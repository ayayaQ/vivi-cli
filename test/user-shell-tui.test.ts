// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { TextareaRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import { newSession } from '../src/session.js'
import { userShellContext } from '../src/user-shell.js'

const active: OpenTuiIO[] = []
afterEach(() => { for (const io of active.splice(0)) io.close() })
async function fixture() {
  const setup = await createTestRenderer({ width: 110, height: 35, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer); active.push(io)
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const arm = async () => { await new Promise(resolve => setTimeout(resolve, 3)); return frame() }
  return { io, setup, composer, frame, arm }
}

test('native live shell input visibly grants exact approval and returns the unchanged multiline script', async () => {
  const f = await fixture(), pending = f.io.readLine('Message')
  await f.arm()
  const input = '!printf "%s\\n" "two words"\npwd'
  f.composer.setText(input)
  expect(await f.frame()).toContain('Shell · Send approves unsandboxed')
  f.setup.mockInput.pressEnter()
  expect(await pending).toBe(input)
  expect(f.setup.renderer.root.findDescendantById('vivi-transcript')!.getChildren().length).toBe(0)
})

test('native busy shell input clearly queues raw text without executing or becoming accepted transcript', async () => {
  const f = await fixture(), submissions: string[] = []
  const cancel = f.io.onCancel(() => {})
  f.io.runStarted()
  const dispose = f.io.onSteering({ submit(content) { submissions.push(content); return true }, takeLast() { return undefined }, clear() {} })
  await f.arm()
  await f.setup.mockInput.typeText('!owned-inert-fixture')
  expect(await f.frame()).toContain('Shell · queued after turn · Send approves unsandboxed')
  f.setup.mockInput.pressEnter()
  expect(submissions).toEqual(['!owned-inert-fixture'])
  expect(f.setup.renderer.root.findDescendantById('vivi-transcript')!.getChildren().length).toBe(0)
  dispose(); cancel()
})

test('cancelled shell output remains visible after canonical session and result refresh', async () => {
  const f = await fixture(), session = newSession({ provider: 'openai', model: 'fixture' })
  const content = userShellContext('owned-inert-fixture', '/bin/sh', '/project', {
    state: 'cancelled', executionComplete: true, output: 'observed partial output', signal: 'SIGKILL',
    processEffects: 'unknown', exitCode: null, truncated: false
  }, [])
  session.history.push({ kind: 'message', role: 'user', content })
  f.io.write(`Shell result · untrusted output\n${content}\n`)
  f.io.setSession(session)
  f.io.result({ status: 'cancelled', history: session.history, content: '', rounds: 0,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })
  const display = await f.frame()
  expect(display).toContain('observed partial output')
  expect(display).toContain('cancelled')
})
