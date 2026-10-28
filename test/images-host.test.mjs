// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { normalizeModelCapabilities } from '@ayayaq/vivi/providers/models'
import { CliHost } from '../dist/host.js'
import { FileImageAssets, imageMetadata } from '../dist/image-assets.js'
import { ReadOnlyWorkspace } from '../dist/workspace.js'
import { FileSessionStore, newSession, validateSession } from '../dist/session.js'
import { replayCliConversationDocument } from '../dist/conversation-records.js'
import { parseModelCatalog } from '../dist/models.js'

const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const call = (path = 'image.png', id = 'image-read') => ({ id, name: 'workspace_read_image', arguments: { path } })
const resultMessages = host => host.session.history.filter(message => message.kind === 'tool_result')
const signal = () => new AbortController().signal
async function setup(t, options = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'vivi-image-host-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'project'); await fs.mkdir(root)
  await fs.writeFile(join(root, 'image.png'), pixels)
  const session = options.session ?? newSession({ provider: 'openai', model: 'gpt-4.1' })
  const store = new FileSessionStore(join(directory, 'state'))
  const images = new FileImageAssets(join(directory, 'state', 'images'), session.id)
  const workspace = await ReadOnlyWorkspace.open(root, [], [store.directory])
  return { root, directory, session, store, images, workspace }
}
function providerFor(images, respond) {
  return { estimateContext(input) { return { inputTokens: Math.ceil(JSON.stringify(input).length / 4), estimated: true } },
    generate: async (input, abort, options) => respond(input, abort, options, images) }
}
function hostFor(f, provider, options = {}) {
  return new CliHost({ ...f, provider, imageCapability: 'supported', approve: async () => false, ...options })
}

test('mentioning an image path remains text and does not read or snapshot a file', async t => {
  const f = await setup(t)
  const host = hostFor(f, providerFor(f.images, async input => {
    assert(input.messages.some(message => message.content === 'Consider image.png later'))
    return { content: 'A path mention is not an image observation.', toolCalls: [] }
  }))
  assert.equal((await host.send('Consider image.png later')).status, 'completed')
  assert.equal(resultMessages(host).length, 0)
  await assert.rejects(fs.stat(f.images.directory), { code: 'ENOENT' })
})

test('explicit workspace read delivers actual pixels on Responses wire and persists only snapshot references', async t => {
  const f = await setup(t), requests = []
  const provider = createOpenAIProvider({ model: 'gpt-4.1', apiKey: 'offline-key', stream: false,
    resolveImage: reference => f.images.resolve(reference), fetch: async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body)
      if (requests.length === 1) return Response.json({ status: 'completed', output: [{ type: 'function_call',
        id: 'item-image', call_id: 'image-read', name: 'workspace_read_image', arguments: '{"path":"image.png"}', status: 'completed' }] })
      const observation = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'image-read')
      assert.equal(observation.output[1].type, 'input_image')
      assert.equal(observation.output[1].image_url, `data:image/png;base64,${pixels.toString('base64')}`)
      return Response.json({ status: 'completed', output: [{ type: 'message', id: 'observed-message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'Observed pixels.', annotations: [] }] }] })
    } })
  const host = hostFor(f, provider)
  const result = await host.send('Inspect image.png')
  assert.equal(result.status, 'completed', JSON.stringify(result.error)); assert.equal(requests.length, 2)
  const [observed] = resultMessages(host)
  assert.equal(observed.images.length, 1); assert.equal(observed.images[0].width, 1)
  assert.equal(host.session.schemaVersion, 3)
  assert(!JSON.stringify(host.session).includes(pixels.toString('base64')))
  const saved = await f.store.load(host.session.id)
  assert.deepEqual(resultMessages({ session: saved })[0].images, observed.images)
  const records = JSON.parse(await fs.readFile(join(f.store.directory, `${host.session.id}.records.json`), 'utf8'))
  const replay = replayCliConversationDocument(records)
  assert(replay.projection.history.some(entry => entry.message.images?.length))
})

test('resume uses immutable pixels after the original file changes or disappears', async t => {
  const f = await setup(t); let round = 0
  const host = hostFor(f, providerFor(f.images, async () => ++round === 1
    ? { content: '', toolCalls: [call()] } : { content: 'Observed.', toolCalls: [] }))
  assert.equal((await host.send('Inspect image.png')).status, 'completed')
  const [observed] = resultMessages(host)
  await fs.writeFile(join(f.root, 'image.png'), 'not the original image')
  await fs.unlink(join(f.root, 'image.png'))
  const images = new FileImageAssets(join(f.directory, 'state', 'images'), f.session.id)
  const resumed = hostFor({ ...f, images, session: await f.store.load(f.session.id) }, providerFor(images, async input => {
    const reference = input.messages.find(message => message.images)?.images[0]
    assert.deepEqual(Buffer.from(images.resolve(reference)), pixels)
    return { content: 'The same saved pixels remain available.', toolCalls: [] }
  }))
  assert.equal((await resumed.send('Review that same observation')).status, 'completed')
  assert.deepEqual(resultMessages(resumed)[0].images, observed.images)
})

test('unknown model support and ignored/outside workspace paths do not produce image references', async t => {
  for (const [capability, path] of [['unknown', 'image.png'], ['supported', 'ignored.png'], ['supported', '../image.png']]) {
    const f = await setup(t)
    await fs.writeFile(join(f.root, '.gitignore'), 'ignored.png\n')
    await fs.writeFile(join(f.root, 'ignored.png'), pixels)
    let round = 0
    const host = hostFor(f, providerFor(f.images, async () => ++round === 1
      ? { content: '', toolCalls: [call(path)] } : { content: 'No pixels were supplied.', toolCalls: [] }), { imageCapability: capability })
    assert.equal((await host.send('Inspect the requested local image')).status, 'completed')
    const [observed] = resultMessages(host)
    assert.equal(observed.isError, true); assert.equal(observed.images, undefined)
    await assert.rejects(fs.stat(f.images.directory), { code: 'ENOENT' })
  }
})

test('snapshot metadata verifies PNG and JPEG and resolver does not expose mutable cached bytes', async t => {
  const f = await setup(t)
  const jpeg = await fs.readFile(new URL('./fixtures/tool-image-1x1.jpg', import.meta.url))
  assert.deepEqual(imageMetadata(jpeg), { mimeType: 'image/jpeg', width: 1, height: 1, byteLength: jpeg.length })
  assert.equal(imageMetadata(pixels).mimeType, 'image/png')
  assert.throws(() => imageMetadata(Buffer.from('ordinary text')), /PNG and JPEG/)
  const reference = await f.images.snapshot(pixels, signal())
  const copy = f.images.resolve(reference); copy.fill(0)
  assert.deepEqual(Buffer.from(f.images.resolve(reference)), pixels)
  f.images.accepted([reference]); await f.images.finish()
  const disk = new FileImageAssets(join(f.directory, 'state', 'images'), f.session.id)
  await disk.preload([{ kind: 'tool_result', images: [reference] }], signal())
  assert.deepEqual(Buffer.from(disk.resolve(reference)), pixels)
})

test('cancelled/unaccepted snapshots are cleaned while accepted snapshots remain for replay', async t => {
  const f = await setup(t), abort = new AbortController(); abort.abort()
  await assert.rejects(f.images.snapshot(pixels, abort.signal), { name: 'AbortError' })
  const reference = await f.images.snapshot(pixels, signal())
  await f.images.finish()
  assert.deepEqual(await fs.readdir(f.images.directory), [])
  const accepted = await f.images.snapshot(pixels, signal())
  f.images.accepted([accepted]); await f.images.finish()
  assert.equal((await fs.readdir(f.images.directory)).length, 1)
  assert.equal(accepted.id, reference.id)
})

test('a resumed store recovers its own interrupted staging files without deleting accepted snapshots', async t => {
  const f = await setup(t)
  const reference = await f.images.snapshot(pixels, signal())
  f.images.accepted([reference]); await f.images.finish()
  await fs.writeFile(join(f.images.directory, 'efc9a2f4-585a-41a0-9f2c-c1d0f09ed489.tmp'), pixels, { mode: 0o600 })
  const resumed = new FileImageAssets(join(f.directory, 'state', 'images'), f.session.id)
  await resumed.preload([{ kind: 'tool_result', images: [reference] }], signal())
  assert.deepEqual(Buffer.from(resumed.resolve(reference)), pixels)
  assert.deepEqual(await fs.readdir(resumed.directory), [`${reference.sha256}.image`])
})

test('missing recent image snapshots block dispatch with an actionable path-free error', async t => {
  const f = await setup(t)
  const sha256 = createHash('sha256').update(pixels).digest('hex')
  const image = { id: `sha256:${sha256}`, sha256, mimeType: 'image/png', width: 1, height: 1, byteLength: pixels.length }
  const history = [{ kind: 'message', role: 'user', content: 'Inspect' }, { kind: 'assistant', content: '', toolCalls: [call()] },
    { kind: 'tool_result', callId: 'image-read', name: 'workspace_read_image', content: 'Observed', images: [image] },
    { kind: 'assistant', content: 'Done', toolCalls: [] }]
  let sent = 0
  const host = hostFor({ ...f, session: validateSession({ ...f.session, schemaVersion: 3, history }) }, providerFor(f.images, async () => {
    sent++; return { content: 'Should not send', toolCalls: [] }
  }))
  const result = await host.send('Inspect the same image again')
  assert.equal(result.status, 'error'); assert.equal(sent, 0)
  assert.match(result.error.message, /Restore the private session image files or start a new session/)
  assert(!result.error.message.includes(f.directory)); assert(!result.error.message.includes('ENOENT'))
})

test('known credentials in image bytes are withheld before snapshots or canonical image results', async t => {
  const f = await setup(t); let round = 0
  const host = hostFor(f, providerFor(f.images, async () => ++round === 1 ? { content: '', toolCalls: [call()] }
    : { content: 'No image bytes were supplied.', toolCalls: [] }), { secrets: ['IHDR'] })
  assert.equal((await host.send('Inspect image.png')).status, 'completed')
  const [observed] = resultMessages(host)
  assert.equal(observed.isError, true); assert.equal(observed.images, undefined)
  assert(!observed.content.includes('IHDR'))
  await assert.rejects(fs.stat(f.images.directory), { code: 'ENOENT' })
})

test('credentials registered during snapshot preload are checked again before provider admission', async t => {
  const f = await setup(t), secrets = []; let sent = 0
  const images = { snapshot: f.images.snapshot.bind(f.images), resolve: f.images.resolve.bind(f.images),
    accepted: f.images.accepted.bind(f.images), finish: f.images.finish.bind(f.images),
    async preload(history, abort) { await f.images.preload(history, abort); secrets.push('late-key-fixture') } }
  const host = hostFor({ ...f, images }, providerFor(images, async () => { sent++; return { content: 'Should not send', toolCalls: [] } }), { secrets })
  const result = await host.send('Consider late-key-fixture in an ordinary draft')
  assert.equal(result.status, 'error'); assert.equal(sent, 0)
  assert.match(result.error.message, /newly known credential/)
})

test('schema3 image sessions acquire disk record anchors without downgrade and legacy schemas reject image fields', async t => {
  const f = await setup(t)
  const image = await f.images.snapshot(pixels, signal()); f.images.accepted([image]); await f.images.finish()
  const history = [{ kind: 'message', role: 'user', content: 'Inspect' }, { kind: 'assistant', content: '', toolCalls: [call()] },
    { kind: 'tool_result', callId: 'image-read', name: 'workspace_read_image', content: 'Observed', images: [image] },
    { kind: 'assistant', content: 'Done', toolCalls: [] }]
  const session = validateSession({ ...f.session, schemaVersion: 3, history })
  for (const schemaVersion of [1, 2]) assert.throws(() => validateSession({ ...session, schemaVersion }), /Invalid session/)
  const host = hostFor({ ...f, session }, providerFor(f.images, async () => ({ content: 'Done', toolCalls: [] })))
  await host.initialize()
  assert.equal(host.session.schemaVersion, 3); assert(host.session.recordAnchor)
  assert.deepEqual(resultMessages(host)[0].images, [image])
})

test('model catalog image support retains an exact provider/protocol binding', () => {
  for (const provider of ['openrouter', 'deepseek']) {
    const raw = provider === 'openrouter' ? { id: 'owned/vision', supported_parameters: ['tools'],
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }
      : { id: 'deepseek-flash', input_modalities: ['text', 'image'], output_modalities: ['text'] }
    const [model] = parseModelCatalog(provider, { data: [raw] })
    assert.equal(model.vision, 'supported')
    assert.deepEqual(model.modelCapabilities, normalizeModelCapabilities({ apiVersion: 1, provider, protocol: 'chat-completions', model: raw }))
  }
})

test('compaction can summarize old image references without requiring unavailable historical pixels', async t => {
  const f = await setup(t)
  const sha256 = createHash('sha256').update(pixels).digest('hex')
  const image = { id: `sha256:${sha256}`, sha256, mimeType: 'image/png', width: 1, height: 1, byteLength: pixels.length }
  const history = [{ kind: 'message', role: 'user', content: 'Old observation' }, { kind: 'assistant', content: '', toolCalls: [call()] },
    { kind: 'tool_result', callId: 'image-read', name: 'workspace_read_image', content: 'Observed', images: [image] },
    { kind: 'assistant', content: 'Historical observation.', toolCalls: [] }]
  for (let index = 0; index < 8; index++) history.push({ kind: 'message', role: 'user', content: `Later discussion ${index}` },
    { kind: 'assistant', content: 'Ordinary later reply. '.repeat(200), toolCalls: [] })
  let summaries = 0
  const session = validateSession({ ...f.session, schemaVersion: 3, history })
  const host = hostFor({ ...f, session }, providerFor(f.images, async (_input, _signal, options) => {
    assert.equal(options.purpose, 'context-summary'); summaries++
    return { content: 'Older history and image observation summarized.', toolCalls: [] }
  }))
  await host.compact()
  assert.equal(summaries, 1)
  assert(host.session.contextCheckpoint.summary.includes(image.id))
  await assert.rejects(fs.stat(f.images.directory), { code: 'ENOENT' })
})
