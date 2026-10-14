// SPDX-License-Identifier: Apache-2.0
// Offline CLI wiring fixtures: synthetic tokens and a fake wrapping-key adapter only.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { main } from '../dist/main.js'
import { parseMcpCliArguments, runMcpCli } from '../dist/mcp-cli.js'
import { McpConfigStore } from '../dist/mcp-config.js'
import { McpManager } from '../dist/mcp-manager.js'
import { McpOAuthControls } from '../dist/mcp-oauth-controls.js'
import { McpOAuthStore } from '../dist/mcp-oauth-store.js'

const endpoint = 'https://mcp.cli.fixture.invalid/mcp', issuer = 'https://auth.cli.fixture.invalid'
const server = { id: 'example', label: 'Fixture', transport: 'http', endpoint, protocol: '2026-07-28', allowLoopbackHttp: false }
const client = { id: 'fixture-public-client', issuer, redirectPort: 52147, redirectPath: '/callback', scopes: ['read'] }
const tokens = { accessToken: 'fixture-private-cli-access', refreshToken: 'fixture-private-cli-refresh', expiresAt: Date.now() + 120_000,
  issuer, resource: endpoint, clientId: client.id, scopes: ['read'] }
function ioFixture(approved = false) {
  return { output: '', approvals: [], registered: [], closed: false, canAutoReview: true,
    get isClosed() { return this.closed }, write(value) { this.output += value }, event() {}, result() {},
    addSecrets(values) { this.registered.push(...values) }, async readLine() { throw Error('Unexpected input') },
    async approve(request) { this.approvals.push(request); return approved },
    onCancel() { return () => {} }, close() { this.closed = true } }
}
async function fixture(t, seeded = true) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-saved-cli-')), entries = new Map(), keyCalls = [], requests = []
  t.after(() => rm(directory, { recursive: true, force: true }))
  const savedStore = new McpOAuthStore(directory, { keyStore: scope => ({
    status: async () => { keyCalls.push('status'); return { available: true, label: 'Synthetic keyring' } },
    load: async () => { keyCalls.push('load'); return entries.get(scope) }, save: async value => { keyCalls.push('save'); entries.set(scope, value) }
  }) })
  const configurations = new McpConfigStore(directory)
  if (seeded) {
    await configurations.save([server], (await configurations.load()).revision)
    const record = await savedStore.saveClient(server.id, endpoint, client)
    await savedStore.saveTokens(server.id, endpoint, record.revision, tokens)
  }
  keyCalls.length = 0
  const dependencies = io => ({ io, mcpOAuth: { savedStore,
    fetchFn: async () => { throw Error('Unexpired CLI restoration must not perform OAuth') },
    openBrowser: async () => { throw Error('Restoration must not open a browser') } },
    mcpManagerFactory: options => new McpManager({ ...options, httpFetch: async (_url, init) => {
      const message = JSON.parse(init.body); requests.push({ message, headers: new Headers(init.headers) })
      const result = message.method === 'server/discover' ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } }
        : message.method === 'tools/list' ? { tools: [] } : assert.fail('Unexpected fixture MCP method')
      return Response.json({ jsonrpc: '2.0', id: message.id, result: { ...result, resultType: 'complete', ttlMs: 0, cacheScope: 'private' } })
    } }) })
  const args = action => ['mcp', action, ...(action === 'list' ? [] : [server.id]), '--session-dir', directory]
  return { directory, savedStore, keyCalls, requests, dependencies, args }
}

test('saved CLI flags are narrow and retain legacy parser shapes when omitted', () => {
  for (const action of ['login', 'connect']) assert.equal(parseMcpCliArguments(['mcp', action, 'example', '--session-only'], {}).sessionOnly, true)
  for (const action of ['list', 'logout', 'remove']) assert.throws(() => parseMcpCliArguments(['mcp', action, ...(action === 'list' ? [] : ['example']), '--session-only'], {}))
  assert.equal(Object.hasOwn(parseMcpCliArguments(['mcp', 'list'], {}), 'sessionOnly'), false)
})

test('CLI help/add/list never load keys or initialize saved-auth leases', async t => {
  const subject = await fixture(t, false)
  for (const args of [['mcp', '--help'], ['mcp', 'add', server.id, endpoint, '--session-dir', subject.directory], subject.args('list')]) {
    assert.equal(await runMcpCli(args, {}, subject.dependencies(ioFixture())), 0)
  }
  assert.deepEqual(subject.keyCalls, []); assert.equal(subject.requests.length, 0)
  assert.deepEqual(await readdir(subject.directory), ['mcp-servers.json'])
})

test('top-level provider-free connect restores saved sign-in after fresh human approval and retains it on exit', async t => {
  const subject = await fixture(t), io = ioFixture(true)
  assert.equal(await main(subject.args('connect'), {}, { ...subject.dependencies(io), providerFactory: () => assert.fail('No model provider permitted') }), 0)
  assert.deepEqual(io.approvals.map(request => request.call.name), ['connect_saved_mcp_server'])
  assert(subject.requests.length > 0); assert(subject.requests.every(request => request.headers.get('authorization') === `Bearer ${tokens.accessToken}`))
  assert.equal((await subject.savedStore.load(server.id, endpoint)).tokens.refreshToken, tokens.refreshToken)
  assert(!JSON.stringify([io.output, io.approvals]).includes('fixture-private-cli'))
  assert(io.registered.includes(tokens.accessToken)); assert(io.registered.includes(tokens.refreshToken))
})

test('denied CLI restore sends no request and standalone logout forgets saved tokens without RAM setup', async t => {
  const subject = await fixture(t), before = await subject.savedStore.load(server.id, endpoint)
  assert.equal(await runMcpCli(subject.args('connect'), {}, subject.dependencies(ioFixture(false))), 1)
  assert.equal(subject.requests.length, 0); assert.equal((await subject.savedStore.load(server.id, endpoint)).revision, before.revision)
  assert.equal(await runMcpCli(subject.args('logout'), {}, subject.dependencies(ioFixture())), 0)
  const cleared = await subject.savedStore.load(server.id, endpoint)
  assert.equal(cleared.tokens, undefined); assert.deepEqual(cleared.client, client)
})

test('CLI remove forgets the affected saved record without reading native keys', async t => {
  const subject = await fixture(t)
  assert.equal(await runMcpCli(subject.args('remove'), {}, subject.dependencies(ioFixture())), 0)
  assert.deepEqual(subject.keyCalls, []); assert.equal(await subject.savedStore.load(server.id, endpoint), undefined)
  assert.equal((await new McpConfigStore(subject.directory).load()).servers.length, 0)
})

test('CLI session-only flag reaches the explicit mode without consulting saved credentials', async t => {
  const subject = await fixture(t), calls = []
  t.mock.method(McpOAuthControls.prototype, 'guidedSignInAndConnect', async (_id, _io, _signal, mode) => { calls.push(mode); return true })
  assert.equal(await runMcpCli([...subject.args('login'), '--session-only'], {}, subject.dependencies(ioFixture(true))), 0)
  assert.deepEqual(calls, ['session-only']); assert.deepEqual(subject.keyCalls, []); assert.equal(subject.requests.length, 0)
})
