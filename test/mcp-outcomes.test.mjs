// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, chmod, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpDigest } from '@ayayaq/vivi/extensions/mcp'
import { FileMcpOutcomeStore, MAX_MCP_OUTCOME_ROWS, reconcileMcpOutcomes, unresolvedMcpResult, unattemptedMcpResult, validateMcpOutcomes } from '../dist/mcp-outcomes.js'
import { FileSessionStore, newSession } from '../dist/session.js'

const call = { id: 'call-exact', name: 'mcp_fixture_exact', arguments: { value: 'ordinary' } }
function row(sessionId = randomUUID(), input = {}) {
  return { id: randomUUID(), sessionId, runId: randomUUID(), callId: call.id, toolName: call.name,
    callDigest: mcpDigest(call), bindingDigest: mcpDigest({ exactOperation: 'captured' }), state: 'intent', ...input }
}
const history = (call_ = call, content = 'generic cancellation') => [
  { kind: 'assistant', content: '', toolCalls: [call_] },
  { kind: 'tool_result', callId: call_.id, name: call_.name, content, isError: true }
]
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-outcomes-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  return { directory, store: new FileMcpOutcomeStore(directory), sessionId: randomUUID() }
}

test('durable standalone intent is recovered as uncertainty without any approval or request capability', async t => {
  const { directory, store, sessionId } = await fixture(t)
  const entry = row(sessionId)
  await store.save(sessionId, [entry])
  const restored = await new FileMcpOutcomeStore(directory).load(sessionId)
  assert.deepEqual(restored, [entry])
  const result = JSON.parse(reconcileMcpOutcomes(history(), sessionId, restored)[1].content)
  assert.equal(result.unknownOutcome, true); assert.equal(result.doNotRetry, true)
  assert.equal(result.requestSent, undefined)
  assert.deepEqual(Object.keys(restored[0]).sort(), Object.keys(entry).sort())
})

for (const result of [unattemptedMcpResult(), unresolvedMcpResult(), {
  content: JSON.stringify({ success: true, method: 'tools/call', requestSent: true, doNotRetry: true, content: [{ type: 'text', text: 'CONFIRMED' }] })
}]) test(`settled exact outcomes persist without a generic cancellation overwrite: ${result.content.slice(0, 35)}`, async t => {
  const { store, sessionId } = await fixture(t)
  const entry = row(sessionId, { state: 'settled', result })
  await store.save(sessionId, [entry]); const restored = await store.load(sessionId)
  assert.deepEqual(reconcileMcpOutcomes(history(), sessionId, restored)[1], {
    kind: 'tool_result', callId: call.id, name: call.name, ...result
  })
})

for (const difference of [ { id: 'other-call' }, { name: 'mcp_other_alias' }, { arguments: { value: 'changed' } } ]) test(`exact canonical binding does not adopt another call: ${Object.keys(difference)}`, () => {
  const entry = row(), messages = history({ ...call, ...difference }, JSON.stringify({ source: 'mcp', requestSent: true }))
  assert.deepEqual(reconcileMcpOutcomes(messages, entry.sessionId, [entry]), messages)
})

test('a forged result.source cannot establish identity or relabel a non-MCP call', () => {
  const entry = row(), foreign = { id: 'foreign', name: 'ordinary_local', arguments: {} }
  const messages = history(foreign, JSON.stringify({ source: 'mcp', unknownOutcome: true }))
  assert.deepEqual(reconcileMcpOutcomes(messages, entry.sessionId, [entry]), messages)
})

for (const result of [unattemptedMcpResult(), { content: JSON.stringify({ requestSent: true, doNotRetry: true, success: true, content: [], method: 'tools/call' }) }]) test('a completed canonical checkpoint survives an independently failed outcome update', () => {
  const entry = row(), messages = history(call, result.content)
  assert.equal(reconcileMcpOutcomes(messages, entry.sessionId, [entry])[1].content, result.content)
})

test('actual session reload closes interrupted pairs and reconciles standalone intent', async t => {
  const { directory, store, sessionId } = await fixture(t)
  const sessionStore = new FileSessionStore(directory), session = newSession({ provider: 'openai', model: 'fixture' })
  session.id = sessionId; session.history = history().slice(0, 1)
  await sessionStore.save(session); await store.save(sessionId, [row(sessionId)])
  const restored = await sessionStore.load(sessionId)
  assert.equal(restored.history.length, 2); assert.equal(restored.history[1].callId, call.id)
  assert.equal(JSON.parse(restored.history[1].content).unknownOutcome, true)
})

test('full admitted 64KiB result content and outcome flags survive standalone reload', async t => {
  const { store, sessionId } = await fixture(t)
  const prefix = '{"requestSent":true,"doNotRetry":true,"confirmedOutcome":true,"text":"', suffix = '"}'
  const content = prefix + 'x'.repeat(65536 - prefix.length - suffix.length) + suffix
  await store.save(sessionId, [row(sessionId, { state: 'settled', result: { content } })])
  const restored = await store.load(sessionId)
  assert.equal(restored[0].result.content, content)
  const body = JSON.parse(reconcileMcpOutcomes(history(), sessionId, restored)[1].content)
  assert.equal(body.requestSent, true); assert.equal(body.doNotRetry, true); assert.equal(body.confirmedOutcome, true)
})

test('bounds, duplicates and malformed/accessor metadata fail closed', async t => {
  const { store, sessionId } = await fixture(t)
  const valid = row(sessionId)
  const oversized = Array.from({ length: MAX_MCP_OUTCOME_ROWS + 1 }, (_, index) => row(sessionId, { callId: `call-${index}` }))
  assert.throws(() => validateMcpOutcomes(sessionId, oversized))
  assert.throws(() => validateMcpOutcomes(sessionId, [valid, valid]))
  assert.throws(() => validateMcpOutcomes(sessionId, [row(sessionId, { state: 'intent', result: undefined })]))
  let invoked = false
  const getter = { ...valid }; Object.defineProperty(getter, 'callId', { enumerable: true, get() { invoked = true; return call.id } })
  assert.throws(() => validateMcpOutcomes(sessionId, [getter])); assert.equal(invoked, false)
  assert.throws(() => store.save(sessionId, [row(sessionId, { state: 'settled', result: { content: 'x'.repeat(65537) } })]))
  assert.deepEqual(await store.load(sessionId), [])
})

for (const value of ['fixture-known-secret', 'fixture%2Dknown%2Dsecret invalid-%', 'fixture\\u002dknown\\u002dsecret']) test('every field and encoded result is screened before persistence', async t => {
  const { directory, sessionId } = await fixture(t), store = new FileMcpOutcomeStore(directory, ['fixture-known-secret'])
  await assert.rejects(store.save(sessionId, [row(sessionId, { state: 'settled', result: { content: JSON.stringify({ nested: value }) } })]), /known credential/)
  await assert.rejects(store.save(sessionId, [row(sessionId, { callId: value })]), /known credential/)
  assert.deepEqual(await store.load(sessionId), [])
})

test('late guard failure preserves prior durable intent and cannot publish an outcome', async t => {
  const { store, sessionId } = await fixture(t), entry = row(sessionId)
  await store.save(sessionId, [entry])
  let guards = 0
  await assert.rejects(store.save(sessionId, [{ ...entry, state: 'settled', result: unattemptedMcpResult() }], {
    assertCurrent() { if (++guards >= 3) throw new Error('became stale') }
  }), /became stale/)
  assert.deepEqual(await store.load(sessionId), [entry])
})

test('symlink and nonprivate ledger files are rejected without reading their contents', async t => {
  const { directory, store, sessionId } = await fixture(t)
  const target = join(directory, `${sessionId}.mcp-outcomes.json`), foreign = join(directory, 'foreign.json')
  await writeFile(foreign, '[]', { mode: 0o600 }); await symlink(foreign, target)
  await assert.rejects(store.load(sessionId), /private regular/)
  await assert.rejects(store.save(sessionId, [row(sessionId)]), /unsafe/)
  assert.equal(await readFile(foreign, 'utf8'), '[]')
  await rm(target); await store.save(sessionId, [row(sessionId)])
  if (process.platform !== 'win32') { await chmod(target, 0o644); await assert.rejects(store.load(sessionId), /private regular/) }
})

test('accepted pre-execution calls recover as definite no-send without an uncertain-effects claim', async t => {
  const { store, sessionId } = await fixture(t)
  await store.save(sessionId, [row(sessionId, { state: 'accepted' })])
  const body = JSON.parse(reconcileMcpOutcomes(history(), sessionId, await store.load(sessionId))[1].content)
  assert.equal(body.requestSent, false); assert.equal(body.unknownOutcome, undefined); assert.equal(body.doNotRetry, undefined)
})

test('two calls sharing an alias preserve exact independent outcomes and ordered pairs', () => {
  const sessionId = randomUUID(), second = { ...call, id: 'second-call', arguments: { value: 'second' } }
  const records = [row(sessionId, { state: 'settled', result: unresolvedMcpResult() }),
    row(sessionId, { callId: second.id, callDigest: mcpDigest(second), state: 'accepted' })]
  const messages = [{ kind: 'assistant', content: '', toolCalls: [call, second] },
    { kind: 'tool_result', callId: call.id, name: call.name, content: 'cancelled' },
    { kind: 'tool_result', callId: second.id, name: second.name, content: 'cancelled' }]
  const result = reconcileMcpOutcomes(messages, sessionId, records)
  assert.equal(result[1].callId, call.id); assert.equal(JSON.parse(result[1].content).unknownOutcome, true)
  assert.equal(result[2].callId, second.id); assert.equal(JSON.parse(result[2].content).requestSent, false)
})

test('privacy identity rewrite bridge reconciles either side of an interrupted two-file checkpoint', async t => {
  const { directory, store, sessionId } = await fixture(t)
  const original = { id: 'old-sensitive-call-id', name: call.name, arguments: { value: 'later-sensitive-arguments' } }
  const canonical = { id: 'opaque-withheld-call-id', name: call.name, arguments: { mcpRequestWithheld: true, reason: 'known_credential' } }
  const result = { content: JSON.stringify({ success: true, requestSent: true, confirmedOutcome: true, doNotRetry: true, content: [] }) }
  const entry = row(sessionId, { callId: canonical.id, callDigest: mcpDigest(canonical), recoveryCallDigest: mcpDigest(original), state: 'settled', result })
  await store.save(sessionId, [entry])
  for (const current of [original, canonical]) {
    const reconciled = reconcileMcpOutcomes(history(current), sessionId, await store.load(sessionId))
    assert.equal(reconciled[1].callId, current.id); assert.equal(reconciled[1].content, result.content)
  }
  const sessionStore = new FileSessionStore(directory), session = newSession({ provider: 'openai', model: 'fixture' })
  session.id = sessionId; session.history = history(original).slice(0, 1)
  await sessionStore.save(session)
  assert.equal((await sessionStore.load(sessionId)).history[1].content, result.content)
  assert.equal(reconcileMcpOutcomes(history({ ...original, id: 'other-id' }), sessionId, [entry])[1].content, 'generic cancellation')
})

test('ambiguous canonical/original digest binding fails closed rather than selecting the first row', () => {
  const sessionId = randomUUID(), first = row(sessionId)
  const second = row(sessionId, { callId: 'other-opaque-id', callDigest: mcpDigest({ ...call, id: 'other-opaque-id' }), recoveryCallDigest: first.callDigest })
  assert.throws(() => reconcileMcpOutcomes(history(), sessionId, [first, second]), /Invalid MCP outcome evidence/)
})
