// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { TextareaRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import type { QuestionRequest, QuestionResponse } from '@ayayaq/vivi/extensions/questions'
import { OpenTuiIO } from '../src/tui.js'
import { TerminalIO } from '../src/terminal.js'
import { PassThrough } from 'node:stream'
import { newSession } from '../src/session.js'

const fixtures: OpenTuiIO[] = []
afterEach(() => { for (const io of fixtures.splice(0)) io.close() })
const tick = () => new Promise(resolve => setTimeout(resolve, 2))
const choice = { id: 'direction', header: 'Direction', question: 'Which direction?', options: [
  { id: 'east', label: 'East', description: 'Go east' }, { id: 'west', label: 'West', description: 'Go west' }] }
const request = (id = 'questions-1', questions: QuestionRequest['questions'] = [choice]): QuestionRequest => ({ requestId: id, callId: `call-${id}`, questions })
const approval = { call: { id: 'approval-1', name: 'note_set', arguments: {} }, currentRevision: 1, description: 'Review exact action' }
async function fixture(width = 100, height = 30) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const titles: string[] = []
  const io = new OpenTuiIO(setup.renderer, { terminalTitle: { set(title) { titles.push(title) }, restore() {} } })
  fixtures.push(io)
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const arm = async () => { await tick(); return frame() }
  const node = (id: string): Renderable => { const found = setup.renderer.root.findDescendantById(id); if (!found) throw new Error(`Missing ${id}`); return found }
  const click = async (id: string) => { const target = node(id); await setup.mockMouse.click(target.x + Math.min(1, target.width - 1), target.y) }
  return { io, setup, frame, arm, input: setup.mockInput, mouse: setup.mockMouse, node, click, titles }
}
function watch<T>(promise: Promise<T>) {
  let settled = false; void promise.then(() => { settled = true })
  return async () => { await Promise.resolve(); expect(settled).toBe(false) }
}
const signal = () => new AbortController().signal

test('native choices are never default answers and only final Submit sends the selected option', async () => {
  const f = await fixture(), answer = f.io.askQuestions(request(), signal()), pending = watch(answer)
  f.input.pressEnter(); await pending()
  expect(await f.arm()).toContain('0/1 ready')
  await f.click('vivi-question-submit'); await pending()
  f.input.pressArrow('down'); f.input.pressEnter(); await pending()
  expect(await f.frame()).toContain('1/1 ready')
  f.input.pressEnter()
  expect(await answer).toEqual({ requestId: 'questions-1', status: 'answered', answers: [{ id: 'direction', answer: { kind: 'option', optionId: 'west' } }] })
})

test('three pages retain option, Unicode multiline Other, and explicit skip until Submit', async () => {
  const f = await fixture(), questions = [choice, { ...choice, id: 'notes', header: 'Notes' }, { id: 'extra', header: 'Extra', question: 'Any extra details?' }]
  const answer = f.io.askQuestions(request('three', questions), signal()), pending = watch(answer)
  await f.arm(); await f.click('vivi-question-option-0'); await f.frame(); await f.click('vivi-question-next')
  await f.frame(); await f.click('vivi-question-other'); await f.input.pasteBracketedText('日本語 🙂 café')
  f.input.pressKey('j', { ctrl: true }); await f.input.pasteBracketedText('second\nthird')
  const text = '日本語 🙂 café\nsecond\nthird'
  expect((f.node('vivi-question-editor') as TextareaRenderable).plainText).toBe(text)
  f.input.pressEnter(); await f.frame(); await f.click('vivi-question-next'); await f.frame()
  await f.click('vivi-question-skip'); await pending()
  await f.click('vivi-question-prev'); await f.frame()
  expect((f.node('vivi-question-editor') as TextareaRenderable).plainText).toBe(text)
  await f.click('vivi-question-submit')
  expect(await answer).toEqual({ requestId: 'three', status: 'answered', answers: [
    { id: 'direction', answer: { kind: 'option', optionId: 'east' } },
    { id: 'notes', answer: { kind: 'text', text } }, { id: 'extra', answer: { kind: 'skipped' } }] })
})

test('free text preserves genuine printable credentials for host screening and strips terminal controls visibly', async () => {
  const f = await fixture(), answer = f.io.askQuestions(request('text', [{ id: 'text', header: 'Text', question: 'Write your answer' }]), signal())
  await f.arm(); f.io.addSecrets(['fake-local-key'])
  await f.input.pasteBracketedText('fake-local-key\n\x1b[31m日本語\x1b[0m')
  expect((f.node('vivi-question-editor') as TextareaRenderable).plainText).toBe('fake-local-key\n日本語')
  f.input.pressEnter(); await f.frame(); await f.click('vivi-question-submit')
  expect(await answer).toEqual({ requestId: 'text', status: 'answered', answers: [{ id: 'text', answer: { kind: 'text', text: 'fake-local-key\n日本語' } }] })
})

test('Escape and Cancel cancel only the question; Ctrl-C still cancels its run', async () => {
  const f = await fixture(); let cancelled = 0
  const dispose = f.io.onCancel(() => { cancelled++ }); f.io.runStarted()
  for (const action of ['escape', 'button']) {
    const answer = f.io.askQuestions(request(action), signal()); await f.arm()
    if (action === 'escape') f.input.pressEscape(); else await f.click('vivi-question-cancel')
    expect(await answer).toEqual({ requestId: action, status: 'cancelled' }); expect(cancelled).toBe(0)
    expect(f.titles.at(-1)).toStartWith('[~]')
  }
  const answer = f.io.askQuestions(request('ctrl-c'), signal()); await f.arm(); f.input.pressCtrlC()
  expect(await answer).toEqual({ requestId: 'ctrl-c', status: 'cancelled' }); expect(cancelled).toBe(1)
  dispose()
})

test('question and approval FIFO preserves a multiline unfinished chat draft in both orders', async () => {
  for (const questionFirst of [true, false]) {
    const f = await fixture(), chat = f.io.readLine('Message'), chatPending = watch(chat)
    await f.input.pasteBracketedText('unfinished 日本語\ndraft')
    let question: Promise<QuestionResponse>, review: Promise<boolean>
    if (questionFirst) { question = f.io.askQuestions(request(), signal()); review = f.io.approve(approval, signal()) }
    else { review = f.io.approve(approval, signal()); question = f.io.askQuestions(request(), signal()) }
    await f.arm()
    if (questionFirst) { expect(f.node('vivi-questions')).toBeDefined(); f.input.pressEscape(); expect(await question).toEqual({ requestId: 'questions-1', status: 'cancelled' }); await f.arm(); f.input.pressEnter(); expect(await review).toBe(false) }
    else { expect(f.setup.renderer.root.findDescendantById('vivi-questions')).toBeUndefined(); f.input.pressEnter(); expect(await review).toBe(false); await f.arm(); f.input.pressEscape(); await question }
    await f.frame(); await chatPending()
    expect((f.node('vivi-composer') as TextareaRenderable).plainText).toBe('unfinished 日本語\ndraft')
    f.input.pressEnter(); expect(await chat).toBe('unfinished 日本語\ndraft')
  }
})

test('queued question waits for ordinary text/choice input and abort removes only the queued request', async () => {
  for (const modal of ['text', 'choice']) {
    const f = await fixture(), other = modal === 'text' ? f.io.askText('Existing input', 'keep this') : f.io.choose('Existing choice', [{ name: 'keep', value: 'keep' }])
    const controller = new AbortController(), queued = f.io.askQuestions(request('queued'), controller.signal)
    await f.frame(); expect(f.setup.renderer.root.findDescendantById('vivi-questions')).toBeUndefined()
    controller.abort(); expect(await queued).toEqual({ requestId: 'queued', status: 'cancelled' })
    const next = f.io.askQuestions(request('next'), signal())
    f.input.pressEnter(); expect(await other).toBe(modal === 'text' ? 'keep this' : 'keep')
    await f.arm(); expect(await f.frame()).toContain('Which direction?')
    f.input.pressEscape(); expect(await next).toEqual({ requestId: 'next', status: 'cancelled' })
  }
})

test('abort, close, owner change and stale mouse releases cannot answer a later prompt', async () => {
  const f = await fixture(), firstController = new AbortController(), first = f.io.askQuestions(request('old'), firstController.signal)
  await f.arm(); const old = f.node('vivi-question-submit'); await f.mouse.pressDown(old.x + 1, old.y)
  firstController.abort(); expect(await first).toEqual({ requestId: 'old', status: 'cancelled' })
  const second = f.io.askQuestions(request('new'), signal()), pending = watch(second)
  await f.arm(); const fresh = f.node('vivi-question-submit'); await f.mouse.release(fresh.x + 1, fresh.y); await pending()
  f.io.setSession(newSession({ provider: 'openai', model: 'fixture' })); expect(await second).toEqual({ requestId: 'new', status: 'cancelled' })
  const third = f.io.askQuestions(request('closing'), signal()), queued = f.io.approve(approval, signal()); await f.arm(); f.io.close()
  expect(await third).toEqual({ requestId: 'closing', status: 'cancelled' }); expect(await queued).toBe(false)
})

test('resize preserves draft and mouse press identity, hidden mode keys cannot grant an answer or authority', async () => {
  const f = await fixture(), answer = f.io.askQuestions(request(), signal()), pending = watch(answer)
  await f.arm(); const option = f.node('vivi-question-option-0'); await f.mouse.pressDown(option.x + 2, option.y)
  f.setup.resize(40, 16); await f.frame(); const resized = f.node('vivi-question-option-0'); await f.mouse.release(resized.x + 2, resized.y)
  await pending(); expect(await f.frame()).toContain('0/1 ready')
  for (const key of ['n', 'r', 'p']) f.input.pressKey(key, { ctrl: true })
  f.input.pressTab({ shift: true }); await f.frame(); await pending()
  expect(await f.frame()).toContain('Manual')
  await f.click('vivi-question-option-1'); await f.frame()
  f.setup.resize(80, 24); await f.frame(); await f.click('vivi-question-submit')
  expect((await answer).status).toBe('answered')
})

test('model metadata controls and credentials are sanitized in every question display', async () => {
  const f = await fixture(); f.io.addSecrets(['known-question-secret'])
  const answer = f.io.askQuestions(request('safe', [{ ...choice, header: '\x1b]2;PWN\x07known-question-secret',
    question: '\x1b[31mSafe text\x1b[0m known-question-secret', options: [{ id: 'one', label: '\x1b[31mOne\x1b[0m', description: 'known-question-secret' }, { id: 'two', label: 'Two' }] }]), signal())
  const display = await f.arm()
  expect(display).toContain('Safe text'); expect(display).not.toContain('PWN'); expect(display).not.toContain('known-question-secret')
  f.input.pressEscape(); await answer
})

test('line mode and pipes declare questions unavailable and never consume piped answers', async () => {
  const input = new PassThrough(), output = new PassThrough(), io = new TerminalIO({ input, output })
  try {
    input.write('east\n'); expect(io.canAskQuestions).toBe(false)
    expect(await io.askQuestions(request('line'), signal())).toEqual({ requestId: 'line', status: 'cancelled' })
    expect(await io.readLine('Next chat')).toBe('east')
  } finally { io.close() }
})


test('32-column compact and roomy forms keep all mouse actions visible through Other and multiline resize', async () => {
  const f = await fixture(32, 12), questions = [{ ...choice, options: [...choice.options!, { id: 'north', label: 'North', description: 'Go north' }] }]
  const answer = f.io.askQuestions(request('compact', questions), signal()); await f.arm()
  for (const [width, height] of [[32, 12], [120, 40], [32, 12]] as const) {
    f.setup.resize(width, height); await f.frame()
    for (const id of ['skip', 'submit', 'cancel']) { const button = f.node(`vivi-question-${id}`); expect(button.y + button.height).toBeLessThanOrEqual(height); expect(button.x + button.width).toBeLessThanOrEqual(width) }
  }
  await f.click('vivi-question-other'); await f.frame(); await f.input.pasteBracketedText('compact 日本語\nsecond\nthird')
  for (const [width, height] of [[120, 40], [32, 12]] as const) {
    f.setup.resize(width, height); await f.frame()
    const editor = f.node('vivi-question-editor') as TextareaRenderable
    expect(editor.plainText).toBe('compact 日本語\nsecond\nthird'); expect(editor.y + editor.height).toBeLessThanOrEqual(height)
    for (const id of ['skip', 'submit', 'cancel']) { const button = f.node(`vivi-question-${id}`); expect(button.y + button.height).toBeLessThanOrEqual(height); expect(button.x + button.width).toBeLessThanOrEqual(width) }
  }
  f.input.pressEnter(); f.input.pressEnter(); expect((await answer).status).toBe('answered')
})

test('later ordinary modal cannot mutate an active question and a failed setup can reopen', async () => {
  const f = await fixture(), answer = f.io.askQuestions(request('kept'), signal()); await f.arm()
  expect(await f.io.choose('Unrelated choice', [{ name: 'wrong', value: 'wrong' }])).toBeUndefined()
  expect(await f.io.chooseSearchable('Unrelated search', [{ name: 'wrong', value: 'wrong' }])).toBeUndefined()
  expect(await f.io.askText('Unrelated text')).toBeUndefined()
  expect(f.setup.renderer.root.findDescendantById('vivi-picker')).toBeUndefined()
  await f.click('vivi-question-option-0'); await f.frame(); await f.click('vivi-question-submit')
  expect((await answer).status).toBe('answered')
  const root = f.setup.renderer.root.findDescendantById('vivi-root')!, original = root.insertBefore
  root.insertBefore = () => { throw new Error('offline synthetic question attachment failure') }
  expect(await f.io.askQuestions(request('failed'), signal())).toEqual({ requestId: 'failed', status: 'cancelled' })
  root.insertBefore = original
  const reopened = f.io.askQuestions(request('reopened'), signal()); await f.arm(); f.input.pressEscape()
  expect(await reopened).toEqual({ requestId: 'reopened', status: 'cancelled' })
})


test('answer edits and paste never split astral Unicode at the 4000 UTF-16-unit limit', async () => {
  const f = await fixture(), answer = f.io.askQuestions(request('limit', [{ id: 'text', header: 'Text', question: 'Write your answer' }]), signal())
  await f.arm(); const editor = f.node('vivi-question-editor') as TextareaRenderable
  await f.input.pasteBracketedText('a'.repeat(3999))
  await f.input.pasteBracketedText('🙂'); expect(editor.plainText).toBe('a'.repeat(3999))
  editor.setText('a'.repeat(3999) + '🙂'); await f.frame(); expect(editor.plainText).toBe('a'.repeat(3999))
  editor.setText('a'.repeat(3998) + '🙂'); await f.frame(); expect(editor.plainText.length).toBe(4000)
  f.input.pressEnter(); f.input.pressEnter()
  expect(await answer).toEqual({ requestId: 'limit', status: 'answered', answers: [{ id: 'text', answer: { kind: 'text', text: 'a'.repeat(3998) + '🙂' } }] })
})

test('capture binds queued request IDs and draft metadata even when the original object changes', async () => {
  const f = await fixture(), other = f.io.askText('Existing modal'), original = request('capture'), controller = new AbortController()
  const answer = f.io.askQuestions(original, controller.signal)
  Object.assign(original, { requestId: 'mutated', questions: [] })
  controller.abort(); expect(await answer).toEqual({ requestId: 'capture', status: 'cancelled' })
  f.input.pressEscape(); expect(await other).toBeUndefined()
})

test('held Enter and rapid prior approval clicks cannot select a fresh question', async () => {
  const f = await fixture(), review = f.io.approve(approval, signal()), answer = f.io.askQuestions(request('after-approval'), signal()), pending = watch(answer)
  await f.arm(); await f.click('vivi-approve'); expect(await review).toBe(true); await f.arm()
  await f.click('vivi-question-option-0'); await pending(); expect(await f.frame()).toContain('0/1 ready')
  f.setup.renderer.stdin.emit('data', Buffer.from('\x1b[13;1:2u')); await pending()
  f.input.pressEnter(); expect(await f.frame()).toContain('1/1 ready'); await pending()
  f.setup.renderer.stdin.emit('data', Buffer.from('\x1b[13;1:2u')); await pending()
  f.input.pressEnter(); expect((await answer).status).toBe('answered')
})
