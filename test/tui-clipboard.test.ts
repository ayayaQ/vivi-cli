// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { createClipboard, createRendererClipboardAdapter, TextareaRenderable } from '@opentui/core'
import type { HostClipboardService, HostClipboardWriteResult } from '@opentui/core'
import { createTestRenderer, setRendererCapabilities } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import { newSession } from '../src/session.js'

const active: OpenTuiIO[] = []
afterEach(() => { for (const io of active.splice(0)) io.close() })
async function fixture(options: { remote?: boolean; fail?: boolean; reject?: boolean; terminal?: boolean } = {}) {
  const setup = await createTestRenderer({ width: 100, height: 35, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  setRendererCapabilities(setup.renderer, { remote: options.remote ?? false, osc52_support: options.terminal === false ? 'unsupported' : 'supported' })
  const hostCopies: string[] = [], terminalCopies: string[] = []
  let disposed = false
  // Offline backends: these tests never read or change the machine's clipboard.
  const host: HostClipboardService = {
    maxWriteBytes: 1024 * 1024,
    read: async () => ({ status: 'unsupported' }), clear: async () => ({ status: 'unsupported' }),
    writeText: async (text): Promise<HostClipboardWriteResult> => {
      if (options.reject) throw new Error('Private backend diagnostic')
      if (options.fail) return { status: 'unsupported' }
      hostCopies.push(text); return { status: 'written' }
    },
    dispose: async () => { disposed = true }
  }
  setup.renderer.copyToClipboardOSC52 = text => { terminalCopies.push(text); return true }
  const clipboard = createClipboard({ host, terminal: createRendererClipboardAdapter(setup.renderer) })
  const io = new OpenTuiIO(setup.renderer, { clipboard }); active.push(io)
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const at = (text: string) => {
    const rows = setup.captureCharFrame().split('\n'), y = rows.findIndex(row => row.includes(text))
    expect(y).toBeGreaterThanOrEqual(0)
    return { x: rows[y]!.indexOf(text), y }
  }
  const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve() }
  return { io, setup, frame, at, settle, hostCopies, terminalCopies, disposed: () => disposed }
}

test('drag copies exact text only on release and keeps the selection and composer focus', async () => {
  const f = await fixture()
  f.io.write('Copy this text')
  const reading = f.io.readLine('Message')
  await f.frame()
  const { x, y } = f.at('Copy this text')
  await f.setup.mockMouse.pressDown(x, y)
  await f.setup.mockMouse.emitMouseEvent('drag', x + 9, y)
  await f.settle(); expect(f.hostCopies).toEqual([])
  await f.setup.mockMouse.release(x + 9, y)
  await f.settle(); expect(f.hostCopies).toEqual(['Copy this '])
  expect(await f.frame()).toContain('Copied!')
  const toast = f.setup.renderer.root.findDescendantById('vivi-copy-toast')!
  const box = f.setup.renderer.root.findDescendantById('vivi-composer-box')!
  expect(toast.y).toBe(box.y - 1)
  expect(toast.x + toast.width).toBe(box.x + box.width)
  expect(f.terminalCopies).toEqual([])
  expect(f.setup.renderer.getSelection()!.getSelectedText()).toBe('Copy this ')
  f.setup.resize(40, 12)
  expect(await f.frame()).toContain('Copied!')
  expect(toast.y).toBe(box.y - 1)
  expect(toast.x + toast.width).toBe(40)
  const composer = f.setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  expect(composer.focused).toBe(true)
  await f.setup.mockInput.typeText('Still typing'); f.setup.mockInput.pressEnter()
  expect(await reading).toBe('Still typing')
  await new Promise(resolve => setTimeout(resolve, 1300))
  expect(await f.frame()).not.toContain('Copied!')
})

test('empty clicks, wheel scrolling and keyboard selections do not overwrite the clipboard', async () => {
  const f = await fixture()
  const reading = f.io.askText('Text', 'Draft text')
  await f.frame()
  const { x, y } = f.at('Draft text')
  await f.setup.mockMouse.click(x, y)
  await f.setup.mockMouse.scroll(x, y, 'up')
  f.setup.mockInput.pressArrow('right', { shift: true })
  await f.frame(); await f.settle()
  expect(f.hostCopies).toEqual([]); expect(f.terminalCopies).toEqual([])
  expect(f.setup.captureCharFrame()).not.toContain('Copied!')
  f.setup.mockInput.pressEscape(); expect(await reading).toBeUndefined()
})

test('composer drag, double-click word and triple-click line selections copy on release', async () => {
  const f = await fixture()
  const reading = f.io.askText('Text', 'Copy draft')
  await f.frame()
  const { x, y } = f.at('Copy draft')
  await f.setup.mockMouse.drag(x + 5, y, x + 10, y)
  await f.settle(); expect(f.hostCopies).toEqual(['draft'])
  f.setup.renderer.clearSelection()
  await f.setup.mockMouse.doubleClick(x + 1, y)
  await f.settle(); expect(f.hostCopies.at(-1)).toBe('Copy')
  await f.setup.mockMouse.click(x + 1, y)
  await f.settle(); expect(f.hostCopies.at(-1)).toBe('Copy draft')
  f.setup.mockInput.pressEscape(); expect(await reading).toBeUndefined()
})

test('multiline Markdown selections preserve Unicode and native copied text', async () => {
  const f = await fixture()
  const session = newSession({ provider: 'openai', model: 'fixture' })
  session.history = [{ kind: 'assistant', content: '```text\ncafé 日本語\nsecond line\n```', toolCalls: [] }]
  f.io.setSession(session); await f.frame()
  const start = f.at('café'), end = f.at('second line')
  await f.setup.mockMouse.drag(start.x, start.y, end.x + 'second line'.length, end.y)
  await f.settle()
  expect(f.hostCopies).toEqual(['café 日本語\nsecond line'])
})

for (const options of [{ remote: true }, { fail: true }]) {
  test(`copy uses OSC 52 ${options.remote ? 'for remote sessions' : 'when the local clipboard is unavailable'}`, async () => {
    const f = await fixture(options)
    f.io.write('Clipboard fallback'); await f.frame()
    const { x, y } = f.at('Clipboard fallback')
    await f.setup.mockMouse.drag(x, y, x + 'Clipboard fallback'.length, y)
    await f.settle()
    expect(f.hostCopies).toEqual([]); expect(f.terminalCopies).toEqual(['Clipboard fallback'])
    expect(await f.frame()).toContain('Copied!')
  })
}

for (const options of [{ fail: true, terminal: false }, { reject: true }]) {
  test(`clipboard ${options.reject ? 'rejection' : 'unavailability'} leaves the session usable and closes its backend`, async () => {
    const f = await fixture(options)
    f.io.write('Copy failure'); await f.frame()
    const { x, y } = f.at('Copy failure')
    await f.setup.mockMouse.drag(x, y, x + 'Copy failure'.length, y)
    await f.settle()
    const display = await f.frame()
    expect(display).toContain('Could not copy selection')
    expect(display).not.toContain('Private backend diagnostic')
    expect(display).not.toContain('Copied!')
    expect(f.io.failed).toBe(false); expect(f.io.isClosed).toBe(false)
    const listeners = f.setup.renderer.listenerCount('selection')
    f.io.close(); await f.settle()
    expect(f.disposed()).toBe(true)
    expect(f.setup.renderer.listenerCount('selection')).toBeLessThan(listeners)
  })
}
