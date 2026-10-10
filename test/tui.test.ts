// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, spyOn, test } from 'bun:test'
import { BoxRenderable, CliRenderEvents, CodeRenderable, RGBA, SelectRenderable,
  TextareaRenderable, TextRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import type { TestRendererSetup } from '@opentui/core/testing'
import type { AgentResult, HistoryMessage } from '@ayayaq/vivi'
import { getSlashCommandCompletions, OpenTuiIO, SLASH_COMMANDS, TUI_THEME } from '../src/tui.js'
import { newSession } from '../src/session.js'
import { WindowsInputDecoder } from '../src/windows-input.js'

const fixtures: { io: OpenTuiIO; setup: TestRendererSetup }[] = []
afterEach(async () => {
  for (const { io } of fixtures.splice(0)) io.close()
  await Promise.resolve()
})
async function fixture(options: { stream?: boolean; secrets?: readonly string[]; width?: number; height?: number;
  kittyKeyboard?: boolean } = {}) {
  const setup = await createTestRenderer({ width: options.width ?? 100, height: options.height ?? 30,
    kittyKeyboard: options.kittyKeyboard ?? true, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer, options)
  fixtures.push({ io, setup })
  const frame = async (): Promise<string> => {
    await setup.renderOnce()
    await setup.renderOnce()
    return setup.captureCharFrame()
  }
  return { io, setup, frame, input: setup.mockInput }
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2))
const history = (content: string): HistoryMessage[] => [
  { kind: 'message', role: 'user', content: 'Hello' },
  { kind: 'assistant', content, toolCalls: [] }
]
const result = (content: string, status: AgentResult['status'] = 'completed'): AgentResult => ({
  status, content, history: status === 'completed' ? history(content) : [{ kind: 'message', role: 'user', content: 'Hello' }],
  rounds: 1, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
})
const request = { call: { id: 'note-1', name: 'note_set', arguments: { key: 'topic', value: 'test', expectedRevision: 4 } },
  description: 'Set session note topic to test', currentRevision: 4 }
const renderedText = (node: Renderable): string => [
  node instanceof TextRenderable || node instanceof TextareaRenderable ? node.plainText : '',
  node instanceof BoxRenderable ? `${node.title ?? ''} ${node.bottomTitle ?? ''}` : '',
  node instanceof SelectRenderable ? JSON.stringify(node.options) : '',
  ...node.getChildren().map(renderedText)
].join('\n')

test('slash command helpers match only the sole starting token', () => {
  expect(SLASH_COMMANDS.map(({ command }) => command)).toEqual([
    '/provider', '/models', '/effort', '/mode', '/new', '/resume', '/rename', '/settings', '/memories', '/commands', '/skills', '/mcp', '/menu', '/help', '/session', '/exit'
  ])
  expect(getSlashCommandCompletions('/')).toEqual(SLASH_COMMANDS)
  expect(getSlashCommandCompletions('/m').map(({ command }) => command)).toEqual(['/models', '/mode', '/memories', '/mcp', '/menu'])
  expect(getSlashCommandCompletions('/provider').map(({ command }) => command)).toEqual(['/provider'])
  expect(getSlashCommandCompletions('/commands').map(({ command }) => command)).toEqual(['/commands'])
  for (const input of ['', 'message', ' /m', 'message /m', '/m ', '/models argument', '/m\n', '/unknown']) {
    expect(getSlashCommandCompletions(input)).toEqual([])
  }
})

test('autocomplete renders above composer, arrows cycle and Tab accepts without submitting', async () => {
  const { io, setup, input, frame } = await fixture()
  const line = io.readLine('Message')
  let submitted = false
  void line.then(() => { submitted = true })
  await input.typeText('/m')
  const display = await frame()
  expect(display).toContain('› /models')
  expect(display).toContain('/menu')
  const completions = setup.renderer.root.findDescendantById('vivi-completions')!
  const composerBox = setup.renderer.root.findDescendantById('vivi-composer-box')!
  expect(completions.y + completions.height).toBeLessThanOrEqual(composerBox.y)
  input.pressArrow('up') // Wrap from the first match to the last.
  expect(await frame()).toContain('› /menu')
  input.pressArrow('down')
  expect(await frame()).toContain('› /models')
  input.pressArrow('down')
  input.pressArrow('down')
  input.pressArrow('down')
  input.pressArrow('down')
  input.pressTab()
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  expect(composer.plainText).toBe('/menu')
  expect(completions.visible).toBe(false)
  await Promise.resolve()
  expect(submitted).toBe(false)
  input.pressEnter()
  expect(await line).toBe('/menu')
})

test('autocomplete leaves ordinary text, arguments, unknown commands and askText alone', async () => {
  const { io, setup, input, frame } = await fixture()
  for (const text of ['ordinary /m', '/models argument', '/unknown']) {
    const line = io.readLine('Message')
    await input.typeText(text)
    await frame()
    const completions = setup.renderer.root.findDescendantById('vivi-completions')!
    expect(completions.visible).toBe(false)
    input.pressArrow('left')
    input.pressArrow('right')
    input.pressTab()
    input.pressEnter()
    expect(await line).toBe(text)
  }
  const text = io.askText('Model identifier')
  await input.typeText('/m')
  expect(setup.renderer.root.findDescendantById('vivi-completions')!.visible).toBe(false)
  input.pressTab()
  input.pressEnter()
  expect(await text).toBe('/m')
})

test('autocomplete keeps the composer visible in a compact native terminal', async () => {
  const { io, setup, input, frame } = await fixture({ width: 40, height: 12 })
  const line = io.readLine('Message')
  await input.typeText('/')
  expect(await frame()).toContain('› /provider')
  const completions = setup.renderer.root.findDescendantById('vivi-completions')!
  const composer = setup.renderer.root.findDescendantById('vivi-composer-box')!
  expect(completions.y + completions.height).toBeLessThanOrEqual(composer.y)
  expect(composer.y + composer.height).toBeLessThanOrEqual(12)
  io.close()
  expect(await line).toBeUndefined()
})

test('autocomplete clears on Escape, aborted input and running-turn cancellation', async () => {
  const { io, setup, input, frame } = await fixture()
  const controller = new AbortController()
  const line = io.readLine('Message', controller.signal)
  const rejected = line.catch((error: Error) => error.message)
  await input.typeText('/s')
  expect(await frame()).toContain('› /settings')
  input.pressEscape()
  expect(setup.renderer.root.findDescendantById('vivi-completions')!.visible).toBe(false)
  expect((setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable).plainText).toBe('')
  await input.typeText('/p')
  controller.abort()
  expect(await rejected).toBe('Input cancelled')
  expect(setup.renderer.root.findDescendantById('vivi-completions')!.visible).toBe(false)
  const next = io.readLine('Message')
  await input.typeText('/m')
  let cancellations = 0
  const dispose = io.onCancel(() => { cancellations++ })
  input.pressTab()
  input.pressEscape()
  expect(cancellations).toBe(1)
  expect(setup.renderer.root.findDescendantById('vivi-completions')!.visible).toBe(false)
  dispose()
  io.close()
  expect(await next).toBeUndefined()
})

test('API key typing is bullet-only in frames, widgets and logs, then immediately redacted', async () => {
  const { io, setup, input, frame } = await fixture()
  const secret = 'sk-live-never-render-me'
  const logs: string[] = []
  const spies = ['log', 'warn', 'error'].map((method) => spyOn(console, method as 'log')
    .mockImplementation((...values: unknown[]) => { logs.push(values.map(String).join(' ')) }))
  try {
    const answer = io.askSecret('OpenAI API key')
    for (let index = 0; index < secret.length; index++) {
      await input.typeText(secret[index]!)
      const display = await frame()
      expect(display).toContain('•')
      if (index >= 2) {
        const prefix = secret.slice(0, index + 1)
        expect(display).not.toContain(prefix)
        expect(renderedText(setup.renderer.root)).not.toContain(prefix)
        expect(JSON.stringify(setup.captureSpans())).not.toContain(prefix)
      }
      expect((setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable).plainText).toBe('')
    }
    input.pressEnter()
    expect(await answer).toBe(secret)
    expect((setup.renderer.root.findDescendantById('vivi-secret-mask') as TextRenderable).plainText).toBe('')
    io.write(`Provider rejected ${secret}`)
    io.event({ type: 'tool_started', call: { id: 'key', name: secret, arguments: {} } })
    const session = newSession({ provider: 'openai', model: secret })
    session.history = history(`Response echoed ${secret}`)
    io.setSession(session)
    const display = await frame()
    expect(display).toContain('[REDACTED]')
    expect(display).not.toContain(secret)
    expect(renderedText(setup.renderer.root)).not.toContain(secret)
    expect(logs.join('\n')).not.toContain(secret)
    expect(setup.externalOutput.takeText()).not.toContain(secret)
  } finally { for (const spy of spies) spy.mockRestore() }
})

test('API key paste and editing use only the password model and never render pasted text', async () => {
  const { io, setup, input, frame } = await fixture()
  const secret = 'pasted-api-key-123'
  const answer = io.askSecret('Paste API key')
  await input.pasteBracketedText(secret)
  expect(await frame()).not.toContain(secret)
  expect(renderedText(setup.renderer.root)).not.toContain(secret)
  expect((setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable).plainText).toBe('')
  input.pressArrow('left')
  input.pressBackspace()
  await input.typeText('X')
  input.pressKey('HOME')
  await input.typeText('!')
  input.pressKey('END')
  input.pressEnter()
  expect(await answer).toBe('!pasted-api-key-1X3')
  expect(await frame()).not.toContain('pasted-api-key')
  const pastedKnown = io.askSecret('Enter the same saved key again')
  await input.pasteBracketedText('!pasted-api-key-1X3')
  input.pressEnter()
  expect(await pastedKnown).toBe('!pasted-api-key-1X3')
})

test('API key cancellation, replacement, clear and repeated prompts cannot carry stale characters', async () => {
  const { io, setup, input, frame } = await fixture()
  const first = io.askSecret('First API key')
  await input.typeText('discard-on-cancel')
  input.pressEscape()
  expect(await first).toBeUndefined()
  const mask = setup.renderer.root.findDescendantById('vivi-secret-mask') as TextRenderable
  expect(mask.plainText).toBe('')
  const second = io.askSecret('Second API key')
  input.pressEnter()
  expect(await second).toBe('')
  const replaced = io.askSecret('Replace this key')
  await input.typeText('discard-on-replace')
  const replacement = io.askSecret('Replacement API key')
  expect(await replaced).toBeUndefined()
  await input.typeText('clear-this-key')
  input.pressKey('u', { ctrl: true })
  await input.typeText('fresh-secret')
  input.pressEnter()
  expect(await replacement).toBe('fresh-secret')
  const line = io.readLine('Message')
  input.pressKey('-', { ctrl: true }) // The ordinary editor has no password undo history.
  expect(await frame()).not.toContain('fresh-secret')
  expect(renderedText(setup.renderer.root)).not.toContain('discard-on-')
  input.pressEnter()
  expect(await line).toBe('')
})

test('API key close and renderer failures clear the model and redact the active credential', async () => {
  for (const action of ['close', 'escape', 'ctrl-c', 'destroy', 'error'] as const) {
    const { io, setup, input, frame } = await fixture()
    const secret = 'active-secret-never-printed'
    const answer = io.askSecret('API key')
    const outcome = answer.catch((error: Error) => error.message)
    await input.typeText(secret)
    expect(await frame()).not.toContain(secret)
    const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
    const mask = setup.renderer.root.findDescendantById('vivi-secret-mask') as TextRenderable
    expect(composer.plainText).toBe('')
    if (action === 'error') setup.renderer.emit(CliRenderEvents.HANDLER_ERROR,
      { error: new Error(`Failure ${secret.slice(0, 10)}\x1b[31m${secret.slice(10)}\x1b[0m`) })
    else if (action === 'close') io.close()
    else if (action === 'destroy') setup.renderer.destroy()
    else if (action === 'escape') input.pressEscape()
    else input.pressCtrlC()
    expect(await outcome).toBe(action === 'error' ? 'OpenTUI renderer failed: failure while reading hidden input' : undefined)
    expect((io as unknown as { secretInput: string[] }).secretInput).toEqual([])
    if (!mask.isDestroyed) expect(mask.plainText).toBe('')
    expect(setup.externalOutput.takeText()).not.toContain(secret)
  }
})

test('password input handler failures are redacted before OpenTUI can log them', async () => {
  for (const handler of ['handleKey', 'handlePaste'] as const) {
    const { io, input } = await fixture()
    const secret = 'secret-only-in-password-model'
    const answer = io.askSecret('API key')
    const outcome = answer.catch((error: Error) => error.message)
    await input.typeText(secret)
    const logs: string[] = []
    const logger = spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
      logs.push(values.map(String).join(' '))
    })
    try {
      Object.assign(io, { [handler]: () => { throw new Error(`Input handler failure ${secret.slice(0, 7)}`) } })
      if (handler === 'handleKey') input.pressKey('F1')
      else await input.pasteBracketedText('irrelevant')
      expect(await outcome).toBe('OpenTUI renderer failed: failure while reading hidden input')
      expect(logs.join('\n')).not.toContain(secret)
      expect(logs.join('\n')).not.toContain(secret.slice(0, 7))
      expect(io.isClosed).toBe(true)
      expect((io as unknown as { secretInput: string[] }).secretInput).toEqual([])
    } finally { logger.mockRestore() }
  }
})

test('API key entry fails closed when OpenTUI raw input logging or debug capture is enabled', async () => {
  for (const capture of [{ stdinLogPath: '/unused-test-capture.log' }, { _debugModeEnabled: true }]) {
    const { io, setup, input, frame } = await fixture()
    const earlier = io.readLine('Message')
    await input.typeText('ordinary draft')
    Object.assign(setup.renderer, capture)
    await expect(io.askSecret('API key')).rejects.toThrow('Disable OTUI_STDIN_LOG and OTUI_DEBUG')
    expect(await earlier).toBeUndefined()
    expect(await frame()).toContain('API key entry blocked')
    expect((setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable).plainText).toBe('')
    expect((io as unknown as { secretInput: string[] }).secretInput).toEqual([])
    Object.assign(setup.renderer, { stdinLogPath: '', _debugModeEnabled: false })
    const safe = io.askSecret('API key')
    await input.typeText('safe-now')
    input.pressEnter()
    expect(await safe).toBe('safe-now')
  }
})

test('API key entry also refuses publicly opted-in raw input capture', async () => {
  const original = { log: process.env.OTUI_STDIN_LOG, debug: process.env.OTUI_DEBUG }
  try {
    for (const capture of [{ OTUI_STDIN_LOG: '/unused-test-capture.log', OTUI_DEBUG: 'false' },
      { OTUI_STDIN_LOG: '', OTUI_DEBUG: 'true' }]) {
      const { io, frame } = await fixture()
      Object.assign(process.env, capture)
      await expect(io.askSecret('API key')).rejects.toThrow('Disable OTUI_STDIN_LOG and OTUI_DEBUG')
      expect(await frame()).toContain('API key entry blocked')
      expect((io as unknown as { secretInput: string[] }).secretInput).toEqual([])
      process.env.OTUI_STDIN_LOG = ''
      process.env.OTUI_DEBUG = 'false'
    }
  } finally {
    if (original.log === undefined) delete process.env.OTUI_STDIN_LOG
    else process.env.OTUI_STDIN_LOG = original.log
    if (original.debug === undefined) delete process.env.OTUI_DEBUG
    else process.env.OTUI_DEBUG = original.debug
  }
})

test('API key input rejects an oversized paste without storing or displaying it', async () => {
  const { io, setup, input, frame } = await fixture()
  const answer = io.askSecret('API key')
  await input.typeText('short-key')
  await input.pasteBracketedText('oversized-secret'.repeat(400))
  expect(await frame()).toContain('API key input limit: 4096 characters')
  expect(renderedText(setup.renderer.root)).not.toContain('oversized-secret')
  input.pressEnter()
  expect(await answer).toBe('short-key')
})

test('API key input rejects malformed paste whole instead of silently changing the credential', async () => {
  const { io, setup, input, frame } = await fixture()
  for (const malformed of ['rejected-secret\n', 'rejected\tsecret', 'rejected\rsecret',
    'rejected\x1b[31msecret', 'rejected\u202esecret', 'rejected\u200fsecret',
    'rejected\u2066secret', 'rejected\u2028secret', 'rejected\x00secret']) {
    const answer = io.askSecret('API key')
    await input.pasteBracketedText('prior-key')
    await input.pasteBracketedText(malformed)
    expect(await frame()).toContain('API key input rejected')
    expect(renderedText(setup.renderer.root)).not.toContain('rejected-secret')
    input.pressEnter()
    expect(await answer).toBe('prior-key')
  }
  const typed = io.askSecret('API key')
  await input.typeText('exact-key')
  await input.typeText('\u202e')
  expect(await frame()).toContain('API key input rejected')
  input.pressEnter()
  expect(await typed).toBe('exact-key')
})

test('API key input length is bounded in UTF-16 code units without altering valid Unicode', async () => {
  const { io, input, frame } = await fixture()
  const answer = io.askSecret('API key')
  await input.pasteBracketedText('🔑'.repeat(2049))
  expect(await frame()).toContain('API key input limit: 4096 characters')
  await input.pasteBracketedText('🔑'.repeat(2048))
  input.pressEnter()
  expect(await answer).toBe('🔑'.repeat(2048))
})

test('newly registered secrets redact prior surfaces and split streaming fragments', async () => {
  const { io, input, frame } = await fixture()
  const secret = 'dynamically-added-credential'
  io.write(`Prior diagnostic ${secret}`)
  io.addSecrets([secret, secret, ''])
  expect(await frame()).not.toContain(secret)
  for (const text of ['Reply dynamically-', 'added-', 'credential and more output'.repeat(3)]) {
    io.event({ type: 'text_delta', text })
    const display = await frame()
    expect(display).not.toContain(secret)
    expect(display).not.toContain('dynamically-')
  }
  const line = io.readLine('Message')
  await input.pasteBracketedText(`ordinary ${secret}`)
  input.pressEnter()
  expect(await line).toBe('ordinary [REDACTED]')
})

test('pink and lavender colors are configured and present in native frame spans', async () => {
  const { io, setup, input, frame } = await fixture()
  const line = io.readLine('Message')
  await input.typeText('/m')
  await frame()
  const header = setup.renderer.root.findDescendantById('vivi-header') as TextRenderable
  const composerBox = setup.renderer.root.findDescendantById('vivi-composer-box') as BoxRenderable
  const completions = setup.renderer.root.findDescendantById('vivi-completions') as BoxRenderable
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  expect(header.fg.equals(RGBA.fromHex(TUI_THEME.pink))).toBe(true)
  expect(composerBox.borderColor.equals(RGBA.fromHex('#f87ea2'))).toBe(true)
  expect(completions.borderColor.equals(RGBA.fromHex('#b08bfc'))).toBe(true)
  expect(composer.cursorColor.equals(RGBA.fromHex(TUI_THEME.lavender))).toBe(true)
  const colors = setup.captureSpans().lines.flatMap((row) => row.spans.map((span) => span.fg.toInts().slice(0, 3)))
  expect(colors).toContainEqual([248, 126, 162])
  expect(colors).toContainEqual([176, 139, 252])
  io.close()
  expect(await line).toBeUndefined()
})

test('renders session header, canonical roles, tools, usage and command hints', async () => {
  const { io, setup, frame } = await fixture({ height: 40 })
  const session = newSession({ provider: 'openai', model: 'mock-model', reasoning: 'high' })
  session.history = [...history('## A heading\n\nA **bold** response'),
    { kind: 'tool_result', callId: 'tool-1', name: 'calculate', content: '{"result":2}' }]
  session.usage = { inputTokens: 9, outputTokens: 8, totalTokens: 17 }
  io.setSession(session)
  const output = await frame()
  expect(output).toContain('openai / mock-model')
  expect((setup.renderer.root.findDescendantById('vivi-header') as TextRenderable).plainText).not.toContain(session.id)
  expect(output).toContain(`cli-session:${session.id}:history:2`)
  expect(output).toContain('reasoning high')
  expect(output).toContain('You')
  expect(output).toContain('Assistant')
  expect(output).toContain('A heading')
  expect(output).toContain('Tool calculate')
  expect(output).toContain('9 in / 8 out / 17 total')
  expect(output).toContain('/new /resume /mode /memories /skills /mcp /settings /menu /help /exit')
})

test('native status labels round, turn and session cache telemetry without inventing zero', async () => {
  const { io, frame } = await fixture({ width: 160, height: 24 })
  const session = newSession({ provider: 'openai', model: 'fake-cache-model' })
  session.usage = { inputTokens: 3, outputTokens: 2, totalTokens: 7, cachedInputTokens: 0 }
  io.setSession(session)
  expect(await frame()).toContain('Session tokens: 3 in / 2 out / 7 total')
  expect(await frame()).toContain('Cache input: read 0 / write unreported')
  io.event({ type: 'round_completed', usage: {
    inputTokens: 1, outputTokens: 2, totalTokens: 5, cacheWriteInputTokens: 0
  } })
  expect(await frame()).toContain('Round tokens: 1 in / 2 out / 5 total')
  expect(await frame()).toContain('Cache input: read unreported / write 0')
  io.event({ type: 'round_completed' })
  expect(await frame()).toContain('Round tokens: 0 in / 0 out / 0 total')
  expect(await frame()).toContain('Cache input: read unreported / write unreported')
  io.result({ ...result('Accepted'), usage: {
    inputTokens: 4, outputTokens: 4, totalTokens: 12, cachedInputTokens: 0, cacheWriteInputTokens: 0
  } })
  expect(await frame()).toContain('Turn tokens: 4 in / 4 out / 12 total')
  expect(await frame()).toContain('Cache input: read 0 / write 0')
  io.setSession(session)
  expect(await frame()).toContain('Session tokens: 3 in / 2 out / 7 total')
  expect(await frame()).toContain('Cache input: read 0 / write unreported')
})

test('compact native cache telemetry remains visible and fresh chats clear the prior counts', async () => {
  const { io, frame } = await fixture({ width: 40, height: 20 })
  const session = newSession({ provider: 'openai', model: 'compact-cache' })
  session.usage = { inputTokens: 3, outputTokens: 2, totalTokens: 7, cachedInputTokens: 0, cacheWriteInputTokens: 0 }
  io.setSession(session)
  expect(await frame()).toContain('Session I/O/T 3/2/7 · cache R/W 0/0')
  io.setDraft('openrouter')
  const output = await frame()
  expect(output).toContain('Session I/O/T 0/0/0 · cache R/W ?/?')
  expect(output).not.toContain('cache R/W 0/0')
})

test('Enter submits; Shift and Alt Enter compose multiline with preserved draft', async () => {
  const { io, input, frame } = await fixture()
  const line = io.readLine('Message')
  await input.typeText('first')
  input.pressEnter({ shift: true })
  await input.typeText('second')
  input.pressEnter({ meta: true })
  await input.typeText('third')
  expect(await frame()).toContain('third')
  input.pressEnter()
  expect(await line).toBe('first\nsecond\nthird')
  const next = io.readLine('Message')
  input.pressEnter()
  expect(await next).toBe('')
})

test('reported Shift+Enter inserts one newline through Kitty, keypad and modifyOtherKeys input', async () => {
  for (const sequence of ['\x1b[13;2u', '\x1b[57414;2u', '\x1b[27;2;13~']) {
    const { io, setup, input } = await fixture()
    const line = io.readLine('Message')
    let submitted = false
    void line.then(() => { submitted = true })
    await input.typeText('first')
    await input.pressKeys([sequence])
    const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
    expect(composer.plainText).toBe('first\n')
    await Promise.resolve()
    expect(submitted).toBe(false)
    await input.typeText('second')
    input.pressEnter()
    expect(await line).toBe('first\nsecond')
  }
})

test('Ctrl+J fallback inserts a newline in legacy and Kitty terminals without submitting', async () => {
  for (const kittyKeyboard of [false, true]) {
    const { io, setup, input, frame } = await fixture({ kittyKeyboard })
    const line = io.readLine('Message')
    let submitted = false
    void line.then(() => { submitted = true })
    await input.typeText('first')
    input.pressKey('j', { ctrl: true })
    const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
    expect(composer.plainText).toBe('first\n')
    await Promise.resolve()
    expect(submitted).toBe(false)
    // Chat now uses this row for the bottom actions; help still documents Ctrl+J.
    expect(await frame()).toContain('Menu  Models')
    await input.pasteBracketedText('second\nthird')
    input.pressEnter()
    expect(await line).toBe('first\nsecond\nthird')
  }
})

test('legacy Shift+Enter remains indistinguishable from Enter while Ctrl+J is a separate fallback', async () => {
  const { io, input } = await fixture({ kittyKeyboard: false })
  const first = io.readLine('Message')
  await input.typeText('plain CR')
  input.pressEnter({ shift: true }) // Legacy input has no Shift modifier, only CR.
  expect(await first).toBe('plain CR')
  const next = io.readLine('Message')
  await input.typeText('first')
  await input.pressKeys(['\n']) // The LF byte from Ctrl+J is not a CR submit.
  await input.typeText('second')
  input.pressEnter()
  expect(await next).toBe('first\nsecond')
})

test('newline fallback preserves cursor position, selection replacement and undo history', async () => {
  const { io, setup, input } = await fixture()
  const line = io.readLine('Message')
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  await input.typeText('leftright')
  for (let i = 0; i < 5; i++) input.pressArrow('left')
  input.pressKey('j', { ctrl: true })
  expect(composer.plainText).toBe('left\nright')
  expect(composer.cursorOffset).toBe(5)
  input.pressKey('-', { ctrl: true })
  expect(composer.plainText).toBe('leftright')
  input.pressKey('.', { ctrl: true })
  expect(composer.plainText).toBe('left\nright')
  input.pressArrow('right', { shift: true })
  input.pressArrow('right', { shift: true })
  input.pressKey('j', { ctrl: true })
  expect(composer.plainText).toBe('left\n\nht')
  input.pressEnter()
  expect(await line).toBe('left\n\nht')
})

test('newline fallback hides slash completions and leaves Unicode and multiline paste intact', async () => {
  const { io, setup, input } = await fixture({ kittyKeyboard: false })
  const line = io.readLine('Message')
  await input.typeText('/m')
  const completions = setup.renderer.root.findDescendantById('vivi-completions')!
  expect(completions.visible).toBe(true)
  input.pressKey('j', { ctrl: true })
  expect(completions.visible).toBe(false)
  await input.pasteBracketedText('中文🙂é\nlast')
  input.pressArrow('left')
  await input.typeText('!')
  input.pressEnter()
  expect(await line).toBe('/m\n中文🙂é\nlas!t')
})

test('Ctrl+J adds lines to ordinary text prompts while confirmation prompts keep their keys', async () => {
  for (const kittyKeyboard of [false, true]) {
    const { io, setup, input, frame } = await fixture({ kittyKeyboard })
    const answer = io.askText('Edit text', 'first')
    const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
    composer.gotoBufferEnd()
    input.pressKey('j', { ctrl: true })
    await input.typeText('second')
    expect(await frame()).toContain('Ctrl+J newline')
    input.pressEnter()
    expect(await answer).toBe('first\nsecond')
    const choice = io.choose('Pick a choice', [{ name: 'One', value: 'one' }])
    input.pressEnter()
    expect(await choice).toBe('one')
    const secret = io.askSecret('Fake API key')
    await input.typeText('fake')
    input.pressEnter()
    expect(await secret).toBe('fake')
  }
})

test('newline key releases, running turns and cancelled drafts cannot edit a subsequent prompt', async () => {
  const { io, setup, input } = await fixture()
  const controller = new AbortController()
  const line = io.readLine('Message', controller.signal)
  const rejected = line.catch((error: Error) => error.message)
  await input.typeText('draft')
  await input.pressKeys(['\x1b[13;2:3u', '\x1b[106;5:3u'])
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  expect(composer.plainText).toBe('draft')
  const dispose = io.onCancel(() => {})
  input.pressKey('j', { ctrl: true })
  expect(composer.plainText).toBe('')
  dispose()
  controller.abort()
  expect(await rejected).toBe('Input cancelled')
  input.pressKey('j', { ctrl: true }) // There is no active editor.
  const next = io.readLine('Message')
  expect(composer.plainText).toBe('')
  input.pressEnter()
  expect(await next).toBe('')
})

test('Windows input-record Shift+Enter and keypad Enter compose without submitting', async () => {
  const { io, setup, input } = await fixture()
  const decoder = new WindowsInputDecoder()
  const record = async (text: string): Promise<void> => {
    const decoded = decoder.write(text)
    if (decoded) await input.pressKeys([decoded])
  }
  const line = io.readLine('Message')
  let submitted = false
  void line.then(() => { submitted = true })
  await input.typeText('first')
  await record('\x1b[13;28;13;1;16;1_')
  await record('\x1b[13;28;13;0;16;1_') // Key-up must not add a second line.
  await input.typeText('second')
  await record('\x1b[13;28;13;1;272;1_') // Keypad Enter retains Shift + ENHANCED_KEY.
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  expect(composer.plainText).toBe('first\nsecond\n')
  await Promise.resolve()
  expect(submitted).toBe(false)
  await input.typeText('third')
  await record('\x1b[13;28;13;1;0;1_')
  expect(await line).toBe('first\nsecond\nthird')
})

test('Windows input-record editing, Ctrl+J, IME text and bracketed paste preserve the draft', async () => {
  const { io, setup, input } = await fixture()
  const decoder = new WindowsInputDecoder()
  const record = async (text: string): Promise<void> => {
    const decoded = decoder.write(text)
    if (decoded) await input.pressKeys([decoded])
  }
  const line = io.readLine('Message')
  await record('\x1b[65;30;97;1;0;2_')
  await record('\x1b[37;75;0;1;256;1_')
  await record('\x1b[74;36;10;1;8;1_')
  await record('\x1b[0;0;20013;1;0;1_\x1b[0;0;25991;1;0;1_')
  await record('\x1b[0;0;55357;1;0;1_\x1b[0;0;56898;1;0;1_')
  await record('\x1b[200~pasted\n\x1b[13;28;13;1;16;1_\x1b[201~')
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  expect(composer.plainText).toBe('a\n中文🙂pasted\na')
  // The record-looking paste stayed text; the ordinary Enter record still submits.
  await record('\x1b[13;28;13;1;0;1_')
  expect(await line).toBe('a\n中文🙂pasted\na')
})

test('Windows zero-character undo/redo records and injected Unicode keep native editor semantics', async () => {
  const { io, setup, input } = await fixture()
  const decoder = new WindowsInputDecoder()
  const record = async (text: string): Promise<void> => {
    const decoded = decoder.write(text)
    if (decoded) await input.pressKeys([decoded])
  }
  const line = io.readLine('Message')
  await input.typeText('draft')
  await record('\x1b[66;48;0;1;2;1_')
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  expect(composer.cursorOffset).toBe(0)
  await record('\x1b[70;33;0;1;2;1_')
  expect(composer.cursorOffset).toBe(5)
  await record('\x1b[74;36;10;1;8;1_')
  expect(composer.plainText).toBe('draft\n')
  await record('\x1b[189;12;0;1;8;1_')
  expect(composer.plainText).toBe('draft')
  await record('\x1b[190;52;0;1;8;1_')
  expect(composer.plainText).toBe('draft\n')
  await record('\x1b[231;0;20013;1;8;1_')
  expect(composer.plainText).toBe('draft\n中')
  await record('\x1b[36;71;0;1;2;1_') // NumLock-off Alt-code digit must not move to Home.
  await record('\x1b[18;56;233;0;0;1_')
  expect(composer.plainText).toBe('draft\n中é')
  await record('\x1b[13;28;13;1;0;1_')
  expect(await line).toBe('draft\n中é')
})

test('Kitty repeat metadata cannot select or confirm an approval', async () => {
  const { io, input, frame } = await fixture()
  const answer = io.approve(request, new AbortController().signal)
  let finished = false
  void answer.then(() => { finished = true })
  await tick(); await frame()
  await input.pressKeys(['\x1b[9;1:2u', '\x1b[57351;1:2u'])
  expect(await frame()).toContain('› Deny')
  input.pressTab()
  expect(await frame()).toContain('› Approve')
  await input.pressKeys(['\x1b[13;1:2u', '\x1b[32;1:2u'])
  await Promise.resolve()
  expect(finished).toBe(false)
  input.pressKey(' ')
  expect(await answer).toBe(true)
})

test('Windows held keys and native repeat counts cannot act on later approval dialogs', async () => {
  const { io, input, frame } = await fixture()
  const decoder = new WindowsInputDecoder()
  const key = async (virtual: number, character: number, down = 1, repeat = 1): Promise<void> => {
    const decoded = decoder.write(`\x1b[${virtual};0;${character};${down};0;${repeat}_`)
    if (decoded) await input.pressKeys([decoded])
  }
  // These keys are already held before a proposal exists.
  for (const [virtual, character] of [[9, 9], [39, 0], [13, 13], [32, 32]]) await key(virtual!, character!)
  const first = io.approve(request, new AbortController().signal)
  let firstFinished = false
  void first.then(() => { firstFinished = true })
  await tick(); await frame()
  await key(9, 9, 1, 3)
  await key(39, 0)
  expect(await frame()).toContain('› Deny')
  await key(9, 0, 0)
  await key(9, 9)
  expect(await frame()).toContain('› Approve')
  await key(13, 13)
  await key(32, 32, 1, 3)
  await Promise.resolve()
  expect(firstFinished).toBe(false)
  await key(13, 0, 0)
  await key(13, 13)
  expect(await first).toBe(true)

  const second = io.approve(request, new AbortController().signal)
  let secondFinished = false
  void second.then(() => { secondFinished = true })
  await tick(); await frame()
  await key(39, 0)
  expect(await frame()).toContain('› Deny')
  await key(39, 0, 0)
  await key(39, 0)
  expect(await frame()).toContain('› Approve')
  await key(13, 13, 1, 3)
  await key(32, 32)
  await Promise.resolve()
  expect(secondFinished).toBe(false)
  input.pressEscape()
  expect(await second).toBe(false)
})

test('reporting restoration failure marks IO failed while closing the renderer and settling input', async () => {
  const { io, setup } = await fixture()
  const line = io.readLine('Message')
  // The real bridge's permanent-write failure is exercised in its stream tests.
  // Here, verify that the TUI does not silently report a successful shutdown.
  ;(io as unknown as { windowsInput: { close(): void } }).windowsInput = {
    close() { throw new Error('fake-output-detail') }
  }
  io.close()
  expect(await line).toBeUndefined()
  expect(io.failed).toBe(true)
  expect(io.isClosed).toBe(true)
  expect(setup.renderer.isDestroyed).toBe(true)
})

test('pickers dismiss with Escape and work repeatedly with typed values intact', async () => {
  const { io, input, frame } = await fixture()
  const options = [{ name: 'One', description: 'First option', value: { id: 1 } },
    { name: 'Two', description: 'Second option', value: { id: 2 } }]
  const first = io.choose('Choose model', options)
  expect(await frame()).toContain('Choose model')
  input.pressEscape()
  expect(await first).toBeUndefined()
  const second = io.choose('Choose again', options)
  input.pressArrow('down')
  input.pressEnter()
  expect(await second).toEqual({ id: 2 })
  const third = io.choose('Initial selection', options, 1)
  input.pressEnter()
  expect(await third).toEqual({ id: 2 })
  expect(await io.choose('Empty', [])).toBeUndefined()
  expect(await frame()).not.toContain('Initial selection')
})

const searchableWidgets = (setup: TestRendererSetup) => ({
  composer: setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable,
  composerBox: setup.renderer.root.findDescendantById('vivi-composer-box') as BoxRenderable,
  pickerBox: setup.renderer.root.findDescendantById('vivi-picker-box') as BoxRenderable,
  picker: setup.renderer.root.findDescendantById('vivi-picker') as SelectRenderable
})

test('searchable picker filters thousands of exact values live by normalized ID, name and provider tokens', async () => {
  const { io, setup, input, frame } = await fixture()
  const target = { id: 'vendor.one/Exact-ID.v2', nested: { preserve: true } }
  const sibling = { id: 'other/Zephyr.v1' }
  const choices = [
    ...Array.from({ length: 3200 }, (_, index) => ({ name: `filler/model-${index.toString().padStart(4, '0')}`,
      description: 'conversation supported · tools supported', searchTerms: ['ordinary', 'openai'], value: { id: index } })),
    { name: target.id, description: 'Zephyr Friendly Name · tools supported', searchTerms: ['Zephyr Friendly Name', 'openrouter'], value: target },
    { name: sibling.id, description: 'Zephyr Friendly Name', searchTerms: ['Zephyr Friendly Name', 'openai'], value: sibling }
  ]
  const answer = io.chooseSearchable('Models', choices, { refresh: true })
  let settled = false
  void answer.then(() => { settled = true })
  expect(await frame()).toContain('3202')
  let widgets = searchableWidgets(setup)
  expect(widgets.composer.focused).toBe(true)
  expect(widgets.picker.focused).toBe(false)
  expect(widgets.composerBox.visible).toBe(true)
  await input.typeText('zephyr')
  await frame()
  widgets = searchableWidgets(setup)
  expect(widgets.picker.options.map(option => option.name).sort()).toEqual([target.id, sibling.id].sort())
  expect(widgets.composerBox.title).toMatch(/2\D+3202/)
  await input.typeText('x')
  expect((await frame()).toLowerCase()).toMatch(/no (matching|results|matches|models)/)
  expect(widgets.composerBox.title).toMatch(/0\D+3202/)
  input.pressEnter()
  await Promise.resolve()
  expect(settled).toBe(false)
  input.pressBackspace()
  await frame()
  expect(widgets.picker.options.map(option => option.name).sort()).toEqual([target.id, sibling.id].sort())
  input.pressKey('u', { ctrl: true })
  await input.typeText('OPENROUTER vEnDoR.ONE zEpHyR v2')
  await frame()
  expect(widgets.picker.options.map(option => option.name)).toEqual([target.id])
  expect(widgets.composer.plainText).toBe('OPENROUTER vEnDoR.ONE zEpHyR v2')
  expect(widgets.composer.focused).toBe(true)
  expect(setup.renderer.root.findDescendantById('vivi-completions')!.visible).toBe(false)
  input.pressEnter()
  const selected = await answer
  expect(selected?.kind).toBe('selected')
  if (selected?.kind !== 'selected') throw new Error('Expected a selected model')
  expect(selected.value).toBe(target)
  expect(selected.query).toBe('OPENROUTER vEnDoR.ONE zEpHyR v2')
  expect(searchableWidgets(setup).composer.plainText).toBe('')
  expect(searchableWidgets(setup).pickerBox.visible).toBe(false)
})

test('searchable navigation keeps search focus and query intact while moving through all results', async () => {
  const { io, setup, input, frame } = await fixture()
  const choices = Array.from({ length: 30 }, (_, index) => ({ name: `batch/model-${index.toString().padStart(2, '0')}`,
    searchTerms: ['batch'], value: { id: `original-${index}` } }))
  const answer = io.chooseSearchable('Navigate models', choices, { initialIndex: 8 })
  await frame()
  const { composer, picker } = searchableWidgets(setup)
  expect(picker.getSelectedIndex()).toBe(8)
  input.pressArrow('up')
  expect(picker.getSelectedIndex()).toBe(7)
  input.pressArrow('down')
  expect(picker.getSelectedIndex()).toBe(8)
  input.pressKey('\x1b[6~')
  expect(picker.getSelectedIndex()).toBeGreaterThan(8)
  input.pressKey('HOME')
  expect(picker.getSelectedIndex()).toBe(0)
  input.pressKey('END')
  expect(picker.getSelectedIndex()).toBe(29)
  input.pressKey('\x1b[5~')
  expect(picker.getSelectedIndex()).toBeLessThan(29)
  expect(composer.focused).toBe(true)
  expect(picker.focused).toBe(false)
  expect(composer.plainText).toBe('')
  await input.typeText('batch 29')
  await frame()
  expect(picker.options.map(option => option.name)).toEqual(['batch/model-29'])
  expect(picker.getSelectedIndex()).toBe(0)
  input.pressArrow('up')
  input.pressArrow('down')
  input.pressKey('HOME')
  input.pressKey('END')
  expect(composer.plainText).toBe('batch 29')
  expect(composer.focused).toBe(true)
  input.pressEnter()
  const selected = await answer
  expect(selected?.kind).toBe('selected')
  if (selected?.kind !== 'selected') throw new Error('Expected a selected model')
  expect(selected.value).toBe(choices[29]!.value)
  expect(selected.query).toBe('batch 29')
})

test('clicking searchable results before and after resize keeps query typing focused and selects the latest exact value', async () => {
  const { io, setup, input, frame } = await fixture()
  const target = { id: 'beta-two', preserve: true }
  const answer = io.chooseSearchable('Mouse-safe models', [
    { name: 'alpha', value: { id: 'alpha' } },
    { name: 'beta-one', value: { id: 'beta-one' } },
    { name: target.id, value: target }
  ])
  await frame()
  let widgets = searchableWidgets(setup)
  await setup.mockMouse.click(widgets.pickerBox.x, widgets.pickerBox.y)
  expect(widgets.composer.focused).toBe(true)
  expect(widgets.picker.focused).toBe(false)
  await input.typeText('beta')
  await frame()
  expect(widgets.composer.plainText).toBe('beta')
  expect(widgets.picker.options.map(option => option.name)).toEqual(['beta-one', 'beta-two'])
  setup.resize(40, 12)
  await frame()
  widgets = searchableWidgets(setup)
  await setup.mockMouse.click(widgets.pickerBox.x, widgets.pickerBox.y)
  expect(widgets.composer.focused).toBe(true)
  expect(widgets.picker.focused).toBe(false)
  await input.typeText('-two')
  await frame()
  expect(widgets.composer.plainText).toBe('beta-two')
  expect(widgets.picker.options.map(option => option.name)).toEqual(['beta-two'])
  input.pressEnter()
  const selected = await answer
  expect(selected?.kind).toBe('selected')
  if (selected?.kind !== 'selected') throw new Error('Expected a selected model')
  expect(selected.value).toBe(target)
  expect(selected.query).toBe('beta-two')
})

test('searchable paste filters without submitting, leaves capability text out of search and Ctrl+U restores all models', async () => {
  const { io, setup, input, frame } = await fixture()
  const values = [{ name: 'openai/gpt-5-mini', description: 'tools supported', searchTerms: ['GPT 5 Mini', 'openai'], value: 'openai/gpt-5-mini' },
    { name: 'vendor/other', description: 'GPT 5 Mini · tools supported', searchTerms: ['other', 'openrouter'], value: 'vendor/other' }]
  const answer = io.chooseSearchable('Paste search', values)
  let settled = false
  void answer.then(() => { settled = true })
  await input.pasteBracketedText('  GPT/5.MINI  ')
  await frame()
  const { composer, picker, composerBox } = searchableWidgets(setup)
  expect(picker.options.map(option => option.name)).toEqual(['openai/gpt-5-mini'])
  expect(settled).toBe(false)
  expect(composer.focused).toBe(true)
  input.pressKey('u', { ctrl: true })
  await frame()
  expect(composer.plainText).toBe('')
  expect(picker.options.map(option => option.name)).toEqual(values.map(value => value.name))
  expect(composerBox.title).toMatch(/2\D+2/)
  await input.typeText('supported')
  expect((await frame()).toLowerCase()).toMatch(/no (matching|results|matches|models)/)
  input.pressEnter()
  await Promise.resolve()
  expect(settled).toBe(false)
  input.pressKey('u', { ctrl: true })
  await input.pasteBracketedText('openai gpt 5 mini')
  input.pressEnter()
  expect(await answer).toEqual({ kind: 'selected', value: 'openai/gpt-5-mini', query: 'openai gpt 5 mini' })
})

test('searchable text editing, Unicode and multiline paste keep the current query live through Enter', async () => {
  const { io, setup, input, frame } = await fixture()
  const exact = { id: 'openai/gpt-5-mini' }
  const choices = [{ name: 'openai/gpt-5-mini-longer', searchTerms: ['OpenAI GPT 5 Mini'], value: { id: 'longer' } },
    { name: exact.id, searchTerms: ['OpenAI GPT 5 Mini'], value: exact }]
  const pasted = io.chooseSearchable('Unicode search', choices)
  let settled = false
  void pasted.then(() => { settled = true })
  await input.pasteBracketedText('ＯＰＥＮＡＩ\nＧＰＴ\t５／ＭＩＮＩ')
  await frame()
  const { composer, picker } = searchableWidgets(setup)
  expect(composer.plainText).toBe('ＯＰＥＮＡＩ ＧＰＴ ５／ＭＩＮＩ')
  expect(composer.plainText).not.toContain('\n')
  expect(settled).toBe(false)
  expect(picker.getSelectedOption()?.name).toBe(exact.id)
  input.pressArrow('left')
  input.pressBackspace()
  await input.typeText('Ｎ')
  input.pressArrow('right')
  expect(composer.plainText).toBe('ＯＰＥＮＡＩ ＧＰＴ ５／ＭＩＮＩ')
  expect(composer.focused).toBe(true)
  input.pressEnter()
  const selected = await pasted
  expect(selected?.kind).toBe('selected')
  if (selected?.kind !== 'selected') throw new Error('Expected a selected model')
  expect(selected.value).toBe(exact)
  expect(selected.query).toBe('ＯＰＥＮＡＩ ＧＰＴ ５／ＭＩＮＩ')
  const immediate = io.chooseSearchable('Immediate search', [{ name: 'alpha', value: 'exact-alpha' },
    { name: 'beta', value: 'exact-beta' }], { query: 'alpha' })
  input.pressKey('u', { ctrl: true })
  await input.typeText('betax')
  input.pressBackspace()
  input.pressEnter() // No frame between the last edit and submission.
  expect(await immediate).toEqual({ kind: 'selected', value: 'exact-beta', query: 'beta' })
})

test('searchable input stays bounded and Ctrl+R only refreshes when the caller enabled it', async () => {
  const { io, setup, input, frame } = await fixture()
  const answer = io.chooseSearchable('Bounded search', [{ name: 'beta', value: 'exact-beta' }])
  let settled = false
  void answer.then(() => { settled = true })
  await input.pasteBracketedText('x'.repeat(4000))
  await frame()
  expect(searchableWidgets(setup).composer.plainText).toHaveLength(200)
  expect(await frame()).toContain('Input limit: 200 characters')
  expect((await frame()).toLowerCase()).toMatch(/no (matching|results|matches|models)/)
  input.pressKey('u', { ctrl: true })
  await input.typeText('beta')
  input.pressKey('r', { ctrl: true })
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(searchableWidgets(setup).composer.plainText).toBe('beta')
  input.pressEnter()
  expect(await answer).toEqual({ kind: 'selected', value: 'exact-beta', query: 'beta' })
})

test('same native input batch uses the newest query for Enter, navigation and refresh', async () => {
  const { io, setup, frame } = await fixture()
  const choices = [{ name: 'alpha', value: 'exact-alpha' }, { name: 'beta', value: 'exact-beta' },
    { name: 'beta-longer', value: 'exact-longer' }]
  const selected = io.chooseSearchable('Same-batch Enter', choices, { query: 'alpha' })
  await frame()
  setup.renderer.stdin.emit('data', Buffer.from('\x15beta\r'))
  expect(await selected).toEqual({ kind: 'selected', value: 'exact-beta', query: 'beta' })
  const navigated = io.chooseSearchable('Same-batch navigation', choices, { query: 'alpha' })
  await frame()
  setup.renderer.stdin.emit('data', Buffer.from('\x15beta\x1b[B\r'))
  expect(await navigated).toEqual({ kind: 'selected', value: 'exact-longer', query: 'beta' })
  const refresh = io.chooseSearchable('Same-batch refresh', choices, { query: 'alpha', refresh: true })
  await frame()
  setup.renderer.stdin.emit('data', Buffer.from('\x15beta\x12'))
  expect(await refresh).toEqual({ kind: 'refresh', query: 'beta' })
})

test('searchable refresh returns the live query and repeated opening starts clean unless a query is supplied', async () => {
  const { io, setup, input, frame } = await fixture()
  const choices = [{ name: 'alpha', value: 'exact-alpha' }, { name: 'beta', value: 'exact-beta' }]
  const refresh = io.chooseSearchable('First models', choices, { refresh: true })
  await input.typeText('bet')
  input.pressKey('r', { ctrl: true })
  expect(await refresh).toEqual({ kind: 'refresh', query: 'bet' })
  expect(searchableWidgets(setup).composer.plainText).toBe('')
  expect(searchableWidgets(setup).pickerBox.visible).toBe(false)
  const reopened = io.chooseSearchable('Refreshed models', choices, { query: 'bet', refresh: true })
  await frame()
  expect(searchableWidgets(setup).composer.plainText).toBe('bet')
  expect(searchableWidgets(setup).picker.options.map(option => option.name)).toEqual(['beta'])
  input.pressEnter()
  expect(await reopened).toEqual({ kind: 'selected', value: 'exact-beta', query: 'bet' })
  for (let attempt = 0; attempt < 3; attempt++) {
    const cancelled = io.chooseSearchable('Cancel models', choices)
    await frame()
    expect(searchableWidgets(setup).composer.plainText).toBe('')
    expect(searchableWidgets(setup).picker.options.map(option => option.name)).toEqual(['alpha', 'beta'])
    await input.typeText('discard')
    input.pressEscape()
    expect(await cancelled).toBeUndefined()
    expect(searchableWidgets(setup).composer.plainText).toBe('')
  }
  const line = io.readLine('Message')
  await input.typeText('/m')
  expect(await frame()).toContain('› /models')
  input.pressTab()
  input.pressEnter()
  expect(await line).toBe('/models')
})

test('empty searchable catalogs stay dismissible and refreshable without Enter selecting a placeholder', async () => {
  const { io, setup, input, frame } = await fixture()
  const answer = io.chooseSearchable('Empty models', [], { refresh: true })
  let settled = false
  void answer.then(() => { settled = true })
  expect((await frame()).toLowerCase()).toMatch(/no (matching|results|matches|models)/)
  expect(searchableWidgets(setup).composerBox.title).toMatch(/0\D+0/)
  expect(searchableWidgets(setup).composer.focused).toBe(true)
  input.pressArrow('down')
  input.pressKey('END')
  input.pressEnter()
  await Promise.resolve()
  expect(settled).toBe(false)
  input.pressKey('r', { ctrl: true })
  expect(await answer).toEqual({ kind: 'refresh', query: '' })
  const again = io.chooseSearchable('Empty again', [])
  input.pressEscape()
  expect(await again).toBeUndefined()
})

test('searchable picker survives native resize and keeps both the search editor and matched values visible', async () => {
  const { io, setup, input, frame } = await fixture({ width: 110, height: 32 })
  const choices = Array.from({ length: 600 }, (_, index) => ({ name: `catalog/model-${index}`, value: `exact-${index}` }))
  const answer = io.chooseSearchable('Resize models', choices, { refresh: true })
  await input.typeText('599')
  for (const [width, height] of [[40, 12], [70, 20], [110, 32]] as const) {
    setup.resize(width, height)
    const display = await frame()
    const { composer, composerBox, pickerBox, picker } = searchableWidgets(setup)
    expect(display).toContain('model-599')
    expect(display).toContain('Ctrl+R refresh')
    expect(display).toContain('Enter choose')
    expect(display).toContain('Esc back')
    expect(composerBox.visible).toBe(true)
    expect(pickerBox.visible).toBe(true)
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(height)
    expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(composerBox.y)
    expect(composer.plainText).toBe('599')
    expect(composer.focused).toBe(true)
    expect(picker.options.map(option => option.name)).toEqual(['catalog/model-599'])
  }
  input.pressEnter()
  expect(await answer).toEqual({ kind: 'selected', value: 'exact-599', query: '599' })
})

test('searchable replacement and native termination settle once and cannot leak a stale query into later input', async () => {
  const { io, setup, input, frame } = await fixture()
  const choices = [{ name: 'alpha', value: { exact: 'alpha' } }, { name: 'beta', value: { exact: 'beta' } }]
  const first = io.chooseSearchable('Old search', choices)
  await input.typeText('alpha')
  const replacement = io.chooseSearchable('New search', choices, { query: 'bet' })
  expect(await first).toBeUndefined()
  await frame()
  expect(searchableWidgets(setup).composer.plainText).toBe('bet')
  input.pressEnter()
  const selected = await replacement
  expect(selected?.kind).toBe('selected')
  if (selected?.kind !== 'selected') throw new Error('Expected a selected model')
  expect(selected.value).toBe(choices[1]!.value)
  const replacedByText = io.chooseSearchable('Discard this search', choices)
  await input.typeText('discard')
  const text = io.askText('Ordinary text', 'fresh')
  expect(await replacedByText).toBeUndefined()
  input.pressEnter()
  expect(await text).toBe('fresh')
  for (const action of ['close', 'ctrl-c', 'destroy', 'error'] as const) {
    const fixtureValue = await fixture()
    const pending = fixtureValue.io.chooseSearchable('Interrupted search', choices)
    const outcome = pending.catch((error: Error) => error.message)
    await fixtureValue.input.typeText('unfinished-query')
    if (action === 'close') fixtureValue.io.close()
    else if (action === 'ctrl-c') fixtureValue.input.pressCtrlC()
    else if (action === 'destroy') fixtureValue.setup.renderer.destroy()
    else fixtureValue.setup.renderer.emit(CliRenderEvents.HANDLER_ERROR, { error: new Error('search failed') })
    expect(await outcome).toBe(action === 'error' ? 'OpenTUI renderer failed: search failed' : undefined)
    expect(fixtureValue.io.isClosed).toBe(true)
    expect(fixtureValue.setup.renderer.isDestroyed).toBe(true)
  }
})

test('askText starts with its initial value and dismisses without stale input', async () => {
  const { io, input } = await fixture()
  const first = io.askText('Model identifier', 'mock-model')
  await input.typeText('-v2')
  input.pressEnter()
  expect(await first).toBe('mock-model-v2')
  const second = io.askText('Reasoning', 'high')
  input.pressEscape()
  expect(await second).toBeUndefined()
  const line = io.readLine('Message')
  await input.typeText('fresh')
  input.pressEnter()
  expect(await line).toBe('fresh')
})

test('idle shortcuts issue commands only for an empty composer', async () => {
  const { io, input } = await fixture()
  for (const [key, command] of [['n', '/new'], ['r', '/resume'], ['p', '/menu']]) {
    const line = io.readLine('Message')
    input.pressKey(key!, { ctrl: true })
    expect(await line).toBe(command!)
  }
  const line = io.readLine('Message')
  await input.typeText('draft')
  input.pressKey('n', { ctrl: true })
  input.pressEnter()
  expect(await line).toBe('draft')
})

test('running turn blocks queued typing and commands; Escape and Ctrl+C cancel', async () => {
  const { io, input, frame } = await fixture()
  let cancelled = 0
  const dispose = io.onCancel(() => cancelled++)
  await input.typeText('queued message')
  input.pressKey('n', { ctrl: true })
  input.pressEnter()
  input.pressEscape()
  input.pressCtrlC()
  expect(cancelled).toBe(2)
  expect(await frame()).not.toContain('queued message')
  dispose()
  const line = io.readLine('Message')
  input.pressEnter()
  expect(await line).toBe('')
})

test('approval clears pretyped input and queued Return, requires fresh selected Approve', async () => {
  const { io, input, frame } = await fixture()
  const draft = io.askText('An earlier input')
  await input.typeText('allow')
  const approval = io.approve(request, new AbortController().signal)
  input.pressEnter()
  await input.typeText('allow') // This batch predates arming and must be discarded.
  input.pressEnter()
  expect(await draft).toBeUndefined()
  await tick()
  const display = await frame()
  expect(display).toContain('current revision 4')
  expect(display).toContain(request.description)
  expect(display).toContain('default: deny')
  let settled = false
  void approval.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  input.pressArrow('right')
  input.pressEnter()
  expect(await approval).toBe(true)
})

test('pasted approval cannot allow; blank, deny, abort, dismissal and close deny', async () => {
  const { io, input, frame } = await fixture()
  const pasted = io.approve(request, new AbortController().signal)
  await tick(); await frame()
  await input.pasteBracketedText('allow\n')
  input.pressEnter()
  expect(await pasted).toBe(false)
  const denied = io.approve(request, new AbortController().signal)
  await tick(); await frame()
  await input.typeText('deny')
  input.pressEnter()
  expect(await denied).toBe(false)
  const abortedController = new AbortController()
  const aborted = io.approve(request, abortedController.signal)
  abortedController.abort()
  expect(await aborted).toBe(false)
  const dismissed = io.approve(request, new AbortController().signal)
  input.pressEscape()
  expect(await dismissed).toBe(false)
  const closed = io.approve(request, new AbortController().signal)
  io.close()
  expect(await closed).toBe(false)
})

test('invalid approval text cannot carry forward into a later approval', async () => {
  const { io, input, frame } = await fixture()
  const first = io.approve(request, new AbortController().signal)
  await tick(); await frame()
  await input.typeText('allowed')
  input.pressEnter()
  input.pressEnter()
  expect(await first).toBe(false)
  await input.typeText('allow')
  input.pressEnter() // No pending input, so this cannot grant a future request.
  const second = io.approve(request, new AbortController().signal)
  await tick(); await frame()
  input.pressEnter()
  expect(await second).toBe(false)
})

test('split streamed secrets never enter a captured frame, accepted response replaces preview', async () => {
  const secret = 'sk-test-super-secret'
  const { io, frame } = await fixture({ secrets: [secret] })
  for (const text of ['A response: sk-', 'test-super-', 'secret and ', '**more text** '.repeat(3)]) {
    io.event({ type: 'text_delta', text })
    const display = await frame()
    expect(display).not.toContain(secret)
    expect(display).not.toContain('sk-test')
  }
  expect(await frame()).toContain('[REDACTED]')
  expect(await frame()).toContain('streaming preview (not accepted)')
  io.event({ type: 'assistant', message: { kind: 'assistant', content: 'Different accepted answer', toolCalls: [] } })
  expect(await frame()).toContain('Different accepted answer')
  expect(await frame()).not.toContain('streaming preview')
  expect(await frame()).not.toContain('A response:')
  io.result(result('Different accepted answer'))
  expect(await frame()).toContain('Completed')
})

test('aborted partial display remains clearly separate after canonical session refresh', async () => {
  const { io, frame } = await fixture({ secrets: ['credential-tail'] })
  io.event({ type: 'text_delta', text: 'unfinished **answer** credential-' })
  io.result(result('', 'cancelled'))
  const session = newSession({ provider: 'openai', model: 'mock-model' })
  session.history = [{ kind: 'message', role: 'user', content: 'Hello' }]
  io.setSession(session)
  const display = await frame()
  expect(display).toContain('Partial display only')
  expect(display).toContain('response was not accepted')
  expect(display).toContain('Cancelled')
  expect(display).not.toContain('credential-')
  expect(session.history).toHaveLength(1)
})

test('display overflow is bounded and canonical completion reconciles it', async () => {
  const { io, frame } = await fixture()
  io.event({ type: 'text_delta', text: 'x'.repeat(70000) })
  expect(await frame()).toContain('display truncated')
  io.result(result('Final accepted response'))
  expect(await frame()).toContain('Final accepted response')
  expect(await frame()).not.toContain('display truncated')
})

test('secrets and terminal commands are stripped from every display surface', async () => {
  const { io, input, frame } = await fixture({ secrets: ['known-secret'] })
  const session = newSession({ provider: 'openai', model: 'known-secret' })
  session.history = history('\x1b[31mred\x1b[0m known-secret\x1b]52;c;clipboard\x07')
  io.setSession(session)
  io.write('\x1b[2Jmessage known-secret')
  io.event({ type: 'tool_started', call: { id: '1', name: 'known-secret', arguments: {} } })
  io.event({ type: 'tool_completed', message: { kind: 'tool_result', callId: '1', name: 'test', content: 'known-secret' } })
  const line = io.readLine('known-secret')
  await input.pasteBracketedText('hello known-secret\x1b[31m world\x1b[0m')
  const display = await frame()
  expect(display).not.toContain('known-secret')
  expect(display).not.toContain('[31m')
  expect(display).not.toContain('clipboard')
  expect(display).toContain('[REDACTED]')
  input.pressEnter()
  expect(await line).toBe('hello [REDACTED] world')
})

test('split terminal escape commands are never displayed as command fragments', async () => {
  const { io, frame } = await fixture()
  io.event({ type: 'text_delta', text: 'visible\x1b[3' })
  expect(await frame()).not.toContain('[3')
  io.event({ type: 'text_delta', text: '1m red\x1b]52;c;payload' })
  expect(await frame()).not.toContain('payload')
  io.event({ type: 'text_delta', text: '\x07 done' })
  const display = await frame()
  expect(display).toContain('visible red done')
  expect(display).not.toContain('52;c;')
})

test('PageUp/Down and Ctrl+Shift arrows scroll transcript without editing composer', async () => {
  const { io, setup, input, frame } = await fixture({ height: 20 })
  const session = newSession({ provider: 'openai', model: 'mock-model' })
  session.history = Array.from({ length: 40 }, (_, index) => ({ kind: 'message' as const, role: 'user' as const, content: `Transcript line ${index}` }))
  io.setSession(session)
  const line = io.readLine('Message')
  await input.typeText('unchanged draft')
  await frame()
  const transcript = setup.renderer.root.findDescendantById('vivi-transcript') as { scrollTop?: number } | undefined
  const before = transcript?.scrollTop ?? 0
  input.pressKey('\x1b[5~')
  await frame()
  expect(transcript?.scrollTop).toBeLessThan(before)
  input.pressKey('\x1b[6~')
  input.pressArrow('up', { ctrl: true, shift: true })
  input.pressArrow('down', { ctrl: true, shift: true })
  input.pressEnter()
  expect(await line).toBe('unchanged draft')
})

test('input size is bounded and input abort clears the composer', async () => {
  const { io, input } = await fixture()
  const controller = new AbortController()
  const line = io.readLine('Message', controller.signal)
  const failure = line.catch((error: Error) => error.message)
  await input.pasteBracketedText('x'.repeat(70000))
  await input.typeText('small')
  controller.abort()
  expect(await failure).toBe('Input cancelled')
  const next = io.readLine('Message')
  input.pressEnter()
  expect(await next).toBe('')
})

test('nonstreaming mode still renders accepted content, errors and tool progress', async () => {
  const { io, frame } = await fixture({ stream: false, secrets: ['known-secret'] })
  io.event({ type: 'text_delta', text: 'hidden preview' })
  expect(await frame()).not.toContain('hidden preview')
  io.event({ type: 'assistant', message: { kind: 'assistant', content: 'Accepted answer', toolCalls: [] } })
  expect(await frame()).toContain('Accepted answer')
  io.result({ ...result('', 'error'), error: { code: 'provider_error', message: 'Failure known-secret' } })
  const session = newSession({ provider: 'openai', model: 'mock-model' })
  io.setSession(session)
  expect(await frame()).toContain('Failure [REDACTED]')
  expect(await frame()).toContain('Error')
})

test('repeated close settles inputs, destroys once and unregisters all hooks', async () => {
  const before = { sigint: process.listenerCount('SIGINT'), sigterm: process.listenerCount('SIGTERM'),
    sighup: process.listenerCount('SIGHUP'), exit: process.listenerCount('exit') }
  const { io, setup } = await fixture()
  let destroyEvents = 0
  setup.renderer.on(CliRenderEvents.DESTROY, () => destroyEvents++)
  const line = io.readLine('Message')
  io.close()
  io.close()
  expect(await line).toBeUndefined()
  expect(destroyEvents).toBe(1)
  expect(setup.renderer.isDestroyed).toBe(true)
  expect(io.isClosed).toBe(true)
  expect(process.listenerCount('SIGINT')).toBe(before.sigint)
  expect(process.listenerCount('SIGTERM')).toBe(before.sigterm)
  expect(process.listenerCount('SIGHUP')).toBe(before.sighup)
  expect(process.listenerCount('exit')).toBe(before.exit)
  expect(await io.readLine('Closed')).toBeUndefined()
  expect(await io.askText('Closed')).toBeUndefined()
  expect(await io.choose('Closed', [{ name: 'A', value: 'a' }])).toBeUndefined()
})

test('renderer errors and external renderer destruction clean up pending input', async () => {
  const first = await fixture()
  const line = first.io.readLine('Message')
  const failure = line.catch((error: Error) => error.message)
  first.setup.renderer.emit(CliRenderEvents.RENDER_ERROR, { error: new Error('synthetic render error'), renderable: undefined })
  expect(await failure).toBe('OpenTUI renderer failed: synthetic render error')
  expect(first.io.failed).toBe(true)
  expect(first.io.readLine('After failure')).rejects.toThrow('OpenTUI renderer failed')
  expect(first.setup.renderer.isDestroyed).toBe(true)
  const second = await fixture()
  const choice = second.io.choose('Model', [{ name: 'A', value: 'a' }])
  second.setup.renderer.destroy()
  expect(await choice).toBeUndefined()
})

test('close, SIGTERM and SIGHUP cancel a running host once and clean up native resources', async () => {
  for (const action of ['close', 'SIGTERM', 'SIGHUP'] as const) {
    const { io, setup } = await fixture()
    let cancellations = 0
    io.onCancel(() => { cancellations++ })
    if (action === 'close') io.close()
    else process.emit(action)
    io.close()
    expect(cancellations).toBe(1)
    expect(setup.renderer.isDestroyed).toBe(true)
  }
})

test('switching sessions clears partial or error notices from the old conversation', async () => {
  const { io, frame } = await fixture()
  const first = newSession({ provider: 'openai', model: 'first-model' })
  io.setSession(first)
  io.event({ type: 'text_delta', text: 'first-session partial' })
  io.result(result('', 'cancelled'))
  io.setSession({ ...first, history: result('', 'cancelled').history })
  expect(await frame()).toContain('first-session partial')
  const second = newSession({ provider: 'openai', model: 'second-model' })
  io.setSession(second)
  const display = await frame()
  expect(display).toContain('second-model')
  expect(display).not.toContain('first-session partial')
  expect(display).not.toContain('response was not accepted')
  expect(display).toContain('Ready')
})

test('Ctrl+C while idle exits and closes the active composer', async () => {
  const { io, input, setup } = await fixture()
  const line = io.readLine('Message')
  input.pressCtrlC()
  expect(await line).toBeUndefined()
  expect(setup.renderer.isDestroyed).toBe(true)
  expect(io.failed).toBe(false)
})

test('constructor failure destroys native renderer and does not leave process hooks', async () => {
  const setup = await createTestRenderer({ width: 80, height: 20, exitOnCtrlC: false, exitSignals: [] })
  const listeners = process.listenerCount('SIGINT')
  let destroyed = 0
  setup.renderer.on(CliRenderEvents.DESTROY, () => { destroyed++ })
  setup.renderer.root.add = () => { throw new Error('synthetic attachment failure') }
  expect(() => new OpenTuiIO(setup.renderer)).toThrow('synthetic attachment failure')
  expect(destroyed).toBe(1)
  expect(setup.renderer.isDestroyed).toBe(true)
  expect(process.listenerCount('SIGINT')).toBe(listeners)
})

test('renderer handler failures cancel active host and reject the next input safely', async () => {
  const { io, setup } = await fixture({ secrets: ['known-secret'] })
  let cancelled = 0
  io.onCancel(() => { cancelled++ })
  setup.renderer.emit(CliRenderEvents.HANDLER_ERROR, { error: new Error('\x1b[31mFailure known-secret\x1b[0m') })
  expect(cancelled).toBe(1)
  expect(setup.renderer.isDestroyed).toBe(true)
  await expect(io.readLine('After failure')).rejects.toThrow('OpenTUI renderer failed: Failure [REDACTED]')
})

test('two renderer surfaces own independent parser workers and can close separately', async () => {
  const first = await fixture()
  const second = await fixture()
  const firstSession = newSession({ provider: 'openai', model: 'first-model' })
  firstSession.history = history('First parser content')
  first.io.setSession(firstSession)
  const secondSession = newSession({ provider: 'openai', model: 'second-model' })
  secondSession.history = history('Second parser content')
  second.io.setSession(secondSession)
  expect(await first.frame()).toContain('First parser content')
  first.io.close()
  expect(await second.frame()).toContain('Second parser content')
  second.io.event({ type: 'assistant', message: { kind: 'assistant', content: 'Still rendering independently', toolCalls: [] } })
  expect(await second.frame()).toContain('Still rendering independently')
})

test('canonical transcript loading is display-bounded without changing persisted history', async () => {
  const { io, setup } = await fixture()
  const session = newSession({ provider: 'openai', model: 'mock-model' })
  session.history = Array.from({ length: 1000 }, (_, index) => ({ kind: 'message' as const,
    role: 'user' as const, content: `Entry ${index}` }))
  const original = structuredClone(session)
  io.setSession(session)
  const transcript = setup.renderer.root.findDescendantById('vivi-transcript')!
  expect(transcript.getChildren().length).toBeLessThanOrEqual(256)
  expect(session).toEqual(original)
})

test('packaged Markdown grammars initialize and conceal markup without using a global cache', async () => {
  const { io, setup, frame } = await fixture({ height: 40 })
  const session = newSession({ provider: 'openai', model: 'mock-model' })
  session.history = history('## Parsed heading\n\nA **parsed bold** response')
  io.setSession(session)
  await frame()
  const codeNodes = (node: Renderable): CodeRenderable[] => [
    ...(node instanceof CodeRenderable ? [node] : []), ...node.getChildren().flatMap(codeNodes)
  ]
  const blocks = codeNodes(setup.renderer.root)
  expect(blocks.length).toBeGreaterThan(0)
  await Promise.all(blocks.map((block) => block.highlightingDone))
  const display = await frame()
  expect(display).toContain('Parsed heading')
  expect(display).toContain('parsed bold')
  expect(display).not.toContain('## Parsed heading')
  expect(display).not.toContain('**parsed bold**')
})

test('registering cancellation after close immediately aborts a late-starting operation', async () => {
  const { io } = await fixture()
  expect(io.isClosed).toBe(false)
  io.close()
  const controller = new AbortController()
  const dispose = io.onCancel(() => controller.abort())
  expect(controller.signal.aborted).toBe(true)
  expect(io.isClosed).toBe(true)
  dispose()
})

test('long workspace paths stay on one right-aligned footer row and keep the composer visible after resize', async () => {
  const { io, setup, frame } = await fixture({ width: 180, height: 30 })
  io.setSession(newSession({ provider: 'openai', model: 'fixture' }))
  const reading = io.readLine('Message')
  for (const path of [`/project/${'long-folder/'.repeat(100)}last`, `C:\\project\\${'日本語-folder\\'.repeat(100)}last`]) {
    io.setWorkspace(path)
    for (const [width, height] of [[180, 30], [80, 24], [60, 20], [40, 20]] as const) {
      setup.resize(width, height)
      await frame()
      const workspace = setup.renderer.root.findDescendantById('vivi-workspace') as TextRenderable
      const composer = setup.renderer.root.findDescendantById('vivi-composer-box')!
      const transcript = setup.renderer.root.findDescendantById('vivi-transcript')!
      expect(workspace.plainText).toContain('Workspace:')
      expect(workspace.plainText).toContain('…')
      expect(workspace.plainText.split('\n')).toHaveLength(1)
      expect(workspace.textAlign).toBe('right')
      expect(workspace.x + workspace.width).toBe(width)
      expect(workspace.y).toBeGreaterThanOrEqual(composer.y + composer.height)
      expect(workspace.y + workspace.height).toBeLessThanOrEqual(height)
      expect(composer.y + composer.height).toBeLessThanOrEqual(height)
      expect(transcript.height).toBeGreaterThan(1)
      expect(workspace.height).toBe(1)
    }
  }
  io.close(); expect(await reading).toBeUndefined()
})

test('workspace status keeps search results, editor and refresh hints visible in a compact terminal', async () => {
  const { io, setup, input, frame } = await fixture({ width: 110, height: 32 })
  io.setSession(newSession({ provider: 'openai', model: 'fixture' }))
  io.setWorkspace(`/project/${'long-folder/'.repeat(100)}last`)
  const selecting = io.chooseSearchable('Workspace models', [{ name: 'model-599', value: 'selected-model' }], { refresh: true })
  for (const [width, height] of [[40, 12], [70, 20], [110, 32]] as const) {
    setup.resize(width, height)
    const display = await frame()
    expect(display).toContain('Workspace:')
    expect(display).toContain('model-599')
    expect(display).toContain('Ctrl+R refresh')
    expect(display).toContain('Enter choose')
    expect(display).toContain('Esc back')
    const { composerBox } = searchableWidgets(setup)
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(height)
  }
  setup.resize(40, 12)
  io.event({ type: 'text_delta', text: 'Streaming fixture' })
  const streaming = await frame()
  expect(streaming).toContain('Workspace:')
  expect(streaming).toContain('Ctrl+R refresh')
  expect(streaming).toContain('model-599')
  input.pressEnter(); expect(await selecting).toEqual({ kind: 'selected', value: 'selected-model', query: '' })
})

test('native transcript differentiates user, assistant and activity without changing content or selection', async () => {
  const { io, setup, frame } = await fixture({ width: 120, height: 80 })
  const session = newSession({ provider: 'openai', model: 'fixture' })
  session.history = [
    { kind: 'message', role: 'user', content: 'Selectable user text' },
    { kind: 'assistant', content: 'Assistant content', toolCalls: [] },
    { kind: 'tool_result', callId: 'normal', name: 'Assistant', content: 'Selectable tool text' },
    { kind: 'message', role: 'system', content: 'System context' },
    { kind: 'tool_result', callId: 'failed', name: 'failed_tool', content: 'Action failed', isError: true }
  ]
  const original = structuredClone(session)
  io.setSession(session)
  const display = await frame()
  const entries = setup.renderer.root.findDescendantById('vivi-transcript')!.getChildren() as BoxRenderable[]
  const label = (index: number) => entries[index]!.getChildren()[0] as TextRenderable
  const body = (index: number) => entries[index]!.getChildren()[1] as TextRenderable
  expect(entries).toHaveLength(5)
  expect(entries[0]!.border).toEqual(['left'])
  expect(entries[0]!.borderColor.equals(RGBA.fromHex(TUI_THEME.lavender))).toBe(true)
  expect(entries[0]!.backgroundColor.equals(RGBA.fromHex(TUI_THEME.userBackground))).toBe(true)
  expect(label(0).fg.equals(RGBA.fromHex(TUI_THEME.lavender))).toBe(true)
  expect(body(0).fg.equals(RGBA.fromHex(TUI_THEME.foreground))).toBe(true)
  expect(label(1).fg.equals(RGBA.fromHex(TUI_THEME.pink))).toBe(true)
  expect(entries[1]!.border).toBe(false)
  for (const index of [2, 3]) {
    expect(label(index).fg.equals(RGBA.fromHex(TUI_THEME.muted))).toBe(true)
    expect(body(index).fg.equals(RGBA.fromHex(TUI_THEME.muted))).toBe(true)
    expect(entries[index]!.border).toBe(false)
  }
  expect(label(4).fg.equals(RGBA.fromHex(TUI_THEME.attention))).toBe(true)
  expect(body(4).fg.equals(RGBA.fromHex(TUI_THEME.foreground))).toBe(true)
  for (const text of ['Selectable user text', 'Assistant content', 'Selectable tool text', 'System context', 'Action failed']) expect(display).toContain(text)
  const spans = setup.captureSpans().lines.flatMap(line => line.spans)
  expect(spans.some(span => span.text.includes('You') && span.fg.equals(RGBA.fromHex(TUI_THEME.lavender)) &&
    span.bg.equals(RGBA.fromHex(TUI_THEME.userBackground)))).toBe(true)
  expect(spans.some(span => span.text.includes('Selectable tool text') && span.fg.equals(RGBA.fromHex(TUI_THEME.muted)))).toBe(true)
  for (const index of [0, 2]) {
    const text = body(index)
    expect(text.selectable).toBe(true)
    await setup.mockMouse.drag(text.x, text.y, text.x + text.plainText.length, text.y)
    expect(setup.renderer.getSelection()?.getSelectedText()).toContain(text.plainText)
    setup.renderer.clearSelection()
  }
  expect(session).toEqual(original)
})

test('review state, pending approvals and result errors remain prominent while settled activity is muted', async () => {
  const { io, setup, input, frame } = await fixture({ width: 120, height: 40 })
  const session = newSession({ provider: 'openai', model: 'fixture' })
  io.setSession(session); io.runStarted()
  const entry = (label: string): BoxRenderable => setup.renderer.root.findDescendantById('vivi-transcript')!.getChildren()
    .find(node => (node.getChildren()[0] as TextRenderable).plainText === label) as BoxRenderable
  const colors = (label: string, attention: boolean) => {
    const nodes = entry(label).getChildren() as TextRenderable[]
    expect(nodes[0]!.fg.equals(RGBA.fromHex(attention ? TUI_THEME.attention : TUI_THEME.muted))).toBe(true)
    expect(nodes[1]!.fg.equals(RGBA.fromHex(attention ? TUI_THEME.foreground : TUI_THEME.muted))).toBe(true)
  }
  const context = { sessionId: session.id, runId: 'fixture', callId: 'save', toolName: 'note_set' }
  io.reviewNotice('Reviewing note_set', { ...context, state: 'reviewing' }); await frame()
  colors('Review · note_set', false)
  io.reviewNotice('Needs your review', { ...context, state: 'needs_review' }); await frame()
  colors('Review · note_set', true)
  io.reviewNotice('Approved by you; change saved', { ...context, state: 'saved', source: 'human' }); await frame()
  colors('Review · note_set', false)
  for (const state of ['failed', 'unknown'] as const) {
    io.reviewNotice(`Unresolved ${state}`, { ...context, callId: state, toolName: state, state }); await frame()
    colors(`Review · ${state}`, true)
  }
  io.reviewNotice('Audit could not be saved'); await frame(); colors('Review warning', true)
  const pending = io.approve(request, new AbortController().signal)
  await tick(); await frame(); colors('Approval required · current revision 4', true)
  input.pressEnter(); expect(await pending).toBe(false)
  io.result({ ...result('Failed', 'error'), error: new Error('Visible result error') }); await frame()
  colors('Error', true)
})

test('title-only header and responsive metadata keep native controls separate from the workspace', async () => {
  const { io, setup, input, frame } = await fixture({ width: 160, height: 30 })
  const session = newSession({ provider: 'openrouter', model: 'fixture-model', reasoning: 'high' })
  session.title = 'Friendly title 日本語'; session.titleRevision = 1
  session.usage = { inputTokens: 10, outputTokens: 5, totalTokens: 18, cachedInputTokens: 0, cacheWriteInputTokens: 7 }
  io.setSession(session); io.setApprovalMode('auto'); io.setWorkspace('/fixture/project')
  const node = (id: string) => setup.renderer.root.findDescendantById(id)!
  const text = (id: string) => node(id) as TextRenderable
  for (const width of [160, 100, 80, 72, 71, 60, 59, 40, 20]) {
    setup.resize(width, 30)
    const reading = io.readLine('Message')
    const display = await frame()
    expect(display).not.toContain(session.id)
    expect(text('vivi-header').plainText).not.toContain('Session ')
    expect(text('vivi-tokens').height).toBe(1)
    expect(text('vivi-tokens').plainText.split('\n')).toHaveLength(1)
    expect(text('vivi-tokens').textAlign).toBe('right')
    expect(text('vivi-tokens').x + text('vivi-tokens').width).toBe(width)
    expect(text('vivi-tokens').y).toBeLessThan(node('vivi-transcript').y)
    expect(text('vivi-model').y + text('vivi-model').height).toBe(node('vivi-composer-box').y)
    expect(text('vivi-model').plainText).toContain('Auto review')
    expect(text('vivi-workspace').y).toBeGreaterThanOrEqual(node('vivi-composer-box').y + node('vivi-composer-box').height)
    expect(text('vivi-workspace').x + text('vivi-workspace').width).toBe(width)
    expect(text('vivi-workspace').y + text('vivi-workspace').height).toBeLessThanOrEqual(30)
    const actions = node('vivi-actions')
    if (width >= 48) {
      expect(actions.visible).toBe(true)
      for (const button of actions.getChildren()) {
        expect(button.x + button.width).toBeLessThanOrEqual(width)
        if (button.y === text('vivi-workspace').y) expect(button.x + button.width).toBeLessThanOrEqual(text('vivi-workspace').x)
        else expect(button.y).toBeLessThan(text('vivi-workspace').y)
      }
      const menu = node('vivi-action-menu')
      await setup.mockMouse.click(menu.x + 1, menu.y)
      expect(await reading).toBe('/menu')
    } else {
      expect(actions.visible).toBe(false)
      await input.typeText('/menu'); input.pressEnter(); expect(await reading).toBe('/menu')
    }
  }
  io.setSession(newSession({ provider: 'openai', model: 'fixture' })); await frame()
  expect(text('vivi-header').plainText).toContain('Untitled')
  expect(session.id).toMatch(/^[a-f0-9-]+$/)
})

test('user borders wrap Unicode and long text without changing native scrolling, drafts or assistant streaming', async () => {
  const { io, setup, input, frame } = await fixture({ width: 40, height: 20 })
  const session = newSession({ provider: 'openai', model: 'fixture' })
  const content = '日本語 👩🏽‍💻 café '.repeat(15)
  session.history = Array.from({ length: 30 }, (_, index) => ({ kind: 'message' as const, role: 'user' as const, content: `${index} ${content}` }))
  io.setSession(session)
  const reading = io.readLine('Message'); await input.typeText('unchanged draft'); await frame()
  const transcript = setup.renderer.root.findDescendantById('vivi-transcript') as import('@opentui/core').ScrollBoxRenderable
  for (const entry of transcript.getChildren()) {
    expect(entry.x + entry.width).toBeLessThanOrEqual(40)
    const body = entry.getChildren()[1] as TextRenderable
    expect(body.plainText).toContain(content)
  }
  expect((transcript.getChildren().at(-1)!.getChildren()[1] as TextRenderable).height).toBeGreaterThan(2)
  const before = transcript.scrollTop
  input.pressKey('\x1b[5~'); await frame(); expect(transcript.scrollTop).toBeLessThan(before)
  const page = transcript.scrollTop
  await setup.mockMouse.scroll(transcript.x + 5, transcript.y + 1, 'up'); await frame()
  expect(transcript.scrollTop).toBeLessThan(page)
  input.pressEnter(); expect(await reading).toBe('unchanged draft')
  io.event({ type: 'text_delta', text: 'Streaming 日本語 '.repeat(10) }); await frame()
  const partial = setup.renderer.root.findDescendantById('vivi-partial') as BoxRenderable
  expect((partial.getChildren()[0] as TextRenderable).fg.equals(RGBA.fromHex(TUI_THEME.pink))).toBe(true)
  expect(partial.border).toBe(false)
  io.event({ type: 'assistant', message: { kind: 'assistant', content: 'Accepted 日本語', toolCalls: [] } }); await frame()
  expect(setup.renderer.root.findDescendantById('vivi-partial')).toBeUndefined()
})


test('extremely narrow telemetry preserves the complete total before clipping labels or title space', async () => {
  const { io, setup, frame } = await fixture({ width: 20, height: 30 })
  const session = newSession({ provider: 'openai', model: 'fixture' })
  const tokens = () => setup.renderer.root.findDescendantById('vivi-tokens') as TextRenderable
  for (const total of [2523, Number.MAX_SAFE_INTEGER]) {
    session.usage = { inputTokens: 2197, outputTokens: 326, totalTokens: total }
    io.setSession(session)
    for (const [width, height] of [[20, 30], [30, 8], [20, 8]] as const) {
      setup.resize(width, height); await frame()
      expect(tokens().plainText).toContain(String(total))
      expect(tokens().plainText).not.toContain('…')
      expect(tokens().x + tokens().width).toBeLessThanOrEqual(width)
    }
  }
  setup.resize(4, 8); await frame()
  expect(tokens().plainText).toBe('…')
})
