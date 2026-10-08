// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { getEventListeners } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { spawnSync } from 'node:child_process'
import { createToolRegistry } from '@ayayaq/vivi/extensions'
import { ReadOnlyWorkspace, createWorkspaceExtension, WORKSPACE_LIMITS } from '../dist/workspace.js'
import { createWorkspaceGlobMatcher } from '../dist/workspace-glob.js'

const signal = () => new AbortController().signal
async function fixture(t, secrets = [], privatePaths = []) {
  const root = await fs.mkdtemp(join(tmpdir(), 'vivi-glob-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const workspace = await ReadOnlyWorkspace.open(root, secrets, privatePaths.map(path => join(root, path)))
  const registry = createToolRegistry([createWorkspaceExtension(workspace)])
  return { root, workspace, registry }
}
async function run(registry, arguments_, abort = signal()) {
  const result = await registry.executeTool({ id: 'glob-fixture', name: 'workspace_glob', arguments: arguments_ }, { signal: abort })
  assert(Buffer.byteLength(result.content) <= WORKSPACE_LIMITS.maximumResultBytes)
  return { result, data: JSON.parse(result.content) }
}
const paths = data => data.matches.map(item => item.path).sort()
async function file(root, path, contents = '') {
  const parts = path.split('/')
  if (parts.length > 1) await fs.mkdir(join(root, ...parts.slice(0, -1)), { recursive: true })
  await fs.writeFile(join(root, ...parts), contents)
}

test('glob matches portable anchored paths, ordinary stars and several globstars', async t => {
  const { root, registry } = await fixture(t)
  for (const path of ['root.test.ts', 'Readme.TS', '.hidden.ts', 'src/a.test.ts', 'src/atestb.ts',
    'src/a.ts', 'src/bb.ts', 'src/deep/a.test.ts', 'src/components/view.tsx', 'src/deep/components/nested/view.tsx',
    '.project/config.ts']) await file(root, path)
  const all = (await run(registry, { pattern: '**/*.ts' })).data
  assert.deepEqual(paths(all), ['.hidden.ts', '.project/config.ts', 'root.test.ts', 'src/a.test.ts', 'src/a.ts', 'src/atestb.ts', 'src/bb.ts', 'src/deep/a.test.ts'])
  assert.equal(all.untrusted, true); assert.equal(all.source, 'selected_workspace')
  assert.equal(all.path, '.'); assert.equal(all.pattern, '**/*.ts'); assert.equal(all.depth, 8)
  assert.equal(all.truncated, false); assert.equal(all.scannedBytes, 0)
  assert(all.matches.every(item => item.kind === 'file'))
  assert.deepEqual(paths((await run(registry, { pattern: '*test*.ts' })).data), ['root.test.ts'])
  assert.deepEqual(paths((await run(registry, { pattern: '**/*test*.ts' })).data), ['root.test.ts', 'src/a.test.ts', 'src/atestb.ts', 'src/deep/a.test.ts'])
  assert.deepEqual(paths((await run(registry, { pattern: 'src/**/components/**/*.tsx' })).data), ['src/components/view.tsx', 'src/deep/components/nested/view.tsx'])
  assert.deepEqual(paths((await run(registry, { pattern: 'src/?.ts' })).data), ['src/a.ts'])
  assert.deepEqual(paths((await run(registry, { pattern: 'readme.ts' })).data), [])
  assert.deepEqual(paths((await run(registry, { pattern: 'Readme.TS' })).data), ['Readme.TS'])
  const scoped = (await run(registry, { path: 'src', pattern: '*.ts' })).data
  assert.equal(scoped.path, 'src')
  assert.deepEqual(paths(scoped), ['src/a.test.ts', 'src/a.ts', 'src/atestb.ts', 'src/bb.ts'])
  assert.deepEqual(paths((await run(registry, { path: 'src', pattern: 'src/*.ts' })).data), [])
})

test('glob uses root and nested ignores, fixed exclusions and the active private folder', async t => {
  const { root, registry } = await fixture(t, [], ['local-state'])
  await file(root, '.gitignore', '*.log\n!keep.log\n!.env\n')
  await file(root, 'src/.gitignore', '*.ts\n!keep.ts\n')
  for (const path of ['skip.log', 'keep.log', 'src/skip.ts', 'src/keep.ts', '.env', '.env.example',
    'fixture.key', '.git/config', '.ssh/config', 'node_modules/package/index.js',
    'local-state/transcript.json', 'config.json']) await file(root, path)
  const data = (await run(registry, { pattern: '**/*' })).data
  assert.deepEqual(paths(data), ['.gitignore', 'config.json', 'keep.log', 'src/.gitignore', 'src/keep.ts'])
  assert.equal((await run(registry, { path: 'local-state', pattern: '**/*' })).result.isError, true)
  assert.deepEqual(paths((await run(registry, { pattern: '**/.env*' })).data), [])
  await fs.writeFile(join(root, '.gitignore'), 'x'.repeat(WORKSPACE_LIMITS.maximumIgnoreFileBytes + 1))
  assert.equal((await run(registry, { pattern: '**/*' })).result.isError, true)
})

test('glob never reads file contents and omits symlink and multi-link aliases', async t => {
  const { root, registry } = await fixture(t)
  await file(root, 'ordinary.txt', 'Fixture')
  await file(root, 'binary.bin', Buffer.from([0, 255]))
  await file(root, 'large.bin', Buffer.alloc(WORKSPACE_LIMITS.maximumFileBytes + 1))
  try { await fs.symlink(join(root, 'ordinary.txt'), join(root, 'shortcut.txt')) }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') t.diagnostic('Symlink permission unavailable'); else throw error }
  await fs.link(join(root, 'ordinary.txt'), join(root, 'second-link.txt'))
  t.mock.method(fs, 'readFile', () => { throw new Error('Glob must not read contents') })
  const data = (await run(registry, { pattern: '**/*' })).data
  assert.deepEqual(paths(data), ['binary.bin', 'large.bin']); assert.equal(data.scannedBytes, 0)
})

test('glob validation refuses traversal, Windows aliases and unsupported pattern syntax before I/O', async t => {
  const { registry } = await fixture(t)
  t.mock.method(fs, 'opendir', () => { throw new Error('Invalid patterns must not enumerate') })
  for (const pattern of ['', '.', '..', '../*.ts', '/src/*.ts', 'C:/*.ts', '//server/share/*',
    'src\\*.ts', 'src/../*.ts', 'src//*.ts', 'src/*.ts/', 'CON', 'name.', 'name ', '*.ts\n',
    '!*.ts', '[ab].ts', '*.{js,ts}', '+(a).ts', '(a|b).ts', '"a*".ts', '"*.ts', 'src/a**b.ts', '***', 'x'.repeat(201)]) {
    const { result, data } = await run(registry, { pattern })
    assert.equal(result.isError, true, pattern); assert.equal(data.error.code, 'invalid_arguments', pattern)
  }
  for (const arguments_ of [{}, { pattern: 1 }, { pattern: '*', depth: 9 }, { pattern: '*', maxResults: 101 },
    { pattern: '*', caseSensitive: false }, { pattern: '*', regex: true }, { pattern: '*', path: '../src' }])
    assert.equal((await run(registry, arguments_)).data.error.code, 'invalid_arguments')
})

test('glob keeps result, depth, file and entry limits truthful even without matches', async t => {
  const { root, registry } = await fixture(t)
  await file(root, 'one/two/deep.txt')
  const shallow = (await run(registry, { pattern: '**/*.txt', depth: 1 })).data
  assert.deepEqual(shallow.matches, []); assert.equal(shallow.truncated, true)
  for (let index = 0; index < 3; index++) await file(root, `root-${index}.txt`)
  const limited = (await run(registry, { pattern: '**/*.txt', maxResults: 2 })).data
  assert.equal(limited.matches.length, 2); assert.equal(limited.truncated, true)
  for (let index = 0; index <= WORKSPACE_LIMITS.maximumFiles; index++) await file(root, `files/file-${index}.txt`)
  const files = (await run(registry, { path: 'files', pattern: '*.absent' })).data
  assert.deepEqual(files.matches, []); assert.equal(files.truncated, true)
  assert.equal(files.scannedFiles, WORKSPACE_LIMITS.maximumFiles)
  for (let index = 0; index <= WORKSPACE_LIMITS.maximumEntries; index++) await file(root, `excluded/.env.${index}`)
  const entries = (await run(registry, { path: 'excluded', pattern: '*' })).data
  assert.deepEqual(entries.matches, []); assert.equal(entries.truncated, true)
  assert.equal(entries.scannedEntries, WORKSPACE_LIMITS.maximumEntries); assert.equal(entries.scannedFiles, 0)
})

test('glob withholds known credentials in names and notices a replaced root', async t => {
  const secrets = [], { root, registry } = await fixture(t, secrets)
  await file(root, 'ordinary-late-known-value.txt')
  secrets.push('late-known-value')
  let matchedNames = 0
  t.mock.method(Worker.prototype, 'postMessage', () => { matchedNames++ })
  const withheld = await run(registry, { pattern: '*.txt' })
  assert.equal(withheld.result.isError, true); assert(!withheld.result.content.includes('late-known-value'))
  assert.equal(matchedNames, 0)
  const moved = `${root}-moved`
  t.after(() => fs.rm(moved, { recursive: true, force: true }))
  await fs.rename(root, moved); await fs.mkdir(root)
  const replaced = await run(registry, { pattern: '*.txt' })
  assert.equal(replaced.result.isError, true); assert(!replaced.result.content.includes(root))
})

test('glob cancellation discards partial output and closes directory enumeration', async t => {
  const { root, registry } = await fixture(t)
  await file(root, 'ordinary.txt')
  const controller = new AbortController(), original = fs.opendir
  let closed = false
  t.mock.method(fs, 'opendir', async (...args) => {
    const stream = await original(...args), read = stream.read.bind(stream), close = stream.close.bind(stream)
    stream.read = async () => { const entry = await read(); controller.abort(); return entry }
    stream.close = async () => { closed = true; await close() }
    return stream
  })
  await assert.rejects(run(registry, { pattern: '*' }, controller.signal), { name: 'AbortError' })
  assert.equal(closed, true); assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('matcher deadline and cancellation terminate its one worker and remove abort listeners', async t => {
  const originalTerminate = Worker.prototype.terminate
  let terminated = 0
  // Leave an ordinary match unanswered to exercise the deadline deterministically.
  t.mock.method(Worker.prototype, 'postMessage', () => {})
  t.mock.method(Worker.prototype, 'terminate', function () { terminated++; return originalTerminate.call(this) })
  const deadlineSignal = signal(), deadline = createWorkspaceGlobMatcher('*.txt', deadlineSignal, 30)
  try { await assert.rejects(deadline.matches('ordinary.txt'), /time limit/) }
  finally { await deadline.close() }
  assert.equal(terminated, 1); assert.equal(getEventListeners(deadlineSignal, 'abort').length, 0)
  const controller = new AbortController(), cancelled = createWorkspaceGlobMatcher('*.txt', controller.signal, 1000)
  const pending = cancelled.matches('ordinary.txt'); controller.abort()
  try { await assert.rejects(pending, /cancelled/) }
  finally { await cancelled.close() }
  assert.equal(terminated, 2); assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
})

test('ordinary glob completion closes its worker; pre-cancelled execution starts none', async t => {
  const { root, registry } = await fixture(t)
  await file(root, 'ordinary.txt')
  const originalTerminate = Worker.prototype.terminate
  let terminated = 0
  t.mock.method(Worker.prototype, 'terminate', function () { terminated++; return originalTerminate.call(this) })
  assert.deepEqual(paths((await run(registry, { pattern: '*.txt' })).data), ['ordinary.txt'])
  assert.equal(terminated, 1)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(run(registry, { pattern: '*.txt' }, controller.signal), { name: 'AbortError' })
  assert.equal(terminated, 1)
})

test('globstars include permitted Unicode line separators in names and directory components', async () => {
  for (const separator of ['\u2028', '\u2029']) {
    for (const [pattern, path] of [['**', `a${separator}b.txt`], ['**/*.txt', `a${separator}b/c.txt`]]) {
      const matcher = createWorkspaceGlobMatcher(pattern, signal(), 1000)
      try { assert.equal(await matcher.matches(path), true) }
      finally { await matcher.close() }
    }
  }
})

test('a normal ESM stdin library consumer can use the matcher with inherited module flags', () => {
  const source = `import { createWorkspaceGlobMatcher } from ${JSON.stringify(new URL('../dist/workspace-glob.js', import.meta.url).href)};
    const matcher = createWorkspaceGlobMatcher('**/*.txt', new AbortController().signal, 1000);
    try { console.log(await matcher.matches('src/readme.txt')); } finally { await matcher.close(); }`
  for (const args of [['--input-type=module'], ['--input-type', 'module']]) {
    const result = spawnSync(process.execPath, args, { input: source, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'true')
  }
})
