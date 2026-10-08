// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { ReadOnlyWorkspace, createWorkspaceExtension, WORKSPACE_TOOL_NAMES } from '../dist/workspace.js'
import { WORKSPACE_MUTATION_TOOL_NAMES, workspaceRevision, WorkspaceCommitError } from '../dist/workspace-edit.js'
import { createBuiltinToolset } from '../dist/tools.js'
const signal = () => new AbortController().signal
async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'vivi-text-edit-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'project'); await fs.mkdir(root)
  return { root, directory, workspace: await ReadOnlyWorkspace.open(root) }
}
async function prepare(workspace, path, before, after, revision, abort = signal()) {
  return workspace.prepareMutation('workspace_edit_text', { path, before, after, expectedRevision: revision }, abort)
}
async function revision(root, path) { return workspaceRevision(await fs.readFile(join(root, path))) }
async function noStages(root) { assert(!(await fs.readdir(root)).some(name => name.startsWith('.vivi-stage-'))) }

test('new mutation names are reserved and the extension needs an explicit host executor', async t => {
  const { workspace } = await fixture(t)
  assert.deepEqual(createWorkspaceExtension(workspace).tools.map(tool => tool.definition.name), WORKSPACE_TOOL_NAMES)
  assert.deepEqual(createWorkspaceExtension(workspace, [], async () => ({ content: '' })).tools.map(tool => tool.definition.name),
    [...WORKSPACE_TOOL_NAMES, ...WORKSPACE_MUTATION_TOOL_NAMES])
  for (const name of WORKSPACE_MUTATION_TOOL_NAMES) assert.throws(() => createBuiltinToolset(false, [{ id: 'fixture', apiVersion: 1,
    tools: [{ definition: { name, description: '', parameters: {} }, validateArguments() {}, execute() {} }] }]), /collision/)
})
test('exclusive creation publishes full UTF-8 bytes, cleans staging, and cannot be replayed', async t => {
  const { workspace, root } = await fixture(t)
  const mutation = await workspace.prepareMutation('workspace_create_text', { path: 'hello.txt', content: '\ufeffHello\r\n' }, signal())
  assert(Object.isFrozen(mutation)); assert.match(mutation.diff, /\\ufeffHello\\r\\n/)
  const result = await workspace.commitMutation(mutation, signal(), () => {})
  assert.equal(await fs.readFile(join(root, 'hello.txt'), 'utf8'), '\ufeffHello\r\n')
  assert.equal(result.revision, await revision(root, 'hello.txt')); await noStages(root)
  await assert.rejects(workspace.commitMutation(mutation, signal(), () => {}), /current host-prepared/)
  await assert.rejects(workspace.prepareMutation('workspace_create_text', { path: 'hello.txt', content: 'overwrite' }, signal()), /existing entry/)
})
test('a file appearing after creation review is preserved', async t => {
  const { workspace, root } = await fixture(t)
  const mutation = await workspace.prepareMutation('workspace_create_text', { path: 'new.txt', content: 'proposal' }, signal())
  await fs.writeFile(join(root, 'new.txt'), 'another writer')
  await assert.rejects(workspace.commitMutation(mutation, signal(), () => {}), /appeared/)
  assert.equal(await fs.readFile(join(root, 'new.txt'), 'utf8'), 'another writer'); await noStages(root)
})
test('unique edit preserves BOM, CRLF, unchanged bytes and original ordinary mode', async t => {
  const { workspace, root } = await fixture(t), before = '\ufeffheading\r\nunique old text\r\nfooter\r\n'
  await fs.writeFile(join(root, 'file.txt'), before, { mode: 0o640 })
  const read = JSON.parse((await workspace.execute('workspace_read', { path: 'file.txt' }, signal())).content)
  assert.equal(read.revision, workspaceRevision(Buffer.from(before))); assert(read.content.startsWith('\ufeff'))
  const mutation = await prepare(workspace, 'file.txt', 'unique old text', 'new text', read.revision)
  const result = await workspace.commitMutation(mutation, signal(), () => {})
  assert.equal(await fs.readFile(join(root, 'file.txt'), 'utf8'), before.replace('unique old text', 'new text'))
  assert.equal(result.revision, await revision(root, 'file.txt'))
  if (process.platform !== 'win32') assert.equal((await fs.stat(join(root, 'file.txt'))).mode & 0o777, 0o640)
  await noStages(root)
})
test('files larger than judge budget support a small precise edit without exposing unchanged bytes in diff', async t => {
  const { workspace, root } = await fixture(t)
  await fs.writeFile(join(root, 'large.txt'), 'unchanged line\n'.repeat(12000) + 'target\n' + 'tail\n'.repeat(1000))
  const mutation = await prepare(workspace, 'large.txt', 'target', 'replacement', await revision(root, 'large.txt'))
  assert(mutation.before.length > 16000); assert(mutation.diff.length < 500)
  await workspace.commitMutation(mutation, signal(), () => {})
  assert.equal(await revision(root, 'large.txt'), mutation.revision); await noStages(root)
})
test('empty, absent, repeated and overlapping targets are refused without mutation', async t => {
  const { workspace, root } = await fixture(t); await fs.writeFile(join(root, 'file.txt'), 'aaaa repeat repeat')
  const hash = await revision(root, 'file.txt')
  for (const before of ['', 'absent', 'repeat', 'aaa']) await assert.rejects(prepare(workspace, 'file.txt', before, 'changed', hash), /nonempty|exactly once/)
  await assert.rejects(prepare(workspace, 'file.txt', 'aaaa', 'aaaa', hash), /different/)
  assert.equal(await fs.readFile(join(root, 'file.txt'), 'utf8'), 'aaaa repeat repeat'); await noStages(root)
})
test('stale hashes fail at preparation and ordinary concurrent changes fail at commit', async t => {
  const { workspace, root } = await fixture(t); await fs.writeFile(join(root, 'file.txt'), 'original target')
  await assert.rejects(prepare(workspace, 'file.txt', 'target', 'after', '0'.repeat(64)), /revision changed/)
  const mutation = await prepare(workspace, 'file.txt', 'target', 'after', await revision(root, 'file.txt'))
  await fs.writeFile(join(root, 'file.txt'), 'a concurrent ordinary edit')
  await assert.rejects(workspace.commitMutation(mutation, signal(), () => {}), /changed while/)
  assert.equal(await fs.readFile(join(root, 'file.txt'), 'utf8'), 'a concurrent ordinary edit'); await noStages(root)
})
test('ignore/private/profile/path and UTF-8 policies apply equally to preparation', async t => {
  const { workspace, root, directory } = await fixture(t)
  await fs.writeFile(join(root, '.gitignore'), 'ignored.txt\n'); await fs.writeFile(join(root, 'binary.txt'), Buffer.from([0xff]))
  for (const path of ['ignored.txt', '.env', '.git/config', '../outside.txt', '/absolute.txt', 'C:/drive.txt', 'missing/file.txt', '.vivi-stage-fixture.tmp']) {
    await assert.rejects(workspace.prepareMutation('workspace_create_text', { path, content: 'ordinary' }, signal()))
  }
  await assert.rejects(prepare(workspace, 'binary.txt', 'target', 'after', await revision(root, 'binary.txt')), /UTF-8/)
  const state = join(root, 'profile'); await fs.mkdir(state)
  const protectedWorkspace = await ReadOnlyWorkspace.open(root, [], [state])
  await assert.rejects(protectedWorkspace.prepareMutation('workspace_create_text', { path: 'profile/file.txt', content: 'ordinary' }, signal()), /excluded/)
  await assert.rejects(workspace.prepareMutation('workspace_create_text', { path: 'nul.txt', content: '\0' }, signal()), /NUL/)
  await assert.rejects(workspace.prepareMutation('workspace_create_text', { path: 'surrogate.txt', content: '\ud800' }, signal()), /UTF-8/)
  assert(!(await fs.readdir(directory)).includes('outside.txt')); await noStages(root)
})
test('oversized complete diff and file bytes fail clearly without truncation', async t => {
  const { workspace, root } = await fixture(t)
  await assert.rejects(workspace.prepareMutation('workspace_create_text', { path: 'large.txt', content: 'x'.repeat(50000) }, signal()), /48 KiB/)
  await assert.rejects(workspace.prepareMutation('workspace_create_text', { path: 'large.txt', content: 'x'.repeat(262145) }, signal()), /bounded/)
  assert.deepEqual(await fs.readdir(root), [])
})
test('ordinary policy changes and newly known credentials during staging fsync stop publication and clean staging', async t => {
  for (const cause of ['ignore', 'secret', 'cancel', 'admission']) {
    const { workspace, root } = await fixture(t), abort = new AbortController()
    const mutation = await workspace.prepareMutation('workspace_create_text', { path: 'new.txt', content: 'ordinary late-known-marker' }, abort.signal)
    const open = fs.open
    t.mock.method(fs, 'open', async (path, ...args) => {
      const handle = await open(path, ...args)
      if (!basename(String(path)).startsWith('.vivi-stage-')) return handle
      const sync = handle.sync.bind(handle)
      handle.sync = async () => {
        await sync()
        if (cause === 'ignore') await fs.writeFile(join(root, '.gitignore'), 'new.txt\n')
        if (cause === 'secret') workspace.addSecrets(['late-known-marker'])
        if (cause === 'cancel') abort.abort()
      }
      return handle
    })
    let checks = 0
    await assert.rejects(workspace.commitMutation(mutation, abort.signal, () => { if (cause === 'admission' && ++checks >= 2) throw new Error('stale enrollment') }))
    await assert.rejects(fs.readFile(join(root, 'new.txt')), { code: 'ENOENT' }); await noStages(root)
    t.mock.restoreAll()
  }
})
test('publication failure cleans staging without deleting or changing the target', async t => {
  const { workspace, root } = await fixture(t), mutation = await workspace.prepareMutation('workspace_create_text', { path: 'new.txt', content: 'new' }, signal())
  t.mock.method(fs, 'link', async () => { throw Object.assign(new Error('filesystem does not support hard links'), { code: 'ENOTSUP' }) })
  await assert.rejects(workspace.commitMutation(mutation, signal(), () => {}), /hard links/)
  await assert.rejects(fs.readFile(join(root, 'new.txt')), { code: 'ENOENT' }); await noStages(root)
})
test('post-publication directory sync failure is a known saved outcome and never removes the committed file', { skip: process.platform !== 'linux' }, async t => {
  const { workspace, root } = await fixture(t), mutation = await workspace.prepareMutation('workspace_create_text', { path: 'new.txt', content: 'complete' }, signal())
  const open = fs.open
  t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await open(path, ...args)
    if (String(path) === root) handle.sync = async () => { throw new Error('simulated directory durability failure') }
    return handle
  })
  await assert.rejects(workspace.commitMutation(mutation, signal(), () => {}), error => error instanceof WorkspaceCommitError && error.result.revision === mutation.revision)
  assert.equal(await fs.readFile(join(root, 'new.txt'), 'utf8'), 'complete'); await noStages(root)
})
