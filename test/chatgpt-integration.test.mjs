// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { TrustedCommandWorkspace } from '../dist/commands.js'
import { tmpdir } from 'node:os'
import { main, parseArguments, providerForSession, decisionProviderForSession } from '../dist/main.js'
import { newSession, validateSession, FileSessionStore } from '../dist/session.js'
import { PreferenceStore, DEFAULT_PREFERENCES } from '../dist/preferences.js'
import { unknownModel } from '../dist/models.js'
import { ChatGptAuthError } from '../dist/chatgpt-auth.js'
import { bindChatGptAccount, chooseChatGptAccount } from '../dist/chatgpt-controls.js'
import { ChatGPTInferenceError } from '../dist/chatgpt-provider.js'
import { ProviderRequestError } from '@ayayaq/vivi/providers/openai'
import { parseChatGptCliArguments } from '../dist/chatgpt-cli.js'
const A = 'a'.repeat(64), B = 'b'.repeat(64)
const account = (id, extra = {}) => ({ id, clientId: `fixture-${id[0]}`, subject: 'same-user', email: 'same@example.test',
  label: `same@example.test · ${id.slice(0, 8)}`, signedIn: true, planUsageEnabled: true, welcomeSeen: true, sessionOnly: false, ...extra })
function authFixture(accounts = [account(A), account(B)]) {
  const state = { accounts, selected: [], tokens: [], signIns: [], logouts: [], welcomes: [] }
  return { state, async listAccounts() { return state.accounts }, async select(id) { state.selected.push(id); const found = state.accounts.find(a => a.id === id); if (!found?.signedIn) throw new ChatGptAuthError('needs-sign-in'); return found },
    async accessToken(id) { state.tokens.push(id); return 'fixture-chatgpt-access' }, async signIn(options) { state.signIns.push(options); return state.accounts.find(a => a.id === options.accountId) ?? state.accounts[0] },
    async signOut(id) { state.logouts.push(id); state.accounts = state.accounts.map(a => a.id === id ? { ...a, signedIn: false } : a); return { revoked: true } },
    async markWelcomeSeen(id) { state.welcomes.push(id) }, async storageStatus() { return { available: true, label: 'Fixture OS vault' } }, async close() {} }
}
function ioFixture(lines = [], choices = [], interactive = true) {
  return { output: '', sessions: [], results: [], choices: [], approvals: [], closed: false, canAutoReview: interactive,
    get isClosed() { return this.closed }, write(value) { this.output += value }, event() {}, result(value) { this.results.push(value) },
    setSession(value) { this.sessions.push(structuredClone(value)) }, setWorkspace() {}, setApprovalMode() {}, setContext() {}, setTaskMode() {}, addSecrets() {}, setDraft() {},
    async readLine() { return lines.shift() }, async choose(title, values) { this.choices.push({ title, values }); const selected = choices.shift(); if (selected !== undefined) assert(values.some(v => v.value === selected), `${selected} is not in ${title}`); return selected },
    async chooseSearchable(title, values) { const selected = choices.shift(); if (selected === undefined) return; assert(values.some(v => v.value === selected)); return { kind: 'selected', value: selected, query: '' } },
    async askText() {}, async approve(request) { this.approvals.push(request); return false }, onCancel() { return () => {} }, close() { this.closed = true } }
}
async function fixture(t) { const directory = await mkdtemp(join(tmpdir(), 'vivi-chatgpt-integration-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory }
function catalogFixture() {
  const calls = []
  return { calls, async list(provider, key, signal) { assert.equal(provider, 'chatgpt'); assert(!signal?.aborted); calls.push(key); return { state: 'fresh', models: [{ ...unknownModel(key === B ? 'model-b' : 'model-a'), conversation: 'supported' }] } } }
}

test('ChatGPT selection is explicit, session-bound and never a credential field', () => {
  const options = parseArguments(['--provider', 'chatgpt', '--chatgpt-account', A, '--model', 'model-a', '--approval-mode', 'skip'], {}, false)
  assert.equal(options.chatgptAccountId, A); assert.equal(options.approvalMode, 'skip')
  assert.throws(() => newSession({ provider: 'chatgpt', model: 'model-a' }), /account registration/)
  const session = newSession({ provider: 'chatgpt', model: 'model-a', chatgptAccountId: A })
  assert.equal(validateSession(session).chatgptAccountId, A)
  assert.throws(() => validateSession({ ...session, provider: 'openai' }), /unexpected ChatGPT/)
  assert.throws(() => parseArguments(['--resume', session.id, '--chatgpt-account', B]), /retain/)
  assert.throws(() => decisionProviderForSession(session, { OPENAI_API_KEY: 'fixture-paid-key' }), /separately configured/)
  assert.equal(parseChatGptCliArguments(['auth', 'login', '--chatgpt-account', A, '--enable-plan-usage'], {}).accountId, A)
  assert.throws(() => parseChatGptCliArguments(['auth', 'login', '--enable-plan-usage'], {}), /saved account/)
})

test('ChatGPT factory sends only selected OAuth to official SSE route, not existing API-key billing', async t => {
  const original = globalThis.fetch, requests = [], auth = authFixture()
  globalThis.fetch = async (url, init) => { requests.push([String(url), new Headers(init.headers), JSON.parse(init.body)]); return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }) }
  t.after(() => { globalThis.fetch = original })
  const session = newSession({ provider: 'chatgpt', model: 'model-a', chatgptAccountId: A })
  const provider = providerForSession(session, { reasoningCapabilities: [], stream: false, chatgptAuth: auth }, { OPENAI_API_KEY: 'fixture-paid-key', OPENROUTER_API_KEY: 'fixture-router-key' })
  await provider.generate({ messages: [{ kind: 'message', role: 'user', content: 'hello' }], tools: [] }, new AbortController().signal)
  assert.deepEqual(auth.state.tokens, [A]); assert.equal(requests[0][0], 'https://api.openai.com/v1/responses')
  assert.equal(requests[0][1].get('authorization'), 'Bearer fixture-chatgpt-access'); assert.equal(requests[0][2].stream, true); assert.equal(requests[0][2].store, false)
})

test('line ChatGPT launch requires chosen saved registration and listed model; no reviewer or fallback is inferred', async t => {
  for (const missing of ['none', 'account', 'model']) {
    const directory = await fixture(t), auth = authFixture(), io = ioFixture([], [], false), catalog = catalogFixture(); let constructed = 0
    const model = missing === 'model' ? 'absent-model' : 'model-a'
    const status = await main(['--no-workspace', '--no-tui', '--provider', 'chatgpt', '--model', model, '--session-dir', directory,
      ...(missing === 'account' ? [] : ['--chatgpt-account', A]), '--prompt', 'hello'], { OPENAI_API_KEY: 'fixture-paid-key' }, { io, chatgptAuth: auth, catalog,
      providerFactory: (session, options) => { constructed++; assert.equal(session.chatgptAccountId, A); assert.equal(options.chatgptAuth, auth); return { async generate() { return { content: 'Done', toolCalls: [] } } } },
      decisionProviderFactory() { assert.fail('SIWC never inherits another reviewer') } })
    assert.equal(status, missing === 'none' ? 0 : 1); assert.equal(constructed, missing === 'none' ? 1 : 0)
    assert.equal(auth.state.signIns.length, 0)
    assert(!io.output.includes('fixture-paid-key'))
  }
})

test('TUI account/workspace switch creates isolated history and current account catalog; canceled selection keeps active account', async t => {
  for (const cancel of [false, true]) {
    const directory = await fixture(t), auth = authFixture(), catalog = catalogFixture(), uses = []
    await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, provider: 'chatgpt', chatgptAccountId: A, model: 'model-a' })
    const io = ioFixture(['First', '/account', 'Second', '/exit'], cancel ? ['choose', undefined] : ['choose', B, 'model-b', false])
    const status = await main(['--no-workspace', '--session-dir', directory], {}, { tuiIO: io, chatgptAuth: auth, catalog,
      providerFactory: session => ({ async generate(input) { uses.push({ id: session.id, account: session.chatgptAccountId, text: input.messages.filter(m => m.kind === 'message' && m.role === 'user' && ['First', 'Second'].includes(m.content)).map(m => m.content) }); return { content: 'Done', toolCalls: [] } } }) })
    assert.equal(status, 0); assert.deepEqual(uses.map(u => u.account), cancel ? [A, A] : [A, B])
    assert.equal(uses[0].id === uses[1].id, cancel); assert.deepEqual(uses[1].text, cancel ? ['First', 'Second'] : ['Second'])
    assert(catalog.calls.includes(A)); if (!cancel) assert(catalog.calls.includes(B))
    assert.equal(auth.state.signIns.length, 0)
    for (const file of await readdir(directory)) if (file.endsWith('.json')) assert(!(await readFile(join(directory, file), 'utf8')).includes('fixture-chatgpt-access'))
  }
})

test('terminal ChatGPT auth and grant errors revoke host binding, transient503 and usage limits do not delete or switch credentials', async () => {
  const failures = [new ChatGptAuthError('needs-sign-in'), new ChatGptAuthError('plan-usage-disabled'),
    new ChatGPTInferenceError(new ProviderRequestError('OpenAI', 'http', 'failed', 401, { bodyShape: 'detail' })),
    new ChatGPTInferenceError(new ProviderRequestError('OpenAI', 'http', 'failed', 403, { bodyShape: 'error', code: 'chatpass_v2_scope_not_authorized' })),
    new ChatGptAuthError('network-unavailable'), new ChatGPTInferenceError(new ProviderRequestError('OpenAI', 'http', 'failed', 503, { bodyShape: 'error', code: 'subscription_sharing_usage_unavailable' })),
    new ChatGPTInferenceError(new ProviderRequestError('OpenAI', 'http', 'failed', 429, { bodyShape: 'error', code: 'subscription_sharing_usage_limit_exceeded' }))]
  for (const [index, failure] of failures.entries()) {
    let current = true, revoked = 0, attempts = 0
    const provider = bindChatGptAccount({ async generate() { attempts++; throw failure } }, { isCurrent: () => current, async invalidate() { revoked++; current = false } })
    await assert.rejects(provider.generate({ messages: [], tools: [] }, new AbortController().signal), error => error === failure)
    assert.equal(revoked, index < 4 ? 1 : 0)
    if (!current) { await assert.rejects(provider.generate({ messages: [], tools: [] }, new AbortController().signal), /account changed/); assert.equal(attempts, 1) }
  }
})

test('resume binds the original ChatGPT registration instead of newer saved defaults', async t => {
  const directory = await fixture(t), auth = authFixture(), catalog = catalogFixture(), io = ioFixture([], [], false)
  const session = newSession({ provider: 'chatgpt', chatgptAccountId: A, model: 'model-a' })
  await new FileSessionStore(directory).save(session)
  await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, provider: 'chatgpt', chatgptAccountId: B, model: 'model-b' })
  let used
  assert.equal(await main(['--no-workspace', '--no-tui', '--session-dir', directory, '--resume', session.id, '--prompt', 'continue'], {}, { io, catalog, chatgptAuth: auth,
    providerFactory: value => { used = value; return { async generate() { return { content: 'Done', toolCalls: [] } } } } }), 0)
  assert.equal(used.chatgptAccountId, A); assert.deepEqual(auth.state.selected, [A]); assert.deepEqual(catalog.calls, [A])
})

test('ChatGPT Auto requires separately explicit reviewer selection and never copies OAuth into reviewer', async t => {
  for (const explicit of [false, true]) {
    const directory = await fixture(t), auth = authFixture(), catalog = catalogFixture(), io = ioFixture([], [], true)
    io.approve = async request => { io.approvals.push(request); return true }
    let rounds = 0, reviewers = 0
    const status = await main(['--no-workspace', '--no-tui', '--provider', 'chatgpt', '--chatgpt-account', A, '--model', 'model-a', '--tools',
      '--session-dir', directory, '--approval-mode', 'auto', ...(explicit ? ['--reviewer', 'openai'] : []), '--prompt', 'Set the tone note'],
      { OPENAI_API_KEY: 'fixture-separate-reviewer' }, { io, catalog, chatgptAuth: auth,
        providerFactory: () => ({ async generate() { return ++rounds === 1 ? { content: '', toolCalls: [{ id: 'tone-fixture', name: 'note_set', arguments: { key: 'tone', value: 'concise', expectedRevision: 0 } }] } : { content: 'Done', toolCalls: [] } } }),
        decisionProviderFactory: (session, env) => { reviewers++; assert.equal(session.provider, 'openai'); assert.equal(env.OPENAI_API_KEY, 'fixture-separate-reviewer'); assert(!JSON.stringify(env).includes('fixture-chatgpt-access'))
          return { id: 'openai', model: 'gpt-6-luna', async evaluate(request) { return { model: 'gpt-6-luna', answers: request.policy.checks.map(check => ({ name: check.name, type: 'predicate', probability: 1 })), usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } } } } })
    assert.equal(status, 0); assert.equal(reviewers, explicit ? 1 : 0); assert.equal(auth.state.tokens.length, 0)
    assert.equal(io.approvals[0].call.name, explicit ? 'enroll_auto_review' : 'note_set')
  }
})

test('cancelled account model selection blocks old-account dispatch and compaction without replay', async t => {
  const directory = await fixture(t), auth = authFixture(), catalog = catalogFixture(), io = ioFixture(['First', '/account', '/compact', 'Second', '/exit'], ['choose', B, undefined])
  await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, provider: 'chatgpt', chatgptAccountId: A, model: 'model-a' })
  let requests = 0
  assert.equal(await main(['--no-workspace', '--session-dir', directory], {}, { tuiIO: io, catalog, chatgptAuth: auth,
    providerFactory: () => ({ async generate() { requests++; return { content: 'Done', toolCalls: [] } } }) }), 0)
  assert.equal(requests, 1); assert.match(io.output, /before compacting; no request was sent/); assert.match(io.output, /before sending another message/)
  assert.equal((await new PreferenceStore(directory).load()).chatgptAccountId, B)
})

test('terminal ChatGPT rejection revokes Skip and cleans owned fake background jobs before the next input', async t => {
  const directory = await fixture(t), root = await fixture(t), auth = authFixture(), catalog = catalogFixture(), io = ioFixture(['Start the fixture', '/mode skip', 'Do not replay', '/exit'])
  const original = TrustedCommandWorkspace.open, processes = []
  TrustedCommandWorkspace.open = (directory, env, secrets) => original.call(TrustedCommandWorkspace, directory, env, secrets, async () => {
    let done; const stdout = new PassThrough(), stderr = new PassThrough(), completed = new Promise(resolve => { done = resolve }), process = { stops: 0 }
    processes.push(process)
    return { stdout, stderr, completed, async stop() { process.stops++; stdout.end(); stderr.end(); done({ exitCode: null, signal: 'SIGKILL' }) } }
  })
  t.after(() => { TrustedCommandWorkspace.open = original })
  io.approve = async request => { io.approvals.push(request); return true }
  let rounds = 0
  const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}
  assert.equal(await main(['--workspace', root, '--session-dir', directory, '--provider', 'chatgpt', '--chatgpt-account', A,
    '--model', 'model-a', '--tools', '--approval-mode', 'skip'], env, { tuiIO: io, catalog, chatgptAuth: auth,
    providerFactory: () => ({ async generate() { if (++rounds === 1) return { content: '', toolCalls: [{ id: 'background-fixture', name: 'command_start', arguments: {
      executable: process.execPath, args: ['-e', 'offline-fixture'], background: true, yieldMs: 0 } }] }
      throw new ChatGPTInferenceError(new ProviderRequestError('OpenAI', 'http', 'fixture denial', 401, { bodyShape: 'error', code: 'subscription_sharing_invalid_user' })) } }) }), 0)
  assert.equal(rounds, 2); assert.equal(processes.length, 1); assert.equal(processes[0].stops, 1)
  assert.equal(io.approvals.filter(request => request.call.name === 'enroll_skip_permissions').length, 1)
  assert(!io.approvals.some(request => request.call.name === 'command_start')); assert.match(io.output, /Unattended permissions revoked/)
  assert.match(io.output, /selected account changed/); assert.equal(auth.state.logouts.length, 0)
})


test('routine saved-account reauthorization does not force consent; disabled plan use needs an explicit Enable choice', async () => {
  for (const signedIn of [false, true]) {
    const auth = authFixture([account(A, { signedIn, planUsageEnabled: false })])
    const io = ioFixture([], signedIn ? [A, 'cancel'] : [A, 'save'])
    await chooseChatGptAccount(io, auth, A)
    assert.equal(auth.state.signIns.length, signedIn ? 0 : 1)
    if (!signedIn) assert.equal(auth.state.signIns[0].enablePlanUsage, undefined)
  }
  const auth = authFixture([account(A, { planUsageEnabled: false })]), io = ioFixture([], [A, 'enable', 'save'])
  await chooseChatGptAccount(io, auth, A)
  assert.equal(auth.state.signIns.length, 1); assert.equal(auth.state.signIns[0].enablePlanUsage, true)
})
