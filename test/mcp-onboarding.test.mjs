// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { McpConfigStore } from '../dist/mcp-config.js'
import { manageMcp } from '../dist/mcp-controls.js'
import { McpManager } from '../dist/mcp-manager.js'
import { McpOAuthControls } from '../dist/mcp-oauth-controls.js'
import { McpSetupService } from '../dist/mcp-setup.js'

const endpoint = 'https://mcp.guided.fixture.invalid/mcp'
const issuer = 'https://auth.guided.fixture.invalid'
const registrationEndpoint = 'https://clients.guided.fixture.invalid/register'
const server = { transport: 'http', id: 'remote', label: 'Owned registration fixture', endpoint,
  protocol: '2026-07-28', allowLoopbackHttp: false }
const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
  registration_endpoint: registrationEndpoint, response_types_supported: ['code'], grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
  authorization_response_iss_parameter_supported: true }
const signal = () => new AbortController().signal
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const clean = value => assert(!JSON.stringify(value).includes('fixture-registration-secret'), 'Registration credentials escaped a public surface')
const json = (message, result) => Response.json({ jsonrpc: '2.0', id: message.id,
  result: { ...result, resultType: 'complete', ttlMs: 0, cacheScope: 'private' } })
function ioFixture(answers = [], selections = [], texts = []) {
  return { output: '', approvals: [], choices: [], textTitles: [], protected: [], closed: false,
    get isClosed() { return this.closed }, write(value) { this.output += value },
    async approve(request, abort) { assert(!abort.aborted); this.approvals.push(structuredClone(request)); return answers.shift() ?? false },
    async choose(title, choices, initial) {
      this.choices.push({ title, choices: structuredClone(choices), initial })
      const selection = selections.shift()
      if (selection !== undefined) assert(choices.some(item => item.value === selection), `${String(selection)} absent from ${title}`)
      return selection
    },
    async askText(title) { this.textTitles.push(title); return texts.shift() },
    async chooseSearchable() { return undefined }, async readLine() { return undefined },
    addSecrets(values) { this.protected.push(...values) }, setSession() { assert.fail('No conversation expected') },
    event() {}, result() {}, close() { this.closed = true },
    onCancel(callback) { this.cancel = callback; return () => { delete this.cancel } }
  }
}
async function availablePort() {
  const listener = createServer()
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}
async function noListener(port) {
  const listener = createServer()
  try { await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve) }) }
  finally { await new Promise(resolve => listener.close(resolve)) }
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-registration-controls-')), store = new McpConfigStore(directory)
  const settings = { issuer, redirectPort: await availablePort(), redirectPath: '/owned/registered/callback', scopes: ['read'], clientName: 'Owned vivi fixture' }
  const oauthRequests = [], requests = [], browserUrls = [], secrets = []
  let rejectedEffects = false, registrations = 0, tokens = 0
  const fetchFn = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET'
    assert.equal(url.protocol, 'https:'); assert(url.hostname.endsWith('.invalid'), 'Fixture attempted external networking')
    assert.equal(init.redirect, 'manual')
    oauthRequests.push({ url: url.href, method, body: init.body, signal: init.signal, headers: new Headers(init.headers) })
    if (options.oauthFetch) { const response = await options.oauthFetch(url, init); if (response) return response }
    if (url.href === endpoint) return new Response(null, { status: 405 })
    if (url.origin === new URL(endpoint).origin && url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return Response.json({ resource: endpoint, authorization_servers: [issuer], scopes_supported: ['read'] })
    if (url.origin === issuer && url.pathname.includes('/.well-known/')) return Response.json(options.metadata ?? metadata)
    if (url.href === registrationEndpoint && method === 'POST') {
      registrations++
      return Response.json({ ...JSON.parse(init.body), client_id: `owned-registered-client-${registrations}`,
        registration_access_token: 'fixture-registration-secret-management-token',
        registration_client_uri: `${issuer}/clients/management`, ...(options.registrationResponse ?? {}) }, { status: 201 })
    }
    if (url.href === metadata.token_endpoint && method === 'POST') {
      tokens++
      return Response.json({ access_token: `fixture-registration-secret-access-${tokens}`, refresh_token: 'fixture-registration-secret-refresh',
        token_type: 'Bearer', expires_in: 60, scope: 'read' })
    }
    assert.fail(`Unexpected fixture OAuth request ${method} ${url.href}`)
  }
  const openBrowser = async (url, abort) => {
    browserUrls.push(new URL(url)); assert.equal(url.origin, issuer)
    if (options.openBrowser) return options.openBrowser(url, abort)
    const callback = new URL(url.searchParams.get('redirect_uri'))
    assert.equal(callback.port, String(settings.redirectPort)); assert.equal(callback.pathname, settings.redirectPath)
    callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('iss', issuer)
    callback.searchParams.set('code', 'fixture-registration-secret-code')
    const response = await fetch(callback); assert.equal(response.status, 200); clean(await response.text())
  }
  const httpFetch = async (input, init) => {
    assert.equal(String(input), endpoint); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual')
    const message = JSON.parse(init.body)
    requests.push({ message, headers: new Headers(init.headers), signal: init.signal })
    if (options.httpFetch) { const response = await options.httpFetch(message, init); if (response) return response }
    if (message.method === 'server/discover') return json(message, { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } })
    if (message.method === 'tools/list') return json(message, { tools: [{ name: 'owned-registration-echo', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] })
    if (message.method === 'tools/call') return rejectedEffects
      ? new Response('fixture-registration-secret-HTTP-error', { status: 401, headers: { 'www-authenticate': 'Bearer' } })
      : json(message, { content: [{ type: 'text', text: 'OWNED_REGISTRATION_RESULT' }] })
    assert.fail(`Unexpected fixture MCP request ${message.method}`)
  }
  const oauth = new McpOAuthControls({ ...(options.policy === undefined ? { dynamicRegistration: 'explicit' } : options.policy === 'default' ? {} : { dynamicRegistration: options.policy }),
    fetchFn, openBrowser, timeoutMs: 5000, secrets: options.secrets, redirectPort: settings.redirectPort, redirectPath: settings.redirectPath,
    ...(options.clientMetadataUrl ? { clientMetadataUrl: options.clientMetadataUrl } : {}),
    registerSecrets(values) { secrets.push(...values); manager.addSecrets(values) } })
  const manager = new McpManager({ store, env: {}, ...oauth.managerOptions(), httpFetch })
  oauth.bind(manager)
  t.after(async () => { await oauth.close(); await manager.close(); await rm(directory, { recursive: true, force: true }) })
  await manager.configure(server)
  if (options.client) await oauth.configureClient(server.id, { ...settings, id: 'owned-existing-client' })
  return { directory, store, settings, oauth, manager, oauthRequests, requests, browserUrls, secrets, fetchFn, openBrowser, httpFetch,
    register: (io = ioFixture([true]), abort = signal()) => oauth.registerPublicClient(server.id, settings, io, abort),
    signIn: (io = ioFixture([true]), abort = signal()) => oauth.guidedSignInAndConnect(server.id, io, abort),
    rejectEffects() { rejectedEffects = true } }
}
const posts = subject => subject.oauthRequests.filter(item => item.method === 'POST')
const registrationPosts = subject => posts(subject).filter(item => item.url === registrationEndpoint)
const tokenPosts = subject => posts(subject).filter(item => item.url === metadata.token_endpoint)

test('URL-only guided login discovers scopes, registers once, opens browser, and connects with one exact consent', async t => {
  const subject = await fixture(t), io = ioFixture([true])
  assert.equal(await subject.signIn(io), true)
  assert.deepEqual(io.approvals.map(item => item.call.name), ['sign_in_mcp_server'])
  const approval = io.approvals[0]
  assert.match(approval.description, /Registration endpoint:/); assert.match(approval.description, /Requested scopes: \["read"\]/)
  assert.match(approval.description, /discover tool metadata/); assert.match(approval.description, /spending limits/)
  assert.match(approval.description, /Token endpoint:/); assert.match(approval.description, /selected model\/provider automatically/)
  assert.equal(registrationPosts(subject).length, 1); assert.equal(tokenPosts(subject).length, 1)
  assert.equal(subject.browserUrls.length, 1)
  assert.equal(subject.browserUrls[0].searchParams.get('scope'), 'read')
  assert.equal(subject.browserUrls[0].searchParams.get('resource'), endpoint)
  assert.equal(subject.browserUrls[0].searchParams.get('code_challenge_method'), 'S256')
  assert.equal(subject.manager.statuses()[0].state, 'connected')
  assert(subject.requests.every(item => item.headers.get('authorization') === 'Bearer fixture-registration-secret-access-1'))
  assert.equal(subject.requests.filter(item => item.message.method === 'tools/list').length, 1)
  assert.equal(subject.requests.filter(item => item.message.method === 'tools/call').length, 0)
  await subject.manager.reload()
  assert.equal(subject.oauth.status(server.id).state, 'connected', 'finishing the setup attempt must not invalidate the grant')
  assert.equal(subject.manager.statuses()[0].state, 'connected')
  clean([io.output, io.approvals, subject.manager.statuses(), await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8')])
  await noListener(subject.settings.redirectPort)
})

test('denied guided consent sends no registration/token/MCP request and opens no browser', async t => {
  const subject = await fixture(t), io = ioFixture([false])
  assert.equal(await subject.signIn(io), false)
  assert.equal(io.approvals.length, 1); assert.equal(posts(subject).length, 0)
  assert.equal(subject.browserUrls.length, 0); assert.equal(subject.requests.length, 0)
  assert.equal(subject.oauth.status(server.id).state, 'unconfigured')
  await noListener(subject.settings.redirectPort)
})

test('guided login uses an existing issuer-bound public client without registering', async t => {
  const subject = await fixture(t, { client: true }), io = ioFixture([true])
  assert.equal(await subject.signIn(io), true)
  assert.equal(registrationPosts(subject).length, 0)
  assert.equal(subject.browserUrls[0].searchParams.get('client_id'), 'owned-existing-client')
  assert.equal(io.approvals.length, 1); assert.match(io.approvals[0].description, /existing public client/)
})

test('CIMD supported issuer uses verified configured JSON document before DCR', async t => {
  const clientMetadataUrl = 'https://client.guided.fixture.invalid/oauth/client.json'
  let subject
  subject = await fixture(t, { clientMetadataUrl, metadata: { ...metadata, client_id_metadata_document_supported: true },
    oauthFetch: url => url.href === clientMetadataUrl ? Response.json({ client_id: clientMetadataUrl, client_name: 'vivi-cli',
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
      redirect_uris: [`http://127.0.0.1:${subject.settings.redirectPort}${subject.settings.redirectPath}`] }) : undefined })
  const io = ioFixture([true]); assert.equal(await subject.signIn(io), true)
  assert.equal(registrationPosts(subject).length, 0)
  assert.equal(subject.browserUrls[0].searchParams.get('client_id'), clientMetadataUrl)
  assert.match(io.approvals[0].description, /hosted client metadata document/)
})

for (const changes of [{ client_secret: 'fixture-registration-secret-client' }, { client_id: 'https://different.guided.fixture.invalid/client.json' },
  { token_endpoint_auth_method: 'client_secret_basic' }, { redirect_uris: ['http://localhost:52147/callback'] }])
  test('invalid configured CIMD document fails before consent, DCR or browser ' + Object.keys(changes)[0], async t => {
    const clientMetadataUrl = 'https://client.guided.fixture.invalid/oauth/client.json'
    const subject = await fixture(t, { clientMetadataUrl, metadata: { ...metadata, client_id_metadata_document_supported: true },
      oauthFetch: url => url.href === clientMetadataUrl ? Response.json({ client_id: clientMetadataUrl, token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], response_types: ['code'], redirect_uris: ['http://127.0.0.1:52147/callback'], ...changes }) : undefined })
    const io = ioFixture([true]); await assert.rejects(subject.signIn(io), error => error.code === 'client-registration-failed')
    assert.equal(io.approvals.length, 0); assert.equal(posts(subject).length, 0); assert.equal(subject.browserUrls.length, 0)
  })

test('unsupported automatic client setup gives a concrete Advanced path without throwing', async t => {
  const { registration_endpoint: ignored, ...unsupported } = metadata
  const subject = await fixture(t, { metadata: unsupported }), io = ioFixture([true])
  assert.equal(await subject.signIn(io), false)
  assert.match(io.output, /Advanced/); assert.match(io.output, /pre-registered public client/)
  assert.equal(io.approvals.length, 0); assert.equal(posts(subject).length, 0); assert.equal(subject.browserUrls.length, 0)
})

test('configuration replacement during guided approval blocks every mutation and browser', async t => {
  const subject = await fixture(t), io = ioFixture([true])
  io.approve = async request => {
    io.approvals.push(request)
    const previous = await subject.store.load()
    await subject.store.save([{ ...server, label: 'Changed endpoint owner' }], previous.revision)
    return true
  }
  await assert.rejects(subject.signIn(io), error => error.code === 'cancelled')
  assert.equal(posts(subject).length, 0); assert.equal(subject.browserUrls.length, 0); assert.equal(subject.requests.length, 0)
})

test('uncertain registration is never silently resubmitted on another guided login', async t => {
  const subject = await fixture(t, { registrationResponse: { client_secret: 'fixture-registration-secret-client' } }), io = ioFixture([true])
  await assert.rejects(subject.signIn(io), error => error.code === 'client-registration-uncertain')
  assert.equal(registrationPosts(subject).length, 1); assert.equal(subject.browserUrls.length, 0)
  await assert.rejects(subject.signIn(ioFixture([true])), error => error.code === 'client-registration-uncertain')
  assert.equal(registrationPosts(subject).length, 1)
})

test('cancelled browser wait closes callback and grants no usable connection', async t => {
  const abort = new AbortController()
  const subject = await fixture(t, { openBrowser: async () => { abort.abort() } })
  await assert.rejects(subject.signIn(ioFixture([true]), abort.signal), error => error.code === 'cancelled')
  assert.equal(registrationPosts(subject).length, 1); assert.equal(tokenPosts(subject).length, 0)
  assert.equal(subject.requests.length, 0); assert.equal(subject.oauth.authorization(server).bearerToken, undefined)
  await noListener(subject.settings.redirectPort)
})

test('shared setup list is inert and state-based; add/remove reject a stale exact config revision', async t => {
  const subject = await fixture(t), service = new McpSetupService(subject.manager, subject.oauth)
  const before = service.list(); assert.equal(before.servers[0].nextAction, 'Connect')
  assert.equal(subject.oauthRequests.length, 0); assert.equal(subject.requests.length, 0)
  await subject.oauth.configureClient(server.id, { ...subject.settings, id: 'owned-existing-client' })
  assert.equal(service.list().servers[0].nextAction, 'Sign in')
  await subject.manager.configure({ ...server, id: 'other', label: 'Other server' })
  await assert.rejects(service.addHttp({ id: 'new', endpoint }, before.revision), /configuration changed/)
  await assert.rejects(service.remove(server.id, before.revision), /configuration changed/)
  assert.equal((await subject.store.load()).servers.length, 2)
})

test('initial unauthenticated Connect challenge leads directly to guided sign-in and fresh connection', async t => {
  const subject = await fixture(t, { httpFetch: (_message, init) => !new Headers(init.headers).has('authorization')
    ? new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }) : undefined })
  const service = new McpSetupService(subject.manager, subject.oauth), io = ioFixture([true, true])
  assert.equal(await service.connect(server.id, io, signal()), true)
  assert.deepEqual(io.approvals.map(item => item.call.name), ['connect_mcp_server', 'sign_in_mcp_server'])
  assert.equal(registrationPosts(subject).length, 1); assert.equal(tokenPosts(subject).length, 1)
  assert.equal(subject.requests.filter(item => item.message.method === 'tools/list').length, 1)
  assert.equal(subject.manager.statuses()[0].state, 'connected')
})

test('denied guided sign-in after initial challenge keeps meaningful Sign in state without another registration', async t => {
  const subject = await fixture(t, { httpFetch: () => new Response(null, { status: 401 }) })
  const service = new McpSetupService(subject.manager, subject.oauth), io = ioFixture([true, false])
  assert.equal(await service.connect(server.id, io, signal()), false)
  assert.equal(service.list().servers[0].nextAction, 'Sign in')
  assert.equal(posts(subject).length, 0); assert.equal(subject.browserUrls.length, 0)
})

test('Advanced protocol edit is explicit and revision-bound without starting a connection', async t => {
  const subject = await fixture(t), io = ioFixture([], ['server:remote', 'advanced', 'protocol', 'legacy', true, 'back'])
  await manageMcp(subject.manager, io, undefined, subject.oauth)
  assert.equal((await subject.store.load()).servers[0].protocol, 'legacy')
  assert.equal(subject.oauthRequests.length, 0); assert.equal(subject.requests.length, 0)
})

test('a public client becoming a known secret during guided consent never reaches the browser or token endpoint', async t => {
  const secrets = [], subject = await fixture(t, { client: true, secrets }), io = ioFixture([true])
  io.approve = async request => {
    io.approvals.push(request)
    secrets.push('owned-existing-client')
    return true
  }
  await assert.rejects(subject.signIn(io), error => error.code === 'authorization-failed')
  assert.equal(subject.browserUrls.length, 0); assert.equal(posts(subject).length, 0)
})

test('scope becoming a known secret during guided consent blocks registration before transmission', async t => {
  const secrets = [], subject = await fixture(t, { secrets }), io = ioFixture([true])
  io.approve = async request => { io.approvals.push(request); secrets.push('read'); return true }
  await assert.rejects(subject.signIn(io), error => error.code === 'authorization-failed')
  assert.equal(posts(subject).length, 0); assert.equal(subject.browserUrls.length, 0)
})

test('Advanced protocol keeps the outer server snapshot revision when configuration changes during menu selection', async t => {
  const subject = await fixture(t), io = ioFixture([], ['server:remote', 'advanced', 'protocol', 'legacy', true, 'back'])
  const choose = io.choose.bind(io)
  io.choose = async (title, choices, initial) => {
    const choice = await choose(title, choices, initial)
    if (choice === 'protocol') {
      const saved = await subject.store.load()
      await subject.store.save([{ ...server, endpoint: 'https://changed.guided.fixture.invalid/mcp' }], saved.revision)
      await subject.manager.reload()
    }
    return choice
  }
  await manageMcp(subject.manager, io, undefined, subject.oauth)
  const saved = await subject.store.load()
  assert.equal(saved.servers[0].endpoint, 'https://changed.guided.fixture.invalid/mcp')
  assert.equal(saved.servers[0].protocol, '2026-07-28')
  assert.equal(subject.requests.length, 0)
})

test('DCR management secret matching the approved token endpoint blocks browser and token transmission', async t => {
  const subject = await fixture(t, { registrationResponse: { registration_access_token: metadata.token_endpoint } }), io = ioFixture([true])
  await assert.rejects(subject.signIn(io), error => error.code === 'authorization-failed')
  assert.equal(registrationPosts(subject).length, 1); assert.equal(tokenPosts(subject).length, 0)
  assert.equal(subject.browserUrls.length, 0); assert.equal(subject.requests.length, 0)
})

test('guided root-resource sign-in preserves the validated advertised resource through PKCE and token exchange', async t => {
  const origin = new URL(endpoint).origin
  const subject = await fixture(t, { oauthFetch: url => url.href === `${origin}/.well-known/oauth-protected-resource/mcp`
    ? Response.json({}, { status: 404 }) : url.href === `${origin}/.well-known/oauth-protected-resource`
      ? Response.json({ resource: origin + '/', authorization_servers: [issuer], scopes_supported: ['read'] }) : undefined })
  assert.equal(await subject.signIn(ioFixture([true])), true)
  assert.equal(subject.browserUrls[0].searchParams.get('resource'), origin + '/')
  assert.equal(new URLSearchParams(tokenPosts(subject)[0].body).get('resource'), origin + '/')
  assert.equal(subject.manager.statuses()[0].state, 'connected')
})
