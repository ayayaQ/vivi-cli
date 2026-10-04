// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import type { CliSession } from '../src/session.js'
import { main } from '../src/main.js'
import { PreferenceStore } from '../src/preferences.js'
import { FileSessionStore } from '../src/session.js'


/** Observe application readiness, including async file IO, before asking the renderer for a frame. */
function observeUI(io: OpenTuiIO) {
  type State = { kind: 'composer'; index: number } | { kind: 'session'; session: CliSession }
  const reached: State[] = []
  let composerCount = 0
  const pending = new Set<{ predicate(state: State): boolean; resolve(state: State): void }>()
  const notify = (state: State): void => {
    reached.push(state)
    for (const waiter of pending) if (waiter.predicate(state)) { pending.delete(waiter); waiter.resolve(state) }
  }
  const readLine = io.readLine.bind(io)
  io.readLine = (title, signal) => {
    const response = readLine(title, signal)
    notify({ kind: 'composer', index: ++composerCount })
    return response
  }
  const setSession = io.setSession.bind(io)
  io.setSession = session => { setSession(session); notify({ kind: 'session', session }) }
  const waitFor = (predicate: (state: State) => boolean): Promise<State> => {
    const state = reached.find(predicate)
    if (state) return Promise.resolve(state)
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve: (state: State): void => { clearTimeout(timer); resolve(state) } }
      const timer = setTimeout(() => { pending.delete(waiter); reject(new Error('Application readiness condition did not arrive within 5 seconds')) }, 5000)
      pending.add(waiter)
    })
  }
  return Object.assign(waitFor, { nextComposer: (): Promise<State> => {
    const previous = composerCount
    return waitFor(state => state.kind === 'composer' && state.index > previous)
  } })
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
    running = main([], { VIVI_SESSION_DIR: directory }, { tuiIO: io, credentials: { status: async () => ({ available: false, label: 'Fake vault' }), load: async () => undefined, save: async () => { throw new Error('Fake storage unavailable') } }, providerFactory: () => ({
      generate: async (input, _signal, progress) => {
        calls++
        expect(input.tools).toEqual([])
        expect(input.messages.at(-1)?.content).toBe('first\nsecond')
        await progress?.onProgress({ type: 'text_delta', text: 'Unaccepted preview' })
        return { content: '## Accepted answer\n\nThe canonical response is visible', toolCalls: [],
          usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }
      }
    }) })
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
      credentials: { status: async () => ({ available: false, label: 'Fake vault' }), load: async () => undefined, save: async () => { throw new Error('Fake storage unavailable') } }, providerFactory: () => { throw new Error('A failed welcome screen must never construct a provider') } })
    await ready(state => state.kind === 'composer')
    await setup.waitForFrame(frame => frame.includes('fresh conversation'))
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
      tuiIO: io, credentials: { status: async () => ({ available: false, label: 'Fake vault' }), load: async () => undefined, save: async () => { throw new Error('Fake storage unavailable') } }, providerFactory: () => {
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
          tuiIO: io, credentials: { status: async () => ({ available: false, label: 'Fake vault' }), load: async () => undefined, save: async () => { throw new Error('Fake storage unavailable') } }, providerFactory: () => ({ generate: async (_input, signal) => {
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
      tuiIO: io, credentials: { status: async () => ({ available: false, label: 'Fake vault' }), load: async () => undefined, save: async () => { throw new Error('Fake storage unavailable') } }, providerFactory: () => ({ generate: async (_input, signal) => {
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

test('native slash setup saves a masked fake key and model/effort pickers work after repeated cancellation', async () => {
  const { parseModelCatalog } = await import('../src/models.js')
  const directory = await mkdtemp(join(tmpdir(), 'vivi-native-provider-'))
  const setup = await createTestRenderer({ width: 100, height: 32, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  const ready = observeUI(io)
  const vault = new Map<string, string>()
  const key = 'fake-native-key-never-network'
  let running: Promise<number> | undefined
  try {
    running = main([], { VIVI_SESSION_DIR: directory }, { tuiIO: io,
      credentials: { status: async () => ({ available: true, label: 'Fake secure vault' }), load: async provider => vault.get(provider),
        save: async (provider, value) => { vault.set(provider, value) } },
      catalog: { list: async provider => ({ state: 'fresh', models: parseModelCatalog(provider, { data: [{ id: 'gpt-5.1' }] }) }) },
      providerFactory: (session, options, env) => {
        expect(env.OPENAI_API_KEY).toBe(key)
        expect(options.enableTools).toBe(true)
        return { generate: async input => { expect(input.tools).toHaveLength(2); return { content: `${session.reasoning} response`, toolCalls: [] } } }
      }
    })
    await ready(state => state.kind === 'composer')
    await setup.waitForFrame(frame => frame.includes('fresh conversation'))
    await setup.mockInput.typeText('/pro')
    await setup.waitForFrame(frame => frame.includes('Commands') && frame.includes('/provider'))
    setup.mockInput.pressTab()
    setup.mockInput.pressEnter()
    await setup.waitForFrame(frame => frame.includes('Provider') && frame.includes('OpenAI'))
    const afterProviderCancel = ready.nextComposer()
    setup.mockInput.pressEscape()
    await afterProviderCancel
    await setup.waitForFrame(frame => frame.includes('Enter send') && !frame.includes('Responses API'))
    await setup.mockInput.typeText('/provider')
    setup.mockInput.pressEnter()
    await setup.waitForFrame(frame => frame.includes('Responses API'))
    setup.mockInput.pressEnter()
    await setup.waitForFrame(frame => frame.includes('API key storage') && frame.includes('Fake secure vault'))
    setup.mockInput.pressEnter()
    await setup.waitForFrame(frame => frame.includes('API key') && frame.includes('Input hidden'))
    await setup.mockInput.pasteBracketedText(key)
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain(key)
    expect(setup.captureCharFrame()).toContain('•')
    setup.mockInput.pressEnter()
    await setup.waitForFrame(frame => frame.includes('Models · openai') && frame.includes('gpt-5.1'))
    setup.mockInput.pressArrow('down')
    setup.mockInput.pressArrow('down')
    const afterModel = ready.nextComposer()
    setup.mockInput.pressEnter()
    await afterModel
    await setup.waitForFrame(frame => frame.includes('openai / gpt-5.1') && frame.includes('Enter send') && !frame.includes('Models ·'))
    expect(vault.get('openai')).toBe(key)
    await setup.mockInput.typeText('/effort')
    setup.mockInput.pressEnter()
    await setup.waitForFrame(frame => frame.includes('Reasoning effort'))
    const afterEffortCancel = ready.nextComposer()
    setup.mockInput.pressEscape()
    await afterEffortCancel
    await setup.waitForFrame(frame => !frame.includes('Reasoning effort'))
    await setup.mockInput.typeText('/effort')
    setup.mockInput.pressEnter()
    await setup.waitForFrame(frame => frame.includes('Reasoning effort'))
    for (let index = 0; index < 4; index++) setup.mockInput.pressArrow('down')
    const afterEffort = ready.nextComposer()
    setup.mockInput.pressEnter()
    await afterEffort
    await setup.waitForFrame(frame => frame.includes('high') && !frame.includes('Reasoning effort'))
    const afterSend = ready.nextComposer()
    await setup.mockInput.typeText('Hello')
    setup.mockInput.pressEnter()
    await afterSend
    await setup.waitForFrame(frame => frame.includes('high response'))
    expect(setup.captureCharFrame()).not.toContain(key)
    await setup.mockInput.typeText('/exit')
    setup.mockInput.pressEnter()
    expect(await running).toBe(0)
    const { readFile } = await import('node:fs/promises')
    for (const file of await readdir(directory)) expect(await readFile(join(directory, file), 'utf8')).not.toContain(key)
    expect(JSON.parse(await readFile(join(directory, 'preferences.json'), 'utf8')).reasoning).toBe('high')
  } finally { io.close(); await running; setup.renderer.destroy(); await rm(directory, { recursive: true, force: true }) }
}, 15000)
