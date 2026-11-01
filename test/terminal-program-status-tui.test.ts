// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { CliRenderEvents } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import type { ProgramState, ProgramBlockKind } from '../src/terminal-program-status.js'
const active: OpenTuiIO[] = []
afterEach(() => { for (const io of active.splice(0)) io.close() })
async function fixture() {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const states: [ProgramState, ProgramBlockKind | undefined][] = []; let clears = 0
  const io = new OpenTuiIO(setup.renderer, { programStatus: {
    report(state, kind) { states.push([state, kind]) }, close(clear) { if (clear) clears++ }
  } })
  active.push(io)
  return { io, setup, states, get clears() { return clears }, input: setup.mockInput,
    frame: async () => { await setup.renderOnce(); await setup.renderOnce() } }
}
test('native turn status survives token/render ticks, tools, done composer and queued continuation', async () => {
  const f = await fixture()
  expect(f.states).toEqual([['idle', undefined]])
  f.io.runStarted()
  const count = f.states.length
  f.io.event({ type: 'text_delta', text: 'private-token\x1b]7501;state=error\x07' })
  await f.frame(); await new Promise(resolve => setTimeout(resolve, 120))
  expect(f.states.length).toBe(count)
  f.io.runFinished('completed', true); f.io.runStarted()
  expect(f.states.length).toBe(count)
  f.io.runFinished('completed')
  const reading = f.io.readLine('Private chat prompt'); await f.frame()
  expect(f.states.at(-1)).toEqual(['done', undefined])
  f.io.close(); await reading; await Promise.resolve()
  expect(f.clears).toBe(1)
})
test('actual native permission dialogs block, queue waits do not; cancellation settles after host finish', async () => {
  const f = await fixture(); f.io.runStarted()
  const controller = new AbortController()
  const request = { call: { id: 'private-call', name: 'private-tool', arguments: { password: 'private-password' } },
    currentRevision: 0, description: 'Private approval context' }
  const approving = f.io.approve(request, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 3)); await f.frame()
  expect(f.states.at(-1)).toEqual(['blocked', 'permission'])
  const before = f.states.length
  const queued = f.io.approve({ ...request, call: { ...request.call, id: 'queued' } }, controller.signal)
  expect(f.states.length).toBe(before)
  controller.abort(); expect(await approving).toBe(false); expect(await queued).toBe(false)
  expect(f.states.at(-1)).toEqual(['working', undefined])
  f.io.runFinished('cancelled'); expect(f.states.at(-1)).toEqual(['idle', undefined])
  expect(JSON.stringify(f.states)).not.toContain('private')
  const preAborted = new AbortController(); preAborted.abort()
  const count = f.states.length
  expect(await f.io.approve(request, preAborted.signal)).toBe(false)
  expect(f.states.length).toBe(count)
})
test('setup input and secret auth classify without transmitting text; error outcome survives redraw', async () => {
  const f = await fixture()
  const choice = f.io.choose('Private manager title', [{ name: 'Back', value: false }]); await f.frame()
  expect(f.states.at(-1)).toEqual(['blocked', 'question'])
  f.input.pressEscape(); await choice
  expect(f.states.at(-1)).toEqual(['idle', undefined])
  const secret = f.io.askSecret('Private credential prompt'); await f.frame()
  expect(f.states.at(-1)).toEqual(['blocked', 'auth'])
  f.input.pressEscape(); await secret
  expect(f.states.at(-1)).toEqual(['idle', undefined])
  f.io.runStarted(); f.io.runFinished('error'); await f.frame()
  expect(f.states.at(-1)).toEqual(['error', undefined])
  f.io.close(); await Promise.resolve(); expect(f.clears).toBe(1)
})
test('native question waits emit blocked question, not permission; abort returns working', async () => {
  const f = await fixture(); f.io.runStarted()
  const controller = new AbortController()
  const asking = f.io.askQuestions({ requestId: 'private-question', questions: [
    { id: 'choice', header: 'Private header', question: 'Private question', options: [{ label: 'One', description: 'Private option' }] }
  ] }, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 3)); await f.frame()
  expect(f.states.at(-1)).toEqual(['blocked', 'question'])
  controller.abort(); expect((await asking).status).toBe('cancelled')
  expect(f.states.at(-1)).toEqual(['working', undefined])
  f.io.runFinished('error'); expect(f.states.at(-1)).toEqual(['error', undefined])
})
test('external destroy, handler failure and repeated close clear once, without late reports', async () => {
  for (const mode of ['external', 'error', 'close']) {
    const f = await fixture(); f.io.runStarted()
    if (mode === 'external') f.setup.renderer.destroy()
    else if (mode === 'error') f.setup.renderer.emit(CliRenderEvents.HANDLER_ERROR, { error: new Error('offline failure') })
    else f.io.close()
    f.io.close(); await Promise.resolve()
    const count = f.states.length
    f.io.runStarted(); f.io.runFinished('error')
    expect(f.clears).toBe(1); expect(f.states.length).toBe(count)
  }
})

test('a destroyed renderer is rejected before reporting a new agent', async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, exitSignals: [], consoleMode: 'disabled' })
  setup.renderer.destroy()
  let reports = 0
  expect(() => new OpenTuiIO(setup.renderer, { programStatus: { report() { reports++ }, close() {} } })).toThrow()
  expect(reports).toBe(0)
})
