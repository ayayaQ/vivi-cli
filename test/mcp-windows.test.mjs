// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import { test } from 'node:test'
import { launchWindowsMcp } from '../dist/mcp-windows.js'

const input = Object.freeze({
  executable: 'C:\\Program Files\\Example\\tool.exe',
  args: Object.freeze(['', 'white space', '"quote"', 'trailing\\', '&|<>^%PATH%', '$(throw 1)', '中文🙂']),
  cwd: 'C:\\work space',
  env: Object.freeze({ SystemRoot: 'C:\\Windows', CUSTOM: 'value' }),
})
function fixture(extra = {}) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const writes = []
  child.stdin.on('data', data => writes.push(data))
  let spawnCall
  let killed = 0
  child.kill = () => { killed++; child.emit('close', null, 'SIGKILL'); return true }
  const runtime = { hostEnv: { SystemRoot: 'C:\\Windows', TEMP: 'C:\\temp', OPENAI_API_KEY: 'provider-key', ANTHROPIC_API_KEY: 'another-key', NODE_OPTIONS: '--require bad', PATH: 'host-path' }, spawn(executable, args, options) { spawnCall = { executable, args, options }; return child }, ...extra }
  return { child, runtime, writes, call: () => spawnCall, killed: () => killed }
}
const frame = value => JSON.stringify(value) + '\r\n'
const dataFrame = (type, bytes) => frame({ type, data: Buffer.from(bytes).toString('base64') })
function collect(stream) { const chunks = []; stream.on('data', chunk => chunks.push(chunk)); return () => Buffer.concat(chunks) }

test('Windows wrapper source is fixed, short enough, and request argv only travels as JSON data', async () => {
  const fake = fixture()
  const command = await launchWindowsMcp(input, fake.runtime)
  const call = fake.call()
  assert.equal(call.executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.equal(call.options.shell, false)
  assert.equal(call.options.windowsHide, true)
  assert.deepEqual(call.options.env, { SystemRoot: 'C:\\Windows', TEMP: 'C:\\temp', PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules' })
  assert.equal(call.args.at(-2), '-EncodedCommand')
  assert.ok(call.args.at(-1).length + call.executable.length + 200 < 32767)
  const script = Buffer.from(call.args.at(-1), 'base64').toString('utf16le')
  assert.ok(!script.includes(input.args[5]))
  assert.ok(!script.includes('provider-key'))
  assert.match(script, /LanguageMode -ne 'FullLanguage'/)
  assert.match(script, /\[String\]::Equals\(\$PSHOME, \$expectedHome, \[StringComparison\]::OrdinalIgnoreCase\)/)
  assert.match(script, /Microsoft\.PowerShell\.Utility\\Microsoft\.PowerShell\.Utility\.psd1/)
  assert.match(script, /\[Environment\]::SetEnvironmentVariable\('PSModulePath', \$moduleDirectory\)/)
  assert.ok(script.indexOf('Import-Module -Name $manifest') < script.indexOf('Microsoft.PowerShell.Utility\\Add-Type'))
  assert.match(script, /Microsoft\.PowerShell\.Utility\\ConvertFrom-Json/)
  assert.match(script, /Microsoft\.PowerShell\.Utility\\New-Object/)
  assert.ok(!script.includes('Microsoft.PowerShell.Commands.Utility.dll'))
  assert.ok(!script.includes('Get-AuthenticodeSignature'))
  const compressed = script.match(/\$compressed = '([^']+)'/)[1]
  const native = gunzipSync(Buffer.from(compressed, 'base64')).toString('utf8')
  assert.match(native, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/)
  assert.match(native, /JOB_LIST = new IntPtr\(0x0002000D\)/)
  assert.match(native, /HANDLE_LIST = new IntPtr\(0x00020002\)/)
  assert.ok(native.indexOf('"Atomic job assignment') < native.indexOf('Check(CreateProcessW('))
  assert.ok(native.indexOf('Check(CreateProcessW(') < native.indexOf('if (ResumeThread('))
  assert.match(native, /WaitForEmptyJob\(job\)/)
  assert.deepEqual(JSON.parse(Buffer.concat(fake.writes).toString('utf8')), input)
  fake.child.stdout.write(frame({ type: 'exit', exitCode: 0, stopped: false }))
  assert.equal(fake.child.stdin.writableEnded, true, 'final metadata must close the helper control reader')
  fake.child.emit('close', 0, null)
  assert.deepEqual(await command.completed, { exitCode: 0 })
})

test('binary stdout/stderr frames survive every protocol byte boundary, and done waits for helper close', async () => {
  const bytes = Buffer.from([0, 255, 13, 10, 42, 128])
  const protocol = dataFrame('stdout', bytes) + dataFrame('stderr', 'diagnostic') + frame({ type: 'exit', exitCode: 7, stopped: false })
  for (let split = 0; split <= protocol.length; split++) {
    const fake = fixture()
    const command = await launchWindowsMcp(input, fake.runtime)
    const out = collect(command.stdout), err = collect(command.stderr)
    let settled = false
    command.completed.then(() => { settled = true })
    fake.child.stdout.write(protocol.slice(0, split))
    fake.child.stdout.write(protocol.slice(split))
    await Promise.resolve()
    assert.equal(settled, false)
    fake.child.emit('close', 0, null)
    assert.deepEqual(await command.completed, { exitCode: 7 })
    assert.deepEqual(out(), bytes)
    assert.equal(err().toString(), 'diagnostic')
  }
})

test('stopping is idempotent, closes the control pipe, and awaits verified cleanup', async () => {
  const fake = fixture()
  const command = await launchWindowsMcp(input, fake.runtime)
  const first = command.stop(), second = command.stop()
  assert.equal(fake.child.stdin.writableEnded, true)
  fake.child.stdout.write(frame({ type: 'exit', exitCode: 1, stopped: true }))
  fake.child.emit('close', 0, null)
  await Promise.all([first, second])
  assert.deepEqual(await command.completed, { exitCode: 1, signal: 'SIGTERM' })
  assert.equal(fake.killed(), 0)
})

test('spawn failure and helper crash do not become successful completion', async () => {
  for (const failure of ['spawn', 'crash']) {
    const fake = fixture()
    const command = await launchWindowsMcp(input, fake.runtime)
    if (failure === 'spawn') fake.child.emit('error', new Error('ENOENT powershell.exe'))
    fake.child.emit('close', null, null)
    const result = await command.completed
    assert.equal(result.exitCode, null)
    assert.match(result.error, failure === 'spawn' ? /ENOENT/ : /without verified tree cleanup/)
  }
})

test('malformed, oversized, or incomplete protocol is bounded and fails closed', async () => {
  for (const malformed of ['not-json\n', frame({ type: 'stdout', data: 'not base64!' }), 'a'.repeat(24001), '{"type":']) {
    const fake = fixture()
    const command = await launchWindowsMcp(input, fake.runtime)
    fake.child.stdout.write(malformed)
    fake.child.emit('close', null, null)
    const result = await command.completed
    assert.equal(result.exitCode, null)
    assert.ok(result.error)
  }
})

test('native launch errors travel separately from approved stderr', async () => {
  const fake = fixture()
  const command = await launchWindowsMcp(input, fake.runtime)
  const err = collect(command.stderr)
  fake.child.stdout.write(dataFrame('error', 'CreateProcessW failed'))
  fake.child.emit('close', 0, null)
  assert.deepEqual(await command.completed, { exitCode: null, error: 'CreateProcessW failed' })
  assert.equal(err().length, 0)
})

test('invalid native input rejects before helper spawn', async () => {
  for (const change of [{ executable: 'tool.exe' }, { executable: '\\tool.exe' }, { cwd: 'relative' }, { cwd: '\\work' }, { args: ['bad\0arg'] }, { env: { PATH: 'one', Path: 'two' } }, { env: { 'bad=name': 'x' } }]) {
    const fake = fixture()
    await assert.rejects(launchWindowsMcp({ ...input, ...change }, fake.runtime))
    assert.equal(fake.call(), undefined)
  }
})

test('an unresponsive helper is force-closed without claiming cleanup verification', async () => {
  const fake = fixture({ cleanupTimeoutMs: 5 })
  const command = await launchWindowsMcp(input, fake.runtime)
  const stopped = command.stop()
  // The timer intentionally does not keep a real CLI alive by itself.
  await new Promise(resolve => setTimeout(resolve, 15))
  await stopped
  assert.equal(fake.killed(), 1)
  assert.match((await command.completed).error, /without verified tree cleanup/)
})

test('helper startup receives identical fixed source across distinct approved requests', async () => {
  const first = fixture(), second = fixture()
  const one = await launchWindowsMcp(input, first.runtime)
  const two = await launchWindowsMcp({ ...input, args: ['totally different', '"; Remove-Item C:\\*; "'] }, second.runtime)
  assert.deepEqual(first.call().args, second.call().args)
  first.child.emit('close', null, null)
  second.child.emit('close', null, null)
  await Promise.all([one.completed, two.completed])
})

test('the frozen approved environment supplies only minimal helper setup variables', async () => {
  const fake = fixture()
  const approved = { ...input, env: Object.freeze({ SystemRoot: 'C:\\FrozenWindows', TEMP: 'C:\\frozen-temp', TMPDIR: 'C:\\frozen-tmpdir', USERPROFILE: 'private-profile', LOCALAPPDATA: 'private-data', OPENAI_API_KEY: 'secret' }) }
  const command = await launchWindowsMcp(approved, { spawn: fake.runtime.spawn })
  assert.deepEqual(fake.call().options.env, { SystemRoot: 'C:\\FrozenWindows', TEMP: 'C:\\frozen-temp', TMPDIR: 'C:\\frozen-tmpdir', PSModulePath: 'C:\\FrozenWindows\\System32\\WindowsPowerShell\\v1.0\\Modules' })
  assert.ok(fake.call().executable.startsWith('C:\\FrozenWindows\\'))
  fake.child.emit('close', null, null)
  await command.completed
})

test('facade output applies backpressure until callers attach readers', async () => {
  const fake = fixture()
  const command = await launchWindowsMcp(input, fake.runtime)
  const bytes = Buffer.alloc(4096, 97)
  const protocol = dataFrame('stdout', bytes).repeat(12) + frame({ type: 'exit', exitCode: 0, stopped: false })
  fake.child.stdout.write(protocol)
  assert.ok(command.stdout.readableLength <= 32_768)
  assert.equal(fake.child.stdout.isPaused(), true)
  fake.child.emit('close', 0, null)
  let done = false
  command.completed.then(() => { done = true })
  await Promise.resolve()
  assert.equal(done, false)
  const out = collect(command.stdout)
  collect(command.stderr)
  assert.deepEqual(await command.completed, { exitCode: 0 })
  assert.deepEqual(out(), Buffer.alloc(12 * bytes.length, 97))
})
test('Windows custom command-string parsers are rejected before helper spawn', async () => {
  const fake = fixture()
  for (const executable of ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\command.com']) {
    await assert.rejects(launchWindowsMcp({ ...input, executable }, fake.runtime), /custom command-string parsing is unsupported/)
  }
  assert.equal(fake.call(), undefined)
})

test('MCP stdin frames preserve exact protocol bytes without shell interpolation', async () => {
  const fake = fixture()
  const owned = await launchWindowsMcp(input, fake.runtime)
  const message = Buffer.from(JSON.stringify({jsonrpc: '2.0', id: 1, method: 'tools/list', params: {cursor: 'opaque " cursor'}}) + '\n')
  await owned.write(message)
  const lines = Buffer.concat(fake.writes).toString('utf8').trimEnd().split('\n')
  assert.deepEqual(JSON.parse(lines[0]), input)
  assert.deepEqual(Buffer.from(lines[1], 'base64'), message)
  await assert.rejects(owned.write(Buffer.alloc(65537)), /limit/)
  const stop = owned.stop()
  await assert.rejects(owned.write(message), /unavailable/)
  fake.child.stdout.write(frame({ type: 'exit', exitCode: 1, stopped: true }))
  fake.child.emit('close', 0, null)
  await stop
})

test('host cancellation is retained when the native helper completes before its EOF reader sees the stop', async () => {
  const fake=fixture(),owned=await launchWindowsMcp(input,fake.runtime)
  const stopped=owned.stop()
  fake.child.stdout.write(frame({type:'exit',exitCode:0,stopped:false}))
  fake.child.emit('close',0,null)
  await stopped
  assert.deepEqual(await owned.completed,{exitCode:0,signal:'SIGTERM'})
})

test('verified prelaunch cancellation permits null exit code and still waits for helper close', async()=>{
  const fake=fixture(),owned=await launchWindowsMcp(input,fake.runtime)
  const stopped=owned.stop()
  fake.child.stdout.write(frame({type:'exit',exitCode:null,stopped:true}))
  fake.child.emit('close',0,null)
  await stopped;assert.deepEqual(await owned.completed,{exitCode:null,signal:'SIGTERM'})
})
test('frames after terminal metadata fail closed and a wedged final-frame helper has a bounded fallback',async()=>{
  const fake=fixture(),owned=await launchWindowsMcp(input,fake.runtime)
  fake.child.stdout.write(frame({type:'exit',exitCode:0,stopped:false})+dataFrame('stdout','late'))
  fake.child.emit('close',0,null)
  assert.match((await owned.completed).error,/protocol/)
  const wedged=fixture({cleanupTimeoutMs:5}),pending=await launchWindowsMcp(input,wedged.runtime)
  wedged.child.stdout.write(frame({type:'exit',exitCode:0,stopped:false}))
  await new Promise(resolve=>setTimeout(resolve,15))
  assert.equal(wedged.killed(),1);assert.match((await pending.completed).error,/did not close/)
})

test('bootstrap write exceptions and callback failures stop the helper without exposing diagnostics', async () => {
  for (const failure of ['throw', 'callback', 'event']) {
    const fake = fixture()
    fake.child.stdin.write = (...args) => {
      if (failure === 'throw') throw new Error('owned-fixture-private-diagnostic')
      if (failure === 'callback') queueMicrotask(() => args.at(-1)(new Error('owned-fixture-private-diagnostic')))
      else queueMicrotask(() => fake.child.stdin.emit('error', new Error('owned-fixture-private-diagnostic')))
      return true
    }
    const owned = await launchWindowsMcp(input, fake.runtime)
    await Promise.resolve()
    assert.equal(fake.child.stdin.writableEnded, true)
    fake.child.emit('close', 1, null)
    const result = await owned.completed
    assert.deepEqual(result, { exitCode: null, error: 'Windows MCP input failed' })
    assert.ok(!JSON.stringify(result).includes('private-diagnostic'))
  }
})

test('discovery write exceptions and callbacks fail closed and pending writes reject at helper close', async () => {
  for (const failure of ['throw', 'callback', 'close']) {
    const fake = fixture(), owned = await launchWindowsMcp(input, fake.runtime)
    fake.child.stdin.write = (...args) => {
      if (failure === 'throw') throw new Error('owned-fixture-private-diagnostic')
      if (failure === 'callback') queueMicrotask(() => args.at(-1)(new Error('owned-fixture-private-diagnostic')))
      return true
    }
    const written = owned.write(Buffer.from('literal protocol bytes\n'))
    const rejected = assert.rejects(written, error => error.message === 'Windows MCP input failed')
    await Promise.resolve()
    if (failure !== 'close') assert.equal(fake.child.stdin.writableEnded, true)
    fake.child.emit('close', 1, null)
    await rejected
    assert.ok((await owned.completed).error)
  }
})

test('control end exceptions are contained and keep the bounded termination fallback', async () => {
  const fake = fixture({ cleanupTimeoutMs: 5 })
  const owned = await launchWindowsMcp(input, fake.runtime)
  fake.child.stdin.end = () => { throw new Error('owned-fixture-private-diagnostic') }
  const stopped = owned.stop()
  assert.equal(fake.child.stdin.destroyed, true)
  await new Promise(resolve => setTimeout(resolve, 15))
  await stopped
  assert.equal(fake.killed(), 1)
  assert.deepEqual(await owned.completed, { exitCode: null, error: 'Windows MCP control pipe failed' })
})

test('a late control-pipe error preserves already verified terminal metadata', async () => {
  const fake = fixture(), owned = await launchWindowsMcp(input, fake.runtime)
  fake.child.stdout.write(frame({ type: 'exit', exitCode: 0, stopped: false }))
  fake.child.stdin.emit('error', new Error('late EPIPE'))
  fake.child.emit('close', 0, null)
  assert.deepEqual(await owned.completed, { exitCode: 0 })
  await assert.rejects(owned.write(Buffer.from('late')), /unavailable/)
})

test('native input-pump failure terminates the owned job before final cleanup', async () => {
  const fake = fixture(), owned = await launchWindowsMcp(input, fake.runtime)
  const script = Buffer.from(fake.call().args.at(-1), 'base64').toString('utf16le')
  const native = gunzipSync(Buffer.from(script.match(/\$compressed = '([^']+)'/)[1], 'base64')).toString('utf8')
  const pump = native.slice(native.indexOf('static Thread InputPump'), native.indexOf('static void WaitForEmptyJob'))
  assert.match(pump, /catch \(Exception error\)/)
  assert.match(pump, /inputQueue\.CompleteAdding\(\)/)
  assert.match(pump, /TerminateJobObject\(activeJob, 1\)/)
  fake.child.emit('close', null, null)
  await owned.completed
})
