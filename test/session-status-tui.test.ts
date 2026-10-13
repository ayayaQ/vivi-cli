// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { CliRenderEvents, TextRenderable, TextareaRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import type { TestRendererSetup } from '@opentui/core/testing'
import type { AgentResult } from '@ayayaq/vivi'
import { OpenTuiIO } from '../src/tui.js'
import { newSession } from '../src/session.js'
import { sendChatTurn } from '../src/terminal.js'
import type { CliHost } from '../src/host.js'
const fixtures: OpenTuiIO[] = []
afterEach(() => { for (const io of fixtures.splice(0)) io.close() })
function clock() {
  let time = 10000, id = 0
  const timers = new Map<number, () => void>()
  return { timers, now: () => time, every(callback: () => void) { timers.set(++id, callback); return id },
    clear(handle: unknown) { timers.delete(handle as number) }, advance(ms: number) { time += ms; for (const callback of timers.values()) callback() } }
}
async function fixture(width = 100, height = 30, stream = false) {
  const runClock = clock(), setup = await createTestRenderer({ width, height, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer, { runClock, stream })
  fixtures.push(io)
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const status = () => (setup.renderer.root.findDescendantById('vivi-status') as TextRenderable).plainText
  return { io, setup, input: setup.mockInput, runClock, frame, status }
}
const request = { call: { id: 'fixture-note', name: 'note_set', arguments: {} }, description: 'Fixture proposed change', currentRevision: 0 }
const result: AgentResult = { status: 'completed', history: [{ kind: 'message', role: 'user', content: 'Test' },
  { kind: 'assistant', content: 'Done', toolCalls: [] }], content: 'Done', rounds: 1, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }
const statusNode = (setup: TestRendererSetup) => setup.renderer.root.findDescendantById('vivi-status') as TextRenderable

test('nonstreaming working status ticks before provider output and stops after completion with session refresh', async () => {
  const { io, runClock, frame, status } = await fixture()
  const session = newSession({ provider: 'openai', model: 'fixture' })
  io.setSession(session)
  io.runStarted(); expect(await frame()).toContain('Working · 0s')
  runClock.advance(1250); expect(status()).toContain('Working · 1s')
  io.event({ type: 'tool_started', call: request.call })
  expect(status()).toContain('Tool running: note_set')
  io.event({ type: 'tool_completed', message: { kind: 'tool_result', callId: 'fixture-note', name: 'note_set', content: 'Done' } })
  expect(status()).not.toContain('Tool running:')
  runClock.advance(2000); io.runFinished('completed'); io.result(result)
  io.setSession({ ...session, history: result.history, title: 'Test', titleRevision: 1 })
  expect(status()).toContain('Completed · 3s'); expect(runClock.timers.size).toBe(0)
  const stopped = status(); runClock.advance(10000); expect(status()).toBe(stopped)
})

test('approval waits have a truthful separate label, accumulate total time and resume working after allow/deny', async () => {
  const { io, input, runClock, frame, status } = await fixture()
  io.runStarted()
  for (const approve of [false, true]) {
    const waiting = io.approve(request, new AbortController().signal)
    await new Promise(resolve => setTimeout(resolve, 2)); await frame()
    expect(status()).toContain('Waiting for approval'); expect(status()).not.toContain('Working')
    runClock.advance(2400); expect(status()).toContain(approve ? '4s' : '2s')
    if (approve) input.pressArrow('right')
    input.pressEnter(); expect(await waiting).toBe(approve)
    expect(status()).toContain('Working')
  }
  io.runFinished('completed'); expect(runClock.timers.size).toBe(0)
})

test('abort cancels a waiting approval and timer cleanup is independent of queued typing and later runs', async () => {
  const { io, input, runClock, frame, status } = await fixture()
  let cancels = 0
  const controller = new AbortController(), dispose = io.onCancel(() => { cancels++; controller.abort() })
  expect(runClock.timers.size).toBe(0) // onCancel is also used by catalog and manual-memory operations.
  io.runStarted(); runClock.advance(1000)
  const waiting = io.approve(request, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 2)); await frame()
  input.pressEscape(); expect(await waiting).toBe(false); expect(cancels).toBe(1)
  expect(status()).toContain('Cancelling')
  io.runFinished('cancelled'); dispose(); expect(runClock.timers.size).toBe(0)
  expect(status()).toContain('Cancelled · 1s')
  const idle = io.readLine('Message')
  await input.typeText('Fresh prompt'); input.pressEnter(); expect(await idle).toBe('Fresh prompt')
  io.runStarted(); expect(status()).toContain('Working · 0s'); expect(runClock.timers.size).toBe(1)
  io.runFinished('error'); expect(status()).toContain('Error · 0s'); expect(runClock.timers.size).toBe(0)
})

test('manual approval outside a turn never starts an elapsed working timer', async () => {
  const { io, input, runClock, frame, status } = await fixture()
  io.runStarted(); io.runFinished('completed')
  const waiting = io.approve(request, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 2)); await frame()
  expect(status()).toContain('Approval required'); expect(status()).not.toContain('Completed'); expect(status()).not.toContain('Working')
  expect(runClock.timers.size).toBe(0)
  input.pressEnter(); expect(await waiting).toBe(false)
  expect(status()).toContain('Ready'); expect(status()).not.toContain('Approval required')
})

test('renderer close/destruction/error stop elapsed callbacks and settle active approvals', async () => {
  for (const stop of ['close', 'destroy', 'error']) {
    const { io, setup, runClock, frame } = await fixture()
    io.runStarted(); const pending = io.approve(request, new AbortController().signal)
    await frame(); expect(runClock.timers.size).toBe(1)
    if (stop === 'close') io.close()
    else if (stop === 'destroy') setup.renderer.destroy()
    else setup.renderer.emit(CliRenderEvents.RENDER_ERROR, new Error('Fixture render failure'))
    expect(await pending.catch(() => false)).toBe(false)
    expect(runClock.timers.size).toBe(0)
    runClock.advance(10000); io.runStarted(); expect(runClock.timers.size).toBe(0)
  }
})

test('failed persistence before a result ends the timer and shows error without awaiting another prompt', async () => {
  const { io, runClock, status } = await fixture()
  const host = { async send() { throw new Error('Fixture checkpoint error') } } as unknown as CliHost
  await expect(sendChatTurn(host, io, 'Test')).rejects.toThrow('checkpoint error')
  expect(status()).toContain('Error · 0s'); expect(runClock.timers.size).toBe(0)
})

test('session names appear in header; rename text modal dismisses without carrying input or starting a timer', async () => {
  const { io, setup, input, runClock, frame } = await fixture()
  io.setSession({ ...newSession({ provider: 'openai', model: 'fixture' }), title: 'Find login bug 日本語', titleRevision: 1 })
  expect(await frame()).toContain('Find login bug 日本語')
  const naming = io.askText('Session name', 'Find login bug 日本語')
  await input.typeText('Draft'); input.pressEscape(); expect(await naming).toBeUndefined()
  expect(runClock.timers.size).toBe(0)
  const next = io.readLine('Message')
  expect((setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable).plainText).toBe('')
  input.pressEnter(); expect(await next).toBe('')
})

test('working and waiting labels remain inside the compact footer after resize', async () => {
  const { io, setup, runClock, frame } = await fixture(100, 30)
  io.setWorkspace('/fixture/project'); io.runStarted()
  for (const [width, height] of [[40, 12], [70, 20], [100, 30]]) {
    setup.resize(width, height); runClock.advance(1000); expect(await frame()).toContain('Working')
    expect(statusNode(setup).plainText.split('\n')[0]!.length).toBeLessThanOrEqual(width)
  }
  const waiting = io.approve(request, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 2))
  setup.resize(40, 12); expect(await frame()).toContain('Waiting for approval')
  expect(statusNode(setup).plainText.split('\n')[0]!.length).toBeLessThanOrEqual(40)
  io.close(); expect(await waiting).toBe(false); expect(runClock.timers.size).toBe(0)
})


test('long session names fit a title-only header and model metadata stays above the composer', async () => {
  const { io, setup, frame } = await fixture()
  const session = { ...newSession({ provider: 'openai', model: 'fixture', reasoning: 'high' }), title: 'Readable '.repeat(8).trim(), titleRevision: 1 }
  io.setSession(session)
  let displayed = await frame()
  expect(displayed).toContain('openai / fixture'); expect(displayed).not.toContain(session.id)
  const header = setup.renderer.root.findDescendantById('vivi-header') as TextRenderable
  expect(header.plainText).toBe(session.title)
  expect(header.height).toBe(1)
  const model = setup.renderer.root.findDescendantById('vivi-model') as TextRenderable
  const composer = setup.renderer.root.findDescendantById('vivi-composer-box')!
  expect(model.y + model.height).toBe(composer.y)
  io.setSession({ ...session, title: '名'.repeat(80) })
  setup.resize(40, 20); displayed = await frame()
  expect(displayed).toContain('openai / fixture'); expect(displayed).toContain('…')
  expect(header.plainText.split('\n')).toHaveLength(1)
  expect(header.plainText.length).toBeLessThanOrEqual(40)
  expect(model.y + model.height).toBe(composer.y)
  expect(displayed).not.toContain(session.id)
})

test('fitted session-name headers never cut a joined Unicode grapheme', async () => {
  const { io, setup, frame } = await fixture(40, 20)
  const emoji = '👩🏽‍💻'
  io.setSession({ ...newSession({ provider: 'openai', model: 'fixture' }), title: emoji.repeat(25), titleRevision: 1 })
  await frame()
  const header = setup.renderer.root.findDescendantById('vivi-header') as TextRenderable
  const prefix = header.plainText.split('…')[0]!
  expect(prefix).toBe(emoji.repeat(prefix.length / emoji.length))
})
