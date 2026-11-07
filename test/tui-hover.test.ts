// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { RGBA, ScrollBoxRenderable, SelectRenderable, TextareaRenderable, TextAttributes, TextRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO, TUI_THEME } from '../src/tui.js'
import { newSession } from '../src/session.js'

const surfaces: OpenTuiIO[] = []
afterEach(() => { for (const io of surfaces.splice(0)) io.close() })
async function fixture(width = 110, height = 32) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer); surfaces.push(io)
  const node = (id: string) => setup.renderer.root.findDescendantById(id)!
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const arm = async () => { await new Promise(resolve => setTimeout(resolve, 2)); return frame() }
  const cell = (x: number, y: number) => {
    let column = 0
    for (const span of setup.captureSpans().lines[y]!.spans) {
      column += span.width
      if (column > x) return span
    }
    throw new Error(`Missing cell ${x},${y}`)
  }
  const hovered = (x: number, y: number) => cell(x, y).bg.equals(RGBA.fromHex(TUI_THEME.hoverBackground))
  const move = async (target: Renderable, x = 1, y = 0) => {
    await setup.mockMouse.moveTo(target.x + x, target.y + y); await frame()
  }
  return { io, setup, node, frame, arm, cell, hovered, move, input: setup.mockInput, mouse: setup.mockMouse }
}

test('settings actions hover across the full row without changing selection or search focus; headings stay plain', async () => {
  const f = await fixture(); f.io.setControlMode(true)
  const choosing = f.io.choose('Conversation actions', [
    { name: 'Models', value: '/models', section: 'Settings' },
    { name: 'Help', value: '/help', section: 'Application' }
  ])
  await f.arm()
  const row = f.node('vivi-control-section-row-1')
  const before = (f.node('vivi-control-description') as TextRenderable).plainText
  await f.move(row, row.width - 2)
  expect(f.hovered(row.x + 1, row.y)).toBe(true)
  expect(f.hovered(row.x + row.width - 2, row.y)).toBe(true)
  expect(f.cell(row.x + 1, row.y).fg.equals(RGBA.fromHex(TUI_THEME.highlightForeground))).toBe(true)
  expect((f.node('vivi-control-query') as TextareaRenderable).focused).toBe(true)
  expect((f.node('vivi-control-description') as TextRenderable).plainText).toBe(before)
  const heading = f.node('vivi-control-section-1')
  await f.move(heading)
  expect(f.hovered(heading.x + 1, heading.y)).toBe(false)
  expect(f.hovered(row.x + 1, row.y)).toBe(false)
  const close = f.node('vivi-control-back'); await f.move(close)
  expect(f.hovered(close.x + 1, close.y)).toBe(true)
  expect(f.cell(close.x + 1, close.y).attributes & TextAttributes.DIM).toBe(0)
  f.input.pressEscape(); expect(await choosing).toBeUndefined()
})

test('picker hover marks only real rows and leaves keyboard choice intact; empty results cannot hover', async () => {
  const f = await fixture()
  const choosing = f.io.choose('Models', [{ name: 'First', value: 1 }, { name: 'Second', value: 2 }])
  await f.arm()
  const picker = f.node('vivi-picker') as SelectRenderable
  const rowHeight = picker.showDescription ? 2 : 1
  await f.move(picker, 2, rowHeight)
  expect(f.hovered(picker.x + 2, picker.y + rowHeight)).toBe(true)
  expect(f.hovered(picker.x + 2, picker.y)).toBe(false)
  expect(picker.getSelectedIndex()).toBe(0)
  await f.move(picker, picker.width - 1, rowHeight)
  expect(f.hovered(picker.x + 2, picker.y + rowHeight)).toBe(false)
  f.input.pressEnter(); expect(await choosing).toBe(1)
  const empty = f.io.chooseSearchable('Models', [])
  await f.arm()
  const results = f.node('vivi-picker'), confirm = f.node('vivi-confirm')
  await f.move(results)
  expect(f.hovered(results.x + 1, results.y)).toBe(false)
  await f.move(confirm)
  expect(f.hovered(confirm.x + 1, confirm.y)).toBe(false)
  f.input.pressEscape(); await empty
})

test('footer hover covers separate provider, model, effort and mode cells but excludes separators and unused space', async () => {
  const f = await fixture()
  f.io.setSession(newSession({ provider: 'openai', model: 'fixture', reasoning: 'high' }))
  const line = f.io.readLine('Message'); await f.arm()
  const footer = f.node('vivi-model') as TextRenderable
  const providerEnd = footer.plainText.indexOf(' · ')
  const modelEnd = footer.plainText.indexOf(' · ', providerEnd + 3)
  expect(modelEnd).toBeGreaterThan(0)
  await f.move(footer)
  expect(f.hovered(footer.x, footer.y)).toBe(true)
  expect(f.hovered(footer.x + providerEnd, footer.y)).toBe(false)
  expect(f.hovered(footer.x + providerEnd + 3, footer.y)).toBe(false)
  await f.move(footer, providerEnd + 3)
  expect(f.hovered(footer.x + providerEnd + 3, footer.y)).toBe(true)
  expect(f.hovered(footer.x, footer.y)).toBe(false)
  expect(f.hovered(footer.x + modelEnd, footer.y)).toBe(false)
  await f.move(footer, modelEnd + 3)
  expect(f.hovered(footer.x + modelEnd + 3, footer.y)).toBe(true)
  expect(f.hovered(footer.x, footer.y)).toBe(false)
  await f.move(footer, footer.plainText.length - 1)
  expect(f.hovered(footer.x + footer.plainText.length - 1, footer.y)).toBe(true)
  expect(f.hovered(footer.x + footer.plainText.lastIndexOf(' · '), footer.y)).toBe(false)
  await f.move(footer, footer.plainText.length)
  expect(f.hovered(footer.x + footer.plainText.length, footer.y)).toBe(false)
  f.io.close(); await line
})

test('command completion hover preserves draft, selection, and editor focus until an explicit click', async () => {
  const f = await fixture(), line = f.io.readLine('Message')
  await f.arm(); await f.input.typeText('/'); await f.frame()
  const list = f.node('vivi-completion-list') as TextRenderable
  const before = list.plainText
  await f.move(list, 4, 1)
  expect(f.hovered(list.x + 4, list.y + 1)).toBe(true)
  expect(f.hovered(list.x + 4, list.y)).toBe(false)
  expect(list.plainText).toBe(before)
  expect((f.node('vivi-composer') as TextareaRenderable).plainText).toBe('/')
  expect((f.node('vivi-composer') as TextareaRenderable).focused).toBe(true)
  f.input.pressArrow('down'); await f.frame()
  expect(f.hovered(list.x + 4, list.y + 1)).toBe(false)
  f.io.close(); await line
})

test('approval hover does not choose, and blur or resize clears feedback without granting approval', async () => {
  const f = await fixture()
  const answer = f.io.approve({ call: { id: 'hover', name: 'note_set', arguments: {} },
    currentRevision: 0, description: 'Review exact change' }, new AbortController().signal)
  await f.arm()
  let deny = f.node('vivi-deny')
  await f.move(deny)
  expect(f.hovered(deny.x + 1, deny.y)).toBe(true)
  expect(await f.frame()).toContain('› Approve')
  f.setup.renderer.emit('blur'); await f.frame()
  deny = f.node('vivi-deny')
  expect(f.hovered(deny.x + 1, deny.y)).toBe(false)
  await f.move(deny, 2)
  expect(f.hovered(deny.x + 1, deny.y)).toBe(true)
  f.setup.resize(90, 28); await f.frame(); deny = f.node('vivi-deny')
  expect(f.hovered(deny.x + 1, deny.y)).toBe(false)
  f.input.pressEscape(); expect(await answer).toBe(false)
})

test('question options and independent process buttons show hover without selecting answers or stopping jobs', async () => {
  const f = await fixture(); let stopped = 0
  const release = f.io.onProcessControls({ list: () => [{ executionId: 'hover-job', executable: 'node', args: [],
    cwd: '/fixture', state: 'running', background: true, cleanupConfirmed: false, totalBytes: 0, truncated: false }],
    async stop() { stopped++ }, async stopAll() { stopped++ } })
  const answer = f.io.askQuestions({ requestId: 'hover-question', callId: 'hover-call', questions: [{ id: 'q',
    header: 'Direction', question: 'Which way?', options: [{ id: 'east', label: 'East' },
      { id: 'west', label: '西へ進む', description: 'Go west' }] }] }, new AbortController().signal)
  await f.arm()
  const west = f.node('vivi-question-option-1')
  await f.move(west, west.width - 2)
  expect(f.hovered(west.x + west.width - 2, west.y)).toBe(true)
  expect(await f.frame()).toContain('0/1 ready')
  for (const id of ['vivi-process-next', 'vivi-process-stop', 'vivi-process-stop-all', 'vivi-question-cancel']) {
    const button = f.node(id); await f.move(button)
    expect(f.hovered(button.x + 1, button.y)).toBe(true)
  }
  expect(stopped).toBe(0)
  f.input.pressEscape(); expect((await answer).status).toBe('cancelled'); release()
})

test('tool detail headers hover across their row while ordinary transcript text stays plain', async () => {
  const f = await fixture()
  f.io.write('Ordinary conversation text')
  f.io.toolPresentation(JSON.stringify({ version: 1, callId: 'hover-tool', name: 'offline_resource',
    status: 'requested', effect: 'unreported', source: { reference: 'owned://hover', revision: 'fixture' },
    arguments: { kind: 'json', text: 'Read fixture resource', data: {} } }))
  await f.frame()
  const transcript = f.node('vivi-transcript')
  const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
  const header = descendants(transcript).find(node => node.id.startsWith('vivi-tool-details-'))!
  const before = await f.frame()
  await f.move(header, header.width - 2)
  expect(f.hovered(header.x + header.width - 2, header.y)).toBe(true)
  expect(await f.frame()).toBe(before)
  const body = f.node(header.id.replace('vivi-tool-details-', 'vivi-tool-body-'))
  expect(body.getChildren()).toHaveLength(0)
  await f.move(transcript, 1)
  expect(f.hovered(header.x + header.width - 2, header.y)).toBe(false)
})

test('hover preserves wide glyphs, stays within a scrolling list, and clears on wheel input', async () => {
  const f = await fixture(44, 18); f.io.setControlMode(true)
  const choosing = f.io.choose('Conversation actions', Array.from({ length: 30 }, (_, value) => ({
    name: `選択 ${value} 👩🏽‍💻`, value, section: 'Settings'
  })))
  await f.arm()
  const list = f.node('vivi-control-sections') as ScrollBoxRenderable
  const row = f.node('vivi-control-section-row-0')
  const before = await f.frame()
  await f.move(row, 3)
  expect(f.hovered(row.x + 3, row.y)).toBe(true)
  expect(await f.frame()).toBe(before)
  const viewport = list.viewport
  for (const [y, line] of f.setup.captureSpans().lines.entries()) {
    if (y >= viewport.y && y < viewport.y + viewport.height) continue
    expect(line.spans.some(span => span.bg.equals(RGBA.fromHex(TUI_THEME.hoverBackground)))).toBe(false)
  }
  await f.mouse.scroll(row.x + 3, row.y, 'down'); await f.frame()
  expect(f.setup.captureSpans().lines.flatMap(line => line.spans)
    .some(span => span.bg.equals(RGBA.fromHex(TUI_THEME.hoverBackground)))).toBe(false)
  expect((f.node('vivi-control-query') as TextareaRenderable).focused).toBe(true)
  f.input.pressEscape(); await choosing
})
