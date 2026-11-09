// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pastedImagePath, readPastedImagePath } from '../dist/pasted-image-path.js'
import { IMAGE_LIMITS } from '../dist/image-assets.js'

test('pasted image paths preserve spaces and Windows separators with either quote style', () => {
  const path = String.raw`C:\Users\joshm\Pictures\Screenshots\Screenshot 2026-11-09 012911.png`
  for (const value of [path, `'${path}'`, `"${path}"`, `  "${path}"\r\n`]) assert.equal(pastedImagePath(value), path)
  for (const path of ['image.PNG', './my picture.jpeg', '../photo.jpg', '/tmp/image.png', String.raw`\\server\share\image.png`, "C:\\Josh's pictures\\photo.png"]) {
    assert.equal(pastedImagePath(path), path)
    assert.equal(pastedImagePath(`"${path}"`), path)
  }
  for (const value of ['text', 'a.txt', '"image.png', "'image.png", 'https://example.com/image.png', 'file:///tmp/image.png', 'one.png\ntwo.png', 'bad\x00.png', '"one.png" "two.png"']) {
    assert.equal(pastedImagePath(value), undefined, value)
  }
})

test('pasted files are read relative to the workspace, bounded, and verified by actual encoding', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-pasted-path-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pixels = await readFile(new URL('./fixtures/tool-image-1x1.jpg', import.meta.url))
  const path = join(directory, 'picture with spaces.jpg'), signal = new AbortController().signal
  await writeFile(path, pixels)
  assert.deepEqual(Buffer.from(await readPastedImagePath(path, directory, signal)), pixels)
  assert.deepEqual(Buffer.from(await readPastedImagePath('picture with spaces.jpg', directory, signal)), pixels)
  await writeFile(join(directory, 'fake.png'), 'not image bytes')
  await assert.rejects(readPastedImagePath('fake.png', directory, signal))
  await assert.rejects(readPastedImagePath('missing.png', directory, signal))
  await mkdir(join(directory, 'folder.png'))
  await assert.rejects(readPastedImagePath('folder.png', directory, signal))
  await writeFile(join(directory, 'large.png'), Buffer.alloc(IMAGE_LIMITS.bytes + 1))
  await assert.rejects(readPastedImagePath('large.png', directory, signal))
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(readPastedImagePath(path, directory, cancelled.signal), { name: 'AbortError' })
})
