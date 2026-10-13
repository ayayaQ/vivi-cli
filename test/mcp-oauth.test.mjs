// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { request } from 'node:http'
import { test } from 'node:test'
import { McpOAuthCallback } from '../dist/mcp-oauth-callback.js'
import { McpOAuthSession } from '../dist/mcp-oauth-session.js'

const endpoint = 'https://mcp.fixture.invalid/mcp', issuer = 'https://auth.fixture.invalid'
const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
  response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const json = (value, status = 200) => Response.json(value, { status })
const codeError = code => error => error.code === code && !/fixture-secret/.test(error.message)
const callbackUrl = url => {
  const callback = new URL(url.searchParams.get('redirect_uri'))
  callback.searchParams.set('state', url.searchParams.get('state'))
  callback.searchParams.set('code', 'fixture-secret-code')
  callback.searchParams.set('iss', issuer)
  return callback
}
function fixture(options = {}) {
  const calls = [], secrets = [], browserUrls = []
  let current = true, now = 1000
  const fetchFn = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET'
    calls.push({ url: url.href, method, body: init?.body, signal: init?.signal })
    if (options.fetchFn) { const result = await options.fetchFn(url, init); if (result) return result }
    if (url.origin === new URL(endpoint).origin && url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return json(options.resource ?? { resource: endpoint, authorization_servers: [issuer] })
    if (url.origin === issuer && url.pathname.includes('/.well-known/')) return json({ ...metadata, ...options.metadata })
    if (url.href === metadata.token_endpoint && method === 'POST') return json(options.tokens ?? { access_token: 'fixture-secret-token',
      refresh_token: 'fixture-secret-refresh', token_type: 'Bearer', expires_in: 60 })
    return json({}, 404)
  }
  const session = new McpOAuthSession({ endpoint, configRevision: 'fixture-revision',
    client: options.client === null ? undefined : { id: 'fixture-public-client', issuer, redirectPort: 0, ...options.client }, scopes: ['read'],
    fetchFn, registerSecrets: values => secrets.push(...values), configurationIsCurrent: () => current,
    now: () => now, timeoutMs: options.timeoutMs ?? 5000,
    openBrowser: async (url, signal) => { browserUrls.push(url); if (options.openBrowser) return options.openBrowser(url, signal)
      const response = await fetch(callbackUrl(url)); assert.equal(response.status, 200); assert.equal(await response.text(), 'MCP sign-in received. You can return to vivi.') }
  })
  return { session, calls, secrets, browserUrls, stale: () => { current = false }, tick: value => { now += value } }
}

async function callbackFixture(t, extra = {}) {
  const abort = new AbortController(), secrets = []
  const callback = await McpOAuthCallback.listen({ state: 'fixture-secret-state', issuer, requireIssuer: true, port: 0,
    signal: abort.signal, isActive: () => true, registerSecrets: values => secrets.push(...values), ...extra })
  t.after(() => callback.close())
  const valid = new URL(callback.redirectUrl)
  valid.search = new URLSearchParams({ state: 'fixture-secret-state', code: 'fixture-secret-code', iss: issuer }).toString()
  return { callback, valid, abort, secrets }
}
async function portAvailable(url) {
  const server = createServer()
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(url.port), '127.0.0.1', resolve) }) }
  finally { await new Promise(resolve => server.close(resolve)) }
}

test('explicit preregistered sign-in uses SDK S256/resource/scope and a real owned callback', async t => {
  const { session, calls, secrets, browserUrls } = fixture(); t.after(() => session.disconnect())
  assert.deepEqual(Object.keys(session.bearerProvider()), ['token'])
  const before = session.authorizationSnapshot().revision
  const plan = await session.prepareSignIn()
  assert.equal(session.status().state, 'prepared'); assert.equal(browserUrls.length, 0)
  assert.equal(plan.registration, 'pre-registered-public-client'); assert.deepEqual(plan.scopes, ['read'])
  assert(Object.isFrozen(plan)); assert(Object.isFrozen(plan.scopes))
  await session.beginSignIn(plan)
  const url = browserUrls[0], body = new URLSearchParams(calls.find(call => call.method === 'POST').body)
  assert.equal(url.searchParams.get('resource'), endpoint); assert.equal(body.get('resource'), endpoint)
  assert.equal(url.searchParams.get('scope'), 'read'); assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('grant_type'), null); assert.equal(body.get('grant_type'), 'authorization_code')
  assert.equal(body.get('client_id'), 'fixture-public-client'); assert.equal(body.get('client_secret'), null)
  assert.equal(body.get('code'), 'fixture-secret-code')
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'))
  assert.equal(secrets.includes(url.searchParams.get('state')), true); assert.equal(secrets.includes(body.get('code_verifier')), true)
  for (const secret of ['fixture-secret-code', 'fixture-secret-token', 'fixture-secret-refresh']) assert(secrets.includes(secret))
  assert.equal(session.status().state, 'connected'); assert.notEqual(session.authorizationSnapshot().revision, before)
  assert.equal(await session.bearerProvider().token(), 'fixture-secret-token')
  assert(!JSON.stringify([plan, session.status()]).includes('fixture-secret'))
  assert(!calls.some(call => /register/.test(call.url))); assert.equal(calls.filter(call => call.method === 'POST').length, 1)
  await portAvailable(new URL(url.searchParams.get('redirect_uri')))
  const oldProvider = session.bearerProvider(), oldRevision = session.authorizationSnapshot().revision
  await session.disconnect(); assert.equal(await oldProvider.token(), undefined); assert.notEqual(session.authorizationSnapshot().revision, oldRevision)
})

test('callback rejects malformed paths, state, issuer, duplicate params and request methods before exchange', async t => {
  const { callback, valid, secrets } = await callbackFixture(t)
  const variants = [url => url.searchParams.delete('state'), url => url.searchParams.set('state', 'wrong'),
    url => url.searchParams.delete('iss'), url => url.searchParams.set('iss', 'https://wrong.invalid'),
    url => url.searchParams.append('state', 'fixture-secret-state'), url => url.searchParams.append('code', 'other'),
    url => url.searchParams.append('iss', issuer), url => { url.pathname += '/other' },
    url => url.searchParams.set('code', 'unsafe\ncode'), url => url.searchParams.set('error', 'access_denied')]
  for (const change of variants) {
    const url = new URL(valid); change(url)
    const response = await fetch(url); assert.equal(response.status, 400); assert(!/fixture-secret|wrong.invalid/.test(await response.text()))
  }
  assert.equal((await fetch(valid, { method: 'POST' })).status, 400)
  assert.equal(await new Promise((resolve, reject) => {
    const call = request(valid, { headers: { Host: 'other.invalid' } }, response => { response.resume(); resolve(response.statusCode) })
    call.once('error', reject); call.end()
  }), 400)
  assert.equal(secrets.length, 0)
  assert.equal((await fetch(valid)).status, 200); assert.equal((await callback.result).code, 'fixture-secret-code')
  assert.equal((await fetch(valid)).status, 400); assert.deepEqual(secrets, ['fixture-secret-code'])
  await callback.close(); await portAvailable(valid)
})

test('error callbacks validate issuer/state and expose only fixed safe errors', async t => {
  const { callback, valid } = await callbackFixture(t)
  valid.searchParams.delete('code'); valid.searchParams.set('error', 'access_denied'); valid.searchParams.set('error_description', 'fixture-secret-description')
  valid.searchParams.set('iss', 'https://wrong.invalid')
  assert.equal((await fetch(valid)).status, 400)
  valid.searchParams.set('iss', issuer); assert.equal((await fetch(valid)).status, 200)
  await assert.rejects(callback.result, codeError('authorization-denied'))
})

test('optional iss may be omitted only when metadata does not require it', async t => {
  const { callback, valid } = await callbackFixture(t, { requireIssuer: false })
  valid.searchParams.delete('iss'); assert.equal((await fetch(valid)).status, 200); assert.equal((await callback.result).iss, undefined)
})

test('preregistration, validated issuer, secure endpoints, public client and S256 are required before browser opening', async t => {
  const variants = [ { client: null }, { metadata: { issuer: 'https://wrong.invalid' } },
    { metadata: { authorization_endpoint: 'http://auth.fixture.invalid/authorize' } }, { metadata: { token_endpoint: 'http://auth.fixture.invalid/token' } },
    { metadata: { code_challenge_methods_supported: ['plain'] } }, { metadata: { code_challenge_methods_supported: undefined } },
    { metadata: { token_endpoint_auth_methods_supported: ['client_secret_basic'] } }, { resource: { resource: 'https://other.invalid', authorization_servers: [issuer] } },
    { resource: { resource: endpoint, authorization_servers: ['https://wrong.invalid'] } } ]
  for (const options of variants) {
    const { session, calls, browserUrls } = fixture(options); t.after(() => session.disconnect())
    await assert.rejects(session.prepareSignIn(), codeError(options.client === null ? 'client-registration-required' : 'authorization-failed'))
    assert.equal(browserUrls.length, 0); assert.equal(calls.filter(call => call.method === 'POST').length, 0)
  }
  for (const endpoint of ['http://mcp.invalid', 'https://user:secret@mcp.invalid', 'https://mcp.invalid?token=secret', 'https://mcp.invalid/#fragment'])
    assert.throws(() => new McpOAuthSession({ endpoint }), codeError('authorization-failed'))
})

test('copied/stale plans and configuration changes invalidate sign-in and tokens', async t => {
  const value = fixture(); t.after(() => value.session.disconnect())
  const first = await value.session.prepareSignIn()
  await assert.rejects(value.session.beginSignIn({ ...first }), codeError('invalid-plan'))
  const second = await value.session.prepareSignIn()
  await assert.rejects(value.session.beginSignIn(first), codeError('invalid-plan'))
  value.stale(); await assert.rejects(value.session.beginSignIn(second), codeError('invalid-plan'))
  assert.equal(value.session.authorizationSnapshot().bearerToken, undefined); assert.equal(value.browserUrls.length, 0)
})

test('expired session token advances auth epoch and requires explicit sign-in, without refresh', async t => {
  const value = fixture(); t.after(() => value.session.disconnect())
  await value.session.beginSignIn(await value.session.prepareSignIn())
  const provider = value.session.bearerProvider(), before = value.session.authorizationSnapshot().revision
  value.tick(60_000)
  assert.equal(value.session.authorizationSnapshot().bearerToken, undefined); assert.notEqual(value.session.authorizationSnapshot().revision, before)
  assert.equal(value.session.status().state, 'needs-sign-in'); assert.equal(await provider.token(), undefined)
  assert.equal(value.calls.filter(call => call.method === 'POST').length, 1)
})

test('cancel during discovery aborts fetch and stale completion cannot install a plan', async t => {
  const started = deferred(), release = deferred()
  const value = fixture({ fetchFn: async (_url, init) => { started.resolve(init.signal); await release.promise; return json({}) } })
  t.after(() => value.session.disconnect())
  const preparation = value.session.prepareSignIn(); const signal = await started.promise
  await value.session.cancelSignIn(); assert(signal.aborted)
  await assert.rejects(preparation, codeError('cancelled')); release.resolve()
  assert.equal(value.session.status().state, 'cancelled'); assert.equal(value.session.authorizationSnapshot().bearerToken, undefined)
})

test('cancel/disconnect during token exchange reject stale tokens and close callback port', async t => {
  for (const action of ['cancelSignIn', 'disconnect']) {
    const started = deferred(), release = deferred()
    const value = fixture({ fetchFn: async (url, init) => { if (url.href === metadata.token_endpoint) { started.resolve(init.signal); await release.promise; return json({ access_token: 'fixture-secret-late', token_type: 'Bearer' }) } } })
    t.after(() => value.session.disconnect())
    const signing = value.session.beginSignIn(await value.session.prepareSignIn()), signal = await started.promise
    await value.session[action](); assert(signal.aborted); await assert.rejects(signing, codeError('cancelled'))
    release.resolve(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(value.session.authorizationSnapshot().bearerToken, undefined)
    await portAvailable(new URL(value.browserUrls[0].searchParams.get('redirect_uri')))
  }
})

test('browser failure, callback timeout, external abort and token failures leave no credential or listener', async t => {
  for (const options of [ { openBrowser: async () => { throw new Error('fixture-secret-browser') } },
    { openBrowser: async () => {}, timeoutMs: 30 }, { tokens: { access_token: 'fixture-secret-token', token_type: 'DPoP' } },
    { fetchFn: async url => url.href === metadata.token_endpoint ? json({ error: 'invalid_grant', error_description: 'fixture-secret-server' }, 400) : undefined } ]) {
    const value = fixture(options); t.after(() => value.session.disconnect())
    await assert.rejects(value.session.beginSignIn(await value.session.prepareSignIn()), codeError(options.timeoutMs ? 'timeout' : 'authorization-failed'))
    assert.equal(value.session.authorizationSnapshot().bearerToken, undefined)
    if (value.browserUrls[0]) await portAvailable(new URL(value.browserUrls[0].searchParams.get('redirect_uri')))
    assert(value.calls.filter(call => call.method === 'POST').length <= 1)
  }
  const opened = deferred(), value = fixture({ openBrowser: async url => { opened.resolve(url); await new Promise(() => {}) } })
  t.after(() => value.session.disconnect())
  const abort = new AbortController(), signing = value.session.beginSignIn(await value.session.prepareSignIn(), abort.signal), url = await opened.promise
  abort.abort(); await assert.rejects(signing, codeError('cancelled')); await portAvailable(new URL(url.searchParams.get('redirect_uri')))
})

test('callback port conflict and abort release all owned listeners', async t => {
  const blocker = createServer(); await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => blocker.close(resolve)))
  const abort = new AbortController()
  await assert.rejects(McpOAuthCallback.listen({ state: 'state', issuer, requireIssuer: true, port: blocker.address().port,
    signal: abort.signal, isActive: () => true, registerSecrets: () => {} }), codeError('callback-unavailable'))
  const { callback, valid, abort: cancel } = await callbackFixture(t)
  cancel.abort(); await assert.rejects(callback.result, codeError('cancelled')); await callback.close(); await portAvailable(valid)
})

test('metadata/token response bytes and redirects are bounded and errors never echo provider text', async t => {
  for (const fetchFn of [ async () => new Response('fixture-secret-' + 'x'.repeat(70_000)),
    async () => new Response(null, { status: 302, headers: { Location: 'https://wrong.invalid/fixture-secret' } }) ]) {
    const value = fixture({ fetchFn }); t.after(() => value.session.disconnect())
    await assert.rejects(value.session.prepareSignIn(), codeError('authorization-failed'))
    assert.equal(value.browserUrls.length, 0); assert(value.calls.every(call => !/wrong.invalid/.test(call.url)))
  }
})


test('one prepared plan permits only one concurrent beginSignIn', async t => {
  const opened = deferred(), resume = deferred()
  const value = fixture({ openBrowser: async url => { opened.resolve(url); await resume.promise; await fetch(callbackUrl(url)) } })
  t.after(() => value.session.disconnect())
  const plan = await value.session.prepareSignIn(), first = value.session.beginSignIn(plan)
  await assert.rejects(value.session.beginSignIn(plan), codeError('invalid-plan'))
  await opened.promise; assert.equal(value.browserUrls.length, 1)
  resume.resolve(); await first; assert.equal(value.session.status().state, 'connected')
  await portAvailable(new URL(value.browserUrls[0].searchParams.get('redirect_uri')))
})


test('valid token endpoint default ports and hostname case use canonical fetch identity', async t => {
  for (const token_endpoint of ['https://auth.fixture.invalid:443/token', 'https://AUTH.fixture.invalid/token']) {
    const value = fixture({ metadata: { token_endpoint } }); t.after(() => value.session.disconnect())
    await value.session.beginSignIn(await value.session.prepareSignIn())
    assert.equal(value.session.status().state, 'connected')
    assert.equal(value.calls.filter(call => call.method === 'POST').length, 1)
  }
})


test('malformed raw callback URL is rejected without crashing the owned server', async t => {
  const { callback, valid } = await callbackFixture(t)
  for (const path of ['/\\', '/%ZZ', '//other.invalid/path']) {
    const status = await new Promise((resolve, reject) => {
      const call = request({ hostname: valid.hostname, port: valid.port, path, headers: { Host: valid.host } }, response => { response.resume(); resolve(response.statusCode) })
      call.once('error', reject); call.end()
    })
    assert.equal(status, 400)
  }
  assert.equal((await fetch(valid)).status, 200); assert.equal((await callback.result).code, 'fixture-secret-code')
})


test('preregistered exact redirect path is bound through browser callback and code exchange', async t => {
  const redirectPath = '/registered/vivi-callback'
  const value = fixture({ client: { redirectPath }, fetchFn: async (url, init) => {
    if (url.href === metadata.token_endpoint) {
      const body = new URLSearchParams(init.body)
      assert.equal(new URL(body.get('redirect_uri')).pathname, redirectPath)
    }
  } }); t.after(() => value.session.disconnect())
  for (let i = 0; i < 2; i++) {
    await value.session.beginSignIn(await value.session.prepareSignIn())
    assert.equal(new URL(value.browserUrls[i].searchParams.get('redirect_uri')).pathname, redirectPath)
    assert.equal(value.session.status().state, 'connected')
  }
  assert.notEqual(value.browserUrls[0].searchParams.get('state'), value.browserUrls[1].searchParams.get('state'))
  for (const redirectPath of ['//other.invalid/path', '/path?query', '/path#fragment', '/a/../callback', '/%2e%2e/callback', '/a\\b', '/a//b'])
    assert.throws(() => fixture({ client: { redirectPath } }), codeError('authorization-failed'))
})

test('immediate listener startup cancellation releases the configured port', async () => {
  const temporary = createServer(); await new Promise(resolve => temporary.listen(0, '127.0.0.1', resolve))
  const port = temporary.address().port; await new Promise(resolve => temporary.close(resolve))
  for (let i = 0; i < 10; i++) {
    const abort = new AbortController()
    const listening = McpOAuthCallback.listen({ state: 'fixture-secret-state', issuer, requireIssuer: true, port,
      signal: abort.signal, isActive: () => true, registerSecrets: () => {} })
    abort.abort(); await assert.rejects(listening, codeError('cancelled'))
    await portAvailable(new URL(`http://127.0.0.1:${port}/`))
  }
})

test('configuration changes during exchange prevent a late token commit without explicit disconnect', async t => {
  const started = deferred(), release = deferred()
  const value = fixture({ fetchFn: async url => { if (url.href === metadata.token_endpoint) {
    started.resolve(); await release.promise; return json({ access_token: 'fixture-secret-late', token_type: 'Bearer' })
  } } }); t.after(() => value.session.disconnect())
  const signing = value.session.beginSignIn(await value.session.prepareSignIn())
  await started.promise; value.stale(); release.resolve()
  await assert.rejects(signing, codeError('cancelled'))
  assert.equal(value.session.authorizationSnapshot().bearerToken, undefined)
  await portAvailable(new URL(value.browserUrls[0].searchParams.get('redirect_uri')))
})
