// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, parse } from 'node:path'
import { createToolRegistry } from '@ayayaq/vivi/extensions'
import { ReadOnlyWorkspace, createWorkspaceExtension, WORKSPACE_LIMITS } from '../dist/workspace.js'

const signal = () => new AbortController().signal
const call = (name, arguments_ = {}) => ({ id: 'workspace-fixture', name, arguments: arguments_ })
const run = async (registry, name, arguments_ = {}, abort = signal()) => {
  const result = await registry.executeTool(call(name, arguments_), { signal: abort })
  const data = JSON.parse(result.content)
  assert(Buffer.byteLength(result.content) <= WORKSPACE_LIMITS.maximumResultBytes)
  return { result, data }
}
async function fixture(t, secrets = []) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'vivi-workspace-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const workspace = await ReadOnlyWorkspace.open(directory, secrets)
  return { directory, workspace, registry: createToolRegistry([createWorkspaceExtension(workspace)]) }
}

test('selected workspace exposes only list, text read and literal search', async t => {
  const { directory, registry } = await fixture(t)
  await fs.mkdir(join(directory, 'src'))
  await fs.writeFile(join(directory, 'package.json'), '{"name":"fixture"}\n')
  await fs.writeFile(join(directory, 'src', 'readme.txt'), 'First line\nRead-only fixture\nLast line\n')
  assert.deepEqual(registry.tools.map(tool => tool.name), ['workspace_list', 'workspace_read', 'workspace_search'])
  const list = (await run(registry, 'workspace_list')).data
  assert.equal(list.untrusted, true)
  assert.equal(list.source, 'selected_workspace')
  assert.equal(list.truncated, false)
  assert(list.entries.some(item => item.path === 'src/readme.txt'))
  const read = (await run(registry, 'workspace_read', { path: 'src/readme.txt', startLine: 2, maxLines: 1 })).data
  assert.equal(read.content, 'Read-only fixture')
  assert.equal(read.startLine, 2)
  assert.equal(read.truncated, true)
  const search = (await run(registry, 'workspace_search', { query: 'READ-ONLY', caseSensitive: false })).data
  assert.deepEqual(search.matches, [{ path: 'src/readme.txt', line: 2, snippet: 'Read-only fixture' }])
  assert.deepEqual((await run(registry, 'workspace_search', { query: '.*' })).data.matches, [])
  assert.equal((await run(registry, 'workspace_read', { path: 'package.json' })).data.content, '{"name":"fixture"}\n')
})

test('root and nested gitignore rules apply to every tool without overriding private exclusions', async t => {
  const { directory, registry } = await fixture(t)
  await fs.mkdir(join(directory, 'src'))
  await fs.mkdir(join(directory, 'hidden'))
  await fs.writeFile(join(directory, '.gitignore'), '*.log\n!keep.log\nhidden/\n!.env\n')
  await fs.writeFile(join(directory, 'src', '.gitignore'), '*.txt\n!readme.txt\n')
  for (const [path, contents] of [['debug.log', 'fixture'], ['keep.log', 'fixture'], ['.env', 'fixture'],
    ['src/skip.txt', 'fixture'], ['src/readme.txt', 'fixture'], ['hidden/readme.txt', 'fixture']]) await fs.writeFile(join(directory, path), contents)
  const list = (await run(registry, 'workspace_list', { depth: 4 })).data.entries.map(item => item.path)
  assert(list.includes('keep.log')); assert(list.includes('src/readme.txt'))
  for (const name of ['debug.log', '.env', 'src/skip.txt', 'hidden', 'hidden/readme.txt']) assert(!list.includes(name))
  for (const path of ['debug.log', '.env', 'src/skip.txt', 'hidden/readme.txt']) assert.equal((await run(registry, 'workspace_read', { path })).result.isError, true)
  const search = (await run(registry, 'workspace_search', { query: 'fixture', depth: 4 })).data
  assert.deepEqual(search.matches.map(item => item.path).sort(), ['keep.log', 'src/readme.txt'])
})

test('known private paths are excluded while ordinary project config remains readable', async t => {
  const { directory, registry } = await fixture(t)
  for (const name of ['.ssh', '.aws', '.git', 'node_modules']) {
    await fs.mkdir(join(directory, name)); await fs.writeFile(join(directory, name, 'fixture.txt'), 'Private fixture')
  }
  for (const name of ['.env.example', '.npmrc', 'credentials.json', 'auth.json', 'fixture.pem']) await fs.writeFile(join(directory, name), 'Private fixture')
  await fs.writeFile(join(directory, 'tsconfig.json'), '{}')
  assert.deepEqual((await run(registry, 'workspace_list')).data.entries, [{ path: 'tsconfig.json', kind: 'file' }])
  assert.equal((await run(registry, 'workspace_read', { path: 'tsconfig.json' })).data.content, '{}')
  await assert.rejects(ReadOnlyWorkspace.open(join(directory, '.aws')), /Private credential/)
})

test('fixed exclusions also apply to explicitly selected roots and their descendants', async t => {
  const { directory } = await fixture(t)
  for (const name of ['node_modules', '.cache', 'secrets', 'credentials.json', '.env.local', 'fixture.key']) {
    const root = join(directory, name)
    await fs.mkdir(root); await fs.mkdir(join(root, 'nested'))
    await assert.rejects(ReadOnlyWorkspace.open(root), /cannot be workspaces/)
    await assert.rejects(ReadOnlyWorkspace.open(join(root, 'nested')), /cannot be workspaces/)
  }
})

test('active custom state directories are excluded by canonical path and existing identity', async t => {
  const { directory } = await fixture(t)
  const state = join(directory, 'local-state')
  await fs.mkdir(state); await fs.writeFile(join(state, 'transcript.json'), '{"fixture":true}')
  await fs.writeFile(join(directory, 'readme.txt'), 'Ordinary sibling')
  const workspace = await ReadOnlyWorkspace.open(directory, [], [state])
  const registry = createToolRegistry([createWorkspaceExtension(workspace)])
  assert.deepEqual((await run(registry, 'workspace_list')).data.entries, [{ path: 'readme.txt', kind: 'file' }])
  const refused = await run(registry, 'workspace_read', { path: 'local-state/transcript.json' })
  assert.equal(refused.result.isError, true); assert(!refused.result.content.includes(directory))
  await fs.rename(state, join(directory, 'moved-state'))
  assert.deepEqual((await run(registry, 'workspace_list')).data.entries, [{ path: 'readme.txt', kind: 'file' }])
  await assert.rejects(ReadOnlyWorkspace.open(join(directory, 'moved-state'), [], [join(directory, 'moved-state')]), /outside.*private state/)
})

test('a missing custom state directory is excluded before it is created', async t => {
  const { directory } = await fixture(t)
  const state = join(directory, 'local-state')
  const workspace = await ReadOnlyWorkspace.open(directory, [], [state])
  await fs.mkdir(state); await fs.writeFile(join(state, 'transcript.json'), '{}')
  await fs.writeFile(join(directory, 'readme.txt'), 'Ordinary sibling')
  const registry = createToolRegistry([createWorkspaceExtension(workspace)])
  assert.deepEqual((await run(registry, 'workspace_list')).data.entries, [{ path: 'readme.txt', kind: 'file' }])
  assert.equal((await run(registry, 'workspace_read', { path: 'readme.txt' })).data.content, 'Ordinary sibling')
  assert.equal((await run(registry, 'workspace_read', { path: 'local-state/transcript.json' })).result.isError, true)
  await fs.rename(state, join(directory, 'moved-state'))
  assert.deepEqual((await run(registry, 'workspace_list')).data.entries, [{ path: 'readme.txt', kind: 'file' }])
})

test('relative-path and argument contracts reject ambiguous inputs before reading', async t => {
  const { registry } = await fixture(t)
  for (const path of ['../readme.txt', '/readme.txt', 'C:/readme.txt', '//server/share', 'src\\readme.txt',
    'src/../readme.txt', 'src//readme.txt', 'readme.txt.', 'CON', 'src/readme.txt\n']) {
    const result = await run(registry, 'workspace_read', { path })
    assert.equal(result.result.isError, true)
    assert.equal(result.data.error.code, 'invalid_arguments')
  }
  for (const args of [{ depth: 0 }, { depth: 9 }, { maxResults: 101 }, { recursive: true }])
    assert.equal((await run(registry, 'workspace_list', args)).data.error.code, 'invalid_arguments')
  for (const args of [{ query: '' }, { query: 'first\nsecond' }, { query: 'x', caseSensitive: 1 }, { query: 'x', regex: true }])
    assert.equal((await run(registry, 'workspace_search', args)).data.error.code, 'invalid_arguments')
  await assert.rejects(ReadOnlyWorkspace.open(parse(process.cwd()).root), /project folder/)
})

test('symlink and hardlink fixtures are omitted and cannot be read', async t => {
  const { directory, registry } = await fixture(t)
  const ordinary = join(directory, 'ordinary.txt')
  await fs.writeFile(ordinary, 'Ordinary fixture')
  try { await fs.symlink(ordinary, join(directory, 'shortcut.txt')) }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') t.diagnostic('Symlink permission unavailable'); else throw error }
  await fs.link(ordinary, join(directory, 'second-link.txt'))
  assert.deepEqual((await run(registry, 'workspace_list')).data.entries, [])
  for (const path of ['shortcut.txt', 'second-link.txt', 'ordinary.txt'])
    assert.equal((await run(registry, 'workspace_read', { path })).result.isError, true)
})

test('file bytes, output bytes, UTF-8 and line bounds stay explicit', async t => {
  const { directory, registry } = await fixture(t)
  await fs.writeFile(join(directory, 'large.txt'), 'x'.repeat(WORKSPACE_LIMITS.maximumFileBytes + 1))
  await fs.writeFile(join(directory, 'utf8.txt'), '🙂'.repeat(5000))
  await fs.writeFile(join(directory, 'binary.txt'), Buffer.from([1, 0, 2]))
  await fs.writeFile(join(directory, 'invalid.txt'), Buffer.from([0xff]))
  for (const path of ['large.txt', 'binary.txt', 'invalid.txt']) assert.equal((await run(registry, 'workspace_read', { path })).result.isError, true)
  const result = (await run(registry, 'workspace_read', { path: 'utf8.txt' })).data
  assert.equal(result.truncated, true)
  assert.equal(Buffer.byteLength(result.content), WORKSPACE_LIMITS.maximumReadBytes)
  assert(!result.content.includes('�'))
  assert.equal((await run(registry, 'workspace_read', { path: 'utf8.txt', startLine: 200 })).data.content, '')
  const search = (await run(registry, 'workspace_search', { query: 'x' })).data
  assert.deepEqual(search.matches, [])
})

test('entry, result and depth budgets report incomplete listings', async t => {
  const { directory, registry } = await fixture(t)
  await fs.mkdir(join(directory, 'one')); await fs.mkdir(join(directory, 'one', 'two'))
  await fs.writeFile(join(directory, 'one', 'two', 'readme.txt'), 'fixture')
  assert.equal((await run(registry, 'workspace_list', { depth: 1 })).data.truncated, true)
  await fs.writeFile(join(directory, 'readme.txt'), 'fixture\n'.repeat(60))
  const search = (await run(registry, 'workspace_search', { query: 'fixture', maxResults: 2, depth: 3 })).data
  assert.equal(search.matches.length, 2); assert.equal(search.truncated, true)
  const list = (await run(registry, 'workspace_list', { maxResults: 1, depth: 3 })).data
  assert.equal(list.entries.length, 1); assert.equal(list.truncated, true)
})

test('cancelled calls stop before filesystem reads and do not echo abort reasons', async t => {
  const { registry } = await fixture(t)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(registry.executeTool(call('workspace_list'), { signal: controller.signal }), { name: 'AbortError' })
})

test('cancellation during directory enumeration closes the reader and discards partial output', async t => {
  const { directory, registry } = await fixture(t)
  await fs.writeFile(join(directory, 'readme.txt'), 'Ordinary fixture')
  const original = fs.opendir, controller = new AbortController()
  let closed = false
  t.mock.method(fs, 'opendir', async (...args) => {
    const stream = await original(...args), read = stream.read.bind(stream), close = stream.close.bind(stream)
    stream.read = async () => { const entry = await read(); controller.abort(); return entry }
    stream.close = async () => { closed = true; await close() }
    return stream
  })
  await assert.rejects(registry.executeTool(call('workspace_list'), { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(closed, true)
})

test('search file and aggregate byte budgets stop scans even when there are no matches', async t => {
  const { directory, registry } = await fixture(t)
  for (let index = 0; index < WORKSPACE_LIMITS.maximumFiles + 1; index++) await fs.writeFile(join(directory, `file-${index}.txt`), 'Ordinary fixture')
  const files = (await run(registry, 'workspace_search', { query: 'absent' })).data
  assert.equal(files.truncated, true); assert.equal(files.scannedFiles, WORKSPACE_LIMITS.maximumFiles)
  await fs.mkdir(join(directory, 'large-files'))
  for (let index = 0; index < 9; index++) await fs.writeFile(join(directory, 'large-files', `file-${index}.txt`), 'x'.repeat(WORKSPACE_LIMITS.maximumFileBytes))
  const bytes = (await run(registry, 'workspace_search', { path: 'large-files', query: 'absent' })).data
  assert.equal(bytes.truncated, true); assert.equal(bytes.scannedBytes, WORKSPACE_LIMITS.maximumScanBytes)
})

test('excluded entries still consume the bounded enumeration budget', async t => {
  const { directory, registry } = await fixture(t)
  for (let index = 0; index < WORKSPACE_LIMITS.maximumEntries + 1; index++) await fs.writeFile(join(directory, `.env.fixture-${index}`), '')
  const list = (await run(registry, 'workspace_list')).data
  assert.equal(list.truncated, true); assert.equal(list.scannedEntries, WORKSPACE_LIMITS.maximumEntries)
  assert.deepEqual(list.entries, [])
})

test('fresh reads notice root replacement and ordinary concurrent file changes', async t => {
  const { directory, registry } = await fixture(t)
  const file = join(directory, 'readme.txt')
  await fs.writeFile(file, 'First ordinary fixture')
  const originalOpen = fs.open
  t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args)
    if (basename(String(path)) === 'readme.txt') await fs.writeFile(file, 'Updated ordinary fixture')
    return handle
  })
  const changed = await run(registry, 'workspace_read', { path: 'readme.txt' })
  assert.equal(changed.result.isError, true)
  assert(!changed.result.content.includes('Updated ordinary fixture'))
  t.mock.restoreAll()
  const moved = `${directory}-moved`
  t.after(() => fs.rm(moved, { recursive: true, force: true }))
  await fs.rename(directory, moved); await fs.mkdir(directory)
  assert.equal((await run(registry, 'workspace_list')).result.isError, true)
})

test('ignore rule failures are closed and known credentials are withheld even when registered later', async t => {
  const secrets = [], { directory, registry } = await fixture(t, secrets)
  await fs.writeFile(join(directory, 'readme.txt'), 'Fixture with late-known-value')
  secrets.push('late-known-value')
  const read = await run(registry, 'workspace_read', { path: 'readme.txt' })
  assert.equal(read.result.isError, true); assert(!read.result.content.includes('late-known-value'))
  assert.equal((await run(registry, 'workspace_search', { query: 'Fixture' })).result.isError, true)
  await fs.writeFile(join(directory, '.gitignore'), 'a'.repeat(WORKSPACE_LIMITS.maximumIgnoreFileBytes + 1))
  assert.equal((await run(registry, 'workspace_list')).result.isError, true)
})

test('filenames stay escaped untrusted data and are never executed', async t => {
  const { directory, registry } = await fixture(t)
  const name = "readme with spaces and 'quotes'.txt"
  await fs.writeFile(join(directory, name), 'File text is data')
  const list = await run(registry, 'workspace_list')
  assert.equal(list.data.entries[0].path, name)
  assert.equal(list.data.untrusted, true)
  assert.equal((await run(registry, 'workspace_read', { path: name })).data.content, 'File text is data')
})
