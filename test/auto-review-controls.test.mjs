// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { main, parseArguments, decisionProviderForSession, deferredDecisionProvider } from '../dist/main.js'
import { TerminalIO, selectApprovalMode, autoReviewDisclosure, runChatLoop } from '../dist/terminal.js'
import { newSession, FileSessionStore } from '../dist/session.js'
import { PreferenceStore } from '../dist/preferences.js'
import { DEFAULT_PREFERENCES } from '../dist/application.js'
import { CliHost } from '../dist/host.js'
import { autoReviewSharingScope, AUTO_REVIEW_SHARING_REVISION } from '../dist/auto-review.js'

const answer = (toolCalls = []) => ({ content: toolCalls.length ? '' : 'Done', toolCalls })
const call = (id, revision = 0) => ({ id, name: 'note_set', arguments: { key: 'tone', value: 'concise', expectedRevision: revision } })
function fakeIO({ lines = [], approvals = [], choices = [], interactive } = {}) {
  return { output: '', requests: [], modes: [], sessions: [], results: [], choices: [], closed: false,
    ...(interactive === undefined ? {} : { canAutoReview: interactive }),
    get isClosed() { return this.closed },
    async readLine() { return lines.shift() },
    write(text) { this.output += text }, event() {}, result(result) { this.results.push(result) },
    async approve(request, signal) { this.requests.push(request); return typeof approvals[0] === 'function' ? approvals.shift()(this, signal) : approvals.shift() ?? false },
    async choose(title, values, initialIndex) {
      this.choices.push({ title, values, initialIndex })
      const selected = choices.shift()
      assert(selected === undefined || values.some(value => value.value === selected), `Missing choice ${String(selected)} in ${title}`)
      return selected
    },
    async chooseSearchable(_title, values) {
      const value = choices.shift()
      if (value === undefined) return
      assert(values.some(choice => choice.value === value)); return { kind: 'selected', value, query: '' }
    },
    async askText() {}, async askSecret() { return choices.shift() }, addSecrets() {},
    setSession(session) { this.sessions.push(session) }, setDraft() {},
    setApprovalMode(mode) { this.modes.push(mode) },
    onCancel(callback) { this.cancel = callback; return () => { this.cancel = undefined } },
    close() { this.closed = true }
  }
}
function hostStub() {
  let mode = 'manual'
  return { session: newSession({ provider: 'openai', model: 'offline-chat' }), memoryEnabled: false,
    get approvalMode() { return mode }, setApprovalMode(value) { mode = value } }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-auto-controls-'))
  t.after(() => rm(directory, { recursive: true, force: true })); return directory
}
function decisionFactory(captures, provider = 'openai') {
  return (session, env) => {
    captures.push({ type: 'factory', session, env })
    assert.equal(session.provider, provider)
    return { id: provider, model: provider === 'openai' ? 'gpt-6-luna' : 'typesafe/jev-1.13',
      async evaluate(request) {
        captures.push({ type: 'review', request })
        return { model: provider === 'openai' ? 'gpt-6-luna' : 'typesafe/jev-1.13',
          answers: request.policy.checks.map(check => ({ name: check.name, type: 'predicate', probability: 1 })),
          usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } }
      } }
  }
}

test('approval launch option defaults Manual, accepts only exact modes and remains independent of feature gates', () => {
  assert.equal(parseArguments(['--model', 'offline-chat'], {}).approvalMode, 'manual')
  assert.equal(parseArguments(['--model', 'offline-chat', '--approval-mode', 'auto', '--no-tools'], {}).approvalMode, 'auto')
  assert.equal(parseArguments(['--model', 'offline-chat', '--approval-mode', 'auto', '--approval-mode', 'manual'], {}).approvalMode, 'manual')
  for (const value of ['Auto', 'always', 'auto-review']) assert.throws(() => parseArguments(['--model', 'offline-chat', '--approval-mode', value], {}), /must be manual or auto/)
})

test('fixed decision providers use the selected existing account and construct without a live request', () => {
  for (const provider of ['openai', 'openrouter']) {
    const session = newSession({ provider, model: 'different-chat-model' })
    const selected = decisionProviderForSession(session, {})
    assert.equal(selected.id, provider)
    assert.equal(selected.model, provider === 'openai' ? 'gpt-6-luna' : 'typesafe/jev-1.13')
  }
})

test('deferred review never constructs before use and refuses another provider or model without evaluating it', () => {
  const session = newSession({ provider: 'openai', model: 'offline-chat' })
  let factories = 0, evaluations = 0
  const selected = deferredDecisionProvider(session, {}, () => { factories++; return {
    id: 'openrouter', model: 'typesafe/jev-1.13', async evaluate() { evaluations++; throw new Error('Must not run') }
  } })
  assert.equal(factories, 0)
  assert.throws(() => selected.evaluate({}, new AbortController().signal), /does not match/)
  assert.equal(factories, 1); assert.equal(evaluations, 0)
})

test('minimal disclosure identifies recipients, review data, unrequested proposals and additional API cost', () => {
  const openai = autoReviewDisclosure('openai'), router = autoReviewDisclosure('openrouter')
  assert.match(openai, /to OpenAI for approval checks/)
  assert.match(router, /to OpenRouter and TypeSafe for approval checks/)
  for (const disclosure of [openai, router]) {
    for (const text of ['current request', 'proposed note/memory changes', 'before and after',
      'including changes you didn’t request', 'private information', 'extra API charges',
      'only actions judged to match your request', 'full URL including path/query', 'destination', 'method', 'network limits',
      'redirect scope', 'hostname to DNS', 'caller IP', 'GET may have server-side effects or costs', 'known credentials are blocked',
      'sensitive data', 'uncertain checks', 'review failures', 'External content cannot authorize']) assert(disclosure.includes(text), text)
    assert(disclosure.length < 1000)
  }
})
test('fresh confirmation binds possible private-text sharing to named recipients and the displayed revision', async () => {
  for (const provider of ['openai', 'openrouter']) {
    const host = hostStub()
    host.session.provider = provider
    const io = fakeIO({ interactive: true, approvals: [true] })
    await selectApprovalMode(host, io, async () => 'auto')
    const request = io.requests[0]
    assert.equal(host.approvalMode, 'auto')
    assert.deepEqual(request.call.arguments.reviewDataSharing, autoReviewSharingScope(provider))
    assert.equal(request.call.arguments.reviewDataSharing.revision, AUTO_REVIEW_SHARING_REVISION)
    assert.equal(request.call.arguments.reviewDataSharing.includesUnrequestedProposals, true)
    assert.deepEqual(request.call.arguments.reviewDataSharing.recipients, provider === 'openai' ? ['OpenAI'] : ['OpenRouter', 'TypeSafe'])
    assert.equal(request.description, autoReviewDisclosure(provider))
    assert.match(request.description, /including changes you didn’t request/)
    assert.match(request.description, /private information/)
    assert.match(request.description, provider === 'openai' ? /to OpenAI for approval checks/ : /to OpenRouter and TypeSafe for approval checks/)
    assert.equal(io.output.includes(request.description), false)
  }
})
test('account or policy enrollment changes while confirmation is open cannot grant stale sharing consent', async () => {
  for (const change of ['account', 'enrollment']) {
    let account = 'account-one'
    const host = new CliHost({ session: newSession({ provider: 'openai', model: 'offline-chat' }),
      provider: { async generate() { throw new Error('No agent calls') } }, store: { async save() {}, async load() {} },
      decisionReview: { canAutoReview: true, accountRevision: () => account, ledger: { async upsert() {} },
        provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { throw new Error('No decision calls') } } } })
    const io = fakeIO({ interactive: true, approvals: [() => {
      if (change === 'account') account = 'account-two'
      else host.setApprovalMode('manual')
      return true
    }] })
    await selectApprovalMode(host, io, async () => 'auto')
    assert.equal(host.approvalMode, 'manual')
    assert.equal(io.requests[0].call.arguments.enrollmentBinding.length, 64)
    assert.match(io.output, /Enrollment changed/)
  }
})

test('fake IO defaults unavailable; Manual selection and cancelled, denied or closed enrollment never grant Auto', async () => {
  const unavailable = fakeIO(), unavailableHost = hostStub()
  await selectApprovalMode(unavailableHost, unavailable)
  assert.equal(unavailableHost.approvalMode, 'manual'); assert.equal(unavailable.requests.length, 0)
  assert.match(unavailable.output, /piped, headless/)
  for (const selected of ['manual', undefined]) {
    const io = fakeIO({ interactive: true }), host = hostStub()
    await selectApprovalMode(host, io, async (_title, choices, initial) => {
      assert.equal(initial, 0); assert.equal(choices[0].value, 'manual'); return selected
    })
    assert.equal(host.approvalMode, 'manual'); assert.equal(io.requests.length, 0)
  }
  for (const approval of [false, io => { io.cancel(); return true }, io => { io.closed = true; return true }]) {
    const io = fakeIO({ interactive: true, approvals: [approval] }), host = hostStub()
    await selectApprovalMode(host, io, async () => 'auto')
    assert.equal(host.approvalMode, 'manual'); assert.equal(io.requests[0].call.name, 'enroll_auto_review')
  }
})

test('each /mode invocation needs a new exact enrollment and slash arguments cannot act as saved authority', async () => {
  const host = hostStub(), io = fakeIO({ interactive: true, lines: ['/mode auto', '/mode', '/mode', '/exit'], approvals: [true, false] })
  await runChatLoop(host, io)
  assert.match(io.output, /Use \/mode by itself/)
  assert.equal(io.requests.length, 2)
  assert.notEqual(io.requests[0].call.id, io.requests[1].call.id)
  assert.equal(host.approvalMode, 'manual')
})

test('piped launch auto and queued allow stay Manual without constructing or calling a decision provider', async t => {
  const directory = await fixture(t), input = new PassThrough(), output = new PassThrough()
  let text = ''; output.on('data', data => { text += data.toString() })
  const io = new TerminalIO({ input, output, stream: false })
  assert.equal(io.canAutoReview, false)
  input.end('allow\n/exit\n')
  let reviews = 0
  assert.equal(await main(['--no-workspace', '--no-tui', '--model', 'offline-chat', '--session-dir', directory,
    '--approval-mode', 'auto', '--prompt', 'Hello'], {}, { io,
    providerFactory: () => ({ generate: async () => answer() }), decisionProviderFactory: () => { reviews++; throw new Error('Must not construct') } }), 0)
  assert.equal(reviews, 0); assert.match(text, /interactive terminal with fresh human enrollment/)
  assert.match(text, /Using Manual/)
})

test('launch Auto still confirms, uses mocked review only after enrollment and never persists approval mode', async t => {
  const directory = await fixture(t), captures = []
  const io = fakeIO({ interactive: true, approvals: [true] })
  let round = 0
  assert.equal(await main(['--no-workspace', '--no-tui', '--model', 'offline-chat', '--enable-notes', '--session-dir', directory,
    '--approval-mode', 'auto', '--prompt', 'Set note tone to concise'], {}, { io,
    providerFactory: () => ({ generate: async () => ++round === 1 ? answer([call('save-tone')]) : answer() }),
    decisionProviderFactory: decisionFactory(captures) }), 0)
  assert.equal(io.requests.length, 1); assert.equal(io.requests[0].call.name, 'enroll_auto_review')
  assert.equal(captures.filter(capture => capture.type === 'review').length, 1)
  assert.match(io.output, /Approval mode: Auto review/)
  const names = await readdir(directory), sessionName = names.find(name => /^[a-f0-9-]{36}\.json$/.test(name))
  const session = JSON.parse(await readFile(join(directory, sessionName), 'utf8'))
  assert.equal(session.notes.tone, 'concise')
  assert(!JSON.stringify(session).includes('approvalMode'))
  const resumed = fakeIO({ interactive: true, approvals: [false] })
  round = 0
  captures.length = 0
  assert.equal(await main(['--no-workspace', '--no-tui', '--resume', session.id, '--enable-notes', '--session-dir', directory,
    '--prompt', 'Set note tone to concise'], {}, { io: resumed,
    providerFactory: () => ({ generate: async () => ++round === 1 ? answer([call('save-again', 1)]) : answer() }),
    decisionProviderFactory: decisionFactory(captures) }), 0)
  assert.equal(captures.length, 0); assert.equal(resumed.requests[0].call.name, 'note_set')
  assert.match(resumed.output, /Approval mode: Manual/)
})

test('fullscreen enrollment picker defaults Manual and new conversation revokes Auto without restoring it from defaults', async t => {
  const directory = await fixture(t)
  await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, model: 'gpt-5.1', enableTools: true })
  const io = fakeIO({ interactive: true, lines: ['/mode', '/new', '/session', '/exit'], choices: ['auto'], approvals: [true] })
  let factories = 0
  assert.equal(await main(['--no-workspace', '--session-dir', directory], {}, { tuiIO: io,
    providerFactory: () => ({ generate: async () => answer() }), decisionProviderFactory: () => { factories++; throw new Error('Must not construct') } }), 0)
  assert.equal(io.choices[0].initialIndex, 0); assert.equal(io.choices[0].values[0].value, 'manual')
  assert.equal(io.requests.length, 1); assert.equal(factories, 0)
  assert.deepEqual(io.modes.slice(-2), ['auto', 'manual'])
  assert.equal(io.sessions.length, 2)
  assert.match(io.output.slice(io.output.indexOf('enrolled for')), /Approval mode: Manual/)
  const defaults = JSON.parse(await readFile(join(directory, 'preferences.json'), 'utf8'))
  assert(!Object.hasOwn(defaults, 'approvalMode'))
})

test('account replacement revokes enrollment even when model selection cancels, and old host cannot re-enroll', async t => {
  const directory = await fixture(t)
  await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, model: 'gpt-5.1', enableTools: true })
  const io = fakeIO({ interactive: true, lines: ['/mode', '/provider', '/mode', '/session', '/exit'],
    choices: ['auto', 'openai', 'enter', 'temporary', 'offline-new-key', undefined], approvals: [true] })
  const credentials = { async status() { return { available: false, label: 'Offline vault' } }, async load() {}, async save() {} }
  const catalog = { async list() { return { state: 'fresh', models: [{ id: 'gpt-5.1', name: 'gpt-5.1', conversation: 'supported', tools: 'supported', reasoning: 'unknown', efforts: [] }] } } }
  let factories = 0
  assert.equal(await main(['--no-workspace', '--session-dir', directory], { OPENAI_API_KEY: 'offline-old-key' }, { tuiIO: io,
    credentials, catalog, providerFactory: () => ({ generate: async () => answer() }),
    decisionProviderFactory: () => { factories++; throw new Error('Must not construct') } }), 0)
  assert.equal(factories, 0); assert.equal(io.requests.length, 1)
  assert.match(io.output, /selected account changed/)
  assert.equal(io.modes.at(-1), 'manual')
  assert.equal(io.sessions.length, 1)
  const store = new FileSessionStore(directory)
  assert.equal((await store.load(io.sessions[0].id)).provider, 'openai')
})
