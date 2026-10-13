// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { RGBA, TextAttributes, TextRenderable, ScrollBoxRenderable } from '@opentui/core'
import type { CapturedSpan, Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO, TUI_THEME } from '../src/tui.js'
import { WORKSPACE_DIFF_COLORS, WorkspaceDiffRenderable } from '../src/tui-diff.js'
import { workspaceDiff, workspaceRevision } from '../src/workspace-edit.js'
import type { ApprovalRequest } from '../src/tools.js'

const active: OpenTuiIO[] = []
afterEach(() => { for (const io of active.splice(0)) io.close() })
const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
const palettes = [
  { name: 'dark', foreground: '#eeeeee', background: '#101014' },
  { name: 'light', foreground: '#202024', background: '#fafafa' },
  { name: 'custom', foreground: '#d6eea9', background: '#183d45' }
] as const
async function fixture(palette = palettes[0], width = 100, height = 40, secrets: readonly string[] = []) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const native = setup.renderer as unknown as { syncNativePaletteState(colors: object): void }
  native.syncNativePaletteState({ palette: [], defaultForeground: palette.foreground,
    defaultBackground: palette.background, cursorColor: null, mouseForeground: null,
    mouseBackground: null, tekForeground: null, tekBackground: null,
    highlightForeground: null, highlightBackground: null })
  const io = new OpenTuiIO(setup.renderer, { secrets }); active.push(io)
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const spans = () => setup.captureSpans().lines.flatMap(line => line.spans)
  const body = () => descendants(setup.renderer.root).find(node => node instanceof WorkspaceDiffRenderable) as WorkspaceDiffRenderable
  return { io, setup, frame, spans, body, input: setup.mockInput }
}
function request(before: string | null, after: string, path = 'fixture.txt'): ApprovalRequest {
  const diff = workspaceDiff(path, before, after)
  const currentRevision = before === null ? 'absent' : workspaceRevision(Buffer.from(before))
  return { call: { id: 'fixture-edit', name: before === null ? 'workspace_create_text' : 'workspace_edit_text', arguments: {} },
    currentRevision, workspaceDiff: diff,
    description: `Precisely edit workspace text file ${JSON.stringify(path)}.\nExact JSON-quoted review.\nBefore SHA-256: ${currentRevision}\nAfter SHA-256: ${workspaceRevision(Buffer.from(after))}\n${diff}` }
}
function colored(span: CapturedSpan, kind: 'added' | 'removed'): boolean {
  return span.bg.equals(RGBA.fromHex(WORKSPACE_DIFF_COLORS[`${kind}Background`])) &&
    span.fg.equals(RGBA.fromHex(WORKSPACE_DIFF_COLORS[`${kind}Foreground`]))
}
function bodySpans(spans: CapturedSpan[], body: WorkspaceDiffRenderable): CapturedSpan[] {
  let column = 0
  return spans.filter(span => {
    const start = column; column += span.width
    return start < body.x + body.width && column > body.x
  })
}
for (const palette of palettes) {
  test(`${palette.name}: exact approval uses full-width red/green bands with explicit contrasting text and unchanged markers`, async () => {
    const f = await fixture(palette), r = request('header\nold\nfooter\n', 'header\nnew\nfooter\n')
    const answer = f.io.approve(r, new AbortController().signal); await f.frame()
    expect(f.body().plainText).toBe(r.description)
    expect(f.spans().some(span => span.text.includes('-"old\\n"') && colored(span, 'removed'))).toBe(true)
    expect(f.spans().some(span => span.text.includes('+"new\\n"') && colored(span, 'added'))).toBe(true)
    const rows = f.setup.captureSpans().lines
    for (const [text, kind] of [['-"old\\n"', 'removed'], ['+"new\\n"', 'added']] as const) {
      const row = rows.find(row => row.spans.some(span => span.text.includes(text)))!
      expect(bodySpans(row.spans, f.body()).every(span => colored(span, kind))).toBe(true)
    }
    const context = f.spans().find(span => span.text.includes('"header\\n"'))!
    expect(context.bg.a).toBe(0); expect(context.fg.intent).toBe('default')
    expect(context.attributes & TextAttributes.DIM).toBe(TextAttributes.DIM)
    for (const text of ['Before SHA-256:', 'After SHA-256:', '--- "fixture.txt"', '+++ "fixture.txt"', '@@ -1,3 +1,3 @@']) {
      const span = f.spans().find(span => span.text.includes(text))!
      expect(span).toBeDefined(); expect(span.bg.a).toBe(0); expect(span.fg.intent).toBe('default')
    }
    expect(f.spans().find(span => span.text.includes('--- "fixture.txt"'))!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
    const surface = f.setup.renderer.root.findDescendantById('vivi-transcript') as ScrollBoxRenderable
    expect(surface.backgroundColor.a).toBe(0)
    f.input.pressEscape(); expect(await answer).toBe(false)
  })
}

test('native selection copies the exact full multiline diff and retains contrasting selected cells', async () => {
  const f = await fixture(), r = request('same\nold\n', 'same\nnew\n')
  const answer = f.io.approve(r, new AbortController().signal); await f.frame()
  const body = f.body(), lines = body.plainText.split('\n'), start = lines.findIndex(line => line.startsWith('--- '))
  await f.setup.mockMouse.drag(body.x, body.y + start, body.x + lines.at(-1)!.length, body.y + body.height - 1)
  await f.frame()
  expect(f.setup.renderer.getSelection()!.getSelectedText()).toBe(r.workspaceDiff!)
  expect(f.spans().some(span => span.text.includes('old') && span.bg.equals(RGBA.fromHex(TUI_THEME.selectedBackground)) &&
    span.fg.equals(RGBA.fromHex(TUI_THEME.highlightForeground)))).toBe(true)
  f.setup.renderer.clearSelection(); await f.frame()
  expect(f.spans().some(span => span.text.includes('old') && colored(span, 'removed'))).toBe(true)
  f.input.pressEscape(); expect(await answer).toBe(false)
})

test('wrapped long Unicode, tabs and control escapes stay exact and colored on every continuation row through resize and scroll', async () => {
  const f = await fixture(palettes[1], 40, 20)
  const before = 'context\n' + '旧🙂é\tword '.repeat(20) + '\r\n'
  const after = 'context\n' + '新👩‍💻é\tword '.repeat(20) + '\x1b[31m\r\n'
  const r = request(before, after, '文件🙂.txt'), answer = f.io.approve(r, new AbortController().signal)
  await f.frame()
  expect(f.body().plainText).toBe(r.description)
  expect(f.body().plainText).toContain('\\u001b[31m\\r\\n')
  const transcript = f.setup.renderer.root.findDescendantById('vivi-transcript') as ScrollBoxRenderable
  for (const [width, height] of [[40, 20], [80, 30], [28, 12], [100, 40]] as const) {
    f.setup.resize(width, height); await f.frame()
    const body = f.body()
    expect(body.plainText).toBe(r.description)
    const source = body.plainText.split('\n').findIndex(line => line.startsWith('+"'))
    const visual = body.getLineSources(0, body.height), row = visual.indexOf(source)
    transcript.scrollTo(body.y - transcript.y + transcript.scrollTop + row); await f.frame()
    const coloredRows = f.setup.captureSpans().lines.filter(line => line.spans.some(span => span.text.includes('新') || span.text.includes('word')))
    expect(coloredRows.length).toBeGreaterThan(0)
    for (const line of coloredRows) for (const span of bodySpans(line.spans, body).filter(span => span.text.trim())) {
      expect(colored(span, 'added') || colored(span, 'removed')).toBe(true)
    }
  }
  f.input.pressEscape(); expect(await answer).toBe(false)
})

for (const [name, before, after] of [['empty creation', null, ''], ['addition only', '', '\nnew\n'], ['removal only', '\nold\n', '']] as const) {
  test(`${name}: empty lines and one-sided diffs preserve complete exact text`, async () => {
    const f = await fixture(), r = request(before, after), answer = f.io.approve(r, new AbortController().signal)
    await f.frame(); expect(f.body().plainText).toBe(r.description)
    const adds = f.spans().filter(span => colored(span, 'added') && span.text.trim())
    const removes = f.spans().filter(span => colored(span, 'removed') && span.text.trim())
    expect(adds.length > 0).toBe(after.length > 0); expect(removes.length > 0).toBe((before?.length ?? 0) > 0)
    f.input.pressEscape(); expect(await answer).toBe(false)
  })
}

test('lookalike ordinary text, missing/mismatched metadata and other tools never gain diff styling', async () => {
  for (const kind of ['ordinary', 'missing', 'mismatch', 'other tool'] as const) {
    const f = await fixture(), r = request('old\n', 'new\n')
    if (kind === 'ordinary') { f.io.write(r.description); await f.frame() }
    else {
      if (kind === 'missing') delete r.workspaceDiff
      if (kind === 'mismatch') r.workspaceDiff = workspaceDiff('other.txt', 'old\n', 'new\n')
      if (kind === 'other tool') r.call.name = 'note_set'
      const answer = f.io.approve(r, new AbortController().signal); await f.frame()
      f.input.pressEscape(); expect(await answer).toBe(false)
    }
    expect(f.spans().some(span => colored(span, 'added') || colored(span, 'removed'))).toBe(false)
  }
})

test('safe control stripping and late secret redaction cannot reintroduce original diff bytes', async () => {
  const f = await fixture(), r = request('old\n', 'fixture-secret\n')
  r.description = '\x1b[31m' + r.description
  const answer = f.io.approve(r, new AbortController().signal); await f.frame()
  expect(f.body().plainText).not.toContain('\x1b')
  f.io.addSecrets(['fixture-secret']); await f.frame()
  const nodes = descendants(f.setup.renderer.root).filter(node => node instanceof TextRenderable) as TextRenderable[]
  expect(nodes.map(node => node.plainText).join('\n')).not.toContain('fixture-secret')
  expect(f.spans().some(span => colored(span, 'added') || colored(span, 'removed'))).toBe(false)
  f.input.pressEscape(); expect(await answer).toBe(false)
})

test('large exact pending review survives transcript pressure, scrolling and rebuild without a truncation notice', async () => {
  const f = await fixture(palettes[0], 60, 20)
  const r = request('old\n', Array.from({ length: 100 }, (_, i) => `new ${i} ` + 'value '.repeat(50)).join('\n') + '\n')
  const answer = f.io.approve(r, new AbortController().signal); await f.frame()
  f.io.write('ordinary activity '.repeat(4000)); await f.frame()
  expect(f.body().plainText).toBe(r.description); expect(f.body().plainText).not.toContain('[display truncated]')
  const transcript = f.setup.renderer.root.findDescendantById('vivi-transcript') as ScrollBoxRenderable
  transcript.scrollTo(0); await f.frame(); expect(f.setup.captureCharFrame()).toContain('Before SHA-256:')
  transcript.scrollTo(transcript.scrollHeight); await f.frame(); expect(f.setup.captureCharFrame()).toContain('new 99')
  await new Promise(resolve => setTimeout(resolve, 2)); await f.frame()
  f.input.pressEnter(); expect(await answer).toBe(false)
})

test('localized foreground/background pairs exceed 7:1 text contrast', () => {
  const luminance = (hex: string): number => {
    const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
  }
  for (const kind of ['added', 'removed'] as const) {
    const fg = luminance(WORKSPACE_DIFF_COLORS[`${kind}Foreground`]), bg = luminance(WORKSPACE_DIFF_COLORS[`${kind}Background`])
    expect((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)).toBeGreaterThan(7)
  }
})

test('coloring retains the native Unicode glyph frame and exact copied content at narrow widths', async () => {
  const r = request('old🙂é\n', '新👩‍💻é word '.repeat(20) + '\n')
  for (const width of [28, 40, 80]) {
    const setup = await createTestRenderer({ width, height: 100, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
    try {
      const options = { content: r.description, width: '100%' as const, wrapMode: 'word' as const, fg: RGBA.defaultForeground(),
        selectionBg: TUI_THEME.selectedBackground, selectionFg: TUI_THEME.highlightForeground }
      const ordinary = new TextRenderable(setup.renderer, options)
      setup.renderer.root.add(ordinary); await setup.renderOnce(); await setup.renderOnce()
      const original = setup.captureCharFrame(), sources = ordinary.getLineSources(0, ordinary.height)
      ordinary.destroyRecursively()
      const diff = new WorkspaceDiffRenderable(setup.renderer, options, r.workspaceDiff!)
      setup.renderer.root.add(diff); await setup.renderOnce(); await setup.renderOnce()
      expect(setup.captureCharFrame()).toBe(original)
      expect(diff.getLineSources(0, diff.height)).toEqual(sources); expect(diff.plainText).toBe(r.description)
      const lastSource = diff.plainText.split('\n').length - 1
      const endRow = sources.lastIndexOf(lastSource)
      await setup.mockMouse.drag(0, 0, width - 1, endRow); await setup.renderOnce(); await setup.renderOnce()
      expect(diff.getSelectedText()).toBe(r.description)
    } finally { setup.renderer.destroy() }
  }
})

test('scrolling long diffs never paints the fixed header, footer or transcript margins', async () => {
  const f = await fixture(palettes[1], 40, 16)
  const r = request('old\n', Array.from({ length: 80 }, (_, i) => `new ${i} ` + 'word '.repeat(30)).join('\n') + '\n')
  const answer = f.io.approve(r, new AbortController().signal); await f.frame()
  const transcript = f.setup.renderer.root.findDescendantById('vivi-transcript') as ScrollBoxRenderable
  for (const [width, height] of [[40, 16], [28, 12], [100, 40]] as const) {
    f.setup.resize(width, height); await f.frame()
    for (const position of [0, 15, transcript.scrollHeight]) {
      transcript.scrollTo(position); await f.frame()
      const viewport = transcript.viewport
      for (const [y, line] of f.setup.captureSpans().lines.entries()) {
        let x = 0
        for (const span of line.spans) {
          const end = x + span.width
          if (y < viewport.y || y >= viewport.y + viewport.height || end <= viewport.x || x >= viewport.x + viewport.width) {
            expect(span.bg.equals(RGBA.fromHex(WORKSPACE_DIFF_COLORS.addedBackground)) ||
              span.bg.equals(RGBA.fromHex(WORKSPACE_DIFF_COLORS.removedBackground))).toBe(false)
          }
          x = end
        }
      }
    }
  }
  f.input.pressEscape(); expect(await answer).toBe(false)
})
