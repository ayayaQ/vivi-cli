// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { McpConfigStore } from '../dist/mcp-config.js'
import { manageMcp } from '../dist/mcp-controls.js'
import { McpManager } from '../dist/mcp-manager.js'
import { McpOAuthControls } from '../dist/mcp-oauth-controls.js'

const endpoint = 'https://mcp.controls.fixture.invalid/mcp', issuer = 'https://auth.controls.fixture.invalid'
const server = { transport: 'http', id: 'remote', label: 'Owned OAuth fixture', endpoint,
  protocol: '2026-07-28', allowLoopbackHttp: false }
const client = { id: 'owned-public-client', issuer, redirectPort: 0, redirectPath: '/owned/mcp/callback', scopes: ['read'] }
const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
  response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true }
const signal = () => new AbortController().signal
const uriTemplate = 'fixture://docs/{name}{?q}', variables = { name: 'alpha', q: 'two words' }, expandedUri = 'fixture://docs/alpha?q=two%20words'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const callbackUrl = url => {
  const callback = new URL(url.searchParams.get('redirect_uri'))
  callback.searchParams.set('state', url.searchParams.get('state'))
  callback.searchParams.set('code', 'fixture-secret-authorization-code')
  callback.searchParams.set('iss', issuer)
  return callback
}
const json = (message, result, protocol = server.protocol) => Response.json({ jsonrpc: '2.0', id: message.id,
  result: protocol === 'legacy' ? result : { ...result, resultType: 'complete', ttlMs: 0, cacheScope: 'private' } })
const clean = value => assert(!JSON.stringify(value).includes('fixture-secret'), 'OAuth credentials escaped a public surface')
function ioFixture(answers = [], selections = [], texts = []) {
  return { output: '', approvals: [], choices: [], closed: false, protected: [],
    get isClosed() { return this.closed }, write(text) { this.output += text },
    async approve(request, abort) { this.approvals.push(structuredClone(request)); assert(!abort.aborted); return answers.shift() ?? false },
    async choose(title, choices, initial) {
      this.choices.push({ title, choices: structuredClone(choices), initial })
      const choice = selections.shift()
      if (choice !== undefined) assert(choices.some(item => item.value === choice), `${String(choice)} absent from ${title}`)
      return choice
    },
    async askText() { return texts.shift() }, async readLine() { return undefined },
    addSecrets(values) { this.protected.push(...values) },
    onCancel(callback) { this.cancel = callback; return () => { delete this.cancel } },
    close() { this.closed = true }, event() {}, result() {}
  }
}
async function portAvailable(url) {
  const listener = createServer()
  try { await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(Number(url.port), '127.0.0.1', resolve) }) }
  finally { await new Promise(resolve => listener.close(resolve)) }
}
async function availablePort() {
  const listener = createServer()
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-oauth-controls-')), store = new McpConfigStore(directory)
  const requests = [], oauthRequests = [], browserUrls = [], secrets = [], effects = []
  const configured = { ...server, protocol: options.protocol ?? server.protocol }
  let now = 1000, exchanges = 0, effectStatus = 200
  const oauth = new McpOAuthControls({ now: () => now, timeoutMs: options.timeoutMs ?? 5000,
    secrets: options.secrets,
    registerSecrets(values) { secrets.push(...values); manager.addSecrets(values) },
    fetchFn: async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? 'GET'
      oauthRequests.push({ url: url.href, method, body: init?.body, signal: init?.signal })
      assert.equal(init.redirect, 'manual')
      assert([new URL(endpoint).origin, issuer].includes(url.origin), 'OAuth fixture attempted external networking')
      if (options.oauthFetch) { const response = await options.oauthFetch(url, init); if (response) return response }
      if (url.href === endpoint) return new Response(null, { status: 405 })
      if (url.origin === new URL(endpoint).origin && url.pathname.startsWith('/.well-known/oauth-protected-resource'))
        return Response.json({ resource: endpoint, authorization_servers: [issuer] })
      if (url.origin === issuer && url.pathname.includes('/.well-known/')) return Response.json(metadata)
      if (url.href === metadata.token_endpoint && method === 'POST') {
        exchanges++
        return Response.json({ access_token: `fixture-secret-access-token-${exchanges}`, refresh_token: 'fixture-secret-refresh-token',
          token_type: 'Bearer', expires_in: 60, scope: 'read' })
      }
      assert.fail(`Unexpected OAuth fixture request ${method} ${url.href}`)
    },
    openBrowser: async (url, abort) => {
      browserUrls.push(new URL(url))
      assert.equal(url.origin, issuer); assert.equal(url.pathname, '/authorize')
      if (options.openBrowser) return options.openBrowser(url, abort)
      const response = await fetch(callbackUrl(url)); assert.equal(response.status, 200)
      clean(await response.text())
    }
  })
  const manager = new McpManager({ store, env: {}, ...oauth.managerOptions(), httpFetch: async (input, init) => {
    assert.equal(String(input), endpoint); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual')
    const message = JSON.parse(init.body), headers = new Headers(init.headers)
    requests.push({ message, headers, signal: init.signal })
    if (options.httpFetch) { const response = await options.httpFetch(message, init); if (response) return response }
    if (message.method === 'tools/call' || message.method === 'resources/read') {
      effects.push(message)
      if (effectStatus !== 200) return new Response('fixture-secret-provider-error', { status: effectStatus,
        headers: { 'www-authenticate': 'Bearer error="invalid_token"' } })
      return json(message, message.method === 'resources/read' ? { contents: [{ uri: message.params.uri, text: 'OWNED_OAUTH_RESOURCE' }] }
        : { content: [{ type: 'text', text: options.toolText ?? 'OWNED_OAUTH_RESULT' }] }, configured.protocol)
    }
    const capabilities = { tools: {}, ...(options.templates ? { resources: {} } : {}) }
    if (message.method === 'initialize') return json(message, { protocolVersion: '2025-11-25', capabilities,
      serverInfo: { name: 'Owned OAuth fixture', version: '1' } }, configured.protocol)
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return new Response(null, { status: 202 })
    if (message.method === 'server/discover') return json(message, { supportedVersions: ['2026-07-28'], capabilities }, configured.protocol)
    if (message.method === 'tools/list') return json(message, { tools: [{ name: 'owned-echo', inputSchema: { type: 'object',
      properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }] }, configured.protocol)
    if (message.method === 'resources/list') return json(message, { resources: [] }, configured.protocol)
    if (message.method === 'resources/templates/list') return json(message, { resourceTemplates: [{ uriTemplate, name: 'Owned OAuth template' }] }, configured.protocol)
    assert.fail(`Unexpected MCP fixture request ${message.method}`)
  } })
  oauth.bind(manager)
  t.after(async () => { await oauth.close(); await manager.close(); await rm(directory, { recursive: true, force: true }) })
  await manager.configure(configured)
  if (!options.noClient) await oauth.configureClient(server.id, client)
  return { directory, store, manager, oauth, configured, requests, oauthRequests, browserUrls, secrets, effects,
    tick(value) { now += value }, rejectEffects(status) { effectStatus = status },
    async signIn(io = ioFixture([true, true]), abort = signal()) { return oauth.signInAndConnect(server.id, io, abort) },
    async prepare(kind = 'tools', values = variables) {
      if (kind === 'resourceTemplates') await manager.refresh(server.id, ['resources', 'resourceTemplates'], signal())
      const [snapshot] = await manager.captureCatalogs(signal()), entry = snapshot.categories[kind].entries[0]
      return manager.prepareOperation(snapshot, entry, kind, { id: 'owned-oauth-operation', name: kind === 'tools' ? entry.alias : 'read_mcp_resource_template',
        arguments: kind === 'tools' ? { query: 'ordinary' } : { serverId: server.id, uriTemplate, variables: values } })
    }
  }
}

test('missing public client and denied sign-in never open browser, bind callback, exchange or connect', async t => {
  const missing = await fixture(t, { noClient: true }), denied = await fixture(t)
  assert.equal(missing.oauth.status(server.id).state, 'unconfigured')
  await assert.rejects(missing.signIn(), error => error.code === 'client-registration-required')
  assert.equal(missing.browserUrls.length, 0); assert.equal(missing.requests.length, 0)
  const io = ioFixture([false])
  assert.equal(await denied.signIn(io), false)
  assert.deepEqual(io.approvals.map(item => item.call.name), ['sign_in_mcp_server'])
  assert.equal(denied.browserUrls.length, 0); assert.equal(denied.requests.length, 0)
  assert.equal(denied.oauthRequests.filter(item => item.method === 'POST').length, 0)
  assert.equal(denied.oauth.authorization(denied.configured).bearerToken, undefined)
  clean([io.approvals, io.output, denied.oauth.status(server.id)])
})

for (const protocol of ['legacy', '2026-07-28']) test(`${protocol} explicit sign-in uses SDK PKCE then separate human HTTP approval and fresh catalog`, async t => {
  const subject = await fixture(t, { protocol }), io = ioFixture([true, true])
  const before = subject.oauth.authorization(subject.configured).revision
  assert.equal(await subject.signIn(io), true)
  assert.deepEqual(io.approvals.map(item => item.call.name), ['sign_in_mcp_server', 'connect_mcp_server'])
  assert(io.approvals[0].description.includes(metadata.authorization_endpoint))
  assert.equal(subject.browserUrls.length, 1)
  const url = subject.browserUrls[0], exchange = subject.oauthRequests.find(item => item.method === 'POST'), body = new URLSearchParams(exchange.body)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), url.searchParams.get('code_challenge'))
  assert.equal(new URL(url.searchParams.get('redirect_uri')).pathname, client.redirectPath)
  assert.equal(body.get('redirect_uri'), url.searchParams.get('redirect_uri'))
  assert.equal(body.get('client_id'), client.id); assert.equal(body.get('client_secret'), null)
  assert.equal(body.get('grant_type'), 'authorization_code'); assert.equal(body.get('resource'), endpoint)
  assert.equal(url.searchParams.get('scope'), 'read'); assert.equal(url.searchParams.get('resource'), endpoint)
  assert(subject.secrets.includes(body.get('code_verifier'))); assert(subject.secrets.includes(url.searchParams.get('state')))
  assert(subject.secrets.includes('fixture-secret-authorization-code')); assert(subject.secrets.includes('fixture-secret-refresh-token'))
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, 'fixture-secret-access-token-1')
  assert.notEqual(subject.oauth.authorization(subject.configured).revision, before)
  const [snapshot] = await subject.manager.captureCatalogs(signal())
  assert.equal(subject.manager.statuses()[0].state, 'connected'); assert.equal(snapshot.categories.tools.entries[0].remoteKey, 'owned-echo')
  assert(subject.requests.every(item => item.headers.get('authorization') === 'Bearer fixture-secret-access-token-1'))
  assert.equal(subject.requests.filter(item => item.message.method === 'tools/list').length, 1)
  assert.equal(subject.effects.length, 0); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
  assert(!subject.oauthRequests.some(item => /register|refresh/.test(item.url)))
  clean([io.output, io.approvals, snapshot, subject.manager.statuses(), subject.oauth.status(server.id)])
  const configText = await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8')
  clean(configText); assert(!configText.includes(client.id)); assert(!configText.includes(client.redirectPath))
  const exposed = JSON.stringify([io.output, io.approvals, snapshot, subject.manager.statuses(), subject.oauth.status(server.id), configText])
  for (const secret of subject.secrets) assert(!exposed.includes(secret), 'An SDK-generated secret escaped a public surface')
  await portAvailable(new URL(url.searchParams.get('redirect_uri')))
})

for (const protocol of ['legacy', '2026-07-28']) test(`${protocol} signed-in template read keeps exact human approval and bearer-free durable evidence`, async t => {
  const { CliHost } = await import('../dist/host.js'), { FileSessionStore } = await import('../dist/session.js')
  const subject = await fixture(t, { protocol, templates: true }), signInIo = ioFixture([true, true])
  assert.equal(await subject.signIn(signInIo), true)
  const operation = await subject.prepare('resourceTemplates'), approvals = []
  assert.equal(operation.resourceUri, expandedUri)
  let rounds = 0, reviews = 0
  const host = await CliHost.create({ store: new FileSessionStore(join(subject.directory, 'sessions')), mcp: subject.manager,
    secrets: subject.secrets, settings: { provider: 'openai', model: 'owned-fixture' },
    approve: async request => { approvals.push(request); return true },
    decisionReview: { canAutoReview: true, accountRevision: () => 'owned-fixture-account',
      provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { reviews++; throw new Error('MCP must remain human-reviewed') } },
      ledger: { async upsert() { throw new Error('MCP must never enter Auto audit') } } },
    provider: { async generate() { return ++rounds === 1 ? { content: '', toolCalls: [{ id: 'owned-oauth-template', name: operation.call.name, arguments: operation.call.arguments }] }
      : { content: 'Owned OAuth template complete', toolCalls: [] } } } })
  t.after(() => host.shutdown()); host.setApprovalMode('auto')
  const completed = await host.send('Read the owned signed-in template')
  assert.equal(completed.status, 'completed'); assert.equal(approvals.length, 1); assert.equal(reviews, 0)
  assert.equal(approvals[0].call.name, 'read_mcp_resource_template')
  assert(approvals[0].description.includes(uriTemplate)); assert(approvals[0].description.includes(expandedUri))
  assert.equal(subject.effects.length, 1); assert.equal(subject.effects[0].method, 'resources/read')
  const { _meta, ...wireParams } = subject.effects[0].params
  assert.deepEqual(wireParams, { uri: expandedUri })
  if (protocol === '2026-07-28') assert.equal(_meta['io.modelcontextprotocol/protocolVersion'], protocol)
  assert.equal(subject.requests.find(item => item.message.method === 'resources/read').headers.get('authorization'), 'Bearer fixture-secret-access-token-1')
  assert.match(JSON.stringify(completed.history), /OWNED_OAUTH_RESOURCE/)
  assert(JSON.stringify(host.conversationRecords.projection).includes(expandedUri))
  assert(host.conversationRecords.projection.outcomes.some(item => item.effect === 'confirmed' && item.status === 'succeeded'))
  clean([signInIo.approvals, approvals, completed.history, host.conversationRecords.projection])
  assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
})

for (const protocol of ['legacy', '2026-07-28']) for (const status of [401, 403])
  test(`${protocol} signed-in template ${status} revokes bearer and never replays the read or authenticates again`, async t => {
    const subject = await fixture(t, { protocol, templates: true })
    assert.equal(await subject.signIn(), true)
    const operation = await subject.prepare('resourceTemplates'); subject.rejectEffects(status)
    const result = await subject.manager.invoke(operation, signal(), () => {}), body = JSON.parse(result.content)
    assert.equal(body.requestSent, true); assert.equal(body.unknownOutcome, true); assert.equal(body.doNotRetry, true)
    assert.equal(subject.effects.length, 1); assert.equal(subject.effects[0].params.uri, expandedUri)
    assert.equal(subject.oauth.status(server.id).state, 'needs-sign-in')
    assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
    assert.equal(subject.browserUrls.length, 1); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
    assert.equal((await subject.manager.captureCatalogs(signal())).length, 0); clean([result, subject.oauth.status(server.id)])
  })

for (const invalidation of ['expiry', 'disconnect']) test(`signed-in template ${invalidation} invalidates its prepared auth epoch before sending`, async t => {
  const subject = await fixture(t, { templates: true }); assert.equal(await subject.signIn(), true)
  const operation = await subject.prepare('resourceTemplates')
  if (invalidation === 'expiry') subject.tick(60_000)
  else await subject.manager.disconnect(server.id)
  const result = await subject.manager.invoke(operation, signal(), () => {}), body = JSON.parse(result.content)
  assert.equal(body.requestSent, false); assert.equal(subject.effects.length, 0)
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
  assert.equal(subject.browserUrls.length, 1); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
  clean(result)
})

test('known bearer values in template variables are withheld before any read or approval', async t => {
  const subject = await fixture(t, { templates: true }); assert.equal(await subject.signIn(), true)
  await assert.rejects(subject.prepare('resourceTemplates', { ...variables, name: 'fixture-secret-access-token-1' }))
  assert.equal(subject.effects.length, 0); assert.equal(subject.requests.filter(item => item.message.method === 'resources/read').length, 0)
})

test('signed-in template browser explains reviewed expansion and retrieves no contents', async t => {
  const subject = await fixture(t, { templates: true }); assert.equal(await subject.signIn(), true)
  await subject.prepare('resourceTemplates')
  const io = ioFixture([], ['server:remote', 'resourceTemplates', 0, 'back'])
  await manageMcp(subject.manager, io, undefined, subject.oauth)
  assert.match(io.output, /Admitted scalar URI templates can be expanded/)
  assert.match(io.output, /browsing retrieves no contents/); assert(!io.output.includes('expansion is unavailable'))
  assert.equal(subject.effects.length, 0); assert.equal(io.approvals.length, 0); clean(io.output)
})

test('denied post-sign-in connection erases session credentials and never sends MCP requests', async t => {
  const subject = await fixture(t), io = ioFixture([true, false])
  assert.equal(await subject.signIn(io), false)
  assert.equal(subject.browserUrls.length, 1); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
  assert.equal(subject.requests.length, 0); assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
  assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
  clean(io.approvals)
})

test('failed fresh HTTP connection cannot retain signed-in credentials or metadata', async t => {
  const subject = await fixture(t, { httpFetch: async () => new Response('fixture-secret-http-failure', { status: 500 }) })
  assert.equal(await subject.signIn(), false)
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
  assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
  clean(subject.manager.statuses()); assert.equal(subject.browserUrls.length, 1)
})

test('successive explicit sign-ins replace auth revision and catalog and each need two fresh approvals', async t => {
  const subject = await fixture(t), first = ioFixture([true, true]), second = ioFixture([true, true])
  assert.equal(await subject.signIn(first), true)
  const old = await subject.prepare(), revision = subject.oauth.authorization(subject.configured).revision
  assert.equal(await subject.signIn(second), true)
  assert.notEqual(subject.oauth.authorization(subject.configured).revision, revision)
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, 'fixture-secret-access-token-2')
  assert.equal(subject.browserUrls.length, 2); assert.equal(subject.requests.filter(item => item.message.method === 'tools/list').length, 2)
  assert.deepEqual(second.approvals.map(item => item.call.name), ['sign_in_mcp_server', 'connect_mcp_server'])
  const outcome = await subject.manager.invoke(old, signal(), () => {})
  assert.equal(JSON.parse(outcome.content).requestSent, false); assert.equal(subject.effects.length, 0)
})

test('concurrent sign-in cannot create a second callback or exchange', async t => {
  const opened = deferred(), resume = deferred()
  const subject = await fixture(t, { openBrowser: async url => { opened.resolve(url); await resume.promise; await fetch(callbackUrl(url)) } })
  const first = subject.signIn(); await opened.promise
  await assert.rejects(subject.signIn(), error => !error.message.includes('fixture-secret'))
  assert.equal(subject.browserUrls.length, 1); assert.equal(subject.requests.length, 0)
  resume.resolve(); assert.equal(await first, true)
  assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
})

test('cancellation while awaiting callback releases the owned listener and sends no token or MCP request', async t => {
  const opened = deferred(), subject = await fixture(t, { openBrowser: async url => { opened.resolve(url) } })
  const abort = new AbortController(), pending = subject.signIn(ioFixture([true, true]), abort.signal)
  const rejected = assert.rejects(pending, error => error.code === 'cancelled' && !error.message.includes('fixture-secret'))
  const url = await opened.promise; abort.abort(); await rejected
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
  assert.equal(subject.requests.length, 0); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 0)
  await portAvailable(new URL(url.searchParams.get('redirect_uri')))
})

test('cancellation while exchanging aborts owned token POST and stale completion cannot install bearer', async t => {
  const entered = deferred(), release = deferred()
  const subject = await fixture(t, { oauthFetch: async (url, init) => {
    if (url.href !== metadata.token_endpoint) return
    entered.resolve(init.signal); await release.promise
    return Response.json({ access_token: 'fixture-secret-late-access-token', token_type: 'Bearer' })
  } })
  const abort = new AbortController(), pending = subject.signIn(ioFixture([true, true]), abort.signal)
  const rejected = assert.rejects(pending, error => error.code === 'cancelled')
  const ownedSignal = await entered.promise; abort.abort(); await rejected; assert(ownedSignal.aborted)
  release.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined); assert.equal(subject.requests.length, 0)
  await portAvailable(new URL(subject.browserUrls[0].searchParams.get('redirect_uri')))
})

for (const action of ['disconnect', 'remove', 'close', 'configuration']) test(`${action} invalidates successful auth and old operations`, async t => {
  const subject = await fixture(t)
  assert.equal(await subject.signIn(), true)
  const revision = subject.oauth.authorization(subject.configured).revision, operation = await subject.prepare()
  if (action === 'configuration') {
    const saved = await subject.store.load()
    await subject.store.save([{ ...subject.configured, label: 'Changed owned fixture' }], saved.revision)
    await subject.manager.reload()
  } else await subject.manager[action](server.id)
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
  assert.notEqual(subject.oauth.authorization(subject.configured).revision, revision)
  if (action !== 'close') assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
  const outcome = await subject.manager.invoke(operation, signal(), () => {})
  assert.equal(JSON.parse(outcome.content).requestSent, false)
  assert.equal(subject.effects.length, 0)
})

for (const action of ['disconnect', 'remove', 'close']) test(`${action} during callback wait cancels sign-in before any connection exists`, async t => {
  const opened = deferred(), subject = await fixture(t, { openBrowser: async url => { opened.resolve(url) } })
  const pending = subject.signIn(), rejected = assert.rejects(pending, error => !error.message.includes('fixture-secret'))
  const url = await opened.promise
  await subject.manager[action](server.id); await rejected
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
  assert.equal(subject.requests.length, 0); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 0)
  await portAvailable(new URL(url.searchParams.get('redirect_uri')))
})

test('expiry advances auth revision, revokes catalog and prevents old operation send without refresh', async t => {
  const subject = await fixture(t); assert.equal(await subject.signIn(), true)
  const operation = await subject.prepare(), revision = subject.oauth.authorization(subject.configured).revision
  subject.tick(60_000)
  assert.equal(subject.oauth.status(server.id).state, 'needs-sign-in')
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
  assert.notEqual(subject.oauth.authorization(subject.configured).revision, revision)
  const outcome = await subject.manager.invoke(operation, signal(), () => {})
  assert.equal(JSON.parse(outcome.content).requestSent, false); assert.equal(subject.effects.length, 0)
  assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
  assert.equal(subject.browserUrls.length, 1); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
})

for (const protocol of ['legacy', '2026-07-28']) for (const status of [401, 403]) test(`${protocol} HTTP ${status} invalidates bearer and explicitly needs sign-in without OAuth or operation replay`, async t => {
  const subject = await fixture(t, { protocol }); assert.equal(await subject.signIn(), true)
  const operation = await subject.prepare(), revision = subject.oauth.authorization(subject.configured).revision
  subject.rejectEffects(status)
  const outcome = await subject.manager.invoke(operation, signal(), () => {}), body = JSON.parse(outcome.content)
  assert.equal(body.unknownOutcome, true); assert.equal(body.requestSent, true); assert.equal(body.doNotRetry, true)
  assert.equal(subject.effects.length, 1); assert.equal(subject.browserUrls.length, 1)
  assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
  assert.notEqual(subject.oauth.authorization(subject.configured).revision, revision)
  assert.equal(subject.oauth.status(server.id).state, 'needs-sign-in')
  assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
  const replay = await subject.manager.invoke(operation, signal(), () => {})
  assert.equal(JSON.parse(replay.content).requestSent, false); assert.equal(subject.effects.length, 1)
  clean([outcome, replay, subject.oauth.status(server.id), subject.manager.statuses()])
})

test('HTTPS management offers explicit sign-in/client controls with Back as default and no automatic authorization', async t => {
  const subject = await fixture(t), io = ioFixture([], ['server:remote', 'back', 'back'])
  await manageMcp(subject.manager, io, undefined, subject.oauth)
  const actions = io.choices.find(item => item.choices.some(choice => choice.value === 'advanced'))
  assert(actions); assert(actions.choices.some(choice => choice.value === 'sign-in')); assert(!actions.choices.some(choice => choice.value === 'oauth-client'))
  assert(io.choices.every(item => item.initial === 0)); assert.equal(actions.choices[0].value, 'back')
  assert.equal(subject.browserUrls.length, 0); assert.equal(subject.oauthRequests.length, 0); assert.equal(subject.requests.length, 0)
  clean([io.output, io.choices])
})

for (const approved of [false, true]) test(`readLine-only OAuth controls configure public client and ${approved ? 'connect after bundled approval' : 'deny before browser'}`, async t => {
  const subject = await fixture(t, { noClient: true }), port = await availablePort()
  const io = ioFixture(approved ? [true] : [false]), prompts = []
  delete io.choose; delete io.askText
  const lines = ['3', '3', '2', client.id, issuer, String(port), client.redirectPath, 'read', '2', '3', '2', '1']
  io.readLine = async prompt => { prompts.push(prompt); return lines.shift() }
  await manageMcp(subject.manager, io, undefined, subject.oauth)
  assert.equal(lines.length, 0)
  assert.equal(prompts.filter(value => value === 'Choose a number; blank cancels: ').length, 7)
  assert.match(io.output, /1\. Back/); assert.match(io.output, /1\. Cancel/)
  assert.match(io.output, /2\. Public client settings/); assert.match(io.output, /2\. Sign in/)
  assert.deepEqual(io.approvals.map(item => item.call.name), ['sign_in_mcp_server'])
  assert.equal(subject.browserUrls.length, approved ? 1 : 0)
  assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, approved ? 1 : 0)
  assert.equal(subject.requests.filter(item => item.message.method === 'tools/list').length, approved ? 1 : 0)
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, approved ? 'fixture-secret-access-token-1' : undefined)
  assert.equal(subject.manager.statuses()[0].state, approved ? 'connected' : 'disabled')
  const saved = await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8')
  clean([io.output, io.approvals, saved]); assert(!saved.includes(client.id)); assert(!saved.includes(client.redirectPath))
  await portAvailable(new URL(`http://127.0.0.1:${port}${client.redirectPath}`))
})

test('public client configuration validates issuer, callback path/port and scopes without discovery or persistence', async t => {
  const subject = await fixture(t, { noClient: true })
  for (const change of [{ issuer: 'http://auth.controls.fixture.invalid' }, { issuer: issuer + '?secret=value' },
    { id: '' }, { id: 'client secret' }, { redirectPort: -1 }, { redirectPort: 65536 }, { redirectPort: 1.5 },
    { redirectPath: undefined }, { redirectPath: '/callback?secret=value' }, { redirectPath: '/callback#fragment' },
    { scopes: ['read', 'read'] }, { scopes: ['read write'] }]) {
    await assert.rejects(subject.oauth.configureClient(server.id, { ...client, ...change }), error => !error.message.includes('fixture-secret'))
    assert.equal(subject.oauth.status(server.id).state, 'unconfigured')
  }
  assert.equal(subject.browserUrls.length, 0); assert.equal(subject.oauthRequests.length, 0); assert.equal(subject.requests.length, 0)
  const before = await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8')
  await subject.oauth.configureClient(server.id, client)
  assert.equal(subject.oauth.status(server.id).state, 'disconnected')
  assert.equal(await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8'), before)
})

test('late-known shared provider secrets cannot become public client ID, issuer, callback path or scope', async t => {
  const shared = [], subject = await fixture(t, { noClient: true, secrets: shared })
  const lateSecret = 'fixture-secret-late-provider-key'
  shared.push(lateSecret)
  for (const change of [{ id: lateSecret }, { issuer: `${issuer}/${lateSecret}` },
    { redirectPath: `/callback/${lateSecret}` }, { scopes: ['read', lateSecret] }]) {
    await assert.rejects(subject.oauth.configureClient(server.id, { ...client, ...change }), error => !error.message.includes(lateSecret))
    assert.equal(subject.oauth.status(server.id).state, 'unconfigured')
  }
  assert.equal(subject.oauthRequests.length, 0); assert.equal(subject.browserUrls.length, 0); assert.equal(subject.requests.length, 0)
  clean(await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8'))
})

test('public client becoming a known secret during human approval blocks browser and token exchange', async t => {
  const shared = [], subject = await fixture(t, { secrets: shared }), io = ioFixture([true, true])
  const approve = io.approve.bind(io)
  io.approve = async (request, abort) => {
    const accepted = await approve(request, abort)
    if (request.call.name === 'sign_in_mcp_server') shared.push(client.id)
    return accepted
  }
  await assert.rejects(subject.signIn(io), error => !error.message.includes(client.id))
  assert.deepEqual(io.approvals.map(item => item.call.name), ['sign_in_mcp_server'])
  assert.equal(subject.browserUrls.length, 0); assert.equal(subject.requests.length, 0)
  assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 0)
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
})

for (const stage of ['sign-in', 'connect']) test(`configuration replacement during ${stage} approval cannot open/send with stale authority`, async t => {
  const subject = await fixture(t), io = ioFixture([true, true]), approve = io.approve.bind(io)
  io.approve = async (request, abort) => {
    const accepted = await approve(request, abort)
    if (request.call.name === (stage === 'sign-in' ? 'sign_in_mcp_server' : 'connect_mcp_server')) {
      const saved = await subject.store.load()
      await subject.store.save([{ ...subject.configured, label: 'Replacement during approval' }], saved.revision)
    }
    return accepted
  }
  await assert.rejects(subject.signIn(io), error => !error.message.includes('fixture-secret'))
  assert.equal(subject.browserUrls.length, stage === 'sign-in' ? 0 : 1)
  assert.equal(subject.requests.length, 0); assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
})

test('cancelling discovery aborts the owned request before browser or token exchange', async t => {
  const entered = deferred(), release = deferred()
  const subject = await fixture(t, { oauthFetch: async (_url, init) => {
    entered.resolve(init.signal); await release.promise; return Response.json({})
  } })
  const abort = new AbortController(), pending = subject.signIn(ioFixture([true, true]), abort.signal)
  const rejected = assert.rejects(pending, error => error.code === 'cancelled')
  const ownedSignal = await entered.promise; abort.abort(); await rejected; assert(ownedSignal.aborted)
  release.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.browserUrls.length, 0); assert.equal(subject.requests.length, 0)
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
})

test('replacing launch-only public client settings revokes existing grant without a new grant or connection', async t => {
  const subject = await fixture(t); assert.equal(await subject.signIn(), true)
  const revision = subject.oauth.authorization(subject.configured).revision
  await subject.oauth.configureClient(server.id, { ...client, id: 'owned-replacement-public-client' })
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
  assert.notEqual(subject.oauth.authorization(subject.configured).revision, revision)
  assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
  assert.equal(subject.browserUrls.length, 1); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
})

test('callback timeout clears the grant and releases the listener without exchanging or connecting', async t => {
  const subject = await fixture(t, { openBrowser: async () => {}, timeoutMs: 500 })
  await assert.rejects(subject.signIn(), error => error.code === 'timeout')
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
  assert.equal(subject.requests.length, 0); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 0)
  await portAvailable(new URL(subject.browserUrls[0].searchParams.get('redirect_uri')))
})

for (const protocol of ['legacy', '2026-07-28']) for (const status of [401, 403]) test(`${protocol} fresh connection HTTP ${status} clears grant, requires sign-in and sends no replay`, async t => {
  const subject = await fixture(t, { protocol, httpFetch: async () => new Response('fixture-secret-rejected-catalog', {
    status, headers: { 'www-authenticate': 'Bearer' } }) })
  assert.equal(await subject.signIn(), false)
  assert.equal(subject.requests.length, 1); assert.equal(subject.effects.length, 0)
  assert.equal(subject.browserUrls.length, 1); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
  assert.equal(subject.oauth.status(server.id).state, 'needs-sign-in')
  assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
  clean([subject.manager.statuses(), subject.oauth.status(server.id)])
})

for (const action of ['disconnect', 'remove', 'close', 'configuration']) test(`${action} during exchange aborts the token POST and rejects late grant`, async t => {
  const entered = deferred(), release = deferred()
  const subject = await fixture(t, { oauthFetch: async (url, init) => {
    if (url.href !== metadata.token_endpoint) return
    entered.resolve(init.signal); await release.promise
    return Response.json({ access_token: 'fixture-secret-lifecycle-late-token', token_type: 'Bearer' })
  } })
  const pending = subject.signIn(), rejected = assert.rejects(pending, error => !error.message.includes('fixture-secret'))
  const ownedSignal = await entered.promise
  if (action === 'configuration') {
    const saved = await subject.store.load()
    await subject.store.save([{ ...subject.configured, label: 'Changed during exchange' }], saved.revision)
    await subject.manager.reload()
  } else await subject.manager[action](server.id)
  await rejected; assert(ownedSignal.aborted)
  release.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined); assert.equal(subject.requests.length, 0)
  await portAvailable(new URL(subject.browserUrls[0].searchParams.get('redirect_uri')))
})

for (const protocol of ['legacy', '2026-07-28']) for (const status of [401, 403]) test(`${protocol} late HTTP ${status} after cancellation revokes the still-current auth epoch`, async t => {
  const entered = deferred(), release = deferred()
  const subject = await fixture(t, { protocol, httpFetch: async (message, init) => {
    if (message.method !== 'tools/call') return
    entered.resolve(init.signal); await release.promise
    return new Response('fixture-secret-late-auth-rejection', { status, headers: { 'www-authenticate': 'Bearer' } })
  } })
  assert.equal(await subject.signIn(), true)
  const abort = new AbortController(), operation = await subject.prepare()
  const revision = subject.oauth.authorization(subject.configured).revision
  const pending = subject.manager.invoke(operation, abort.signal, () => {}), wireSignal = await entered.promise
  abort.abort(); await new Promise(resolve => setImmediate(resolve)); assert(wireSignal.aborted)
  release.resolve()
  const outcome = await pending
  assert.equal(JSON.parse(outcome.content).unknownOutcome, true)
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
  assert.notEqual(subject.oauth.authorization(subject.configured).revision, revision)
  assert.equal(subject.oauth.status(server.id).state, 'needs-sign-in')
  assert.equal(subject.requests.filter(item => item.message.method === 'tools/call').length, 1)
  assert.equal(subject.browserUrls.length, 1); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
  clean([outcome, subject.manager.statuses()])
})

for (const protocol of ['legacy', '2026-07-28']) for (const status of [401, 403]) test(`${protocol} stale late HTTP ${status} cannot revoke a replacement sign-in or catalog`, async t => {
  const entered = deferred(), release = deferred()
  const subject = await fixture(t, { protocol, httpFetch: async (message, init) => {
    if (message.method !== 'tools/call') return
    entered.resolve(init.signal); await release.promise
    return new Response('fixture-secret-stale-auth-rejection', { status, headers: { 'www-authenticate': 'Bearer' } })
  } })
  assert.equal(await subject.signIn(), true)
  const abort = new AbortController(), pending = subject.manager.invoke(await subject.prepare(), abort.signal, () => {})
  const wireSignal = await entered.promise
  abort.abort(); await new Promise(resolve => setImmediate(resolve)); assert(wireSignal.aborted)
  assert.equal(await subject.signIn(), true)
  const replacement = subject.oauth.authorization(subject.configured), [snapshot] = await subject.manager.captureCatalogs(signal())
  assert.equal(replacement.bearerToken, 'fixture-secret-access-token-2')
  release.resolve(); const outcome = await pending
  assert.equal(JSON.parse(outcome.content).unknownOutcome, true)
  assert.deepEqual(subject.oauth.authorization(subject.configured), replacement)
  assert.equal(subject.oauth.status(server.id).state, 'connected')
  assert.equal(subject.manager.statuses()[0].state, 'connected')
  assert.deepEqual(await subject.manager.captureCatalogs(signal()), [snapshot])
  assert.equal(subject.requests.filter(item => item.message.method === 'tools/call').length, 1)
  assert.equal(subject.browserUrls.length, 2); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 2)
  clean([outcome, snapshot, subject.manager.statuses()])
})

for (const failure of ['denied', 'failed']) test(`a ${failure} sign-in retains its attempt lock until awaited disconnect cleanup finishes`, async t => {
  let failOnce = failure === 'failed'
  const subject = await fixture(t, { httpFetch: async () => {
    if (failOnce) { failOnce = false; return new Response('fixture-secret-first-connection-failure', { status: 500 }) }
  } })
  const entered = deferred(), release = deferred(), disconnect = subject.manager.disconnect.bind(subject.manager)
  let calls = 0, settled = false
  subject.manager.disconnect = async id => {
    const ordinal = ++calls
    await disconnect(id)
    if (ordinal === 2) { entered.resolve(); await release.promise }
  }
  const first = subject.signIn(ioFixture(failure === 'denied' ? [false] : [true, true])).then(value => { settled = true; return value })
  await entered.promise
  const discoveryCount = subject.oauthRequests.length, browserCount = subject.browserUrls.length
  try {
    assert.equal(settled, false)
    await assert.rejects(subject.signIn(), error => error.code === 'invalid-plan')
    assert.equal(subject.oauthRequests.length, discoveryCount); assert.equal(subject.browserUrls.length, browserCount)
  } finally { release.resolve() }
  assert.equal(await first, false)
  assert.equal(await subject.signIn(), true)
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, failure === 'failed' ? 'fixture-secret-access-token-2' : 'fixture-secret-access-token-1')
})

for (const action of ['abort', 'close-io', 'configuration']) test(`${action} after fresh manager connect settles revokes grant/catalog and releases the attempt`, async t => {
  const subject = await fixture(t), abort = new AbortController(), io = ioFixture([true, true])
  const connect = subject.manager.connect.bind(subject.manager)
  subject.manager.connect = async (...args) => {
    const connected = await connect(...args)
    if (connected) {
      if (action === 'abort') abort.abort()
      else if (action === 'close-io') io.close()
      else {
        const saved = await subject.store.load()
        await subject.store.save([{ ...subject.configured, label: 'Changed after connection settled' }], saved.revision)
      }
    }
    return connected
  }
  await assert.rejects(subject.signIn(io, abort.signal), error => error.code === 'cancelled')
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, undefined)
  assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
  assert.equal(subject.manager.statuses()[0].state, 'disabled')
  assert.equal(subject.requests.filter(item => item.message.method === 'tools/list').length, 1)
  assert.equal(subject.browserUrls.length, 1); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
  await portAvailable(new URL(subject.browserUrls[0].searchParams.get('redirect_uri')))
  subject.manager.connect = connect
  if (action === 'configuration') await subject.oauth.configureClient(server.id, client)
  assert.equal(await subject.signIn(), true)
  assert.equal(subject.oauth.authorization(subject.configured).bearerToken, 'fixture-secret-access-token-2')
})

test('OAuth secrets are redacted from tool outputs, host approvals, model input, history and persisted session files', async t => {
  const { CliHost } = await import('../dist/host.js'), { FileSessionStore } = await import('../dist/session.js')
  const subject = await fixture(t, { toolText: 'fixture-secret-access-token-1 fixture-secret-refresh-token fixture-secret-authorization-code' })
  assert.equal(await subject.signIn(), true)
  const operation = await subject.prepare(), approvals = [], inputs = [], directory = join(subject.directory, 'sessions')
  let rounds = 0
  const host = await CliHost.create({ store: new FileSessionStore(directory, subject.secrets), mcp: subject.manager, secrets: subject.secrets,
    settings: { provider: 'openai', model: 'owned-fixture' }, approve: async request => { approvals.push(request); return true },
    provider: { async generate(input) { inputs.push(structuredClone(input)); return ++rounds === 1
      ? { content: '', toolCalls: [{ id: 'owned-oauth-host-call', name: operation.call.name, arguments: { query: 'ordinary' } }] }
      : { content: 'Owned OAuth host complete', toolCalls: [] } } } })
  t.after(() => host.shutdown())
  const completed = await host.send('Use the owned OAuth fixture')
  assert.equal(completed.status, 'completed'); assert.equal(subject.effects.length, 1)
  assert.equal(approvals.length, 1); assert.equal(approvals[0].call.name, operation.call.name)
  clean([approvals, inputs, completed.history])
  assert(inputs.every(input => input.tools.every(tool => !/sign_in_mcp|oauth|refresh_token/.test(tool.name))))
  for (const name of await readdir(directory)) if (name.endsWith('.json')) clean(await readFile(join(directory, name), 'utf8'))
})
