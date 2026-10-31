// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { TextareaRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import type { BackgroundProcessControls } from '../src/process-controls.js'
const active: OpenTuiIO[] = []
afterEach(() => { for (const io of active.splice(0)) io.close() })
const id = '11111111-1111-4111-8111-111111111111'
const job = { executionId: id, executable: 'node', args: ['dev.mjs'], cwd: '/fixture', state: 'running', background: true, cleanupConfirmed: false, totalBytes: 0, truncated: false }
async function fixture(width = 100, height = 30) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer); active.push(io)
  const node = (value: string): Renderable => setup.renderer.root.findDescendantById(value)!
  const composer = node('vivi-composer') as TextareaRenderable
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const arm = async () => { await new Promise(resolve => setTimeout(resolve, 2)); return frame() }
  const click = async (value: string) => { const target = node(value); await setup.mockMouse.click(target.x + 1, target.y) }
  return { io, setup, node, composer, frame, arm, click, input: setup.mockInput }
}
const request = { call: { id: 'review', name: 'note_set', arguments: {} }, currentRevision: 0, description: 'Exact review' }

test('independent process Stop and Stop All preserve idle draft and serialize duplicate cleanup clicks', async () => {
  const f = await fixture(); let stopped = 0, all = 0, finish!: () => void
  const release = f.io.onProcessControls({ list: () => [job], stop: async () => { stopped++; await new Promise<void>(resolve => { finish = resolve }) }, async stopAll() { all++ } })
  const line = f.io.readLine('Message'); await f.arm(); await f.input.typeText('keep this draft'); await f.frame()
  expect(await f.frame()).toContain('Processes 1')
  await f.click('vivi-process-stop'); await f.click('vivi-process-stop-all'); await f.click('vivi-process-stop')
  expect(stopped).toBe(1); expect(all).toBe(1); expect(f.composer.plainText).toBe('keep this draft')
  finish(); await Promise.resolve(); await f.frame(); await f.click('vivi-process-stop-all')
  expect(all).toBe(2); expect(f.composer.plainText).toBe('keep this draft')
  release(); expect(f.node('vivi-processes').visible).toBe(false)
  f.io.close(); expect(await line).toBeUndefined()
})

test('process controls remain independent during steering, approval and after inference cancellation', async () => {
  const f = await fixture(); let all = 0, cancelled = 0
  const release = f.io.onProcessControls({ list: () => [job], async stop() {}, async stopAll() { all++ } })
  const cancel = f.io.onCancel(() => cancelled++); f.io.runStarted()
  const steering = f.io.onSteering({ submit: () => false, takeLast() {}, clear() {} })
  await f.arm(); await f.input.typeText('queued draft'); await f.frame(); await f.click('vivi-process-stop-all')
  expect(all).toBe(1); expect(cancelled).toBe(0); expect(f.composer.plainText).toBe('queued draft')
  const approval = f.io.approve(request, new AbortController().signal); await f.arm()
  f.setup.renderer.stdin.emit('data', Buffer.from('\x1b[18~')); await f.frame()
  expect(all).toBe(2); expect(cancelled).toBe(0)
  await f.click('vivi-deny'); expect(await approval).toBe(false)
  expect(f.composer.plainText).toBe('queued draft')
  f.io.runFinished('cancelled'); steering(); cancel(); await f.frame(); await f.click('vivi-process-stop-all')
  expect(all).toBe(3); release()
})

test('host replacement invalidates process gestures and old disposal cannot detach newer controls', async () => {
  const f = await fixture(); let old = 0, next = 0
  const controls = (stopAll: () => Promise<void>): BackgroundProcessControls => ({ list: () => [job], async stop() {}, stopAll })
  const releaseOld = f.io.onProcessControls(controls(async () => { old++ })); await f.frame()
  const button = f.node('vivi-process-stop-all'); await f.setup.mockMouse.pressDown(button.x + 1, button.y)
  const releaseNext = f.io.onProcessControls(controls(async () => { next++ })); releaseOld(); await f.frame()
  await f.setup.mockMouse.release(button.x + 1, button.y); expect(old).toBe(0); expect(next).toBe(0)
  await f.click('vivi-process-stop-all'); expect(old).toBe(0); expect(next).toBe(1); releaseNext()
})


test('compact question dialogs keep independent Stop All visible and never submit an answer', async () => {
  const f = await fixture(44, 15); let all = 0
  const release = f.io.onProcessControls({ list: () => [job], async stop() {}, async stopAll() { all++ } })
  const question = f.io.askQuestions({ requestId: 'question', callId: 'question-call', questions: [{ id: 'choice', header: 'Choice', question: 'Select one?',
    options: [{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }] }] }, new AbortController().signal)
  await f.arm(); const button = f.node('vivi-process-stop-all')
  expect(button.y).toBeLessThan(15); expect(button.x + button.width).toBeLessThanOrEqual(44)
  await f.click('vivi-process-stop-all'); expect(all).toBe(1)
  expect(await f.frame()).toContain('0/1 ready')
  f.setup.resize(80, 24); await f.frame(); f.input.pressEscape()
  expect((await question).status).toBe('cancelled'); release()
})

test('Next changes only the independently stoppable job and uncertain foreground cleanup is labelled', async () => {
  const f = await fixture(), second = { ...job, executionId: '22222222-2222-4222-8222-222222222222', background: false, state: 'failed' }
  const stopped: string[] = []
  const release = f.io.onProcessControls({ list: () => [job, second], async stop(value) { stopped.push(value) }, async stopAll() {} })
  await f.frame(); expect(await f.frame()).toContain('cleanup unconfirmed')
  await f.click('vivi-process-next'); await f.frame(); await f.click('vivi-process-stop')
  expect(stopped).toEqual([id]); release()
})


test('30-column process controls retain visible Stop and Stop All targets after resize', async () => {
  const f = await fixture(30, 18); let all = 0
  const release = f.io.onProcessControls({ list: () => [job], async stop() {}, async stopAll() { all++ } })
  await f.frame()
  for (const id of ['vivi-process-stop', 'vivi-process-stop-all']) {
    const button = f.node(id); expect(button.y).toBeLessThan(18); expect(button.x + button.width).toBeLessThanOrEqual(30)
  }
  expect(f.node('vivi-process-next').visible).toBe(false)
  await f.click('vivi-process-stop-all'); expect(all).toBe(1)
  f.setup.resize(100, 30); await f.frame(); expect(f.node('vivi-process-next').visible).toBe(true); release()
})

test('three-page Unicode Other answers survive a bound job stopping and its process bar disappearing mid-dialog', async () => {
  const f = await fixture(); let cleanupConfirmed = false, stopped = 0, submitted = false
  const release = f.io.onProcessControls({
    list: () => [{ ...job, state: cleanupConfirmed ? 'cancelled' : 'running', cleanupConfirmed }],
    async stop() { stopped++; cleanupConfirmed = true },
    async stopAll() { stopped++; cleanupConfirmed = true }
  })
  const option = { id: 'direction', header: 'Direction', question: 'Which direction?', options: [
    { id: 'east', label: 'East' }, { id: 'west', label: 'West' }] }
  const answer = f.io.askQuestions({ requestId: 'bound-three', callId: 'bound-three-call', questions: [option,
    { ...option, id: 'notes', header: 'Notes' }, { id: 'extra', header: 'Extra', question: 'Any extra details?' }] }, new AbortController().signal)
  void answer.then(() => { submitted = true })
  await f.arm(); expect(f.node('vivi-processes').visible).toBe(true)
  await f.click('vivi-question-option-0'); await f.frame(); await f.click('vivi-question-next')
  await f.frame(); await f.click('vivi-question-other'); await f.input.pasteBracketedText('日本語 🙂 café')
  f.input.pressKey('j', { ctrl: true }); await f.input.pasteBracketedText('second\nthird')
  const text = '日本語 🙂 café\nsecond\nthird'
  expect((f.node('vivi-question-editor') as TextareaRenderable).plainText).toBe(text)
  // Independent cleanup changes the native layout while the question editor owns
  // an unsubmitted multiline answer. It must neither submit nor clear that draft.
  f.setup.renderer.stdin.emit('data', Buffer.from('\x1b[18~'))
  await f.frame(); expect(stopped).toBe(1); expect(cleanupConfirmed).toBe(true)
  expect(f.node('vivi-processes').visible).toBe(false)
  expect((f.node('vivi-question-editor') as TextareaRenderable).plainText).toBe(text)
  expect(submitted).toBe(false)
  f.input.pressEnter(); await f.frame(); await f.click('vivi-question-next'); await f.frame()
  await f.click('vivi-question-skip'); expect(submitted).toBe(false)
  await f.click('vivi-question-prev'); await f.frame()
  expect((f.node('vivi-question-editor') as TextareaRenderable).plainText).toBe(text)
  await f.click('vivi-question-submit')
  expect(await answer).toEqual({ requestId: 'bound-three', status: 'answered', answers: [
    { id: 'direction', answer: { kind: 'option', optionId: 'east' } },
    { id: 'notes', answer: { kind: 'text', text } }, { id: 'extra', answer: { kind: 'skipped' } }] })
  release()
})
