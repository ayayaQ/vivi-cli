// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import type { TextareaRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenTuiIO } from '../src/tui.js'
import type { OpenTuiOptions } from '../src/tui.js'
import { PromptHistoryStore } from '../src/prompt-history.js'
import { newSession } from '../src/session.js'

const active: OpenTuiIO[] = []
afterEach(() => { for (const io of active.splice(0)) io.close() })
async function fixture(promptHistory: string[] = [], options: OpenTuiOptions = {}) {
  const setup = await createTestRenderer({ width: 80, height: 30, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer, { promptHistory, ...options }); active.push(io)
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce() }
  return { io, composer, input: setup.mockInput, frame }
}

test('Up/Down recalls submissions across conversations and workspaces and restores the draft and cursor', async () => {
  const f = await fixture(['older'])
  const first = f.io.readLine('Message'); await f.frame()
  await f.input.typeText('latest'); f.input.pressEnter(); expect(await first).toBe('latest')
  f.io.setSession(newSession({ provider: 'openai', model: 'other model' }))
  f.io.setWorkspace('C:/another-workspace')
  const next = f.io.readLine('Message'); await f.frame()
  await f.input.pasteBracketedText('draft 🙂中文'); f.input.pressArrow('left'); f.input.pressArrow('left')
  const cursor = f.composer.cursorOffset
  f.input.pressArrow('up'); expect(f.composer.plainText).toBe('latest')
  await f.input.typeText(' edited')
  f.input.pressArrow('up'); expect(f.composer.plainText).toBe('older')
  f.input.pressArrow('up'); expect(f.composer.plainText).toBe('older')
  f.input.pressArrow('down'); expect(f.composer.plainText).toBe('latest edited')
  f.input.pressArrow('down'); expect(f.composer.plainText).toBe('draft 🙂中文')
  expect(f.composer.cursorOffset).toBe(cursor)
  f.input.pressEnter(); expect(await next).toBe('draft 🙂中文')
})

test('multiline and wrapped arrows move normally until the first/last visual row', async () => {
  const f = await fixture(['previous'])
  const reading = f.io.readLine('Message'); await f.frame()
  const draft = 'long wrapped text '.repeat(12) + '\nlast'
  await f.input.pasteBracketedText(draft); await f.frame()
  f.input.pressArrow('up'); expect(f.composer.plainText).toBe(draft)
  expect(f.composer.visualCursor.visualRow).toBeGreaterThan(0)
  while (f.composer.visualCursor.visualRow > 0) f.input.pressArrow('up')
  f.input.pressArrow('up'); expect(f.composer.plainText).toBe('previous')
  f.input.pressArrow('down'); expect(f.composer.plainText).toBe(draft)
  f.input.pressArrow('down'); expect(f.composer.plainText).toBe(draft)
  f.input.pressEnter(); expect(await reading).toBe(draft)
})

test('slash completion keeps arrow priority and recalled commands remain browsable and require Enter', async () => {
  const f = await fixture(['older', '/help'])
  const reading = f.io.readLine('Message'); await f.frame()
  await f.input.typeText('/m'); await f.frame()
  f.input.pressArrow('up'); expect(f.composer.plainText).toBe('/m')
  f.input.pressEscape()
  f.input.pressArrow('up'); expect(f.composer.plainText).toBe('/help')
  f.input.pressArrow('up'); expect(f.composer.plainText).toBe('older')
  f.input.pressArrow('down'); expect(f.composer.plainText).toBe('/help')
  f.input.pressEnter(); expect(await reading).toBe('/help')
})

test('setup and secret dialogs cannot recall or contribute prompt history; cancelled drafts are excluded', async () => {
  const f = await fixture(['real prompt'])
  const setup = f.io.askText('Session name'); await f.frame()
  f.input.pressArrow('up'); expect(f.composer.plainText).toBe('')
  await f.input.typeText('private setup'); f.input.pressEnter(); expect(await setup).toBe('private setup')
  const secret = f.io.askSecret('API key'); await f.frame()
  f.input.pressArrow('up'); await f.input.typeText('test-hidden-key'); f.input.pressEnter()
  expect(await secret).toBe('test-hidden-key')
  const cancelled = f.io.readLine('Message'); await f.frame()
  await f.input.typeText('abandoned'); f.input.pressEscape()
  // Idle Escape clears the draft, keeping the composer available.
  f.input.pressEnter(); expect(await cancelled).toBe('')
  const reading = f.io.readLine('Message'); await f.frame()
  f.input.pressArrow('up'); expect(f.composer.plainText).toBe('real prompt')
  f.input.pressEnter(); expect(await reading).toBe('real prompt')
})

test('accepted steering submissions enter history while rejected submissions remain drafts', async () => {
  const f = await fixture(['idle prompt'])
  const cancel = f.io.onCancel(() => {})
  f.io.runStarted()
  let accept = true
  const stop = f.io.onSteering({ submit: () => accept, takeLast: () => undefined, clear: () => {} })
  await new Promise(resolve => setTimeout(resolve, 2)); await f.frame()
  await f.input.typeText('queued prompt'); f.input.pressEnter()
  f.input.pressArrow('up'); expect(f.composer.plainText).toBe('queued prompt')
  f.input.pressArrow('down'); expect(f.composer.plainText).toBe('')
  accept = false
  await f.input.typeText('rejected prompt'); f.input.pressEnter()
  expect(f.composer.plainText).toBe('rejected prompt')
  f.input.pressArrow('up'); expect(f.composer.plainText).toBe('queued prompt')
  f.input.pressArrow('down'); expect(f.composer.plainText).toBe('rejected prompt')
  stop(); cancel()
})

test('composer submissions persist for a later launch, with credentials redacted and dialog text excluded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-tui-history-'))
  try {
    const store = new PromptHistoryStore(directory)
    const f = await fixture([], { promptHistoryStore: store, secrets: ['fixture-secret'] })
    const dialog = f.io.askText('Name'); await f.frame()
    await f.input.typeText('dialog only'); f.input.pressEnter(); await dialog
    const reading = f.io.readLine('Message'); await f.frame()
    await f.input.pasteBracketedText('hello fixture-secret\n🙂中文')
    f.input.pressEnter(); await reading
    await store.drain(); f.io.close()
    const saved = await new PromptHistoryStore(directory).load()
    expect(saved).toHaveLength(1)
    expect(saved[0]).not.toContain('fixture-secret')
    expect(saved[0]).toContain('🙂中文')
    const next = await fixture(saved)
    const recall = next.io.readLine('Message'); await next.frame()
    next.input.pressArrow('up'); expect(next.composer.plainText).toBe(saved[0]!)
    next.input.pressEnter(); expect(await recall).toBe(saved[0]!)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a persistence failure leaves submissions and in-memory recall working', async () => {
  class UnavailableHistoryStore extends PromptHistoryStore {
    override async append(): Promise<void> { throw new Error('unavailable') }
  }
  const f = await fixture([], { promptHistoryStore: new UnavailableHistoryStore('.') })
  const reading = f.io.readLine('Message'); await f.frame()
  await f.input.typeText('still sent'); f.input.pressEnter(); expect(await reading).toBe('still sent')
  await f.frame()
  const next = f.io.readLine('Message'); await f.frame()
  f.input.pressArrow('up'); expect(f.composer.plainText).toBe('still sent')
  f.input.pressEnter(); expect(await next).toBe('still sent')
})
