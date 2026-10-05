// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { normalizeModelCapabilities } from '@ayayaq/vivi/providers/models'
import { ModelCatalog, parseModelCatalog, documentedOpenAIModel } from '../dist/models.js'
const fixture = JSON.parse(readFileSync(new URL('./fixtures/model-capabilities.json', import.meta.url), 'utf8'))
const model = (raw, provider = 'openrouter') => parseModelCatalog(provider, { data: [{ id: 'vendor/model:free', ...raw }] })[0]
const response = data => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } })
const cliSummary = entry => ({ selected: true, conversation: entry.conversation, tools: entry.tools,
  streaming: entry.streaming, reasoning: entry.reasoning, reasoningMandatory: entry.reasoningMandatory, efforts: entry.efforts })
test('shared normalization fixture preserves endpoint scope and separate reasoning capabilities', () => {
  assert.equal(fixture.apiVersion, 1)
  assert.equal(fixture.cases.length, 38)
  for (const { name, input, expected, cli } of fixture.cases) {
    const normalized = normalizeModelCapabilities(input)
    const { chat, tools, stream, reasoning } = normalized
    assert.deepEqual({ chat, tools, stream, reasoning }, expected, name)
    assert.equal(normalized.id, input.model.id, name)
    assert.equal(normalized.protocol, input.protocol, name)
    if (!cli) continue // The CLI itself uses Responses or OpenRouter Chat Completions.
    if (!cli.selected) {
      assert.throws(() => parseModelCatalog(input.provider, { data: [input.model] }), /No selectable/, name)
    } else {
      const actual = parseModelCatalog(input.provider, { data: [input.model] })[0]
      assert.equal(actual.id, input.model.id, name)
      assert.deepEqual(cliSummary(actual), cli, name)
    }
  }
})
test('all 52 host OpenAI facts and 72 exclusions survive shared seed enrichment', () => {
  assert.equal(fixture.provenance.cli.commit, '01e6445d921773ecd3112d97d6327334abf931d3')
  assert.equal(fixture.provenance.cli.sourceSha256, 'b7b14af7f388d4cb9e7255ec1c553798b4205138d8268d2821fb1a97cd562fe0')
  assert.equal(fixture.baselineOpenAI.length, 52)
  assert.equal(fixture.baselineOpenAIExclusions.length, 72)
  const baselineHash = createHash('sha256').update(JSON.stringify({ documented: fixture.baselineOpenAI, excluded: fixture.baselineOpenAIExclusions })).digest('hex')
  assert.equal(baselineHash, 'c7065f5b37e8c0e2c7b0838eca86403fbaa7f726cebe6309f700ae48417fd549')
  assert.deepEqual(fixture.corrections.map(({ ids, field, from, to }) => ({ ids, field, from, to })), [
    { ids: ['gpt-4.1', 'gpt-4.1-2025-04-14'], field: 'reasoning', from: 'unknown', to: 'unsupported' },
    { ids: ['o3-pro', 'o3-pro-2025-06-10'], field: 'reasoning', from: 'unknown', to: 'supported' }
  ])
  const ids = fixture.baselineOpenAI.map(({ model }) => model.id)
  const excluded = fixture.baselineOpenAIExclusions.map(({ model }) => model.id)
  assert.equal(new Set([...ids, ...excluded]).size, 124)
  const corrections = fixture.corrections.flatMap(correction => correction.ids.map(id => ({ id, ...correction })))
  assert.equal(corrections.length, 4)
  for (const { model: before } of [...fixture.baselineOpenAI, ...fixture.baselineOpenAIExclusions]) {
    const expected = structuredClone(before)
    for (const correction of corrections.filter(correction => correction.id === before.id)) {
      assert.equal(expected[correction.field], correction.from)
      assert.match(correction.url, /^https:\/\/developers\.openai\.com\/api\/docs\/models\//)
      expected[correction.field] = correction.to
    }
    assert.deepEqual(documentedOpenAIModel(before.id), expected, before.id)
  }
  const entries = parseModelCatalog('openai', { data: [...ids, ...excluded].map(id => ({ id })) })
  assert.deepEqual(entries.map(entry => entry.id), [...ids].sort((a, b) => a.localeCompare(b)))
  for (const id of excluded) assert.throws(() => parseModelCatalog('openai', { data: [{ id }] }), /No selectable/, id)
  for (const id of ['o3-pro', 'o3-pro-2025-06-10']) {
    const entry = documentedOpenAIModel(id)
    assert.equal(entry.reasoning, 'supported')
    assert.deepEqual(entry.efforts, []) // Effort selection and disable remain unverified.
    assert.equal(entry.reasoningMandatory, false)
  }
})
test('OpenRouter metadata has tri-state tool and model-specific mandatory effort semantics', () => {
  for (const parameters of [undefined, null, 'tools', [12]]) assert.equal(model({ supported_parameters: parameters }).tools, 'unknown')
  assert.equal(model({ supported_parameters: [] }).tools, 'unsupported')
  assert.equal(model({ supported_parameters: ['tools'] }).tools, 'supported') // vivi 0.2.1 omits redundant tool_choice
  assert.equal(model({ supported_parameters: ['tools', 'tool_choice'] }).tools, 'supported')
  assert.equal(model({ reasoning: {} }).reasoning, 'unknown')
  assert.deepEqual(model({ reasoning: { supported_efforts: ['none', 'high', 'future'], mandatory: true } }).efforts, ['high'])
  assert.deepEqual(model({ reasoning: { supported_efforts: null } }).efforts, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(model({ reasoning: { supported_efforts: [] } }).efforts, [])
  assert.deepEqual(model({ reasoning: { supported_efforts: 'high' } }).efforts, [])
  assert.equal(model({ name: 'Duplicate name', canonical_slug: 'wrong-id' }).id, 'vendor/model:free')
})
test('OpenRouter explicit disable is independent of named efforts and forbidden when mandatory', () => {
  assert.deepEqual(model({ reasoning: { mandatory: false, supports_max_tokens: true } }).efforts, ['none'])
  assert.deepEqual(model({ reasoning: { mandatory: true, supports_max_tokens: true } }).efforts, [])
  assert.deepEqual(model({ reasoning: { mandatory: false, supported_efforts: ['high'] } }).efforts, ['none', 'high'])
  assert.deepEqual(model({ reasoning: { supported_efforts: ['high'] } }).efforts, ['high'])
  assert.equal(model({ reasoning: { supports_max_tokens: true } }).reasoning, 'supported')
  assert.deepEqual(model({ reasoning: { supports_max_tokens: true } }).efforts, [])
  for (const id of ['openrouter/auto', 'openrouter/free']) {
    assert.equal(model({ id, supported_parameters: ['tools'] }).reasoning, 'unknown')
  }
  for (const parameter of ['reasoning', 'include_reasoning']) {
    assert.equal(model({ supported_parameters: [parameter] }).reasoning, 'supported')
    assert.deepEqual(model({ supported_parameters: [parameter] }).efforts, [])
  }
  for (const reasoning of [null, 12, 'high']) {
    assert.equal(model({ supported_parameters: [], reasoning }).reasoning, 'unknown')
  }
  assert.equal(model({ supported_parameters: [12] }).reasoning, 'unknown')
})
test('OpenAI exact Responses registry never guesses unknown or other-provider IDs', () => {
  assert.deepEqual(documentedOpenAIModel('gpt-5').efforts, ['minimal', 'low', 'medium', 'high'])
  assert.deepEqual(documentedOpenAIModel('gpt-5.1').efforts, ['none', 'low', 'medium', 'high'])
  assert.deepEqual(documentedOpenAIModel('gpt-5.5-pro').efforts, ['medium', 'high', 'xhigh'])
  assert.equal(documentedOpenAIModel('gpt-5.5-pro').streaming, 'unsupported')
  assert.equal(documentedOpenAIModel('gpt-6.1-sol').tools, 'supported')
  assert.equal(documentedOpenAIModel('gpt-6.1-sol-future').tools, 'unknown')
  assert.equal(model({ id: 'openai/gpt-6.1-sol' }).tools, 'unknown')
  assert.equal(model({ id: 'gpt-4.1' }, 'openai').tools, 'supported')
  assert.deepEqual(model({ id: 'gpt-4.1' }, 'openai').efforts, [])
})
test('catalog parser bounds and validates untrusted metadata, ignores unsafe IDs and sanitizes names', () => {
  assert.throws(() => parseModelCatalog('openai', { data: Array(5001).fill({ id: 'x' }) }), /format or size/)
  assert.throws(() => parseModelCatalog('openai', { data: [{ id: 'bad\u001b' }] }), /No selectable/)
  assert.equal(model({ name: '\u001b]52;secret' }).name, 'vendor/model:free')
  const parsed = parseModelCatalog('openrouter', { data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] })
  assert.deepEqual(parsed.map(m => m.id), ['a', 'b'])
  for (const id of ['', 'bad id', 'x'.repeat(201), 'bad\u202e', 'bad\u2066', 'bad\u009f']) {
    for (const provider of ['openai', 'openrouter']) {
      assert.throws(() => parseModelCatalog(provider, { data: [{ id }] }), /No selectable/)
    }
    assert.equal(documentedOpenAIModel(id).reasoning, 'unknown')
  }
  assert.equal(model({ name: 'Spoofed\u202e' }).name, 'vendor/model:free')
  const duplicates = parseModelCatalog('openrouter', { data: [{ id: 'b', name: 'First' }, { id: 'a' }, { id: 'b', name: 'Last' }] })
  assert.equal(duplicates[1].name, 'Last')
})
test('catalog data and normalization never invoke metadata getters or inherit claims', () => {
  let calls = 0
  const getter = () => { calls++; throw new Error('sensitive metadata getter') }
  const withGetter = (key, rest = {}) => Object.defineProperty(rest, key, { get: getter })
  assert.throws(() => parseModelCatalog('openrouter', withGetter('data')), /format or size/)
  const data = [{ id: 'vendor/safe' }, withGetter('id')]
  Object.defineProperty(data, '2', { get: getter })
  assert.deepEqual(parseModelCatalog('openrouter', { data }).map(entry => entry.id), ['vendor/safe'])
  const raw = withGetter('name', { id: 'vendor/safe', supported_parameters: ['tools'] })
  const entry = parseModelCatalog('openrouter', { data: [raw] })[0]
  assert.equal(entry.name, 'vendor/safe')
  assert.equal(entry.tools, 'supported')
  const reasoning = withGetter('supported_efforts', { mandatory: false })
  assert.deepEqual(parseModelCatalog('openrouter', { data: [{ id: 'vendor/safe', reasoning }] })[0].efforts, ['none'])
  assert.equal(parseModelCatalog('openrouter', { data: [withGetter('reasoning', { id: 'vendor/safe', supported_parameters: [] })] })[0].reasoning, 'unknown')
  const parameters = ['tools']
  Object.defineProperty(parameters, '1', { get: getter })
  assert.equal(model({ supported_parameters: parameters }).tools, 'unknown')
  const sparse = Array(1)
  assert.equal(model({ supported_parameters: sparse }).tools, 'unknown')
  assert.equal(model({ supported_parameters: Array(101).fill('tools') }).tools, 'unknown')
  assert.equal(model({ reasoning: { supported_efforts: sparse } }).reasoning, 'unknown')
  assert.equal(model({ architecture: withGetter('input_modalities', { output_modalities: ['text'] }) }).conversation, 'unknown')
  const inherited = Object.create({ supported_parameters: ['tools'], reasoning: { supported_efforts: null } })
  inherited.id = 'vendor/inherited'
  assert.throws(() => parseModelCatalog('openrouter', { data: [inherited] }), /No selectable/)
  const plain = Object.assign(Object.create(null), { id: 'vendor/null-prototype', supported_parameters: ['tools'] })
  assert.equal(parseModelCatalog('openrouter', { data: [plain] })[0].tools, 'supported')
  assert.equal(calls, 0)
})
test('discovery uses fixed provider endpoints, isolated key scopes, clone-safe cache and explicit stale state', async () => {
  let now = 0, calls = 0, fail = false
  const catalog = new ModelCatalog(async (url, request) => {
    calls++
    assert.equal(url, 'https://openrouter.ai/api/v1/models/user')
    assert.equal(request.redirect, 'error')
    assert.equal(request.headers.Authorization, 'Bearer fake-key')
    if (fail) throw new Error('network headers fake-key')
    return response([{ id: 'vendor/model', supported_parameters: ['tools', 'tool_choice'] }])
  }, () => now)
  const first = await catalog.list('openrouter', 'fake-key')
  first.models[0].id = 'mutated'
  const second = await catalog.list('openrouter', 'fake-key')
  assert.equal(second.state, 'cached'); assert.equal(second.models[0].id, 'vendor/model'); assert.equal(calls, 1)
  now = 16 * 60 * 1000; fail = true
  const stale = await catalog.list('openrouter', 'fake-key')
  assert.equal(stale.state, 'stale'); assert(!stale.warning.includes('fake-key'))
  await assert.rejects(catalog.list('openrouter', 'other-key'), /could not be loaded/)
})
test('authentication denial never falls back to cached models and never echoes response bodies', async () => {
  let deny = false
  const catalog = new ModelCatalog(async () => deny ? new Response('fake-sensitive-body', { status: 401 }) : response([{ id: 'gpt-5.1' }]))
  await catalog.list('openai', 'fake')
  deny = true
  await assert.rejects(catalog.list('openai', 'fake', undefined, true), error => /access was denied/.test(error.message) && !error.message.includes('sensitive'))
  await assert.rejects(catalog.list('openai', 'fake'), /access was denied/)
  await assert.rejects(catalog.list('openai'), /\/provider/)
})
test('malformed/oversized bodies and aborts return safe errors without retaining an invalid cache', async () => {
  for (const fetcher of [async () => new Response('{broken'), async () => new Response('x', { headers: { 'Content-Length': '4194305' } }),
    async () => new Response('x'.repeat(4194305)), async () => response([])]) {
    const catalog = new ModelCatalog(fetcher)
    await assert.rejects(catalog.list('openrouter'), /Model|No selectable/)
  }
  const controller = new AbortController()
  controller.abort()
  const catalog = new ModelCatalog(async (_url, init) => { assert(init.signal.aborted); throw new Error('raw fake-key') })
  await assert.rejects(catalog.list('openrouter', undefined, controller.signal), /cancelled/)
})

test('catalog hides known nonconversation models, preserves multimodal text chat and keeps future IDs unverified', () => {
  const openai = parseModelCatalog('openai', { data: [{ id: 'text-embedding-3-small' }, { id: 'text-embedding-3-large' },
    { id: 'text-embedding-ada-002' }, { id: 'gpt-4o-mini-tts-2025-03-20' }, { id: 'gpt-image-2' },
    { id: 'omni-moderation-latest' }, { id: 'gpt-5-search-api' }, { id: 'gpt-5.1' }, { id: 'future-text-model' }] })
  assert.deepEqual(openai.map(m => m.id), ['future-text-model', 'gpt-5.1'])
  assert.equal(openai[0].conversation, 'unknown'); assert.equal(openai[1].conversation, 'supported')
  const router = parseModelCatalog('openrouter', { data: [
    { id: 'vendor/image-only', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
    { id: 'vendor/transcription', architecture: { input_modalities: ['audio'], output_modalities: ['text'] } },
    { id: 'vendor/embedding', architecture: { input_modalities: ['text'], output_modalities: ['embedding'] } },
    { id: 'vendor/multimodal-chat', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
    { id: 'vendor/unknown', architecture: { input_modalities: null, output_modalities: [12] } }
  ] })
  assert.deepEqual(router.map(m => m.id), ['vendor/multimodal-chat', 'vendor/unknown'])
  assert.equal(router[0].conversation, 'supported'); assert.equal(router[1].conversation, 'unknown')
})

test('an already-aborted request rejects even when the catalog cache is fresh', async () => {
  let calls = 0
  const catalog = new ModelCatalog(async () => { calls++; return response([{ id: 'vendor/model' }]) })
  await catalog.list('openrouter')
  const abort = new AbortController(); abort.abort()
  await assert.rejects(catalog.list('openrouter', undefined, abort.signal), /cancelled/)
  assert.equal(calls, 1)
})
