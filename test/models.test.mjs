// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ModelCatalog, parseModelCatalog, documentedOpenAIModel } from '../dist/models.js'
const model = (raw, provider = 'openrouter') => parseModelCatalog(provider, { data: [{ id: 'vendor/model:free', ...raw }] })[0]
const response = data => new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } })
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
