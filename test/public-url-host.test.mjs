// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { CliHost } from '../dist/host.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { FilePublicUrlOutcomeStore } from '../dist/public-url-outcomes.js'
import { PUBLIC_URL_LIMITS, publicUrlContainsSecret } from '../dist/public-url.js'
import { createBuiltinToolset } from '../dist/tools.js'
import { createPublicUrlExtension } from '../dist/public-url-tools.js'
import { routePreparedAction } from '@ayayaq/vivi/decisions'
import { mcpDigest } from '@ayayaq/vivi/extensions/mcp'

const url = 'https://example.com/selected?ordinary=one'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function response(config = {}) {
  const state = { closes: 0 }
  return { state, status: config.status ?? 200, headers: config.headers ?? { 'content-type': 'text/plain; charset=utf-8' },
    body: config.body ?? { async *[Symbol.asyncIterator]() { yield Buffer.from(config.text ?? 'ordinary public text') } },
    close() { state.closes++; config.onClose?.() } }
}
async function fixture(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vivi-public-url-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const secrets = [], reviews = [], humans = [], records = [], sends = [], resolves = [], events = [], saves = []
  const store = new FileSessionStore(join(root, 'state'), secrets)
  const fileOutcomes = new FilePublicUrlOutcomeStore(store.directory, secrets)
  let host, rounds = 0
  const outcomeStore = { load: id => fileOutcomes.load(id), addSecrets: values => fileOutcomes.addSecrets(values),
    drain: () => fileOutcomes.drain(), async save(id, rows, options) {
      saves.push(structuredClone(rows)); events.push(rows.some(row => row.state === 'intent') ? 'intent' : 'outcomes')
      await config.onOutcomeSave?.({ host, options: hostOptions, rows, guard: options?.assertCurrent, fileOutcomes })
      await fileOutcomes.save(id, rows, options)
    } }
  const hostOptions = { store, session: newSession({ provider: 'openai', model: 'fixture-model' }), secrets,
    publicUrlOutcomes: config.noOutcome ? undefined : outcomeStore,
    publicUrlTransport: { async resolve(hostname, signal, guard) {
      guard(); resolves.push(hostname); events.push('resolve')
      await config.onResolve?.({ host, options: hostOptions, signal, guard, secrets })
      return config.addresses ?? ['8.8.8.8']
    }, async request(request) {
      request.assertCurrent(); sends.push(request); events.push('request')
      const persisted = JSON.parse(await readFile(join(store.directory, `${host.session.id}.public-url-outcomes.json`), 'utf8'))
      assert(persisted.some(row => row.state === 'intent'))
      request.onTransmit()
      return await config.onRequest?.({ host, options: hostOptions, request, secrets, sends }) ?? response(config)
    } },
    approve: async (request, signal) => { humans.push(request); events.push('human'); await config.onHuman?.({ host, options: hostOptions, request, signal, secrets }); return config.allow ?? false },
    decisionReview: { canAutoReview: true, accountRevision: () => 'fixture-account', isAvailable: () => true,
      provider: { id: 'openai', model: 'gpt-6-luna', async evaluate(request, signal) {
        reviews.push(request); events.push('review'); await config.onReview?.({ host, options: hostOptions, request, signal, secrets })
        if (config.reviewFailure) throw new Error('private provider failure')
        return { model: 'gpt-6-luna', answers: request.policy.checks.map(check => ({ name: check.name, type: 'predicate', probability: config.probability ?? 1 })), usage: { inputTokens: 1, outputTokens: 1 } }
      } }, ledger: { async upsert(record) { records.push(structuredClone(record)); await config.onAudit?.({ host, options: hostOptions, record }) } } },
    provider: { async generate(input) {
      rounds++; config.inspectTools?.(input.tools)
      await config.onGenerate?.({ host, options: hostOptions, input, secrets })
      if (config.generate) return config.generate(input, rounds)
      if (rounds === 1) return { content: '', toolCalls: [{ id: 'public-url-call', name: 'fetch_url', arguments: config.arguments ?? { url: config.url ?? url } }] }
      return { content: 'Done', toolCalls: [] }
    } }, onEvent: event => config.onEvent?.({ host, event, options: hostOptions, secrets }) }
  if (config.noOutcome) hostOptions.store = { save: async () => {}, load: async () => hostOptions.session }
  host = new CliHost(hostOptions)
  t.after(() => host.shutdown())
  if (config.auto) host.setApprovalMode('auto')
  return { root, host, options: hostOptions, secrets, reviews, humans, records, sends, resolves, saves, events, store, fileOutcomes }
}
const resultBody = result => JSON.parse(result.history.find(message => message.kind === 'tool_result').content)

test('actual host advertises one fixed URL-only tool and reserves it from caller extensions', async t => {
  const subject = await fixture(t, { inspectTools(tools) {
    const tool = tools.find(item => item.name === 'fetch_url'); assert(tool)
    assert.deepEqual(tool.parameters.required, ['url']); assert.equal(tool.parameters.additionalProperties, false)
    assert.deepEqual(Object.keys(tool.parameters.properties), ['url'])
  } })
  await subject.host.send(`Read ${url}`)
  assert.throws(() => createBuiltinToolset(false, [createPublicUrlExtension(async () => ({ content: 'unsafe' }))]), /collision|reserved/)
})
test('no durable sink, disabled URL capability or chat-only model exposes no URL executor', async t => {
  for (const cause of ['sink', 'disabled', 'tools']) {
    const subject = await fixture(t, { noOutcome: cause === 'sink', inspectTools(tools) { assert(!tools.some(tool => tool.name === 'fetch_url')) } })
    if (cause === 'disabled') subject.options.enablePublicUrl = false
    if (cause === 'tools') subject.options.enableTools = false
    await subject.host.send('Ordinary chat')
    assert.equal(subject.sends.length, 0); assert.equal(subject.resolves.length, 0)
  }
})
for (const allow of [false, true]) test(`Manual exact URL disclosure and durable intent: ${allow}`, async t => {
  const subject = await fixture(t, { allow })
  const body = resultBody(await subject.host.send(`Read ${url}`))
  assert.equal(body.success, allow); assert.equal(subject.reviews.length, 0); assert.equal(subject.humans.length, 1)
  assert(subject.humans[0].description.includes(url)); assert.match(subject.humans[0].description, /full path and query|full path and query/i)
  assert.match(subject.humans[0].description, /server-side effects/); assert.equal(subject.sends.length, allow ? 1 : 0)
  if (allow) { assert.equal(body.untrusted, true); assert.equal(body.finalUrl, url); assert.equal(body.requests[0].transmission, 'observed'); assert(subject.events.indexOf('intent') < subject.events.indexOf('request')) }
  else assert.deepEqual(body.requests, [])
})
test('Auto binds exact trusted URL/network effect and records admission separately from retrieval', async t => {
  const subject = await fixture(t, { auto: true })
  const body = resultBody(await subject.host.send(`Read ${url}`))
  assert.equal(body.success, true); assert.equal(subject.reviews.length, 1); assert.equal(subject.humans.length, 0)
  const snapshot = subject.reviews[0].snapshot, effect = snapshot.preparedAction.effects[0]
  assert.equal(routePreparedAction(snapshot).route, 'model-review'); assert.equal(effect.kind, 'external'); assert.equal(effect.scope, 'external')
  assert.equal(effect.affectedData.url, url); assert.equal(effect.affectedData.method, 'GET'); assert.deepEqual({ ...effect.affectedData.limits }, PUBLIC_URL_LIMITS)
  assert.equal(snapshot.toolCall.arguments.url, url); assert.equal(snapshot.userRequest.text, `Read ${url}`)
  assert.deepEqual(subject.records.map(record => record.state), ['commit_started', 'committed'])
  assert(subject.records.every(record => record.actionKind === 'network-admission'))
  assert(!JSON.stringify(subject.records).includes(url)); assert.equal(subject.sends.length, 1)
})
for (const config of [{ probability: 0.5 }, { probability: 0.01 }, { reviewFailure: true }]) {
  test(`Auto uncertainty/rejection/failure falls back to exact human confirmation ${JSON.stringify(config)}`, async t => {
    const subject = await fixture(t, { ...config, auto: true, allow: true })
    assert.equal(resultBody(await subject.host.send(`Read ${url}`)).success, true)
    assert.equal(subject.humans.length, 1); assert(subject.humans[0].description.includes(url)); assert.equal(subject.sends.length, 1)
  })
}
for (const input of ['https://127.0.0.1/', 'https://10.1.2.3/', 'https://localhost/', 'http://example.com/',
  'https://example.com:444/', 'https://user@example.com/', 'https://example.com/?token=ordinary']) {
  test(`hard URL policy veto cannot be approved by a human or judge: ${input}`, async t => {
    const subject = await fixture(t, { auto: true, allow: true, url: input })
    const body = resultBody(await subject.host.send('Read the selected public page'))
    assert.equal(body.success, false); assert.equal(subject.reviews.length, 0); assert.equal(subject.humans.length, 0)
    assert.equal(subject.resolves.length, 0); assert.equal(subject.sends.length, 0)
  })
}
for (const addresses of [['127.0.0.1'], ['8.8.8.8', '10.0.0.1'], []]) test(`resolved private/mixed/empty answers cannot enter HTTP: ${addresses}`, async t => {
  const subject = await fixture(t, { auto: true, allow: true, addresses })
  assert.equal(resultBody(await subject.host.send(`Read ${url}`)).success, false)
  assert.equal(subject.sends.length, 0)
})
for (const cause of ['tools', 'url', 'transport', 'request', 'resolver', 'store', 'sink', 'account', 'provider', 'ledger', 'surface', 'cancel', 'secret']) {
  test(`actual host revokes stale ${cause} after review before DNS`, async t => {
    const subject = await fixture(t, { auto: true, onReview({ host, options, secrets }) {
      if (cause === 'tools') options.enableTools = false
      if (cause === 'url') options.enablePublicUrl = false
      if (cause === 'transport') options.publicUrlTransport = { ...options.publicUrlTransport }
      if (cause === 'request') options.publicUrlTransport.request = async () => { throw new Error('unexpected request') }
      if (cause === 'resolver') options.publicUrlTransport.resolve = async () => []
      if (cause === 'store') options.store = { save: options.store.save.bind(options.store), load: options.store.load.bind(options.store) }
      if (cause === 'sink') options.publicUrlOutcomes = { ...options.publicUrlOutcomes }
      if (cause === 'account') options.decisionReview.accountRevision = () => 'changed'
      if (cause === 'provider') options.decisionReview.provider = { ...options.decisionReview.provider }
      if (cause === 'ledger') options.decisionReview.ledger = { async upsert() {} }
      if (cause === 'surface') options.decisionReview.isAvailable = () => false
      if (cause === 'cancel') host.cancel()
      if (cause === 'secret') secrets.push('ordinary=one')
    } })
    const result = await subject.host.send(`Read ${url}`)
    assert.equal(resultBody(result).success, false); assert.equal(subject.resolves.length, 0); assert.equal(subject.sends.length, 0)
    assert.equal(subject.humans.length, 0)
  })
}
test('prepared call and human approval mutation cannot rewrite the destination', async t => {
  const subject = await fixture(t, { allow: true, onHuman({ request }) { request.call.arguments.url = 'https://other.example/replaced' } })
  assert.equal(resultBody(await subject.host.send(`Read ${url}`)).success, true)
  assert.equal(subject.sends.length, 1); assert.equal(subject.sends[0].url, url)
  assert.equal(subject.resolves.length, 1)
})
for (const phase of ['resolve', 'intent']) test(`final ${phase} boundary rechecks cancellation, secrets and authority`, async t => {
  for (const cause of ['cancel', 'secret', 'disabled']) {
    const mutate = ({ host, options, secrets }) => { if (cause === 'cancel') host.cancel(); else if (cause === 'secret') secrets.push('ordinary=one'); else options.enablePublicUrl = false }
    const subject = await fixture(t, { auto: true,
      ...(phase === 'resolve' ? { onResolve: mutate } : { onOutcomeSave({ host, options, rows, guard }) {
        if (!rows.some(row => row.state === 'intent')) return
        mutate({ host, options, secrets: subject.secrets }); guard?.()
      } }) })
    await subject.host.send(`Read ${url}`); assert.equal(subject.sends.length, 0)
    const persisted = await readFile(join(subject.store.directory, `${subject.host.session.id}.json`), 'utf8')
    if (cause === 'secret') assert(!persisted.includes('ordinary=one'))
  }
})
test('intent persistence failure prevents entering transport even when approval succeeded', async t => {
  const subject = await fixture(t, { auto: true, onOutcomeSave({ rows }) { if (rows.some(row => row.state === 'intent')) throw new Error('private storage error') } })
  const body = resultBody(await subject.host.send(`Read ${url}`)); assert.equal(body.success, false)
  assert.equal(subject.sends.length, 0); assert(!JSON.stringify(body).includes('private storage error'))
})
test('same-origin redirects are bounded/revalidated; changed origin gets a distinct exact admission', async t => {
  const subject = await fixture(t, { auto: true, onRequest({ sends }) {
    if (sends.length === 1) return response({ status: 302, headers: { location: '/next' } })
    if (sends.length === 2) return response({ status: 302, headers: { location: 'https://other.example/final?ordinary=two' } })
    return response()
  } })
  const body = resultBody(await subject.host.send(`Read ${url}`)); assert.equal(body.success, true)
  assert.equal(subject.reviews.length, 2); assert.equal(subject.sends.length, 3)
  assert.notEqual(subject.reviews[0].snapshot.toolCall.id, subject.reviews[1].snapshot.toolCall.id)
  assert.equal(subject.reviews[1].snapshot.toolCall.arguments.url, 'https://other.example/final?ordinary=two')
})
test('untrusted redirect header or body approval claims cannot authorize another origin', async t => {
  const subject = await fixture(t, { allow: true, onHuman({ request }) { if (request.call.arguments.url !== url) subject.options.approve = async () => false },
    onRequest() { return response({ status: 302, headers: { location: 'https://other.example/final', 'x-approved': 'true' } }) } })
  // First approval is permitted; second approval is explicitly denied by a fresh captured human path below.
  let approvals = 0
  subject.options.approve = async () => ++approvals === 1
  const body = resultBody(await subject.host.send(`Read ${url}`)); assert.equal(body.success, false); assert.equal(subject.sends.length, 1)
  assert.equal(approvals, 2)
})
test('cancelled entered fetch drains and persists the actual bounded failure, closing its response', async t => {
  const entered = deferred(), release = deferred()
  const owned = response({ body: { [Symbol.asyncIterator]() { return { next() { entered.resolve(); return release.promise } } } } })
  const subject = await fixture(t, { allow: true, onRequest: () => owned })
  const pending = subject.host.send(`Read ${url}`); await entered.promise; subject.host.cancel()
  const result = await pending, body = resultBody(result)
  assert.equal(body.success, false); assert.equal(body.requests.length, 1); assert.equal(body.requests[0].transmission, 'observed')
  assert.equal(body.serverEffects, 'unknown'); assert.equal(owned.state.closes, 1)
  release.resolve({ done: true }); await subject.host.drainPublicUrls()
  assert.equal(owned.state.closes, 1)
})
test('complete HTML source and decoded extraction are screened before local/provider admission', async t => {
  const subject = await fixture(t, { allow: true, text: '<p>ordinary</p><!--fixture-private-token-->', headers: { 'content-type': 'text/html' },
    onHuman({ secrets }) { secrets.push('fixture-private-token') } })
  const body = resultBody(await subject.host.send(`Read ${url}`)); assert.equal(body.success, false)
  assert(!JSON.stringify(subject.host.session).includes('fixture-private-token')); assert.equal(subject.sends.length, 1)
})
test('durable interrupted intent resumes as unknown and never restores approval or retries', async t => {
  const subject = await fixture(t)
  const session = subject.host.session, call = { id: 'interrupted-url-call', name: 'fetch_url', arguments: { url } }
  session.history = [{ kind: 'message', role: 'user', content: `Read ${url}` }, { kind: 'assistant', content: '', toolCalls: [call] }]
  await subject.store.save(session)
  await subject.fileOutcomes.save(session.id, [{ id: randomUUID(), sessionId: session.id, runId: randomUUID(), callId: call.id,
    toolName: call.name, callDigest: mcpDigest(call), bindingDigest: createHash('sha256').update('binding').digest('hex'), state: 'intent' }])
  let resumed
  resumed = await CliHost.resume({ ...subject.options, id: session.id, provider: { async generate(input) {
    const body = JSON.parse(input.messages.find(message => message.kind === 'tool_result').content)
    assert.equal(body.unknownOutcome, true); assert.equal(body.doNotRetry, true)
    return { content: 'The previous attempt is uncertain', toolCalls: [] }
  } } })
  t.after(() => resumed.shutdown()); assert.equal(resumed.approvalMode, 'manual')
  await resumed.send('What happened?'); assert.equal(subject.sends.length, 0); assert.equal(subject.humans.length, 0)
})
test('existing seven excluded historical filesystem cases retain exact canonical source and exclusions', () => {
  // Git's Windows checkout may render CRLF; compare unchanged canonical LF
  // source bytes without running or changing any excluded assessment.
  const source = readFileSync(new URL('./skills-store.test.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  for (const checkout of [source, source.replace(/\n/g, '\r\n')]) {
    assert.equal(createHash('sha256').update(checkout.replace(/\r\n/g, '\n')).digest('hex'), 'bd9068e4d8f249220ad890d2edafc8027785614590f7c0512918bde6a2517a4f')
  }
  assert.equal([...source.toString().matchAll(/^excludedAssessment\(/gm)].length, 7)
  assert.match(source.toString(), /Restricted\/adversarial filesystem assessment excluded and unrun/)
})

test('a fresh model call ID cannot automatically retry a URL after a possible send within one run', async t => {
  const subject = await fixture(t, { auto: true, generate(_input, rounds) {
    if (rounds <= 2) return { content: '', toolCalls: [{ id: `attempt-${rounds}`, name: 'fetch_url', arguments: { url } }] }
    return { content: 'The first attempt is uncertain', toolCalls: [] }
  }, onRequest() { throw new Error('private transport failure after send') } })
  const result = await subject.host.send(`Read ${url}`)
  const bodies = result.history.filter(message => message.kind === 'tool_result').map(message => JSON.parse(message.content))
  assert.equal(bodies.length, 2); assert.equal(bodies[0].doNotRetry, true)
  assert.equal(bodies[1].error.code, 'public_url_retry_blocked'); assert.equal(bodies[1].transmission, 'not_attempted')
  assert.equal(subject.sends.length, 1); assert.equal(subject.reviews.length, 1)
})
test('an explicitly new user turn can admit a new same-URL request without restoring the old receipt', async t => {
  let calls = 0
  const subject = await fixture(t, { auto: true, generate(input) {
    if (input.messages.at(-1)?.kind === 'message' && input.messages.at(-1).role === 'user') {
      return { content: '', toolCalls: [{ id: `turn-call-${++calls}`, name: 'fetch_url', arguments: { url } }] }
    }
    return { content: 'Done', toolCalls: [] }
  } })
  assert.equal(resultBody(await subject.host.send(`Read ${url}`)).success, true)
  const second = await subject.host.send(`Read ${url} again`)
  assert.equal(JSON.parse(second.history.filter(message => message.kind === 'tool_result').at(-1).content).success, true)
  assert.equal(subject.reviews.length, 2); assert.equal(subject.sends.length, 2)
  assert.notEqual(subject.reviews[0].snapshot.runId, subject.reviews[1].snapshot.runId)
})

test('actual host handles a large bounded page without per-character cryptographic admission work', async t => {
  const subject = await fixture(t, { auto: true, text: 'ordinary text '.repeat(10000) })
  const body = resultBody(await subject.host.send(`Read ${url}`))
  assert.equal(body.success, true); assert.equal(body.bytesRead, 140000)
  assert.equal(body.truncated, true); assert(Buffer.byteLength(JSON.stringify(body)) <= 64 * 1024)
  assert.equal(subject.sends.length, 1); assert.equal(subject.reviews.length, 1)
})
test('newly replaced host secret list vetoes the pending URL even if the reviewer list was captured earlier', async t => {
  const subject = await fixture(t, { auto: true, onReview({ options }) { options.secrets = ['ordinary=one'] } })
  const result = await subject.host.send(`Read ${url}`)
  assert.equal(resultBody(result).success, false); assert.equal(subject.sends.length, 0); assert.equal(subject.resolves.length, 0)
  assert(!JSON.stringify(subject.host.session).includes('ordinary=one'))
})

for (const allow of [false, true]) test(`final Auto audit failure asks a human before the actual HTTP request: ${allow}`, async t => {
  let failed = false
  const subject = await fixture(t, { auto: true, allow, onAudit({ record }) {
    if (record.toolName === 'fetch_url' && record.state === 'committed' && record.source === 'automatic' && !failed) {
      failed = true; throw new Error('private final admission audit failure')
    }
  } })
  const body = resultBody(await subject.host.send(`Read ${url}`))
  assert.equal(body.success, allow); assert.equal(subject.humans.length, 1); assert.equal(subject.reviews.length, 1)
  assert.equal(subject.sends.length, allow ? 1 : 0); assert.equal(subject.resolves.length, allow ? 1 : 0)
  assert(subject.humans[0].description.includes(url)); assert(!JSON.stringify(body).includes('private final admission audit failure'))
  assert.throws(() => subject.host.setApprovalMode('auto'), /healthy review ledger/)
})

test('a newly known HTML-entity credential in final assistant text is withheld from returned content and history', async t => {
  const marker = 'fixture-review-secret', encoded = [...marker].map(point => `&#${point.charCodeAt(0)};`).join('')
  const subject = await fixture(t, { allow: true, generate(_input, rounds) {
    return rounds === 1 ? { content: '', toolCalls: [{ id: 'late-final-secret', name: 'fetch_url', arguments: { url } }] }
      : { content: encoded, toolCalls: [] }
  }, onEvent({ event, secrets }) { if (event.type === 'assistant' && event.message.toolCalls.length === 0) secrets.push(marker) } })
  const result = await subject.host.send(`Read ${url}`)
  assert.equal(result.status, 'completed'); assert(!publicUrlContainsSecret(result.content, [marker]))
  assert.equal(result.content, '[Public URL response content withheld: known credential]')
  assert(!publicUrlContainsSecret(result.history, [marker])); assert(!publicUrlContainsSecret(subject.host.session, [marker]))
  assert.equal(subject.host.conversationRecords.state, 'quarantined')
  await subject.host.shutdown()
  const shadow = JSON.parse(await readFile(join(subject.store.directory, `${subject.host.session.id}.records.json`), 'utf8'))
  assert.equal(shadow.state, 'quarantined'); assert(!publicUrlContainsSecret(shadow, [marker]))
})

test('newly known entity-encoded URL call IDs are rewritten consistently without rejecting the turn', async t => {
  const marker = 'fixture-secret', encoded = [...marker].map(point => `&#${point.charCodeAt(0)};`).join('')
  const subject = await fixture(t, { allow: true, generate(_input, rounds) {
    return rounds === 1 ? { content: '', toolCalls: [{ id: encoded, name: 'fetch_url', arguments: { url } }] }
      : { content: 'The request was blocked', toolCalls: [] }
  }, onHuman({ secrets }) { secrets.push(marker) } })
  const result = await subject.host.send(`Read ${url}`)
  assert.equal(subject.sends.length, 0); assert.equal(subject.resolves.length, 0)
  const accepted = result.history.find(message => message.kind === 'assistant').toolCalls[0]
  const response = result.history.find(message => message.kind === 'tool_result')
  assert.notEqual(accepted.id, encoded); assert.equal(response.callId, accepted.id)
  assert(!publicUrlContainsSecret(result, [marker])); assert(!publicUrlContainsSecret(subject.host.session, [marker]))
  const persisted = await readFile(join(subject.store.directory, `${subject.host.session.id}.json`), 'utf8')
  assert(!publicUrlContainsSecret(persisted, [marker]))
})

test('replaced host secrets screen the complete current request before any Auto judge transmission', async t => {
  const marker = 'fixture-user-request-credential'
  const subject = await fixture(t, { auto: true, allow: false, onGenerate({ options }) { options.secrets = [marker] } })
  const result = await subject.host.send(`Read ${url}; private context ${marker}`)
  assert.equal(resultBody(result).success, false)
  assert.equal(subject.reviews.length, 0); assert.equal(subject.humans.length, 1)
  assert(!publicUrlContainsSecret(subject.humans, [marker]))
  assert.equal(subject.sends.length, 0); assert.equal(subject.resolves.length, 0)
  assert(!publicUrlContainsSecret(subject.host.session, [marker]))
  assert.equal(subject.host.conversationRecords.state, 'quarantined')
  await subject.host.shutdown()
  const shadow = JSON.parse(await readFile(join(subject.store.directory, `${subject.host.session.id}.records.json`), 'utf8'))
  assert.equal(shadow.state, 'quarantined'); assert(!publicUrlContainsSecret(shadow, [marker]))
})

test('a replacement secret list quarantines already accepted encoded shadow bytes', async t => {
  const marker = 'fixture-replaced-shadow-credential', encoded = [...marker].map(point => `&#${point.charCodeAt(0)};`).join('')
  const subject = await fixture(t, { allow: true, generate(_input, rounds) {
    return rounds === 1 ? { content: '', toolCalls: [{ id: 'replaced-final-secret', name: 'fetch_url', arguments: { url } }] }
      : { content: encoded, toolCalls: [] }
  }, onEvent({ event, options }) { if (event.type === 'assistant' && event.message.toolCalls.length === 0) options.secrets = [marker] } })
  const result = await subject.host.send(`Read ${url}`)
  assert(!publicUrlContainsSecret(result, [marker])); assert(!publicUrlContainsSecret(subject.host.session, [marker]))
  assert.equal(subject.host.conversationRecords.state, 'quarantined')
  await subject.host.shutdown()
  const shadow = JSON.parse(await readFile(join(subject.store.directory, `${subject.host.session.id}.records.json`), 'utf8'))
  assert.equal(shadow.state, 'quarantined'); assert(!publicUrlContainsSecret(shadow, [marker]))
})
