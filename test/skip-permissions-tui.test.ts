// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { TextareaRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { CliHost } from '../src/host.js'
import { OpenTuiIO, SLASH_COMMANDS } from '../src/tui.js'
import { newSession } from '../src/session.js'
import { runModeControl, selectApprovalMode } from '../src/terminal.js'

const active: { io: OpenTuiIO; host: CliHost }[] = []
afterEach(async () => { for (const { io, host } of active.splice(0)) { io.close(); await host.shutdown() } })
async function fixture(width = 120) {
  const setup = await createTestRenderer({ width, height: 35, kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  Object.defineProperty(io, 'canAutoReview', { get: () => !io.isClosed })
  const host = new CliHost({ session: newSession({ provider: 'openai', model: 'offline-skip' }), store: { async save() {} },
    permissionApproval: { isAvailable: () => !io.isClosed, accountRevision: () => 'offline-chat-account' },
    provider: { async generate() { throw new Error('Mode selection never calls a model') } } })
  active.push({ io, host }); io.setSession(host.session)
  const frame = async () => { await setup.flush(); await setup.renderOnce(); return setup.captureCharFrame() }
  const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 0)); await frame()
    // A newly drawn approval arms only after its input batch drains.
    await new Promise(resolve => setTimeout(resolve, 0)); return frame()
  }
  return { setup, io, host, frame, settle, input: setup.mockInput }
}

test('native Skip confirmation has honest label and cancel default, then explicit allow enables session-only Skip', async () => {
  const f = await fixture()
  const denied = runModeControl(f.host, f.io, '/mode skip')
  const warning = await f.settle()
  expect(warning).toContain('Enable Skip permissions?')
  expect(warning).toContain('Cancel')
  f.input.pressEnter(); await denied
  expect(f.host.approvalMode).toBe('manual')
  const enrolled = runModeControl(f.host, f.io, '/mode skip')
  await f.settle(); f.input.pressArrow('right'); f.input.pressEnter(); await enrolled
  expect(f.host.approvalMode).toBe('skip')
  const result = await f.frame()
  expect(result).toContain('Skip permissions')
  expect(result).not.toContain('Auto review:')
  expect(result).not.toContain('model estimate')
})

test('native picker selects Skip deliberately and cancelling from Plan preserves policy and an unsent draft', async () => {
  const f = await fixture(60)
  f.host.setTaskMode('plan'); f.io.setTaskMode('plan')
  const reading = f.io.readLine('Message'); await f.input.typeText('Keep the unsent plan'); await f.frame()
  f.input.pressTab({ shift: true }); expect(await reading).toBe('/mode cycle')
  const choosing = selectApprovalMode(f.host, f.io, (title, choices, index) => f.io.choose(title, choices, index))
  await f.frame(); f.input.pressArrow('up'); f.input.pressEnter()
  await f.settle(); f.input.pressEscape(); await choosing
  expect(f.host.taskMode).toBe('plan'); expect(f.host.approvalMode).toBe('manual')
  const next = f.io.readLine('Message'); await f.frame()
  expect((f.setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable).plainText).toBe('Keep the unsent plan')
  f.input.pressEnter(); expect(await next).toBe('Keep the unsent plan')
})

test('ChatGPT session header identifies plan use and its safe registration label; account and usage controls are discoverable', async () => {
  const f = await fixture(180)
  f.io.setSession(newSession({ provider: 'chatgpt', model: 'account-model', chatgptAccountId: 'a'.repeat(64) }))
  const frame = await f.frame()
  expect(frame).toContain('Using ChatGPT plan')
  expect(frame).toContain('account aaaaaaaaaaaa')
  expect(SLASH_COMMANDS.some(item => item.command === '/account')).toBe(true)
  expect(SLASH_COMMANDS.some(item => item.command === '/usage')).toBe(true)
})
