// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { CliRenderEvents } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import { newSession } from '../src/session.js'

const active: OpenTuiIO[] = []
afterEach(() => { for (const io of active.splice(0)) io.close() })
async function fixture() {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const titles: string[] = []; let restores = 0
  const io = new OpenTuiIO(setup.renderer, { terminalTitle: { set(value) { titles.push(value) }, restore() { restores++ } } })
  active.push(io)
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce() }
  return { io, setup, titles, get restores() { return restores }, frame, input: setup.mockInput }
}

test('new, renamed and resumed session titles replace each other without provider/tool details', async () => {
  const f = await fixture(), session = newSession({ provider: 'openai', model: 'offline-model' })
  session.title = 'Fix login'; session.titleRevision = 1
  f.io.setSession(session); expect(f.titles.at(-1)).toBe('vivi · Fix login')
  session.title = 'Check startup'; session.titleRevision++
  f.io.setSession(session); expect(f.titles.at(-1)).toBe('vivi · Check startup')
  const resumed = newSession({ provider: 'openai', model: 'different-model' })
  resumed.title = 'Older session'; resumed.titleRevision = 1
  f.io.setSession(resumed); expect(f.titles.at(-1)).toBe('vivi · Older session')
  f.io.setDraft('openrouter'); expect(f.titles.at(-1)).toBe('vivi · Untitled conversation')
  expect(f.titles.join('\n')).not.toContain('model')
})

test('working, approval, cancellation and settled turn states use stable short prefixes', async () => {
  const f = await fixture(), reading = f.io.readLine('Message'); await f.frame()
  const dispose = f.io.onCancel(() => {})
  f.io.runStarted(); expect(f.titles.at(-1)).toBe('[~] vivi · Untitled conversation')
  const count = f.titles.length
  f.io.event({ type: 'text_delta', text: 'Private preview' }); await f.frame()
  expect(f.titles.length).toBe(count)
  const approving = f.io.approve({ call: { id: 'offline-title', name: 'note_set', arguments: { private: 'never-title' } },
    currentRevision: 0, description: 'Review exact action' }, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 3)); await f.frame()
  expect(f.titles.at(-1)).toBe('[!] vivi · Untitled conversation')
  f.input.pressEnter(); expect(await approving).toBe(false)
  expect(f.titles.at(-1)).toBe('[~] vivi · Untitled conversation')
  f.input.pressEscape(); expect(f.titles.at(-1)).toBe('[~] vivi · Untitled conversation')
  f.io.runFinished('cancelled'); dispose()
  expect(f.titles.at(-1)).toBe('vivi · Untitled conversation')
  expect(f.titles.join('\n')).not.toContain('never-title')
  expect(await reading).toBeUndefined()
})

test('setup dialogs show input-needed and closing or cancelling restores idle state', async () => {
  const f = await fixture()
  const choosing = f.io.choose('Private setup context', [{ name: 'Back', value: false }]); await f.frame()
  expect(f.titles.at(-1)).toBe('[!] vivi · Untitled conversation')
  f.input.pressEscape(); expect(await choosing).toBeUndefined()
  expect(f.titles.at(-1)).toBe('vivi · Untitled conversation')
  const text = f.io.askText('Model setting'); await f.frame()
  expect(f.titles.at(-1)).toBe('[!] vivi · Untitled conversation')
  f.input.pressEscape(); await text
  expect(f.titles.at(-1)).toBe('vivi · Untitled conversation')
  expect(f.titles.join('\n')).not.toContain('Private setup')
})

test('known credentials are redacted again when registered after the session title', async () => {
  const f = await fixture(), session = newSession({ provider: 'openai', model: 'offline' })
  session.title = 'Review fake-title-secret'; session.titleRevision = 1
  f.io.setSession(session); f.io.addSecrets(['fake-title-secret'])
  expect(f.titles.at(-1)).toBe('vivi · Review [REDACTED]')
})

test('completion and error settle without an active prefix; close and renderer failures restore once', async () => {
  for (const outcome of ['completed', 'error'] as const) {
    const f = await fixture(); f.io.runStarted(); f.io.runFinished(outcome)
    expect(f.titles.at(-1)).toBe('vivi · Untitled conversation')
  }
  for (const state of ['close', 'failure', 'destroy'] as const) {
    const f = await fixture(); f.io.runStarted()
    if (state === 'close') f.io.close()
    else if (state === 'failure') f.setup.renderer.emit(CliRenderEvents.RENDER_ERROR, { error: new Error('Offline failure') })
    else f.setup.renderer.destroy()
    f.io.close(); f.io.runFinished('error')
    await Promise.resolve()
    expect(f.restores).toBe(1)
  }
})
