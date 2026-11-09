// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { TextareaRenderable, ImageRenderable } from '@opentui/core'
import type { ClipboardReadResult } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import type { OpenTuiOptions } from '../src/tui.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PastedImage } from '../src/image-assets.js'

const active: OpenTuiIO[] = []
afterEach(() => { for (const io of active.splice(0)) io.close() })
async function fixture(options: OpenTuiOptions = {}) {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer, options); active.push(io)
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 2000
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Paste did not settle: ${composer.plainText}`)
      await new Promise(resolve => setTimeout(resolve, 1)); await frame()
    }
    await frame()
  }
  return { io, setup, composer, frame, until, input: setup.mockInput }
}
const text = 'first line\n' + 'long text 中文🙂 '.repeat(100)
const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
async function imageFile() {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-paste-path-tui-'))
  const path = join(directory, 'Screenshot with spaces.png')
  await writeFile(path, pixels)
  return { directory, path, cleanup: () => rm(directory, { recursive: true, force: true }) }
}

test('clicking a thumbnail opens the attached pixels without submitting or changing the draft', async () => {
  const opened: PastedImage[] = []
  const file = await imageFile()
  try {
    const f = await fixture({ imagePreview: { open: async image => { opened.push(image) }, dispose: async () => {} } })
    const reading = f.io.readLine('Message')
    let submitted = false; void reading.then(() => { submitted = true })
    await f.input.pasteBracketedText(`"${file.path}"`)
    await f.until(() => f.composer.plainText === '[Image #1]')
    await f.input.typeText(' check this')
    await writeFile(file.path, 'changed original')
    const thumbnail = f.setup.renderer.root.findDescendantById('vivi-pasted-image-0')!
    await f.setup.mockMouse.click(thumbnail.x + 1, thumbnail.y + 1)
    expect(opened).toHaveLength(1)
    expect(opened[0]!.bytes).toEqual(new Uint8Array(pixels))
    expect(f.composer.plainText).toBe('[Image #1] check this')
    expect(submitted).toBe(false)
    f.input.pressEnter(); expect(await reading).toContain(' check this')
  } finally { await file.cleanup() }
})

test('clipboard thumbnails ignore drags, modified clicks, duplicate pending opens and deleted targets', async () => {
  let opens = 0, finish!: () => void
  const f = await fixture({ imagePreview: { open: () => { opens++; return new Promise(resolve => { finish = resolve }) }, dispose: async () => {} },
    clipboard: { read: async () => ({ status: 'read', representation: { mimeType: 'image/png', bytes: pixels } }),
      writeText: async () => { throw new Error('unused') }, dispose: async () => {} } })
  const reading = f.io.readLine('Message')
  f.input.pressKey('v', { ctrl: true }); await f.frame()
  const thumbnail = f.setup.renderer.root.findDescendantById('vivi-pasted-image-0')!
  const x = thumbnail.x + 1, y = thumbnail.y + 1, mouse = f.setup.mockMouse
  await mouse.click(x, y, 2)
  await mouse.click(x, y, 0, { modifiers: { ctrl: true } })
  await mouse.drag(x, y, x + 3, y)
  expect(opens).toBe(0)
  await mouse.click(x, y); await mouse.click(x, y)
  expect(opens).toBe(1)
  finish(); await f.frame()
  await mouse.pressDown(x, y)
  f.input.pressBackspace(); await f.frame()
  await mouse.release(x, y)
  expect(opens).toBe(1)
  f.input.pressEnter(); expect(await reading).toBe('')
})

test('viewer errors leave the composer usable and closing disposes the preview service once', async () => {
  let disposed = 0
  const f = await fixture({ imagePreview: { open: async () => { throw new Error('private native error') }, dispose: async () => { disposed++ } },
    clipboard: { read: async () => ({ status: 'read', representation: { mimeType: 'image/png', bytes: pixels } }),
      writeText: async () => { throw new Error('unused') }, dispose: async () => {} } })
  const reading = f.io.readLine('Message')
  f.input.pressKey('v', { ctrl: true }); await f.frame()
  const thumbnail = f.setup.renderer.root.findDescendantById('vivi-pasted-image-0')!
  await f.setup.mockMouse.click(thumbnail.x + 1, thumbnail.y + 1)
  expect(f.io.failed).toBe(false)
  expect(await f.frame()).not.toContain('private native error')
  expect(f.composer.plainText).toBe('[Image #1]')
  f.input.pressEnter(); expect(await reading).toContain('Image #1')
  f.io.close(); f.io.close(); expect(disposed).toBe(1)
})

for (const quote of ['', "'", '"']) test(`a ${quote || 'unquoted'} pasted image path becomes an atomic attachment with a thumbnail`, async () => {
  const file = await imageFile()
  try {
    const f = await fixture(), reading = f.io.readLine('Message')
    await f.input.pasteBracketedText(`${quote}${file.path}${quote}`)
    await f.until(() => f.composer.plainText === '[Image #1]')
    expect(f.setup.renderer.root.findDescendantById('vivi-pasted-images')!.visible).toBe(true)
    f.input.pressBackspace(); await f.frame()
    expect(f.composer.plainText).toBe('')
    f.input.pressKey('-', { ctrl: true }); await f.frame()
    f.input.pressEnter()
    const content = (await reading)!
    expect(f.io.pastedImages(content)[0]?.bytes).toEqual(new Uint8Array(pixels))
    expect(content).not.toContain(file.path)
  } finally { await file.cleanup() }
})

test('successive image-path and ordinary text pastes retain their order and use the launch workspace for relative paths', async () => {
  const file = await imageFile()
  try {
    const f = await fixture(), reading = f.io.readLine('Message')
    f.io.setWorkspace(file.directory)
    await f.input.pasteBracketedText('"Screenshot with spaces.png"')
    await f.input.pasteBracketedText(`'${file.path}'`)
    await f.input.pasteBracketedText(' tail')
    await f.until(() => f.composer.plainText === '[Image #1][Image #2] tail')
    f.input.pressEnter()
    const content = (await reading)!
    expect(f.io.pastedImages(content)).toHaveLength(2)
    expect(content.endsWith(' tail')).toBe(true)
  } finally { await file.cleanup() }
})

test('Ctrl+V clipboard text containing an image path becomes an image attachment', async () => {
  const file = await imageFile()
  try {
    const f = await fixture({ clipboard: { read: async () => ({ status: 'read', representation: {
      mimeType: 'text/plain', bytes: Buffer.from(`"${file.path}"`) } }),
      writeText: async () => { throw new Error('unused') }, dispose: async () => {} } })
    const reading = f.io.readLine('Message')
    f.input.pressKey('v', { ctrl: true })
    await f.until(() => f.composer.plainText === '[Image #1]')
    f.input.pressEnter(); expect(f.io.pastedImages((await reading)!)).toHaveLength(1)
  } finally { await file.cleanup() }
})

test('unreadable image paths remain literal text and cancelled path reads cannot affect a later prompt', async () => {
  const file = await imageFile()
  try {
    const f = await fixture(), reading = f.io.readLine('Message')
    const missing = `"${join(file.directory, 'missing.png')}"`
    await f.input.pasteBracketedText(missing)
    await f.until(() => f.composer.plainText === missing)
    f.input.pressEnter(); expect(await reading).toBe(missing)
    const cancelled = f.io.readLine('Message')
    f.setup.renderer.stdin.emit('data', Buffer.from(`\x1b[200~"${file.path}"\x1b[201~`))
    f.input.pressEscape(); f.input.pressEnter(); expect(await cancelled).toBe('')
    const next = f.io.readLine('Message')
    await new Promise(resolve => setTimeout(resolve, 10)); await f.frame()
    expect(f.composer.plainText).toBe('')
    f.input.pressEnter(); expect(await next).toBe('')
  } finally { await file.cleanup() }
})

test('large text is visually collapsed and submits its entire Unicode content with surrounding edits', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.input.pasteBracketedText('前🙂 ')
  await f.input.pasteBracketedText(text)
  await f.input.typeText(' tail')
  expect(await f.frame()).toContain(`[Pasted Content ${text.length} chars]`)
  expect(f.composer.plainText).not.toContain('first line')
  f.input.pressEnter()
  expect(await reading).toBe('前🙂 ' + text + ' tail')
})

test('short text stays editable while multiline paste collapses', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.input.pasteBracketedText('short\ntext')
  expect(f.composer.plainText).toBe('short\ntext')
  const lines = Array.from({ length: 10 }, () => 'a').join('\n')
  await f.input.pasteBracketedText(lines)
  expect(f.composer.plainText).toContain('[Pasted Content')
  f.input.pressEnter(); expect(await reading).toBe('short\ntext' + lines)
})

test('backspace removes one complete block and undo restores its full submission value', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.input.typeText('prefix '); await f.input.pasteBracketedText(text)
  f.input.pressBackspace(); await f.frame()
  expect(f.composer.plainText).toBe('prefix ')
  f.input.pressKey('-', { ctrl: true }); await f.frame()
  expect(f.composer.plainText).toContain('[Pasted Content')
  f.input.pressEnter(); expect(await reading).toBe('prefix ' + text)
})

test('repeating the same paste expands the adjacent block once, with native editing and undo', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.input.pasteBracketedText(text)
  await f.input.pasteBracketedText(text)
  expect(f.composer.plainText).toBe(text)
  f.input.pressKey('-', { ctrl: true }); await f.frame()
  expect(f.composer.plainText).toContain('[Pasted Content')
  f.input.pressKey('.', { ctrl: true }); await f.frame()
  expect(f.composer.plainText).toBe(text)
  f.input.pressBackspace(); await f.frame()
  f.input.pressEnter(); expect(await reading).toBe(text.slice(0, -1))
})

test('unrelated text pastes remain separate and collapsed contents count toward the input limit', async () => {
  const f = await fixture(), reading = f.io.readLine('Message'), large = 'x'.repeat(65000)
  await f.input.pasteBracketedText(large)
  await f.input.pasteBracketedText('y'.repeat(1000))
  expect(f.composer.plainText).toBe('[Pasted Content 65000 chars]')
  await f.input.pasteBracketedText(large)
  expect(f.composer.plainText).toBe(large)
  f.input.pressEnter(); expect(await reading).toBe(large)
})

test('oversized pastes are rejected whole without silently submitting a shortened block', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.input.pasteBracketedText('x'.repeat(70000))
  expect(f.composer.plainText).toBe('')
  f.input.pressEnter(); expect(await reading).toBe('')
})

test('selecting across tokens replaces both the label and hidden content', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.input.typeText('prefix '); await f.input.pasteBracketedText(text)
  f.composer.setSelection(0, f.composer.cursorOffset)
  await f.input.pasteBracketedText('replacement')
  f.input.pressEnter(); expect(await reading).toBe('replacement')
})

test('typed lookalike labels remain literal and cleared blocks do not enter the next prompt', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.input.pasteBracketedText(text)
  f.input.pressEscape()
  await f.input.typeText('[Pasted Content 2000 chars]')
  f.input.pressEnter(); expect(await reading).toBe('[Pasted Content 2000 chars]')
  const next = f.io.readLine('Message'); f.input.pressEnter(); expect(await next).toBe('')
})

test('image paste creates a thumbnail, submits bytes separately and supports atomic removal and undo', async () => {
  const f = await fixture({ clipboard: { read: async () => ({ status: 'read', representation: { mimeType: 'image/png', bytes: pixels } }),
    writeText: async () => { throw new Error('unused') }, dispose: async () => {} } })
  const reading = f.io.readLine('Message')
  f.input.pressKey('v', { ctrl: true }); await f.frame()
  expect(f.composer.plainText).toBe('[Image #1]')
  const preview = f.setup.renderer.root.findDescendantById('vivi-pasted-image-0') as ImageRenderable
  await preview.loadPromise
  expect(preview.image?.width).toBe(1)
  expect(f.setup.renderer.root.findDescendantById('vivi-pasted-images')!.visible).toBe(true)
  f.input.pressBackspace(); await f.frame()
  expect(f.composer.plainText).toBe('')
  expect(f.setup.renderer.root.findDescendantById('vivi-pasted-images')!.visible).toBe(false)
  f.input.pressKey('-', { ctrl: true }); await f.frame()
  expect(f.composer.plainText).toBe('[Image #1]')
  f.input.pressEnter()
  const content = (await reading)!
  expect(content).toContain('workspace_read_image')
  expect(f.io.pastedImages(content)[0]?.bytes).toEqual(new Uint8Array(pixels))
  expect(content).not.toContain(pixels.toString('base64'))
})

test('history navigation and mode changes restore collapsed drafts with their cursor and hidden text', async () => {
  const f = await fixture({ promptHistory: ['previous prompt'] }), reading = f.io.readLine('Message')
  await f.input.pasteBracketedText(text)
  f.input.pressArrow('up'); await f.frame()
  expect(f.composer.plainText).toBe('previous prompt')
  f.input.pressArrow('down'); await f.frame()
  expect(f.composer.plainText).toContain('[Pasted Content')
  f.input.pressTab({ shift: true })
  expect(await reading).toBe('/mode cycle')
  const next = f.io.readLine('Message'); await f.frame()
  expect(f.composer.plainText).toContain('[Pasted Content')
  f.input.pressEnter(); expect(await next).toBe(text)
})

test('late credentials in hidden blocks are removed before submission', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  const secretText = text + ' newly-known-secret'
  await f.input.pasteBracketedText(secretText)
  f.io.addSecrets(['newly-known-secret'])
  f.input.pressEnter()
  const submitted = await reading
  expect(submitted).not.toContain('newly-known-secret')
  expect(submitted).toContain('[REDACTED]')
})

test('a cancelled clipboard read cannot paste into a later prompt', async () => {
  let finish!: (value: ClipboardReadResult) => void
  const f = await fixture({ clipboard: { read: () => new Promise(resolve => { finish = resolve }),
    writeText: async () => { throw new Error('unused') }, dispose: async () => {} } })
  const first = f.io.readLine('Message')
  f.input.pressKey('v', { ctrl: true })
  f.input.pressEnter(); await f.frame()
  f.input.pressEscape()
  f.input.pressEnter(); expect(await first).toBe('')
  const next = f.io.readLine('Message')
  finish({ status: 'read', representation: { mimeType: 'image/png', bytes: pixels } })
  await f.frame()
  expect(f.composer.plainText).toBe('')
  f.input.pressEnter(); expect(await next).toBe('')
})

test('image thumbnails stay above the editable row and fit compact terminal resizes', async () => {
  const f = await fixture({ clipboard: { read: async () => ({ status: 'read', representation: { mimeType: 'image/png', bytes: pixels } }),
    writeText: async () => { throw new Error('unused') }, dispose: async () => {} } })
  const reading = f.io.readLine('Message')
  f.input.pressKey('v', { meta: true }); await f.frame()
  await f.input.pasteBracketedText(text)
  for (const [width, height] of [[40, 12], [80, 20], [100, 30]] as const) {
    f.setup.resize(width, height); await f.frame()
    const previews = f.setup.renderer.root.findDescendantById('vivi-pasted-images')!
    const box = f.setup.renderer.root.findDescendantById('vivi-composer-box')!
    expect(previews.y + previews.height).toBeLessThanOrEqual(f.composer.y)
    expect(box.y + box.height).toBeLessThanOrEqual(height)
    expect(f.composer.height).toBeGreaterThan(0)
  }
  f.input.pressEnter(); expect(await reading).toContain(text)
})

test('Delete removes an entire block from its beginning and expanding one block preserves its neighbors', async () => {
  const f = await fixture(), reading = f.io.readLine('Message'), other = 'different'.repeat(150)
  await f.input.pasteBracketedText(text)
  const middle = f.composer.cursorOffset
  await f.input.pasteBracketedText(other)
  f.composer.cursorOffset = middle
  await f.input.pasteBracketedText(text)
  expect(f.composer.plainText).toContain(text)
  f.input.pressKey('\x1b[3~'); await f.frame()
  expect(f.composer.plainText).toBe(text)
  f.input.pressEnter(); expect(await reading).toBe(text)
})
