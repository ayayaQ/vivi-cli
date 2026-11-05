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

async function blockedWriter(t, directory) {
  // Pause the real save after it acquires the lease, before reading history.
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { PromptHistoryStore } from ${JSON.stringify(new URL('../dist/prompt-history.js', import.meta.url).href)};
    const store = new PromptHistoryStore(${JSON.stringify(directory)});
    store.load = async () => {
      process.stdout.write('locked\\n');
      await new Promise(() => setInterval(() => {}, 1000));
    };
    await store.append('interrupted');
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited })
  await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error(`Writer did not acquire lease: ${stderr}`)), 15000)
    child.stdout.on('data', chunk => {
      output += chunk
      if (output.includes('locked\n')) { clearTimeout(timer); resolve() }
    })
    exited.then(() => { clearTimeout(timer); reject(new Error(`Writer exited before acquiring lease: ${stderr}`)) }, reject)
  })
  return { child, exited }
}

test('a live history writer keeps its lease; killing it permits waiting writers to recover', async t => {
  const f = await fixture(t)
  await f.store.append('before crash')
  const { child, exited } = await blockedWriter(t, f.directory)
  const lease = join(f.directory, 'prompt-history-lease.sqlite')
  const before = await stat(lease)
  const { utimes } = await import('node:fs/promises')
  await utimes(lease, new Date(0), new Date(0))
  let finished = false
  const pending = Promise.all(Array.from({ length: 6 }, (_, i) =>
    new PromptHistoryStore(f.directory).append(`after crash ${i}`)))
  pending.then(() => { finished = true }, () => { finished = true })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(finished, false, 'a live writer must not be evicted, even with an old lock mtime')
  assert.deepEqual(await f.store.load(), ['before crash'])
  child.kill('SIGKILL')
  await exited
  await pending
  const saved = await f.store.load()
  assert.equal(saved.length, 7)
  assert.equal(saved[0], 'before crash')
  assert.equal(new Set(saved).size, 7)
  const after = await stat(lease)
  assert.equal(after.ino, before.ino, 'recovery must not unlink and recreate the lock inode')
})

test('history rejects unsafe lease files and SQLite sidecars', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  await mkdir(f.directory, { mode: 0o700 })
  const external = join(f.root, 'external-lease')
  await writeFile(external, '', { mode: 0o600 })
  const lease = join(f.directory, 'prompt-history-lease.sqlite')
  for (const candidate of [lease, lease + '-journal', lease + '-wal', lease + '-shm']) {
    await symlink(external, candidate)
    await assert.rejects(f.store.append('must not write'))
    assert.equal(await readFile(external, 'utf8'), '')
    await rm(candidate)
  }
  const { link, chmod } = await import('node:fs/promises')
  await rm(lease, { force: true })
  await link(external, lease)
  await assert.rejects(f.store.append('must not write'))
  await rm(lease)
  await writeFile(lease, '', { mode: 0o600 })
  await chmod(lease, 0o644)
  await assert.rejects(f.store.append('must not write'))
})

test('replacing the lease inode during a save aborts without removing the replacement', async t => {
  const f = await fixture(t)
  await f.store.append('original')
  const lease = join(f.directory, 'prompt-history-lease.sqlite')
  const originalLoad = f.store.load.bind(f.store)
  f.store.load = async () => {
    const entries = await originalLoad()
    // Windows prevents replacing a file held open by SQLite.
    const { rename } = await import('node:fs/promises')
    try { await rename(lease, lease + '.old') }
    catch (error) { if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw new Error('replacement refused'); throw error }
    await writeFile(lease, 'replacement', { mode: 0o600 })
    return entries
  }
  await assert.rejects(f.store.append('must not write'))
  assert.deepEqual(await originalLoad(), ['original'])
  if (process.platform !== 'win32') assert.equal(await readFile(lease, 'utf8'), 'replacement')
})

test('history times out rather than taking a live writer lease, then recovers', async t => {
  const f = await fixture(t)
  const { child, exited } = await blockedWriter(t, f.directory)
  await assert.rejects(f.store.append('blocked'), error => {
    assert.match(error.message, /Prompt history (?:writer lease|journal setup) remained busy/)
    assert(error.cause, 'retain the native SQLite failure for diagnostics')
    return true
  })
  child.kill('SIGKILL')
  await exited
  await f.store.append('recovered')
  assert.deepEqual(await f.store.load(), ['recovered'])
})

test('history writer lease does not require upgrading past another connection shared lock', async t => {
  const f = await fixture(t)
  await f.store.append('initial')
  const lease = join(f.directory, 'prompt-history-lease.sqlite')
  const { Database } = 'Bun' in globalThis ? await import('bun:sqlite') : { Database: (await import('node:sqlite')).DatabaseSync }
  const reader = new Database(lease)
  reader.exec('BEGIN; SELECT * FROM sqlite_schema')
  try {
    await Promise.all(Array.from({ length: 6 }, (_, i) => new PromptHistoryStore(f.directory).append(`writer ${i}`)))
    const saved = await f.store.load()
    assert.equal(saved.length, 7)
    assert.equal(new Set(saved).size, 7)
  } finally {
    reader.exec('ROLLBACK')
    reader.close()
  }
})
