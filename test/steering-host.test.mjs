// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { CliHost } from '../dist/host.js'
import { newSession, validateSession } from '../dist/session.js'
import { sendChatTurn, runSteeringCommand, runChatLoop } from '../dist/terminal.js'

const settings = { provider: 'openai', model: 'owned-steering-fixture' }
const answer = (content = 'Done', toolCalls = []) => ({ content, toolCalls })
const call = id => ({ id, name: 'fixture', arguments: {} })
const tick = () => new Promise(resolve => setImmediate(resolve))
function gate(t) {
  let resolve
  const promise = new Promise(done => { resolve = done })
  t.after(() => resolve())
  return { promise, resolve }
}
async function fixture(t, options = {}) {
  const snapshots = [], queries = [], accepted = []
  let rounds = 0, host
  const store = { async save(value) { snapshots.push(validateSession(structuredClone(value))); await options.onSave?.(value, host) } }
  host = await CliHost.create({ settings, store, provider: { async generate(input, signal, progress) {
    queries.push(structuredClone(input)); return options.generate?.(input, signal, progress, ++rounds) ?? answer()
  } }, ...options.host })
  t.after(() => host.shutdown())
  return { host, snapshots, queries, accepted }
}
function surface() {
  const state = { messages: [], accepted: [], results: [], starts: 0, finishes: [], controls: undefined }
  const io = {
    onSteering(controls) { state.controls = controls; return () => { state.controls = undefined } },
    setSteeringQueue(messages) { state.queue = messages },
    steeringAccepted(content, initial) { state.accepted.push({ content, initial }) },
    runStarted() { state.starts++ }, runFinished(outcome) { state.finishes.push(outcome) },
    write(text) { state.messages.push(text) }, result(result) { state.results.push(result) },
    onCancel() { return () => {} }, close() {}, event() {}, approve() { return Promise.resolve(false) }
  }
  return { io, state }
}

test('host injects duplicate queued user messages only after the complete tool batch and checkpoints them', { timeout: 10000 }, async t => {
  const entered = gate(t), release = gate(t), order = []
  const f = await fixture(t, { generate(input, _signal, _progress, round) {
    order.push(`generate:${round}`)
    if (round === 1) return answer('Two calls', [call('a'), call('b')])
    assert.deepEqual(input.messages.slice(-2).map(message => message.content), ['same', 'same'])
    return answer()
  }, host: { extensions: [{ id: 'owned-fixture', apiVersion: 1, tools: [{
    definition: { name: 'fixture', description: 'Inert test', parameters: {} }, validateArguments() {},
    async execute(call) { order.push(call.id); if (call.id === 'a') { entered.resolve(); await release.promise }; return { content: call.id } }
  }] }] } })
  const run = f.host.send('Start', undefined, content => f.accepted.push(content))
  await entered.promise
  f.host.queueMessage('same'); f.host.queueMessage('same')
  assert.equal(f.host.queuedMessages.length, 2)
  release.resolve()
  const result = await run
  assert.equal(result.status, 'completed')
  assert.deepEqual(order, ['generate:1', 'a', 'b', 'generate:2'])
  assert.deepEqual(f.accepted, ['same', 'same'])
  assert.deepEqual(result.history.filter(message => message.kind === 'message').map(message => message.content), ['Start', 'same', 'same'])
  assert.deepEqual(f.host.queuedMessages, [])
  assert.deepEqual(f.host.conversationRecords.runs.at(-1).history.map(entry => entry.message), result.history)
  assert.equal(f.host.conversationRecords.state, 'shadow')
})

test('force send waits for owned cleanup before the next run and ignores late provider output', { timeout: 10000 }, async t => {
  const entered = gate(t), late = gate(t), cleaning = gate(t), cleaned = gate(t)
  const { io, state } = surface()
  let cleanupCalls = 0, cleanupSettled = false
  const f = await fixture(t, { generate(_input, _signal, _progress, round) {
    if (round === 1) { entered.resolve(); return late.promise.then(() => answer('Obsolete')) }
    assert.equal(cleanupSettled, true)
    return answer('New answer')
  }, host: { commandWorkspace: { endRun: async () => {
    if (++cleanupCalls === 1) { cleaning.resolve(); await cleaned.promise; cleanupSettled = true }
  }, shutdown: async () => {} } } })
  const run = sendChatTurn(f.host, io, 'Start')
  await entered.promise
  assert.equal(state.controls.submit('Follow-up', true), true)
  await cleaning.promise; await tick()
  assert.equal(f.queries.length, 1, 'A replacement run cannot overlap admitted cleanup')
  assert.equal(f.host.running, true)
  cleaned.resolve()
  const result = await run
  assert.equal(result.status, 'completed'); assert.equal(result.content, 'New answer')
  assert.deepEqual(state.finishes, ['cancelled', 'completed'])
  assert.deepEqual(state.accepted, [{ content: 'Follow-up', initial: true }])
  assert.deepEqual(result.history.filter(message => message.kind === 'message').map(message => message.content), ['Start', 'Follow-up'])
  assert.equal(state.results[0].status, 'cancelled')
  late.resolve(); await tick()
  assert(!f.host.session.history.some(message => message.content === 'Obsolete'))
  assert.deepEqual(f.host.queuedMessages, [])
})

test('ordinary cancel preserves queued input, while explicit queue send resumes the same owner', { timeout: 10000 }, async t => {
  const entered = gate(t), late = gate(t), { io, state } = surface()
  const f = await fixture(t, { generate(_input, _signal, _progress, round) {
    if (round === 1) { entered.resolve(); return late.promise.then(() => answer('Obsolete')) }
    return answer('Resumed')
  } })
  const run = sendChatTurn(f.host, io, 'Start')
  await entered.promise
  state.controls.submit('Retained', false)
  f.host.cancel()
  assert.equal((await run).status, 'cancelled')
  assert.equal(f.queries.length, 1)
  assert.equal(f.host.queuedMessages[0].content, 'Retained')
  assert.equal(await runSteeringCommand(f.host, io, '/queue send'), true)
  assert.equal(state.results.at(-1).content, 'Resumed')
  assert.deepEqual(f.host.queuedMessages, [])
})

test('final text response queues continue, including rollover at the exhausted round budget', { timeout: 10000 }, async t => {
  const { io, state } = surface()
  const f = await fixture(t, { generate(_input, _signal, _progress, round) {
    if (round === 1) state.controls.submit('After final', false)
    return answer(`answer ${round}`)
  }, host: { maxRounds: 1 } })
  const result = await sendChatTurn(f.host, io, 'Start')
  assert.equal(result.status, 'completed')
  assert.equal(result.content, 'answer 2')
  assert.equal(f.queries.length, 2)
  assert.deepEqual(state.finishes, ['completed', 'completed'])
  assert.deepEqual(f.host.queuedMessages, [])
})

test('a later idle submit follows retained queued input instead of overtaking it', { timeout: 10000 }, async t => {
  const { io, state } = surface()
  const f = await fixture(t)
  f.host.queueMessage('First retained')
  const result = await sendChatTurn(f.host, io, 'Later submit')
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.history.filter(message => message.kind === 'message').map(message => message.content),
    ['First retained', 'Later submit'])
  assert.deepEqual(state.accepted.map(message => message.content), ['First retained', 'Later submit'])
  assert.deepEqual(f.host.queuedMessages, [])
})

test('captured boundary input is visibly sending and cannot be removed before admission', { timeout: 10000 }, async t => {
  const { io, state } = surface()
  const original = io.setSteeringQueue
  let checked = false
  io.setSteeringQueue = messages => {
    original(messages)
    if (checked || messages[0]?.state !== 'sending') return
    checked = true
    state.controls.clear()
    assert.equal(state.queue[0].state, 'sending')
    assert.equal(state.controls.takeLast(), undefined)
  }
  const f = await fixture(t, { generate(_input, _signal, _progress, round) {
    if (round === 1) state.controls.submit('Admitting', false)
    return answer()
  } })
  assert.equal((await sendChatTurn(f.host, io, 'Start')).status, 'completed')
  assert.equal(checked, true)
  assert.deepEqual(f.host.queuedMessages, [])
})

test('interrupt waits for an admitted steering checkpoint and keeps canonical input exactly once', { timeout: 10000 }, async t => {
  const entered = gate(t), release = gate(t), { io, state } = surface()
  let stored, paused = false
  const conversationStore = {
    async read() { return stored && structuredClone(stored) },
    async write(_id, value, expectedDigest, assertCurrent) {
      assert.equal(stored?.digest ?? null, expectedDigest)
      const record = value.runs?.at(-1)?.records.at(-1)
      if (!paused && record?.type === 'user_message_accepted') {
        paused = true; entered.resolve(); await release.promise
      }
      assertCurrent()
      stored = { value: structuredClone(value), digest: createHash('sha256').update(JSON.stringify(value)).digest('hex') }
      return stored.digest
    }
  }
  const f = await fixture(t, { generate(input, _signal, _progress, round) {
    if (round === 1) state.controls.submit('Admitted', false)
    else assert.deepEqual(input.messages.filter(message => message.kind === 'message').map(message => message.content),
      ['Start', 'Admitted', 'Next'])
    return answer()
  }, host: { conversationStore } })
  const run = sendChatTurn(f.host, io, 'Start')
  await entered.promise
  assert.equal(f.host.session.history.filter(message => message.content === 'Admitted').length, 1)
  assert.deepEqual(f.host.queuedMessages, [])
  assert.equal(state.controls.submit('Next', true), true)
  await tick()
  assert.equal(f.queries.length, 1, 'The replacement turn waits for the admitted checkpoint')
  release.resolve()
  const result = await run
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.history.filter(message => message.kind === 'message').map(message => message.content),
    ['Start', 'Admitted', 'Next'])
  assert.deepEqual(f.host.queuedMessages, [])
  assert.equal(f.host.conversationRecords.state, 'shadow')
})

test('checkpoint failure cannot duplicate known canonical admission and rejects credentials before queueing', { timeout: 10000 }, async t => {
  let fail = false
  const f = await fixture(t, { generate(_input, _signal, _progress, round) {
    if (round === 1) { f.host.queueMessage('Retained'); fail = true }
    return answer()
  }, onSave(session) {
    if (fail && session.history.at(-1)?.kind === 'message') throw new Error('Owned checkpoint failed')
  }, host: { secrets: ['owned-secret'] } })
  assert.throws(() => f.host.queueMessage('owned-secret'), /credential/)
  await assert.rejects(f.host.send('Start'), /checkpoint failed/)
  assert.deepEqual(f.host.queuedMessages, [])
  assert.equal(f.host.session.history.filter(message => message.kind === 'message' && message.content === 'Retained').length, 1)
})

test('queued steering stays raw and ordered after context compaction, and local context refresh never consumes it', async t => {
  const requests = [], session = newSession(settings)
  for (let index = 0; index < 5; index++) session.history.push(
    { kind: 'message', role: 'user', content: `Earlier ${index}: ${'source '.repeat(100)}` },
    { kind: 'assistant', content: 'Answer '.repeat(100), toolCalls: [] })
  let host, ordinary = 0
  host = new CliHost({ session, store: { async save(value) { validateSession(value) } }, enableTools: false,
    provider: {
      estimateContext(input) { return { inputTokens: Math.ceil(JSON.stringify(input).length / 4), estimated: true } },
      async generate(input, _signal, options) {
        if (options?.purpose === 'context-summary') return answer('Historical facts only')
        requests.push(structuredClone(input))
        if (++ordinary === 1) { host.queueMessage('same'); host.queueMessage('same') }
        return answer()
      }
    } })
  t.after(() => host.shutdown())
  await host.compact()
  const prior = structuredClone(host.session.history)
  host.queueMessage('queued before refresh')
  await host.refreshContext()
  assert.deepEqual(host.queuedMessages.map(message => message.content), ['queued before refresh'])
  host.clearQueuedMessages()
  const result = await host.send('Continue')
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.history.slice(0, prior.length), prior)
  assert.deepEqual(result.history.filter(message => message.kind === 'message').slice(-3).map(message => message.content), ['Continue', 'same', 'same'])
  assert(requests[1].messages.some(message => message.content?.startsWith('Historical conversation summary')))
  assert.deepEqual(requests[1].messages.slice(-2).map(message => message.content), ['same', 'same'])
  assert.deepEqual(host.queuedMessages, [])
  assert.equal(host.conversationRecords.state, 'shadow')
})

test('ordinary cancellation after interrupt prevents queued resend from restarting', { timeout: 10000 }, async t => {
  const cleaning = gate(t), cleaned = gate(t), started = gate(t), late = gate(t)
  const { io, state } = surface()
  let cancel, cleanup = 0
  io.onCancel = callback => { cancel = callback; return () => { cancel = undefined } }
  const f = await fixture(t, { generate() { started.resolve(); return late.promise.then(() => answer()) },
    host: { commandWorkspace: { async endRun() { if (++cleanup === 1) { cleaning.resolve(); await cleaned.promise } }, async shutdown() {} } } })
  f.host.queueMessage('First')
  const run = runSteeringCommand(f.host, io, '/queue send')
  await started.promise
  assert.equal(state.controls.submit('Second', true), true)
  await cleaning.promise
  cancel()
  cleaned.resolve()
  await run
  assert.equal(f.queries.length, 1)
  assert.deepEqual(f.host.queuedMessages.map(message => message.content), ['Second'])
})


test('line queue send reports checkpoint failure and keeps the loop alive for explicit retry', async t => {
  let fail = true
  const { host, queries } = await fixture(t, { onSave(session) {
    if (fail && session.history.some(message => message.role === 'user')) { fail = false; throw new Error('Owned queue checkpoint failed') }
  } })
  host.queueMessage('Retain and retry')
  const { io, state } = surface()
  const lines = ['/queue send', '/queue', '/queue send', '/exit']
  io.readLine = async () => lines.shift()
  await runChatLoop(host, io)
  assert.equal(lines.length, 0, 'Failed queued send did not terminate the input loop')
  assert.ok(state.messages.some(text => text.includes('Owned queue checkpoint failed')))
  assert.ok(state.messages.some(text => text.includes('Retain and retry')), 'Pending queue remained visible after rollback')
  assert.equal(state.results.length, 1, 'Only the explicit retry completed')
  assert.equal(queries.length, 1, 'Failed checkpoint could not call the provider')
  assert.equal(host.queuedMessages.length, 0)
  assert.deepEqual(host.session.history.filter(message => message.role === 'user').map(message => message.content), ['Retain and retry'])
})
