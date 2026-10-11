// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TextRenderable, MarkdownRenderable, BoxRenderable, ScrollBoxRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { toolPresentationView, decodeToolPresentation } from '@ayayaq/vivi/presentation'
import type { ToolPresentation } from '@ayayaq/vivi/presentation'
import { OpenTuiIO, TUI_THEME } from '../src/tui.js'
import { cliToolCardView } from '../src/tool-presentation.js'
import { CliHost } from '../src/host.js'
import { FileSessionStore, newSession, validateSession } from '../src/session.js'
import { McpManager } from '../src/mcp-manager.js'
import { McpConfigStore } from '../src/mcp-config.js'
import { mcpAlias } from '../src/mcp-catalog.js'
import { sendChatTurn } from '../src/terminal.js'
import type { ApprovalRequest } from '../src/tools.js'

const corpus: ToolPresentation[] = JSON.parse(await readFile(new URL('./fixtures/tool-presentation-hosts.json', import.meta.url), 'utf8'))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const nodes = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(nodes)]
const contents = (node: Renderable): string => nodes(node).filter(item => item instanceof TextRenderable || item instanceof MarkdownRenderable).map(item => item instanceof MarkdownRenderable ? item.content : (item as TextRenderable).plainText).join('\n')
async function fixture(width = 100, height = 40) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  cleanups.push(async () => { io.close(); await Promise.resolve() })
  const frame = async (): Promise<string> => { await new Promise(resolve => setTimeout(resolve, 3)); await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const transcript = () => setup.renderer.root.findDescendantById('vivi-transcript')!
  const headers = () => nodes(transcript()).filter(node => node.id.startsWith('vivi-tool-details-')) as TextRenderable[]
  const body = (header: Renderable) => setup.renderer.root.findDescendantById(header.id.replace('vivi-tool-details-', 'vivi-tool-body-'))!
  const reveal = async (header: Renderable) => {
    const scroll = transcript() as ScrollBoxRenderable
    const current = setup.renderer.root.findDescendantById(header.id)!
    scroll.scrollTo(scroll.scrollTop + current.y - scroll.viewport.y)
    await frame()
    return setup.renderer.root.findDescendantById(header.id) as TextRenderable
  }
  const clickHeader = async (header: Renderable, emptyRight = false) => {
    const target = await reveal(header)
    const viewport = (transcript() as ScrollBoxRenderable).viewport
    const right = Math.min(target.x + target.width, target.parent!.x + target.parent!.width, viewport.x + viewport.width) - 1
    await setup.mockMouse.click(emptyRight ? right : target.x + 1, target.y)
    await frame()
  }
  const expandAll = async () => {
    for (const header of headers()) if (body(header).getChildren().length === 0) await clickHeader(header)
  }
  return { io, setup, frame, transcript, input: setup.mockInput, headers, body, reveal, clickHeader, expandAll }
}
for (const [index, snapshot] of corpus.entries()) test(`actual OpenTUI shared fixture ${index} is compact by default and preserves full expanded semantics`, async () => {
  const f = await fixture(40, 40), encoded = JSON.stringify(snapshot)
  f.io.toolPresentation(encoded); await f.frame()
  const expected = toolPresentationView(decodeToolPresentation(encoded), { detailBytes: 8192 })
  const compact = cliToolCardView(encoded)
  const [header] = f.headers()
  expect(header).toBeInstanceOf(TextRenderable)
  expect(header!.selectable).toBe(false)
  expect(header!.plainText).toStartWith('▸ ')
  expect(header!.height).toBe(1)
  expect(f.body(header!).getChildren()).toHaveLength(0)
  const collapsed = contents(f.transcript())
  expect(collapsed).not.toContain('Source:')
  expect(collapsed).not.toContain('Arguments:')
  expect(collapsed).not.toContain('Details collapsed.')
  for (const warning of compact.warnings) expect(collapsed).toContain(warning)
  expect(nodes(f.transcript()).some(node => node instanceof MarkdownRenderable)).toBe(false)
  f.input.pressKey('o', { ctrl: true }); await f.frame()
  const body = f.body(header!)
  for (const line of expected.header) expect(contents(body)).toContain(line)
  for (const warning of expected.warnings) expect(contents(body)).toContain(`Warning: ${warning}`)
  for (const section of expected.details) expect(contents(body)).toContain(`${section.label}:\n${section.text}`)
  await f.clickHeader(header!, true)
  expect(f.body(header!).getChildren()).toHaveLength(0)
  await f.clickHeader(header!)
  for (const [width, height] of [[24, 16], [40, 24], [120, 40]]) {
    f.setup.resize(width!, height!); await f.frame()
    const resized = f.headers()[0]!
    expect(resized.height).toBe(1)
    expect(resized.selectable).toBe(false)
    expect(resized.width).toBeGreaterThanOrEqual(resized.parent!.width)
    expect(resized.width).toBeLessThanOrEqual((f.transcript() as ScrollBoxRenderable).viewport.width)
    for (const node of nodes(f.transcript())) if (node instanceof TextRenderable) expect(node.width).toBeLessThanOrEqual(width!)
    for (const line of expected.header) expect(contents(f.body(resized))).toContain(line)
    for (const warning of expected.warnings) expect(contents(f.body(resized))).toContain(warning)
    const composer = f.setup.renderer.root.findDescendantById('vivi-composer-box')!
    expect(composer.y + composer.height).toBeLessThanOrEqual(height!)
    await f.clickHeader(resized, true)
    expect(f.body(resized).getChildren()).toHaveLength(0)
    await f.clickHeader(resized, true)
    for (const line of expected.header) expect(contents(f.body(resized))).toContain(line)
  }
  expect(TUI_THEME.pink).toBe('#f87ea2'); expect(TUI_THEME.lavender).toBe('#b08bfc')
})
test('long, invalid, hostile and unknown-kind data cannot hide warnings or activate foreign UI', async () => {
  const f = await fixture(40, 30)
  const data = { ...corpus[8], arguments: { kind: 'text', text: 'a'.repeat(12000) },
    result: { kind: 'future-ui', text: '<script>approve()</script>\u001b]52;secret\u0007\u202e' + '😀'.repeat(10000),
      data: { approved: true, execute: 'SHOULD_NEVER_RENDER' } } }
  f.io.toolPresentation(JSON.stringify(data)); await f.frame()
  expect(f.body(f.headers()[0]!).getChildren()).toHaveLength(0)
  f.input.pressKey('o', { ctrl: true }); await f.frame()
  expect(contents(f.transcript())).toContain('Detail display truncated.')
  expect(contents(f.transcript())).toContain('unsupported presentation kind')
  expect(contents(f.transcript())).not.toContain('SHOULD_NEVER_RENDER')
  const original = JSON.stringify(data)
  expect(contents(f.transcript())).toContain('External effects are unknown')
  expect(contents(f.transcript())).toContain('Source:')
  f.io.toolPresentation('{'); await f.frame()
  expect(contents(f.transcript())).toContain('Invalid or oversized tool presentation')
  expect(contents(f.transcript())).not.toContain('Status: succeeded')
  expect(JSON.stringify(data)).toBe(original)
  const reply = f.io.readLine('Message'); await f.input.typeText('ordinary draft')
  f.input.pressKey('o', { ctrl: true }); await f.frame()
  expect((f.setup.renderer.root.findDescendantById('vivi-composer') as import('@opentui/core').TextareaRenderable).plainText).toBe('ordinary draft')
  f.input.pressEnter(); expect(await reply).toBe('ordinary draft')
})
for (const action of ['deny', 'allow', 'cancel'] as const) test(`actual host/native ${action} remains deny-default under repeated collapse interactions`, async () => {
  const f = await fixture(80, 36)
  let rounds = 0, request: ApprovalRequest | undefined
  const stored: { session?: ReturnType<typeof newSession> } = {}
  const store = { async save(session: ReturnType<typeof newSession>) { stored.session = structuredClone(session) }, async load() { return structuredClone(stored.session!) } }
  const host = await CliHost.create({ store, settings: { provider: 'openai', model: 'owned-offline' }, enableNotes: true,
    provider: { async generate(input) { rounds++; return input.messages.at(-1)?.kind === 'message' ? { content: 'Before reviewed call', toolCalls: [{ id: `note-${rounds}`, name: 'note_set',
      arguments: { key: 'color', value: 'pink', expectedRevision: host.session.noteRevision } }] } : { content: 'After reviewed call', toolCalls: [] } } },
    approve(value, signal) { request = value; return f.io.approve(value, signal) }, onEvent(event) { f.io.event(event) } })
  cleanups.push(async () => { await host.shutdown() })
  f.io.setSession(host.session)
  const dispose = f.io.onCancel(() => host.cancel()); cleanups.push(async () => dispose())
  for (let turn = 0; turn < 2; turn++) {
    request = undefined
    const running = sendChatTurn(host, f.io, 'Set a color note to pink')
    for (let attempt = 0; attempt < 1000 && !request; attempt++) await f.frame()
    expect(request).toBeDefined(); await f.frame()
    const requestIndex = host.session.history.findIndex(message => message.kind === 'assistant' && message.toolCalls.some(call => call.id === request!.call.id))
    const reviewed = f.headers().at(-1)!
    expect(f.body(reviewed).getChildren()).toHaveLength(0)
    expect(reviewed.plainText).toContain('approval required')
    f.input.pressKey('o', { ctrl: true }); await f.frame()
    expect(contents(f.body(reviewed))).toContain(`cli-session:${host.session.id}:history:${requestIndex}`)
    expect(contents(f.transcript())).toContain('Approval required. This display grants no permission to execute.')
    f.input.pressKey('o', { ctrl: true }); f.input.pressKey('o', { ctrl: true }); f.input.pressKey('o', { ctrl: true }); await f.frame()
    expect(f.body(reviewed).getChildren()).toHaveLength(0)
    expect(f.headers().at(-1)!.plainText).toContain('approval required')
    expect((f.setup.renderer.root.findDescendantById('vivi-deny') as TextRenderable).plainText).toContain('› Deny')
    const allow = f.setup.renderer.root.findDescendantById('vivi-approve')!
    if (action === 'allow') { if (turn === 0) await f.setup.mockMouse.click(allow.x + 1, allow.y); else { f.input.pressArrow('right'); f.input.pressEnter() } }
    else if (action === 'cancel') f.input.pressEscape()
    else f.input.pressEnter()
    const result = await running; f.io.result(result); f.io.setSession(host.session); await f.frame()
    expect(host.session.noteRevision).toBe(action === 'allow' ? turn + 1 : 0)
    expect(f.body(f.headers().at(-1)!).getChildren()).toHaveLength(0)
    expect(f.headers().at(-1)!.plainText).toContain(action === 'allow' ? 'unverified' : action === 'deny' ? 'denied' : 'cancelled')
    f.input.pressKey('o', { ctrl: true }); await f.frame()
    expect(contents(f.transcript())).not.toContain('Status: approval_required')
    expect(contents(f.transcript())).not.toContain('Status: running')
    expect(contents(f.transcript())).toContain(`Status: ${action === 'allow' ? 'unknown' : action === 'deny' ? 'denied' : 'cancelled'}`)
    if (action === 'allow') expect(contents(f.transcript())).toContain('External effects are unreported')
    else expect(contents(f.transcript())).toContain('Effect: not_attempted')
    const text = contents(f.transcript())
    expect(text.indexOf('Before reviewed call')).toBeLessThan(text.indexOf('note_set'))
    if (action !== 'cancel') expect(text.lastIndexOf('note_set')).toBeLessThan(text.lastIndexOf('After reviewed call'))
  }
})
test('late credential recognition and canonical refresh/reused call IDs never transfer display authority', async () => {
  const f = await fixture(), session = newSession({ provider: 'openai', model: 'offline' })
  const call = { id: 'same', name: 'offline_tool', arguments: { value: 'future-credential' } }
  session.history = [{ kind: 'message', role: 'user', content: 'first' }, { kind: 'assistant', content: '', toolCalls: [call] },
    { kind: 'tool_result', callId: call.id, name: call.name, content: 'ordinary first result' },
    { kind: 'message', role: 'user', content: 'second' }, { kind: 'assistant', content: '', toolCalls: [{ ...call, arguments: {} }] },
    { kind: 'tool_result', callId: call.id, name: call.name, content: 'ordinary second result' }]
  const original = structuredClone(session)
  f.io.setSession(session); await f.frame()
  f.input.pressKey('o', { ctrl: true }); await f.frame(); f.io.setSession(session); await f.frame()
  const tools = nodes(f.transcript()).filter(node => node.id.startsWith('vivi-tool-details-'))
  expect(tools).toHaveLength(2); expect(new Set(tools.map(node => node.id)).size).toBe(2)
  expect(f.body(tools[0]!).getChildren()).toHaveLength(0)
  expect(contents(f.body(tools[1]!))).toContain('ordinary second result')
  await f.clickHeader(tools[0]!)
  f.io.addSecrets(['future-credential']); await f.frame()
  expect(contents(f.transcript())).not.toContain('future-credential')
  expect(contents(f.transcript())).toContain('withheld')
  expect(session).toEqual(original)
  const next = newSession({ provider: 'openai', model: 'next' }); f.io.setSession(next); await f.frame()
  expect(contents(f.transcript())).not.toContain('ordinary first result')
  expect(f.headers()).toHaveLength(0)
})

test('detail key repeats/releases and stale mouse gestures cannot select or confirm human approval', async () => {
  const f = await fixture(100, 50)
  f.io.toolPresentation(JSON.stringify(corpus[1])); await f.frame()
  const initial = contents(f.transcript())
  for (const sequence of ['\u001b[111;5:2u', '\u001b[111;5:3u']) {
    f.setup.renderer.stdin.emit('data', Buffer.from(sequence)); await f.frame()
    expect(contents(f.transcript())).toBe(initial)
  }
  const toggle = f.setup.renderer.root.findDescendantById('vivi-tool-details-display-0')!
  await f.setup.mockMouse.pressDown(toggle.x + 1, toggle.y)
  const answer = f.io.approve({ call: { id: 'human-exact', name: 'note_set', arguments: {} },
    description: 'Exact owned fake approval', currentRevision: 0 }, new AbortController().signal)
  let settled = false; void answer.then(() => { settled = true })
  await f.frame()
  const yes = f.setup.renderer.root.findDescendantById('vivi-approve')!
  await f.setup.mockMouse.release(yes.x + 1, yes.y); await f.frame()
  expect(settled).toBe(false)
  f.input.pressKey('o', { ctrl: true }); await f.frame()
  expect(contents(f.transcript())).toContain('Exact owned fake approval')
  expect((f.setup.renderer.root.findDescendantById('vivi-deny') as TextRenderable).plainText).toContain('› Deny')
  f.input.pressEnter(); expect(await answer).toBe(false)
})

test('live request/result source revisions and indices equal the actual host canonical entries', async () => {
  const f = await fixture(100, 45)
  const sourceHashes: string[] = []
  let rounds = 0
  const { createHash } = await import('node:crypto')
  const host = await CliHost.create({ store: { async save() {}, async load() { throw new Error('unused') } },
    settings: { provider: 'openai', model: 'offline' },
    provider: { async generate() { return ++rounds % 2 === 1 ? { content: 'Before', toolCalls: [{ id: `call-${rounds}`, name: 'current_time', arguments: {} }] }
      : { content: 'After', toolCalls: [] } } },
    onEvent(event) {
      f.io.event(event)
      if (event.type === 'assistant' && event.message.toolCalls.length || event.type === 'tool_completed') {
        const index = host.session.history.length - 1, message = host.session.history[index]!
        const revision = createHash('sha256').update(JSON.stringify(message)).digest('hex')
        if (f.body(f.headers().at(-1)!).getChildren().length === 0) f.input.pressKey('o', { ctrl: true })
        const text = contents(f.body(f.headers().at(-1)!))
        expect(text).toContain(`cli-session:${host.session.id}:history:${index}`)
        expect(text).toContain(revision); sourceHashes.push(revision)
      }
    } })
  cleanups.push(async () => host.shutdown()); f.io.setSession(host.session)
  for (let turn = 0; turn < 2; turn++) {
    const result = await sendChatTurn(host, f.io, 'Use the offline clock'); f.io.result(result); f.io.setSession(host.session); await f.frame()
  }
  expect(sourceHashes).toHaveLength(4); expect(new Set(sourceHashes).size).toBe(4)
})
for (const late of [false, true]) test(`encoded private tool identities and summaries are withheld ${late ? 'after registration' : 'at first render'}`, async () => {
  const f = await fixture(100, 45)
  const encoded = '%6b%6e%6f%77%6e%2d%63%72%65%64%65%6e%74%69%61%6c'
  if (!late) f.io.addSecrets(['known-credential'])
  const session = newSession({ provider: 'openai', model: 'offline' })
  session.history = [{ kind: 'message', role: 'user', content: 'ordinary' },
    { kind: 'assistant', content: '', toolCalls: [{ id: 'identity-call', name: encoded, arguments: {} }] },
    { kind: 'tool_result', callId: 'identity-call', name: encoded, content: 'ordinary result' }]
  const { validateSession } = await import('../src/session.js'); validateSession(session)
  const original = structuredClone(session)
  f.io.setSession(session); await f.frame()
  if (late) { expect(contents(f.transcript())).toContain(encoded); f.io.addSecrets(['known-credential']); await f.frame() }
  expect(contents(f.transcript())).not.toContain(encoded)
  expect(contents(f.transcript())).not.toContain('known-credential')
  expect(contents(f.transcript())).toContain('withheld')
  f.io.setSession(session); await f.frame()
  expect(contents(f.transcript())).not.toContain(encoded)
  expect(session).toEqual(original)
})

test('interrupted mixed batch still reports the exact canonical MCP result source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-review-mixed-cancel-'))
  const setup = await createTestRenderer({ width: 110, height: 55, kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  let peer: any, pending = false, rounds = 0, sends = 0
  const manager = new McpManager({ store: new McpConfigStore(directory), env: {}, transportFactory: () => peer = {
    async start() {}, async close() { peer.onclose?.() }, async send(message: any) {
      if (!message.method || message.id === undefined) return
      let result: any
      if (message.method === 'tools/call') { sends++; result = { content: [{ type: 'text', text: 'owned' }] } }
      else if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'Owned fake', version: '1' } }
      else if (message.method === 'tools/list') result = { tools: [{ name: 'fixture', inputSchema: { type: 'object' } }] }
      else { queueMicrotask(() => peer.onmessage?.({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported owned fixture' } })); return }
      queueMicrotask(() => peer.onmessage?.({ jsonrpc: '2.0', id: message.id, result: { ...result, resultType: 'complete' } }))
    } } })
  // The injected owned transport never starts an executable or uses a network.
  const ownedScript = join(directory, 'owned-peer.mjs')
  await writeFile(ownedScript, 'export {}\n')
  await manager.configure({ id: 'fixture', label: 'Owned fake', executable: process.execPath,
    args: ['--no-install', ownedScript], cwd: directory, protocol: 'legacy', environment: [] })
  await manager.connect('fixture', async () => true, new AbortController().signal)
  let observed: { actualIndex: number; sourceIndex: number; text: string } | undefined
  const host = await CliHost.create({ store: new FileSessionStore(join(directory, 'sessions')), enableNotes: true, mcp: manager,
    settings: { provider: 'openai', model: 'offline' },
    provider: { async generate() { return ++rounds === 1 ? { content: 'Before mixed batch', toolCalls: [
      { id: 'cancel-note', name: 'note_set', arguments: { key: 'color', value: 'pink', expectedRevision: 0 } },
      { id: 'unstarted-mcp', name: mcpAlias('fixture', 'tools', 'fixture'), arguments: {} }] } : { content: 'After', toolCalls: [] } } },
    approve(request, signal) { pending = true; return io.approve(request, signal) },
    onEvent(event) {
      io.event(event)
      if (event.type === 'tool_completed' && event.message.callId === 'unstarted-mcp') {
        const actualIndex = host.session.history.findIndex(message => message.kind === 'tool_result' && message.callId === 'unstarted-mcp')
        const cards = (io as any).entries.filter((entry: any) => entry.tool)
        const presentation = JSON.parse(cards.find((entry: any) => JSON.parse(entry.tool.encoded).callId === 'unstarted-mcp').tool.encoded)
        const sourceIndex = Number(presentation.source.reference.match(/history:(\d+)$/)[1])
        observed = { actualIndex, sourceIndex, text: contents(setup.renderer.root.findDescendantById('vivi-transcript')!) }
      }
    } })
  const dispose = io.onCancel(() => host.cancel())
  try {
    io.setSession(host.session)
    const running = sendChatTurn(host, io, 'Set a note then use the owned fake')
    for (let i = 0; i < 1000 && !pending; i++) { await new Promise(resolve => setTimeout(resolve, 3)); await setup.renderOnce(); await setup.renderOnce() }
    expect(pending).toBe(true); await new Promise(resolve => setTimeout(resolve, 5)); await setup.renderOnce(); await setup.renderOnce()
    setup.mockInput.pressEscape(); const result = await running
    expect(result.status).toBe('cancelled'); expect(sends).toBe(0); expect(observed).toBeDefined()
    expect(observed!.actualIndex).toBe(3)
    expect(observed!.sourceIndex).toBe(observed!.actualIndex)
    expect(host.session.noteRevision).toBe(0)
  } finally { dispose(); io.close(); await host.shutdown(); await manager.close(); await rm(directory, { recursive: true, force: true }) }
})

test('pending exact review cannot displace its current presentation warning/source', async () => {
  const setup = await createTestRenderer({ width: 100, height: 50, kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  try {
    const session = newSession({ provider: 'openai', model: 'offline' }); io.setSession(session); io.runStarted()
    const call = { id: 'large-review', name: 'owned_fixture', arguments: { text: 'ordinary '.repeat(1300) } }
    io.event({ type: 'assistant', message: { kind: 'assistant', content: 'Before review', toolCalls: [call] } })
    const answer = io.approve({ call, description: 'd'.repeat(60 * 1024 - 1), currentRevision: 0 }, new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 5)); await setup.renderOnce(); await setup.renderOnce()
    setup.mockInput.pressKey('o', { ctrl: true }); await setup.renderOnce(); await setup.renderOnce()
    const text = contents(setup.renderer.root.findDescendantById('vivi-transcript')!)
    expect(text).toContain('Approval required. This display grants no permission to execute.')
    expect(text).toContain(`cli-session:${session.id}:history:1`)
    expect(text).toContain('d'.repeat(60 * 1024 - 1))
    setup.mockInput.pressKey('o', { ctrl: true }); await setup.renderOnce(); await setup.renderOnce()
    expect(contents(setup.renderer.root.findDescendantById('vivi-transcript')!)).toContain('approval required')
    setup.mockInput.pressEnter(); expect(await answer).toBe(false)
  } finally { io.close() }
})
for (const length of [60000, 65536]) test(`admitted ${length}-character final response retains text and multiple current tool safety/source rows`, async () => {
  const setup = await createTestRenderer({ width: 100, height: 50, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  try {
    const session = newSession({ provider: 'openai', model: 'offline' })
    const call = { id: 'long-answer', name: 'owned_fixture', arguments: { text: 'a'.repeat(12000) } }
    session.history = [{ kind: 'message', role: 'user', content: 'ordinary' }, { kind: 'assistant', content: 'Before', toolCalls: [call] },
      { kind: 'tool_result', callId: call.id, name: call.name, content: 'ordinary result' },
      { kind: 'assistant', content: 'Another owned call', toolCalls: [{ ...call, id: 'later-card', arguments: {} }] },
      { kind: 'tool_result', callId: 'later-card', name: call.name, content: 'later result', isError: true },
      { kind: 'assistant', content: 'z'.repeat(length), toolCalls: [] }]
    validateSession(session); io.setSession(session); await setup.renderOnce(); await setup.renderOnce()
    const transcript = setup.renderer.root.findDescendantById('vivi-transcript')! as ScrollBoxRenderable
    const headers = nodes(transcript).filter(node => node.id.startsWith('vivi-tool-details-'))
    expect(headers).toHaveLength(2)
    for (const header of headers) {
      const current = setup.renderer.root.findDescendantById(header.id)!
      transcript.scrollTo(transcript.scrollTop + current.y - transcript.viewport.y); await setup.renderOnce(); await setup.renderOnce()
      const target = setup.renderer.root.findDescendantById(header.id)!
      await setup.mockMouse.click(target.x + 1, target.y); await setup.renderOnce(); await setup.renderOnce()
    }
    const text = contents(transcript)
    expect(text).toContain('External effects are unreported. Do not infer that no effects occurred.')
    expect(text).toContain(`cli-session:${session.id}:history:2`)
    expect(text).toContain(`cli-session:${session.id}:history:4`)
    expect(text).toContain('z'.repeat(60000))
    if (length === 65536) expect(text).toContain('[display truncated]')
    setup.mockInput.pressKey('o', { ctrl: true }); await setup.renderOnce(); await setup.renderOnce()
    const collapsed = contents(setup.renderer.root.findDescendantById('vivi-transcript')!)
    expect(collapsed).toContain(`cli-session:${session.id}:history:2`)
    expect(collapsed).not.toContain(`cli-session:${session.id}:history:4`)
    const latest = setup.renderer.root.findDescendantById(headers.at(-1)!.id) as TextRenderable
    expect(latest.plainText).toContain('error/unverified')
    expect(collapsed).toContain('External effects are unreported. Do not infer that no effects occurred.')
  } finally { io.close() }
})

test('full-row clicks independently toggle calls and Ctrl+O only toggles the latest card', async () => {
  const f = await fixture(100, 50)
  for (const [index, name] of ['first_tool', 'second_tool', 'latest_tool'].entries()) {
    f.io.toolPresentation(JSON.stringify({ ...corpus[3], name, callId: `owned-${index}`,
      arguments: { kind: 'text', text: `{"ordinary":"argument-${index}"}` }, result: { kind: 'text', text: `result-${index}` } }))
  }
  await f.frame()
  const [first, second, latest] = f.headers()
  expect(f.headers()).toHaveLength(3)
  for (const header of f.headers()) {
    expect(header.selectable).toBe(false)
    expect(header.width).toBe(header.parent!.width)
    expect(f.body(header).getChildren()).toHaveLength(0)
  }
  expect(first!.plainText.length).toBeLessThan(first!.width - 1)
  await f.clickHeader(first!, true) // The last cell is empty, but belongs to this header.
  expect(contents(f.body(first!))).toContain('result-0')
  expect(f.body(second!).getChildren()).toHaveLength(0)
  expect(f.body(latest!).getChildren()).toHaveLength(0)
  await f.clickHeader(second!)
  expect(contents(f.body(second!))).toContain('result-1')
  expect(contents(f.body(first!))).toContain('result-0')
  f.input.pressKey('o', { ctrl: true }); await f.frame()
  expect(contents(f.body(latest!))).toContain('result-2')
  expect(contents(f.body(second!))).toContain('result-1')
  expect(contents(f.body(first!))).toContain('result-0')
  await f.clickHeader(first!, true)
  expect(f.body(first!).getChildren()).toHaveLength(0)
  expect(contents(f.body(second!))).toContain('result-1')
  expect(contents(f.body(latest!))).toContain('result-2')
  f.input.pressKey('o', { ctrl: true }); await f.frame()
  expect(f.body(latest!).getChildren()).toHaveLength(0)
  expect(contents(f.body(second!))).toContain('result-1')
  expect(f.setup.renderer.getSelection()).toBeNull()
})

test('detail headers reject releases, modified clicks, drag, pointer exit and stale refresh/resize gestures', async () => {
  const f = await fixture(100, 50), session = newSession({ provider: 'openai', model: 'offline' })
  const call = { id: 'exact-card', name: 'owned_fixture', arguments: { text: 'ordinary' } }
  session.history = [{ kind: 'message', role: 'user', content: 'ordinary' },
    { kind: 'assistant', content: '', toolCalls: [call] }, { kind: 'tool_result', callId: call.id, name: call.name, content: 'ordinary result' }]
  f.io.setSession(session); await f.frame()
  const id = f.headers()[0]!.id
  const target = () => f.setup.renderer.root.findDescendantById(id)!
  const remainsCollapsed = async () => { await f.frame(); expect(f.body(target()).getChildren()).toHaveLength(0) }
  let header = await f.reveal(target())
  await f.setup.mockMouse.release(header.x + 1, header.y); await remainsCollapsed()
  for (const button of [1, 2] as const) {
    header = await f.reveal(target()); await f.setup.mockMouse.click(header.x + 1, header.y, button); await remainsCollapsed()
  }
  for (const modifiers of [{ ctrl: true }, { alt: true }, { shift: true }]) {
    header = await f.reveal(target()); await f.setup.mockMouse.click(header.x + 1, header.y, 0, { modifiers }); await remainsCollapsed()
  }
  header = await f.reveal(target()); await f.setup.mockMouse.drag(header.x + 1, header.y, header.x + 2, header.y); await remainsCollapsed()
  header = await f.reveal(target()); await f.setup.mockMouse.pressDown(header.x + 1, header.y)
  await f.setup.mockMouse.moveTo(header.x + 1, header.y + 1)
  await f.setup.mockMouse.release(header.x + 1, header.y); await remainsCollapsed()
  header = await f.reveal(target()); await f.setup.mockMouse.pressDown(header.x + 1, header.y)
  f.io.setSession(session); await f.frame()
  header = await f.reveal(target()); await f.setup.mockMouse.release(header.x + 1, header.y); await remainsCollapsed()
  header = await f.reveal(target()); await f.setup.mockMouse.pressDown(header.x + 1, header.y)
  f.setup.resize(70, 32); await f.frame()
  header = await f.reveal(target()); await f.setup.mockMouse.release(header.x + 1, header.y); await remainsCollapsed()
  for (const sequence of ['\u001b[111;5:2u', '\u001b[111;5:3u']) {
    f.setup.renderer.stdin.emit('data', Buffer.from(sequence)); await remainsCollapsed()
  }
  await f.clickHeader(target(), true)
  expect(contents(f.body(target()))).toContain('ordinary result')
  for (const sequence of ['\u001b[111;5:2u', '\u001b[111;5:3u']) {
    f.setup.renderer.stdin.emit('data', Buffer.from(sequence)); await f.frame()
    expect(contents(f.body(target()))).toContain('ordinary result')
  }
  header = await f.reveal(target()); await f.setup.mockMouse.pressDown(header.x + 1, header.y)
  f.input.pressKey('o', { ctrl: true }); await f.frame()
  header = await f.reveal(target()); await f.setup.mockMouse.release(header.x + 1, header.y); await remainsCollapsed()
  expect(f.setup.renderer.getSelection()).toBeNull()
})

test('mouse wheel over compact headers scrolls the transcript without toggling or stealing the composer', async () => {
  const f = await fixture(80, 24)
  for (let index = 0; index < 50; index++) f.io.toolPresentation(JSON.stringify({ ...corpus[3], name: `owned_${index}`, callId: `call-${index}` }))
  const draft = f.io.readLine('Message'); await f.input.typeText('keep this draft'); await f.frame()
  const scroll = f.transcript() as ScrollBoxRenderable
  scroll.scrollTo(15); await f.frame()
  const visible = f.headers().find(header => header.y >= scroll.viewport.y && header.y < scroll.viewport.y + scroll.viewport.height)!
  expect(visible).toBeDefined()
  const before = scroll.scrollTop
  await f.setup.mockMouse.scroll(visible.x + visible.width - 1, visible.y, 'down'); await f.frame()
  expect(scroll.scrollTop).toBeGreaterThan(before)
  for (const header of f.headers()) expect(f.body(header).getChildren()).toHaveLength(0)
  const composer = f.setup.renderer.root.findDescendantById('vivi-composer') as import('@opentui/core').TextareaRenderable
  expect(composer.focused).toBe(true)
  expect(composer.plainText).toBe('keep this draft')
  const next = f.headers().find(header => header.y >= scroll.viewport.y && header.y < scroll.viewport.y + scroll.viewport.height)!
  const advanced = scroll.scrollTop
  await f.setup.mockMouse.scroll(next.x + 1, next.y, 'up'); await f.frame()
  expect(scroll.scrollTop).toBeLessThan(advanced)
  for (const header of f.headers()) expect(f.body(header).getChildren()).toHaveLength(0)
  f.input.pressEnter(); expect(await draft).toBe('keep this draft')
})

test('long wide-character targets remain a single clipped selectable-false row through resize', async () => {
  const f = await fixture(120, 40)
  f.io.toolPresentation(JSON.stringify({ ...corpus[3], name: 'workspace_read',
    arguments: { kind: 'text', text: JSON.stringify({ path: 'directory/' + '界😀'.repeat(200) + '/file.txt', payload: 'hidden argument' }) } }))
  await f.frame()
  const id = f.headers()[0]!.id
  for (const [width, height] of [[120, 40], [24, 16], [40, 24], [160, 50]]) {
    f.setup.resize(width!, height!); await f.frame()
    const header = f.setup.renderer.root.findDescendantById(id) as TextRenderable
    expect(header.height).toBe(1)
    expect(header.width).toBe(header.parent!.width)
    expect(header.width).toBeLessThanOrEqual(width!)
    expect(header.selectable).toBe(false)
    expect(f.body(header).getChildren()).toHaveLength(0)
    expect(header.plainText).toEndWith('…')
    expect(contents(f.transcript())).not.toContain('Source:')
    expect(contents(f.transcript())).not.toContain('hidden argument')
  }
  await f.clickHeader(f.headers()[0]!, true)
  expect(contents(f.body(f.headers()[0]!))).toContain('hidden argument')
  expect(f.headers()[0]!.height).toBe(1)
})

test('large detail bodies stay bounded, scrollable and independently collapsible', async () => {
  const f = await fixture(60, 24)
  f.io.toolPresentation(JSON.stringify({ ...corpus[8], name: 'large_details', arguments: { kind: 'text', text: 'argument '.repeat(1600) },
    result: { kind: 'text', text: Array.from({ length: 1600 }, (_, index) => `result ${index}`).join('\n') },
    warnings: ['Check the destination before retrying this exact action.'] }))
  f.io.toolPresentation(JSON.stringify({ ...corpus[3], name: 'small_details', result: { kind: 'text', text: 'small result' } }))
  await f.frame()
  const [large, small] = f.headers(), scroll = f.transcript() as ScrollBoxRenderable
  const compactHeight = scroll.scrollHeight
  expect(contents(f.transcript())).toContain('Check the destination before retrying this exact action.')
  expect(contents(f.transcript())).not.toContain('Source:')
  await f.clickHeader(large!, true)
  const body = f.body(large!)
  expect(contents(body)).toContain('Detail display truncated.')
  expect(contents(body)).toContain('Status: unknown')
  expect(contents(body)).toContain('Effect: unknown')
  expect(contents(body)).toContain('Source: "owned://outcomes/call-1"')
  expect(contents(body)).toContain('Warning: Check the destination before retrying this exact action.')
  expect(contents(f.transcript()).match(/Check the destination before retrying this exact action\./g)).toHaveLength(1)
  expect(scroll.scrollHeight).toBeGreaterThan(compactHeight + 50)
  expect(contents(body).length).toBeLessThan(10000)
  expect(f.body(small!).getChildren()).toHaveLength(0)
  scroll.scrollTo(scroll.scrollHeight); await f.frame()
  expect(scroll.scrollTop).toBeGreaterThan(0)
  await f.clickHeader(large!, true)
  expect(f.body(large!).getChildren()).toHaveLength(0)
  expect(scroll.scrollHeight).toBe(compactHeight)
  expect(contents(f.transcript())).toContain('Check the destination before retrying this exact action.')
  expect(contents(f.transcript())).not.toContain('Source:')
  await f.clickHeader(small!, true)
  expect(contents(f.body(small!))).toContain('small result')
  expect(f.body(large!).getChildren()).toHaveLength(0)
})

test('a live local-read expansion survives result and canonical refresh without empty assistant or request chatter', async () => {
  const f = await fixture(100, 40)
  let rounds = 0, finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  const host = await CliHost.create({ store: { async save() {}, async load() { throw new Error('unused') } },
    settings: { provider: 'openai', model: 'offline' }, provider: { async generate() {
      if (++rounds === 1) return { content: '', toolCalls: [{ id: 'same-live-call', name: 'current_time', arguments: {} }] }
      await held; return { content: 'Finished the time check', toolCalls: [] }
    } }, onEvent(event) { f.io.event(event) } })
  cleanups.push(async () => host.shutdown()); f.io.setSession(host.session)
  const running = sendChatTurn(host, f.io, 'Read the clock')
  for (let attempt = 0; attempt < 1000 && rounds < 2; attempt++) await f.frame()
  expect(rounds).toBe(2); await f.frame()
  expect(f.headers()).toHaveLength(1)
  const header = f.headers()[0]!, id = header.id
  expect(header.plainText).toBe('▸ current_time')
  expect(f.body(header).getChildren()).toHaveLength(0)
  expect(contents(f.transcript())).not.toContain('External effects')
  expect(contents(f.transcript())).not.toContain('Tools requested')
  expect(contents(f.transcript())).not.toContain('Assistant')
  f.input.pressKey('o', { ctrl: true }); await f.frame()
  expect(contents(f.body(header))).toContain('Status: unknown')
  expect(contents(f.body(header))).toContain('Effect: unreported')
  finish(); const result = await running
  f.io.result(result); f.io.setSession(host.session); await f.frame()
  expect(f.headers()).toHaveLength(1)
  expect(f.headers()[0]!.id).toBe(id)
  expect(f.headers()[0]!.plainText).toBe('▾ current_time')
  expect(contents(f.body(header))).toContain(`cli-session:${host.session.id}:history:2`)
  expect(contents(f.body(header))).toContain('Result:')
  expect(contents(f.transcript())).toContain('Finished the time check')
  expect(contents(f.transcript()).match(/Assistant/g)).toHaveLength(1)
  f.input.pressKey('o', { ctrl: true }); await f.frame()
  expect(f.headers()[0]!.plainText).toBe('▸ current_time')
  expect(contents(f.transcript())).not.toContain('External effects')
})

test('same-session refresh preserves each expansion but switching sessions and draft reset clear it', async () => {
  const f = await fixture(100, 45), session = newSession({ provider: 'openai', model: 'offline' })
  const call = { id: 'reused', name: 'owned_fixture', arguments: { target: 'first' } }
  session.history = [{ kind: 'message', role: 'user', content: 'first turn' }, { kind: 'assistant', content: '', toolCalls: [call] },
    { kind: 'tool_result', callId: call.id, name: call.name, content: 'first result' },
    { kind: 'message', role: 'user', content: 'second turn' }, { kind: 'assistant', content: '', toolCalls: [{ ...call, arguments: { target: 'second' } }] },
    { kind: 'tool_result', callId: call.id, name: call.name, content: 'second result' }]
  f.io.setSession(session); await f.frame()
  const [first, second] = f.headers()
  expect(first!.id).not.toBe(second!.id)
  await f.clickHeader(first!, true)
  f.io.setSession(structuredClone(session)); await f.frame()
  expect(contents(f.body(first!))).toContain('first result')
  expect(f.body(second!).getChildren()).toHaveLength(0)
  f.input.pressKey('o', { ctrl: true }); await f.frame()
  expect(contents(f.body(second!))).toContain('second result')
  expect(contents(f.body(first!))).toContain('first result')
  f.io.setSession(newSession({ provider: 'openai', model: 'other' })); await f.frame()
  expect(f.headers()).toHaveLength(0)
  f.io.setSession(session); await f.frame()
  for (const header of f.headers()) expect(f.body(header).getChildren()).toHaveLength(0)
  await f.expandAll()
  expect(contents(f.body(first!))).toContain('first result')
  expect(contents(f.body(second!))).toContain('second result')
  f.io.setDraft('openai'); await f.frame()
  expect(f.headers()).toHaveLength(0)
  f.io.setSession(session); await f.frame()
  for (const header of f.headers()) expect(f.body(header).getChildren()).toHaveLength(0)
})

test('interrupted saved orphan calls remain visible unknown cards and reused IDs do not inherit expansions', async () => {
  const f = await fixture(100, 40), session = newSession({ provider: 'openai', model: 'offline' })
  f.io.setSession(session); f.io.runStarted()
  const call = { id: 'orphan', name: 'current_time', arguments: { timezone: 'Etc/UTC' } }
  const assistant = { kind: 'assistant' as const, content: '', toolCalls: [call] }
  f.io.event({ type: 'assistant', message: assistant }); f.io.event({ type: 'tool_started', call }); await f.frame()
  expect(f.headers()[0]!.plainText).toContain('running')
  f.input.pressKey('o', { ctrl: true }); await f.frame()
  const originalId = f.headers()[0]!.id
  f.io.runFinished('cancelled'); await f.frame()
  expect(contents(f.body(f.headers()[0]!))).toContain('Status: unknown')
  session.history = [{ kind: 'message', role: 'user', content: 'interrupted turn' }, assistant]
  f.io.setSession(session); await f.frame()
  expect(f.headers()).toHaveLength(1)
  expect(f.headers()[0]!.id).toBe(originalId)
  expect(f.headers()[0]!.plainText).toContain('unverified')
  expect(contents(f.body(f.headers()[0]!))).toContain('Status: unknown')
  expect(contents(f.body(f.headers()[0]!))).toContain(`cli-session:${session.id}:history:1`)
  expect(contents(f.body(f.headers()[0]!))).toContain('Etc/UTC')
  session.history.push({ kind: 'message', role: 'user', content: 'new interrupted turn' },
    { ...assistant, toolCalls: [{ ...call, arguments: { timezone: 'other-timezone' } }] })
  f.io.setSession(session); await f.frame()
  const [first, second] = f.headers()
  expect(first!.id).toBe(originalId)
  expect(second!.id).not.toBe(first!.id)
  expect(contents(f.body(first!))).toContain('Etc/UTC')
  expect(f.body(second!).getChildren()).toHaveLength(0)
  expect(second!.plainText).toContain('unverified')
  expect(contents(f.transcript())).not.toContain('Tools requested')
  expect(contents(f.transcript())).not.toContain('Assistant')
  f.input.pressKey('o', { ctrl: true }); await f.frame()
  expect(contents(f.body(second!))).toContain('other-timezone')
  expect(contents(f.body(first!))).toContain('Etc/UTC')
})

for (const [status, effect, visible] of [
  ['approval_required', 'not_attempted', 'approval required'], ['denied', 'not_attempted', 'denied'],
  ['failed', 'unreported', 'failed/unverified'], ['cancelled', 'unreported', 'cancelled/unknown'],
  ['unknown', 'unreported', 'unverified'], ['succeeded', 'unreported', 'unverified'],
  ['unknown', 'unknown', 'effects unknown'], ['failed', 'unknown', 'failed/unknown'], ['cancelled', 'unknown', 'cancelled/unknown'],
] as const) test(`24-column collapsed ${status}/${effect} retains visible safety uncertainty`, async () => {
  const f = await fixture(24, 16)
  f.io.toolPresentation(JSON.stringify({ ...corpus[3], name: 'long_foreign_operation_name', status, effect })); await f.frame()
  const header = await f.reveal(f.headers()[0]!)
  expect(header.height).toBe(1)
  expect(f.body(header).getChildren()).toHaveLength(0)
  const row = (await f.frame()).split('\n')[header.y]!
  expect(row).toContain(visible)
  expect(contents(f.transcript())).not.toContain('Source:')
})

test('24-column generic error result remains visibly unverified when its detail body is collapsed', async () => {
  const f = await fixture(24, 16), session = newSession({ provider: 'openai', model: 'offline' })
  const call = { id: 'generic-error', name: 'long_external_tool', arguments: {} }
  session.history = [{ kind: 'message', role: 'user', content: 'run' }, { kind: 'assistant', content: '', toolCalls: [call] },
    { kind: 'tool_result', callId: call.id, name: call.name, content: 'untrusted error result', isError: true }]
  f.io.setSession(session); await f.frame()
  const header = await f.reveal(f.headers()[0]!)
  expect((await f.frame()).split('\n')[header.y]).toContain('error/unverified')
  expect(f.body(header).getChildren()).toHaveLength(0)
})

test('24-column malformed presentations retain a visible invalid warning and unverified outcome', async () => {
  const f = await fixture(24, 16)
  f.io.toolPresentation('{'); await f.frame()
  const header = await f.reveal(f.headers()[0]!)
  expect((await f.frame()).split('\n')[header.y]).toContain('unverified')
  expect(contents(f.transcript())).toContain('Invalid or oversized tool presentation')
  expect(f.body(header).getChildren()).toHaveLength(0)
})
