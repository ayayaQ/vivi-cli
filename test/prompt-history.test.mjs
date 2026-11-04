// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_PROMPT_HISTORY, PromptHistory, PromptHistoryStore } from '../dist/prompt-history.js'

test('history retains 100 prompts, skips blanks and consecutive duplicates, and stops at each end', () => {
  const history = new PromptHistory()
  for (let i = 0; i < 105; i++) history.add(`prompt ${i}`)
  history.add('prompt 104'); history.add(' \n ')
  const draft = { text: 'unfinished', cursor: 3 }
  let current = draft
  for (let i = 104; i >= 5; i--) {
    current = history.move(-1, current)
    assert.equal(current.text, `prompt ${i}`)
  }
  assert.equal(history.move(-1, current), undefined)
  for (let i = 0; i < MAX_PROMPT_HISTORY; i++) current = history.move(1, current)
  assert.deepEqual(current, draft)
  assert.equal(history.move(1, current), undefined)
})

test('browsing preserves edits and cursor without changing saved entries', () => {
  const history = new PromptHistory(['old', 'new'])
  history.move(-1, { text: 'draft', cursor: 2 })
  history.move(-1, { text: 'edited new', cursor: 4 })
  assert.deepEqual(history.move(1, { text: 'old', cursor: 3 }), { text: 'edited new', cursor: 4 })
  history.reset()
  assert.equal(history.move(-1, { text: '', cursor: 0 }).text, 'new')
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vivi-prompt-history-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'profile')
  return { root, directory, path: join(directory, 'prompt-history.json'), store: new PromptHistoryStore(directory) }
}

test('history persists across harness instances and trims to the newest 100 complete prompts', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.store.load(), [])
  await f.store.append('first\nmultiline 🙂中文')
  assert.deepEqual(await new PromptHistoryStore(f.directory).load(), ['first\nmultiline 🙂中文'])
  await writeFile(f.path, JSON.stringify(Array.from({ length: 100 }, (_, i) => `prompt ${i}`)), { mode: 0o600 })
  await f.store.append('newest')
  await f.store.append('newest')
  await f.store.append('\n ')
  const saved = await f.store.load()
  assert.equal(saved.length, 100)
  assert.equal(saved[0], 'prompt 1')
  assert.equal(saved.at(-1), 'newest')
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.path)).mode & 0o777, 0o600)
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700)
  }
})

test('simultaneous harness writers merge prompts without overwriting each other', async t => {
  const f = await fixture(t)
  const other = new PromptHistoryStore(f.directory)
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? f.store : other).append(`prompt ${i}`)))
  const saved = await f.store.load()
  assert.equal(saved.length, 12)
  assert.equal(new Set(saved).size, 12)
  await Promise.all([f.store.drain(), other.drain()])
})

test('invalid history is rejected and never overwritten; subsequent valid writes recover', async t => {
  const f = await fixture(t)
  await mkdir(f.directory, { mode: 0o700 })
  for (const encoded of ['not json', '[42]', JSON.stringify(['x'.repeat(65537)]), JSON.stringify(Array(101).fill('x'))]) {
    await writeFile(f.path, encoded, { mode: 0o600 })
    await assert.rejects(f.store.load())
    await assert.rejects(f.store.append('new prompt'))
    assert.equal(await readFile(f.path, 'utf8'), encoded)
  }
  await writeFile(f.path, '[]', { mode: 0o600 })
  await f.store.append('recovered')
  assert.deepEqual(await f.store.load(), ['recovered'])
})

test('history refuses symlinked files and directories', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await mkdir(f.directory, { mode: 0o700 })
  const external = join(f.root, 'external.json')
  await writeFile(external, '[]', { mode: 0o600 })
  await symlink(external, f.path)
  await assert.rejects(f.store.load())
  await assert.rejects(f.store.append('must not overwrite'))
  assert.equal(await readFile(external, 'utf8'), '[]')
  const linked = join(f.root, 'linked-profile')
  await symlink(f.directory, linked)
  await assert.rejects(new PromptHistoryStore(linked).load())
})
