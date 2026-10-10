// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as nodeTest } from 'node:test'
import { CliHost } from '../dist/host.js'
import { TrustedCommandWorkspace } from '../dist/commands.js'
import { createBuiltinToolset } from '../dist/tools.js'
import { validateSession } from '../dist/session.js'

// CLI-19 acceptance: production CLI adapters and the installed shared registry.
// Providers, storage hooks and executor promises are inert, owned offline fixtures.
const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn)
const settings = { provider: 'openai', model: 'owned-scope-offline-fixture' }
const tick = () => new Promise(resolve => setImmediate(resolve))
const call = (name = 'fixture', arguments_ = {}, id = 'owned-call') => ({ id, name, arguments: arguments_ })
const answer = (content = 'Owned fixture finished', toolCalls = []) => ({ content, toolCalls })
const extension = (name = 'fixture', execute = () => ({ content: name })) => ({
  id: `${name}-extension`, apiVersion: 1, tools: [{
    definition: { name, description: 'Owned offline scope fixture', parameters: { type: 'object' } },
    validateArguments() {}, execute
  }]
})
const toolHost = () => ({ enableNotes: true, now: () => new Date('2026-10-10T00:00:00.000Z'),
  readNotes: () => ({ revision: 0, notes: {} }),
  async commitNote() { assert.fail('Unexpected note commit') },
  async approve() { assert.fail('Unexpected approval') }
})
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
async function promptly(promise, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle promptly`)), 1500)
    })])
  } finally { clearTimeout(timer) }
}
function includesError(error, original) {
  return error === original || error?.cause && includesError(error.cause, original) ||
    Array.isArray(error?.errors) && error.errors.some(child => includesError(child, original))
}
function memoryStore(onSave) {
  return { snapshots: [], async save(session, options) {
    await onSave?.(session, options)
    this.snapshots.push(validateSession(structuredClone(session)))
  }, async load(id) { return structuredClone(this.snapshots.findLast(session => session.id === id)) } }
}
async function fixture(t, input = {}) {
  const store = input.store ?? memoryStore()
  const options = { settings, store, provider: { async generate() { return answer() } }, ...input }
  const host = await CliHost.create(options)
  t.after(async () => { await Promise.allSettled([host.shutdown()]) })
  return { host, store, options }
}

test('CLI toolset seals synchronously, memoizes disposal and attempts every reverse cleanup', async t => {
  const toolset = createBuiltinToolset(), held = gate(t), calls = []
  const first = new Error('Owned first cleanup failure'), last = new Error('Owned last cleanup failure')
  toolset.defer(() => { calls.push('first'); throw first })
  toolset.defer(async () => { calls.push('middle'); held.enter(); await held.wait })
  toolset.defer(() => { calls.push('last'); throw last })
  t.after(async () => { held.release(); await Promise.allSettled([toolset.dispose()]) })
  const disposing = toolset.dispose(), observed = observe(disposing)
  assert.equal(toolset.signal.aborted, true)
  assert.equal(toolset.dispose(), disposing)
  assert.throws(() => toolset.defer(() => {}), /not open|closed|closing/i)
  await held.entered
  assert.deepEqual(calls, ['last', 'middle'])
  assert.equal(observed.settled, false)
  held.release()
  await observed.done
  assert(observed.error instanceof AggregateError)
  assert.deepEqual(observed.error.errors, [last, first])
  assert.deepEqual(calls, ['last', 'middle', 'first'])
  assert.equal(toolset.dispose(), disposing)
  await assert.rejects(toolset.dispose(), error => error === observed.error)
})

test('retained disposed CLI toolsets cannot dispatch built-ins or acquire a replacement owner', async t => {
  let oldEntries = 0, nextEntries = 0, hostEntries = 0
  const oldPack = extension('fixture', () => { oldEntries++; return { content: 'old' } })
  const nextPack = extension('fixture', () => { nextEntries++; return { content: 'next' } })
  const old = createBuiltinToolset(true, [oldPack]), next = createBuiltinToolset(true, [nextPack])
  const host = { ...toolHost(), now() { hostEntries++; return new Date() },
    readNotes() { hostEntries++; return { revision: 0, notes: {} } },
    async approve() { hostEntries++; return true }, async commitNote() { hostEntries++; return 1 } }
  t.after(async () => { await Promise.allSettled([old.dispose(), next.dispose()]) })
  const advertised = structuredClone(old.tools), caller = new AbortController()
  assert.equal((await old.executeTool(call(), caller.signal, host)).content, 'old')
  await old.dispose()
  for (const request of [call(), call('calculate', { expression: '1+1' }), call('current_time'), call('note_read'),
    call('note_set', { key: 'owned', value: 'fixture', expectedRevision: 0 })]) {
    await assert.rejects(old.executeTool(request, caller.signal, host), { name: 'AbortError' })
  }
  assert.deepEqual(old.tools, advertised, 'Closing retains fixed advertised facts')
  assert.equal(oldEntries, 1); assert.equal(hostEntries, 0)
  assert.equal(next.signal.aborted, false)
  assert.equal((await next.executeTool(call(), caller.signal, host)).content, 'next')
  assert.equal(nextEntries, 1)
})

for (const domain of ['custom', 'memory', 'workspace', 'skills', 'commands', 'mcp']) {
  test(`CLI ${domain} dispatch combines caller and owner cancellation without leaking listeners`, async t => {
    const names = { custom: 'fixture', memory: 'list_memories', workspace: 'workspace_list',
      skills: 'list_skills', commands: 'command_start', mcp: 'mcp_owned_fixture' }
    for (const source of ['caller', 'owner']) {
      const held = gate(t), caller = new AbortController(), reason = new Error(`Owned ${source} cancellation`)
      let executionSignal
      const pack = extension(names[domain], (_call, { signal }) => {
        executionSignal = signal; held.enter(); return held.wait.then(() => ({ content: 'obsolete success' }))
      })
      const packs = [false, [], undefined, undefined, undefined, undefined, undefined]
      if (domain === 'custom') packs[1] = [pack]
      else packs[{ memory: 2, workspace: 3, skills: 4, commands: 5, mcp: 6 }[domain]] = pack
      const toolset = createBuiltinToolset(...packs)
      t.after(async () => { held.release(); await Promise.allSettled([toolset.dispose()]) })
      const execution = observe(toolset.executeTool(call(names[domain]), caller.signal, toolHost()))
      await held.entered
      assert.notEqual(executionSignal, caller.signal)
      assert.equal(executionSignal.aborted, false)
      if (source === 'caller') caller.abort(reason)
      else await promptly(toolset.dispose(), 'Owned toolset disposal')
      assert.equal(executionSignal.aborted, true)
      assert.equal(executionSignal.reason, source === 'caller' ? reason : toolset.signal.reason)
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
      assert.equal(execution.settled, false, 'Direct registry awaits arbitrary executor promises')
      held.release()
      await execution.done
      assert.equal(execution.error, executionSignal.reason)
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
      await toolset.dispose()
      assert.equal(getEventListeners(toolset.signal, 'abort').length, 0)
    }
  })
}

for (const boundary of ['checkpoint', 'display callback']) {
  for (const cancellation of ['caller abort', 'shutdown']) {
    test(`actual CLI ${cancellation} drains a non-MCP ${boundary} and final durable settlement`, async t => {
      const blocked = gate(t), terminal = gate(t), caller = new AbortController(), displayed = []
      let eventCheckpointSeen = false, terminalCheckpointSeen = false, cancelRequested = false
      const store = memoryStore(async session => {
        if (!session.history.some(message => message.kind === 'assistant')) return
        if (!eventCheckpointSeen) {
          eventCheckpointSeen = true
          if (boundary === 'checkpoint') { blocked.enter(); await blocked.wait }
        } else if (cancelRequested && !terminalCheckpointSeen) {
          terminalCheckpointSeen = true; terminal.enter(); await terminal.wait
        }
      })
      const { host } = await fixture(t, { store, async onEvent(event) {
        displayed.push(structuredClone(event))
        if (boundary === 'display callback' && event.type === 'assistant') { blocked.enter(); await blocked.wait }
      } })
      const sending = observe(host.send('Owned generic event', caller.signal))
      await blocked.entered
      cancelRequested = true
      let shutting
      if (cancellation === 'shutdown') shutting = observe(host.shutdown())
      else caller.abort(new Error('Owned caller cancellation'))
      await tick()
      assert.equal(sending.settled, false, 'Admitted callback must settle before releasing the turn')
      assert.equal(host.running, true)
      if (shutting) assert.equal(shutting.settled, false, 'Shutdown owns the active turn drain')
      assert.equal(displayed.length, boundary === 'checkpoint' ? 0 : 1)
      blocked.release()
      await terminal.entered
      assert.equal(sending.settled, false, 'Final canonical checkpoint remains owned')
      if (shutting) assert.equal(shutting.settled, false, 'Shutdown must await final durable settlement')
      terminal.release()
      await sending.done
      assert.equal(sending.error, undefined)
      assert.equal(sending.value.status, 'cancelled')
      assert.equal(host.running, false)
      assert.equal(displayed.length, boundary === 'checkpoint' ? 0 : 1)
      assert.deepEqual((await store.load(host.session.id)).history, sending.value.history)
      assert.deepEqual(host.session.history, sending.value.history)
      assert.equal(sending.value.history.filter(message => message.kind === 'assistant').length, 1)
      assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
      if (shutting) { await shutting.done; assert.equal(shutting.error, undefined) }
    })
  }
}

test('actual CLI shutdown makes retained provider callbacks inert without waiting for a late provider', async t => {
  const providerHeld = gate(t), displayed = [], caller = new AbortController()
  let progress
  const { host, store } = await fixture(t, { provider: { async generate(_input, _signal, options) {
    progress = options.onProgress
    await progress({ type: 'text_delta', text: 'admitted progress' })
    providerHeld.enter(); await providerHeld.wait
    return answer('OBSOLETE_PROVIDER_SUCCESS')
  } }, onEvent: event => displayed.push(structuredClone(event)) })
  const sending = observe(host.send('Owned blocked provider', caller.signal))
  await providerHeld.entered
  await promptly(host.shutdown(), 'CLI shutdown with an uncooperative provider')
  await sending.done
  assert.equal(sending.error, undefined); assert.equal(sending.value.status, 'cancelled')
  const settledSession = host.session, writes = store.snapshots.length, settledResult = structuredClone(sending.value)
  await progress({ type: 'text_delta', text: 'OBSOLETE_CALLBACK' })
  providerHeld.release(); await tick()
  await progress({ type: 'text_delta', text: 'OBSOLETE_CALLBACK_AFTER_PROVIDER' })
  assert.deepEqual(displayed, [{ type: 'text_delta', text: 'admitted progress' }])
  assert.equal(store.snapshots.length, writes)
  assert.deepEqual(host.session, settledSession)
  assert.deepEqual(sending.value, settledResult)
  assert.equal(JSON.stringify(store.snapshots).includes('OBSOLETE_'), false)
  await assert.rejects(host.send('Cannot reuse closed host'), /host is shut down/i)
})

test('actual CLI cancellation promptly releases an uncooperative extension and ignores its late result', async t => {
  const held = gate(t), caller = new AbortController()
  let executionSignal, executions = 0, generations = 0
  const pack = extension('fixture', (_call, { signal }) => {
    executions++; executionSignal = signal; held.enter()
    return held.wait.then(() => ({ content: 'OBSOLETE_EXECUTOR_SUCCESS' }))
  })
  const { host, store } = await fixture(t, { extensions: [pack], provider: { async generate() {
    generations++; return answer('', [call()])
  } } })
  const sending = host.send('Owned uncooperative extension', caller.signal)
  await held.entered
  host.cancel()
  const result = await promptly(sending, 'CLI cancellation of an arbitrary executor promise')
  assert.equal(result.status, 'cancelled')
  assert.equal(executionSignal.aborted, true)
  assert.equal(host.running, false)
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
  const cancelledResult = structuredClone(result), cancelledSession = host.session, writes = store.snapshots.length
  const toolResult = result.history.find(message => message.kind === 'tool_result')
  assert.equal(JSON.parse(toolResult.content).error.code, 'cancelled')
  held.release(); await tick()
  assert.equal(executions, 1); assert.equal(generations, 1)
  assert.deepEqual(result, cancelledResult); assert.deepEqual(host.session, cancelledSession)
  assert.equal(store.snapshots.length, writes)
  assert.deepEqual((await store.load(host.session.id)).history, result.history)
  assert.equal(JSON.stringify(store.snapshots).includes('OBSOLETE_EXECUTOR_SUCCESS'), false)
})

test('actual CLI keeps definitions and executors fixed for a turn and adopts changed packs only next turn', async t => {
  const pack = extension('fixture', () => ({ content: 'captured executor' })), packs = [pack]
  pack.tools[0].definition.description = 'captured definition'
  const extra = extension('next_fixture', () => ({ content: 'next executor' }))
  let mutate = false, mutated = false, turn = 0, round = 0, oldExecutions = 0, newExecutions = 0
  pack.tools[0].execute = () => { oldExecutions++; return { content: 'captured executor' } }
  const store = memoryStore(async session => {
    if (!mutate || mutated || !session.history.some(message => message.kind === 'message' && message.role === 'user')) return
    mutated = true
    pack.tools[0].definition.description = 'changed definition'
    pack.tools[0].execute = () => { newExecutions++; return { content: 'changed executor' } }
    packs.push(extra)
  })
  const { host } = await fixture(t, { store, extensions: packs, provider: { async generate({ tools, messages }) {
    const fixtureTool = tools.find(tool => tool.name === 'fixture')
    assert.equal(fixtureTool.description, turn === 1 ? 'captured definition' : 'changed definition')
    assert.equal(tools.some(tool => tool.name === 'next_fixture'), turn === 2)
    if (++round === 1) return answer('', [call('fixture', {}, `owned-turn-${turn}`)])
    assert.equal(messages.at(-1).content, turn === 1 ? 'captured executor' : 'changed executor')
    return answer()
  } } })
  mutate = true; turn = 1
  const first = await host.send('Capture first turn')
  assert.equal(first.status, 'completed'); assert.equal(oldExecutions, 1); assert.equal(newExecutions, 0)
  turn = 2; round = 0
  const second = await host.send('Capture replacement turn')
  assert.equal(second.status, 'completed'); assert.equal(oldExecutions, 1); assert.equal(newExecutions, 1)
  assert.deepEqual((await store.load(host.session.id)).history, second.history)
})

test('actual CLI repeated successful and failed setup releases only its caller forwarding listeners', async t => {
  const caller = new AbortController(), sentinel = () => {}, packs = []
  caller.signal.addEventListener('abort', sentinel)
  t.after(() => caller.signal.removeEventListener('abort', sentinel))
  const baseline = getEventListeners(caller.signal, 'abort')
  let generations = 0
  const { host } = await fixture(t, { extensions: packs, provider: { async generate() {
    generations++; return answer()
  } } })
  for (let index = 0; index < 12; index++) {
    assert.equal((await host.send(`Owned successful setup ${index}`, caller.signal)).status, 'completed')
    assert.deepEqual(getEventListeners(caller.signal, 'abort'), baseline)
    packs.push(extension('current_time'))
    const before = host.session
    await assert.rejects(host.send(`Owned failed setup ${index}`, caller.signal), /Tool name collision/)
    assert.equal(host.running, false)
    assert.deepEqual(host.session, before)
    assert.deepEqual(getEventListeners(caller.signal, 'abort'), baseline)
    packs.pop()
  }
  assert.equal(generations, 12)
  await host.shutdown()
  assert.deepEqual(getEventListeners(caller.signal, 'abort'), baseline)
})

test('actual CLI partial registration failure rolls back only its candidate and permits a fresh turn', async t => {
  let predecessorEntries = 0, candidateEntries = 0, generations = 0
  const predecessor = createBuiltinToolset(false, [extension('established', () => {
    predecessorEntries++; return { content: 'published predecessor' }
  })])
  t.after(() => predecessor.dispose())
  const partial = extension('candidate', () => { candidateEntries++; return { content: 'partial candidate' } })
  partial.tools.push({ ...extension('current_time').tools[0] })
  const packs = [extension('early_candidate'), partial], caller = new AbortController()
  const { host } = await fixture(t, { extensions: packs, provider: { async generate() {
    generations++; return answer()
  } } })
  const before = host.session
  await assert.rejects(host.send('Reject the partial candidate', caller.signal), /Tool name collision/)
  assert.deepEqual(host.session, before); assert.equal(host.running, false)
  assert.equal(generations, 0); assert.equal(candidateEntries, 0)
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
  assert.equal(predecessor.signal.aborted, false)
  assert.equal((await predecessor.executeTool(call('established'), caller.signal, toolHost())).content, 'published predecessor')
  assert.equal(predecessorEntries, 1)
  packs.splice(0, packs.length, extension('fresh_candidate'))
  assert.equal((await host.send('Set up a fresh candidate', caller.signal)).status, 'completed')
  assert.equal(generations, 1); assert.equal(predecessor.signal.aborted, false)
})

test('actual CLI note review preserves its exact host owner while execution uses a scoped signal', async t => {
  let generations = 0, approvals = 0
  const caller = new AbortController()
  const { host, store } = await fixture(t, { enableNotes: true, async approve(_request, signal) {
    approvals++; assert.notEqual(signal, caller.signal); assert.equal(signal.aborted, false); return true
  }, provider: { async generate({ messages }) {
    if (++generations === 1) return answer('', [call('note_set', { key: 'owned', value: 'saved fixture', expectedRevision: 0 })])
    const result = JSON.parse(messages.at(-1).content)
    assert.equal(result.success, true); assert.equal(result.revision, 1)
    return answer()
  } } })
  const result = await host.send('Save the owned note', caller.signal)
  assert.equal(result.status, 'completed'); assert.equal(approvals, 1)
  assert.deepEqual(host.session.notes, { owned: 'saved fixture' }); assert.equal(host.session.noteRevision, 1)
  assert.deepEqual((await store.load(host.session.id)).notes, host.session.notes)
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
})

test('actual CLI command process remains cancellable after command_start scoped dispatch settles', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-cli-owned-command-scope-')), blocked = gate(t)
  const workspace = await TrustedCommandWorkspace.open(directory, process.env)
  t.after(async () => { await workspace.shutdown(); await rm(directory, { recursive: true, force: true }) })
  let executionId, executionOwner, startSignal, lifetimeSignal, endRuns = 0
  const start = workspace.start.bind(workspace), endRun = workspace.endRun.bind(workspace)
  workspace.start = async (request, context, signal, lifetime) => {
    executionOwner = `${context.launchId}:${context.sessionId}:${context.runId}`
    startSignal = signal; lifetimeSignal = lifetime
    const result = await start(request, context, signal, lifetime)
    executionId = JSON.parse(result.content).executionId
    return result
  }
  workspace.endRun = async () => { endRuns++; await endRun() }
  const { host } = await fixture(t, { commandWorkspace: workspace,
    commandApproval: { isAvailable: () => true, accountRevision: () => 'owned-fixture-account' },
    async approve() { return true },
    provider: { async generate() {
      return answer('', [call('command_start', { executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'], yieldMs: 0, timeoutMs: 10000 })])
    } }, async onEvent(event) {
      if (event.type === 'tool_completed') { blocked.enter(); await blocked.wait }
    } })
  assert.equal(await host.enableCommands(), true)
  const sending = observe(host.send('Run the inert owned command fixture'))
  await blocked.entered
  assert.equal(typeof executionId, 'string')
  assert.notEqual(startSignal, lifetimeSignal)
  assert.equal(startSignal.aborted, false); assert.equal(lifetimeSignal.aborted, false)
  assert.equal(JSON.parse((await workspace.poll(executionId, executionOwner)).content).state, 'running')
  host.cancel()
  assert.equal(lifetimeSignal.aborted, true)
  const terminal = await promptly((async () => {
    for (;;) {
      const result = JSON.parse((await workspace.poll(executionId, executionOwner)).content)
      if (result.state !== 'running') return result
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  })(), 'Owned command cancellation before event drain')
  assert.equal(terminal.state, 'cancelled')
  assert.equal(endRuns, 0, 'Process cancellation does not depend on endRun after the blocked callback')
  assert.equal(sending.settled, false)
  blocked.release(); await sending.done
  assert.equal(sending.error, undefined); assert.equal(sending.value.status, 'cancelled')
  assert.equal(endRuns, 1)
  assert.equal(getEventListeners(lifetimeSignal, 'abort').length, 0)
})

test('actual CLI per-turn scope disposal leaves the application-owned MCP manager open', async t => {
  let captures = 0, closes = 0
  const manager = { addSecrets() {}, async captureCatalogs(signal) {
    signal.throwIfAborted(); captures++; return []
  }, async close() { closes++ } }
  const { host } = await fixture(t, { mcp: manager })
  assert.equal((await host.send('First owned manager turn')).status, 'completed')
  assert.equal((await host.send('Second owned manager turn')).status, 'completed')
  assert.equal(captures, 2); assert.equal(closes, 0)
  await host.shutdown()
  assert.equal(closes, 0, 'MCP connections belong to the application, including across session-host shutdown')
  await manager.close(); assert.equal(closes, 1)
})

test('actual CLI rejected admitted non-MCP display work remains observable after cancellation', async t => {
  const held = gate(t), failure = new Error('Owned admitted display failure'), caller = new AbortController()
  const { host } = await fixture(t, { async onEvent(event) {
    if (event.type !== 'assistant') return
    held.enter(); await held.wait; throw failure
  } })
  const sending = observe(host.send('Owned rejected display', caller.signal))
  await held.entered
  host.cancel(); await tick()
  assert.equal(sending.settled, false)
  held.release(); await sending.done
  assert(includesError(sending.error, failure), 'Cancellation must not swallow a rejected admitted callback')
  assert.equal(host.running, false)
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
})

test('actual CLI drains detached progress rejection after provider failure while its turn owner remains open', async t => {
  const held = gate(t), caller = new AbortController(), displayed = []
  const displayFailure = new Error('Owned detached progress display failure')
  const providerFailure = new Error('Owned provider failure while display work remains pending')
  const prompt = 'Owned detached progress fixture'
  let providerSignal
  const { host, store } = await fixture(t, { provider: { async generate(_input, signal, options) {
    providerSignal = signal
    // This provider's failure closes its round and detaches the progress wait,
    // without cancelling the CLI turn or releasing already admitted display work.
    void options.onProgress({ type: 'text_delta', text: 'Owned uncommitted progress' }).catch(() => {})
    await held.entered
    throw providerFailure
  } }, async onEvent(event) {
    displayed.push(structuredClone(event))
    if (event.type === 'text_delta') { held.enter(); await held.wait; throw displayFailure }
  } })
  const sending = observe(host.send(prompt, caller.signal))
  await held.entered
  await tick()
  assert.equal(providerSignal.aborted, true, 'Only the failed provider round has closed')
  assert.equal(caller.signal.aborted, false)
  assert.equal(host.running, true)
  assert.equal(sending.settled, false, 'The host still owns the detached display callback')
  assert.deepEqual(host.session.history, [{ kind: 'message', role: 'user', content: prompt }])
  held.release(); await sending.done
  assert(includesError(sending.error, displayFailure), 'An admitted callback failure must survive provider-round closure')
  assert(sending.error.errors.some(error => error.errors?.some(error =>
    error.code === 'provider_error' && error.message === providerFailure.message)),
  'The detached callback cleanup error must retain the stronger canonical core failure too')
  assert.equal(host.running, false)
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
  assert.deepEqual(displayed, [{ type: 'text_delta', text: 'Owned uncommitted progress' }])
  const persisted = await store.load(host.session.id)
  assert.deepEqual(persisted.history, [{ kind: 'message', role: 'user', content: prompt }])
  assert.deepEqual(persisted.history, host.session.history)
  assert.deepEqual(persisted.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  assert.equal(store.snapshots.length, 3, 'Initialization, prompt and unchanged canonical terminal state are checkpointed')
})

for (const action of ['shutdown', 'drainMcp']) {
  test(`actual CLI rejects an event callback awaiting its own ${action} without deadlocking`, async t => {
    let subject, attempted = false, callbackFailure
    const caller = new AbortController()
    subject = await fixture(t, { async onEvent(event) {
      if (event.type !== 'assistant' || attempted) return
      attempted = true
      try { await subject.host[action]() }
      catch (error) { callbackFailure = error; throw error }
    } })
    const result = await promptly(subject.host.send('Owned reentrant callback fixture', caller.signal),
      `CLI callback awaiting its own ${action}`)
    assert(callbackFailure instanceof Error)
    assert.match(callbackFailure.message, /cannot await its own/i)
    assert.equal(result.status, 'error'); assert.equal(result.error.code, 'event_error')
    assert.equal(result.error.message, callbackFailure.message)
    assert.equal(result.rounds, 1)
    assert.equal(subject.host.running, false)
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
    assert.deepEqual((await subject.store.load(subject.host.session.id)).history, result.history)
    assert.equal(result.history.filter(message => message.kind === 'assistant').length, 1)
    assert.equal((await subject.host.send('A fresh turn remains available')).status, 'completed',
      'Rejected self-drain must not mutate shutdown state or seal a future turn')
  })
}

test('actual CLI permits delayed callback descendants to shut down after delivery and send settle', async t => {
  const delayed = gate(t)
  let subject, descendant, scheduled = false
  subject = await fixture(t, { onEvent(event) {
    if (event.type !== 'assistant' || scheduled) return
    scheduled = true
    descendant = observe(new Promise((resolve, reject) => {
      // The inherited delivery context becomes inactive when this callback returns.
      setImmediate(async () => {
        delayed.enter(); await delayed.wait
        try {
          assert.equal(subject.host.running, false)
          await subject.host.shutdown()
          resolve()
        } catch (error) { reject(error) }
      })
    }))
  } })
  const result = await subject.host.send('Owned delayed callback descendant fixture')
  assert.equal(result.status, 'completed')
  await delayed.entered
  assert.equal(descendant.settled, false)
  delayed.release()
  await promptly(descendant.done, 'Delayed descendant shutdown after delivery settled')
  assert.equal(descendant.error, undefined)
  assert.deepEqual((await subject.store.load(subject.host.session.id)).history, result.history)
  await assert.rejects(subject.host.send('The delayed shutdown completed'), /host is shut down/i)
})

test('actual CLI turn cleanup attempts every independent domain after an earlier cleanup failure', async t => {
  const failure = new Error('Owned command endRun failure'), calls = [], caller = new AbortController()
  const commandWorkspace = { isEnabledFor: () => false, async endRun() { calls.push('commands'); throw failure },
    async shutdown() {} }
  const { host } = await fixture(t, { commandWorkspace,
    memory: { async drain() { calls.push('memory') } }, skills: { async drain() { calls.push('skills') } },
    mcpOutcomes: { async load() { return [] }, async save() {}, async drain() { calls.push('mcp') } } })
  const sending = observe(host.send('Owned failed cleanup', caller.signal))
  await sending.done
  assert(includesError(sending.error, failure))
  const failedCleanup = calls.indexOf('commands')
  assert(failedCleanup >= 0)
  for (const domain of ['mcp', 'memory', 'skills']) {
    assert(calls.indexOf(domain, failedCleanup + 1) > failedCleanup, `${domain} drain must run after command cleanup rejects`)
  }
  assert.equal(host.running, false)
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0)
})

test('actual CLI shutdown attempts every independent cleanup and exposes all failures', async t => {
  const first = new Error('Owned shutdown command failure'), second = new Error('Owned shutdown memory failure'), calls = []
  const { host } = await fixture(t, {
    commandWorkspace: { async shutdown() { calls.push('commands'); throw first } },
    memory: { async drain() { calls.push('memory'); throw second } },
    skills: { async drain() { calls.push('skills') } },
    mcpOutcomes: { async load() { return [] }, async save() {}, async drain() { calls.push('mcp') } }
  })
  const shutting = observe(host.shutdown())
  await shutting.done
  assert(includesError(shutting.error, first)); assert(includesError(shutting.error, second))
  assert.deepEqual([...new Set(calls)].sort(), ['commands', 'mcp', 'memory', 'skills'])
  await assert.rejects(host.send('Cannot re-open after failed shutdown'), /host is shut down/i)
})
