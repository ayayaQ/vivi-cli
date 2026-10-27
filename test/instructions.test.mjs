// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ProjectInstructions, INSTRUCTION_LIMIT_BYTES } from '../dist/instructions.js'
import { ReadOnlyWorkspace } from '../dist/workspace.js'

const signal = () => new AbortController().signal
async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'vivi-instructions-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'project'); await fs.mkdir(join(root, 'src', 'nested'), { recursive: true })
  return { directory, root, workspace: await ReadOnlyWorkspace.open(root) }
}
test('optional root guidance is fresh, inert derived context and absent without diagnostics', async t => {
  const f = await fixture(t), instructions = new ProjectInstructions(f.workspace)
  let snapshot = await instructions.refresh(signal())
  assert.deepEqual(snapshot.messages, []); assert.equal(snapshot.sources.get('AGENTS.md').revision, 'absent')
  await fs.writeFile(join(f.root, 'AGENTS.md'), 'Use ordinary project formatting.\n')
  snapshot = await instructions.refresh(signal())
  assert.equal(snapshot.messages[0].role, 'system'); assert(!snapshot.messages[0].content.includes('Use ordinary project formatting.'))
  assert.equal(snapshot.messages[1].role, 'user'); assert(snapshot.messages[1].content.includes('Use ordinary project formatting.'))
  assert.match(snapshot.messages[0].content, /below actual user instructions and host\/system policy/)
  const previous = snapshot.sources.get('AGENTS.md').revision
  await fs.writeFile(join(f.root, 'AGENTS.md'), 'Use the current project formatting.\n')
  snapshot = await instructions.refresh(signal())
  assert.notEqual(snapshot.sources.get('AGENTS.md').revision, previous)
})
test('explicit profile precedes selected root and only activated bounded descendant scopes', async t => {
  const f = await fixture(t)
  await fs.writeFile(join(f.directory, 'AGENTS.md'), 'Parent guidance must not load')
  await fs.writeFile(join(f.root, 'profile.md'), 'Profile guidance')
  await fs.writeFile(join(f.root, 'AGENTS.md'), 'Root guidance')
  await fs.writeFile(join(f.root, 'src', 'AGENTS.md'), 'Source guidance')
  await fs.writeFile(join(f.root, 'src', 'nested', 'AGENTS.md'), 'Nested guidance')
  const instructions = new ProjectInstructions(f.workspace, { workspace: f.workspace, path: 'profile.md' })
  let snapshot = await instructions.refresh(signal())
  assert.deepEqual([...snapshot.sources.keys()], ['profile', 'AGENTS.md'])
  await assert.rejects(instructions.assertMutation('src/nested/new.txt', snapshot, signal()), /originating dispatch/)
  snapshot = await instructions.refresh(signal())
  assert.deepEqual([...snapshot.sources.keys()], ['profile', 'AGENTS.md', 'src/AGENTS.md', 'src/nested/AGENTS.md'])
  const content = snapshot.messages[1].content
  assert(content.indexOf('Profile guidance') < content.indexOf('Root guidance'))
  assert(content.indexOf('Root guidance') < content.indexOf('Source guidance'))
  assert(content.indexOf('Source guidance') < content.indexOf('Nested guidance'))
  assert(!content.includes('Parent guidance must not load'))
  await instructions.assertMutation('src/nested/new.txt', snapshot, signal())
})
test('root-only guidance allows a new ordinary descendant target but newly added guidance requires replanning', async t => {
  const f = await fixture(t), instructions = new ProjectInstructions(f.workspace)
  await fs.writeFile(join(f.root, 'AGENTS.md'), 'Root conventions')
  const originating = await instructions.refresh(signal())
  await instructions.assertMutation('src/new.txt', originating, signal())
  await fs.writeFile(join(f.root, 'src', 'AGENTS.md'), 'New source conventions')
  await assert.rejects(instructions.assertMutation('src/new.txt', originating, signal()), /replan/)
  const refreshed = await instructions.refresh(signal())
  await instructions.assertMutation('src/new.txt', refreshed, signal())
  await fs.unlink(join(f.root, 'src', 'AGENTS.md'))
  await assert.rejects(instructions.assertMutation('src/new.txt', refreshed, signal()), /changed/)
})
test('aggregate bound reports the applicable source and blocks incomplete mutation guidance without silent truncation', async t => {
  const f = await fixture(t), instructions = new ProjectInstructions(f.workspace)
  await fs.writeFile(join(f.root, 'AGENTS.md'), 'a'.repeat(INSTRUCTION_LIMIT_BYTES / 2 + 1))
  await fs.writeFile(join(f.root, 'src', 'AGENTS.md'), 'b'.repeat(INSTRUCTION_LIMIT_BYTES / 2 + 1))
  instructions.activate('src/new.txt', true)
  const snapshot = await instructions.refresh(signal())
  assert.match(snapshot.sources.get('src/AGENTS.md').error, /aggregate 32 KiB/)
  assert(snapshot.messages[1].content.includes('SOURCE ERROR'))
  await assert.rejects(instructions.assertMutation('src/new.txt', snapshot, signal()), /aggregate 32 KiB/)
  instructions.disable()
  const disabled = await instructions.refresh(signal())
  assert.deepEqual(disabled.messages, [])
  await instructions.assertMutation('src/new.txt', disabled, signal())
})
