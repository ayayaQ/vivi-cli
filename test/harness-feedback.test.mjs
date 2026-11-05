// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliHost } from '../dist/host.js'
import { newSession, SessionCommitError } from '../dist/session.js'
import { ReadOnlyWorkspace } from '../dist/workspace.js'
import { workspaceRevision, WorkspaceCommitError } from '../dist/workspace-edit.js'

async function directory(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'vivi-harness-feedback-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  return root
}

test('workspace read failures identify the cause without exposing filesystem details', async t => {
  const root = await directory(t), workspace = await ReadOnlyWorkspace.open(root)
  await fs.mkdir(join(root, 'folder'))
  await fs.writeFile(join(root, 'invalid.txt'), Buffer.from([255]))
  await fs.writeFile(join(root, 'binary-nul.txt'), Buffer.from([0]))
  await fs.writeFile(join(root, 'large.txt'), 'x'.repeat(262145))
  const canonicalRoot = await fs.realpath(root)
  const lstat = fs.lstat
  const injected = []
  t.mock.method(fs, 'lstat', async (path, ...args) => {
    // Linux reads through a pinned /proc/self/fd parent, not the original root.
    // Resolve only the parent so nonexistent fault targets still match.
    const name = basename(String(path))
    const target = ['denied.txt', 'unknown.txt'].includes(name) &&
      await fs.realpath(dirname(String(path))) === canonicalRoot
    if (target && name === 'denied.txt') {
      injected.push(name)
      throw Object.assign(new Error(`EACCES: private filesystem detail ${root}`), { code: 'EACCES' })
    }
    if (target && name === 'unknown.txt') {
      injected.push(name)
      throw new Error(`private filesystem detail ${root}`)
    }
    return lstat(path, ...args)
  })
  for (const [path, code, message] of [
    ['missing.txt', 'not_found', /not found/], ['folder', 'is_directory', /workspace_list/],
    ['invalid.txt', 'not_utf8', /valid UTF-8/], ['binary-nul.txt', 'not_text', /NUL/],
    ['large.txt', 'too_large', /byte limit/], ['denied.txt', 'permission_denied', /permissions/],
    ['unknown.txt', 'workspace_read_failed', /details are withheld/]
  ]) {
    const result = await workspace.execute('workspace_read', { path }, new AbortController().signal)
    const data = JSON.parse(result.content)
    assert.equal(result.isError, true); assert.equal(data.error.code, code); assert.match(data.error.message, message)
    assert(!result.content.includes(root)); assert(!result.content.includes('private filesystem detail'))
  }
  assert.deepEqual(injected, ['denied.txt', 'unknown.txt'])
})

async function writer(t, { name = 'note_set', mode = 'manual', probability = 1, allow = true, durability = false } = {}) {
  const root = await directory(t), workspace = await ReadOnlyWorkspace.open(root)
  const initial = 'old text\n'
  if (name === 'workspace_edit_text') await fs.writeFile(join(root, 'task.txt'), initial)
  const args = name === 'note_set' ? { key: 'task', value: 'new text', expectedRevision: 0 }
    : name === 'workspace_create_text' ? { path: 'task.txt', content: 'new text\n' }
      : { path: 'task.txt', before: 'old', after: 'new', expectedRevision: workspaceRevision(Buffer.from(initial)) }
  let rounds = 0, human = 0, evaluations = 0, failedDurability = false
  const store = { async save(_session, options) {
    if (durability && name === 'note_set' && options?.assertCurrent && !failedDurability) {
      failedDurability = true; throw new SessionCommitError(new Error('durability fixture'))
    }
  } }
  if (durability && name !== 'note_set') {
    const commit = workspace.commitMutation.bind(workspace)
    t.mock.method(workspace, 'commitMutation', async (...args) => { throw new WorkspaceCommitError(await commit(...args)) })
  }
  const host = new CliHost({ workspace, store, session: newSession({ provider: 'openai', model: 'fixture' }), enableNotes: true,
    permissionApproval: { isAvailable: () => true, accountRevision: () => 'fixture-account' },
    approve: async () => { human++; return allow },
    decisionReview: { canAutoReview: true, accountRevision: () => 'fixture-account', isAvailable: () => true,
      provider: { id: 'openai', model: 'gpt-6-luna', async evaluate(request) {
        evaluations++
        return { model: 'gpt-6-luna', answers: request.policy.checks.map(check => ({ name: check.name, type: 'predicate', probability })),
          usage: { inputTokens: 1, outputTokens: 1 } }
      } }, ledger: { async upsert() {} } },
    provider: { async generate() {
      return ++rounds === 1 ? { content: '', toolCalls: [{ id: 'write', name, arguments: args }] }
        : { content: 'Done', toolCalls: [] }
    } }
  })
  t.after(() => host.shutdown())
  host.setApprovalMode(mode)
  const response = await host.send('Save the task with new text')
  const result = JSON.parse(response.history.find(message => message.kind === 'tool_result').content)
  return { result, human, evaluations, host, root }
}

for (const name of ['note_set', 'workspace_create_text', 'workspace_edit_text']) {
  for (const [mode, probability, expected] of [['manual', 1, 'human'], ['auto', 1, 'automatic'], ['auto', 0.5, 'human'], ['skip', 1, 'skip']]) {
    test(`${name} reports actual ${expected} review source in ${mode} mode (${probability})`, async t => {
      const { result, human, evaluations } = await writer(t, { name, mode, probability })
      assert.equal(result.success, true); assert.equal(result.reviewSource, expected)
      assert.equal(human, expected === 'human' ? 1 : 0)
      assert.equal(evaluations, mode === 'auto' ? 1 : 0)
    })
  }
  test(`${name} denial does not report a successful review source`, async t => {
    const { result } = await writer(t, { name, allow: false })
    assert.equal(result.success, false); assert.equal(Object.hasOwn(result, 'reviewSource'), false)
  })
  test(`${name} retains review source when publication succeeds but durability is unconfirmed`, async t => {
    const { result } = await writer(t, { name, durability: true })
    assert.equal(result.success, true); assert.equal(result.durabilityUnconfirmed, true)
    assert.equal(result.reviewSource, 'human')
  })
}

test('workspace edit zero-match and repeated-match codes reach the provider without approval', async t => {
  for (const [before, code] of [['absent', 'target_not_found'], ['text', 'target_not_unique']]) {
    const root = await directory(t), workspace = await ReadOnlyWorkspace.open(root)
    const initial = 'text text'; await fs.writeFile(join(root, 'task.txt'), initial)
    let rounds = 0
    const host = new CliHost({ workspace, store: { async save() {} }, session: newSession({ provider: 'openai', model: 'fixture' }),
      approve: async () => { assert.fail('Invalid target must fail before approval') }, provider: { async generate() {
        return ++rounds === 1 ? { content: '', toolCalls: [{ id: 'edit', name: 'workspace_edit_text', arguments: {
          path: 'task.txt', before, after: 'new', expectedRevision: workspaceRevision(Buffer.from(initial))
        } }] } : { content: 'Done', toolCalls: [] }
      } } })
    t.after(() => host.shutdown())
    const response = await host.send('Edit task.txt')
    const result = JSON.parse(response.history.find(message => message.kind === 'tool_result').content)
    assert.equal(result.error.code, code); assert.equal(result.success, false)
    assert.equal(await fs.readFile(join(root, 'task.txt'), 'utf8'), initial)
  }
})
