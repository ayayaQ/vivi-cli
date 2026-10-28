// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { TextareaRenderable, TextRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import { newSession } from '../src/session.js'
import { SteeringQueue } from '../src/steering.js'

const active: OpenTuiIO[] = []
afterEach(() => { for (const io of active.splice(0)) io.close() })
const tick = () => new Promise(resolve => setTimeout(resolve, 2))
async function fixture(width = 100, height = 30, secrets: string[] = []) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer, { secrets }); active.push(io)
  const node = (id: string): Renderable => setup.renderer.root.findDescendantById(id)!
  const composer = node('vivi-composer') as TextareaRenderable
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const arm = async () => { await tick(); return frame() }
  const click = async (id: string) => { const target = node(id); await setup.mockMouse.click(target.x + 1, target.y) }
  const queue = new SteeringQueue()
  const submitted: { content: string; interrupt: boolean }[] = []
  let cancellations = 0
  const update = () => io.setSteeringQueue(queue.messages)
  const start = () => {
    const cancel = io.onCancel(() => cancellations++)
    io.runStarted()
    const dispose = io.onSteering({
      submit(content, interrupt) {
        try { queue.add(content) }
        catch (error) { io.write(`${(error as Error).message}\n`); return false }
        submitted.push({ content, interrupt }); update()
        return true
      },
      takeLast() { const content = queue.takeLast(); update(); return content },
      clear() { queue.clear(); update() }
    })
    return () => { dispose(); cancel() }
  }
  return { io, setup, node, composer, frame, arm, click, queue, submitted, update, start,
    input: setup.mockInput, mouse: setup.mockMouse, cancellations: () => cancellations }
}
const request = { call: { id: 'write-1', name: 'note_set', arguments: {} },
  currentRevision: 0, description: 'Save this exact reviewed change' }

test('only opted-in agent turns keep the native composer editable and Enter queues FIFO duplicates', async () => {
  const f = await fixture(), stop = f.start()
  await f.arm()
  expect(f.node('vivi-actions').visible).toBe(false)
  expect((await f.frame())).toContain('Interrupt & send')
  for (let i = 0; i < 2; i++) { await f.input.typeText('same queued text'); f.input.pressEnter() }
  expect(f.queue.messages.map(message => message.content)).toEqual(['same queued text', 'same queued text'])
  expect(new Set(f.queue.messages.map(message => message.id)).size).toBe(2)
  expect(f.submitted).toEqual([{ content: 'same queued text', interrupt: false }, { content: 'same queued text', interrupt: false }])
  expect(f.composer.plainText).toBe('')
  const display = await f.frame()
  expect(display).toContain('Queued · 2')
  expect(display).toContain('1. same queued text')
  expect(display).toContain('2. same queued text')
  expect(f.node('vivi-transcript').getChildren().length).toBe(0)
  stop()
  const locked = f.io.onCancel(() => {})
  await f.input.typeText('manager input'); f.input.pressEnter()
  expect(f.composer.plainText).toBe('')
  expect(f.queue.messages.length).toBe(2)
  locked()
})

test('queued messages become displayed users only after acceptance, and session rebuild does not duplicate them', async () => {
  const f = await fixture(), session = newSession({ provider: 'openai', model: 'fixture' })
  f.io.setSession(session)
  const stop = f.start(); await f.arm()
  await f.input.typeText('accepted once'); f.input.pressEnter()
  expect(f.node('vivi-transcript').getChildren().length).toBe(0)
  const initialIndex = (f.io as unknown as { liveHistoryIndex: number }).liveHistoryIndex
  f.io.steeringAccepted('accepted once', true)
  expect((f.io as unknown as { liveHistoryIndex: number }).liveHistoryIndex).toBe(initialIndex)
  f.io.steeringAccepted('second accepted')
  expect((f.io as unknown as { liveHistoryIndex: number }).liveHistoryIndex).toBe(initialIndex + 1)
  f.queue.clear(); f.update()
  expect(f.node('vivi-transcript').getChildren().length).toBe(2)
  session.history = [{ kind: 'message', role: 'user', content: 'accepted once' },
    { kind: 'message', role: 'user', content: 'second accepted' }]
  f.io.setSession(session)
  expect(f.node('vivi-transcript').getChildren().length).toBe(2)
  const display = await f.frame()
  // The generated conversation title may repeat the first user's text.
  expect(display.match(/You/g)?.length).toBe(2)
  expect(display).toContain('second accepted')
  stop()
})

test('Ctrl+Enter and the discoverable Interrupt & send button explicitly request interruption', async () => {
  const f = await fixture(40, 12), stop = f.start()
  await f.arm()
  await f.input.typeText('keyboard interrupt')
  f.input.pressEnter({ ctrl: true })
  await f.input.typeText('mouse interrupt'); await f.frame()
  await f.click('vivi-steering-interrupt')
  expect(f.submitted).toEqual([{ content: 'keyboard interrupt', interrupt: true },
    { content: 'mouse interrupt', interrupt: true }])
  expect(f.cancellations()).toBe(0)
  const display = await f.frame()
  expect(display).toContain('Interrupt & send')
  expect(display).toContain('Queued · 2')
  expect(f.node('vivi-steering-actions').y + f.node('vivi-steering-actions').height).toBeLessThanOrEqual(12)
  expect(f.node('vivi-composer-box').y + f.node('vivi-composer-box').height).toBeLessThanOrEqual(12)
  stop()
})

test('Undo latest edits only the removable latest message and Clear retains captured admission batches', async () => {
  const f = await fixture(), stop = f.start(); await f.arm()
  for (const text of ['first', 'latest']) { await f.input.typeText(text); f.input.pressEnter() }
  await f.frame(); await f.click('vivi-steering-undo')
  expect(f.composer.plainText).toBe('latest')
  expect(f.queue.messages.map(message => message.content)).toEqual(['first'])
  await f.input.typeText(' edited'); f.input.pressEnter()
  expect(f.queue.messages.map(message => message.content)).toEqual(['first', 'latest edited'])
  await f.input.typeText('unfinished')
  await f.frame(); await f.click('vivi-steering-undo')
  expect(f.composer.plainText).toBe('unfinished')
  expect(f.queue.messages.length).toBe(2)
  f.composer.setText('')
  f.queue.stage(0); f.update(); await f.frame()
  await f.click('vivi-steering-undo')
  expect(f.composer.plainText).toBe('')
  expect((await f.frame())).toContain('[sending]')
  await f.click('vivi-steering-clear')
  expect(f.queue.messages.length).toBe(2)
  f.queue.release(); f.update(); await f.frame()
  await f.click('vivi-steering-clear')
  expect(f.queue.messages).toEqual([])
  expect(f.node('vivi-steering-queue').visible).toBe(false)
  stop()
})

test('slash navigation and bounded queue rejections keep the draft and its owner unchanged', async () => {
  const f = await fixture(), stop = f.start(); await f.arm()
  await f.input.typeText('/new')
  f.input.pressTab(); f.input.pressKey('n', { ctrl: true }); f.input.pressEnter()
  expect(f.queue.messages.length).toBe(0)
  expect(f.composer.plainText).toBe('/new')
  expect(f.node('vivi-completions').visible).toBe(false)
  expect(await f.frame()).toContain('draft kept')
  f.composer.setText('')
  for (let i = 0; i < 32; i++) f.queue.add(`queued ${i}`)
  f.update()
  await f.input.typeText('keep me'); f.input.pressEnter()
  expect(f.composer.plainText).toBe('keep me')
  expect(f.queue.messages.length).toBe(32)
  expect(await f.frame()).toContain('Message queue is full')
  stop()
})

test('approval remains deny-default and paste/undo cannot replay a suspended steering draft', async () => {
  const f = await fixture(), stop = f.start(); await f.arm()
  await f.input.typeText('queue me'); f.input.pressEnter()
  await f.input.typeText('unfinished allow')
  const approval = f.io.approve(request, new AbortController().signal)
  f.input.pressEnter(); await f.arm()
  expect(f.composer.plainText).toBe('')
  expect(f.node('vivi-steering-actions').visible).toBe(false)
  await f.input.pasteBracketedText('allow\n')
  f.input.pressKey('-', { ctrl: true })
  expect(f.composer.plainText).toBe('')
  expect(f.queue.messages.length).toBe(1)
  f.input.pressEnter()
  expect(await approval).toBe(false)
  expect(f.composer.plainText).toBe('unfinished allow')
  f.input.pressEnter() // Closing-input batch is never a new steering submit.
  expect(f.queue.messages.length).toBe(1)
  await f.arm(); f.input.pressEnter()
  expect(f.queue.messages.map(message => message.content)).toEqual(['queue me', 'unfinished allow'])
  expect(f.cancellations()).toBe(0)
  stop()
})

test('Escape and Ctrl+C retain queued input and carry unfinished draft only after scope disposal', async () => {
  const f = await fixture(), stop = f.start(); await f.arm()
  await f.input.typeText('queued'); f.input.pressEnter()
  await f.input.typeText('unfinished draft')
  f.input.pressEscape(); f.input.pressCtrlC()
  expect(f.cancellations()).toBe(2)
  expect(f.composer.plainText).toBe('unfinished draft')
  expect(f.queue.messages.map(message => message.content)).toEqual(['queued'])
  f.io.runFinished('cancelled'); stop()
  await f.input.typeText(' stale'); f.input.pressEnter()
  expect(f.composer.plainText).toBe('')
  const line = f.io.readLine('Message'); await f.frame()
  expect(f.composer.plainText).toBe('unfinished draft')
  f.input.pressEnter(); expect(await line).toBe('unfinished draft')
})

test('scope disposal during approval preserves draft without restoring it into the modal or carrying a stale click', async () => {
  const f = await fixture(), stop = f.start(); await f.arm()
  await f.input.typeText('save draft')
  const button = f.node('vivi-steering-interrupt')
  await f.mouse.pressDown(button.x + 1, button.y)
  const controller = new AbortController()
  const approval = f.io.approve(request, controller.signal)
  stop(); await f.arm()
  await f.mouse.release(button.x + 1, button.y)
  expect(f.submitted).toEqual([])
  expect(f.composer.plainText).toBe('')
  controller.abort(); expect(await approval).toBe(false)
  expect(f.composer.plainText).toBe('')
  const line = f.io.readLine('Message'); await f.frame()
  expect(f.composer.plainText).toBe('save draft')
  f.input.pressEnter(); expect(await line).toBe('save draft')
})

test('old submit/repeat and mouse gestures cannot affect the next bounded run, with draft preserved', async () => {
  const f = await fixture(), stop = f.start(); await f.arm()
  await f.input.typeText('carry draft')
  const button = f.node('vivi-steering-interrupt')
  await f.mouse.pressDown(button.x + 1, button.y)
  f.io.runFinished('completed')
  f.input.pressEnter()
  expect(f.submitted).toEqual([])
  f.io.runStarted()
  await f.mouse.release(button.x + 1, button.y)
  f.input.pressEnter()
  expect(f.submitted).toEqual([])
  await f.arm()
  f.setup.renderer.stdin.emit('data', Buffer.from('\x1b[13;1:2u'))
  f.setup.renderer.stdin.emit('data', Buffer.from('\x1b[13;5:3u'))
  expect(f.submitted).toEqual([])
  expect(f.composer.plainText).toBe('carry draft')
  f.input.pressEnter()
  expect(f.submitted).toEqual([{ content: 'carry draft', interrupt: false }])
  stop()
})

test('queue previews are bounded, redact newly known secrets and remain responsive after compact resize', async () => {
  const f = await fixture(), stop = f.start(); await f.arm()
  f.queue.add('known credential sk-do-not-display ' + '😀'.repeat(5000)); f.update()
  f.io.addSecrets(['sk-do-not-display'])
  expect((f.node('vivi-steering-queue') as TextRenderable).plainText).toContain('[REDACTED]')
  expect(await f.frame()).not.toContain('sk-do-not-display')
  for (const [width, height] of [[40, 12], [80, 20], [100, 30]] as const) {
    f.setup.resize(width, height); const display = await f.frame()
    expect(display).toContain('Interrupt & send')
    expect(f.node('vivi-composer-box').y + f.node('vivi-composer-box').height).toBeLessThanOrEqual(height)
    expect(f.node('vivi-transcript').height).toBeGreaterThan(0)
    expect(f.node('vivi-steering-queue').height).toBeLessThanOrEqual(4)
  }
  stop()
})

test('working composer keeps native Unicode, paste, multiline, mouse focus and undo semantics', async () => {
  const f = await fixture(), stop = f.start(); await f.arm()
  await f.input.pasteBracketedText('🙂中文 pasted\nsecond')
  f.input.pressKey('j', { ctrl: true }); await f.input.typeText('third')
  f.input.pressEnter({ shift: true }); await f.input.typeText('fourth')
  await f.frame()
  expect(f.composer.plainText).toBe('🙂中文 pasted\nsecond\nthird\nfourth')
  expect(f.composer.height).toBe(4)
  f.input.pressKey('-', { ctrl: true }); await f.frame()
  expect(f.composer.plainText.length).toBeLessThan('🙂中文 pasted\nsecond\nthird\nfourth'.length)
  f.input.pressKey('.', { ctrl: true }); await f.frame()
  expect(f.composer.plainText).toBe('🙂中文 pasted\nsecond\nthird\nfourth')
  const area = f.node('vivi-composer')
  await f.mouse.click(area.x + 1, area.y + area.height - 1)
  expect(f.composer.focused).toBe(true)
  f.input.pressEnter()
  expect(f.queue.messages.map(message => message.content)).toEqual(['🙂中文 pasted\nsecond\nthird\nfourth'])
  stop()
})

test('repeated approval dismissal and cancellation restore the same draft once and close safely', async () => {
  const f = await fixture(40, 12), stop = f.start(); await f.arm()
  await f.input.typeText('queued'); f.input.pressEnter()
  await f.input.typeText('keep through approvals')
  const first = f.io.approve(request, new AbortController().signal)
  await f.arm()
  await f.click('vivi-deny'); expect(await first).toBe(false)
  await f.arm()
  expect(f.composer.plainText).toBe('keep through approvals')
  const second = f.io.approve({ ...request, description: 'Second review' }, new AbortController().signal)
  await f.arm()
  f.input.pressArrow('right'); f.input.pressEnter(); expect(await second).toBe(true)
  await f.arm()
  expect(f.composer.plainText).toBe('keep through approvals')
  const third = f.io.approve({ ...request, description: 'Third review' }, new AbortController().signal)
  await f.arm(); f.input.pressCtrlC(); expect(await third).toBe(false)
  expect(f.cancellations()).toBe(1)
  expect(f.composer.plainText).toBe('keep through approvals')
  expect(f.queue.messages.map(message => message.content)).toEqual(['queued'])
  f.io.close(); f.io.close()
  expect(f.cancellations()).toBe(2)
  stop() // Disposed controls and timers cannot re-open the destroyed surface.
  expect(f.io.isClosed).toBe(true)
})

test('question dialogs suspend steering drafts and restore them without treating answers as queued chat', async () => {
  const f = await fixture(), stop = f.start()
  await f.arm(); await f.input.typeText('unfinished steering draft')
  const controller = new AbortController()
  const question = f.io.askQuestions({ requestId: 'steering-question', callId: 'question-1',
    questions: [{ id: 'route', header: 'Route', question: 'Which route?',
      options: [{ id: 'a', label: 'Route A' }, { id: 'b', label: 'Route B' }] }] }, controller.signal)
  await f.arm()
  expect((await f.frame())).toContain('Which route?')
  expect(f.node('vivi-steering-actions').visible).toBe(false)
  expect(f.submitted).toEqual([])
  controller.abort()
  expect((await question).status).toBe('cancelled')
  await f.arm()
  expect(f.composer.plainText).toBe('unfinished steering draft')
  expect(f.submitted).toEqual([])
  f.input.pressEnter()
  expect(f.submitted).toEqual([{ content: 'unfinished steering draft', interrupt: false }])
  stop()
})

test('ordinary held typing and backspace remain native while repeated submit stays inert', async () => {
  const f = await fixture(), stop = f.start(); await f.arm()
  await f.input.typeText('draft')
  f.setup.renderer.stdin.emit('data', Buffer.from('\x1b[97;1:2u'))
  expect(f.composer.plainText).toBe('drafta')
  f.setup.renderer.stdin.emit('data', Buffer.from('\x1b[127;1:2u'))
  expect(f.composer.plainText).toBe('draft')
  f.setup.renderer.stdin.emit('data', Buffer.from('\x1b[13;1:2u'))
  expect(f.submitted).toEqual([])
  stop()
})

test('queued previews leave question controls inside compact layouts before and after resize', async () => {
  const f = await fixture(), stop = f.start(); await f.arm()
  for (const text of ['first pending', 'second pending', 'third pending']) f.queue.add(text)
  f.update(); await f.frame()
  expect(f.node('vivi-steering-queue').height).toBe(4)
  const controller = new AbortController()
  const question = f.io.askQuestions({ requestId: 'queued-layout', callId: 'queued-layout', questions: [
    { id: 'route', header: 'Route', question: 'Which route should the next step take?', options: [
      { id: 'a', label: 'Route A', description: 'Continue with the first approach.' },
      { id: 'b', label: 'Route B', description: 'Use the second approach.' }
    ] },
    { id: 'scope', header: 'Scope', question: 'Which part should we handle next?' }
  ] }, controller.signal)
  await f.arm()
  for (const [width, height] of [[100, 30], [40, 16], [32, 12], [100, 30]] as const) {
    f.setup.resize(width, height); await f.frame()
    expect(f.node('vivi-steering-queue').height).toBe(1)
    const box = f.node('vivi-questions'), actions = f.node('vivi-question-actions')
    expect(actions.y).toBeGreaterThan(box.y)
    expect(actions.y + actions.height).toBeLessThan(box.y + box.height)
    for (const child of f.node('vivi-root').getChildren().filter(child => child.visible)) {
      expect(child.y + child.height).toBeLessThanOrEqual(height)
    }
  }
  controller.abort(); expect((await question).status).toBe('cancelled')
  await f.arm()
  expect(f.node('vivi-steering-queue').height).toBe(4)
  expect(f.queue.messages.map(message => message.content)).toEqual(['first pending', 'second pending', 'third pending'])
  stop()
})
