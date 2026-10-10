// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliConversationCommitError, CliConversationRecords, FileCliConversationStore,
  replayCliConversationDocument } from '../dist/conversation-records.js'
import { FileSessionStore, newSession, validateSession } from '../dist/session.js'

// Ordinary, bounded offline coverage only. File cases use our own private temp
// directories and regular files. Fault injection stays in inert memory stores;
// none of the historical restricted filesystem, native UI or live-provider
// assessments are invoked by this suite.
const settings = { provider: 'openai', model: 'offline-record-fixture' }
const usage = () => ({ inputTokens: 3, outputTokens: 2, totalTokens: 7, cachedInputTokens: 0 })
const sha256 = body => createHash('sha256').update(body).digest('hex')
const encoded = value => `${JSON.stringify(value)}\n`
const copy = value => structuredClone(value)

function legacySession(overrides = {}) {
  return validateSession({ ...newSession(settings), title: 'Original display title', titleRevision: 4,
    reasoning: 'high', noteRevision: 3, notes: { project: 'Original note' },
    history: [{ kind: 'message', role: 'user', content: 'Original input' },
      { kind: 'assistant', content: 'Original answer', toolCalls: [],
        providerState: { provider: 'offline', items: [{ opaque: 'retained data' }] } }],
    usage: { inputTokens: 8, outputTokens: 3, totalTokens: 15, cachedInputTokens: 0 }, ...overrides })
}

class MemoryConversationStore {
  current
  writes = []
  writeCalls = 0
  readCalls = 0
  fault
  constructor(value) { if (value !== undefined) this.replace(value) }
  replace(value) { this.current = { value: copy(value), digest: sha256(encoded(value)) } }
  async read() { this.readCalls++; return copy(this.current) }
  async write(sessionId, value, expectedDigest, assertCurrent) {
    this.writeCalls++
    assert.equal(value.sessionId, sessionId)
    if ((this.current?.digest ?? null) !== expectedDigest) throw new Error('Inert lease changed')
    assertCurrent()
    const fault = this.fault
    this.fault = undefined
    if (fault === 'before-write') throw new Error('Inert failure before commit')
    const next = copy(value)
    if (fault === 'different-anchor') next.records[0].eventId = randomUUID()
    if (fault === 'different-metadata') next.legacy.title = 'Different complete envelope'
    this.replace(next)
    this.writes.push(copy(next))
    if (fault === 'durability') throw new CliConversationCommitError(new Error('Inert fsync confirmation failed'))
    if (fault) throw new Error('Inert ambiguous commit result')
    return this.current.digest
  }
}

async function initialized(session = legacySession(), store = new MemoryConversationStore(), secrets = []) {
  const notices = []
  const owner = new CliConversationRecords(session.id, store, secrets, message => notices.push(message))
  await owner.initialize(session, [])
  assert.equal(owner.view.state, 'shadow')
  return { owner, store, session, notices }
}

async function settledFixture(store = new MemoryConversationStore()) {
  const fixture = await initialized(legacySession(), store)
  const runId = randomUUID()
  const input = { ...fixture.session, history: [...fixture.session.history,
    { kind: 'message', role: 'user', content: 'New input' }] }
  await fixture.owner.begin(runId, input)
  const message = { kind: 'assistant', content: 'New answer', toolCalls: [] }
  await fixture.owner.accept(runId, { type: 'assistant_accepted', message, round: 1,
    usage: usage(), aggregateUsage: usage() })
  const result = { status: 'completed', history: [...input.history, message], content: message.content,
    rounds: 1, usage: usage() }
  const session = validateSession({ ...input, schemaVersion: 2,
    recordAnchor: { version: 1, eventId: fixture.owner.anchorEventId }, history: result.history,
    usage: { inputTokens: 11, outputTokens: 5, totalTokens: 22, cachedInputTokens: 0 } })
  await fixture.owner.settle(runId, result, session, [])
  assert.equal(fixture.owner.view.state, 'shadow')
  assert.equal(fixture.owner.view.observedSequence, 2)
  return { ...fixture, session, runId, result, document: copy((await store.read(session.id)).value) }
}

async function privateFiles(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-cli-record-recovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, store: new FileCliConversationStore(directory) }
}

function assertWithheld(owner, state = 'quarantined') {
  const view = owner.view
  assert.equal(view.state, state)
  assert.equal(Object.hasOwn(view, 'projection'), false)
  assert.equal(Object.hasOwn(view, 'runs'), false)
  assert.equal(owner.anchorEventId, undefined)
}

test('ordinary private regular-file storage round-trips exact bytes, digest and ownership', async t => {
  const { directory, store } = await privateFiles(t)
  const session = legacySession()
  assert.equal(await store.read(session.id), undefined)
  const { owner } = await initialized(session, store)
  const path = join(directory, `${session.id}.records.json`)
  const body = await readFile(path, 'utf8')
  const stored = await new FileCliConversationStore(directory).read(session.id)
  assert.equal(stored.digest, sha256(body))
  assert.equal(body, encoded(stored.value))
  assert.deepEqual(stored.value.legacy, session)
  assert.equal(owner.view.committedSequence, 1)
  assert.equal(owner.view.durability, 'disk')
  assert.ok((await lstat(path)).isFile())
  if (process.platform !== 'win32') {
    for (const [entry, mode] of [[directory, 0o700], [path, 0o600]]) {
      const info = await lstat(entry)
      assert.equal(info.mode & 0o777, mode)
      assert.equal(info.uid, process.getuid())
    }
  }
  assert.deepEqual(await readdir(directory), [`${session.id}.records.json`])
})

test('storage CAS compares exact existing bytes, including ordinary JSON whitespace changes', async t => {
  const { directory, store } = await privateFiles(t)
  const { session } = await initialized(legacySession(), store)
  const original = await store.read(session.id)
  const path = join(directory, `${session.id}.records.json`)
  const changedBytes = `${JSON.stringify(original.value, null, 2)}\n`
  await writeFile(path, changedBytes, { mode: 0o600 })
  const current = await store.read(session.id)
  assert.deepEqual(current.value, original.value)
  assert.notEqual(current.digest, original.digest)
  await assert.rejects(store.write(session.id, original.value, original.digest, () => {}), /lease changed/)
  await assert.rejects(store.write(session.id, original.value, null, () => {}), /lease changed/)
  assert.equal(await readFile(path, 'utf8'), changedBytes)
  const digest = await store.write(session.id, original.value, current.digest, () => {})
  assert.equal(digest, sha256(encoded(original.value)))
  assert.deepEqual(await readdir(directory), [`${session.id}.records.json`])
})

test('late storage guard rejection leaves the original checkpoint and cleans its temp file', async t => {
  const { directory, store } = await privateFiles(t)
  const { session } = await initialized(legacySession(), store)
  const original = await store.read(session.id)
  let guards = 0
  await assert.rejects(store.write(session.id, original.value, original.digest, () => {
    if (++guards >= 3) throw new Error('Ordinary fixture guard became stale')
  }), /guard became stale/)
  assert.ok(guards >= 3)
  assert.deepEqual(await store.read(session.id), original)
  assert.deepEqual(await readdir(directory), [`${session.id}.records.json`])
})

test('schema-1 import retains metadata, original identities, opaque state and aggregate omission/zero', async () => {
  for (const aggregate of [{ inputTokens: 8, outputTokens: 3, totalTokens: 15 },
    { inputTokens: 8, outputTokens: 3, totalTokens: 15, cachedInputTokens: 0, cacheWriteInputTokens: 0 }]) {
    const session = legacySession({ usage: aggregate })
    const original = copy(session)
    const { owner, store } = await initialized(session)
    const replayed = replayCliConversationDocument(store.current.value)
    assert.deepEqual(session, original)
    assert.deepEqual(replayed.document.legacy, original)
    assert.deepEqual(replayed.projection.usage, aggregate)
    assert.deepEqual(replayed.projection.history.map(entry => entry.message), original.history)
    assert.deepEqual(replayed.projection.history.map(entry => entry.id), ['cli-history:0', 'cli-history:1'])
    assert.deepEqual(replayed.projection.history.map(entry => entry.source.reference),
      original.history.map((_, index) => `cli-session:${original.id}:history:${index}`))
    assert.deepEqual(replayed.projection.runs, [])
    assert.deepEqual(replayed.runs, [])
    assert.equal(replayed.document.records[0].reason, 'legacy_import')
    assert.equal(owner.anchorEventId, replayed.document.records[0].eventId)
  }
})

test('validated schema-2 canonical anchor round-trips separately without reimporting legacy metadata', async t => {
  const { directory, store } = await privateFiles(t)
  const original = legacySession()
  const { owner } = await initialized(original, store)
  const anchored = validateSession({ ...original, schemaVersion: 2,
    recordAnchor: { version: 1, eventId: owner.anchorEventId }, title: 'Later display title',
    titleRevision: 5, noteRevision: 4, notes: { project: 'Later note' } })
  const canonical = new FileSessionStore(directory)
  await canonical.save(anchored)
  const loaded = await canonical.load(original.id)
  assert.deepEqual(loaded, anchored)
  const before = await store.read(original.id)
  const resumed = new CliConversationRecords(original.id, new FileCliConversationStore(directory))
  await resumed.initialize(loaded, [])
  assert.equal(resumed.view.state, 'shadow')
  assert.equal(resumed.anchorEventId, anchored.recordAnchor.eventId)
  assert.equal(resumed.view.committedSequence, 1)
  assert.deepEqual(await store.read(original.id), before)
  assert.deepEqual(before.value.legacy, original)
})

test('schema-2 requires a supported explicit anchor and schema-1 cannot contain one', () => {
  const session = legacySession()
  assert.throws(() => validateSession({ ...session, schemaVersion: 2 }), /requires a record anchor/)
  assert.throws(() => validateSession({ ...session, schemaVersion: 2,
    recordAnchor: { version: 2, eventId: 'offline-anchor' } }), /invalid record anchor/)
  assert.throws(() => validateSession({ ...session,
    recordAnchor: { version: 1, eventId: 'offline-anchor' } }), /schema-1/)
})

test('repeated initialization and full replay are idempotent without doubled history or usage', async () => {
  const { owner, store, session } = await initialized()
  const original = copy(store.current)
  await Promise.all([owner.initialize(session, []), owner.initialize(session, [])])
  assert.equal(store.writeCalls, 1)
  assert.deepEqual(store.current, original)
  const document = copy(original.value)
  document.records.push(copy(document.records[0]))
  const replayed = replayCliConversationDocument(document)
  assert.equal(replayed.projection.sequence, 1)
  assert.equal(replayed.projection.receipts.length, 1)
  assert.deepEqual(replayed.projection.usage, session.usage)
  assert.deepEqual(replayed.projection.history.map(entry => entry.message), session.history)
})

test('settled full session/run replay is idempotent including exact duplicate old frames', async () => {
  const { owner, document, session } = await settledFixture()
  const expected = owner.view
  const duplicate = copy(document)
  duplicate.records.splice(1, 0, copy(duplicate.records[0]))
  duplicate.records.push(copy(duplicate.records.at(-1)))
  duplicate.runs[0].records.splice(2, 0, copy(duplicate.runs[0].records[1]))
  duplicate.runs[0].records.push(copy(duplicate.runs[0].records.at(-1)))
  const replayed = replayCliConversationDocument(duplicate)
  assert.deepEqual(replayed.projection, expected.projection)
  assert.deepEqual(replayed.runs, expected.runs)
  assert.equal(replayed.projection.receipts.length, 2)
  assert.equal(replayed.runs[0].receipts.length, 3)
  assert.deepEqual(replayed.projection.usage, session.usage)
})

test('ordinary settled file checkpoint restores its full session and exact retained run chain', async t => {
  const { directory, store } = await privateFiles(t)
  const { owner, session, document, runId } = await settledFixture(store)
  const canonical = new FileSessionStore(directory)
  await canonical.save(session)
  const restored = new CliConversationRecords(session.id, new FileCliConversationStore(directory))
  await restored.initialize(await canonical.load(session.id), [])
  assert.deepEqual(restored.view, owner.view)
  assert.equal(restored.view.runs[0].state, 'settled')
  assert.equal(restored.view.runs[0].runId, runId)
  assert.equal(restored.view.committedSequence, 2)
  assert.deepEqual((await store.read(session.id)).value, document)
  assert.deepEqual(document.legacy.notes, { project: 'Original note' })
  assert.equal(document.legacy.schemaVersion, 1)
})

test('a serialized owner drains an admitted write before later accepted data uses its lease', async () => {
  const store = new MemoryConversationStore()
  const { owner, session } = await initialized(legacySession(), store)
  let release, entered
  const ready = new Promise(resolve => { entered = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const write = store.write.bind(store)
  const leases = []
  let active = 0, maximumActive = 0
  store.write = async (...args) => {
    maximumActive = Math.max(maximumActive, ++active)
    leases.push(args[2])
    try {
      if (leases.length === 1) { entered(); await blocked }
      return await write(...args)
    } finally { active-- }
  }
  const oldDigest = store.current.digest
  const runId = randomUUID()
  const input = { ...session, history: [...session.history,
    { kind: 'message', role: 'user', content: 'Queued input' }] }
  const message = { kind: 'assistant', content: 'Queued accepted answer', toolCalls: [] }
  const begin = owner.begin(runId, input)
  const accepted = owner.accept(runId, { type: 'assistant_accepted', message, round: 1,
    usage: usage(), aggregateUsage: usage() })
  await ready
  assert.equal(active, 1)
  assert.equal(leases.length, 1)
  assert.equal(owner.view.committedSequence, 1)
  release()
  await Promise.all([begin, accepted, owner.drain()])
  assert.equal(maximumActive, 1)
  assert.equal(active, 0)
  assert.equal(leases[0], oldDigest)
  assert.equal(leases[1], sha256(encoded(store.writes[1])))
  assert.deepEqual(replayCliConversationDocument(store.current.value).runs[0].history.at(-1).message, message)
})

test('exact ambiguous committed write is acknowledged by readback without retrying append', async () => {
  const store = new MemoryConversationStore()
  store.fault = 'after-write'
  const { owner, session } = await initialized(legacySession(), store)
  assert.equal(store.writeCalls, 1)
  assert.ok(store.readCalls >= 2)
  assert.equal(owner.view.observedSequence, 1)
  assert.equal(owner.view.committedSequence, 1)
  assert.deepEqual(owner.view.projection.history.map(entry => entry.message), session.history)
})

for (const fault of ['before-write', 'different-anchor', 'different-metadata']) {
  test(`ambiguous ${fault} readback cannot acknowledge a different checkpoint`, async () => {
    const session = legacySession()
    const store = new MemoryConversationStore()
    store.fault = fault
    const owner = new CliConversationRecords(session.id, store)
    await owner.initialize(session, [])
    assertWithheld(owner, fault === 'before-write' ? 'unavailable' : 'quarantined')
    assert.equal(owner.view.committedSequence, 0)
    assert.equal(owner.view.observedSequence, 1)
    assert.equal(store.writeCalls, fault === 'before-write' ? 1 : 2)
  })
}

test('failed terminal checkpoint keeps its earlier committed cursor and incomplete stored run', async () => {
  const { owner, store, session } = await initialized()
  const runId = randomUUID()
  const input = { ...session, history: [...session.history, { kind: 'message', role: 'user', content: 'New input' }] }
  await owner.begin(runId, input)
  const message = { kind: 'assistant', content: 'Accepted before storage failure', toolCalls: [] }
  await owner.accept(runId, { type: 'assistant_accepted', message, round: 1,
    usage: usage(), aggregateUsage: usage() })
  const before = copy(store.current)
  const result = { status: 'completed', history: [...input.history, message], content: message.content,
    rounds: 1, usage: usage() }
  const canonical = { ...input, history: result.history,
    usage: { inputTokens: 11, outputTokens: 5, totalTokens: 22, cachedInputTokens: 0 } }
  store.fault = 'before-write'
  await owner.settle(runId, result, canonical, [])
  assertWithheld(owner, 'unavailable')
  assert.equal(owner.view.observedSequence, 2)
  assert.equal(owner.view.committedSequence, 1)
  assert.deepEqual(store.current, before)
  const replayed = replayCliConversationDocument(before.value)
  assert.equal(replayed.projection.sequence, 1)
  assert.equal(replayed.runs[0].state, 'running')
  assert.deepEqual(replayed.runs[0].runUsage, usage())
})

test('explicit failed fsync confirmation after replacement retains the old committed cursor despite exact readable bytes', async () => {
  const { owner, store, session } = await initialized()
  const runId = randomUUID()
  const input = { ...session, history: [...session.history,
    { kind: 'message', role: 'user', content: 'Accepted input before inert fsync failure' }] }
  await owner.begin(runId, input)
  const message = { kind: 'assistant', content: 'Accepted answer before inert fsync failure', toolCalls: [] }
  await owner.accept(runId, { type: 'assistant_accepted', message, round: 1,
    usage: usage(), aggregateUsage: usage() })
  const committedRuns = copy(owner.view.committedRuns)
  assert.equal(committedRuns[0].sequence, 2)
  const oldDigest = store.current.digest
  const result = { status: 'completed', history: [...input.history, message], content: message.content,
    rounds: 1, usage: usage() }
  const canonical = { ...input, history: result.history,
    usage: { inputTokens: 11, outputTokens: 5, totalTokens: 22, cachedInputTokens: 0 } }
  store.fault = 'durability'
  await owner.settle(runId, result, canonical, [])
  assertWithheld(owner, 'unavailable')
  assert.equal(owner.view.observedSequence, 2)
  assert.equal(owner.view.committedSequence, 1)
  assert.equal(Object.hasOwn(owner.view, 'committedRuns'), false)
  assert.notEqual(store.current.digest, oldDigest)
  const readback = await store.read(session.id)
  const replayed = replayCliConversationDocument(readback.value)
  assert.equal(replayed.projection.sequence, 2)
  assert.equal(replayed.runs[0].state, 'settled')
  assert.deepEqual(replayed.projection.history.map(entry => entry.message), canonical.history)
  assert.equal(store.writeCalls, 4)
})

test('schema-2 missing shadow is quarantined instead of inventing another sequence-one anchor', async () => {
  const session = validateSession({ ...legacySession(), schemaVersion: 2,
    recordAnchor: { version: 1, eventId: 'missing-owned-anchor' } })
  const store = new MemoryConversationStore()
  const owner = new CliConversationRecords(session.id, store)
  await owner.initialize(session, [])
  assertWithheld(owner)
  assert.equal(owner.view.observedSequence, 0)
  assert.deepEqual(store.current.value, { schemaVersion: 1, sessionId: session.id,
    state: 'quarantined', previousDigest: null })
})

for (const change of ['history', 'usage', 'anchor']) {
  test(`changed canonical ${change} with a retained shadow withholds recovery`, async () => {
    const { session, owner, store } = await initialized()
    const canonical = validateSession({ ...session, schemaVersion: 2,
      recordAnchor: { version: 1, eventId: owner.anchorEventId } })
    if (change === 'history') canonical.history[0].content = 'Changed prefix'
    if (change === 'usage') canonical.usage.totalTokens++
    if (change === 'anchor') canonical.recordAnchor.eventId = 'different-owned-anchor'
    const previousDigest = store.current.digest
    const resumed = new CliConversationRecords(session.id, store)
    await resumed.initialize(canonical, [])
    assertWithheld(resumed)
    assert.equal(resumed.view.committedSequence, change === 'anchor' ? 0 : 1)
    assert.equal(store.current.value.previousDigest, previousDigest)
    assert.equal(Object.hasOwn(store.current.value, 'records'), false)
  })
}

const invalidChains = [
  ['erased session prefix', document => { document.records.shift() }],
  ['empty session chain', document => { document.records = [] }],
  ['changed legacy anchor payload', document => { document.records[0].snapshot.history[0].message.content = 'Changed original' }],
  ['session gap', document => { document.records[1].sequence++ }],
  ['wrong session predecessor', document => { document.records[1].previousEventId = 'wrong-predecessor' }],
  ['conflicting old event', document => { document.records.push({ ...copy(document.records[0]), source: { reference: 'different-source' } }) }],
  ['missing run start', document => { document.runs[0].records.shift() }],
  ['missing run terminal', document => { document.runs[0].records.pop() }],
  ['missing complete run chain', document => { document.runs = [] }],
  ['uncommitted run terminal', document => { document.records.pop() }],
  ['changed run baseline receipt', document => { document.runs[0].records[0].baseReceiptDigest = 'a'.repeat(64) }],
  ['unknown envelope version', document => { document.schemaVersion = 99 }],
  ['unknown session record version', document => { document.records[0].version = 99 }],
  ['unknown run record version', document => { document.runs[0].records[1].version = 99 }]
]

for (const [label, corrupt] of invalidChains) {
  test(`${label} fails atomic replay and quarantines stored recovery without an empty fallback`, async () => {
    const { document, session } = await settledFixture()
    corrupt(document)
    const before = copy(document)
    assert.throws(() => replayCliConversationDocument(document))
    assert.deepEqual(document, before)
    const store = new MemoryConversationStore(document)
    const previousDigest = store.current.digest
    const owner = new CliConversationRecords(session.id, store)
    await owner.initialize(session, [])
    assertWithheld(owner)
    assert.equal(owner.view.committedSequence, 0)
    assert.deepEqual(store.current.value, { schemaVersion: 1, sessionId: session.id,
      state: 'quarantined', previousDigest })
  })
}

test('ordinary malformed JSON bytes are replaced with a bounded quarantine, never empty history', async t => {
  const { directory, store } = await privateFiles(t)
  const session = legacySession()
  await writeFile(join(directory, `${session.id}.records.json`), '{incomplete-owned-fixture', { mode: 0o600 })
  const original = await store.read(session.id)
  const owner = new CliConversationRecords(session.id, store)
  await owner.initialize(session, [])
  assertWithheld(owner)
  assert.deepEqual((await store.read(session.id)).value, { schemaVersion: 1, sessionId: session.id,
    state: 'quarantined', previousDigest: original.digest })
})

test('stored prefix changes after initialization prevent accepting a new run', async () => {
  const { owner, session, store } = await initialized()
  const replacement = copy(store.current.value)
  replacement.legacy.title = 'Competing ordinary writer metadata'
  store.replace(replacement)
  const writes = store.writeCalls
  await owner.begin(randomUUID(), { ...session, history: [...session.history,
    { kind: 'message', role: 'user', content: 'New input' }] })
  assertWithheld(owner)
  assert.equal(owner.view.committedSequence, 1)
  assert.equal(store.writeCalls, writes + 1)
  assert.equal(store.current.value.state, 'quarantined')
  assert.equal(store.current.value.previousDigest, sha256(encoded(replacement)))
})

test('missing stored prefix after initialization cannot become an accepted disk checkpoint', async () => {
  const { owner, session, store } = await initialized()
  const previousDigest = store.current.digest
  store.current = undefined
  const writes = store.writeCalls
  await owner.begin(randomUUID(), { ...session, history: [...session.history,
    { kind: 'message', role: 'user', content: 'New input' }] })
  assertWithheld(owner)
  assert.equal(owner.view.committedSequence, 1)
  assert.equal(store.writeCalls, writes + 1)
  assert.equal(store.current.value.state, 'quarantined')
  assert.equal(store.current.value.previousDigest, previousDigest)
})

const secret = 'owned-offline-dummy-newly-known-secret'
const privacyCases = [
  ['display title', session => { session.title = secret }],
  ['notes', session => { session.notes.project = secret }],
  ['user payload', session => { session.history[0].content = secret }],
  ['opaque provider state', session => { session.history[1].providerState.items[0].opaque = secret }],
  ['tool arguments', session => {
    session.history[1].toolCalls = [{ id: 'ordinary-call', name: 'offline_tool', arguments: { value: secret } }]
    session.history.push({ kind: 'tool_result', callId: 'ordinary-call', name: 'offline_tool', content: 'Ordinary result' })
  }],
  ['immutable call identity', session => {
    session.history[1].toolCalls = [{ id: secret, name: 'offline_tool', arguments: {} }]
    session.history.push({ kind: 'tool_result', callId: secret, name: 'offline_tool', content: 'Ordinary result' })
  }],
  ['tool result payload', session => {
    session.history[1].toolCalls = [{ id: 'ordinary-call', name: 'offline_tool', arguments: {} }]
    session.history.push({ kind: 'tool_result', callId: 'ordinary-call', name: 'offline_tool', content: secret })
  }]
]

for (const [label, fill] of privacyCases) {
  test(`newly known dummy secret in ${label} is scrubbed from stored records and withheld across reload`, async t => {
    const { directory, store } = await privateFiles(t)
    const session = legacySession()
    fill(session)
    validateSession(session)
    const { owner } = await initialized(session, store)
    const path = join(directory, `${session.id}.records.json`)
    assert.ok((await readFile(path, 'utf8')).includes(secret))
    const resumed = new CliConversationRecords(session.id, new FileCliConversationStore(directory), [secret])
    await resumed.initialize({ ...session, schemaVersion: 2,
      recordAnchor: { version: 1, eventId: owner.anchorEventId } }, [])
    assertWithheld(resumed)
    const tombstone = await store.read(session.id)
    assert.equal(tombstone.value.state, 'quarantined')
    assert.equal(Object.hasOwn(tombstone.value, 'legacy'), false)
    for (const filename of await readdir(directory)) {
      assert.equal((await readFile(join(directory, filename), 'utf8')).includes(secret), false)
    }
    const again = new CliConversationRecords(session.id, store)
    await again.initialize(session, [])
    assertWithheld(again)
    assert.deepEqual(await store.read(session.id), tombstone)
  })
}

test('newly known secret in immutable original source identity quarantines before restored publication', async t => {
  const { store } = await privateFiles(t)
  const { session } = await initialized(legacySession(), store)
  const original = await store.read(session.id)
  const document = copy(original.value)
  document.records[0].snapshot.history[0].source.reference = `owned-source:${secret}`
  replayCliConversationDocument(document)
  await store.write(session.id, document, original.digest, () => {})
  const resumed = new CliConversationRecords(session.id, store, [secret])
  await resumed.initialize(session, [])
  assertWithheld(resumed)
  assert.equal(encoded((await store.read(session.id)).value).includes(secret), false)
})

test('learning a secret after admission withholds the next view immediately and scrubs on drain', async t => {
  const { directory, store } = await privateFiles(t)
  const secrets = []
  const session = legacySession({ notes: { project: secret } })
  const { owner } = await initialized(session, store, secrets)
  assert.equal(owner.view.state, 'shadow')
  secrets.push(secret)
  assertWithheld(owner)
  await owner.drain()
  assert.equal((await store.read(session.id)).value.state, 'quarantined')
  assert.equal((await readFile(join(directory, `${session.id}.records.json`), 'utf8')).includes(secret), false)
  const again = new CliConversationRecords(session.id, store, secrets)
  await again.initialize(session, [])
  assertWithheld(again)
})

test('a newly known immutable run identity cannot leak through committed-run watermarks before quarantine drains', async () => {
  const secrets = []
  const { owner, session, store } = await initialized(legacySession(), new MemoryConversationStore(), secrets)
  await owner.begin(secret, { ...session, history: [...session.history,
    { kind: 'message', role: 'user', content: 'Ordinary input for immutable identity fixture' }] })
  assert.equal(owner.view.state, 'shadow')
  assert.ok(encoded(store.current.value).includes(secret))
  secrets.push(secret)
  assertWithheld(owner)
  assert.equal(JSON.stringify(owner.view).includes(secret), false)
  await owner.drain()
  assert.equal(encoded(store.current.value).includes(secret), false)
  assert.equal(store.current.value.state, 'quarantined')
})

test('secret rejected at initial admission never publishes a projection or persists the secret', async () => {
  const session = legacySession({ title: secret })
  const store = new MemoryConversationStore()
  const owner = new CliConversationRecords(session.id, store, [secret])
  await owner.initialize(session, [])
  assertWithheld(owner)
  assert.equal(owner.view.committedSequence, 0)
  assert.equal(encoded(store.current.value).includes(secret), false)
  assert.equal(store.current.value.state, 'quarantined')
})

test('escaped dummy-secret payload is screened using its JSON spelling before publication', async () => {
  const escapedSecret = 'owned-dummy-quote"and\\slash\nsecret'
  const session = legacySession({ notes: { project: escapedSecret } })
  const { store } = await initialized(session)
  assert.equal(encoded(store.current.value).includes(escapedSecret), false)
  const owner = new CliConversationRecords(session.id, store, [escapedSecret])
  await owner.initialize(session, [])
  assertWithheld(owner)
  assert.equal(encoded(store.current.value).includes(JSON.stringify(escapedSecret).slice(1, -1)), false)
})

function inertProxy(value, touched) {
  return new Proxy(value, Object.fromEntries(['get', 'ownKeys', 'getPrototypeOf', 'getOwnPropertyDescriptor']
    .map(trap => [trap, () => { touched(); throw new Error(`An inert ${trap} trap must not run`) }])))
}

function inertGetter(object, key, touched) {
  Object.defineProperty(object, key, { enumerable: true, configurable: true,
    get() { touched(); throw new Error('An inert accessor must not run') } })
}

const invalidContainers = [
  ['envelope proxy', (document, touched) => inertProxy(document, touched)],
  ['nested legacy proxy', (document, touched) => { document.legacy = inertProxy(document.legacy, touched); return document }],
  ['record-array proxy', (document, touched) => { document.records = inertProxy(document.records, touched); return document }],
  ['nested accepted-message proxy', (document, touched) => {
    document.runs[0].records[1].entry.message = inertProxy(document.runs[0].records[1].entry.message, touched)
    return document
  }],
  ['envelope getter', (document, touched) => { inertGetter(document, 'sessionId', touched); return document }],
  ['metadata getter', (document, touched) => { inertGetter(document.legacy, 'title', touched); return document }],
  ['session-record getter', (document, touched) => { inertGetter(document.records[0], 'type', touched); return document }],
  ['retained-run getter', (document, touched) => { inertGetter(document.runs[0], 'records', touched); return document }],
  ['message-payload getter', (document, touched) => {
    inertGetter(document.records[0].snapshot.history[0].message, 'content', touched); return document
  }],
  ['record-array getter', (document, touched) => { inertGetter(document.records, '0', touched); return document }],
  ['toJSON callback', (document, touched) => { document.toJSON = () => { touched(); return {} }; return document }],
  ['custom envelope prototype', document => { Object.setPrototypeOf(document, { inherited: true }); return document }],
  ['custom array prototype', document => { Object.setPrototypeOf(document.records, {}); return document }],
  ['sparse record array', document => { delete document.records[0]; return document }],
  ['extra array field', document => { document.records.extra = 'inert unexpected field'; return document }],
  ['hidden field', document => { Object.defineProperty(document, 'hidden', { value: true }); return document }],
  ['symbol field', document => { document[Symbol('inert')] = 'inert unexpected field'; return document }],
  ['cyclic container', document => { document.cycle = document; return document }]
]

for (const [label, makeInvalid] of invalidContainers) {
  test(`inert ${label} is rejected before accessor/trap evaluation or restored publication`, async () => {
    const { document, session } = await settledFixture()
    let evaluations = 0
    const value = makeInvalid(document, () => { evaluations++ })
    assert.throws(() => replayCliConversationDocument(value))
    assert.equal(evaluations, 0)
    const digest = sha256('Inert untrusted container, never serialized')
    let written
    const store = {
      async read() { return { value, digest } },
      async write(id, next, expectedDigest, assertCurrent) {
        assert.equal(id, session.id)
        assert.equal(expectedDigest, digest)
        assertCurrent()
        written = copy(next)
        return sha256(encoded(next))
      }
    }
    const owner = new CliConversationRecords(session.id, store)
    await owner.initialize(session, [])
    assertWithheld(owner)
    assert.equal(evaluations, 0)
    assert.deepEqual(written, { schemaVersion: 1, sessionId: session.id,
      state: 'quarantined', previousDigest: digest })
  })
}

test('recovery of an incomplete accepted tool request is data-only and has no restored authority', async t => {
  let networkCalls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    networkCalls++
    throw new Error('Live networking is excluded from this offline fixture')
  })
  const { session, owner, store } = await initialized()
  const runId = randomUUID()
  const input = { ...session, history: [...session.history,
    { kind: 'message', role: 'user', content: 'Data-only request' }] }
  await owner.begin(runId, input)
  const message = { kind: 'assistant', content: '', toolCalls: [{ id: 'unexecuted-call',
    name: 'offline_never_execute', arguments: { approvalText: 'Stored text grants no approval' } }],
    providerState: { provider: 'offline', items: [{ approved: true, resource: 'opaque historical data' }] } }
  await owner.accept(runId, { type: 'assistant_accepted', message, round: 1,
    usage: usage(), aggregateUsage: usage() })
  const writes = store.writeCalls
  const restored = new CliConversationRecords(session.id, store)
  await restored.initialize(session, [])
  const view = restored.view
  assert.equal(view.state, 'shadow')
  assert.equal(view.committedSequence, 1)
  assert.equal(view.runs[0].state, 'running')
  assert.deepEqual(view.runs[0].history.at(-1).message, message)
  assert.deepEqual(view.runs[0].runUsage, usage())
  assert.deepEqual(view.projection.outcomes, [])
  assert.deepEqual(view.projection.history.map(entry => entry.message), session.history)
  for (const data of [view.projection, view.runs[0]]) {
    for (const capability of ['approve', 'approval', 'executeTool', 'provider', 'transport', 'retry', 'send']) {
      assert.equal(Object.hasOwn(data, capability), false)
    }
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(data)))
  }
  assert.equal(networkCalls, 0)
  assert.equal(store.writeCalls, writes)
})

test('returned record views are detached so a consumer cannot rewrite the owner or stored prefix', async () => {
  const { owner, store, session } = await initialized()
  const view = owner.view
  view.projection.history[0].message.content = 'Consumer-only mutation'
  view.projection.usage.totalTokens = 100
  assert.deepEqual(owner.view.projection.history.map(entry => entry.message), session.history)
  assert.deepEqual(owner.view.projection.usage, session.usage)
  assert.deepEqual(store.current.value.legacy.history, session.history)
})

test('memory-only shadow observes its anchor without claiming a durable disk acknowledgement', async () => {
  const session = legacySession()
  const owner = new CliConversationRecords(session.id)
  await owner.initialize(session, [])
  assert.equal(owner.view.state, 'shadow')
  assert.equal(owner.view.durability, 'memory')
  assert.equal(owner.view.observedSequence, 1)
  assert.equal(owner.view.committedSequence, 0)
  assert.deepEqual(owner.view.projection.usage, session.usage)
  assert.deepEqual(owner.view.projection.history.map(entry => entry.message), session.history)
})
