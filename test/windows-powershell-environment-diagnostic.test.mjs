// SPDX-License-Identifier: Apache-2.0
// Four owned CI observations only; product deadlines and cache policy stay fixed.
// Environment values and unexpected stdout/stderr are never logged.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { win32 } from 'node:path'
import { launchWindowsCommand } from '../dist/command-windows.js'
import { captureCommandEnvironment, commandEnvironment } from '../dist/commands.js'

const runtimeNames = ['SystemDrive', 'ComSpec', 'PATHEXT']
const profileNames = ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
const variants = ['current', 'runtime', 'profile', 'combined']
const program = String.raw`
function Mark([string]$value) { [Console]::Error.WriteLine('VIVI_WPS_DIAG:' + $value); [Console]::Error.Flush() }
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Mark 'startup'
$expectedModules = [IO.Path]::Combine($env:SystemRoot, 'System32\WindowsPowerShell\v1.0\Modules')
$modulePath = [string][Environment]::GetEnvironmentVariable('PSModulePath')
$parts = $modulePath.Split([char]';', [StringSplitOptions]::RemoveEmptyEntries)
$containsSystem = $false
foreach ($entry in $parts) { if ([String]::Equals($entry, $expectedModules, [StringComparison]::OrdinalIgnoreCase)) { $containsSystem = $true } }
if ([String]::Equals($modulePath, $expectedModules, [StringComparison]::OrdinalIgnoreCase)) { Mark 'modules-unchanged-system' }
elseif ($containsSystem) { Mark 'modules-expanded-with-system' } else { Mark 'modules-no-system' }
if ($parts.Length -eq 0) { Mark 'modules-count-zero' } elseif ($parts.Length -eq 1) { Mark 'modules-count-one' } else { Mark 'modules-count-many' }
Mark 'invoke-start'
Write-Output 'ordinary-powershell-diagnostic'
Mark 'invoke-ready'
if ($Error.Count -eq 0) { Mark 'errors-none' } else { Mark 'errors-present' }
for ($index = 0; $index -lt [Math]::Min(4, $Error.Count); $index++) {
  $record = $Error[$index]
  $identifier = ([string]$record.FullyQualifiedErrorId).Split([char]',')[0]
  switch ($identifier) {
    'CommandNotFoundException' { Mark 'error-id-command-not-found' }
    'ModuleAutoLoadingFailed' { Mark 'error-id-module-autoload' }
    'Modules_ModuleNotFound' { Mark 'error-id-module-not-found' }
    'InvokeMethodOnNull' { Mark 'error-id-null-method' }
    default { Mark 'error-id-other' }
  }
  switch ($record.Exception.GetType().Name) {
    'ArgumentNullException' { Mark 'error-type-argument-null' }
    'DirectoryNotFoundException' { Mark 'error-type-directory-missing' }
    'FileNotFoundException' { Mark 'error-type-file-missing' }
    'IOException' { Mark 'error-type-io' }
    'UnauthorizedAccessException' { Mark 'error-type-access' }
    'CommandNotFoundException' { Mark 'error-type-command-missing' }
    default { Mark 'error-type-other' }
  }
}
Mark 'script-end'
`
const markers = new Set(['startup', 'modules-unchanged-system', 'modules-expanded-with-system', 'modules-no-system', 'modules-count-zero', 'modules-count-one', 'modules-count-many', 'invoke-start', 'invoke-ready', 'errors-none', 'errors-present', 'error-id-command-not-found', 'error-id-module-autoload', 'error-id-module-not-found', 'error-id-null-method', 'error-id-other', 'error-type-argument-null', 'error-type-directory-missing', 'error-type-file-missing', 'error-type-io', 'error-type-access', 'error-type-command-missing', 'error-type-other', 'script-end'])
const encoded = Buffer.from(program, 'utf16le').toString('base64')
function environments(host) {
  const base = commandEnvironment(captureCommandEnvironment(host)), extras = {}
  for (const name of [...runtimeNames, ...profileNames]) {
    const keys = Object.keys(host).filter(key => key.toUpperCase() === name.toUpperCase())
    assert.ok(keys.length <= 1, 'Ambiguous diagnostic host name')
    if (!keys.length) continue
    const value = host[keys[0]]
    if (value === undefined) continue
    assert.ok(typeof value === 'string' && value.length <= 32_768 && !value.includes('\0'), 'Invalid diagnostic host value')
    extras[name] = value
  }
  return variants.map(name => ({ name, env: Object.freeze({ ...base, ...Object.fromEntries((name === 'runtime' ? runtimeNames : name === 'profile' ? profileNames : name === 'combined' ? [...runtimeNames, ...profileNames] : []).filter(key => extras[key] !== undefined).map(key => [key, extras[key]])) }) }))
}
function markerReader(report, unexpected) {
  const seen = new Set()
  let line = '', discard = false
  return chunk => {
    for (const byte of chunk) {
      if (byte === 10) {
        const value = line.replace(/\r$/, '').replace(/^VIVI_WPS_DIAG:/, '')
        if (!discard && line.startsWith('VIVI_WPS_DIAG:') && markers.has(value)) {
          if (!seen.has(value)) { seen.add(value); report(value) }
        } else unexpected(!discard && line.startsWith('#< CLIXML') ? 'clixml' : 'other')
        line = ''; discard = false
      } else if (!discard) {
        if (line.length >= 128) { line = ''; discard = true }
        else line += String.fromCharCode(byte)
      }
    }
  }
}

test('diagnostic variants read only six explicit frozen additions and preserve the current policy', () => {
  const host = { SystemRoot: 'C:\\Windows', SystemDrive: 'C:', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.EXE;.CMD', USERPROFILE: 'C:\\Users\\fixture', APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' }
  Object.defineProperty(host, 'OPENAI_API_KEY', { enumerable: true, get() { throw new Error('Provider value must not be read') } })
  Object.defineProperty(host, 'PSModulePath', { enumerable: true, get() { throw new Error('Inherited module paths must not be read') } })
  const snapshots = environments(host)
  host.LOCALAPPDATA = 'changed'
  assert.deepEqual(snapshots.map(item => item.name), variants)
  for (const item of snapshots) { assert(Object.isFrozen(item.env)); assert.equal(item.env.OPENAI_API_KEY, undefined) }
  assert.equal(snapshots[0].env.LOCALAPPDATA, undefined)
  assert.equal(snapshots[1].env.USERPROFILE, undefined)
  assert.equal(snapshots[2].env.ComSpec, undefined)
  assert.equal(snapshots[3].env.LOCALAPPDATA, 'C:\\Users\\fixture\\AppData\\Local')
  assert.throws(() => environments({ SystemRoot: 'C:\\Windows', APPDATA: 'bad\0path' }), /Invalid diagnostic/)
  assert.ok(!/Import-Module|SetEnvironmentVariable|PSModuleAnalysisCachePath|PSDisableModuleAnalysisCacheCleanup|Set-ExecutionPolicy|\.Run\(/.test(program))
  assert.ok(!/\$(?:HOME|Host|PID|PSHOME|Error)\b\s*=(?!=)/i.test(program))
  assert.ok(!/^\s*\/\//m.test(program))
  assert.ok(program.includes("Write-Output 'ordinary-powershell-diagnostic'"))
  assert.ok(program.includes("'System32\\WindowsPowerShell\\v1.0\\Modules'"))
  assert.ok(encoded.length + 256 < 32_767)
})
test('diagnostic parser emits only bounded fixed markers and classifications', () => {
  const observed = [], classes = [], consume = markerReader(value => observed.push(value), value => classes.push(value))
  for (const byte of Buffer.from('VIVI_WPS_DIAG:startup\r\nVIVI_WPS_DIAG:invoke-start\n')) consume([byte])
  consume(Buffer.from('VIVI_WPS_DIAG:startup\n#< CLIXML\nprivate-path-and-value\n' + 'x'.repeat(1024) + '\nVIVI_WPS_DIAG:script-end\n'))
  assert.deepEqual(observed, ['startup', 'invoke-start', 'script-end'])
  assert.deepEqual(classes, ['clixml', 'other', 'other'])
})
test('Windows current/runtime/profile/combined environment observations remain separate from product gates', { skip: process.platform !== 'win32', timeout: 260_000 }, async t => {
  const snapshots = environments(process.env)
  for (const { name, env } of snapshots) {
    t.signal.throwIfAborted()
    for (const key of [...runtimeNames, ...profileNames]) t.diagnostic(`${name}:${key}-${env[key] === undefined ? 'absent' : 'present'}`)
    const started = performance.now(), seen = [], first = new Set(), unexpected = new Set()
    const stamp = label => t.diagnostic(`${name}:${label}:${Math.floor(performance.now() - started)}ms`)
    const command = await launchWindowsCommand({ executable: win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], cwd: process.cwd(), env }, { onPhase: phase => { if (['process-resumed', 'root-exit', 'helper-close'].includes(phase)) stamp(phase) } })
    let stopping, deadlineReached = false, outputOverflow = false, stdoutBytes = 0, stderrBytes = 0
    const stop = () => stopping ??= command.stop()
    const consume = markerReader(value => { seen.push(value); stamp(value) }, kind => { if (!unexpected.has(kind)) { unexpected.add(kind); stamp(`stderr-${kind}`) } })
    command.stdout.on('data', chunk => { if (!first.has('stdout')) { first.add('stdout'); stamp('first-stdout') }; stdoutBytes = Math.min(16_385, stdoutBytes + chunk.length); if (stdoutBytes + stderrBytes > 16_384) { outputOverflow = true; void stop().catch(() => {}) } })
    command.stderr.on('data', chunk => { if (!first.has('stderr')) { first.add('stderr'); stamp('first-stderr') }; stderrBytes = Math.min(16_385, stderrBytes + chunk.length); if (stdoutBytes + stderrBytes > 16_384) { outputOverflow = true; void stop().catch(() => {}) }; consume(chunk) })
    const abort = () => { void stop().catch(() => {}) }
    t.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { deadlineReached = true; void stop().catch(() => {}) }, 50_000)
    if (t.signal.aborted) abort()
    try {
      const result = await command.completed
      assert.ok(result.error === undefined, 'Diagnostic helper/tree cleanup failed')
      stamp(deadlineReached ? 'observation-timeout' : outputOverflow ? 'observation-output-limit' : result.exitCode === 0 ? 'observation-exited-zero' : 'observation-exited-nonzero')
      t.diagnostic(`${name}:stdout-bytes:${stdoutBytes}:stderr-bytes:${stderrBytes}`)
      if (!deadlineReached && !outputOverflow) assert.ok(seen.includes('startup'), 'Diagnostic target did not reach startup')
    } finally { clearTimeout(timer); t.signal.removeEventListener('abort', abort); await stop() }
    t.signal.throwIfAborted()
  }
})
