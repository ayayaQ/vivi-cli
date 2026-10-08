// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { buildWindowsCommandHelper, HelperBuildError, inspectManagedAnyCpuImage, runBoundedWindowsTool } from '../scripts/build-windows-command-helper.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const host = Object.freeze({ SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: 'C:\\Temp', TMP: 'C:\\Temp', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files', PATH: 'never-forward', HOME: 'never-forward', OPENAI_API_KEY: 'never-forward-key', NODE_OPTIONS: '--require never-forward', GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows', RUNNER_ENVIRONMENT: 'github-hosted' })
const installation = { installationPath: 'C:\\Program Files\\Microsoft Visual Studio\\18\\Enterprise', installationVersion: '18.10.12217.157', productId: 'Microsoft.VisualStudio.Product.Enterprise', isComplete: true, isLaunchable: true }
const roslyn = path.win32.join(installation.installationPath, 'MSBuild', 'Current', 'Bin', 'Roslyn')
const tick = () => new Promise(resolve => setImmediate(resolve))

// Synthetic non-executable PE/CLR header bytes, generated only in owned test
// temporary directories. This is not a compiler-generated binary/asset in Git.
function mockImage() {
  const bytes = Buffer.alloc(1024)
  bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c)
  bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(0x14c, 0x84)
  bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(224, 0x94); bytes.writeUInt16LE(0x2002, 0x96)
  const optional = 0x98
  bytes.writeUInt16LE(0x10b, optional); bytes.writeUInt32LE(16, optional + 92)
  bytes.writeUInt32LE(0x2000, optional + 96 + 14 * 8); bytes.writeUInt32LE(72, optional + 96 + 14 * 8 + 4)
  const section = optional + 224
  bytes.writeUInt32LE(512, section + 8); bytes.writeUInt32LE(0x2000, section + 12)
  bytes.writeUInt32LE(512, section + 16); bytes.writeUInt32LE(512, section + 20)
  bytes.writeUInt32LE(72, 512); bytes.writeUInt32LE(0x2080, 520); bytes.writeUInt32LE(64, 524); bytes.writeUInt32LE(1, 528)
  bytes.writeUInt32LE(0x424a5342, 640); bytes.writeUInt32LE(12, 652); bytes.write('v4.0.30319\0', 656, 'ascii')
  return bytes
}
async function fixture(t, changes = {}) {
  const folder = await fs.mkdtemp(path.join(tmpdir(), 'vivi-build-proof-test-'))
  t.after(() => fs.rm(folder, { recursive: true, force: true }))
  const sourceRoot = path.join(folder, 'repo')
  await fs.mkdir(path.join(sourceRoot, 'native'), { recursive: true })
  await fs.mkdir(path.join(sourceRoot, 'src'))
  for (const name of ['ViviCommandJob.cs', 'ViviCommandJob.AssemblyInfo.cs', 'windows-command-helper.spec.json']) await fs.copyFile(path.join(root, 'native', name), path.join(sourceRoot, 'native', name))
  await fs.writeFile(path.join(sourceRoot, 'src', 'command-windows.ts'), (await fs.readFile(path.join(root, 'src', 'command-windows.ts'), 'utf8')).replaceAll('\r\n', '\n'))
  const artifactDir = path.join(folder, 'proof')
  const calls = [], inspections = []
  let builds = 0, toolGeneration = 0
  const runtime = {
    platform: 'win32', hostEnv: host,
    async inspectFile(file) {
      inspections.push(file)
      if (changes.missingReference && file.endsWith('System.Core.dll')) throw new HelperBuildError('Installed reference is unavailable')
      const bytes = Buffer.from('fixed official fixture ' + file + (changes.changedTool && file.includes('Roslyn') ? String(toolGeneration) : ''))
      return { path: file, sha256: hash(bytes), size: bytes.length, bytes }
    },
    async listCompilerFiles(directory) { return [path.win32.join(directory, 'csc.exe'), path.win32.join(directory, 'Microsoft.CodeAnalysis.dll'), path.win32.join(directory, 'csc.exe.config')] },
    async runTool(executable, args, options) {
      calls.push({ executable, args, options })
      assert.equal(options.env.OPENAI_API_KEY, undefined)
      assert.equal(options.env.PATH, undefined)
      assert.equal(options.env.HOME, undefined)
      assert.equal(options.env.NODE_OPTIONS, undefined)
      if (executable.endsWith('powershell.exe')) return { stdout: Buffer.from(JSON.stringify({ company: changes.badCompany ? 'Unknown Publisher' : 'Microsoft Corporation', fileVersion: '5.0.0.0', productVersion: '5.0.0.0' })), stderr: Buffer.alloc(0), exitCode: 0 }
      if (executable.endsWith('vswhere.exe')) return { stdout: Buffer.from(JSON.stringify(changes.missingInstallation ? [] : [changes.installation ?? installation])), stderr: Buffer.alloc(0), exitCode: 0 }
      assert.ok(executable.endsWith('csc.exe'))
      builds++
      if (changes.compileError) throw new HelperBuildError('Compiler failed', { cleanupVerified: changes.cleanupVerified !== false })
      const output = args.find(argument => argument.startsWith('/out:')).slice(5)
      const bytes = mockImage()
      if (changes.nondeterministic && builds === 2) bytes[bytes.length - 1] = 1
      await fs.writeFile(output, bytes)
      if (changes.changedSource && builds === 2) await fs.appendFile(path.join(sourceRoot, 'native', 'ViviCommandJob.cs'), '// mutation\n')
      if (changes.changedTool && builds === 2) toolGeneration++
      if (changes.changedSnapshot) await fs.appendFile(path.join(options.cwd, 'references', 'System.dll'), 'mutation')
      if (changes.abortDuringBuild && builds === 1) changes.abortDuringBuild.abort()
      return { stdout: Buffer.from('fixed compiler diagnostic'), stderr: Buffer.alloc(0), exitCode: 0 }
    },
  }
  return { sourceRoot, artifactDir, calls, inspections, runtime, options: { sourceRoot, artifactDir, sourceRevision: 'a'.repeat(40) } }
}
function processFixture() {
  const child = Object.assign(new EventEmitter(), { pid: 111, stdout: new PassThrough(), stderr: new PassThrough(), unref() {} })
  const killer = Object.assign(new EventEmitter(), { pid: 222, kill() { return true } })
  const calls = []
  let onKill
  const runtime = { cleanupTimeoutMs: 15, spawn(executable, args, options) { calls.push({ executable, args, options }); if (calls.length === 1) return child; onKill?.(); return killer } }
  return { child, killer, calls, runtime, setKill(callback) { onKill = callback } }
}
const toolOptions = { env: { SystemRoot: 'C:\\Windows' }, taskkill: 'C:\\Windows\\System32\\taskkill.exe', timeoutMs: 40, maxOutputBytes: 128 }


test('native source is byte-exact with production and its anchored source/ABI spec', async () => {
  const production = (await fs.readFile(path.join(root, 'src', 'command-windows.ts'), 'utf8')).replaceAll('\r\n', '\n')
  const source = await fs.readFile(path.join(root, 'native', 'ViviCommandJob.cs'))
  assert.deepEqual(source, Buffer.from(production.match(/const nativeSource = String\.raw`([\s\S]*?)`\n/)[1]))
  const spec = JSON.parse(await fs.readFile(path.join(root, 'native', 'windows-command-helper.spec.json'), 'utf8'))
  assert.equal(spec.sourceFiles[0].sha256, hash(source))
  assert.equal(spec.abiVersion, 1)
  assert.equal(spec.compilerPins, null)
  assert.equal(spec.approvalState, 'unapproved-discovery')
  assert.equal(spec.runtimeIntegration, false)
  assert.match(await fs.readFile(path.join(root, 'native', '.gitattributes'), 'utf8'), /\*\.cs text eol=lf/)
})

test('build proof uses fixed inputs, two fresh dirs and emits only unapproved noncanonical artifacts', async t => {
  const subject = await fixture(t)
  const result = await buildWindowsCommandHelper(subject.options, subject.runtime)
  assert.equal(result.manifest.approvalState, 'unapproved-discovery')
  assert.equal(result.manifest.canonical, false)
  assert.equal(result.manifest.runtimeEligible, false)
  assert.equal(result.manifest.reproducible, true)
  assert.equal(result.manifest.source.declaredRevision, 'a'.repeat(40))
  assert.deepEqual(result.files.sort(), ['ViviCommandJob.dll', 'ViviCommandJob.cs', 'ViviCommandJob.AssemblyInfo.cs', 'windows-command-helper.spec.json', 'discovery-proof.json'].sort())
  assert.deepEqual((await fs.readdir(subject.artifactDir)).sort(), result.files)
  const compiles = subject.calls.filter(call => call.executable.endsWith('csc.exe'))
  assert.equal(compiles.length, 2)
  assert.notEqual(compiles[0].options.cwd, compiles[1].options.cwd)
  for (const call of compiles) {
    assert.ok(call.args.includes('/noconfig'))
    assert.ok(call.args.includes('/nostdlib+'))
    assert.ok(call.args.includes('/deterministic+'))
    assert.ok(call.args.includes('/platform:anycpu'))
    assert.equal(call.args.filter(argument => argument.startsWith('/reference:')).length, 3)
    assert.ok(!call.args.some(argument => /^\/(?:shared|analyzer|recurse|lib)/i.test(argument) || argument.startsWith('@')))
    assert.equal(call.options.timeoutMs, 120_000)
  }
  for (const name of ['ViviCommandJob.cs', 'ViviCommandJob.AssemblyInfo.cs', 'windows-command-helper.spec.json']) assert.deepEqual(await fs.readFile(path.join(subject.artifactDir, name)), await fs.readFile(path.join(subject.sourceRoot, 'native', name)))
  assert.equal(result.manifest.assembly.sha256, hash(mockImage()))
  assert.equal(result.manifest.toolchain.pinApproval, 'required')
  assert.ok(result.manifest.toolchain.dependencies.some(record => record.path === 'Microsoft.CodeAnalysis.dll'))
  assert.ok(!JSON.stringify(result.manifest).includes('never-forward-key'))
})

test('missing prerequisites or changed installed SDK stop before compiling or creating artifacts', async t => {
  for (const change of [{ missingReference: true }, { missingInstallation: true }, { installation: { ...installation, installationVersion: '18.10.12217.158' } }, { installation: { ...installation, isComplete: false } }]) {
    const subject = await fixture(t, change)
    await assert.rejects(buildWindowsCommandHelper(subject.options, subject.runtime))
    assert.equal(subject.calls.filter(call => call.executable.endsWith('csc.exe')).length, 0)
    await assert.rejects(fs.access(subject.artifactDir), { code: 'ENOENT' })
  }
})

test('source/spec/ABI drift is rejected before tool discovery', async t => {
  for (const change of ['source', 'spec', 'abi', 'production']) {
    const subject = await fixture(t)
    if (change === 'source') await fs.appendFile(path.join(subject.sourceRoot, 'native', 'ViviCommandJob.cs'), 'mutation')
    else if (change === 'production') await fs.appendFile(path.join(subject.sourceRoot, 'src', 'command-windows.ts'), '\n') // outside template is harmless
    else {
      const filename = path.join(subject.sourceRoot, 'native', 'windows-command-helper.spec.json')
      const spec = JSON.parse(await fs.readFile(filename, 'utf8'))
      if (change === 'abi') spec.entryPoint.name = 'OtherMethod'
      else spec.compilerPins = { selfApproved: true }
      await fs.writeFile(filename, JSON.stringify(spec))
    }
    if (change === 'production') {
      const filename = path.join(subject.sourceRoot, 'src', 'command-windows.ts')
      await fs.writeFile(filename, (await fs.readFile(filename, 'utf8')).replace('const nativeSource = String.raw`\nusing System;', 'const nativeSource = String.raw`\nusing Different;'))
    }
    await assert.rejects(buildWindowsCommandHelper(subject.options, subject.runtime))
    assert.equal(subject.calls.length, 0)
  }
})

test('nondeterminism and post-build input/tool changes discard only completed owned outputs', async t => {
  for (const change of [{ nondeterministic: true }, { changedSource: true }, { changedTool: true }, { changedSnapshot: true }, { compileError: true }]) {
    const subject = await fixture(t, change)
    await assert.rejects(buildWindowsCommandHelper(subject.options, subject.runtime))
    await assert.rejects(fs.access(subject.artifactDir), { code: 'ENOENT' })
  }
})

test('unverified compiler cleanup quarantines outputs and never emits a success manifest', async t => {
  const subject = await fixture(t, { compileError: true, cleanupVerified: false })
  await assert.rejects(buildWindowsCommandHelper(subject.options, subject.runtime), error => error.cleanupVerified === false && error.artifactDirectory === subject.artifactDir)
  assert.equal(JSON.parse(await fs.readFile(path.join(subject.artifactDir, 'cleanup-blocker.json'), 'utf8')).runtimeEligible, false)
  await assert.rejects(fs.access(path.join(subject.artifactDir, 'discovery-proof.json')), { code: 'ENOENT' })
})

test('cancellation before setup or after compilation cannot publish proof or run a second compiler', async t => {
  const before = await fixture(t)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(buildWindowsCommandHelper({ ...before.options, signal: controller.signal }, before.runtime), /cancelled/)
  assert.equal(before.calls.length, 0)
  const during = new AbortController(), subject = await fixture(t, { abortDuringBuild: during })
  await assert.rejects(buildWindowsCommandHelper({ ...subject.options, signal: during.signal }, subject.runtime), /cancelled/)
  assert.equal(subject.calls.filter(call => call.executable.endsWith('csc.exe')).length, 1)
  await assert.rejects(fs.access(subject.artifactDir), { code: 'ENOENT' })
})

test('stale/preexisting outputs and nonreserved worktree locations are never overwritten', async t => {
  const subject = await fixture(t)
  await fs.mkdir(subject.artifactDir)
  await fs.writeFile(path.join(subject.artifactDir, 'sentinel'), 'keep')
  await assert.rejects(buildWindowsCommandHelper(subject.options, subject.runtime), { code: 'EEXIST' })
  assert.equal(await fs.readFile(path.join(subject.artifactDir, 'sentinel'), 'utf8'), 'keep')
  for (const artifactDir of [path.join(subject.sourceRoot, 'dist', 'proof'), path.join(subject.sourceRoot, 'native', 'proof')]) {
    await assert.rejects(buildWindowsCommandHelper({ ...subject.options, artifactDir }, subject.runtime), /Artifacts/)
  }
})

test('managed-image validation rejects native/x86/invalid headers without loading code', () => {
  assert.equal(inspectManagedAnyCpuImage(mockImage()).clrVersion, 'v4.0.30319')
  for (const change of ['mz', 'machine', 'cli', 'x86', 'metadata']) {
    const bytes = mockImage()
    if (change === 'mz') bytes[0] = 0
    if (change === 'machine') bytes.writeUInt16LE(0x8664, 0x84)
    if (change === 'cli') bytes.writeUInt32LE(0, 0x98 + 96 + 14 * 8)
    if (change === 'x86') bytes.writeUInt32LE(3, 528)
    if (change === 'metadata') bytes[640] = 0
    assert.throws(() => inspectManagedAnyCpuImage(bytes), /CLR4 AnyCPU/)
  }
})

test('bounded tools never receive a shell, input stream, unknown env or installs', async () => {
  const fake = processFixture()
  const result = runBoundedWindowsTool('C:\\official\\csc.exe', ['/noconfig'], toolOptions, fake.runtime)
  fake.child.stdout.write('fixed-output')
  fake.child.emit('exit', 0, null); fake.child.emit('close', 0, null)
  assert.equal((await result).stdout.toString(), 'fixed-output')
  assert.equal(fake.calls[0].options.shell, false)
  assert.deepEqual(fake.calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.deepEqual(fake.calls[0].options.env, { SystemRoot: 'C:\\Windows' })
  assert.equal(fake.calls.length, 1)
})

test('timeout, output overflow and cancellation clean a still-live root before rejection', async () => {
  for (const failure of ['timeout', 'overflow', 'cancel']) {
    const fake = processFixture(), controller = new AbortController()
    fake.setKill(() => setImmediate(() => { fake.child.emit('exit', 1, null); fake.child.emit('close', 1, null); fake.killer.emit('close', 0, null) }))
    const promise = runBoundedWindowsTool('C:\\official\\csc.exe', [], { ...toolOptions, signal: controller.signal, timeoutMs: failure === 'timeout' ? 5 : 40 }, fake.runtime)
    if (failure === 'overflow') fake.child.stderr.write(Buffer.alloc(129))
    if (failure === 'cancel') controller.abort()
    await assert.rejects(promise, error => error.cleanupVerified === true)
    assert.deepEqual(fake.calls[1].args, ['/PID', '111', '/T', '/F'])
    assert.equal(fake.calls[1].executable, toolOptions.taskkill)
  }
})

test('root exit clears PID authority even if inherited pipes stay open', async () => {
  const fake = processFixture()
  const promise = runBoundedWindowsTool('C:\\official\\csc.exe', [], { ...toolOptions, timeoutMs: 5 }, fake.runtime)
  fake.child.emit('exit', 0, null)
  await assert.rejects(promise, error => error.cleanupVerified === false)
  assert.equal(fake.calls.length, 1)
})

test('failed or unresponsive tree cleanup remains unverified and bounded', async () => {
  for (const mode of ['failed', 'unresponsive']) {
    const fake = processFixture()
    if (mode === 'failed') fake.setKill(() => setImmediate(() => fake.killer.emit('close', 1, null)))
    const promise = runBoundedWindowsTool('C:\\official\\csc.exe', [], { ...toolOptions, timeoutMs: 5 }, fake.runtime)
    await assert.rejects(promise, error => error.cleanupVerified === false)
    assert.equal(fake.calls.length, 2)
  }
})

test('spawn failure does not require targeting a nonexistent process', async () => {
  const fake = processFixture(); fake.child.pid = undefined
  const promise = runBoundedWindowsTool('C:\\missing\\csc.exe', [], toolOptions, fake.runtime)
  fake.child.emit('error', new Error('not found'))
  await assert.rejects(promise, error => error.cleanupVerified === true)
  assert.equal(fake.calls.length, 1)
  fake.child.emit('close', null, null)
  await tick()
})

test('CRLF checkout of the TS anchor preserves canonical LF native equivalence', async t => {
  const subject = await fixture(t)
  const file = path.join(subject.sourceRoot, 'src', 'command-windows.ts')
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replaceAll('\n', '\r\n'))
  const result = await buildWindowsCommandHelper(subject.options, subject.runtime)
  assert.equal(result.manifest.source.productionEquivalenceVerified, true)
  assert.equal(result.manifest.source.productionLineEndings, 'CRLF-to-LF-only')
})

test('stdout/stderr read errors enter cleanup and cannot become a successful tool exit', async () => {
  for (const stream of ['stdout', 'stderr']) {
    const fake = processFixture()
    fake.setKill(() => setImmediate(() => { fake.child.emit('exit', 1, null); fake.child.emit('close', 1, null); fake.killer.emit('close', 0, null) }))
    const promise = runBoundedWindowsTool('C:\\official\\csc.exe', [], toolOptions, fake.runtime)
    assert.doesNotThrow(() => fake.child[stream].emit('error', new Error('read failed')))
    await assert.rejects(promise, /observation failed/)
    assert.equal(fake.calls.length, 2)
  }
})

test('cleanup observes taskkill closure after forcing it, or reports its lifetime unverified', async () => {
  const fake = processFixture()
  let killed = false, closed = false
  fake.killer.kill = () => { killed = true; setTimeout(() => { closed = true; fake.killer.emit('close', null, 'SIGKILL') }, 5); return true }
  const promise = runBoundedWindowsTool('C:\\official\\csc.exe', [], { ...toolOptions, timeoutMs: 5 }, fake.runtime)
  await assert.rejects(promise, error => error.cleanupVerified === false)
  assert.equal(killed, true)
  assert.equal(closed, true)
})

test('artifact reparse ancestors are rejected before creating compiler outputs', async t => {
  const subject = await fixture(t)
  const reserved = path.join(subject.sourceRoot, '.vivi-build')
  await fs.mkdir(reserved)
  const link = path.join(reserved, 'redirect')
  await fs.symlink(path.join(subject.sourceRoot, 'native'), link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(buildWindowsCommandHelper({ ...subject.options, artifactDir: path.join(link, 'proof') }, subject.runtime), /reparse/)
  assert.equal(subject.calls.filter(call => call.executable.endsWith('csc.exe')).length, 0)
  await assert.rejects(fs.access(path.join(subject.sourceRoot, 'native', 'proof')), { code: 'ENOENT' })
})

test('version resources are informative only and discovery never downloads, installs or self-approves pins', async t => {
  const subject = await fixture(t, { badCompany: true })
  const result = await buildWindowsCommandHelper(subject.options, subject.runtime)
  assert.equal(result.manifest.toolchain.compiler.company, 'Unknown Publisher')
  assert.equal(result.manifest.toolchain.compiler.versionResourcesInformationalOnly, true)
  assert.match(result.manifest.toolchain.provenanceCheck, /PE-branding-is-informational-not-signer-authentication/)
  for (const call of subject.calls.filter(call => call.executable.endsWith('powershell.exe'))) {
    const program = Buffer.from(call.args.at(-1), 'base64').toString('utf16le')
    assert.ok(!/Add-Type|Install-|Invoke-WebRequest|Download|WinVerifyTrust|https?:/.test(program))
  }
})

test('toolchain traversal has entry/depth bounds even for noncompiler entries', async t => {
  for (const mode of ['entries', 'depth']) {
    const subject = await fixture(t)
    delete subject.runtime.listCompilerFiles
    const directory = name => ({ name, isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false })
    subject.runtime.readdir = async () => mode === 'entries' ? Array.from({ length: 4097 }, (_, index) => directory(`other-${index}`)) : [directory('nested')]
    await assert.rejects(buildWindowsCommandHelper(subject.options, subject.runtime), /bounded (?:entry count|directory depth)/)
    assert.equal(subject.calls.filter(call => call.executable.endsWith('csc.exe')).length, 0)
  }
})


test('cancellation during final artifact publication still discards the owned proof', async t => {
  const subject = await fixture(t)
  const controller = new AbortController()
  subject.runtime.beforePublish = async () => controller.abort()
  await assert.rejects(buildWindowsCommandHelper({ ...subject.options, signal: controller.signal }, subject.runtime), /cancelled/)
  await assert.rejects(fs.access(subject.artifactDir), { code: 'ENOENT' })
})

test('a declared self-hosted environment is rejected before SDK discovery', async t => {
  const subject = await fixture(t)
  subject.runtime.hostEnv = { ...host, RUNNER_ENVIRONMENT: 'self-hosted' }
  await assert.rejects(buildWindowsCommandHelper(subject.options, subject.runtime), /controlled GitHub-hosted/)
  assert.equal(subject.calls.length, 0)
})
