// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Writable } from 'node:stream'
import { AutomationIO, AUTOMATION_LIMITS } from '../dist/automation.js'

function capture() {
  let text = ''
  const stream = new Writable({ write(chunk, _encoding, callback) { text += chunk; callback() } })
  return { stream, text: () => text, records: () => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
}
const result = (content = 'Done') => ({ status: 'completed', content, history: [], rounds: 1,
  usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } })

test('automation wire is versioned, monotonic and terminal only after finish', async () => {
  const out = capture(), err = capture(), io = new AutomationIO([], { stdout: out.stream, stderr: err.stream })
  await io.started(); await io.sessionStarted('session', 'openai', 'model')
  await io.event({ type: 'assistant', message: { kind: 'assistant', content: 'Done', toolCalls: [], providerState: { provider: 'x', items: ['never-emit'] } } })
  await io.event({ type: 'round_completed', usage: result().usage })
  io.result(result()); io.close()
  assert(!out.records().some(e => e.type === 'run.completed'))
  assert.equal(await io.finish(0), 0)
  const events = out.records()
  assert.deepEqual(events.map(e => e.seq), [1, 2, 3, 4, 5])
  assert(events.every(e => e.version === 1 && e.protocol === 'vivi.automation' && e.run_id === events[0].run_id))
  assert.equal(events.at(-1).usage.complete, true)
  assert(!out.text().includes('never-emit'))
})

test('provisional chunks and tool bodies are omitted, accepted text dynamically redacted', async () => {
  const out = capture(), err = capture(), io = new AutomationIO([], { stdout: out.stream, stderr: err.stream })
  await io.started()
  await io.event({ type: 'text_delta', text: 'split-' }); await io.event({ type: 'text_delta', text: 'secret' })
  io.addSecrets(['split-secret'])
  await io.event({ type: 'assistant', message: { kind: 'assistant', content: 'split-secret', toolCalls: [] } })
  await io.event({ type: 'tool_started', call: { id: 'c', name: 'tool', arguments: { private: 'never-arguments' } } })
  await io.event({ type: 'tool_completed', message: { kind: 'tool_result', callId: 'c', name: 'tool', content: 'never-result' } })
  io.result(result('split-secret')); assert.equal(await io.finish(0), 0)
  assert(!out.text().includes('split-secret')); assert(!out.text().includes('never-'))
  assert.equal(out.records().at(-1).final_text, '[REDACTED]')
  assert.equal(out.records().at(-1).usage.complete, false)
})

test('schema mode withholds assistant text even before final validation failure', async () => {
  const out = capture(), io = new AutomationIO([], { stdout: out.stream, stderr: capture().stream }); io.schemaMode = true
  await io.started(); await io.event({ type: 'assistant', message: { kind: 'assistant', content: 'not-json', toolCalls: [] } })
  io.result(result('not-json'))
  assert.equal(await io.finish(0, () => { throw Object.assign(new Error('sensitive value'), { code: 'invalid_json' }) }), 3)
  assert(!out.text().includes('not-json')); assert(!out.text().includes('sensitive'))
  assert.equal(out.records().at(-1).code, 'invalid_json')
})

test('cleanup failure overrides successful result and cancellation', async () => {
  const out = capture(), signal = new AbortController(), io = new AutomationIO([], { stdout: out.stream, stderr: capture().stream, signal: signal.signal })
  await io.started(); io.result(result()); signal.abort(); io.cleanupFailure()
  assert.equal(await io.finish(0), 1); assert.equal(out.records().at(-1).code, 'cleanup_failed')
})

test('own expected AbortError preserves cancellation without raw exception', async () => {
  const out = capture(), signal = new AbortController(), io = new AutomationIO([], { stdout: out.stream, stderr: capture().stream, signal: signal.signal })
  await io.started(); signal.abort(); io.caught(new DOMException('private exception', 'AbortError'))
  assert.equal(await io.finish(1), 130); assert.equal(out.records().at(-1).type, 'run.cancelled')
  assert(!out.text().includes('private'))
})

test('output acknowledgements apply backpressure and bound stalled consumer lifetime', async () => {
  let writeCallback
  const stdout = new Writable({ write(_chunk, _encoding, callback) { writeCallback = callback } })
  const io = new AutomationIO([], { stdout, stderr: capture().stream, writeTimeoutMs: 30 })
  let cancelled = false; io.onCancel(() => { cancelled = true })
  await assert.rejects(io.started(), /output is unavailable/)
  assert.equal(cancelled, true); assert.equal(await io.finish(0), 74)
  writeCallback(); stdout.destroy() // late callbacks/close cannot become unhandled failures
})

test('broken pipe aborts work and emits no fake terminal success', async () => {
  const stdout = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error('secret-pipe'), { code: 'EPIPE' })) } })
  const io = new AutomationIO([], { stdout, stderr: capture().stream })
  await assert.rejects(io.started()); assert.equal(io.signal.aborted, true); assert.equal(await io.finish(0), 74)
  await new Promise(resolve => setImmediate(resolve))
})

test('a slow writable holds each accepted event until its write callback', async () => {
  const pending = [], chunks = []
  const stdout = new Writable({ write(chunk, _encoding, callback) { chunks.push(String(chunk)); pending.push(callback) } })
  const io = new AutomationIO([], { stdout, stderr: capture().stream })
  let done = false; const start = io.started().then(() => { done = true })
  await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false)
  pending.shift()(); await start; assert.equal(done, true)
  io.result(result()); const finish = io.finish(0)
  await new Promise(resolve => setImmediate(resolve)); pending.shift()()
  assert.equal(await finish, 0); assert.equal(chunks.length, 2)
})

test('oversized final answer fails instead of clipping a successful answer', async () => {
  const out = capture(), io = new AutomationIO([], { stdout: out.stream, stderr: capture().stream })
  await io.started(); io.result(result('x'.repeat(AUTOMATION_LIMITS.finalBytes + 1)))
  assert.equal(await io.finish(0), 3); assert.equal(out.records().at(-1).code, 'output_too_large')
})

test('approval callbacks deny immediately and prevent successful terminal status', async () => {
  const out = capture(), io = new AutomationIO([], { stdout: out.stream, stderr: capture().stream })
  await io.started(); assert.equal(await io.approve({}, new AbortController().signal), false)
  io.result(result()); assert.equal(await io.finish(0), 4)
  assert.equal(out.records().at(-1).code, 'interaction_required')
})
