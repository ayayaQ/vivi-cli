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
    taskModes: [], setTaskMode(mode) { this.taskModes.push(mode) },
    setApprovalMode(mode) { this.modes.push(mode) },
    onCancel(callback) { this.cancel = callback; return () => { this.cancel = undefined } },
    close() { this.closed = true }
  }
}
function hostStub() {
  let mode = 'manual'
  return { session: newSession({ provider: 'openai', model: 'offline-chat' }), memoryEnabled: false,
    get reviewProvider() { return this.session.provider }, get approvalMode() { return mode }, setApprovalMode(value) { mode = value }, invalidateContext() {} }
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
  assert.equal(parseArguments(['--model', 'offline-chat', '--approval-mode', 'skip'], {}).approvalMode, 'skip')
  assert.equal(parseArguments(['--model', 'offline-chat', '--approval-mode', 'auto', '--no-tools'], {}).approvalMode, 'auto')
  assert.equal(parseArguments(['--model', 'offline-chat', '--approval-mode', 'auto', '--approval-mode', 'manual'], {}).approvalMode, 'manual')
  for (const value of ['Auto', 'always', 'auto-review']) assert.throws(() => parseArguments(['--model', 'offline-chat', '--approval-mode', value], {}), /must be manual, auto or skip/)
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

test('Auto explanation is brief and identifies the reviewer and extra API charges', () => {
  for (const provider of ['openai', 'openrouter']) {
    const disclosure = autoReviewDisclosure(provider, true)
    assert(disclosure.length < 180)
    assert.match(disclosure, provider === 'openai' ? /OpenAI/ : /OpenRouter and TypeSafe/)
    assert.match(disclosure, /extra API charges/)
    assert.match(disclosure, /DeepSeek web requests are billed separately/)
  }
})

test('selecting Auto enables it immediately without an approval request', async () => {
  for (const provider of ['openai', 'openrouter']) {
    const host = hostStub(), io = fakeIO({ interactive: true })
    host.session.provider = provider
    await selectApprovalMode(host, io, async () => 'auto')
    assert.equal(host.approvalMode, 'auto')
    assert.equal(io.requests.length, 0)
    assert.match(io.output, /Approval mode: Auto review/)
    assert(io.output.includes(autoReviewDisclosure(provider)))
  }
})

test('unavailable or closed IO, Manual selection and picker cancellation never enable Auto', async () => {
  for (const io of [fakeIO(), fakeIO({ interactive: false }), { ...fakeIO({ interactive: true }), closed: true, isClosed: true }]) {
    const host = hostStub()
    await selectApprovalMode(host, io, async () => 'auto')
    assert.equal(host.approvalMode, 'manual'); assert.equal(io.requests.length, 0)
  }
  for (const selected of ['manual', undefined]) {
    const io = fakeIO({ interactive: true }), host = hostStub()
    await selectApprovalMode(host, io, async (_title, choices, initial) => {
      assert.equal(initial, 0); assert.equal(choices[0].value, 'manual'); return selected
    })
    assert.equal(host.approvalMode, 'manual'); assert.equal(io.requests.length, 0)
  }
})

test('cancelled, closed, unavailable or replaced sessions during reviewer setup do not enable Auto', async () => {
  for (const change of ['cancel', 'close', 'unavailable', 'session', 'decline']) {
    const host = hostStub(), io = fakeIO({ interactive: true })
    let reviewer
    Object.defineProperty(host, 'reviewProvider', { get: () => reviewer })
    await selectApprovalMode(host, io, async () => 'auto', async () => {
      reviewer = 'openai'
      if (change === 'cancel') io.cancel()
      if (change === 'close') io.closed = true
      if (change === 'unavailable') io.canAutoReview = false
      if (change === 'session') host.session = newSession({ provider: 'openai', model: 'offline' })
      return change !== 'decline'
    })
    assert.equal(host.approvalMode, 'manual'); assert.equal(io.requests.length, 0)
  }
})

test('line /mode enables Auto directly and slash arguments remain rejected', async () => {
  const host = hostStub(), io = fakeIO({ interactive: true, lines: ['/mode auto', '/mode', '/mode', '/exit'] })
  await runChatLoop(host, io)
  assert.match(io.output, /Use \/mode by itself/)
  assert.equal(io.requests.length, 0)
  assert.equal(host.approvalMode, 'auto')
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
  assert.equal(reviews, 0); assert.match(text, /live interactive terminal/)
  assert.match(text, /Using Manual/)
})

test('launch Auto enables review directly, saves the mode preference and restores it on resume', async t => {
  const directory = await fixture(t), captures = []
  const io = fakeIO({ interactive: true, approvals: [true] })
  let round = 0
  assert.equal(await main(['--no-workspace', '--no-tui', '--model', 'offline-chat', '--tools', '--enable-notes', '--session-dir', directory,
    '--approval-mode', 'auto', '--prompt', 'Set note tone to concise'], {}, { io,
    providerFactory: () => ({ generate: async () => ++round === 1 ? answer([call('save-tone')]) : answer() }),
    decisionProviderFactory: decisionFactory(captures) }), 0)
  assert.equal(io.requests.length, 0)
  assert.equal(captures.filter(capture => capture.type === 'review').length, 1)
  assert.match(io.output, /Approval mode: Auto review/)
  const names = await readdir(directory), sessionName = names.find(name => /^[a-f0-9-]{36}\.json$/.test(name))
  const session = JSON.parse(await readFile(join(directory, sessionName), 'utf8'))
  assert.equal(session.notes.tone, 'concise')
  assert(!JSON.stringify(session).includes('approvalMode'))
  const resumed = fakeIO({ interactive: true, approvals: [false] })
  round = 0
  captures.length = 0
  assert.equal(await main(['--no-workspace', '--no-tui', '--resume', session.id, '--tools', '--enable-notes', '--session-dir', directory,
    '--prompt', 'Set note tone to concise'], {}, { io: resumed,
    providerFactory: () => ({ generate: async () => ++round === 1 ? answer([call('save-again', 1)]) : answer() }),
    decisionProviderFactory: decisionFactory(captures) }), 0)
  assert.equal(captures.filter(capture => capture.type === 'review').length, 1); assert.equal(resumed.requests.length, 0)
  assert.match(resumed.output, /Approval mode: Auto review/)
  assert.equal((await new PreferenceStore(directory).load()).mode, 'auto')
})

test('fullscreen picker starts Manual and new conversations restore the chosen Auto mode', async t => {
  const directory = await fixture(t)
  await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, model: 'gpt-5.1', enableTools: true })
  const io = fakeIO({ interactive: true, lines: ['/mode', '/new', '/session', '/exit'], choices: ['auto'], approvals: [true] })
  let factories = 0
  assert.equal(await main(['--no-workspace', '--session-dir', directory], { OPENAI_API_KEY: 'offline-review-key' }, { tuiIO: io,
    providerFactory: () => ({ generate: async () => answer() }), decisionProviderFactory: () => { factories++; throw new Error('Must not construct') } }), 0)
  assert.equal(io.choices[0].initialIndex, 0); assert.equal(io.choices[0].values[0].value, 'manual')
  assert.equal(io.requests.length, 0); assert.equal(factories, 0)
  assert.deepEqual(io.modes.slice(-2), ['manual', 'auto'])
  assert.equal(io.sessions.length, 2)
  assert.match(io.output.slice(io.output.indexOf('Approval mode: Auto review')), /Approval mode: Manual/)
  const defaults = JSON.parse(await readFile(join(directory, 'preferences.json'), 'utf8'))
  assert.equal(defaults.mode, 'auto'); assert.equal(defaults.reviewer, 'openai')
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
  assert.equal(factories, 0); assert.equal(io.requests.length, 0)
  assert.match(io.output, /selected account changed/)
  assert.equal(io.modes.at(-1), 'manual')
  assert.equal(io.sessions.length, 1)
  const store = new FileSessionStore(directory)
  assert.equal((await store.load(io.sessions[0].id)).provider, 'openai')
})

test('interactive /mode cycle bypasses the picker and visits Auto, Skip and Plan', async t => {
  const directory = await fixture(t)
  await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, model: 'gpt-5.1', enableTools: true })
  const io = fakeIO({ interactive: true, lines: ['/mode cycle', '/mode cycle', '/mode cycle', '/exit'], approvals: [true] })
  assert.equal(await main(['--no-workspace', '--session-dir', directory], {}, { tuiIO: io,
    providerFactory: () => ({ generate: async () => { throw new Error('Mode controls must not send a chat turn') } }) }), 0)
  assert.equal(io.requests.length, 1); assert.equal(io.requests[0].call.name, 'enroll_skip_permissions')
  assert.equal(io.choices.length, 0)
  assert.equal(io.modes.at(-1), 'manual')
  assert.equal(io.taskModes.at(-1), 'plan')
  assert.match(io.output, /Approval mode: Auto review/)
})

test('full-screen Plan selection and direct command require no enrollment; a new conversation restores Plan', async t => {
  const directory = await fixture(t)
  await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, model: 'gpt-5.1', enableTools: true })
  const io = fakeIO({ interactive: true, lines: ['/mode', 'Investigate', '/mode', '/session', '/mode manual', '/mode plan', '/new', '/session', '/exit'],
    choices: ['plan', undefined] })
  let generates = 0
  assert.equal(await main(['--no-workspace', '--session-dir', directory], {}, { tuiIO: io,
    providerFactory: () => ({ async generate({ tools, messages }) {
      generates++
      assert(!tools.some(tool => ['note_set', 'create_memory', 'command_start', 'fetch_url'].includes(tool.name)))
      assert(messages.some(message => message.role === 'system' && message.content.startsWith('Plan mode is active')))
      return answer()
    } }), decisionProviderFactory: () => { throw new Error('Plan must not construct a decision provider') } }), 0)
  assert.equal(generates, 1); assert.equal(io.requests.length, 0)
  assert.deepEqual(io.choices[0].values.map(choice => choice.value), ['manual', 'auto', 'skip', 'plan'])
  assert.equal(io.choices[1].initialIndex, 3)
  assert.match(io.output, /Mode: Plan/); assert.match(io.output, /Approval mode: Manual/)
  assert.equal(io.taskModes.at(-1), 'plan')
  assert.equal(io.sessions.length, 3) // Initial, post-turn refresh, new conversation.
})

test('application unavailable Auto selection keeps Plan for the next ordinary turn without a decision provider', async t => {
  for (const interactive of [false, undefined]) {
    const directory = await fixture(t)
    await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, model: 'gpt-5.1', enableTools: true })
    const io = fakeIO({ interactive, lines: ['/mode plan', '/mode', 'Continue planning', '/session', '/exit'],
      choices: ['auto'] })
    let generates = 0
    assert.equal(await main(['--no-workspace', '--session-dir', directory], {}, { tuiIO: io,
      providerFactory: () => ({ async generate({ tools, messages }) {
        generates++; assert(!tools.some(tool => ['note_set', 'create_memory', 'command_start', 'fetch_url'].includes(tool.name)))
        assert(messages.some(message => message.content.startsWith('Plan mode is active'))); return answer()
      } }), decisionProviderFactory: () => { throw new Error('Negative enrollment must not construct a decision provider') } }), 0)
    assert.equal(generates, 1); assert.equal(io.requests.length, 0)
    assert.equal(io.taskModes.at(-1), 'plan'); assert.match(io.output, /Mode: Plan/)
  }
})

test('confirmed provider, model and effort replacements preserve Plan; new conversations restore it', async t => {
  const directory = await fixture(t)
  await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, model: 'gpt-5.1', enableTools: true,
    reasoningCapabilities: ['none', 'low', 'medium', 'high'] })
  const io = fakeIO({ interactive: true,
    lines: ['/mode plan', '/models', 'Plan after model', '/effort', 'Plan after effort', '/provider', 'Plan after provider', '/new', '/session', '/exit'],
    choices: ['gpt-5.1', 'low', 'openai', 'current', 'gpt-5.1'] })
  let generates = 0
  const catalog = { async list() { return { state: 'fresh', models: [{ id: 'gpt-5.1', name: 'Offline model',
    conversation: 'supported', tools: 'supported', reasoning: 'supported', efforts: ['none', 'low', 'medium', 'high'] }] } } }
  assert.equal(await main(['--no-workspace', '--session-dir', directory], { OPENAI_API_KEY: 'offline-plan-key' }, { tuiIO: io, catalog,
    providerFactory: () => ({ async generate({ tools, messages }) {
      generates++; assert(!tools.some(tool => ['note_set', 'create_memory', 'command_start', 'fetch_url'].includes(tool.name)))
      assert(messages.some(message => message.content.startsWith('Plan mode is active'))); return answer()
    } }), decisionProviderFactory: () => { throw new Error('Plan replacements must not construct a decision provider') } }), 0)
  assert.equal(generates, 3); assert.equal(io.requests.length, 0)
  assert.deepEqual(io.taskModes, ['execute', 'plan', 'plan', 'plan', 'plan', 'execute', 'plan'])
  assert.equal(io.modes.at(-1), 'manual')
  assert.equal(io.sessions.filter(session => session.reasoning === 'low').length > 0, true)
  assert.match(io.output, /local-read task policy preserved/)
})

test('failed Auto activation from Plan restores the Plan task policy', async () => {
  const host = hostStub(), io = fakeIO({ interactive: true })
  host.taskMode = 'plan'
  host.setTaskMode = mode => { host.taskMode = mode }
  host.setApprovalMode = mode => { if (mode === 'auto') throw new Error('Review unavailable') }
  await assert.rejects(selectApprovalMode(host, io, async () => 'auto'), /Review unavailable/)
  assert.equal(host.taskMode, 'plan')
  assert.equal(io.requests.length, 0)
})
