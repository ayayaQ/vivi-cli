// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { Client, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/client'
import { CliHost } from '../dist/host.js'
import { McpManager } from '../dist/mcp-manager.js'
import { McpConfigStore } from '../dist/mcp-config.js'
import { mcpAlias } from '../dist/mcp-catalog.js'
import { FileMcpOutcomeStore, McpOutcomeCommitError } from '../dist/mcp-outcomes.js'
import { FileSessionStore, newSession, validateSession } from '../dist/session.js'
import { mcpContainsSecret } from '../dist/mcp-content.js'
import { TerminalIO, sendChatTurn } from '../dist/terminal.js'

const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn)
const settings = { provider: 'openai', model: 'owned-offline-fixture' }
const remoteName = 'owned/outcome-operation'
const alias = mcpAlias('fixture', 'tools', remoteName)
const resourceUri = 'fixture://owned/exact-resource'
const toolCall = (id = 'owned-call-1', name = alias, arguments_ = { query: 'exact owned arguments' }) => ({ id, name, arguments: arguments_ })
const answer = (toolCalls = [], content = '') => ({ content, toolCalls })
const signal = () => new AbortController().signal
const invocationMethods = new Set(['tools/call', 'resources/read'])

function gate(t) {
  let enter, release
  const entered = new Promise(resolve => { enter = resolve })
  const wait = new Promise(resolve => { release = resolve })
  t.after(() => release())
  return { entered, enter, wait, release }
}

/** Actual CLI + shared runAgent + pinned SDK; only the peer/provider/storage hooks are fake. */
async function fixture(t, input = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-owned-mcp-outcome-'))
  const sessionDirectory = join(directory, 'sessions')
  const secrets = input.secrets ?? [], frames = [], approvals = [], providerInputs = [], notices = [], writes = []
  const state = { rounds: 0, closes: 0, starts: 0 }
  const sessionStore = new FileSessionStore(sessionDirectory, secrets)
  const outcomes = new FileMcpOutcomeStore(sessionDirectory, secrets)
  if (input.saveSession) {
    const save = sessionStore.save.bind(sessionStore)
    sessionStore.save = async (session, options) => {
      await input.saveSession(session, options, subject)
      return save(session, options)
    }
  }
  const outcomeStore = input.saveOutcome ? {
    load: id => outcomes.load(id),
    addSecrets: values => outcomes.addSecrets?.(values),
    drain: () => outcomes.drain?.(),
    async save(id, records, options) {
      writes.push(structuredClone(records))
      return input.saveOutcome(id, records, options, outcomes, subject)
    }
  } : outcomes
  const config = new McpConfigStore(join(directory, 'config'), secrets)
  let peer
  const manager = new McpManager({ store: config, env: {}, secrets, transportFactory: () => {
    state.starts++
    peer = {
      async start() {},
      async close() { state.closes++; peer.onclose?.() },
      async send(message) {
        if (!message.method || message.id === undefined) return
        if (invocationMethods.has(message.method)) {
          frames.push(structuredClone(message))
          const result = input.invoke ? await input.invoke(message, subject) : message.method === 'resources/read'
            ? { contents: [{ uri: resourceUri, text: 'CONFIRMED_OWNED_RESOURCE' }] }
            : { content: [{ type: 'text', text: 'CONFIRMED_OWNED_RESPONSE' }] }
          if (result === undefined) return
          queueMicrotask(() => peer.onmessage?.({ jsonrpc: '2.0', id: message.id, result: { ...result, resultType: 'complete' } }))
          return
        }
        let result
        if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'Owned offline fixture', version: '1' } }
        else if (message.method === 'server/discover') result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} }, ttlMs: 0, cacheScope: 'private' }
        else if (message.method === 'tools/list') result = { tools: [{ name: remoteName, inputSchema: {
          type: 'object', properties: { query: { type: 'string', maxLength: 100 } }, required: ['query'], additionalProperties: false
        } }] }
        else if (message.method === 'resources/list') result = { resources: [{ name: 'Owned exact resource', uri: resourceUri }] }
        else if (message.method === 'resources/templates/list') result = { resourceTemplates: [] }
        else { queueMicrotask(() => peer.onmessage?.({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported owned fixture method' } })); return }
        queueMicrotask(() => peer.onmessage?.({ jsonrpc: '2.0', id: message.id, result: { ...result,
          ...(message.method.endsWith('/list') ? { ttlMs: 0, cacheScope: 'private' } : {}), resultType: 'complete' } }))
      }
    }
    return peer
  } })
  const server = { id: 'fixture', label: 'Owned offline fixture', executable: process.execPath,
    args: process.versions.bun ? ['--no-install', fileURLToPath(import.meta.url)] : [],
    cwd: directory, protocol: input.protocol ?? 'legacy', environment: [] }
  await manager.configure(server)
  assert.equal(await manager.connect(server.id, async () => true, signal()), true)
  if (input.resource) await manager.refresh(server.id, ['resources'], signal())
  const streamIn = new PassThrough(), streamOut = new PassThrough()
  let output = ''
  streamOut.on('data', bytes => { output += bytes.toString() })
  const io = new TerminalIO({ input: streamIn, output: streamOut, tui: false, stream: false, secrets })
  const options = {
    session: newSession(settings), store: sessionStore, mcp: manager, secrets,
    // Omitting this option exercises the production FileSessionStore auto-wiring.
    ...(input.saveOutcome || input.explicitOutcomes ? { mcpOutcomes: outcomeStore } : {}),
    provider: { async generate(value) {
      state.rounds++; providerInputs.push(structuredClone(value))
      return input.generate ? input.generate(value, subject) : state.rounds === 1
        ? answer([input.resource ? toolCall('owned-resource-call', 'read_mcp_resource', { serverId: server.id, uri: resourceUri }) : toolCall()])
        : answer([], 'Owned fixture finished')
    } },
    async approve(request, abortSignal) {
      approvals.push(structuredClone(request))
      return input.approve ? input.approve(request, abortSignal, subject) : true
    },
    onMcpNotice(message) { notices.push(message); io.write(`${message}\n`) },
    async onEvent(event) { await input.onEvent?.(event, subject); io.event(event) }
  }
  const host = new CliHost(options)
  const subject = { directory, sessionDirectory, sessionStore, outcomes, outcomeStore, config, server, manager, host, options,
    secrets, state, frames, approvals, providerInputs, notices, writes, io, output: () => output,
    async send(prompt = 'Run the exact owned fixture operation') {
      const result = await sendChatTurn(host, io, prompt); io.result(result); return result
    },
    async changeConfig() { const current = await config.load(); await config.save([{ ...server, label: 'Changed during owned fixture wait' }], current.revision) },
    notify() { peer.onmessage?.({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) },
    respond(message, result) { peer.onmessage?.({ jsonrpc: '2.0', id: message.id, result: { ...result, resultType: 'complete' } }) },
    protocolError(message, error) { peer.onmessage?.({ jsonrpc: '2.0', id: message.id, error }) }
  }
  t.after(async () => { io.close(); streamIn.destroy(); streamOut.destroy(); await host.shutdown(); await manager.close(); await rm(directory, { recursive: true, force: true }) })
  return subject
}

function resultOf(value, callId = 'owned-call-1') {
  const history = Array.isArray(value) ? value : value.history
  const result = history.find(message => message.kind === 'tool_result' && message.callId === callId)
  assert(result, `missing canonical result for ${callId}`)
  const call = history.flatMap(message => message.kind === 'assistant' ? message.toolCalls : []).find(call => call.id === callId)
  assert(call, `missing canonical call for ${callId}`)
  assert.equal(result.name, call.name)
  return { message: result, body: JSON.parse(result.content) }
}
function notSent(value, callId) {
  const { message, body } = resultOf(value, callId)
  assert.equal(message.isError, true)
  assert.equal(body.requestSent, false)
  assert.notEqual(body.unknownOutcome, true)
  assert.notEqual(body.doNotRetry, true)
  return body
}
function unknown(value, callId) {
  const { message, body } = resultOf(value, callId)
  assert.equal(message.isError, true)
  assert.equal(body.unknownOutcome, true)
  assert.equal(body.doNotRetry, true)
  assert.notEqual(body.requestSent, false)
  return body
}
function confirmed(value, callId, text = 'CONFIRMED_OWNED_RESPONSE') {
  const { message, body } = resultOf(value, callId)
  assert.notEqual(message.isError, true)
  assert.equal(body.success, true)
  assert.notEqual(body.unknownOutcome, true)
  assert.notEqual(body.requestSent, false)
  assert(JSON.stringify(body).includes(text))
  return body
}
async function resume(t, subject) {
  const providerInputs = [], store = new FileSessionStore(subject.sessionDirectory, subject.secrets)
  const host = await CliHost.resume({ id: subject.host.session.id, store, secrets: subject.secrets,
    provider: { async generate(value) { providerInputs.push(structuredClone(value)); return answer([], 'Read-only continuation') } } })
  t.after(() => host.shutdown())
  return { host, store, providerInputs }
}

for (const change of ['abort', 'configuration', 'manager', 'tools']) test(`actual CLI before-review-send ${change} persists definite no-send`, async t => {
  const subject = await fixture(t, { async approve(_request, _signal, subject) {
    if (change === 'abort') subject.host.cancel()
    else if (change === 'configuration') await subject.changeConfig()
    else if (change === 'manager') subject.options.mcp = undefined
    else subject.options.enableTools = false
    return true
  } })
  const result = await subject.send()
  assert.equal(result.status, change === 'abort' ? 'cancelled' : 'completed')
  assert.equal(subject.frames.length, 0); assert.equal(subject.approvals.length, 1)
  notSent(result)
  notSent((await subject.sessionStore.load(subject.host.session.id)).history)
  assert.match(subject.output(), /not sent|not attempted|no remote request/i)
  const restored = await resume(t, subject)
  notSent(restored.host.session.history)
  await restored.host.send('Continue without repeating the operation')
  notSent(restored.providerInputs[0].messages)
  assert.equal(subject.frames.length, 0); assert.equal(subject.approvals.length, 1)
})

test('actual CLI abort in tool_started is definitely unattempted before MCP execution enters', async t => {
  const subject = await fixture(t, { onEvent(event, subject) { if (event.type === 'tool_started') subject.host.cancel() } })
  const result = await subject.send()
  assert.equal(result.status, 'cancelled'); assert.equal(subject.frames.length, 0); assert.equal(subject.approvals.length, 0)
  notSent(result)
  const persisted = await subject.sessionStore.load(subject.host.session.id)
  notSent(persisted.history); validateSession(persisted)
  const restored = await resume(t, subject)
  notSent(restored.host.session.history)
  await restored.host.send('Continue without repeating the unentered operation')
  notSent(restored.providerInputs[0].messages)
  assert.equal(subject.frames.length, 0); assert.equal(subject.approvals.length, 0)
})

test('actual CLI accepted no-send evidence survives tool_started abort and a failed terminal checkpoint', async t => {
  const subject = await fixture(t, {
    onEvent(event, subject) { if (event.type === 'tool_started') subject.host.cancel() },
    async saveSession(session) { if (session.history.some(message => message.kind === 'tool_result')) throw new Error('Owned unentered-call terminal checkpoint failure') }
  })
  const terminal = await subject.send().then(result => result, error => error)
  assert(terminal instanceof Error || terminal.status === 'error')
  assert.equal(subject.frames.length, 0); assert.equal(subject.approvals.length, 0)
  const records = await subject.outcomes.load(subject.host.session.id)
  assert.equal(records.length, 1); assert.equal(records[0].state, 'accepted')
  const reloaded = await new FileSessionStore(subject.sessionDirectory).load(subject.host.session.id)
  notSent(reloaded.history); validateSession(reloaded)
  const restored = await resume(t, subject)
  notSent(restored.host.session.history)
  await restored.host.send('Continue without executing the recovered unentered call')
  notSent(restored.providerInputs[0].messages)
  assert.equal(subject.frames.length, 0); assert.equal(subject.approvals.length, 0)
  assert.equal((await subject.outcomes.load(subject.host.session.id)).length, 0)
})

test('actual CLI abort after the first multicall frame marks later unentered MCP calls definitely unattempted', async t => {
  const subject = await fixture(t, {
    generate(_value, subject) { return subject.state.rounds === 1 ? answer([toolCall('entered-first'), toolCall('unentered-second'), toolCall('unentered-third')]) : answer([], 'Continuation only') },
    async invoke(_message, subject) { queueMicrotask(() => subject.host.cancel()); return undefined }
  })
  const result = await subject.send()
  assert.equal(result.status, 'cancelled'); assert.equal(subject.frames.length, 1); assert.equal(subject.approvals.length, 1)
  unknown(result, 'entered-first'); notSent(result, 'unentered-second'); notSent(result, 'unentered-third')
  const persisted = await subject.sessionStore.load(subject.host.session.id)
  validateSession(persisted)
  unknown(persisted.history, 'entered-first'); notSent(persisted.history, 'unentered-second'); notSent(persisted.history, 'unentered-third')
  const restored = await resume(t, subject)
  await restored.host.send('Continue without replaying any prior multicall request')
  unknown(restored.providerInputs[0].messages, 'entered-first'); notSent(restored.providerInputs[0].messages, 'unentered-second'); notSent(restored.providerInputs[0].messages, 'unentered-third')
  assert.equal(subject.frames.length, 1); assert.equal(subject.approvals.length, 1)
})

for (const resource of [false, true]) test(`actual CLI ${resource ? 'resource read' : 'tool call'} abort after exactly one frame retains unknown effects across next run`, async t => {
  const subject = await fixture(t, { resource, async invoke(_message, subject) { queueMicrotask(() => subject.host.cancel()); return undefined } })
  const callId = resource ? 'owned-resource-call' : 'owned-call-1'
  const result = await subject.send()
  assert.equal(result.status, 'cancelled'); assert.equal(subject.frames.length, 1)
  assert.equal(subject.frames[0].method, resource ? 'resources/read' : 'tools/call')
  unknown(result, callId)
  const persisted = await subject.sessionStore.load(subject.host.session.id)
  validateSession(persisted); unknown(persisted.history, callId)
  assert.match(subject.output(), /unconfirmed|unknown|uncertain/i)
  assert.match(subject.output(), /do not retry/i)
  assert.equal(subject.manager.statuses()[0].state, 'error')
  await subject.host.send('Continue without retrying the unknown operation')
  assert.equal(subject.frames.length, 1); assert.equal(subject.approvals.length, 1)
  const restored = await resume(t, subject)
  unknown(restored.host.session.history, callId)
  await restored.host.send('Read-only restart continuation')
  unknown(restored.providerInputs[0].messages, callId)
  assert.equal(subject.frames.length, 1)
})

test('actual CLI confirmed SDK response wins a same-frame cancellation race', async t => {
  const subject = await fixture(t, { async invoke(message, subject) {
    subject.respond(message, { content: [{ type: 'text', text: 'CONFIRMED_BEFORE_CANCELLATION' }] })
    subject.host.cancel()
    return undefined
  } })
  const result = await subject.send()
  assert.equal(result.status, 'cancelled'); assert.equal(subject.frames.length, 1)
  const body = confirmed(result, 'owned-call-1', 'CONFIRMED_BEFORE_CANCELLATION')
  assert.equal(body.requestSent, true); assert.equal(body.doNotRetry, true)
  const restored = await resume(t, subject)
  confirmed(restored.host.session.history, 'owned-call-1', 'CONFIRMED_BEFORE_CANCELLATION')
  await restored.host.send('Continue from the confirmed response without repeating it')
  confirmed(restored.providerInputs[0].messages, 'owned-call-1', 'CONFIRMED_BEFORE_CANCELLATION')
  assert.equal(subject.frames.length, 1)
})

test('actual CLI bounded protocol error remains confirmed through cancellation without retaining peer details', async t => {
  const secret = 'OWNED_FAKE_PEER_ERROR_CREDENTIAL'
  const subject = await fixture(t, { secrets: [secret], async saveOutcome(id, records, options, base) {
    if (records.some(record => record.state === 'settled')) throw new Error('Owned protocol-error settlement persistence failure')
    return base.save(id, records, options)
  }, async invoke(message, subject) {
    subject.protocolError(message, { code: -32603, message: secret, data: { privateDetails: secret } })
    subject.host.cancel()
    return undefined
  } })
  const result = await subject.send()
  assert.equal(result.status, 'cancelled'); assert.equal(subject.frames.length, 1)
  const { message, body } = resultOf(result)
  assert.equal(message.isError, true); assert.equal(body.success, false)
  assert.equal(body.requestSent, true); assert.equal(body.confirmedOutcome, true); assert.equal(body.doNotRetry, true)
  assert.notEqual(body.unknownOutcome, true)
  assert(!mcpContainsSecret([result.history, subject.output(), subject.providerInputs], [secret]))
  const restored = await resume(t, subject)
  const persisted = resultOf(restored.host.session.history).body
  assert.equal(persisted.confirmedOutcome, true); assert.equal(persisted.requestSent, true)
  assert.equal(subject.frames.length, 1)
})

for (const change of ['abort', 'configuration']) test(`actual CLI rechecks ${change} after delayed pinned SDK call setup`, async t => {
  const blocked = gate(t), original = Client.prototype.callTool
  t.mock.method(Client.prototype, 'callTool', async function (...args) { blocked.enter(); await blocked.wait; return original.apply(this, args) })
  const subject = await fixture(t)
  let finished = false
  const pending = subject.send(); pending.then(() => { finished = true }, () => { finished = true }); await blocked.entered
  assert.equal(subject.frames.length, 0)
  if (change === 'abort') subject.host.cancel(); else await subject.changeConfig()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false, 'the host must drain owned MCP setup before returning')
  blocked.release()
  const result = await pending
  assert.equal(subject.frames.length, 0)
  notSent(result); notSent((await subject.sessionStore.load(subject.host.session.id)).history)
})

for (const change of ['abort', 'configuration', 'manager', 'catalog']) test(`actual CLI final ${change} guard runs after durable intent persistence`, async t => {
  const blocked = gate(t)
  let paused = false
  const subject = await fixture(t, { async saveOutcome(id, records, options, base) {
    await base.save(id, records, options)
    if (!paused && records.some(record => record.state === 'intent')) { paused = true; blocked.enter(); await blocked.wait }
  } })
  const pending = subject.send(); await blocked.entered
  assert.equal(subject.frames.length, 0)
  assert((await subject.outcomes.load(subject.host.session.id)).some(record => record.state === 'intent'))
  if (change === 'abort') subject.host.cancel()
  else if (change === 'configuration') await subject.changeConfig()
  else if (change === 'manager') subject.options.mcp = undefined
  else { subject.notify(); await new Promise(resolve => setImmediate(resolve)) }
  blocked.release()
  const result = await pending
  assert.equal(subject.frames.length, 0)
  notSent(result); notSent((await subject.sessionStore.load(subject.host.session.id)).history)
  assert.equal((await subject.outcomes.load(subject.host.session.id)).length, 0)
})

test('actual CLI shutdown drains delayed intent and does not resurrect a revoked run', async t => {
  const blocked = gate(t)
  let paused = false, turnFinished = false, shutdownFinished = false
  const subject = await fixture(t, { async saveOutcome(id, records, options, base) {
    await base.save(id, records, options)
    if (!paused && records.some(record => record.state === 'intent')) { paused = true; blocked.enter(); await blocked.wait }
  } })
  const pending = subject.send(); pending.then(() => { turnFinished = true }, () => { turnFinished = true })
  await blocked.entered
  const closing = subject.host.shutdown(); closing.then(() => { shutdownFinished = true }, () => { shutdownFinished = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(turnFinished, false); assert.equal(shutdownFinished, false); assert.equal(subject.frames.length, 0)
  blocked.release()
  const result = await pending; await closing
  assert.equal(result.status, 'cancelled'); notSent(result)
  notSent((await subject.sessionStore.load(subject.host.session.id)).history)
  assert.equal(subject.frames.length, 0)
  await assert.rejects(subject.host.send('A closed run must stay closed'), /shut down/)
})

test('actual CLI abort and shutdown await intent persistence that has not reached its durable replacement', async t => {
  const blocked = gate(t)
  let paused = false, turnFinished = false, shutdownFinished = false
  const subject = await fixture(t, { async saveOutcome(id, records, options, base) {
    if (!paused && records.some(record => record.state === 'intent')) { paused = true; blocked.enter(); await blocked.wait }
    return base.save(id, records, options)
  } })
  const pending = subject.send(); pending.then(() => { turnFinished = true }, () => { turnFinished = true })
  await blocked.entered
  const admitted = await subject.outcomes.load(subject.host.session.id)
  assert(admitted.some(record => record.callId === 'owned-call-1' && record.state === 'accepted'))
  assert(!admitted.some(record => record.state === 'intent'))
  subject.host.cancel()
  const closing = subject.host.shutdown(); closing.then(() => { shutdownFinished = true }, () => { shutdownFinished = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(turnFinished, false); assert.equal(shutdownFinished, false); assert.equal(subject.frames.length, 0)
  blocked.release()
  const result = await pending; await closing
  assert.equal(result.status, 'cancelled'); notSent(result)
  notSent((await subject.sessionStore.load(subject.host.session.id)).history)
  assert.equal(subject.frames.length, 0)
})

test('actual CLI delayed intent consumes one permit and sends the exact modern SDK envelope', async t => {
  const blocked = gate(t)
  let paused = false
  const subject = await fixture(t, { protocol: '2026-07-28', async saveOutcome(id, records, options, base) {
    await base.save(id, records, options)
    if (!paused && records.some(record => record.state === 'intent')) { paused = true; blocked.enter(); await blocked.wait }
  } })
  const pending = subject.send(); await blocked.entered
  assert.equal(subject.frames.length, 0)
  blocked.release()
  const result = await pending
  assert.equal(result.status, 'completed'); assert.equal(subject.frames.length, 1); assert.equal(subject.approvals.length, 1)
  assert.deepEqual(subject.frames[0].params, { name: remoteName, arguments: { query: 'exact owned arguments' }, _meta: {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_INFO_META_KEY]: { name: 'vivi-cli-discovery', version: '0.1.0-dev.0' }, [CLIENT_CAPABILITIES_META_KEY]: {}
  } })
  assert(subject.writes.some(records => records.some(record => record.state === 'intent')))
  assert(subject.writes.some(records => records.some(record => record.state === 'settled')))
  confirmed(result)
  assert.equal((await subject.outcomes.load(subject.host.session.id)).length, 0)
})

for (const committed of [false, true]) test(`actual CLI ${committed ? 'uncertain committed' : 'failed'} send-intent persistence records no-send without attempting a frame`, async t => {
  const subject = await fixture(t, { async saveOutcome(id, records, options, base) {
    if (records.some(record => record.state === 'intent')) {
      if (committed) { await base.save(id, records, options); throw new McpOutcomeCommitError(new Error('Owned fixture durability confirmation failure')) }
      throw new Error('Owned fixture intent persistence failure')
    }
    return base.save(id, records, options)
  } })
  const result = await subject.send()
  assert.equal(subject.frames.length, 0); assert.equal(subject.approvals.length, 1)
  notSent(result)
  const restored = await resume(t, subject)
  notSent(restored.host.session.history)
  await restored.host.send('Continue without executing the failed-persistence proposal')
  notSent(restored.providerInputs[0].messages)
  assert.equal(subject.frames.length, 0)
})

test('actual CLI newly-known request credential during delayed intent preserves matched no-send privacy recovery', async t => {
  const blocked = gate(t), secrets = []
  let paused = false
  const subject = await fixture(t, { secrets, async saveOutcome(id, records, options, base) {
    await base.save(id, records, options)
    if (!paused && records.some(record => record.state === 'intent')) { paused = true; blocked.enter(); await blocked.wait }
  } })
  const pending = subject.send(); await blocked.entered
  secrets.push('exact owned arguments')
  blocked.release()
  const result = await pending
  assert.equal(subject.frames.length, 0)
  notSent(result)
  const persisted = await subject.sessionStore.load(subject.host.session.id)
  validateSession(persisted); notSent(persisted.history)
  assert(!mcpContainsSecret([result.history, persisted.history], secrets))
  const call = persisted.history.flatMap(message => message.kind === 'assistant' ? message.toolCalls : []).find(call => call.id === 'owned-call-1')
  assert.equal(call.arguments.mcpRequestWithheld, true)
  const restored = await resume(t, subject)
  notSent(restored.host.session.history)
  await restored.host.send('Continue with the privacy-screened prior result')
  notSent(restored.providerInputs[0].messages)
  assert(!mcpContainsSecret(restored.providerInputs, secrets))
  assert.equal(subject.frames.length, 0)
})

test('actual CLI failed outcome write keeps confirmed terminal history on restart', async t => {
  const subject = await fixture(t, { async saveOutcome(id, records, options, base) {
    if (records.some(record => record.state === 'settled')) throw new Error('Owned fixture settlement persistence failure')
    return base.save(id, records, options)
  } })
  const result = await subject.send()
  assert.equal(subject.frames.length, 1); confirmed(result)
  const restored = await resume(t, subject)
  confirmed(restored.host.session.history)
  await restored.host.send('Continue after the confirmed saved result')
  confirmed(restored.providerInputs[0].messages)
  assert.equal(subject.frames.length, 1)
})

for (const settlementFails of [false, true]) test(`actual CLI failed terminal checkpoint recovers ${settlementFails ? 'unsettled intent conservatively' : 'confirmed exact outcome'} without replay`, async t => {
  const subject = await fixture(t, {
    async saveSession(session) {
      if (session.history.some(message => message.kind === 'tool_result')) throw new Error('Owned fixture terminal checkpoint failure')
    },
    async saveOutcome(id, records, options, base) {
      if (settlementFails && records.some(record => record.state === 'settled')) throw new Error('Owned fixture outcome checkpoint failure')
      return base.save(id, records, options)
    }
  })
  // A failed checkpoint may be returned as a runner error or reject the host's final save.
  const terminal = await subject.send().then(result => result, error => error)
  assert(terminal instanceof Error || terminal.status === 'error')
  assert.equal(subject.frames.length, 1)
  const raw = JSON.parse(await readFile(join(subject.sessionDirectory, `${subject.host.session.id}.json`), 'utf8'))
  assert(raw.history.some(message => message.kind === 'assistant' && message.toolCalls.some(call => call.id === 'owned-call-1')))
  assert(!raw.history.some(message => message.kind === 'tool_result'))
  const pending = await subject.outcomes.load(subject.host.session.id)
  assert.equal(pending.length, 1); assert.equal(pending[0].state, settlementFails ? 'intent' : 'settled')
  assert.equal(pending[0].callId, 'owned-call-1'); assert.equal(pending[0].toolName, alias)
  // The normal application reload path must recover before first transcript display.
  const reloaded = await new FileSessionStore(subject.sessionDirectory).load(subject.host.session.id)
  ;(settlementFails ? unknown : confirmed)(reloaded.history)
  const restored = await resume(t, subject)
  ;(settlementFails ? unknown : confirmed)(restored.host.session.history)
  await restored.host.send('Continue without reissuing the operation after restart')
  ;(settlementFails ? unknown : confirmed)(restored.providerInputs[0].messages)
  assert.equal(subject.frames.length, 1); assert.equal(subject.approvals.length, 1)
  assert.equal((await subject.outcomes.load(subject.host.session.id)).length, 0)
})

test('actual CLI same-alias calls preserve exact pairing when the later call is cancelled', async t => {
  const subject = await fixture(t, {
    generate(_value, subject) {
      return subject.state.rounds === 1 ? answer([toolCall('owned-first'), toolCall('owned-second')]) : answer([], 'Continuation only')
    },
    async invoke(_message, subject) {
      if (subject.frames.length === 1) return { content: [{ type: 'text', text: 'CONFIRMED_FIRST_CALL' }] }
      queueMicrotask(() => subject.host.cancel()); return undefined
    }
  })
  const result = await subject.send()
  assert.equal(result.status, 'cancelled'); assert.equal(subject.frames.length, 2)
  confirmed(result, 'owned-first', 'CONFIRMED_FIRST_CALL'); unknown(result, 'owned-second')
  const restored = await resume(t, subject)
  validateSession(restored.host.session)
  confirmed(restored.host.session.history, 'owned-first', 'CONFIRMED_FIRST_CALL'); unknown(restored.host.session.history, 'owned-second')
  await restored.host.send('Continue with the exact matched prior results')
  confirmed(restored.providerInputs[0].messages, 'owned-first', 'CONFIRMED_FIRST_CALL'); unknown(restored.providerInputs[0].messages, 'owned-second')
  assert.equal(subject.frames.length, 2); assert.equal(subject.approvals.length, 2)
})

test('actual CLI near-64KiB confirmed response survives persistence and SDK/provider context without clipped outcome JSON', async t => {
  const text = `${'x'.repeat(65000)}OWNED_BOUNDARY_END`
  const subject = await fixture(t, { invoke: async () => ({ content: [{ type: 'text', text }] }) })
  const result = await subject.send()
  const { message, body } = resultOf(result)
  assert.equal(body.content[0].text, text)
  assert(Buffer.byteLength(message.content) > 64 * 1024 - 1024)
  assert(Buffer.byteLength(message.content) <= 64 * 1024)
  confirmed(result, 'owned-call-1', 'OWNED_BOUNDARY_END')
  assert.equal(resultOf(subject.providerInputs[1].messages).body.content[0].text, text)
  const restored = await resume(t, subject)
  assert.equal(resultOf(restored.host.session.history).body.content[0].text, text)
  assert.equal(subject.frames.length, 1)
})

test('actual CLI marker-budget withholding preserves known success at the 64KiB projection boundary', async t => {
  const emptyProjection = { success: true, source: 'mcp', untrusted: true, serverId: 'fixture', method: 'tools/call', remoteKey: remoteName, content: [{ type: 'text', text: '' }] }
  const text = 'x'.repeat(64 * 1024 - Buffer.byteLength(JSON.stringify(emptyProjection)) - 1)
  assert.equal(Buffer.byteLength(JSON.stringify({ ...emptyProjection, content: [{ type: 'text', text }] })), 64 * 1024 - 1)
  const subject = await fixture(t, { invoke: async () => ({ content: [{ type: 'text', text }] }) })
  const result = await subject.send()
  const { message, body } = resultOf(result)
  assert.notEqual(message.isError, true); assert.equal(body.success, true)
  assert.equal(body.requestSent, true); assert.equal(body.confirmedOutcome, true)
  assert.equal(body.contentWithheld, true); assert.equal(body.doNotRetry, true)
  assert.notEqual(body.unknownOutcome, true)
  assert(Buffer.byteLength(message.content) <= 64 * 1024)
  const restored = await resume(t, subject)
  const persisted = resultOf(restored.host.session.history).body
  assert.equal(persisted.success, true); assert.equal(persisted.confirmedOutcome, true)
  assert.equal(persisted.contentWithheld, true); assert.equal(persisted.doNotRetry, true)
  assert.equal(subject.frames.length, 1)
})

test('actual CLI late credential withholding retains confirmed privacy and no-retry markers near 64KiB', async t => {
  const secret = 'OWNED_FAKE_CREDENTIAL_MARKER', secrets = []
  const text = `${'x'.repeat(65000)}${secret}`
  const subject = await fixture(t, { secrets, invoke: async () => ({ content: [{ type: 'text', text }] }),
    onEvent(event) { if (event.type === 'tool_completed') secrets.push(secret) }
  })
  const result = await subject.send()
  const { body } = resultOf(result)
  assert.equal(body.success, true); assert.equal(body.contentWithheld, true)
  assert.equal(body.confirmedOutcome, true); assert.equal(body.doNotRetry, true)
  assert.notEqual(body.unknownOutcome, true)
  assert(!mcpContainsSecret([result.history, subject.host.session.history, subject.providerInputs, subject.output()], secrets))
  const restored = await resume(t, subject)
  const persisted = resultOf(restored.host.session.history).body
  assert.equal(persisted.confirmedOutcome, true); assert.equal(persisted.contentWithheld, true); assert.equal(persisted.doNotRetry, true)
  assert(!mcpContainsSecret(restored.host.session, secrets))
  assert.equal(subject.frames.length, 1)
})

test('actual CLI corrected cancellation-result callback cannot leave newly-known encoded credentials in returned or reloaded history', async t => {
  const secret = 'OWNED FINAL CALLBACK CREDENTIAL', encoded = encodeURIComponent(secret), secrets = []
  let correctedEvents = 0
  const subject = await fixture(t, { secrets, async invoke(message, subject) {
    subject.respond(message, { content: [{ type: 'text', text: encoded }] })
    subject.host.cancel(); return undefined
  }, onEvent(event) {
    if (event.type === 'tool_completed' && ++correctedEvents === 1) secrets.push(secret)
  } })
  const result = await subject.send()
  assert.equal(result.status, 'cancelled'); assert.equal(subject.frames.length, 1)
  assert(correctedEvents >= 1)
  const { body } = resultOf(result)
  assert.equal(body.success, true); assert.equal(body.contentWithheld, true)
  assert.equal(body.confirmedOutcome, true); assert.equal(body.doNotRetry, true)
  assert.notEqual(body.unknownOutcome, true)
  const persisted = await new FileSessionStore(subject.sessionDirectory, secrets).load(subject.host.session.id)
  const storedBody = resultOf(persisted.history).body
  assert.equal(storedBody.confirmedOutcome, true); assert.equal(storedBody.contentWithheld, true); assert.equal(storedBody.doNotRetry, true)
  assert(!mcpContainsSecret([result.history, subject.host.session.history, persisted.history], secrets))
  const restored = await resume(t, subject)
  await restored.host.send('Continue with the confirmed privacy-screened result')
  assert(!mcpContainsSecret(restored.providerInputs, secrets))
  assert.equal(subject.frames.length, 1)
})
