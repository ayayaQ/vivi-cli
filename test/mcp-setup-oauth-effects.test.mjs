// SPDX-License-Identifier: Apache-2.0
// Real local setup/OAuth/store logic, synthetic OAuth/MCP peers and wrapping keys only.
// No native keyring, live account, public network or user-machine access is used.
import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { McpConfigStore } from '../dist/mcp-config.js'
import { McpManager } from '../dist/mcp-manager.js'
import { McpOAuthControls } from '../dist/mcp-oauth-controls.js'
import { McpOAuthStore } from '../dist/mcp-oauth-store.js'
import { McpOAuthSession } from '../dist/mcp-oauth-session.js'
import { McpSetupService } from '../dist/mcp-setup.js'
import { CliHost } from '../dist/host.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { FileMcpOutcomeStore, reconcileMcpOutcomes } from '../dist/mcp-outcomes.js'
import { TerminalIO, sendChatTurn } from '../dist/terminal.js'

const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn)
const endpoint = 'https://mcp.effects.fixture.invalid/mcp', issuer = 'https://auth.effects.fixture.invalid'
const server = { transport: 'http', id: 'remote', label: 'Owned effects fixture', endpoint, protocol: '2026-07-28', allowLoopbackHttp: false }
const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`,
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true }
const signal = () => new AbortController().signal
const body = result => JSON.parse(result.content)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const kinds = receipts => receipts.map(receipt => receipt.kind)
const clean = value => assert(!JSON.stringify(value).includes('fixture-private-'), 'Credentials escaped boundary evidence')
async function port() {
  const listener = createServer()
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const result = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return result
}
function response(message, result) { return Response.json({ jsonrpc: '2.0', id: message.id,
  result: { ...result, resultType: 'complete', ttlMs: 0, cacheScope: 'private' } }) }
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-setup-oauth-effects-')), configurations = new McpConfigStore(directory)
  const secrets = [], keys = new Map(), oauthRequests = [], mcpRequests = [], browsers = [], receipts = [], settlements = [], approvals = []
  let available = true, now = 1000, manager
  const state = { current: true, closed: false }
  const register = values => { secrets.push(...values); manager?.addSecrets(values) }
  const keyStore = scope => ({ status: async () => ({ available, label: 'Owned fake wrapping key' }),
    load: async () => { if (!available) throw Error('fixture-private-locked-key'); return keys.get(scope) },
    save: async value => { if (!available) throw Error('fixture-private-locked-key'); keys.set(scope, value) } })
  const savedStore = new McpOAuthStore(directory, { keyStore, registerSecrets: register, transactionTimeoutMs: 5000 })
  const publicClient = { id: 'owned-effects-public-client', issuer, redirectPort: await port(), redirectPath: '/owned/callback', scopes: ['read'] }
  const tokens = { accessToken: 'fixture-private-access', refreshToken: 'fixture-private-refresh', expiresAt: options.expiresAt ?? 121000,
    issuer, resource: endpoint, clientId: publicClient.id, scopes: ['read'] }
  await configurations.save([server], (await configurations.load()).revision)
  if (options.seed !== 'none') {
    const saved = await savedStore.saveClient(server.id, endpoint, publicClient)
    if (options.seed !== 'client') await savedStore.saveTokens(server.id, endpoint, saved.revision, tokens)
  }
  const oauth = new McpOAuthControls({ savedStore, dynamicRegistration: 'explicit', redirectPort: publicClient.redirectPort,
    redirectPath: publicClient.redirectPath, now: () => now, timeoutMs: 5000, registerSecrets: register,
    fetchFn: async (input, init) => {
      const url = new URL(String(input)), method = init?.method ?? 'GET'
      assert(url.hostname.endsWith('.fixture.invalid'), 'Fixture attempted public networking')
      oauthRequests.push({ url: url.href, method, body: init?.body })
      if (options.oauthFetch) { const value = await options.oauthFetch(url, init); if (value) return value }
      if (url.href === endpoint) return new Response(null, { status: 405 })
      if (url.origin === new URL(endpoint).origin && url.pathname.includes('/.well-known/oauth-protected-resource'))
        return Response.json({ resource: endpoint, authorization_servers: [issuer], scopes_supported: ['read'] })
      if (url.origin === issuer && url.pathname.includes('/.well-known/')) return Response.json(metadata)
      if (url.href === metadata.registration_endpoint && method === 'POST') return Response.json({ ...JSON.parse(init.body),
        client_id: publicClient.id, registration_access_token: 'fixture-private-registration-management' }, { status: 201 })
      if (url.href === metadata.token_endpoint && method === 'POST') return Response.json({ access_token: 'fixture-private-issued-access',
        refresh_token: 'fixture-private-issued-refresh', token_type: 'Bearer', expires_in: 120, scope: 'read' })
      assert.fail(`Unexpected synthetic OAuth request ${method} ${url.href}`)
    }, openBrowser: async url => {
      browsers.push(url.origin + url.pathname)
      const callback = new URL(url.searchParams.get('redirect_uri'))
      callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('iss', issuer)
      callback.searchParams.set('code', 'fixture-private-authorization-code')
      const received = await fetch(callback); assert.equal(received.status, 200); clean(await received.text())
    } })
  manager = new McpManager({ store: configurations, env: {}, ...oauth.managerOptions(), httpFetch: async (input, init) => {
    assert.equal(String(input), endpoint)
    const message = JSON.parse(init.body); mcpRequests.push(message.method)
    if (options.httpFetch) { const value = await options.httpFetch(message, init); if (value) return value }
    if (message.method === 'server/discover') return response(message, { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } })
    if (message.method === 'tools/list') return response(message, { tools: [] })
    assert.fail(`Unexpected synthetic MCP method ${message.method}`)
  } })
  oauth.bind(manager); await manager.reload()
  const service = new McpSetupService(manager, oauth)
  const io = { get isClosed() { return state.closed }, write() {}, event() {}, result() {}, readLine: async () => undefined,
    approve: async () => assert.fail('Setup approvals must route through the execution context'), onCancel() { return () => {} } }
  const context = { io, assertCurrent() { if (!state.current) throw Error('Owned setup context is stale') },
    async approve(request, abort) { assert(!abort.aborted); approvals.push(structuredClone(request)); return options.approve ? options.approve(request) : true },
    async beforeEffect() { if (options.beforeEffect) await options.beforeEffect() },
    effect(receipt) { receipts.push(structuredClone(receipt)); clean(receipt); options.effect?.(receipt) },
    async settle(result) { settlements.push(structuredClone(result)); clean(result); if (options.settle) await options.settle(result) } }
  const subject = { directory, configurations, manager, oauth, savedStore, service, publicClient, tokens, secrets, oauthRequests, mcpRequests, browsers,
    receipts, settlements, approvals, state, context, keyStore, tick(value) { now += value }, lock() { available = false },
    call(action = 'login', id = 'owned-effects-call') { return { id, name: 'mcp_setup', arguments: { action, id: server.id, expectedRevision: manager.configurationRevision() } } },
    async run(action = 'login', abort = signal()) { return service.executeSetup(this.call(action), abort, context) } }
  t.after(async () => { await oauth.close(); await manager.close(); await savedStore.settle(); await rm(directory, { recursive: true, force: true }) })
  return subject
}

for (const failure of ['persistence', 'observer', 'cancellation']) test(`validated browser authorization remains known after ${failure} before credential save`, async t => {
  const abort = new AbortController()
  const subject = await fixture(t, { seed: 'client', effect(receipt) {
    if (receipt.kind !== 'authorization-granted') return
    if (failure === 'observer') throw Error('Owned observer failed after seeing the grant')
    if (failure === 'cancellation') abort.abort()
  } })
  if (failure === 'persistence') subject.savedStore.saveTokens = async () => { throw Error('fixture-private-save-failure') }
  const result = body(await subject.run('login', abort.signal))
  assert.equal(result.success, false); assert.equal(result.confirmedOutcome, true); assert.equal(result.setupIncomplete, true); assert.equal(result.doNotRetry, true)
  assert(kinds(result.knownEffects).includes('authorization-granted')); assert(!kinds(result.knownEffects).includes('saved-credentials-replaced'))
  assert.equal(subject.oauthRequests.filter(item => item.method === 'POST' && item.url === metadata.token_endpoint).length, 1)
  assert.equal(subject.mcpRequests.length, 0); assert.equal(subject.oauth.authorization(server).bearerToken, undefined)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens, undefined)
  clean([result, subject.receipts, subject.approvals])
})

test('agent setup records a saved grant after protocol failure and explicit Connect reuses it without browser replay', async t => {
  let rejected = true
  const subject = await fixture(t, { seed: 'client', httpFetch(message) {
    if (rejected && message.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: message.id,
      error: { code: -32601, message: 'fixture-private-unsupported-method' } })
  } })
  const failed = body(await subject.run('login'))
  assert.equal(failed.success, false); assert.equal(failed.confirmedOutcome, true)
  assert(kinds(failed.knownEffects).includes('authorization-granted'))
  assert(kinds(failed.knownEffects).includes('saved-credentials-replaced'))
  const local = await subject.service.listLocal(signal())
  assert.equal(local.servers[0].nextAction, 'Connect')
  assert.match(local.servers[0].message, /protocol handshake failed/)
  rejected = false
  const connected = body(await subject.run('connect'))
  assert.equal(connected.success, true)
  assert.equal(subject.browsers.length, 1)
  assert.equal(subject.oauthRequests.filter(item => item.method === 'POST' && item.url === metadata.token_endpoint).length, 1)
  assert.deepEqual(subject.approvals.map(item => item.call.name), ['mcp_setup', 'sign_in_mcp_server', 'mcp_setup', 'connect_saved_mcp_server'])
  assert.equal(subject.manager.statuses()[0].state, 'connected')
  clean([failed, connected, local])
})

for (const failure of ['client-save', 'observer', 'cancellation']) test(`validated public registration remains known after ${failure} without starting browser sign-in`, async t => {
  const abort = new AbortController()
  const subject = await fixture(t, { seed: 'none', effect(receipt) {
    if (receipt.kind !== 'public-client-registered') return
    if (failure === 'observer') throw Error('Owned registration observer failed')
    if (failure === 'cancellation') abort.abort()
  } })
  if (failure === 'client-save') subject.savedStore.saveClient = async () => { throw Error('fixture-private-client-save-failure') }
  const result = body(await subject.run('login', abort.signal))
  assert.equal(result.success, false); assert(kinds(result.knownEffects).includes('public-client-registered'))
  assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
  assert.equal(subject.browsers.length, 0); assert.equal(subject.mcpRequests.length, 0)
  assert(!kinds(result.knownEffects).includes('authorization-granted'))
  assert.equal(await subject.savedStore.load(server.id, endpoint), undefined)
})

for (const mutation of ['client', 'credentials']) test(`encrypted ${mutation} rename is observed before a failed directory fsync`, async t => {
  const subject = await fixture(t, { seed: 'client' }), seen = []
  subject.savedStore.syncDirectory = async () => { throw Error('fixture-private-directory-fsync-failure') }
  const lifecycle = { assertCurrent() {}, effect(receipt) { seen.push(receipt) } }
  const current = await subject.savedStore.load(server.id, endpoint)
  await assert.rejects(mutation === 'client'
    ? subject.savedStore.saveClient(server.id, endpoint, subject.publicClient, () => true, undefined, lifecycle)
    : subject.savedStore.saveTokens(server.id, endpoint, current.revision, subject.tokens, () => true, undefined, lifecycle), error => error.code === 'unavailable')
  assert.equal(seen.length, 1); assert.equal(seen[0].kind, mutation === 'client' ? 'saved-client-replaced' : 'saved-credentials-replaced')
  assert.equal(seen[0].durabilityUnverified, true)
  const restart = new McpOAuthStore(subject.directory, { keyStore: subject.keyStore })
  assert.equal((await restart.load(server.id, endpoint)).revision, seen[0].recordRevision)
  clean([seen, await readFile(join(subject.directory, 'mcp-oauth-remote.json'), 'utf8')])
})

test('an observer failure after native replacement still finishes its fsync and retains the observed boundary', async t => {
  const subject = await fixture(t, { seed: 'client' }), seen = []
  const original = subject.savedStore.syncDirectory.bind(subject.savedStore); let syncs = 0
  subject.savedStore.syncDirectory = async () => { syncs++; await original() }
  await assert.rejects(subject.savedStore.saveClient(server.id, endpoint, subject.publicClient, () => true, undefined,
    { assertCurrent() {}, effect(receipt) { seen.push(receipt); throw Error('Owned observer failure') } }), error => error.code === 'unavailable')
  assert.equal(syncs, 1); assert.equal(seen.length, 1)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).revision, seen[0].recordRevision)
})

for (const action of ['logout', 'remove']) test(`${action} retains known local forgetting when directory fsync fails`, async t => {
  const subject = await fixture(t)
  subject.savedStore.syncDirectory = async () => { throw Error('fixture-private-forget-fsync-failure') }
  const result = body(await subject.run(action))
  assert.equal(result.success, false); assert.equal(result.confirmedOutcome, true)
  assert(kinds(result.knownEffects).includes('saved-sign-in-forgotten')); assert.equal(result.durabilityUnverified, true)
  assert.equal((await subject.savedStore.load(server.id, endpoint))?.tokens, undefined)
  if (action === 'remove') assert.equal((await subject.configurations.load()).servers.length, 1, 'Configuration remains available to finish interrupted cleanup')
  assert.equal(subject.oauthRequests.length, 0); assert.equal(subject.mcpRequests.length, 0)
})

test('locked-key logout observes actual unlink before a failed directory fsync', async t => {
  const subject = await fixture(t); subject.lock()
  subject.savedStore.syncDirectory = async () => { throw Error('fixture-private-unlink-fsync-failure') }
  const result = body(await subject.run('logout'))
  assert(kinds(result.knownEffects).includes('saved-sign-in-forgotten')); assert.equal(result.success, false)
  assert(!(await readdir(subject.directory)).includes('mcp-oauth-remote.json'))
})

test('specific protected credential persistence drains before setup settlement and claim release on abort', async t => {
  const subject = await fixture(t, { seed: 'client' }), entered = deferred(), release = deferred(), abort = new AbortController()
  t.after(() => release.resolve())
  const original = subject.savedStore.syncDirectory.bind(subject.savedStore); let syncs = 0
  subject.savedStore.syncDirectory = async () => { syncs++; if (syncs === 2) { entered.resolve(); await release.promise } await original() }
  let finished = false
  const work = subject.run('login', abort.signal).then(value => { finished = true; return value })
  await entered.promise
  assert(kinds(subject.receipts).includes('saved-credentials-replaced'))
  abort.abort(); await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(finished, false); assert.equal(subject.settlements.length, 0); assert.equal(subject.oauth.hasActiveAttempt(server.id), true)
  release.resolve(); const result = body(await work)
  assert.equal(result.success, false); assert(kinds(result.knownEffects).includes('authorization-granted'))
  assert(kinds(result.knownEffects).includes('saved-credentials-replaced')); assert.equal(subject.settlements.length, 1)
  assert.equal(subject.oauth.hasActiveAttempt(server.id), false); assert.equal(subject.mcpRequests.length, 0)
})

test('refresh-intent cancellation is known and never starts a token POST or claims refreshed credentials', async t => {
  const abort = new AbortController()
  const subject = await fixture(t, { expiresAt: 500, effect(receipt) { if (receipt.kind === 'refresh-intent-replaced') abort.abort() } })
  const result = body(await subject.run('connect', abort.signal))
  assert.equal(result.success, false); assert.deepEqual(kinds(result.knownEffects), ['refresh-intent-replaced'])
  assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 0); assert.equal(subject.mcpRequests.length, 0)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens, undefined)
})

for (const failure of ['final-guard', 'http-denial']) test(`successful refresh remains known after ${failure} prevents a usable MCP connection`, async t => {
  let subject
  subject = await fixture(t, { expiresAt: 500,
    effect(receipt) { if (failure === 'final-guard' && receipt.kind === 'saved-credentials-replaced') subject.state.current = false },
    httpFetch(message) { if (failure === 'http-denial' && message.method === 'server/discover') return new Response('fixture-private-denial', { status: 401 }) } })
  const result = body(await subject.run('connect'))
  assert.equal(result.success, false); assert.equal(result.setupIncomplete, true)
  assert(kinds(result.knownEffects).includes('authorization-refreshed')); assert(kinds(result.knownEffects).includes('saved-credentials-replaced'))
  assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1); assert.equal(subject.browsers.length, 0)
  assert.equal(subject.oauth.authorization(server).bearerToken, undefined)
  if (failure === 'final-guard') assert.equal(subject.mcpRequests.length, 0)
  else { assert(kinds(result.knownEffects).includes('saved-sign-in-forgotten')); assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens, undefined) }
})

test('scoped reconciliation preserves actual affected IDs rather than relabeling every receipt as the primary target', async t => {
  const subject = await fixture(t)
  await subject.savedStore.saveClient('stale', 'https://stale.effects.fixture.invalid/mcp', subject.publicClient)
  const result = body(await subject.run('connect'))
  const forgotten = result.knownEffects.find(receipt => receipt.kind === 'saved-sign-in-forgotten')
  assert.equal(forgotten.serverId, 'stale'); assert.equal(forgotten.revision, subject.manager.configurationRevision())
  assert.equal(result.success, true); assert.equal(await subject.savedStore.load('stale', 'https://stale.effects.fixture.invalid/mcp'), undefined)
})

test('stale CAS, pre-replacement cancellation and no-op removal cannot invent mutation receipts', async t => {
  const subject = await fixture(t), seen = [], lifecycle = { assertCurrent() {}, effect(receipt) { seen.push(receipt) } }
  await assert.rejects(subject.savedStore.saveTokens(server.id, endpoint, '00000000-0000-4000-8000-000000000000', subject.tokens, () => true, undefined, lifecycle), error => error.code === 'changed')
  await assert.rejects(subject.savedStore.saveClient(server.id, endpoint, subject.publicClient, () => false, undefined, lifecycle), error => error.code === 'changed')
  await subject.savedStore.remove('absent', () => true, lifecycle)
  assert.deepEqual(seen, [])
})

test('local list projects expired authorization without revoking its token, rotating its epoch or canceling work', async t => {
  const subject = await fixture(t), io = { ...subject.context.io, approve: async () => true }
  assert.equal(await subject.oauth.connectSaved(server.id, io, signal()), true)
  const session = subject.oauth.registrations.get(server.id).session
  const before = { token: session.token, revision: session.revision, state: session.state }
  subject.tick(121000)
  const calls = subject.oauthRequests.length, mcp = subject.mcpRequests.length
  session.authorizationSnapshot = () => assert.fail('Inert list must not expire authorization')
  const result = await subject.service.listLocal(signal())
  assert.equal(result.servers[0].signInState, 'needs-sign-in')
  assert.deepEqual({ token: session.token, revision: session.revision, state: session.state }, before)
  assert.equal(subject.oauthRequests.length, calls); assert.equal(subject.mcpRequests.length, mcp)
  delete session.authorizationSnapshot
})

test('peekStatus does not cancel an active stale-configuration sign-in flow or change its epoch', async t => {
  let current = true
  const session = new McpOAuthSession({ endpoint, configRevision: 'owned-peek-revision', client: { id: 'owned-peek-client', issuer, redirectPort: 0 }, scopes: ['read'],
    configurationIsCurrent: () => current, registerSecrets() {}, openBrowser: async () => assert.fail('Prepared flow must not open a browser'),
    fetchFn: async input => new URL(String(input)).origin === issuer ? Response.json(metadata)
      : Response.json({ resource: endpoint, authorization_servers: [issuer] }) })
  t.after(() => session.disconnect())
  await session.prepareSignIn()
  const flow = session.flow, revision = session.revision, state = session.state
  current = false
  assert.equal(session.peekStatus().state, 'cancelled')
  assert.equal(session.flow, flow); assert.equal(flow.abort.signal.aborted, false); assert.equal(session.revision, revision); assert.equal(session.state, state)
})

for (const action of ['login', 'connect']) test(`${action} preserves all known receipts when final settlement fails`, async t => {
  const subject = await fixture(t, { seed: action === 'login' ? 'client' : undefined, expiresAt: 500,
    settle: async () => { throw Error('Owned settlement checkpoint failed') } })
  await assert.rejects(subject.run(action), /checkpoint failed/)
  assert(kinds(subject.receipts).includes(action === 'login' ? 'authorization-granted' : 'authorization-refreshed'))
  assert(kinds(subject.receipts).includes('saved-credentials-replaced')); assert(kinds(subject.receipts).includes('connected'))
  assert.equal(subject.settlements.length, 1); assert.equal(body(subject.settlements[0]).success, true)
})

async function hostFixture(t, input = {}) {
  const subject = await fixture(t, { seed: 'client' }), sessionDirectory = join(subject.directory, 'sessions')
  const store = new FileSessionStore(sessionDirectory, subject.secrets), outcomes = new FileMcpOutcomeStore(sessionDirectory, subject.secrets)
  let failCheckpoint = input.failCheckpoint, round = 0
  const originalSave = store.save.bind(store)
  store.save = async (session, options) => {
    if (failCheckpoint && session.history.some(message => message.kind === 'tool_result' && message.name === 'mcp_setup'))
      throw Error('Owned terminal checkpoint failed')
    return originalSave(session, options)
  }
  const outcomeStore = { load: id => outcomes.load(id), addSecrets: values => outcomes.addSecrets(values), drain: () => outcomes.drain(),
    async save(id, rows, options) {
      if (input.failSettlement && rows.some(row => row.state === 'settled')) throw Error('Owned outcome settlement failed')
      return outcomes.save(id, rows, options)
    } }
  const streamIn = new PassThrough(), streamOut = new PassThrough(), io = new TerminalIO({ input: streamIn, output: streamOut, tui: false, stream: false, secrets: subject.secrets })
  Object.defineProperty(io, 'canAutoReview', { get() { return !this.isClosed } })
  const call = subject.call('login', 'owned-host-effects-call')
  const host = new CliHost({ session: newSession({ provider: 'openai', model: 'owned-effects-model' }), store, mcp: subject.manager,
    mcpSetup: { service: subject.service, io }, mcpOutcomes: outcomeStore, secrets: subject.secrets, enablePublicUrl: false,
    approve: async () => true, provider: { async generate() { round++; return round === 1
      ? { content: 'Run the owned fake OAuth setup', toolCalls: [call] } : { content: 'Owned fixture finished', toolCalls: [] } } } })
  t.after(async () => { failCheckpoint = false; io.close(); streamIn.destroy(); streamOut.destroy(); await host.shutdown() })
  return { ...subject, host, io, call, outcomes, async run() { return sendChatTurn(host, io, 'Sign in using the owned fake OAuth peer') },
    allowCheckpoint() { failCheckpoint = false } }
}

for (const failSettlement of [false, true]) test(`real OAuth boundary evidence survives failed terminal checkpoint with ${failSettlement ? 'failed' : 'successful'} outcome settlement`, async t => {
  const subject = await hostFixture(t, { failCheckpoint: true, failSettlement })
  await assert.rejects(subject.run(), /checkpoint failed/)
  await subject.host.drainMcp()
  const rows = await subject.outcomes.load(subject.host.session.id)
  assert.equal(rows.length, 1); assert.equal(rows[0].state, failSettlement ? 'intent' : 'settled')
  if (!failSettlement) {
    const result = body(rows[0].result)
    assert(kinds(result.knownEffects).includes('authorization-granted')); assert(kinds(result.knownEffects).includes('saved-credentials-replaced'))
    const interrupted = [{ kind: 'assistant', content: 'Owned interrupted setup', toolCalls: [subject.call] },
      { kind: 'tool_result', callId: subject.call.id, name: 'mcp_setup', content: 'Generic interrupted result', isError: true }]
    const recovered = reconcileMcpOutcomes(interrupted, subject.host.session.id, rows)
    assert(kinds(body(recovered[1]).knownEffects).includes('authorization-granted'))
  }
  clean([rows, subject.host.session.history])
  assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
  subject.allowCheckpoint()
})

test('delayed denial-driven invalidation is tracked from entry until its credential clearing receipt settles', async t => {
  const subject = await fixture(t, { expiresAt: 500, httpFetch(message) {
    if (message.method === 'server/discover') return new Response('fixture-private-denial', { status: 401 })
  } }), entered = deferred(), release = deferred()
  t.after(() => release.resolve())
  const original = subject.savedStore.settle.bind(subject.savedStore); let held = false
  subject.savedStore.settle = async () => { if (!held) { held = true; entered.resolve(); await release.promise } await original() }
  let finished = false
  const work = subject.run('connect').then(value => { finished = true; return value })
  await entered.promise; await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(finished, false); assert.equal(subject.settlements.length, 0); assert.equal(subject.oauth.hasActiveAttempt(server.id), true)
  assert(kinds(subject.receipts).includes('authorization-refreshed')); assert(!kinds(subject.receipts).includes('saved-sign-in-forgotten'))
  release.resolve(); const result = body(await work)
  assert.equal(result.success, false)
  assert(kinds(result.knownEffects).includes('authorization-refreshed')); assert(kinds(result.knownEffects).includes('saved-credentials-replaced'))
  assert(kinds(result.knownEffects).includes('saved-sign-in-forgotten')); assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens, undefined)
  assert.equal(subject.oauth.hasActiveAttempt(server.id), false)
})

test('a native replacement boundary delivered after abort remains owned until final setup settlement', async t => {
  const subject = await fixture(t, { seed: 'client' }), entered = deferred(), release = deferred(), abort = new AbortController()
  t.after(() => release.resolve())
  const original = subject.savedStore.replaced.bind(subject.savedStore); let replacements = 0
  // The fake native completion gate is after actual rename, before its trusted notification.
  subject.savedStore.replaced = async (...args) => { replacements++; if (replacements === 2) { entered.resolve(); await release.promise } return original(...args) }
  let finished = false
  const work = subject.run('login', abort.signal).then(value => { finished = true; return value })
  await entered.promise; assert(!kinds(subject.receipts).includes('saved-credentials-replaced'))
  abort.abort(); await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(finished, false); assert.equal(subject.settlements.length, 0)
  release.resolve(); const result = body(await work)
  assert.equal(result.success, false); assert(kinds(result.knownEffects).includes('saved-credentials-replaced'))
  assert.equal(subject.mcpRequests.length, 0); assert.equal(subject.oauth.hasActiveAttempt(server.id), false)
})

test('real host waits for a late native credential receipt before abort retirement and failed terminal checkpoint', async t => {
  const subject = await hostFixture(t, { failCheckpoint: true }), entered = deferred(), release = deferred()
  t.after(() => release.resolve())
  const original = subject.savedStore.replaced.bind(subject.savedStore); let replacements = 0
  subject.savedStore.replaced = async (...args) => { replacements++; if (replacements === 2) { entered.resolve(); await release.promise } return original(...args) }
  let finished = false
  const work = subject.run().then(value => { finished = true; return value }, error => { finished = true; return error })
  await entered.promise; subject.host.cancel(); await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(finished, false, 'Host must not retire the setup before native receipt delivery')
  release.resolve(); const result = await work
  assert(result instanceof Error || result.status === 'cancelled' || result.status === 'error')
  await subject.host.drainMcp()
  const rows = await subject.outcomes.load(subject.host.session.id)
  assert.equal(rows.length, 1); assert.equal(rows[0].state, 'settled')
  const recovered = body(rows[0].result)
  assert.equal(recovered.success, false); assert(kinds(recovered.knownEffects).includes('authorization-granted'))
  assert(kinds(recovered.knownEffects).includes('saved-credentials-replaced')); assert.equal(subject.mcpRequests.length, 0)
  clean([rows, subject.host.session.history]); subject.allowCheckpoint()
})

for (const action of ['login', 'connect']) test(`${action} cannot adopt bearer authority after the credential boundary observer invalidates its owner`, async t => {
  let subject, adoptions = 0
  subject = await fixture(t, { seed: action === 'login' ? 'client' : undefined, expiresAt: 500, effect(receipt) {
    if (receipt.kind !== 'saved-credentials-replaced') return
    subject.state.current = false
    const session = subject.oauth.registrations.get(server.id).session
    const original = session.installCredentials.bind(session)
    session.installCredentials = credentials => { adoptions++; original(credentials) }
  } })
  const result = body(await subject.run(action))
  assert.equal(result.success, false); assert.equal(adoptions, 0)
  assert(kinds(result.knownEffects).includes('saved-credentials-replaced'))
  assert.equal(subject.mcpRequests.length, 0); assert.equal(subject.oauth.authorization(server).bearerToken, undefined)
})

for (const invalidation of ['owner', 'io']) test(`browser sign-in cannot adopt bearer authority when ${invalidation} changes during awaited callback cleanup`, async t => {
  let subject, adoptions = 0
  subject = await fixture(t, { seed: 'client', effect(receipt) {
    if (receipt.kind !== 'saved-credentials-replaced') return
    const session = subject.oauth.registrations.get(server.id).session
    const cleanup = session.cleanup.bind(session), install = session.installCredentials.bind(session)
    session.cleanup = async flow => {
      await Promise.resolve()
      if (invalidation === 'owner') subject.state.current = false; else subject.state.closed = true
      await cleanup(flow)
    }
    session.installCredentials = credentials => { adoptions++; install(credentials) }
  } })
  const result = body(await subject.run('login'))
  assert.equal(adoptions, 0); assert.equal(result.success, false)
  assert(kinds(result.knownEffects).includes('authorization-granted')); assert(kinds(result.knownEffects).includes('saved-credentials-replaced'))
  assert.equal(subject.mcpRequests.length, 0); assert.equal(subject.oauth.authorization(server).bearerToken, undefined)
})

for (const action of ['login', 'connect']) test(`${action} releases only initial owner checks and retains authorization for a later approved turn`, async t => {
  const subject = await fixture(t, { seed: action === 'login' ? 'client' : undefined, expiresAt: 500 })
  const result = body(await subject.run(action))
  assert.equal(result.success, true); assert.equal(subject.oauth.hasActiveAttempt(server.id), false)
  const before = subject.oauth.authorization(server), requests = subject.oauthRequests.length
  assert.equal(before.bearerToken, 'fixture-private-issued-access')
  subject.state.current = false; subject.state.closed = true
  const next = subject.oauth.authorization(server)
  assert.equal(next.bearerToken, before.bearerToken); assert.equal(next.revision, before.revision)
  await subject.manager.refresh(server.id, ['tools'], signal())
  assert.equal(subject.manager.statuses()[0].state, 'connected'); assert.equal(subject.oauthRequests.length, requests)
})

for (const outcome of ['cleanup-invalidation', 'next-turn']) test(`session-only guided sign-in ${outcome} retains the same initial-owner phase boundary`, async t => {
  let subject, adoptions = 0
  subject = await fixture(t, { seed: 'none', effect(receipt) {
    if (outcome !== 'cleanup-invalidation' || receipt.kind !== 'authorization-granted') return
    const session = subject.oauth.registrations.get(server.id).session
    const cleanup = session.cleanup.bind(session), install = session.installCredentials.bind(session)
    session.cleanup = async flow => { await Promise.resolve(); subject.state.current = false; await cleanup(flow) }
    session.installCredentials = credentials => { adoptions++; install(credentials) }
  } })
  const io = { ...subject.context.io, get isClosed() { return subject.state.closed }, approve: async () => true }
  const lifecycle = { assertCurrent: () => subject.context.assertCurrent(), effect: receipt => subject.context.effect(receipt) }
  const work = subject.oauth.guidedSignInAndConnect(server.id, io, signal(), 'session-only', lifecycle)
  if (outcome === 'cleanup-invalidation') {
    await assert.rejects(work, error => error.code === 'cancelled')
    assert.equal(adoptions, 0); assert.equal(subject.mcpRequests.length, 0); assert.equal(subject.oauth.authorization(server).bearerToken, undefined)
  } else {
    assert.equal(await work, true)
    const before = subject.oauth.authorization(server)
    subject.state.current = false; subject.state.closed = true
    assert.deepEqual(subject.oauth.authorization(server), before)
    await subject.manager.refresh(server.id, ['tools'], signal())
    assert.equal(subject.manager.statuses()[0].state, 'connected')
  }
  assert(kinds(subject.receipts).includes('authorization-granted'))
  assert(!kinds(subject.receipts).some(kind => kind.startsWith('saved-')))
  assert.equal(await subject.savedStore.load(server.id, endpoint), undefined)
})

for (const outcome of ['owner-cleanup-invalidation', 'io-cleanup-invalidation', 'next-turn']) test(`legacy public signInAndConnect ${outcome} releases only its initial-owner guard`, async t => {
  let subject, adoptions = 0
  subject = await fixture(t, { seed: 'client', effect(receipt) {
    if (outcome === 'next-turn' || receipt.kind !== 'authorization-granted') return
    const session = subject.oauth.registrations.get(server.id).session
    const cleanup = session.cleanup.bind(session), install = session.installCredentials.bind(session)
    session.cleanup = async flow => {
      await Promise.resolve()
      if (outcome === 'owner-cleanup-invalidation') subject.state.current = false; else subject.state.closed = true
      await cleanup(flow)
    }
    session.installCredentials = credentials => { adoptions++; install(credentials) }
  } })
  await subject.oauth.configureClient(server.id, subject.publicClient)
  const io = { ...subject.context.io, get isClosed() { return subject.state.closed },
    approve: (request, abort) => subject.context.approve(request, abort) }
  const lifecycle = { assertCurrent: () => subject.context.assertCurrent(), effect: receipt => subject.context.effect(receipt) }
  const work = subject.oauth.signInAndConnect(server.id, io, signal(), lifecycle)
  if (outcome === 'next-turn') {
    assert.equal(await work, true)
    assert.deepEqual(subject.approvals.map(request => request.call.name), ['sign_in_mcp_server', 'connect_mcp_server'])
    const before = subject.oauth.authorization(server)
    assert.equal(before.bearerToken, 'fixture-private-issued-access'); assert.equal(subject.oauth.hasActiveAttempt(server.id), false)
    subject.state.current = false; subject.state.closed = true
    assert.deepEqual(subject.oauth.authorization(server), before)
    await subject.manager.refresh(server.id, ['tools'], signal())
    assert.equal(subject.manager.statuses()[0].state, 'connected')
  } else {
    await assert.rejects(work, error => error.code === 'cancelled')
    assert.equal(adoptions, 0); assert.equal(subject.mcpRequests.length, 0); assert.equal(subject.oauth.authorization(server).bearerToken, undefined)
  }
  assert(kinds(subject.receipts).includes('authorization-granted'))
  assert.equal(subject.oauthRequests.filter(request => request.method === 'POST').length, 1)
  assert.equal(subject.browsers.length, 1)
  clean(subject.receipts)
})
