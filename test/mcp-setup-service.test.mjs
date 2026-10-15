// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { McpConfigCommitError, McpConfigStore, mcpDigest } from '../dist/mcp-config.js'
import { McpConfigurationChangeError, McpManager } from '../dist/mcp-manager.js'
import { McpSetupService } from '../dist/mcp-setup.js'

const signal = () => new AbortController().signal
const http = (id = 'docs') => ({ transport: 'http', id, label: 'Docs', endpoint: `https://${id}.example.test/mcp`,
  protocol: 'legacy', allowLoopbackHttp: false })
const body = result => JSON.parse(result.content)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const call = (revision, action = 'add', extra = {}) => ({ id: 'setup-owned-call', name: 'mcp_setup', arguments: {
  action, id: 'docs', expectedRevision: revision, ...(action === 'add' ? { endpoint: http().endpoint, protocol: 'legacy' } : {}), ...extra } })

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-setup-service-')), store = new McpConfigStore(directory)
  const methods = [], transportState = { starts: 0, closes: 0, blockClose: false }, invalidations = []
  const manager = new McpManager({ store, env: {}, httpAuthorizationInvalidated: async (id, reason) => {
    invalidations.push({ id, reason }); if (options.invalidate) await options.invalidate(id, reason)
  }, transportFactory: () => {
    const transport = { async start() { transportState.starts++ }, async close() {
      transportState.closes++
      if (transportState.blockClose) throw new Error('Private untrusted cleanup diagnostic')
      transport.onclose?.()
    }, async send(message) {
      if (!message.method) return
      methods.push(message.method)
      if (message.id === undefined) return
      const result = message.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} },
        serverInfo: { name: 'Synthetic fixture', version: '1' } } : { tools: [] }
      queueMicrotask(() => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result }))
    } }
    return transport
  } })
  t.after(async () => { transportState.blockClose = false; await manager.close().catch(() => undefined); await rm(directory, { recursive: true, force: true }) })
  const service = new McpSetupService(manager, options.oauth)
  const events = [], approvals = [], effects = [], settlements = [], state = { current: true, closed: false, approval: true }
  const io = { get isClosed() { return state.closed }, write() {}, event() {}, result() {}, async readLine() {},
    async approve() { assert.fail('All approval must use the trusted context') }, onCancel() { return () => {} }, close() { state.closed = true } }
  const context = { io, assertCurrent() { if (!state.current) throw new Error('Stale setup owner') },
    async approve(request, approvalSignal) { events.push('approval'); approvals.push(request)
      return options.approve ? options.approve(request, approvalSignal) : state.approval },
    async beforeEffect() { events.push('intent'); if (options.intent) await options.intent() },
    effect(receipt) { events.push(receipt.kind); effects.push(receipt); options.effect?.(receipt) },
    async settle(result) { events.push('settled'); settlements.push(result)
      if (body(result).confirmedOutcome === true) assert.equal(body(result).doNotRetry, true, 'Confirmed setup receipts must prohibit replay')
      if (options.settle) await options.settle(result) } }
  return { directory, store, manager, service, state, context, approvals, effects, settlements, events, methods, transportState, invalidations,
    revision: async () => (await store.load()).revision,
    async run(action = 'add', extra = {}, ownedSignal = signal()) { return service.executeSetup(call(await this.revision(), action, extra), ownedSignal, context) } }
}

test('first-turn local list loads fresh saved entries without reload, auth, network, catalog or writes', async t => {
  const subject = await fixture(t)
  await subject.store.save([http()], await subject.revision())
  assert.equal(subject.manager.configurationRevision(), '')
  subject.manager.reload = async () => assert.fail('Local listing must not reload')
  const before = await readdir(subject.directory), bytes = await readFile(join(subject.directory, 'mcp-servers.json'))
  const result = await subject.service.listLocal(signal())
  assert.equal(result.revision, await subject.revision()); assert.deepEqual(result.servers.map(server => server.id), ['docs'])
  assert.equal(result.servers[0].state, 'disabled'); assert.equal(result.servers[0].nextAction, 'Connect')
  assert(Object.isFrozen(result.servers[0])); assert.deepEqual(subject.methods, []); assert.deepEqual(subject.invalidations, [])
  assert.deepEqual(await readdir(subject.directory), before); assert.deepEqual(await readFile(join(subject.directory, 'mcp-servers.json')), bytes)
})

test('fresh local projection of externally changed config disables stale status without disconnecting', async t => {
  const subject = await fixture(t)
  await subject.manager.configure(http()); assert.equal(await subject.manager.connect('docs', async () => true, signal()), true)
  const methods = [...subject.methods], closes = subject.transportState.closes, invalidations = subject.invalidations.length
  await subject.store.save([{ ...http(), label: 'New local label' }], await subject.revision())
  const local = await subject.service.listLocal(signal())
  assert.equal(local.servers[0].label, 'New local label'); assert.equal(local.servers[0].state, 'disabled')
  assert.equal(subject.manager.statuses()[0].state, 'connected')
  assert.deepEqual(subject.methods, methods); assert.equal(subject.transportState.closes, closes); assert.equal(subject.invalidations.length, invalidations)
  await writeFile(join(subject.directory, 'mcp-servers.json'), '{private-invalid-config', { mode: 0o600 })
  await assert.rejects(subject.service.listLocal(signal()))
  assert.equal(subject.transportState.closes, closes); assert.equal(subject.invalidations.length, invalidations)
})

test('add uses exact human proposal review, durable intent and known disabled save in order', async t => {
  const subject = await fixture(t), originalRevision = await subject.revision()
  const response = body(await subject.run('add', { label: 'Visible\u202e label' }))
  assert.equal(response.success, true); assert.equal(response.confirmedOutcome, true); assert.equal(response.configSaved, true)
  assert.equal(response.doNotRetry, true)
  assert.equal(response.configRevision, await subject.revision()); assert.notEqual(response.configRevision, originalRevision)
  assert.deepEqual(subject.events, ['approval', 'intent', 'configuration-saved', 'settled'])
  assert.equal(subject.approvals[0].call.name, 'mcp_setup'); assert.equal(subject.approvals[0].call.arguments.expectedRevision, originalRevision)
  assert.match(subject.approvals[0].description, /disabled HTTPS/); assert.match(subject.approvals[0].description, /\\u202e/)
  assert.match(subject.approvals[0].currentRevision, /^[a-f0-9]{64}$/)
  assert.equal(subject.manager.statuses()[0].state, 'disabled'); assert.equal(subject.transportState.starts, 0)
})

for (const extra of [{ endpoint: 'http://127.0.0.1/mcp' }, { endpoint: 'https://user:password@example.test/mcp' },
  { endpoint: 'https://example.test/mcp?token=private' }, { allowLoopbackHttp: true }, { headers: {} },
  { executable: process.execPath }, { environment: ['HOME'] }, { settings: {} }, { approved: true },
  { protocol: 'other' }, { label: '' }, { id: 'UPPER' }, { expectedRevision: 'not-a-revision' }]) {
  test(`invalid agent add fields have no review or effects: ${Object.keys(extra).join(',')}`, async t => {
    const subject = await fixture(t), response = body(await subject.run('add', extra))
    assert.equal(response.notAttempted, true); assert.equal(response.requestSent, false)
    assert.deepEqual(subject.approvals, []); assert.deepEqual(subject.effects, []); assert.equal((await subject.store.load()).servers.length, 0)
  })
}

test('stale model revision, duplicate add and absent removal are rejected before human review', async t => {
  const subject = await fixture(t), empty = await subject.revision()
  await subject.manager.configure(http())
  for (const request of [call(empty), call(await subject.revision()), call(await subject.revision(), 'remove', { id: 'absent' }),
    call(await subject.revision(), 'connect', { endpoint: http().endpoint })]) {
    assert.equal(body(await subject.service.executeSetup(request, signal(), subject.context)).notAttempted, true)
  }
  assert.deepEqual(subject.approvals, []); assert.deepEqual(subject.effects, [])
})

for (const stop of ['deny', 'closed', 'abort', 'stale-owner', 'revision-change', 'intent-failure']) {
  test(`${stop} prevents setup commit and transport startup`, async t => {
    const controller = new AbortController()
    const subject = await fixture(t, { async approve() {
      if (stop === 'closed') subject.state.closed = true
      if (stop === 'abort') controller.abort()
      if (stop === 'stale-owner') subject.state.current = false
      if (stop === 'revision-change') await subject.store.save([http('changed')], await subject.revision())
      return stop !== 'deny'
    }, async intent() { if (stop === 'intent-failure') throw new Error('Synthetic durable persistence failure') } })
    const response = body(await subject.run('add', {}, controller.signal))
    assert.equal(response.notAttempted, true); assert.equal(response.requestSent, false); assert.deepEqual(subject.effects, [])
    assert.equal((await subject.store.load()).servers.some(server => server.id === 'docs'), false); assert.equal(subject.transportState.starts, 0)
    assert(!subject.events.includes('configuration-saved'))
  })
}

test('mutating retained input during local preparation cannot change the approved or saved proposal', async t => {
  const subject = await fixture(t), request = call(await subject.revision()), held = deferred(), ready = deferred()
  const original = subject.manager.localStatuses.bind(subject.manager)
  let reads = 0
  subject.manager.localStatuses = async () => { if (++reads === 1) { ready.resolve(); await held.promise } return original() }
  const pending = subject.service.executeSetup(request, signal(), subject.context)
  await ready.promise; request.arguments.endpoint = 'https://replacement.example.test/mcp'; held.resolve()
  assert.equal(body(await pending).success, true)
  assert.equal(subject.approvals[0].call.arguments.endpoint, http().endpoint)
  assert.equal((await subject.store.load()).servers[0].endpoint, http().endpoint)
})

test('store repeats trusted owner guard immediately before rename', async t => {
  const subject = await fixture(t), revision = await subject.revision()
  let guards = 0
  await assert.rejects(subject.store.save([http()], revision, () => { if (++guards === 2) throw new Error('Owner cancelled at commit') }), /Owner cancelled/)
  assert.equal(guards, 2); assert.equal(await subject.revision(), revision)
  assert.deepEqual(await readdir(subject.directory), [])
})

test('store revision change at the final disk recheck prevents rename even after approval', async t => {
  const subject = await fixture(t), revision = await subject.revision(), load = subject.store.load.bind(subject.store)
  let reads = 0
  subject.store.load = async () => ++reads === 2 ? { revision: mcpDigest('changed'), servers: [] } : load()
  await assert.rejects(subject.store.save([http()], revision), /changed while saving/)
  assert.equal((await load()).revision, revision)
})

test('post-rename directory sync failure carries typed exact known commit evidence', { skip: process.platform === 'win32' }, async t => {
  const subject = await fixture(t), revision = await subject.revision(), handle = await open(subject.directory, 'r')
  const prototype = Object.getPrototypeOf(handle), sync = prototype.sync
  await handle.close()
  t.mock.method(prototype, 'sync', async function () { if ((await this.stat()).isDirectory()) throw new Error('Synthetic directory fsync failure'); return sync.call(this) })
  let evidence
  await assert.rejects(subject.store.save([http()], revision), error => { assert(error instanceof McpConfigCommitError); evidence = error.configuration; return true })
  assert.deepEqual(evidence.servers, [http()]); assert.equal(evidence.revision, await subject.revision()); assert(Object.isFrozen(evidence))
  assert.equal((await readdir(subject.directory)).includes('mcp-servers.lock'), false)
})

test('manager retains known saved revision and emits it before global invalidation failure', async t => {
  let fail = false
  const subject = await fixture(t, { invalidate() { if (fail) throw new Error('Private auth cleanup error') } })
  await subject.manager.configure(http()); await subject.manager.connect('docs', async () => true, signal())
  fail = true
  const receipts = []
  await assert.rejects(subject.manager.configure(http('added'), await subject.revision(), {
    assertCurrent() {}, saved(configuration) { receipts.push(configuration); assert.equal(subject.manager.configurationRevision(), configuration.revision) }
  }), error => error instanceof McpConfigurationChangeError && error.configuration.revision === receipts[0].revision)
  assert.equal(subject.manager.configurationRevision(), await subject.revision()); assert.equal(receipts.length, 1)
  assert.equal(subject.manager.statuses()[0].snapshot, undefined); assert.equal(subject.manager.statuses()[0].state, 'error')
  fail = false
})

test('remove discloses every globally affected ID and preserves confirmed saved config after cleanup fails', async t => {
  const subject = await fixture(t)
  await subject.manager.configure(http()); await subject.manager.configure(http('other'))
  await subject.manager.connect('docs', async () => true, signal()); subject.transportState.blockClose = true
  const response = body(await subject.run('remove'))
  assert.equal(response.success, false); assert.equal(response.confirmedOutcome, true); assert.equal(response.configSaved, true)
  assert.equal(response.cleanupUnverified, true); assert.equal(response.unknownOutcome, undefined)
  assert.deepEqual(response.affectedServerIds, ['docs', 'other']); assert.deepEqual(subject.effects[0].affectedServerIds, ['docs', 'other'])
  assert.match(subject.approvals[0].description, /other/); assert.deepEqual((await subject.store.load()).servers.map(server => server.id), ['other'])
  assert.equal(subject.manager.configurationRevision(), response.configRevision)
  const retained = subject.manager.statuses().find(status => status.server.id === 'docs')
  assert.equal(retained.state, 'error'); assert.equal(retained.snapshot, undefined); assert.match(retained.message, /Use Disable/)
  await assert.rejects(subject.manager.reload(), /cleanup could not be verified/)
  assert.equal(subject.manager.configurationRevision(), response.configRevision)
  subject.transportState.blockClose = false; await subject.manager.disconnect('docs')
  assert.equal(subject.manager.statuses().some(status => status.server.id === 'docs'), false)
})

test('known configuration save survives cancellation and stale owner during effect callback', async t => {
  const controller = new AbortController()
  const subject = await fixture(t, { effect() { controller.abort(); subject.state.current = false } })
  const response = body(await subject.run('add', {}, controller.signal))
  assert.equal(response.success, true); assert.equal(response.confirmedOutcome, true); assert.equal(response.configSaved, true)
  assert.equal(subject.settlements.length, 1); assert.equal(response.configRevision, await subject.revision())
})

test('host settlement failure leaves immediate known receipt available', async t => {
  const subject = await fixture(t, { settle() { throw new Error('Synthetic receipt persistence failure') } })
  await assert.rejects(subject.run(), /receipt persistence/)
  assert.equal(subject.effects.length, 1); assert.equal(subject.effects[0].kind, 'configuration-saved')
  assert.equal(subject.effects[0].revision, await subject.revision())
})

test('connect keeps fresh initial review and independent launch review before synthetic startup', async t => {
  const subject = await fixture(t)
  await subject.manager.configure(http())
  const response = body(await subject.run('connect'))
  assert.equal(response.success, true); assert.equal(response.confirmedOutcome, true); assert.equal(response.requestSent, true)
  assert.equal(response.doNotRetry, true)
  assert.deepEqual(subject.approvals.map(request => request.call.name), ['mcp_setup', 'connect_mcp_server'])
  assert.deepEqual(subject.events, ['approval', 'intent', 'approval', 'connected', 'settled'])
  assert.deepEqual(subject.methods, ['initialize', 'notifications/initialized', 'tools/list'])
})

test('denied deeper launch approval after durable intent remains conservative unknown', async t => {
  const subject = await fixture(t, { approve(request) { return request.call.name === 'mcp_setup' } })
  await subject.manager.configure(http())
  const response = body(await subject.run('connect'))
  assert.equal(response.unknownOutcome, true); assert.equal(response.doNotRetry, true); assert.equal(response.notAttempted, undefined)
  assert.equal(subject.transportState.starts, 0)
})

for (const completed of [false, true]) test(`synthetic login result ${completed} keeps independent browser approval and effect evidence`, async t => {
  const oauth = { status() { return { state: 'unconfigured', revision: 'anonymous' } },
    async guidedSignInAndConnect(id, io, ownedSignal) {
      assert.equal(id, 'docs'); assert.equal(await io.approve({ call: { id: 'browser-plan', name: 'sign_in_mcp_server', arguments: { serverId: id } },
        currentRevision: 'browser-plan', description: 'Synthetic exact issuer/scopes/browser plan' }, ownedSignal), true)
      return completed
    } }
  const subject = await fixture(t, { oauth })
  await subject.manager.configure(http())
  const response = body(await subject.run('login'))
  assert.deepEqual(subject.approvals.map(request => request.call.name), ['mcp_setup', 'sign_in_mcp_server'])
  assert.equal(response.confirmedOutcome, completed ? true : undefined); assert.equal(response.unknownOutcome, completed ? undefined : true)
  assert.equal(response.notAttempted, undefined)
})

test('login IO owner rejects a configuration adopted after the exact initial proposal', async t => {
  let discoveries = 0
  const oauth = { status() { return { state: 'unconfigured', revision: 'anonymous' } },
    async guidedSignInAndConnect(_id, io) {
      await subject.store.save([{ ...http(), endpoint: 'https://changed.example.test/mcp' }], await subject.revision())
      await subject.manager.reload()
      if (io.isClosed) throw new Error('Initial exact proposal is stale')
      discoveries++; return false
    } }
  const subject = await fixture(t, { oauth })
  await subject.manager.configure(http())
  const response = body(await subject.run('login'))
  assert.equal(discoveries, 0); assert.equal(response.unknownOutcome, true)
  assert.equal(subject.approvals.length, 1)
})

test('known connected and logged-out receipts survive immediate late cancellation', async t => {
  let controller = new AbortController()
  const subject = await fixture(t, { effect() { controller.abort() } })
  await subject.manager.configure(http())
  assert.equal(body(await subject.run('connect', {}, controller.signal)).confirmedOutcome, true)
  controller = new AbortController()
  const response = body(await subject.run('logout', {}, controller.signal))
  assert.equal(response.success, true); assert.equal(response.confirmedOutcome, true); assert.equal(response.effectReceipt.kind, 'logged-out')
  assert.equal(response.doNotRetry, true)
  assert.equal(subject.manager.statuses()[0].state, 'disabled')
})

for (const protocol of [undefined, 'auto', '2026-07-28', 'legacy']) test(`agent add reviews and saves protocol ${protocol ?? 'auto by default'} without connecting`, async t => {
  const subject = await fixture(t), request = call(await subject.revision())
  if (protocol === undefined) delete request.arguments.protocol
  else request.arguments.protocol = protocol
  const response = body(await subject.service.executeSetup(request, signal(), subject.context))
  assert.equal(response.success, true); assert.equal(subject.approvals.length, 1)
  const saved = await subject.store.load()
  assert.equal(saved.servers[0].protocol, protocol ?? 'auto')
  assert.match(subject.approvals[0].description, new RegExp(`"protocol":"${protocol ?? 'auto'}"`))
  assert.deepEqual(subject.approvals[0].call.arguments, request.arguments)
  assert.equal(subject.transportState.starts, 0); assert.deepEqual(subject.methods, [])
})

test('direct HTTP setup defaults to auto and retains explicit protocol overrides', async t => {
  const subject = await fixture(t)
  await subject.service.addHttp({ id: 'docs', endpoint: http().endpoint })
  assert.equal((await subject.store.load()).servers[0].protocol, 'auto')
  for (const protocol of ['2026-07-28', 'legacy', 'auto']) {
    await subject.service.remove('docs')
    await subject.service.addHttp({ id: 'docs', endpoint: http().endpoint, protocol })
    assert.equal((await subject.store.load()).servers[0].protocol, protocol)
  }
  assert.equal(subject.transportState.starts, 0); assert.deepEqual(subject.methods, [])
})
