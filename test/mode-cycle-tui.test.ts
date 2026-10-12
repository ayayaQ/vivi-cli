// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { TextareaRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import { WindowsInputDecoder } from '../src/windows-input.js'

const active: OpenTuiIO[] = []
afterEach(() => { for (const io of active.splice(0)) io.close() })
async function fixture(kittyKeyboard = true) {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer); active.push(io)
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce() }
  return { io, setup, composer, frame, input: setup.mockInput }
}

test('Shift+Tab cycles from an idle draft and restores it after a cancelled dialog', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.input.typeText('Unsent draft'); await f.frame()
  f.input.pressTab({ shift: true })
  expect(await reading).toBe('/mode cycle')
  const choosing = f.io.choose('Mode', [{ name: 'Cancel', value: false }]); await f.frame()
  f.input.pressEscape(); expect(await choosing).toBeUndefined()
  const next = f.io.readLine('Message'); await f.frame()
  expect(f.composer.plainText).toBe('Unsent draft')
  f.input.pressEnter(); expect(await next).toBe('Unsent draft')
})

test('plain Tab completes slash input; Shift+Tab preserves the original completion draft', async () => {
  const f = await fixture(), first = f.io.readLine('Message')
  await f.input.typeText('/m'); await f.frame()
  f.input.pressTab(); expect(f.composer.plainText).toBe('/models')
  f.input.pressTab({ shift: true }); expect(await first).toBe('/mode cycle')
  const next = f.io.readLine('Message'); await f.frame()
  expect(f.composer.plainText).toBe('/models')
  f.input.pressEnter(); expect(await next).toBe('/models')
})

test('legacy CSI backtab and translated Windows Shift+Tab use the same idle shortcut', async () => {
  for (const encoding of ['\x1b[Z', new WindowsInputDecoder().write('\x1b[9;0;9;1;16;1_')]) {
    const f = await fixture(false), reading = f.io.readLine('Message'); await f.frame()
    f.setup.renderer.stdin.emit('data', Buffer.from(encoding))
    expect(await reading).toBe('/mode cycle')
  }
})

test('repeated and extra-modified backtabs cannot trigger a cycle', async () => {
  const f = await fixture(), reading = f.io.readLine('Message'); await f.frame()
  let settled = false; void reading.then(() => { settled = true })
  f.setup.renderer.keyInput.emit('keypress', { name: 'tab', shift: true, repeated: true,
    eventType: 'repeat', ctrl: false, meta: false, super: false, hyper: false,
    preventDefault() {}, stopPropagation() {} })
  f.input.pressTab({ shift: true, ctrl: true }); await Promise.resolve()
  expect(settled).toBe(false)
  f.input.pressEnter(); expect(await reading).toBe('')
})

test('active turn and cancellation lock suppress the idle shortcut', async () => {
  const f = await fixture(), reading = f.io.readLine('Message'); await f.frame()
  let settled = false; void reading.then(() => { settled = true })
  const dispose = f.io.onCancel(() => {})
  f.io.runStarted(); f.input.pressTab({ shift: true }); await Promise.resolve()
  expect(settled).toBe(false)
  f.io.runFinished('completed'); dispose()
  f.input.pressTab({ shift: true }); expect(await reading).toBe('/mode cycle')
})

test('approval and search dialogs retain their own Shift+Tab behavior', async () => {
  const f = await fixture(), approving = f.io.approve({ call: { id: 'offline', name: 'note_set',
    arguments: {} }, currentRevision: 0, description: 'Offline approval' }, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 3)); await f.frame()
  f.input.pressTab({ shift: true }); f.input.pressTab({ shift: true })
  f.input.pressEnter(); expect(await approving).toBe(false)
  const choosing = f.io.chooseSearchable('Models', [{ name: 'A', value: 'a' }]); await f.frame()
  f.input.pressTab({ shift: true }); f.input.pressEnter()
  expect((await choosing)?.kind).toBe('selected')
})
