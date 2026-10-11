// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { FilePublicUrlOutcomeStore, validatePublicUrlOutcomes, reconcilePublicUrlOutcomes,
  publicUrlOutcomeResult, unattemptedPublicUrlResult, MAX_PUBLIC_URL_OUTCOME_ROWS } from '../dist/public-url-outcomes.js'
import { mcpDigest } from '@ayayaq/vivi/extensions/mcp'

const sessionId = randomUUID(), runId = randomUUID()
const call = { id: 'url-call', name: 'fetch_url', arguments: { url: 'https://example.com/selected' } }
function row(overrides = {}) { return { id: randomUUID(), sessionId, runId, callId: call.id, toolName: call.name,
  callDigest: mcpDigest(call), bindingDigest: createHash('sha256').update('binding').digest('hex'), state: 'intent', ...overrides } }
const history = () => [{ kind: 'assistant', content: '', toolCalls: [call] },
  { kind: 'tool_result', callId: call.id, name: call.name, content: 'Generic cancelled result', isError: true }]
async function store(t, secrets = []) {
  const root = await mkdtemp(join(tmpdir(), 'vivi-public-url-outcomes-')); t.after(() => rm(root, { recursive: true, force: true }))
  return { root, subject: new FilePublicUrlOutcomeStore(root, secrets) }
}
test('URL outcome evidence is detached closed JSON and contains no executable receipt', () => {
  const input = [row()], checked = validatePublicUrlOutcomes(sessionId, input)
  assert.deepEqual(checked, input); input[0].state = 'accepted'; assert.equal(checked[0].state, 'intent')
  assert.throws(() => validatePublicUrlOutcomes(sessionId, [row({ permit: true })]), /Invalid/)
  assert.throws(() => validatePublicUrlOutcomes(sessionId, [row({ approve: true })]), /Invalid/)
})
for (const overrides of [{ toolName: 'arbitrary_tool' }, { callId: '' }, { callDigest: 'invalid' },
  { bindingDigest: 'invalid' }, { sessionId: randomUUID() }, { runId: 'wrong' }, { state: 'unknown' },
  { result: { content: 'unexpected intent result' } }]) test(`invalid URL outcome record is refused: ${JSON.stringify(overrides)}`, () => {
  assert.throws(() => validatePublicUrlOutcomes(sessionId, [row(overrides)]))
})
test('duplicate occurrence IDs/digests and capacity overflow fail closed without eviction', () => {
  const first = row(); assert.throws(() => validatePublicUrlOutcomes(sessionId, [first, { ...first, id: randomUUID() }]))
  assert.throws(() => validatePublicUrlOutcomes(sessionId, Array.from({ length: MAX_PUBLIC_URL_OUTCOME_ROWS + 1 }, (_, index) =>
    row({ callId: `call-${index}`, callDigest: createHash('sha256').update(String(index)).digest('hex') }))))
})
test('settled result bytes and fields are bounded independently of text content', () => {
  assert.throws(() => validatePublicUrlOutcomes(sessionId, [row({ state: 'settled', result: { content: 'a'.repeat(65537) } })]))
  assert.throws(() => validatePublicUrlOutcomes(sessionId, [row({ state: 'settled', result: { content: '😀'.repeat(20000) } })]))
  assert.throws(() => validatePublicUrlOutcomes(sessionId, [row({ state: 'settled', result: { content: 'safe', approved: true } })]))
})
test('only matching canonical occurrence can receive unknown or settled recovery evidence', () => {
  const intent = row(), recovered = reconcilePublicUrlOutcomes(history(), sessionId, [intent])
  assert.equal(JSON.parse(recovered[1].content).unknownOutcome, true)
  assert.equal(JSON.parse(recovered[1].content).doNotRetry, true)
  const unrelated = row({ callDigest: createHash('sha256').update('other call').digest('hex') })
  assert.equal(reconcilePublicUrlOutcomes(history(), sessionId, [unrelated])[1].content, 'Generic cancelled result')
  const settled = row({ state: 'settled', result: unattemptedPublicUrlResult('approval_denied') })
  assert.deepEqual(reconcilePublicUrlOutcomes(history(), sessionId, [settled])[1], { kind: 'tool_result', callId: call.id, name: call.name, ...settled.result })
})
test('accepted evidence proves no HTTP attempt; intent proves only possible transmission', () => {
  assert.equal(JSON.parse(publicUrlOutcomeResult(row({ state: 'accepted' })).content).transmission, 'not_attempted')
  const unknown = JSON.parse(publicUrlOutcomeResult(row()).content)
  assert.equal(unknown.transmission, 'unknown'); assert.equal(unknown.serverEffects, 'unknown'); assert.equal(unknown.success, false)
})
test('private fsynced sidecar roundtrip is evidence-only and survives a transcript failure', async t => {
  const { subject, root } = await store(t), evidence = [row()]
  await subject.save(sessionId, evidence); assert.deepEqual(await subject.load(sessionId), evidence)
  const contents = await readFile(join(root, `${sessionId}.public-url-outcomes.json`), 'utf8')
  assert(!contents.includes('https://')); assert(!contents.includes('approve')); assert.equal(JSON.parse(contents)[0].state, 'intent')
})
test('guard revocation during queued persistence cannot overwrite prior evidence', async t => {
  const { subject } = await store(t), evidence = [row()]
  await subject.save(sessionId, evidence)
  let guards = 0
  await assert.rejects(subject.save(sessionId, [row({ state: 'settled', result: unattemptedPublicUrlResult() })],
    { assertCurrent() { if (++guards > 2) throw new Error('stale receipt') } }), /stale/)
  assert.deepEqual(await subject.load(sessionId), evidence); await subject.drain()
})
test('full evidence screening blocks raw, escaped, percent and HTML-entity known secret values', async t => {
  const marker = 'fixture-private-marker', { subject } = await store(t, [marker])
  for (const content of [marker, [...marker].map(point => `\\u${point.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
    [...Buffer.from(marker)].map(byte => `%${byte.toString(16)}`).join(''), [...marker].map(point => `&#${point.charCodeAt(0)};`).join('')]) {
    await assert.rejects(subject.save(sessionId, [row({ state: 'settled', result: { content } })]), /known credential/)
  }
  assert.deepEqual(await subject.load(sessionId), [])
})
test('missing URL sidecar is an empty evidence set and creates no send authority', async t => {
  const { subject } = await store(t); assert.deepEqual(await subject.load(sessionId), [])
  assert.throws(() => validatePublicUrlOutcomes('arbitrary-filename', []))
})
