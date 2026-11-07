// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { BoxRenderable, TextareaRenderable, TextRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import { newSession } from '../src/session.js'
import { USER_SHELL_DISCLOSURE } from '../src/user-shell.js'

const active: OpenTuiIO[] = []
afterEach(() => { for (const io of active.splice(0)) io.close() })
async function fixture(width = 100, height = 30, loading = false) {
  const setup = await createTestRenderer({ width, height, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer, { loading }); active.push(io)
  const node = (id: string) => setup.renderer.root.findDescendantById(id)!
  const composer = node('vivi-composer') as TextareaRenderable
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  return { io, setup, node, composer, frame }
}

test('startup animates while hiding provisional settings and ignores input until the real session is ready', async () => {
  const f = await fixture(40, 12, true)
  expect(await f.frame()).toContain('Starting vivi')
  expect(f.node('vivi-root').visible).toBe(false)
  expect(await f.frame()).not.toContain('Manual')
  const first = (f.node('vivi-loading-stage') as TextRenderable).plainText
  await new Promise(resolve => setTimeout(resolve, 120)); await f.frame()
  expect((f.node('vivi-loading-stage') as TextRenderable).plainText).not.toBe(first)
  f.io.setLoading('Loading model capabilities…')
  f.setup.resize(32, 10)
  expect(await f.frame()).toContain('Loading model capabilities')
  await f.setup.mockInput.typeText('Too early')
  f.setup.mockInput.pressEnter()
  expect(f.composer.plainText).toBe('')
  f.io.setSession(newSession({ provider: 'deepseek', model: 'deepseek-flash' }))
  f.io.setTaskMode('plan')
  expect(await f.frame()).not.toContain('deepseek')
  const reading = f.io.readLine('Message')
  expect(await f.frame()).toContain('Plan')
  expect(f.node('vivi-loading').visible).toBe(false)
  expect(f.node('vivi-root').visible).toBe(true)
  expect(f.node('vivi-transcript').getChildren()).toHaveLength(0)
  expect(f.composer.plainText).toBe('')
  f.io.close(); expect(await reading).toBeUndefined()
})

test('Ctrl+C exits startup immediately and cancels outstanding setup', async () => {
  const f = await fixture(40, 12, true)
  let cancelled = 0
  f.io.onCancel(() => { cancelled++ })
  await f.frame(); f.setup.mockInput.pressCtrlC()
  expect(f.io.isClosed).toBe(true)
  expect(f.setup.renderer.isDestroyed).toBe(true)
  expect(cancelled).toBe(1)
})

test('fresh welcome shows one model/mode row, a home-relative workspace and an empty transcript', async () => {
  const f = await fixture()
  f.io.setSession(newSession({ provider: 'deepseek', model: 'deepseek-flash' }))
  f.io.setWorkspace(join(homedir(), 'projects', 'vivi'))
  f.io.setContext({ inputTokens: 9800, estimated: true, contextWindow: 1000000, outputReserveTokens: 4096 })
  f.io.setApprovalMode('auto')
  const reading = f.io.readLine('Message'), displayed = await f.frame()
  expect((f.node('vivi-header') as TextRenderable).plainText).toBe('vivi')
  expect((f.node('vivi-workspace') as TextRenderable).plainText).toBe(join('~', 'projects', 'vivi'))
  expect(f.node('vivi-transcript').getChildren()).toHaveLength(0)
  expect(f.node('vivi-status').visible).toBe(false)
  expect(f.node('vivi-tokens').visible).toBe(false)
  expect(f.node('vivi-actions').getChildren()).toHaveLength(1)
  expect(displayed.match(/Auto review/g)).toHaveLength(1)
  for (const text of ['Untitled conversation', 'Ready', 'reasoning default', 'Workspace:', 'reviewed text edits']) {
    expect(displayed).not.toContain(text)
  }
  const box = f.node('vivi-composer-box') as BoxRenderable
  expect(box.title).toBeUndefined()
  expect(box.border).toEqual(['top', 'bottom'])
  expect(displayed.split('\n')[box.y + box.height - 1]).toBe('─'.repeat(100))
  expect(f.composer.height).toBe(1)
  expect(f.node('vivi-model').y).toBe(box.y + box.height)
  f.io.close(); expect(await reading).toBeUndefined()
})

test('context stays quiet before the first turn, appears near capacity, and resets for a new conversation', async () => {
  const f = await fixture()
  const session = newSession({ provider: 'openai', model: 'fixture' })
  const usage = { inputTokens: 1000, estimated: true, contextWindow: 10000, outputReserveTokens: 1000 }
  f.io.setSession(session); f.io.setContext(usage)
  expect(await f.frame()).not.toContain('Context')
  f.io.setContext({ ...usage, inputTokens: 7200 })
  expect(await f.frame()).toContain('Context ~7.2k/10k')
  session.history = [{ kind: 'message', role: 'user', content: 'First turn' }]
  f.io.setSession(session); f.io.setContext(usage)
  expect(await f.frame()).toContain('Context ~1k/10k')
  f.io.setSession(newSession({ provider: 'openai', model: 'other' })); f.io.setContext(usage)
  expect(await f.frame()).not.toContain('Context')
})

test('shell details appear beside live shell input and disappear on edit or modal replacement', async () => {
  const f = await fixture()
  const reading = f.io.readLine('Message')
  f.composer.setText('!echo fixture')
  expect(await f.frame()).toContain('Send is approval')
  expect((f.node('vivi-shell-notice') as TextRenderable).plainText).toBe(USER_SHELL_DISCLOSURE)
  f.composer.setText('ordinary message')
  expect(await f.frame()).not.toContain('Send is approval')
  f.composer.setText('!echo fixture')
  const modal = f.io.askText('Name')
  expect(await reading).toBeUndefined()
  expect(await f.frame()).not.toContain('Send is approval')
  f.setup.mockInput.pressEscape(); expect(await modal).toBeUndefined()
})

test('compact shell composer retains the disclosure, input and menu inside the terminal', async () => {
  const f = await fixture(40, 12), reading = f.io.readLine('Message')
  f.composer.setText('!echo fixture')
  for (const width of [40, 32]) {
    f.setup.resize(width, 12)
    const displayed = await f.frame()
    expect(displayed).toContain('Send approves')
    expect(displayed).toContain('provider')
    expect(displayed).toContain('/ menu')
    expect(f.node('vivi-composer-box').y + f.node('vivi-composer-box').height).toBeLessThanOrEqual(11)
    expect(f.node('vivi-model').y + f.node('vivi-model').height).toBeLessThanOrEqual(12)
    expect(f.node('vivi-transcript').height).toBeGreaterThanOrEqual(1)
  }
  f.setup.mockInput.pressEnter(); expect(await reading).toBe('!echo fixture')
})
