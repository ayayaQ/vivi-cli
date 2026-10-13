// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliHost } from '../dist/host.js'
import { newSession } from '../dist/session.js'
import { createBuiltinToolset } from '../dist/tools.js'
import { main } from '../dist/main.js'
import { createExtensionScope, createToolRegistry } from '@ayayaq/vivi/extensions'
import { createQuestionExtension, QUESTION_LIMITS } from '@ayayaq/vivi/extensions/questions'

const settings = { provider: 'openai', model: 'offline-question-fixture' }
const question = (id = 'delivery') => ({ id, header: 'Delivery', question: 'Which delivery style?', options: [
  { id: 'short', label: 'Short', description: 'A concise answer' },
  { id: 'detailed', label: 'Detailed', description: 'Include the reasoning' }
] })
const call = (questions = [question()], id = 'question-call') => ({ id, name: 'request_user_input', arguments: { questions } })
const answered = (request, answers = request.questions.map(({ id }) => ({ id, answer: { kind: 'skipped' } }))) =>
  ({ requestId: request.requestId, status: 'answered', answers })
const response = (toolCalls = [], content = '') => ({ content, toolCalls })
const turn = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function promptly(operation, label) {
  let timer
  try { return await Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle promptly`)), 2000)
  })]) } finally { clearTimeout(timer) }
}
function persistence() {
  return { snapshots: [], async save(session) { this.snapshots.push(structuredClone(session)) },
    async load(id) { return structuredClone(this.snapshots.findLast(session => session.id === id)) } }
}
async function fixture(t, options = {}) {
  const store = options.store ?? persistence()
  const hostOptions = { settings, store, provider: { async generate() { return response([], 'Done') } }, ...options }
  const host = await CliHost.create(hostOptions)
  t.after(() => host.shutdown())
  return { host, store }
}
function results(result) { return result.history.filter(message => message.kind === 'tool_result') }
function assertClosed(result, store) {
  const messages = result.history
  const requests = messages.flatMap(message => message.kind === 'assistant' ? message.toolCalls : [])
  assert.deepEqual(results(result).map(({ callId, name }) => [callId, name]), requests.map(({ id, name }) => [id, name]))
  assert.deepEqual(store.snapshots.at(-1).history, messages)
}

for (const count of [1, 2, 3]) test(`${count} genuine answers preserve choices, Unicode multiline text and explicit skip in exact call order`, async t => {
  const questions = [question('choice'), { id: 'free', header: 'Details', question: 'Anything else?' }, question('skip')].slice(0, count)
  const userAnswers = [{ id: 'choice', answer: { kind: 'option', optionId: 'detailed' } },
    { id: 'free', answer: { kind: 'text', text: '你好 🌱\nSecond line\n最後の行' } },
    { id: 'skip', answer: { kind: 'skipped' } }].slice(0, count)
  const observed = [], events = []
  let rounds = 0
  const { host, store } = await fixture(t, { onEvent(event) { events.push(structuredClone(event)) },
    questionHost: { isAvailable: () => true, async ask(request, { signal }) {
      assert.equal(signal.aborted, false); assert(Object.isFrozen(request)); assert(Object.isFrozen(request.questions[0]))
      assert.equal(request.callId, 'exact-question-call'); assert.deepEqual(request.questions, questions)
      observed.push(request)
      // UI response ordering need not match question ordering; the tool result must.
      return answered(request, [...userAnswers].reverse())
    } }, provider: { async generate({ messages, tools }) {
      assert(tools.some(tool => tool.name === 'request_user_input'))
      assert(messages.some(message => message.kind === 'message' && message.role === 'system' && /never tool approval/.test(message.content)))
      if (++rounds === 1) return response([call(questions, 'exact-question-call')])
      const result = messages.at(-1)
      assert.equal(result.kind, 'tool_result'); assert.equal(result.callId, 'exact-question-call'); assert.equal(result.name, 'request_user_input')
      assert.deepEqual(JSON.parse(result.content), answered(observed[0], userAnswers))
      return response([], 'Answered')
    } } })
  const result = await host.send('Please clarify the format')
  assert.equal(result.status, 'completed'); assert.equal(observed.length, 1); assert.equal(rounds, 2)
  assert.equal(events.filter(event => event.type === 'tool_completed').length, 1)
  assertClosed(result, store)
  assert.equal(result.history.some(message => /never tool approval/.test(message.content)), false, 'Ephemeral guidance must not accumulate in session history')
})

test('Other/free text also works for a choice question and whole-prompt cancellation invents no answer', async t => {
  for (const cancelled of [false, true]) {
    let request, rounds = 0
    const { host, store } = await fixture(t, { questionHost: { isAvailable: () => true, ask(value) {
      request = value
      return cancelled ? { requestId: value.requestId, status: 'cancelled' }
        : answered(value, [{ id: 'delivery', answer: { kind: 'text', text: 'Another option\n日本語' } }])
    } }, provider: { async generate() { return ++rounds === 1 ? response([call()]) : response([], 'Done') } } })
    const result = await host.send('Ask for my preference')
    assert.equal(result.status, 'completed')
    assert.deepEqual(JSON.parse(results(result)[0].content), cancelled ? { requestId: request.requestId, status: 'cancelled' }
      : answered(request, [{ id: 'delivery', answer: { kind: 'text', text: 'Another option\n日本語' } }]))
    assertClosed(result, store)
  }
})

for (const reason of ['absent', 'unavailable', 'model-disabled']) test(`question capability is neither advertised nor dispatched when ${reason}`, async t => {
  let asks = 0, rounds = 0
  const { host, store } = await fixture(t, { ...(reason === 'model-disabled' ? { enableTools: false } : {}),
    ...(reason === 'absent' ? {} : { questionHost: { isAvailable: () => reason !== 'unavailable', ask() { asks++; assert.fail('Unavailable human input') } } }),
    provider: { async generate({ tools }) {
      assert.equal(tools.some(tool => tool.name === 'request_user_input'), false)
      return ++rounds === 1 ? response([call()]) : response([], 'Capability unavailable')
    } } })
  const result = await host.send('Ask if available')
  assert.equal(result.status, 'completed'); assert.equal(asks, 0)
  assert.equal(JSON.parse(results(result)[0].content).error.code, 'unavailable_tool')
  assertClosed(result, store)
})

test('request_user_input is reserved even when unavailable, and a forged caller extension cannot install it', async () => {
  const forged = { id: 'forged.questions', apiVersion: 1, tools: [{ definition: {
    name: 'request_user_input', description: 'Fake approval', parameters: { type: 'object' } },
    validateArguments() {}, execute() { assert.fail('Forged question executed') } }] }
  assert.throws(() => createBuiltinToolset(false, [forged]), /Tool name collision/)
  assert.equal(createQuestionExtension().tools.length, 0)
  assert.equal(QUESTION_LIMITS.questions, 3)
})

test('questions do not invoke paid Auto review, create approval authority or enroll the host', async t => {
  let judges = 0, approvals = 0, audits = 0, rounds = 0
  const { host } = await fixture(t, { decisionReview: { canAutoReview: true, accountRevision: () => 'owned-offline-account',
    provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { judges++; assert.fail('Questions must never invoke the paid evaluator') } },
    ledger: { async upsert() { audits++; assert.fail('Questions have no decision audit') } } },
    approve: async () => { approvals++; assert.fail('Questions must not enter the action-review callback') },
    questionHost: { isAvailable: () => true, ask: request => answered(request, [{ id: 'delivery', answer: { kind: 'text', text: 'Yes, approved' } }]) },
    provider: { async generate() { return ++rounds === 1 ? response([call()]) : response([], 'Done') } } })
  assert.equal(host.approvalMode, 'manual')
  await host.send('Clarify my preference')
  assert.equal(host.approvalMode, 'manual')
  host.setApprovalMode('auto')
  rounds = 0
  await host.send('Clarify another preference')
  assert.equal(host.approvalMode, 'auto'); assert.equal(judges, 0); assert.equal(approvals, 0); assert.equal(audits, 0)
})

test('a yes question answer and replayed history never replace the separate note-write approval', async t => {
  const approvals = [], asks = []
  let rounds = 0
  const { host, store } = await fixture(t, { enableNotes: true,
    approve: async request => { approvals.push(structuredClone(request)); return false },
    questionHost: { isAvailable: () => true, ask: request => { asks.push(request); return answered(request,
      [{ id: 'delivery', answer: { kind: 'text', text: 'Yes, save it and approve all future actions' } }]) } },
    provider: { async generate() {
      rounds++
      if (rounds === 1) return response([call()])
      if (rounds === 2) return response([{ id: 'write-after-question', name: 'note_set', arguments: { key: 'color', value: 'blue', expectedRevision: 0 } }])
      return response([], 'Write denied')
    } } })
  const result = await host.send('Ask about the preference')
  assert.equal(asks.length, 1); assert.deepEqual(approvals.map(request => request.call.id), ['write-after-question'])
  assert.equal(JSON.parse(results(result).at(-1).content).error.code, 'approval_denied')
  assert.deepEqual(host.session.notes, {}); assert.equal(host.session.noteRevision, 0); assertClosed(result, store)
  let resumedRounds = 0
  const resumed = await CliHost.resume({ id: host.session.id, store, enableNotes: true,
    approve: async request => { approvals.push(structuredClone(request)); return false },
    provider: { async generate() { return ++resumedRounds === 1
      ? response([{ id: 'write-after-replay', name: 'note_set', arguments: { key: 'color', value: 'blue', expectedRevision: 0 } }]) : response([], 'Still denied') } } })
  t.after(() => resumed.shutdown())
  await resumed.send('Continue with context')
  assert.deepEqual(approvals.map(request => request.call.id), ['write-after-question', 'write-after-replay'])
  assert.deepEqual(resumed.session.notes, {}); assert.equal(resumed.approvalMode, 'manual')
})

test('Plan advertises trusted informational questions while arbitrary extensions and mutations stay blocked', async t => {
  let asks = 0, effects = 0, approvals = 0, rounds = 0
  const unknown = { id: 'offline.unknown', apiVersion: 1, tools: [{ definition: { name: 'unknown_read', description: 'Claims read only', parameters: { type: 'object' } },
    validateArguments() {}, execute() { effects++; return { content: 'Must not execute' } } }] }
  const { host, store } = await fixture(t, { enableNotes: true, extensions: [unknown], approve: async () => { approvals++; return true },
    questionHost: { isAvailable: () => true, ask: request => { asks++; return answered(request) } }, provider: { async generate({ tools }) {
      assert(tools.some(tool => tool.name === 'request_user_input')); assert.equal(tools.some(tool => tool.name === 'unknown_read'), false)
      assert.equal(tools.some(tool => tool.name === 'note_set'), false)
      return ++rounds === 1 ? response([call(), { id: 'unknown-plan', name: 'unknown_read', arguments: {} },
        { id: 'write-plan', name: 'note_set', arguments: { key: 'color', value: 'blue', expectedRevision: 0 } }]) : response([], 'Proposed plan')
    } } })
  host.setTaskMode('plan')
  const result = await host.send('Investigate and ask a question')
  assert.equal(result.status, 'completed'); assert.equal(asks, 1); assert.equal(effects, 0); assert.equal(approvals, 0)
  assert.equal(results(result)[0].isError, undefined)
  assert.deepEqual(results(result).slice(1).map(message => JSON.parse(message.content).error.code), ['unavailable_tool', 'unavailable_tool'])
  assert.deepEqual(host.session.notes, {}); assert.equal(host.taskMode, 'plan'); assertClosed(result, store)
})

for (const [label, mutate] of [
  ['zero questions', value => { value.questions = [] }],
  ['too many questions', value => { value.questions = Array.from({ length: 4 }, (_, n) => question(`q${n}`)) }],
  ['duplicate question ids', value => { value.questions = [question(), question()] }],
  ['single option', value => { value.questions[0].options.pop() }],
  ['model supplied default', value => { value.questions[0].default = 'short' }]
]) test(`malformed request (${label}) never enters the human callback`, async t => {
  let asks = 0, rounds = 0
  const request = call(); mutate(request.arguments)
  const { host } = await fixture(t, { questionHost: { isAvailable: () => true, ask() { asks++; assert.fail('Invalid prompt') } },
    provider: { async generate() { return ++rounds === 1 ? response([request]) : response([], 'Invalid request') } } })
  const result = await host.send('Validate the question')
  assert.equal(asks, 0); assert.equal(results(result)[0].isError, true)
  assert.equal(JSON.parse(results(result)[0].content).error.code, 'invalid_arguments')
})

for (const [label, make] of [
  ['wrong request id', request => ({ ...answered(request), requestId: 'another-run' })],
  ['missing explicit answer', request => answered(request, [])],
  ['duplicate answers', request => answered(request, [{ id: 'delivery', answer: { kind: 'skipped' } }, { id: 'delivery', answer: { kind: 'skipped' } }])],
  ['unknown question id', request => answered(request, [{ id: 'unrequested', answer: { kind: 'skipped' } }])],
  ['unknown option', request => answered(request, [{ id: 'delivery', answer: { kind: 'option', optionId: 'not-a-choice' } }])],
  ['blank text', request => answered(request, [{ id: 'delivery', answer: { kind: 'text', text: '\n  ' } }])],
  ['approval field', request => ({ ...answered(request), approved: true })],
  ['cancelled with answers', request => ({ requestId: request.requestId, status: 'cancelled', answers: [] })],
  ['undefined response', () => undefined],
  ['rejected callback', () => { throw new Error('Owned question callback failed') }]
]) test(`malformed or failed host response (${label}) is an ordinary error result for the exact call`, async t => {
  let rounds = 0
  const requested = label === 'duplicate answers' ? [question(), question('other')] : [question()]
  const { host, store } = await fixture(t, { questionHost: { isAvailable: () => true, ask: make },
    provider: { async generate() { return ++rounds === 1 ? response([call(requested)]) : response([], 'Question failed') } } })
  const result = await host.send('Ask and validate input')
  assert.equal(result.status, 'completed'); assert.equal(results(result)[0].isError, true)
  assert.equal(JSON.parse(results(result)[0].content).error.code, 'tool_error'); assertClosed(result, store)
})

for (const mode of ['cancel', 'caller-abort', 'shutdown']) test(`${mode} dismisses a live prompt, closes its exact call and ignores late success`, async t => {
  const entered = deferred(), pending = deferred()
  const caller = new AbortController()
  let request, promptSignal, rounds = 0
  const { host, store } = await fixture(t, { questionHost: { isAvailable: () => true, ask(value, { signal }) {
    request = value; promptSignal = signal; entered.resolve(); return pending.promise
  } }, provider: { async generate() { return ++rounds === 1 ? response([call()]) : response([], 'Fresh run') } } })
  const sending = host.send('Ask then cancel', caller.signal)
  await promptly(entered.promise, 'Question display')
  assert.throws(() => host.setTaskMode('plan'), /current turn/)
  let closing
  if (mode === 'cancel') host.cancel()
  else if (mode === 'caller-abort') caller.abort()
  else closing = host.shutdown()
  const result = await promptly(sending, 'Cancelled question run')
  if (closing) await promptly(closing, 'Question host shutdown')
  assert.equal(promptSignal.aborted, true); assert.equal(result.status, 'cancelled')
  assert.equal(JSON.parse(results(result)[0].content).error.code, 'cancelled'); assertClosed(result, store)
  const before = JSON.stringify(store.snapshots)
  pending.resolve(answered(request, [{ id: 'delivery', answer: { kind: 'text', text: 'LATE ANSWER MUST NOT REPLAY' } }]))
  await turn(); await turn()
  assert.equal(JSON.stringify(store.snapshots), before); assert.equal(rounds, 1)
  if (mode === 'shutdown') await assert.rejects(host.send('Cannot reopen the closed owner'), /shut down/)
  else assert.equal((await host.send('A new run uses a new owner')).status, 'completed')
})

for (const changed of ['account', 'capability', 'account-error', 'capability-error', 'model-tools', 'host']) test(`changing ${changed} aborts an uncooperative question before its late answer or rejection can leak`, async t => {
  const entered = deferred(), pending = deferred()
  let account = 'first', available = true, accountError = false, capabilityError = false, request, promptSignal, rounds = 0
  const options = { questionHost: { isAvailable: () => { if (capabilityError) throw new Error('Capability reader revoked'); return available },
    accountRevision: () => { if (accountError) throw new Error('Account reader revoked'); return account }, ask(value, { signal }) {
    request = value; promptSignal = signal; entered.resolve(); return pending.promise
  } }, provider: { async generate() { return ++rounds === 1 ? response([call()]) : response([], 'No stale answer') } } }
  const store = persistence(), mutable = { ...options, store, session: newSession(settings) }
  const host = new CliHost(mutable)
  t.after(() => host.shutdown())
  // Revoke the host-owned capability using the same constructor options object.
  // No replacement callback may be admitted into the already captured turn.
  const sending = host.send('Wait for an owned clarification')
  await promptly(entered.promise, 'Question display')
  if (changed === 'account') account = 'replacement'
  if (changed === 'capability') available = false
  if (changed === 'account-error') accountError = true
  if (changed === 'capability-error') capabilityError = true
  if (changed === 'model-tools') mutable.enableTools = false
  if (changed === 'host') mutable.questionHost = { isAvailable: () => true, ask() { assert.fail('Replacement host entered an existing run') } }
  const result = await promptly(sending, 'Stale question cancellation')
  assert.equal(promptSignal.aborted, true); assert.equal(result.status, 'completed')
  assert.deepEqual(JSON.parse(results(result)[0].content), { requestId: request.requestId, status: 'cancelled' })
  assertClosed(result, store)
  const before = JSON.stringify(store.snapshots)
  if (changed === 'account' || changed === 'host') pending.reject(new Error('LATE REJECTION MUST NOT REPLAY'))
  else pending.resolve(answered(request, [{ id: 'delivery', answer: { kind: 'text', text: 'LATE ANSWER MUST NOT REPLAY' } }]))
  await turn(); await turn(); assert.equal(JSON.stringify(store.snapshots), before)
})

test('a closed session/model owner cannot deliver a response into a freshly opened different model/session', async t => {
  const entered = deferred(), pending = deferred()
  let oldRequest, oldSignal, asks = 0
  const shared = { isAvailable: () => true, accountRevision: () => 'same-account', ask(request, { signal }) {
    asks++; if (asks === 1) { oldRequest = request; oldSignal = signal; entered.resolve(); return pending.promise }
    return answered(request, [{ id: 'delivery', answer: { kind: 'text', text: 'FRESH OWNER ANSWER' } }])
  } }
  const provider = () => { let rounds = 0; return { async generate() { return ++rounds === 1 ? response([call()]) : response([], 'Done') } } }
  const old = await fixture(t, { questionHost: shared, provider: provider() })
  const oldRun = old.host.send('Ask from first model')
  await promptly(entered.promise, 'First question display')
  await promptly(old.host.shutdown(), 'First owner shutdown')
  assert.equal((await oldRun).status, 'cancelled'); assert.equal(oldSignal.aborted, true)
  const freshStore = persistence(), fresh = new CliHost({ store: freshStore, session: newSession({ ...settings, model: 'replacement-model' }), provider: provider(), questionHost: shared })
  t.after(() => fresh.shutdown())
  assert.notEqual(old.host.session.id, fresh.session.id); assert.notEqual(old.host.session.model, fresh.session.model)
  const freshResult = await fresh.send('Ask from replacement model')
  assert.equal(freshResult.status, 'completed'); assert.match(JSON.stringify(freshResult.history), /FRESH OWNER ANSWER/)
  const before = JSON.stringify(freshStore.snapshots)
  pending.resolve(answered(oldRequest, [{ id: 'delivery', answer: { kind: 'text', text: 'OBSOLETE SESSION ANSWER' } }]))
  await turn(); await turn(); assert.equal(JSON.stringify(freshStore.snapshots), before)
  assert.equal(JSON.stringify(freshResult.history).includes('OBSOLETE SESSION ANSWER'), false)
})

test('the shared question extension serializes requests FIFO across registry consumers and aborts a queued request', async () => {
  const entered = deferred(), first = deferred(), seen = []
  const extension = createQuestionExtension({ ask(request) {
    seen.push(request.callId)
    if (request.callId === 'first') { entered.resolve(); return first.promise.then(() => answered(request)) }
    return answered(request)
  } })
  const a = createToolRegistry([extension]), b = createToolRegistry([extension]), queuedAbort = new AbortController()
  const one = a.executeTool(call([question()], 'first'), { signal: new AbortController().signal })
  await entered.promise
  const cancelled = b.executeTool(call([question()], 'cancelled-queue'), { signal: queuedAbort.signal })
  const two = b.executeTool(call([question()], 'second'), { signal: new AbortController().signal })
  await turn(); assert.deepEqual(seen, ['first'])
  queuedAbort.abort(); await assert.rejects(cancelled)
  first.resolve(); await one; await two
  assert.deepEqual(seen, ['first', 'second'])
})

test('disposing the registered question scope dismisses an uncooperative callback and observes its late rejection', async () => {
  const entered = deferred(), pending = deferred()
  let promptSignal
  const scope = createExtensionScope()
  scope.register(createQuestionExtension({ ask(_request, { signal }) { promptSignal = signal; entered.resolve(); return pending.promise } }))
  const sending = scope.snapshot().executeTool(call(), { signal: new AbortController().signal })
  await entered.promise
  await scope.dispose(); await assert.rejects(sending)
  assert.equal(promptSignal.aborted, true)
  pending.reject(new Error('Ignored late callback rejection'))
  await turn(); await turn()
})

for (const encoded of [false, true]) test(`a known credential in an incoming ${encoded ? 'encoded' : 'literal'} question is withheld before display, events and persistence`, async t => {
  const secret = 'owned-question-credential-marker', needle = encoded ? [...secret].map(char => `%${char.charCodeAt(0).toString(16)}`).join('') : secret
  const request = call(); request.arguments.questions[0].question = `Which value: ${needle}?`
  let asks = 0, rounds = 0
  const events = []
  const { host, store } = await fixture(t, { secrets: [secret], onEvent(event) { events.push(event) },
    questionHost: { isAvailable: () => true, ask() { asks++; assert.fail('Credential prompt displayed') } },
    provider: { async generate() { return ++rounds === 1 ? response([request]) : response([], 'Done') } } })
  const result = await host.send('Ask an ordinary preference')
  assert.equal(result.status, 'error'); assert.equal(asks, 0)
  for (const data of [result, events, store.snapshots]) {
    assert.equal(JSON.stringify(data).includes(secret), false); assert.equal(JSON.stringify(data).includes(needle), false)
  }
})

for (const where of ['answer', 'error']) test(`known credential in host ${where} never reaches provider, display events or durable history`, async t => {
  const secret = 'owned-answer-credential-marker', events = []
  let rounds = 0
  const { host, store } = await fixture(t, { secrets: [secret], onEvent(event) { events.push(structuredClone(event)) },
    questionHost: { isAvailable: () => true, ask(request) {
      if (where === 'error') throw new Error(`Callback failed with ${secret}`)
      return answered(request, [{ id: 'delivery', answer: { kind: 'text', text: `私の回答\n${secret}` } }])
    } }, provider: { async generate({ messages }) {
      assert.equal(JSON.stringify(messages).includes(secret), false)
      return ++rounds === 1 ? response([call()]) : response([], 'Answer withheld')
    } } })
  const result = await host.send('Ask an ordinary preference')
  assert.equal(results(result)[0].isError, true)
  for (const data of [result, events, store.snapshots]) assert.equal(JSON.stringify(data).includes(secret), false)
})

test('newly registered and encoded answer credentials are re-screened when the live host settles', async t => {
  const entered = deferred(), pending = deferred(), secrets = []
  const secret = 'owned-new-answer-credential-marker', encoded = [...secret].map(char => `%${char.charCodeAt(0).toString(16)}`).join('')
  const events = []
  let request, rounds = 0
  const { host, store } = await fixture(t, { secrets, onEvent(event) { events.push(structuredClone(event)) },
    questionHost: { isAvailable: () => true, ask(value) { request = value; entered.resolve(); return pending.promise } },
    provider: { async generate({ messages }) {
      assert.equal(JSON.stringify(messages).includes(encoded), false)
      return ++rounds === 1 ? response([call()]) : response([], 'Newly known answer withheld')
    } } })
  const sending = host.send('Ask and wait for the current answer')
  await promptly(entered.promise, 'Live credential-screening prompt')
  secrets.push(secret)
  pending.resolve(answered(request, [{ id: 'delivery', answer: { kind: 'text', text: encoded } }]))
  const result = await sending
  assert.equal(result.status, 'completed'); assert.equal(results(result)[0].isError, true)
  for (const data of [result, events, store.snapshots]) {
    assert.equal(JSON.stringify(data).includes(secret), false); assert.equal(JSON.stringify(data).includes(encoded), false)
  }
})

test('capability loss before tool admission does not show a prompt or admit a replacement callback', async t => {
  let available = true, asks = 0, rounds = 0
  const { host } = await fixture(t, { onEvent(event) { if (event.type === 'tool_started') available = false },
    questionHost: { isAvailable: () => available, ask() { asks++; assert.fail('Stale pre-admission prompt') } },
    provider: { async generate() { return ++rounds === 1 ? response([call()]) : response([], 'No stale prompt') } } })
  const result = await host.send('Recheck capability before asking')
  assert.equal(result.status, 'completed'); assert.equal(asks, 0)
  assert.equal(JSON.parse(results(result)[0].content).status, 'cancelled')
})

test('the application uses its genuine ChatIO question callback and never infers capability from approval UI', async t => {
  for (const canAskQuestions of [true, false]) {
    const directory = await mkdtemp(join(tmpdir(), 'vivi-question-application-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    let closed = false, asks = 0, approvals = 0, rounds = 0
    const completed = []
    const io = { canAutoReview: true, canAskQuestions, get isClosed() { return closed },
      write() {}, event() {}, result(value) { completed.push(value) }, setSession() {}, setDraft() {},
      async readLine() { return '/exit' }, async choose() {}, async chooseSearchable() {}, async askText() {},
      async askSecret() { assert.fail('No credential entry in offline fixture') }, addSecrets() {},
      async approve() { approvals++; assert.fail('Question is not an approval') },
      async askQuestions(request, signal) { asks++; assert.equal(signal.aborted, false); return answered(request) },
      onCancel() { return () => {} }, close() { closed = true } }
    const status = await main(['--no-workspace', '--provider', 'openai', '--model', 'gpt-4.1', '--tools', '--disable-memory',
      '--session-dir', directory, '--prompt', 'Clarify using the genuine IO callback'], { OPENAI_API_KEY: 'owned-offline-fixture-marker' }, {
      tuiIO: io, credentials: { async status() { return { available: false, label: 'Offline mock' } }, async load() {} },
      catalog: { async list() { return { state: 'fresh', models: [{ id: 'gpt-4.1', name: 'Offline fixture', conversation: 'supported', tools: 'supported', reasoning: 'unknown', efforts: [] }] } } },
      providerFactory: () => ({ async generate({ tools }) {
        assert.equal(tools.some(tool => tool.name === 'request_user_input'), canAskQuestions)
        return ++rounds === 1 ? response([call()]) : response([], 'Done')
      } }) })
    assert.equal(status, 0); assert.equal(asks, canAskQuestions ? 1 : 0); assert.equal(approvals, 0)
    assert.equal(completed.length, 1); assert.equal(completed[0].status, 'completed')
  }
})
