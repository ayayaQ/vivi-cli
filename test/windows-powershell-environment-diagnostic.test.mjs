// SPDX-License-Identifier: Apache-2.0
// Two owned CI observations only; product deadlines and cache policy stay fixed.
// Environment values and unexpected stdout/stderr are never logged.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { lstat, realpath } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { win32 } from 'node:path'
import { launchWindowsCommand } from '../dist/command-windows.js'
import { captureCommandEnvironment, commandEnvironment } from '../dist/commands.js'
import { HelperBuildError, runBoundedWindowsTool } from '../scripts/build-windows-command-helper.mjs'

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

const outputLimit = 16_384
// This closed recognizer observes only bounded literal CLIXML signatures. It
// never deserializes XML/entities, trusts output, or forwards payload strings.
function clixmlLabels(bytes) {
  if (bytes.length > outputLimit) return ['clixml-observation-truncated']
  const text = bytes.toString('latin1')
  if (!text.includes('#< CLIXML')) return []
  const labels = new Set(['clixml-envelope']), streams = new Set()
  let fragments = 0
  for (const match of text.matchAll(/<Objs\b[^<>]{0,256}>[\s\S]*?<\/Objs>/g)) {
    if (++fragments > 16) { labels.add('clixml-observation-truncated'); break }
    const fragment = match[0]
    for (const tag of fragment.matchAll(/<(?:Obj|S)\b[^<>]{0,256}\sS="([^"<>]{1,32})"[^<>]{0,256}>/g)) {
      const stream = tag[1].toLowerCase()
      streams.add(['progress', 'error', 'warning', 'verbose', 'debug', 'information', 'output'].includes(stream) ? stream : 'other')
    }
    if (fragment.includes('<AV>Preparing modules for first use.</AV>')) labels.add('clixml-module-first-use-activity')
    if (fragment.includes('<T>Completed</T>')) labels.add('clixml-completed-record')
  }
  for (const stream of streams) labels.add(`clixml-stream-${stream}`)
  if (!fragments || !streams.size) labels.add('clixml-unrecognized')
  return [...labels]
}
function fixtureInput(host, cwd) {
  const env = commandEnvironment(captureCommandEnvironment(host))
  return Object.freeze({ executable: win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: Object.freeze(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]), cwd, env })
}
async function directCommand(input, signal, observe, phase, runtime = {}) {
  const spawn = runtime.spawn ?? nodeSpawn
  const safe = callback => (...args) => { try { Promise.resolve(callback(...args)).catch(() => {}) } catch { /* observation cannot interrupt supervision */ } }
  let targetSeen = false
  return runBoundedWindowsTool(input.executable, input.args, { cwd: input.cwd, env: input.env, signal, taskkill: win32.join(input.env.SystemRoot, 'System32', 'taskkill.exe'), timeoutMs: 50_000, maxOutputBytes: outputLimit }, {
    ...runtime,
    spawn(executable, args, options) {
      const child = spawn(executable, args, options)
      if (!targetSeen) {
        targetSeen = true
        // Always return the spawned child, even if observation setup fails.
        try {
          child.stdout.on('data', safe(chunk => observe('stdout', chunk)))
          child.stderr.on('data', safe(chunk => observe('stderr', chunk)))
          child.once('spawn', safe(() => phase('process-spawned')))
          child.once('exit', safe(() => phase('root-exit')))
          child.once('close', safe(() => phase('direct-close')))
        } catch { /* missing observations fail the fixed completion checks */ }
      }
      return child
    },
  })
}
function observation(stamp) {
  const seen = new Set(), first = new Set(), unexpected = new Set()
  const bytes = { stdout: 0, stderr: 0 }, chunks = { stdout: [], stderr: [] }
  const consume = markerReader(value => { seen.add(value); stamp(value) }, kind => { if (!unexpected.has(kind)) { unexpected.add(kind); stamp(`stderr-${kind}`) } })
  return {
    seen, bytes,
    read(kind, chunk) {
      if (!first.has(kind)) { first.add(kind); stamp(`first-${kind}`) }
      const remaining = Math.max(0, outputLimit - bytes[kind])
      if (remaining) chunks[kind].push(Buffer.from(chunk.subarray(0, remaining)))
      bytes[kind] = Math.min(outputLimit + 1, bytes[kind] + chunk.length)
      if (kind === 'stderr' && remaining) consume(chunk.subarray(0, remaining))
      return bytes.stdout + bytes.stderr > outputLimit
    },
    finish(censored) {
      for (const label of clixmlLabels(Buffer.concat(chunks.stderr))) stamp(label)
      if (!censored) {
        assert.ok(seen.has('startup') && seen.has('invoke-ready') && seen.has('script-end'), 'Diagnostic target did not finish its fixed phases')
        assert.ok(Buffer.concat(chunks.stdout).equals(Buffer.from('ordinary-powershell-diagnostic\r\n')), 'Diagnostic target output differs from the fixed constant')
      }
    },
  }
}

test('direct and Vivi fixtures share the exact frozen current generated environment and PowerShell source', () => {
  const host = { SystemRoot: 'C:\\Windows', TEMP: 'C:\\Temp' }
  for (const name of ['OPENAI_API_KEY', 'PSModulePath', 'LOCALAPPDATA']) Object.defineProperty(host, name, { enumerable: true, get() { throw new Error('Excluded value must not be read') } })
  const input = fixtureInput(host, 'C:\\fixture')
  host.TEMP = 'changed'
  assert.ok(Object.isFrozen(input) && Object.isFrozen(input.args) && Object.isFrozen(input.env))
  assert.equal(input.env.TEMP, 'C:\\Temp')
  assert.equal(input.env.LOCALAPPDATA, undefined)
  assert.ok(!/Import-Module|SetEnvironmentVariable|PSModuleAnalysisCachePath|PSDisableModuleAnalysisCacheCleanup|Set-ExecutionPolicy|\.Run\(/.test(program))
  assert.ok(!/\$(?:HOME|Host|PID|PSHOME|Error)\b\s*=(?!=)/i.test(program))
  assert.ok(!/^\s*\/\//m.test(program))
  assert.ok(program.includes("Write-Output 'ordinary-powershell-diagnostic'"))
  assert.ok(program.includes("'System32\\WindowsPowerShell\\v1.0\\Modules'"))
  assert.ok(encoded.length + 256 < 32_767)
})
test('diagnostic recognizes bounded progress/error categories without decoding private CLIXML content', () => {
  const progress = '#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress" RefId="0"><MS><PR N="Record"><AV>Preparing modules for first use.</AV><T>Completed</T></PR></MS></Obj></Objs>'
  assert.deepEqual(clixmlLabels(Buffer.from(progress)), ['clixml-envelope', 'clixml-module-first-use-activity', 'clixml-completed-record', 'clixml-stream-progress'])
  const error = progress.replace('</Objs>', '<S S="Error">private-path-and-value</S><S S="secret-stream">private-value</S></Objs>')
  const labels = clixmlLabels(Buffer.from(error))
  assert.ok(labels.includes('clixml-stream-error') && labels.includes('clixml-stream-other'))
  assert.ok(labels.every(value => !/private|secret-stream/.test(value)))
  assert.deepEqual(clixmlLabels(Buffer.from('#< CLIXML\n<Objs>')), ['clixml-envelope', 'clixml-unrecognized'])
  assert.deepEqual(clixmlLabels(Buffer.alloc(outputLimit + 1)), ['clixml-observation-truncated'])
  const observed = [], classes = [], consume = markerReader(value => observed.push(value), value => classes.push(value))
  for (const byte of Buffer.from('VIVI_WPS_DIAG:startup\r\nVIVI_WPS_DIAG:invoke-start\n')) consume([byte])
  consume(Buffer.from('VIVI_WPS_DIAG:startup\n#< CLIXML\nprivate-path-and-value\n' + 'x'.repeat(1024) + '\nVIVI_WPS_DIAG:script-end\n'))
  assert.deepEqual(observed, ['startup', 'invoke-start', 'script-end'])
  assert.deepEqual(classes, ['clixml', 'other', 'other'])
})
function directFixture() {
  const child = Object.assign(new EventEmitter(), { pid: 111, stdout: new PassThrough(), stderr: new PassThrough(), unref() {} })
  const killer = Object.assign(new EventEmitter(), { pid: 222, kill() { return true } })
  const calls = [], input = fixtureInput({ SystemRoot: 'C:\\Windows' }, 'C:\\fixture')
  const runtime = { cleanupTimeoutMs: 10, spawn(executable, args, options) { calls.push({ executable, args, options }); return calls.length === 1 ? child : killer } }
  return { child, killer, calls, input, runtime }
}
test('direct observer forwards exact target inputs and cannot interrupt the bounded runner', async () => {
  const f = directFixture(), observed = []
  const running = directCommand(f.input, undefined, () => Promise.reject(new Error('observer failure')), value => { observed.push(value); if (value === 'root-exit') throw new Error('observer failure') }, f.runtime)
  f.child.emit('spawn'); f.child.stdout.write('constant'); f.child.stdout.end(); f.child.stderr.end()
  f.child.emit('exit', 0); f.child.emit('close', 0)
  const result = await running
  assert.ok(result.stdout.equals(Buffer.from('constant')))
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].executable, f.input.executable)
  assert.deepEqual(f.calls[0].args, f.input.args)
  assert.deepEqual(f.calls[0].options.env, { ...f.input.env })
  assert.equal(f.calls[0].options.shell, false)
  assert.deepEqual(f.calls[0].options.stdio, ['ignore', 'pipe', 'pipe'])
  assert.equal(f.calls[0].options.cwd, f.input.cwd)
  assert.deepEqual(observed, ['process-spawned', 'root-exit', 'direct-close'])
})
test('direct cancellation awaits live-parent cleanup and never targets a PID after root exit', async () => {
  const f = directFixture(), controller = new AbortController(), phases = []
  const running = directCommand(f.input, controller.signal, () => {}, value => phases.push(value), f.runtime)
  controller.abort()
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[1].args, ['/PID', '111', '/T', '/F'])
  let settled = false; void running.catch(() => { settled = true })
  f.killer.emit('spawn'); f.killer.emit('close', 0); assert.deepEqual(phases, []); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false)
  f.child.emit('exit', 1); f.child.emit('close', 1)
  await assert.rejects(running, error => error instanceof HelperBuildError && error.cleanupVerified)
  const exited = directFixture(), afterExit = new AbortController()
  const dangling = directCommand(exited.input, afterExit.signal, () => {}, () => {}, exited.runtime)
  exited.child.emit('exit', 0); afterExit.abort()
  await assert.rejects(dangling, error => error instanceof HelperBuildError && error.cleanupVerified === false)
  assert.equal(exited.calls.length, 1)
  const early = directFixture(), already = new AbortController(); already.abort()
  await assert.rejects(directCommand(early.input, already.signal, () => {}, () => {}, early.runtime), error => error instanceof HelperBuildError && error.cleanupVerified)
  assert.equal(early.calls.length, 0)
})
test('Windows direct-current then Vivi-current observations remain separate from product gates', { skip: process.platform !== 'win32', timeout: 140_000 }, async t => {
  const input = fixtureInput(process.env, process.cwd())
  for (const file of [input.executable, win32.join(input.env.SystemRoot, 'System32', 'taskkill.exe')]) {
    const info = await lstat(file)
    assert.ok(info.isFile() && !info.isSymbolicLink(), 'Diagnostic OS tool must be a regular file')
    assert.ok((await realpath(file)).toLowerCase() === file.toLowerCase(), 'Diagnostic OS tool location changed')
  }
  t.diagnostic('order:direct-first-potentially-cold:Vivi-second-potentially-warm')
  for (const name of ['direct-current', 'Vivi-current']) {
    t.signal.throwIfAborted()
    const started = performance.now()
    const stamp = label => t.diagnostic(`${name}:${label}:${Math.floor(performance.now() - started)}ms`)
    const observed = observation(stamp)
    let censored = false
    if (name === 'direct-current') {
      try {
        await directCommand(input, t.signal, (kind, chunk) => observed.read(kind, chunk), stamp)
        stamp('observation-exited-zero')
      } catch (error) {
        assert.ok(error instanceof HelperBuildError && error.cleanupVerified, 'Direct diagnostic/tree cleanup failed')
        const category = new Map([['Tool exceeded its bounded timeout', 'observation-timeout'], ['Tool output exceeded its bounded limit', 'observation-output-limit'], ['Build proof cancelled', 'observation-cancelled']]).get(error.message)
        assert.ok(category, 'Direct diagnostic returned an unexpected failure')
        censored = true; stamp(category)
      }
    } else {
      const command = await launchWindowsCommand(input, { onPhase: phase => { if (['process-resumed', 'root-exit', 'helper-close'].includes(phase)) stamp(phase) } })
      let stopping, deadlineReached = false, outputOverflow = false
      const stop = () => stopping ??= command.stop()
      for (const kind of ['stdout', 'stderr']) command[kind].on('data', chunk => { if (observed.read(kind, chunk)) { outputOverflow = true; void stop().catch(() => {}) } })
      const abort = () => { void stop().catch(() => {}) }
      t.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => { deadlineReached = true; void stop().catch(() => {}) }, 50_000)
      if (t.signal.aborted) abort()
      try {
        const result = await command.completed
        assert.ok(result.error === undefined, 'Diagnostic helper/tree cleanup failed')
        censored = deadlineReached || outputOverflow
        stamp(deadlineReached ? 'observation-timeout' : outputOverflow ? 'observation-output-limit' : result.exitCode === 0 ? 'observation-exited-zero' : 'observation-exited-nonzero')
      } finally { clearTimeout(timer); t.signal.removeEventListener('abort', abort); await stop() }
    }
    observed.finish(censored)
    t.diagnostic(`${name}:stdout-bytes:${observed.bytes.stdout}:stderr-bytes:${observed.bytes.stderr}`)
    t.signal.throwIfAborted()
  }
})
