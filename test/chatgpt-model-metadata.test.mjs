// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { measureContext, prepareContext } from '@ayayaq/vivi'
import { parseChatGPTModelCatalog } from '../dist/chatgpt-models.js'
import { createChatGPTProvider } from '../dist/chatgpt-provider.js'
import { contextLimitsForModel, documentedOpenAIModel } from '../dist/models.js'
import { formatContextDetails, formatContextStatus } from '../dist/context-status.js'
import { chooseEffort, settingsForModel } from '../dist/application.js'
import { DEFAULT_PREFERENCES } from '../dist/preferences.js'

const model = (slug = 'gpt-6.1-sol') => parseChatGPTModelCatalog({ models: [{ slug, visibility: 'list' }] })[0]
const efforts = ['low', 'medium', 'high', 'xhigh', 'max']
const accountId = 'a'.repeat(64)
const input = { messages: [{ kind: 'message', role: 'user', content: 'Hello' }], tools: [] }

test('reviewed ChatGPT metadata is detached, route-specific, and does not import API-key capacities', () => {
  const first = model()
  first.efforts.push('none'); first.modelCapabilities.reasoning.efforts.push('none')
  first.contextBudget.tokens = 1; first.contextBudget.source.url = 'https://invalid.example/'
  const fresh = model()
  assert.deepEqual(fresh.efforts, efforts); assert.deepEqual(fresh.modelCapabilities.reasoning.efforts, efforts)
  assert.equal(fresh.contextBudget.tokens, 475000)
  assert.equal(fresh.contextBudget.source.url, 'https://developers.openai.com/api/docs/models/gpt-6.1-sol')
  assert.equal(fresh.contextWindow, undefined); assert.equal(fresh.modelCapabilities.contextWindow, undefined)
  assert.equal(fresh.maxOutputTokens, undefined); assert.equal(fresh.modelCapabilities.maxOutputTokens, undefined)
  assert.notEqual(documentedOpenAIModel('gpt-6.1-sol').contextWindow, fresh.contextBudget.tokens)
  for (const id of ['future-model', 'gpt-6.1-sol-preview', 'GPT-6.1-SOL', 'openai/gpt-6.1-sol', 'gpt-6-sol', '__proto__']) {
    const unknown = model(id)
    assert.equal(unknown.reasoning, 'unknown'); assert.deepEqual(unknown.efforts, [])
    assert.equal(unknown.contextBudget, undefined); assert.equal(contextLimitsForModel(unknown), undefined)
  }
})

test('local budget is labelled in context output and cannot exceed a documented smaller capacity', async () => {
  const metadata = model(), limits = contextLimitsForModel(metadata)
  assert.deepEqual(limits, { contextWindow: 475000, source: { kind: 'host',
    url: 'https://developers.openai.com/api/docs/models/gpt-6.1-sol', reviewedOn: '2026-11-07' } })
  const { usage } = measureContext({ ...input, provider: { async generate() { assert.fail('measurement is offline') } },
    context: { sourceId: 'fixture', limits } })
  assert.equal(usage.outputReserveTokens, 4096); assert.equal(usage.availableInputTokens, 470904)
  assert.match(formatContextStatus(usage), /^Context budget ~/)
  for (const details of [formatContextDetails(usage), formatContextDetails(usage, metadata), formatContextDetails(undefined, metadata)]) {
    assert.match(details, /Capacity: unknown/)
    assert.match(details, /Working budget: 475000 tokens \(local policy, not a confirmed subscription limit; includes output reserve\)/)
    assert.doesNotMatch(details, /Capacity: 475000|Provider maximum output/)
  }
  const smaller = contextLimitsForModel({ ...metadata, contextWindow: 128000,
    contextLimitsSource: { kind: 'provider-catalog', url: 'https://example.test/models', reviewedOn: '2026-11-07' } })
  assert.equal(smaller.contextWindow, 128000); assert.equal(smaller.source.kind, 'provider-catalog')
  assert.equal(contextLimitsForModel({ ...metadata, contextWindow: 1000000 }).contextWindow, 475000)
})

test('Vivi compaction uses its own 85% input threshold inside the local budget', async () => {
  const messages = Array.from({ length: 14 }, (_, index) => index % 2
    ? { kind: 'assistant', content: `Fixture ${index}`, toolCalls: [] }
    : { kind: 'message', role: 'user', content: `Fixture ${index}` })
  for (const tokens of [400268, 400269]) {
    const events = [], calls = []
    const provider = {
      estimateContext(request) { return { inputTokens: request.messages.length >= messages.length ? tokens : 1000, estimated: true } },
      async generate(request, signal, options) { calls.push(options.purpose); return { content: 'Inert historical fixture summary', toolCalls: [] } }
    }
    const result = await prepareContext({ messages, tools: [], provider,
      context: { sourceId: 'fixture', limits: contextLimitsForModel(model()) },
      onEvent: event => events.push(event) })
    assert.equal(calls.length, tokens === 400269 ? 1 : 0)
    if (calls.length) {
      assert.deepEqual(calls, ['context-summary']); assert(result.checkpoint)
      assert.equal(events.find(event => event.type === 'compaction_started').reason, 'threshold')
    } else assert.equal(result.usage.availableInputTokens, 470904)
  }
})

test('ChatGPT effort picker offers documented levels without none, ultra, or an automatic override', async () => {
  const settings = settingsForModel({ ...DEFAULT_PREFERENCES, provider: 'chatgpt', model: 'gpt-6.1-sol' }, model())
  assert.equal(settings.reasoning, 'default')
  const result = await chooseEffort({ async choose(title, choices) {
    assert.deepEqual(choices.map(choice => choice.value), ['default', ...efforts])
    assert.match(choices[1].description, /account\/workspace policy can still reject/)
    return 'max'
  } }, settings)
  assert.equal(result.reasoning, 'max')
  const unknown = settingsForModel(result, model('future-model'))
  assert.equal(unknown.reasoning, 'default'); assert.deepEqual(unknown.reasoningCapabilities, [])
})

test('documented efforts reach the public subscription route while default omits reasoning and budget is never sent', async () => {
  for (const effort of [undefined, ...efforts]) {
    const metadata = model(), requests = []
    const provider = createChatGPTProvider({ model: metadata.id, accountId,
      accessToken: async () => 'offline-fixture-token', modelCapabilities: metadata.modelCapabilities,
      supportedReasoningEfforts: metadata.efforts, reasoning: effort ? { mode: 'effort', effort } : { mode: 'default' },
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) })
        return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
          { headers: { 'content-type': 'text/event-stream' } })
      } })
    await provider.generate(input, new AbortController().signal, { maxOutputTokens: 4096 })
    assert.equal(requests.length, 1); assert.equal(requests[0].url, 'https://api.openai.com/v1/responses')
    assert.deepEqual(requests[0].body.reasoning, effort ? { effort } : undefined)
    for (const key of ['max_output_tokens', 'context_window', 'contextBudget', 'contextWindow']) assert(!(key in requests[0].body))
    assert.equal(requests[0].body.store, false); assert.equal(requests[0].body.stream, true)
  }
  let credentials = 0, requests = 0
  for (const reasoning of [{ mode: 'disabled' }, { mode: 'effort', effort: 'ultra' }]) assert.throws(() => createChatGPTProvider({
    model: 'gpt-6.1-sol', accountId, accessToken: async () => { credentials++; return 'fixture' },
    supportedReasoningEfforts: efforts, reasoning, fetch: async () => { requests++; assert.fail('unverified effort cannot send') }
  }), /explicit model capability support/)
  assert.equal(credentials, 0); assert.equal(requests, 0)
})
