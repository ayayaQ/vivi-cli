// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { CliHost } from '../dist/host.js'
import { validateSession } from '../dist/session.js'
import { SteeringQueue } from '../dist/steering.js'
import { sendChatTurn, runSteeringCommand, TerminalIO } from '../dist/terminal.js'

const settings = { provider: 'openai', model: 'owned-shell-fixture' }
const answer = (content = 'Done', toolCalls = []) => ({ content, toolCalls })
const user = content => ({ kind: 'message', role: 'user', content })
const users = history => history.filter(message => message.kind === 'message' && message.role === 'user')
const observation = content => JSON.parse(content.slice(content.indexOf('\n') + 1))
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred(t) {
  let resolve
  const promise = new Promise(done => { resolve = done })
  t.after(() => resolve())
  return { promise, resolve }
}
function surface() {
  const state = { controls: undefined, queue: [], accepted: [], results: [], writes: [], drafts: [], finishes: [] }
  const io = {
    canAutoReview: true,
    onSteering(controls) { state.controls = controls; return () => { state.controls = undefined } },
    setSteeringQueue(messages) { state.queue = messages },
    steeringAccepted(content, initial) { state.accepted.push({ content, initial }) },
    setComposerDraft(content) { state.drafts.push(content) },
    runStarted() {}, runFinished(value) { state.finishes.push(value) },
    write(value) { state.writes.push(value) }, result(value) { state.results.push(value) },
    onCancel() { return () => {} }, event() {}, close() {},
    async approve() { assert.fail('A live user ! submission must not ask a second time') }
  }
  return { io, state }
}
async function fixture(t, input = {}) {
  const queries = [], shellCalls = [], approvals = [], saves = [], order = []
  let host
  const workspace = {
    directory: '/fixture/project',
    async runUserShell(script, context, signal, lifetime = signal) {
      assert.equal(context.isCurrent(), true)
      assert.equal(context.canApprove(), true)
      shellCalls.push({ script, context, signal, lifetime }); order.push('shell')
      return await input.shell?.({ script, context, signal, lifetime, host }) ?? {
        state: 'exited', executionComplete: true, processEffects: 'unknown', output: 'actual output\n!output-is-not-input',
        exitCode: 7, truncated: false, untrusted: true, shell: '/bin/sh'
      }
    },
    async endRun() { order.push('cleanup'); await input.endRun?.() },
    async shutdown() {}, async disable() {}, async allowProposals() {}
  }
  host = await CliHost.create({ settings,
    commandWorkspace: workspace,
    commandApproval: { isAvailable: () => true, accountRevision: () => 'owned-shell-account' },
    async approve(request) { approvals.push(request); return false },
    store: { async save(value) { saves.push(validateSession(structuredClone(value))); await input.save?.(value, host) } },
    provider: { async generate(request, signal) {
      queries.push(structuredClone(request)); order.push('provider')
      return await input.generate?.(request, signal, queries.length, host) ?? answer()
    } },
    ...input.options
  })
  t.after(() => host.shutdown())
  return { host, workspace, queries, shellCalls, approvals, saves, order }
}

test('a queued shell is a FIFO barrier and its execution authority becomes ordinary data exactly once', () => {
  const queue = new SteeringQueue()
  const first = queue.add('Before'), shell = queue.add('!owned-fixture', 'shell')
  queue.add('After')
  assert.deepEqual(queue.stage(0), [user('Before')])
  assert.deepEqual(queue.stage(0), [])
  queue.acknowledge(user('Before'), 0); queue.release()
  assert.equal(queue.messages[0].id, shell.id)
  assert.deepEqual(queue.stage(1), [], 'Neither a shell nor chat behind it can enter an active turn')
  assert.throws(() => queue.claimShell(first.id, 'Before'))
  queue.claimShell(shell.id, shell.content)
  assert.equal(queue.messages[0].state, 'sending')
  assert.equal(queue.takeLast(), 'After')
  queue.clear()
  assert.equal(queue.messages[0].id, shell.id)
  assert.equal(queue.takeLast(), undefined)
  queue.shellResult(shell.id, 'Observed shell result')
  assert.equal(queue.messages[0].kind, undefined)
  assert.throws(() => queue.claimShell(shell.id, shell.content))
  assert.deepEqual(queue.stage(1), [user('Observed shell result')])
})

test('live ! runs before the provider and supplies one truthful untrusted user envelope with no synthetic tool history', async t => {
  const f = await fixture(t), { io } = surface()
  const result = await sendChatTurn(f.host, io, '!exit 7')
  assert.equal(result.status, 'completed')
  assert.deepEqual(f.order.slice(0, 2), ['shell', 'provider'])
  assert.deepEqual(f.shellCalls.map(call => call.script), ['exit 7'])
  assert.equal(f.approvals.length, 0)
  assert.equal(f.queries.length, 1)
  const input = users(result.history)
  assert.equal(input.length, 1)
  const value = observation(input[0].content)
  assert.equal(value.source, 'user_shell'); assert.equal(value.command, 'exit 7')
  assert.equal(value.shell, '/bin/sh'); assert.equal(value.cwd, '/fixture/project')
  assert.equal(value.result.state, 'exited'); assert.equal(value.result.exitCode, 7)
  assert.equal(value.result.processEffects, 'unknown'); assert.equal(value.result.untrusted, true)
  assert.match(value.result.output, /!output-is-not-input/)
  assert.equal(result.history.filter(message => message.kind === 'assistant').length, 1)
  assert(!result.history.some(message => message.kind === 'tool_result'))
  assert.deepEqual(f.host.queuedMessages, [])
  assert.deepEqual(f.host.conversationRecords.projection.history.map(entry => entry.message), result.history)
})

test('raw host.send and restored ! history remain data, never a shell submission', async t => {
  const f = await fixture(t)
  const first = await f.host.send('!this-is-ordinary-API-input')
  assert.equal(users(first.history)[0].content, '!this-is-ordinary-API-input')
  assert.equal(f.shellCalls.length, 0)
  const saved = f.host.session
  const resumed = new CliHost({ session: saved, commandWorkspace: f.workspace,
    commandApproval: { isAvailable: () => true, accountRevision: () => 'fresh-account' },
    store: { async save(value) { validateSession(value) } },
    provider: { async generate() { return answer('Resumed') } }
  })
  t.after(() => resumed.shutdown())
  await resumed.initialize()
  assert.deepEqual(resumed.queuedMessages, [])
  await resumed.send('Continue this conversation')
  assert.equal(f.shellCalls.length, 0)
})

test('busy ! waits for the completed turn and cleanup; later chat cannot overtake the shell', { timeout: 10000 }, async t => {
  const entered = deferred(t), release = deferred(t), cleaning = deferred(t), cleaned = deferred(t)
  const { io, state } = surface()
  let cleanups = 0
  const f = await fixture(t, {
    async generate(request, _signal, round) {
      if (round === 1) return answer('', [{ id: 'ordinary-tool', name: 'inert_fixture', arguments: {} }])
      if (round === 2) {
        assert(users(request.messages).some(message => message.content === 'Before'))
        assert(!users(request.messages).some(message => message.content === 'After' || message.content.startsWith('!')))
      }
      return answer()
    },
    async endRun() { if (++cleanups === 1) { cleaning.resolve(); await cleaned.promise } },
    options: { extensions: [{ id: 'inert-shell-fixture', apiVersion: 1, tools: [{
      definition: { name: 'inert_fixture', description: 'Inert fixture', parameters: {} }, validateArguments() {},
      async execute() { entered.resolve(); await release.promise; return { content: 'inert result' } }
    }] }] }
  })
  const run = sendChatTurn(f.host, io, 'Start')
  await entered.promise
  assert.equal(state.controls.submit('Before', false), true)
  assert.equal(state.controls.submit('!owned-fixture', false), true)
  assert.equal(state.controls.submit('After', false), true)
  assert.equal(f.shellCalls.length, 0)
  release.resolve(); await cleaning.promise; await tick()
  assert.equal(f.shellCalls.length, 0, 'The shell must wait for current owned cleanup')
  cleaned.resolve()
  const result = await run
  assert.equal(result.status, 'completed')
  assert.equal(f.shellCalls.length, 1)
  const inputs = users(result.history).map(message => message.content)
  assert.deepEqual(inputs.slice(0, 2), ['Start', 'Before'])
  assert.equal(observation(inputs[2]).command, 'owned-fixture')
  assert.equal(inputs[3], 'After')
  assert.deepEqual(f.host.queuedMessages, [])
})

test('ordinary cancel retains an unstarted shell, and an explicit queue send executes it only once', { timeout: 10000 }, async t => {
  const entered = deferred(t), release = deferred(t), { io, state } = surface()
  const f = await fixture(t, { async generate(_request, _signal, round) {
    if (round === 1) { entered.resolve(); await release.promise }
    return answer()
  } })
  const run = sendChatTurn(f.host, io, 'Start')
  await entered.promise
  assert.equal(state.controls.submit('!owned-fixture', false), true)
  const id = f.host.queuedMessages[0].id
  f.host.cancel()
  assert.equal((await run).status, 'cancelled')
  assert.equal(f.shellCalls.length, 0)
  assert.equal(f.host.queuedMessages[0].kind, 'shell')
  await runSteeringCommand(f.host, io, '/queue send')
  assert.equal(f.shellCalls.length, 1)
  await assert.rejects(f.host.sendUserShell(id), /no longer|queued|owned/i)
  assert.equal(f.shellCalls.length, 1)
  release.resolve()
})

test('interactive line input shares the live shell queue and automatic continuation path', { timeout: 10000 }, async t => {
  const entered = deferred(t), release = deferred(t), input = new PassThrough(), output = new PassThrough()
  input.isTTY = true; output.isTTY = true
  let displayed = ''
  output.on('data', chunk => { displayed += chunk.toString() })
  const io = new TerminalIO({ input, output }); t.after(() => io.close())
  const f = await fixture(t, { async generate(_request, _signal, round) {
    if (round === 1) { entered.resolve(); await release.promise }
    return answer()
  } })
  const run = sendChatTurn(f.host, io, 'Start')
  await entered.promise
  input.write('!owned-fixture\n'); await tick()
  assert.equal(f.host.queuedMessages[0].kind, 'shell')
  assert.equal(f.shellCalls.length, 0)
  release.resolve()
  const result = await run
  assert.equal(result.status, 'completed')
  assert.equal(f.shellCalls.length, 1)
  assert.equal(f.queries.length, 2)
  assert(!displayed.includes('Approval required'))
  assert.deepEqual(f.host.queuedMessages, [])
})

test('cancelling a running shell records its actual outcome without starting a provider response', { timeout: 10000 }, async t => {
  const entered = deferred(t), controller = new AbortController(), { io } = surface()
  const f = await fixture(t, { async shell({ signal }) {
    entered.resolve()
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) })
    return { state: 'cancelled', executionComplete: true, processEffects: 'unknown', output: 'partial output',
      signal: 'SIGKILL', exitCode: null, shell: '/bin/sh', truncated: false, untrusted: true }
  } })
  const run = sendChatTurn(f.host, io, '!owned-fixture', controller.signal)
  await entered.promise; controller.abort()
  const result = await run
  assert.equal(result.status, 'cancelled')
  assert.equal(f.shellCalls.length, 1)
  assert.equal(f.queries.length, 0)
  assert.equal(observation(users(f.host.session.history)[0].content).result.state, 'cancelled')
  assert.deepEqual(f.host.queuedMessages, [])
})

test('a post-shell checkpoint failure retains only its observation and retry never executes the command again', async t => {
  let failing = false
  const { io } = surface()
  const f = await fixture(t, {
    shell() { failing = true },
    save(value) { if (failing && users(value.history).length) throw new Error('Owned checkpoint failed after shell') }
  })
  await assert.rejects(sendChatTurn(f.host, io, '!owned-fixture'), /checkpoint failed/)
  assert.equal(f.shellCalls.length, 1); assert.equal(f.queries.length, 0)
  assert.equal(f.host.queuedMessages.length, 1)
  assert.equal(f.host.queuedMessages[0].kind, undefined)
  assert.equal(observation(f.host.queuedMessages[0].content).command, 'owned-fixture')
  failing = false
  await runSteeringCommand(f.host, io, '/queue send')
  assert.equal(f.shellCalls.length, 1); assert.equal(f.queries.length, 1)
  assert.equal(users(f.host.session.history).length, 1)
  assert.deepEqual(f.host.queuedMessages, [])
})

test('a provider failure after shell execution persists the observation and never requeues execution', async t => {
  const f = await fixture(t, { generate() { throw new Error('Owned provider failure') } }), { io } = surface()
  const result = await sendChatTurn(f.host, io, '!owned-fixture')
  assert.equal(result.status, 'error')
  assert.equal(f.shellCalls.length, 1)
  assert.equal(users(f.host.session.history).length, 1)
  assert.equal(observation(users(f.host.session.history)[0].content).result.exitCode, 7)
  assert.deepEqual(f.host.queuedMessages, [])
})

test('an unexpected runner exception preserves unknown effects instead of claiming the shell never ran', async t => {
  const f = await fixture(t, { shell() { throw new Error('Owned runner failed after dispatch entry') } }), { io } = surface()
  const result = await sendChatTurn(f.host, io, '!owned-fixture')
  assert.equal(result.status, 'completed')
  assert.equal(f.shellCalls.length, 1)
  const value = observation(users(result.history)[0].content).result
  assert.equal(value.state, 'failed'); assert.equal(value.executionComplete, false)
  assert.equal(value.processEffects, 'unknown')
  assert.deepEqual(f.host.queuedMessages, [])
})

test('a shell-result display callback failure retains only data and cannot reactivate the consumed command', async t => {
  const f = await fixture(t), { io } = surface()
  const queued = f.host.queueUserShell('!owned-fixture')
  await assert.rejects(f.host.sendUserShell(queued.id, undefined, undefined, undefined,
    () => { throw new Error('Owned shell display failed') }), /display failed/)
  assert.equal(f.shellCalls.length, 1)
  assert.equal(f.host.queuedMessages[0].kind, undefined)
  assert.equal(observation(f.host.queuedMessages[0].content).result.exitCode, 7)
  await runSteeringCommand(f.host, io, '/queue send')
  assert.equal(f.shellCalls.length, 1)
  assert.equal(users(f.host.session.history).length, 1)
})

for (const revoke of ['plan', 'disable']) test(`${revoke} revokes pending executable input but retains ordinary chat`, async t => {
  const f = await fixture(t)
  f.host.queueMessage('Before')
  f.host.queueUserShell('!owned-fixture')
  f.host.queueMessage('After')
  if (revoke === 'plan') f.host.setTaskMode('plan')
  else await f.host.disableCommands()
  assert.deepEqual(f.host.queuedMessages.map(message => message.content), ['Before', 'After'])
  assert(f.host.queuedMessages.every(message => message.kind === undefined))
  assert.equal(f.shellCalls.length, 0)
})

for (const gate of ['plan', 'disabled', 'chat-only', 'noninteractive']) test(`! rejects the ${gate} capability gate without execution or model dispatch`, async t => {
  const options = gate === 'disabled' ? { enableCommands: false } : gate === 'chat-only' ? { enableTools: false }
    : gate === 'noninteractive' ? { commandApproval: { isAvailable: () => false, accountRevision: () => 'owned-shell-account' } } : {}
  const f = await fixture(t, { options }), { io, state } = surface()
  if (gate === 'plan') f.host.setTaskMode('plan')
  await assert.rejects(sendChatTurn(f.host, io, '!owned-fixture'), /requires|unavailable|interactive|mode/i)
  assert.equal(f.shellCalls.length, 0); assert.equal(f.queries.length, 0)
  assert.deepEqual(f.host.queuedMessages, [])
  assert.deepEqual(state.drafts, ['!owned-fixture'])
})

test('known credential scripts are rejected before execution and leave the original draft available', async t => {
  const secret = 'owned-user-shell-private-key'
  const f = await fixture(t, { options: { secrets: [secret] } }), { io, state } = surface()
  await assert.rejects(sendChatTurn(f.host, io, `!echo ${secret}`), /credential|secret/i)
  assert.equal(f.shellCalls.length, 0); assert.equal(f.queries.length, 0)
  assert.deepEqual(f.host.queuedMessages, [])
  assert.equal(state.drafts.length, 1)
})
