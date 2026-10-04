// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import type { Choice } from '../src/tui.js'
import type { CliSession } from '../src/session.js'
import { main } from '../src/main.js'
import { PreferenceStore } from '../src/preferences.js'
import { FileSessionStore } from '../src/session.js'


/** Observe application readiness, including async file IO, before asking the renderer for a frame. */
function observeUI(io: OpenTuiIO) {
  type State = { kind: 'welcome' } | { kind: 'session'; session: CliSession }
  const reached: State[] = []
  const pending = new Set<{ predicate(state: State): boolean; resolve(state: State): void }>()
  const notify = (state: State): void => {
    reached.push(state)
    for (const waiter of pending) if (waiter.predicate(state)) { pending.delete(waiter); waiter.resolve(state) }
  }
  const choose = io.choose.bind(io)
  io.choose = <T>(title: string, choices: readonly Choice<T>[], initialIndex?: number): Promise<T | undefined> => {
    const response = choose(title, choices, initialIndex)
    if (title === 'Welcome to vivi') notify({ kind: 'welcome' })
    return response
  }
  const setSession = io.setSession.bind(io)
  io.setSession = session => { setSession(session); notify({ kind: 'session', session }) }
  return (predicate: (state: State) => boolean): Promise<State> => {
    const state = reached.find(predicate)
    if (state) return Promise.resolve(state)
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: (state: State): void => { clearTimeout(timer); resolve(state) } }
      const timer = setTimeout(() => { pending.delete(waiter); reject(new Error('Application readiness condition did not arrive within 5 seconds')) }, 5000)
      pending.add(waiter)
    })
  }
}

test('native surface runs saved-default chat, accepted Markdown, new session and exit through the canonical host', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-native-application-'))
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  const ready = observeUI(io)
  let running: Promise<number> | undefined
  const ids: string[] = []
  const setSession = io.setSession.bind(io)
  io.setSession = session => { if (!ids.includes(session.id)) ids.push(session.id); setSession(session) }
  try {
    await new PreferenceStore(directory).save({ schemaVersion: 1, provider: 'openai', model: 'native-fake-model',
      reasoning: 'default', reasoningCapabilities: [], enableTools: false, enableNotes: false, stream: true, maxRounds: 25 })
    let calls = 0
    running = main([], { VIVI_SESSION_DIR: directory }, { tuiIO: io, providerFactory: () => ({
      generate: async (input, _signal, progress) => {
        calls++
        expect(input.tools).toEqual([])
        expect(input.messages.at(-1)?.content).toBe('first\nsecond')
        await progress?.onProgress({ type: 'text_delta', text: 'Unaccepted preview' })
        return { content: '## Accepted answer\n\nThe canonical response is visible', toolCalls: [],
          usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }
      }
    }) })
    await ready(state => state.kind === 'welcome')
    await setup.waitForFrame(frame => frame.includes('New conversation') && frame.includes('native-fake-model'))
    setup.mockInput.pressEnter()
    await ready(state => state.kind === 'session')
    await setup.waitForFrame(frame => frame.includes('openai / native-fake-model') && frame.includes('Enter send'))
    await setup.mockInput.typeText('first')
    setup.mockInput.pressEnter({ shift: true })
    await setup.mockInput.typeText('second')
    setup.mockInput.pressEnter()
    await ready(state => state.kind === 'session' && state.session.history.some(message => message.content.includes('The canonical response is visible')))
    await setup.waitForFrame(frame => frame.includes('The canonical response is visible') && frame.includes('Completed'))
    expect(calls).toBe(1)
    await setup.mockInput.typeText('/new')
    setup.mockInput.pressEnter()
    await ready(state => state.kind === 'session' && state.session.id !== ids[0])
    await setup.waitForFrame(frame => frame.includes(ids[1]!))
    expect(setup.captureCharFrame()).not.toContain('The canonical response is visible')
    await setup.mockInput.typeText('/exit')
    setup.mockInput.pressEnter()
    expect(await running).toBe(0)
    expect(setup.renderer.isDestroyed).toBe(true)
    const saved = await new FileSessionStore(directory).load(ids[0]!)
    expect(saved.history.map(message => message.content)).toEqual(['first\nsecond', '## Accepted answer\n\nThe canonical response is visible'])
    expect(saved.usage.totalTokens).toBe(7)
    expect((await readdir(directory)).some(name => name.endsWith('.lock'))).toBe(false)
  } finally { io.close(); await running; setup.renderer.destroy(); await rm(directory, { recursive: true, force: true }) }
}, 10000)

test('fatal native failure exits nonzero and prints a redacted error after terminal restoration', async () => {
  const { CliRenderEvents } = await import('@opentui/core')
  const directory = await mkdtemp(join(tmpdir(), 'vivi-native-failure-'))
  const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer, { secrets: ['known-secret'] })
  const ready = observeUI(io)
  const originalWrite = process.stderr.write
  let errors = ''
  process.stderr.write = ((chunk: string | Uint8Array) => { errors += chunk.toString(); return true }) as typeof process.stderr.write
  try {
    const running = main([], { VIVI_SESSION_DIR: directory, OPENAI_API_KEY: 'known-secret' }, { tuiIO: io,
      providerFactory: () => { throw new Error('A failed welcome screen must never construct a provider') } })
    await ready(state => state.kind === 'welcome')
    await setup.waitForFrame(frame => frame.includes('Welcome to vivi'))
    setup.renderer.emit(CliRenderEvents.RENDER_ERROR, { error: new Error('\x1b[31mSynthetic known-secret failure\x1b[0m') })
    expect(await running).toBe(1)
    expect(setup.renderer.isDestroyed).toBe(true)
    expect(errors).toContain('OpenTUI renderer failed: Synthetic [REDACTED] failure')
    expect(errors).not.toContain('known-secret')
    expect(errors).not.toContain('\x1b')
  } finally { process.stderr.write = originalWrite; io.close(); setup.renderer.destroy(); await rm(directory, { recursive: true, force: true }) }
})

test('closing native UI during startup cannot start a one-shot provider request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-native-startup-cancel-'))
  const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  let calls = 0
  try {
    const code = await main(['--model', 'fake', '--tui', '--prompt', 'hello'], { VIVI_SESSION_DIR: directory }, {
      tuiIO: io, providerFactory: () => {
        io.close()
        return { generate: async () => { calls++; return { content: 'Must never run', toolCalls: [] } } }
      }
    })
    expect(code).toBe(0)
    expect(calls).toBe(0)
    expect((await readdir(directory)).some(name => name.endsWith('.lock'))).toBe(false)
  } finally { io.close(); setup.renderer.destroy(); await rm(directory, { recursive: true, force: true }) }
})

for (const event of ['RENDER_ERROR', 'HANDLER_ERROR'] as const) {
  test(`one-shot native ${event} reports a safe fatal error after restoration instead of cancellation`, async () => {
    const { CliRenderEvents } = await import('@opentui/core')
    const directory = await mkdtemp(join(tmpdir(), 'vivi-native-prompt-failure-'))
    const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
    const io = new OpenTuiIO(setup.renderer, { secrets: ['known-secret'] })
    const originalWrite = process.stderr.write
    let errors = ''
    let outputAfterRestoration = true
    let aborted = false
    process.stderr.write = ((chunk: string | Uint8Array) => {
      outputAfterRestoration &&= setup.renderer.isDestroyed
      errors += chunk.toString()
      return true
    }) as typeof process.stderr.write
    try {
      const code = await main(['--model', 'fake', '--tui', '--prompt', 'hello'],
        { VIVI_SESSION_DIR: directory, OPENAI_API_KEY: 'known-secret' }, {
          tuiIO: io, providerFactory: () => ({ generate: async (_input, signal) => {
            setup.renderer.emit(CliRenderEvents[event], { error: new Error('\x1b[31mSynthetic known-secret failure\x1b[0m') })
            aborted = signal.aborted
            return { content: 'Must not be accepted', toolCalls: [] }
          } })
        })
      expect(code).toBe(1)
      expect(aborted).toBe(true)
      expect(io.failed).toBe(true)
      expect(setup.renderer.isDestroyed).toBe(true)
      expect(outputAfterRestoration).toBe(true)
      expect(errors).toContain('OpenTUI renderer failed: Synthetic [REDACTED] failure')
      expect(errors).not.toContain('known-secret')
      expect(errors).not.toContain('\x1b')
      expect((await readdir(directory)).some(name => name.endsWith('.lock'))).toBe(false)
    } finally { process.stderr.write = originalWrite; io.close(); setup.renderer.destroy(); await rm(directory, { recursive: true, force: true }) }
  })
}

test('one-shot native user cancellation remains status 130 without a fatal diagnostic', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-native-prompt-cancel-'))
  const setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  const originalWrite = process.stderr.write
  let errors = ''
  let aborted = false
  process.stderr.write = ((chunk: string | Uint8Array) => { errors += chunk.toString(); return true }) as typeof process.stderr.write
  try {
    const code = await main(['--model', 'fake', '--tui', '--prompt', 'hello'], { VIVI_SESSION_DIR: directory }, {
      tuiIO: io, providerFactory: () => ({ generate: async (_input, signal) => {
        setup.mockInput.pressCtrlC()
        aborted = signal.aborted
        return { content: 'Must not be accepted', toolCalls: [] }
      } })
    })
    expect(code).toBe(130)
    expect(aborted).toBe(true)
    expect(io.failed).toBe(false)
    expect(setup.renderer.isDestroyed).toBe(true)
    expect(errors).toBe('')
    expect((await readdir(directory)).some(name => name.endsWith('.lock'))).toBe(false)
  } finally { process.stderr.write = originalWrite; io.close(); setup.renderer.destroy(); await rm(directory, { recursive: true, force: true }) }
})
