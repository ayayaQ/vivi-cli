// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { ImageRenderable, TextareaRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import type { AgentResult, HistoryMessage, ToolImageReference } from '@ayayaq/vivi'
import { OpenTuiIO } from '../src/tui.js'
import { newSession } from '../src/session.js'
import { imageMetadata } from '../src/image-assets.js'
import type { PastedImage } from '../src/image-assets.js'

const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const sha256 = createHash('sha256').update(pixels).digest('hex')
const reference: ToolImageReference = { id: `sha256:${sha256}`, sha256, ...imageMetadata(pixels) }
const call = { id: 'image-read', name: 'workspace_read_image', arguments: { path: 'picture.png' } }
const result = { kind: 'tool_result' as const, callId: call.id, name: call.name, content: '{"success":true}', images: [reference] }
const history: HistoryMessage[] = [{ kind: 'message', role: 'user', content: 'Inspect picture.png' },
  { kind: 'assistant', content: '', toolCalls: [call] }, result, { kind: 'assistant', content: 'Observed.', toolCalls: [] }]
const active: OpenTuiIO[] = []
afterEach(() => { for (const io of active.splice(0)) io.close() })
async function fixture() {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const opened: PastedImage[] = []
  const io = new OpenTuiIO(setup.renderer, { imagePreview: { open: async image => { opened.push(image) }, dispose: async () => {} } })
  active.push(io)
  const session = newSession({ provider: 'openai', model: 'fixture' })
  let reads = 0
  io.setImageSource({ sessionId: session.id, read: async () => { reads++; return Uint8Array.from(pixels) } })
  io.setSession(session)
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const images = () => {
    const found: ImageRenderable[] = []
    const visit = (node: Renderable) => { if (node instanceof ImageRenderable && node.id.startsWith('vivi-tool-image-')) found.push(node); for (const child of node.getChildren()) visit(child) }
    visit(setup.renderer.root); return found
  }
  const loaded = async () => {
    await frame(); await Promise.resolve(); await frame()
    for (const image of images()) await image.loadPromise
    await frame()
  }
  const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
  return { io, setup, session, opened, frame, images, loaded, composer, reads: () => reads }
}

test('completed image reads show a clickable thumbnail while the tool card is collapsed and keep the draft', async () => {
  const f = await fixture(), reading = f.io.readLine('Message')
  await f.setup.mockInput.typeText('Unsent draft')
  f.io.event({ type: 'assistant', message: { kind: 'assistant', content: '', toolCalls: [call] } })
  f.io.event({ type: 'tool_completed', message: result })
  await f.loaded()
  const image = f.images()[0]!
  expect(image.image?.width).toBe(1)
  expect(await f.frame()).toContain('1 x 1 - open')
  await f.setup.mockMouse.click(image.x + 1, image.y + 1)
  expect(f.opened).toHaveLength(1)
  expect(f.opened[0]!.bytes).toEqual(new Uint8Array(pixels))
  expect(f.composer.plainText).toBe('Unsent draft')
  f.setup.mockInput.pressEnter(); expect(await reading).toBe('Unsent draft')
  const final: AgentResult = { status: 'completed', history, content: 'Observed.', rounds: 1,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
  f.io.result(final); await f.loaded()
  expect(f.images()[0]?.image?.width).toBe(1)
  expect(f.reads()).toBe(1)
})

test('saved image results render on resume, remain clickable after expand/collapse and reflow at compact sizes', async () => {
  const f = await fixture()
  f.io.setSession({ ...f.session, schemaVersion: 3, history })
  await f.loaded()
  expect(f.images()).toHaveLength(1)
  const image = f.images()[0]!
  await f.setup.mockMouse.click(image.x + 1, image.y + 1)
  expect(f.opened).toHaveLength(1)
  // The tool's preceding row is its expand/collapse control.
  await f.setup.mockMouse.click(image.x + 1, image.y - 1)
  await f.loaded()
  expect(f.images()[0]?.image?.width).toBe(1)
  f.setup.resize(40, 12); await f.loaded()
  expect(f.images()[0]!.width).toBeLessThanOrEqual(36)
  expect(f.reads()).toBe(1)
})

test('failed reads and result-body lookalikes never create image thumbnails', async () => {
  const f = await fixture()
  const failed = structuredClone(history)
  failed[2] = { ...result, isError: true }
  f.io.setSession({ ...f.session, history: failed }); await f.frame()
  expect(f.images()).toHaveLength(0)
  const fake = structuredClone(history)
  fake[2] = { kind: 'tool_result', callId: call.id, name: call.name, content: JSON.stringify({ images: [reference], path: 'picture.png' }) }
  f.io.setSession({ ...f.session, history: fake }); await f.frame()
  expect(f.images()).toHaveLength(0)
  expect(f.reads()).toBe(0)
})

test('missing snapshots show a quiet unavailable label without breaking the composer', async () => {
  const f = await fixture()
  f.io.setImageSource({ sessionId: f.session.id, read: async () => { throw new Error('private snapshot path') } })
  f.io.setSession({ ...f.session, schemaVersion: 3, history })
  await f.loaded()
  expect(await f.frame()).toContain('Unavailable')
  expect(await f.frame()).not.toContain('private snapshot path')
  expect(f.images()[0]?.image).toBeNull()
  const reading = f.io.readLine('Message')
  await f.setup.mockInput.typeText('still editable'); f.setup.mockInput.pressEnter()
  expect(await reading).toBe('still editable')
})

test('late image loads cannot render or open in a replacement session', async () => {
  const f = await fixture()
  let finish!: (bytes: Uint8Array) => void
  f.io.setImageSource({ sessionId: f.session.id, read: () => new Promise(resolve => { finish = resolve }) })
  f.io.setSession({ ...f.session, schemaVersion: 3, history }); await f.frame()
  const old = f.images()[0]!
  f.io.setSession(newSession({ provider: 'openai', model: 'other' }))
  finish(pixels); await f.loaded()
  expect(old.isDestroyed).toBe(true)
  expect(f.images()).toHaveLength(0)
  expect(f.opened).toHaveLength(0)
})

test('newly registered credentials withhold already cached image pixels', async () => {
  const f = await fixture()
  f.io.setSession({ ...f.session, schemaVersion: 3, history }); await f.loaded()
  expect(f.images()[0]?.image?.width).toBe(1)
  f.io.addSecrets(['IHDR'])
  await f.loaded()
  expect(f.images()[0]?.image).toBeNull()
  expect(await f.frame()).toContain('Unavailable')
  const image = f.images()[0]!
  await f.setup.mockMouse.click(image.x + 1, image.y + 1)
  expect(f.opened).toHaveLength(0)
})
