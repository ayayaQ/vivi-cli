// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FileImagePreviewer, imageViewerCommand } from '../dist/image-preview.js'

const pixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')

test('viewer commands open a literal local file with the platform default application', () => {
  const path = resolve('image with spaces & punctuation.png')
  assert.deepEqual(imageViewerCommand(path, 'win32'), {
    command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', pathToFileURL(path).href] })
  assert.deepEqual(imageViewerCommand(path, 'darwin'), { command: '/usr/bin/open', args: [path] })
  assert.deepEqual(imageViewerCommand(path, 'linux'), { command: 'xdg-open', args: [path] })
})

test('previews open immutable pixels, reuse snapshots, and clean up their temporary files', async t => {
  const opened = []
  const preview = new FileImagePreviewer(async path => {
    opened.push(path)
    assert.deepEqual(await readFile(path), pixels)
    assert.equal(extname(path), '.png')
  })
  t.after(() => preview.dispose())
  const input = { path: 'vivi-paste/image.png', bytes: Buffer.from(pixels) }
  const opening = preview.open(input); input.bytes.fill(0); await opening
  await preview.open({ path: 'different-image.png', bytes: pixels })
  assert.equal(opened.length, 2); assert.equal(opened[0], opened[1])
  const directory = dirname(opened[0])
  await preview.dispose(); await preview.dispose()
  await assert.rejects(stat(directory), { code: 'ENOENT' })
  await assert.rejects(preview.open({ path: 'image.png', bytes: pixels }), /closed/)
})

test('launch failures leave a valid snapshot available for another click', async t => {
  let attempts = 0
  const preview = new FileImagePreviewer(async path => {
    if (++attempts === 1) throw new Error('Viewer unavailable')
    assert.deepEqual(await readFile(path), pixels)
  })
  t.after(() => preview.dispose())
  const image = { path: 'image.png', bytes: pixels }
  await assert.rejects(preview.open(image), /Viewer unavailable/)
  await preview.open(image)
  assert.equal(attempts, 2)
})

test('closing during snapshot creation prevents a late viewer launch', async () => {
  let launches = 0
  const preview = new FileImagePreviewer(async () => { launches++ })
  const opening = preview.open({ path: 'image.png', bytes: pixels })
  await preview.dispose(); await opening
  assert.equal(launches, 0)
})

test('invalid image bytes never reach an external application', async t => {
  let launches = 0
  const preview = new FileImagePreviewer(async () => { launches++ })
  t.after(() => preview.dispose())
  await assert.rejects(preview.open({ path: 'pretend.png', bytes: Buffer.from('not an image') }))
  assert.equal(launches, 0)
})
