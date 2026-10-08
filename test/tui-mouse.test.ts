// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { SelectRenderable, TextareaRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import type { TestRendererSetup } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import { pickerIndexAt } from '../src/tui-mouse.js'

const fixtures: OpenTuiIO[] = []
afterEach(() => { for (const io of fixtures.splice(0)) io.close() })
const tick = () => new Promise(resolve => setTimeout(resolve, 2))
async function fixture(width = 100, height = 30) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  fixtures.push(io)
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const node = (id: string): Renderable => {
    const found = setup.renderer.root.findDescendantById(id)
    if (!found) throw new Error(`Missing ${id}`)
    return found
  }
  const click = async (id: string) => { const target = node(id); await setup.mockMouse.click(target.x + 1, target.y) }
  return { io, setup, input: setup.mockInput, mouse: setup.mockMouse, frame, node, click }
}
const request = { call: { id: 'memory-1', name: 'memory_create', arguments: {} },
  currentRevision: 'new memory', description: 'Create memory exactly as reviewed' }
function watch<T>(promise: Promise<T>) {
  let settled = false
  void promise.then(() => { settled = true })
  return async () => { await Promise.resolve(); expect(settled).toBe(false) }
}
async function arm(frame: () => Promise<string>) { await tick(); await frame() }

// These are real SGR terminal events through OpenTUI's native hit grid and parser.
test('approval has explicit Deny/Approve buttons; fresh clicks approve or deny exactly once', async () => {
  const f = await fixture()
  const first = f.io.approve(request, new AbortController().signal)
  await arm(f.frame)
  expect(await f.frame()).toContain('› Deny')
  await f.click('vivi-approve')
  expect(await first).toBe(true)
  const second = f.io.approve({ ...request, description: 'Second proposal' }, new AbortController().signal)
  await arm(f.frame)
  await f.click('vivi-deny')
  expect(await second).toBe(false)
  expect(f.node('vivi-picker-box').visible).toBe(false)
})

test('keyboard approval initially denies, requires deliberate selection, ignores typed allow and repeat Enter', async () => {
  const f = await fixture()
  const denied = f.io.approve(request, new AbortController().signal)
  await arm(f.frame)
  await f.input.typeText('allow')
  f.input.pressEnter()
  expect(await denied).toBe(false)
  const allowed = f.io.approve(request, new AbortController().signal)
  const pending = watch(allowed)
  await arm(f.frame)
  f.input.pressTab()
  expect(await f.frame()).toContain('› Approve')
  f.setup.renderer.stdin.emit('data', Buffer.from('\x1b[13;1:2u')) // Kitty repeat
  await pending()
  f.input.pressEnter()
  expect(await allowed).toBe(true)
  const next = f.io.approve(request, new AbortController().signal)
  await arm(f.frame)
  f.input.pressEnter()
  expect(await next).toBe(false)
})

test('approval never activates on a release, unrelated press, modifier click, drag or pointer exit', async () => {
  const f = await fixture()
  const answer = f.io.approve(request, new AbortController().signal)
  const pending = watch(answer)
  await arm(f.frame)
  const yes = f.node('vivi-approve'), no = f.node('vivi-deny')
  await f.mouse.release(yes.x + 1, yes.y)
  await pending()
  await f.mouse.pressDown(no.x + 1, no.y)
  await f.mouse.release(yes.x + 1, yes.y)
  await pending()
  for (const button of [1, 2] as const) { await f.mouse.click(yes.x + 1, yes.y, button); await pending() }
  for (const modifiers of [{ ctrl: true }, { alt: true }, { shift: true }]) {
    await f.mouse.click(yes.x + 1, yes.y, 0, { modifiers }); await pending()
  }
  await f.mouse.drag(yes.x + 1, yes.y, yes.x + 2, yes.y)
  await pending()
  await f.mouse.pressDown(yes.x + 1, yes.y)
  await f.mouse.moveTo(no.x + 1, no.y)
  await f.mouse.release(yes.x + 1, yes.y)
  await pending()
  await f.click('vivi-deny')
  expect(await answer).toBe(false)
})

test('pre-render/unarmed clicks, resize and abort cannot authorize a stale proposal', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const first = f.io.approve(request, controller.signal)
  const pending = watch(first)
  await f.frame() // Mouse down in the unarmed input batch is ignored.
  await f.click('vivi-approve')
  await pending()
  await arm(f.frame)
  let yes = f.node('vivi-approve')
  await f.mouse.pressDown(yes.x + 1, yes.y)
  f.setup.resize(70, 22)
  await f.frame()
  yes = f.node('vivi-approve')
  await f.mouse.release(yes.x + 1, yes.y)
  await pending()
  await f.mouse.pressDown(yes.x + 1, yes.y)
  controller.abort()
  expect(await first).toBe(false)
  const second = f.io.approve({ ...request, description: 'Different exact proposal' }, new AbortController().signal)
  const stillPending = watch(second)
  await arm(f.frame)
  yes = f.node('vivi-approve')
  await f.mouse.release(yes.x + 1, yes.y)
  await stillPending()
  f.input.pressEnter()
  expect(await second).toBe(false)
})

test('a double click cannot carry approval into an immediately following request', async () => {
  const f = await fixture()
  const first = f.io.approve(request, new AbortController().signal)
  let next: Promise<boolean> | undefined
  void first.then(() => { next = f.io.approve({ ...request, description: 'Next request' }, new AbortController().signal) })
  await arm(f.frame)
  const yes = f.node('vivi-approve')
  await f.mouse.doubleClick(yes.x + 1, yes.y)
  expect(await first).toBe(true)
  expect(next).toBeDefined()
  await arm(f.frame)
  await watch(next!)()
  f.input.pressEnter()
  expect(await next).toBe(false)
})

test('default-font picker hit mapping matches rendered centered rows, descriptions and blank/scrollbar cells', async () => {
  const f = await fixture()
  const choices = Array.from({ length: 20 }, (_, value) => ({ name: `option-${value}`, description: `details-${value}`, value }))
  const answer = f.io.choose('Choose options', choices, 10)
  await f.frame()
  const picker = f.node('vivi-picker') as SelectRenderable
  const rowHeight = 2
  const visible = Math.floor(picker.height / rowHeight)
  const first = 10 - Math.floor(visible / 2)
  for (let offset = 0; offset < visible; offset++) {
    expect(pickerIndexAt(picker, picker.x + 3, picker.y + offset * rowHeight)).toBe(first + offset)
    expect(pickerIndexAt(picker, picker.x + 3, picker.y + offset * rowHeight + 1)).toBe(first + offset)
    expect((await f.frame()).split('\n')[picker.y + offset * rowHeight]).toContain(`option-${first + offset}`)
  }
  expect(pickerIndexAt(picker, picker.x + picker.width - 1, picker.y)).toBeUndefined()
  expect(pickerIndexAt(picker, picker.x, picker.y + visible * 2)).toBeUndefined()
  await f.mouse.click(picker.x + 3, picker.y + rowHeight + 1)
  expect(await answer).toBe(first + 1)
})

test('pickers support row click, wheel navigation, Choose/Back and preserve typed values across repeated dialogs', async () => {
  const f = await fixture()
  const choices = Array.from({ length: 30 }, (_, value) => ({ name: `choice-${value}`, value: { value } }))
  const first = f.io.choose('Wheel picker', choices)
  await f.frame()
  let picker = f.node('vivi-picker') as SelectRenderable
  await f.mouse.scroll(picker.x + 3, picker.y, 'down')
  await f.frame()
  expect(picker.getSelectedIndex()).toBeGreaterThan(0)
  const chosen = picker.getSelectedIndex()
  await f.click('vivi-confirm')
  expect(await first).toBe(choices[chosen]!.value)
  const second = f.io.choose('Cancel picker', choices)
  await f.frame()
  await f.click('vivi-back')
  expect(await second).toBeUndefined()
  const third = f.io.choose('Replacement picker', choices)
  await f.frame()
  picker = f.node('vivi-picker') as SelectRenderable
  await f.mouse.click(picker.x + 3, picker.y + 2)
  expect(await third).toBe(choices[1]!.value)
})

test('model row clicks keep exact values, reject stale filter rows and keep query typing focused after wheel', async () => {
  const f = await fixture()
  const choices = Array.from({ length: 30 }, (_, value) => ({ name: `model-${value}`, value: { value } }))
  const answer = f.io.chooseSearchable('Models', choices, { refresh: true })
  const pending = watch(answer)
  await f.frame()
  const picker = f.node('vivi-picker') as SelectRenderable
  const composer = f.node('vivi-composer') as TextareaRenderable
  await f.mouse.scroll(picker.x + 3, picker.y, 'down')
  expect(composer.focused).toBe(true)
  await f.frame()
  await f.mouse.pressDown(picker.x + 3, picker.y)
  await f.input.typeText('model-29')
  await f.frame()
  await f.mouse.release(picker.x + 3, picker.y)
  await pending()
  expect(composer.plainText).toBe('model-29')
  await f.mouse.click(picker.x + 3, picker.y)
  expect(await answer).toEqual({ kind: 'selected', value: choices[29]!.value, query: 'model-29' })
})

test('model refresh/back buttons and empty placeholder clicks remain safe', async () => {
  const f = await fixture()
  const first = f.io.chooseSearchable('Empty models', [], { refresh: true })
  const pending = watch(first)
  await f.frame()
  const picker = f.node('vivi-picker') as SelectRenderable
  await f.mouse.click(picker.x + 3, picker.y)
  await f.click('vivi-confirm')
  await pending()
  await f.input.typeText('filter')
  await f.frame()
  await f.click('vivi-refresh')
  expect(await first).toEqual({ kind: 'refresh', query: 'filter' })
  const second = f.io.chooseSearchable('Other models', [{ name: 'Only model', value: 42 }])
  await f.frame()
  await f.click('vivi-back')
  expect(await second).toBeUndefined()
})

test('command completion clicks fill a draft without submitting and toolbar actions protect nonempty drafts', async () => {
  const f = await fixture()
  const line = f.io.readLine('Message')
  const pending = watch(line)
  await f.frame()
  await f.input.typeText('/m')
  await f.frame()
  const list = f.node('vivi-completion-list')
  await f.mouse.click(list.x + 4, list.y + 2)
  await pending()
  expect((f.node('vivi-composer') as TextareaRenderable).plainText).toBe('/memories')
  f.input.pressEnter()
  expect(await line).toBe('/memories')
  const draft = f.io.readLine('Message')
  const pendingDraft = watch(draft)
  await f.input.typeText('Keep my draft')
  await f.frame()
  await f.click('vivi-action-settings')
  await pendingDraft()
  expect((f.node('vivi-composer') as TextareaRenderable).plainText).toBe('Keep my draft')
  expect(await f.frame()).toContain('Finish or clear your draft')
  f.input.pressEscape()
  await f.frame()
  await f.click('vivi-action-models')
  expect(await draft).toBe('/models')
})

test('text modal Confirm/Cancel work while secret Confirm still uses the hidden-only model', async () => {
  const f = await fixture()
  const first = f.io.askText('Edit memory', 'Existing')
  await f.frame()
  await f.click('vivi-confirm')
  expect(await first).toBe('Existing')
  const second = f.io.askText('Abandon memory', 'Never submit')
  await f.frame()
  await f.click('vivi-back')
  expect(await second).toBeUndefined()
  const secret = f.io.askSecret('Fake key')
  await f.input.typeText('fake-private-key')
  expect(await f.frame()).not.toContain('fake-private-key')
  await f.click('vivi-confirm')
  expect(await secret).toBe('fake-private-key')
})

test('transcript wheel and clicks preserve composer keyboard focus; clicking composer restores it', async () => {
  const f = await fixture()
  f.io.write(Array.from({ length: 80 }, (_, i) => `Transcript ${i}`).join('\n'))
  const line = f.io.readLine('Message')
  await f.frame()
  const transcript = f.node('vivi-transcript')
  const composer = f.node('vivi-composer') as TextareaRenderable
  await f.mouse.scroll(transcript.x + 4, transcript.y + 2, 'up')
  await f.mouse.click(transcript.x + 4, transcript.y + 2)
  expect(composer.focused).toBe(true)
  composer.blur()
  await f.mouse.click(composer.x + 2, composer.y)
  expect(composer.focused).toBe(true)
  await f.input.typeText('Still typing')
  f.input.pressEnter()
  expect(await line).toBe('Still typing')
})

test('compact terminals retain visible approval choices and keyboard-only picker paths', async () => {
  const f = await fixture(40, 12)
  const approval = f.io.approve(request, new AbortController().signal)
  await arm(f.frame)
  const display = await f.frame()
  expect(display).toContain('› Deny')
  expect(display).toContain('Approve')
  await f.click('vivi-deny')
  expect(await approval).toBe(false)
  const choice = f.io.choose('Compact picker', [{ name: 'First', value: 1 }, { name: 'Second', value: 2 }])
  await f.frame()
  f.input.pressArrow('down'); f.input.pressEnter()
  expect(await choice).toBe(2)
})


test('transcript clicks never steal keyboard selection from a choice dialog', async () => {
  const f = await fixture()
  const answer = f.io.choose('Keep picker focus', [{ name: 'First', value: 1 }, { name: 'Second', value: 2 }])
  await f.frame()
  const transcript = f.node('vivi-transcript')
  await f.mouse.click(transcript.x + 3, transcript.y + 1)
  expect((f.node('vivi-picker') as SelectRenderable).focused).toBe(true)
  f.input.pressArrow('down'); f.input.pressEnter()
  expect(await answer).toBe(2)
})

test('short approval dialogs keep both decision buttons inside the visible viewport', async () => {
  for (const [width, height] of [[30, 8], [40, 9], [45, 10]] as const) {
    const f = await fixture(width, height)
    const answer = f.io.approve(request, new AbortController().signal)
    await arm(f.frame)
    for (const id of ['vivi-deny', 'vivi-approve']) {
      const button = f.node(id)
      expect(button.y).toBeGreaterThanOrEqual(0)
      expect(button.y + button.height).toBeLessThanOrEqual(height)
      expect(button.x + button.width).toBeLessThanOrEqual(width)
    }
    await f.click('vivi-deny')
    expect(await answer).toBe(false)
    const line = f.io.readLine('Message')
    await f.frame()
    expect(f.node('vivi-header').height).toBe(1)
    expect(f.node('vivi-tokens').y).toBeLessThan(f.node('vivi-transcript').y)
    f.io.close()
    expect(await line).toBeUndefined()
  }
})


test('a slow repeat within OpenTUI’s 500ms double-click window cannot approve the next request', async () => {
  const f = await fixture()
  const first = f.io.approve(request, new AbortController().signal)
  let next: Promise<boolean> | undefined
  void first.then(() => { next = f.io.approve({ ...request, description: 'Second slow-click request' }, new AbortController().signal) })
  await arm(f.frame)
  await f.click('vivi-approve')
  expect(await first).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 450))
  await f.frame()
  await f.click('vivi-approve')
  await watch(next!)()
  f.input.pressEnter()
  expect(await next).toBe(false)
})


test('leaving terminal focus interrupts approval gestures and resets keyboard selection to Deny', async () => {
  const f = await fixture()
  const answer = f.io.approve(request, new AbortController().signal)
  const pending = watch(answer)
  await arm(f.frame)
  f.input.pressArrow('right')
  await f.frame()
  const yes = f.node('vivi-approve')
  await f.mouse.pressDown(yes.x + 1, yes.y)
  f.setup.renderer.stdin.emit('data', Buffer.from('\x1b[O\x1b[I'))
  await f.frame()
  await f.mouse.release(yes.x + 1, yes.y)
  await pending()
  expect(await f.frame()).toContain('› Deny')
  f.input.pressEnter()
  expect(await answer).toBe(false)
})


async function pauseNativeFrame(setup: TestRendererSetup): Promise<() => Promise<void>> {
  let unblock!: () => void, started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  const callback = async () => { started(); await blocked }
  setup.renderer.setFrameCallback(callback)
  const rendering = setup.renderOnce()
  await entered
  return async () => { unblock(); await rendering; setup.renderer.removeFrameCallback(callback) }
}

test('approval requires a completed native frame, not merely an incremented frame ID', async () => {
  const f = await fixture()
  const answer = f.io.approve(request, new AbortController().signal)
  await tick()
  const resume = await pauseNativeFrame(f.setup)
  try {
    f.input.pressArrow('right'); f.input.pressEnter()
    await watch(answer)()
  } finally { await resume() }
  f.input.pressArrow('right'); f.input.pressEnter()
  expect(await answer).toBe(true)
})

test('stale model cells cannot activate while the updated filter frame is still rendering', async () => {
  const f = await fixture()
  const choices = Array.from({ length: 30 }, (_, value) => ({ name: `model-${value}`, value: { value } }))
  const answer = f.io.chooseSearchable('Filter frame race', choices)
  await f.frame()
  const picker = f.node('vivi-picker')
  const x = picker.x + 3, y = picker.y
  await f.input.typeText('model-29')
  const resume = await pauseNativeFrame(f.setup)
  try {
    await f.mouse.click(x, y)
    await watch(answer)()
  } finally { await resume() }
  await f.frame()
  await f.mouse.click(picker.x + 3, picker.y)
  expect(await answer).toEqual({ kind: 'selected', value: choices[29]!.value, query: 'model-29' })
})


test('compact workspace choices render selectable rows on first open and after a native resize', async () => {
  for (const [width, height] of [[30, 8], [40, 9]] as const) for (const resize of [false, true]) {
    const f = await fixture(resize ? 100 : width, resize ? 30 : height)
    f.io.setWorkspace('/fixture/project')
    const answer = f.io.choose('Menu', [
      { name: 'First', description: 'Description', value: 0 },
      { name: 'Second', description: 'Description', value: 1 }
    ])
    await f.frame()
    if (resize) f.setup.resize(width, height)
    let display = await f.frame()
    expect(display).toContain('First')
    expect((f.node('vivi-picker') as SelectRenderable).showDescription).toBe(height > 8)
    expect(f.node('vivi-picker').height).toBeGreaterThan(0)
    expect(f.node('vivi-workspace').y + f.node('vivi-workspace').height).toBeLessThanOrEqual(height)
    f.input.pressArrow('down'); display = await f.frame(); expect(display).toContain('Second')
    f.input.pressEnter(); expect(await answer).toBe(1)
    const line = f.io.readLine('Message'); await f.frame()
    expect(f.node('vivi-composer-box').y + f.node('vivi-composer-box').height).toBeLessThanOrEqual(height)
    expect(f.node('vivi-workspace').y + f.node('vivi-workspace').height).toBeLessThanOrEqual(height)
    f.input.pressEnter(); expect(await line).toBe('')
  }
})


test('choice resize budgets the planned header rows before Yoga settles', async () => {
  const f = await fixture(160, 30)
  f.io.setWorkspace('/fixture/project')
  const answer = f.io.choose('Menu', Array.from({ length: 10 }, (_, index) =>
    ({ name: `Option ${index}`, description: 'Description', value: index })))
  await f.frame()
  for (const height of [14, 15, 16]) {
    f.setup.resize(40, height)
    await f.setup.renderOnce()
    const display = f.setup.captureCharFrame()
    expect(display).toContain('Option 0')
    expect(display).toContain('Workspace:')
    expect(display).toContain('↑/↓ select')
    const hints = f.node('vivi-hints')
    expect(hints.y + hints.height).toBeLessThanOrEqual(height)
    expect(f.node('vivi-workspace').y + f.node('vivi-workspace').height).toBeLessThanOrEqual(height)
    f.setup.resize(160, 30); await f.frame()
  }
  f.input.pressEnter(); expect(await answer).toBe(0)
})
