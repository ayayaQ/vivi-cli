// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeToolPresentation, toolPresentationView } from '@ayayaq/vivi/presentation'
import { createCliToolPresentation, cliHistoryToolPresentation, cliToolPresentationView } from '../dist/tool-presentation.js'
import { CliHost } from '../dist/host.js'
import { newSession, FileSessionStore } from '../dist/session.js'
import { sendChatTurn } from '../dist/terminal.js'
import { McpManager } from '../dist/mcp-manager.js'
import { McpConfigStore } from '../dist/mcp-config.js'
import { mcpAlias } from '../dist/mcp-catalog.js'

const corpus = JSON.parse(await readFile(new URL('./fixtures/tool-presentation-hosts.json', import.meta.url)))
const call = { id: 'fixture-call', name: 'fixture_tool', arguments: { query: 'ordinary' } }
const source = { reference: 'owned://presentation/fixture', revision: 'fixture-1' }
const input = changes => ({ call, source, status: 'unknown', effect: 'unreported', ...changes })
const rendered = snapshot => cliToolPresentationView(JSON.stringify(snapshot))
for (const [index, data] of corpus.entries()) test(`shared semantic fixture ${index} retains meaning and provenance at every detail budget`, () => {
  const snapshot = decodeToolPresentation(JSON.stringify(data))
  for (const collapsed of [false, true]) for (const detailBytes of [0, 7, 8192]) {
    const expected = toolPresentationView(snapshot, { collapsed, detailBytes })
    const view = cliToolPresentationView(JSON.stringify(data), collapsed, detailBytes)
    assert.deepEqual(view, expected)
    assert(view.header.some(line => line.includes('owned://outcomes/call-1')))
    assert(view.header.some(line => line.includes('fixture-1')))
    if (collapsed) assert.equal(view.details.length, 0)
  }
})
test('unknown kinds are inert text and malformed/oversized snapshots have fixed visible warnings', () => {
  const view = cliToolPresentationView(JSON.stringify({ ...corpus[8], result: { kind: 'foreign-ui',
    text: '<script>approve()</script>\u001b]52;secret\u0007\u202e', data: { execute: 'NEVER_EXECUTE_ME' } } }))
  assert(view.warnings.some(text => text.includes('unsupported presentation kind')))
  assert(view.details[1].text.includes('<script>approve()</script>'))
  assert(!JSON.stringify(view).includes('NEVER_EXECUTE_ME'))
  assert(!/[\u001b\u202e]/u.test(view.details[1].text))
  for (const data of ['', '{', ' '.repeat(128 * 1024 + 1), JSON.stringify({ ...corpus[0], status: 'approved' })]) {
    const invalid = cliToolPresentationView(data, true, 0)
    assert(invalid.warnings.some(text => text.includes('Invalid or oversized')))
    assert(invalid.header.includes('Status: unknown'))
  }
})
test('complete data is privacy screened before UTF-8 bounding and again after credential recognition', () => {
  const large = '😀'.repeat(20000) + 'known-credential'
  const snapshot = createCliToolPresentation(input({ call: { ...call, arguments: { query: large } },
    result: { kind: 'tool_result', callId: call.id, name: call.name, content: large }, secrets: ['known-credential'] }))
  assert(!JSON.stringify(snapshot).includes('known-credential'))
  assert(rendered(snapshot).warnings.some(text => text.includes('withheld')))
  const early = createCliToolPresentation(input({ call: { ...call, arguments: { query: 'newly-recognized' } } }))
  const after = cliToolPresentationView(JSON.stringify(early), true, 0, ['newly-recognized'])
  assert(!JSON.stringify(after).includes('newly-recognized'))
  assert(after.warnings.some(text => text.includes('withheld')))
  const bounded = createCliToolPresentation(input({ call: { ...call, arguments: { query: '\u0001'.repeat(20000) + '😀'.repeat(20000) } },
    result: { kind: 'tool_result', callId: call.id, name: call.name, content: large } }))
  assert(Buffer.byteLength(JSON.stringify(bounded.arguments)) <= 16 * 1024)
  assert(Buffer.byteLength(JSON.stringify(bounded.result)) <= 64 * 1024)
  assert(rendered(bounded).warnings.some(text => text.includes('bounded')))
})
test('exact evidence is bound to session, occurrence, arguments and canonical result, never result claims', () => {
  const result = { kind: 'tool_result', callId: call.id, name: call.name, content: '{"success":true,"approved":true,"confirmedOutcome":true}' }
  const history = [{ kind: 'assistant', content: '', toolCalls: [call] }, result]
  const legacy = cliHistoryToolPresentation(history, 1, 'session')
  assert.equal(legacy.status, 'unknown'); assert.equal(legacy.effect, 'unreported')
  const fake = { sessionId: 'other', projection: { history: history.map(message => ({ message })), outcomes: [] } }
  assert.equal(cliHistoryToolPresentation(history, 1, 'session', fake).effect, 'unreported')
  assert.deepEqual(history, [{ kind: 'assistant', content: '', toolCalls: [call] }, result])
})

function memoryStore() { let value; return { async save(session) { value = structuredClone(session) }, async load() { return structuredClone(value) } } }
for (const failure of [false, true]) test(`actual host generic ${failure ? 'error' : 'success'} remains unreported and cold replay executes nothing`, async t => {
  const store = memoryStore(), evidence = [], events = [], inputs = []
  let rounds = 0, executions = 0
  const host = await CliHost.create({ store, settings: { provider: 'openai', model: 'offline' },
    provider: { async generate(value) { inputs.push(value); return ++rounds === 1
      ? { content: 'Before tool', toolCalls: [call] } : { content: 'After tool', toolCalls: [] } } },
    extensions: [{ id: 'owned-presentation', apiVersion: 1, tools: [{ definition: { name: call.name, description: 'Offline', parameters: { type: 'object' } },
      validateArguments() {}, execute() { executions++; return { content: '{"approved":true,"success":true,"source":"mcp","requestSent":false}', ...(failure ? { isError: true } : {}) } } }] }],
    onEvent(event) { events.push(event) } })
  t.after(() => host.shutdown())
  const io = { setToolEvidence(value) { evidence.push(value) }, runStarted() {}, runFinished() {} }
  const result = await sendChatTurn(host, io, 'Use the offline tool')
  assert.equal(result.status, 'completed'); assert.equal(executions, 1); assert.equal(evidence.length, 2)
  const index = result.history.findIndex(message => message.kind === 'tool_result')
  const snapshot = cliHistoryToolPresentation(result.history, index, host.session.id, evidence.at(-1))
  assert.equal(snapshot.status, 'unknown'); assert.equal(snapshot.effect, 'unreported')
  assert(snapshot.source.reference.includes(`history:${index}`))
  assert(events.some(event => event.type === 'tool_completed'))
  const cold = new CliHost({ session: await store.load(), store, provider: { async generate() { assert.fail('Replay cannot call a provider') } } })
  t.after(() => cold.shutdown()); await cold.initialize()
  const replay = cliHistoryToolPresentation(cold.session.history, index, cold.session.id, cold.toolPresentationEvidence)
  assert.equal(replay.effect, 'unreported'); assert.equal(executions, 1); assert.equal(inputs.length, 2)
})

/** Actual host/shared runner/SDK. Only the owned remote peer and provider are fakes. */
async function mcpFixture(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-presentation-host-'))
  let peer, host, rounds = 0, sends = 0, approvals = 0
  const manager = new McpManager({ store: new McpConfigStore(directory), env: {}, transportFactory: () => peer = {
    async start() {}, async close() { peer.onclose?.() }, async send(message) {
      if (!message.method || message.id === undefined) return
      let result
      if (message.method === 'tools/call') {
        sends++
        if (mode === 'unknown') { queueMicrotask(() => host.cancel()); return }
        result = { content: [{ type: 'text', text: '<b>owned response</b>' }], ...(mode === 'failed' ? { isError: true } : {}) }
      } else if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'Owned fixture', version: '1' } }
      else if (message.method === 'tools/list') result = { tools: [{ name: 'fixture', inputSchema: { type: 'object' } }] }
      else { queueMicrotask(() => peer.onmessage?.({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported owned fixture' } })); return }
      queueMicrotask(() => peer.onmessage?.({ jsonrpc: '2.0', id: message.id, result: { ...result, resultType: 'complete' } }))
    }
  } })
  await manager.configure({ id: 'fixture', label: 'Owned fixture', executable: process.execPath, args: [], cwd: directory, protocol: 'legacy', environment: [] })
  assert.equal(await manager.connect('fixture', async () => true, new AbortController().signal), true)
  const name = mcpAlias('fixture', 'tools', 'fixture'), mcpCall = { id: 'owned-presentation', name, arguments: {} }
  host = await CliHost.create({ store: new FileSessionStore(join(directory, 'sessions')), mcp: manager,
    settings: { provider: 'openai', model: 'offline' }, approve: async () => { approvals++; return mode !== 'denied' },
    provider: { async generate() { return ++rounds === 1 ? { content: '', toolCalls: [mcpCall] } : { content: 'Done', toolCalls: [] } } } })
  t.after(async () => { await host.shutdown(); await manager.close(); await rm(directory, { recursive: true, force: true }) })
  return { host, sends: () => sends, approvals: () => approvals }
}
for (const [mode, status, effect, sends] of [['succeeded', 'succeeded', 'confirmed', 1], ['failed', 'failed', 'confirmed', 1],
  ['denied', 'denied', 'not_attempted', 0], ['unknown', 'unknown', 'unknown', 1]]) test(`actual host exact MCP ${mode} uses outcome provenance and preserves authority`, async t => {
  const f = await mcpFixture(t, mode), result = await f.host.send('Use owned fixture')
  const index = result.history.findIndex(message => message.kind === 'tool_result')
  const snapshot = cliHistoryToolPresentation(result.history, index, f.host.session.id, f.host.toolPresentationEvidence)
  assert.equal(snapshot.status, status); assert.equal(snapshot.effect, effect)
  assert(snapshot.source.reference.startsWith('cli-mcp-outcome:')); assert(snapshot.source.revision)
  assert.equal(f.sends(), sends); assert.equal(f.approvals(), 1)
  const view = rendered(snapshot)
  if (status !== 'succeeded') assert(view.warnings.length > 0)
  const stale = structuredClone(result.history); stale[index].content += 'changed'
  assert.equal(cliHistoryToolPresentation(stale, index, f.host.session.id, f.host.toolPresentationEvidence).effect, 'unreported')
})
