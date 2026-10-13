// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isSpecType, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY, RELATED_TASK_META_KEY } from '@modelcontextprotocol/client'
import { McpConfigStore } from '../dist/mcp-config.js'
import { McpManager } from '../dist/mcp-manager.js'
import { MCP_OPERATION_LIMITS, projectMcpResult } from '../dist/mcp-content.js'

const timeout = { timeout: 15_000 }, secret = 'offline-known-secret-marker'
const remoteName = 'echo/name', uri = 'fixture:///exact'
const inputSchema = { type: 'object', properties: { query: { type: 'string', minLength: 1 } }, required: ['query'], additionalProperties: false }
const outputSchema = { type: 'object', properties: { echo: { type: 'string' } }, required: ['echo'], additionalProperties: false }
const signal = () => new AbortController().signal
const body = result => JSON.parse(result.content)
const success = kind => kind === 'tools' ? { content: [{ type: 'text', text: 'CONFIRMED_TOOL_RESPONSE' }], structuredContent: { echo: 'ordinary' } }
  : { contents: [{ uri, text: 'CONFIRMED_RESOURCE_RESPONSE' }] }
const wire = (kind, value = success(kind)) => ({ ...value, resultType: value.resultType ?? 'complete',
  ...(kind === 'resources' ? { ttlMs: 0, cacheScope: 'private' } : {}) })
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

/** Owned in-memory peer exercising the real SDK. No server process or network is used. */
async function fixture(t, protocol, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-boundary-'))
  const store = new McpConfigStore(directory, [secret]), requests = [], effects = [], events = []
  let transport, closed = false, closes = 0
  const manager = new McpManager({ store, env: {}, secrets: [secret], transportFactory() {
    transport = {
      async start() {},
      async close() { if (!closed) { closed = true; closes++; await options.onClose?.(); transport.onclose?.() } },
      async send(message) {
        if (!message.method || message.id === undefined) return
        requests.push(structuredClone(message))
        const frame = fields => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, ...fields })
        const raw = result => frame({ result })
        const kind = message.method === 'resources/read' ? 'resources' : 'tools'
        const reply = result => raw({ ...result, resultType: result.resultType ?? 'complete',
          ...(message.method.startsWith('resources/') || message.method === 'tools/list' ? { ttlMs: 0, cacheScope: 'private' } : {}) })
        if (['tools/call', 'resources/read'].includes(message.method)) {
          effects.push(structuredClone(message)); events.push('frame')
          if (options.onEffect) await options.onEffect({ message, kind, frame, raw, reply,
            error: error => frame({ error }), notify: () => transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) })
          else reply(success(kind))
        } else if (message.method === 'initialize') reply({ protocolVersion: '2025-11-25', capabilities: {
          tools: { listChanged: true }, resources: { listChanged: true } }, serverInfo: { name: 'Owned fixture', version: '1' } })
        else if (message.method === 'server/discover') reply({ supportedVersions: ['2026-07-28'],
          capabilities: { tools: { listChanged: true }, resources: { listChanged: true } }, ttlMs: 0, cacheScope: 'private' })
        else if (message.method === 'tools/list') reply({ tools: [{ name: remoteName, inputSchema, outputSchema }] })
        else if (message.method === 'resources/list') reply({ resources: [{ uri, name: 'Exact owned resource' }] })
        else assert.fail(`Unexpected owned request: ${message.method}`)
      }
    }
    return transport
  } })
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }) })
  const server = { id: 'fixture', label: 'Owned boundary fixture', executable: process.execPath,
    args: process.versions.bun ? ['--no-install', fileURLToPath(import.meta.url)] : [], cwd: directory, protocol, environment: [] }
  await manager.configure(server)
  assert.equal(await manager.connect(server.id, async () => true, signal()), true)
  await manager.refresh(server.id, ['resources'], signal())
  const [snapshot] = await manager.captureCatalogs(signal())
  return { manager, store, server, snapshot, protocol, requests, effects, events, closes: () => closes,
    prepare(kind = 'tools') {
      const entry = snapshot.categories[kind].entries[0]
      return manager.prepareOperation(snapshot, entry, kind, { id: `boundary-${kind}`,
        name: kind === 'tools' ? entry.alias : 'read_mcp_resource', arguments: kind === 'tools' ? { query: 'ordinary' } : { serverId: server.id, uri } })
    },
    notify() { transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) },
    changeConfig() { writeFileSync(join(directory, 'mcp-servers.json'),
      JSON.stringify({ schemaVersion: 1, servers: [{ ...server, label: 'Changed owned configuration' }] }), { mode: 0o600 }) } }
}
function lifecycle(subject, beforeSend = async () => {}, settle = async () => {}) {
  const settled = [], state = { intents: 0 }
  return { settled, state, hooks: {
    async beforeSend() { state.intents++; subject.events.push('intent'); await beforeSend() },
    async settle(result) { settled.push(structuredClone(result)); subject.events.push('settle'); await settle(result) }
  } }
}
function notSent(result) {
  assert.equal(result.isError, true); assert.equal(body(result).requestSent, false)
  assert.equal(body(result).unknownOutcome, undefined); assert.equal(body(result).doNotRetry, undefined)
}
function known(result, isError = false) {
  assert.equal(result.isError ?? false, isError); assert.equal(body(result).success, !isError)
  assert.equal(body(result).requestSent, true); assert.equal(body(result).confirmedOutcome, true)
  assert.equal(body(result).unknownOutcome, undefined); assert.equal(body(result).doNotRetry, true)
}
function unknown(result) {
  assert.equal(result.isError, true); assert.equal(body(result).requestSent, true)
  assert.equal(body(result).unknownOutcome, true); assert.equal(body(result).doNotRetry, true)
  assert.equal(body(result).confirmedOutcome, undefined)
  for (const value of [secret, 'WITHHOLD_INVALID', 'CONFIRMED_TOOL_RESPONSE', 'CONFIRMED_RESOURCE_RESPONSE']) assert(!result.content.includes(value))
}
function exactFrame(subject, kind = 'tools') {
  assert.equal(subject.effects.length, 1)
  assert.equal(subject.requests.filter(message => message.method === 'tools/list').length, 1)
  assert.equal(subject.requests.filter(message => message.method === 'resources/list').length, 1)
  const expected = kind === 'tools' ? { name: remoteName, arguments: { query: 'ordinary' } } : { uri }
  if (subject.protocol === '2026-07-28') expected._meta = {
    [PROTOCOL_VERSION_META_KEY]: subject.protocol, [CLIENT_INFO_META_KEY]: { name: 'vivi-cli-discovery', version: '0.1.0-dev.0' }, [CLIENT_CAPABILITIES_META_KEY]: {} }
  assert.equal(subject.effects[0].method, kind === 'tools' ? 'tools/call' : 'resources/read')
  assert.deepEqual(subject.effects[0].params, expected)
}
function settledOnce(persistence, result) { assert.deepEqual(persistence.settled, [result]) }

for (const protocol of ['legacy', '2026-07-28']) {
  for (const kind of ['tools', 'resources']) {
    for (const change of ['configuration', 'run', 'catalog', 'arguments credential', 'binding credential', 'snapshot credential', 'cancel']) {
      test(`${protocol} ${kind} rechecks ${change} after paused durable intent`, timeout, async t => {
        const subject = await fixture(t, protocol), entered = deferred(), release = deferred(), controller = new AbortController()
        const operation = subject.prepare(kind), persistence = lifecycle(subject, async () => { entered.resolve(); await release.promise })
        let current = true
        const pending = subject.manager.invoke(operation, controller.signal, () => { if (!current) throw new Error('Owned run changed') }, persistence.hooks)
        await entered.promise; assert.equal(subject.effects.length, 0)
        if (change === 'configuration') subject.changeConfig()
        else if (change === 'run') current = false
        else if (change === 'catalog') subject.notify()
        else if (change === 'arguments credential') subject.manager.addSecrets([kind === 'tools' ? 'ordinary' : uri])
        else if (change === 'binding credential') subject.manager.addSecrets([operation.binding.launchDigest])
        else if (change === 'snapshot credential') subject.manager.addSecrets([kind === 'tools' ? uri : remoteName])
        else controller.abort()
        release.resolve()
        const result = await pending; await tick()
        notSent(result); assert.equal(subject.effects.length, 0); assert.equal(persistence.state.intents, 1)
        settledOnce(persistence, result); assert.deepEqual(subject.events, ['intent', 'settle'])
      })
    }
    test(`${protocol} ${kind} a failed intent write prevents the frame`, timeout, async t => {
      const subject = await fixture(t, protocol), persistence = lifecycle(subject, async () => { throw new Error('Owned intent write failed') })
      const result = await subject.manager.invoke(subject.prepare(kind), signal(), () => {}, persistence.hooks)
      notSent(result); assert.equal(subject.effects.length, 0); settledOnce(persistence, result)
    })
    test(`${protocol} ${kind} cancellation drains paused intent before settlement`, timeout, async t => {
      const subject = await fixture(t, protocol), entered = deferred(), release = deferred(), controller = new AbortController()
      const persistence = lifecycle(subject, async () => { entered.resolve(); await release.promise })
      let resolved = false
      const pending = subject.manager.invoke(subject.prepare(kind), controller.signal, () => {}, persistence.hooks).then(result => { resolved = true; return result })
      await entered.promise; controller.abort()
      try { await tick(); assert.equal(resolved, false); assert.equal(persistence.settled.length, 0); assert.equal(subject.effects.length, 0) }
      finally { release.resolve() }
      const result = await pending; notSent(result); settledOnce(persistence, result)
    })
    test(`${protocol} ${kind} one sent frame then cancellation is unknown and cannot replay`, timeout, async t => {
      const received = deferred(), subject = await fixture(t, protocol, { onEffect() { received.resolve() } })
      const controller = new AbortController(), operation = subject.prepare(kind), persistence = lifecycle(subject)
      const pending = subject.manager.invoke(operation, controller.signal, () => {}, persistence.hooks)
      await received.promise; controller.abort()
      const result = await pending; unknown(result); exactFrame(subject, kind); settledOnce(persistence, result)
      assert.equal(subject.closes(), 1); assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
      const second = lifecycle(subject), retry = await subject.manager.invoke(operation, signal(), () => {}, second.hooks)
      notSent(retry); assert.equal(second.state.intents, 0); assert.equal(subject.effects.length, 1)
      await assert.rejects(subject.manager.connect('fixture', async () => true, signal()), /Disable/)
    })
    for (const confirmed of [false, true]) test(`${protocol} ${kind} owned close releases blocked transport write with ${confirmed ? 'known' : 'unknown'} outcome`, timeout, async t => {
      const controller = new AbortController(), received = deferred(), writeClosed = deferred()
      let subject
      subject = await fixture(t, protocol, { onClose() { writeClosed.resolve() }, async onEffect({ reply }) {
        if (confirmed) reply(success(kind))
        received.resolve(); await writeClosed.promise; subject.events.push('write-released')
      } })
      const persistence = lifecycle(subject), pending = subject.manager.invoke(subject.prepare(kind), controller.signal, () => {}, persistence.hooks)
      await received.promise; controller.abort()
      const result = await pending; if (confirmed) known(result); else unknown(result)
      exactFrame(subject, kind); settledOnce(persistence, result); assert.equal(subject.closes(), 1)
      assert.deepEqual(subject.events, ['intent', 'frame', 'write-released', 'settle'])
    })
    for (const change of ['cancel', 'catalog', 'configuration', 'run']) test(`${protocol} ${kind} confirmed response survives ${change}`, timeout, async t => {
      const controller = new AbortController()
      let subject, current = true
      subject = await fixture(t, protocol, { onEffect({ reply, notify }) {
        reply(success(kind))
        if (change === 'cancel') controller.abort()
        else if (change === 'catalog') notify()
        else if (change === 'configuration') subject.changeConfig()
        else current = false
      } })
      const persistence = lifecycle(subject), result = await subject.manager.invoke(subject.prepare(kind), controller.signal,
        () => { if (!current) throw new Error('Owned run changed') }, persistence.hooks)
      known(result); exactFrame(subject, kind); settledOnce(persistence, result)
      assert.match(result.content, kind === 'tools' ? /CONFIRMED_TOOL_RESPONSE/ : /CONFIRMED_RESOURCE_RESPONSE/)
    })
    test(`${protocol} ${kind} bounded protocol error is sanitized and confirmed without retry`, timeout, async t => {
      const subject = await fixture(t, protocol, { onEffect({ error }) { error({ code: -32020, message: `WITHHOLD_INVALID ${secret}`, data: { token: secret } }) } })
      const persistence = lifecycle(subject), result = await subject.manager.invoke(subject.prepare(kind), signal(), () => {}, persistence.hooks)
      known(result, true); assert.equal(body(result).error.code, 'mcp_protocol_error')
      assert(!result.content.includes(secret)); assert(!result.content.includes('WITHHOLD_INVALID'))
      exactFrame(subject, kind); settledOnce(persistence, result)
    })
    for (const order of ['result then error', 'error then result', 'invalid then valid', 'invalid error then valid', 'both then valid']) for (const cancel of [false, true]) {
      test(`${protocol} ${kind} first response stays latched: ${order}${cancel ? ', immediate abort' : ''}`, timeout, async t => {
        const controller = new AbortController(), valid = success(kind), protocolError = { code: -32020, message: 'WITHHOLD_INVALID' }
        const subject = await fixture(t, protocol, { onEffect({ reply, error, frame }) {
          if (order === 'result then error') { reply(valid); error(protocolError) }
          else if (order === 'error then result') { error(protocolError); reply(valid) }
          else if (order === 'invalid error then valid') { error({ code: -32020, message: 42 }); reply(valid) }
          else if (order === 'both then valid') { frame({ result: wire(kind), error: protocolError }); reply(valid) }
          else { reply(kind === 'tools' ? { ...valid, content: [{ type: 'image' }] } : { contents: [{ uri, text: 42 }] }); reply(valid) }
          if (cancel) controller.abort()
        } })
        const persistence = lifecycle(subject), result = await subject.manager.invoke(subject.prepare(kind), controller.signal, () => {}, persistence.hooks)
        if (order === 'result then error') known(result)
        else if (order === 'error then result') { known(result, true); assert.equal(body(result).error.code, 'mcp_protocol_error'); assert(!result.content.includes('CONFIRMED_')) }
        else unknown(result)
        assert(!result.content.includes('WITHHOLD_INVALID')); exactFrame(subject, kind); settledOnce(persistence, result)
      })
    }
  }
  for (const isError of [false, true]) {
    test(`${protocol} confirmed tool ${isError ? 'error' : 'success'} survives immediate abort`, timeout, async t => {
      const controller = new AbortController(), subject = await fixture(t, protocol, { onEffect({ reply }) {
        reply({ ...success('tools'), ...(isError ? { isError: true, structuredContent: { echo: 42 } } : {}) }); controller.abort()
      } })
      const persistence = lifecycle(subject), result = await subject.manager.invoke(subject.prepare(), controller.signal, () => {}, persistence.hooks)
      known(result, isError); exactFrame(subject); settledOnce(persistence, result)
    })
    test(`${protocol} failed settlement preserves confirmed tool ${isError ? 'error' : 'success'}`, timeout, async t => {
      const subject = await fixture(t, protocol, { onEffect({ reply }) { reply({ ...success('tools'), ...(isError ? { isError: true } : {}) }) } })
      const persistence = lifecycle(subject, async () => {}, async () => { throw new Error('Owned outcome checkpoint failed') })
      const result = await subject.manager.invoke(subject.prepare(), signal(), () => {}, persistence.hooks)
      known(result, isError); exactFrame(subject); settledOnce(persistence, result)
    })
    test(`${protocol} projection budget fallback preserves confirmed tool ${isError ? 'error' : 'success'}`, timeout, async t => {
      const response = { ...success('tools'), ...(isError ? { isError: true } : {}) }
      const baseline = projectMcpResult('fixture', 'tools/call', remoteName, response, [secret])
      response.content[0].text = 'x'.repeat(MCP_OPERATION_LIMITS.resultBytes - Buffer.byteLength(baseline.content) + response.content[0].text.length)
      assert.equal(Buffer.byteLength(projectMcpResult('fixture', 'tools/call', remoteName, response, [secret]).content), MCP_OPERATION_LIMITS.resultBytes)
      const subject = await fixture(t, protocol, { onEffect({ reply }) { reply(response) } })
      const persistence = lifecycle(subject), result = await subject.manager.invoke(subject.prepare(), signal(), () => {}, persistence.hooks)
      known(result, isError); assert.equal(body(result).contentWithheld, true)
      assert(Buffer.byteLength(result.content) <= MCP_OPERATION_LIMITS.resultBytes); exactFrame(subject); settledOnce(persistence, result)
    })
  }
  const malformedContent = {
    'image without data': { type: 'image', mimeType: 'image/png' }, 'image without MIME type': { type: 'image', data: 'aW1hZ2U=' },
    'audio without data': { type: 'audio', mimeType: 'audio/wav' }, 'audio without MIME type': { type: 'audio', data: 'YXVkaW8=' },
    'resource without content': { type: 'resource', resource: { uri } }, 'resource invalid text': { type: 'resource', resource: { uri, text: 42 } },
    'resource invalid MIME type': { type: 'resource', resource: { uri, text: 'WITHHOLD_INVALID', mimeType: 42 } },
    'resource link without name': { type: 'resource_link', uri }
  }
  const invalidTools = {
    'malformed envelope': { content: 'invalid' }, 'bad output schema': { ...success('tools'), structuredContent: { echo: 42 } },
    'missing structured output': { content: [{ type: 'text', text: 'WITHHOLD_INVALID' }] },
    'foreign result family': { ...success('tools'), task: { taskId: 'WITHHOLD_INVALID' } },
    'input required': { resultType: 'input_required', inputRequests: { fixture: {} } },
    'known credential': { ...success('tools'), content: [{ type: 'text', text: `${secret} invalid-%` }] },
    'too many items': { ...success('tools'), content: Array.from({ length: 129 }, () => ({ type: 'text', text: 'WITHHOLD_INVALID' })) },
    'oversized content': { ...success('tools'), content: [{ type: 'text', text: 'x'.repeat(65537) }] },
    ...Object.fromEntries(Object.entries(malformedContent).map(([name, content]) => [name, { ...success('tools'), content: [content] }]))
  }
  for (const [name, response] of Object.entries(invalidTools)) for (const cancel of [false, true]) {
    test(`${protocol} invalid ${name} stays unknown${cancel ? ' on immediate abort' : ''}`, timeout, async t => {
      if (malformedContent[name]) assert.equal(isSpecType.CallToolResult(response), false)
      const controller = new AbortController(), subject = await fixture(t, protocol, { onEffect({ reply }) { reply(response); if (cancel) controller.abort() } })
      const persistence = lifecycle(subject), result = await subject.manager.invoke(subject.prepare(), controller.signal, () => {}, persistence.hooks)
      unknown(result); exactFrame(subject); settledOnce(persistence, result)
      assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
    })
  }
  test(`${protocol} valid binary and embedded resources remain confirmed and inert on abort`, timeout, async t => {
    const controller = new AbortController(), response = { ...success('tools'), content: [
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }, { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
      { type: 'resource', resource: { uri, text: 'CONFIRMED_EMBEDDED_TEXT' } },
      { type: 'resource', resource: { uri: 'fixture:///binary', blob: 'YmluYXJ5', mimeType: 'application/octet-stream' } },
      { type: 'resource_link', uri: 'fixture:///inert', name: 'Inert link' }
    ] }
    assert.equal(isSpecType.CallToolResult(response), true)
    const subject = await fixture(t, protocol, { onEffect({ reply }) { reply(response); controller.abort() } })
    const persistence = lifecycle(subject), result = await subject.manager.invoke(subject.prepare(), controller.signal, () => {}, persistence.hooks)
    known(result); assert.match(result.content, /binaryOmitted/); assert.match(result.content, /CONFIRMED_EMBEDDED_TEXT/)
    for (const value of ['aW1hZ2U=', 'YXVkaW8=', 'YmluYXJ5']) assert(!result.content.includes(value))
    exactFrame(subject); settledOnce(persistence, result)
  })
  for (const cancel of [false, true]) test(`${protocol} mismatched resource URI remains unknown${cancel ? ' on abort' : ''}`, timeout, async t => {
    const controller = new AbortController(), subject = await fixture(t, protocol, { onEffect({ reply }) {
      reply({ contents: [{ uri: 'fixture:///other', text: 'WITHHOLD_INVALID' }] }); if (cancel) controller.abort()
    } })
    const persistence = lifecycle(subject), result = await subject.manager.invoke(subject.prepare('resources'), controller.signal, () => {}, persistence.hooks)
    unknown(result); assert(!result.content.includes('fixture:///other')); exactFrame(subject, 'resources'); settledOnce(persistence, result)
  })
  if (protocol === 'legacy') {
    for (const value of [null, 'WITHHOLD_INVALID', 42, true, ['WITHHOLD_INVALID']]) for (const cancel of [false, true]) {
      test(`legacy primitive structured content ${JSON.stringify(value)} is unknown${cancel ? ' on abort' : ''}`, timeout, async t => {
        const controller = new AbortController(), subject = await fixture(t, protocol, { onEffect({ raw }) {
          raw({ ...success('tools'), isError: true, structuredContent: value }); if (cancel) controller.abort()
        } })
        const persistence = lifecycle(subject), result = await subject.manager.invoke(subject.prepare(), controller.signal, () => {}, persistence.hooks)
        unknown(result); exactFrame(subject); settledOnce(persistence, result)
      })
    }
    const metadata = { 'object progress token': { progressToken: {} }, 'numeric task ID': { [RELATED_TASK_META_KEY]: { taskId: 42 } } }
    for (const kind of ['tools', 'resources']) for (const [name, _meta] of Object.entries(metadata)) for (const cancel of [false, true]) {
      test(`legacy ${kind} invalid metadata ${name} stays unknown${cancel ? ' on abort' : ''}`, timeout, async t => {
        assert.equal(isSpecType.RequestMeta(_meta), false)
        const controller = new AbortController(), subject = await fixture(t, protocol, { onEffect({ raw }) { raw({ ...success(kind), _meta }); if (cancel) controller.abort() } })
        const persistence = lifecycle(subject), result = await subject.manager.invoke(subject.prepare(kind), controller.signal, () => {}, persistence.hooks)
        unknown(result); exactFrame(subject, kind); settledOnce(persistence, result)
      })
    }
    for (const kind of ['tools', 'resources']) test(`legacy ${kind} valid metadata is admitted and omitted from projection`, timeout, async t => {
      const controller = new AbortController(), _meta = { progressToken: 'owned-progress', [RELATED_TASK_META_KEY]: { taskId: 'owned-task' } }
      assert.equal(isSpecType.RequestMeta(_meta), true)
      const subject = await fixture(t, protocol, { onEffect({ raw }) { raw({ ...success(kind), _meta }); controller.abort() } })
      const persistence = lifecycle(subject), result = await subject.manager.invoke(subject.prepare(kind), controller.signal, () => {}, persistence.hooks)
      known(result); assert(!result.content.includes('owned-progress')); assert(!result.content.includes('owned-task'))
      exactFrame(subject, kind); settledOnce(persistence, result)
    })
  } else {
    const cases = [['tools', 'resultType'], ['resources', 'resultType'], ['resources', 'ttlMs'], ['resources', 'cacheScope'],
      ['resources', 'ttlMs', -1], ['resources', 'cacheScope', 'unsupported']]
    for (const [kind, field, value] of cases) for (const cancel of [false, true]) {
      test(`modern ${kind} ${value === undefined ? 'missing' : 'invalid'} ${field} stays unknown${cancel ? ' on abort' : ''}`, timeout, async t => {
        const controller = new AbortController(), response = wire(kind)
        if (value === undefined) delete response[field]
        else response[field] = value
        const subject = await fixture(t, protocol, { onEffect({ raw }) { raw(response); if (cancel) controller.abort() } })
        const persistence = lifecycle(subject), result = await subject.manager.invoke(subject.prepare(kind), controller.signal, () => {}, persistence.hooks)
        unknown(result); exactFrame(subject, kind); settledOnce(persistence, result)
      })
    }
  }
}
