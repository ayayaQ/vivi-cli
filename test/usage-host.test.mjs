// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { CliHost, FileSessionStore, newSession, validateSession, TerminalIO, runChatLoop } from '../dist/index.js'

const settings = { provider: 'openai', model: 'fake-usage-model' }
const counts = (cachedInputTokens = 0, cacheWriteInputTokens = 0) => ({
  inputTokens: 3, outputTokens: 2, totalTokens: 7, cachedInputTokens, cacheWriteInputTokens
})
const response = (usage, toolCalls = []) => ({ content: 'Accepted', toolCalls, ...(usage ? { usage } : {}) })
const call = { id: 'cache-calc', name: 'calculate', arguments: { expression: '1+1' } }
const own = (usage, field) => Object.hasOwn(usage, field)
function memoryStore() {
  return { snapshots: [], async save(session) { this.snapshots.push(validateSession(session)) },
    async load(id) { return structuredClone(this.snapshots.findLast(session => session.id === id)) } }
}
async function create(provider, options = {}) {
  const store = options.store ?? memoryStore()
  return { store, host: await CliHost.create({ store, settings, provider, ...options }) }
}

test('schema-1 cache fields round-trip, preserve absence/zero and reject invalid metrics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-cli-cache-usage-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new FileSessionStore(directory)
  const old = newSession(settings)
  await store.save(old)
  assert.deepEqual((await store.load(old.id)).usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  for (const cache of [{ cachedInputTokens: 0 }, { cacheWriteInputTokens: 0 },
    { cachedInputTokens: 4, cacheWriteInputTokens: 2 }]) {
    const session = { ...old, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 7, ...cache } }
    await store.save(session)
    assert.deepEqual((await store.load(old.id)).usage, session.usage)
  }
  for (const field of ['cachedInputTokens', 'cacheWriteInputTokens']) {
    for (const value of [undefined, null, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0']) {
      assert.throws(() => validateSession({ ...old, usage: { ...old.usage, [field]: value } }), /Invalid session/)
    }
  }
  assert.throws(() => validateSession({ ...old, usage: { ...old.usage, guessedSavings: 0 } }), /unexpected field/)
})

test('round, turn and resumed session sums preserve explicit zero without inflating provider totals', async () => {
  let round = 0
  const events = []
  const { host, store } = await create({ generate: async () => ++round === 1
    ? response(counts(2, 0), [call]) : response(counts(0, 4)) }, { onEvent: event => events.push(event) })
  const result = await host.send('Two rounds')
  const expected = { inputTokens: 6, outputTokens: 4, totalTokens: 14, cachedInputTokens: 2, cacheWriteInputTokens: 4 }
  assert.equal(result.rounds, 2)
  assert.deepEqual(result.usage, expected)
  assert.deepEqual(host.session.usage, expected)
  assert.deepEqual((await store.load(host.session.id)).usage, expected)
  assert.deepEqual(events.filter(event => event.type === 'round_completed').map(event => event.usage),
    [counts(2, 0), counts(0, 4)])
  const resumed = await CliHost.resume({ store, id: host.session.id, provider: { generate: async () => response(counts(0, 0)) } })
  assert.deepEqual((await resumed.send('Continue')).usage, counts(0, 0))
  assert.deepEqual(resumed.session.usage,
    { inputTokens: 9, outputTokens: 6, totalTokens: 21, cachedInputTokens: 2, cacheWriteInputTokens: 4 })
})

test('usage preflight preserves the provider method receiver and per-turn capture', async () => {
  const provider = { calls: 0, async generate() {
    assert.equal(this, provider)
    this.calls++
    this.generate = async () => { throw new Error('A replaced method must wait for the next turn') }
    return this.calls === 1 ? response(counts(0, 0), [call]) : response(counts(0, 0))
  } }
  const { host } = await create(provider)
  const result = await host.send('Capture one method')
  assert.equal(result.status, 'completed')
  assert.equal(result.rounds, 2)
  assert.equal(provider.calls, 2)
  assert.deepEqual(host.session.usage,
    { inputTokens: 6, outputTokens: 4, totalTokens: 14, cachedInputTokens: 0, cacheWriteInputTokens: 0 })
})

test('each cache field becomes independently unreported across rounds and later turns', async () => {
  let round = 0
  const readOnly = { inputTokens: 3, outputTokens: 2, totalTokens: 7, cachedInputTokens: 5 }
  const { host } = await create({ generate: async () => ++round === 1
    ? response(counts(2, 0), [call]) : response(readOnly) })
  const first = await host.send('Two rounds')
  assert.deepEqual(first.usage, { inputTokens: 6, outputTokens: 4, totalTokens: 14, cachedInputTokens: 7 })
  assert.deepEqual(host.session.usage, first.usage)
  await host.send('Reported read only again')
  assert.equal(host.session.usage.cachedInputTokens, 12)
  assert.equal(own(host.session.usage, 'cacheWriteInputTokens'), false)
  const resumed = new CliHost({ store: memoryStore(), session: host.session,
    provider: { generate: async () => response({ inputTokens: 3, outputTokens: 2, totalTokens: 7, cacheWriteInputTokens: 0 }) } })
  const result = await resumed.send('Missing read')
  assert.equal(result.usage.cacheWriteInputTokens, 0)
  assert.equal(own(resumed.session.usage, 'cachedInputTokens'), false)
  assert.equal(own(resumed.session.usage, 'cacheWriteInputTokens'), false)
})

test('a committed no-usage round invalidates both cache fields while an unaccepted response does not', async () => {
  let index = 0
  const { host } = await create({ generate: async () => ++index === 1
    ? response(counts(0, 0), [call]) : response(undefined) })
  const result = await host.send('Missing round telemetry')
  assert.equal(result.rounds, 2)
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 7 })
  assert.deepEqual(host.session.usage, result.usage)
})

test('old schema-1 assistant history never acquires invented complete cache aggregates', async () => {
  const old = newSession(settings)
  old.history = [{ kind: 'message', role: 'user', content: 'Old request' },
    { kind: 'assistant', content: 'Old response', toolCalls: [] }]
  old.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const host = new CliHost({ store: memoryStore(), session: validateSession(JSON.parse(JSON.stringify(old))),
    provider: { generate: async () => response(counts(0, 0)) } })
  const result = await host.send('New reported turn')
  assert.deepEqual(result.usage, counts(0, 0))
  assert.deepEqual(host.session.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 7 })
  const nonemptyTotals = { ...newSession(settings), usage: { inputTokens: 8, outputTokens: 3, totalTokens: 15 } }
  const other = new CliHost({ store: memoryStore(), session: nonemptyTotals,
    provider: { generate: async () => response(counts(0, 0)) } })
  await other.send('Do not discard historical totals')
  assert.deepEqual(other.session.usage, { inputTokens: 11, outputTokens: 5, totalTokens: 22 })
})

test('unknown historical cache sums do not reject individually safe reports from later turns', async () => {
  const old = newSession(settings)
  old.history = [{ kind: 'assistant', content: 'No historical telemetry', toolCalls: [] }]
  const max = { inputTokens: 0, outputTokens: 0, totalTokens: 0,
    cachedInputTokens: Number.MAX_SAFE_INTEGER, cacheWriteInputTokens: 0 }
  const host = new CliHost({ store: memoryStore(), session: old,
    provider: { generate: async () => response(max) } })
  for (const content of ['First maximum', 'Second maximum']) {
    const result = await host.send(content)
    assert.equal(result.status, 'completed')
    assert.deepEqual(result.usage, max)
    assert.deepEqual(host.session.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  }
})

for (const failAt of ['assistant', 'round_completed']) {
  test(`cancellation at ${failAt} reconciles accepted usage exactly once`, async () => {
    let host
    const store = memoryStore()
    host = (await create({ generate: async () => response(counts(0, 2), [call]) },
      { store, onEvent: event => { if (event.type === failAt) host.cancel() } })).host
    const result = await host.send('Cancel after accepting')
    assert.equal(result.status, 'cancelled')
    assert.equal(result.rounds, 1)
    assert.deepEqual(result.usage, counts(0, 2))
    assert.deepEqual(host.session.usage, result.usage)
    assert.deepEqual((await store.load(host.session.id)).usage, result.usage)
    assert.deepEqual((await store.load(host.session.id)).history, result.history)
  })
}

test('event failure after round checkpoint reconciles once from the pre-turn baseline', async () => {
  let fail = false
  const { host, store } = await create({ generate: async () => response(counts(0, 0)) },
    { onEvent: event => { if (fail && event.type === 'round_completed') throw new Error('Fake event failure') } })
  await host.send('First accepted turn')
  fail = true
  const result = await host.send('Accepted before hook fails')
  assert.equal(result.status, 'error')
  assert.equal(result.error.code, 'event_error')
  assert.deepEqual(result.usage, counts(0, 0))
  assert.deepEqual(host.session.usage,
    { inputTokens: 6, outputTokens: 4, totalTokens: 14, cachedInputTokens: 0, cacheWriteInputTokens: 0 })
  assert.deepEqual((await store.load(host.session.id)).usage, host.session.usage)
})

test('cancellation before acceptance preserves prior cache telemetry and suppresses late counts', async () => {
  let resolve
  let started
  const ready = new Promise(yes => { started = yes })
  let round = 0
  const { host, store } = await create({ generate: async () => {
    if (++round === 1) return response(counts(0, 4))
    started()
    return new Promise(yes => { resolve = yes })
  } })
  await host.send('Accepted first')
  const sending = host.send('Unaccepted second')
  await ready
  host.cancel()
  const result = await sending
  assert.equal(result.rounds, 0)
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(host.session.usage, counts(0, 4))
  resolve(response(counts(100, 100)))
  await new Promise(yes => setImmediate(yes))
  assert.deepEqual((await store.load(host.session.id)).usage, counts(0, 4))
})

test('assistant checkpoint with unreported round metrics cannot masquerade as complete cache sums', async () => {
  const { host, store } = await create({ generate: async () => response(counts(2, 3)) })
  await host.send('First')
  await host.send('Second')
  const checkpoint = store.snapshots.findLast(session => session.history.filter(message => message.kind === 'assistant').length === 2 &&
    !own(session.usage, 'cachedInputTokens'))
  assert.ok(checkpoint)
  assert.equal(own(checkpoint.usage, 'cacheWriteInputTokens'), false)
  const recovered = new CliHost({ store: memoryStore(), session: checkpoint,
    provider: { generate: async () => response(counts(0, 0)) } })
  await recovered.send('After hypothetical crash')
  assert.equal(own(recovered.session.usage, 'cachedInputTokens'), false)
  assert.equal(own(recovered.session.usage, 'cacheWriteInputTokens'), false)
})

for (const field of ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens']) {
  test(`session ${field} overflow is rejected before committing another assistant`, async () => {
    const session = newSession(settings)
    session.history = [{ kind: 'assistant', content: 'Prior', toolCalls: [] }]
    session.usage = { ...counts(0, 0), [field]: Number.MAX_SAFE_INTEGER }
    const host = new CliHost({ store: memoryStore(), session,
      provider: { generate: async () => response({ ...counts(1, 1), inputTokens: 1 }) } })
    const result = await host.send('Overflow')
    assert.equal(result.status, 'error')
    assert.equal(result.rounds, 0)
    assert.equal(result.history.filter(message => message.kind === 'assistant').length, 1)
    assert.deepEqual(host.session.usage, session.usage)
  })
}

test('line output labels turn and session scope and preserves zero versus unreported', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let text = ''
  output.on('data', chunk => { text += chunk })
  const io = new TerminalIO({ input, output, stream: false })
  try {
    io.result({ status: 'completed', rounds: 1, content: '', history: [],
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 7, cachedInputTokens: 0 } })
    assert.match(text, /Turn tokens: 3 in \/ 2 out \/ 7 total/)
    assert.match(text, /Cache input: read 0 \/ write unreported/)
    const { host } = await create({ generate: async () => response(counts(0, 0)) })
    await host.send('Known session')
    input.end('/session\n/exit\n')
    await runChatLoop(host, io)
    assert.match(text, /Session tokens: 3 in \/ 2 out \/ 7 total/)
    assert.match(text, /Cache input: read 0 \/ write 0/)
  } finally { io.close(); input.destroy(); output.destroy() }
})

test('legacy synthetic terminal wraps multiline cache status within its row and column budget', () => {
  const input = new PassThrough()
  const output = new PassThrough()
  Object.assign(input, { isTTY: true })
  Object.assign(output, { isTTY: true, rows: 12, columns: 40 })
  let text = ''
  output.on('data', chunk => { text += chunk })
  const io = new TerminalIO({ input, output, tui: true, stream: false })
  try {
    io.event({ type: 'round_completed', usage: counts(0, 0) })
    const frame = text.split('\x1b[2J\x1b[H').at(-1)
    assert.match(frame, /Round tokens: 3 in \/ 2 out \/ 7 total/)
    assert.match(frame, /Cache input: read 0 \/ write 0/)
    assert.ok(frame.trimEnd().split('\n').every(line => line.length <= 40))
    assert.ok(frame.trimEnd().split('\n').length < 12)
  } finally { io.close(); input.destroy(); output.destroy() }
})
