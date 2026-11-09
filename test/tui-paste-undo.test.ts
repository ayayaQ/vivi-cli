// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import type { TextareaRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import { newSession } from '../src/session.js'

const active: OpenTuiIO[] = []
afterEach(() => { for (const io of active.splice(0)) io.close() })
const pasted = 'Hidden draft 中文🙂 '.repeat(100)

async function fixture(promptHistory?: readonly string[]) {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer, { promptHistory }); active.push(io)
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce() }
  const undo = async () => { setup.mockInput.pressKey('-', { ctrl: true }); await frame() }
  const redo = async () => { setup.mockInput.pressKey('.', { ctrl: true }); await frame() }
  return { io, composer, frame, undo, redo, input: setup.mockInput }
}

test('undo and redo after Escape cannot restore an invisible cleared paste', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.input.pasteBracketedText(pasted)
  await f.input.typeText(' tail')
  f.input.pressEscape()
  await f.undo(); await f.undo(); await f.redo()
  expect(f.composer.plainText).toBe('')
  expect(f.composer.extmarks.getAll()).toHaveLength(0)
  f.input.pressEnter(); expect(await reading).toBe('')
})

test('exhausting a new prompt undo/redo history never restores the previous prompt paste', async () => {
  const f = await fixture(), first = f.io.readLine('Message')
  await f.input.pasteBracketedText(pasted)
  await f.input.typeText(' tail')
  f.input.pressEnter(); expect(await first).toBe(pasted + ' tail')
  const next = f.io.readLine('Message')
  await f.input.typeText('b')
  await f.undo(); await f.undo()
  expect(f.composer.plainText).toBe('')
  expect(f.composer.extmarks.getAll()).toHaveLength(0)
  await f.redo(); await f.redo()
  expect(f.composer.plainText).toBe('b')
  expect(f.composer.extmarks.getAll()).toHaveLength(0)
  f.input.pressEnter(); expect(await next).toBe('b')
})

test('fresh edits after Escape have their own undo history without reviving the cleared paste', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.input.pasteBracketedText(pasted)
  await f.input.typeText(' tail')
  f.input.pressEscape()
  await f.input.typeText('b')
  await f.undo(); await f.undo()
  expect(f.composer.plainText).toBe('')
  expect(f.composer.extmarks.getAll()).toHaveLength(0)
  await f.redo(); await f.redo()
  expect(f.composer.plainText).toBe('b')
  expect(f.composer.extmarks.getAll()).toHaveLength(0)
  f.input.pressEnter(); expect(await reading).toBe('b')
})

test('a stale extmark whose label is absent never supplies hidden text', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.input.pasteBracketedText(pasted)
  const [stale] = f.composer.extmarks.getAll()
  f.composer.setText('ordinary text')
  f.composer.extmarks.create({ ...stale! })
  f.input.pressEnter(); expect(await reading).toBe('ordinary text')
})

test('a replacement session cannot revive hidden text through undo', async () => {
  const f = await fixture()
  f.io.setSession(newSession({ provider: 'openai', model: 'fixture' }))
  const first = f.io.readLine('Message')
  await f.input.pasteBracketedText(pasted)
  await f.input.typeText(' tail')
  f.input.pressEnter(); expect(await first).toBe(pasted + ' tail')
  f.io.setSession(newSession({ provider: 'openai', model: 'replacement' }))
  const next = f.io.readLine('Message')
  await f.undo(); await f.redo()
  expect(f.composer.plainText).toBe('')
  expect(f.composer.extmarks.getAll()).toHaveLength(0)
  f.input.pressEnter(); expect(await next).toBe('')
})

test('undo at the history restoration boundary preserves the current collapsed draft', async () => {
  const f = await fixture(['previous prompt']), reading = f.io.readLine('Message')
  await f.input.pasteBracketedText(pasted)
  await f.input.typeText(' tail')
  f.input.pressArrow('up'); await f.frame()
  expect(f.composer.plainText).toBe('previous prompt')
  f.input.pressArrow('down'); await f.frame()
  const restored = f.composer.plainText
  await f.undo(); await f.redo()
  expect(f.composer.plainText).toBe(restored)
  expect(f.composer.extmarks.getAll()).toHaveLength(1)
  f.input.pressEnter(); expect(await reading).toBe(pasted + ' tail')
})

test('atomic deletion, insertion and expansion still undo and redo with their hidden contents', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.input.pasteBracketedText(pasted)
  await f.undo(); expect(f.composer.plainText).toBe('')
  await f.redo(); expect(f.composer.plainText).toContain('[Pasted Content')
  f.input.pressBackspace(); await f.frame()
  expect(f.composer.plainText).toBe('')
  await f.undo(); expect(f.composer.plainText).toContain('[Pasted Content')
  await f.input.pasteBracketedText(pasted)
  expect(f.composer.plainText).toBe(pasted)
  await f.undo(); expect(f.composer.plainText).toContain('[Pasted Content')
  await f.redo(); expect(f.composer.plainText).toBe(pasted)
  f.input.pressEnter(); expect(await reading).toBe(pasted)
})
