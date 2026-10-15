// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { createTestRenderer } from '@opentui/core/testing'
import { TextareaRenderable } from '@opentui/core'
import { OpenTuiIO, getSlashCommandCompletions } from '../src/tui.js'
const instances: OpenTuiIO[] = []
afterEach(() => { for (const io of instances.splice(0)) io.close() })
async function fixture() {
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer); instances.push(io)
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  return { io, setup, frame }
}
test('skills completion and native action button have keyboard/mouse parity without bypassing a draft', async () => {
  expect(getSlashCommandCompletions('/sk').map(item => item.command)).toEqual(['/skills'])
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.frame()
  const button = f.setup.renderer.root.findDescendantById('vivi-action-skills')!
  await f.setup.mockMouse.click(button.x + 1, button.y)
  expect(await reading).toBe('/skills')
  const next = f.io.readLine('Message')
  await f.setup.mockInput.typeText('Unsent text'); await f.frame()
  await f.setup.mockMouse.click(button.x + 1, button.y)
  const composer = f.setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  expect(composer.plainText).toBe('Unsent text')
  f.setup.mockInput.pressEnter(); expect(await next).toBe('Unsent text')
})
test('creation request returns as editable composer text and requires fresh send', async () => {
  const f = await fixture()
  const prompt = 'Use the bundled skill-creator to draft a normal SKILL.md\nShow the draft for manual saving'
  f.io.setComposerDraft(prompt)
  const reading = f.io.readLine('Message'); let sent = false
  void reading.then(() => { sent = true })
  await f.frame(); expect(sent).toBe(false)
  const composer = f.setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  expect(composer.plainText).toBe(prompt)
  await f.setup.mockInput.typeText(' and keep it concise')
  f.setup.mockInput.pressEnter(); expect(await reading).toBe(`${prompt} and keep it concise`)
  const next = f.io.readLine('Message'); await f.frame(); expect(composer.plainText).toBe('')
  f.io.close(); expect(await next).toBeUndefined()
})
test('40-column footer retains compact hints rather than clipping fixed action buttons', async () => {
  const setup = await createTestRenderer({ width: 40, height: 24, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' });
  const io = new OpenTuiIO(setup.renderer); instances.push(io);
  const reading = io.readLine('Message');
  await setup.renderOnce(); await setup.renderOnce();
  expect(setup.renderer.root.findDescendantById('vivi-actions')!.visible).toBe(false);
  expect(setup.captureCharFrame()).toContain('Enter send');
  io.close(); expect(await reading).toBeUndefined();
});



test('native Save skill review shows exact text, defaults to deny and requires an explicit save click', async () => {
  const f = await fixture()
  const request = { call: { id: 'native-save-skill', name: 'save_skill', arguments: { name: 'brief-summary', content: 'Exact reviewed SKILL.md', expectedRevision: null } },
    currentRevision: 'new installed skill', description: 'After exact source: "Exact reviewed SKILL.md"\nAvailable next turn' }
  const denied = f.io.approve(request, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 2))
  const first = await f.frame()
  expect(first).toContain('Save skill?')
  expect(first).toContain('Exact reviewed SKILL.md')
  f.setup.mockInput.pressEnter()
  expect(await denied).toBe(false)
  const saving = f.io.approve({ ...request, call: { ...request.call, id: 'native-save-skill-2' } }, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 2))
  await f.frame()
  const save = f.setup.renderer.root.findDescendantById('vivi-approve')!
  await f.setup.mockMouse.click(save.x + 1, save.y)
  expect(await saving).toBe(true)
})
