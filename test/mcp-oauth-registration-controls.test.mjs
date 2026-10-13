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
import { McpOAuthRegistration } from '../dist/mcp-oauth-registration.js'
import { main, parseArguments } from '../dist/main.js'
import { runApplication } from '../dist/application.js'

const endpoint = 'https://mcp.controls.registration.fixture.invalid/mcp'
const issuer = 'https://auth.controls.registration.fixture.invalid'
const registrationEndpoint = 'https://clients.controls.registration.fixture.invalid/register'
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
    if (url.origin === new URL(endpoint).origin && url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return Response.json({ resource: endpoint, authorization_servers: [issuer] })
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
    fetchFn, openBrowser, timeoutMs: 5000, secrets: options.secrets,
    registerSecrets(values) { secrets.push(...values); manager.addSecrets(values) } })
  const manager = new McpManager({ store, env: {}, ...oauth.managerOptions(), httpFetch })
  oauth.bind(manager)
  t.after(async () => { await oauth.close(); await manager.close(); await rm(directory, { recursive: true, force: true }) })
  await manager.configure(server)
  if (options.client) await oauth.configureClient(server.id, { ...settings, id: 'owned-existing-client' })
  return { directory, store, settings, oauth, manager, oauthRequests, requests, browserUrls, secrets, fetchFn, openBrowser, httpFetch,
    register: (io = ioFixture([true]), abort = signal()) => oauth.registerPublicClient(server.id, settings, io, abort),
    signIn: (io = ioFixture([true, true]), abort = signal()) => oauth.signInAndConnect(server.id, io, abort),
    rejectEffects() { rejectedEffects = true } }
}
const registrationPosts = subject => subject.oauthRequests.filter(item => item.url === registrationEndpoint && item.method === 'POST')
const tokenPosts = subject => subject.oauthRequests.filter(item => item.url === metadata.token_endpoint && item.method === 'POST')
async function replaceConfiguration(subject) {
  const saved = await subject.store.load()
  await subject.store.save([{ ...server, label: 'Replacement registration fixture' }], saved.revision)
  await subject.manager.reload()
}
async function publicSurfaces(subject, io) {
  const files = await readdir(subject.directory)
  const saved = await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8')
  clean([io.output, io.approvals, io.choices, subject.manager.statuses(), subject.oauth.status(server.id), subject.oauth.registrationStatus(server.id), saved])
  assert(!saved.includes('owned-registered-client')); assert(!saved.includes(subject.settings.redirectPath)); assert(!saved.includes(subject.settings.clientName))
  assert.deepEqual(files, ['mcp-servers.json'])
}

for (const policy of ['default', 'disabled']) test(`${policy} policy does not offer or execute dynamic registration`, async t => {
  const subject = await fixture(t, { policy }), io = ioFixture([], ['server:remote', 'back', 'back'])
  assert.equal(subject.oauth.canRegisterPublicClient(), false)
  await manageMcp(subject.manager, io, undefined, subject.oauth)
  assert(!io.choices.some(item => item.choices.some(choice => choice.value === 'oauth-register')))
  await assert.rejects(subject.register(), error => !error.message.includes('fixture-registration-secret'))
  await assert.rejects(subject.signIn(), error => error.code === 'client-registration-required')
  assert.equal(subject.oauthRequests.length, 0); assert.equal(subject.requests.length, 0); assert.equal(subject.browserUrls.length, 0)
})

test('denied explicit registration discovers and shows exact endpoint and public metadata, but sends no POST', async t => {
  const subject = await fixture(t), io = ioFixture([false])
  const before = await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8')
  assert.equal(await subject.register(io), false)
  assert.deepEqual(io.approvals.map(item => item.call.name), ['register_mcp_oauth_client'])
  const approval = io.approvals[0]
  assert(approval.description.includes(registrationEndpoint)); assert(approval.description.includes(subject.settings.clientName))
  assert(approval.description.includes(`http://127.0.0.1:${subject.settings.redirectPort}${subject.settings.redirectPath}`))
  assert.match(approval.description, /may retain/); assert.match(approval.description, /billable API access/)
  assert.match(approval.description, /"token_endpoint_auth_method":"none"/); assert.match(approval.description, /"scope":"read"/)
  assert.equal(approval.currentRevision, approval.call.arguments.registrationRevision)
  assert.equal(approval.call.arguments.configRevision, subject.manager.configurationRevision())
  assert.equal(registrationPosts(subject).length, 0); assert.equal(tokenPosts(subject).length, 0)
  assert.equal(subject.browserUrls.length, 0); assert.equal(subject.requests.length, 0); assert.equal(subject.oauth.status(server.id).state, 'unconfigured')
  assert.equal(await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8'), before)
  await publicSurfaces(subject, io); await noListener(subject.settings.redirectPort)
})

test('approved registration makes exactly one SDK public-client POST, discards management data and returns without sign-in or connection', async t => {
  const subject = await fixture(t), io = ioFixture([true])
  assert.equal(await subject.register(io), true)
  const [post] = registrationPosts(subject)
  assert.equal(registrationPosts(subject).length, 1); assert.equal(post.headers.get('authorization'), null)
  assert.deepEqual(JSON.parse(post.body), { redirect_uris: [`http://127.0.0.1:${subject.settings.redirectPort}${subject.settings.redirectPath}`],
    application_type: 'native', client_name: subject.settings.clientName, token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'], response_types: ['code'], scope: 'read' })
  assert.equal(subject.oauth.status(server.id).state, 'disconnected'); assert.equal(subject.oauth.hasActiveAttempt(server.id), false)
  assert.equal(subject.oauth.authorization(server).bearerToken, undefined); assert.equal(subject.manager.statuses()[0].state, 'disabled')
  assert.equal(subject.browserUrls.length, 0); assert.equal(tokenPosts(subject).length, 0); assert.equal(subject.requests.length, 0)
  assert(subject.secrets.includes('fixture-registration-secret-management-token'))
  await publicSurfaces(subject, io); await noListener(subject.settings.redirectPort)
})

test('registration menu returns before a separately selected sign-in and fresh connection/catalog approval', async t => {
  const subject = await fixture(t), settings = subject.settings
  const io = ioFixture([true, true, true], ['server:remote', 'oauth-register', 'server:remote', 'sign-in', 'back'],
    [issuer, String(settings.redirectPort), settings.redirectPath, 'read', settings.clientName])
  const choose = io.choose.bind(io)
  io.choose = async (title, choices, initial) => {
    if (title === 'MCP connections' && registrationPosts(subject).length === 1 && subject.browserUrls.length === 0) {
      assert.equal(subject.requests.length, 0); assert.equal(tokenPosts(subject).length, 0)
      assert.equal(subject.oauth.status(server.id).state, 'disconnected')
    }
    return choose(title, choices, initial)
  }
  await manageMcp(subject.manager, io, undefined, subject.oauth)
  assert.deepEqual(io.approvals.map(item => item.call.name), ['register_mcp_oauth_client', 'sign_in_mcp_server', 'connect_mcp_server'])
  assert(io.choices.every(item => item.initial === 0)); assert(io.choices.every(item => item.choices[0].value === 'back'))
  assert.equal(registrationPosts(subject).length, 1); assert.equal(tokenPosts(subject).length, 1); assert.equal(subject.browserUrls.length, 1)
  assert.match(io.approvals[1].description, /does not revoke provider-side grants or keys/)
  assert.equal(subject.browserUrls[0].searchParams.get('client_id'), 'owned-registered-client-1')
  assert.equal(subject.requests.filter(item => item.message.method === 'tools/list').length, 1)
  assert(subject.requests.every(item => item.headers.get('authorization') === 'Bearer fixture-registration-secret-access-1'))
  assert.equal(subject.requests.filter(item => item.message.method === 'tools/call').length, 0)
  assert.match(io.output, /Returning to the menu/); assert.match(io.output, /signed in and connected/)
  await publicSurfaces(subject, io); await noListener(settings.redirectPort)
})

test('readLine-only registration controls collect explicit fixed callback and return before a separately selected sign-in', async t => {
  const subject = await fixture(t), io = ioFixture([true, true, true]), prompts = [], settings = subject.settings
  delete io.choose; delete io.askText
  const lines = ['3', '5', issuer, String(settings.redirectPort), settings.redirectPath, 'read', settings.clientName, '3', '4', '1']
  io.readLine = async prompt => { prompts.push(prompt); return lines.shift() }
  await manageMcp(subject.manager, io, undefined, subject.oauth)
  assert.equal(lines.length, 0); assert.match(io.output, /5\. Register public OAuth client/)
  assert(prompts.some(value => value.includes('127.0.0.1'))); assert(prompts.some(value => value.includes('Explicit requested OAuth scopes')))
  assert.deepEqual(io.approvals.map(item => item.call.name), ['register_mcp_oauth_client', 'sign_in_mcp_server', 'connect_mcp_server'])
  assert.equal(registrationPosts(subject).length, 1); assert.equal(tokenPosts(subject).length, 1); assert.equal(subject.browserUrls.length, 1)
  await publicSurfaces(subject, io); await noListener(settings.redirectPort)
})

for (const stage of ['registration', 'sign-in', 'connect']) test(`declining the separate ${stage} approval grants no later step`, async t => {
  const subject = await fixture(t), registerIo = ioFixture([stage !== 'registration'])
  const registered = await subject.register(registerIo)
  if (stage === 'registration') {
    assert.equal(registered, false); assert.equal(registrationPosts(subject).length, 0)
  } else {
    assert.equal(registered, true)
    const signInIo = ioFixture(stage === 'sign-in' ? [false] : [true, false])
    assert.equal(await subject.signIn(signInIo), false)
    assert.deepEqual(signInIo.approvals.map(item => item.call.name), stage === 'sign-in' ? ['sign_in_mcp_server'] : ['sign_in_mcp_server', 'connect_mcp_server'])
    await publicSurfaces(subject, signInIo)
  }
  assert.equal(subject.browserUrls.length, stage === 'connect' ? 1 : 0); assert.equal(subject.requests.length, 0)
  assert.equal(subject.oauth.authorization(server).bearerToken, undefined); await noListener(subject.settings.redirectPort)
})

test('Connect and missing-client Sign in never silently register, even after HTTP 401 with registration advertised', async t => {
  const subject = await fixture(t, { httpFetch: async () => new Response('fixture-registration-secret-unauthorized', { status: 401,
    headers: { 'www-authenticate': `Bearer resource_metadata="${new URL(endpoint).origin}/.well-known/oauth-protected-resource"` } }) })
  const io = ioFixture([true], ['server:remote', 'connect', 'back'])
  await manageMcp(subject.manager, io, undefined, subject.oauth)
  await assert.rejects(subject.signIn(), error => error.code === 'client-registration-required')
  assert.equal(subject.requests.length, 1); assert.equal(subject.oauthRequests.length, 0); assert.equal(subject.browserUrls.length, 0)
  assert.deepEqual(io.approvals.map(item => item.call.name), ['connect_mcp_server']); clean([io.output, subject.manager.statuses()])
})

test('registered-client HTTP 401 clears bearer without registration, sign-in or operation replay', async t => {
  const subject = await fixture(t)
  assert.equal(await subject.register(), true); assert.equal(await subject.signIn(), true)
  const [snapshot] = await subject.manager.captureCatalogs(signal()), entry = snapshot.categories.tools.entries[0]
  const operation = subject.manager.prepareOperation(snapshot, entry, 'tools', { id: 'owned-registration-operation', name: entry.alias, arguments: {} })
  subject.rejectEffects()
  const result = await subject.manager.invoke(operation, signal(), () => {}), body = JSON.parse(result.content)
  assert.equal(body.requestSent, true); assert.equal(body.unknownOutcome, true); assert.equal(body.doNotRetry, true)
  assert.equal(subject.oauth.status(server.id).state, 'needs-sign-in'); assert.equal(subject.oauth.authorization(server).bearerToken, undefined)
  assert.equal(registrationPosts(subject).length, 1); assert.equal(tokenPosts(subject).length, 1); assert.equal(subject.browserUrls.length, 1)
  assert.equal(subject.requests.filter(item => item.message.method === 'tools/call').length, 1)
  assert.equal((await subject.manager.captureCatalogs(signal())).length, 0); clean([result, subject.oauth.status(server.id)])
})

for (const action of ['disconnect', 'remove', 'close', 'configuration']) for (const stage of ['discovery', 'approval', 'POST'])
  test(`${action} during registration ${stage} invalidates owned attempt before a client entry exists`, async t => {
    const entered = deferred(), release = deferred()
    const subject = await fixture(t, { oauthFetch: async (url, init) => {
      if (stage === 'discovery' && init.method !== 'POST' || stage === 'POST' && url.href === registrationEndpoint) {
        entered.resolve(init.signal); await release.promise
        return stage === 'POST' ? Response.json({ ...JSON.parse(init.body), client_id: 'owned-late-client' }, { status: 201 }) : Response.json({})
      }
    } })
    const io = ioFixture([true])
    if (stage === 'approval') io.approve = async request => { io.approvals.push(structuredClone(request)); entered.resolve(); await release.promise; return true }
    const pending = subject.register(io), rejected = assert.rejects(pending, error => !error.message.includes('fixture-registration-secret'))
    const ownedSignal = await entered.promise
    assert.equal(subject.oauth.status(server.id).state, 'unconfigured'); assert.equal(subject.oauth.hasActiveAttempt(server.id), true)
    if (action === 'configuration') await replaceConfiguration(subject)
    else await subject.manager[action](server.id)
    await rejected
    if (ownedSignal) assert.equal(ownedSignal.aborted, true)
    release.resolve(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(subject.oauth.status(server.id).state, 'unconfigured'); assert.equal(subject.oauth.hasActiveAttempt(server.id), false)
    assert.equal(subject.oauth.authorization(server).bearerToken, undefined)
    assert.equal(registrationPosts(subject).length, stage === 'POST' ? 1 : 0)
    assert.equal(subject.browserUrls.length, 0); assert.equal(tokenPosts(subject).length, 0); assert.equal(subject.requests.length, 0)
    await publicSurfaces(subject, io); await noListener(subject.settings.redirectPort)
  })

for (const mutation of ['configuration', 'client', 'secret', 'close']) test(`${mutation} change during registration approval blocks the POST and stale client installation`, async t => {
  const shared = [], subject = await fixture(t, { secrets: shared }), io = ioFixture([true]), approve = io.approve.bind(io), changed = deferred()
  io.approve = async (request, abort) => {
    const accepted = await approve(request, abort)
    if (mutation === 'configuration') await replaceConfiguration(subject)
    if (mutation === 'client') await subject.oauth.configureClient(server.id, { ...subject.settings, id: 'owned-replacement-client' })
    if (mutation === 'secret') shared.push(subject.settings.clientName)
    if (mutation === 'close') io.close()
    changed.resolve()
    return accepted
  }
  await assert.rejects(subject.register(io), error => !error.message.includes('fixture-registration-secret'))
  await changed.promise
  assert.equal(registrationPosts(subject).length, 0); assert.equal(subject.browserUrls.length, 0); assert.equal(subject.requests.length, 0)
  assert.equal(subject.oauth.status(server.id).state, mutation === 'client' ? 'disconnected' : 'unconfigured')
  assert.equal(subject.oauth.authorization(server).bearerToken, undefined)
})

test('concurrent registration and sign-in share one attempt lock before registration approval', async t => {
  const entered = deferred(), release = deferred(), subject = await fixture(t, { client: true }), io = ioFixture([true])
  io.approve = async () => { entered.resolve(); await release.promise; return true }
  const pending = subject.register(io); await entered.promise
  const count = subject.oauthRequests.length
  await assert.rejects(subject.register(), error => error.code === 'invalid-plan')
  await assert.rejects(subject.signIn(), error => error.code === 'invalid-plan')
  assert.equal(subject.oauthRequests.length, count); assert.equal(subject.browserUrls.length, 0); assert.equal(registrationPosts(subject).length, 0)
  release.resolve(); assert.equal(await pending, true); assert.equal(await subject.signIn(), true)
  assert.equal(registrationPosts(subject).length, 1); assert.equal(tokenPosts(subject).length, 1)
})

test('registration cannot begin while sign-in owns a callback', async t => {
  const entered = deferred(), subject = await fixture(t, { client: true, openBrowser: async url => entered.resolve(url) })
  const abort = new AbortController(), pending = subject.signIn(ioFixture([true, true]), abort.signal)
  const rejected = assert.rejects(pending, error => error.code === 'cancelled')
  await entered.promise
  await assert.rejects(subject.register(), error => error.code === 'invalid-plan')
  assert.equal(registrationPosts(subject).length, 0); abort.abort(); await rejected; await noListener(subject.settings.redirectPort)
})

test('denied registration keeps its shared attempt lock until adapter cleanup finishes', async t => {
  const subject = await fixture(t), entered = deferred(), release = deferred()
  const cancel = McpOAuthRegistration.prototype.cancelRegistration
  let calls = 0, settled = false
  McpOAuthRegistration.prototype.cancelRegistration = async function () {
    await cancel.call(this)
    if (++calls === 2) { entered.resolve(); await release.promise }
  }
  try {
    const pending = subject.register(ioFixture([false])).then(value => { settled = true; return value })
    await entered.promise; assert.equal(settled, false)
    await assert.rejects(subject.register(), error => error.code === 'invalid-plan')
    await assert.rejects(subject.signIn(), error => error.code === 'invalid-plan')
    assert.equal(registrationPosts(subject).length, 0); assert.equal(subject.browserUrls.length, 0)
    release.resolve(); assert.equal(await pending, false)
  } finally { release.resolve(); McpOAuthRegistration.prototype.cancelRegistration = cancel }
  assert.equal(subject.oauth.hasActiveAttempt(server.id), false); assert.equal(await subject.register(), true)
})

for (const invalid of [{ redirectPort: 0 }, { redirectPort: 65536 }, { redirectPath: '/callback?unexpected=1' },
  { issuer: 'http://auth.controls.registration.fixture.invalid' }, { scopes: ['read', 'read'] }, { scopes: ['read write'] }, { clientName: '' }])
  test(`invalid explicit registration setting ${JSON.stringify(invalid)} sends nothing`, async t => {
    const subject = await fixture(t)
    await assert.rejects(subject.oauth.registerPublicClient(server.id, { ...subject.settings, ...invalid }, ioFixture([true]), signal()))
    assert.equal(subject.oauthRequests.length, 0); assert.equal(subject.requests.length, 0); assert.equal(subject.browserUrls.length, 0)
    assert.equal(subject.oauth.hasActiveAttempt(server.id), false)
  })

for (const field of ['issuer', 'redirectPath', 'scopes', 'clientName']) test(`known provider secret in registration ${field} never reaches discovery or approval`, async t => {
  const secret = 'fixture-registration-secret-provider-key', subject = await fixture(t, { secrets: [secret] }), io = ioFixture([true])
  const invalid = field === 'issuer' ? `${issuer}/${secret}` : field === 'redirectPath' ? `/callback/${secret}` : field === 'scopes' ? [secret] : secret
  await assert.rejects(subject.oauth.registerPublicClient(server.id, { ...subject.settings, [field]: invalid }, io, signal()))
  assert.equal(subject.oauthRequests.length, 0); assert.equal(io.approvals.length, 0); assert.equal(subject.browserUrls.length, 0)
})

for (const surface of ['application', 'interactive main', 'line main']) test(`${surface} explicitly enables human-only registration without creating provider or conversation`, async t => {
  const subject = await fixture(t), settings = subject.settings
  const io = ioFixture([true], ['server:remote', 'oauth-register', 'back'],
    [issuer, String(settings.redirectPort), settings.redirectPath, 'read', settings.clientName])
  const args = ['--no-workspace', '--provider', 'openai', '--model', 'gpt-5.1', '--no-skills', '--no-stream', '--prompt', '/mcp',
    ...(surface === 'line main' ? ['--no-tui'] : [])]
  const env = { VIVI_SESSION_DIR: subject.directory }, options = parseArguments(args, env)
  let manager
  const input = { io, args, env, options, secrets: [],
    providerFactory() { assert.fail('Registration management must not create a provider') },
    mcpManagerFactory(config) { manager = new McpManager({ ...config, httpFetch: subject.httpFetch }); return manager },
    mcpOAuth: { fetchFn: subject.fetchFn, openBrowser: subject.openBrowser, timeoutMs: 5000 } }
  const result = surface === 'application' ? await runApplication(input) : await main(args, env, { providerFactory: input.providerFactory,
    mcpManagerFactory: input.mcpManagerFactory, mcpOAuth: input.mcpOAuth, ...(surface === 'line main' ? { io } : { tuiIO: io }) })
  assert.equal(result, 0); assert(manager)
  assert.deepEqual(io.approvals.map(item => item.call.name), ['register_mcp_oauth_client'])
  assert.equal(registrationPosts(subject).length, 1); assert.equal(tokenPosts(subject).length, 0); assert.equal(subject.browserUrls.length, 0); assert.equal(subject.requests.length, 0)
  assert(io.protected.includes('fixture-registration-secret-management-token'))
  await publicSurfaces(subject, io); await noListener(settings.redirectPort)
})
