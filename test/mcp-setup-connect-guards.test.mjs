// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpConfigStore } from '../dist/mcp-config.js'
import { McpManager } from '../dist/mcp-manager.js'
import { McpHttpTransport } from '../dist/mcp-http-transport.js'
import { McpSetupService } from '../dist/mcp-setup.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const signal = () => new AbortController().signal
const body = result => JSON.parse(result.content)

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-setup-connect-guard-')), store = new McpConfigStore(directory)
  const state = { current: true, approved: false, starts: 0, closes: 0, factories: 0 }, frames = [], afterStale = [], approvals = [], effects = []
  const executable = join(directory, process.platform === 'win32' ? 'installed-fixture.exe' : 'installed-fixture')
  await writeFile(executable, 'Owned inert installed fixture. Never executed by these synthetic transports.', { mode: 0o700 })
  const server = options.http ? { transport: 'http', id: 'docs', label: 'Owned HTTP fixture', endpoint: 'https://mcp.guard.fixture.invalid/mcp',
    protocol: options.protocol ?? 'legacy', allowLoopbackHttp: false }
    : { id: 'docs', label: 'Owned installed fixture', executable, args: [], cwd: directory, protocol: 'legacy', environment: [] }
  const response = method => method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} },
    serverInfo: { name: 'Synthetic peer', version: '1' } }
    : method === 'server/discover' ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} } }
    : method === 'tools/list' ? { tools: [{ name: 'fixture_echo', inputSchema: { type: 'object', properties: {} } }] }
    : method === 'resources/list' ? { resources: [] }
    : method === 'tools/call' ? { content: [{ type: 'text', text: 'CONFIRMED_OFFLINE' }] } : undefined
  const record = message => { frames.push(message.method); if (!state.current) afterStale.push(message.method) }
  const manager = new McpManager({ store, env: {}, ...(options.nativeHttp ? { httpFetch: async (_input, init) => {
    const message = JSON.parse(init.body); record(message)
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 })
    let result = response(message.method)
    if (server.protocol !== 'legacy') result = { ...result, resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
    return Response.json({ jsonrpc: '2.0', id: message.id, result })
  } } : { transportFactory() {
    state.factories++; options.factory?.(state)
    const transport = { async start() { state.starts++; if (options.start) await options.start(state) },
      async close() { state.closes++; transport.onclose?.() }, async send(message) {
        record(message); options.send?.(message, state)
        if (message.id !== undefined) queueMicrotask(() => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result: response(message.method) }))
      } }
    return transport
  } }) })
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }) })
  await manager.configure(server)
  const guard = { assertCurrent() { if (!state.current) throw new Error('Setup owner is no longer current') } }
  const io = { get isClosed() { return false }, write() {}, event() {}, result() {}, async readLine() {},
    async approve() { assert.fail('Approval must use the trusted service context') }, onCancel() { return () => {} }, close() {} }
  const context = { io, ...guard, async approve(request) { approvals.push(request.call.name)
    if (request.call.name === 'connect_mcp_server') state.approved = true
    return true
  }, async beforeEffect() {}, effect(receipt) { effects.push(receipt) }, async settle() {} }
  const service = new McpSetupService(manager)
  const direct = () => manager.connect('docs', async () => { state.approved = true; return true }, signal(), guard)
  const throughService = async () => service.executeSetup({ id: 'owned-setup', name: 'mcp_setup', arguments: {
    action: 'connect', id: 'docs', expectedRevision: (await store.load()).revision } }, signal(), context)
  return { directory, store, manager, server, state, frames, afterStale, approvals, effects, guard, direct, throughService, executable }
}

for (const surface of ['manager', 'service']) for (const phase of ['reload', 'launch-preparation', 'final-disk-load']) {
  test(`${surface} invalidation during post-approval ${phase} prevents native startup and all protocol sends`, async t => {
    const subject = await fixture(t), entered = deferred(), held = deferred()
    if (phase === 'launch-preparation') {
      const handle = await open(subject.executable, 'r'), prototype = Object.getPrototypeOf(handle), original = prototype.stat
      const executableInfo = await stat(subject.executable)
      await handle.close()
      let paused = false
      t.mock.method(prototype, 'stat', async function (...args) {
        const info = await original.apply(this, args)
        if (subject.state.approved && !paused && info.dev === executableInfo.dev && info.ino === executableInfo.ino) {
          paused = true; entered.resolve(); await held.promise
        }
        return info
      })
    } else {
      const load = subject.store.load.bind(subject.store), pauseAt = phase === 'reload' ? 1 : 2
      let reads = 0
      subject.store.load = async () => { const current = await load()
        if (subject.state.approved && ++reads === pauseAt) { entered.resolve(); await held.promise }
        return current
      }
    }
    const pending = surface === 'manager' ? subject.direct() : subject.throughService()
    // Attach rejection observation before releasing the failed owner boundary.
    const observed = pending.then(value => ({ value }), error => ({ error }))
    await entered.promise; subject.state.current = false; held.resolve()
    const outcome = await observed
    if (surface === 'manager') assert.match(outcome.error?.message ?? '', /owner is no longer current/)
    else { assert.equal(body(outcome.value).unknownOutcome, true); assert.equal(body(outcome.value).doNotRetry, true) }
    assert.equal(subject.state.starts, 0); assert.deepEqual(subject.frames, []); assert.deepEqual(subject.effects, [])
  })
}

test('owner invalidated by trusted transport construction is rechecked before calling native start', async t => {
  const subject = await fixture(t, { factory(state) { state.current = false } })
  assert.equal(await subject.direct(), false)
  assert.equal(subject.state.factories, 1); assert.equal(subject.state.starts, 0); assert.deepEqual(subject.frames, [])
})

test('service invalidation during delayed native readiness prevents every handshake frame', async t => {
  const entered = deferred(), held = deferred(), subject = await fixture(t, { async start() { entered.resolve(); await held.promise } })
  const pending = subject.throughService()
  await entered.promise; subject.state.current = false; held.resolve()
  const outcome = body(await pending)
  assert.equal(outcome.unknownOutcome, true); assert.equal(subject.state.starts, 1)
  assert.deepEqual(subject.frames, []); assert.deepEqual(subject.effects, []); assert(subject.state.closes > 0)
})

test('setup guard remains active for initial tools discovery after the handshake', async t => {
  const subject = await fixture(t, { send(message, state) { if (message.method === 'notifications/initialized') state.current = false } })
  assert.equal(await subject.direct(), false)
  assert.deepEqual(subject.frames, ['initialize', 'notifications/initialized'])
  assert.deepEqual(subject.afterStale, [])
})

for (const protocol of ['legacy', '2026-07-28']) test(`${protocol} service invalidation while real HTTP SDK awaits token blocks actual fetch`, async t => {
  const entered = deferred(), held = deferred(), original = McpHttpTransport.prototype.start
  t.mock.method(McpHttpTransport.prototype, 'start', async function () {
    const provider = this.sdk._authProvider, token = provider.token.bind(provider)
    provider.token = async () => { entered.resolve(); await held.promise; return token() }
    return original.call(this)
  })
  const subject = await fixture(t, { http: true, nativeHttp: true, protocol }), pending = subject.throughService()
  await entered.promise; subject.state.current = false; held.resolve()
  const outcome = body(await pending)
  assert.equal(outcome.unknownOutcome, true); assert.equal(outcome.doNotRetry, true)
  assert.deepEqual(subject.frames, []); assert.deepEqual(subject.effects, [])
})

for (const transport of ['native', 'http']) test(`completed setup releases ${transport} guard for later user refresh and separately approved tools`, async t => {
  const subject = await fixture(t, transport === 'http' ? { http: true, nativeHttp: true } : {})
  assert.equal(await subject.direct(), true)
  subject.state.current = false
  await subject.manager.refresh('docs', ['tools', 'resources'], signal())
  assert.equal(subject.manager.statuses()[0].state, 'connected')
  const [snapshot] = await subject.manager.captureCatalogs(signal()), entry = snapshot.categories.tools.entries[0]
  const operation = await subject.manager.prepareOperation(snapshot, entry, 'tools', { id: 'later-user-call', name: entry.alias, arguments: {} })
  const outcome = body(await subject.manager.invoke(operation, signal(), () => {}))
  assert.equal(outcome.success, true); assert.equal(outcome.confirmedOutcome, true)
  assert(subject.afterStale.includes('tools/list')); assert(subject.afterStale.includes('resources/list')); assert(subject.afterStale.includes('tools/call'))
})
