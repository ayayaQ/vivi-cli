// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { McpOAuthRegistration } from '../dist/mcp-oauth-registration.js'
import { createMcpOAuthFetch } from '../dist/mcp-oauth-network.js'
import { McpOAuthError, mcpOAuthRegistrationFailureMessage } from '../dist/mcp-oauth-callback.js'
import { createMcpOAuthNativeFetch } from '../dist/mcp-oauth-native.js'

const endpoint = 'https://mcp.fixture.invalid/mcp', issuer = 'https://auth.fixture.invalid'
const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] }
const settings = { issuer, redirectPort: 41873, redirectPath: '/oauth/callback', scopes: ['read'], clientName: 'vivi fixture' }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const safeError = code => error => error.code === code && !/fixture-secret|provider-error/.test(error.message)
function fixture(options = {}) {
  const calls = [], secrets = []
  let current = true
  const registration = new McpOAuthRegistration({ endpoint, configRevision: 'fixture-config', ...settings, ...options.settings,
    timeoutMs: options.timeoutMs ?? 3000, registerSecrets: values => secrets.push(...values), configurationIsCurrent: () => current,
    fetchFn: async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? 'GET'
      calls.push({ url: url.href, method, body: init?.body, signal: init?.signal, redirect: init?.redirect })
      const injected = await options.fetchFn?.(url, init); if (injected) return injected
      if (url.origin === new URL(endpoint).origin && url.pathname.startsWith('/.well-known/oauth-protected-resource'))
        return Response.json(options.resource ?? { resource: endpoint, authorization_servers: [issuer], bearer_methods_supported: ['header'] })
      if (url.origin === issuer && url.pathname.includes('/.well-known/')) return Response.json({ ...metadata, ...options.metadata })
      if (method === 'POST') {
        const body = JSON.parse(init.body)
        return Response.json(options.response ? options.response(body) : { ...body, client_id: 'fixture-public-client' }, { status: 201 })
      }
      return Response.json({}, { status: 404 })
    } })
  return { registration, calls, secrets, stale: () => { current = false } }
}

test('SDK-real DCR is one explicit POST of exact public metadata and fixed preregistered callback', async t => {
  const { registration, calls, secrets } = fixture({ response: body => ({ ...body, client_id: 'fixture-public-client',
    registration_access_token: 'fixture-secret-management', registration_client_uri: `${issuer}/manage/client` }) })
  t.after(() => registration.cancelRegistration())
  const plan = await registration.prepareRegistration()
  assert.equal(calls.filter(call => call.method === 'POST').length, 0)
  assert.equal(plan.endpoint, endpoint); assert.equal(plan.issuer, issuer); assert.equal(plan.registrationEndpoint, metadata.registration_endpoint)
  assert.equal(plan.redirectUri, 'http://127.0.0.1:41873/oauth/callback')
  assert.deepEqual(plan.clientMetadata, { redirect_uris: [plan.redirectUri], application_type: 'native', client_name: 'vivi fixture',
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'], scope: 'read' })
  assert(Object.isFrozen(plan)); assert(Object.isFrozen(plan.clientMetadata)); assert(Object.isFrozen(plan.clientMetadata.redirect_uris))
  const client = await registration.beginRegistration(plan)
  assert.deepEqual(client, { id: 'fixture-public-client', issuer, redirectPort: settings.redirectPort,
    redirectPath: settings.redirectPath, scopes: ['read'] })
  assert.equal(calls.filter(call => call.method === 'POST').length, 1)
  assert(secrets.includes('fixture-secret-management')); assert.equal(registration.status().state, 'registered')
})

test('registration result retains public launch settings only and cannot reuse an approval', async t => {
  const { registration, calls, secrets } = fixture({ response: body => ({ ...body, client_id: 'fixture-public-client',
    registration_access_token: 'fixture-secret-management' }) }); t.after(() => registration.cancelRegistration())
  const plan = await registration.prepareRegistration(), client = await registration.beginRegistration(plan)
  assert.deepEqual(client, { id: 'fixture-public-client', issuer, redirectPort: settings.redirectPort,
    redirectPath: settings.redirectPath, scopes: ['read'] })
  assert(Object.isFrozen(client)); assert(Object.isFrozen(client.scopes)); assert.equal(secrets.includes('fixture-secret-management'), true)
  assert(!JSON.stringify([client, registration.status(), plan]).includes('fixture-secret'))
  const post = calls.filter(call => call.method === 'POST'); assert.equal(post.length, 1)
  assert.equal(post[0].url, metadata.registration_endpoint); assert.equal(post[0].redirect, 'manual')
  const body = JSON.parse(post[0].body)
  assert.equal(body.client_secret, undefined); assert(!body.grant_types.includes('refresh_token')); assert.equal(body.scope, 'read')
  assert(!calls.some(call => /\/token$|\/authorize$/.test(call.url)))
  await assert.rejects(registration.beginRegistration(plan), safeError('invalid-plan'))
  assert.equal(calls.filter(call => call.method === 'POST').length, 1)
})

test('empty requested scopes omit scope and do not invent provider grants', async t => {
  const { registration, calls } = fixture({ settings: { scopes: [] } }); t.after(() => registration.cancelRegistration())
  const plan = await registration.prepareRegistration(); assert.equal(Object.hasOwn(plan.clientMetadata, 'scope'), false)
  assert.deepEqual((await registration.beginRegistration(plan)).scopes, [])
  assert.equal(Object.hasOwn(JSON.parse(calls.find(call => call.method === 'POST').body), 'scope'), false)
})

test('discovery must advertise a safe registration endpoint and compatible issuer/resource/PKCE/public client', async t => {
  const variants = [ { metadata: { registration_endpoint: undefined } }, { metadata: { issuer: 'https://other.invalid' } },
    { metadata: { registration_endpoint: 'http://auth.fixture.invalid/register' } },
    { metadata: { registration_endpoint: `${issuer}/register?secret=fixture-secret` } },
    { metadata: { authorization_endpoint: 'http://auth.fixture.invalid/authorize' } },
    { metadata: { token_endpoint: 'http://auth.fixture.invalid/token' } }, { metadata: { code_challenge_methods_supported: ['plain'] } },
    { metadata: { response_types_supported: ['token'] } }, { metadata: { grant_types_supported: ['refresh_token'] } },
    { metadata: { token_endpoint_auth_methods_supported: ['client_secret_basic'] } },
    { resource: { resource: 'https://other.invalid/mcp', authorization_servers: [issuer] } },
    { resource: { resource: endpoint, authorization_servers: ['https://other.invalid'] } },
    { resource: { resource: endpoint, authorization_servers: [issuer], bearer_methods_supported: ['query'] } } ]
  for (const [index, options] of variants.entries()) await t.test(`invalid discovery ${index}`, async () => {
    const { registration, calls } = fixture(options)
    await assert.rejects(registration.prepareRegistration(), safeError('client-registration-failed'))
    assert.equal(calls.filter(call => call.method === 'POST').length, 0)
    await registration.cancelRegistration()
  })
})

test('returned registration is rejected unless exact native public metadata is preserved', async t => {
  const variants = [ { client_id: '' }, { client_id: 'x'.repeat(1025) }, { client_id: 'bad\nclient' },
    { client_secret: 'fixture-secret-client' }, { client_secret: '' }, { token_endpoint_auth_method: 'client_secret_basic' },
    { token_endpoint_auth_method: undefined },
    { redirect_uris: undefined }, { redirect_uris: ['http://127.0.0.1:41873/wrong'] }, { redirect_uris: [ 'http://127.0.0.1:41873/oauth/callback', 'https://other.invalid' ] },
    { grant_types: ['authorization_code', 'refresh_token'] }, { response_types: ['token'] }, { application_type: 'web' },
    { client_name: 42 },
    { scope: undefined }, { scope: 'read write' }, { scope: 'write' }, { issuer: 'https://wrong.invalid' } ]
  for (const [index, change] of variants.entries()) await t.test(`invalid response ${index}`, async () => {
    const { registration, calls, secrets } = fixture({ response: body => ({ ...body, client_id: 'fixture-public-client', ...change }) })
    const plan = await registration.prepareRegistration()
    await assert.rejects(registration.beginRegistration(plan), safeError('client-registration-uncertain'))
    assert.equal(registration.status().state, 'failed'); assert.equal(calls.filter(call => call.method === 'POST').length, 1)
    if (change.client_secret) assert(secrets.includes(change.client_secret))
    await assert.rejects(registration.beginRegistration(plan), safeError('invalid-plan'))
  })
})

test('optional application type and negotiated display name do not block public registration', async t => {
  for (const change of [{ application_type: undefined }, { client_name: undefined }, { client_name: 'Issuer-approved display name' },
    { application_type: undefined, client_name: undefined }]) await t.test(JSON.stringify(change), async () => {
    const { registration, calls } = fixture({ response: body => ({ ...body, client_id: 'fixture-public-client', ...change }) })
    const plan = await registration.prepareRegistration(), client = await registration.beginRegistration(plan)
    assert.equal(client.id, 'fixture-public-client'); assert.equal(client.client_name, undefined)
    const posts = calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 1)
    const requested = JSON.parse(posts[0].body)
    assert.equal(requested.application_type, 'native'); assert.equal(requested.client_name, settings.clientName)
    await assert.rejects(registration.beginRegistration(plan), safeError('invalid-plan'))
  })
})

test('fixed HTTP diagnostics retain status without issuer bodies and consume approval once', async t => {
  for (const status of [400, 403, 429, 500]) for (const json of [true, false]) await t.test(`${status} json=${json}`, async () => {
    const { registration, calls, secrets } = fixture({ fetchFn: (_url, init) => init?.method === 'POST'
      ? json ? Response.json({ error: 'invalid_client_metadata', error_description: 'provider-error fixture-secret-error',
        client_secret: 'fixture-secret-error' }, { status }) : new Response('provider-error fixture-secret-error', { status }) : undefined })
    const plan = await registration.prepareRegistration()
    await assert.rejects(registration.beginRegistration(plan), error => {
      assert.equal(error.code, 'client-registration-uncertain')
      assert.deepEqual(error.registrationDiagnostic, { kind: 'http-rejected', status })
      const message = mcpOAuthRegistrationFailureMessage('fixture', error)
      assert.match(message, new RegExp(`HTTP ${status}`)); assert.match(message, /Browser sign-in did not start/)
      assert.match(message, /will not automatically register again/)
      assert(!/provider-error|fixture-secret/.test(message + JSON.stringify(error))); return true
    })
    if (json) assert(secrets.includes('fixture-secret-error'))
    assert.equal(calls.filter(call => call.method === 'POST').length, 1)
    await assert.rejects(registration.beginRegistration(plan), safeError('invalid-plan'))
  })
})

test('incompatible successful registration identifies fixed field names without values', async () => {
  const { registration, calls } = fixture({ response: body => ({ ...body, client_id: 'fixture-public-client',
    redirect_uris: ['https://provider-error.fixture-secret.invalid/callback'], token_endpoint_auth_method: 'client_secret_basic' }) })
  const plan = await registration.prepareRegistration()
  await assert.rejects(registration.beginRegistration(plan), error => {
    assert.equal(error.code, 'client-registration-uncertain')
    assert.deepEqual(error.registrationDiagnostic, { kind: 'response-mismatch', fields: ['token_endpoint_auth_method', 'redirect_uris'] })
    const message = mcpOAuthRegistrationFailureMessage('fixture', error)
    assert.match(message, /token_endpoint_auth_method, redirect_uris/)
    assert.match(message, /A client may have been created/); assert(!/provider-error|fixture-secret/.test(message + JSON.stringify(error)))
    return true
  })
  assert.equal(calls.filter(call => call.method === 'POST').length, 1)
})

test('malformed successful JSON reports invalid response without printing its body', async () => {
  const { registration } = fixture({ fetchFn: (_url, init) => init?.method === 'POST' ? new Response('{fixture-secret') : undefined })
  const plan = await registration.prepareRegistration()
  await assert.rejects(registration.beginRegistration(plan), error => {
    assert.deepEqual(error.registrationDiagnostic, { kind: 'invalid-response' })
    assert.match(mcpOAuthRegistrationFailureMessage('fixture', error), /invalid response/)
    assert(!JSON.stringify(error).includes('fixture-secret')); return true
  })
})

test('native DNS failures carry fixed phase evidence through registration without dispatch', async () => {
  let requests = 0
  const native = createMcpOAuthNativeFetch({ async resolvePublicUrlHost() { throw new Error('provider-error fixture-secret') },
    request() { requests++; throw new Error('unexpected dispatch') } })
  const { registration } = fixture({ fetchFn: (url, init) => init?.method === 'POST' ? native(url.href, init) : undefined })
  const plan = await registration.prepareRegistration()
  await assert.rejects(registration.beginRegistration(plan), error => {
    assert.equal(error.code, 'client-registration-uncertain')
    assert.deepEqual(error.registrationDiagnostic, { kind: 'transport-failure', phase: 'dns' })
    const message = mcpOAuthRegistrationFailureMessage('fixture', error)
    assert.match(message, /DNS lookup, before HTTP request transmission/)
    assert(!/provider-error|fixture-secret/.test(message + JSON.stringify(error))); return true
  })
  assert.equal(requests, 0)
})

test('safe formatter never copies unknown diagnostic field names', () => {
  const error = new McpOAuthError('client-registration-uncertain', { kind: 'response-mismatch', fields: ['fixture-secret', 'redirect_uris'] })
  const message = mcpOAuthRegistrationFailureMessage('fixture', error)
  assert.match(message, /redirect_uris/); assert(!message.includes('fixture-secret'))
})

test('native TLS setup failure remains pre-transmission through full registration diagnostics', async () => {
  let requests = 0
  const native = createMcpOAuthNativeFetch({ async resolvePublicUrlHost() { return ['8.8.8.8'] },
    request() { requests++; throw new Error('provider-error fixture-secret') } })
  const { registration } = fixture({ fetchFn: (url, init) => init?.method === 'POST' ? native(url.href, init) : undefined })
  const plan = await registration.prepareRegistration()
  await assert.rejects(registration.beginRegistration(plan), error => {
    assert.equal(error.code, 'client-registration-uncertain')
    assert.deepEqual(error.registrationDiagnostic, { kind: 'transport-failure', phase: 'tls' })
    const message = mcpOAuthRegistrationFailureMessage('fixture', error)
    assert.match(message, /TLS connection, before HTTP request transmission/)
    assert(!/provider-error|fixture-secret/.test(message + JSON.stringify(error))); return true
  })
  assert.equal(requests, 1)
})

test('plans are object-bound, epoch-bound and configuration-bound', async t => {
  const { registration, calls, stale } = fixture(); t.after(() => registration.cancelRegistration())
  const first = await registration.prepareRegistration()
  await assert.rejects(registration.beginRegistration({ ...first }), safeError('invalid-plan'))
  await registration.cancelRegistration(); await assert.rejects(registration.beginRegistration(first), safeError('invalid-plan'))
  const second = await registration.prepareRegistration(); stale()
  await assert.rejects(registration.beginRegistration(second), safeError('invalid-plan'))
  assert.equal(calls.filter(call => call.method === 'POST').length, 0)
})

test('concurrent preparation invalidates the older request before discovery', async () => {
  const { registration, calls } = fixture()
  const first = registration.prepareRegistration(), rejected = assert.rejects(first, safeError('invalid-plan'))
  const second = registration.prepareRegistration(); await rejected; await second
  assert.equal(calls.filter(call => call.method === 'POST').length, 0); await registration.cancelRegistration()
})

test('concurrent begin claims one approval and sends only once', async () => {
  const gate = deferred(), entered = deferred()
  const { registration, calls } = fixture({ fetchFn: async (_url, init) => {
    if (init?.method === 'POST') { entered.resolve(); await gate.promise }
  } })
  const plan = await registration.prepareRegistration(), begun = registration.beginRegistration(plan)
  await entered.promise; await assert.rejects(registration.beginRegistration(plan), safeError('invalid-plan'))
  gate.resolve(); await begun; assert.equal(calls.filter(call => call.method === 'POST').length, 1)
})

test('cancelled discovery ignores late results and sends nothing', async () => {
  const gate = deferred(), entered = deferred()
  const { registration, calls } = fixture({ fetchFn: async () => { entered.resolve(); await gate.promise } })
  const pending = registration.prepareRegistration(), rejected = assert.rejects(pending, safeError('client-registration-cancelled'))
  await entered.promise; const before = registration.status().revision; await registration.cancelRegistration(); await rejected
  assert.notEqual(registration.status().revision, before); gate.resolve(); await Promise.resolve()
  assert.equal(registration.status().state, 'cancelled'); assert.equal(calls.filter(call => call.method === 'POST').length, 0)
})

test('sent POST cancellation and changed config cannot commit a late client and warn about uncertain service outcome', async t => {
  for (const kind of ['cancel', 'signal', 'config']) await t.test(kind, async () => {
    const gate = deferred(), entered = deferred(), abort = new AbortController()
    const { registration, calls, stale } = fixture({ fetchFn: async (_url, init) => {
      if (init?.method === 'POST') { entered.resolve(); await gate.promise }
    } })
    const plan = await registration.prepareRegistration(), pending = registration.beginRegistration(plan, abort.signal)
    const rejected = assert.rejects(pending, safeError('client-registration-uncertain')); await entered.promise
    if (kind === 'cancel') await registration.cancelRegistration()
    if (kind === 'signal') abort.abort()
    if (kind === 'config') stale()
    gate.resolve(); await rejected
    assert.notEqual(registration.status().state, 'registered'); assert.equal(calls.filter(call => call.method === 'POST').length, 1)
  })
})

test('timeouts and aborted approval send no POST; sent timeout is uncertain', async t => {
  await t.test('discovery timeout', async () => {
    const { registration, calls } = fixture({ timeoutMs: 20, fetchFn: async () => new Promise(() => {}) })
    await assert.rejects(registration.prepareRegistration(), safeError('client-registration-cancelled'))
    assert.equal(calls.filter(call => call.method === 'POST').length, 0)
  })
  await t.test('signal already aborted', async () => {
    const { registration, calls } = fixture(), plan = await registration.prepareRegistration(), abort = new AbortController(); abort.abort()
    await assert.rejects(registration.beginRegistration(plan, abort.signal), safeError('client-registration-cancelled'))
    assert.equal(calls.filter(call => call.method === 'POST').length, 0)
  })
  await t.test('POST timeout', async () => {
    const { registration, calls } = fixture({ timeoutMs: 20, fetchFn: async (_url, init) => {
      if (init?.method === 'POST') return new Promise(() => {})
    } })
    const plan = await registration.prepareRegistration()
    await assert.rejects(registration.beginRegistration(plan), safeError('client-registration-uncertain'))
    assert.equal(calls.filter(call => call.method === 'POST').length, 1)
  })
})

test('redirects, oversized responses, malformed JSON and provider errors cannot cause POST retries or leak errors', async t => {
  const responses = [ () => new Response(null, { status: 307, headers: { Location: `${issuer}/register-again` } }),
    () => new Response(null, { status: 308, headers: { Location: 'https://other.invalid/register' } }),
    () => new Response('x'.repeat(65537)), () => new Response('{'),
    () => Response.json({ error: 'invalid_client_metadata', error_description: 'provider-error fixture-secret-error',
      client_secret: 'fixture-secret-error' }, { status: 400 }) ]
  for (const [index, response] of responses.entries()) await t.test(`response ${index}`, async () => {
    const { registration, calls, secrets } = fixture({ fetchFn: (_url, init) => init?.method === 'POST' ? response() : undefined })
    const plan = await registration.prepareRegistration()
    await assert.rejects(registration.beginRegistration(plan), safeError('client-registration-uncertain'))
    assert.equal(calls.filter(call => call.method === 'POST').length, 1)
    if (index === 4) assert(secrets.includes('fixture-secret-error'))
  })
})

test('fixed callback and bounded public settings are required before discovery', () => {
  for (const change of [{ redirectPort: 0 }, { redirectPort: 65536 }, { redirectPath: '//evil' }, { redirectPath: '/callback?code=x' },
    { redirectPath: '/%2e' }, { redirectPath: '/a/../b' }, { clientName: '' }, { clientName: '\nunsafe' },
    { clientName: 'x'.repeat(129) }, { scopes: ['read', 'read'] }, { scopes: ['bad scope'] }, { issuer: 'http://auth.invalid' }])
    assert.throws(() => fixture({ settings: change }))
})

test('OAuth network seam consumes one POST, rejects unapproved endpoints and respects Request abort', async () => {
  const calls = [], abort = new AbortController()
  const fetchFn = createMcpOAuthFetch({ fetchFn: async (input, init) => { calls.push([String(input), init]); return Response.json({}) },
    signal: abort.signal, origins: [issuer], assertCurrent: () => {}, postEndpoint: () => metadata.registration_endpoint, registerSecrets: () => {} })
  await assert.rejects(fetchFn(`${issuer}/token`, { method: 'POST' }), safeError('authorization-failed'))
  await assert.rejects(fetchFn('https://other.invalid'), safeError('authorization-failed'))
  const stopped = new AbortController(); stopped.abort()
  await assert.rejects(fetchFn(new Request(metadata.registration_endpoint, { method: 'POST', signal: stopped.signal })), safeError('cancelled'))
  await fetchFn(metadata.registration_endpoint, { method: 'POST' })
  await assert.rejects(fetchFn(metadata.registration_endpoint, { method: 'POST' }), safeError('authorization-failed'))
  assert.equal(calls.length, 1)
})
