// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { TextareaRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'

const active: OpenTuiIO[] = []
afterEach(() => { for (const io of active.splice(0)) io.close() })
async function fixture(width = 100, height = 30) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer); active.push(io)
  const node = (id: string): Renderable => setup.renderer.root.findDescendantById(id)!
  const composer = node('vivi-composer') as TextareaRenderable
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  return { io, setup, node, composer, frame, input: setup.mockInput }
}

test('composer grows for newlines, shrinks after edits and keeps native undo and submit semantics', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.frame()
  expect(f.composer.height).toBe(2)
  for (const text of ['first', 'second', 'third', 'fourth']) {
    await f.input.typeText(text); f.input.pressKey('j', { ctrl: true })
  }
  await f.frame()
  expect(f.composer.plainText).toBe('first\nsecond\nthird\nfourth\n')
  expect(f.composer.height).toBe(5)
  expect(f.node('vivi-composer-box').height).toBe(7)
  expect(f.node('vivi-transcript').height).toBeGreaterThan(1)
  f.input.pressKey('-', { ctrl: true }); await f.frame()
  expect(f.composer.height).toBe(4)
  f.input.pressKey('.', { ctrl: true }); await f.frame()
  expect(f.composer.height).toBe(5)
  for (let i = 0; i < f.composer.plainText.length; i++) f.input.pressArrow('left', { shift: true })
  f.input.pressBackspace()
  await f.frame(); expect(f.composer.height).toBe(2)
  f.input.pressEnter(); expect(await reading).toBe('')
  await f.frame(); expect(f.composer.height).toBe(2)
})

test('composer measures wrapped Unicode cells and reflows height when the terminal resizes', async () => {
  const f = await fixture(80, 30), reading = f.io.readLine('Message')
  await f.frame(); await f.input.typeText('🙂中文 word '.repeat(18))
  await f.frame()
  const wide = f.composer.height
  expect(wide).toBeGreaterThan(2)
  f.setup.resize(40, 30); await f.frame()
  expect(f.composer.height).toBeGreaterThan(wide)
  f.setup.resize(120, 30); await f.frame()
  expect(f.composer.height).toBeLessThan(wide)
  const value = f.composer.plainText
  f.input.pressEnter(); expect(await reading).toBe(value)
})

test('large multiline drafts stay bounded, keep the last line editable and fit compact resize', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.frame(); await f.input.pasteBracketedText(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'))
  await f.frame()
  expect(f.composer.height).toBe(10)
  expect(f.composer.scrollY).toBeGreaterThan(0)
  await f.input.typeText(' tail')
  for (const [width, height] of [[40, 12], [80, 20], [100, 30]] as const) {
    f.setup.resize(width, height); await f.frame()
    const box = f.node('vivi-composer-box')
    expect(box.y + box.height).toBeLessThanOrEqual(height)
    expect(f.node('vivi-transcript').height).toBeGreaterThan(0)
    expect(f.composer.height).toBeLessThanOrEqual(10)
    expect(f.composer.height).toBeGreaterThan(0)
  }
  f.input.pressEnter(); expect((await reading)?.endsWith('line 99 tail')).toBe(true)
})

test('chat actions replace the shortcut footer below the composer and keep mouse and keyboard paths', async () => {
  const f = await fixture(), first = f.io.readLine('Message')
  const display = await f.frame(), actions = f.node('vivi-actions'), box = f.node('vivi-composer-box')
  expect(actions.visible).toBe(true)
  expect(actions.y).toBe(box.y + box.height)
  expect(actions.y + actions.height).toBeLessThanOrEqual(30)
  expect(f.node('vivi-hints').visible).toBe(false)
  expect(display).toContain('Menu  Models')
  expect(display).not.toContain('Enter send')
  const menu = f.node('vivi-action-menu')
  await f.setup.mockMouse.click(menu.x + 1, menu.y)
  expect(await first).toBe('/menu')
  const second = f.io.readLine('Message'); await f.frame()
  f.input.pressKey('p', { ctrl: true }); expect(await second).toBe('/menu')
  const third = f.io.readLine('Message'); await f.frame(); await f.input.typeText('draft')
  const models = f.node('vivi-action-models'); await f.setup.mockMouse.click(models.x + 1, models.y)
  expect(f.composer.plainText).toBe('draft')
  f.input.pressEnter(); expect(await third).toBe('draft')
})

test('footer actions leave completion and modal controls visible at small sizes', async () => {
  const f = await fixture(40, 12), reading = f.io.readLine('Message')
  await f.input.typeText('/m'); const display = await f.frame()
  expect(f.node('vivi-actions').visible).toBe(false)
  expect(f.node('vivi-hints').visible).toBe(true)
  expect(display).toContain('/models')
  expect(f.node('vivi-composer-box').y + f.node('vivi-composer-box').height).toBeLessThanOrEqual(12)
  f.input.pressEscape(); f.input.pressEnter(); expect(await reading).toBe('')
  const choosing = f.io.choose('Choose', [{ name: 'Back', value: false }]); await f.frame()
  expect(f.node('vivi-actions').visible).toBe(false)
  expect(f.node('vivi-hints').visible).toBe(true)
  f.input.pressEnter(); expect(await choosing).toBe(false)
})
