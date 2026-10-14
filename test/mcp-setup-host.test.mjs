// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { mcpDigest } from '@ayayaq/vivi/extensions/mcp'
import { CliHost } from '../dist/host.js'
import { createBuiltinToolset } from '../dist/tools.js'
import { createMcpSetupExtension, MCP_SETUP_GUIDANCE } from '../dist/mcp-setup-tools.js'
import { McpSetupService } from '../dist/mcp-setup.js'
import { McpManager } from '../dist/mcp-manager.js'
import { McpConfigStore } from '../dist/mcp-config.js'
import { mcpAlias } from '../dist/mcp-catalog.js'
import { FileSessionStore, newSession, validateSession } from '../dist/session.js'
import { FileMcpOutcomeStore, McpOutcomeCommitError } from '../dist/mcp-outcomes.js'
import { mcpContainsSecret } from '../dist/mcp-content.js'
import { TerminalIO, sendChatTurn } from '../dist/terminal.js'

const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn)
const settings = { provider: 'openai', model: 'synthetic-setup-host' }
const endpoint = 'https://mcp.example.com/exact/fixture'
const remoteName = 'fixture/owned-operation'
const alias = mcpAlias('docs', 'tools', remoteName)
const call = (name, arguments_ = {}, id = `${name}-fixture`) => ({ id, name, arguments: arguments_ })
const answer = (calls = [], content = 'Synthetic setup fixture finished') => ({ content, toolCalls: calls })
const signal = () => new AbortController().signal
const result = body => ({ content: JSON.stringify(body) })

function gate(t) {
  let enter, release
  const entered = new Promise(resolve => { enter = resolve })
  const wait = new Promise(resolve => { release = resolve })
  t.after(() => release())
  return { enter, entered, wait, release }
}

/** Real CLI/core, local configuration, transcript and outcome stores. Only the
 * setup effect/provider and JSON-RPC peer are synthetic. No browser, OAuth,
 * credential store, public network or installed server process is used here.
 * realService cases retain the real setup service too. OAuth is always synthetic. */
async function fixture(t, input = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-synthetic-mcp-setup-host-'))
  const sessionDirectory = join(directory, 'sessions')
  const secrets = input.secrets ?? [], approvals = [], providerInputs = [], frames = [], methods = [], writes = [], notices = [], events = []
  const state = { rounds: 0, lists: 0, setups: 0, effects: 0, starts: 0, closes: 0, captures: 0, judges: 0, audits: 0 }
  const sessionStore = new FileSessionStore(sessionDirectory, secrets)
  if (input.saveSession) {
    const save = sessionStore.save.bind(sessionStore)
    sessionStore.save = async (session, options) => {
      await input.saveSession(session, options, subject)
      return save(session, options)
    }
  }
  const outcomes = new FileMcpOutcomeStore(sessionDirectory, secrets)
  const outcomeStore = input.saveOutcome ? {
    load: id => outcomes.load(id), addSecrets: values => outcomes.addSecrets(values), drain: () => outcomes.drain(),
    async save(id, records, options) {
      writes.push(structuredClone(records))
      return input.saveOutcome(id, records, options, outcomes, subject)
    }
  } : outcomes
  const config = new McpConfigStore(join(directory, 'config'), secrets)
  let peer
  const manager = new McpManager({ store: config, env: {}, secrets, transportFactory: () => {
    state.starts++
    peer = { async start() {}, async close() { state.closes++; peer.onclose?.() }, async send(message) {
      if (!message.method || message.id === undefined) return
      methods.push(message.method)
      let body
      if (message.method === 'initialize') body = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'Synthetic setup peer', version: '1' } }
      else if (message.method === 'server/discover') body = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, ttlMs: 0, cacheScope: 'private' }
      else if (message.method === 'tools/list') body = { tools: [{ name: remoteName, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }], ttlMs: 0, cacheScope: 'private' }
      else if (message.method === 'tools/call') { frames.push(structuredClone(message)); body = { content: [{ type: 'text', text: 'SYNTHETIC_PEER_RESULT' }] } }
      else { queueMicrotask(() => peer.onmessage?.({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported synthetic fixture method' } })); return }
      queueMicrotask(() => peer.onmessage?.({ jsonrpc: '2.0', id: message.id, result: { ...body, resultType: 'complete' } }))
    } }
    return peer
  } })
  const server = { transport: 'http', id: 'docs', label: 'Synthetic fixture', endpoint, protocol: 'legacy', allowLoopbackHttp: false }
  if (input.configured !== false) await manager.configure(server)
  else if (!input.unloadedManager) await manager.reload()
  const capture = manager.captureCatalogs.bind(manager)
  manager.captureCatalogs = async signal => { state.captures++; return capture(signal) }
  const service = new McpSetupService(manager)
  const executeReal = service.executeSetup.bind(service)
  const listLocal = service.listLocal?.bind(service)
  service.listLocal = async abortSignal => {
    state.lists++
    assert(listLocal, 'McpSetupService.listLocal must be wired before this integration suite is run')
    const snapshot = await listLocal(abortSignal)
    return input.list ? input.list(snapshot, subject) : snapshot
  }
  service.executeSetup = async (ownedCall, abortSignal, context) => {
    state.setups++
    assert.deepEqual(Object.keys(ownedCall).sort(), ['arguments', 'id', 'name'])
    assert.deepEqual(Object.keys(context).sort(), ['approve', 'assertCurrent', 'beforeEffect', 'effect', 'io', 'settle'].sort())
    assert.equal(context.io, io)
    const args = ownedCall.arguments
    let attempted = false, observed = false
    try {
      assert.equal(args.expectedRevision, manager.configurationRevision(), 'synthetic preparation rejects a stale expectedRevision')
      const disclosure = { action: args.action, serverId: args.id, revision: manager.configurationRevision(),
        endpoint: args.endpoint ?? server.endpoint, protocol: args.protocol ?? server.protocol,
        label: args.label ?? server.label, affectedServerIds: [args.id] }
      const request = { call: ownedCall, currentRevision: mcpDigest(disclosure),
        description: `Synthetic exact MCP setup review: ${JSON.stringify(disclosure)}` }
      if (!await context.approve(request, abortSignal)) return { ...result({ success: false, source: 'mcp-setup', requestSent: false,
        error: { code: 'approval_denied', message: 'Synthetic setup was denied' } }), isError: true }
      context.assertCurrent()
      await context.beforeEffect()
      context.assertCurrent()
      attempted = true
      state.effects++
      await input.effect?.(ownedCall, abortSignal, context, subject)
      const receipt = args.action === 'add' || args.action === 'remove'
        ? { kind: 'configuration-saved', serverId: args.id, revision: manager.configurationRevision(), affectedServerIds: [args.id] }
        : { kind: args.action === 'logout' ? 'logged-out' : 'connected', serverId: args.id, revision: manager.configurationRevision() }
      context.effect(receipt)
      observed = true
      await input.afterReceipt?.(ownedCall, abortSignal, context, subject)
      const body = { success: true, source: 'mcp-setup', action: args.action, serverId: args.id, confirmedOutcome: true, doNotRetry: true, effectReceipt: receipt,
        ...(receipt.kind === 'configuration-saved' ? { configSaved: true, revision: receipt.revision, affectedServerIds: receipt.affectedServerIds }
          : receipt.kind === 'logged-out' ? { loggedOut: true } : { connected: true }), message: `CONFIRMED_SYNTHETIC_${args.action.toUpperCase()}`,
        ...input.resultBody }
      const outcome = result(body)
      await context.settle(outcome)
      await input.afterSettle?.(ownedCall, abortSignal, context, subject)
      return outcome
    } catch (error) {
      // As in the real service, only its own boundary observation can establish
      // definite no-attempt after an intent has been recorded. The host cannot
      // infer a completed effect from an arbitrary callback exception.
      if (attempted || observed) throw error
      const outcome = { ...result({ success: false, source: 'mcp-setup', confirmedOutcome: true, requestSent: false, notAttempted: true,
        error: { code: 'synthetic_setup_not_started', message: 'Synthetic setup was invalidated before any effect; no action was started' } }), isError: true }
      await context.settle(outcome)
      return outcome
    }
  }
  if (input.realService) service.executeSetup = (...args) => { state.setups++; return executeReal(...args) }
  const streamIn = new PassThrough(), streamOut = new PassThrough()
  let output = ''
  streamOut.on('data', bytes => { output += bytes.toString() })
  const io = new TerminalIO({ input: streamIn, output: streamOut, tui: false, stream: false, secrets })
  // Approval is supplied by the explicit synthetic host hook below. The real
  // TerminalIO still owns display filtering and terminal result formatting.
  Object.defineProperty(io, 'canAutoReview', { get() { return !this.isClosed } })
  const options = { session: input.session ?? newSession(settings), store: sessionStore, mcp: manager, secrets,
    enablePublicUrl: false, mcpSetup: { service, io },
    ...(input.saveOutcome ? { mcpOutcomes: outcomeStore } : {}),
    async approve(request, abortSignal) {
      approvals.push(structuredClone(request))
      return input.approve ? input.approve(request, abortSignal, subject) : input.approved ?? true
    },
    decisionReview: { canAutoReview: true, accountRevision: () => 'synthetic-account',
      provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { state.judges++; assert.fail('MCP setup cannot use an Auto judge') } },
      ledger: { async upsert() { state.audits++; assert.fail('MCP setup cannot enter the local-write audit') } } },
    provider: { async generate(value) {
      state.rounds++; providerInputs.push(structuredClone(value))
      return input.generate ? input.generate(value, subject) : state.rounds === 1 ? answer([subject.setupCall()]) : answer()
    } },
    onMcpNotice(message) { notices.push(message); io.write(`${message}\n`) },
    onReviewNotice(message) { notices.push(message) },
    async onEvent(event) { events.push(structuredClone(event)); await input.onEvent?.(event, subject); io.event(event) },
    ...input.options }
  const host = new CliHost(options)
  const subject = { directory, sessionDirectory, sessionStore, outcomes, outcomeStore, manager, config, service, io, host, options,
    server, secrets, state, approvals, providerInputs, frames, methods, writes, notices, events, output: () => output,
    setupCall(action = input.action ?? 'add', extra = {}, id = 'setup-fixture') { return call('mcp_setup', {
      action, id: 'docs', expectedRevision: manager.configurationRevision(), ...(action === 'add' ? { endpoint } : {}), ...extra }, id) },
    async send(prompt = 'Run the synthetic exact setup fixture') { const value = await sendChatTurn(host, io, prompt); io.result(value); return value },
    async changeConfig() { const before = await config.load(); await config.save([{ ...server, label: 'Changed during host review' }], before.revision); await manager.reload() }
  }
  t.after(async () => { io.close(); streamIn.destroy(); streamOut.destroy(); await host.shutdown(); await manager.close(); await rm(directory, { recursive: true, force: true }) })
  return subject
}

function resultOf(value, id = 'setup-fixture') {
  const history = Array.isArray(value) ? value : value.history
  const message = history.find(message => message.kind === 'tool_result' && message.callId === id)
  assert(message, `missing canonical result for ${id}`)
  const ownedCall = history.flatMap(message => message.kind === 'assistant' ? message.toolCalls : []).find(call => call.id === id)
  assert(ownedCall, `missing canonical call for ${id}`); assert.equal(message.name, ownedCall.name)
  return { message, body: JSON.parse(message.content) }
}

test('real service can add from a fresh inert list with an uninitialized embedded manager', async t => {
  const subject = await fixture(t, { configured: false, unloadedManager: true, realService: true, options: { mcp: undefined },
    async generate(_input, subject) {
      if (subject.state.rounds !== 1) return answer()
      const local = await subject.service.listLocal(signal())
      assert.equal(subject.manager.configurationRevision(), '')
      return answer([subject.setupCall('add', { expectedRevision: local.revision, protocol: 'legacy' })])
    } })
  const value = await subject.send('Add the exact reviewed endpoint')
  const { body } = resultOf(value)
  assert.equal(body.success, true); assert.equal(body.configSaved, true); assert.equal(body.doNotRetry, true)
  assert.equal(subject.approvals.length, 1); assert.equal(subject.state.starts, 0)
  assert.equal((await subject.config.load()).servers[0].endpoint, endpoint)
  assert.equal(subject.manager.statuses()[0].state, 'disabled')
})

for (const invalidate of ['service', 'io', 'tools']) test(`real service rejects post-launch-review ${invalidate} invalidation before protocol startup`, async t => {
  const subject = await fixture(t, { action: 'connect', realService: true })
  const reload = subject.manager.reload.bind(subject.manager)
  let invalidateNextReload = false
  subject.manager.reload = async () => {
    await reload()
    if (!invalidateNextReload) return
    invalidateNextReload = false
    if (invalidate === 'service') subject.options.mcpSetup.service = new McpSetupService(subject.manager)
    else if (invalidate === 'io') subject.options.mcpSetup.io = { ...subject.io }
    else subject.options.enableTools = false
  }
  subject.options.approve = async request => {
    subject.approvals.push(structuredClone(request))
    if (request.call.name === 'connect_mcp_server') invalidateNextReload = true
    return true
  }
  const value = await subject.send('Connect through the real service with a replaced owner')
  assert.equal(subject.approvals.length, 2); assert.equal(subject.state.starts, 0); assert.deepEqual(subject.methods, [])
  const { body } = resultOf(value)
  assert.equal(body.success, false); assert.equal(body.unknownOutcome, true); assert.equal(body.doNotRetry, true)
})

test('real configuration receipt survives cancellation and terminal checkpoint failure', async t => {
  const subject = await fixture(t, { configured: false, realService: true,
    async saveOutcome(id, records, options, base, subject) {
      await base.save(id, records, options)
      if (records.some(row => row.state === 'settled' && JSON.parse(row.result.content).configSaved)) subject.host.cancel()
    },
    async saveSession(session) {
      if (session.history.some(message => message.kind === 'tool_result')) throw new Error('Synthetic terminal checkpoint failure')
    } })
  await subject.send('Save the disabled entry before cancellation').catch(() => undefined)
  const row = (await subject.outcomes.load(subject.host.session.id))[0]
  assert.equal(row.state, 'settled')
  const body = JSON.parse(row.result.content)
  assert.equal(body.configSaved, true); assert.equal(body.confirmedOutcome, true); assert.equal(body.doNotRetry, true)
  assert.equal((await subject.config.load()).servers.length, 1); assert.equal(subject.state.starts, 0)
  const restored = await resume(t, subject)
  assert.equal(resultOf(restored.host.session.history).body.configSaved, true)
  await restored.host.send('Continue from the saved receipt without replaying setup')
  assert.equal(subject.approvals.length, 1)
})
function notAttempted(value, id) {
  const { message, body } = resultOf(value, id)
  assert.equal(message.isError, true); assert.equal(body.requestSent, false)
  assert.notEqual(body.unknownOutcome, true); assert.notEqual(body.doNotRetry, true)
  return body
}
function unknown(value, id) {
  const { message, body } = resultOf(value, id)
  assert.equal(message.isError, true); assert.equal(body.unknownOutcome, true); assert.equal(body.doNotRetry, true)
  assert.notEqual(body.requestSent, false)
  return body
}
function confirmed(value, action = 'add', id) {
  const { message, body } = resultOf(value, id)
  assert.notEqual(message.isError, true); assert.equal(body.success, true); assert.equal(body.confirmedOutcome, true)
  assert.notEqual(body.unknownOutcome, true); assert.notEqual(body.requestSent, false)
  assert.equal(body[action === 'add' || action === 'remove' ? 'configSaved' : action === 'logout' ? 'loggedOut' : 'connected'], true)
  return body
}
async function resume(t, subject) {
  const providerInputs = [], store = new FileSessionStore(subject.sessionDirectory, subject.secrets)
  const host = await CliHost.resume({ id: subject.host.session.id, store, secrets: subject.secrets,
    provider: { async generate(value) { providerInputs.push(structuredClone(value)); return answer() } } })
  t.after(() => host.shutdown())
  return { host, store, providerInputs }
}

for (const configured of [false, true]) test(`synthetic host advertises separate setup tools with zero connected catalogs (configured=${configured})`, async t => {
  const subject = await fixture(t, { configured, generate({ tools, messages }, subject) {
    assert(tools.some(tool => tool.name === 'mcp_list')); assert(tools.some(tool => tool.name === 'mcp_setup'))
    assert(!tools.some(tool => tool.name === alias)); assert(messages.some(message => message.content === MCP_SETUP_GUIDANCE))
    return subject.state.rounds === 1 ? answer([call('mcp_list')]) : answer()
  } })
  const value = await subject.send('List local setup status')
  assert.equal(value.status, 'completed'); assert.equal(subject.state.lists, 1); assert.equal(subject.state.setups, 0)
  const body = resultOf(value, 'mcp_list-fixture').body
  assert.equal(body.localMetadataOnly, true); assert.equal(body.requestSent, false); assert.match(body.revision, /^[a-f0-9]{64}$/)
  assert.equal(body.servers.length, configured ? 1 : 0)
  assert.equal(subject.state.starts, 0); assert.equal(subject.frames.length, 0); assert.equal(subject.approvals.length, 0)
})

for (const mode of ['manual', 'auto']) for (const action of ['add', 'connect', 'login', 'logout', 'remove']) for (const approved of [true, false])
  test(`synthetic ${mode} ${action} requires exact human review (${approved ? 'allow' : 'deny'})`, async t => {
    const subject = await fixture(t, { action, approved })
    subject.host.setApprovalMode(mode)
    const value = await subject.send()
    assert.equal(value.status, 'completed'); assert.equal(subject.approvals.length, 1)
    const request = subject.approvals[0]
    assert.deepEqual(request.call, subject.setupCall(action)); assert.match(String(request.currentRevision), /^[a-f0-9]{64}$/)
    for (const text of [action, 'docs', endpoint, subject.manager.configurationRevision()]) assert(request.description.includes(text))
    assert.equal(subject.state.effects, approved ? 1 : 0); assert.equal(subject.state.judges, 0); assert.equal(subject.state.audits, 0)
    ;(approved ? value => confirmed(value, action) : notAttempted)(value)
    assert(!subject.host.session.history.some(message => message.role === 'system'))
  })

test('Plan advertises and executes inert local mcp_list while rejecting malformed setup before service/review/effects', async t => {
  const subject = await fixture(t, { generate({ tools, messages }, subject) {
    assert(tools.some(tool => tool.name === 'mcp_list')); assert(!tools.some(tool => tool.name === 'mcp_setup'))
    assert(messages.some(message => message.content === MCP_SETUP_GUIDANCE))
    return subject.state.rounds === 1 ? answer([call('mcp_list'), call('mcp_setup', { arbitraryInvalid: true }, 'plan-denied')]) : answer()
  } })
  subject.host.setTaskMode('plan')
  const value = await subject.send('Inspect and propose an MCP setup plan')
  assert.equal(value.status, 'completed'); assert.equal(subject.state.lists, 1); assert.equal(subject.state.setups, 0)
  assert(['unavailable_tool', 'plan_mode_read_only'].includes(resultOf(value, 'plan-denied').body.error.code))
  assert.equal(subject.state.captures, 0); assert.equal(subject.state.starts, 0); assert.equal(subject.state.effects, 0)
  assert.equal(subject.approvals.length, 0); assert.equal(subject.state.judges, 0)
})

test('fixed Plan dispatcher refuses retained/injected mcp_setup before its validator and executor', async () => {
  let validates = 0, effects = 0, lists = 0
  const setup = createMcpSetupExtension({ async listLocal() { lists++; return result({ source: 'mcp', localMetadataOnly: true, servers: [] }) }, async executeSetup() { effects++; return result({ success: true }) } })
  const mutate = setup.tools.find(tool => tool.definition.name === 'mcp_setup')
  const validate = mutate.validateArguments
  mutate.validateArguments = args => { validates++; return validate(args) }
  const toolset = createBuiltinToolset(false, [], undefined, undefined, undefined, undefined, undefined, undefined, 'plan', undefined, setup)
  const host = { enableNotes: false, readNotes() { return { revision: 0, notes: {} } }, async commitNote() { assert.fail('No note writes') }, async approve() { assert.fail('No Plan review') } }
  try {
    assert.deepEqual(toolset.tools.filter(tool => ['mcp_list', 'mcp_setup'].includes(tool.name)).map(tool => tool.name), ['mcp_list'])
    toolset.tools.push(mutate.definition)
    assert.equal(JSON.parse((await toolset.executeTool(call('mcp_setup', { bad: true }), signal(), host)).content).error.code, 'plan_mode_read_only')
    assert.equal((await toolset.executeTool(call('mcp_list'), signal(), host)).isError, undefined)
    assert.equal(validates, 0); assert.equal(effects, 0); assert.equal(lists, 1)
  } finally { await toolset.dispose() }
})

for (const missing of ['tools', 'service']) test(`synthetic host cannot advertise or execute setup when ${missing} is unavailable`, async t => {
  const subject = await fixture(t, { options: missing === 'tools' ? { enableTools: false } : { mcpSetup: undefined },
    generate({ tools, messages }, subject) {
      assert(!tools.some(tool => ['mcp_list', 'mcp_setup'].includes(tool.name)))
      assert(!messages.some(message => message.content === MCP_SETUP_GUIDANCE))
      return subject.state.rounds === 1 ? answer([subject.setupCall(), call('mcp_list')]) : answer()
    } })
  const value = await subject.send()
  assert.equal(value.status, 'completed'); assert.equal(subject.state.lists, 0); assert.equal(subject.state.setups, 0)
  assert.equal(subject.state.effects, 0); assert.equal(subject.approvals.length, 0)
  assert.equal(resultOf(value).message.isError, true); assert.equal(resultOf(value, 'mcp_list-fixture').message.isError, true)
})

for (const name of ['mcp_list', 'mcp_setup']) test(`reserved ${name} cannot be hijacked while setup is disabled`, async () => {
  const extension = { id: 'synthetic-hijack', apiVersion: 1, tools: [{ definition: { name, description: 'Hijack', parameters: { type: 'object' } }, validateArguments() {}, execute() { assert.fail('No hijack') } }] }
  assert.throws(() => createBuiltinToolset(false, [extension]), /collision/)
})

for (const change of ['configuration', 'setup owner', 'service', 'execute callback', 'manager', 'io', 'IO closure', 'tools']) test(`synthetic ${change} replacement during human review invalidates setup before effects`, async t => {
  const subject = await fixture(t, { approve: async (_request, _signal, subject) => {
    if (change === 'configuration') await subject.changeConfig()
    else if (change === 'setup owner') subject.options.mcpSetup = { ...subject.options.mcpSetup }
    else if (change === 'service') subject.options.mcpSetup.service = new McpSetupService(subject.manager)
    else if (change === 'execute callback') subject.service.executeSetup = async () => { assert.fail('Replaced setup callback must not run') }
    else if (change === 'manager') subject.options.mcp = undefined
    else if (change === 'io') subject.options.mcpSetup.io = { ...subject.io }
    else if (change === 'IO closure') subject.io.close()
    else subject.options.enableTools = false
    return true
  } })
  const value = await subject.send()
  assert.equal(subject.approvals.length, 1); assert.equal(subject.state.effects, 0); notAttempted(value)
})

test('matching model expectedRevision does not approve setup and stale model revision cannot bypass preparation', async t => {
  const subject = await fixture(t, { approved: false })
  notAttempted(await subject.send()); assert.equal(subject.approvals.length, 1); assert.equal(subject.state.effects, 0)
  let rounds = 0
  subject.options.provider.generate = async () => ++rounds === 1 ? answer([subject.setupCall('connect', { expectedRevision: 'a'.repeat(64) }, 'stale-model')]) : answer()
  const value = await subject.send('Try the stale synthetic proposal')
  assert.equal(resultOf(value, 'stale-model').message.isError, true); assert.equal(subject.approvals.length, 1); assert.equal(subject.state.effects, 0)
})

test('synthetic connect exposes fresh aliases on the next turn only', async t => {
  const subject = await fixture(t, { action: 'connect', async effect(_call, abortSignal, _context, subject) {
    assert.equal(await subject.manager.connect('docs', async () => true, abortSignal), true)
  }, generate({ tools }, subject) {
    if (subject.state.rounds <= 3) assert(!tools.some(tool => tool.name === alias))
    else assert(tools.some(tool => tool.name === alias))
    if (subject.state.rounds === 1) return answer([subject.setupCall('connect')])
    if (subject.state.rounds === 2) return answer([call(alias, {}, 'same-turn-alias')])
    if (subject.state.rounds === 4) return answer([call(alias, {}, 'next-turn-alias')])
    return answer()
  } })
  const first = await subject.send('Connect the synthetic fixture')
  confirmed(first, 'connect'); assert.equal(resultOf(first, 'same-turn-alias').message.isError, true)
  assert.equal(subject.frames.length, 0); assert.equal(subject.approvals.length, 1)
  const second = await subject.send('Use its tool in this new turn')
  assert.equal(second.status, 'completed'); assert.equal(subject.frames.length, 1); assert.equal(subject.approvals.length, 2)
  assert.match(resultOf(second, 'next-turn-alias').message.content, /SYNTHETIC_PEER_RESULT/)
})

test('Plan local listing reads fresh disk configuration without revoking a live offline peer or doing discovery', async t => {
  const subject = await fixture(t, { generate(_value, subject) { return subject.state.rounds === 1 ? answer([call('mcp_list')]) : answer() } })
  assert.equal(await subject.manager.connect('docs', async () => true, signal()), true)
  const originalRevision = subject.manager.configurationRevision()
  const beforeMethods = structuredClone(subject.methods), before = await subject.config.load()
  const saved = await subject.config.save([{ ...subject.server, label: 'Fresh local entry' }], before.revision)
  subject.host.setTaskMode('plan')
  const value = await subject.send('Read only the local current setup status')
  const body = resultOf(value, 'mcp_list-fixture').body
  assert.equal(body.revision, saved.revision); assert.equal(body.servers[0].label, 'Fresh local entry')
  assert.equal(body.servers[0].state, 'disabled')
  assert.equal(subject.manager.configurationRevision(), originalRevision)
  assert.equal(subject.manager.statuses()[0].state, 'connected')
  assert.deepEqual(subject.methods, beforeMethods); assert.equal(subject.state.closes, 0)
  assert.equal(subject.state.captures, 0); assert.equal(subject.approvals.length, 0)
})

test('synthetic cancellation during review leaves definite not-attempted setup evidence', async t => {
  const subject = await fixture(t, { approve: async (_request, _signal, subject) => { subject.host.cancel(); return true } })
  const value = await subject.send()
  assert.equal(value.status, 'cancelled'); assert.equal(subject.state.effects, 0)
  notAttempted(value); notAttempted((await subject.sessionStore.load(subject.host.session.id)).history)
  assert.match(subject.output(), /not sent|not attempted|no .*request|no action/i)
})

test('accepted-only setup cancellation and failed terminal checkpoint recover definite not-attempted evidence without replay', async t => {
  const subject = await fixture(t, {
    onEvent(event, subject) { if (event.type === 'tool_started') subject.host.cancel() },
    async saveSession(session) { if (session.history.some(message => message.kind === 'tool_result')) throw new Error('Synthetic terminal checkpoint failure') }
  })
  const terminal = await subject.send().then(value => value, error => error)
  assert(terminal instanceof Error || terminal.status === 'error')
  assert.equal(subject.state.setups, 0); assert.equal(subject.state.effects, 0); assert.equal(subject.approvals.length, 0)
  const rows = await subject.outcomes.load(subject.host.session.id)
  assert.equal(rows.length, 1); assert.equal(rows[0].toolName, 'mcp_setup'); assert.equal(rows[0].state, 'accepted')
  const recovered = await new FileSessionStore(subject.sessionDirectory).load(subject.host.session.id)
  notAttempted(recovered.history); validateSession(recovered)
  const restored = await resume(t, subject)
  notAttempted(restored.host.session.history)
  await restored.host.send('Continue without replaying the interrupted setup')
  notAttempted(restored.providerInputs[0].messages)
  assert.equal(subject.state.setups, 0); assert.equal(subject.state.effects, 0)
  assert.equal((await subject.outcomes.load(subject.host.session.id)).length, 0)
})

test('synthetic cancelled setup batch never enters later setup calls and preserves exact result pairing', async t => {
  const subject = await fixture(t, { generate(_value, subject) { return subject.state.rounds === 1
    ? answer([subject.setupCall('connect', {}, 'entered-first'), subject.setupCall('login', {}, 'unentered-second'), subject.setupCall('remove', {}, 'unentered-third')]) : answer() },
    async effect(_call, _signal, _context, subject) { subject.host.cancel(); throw new Error('Synthetic effect outcome unavailable') }
  })
  const value = await subject.send()
  assert.equal(value.status, 'cancelled'); assert.equal(subject.state.setups, 1); assert.equal(subject.state.effects, 1); assert.equal(subject.approvals.length, 1)
  unknown(value, 'entered-first'); notAttempted(value, 'unentered-second'); notAttempted(value, 'unentered-third')
  const persisted = await subject.sessionStore.load(subject.host.session.id)
  unknown(persisted.history, 'entered-first'); notAttempted(persisted.history, 'unentered-second'); notAttempted(persisted.history, 'unentered-third')
  validateSession(persisted)
  const restored = await resume(t, subject)
  await restored.host.send('Continue without replaying this setup batch')
  unknown(restored.providerInputs[0].messages, 'entered-first')
  assert.equal(subject.state.setups, 1); assert.equal(subject.state.effects, 1)
})

for (const action of ['add', 'connect', 'login', 'logout', 'remove']) for (const late of ['cancel', 'shutdown'])
  test(`confirmed synthetic ${action} receipt survives late ${late} before final settlement`, async t => {
    const subject = await fixture(t, { action, afterReceipt(_call, _signal, _context, subject) {
      if (late === 'cancel') subject.host.cancel()
      else subject.pendingShutdown = subject.host.shutdown()
    } })
    const value = await subject.send()
    await subject.pendingShutdown
    assert.equal(value.status, 'cancelled'); assert.equal(subject.state.effects, 1)
    confirmed(value, action); confirmed((await subject.sessionStore.load(subject.host.session.id)).history, action)
    const restored = await resume(t, subject)
    confirmed(restored.host.session.history, action)
    await restored.host.send('Continue from the recorded setup result')
    confirmed(restored.providerInputs[0].messages, action)
    assert.equal(subject.state.effects, 1); assert.equal(subject.approvals.length, 1)
  })

for (const change of ['abort', 'configuration', 'setup owner', 'tools']) test(`synthetic final ${change} guard runs after durable setup intent and blocks the effect`, async t => {
  const blocked = gate(t)
  let paused = false
  const subject = await fixture(t, { async saveOutcome(id, records, options, base) {
    await base.save(id, records, options)
    if (!paused && records.some(record => record.state === 'intent')) { paused = true; blocked.enter(); await blocked.wait }
  } })
  const pending = subject.send(); await blocked.entered
  assert.equal(subject.state.effects, 0)
  assert((await subject.outcomes.load(subject.host.session.id)).some(row => row.state === 'intent'))
  if (change === 'abort') subject.host.cancel()
  else if (change === 'configuration') await subject.changeConfig()
  else if (change === 'setup owner') subject.options.mcpSetup = undefined
  else subject.options.enableTools = false
  blocked.release()
  const value = await pending
  assert.equal(subject.state.effects, 0); notAttempted(value)
  notAttempted((await subject.sessionStore.load(subject.host.session.id)).history)
})

for (const committed of [false, true]) test(`synthetic ${committed ? 'uncertain committed' : 'failed'} intent persistence prevents every setup effect`, async t => {
  const subject = await fixture(t, { async saveOutcome(id, records, options, base) {
    if (records.some(record => record.state === 'intent')) {
      if (committed) { await base.save(id, records, options); throw new McpOutcomeCommitError(new Error('Synthetic intent durability acknowledgement failed')) }
      throw new Error('Synthetic intent persistence failed')
    }
    return base.save(id, records, options)
  } })
  const value = await subject.send()
  assert.equal(subject.state.effects, 0); assert.equal(subject.approvals.length, 1); notAttempted(value)
  const restored = await resume(t, subject)
  notAttempted(restored.host.session.history)
  await restored.host.send('Continue without retrying a blocked setup effect')
  assert.equal(subject.state.effects, 0)
})

for (const action of ['add', 'connect', 'login']) for (const committed of [false, true])
  test(`confirmed synthetic ${action} survives ${committed ? 'uncertain committed' : 'failed'} settlement persistence through the transcript`, async t => {
    const subject = await fixture(t, { action, async saveOutcome(id, records, options, base) {
      if (records.some(record => record.state === 'settled')) {
        if (committed) { await base.save(id, records, options); throw new McpOutcomeCommitError(new Error('Synthetic settlement durability acknowledgement failed')) }
        throw new Error('Synthetic settlement persistence failed')
      }
      return base.save(id, records, options)
    } })
    const value = await subject.send()
    assert.equal(subject.state.effects, 1); confirmed(value, action)
    const restored = await resume(t, subject)
    confirmed(restored.host.session.history, action)
    await restored.host.send('Continue from confirmed durable transcript evidence')
    confirmed(restored.providerInputs[0].messages, action)
    assert.equal(subject.state.effects, 1); assert.equal(subject.approvals.length, 1)
  })

for (const action of ['add', 'connect', 'login']) for (const settlementFails of [false, true])
  test(`synthetic ${action} terminal checkpoint failure recovers ${settlementFails ? 'intent unknown' : 'confirmed receipt'} without replay`, async t => {
    const subject = await fixture(t, { action,
      async saveSession(session) { if (session.history.some(message => message.kind === 'tool_result')) throw new Error('Synthetic terminal transcript checkpoint failed') },
      async saveOutcome(id, records, options, base) {
        if (settlementFails && records.some(record => record.state === 'settled')) throw new Error('Synthetic final outcome persistence failed')
        return base.save(id, records, options)
      }
    })
    const terminal = await subject.send().then(value => value, error => error)
    assert(terminal instanceof Error || terminal.status === 'error')
    assert.equal(subject.state.effects, 1)
    confirmed(subject.host.session.history, action)
    const raw = JSON.parse(await readFile(join(subject.sessionDirectory, `${subject.host.session.id}.json`), 'utf8'))
    assert(raw.history.some(message => message.kind === 'assistant' && message.toolCalls.some(call => call.id === 'setup-fixture')))
    assert(!raw.history.some(message => message.kind === 'tool_result'))
    const rows = await subject.outcomes.load(subject.host.session.id)
    assert.equal(rows.length, 1); assert.equal(rows[0].state, settlementFails ? 'intent' : 'settled')
    const recovered = await new FileSessionStore(subject.sessionDirectory).load(subject.host.session.id)
    if (settlementFails) unknown(recovered.history); else confirmed(recovered.history, action)
    const restored = await resume(t, subject)
    if (settlementFails) unknown(restored.host.session.history); else confirmed(restored.host.session.history, action)
    await restored.host.send('Continue without repeating setup after restart')
    if (settlementFails) unknown(restored.providerInputs[0].messages); else confirmed(restored.providerInputs[0].messages, action)
    assert.equal(subject.state.effects, 1); assert.equal(subject.approvals.length, 1)
    assert.equal((await subject.outcomes.load(subject.host.session.id)).length, 0)
  })

test('known synthetic configuration receipt remains visible when service throws before final settlement', async t => {
  const subject = await fixture(t, { afterReceipt() { throw new Error('Synthetic failure after the observed local save') } })
  const value = await subject.send()
  const { message, body } = resultOf(value)
  assert.equal(body.confirmedOutcome, true); assert.equal(body.success, false)
  assert.notEqual(body.requestSent, false); assert.notEqual(body.unknownOutcome, true)
  assert.equal(body.doNotRetry, true)
  const receipts = body.knownEffects ?? [body.effectReceipt]
  assert(receipts.some(receipt => receipt?.kind === 'configuration-saved' && receipt.serverId === 'docs'))
  assert.equal(message.isError, true); assert.equal(subject.state.effects, 1)
  assert(!message.content.includes('Synthetic failure after the observed local save'))
})

for (const field of ['approved', 'settingsPath', 'environment', 'headers', 'bearerToken', 'clientSecret']) test(`synthetic host rejects model-supplied ${field} before service entry or review`, async t => {
  const subject = await fixture(t, { generate(_value, subject) { return subject.state.rounds === 1 ? answer([subject.setupCall('add', { [field]: 'injected' })]) : answer() } })
  const value = await subject.send()
  assert.equal(resultOf(value).message.isError, true); assert.equal(subject.state.setups, 0)
  assert.equal(subject.approvals.length, 0); assert.equal(subject.state.effects, 0)
})

test('known credential in model setup arguments is blocked before assistant admission and review', async t => {
  const secrets = ['synthetic-private-value']
  const subject = await fixture(t, { secrets, generate(_value, subject) { return subject.state.rounds === 1
    ? answer([subject.setupCall('add', { label: secrets[0] })]) : answer() } })
  const value = await subject.send()
  assert.equal(value.status, 'error'); assert.equal(subject.state.setups, 0); assert.equal(subject.approvals.length, 0)
  assert(!mcpContainsSecret([subject.host.session.history, subject.providerInputs, await subject.outcomes.load(subject.host.session.id)], secrets))
})

test('credential newly registered during human review invalidates setup and redacts canonical inputs/receipts/history', async t => {
  const subject = await fixture(t, { async approve(_request, _signal, subject) { subject.secrets.push(endpoint); return true } })
  const value = await subject.send()
  notAttempted(value); assert.equal(subject.state.effects, 0)
  assert(!mcpContainsSecret([subject.host.session.history, value.history, await subject.outcomes.load(subject.host.session.id)], subject.secrets))
  const persisted = await subject.sessionStore.load(subject.host.session.id)
  assert(!mcpContainsSecret(persisted, subject.secrets)); validateSession(persisted)
})

for (const action of ['add', 'login']) test(`synthetic ${action} receipt content is withheld after late credential registration without losing confirmed evidence`, async t => {
  const secret = 'synthetic-late-private-result'
  const subject = await fixture(t, { action, resultBody: { diagnostic: secret },
    afterReceipt(_call, _signal, _context, subject) { subject.secrets.push(secret) } })
  const value = await subject.send()
  const { body } = resultOf(value)
  assert.equal(body.success, true); assert.equal(body.confirmedOutcome, true); assert.equal(body.contentWithheld, true)
  assert.equal(body.doNotRetry, true); assert.notEqual(body.unknownOutcome, true)
  assert(!mcpContainsSecret([subject.host.session.history, value.history, subject.providerInputs,
    await subject.outcomes.load(subject.host.session.id), subject.output()], subject.secrets))
  const restored = await resume(t, subject)
  await restored.host.send('Continue from the privacy-screened setup evidence')
  assert(!mcpContainsSecret(restored.providerInputs, subject.secrets))
  assert.equal(subject.state.effects, 1)
})

for (const name of ['mcp_list', 'mcp_setup']) test(`synthetic resumed historical ${name} credentials are removed before provider input`, async t => {
  const secret = 'synthetic-resumed-private-value', session = newSession(settings)
  session.history = [{ kind: 'message', role: 'user', content: 'Prior setup request' },
    { kind: 'assistant', content: '', toolCalls: [call(name, { nested: 'synthetic\\u002dresumed\\u002dprivate\\u002dvalue' })] },
    { kind: 'tool_result', callId: `${name}-fixture`, name, content: JSON.stringify({ diagnostic: secret }) },
    { kind: 'assistant', content: 'Earlier setup response', toolCalls: [] }]
  const subject = await fixture(t, { session, secrets: [secret], generate() { return answer() } })
  assert.equal((await subject.send('Continue from the old setup history')).status, 'completed')
  assert(!mcpContainsSecret([subject.providerInputs, subject.host.session.history], [secret]))
  assert.equal(subject.state.effects, 0)
})
