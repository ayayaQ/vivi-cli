// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { McpOAuthSession } from '../dist/mcp-oauth-session.js'

const endpoint = 'https://mcp.fixture.invalid/mcp', issuer = 'https://auth.fixture.invalid'
const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] }
const saved = { accessToken: 'fixture-secret-access', refreshToken: 'fixture-secret-refresh', expiresAt: 61_000,
  issuer, resource: endpoint, clientId: 'fixture-public-client', scopes: ['read'] }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(options = {}) {
  const calls = [], secrets = [], stored = [], browsers = []
  let now = 1000, current = true, initial = options.initialCredentials ?? saved
  const session = new McpOAuthSession({ endpoint, configRevision: 'fixture-config', client: { id: saved.clientId, issuer, redirectPort: 0 }, scopes: options.scopes ?? ['read'],
    initialCredentials: initial, now: () => now, timeoutMs: options.timeoutMs ?? 2000, configurationIsCurrent: () => current,
    registerSecrets: values => secrets.push(...values), openBrowser: async url => browsers.push(url),
    ...(options.refreshCredentials === null ? {} : { refreshCredentials: async (perform, context) => { const result = options.refreshCredentials ? await options.refreshCredentials(perform, initial, context) : await perform(initial); stored.push(result); initial = result; return result } }),
    fetchFn: async (input, init) => {
      const url = new URL(String(input)); calls.push({ url: url.href, method: init?.method ?? 'GET', body: init?.body })
      if (options.fetchFn) { const result = await options.fetchFn(url, init); if (result) return result }
      if (url.origin === new URL(endpoint).origin) return Response.json({ resource: endpoint, authorization_servers: [issuer] })
      if (url.pathname.includes('/.well-known/')) return Response.json({ ...metadata, ...options.metadata })
      if (url.href === metadata.token_endpoint) return Response.json(options.tokens ?? { access_token: 'fixture-secret-new-access', refresh_token: 'fixture-secret-new-refresh', token_type: 'Bearer', expires_in: 120 })
      return Response.json({}, { status: 404 })
    }
  })
  return { session, calls, secrets, stored, browsers, tick: value => { now += value }, stale: () => { current = false } }
}
const safeError = code => error => error.code === code && !/fixture-secret|malicious-description/.test(error.message)

test('restore installs bound saved bearer without a browser or network, with no interactive transport recovery', async t => {
  const { session, calls, browsers, secrets } = fixture(); t.after(() => session.disconnect())
  assert.equal(session.authorizationSnapshot().bearerToken, saved.accessToken)
  assert.equal(session.status().state, 'connected'); assert.deepEqual(calls, []); assert.deepEqual(browsers, [])
  assert.deepEqual(Object.keys(session.bearerProvider()), ['token']); assert(secrets.includes(saved.refreshToken))
  assert(!JSON.stringify(session.status()).includes('fixture-secret'))
  for (const invalid of [{ ...saved, issuer: 'https://other.invalid' }, { ...saved, clientId: 'other' }, { ...saved, resource: endpoint + '/other' },
    { ...saved, scopes: ['write'] }, { ...saved, accessToken: 'malformed\nsecret' }])
    assert.throws(() => fixture({ initialCredentials: invalid }), safeError('authorization-failed'))
})

test('expiry refresh uses one SDK POST with resource and public client, persists rotation then advances epoch', async t => {
  const { session, tick, calls, stored, browsers, secrets } = fixture(); t.after(() => session.disconnect())
  const oldProvider = session.bearerProvider(), revision = session.status().revision
  tick(60_000); assert.equal(session.authorizationSnapshot().bearerToken, undefined)
  await session.refresh()
  assert.equal(session.authorizationSnapshot().bearerToken, 'fixture-secret-new-access')
  assert.notEqual(session.status().revision, revision); assert.equal(await oldProvider.token(), undefined)
  const posts = calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 1)
  const body = new URLSearchParams(posts[0].body)
  assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.get('refresh_token'), saved.refreshToken)
  assert.equal(body.get('client_id'), saved.clientId); assert.equal(body.get('resource'), endpoint); assert.equal(body.get('client_secret'), null)
  assert.equal(stored[0].refreshToken, 'fixture-secret-new-refresh'); assert.equal(stored[0].expiresAt, 181_000)
  assert(secrets.includes('fixture-secret-new-access')); assert(secrets.includes('fixture-secret-new-refresh')); assert.deepEqual(browsers, [])
  await session.refresh(); assert.equal(calls.filter(call => call.method === 'POST').length, 1)
})

test('unknown expiry does not fabricate expiration; refresh without a returned rotation preserves the saved token', async t => {
  const unknown = fixture({ initialCredentials: { ...saved, expiresAt: undefined } }); t.after(() => unknown.session.disconnect())
  await unknown.session.refresh(); assert.deepEqual(unknown.calls, [])
  const result = fixture({ tokens: { access_token: 'fixture-secret-new-access', token_type: 'Bearer', expires_in: 120 } }); t.after(() => result.session.disconnect())
  result.tick(60_000); await result.session.refresh(); assert.equal(result.stored[0].refreshToken, saved.refreshToken)
})

test('fresh scope expansion, invalid tokens and endpoint failure require sign-in without an MCP request or retry', async t => {
  for (const options of [{ scopes: ['read', 'write'], tokens: { access_token: 'fixture-secret-new-access', token_type: 'Bearer', scope: 'read write' } },
    { tokens: { access_token: 'fixture-secret-new-access', token_type: 'DPoP' } },
    { tokens: { access_token: 'fixture-secret-new-access', token_type: 'Bearer', expires_in: Infinity } },
    { fetchFn: async url => url.href === metadata.token_endpoint ? Response.json({ error: 'invalid_grant', error_description: 'malicious-description' }, { status: 400 }) : undefined }]) {
    const result = fixture(options); t.after(() => result.session.disconnect()); result.tick(60_000)
    await assert.rejects(result.session.refresh(), safeError('authorization-failed'))
    assert.equal(result.session.authorizationSnapshot().bearerToken, undefined); assert.equal(result.session.status().state, 'needs-sign-in')
    assert.equal(result.calls.filter(call => call.method === 'POST').length, 1); assert.equal(result.stored.length, 0)
    await assert.rejects(result.session.refresh(), safeError('authorization-failed'))
    assert.equal(result.calls.filter(call => call.method === 'POST').length, 1)
  }
})

test('legacy session-only restoration cannot refresh and operation denial does not start OAuth', async t => {
  const result = fixture({ refreshCredentials: null }); t.after(() => result.session.disconnect())
  result.tick(60_000); await assert.rejects(result.session.refresh(), safeError('authorization-failed')); assert.deepEqual(result.calls, [])
  const second = fixture(); t.after(() => second.session.disconnect())
  const provider = second.session.bearerProvider(); await second.session.requireSignIn()
  assert.equal(await provider.token(), undefined); assert.deepEqual(second.calls, []); assert.deepEqual(second.browsers, [])
})

test('disconnect or config change during refresh cannot install late tokens or persist a successful refresh', async t => {
  for (const cancel of ['disconnect', 'configuration']) {
    const gate = deferred(), entered = deferred()
    const result = fixture({ fetchFn: async url => { if (url.href === metadata.token_endpoint) { entered.resolve(); await gate.promise; return Response.json({ access_token: 'fixture-secret-late-access', token_type: 'Bearer', expires_in: 60 }) } } })
    t.after(() => result.session.disconnect()); result.tick(60_000)
    const refreshing = result.session.refresh(); const rejection = assert.rejects(refreshing, safeError('cancelled'))
    await entered.promise
    if (cancel === 'disconnect') await result.session.disconnect(); else result.stale()
    gate.resolve(); await rejection
    assert.equal(result.session.authorizationSnapshot().bearerToken, undefined); assert.equal(result.stored.length, 0)
    assert.equal(result.calls.filter(call => call.method === 'POST').length, 1)
  }
})

test('concurrent refresh is rejected and host persistence failure leaves no usable bearer', async t => {
  const gate = deferred(), entered = deferred()
  const result = fixture({ refreshCredentials: async (perform, initial) => { entered.resolve(); await gate.promise; const tokens = await perform(initial); throw Error(tokens.accessToken) } })
  t.after(() => result.session.disconnect()); result.tick(60_000)
  const running = result.session.refresh(), rejection = assert.rejects(running, safeError('authorization-failed'))
  await entered.promise; await assert.rejects(result.session.refresh(), safeError('cancelled'))
  gate.resolve(); await rejection
  assert.equal(result.session.authorizationSnapshot().bearerToken, undefined); assert.equal(result.stored.length, 0)
})

test('persistence hook receives cancellation/current context after refresh network succeeds', async t => {
  const gate = deferred(), entered = deferred()
  let persisted = false, context
  const result = fixture({ refreshCredentials: async (perform, initial, received) => {
    context = received; const updated = await perform(initial); entered.resolve(); await gate.promise
    assert.equal(context.signal.aborted, true); assert.equal(context.isCurrent(), false)
    if (!context.isCurrent()) throw Error('fixture-secret-persistence-cancelled')
    persisted = true; return updated
  } })
  t.after(() => result.session.disconnect()); result.tick(60_000)
  const running = result.session.refresh(), rejection = assert.rejects(running, safeError('cancelled'))
  await entered.promise; assert.equal(context.isCurrent(), true)
  await result.session.disconnect(); await rejection; gate.resolve()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(persisted, false); assert.equal(result.stored.length, 0)
  assert.equal(result.session.authorizationSnapshot().bearerToken, undefined)
})

test('cached discovery must bind restored credentials to the configured resource and issuer', () => {
  const base = { endpoint, configRevision: 'fixture-config', client: { id: saved.clientId, issuer, redirectPort: 0 }, scopes: ['read'],
    fetchFn: async () => { throw Error('unexpected fixture network') }, openBrowser: async () => { throw Error('unexpected browser') },
    registerSecrets: () => undefined, configurationIsCurrent: () => true }
  for (const discovery of [
    { authorizationServerUrl: issuer, authorizationServerMetadata: metadata, resourceMetadata: { resource: 'https://other.fixture.invalid/mcp', authorization_servers: [issuer] } },
    { authorizationServerUrl: 'https://other.fixture.invalid', authorizationServerMetadata: { ...metadata, issuer: 'https://other.fixture.invalid' }, resourceMetadata: { resource: endpoint, authorization_servers: ['https://other.fixture.invalid'] } }
  ]) assert.throws(() => new McpOAuthSession({ ...base, discovery, initialCredentials: { ...saved, resource: discovery.resourceMetadata.resource } }), safeError('authorization-failed'))
})
