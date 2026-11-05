// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliHost } from '../dist/host.js'
import { newSession } from '../dist/session.js'
import { ReadOnlyWorkspace } from '../dist/workspace.js'
import { workspaceRevision, WorkspaceCommitError } from '../dist/workspace-edit.js'
import { createBuiltinToolset } from '../dist/tools.js'
import { createDeepSeekWebExtension, DEEPSEEK_WEB_COST, DEEPSEEK_WEB_GUIDANCE } from '../dist/web-tools.js'

const signal = () => new AbortController().signal
const initial = '\ufefforiginal\r\n'
const revision = workspaceRevision(Buffer.from(initial))
async function isSourcePath(path, root) {
  return basename(String(path)) === 'old.txt' && await fs.realpath(dirname(String(path))) === await fs.realpath(root)
}
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'vivi-ergonomics-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(join(root, 'old.txt'), initial)
  await fs.mkdir(join(root, 'sub'))
  const workspace = await ReadOnlyWorkspace.open(root)
  return { root, workspace }
}
const entries = {
  workspace_delete_file: { path: 'old.txt', expectedRevision: revision },
  workspace_move_file: { path: 'old.txt', destination: 'sub/new.txt', expectedRevision: revision },
  workspace_mkdir: { path: 'sub/new-folder' }
}

test('list reports metadata and distinguishes examined entries from returned entries and content reads', async t => {
  const { root, workspace } = await fixture(t)
  await fs.writeFile(join(root, '.env'), 'excluded')
  const result = JSON.parse((await workspace.execute('workspace_list', { maxResults: 1 }, signal())).content)
  assert.equal(result.entries.length, 1); assert.equal(result.truncated, true)
  assert(result.scannedEntries >= 2); assert(result.scannedFiles >= 1); assert.equal(result.scannedBytes, 0)
  const all = JSON.parse((await workspace.execute('workspace_list', {}, signal())).content)
  assert.equal(all.scannedFiles, 1)
  assert(all.scannedEntries > all.entries.length)
  const file = all.entries.find(entry => entry.path === 'old.txt'), info = await fs.stat(join(root, 'old.txt'))
  assert.equal(file.sizeBytes, Buffer.byteLength(initial)); assert.equal(file.modifiedAt, info.mtime.toISOString())
  assert(all.entries.every(entry => Number.isFinite(Date.parse(entry.modifiedAt))))
})

for (const mode of ['manual', 'auto', 'skip', 'plan']) {
  test(`session_status reads actual host state in ${mode} without approvals, notes or extra provider requests`, async t => {
    let rounds = 0
    const session = newSession({ provider: 'openai', model: 'fixture', reasoning: 'high' })
    const host = new CliHost({ session, store: { async save() {} }, enableNotes: false,
      permissionApproval: { isAvailable: () => true, accountRevision: () => 'account' },
      decisionReview: { canAutoReview: true, accountRevision: () => 'account', isAvailable: () => true,
        provider: { id: 'openai', model: 'reviewer', evaluate: async () => assert.fail('Status must never use a reviewer') }, ledger: { async upsert() {} } },
      approve: async () => assert.fail('Status must never request approval'),
      provider: { async generate({ tools }) {
        assert(tools.some(tool => tool.name === 'session_status'))
        return ++rounds === 1 ? { content: '', toolCalls: [{ id: 'status', name: 'session_status', arguments: {} }] }
          : { content: 'Done', toolCalls: [] }
      } } })
    t.after(() => host.shutdown())
    if (mode === 'plan') host.setTaskMode('plan')
    else if (mode !== 'manual') host.setApprovalMode(mode)
    const response = await host.send('Inspect current session')
    const data = JSON.parse(response.history.find(message => message.kind === 'tool_result').content)
    assert.equal(data.provider, 'openai'); assert.equal(data.model, 'fixture'); assert.equal(data.reasoning, 'high')
    assert.equal(data.taskMode, mode === 'plan' ? 'plan' : 'execute')
    assert.equal(data.approvalMode, mode === 'plan' ? 'manual' : mode)
    assert(data.context === null || typeof data.context.inputTokens === 'number')
    assert.equal(rounds, 2); assert.deepEqual(Object.keys(data).sort(), ['approvalMode', 'context', 'model', 'provider', 'reasoning', 'taskMode'])
  })
}

test('session_status rejects arguments and cannot be replaced by an extension', async () => {
  const tools = createBuiltinToolset()
  try {
    const host = { readSessionStatus: () => assert.fail('Unexpected arguments must fail first') }
    const result = await tools.executeTool({ id: 'bad', name: 'session_status', arguments: { model: 'fake' } }, signal(), host)
    assert.equal(result.isError, true)
    assert.equal(JSON.parse(result.content).error.code, 'invalid_arguments')
  } finally { await tools.dispose() }
  assert.throws(() => createBuiltinToolset(false, [{ id: 'collision', apiVersion: 1, tools: [{
    definition: { name: 'session_status', description: '', parameters: {} }, validateArguments() {}, execute() {}
  }] }]), /collision/)
})

test('DeepSeek numeric cost and billing limits are visible before a paid request', () => {
  const web = createDeepSeekWebExtension(() => assert.fail('No paid requests in verification'))
  assert(DEEPSEEK_WEB_GUIDANCE.includes(DEEPSEEK_WEB_COST))
  assert.match(DEEPSEEK_WEB_GUIDANCE, /no enforceable per-turn spending cap/)
  for (const tool of web.tools) assert(tool.definition.description.includes(DEEPSEEK_WEB_COST))
})

for (const [name, args] of Object.entries(entries)) {
  test(`${name} commits once and preserves bytes or creates exactly one directory`, async t => {
    const { root, workspace } = await fixture(t)
    const prepared = await workspace.prepareMutation(name, args, signal())
    const result = await workspace.commitMutation(prepared, signal(), () => {})
    if (name === 'workspace_delete_file') await assert.rejects(fs.lstat(join(root, 'old.txt')), { code: 'ENOENT' })
    else if (name === 'workspace_move_file') {
      assert.equal(await fs.readFile(join(root, args.destination), 'utf8'), initial)
      await assert.rejects(fs.lstat(join(root, 'old.txt')), { code: 'ENOENT' })
      assert.equal(result.sourceRemoved, true)
    } else assert((await fs.stat(join(root, args.path))).isDirectory())
    await assert.rejects(workspace.commitMutation(prepared, signal(), () => {}), /current host-prepared/)
  })
  for (const allow of [false, true]) {
    test(`${name} in Auto uses human review (${allow ? 'allow' : 'deny'}) and no model evaluator`, async t => {
      const { root, workspace } = await fixture(t)
      let rounds = 0, approvals = 0
      const host = new CliHost({ workspace, session: newSession({ provider: 'openai', model: 'fixture' }), store: { async save() {} },
        decisionReview: { canAutoReview: true, accountRevision: () => 'account', isAvailable: () => true,
          provider: { id: 'openai', model: 'reviewer', evaluate: async () => assert.fail('New operations must stay Manual') }, ledger: { async upsert() {} } },
        approve: async request => { approvals++; assert(request.description.includes(args.path)); return allow },
        provider: { async generate() { return ++rounds === 1 ? { content: '', toolCalls: [{ id: 'mutation', name, arguments: args }] } : { content: 'Done', toolCalls: [] } } } })
      t.after(() => host.shutdown()); host.setApprovalMode('auto')
      const response = await host.send('Perform the requested workspace operation')
      const result = JSON.parse(response.history.find(message => message.kind === 'tool_result').content)
      assert.equal(approvals, 1); assert.equal(result.success, allow)
      if (!allow) {
        assert.equal(await fs.readFile(join(root, 'old.txt'), 'utf8'), initial)
        if (name !== 'workspace_delete_file') await assert.rejects(fs.lstat(join(root, args.destination ?? args.path)), { code: 'ENOENT' })
      }
    })
  }
  test(`${name} refuses stale resource state after preparation`, async t => {
    const { root, workspace } = await fixture(t)
    const prepared = await workspace.prepareMutation(name, args, signal())
    if (name === 'workspace_mkdir') await fs.mkdir(join(root, args.path))
    else await fs.writeFile(join(root, 'old.txt'), 'concurrent edit')
    await assert.rejects(workspace.commitMutation(prepared, signal(), () => {}), /changed|already exists/)
    if (name !== 'workspace_mkdir') assert.equal(await fs.readFile(join(root, 'old.txt'), 'utf8'), 'concurrent edit')
  })
  test(`${name} rechecks ignore rules after review`, async t => {
    const { root, workspace } = await fixture(t)
    const prepared = await workspace.prepareMutation(name, args, signal())
    await fs.writeFile(join(root, '.gitignore'), name === 'workspace_mkdir' ? 'sub/new-folder/\n' : 'old.txt\n')
    await assert.rejects(workspace.commitMutation(prepared, signal(), () => {}), /excluded/)
    assert.equal(await fs.readFile(join(root, 'old.txt'), 'utf8'), initial)
  })
  test(`${name} blocks newly known credentials at the final admission check`, async t => {
    const { root, workspace } = await fixture(t)
    const prepared = await workspace.prepareMutation(name, args, signal())
    let checks = 0
    await assert.rejects(workspace.commitMutation(prepared, signal(), () => {
      if (++checks === 2) workspace.addSecrets([name === 'workspace_mkdir' ? 'new-folder' : 'original'])
    }), /newly known credential/)
    assert.equal(await fs.readFile(join(root, 'old.txt'), 'utf8'), initial)
    if (name !== 'workspace_delete_file') await assert.rejects(fs.lstat(join(root, args.destination ?? args.path)), { code: 'ENOENT' })
  })
}

test('move refuses existing, excluded, missing-parent and outside-workspace destinations', async t => {
  const { root, workspace } = await fixture(t)
  await fs.writeFile(join(root, 'existing.txt'), 'keep')
  await fs.writeFile(join(root, '.gitignore'), 'ignored/\n')
  for (const destination of ['existing.txt', '.env', '.git/file.txt', '../outside.txt', 'missing/new.txt', 'ignored/new.txt']) {
    await assert.rejects(workspace.prepareMutation('workspace_move_file', { ...entries.workspace_move_file, destination }, signal()))
  }
  const prepared = await workspace.prepareMutation('workspace_move_file', entries.workspace_move_file, signal())
  await fs.writeFile(join(root, 'sub/new.txt'), 'keep')
  await assert.rejects(workspace.commitMutation(prepared, signal(), () => {}), /already exists/)
  assert.equal(await fs.readFile(join(root, 'sub/new.txt'), 'utf8'), 'keep')
  assert.equal(await fs.readFile(join(root, 'old.txt'), 'utf8'), initial)
})

for (const name of ['workspace_delete_file', 'workspace_move_file']) {
  test(`${name} preserves a source changed during the final host check`, async t => {
    const { root, workspace } = await fixture(t)
    const prepared = await workspace.prepareMutation(name, entries[name], signal())
    let checks = 0
    await assert.rejects(workspace.commitMutation(prepared, signal(), async () => {
      if (++checks === (name === 'workspace_move_file' ? 3 : 2)) await fs.writeFile(join(root, 'old.txt'), 'concurrent edit')
    }))
    assert.equal(await fs.readFile(join(root, 'old.txt'), 'utf8'), 'concurrent edit')
  })
}

test('move exposes readable partial results when source unlink fails after exclusive destination creation', async t => {
  const { root, workspace } = await fixture(t)
  const prepared = await workspace.prepareMutation('workspace_move_file', entries.workspace_move_file, signal())
  const unlink = fs.unlink
  t.mock.method(fs, 'unlink', async (path, ...args) => {
    if (await isSourcePath(path, root)) throw new Error('Unlink fixture failure')
    return unlink(path, ...args)
  })
  await assert.rejects(workspace.commitMutation(prepared, signal(), () => {}), error => {
    assert(error instanceof WorkspaceCommitError); assert.equal(error.result.sourceRemoved, false); return true
  })
  assert.equal(await fs.readFile(join(root, 'old.txt'), 'utf8'), initial)
  assert.equal(await fs.readFile(join(root, 'sub/new.txt'), 'utf8'), initial)
  for (const path of ['old.txt', 'sub/new.txt']) {
    const result = await workspace.execute('workspace_read', { path }, signal())
    assert.equal(result.isError, undefined)
    assert.equal(JSON.parse(result.content).revision, revision)
  }
})

for (const failure of ['file', 'destination-directory', 'source-directory', undefined]) {
  test(`move syncs destination bytes and entry before source removal (${failure ?? 'success'})`,
    { skip: failure?.endsWith('directory') && process.platform !== 'linux' }, async t => {
    const { root, workspace } = await fixture(t)
    const canonicalRoot = await fs.realpath(root)
    const prepared = await workspace.prepareMutation('workspace_move_file', entries.workspace_move_file, signal())
    const events = [], open = fs.open, unlink = fs.unlink
    t.mock.method(fs, 'open', async (path, ...args) => {
      const handle = await open(path, ...args), canonical = await fs.realpath(String(path))
      const stage = canonical === join(canonicalRoot, 'sub/new.txt') ? 'file'
        : canonical === join(canonicalRoot, 'sub') ? 'destination-directory' : canonical === canonicalRoot ? 'source-directory' : undefined
      if (stage) {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          events.push(stage)
          if (stage === failure) throw new Error(`Simulated ${stage} sync failure`)
          await sync()
        }
      }
      return handle
    })
    t.mock.method(fs, 'unlink', async (path, ...args) => {
      if (await isSourcePath(path, root)) events.push('source-unlink')
      return unlink(path, ...args)
    })
    if (failure) {
      await assert.rejects(workspace.commitMutation(prepared, signal(), () => {}), error => {
        assert(error instanceof WorkspaceCommitError)
        assert.equal(error.result.sourceRemoved, failure === 'source-directory')
        return true
      })
    } else assert.equal((await workspace.commitMutation(prepared, signal(), () => {})).sourceRemoved, true)
    assert.equal(await fs.readFile(join(root, 'sub/new.txt'), 'utf8'), initial)
    if (failure && failure !== 'source-directory') {
      assert.equal(await fs.readFile(join(root, 'old.txt'), 'utf8'), initial)
      assert(!events.includes('source-unlink'))
    } else {
      await assert.rejects(fs.lstat(join(root, 'old.txt')), { code: 'ENOENT' })
      assert(events.indexOf('file') < events.indexOf('source-unlink'))
      if (process.platform === 'linux') {
        assert(events.indexOf('file') < events.indexOf('destination-directory'))
        assert(events.indexOf('destination-directory') < events.indexOf('source-unlink'))
        assert(events.indexOf('source-unlink') < events.indexOf('source-directory'))
      }
    }
    if (failure) assert(events.includes(failure), 'The intended sync failure must be injected')
  })
}

for (const cause of ['source-policy', 'destination-policy', 'cancel', 'destination-change']) {
  test(`move preserves source when ${cause} occurs during destination sync`, async t => {
    const { root, workspace } = await fixture(t), canonicalRoot = await fs.realpath(root)
    const controller = new AbortController(), open = fs.open
    const prepared = await workspace.prepareMutation('workspace_move_file', entries.workspace_move_file, controller.signal)
    let injected = false
    t.mock.method(fs, 'open', async (path, ...args) => {
      const handle = await open(path, ...args)
      if (await fs.realpath(String(path)) === join(canonicalRoot, 'sub/new.txt')) {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          await sync(); injected = true
          if (cause.endsWith('policy')) await fs.writeFile(join(root, '.gitignore'), cause === 'source-policy' ? 'old.txt\n' : 'sub/new.txt\n')
          if (cause === 'cancel') controller.abort()
          if (cause === 'destination-change') await fs.writeFile(join(root, 'sub/new.txt'), 'concurrent destination edit')
        }
      }
      return handle
    })
    await assert.rejects(workspace.commitMutation(prepared, controller.signal, () => {}), error => {
      assert(error instanceof WorkspaceCommitError); assert.equal(error.result.sourceRemoved, false); return true
    })
    assert.equal(injected, true)
    assert.equal(await fs.readFile(join(root, 'old.txt'), 'utf8'), initial)
    assert.equal(await fs.readFile(join(root, 'sub/new.txt'), 'utf8'), cause === 'destination-change' ? 'concurrent destination edit' : initial)
  })
}

for (const partial of [false, true]) {
  test(`move host preserves ${partial ? 'partial outcome evidence' : 'destination project guidance checks'} after approval`, async t => {
    const { root, workspace } = await fixture(t)
    let rounds = 0
    if (partial) {
      const unlink = fs.unlink
      t.mock.method(fs, 'unlink', async (path, ...args) => {
        if (await isSourcePath(path, root)) throw new Error('Unlink fixture failure')
        return unlink(path, ...args)
      })
    }
    const host = new CliHost({ workspace, session: newSession({ provider: 'openai', model: 'fixture' }), store: { async save() {} },
      approve: async () => {
        if (!partial) await fs.writeFile(join(root, 'sub/AGENTS.md'), 'New project instructions during review')
        return true
      }, provider: { async generate() {
        return ++rounds === 1 ? { content: '', toolCalls: [{ id: 'move', name: 'workspace_move_file', arguments: entries.workspace_move_file }] }
          : { content: 'Done', toolCalls: [] }
      } } })
    t.after(() => host.shutdown())
    const response = await host.send('Move old.txt to sub/new.txt')
    const result = JSON.parse(response.history.find(message => message.kind === 'tool_result').content)
    assert.equal(result.success, false)
    assert.equal(result.error.code, partial ? 'workspace_move_partial' : 'instructions_required')
    assert.equal(await fs.readFile(join(root, 'old.txt'), 'utf8'), initial)
    if (partial) {
      assert.equal(result.partial, true); assert.equal(result.sourceRemoved, false)
      assert.equal(await fs.readFile(join(root, 'sub/new.txt'), 'utf8'), initial)
      const receipt = host.toolPresentationEvidence.decisions.find(decision => decision.callId === 'move')
      assert.equal(receipt.status, 'failed'); assert.equal(receipt.effect, 'unknown')
    } else await assert.rejects(fs.lstat(join(root, 'sub/new.txt')), { code: 'ENOENT' })
  })
}

test('move host preserves a successful move with unconfirmed source-directory durability', { skip: process.platform !== 'linux' }, async t => {
  const { root, workspace } = await fixture(t), open = fs.open
  const canonicalRoot = await fs.realpath(root)
  let rounds = 0, injected = false
  t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await open(path, ...args)
    if (await fs.realpath(String(path)) === canonicalRoot) handle.sync = async () => {
      injected = true; throw new Error('Simulated source-directory sync failure')
    }
    return handle
  })
  const host = new CliHost({ workspace, session: newSession({ provider: 'openai', model: 'fixture' }), store: { async save() {} },
    approve: async () => true, provider: { async generate() {
      return ++rounds === 1 ? { content: '', toolCalls: [{ id: 'move', name: 'workspace_move_file', arguments: entries.workspace_move_file }] }
        : { content: 'Done', toolCalls: [] }
    } } })
  t.after(() => host.shutdown())
  const response = await host.send('Move old.txt to sub/new.txt')
  const result = JSON.parse(response.history.find(message => message.kind === 'tool_result').content)
  assert.equal(injected, true); assert.equal(result.success, true); assert.equal(result.sourceRemoved, true)
  assert.equal(result.durabilityUnconfirmed, true); assert.equal(result.reviewSource, 'human')
  assert.equal(await fs.readFile(join(root, 'sub/new.txt'), 'utf8'), initial)
  await assert.rejects(fs.lstat(join(root, 'old.txt')), { code: 'ENOENT' })
})
