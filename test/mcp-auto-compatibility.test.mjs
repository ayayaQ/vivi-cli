// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpConfigStore } from '../dist/mcp-config.js'
import { McpManager, mcpStartDisclosure } from '../dist/mcp-manager.js'

const signal = () => new AbortController().signal
const endpoint = 'https://mcp.example.test/auto'
const modern = '2026-07-28', legacy = '2025-11-25'
const token = 'offline-auto-session-fixture'
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const json = (request, body, status = 200, headers = {}) => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...body }),
  { status, headers: { 'content-type': 'application/json', ...headers } })

async function fixture(t, era, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-auto-')), store = new McpConfigStore(directory), requests = []
  let authorization = { revision: 'auth-1', bearerToken: token }
  const server = { transport: 'http', id: 'auto', label: 'Offline auto fixture', endpoint,
    protocol: options.protocol ?? 'auto', allowLoopbackHttp: false }
  const result = (request, body, headers = {}) => json(request, { result: era === 'modern'
    ? { ...body, resultType: 'complete', ttlMs: 0, cacheScope: 'private' } : body }, 200, headers)
  const manager = new McpManager({ store, env: {}, httpAuthorization: () => authorization,
    httpFetch: async (input, init) => {
      assert.equal(String(input), endpoint); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual')
      const request = JSON.parse(init.body), headers = new Headers(init.headers)
      requests.push({ request, headers, signal: init.signal })
      assert.equal(headers.get('authorization'), `Bearer ${token}`)
      if (request.method === 'server/discover') {
        if (options.probe) return options.probe(request, init)
        if (era === 'legacy') return json(request, { error: { code: -32000, message: 'Server not initialized' } }, 400,
          options.probeSession ? { 'mcp-session-id': 'unadopted-probe-session' } : {})
        return result(request, { supportedVersions: [modern], capabilities: { tools: {}, resources: {} } },
          options.modernSession ? { 'mcp-session-id': 'forbidden-modern-session' } : {})
      }
      if (request.method === 'initialize') return result(request, { protocolVersion: legacy,
        capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'Offline legacy', version: '1' } }, { 'mcp-session-id': 'approved-legacy-session' })
      if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return new Response(null, { status: 202 })
      if (request.method === 'tools/list') return result(request, { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] })
      if (request.method === 'resources/list') return result(request, { resources: [{ name: 'Document', uri: 'fixture:///document' }] })
      if (request.method === 'resources/templates/list') return result(request, { resourceTemplates: [] })
      if (request.method === 'tools/call' || request.method === 'resources/read') {
        if (options.operation) return options.operation(request, init)
        return result(request, request.method === 'tools/call' ? { content: [{ type: 'text', text: 'OFFLINE_CONFIRMED' }] }
          : { contents: [{ uri: request.params.uri, text: 'OFFLINE_DOCUMENT' }] })
      }
      assert.fail('Unexpected offline MCP request')
    } })
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }) })
  await manager.configure(server)
  return { manager, store, server, requests, setAuthorization(value) { authorization = value },
    connect: (approve = async () => true, connectionSignal = signal()) => manager.connect(server.id, approve, connectionSignal),
    async operation(kind) {
      if (kind === 'resources') await manager.refresh(server.id, ['resources'], signal())
      const [snapshot] = await manager.captureCatalogs(signal()), entry = snapshot.categories[kind].entries[0]
      return manager.prepareOperation(snapshot, entry, kind, { id: 'auto-operation', name: kind === 'tools' ? entry.alias : 'read_mcp_resource',
        arguments: kind === 'tools' ? {} : { serverId: server.id, uri: entry.remoteKey } })
    } }
}

for (const era of ['modern', 'legacy']) {
  for (const kind of ['tools', 'resources']) test(`auto ${era} ${kind} negotiates once and binds each approved request to its actual era`, async t => {
    const subject = await fixture(t, era, { probeSession: true })
    let approvals = 0
    assert.equal(await subject.connect(async launch => {
      approvals++; assert.equal(launch.server.protocol, 'auto'); assert(mcpStartDisclosure(launch).includes('Protocol: auto'))
      return true
    }), true)
    assert.equal(approvals, 1)
    const operation = await subject.operation(kind)
    assert.equal(operation.snapshot.protocolVersion, era === 'modern' ? modern : legacy)
    assert.equal(operation.snapshot.configRevision, subject.manager.configurationRevision())
    const outcome = JSON.parse((await subject.manager.invoke(operation, signal(), () => {})).content)
    assert.equal(outcome.confirmedOutcome, true)
    const methods = subject.requests.map(item => item.request.method)
    assert.equal(methods.filter(method => method === 'server/discover').length, 1)
    assert.equal(methods.filter(method => method === 'initialize').length, era === 'legacy' ? 1 : 0)
    assert.equal(methods.filter(method => method === (kind === 'tools' ? 'tools/call' : 'resources/read')).length, 1)
    const probe = subject.requests[0]
    assert.equal(probe.headers.get('mcp-protocol-version'), modern)
    assert.equal(probe.headers.get('mcp-session-id'), null)
    const request = subject.requests.at(-1)
    assert.equal(request.headers.get('mcp-protocol-version'), era === 'modern' ? modern : legacy)
    assert.equal(request.headers.get('mcp-session-id'), era === 'legacy' ? 'approved-legacy-session' : null)
    assert.equal(request.headers.get('mcp-method'), era === 'modern' ? request.request.method : null)
    assert.equal(request.request.params?._meta?.['io.modelcontextprotocol/protocolVersion'], era === 'modern' ? modern : undefined)
    if (era === 'legacy') {
      const initialize = subject.requests.find(item => item.request.method === 'initialize')
      assert.equal(initialize.headers.get('mcp-session-id'), null)
      assert.equal(initialize.request.params.protocolVersion, legacy)
      assert.equal(initialize.request.params._meta, undefined)
    }
  })
  test(`auto ${era} operation failure never renegotiates or replays a tool call`, async t => {
    const subject = await fixture(t, era, { operation() { throw new TypeError('Offline connection lost') } })
    assert.equal(await subject.connect(), true)
    const outcome = JSON.parse((await subject.manager.invoke(await subject.operation('tools'), signal(), () => {})).content)
    assert.equal(outcome.unknownOutcome, true); assert.equal(outcome.doNotRetry, true)
    assert.equal(subject.requests.filter(item => item.request.method === 'tools/call').length, 1)
    assert.equal(subject.requests.filter(item => item.request.method === 'server/discover').length, 1)
  })
}

for (const status of [401, 403, 500]) test(`auto HTTP ${status} probe stops without legacy fallback or automatic sign-in`, async t => {
  const subject = await fixture(t, 'legacy', { probe: () => new Response('offline rejection', { status,
    headers: { 'www-authenticate': 'Bearer error="insufficient_scope", scope="write"' } }) })
  assert.equal(await subject.connect(), false)
  assert.deepEqual(subject.requests.map(item => item.request.method), ['server/discover'])
  assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
})
for (const [name, probe] of [
  ['network failure', () => { throw new TypeError('Offline network failure') }],
  ['malformed JSON', () => new Response('{invalid', { headers: { 'content-type': 'application/json' } })],
  ['non-protocol content', () => new Response('<html>Offline</html>', { headers: { 'content-type': 'text/html' } })]
]) test(`auto ${name} stops without a legacy request`, async t => {
  const subject = await fixture(t, 'legacy', { probe })
  assert.equal(await subject.connect(), false)
  assert.deepEqual(subject.requests.map(item => item.request.method), ['server/discover'])
})
test('auto successful modern discovery rejects transport sessions before catalogs become available', async t => {
  const subject = await fixture(t, 'modern', { modernSession: true })
  assert.equal(await subject.connect(), false)
  assert.deepEqual(subject.requests.map(item => item.request.method), ['server/discover'])
  assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
})
for (const protocol of ['legacy', modern]) test(`explicit ${protocol} remains a pin and never switches eras`, async t => {
  const subject = await fixture(t, 'legacy', { protocol })
  assert.equal(await subject.connect(), protocol === 'legacy')
  assert.equal(subject.server.protocol, protocol)
  assert.equal(subject.requests.some(item => item.request.method === 'server/discover'), protocol === modern)
  assert.equal(subject.requests.some(item => item.request.method === 'initialize'), protocol === 'legacy')
})
test('auto cancellation while the probe is pending prevents every follow-on request', async t => {
  const entered = deferred(), release = deferred(), controller = new AbortController()
  const subject = await fixture(t, 'legacy', { probe: async request => {
    entered.resolve(); await release.promise
    return json(request, { error: { code: -32000, message: 'Server not initialized' } }, 400)
  } })
  const pending = subject.connect(undefined, controller.signal)
  await entered.promise; controller.abort(); release.resolve()
  assert.equal(await pending, false)
  assert.deepEqual(subject.requests.map(item => item.request.method), ['server/discover'])
  assert.equal(subject.requests[0].signal.aborted, true)
})
for (const change of ['authorization', 'configuration']) test(`auto ${change} change after the probe prevents legacy fallback under stale approval`, async t => {
  const entered = deferred(), release = deferred()
  const subject = await fixture(t, 'legacy', { probe: async request => {
    entered.resolve(); await release.promise
    return json(request, { error: { code: -32000, message: 'Server not initialized' } }, 400)
  } })
  const pending = subject.connect()
  await entered.promise
  if (change === 'authorization') subject.setAuthorization({ revision: 'auth-2', bearerToken: token })
  else await subject.manager.remove(subject.server.id)
  release.resolve()
  assert.equal(await pending, false)
  assert.deepEqual(subject.requests.map(item => item.request.method), ['server/discover'])
})
