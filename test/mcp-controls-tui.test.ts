// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BoxRenderable, CliRenderEvents, SelectRenderable, TextareaRenderable, TextRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import type { Transport } from '@modelcontextprotocol/client'
import { OpenTuiIO, getSlashCommandCompletions } from '../src/tui.js'
import { McpConfigStore } from '../src/mcp-config.js'
import { McpManager } from '../src/mcp-manager.js'
import { manageMcp } from '../src/mcp-controls.js'

const fixtures: { io: OpenTuiIO; manager: McpManager; directory: string; releaseCleanup(): void }[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.releaseCleanup(); f.io.close(); await f.manager.close(); await rm(f.directory, { recursive: true, force: true })
  }
})
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 3))
function contents(node: Renderable): string {
  return [node instanceof TextRenderable || node instanceof TextareaRenderable ? node.plainText : '',
    node instanceof BoxRenderable ? `${node.title ?? ''}` : '',
    node instanceof SelectRenderable ? JSON.stringify(node.options) : '', ...node.getChildren().map(contents)].join('\n')
}
type Phase = { kind: 'choice'; title: string; choices: readonly { name: string; value: unknown }[] }
  | { kind: 'text'; title: string } | { kind: 'approval' }
async function fixture(configured = false) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-native-mcp-'))
  const setup = await createTestRenderer({ width: 120, height: 40, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer), store = new McpConfigStore(directory)
  let starts = 0, closes = 0, cleanupBlocked = false
  const methods: string[] = []
  const manager = new McpManager({ store, env: {}, transportFactory: () => {
    starts++
    // An in-memory protocol peer. It cannot launch code, access a provider,
    // read a resource, invoke a tool, or touch any third-party service.
    const transport: Transport = { start: async () => {}, close: async () => {
      closes++
      if (cleanupBlocked) throw new Error('Private transport error must stay out of the UI ' + 'x'.repeat(5000))
      transport.onclose?.()
    },
      send: async message => {
        if (!('method' in message)) return
        methods.push(message.method)
        if (!('id' in message)) return
        const result = message.method === 'initialize'
          ? { resultType: 'complete', protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'Offline peer', version: '1' }, instructions: 'Do not project metadata into a model' }
          : message.method === 'tools/list' ? { resultType: 'complete', tools: [{ name: 'exact/name', inputSchema: { type: 'object' } }] }
          : message.method === 'resources/list' ? { resultType: 'complete', resources: [{ name: 'Offline metadata', uri: 'fixture:///never-read' }] }
          : { resultType: 'complete', resourceTemplates: [{ name: 'Offline template', uriTemplate: 'fixture:///{name}' }] }
        const id = message.id
        queueMicrotask(() => transport.onmessage?.({ jsonrpc: '2.0', id, result }))
      } }
    return transport
  } })
  fixtures.push({ io, manager, directory, releaseCleanup: () => { cleanupBlocked = false } })
  if (configured) await manager.configure({ id: 'docs', label: 'Trusted offline peer', executable: process.execPath,
    args: [], cwd: directory, protocol: 'legacy', environment: [] })
  const phases: Phase[] = []
  let waiting: ((phase: Phase) => void) | undefined
  const announce = (phase: Phase) => { if (waiting) { const accept = waiting; waiting = undefined; accept(phase) } else phases.push(phase) }
  const next = () => phases.length ? Promise.resolve(phases.shift()!) : new Promise<Phase>(resolve => { waiting = resolve })
  const originalChoose = io.choose.bind(io), originalText = io.askText.bind(io), originalApproval = io.approve.bind(io)
  io.choose = (title, choices, initialIndex) => {
    const result = originalChoose(title, choices, initialIndex); announce({ kind: 'choice', title, choices }); return result
  }
  io.askText = (title, initial) => { const result = originalText(title, initial); announce({ kind: 'text', title }); return result }
  io.approve = (request, signal) => { const result = originalApproval(request, signal); announce({ kind: 'approval' }); return result }
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const choice = async (value: unknown, mouse = false) => {
    const phase = await next(); expect(phase.kind).toBe('choice')
    if (phase.kind !== 'choice') throw new Error('Expected native choice')
    const index = phase.choices.findIndex(option => option.value === value ||
      value !== null && typeof value === 'object' && JSON.stringify(option.value) === JSON.stringify(value))
    expect(index).toBeGreaterThanOrEqual(0)
    await frame()
    const picker = setup.renderer.root.findDescendantById('vivi-picker') as SelectRenderable
    expect(picker.getSelectedIndex()).toBe(0)
    for (let offset = 0; offset < index; offset++) setup.mockInput.pressArrow('down')
    await frame()
    if (mouse) {
      const button = setup.renderer.root.findDescendantById('vivi-confirm')!
      await setup.mockMouse.click(button.x + 1, button.y)
    } else setup.mockInput.pressEnter()
  }
  const text = async (value: string) => {
    const phase = await next(); expect(phase.kind).toBe('text')
    await frame(); setup.mockInput.pressKey('u', { ctrl: true }); await setup.mockInput.typeText(value); setup.mockInput.pressEnter()
  }
  return { io, manager, store, setup, frame, next, choice, text, input: setup.mockInput,
    starts: () => starts, closes: () => closes, methods,
    blockCleanup: () => { cleanupBlocked = true }, allowCleanup: () => { cleanupBlocked = false } }
}

test('MCP completion returns only the human-authored slash command', async () => {
  const f = await fixture()
  expect(getSlashCommandCompletions('/mc').map(value => value.command)).toEqual(['/mcp'])
  const reading = f.io.readLine('Message')
  await f.input.typeText('/mc'); await f.frame(); f.input.pressTab(); f.input.pressEnter()
  expect(await reading).toBe('/mcp'); expect(f.starts()).toBe(0)
})

test('native MCP picker and text input work while manager cancellation is registered', async () => {
  const f = await fixture(), running = manageMcp(f.manager, f.io, f.store.directory)
  await f.choice('add', true)
  await f.text('docs'); await f.text('Offline peer'); await f.text(process.execPath)
  await f.text(f.store.directory); await f.text('0')
  await f.choice('legacy'); await f.choice([]); await f.choice(true); await f.choice('back')
  await running
  expect((await f.store.load()).servers.map(server => server.id)).toEqual(['docs'])
  expect(f.manager.statuses()[0]?.state).toBe('disabled'); expect(f.starts()).toBe(0)
  expect((f.setup.renderer.root.findDescendantById('vivi-status') as TextRenderable).plainText).toBe('Ready')
}, 10000)

for (const kind of ['picker', 'text'] as const) {
  for (const cancel of ['escape', 'ctrl-c', 'close'] as const) test(`${cancel} settles the MCP ${kind} without saving or spawning`, async () => {
    const f = await fixture(), running = manageMcp(f.manager, f.io, f.store.directory)
    if (kind === 'text') await f.choice('add')
    const phase = await f.next(); expect(phase.kind).toBe(kind === 'picker' ? 'choice' : 'text')
    await f.frame()
    if (cancel === 'escape') f.input.pressEscape()
    else if (cancel === 'ctrl-c') f.input.pressCtrlC()
    else f.io.close()
    if (cancel === 'escape' && kind === 'text') await f.choice('back')
    await running
    expect((await f.store.load()).servers).toEqual([]); expect(f.starts()).toBe(0)
    expect(f.setup.renderer.root.findDescendantById('vivi-picker')).toBeUndefined()
    if (cancel !== 'close') {
      expect(f.io.isClosed).toBe(false)
      expect((f.setup.renderer.root.findDescendantById('vivi-status') as TextRenderable).plainText).toBe('Ready')
      const reading = f.io.readLine('Message'); await f.input.typeText('Fresh ordinary draft'); f.input.pressEnter()
      expect(await reading).toBe('Fresh ordinary draft')
    }
  })
}

for (const cancel of ['deny', 'escape', 'ctrl-c', 'close', 'failure'] as const) test(`native MCP startup ${cancel} never starts its peer`, async () => {
  const f = await fixture(true), running = manageMcp(f.manager, f.io)
  const stopped = running.catch((error: Error) => error.message)
  await f.choice('server:docs'); await f.choice('connect')
  expect((await f.next()).kind).toBe('approval')
  await tick(); await f.frame()
  expect(await f.frame()).toContain('› Deny')
  expect(contents(f.setup.renderer.root)).toContain('runs its installed code with your OS permissions')
  expect(f.starts()).toBe(0)
  if (cancel === 'deny') {
    await f.input.pasteBracketedText('allow'); await f.frame(); f.input.pressEnter()
  } else if (cancel === 'escape') f.input.pressEscape()
  else if (cancel === 'ctrl-c') f.input.pressCtrlC()
  else if (cancel === 'close') f.io.close()
  else f.setup.renderer.emit(CliRenderEvents.RENDER_ERROR, { error: new Error('Synthetic MCP renderer failure') })
  if (cancel === 'deny') await f.choice('back')
  const failure = await stopped
  if (cancel === 'failure') expect(failure).toContain('Synthetic MCP renderer failure')
  else expect(failure).toBeUndefined()
  expect(f.starts()).toBe(0); expect(f.manager.statuses()[0]?.state).toBe('disabled')
})

test('fresh native human approval connects metadata only, and disable closes the owned peer', async () => {
  const f = await fixture(true), running = manageMcp(f.manager, f.io)
  await f.choice('server:docs'); await f.choice('connect')
  expect((await f.next()).kind).toBe('approval')
  // Queued and repeat gestures cannot authorize the just-opened request.
  f.input.pressArrow('right'); f.input.pressEnter()
  f.setup.renderer.keyInput.emit('keypress', { name: 'return', sequence: '\r', repeated: true, eventType: 'repeat',
    ctrl: false, meta: false, shift: false, super: false, hyper: false, preventDefault() {}, stopPropagation() {} })
  expect(f.starts()).toBe(0)
  await tick(); await f.frame(); f.input.pressArrow('right'); await f.frame(); f.input.pressEnter()
  await f.choice('server:docs'); await f.choice('tools')
  const browsing = await f.next(); expect(browsing.kind).toBe('choice')
  expect(contents(f.setup.renderer.root)).toContain('exact/name')
  await f.frame(); f.input.pressArrow('down'); f.input.pressEnter()
  await f.choice('server:docs'); await f.choice('resources')
  const resources = await f.next(); expect(resources.kind).toBe('choice')
  await f.frame(); f.input.pressArrow('down'); f.input.pressEnter()
  await f.choice('server:docs'); await f.choice('disable'); await f.choice('back')
  await running
  expect(f.starts()).toBe(1); expect(f.closes()).toBe(1)
  expect(f.manager.statuses()[0]?.state).toBe('disabled')
  expect(f.methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'resources/templates/list'])
  expect(contents(f.setup.renderer.root)).toContain('execution and resource content retrieval are unavailable')
})

test('manager modal permissions do not permit active chat keys, paste, mouse actions or direct composer submit', async () => {
  const f = await fixture()
  const controller = new AbortController(), dispose = f.io.onCancel(() => controller.abort())
  const reading = f.io.readLine('Active chat', controller.signal)
  const stopped = reading.catch((error: Error) => error.message)
  let submitted = false; void reading.then(() => { submitted = true }, () => {})
  await f.input.typeText('/mcp'); await f.input.pasteBracketedText('/mcp')
  f.input.pressKey('p', { ctrl: true }); f.input.pressEnter(); await f.frame()
  expect(submitted).toBe(false)
  const composer = f.setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  expect(composer.plainText).toBe('')
  const action = f.setup.renderer.root.findDescendantById('vivi-action-menu')!
  await f.setup.mockMouse.click(action.x + 1, action.y)
  expect(submitted).toBe(false)
  composer.setText('/mcp'); composer.submit()
  await Promise.resolve(); expect(submitted).toBe(false)
  f.input.pressCtrlC(); expect(await stopped).toBe('Input cancelled'); dispose()
})

test('native unavailable-config UI retains failed cleanup ownership and permits only explicit disconnect retries', async () => {
  const f = await fixture(true)
  expect(await f.manager.connect('docs', async () => true, new AbortController().signal)).toBe(true)
  expect(f.manager.statuses()[0]?.snapshot).toBeDefined()
  const file = join(f.store.directory, 'mcp-servers.json'), invalid = '{owned-invalid-configuration'
  await writeFile(file, invalid, { mode: 0o600 }); f.blockCleanup()
  let reads = 0
  const load = f.store.load.bind(f.store)
  f.store.load = async () => { reads++; return load() }
  f.store.save = async () => { throw new Error('Cleanup must not write saved configuration') }
  const running = manageMcp(f.manager, f.io), stopped = running.catch((error: Error) => error.message)
  for (const attempt of [1, 2]) {
    const phase = await f.next(); expect(phase.kind).toBe('choice')
    if (phase.kind !== 'choice') throw new Error('Expected cleanup-only native choice')
    expect(phase.title).toContain('saved configuration unavailable')
    expect(phase.choices.map(choice => choice.value)).toEqual(['back', 'cleanup:docs'])
    expect(f.manager.statuses()[0]?.state).toBe('error'); expect(f.manager.statuses()[0]?.snapshot).toBeUndefined()
    expect(f.closes()).toBe(attempt); expect(f.starts()).toBe(1); expect(reads).toBe(1)
    const display = contents(f.setup.renderer.root)
    expect(display).toContain('owned connection retained'); expect(display).not.toContain('exact/name')
    expect(display).not.toContain('Private transport error'); expect(display).not.toContain('Enable and connect')
    expect(display).not.toContain('Add trusted installed server')
    await f.frame()
    if (attempt === 2) f.allowCleanup()
    f.input.pressArrow('down'); await f.frame(); f.input.pressEnter()
  }
  expect(await stopped).toContain('saved configuration remains unavailable or invalid')
  expect(f.manager.statuses()[0]?.state).toBe('disabled'); expect(f.manager.statuses()[0]?.snapshot).toBeUndefined()
  expect(f.closes()).toBe(3); expect(reads).toBe(1); expect(f.starts()).toBe(1)
  expect(contents(f.setup.renderer.root)).toContain('disabled for this launch; owned connection cleanup completed')
  expect(f.methods).toEqual(['initialize', 'notifications/initialized', 'tools/list'])
  expect(await readFile(file, 'utf8')).toBe(invalid)
})

test('native Back from unavailable configuration reports unresolved cleanup without dropping the retained peer', async () => {
  const f = await fixture(true)
  expect(await f.manager.connect('docs', async () => true, new AbortController().signal)).toBe(true)
  await writeFile(join(f.store.directory, 'mcp-servers.json'), '{owned-invalid-configuration', { mode: 0o600 })
  f.blockCleanup()
  const running = manageMcp(f.manager, f.io), stopped = running.catch((error: Error) => error.message)
  const phase = await f.next(); expect(phase.kind).toBe('choice')
  if (phase.kind !== 'choice') throw new Error('Expected cleanup-only native choice')
  expect(phase.choices.map(choice => choice.value)).toEqual(['back', 'cleanup:docs'])
  await f.frame(); f.input.pressEscape()
  expect(await stopped).toContain('owned process cleanup remains unverified')
  expect(f.manager.statuses()[0]?.state).toBe('error'); expect(f.manager.statuses()[0]?.snapshot).toBeUndefined()
  expect(f.closes()).toBe(1); expect(f.starts()).toBe(1)
  expect(contents(f.setup.renderer.root)).not.toContain('disabled for this launch')
})
