// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CliHost } from '../dist/host.js'
import { TrustedCommandWorkspace, captureCommandEnvironment } from '../dist/commands.js'
import { FileMemoryStore } from '../dist/memory.js'
import { FileSessionStore, newSession, SessionCommitError } from '../dist/session.js'
import { ReadOnlyWorkspace } from '../dist/workspace.js'
import { WorkspaceCommitError, workspaceRevision } from '../dist/workspace-edit.js'
import { cliHistoryToolPresentation, cliToolCardView, cliToolPresentationView } from '../dist/tool-presentation.js'

const settings = { provider: 'openai', model: 'offline-all-tool-outcomes-fixture' }
const call = (name, arguments_ = {}, id = `owned-${name}`) => ({ id, name, arguments: arguments_ })
const answer = (toolCalls = []) => ({ content: toolCalls.length ? '' : 'Done', toolCalls })
const resultEntries = host => host.session.history.flatMap((message, index) => message.kind === 'tool_result' ? [{ message, index }] : [])
function presentation(host, name, history = host.session.history, evidence = host.toolPresentationEvidence) {
  const index = history.findIndex(message => message.kind === 'tool_result' && (!name || message.name === name))
  assert(index >= 0, `Expected canonical tool result for ${name ?? 'the tool'}`)
  return cliHistoryToolPresentation(history, index, host.session.id, evidence)
}
function assertEvidence(snapshot, status = 'succeeded', effect = 'confirmed') {
  assert.equal(snapshot.status, status)
  assert.equal(snapshot.effect, effect)
  assert(snapshot.source.reference.startsWith('cli-'), 'Evidence has a concrete host source')
  assert(!snapshot.source.reference.startsWith('cli-session:'), 'Canonical bytes alone are not an outcome source')
  assert.match(snapshot.source.revision, /^[a-f0-9]{64}$/)
  if (status === 'succeeded' && effect === 'confirmed') {
    const view = cliToolPresentationView(JSON.stringify(snapshot))
    assert(!view.warnings.some(warning => /outcome is unknown|effects are unknown|effects are unreported/i.test(warning)))
    const card = cliToolCardView(JSON.stringify(snapshot))
    assert(!/unverified|unknown/.test(card.title)); assert.equal(card.attention, false)
  }
}
async function fixture(t, { initial, setup, ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-all-tool-outcomes-'))
  const root = join(directory, 'project'); await mkdir(root)
  if (initial !== undefined) await writeFile(join(root, 'receipt.txt'), initial)
  const workspace = await ReadOnlyWorkspace.open(root)
  const store = new FileSessionStore(join(directory, 'state'))
  const memory = new FileMemoryStore(join(directory, 'memory'))
  const setupOptions = await setup?.({ directory, root, workspace, store, memory })
  const resumed = []
  let host
  const observations = []
  const onEvent = options.onEvent
  host = await CliHost.create({ store, workspace, settings, approve: async () => true, ...setupOptions,
    ...(options.enableMemory ? { memory } : {}),
    ...options, onEvent(event) {
      if (event.type === 'tool_completed') {
        const history = host.session.history
        const index = history.findLastIndex(message => message.kind === 'tool_result' &&
          message.callId === event.message.callId && message.name === event.message.name)
        observations.push(cliHistoryToolPresentation(history, index, host.session.id, host.toolPresentationEvidence))
      }
      return onEvent?.(event, host)
    } })
  t.after(async () => {
    await host.shutdown()
    for (const restored of resumed) await restored.shutdown()
    await memory.drain({ close: true })
    await rm(directory, { recursive: true, force: true })
  })
  const coldResume = async () => {
    const restored = await CliHost.resume({ id: host.session.id, store,
      provider: { async generate() { assert.fail('Cold replay cannot execute a provider') } } })
    resumed.push(restored)
    return restored
  }
  return { host, root, directory, workspace, store, memory, observations, coldResume }
}
function oneCallProvider(toolCall) {
  let round = 0
  return { async generate() { return ++round === 1 ? answer([toolCall]) : answer() } }
}

for (const name of ['workspace_create_text', 'workspace_edit_text']) {
  test(`${name} has exact live, settled and cold-resume evidence after a real file commit`, async t => {
    const initial = 'header\nold\nfooter\n', final = 'header\nnew\nfooter\n'
    const arguments_ = name === 'workspace_create_text' ? { path: 'receipt.txt', content: final }
      : { path: 'receipt.txt', expectedRevision: workspaceRevision(Buffer.from(initial)), before: 'old', after: 'new' }
    const f = await fixture(t, { ...(name === 'workspace_edit_text' ? { initial } : {}),
      provider: oneCallProvider(call(name, arguments_)) })
    const result = await f.host.send('Make the reviewed workspace text change')
    assert.equal(result.status, 'completed')
    assert.equal(await readFile(join(f.root, 'receipt.txt'), 'utf8'), final)
    assert.equal(f.observations.length, 1)
    assertEvidence(f.observations[0]); assertEvidence(presentation(f.host, name))
    assert.equal(f.host.conversationRecords.projection.outcomes.length, 1)
    const restored = await f.coldResume()
    assert.deepEqual(presentation(restored, name), presentation(f.host, name))
  })
}

test('workspace publication with an unconfirmed durability warning remains a confirmed success', async t => {
  const f = await fixture(t, { provider: oneCallProvider(call('workspace_create_text', { path: 'receipt.txt', content: 'published\n' })) })
  const commit = f.workspace.commitMutation.bind(f.workspace)
  let published = 0
  f.workspace.commitMutation = async (...args) => {
    const result = await commit(...args); published++
    throw new WorkspaceCommitError(result)
  }
  await f.host.send('Create the reviewed text file')
  assert.equal(published, 1); assert.equal(await readFile(join(f.root, 'receipt.txt'), 'utf8'), 'published\n')
  assert.equal(JSON.parse(resultEntries(f.host)[0].message.content).durabilityUnconfirmed, true)
  assertEvidence(presentation(f.host, 'workspace_create_text'))
  const restored = await f.coldResume()
  assert.deepEqual(presentation(restored), presentation(f.host))
})

test('cancellation immediately after actual workspace publication preserves the committed outcome through cold replay', async t => {
  const f = await fixture(t, { provider: oneCallProvider(call('workspace_create_text', { path: 'receipt.txt', content: 'Saved before cancellation\n' })) })
  const commit = f.workspace.commitMutation.bind(f.workspace)
  f.workspace.commitMutation = async (...args) => {
    const result = await commit(...args)
    f.host.cancel()
    return result
  }
  const result = await f.host.send('Create this reviewed file, then cancel the turn')
  assert.equal(result.status, 'cancelled')
  assert.equal(await readFile(join(f.root, 'receipt.txt'), 'utf8'), 'Saved before cancellation\n')
  assertEvidence(presentation(f.host, 'workspace_create_text'))
  const restored = await f.coldResume()
  assert.deepEqual(presentation(restored), presentation(f.host))
})

test('a generic rejection after workspace publication reports uncertain effects rather than asserting no write', async t => {
  const f = await fixture(t, { provider: oneCallProvider(call('workspace_create_text', { path: 'receipt.txt', content: 'Published but unconfirmed\n' })) })
  const commit = f.workspace.commitMutation.bind(f.workspace)
  f.workspace.commitMutation = async (...args) => {
    await commit(...args)
    throw new Error('Fixture callback rejected after publication without a trusted completion receipt')
  }
  await f.host.send('Create the reviewed file')
  assert.equal(await readFile(join(f.root, 'receipt.txt'), 'utf8'), 'Published but unconfirmed\n')
  assertEvidence(presentation(f.host), 'failed', 'unknown')
  const restored = await f.coldResume()
  assert.deepEqual(presentation(restored), presentation(f.host))
})

test('note_set has exact live, settled and cold-resume evidence after durable publication', async t => {
  const f = await fixture(t, { enableNotes: true,
    provider: oneCallProvider(call('note_set', { key: 'receipt', value: 'Saved note', expectedRevision: 0 })) })
  await f.host.send('Save the reviewed session note')
  assert.equal(f.host.session.notes.receipt, 'Saved note'); assert.equal(f.host.session.noteRevision, 1)
  assert.equal((await f.store.load(f.host.session.id)).notes.receipt, 'Saved note')
  assert.equal(f.observations.length, 1)
  assertEvidence(f.observations[0]); assertEvidence(presentation(f.host, 'note_set'))
  const restored = await f.coldResume()
  assert.equal(restored.session.notes.receipt, 'Saved note')
  assert.deepEqual(presentation(restored), presentation(f.host))
})

test('SessionCommitError after note publication cannot relabel the saved note as a failed or unknown effect', async t => {
  const f = await fixture(t, { enableNotes: true,
    provider: oneCallProvider(call('note_set', { key: 'receipt', value: 'Published note', expectedRevision: 0 })) })
  const save = f.store.save.bind(f.store)
  let durabilityFailure = false
  f.store.save = async (session, options) => {
    await save(session, options)
    if (!durabilityFailure && session.noteRevision === 1) {
      durabilityFailure = true
      throw new SessionCommitError(new Error('Fixture post-publication durability confirmation failed'))
    }
  }
  await f.host.send('Save the reviewed session note')
  assert.equal(durabilityFailure, true)
  assert.equal(f.host.session.notes.receipt, 'Published note')
  assert.equal((await f.store.load(f.host.session.id)).notes.receipt, 'Published note')
  assertEvidence(presentation(f.host, 'note_set'))
  const restored = await f.coldResume()
  assert.deepEqual(presentation(restored), presentation(f.host))
})

for (const name of ['create_memory', 'edit_memory', 'delete_memory']) {
  test(`${name} has exact live, settled and cold-resume evidence backed by the actual memory store`, async t => {
    let record, round = 0
    const f = await fixture(t, { enableMemory: true, async setup({ memory }) {
      if (name !== 'create_memory') {
        await memory.commit(await memory.prepareCreate('Original preference', 'user'))
        record = (await memory.list()).memories[0]
      }
    }, provider: { async generate() {
      return ++round === 1 ? answer([call(name, name === 'create_memory' ? { content: 'Saved preference' }
        : { id: record.id, expectedRevision: record.revision, ...(name === 'edit_memory' ? { content: 'Changed preference' } : {}) })]) : answer()
    } } })
    await f.host.send('Make the reviewed saved-memory change')
    const data = await f.memory.list()
    assert.equal(data.memories.length, name === 'delete_memory' ? 0 : 1)
    if (name !== 'delete_memory') assert.equal(data.memories[0].content, name === 'edit_memory' ? 'Changed preference' : 'Saved preference')
    assert.equal(JSON.parse(await readFile(join(f.directory, 'memory', 'memories.json'), 'utf8')).memories.length,
      name === 'delete_memory' ? 0 : 1)
    assert.equal(f.observations.length, 1); assertEvidence(f.observations[0]); assertEvidence(presentation(f.host, name))
    const restored = await f.coldResume()
    assert.deepEqual(presentation(restored, name), presentation(f.host, name))
  })
}

for (const name of ['workspace_create_text', 'note_set']) {
  test(`denied ${name} has durable exact not-attempted evidence and changes no resource`, async t => {
    const arguments_ = name === 'workspace_create_text' ? { path: 'receipt.txt', content: 'Forbidden write' }
      : { key: 'receipt', value: 'Forbidden note', expectedRevision: 0 }
    const f = await fixture(t, { enableNotes: true, approve: async () => false,
      provider: oneCallProvider(call(name, arguments_)) })
    await f.host.send('Propose this reviewed change')
    await assert.rejects(readFile(join(f.root, 'receipt.txt')), { code: 'ENOENT' })
    assert.equal(f.host.session.noteRevision, 0)
    assertEvidence(presentation(f.host, name), 'denied', 'not_attempted')
    const restored = await f.coldResume()
    assert.deepEqual(presentation(restored, name), presentation(f.host, name))
  })
}

for (const name of ['workspace_create_text', 'workspace_edit_text', 'note_set', 'create_memory', 'edit_memory', 'delete_memory']) {
  test(`cancel during ${name} review proves the commit was not attempted`, async t => {
    let host, record, round = 0
    const initial = 'Original workspace text\n'
    const memoryMutation = name.endsWith('_memory')
    const f = await fixture(t, { enableNotes: true, enableMemory: memoryMutation,
      ...(name === 'workspace_edit_text' ? { initial } : {}),
      async setup({ memory }) {
        if (memoryMutation && name !== 'create_memory') {
          await memory.commit(await memory.prepareCreate('Original memory', 'user'))
          record = (await memory.list()).memories[0]
        }
      }, approve: async () => { host.cancel(); return false }, provider: { async generate() {
        const arguments_ = name === 'workspace_create_text' ? { path: 'receipt.txt', content: 'Cancelled write' }
          : name === 'workspace_edit_text' ? { path: 'receipt.txt', expectedRevision: workspaceRevision(Buffer.from(initial)), before: 'Original', after: 'Cancelled' }
          : name === 'note_set' ? { key: 'receipt', value: 'Cancelled note', expectedRevision: 0 }
          : name === 'create_memory' ? { content: 'Cancelled memory' }
          : { id: record.id, expectedRevision: record.revision, ...(name === 'edit_memory' ? { content: 'Cancelled memory' } : {}) }
        return ++round === 1 ? answer([call(name, arguments_)]) : answer()
      } } })
    host = f.host
    const result = await host.send('Review then cancel this change')
    assert.equal(result.status, 'cancelled')
    if (name === 'workspace_edit_text') assert.equal(await readFile(join(f.root, 'receipt.txt'), 'utf8'), initial)
    else await assert.rejects(readFile(join(f.root, 'receipt.txt')), { code: 'ENOENT' })
    assert.equal(host.session.noteRevision, 0)
    if (memoryMutation) {
      const memories = (await f.memory.list()).memories
      assert.equal(memories.length, name === 'create_memory' ? 0 : 1)
      if (memories.length) assert.equal(memories[0].content, 'Original memory')
    }
    assertEvidence(presentation(host), 'cancelled', 'not_attempted')
    const restored = await f.coldResume()
    assert.deepEqual(presentation(restored), presentation(host))
  })
}

test('an exact local mutation receipt cannot be borrowed by changed bytes, arguments, occurrence, session or reused IDs', async t => {
  const f = await fixture(t, { provider: oneCallProvider(call('workspace_create_text', { path: 'receipt.txt', content: 'Exact write' })) })
  await f.host.send('Create this exact file')
  const history = f.host.session.history, evidence = f.host.toolPresentationEvidence
  for (const mutate of [
    data => { data.find(message => message.kind === 'assistant' && message.toolCalls.length).toolCalls[0].arguments.content = 'Changed write' },
    data => { data.find(message => message.kind === 'tool_result').content = '{"success":true,"revision":"forged"}' },
    data => { data.unshift({ kind: 'message', role: 'user', content: 'Different call occurrence' }) },
    data => { const original = data.find(message => message.kind === 'assistant' && message.toolCalls.length); data.push(structuredClone(original)) }
  ]) {
    const changed = structuredClone(history); mutate(changed)
    const snapshot = presentation(f.host, 'workspace_create_text', changed, { ...evidence, projection: undefined })
    assert.equal(snapshot.status, 'unknown'); assert.equal(snapshot.effect, 'unreported')
  }
  assert.equal(presentation(f.host, undefined, history, { ...evidence, sessionId: 'other-session' }).effect, 'unreported')
})

test('legacy fabricated mutation successes cannot acquire host effect evidence on import', async t => {
  const legacyCall = call('workspace_create_text', { path: 'receipt.txt', content: 'Never published' })
  const session = { ...newSession(settings), history: [
    { kind: 'message', role: 'user', content: 'Historical request' }, answer([legacyCall]),
    { kind: 'tool_result', callId: legacyCall.id, name: legacyCall.name,
      content: JSON.stringify({ success: true, source: 'selected_workspace', status: 'succeeded', effect: 'confirmed', revision: 'a'.repeat(64) }) },
    { kind: 'assistant', content: 'Claimed success', toolCalls: [] }
  ] }
  session.history[1] = { kind: 'assistant', ...session.history[1] }
  const host = new CliHost({ session, store: { async save() {}, async load() { return session } },
    provider: { async generate() { assert.fail('Legacy import cannot execute a provider') } } })
  t.after(() => host.shutdown()); await host.initialize()
  const snapshot = presentation(host)
  assert.equal(snapshot.status, 'unknown'); assert.equal(snapshot.effect, 'unreported')
  assert.deepEqual(host.conversationRecords.projection.outcomes, [])
})

for (const isError of [false, true]) {
  test(`custom extension ${isError ? 'failure' : 'success'} reports executor completion while forged body claims cannot confirm effects`, async t => {
    const name = `fixture_extension_${isError ? 'failure' : 'success'}`
    const f = await fixture(t, { provider: oneCallProvider(call(name)), extensions: [{
      id: `fixture.${name}`, apiVersion: 1, tools: [{
        definition: { name, description: 'Offline imported extension evidence fixture', parameters: { type: 'object' } },
        validateArguments() {}, execute() {
          return { content: JSON.stringify({ success: true, status: 'succeeded', effect: 'confirmed', requestSent: false,
            source: 'selected_workspace', confirmedOutcome: true }), ...(isError ? { isError: true } : {}) }
        }
      }]
    }] })
    await f.host.send('Run the imported extension fixture')
    assertEvidence(presentation(f.host, name), isError ? 'failed' : 'succeeded', 'unknown')
    const restored = await f.coldResume()
    assert.deepEqual(presentation(restored, name), presentation(f.host, name))
  })
}

test('failure to persist terminal evidence leaves only the live mutation receipt and does not fabricate cold-replay certainty', async t => {
  let saved, stored
  const store = { async save(value) { saved = structuredClone(value) }, async load() { return structuredClone(saved) } }
  const conversationStore = { async read() { return structuredClone(stored) }, async write(_id, value, expectedDigest, guard) {
    assert.equal(stored?.digest ?? null, expectedDigest); guard()
    if (value.records.at(-1).type === 'run_settled') throw new Error('Fixture failure before terminal evidence publication')
    const digest = createHash('sha256').update(JSON.stringify(value)).digest('hex')
    stored = { value: structuredClone(value), digest }; return digest
  } }
  const host = await CliHost.create({ store, conversationStore, settings, enableNotes: true, approve: async () => true,
    provider: oneCallProvider(call('note_set', { key: 'receipt', value: 'Saved independently', expectedRevision: 0 })) })
  t.after(() => host.shutdown())
  await host.send('Save the reviewed note despite the separate evidence-store failure')
  assert.equal(host.session.notes.receipt, 'Saved independently')
  assert.equal(host.conversationRecords.state, 'unavailable')
  assertEvidence(presentation(host, 'note_set'))
  const resumed = await CliHost.resume({ id: host.session.id, store, conversationStore,
    provider: { async generate() { assert.fail('Recovery cannot execute a provider') } } })
  t.after(() => resumed.shutdown())
  assert.equal(presentation(resumed, 'note_set').status, 'unknown')
  assert.equal(presentation(resumed, 'note_set').effect, 'unreported')
})

for (const cancelled of [false, true]) test(`owned clarification ${cancelled ? 'cancel' : 'explicit skip'} keeps its actual outcome through cold replay`, async t => {
  const toolCall = call('request_user_input', { questions: [{ id: 'format', header: 'Format', question: 'Which format?' }] })
  const f = await fixture(t, { provider: oneCallProvider(toolCall), questionHost: { isAvailable: () => true,
    ask(request) { return cancelled ? { requestId: request.requestId, status: 'cancelled' }
      : { requestId: request.requestId, status: 'answered', answers: [{ id: 'format', answer: { kind: 'skipped' } }] } }
  } })
  await f.host.send('Clarify the format')
  for (const snapshot of [f.observations[0], presentation(f.host), presentation(await f.coldResume())]) {
    assertEvidence(snapshot, cancelled ? 'cancelled' : 'succeeded', 'confirmed')
  }
})

test('owned command exit completion has exact live and cold receipts without claiming arbitrary effects', async t => {
  let round = 0
  const f = await fixture(t, {
    setup: async ({ root }) => ({ commandWorkspace: await TrustedCommandWorkspace.open(root, captureCommandEnvironment(process.env)) }),
    commandApproval: { isAvailable: () => true, accountRevision: () => 'offline-command-account' },
    maxRounds: 25,
    provider: { async generate({ messages }) {
      if (++round === 1) return answer([call('command_start', { executable: process.execPath, args: ['--version'], yieldMs: 0 })])
      const previous = JSON.parse(messages.findLast(message => message.kind === 'tool_result').content)
      // Native Windows process setup and exit are asynchronous. Observe an actual
      // terminal result instead of assuming the first bounded wait completes it.
      return previous.state === 'running'
        ? answer([call('command_poll', { executionId: previous.executionId, yieldMs: 2000 }, `exit-poll-${round}`)]) : answer()
    } }
  })
  await f.host.send('Run the owned local version fixture')
  const entries = resultEntries(f.host), restored = await f.coldResume()
  const terminal = JSON.parse(entries.at(-1).message.content)
  assert.equal(terminal.state, 'exited'); assert.equal(terminal.exitCode, 0)
  assert.equal(f.observations.length, entries.length)
  for (const [position, { message, index }] of entries.entries()) {
    const status = JSON.parse(message.content).state === 'running' ? 'unknown' : 'succeeded'
    for (const snapshot of [f.observations[position],
      cliHistoryToolPresentation(f.host.session.history, index, f.host.session.id, f.host.toolPresentationEvidence),
      cliHistoryToolPresentation(restored.session.history, index, restored.session.id, restored.toolPresentationEvidence)]) {
      assertEvidence(snapshot, status, 'unknown')
    }
  }
})
test('owned command start, poll and stop preserve observed process states through cold replay', async t => {
  let round = 0
  const f = await fixture(t, {
    setup: async ({ root }) => ({ commandWorkspace: await TrustedCommandWorkspace.open(root, captureCommandEnvironment(process.env)) }),
    commandApproval: { isAvailable: () => true, accountRevision: () => 'offline-command-account' },
    provider: { async generate({ messages }) {
      if (++round === 1) return answer([call('command_start', { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], yieldMs: 0, timeoutMs: 5000 })])
      const previous = messages.findLast(message => message.kind === 'tool_result')
      if (round === 2) return answer([call('command_poll', { executionId: JSON.parse(previous.content).executionId, yieldMs: 0 })])
      if (round === 3) return answer([call('command_stop', { executionId: JSON.parse(previous.content).executionId })])
      return answer()
    } }
  })
  await f.host.send('Start, inspect and stop the owned inert fixture process')
  const restored = await f.coldResume()
  for (const [name, status] of [['command_start', 'unknown'], ['command_poll', 'unknown'], ['command_stop', 'cancelled']]) {
    assertEvidence(presentation(f.host, name), status, 'unknown')
    assert.deepEqual(presentation(restored, name), presentation(f.host, name))
  }
})

test('late URL content withholding preserves exact successful retrieval evidence live and cold', async t => {
  const secrets = [], marker = 'offline-late-url-content-marker'
  const f = await fixture(t, { secrets, provider: oneCallProvider(call('fetch_url', { url: 'https://example.com/ordinary' })),
    publicUrlTransport: { async resolve() { return ['8.8.8.8'] }, async request(input) {
      input.onTransmit()
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: { async *[Symbol.asyncIterator]() { yield Buffer.from(marker) } }, close() {} }
    } }, onEvent(event) { if (event.type === 'tool_completed') secrets.push(marker) }
  })
  await f.host.send('Retrieve the selected ordinary page')
  assertEvidence(f.observations[0], 'succeeded', 'unknown')
  for (const host of [f.host, await f.coldResume()]) {
    assertEvidence(presentation(host), 'succeeded', 'unknown')
    const result = host.session.history.find(message => message.kind === 'tool_result')
    const body = JSON.parse(result.content)
    assert.equal(body.success, true); assert.equal(body.contentWithheld, true); assert.equal(result.isError, undefined)
    assert(!JSON.stringify(host.session).includes(marker))
  }
  const rows = await readFile(join(f.directory, 'state', `${f.host.session.id}.public-url-outcomes.json`), 'utf8')
  assert(!rows.includes(marker)); assert.equal(JSON.parse(rows).length, 1, 'Exact safe ledger survives an unavailable shadow')
})

test('possible DNS transmission prevents a fresh-call-ID automatic retry in the same turn', async t => {
  let resolves = 0, round = 0
  const url = 'https://example.com/dns-fixture'
  const f = await fixture(t, { publicUrlTransport: { async resolve() { resolves++; throw new Error('Offline DNS failure') },
    async request() { assert.fail('No HTTP request should follow failed resolution') } },
    provider: { async generate() { return ++round === 1 ? answer([
      call('fetch_url', { url }, 'dns-first'), call('fetch_url', { url }, 'dns-retry')
    ]) : answer() } }
  })
  await f.host.send('Retrieve the exact ordinary page once')
  assert.equal(resolves, 1)
  const snapshots = resultEntries(f.host).map(({ index }) => cliHistoryToolPresentation(f.host.session.history, index, f.host.session.id, f.host.toolPresentationEvidence))
  assertEvidence(snapshots[0], 'failed', 'unknown')
  assertEvidence(snapshots[1], 'denied', 'not_attempted')
})
test('durably represented URL receipts retire after each completed turn', async t => {
  let round = 0, calls = 0, sends = 0
  const f = await fixture(t, { publicUrlTransport: { async resolve() { return ['8.8.8.8'] }, async request(input) {
    sends++; input.onTransmit()
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: { async *[Symbol.asyncIterator]() { yield Buffer.from('fixture') } }, close() {} }
  } }, provider: { async generate() { return ++round % 2 ? answer(Array.from({ length: 3 }, () => {
    const id = `retirement-${++calls}`
    return call('fetch_url', { url: `https://example.com/${id}` }, id)
  })) : answer() } } })
  for (let turn = 0; turn < 2; turn++) {
    assert.equal((await f.host.send(`Retrieve ordinary fixture batch ${turn}`)).status, 'completed')
    const rows = JSON.parse(await readFile(join(f.directory, 'state', `${f.host.session.id}.public-url-outcomes.json`), 'utf8'))
    assert.equal(rows.length, 0, 'Durable exact outcomes replace transient domain receipts after every completed run')
  }
  assert.equal(sends, 6)
  assert.equal(f.host.conversationRecords.state, 'shadow')
})
