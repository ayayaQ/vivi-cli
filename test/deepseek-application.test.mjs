// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../dist/main.js'
import { DEFAULT_PREFERENCES } from '../dist/application.js'
import { PreferenceStore } from '../dist/preferences.js'
import { unknownModel } from '../dist/models.js'
function ioFixture({ choices = [], lines = [], approvals = [] } = {}) {
  return { output: '', sessions: [], requests: [], choices: [], protected: [], closed: false, canAutoReview: true,
    get isClosed() { return this.closed },
    async choose(title, values, initialIndex) { this.choices.push({ title, values, initialIndex }); const value = choices.shift(); assert(value === undefined || values.some(row => row.value === value), `${value} absent in ${title}`); return value },
    async chooseSearchable(title, values) { const value = choices.shift(); assert(value === undefined || values.some(row => row.value === value), `${value} absent in ${title}`); return value === undefined ? undefined : { kind: 'selected', value, query: '' } },
    async askSecret() { return 'entered-fixture-key' }, async askText() {}, async readLine() { return lines.shift() },
    async approve(request) { this.requests.push(request); return approvals.shift() ?? false },
    setSession(session) { this.sessions.push(session) }, setApprovalMode() {}, setContext() {}, setTaskMode() {},
    write(text) { this.output += text }, event() {}, result() {}, addSecrets(values) { this.protected.push(...values) },
    onCancel() { return () => {} }, close() { this.closed = true }
  }
}
async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-deepseek-app-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const vault = new Map(Object.entries(config.vault ?? {})), loads = [], saves = [], models = [], providers = [], reviews = [], reviewKeys = []
  const credentials = { async status() { return { available: config.secure ?? false, label: 'Fixture secure vault' } },
    async load(slot) { loads.push(slot); return vault.get(slot) }, async save(slot, key) { saves.push({ slot, key }); vault.set(slot, key) } }
  const catalog = { async list(provider, key) { models.push({ provider, key }); return { state: 'fresh', models: [{ ...unknownModel(provider === 'deepseek' ? 'deepseek-flash' : 'gpt-5.1'),
    conversation: 'supported', tools: 'supported', streaming: 'supported', reasoning: 'supported', efforts: ['none', 'high'] }] } } }
  const provider = config.provider ?? 'openai', model = provider === 'deepseek' ? 'deepseek-flash' : 'gpt-5.1'
  await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, provider, model, enableTools: true, ...(config.webProvider ? { webProvider: config.webProvider } : {}) })
  let rounds = 0
  const run = io => main(['--session-dir', directory, '--no-workspace', '--no-skills'],
    { OPENAI_API_KEY: 'fixture-openai-key', DEEPSEEK_API_KEY: 'fixture-chat-key', ...(config.env ?? {}) }, {
      tuiIO: io, credentials, catalog, providerFactory(session, options, env) {
        providers.push({ session, options, env }); return { async generate(input) { rounds++; const output = config.generate?.(input, rounds) ?? { content: 'Hello', toolCalls: [] };
          return session.provider !== 'deepseek' ? output : { ...output, providerState: { provider: `deepseek:${session.model}`, items: [{ role: 'assistant', content: output.content || null, reasoning_content: 'Native fixture reasoning',
            ...(output.toolCalls.length ? { tool_calls: output.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) }] } } } }
      }, decisionProviderFactory(session, env) { reviewKeys.push(env.OPENAI_API_KEY); return { id: session.provider, model: session.provider === 'openai' ? 'gpt-6-luna' : 'typesafe/jev-1.13', async evaluate(request) {
        reviews.push(request); return { model: session.provider === 'openai' ? 'gpt-6-luna' : 'typesafe/jev-1.13', answers: request.policy.checks.map(row => ({ name: row.name, type: 'predicate', probability: 1 })), usage: { inputTokens: 1, outputTokens: 1 } }
      } } }
    })
  return { directory, vault, loads, saves, models, providers, reviews, reviewKeys, run }
}
test('DeepSeek chat does not enable paid web or select another reviewer automatically', async t => {
  const f = await fixture(t, { provider: 'deepseek', generate(input) { assert(!input.tools.some(row => row.name === 'web_search')); return { content: 'Hello', toolCalls: [] } } })
  const io = ioFixture({ lines: ['Hello', '/exit'] }); assert.equal(await f.run(io), 0)
  assert(!f.loads.includes('deepseek-web')); assert.equal(f.reviews.length, 0); assert.equal(f.providers[0].session.provider, 'deepseek')
})
test('web Disabled is independent, durable and keeps the same conversation', async t => {
  const f = await fixture(t), io = ioFixture({ lines: ['Before', '/web', 'After', '/exit'], choices: ['disabled'] })
  assert.equal(await f.run(io), 0)
  assert.equal(JSON.parse(await readFile(join(f.directory, 'preferences.json'))).webProvider, 'disabled')
  assert.equal(new Set(io.sessions.map(row => row.id)).size, 1); assert.equal(f.providers[0].session.provider, 'openai')
})
test('cancelling paid web opt-in does not load or copy chat credentials', async t => {
  const f = await fixture(t), io = ioFixture({ lines: ['/web', '/exit'], choices: ['deepseek', false] })
  assert.equal(await f.run(io), 0); assert(!f.loads.includes('deepseek-web')); assert.equal(f.saves.length, 0)
  assert.equal(JSON.parse(await readFile(join(f.directory, 'preferences.json'))).webProvider, undefined)
})
test('separate secure web key and fresh paid Auto enrollment allow a search without redundant human action approval', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original }); const sends = []
  globalThis.fetch = async (input, init) => { sends.push({ input, init }); return new Response(JSON.stringify({ results: [] })) }
  const f = await fixture(t, { vault: { 'deepseek-web': 'fixture-separate-web-key' }, generate(_input, round) {
    return round === 1 ? { content: '', toolCalls: [{ id: 'search-once', name: 'web_search', arguments: { query: 'ordinary topic' } }] } : { content: 'Done', toolCalls: [] }
  } })
  const io = ioFixture({ lines: ['/web', '/mode', 'Search ordinary topic', '/exit'], choices: ['deepseek', true, 'current', 'auto'], approvals: [true] })
  assert.equal(await f.run(io), 0); assert.equal(sends.length, 1); assert.equal(io.requests.length, 1)
  assert.equal(sends[0].init.headers.Authorization, 'Bearer fixture-separate-web-key'); assert.equal(f.reviews.length, 1)
  assert.match(io.requests[0].description, /paid DeepSeek/); assert.match(io.requests[0].description, /not an enforceable/)
  assert.equal(io.requests[0].call.arguments.reviewDataSharing.webRecipient, 'DeepSeek')
  assert(!io.output.includes('fixture-separate-web-key')); assert(!JSON.stringify(await new PreferenceStore(f.directory).load()).includes('fixture-separate-web-key'))
})
test('chat-key reuse for web requires a deliberate choice and storage choice', async t => {
  const f = await fixture(t, { provider: 'deepseek' })
  const io = ioFixture({ lines: ['/web', '/exit'], choices: ['deepseek', true, 'reuse', 'temporary'] })
  assert.equal(await f.run(io), 0); assert.equal(f.saves.length, 0)
  assert(io.choices.some(choice => choice.values.some(row => /Reuse my DeepSeek chat key/.test(row.name))))
  assert(io.choices.some(choice => choice.title === 'DeepSeek web key storage'))
  assert.equal(JSON.parse(await readFile(join(f.directory, 'preferences.json'))).webProvider, 'deepseek')
})
test('DeepSeek Auto setup explicitly chooses a supported reviewer and does not persist that choice', async t => {
  const f = await fixture(t, { provider: 'deepseek' })
  const io = ioFixture({ lines: ['/mode', '/exit'], choices: ['auto', 'openai', 'current'], approvals: [true] })
  assert.equal(await f.run(io), 0); assert.equal(io.requests.length, 1)
  assert.equal(io.requests[0].call.arguments.provider, 'openai'); assert.match(io.requests[0].description, /to OpenAI/)
  const picker = io.choices.find(row => row.title.startsWith('Auto reviewer'))
  assert.deepEqual(picker.values.map(row => row.value), ['none', 'openai', 'openrouter'])
  assert.equal(JSON.parse(await readFile(join(f.directory, 'preferences.json'))).reviewer, undefined)
  assert.equal(f.providers[0].session.provider, 'deepseek')
})
test('chat setup preserves independently selected web Disabled', async t => {
  const f = await fixture(t, { webProvider: 'disabled' })
  const io = ioFixture({ lines: ['/provider', '/exit'], choices: ['deepseek', 'current', 'deepseek-flash'] })
  assert.equal(await f.run(io), 0)
  const saved = JSON.parse(await readFile(join(f.directory, 'preferences.json')))
  assert.equal(saved.provider, 'deepseek'); assert.equal(saved.webProvider, 'disabled'); assert(!f.loads.includes('deepseek-web'))
})

for (const initial of ['old-chat-account-key', undefined]) test(`explicit reviewer key survives repeated selection and switch away/back: ${initial ? 'existing env key' : 'no env key'}`, async t => {
  const f = await fixture(t, { provider: 'deepseek', env: { OPENAI_API_KEY: initial }, generate(_input, round) {
    if (round === 1 || round === 3) return { content: '', toolCalls: [{ id: `note-${round}`, name: 'note_set', arguments: { key: 'tone', value: round === 1 ? 'concise' : 'clear', expectedRevision: round === 1 ? 0 : 1 } }] }
    return { content: 'Done', toolCalls: [] }
  } })
  const io = ioFixture({ lines: ['/reviewer', '/mode', 'Set a session note named tone to concise', '/reviewer', '/reviewer', '/mode', 'Set the session note named tone to clear', '/exit'],
    choices: ['openai', 'enter', 'temporary', 'auto', 'none', 'openai', 'current', 'auto'], approvals: [true, true] })
  assert.equal(await f.run(io), 0); assert.deepEqual(f.reviewKeys, ['entered-fixture-key', 'entered-fixture-key'])
  assert.equal(f.reviews.length, 2); assert.equal(io.requests.length, 2)
  const current = io.choices.filter(row => row.title === 'openai reviewer key').at(-1).values.find(row => row.value === 'current')
  assert.match(current.description, /Explicit reviewer key/)
  assert.equal(f.providers[0].env.OPENAI_API_KEY, initial)
})
