// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { createProgramStatusSink, TerminalProgramStatus } from '../dist/terminal-program-status.js'
import { TerminalIO } from '../dist/terminal.js'
const frame = (state, kind) => `\x1b]7501;state=${state}${state === 'clear' ? '' : ':app=vivi-cli'}${kind ? `:kind=${kind}` : ''}\x1b\\`
function output(ready = true) {
  const stream = new EventEmitter(); stream.isTTY = true; stream.bytes = []
  stream.write = (bytes, callback) => { stream.bytes.push(bytes); callback?.(); return ready }
  return stream
}
test('exact rev 0.4 frames, root identity and fixed vocabulary; dedup and idempotent cleanup', () => {
  const stream = output(), sink = createProgramStatusSink(stream, {})
  for (const state of ['idle', 'working', 'done', 'blocked', 'error']) { sink.report(state); sink.report(state) }
  for (const kind of ['permission', 'question', 'auth']) sink.report('blocked', kind)
  sink.report('working\x07secret'); sink.report('blocked', 'question:msg=secret')
  sink.close(true); sink.close(true); sink.report('working')
  assert.deepEqual(stream.bytes, ['idle', 'working', 'done', 'blocked', 'error'].map(s => frame(s)).concat(
    ['permission', 'question', 'auth'].map(k => frame('blocked', k)), frame('clear')))
})
test('non-TTY, dumb, opt-out and old VTE never write, query stdin or install listeners', () => {
  for (const [tty, env] of [[false, {}], [undefined, {}], [true, { TERM: 'dumb' }],
    ...['0', 'false', 'OFF'].map(value => [true, { VIVI_OSC7501: value }]), [true, { VTE_VERSION: '5399' }]]) {
    const stream = output(); stream.isTTY = tty
    assert.equal(createProgramStatusSink(stream, env), undefined)
    assert.deepEqual(stream.bytes, []); assert.equal(stream.listenerCount('error'), 0)
  }
  for (const env of [{}, { VTE_VERSION: '5400' }, { VTE_VERSION: 'invalid' }, { TMUX: 'present' }]) {
    const stream = output(), sink = createProgramStatusSink(stream, env)
    sink.report('working'); sink.close(false); assert.deepEqual(stream.bytes, [frame('working')])
  }
})
test('one bounded latest pending record under backpressure, including reverting to written state', () => {
  const stream = output(false), sink = createProgramStatusSink(stream, {})
  sink.report('working')
  for (let i = 0; i < 10000; i++) { sink.report('blocked', 'permission'); sink.report('working') }
  stream.emit('drain'); assert.deepEqual(stream.bytes, [frame('working')])
  sink.report('blocked', 'question'); sink.report('working'); sink.report('done')
  assert.equal(stream.bytes.length, 2)
  stream.emit('drain'); assert.deepEqual(stream.bytes, [frame('working'), frame('blocked', 'question'), frame('done')])
  sink.report('working'); sink.close(true); stream.emit('drain')
  assert.equal(stream.bytes.at(-1), frame('clear')); assert.equal(stream.bytes.length, 4)
  assert.equal(stream.listenerCount('drain'), 0)
})
test('write errors cannot fail the conversation and stop further reports', async () => {
  const throwing = output(); throwing.write = () => { throw new Error('offline failure') }
  const sink = createProgramStatusSink(throwing, {})
  assert.doesNotThrow(() => { sink.report('working'); sink.report('done'); sink.close(true) })
  const stream = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('offline async failure')) } })
  stream.isTTY = true
  const asyncSink = createProgramStatusSink(stream, {})
  asyncSink.report('working'); asyncSink.close(true); await new Promise(resolve => setImmediate(resolve))
  assert.doesNotThrow(() => { asyncSink.report('done'); asyncSink.close(true) })
  for (const clear of [true, false]) {
    const delayed = new Writable({ write(_chunk, _encoding, callback) { setTimeout(() => callback(new Error('delayed offline failure')), 10) } })
    delayed.isTTY = true
    const delayedSink = createProgramStatusSink(delayed, {})
    delayedSink.report('done'); delayedSink.close(clear)
    await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(delayed.listenerCount('error'), 0)
  }
})
test('explicit lifecycle holds done/error through redraws; dialogs resume prior state; cancellation idle only on finish', () => {
  const reports = [], closes = []
  const status = new TerminalProgramStatus({ report: (...args) => reports.push(args), close: value => closes.push(value) })
  status.runStarted(); status.setBlocked('permission'); status.setBlocked('permission'); status.setBlocked()
  status.setBlocked('question'); status.setBlocked(); status.runFinished('completed')
  for (let i = 0; i < 100; i++) status.setBlocked()
  status.setBlocked('auth'); status.setBlocked(); status.runStarted(); status.runFinished('cancelled')
  status.runStarted(); status.runFinished('error'); status.close(); status.close(); status.runStarted()
  assert.deepEqual(reports, [['idle', undefined], ['working', undefined], ['blocked', 'permission'], ['working', undefined],
    ['blocked', 'question'], ['working', undefined], ['done', undefined], ['blocked', 'auth'], ['done', undefined],
    ['working', undefined], ['idle', undefined], ['working', undefined], ['error', undefined]])
  assert.deepEqual(closes, [true])
})
test('one-shot preserves only terminal done/error, clearing incomplete or blocked work', () => {
  for (const outcome of [undefined, 'completed', 'cancelled', 'error']) {
    const stream = output(), status = new TerminalProgramStatus(createProgramStatusSink(stream, {}), false)
    status.runStarted(); if (outcome) status.runFinished(outcome)
    status.close()
    assert.equal(stream.bytes.at(-1), frame(outcome === 'completed' ? 'done' : outcome === 'error' ? 'error' : 'clear'))
  }
})
test('line mode actual approval, abort, completion and cleanup use the shared lifecycle', async () => {
  const input = new PassThrough(); input.isTTY = true
  const stream = new PassThrough(); stream.isTTY = true
  let bytes = ''; stream.on('data', data => { bytes += data })
  const io = new TerminalIO({ input, output: stream, statusEnvironment: {} })
  io.runStarted()
  const controller = new AbortController()
  const approval = io.approve({ call: { id: 'private-id', name: 'private-tool', arguments: {} },
    currentRevision: 0, description: 'private-description' }, controller.signal)
  controller.abort(); await assert.rejects(approval)
  io.runFinished('cancelled'); io.runStarted(); io.runFinished('completed'); io.close(); io.close()
  const frames = bytes.match(/\x1b\]7501;[^\x1b]*\x1b\\/g)
  assert.deepEqual(frames, [frame('idle'), frame('working'), frame('blocked', 'permission'), frame('working'),
    frame('idle'), frame('working'), frame('done'), frame('clear')])
})
test('headless line output stays free of OSC even through final states', () => {
  const input = new PassThrough(), stream = new PassThrough(); let bytes = ''
  stream.on('data', data => { bytes += data })
  const io = new TerminalIO({ input, output: stream, statusEnvironment: {} })
  io.runStarted(); io.write('ordinary output\n'); io.runFinished('error'); io.close()
  assert.equal(bytes, 'ordinary output\n')
})
