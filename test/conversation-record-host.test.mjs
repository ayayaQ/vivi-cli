// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test as nodeTest } from 'node:test'
import { AGENT_RECORD_LIMITS, agentArgumentsDigest, applyAgentRecord, createAgentProjection, projectAgentRecords } from '@ayayaq/vivi/events'
import { applyAgentRunRecord, assertAgentRunCurrent, createAgentRunProjection, projectAgentRunRecords } from '@ayayaq/vivi/events/stream'
import { assertMcpJson, assertMcpOperationCurrent, emptyMcpCategory, mcpAlias, mcpDigest, mcpOperationRevisions, prepareMcpOperation } from '@ayayaq/vivi/extensions/mcp'
import { CliHost } from '../dist/host.js'
import { CLI_CONVERSATION_LIMITS, replayCliConversationDocument } from '../dist/conversation-records.js'
import { createMcpSchemaValidator } from '../dist/mcp-schema.js'
import { validateMcpOutcomes } from '../dist/mcp-outcomes.js'
import { newSession, validateSession } from '../dist/session.js'

// CLI-20: the actual CLI host and installed shared runner own all conversation work.
// Providers, storage and MCP transport evidence are inert, in-memory owned fixtures.
// These tests establish logical acknowledgement/replay, not physical fsync or live MCP.
const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn)
const settings = { provider: 'openai', model: 'owned-conversation-record-fixture' }
const tick = () => new Promise(resolve => setImmediate(resolve))
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const call = (name = 'calculate', arguments_ = { expression: '2+3' }, id = 'record-call') => ({ id, name, arguments: arguments_ })
const answer = (content = 'Owned final answer', toolCalls = [], usage) => ({ content, toolCalls, ...(usage ? { usage } : {}) })
const counts = { inputTokens: 3, outputTokens: 2, totalTokens: 7, cachedInputTokens: 0, cacheWriteInputTokens: 1 }
const sevenDays = 7 * 24 * 60 * 60 * 1000
const messages = projection => projection.history.map(entry => entry.message)
const toolResults = history => history.filter(message => message.kind === 'tool_result')
const extension = (name, execute) => ({ id: `${name}-fixture`, apiVersion: 1, tools: [{
  definition: { name, description: 'Inert owned conversation fixture', parameters: { type: 'object' } },
  validateArguments() {}, execute
}] })
function gate(t) {
  let enter, release
  const entered = new Promise(resolve => { enter = resolve })
  const wait = new Promise(resolve => { release = resolve })
  t.after(() => release())
  return { entered, enter, wait, release }
}
function observe(promise) {
  const state = { settled: false, value: undefined, error: undefined }
  state.done = promise.then(value => { state.value = value; state.settled = true }, error => {
    state.error = error; state.settled = true
  })
  return state
}
function canonicalStore(onSave) {
  const snapshots = [], values = new Map()
  return { snapshots, async save(session, options) {
    const snapshot = validateSession(structuredClone(session))
    await onSave?.(snapshot, options)
    options?.signal?.throwIfAborted(); options?.assertCurrent?.()
    values.set(session.id, snapshot); snapshots.push(structuredClone(snapshot))
  }, async load(id) {
    assert(values.has(id), 'An actual canonical checkpoint must exist')
    return structuredClone(values.get(id))
  } }
}
function conversationStore(onWrite) {
  const writes = [], values = new Map()
  return { writes, async read(id) { return structuredClone(values.get(id)) },
    async write(id, value, expectedDigest, assertCurrent) {
      assert.equal(value.sessionId, id)
      assert.equal(values.get(id)?.digest ?? null, expectedDigest, 'Exact stored shadow lease')
      assertCurrent()
      const snapshot = structuredClone(value)
      if (!('state' in snapshot)) replayCliConversationDocument(snapshot)
      await onWrite?.(snapshot, expectedDigest)
      assert.equal(values.get(id)?.digest ?? null, expectedDigest, 'Lease is rechecked after any wait')
      assertCurrent()
      const nextDigest = digest(snapshot)
      values.set(id, { value: snapshot, digest: nextDigest }); writes.push(structuredClone(snapshot))
      return nextDigest
    } }
}
function outcomeStore(onSave) {
  const writes = [], values = new Map()
  return { writes, async load(id) { return structuredClone(values.get(id) ?? []) },
    async save(id, rows, options) {
      const next = validateMcpOutcomes(id, rows)
      await onSave?.(next)
      options?.assertCurrent?.()
      values.set(id, next); writes.push(structuredClone(next))
    }, async drain() {} }
}
async function fixture(t, input = {}) {
  const store = input.store ?? canonicalStore(input.onSave)
  const records = input.conversationStore ?? conversationStore(input.onWrite)
  const live = [], notices = [], providerInputs = []
  let generations = 0, host
  const options = { store, conversationStore: records, session: input.session ?? newSession(settings),
    provider: { async generate(value, signal, generation) {
      generations++; providerInputs.push(structuredClone(value))
      return input.generate ? input.generate(value, signal, generation, generations) : answer()
    } }, onConversationNotice: message => notices.push(message), ...input.options,
    async onEvent(event) {
      // Ordered canonical acceptance precedes this legacy live-display seam.
      live.push({ event: structuredClone(event), view: host.conversationRecords, canonical: host.session })
      await input.onEvent?.(event, host)
    } }
  // Keep the actual constructor's options object so fixture scope changes reach
  // the production admission checks rather than a detached create() input copy.
  host = new CliHost(options)
  await host.initialize()
  t.after(async () => { await host.shutdown() })
  return { host, store, records, live, notices, providerInputs, options, generations: () => generations }
}

/** Replay every acknowledged complete write incrementally, independently of host replay. */
function replayAcknowledged(writes, sessionId) {
  let session = createAgentProjection(sessionId)
  const anchors = new Map([[0, session]]), runs = new Map()
  for (const document of writes) {
    if ('state' in document) continue
    for (const record of document.records.slice(session.sequence)) {
      session = applyAgentRecord(session, record); anchors.set(session.sequence, session)
    }
    for (const chain of document.runs) {
      let run = runs.get(chain.runId) ?? createAgentRunProjection(anchors.get(chain.records[0].baseSequence), chain.runId)
      for (const record of chain.records.slice(run.sequence)) run = applyAgentRunRecord(run, record)
      runs.set(chain.runId, run)
    }
  }
  return { projection: session, runs: [...runs.values()] }
}
/** Only Date advances: no multi-day sleep, timer expiry or execution-resume API. */
function pauseClock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 10, 12) })
  return () => {
    const before = Date.now()
    t.mock.timers.tick(sevenDays)
    assert.equal(Date.now() - before, sevenDays, 'The elapsed seven-day pause is clock-only simulation')
  }
}
/** Pending accepted data is paired with actual acknowledged bytes, never a guessed cursor. */
async function assertPausedPaired(subject, expectedCall) {
  const { host, store, records } = subject, id = host.session.id
  const canonical = await store.load(id), stored = await records.read(id)
  const replay = replayCliConversationDocument(stored.value)
  const incremental = replayAcknowledged(records.writes, id), view = host.conversationRecords
  assert.equal(host.running, true); assert.equal(view.state, 'shadow'); assert.equal(view.durability, 'disk')
  assert.deepEqual(view.projection, replay.projection); assert.deepEqual(view.runs, replay.runs)
  assert.deepEqual(incremental, { projection: replay.projection, runs: replay.runs })
  assert.deepEqual(projectAgentRecords(id, stored.value.records), replay.projection)
  const chain = stored.value.runs.at(-1), run = replay.runs.at(-1), base = replay.projection
  assert.deepEqual(projectAgentRunRecords(base, run.runId, chain.records), run)
  assert.deepEqual(chain.records.map(record => record.type), ['run_started', 'assistant_accepted'])
  assert.equal(run.state, 'running'); assert.equal(run.rounds, 1); assert.deepEqual(run.runUsage, counts)
  assert.deepEqual(messages(run), canonical.history); assert.deepEqual(host.session.history, canonical.history)
  assert.equal(toolResults(canonical.history).length, 0)
  assert.deepEqual(run.history.at(-1).message.toolCalls, [expectedCall], 'Exact pending call ID/name/arguments survive replay')
  assert.equal(run.history.at(-1).message.kind, 'assistant')
  for (const [index, entry] of run.history.entries()) {
    assert.equal(entry.id, `cli-history:${index}`)
    assert.equal(entry.source.reference, `cli-session:${id}:history:${index}`)
    assert.equal(entry.source.revision, digest(entry.message), 'The original host-owned SHA-256 source revision is retained')
  }
  const start = chain.records[0]
  assert.equal(base.sequence, 1); assert.equal(view.observedSequence, 1); assert.equal(view.committedSequence, 1)
  assert.equal(run.baseSequence, base.sequence); assert.equal(start.baseSequence, base.sequence)
  assert.equal(run.baseEventId, base.eventId); assert.equal(start.baseEventId, base.eventId)
  assert.equal(run.baseReceiptDigest, base.receipts.at(-1).digest)
  assert.equal(start.baseReceiptDigest, run.baseReceiptDigest); assert.match(run.baseReceiptDigest, /^[a-f0-9]{64}$/)
  assert.equal(run.sequence, 2); assert.equal(run.eventId, chain.records.at(-1).eventId)
  assert.deepEqual(view.committedRuns.at(-1), { runId: run.runId, sequence: 2, eventId: run.eventId },
    'The acknowledged run cursor is separate from the unchanged settled-session cursor')
  assertAgentRunCurrent(run, base)
  const displayed = subject.live.find(item => item.event.type === 'assistant')
  assert(displayed, 'The actual host displayed the checkpointed accepted assistant')
  assert.deepEqual(displayed.event.message, run.history.at(-1).message)
  assert.deepEqual(displayed.view.runs.at(-1), run)
  return { canonical, stored, replay, run, view }
}
async function assertPaired(t, subject, result) {
  const { host, store, records } = subject
  await host.drainMcp()
  const canonical = await store.load(host.session.id)
  const stored = await records.read(host.session.id)
  assert(stored, 'The actual host acknowledged a complete-chain document')
  const replay = replayCliConversationDocument(stored.value)
  const incremental = replayAcknowledged(records.writes, host.session.id)
  const view = host.conversationRecords
  assert.equal(view.state, 'shadow'); assert.equal(view.durability, 'disk')
  assert.equal(view.observedSequence, view.committedSequence)
  assert.deepEqual(view.projection, replay.projection)
  assert.deepEqual(view.runs, replay.runs)
  assert.deepEqual(incremental.projection, replay.projection)
  assert.deepEqual(incremental.runs, replay.runs)
  assert.deepEqual(projectAgentRecords(host.session.id, stored.value.records), replay.projection)
  for (const chain of stored.value.runs) {
    const prefix = projectAgentRecords(host.session.id, stored.value.records.slice(0, chain.records[0].baseSequence))
    assert.deepEqual(projectAgentRunRecords(prefix, chain.runId, chain.records), replay.runs.find(run => run.runId === chain.runId))
  }
  assert.deepEqual(messages(replay.projection), canonical.history)
  assert.deepEqual(messages(replay.projection), host.session.history)
  assert.deepEqual(replay.projection.usage, canonical.usage)
  if (result) assert.deepEqual(canonical.history, result.history)
  for (const { event, view: eventView, canonical: eventCanonical } of subject.live) {
    if (!['assistant', 'tool_completed'].includes(event.type) || eventView.state !== 'shadow') continue
    const lastAccepted = eventView.runs.at(-1).history.at(-1).message
    if (event.type === 'assistant' || lastAccepted.kind === 'tool_result') {
      assert.deepEqual(lastAccepted, event.message, 'Actual live display follows exact accepted message projection')
    } else {
      // Cancellation cleanup has no accepted callback. The host may deliver an exact
      // corrected MCP result after canonical checkpoint and before shadow terminal.
      assert.equal(event.type, 'tool_completed')
      assert.deepEqual(eventCanonical.history.find(message => message.kind === 'tool_result' &&
        message.callId === event.message.callId && message.name === event.message.name), event.message,
      'Unseen corrected live output comes only from the checkpointed canonical terminal')
    }
  }
  const resumed = await CliHost.resume({ id: host.session.id, store, conversationStore: records,
    provider: { async generate() { assert.fail('Replay must not call a provider') } },
    ...(subject.options.mcpOutcomes ? { mcpOutcomes: subject.options.mcpOutcomes } : {}) })
  t.after(() => resumed.shutdown())
  assert.deepEqual(resumed.conversationRecords, view, 'Fresh actual host reload matches live and incremental views')
  assert.deepEqual(resumed.session.history, canonical.history)
  return { document: stored.value, replay, resumed }
}

// Trusted synthetic manager: production catalog/preparation validation, host approvals,
// and actual CliHost ledger create exact accepted/intent/settled rows. No SDK/process,
// remote server, real keys, or lookalike tool-result JSON is used as effect authority.
function syntheticMcp(input = {}) {
  const remoteKey = 'owned-record-operation', alias = mcpAlias('fixture', 'tools', remoteKey)
  const entries = [{ remoteKey, alias, state: 'available', descriptor: { name: remoteKey,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } }]
  const snapshot = { serverId: 'fixture', configRevision: 'owned-config', connectionGeneration: 'owned-connection',
    protocolVersion: '2025-11-25', catalogGeneration: 1, categories: {
      tools: { state: 'ready', entries, digest: mcpDigest(entries) },
      resources: emptyMcpCategory(), resourceTemplates: emptyMcpCategory()
    } }
  const launchDigest = mcpDigest({ owned: 'synthetic-no-process-launch' })
  const invocations = [], preparations = []
  const assertCurrentOperation = operation => assertMcpOperationCurrent(operation, snapshot, launchDigest, true, snapshot.configRevision)
  const manager = { addSecrets() {}, async captureCatalogs(signal) { signal.throwIfAborted(); return [structuredClone(snapshot)] },
    prepareOperation(catalog, entry, kind, requested) {
      const operation = prepareMcpOperation(catalog, entry, kind, requested, launchDigest, createMcpSchemaValidator())
      assertCurrentOperation(operation); preparations.push(operation)
      return operation
    }, operationRevisions(operation) { return mcpOperationRevisions(operation, snapshot, launchDigest, true, snapshot.configRevision) },
    async invoke(operation, signal, assertCurrent, hooks) {
      signal.throwIfAborted(); assertCurrent(); assertCurrentOperation(operation); await hooks.beforeSend()
      signal.throwIfAborted(); assertCurrent(); assertCurrentOperation(operation); invocations.push(structuredClone(operation.call))
      if (input.invoke) return input.invoke(operation, signal, assertCurrent, hooks)
      const result = { content: JSON.stringify({ source: 'mcp', untrusted: true, success: true,
        method: 'tools/call', requestSent: true, confirmedOutcome: true, doNotRetry: true,
        content: [{ type: 'text', text: 'EXACT_OWNED_CONFIRMED_RESPONSE' }] }) }
      await hooks.settle(result)
      return result
    } }
  return { manager, alias, invocations, preparations, snapshot,
    changeCatalog() {
      entries[0].descriptor.description = 'Owned catalog revised during the simulated pause'
      snapshot.catalogGeneration++; snapshot.categories.tools.digest = mcpDigest(entries)
    },
    changeConfig() { snapshot.configRevision = mcpDigest({ owned: 'configuration revised during the simulated pause' }) },
    call: id => call(alias, { query: 'owned exact arguments' }, id) }
}

test('actual CLI pairs two tool turns, provider state, reported cache counts and independent reload', async t => {
  const subject = await fixture(t, { generate(_value, _signal, _options, round) {
    if (round === 1) return { ...answer('Calculating', [call()], counts),
      providerState: { provider: 'owned-fixture', items: [{ opaque: 'native-state-preserved' }] } }
    if (round === 2) return answer('Five', [], counts)
    if (round === 3) return answer('Calculating again', [call('calculate', { expression: '5*2' }, 'second-record-call')], counts)
    return answer('Ten', [], counts)
  } })
  const first = await subject.host.send('Calculate two plus three')
  assert.equal(first.status, 'completed'); assert.equal(first.rounds, 2)
  const firstView = subject.host.conversationRecords
  const second = await subject.host.send('Double that result')
  assert.equal(second.status, 'completed'); assert.equal(second.rounds, 2)
  const { document, replay } = await assertPaired(t, subject, second)
  assert.equal(document.records.length, 3); assert.equal(document.runs.length, 2)
  assert.deepEqual(document.runs.map(run => run.records.map(record => record.type)), [
    ['run_started', 'assistant_accepted', 'tool_result_accepted', 'assistant_accepted', 'run_settled'],
    ['run_started', 'assistant_accepted', 'tool_result_accepted', 'assistant_accepted', 'run_settled']
  ])
  assert.deepEqual(replay.projection.history.slice(0, firstView.projection.history.length), firstView.projection.history,
    'Original history IDs and revisions remain stable across turns')
  assert.deepEqual(replay.projection.usage, { inputTokens: 12, outputTokens: 8, totalTokens: 28,
    cachedInputTokens: 0, cacheWriteInputTokens: 4 })
  assert.deepEqual(replay.projection.history[1].message.providerState,
    { provider: 'owned-fixture', items: [{ opaque: 'native-state-preserved' }] })
  assert.deepEqual(replay.projection.outcomes, [], 'Calculator success cannot prove external effect evidence')
})

test('actual CLI keeps transient text progress outside accepted and settled record bodies', async t => {
  const subject = await fixture(t, { async generate(_value, _signal, options) {
    await options.onProgress({ type: 'text_delta', text: 'TRANSIENT_PROGRESS_NEVER_CANONICAL' })
    return answer('The actual accepted answer', [], counts)
  } })
  const result = await subject.host.send('Show streamed progress')
  const { document } = await assertPaired(t, subject, result)
  assert.equal(subject.live.filter(item => item.event.type === 'text_delta').length, 1)
  assert(!JSON.stringify(document).includes('TRANSIENT_PROGRESS_NEVER_CANONICAL'))
  assert(!JSON.stringify(subject.host.session).includes('TRANSIENT_PROGRESS_NEVER_CANONICAL'))
  assert.deepEqual(document.runs[0].records.map(record => record.type), ['run_started', 'assistant_accepted', 'run_settled'])
})

test('actual CLI records a tool failure without inventing external effect evidence', async t => {
  let executions = 0
  const subject = await fixture(t, { options: { extensions: [extension('owned_failure', () => {
    executions++; throw new Error('Owned executor failed')
  })] }, generate(_value, _signal, _options, round) {
    return round === 1 ? answer('', [call('owned_failure', {}, 'failure-record-call')], counts) : answer('Failure handled')
  } })
  const result = await subject.host.send('Attempt the inert failing fixture')
  assert.equal(result.status, 'completed'); assert.equal(executions, 1)
  assert.equal(toolResults(result.history)[0].isError, true)
  assert.match(toolResults(result.history)[0].content, /Owned executor failed/)
  const { replay } = await assertPaired(t, subject, result)
  assert.deepEqual(replay.projection.outcomes, [])
})

test('actual CLI denied note change retains canonical failure and unchanged note metadata', async t => {
  const approvals = []
  const subject = await fixture(t, { options: { enableNotes: true, async approve(request) { approvals.push(request); return false } },
    generate(_value, _signal, _options, round) { return round === 1
      ? answer('', [call('note_set', { key: 'owned', value: 'Denied note', expectedRevision: 0 }, 'denied-note-call')]) : answer('Note was denied') }
  })
  const result = await subject.host.send('Propose an owned note change')
  assert.equal(approvals.length, 1); assert.equal(subject.host.session.noteRevision, 0)
  assert.deepEqual(subject.host.session.notes, {})
  assert.equal(JSON.parse(toolResults(result.history)[0].content).error.code, 'approval_denied')
  const { document, replay } = await assertPaired(t, subject, result)
  assert.deepEqual(document.legacy.notes, {}); assert.deepEqual(replay.projection.outcomes, [])
})

for (const boundary of ['assistant', 'tool_started']) test(`actual CLI final ${boundary} cancellation includes unseen ordered cleanup closures`, async t => {
  let executions = 0
  const subject = await fixture(t, { options: { extensions: [extension('owned_cancel', () => {
    executions++; return { content: 'This executor must not be entered' }
  })] }, generate() { return answer('Accepted before cancellation', [
    call('owned_cancel', {}, 'cancel-first'), call('owned_cancel', {}, 'cancel-second')
  ], counts) }, onEvent(event, host) { if (event.type === boundary) host.cancel() } })
  const result = await subject.host.send('Cancel before executing this accepted batch')
  assert.equal(result.status, 'cancelled'); assert.equal(result.rounds, 1); assert.equal(executions, 0)
  assert.deepEqual(toolResults(result.history).map(message => message.callId), ['cancel-first', 'cancel-second'])
  assert(toolResults(result.history).every(message => message.isError))
  assert.equal(subject.live.filter(item => item.event.type === 'tool_completed').length, 0)
  const { document, replay } = await assertPaired(t, subject, result)
  assert.deepEqual(document.runs[0].records.map(record => record.type), ['run_started', 'assistant_accepted', 'run_settled'])
  assert.equal(replay.runs[0].state, 'settled'); assert.equal(replay.runs[0].rounds, 1)
  assert.deepEqual(replay.runs[0].runUsage, counts)
})

test('actual CLI final terminal contains cleanup after a live callback failure', async t => {
  const subject = await fixture(t, { generate() { return answer('Accepted before callback failure', [call()], counts) },
    onEvent(event) { if (event.type === 'assistant') throw new Error('Owned display callback failed') } })
  const result = await subject.host.send('Keep accepted history when live delivery fails')
  assert.equal(result.status, 'error'); assert.equal(result.error.code, 'event_error')
  assert.equal(toolResults(result.history).length, 1)
  assert.equal(subject.live.filter(item => item.event.type === 'tool_completed').length, 0)
  const { document } = await assertPaired(t, subject, result)
  assert.equal(document.records.at(-1).settlement.error.code, 'event_error')
  assert.deepEqual(document.runs[0].records.map(record => record.type), ['run_started', 'assistant_accepted', 'run_settled'])
})

for (const boundary of ['accepted shadow write', 'canonical callback write', 'live callback']) {
  test(`actual CLI cancellation drains admitted ${boundary} before its final shadow acknowledgement`, async t => {
    const held = gate(t), terminal = gate(t), caller = new AbortController()
    let blocked = false, terminalSeen = false, cancelled = false
    const subject = await fixture(t, {
      async onWrite(document) {
        const records = document.runs.at(-1)?.records ?? []
        if (boundary === 'accepted shadow write' && !blocked && records.at(-1)?.type === 'assistant_accepted') {
          blocked = true; held.enter(); await held.wait
        }
        if (cancelled && !terminalSeen && records.at(-1)?.type === 'run_settled') {
          terminalSeen = true; terminal.enter(); await terminal.wait
        }
      }, async onSave(session) {
        if (boundary === 'canonical callback write' && !blocked && session.history.some(message => message.kind === 'assistant')) {
          blocked = true; held.enter(); await held.wait
        }
      }, async onEvent(event) {
        if (boundary === 'live callback' && !blocked && event.type === 'assistant') {
          blocked = true; held.enter(); await held.wait
        }
      }, generate() { return answer('Accepted while storage waits', [], counts) }
    })
    const sending = observe(subject.host.send('Await every admitted operation', caller.signal))
    await held.entered
    cancelled = true; caller.abort(new Error('Owned cancellation while admitted work waits'))
    await tick()
    assert.equal(sending.settled, false); assert.equal(subject.host.running, true)
    await assert.rejects(subject.host.send('Replacement cannot enter'), /already running/)
    const writing = subject.host.conversationRecords
    assert.equal(writing.committedSequence, 1, 'Accepted observation is not a settled-session disk acknowledgement')
    assert.equal(writing.runs.at(-1).sequence, 2)
    assert.equal(writing.committedRuns.at(-1).sequence, boundary === 'accepted shadow write' ? 1 : 2,
      'Observed accepted state is separate from the per-run storage acknowledgement')
    held.release()
    await terminal.entered
    assert.equal(sending.settled, false, 'The final shadow write belongs to this turn')
    assert.equal(subject.host.running, true)
    const observed = subject.host.conversationRecords
    assert.equal(observed.observedSequence, 2); assert.equal(observed.committedSequence, 1)
    assert.equal(observed.runs.at(-1).state, 'settled')
    assert.equal(observed.runs.at(-1).sequence, 3); assert.equal(observed.committedRuns.at(-1).sequence, 2)
    terminal.release()
    await sending.done
    assert.equal(sending.error, undefined); assert.equal(sending.value.status, 'cancelled')
    await assertPaired(t, subject, sending.value)
  })
}

test('actual CLI legacy import retains title, notes and aggregate usage without fabricating historical runs', async t => {
  const old = newSession(settings)
  old.title = 'Original legacy title'; old.titleRevision = 4
  old.notes = { color: 'blue' }; old.noteRevision = 2
  old.history = [{ kind: 'message', role: 'user', content: 'Legacy request' },
    { kind: 'assistant', content: 'Legacy response', toolCalls: [], providerState: { provider: 'owned-fixture', items: [{ old: true }] } }]
  old.usage = { inputTokens: 14, outputTokens: 4, totalTokens: 23 }
  const subject = await fixture(t, { session: validateSession(old) })
  const { document, replay } = await assertPaired(t, subject)
  assert.deepEqual(document.legacy, validateSession(old)); assert.equal(document.records[0].reason, 'legacy_import')
  assert.equal(document.records.length, 1); assert.deepEqual(document.runs, [])
  assert.deepEqual(replay.projection.runs, []); assert.deepEqual(replay.projection.usage, old.usage)
  assert.equal(subject.generations(), 0)
})

test('actual CLI exact owned confirmed MCP effects survive live, incremental and fresh reload projections', async t => {
  const mcp = syntheticMcp(), outcomes = outcomeStore(), approvals = []
  const subject = await fixture(t, { options: { mcp: mcp.manager, mcpOutcomes: outcomes,
    async approve(request) { approvals.push(request); return true } },
    generate(_value, _signal, _options, round) { return round === 1 ? answer('', [mcp.call('confirmed-record-call')], counts) : answer('Confirmed result received') }
  })
  const result = await subject.host.send('Run the exact owned synthetic MCP operation')
  assert.equal(result.status, 'completed'); assert.equal(mcp.invocations.length, 1); assert.equal(approvals.length, 1)
  const { replay } = await assertPaired(t, subject, result)
  const evidence = replay.projection.outcomes[0]
  assert.equal(evidence.callId, 'confirmed-record-call'); assert.equal(evidence.effect, 'confirmed'); assert.equal(evidence.status, 'succeeded')
  assert.equal(evidence.runId, replay.runs[0].runId)
  assert.match(evidence.source.reference, /^cli-mcp-outcome:/)
  assert.equal((await outcomes.load(subject.host.session.id)).length, 0, 'Retirement happens only after the matching canonical checkpoint')
  assert(outcomes.writes.some(rows => rows.some(row => row.state === 'intent')))
  assert(outcomes.writes.some(rows => rows.some(row => row.state === 'settled')))
})

test('actual CLI auto mode still manually denies an MCP operation and records exact definite no-send evidence', async t => {
  const mcp = syntheticMcp(), outcomes = outcomeStore()
  let approvals = 0, evaluations = 0
  const subject = await fixture(t, { options: { mcp: mcp.manager, mcpOutcomes: outcomes,
    async approve() { approvals++; return false }, decisionReview: { canAutoReview: true, accountRevision: () => 'owned-account',
      provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { evaluations++; assert.fail('MCP is always manually reviewed') } },
      ledger: { async upsert() { assert.fail('Manual MCP operations have no local-write model-review ledger') } } } },
    generate(_value, _signal, _options, round) { return round === 1 ? answer('', [mcp.call('denied-mcp-call')]) : answer('MCP denied') }
  })
  subject.host.setApprovalMode('auto')
  const result = await subject.host.send('Propose an exact manual MCP operation')
  assert.equal(approvals, 1); assert.equal(evaluations, 0); assert.equal(mcp.invocations.length, 0)
  assert.equal(JSON.parse(toolResults(result.history)[0].content).requestSent, false)
  const { replay } = await assertPaired(t, subject, result)
  assert.equal(replay.projection.outcomes[0].effect, 'not_attempted')
  assert.equal(replay.projection.outcomes[0].status, 'denied')
})

const pauseChanges = [
  { name: 'unchanged state', sends: 1 },
  { name: 'actual catalog revision', sends: 0, revisionChanges: true, change(_subject, mcp) { mcp.changeCatalog() } },
  { name: 'actual configuration revision', sends: 0, revisionChanges: true, change(_subject, mcp) { mcp.changeConfig() } },
  { name: 'manager owner replacement', sends: 0, change(subject) { subject.options.mcp = undefined } },
  { name: 'tools scope disabled', sends: 0, change(subject) { subject.options.enableTools = false } },
  { name: 'cancellation', sends: 0, change(subject) { subject.host.cancel() } }
]
for (const scenario of pauseChanges) test(`actual CLI seven-day clock-only approval pause revalidates ${scenario.name}`, async t => {
  const advanceClock = pauseClock(t), held = gate(t), mcp = syntheticMcp(), outcomes = outcomeStore(), approvals = []
  const requested = mcp.call(`paused-${scenario.name.replaceAll(' ', '-')}`)
  let approvalSignal
  const subject = await fixture(t, { options: { mcp: mcp.manager, mcpOutcomes: outcomes,
    async approve(request, signal) {
      approvals.push(structuredClone(request)); approvalSignal = signal; held.enter(); await held.wait
      return true // A late human response is still subjected to the actual host's currentness checks.
    } }, generate(_value, _signal, _options, round) {
    return round === 1 ? answer('Accepted pending manual MCP operation', [requested], counts) : answer('Current review outcome retained')
  } })
  const sending = observe(subject.host.send('Hold the exact owned operation for manual review'))
  await held.entered
  const before = await assertPausedPaired(subject, requested)
  assert.equal(approvals.length, 1); assert.deepEqual(approvals[0].call, requested)
  assert.equal(mcp.preparations.length, 1)
  assert.equal(approvals[0].currentRevision, mcpDigest(mcp.preparations[0].binding))
  const revisions = mcp.manager.operationRevisions(mcp.preparations[0])
  const accepted = await outcomes.load(subject.host.session.id)
  assert.equal(accepted.length, 1); assert.equal(accepted[0].state, 'accepted')
  assert.equal(accepted[0].runId, before.run.runId); assert.equal(accepted[0].callId, requested.id)
  assert.equal(accepted[0].toolName, requested.name); assert.equal(accepted[0].callDigest, mcpDigest(requested))
  advanceClock(); await tick()
  const after = await assertPausedPaired(subject, requested)
  assert.deepEqual(after, before, 'Clock-only elapsed time does not change pending work, sources or either committed cursor')
  assert.equal(sending.settled, false); assert.equal(subject.generations(), 1); assert.equal(mcp.invocations.length, 0)
  assert.equal(approvals.length, 1); assert.equal(approvalSignal.aborted, false)
  await scenario.change?.(subject, mcp)
  const currentRevisions = mcp.manager.operationRevisions(mcp.preparations[0])
  if (scenario.revisionChanges) {
    assert.notDeepEqual(currentRevisions, revisions, 'Production shared current-binding evidence reflects the actual changed fixture state')
    assert.throws(() => assertMcpOperationCurrent(mcp.preparations[0], mcp.snapshot,
      mcp.preparations[0].binding.launchDigest, true, mcp.snapshot.configRevision), /stale/)
  } else assert.deepEqual(currentRevisions, revisions)
  if (scenario.name === 'cancellation') {
    await tick(); assert.equal(approvalSignal.aborted, true)
    assert.equal(sending.settled, false, 'The cancelled host retains admitted review work until the late response drains')
  }
  held.release(); await sending.done
  assert.equal(sending.error, undefined)
  assert.equal(sending.value.status, scenario.name === 'cancellation' ? 'cancelled' : 'completed')
  assert.equal(approvals.length, 1); assert.equal(mcp.invocations.length, scenario.sends)
  assert.deepEqual(mcp.invocations, scenario.sends ? [requested] : [])
  const finalResult = toolResults(sending.value.history)[0], body = JSON.parse(finalResult.content)
  assert.equal(finalResult.callId, requested.id); assert.equal(finalResult.name, requested.name)
  assert.equal(body.requestSent, Boolean(scenario.sends))
  assert.equal(body.confirmedOutcome === true, Boolean(scenario.sends))
  assert.equal(body.unknownOutcome === true, false)
  assert.equal(outcomes.writes.some(rows => rows.some(row => row.state === 'intent')), Boolean(scenario.sends),
    'A stale or cancelled approval cannot enter the production durable-intent pipeline')
  const { document, replay } = await assertPaired(t, subject, sending.value)
  assert.deepEqual(replay.projection.history.slice(0, before.run.history.length), before.run.history)
  assert.deepEqual(document.runs[0].records.slice(0, 2), before.stored.value.runs[0].records)
  const evidence = replay.projection.outcomes[0]
  assert.equal(evidence.runId, before.run.runId); assert.equal(evidence.callId, requested.id); assert.equal(evidence.name, requested.name)
  assert.equal(evidence.argumentsDigest, agentArgumentsDigest(requested.arguments))
  assert.equal(evidence.effect, scenario.sends ? 'confirmed' : 'not_attempted')
  assert.equal(evidence.status, scenario.sends ? 'succeeded' : 'denied')
  assert.equal(evidence.source.reference, `cli-mcp-outcome:${accepted[0].id}`)
  const settled = outcomes.writes.flat().findLast(row => row.callId === requested.id && row.state === 'settled')
  assert.equal(evidence.source.revision, digest(settled))
  assert.equal((await outcomes.load(subject.host.session.id)).length, 0)
  assert.equal(mcp.invocations.length, scenario.sends, 'Full, incremental and fresh-host replay never resends the effect')
})

for (const retainReceipt of [true, false]) test(`actual CLI cold copy after seven-day clock-only approval pause retains ${retainReceipt ? 'exact no-send' : 'unknown'} recovery and requires fresh approval`, async t => {
  const advanceClock = pauseClock(t), oldApproval = gate(t), recoveryWrite = gate(t), freshApproval = gate(t)
  const mcp = syntheticMcp(), outcomes = outcomeStore(), approvals = []
  const requested = mcp.call('cold-paused-call')
  const subject = await fixture(t, { options: { mcp: mcp.manager, mcpOutcomes: outcomes,
    async approve(request) { approvals.push(structuredClone(request)); oldApproval.enter(); await oldApproval.wait; return true } },
    generate() { return answer('Accepted before a simulated process loss', [requested], counts) }
  })
  const sending = observe(subject.host.send('Hold pending work before a cold data-only restore'))
  await oldApproval.entered
  const before = await assertPausedPaired(subject, requested)
  advanceClock(); await tick()
  const paused = await assertPausedPaired(subject, requested)
  assert.deepEqual(paused, before); assert.equal(sending.settled, false); assert.equal(mcp.invocations.length, 0)
  const id = subject.host.session.id, receipt = await outcomes.load(id)
  assert.equal(receipt.length, 1); assert.equal(receipt[0].state, 'accepted')
  // Copy only acknowledged canonical/record/optional receipt data. No original
  // executor, owner, callbacks or outstanding human approval enters the new host.
  // Dropping the optional accepted receipt models lost evidence, never proof of no send.
  const recoveredStore = canonicalStore(), recoveredOutcomes = outcomeStore()
  let recoveryBlocked = false
  const recoveredRecords = conversationStore(async document => {
    if (!recoveryBlocked && document.records.at(-1).reason === 'reconciliation') {
      recoveryBlocked = true; recoveryWrite.enter(); await recoveryWrite.wait
    }
  })
  await recoveredStore.save(paused.canonical)
  await recoveredRecords.write(id, paused.stored.value, null, () => {})
  if (retainReceipt) await recoveredOutcomes.save(id, receipt)
  const freshMcp = syntheticMcp(), newCall = freshMcp.call('fresh-after-cold-pause'), freshApprovals = [], live = [], providerInputs = []
  let generations = 0, resumed
  const options = { session: await recoveredStore.load(id), store: recoveredStore, conversationStore: recoveredRecords,
    mcp: freshMcp.manager, mcpOutcomes: recoveredOutcomes,
    provider: { async generate(value) {
      generations++; providerInputs.push(structuredClone(value))
      return generations === 1 ? answer('A new proposal needs new review', [newCall], counts) : answer('Freshly approved operation finished')
    } }, async approve(request) {
      freshApprovals.push(structuredClone(request)); freshApproval.enter(); await freshApproval.wait; return true
    }, onEvent(event) { live.push({ event: structuredClone(event), view: resumed.conversationRecords, canonical: resumed.session }) } }
  resumed = new CliHost(options)
  t.after(() => resumed.shutdown())
  const initializing = observe(resumed.initialize())
  await recoveryWrite.entered
  const unacknowledged = resumed.conversationRecords
  assert.equal(initializing.settled, false); assert.equal(generations, 0); assert.equal(freshApprovals.length, 0)
  assert.equal(freshMcp.preparations.length, 0); assert.equal(freshMcp.invocations.length, 0); assert.equal(resumed.running, false)
  assert.equal(unacknowledged.observedSequence, 2); assert.equal(unacknowledged.committedSequence, 1,
    'An observed reconciliation is not a checkpoint acknowledgement while its actual store write is held')
  assert.deepEqual(unacknowledged.committedRuns, paused.view.committedRuns)
  assert.deepEqual(unacknowledged.runs[0], paused.run, 'The original active chain and cursor are immutable recovery data')
  assert.deepEqual((await recoveredRecords.read(id)).value, paused.stored.value)
  assert.deepEqual(replayAcknowledged(recoveredRecords.writes, id), { projection: paused.replay.projection, runs: paused.replay.runs })
  recoveryWrite.release(); await initializing.done
  assert.equal(initializing.error, undefined)
  const restored = resumed.conversationRecords, recoveredDocument = (await recoveredRecords.read(id)).value
  const full = replayCliConversationDocument(recoveredDocument), incremental = replayAcknowledged(recoveredRecords.writes, id)
  assert.equal(restored.state, 'shadow'); assert.equal(restored.observedSequence, 2); assert.equal(restored.committedSequence, 2)
  assert.deepEqual(restored.projection, full.projection); assert.deepEqual(restored.runs, full.runs)
  assert.deepEqual(incremental, { projection: full.projection, runs: full.runs })
  assert.deepEqual(recoveredDocument.runs, paused.stored.value.runs); assert.deepEqual(full.runs[0], paused.run)
  assert.deepEqual(restored.committedRuns, paused.view.committedRuns)
  assert.deepEqual(full.projection.history.slice(0, paused.run.history.length), paused.run.history)
  assert.deepEqual(messages(full.projection), resumed.session.history)
  assert.deepEqual(full.projection.runs, [], 'Recovery does not invent a terminal status for the interrupted run')
  const reconciliation = recoveredDocument.records.at(-1)
  assert.equal(reconciliation.type, 'session_snapshot'); assert.equal(reconciliation.reason, 'reconciliation')
  assert.equal(reconciliation.previousEventId, paused.replay.projection.eventId)
  assert.deepEqual(full.projection.usage, paused.canonical.usage)
  assert.throws(() => assertAgentRunCurrent(full.runs[0], full.projection), /obsolete/,
    'The preserved active cursor cannot authorize use against the newer canonical reconciliation')
  assert.equal(applyAgentRecord(full.projection, paused.stored.value.records[0]), full.projection,
    'An old session duplicate cannot roll recovery back')
  assert.equal(applyAgentRunRecord(full.runs[0], paused.stored.value.runs[0].records[1]), full.runs[0])
  const closure = toolResults(resumed.session.history)[0], body = JSON.parse(closure.content)
  assert.equal(closure.callId, requested.id); assert.equal(closure.name, requested.name); assert.equal(closure.isError, true)
  assert.equal(toolResults(resumed.session.history).length, 1)
  if (retainReceipt) {
    assert.equal(body.requestSent, false); assert.equal(body.unknownOutcome === true, false)
    assert.deepEqual(full.projection.outcomes, [{ runId: paused.run.runId, callId: requested.id, name: requested.name,
      argumentsDigest: agentArgumentsDigest(requested.arguments), status: 'cancelled', effect: 'not_attempted',
      source: { reference: `cli-mcp-outcome:${receipt[0].id}`, revision: digest(receipt[0]) } }])
  } else {
    assert.equal(body.error.code, 'interrupted'); assert.match(body.error.message, /outcome may be unknown/)
    assert.equal(body.requestSent, undefined); assert.equal(body.confirmedOutcome, undefined)
    assert.deepEqual(full.projection.outcomes, [], 'Absent receipt remains unknown; it is not invented no-send evidence')
  }
  assert.equal(generations, 0); assert.equal(freshApprovals.length, 0); assert.equal(freshMcp.invocations.length, 0)
  const reloaded = await CliHost.resume({ id, store: recoveredStore, conversationStore: recoveredRecords,
    mcp: freshMcp.manager, mcpOutcomes: recoveredOutcomes,
    provider: { async generate() { assert.fail('Cold replay cannot invoke a provider') } },
    async approve() { assert.fail('Cold replay cannot reconstruct human approval') } })
  t.after(() => reloaded.shutdown())
  assert.deepEqual(reloaded.conversationRecords, restored); assert.deepEqual(reloaded.session.history, resumed.session.history)
  assert.equal(freshMcp.invocations.length, 0)
  subject.host.cancel(); oldApproval.release(); await sending.done
  assert.equal(sending.error, undefined); assert.equal(sending.value.status, 'cancelled'); assert.equal(mcp.invocations.length, 0)
  const continuing = observe(resumed.send('Approve a later newly proposed exact call'))
  await freshApproval.entered
  assert.equal(continuing.settled, false); assert.equal(generations, 1); assert.equal(freshApprovals.length, 1)
  assert.deepEqual(freshApprovals[0].call, newCall); assert.notEqual(newCall.id, requested.id)
  assert.equal(freshMcp.invocations.length, 0, 'A restored pending call or old human response cannot approve a later call')
  assert.deepEqual(toolResults(providerInputs[0].messages), [closure])
  freshApproval.release(); await continuing.done
  assert.equal(continuing.error, undefined); assert.equal(continuing.value.status, 'completed')
  assert.deepEqual(freshMcp.invocations, [newCall]); assert.equal(approvals.length, 1); assert.equal(freshApprovals.length, 1)
  const { replay } = await assertPaired(t, { host: resumed, store: recoveredStore, records: recoveredRecords, live, options }, continuing.value)
  assert.deepEqual(replay.runs[0], paused.run)
  assert.deepEqual(replay.projection.history.slice(0, full.projection.history.length), full.projection.history)
  assert.equal(mcp.invocations.length, 0); assert.deepEqual(freshMcp.invocations, [newCall])
})

test('actual CLI exact intent without settlement remains unknown and never replays an MCP operation', async t => {
  const outcomes = outcomeStore(), mcp = syntheticMcp({ async invoke() { throw new Error('Owned synthetic wire lost after intent') } })
  const subject = await fixture(t, { options: { mcp: mcp.manager, mcpOutcomes: outcomes, approve: async () => true },
    generate(_value, _signal, _options, round) { return round === 1 ? answer('', [mcp.call('unknown-mcp-call')]) : answer('Unknown effect retained') }
  })
  const result = await subject.host.send('Do not retry uncertain effects')
  assert.equal(mcp.invocations.length, 1)
  const body = JSON.parse(toolResults(result.history)[0].content)
  assert.equal(body.unknownOutcome, true); assert.equal(body.doNotRetry, true)
  const { replay } = await assertPaired(t, subject, result)
  assert.equal(replay.projection.outcomes[0].effect, 'unknown'); assert.equal(replay.projection.outcomes[0].status, 'unknown')
  assert.equal(mcp.invocations.length, 1, 'Fresh restoration never reconstructs an executor or approval')
})

test('actual CLI does not elevate MCP-shaped custom JSON into host-owned effect evidence', async t => {
  const name = 'mcp_lookalike_fixture'
  const subject = await fixture(t, { options: { extensions: [extension(name, () => ({ content: JSON.stringify({
    source: 'mcp', success: true, requestSent: true, confirmedOutcome: true, doNotRetry: true, content: []
  }) }))] }, generate(_value, _signal, _options, round) {
    return round === 1 ? answer('', [call(name, {}, 'lookalike-call')]) : answer('Generic tool result retained')
  } })
  const result = await subject.host.send('Keep generic tool content untrusted')
  const { replay } = await assertPaired(t, subject, result)
  assert.deepEqual(replay.projection.outcomes, [])
})

test('actual CLI failed canonical MCP checkpoint retains stronger exact ledger evidence and old committed cursor', async t => {
  const outcomes = outcomeStore(), mcp = syntheticMcp()
  let failCheckpoint = true
  const subject = await fixture(t, { options: { mcp: mcp.manager, mcpOutcomes: outcomes, approve: async () => true },
    onSave(session) { if (failCheckpoint && toolResults(session.history).length) throw new Error('Owned canonical result checkpoint failed') },
    generate(_value, _signal, _options, round) { return round === 1 ? answer('', [mcp.call('failed-checkpoint-call')]) : answer('No second send expected') }
  })
  const previous = subject.host.conversationRecords.committedSequence
  await assert.rejects(subject.host.send('Retain exact evidence if canonical storage fails'), /checkpoint failed|cleanup also failed|callback failed/)
  assert.equal(mcp.invocations.length, 1)
  const retained = await outcomes.load(subject.host.session.id)
  assert.equal(retained.length, 1); assert.equal(retained[0].state, 'settled')
  assert.match(retained[0].result.content, /EXACT_OWNED_CONFIRMED_RESPONSE/)
  assert.equal(subject.host.conversationRecords.committedSequence, previous)
  assert.equal(subject.host.conversationRecords.projection.sequence, previous)
  assert(!subject.records.writes.some(document => document.records.some(record => record.type === 'run_settled')))
  assert(!outcomes.writes.some(rows => rows.length === 0), 'No failed canonical checkpoint acknowledges or retires stronger MCP evidence')
  failCheckpoint = false
  const resumed = await CliHost.resume({ id: subject.host.session.id, store: subject.store, conversationStore: subject.records,
    mcpOutcomes: outcomes, provider: { async generate() { assert.fail('Recovery is read-only') } } })
  t.after(() => resumed.shutdown())
  assert.match(toolResults(resumed.session.history)[0].content, /EXACT_OWNED_CONFIRMED_RESPONSE/)
  assert.equal(mcp.invocations.length, 1)
})


test('actual CLI cancelled MCP operation drains a late exact confirmed outcome before terminal projection and retirement', async t => {
  const held = gate(t), outcomeWrite = gate(t), terminalWrite = gate(t), caller = new AbortController()
  let outcomeBlocked = false, terminalBlocked = false
  const outcomes = outcomeStore(async rows => {
    if (!outcomeBlocked && rows.some(row => row.state === 'settled')) {
      outcomeBlocked = true; outcomeWrite.enter(); await outcomeWrite.wait
    }
  })
  const mcp = syntheticMcp({ async invoke(_operation, _signal, _assertCurrent, hooks) {
    held.enter(); await held.wait
    const result = { content: JSON.stringify({ source: 'mcp', success: true, requestSent: true,
      confirmedOutcome: true, doNotRetry: true, content: [{ type: 'text', text: 'LATE_OWNED_CONFIRMED_EFFECT' }] }) }
    await hooks.settle(result)
    return result
  } })
  const subject = await fixture(t, { options: { mcp: mcp.manager, mcpOutcomes: outcomes, approve: async () => true },
    async onWrite(document) {
      if (!terminalBlocked && document.records.at(-1).type === 'run_settled') {
        terminalBlocked = true; terminalWrite.enter(); await terminalWrite.wait
      }
    }, generate(_value, _signal, _options, round) {
      return round === 1 ? answer('Accepted MCP request', [mcp.call('late-confirmed-call')], counts) : answer('Must remain cancelled')
    }
  })
  const sending = observe(subject.host.send('Preserve late confirmed effects on cancellation', caller.signal))
  await held.entered
  caller.abort(new Error('Owned cancellation after exact synthetic send'))
  await tick()
  assert.equal(sending.settled, false); assert.equal(subject.host.running, true)
  assert.equal(mcp.invocations.length, 1)
  assert.equal((await outcomes.load(subject.host.session.id))[0].state, 'intent')
  held.release()
  await outcomeWrite.entered
  assert.equal(sending.settled, false, 'Admitted exact outcome persistence must drain')
  assert.equal(subject.host.conversationRecords.committedSequence, 1)
  outcomeWrite.release()
  await terminalWrite.entered
  assert.equal(sending.settled, false, 'Terminal projection storage still owns the cancelled turn')
  assert.equal((await outcomes.load(subject.host.session.id))[0].state, 'settled')
  terminalWrite.release()
  await sending.done
  assert.equal(sending.error, undefined); assert.equal(sending.value.status, 'cancelled')
  const finalResult = toolResults(sending.value.history)[0]
  assert.match(finalResult.content, /LATE_OWNED_CONFIRMED_EFFECT/)
  assert.notEqual(finalResult.isError, true, 'Generic cleanup cannot erase an exact confirmed response')
  const corrected = subject.live.filter(item => item.event.type === 'tool_completed')
  assert.equal(corrected.length, 1); assert.deepEqual(corrected[0].event.message, finalResult)
  const { document, replay } = await assertPaired(t, subject, sending.value)
  assert.deepEqual(document.runs[0].records.map(record => record.type), ['run_started', 'assistant_accepted', 'run_settled'])
  assert.equal(replay.projection.outcomes[0].effect, 'confirmed'); assert.equal(replay.projection.outcomes[0].status, 'succeeded')
  assert.equal((await outcomes.load(subject.host.session.id)).length, 0)
  assert.equal(mcp.invocations.length, 1)
})


test('actual CLI final-headroom preflight rejects oversized assistant before acceptance, review or dispatch', async t => {
  const approvals = [], mcp = syntheticMcp(), outcomes = outcomeStore()
  const subject = await fixture(t, { options: { mcp: mcp.manager, mcpOutcomes: outcomes,
    async approve(request) { approvals.push(request); return true } }, generate() {
      return answer('x'.repeat(CLI_CONVERSATION_LIMITS.activeHistoryBytes), [mcp.call('oversized-unaccepted-call')], counts)
    }
  })
  const result = await subject.host.send('Reject candidates without room for complete settlement')
  assert.equal(result.status, 'error'); assert.equal(result.error.code, 'provider_error')
  assert.match(result.error.message, /final headroom exhausted/)
  assert.equal(result.rounds, 0); assert.equal(result.content, '')
  assert.equal(approvals.length, 0); assert.equal(mcp.invocations.length, 0)
  assert.equal(subject.live.filter(item => ['assistant', 'tool_started', 'tool_completed'].includes(item.event.type)).length, 0)
  assert.equal(result.history.filter(message => message.kind === 'assistant').length, 0)
  assert.deepEqual(await outcomes.load(subject.host.session.id), [])
  const { document, replay } = await assertPaired(t, subject, result)
  assert.deepEqual(document.runs[0].records.map(record => record.type), ['run_started', 'run_settled'])
  assert.deepEqual(replay.projection.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
})

test('actual CLI simulated interrupted accepted run recovers canonical closures without executing or inventing a terminal run', async t => {
  const held = gate(t)
  let executions = 0
  const subject = await fixture(t, { options: { extensions: [extension('owned_interrupted', () => {
    executions++; assert.fail('Accepted historical tool must never be executed by recovery')
  })] }, generate() { return answer('Accepted before simulated crash', [call('owned_interrupted', {}, 'interrupted-call')], counts) },
    async onEvent(event) { if (event.type === 'assistant') { held.enter(); await held.wait } }
  })
  const sending = observe(subject.host.send('Preserve this interrupted accepted prefix'))
  await held.entered
  const id = subject.host.session.id, canonicalAtCrash = await subject.store.load(id), shadowAtCrash = await subject.records.read(id)
  const crashRun = replayCliConversationDocument(shadowAtCrash.value).runs[0]
  assert.equal(crashRun.state, 'running'); assert.equal(crashRun.rounds, 1)
  assert.deepEqual(shadowAtCrash.value.runs[0].records.map(record => record.type), ['run_started', 'assistant_accepted'])
  assert.equal(toolResults(canonicalAtCrash.history).length, 0)
  // Fork acknowledged bytes into fresh in-memory stores: this models process loss
  // without sharing the old executor, callbacks, subscriptions or approval state.
  const recoveredStore = canonicalStore(), recoveredRecords = conversationStore()
  await recoveredStore.save(canonicalAtCrash)
  await recoveredRecords.write(id, shadowAtCrash.value, null, () => {})
  let generations = 0, approvals = 0
  const resumed = await CliHost.resume({ id, store: recoveredStore, conversationStore: recoveredRecords,
    provider: { async generate() { generations++; return answer('Fresh continuation only') } },
    async approve() { approvals++; assert.fail('Restoration grants no reusable approval') } })
  t.after(() => resumed.shutdown())
  assert.equal(generations, 0); assert.equal(approvals, 0); assert.equal(executions, 0)
  const restored = resumed.conversationRecords
  assert.equal(restored.state, 'shadow'); assert.equal(restored.committedSequence, 2)
  assert.deepEqual(messages(restored.projection), resumed.session.history)
  assert.deepEqual(restored.projection.runs, [], 'Unknown historical terminal status is not fabricated')
  assert.equal(restored.runs[0].state, 'running'); assert.deepEqual(restored.runs[0], crashRun)
  assert.deepEqual(restored.projection.history.slice(0, crashRun.history.length), crashRun.history)
  const closures = toolResults(resumed.session.history)
  assert.equal(closures.length, 1); assert.equal(closures[0].callId, 'interrupted-call'); assert.equal(closures[0].isError, true)
  const recoveredDocument = (await recoveredRecords.read(id)).value
  assert.equal(recoveredDocument.records.at(-1).type, 'session_snapshot')
  assert.equal(recoveredDocument.records.at(-1).reason, 'reconciliation')
  assert.deepEqual(recoveredDocument.records.at(-1).snapshot.usage, canonicalAtCrash.usage,
    'Recovery preserves canonical aggregate usage rather than inventing a complete total from partial telemetry')
  assert.deepEqual(replayAcknowledged(recoveredRecords.writes, id).projection, restored.projection)
  subject.host.cancel(); held.release(); await sending.done
  assert.equal(sending.error, undefined); assert.equal(sending.value.status, 'cancelled')
  const next = await resumed.send('Continue with a fresh run and no historical executor')
  assert.equal(next.status, 'completed'); assert.equal(generations, 1); assert.equal(executions, 0); assert.equal(approvals, 0)
  await assertPaired(t, { host: resumed, store: recoveredStore, records: recoveredRecords, live: [], options: {} }, next)
})


for (const budget of ['depth', 'nodes']) test(`actual CLI enclosed terminal ${budget} preflight rejects ordinary provider state before acceptance, review or dispatch`, async t => {
  let executions = 0, approvals = 0
  const ordinaryCall = call('owned_headroom', {}, `ordinary-${budget}-call`)
  const noteCall = call('note_set', { key: 'owned', value: 'Must stay unreviewed', expectedRevision: 0 }, `unreviewed-${budget}-note`)
  let nested = { leaf: 'ordinary opaque provider state' }
  for (let index = 0; index < 27; index++) nested = { next: nested }
  const candidate = { ...answer('Execute the inert fixture and review its note', [ordinaryCall, noteCall], counts),
    providerState: { provider: 'owned-fixture', items: budget === 'depth' ? [nested] : Array(AGENT_RECORD_LIMITS.nodes - 24).fill(null) } }
  assert.doesNotThrow(() => assertMcpJson(candidate, AGENT_RECORD_LIMITS.bytes, {
    nodes: AGENT_RECORD_LIMITS.nodes, depth: AGENT_RECORD_LIMITS.depth
  }), 'The ordinary provider payload fits the isolated JSON budget')
  assert(Buffer.byteLength(JSON.stringify(candidate)) < CLI_CONVERSATION_LIMITS.activeHistoryBytes,
    'This regression exercises terminal structure rather than byte headroom')
  const subject = await fixture(t, { options: { enableNotes: true,
    extensions: [extension('owned_headroom', () => { executions++; return { content: 'Must stay undispatched' } })],
    async approve() { approvals++; return true } }, generate() { return candidate } })
  const result = await subject.host.send(`Reject the ordinary candidate that overflows enclosed terminal ${budget}`)
  assert.equal(subject.generations(), 1); assert.equal(result.status, 'error'); assert.equal(result.error.code, 'provider_error')
  assert.match(result.error.message, budget === 'depth'
    ? /Event JSON complexity limit exceeded/ : /Event (?:JSON complexity limit exceeded|array must be bounded plain JSON)/)
  assert.equal(result.rounds, 0); assert.equal(result.content, '')
  assert.equal(executions, 0); assert.equal(approvals, 0)
  assert.equal(subject.host.session.noteRevision, 0); assert.deepEqual(subject.host.session.notes, {})
  assert.equal(subject.live.filter(item => ['assistant', 'tool_started', 'tool_completed'].includes(item.event.type)).length, 0)
  assert.equal(result.history.filter(message => message.kind === 'assistant').length, 0)
  assert.equal(toolResults(result.history).length, 0)
  const { document, replay } = await assertPaired(t, subject, result)
  assert.deepEqual(document.runs[0].records.map(record => record.type), ['run_started', 'run_settled'])
  assert.deepEqual(replay.projection.outcomes, [])
  assert.deepEqual(replay.projection.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  assert(!JSON.stringify(document).includes('ordinary opaque provider state'))
  assert(!JSON.stringify(document).includes('Must stay unreviewed'))
})
