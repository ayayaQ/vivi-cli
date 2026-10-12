// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { TextareaRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { CliHost } from '../src/host.js'
import { OpenTuiIO } from '../src/tui.js'
import { newSession } from '../src/session.js'
import { cycleApprovalMode, selectApprovalMode } from '../src/terminal.js'

const active: { io: OpenTuiIO; host: CliHost }[] = []
afterEach(async () => { for (const { io, host } of active.splice(0)) { io.close(); await host.shutdown() } })
async function fixture(width = 100) {
  const setup = await createTestRenderer({ width, height: 30, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  // Explicit offline approval surface, never an account or physical terminal.
  Object.defineProperty(io, 'canAutoReview', { get: () => !io.isClosed })
  const host = new CliHost({ session: newSession({ provider: 'openai', model: 'offline' }),
    store: { async save() {}, async load() { throw new Error('No resume in fixture') } },
    provider: { async generate() { throw new Error('Mode controls must not call a model') } },
    decisionReview: { canAutoReview: true, accountRevision: () => 'offline', ledger: { async upsert() {} },
      provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { throw new Error('No decision model in fixture') } } } })
  active.push({ io, host }); io.setSession(host.session)
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  return { io, host, setup, composer, frame, input: setup.mockInput }
}

test('native idle Shift+Tab cycles Manual -> enrolled Auto -> Plan -> Manual and preserves an unfinished draft', async () => {
  const f = await fixture(), first = f.io.readLine('Message')
  await f.input.typeText('Unsent planning draft'); await f.frame()
  f.input.pressTab({ shift: true }); expect(await first).toBe('/mode cycle')
  const enrolling = cycleApprovalMode(f.host, f.io)
  await new Promise(resolve => setTimeout(resolve, 3)); await f.frame()
  expect(f.host.approvalMode).toBe('manual')
  f.input.pressArrow('right'); f.input.pressEnter(); await enrolling
  expect(f.host.approvalMode).toBe('auto'); expect(await f.frame()).toContain('Auto review')
  for (const expected of ['plan', 'execute']) {
    const reading = f.io.readLine('Message'); await f.frame()
    expect(f.composer.plainText).toBe('Unsent planning draft')
    f.input.pressTab({ shift: true }); expect(await reading).toBe('/mode cycle')
    await cycleApprovalMode(f.host, f.io)
    expect(f.host.taskMode).toBe(expected); expect(f.host.approvalMode).toBe('manual')
    expect(await f.frame()).toContain(expected === 'plan' ? 'reasoning default · Plan' : 'reasoning default · Manual')
  }
  const last = f.io.readLine('Message'); await f.frame()
  expect(f.composer.plainText).toBe('Unsent planning draft')
  f.input.pressEnter(); expect(await last).toBe('Unsent planning draft')
})

test('native mode picker selects Plan without any approval dialog, and cancelling a later picker preserves it', async () => {
  const f = await fixture(48)
  const choosing = selectApprovalMode(f.host, f.io, (title, choices, index) => f.io.choose(title, choices, index))
  await f.frame(); f.input.pressArrow('down'); f.input.pressArrow('down'); f.input.pressEnter(); await choosing
  expect(f.host.taskMode).toBe('plan'); expect(await f.frame()).toContain('Plan')
  const cancelling = selectApprovalMode(f.host, f.io, (title, choices, index) => f.io.choose(title, choices, index))
  await f.frame(); f.input.pressEscape(); await cancelling
  expect(f.host.taskMode).toBe('plan'); expect(await f.frame()).toContain('Plan')
})

test('closing the native mode picker leaves the current Plan policy in force', async () => {
  const f = await fixture()
  f.host.setTaskMode('plan'); f.io.setTaskMode('plan')
  const choosing = selectApprovalMode(f.host, f.io, (title, choices, index) => f.io.choose(title, choices, index))
  await f.frame(); f.io.close(); await choosing
  expect(f.host.taskMode).toBe('plan'); expect(f.host.approvalMode).toBe('manual')
})

test('denying, cancelling and closing Auto enrollment from Plan keep Plan and preserve the idle draft', async () => {
  for (const outcome of ['deny', 'cancel', 'close'] as const) {
    const f = await fixture()
    f.host.setTaskMode('plan'); f.io.setTaskMode('plan')
    const reading = f.io.readLine('Message'); await f.input.typeText('Keep this planning draft'); await f.frame()
    f.input.pressTab({ shift: true }); expect(await reading).toBe('/mode cycle')
    // Explicit picker choice, not Shift+Tab's Plan -> Manual transition.
    const choosing = selectApprovalMode(f.host, f.io, (title, choices, index) => f.io.choose(title, choices, index))
    await f.frame(); f.input.pressArrow('up'); f.input.pressEnter()
    await new Promise(resolve => setTimeout(resolve, 3)); await f.frame()
    expect(f.host.taskMode).toBe('plan'); expect(f.host.approvalMode).toBe('manual')
    // Complete the approval input-drain tick and a fresh frame before any
    // gesture; the picker Return cannot count as enrollment confirmation.
    await new Promise(resolve => setTimeout(resolve, 3)); await f.frame()
    if (outcome === 'deny') f.input.pressEnter()
    else if (outcome === 'cancel') f.input.pressEscape()
    else f.io.close()
    await choosing
    expect(f.host.taskMode).toBe('plan'); expect(f.host.approvalMode).toBe('manual')
    if (outcome !== 'close') {
      const next = f.io.readLine('Message'); await f.frame()
      expect((f.setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable).plainText).toBe('Keep this planning draft')
      f.input.pressEnter(); expect(await next).toBe('Keep this planning draft')
    }
  }
})
