// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { setImmediate as tick } from 'node:timers/promises'
import { bindBackgroundProcessControls, runProcessControl } from '../dist/process-controls.js'
import { TerminalIO } from '../dist/terminal.js'
const id = '11111111-1111-4111-8111-111111111111'
const job = { executionId: id, executable: 'node', args: ['dev.mjs'], cwd: '/project', state: 'running', background: true, cleanupConfirmed: false, totalBytes: 0, truncated: false }
function fixture() {
  const writes = [], calls = []
  let controls, disposed = 0
  const host = { listBackgroundCommands: () => [job], async readBackgroundCommand(value) { calls.push(['logs', value]); return { content: JSON.stringify({ ...job, output: 'tail', truncated: true }) } },
    async stopBackgroundCommand(value) { calls.push(['stop', value]); return { content: JSON.stringify({ ...job, state: 'cancelled', cleanupConfirmed: true }) } },
    async stopAllBackgroundCommands() { calls.push(['all']) }, async restartBackgroundCommand(value, signal) { calls.push(['restart', value, signal]); return { content: JSON.stringify(job) } } }
  const io = { write: text => writes.push(text), onCancel: () => () => {}, onProcessControls(value) { controls = value; return () => disposed++ } }
  return { host, io, writes, calls, controls: () => controls, disposed: () => disposed }
}
test('process commands are provider-independent; logs show retained truncation and restart uses a fresh signal', async () => {
  const f = fixture()
  for (const command of ['/processes', `/processes logs ${id}`, `/processes stop ${id}`, `/processes restart ${id}`, '/processes stop-all']) assert.equal(await runProcessControl(f.host, f.io, command), true)
  assert.deepEqual(f.calls.map(call => call[0]), ['logs', 'stop', 'restart', 'all'])
  assert(f.calls[2][2] instanceof AbortSignal)
  assert(f.writes.join('').includes(id)); assert(f.writes.join('').includes('older output truncated'))
  assert(f.writes.join('').includes('tree cleanup verified'))
  assert.equal(await runProcessControl(f.host, f.io, '/processes stop-all unexpected'), true)
  assert.equal(f.calls.length, 4)
})
test('independent repeated Stop All drains once and released host bindings become inert', async () => {
  const f = fixture(); let release
  f.host.stopAllBackgroundCommands = () => { f.calls.push(['all']); return new Promise(resolve => { release = resolve }) }
  const dispose = bindBackgroundProcessControls(f.host, f.io), controls = f.controls()
  const first = controls.stopAll(), second = controls.stopAll(); assert.equal(f.calls.length, 1)
  dispose(); release(); await Promise.all([first, second])
  assert.equal(f.disposed(), 1); assert.deepEqual(controls.list(), [])
  await controls.stop(id); await controls.stopAll(); assert.equal(f.calls.length, 1)
  assert.equal(f.writes.length, 0, 'An obsolete host cannot report success into the new session')
})
test('failed or uncertain cleanup never prints a verified stopped claim', async () => {
  const f = fixture()
  f.host.stopBackgroundCommand = async () => ({ content: JSON.stringify({ executionId: id, state: 'failed', executionComplete: true, cleanupConfirmed: false }) })
  f.host.stopAllBackgroundCommands = async () => { throw new Error('tree still active') }
  const dispose = bindBackgroundProcessControls(f.host, f.io), controls = f.controls()
  await controls.stop(id); await controls.stopAll(); dispose()
  assert(f.writes.join('').includes('cleanup not confirmed'))
  assert(f.writes.join('').includes('tree still active'))
  assert(!f.writes.join('').includes('cleanup verified'))
})
test('interactive line F6/F7 stop jobs during working and approvals without consuming the draft or cancelling inference', async t => {
  const input = new PassThrough(), output = new PassThrough(); input.isTTY = true; output.isTTY = true
  const io = new TerminalIO({ input, output }); t.after(() => io.close())
  let stopped = 0, all = 0, cancelled = 0
  const dispose = io.onProcessControls({ list: () => [job], async stop(value) { assert.equal(value, id); stopped++ }, async stopAll() { all++ } })
  const working = io.onCancel(() => cancelled++)
  const steering = io.onSteering({ submit() { throw new Error('Shortcut must not submit a draft') }, takeLast() {}, clear() {} })
  input.write('draft'); input.emit('keypress', '', { name: 'f6' }); input.emit('keypress', '', { name: 'f7' }); await tick()
  assert.equal(stopped, 1); assert.equal(all, 1); assert.equal(cancelled, 0); assert.equal(io.readline.line, 'draft')
  const approval = io.approve({ call: { id: 'approval', name: 'note_set', arguments: {} }, currentRevision: 0, description: 'review' }, new AbortController().signal)
  input.emit('keypress', '', { name: 'f7' }); input.write('deny\n'); assert.equal(await approval, false)
  assert.equal(all, 2); assert.equal(io.readline.line, 'draft')
  dispose(); input.emit('keypress', '', { name: 'f7' }); await tick(); assert.equal(all, 2)
  steering(); working()
})


test('Stop All is never swallowed by a pending individual stop and still stops the other jobs', async () => {
  const f = fixture(); let finishOne, finishAll
  f.host.stopBackgroundCommand = value => { f.calls.push(['stop', value]); return new Promise(resolve => { finishOne = () => resolve({ content: JSON.stringify({ ...job, state: 'cancelled', cleanupConfirmed: true }) }) }) }
  f.host.stopAllBackgroundCommands = () => { f.calls.push(['all']); return new Promise(resolve => { finishAll = resolve }) }
  const dispose = bindBackgroundProcessControls(f.host, f.io), controls = f.controls()
  const first = controls.stop(id), duplicate = controls.stop(id), all = controls.stopAll(), repeatedAll = controls.stopAll()
  assert.deepEqual(f.calls.map(value => value[0]), ['stop', 'all'], 'Distinct cleanup targets run independently; exact repeats coalesce')
  finishAll(); await all; await repeatedAll
  finishOne(); await first; await duplicate; dispose()
})
