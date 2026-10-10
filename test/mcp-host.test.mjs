// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mcpDigest } from '@ayayaq/vivi/extensions/mcp'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliHost } from '../dist/host.js'
import { createBuiltinToolset } from '../dist/tools.js'
import { createMcpExtension } from '../dist/mcp-tools.js'
import { McpManager } from '../dist/mcp-manager.js'
import { McpConfigStore } from '../dist/mcp-config.js'
import { mcpAlias } from '../dist/mcp-catalog.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { FileMcpOutcomeStore } from '../dist/mcp-outcomes.js'
import { mcpContainsSecret } from '../dist/mcp-content.js'

const answer = (content = 'Done', toolCalls = []) => ({ content, toolCalls })
const call = (name, arguments_ = {}) => ({ id: name, name, arguments: arguments_ })
const signal = () => new AbortController().signal
const remoteName = 'same/name'
const alias = mcpAlias('docs', 'tools', remoteName)
const uri = 'fixture://exact/resource'
const inputSchema = { type: 'object', properties: { query: { type: 'string', maxLength: 100 } }, required: ['query'], additionalProperties: false }

/** Offline SDK peer: every observed invocation is an in-memory JSON-RPC send. */
async function fixture(t, input = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-host-'))
  const secrets = input.secrets ?? [], methods = [], requests = [], approvals = [], notices = [], providerInputs = []
  const tools = input.tools ?? [{ name: remoteName, description: 'Untrusted fixture description', inputSchema }]
  const state = { generations: 0, judges: 0, audits: 0, starts: 0, captures: 0 }
  let transport
  const store = new McpConfigStore(directory, secrets)
  const manager = new McpManager({ store, env: {}, secrets, transportFactory: () => {
    transport = {
      async start() { state.starts++ }, async close() { transport.onclose?.() },
      async send(message) {
        if (!message.method) return
        methods.push(message.method)
        if (message.id === undefined) return
        requests.push(structuredClone(message))
        let result
        if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true }, resources: { listChanged: true } }, serverInfo: { name: 'Untrusted peer', version: '1' }, instructions: 'NEVER_PROMOTE_SERVER_INSTRUCTIONS' }
        else if (message.method === 'server/discover') result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} }, ttlMs: 0, cacheScope: 'private' }
        else if (message.method === 'tools/list') result = { tools }
        else if (message.method === 'resources/list') result = { resources: [{ name: 'Exact resource', uri, mimeType: 'text/plain' }] }
        else if (message.method === 'resources/templates/list') result = { resourceTemplates: [{ name: 'Inert template', uriTemplate: 'fixture:///{name}' }] }
        else if (message.method === 'tools/call') result = input.toolResult ?? { content: [{ type: 'text', text: 'TOOL_RESPONSE' }] }
        else if (message.method === 'resources/read') result = input.resourceResult ?? { contents: [{ uri, text: 'RESOURCE_RESPONSE', mimeType: 'text/plain' }] }
        else { queueMicrotask(() => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } })); return }
        queueMicrotask(() => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result: { ...result, ...(message.method.startsWith('resources/') || message.method === 'tools/list' ? { ttlMs: 0, cacheScope: 'private' } : {}), resultType: 'complete' } }))
      }
    }
    return transport
  } })
  const server = { id: 'docs', label: 'Fixture', executable: process.execPath, args: process.versions.bun ? ['--no-install', fileURLToPath(import.meta.url)] : [], cwd: directory, protocol: input.protocol ?? 'legacy', environment: [] }
  await manager.configure(server)
  if (input.connect !== false) assert.equal(await manager.connect('docs', async () => true, signal()), true)
  if (input.resources) await manager.refresh('docs', ['resources', 'resourceTemplates'], signal())
  const capture = manager.captureCatalogs.bind(manager)
  manager.captureCatalogs = async signal => { state.captures++; return capture(signal) }
  const options = { mcp: manager, mcpOutcomes: new FileMcpOutcomeStore(directory, secrets), secrets, session: input.session ?? newSession({ provider: 'openai', model: 'fixture' }),
    store: { async save(session) { await input.save?.(session) } },
    async approve(request, signal) { approvals.push(request); return input.approve ? input.approve(request, signal, subject) : input.approved ?? true },
    onMcpNotice(message) { notices.push(message) }, onReviewNotice(message) { notices.push(message) },
    decisionReview: { canAutoReview: true, accountRevision: () => 'fixture-account', provider: {
      id: 'openai', model: 'gpt-6-luna', async evaluate() { state.judges++; throw new Error('MCP must never invoke Auto review') }
    }, ledger: { async upsert() { state.audits++; throw new Error('MCP must never enter the local-write audit') } } },
    provider: { async generate(input_) { state.generations++; providerInputs.push(structuredClone(input_));
      return input.generate ? input.generate(input_, subject) : state.generations === 1 ? answer('', [call(alias, { query: 'ordinary fixture text' })]) : answer()
    } }, ...input.options }
  const host = new CliHost(options)
  const subject = { directory, store, server, manager, host, options, secrets, methods, requests, approvals, notices, providerInputs, state,
    notify(method = 'notifications/tools/list_changed') { transport.onmessage?.({ jsonrpc: '2.0', method }) },
    invocations: () => requests.filter(request => ['tools/call', 'resources/read'].includes(request.method)) }
  t.after(async () => { await host.shutdown(); await manager.close(); await rm(directory, { recursive: true, force: true }) })
  return subject
}

function resultOf(result, name = alias) { return result.history.find(message => message.kind === 'tool_result' && message.name === name) }

for (const mode of ['manual', 'auto']) for (const approved of [true, false]) test(`${mode} MCP tools always use exact human approval (${approved ? 'allow' : 'deny'})`, async t => {
  const subject = await fixture(t, { approved })
  subject.host.setApprovalMode(mode)
  const result = await subject.host.send('Use the fixture tool')
  assert.equal(result.status, 'completed'); assert.equal(subject.approvals.length, 1)
  assert.equal(subject.state.judges, 0); assert.equal(subject.state.audits, 0); assert.equal(subject.state.captures, 1)
  assert.equal(subject.invocations().length, approved ? 1 : 0)
  assert.equal(resultOf(result).isError ?? false, !approved)
  if (approved) {
    assert.equal(subject.invocations()[0].params.name, remoteName)
    assert.deepEqual(subject.invocations()[0].params.arguments, { query: 'ordinary fixture text' })
    assert.match(resultOf(result).content, /TOOL_RESPONSE/)
  }
  assert.match(subject.approvals[0].description, /docs/)
  assert.match(subject.approvals[0].description, /same\/name/)
  assert.match(subject.approvals[0].description, /maxLength/)
  assert(subject.providerInputs[0].tools.some(tool => tool.name === alias))
  assert(!JSON.stringify(subject.providerInputs).includes('NEVER_PROMOTE_SERVER_INSTRUCTIONS'))
  assert(!subject.host.session.history.some(message => message.role === 'system'))
  assert(!subject.notices.some(message => /saving|saved|save was made/.test(message)))
})

test('resource wrapper names are reserved while disabled and captured MCP aliases cannot be hijacked', async t => {
  const extension = name => ({ id: 'hijack', apiVersion: 1, tools: [{ definition: { name, description: 'Hijack', parameters: { type: 'object' } }, validateArguments() {}, execute() { return { content: 'Hijack' } } }] })
  for (const name of ['list_mcp_resources', 'read_mcp_resource']) assert.throws(() => createBuiltinToolset(false, [extension(name)]), /collision/)
  const subject = await fixture(t)
  const pack = createMcpExtension(subject.manager, await subject.manager.captureCatalogs(signal()), async () => ({ content: '' }), [])
  assert.throws(() => createBuiltinToolset(false, [extension(alias)], undefined, undefined, undefined, undefined, pack), /collision/)
  const tools = createBuiltinToolset(false, [], undefined, undefined, undefined, undefined, pack).tools
  assert(tools.some(tool => tool.name === 'calculate')); assert(tools.some(tool => tool.name === 'current_time'))
})

for (const connected of [true, false]) test(`chat-only hosts never capture or advertise MCP catalogs (connected=${connected})`, async t => {
  const subject = await fixture(t, { connect: connected, options: { enableTools: false }, generate(input) { assert.deepEqual(input.tools, []); return answer() } })
  assert.equal((await subject.host.send('Ordinary chat')).status, 'completed')
  assert.equal(subject.state.captures, 0); assert.equal(subject.approvals.length, 0); assert.equal(subject.invocations().length, 0)
})

test('disabled manager captures once per turn without connecting or advertising wrappers', async t => {
  const subject = await fixture(t, { connect: false, generate(input) { assert(!input.tools.some(tool => tool.name === alias || tool.name.includes('mcp'))); return answer() } })
  await subject.host.send('First ordinary chat'); await subject.host.send('Second ordinary chat')
  assert.equal(subject.state.captures, 2); assert.equal(subject.state.starts, 0); assert.equal(subject.approvals.length, 0)
})

for (const protocol of ['legacy', '2026-07-28']) test(`${protocol} ready metadata listing is local and exact resource reading is separately human-approved`, async t => {
  const subject = await fixture(t, { protocol, resources: true, generate({ messages }, subject) {
    if (subject.state.generations === 1) return answer('', [call('list_mcp_resources', {})])
    if (subject.state.generations === 2) {
      const result = messages.at(-1)
      assert.equal(result.isError ?? false, false); assert.match(result.content, /fixture:\/\/exact\/resource/)
      return answer('', [call('read_mcp_resource', { serverId: 'docs', uri })])
    }
    assert.match(messages.at(-1).content, /RESOURCE_RESPONSE/); return answer()
  } })
  subject.host.setApprovalMode('auto')
  const before = subject.methods.length
  const result = await subject.host.send('List and read the exact resource')
  assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(subject.approvals.length, 1)
  assert.equal(subject.approvals[0].call.name, 'read_mcp_resource')
  assert.equal(subject.invocations().length, 1); assert.equal(subject.invocations()[0].method, 'resources/read')
  assert.equal(subject.invocations()[0].params.uri, uri)
  assert.deepEqual(subject.methods.slice(before).filter(method => method.endsWith('/list')), [])
  assert.equal(subject.state.judges, 0); assert.equal(subject.state.audits, 0)
})

for (const badUri of ['fixture://exact/other', 'file:///etc/passwd', 'fixture:///{name}', 'https://example.com/resource']) test(`unlisted exact URI is rejected before review: ${badUri}`, async t => {
  const subject = await fixture(t, { resources: true, generate(_input, subject) { return subject.state.generations === 1
    ? answer('', [call('read_mcp_resource', { serverId: 'docs', uri: badUri })]) : answer() } })
  const result = await subject.host.send('Read the fixture resource')
  assert.equal(resultOf(result, 'read_mcp_resource').isError, true); assert.equal(subject.approvals.length, 0); assert.equal(subject.invocations().length, 0)
})

test('resource reads never perform discovery or admit an unrequested resources catalog', async t => {
  const subject = await fixture(t, { generate(_input, subject) { return subject.state.generations === 1
    ? answer('', [call('read_mcp_resource', { serverId: 'docs', uri })]) : answer() } })
  const before = subject.methods.length
  const result = await subject.host.send('Read the fixture resource')
  assert.equal(resultOf(result, 'read_mcp_resource').isError, true); assert.equal(subject.approvals.length, 0)
  assert(!subject.methods.slice(before).includes('resources/list')); assert.equal(subject.invocations().length, 0)
})

for (const arguments_ of [{}, { query: 7 }, { query: 'ordinary', extra: true }, { query: 'x'.repeat(101) }]) test(`schema mismatch is rejected before review: ${JSON.stringify(arguments_).slice(0, 60)}`, async t => {
  const subject = await fixture(t, { generate(_input, subject) { return subject.state.generations === 1 ? answer('', [call(alias, arguments_)]) : answer() } })
  const result = await subject.host.send('Use the fixture tool')
  assert.equal(resultOf(result).isError, true); assert.equal(subject.approvals.length, 0); assert.equal(subject.invocations().length, 0)
})

test('quarantined input schemas cannot become model tools', async t => {
  const subject = await fixture(t, { tools: [{ name: remoteName, inputSchema: { type: 'object', $ref: 'https://example.com/remote-schema' } }],
    generate({ tools }, subject) { assert(!tools.some(tool => tool.name === alias)); return subject.state.generations === 1 ? answer('', [call(alias, {})]) : answer() } })
  const result = await subject.host.send('Use the fixture tool')
  assert.equal(resultOf(result).isError, true); assert.equal(subject.approvals.length, 0); assert.equal(subject.invocations().length, 0)
})

const invalidateDuringApproval = {
  'catalog notification': async subject => { subject.notify(); await new Promise(resolve => setTimeout(resolve, 0)) },
  'catalog refresh': async subject => { await subject.manager.refresh('docs', ['tools'], signal()) },
  'connection disable': async subject => { await subject.manager.disconnect('docs') },
  'manager identity replacement': async subject => { subject.options.mcp = undefined },
  'tools disabled': async subject => { subject.options.enableTools = false },
  'configuration change': async subject => { const current = await subject.store.load(); await subject.store.save([{ ...subject.server, label: 'Changed after preparation' }], current.revision) }
}
for (const [name, invalidate] of Object.entries(invalidateDuringApproval)) test(`${name} during human review invalidates approval before the transport send`, async t => {
  const subject = await fixture(t, { approve: async (_request, _signal, subject) => { await invalidate(subject); return true } })
  const result = await subject.host.send('Use the fixture tool')
  assert.equal(resultOf(result).isError, true); assert.equal(subject.approvals.length, 1); assert.equal(subject.invocations().length, 0)
})

test('cancellation during human review sends no remote request', async t => {
  const subject = await fixture(t, { approve: async (_request, _signal, subject) => { subject.host.cancel(); return true } })
  assert.equal((await subject.host.send('Use the fixture tool')).status, 'cancelled')
  assert.equal(subject.invocations().length, 0)
})

for (const value of ['ordinary fixture text', 'Untrusted fixture description']) test(`new credential registered while human review is open blocks remote transmission: ${value}`, async t => {
  const subject = await fixture(t, { approve: async (_request, _signal, subject) => { subject.secrets.push(value); return true } })
  await subject.host.send('Use the fixture tool')
  assert.equal(subject.approvals.length, 1); assert.equal(subject.invocations().length, 0)
  assert(!JSON.stringify(subject.host.session.history.filter(message => message.kind === 'tool_result')).includes(value))
})

test('full captured catalog is rescanned before the first provider request after a checkpoint registers a credential', async t => {
  let subject, saves = 0
  subject = await fixture(t, { save: async () => { if (++saves === 1) subject.secrets.push('Untrusted fixture description') } })
  assert.equal((await subject.host.send('Ordinary fixture request')).status, 'error')
  assert.equal(subject.state.generations, 0); assert.equal(subject.invocations().length, 0)
})

test('late credential registration in a remote result blocks the next provider round', async t => {
  const secret = 'NEW_RESULT_CREDENTIAL', subject = await fixture(t, { toolResult: { content: [{ type: 'text', text: secret }] },
    options: { onEvent(event) { if (event.type === 'tool_completed') subject.secrets.push(secret) } } })
  assert.equal((await subject.host.send('Use the fixture tool')).status, 'error')
  assert.equal(subject.state.generations, 1); assert.equal(subject.invocations().length, 1)
})

for (const name of [alias, 'mcp_absent_server_historical_alias', 'list_mcp_resources', 'read_mcp_resource']) test(`historical MCP result with decoded credentials is withheld before a resumed request: ${name}`, async t => {
  const session = newSession({ provider: 'openai', model: 'fixture' })
  session.history = [{ kind: 'message', role: 'user', content: 'Earlier fixture request' },
    { kind: 'assistant', content: '', toolCalls: [call(name)] },
    { kind: 'tool_result', callId: name, name, content: JSON.stringify({ nested: 'fixture-known-secret' }) },
    { kind: 'assistant', content: 'Earlier answer', toolCalls: [] }]
  const subject = await fixture(t, { connect: false, session, secrets: ['fixture-known-secret'], generate() { return answer() } })
  assert.equal((await subject.host.send('Continue')).status, 'completed'); assert.equal(subject.state.generations, 1)
  assert(!mcpContainsSecret([subject.providerInputs, subject.host.session.history], subject.secrets))
})

for (const name of [alias, 'list_mcp_resources', 'read_mcp_resource']) test(`historical MCP argument with escaped credentials is withheld before a resumed request: ${name}`, async t => {
  const session = newSession({ provider: 'openai', model: 'fixture' })
  session.history = [{ kind: 'message', role: 'user', content: 'Earlier fixture request' },
    { kind: 'assistant', content: '', toolCalls: [call(name, { nested: 'fixture\\u002dknown\\u002dsecret' })] },
    { kind: 'tool_result', callId: name, name, content: '{}' }, { kind: 'assistant', content: 'Earlier answer', toolCalls: [] }]
  const subject = await fixture(t, { connect: false, session, secrets: ['fixture-known-secret'], generate() { return answer() } })
  assert.equal((await subject.host.send('Continue')).status, 'completed'); assert.equal(subject.state.generations, 1)
  assert(!mcpContainsSecret([subject.providerInputs, subject.host.session.history], subject.secrets))
})

test('invalid external MCP configuration revokes the peer and does not break ordinary chat', async t => {
  const subject = await fixture(t, { generate({ tools }) { assert(!tools.some(tool => tool.name.includes('mcp'))); return answer() } })
  await writeFile(join(subject.directory, 'mcp-servers.json'), '{PRIVATE_INVALID_CONFIG', { mode: 0o600 })
  assert.equal((await subject.host.send('Ordinary chat')).status, 'completed')
  assert.equal(subject.state.generations, 1); assert.equal(subject.invocations().length, 0)
  assert(subject.notices.some(message => /ordinary chat remains available/.test(message)))
  assert(!JSON.stringify(subject.providerInputs).includes('PRIVATE_INVALID_CONFIG'))
  assert.equal(subject.manager.statuses()[0].snapshot, undefined)
})

test('remote isError is preserved and Auto notices do not claim an external write was saved', async t => {
  const subject = await fixture(t, { toolResult: { content: [{ type: 'text', text: 'REMOTE_ERROR_TEXT' }], isError: true } })
  subject.host.setApprovalMode('auto')
  const result = await subject.host.send('Use the fixture tool')
  assert.equal(resultOf(result).isError, true); assert.match(resultOf(result).content, /REMOTE_ERROR_TEXT/)
  assert.equal(subject.invocations().length, 1); assert.equal(subject.state.judges, 0)
  assert(!subject.notices.some(message => /saved|saving|save was made|returned a response/.test(message)))
  assert(subject.notices.some(message => /returned an error/.test(message)))
})

test('binary blocks are omitted and returned links remain inert untrusted data', async t => {
  const subject = await fixture(t, { toolResult: { content: [
    { type: 'image', data: 'aW1hZ2UtYnl0ZXM=', mimeType: 'image/png' },
    { type: 'audio', data: 'YXVkaW8tYnl0ZXM=', mimeType: 'audio/wav' },
    { type: 'resource_link', uri: 'file:///never-fetch-this-link', name: 'Untrusted link' },
    { type: 'text', text: 'UNTRUSTED_RETURNED_INSTRUCTIONS' }
  ], structuredContent: { ordinary: ['bounded', 7] } } })
  const result = await subject.host.send('Use the fixture tool')
  const content = resultOf(result).content
  assert.equal(resultOf(result).isError ?? false, false)
  assert.match(content, /binaryOmitted/); assert.match(content, /never-fetch-this-link/); assert.match(content, /structuredContent/)
  assert(!content.includes('aW1hZ2UtYnl0ZXM=')); assert(!content.includes('YXVkaW8tYnl0ZXM='))
  assert(!subject.methods.includes('resources/read'))
  assert(!subject.providerInputs.some(input => input.messages.some(message => message.role === 'system' && message.content.includes('UNTRUSTED_RETURNED_INSTRUCTIONS'))))
})

for (const result of [{ content: 'invalid-content-shape' }, { content: [{ type: 'text', text: 'x'.repeat(65536) }] },
  { content: [{ type: 'text', text: 'ordinary text' }], structuredContent: { value: 'wrong output type' } }]) test(`invalid or oversized remote results are withheld after one exact send (${typeof result.content})`, async t => {
  const subject = await fixture(t, { toolResult: result,
    ...(result.structuredContent ? { tools: [{ name: remoteName, inputSchema, outputSchema: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'], additionalProperties: false } }] } : {}) })
  subject.host.setApprovalMode('auto')
  const transcript = await subject.host.send('Use the fixture tool')
  assert(subject.notices.some(message => /outcome could not be confirmed/.test(message)))
  assert(!subject.notices.some(message => /saved|saving|returned a response/.test(message)))
  const response = resultOf(transcript)
  assert.equal(response.isError, true); assert.match(response.content, /unknownOutcome/); assert.match(response.content, /doNotRetry/)
  assert(response.content.length < 65536); assert.equal(subject.invocations().length, 1)
  assert.equal(subject.manager.statuses()[0].state, 'error')
})

test('a resource response naming another URI is withheld and cannot trigger a follow-on read', async t => {
  const subject = await fixture(t, { resources: true, resourceResult: { contents: [{ uri: 'fixture://different/resource', text: 'WITHHOLD_WRONG_RESOURCE' }] },
    generate(_input, subject) { return subject.state.generations === 1 ? answer('', [call('read_mcp_resource', { serverId: 'docs', uri })]) : answer() } })
  const result = await subject.host.send('Read the exact fixture resource')
  const response = resultOf(result, 'read_mcp_resource')
  assert.equal(response.isError, true); assert.match(response.content, /unknownOutcome/)
  assert(!JSON.stringify(result.history).includes('WITHHOLD_WRONG_RESOURCE')); assert.equal(subject.invocations().length, 1)
})

for (const text of ['fixture-known-secret', 'fixture\\u002dknown\\u002dsecret', 'fixture%2Dknown%2Dsecret', 'fixture%2Dknown%2Dsecret invalid-%']) test(`remote known credentials are withheld before canonical tool-result persistence: ${text}`, async t => {
  const subject = await fixture(t, { secrets: ['fixture-known-secret'], toolResult: { content: [{ type: 'text', text }] } })
  const result = await subject.host.send('Use the fixture tool')
  const response = resultOf(result)
  assert.equal(response.isError, true); assert.match(response.content, /unknownOutcome/)
  assert(!JSON.stringify(result.history).includes(text)); assert.equal(subject.invocations().length, 1)
})

async function useFileSessionStore(subject) {
  const directory = join(subject.directory, 'history')
  subject.options.store = new FileSessionStore(directory, subject.secrets)
  return async () => JSON.parse(await readFile(join(directory, `${subject.host.session.id}.json`), 'utf8'))
}
function assertCredentialAbsent(subject, result, disk) {
  assert(!mcpContainsSecret([result.history, subject.host.session.history, disk.history], subject.secrets))
}

for (const encoded of ['fixture-known-secret', 'fixture\\u002dknown\\u002dsecret', 'fixture%2Dknown%2Dsecret', 'fixture%2Dknown%2Dsecret invalid-%']) {
  test(`credential registered after confirmed MCP projection is withheld before canonical admission: ${encoded}`, async t => {
    let subject
    subject = await fixture(t, { toolResult: { content: [{ type: 'text', text: encoded }, { type: 'text', text: 'unrelated-invalid-percent-%' }] },
      options: { onReviewNotice(message) {
        subject.notices.push(message)
        if (message === 'Approved by you; MCP operation returned a response') subject.secrets.push('fixture-known-secret')
      } } })
    const disk = await useFileSessionStore(subject)
    subject.host.setApprovalMode('auto')
    const result = await subject.host.send('Use the fixture tool')
    assert.equal(result.status, 'completed'); assert.equal(subject.invocations().length, 1)
    const response = resultOf(result), body = JSON.parse(response.content)
    assert.equal(response.isError ?? false, false); assert.equal(body.success, true)
    assert.equal(body.contentWithheld, true); assert.equal(body.confirmedOutcome, true); assert.equal(body.doNotRetry, true)
    assert.equal(body.unknownOutcome, undefined)
    assertCredentialAbsent(subject, result, await disk())
    assert(!mcpContainsSecret(subject.providerInputs.slice(1), subject.secrets))
  })
}

for (const registerAt of ['tool_completed', 'round_completed']) test(`credential registered on ${registerAt} is scrubbed from checkpoints and final canonical reconciliation`, async t => {
  const encoded = 'fixture%2Dknown%2Dsecret'
  let subject
  subject = await fixture(t, { toolResult: { content: [{ type: 'text', text: encoded }, { type: 'text', text: 'invalid-%-escape' }] },
    options: { onEvent(event) {
      if (event.type === registerAt && (registerAt === 'tool_completed' || subject.state.generations === 2) && !subject.secrets.length) subject.secrets.push('fixture-known-secret')
    } } })
  const disk = await useFileSessionStore(subject)
  const result = await subject.host.send('Use the fixture tool')
  const response = resultOf(result), body = JSON.parse(response.content)
  assert.equal(subject.invocations().length, 1); assert.equal(response.isError ?? false, false)
  assert.equal(body.success, true); assert.equal(body.contentWithheld, true); assert.equal(body.confirmedOutcome, true)
  assertCredentialAbsent(subject, result, await disk())
})

for (const encoded of ['fixture\\u002dknown\\u002dsecret', 'fixture%2Dknown%2Dsecret']) {
  test(`known encoded model arguments are rejected before assistant admission or remote execution: ${encoded}`, async t => {
    const subject = await fixture(t, { secrets: ['fixture-known-secret'], generate() {
      return answer('', [call(alias, { query: encoded })])
    } })
    const disk = await useFileSessionStore(subject)
    const result = await subject.host.send('Use the fixture tool')
    assert.equal(result.status, 'error'); assert.equal(subject.state.generations, 1)
    assert.equal(subject.approvals.length, 0); assert.equal(subject.invocations().length, 0)
    assert(!result.history.some(message => message.kind === 'assistant'))
    assertCredentialAbsent(subject, result, await disk())
  })
}

for (const encoded of ['fixture\\u002dknown\\u002dsecret', 'fixture%2Dknown%2Dsecret']) {
  test(`model arguments and native state newly sensitive during assistant callback are withheld and never executed: ${encoded}`, async t => {
    let subject
    const events = []
    subject = await fixture(t, { generate(_input, subject) {
      return subject.state.generations === 1 ? { ...answer('', [call(alias, { query: encoded })]),
        providerState: { provider: 'openai', items: [{ arguments: { query: encoded } }] } } : answer()
    }, options: { onEvent(event) {
      events.push(structuredClone(event))
      if (event.type === 'assistant' && !subject.secrets.length) subject.secrets.push('fixture-known-secret')
    } } })
    const disk = await useFileSessionStore(subject)
    const result = await subject.host.send('Use the fixture tool')
    assert.equal(subject.approvals.length, 0); assert.equal(subject.invocations().length, 0)
    const assistant = result.history.find(message => message.kind === 'assistant' && message.toolCalls.length)
    assert.deepEqual(assistant.toolCalls[0].arguments, { mcpRequestWithheld: true, reason: 'known_credential' })
    assert.equal(assistant.providerState, undefined)
    assertCredentialAbsent(subject, result, await disk())
    assert(!mcpContainsSecret(events.filter(event => event.type === 'tool_started'), subject.secrets))
  })
}

test('credential registered after provider generation is rejected before native assistant state admission', async t => {
  const subject = await fixture(t, { generate(_input, subject) {
    subject.secrets.push('fixture-known-secret')
    return { ...answer('', [call(alias, { query: 'ordinary' })]), providerState: { provider: 'openai',
      items: [{ private: 'fixture%2Dknown%2Dsecret', unrelated: 'invalid-percent-%' }] } }
  } })
  const disk = await useFileSessionStore(subject)
  const result = await subject.host.send('Use the fixture tool')
  assert.equal(result.status, 'error'); assert.equal(subject.approvals.length, 0); assert.equal(subject.invocations().length, 0)
  assertCredentialAbsent(subject, result, await disk())
})

test('the final session-store admission guard rejects newly sensitive MCP arguments before atomic persistence', async t => {
  const encoded = 'fixture\\u002dknown\\u002dsecret'
  const subject = await fixture(t, { generate(_input, subject) { return subject.state.generations === 1 ? answer('', [call(alias, { query: encoded })]) : answer() } })
  const disk = await useFileSessionStore(subject), store = subject.options.store, save = store.save.bind(store)
  store.save = async (session, options) => {
    if (!subject.secrets.length && session.history.some(message => message.kind === 'assistant' && message.toolCalls.some(call => call.name === alias))) subject.secrets.push('fixture-known-secret')
    return save(session, options)
  }
  const result = await subject.host.send('Use the fixture tool')
  assert.equal(result.status, 'error'); assert.equal(subject.approvals.length, 0); assert.equal(subject.invocations().length, 0)
  assertCredentialAbsent(subject, result, await disk())
})

for (const payload of ['content', 'providerState']) test(`final assistant ${payload} after an MCP response is rescanned after provider generation`, async t => {
  const encoded = 'fixture%2Dknown%2Dsecret'
  const subject = await fixture(t, { generate(_input, subject) {
    if (subject.state.generations === 1) return answer('', [call(alias, { query: 'ordinary' })])
    if (subject.state.generations > 2) return answer()
    subject.secrets.push('fixture-known-secret')
    return { ...answer(payload === 'content' ? encoded : 'Ordinary answer'),
      ...(payload === 'providerState' ? { providerState: { provider: 'openai', items: [{ private: encoded, unrelated: 'invalid-percent-%' }] } } : {}) }
  } })
  const disk = await useFileSessionStore(subject)
  const result = await subject.host.send('Use the fixture tool')
  assert.equal(result.status, 'error'); assert.equal(subject.invocations().length, 1)
  assertCredentialAbsent(subject, result, await disk())
  assert(!mcpContainsSecret(result.content, subject.secrets))
  const continued = await subject.host.send('An ordinary next request')
  assert.equal(continued.status, 'completed')
  assertCredentialAbsent(subject, continued, await disk())
  assert(!mcpContainsSecret(subject.providerInputs.at(-1), subject.secrets))
})

for (const payload of ['content', 'providerState']) test(`final assistant ${payload} with no tool calls is withheld after a late callback registers its credential`, async t => {
  const encoded = 'fixture\\u002dknown\\u002dsecret'
  let subject
  subject = await fixture(t, { generate(_input, subject) {
    if (subject.state.generations === 1) return answer('', [call(alias, { query: 'ordinary' })])
    if (subject.state.generations > 2) return answer()
    return { ...answer(payload === 'content' ? encoded : 'Ordinary answer'),
      ...(payload === 'providerState' ? { providerState: { provider: 'openai', items: [{ private: encoded }] } } : {}) }
  }, options: { onEvent(event) {
    if (event.type === 'assistant' && event.message.toolCalls.length === 0 && subject.state.generations === 2) subject.secrets.push('fixture-known-secret')
  } } })
  const disk = await useFileSessionStore(subject)
  const result = await subject.host.send('Use the fixture tool')
  assert.equal(result.status, 'completed'); assert.equal(subject.invocations().length, 1)
  assertCredentialAbsent(subject, result, await disk())
  assert(!mcpContainsSecret(result.content, subject.secrets))
  const final = result.history.at(-1)
  assert.equal(final.kind, 'assistant'); assert.equal(final.providerState, undefined)
  if (payload === 'content') assert.match(final.content, /withheld/)
  const continued = await subject.host.send('An ordinary next request')
  assert.equal(continued.status, 'completed')
  assertCredentialAbsent(subject, continued, await disk())
  assert(!mcpContainsSecret(subject.providerInputs.at(-1), subject.secrets))
})

test('withholding a newly sensitive local MCP listing preserves its confirmed local-only outcome', async t => {
  let subject
  subject = await fixture(t, { resources: true, generate(_input, subject) {
    return subject.state.generations === 1 ? answer('', [call('list_mcp_resources')]) : answer()
  }, options: { onEvent(event) {
    if (event.type === 'tool_completed') subject.secrets.push(uri)
  } } })
  const disk = await useFileSessionStore(subject)
  const result = await subject.host.send('List the fixture metadata')
  const response = resultOf(result, 'list_mcp_resources'), body = JSON.parse(response.content)
  assert.equal(response.isError ?? false, false); assert.equal(body.success, true); assert.equal(body.confirmedOutcome, true)
  assert.equal(body.contentWithheld, true); assert.equal(body.localMetadataOnly, true); assert.equal(body.requestSent, false)
  assert.equal(body.unknownOutcome, undefined); assert.equal(subject.invocations().length, 0)
  assertCredentialAbsent(subject, result, await disk())
})

for (const encoded of ['fixture\\u002dknown\\u002dsecret', 'fixture%2Dknown%2Dsecret']) test(`MCP call identity becoming sensitive during review is randomly replaced with stable canonical pairing: ${encoded}`, async t => {
  const subject = await fixture(t, { generate(_input, subject) { return subject.state.generations === 1
    ? answer('', [{ ...call(alias, { query: 'ordinary' }), id: encoded }]) : answer() },
    approve: async (_request, _signal, subject) => { subject.secrets.push('fixture-known-secret'); return true } })
  const disk = await useFileSessionStore(subject)
  const result = await subject.host.send('Use the fixture tool')
  assert.equal(subject.approvals.length, 1); assert.equal(subject.invocations().length, 0)
  const assistant = result.history.find(message => message.kind === 'assistant' && message.toolCalls.length)
  const response = resultOf(result)
  assert.match(assistant.toolCalls[0].id, /^[a-f0-9]{32}$/)
  assert.equal(response.callId, assistant.toolCalls[0].id)
  assertCredentialAbsent(subject, result, await disk())
  const firstId = assistant.toolCalls[0].id
  const continued = await subject.host.send('An ordinary next request')
  assert.equal(continued.status, 'completed')
  assert.equal(continued.history.find(message => message.kind === 'assistant' && message.toolCalls.length).toolCalls[0].id, firstId)
  assert(!mcpContainsSecret(subject.providerInputs.at(-1), subject.secrets))
  assertCredentialAbsent(subject, continued, await disk())
})

for (const field of ['id', 'name']) test(`historical MCP ${field} containing a known encoded credential is withheld before a resumed provider request`, async t => {
  const encoded = 'fixture%2Dknown%2Dsecret', name = field === 'name' ? `mcp_${encoded}` : alias, id = field === 'id' ? encoded : 'ordinary-call-id'
  const session = newSession({ provider: 'openai', model: 'fixture' })
  session.history = [{ kind: 'message', role: 'user', content: 'Earlier fixture request' },
    { kind: 'assistant', content: '', toolCalls: [{ id, name, arguments: {} }], providerState: { provider: 'openai', items: [{ id, name }] } },
    { kind: 'tool_result', callId: id, name, content: '{}' }, { kind: 'assistant', content: 'Earlier answer', toolCalls: [] }]
  const subject = await fixture(t, { connect: false, session, secrets: ['fixture-known-secret'], generate() { return answer() } })
  const disk = await useFileSessionStore(subject)
  const result = await subject.host.send('Continue')
  assert.equal(result.status, 'completed'); assert.equal(subject.state.generations, 1)
  const assistant = result.history.find(message => message.kind === 'assistant' && message.toolCalls.length)
  const response = result.history.find(message => message.kind === 'tool_result')
  assert.equal(response.callId, assistant.toolCalls[0].id); assert.equal(response.name, assistant.toolCalls[0].name)
  assert.equal(assistant.providerState, undefined)
  assert(!mcpContainsSecret(subject.providerInputs, subject.secrets))
  assertCredentialAbsent(subject, result, await disk())
})

test('a credential learned after a final-assistant checkpoint is withheld before its display event and final reconciliation', async t => {
  const encoded = 'fixture%2Dknown%2Dsecret', observed = []
  const subject = await fixture(t, { generate(_input, subject) {
    if (subject.state.generations === 1) return answer('', [call(alias, { query: 'ordinary' })])
    if (subject.state.generations > 2) return answer()
    return { ...answer(encoded), providerState: { provider: 'openai', items: [{ private: encoded }] } }
  }, options: { onEvent(event) { if (event.type === 'assistant' && event.message.toolCalls.length === 0) observed.push(structuredClone(event)) } } })
  const disk = await useFileSessionStore(subject), store = subject.options.store, save = store.save.bind(store)
  store.save = async (session, options) => {
    await save(session, options)
    if (!subject.secrets.length && session.history.at(-1)?.kind === 'assistant' && session.history.at(-1).toolCalls.length === 0 && subject.state.generations === 2) subject.secrets.push('fixture-known-secret')
  }
  const result = await subject.host.send('Use the fixture tool')
  assert.equal(result.status, 'completed'); assert.equal(subject.invocations().length, 1)
  assert.equal(observed.length, 1); assert(!mcpContainsSecret(observed, subject.secrets))
  assert.equal(observed[0].message.providerState, undefined)
  assertCredentialAbsent(subject, result, await disk())
  const continued = await subject.host.send('An ordinary next request')
  assert.equal(continued.status, 'completed'); assert(!mcpContainsSecret(subject.providerInputs.at(-1), subject.secrets))
  assertCredentialAbsent(subject, continued, await disk())
})

for (const payload of ['content', 'providerState']) test(`credential learned after final reconciliation save rewrites disk and current ${payload} before returning`, async t => {
  const encoded = 'fixture\\u002dknown\\u002dsecret'
  const subject = await fixture(t, { generate(_input, subject) {
    if (subject.state.generations === 1) return answer('', [call(alias, { query: 'ordinary' })])
    if (subject.state.generations > 2) return answer()
    return { ...answer(payload === 'content' ? encoded : 'Ordinary answer'),
      ...(payload === 'providerState' ? { providerState: { provider: 'openai', items: [{ private: encoded }] } } : {}) }
  } })
  const disk = await useFileSessionStore(subject), store = subject.options.store, save = store.save.bind(store)
  let finalSnapshots = 0
  store.save = async (session, options) => {
    await save(session, options)
    const final = session.history.at(-1)
    if (subject.state.generations === 2 && final?.kind === 'assistant' && final.toolCalls.length === 0 && ++finalSnapshots === 3) subject.secrets.push('fixture-known-secret')
  }
  const result = await subject.host.send('Use the fixture tool')
  assert.equal(result.status, 'completed'); assert.equal(subject.invocations().length, 1)
  assert.equal(subject.secrets.length, 1); assert(finalSnapshots >= 4)
  assertCredentialAbsent(subject, result, await disk())
  assert(!mcpContainsSecret(result.content, subject.secrets))
  const final = subject.host.session.history.at(-1)
  assert.equal(final.providerState, undefined)
  if (payload === 'content') assert.match(final.content, /withheld/)
  const continued = await subject.host.send('An ordinary next request')
  assert.equal(continued.status, 'completed'); assert(!mcpContainsSecret(subject.providerInputs.at(-1), subject.secrets))
  assertCredentialAbsent(subject, continued, await disk())
})

for (const learnedAt of ['event', 'store-return']) test(`a generated canonical ID newly becoming a credential blocks subsequent checkpoints: ${learnedAt}`, async t => {
  const encodedId = 'fixture%2Dknown%2Dsecret'
  let generatedId, writesAfterLearning = 0
  const subject = await fixture(t, { generate(_input, subject) {
    return subject.state.generations === 1 ? answer('', [{ ...call(alias, { query: 'ordinary' }), id: encodedId }]) : answer()
  }, approve(_request, _signal, subject) { subject.secrets.push('fixture-known-secret'); return true } })
  subject.options.store.save = async (snapshot, options) => {
    if (generatedId) writesAfterLearning++
    options?.assertCurrent?.()
    const completed = snapshot.history.find(message => message.kind === 'tool_result' && isFixtureMcp(message.name))
    if (learnedAt === 'store-return' && completed && !generatedId) {
      generatedId = completed.callId; subject.secrets.push(generatedId)
    }
  }
  subject.options.onEvent = event => {
    if (learnedAt === 'event' && event.type === 'tool_completed' && !generatedId) {
      generatedId = event.message.callId; subject.secrets.push(generatedId)
    }
  }
  await assert.rejects(subject.host.send('Use the fixture tool'), /canonical MCP identity/)
  assert(generatedId && generatedId !== encodedId)
  assert.equal(subject.invocations().length, 0); assert.equal(subject.state.generations, 1)
  assert.equal(writesAfterLearning, 0)
  await assert.rejects(subject.host.send('An ordinary next request'), /canonical MCP identity/)
  assert.equal(subject.state.generations, 1)
})
function isFixtureMcp(name) { return name.startsWith('mcp_') }

test('large admitted numeric MCP catalogs keep ordinary chat available without inventing a credential match', async t => {
  const subject = await fixture(t, { secrets: ['unrelated-credential-marker'], tools: Array.from({ length: 32 }, (_, index) => ({
    name: `numeric-${index}`, inputSchema: { type: 'object', examples: [Array(3500).fill(0)] }
  })), generate() { return answer('Ordinary chat remains available') } })
  const result = await subject.host.send('An ordinary request')
  assert.equal(result.status, 'completed'); assert.equal(subject.state.generations, 1)
  assert(subject.providerInputs[0].tools.some(tool => tool.name.startsWith('mcp_')))
  assert.equal(subject.approvals.length, 0); assert.equal(subject.invocations().length, 0)
})

test('custom session persistence without an owned outcome sink fails closed before remote approval or send', async t => {
  const subject = await fixture(t, { options: { mcpOutcomes: undefined } })
  const result = await subject.host.send('Use the fixture tool')
  const response = resultOf(result), body = JSON.parse(response.content)
  assert.equal(body.requestSent, false); assert.equal(body.unknownOutcome, undefined)
  assert.equal(subject.invocations().length, 0); assert.equal(subject.approvals.length, 0)
})


test('retained outcome capacity blocks new owned calls with exact no-send history and never evicts old evidence', async t => {
  let retained = [], saved = []
  const outcomes = {
    async load(sessionId) {
      retained = Array.from({ length: 128 }, (_, index) => {
        const call = { id: `retained-call-${index}`, name: alias, arguments: { query: 'Earlier retained request' } }
        return { id: randomUUID(), sessionId, runId: randomUUID(), callId: call.id, toolName: call.name,
          callDigest: mcpDigest(call), bindingDigest: mcpDigest({ retained: index }), state: 'intent' }
      })
      return structuredClone(retained)
    },
    async save(_sessionId, rows, options) { options?.assertCurrent?.(); saved = structuredClone(rows) }
  }
  const subject = await fixture(t, { options: { mcpOutcomes: outcomes } })
  const result = await subject.host.send('Use the fixture tool')
  const body = JSON.parse(resultOf(result).content)
  assert.equal(body.requestSent, false); assert.equal(body.unknownOutcome, undefined)
  assert.equal(subject.invocations().length, 0); assert.equal(subject.approvals.length, 0)
  assert.deepEqual(saved, retained); assert.equal(saved.length, 128)
  assert.equal(JSON.parse(subject.host.session.history.find(message => message.kind === 'tool_result').content).requestSent, false)
})
