// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CliHost } from '../dist/host.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { cliHistoryToolPresentation, cliToolCardView, cliToolPresentationView } from '../dist/tool-presentation.js'

const settings = { provider: 'openai', model: 'offline-builtin-read-fixture' }
const call = (name, arguments_ = {}, id = `owned-${name}`) => ({ id, name, arguments: arguments_ })
const display = (host, history = host.session.history, evidence = host.toolPresentationEvidence) => {
  const index = history.findIndex(message => message.kind === 'tool_result')
  return cliHistoryToolPresentation(history, index, host.session.id, evidence)
}
async function diskHost(t, calls, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-builtin-read-outcomes-'))
  const store = new FileSessionStore(directory)
  let rounds = 0
  const host = await CliHost.create({ store, settings, ...options,
    provider: { async generate() { return ++rounds === 1 ? { content: '', toolCalls: calls }
      : { content: 'Done', toolCalls: [] } } } })
  t.after(async () => { await host.shutdown(); await rm(directory, { recursive: true, force: true }) })
  return { host, store }
}
for (const [name, args] of [['calculate', { expression: '118 + .314702876223' }], ['current_time', { timezone: 'UTC' }], ['note_read', {}]]) {
  test(`owned ${name} success has exact live, final and durable cold-replay evidence`, async t => {
    let host, observed
    const f = await diskHost(t, [call(name, args)], { enableNotes: true, onEvent(event) {
      if (event.type === 'tool_completed') observed = display(host)
    } })
    host = f.host
    const result = await host.send('Use the owned read')
    assert.equal(result.status, 'completed')
    for (const snapshot of [observed, display(host)]) {
      assert.equal(snapshot.status, 'succeeded'); assert.equal(snapshot.effect, 'confirmed')
      assert(snapshot.source.reference.startsWith('cli-builtin-read:'))
      const view = cliToolPresentationView(JSON.stringify(snapshot))
      assert(!view.warnings.some(warning => /unknown|unreported/i.test(warning)))
      const card = cliToolCardView(JSON.stringify(snapshot))
      assert(!card.title.includes('unverified')); assert.equal(card.attention, false)
    }
    assert.equal(host.conversationRecords.projection.outcomes.length, 1)
    const resumed = await CliHost.resume({ id: host.session.id, store: f.store,
      provider: { async generate() { assert.fail('Cold replay must not run a provider') } } })
    t.after(() => resumed.shutdown())
    assert.deepEqual(display(resumed), display(host))
  })
}
for (const [name, args] of [['calculate', { expression: '1 / 0' }], ['current_time', { timezone: 'invalid/zone' }]]) {
  test(`owned ${name} validation failure stays a failure with a confirmed local outcome`, async t => {
    const { host } = await diskHost(t, [call(name, args)])
    await host.send('Try this invalid read')
    const snapshot = display(host)
    assert.equal(snapshot.status, 'failed'); assert.equal(snapshot.effect, 'confirmed')
    assert(cliToolCardView(JSON.stringify(snapshot)).title.startsWith('failed'))
    assert(cliToolPresentationView(JSON.stringify(snapshot)).warnings.some(warning => warning.includes('Tool failed')))
  })
}
test('a changed session, occurrence, arguments or result cannot borrow a live read receipt', async t => {
  const { host } = await diskHost(t, [call('calculate', { expression: '2+3' })])
  await host.send('Calculate')
  const history = host.session.history, evidence = host.toolPresentationEvidence
  for (const mutate of [data => { data[1].toolCalls[0].arguments.expression = '2+4' },
    data => { data[2].content = '{"result":6}' }, data => { data.splice(0, 0, { kind: 'message', role: 'user', content: 'Different occurrence' }) }]) {
    const changed = structuredClone(history); mutate(changed)
    const index = changed.findIndex(message => message.kind === 'tool_result')
    const snapshot = cliHistoryToolPresentation(changed, index, host.session.id, { ...evidence, projection: undefined })
    assert.equal(snapshot.status, 'unknown'); assert.equal(snapshot.effect, 'unreported')
  }
  assert.equal(display(host, history, { ...evidence, sessionId: 'other' }).effect, 'unreported')
})
test('legacy valid builtin result bodies do not acquire execution evidence on import', async t => {
  const history = [{ kind: 'message', role: 'user', content: 'Old calculation' },
    { kind: 'assistant', content: '', toolCalls: [call('calculate', { expression: '2+3' })] },
    { kind: 'tool_result', callId: 'owned-calculate', name: 'calculate', content: '{"result":5}' },
    { kind: 'assistant', content: 'Five', toolCalls: [] }]
  const session = { ...newSession(settings), history }
  const host = new CliHost({ session, store: { async save() {}, async load() { return session } },
    provider: { async generate() { assert.fail('Legacy import cannot execute tools or providers') } } })
  t.after(() => host.shutdown()); await host.initialize()
  assert.equal(display(host).status, 'unknown'); assert.equal(display(host).effect, 'unreported')
  assert.deepEqual(host.conversationRecords.projection.outcomes, [])
})
test('cancel-before-dispatch keeps the synthetic builtin closure uncertain', async t => {
  let host
  const f = await diskHost(t, [call('calculate', { expression: '2+3' })], { onEvent(event) {
    if (event.type === 'tool_started') host.cancel()
  } })
  host = f.host
  const result = await host.send('Calculate then cancel')
  assert.equal(result.status, 'cancelled')
  assert.equal(display(host).status, 'unknown'); assert.equal(display(host).effect, 'unreported')
  assert.deepEqual(host.conversationRecords.projection.outcomes, [])
})
test('generic extensions and committed local writes do not inherit read effect certainty', async t => {
  const imported = call('owned_extension', {})
  const { host } = await diskHost(t, [imported, call('note_set', { key: 'ordinary', value: 'saved', expectedRevision: 0 })], {
    enableNotes: true, approve: async () => true,
    extensions: [{ id: 'owned.fixture', apiVersion: 1, tools: [{ definition: { name: imported.name,
      description: 'Inert imported fixture', parameters: { type: 'object' } }, validateArguments() {},
      execute() { return { content: '{"success":true,"status":"succeeded","effect":"confirmed"}' } } }] }]
  })
  await host.send('Run imported fixture and save note')
  const history = host.session.history
  for (const [index, message] of history.entries()) if (message.kind === 'tool_result') {
    const snapshot = cliHistoryToolPresentation(history, index, host.session.id, host.toolPresentationEvidence)
    assert.equal(snapshot.status, 'unknown'); assert.equal(snapshot.effect, 'unreported')
  }
  assert.equal(host.session.notes.ordinary, 'saved')
})
test('failed terminal persistence does not manufacture a resumed builtin receipt', async t => {
  let saved, stored
  const store = { async save(value) { saved = structuredClone(value) }, async load() { return structuredClone(saved) } }
  const conversationStore = { async read() { return structuredClone(stored) }, async write(_id, value, expectedDigest, guard) {
    assert.equal(stored?.digest ?? null, expectedDigest); guard()
    if (value.records.at(-1).type === 'run_settled') throw new Error('Owned failure before terminal commit')
    const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex')
    stored = { value: structuredClone(value), digest }; return digest
  } }
  let rounds = 0
  const host = await CliHost.create({ store, conversationStore, settings,
    provider: { async generate() { return ++rounds === 1 ? { content: '', toolCalls: [call('calculate', { expression: '2+3' })] }
      : { content: 'Done', toolCalls: [] } } } })
  t.after(() => host.shutdown())
  await host.send('Calculate with terminal commit failure')
  assert.equal(host.conversationRecords.state, 'unavailable')
  assert.equal(display(host).effect, 'confirmed', 'The live host retains exact observed completion')
  const resumed = await CliHost.resume({ id: host.session.id, store, conversationStore,
    provider: { async generate() { assert.fail('Recovery cannot execute providers') } } })
  t.after(() => resumed.shutdown())
  assert.equal(display(resumed).status, 'unknown'); assert.equal(display(resumed).effect, 'unreported')
})
