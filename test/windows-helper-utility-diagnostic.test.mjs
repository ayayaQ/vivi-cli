// SPDX-License-Identifier: Apache-2.0
// CI observation only: an explicit verified built-in OS manifest is the trust
// boundary. Metadata does not authenticate arbitrary modules or DLL locations.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HelperBuildError, runBoundedWindowsTool } from '../scripts/build-windows-command-helper.mjs'

const modes = ['minimal-baseline', 'exact-manifest']
const setupNames = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']
const identityPrefixes = ['add-type-meta', 'json-meta']
const phases = new Set(['helper-start', 'system-path-ready', 'baseline-skipped', 'module-path-reset', 'import-start', 'import-ready', 'import-error', 'resolve-start', 'resolve-ready', 'resolve-error', 'source-verified', 'add-type-start', 'add-type-ready', 'add-type-error', 'json-start', 'json-ready', 'json-error', 'helper-error', ...identityPrefixes.flatMap(prefix => ['module-kind-binary', 'module-kind-manifest', 'module-kind-other', 'identity-unavailable'].map(kind => `${prefix}-${kind}`))])
const program = String.raw`
function Phase([string]$name) {
  [Console]::Error.WriteLine('VIVI_UTILITY_PHASE:' + $name)
  [Console]::Error.Flush()
}
function PublicIdentity($assembly, [string]$prefix) {
  try {
    $name = $assembly.GetName(); $version = $name.Version; $token = $name.GetPublicKeyToken()
    if ($name.Name -cne 'Microsoft.PowerShell.Commands.Utility' -or -not [String]::IsNullOrEmpty($name.CultureName) -or $null -eq $version -or $null -eq $token -or $token.Length -ne 8) { return $false }
    foreach ($part in @($version.Major, $version.Minor, $version.Build, $version.Revision)) {
      if ($part -lt 0 -or $part -gt 65535) { return $false }
    }
    $hex = [BitConverter]::ToString($token).Replace('-', '').ToLowerInvariant()
    [Console]::Error.WriteLine('VIVI_UTILITY_IDENTITY:' + $prefix + ':' + $version.ToString() + ':neutral:' + $hex)
    [Console]::Error.Flush()
    return $true
  } catch { return $false }
}
Phase 'helper-start'
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$operation = 'invariant'
try {
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Unsupported language mode' }
  $home = [IO.Path]::GetFullPath([IO.Path]::Combine($env:SystemRoot, 'System32\WindowsPowerShell\v1.0'))
  if (-not [String]::Equals($PSHOME, $home, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected PowerShell home' }
  $modules = [IO.Path]::Combine($home, 'Modules')
  $manifest = [IO.Path]::Combine($modules, 'Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
  if (-not [IO.File]::Exists($manifest) -or ([IO.File]::GetAttributes($manifest) -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint))) { throw 'Unexpected built-in manifest' }
  $parent = [IO.Path]::GetDirectoryName($manifest)
  while (-not [String]::IsNullOrEmpty($parent)) {
    if ([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected built-in ancestor' }
    $parent = [IO.Path]::GetDirectoryName($parent)
  }
  Phase 'system-path-ready'
  $mode = $env:VIVI_UTILITY_DIAGNOSTIC_MODE
  if ($mode -eq 'minimal-baseline') {
    Phase 'baseline-skipped'
    [Console]::Out.WriteLine('VIVI_UTILITY_OUTCOME:baseline-not-reexecuted')
    exit 0
  }
  if ($mode -ne 'exact-manifest') { throw 'Unknown diagnostic mode' }
  [Environment]::SetEnvironmentVariable('PSModulePath', $modules)
  Phase 'module-path-reset'
  Phase 'import-start'
  $operation = 'import'
  Import-Module -Name $manifest -ErrorAction Stop
  $operation = 'invariant'
  Phase 'import-ready'
  Phase 'resolve-start'
  $operation = 'resolve'
  $commands = @((Get-Command 'Microsoft.PowerShell.Utility\Add-Type' -CommandType Cmdlet -ErrorAction Stop), (Get-Command 'Microsoft.PowerShell.Utility\ConvertFrom-Json' -CommandType Cmdlet -ErrorAction Stop))
  $operation = 'invariant'
  Phase 'resolve-ready'
  for ($index = 0; $index -lt 2; $index++) {
    $command = $commands[$index]; $expected = @('Add-Type', 'ConvertFrom-Json')[$index]
    $type = @('Microsoft.PowerShell.Commands.AddTypeCommand', 'Microsoft.PowerShell.Commands.ConvertFromJsonCommand')[$index]
    if ($command.Name -cne $expected -or $command.ModuleName -cne 'Microsoft.PowerShell.Utility' -or $null -eq $command.ImplementingType -or $command.ImplementingType.FullName -cne $type) { throw 'Unexpected built-in command' }
    $prefix = @('add-type-meta', 'json-meta')[$index]
    switch ([string]$command.Module.ModuleType) {
      'Binary' { Phase ($prefix + '-module-kind-binary') }
      'Manifest' { Phase ($prefix + '-module-kind-manifest') }
      default { Phase ($prefix + '-module-kind-other') }
    }
    if (-not (PublicIdentity $command.ImplementingType.Assembly $prefix)) { Phase ($prefix + '-identity-unavailable') }
  }
  Phase 'source-verified'
  Phase 'add-type-start'
  $operation = 'add-type'
  Microsoft.PowerShell.Utility\Add-Type -TypeDefinition 'public sealed class ViviUtilityDiagnostic {}' -ErrorAction Stop
  $operation = 'invariant'
  Phase 'add-type-ready'
  Phase 'json-start'
  $operation = 'json'
  $parsed = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject '{"value":"fixed"}' -ErrorAction Stop
  $operation = 'invariant'
  if ($parsed.value -ne 'fixed') { throw 'Unexpected fixed JSON result' }
  Phase 'json-ready'
  [Console]::Out.WriteLine('VIVI_UTILITY_OUTCOME:completed')
} catch {
  switch ($operation) {
    'import' { Phase 'import-error' }
    'resolve' { Phase 'resolve-error' }
    'add-type' { Phase 'add-type-error' }
    'json' { Phase 'json-error' }
    default { Phase 'helper-error' }
  }
  exit 1
}
`
const encoded = Buffer.from(program, 'utf16le').toString('base64')
const powershellArgs = Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])
function inputs(host, mode, temporary) {
  assert.ok(modes.includes(mode))
  const env = Object.fromEntries(setupNames.flatMap(name => typeof host[name] === 'string' ? [[name, host[name]]] : []))
  assert.match(env.SystemRoot ?? '', /^[a-z]:[\\/]/i)
  const home = path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
  env.TEMP = temporary; env.TMP = temporary
  if (env.TMPDIR !== undefined) env.TMPDIR = temporary
  env.VIVI_UTILITY_DIAGNOSTIC_MODE = mode
  if (mode === 'exact-manifest') env.PSModulePath = path.win32.join(home, 'Modules')
  return { env, home, powershell: path.win32.join(home, 'powershell.exe'), taskkill: path.win32.join(env.SystemRoot, 'System32', 'taskkill.exe'), manifest: path.win32.join(home, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1') }
}
function publicIdentity(line) {
  if (line.length > 96) return undefined
  const match = /^VIVI_UTILITY_IDENTITY:(add-type-meta|json-meta):([0-9]{1,5}(?:\.[0-9]{1,5}){3}):neutral:([0-9a-f]{16})$/.exec(line)
  if (!match || !match[2].split('.').every(part => Number(part) <= 65535 && String(Number(part)) === part)) return undefined
  return { prefix: match[1], name: 'Microsoft.PowerShell.Commands.Utility', version: match[2], culture: 'neutral', token: match[3] }
}
function reader(notify, identity = () => {}) {
  const seen = new Set(), identities = new Set()
  let line = '', discard = false
  const observe = (callback, item) => { try { Promise.resolve(callback(item)).catch(() => {}) } catch { /* diagnostic-only */ } }
  return bytes => {
    for (const byte of bytes) {
      if (byte === 10) {
        const current = line.replace(/\r$/, ''), name = current.replace(/^VIVI_UTILITY_PHASE:/, ''), record = !discard && publicIdentity(current)
        if (!discard && current.startsWith('VIVI_UTILITY_PHASE:') && phases.has(name) && !seen.has(name)) { seen.add(name); observe(notify, name) }
        if (record && !identities.has(record.prefix)) { identities.add(record.prefix); observe(identity, record) }
        line = ''; discard = false
      } else if (!discard) {
        if (line.length >= 96) { line = ''; discard = true }
        else line += String.fromCharCode(byte)
      }
    }
  }
}
async function verifySystemFile(file, directory = false) {
  try {
    const info = await fs.lstat(file)
    assert.equal(info.isSymbolicLink(), false)
    assert.equal(directory ? info.isDirectory() : info.isFile(), true)
    assert.equal(path.win32.normalize(await fs.realpath(file)).toLowerCase(), path.win32.normalize(file).toLowerCase())
    let parent = path.win32.dirname(file)
    while (true) {
      assert.equal((await fs.lstat(parent)).isSymbolicLink(), false)
      const next = path.win32.dirname(parent)
      if (next === parent) break
      parent = next
    }
  } catch { throw new Error('Verified built-in OS component unavailable') }
}
function observedOperationFailure(error, observed) {
  if (!(error instanceof HelperBuildError) || error.cleanupVerified === false || error.message !== 'Tool returned a nonzero exit status') return undefined
  const operation = observed.at(-1)?.match(/^(import|resolve|add-type|json)-error$/)?.[1]
  if (!operation || observed.includes('helper-error')) return undefined
  assert.ok(observed.includes(`${operation}-start`) && !observed.includes(`${operation}-ready`))
  if (operation !== 'import') assert.ok(observed.includes('import-ready'))
  if (operation === 'add-type' || operation === 'json') assert.ok(observed.includes('source-verified'))
  if (operation === 'json') assert.ok(observed.includes('add-type-ready'))
  return operation
}

test('Utility probe uses the verified OS manifest, fixed module environment and bounded authored source', () => {
  const host = { SystemRoot: 'C:\\Windows', PSModulePath: 'C:\\user', USERPROFILE: 'C:\\user', OPENAI_API_KEY: 'private' }
  const active = inputs(host, 'exact-manifest', 'C:\\owned-temp'), baseline = inputs(host, 'minimal-baseline', 'C:\\owned-temp')
  assert.deepEqual(modes, ['minimal-baseline', 'exact-manifest'])
  assert.deepEqual(Object.keys(active.env).sort(), ['SystemRoot', 'TEMP', 'TMP', 'PSModulePath', 'VIVI_UTILITY_DIAGNOSTIC_MODE'].sort())
  assert.equal(active.env.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules')
  assert.equal(baseline.env.PSModulePath, undefined)
  assert.ok(!/ViviCommandJob|\.Run\(|ConvertTo-Json|Set-ExecutionPolicy|ExecutionPolicy|Bypass|Install-|Download|Invoke-WebRequest|GetAssemblyName|GacCategory|\.dll/.test(program))
  assert.ok(program.indexOf('baseline-not-reexecuted') < program.indexOf('Import-Module'))
  assert.ok(program.indexOf("SetEnvironmentVariable('PSModulePath'") < program.indexOf('Import-Module'))
  assert.ok(program.includes("Import-Module -Name $manifest -ErrorAction Stop"))
  assert.ok(program.includes('[IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint'))
  assert.ok(program.includes('[IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint'))
  assert.ok(program.includes('$command.ImplementingType.FullName -cne $type'))
  assert.ok(program.indexOf("Phase 'source-verified'") < program.indexOf("Microsoft.PowerShell.Utility\\Add-Type -TypeDefinition"))
  assert.ok([active.powershell, ...powershellArgs].reduce((total, item) => total + item.length + 3, 1) <= 32_767)
  assert.ok([...phases].every(name => `VIVI_UTILITY_PHASE:${name}\r\n`.length <= 96))
})
test('public OS identity records allow only bounded known neutral Utility identities', () => {
  const frame = 'VIVI_UTILITY_IDENTITY:add-type-meta:3.0.0.0:neutral:31bf3856ad364e35'
  assert.deepEqual(publicIdentity(frame), { prefix: 'add-type-meta', name: 'Microsoft.PowerShell.Commands.Utility', version: '3.0.0.0', culture: 'neutral', token: '31bf3856ad364e35' })
  for (const line of [frame.replace('3.0.0.0', '65536.0.0.0'), frame.replace('3.0.0.0', '03.0.0.0'), frame.replace('3.0.0.0', '3.0.0'), frame.replace('neutral', 'user'), frame.replace('31bf', 'G1bf'), frame + 'private', frame.replace('add-type-meta', 'private-prefix'), 'x'.repeat(97)]) assert.equal(publicIdentity(line), undefined)
  const records = [], observed = [], consume = reader(name => observed.push(name), item => records.push(item))
  for (const byte of Buffer.from(frame + '\r\nVIVI_UTILITY_PHASE:import-ready\n')) consume([byte])
  consume(Buffer.from(frame + '\nprivate raw path\n' + 'x'.repeat(1024) + frame + '\n'))
  assert.equal(records.length, 1); assert.deepEqual(observed, ['import-ready'])
})
test('operation observations never hide component/source/result or cleanup invariant failures', () => {
  const error = new HelperBuildError('Tool returned a nonzero exit status')
  assert.equal(observedOperationFailure(error, ['import-start', 'import-error']), 'import')
  assert.equal(observedOperationFailure(error, ['import-ready', 'source-verified', 'add-type-start', 'add-type-ready', 'json-start', 'json-error']), 'json')
  assert.equal(observedOperationFailure(error, ['helper-error']), undefined)
  assert.equal(observedOperationFailure(new HelperBuildError(error.message, { cleanupVerified: false }), ['import-start', 'import-error']), undefined)
  assert.throws(() => observedOperationFailure(error, ['json-start', 'json-error']))
})
test('Windows exact built-in Utility import/Add-Type/JSON timing is bounded and serialized', { skip: process.platform !== 'win32', timeout: 190_000 }, async t => {
  const host = Object.freeze(Object.fromEntries(setupNames.flatMap(name => {
    const value = process.env[name] ?? process.env[name.toUpperCase()]
    return typeof value === 'string' ? [[name, value]] : []
  })))
  for (const mode of modes) {
    const temporary = await fs.mkdtemp(path.join(tmpdir(), 'vivi-utility-observation-'))
    let cleanupVerified = true
    try {
      const input = inputs(host, mode, temporary)
      await verifySystemFile(input.powershell); await verifySystemFile(input.taskkill)
      await verifySystemFile(input.home, true); await verifySystemFile(input.manifest)
      const started = performance.now(), observed = []
      const consume = reader(name => { observed.push(name); t.diagnostic(`${mode}:${name}:${Math.floor(performance.now() - started)}ms`) }, item => t.diagnostic(`${mode}:${item.prefix}:${item.name}:${item.version}:neutral:${item.token}`))
      const runtime = { spawn(exe, args, options) { const child = spawn(exe, args, options); if (exe === input.powershell) child.stderr.on('data', consume); return child } }
      let result
      try { result = await runBoundedWindowsTool(input.powershell, powershellArgs, { env: input.env, cwd: temporary, taskkill: input.taskkill, timeoutMs: 50_000, maxOutputBytes: 16_384, signal: t.signal }, runtime) }
      catch (error) {
        cleanupVerified = error?.cleanupVerified !== false
        if (!(error instanceof HelperBuildError) || !cleanupVerified || observed.includes('helper-error')) throw error
        const operation = observedOperationFailure(error, observed)
        if (!operation && error.message !== 'Tool exceeded its bounded timeout') throw error
        t.diagnostic(`${mode}:${operation ? operation + '-failure-observed' : 'observation-timeout'}:${Math.floor(performance.now() - started)}ms`)
        continue
      }
      const outcome = result.stdout.toString('utf8').replace(/\r\n/g, '\n')
      assert.ok(outcome === (mode === 'minimal-baseline' ? 'VIVI_UTILITY_OUTCOME:baseline-not-reexecuted\n' : 'VIVI_UTILITY_OUTCOME:completed\n'), 'Unexpected fixed Utility diagnostic result')
      if (mode === 'minimal-baseline') assert.ok(observed.includes('baseline-skipped') && !observed.includes('import-start'))
      else assert.ok(['import-ready', 'source-verified', 'add-type-ready', 'json-ready'].every(name => observed.includes(name)))
      t.diagnostic(`${mode}:${mode === 'minimal-baseline' ? 'baseline-not-reexecuted' : 'observation-completed'}`)
    } finally {
      if (cleanupVerified) await fs.rm(temporary, { recursive: true, force: true })
      else t.diagnostic(`${mode}:cleanup-unverified-quarantine-retained`)
    }
  }
})
