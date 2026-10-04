// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { CliRenderEvents, CodeRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import type { TestRendererSetup } from '@opentui/core/testing'
import type { AgentResult, HistoryMessage } from '@ayayaq/vivi'
import { OpenTuiIO } from '../src/tui.js'
import { newSession } from '../src/session.js'

const fixtures: { io: OpenTuiIO; setup: TestRendererSetup }[] = []
afterEach(async () => {
  for (const { io } of fixtures.splice(0)) io.close()
  await Promise.resolve()
})
async function fixture(options: { stream?: boolean; secrets?: readonly string[]; width?: number; height?: number } = {}) {
  const setup = await createTestRenderer({ width: options.width ?? 100, height: options.height ?? 30,
    kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer, options)
  fixtures.push({ io, setup })
  const frame = async (): Promise<string> => {
    await setup.renderOnce()
    await setup.renderOnce()
    return setup.captureCharFrame()
  }
  return { io, setup, frame, input: setup.mockInput }
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2))
const history = (content: string): HistoryMessage[] => [
  { kind: 'message', role: 'user', content: 'Hello' },
  { kind: 'assistant', content, toolCalls: [] }
]
const result = (content: string, status: AgentResult['status'] = 'completed'): AgentResult => ({
  status, content, history: status === 'completed' ? history(content) : [{ kind: 'message', role: 'user', content: 'Hello' }],
  rounds: 1, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
})
const request = { call: { id: 'note-1', name: 'note_set', arguments: { key: 'topic', value: 'test', expectedRevision: 4 } },
  description: 'Set session note topic to test', currentRevision: 4 }

test('renders session header, canonical roles, tools, usage and command hints', async () => {
  const { io, frame } = await fixture()
  const session = newSession({ provider: 'openai', model: 'mock-model', reasoning: 'high' })
  session.history = [...history('## A heading\n\nA **bold** response'),
    { kind: 'tool_result', callId: 'tool-1', name: 'calculate', content: '{"result":2}' }]
  session.usage = { inputTokens: 9, outputTokens: 8, totalTokens: 17 }
  io.setSession(session)
  const output = await frame()
  expect(output).toContain('openai / mock-model')
  expect(output).toContain(session.id)
  expect(output).toContain('reasoning high')
  expect(output).toContain('You')
  expect(output).toContain('Assistant')
  expect(output).toContain('A heading')
  expect(output).toContain('Tool calculate')
  expect(output).toContain('9 in / 8 out / 17 total')
  expect(output).toContain('/new /resume /settings /menu /help /exit')
})

test('Enter submits; Shift and Alt Enter compose multiline with preserved draft', async () => {
  const { io, input, frame } = await fixture()
  const line = io.readLine('Message')
  await input.typeText('first')
  input.pressEnter({ shift: true })
  await input.typeText('second')
  input.pressEnter({ meta: true })
  await input.typeText('third')
  expect(await frame()).toContain('third')
  input.pressEnter()
  expect(await line).toBe('first\nsecond\nthird')
  const next = io.readLine('Message')
  input.pressEnter()
  expect(await next).toBe('')
})

test('pickers dismiss with Escape and work repeatedly with typed values intact', async () => {
  const { io, input, frame } = await fixture()
  const options = [{ name: 'One', description: 'First option', value: { id: 1 } },
    { name: 'Two', description: 'Second option', value: { id: 2 } }]
  const first = io.choose('Choose model', options)
  expect(await frame()).toContain('Choose model')
  input.pressEscape()
  expect(await first).toBeUndefined()
  const second = io.choose('Choose again', options)
  input.pressArrow('down')
  input.pressEnter()
  expect(await second).toEqual({ id: 2 })
  const third = io.choose('Initial selection', options, 1)
  input.pressEnter()
  expect(await third).toEqual({ id: 2 })
  expect(await io.choose('Empty', [])).toBeUndefined()
  expect(await frame()).not.toContain('Initial selection')
})

test('askText starts with its initial value and dismisses without stale input', async () => {
  const { io, input } = await fixture()
  const first = io.askText('Model identifier', 'mock-model')
  await input.typeText('-v2')
  input.pressEnter()
  expect(await first).toBe('mock-model-v2')
  const second = io.askText('Reasoning', 'high')
  input.pressEscape()
  expect(await second).toBeUndefined()
  const line = io.readLine('Message')
  await input.typeText('fresh')
  input.pressEnter()
  expect(await line).toBe('fresh')
})

test('idle shortcuts issue commands only for an empty composer', async () => {
  const { io, input } = await fixture()
  for (const [key, command] of [['n', '/new'], ['r', '/resume'], ['p', '/menu']]) {
    const line = io.readLine('Message')
    input.pressKey(key!, { ctrl: true })
    expect(await line).toBe(command!)
  }
  const line = io.readLine('Message')
  await input.typeText('draft')
  input.pressKey('n', { ctrl: true })
  input.pressEnter()
  expect(await line).toBe('draft')
})

test('running turn blocks queued typing and commands; Escape and Ctrl+C cancel', async () => {
  const { io, input, frame } = await fixture()
  let cancelled = 0
  const dispose = io.onCancel(() => cancelled++)
  await input.typeText('queued message')
  input.pressKey('n', { ctrl: true })
  input.pressEnter()
  input.pressEscape()
  input.pressCtrlC()
  expect(cancelled).toBe(2)
  expect(await frame()).not.toContain('queued message')
  dispose()
  const line = io.readLine('Message')
  input.pressEnter()
  expect(await line).toBe('')
})

test('approval clears pretyped input and queued Return, requires fresh typed allow', async () => {
  const { io, input, frame } = await fixture()
  const draft = io.askText('An earlier input')
  await input.typeText('allow')
  const approval = io.approve(request, new AbortController().signal)
  input.pressEnter()
  await input.typeText('allow') // This batch predates arming and must be discarded.
  input.pressEnter()
  expect(await draft).toBeUndefined()
  await tick()
  const display = await frame()
  expect(display).toContain('current revision 4')
  expect(display).toContain(request.description)
  expect(display).toContain('default: deny')
  let settled = false
  void approval.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  await input.typeText('allow')
  input.pressEnter()
  expect(await approval).toBe(true)
})

test('pasted approval cannot allow; blank, deny, abort, dismissal and close deny', async () => {
  const { io, input } = await fixture()
  const pasted = io.approve(request, new AbortController().signal)
  await tick()
  await input.pasteBracketedText('allow\n')
  input.pressEnter()
  expect(await pasted).toBe(false)
  const denied = io.approve(request, new AbortController().signal)
  await tick()
  await input.typeText('deny')
  input.pressEnter()
  expect(await denied).toBe(false)
  const abortedController = new AbortController()
  const aborted = io.approve(request, abortedController.signal)
  abortedController.abort()
  expect(await aborted).toBe(false)
  const dismissed = io.approve(request, new AbortController().signal)
  input.pressEscape()
  expect(await dismissed).toBe(false)
  const closed = io.approve(request, new AbortController().signal)
  io.close()
  expect(await closed).toBe(false)
})

test('invalid approval text cannot carry forward into a later approval', async () => {
  const { io, input } = await fixture()
  const first = io.approve(request, new AbortController().signal)
  await tick()
  await input.typeText('allowed')
  input.pressEnter()
  input.pressEnter()
  expect(await first).toBe(false)
  await input.typeText('allow')
  input.pressEnter() // No pending input, so this cannot grant a future request.
  const second = io.approve(request, new AbortController().signal)
  await tick()
  input.pressEnter()
  expect(await second).toBe(false)
})

test('split streamed secrets never enter a captured frame, accepted response replaces preview', async () => {
  const secret = 'sk-test-super-secret'
  const { io, frame } = await fixture({ secrets: [secret] })
  for (const text of ['A response: sk-', 'test-super-', 'secret and ', '**more text** '.repeat(3)]) {
    io.event({ type: 'text_delta', text })
    const display = await frame()
    expect(display).not.toContain(secret)
    expect(display).not.toContain('sk-test')
  }
  expect(await frame()).toContain('[REDACTED]')
  expect(await frame()).toContain('streaming preview (not accepted)')
  io.event({ type: 'assistant', message: { kind: 'assistant', content: 'Different accepted answer', toolCalls: [] } })
  expect(await frame()).toContain('Different accepted answer')
  expect(await frame()).not.toContain('streaming preview')
  expect(await frame()).not.toContain('A response:')
  io.result(result('Different accepted answer'))
  expect(await frame()).toContain('Completed')
})

test('aborted partial display remains clearly separate after canonical session refresh', async () => {
  const { io, frame } = await fixture({ secrets: ['credential-tail'] })
  io.event({ type: 'text_delta', text: 'unfinished **answer** credential-' })
  io.result(result('', 'cancelled'))
  const session = newSession({ provider: 'openai', model: 'mock-model' })
  session.history = [{ kind: 'message', role: 'user', content: 'Hello' }]
  io.setSession(session)
  const display = await frame()
  expect(display).toContain('Partial display only')
  expect(display).toContain('response was not accepted')
  expect(display).toContain('Cancelled')
  expect(display).not.toContain('credential-')
  expect(session.history).toHaveLength(1)
})

test('display overflow is bounded and canonical completion reconciles it', async () => {
  const { io, frame } = await fixture()
  io.event({ type: 'text_delta', text: 'x'.repeat(70000) })
  expect(await frame()).toContain('display truncated')
  io.result(result('Final accepted response'))
  expect(await frame()).toContain('Final accepted response')
  expect(await frame()).not.toContain('display truncated')
})

test('secrets and terminal commands are stripped from every display surface', async () => {
  const { io, input, frame } = await fixture({ secrets: ['known-secret'] })
  const session = newSession({ provider: 'openai', model: 'known-secret' })
  session.history = history('\x1b[31mred\x1b[0m known-secret\x1b]52;c;clipboard\x07')
  io.setSession(session)
  io.write('\x1b[2Jmessage known-secret')
  io.event({ type: 'tool_started', call: { id: '1', name: 'known-secret', arguments: {} } })
  io.event({ type: 'tool_completed', message: { kind: 'tool_result', callId: '1', name: 'test', content: 'known-secret' } })
  const line = io.readLine('known-secret')
  await input.pasteBracketedText('hello known-secret\x1b[31m world\x1b[0m')
  const display = await frame()
  expect(display).not.toContain('known-secret')
  expect(display).not.toContain('[31m')
  expect(display).not.toContain('clipboard')
  expect(display).toContain('[REDACTED]')
  input.pressEnter()
  expect(await line).toBe('hello [REDACTED] world')
})

test('split terminal escape commands are never displayed as command fragments', async () => {
  const { io, frame } = await fixture()
  io.event({ type: 'text_delta', text: 'visible\x1b[3' })
  expect(await frame()).not.toContain('[3')
  io.event({ type: 'text_delta', text: '1m red\x1b]52;c;payload' })
  expect(await frame()).not.toContain('payload')
  io.event({ type: 'text_delta', text: '\x07 done' })
  const display = await frame()
  expect(display).toContain('visible red done')
  expect(display).not.toContain('52;c;')
})

test('PageUp/Down and Ctrl+Shift arrows scroll transcript without editing composer', async () => {
  const { io, setup, input, frame } = await fixture({ height: 20 })
  const session = newSession({ provider: 'openai', model: 'mock-model' })
  session.history = Array.from({ length: 40 }, (_, index) => ({ kind: 'message' as const, role: 'user' as const, content: `Transcript line ${index}` }))
  io.setSession(session)
  const line = io.readLine('Message')
  await input.typeText('unchanged draft')
  await frame()
  const transcript = setup.renderer.root.findDescendantById('vivi-transcript') as { scrollTop?: number } | undefined
  const before = transcript?.scrollTop ?? 0
  input.pressKey('\x1b[5~')
  await frame()
  expect(transcript?.scrollTop).toBeLessThan(before)
  input.pressKey('\x1b[6~')
  input.pressArrow('up', { ctrl: true, shift: true })
  input.pressArrow('down', { ctrl: true, shift: true })
  input.pressEnter()
  expect(await line).toBe('unchanged draft')
})

test('input size is bounded and input abort clears the composer', async () => {
  const { io, input } = await fixture()
  const controller = new AbortController()
  const line = io.readLine('Message', controller.signal)
  const failure = line.catch((error: Error) => error.message)
  await input.pasteBracketedText('x'.repeat(70000))
  await input.typeText('small')
  controller.abort()
  expect(await failure).toBe('Input cancelled')
  const next = io.readLine('Message')
  input.pressEnter()
  expect(await next).toBe('')
})

test('nonstreaming mode still renders accepted content, errors and tool progress', async () => {
  const { io, frame } = await fixture({ stream: false, secrets: ['known-secret'] })
  io.event({ type: 'text_delta', text: 'hidden preview' })
  expect(await frame()).not.toContain('hidden preview')
  io.event({ type: 'assistant', message: { kind: 'assistant', content: 'Accepted answer', toolCalls: [] } })
  expect(await frame()).toContain('Accepted answer')
  io.result({ ...result('', 'error'), error: { code: 'provider_error', message: 'Failure known-secret' } })
  const session = newSession({ provider: 'openai', model: 'mock-model' })
  io.setSession(session)
  expect(await frame()).toContain('Failure [REDACTED]')
  expect(await frame()).toContain('Error')
})

test('repeated close settles inputs, destroys once and unregisters all hooks', async () => {
  const before = { sigint: process.listenerCount('SIGINT'), sigterm: process.listenerCount('SIGTERM'),
    sighup: process.listenerCount('SIGHUP'), exit: process.listenerCount('exit') }
  const { io, setup } = await fixture()
  let destroyEvents = 0
  setup.renderer.on(CliRenderEvents.DESTROY, () => destroyEvents++)
  const line = io.readLine('Message')
  io.close()
  io.close()
  expect(await line).toBeUndefined()
  expect(destroyEvents).toBe(1)
  expect(setup.renderer.isDestroyed).toBe(true)
  expect(io.isClosed).toBe(true)
  expect(process.listenerCount('SIGINT')).toBe(before.sigint)
  expect(process.listenerCount('SIGTERM')).toBe(before.sigterm)
  expect(process.listenerCount('SIGHUP')).toBe(before.sighup)
  expect(process.listenerCount('exit')).toBe(before.exit)
  expect(await io.readLine('Closed')).toBeUndefined()
  expect(await io.askText('Closed')).toBeUndefined()
  expect(await io.choose('Closed', [{ name: 'A', value: 'a' }])).toBeUndefined()
})

test('renderer errors and external renderer destruction clean up pending input', async () => {
  const first = await fixture()
  const line = first.io.readLine('Message')
  const failure = line.catch((error: Error) => error.message)
  first.setup.renderer.emit(CliRenderEvents.RENDER_ERROR, { error: new Error('synthetic render error'), renderable: undefined })
  expect(await failure).toBe('OpenTUI renderer failed: synthetic render error')
  expect(first.io.failed).toBe(true)
  expect(first.io.readLine('After failure')).rejects.toThrow('OpenTUI renderer failed')
  expect(first.setup.renderer.isDestroyed).toBe(true)
  const second = await fixture()
  const choice = second.io.choose('Model', [{ name: 'A', value: 'a' }])
  second.setup.renderer.destroy()
  expect(await choice).toBeUndefined()
})

test('close, SIGTERM and SIGHUP cancel a running host once and clean up native resources', async () => {
  for (const action of ['close', 'SIGTERM', 'SIGHUP'] as const) {
    const { io, setup } = await fixture()
    let cancellations = 0
    io.onCancel(() => { cancellations++ })
    if (action === 'close') io.close()
    else process.emit(action)
    io.close()
    expect(cancellations).toBe(1)
    expect(setup.renderer.isDestroyed).toBe(true)
  }
})

test('switching sessions clears partial or error notices from the old conversation', async () => {
  const { io, frame } = await fixture()
  const first = newSession({ provider: 'openai', model: 'first-model' })
  io.setSession(first)
  io.event({ type: 'text_delta', text: 'first-session partial' })
  io.result(result('', 'cancelled'))
  io.setSession({ ...first, history: result('', 'cancelled').history })
  expect(await frame()).toContain('first-session partial')
  const second = newSession({ provider: 'openai', model: 'second-model' })
  io.setSession(second)
  const display = await frame()
  expect(display).toContain('second-model')
  expect(display).not.toContain('first-session partial')
  expect(display).not.toContain('response was not accepted')
  expect(display).toContain('Ready')
})

test('Ctrl+C while idle exits and closes the active composer', async () => {
  const { io, input, setup } = await fixture()
  const line = io.readLine('Message')
  input.pressCtrlC()
  expect(await line).toBeUndefined()
  expect(setup.renderer.isDestroyed).toBe(true)
  expect(io.failed).toBe(false)
})

test('constructor failure destroys native renderer and does not leave process hooks', async () => {
  const setup = await createTestRenderer({ width: 80, height: 20, exitOnCtrlC: false, exitSignals: [] })
  const listeners = process.listenerCount('SIGINT')
  let destroyed = 0
  setup.renderer.on(CliRenderEvents.DESTROY, () => { destroyed++ })
  setup.renderer.root.add = () => { throw new Error('synthetic attachment failure') }
  expect(() => new OpenTuiIO(setup.renderer)).toThrow('synthetic attachment failure')
  expect(destroyed).toBe(1)
  expect(setup.renderer.isDestroyed).toBe(true)
  expect(process.listenerCount('SIGINT')).toBe(listeners)
})

test('renderer handler failures cancel active host and reject the next input safely', async () => {
  const { io, setup } = await fixture({ secrets: ['known-secret'] })
  let cancelled = 0
  io.onCancel(() => { cancelled++ })
  setup.renderer.emit(CliRenderEvents.HANDLER_ERROR, { error: new Error('\x1b[31mFailure known-secret\x1b[0m') })
  expect(cancelled).toBe(1)
  expect(setup.renderer.isDestroyed).toBe(true)
  await expect(io.readLine('After failure')).rejects.toThrow('OpenTUI renderer failed: Failure [REDACTED]')
})

test('two renderer surfaces own independent parser workers and can close separately', async () => {
  const first = await fixture()
  const second = await fixture()
  const firstSession = newSession({ provider: 'openai', model: 'first-model' })
  firstSession.history = history('First parser content')
  first.io.setSession(firstSession)
  const secondSession = newSession({ provider: 'openai', model: 'second-model' })
  secondSession.history = history('Second parser content')
  second.io.setSession(secondSession)
  expect(await first.frame()).toContain('First parser content')
  first.io.close()
  expect(await second.frame()).toContain('Second parser content')
  second.io.event({ type: 'assistant', message: { kind: 'assistant', content: 'Still rendering independently', toolCalls: [] } })
  expect(await second.frame()).toContain('Still rendering independently')
})

test('canonical transcript loading is display-bounded without changing persisted history', async () => {
  const { io, setup } = await fixture()
  const session = newSession({ provider: 'openai', model: 'mock-model' })
  session.history = Array.from({ length: 1000 }, (_, index) => ({ kind: 'message' as const,
    role: 'user' as const, content: `Entry ${index}` }))
  const original = structuredClone(session)
  io.setSession(session)
  const transcript = setup.renderer.root.findDescendantById('vivi-transcript')!
  expect(transcript.getChildren().length).toBeLessThanOrEqual(256)
  expect(session).toEqual(original)
})

test('packaged Markdown grammars initialize and conceal markup without using a global cache', async () => {
  const { io, setup, frame } = await fixture()
  const session = newSession({ provider: 'openai', model: 'mock-model' })
  session.history = history('## Parsed heading\n\nA **parsed bold** response')
  io.setSession(session)
  await frame()
  const codeNodes = (node: Renderable): CodeRenderable[] => [
    ...(node instanceof CodeRenderable ? [node] : []), ...node.getChildren().flatMap(codeNodes)
  ]
  const blocks = codeNodes(setup.renderer.root)
  expect(blocks.length).toBeGreaterThan(0)
  await Promise.all(blocks.map((block) => block.highlightingDone))
  const display = await frame()
  expect(display).toContain('Parsed heading')
  expect(display).toContain('parsed bold')
  expect(display).not.toContain('## Parsed heading')
  expect(display).not.toContain('**parsed bold**')
})

test('registering cancellation after close immediately aborts a late-starting operation', async () => {
  const { io } = await fixture()
  expect(io.isClosed).toBe(false)
  io.close()
  const controller = new AbortController()
  const dispose = io.onCancel(() => controller.abort())
  expect(controller.signal.aborted).toBe(true)
  expect(io.isClosed).toBe(true)
  dispose()
})
