// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createTestRenderer } from '@opentui/core/testing'
import { TextareaRenderable } from '@opentui/core'
import { OpenTuiIO } from '../src/tui.js'
import type { CliProviderName, CliSession } from '../src/session.js'
import type { Catalog, ModelEntry } from '../src/models.js'
import type { TuiPreferences } from '../src/preferences.js'
import { main } from '../src/main.js'
import { PreferenceStore } from '../src/preferences.js'
import { FileSessionStore } from '../src/session.js'
import { FileMemoryStore } from '../src/memory.js'
import type { ApprovalRequest } from '../src/tools.js'


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

test('native memory manager reviews repeated writes, refreshes conflicts and makes Back/Cancel/disable safe', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-native-memory-'))
  const setup = await createTestRenderer({ width: 110, height: 36, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer), ready = observeUI(io), memory = new FileMemoryStore(directory)
  type Phase = { kind: 'choice'; title: string; names: string[] } | { kind: 'text'; title: string }
    | { kind: 'approval'; request: ApprovalRequest }
  const phases: Phase[] = [], requests: ApprovalRequest[] = []
  let wake: ((phase: Phase) => void) | undefined
  const announce = (phase: Phase): void => { if (wake) { const finish = wake; wake = undefined; finish(phase) } else phases.push(phase) }
  const next = (): Promise<Phase> => phases.length ? Promise.resolve(phases.shift()!) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { wake = undefined; reject(new Error('Native memory input did not open')) }, 5000)
    wake = phase => { clearTimeout(timer); resolve(phase) }
  })
  const originalChoose = io.choose.bind(io), originalText = io.askText.bind(io), originalApprove = io.approve.bind(io)
  io.choose = (title, choices, initial) => {
    const response = originalChoose(title, choices, initial)
    announce({ kind: 'choice', title, names: choices.map(choice => choice.name) })
    return response
  }
  io.askText = (title, initial) => { const response = originalText(title, initial); announce({ kind: 'text', title }); return response }
  io.approve = (request, signal) => {
    const response = originalApprove(request, signal); requests.push(request); announce({ kind: 'approval', request }); return response
  }
  const choose = async (name: string): Promise<void> => {
    const phase = await next(); expect(phase.kind).toBe('choice')
    if (phase.kind !== 'choice') throw new Error('Expected a native choice')
    const index = phase.names.indexOf(name); expect(index).toBeGreaterThanOrEqual(0)
    await setup.renderOnce()
    for (let offset = 0; offset < index; offset++) setup.mockInput.pressArrow('down')
    setup.mockInput.pressEnter()
  }
  const text = async (content?: string): Promise<void> => {
    const phase = await next(); expect(phase.kind).toBe('text')
    if (content === undefined) setup.mockInput.pressEscape()
    else { setup.mockInput.pressKey('u', { ctrl: true }); await setup.mockInput.typeText(content); setup.mockInput.pressEnter() }
  }
  const approval = async (allow: boolean, beforeReply?: () => Promise<void>): Promise<void> => {
    const phase = await next(); expect(phase.kind).toBe('approval')
    await setup.renderOnce(); await new Promise(resolve => setTimeout(resolve, 2))
    await beforeReply?.()
    if (allow) await setup.mockInput.typeText('allow')
    setup.mockInput.pressEnter()
  }
  let running: Promise<number> | undefined
  try {
    await new PreferenceStore(directory).save({ schemaVersion: 1, provider: 'openai', model: 'native-memory-model',
      reasoning: 'default', reasoningCapabilities: [], enableTools: false, enableNotes: false, enableMemory: true, stream: false, maxRounds: 25 })
    running = main([], { VIVI_SESSION_DIR: directory }, { tuiIO: io,
      credentials: { status: async () => ({ available: false, label: 'Fake vault' }), load: async () => undefined, save: async () => { throw new Error('Fake storage') } },
      providerFactory: () => ({ generate: async () => { throw new Error('Memory management must not call a provider') } }) })
    await ready(state => state.kind === 'composer')
    await setup.mockInput.typeText('/memories'); setup.mockInput.pressEnter()
    await choose('Add memory'); await text() // Escape abandons content entry.
    await choose('Add memory'); await text('Denied memory'); await approval(false)
    await choose('Add memory'); await text('I prefer concise replies'); await approval(true)
    const afterCreate = await next(); expect(afterCreate.kind).toBe('choice'); phases.unshift(afterCreate)
    const first = (await memory.list()).memories[0]!
    expect(first.content).toBe('I prefer concise replies'); expect(first.createdBy).toBe('user')
    await choose('Edit memory'); await choose('Back')
    await choose('Edit memory'); await choose(first.id); await text()
    await choose('Edit memory'); await choose(first.id); await text('Stale proposed edit')
    await approval(true, async () => { await memory.commit(await memory.prepareUpdate(first.id, first.revision, 'Changed elsewhere', 'user')) })
    await choose('Refresh memories')
    expect((await memory.list()).memories[0]!.content).toBe('Changed elsewhere')
    await choose('Edit memory'); await choose(first.id); await text('Fresh approved edit'); await approval(true)
    await choose('Delete memory'); await choose(first.id); await approval(false)
    await choose('Disable for this launch')
    const afterDisable = ready.nextComposer(); await choose('Back'); await afterDisable
    expect((await memory.list()).memories[0]!.content).toBe('Fresh approved edit')
    await setup.mockInput.typeText('/memories'); setup.mockInput.pressEnter()
    await choose('Enable for this launch'); await choose('Delete memory'); await choose(first.id); await approval(true)
    const afterMemory = ready.nextComposer(); await choose('Back'); await afterMemory
    expect((await memory.list()).memories).toEqual([])
    expect(requests.map(request => request.call.name)).toEqual(['create_memory', 'create_memory', 'edit_memory', 'edit_memory', 'delete_memory', 'delete_memory'])
    expect(requests[0]!.currentRevision).toBe('new memory')
    expect(requests[2]!.currentRevision).not.toBe(requests[3]!.currentRevision)
    await setup.mockInput.typeText('/exit'); setup.mockInput.pressEnter()
    expect(await running).toBe(0)
    expect((await readdir(directory)).some(name => name.endsWith('.lock'))).toBe(false)
  } finally { io.close(); await running; setup.renderer.destroy(); await rm(directory, { recursive: true, force: true }) }
}, 20000)

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
      reasoning: 'default', reasoningCapabilities: [], enableTools: false, enableNotes: false, enableMemory: false, stream: true, maxRounds: 25 })
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

function nativeCatalogModel(id: string, name = id): ModelEntry {
  return { id, name, conversation: 'supported', tools: 'unsupported', streaming: 'supported',
    reasoning: 'unsupported', efforts: [], reasoningMandatory: false, source: 'Native fake catalog' }
}

/** Synthetic metadata and providers keep these native integration tests entirely offline. */
async function nativeCatalogApplication(provider: CliProviderName, catalog: Catalog) {
  const directory = await mkdtemp(join(tmpdir(), `vivi-native-${provider}-catalog-`))
  const setup = await createTestRenderer({ width: 110, height: 32, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  const ready = observeUI(io)
  const preferences = new PreferenceStore(directory)
  const defaults: TuiPreferences = { schemaVersion: 1, provider, model: 'saved-default-model', reasoning: 'default',
    reasoningCapabilities: [], enableTools: false, enableNotes: false, enableMemory: false, stream: true, maxRounds: 25 }
  await preferences.save(defaults)
  let current: CliSession | undefined
  const setSession = io.setSession.bind(io)
  io.setSession = session => { current = structuredClone(session); setSession(session) }
  const sessions: { id: string; provider: CliProviderName; model: string }[] = []
  const requests: { sessionId: string; model: string; prompt: unknown }[] = []
  const running = main([], { VIVI_SESSION_DIR: directory }, { tuiIO: io, catalog,
    credentials: { status: async () => ({ available: false, label: 'Fake vault' }), load: async () => undefined,
      save: async () => { throw new Error('Catalog tests must not save credentials') } },
    providerFactory: (session, _options, env) => {
      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.OPENROUTER_API_KEY).toBeUndefined()
      sessions.push({ id: session.id, provider: session.provider, model: session.model })
      return { generate: async input => {
        expect(input.tools).toEqual([])
        requests.push({ sessionId: session.id, model: session.model, prompt: input.messages.at(-1)?.content })
        return { content: 'Native catalog answer', toolCalls: [] }
      } }
    }
  })
  const composer = (): TextareaRenderable => setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  const session = (): CliSession => {
    if (!current) throw new Error('Native catalog application has not opened its session')
    return current
  }
  const openModels = async (): Promise<void> => {
    await setup.mockInput.typeText('/models')
    setup.mockInput.pressEnter()
    await setup.waitForFrame(frame => frame.includes(`Models · ${provider}`) && frame.includes('Type to search'))
  }
  const chat = async (text: string): Promise<void> => {
    expect(composer().plainText).toBe('')
    const afterSend = ready.nextComposer()
    await setup.mockInput.typeText(text)
    setup.mockInput.pressEnter()
    await afterSend
    await setup.waitForFrame(frame => frame.includes('Native catalog answer') && frame.includes('Enter send'))
    expect(requests.at(-1)?.prompt).toBe(text)
    expect(composer().plainText).toBe('')
  }
  const close = async (): Promise<void> => {
    io.close()
    try { expect(await running).toBe(0) }
    finally { setup.renderer.destroy(); await rm(directory, { recursive: true, force: true }) }
  }
  try {
    await ready(state => state.kind === 'composer')
    await setup.waitForFrame(frame => frame.includes(`${provider} / saved-default-model`) && frame.includes('Enter send'))
  } catch (error) { await close(); throw error }
  return { directory, setup, io, ready, preferences, defaults, sessions, requests, running, composer, session, openModels, chat, close }
}

for (const provider of ['openai', 'openrouter'] as const) {
  test(`native ${provider} live catalog search selects exact IDs by identifier, display name and provider beyond 250 rows`, async () => {
    const byId = nativeCatalogModel('zz-lab/aurora-4096:preview', 'Orchid Identifier Match')
    const byName = nativeCatalogModel('zz-lab/quartz-4097:preview', 'Cobalt Semantic Search')
    const byProvider = nativeCatalogModel('zz-lab/zircon-4098:preview', 'Copper Gateway Search')
    const models = [nativeCatalogModel('saved-default-model'),
      ...Array.from({ length: 4096 }, (_, index) => nativeCatalogModel(`fixture-model-${String(index).padStart(4, '0')}`)),
      byId, byName, byProvider]
    let catalogCalls = 0
    const app = await nativeCatalogApplication(provider, { list: async (actualProvider, key) => {
      expect(actualProvider).toBe(provider)
      expect(key).toBeUndefined()
      catalogCalls++
      return { state: 'fresh', models }
    } })
    try {
      expect(models.indexOf(byId)).toBeGreaterThan(4000)
      const selections = [
        { query: 'ZZ LAB AURORA 4096 PREVIEW', model: byId },
        { query: 'COBALT / SEMANTIC', model: byName },
        { query: `${provider.toUpperCase()} COPPER`, model: byProvider }
      ]
      for (const [index, { query, model }] of selections.entries()) {
        const previousId = app.session().id
        await app.openModels()
        expect(app.composer().plainText).toBe('')
        if (index === 0) expect(app.setup.captureCharFrame()).not.toContain(byId.id)
        if (index === 2) {
          const wrongProvider = provider === 'openai' ? 'openrouter' : 'openai'
          await app.setup.mockInput.typeText(`${wrongProvider} COPPER`)
          await app.setup.waitForFrame(frame => frame.includes('No matching models'))
          app.setup.mockInput.pressEnter()
          await app.setup.renderOnce()
          expect(app.session().id).toBe(previousId)
          expect(app.composer().plainText).toBe(`${wrongProvider} COPPER`)
          app.setup.mockInput.pressKey('u', { ctrl: true })
          expect(app.composer().plainText).toBe('')
        }
        await app.setup.mockInput.typeText(query)
        await app.setup.waitForFrame(frame => frame.includes(model.id))
        expect(app.composer().plainText).toBe(query)
        const afterModel = app.ready.nextComposer()
        app.setup.mockInput.pressEnter()
        await afterModel
        await app.setup.waitForFrame(frame => frame.includes(`${provider} / ${model.id}`) && !frame.includes('Models ·'))
        expect(app.session().id).not.toBe(previousId)
        expect(app.session().model).toBe(model.id)
        expect(app.session().history).toEqual([])
        expect(await app.preferences.load()).toEqual({ ...app.defaults, model: model.id })
        expect(app.composer().plainText).toBe('')
        expect(app.setup.renderer.root.findDescendantById('vivi-completions')!.visible).toBe(false)
        await app.chat(`clean chat after ${index + 1}`)
        expect(app.requests.at(-1)).toEqual({ sessionId: app.session().id, model: model.id, prompt: `clean chat after ${index + 1}` })
      }
      expect(catalogCalls).toBe(3)
      expect(app.sessions.map(session => session.model)).toEqual(['saved-default-model', byId.id, byName.id, byProvider.id])
      await app.setup.mockInput.typeText('/exit')
      app.setup.mockInput.pressEnter()
      expect(await app.running).toBe(0)
    } finally { await app.close() }
  }, 20000)

  test(`native ${provider} search cancellation preserves session/defaults and refresh preserves the live query`, async () => {
    const fillers = Array.from({ length: 3072 }, (_, index) => nativeCatalogModel(`fixture-model-${String(index).padStart(4, '0')}`))
    const original = nativeCatalogModel('zz-lab/cedar-3072:preview', 'Original Cedar Catalog')
    const refreshed = nativeCatalogModel('zz-lab/aurora-3073:latest', 'Refreshed Aurora Catalog')
    const calls: { provider: CliProviderName; refresh: boolean }[] = []
    const app = await nativeCatalogApplication(provider, { list: async (actualProvider, key, _signal, refresh = false) => {
      expect(actualProvider).toBe(provider)
      expect(key).toBeUndefined()
      calls.push({ provider: actualProvider, refresh })
      return { state: refresh ? 'fresh' : 'cached', models: [nativeCatalogModel('saved-default-model'), ...fillers,
        refresh ? refreshed : original] }
    } })
    try {
      await app.chat('before cancelled model search')
      const originalSession = structuredClone(app.session())
      for (const query of ['CEDAR ORIGINAL', 'catalog-that-does-not-exist']) {
        await app.openModels()
        await app.setup.mockInput.typeText(query)
        await app.setup.renderOnce()
        const afterCancel = app.ready.nextComposer()
        app.setup.mockInput.pressEscape()
        await afterCancel
        await app.setup.waitForFrame(frame => frame.includes('Enter send') && !frame.includes('Models ·'))
        expect(app.session()).toEqual(originalSession)
        expect(await app.preferences.load()).toEqual(app.defaults)
        expect(await new FileSessionStore(app.directory).load(originalSession.id)).toEqual(originalSession)
        expect(app.sessions).toHaveLength(1)
        expect(app.composer().plainText).toBe('')
      }
      await app.chat('clean chat after cancellation')
      expect(app.session().id).toBe(originalSession.id)
      expect(app.session().history.map(message => message.content)).toEqual([
        'before cancelled model search', 'Native catalog answer', 'clean chat after cancellation', 'Native catalog answer'
      ])
      await app.openModels()
      const query = 'REFRESHED AURORA'
      await app.setup.mockInput.typeText(query)
      await app.setup.waitForFrame(frame => frame.includes('No matching models'))
      app.setup.mockInput.pressKey('r', { ctrl: true })
      await app.setup.waitForFrame(frame => frame.includes('Models ·') && frame.includes(refreshed.id))
      expect(app.composer().plainText).toBe(query)
      expect(app.session().id).toBe(originalSession.id)
      expect(await app.preferences.load()).toEqual(app.defaults)
      expect(calls).toEqual([
        { provider, refresh: false }, { provider, refresh: false }, { provider, refresh: false }, { provider, refresh: true }
      ])
      const afterModel = app.ready.nextComposer()
      app.setup.mockInput.pressEnter()
      await afterModel
      await app.setup.waitForFrame(frame => frame.includes(`${provider} / ${refreshed.id}`) && !frame.includes('Models ·'))
      expect(app.session().id).not.toBe(originalSession.id)
      expect(app.session().model).toBe(refreshed.id)
      expect(await app.preferences.load()).toEqual({ ...app.defaults, model: refreshed.id })
      expect(app.composer().plainText).toBe('')
      await app.chat('clean chat after refresh')
      expect(app.requests.at(-1)).toEqual({ sessionId: app.session().id, model: refreshed.id, prompt: 'clean chat after refresh' })
      const preserved = await new FileSessionStore(app.directory).load(originalSession.id)
      expect(preserved.model).toBe('saved-default-model')
      expect(preserved.history.map(message => message.content)).toEqual([
        'before cancelled model search', 'Native catalog answer', 'clean chat after cancellation', 'Native catalog answer'
      ])
      await app.setup.mockInput.typeText('/exit')
      app.setup.mockInput.pressEnter()
      expect(await app.running).toBe(0)
      expect((await readdir(app.directory)).some(name => name.endsWith('.lock'))).toBe(false)
    } finally { await app.close() }
  }, 20000)
}
