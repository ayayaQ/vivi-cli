// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { McpConfigStore } from '../dist/mcp-config.js'
import { McpManager } from '../dist/mcp-manager.js'
import { manageMcp } from '../dist/mcp-controls.js'
import { McpStdioTransport } from '../dist/mcp-transport.js'

// Replace only the owned-process startup boundary. Real start/send/receive/close/dispose run;
// no process, Windows helper, network, model or provider is used by this fixture.
function injectedOwnedTransport(launch, stop) {
  const transport = new McpStdioTransport(launch), stdout = new PassThrough(), stderr = new PassThrough()
  const methods = []
  let complete, starts = 0
  const completed = new Promise(resolve => { complete = resolve })
  const owned = { stdout, stderr, completed, stop: async () => {
    await stop(); stdout.end(); stderr.end(); complete({ exitCode: 0 })
  }, write: async bytes => {
    const message = JSON.parse(bytes.toString('utf8'))
    methods.push(message.method)
    if (message.id === undefined) return
    const result = message.method === 'initialize' ? { resultType: 'complete', protocolVersion: '2025-11-25',
      capabilities: { tools: {} }, serverInfo: { name: 'Owned inert peer', version: '1' } }
      : { resultType: 'complete', tools: [{ name: 'never-show-revoked-metadata', inputSchema: { type: 'object' } }] }
    queueMicrotask(() => stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n'))
  } }
  transport.beginStart = async () => {
    starts++; transport.windows = owned
    stdout.on('data', chunk => transport.receive(chunk))
  }
  return { transport, owned, methods, starts: () => starts }
}

async function managerFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-final-validation-')), store = new McpConfigStore(directory)
  const transports = []
  const manager = new McpManager({ store, env: {}, transportFactory: launch => {
    const subject = injectedOwnedTransport(launch, async () => {})
    transports.push(subject); return subject.transport
  } })
  t.after(async () => {
    await manager.close(); await Promise.all(transports.map(subject => subject.transport.close()))
    await rm(directory, { recursive: true, force: true })
  })
  const script = fileURLToPath(new URL('./fixtures/mcp-discovery-server.mjs', import.meta.url))
  await manager.configure({ id: 'docs', label: 'Owned inert peer', executable: process.execPath,
    args: [...(process.versions.bun ? ['--no-install'] : []), script], cwd: directory, protocol: 'legacy', environment: [] })
  return { manager, store, transports }
}

for (const cleanup of ['reject', 'throw']) test(`failed legacy handshake observes SDK cleanup while retaining strict host cleanup failures (${cleanup})`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-sdk-cleanup-'))
  const store = new McpConfigStore(directory), failure = new Error('Owned inert cleanup fixture failed')
  let starts = 0, closes = 0, failCleanup = true
  const methods = [], unhandled = []
  const onUnhandled = error => { unhandled.push(error) }
  process.on('unhandledRejection', onUnhandled)
  const transport = {
    async start() { starts++ },
    async send(message) {
      methods.push(message.method)
      if (message.method === 'initialize') queueMicrotask(() => transport.onmessage?.({
        jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Owned inert handshake failure' },
      }))
    },
    close() {
      closes++
      if (failCleanup) {
        if (cleanup === 'throw') throw failure
        return Promise.reject(failure)
      }
      transport.onclose?.()
      return Promise.resolve()
    },
  }
  const manager = new McpManager({ store, env: {}, transportFactory: () => transport })
  t.after(async () => {
    failCleanup = false
    try { await manager.close() }
    finally { process.off('unhandledRejection', onUnhandled); await rm(directory, { recursive: true, force: true }) }
  })
  const script = fileURLToPath(new URL('./fixtures/mcp-discovery-server.mjs', import.meta.url))
  await manager.configure({ id: 'docs', label: 'Owned inert peer', executable: process.execPath,
    args: [...(process.versions.bun ? ['--no-install'] : []), script], cwd: directory, protocol: 'legacy', environment: [] })
  await assert.rejects(manager.connect('docs', async () => true, new AbortController().signal), error => error === failure)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
  assert.equal(starts, 1); assert.deepEqual(methods, ['initialize']); assert.ok(closes >= 2)
  assert.equal(manager.statuses()[0].state, 'error')
  await assert.rejects(manager.connect('docs', async () => true, new AbortController().signal), /Disable/)
  await assert.rejects(manager.disconnect('docs'), error => error === failure)
  await assert.rejects(manager.close(), error => error === failure)
  assert.equal(starts, 1)
  failCleanup = false
  await manager.close()
  assert.equal(manager.statuses()[0].state, 'disabled')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(unhandled, [])
})

function gateFinalConfigurationRead(store) {
  const load = store.load.bind(store)
  let reads = 0, entered, release
  const ready = new Promise(resolve => { entered = resolve }), held = new Promise(resolve => { release = resolve })
  store.load = async () => {
    const configuration = await load()
    // connect's third read is the final post-approval configuration revalidation.
    if (++reads === 3) { entered(); await held }
    return configuration
  }
  return { ready, release }
}

test('shutdown resolved during final configuration validation prevents any subsequent transport creation or start', async t => {
  const subject = await managerFixture(t), gate = gateFinalConfigurationRead(subject.store)
  t.after(() => gate.release())
  let approvals = 0
  const pending = subject.manager.connect('docs', async () => { approvals++; return true }, new AbortController().signal)
  await gate.ready
  assert.equal(approvals, 1); assert.equal(subject.transports.length, 0)
  await subject.manager.close()
  assert.equal(subject.transports.length, 0)
  gate.release()
  await assert.rejects(pending, /manager is closed/)
  assert.equal(subject.transports.length, 0); assert.equal(subject.manager.statuses()[0].state, 'disabled')
})

test('overlapping approved connects reserve one same-ID connection after final configuration validation', async t => {
  const subject = await managerFixture(t), gate = gateFinalConfigurationRead(subject.store)
  t.after(() => gate.release())
  let approvals = 0
  const approve = async () => { approvals++; return true }
  const pending = subject.manager.connect('docs', approve, new AbortController().signal)
  await gate.ready
  assert.equal(await subject.manager.connect('docs', approve, new AbortController().signal), true)
  const connected = subject.manager.statuses()[0].snapshot
  assert.equal(approvals, 2); assert.equal(subject.transports.length, 1)
  gate.release()
  await assert.rejects(pending, /launch changed/)
  assert.equal(subject.transports.length, 1); assert.equal(subject.transports[0].starts(), 1)
  assert.equal(subject.manager.statuses()[0].state, 'connected')
  assert.equal(subject.manager.statuses()[0].snapshot.connectionGeneration, connected.connectionGeneration)
})

test('real stdio disposal retries a rejected owned stop, deduplicates concurrent close, and stays closed', async () => {
  let stops = 0, notifications = 0, enter, rejectStop
  const entered = new Promise(resolve => { enter = resolve })
  const failure = new Promise((_, reject) => { rejectStop = reject })
  const subject = injectedOwnedTransport({}, async () => { if (++stops === 1) { enter(); await failure } })
  const transport = subject.transport
  transport.onclose = () => { notifications++ }
  await transport.start()
  const first = transport.close()
  assert.equal(transport.close(), first)
  await entered; assert.equal(stops, 1)
  rejectStop(new Error('Owned fixture stop temporarily failed'))
  await assert.rejects(first, /temporarily failed/)
  assert.equal(transport.windows, subject.owned); assert.equal(notifications, 1)
  await assert.rejects(transport.start(), /cannot be restarted/)
  await assert.rejects(transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), /connection is closed/)
  const second = transport.close()
  assert.notEqual(second, first); assert.equal(transport.close(), second)
  await second
  assert.equal(stops, 2); assert.equal(notifications, 1); assert.equal(subject.starts(), 1)
  assert.equal(transport.close(), second); await transport.close(); assert.equal(stops, 2)
  await assert.rejects(transport.start(), /cannot be restarted/)
  await assert.rejects(transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), /connection is closed/)
})

for (const failure of ['signal', 'verification']) test(`POSIX cleanup retries never re-signal a cached group ID after ${failure} failure`, async () => {
  const group = 2147483647, calls = [], transport = new McpStdioTransport({})
  const child = { pid: group, exitCode: 0, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() }
  let verifiedDead = false, notifications = 0
  const kill = process.kill
  process.kill = (pid, signal) => {
    assert.equal(pid, -group, 'Only the inert fixture group may be addressed')
    calls.push(signal)
    if (signal === 0) {
      const error = new Error('Owned fixture group verification remains ambiguous')
      error.code = verifiedDead ? 'ESRCH' : 'EPERM'
      throw error
    }
    assert(['SIGTERM', 'SIGKILL'].includes(signal))
    if (failure === 'signal') { const error = new Error('Owned fixture signal failed'); error.code = 'EPERM'; throw error }
    return true
  }
  transport.child = child
  transport.onclose = () => { notifications++ }
  try {
    await assert.rejects(transport.close(), failure === 'signal' ? /cleanup could not be verified/ : /verification remains ambiguous/)
    const firstCalls = failure === 'signal' ? ['SIGTERM'] : ['SIGTERM', 'SIGKILL', 0]
    assert.deepEqual(calls, firstCalls)
    assert.equal(transport.child, child); assert.equal(transport.pid, group)
    const retry = transport.close()
    assert.equal(transport.close(), retry)
    await assert.rejects(retry, /verification remains ambiguous/)
    assert.deepEqual(calls, [...firstCalls, 0])
    assert.equal(transport.child, child); assert.equal(notifications, 1)
    await assert.rejects(transport.start(), /cannot be restarted/)
    await assert.rejects(transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), /connection is closed/)
    child.exitCode = null
    await assert.rejects(transport.close(), /cleanup timed out/)
    assert.deepEqual(calls, [...firstCalls, 0]); assert.equal(transport.child, child)
    child.exitCode = 0
    verifiedDead = true
    const complete = transport.close(); await complete
    assert.deepEqual(calls, [...firstCalls, 0, 0])
    assert.equal(transport.close(), complete); await transport.close()
    assert.equal(calls.length, firstCalls.length + 2); assert.equal(notifications, 1)
  } finally { process.kill = kill }
})

for (const surface of ['picker', 'line']) test(`${surface} cleanup UI retries actual retained stdio disposal without approval or restart`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-real-dispose-ui-')), store = new McpConfigStore(directory)
  let blocked = false, stops = 0, notifications = 0, reads = 0, subject
  const manager = new McpManager({ store, env: {}, transportFactory: launch => {
    subject = injectedOwnedTransport(launch, async () => {
      stops++; if (blocked) throw new Error('Private owned stop failure must not appear ' + 'x'.repeat(5000))
    })
    return subject.transport
  } })
  t.after(async () => { blocked = false; await manager.close(); await rm(directory, { recursive: true, force: true }) })
  const script = fileURLToPath(new URL('./fixtures/mcp-discovery-server.mjs', import.meta.url))
  await manager.configure({ id: 'docs', label: 'Owned inert peer', executable: process.execPath,
    args: [...(process.versions.bun ? ['--no-install'] : []), script], cwd: directory, protocol: 'legacy', environment: [] })
  assert.equal(await manager.connect('docs', async () => true, new AbortController().signal), true)
  assert(manager.statuses()[0].snapshot)
  const onclose = subject.transport.onclose
  subject.transport.onclose = () => { notifications++; onclose?.() }
  const file = join(directory, 'mcp-servers.json'), invalid = '{owned-invalid-configuration'
  await writeFile(file, invalid, { mode: 0o600 }); blocked = true
  const load = store.load.bind(store)
  store.load = async () => { reads++; return load() }
  store.save = async () => { throw new Error('Cleanup controls must never save configuration') }
  let selections = 0
  const select = () => {
    assert.equal(manager.statuses()[0].state, 'error'); assert.equal(manager.statuses()[0].snapshot, undefined)
    assert.equal(stops, selections + 1); assert.equal(subject.transport.windows, subject.owned)
    if (selections++) blocked = false
    return 'cleanup:docs'
  }
  const io = { output: '', approvals: 0, isClosed: false,
    write(value) { this.output += value }, approve: async () => { io.approvals++; return true },
    onCancel: () => () => {}, readLine: async () => { select(); return '2' } }
  if (surface === 'picker') io.choose = async (title, choices, initial) => {
    assert.match(title, /saved configuration unavailable/); assert.equal(initial, 0)
    assert.deepEqual(choices.map(choice => choice.value), ['back', 'cleanup:docs'])
    return select()
  }
  await assert.rejects(manageMcp(manager, io), /saved configuration remains unavailable or invalid/)
  assert.equal(selections, 2); assert.equal(stops, 3); assert.equal(reads, 1)
  assert.equal(subject.starts(), 1); assert.equal(io.approvals, 0); assert.equal(notifications, 1)
  assert.equal(manager.statuses()[0].state, 'disabled'); assert.equal(manager.statuses()[0].snapshot, undefined)
  assert.match(io.output, /owned connection retained for explicit Disable retry/)
  assert.match(io.output, /owned connection cleanup completed/)
  assert(!io.output.includes('never-show-revoked-metadata')); assert(!io.output.includes('Private owned stop failure'))
  assert(!io.output.includes('Add trusted installed server'))
  assert.deepEqual(subject.methods, ['initialize', 'notifications/initialized', 'tools/list'])
  assert.equal(await readFile(file, 'utf8'), invalid)
  await assert.rejects(subject.transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' }), /connection is closed/)
  await subject.transport.close(); assert.equal(stops, 3)
})

test('owned transport permits exact invocation requests but rejects all other client workflows', async () => {
  const subject = injectedOwnedTransport({}, async () => {})
  await subject.transport.start()
  try {
    for (const method of ['tools/call', 'resources/read']) await subject.transport.send({ jsonrpc: '2.0', id: method, method,
      params: method === 'tools/call' ? { name: 'owned/name', arguments: {} } : { uri: 'fixture:///owned' } })
    assert.deepEqual(subject.methods, ['tools/call', 'resources/read'])
    for (const method of ['prompts/list', 'prompts/get', 'resources/subscribe', 'subscriptions/listen', 'sampling/createMessage', 'elicitation/create', 'roots/list']) {
      await assert.rejects(subject.transport.send({ jsonrpc: '2.0', id: 'forbidden', method }), /MCP request is unsupported/)
    }
    assert.deepEqual(subject.methods, ['tools/call', 'resources/read'])
  } finally { await subject.transport.close() }
})
