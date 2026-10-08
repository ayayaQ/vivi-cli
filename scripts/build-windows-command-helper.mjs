// SPDX-License-Identifier: Apache-2.0
// Stage 1 only: offline discovery and reproducibility evidence. This script never
// approves toolchain pins, emits canonical assets, or invokes ViviCommandJob.Run.
import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const sourceNames = ['ViviCommandJob.cs', 'ViviCommandJob.AssemblyInfo.cs']
const specName = 'windows-command-helper.spec.json'
const referenceNames = ['mscorlib.dll', 'System.dll', 'System.Core.dll']
const hostNames = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const toolLimit = 256 * 1024
const fileLimit = 64 * 1024 * 1024
// Version resources are informational only, never signer authentication.
// Stage 1 trusts the explicitly selected installed SDK in controlled hosted CI;
// all observed executable/dependency/reference hashes still require pin review.
const buildEnvironment = {
  provider: 'controlled-github-hosted-windows',
  installationVersion: '18.10.12217.157',
  productId: 'Microsoft.VisualStudio.Product.Enterprise',
  installationRelativePath: 'Microsoft Visual Studio/18/Enterprise',
  compilerRelativePath: 'MSBuild/Current/Bin/Roslyn/csc.exe',
  referencePackVersion: 'v4.6.2',
}
const metadataProgram = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  $file = [Diagnostics.FileVersionInfo]::GetVersionInfo([Environment]::GetEnvironmentVariable('VIVI_BUILD_INSPECT_FILE'))
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject @{ company = $file.CompanyName; fileVersion = $file.FileVersion; productVersion = $file.ProductVersion }))
} catch { exit 1 }
`

const metadataCommand = Buffer.from(metadataProgram, 'utf16le').toString('base64')

export class HelperBuildError extends Error {
  constructor(message, { cleanupVerified = true, artifactDirectory } = {}) {
    super(message)
    this.name = 'HelperBuildError'
    this.cleanupVerified = cleanupVerified
    if (artifactDirectory !== undefined) this.artifactDirectory = artifactDirectory
  }
}

function hostValue(env, name) {
  return Object.entries(env).find(([key, value]) => key.toLowerCase() === name.toLowerCase() && typeof value === 'string')?.[1]
}
function helperEnv(host) {
  return Object.fromEntries(hostNames.flatMap(name => {
    const value = hostValue(host, name)
    return value === undefined ? [] : [[name, value]]
  }))
}
function windowsPath(value) { return typeof value === 'string' && /^[a-z]:[\\/]/i.test(value) && !value.includes('\0') }
function physicalWindows(value) { return path.win32.normalize(value.replace(/^\\\\\?\\/, '')).toLowerCase() }
function windowsWithin(root, file) {
  const relative = path.win32.relative(physicalWindows(root), physicalWindows(file))
  return relative !== '..' && !relative.startsWith('..\\') && !path.win32.isAbsolute(relative)
}
function within(root, file) {
  const relative = path.relative(root, file)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
async function noReparseAncestors(directory) {
  let current = directory
  while (true) {
    const entry = await fs.lstat(current)
    if (entry.isSymbolicLink()) throw new HelperBuildError('Artifact staging has a reparse ancestor')
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}
async function existingAncestor(directory) {
  let current = directory
  while (true) {
    try { await fs.lstat(current); return current }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}
function abortError() { return new HelperBuildError('Build proof cancelled') }
function checkAbort(signal) { if (signal?.aborted) throw abortError() }

/** Bounded read-only/tool subprocess; taskkill is only allowed before root exit. */
export async function runBoundedWindowsTool(executable, args, options, runtime = {}) {
  const spawn = runtime.spawn ?? nodeSpawn
  const timeoutMs = options.timeoutMs ?? 120_000
  const maxOutputBytes = options.maxOutputBytes ?? toolLimit
  const cleanupTimeoutMs = runtime.cleanupTimeoutMs ?? 3000
  checkAbort(options.signal)
  let child
  try { child = spawn(executable, [...args], { cwd: options.cwd ?? path.win32.dirname(executable), env: { ...options.env }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch { throw new HelperBuildError('Tool could not be started') }
  let rootExited = false, closeSeen = false, spawnFailed = false, failure, cleanupPromise
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), received = 0
  let resolveClosed, resolveFailure
  const failed = new Promise(resolve => { resolveFailure = resolve })
  const closed = new Promise(resolve => { resolveClosed = resolve })
  const cleanup = async () => {
    if (closeSeen || spawnFailed) return
    // A root PID is unsafe to target after exit, even while its pipes are open.
    if (rootExited || !Number.isInteger(child.pid) || child.pid <= 0) throw new HelperBuildError('Tool tree cleanup cannot be verified after root exit', { cleanupVerified: false })
    let killer
    try { killer = spawn(options.taskkill, ['/PID', String(child.pid), '/T', '/F'], { cwd: path.win32.dirname(options.taskkill), env: { ...options.env }, shell: false, windowsHide: true, stdio: 'ignore' }) }
    catch { throw new HelperBuildError('Tool tree cleanup could not be started', { cleanupVerified: false }) }
    let resolveKill
    const killed = new Promise(resolve => { resolveKill = resolve })
    let killCloseBound
    const killBound = setTimeout(() => {
      try { killer.kill('SIGKILL') } catch { /* failure remains unverified */ }
      killCloseBound = setTimeout(() => { killer.unref?.(); resolveKill(false) }, cleanupTimeoutMs)
    }, cleanupTimeoutMs)
    killer.once('error', () => resolveKill(false))
    killer.once('close', code => resolveKill(code === 0))
    const verifiedKill = await killed
    clearTimeout(killBound)
    clearTimeout(killCloseBound)
    if (!verifiedKill) throw new HelperBuildError('Live-parent tool tree cleanup failed', { cleanupVerified: false })
    let bound
    try {
      const ended = await Promise.race([closed.then(() => true), new Promise(resolve => { bound = setTimeout(() => resolve(false), cleanupTimeoutMs) })])
      if (!ended) throw new HelperBuildError('Tool pipes remained open after tree cleanup', { cleanupVerified: false })
    } finally { clearTimeout(bound) }
  }
  const fail = reason => {
    if (failure) return
    failure = reason
    cleanupPromise = cleanup()
    resolveFailure()
    // Observe rejection immediately; the authoritative error is awaited below.
    cleanupPromise.catch(() => {})
  }
  const collect = destination => chunk => {
    const bytes = Buffer.from(chunk)
    received += bytes.length
    if (received > maxOutputBytes) { fail('Tool output exceeded its bounded limit'); return }
    if (destination === 'stdout') stdout = Buffer.concat([stdout, bytes])
    else stderr = Buffer.concat([stderr, bytes])
  }
  child.stdout?.on('data', collect('stdout'))
  child.stderr?.on('data', collect('stderr'))
  child.stdout?.on('error', () => fail('Tool stdout observation failed'))
  child.stderr?.on('error', () => fail('Tool stderr observation failed'))
  child.once('exit', () => { rootExited = true })
  child.once('error', () => { spawnFailed = !Number.isInteger(child.pid) || child.pid <= 0; fail('Tool could not be started') })
  child.once('close', (code, signal) => { closeSeen = true; rootExited = true; resolveClosed({ code, signal }) })
  const abort = () => fail('Build proof cancelled')
  options.signal?.addEventListener('abort', abort, { once: true })
  const deadline = setTimeout(() => fail('Tool exceeded its bounded timeout'), timeoutMs)
  // Recheck after registering abort so a setup-time cancellation is not lost.
  if (options.signal?.aborted) abort()
  try {
    const observation = await Promise.race([closed, failed.then(() => undefined)])
    if (cleanupPromise) {
      try { await cleanupPromise }
      catch (error) {
        // This remains an unverified-cleanup failure, never a successful close.
        // Release our own observation handles so the failed CLI can report/exit;
        // do not remove the quarantined compiler files or claim tree termination.
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.()
        throw error
      }
    }
    if (spawnFailed) throw new HelperBuildError(failure ?? 'Tool could not be started')
    if (!observation && !closeSeen) throw new HelperBuildError('Tool lifecycle remained unverified after its deadline', { cleanupVerified: false })
    if (failure) throw new HelperBuildError(failure)
    if (observation?.code !== 0) throw new HelperBuildError('Tool returned a nonzero exit status')
    return { stdout, stderr, exitCode: observation.code }
  } finally {
    clearTimeout(deadline)
    options.signal?.removeEventListener('abort', abort)
    // Never destroy inherited pipes to manufacture a successful close.
  }
}

async function checkedFile(file, root, runtime) {
  if (!windowsPath(file) || !windowsWithin(root, file)) throw new HelperBuildError('Installed tool/reference path is outside its required root')
  if (runtime.inspectFile) return runtime.inspectFile(file, root)
  const info = await fs.lstat(file)
  if (!info.isFile() || info.isSymbolicLink() || info.size > fileLimit) throw new HelperBuildError('Installed tool/reference must be a bounded regular file')
  const canonical = await fs.realpath(file)
  if (!windowsWithin(root, canonical)) throw new HelperBuildError('Installed tool/reference reparse target escaped its required root')
  // Check each ancestor too: a contained reparse can still substitute an input.
  let ancestor = path.win32.dirname(file)
  while (true) {
    if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new HelperBuildError('Installed tool/reference has a reparse ancestor')
    const next = path.win32.dirname(ancestor)
    if (next === ancestor) break
    ancestor = next
  }
  const bytes = await fs.readFile(canonical)
  if (bytes.length > fileLimit) throw new HelperBuildError('Installed file grew beyond its bounded size')
  return { path: canonical, sha256: sha256(bytes), size: bytes.length, bytes }
}
async function compilerFiles(directory, runtime, signal) {
  if (runtime.listCompilerFiles) return runtime.listCompilerFiles(directory)
  const names = []
  let entries = 0
  const visit = async (folder, depth = 0) => {
    checkAbort(signal)
    if (depth > 16) throw new HelperBuildError('Roslyn toolchain exceeded its bounded directory depth')
    const children = await (runtime.readdir ?? fs.readdir)(folder, { withFileTypes: true })
    entries += children.length
    if (entries > 4096) throw new HelperBuildError('Roslyn toolchain exceeded its bounded entry count')
    for (const entry of children) {
      checkAbort(signal)
      if (entry.isSymbolicLink()) throw new HelperBuildError('Roslyn toolchain has a reparse entry')
      const full = path.win32.join(folder, entry.name)
      if (entry.isDirectory()) await visit(full, depth + 1)
      else if (entry.isFile() && /\.(?:exe|dll|config|json|rsp)$/i.test(entry.name)) {
        names.push(full)
        if (names.length > 256) throw new HelperBuildError('Roslyn toolchain exceeded its bounded file count')
      }
    }
  }
  await visit(directory)
  return names.sort((a, b) => a.localeCompare(b, 'en'))
}
async function fingerprint(directory, runtime, signal) {
  const files = await compilerFiles(directory, runtime, signal)
  if (!files.length || files.length > 256) throw new HelperBuildError('Roslyn toolchain files are unavailable')
  const result = []
  let size = 0
  for (const file of files) {
    checkAbort(signal)
    const record = await checkedFile(file, directory, runtime)
    size += record.size
    if (size > 256 * 1024 * 1024) throw new HelperBuildError('Roslyn toolchain exceeded its bounded total size')
    result.push({ path: path.win32.relative(directory, record.path).replaceAll('\\', '/'), sha256: record.sha256, size: record.size })
  }
  return result
}
function run(runtime, executable, args, options) {
  return (runtime.runTool ?? ((exe, argv, config) => runBoundedWindowsTool(exe, argv, config, runtime)))(executable, args, options)
}
async function metadata(file, powershell, env, taskkill, signal, runtime) {
  const result = await run(runtime, powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', metadataCommand], {
    env: { ...env, VIVI_BUILD_INSPECT_FILE: file }, taskkill, signal, timeoutMs: 20_000, maxOutputBytes: 16_384,
  })
  let record
  try { record = JSON.parse(result.stdout.toString('utf8').replace(/^\uFEFF/, '').trim()) }
  catch { throw new HelperBuildError('Installed tool version metadata is invalid') }
  if (!record || typeof record.company !== 'string' || record.company.length > 256 || typeof record.fileVersion !== 'string' || !record.fileVersion || record.fileVersion.length > 256 || typeof record.productVersion !== 'string' || record.productVersion.length > 256) throw new HelperBuildError('Installed tool version metadata is invalid')
  return { company: record.company, fileVersion: record.fileVersion, productVersion: record.productVersion, versionResourcesInformationalOnly: true }

}
async function sources(sourceRoot) {
  const specPath = path.join(sourceRoot, 'native', specName)
  const specStat = await fs.lstat(specPath)
  if (!specStat.isFile() || specStat.isSymbolicLink() || specStat.size > 16_384) throw new HelperBuildError('Helper spec must be a bounded regular source file')
  const specBytes = await fs.readFile(specPath)
  if (specBytes.length > 16_384) throw new HelperBuildError('Helper spec exceeded its bounded size')
  let spec
  try { spec = JSON.parse(specBytes) } catch { throw new HelperBuildError('Helper spec is invalid') }
  if (JSON.stringify(spec.buildEnvironment) !== JSON.stringify(buildEnvironment)) throw new HelperBuildError('Controlled build SDK/location specification is unsupported')
  if (spec.schemaVersion !== 1 || spec.abiVersion !== 1 || spec.nativeType !== 'ViviCommandJob' || spec.targetFramework !== '.NETFramework,Version=v4.6.2' || spec.referencePackVersion !== 'v4.6.2' || spec.platform !== 'anycpu' || spec.approvalState !== 'unapproved-discovery' || spec.runtimeIntegration !== false || spec.compilerPins !== null || JSON.stringify(spec.referenceAssemblies) !== JSON.stringify(referenceNames)) throw new HelperBuildError('Helper spec/ABI identity is unsupported')
  if (JSON.stringify(spec.productionEquivalent) !== JSON.stringify({ path: 'src/command-windows.ts', template: 'nativeSource', sourcePath: 'native/ViviCommandJob.cs' })) throw new HelperBuildError('Production source anchor is unsupported')
  const signature = { name: 'Run', static: true, returnType: 'System.Void', parameterTypes: ['System.String', 'System.String[]', 'System.String', 'System.Collections.Generic.Dictionary<System.String,System.String>'] }
  if (JSON.stringify(spec.entryPoint) !== JSON.stringify(signature) || spec.assemblyName !== 'ViviCommandJob' || spec.assemblyVersion !== '1.0.0.0' || !Array.isArray(spec.sourceFiles) || spec.sourceFiles.length !== 2) throw new HelperBuildError('Helper ABI signature is unsupported')
  const records = []
  for (let index = 0; index < sourceNames.length; index++) {
    const name = sourceNames[index], expected = spec.sourceFiles[index]
    if (expected?.path !== `native/${name}` || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new HelperBuildError('Helper source identity is invalid')
    const file = path.join(sourceRoot, 'native', name)
    const sourceStat = await fs.lstat(file)
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 131_072) throw new HelperBuildError('Helper source must be a bounded regular file')
    const bytes = await fs.readFile(file)
    if (bytes.length > 131_072 || bytes.includes(13) || bytes.includes(0) || sha256(bytes) !== expected.sha256) throw new HelperBuildError('Helper source bytes do not match the anchored LF spec')
    records.push({ name, bytes, path: expected.path, sha256: expected.sha256 })
  }
  const productionPath = path.join(sourceRoot, 'src', 'command-windows.ts')
  const productionStat = await fs.lstat(productionPath)
  if (!productionStat.isFile() || productionStat.isSymbolicLink() || productionStat.size > 1024 * 1024) throw new HelperBuildError('Production source anchor must be a bounded regular file')
  const production = await fs.readFile(productionPath, 'utf8')
  // Git's Windows checkout may use CRLF for the TypeScript anchor. Only line
  // endings are canonicalized; native sources/spec remain exact LF bytes.
  const inline = production.replaceAll('\r\n', '\n').match(/const nativeSource = String\.raw`([\s\S]*?)`\n/)
  if (!/public static void Run\(string executable, string\[\] args, string cwd, Dictionary<string,string> env\)/.test(records[0].bytes.toString('utf8'))) throw new HelperBuildError('Native source method does not match the anchored ABI')
  if (!inline || !Buffer.from(inline[1], 'utf8').equals(records[0].bytes)) throw new HelperBuildError('Extracted C# differs from the production algorithm')
  return { spec, specBytes, records, specSha256: sha256(specBytes) }
}

/** Structural PE/CLR check only; no assembly is loaded and no native method runs. */
export function inspectManagedAnyCpuImage(bytes) {
  const fail = () => { throw new HelperBuildError('Compiler output is not a CLR4 AnyCPU library') }
  const range = (offset, size) => { if (!Number.isInteger(offset) || offset < 0 || offset + size > bytes.length) fail() }
  const u16 = offset => { range(offset, 2); return bytes.readUInt16LE(offset) }
  const u32 = offset => { range(offset, 4); return bytes.readUInt32LE(offset) }
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) fail()
  const pe = u32(0x3c)
  if (u32(pe) !== 0x00004550 || u16(pe + 4) !== 0x014c || !(u16(pe + 22) & 0x2000)) fail()
  const sections = u16(pe + 6), optional = pe + 24, optionalSize = u16(pe + 20)
  if (!sections || sections > 96 || optionalSize < 224 || u16(optional) !== 0x10b || u32(optional + 92) < 15) fail()
  range(optional, optionalSize)
  const sectionTable = optional + optionalSize
  range(sectionTable, sections * 40)
  const locate = (rva, count) => {
    for (let index = 0; index < sections; index++) {
      const section = sectionTable + index * 40, start = u32(section + 12), rawSize = u32(section + 16)
      if (rva >= start && rva - start + count <= rawSize) {
        const offset = u32(section + 20) + rva - start
        range(offset, count)
        return offset
      }
    }
    fail()
  }
  const cliRva = u32(optional + 96 + 14 * 8), cliSize = u32(optional + 96 + 14 * 8 + 4)
  if (cliSize < 72) fail()
  const cli = locate(cliRva, 72), flags = u32(cli + 16)
  if (u32(cli) < 72 || !(flags & 1) || (flags & (2 | 0x20000)) || u32(cli + 20) !== 0) fail()
  const metadataSize = u32(cli + 12)
  if (metadataSize < 32) fail()
  const metadata = locate(u32(cli + 8), metadataSize)
  if (u32(metadata) !== 0x424a5342) fail()
  const versionSize = u32(metadata + 12)
  if (!versionSize || versionSize > 64) fail()
  range(metadata + 16, versionSize)
  const clrVersion = bytes.subarray(metadata + 16, metadata + 16 + versionSize).toString('ascii').replace(/\0+$/, '')
  if (!/^v4\.0\.\d+$/.test(clrVersion)) fail()
  return { machine: 'I386-IL', ilOnly: true, requires32Bit: false, prefers32Bit: false, library: true, clrVersion }
}

/** Creates discovery-only proof in a fresh owned artifact directory. Never ships it. */
export async function buildWindowsCommandHelper(options, runtime = {}) {
  if ((runtime.platform ?? process.platform) !== 'win32') throw new HelperBuildError('Build proof requires an existing Windows CI environment')
  const sourceRoot = await fs.realpath(path.resolve(options.sourceRoot ?? repositoryRoot))
  if (process.platform === 'win32' && !windowsPath(sourceRoot)) throw new HelperBuildError('Build sources must be on a local drive in the controlled image')
  const artifactDirectory = path.resolve(options.artifactDir ?? '')
  if (/^(?:\\\\|\/\/)/.test(options.artifactDir ?? '')) throw new HelperBuildError('Network/pipe artifact destinations are unsupported')
  if (!options.artifactDir || !path.isAbsolute(options.artifactDir)) throw new HelperBuildError('A new absolute artifact directory is required')
  const reserved = path.join(sourceRoot, '.vivi-build')
  if (within(sourceRoot, artifactDirectory) && !within(reserved, artifactDirectory)) throw new HelperBuildError('Artifacts must be external to Git or within reserved .vivi-build')
  if (physicalWindows(artifactDirectory).includes(`${path.win32.sep}dist${path.win32.sep}`) || artifactDirectory === path.join(sourceRoot, 'dist')) throw new HelperBuildError('Artifacts cannot be staged inside dist')
  if (options.sourceRevision !== undefined && !/^[a-f0-9]{40}$/.test(options.sourceRevision)) throw new HelperBuildError('Source revision must be a declared 40-hex commit')
  const input = await sources(sourceRoot)
  checkAbort(options.signal)
  const host = runtime.hostEnv ?? process.env
  if (hostValue(host, 'GITHUB_ACTIONS') !== 'true' || hostValue(host, 'RUNNER_OS') !== 'Windows' || hostValue(host, 'RUNNER_ENVIRONMENT') !== 'github-hosted') throw new HelperBuildError('Build proof is restricted to the declared controlled GitHub-hosted Windows environment')
  const env = helperEnv(host), programFiles = hostValue(host, 'ProgramFiles(x86)'), programFiles64 = hostValue(host, 'ProgramFiles')
  if (Object.entries(env).some(([name, value]) => ['WINDIR', 'TEMP', 'TMP', 'TMPDIR'].includes(name) && !windowsPath(value))) throw new HelperBuildError('Build helper setup paths must remain on local Windows drives')
  if (!windowsPath(env.SystemRoot) || !windowsPath(programFiles) || !windowsPath(programFiles64)) throw new HelperBuildError('Installed Windows/Visual Studio roots are unavailable')
  const powershell = path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const taskkill = path.win32.join(env.SystemRoot, 'System32', 'taskkill.exe')
  const windowsTools = { powershell: await checkedFile(powershell, path.win32.join(env.SystemRoot, 'System32'), runtime), taskkill: await checkedFile(taskkill, path.win32.join(env.SystemRoot, 'System32'), runtime) }
  const installer = path.win32.join(programFiles, 'Microsoft Visual Studio', 'Installer')
  const vswhere = path.win32.join(installer, 'vswhere.exe')
  const locator = await checkedFile(vswhere, installer, runtime)
  const locatorMetadata = await metadata(locator.path, powershell, env, taskkill, options.signal, runtime)
  const discovered = await run(runtime, locator.path, ['-version', '[18.10.12217.157,18.10.12217.158)', '-products', buildEnvironment.productId, '-requires', 'Microsoft.VisualStudio.Component.Roslyn.Compiler', 'Microsoft.Net.Component.4.6.2.TargetingPack', '-format', 'json', '-utf8'], { env, taskkill, signal: options.signal, timeoutMs: 20_000 })
  let installations
  try { installations = JSON.parse(discovered.stdout.toString('utf8').replace(/^\uFEFF/, '').trim()) }
  catch { throw new HelperBuildError('Installed Visual Studio discovery returned invalid data') }
  if (!Array.isArray(installations) || installations.length !== 1) throw new HelperBuildError('One installed official Roslyn/reference-pack environment is required')
  const installation = installations[0]
  if (!installation || installation.isComplete !== true || installation.isLaunchable !== true || !windowsPath(installation.installationPath) || !/^\d+\.\d+\.\d+\.\d+$/.test(installation.installationVersion ?? '') || !/^Microsoft\.VisualStudio\.Product\.(?:Enterprise|Professional|Community|BuildTools)$/.test(installation.productId ?? '')) throw new HelperBuildError('Visual Studio installation metadata is unsupported')
  const expectedInstallation = path.win32.join(programFiles64, 'Microsoft Visual Studio', '18', 'Enterprise')
  if (installation.installationVersion !== buildEnvironment.installationVersion || installation.productId !== buildEnvironment.productId || physicalWindows(installation.installationPath) !== physicalWindows(expectedInstallation)) throw new HelperBuildError('Installed Visual Studio version/location differs from the declared SDK')
  const roslyn = path.win32.join(installation.installationPath, 'MSBuild', 'Current', 'Bin', 'Roslyn')
  const compiler = await checkedFile(path.win32.join(roslyn, 'csc.exe'), installation.installationPath, runtime)
  const compilerMetadata = await metadata(compiler.path, powershell, env, taskkill, options.signal, runtime)
  const toolsBefore = await fingerprint(roslyn, runtime, options.signal)
  if (!toolsBefore.some(record => record.path.toLowerCase() === 'csc.exe' && record.sha256 === compiler.sha256)) throw new HelperBuildError('Compiler identity differs from its toolchain snapshot')
  const referenceRoot = path.win32.join(programFiles, 'Reference Assemblies', 'Microsoft', 'Framework', '.NETFramework', 'v4.6.2')
  const references = []
  for (const name of referenceNames) references.push({ name, ...await checkedFile(path.win32.join(referenceRoot, name), referenceRoot, runtime) })
  checkAbort(options.signal)
  // Reserve a fresh artifact directory. Refuse pre-existing output/stale DLLs.
  await noReparseAncestors(await existingAncestor(path.dirname(artifactDirectory)))
  await fs.mkdir(path.dirname(artifactDirectory), { recursive: true })
  await noReparseAncestors(path.dirname(artifactDirectory))
  const physicalParent = await fs.realpath(path.dirname(artifactDirectory))
  const physicalOutput = path.join(physicalParent, path.basename(artifactDirectory))
  if (within(sourceRoot, physicalOutput) && !within(reserved, physicalOutput)) throw new HelperBuildError('Artifact parent reparse target escaped the reserved directory')
  await fs.mkdir(artifactDirectory, { mode: 0o700 })
  let owned = true, quarantined = false
  try {
    const compileDirectories = []
    const buildEvidence = []
    const dllBytes = []
    for (const label of ['a', 'b']) {
      checkAbort(options.signal)
      const directory = await fs.mkdtemp(path.join(artifactDirectory, `.compile-${label}-`))
      compileDirectories.push(directory)
      await fs.mkdir(path.join(directory, 'references'))
      for (const record of input.records) await fs.writeFile(path.join(directory, record.name), record.bytes, { flag: 'wx', mode: 0o600 })
      for (const record of references) await fs.writeFile(path.join(directory, 'references', record.name), record.bytes, { flag: 'wx', mode: 0o600 })
      const output = path.join(directory, 'ViviCommandJob.dll')
      const args = ['/nologo', '/noconfig', '/nostdlib+', '/target:library', '/platform:anycpu', '/deterministic+', '/optimize+', '/debug-', '/langversion:5', '/warn:4', '/codepage:65001', '/utf8output', '/preferreduilang:en-US', `/pathmap:${directory}=/_vivi_native`, `/out:${output}`, ...references.map(record => `/reference:${path.join(directory, 'references', record.name)}`), ...input.records.map(record => path.join(directory, record.name))]
      const result = await run(runtime, compiler.path, args, { cwd: directory, env, taskkill, signal: options.signal, timeoutMs: 120_000 })
      checkAbort(options.signal)
      for (const record of input.records) if (sha256(await fs.readFile(path.join(directory, record.name))) !== record.sha256) throw new HelperBuildError('Compiler source snapshot changed during compilation')
      for (const record of references) if (sha256(await fs.readFile(path.join(directory, 'references', record.name))) !== record.sha256) throw new HelperBuildError('Compiler reference snapshot changed during compilation')
      const stat = await fs.lstat(output)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new HelperBuildError('Compiler did not create a bounded regular assembly')
      const bytes = await fs.readFile(output)
      const managedImage = inspectManagedAnyCpuImage(bytes)
      dllBytes.push(bytes)
      buildEvidence.push({ index: label, assemblySha256: sha256(bytes), assemblySize: bytes.length, managedImage, stdoutSha256: sha256(result.stdout), stderrSha256: sha256(result.stderr), stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length })
    }
    if (!dllBytes[0].equals(dllBytes[1])) throw new HelperBuildError('Two clean compiler builds were not byte-for-byte deterministic')
    const inputAfter = await sources(sourceRoot)
    if (inputAfter.specSha256 !== input.specSha256) throw new HelperBuildError('Source spec changed during compilation')
    if (JSON.stringify(await fingerprint(roslyn, runtime, options.signal)) !== JSON.stringify(toolsBefore)) throw new HelperBuildError('Installed Roslyn toolchain changed during compilation')
    const locatorAfter = await checkedFile(vswhere, installer, runtime)
    if (locatorAfter.sha256 !== locator.sha256) throw new HelperBuildError('Installed discovery tool changed during compilation')
    for (const [name, original] of Object.entries(windowsTools)) if ((await checkedFile(name === 'powershell' ? powershell : taskkill, path.win32.join(env.SystemRoot, 'System32'), runtime)).sha256 !== original.sha256) throw new HelperBuildError('Installed OS tool changed during compilation')
    for (const record of references) if ((await checkedFile(path.win32.join(referenceRoot, record.name), referenceRoot, runtime)).sha256 !== record.sha256) throw new HelperBuildError('Installed reference pack changed during compilation')
    checkAbort(options.signal)
    // No process remains running here: each runner settled only after pipe close.
    for (const directory of compileDirectories) await fs.rm(directory, { recursive: true, force: true })
    const manifest = {
      schemaVersion: 1, purpose: 'windows-helper-source-build-proof', approvalState: 'unapproved-discovery', canonical: false, runtimeEligible: false, reproducible: true,
      abi: { version: input.spec.abiVersion, type: input.spec.nativeType, method: input.spec.entryPoint, assemblyVersion: input.spec.assemblyVersion },
      targetFramework: input.spec.targetFramework, platform: input.spec.platform,
      source: { declaredRevision: options.sourceRevision ?? null, specSha256: input.specSha256, productionEquivalenceVerified: true, productionLineEndings: 'CRLF-to-LF-only', files: input.records.map(record => ({ path: record.path, sha256: record.sha256 })) },
      toolchain: { pinApproval: 'required', provenanceCheck: 'controlled-hosted-image-and-exact-installed-SDK-selection; PE-branding-is-informational-not-signer-authentication; observed-hashes-require-independent-pin-review',
        installationVersion: installation.installationVersion, productId: installation.productId, declaredEnvironment: buildEnvironment, windowsTools: Object.fromEntries(Object.entries(windowsTools).map(([name, record]) => [name, { sha256: record.sha256, size: record.size }])),
        locator: { sha256: locator.sha256, size: locator.size, ...locatorMetadata }, compiler: { sha256: compiler.sha256, size: compiler.size, ...compilerMetadata }, dependencies: toolsBefore,
        referencePackVersion: 'v4.6.2', references: references.map(record => ({ name: record.name, sha256: record.sha256, size: record.size })) },
      compilerOptions: ['/nologo', '/noconfig', '/nostdlib+', '/target:library', '/platform:anycpu', '/deterministic+', '/optimize+', '/debug-', '/langversion:5', '/warn:4', '/codepage:65001', '/utf8output', '/preferreduilang:en-US', '/pathmap:<fresh-directory>=/_vivi_native', '/out:<fresh-directory>/ViviCommandJob.dll', '/reference:<snapshot>/mscorlib.dll', '/reference:<snapshot>/System.dll', '/reference:<snapshot>/System.Core.dll'],
      assembly: { filename: 'ViviCommandJob.dll', sha256: sha256(dllBytes[0]), size: dllBytes[0].length, managedImage: inspectManagedAnyCpuImage(dllBytes[0]), abiVerification: 'source-anchored; loaded-method-signature-review-pending' }, builds: buildEvidence,
      reviewRequired: ['compiler-and-reference-pins', 'runtime-loader-integration', 'native-product-fixtures'],
    }
    await fs.writeFile(path.join(artifactDirectory, 'ViviCommandJob.dll'), dllBytes[0], { flag: 'wx', mode: 0o600 })
    for (const record of input.records) await fs.writeFile(path.join(artifactDirectory, record.name), record.bytes, { flag: 'wx', mode: 0o600 })
    await fs.writeFile(path.join(artifactDirectory, specName), input.specBytes, { flag: 'wx', mode: 0o600 })
    await fs.writeFile(path.join(artifactDirectory, 'discovery-proof.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await runtime.beforePublish?.()
    checkAbort(options.signal)
    owned = false
    return { artifactDirectory, manifest, files: ['ViviCommandJob.dll', ...sourceNames, specName, 'discovery-proof.json'] }
  } catch (error) {
    if (error?.cleanupVerified === false) {
      quarantined = true
      // Retain quarantined outputs until process cleanup is established. They are
      // never part of the success upload contract and cannot become runtime assets.
      await fs.writeFile(path.join(artifactDirectory, 'cleanup-blocker.json'), JSON.stringify({ approvalState: 'unapproved-discovery', canonical: false, runtimeEligible: false, reason: 'compiler-process-cleanup-unverified' }) + '\n', { flag: 'wx', mode: 0o600 }).catch(() => {})
      throw new HelperBuildError('Build proof blocked by unverified compiler cleanup', { cleanupVerified: false, artifactDirectory })
    }
    throw error
  } finally {
    if (owned && !quarantined) await fs.rm(artifactDirectory, { recursive: true, force: true })
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 1 && argv[0] === '--help') { console.log('Usage: node scripts/build-windows-command-helper.mjs --artifact-dir <new absolute proof directory> [--source-revision <40-hex commit>]\nOffline discovery/build proof only; never installs tools or approves runtime assets.'); return }
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1]
    if (!value || (key !== '--artifact-dir' && key !== '--source-revision')) throw new HelperBuildError('Only --artifact-dir and --source-revision are accepted')
    const field = key === '--artifact-dir' ? 'artifactDir' : 'sourceRevision'
    if (options[field] !== undefined) throw new HelperBuildError('Duplicate build proof argument')
    options[field] = value
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel)
  try {
    const result = await buildWindowsCommandHelper({ ...options, signal: controller.signal })
    console.log(JSON.stringify({ artifactDirectory: result.artifactDirectory, files: result.files, approvalState: 'unapproved-discovery', canonical: false, runtimeEligible: false }))
  } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof HelperBuildError ? error.message : 'Build proof failed before verification'); if (error?.artifactDirectory) console.error(`Unapproved quarantine retained at ${error.artifactDirectory}`); process.exitCode = 1 })
}
