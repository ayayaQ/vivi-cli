// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TextareaRenderable, TextRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { main } from '../src/main.js'
import { OpenTuiIO } from '../src/tui.js'
import { PreferenceStore } from '../src/preferences.js'

test('Ctrl+P opens real settings subviews, returns to filtered commands and leaves the conversation clean', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-control-modal-'))
  const setup = await createTestRenderer({ width: 110, height: 36, kittyKeyboard: true, exitOnCtrlC: false,
    exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  const node = (id: string) => setup.renderer.root.findDescendantById(id)!
  const frame = async () => { await new Promise(resolve => setTimeout(resolve, 2)); await setup.renderOnce(); await setup.renderOnce() }
  const title = () => (node('vivi-control-title') as TextRenderable | undefined)?.plainText
  const waitFor = async (value: string) => {
    await setup.waitForFrame(() => title() === value); await frame()
  }
  const search = async (text: string) => {
    setup.mockInput.pressKey('u', { ctrl: true }); await setup.mockInput.typeText(text); await frame(); setup.mockInput.pressEnter()
  }
  let ready!: () => void
  const started = new Promise<void>(resolve => { ready = resolve })
  const readLine = io.readLine.bind(io)
  io.readLine = (prompt, signal) => { const reading = readLine(prompt, signal); ready(); return reading }
  let running: Promise<number> | undefined, requests = 0
  try {
    await new PreferenceStore(directory).save({ schemaVersion: 1, provider: 'openai', model: 'gpt-5.1', reasoning: 'default',
      reasoningCapabilities: [], enableTools: false, enableNotes: false, enableMemory: false, stream: false, maxRounds: 7 })
    running = main(['--no-workspace'], { VIVI_SESSION_DIR: directory }, { tuiIO: io,
      providerFactory: () => ({ async generate() { requests++; throw new Error('Settings must not generate a response') } }) })
    await started; await frame()
    const transcript = node('vivi-transcript'), initial = transcript.getChildren().length
    setup.mockInput.pressKey('p', { ctrl: true }); await waitFor('Commands')
    await search('context'); await waitFor('Settings / Context')
    expect(setup.captureCharFrame()).toContain('Input tokens')
    expect(node('vivi-control-body').visible).toBe(true)
    expect(transcript.getChildren().length).toBe(initial)
    setup.mockInput.pressEscape(); await waitFor('Commands')
    expect((node('vivi-control-query') as TextareaRenderable).plainText).toBe('context')
    await search('session'); await waitFor('Settings / Session')
    expect(setup.captureCharFrame()).toContain('Workspace')
    setup.mockInput.pressEscape(); await waitFor('Commands')
    await search('help'); await waitFor('Settings / Help')
    setup.mockInput.pressKey('pagedown'); await frame()
    setup.mockInput.pressEscape(); await waitFor('Commands')
    setup.mockInput.pressEscape()
    await setup.waitForFrame(() => !node('vivi-control-overlay')); await frame()
    expect(transcript.getChildren().length).toBe(initial)
    expect(requests).toBe(0)
    expect(node('vivi-root').opacity).toBe(1)
    await setup.mockInput.typeText('/exit'); setup.mockInput.pressEnter(); expect(await running).toBe(0)
  } finally {
    io.close(); await running?.catch(() => undefined); setup.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)

test('direct slash commands and footer shortcuts share modal settings, preserve drafts and keep output local', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-direct-modal-'))
  const setup = await createTestRenderer({ width: 110, height: 36, kittyKeyboard: true, exitOnCtrlC: false,
    exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  const node = (id: string) => setup.renderer.root.findDescendantById(id)!
  const frame = async () => { await new Promise(resolve => setTimeout(resolve, 2)); await setup.renderOnce(); await setup.renderOnce() }
  const title = () => (node('vivi-control-title') as TextRenderable | undefined)?.plainText ?? ''
  const modal = async (prefix: string) => {
    await setup.waitForFrame(() => title().startsWith(`Settings / ${prefix}`) &&
      (node('vivi-control-body')?.visible || (node('vivi-control-query') as TextareaRenderable | undefined)?.focused)); await frame()
    expect(node('vivi-control-overlay')).toBeDefined()
    expect(node('vivi-picker-box').visible).toBe(false)
    expect(node('vivi-root').opacity).toBe(0.35)
  }
  const idle = async () => {
    for (let attempt = 0; attempt < 1000 && (node('vivi-control-overlay') || !(node('vivi-composer') as TextareaRenderable).focused); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 5)); await setup.renderOnce()
    }
    expect(node('vivi-control-overlay')).toBeUndefined()
    expect((node('vivi-composer') as TextareaRenderable).focused).toBe(true)
    await frame()
  }
  const command = async (text: string) => { await setup.mockInput.typeText(text); setup.mockInput.pressEnter() }
  const cancel = async () => { setup.mockInput.pressEscape(); await idle() }
  let running: Promise<number> | undefined, requests = 0
  try {
    await new PreferenceStore(directory).save({ schemaVersion: 1, provider: 'openai', model: 'gpt-5.1', reasoning: 'default',
      reasoningCapabilities: ['low', 'medium', 'high'], enableTools: false, enableNotes: false, enableMemory: false, stream: false, maxRounds: 7 })
    running = main(['--no-workspace'], { VIVI_SESSION_DIR: directory }, { tuiIO: io,
      credentials: { status: async () => ({ available: false, label: 'Offline vault' }), load: async () => undefined,
        save: async () => { throw new Error('No credential writes expected') } },
      catalog: { list: async () => ({ state: 'cached', models: [{ id: 'gpt-5.1', name: 'Fixture GPT', conversation: 'supported',
        tools: 'unsupported', streaming: 'supported', reasoning: 'supported', efforts: ['low', 'medium', 'high'],
        reasoningMandatory: false, source: 'Offline fixture' }] }) },
      providerFactory: () => ({ async generate() { requests++; throw new Error('Settings must not call a provider') } }) })
    await idle()
    const transcript = node('vivi-transcript'), initial = transcript.getChildren().length
    for (const [slash, heading] of [['/provider', 'Provider'], ['/models', 'Models ·'], ['/effort', 'Reasoning effort'],
      ['/notes', 'Session notes'], ['/web', 'Web provider'], ['/account', 'ChatGPT account controls']]) {
      await command(slash!); await modal(heading!); await cancel()
      expect(transcript.getChildren().length).toBe(initial)
    }
    for (const [slash, heading, content] of [['/context', 'Context', 'Input tokens'], ['/session', 'Session', 'Workspace'],
      ['/help', 'Help', 'Commands and shortcuts'], ['/usage', 'ChatGPT usage', 'Manage your plan'],
      ['/queue', 'Queue', 'No queued messages'], ['/instructions', 'Instructions', 'Project instructions'],
      ['/not-a-command', 'Not-a-command', 'Unknown slash command']]) {
      await command(slash!); await modal(heading!)
      expect(node('vivi-control-body').visible).toBe(true)
      expect(setup.captureCharFrame()).toContain(content!)
      await cancel(); expect(transcript.getChildren().length).toBe(initial)
    }
    await setup.mockInput.typeText('Keep this unfinished draft'); await frame()
    const footer = node('vivi-model') as TextRenderable
    expect(footer.plainText).toContain('gpt-5.1 · default')
    const effortX = footer.x + footer.plainText.indexOf('default')
    // A press on one target and release on the other cannot open either view.
    await setup.mockMouse.pressDown(footer.x + 3, footer.y)
    await setup.mockMouse.release(effortX, footer.y)
    expect(node('vivi-control-overlay')).toBeUndefined()
    await setup.mockMouse.click(footer.x + 3, footer.y); await modal('Models ·'); await cancel()
    expect((node('vivi-composer') as TextareaRenderable).plainText).toBe('Keep this unfinished draft')
    await setup.mockMouse.click(effortX, footer.y); await modal('Reasoning effort')
    await setup.mockInput.typeText('medium'); await frame(); setup.mockInput.pressEnter()
    await idle()
    expect(footer.plainText).toContain('gpt-5.1 · medium')
    expect(footer.plainText).not.toContain('reasoning')
    expect((node('vivi-composer') as TextareaRenderable).plainText).toBe('Keep this unfinished draft')
    expect((await new PreferenceStore(directory).load())?.reasoning).toBe('medium')
    expect(transcript.getChildren().length).toBe(initial)
    expect(requests).toBe(0)
    setup.mockInput.pressKey('u', { ctrl: true }); await command('/exit'); expect(await running).toBe(0)
  } finally {
    io.close(); await running?.catch(() => undefined); setup.renderer.destroy()
    await rm(directory, { recursive: true, force: true })
  }
}, 20000)
