// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { McpConfigStore, validateMcpServer, prepareMcpLaunch } from '../dist/mcp-config.js'
import { McpManager, mcpStartDisclosure, mcpOperationDisclosure } from '../dist/mcp-manager.js'
import { McpHttpTransport, MCP_HTTP_LIMITS } from '../dist/mcp-http-transport.js'
const signal = () => new AbortController().signal
const base = { transport: 'http', id: 'remote', label: 'Owned HTTP fixture', endpoint: 'https://mcp.example.test/endpoint', protocol: '2026-07-28', allowLoopbackHttp: false }
const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }
const remoteName = 'echo/name', uri = 'fixture:///exact'
const uriTemplate = 'fixture:///{name}', variables = { name: 'document/é %2f' }, expandedUri = 'fixture:///document%2F%C3%A9%20%252f'
const token = 'offline-session-bearer-fixture'
const json = (message, result, protocol, status = 200, headers = {}) => new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id,
  result: protocol === 'legacy' ? result : { ...result, resultType: 'complete', ttlMs: 0, cacheScope: 'private' } }),
  { status, headers: { 'content-type': 'application/json', ...headers } })
const result = body => JSON.parse(body.content)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function fixture(t, protocol = base.protocol, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-http-')), store = new McpConfigStore(directory), requests = [], effects = []
  let authorization = options.authorization ?? { revision: 'anonymous' }
  const server = { ...base, protocol }
  const manager = new McpManager({ store, env: {}, httpAuthorization: () => authorization,
    httpFetch: async (input, init) => {
      assert.equal(String(input), server.endpoint); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual')
      const message = JSON.parse(init.body); requests.push({ message, headers: new Headers(init.headers), signal: init.signal })
      if (['tools/call', 'resources/read'].includes(message.method)) {
        effects.push(message)
        if (options.effect) return options.effect(message, init)
        return json(message, message.method === 'tools/call' ? { content: [{ type: 'text', text: 'HTTP_CONFIRMED' }] }
          : { contents: [{ uri: message.params.uri, text: 'HTTP_RESOURCE' }] }, protocol)
      }
      if (message.method === 'initialize') return json(message, { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'Fixture', version: '1' } }, protocol, 200, { 'mcp-session-id': 'owned-legacy-session' })
      if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
      if (message.method === 'server/discover') return json(message, { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} } }, protocol)
      if (message.method === 'tools/list') return json(message, { tools: [{ name: remoteName, inputSchema: schema }] }, protocol)
      if (message.method === 'resources/list') return json(message, { resources: [{ uri, name: 'Owned resource' }] }, protocol)
      if (message.method === 'resources/templates/list') return json(message, { resourceTemplates: options.templates ? [{ uriTemplate, name: 'Owned template' }] : [] }, protocol)
      if (message.method === 'notifications/cancelled') return new Response(null, { status: 202 })
      assert.fail(`Unexpected request ${message.method}`)
    } })
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }) })
  await manager.configure(server)
  if (!options.disconnected) {
    assert.equal(await manager.connect(server.id, async launch => { options.disclosure?.(mcpStartDisclosure(launch)); return true }, signal()), true)
    await manager.refresh(server.id, options.templates ? ['resources', 'resourceTemplates'] : ['resources'], signal())
  }
  return { manager, store, server, requests, effects, directory, setAuthorization: value => { authorization = value },
    async prepare(kind = 'tools') {
      const [snapshot] = await manager.captureCatalogs(signal()), entry = snapshot.categories[kind].entries[0]
      return manager.prepareOperation(snapshot, entry, kind, { id: 'http-operation', name: kind === 'tools' ? entry.alias : kind === 'resourceTemplates' ? 'read_mcp_resource_template' : 'read_mcp_resource',
        arguments: kind === 'tools' ? { query: 'ordinary' } : kind === 'resourceTemplates' ? { serverId: server.id, uriTemplate, variables } : { serverId: server.id, uri } })
    } }
}
test('HTTP configuration rejects secrets, insecure endpoints and arbitrary fields; stdio remains compatible', async () => {
  for (const endpoint of ['http://example.test/mcp', 'http://127.0.0.1/mcp', 'https://user:password@example.test/mcp', 'https://example.test/mcp?token=value', 'https://example.test/mcp#fragment', 'file:///mcp', 'https://example.test/\n']) {
    assert.throws(() => validateMcpServer({ ...base, endpoint }), /Invalid MCP/)
  }
  for (const endpoint of ['http://example.test/mcp', 'http://127.0.0.2/mcp', 'http://localhost/mcp', 'http://2130706433/mcp', 'http://127.1/mcp', 'http://0x7f000001/mcp']) assert.throws(() => validateMcpServer({ ...base, endpoint, allowLoopbackHttp: true }), /Invalid MCP/)
  for (const endpoint of ['http://127.0.0.1/mcp', 'http://[::1]/mcp']) assert.equal(validateMcpServer({ ...base, endpoint, allowLoopbackHttp: true }).endpoint, endpoint)
  for (const extra of [{ headers: {} }, { bearerToken: token }, { environment: [] }, { transport: 'sse' }]) assert.throws(() => validateMcpServer({ ...base, ...extra }), /Invalid MCP/)
  assert.throws(() => validateMcpServer({ ...base, label: token }, [token]), /Invalid MCP/)
  let encoded = [...token].map(c => '%' + c.charCodeAt(0).toString(16)).join('')
  for (let depth = 0; depth < 4; depth++) {
    assert.throws(() => validateMcpServer({ ...base, endpoint: 'https://mcp.example.test/' + encoded + '/%ff%ZZ' }, [token]), /Invalid MCP/)
    encoded = encoded.replaceAll('%', '%25')
  }
  const anonymous = await prepareMcpLaunch(base, 'config', {}, [], 'anonymous'), authenticated = await prepareMcpLaunch(base, 'config', {}, [], 'auth-epoch-2')
  assert.notEqual(anonymous.digest, authenticated.digest); assert(!JSON.stringify(authenticated).includes(token))
})
for (const protocol of ['legacy', '2026-07-28']) {
  for (const kind of ['tools', 'resources']) test(`${protocol} HTTP ${kind} exact one-shot result through real SDK and bounded fetch`, async t => {
    const subject = await fixture(t, protocol), operation = await subject.prepare(kind), events = []
    const outcome = await subject.manager.invoke(operation, signal(), () => {}, { async beforeSend() { events.push('intent') }, async settle() { events.push('settle') } })
    assert.equal(result(outcome).success, true); assert.equal(result(outcome).confirmedOutcome, true); assert.equal(result(outcome).requestSent, true)
    assert.equal(subject.effects.length, 1); assert.deepEqual(events, ['intent', 'settle'])
    const request = subject.requests.find(item => item.message.method === (kind === 'tools' ? 'tools/call' : 'resources/read'))
    assert.equal(request.headers.get('mcp-protocol-version'), protocol === 'legacy' ? '2025-11-25' : protocol)
    assert.equal(request.headers.get('mcp-session-id'), protocol === 'legacy' ? 'owned-legacy-session' : null)
    assert.equal(request.headers.get('mcp-method'), protocol === 'legacy' ? null : request.message.method)
  })
  test(`${protocol} HTTP template uses exact expanded URI through both guarded send boundaries`, async t => {
    const subject = await fixture(t, protocol, { templates: true }), operation = await subject.prepare('resourceTemplates')
    assert.equal(operation.remoteKey, uriTemplate); assert.equal(operation.resourceUri, expandedUri)
    const disclosure = mcpOperationDisclosure(operation)
    assert(disclosure.includes(uriTemplate)); assert(disclosure.includes(expandedUri))
    const outcome = await subject.manager.invoke(operation, signal(), () => {})
    assert.equal(result(outcome).confirmedOutcome, true); assert.equal(result(outcome).remoteKey, expandedUri)
    assert.equal(subject.effects.length, 1); assert.equal(subject.effects[0].method, 'resources/read')
    assert.equal(subject.effects[0].params.uri, expandedUri); assert(!Object.hasOwn(subject.effects[0].params, 'uriTemplate'))
  })
  test(`${protocol} HTTP template rejects a response using the unexpanded URI`, async t => {
    const subject = await fixture(t, protocol, { templates: true, effect: message => json(message,
      { contents: [{ uri: uriTemplate, text: 'MISMATCHED_TEMPLATE_BODY' }] }, protocol) })
    const outcome = await subject.manager.invoke(await subject.prepare('resourceTemplates'), signal(), () => {})
    assert.equal(subject.effects.length, 1); assert.equal(result(outcome).unknownOutcome, true)
    assert(!outcome.content.includes('MISMATCHED_TEMPLATE_BODY'))
  })
  test(`${protocol} HTTP template authorization change during intent cannot send an old URI`, async t => {
    const subject = await fixture(t, protocol, { templates: true }), operation = await subject.prepare('resourceTemplates')
    const outcome = await subject.manager.invoke(operation, signal(), () => {}, {
      async beforeSend() { subject.setAuthorization({ revision: 'changed-template-epoch' }) }, async settle() {} })
    assert.equal(result(outcome).requestSent, false); assert.equal(subject.effects.length, 0)
  })
  for (const status of [401, 403, 404, 500, 307]) test(`${protocol} HTTP ${status} never retries, signs in or follows redirects`, async t => {
    const subject = await fixture(t, protocol, { authorization: { revision: 'auth-1', bearerToken: token },
      effect: () => new Response('untrusted error text', { status, headers: status === 403 ? { 'www-authenticate': 'Bearer error="insufficient_scope", scope="write"' }
        : status === 307 ? { location: 'https://different.example.test/' } : { 'www-authenticate': 'Bearer' } }) })
    const outcome = await subject.manager.invoke(await subject.prepare(), signal(), () => {})
    assert.equal(subject.effects.length, 1); assert.equal(result(outcome).unknownOutcome, true); assert.equal(result(outcome).doNotRetry, true)
    assert(!outcome.content.includes('untrusted error text')); assert(!outcome.content.includes(token))
    assert.equal(subject.requests.find(item => item.message.method === 'tools/call').headers.get('authorization'), `Bearer ${token}`)
    assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
  })
  test(`${protocol} HTTP cancellation aborts request-scoped SSE without resume`, async t => {
    const sent = deferred(), controller = new AbortController(); let cancelled = 0, wireSignal
    const subject = await fixture(t, protocol, { effect: (message, init) => {
      wireSignal = init.signal
      const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('id: prime\ndata: \n\n')); sent.resolve() }, cancel() { cancelled++ } })
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    } })
    const pending = subject.manager.invoke(await subject.prepare(), controller.signal, () => {})
    await sent.promise; controller.abort()
    const outcome = await pending
    assert.equal(result(outcome).unknownOutcome, true); assert.equal(subject.effects.length, 1); assert(wireSignal.aborted); assert.equal(cancelled, 1)
    if (protocol !== 'legacy') assert(!subject.requests.some(item => item.message.method === 'notifications/cancelled'))
  })
  test(`${protocol} HTTP response bytes are bounded before JSON parsing`, async t => {
    const subject = await fixture(t, protocol, { effect: () => new Response('x'.repeat(MCP_HTTP_LIMITS.responseBytes + 1), { headers: { 'content-type': 'application/json' } }) })
    const outcome = await subject.manager.invoke(await subject.prepare(), signal(), () => {})
    assert.equal(result(outcome).unknownOutcome, true); assert.equal(subject.effects.length, 1)
  })
}
test('session-only bearer never enters persisted configuration, approval or results; epoch changes revoke old operations', async t => {
  let disclosure
  const subject = await fixture(t, '2026-07-28', { authorization: { revision: 'auth-1', bearerToken: token }, disclosure: value => { disclosure = value } })
  assert(!disclosure.includes(token)); assert(!disclosure.includes('Executable:')); assert(disclosure.includes(base.endpoint))
  assert(!(await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8')).includes(token))
  const operation = await subject.prepare(), entered = deferred(), release = deferred()
  const pending = subject.manager.invoke(operation, signal(), () => {}, { async beforeSend() { entered.resolve(); await release.promise }, async settle() {} })
  await entered.promise; subject.setAuthorization({ revision: 'auth-2', bearerToken: 'offline-new-session-fixture' }); release.resolve()
  const outcome = await pending
  assert.equal(result(outcome).requestSent, false); assert.equal(subject.effects.length, 0); assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
})
test('authorization change during connection approval prevents all network requests', async t => {
  const subject = await fixture(t, '2026-07-28', { disconnected: true, authorization: { revision: 'auth-1', bearerToken: token } })
  await assert.rejects(subject.manager.connect('remote', async () => { subject.setAuthorization({ revision: 'auth-2', bearerToken: token }); return true }, signal()), /authorization changed/)
  assert.equal(subject.requests.length, 0)
})
test('HTTP wire ticket blocks an SDK-internal POST replay after the first attempted send', async () => {
  const launch = await prepareMcpLaunch(base, 'config', {}, [], 'auth-1'); let attempts = 0, started = 0
  const transport = new McpHttpTransport(launch, { token: () => token, beforeOperation: async () => {}, operationStarted: () => { started++ },
    fetch: async () => { attempts++; return new Response(null, { status: 401 }) } })
  // Deliberately simulate a future SDK regression adding automatic reauthentication.
  transport.sdk._authProvider.onUnauthorized = async () => {}
  await transport.start()
  await assert.rejects(transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: remoteName, arguments: { query: 'ordinary' } } }), /one-shot/)
  assert.equal(attempts, 1); assert.equal(started, 1); await transport.close()
})
test('HTTP close owns paused response-reader cancellation until cleanup settles', async () => {
  const launch = await prepareMcpLaunch(base, 'config', {}, [], 'anonymous'), cancellation = deferred(), entered = deferred()
  const transport = new McpHttpTransport(launch, { beforeOperation: async () => {}, operationStarted: () => {}, fetch: async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode('id: prime\ndata: \n\n')) }, async cancel() { entered.resolve(); await cancellation.promise }
  }), { headers: { 'content-type': 'text/event-stream' } }) })
  await transport.start(); await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: remoteName, arguments: { query: 'ordinary' } } })
  let closed = false
  const closing = transport.close().then(() => { closed = true })
  await entered.promise; await new Promise(done => setImmediate(done)); assert.equal(closed, false)
  cancellation.resolve(); await closing; assert.equal(closed, true)
})
test('HTTP oversized Content-Length retains cancellation ownership before rejecting', async () => {
  const launch = await prepareMcpLaunch(base, 'config', {}, [], 'anonymous'), cancellation = deferred(), entered = deferred()
  const transport = new McpHttpTransport(launch, { beforeOperation: async () => {}, operationStarted: () => {}, fetch: async () => new Response(new ReadableStream({
    async cancel() { entered.resolve(); await cancellation.promise }
  }), { headers: { 'content-type': 'application/json', 'content-length': String(MCP_HTTP_LIMITS.responseBytes + 1) } }) })
  await transport.start()
  let settled = false, closed = false
  const sending = transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: remoteName, arguments: { query: 'ordinary' } } }).catch(error => { settled = true; assert.match(error.message, /byte limit/) })
  await entered.promise; const closing = transport.close().then(() => { closed = true })
  await new Promise(done => setImmediate(done)); assert.equal(settled, false); assert.equal(closed, false)
  cancellation.resolve(); await Promise.all([sending, closing]); assert(settled); assert(closed)
})
for (const protocol of ['legacy', '2026-07-28']) test(`${protocol} successful HTTP SSE operation closes and drains its exact stream`, async t => {
  const cancellation = deferred(), entered = deferred(); let cancelled = 0
  const subject = await fixture(t, protocol, { effect: message => {
    const payload = { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'SSE_CONFIRMED' }], ...(protocol === 'legacy' ? {} : { resultType: 'complete' }) } }
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`)) },
      async cancel() { cancelled++; entered.resolve(); await cancellation.promise } }), { headers: { 'content-type': 'text/event-stream' } })
  } })
  let settled = false
  const pending = subject.manager.invoke(await subject.prepare(), signal(), () => {}).then(value => { settled = true; return value })
  await entered.promise; await new Promise(done => setImmediate(done)); assert.equal(settled, false); assert.equal(cancelled, 1)
  cancellation.resolve(); const outcome = await pending
  assert.equal(result(outcome).confirmedOutcome, true); assert.equal(subject.effects.length, 1); assert.equal(cancelled, 1)
  assert.equal(subject.manager.statuses()[0].state, 'connected')
})
for (const protocol of ['legacy', '2026-07-28']) test(`${protocol} completed metadata SSE is closed without a background stream`, async () => {
  const launch = await prepareMcpLaunch({ ...base, protocol }, 'config', {}, [], 'anonymous'), cancellation = deferred(), entered = deferred()
  let responses = 0
  const transport = new McpHttpTransport(launch, { beforeOperation: async () => {}, operationStarted: () => {}, fetch: async (input, init) => {
    const message = JSON.parse(init.body)
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } })}\n\n`)) },
      async cancel() { entered.resolve(); await cancellation.promise } }), { headers: { 'content-type': 'text/event-stream' } })
  } })
  transport.onmessage = () => { responses++ }
  await transport.start(); await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  await entered.promise
  let drained = false
  const draining = transport.drainCleanup().then(() => { drained = true })
  await new Promise(done => setImmediate(done)); assert.equal(drained, false); assert.equal(responses, 1)
  cancellation.resolve(); await draining; assert(drained); await transport.close()
})
test('legacy cancellation aborts the original owned metadata POST before headers', async () => {
  const launch = await prepareMcpLaunch({ ...base, protocol: 'legacy' }, 'config', {}, [], 'anonymous'), entered = deferred()
  let originalSignal, notifications = 0
  const transport = new McpHttpTransport(launch, { beforeOperation: async () => {}, operationStarted: () => {}, fetch: async (input, init) => {
    const message = JSON.parse(init.body)
    if (message.method === 'notifications/cancelled') { notifications++; return new Response(null, { status: 202 }) }
    originalSignal = init.signal; entered.resolve()
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('Owned fetch aborted')), { once: true }))
  } })
  await transport.start()
  const sending = assert.rejects(transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }), /aborted/)
  await entered.promise
  await transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })
  await sending; assert(originalSignal.aborted); assert.equal(notifications, 1); await transport.close()
})
test('cancelled modern metadata with 202 and no stream drops its owned request controller', async () => {
  const launch = await prepareMcpLaunch(base, 'config', {}, [], 'anonymous'), controller = new AbortController()
  const transport = new McpHttpTransport(launch, { beforeOperation: async () => {}, operationStarted: () => {}, fetch: async () => new Response(null, { status: 202 }) })
  await transport.start(); await transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { requestSignal: controller.signal })
  assert.equal(transport.requestControllers.size, 1); controller.abort(); assert.equal(transport.requestControllers.size, 0)
  await transport.close()
})
for (const kind of ['tools', 'resourceTemplates']) test(`HTTP host retains exact human approval and durable ${kind} outcome evidence in Auto mode`, async t => {
  const { CliHost } = await import('../dist/host.js'), { FileSessionStore } = await import('../dist/session.js')
  const subject = await fixture(t, base.protocol, { templates: kind === 'resourceTemplates' }), operation = await subject.prepare(kind), approvals = []
  let rounds = 0, reviews = 0
  const host = await CliHost.create({ store: new FileSessionStore(join(subject.directory, 'sessions')), mcp: subject.manager,
    settings: { provider: 'openai', model: 'owned-fixture' }, approve: async request => { approvals.push(request); return true },
    decisionReview: { canAutoReview: true, accountRevision: () => 'owned-fixture-account', provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { reviews++; throw new Error('MCP must remain human-reviewed') } }, ledger: { async upsert() { throw new Error('MCP must never enter Auto audit') } } },
    provider: { async generate() { return ++rounds === 1 ? { content: '', toolCalls: [{ id: 'owned-http-host-call', name: operation.call.name, arguments: operation.call.arguments }] }
      : { content: 'Owned HTTP host complete', toolCalls: [] } } } })
  t.after(() => host.shutdown())
  host.setApprovalMode('auto')
  assert.equal(host.approvalMode, 'auto')
  const completed = await host.send('Use the owned HTTP fixture')
  assert.equal(completed.status, 'completed'); assert.equal(approvals.length, 1); assert.equal(reviews, 0); assert.equal(subject.effects.length, 1)
  assert.equal(approvals[0].call.name, operation.call.name); assert.match(approvals[0].description, /one attempt/)
  assert.match(JSON.stringify(completed.history), kind === 'tools' ? /HTTP_CONFIRMED/ : /HTTP_RESOURCE/)
  if (kind === 'resourceTemplates') {
    assert(approvals[0].description.includes(expandedUri)); assert.equal(subject.effects[0].params.uri, expandedUri)
    assert(JSON.stringify(host.conversationRecords.projection).includes(expandedUri))
  }
  assert(host.conversationRecords.projection.outcomes.some(item => item.effect === 'unknown' && item.status === 'succeeded'))
})
