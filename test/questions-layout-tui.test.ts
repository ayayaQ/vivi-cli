// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import type { Renderable, TextareaRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'

const fixtures: OpenTuiIO[] = []
afterEach(() => { for (const io of fixtures.splice(0)) io.close() })
const questions = [{ id: 'next', header: 'Next step',
  question: "One thing to flag up front: I can't take or view a screenshot. Given that, how do you want to debug vivi-cli with me?",
  options: [
    { id: 'inspect', label: 'Inspect the code with me', description: "I read vivi-cli's files in the workspace and hunt for the likely bug from the code itself." },
    { id: 'run', label: 'Run it, capture text output', description: 'Work from stdout/stderr and any log file instead of a picture. Every run needs fresh approval.' },
    { id: 'paste', label: 'You screenshot, I work from pasted text', description: 'You keep the screenshot; paste the error text, two lines, or a description of what looked wrong.' }
  ] }, { id: 'look', header: 'What looked off', question: 'What did you actually see that looked off?', options: [
    { id: 'layout', label: 'Rendering / layout', description: 'Misaligned, clipped, overlapping, wrong colors or glyphs' },
    { id: 'crash', label: 'An error or crash', description: 'A stack trace, non-zero exit code, failed assertion, or a hang' }
  ] }]
async function fixture(width: number, height: number) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer); fixtures.push(io)
  const node = (id: string): Renderable => {
    const found = setup.renderer.root.findDescendantById(id)
    if (!found) throw new Error(`Missing ${id}`)
    return found
  }
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const click = async (id: string) => { const target = node(id); await setup.mockMouse.click(target.x + 1, target.y) }
  return { setup, io, node, frame, click }
}

function expectLayout(f: Awaited<ReturnType<typeof fixture>>, frame: string, height: number) {
  for (const child of f.node('vivi-root').getChildren().filter(child => child.visible)) {
    expect(child.y + child.height).toBeLessThanOrEqual(height)
  }
  const box = f.node('vivi-questions'), actions = f.node('vivi-question-actions')
  for (const child of box.getChildren().filter(child => child.visible)) {
    expect(child.y).toBeGreaterThanOrEqual(box.y + 1)
    expect(child.y + child.height).toBeLessThanOrEqual(box.y + box.height - 1)
  }
  for (const name of ['prev', 'next', 'skip', 'submit', 'cancel']) {
    const button = f.node(`vivi-question-${name}`)
    expect(button.x).toBeGreaterThanOrEqual(box.x + 1)
    expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width - 1)
    expect(button.y).toBe(actions.y)
  }
  const choices = f.node('vivi-question-choices')
  if (choices.visible) {
    const other = f.node('vivi-question-other')
    expect(other.y + other.height).toBeLessThanOrEqual(actions.y)
  }
  expect(box.y + box.height).toBeLessThanOrEqual(height)
  const model = f.node('vivi-model')
  if (model.visible) {
    expect(box.y + box.height).toBeLessThanOrEqual(model.y)
    expect(frame.split('\n')[model.y]).not.toMatch(/Prev|Next|Skip|Submit|Cancel/)
  }
  expect(frame.split('\n')[box.y + box.height - 1]).toMatch(/^└.*┘$/)
  expect(frame.split('\n')[actions.y]).toMatch(/Skip\s+›?Submit\s+Cancel/)
}

test('question actions stay inside their border and never paint onto the model/footer rows', async () => {
  for (const workspace of [false, true]) for (const [width, height] of [[268, 32], [100, 30], [40, 16], [40, 15], [32, 14], [32, 12]] as const) {
    const f = await fixture(width, height)
    if (workspace) f.io.setWorkspace('/offline-fixture')
    const controller = new AbortController(), answer = f.io.askQuestions({ requestId: 'layout', callId: 'layout', questions }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 2))
    expectLayout(f, await f.frame(), height)
    controller.abort(); await answer; f.io.close()
  }
})


test('question geometry and multiline drafts survive first render, keyboard selection, paging and resize', async () => {
  const f = await fixture(100, 30)
  f.io.setWorkspace('/offline-fixture')
  const answer = f.io.askQuestions({ requestId: 'resize', callId: 'resize', questions }, new AbortController().signal)
  await f.frame()
  await new Promise(resolve => setTimeout(resolve, 2))
  expectLayout(f, await f.frame(), 30)
  f.setup.mockInput.pressEnter()
  const selected = await f.frame()
  expect(selected).toContain('1/2 ready')
  expectLayout(f, selected, 30)
  await f.click('vivi-question-next')
  expectLayout(f, await f.frame(), 30)
  await f.click('vivi-question-other')
  await f.setup.mockInput.pasteBracketedText('日本語 🙂 café\nsecond\nthird')
  for (const [width, height] of [[32, 12], [268, 32], [40, 16], [32, 14], [100, 30]] as const) {
    f.setup.resize(width, height)
    expectLayout(f, await f.frame(), height)
    expect((f.node('vivi-question-editor') as TextareaRenderable).plainText).toBe('日本語 🙂 café\nsecond\nthird')
  }
  f.setup.mockInput.pressEnter()
  expectLayout(f, await f.frame(), 30)
  await f.click('vivi-question-prev')
  expectLayout(f, await f.frame(), 30)
  await f.click('vivi-question-next')
  expectLayout(f, await f.frame(), 30)
  await f.click('vivi-question-submit')
  expect(await answer).toEqual({ requestId: 'resize', status: 'answered', answers: [
    { id: 'next', answer: { kind: 'option', optionId: 'inspect' } },
    { id: 'look', answer: { kind: 'text', text: '日本語 🙂 café\nsecond\nthird' } }
  ] })
  await f.frame()
  expect(f.setup.renderer.root.findDescendantById('vivi-questions')).toBeUndefined()
})
