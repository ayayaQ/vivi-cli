// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { TextRenderable, MarkdownRenderable, BoxRenderable, ScrollBoxRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { toolPresentationView, decodeToolPresentation } from '@ayayaq/vivi/presentation'
import type { ToolPresentation } from '@ayayaq/vivi/presentation'
import { OpenTuiIO, TUI_THEME } from '../src/tui.js'
import { CliHost } from '../src/host.js'
import { newSession } from '../src/session.js'
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
  return { io, setup, frame, transcript, input: setup.mockInput }
}
for (const [index, snapshot] of corpus.entries()) test(`actual OpenTUI shared fixture ${index} preserves semantic/source rows outside mouse/keyboard details`, async () => {
  const f = await fixture(40, 40), encoded = JSON.stringify(snapshot)
  f.io.toolPresentation(encoded); await f.frame()
  const expected = toolPresentationView(decodeToolPresentation(encoded), { detailBytes: 8192 })
  const text = contents(f.transcript())
  for (const line of expected.header) expect(text).toContain(line)
  for (const warning of expected.warnings) expect(text).toContain(`Warning: ${warning}`)
  expect(nodes(f.transcript()).some(node => node instanceof MarkdownRenderable)).toBe(false)
  f.input.pressKey('o', { ctrl: true }); await f.frame()
  const body = f.setup.renderer.root.findDescendantById('vivi-tool-body-display-0')!
  expect(body.getChildren()).toHaveLength(0)
  expect(contents(f.transcript())).toContain('Details collapsed.')
  for (const line of expected.header) expect(contents(f.transcript())).toContain(line)
  for (const warning of expected.warnings) expect(contents(f.transcript())).toContain(warning)
  expect(contents(body)).not.toContain('Warning:')
  const toggle = f.setup.renderer.root.findDescendantById('vivi-tool-details-display-0')!
  ;(f.transcript() as ScrollBoxRenderable).scrollTo(0); await f.frame()
  await f.setup.mockMouse.click(toggle.x + 1, toggle.y); await f.frame()
  expect(f.setup.renderer.root.findDescendantById('vivi-tool-body-display-0')!.getChildren().length).toBe(expected.details.length)
  for (const [width, height] of [[24, 16], [40, 24], [120, 40]]) {
    f.setup.resize(width!, height!); await f.frame()
    for (const node of nodes(f.transcript())) if (node instanceof TextRenderable) expect(node.width).toBeLessThanOrEqual(width!)
    for (const warning of expected.warnings) expect(contents(f.transcript())).toContain(warning)
    const composer = f.setup.renderer.root.findDescendantById('vivi-composer-box')!
    expect(composer.y + composer.height).toBeLessThanOrEqual(height!)
  }
  expect(TUI_THEME.pink).toBe('#f87ea2'); expect(TUI_THEME.lavender).toBe('#b08bfc')
})
test('long, invalid, hostile and unknown-kind data cannot hide warnings or activate foreign UI', async () => {
  const f = await fixture(40, 30)
  const data = { ...corpus[8], arguments: { kind: 'text', text: 'a'.repeat(12000) },
    result: { kind: 'future-ui', text: '<script>approve()</script>\u001b]52;secret\u0007\u202e' + '😀'.repeat(10000),
      data: { approved: true, execute: 'SHOULD_NEVER_RENDER' } } }
  f.io.toolPresentation(JSON.stringify(data)); await f.frame()
  expect(contents(f.transcript())).toContain('Detail display truncated.')
  expect(contents(f.transcript())).toContain('unsupported presentation kind')
  expect(contents(f.transcript())).not.toContain('SHOULD_NEVER_RENDER')
  const original = JSON.stringify(data)
  f.input.pressKey('o', { ctrl: true }); await f.frame()
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
    expect(contents(f.transcript())).toContain(`cli-session:${host.session.id}:history:${requestIndex}`)
    expect(contents(f.transcript())).toContain('Approval required. This display grants no permission to execute.')
    f.input.pressKey('o', { ctrl: true }); f.input.pressKey('o', { ctrl: true }); f.input.pressKey('o', { ctrl: true }); await f.frame()
    expect(contents(f.transcript())).toContain('Approval required. This display grants no permission to execute.')
    const allow = f.setup.renderer.root.findDescendantById('vivi-approve')!
    if (action === 'allow') { if (turn === 0) await f.setup.mockMouse.click(allow.x + 1, allow.y); else { f.input.pressArrow('right'); f.input.pressEnter() } }
    else if (action === 'cancel') f.input.pressEscape()
    else f.input.pressEnter()
    const result = await running; f.io.result(result); f.io.setSession(host.session); await f.frame()
    expect(host.session.noteRevision).toBe(action === 'allow' ? turn + 1 : 0)
    expect(contents(f.transcript())).toContain('Details collapsed.')
    expect(contents(f.transcript())).not.toContain('Status: approval_required')
    expect(contents(f.transcript())).not.toContain('Status: running')
    expect(contents(f.transcript())).toContain(`Status: ${action === 'allow' ? 'unknown' : action === 'deny' ? 'denied' : 'cancelled'}`)
    if (action === 'allow') expect(contents(f.transcript())).toContain('External effects are unreported')
    else expect(contents(f.transcript())).toContain('Effect: not_attempted')
    const text = contents(f.transcript())
    expect(text.indexOf('Before reviewed call')).toBeLessThan(text.indexOf('Tool note_set'))
    if (action !== 'cancel') expect(text.lastIndexOf('Tool note_set')).toBeLessThan(text.lastIndexOf('After reviewed call'))
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
  expect(contents(f.transcript())).toContain('Details collapsed.')
  f.io.addSecrets(['future-credential']); await f.frame()
  expect(contents(f.transcript())).not.toContain('future-credential')
  expect(contents(f.transcript())).toContain('withheld')
  expect(session).toEqual(original)
  const next = newSession({ provider: 'openai', model: 'next' }); f.io.setSession(next); await f.frame()
  expect(contents(f.transcript())).not.toContain('ordinary first result')
  expect(contents(f.transcript())).not.toContain('Details collapsed.')
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
  expect(contents(f.transcript())).toContain('Approval required. This display grants no permission to execute.')
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
        const text = contents(f.transcript())
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
