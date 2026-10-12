// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { MarkdownRenderable, RGBA, TextareaRenderable, TextAttributes, TextBufferRenderable, TextTableRenderable } from '@opentui/core'
import type { CapturedSpan, Renderable } from '@opentui/core'
import { createTestRenderer, setRendererCapabilities } from '@opentui/core/testing'
import type { TestRendererSetup } from '@opentui/core/testing'
import { OpenTuiIO, TUI_THEME } from '../src/tui.js'
import { newSession } from '../src/session.js'

const palettes = [
  { name: 'dark', foreground: '#eeeeee', background: '#101014' },
  { name: 'light', foreground: '#202024', background: '#fafafa' },
  { name: 'custom', foreground: '#d6eea9', background: '#183d45' }
] as const
const fixtures: OpenTuiIO[] = []
afterEach(() => { for (const io of fixtures.splice(0)) io.close() })
async function fixture(palette: typeof palettes[number]) {
  const setup = await createTestRenderer({ width: 100, height: 40, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  // Seed the pinned native renderer's palette without OSC queries or a real terminal.
  // Captured spans preserve color intent; default intent is resolved by the terminal.
  const native = setup.renderer as unknown as { syncNativePaletteState(colors: object): void }
  native.syncNativePaletteState({ palette: [], defaultForeground: palette.foreground,
    defaultBackground: palette.background, cursorColor: null, mouseForeground: null,
    mouseBackground: null, tekForeground: null, tekBackground: null,
    highlightForeground: null, highlightBackground: null })
  const io = new OpenTuiIO(setup.renderer)
  fixtures.push(io)
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  return { io, setup, frame, composer, input: setup.mockInput }
}
const spans = (setup: TestRendererSetup): CapturedSpan[] => setup.captureSpans().lines.flatMap(line => line.spans)
function ordinary(setup: TestRendererSetup, text: string): CapturedSpan {
  const span = spans(setup).find(span => span.text.includes(text) && span.bg.a === 0 && span.fg.intent === 'default')
  expect(span).toBeDefined()
  expect(span!.fg.intent).toBe('default')
  expect(span!.fg.slot).toBe(0)
  expect(span!.bg.a).toBe(0)
  return span!
}
function inheritedSurfaces(setup: TestRendererSetup): void {
  // The only opaque cells belong to intentionally localized highlights.
  for (const span of spans(setup)) {
    expect(span.bg.a === 0 || [TUI_THEME.userBackground, TUI_THEME.selectedBackground]
      .some(color => span.bg.equals(RGBA.fromHex(color)))).toBe(true)
  }
}
function contrastingSelection(setup: TestRendererSetup, text: string): void {
  const selected = spans(setup).filter(span => span.bg.equals(RGBA.fromHex(TUI_THEME.selectedBackground)) && text.includes(span.text.trim()))
  expect(selected.some(span => span.text.trim())).toBe(true)
  for (const span of selected.filter(span => span.text.trim())) {
    expect(span.fg.equals(RGBA.fromHex(TUI_THEME.highlightForeground))).toBe(true)
    expect(span.fg.intent).toBe('rgb')
  }
}
const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
const request = { call: { id: 'theme-note', name: 'note_set', arguments: { key: 'topic', value: 'fixture', expectedRevision: 1 } },
  description: 'Save ordinary approval details', currentRevision: 1 }

for (const palette of palettes) {
  test(`${palette.name}: startup, resize, focused/unfocused composer and ordinary transcript inherit terminal colors`, async () => {
    const { io, setup, frame, composer, input } = await fixture(palette)
    await frame()
    expect(spans(setup).every(span => span.bg.a === 0)).toBe(true)
    expect(ordinary(setup, 'Ready').attributes & TextAttributes.DIM).toBe(TextAttributes.DIM)
    const line = io.readLine('Message')
    await input.typeText('Ordinary draft')
    for (const focused of [false, true]) {
      if (focused) composer.focus(); else composer.blur()
      await frame(); ordinary(setup, 'Ordinary draft'); inheritedSurfaces(setup)
      expect(composer.backgroundColor.a).toBe(0)
      expect(composer.textColor.intent).toBe('default')
    }
    for (const [width, height] of [[40, 12], [120, 50], [100, 40]]) {
      setup.resize(width!, height!); await frame()
      ordinary(setup, 'Ordinary draft'); inheritedSurfaces(setup)
    }
    input.pressEnter(); expect(await line).toBe('Ordinary draft')
    io.write('Ordinary activity')
    const session = newSession({ provider: 'openai', model: 'fixture' })
    session.history = [{ kind: 'message', role: 'user', content: 'Highlighted user message' },
      { kind: 'assistant', content: 'Ordinary answer', toolCalls: [] }]
    io.setSession(session); await frame()
    ordinary(setup, 'Ordinary answer'); inheritedSurfaces(setup)
    const user = spans(setup).find(span => span.text.includes('Highlighted user message') && span.bg.a > 0)!
    expect(user.bg.equals(RGBA.fromHex(TUI_THEME.userBackground))).toBe(true)
    expect(user.fg.equals(RGBA.fromHex(TUI_THEME.highlightForeground))).toBe(true)
    expect(spans(setup).some(span => span.fg.equals(RGBA.fromHex(TUI_THEME.pink)))).toBe(true)
    expect(spans(setup).some(span => span.fg.equals(RGBA.fromHex(TUI_THEME.lavender)))).toBe(true)
  })

  test(`${palette.name}: normal and search pickers inherit in both focus states and repeated cancel/reopen`, async () => {
    const { io, setup, frame, input } = await fixture(palette)
    const choices = [{ name: 'First model', description: 'First details', value: 1 },
      { name: 'Ordinary model', description: 'Ordinary details', value: 2 }]
    for (let repeat = 0; repeat < 2; repeat++) {
      const choice = io.choose('Choose model', choices)
      const picker = setup.renderer.root.findDescendantById('vivi-picker')!
      for (const focused of [false, true]) {
        if (focused) picker.focus(); else picker.blur()
        await frame(); ordinary(setup, 'Ordinary model'); ordinary(setup, 'Ordinary details')
        inheritedSurfaces(setup)
      }
      input.pressEscape(); expect(await choice).toBeUndefined()
      await frame(); expect(setup.renderer.root.findDescendantById('vivi-picker')).toBeUndefined()
      const search = io.chooseSearchable('Find model', choices)
      await input.typeText('model'); await frame()
      ordinary(setup, 'model'); ordinary(setup, 'Ordinary model'); inheritedSurfaces(setup)
      setup.resize(50, 20); await frame(); ordinary(setup, 'Ordinary model')
      input.pressEscape(); expect(await search).toBeUndefined()
      setup.resize(100, 40); await frame(); inheritedSurfaces(setup)
    }
    const line = io.readLine('Message'); await input.typeText('Fresh draft'); await frame()
    ordinary(setup, 'Fresh draft'); input.pressEnter(); expect(await line).toBe('Fresh draft')
  })

  test(`${palette.name}: secret mask and approval keep transparent dialogs and cancellation safety`, async () => {
    const { io, setup, frame, input, composer } = await fixture(palette)
    for (let repeat = 0; repeat < 2; repeat++) {
      const secret = io.askSecret('Fixture secret')
      await input.typeText('fixture-secret-only'); const masked = await frame()
      expect(masked).toContain('•'); expect(masked).not.toContain('fixture-secret-only')
      expect(composer.plainText).toBe(''); inheritedSurfaces(setup)
      input.pressEscape(); expect(await secret).toBeUndefined()
      await frame(); inheritedSurfaces(setup)
      const approval = io.approve(request, new AbortController().signal)
      await frame(); ordinary(setup, 'Save ordinary approval details'); inheritedSurfaces(setup)
      expect(spans(setup).some(span => span.text.includes('Deny') &&
        span.bg.equals(RGBA.fromHex(TUI_THEME.selectedBackground)))).toBe(true)
      input.pressEscape(); expect(await approval).toBe(false)
      await frame(); inheritedSurfaces(setup)
    }
  })

  test(`${palette.name}: mouse and keyboard selections stay contrasting and preserve exact copied text`, async () => {
    const { io, setup, frame, input, composer } = await fixture(palette)
    const line = io.askText('Text', 'Copy draft')
    await frame()
    for (let count = 0; count < 5; count++) input.pressArrow('left', { shift: true })
    await frame(); expect(composer.getSelectedText()).toBe('draft'); contrastingSelection(setup, 'draft')
    input.pressEscape(); expect(await line).toBeUndefined()
    const session = newSession({ provider: 'openai', model: 'fixture' })
    session.history = [{ kind: 'message', role: 'user', content: 'Copy user' },
      { kind: 'assistant', content: 'Copy answer\n\n> Copy quote\n\n| Header | Other |\n| --- | --- |\n| Copy table | Value |\n\n```text\nCopy code\n```', toolCalls: [] }]
    io.setSession(session); await frame()
    const transcript = setup.renderer.root.findDescendantById('vivi-transcript')!
    for (const text of ['Copy user', 'Copy answer', 'Copy quote', 'Copy code']) {
      const node = descendants(transcript).find(node => node instanceof TextBufferRenderable && node.plainText.includes(text)) as TextBufferRenderable
      expect(node).toBeDefined()
      expect(node.selectionFg!.equals(RGBA.fromHex(TUI_THEME.highlightForeground))).toBe(true)
      const row = setup.captureCharFrame().split('\n').findIndex(row => row.includes(text))
      const col = setup.captureCharFrame().split('\n')[row]!.indexOf(text)
      await setup.mockMouse.drag(col, row, col + text.length, row)
      await frame(); expect(setup.renderer.getSelection()!.getSelectedText()).toBe(text)
      contrastingSelection(setup, text); setup.renderer.clearSelection(); await frame()
    }
    const table = descendants(transcript).find(node => node instanceof TextTableRenderable) as TextTableRenderable
    expect(table).toBeDefined()
    const rows = setup.captureCharFrame().split('\n'), row = rows.findIndex(row => row.includes('Copy table'))
    const col = rows[row]!.indexOf('Copy table')
    await setup.mockMouse.drag(col, row, col + 'Copy table'.length, row)
    await frame(); expect(setup.renderer.getSelection()!.getSelectedText()).toContain('Copy table')
    contrastingSelection(setup, 'Copy table')
    setup.renderer.clearSelection(); await frame(); inheritedSurfaces(setup)
  })
}


const tableText = '| Header | Other |\n| --- | --- |\n| Copy table | Value |\n'
function tableSpacing(setup: TestRendererSetup): void {
  const nodes = descendants(setup.renderer.root)
  const table = nodes.find(node => node instanceof TextTableRenderable)!
  const following = nodes.find(node => node instanceof TextBufferRenderable && node.plainText.includes('Following paragraph'))!
  expect(table).toBeDefined(); expect(following).toBeDefined()
  expect(following.y - table.y - table.height).toBe(1)
}
async function selectText(setup: TestRendererSetup, frame: () => Promise<string>, text: string, endAdjustment = 0): Promise<void> {
  const rows = setup.captureCharFrame().split('\n'), row = rows.findIndex(row => row.includes(text))
  const col = rows[row]!.indexOf(text)
  // These fixtures use single-width text; Unicode copies are checked separately.
  await setup.mockMouse.drag(col, row, col + text.length + endAdjustment, row)
  await frame(); expect(setup.renderer.getSelection()!.getSelectedText()).toBe(text)
  contrastingSelection(setup, text)
  setup.renderer.clearSelection(); await frame(); inheritedSurfaces(setup)
}
test('static Markdown tables preserve native spacing, transparent ordinary cells and header selection', async () => {
  const { io, setup, frame } = await fixture(palettes[1])
  io.event({ type: 'assistant', message: { kind: 'assistant', content: tableText + '\nFollowing paragraph\n', toolCalls: [] } })
  await frame(); tableSpacing(setup); ordinary(setup, 'Copy table'); ordinary(setup, 'Value')
  await selectText(setup, frame, 'Copy table'); await selectText(setup, frame, 'Header')
})
for (const initial of [tableText, tableText + '\n']) {
  test(`streamed Markdown table retains native spacing after ${initial.endsWith('\n\n') ? 'existing' : 'new'} blank newline`, async () => {
    const { io, setup, frame } = await fixture(palettes[0])
    io.event({ type: 'text_delta', text: initial }); await frame()
    const nodes = descendants(setup.renderer.root)
    const markdown = nodes.find(node => node instanceof MarkdownRenderable)!
    const table = nodes.find(node => node instanceof TextTableRenderable)!
    expect(markdown.height).toBe(table.height)
    io.event({ type: 'text_delta', text: (initial.endsWith('\n\n') ? '' : '\n') + 'Following paragraph\n' })
    await frame(); tableSpacing(setup); await selectText(setup, frame, 'Copy table')
  })
}
test('nested Markdown table selections preserve wide glyphs, native content and copied text', async () => {
  const { io, setup, frame } = await fixture(palettes[2])
  io.event({ type: 'assistant', message: { kind: 'assistant', content: '- Intro\n\n  | Header | Other |\n  | --- | --- |\n  | Nested 世界 | Value |\n\nOutside paragraph', toolCalls: [] } })
  await frame(); ordinary(setup, 'Nested 世界')
  const table = descendants(setup.renderer.root).find(node => node instanceof TextTableRenderable) as TextTableRenderable
  const original = structuredClone(table.content)
  const rows = setup.captureCharFrame().split('\n'), row = rows.findIndex(row => row.includes('Nested 世界'))
  const col = rows[row]!.indexOf('Nested 世界')
  await setup.mockMouse.drag(col, row, col + 11, row); await frame()
  expect(setup.renderer.getSelection()!.getSelectedText()).toBe('Nested 世界')
  contrastingSelection(setup, 'Nested 世界'); expect(table.content).toEqual(original)
  setup.renderer.clearSelection(); await frame(); ordinary(setup, 'Nested 世界'); inheritedSurfaces(setup)
})
test('newly appended streamed list children get contrasting native selections', async () => {
  const { io, setup, frame } = await fixture(palettes[0])
  io.event({ type: 'text_delta', text: '- First item\n' }); await frame()
  io.event({ type: 'text_delta', text: '- Second selection\n' }); await frame()
  ordinary(setup, 'Second selection'); await selectText(setup, frame, 'Second selection')
})
test('late hyperlink capability changes keep native table identity, reflow and selection colors', async () => {
  const { io, setup, frame } = await fixture(palettes[1])
  io.event({ type: 'assistant', message: { kind: 'assistant', content: '| Header | Other |\n| --- | --- |\n| [OpenAI](https://openai.com) | Value |\n', toolCalls: [] } })
  await frame()
  const table = descendants(setup.renderer.root).find(node => node instanceof TextTableRenderable) as TextTableRenderable
  const text = () => table.content.flat(2).map(chunk => chunk?.text ?? '').join('')
  expect(text()).toContain('https://openai.com')
  for (const hyperlinks of [true, false, true]) {
    const capabilities = setRendererCapabilities(setup.renderer, { hyperlinks })
    setup.renderer.emit('capabilities', capabilities); await frame()
    expect(descendants(setup.renderer.root).find(node => node instanceof TextTableRenderable)).toBe(table)
    expect(text().includes('https://openai.com')).toBe(!hyperlinks)
    expect(table.content.flat(2).find(chunk => chunk?.text === 'OpenAI')!.link!.url).toBe('https://openai.com')
    // Table selection endpoints include the next cell when fallback text follows.
    await selectText(setup, frame, 'OpenAI', hyperlinks ? 0 : -1)
  }
})
