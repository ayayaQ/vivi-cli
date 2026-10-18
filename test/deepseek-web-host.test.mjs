// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CliHost } from '../dist/host.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { FilePublicUrlOutcomeStore, publicUrlOutcomeResult, cliPublicUrlRecordOutcome } from '../dist/public-url-outcomes.js'
import { createBuiltinToolset, BUILTIN_TOOL_OUTCOME_POLICIES } from '../dist/tools.js'
import { createDeepSeekWebExtension, DEEPSEEK_WEB_DISCLOSURE } from '../dist/web-tools.js'
import { autoReviewSharingScope, autoReviewPolicy } from '../dist/auto-review.js'
const url = 'https://example.com/article?topic=ordinary'
const query = 'ordinary topic site:example.com'
const success = operation => operation === 'search' ? { results: [{ title: 'Example', url, snippet: 'Snippet', summary: 'Summary', content: '' }] }
  : { title: 'Example', content: 'Example page' }
async function fixture(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vivi-deepseek-web-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const account = { value: 'account-one' }
  const secrets = ['fixture-web-key'], sends = [], humans = [], reviews = [], audits = [], events = [], outcomes = []
  const store = new FileSessionStore(join(root, 'state'), secrets)
  const sink = new FilePublicUrlOutcomeStore(store.directory, secrets)
  let host, rounds = 0
  const operation = config.operation ?? 'search'
  const call = { id: 'web-call', name: operation === 'search' ? 'web_search' : 'fetch_url', arguments: config.arguments ?? (operation === 'search' ? { query } : { url }) }
  const options = { session: newSession({ provider: config.chatProvider ?? 'openai', model: 'fixture' }), store, secrets,
    web: { provider: 'deepseek', revision: randomUUID(), apiKey: () => 'fixture-web-key', async fetch(input, init) {
      sends.push({ input, init }); events.push('send')
      const persisted = await sink.load(host.session.id)
      assert(persisted.some(row => row.state === 'intent'))
      await config.onFetch?.({ host, options, secrets, account, input, init })
      if (config.transportFailure) throw new Error('fixture private body')
      return new Response(JSON.stringify(config.body ?? success(operation)), { status: config.status ?? 200, headers: { 'content-type': 'application/json' } })
    } }, publicUrlTransport: { async resolve(hostname, signal, guard) { guard(); events.push('resolve'); await config.onResolve?.({ host, options, secrets, signal }); return config.addresses ?? ['8.8.8.8'] } },
    publicUrlOutcomes: { load: id => sink.load(id), drain: () => sink.drain(), addSecrets: values => sink.addSecrets(values), async save(id, rows, saveOptions) {
      outcomes.push(structuredClone(rows)); events.push(rows.some(row => row.state === 'intent') ? 'intent' : 'outcome')
      await config.onSave?.({ host, options, secrets, rows, guard: saveOptions?.assertCurrent })
      await sink.save(id, rows, saveOptions)
      await config.afterSave?.({ host, options, secrets, account, rows })
    } },
    async approve(request, signal) { humans.push(request); events.push('human'); await config.onHuman?.({ host, options, secrets, request, signal }); return config.allow ?? false },
    decisionReview: { canAutoReview: true, accountRevision: () => account.value, isAvailable: () => true,
      ...(config.chatProvider === 'deepseek' ? { explicitReviewer: true } : {}),
      provider: { id: 'openai', model: 'gpt-6-luna', async evaluate(request, signal) {
        reviews.push(request); events.push('review'); await config.onReview?.({ host, options, secrets, request, signal })
        if (config.reviewFailure) throw new Error('fixture private error')
        return { model: 'gpt-6-luna', answers: request.policy.checks.map(check => ({ name: check.name, type: 'predicate', probability: config.probability ?? 1 })), usage: { inputTokens: 1, outputTokens: 1 } }
      } }, ledger: { async upsert(record) { audits.push(record); await config.onAudit?.({ host, options, secrets, record }) } } },
    provider: { async generate(input) {
      rounds++; config.inspect?.(input)
      if (config.generate) return config.generate(input, rounds)
      if (rounds === 1) return { content: '', toolCalls: [call] }
      return { content: 'Done', toolCalls: [] }
    } } }
  if (config.noSink) { options.store = { save: async () => {} }; delete options.publicUrlOutcomes }
  if (config.noTools) options.enableTools = false
  host = new CliHost(options); t.after(() => host.shutdown())
  if (config.plan) host.setTaskMode('plan')
  if (config.auto) host.setApprovalMode('auto')
  return { host, options, secrets, account, sends, humans, reviews, audits, events, outcomes, sink, call }
}
const body = result => JSON.parse(result.history.find(message => message.kind === 'tool_result')?.content ?? '{}')
for (const operation of ['search', 'fetch']) {
  for (const auto of [false, true]) test(`${operation} ${auto ? 'Auto' : 'Manual'} uses exact fixed DeepSeek route and durable intent`, async t => {
    const f = await fixture(t, { operation, auto, allow: true })
    const result = await f.host.send(operation === 'search' ? `Search the web for ${query}` : `Read ${url}`)
    const value = body(result)
    assert.equal(value.success, true); assert.equal(value.source, 'web_provider'); assert.equal(value.provider, 'deepseek')
    assert.equal(value.requestState, 'response_received'); assert.equal(value.billing, 'unverified')
    assert.equal(value.finalUrl, undefined); assert.equal(value.httpStatus, undefined); assert.equal(value.bodySha256, undefined)
    assert.equal(f.sends.length, 1); assert.equal(f.sends[0].input, `https://api.deepseek.com/v1/tools/${operation}`)
    assert.equal(f.sends[0].init.headers.Authorization, 'Bearer fixture-web-key')
    assert.equal(f.humans.length, auto ? 0 : 1); assert.equal(f.reviews.length, auto ? 1 : 0)
    assert(f.events.indexOf('intent') < f.events.indexOf('send'))
    if (operation === 'fetch') { assert(f.events.indexOf(auto ? 'review' : 'human') < f.events.indexOf('resolve')); assert.equal(value.requestedUrl, url) }
    else { assert.equal(value.results[0].url, url); assert.deepEqual(JSON.parse(f.sends[0].init.body), { query, count: 5, need_content: false }) }
    const projection = f.host.toolPresentationEvidence.projection
    assert(projection.outcomes.some(row => row.callId === f.call.id && row.status === 'succeeded' && row.effect === 'unknown'))
    if (auto) {
      assert.match(f.reviews[0].snapshot.policyRevision, /deepseek-web/)
      assert.equal(f.reviews[0].snapshot.inputData.provider, 'deepseek')
      assert.match(f.reviews[0].snapshot.inputData.cost, /0\.00075/)
      assert(f.reviews[0].snapshot.userRequest.approvedScope.tools.includes('web_search'))
      assert(f.audits.every(row => row.actionKind === 'network-admission'))
    } else assert.match(f.humans[0].description, /DeepSeek.*separate paid service|separate paid service/s)
  })
}
for (const config of [{}, { auto: true, reviewFailure: true }, { auto: true, probability: .8 }]) test(`denial blocks paid dispatch ${JSON.stringify(config)}`, async t => {
  const f = await fixture(t, config)
  assert.equal(body(await f.host.send(`Search ${query}`)).success, false)
  assert.equal(f.sends.length, 0); assert.equal(f.humans.length, 1)
})
test('unknown paid send is not retried within the same user turn and stays unknown in durable evidence', async t => {
  const f = await fixture(t, { auto: true, transportFailure: true, generate(_input, round) {
    if (round <= 2) return { content: '', toolCalls: [{ id: `call-${round}`, name: 'web_search', arguments: { query } }] }
    return { content: 'Done', toolCalls: [] }
  } })
  const result = await f.host.send(`Search ${query}`), results = result.history.filter(row => row.kind === 'tool_result').map(row => JSON.parse(row.content))
  assert.equal(f.sends.length, 1); assert.equal(results[0].unknownOutcome, true); assert.equal(results[1].error.code, 'web_retry_blocked')
  assert(f.host.toolPresentationEvidence.projection.outcomes.some(row => row.callId === 'call-1' && row.status === 'unknown'))
})
test('Plan, missing durable evidence, and tools-off expose no web capability', async t => {
  for (const config of [{ plan: true }, { noSink: true }, { noTools: true }]) {
    const f = await fixture(t, { ...config, inspect(input) { assert(!input.tools.some(tool => ['fetch_url', 'web_search'].includes(tool.name))) } })
    await f.host.send('Ordinary chat'); assert.equal(f.sends.length, 0); assert.equal(f.humans.length, 0)
  }
})
for (const args of [{ query, endpoint: 'https://evil.example' }, { query: 'a'.repeat(129) }, { query, count: 6 }, { query, includeContent: 'yes' }, { url: 'https://127.0.0.1/' }]) test(`invalid arguments block before review ${JSON.stringify(args)}`, async t => {
  const f = await fixture(t, { arguments: args, operation: 'url' in args ? 'fetch' : 'search', auto: true })
  await f.host.send('Search public web'); assert.equal(f.sends.length, 0); assert.equal(f.reviews.length, 0)
})
for (const stage of ['onHuman', 'onReview', 'onResolve', 'onSave']) test(`credential learned at ${stage} prevents paid send`, async t => {
  const f = await fixture(t, { operation: stage === 'onResolve' ? 'fetch' : 'search', auto: stage !== 'onHuman', allow: true,
    [stage]({ secrets, rows }) { if (!rows || rows.some(row => row.state === 'intent')) secrets.push(stage === 'onResolve' ? 'ordinary' : query) } })
  await f.host.send(`Search ${query}`); assert.equal(f.sends.length, 0)
})
test('private fetch resolution blocks API send after exact approval', async t => {
  const f = await fixture(t, { operation: 'fetch', auto: true, addresses: ['127.0.0.1'] })
  await f.host.send(`Read ${url}`); assert.equal(f.sends.length, 0)
})
test('changing web mode revokes Auto and cannot silently use paid fallback', async t => {
  const f = await fixture(t, { auto: true, generate(input) { assert(!input.tools.some(tool => tool.name === 'web_search')); return { content: 'Done', toolCalls: [] } } })
  const binding = f.host.approvalEnrollmentBinding
  f.host.setWebConfiguration({ provider: 'direct' }); assert.equal(f.host.approvalMode, 'manual'); assert.notEqual(f.host.approvalEnrollmentBinding, binding)
  await f.host.send('Hello'); assert.equal(f.sends.length, 0)
  f.host.setWebConfiguration({ provider: 'disabled' }); await f.host.send('Hello')
})
test('paid web has explicit outcome inventory and cannot be claimed by imported extensions', async () => {
  const pack = createDeepSeekWebExtension(async () => ({ content: '{}' }))
  assert.throws(() => createBuiltinToolset(false, [pack]), /reserved|collision/)
  const set = createBuiltinToolset(false, [], undefined, undefined, undefined, undefined, undefined, pack)
  try { for (const name of ['fetch_url', 'web_search']) { assert.equal(set.outcomePolicies.get(name), 'public-url'); assert.equal(BUILTIN_TOOL_OUTCOME_POLICIES[name], 'public-url') } }
  finally { await set.dispose() }
})
test('paid web consent differs from unchanged direct consent and retained row recovery never replays', () => {
  assert.notDeepEqual(autoReviewSharingScope('openai'), autoReviewSharingScope('openai', true))
  assert.match(autoReviewPolicy('openai', true).checks.map(row => row.instructions).join(' '), /paid DeepSeek/)
  assert.match(DEEPSEEK_WEB_DISCLOSURE, /0\.00075/)
  const row = { webProvider: 'deepseek', state: 'intent' }
  assert.equal(JSON.parse(publicUrlOutcomeResult(row).content).unknownOutcome, true)
  assert.deepEqual(cliPublicUrlRecordOutcome(row), { status: 'unknown', effect: 'unknown' })
})

for (const cause of ['failure', 'private', 'cancel']) test(`DNS ${cause} preserves possible network disclosure without API billing`, async t => {
  let resolves = 0
  const f = await fixture(t, { operation: 'fetch', auto: true, ...(cause === 'private' ? { addresses: ['127.0.0.1'] } : {}), onResolve({ host }) {
    resolves++; if (cause === 'failure') throw new Error('DNS failed'); if (cause === 'cancel') host.cancel()
  } })
  const value = body(await f.host.send(`Read ${url}`))
  assert.equal(resolves, 1); assert.equal(f.sends.length, 0)
  assert.equal(value.requestState, 'not_started'); assert.equal(value.billing, 'not_attempted'); assert.equal(value.networkActivity, 'possible')
  const row = f.outcomes.flat().findLast(row => row.state === 'settled')
  assert.equal(JSON.parse(row.result.content).networkActivity, 'possible')
  assert.equal(cliPublicUrlRecordOutcome(row).effect, 'unknown')
})
test('denial before DNS proves no network attempt; recovered accepted rows remain conservative', async t => {
  let resolves = 0
  const f = await fixture(t, { operation: 'fetch', onResolve() { resolves++ } })
  const value = body(await f.host.send(`Read ${url}`))
  assert.equal(resolves, 0); assert.equal(value.networkActivity, 'not_attempted'); assert.equal(value.requestState, 'not_started')
  const accepted = publicUrlOutcomeResult({ webProvider: 'deepseek', state: 'accepted' })
  assert.equal(JSON.parse(accepted.content).networkActivity, 'possible'); assert.equal(JSON.parse(accepted.content).billing, 'not_attempted')
})

for (const operation of ['search', 'fetch']) test(`final ${operation} dispatch rechecks reviewer account across asynchronous-hook microtasks`, async t => {
  let fenced = 0
  for (let depth = 0; depth <= 7; depth++) {
    let queued = false
    const observed = []
    const later = (remaining, effect) => remaining === 0 ? effect() : queueMicrotask(() => later(remaining - 1, effect))
    const f = await fixture(t, { operation, auto: true, afterSave({ account, rows }) {
      if (!queued && rows.some(row => row.state === 'intent')) { queued = true; later(depth, () => { account.value = 'account-two' }) }
    }, onFetch({ account }) { observed.push(account.value) } })
    const value = body(await f.host.send(operation === 'search' ? `Search ${query}` : `Read ${url}`))
    assert(observed.every(value => value === 'account-one'), `A stale reviewer account dispatched at microtask depth ${depth}`)
    if (f.sends.length === 0) { fenced++; assert.equal(value.requestState, 'not_started'); assert.equal(value.billing, 'not_attempted') }
  }
  assert(fenced >= 4)
})
test('actual transport invocation remains uncertain on a synchronous transport failure', async t => {
  const f = await fixture(t, { auto: true, transportFailure: true })
  const value = body(await f.host.send(`Search ${query}`))
  assert.equal(f.sends.length, 1); assert.equal(value.requestState, 'unknown'); assert.equal(value.billing, 'unknown')
})
for (const change of ['web-revision', 'known-secret']) test(`final dispatch also fences ${change} changes in the hook-to-fetch gap`, async t => {
  let fenced = 0
  for (let depth = 0; depth <= 7; depth++) {
    let queued = false, changed = false
    const observed = []
    const later = (remaining, effect) => remaining === 0 ? effect() : queueMicrotask(() => later(remaining - 1, effect))
    const f = await fixture(t, { auto: true, afterSave({ options, secrets, rows }) {
      if (!queued && rows.some(row => row.state === 'intent')) { queued = true; later(depth, () => {
        changed = true
        if (change === 'web-revision') options.web.revision = 'changed-web-revision'
        else secrets.push(query)
      }) }
    }, onFetch() { observed.push(changed) } })
    const value = body(await f.host.send(`Search ${query}`))
    assert(observed.every(changed => !changed), `Stale ${change} dispatched at microtask depth ${depth}`)
    if (f.sends.length === 0) { fenced++; assert.equal(value.requestState, 'not_started'); assert.equal(value.billing, 'not_attempted') }
  }
  assert(fenced >= 4)
})
