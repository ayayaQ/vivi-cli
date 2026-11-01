// SPDX-License-Identifier: Apache-2.0
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { compactContext } from '@ayayaq/vivi'
import { createChatGPTProvider, projectChatGPTRequest, CHATGPT_USAGE_URL } from '../dist/chatgpt-provider.js'
import { ChatGPTModelCatalog, parseChatGPTModelCatalog } from '../dist/chatgpt-models.js'
const signal = () => new AbortController().signal
const accountId = 'a'.repeat(64)
const frame = value => `data: ${JSON.stringify(value)}\n\n`
const sse = (...events) => new Response(events.map(frame).join(''), { headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_fixture' } })
const completed = (output = []) => ({ type: 'response.completed', response: { status: 'completed', output } })
const message = content => ({ type: 'message', id: 'message_fixture', role: 'assistant', content: [{ type: 'output_text', text: content, annotations: [] }] })
const tool = { name: 'read_state', description: 'Read state', parameters: { type: 'object', properties: {} } }
const seed = [{ kind: 'message', role: 'system', content: 'Host instructions' }, { kind: 'message', role: 'user', content: 'Inspect' }]
function harness(replies, options = {}) {
  const requests = []; let credentials = 0
  const provider = createChatGPTProvider({ accountId, model: 'fixture-model', accessToken: async () => `fixture-token-${++credentials}`,
    fetch: async (url, init) => {
      assert(replies.length, 'no live network fallback'); requests.push({ url: String(url), body: JSON.parse(init.body), headers: new Headers(init.headers) })
      return replies.shift()
    }, ...options })
  return { provider, requests, credentials: () => credentials }
}
const noUnsupportedFields = body => {
  for (const name of ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt',
    'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id']) assert(!(name in body), name)
  assert.equal(body.store, false); assert.equal(body.stream, true); assert(Array.isArray(body.input)); assert(!body.input.some(item => item.role === 'system'))
}

test('ChatGPT always uses SSE and buffers display-only no-stream; schemas and history share namespaces', async () => {
  const native = [ { type: 'reasoning', id: 'reason_fixture', summary: [], encrypted_content: 'opaque-reasoning' },
    { type: 'function_call', id: 'item_fixture', call_id: 'call_fixture', name: tool.name, namespace: 'vivi', arguments: '{}' } ]
  const h = harness([sse({ type: 'response.output_text.delta', delta: 'hidden' }, completed(native)), sse(completed([message('Done')]))])
  let deltas = 0
  const first = await h.provider.generate({ messages: seed, tools: [tool] }, signal(), { onProgress: () => { deltas++ }, maxOutputTokens: 1 })
  assert.equal(deltas, 0); assert.equal(h.credentials(), 1)
  const history = [...seed, { kind: 'assistant', ...first }, { kind: 'tool_result', callId: 'call_fixture', name: tool.name, content: 'observed' }]
  await h.provider.generate({ messages: history, tools: [tool] }, signal())
  assert.equal(h.requests[0].url, 'https://api.openai.com/v1/responses')
  assert.equal(h.requests[1].headers.get('authorization'), 'Bearer fixture-token-2')
  assert.deepEqual(h.requests[0].body.tools, [{ type: 'namespace', name: 'vivi', description: 'Vivi host tools. The host independently validates and authorizes every operation.', tools: [{ type: 'function', ...tool, strict: false }] }])
  assert.deepEqual(h.requests[1].body.input.slice(2, 4), native)
  for (const request of h.requests) noUnsupportedFields(request.body)
  const canonical = projectChatGPTRequest({ model: 'fixture-model', input: [{ type: 'function_call', call_id: 'old', name: tool.name, arguments: '{}' }], stream: true })
  assert.equal(canonical.input[0].namespace, 'vivi')
})

test('display streaming emits progress but only completed SSE commits a result; usage failures carry recovery', async () => {
  const h = harness([sse({ type: 'response.output_text.delta', delta: 'partial' },
    { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', param: 'model', message: 'private-body' } } })], { stream: true })
  const deltas = []
  await assert.rejects(h.provider.generate({ messages: seed, tools: [] }, signal(), { onProgress: event => deltas.push(event.text) }), error => {
    assert.match(error.message, /usage limit reached/); assert(error.message.includes(CHATGPT_USAGE_URL)); assert.equal(error.details.code, 'subscription_sharing_usage_limit_exceeded')
    assert.equal(error.details.requestId, 'req_fixture'); assert(!JSON.stringify(error).includes('private-body')); return true
  })
  assert.deepEqual(deltas, ['partial']); assert.equal(h.requests.length, 1)
  const incomplete = harness([sse({ type: 'response.output_text.delta', delta: 'not done' })])
  await assert.rejects(incomplete.provider.generate({ messages: seed, tools: [] }, signal()), /before completion/)
})

test('ChatGPT rejects foreign tool namespaces before execution', async () => {
  const h = harness([sse(completed([{ type: 'function_call', call_id: 'call_1', name: tool.name, namespace: 'other', arguments: '{}' }]))])
  await assert.rejects(h.provider.generate({ messages: seed, tools: [tool] }, signal()), /namespace/)
  assert.throws(() => projectChatGPTRequest({ model: 'fixture', input: [{ type: 'function_call', namespace: 'other' }] }), /namespace/)
})

test('ChatGPT context compaction uses the same wire projection without unsupported output bounds', async () => {
  const h = harness([sse(completed([message('concise historical facts')]))])
  const history = [...seed.slice(0, 1), ...Array.from({ length: 10 }, (_, index) => [
    { kind: 'message', role: 'user', content: `old request ${index} ${'a'.repeat(250)}` },
    { kind: 'assistant', content: `old response ${index} ${'b'.repeat(250)}`, toolCalls: [] }
  ]).flat(), seed[1]]
  const before = structuredClone(history)
  const compacted = await compactContext({ provider: h.provider, messages: history, tools: [tool], context: { sourceId: 'fixture-session', keepRecentMessages: 3 } })
  assert(compacted.checkpoint); assert.deepEqual(history, before); assert.equal(h.requests.length, 1)
  noUnsupportedFields(h.requests[0].body); assert(!('tools' in h.requests[0].body))
})

test('ChatGPT catalog uses visible slugs and labels in server order without static capability assumptions', () => {
  const models = parseChatGPTModelCatalog({ models: [
    { slug: 'z-model', display_name: 'Zed', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
    { slug: 'gpt-5', display_name: 'Account choice', visibility: 'list' }, { slug: 'z-model', display_name: 'Duplicate', visibility: 'list' }
  ] })
  assert.deepEqual(models.map(model => [model.id, model.name]), [['z-model', 'Zed'], ['gpt-5', 'Account choice']])
  for (const model of models) { assert.equal(model.tools, 'unknown'); assert.equal(model.vision, undefined); assert.deepEqual(model.efforts, []); assert.equal(model.modelCapabilities.vision, 'unknown') }
  assert.throws(() => parseChatGPTModelCatalog({ data: [{ id: 'api-key-schema' }] }), /format/)
})

test('ChatGPT model cache is registration-bound, refreshable and does not retain credentials', async () => {
  const requests = []
  const catalog = new ChatGPTModelCatalog({ accessToken: async id => `fixture-${id}`, fetch: async (url, init) => {
    requests.push([String(url), new Headers(init.headers).get('authorization')])
    return new Response(JSON.stringify({ models: [{ slug: `model-${requests.length}`, display_name: 'Choice', visibility: 'list' }] }))
  } })
  assert.equal((await catalog.list('account-a')).models[0].id, 'model-1')
  assert.equal((await catalog.list('account-a')).state, 'cached'); assert.equal(requests.length, 1)
  assert.equal((await catalog.list('account-b')).models[0].id, 'model-2')
  assert.equal((await catalog.list('account-a', undefined, true)).models[0].id, 'model-3')
  catalog.clear('account-a'); await catalog.list('account-a'); assert.equal(requests.length, 4)
  assert.deepEqual(requests[1], ['https://api.openai.com/v1/models', 'Bearer fixture-account-b'])
})

test('ChatGPT catalog cancellation settles even when fetch ignores abort, with late data quarantined', async () => {
  let release, calls = 0
  const catalog = new ChatGPTModelCatalog({ accessToken: async () => 'fixture-token', fetch: async () => {
    calls++
    if (calls === 1) return await new Promise(resolve => { release = resolve })
    return new Response(JSON.stringify({ models: [{ slug: 'new-model', visibility: 'list' }] }))
  } })
  const controller = new AbortController(), pending = catalog.list('account-a', controller.signal)
  while (!release) await new Promise(resolve => setTimeout(resolve, 0))
  controller.abort()
  await assert.rejects(pending, /cancelled/)
  release(new Response(JSON.stringify({ models: [{ slug: 'obsolete-model', visibility: 'list' }] })))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal((await catalog.list('account-a')).models[0].id, 'new-model')
  assert.equal(calls, 2)
})

test('ChatGPT catalog does not echo credential-bearing resolver or transport error messages', async () => {
  for (const options of [
    { accessToken: async () => { throw new Error('ChatGPT fixture-secret') }, fetch: async () => { throw new Error('not reached') } },
    { accessToken: async () => 'fixture-secret', fetch: async () => { throw new Error('ChatGPT fixture-secret') } }
  ]) {
    const catalog = new ChatGPTModelCatalog(options)
    await assert.rejects(catalog.list('account-a'), error => !error.message.includes('fixture-secret'))
  }
})

test('ChatGPT masks unexpected resolver diagnostics without making an inference request', async () => {
  let requests = 0
  const provider = createChatGPTProvider({ accountId, model: 'fixture', accessToken: async () => { throw new Error('fixture-private-token') },
    fetch: async () => { requests++; throw new Error('not reached') } })
  await assert.rejects(provider.generate({ messages: seed, tools: [] }, signal()), error => /credential renewal/.test(error.message) && !error.message.includes('fixture-private-token'))
  assert.equal(requests, 0)
})

test('ChatGPT native history is bound to exact account and model, with no caller mutation', async () => {
  const h = harness([sse(completed([{ type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'opaque' }]))])
  const result = await h.provider.generate({ messages: seed, tools: [] }, signal())
  assert.equal(result.providerState.provider, `chatgpt:${accountId}:fixture-model`)
  const history = [...seed, { kind: 'assistant', ...result }], before = structuredClone(history)
  h.provider.estimateContext({ messages: history, tools: [] })
  assert.deepEqual(history, before)
  const other = harness([], { accountId: 'b'.repeat(64) })
  assert.throws(() => other.provider.estimateContext({ messages: history, tools: [] }), /another account or model/)
  await assert.rejects(other.provider.generate({ messages: history, tools: [] }, signal()), /another account or model/)
  assert.equal(other.credentials(), 0); assert.equal(other.requests.length, 0)
  const apiKeyState = structuredClone(history); apiKeyState.at(-1).providerState.provider = 'openai:fixture-model'
  await assert.rejects(h.provider.generate({ messages: apiKeyState, tools: [] }, signal()), /another account or model/)
  assert.throws(() => createChatGPTProvider({ accountId: 'not-validated', model: 'fixture', accessToken: async () => 'never-used' }), /validated account/)
})

test('ChatGPT generation change while credentials are pending never sends a stale token', { timeout: 3000 }, async () => {
  let generation = 0, releaseToken, requests = 0
  const provider = createChatGPTProvider({ accountId, model: 'fixture-model', isCurrent: () => generation === 0,
    accessToken: async () => await new Promise(resolve => { releaseToken = resolve }),
    fetch: async () => { requests++; return sse(completed()) } })
  const pending = provider.generate({ messages: seed, tools: [] }, signal())
  assert.equal(typeof releaseToken, 'function')
  generation++
  releaseToken('fixture-private-token')
  await assert.rejects(pending, error => error.code === 'account-changed' && !error.message.includes('fixture-private-token'))
  assert.equal(requests, 0)
})

test('ChatGPT rechecks its generation immediately at the HTTP dispatch boundary', async () => {
  let checks = 0, requests = 0
  const provider = createChatGPTProvider({ accountId, model: 'fixture-model', isCurrent: () => ++checks < 3,
    accessToken: async () => 'fixture-token', fetch: async () => { requests++; return sse(completed()) } })
  await assert.rejects(provider.generate({ messages: seed, tools: [] }, signal()), error => error.code === 'account-changed')
  assert.equal(requests, 0)
  assert(checks >= 3)
})

test('ChatGPT generation change while inference is pending rejects late completed output', { timeout: 3000 }, async () => {
  let current = true, releaseResponse, requests = 0, accepted = false
  const provider = createChatGPTProvider({ accountId, model: 'fixture-model', isCurrent: () => current,
    accessToken: async () => 'fixture-token', fetch: async () => {
      requests++; return await new Promise(resolve => { releaseResponse = resolve })
    } })
  const pending = provider.generate({ messages: seed, tools: [] }, signal()).then(result => { accepted = true; return result })
  while (!releaseResponse) await new Promise(resolve => setTimeout(resolve, 0))
  current = false
  releaseResponse(sse(completed([message('obsolete output') ])))
  await assert.rejects(pending, error => error.code === 'account-changed')
  assert.equal(requests, 1); assert.equal(accepted, false)
})

test('ChatGPT generation change suppresses further display progress from the old account', { timeout: 3000 }, async () => {
  let current = true, body, firstDelta
  const displayed = [], sawFirst = new Promise(resolve => { firstDelta = resolve })
  const provider = createChatGPTProvider({ accountId, model: 'fixture-model', stream: true, isCurrent: () => current,
    accessToken: async () => 'fixture-token', fetch: async () => new Response(new ReadableStream({ start(controller) { body = controller } }),
      { headers: { 'content-type': 'text/event-stream' } }) })
  const pending = provider.generate({ messages: seed, tools: [] }, signal(), { onProgress: event => {
    displayed.push(event.text); firstDelta()
  } })
  while (!body) await new Promise(resolve => setTimeout(resolve, 0))
  body.enqueue(new TextEncoder().encode(frame({ type: 'response.output_text.delta', delta: 'current' })))
  await sawFirst
  current = false
  body.enqueue(new TextEncoder().encode(frame({ type: 'response.output_text.delta', delta: 'obsolete' })))
  await assert.rejects(pending, error => error.code === 'account-changed')
  assert.deepEqual(displayed, ['current'])
})


test('ChatGPT fails closed when an older core ignores the required request projection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-chatgpt-core-compat-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fake = join(directory, 'old-core.mjs'), hooks = join(directory, 'hooks.mjs'), register = join(directory, 'register.mjs')
  await writeFile(fake, `export { ProviderRequestError } from ${JSON.stringify(import.meta.resolve('@ayayaq/vivi/providers/openai'))};\nexport function createOpenAIProvider() { return { estimateContext(){return {}}, generate(){throw new Error('Legacy generation must not run')} } }`)
  await writeFile(hooks, `export function resolve(name,context,next){return name==='@ayayaq/vivi/providers/openai'?{url:${JSON.stringify(pathToFileURL(fake).href)},shortCircuit:true}:next(name,context)}`)
  await writeFile(register, `import {register} from 'node:module';register(${JSON.stringify(pathToFileURL(hooks).href)})`)
  const script = `import assert from 'node:assert/strict';import {createChatGPTProvider} from ${JSON.stringify(new URL('../dist/chatgpt-provider.js', import.meta.url).href)};let tokens=0,requests=0;assert.throws(()=>createChatGPTProvider({model:'fixture',accountId:'a'.repeat(64),accessToken:async()=>{tokens++;return 'fixture'},fetch:async()=>{requests++;throw new Error('No network')}}),/core release with request projection/);assert.equal(tokens,0);assert.equal(requests,0);console.log('Legacy core rejected before credentials or network')`
  // Bun's loader flags differ; execute this ordinary Node contract with the installed Node binary.
  const executable = process.versions.bun ? 'node' : process.execPath
  const result = spawnSync(executable, ['--import', pathToFileURL(register).href, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /Legacy core rejected/)
})


test('ChatGPT bearer route remains fixed even when a JavaScript caller supplies an API-key baseURL option', async () => {
  const targets = []
  const provider = createChatGPTProvider({ model: 'fixture', accountId, baseURL: 'https://example.invalid/v1',
    accessToken: async () => 'fixture-only-token', fetch: async (url, init) => { targets.push(String(url)); assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-only-token'); return sse(completed()) } })
  await provider.generate({ messages: seed, tools: [] }, signal())
  assert.deepEqual(targets, ['https://api.openai.com/v1/responses'])
})
