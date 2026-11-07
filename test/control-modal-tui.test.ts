// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { RGBA, SelectRenderable, TextareaRenderable, TextRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO, TUI_THEME } from '../src/tui.js'
import { pickerIndexAt } from '../src/tui-mouse.js'
const surfaces: OpenTuiIO[] = []
afterEach(() => { for (const io of surfaces.splice(0)) io.close() })
const choices = [{ name: 'Context details', description: 'Input usage and capacity', value: '/context' },
  { name: 'Session details', description: 'Workspace and permissions', value: '/session' },
  { name: 'Choose model', description: 'Change the current model', value: '/models' }]
const sectioned = [
  { name: 'Choose model', value: '/models', section: 'Models & providers' },
  { name: 'Reasoning effort', value: '/effort', section: 'Models & providers' },
  { name: 'New conversation', value: '/new', section: 'Conversation' },
  { name: 'Resume conversation', value: '/resume', section: 'Conversation' },
  { name: 'Help', value: '/help', section: 'Application' },
  { name: 'Quit', value: '/exit', section: 'Application' }
]
async function fixture(width = 110, height = 32) {
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer); surfaces.push(io)
  const node = (id: string) => setup.renderer.root.findDescendantById(id)!
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const arm = async () => { await new Promise(resolve => setTimeout(resolve, 2)); return frame() }
  return { io, setup, node, frame, arm, input: setup.mockInput, mouse: setup.mockMouse }
}

test('controls overlay is centered over the unchanged transcript and searches exact choices', async () => {
  const f = await fixture()
  f.io.write('Background conversation'); const transcript = f.node('vivi-transcript'), count = transcript.getChildren().length
  await f.frame()
  const composerY = f.node('vivi-composer-box').y, composerHeight = f.node('vivi-composer-box').height
  f.io.setControlMode(true)
  const choosing = f.io.choose('Conversation actions', choices)
  await f.arm()
  const panel = f.node('vivi-control-panel')
  expect(panel.x).toBeGreaterThan(0); expect(panel.y).toBeGreaterThan(0)
  expect(Math.abs(panel.x * 2 + panel.width - 110)).toBeLessThanOrEqual(1)
  expect(Math.abs(panel.y * 2 + panel.height - 32)).toBeLessThanOrEqual(1)
  expect(f.node('vivi-root').opacity).toBe(0.35)
  expect(f.node('vivi-composer-box').y).toBe(composerY)
  expect(f.node('vivi-composer-box').height).toBe(composerHeight)
  await f.input.typeText('context'); const displayed = await f.frame()
  expect(displayed).toContain('Context details'); expect(displayed).not.toContain('Session details')
  f.input.pressEnter(); expect(await choosing).toBe('/context')
  expect(transcript.getChildren().length).toBe(count)
  f.io.setControlMode(false)
  expect(f.node('vivi-control-overlay')).toBeUndefined()
  expect(f.node('vivi-root').opacity).toBe(1)
})

test('mouse wheel and full-row clicks retain search focus and cannot use stale filtered rows', async () => {
  const f = await fixture(), many = Array.from({ length: 50 }, (_, value) => ({ name: `Action ${value}`, value }))
  f.io.setControlMode(true); const choosing = f.io.choose('Conversation actions', many)
  await f.arm()
  const picker = f.node('vivi-control-picker') as SelectRenderable
  await f.mouse.scroll(picker.x + 3, picker.y, 'down'); await f.frame()
  expect(picker.getSelectedIndex()).toBe(1)
  for (const direction of ['down', 'down', 'up'] as const) await f.mouse.scroll(picker.x + 3, picker.y, direction)
  await f.frame(); expect(picker.getSelectedIndex()).toBe(0)
  expect((f.node('vivi-control-query') as TextareaRenderable).focused).toBe(true)
  await f.mouse.pressDown(picker.x + 3, picker.y)
  await f.input.typeText('Action 49'); await f.frame()
  await f.mouse.release(picker.x + 3, picker.y)
  let finished = false; void choosing.then(() => { finished = true }); await Promise.resolve(); expect(finished).toBe(false)
  await f.mouse.click(picker.x + picker.width - 3, picker.y)
  expect(await choosing).toBe(49)
})

test('resume rows alternate shading through scrolling and filtering, with distinct selection and hover', async () => {
  const f = await fixture(); f.io.setControlMode(true)
  const choosing = f.io.choose('Resume a local session', Array.from({ length: 40 }, (_, value) => ({ name: `Session ${value}`, leadingText: `${value}d ago`, value })))
  const displayed = await f.arm()
  expect(displayed).toContain('0d ago   Session 0')
  expect(displayed).toContain('10d ago  Session 10')
  const picker = f.node('vivi-control-picker') as SelectRenderable
  const background = (x: number, y: number) => {
    let column = 0
    for (const span of f.setup.captureSpans().lines[y]!.spans) {
      column += span.width
      if (column > x) return span.bg.toInts().join(',')
    }
    throw new Error('Missing picker cell')
  }
  const bands = () => {
    for (let row = 0; row < picker.height; row++) {
      const index = pickerIndexAt(picker, picker.x, picker.y + row)
      if (index === undefined || index === picker.getSelectedIndex()) continue
      expect(background(picker.x + picker.width - 3, picker.y + row) === stripe)
        .toBe(index % 2 === 0)
    }
  }
  expect((f.node('vivi-control-query') as TextareaRenderable).plainText).toBe('')
  const stripe = RGBA.fromHex(TUI_THEME.rowBackground).toInts().join(',')
  expect(background(picker.x + 3, picker.y + 2)).toBe(stripe)
  expect(background(picker.x + 3, picker.y)).not.toBe(stripe)
  expect(background(picker.x + 3, picker.y + 1)).not.toBe(stripe)
  bands()
  await f.mouse.moveTo(picker.x + 3, picker.y + 2); await f.frame()
  expect(background(picker.x + 3, picker.y + 2)).not.toBe(stripe)
  for (let step = 0; step < 15; step++) f.input.pressArrow('down')
  await f.frame()
  bands()
  f.setup.resize(70, 20); await f.frame(); bands()
  await f.input.typeText('No session matches'); await f.frame()
  expect(background(picker.x + 3, picker.y)).not.toBe(stripe)
  f.input.pressKey('u', { ctrl: true }); await f.input.typeText('Session 14'); await f.frame()
  expect(picker.options[0]!.name).toBe('14d ago  Session 14')
  await f.mouse.click(picker.x + 3, picker.y)
  expect(await choosing).toBe(14)
})

test('context detail view scrolls independently and returns to the same menu search', async () => {
  const f = await fixture(); f.io.setControlMode(true)
  const menu = f.io.choose('Conversation actions', choices); await f.arm()
  await f.input.typeText('context'); await f.frame(); f.input.pressEnter(); expect(await menu).toBe('/context')
  const details = f.io.showControlDetails({ title: 'Context', meter: { label: 'Estimated input', value: 2500, capacity: 10000 },
    fields: [{ label: 'Capacity', value: '10,000 tokens' }], sections: [{ title: 'Details', body: 'Independent detail text\n'.repeat(50) }] })
  expect(await f.arm()).toContain('25%')
  expect(f.node('vivi-transcript').getChildren()).toHaveLength(0)
  f.input.pressKey('pagedown'); await f.frame()
  const body = f.node('vivi-control-body') as import('@opentui/core').ScrollBoxRenderable
  for (const direction of ['down', 'down', 'down', 'up', 'up', 'up'] as const) {
    const before = body.scrollTop
    await f.mouse.scroll(body.viewport.x + 2, body.viewport.y + 1, direction); await f.frame()
    expect(body.scrollTop).toBe(before + (direction === 'down' ? 1 : -1))
  }
  f.input.pressEscape(); await details
  const back = f.io.choose('Conversation actions', choices); await f.arm()
  expect((f.node('vivi-control-query') as TextareaRenderable).plainText).toBe('context')
  f.input.pressEscape(); expect(await back).toBeUndefined()
})

test('nested settings text stays in the overlay and local output never enters history', async () => {
  const f = await fixture(); f.io.setControlMode(true)
  const text = f.io.askText('Conversation name', 'Old name'); await f.arm()
  f.input.pressKey('u', { ctrl: true }); await f.input.typeText('New name')
  f.setup.renderer.stdin.emit('data', Buffer.from('\n')); await f.input.typeText('second line'); await f.frame()
  const query = f.node('vivi-control-query') as TextareaRenderable
  const value = query.plainText
  expect(value).toBe('New name\nsecond line')
  f.input.pressKey('-', { ctrl: true }); expect(query.plainText.length).toBeLessThan(value.length)
  f.input.pressKey('.', { ctrl: true }); expect(query.plainText).toBe(value)
  const confirm = f.node('vivi-control-confirm'); await f.mouse.click(confirm.x + 1, confirm.y)
  expect(await text).toBe(value)
  f.io.write('Saved local settings\n')
  const menu = f.io.choose('Conversation actions', choices)
  expect(await f.arm()).toContain('Saved local settings')
  expect(f.node('vivi-transcript').getChildren()).toHaveLength(0)
  f.input.pressEscape(); await menu
})

test('overlay fits compact resize, rejects held confirmation, and closes on a fresh outside click', async () => {
  const f = await fixture(); f.io.setControlMode(true)
  const choosing = f.io.choose('Conversation actions', choices)
  f.input.pressEnter(); await f.arm()
  let finished = false; void choosing.then(() => { finished = true })
  f.setup.renderer.stdin.emit('data', Buffer.from('\x1b[13;1:2u')); await Promise.resolve(); expect(finished).toBe(false)
  for (const [width, height] of [[40, 12], [30, 8], [110, 32]]) {
    f.setup.resize(width!, height!); await f.frame()
    const panel = f.node('vivi-control-panel')
    expect(panel.x).toBeGreaterThanOrEqual(0); expect(panel.y).toBeGreaterThanOrEqual(0)
    expect(panel.x + panel.width).toBeLessThanOrEqual(width!)
    expect(panel.y + panel.height).toBeLessThanOrEqual(height!)
    const picker = f.node('vivi-control-picker')
    expect(picker.y + picker.height).toBeLessThanOrEqual(panel.y + panel.height)
  }
  await f.mouse.click(0, 0); expect(await choosing).toBeUndefined()
})

test('late credentials are redacted in modal fields and closing settles active input', async () => {
  const f = await fixture(); f.io.setControlMode(true)
  const details = f.io.showControlDetails({ title: 'Local state', fields: [{ label: 'Value', value: 'private-fixture-value' }] })
  await f.arm(); f.io.addSecrets(['private-fixture-value'])
  expect(await f.frame()).not.toContain('private-fixture-value')
  expect((f.node('vivi-control-title') as TextRenderable).plainText).toContain('Local state')
  f.io.close(); await details; expect(f.io.isClosed).toBe(true)
})

test('model refresh and long settings output stay accessible by mouse without transcript entries', async () => {
  const f = await fixture(); f.io.setControlMode(true)
  const models = f.io.chooseSearchable('Models', choices, { refresh: true })
  await f.arm()
  const refresh = f.node('vivi-control-refresh'); await f.mouse.click(refresh.x + 1, refresh.y)
  expect(await models).toEqual({ kind: 'refresh', query: '' })
  f.io.write('Detailed local settings output\n'.repeat(30))
  const menu = f.io.choose('Conversation actions', choices)
  expect(await f.arm()).toContain('Detailed local settings output')
  expect(f.node('vivi-control-body').visible).toBe(true)
  const back = f.node('vivi-control-back'); await f.mouse.click(back.x + 1, back.y)
  await f.arm(); expect(f.node('vivi-control-picker').visible).toBe(true)
  expect(f.node('vivi-transcript').getChildren()).toHaveLength(0)
  f.io.close(); expect(await menu).toBeUndefined()
})

test('human approval suspends the overlay and uses the existing fresh confirmation surface', async () => {
  const f = await fixture(); f.io.setControlMode(true)
  const choosing = f.io.choose('Conversation actions', choices); await f.arm(); f.input.pressEnter(); await choosing
  const approval = f.io.approve({ call: { id: 'modal-approval', name: 'memory_create', arguments: {} },
    currentRevision: 'new memory', description: 'Exact local change' }, new AbortController().signal)
  await f.arm()
  expect(f.node('vivi-control-overlay').visible).toBe(false)
  expect(f.node('vivi-root').opacity).toBe(1)
  expect(await f.frame()).toContain('Exact local change')
  f.input.pressEscape(); expect(await approval).toBe(false)
  expect(f.node('vivi-control-overlay').visible).toBe(true)
})

test('muted section headers are not selectable and keyboard navigation moves only between actions', async () => {
  const f = await fixture(); f.io.setControlMode(true)
  const choosing = f.io.choose('Conversation actions', sectioned)
  const displayed = await f.arm()
  for (const section of ['Models & providers', 'Conversation', 'Application']) expect(displayed).toContain(section)
  const header = f.node('vivi-control-section-0') as TextRenderable
  expect(header.selectable).toBe(false)
  let finished = false; void choosing.then(() => { finished = true })
  await f.mouse.click(header.x + 1, header.y); await Promise.resolve(); expect(finished).toBe(false)
  f.input.pressArrow('down'); f.input.pressArrow('down'); await f.frame()
  expect((f.node('vivi-control-description') as TextRenderable).plainText).toContain('/new')
  f.input.pressEnter(); expect(await choosing).toBe('/new')
})

test('search retains matching groups, hides empty headings and rejects stale row clicks', async () => {
  const f = await fixture(); f.io.setControlMode(true)
  const choosing = f.io.choose('Conversation actions', sectioned); await f.arm()
  const original = f.node('vivi-control-section-row-0')
  await f.mouse.pressDown(original.x + 2, original.y)
  await f.input.typeText('Quit'); const displayed = await f.frame()
  expect(displayed).toContain('Application'); expect(displayed).toContain('Quit')
  expect(displayed).not.toContain('Models & providers'); expect(displayed).not.toContain('Conversation')
  const target = f.node('vivi-control-section-row-5')
  await f.mouse.release(target.x + 2, target.y)
  let finished = false; void choosing.then(() => { finished = true }); await Promise.resolve(); expect(finished).toBe(false)
  await f.mouse.click(target.x + target.width - 2, target.y)
  expect(await choosing).toBe('/exit')
  const next = f.io.choose('Conversation actions', sectioned); await f.arm()
  f.input.pressKey('u', { ctrl: true }); await f.input.typeText('no-such-action'); await f.frame()
  expect(await f.frame()).toContain('No matching commands')
  for (const section of ['Models & providers', 'Conversation', 'Application']) expect(await f.frame()).not.toContain(section)
  f.input.pressEnter(); f.input.pressEscape(); expect(await next).toBeUndefined()
})

test('exact action matches outrank similarly named sections during search', async () => {
  const f = await fixture(); f.io.setControlMode(true)
  const choosing = f.io.choose('Conversation actions', [...sectioned, { name: 'Mode', value: '/mode', section: 'Permissions' }])
  await f.arm(); await f.input.typeText('mode'); await f.frame()
  expect((f.node('vivi-control-description') as TextRenderable).plainText).toContain('/mode')
  f.input.pressEnter(); expect(await choosing).toBe('/mode')
})

test('section navigation scrolls the selected action into view and wheel browsing keeps typing focused', async () => {
  const f = await fixture(), many = Array.from({ length: 30 }, (_, value) => ({ name: `Action ${value}`, value,
    section: ['Models', 'Conversation', 'Tools'][Math.floor(value / 10)]! }))
  f.io.setControlMode(true); const choosing = f.io.choose('Conversation actions', many); await f.arm()
  const list = f.node('vivi-control-sections') as import('@opentui/core').ScrollBoxRenderable
  for (const [direction, expected] of [['down', 1], ['down', 1], ['up', 0], ['up', 0]] as const) {
    await f.mouse.scroll(list.viewport.x + 2, list.viewport.y, direction); await f.frame()
    expect(list.scrollTop).toBe(expected)
  }
  for (let index = 0; index < 10; index++) f.input.pressArrow('down')
  await f.frame()
  const selected = f.node('vivi-control-section-row-10')
  expect(list.scrollTop).toBeGreaterThan(0)
  expect(selected.y).toBeGreaterThanOrEqual(list.viewport.y)
  expect(selected.y + selected.height).toBeLessThanOrEqual(list.viewport.y + list.viewport.height)
  const before = list.scrollTop
  await f.mouse.scroll(list.x + 2, list.y + 2, 'down'); await f.frame()
  expect(list.scrollTop).toBe(before + 1)
  expect((f.node('vivi-control-query') as TextareaRenderable).focused).toBe(true)
  const index = many.findIndex((_, value) => {
    const row = f.node(`vivi-control-section-row-${value}`)
    return row.y >= list.viewport.y && row.y + row.height <= list.viewport.y + list.viewport.height
  })
  expect(index).toBeGreaterThan(0)
  const target = f.node(`vivi-control-section-row-${index}`)
  await f.mouse.click(target.x + target.width - 2, target.y); expect(await choosing).toBe(index)
})

test('short output hidden by compact layout opens readable details before returning to commands', async () => {
  const f = await fixture(80, 16); f.io.setControlMode(true)
  const notice = 'Choose a model before selecting approval mode'
  f.io.write(`${notice}\n`)
  const menu = f.io.choose('Conversation actions', choices)
  expect(await f.arm()).toContain(notice)
  expect(f.node('vivi-control-body').visible).toBe(true)
  expect(f.node('vivi-transcript').getChildren()).toHaveLength(0)
  f.input.pressEscape(); await f.arm()
  expect(f.node('vivi-control-picker').visible).toBe(true)
  f.input.pressEscape(); expect(await menu).toBeUndefined()
})

test('wrapped notices use details while fully visible notices need no extra acknowledgment', async () => {
  const f = await fixture(40, 32); f.io.setControlMode(true)
  const notice = 'The selected account changed. Use /new or /models before sending another message; no previous-account request was sent.'
  f.io.write(`${notice}\n`)
  const menu = f.io.choose('Conversation actions', choices)
  await f.arm()
  expect(f.node('vivi-control-body').visible).toBe(true)
  expect(await f.frame()).toContain('previous-account request was')
  f.input.pressEscape(); await f.arm(); f.input.pressEscape(); await menu
  f.io.write('Setting saved\n')
  const next = f.io.choose('Conversation actions', choices)
  expect(await f.arm()).toContain('Setting saved')
  expect(f.node('vivi-control-picker').visible).toBe(true)
  f.input.pressEscape(); await next
  await f.io.showControlOutput(true)
  expect(f.node('vivi-control-body').visible).toBe(false)
})

test('oversized modal paste preserves the entire existing value instead of truncating its tail', async () => {
  const f = await fixture(); f.io.setControlMode(true)
  const text = f.io.askText('Edit settings', 'Keep this existing suffix'); await f.arm()
  const query = f.node('vivi-control-query') as TextareaRenderable
  query.gotoBufferHome()
  f.setup.renderer.stdin.emit('data', Buffer.from(`\x1b[200~${'x'.repeat(65536)}\x1b[201~`))
  await f.frame()
  expect(query.plainText).toBe('Keep this existing suffix')
  expect(await f.frame()).toContain('Paste ignored: input limit is 65536')
  f.input.pressEnter(); expect(await text).toBe('Keep this existing suffix')
  f.io.setControlMode(false); f.io.setControlMode(true)
  const choosing = f.io.choose('Conversation actions', choices); await f.arm()
  await f.input.typeText('context'); await f.frame()
  f.setup.renderer.stdin.emit('data', Buffer.from(`\x1b[200~${'x'.repeat(200)}\x1b[201~`))
  await f.frame()
  expect((f.node('vivi-control-query') as TextareaRenderable).plainText).toBe('context')
  f.input.pressEnter(); expect(await choosing).toBe('/context')
})
