// SPDX-License-Identifier: Apache-2.0
// Observation only. Prior censored minimal-env timings remain the baseline;
// this fixture never searches user modules, changes policy or invokes Run.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { HelperBuildError, runBoundedWindowsTool } from '../scripts/build-windows-command-helper.mjs'

const modes = ['minimal-baseline', 'system-only', 'exact-manifest']
const setupNames = ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']
const metadataPrefixes = ['add-type-meta', 'json-meta']
const metadataCategories = {
  name: ['match', 'mismatch', 'unavailable'], module: ['match', 'mismatch', 'unavailable'], type: ['match', 'mismatch', 'unavailable'],
  'assembly-name': ['match', 'mismatch', 'unavailable'], identity: ['match', 'mismatch', 'unavailable'],
  'module-path': ['manifest', 'binary', 'gac', 'other', 'unavailable'], 'module-base': ['manifest', 'home', 'gac', 'other', 'unavailable'],
  'module-pair': ['manifest', 'binary', 'mixed-trusted', 'other', 'unavailable'], location: ['pshome', 'gac', 'other', 'unavailable'],
}
const phases = new Set(['helper-start', 'system-path-ready', 'module-search-trusted', 'module-search-untrusted', 'module-path-reset', 'import-start', 'import-ready', 'import-error', 'resolve-start', 'resolve-ready', 'resolve-error', 'source-kind-manifest', 'source-kind-binary', 'source-kind-unexpected', 'source-type-unexpected', 'source-location-unexpected', 'source-identity-unexpected', 'source-verified', 'add-type-start', 'add-type-ready', 'add-type-error', 'json-start', 'json-ready', 'json-error', 'helper-error', ...metadataPrefixes.flatMap(prefix => Object.entries(metadataCategories).flatMap(([key, values]) => values.map(item => `${prefix}-${key}-${item}`)))])
const program = String.raw`
function Phase([string]$name) {
  [Console]::Error.WriteLine('VIVI_UTILITY_PHASE:' + $name)
  [Console]::Error.Flush()
}
function MatchCategory([string]$actual, [string]$expected) {
  if ([String]::IsNullOrEmpty($actual) -or $actual.Length -gt 4096) { return 'unavailable' }
  if ([String]::Equals($actual, $expected, [StringComparison]::Ordinal)) { return 'match' }
  return 'mismatch'
}
function GacCategory([string]$location, [string]$windows) {
  if ([String]::IsNullOrEmpty($location) -or $location.Length -gt 4096 -or $location -notmatch '^[a-z]:[\\/]') { return $false }
  try {
    $normalized = [IO.Path]::GetFullPath($location).TrimEnd([char[]]@('\', '/'))
    foreach ($relative in @('Microsoft.NET\assembly\GAC_MSIL', 'Microsoft.NET\assembly\GAC_32', 'Microsoft.NET\assembly\GAC_64', 'assembly\GAC', 'assembly\GAC_MSIL', 'assembly\GAC_32', 'assembly\GAC_64')) {
      $root = [IO.Path]::GetFullPath([IO.Path]::Combine($windows, $relative))
      if ([String]::Equals($normalized, $root, [StringComparison]::OrdinalIgnoreCase) -or $normalized.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
  } catch { return $false }
  return $false
}
function PathCategory([string]$actual, [string]$first, [string]$second, [string]$windows, [string]$firstName, [string]$secondName) {
  if ([String]::IsNullOrEmpty($actual) -or $actual.Length -gt 4096) { return 'unavailable' }
  if ([String]::Equals($actual, $first, [StringComparison]::OrdinalIgnoreCase)) { return $firstName }
  if ([String]::Equals($actual, $second, [StringComparison]::OrdinalIgnoreCase)) { return $secondName }
  if (GacCategory $actual $windows) { return 'gac' }
  return 'other'
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
  $utilityDll = [IO.Path]::Combine($expectedHome, 'Microsoft.PowerShell.Commands.Utility.dll')
  foreach ($filePath in @($manifest, $utilityDll)) {
    if (-not [IO.File]::Exists($filePath) -or ([IO.File]::GetAttributes($filePath) -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint))) { throw 'Unexpected built-in file' }
    $parent = [IO.Path]::GetDirectoryName($filePath)
    while (-not [String]::IsNullOrEmpty($parent)) {
      if ([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected built-in ancestor' }
      $parent = [IO.Path]::GetDirectoryName($parent)
    }
  }
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
  $installedIdentity = [Reflection.AssemblyName]::GetAssemblyName($utilityDll)
  $expectedTypes = @{ 'Add-Type' = 'Microsoft.PowerShell.Commands.AddTypeCommand'; 'ConvertFrom-Json' = 'Microsoft.PowerShell.Commands.ConvertFromJsonCommand' }
  # Observe both fixed commands before any rejection. Categories confer no trust.
  for ($index = 0; $index -lt 2; $index++) {
    $command = @($addType, $fromJson)[$index]
    $prefix = @('add-type-meta', 'json-meta')[$index]
    $expectedName = @('Add-Type', 'ConvertFrom-Json')[$index]
    Phase ($prefix + '-name-' + (MatchCategory $command.Name $expectedName))
    Phase ($prefix + '-module-' + (MatchCategory $command.ModuleName 'Microsoft.PowerShell.Utility'))
    $pathKind = PathCategory $command.Module.Path $manifest $utilityDll $env:SystemRoot 'manifest' 'binary'
    $baseKind = PathCategory $command.Module.ModuleBase $moduleDirectory $expectedHome $env:SystemRoot 'manifest' 'home'
    Phase ($prefix + '-module-path-' + $pathKind)
    Phase ($prefix + '-module-base-' + $baseKind)
    if ($pathKind -eq 'manifest' -and $baseKind -eq 'manifest') { $pair = 'manifest' }
    elseif ($pathKind -eq 'binary' -and $baseKind -eq 'home') { $pair = 'binary' }
    elseif ($pathKind -eq 'unavailable' -or $baseKind -eq 'unavailable') { $pair = 'unavailable' }
    elseif (($pathKind -eq 'manifest' -or $pathKind -eq 'binary') -and ($baseKind -eq 'manifest' -or $baseKind -eq 'home')) { $pair = 'mixed-trusted' }
    else { $pair = 'other' }
    Phase ($prefix + '-module-pair-' + $pair)
    Phase ($prefix + '-type-' + (MatchCategory $command.ImplementingType.FullName $expectedTypes[$expectedName]))
    $assembly = $command.ImplementingType.Assembly
    $assemblyLocation = $null; $assemblyIdentity = $null; $assemblyName = $null
    try { $assemblyLocation = $assembly.Location } catch {}
    try { $assemblyIdentity = $assembly.FullName } catch {}
    try { if ($null -ne $assembly) { $assemblyName = $assembly.GetName().Name } } catch {}
    $locationKind = PathCategory $assemblyLocation $utilityDll $utilityDll $env:SystemRoot 'pshome' 'pshome'
    Phase ($prefix + '-location-' + $locationKind)
    Phase ($prefix + '-assembly-name-' + (MatchCategory $assemblyName 'Microsoft.PowerShell.Commands.Utility'))
    Phase ($prefix + '-identity-' + (MatchCategory $assemblyIdentity $installedIdentity.FullName))
  }
  if ($installedIdentity.Name -cne 'Microsoft.PowerShell.Commands.Utility') { throw 'Unexpected built-in assembly' }
  foreach ($command in @($addType, $fromJson)) {
    if ($command.CommandType -ne 'Cmdlet' -or $command.ModuleName -cne 'Microsoft.PowerShell.Utility' -or $null -eq $command.Module -or
        -not $expectedTypes.ContainsKey($command.Name) -or $null -eq $command.ImplementingType) { throw 'Unexpected command source' }
    $manifestSource = [String]::Equals($command.Module.Path, $manifest, [StringComparison]::OrdinalIgnoreCase) -and
      [String]::Equals($command.Module.ModuleBase, $moduleDirectory, [StringComparison]::OrdinalIgnoreCase)
    $binarySource = [String]::Equals($command.Module.Path, $utilityDll, [StringComparison]::OrdinalIgnoreCase) -and
      [String]::Equals($command.Module.ModuleBase, $expectedHome, [StringComparison]::OrdinalIgnoreCase)
    if ($manifestSource) { Phase 'source-kind-manifest' } elseif ($binarySource) { Phase 'source-kind-binary' }
    else { Phase 'source-kind-unexpected'; throw 'Unexpected command source' }
    $assembly = $command.ImplementingType.Assembly
    if ($command.ImplementingType.FullName -cne $expectedTypes[$command.Name] -or $null -eq $assembly) { Phase 'source-type-unexpected'; throw 'Unexpected implementing type' }
    if (-not [String]::Equals($assembly.Location, $utilityDll, [StringComparison]::OrdinalIgnoreCase)) { Phase 'source-location-unexpected'; throw 'Unexpected implementing location' }
    if ($assembly.FullName -cne $installedIdentity.FullName) { Phase 'source-identity-unexpected'; throw 'Unexpected implementing identity' }
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
const powershellArgs = Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded])
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
  return { env, home, powershell: path.win32.join(home, 'powershell.exe'), taskkill: path.win32.join(env.SystemRoot, 'System32', 'taskkill.exe'), modules: path.win32.join(home, 'Modules'), manifest: path.win32.join(home, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1'), utilityDll: path.win32.join(home, 'Microsoft.PowerShell.Commands.Utility.dll') }
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
// Controlled data model of the coupled native source predicate, anchored below.
// It does not execute PowerShell or authenticate a signer/toolchain pin.
function modeledSourceKind(command, input, installedIdentity) {
  const expectedTypes = { 'Add-Type': 'Microsoft.PowerShell.Commands.AddTypeCommand', 'ConvertFrom-Json': 'Microsoft.PowerShell.Commands.ConvertFromJsonCommand' }
  const equalPath = (left, right) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase()
  if (command.commandType !== 'Cmdlet' || command.moduleName !== 'Microsoft.PowerShell.Utility' || !command.module || !Object.hasOwn(expectedTypes, command.name) || command.typeName !== expectedTypes[command.name] || installedIdentity.name !== 'Microsoft.PowerShell.Commands.Utility' || !equalPath(command.assemblyLocation, input.utilityDll) || command.assemblyIdentity !== installedIdentity.fullName) return undefined
  const manifestSource = equalPath(command.module.path, input.manifest) && equalPath(command.module.base, path.win32.dirname(input.manifest))
  const binarySource = equalPath(command.module.path, input.utilityDll) && equalPath(command.module.base, input.home)
  return manifestSource ? 'manifest' : binarySource ? 'binary' : undefined
}
function modeledGacLocation(location, windows) {
  if (typeof location !== 'string' || !location || location.length > 4096 || !/^[a-z]:[\\/]/i.test(location)) return false
  const normalized = path.win32.normalize(location).replace(/[\\/]+$/, '').toLowerCase()
  return ['Microsoft.NET/assembly/GAC_MSIL', 'Microsoft.NET/assembly/GAC_32', 'Microsoft.NET/assembly/GAC_64', 'assembly/GAC', 'assembly/GAC_MSIL', 'assembly/GAC_32', 'assembly/GAC_64'].some(relative => {
    const root = path.win32.join(windows, relative).toLowerCase()
    return normalized === root || normalized.startsWith(root + '\\')
  })
}
function modeledMetadata(command, input, installedIdentity, expectedName) {
  const match = (actual, expected) => typeof actual !== 'string' || !actual || actual.length > 4096 ? 'unavailable' : actual === expected ? 'match' : 'mismatch'
  const classify = (actual, first, second, firstName, secondName) => typeof actual !== 'string' || !actual || actual.length > 4096 ? 'unavailable' : actual.toLowerCase() === first.toLowerCase() ? firstName : actual.toLowerCase() === second.toLowerCase() ? secondName : modeledGacLocation(actual, input.env.SystemRoot) ? 'gac' : 'other'
  const modulePath = classify(command.module?.path, input.manifest, input.utilityDll, 'manifest', 'binary')
  const moduleBase = classify(command.module?.base, path.win32.dirname(input.manifest), input.home, 'manifest', 'home')
  const pair = modulePath === 'manifest' && moduleBase === 'manifest' ? 'manifest' : modulePath === 'binary' && moduleBase === 'home' ? 'binary' : [modulePath, moduleBase].includes('unavailable') ? 'unavailable' : ['manifest', 'binary'].includes(modulePath) && ['manifest', 'home'].includes(moduleBase) ? 'mixed-trusted' : 'other'
  return { name: match(command.name, expectedName), module: match(command.moduleName, 'Microsoft.PowerShell.Utility'), type: match(command.typeName, expectedName === 'Add-Type' ? 'Microsoft.PowerShell.Commands.AddTypeCommand' : 'Microsoft.PowerShell.Commands.ConvertFromJsonCommand'), 'module-path': modulePath, 'module-base': moduleBase, 'module-pair': pair, location: classify(command.assemblyLocation, input.utilityDll, input.utilityDll, 'pshome', 'pshome'), 'assembly-name': match(command.assemblyName, 'Microsoft.PowerShell.Commands.Utility'), identity: match(command.assemblyIdentity, installedIdentity.fullName) }
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
  assert.ok(program.includes('$command.Module.ModuleBase, $moduleDirectory'))
  assert.ok(program.includes('$command.Module.Path, $utilityDll'))
  assert.ok(program.includes('$command.Module.ModuleBase, $expectedHome'))
  assert.ok(program.includes('$assembly.Location, $utilityDll'))
  assert.ok(program.includes('$assembly.FullName -cne $installedIdentity.FullName'))
  assert.ok(program.includes('$command.ImplementingType.FullName -cne $expectedTypes[$command.Name]'))
  assert.ok(program.includes("[Reflection.AssemblyName]::GetAssemblyName($utilityDll)"))
  assert.ok(program.includes('[IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint'))
  assert.ok(program.includes('$trustedSearch = $searchEntries.Length -gt 0'))
  assert.ok(program.includes('public sealed class ViviUtilityDiagnostic {}'))
  // This exact reviewed guard body is unchanged by observational categories.
  const guards = program.match(/  foreach \(\$command in @\(\$addType, \$fromJson\)\) \{[\s\S]*?\n  \}\n  Phase 'source-verified'/)?.[0]
  assert.equal(createHash('sha256').update(guards).digest('hex'), '6853dfbe0e99a36b20f32d885e6f45899d5e0fdd0f76e0cf4e124e8e28a2187d')
  assert.ok(program.indexOf("Phase ($prefix + '-identity-'") < program.indexOf('if ($installedIdentity.Name'))
  assert.ok(program.includes("$normalized.StartsWith($root + '\\', [StringComparison]::OrdinalIgnoreCase)"))
  const fixtureExe = inputs({ SystemRoot: 'C:\\Windows' }, 'system-only', 'C:\\owned-temp').powershell
  // Conservatively count quotes/separators and terminating NUL for every fixed
  // argument against Windows' total UTF16 command-line bound.
  assert.ok([fixtureExe, ...powershellArgs].reduce((total, argument) => total + argument.length + 3, 1) <= 32_767)
  assert.ok([...phases].every(name => `VIVI_UTILITY_PHASE:${name}\r\n`.length <= 96))
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), program)
})
test('source predicate couples only exact built-in manifest/binary representations to the installed implementing assembly', () => {
  const input = inputs({ SystemRoot: 'C:\\Windows' }, 'system-only', 'C:\\owned-temp')
  const installedIdentity = { name: 'Microsoft.PowerShell.Commands.Utility', fullName: 'controlled-test-full-assembly-identity' }
  for (const name of ['Add-Type', 'ConvertFrom-Json']) {
    for (const kind of ['manifest', 'binary']) {
      const command = { name, commandType: 'Cmdlet', moduleName: 'Microsoft.PowerShell.Utility', module: { path: kind === 'manifest' ? input.manifest : input.utilityDll, base: kind === 'manifest' ? path.win32.dirname(input.manifest) : input.home }, typeName: name === 'Add-Type' ? 'Microsoft.PowerShell.Commands.AddTypeCommand' : 'Microsoft.PowerShell.Commands.ConvertFromJsonCommand', assemblyLocation: input.utilityDll, assemblyIdentity: installedIdentity.fullName }
      assert.equal(modeledSourceKind(command, input, installedIdentity), kind)
      assert.equal(modeledSourceKind({ ...command, module: { path: command.module.path.toUpperCase(), base: command.module.base.toUpperCase() }, assemblyLocation: input.utilityDll.toUpperCase() }, input, installedIdentity), kind)
      for (const change of [
        { commandType: 'Function' }, { name: 'Other-Cmdlet' }, { moduleName: 'Other.Module' }, { module: null },
        { typeName: 'Other.ImplementingType' }, { assemblyIdentity: 'different-identity' },
        { assemblyLocation: 'C:\\user\\Microsoft.PowerShell.Commands.Utility.dll' },
        { assemblyLocation: 'C:\\Windows\\Microsoft.NET\\assembly\\Microsoft.PowerShell.Commands.Utility.dll' },
        { module: { path: 'C:\\user\\Microsoft.PowerShell.Utility.psd1', base: command.module.base } },
        { module: { path: command.module.path, base: 'C:\\user' } },
        { module: { path: input.manifest, base: input.home } },
        { module: { path: input.utilityDll, base: path.win32.dirname(input.manifest) } },
      ]) assert.equal(modeledSourceKind({ ...command, ...change }, input, installedIdentity), undefined)
      assert.equal(modeledSourceKind(command, input, { ...installedIdentity, name: 'Other.Assembly' }), undefined)
    }
  }
})
test('metadata categories distinguish OS GAC and identity without granting trust or emitting raw values', () => {
  const input = inputs({ SystemRoot: 'C:\\Windows' }, 'system-only', 'C:\\owned-temp')
  const installed = { name: 'Microsoft.PowerShell.Commands.Utility', fullName: 'private-fixed-identity' }
  const command = { name: 'Add-Type', moduleName: 'Microsoft.PowerShell.Utility', commandType: 'Cmdlet', typeName: 'Microsoft.PowerShell.Commands.AddTypeCommand', module: { path: input.utilityDll, base: input.home }, assemblyLocation: input.utilityDll, assemblyName: 'Microsoft.PowerShell.Commands.Utility', assemblyIdentity: installed.fullName }
  assert.equal(modeledMetadata(command, input, installed, command.name).location, 'pshome')
  const gac = 'C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL\\Microsoft.PowerShell.Commands.Utility\\fixed\\Microsoft.PowerShell.Commands.Utility.dll'
  const observed = modeledMetadata({ ...command, assemblyLocation: gac }, input, installed, command.name)
  assert.equal(observed.location, 'gac'); assert.equal(observed.identity, 'match')
  assert.equal(modeledSourceKind({ ...command, assemblyLocation: gac }, input, installed), undefined)
  assert.equal(modeledMetadata({ ...command, assemblyLocation: gac, assemblyIdentity: 'different-private-identity' }, input, installed, command.name).identity, 'mismatch')
  for (const location of ['', undefined, 'x'.repeat(4097)]) assert.equal(modeledMetadata({ ...command, assemblyLocation: location }, input, installed, command.name).location, 'unavailable')
  for (const location of ['C:\\user\\Microsoft.PowerShell.Commands.Utility.dll', 'C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL-evil\\a.dll', 'C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL\\..\\other\\a.dll', 'C:\\Windows-other\\Microsoft.NET\\assembly\\GAC_MSIL\\a.dll', '\\\\server\\Microsoft.NET\\assembly\\GAC_MSIL\\a.dll', 'relative\\a.dll']) assert.equal(modeledMetadata({ ...command, assemblyLocation: location }, input, installed, command.name).location, 'other')
  for (const location of [gac.toUpperCase(), gac.replaceAll('\\', '/'), 'C:\\Windows\\assembly\\GAC_64\\a.dll', 'C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL\\fixed\\..\\a.dll']) assert.equal(modeledGacLocation(location, input.env.SystemRoot), true)
  const mixed = modeledMetadata({ ...command, module: { path: input.utilityDll, base: path.win32.dirname(input.manifest) } }, input, installed, command.name)
  assert.equal(mixed['module-path'], 'binary'); assert.equal(mixed['module-base'], 'manifest'); assert.equal(mixed['module-pair'], 'mixed-trusted')
  for (const prefix of metadataPrefixes) {
    for (const [key, category] of Object.entries(observed)) assert.ok(phases.has(`${prefix}-${key}-${category}`))
  }
  assert.ok(!JSON.stringify(observed).includes('private') && !JSON.stringify(observed).includes('C:'))
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
      await verifySystemFile(input.modules, true); await verifySystemFile(input.manifest); await verifySystemFile(input.utilityDll)
      const started = performance.now(), observed = []
      const consume = reader(name => { observed.push(name); t.diagnostic(`${mode}:${name}:${Math.floor(performance.now() - started)}ms`) })
      const runtime = { spawn(exe, args, options) { const child = spawn(exe, args, options); if (exe === input.powershell) child.stderr.on('data', consume); return child } }
      let result
      try {
        result = await runBoundedWindowsTool(input.powershell, powershellArgs, { env: input.env, cwd: temporary, taskkill: input.taskkill, timeoutMs: 50_000, maxOutputBytes: 16_384, signal: t.signal }, runtime)
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
