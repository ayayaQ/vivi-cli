// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { discoverMcpOAuth, fetchMcpOAuthClientMetadata } from '../dist/mcp-oauth-discovery.js'
import { createMcpOAuthFetch, mcpOAuthRemoteUrl, validateMcpOAuthDiscovery } from '../dist/mcp-oauth-network.js'

const endpoint = 'https://mcp.discovery.fixture.invalid/public/mcp', origin = new URL(endpoint).origin
const issuer = 'https://auth.discovery.fixture.invalid'
const pathPrm = `${origin}/.well-known/oauth-protected-resource/public/mcp`, rootPrm = `${origin}/.well-known/oauth-protected-resource`
const asMetadata = `${issuer}/.well-known/oauth-authorization-server`
const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] }
const prm = { resource: endpoint, authorization_servers: [issuer], bearer_methods_supported: ['header'] }
const safeFailure = code => error => error.code === code && !/provider-secret|fixture.invalid/.test(error.message)
function fixture(overrides = {}) {
  const calls = []
  const fetchFn = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push({ url, method: init?.method ?? 'GET', init })
    assert.equal(init?.redirect, 'manual'); assert.equal(init?.credentials, 'omit')
    const custom = await overrides.fetchFn?.(url, init)
    if (custom) return custom
    if (url === endpoint) return new Response(null, { status: overrides.status ?? 405,
      ...(overrides.challenge ? { headers: { 'WWW-Authenticate': overrides.challenge } } : {}) })
    if (url === pathPrm) return Response.json(overrides.prm ?? prm)
    if (url === asMetadata) return Response.json({ ...metadata, ...overrides.metadata })
    return Response.json({}, { status: 404 })
  }
  return { calls, fetchFn, discover: options => discoverMcpOAuth(endpoint, { fetchFn, ...options }) }
}

test('URL-only discovery works without known issuer after an endpoint GET 405', async () => {
  const subject = fixture({ prm: { ...prm, scopes_supported: ['read', 'write'] } })
  const result = await subject.discover()
  assert.deepEqual(subject.calls.map(call => call.url), [endpoint, pathPrm, asMetadata])
  assert.equal(result.issuer, issuer); assert.equal(result.resource, endpoint)
  assert.equal(result.info.resourceMetadataUrl, pathPrm); assert.deepEqual(result.scopes, ['read', 'write'])
  for (const value of [result, result.info, result.info.resourceMetadata, result.info.resourceMetadata.authorization_servers,
    result.info.authorizationServerMetadata, result.info.authorizationServerMetadata.response_types_supported, result.scopes]) assert(Object.isFrozen(value))
  assert(subject.calls.every(call => call.method === 'GET'))
  assert(!subject.calls.some(call => /\/(?:authorize|register|token)$/.test(call.url)))
})

test('Bearer resource_metadata wins across origins and challenge scopes win over PRM and AS scopes', async () => {
  const challenged = 'https://metadata.discovery.fixture.invalid/custom/resource'
  const subject = fixture({ status: 401, challenge: `Basic realm="team, tools", bEaReR resource_metadata="${challenged}", scope="write read write"`,
    metadata: { scopes_supported: ['admin'] }, fetchFn: url => url === challenged
      ? Response.json({ ...prm, scopes_supported: ['admin'] }) : undefined })
  const result = await subject.discover()
  assert.deepEqual(result.scopes, ['write', 'read'])
  assert.equal(result.info.resourceMetadataUrl, challenged)
  assert.deepEqual(subject.calls.map(call => call.url), [endpoint, challenged, asMetadata])
})

test('an explicit empty Bearer scope stays empty; scopes are never guessed from AS metadata', async () => {
  const empty = fixture({ status: 401, challenge: 'Bearer scope=""', prm: { ...prm, scopes_supported: ['read'] } })
  assert.deepEqual((await empty.discover()).scopes, [])
  assert.deepEqual((await fixture({ metadata: { scopes_supported: ['read', 'openid', 'offline_access'] } }).discover()).scopes, [])
})

test('non-Bearer resource_metadata is ignored and cannot select another URL', async () => {
  const subject = fixture({ status: 401, challenge: 'Basic resource_metadata="https://other.discovery.fixture.invalid/meta"' })
  await subject.discover()
  assert.deepEqual(subject.calls.map(call => call.url), [endpoint, pathPrm, asMetadata])
})

test('missing path PRM falls back to exact origin resource at root', async () => {
  const subject = fixture({ fetchFn: url => url === pathPrm ? Response.json({}, { status: 404 })
    : url === rootPrm ? Response.json({ ...prm, resource: origin }) : undefined })
  const result = await subject.discover()
  assert.equal(result.resource, origin); assert.equal(result.info.resourceMetadataUrl, rootPrm)
  assert.equal(validateMcpOAuthDiscovery(result.info, endpoint, issuer, result.resource).issuer, issuer)
  assert.throws(() => validateMcpOAuthDiscovery(result.info, endpoint, issuer), safeFailure('authorization-failed'))
  assert.deepEqual(subject.calls.map(call => call.url), [endpoint, pathPrm, rootPrm, asMetadata])
})

test('root validation parameter cannot approve arbitrary paths or unrelated resources', () => {
  const info = { authorizationServerUrl: issuer, authorizationServerMetadata: metadata, resourceMetadata: { ...prm, resource: `${origin}/other` } }
  for (const expected of [`${origin}/other`, 'https://other.discovery.fixture.invalid'])
    assert.throws(() => validateMcpOAuthDiscovery(info, endpoint, issuer, expected), safeFailure('authorization-failed'))
})

test('challenge/path PRM cannot broaden to origin and root PRM cannot claim an endpoint path', async () => {
  for (const source of ['path', 'challenge', 'root']) {
    const subject = fixture({ ...(source === 'challenge' ? { status: 401, challenge: `Bearer resource_metadata="${pathPrm}"` } : {}),
      prm: { ...prm, resource: origin }, fetchFn: source === 'root' ? url => url === pathPrm
        ? Response.json({}, { status: 404 }) : url === rootPrm ? Response.json(prm) : undefined : undefined })
    await assert.rejects(subject.discover(), safeFailure('authorization-failed'))
    assert(!subject.calls.some(call => call.url === asMetadata))
  }
})

test('issuer path tries RFC8414, OIDC insertion, then OIDC appending in order', async () => {
  const pathIssuer = `${issuer}/tenant`, oauth = `${issuer}/.well-known/oauth-authorization-server/tenant`
  const inserted = `${issuer}/.well-known/openid-configuration/tenant`, appended = `${issuer}/tenant/.well-known/openid-configuration`
  const oidc = { ...metadata, issuer: pathIssuer, jwks_uri: `${issuer}/jwks`, subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] }
  const subject = fixture({ prm: { ...prm, authorization_servers: [pathIssuer] }, fetchFn: url =>
    url === oauth || url === inserted ? Response.json({}, { status: 404 }) : url === appended ? Response.json(oidc) : undefined })
  assert.equal((await subject.discover()).issuer, pathIssuer)
  assert.deepEqual(subject.calls.map(call => call.url), [endpoint, pathPrm, oauth, inserted, appended])
})

test('root issuer supports OIDC discovery when RFC8414 is unavailable', async () => {
  const oidcUrl = `${issuer}/.well-known/openid-configuration`
  const subject = fixture({ fetchFn: url => url === asMetadata ? Response.json({}, { status: 404 })
    : url === oidcUrl ? Response.json({ ...metadata, jwks_uri: `${issuer}/jwks`, subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] }) : undefined })
  assert.equal((await subject.discover()).issuer, issuer)
  assert.deepEqual(subject.calls.map(call => call.url), [endpoint, pathPrm, asMetadata, oidcUrl])
})

test('advanced issuer selection must exactly match an advertised issuer', async () => {
  const other = 'https://other.auth.discovery.fixture.invalid'
  const subject = fixture({ prm: { ...prm, authorization_servers: [issuer, other] }, fetchFn: url =>
    url === `${other}/.well-known/oauth-authorization-server` ? Response.json({ ...metadata, issuer: other }) : undefined })
  assert.equal((await subject.discover({ issuer: other })).issuer, other)
  assert(!subject.calls.some(call => call.url === asMetadata))
  const unadvertised = fixture()
  await assert.rejects(unadvertised.discover({ issuer: other }), safeFailure('authorization-failed'))
  assert.deepEqual(unadvertised.calls.map(call => call.url), [endpoint, pathPrm])
})

test('exact issuer matching rejects SDK-tolerated trailing-slash mismatch', async () => {
  const subject = fixture({ prm: { ...prm, authorization_servers: [`${issuer}/`] } })
  await assert.rejects(subject.discover(), safeFailure('authorization-failed'))
})

test('incompatible/malformed OAuth capabilities fail without grants', async t => {
  for (const [index, update] of [{ code_challenge_methods_supported: undefined }, { code_challenge_methods_supported: ['plain'] },
    { response_types_supported: ['token'] }, { grant_types_supported: ['refresh_token'] },
    { token_endpoint_auth_methods_supported: undefined }, { token_endpoint_auth_methods_supported: ['client_secret_basic'] },
    { token_endpoint: undefined }, { issuer: `${issuer}/other` }].entries()) await t.test(`capability ${index}`, async () => {
      const subject = fixture({ metadata: update })
      await assert.rejects(subject.discover(), safeFailure('authorization-failed'))
      assert(subject.calls.every(call => call.method === 'GET'))
    })
})

test('absent/malformed resource metadata cannot fall back to an invented authorization server', async () => {
  for (const resource of [{ resource: endpoint }, { ...prm, authorization_servers: [] }, { ...prm, resource: `${endpoint}/` },
    { ...prm, bearer_methods_supported: ['query'] }, { ...prm, dpop_bound_access_tokens_required: true },
    { ...prm, scopes_supported: ['bad scope'] }]) {
    const subject = fixture({ prm: resource })
    await assert.rejects(subject.discover(), safeFailure('authorization-failed'))
    assert(subject.calls.every(call => call.method === 'GET'))
  }
  const absent = fixture({ fetchFn: url => url === pathPrm || url === rootPrm ? Response.json({}, { status: 404 }) : undefined })
  await assert.rejects(absent.discover(), safeFailure('authorization-failed'))
  assert(!absent.calls.some(call => new URL(call.url).origin === issuer))
})

test('unsafe endpoints are rejected before fetch, including private IP representations and empty query/fragment', async () => {
  for (const url of ['http://mcp.invalid/mcp', 'https://user:password@mcp.invalid/mcp', 'https://mcp.invalid/mcp?',
    'https://mcp.invalid/mcp#', 'https://mcp.invalid/mcp?scope=read', 'https://mcp.invalid/mcp#section',
    'https://localhost/mcp', 'https://host.internal/mcp', 'https://host.local/mcp', 'https://127.0.0.1/mcp',
    'https://2130706433/mcp', 'https://0x7f000001/mcp', 'https://10.0.0.1/mcp', 'https://[::1]/mcp',
    'https://[::ffff:127.0.0.1]/mcp', 'https://mcp.invalid\\@other.invalid/mcp']) {
    let fetched = false
    await assert.rejects(discoverMcpOAuth(url, { fetchFn: async () => { fetched = true; return Response.json({}) } }), safeFailure('authorization-failed'))
    assert.equal(fetched, false, url)
    assert.throws(() => mcpOAuthRemoteUrl(url), safeFailure('authorization-failed'))
  }
})

test('unsafe challenged URLs, issuers, authorization/token/registration endpoints never reach those destinations', async () => {
  for (const unsafe of ['http://unsafe.invalid/meta', 'https://127.0.0.1/meta', 'https://host.internal/meta',
    'https://safe.invalid/meta?token=provider-secret', 'https://safe.invalid/meta#fragment', 'https://user:pass@safe.invalid/meta']) {
    for (const target of ['challenge', 'issuer', 'authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
      const subject = fixture(target === 'challenge' ? { status: 401, challenge: `Bearer resource_metadata="${unsafe}"` }
        : target === 'issuer' ? { prm: { ...prm, authorization_servers: [unsafe] } } : { metadata: { [target]: unsafe } })
      await assert.rejects(subject.discover(), safeFailure('authorization-failed'))
      assert(!subject.calls.some(call => call.url === unsafe))
    }
  }
})

test('malformed/ambiguous Bearer challenges fail instead of silently choosing fallback authority', async () => {
  for (const challenge of ['Bearer resource_metadata="not a URL"', 'Bearer resource_metadata=""',
    `Bearer resource_metadata="${pathPrm}", resource_metadata="${rootPrm}"`, 'Bearer scope="read", Bearer scope="write"',
    'Bearer scope="unterminated', 'Bearer scope="bad\\\"scope"', 'Bearer scope="read  write"']) {
    const subject = fixture({ status: 401, challenge })
    await assert.rejects(subject.discover(), safeFailure('authorization-failed'))
    assert.deepEqual(subject.calls.map(call => call.url), [endpoint])
  }
})

test('redirects, huge headers, and metadata over 64 KiB fail closed', async () => {
  for (const response of [() => Response.redirect('https://redirect.fixture.invalid/meta'),
    () => new Response(null, { status: 401, headers: { 'WWW-Authenticate': `Bearer realm="${'x'.repeat(16 * 1024)}"` } }),
    () => new Response('x'.repeat(64 * 1024 + 1), { status: 405 }),
    () => new Response(null, { status: 405, headers: { 'content-length': String(64 * 1024 + 1) } })]) {
    const subject = fixture({ fetchFn: url => url === endpoint ? response() : undefined })
    await assert.rejects(subject.discover(), safeFailure('authorization-failed'))
    assert.deepEqual(subject.calls.map(call => call.url), [endpoint])
  }
})

test('abort/deadline stop a noncooperative fetch and no later phase runs', async () => {
  const controller = new AbortController(); let calls = 0
  const pending = discoverMcpOAuth(endpoint, { signal: controller.signal, fetchFn: async () => { calls++; return new Promise(() => {}) } })
  controller.abort()
  await assert.rejects(pending, safeFailure('cancelled')); assert.equal(calls, 1)
  let lateResolve
  const timed = fixture({ fetchFn: () => new Promise(resolve => { lateResolve = resolve }) })
  await assert.rejects(timed.discover({ deadlineMs: 20 }), safeFailure('timeout'))
  lateResolve(Response.json(prm)); await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(timed.calls.length, 1)
  const already = new AbortController(); already.abort()
  const subject = fixture(); await assert.rejects(subject.discover({ signal: already.signal }), safeFailure('cancelled'))
  assert.equal(subject.calls.length, 0)
})

test('ownership guard is rechecked after asynchronous fetch and body phases', async () => {
  let current = true
  const subject = fixture({ fetchFn: url => { if (url === pathPrm) { current = false; return Response.json(prm) } return undefined } })
  await assert.rejects(subject.discover({ assertCurrent: () => { if (!current) throw Object.assign(new Error('provider-secret'), { code: 'cancelled' }) } }), safeFailure('authorization-failed'))
  assert.deepEqual(subject.calls.map(call => call.url), [endpoint, pathPrm])
  current = true
  const streamed = fixture({ fetchFn: url => url === pathPrm ? new Response(new ReadableStream({ pull(controller) {
    current = false; controller.enqueue(new TextEncoder().encode(JSON.stringify(prm))); controller.close()
  } }), { headers: { 'content-type': 'application/json' } }) : undefined })
  await assert.rejects(streamed.discover({ assertCurrent: () => { if (!current) throw new Error('provider-secret') } }), safeFailure('authorization-failed'))
  assert(!streamed.calls.some(call => call.url === asMetadata))
})

test('exact GET allowlists cannot authorize arbitrary URLs or a POST on an approved origin', async () => {
  let calls = 0
  const fetchFn = createMcpOAuthFetch({ fetchFn: async () => { calls++; return Response.json({}) }, signal: new AbortController().signal,
    origins: [origin], getEndpoints: [pathPrm], assertCurrent: () => {}, postEndpoint: () => undefined, registerSecrets: () => {} })
  await assert.rejects(fetchFn(rootPrm), safeFailure('authorization-failed'))
  await assert.rejects(fetchFn(pathPrm, { method: 'POST' }), safeFailure('authorization-failed'))
  assert.equal(calls, 0)
  await fetchFn(pathPrm); assert.equal(calls, 1)
})

test('optional CIMD reader performs one exact public GET and returns frozen JSON', async () => {
  const url = 'https://clients.discovery.fixture.invalid/vivi.json', calls = []
  const document = { client_id: url, redirect_uris: ['http://127.0.0.1:41873/oauth/callback'], token_endpoint_auth_method: 'none' }
  const result = await fetchMcpOAuthClientMetadata(url, { fetchFn: async (input, init) => {
    calls.push([String(input), init]); return Response.json(document)
  } })
  assert.deepEqual(result, document); assert(Object.isFrozen(result)); assert(Object.isFrozen(result.redirect_uris))
  assert.equal(calls.length, 1); assert.equal(calls[0][0], url); assert.equal(calls[0][1].method, 'GET')
  assert.equal(calls[0][1].redirect, 'manual'); assert.equal(calls[0][1].credentials, 'omit')
})

test('CIMD reader rejects non-JSON media, arrays, malformed, redirects, over 5 KiB, unsafe URLs, and cancellation', async () => {
  const url = 'https://clients.discovery.fixture.invalid/vivi.json'
  for (const response of [() => new Response('{}', { headers: { 'content-type': 'text/plain' } }),
    () => new Response('{}', { headers: {} }), () => Response.json([]), () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => Response.redirect('https://other.discovery.fixture.invalid/client'),
    () => Response.json({ padding: 'x'.repeat(5 * 1024) }), () => Response.json({}, { status: 404 })])
    await assert.rejects(fetchMcpOAuthClientMetadata(url, { fetchFn: async () => response() }), safeFailure('authorization-failed'))
  let calls = 0
  await assert.rejects(fetchMcpOAuthClientMetadata('https://127.0.0.1/client', { fetchFn: async () => { calls++; return Response.json({}) } }), safeFailure('authorization-failed'))
  assert.equal(calls, 0)
  await assert.rejects(fetchMcpOAuthClientMetadata(url, { deadlineMs: 20, fetchFn: async () => new Promise(() => {}) }), safeFailure('timeout'))
})

test('root fallback accepts equivalent trailing slash but preserves the exact advertised resource', async () => {
  const subject = fixture({ fetchFn: url => url === pathPrm ? Response.json({}, { status: 404 })
    : url === rootPrm ? Response.json({ ...prm, resource: origin + '/' }) : undefined })
  const discovered = await subject.discover()
  assert.equal(discovered.resource, origin + '/'); assert.equal(discovered.info.resourceMetadata.resource, origin + '/')
})

test('root endpoint accepts origin-without-slash PRM while preserving the advertised resource', async () => {
  const calls = [], rootEndpoint = origin + '/'
  const result = await discoverMcpOAuth(rootEndpoint, { fetchFn: async input => {
    const url = String(input); calls.push(url)
    if (url === rootEndpoint) return new Response(null, { status: 405 })
    if (url === rootPrm) return Response.json({ ...prm, resource: origin })
    if (url === asMetadata) return Response.json(metadata)
    return Response.json({}, { status: 404 })
  } })
  assert.equal(result.resource, origin); assert.deepEqual(calls, [rootEndpoint, rootPrm, asMetadata])
})

test('public HTTPS nondefault ports survive discovery and exact issuer/resource validation', async () => {
  const target = 'https://mcp.port.fixture.invalid:8443/mcp', auth = 'https://auth.port.fixture.invalid:9443'
  const result = await discoverMcpOAuth(target, { fetchFn: async input => {
    const url = new URL(String(input))
    if (url.href === target) return new Response(null, { status: 405 })
    if (url.origin === new URL(target).origin) return Response.json({ resource: target, authorization_servers: [auth] })
    if (url.origin === auth) return Response.json({ ...metadata, issuer: auth, authorization_endpoint: auth + '/authorize', token_endpoint: auth + '/token' })
    assert.fail('Unexpected fixture destination')
  } })
  assert.equal(result.issuer, auth); assert.equal(result.resource, target)
})
