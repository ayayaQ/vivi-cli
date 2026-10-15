// SPDX-License-Identifier: Apache-2.0
// Owned offline host-integration fixtures. No native keyring or authenticated service is used.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { McpConfigStore } from '../dist/mcp-config.js'
import { McpManager } from '../dist/mcp-manager.js'
import { McpOAuthControls } from '../dist/mcp-oauth-controls.js'
import { McpOAuthStore } from '../dist/mcp-oauth-store.js'
import { McpSetupService } from '../dist/mcp-setup.js'
import { manageMcp } from '../dist/mcp-controls.js'

const endpoint = 'https://mcp.saved.fixture.invalid/mcp', issuer = 'https://auth.saved.fixture.invalid'
const server = { transport: 'http', id: 'remote', label: 'Owned saved-auth fixture', endpoint,
  protocol: '2026-07-28', allowLoopbackHttp: false }
const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
  response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
  authorization_response_iss_parameter_supported: true }
const signal = () => new AbortController().signal
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const safeError = error => ['cancelled', 'needs-sign-in', 'authorization-failed', 'unavailable'].includes(error.code)
const clean = value => assert(!JSON.stringify(value).includes('fixture-private-'), 'Saved OAuth credentials escaped a public surface')
function ioFixture(answers = [true], choices = []) {
  return { approvals: [], selections: [], output: '', closed: false,
    get isClosed() { return this.closed },
    write(value) { this.output += value }, addSecrets() {}, event() {}, result() {},
    async approve(request, abort) { assert(!abort.aborted); this.approvals.push(structuredClone(request)); return answers.shift() ?? false },
    async choose(title, items, initial) { this.selections.push({ title, items: structuredClone(items), initial }); return choices.shift() },
    async readLine() { return undefined }, async askText() { return undefined },
    onCancel() { return () => {} }, close() { this.closed = true }
  }
}
async function availablePort() {
  const listener = createServer()
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}
function response(message, result, protocol = server.protocol) {
  return Response.json({ jsonrpc: '2.0', id: message.id, result: protocol === 'legacy' ? result : { ...result, resultType: 'complete', ttlMs: 0, cacheScope: 'private' } })
}
async function bounded(promise, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), 10_000) })]) }
  finally { clearTimeout(timer) }
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-saved-controls-')), configurations = new McpConfigStore(directory)
  const keys = new Map(), keyCalls = [], secrets = [], hosts = [], cleanups = []
  let available = true, now = 1000, exchanges = 0, denial = 0
  const keyStore = scope => ({
    status: async () => { keyCalls.push('status'); return { available, label: 'Fixture keyring' } },
    load: async () => { keyCalls.push('load'); if (!available) throw Error('fixture-private-locked-helper'); return keys.get(scope) },
    save: async value => { keyCalls.push('save'); if (!available) throw Error('fixture-private-locked-helper'); keys.set(scope, value) }
  })
  const register = values => secrets.push(...values)
  const savedStore = new McpOAuthStore(directory, { keyStore, registerSecrets: register })
  const publicClient = { id: 'owned-saved-public-client', issuer, redirectPort: await availablePort(), redirectPath: '/fixture/callback', scopes: ['read'],
    ...(options.resource ? { resource: options.resource } : {}) }
  const resource = publicClient.resource ?? endpoint
  const initial = { accessToken: 'fixture-private-saved-access', refreshToken: 'fixture-private-saved-refresh',
    expiresAt: options.expiresAt ?? 121_000, issuer, resource, clientId: publicClient.id, scopes: ['read'] }
  t.after(async () => {
    for (const cleanup of [...cleanups].reverse()) cleanup()
    for (const owner of [...hosts].reverse()) await owner.close()
    await savedStore.settle(); await rm(directory, { recursive: true, force: true })
  })
  const configured = { ...server, protocol: options.protocol ?? server.protocol }
  await configurations.save([configured], (await configurations.load()).revision)
  async function seed(id = server.id, serverEndpoint = endpoint, client = publicClient, tokens = initial) {
    const record = await savedStore.saveClient(id, serverEndpoint, client)
    return tokens ? savedStore.saveTokens(id, serverEndpoint, record.revision, tokens) : record
  }
  if (options.seed !== false) await seed()
  function host() {
    const oauthRequests = [], requests = [], browsers = []
    let manager
    const oauth = new McpOAuthControls({ dynamicRegistration: 'disabled', savedStore, now: () => now, timeoutMs: 5000,
      registerSecrets: values => { register(values); manager.addSecrets(values) },
      fetchFn: async (input, init) => {
        const url = new URL(String(input)), method = init?.method ?? 'GET'
        assert(url.hostname.endsWith('.fixture.invalid'), 'Fixture attempted external networking')
        const item = { url: url.href, method, body: init?.body, signal: init?.signal }
        oauthRequests.push(item)
        if (options.oauthFetch) { const value = await options.oauthFetch(item); if (value) return value }
        if (url.href === endpoint) return new Response(null, { status: 405 })
        if (url.origin === new URL(endpoint).origin && url.pathname.includes('/.well-known/oauth-protected-resource')) {
          if (options.resource === new URL(endpoint).origin + '/' && url.pathname !== '/.well-known/oauth-protected-resource')
            return new Response(null, { status: 404 })
          return Response.json({ resource, authorization_servers: [issuer], scopes_supported: ['read'] })
        }
        if (url.origin === issuer && url.pathname.includes('/.well-known/')) return Response.json(metadata)
        if (url.href === metadata.token_endpoint && method === 'POST') {
          exchanges++
          return Response.json({ access_token: `fixture-private-refreshed-access-${exchanges}`, refresh_token: `fixture-private-refreshed-token-${exchanges}`,
            token_type: 'Bearer', expires_in: 120, scope: 'read' })
        }
        assert.fail(`Unexpected synthetic OAuth request ${method} ${url.href}`)
      },
      openBrowser: async url => {
        browsers.push(new URL(url))
        const callback = new URL(url.searchParams.get('redirect_uri'))
        callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('iss', issuer)
        callback.searchParams.set('code', 'fixture-private-code')
        const received = await fetch(callback); assert.equal(received.status, 200); clean(await received.text())
      }
    })
    manager = new McpManager({ store: configurations, env: {}, ...oauth.managerOptions(), httpFetch: async (input, init) => {
      assert.equal(String(input), endpoint)
      const message = JSON.parse(init.body), headers = new Headers(init.headers)
      requests.push({ message, headers })
      if (options.httpFetch) { const value = await options.httpFetch(message, init); if (value) return value }
      if (message.method === 'initialize') return response(message, { protocolVersion: '2025-11-25', capabilities: { tools: {} },
        serverInfo: { name: 'Owned saved-auth fixture', version: '1' } }, configured.protocol)
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (message.method === 'server/discover') return response(message, { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } })
      if (message.method === 'tools/list') return response(message, { tools: [{ name: 'owned-saved-echo', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] }, configured.protocol)
      if (message.method === 'tools/call') return denial ? new Response('fixture-private-service-error', { status: denial })
        : response(message, { content: [{ type: 'text', text: 'Owned offline result' }] })
      assert.fail(`Unexpected synthetic MCP method ${message.method}`)
    } })
    oauth.bind(manager)
    const created = { oauth, manager, service: new McpSetupService(manager, oauth), oauthRequests, requests, browsers,
      async connect(io = ioFixture(), abort = signal()) { return oauth.connectSaved(server.id, io, abort) },
      async operation() {
        const [snapshot] = await manager.captureCatalogs(signal()), entry = snapshot.categories.tools.entries[0]
        return manager.prepareOperation(snapshot, entry, 'tools', { id: 'owned-saved-call', name: entry.alias, arguments: {} })
      },
      async close() { await oauth.close(); await manager.close() }
    }
    hosts.push(created); return created
  }
  return { directory, configurations, savedStore, initial, publicClient, host, seed, keyCalls, secrets, cleanup(callback) { cleanups.push(callback) },
    tick(value) { now += value }, lock() { available = false }, unlock() { available = true }, reject(status) { denial = status } }
}

test('saved restart remains inert until Connect, then restores without browser or OAuth POST under fresh approval', async t => {
  const subject = await fixture(t), owner = subject.host(), io = ioFixture()
  await owner.manager.reload(); subject.keyCalls.length = 0
  assert.equal(owner.service.list().servers[0].state, 'disabled')
  assert.deepEqual(subject.keyCalls, []); assert.deepEqual(owner.oauthRequests, []); assert.deepEqual(owner.requests, [])
  assert.equal(await owner.service.connect(server.id, io, signal()), true)
  assert.deepEqual(io.approvals.map(item => item.call.name), ['connect_saved_mcp_server'])
  assert.match(io.approvals[0].description, /selected model\/provider context/)
  assert.equal(owner.oauthRequests.length, 0); assert.equal(owner.browsers.length, 0)
  assert(owner.requests.every(item => item.headers.get('authorization') === `Bearer ${subject.initial.accessToken}`))
  clean([io.approvals, io.output, owner.service.list(), owner.manager.statuses(), await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8')])
})

test('denied expired restart performs read-only discovery but neither refresh nor MCP request and preserves the saved record', async t => {
  const subject = await fixture(t, { expiresAt: 500 }), owner = subject.host(), before = await subject.savedStore.load(server.id, endpoint)
  assert.equal(await owner.connect(ioFixture([false])), false)
  assert.equal(owner.oauthRequests.filter(item => item.method !== 'GET').length, 0)
  assert.equal(owner.requests.length, 0); assert.equal(owner.browsers.length, 0)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).revision, before.revision)
})

test('a token entering the refresh window during approval cannot refresh under a no-refresh disclosure', async t => {
  const subject = await fixture(t), owner = subject.host(), io = ioFixture(), before = await subject.savedStore.load(server.id, endpoint)
  io.approve = async request => {
    io.approvals.push(request)
    assert.match(request.description, /do not need a refresh request/)
    subject.tick(121_000)
    return true
  }
  let connected = false
  try { connected = await owner.connect(io) }
  catch (error) { assert(['invalid-plan', 'changed', 'cancelled', 'needs-sign-in', 'authorization-failed'].includes(error.code)) }
  assert.equal(connected, false)
  assert.equal(owner.oauthRequests.filter(item => item.method === 'POST').length, 0)
  assert.equal(owner.requests.length, 0)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).revision, before.revision)
})

test('approved expired root-resource restart rotates durably before token-bound catalog requests', async t => {
  const root = new URL(endpoint).origin + '/', subject = await fixture(t, { resource: root, expiresAt: 500 }), owner = subject.host(), io = ioFixture()
  const approve = io.approve.bind(io)
  io.approve = async (...args) => {
    assert.equal(owner.oauthRequests.filter(item => item.method === 'POST').length, 0)
    assert(args[0].description.includes(`Token endpoint: "${metadata.token_endpoint}"`))
    return approve(...args)
  }
  assert.equal(await owner.connect(io), true)
  const posts = owner.oauthRequests.filter(item => item.method === 'POST')
  assert.equal(posts.length, 1); const body = new URLSearchParams(posts[0].body)
  assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.get('resource'), root)
  assert.equal(body.get('refresh_token'), subject.initial.refreshToken)
  const saved = await subject.savedStore.load(server.id, endpoint)
  assert.equal(saved.tokens.refreshToken, 'fixture-private-refreshed-token-1')
  assert(owner.requests.every(item => item.headers.get('authorization') === `Bearer ${saved.tokens.accessToken}`))
  assert.equal(owner.browsers.length, 0)
  await owner.manager.disconnect(server.id); subject.tick(121_000)
  assert.equal(await owner.connect(), true)
  const next = owner.oauthRequests.filter(item => item.method === 'POST').at(-1)
  assert.equal(new URLSearchParams(next.body).get('refresh_token'), saved.tokens.refreshToken)
})

test('disconnect and app close retain saved sign-in for a new host but never retain the old catalog', async t => {
  const subject = await fixture(t), owner = subject.host()
  assert.equal(await owner.connect(), true); const old = await owner.operation()
  await owner.manager.disconnect(server.id)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens.accessToken, subject.initial.accessToken)
  const outcome = await owner.manager.invoke(old, signal(), () => {})
  assert.equal(owner.requests.filter(item => item.message.method === 'tools/call').length, 0); clean(outcome)
  await owner.close()
  const restarted = subject.host(); assert.equal(await restarted.connect(), true)
  assert.equal(restarted.browsers.length, 0); assert.equal(restarted.oauthRequests.length, 0)
})

for (const status of [401, 403]) test(`HTTP ${status} forgets current saved credentials once without refresh or operation replay`, async t => {
  const subject = await fixture(t), owner = subject.host()
  assert.equal(await owner.connect(), true); const operation = await owner.operation(); subject.reject(status)
  const result = await owner.manager.invoke(operation, signal(), () => {})
  assert.equal(owner.requests.filter(item => item.message.method === 'tools/call').length, 1)
  assert.equal(owner.oauthRequests.length, 0); assert.equal(owner.browsers.length, 0); clean(result)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens, undefined)
  await owner.close(); const restarted = subject.host()
  assert.equal(await restarted.connect(ioFixture([true])), undefined)
  assert.equal(restarted.requests.length, 0); assert.equal(restarted.oauthRequests.length, 0)
})

test('fresh-process logout forgets credentials while preserving public client settings and performs no network', async t => {
  const subject = await fixture(t), owner = subject.host()
  await owner.oauth.logout(server.id)
  const saved = await subject.savedStore.load(server.id, endpoint)
  assert.deepEqual(saved.client, subject.publicClient); assert.equal(saved.tokens, undefined)
  assert.equal(owner.requests.length, 0); assert.equal(owner.oauthRequests.length, 0); assert.equal(owner.browsers.length, 0)
})

test('explicit fresh-process logout can forget an unreadable record while the synthetic keyring is locked', async t => {
  const subject = await fixture(t), owner = subject.host(); subject.lock()
  await owner.service.logout(server.id)
  assert(!(await readdir(subject.directory)).includes('mcp-oauth-remote.json'))
  assert.equal(owner.requests.length, 0); assert.equal(owner.oauthRequests.length, 0)
  subject.unlock(); assert.equal(await subject.savedStore.load(server.id, endpoint), undefined)
})

test('late old-epoch HTTP denial cannot erase a concurrently replaced saved record', async t => {
  const entered = deferred(), release = deferred()
  const subject = await fixture(t, { httpFetch: async message => {
    if (message.method === 'tools/call') { entered.resolve(); await release.promise; return new Response(null, { status: 401 }) }
  } }), owner = subject.host()
  subject.cleanup(() => release.resolve())
  assert.equal(await owner.connect(), true)
  const running = owner.manager.invoke(await owner.operation(), signal(), () => {})
  await bounded(entered.promise, 'Synthetic denied request did not reach its gate')
  const replacement = await subject.seed(server.id, endpoint, subject.publicClient,
    { ...subject.initial, accessToken: 'fixture-private-replacement-access', refreshToken: 'fixture-private-replacement-refresh' })
  release.resolve(); clean(await running)
  const restored = await subject.savedStore.load(server.id, endpoint)
  assert.equal(restored.revision, replacement.revision); assert.equal(restored.tokens.accessToken, replacement.tokens.accessToken)
  assert.equal(owner.requests.filter(item => item.message.method === 'tools/call').length, 1)
  assert.equal(owner.oauthRequests.length, 0)
})

test('locked-key old-epoch HTTP denial preserves a replacement whose revision cannot be verified', async t => {
  const entered = deferred(), release = deferred()
  const subject = await fixture(t, { httpFetch: async message => {
    if (message.method === 'tools/call') { entered.resolve(); await release.promise; return new Response(null, { status: 401 }) }
  } }), owner = subject.host()
  subject.cleanup(() => release.resolve())
  assert.equal(await owner.connect(), true)
  const running = owner.manager.invoke(await owner.operation(), signal(), () => {})
  await bounded(entered.promise, 'Synthetic denied request did not reach its gate')
  const replacement = await subject.seed(server.id, endpoint, subject.publicClient,
    { ...subject.initial, accessToken: 'fixture-private-locked-replacement', refreshToken: 'fixture-private-locked-refresh' })
  const file = join(subject.directory, 'mcp-oauth-remote.json'), before = await readFile(file)
  subject.lock(); release.resolve(); clean(await running)
  assert.deepEqual(await readFile(file), before)
  subject.unlock(); assert.equal((await subject.savedStore.load(server.id, endpoint)).revision, replacement.revision)
  assert.equal(owner.oauth.authorization(server).bearerToken, undefined)
})

test('unrelated server add update and remove preserve approved credentials; own endpoint change forgets only that identity', async t => {
  const subject = await fixture(t), owner = subject.host(); await owner.manager.reload()
  const before = await subject.savedStore.load(server.id, endpoint)
  const other = { ...server, id: 'other', endpoint: 'https://other.saved.fixture.invalid/mcp' }
  await owner.manager.configure(other)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).revision, before.revision)
  await owner.manager.update({ ...other, label: 'Changed unrelated label' }, owner.manager.configurationRevision())
  assert.equal((await subject.savedStore.load(server.id, endpoint)).revision, before.revision)
  await owner.manager.remove(other.id)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).revision, before.revision)
  await owner.manager.update({ ...server, endpoint: 'https://changed.saved.fixture.invalid/mcp' }, owner.manager.configurationRevision())
  assert.equal(await subject.savedStore.load(server.id, endpoint), undefined)
  assert.equal(owner.requests.length, 0); assert.equal(owner.oauthRequests.length, 0)
})

test('stale removal approval cannot forget saved credentials before its configuration revision is rejected', async t => {
  const subject = await fixture(t), owner = subject.host(); await owner.manager.reload()
  const stale = owner.manager.configurationRevision()
  await owner.manager.configure({ ...server, id: 'other', endpoint: 'https://other.saved.fixture.invalid/mcp' })
  const before = await subject.savedStore.load(server.id, endpoint)
  await assert.rejects(owner.service.remove(server.id, stale), /configuration changed/i)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).revision, before.revision)
  assert((await subject.configurations.load()).servers.some(item => item.id === server.id))
  assert.equal(owner.requests.length, 0); assert.equal(owner.oauthRequests.length, 0)
})

test('external configuration change during removal cleanup cannot forget saved credentials under a stale approval', async t => {
  const subject = await fixture(t), owner = subject.host(), entered = deferred(), release = deferred()
  await owner.manager.reload()
  const revision = owner.manager.configurationRevision(), before = await subject.savedStore.load(server.id, endpoint)
  const original = subject.savedStore.remove.bind(subject.savedStore)
  subject.savedStore.remove = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
  subject.cleanup(() => release.resolve())
  const removal = owner.service.remove(server.id, revision)
  const rejection = assert.rejects(removal, error => error.code === 'changed' || /configuration changed/i.test(error.message))
  await bounded(entered.promise, 'Synthetic removal did not reach its deletion gate')
  const current = await subject.configurations.load()
  await subject.configurations.save([...current.servers, { ...server, id: 'other', endpoint: 'https://other.saved.fixture.invalid/mcp' }], current.revision)
  release.resolve(); await rejection
  assert.equal((await subject.savedStore.load(server.id, endpoint))?.revision, before.revision)
  assert((await subject.configurations.load()).servers.some(item => item.id === server.id))
})

test('external endpoint replacement during stale removal preserves the newly bound saved record without deadlocking cleanup', async t => {
  const subject = await fixture(t), owner = subject.host(), entered = deferred(), release = deferred()
  await owner.manager.reload()
  const revision = owner.manager.configurationRevision(), original = subject.savedStore.remove.bind(subject.savedStore)
  subject.savedStore.remove = async (...args) => { entered.resolve(); await release.promise; return original(...args) }
  subject.cleanup(() => release.resolve())
  const removal = owner.service.remove(server.id, revision)
  const rejection = assert.rejects(removal, error => error.code === 'changed' || /configuration changed/i.test(error.message))
  await bounded(entered.promise, 'Synthetic endpoint replacement did not reach the deletion gate')
  const replacementEndpoint = 'https://replacement.saved.fixture.invalid/mcp', current = await subject.configurations.load()
  await subject.configurations.save([{ ...server, endpoint: replacementEndpoint }], current.revision)
  const replacement = await subject.seed(server.id, replacementEndpoint, subject.publicClient, { ...subject.initial, resource: replacementEndpoint })
  release.resolve(); await bounded(rejection, 'Stale deletion guard deadlocked on configuration invalidation')
  assert.equal((await subject.savedStore.load(server.id, replacementEndpoint))?.revision, replacement.revision)
  assert.equal((await subject.configurations.load()).servers[0].endpoint, replacementEndpoint)
})

test('global expiry invalidation retains refresh authority instead of treating it as a server denial', async t => {
  const subject = await fixture(t), owner = subject.host()
  assert.equal(await owner.connect(), true); subject.tick(121_000)
  await owner.manager.reload()
  assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens.refreshToken, subject.initial.refreshToken)
  assert.equal(owner.oauthRequests.length, 0)
  assert.equal(await owner.connect(), true)
  assert.equal(owner.oauthRequests.filter(item => item.method === 'POST').length, 1)
})

test('invalid unknown configuration revokes runtime authority without deleting saved sign-in', async t => {
  const subject = await fixture(t), owner = subject.host()
  assert.equal(await owner.connect(), true)
  const before = await subject.savedStore.load(server.id, endpoint)
  await writeFile(join(subject.directory, 'mcp-servers.json'), 'synthetic-invalid-configuration')
  await assert.rejects(owner.manager.reload())
  assert.equal(owner.oauth.authorization(server).bearerToken, undefined)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).revision, before.revision)
  assert.equal(owner.oauthRequests.length, 0)
})

test('logout waits for a refresh persistence mutation to settle, then removes the late saved authority', async t => {
  const subject = await fixture(t, { expiresAt: 500 }), owner = subject.host(), entered = deferred(), release = deferred()
  const original = subject.savedStore.syncDirectory.bind(subject.savedStore)
  let syncs = 0
  subject.savedStore.syncDirectory = async () => {
    syncs++
    if (syncs === 2) { entered.resolve(); await release.promise }
    await original()
  }
  subject.cleanup(() => release.resolve())
  const connecting = owner.connect().then(value => value, error => { assert(safeError(error)); return false })
  await bounded(entered.promise, 'Synthetic refresh persistence did not reach the gate')
  let loggedOut = false
  const logout = owner.oauth.logout(server.id).then(() => { loggedOut = true })
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(loggedOut, false)
  release.resolve(); await bounded(logout, 'Synthetic logout did not settle'); await connecting
  assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens, undefined)
  assert.equal(owner.oauth.authorization(server).bearerToken, undefined)
  assert.equal(owner.requests.length, 0)
})

test('logout excludes a new Connect while settle and local credential cleanup remain in progress', async t => {
  const subject = await fixture(t), owner = subject.host(), entered = deferred(), release = deferred()
  const original = subject.savedStore.settle.bind(subject.savedStore)
  let held = false
  subject.savedStore.settle = async () => {
    if (!held) { held = true; entered.resolve(); await release.promise }
    await original()
  }
  subject.cleanup(() => release.resolve())
  const loggingOut = owner.oauth.logout(server.id)
  await bounded(entered.promise, 'Synthetic logout did not reach settle')
  let connected = false
  try { connected = await owner.connect() }
  catch (error) { assert(['invalid-plan', 'cancelled', 'busy'].includes(error.code)) }
  release.resolve(); await loggingOut
  assert.equal(connected, false)
  assert.equal(owner.oauth.authorization(server).bearerToken, undefined)
  assert.equal(owner.requests.length, 0)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens, undefined)
})

test('a locked saved record cannot silently become an anonymous or session-only connection', async t => {
  const subject = await fixture(t), owner = subject.host(); subject.lock()
  await assert.rejects(owner.connect(ioFixture([true])), error => error.code === 'unavailable')
  assert.equal(owner.requests.length, 0); assert.equal(owner.oauthRequests.length, 0); assert.equal(owner.browsers.length, 0)
  subject.unlock(); assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens.accessToken, subject.initial.accessToken)
  assert((await readdir(subject.directory)).includes('mcp-oauth-remote.json'))
})

test('HTTP denial excludes a new Connect until revoked saved authority has been forgotten', async t => {
  const subject = await fixture(t), owner = subject.host(), entered = deferred(), release = deferred()
  assert.equal(await owner.connect(), true)
  const operation = await owner.operation(), original = subject.savedStore.settle.bind(subject.savedStore)
  let held = false
  subject.savedStore.settle = async () => {
    if (!held) { held = true; entered.resolve(); await release.promise }
    await original()
  }
  subject.cleanup(() => release.resolve()); subject.reject(401)
  const denied = owner.manager.invoke(operation, signal(), () => {})
  await bounded(entered.promise, 'Synthetic denial did not reach credential cleanup')
  const before = owner.requests.length
  let connected = false
  try { connected = await owner.connect() }
  catch (error) { assert(['invalid-plan', 'cancelled', 'busy'].includes(error.code)) }
  release.resolve(); clean(await denied)
  await subject.savedStore.settle()
  assert.equal(connected, false)
  assert.equal(owner.requests.length, before)
  assert.equal(owner.oauth.authorization(server).bearerToken, undefined)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens, undefined)
})

test('guided saved sign-in persists the approved client and grant and restores in a fresh host without browser setup', async t => {
  const subject = await fixture(t, { seed: false }), owner = subject.host()
  await owner.oauth.configureClient(server.id, subject.publicClient)
  const io = ioFixture([true]); assert.equal(await owner.service.login(server.id, io, signal()), true)
  assert.deepEqual(io.approvals.map(item => item.call.name), ['sign_in_mcp_server'])
  assert.match(io.approvals[0].description, /OS-protected encrypted storage/)
  assert.equal(owner.browsers.length, 1)
  const record = await subject.savedStore.load(server.id, endpoint)
  assert.equal(record.tokens.accessToken, 'fixture-private-refreshed-access-1')
  assert.equal(record.tokens.resource, endpoint); assert.equal(record.client.resource, endpoint)
  clean([await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8'), await readFile(join(subject.directory, 'mcp-oauth-remote.json'), 'utf8'), io.approvals, io.output])
  await owner.close(); const restarted = subject.host()
  assert.equal(await restarted.service.connect(server.id, ioFixture([true]), signal()), true)
  assert.equal(restarted.browsers.length, 0); assert.equal(restarted.oauthRequests.length, 0)
})

test('accepted callback and saved grant survive protocol rejection; menu Connect retries without another browser grant', async t => {
  let rejectProtocol = true
  const subject = await fixture(t, { seed: false, httpFetch(message) {
    if (rejectProtocol && message.method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: message.id,
      error: { code: -32601, message: 'fixture-private-protocol-rejection' } })
  } }), owner = subject.host()
  await owner.oauth.configureClient(server.id, subject.publicClient)
  const login = ioFixture([true])
  assert.equal(await owner.service.login(server.id, login, signal()), false)
  assert.equal(owner.browsers.length, 1)
  assert.equal(owner.oauthRequests.filter(item => item.method === 'POST').length, 1)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens.accessToken, 'fixture-private-refreshed-access-1')
  assert.equal(owner.oauth.authorization(server).bearerToken, undefined)
  assert.equal(owner.manager.statuses()[0].state, 'disabled')
  assert.deepEqual(owner.requests.map(item => item.message.method), ['server/discover'])
  assert.match(login.output, /Browser sign-in completed, but the MCP connection failed/)
  assert.match(login.output, /protocol handshake failed/)
  assert.match(login.output, /Configured protocol: 2026-07-28/)
  assert.match(login.output, /Saved sign-in was retained/)
  assert(!login.output.includes('requires legacy'))
  const keyCalls = subject.keyCalls.length
  const local = await owner.service.listLocal(signal())
  assert.equal(subject.keyCalls.length, keyCalls)
  assert.equal(local.servers[0].nextAction, 'Connect')
  assert.match(local.servers[0].message, /protocol handshake failed/)
  rejectProtocol = false
  const retry = ioFixture([true], ['server:remote', 'connect', 'back'])
  await manageMcp(owner.manager, retry, undefined, owner.oauth)
  assert.equal(retry.selections[1].items[1].name, 'Connect')
  assert.deepEqual(retry.approvals.map(item => item.call.name), ['connect_saved_mcp_server'])
  assert.equal(owner.browsers.length, 1)
  assert.equal(owner.oauthRequests.filter(item => item.method === 'POST').length, 1)
  assert.equal(owner.manager.statuses()[0].state, 'connected')
  assert.equal(owner.oauth.status(server.id).state, 'connected')
  assert.equal(owner.oauth.hasActiveAttempt(server.id), false)
  assert.equal(owner.oauth.connectionFailure(server.id), undefined)
  clean([login.output, retry.output, local, retry.approvals])
})

test('guided saved sign-in supports explicitly configured legacy without changing the protocol or approval', async t => {
  const subject = await fixture(t, { seed: false, protocol: 'legacy' }), owner = subject.host()
  await owner.oauth.configureClient(server.id, subject.publicClient)
  const io = ioFixture([true])
  assert.equal(await owner.service.login(server.id, io, signal()), true)
  assert.match(io.approvals[0].description, /Protocol: legacy/)
  assert.deepEqual(owner.requests.map(item => item.message.method), ['initialize', 'notifications/initialized', 'tools/list'])
  assert.equal(owner.manager.statuses()[0].snapshot.protocolVersion, '2025-11-25')
  assert.equal(owner.oauth.status(server.id).state, 'connected')
  assert.equal(owner.oauth.hasActiveAttempt(server.id), false)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens.accessToken, 'fixture-private-refreshed-access-1')
})

test('inert local listing never attaches an old connection failure to externally replaced configuration', async t => {
  const subject = await fixture(t, { seed: false, httpFetch(message) {
    return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'fixture-private-old-failure' } })
  } }), owner = subject.host()
  await owner.oauth.configureClient(server.id, subject.publicClient)
  assert.equal(await owner.service.login(server.id, ioFixture([true]), signal()), false)
  assert.match((await owner.service.listLocal(signal())).servers[0].message, /protocol handshake failed/)
  const before = await subject.configurations.load()
  const replacement = { ...server, endpoint: 'https://replacement.saved.fixture.invalid/mcp', protocol: 'legacy' }
  await subject.configurations.save([replacement], before.revision)
  const keyCalls = subject.keyCalls.length, requests = owner.requests.length
  const local = await owner.service.listLocal(signal())
  assert.equal(local.servers[0].endpoint, replacement.endpoint)
  assert.equal(local.servers[0].message, undefined)
  assert.equal(local.servers[0].signInState, undefined)
  assert.equal(local.servers[0].nextAction, 'Connect')
  assert.equal(subject.keyCalls.length, keyCalls)
  assert.equal(owner.requests.length, requests)
  clean(local)
})

test('explicit Sign in again still replaces a saved grant through fresh browser approval', async t => {
  const subject = await fixture(t), owner = subject.host()
  assert.equal(await owner.connect(), true)
  await owner.manager.disconnect(server.id)
  const io = ioFixture([true], ['server:remote', 'sign-in', 'back'])
  await manageMcp(owner.manager, io, undefined, owner.oauth)
  assert.equal(io.selections[1].items[1].name, 'Connect')
  assert(io.selections[1].items.some(item => item.name === 'Sign in again' && item.value === 'sign-in'))
  assert.deepEqual(io.approvals.map(item => item.call.name), ['sign_in_mcp_server'])
  assert.equal(owner.browsers.length, 1)
  assert.equal(owner.oauthRequests.filter(item => item.method === 'POST').length, 1)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens.accessToken, 'fixture-private-refreshed-access-1')
})

test('post-callback HTTP denial clears saved authority and still requires fresh sign-in', async t => {
  const subject = await fixture(t, { seed: false, httpFetch() { return new Response('fixture-private-rejected', { status: 401 }) } }), owner = subject.host()
  await owner.oauth.configureClient(server.id, subject.publicClient)
  const io = ioFixture([true])
  assert.equal(await owner.service.login(server.id, io, signal()), false)
  assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens, undefined)
  assert.equal(owner.oauth.hasSavedSignIn(server.id), false)
  assert.equal((await owner.service.listLocal(signal())).servers[0].nextAction, 'Sign in')
  assert.match(io.output, /server rejected the credentials/)
  assert(!io.output.includes('Protocol compatibility'))
  assert(!io.output.includes('Saved sign-in was retained'))
  assert.equal(owner.browsers.length, 1)
  assert.equal(owner.oauthRequests.filter(item => item.method === 'POST').length, 1)
  clean(io.output)
})

test('credentials expiring after save are not reported as a server rejection and remain eligible for approved refresh', async t => {
  const subject = await fixture(t, { seed: false }), owner = subject.host()
  await owner.oauth.configureClient(server.id, subject.publicClient)
  const save = subject.savedStore.saveTokens.bind(subject.savedStore)
  subject.savedStore.saveTokens = async (...args) => { const record = await save(...args); subject.tick(122000); return record }
  const io = ioFixture([true])
  assert.equal(await owner.service.login(server.id, io, signal()), false)
  assert.equal(owner.requests.length, 0)
  assert(!io.output.includes('server rejected the credentials'))
  assert.match(io.output, /Saved sign-in was retained/)
  assert.equal(owner.oauth.hasSavedSignIn(server.id), true)
  assert.equal((await owner.service.listLocal(signal())).servers[0].nextAction, 'Connect')
  const retry = ioFixture([true])
  assert.equal(await owner.service.connect(server.id, retry, signal()), true)
  assert.deepEqual(retry.approvals.map(item => item.call.name), ['connect_saved_mcp_server'])
  assert.equal(owner.browsers.length, 1)
  assert.equal(owner.oauthRequests.filter(item => item.method === 'POST').length, 2)
  clean([io.output, retry.output])
})

for (const action of ['logout', 'forgetSaved']) test(`${action} clears old retained-sign-in failure guidance`, async t => {
  const subject = await fixture(t, { seed: false, httpFetch(message) {
    return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'fixture-private-old-failure' } })
  } }), owner = subject.host()
  await owner.oauth.configureClient(server.id, subject.publicClient)
  assert.equal(await owner.service.login(server.id, ioFixture([true]), signal()), false)
  assert.match(owner.oauth.connectionFailure(server.id), /Saved sign-in was retained/)
  await owner.oauth[action](server.id)
  assert.equal(owner.oauth.connectionFailure(server.id), undefined)
  assert.equal(owner.oauth.hasSavedSignIn(server.id), false)
  assert.equal((await owner.service.listLocal(signal())).servers[0].message, undefined)
})

test('saved Connect approval cannot adopt a changed protocol or replay the earlier grant', async t => {
  const subject = await fixture(t, { seed: false, httpFetch(message) {
    return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'fixture-private-old-failure' } })
  } }), owner = subject.host()
  await owner.oauth.configureClient(server.id, subject.publicClient)
  assert.equal(await owner.service.login(server.id, ioFixture([true]), signal()), false)
  const requests = owner.requests.length, oauthRequests = owner.oauthRequests.length, io = ioFixture()
  io.approve = async request => {
    io.approvals.push(request)
    assert.equal(request.call.name, 'connect_saved_mcp_server')
    const current = await subject.configurations.load()
    await subject.configurations.save([{ ...server, protocol: 'legacy' }], current.revision)
    return true
  }
  await assert.rejects(owner.service.connect(server.id, io, signal()), safeError)
  assert.equal(owner.requests.length, requests)
  assert.equal(owner.oauthRequests.length, oauthRequests)
  assert.equal(owner.browsers.length, 1)
  assert.equal((await owner.service.listLocal(signal())).servers[0].message, undefined)
  clean(io.approvals)
})

test('a denied grant whose disk cleanup is locked is never advertised as reusable saved sign-in', async t => {
  let mode = 'denied'
  const subject = await fixture(t, { seed: false, httpFetch(message) {
    if (mode === 'denied') { subject.lock(); return new Response(null, { status: 401 }) }
    if (mode === 'protocol') return Response.json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'fixture-private-unsupported-method' } })
  } }), owner = subject.host()
  await owner.oauth.configureClient(server.id, subject.publicClient)
  assert.equal(await owner.service.login(server.id, ioFixture([true]), signal()), false)
  assert.equal(owner.oauth.hasSavedSignIn(server.id), false)
  assert.equal((await owner.service.listLocal(signal())).servers[0].nextAction, 'Sign in')
  subject.unlock(); mode = 'protocol'
  assert.equal(await owner.service.login(server.id, ioFixture([true]), signal()), false)
  assert.equal(owner.oauth.hasSavedSignIn(server.id), true)
  assert.equal((await owner.service.listLocal(signal())).servers[0].nextAction, 'Connect')
  mode = 'accepted'
  assert.equal(await owner.service.connect(server.id, ioFixture([true]), signal()), true)
  assert.equal(owner.browsers.length, 2)
})

test('locked-store fallback requires an explicit approval and cancellation starts no sign-in or anonymous connection', async t => {
  const subject = await fixture(t), owner = subject.host(), io = ioFixture([false]); subject.lock()
  assert.equal(await owner.service.connect(server.id, io, signal()), false)
  assert.deepEqual(io.approvals.map(item => item.call.name), ['use_session_only_mcp_sign_in'])
  assert.match(io.approvals[0].description, /no credentials or client settings will be saved/)
  assert.equal(owner.oauthRequests.length, 0); assert.equal(owner.requests.length, 0); assert.equal(owner.browsers.length, 0)
  clean([io.approvals, io.output]); subject.unlock()
  assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens.accessToken, subject.initial.accessToken)
})

test('explicit locked-store fallback grants only launch authority and leaves the encrypted saved record unchanged', async t => {
  const subject = await fixture(t, { seed: false }), owner = subject.host()
  await owner.oauth.configureClient(server.id, subject.publicClient)
  const file = join(subject.directory, 'mcp-oauth-remote.json'), before = await readFile(file)
  subject.lock(); const io = ioFixture([true, true])
  assert.equal(await owner.service.connect(server.id, io, signal()), true)
  assert.deepEqual(io.approvals.map(item => item.call.name), ['use_session_only_mcp_sign_in', 'sign_in_mcp_server'])
  assert.match(io.approvals[1].description, /no settings or tokens will be saved/)
  assert.equal(owner.browsers.length, 1); assert.equal(owner.oauthRequests.filter(item => item.method === 'POST').length, 1)
  assert.deepEqual(await readFile(file), before); clean([io.approvals, io.output])
  await owner.close(); subject.unlock(); assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens, undefined)
})

test('explicit session-only login never consults the keyring or changes saved credentials', async t => {
  const subject = await fixture(t, { seed: false }), owner = subject.host()
  await owner.oauth.configureClient(server.id, subject.publicClient)
  const file = join(subject.directory, 'mcp-oauth-remote.json'), before = await readFile(file)
  subject.keyCalls.length = 0
  assert.equal(await owner.service.login(server.id, ioFixture([true]), signal(), 'session-only'), true)
  assert.deepEqual(subject.keyCalls, []); assert.deepEqual(await readFile(file), before)
  assert.equal(owner.browsers.length, 1)
})

for (const change of [
  { id: 'owned-replacement-public-client' }, { issuer: 'https://replacement.saved.fixture.invalid' },
  { scopes: ['read', 'write'] }, { resource: new URL(endpoint).origin + '/' }
]) test(`public client ${Object.keys(change)[0]} replacement forgets old saved authority without requesting a new grant`, async t => {
  const subject = await fixture(t), owner = subject.host(); assert.equal(await owner.connect(), true)
  const operation = await owner.operation(), client = { ...subject.publicClient, ...change }
  await owner.oauth.configureClient(server.id, client)
  const record = await subject.savedStore.load(server.id, endpoint)
  assert.deepEqual(record.client, client); assert.equal(record.tokens, undefined)
  await owner.manager.invoke(operation, signal(), () => {})
  assert.equal(owner.requests.filter(item => item.message.method === 'tools/call').length, 0)
  assert.equal(owner.oauthRequests.length, 0); assert.equal(owner.browsers.length, 0)
})
