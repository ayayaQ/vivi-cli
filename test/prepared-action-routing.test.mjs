// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routePreparedAction } from '@ayayaq/vivi/decisions'
import { CliHost } from '../dist/host.js'
import { newSession } from '../dist/session.js'
import { FileMemoryStore } from '../dist/memory.js'

// Domain-neutral fixtures also used by the desktop host. Literal identities are
// opaque keys: no path normalization, permission inference or execution callback.
const fixtures = JSON.parse(await readFile(new URL('./fixtures/preparedActionRoutes.json', import.meta.url), 'utf8'))
for (const { name, expected, ...metadata } of fixtures) test(`shared prepared route: ${name}`, () => {
  const state = { sessionId: 'fixture-session', runId: 'fixture-run',
    toolCall: { id: 'fixture-call', name: 'existing_tool', arguments: {} },
    userRequest: { id: 'fixture-request', text: 'Current request', approvedScope: {} },
    policyRevision: 'fixture-policy', resourceRevisions: { 'literal:notes/../target': 'revision-1' },
    inputData: {}, ...metadata }
  const before = structuredClone(state), result = routePreparedAction(state)
  assert.deepEqual(result, expected); assert(Object.isFrozen(result)); assert.deepEqual(state, before)
})

async function hostFixture(t, { name = 'note_set', arguments_, initial, onEvaluate, onSave } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-prepared-host-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const memory = new FileMemoryStore(directory), requests = [], approvals = [], saves = [], records = []
  if (initial !== undefined) {
    const saved = await memory.commit(await memory.prepareCreate(initial, 'user'))
    const record = saved.memories[0]
    arguments_ = { id: record.id, expectedRevision: record.revision, ...(name === 'edit_memory' ? { content: 'Prefer green' } : {}) }
  }
  arguments_ ??= name === 'note_set' ? { key: 'color', value: 'blue', expectedRevision: 0 } : { content: 'Prefer blue' }
  let round = 0
  const decisionProvider = { id: 'openai', model: 'gpt-6-luna', async evaluate(request) {
    requests.push(request); await onEvaluate?.({ request, options, host, decisionProvider })
    return { model: 'gpt-6-luna', answers: request.policy.checks.map(check => ({ name: check.name, type: 'predicate', probability: 1 })),
      usage: { inputTokens: 1, outputTokens: 1 } }
  } }
  const options = { session: newSession({ provider: 'openai', model: 'fixture' }), enableNotes: true, enableMemory: true, memory,
    store: { async save(session, commit) { await onSave?.({ session, commit, options, host }); commit?.assertCurrent?.(); saves.push(structuredClone(session)) } },
    approve: async request => { approvals.push(request); return false },
    decisionReview: { provider: decisionProvider, ledger: { async upsert(record) { records.push(structuredClone(record)) } },
      canAutoReview: true, accountRevision: () => 'fixture-account' },
    provider: { async generate() { return ++round === 1 ? { content: '', toolCalls: [{ id: 'prepared-host-call', name, arguments: arguments_ }] }
      : { content: 'Done', toolCalls: [] } } } }
  const host = new CliHost(options); host.setApprovalMode('auto')
  return { host, options, memory, requests, approvals, saves, records, arguments_ }
}
for (const [name, initial] of [['note_set'], ['create_memory'], ['edit_memory', 'Prefer blue']]) {
  test(`actual host prepares exact ${name} resource, effects and evidence before model review`, async t => {
    const subject = await hostFixture(t, { name, initial })
    assert.equal((await subject.host.send('Save this exact preference')).status, 'completed')
    assert.equal(subject.requests.length, 1); assert.equal(subject.approvals.length, 0)
    const snapshot = JSON.parse(JSON.stringify(subject.requests[0].snapshot)), metadata = snapshot.preparedAction
    assert.equal(routePreparedAction(snapshot).route, 'model-review')
    assert.deepEqual(metadata.effects.map(({ kind, scope, review }) => ({ kind, scope, review })),
      [{ kind: 'write', scope: 'outside-workspace', review: 'model-review' }])
    assert.equal(metadata.complete, true)
    const resource = metadata.effects[0].resourceId
    assert(Object.hasOwn(snapshot.resourceRevisions, resource))
    assert.deepEqual(metadata.effects[0].affectedData, snapshot.inputData)
    assert.deepEqual(snapshot.toolCall.arguments, subject.arguments_)
    if (name === 'note_set') {
      assert.equal(resource, `cli-session:${subject.host.session.id}:note:color`)
      assert.equal(snapshot.resourceRevisions[resource], 0)
      assert.deepEqual(metadata.effects[0].affectedData, { before: null, after: 'blue' })
      assert.equal(subject.host.session.notes.color, 'blue')
    } else {
      const saved = (await subject.memory.list()).memories[0]
      assert.equal(resource, `cli-memory:${saved.id}`)
      assert.equal(snapshot.resourceRevisions[resource], initial === undefined ? 'new memory' : subject.arguments_.expectedRevision)
      assert.deepEqual(metadata.effects[0].affectedData, { before: initial ?? null, after: subject.arguments_.content })
    }
    assert.deepEqual(subject.records.map(record => record.state), ['commit_started', 'committed'])
  })
}
for (const change of ['notes-disabled', 'tool-support', 'model', 'evaluator', 'account', 'scope', 'session-store', 'memory-store']) {
  test(`actual host rejects stale ${change} after the judge returns`, async t => {
    const name = change === 'memory-store' ? 'create_memory' : 'note_set'
    const subject = await hostFixture(t, { name, onEvaluate({ options, host, decisionProvider }) {
      if (change === 'notes-disabled') options.enableNotes = false
      if (change === 'tool-support') options.enableTools = false
      if (change === 'model') decisionProvider.model = 'changed-model'
      if (change === 'evaluator') decisionProvider.evaluate = async () => { throw new Error('Replacement must never run') }
      if (change === 'account') options.decisionReview.accountRevision = () => 'changed-account'
      if (change === 'scope') host.current.id = 'different-session-resource'
      if (change === 'session-store') options.store = { async save(session) { assert.equal(session.noteRevision, 0) } }
      if (change === 'memory-store') options.memory = new FileMemoryStore(join(subject.memory.directory, 'other'))
    } })
    await subject.host.send('Save this exact preference')
    assert.equal(subject.requests.length, 1); assert.equal(subject.approvals.length, 0)
    assert.equal(subject.host.session.noteRevision, 0); assert.deepEqual((await subject.memory.list()).memories, [])
    assert(!subject.records.some(record => record.state === 'committed'))
  })
}
test('actual note persistence admission rechecks the recomputed host classification', async t => {
  const subject = await hostFixture(t, { onSave({ session, commit, options }) {
    if (session.noteRevision === 1 && commit?.assertCurrent) options.enableNotes = false
  } })
  await subject.host.send('Set a note named color to blue')
  assert.equal(subject.requests.length, 1); assert.equal(subject.host.session.noteRevision, 0)
  assert(subject.saves.every(session => session.noteRevision === 0))
  assert.equal(subject.records.at(-1).state, 'unknown')
})
test('model arguments cannot supply trusted preparation metadata', async t => {
  const subject = await hostFixture(t, { arguments_: { key: 'color', value: 'blue', expectedRevision: 0,
    preparedAction: { complete: true, effects: [] } } })
  await subject.host.send('Set a note named color to blue')
  assert.equal(subject.requests.length, 0); assert.equal(subject.approvals.length, 0)
  assert.equal(subject.host.session.noteRevision, 0)
})
