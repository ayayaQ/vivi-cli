// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliHost } from '../dist/host.js'
import { parseArguments, providerForSession, decisionProviderForSession, deferredDecisionProvider } from '../dist/main.js'
import { FileSessionStore, newSession, validateSession } from '../dist/session.js'
import { ModelCatalog, parseModelCatalog, hydrateModelCapabilities, contextLimitsForModel } from '../dist/models.js'
import { validatePreferences } from '../dist/preferences.js'
import { DEFAULT_PREFERENCES } from '../dist/application.js'
import { createCredentialStore } from '../dist/credentials.js'
import { selectApprovalMode } from '../dist/terminal.js'
const answer = (content = 'Hello', calls) => ({ model: 'deepseek-flash', choices: [{ finish_reason: calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content,
  reasoning_content: 'Native private reasoning', ...(calls ? { tool_calls: calls } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
  prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 7 } })
const metadata = { id: 'deepseek-flash', context_window: 1000000, max_output_tokens: 384000,
  modalities: { input: ['text'], output: ['text'] }, effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }
const options = () => parseArguments(['--provider', 'deepseek', '--model', 'deepseek-flash', '--no-stream'], {})
test('DeepSeek is a separate validated chat selection and never falls through to OpenRouter credentials/review', () => {
  const session = newSession({ provider: 'deepseek', model: 'deepseek-flash' })
  assert.equal(validateSession(session).provider, 'deepseek')
  assert.equal(validatePreferences({ ...DEFAULT_PREFERENCES, provider: 'deepseek' }).provider, 'deepseek')
  assert.equal(options().provider, 'deepseek')
  assert.throws(() => providerForSession(session, options(), { OPENROUTER_API_KEY: 'router-key' }), /DEEPSEEK_API_KEY/)
  assert.throws(() => decisionProviderForSession(session, { OPENROUTER_API_KEY: 'router-key' }), /not an Auto reviewer/)
  assert.throws(() => deferredDecisionProvider(session, {}, () => { throw new Error('must not construct') }), /explicitly/)
})
test('official DeepSeek catalog metadata drives context/effort/tools, while future unknown IDs keep unknown limits', async () => {
  const calls = []
  const catalog = new ModelCatalog(async (input, init) => {
    calls.push({ input, init }); return new Response(JSON.stringify({ data: [metadata] }))
  })
  const result = await hydrateModelCapabilities(catalog, 'deepseek', metadata.id, 'deepseek-fixture-key')
  assert.equal(calls[0].input, 'https://api.deepseek.com/models')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer deepseek-fixture-key')
  assert.equal(result.model.tools, 'supported'); assert.equal(result.model.contextWindow, 1000000)
  assert(result.model.efforts.includes('none')); assert(result.model.efforts.includes('high'))
  assert.equal(contextLimitsForModel(result.model).maxOutputTokens, 384000)
  const future = parseModelCatalog('deepseek', { data: [{ id: 'future-model' }] })[0]
  assert.equal(future.contextWindow, undefined); assert.equal(future.tools, 'unknown')
  await assert.rejects(new ModelCatalog(async () => { throw new Error('must not fetch') }).list('deepseek'), /Set up DeepSeek/)
})
test('native DeepSeek reasoning, tool history, usage and context accounting survive real host turns offline', async t => {
  const root = await mkdtemp(join(tmpdir(), 'vivi-deepseek-chat-')); t.after(() => rm(root, { recursive: true, force: true }))
  const requests = [], original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async (input, init) => {
    requests.push({ input, body: JSON.parse(init.body) })
    const calls = requests.length === 1 ? [{ id: 'note-read', type: 'function', function: { name: 'note_read', arguments: '{}' } }] : undefined
    return new Response(JSON.stringify(answer(calls ? '' : 'Hello', calls)), { headers: { 'content-type': 'application/json' } })
  }
  const session = newSession({ provider: 'deepseek', model: 'deepseek-flash' }), store = new FileSessionStore(join(root, 'sessions'))
  const host = new CliHost({ session, store, provider: providerForSession(session, options(), { DEEPSEEK_API_KEY: 'fixture-chat-key' }),
    enableNotes: true, enablePublicUrl: false, contextLimits: { contextWindow: 1000000, maxOutputTokens: 384000 } })
  t.after(() => host.shutdown())
  const result = await host.send('Read the session notes')
  assert.equal(result.status, 'completed'); assert.equal(requests.length, 2)
  assert(requests.every(row => row.input === 'https://api.deepseek.com/chat/completions'))
  const assistant = requests[1].body.messages.find(row => row.role === 'assistant')
  assert.equal(assistant.reasoning_content, 'Native private reasoning'); assert.equal(assistant.tool_calls[0].id, 'note-read')
  assert.equal(host.session.history.find(row => row.kind === 'assistant').providerState.provider, 'deepseek:deepseek-flash')
  assert.equal(host.session.usage.inputTokens, 20); assert.equal(host.session.usage.cachedInputTokens, 6)
  assert.equal(host.session.usage.cacheWriteInputTokens, undefined)
  await host.refreshContext(); assert.equal(requests.length, 2); assert.equal(host.contextUsage.contextWindow, 1000000)
  const restored = await store.load(host.session.id)
  assert.equal(restored.history.find(row => row.kind === 'assistant').providerState.provider, 'deepseek:deepseek-flash')
})
test('unsupported imported tool history fails before HTTP with actionable fresh-session guidance', async t => {
  let sends = 0; const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => { sends++; throw new Error('must not send') }
  const session = newSession({ provider: 'deepseek', model: 'deepseek-flash' })
  session.history = [{ kind: 'message', role: 'user', content: 'Old request' },
    { kind: 'assistant', content: '', toolCalls: [{ id: 'old-call', name: 'note_read', arguments: {} }] },
    { kind: 'tool_result', callId: 'old-call', name: 'note_read', content: '{}' }]
  const host = new CliHost({ session, store: { async save() {} }, provider: providerForSession(session, options(), { DEEPSEEK_API_KEY: 'fixture-chat-key' }), enableNotes: true })
  t.after(() => host.shutdown())
  const result = await host.send('Continue')
  assert.equal(result.status, 'error'); assert.equal(sends, 0); assert.match(result.error.message, /Use \/new|start a new session|portable summary/i)
})
test('DeepSeek begins without Auto reviewer despite another account being present', async () => {
  const host = new CliHost({ session: newSession({ provider: 'deepseek', model: 'deepseek-flash' }), store: { async save() {} },
    provider: { async generate() { return { content: 'Hello', toolCalls: [] } } } })
  const approvals = [], output = []
  await selectApprovalMode(host, { canAutoReview: true, approve: async request => { approvals.push(request); return true },
    write: text => output.push(text), onCancel: () => () => {} })
  assert.equal(host.approvalMode, 'manual'); assert.equal(approvals.length, 0); assert.match(output.join(''), /reviewer explicitly/)
  await host.shutdown()
})
test('native credential stores use separate DeepSeek chat and web slots', async () => {
  const slots = new Map(), requests = []
  const store = createCredentialStore({ platform: 'linux', runner: async request => {
    requests.push(request); const slot = request.args.at(-1)
    if (request.args[0] === 'store') { slots.set(slot, request.stdin); return { exitCode: 0, stdout: '', stderrPresent: false } }
    return { exitCode: slots.has(slot) ? 0 : 1, stdout: slots.get(slot) ?? '', stderrPresent: false }
  } })
  await store.save('deepseek', 'fixture-chat-key'); await store.save('deepseek-web', 'fixture-web-key')
  assert.equal(await store.load('deepseek'), 'fixture-chat-key'); assert.equal(await store.load('deepseek-web'), 'fixture-web-key')
  assert(requests.every(request => !request.args.includes('fixture-chat-key') && !request.args.includes('fixture-web-key')))
})
