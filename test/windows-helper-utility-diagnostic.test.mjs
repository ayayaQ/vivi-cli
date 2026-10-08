// SPDX-License-Identifier: Apache-2.0
// Observation only. Prior censored minimal-env timings remain the baseline;
// this fixture never searches user modules, changes policy or invokes Run.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HelperBuildError, runBoundedWindowsTool } from '../scripts/build-windows-command-helper.mjs'

const modes = ['minimal-baseline', 'system-only', 'exact-manifest']
const setupNames = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']
const phases = new Set(['helper-start', 'system-path-ready', 'module-search-trusted', 'module-search-untrusted', 'module-path-reset', 'import-start', 'import-ready', 'import-error', 'resolve-start', 'resolve-ready', 'resolve-error', 'source-verified', 'add-type-start', 'add-type-ready', 'add-type-error', 'json-start', 'json-ready', 'json-error', 'helper-error'])
const program = String.raw`
function Phase([string]$name) {
  [Console]::Error.WriteLine('VIVI_UTILITY_PHASE:' + $name)
  [Console]::Error.Flush()
}
Phase 'helper-start'
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$operation = 'invariant'
try {
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'Unsupported language mode' }
  $expectedHome = [IO.Path]::GetFullPath([IO.Path]::Combine([Environment]::GetEnvironmentVariable('SystemRoot'), 'System32\WindowsPowerShell\v1.0'))
  if (-not [String]::Equals($PSHOME, $expectedHome, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected PowerShell home' }
  $systemModules = [IO.Path]::Combine($expectedHome, 'Modules')
  $moduleDirectory = [IO.Path]::Combine($systemModules, 'Microsoft.PowerShell.Utility')
  $manifest = [IO.Path]::Combine($moduleDirectory, 'Microsoft.PowerShell.Utility.psd1')
  if (-not [IO.File]::Exists($manifest)) { throw 'Missing built-in manifest' }
  Phase 'system-path-ready'
  $mode = [Environment]::GetEnvironmentVariable('VIVI_UTILITY_DIAGNOSTIC_MODE')
  if ($mode -ne 'minimal-baseline' -and $mode -ne 'system-only' -and $mode -ne 'exact-manifest') { throw 'Unknown diagnostic mode' }
  $search = [string][Environment]::GetEnvironmentVariable('PSModulePath')
  $searchEntries = $search.Split([char]';', [StringSplitOptions]::RemoveEmptyEntries)
  $trustedSearch = $searchEntries.Length -gt 0
  foreach ($directory in $searchEntries) {
    if (-not [String]::Equals([IO.Path]::GetFullPath($directory), $systemModules, [StringComparison]::OrdinalIgnoreCase)) { $trustedSearch = $false }
  }
  if ($trustedSearch) { Phase 'module-search-trusted' } else { Phase 'module-search-untrusted' }
  if ($mode -eq 'minimal-baseline' -and -not $trustedSearch) {
    [Console]::Out.WriteLine('VIVI_UTILITY_OUTCOME:baseline-not-reexecuted')
    exit 0
  }
  if ($mode -ne 'minimal-baseline') {
    [Environment]::SetEnvironmentVariable('PSModulePath', $systemModules)
    Phase 'module-path-reset'
  }
  if ($mode -eq 'exact-manifest') {
    Phase 'import-start'
    $operation = 'import'
    Import-Module -Name $manifest -ErrorAction Stop
    $operation = 'invariant'
    Phase 'import-ready'
  }
  Phase 'resolve-start'
  $operation = 'resolve'
  $addType = Get-Command -Name 'Microsoft.PowerShell.Utility\Add-Type' -CommandType Cmdlet -ErrorAction Stop
  $fromJson = Get-Command -Name 'Microsoft.PowerShell.Utility\ConvertFrom-Json' -CommandType Cmdlet -ErrorAction Stop
  $operation = 'invariant'
  Phase 'resolve-ready'
  foreach ($command in @($addType, $fromJson)) {
    if ($command.ModuleName -ne 'Microsoft.PowerShell.Utility' -or $null -eq $command.Module -or
        -not [String]::Equals($command.Module.Path, $manifest, [StringComparison]::OrdinalIgnoreCase) -or
        -not [String]::Equals($command.Module.ModuleBase, $moduleDirectory, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected command source' }
  }
  Phase 'source-verified'
  Phase 'add-type-start'
  $operation = 'add-type'
  & $addType -TypeDefinition 'public sealed class ViviUtilityDiagnostic {}' -ErrorAction Stop
  $operation = 'invariant'
  Phase 'add-type-ready'
  Phase 'json-start'
  $operation = 'json'
  $parsed = & $fromJson -InputObject '{"value":"fixed"}' -ErrorAction Stop
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
function value(env, name) { return Object.entries(env).find(([key, item]) => key.toLowerCase() === name.toLowerCase() && typeof item === 'string')?.[1] }
function inputs(host, mode, temporary) {
  assert.ok(modes.includes(mode))
  const env = Object.fromEntries(setupNames.flatMap(name => value(host, name) === undefined ? [] : [[name, value(host, name)]]))
  assert.match(env.SystemRoot ?? '', /^[a-z]:[\\/]/i)
  const home = path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
  env.TEMP = temporary; env.TMP = temporary
  if (env.TMPDIR !== undefined) env.TMPDIR = temporary
  env.VIVI_UTILITY_DIAGNOSTIC_MODE = mode
  if (mode !== 'minimal-baseline') env.PSModulePath = path.win32.join(home, 'Modules')
  return { env, powershell: path.win32.join(home, 'powershell.exe'), taskkill: path.win32.join(env.SystemRoot, 'System32', 'taskkill.exe'), modules: path.win32.join(home, 'Modules'), manifest: path.win32.join(home, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1') }
}
function reader(notify) {
  const seen = new Set()
  let line = '', discard = false
  return bytes => {
    for (const byte of bytes) {
      if (byte === 10) {
        const name = !discard && line.replace(/\r$/, '').replace(/^VIVI_UTILITY_PHASE:/, '')
        if (!discard && line.startsWith('VIVI_UTILITY_PHASE:') && phases.has(name) && !seen.has(name)) {
          seen.add(name)
          try { Promise.resolve(notify(name)).catch(() => {}) } catch { /* diagnostic-only */ }
        }
        line = ''; discard = false
      } else if (!discard) {
        if (line.length >= 96) { line = ''; discard = true }
        else line += String.fromCharCode(byte)
      }
    }
  }
}
async function verifySystemFile(file, directory = false) {
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
}
function observedOperationFailure(error, observed, mode) {
  if (!(error instanceof HelperBuildError) || error.cleanupVerified === false || error.message !== 'Tool returned a nonzero exit status') return undefined
  const operation = observed.at(-1)?.match(/^(import|resolve|add-type|json)-error$/)?.[1]
  if (!operation || observed.includes('helper-error')) return undefined
  assert.ok(observed.includes(`${operation}-start`) && !observed.includes(`${operation}-ready`))
  if (operation === 'import') assert.equal(mode, 'exact-manifest')
  if (operation === 'add-type' || operation === 'json') assert.ok(observed.includes('source-verified'))
  if (operation === 'json') assert.ok(observed.includes('add-type-ready'))
  return operation
}

test('Utility diagnostic source and environments are fixed and cannot use providers, user modules or policy overrides', () => {
  const host = { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: 'C:\\Temp', TMP: 'C:\\Temp', PSModulePath: 'C:\\user-modules', USERPROFILE: 'C:\\user', PATH: 'private', OPENAI_API_KEY: 'private' }
  for (const mode of modes) {
    const input = inputs(host, mode, 'C:\\owned-temp')
    assert.deepEqual(Object.keys(input.env).sort(), ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'VIVI_UTILITY_DIAGNOSTIC_MODE', ...(mode === 'minimal-baseline' ? [] : ['PSModulePath'])].sort())
    assert.equal(input.env.PSModulePath, mode === 'minimal-baseline' ? undefined : 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules')
  }
  assert.ok(!/ViviCommandJob|\.Run\(|ConvertTo-Json|Set-ExecutionPolicy|ExecutionPolicy|Bypass|Install-|Download|Invoke-WebRequest/.test(program))
  assert.ok(program.indexOf('baseline-not-reexecuted') < program.indexOf('Get-Command'))
  assert.ok(program.indexOf("SetEnvironmentVariable('PSModulePath'") < program.indexOf('Import-Module'))
  assert.ok(program.indexOf("Phase 'source-verified'") < program.indexOf('& $addType'))
  assert.ok(program.indexOf("Phase 'source-verified'") < program.indexOf('& $fromJson'))
  assert.ok(program.includes('$command.Module.Path, $manifest'))
  assert.ok(program.includes('$trustedSearch = $searchEntries.Length -gt 0'))
  assert.ok(program.includes('public sealed class ViviUtilityDiagnostic {}'))
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), program)
})
test('Utility phase observations are exact, bounded, deduplicated and chunk-safe', () => {
  const observed = [], consume = reader(name => observed.push(name))
  const data = Buffer.from('private\nVIVI_UTILITY_PHASE:helper-start\r\nVIVI_UTILITY_PHASE:import-start\n')
  for (const byte of data) consume([byte])
  consume(Buffer.from('VIVI_UTILITY_PHASE:helper-start\nVIVI_UTILITY_PHASE:private\n' + 'x'.repeat(1024) + 'VIVI_UTILITY_PHASE:json-ready\n'))
  consume(Buffer.from('VIVI_UTILITY_PHASE:import-ready\nVIVI_UTILITY_PHASE:json-ready\n'))
  assert.deepEqual(observed, ['helper-start', 'import-start', 'import-ready', 'json-ready'])
})
test('observed operation failures cannot hide source, result, language or cleanup invariant failures', () => {
  const failure = new HelperBuildError('Tool returned a nonzero exit status')
  assert.equal(observedOperationFailure(failure, ['import-start', 'import-error'], 'exact-manifest'), 'import')
  assert.equal(observedOperationFailure(failure, ['resolve-start', 'resolve-error'], 'system-only'), 'resolve')
  assert.equal(observedOperationFailure(failure, ['source-verified', 'add-type-start', 'add-type-error'], 'system-only'), 'add-type')
  assert.equal(observedOperationFailure(failure, ['source-verified', 'add-type-ready', 'json-start', 'json-error'], 'system-only'), 'json')
  assert.equal(observedOperationFailure(failure, ['helper-error'], 'system-only'), undefined)
  assert.equal(observedOperationFailure(failure, ['helper-error', 'json-start', 'json-error'], 'system-only'), undefined)
  assert.equal(observedOperationFailure(new HelperBuildError('Tool returned a nonzero exit status', { cleanupVerified: false }), ['import-start', 'import-error'], 'exact-manifest'), undefined)
  assert.equal(observedOperationFailure(new HelperBuildError('Tool stdout observation failed'), ['import-start', 'import-error'], 'exact-manifest'), undefined)
  for (const observed of [['json-error'], ['json-start', 'json-error'], ['source-verified', 'json-start', 'json-error'], ['source-verified', 'add-type-ready', 'json-start', 'json-ready', 'json-error']]) assert.throws(() => observedOperationFailure(failure, observed, 'system-only'))
  assert.throws(() => observedOperationFailure(failure, ['import-start', 'import-error'], 'system-only'))
})
test('Windows Utility module environment observations are serialized, bounded and never execute the command Job helper', { skip: process.platform !== 'win32', timeout: 190_000 }, async t => {
  const frozenHost = Object.freeze(Object.fromEntries(setupNames.flatMap(name => {
    const item = process.env[name] ?? process.env[name.toUpperCase()]
    return typeof item === 'string' ? [[name, item]] : []
  })))
  for (const mode of modes) {
    const temporary = await fs.mkdtemp(path.join(tmpdir(), 'vivi-utility-observation-'))
    let cleanupVerified = true
    try {
      const input = inputs(frozenHost, mode, temporary)
      await verifySystemFile(input.powershell); await verifySystemFile(input.taskkill)
      await verifySystemFile(input.modules, true); await verifySystemFile(input.manifest)
      const started = performance.now(), observed = []
      const consume = reader(name => { observed.push(name); t.diagnostic(`${mode}:${name}:${Math.floor(performance.now() - started)}ms`) })
      const runtime = { spawn(exe, args, options) { const child = spawn(exe, args, options); if (exe === input.powershell) child.stderr.on('data', consume); return child } }
      let result
      try {
        result = await runBoundedWindowsTool(input.powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env: input.env, cwd: temporary, taskkill: input.taskkill, timeoutMs: 50_000, maxOutputBytes: 16_384, signal: t.signal }, runtime)
      } catch (error) {
        cleanupVerified = error?.cleanupVerified !== false
        if (!(error instanceof HelperBuildError) || !cleanupVerified || observed.includes('helper-error')) throw error
        const operation = observedOperationFailure(error, observed, mode)
        if (operation) {
          t.diagnostic(`${mode}:${operation}-failure-observed:${Math.floor(performance.now() - started)}ms`)
          continue
        }
        if (error.message !== 'Tool exceeded its bounded timeout') throw error
        t.diagnostic(`${mode}:observation-timeout:${Math.floor(performance.now() - started)}ms`)
        continue
      }
      const outcome = result.stdout.toString('utf8').replace(/\r\n/g, '\n')
      if (outcome === 'VIVI_UTILITY_OUTCOME:baseline-not-reexecuted\n') {
        assert.equal(mode, 'minimal-baseline')
        assert.ok(observed.includes('module-search-untrusted'))
        assert.ok(!observed.includes('resolve-start') && !observed.includes('add-type-start') && !observed.includes('json-start'))
        t.diagnostic(`${mode}:baseline-not-reexecuted`)
      } else {
        assert.equal(outcome, 'VIVI_UTILITY_OUTCOME:completed\n')
        assert.ok(observed.includes('source-verified') && observed.includes('add-type-ready') && observed.includes('json-ready'))
        if (mode === 'exact-manifest') assert.ok(observed.includes('import-ready'))
        t.diagnostic(`${mode}:observation-completed`)
      }
    } finally {
      if (cleanupVerified) await fs.rm(temporary, { recursive: true, force: true })
      else t.diagnostic(`${mode}:cleanup-unverified-quarantine-retained`)
    }
  }
})
