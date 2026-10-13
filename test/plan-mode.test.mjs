// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliHost } from '../dist/host.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { FileMemoryStore } from '../dist/memory.js'
import { ReadOnlyWorkspace } from '../dist/workspace.js'
import { createSkillCatalog } from '@ayayaq/vivi/extensions/skills'
import { createBuiltinToolset } from '../dist/tools.js'
import { PLAN_MODE_GUIDANCE } from '../dist/task-mode.js'
import { cycleApprovalMode, runModeControl, selectApprovalMode } from '../dist/terminal.js'

const settings = { provider: 'openai', model: 'offline-plan' }
const call = (name, arguments_ = {}, id = name) => ({ id, name, arguments: arguments_ })
const answer = (content = 'Proposed plan', toolCalls = []) => ({ content, toolCalls })
const persistence = () => ({ snapshots: [], async save(session) { this.snapshots.push(structuredClone(session)) }, async load() {} })
const extension = (name, execute, validateArguments = () => {}) => ({ id: `offline.${name}`, apiVersion: 1,
  tools: [{ definition: { name, description: 'Read only according to the extension', parameters: { type: 'object' } }, validateArguments, execute }] })
function controls(host, allow = false) {
  const requests = [], modes = [], tasks = []
  const io = { canAutoReview: true, write() {}, setApprovalMode(mode) { modes.push(mode) }, setTaskMode(mode) { tasks.push(mode) },
    onCancel() { return () => {} }, async approve(request) { requests.push(request); return allow } }
  return { host, io, requests, modes, tasks }
}
function host(options = {}) {
  return new CliHost({ store: persistence(), session: newSession(settings), provider: { async generate() { return answer() } }, ...options })
}

test('Plan uses enabled local reads, blocks every mutation/remote/extension before review, and persists the ordinary plan', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-plan-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'project'); await mkdir(root)
  await writeFile(join(root, 'readme.txt'), 'Local project context')
  const store = new FileSessionStore(join(directory, 'state'))
  const memory = new FileMemoryStore(join(directory, 'memory'))
  t.after(() => memory.drain({ close: true }))
  await memory.commit(await memory.prepareCreate('Ordinary saved context', 'user'))
  const beforeMemory = await memory.list()
  const catalog = createSkillCatalog([{ content: '---\nname: offline-guide\ndescription: Local guide\n---\nInert local instructions\n', readOnly: true }])
  const revision = catalog.skills[0].revision
  const effects = { human: 0, judge: 0, capture: 0, command: 0, url: 0, extension: 0 }
  const reads = [call('calculate', { expression: '2 + 3' }), call('current_time'), call('note_read'), call('list_memories'),
    call('list_skills'), call('read_skill', { name: 'offline-guide', path: 'SKILL.md', expectedRevision: revision }),
    call('workspace_read', { path: 'readme.txt' }), call('workspace_list'),
    call('workspace_search', { query: 'Local' }), call('workspace_glob', { pattern: '*.txt' })]
  const blocked = ['note_set', 'create_memory', 'edit_memory', 'delete_memory', 'save_skill',
    'workspace_create_text', 'workspace_edit_text', 'command_start', 'command_poll', 'command_stop',
    'fetch_url', 'list_mcp_resources', 'read_mcp_resource', 'read_mcp_resource_template', 'mcp_offline_read', 'custom_read', 'unknown_future_tool']
  let rounds = 0
  const subject = host({ store, memory, enableMemory: true, enableNotes: true, enableSkills: true,
    skills: { writable: false, diagnostics: [], addSecrets() {}, async snapshot() { return catalog }, async drain() {} },
    workspace: await ReadOnlyWorkspace.open(root), commandApproval: { isAvailable: () => true, accountRevision: () => 'offline' },
    commandWorkspaceFactory: async () => { effects.command++; throw new Error('No command setup in Plan') },
    mcp: { addSecrets() {}, async captureCatalogs() { effects.capture++; throw new Error('No remote catalog capture in Plan') }, async drain() {} },
    publicUrlTransport: { async resolve() { effects.url++; throw new Error('No DNS in Plan') }, async request() { effects.url++; throw new Error('No URL request in Plan') } },
    extensions: [extension('custom_read', () => { effects.extension++; return { content: 'Not trusted as a read' } })],
    approve: async () => { effects.human++; return true },
    decisionReview: { canAutoReview: true, accountRevision: () => 'offline', ledger: { async upsert() {} },
      provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { effects.judge++; throw new Error('No review in Plan') } } },
    provider: { async generate(input) {
      assert(input.messages.some(message => message.content === PLAN_MODE_GUIDANCE))
      assert.deepEqual(input.tools.map(tool => tool.name).sort(), reads.map(tool => tool.name).sort())
      assert.throws(() => subject.setTaskMode('execute'), /current turn/)
      assert.throws(() => subject.setApprovalMode('auto'), /current turn/)
      if (++rounds === 1) return answer('', reads)
      if (rounds === 2) {
        const results = input.messages.filter(message => message.kind === 'tool_result')
        assert.equal(results.length, reads.length); assert(results.every(message => !message.isError))
        assert(results.some(message => message.content.includes('Local project context')))
        assert(results.some(message => message.content.includes('Inert local instructions')))
        return answer('', blocked.map(name => call(name, {})))
      }
      assert(input.messages.filter(message => message.kind === 'tool_result' && blocked.includes(message.name)).every(message => message.isError))
      return answer()
    } } })
  t.after(() => subject.shutdown())
  subject.setApprovalMode('auto'); const oldEnrollment = subject.approvalEnrollmentBinding
  subject.setTaskMode('plan')
  assert.equal(subject.approvalMode, 'manual'); assert.notEqual(subject.approvalEnrollmentBinding, oldEnrollment)
  assert.throws(() => subject.setApprovalMode('auto'), /Leave Plan/)
  const result = await subject.send('Investigate and propose a plan')
  assert.equal(result.status, 'completed'); assert.equal(result.content, 'Proposed plan')
  assert.equal(subject.taskMode, 'plan')
  assert.deepEqual(effects, { human: 0, judge: 0, capture: 0, command: 0, url: 0, extension: 0 })
  assert.equal(subject.session.noteRevision, 0); assert.deepEqual(subject.session.notes, {})
  assert.deepEqual(await memory.list(), beforeMemory)
  assert.equal(await readFile(join(root, 'readme.txt'), 'utf8'), 'Local project context')
  assert.deepEqual(await readdir(root), ['readme.txt'])
  assert.deepEqual((await store.load(subject.session.id)).history, result.history)
  assert(!result.history.some(message => message.role === 'system'))
})

test('fixed Plan dispatcher denies omitted and later-injected tools before validators or approvals', async () => {
  assert.throws(() => createBuiltinToolset(false, [], undefined, undefined, undefined, undefined, undefined, undefined, 'unknown'), /Unknown task mode/)
  let effects = 0
  const mutate = extension('create_memory', () => { effects++; return { content: 'mutation' } }, () => { effects++ })
  const imported = extension('custom_read', () => { effects++; return { content: 'external' } }, () => { effects++ })
  const toolset = createBuiltinToolset(true, [imported], mutate, undefined, undefined, undefined, undefined, undefined, 'plan')
  const signal = new AbortController().signal
  const toolHost = { enableNotes: true, readNotes: () => ({ revision: 0, notes: {} }),
    async commitNote() { effects++; return 1 }, async approve() { effects++; return true } }
  try {
    toolset.tools.push(imported.tools[0].definition)
    for (const name of ['note_set', 'create_memory', 'custom_read', 'read_skill', 'workspace_read', 'fetch_url', 'mcp_fake_read']) {
      const result = await toolset.executeTool(call(name), signal, toolHost)
      assert.equal(result.isError, true); assert.equal(JSON.parse(result.content).error.code, 'plan_mode_read_only')
    }
    assert.equal(effects, 0)
    assert.equal((await toolset.executeTool(call('note_read'), signal, toolHost)).isError, undefined)
  } finally { await toolset.dispose() }
  await assert.rejects(toolset.executeTool(call('note_read'), signal, toolHost))
})

test('Plan does not enable disabled features or override chat-only model capability', async () => {
  for (const enableTools of [true, false]) {
    let rounds = 0
    const subject = host({ enableTools, provider: { async generate({ tools }) {
      assert.deepEqual(tools.map(tool => tool.name), enableTools ? ['calculate', 'current_time'] : [])
      return ++rounds === 1 ? answer('', ['note_read', 'list_memories', 'read_skill', 'workspace_read'].map(name => call(name))) : answer()
    } } })
    subject.setTaskMode('plan')
    const result = await subject.send('Plan without enabling more features')
    assert.equal(result.status, 'completed')
    assert(result.history.filter(message => message.kind === 'tool_result').every(message => message.isError))
    await subject.shutdown()
  }
})

test('Plan stays selected across turns; leaving it never replays an old proposal or restores Auto', async () => {
  let rounds = 0, approvals = 0
  const subject = host({ enableNotes: true, approve: async () => { approvals++; return true }, provider: { async generate() {
    return ++rounds === 1 || rounds === 4 ? answer('', [call('note_set', { key: 'status', value: 'explicit-new-turn', expectedRevision: 0 }, `note-turn-${rounds}`)]) : answer()
  } } })
  subject.setTaskMode('plan')
  await subject.send('Describe a note change'); await subject.send('Describe the next step')
  assert.equal(subject.taskMode, 'plan'); assert.equal(approvals, 0)
  subject.setTaskMode('execute')
  assert.equal(subject.approvalMode, 'manual'); assert.equal(subject.session.noteRevision, 0)
  await subject.send('Set status to explicit-new-turn now')
  assert.equal(approvals, 1); assert.equal(subject.session.noteRevision, 1)
  await subject.shutdown()
})

test('mode picker offers Plan without enrollment, cancellation preserves Plan, and the full cycle requires fresh Auto consent', async () => {
  const subject = host({ decisionReview: { canAutoReview: true, accountRevision: () => 'offline', ledger: { async upsert() {} },
    provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { assert.fail('No review expected') } } } })
  const f = controls(subject, true)
  await selectApprovalMode(subject, f.io, async (_title, choices, initial) => {
    assert.deepEqual(choices.map(choice => choice.value), ['manual', 'auto', 'plan']); assert.equal(initial, 0); return 'plan'
  })
  assert.equal(subject.taskMode, 'plan'); assert.equal(f.requests.length, 0)
  await selectApprovalMode(subject, f.io, async (_title, _choices, initial) => { assert.equal(initial, 2); return undefined })
  assert.equal(subject.taskMode, 'plan')
  await cycleApprovalMode(subject, f.io); assert.equal(subject.taskMode, 'execute')
  await cycleApprovalMode(subject, f.io); assert.equal(subject.approvalMode, 'auto'); assert.equal(f.requests.length, 1)
  await cycleApprovalMode(subject, f.io); assert.equal(subject.taskMode, 'plan'); assert.equal(subject.approvalMode, 'manual')
  await runModeControl(subject, f.io, '/mode manual')
  await cycleApprovalMode(subject, f.io); assert.equal(f.requests.length, 2)
  assert.notEqual(f.requests[0].call.id, f.requests[1].call.id)
  f.io.canAutoReview = false
  await runModeControl(subject, f.io, '/mode plan'); assert.equal(subject.taskMode, 'plan')
  assert.equal(f.requests.length, 2)
  await subject.shutdown()
})

test('mode setters reject active turns and cancelled old approvals cannot commit after Plan is selected', async () => {
  let resolveApproval, enteredApproval
  const waiting = new Promise(resolve => { enteredApproval = resolve })
  let rounds = 0
  const subject = host({ enableNotes: true, approve: async () => {
    enteredApproval(); return new Promise(resolve => { resolveApproval = resolve })
  }, provider: { async generate() {
    return ++rounds === 1 ? answer('', [call('note_set', { key: 'stale', value: 'uncommitted', expectedRevision: 0 })]) : answer()
  } } })
  const sending = subject.send('Propose a note')
  await waiting
  assert.throws(() => subject.setTaskMode('plan'), /current turn/)
  assert.throws(() => subject.setApprovalMode('manual'), /current turn/)
  subject.cancel(); resolveApproval(true)
  assert.equal((await sending).status, 'cancelled')
  subject.setTaskMode('plan'); await subject.send('Plan the next step')
  assert.equal(subject.session.noteRevision, 0); assert.deepEqual(subject.session.notes, {})
  await subject.shutdown()
})

test('Auto enrollment from Plan is transactional on deny, cancel, close, unavailable surface and errors', async () => {
  for (const outcome of ['deny', 'cancel', 'close', 'unavailable', 'error', 'allow']) {
    const subject = host({ decisionReview: { canAutoReview: true, accountRevision: () => 'offline', ledger: { async upsert() {} },
      provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { assert.fail('Enrollment cannot call the judge') } } } })
    subject.setTaskMode('plan')
    const f = controls(subject); let cancel
    f.io.onCancel = callback => { cancel = callback; return () => {} }
    f.io.canAutoReview = outcome !== 'unavailable'
    f.io.approve = async () => {
      assert.equal(subject.taskMode, 'plan'); assert.equal(subject.approvalMode, 'manual')
      if (outcome === 'cancel') cancel()
      if (outcome === 'close') f.io.isClosed = true
      if (outcome === 'error') throw new Error('Offline approval failure')
      return outcome !== 'deny'
    }
    const selection = selectApprovalMode(subject, f.io, async () => 'auto')
    if (outcome === 'error') await assert.rejects(selection, /Offline approval failure/)
    else await selection
    assert.equal(subject.taskMode, outcome === 'allow' ? 'execute' : 'plan')
    assert.equal(subject.approvalMode, outcome === 'allow' ? 'auto' : 'manual')
    await subject.shutdown()
  }
})

test('stale Auto confirmation from Plan preserves a newer explicit Plan or Manual choice', async () => {
  for (const latest of ['plan', 'manual']) {
    const subject = host({ decisionReview: { canAutoReview: true, accountRevision: () => 'offline', ledger: { async upsert() {} },
      provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { assert.fail('No judge during enrollment') } } } })
    subject.setTaskMode('plan'); const f = controls(subject)
    f.io.approve = async () => { await runModeControl(subject, f.io, `/mode ${latest}`); return true }
    await selectApprovalMode(subject, f.io, async () => 'auto')
    assert.equal(subject.taskMode, latest === 'plan' ? 'plan' : 'execute')
    assert.equal(subject.approvalMode, 'manual'); await subject.shutdown()
  }
})

test('Auto enrollment failure after human allow restores Plan before exposing an unhealthy-ledger error', async () => {
  const subject = host({ decisionReview: { canAutoReview: true, accountRevision: () => 'offline', ledger: {
    async upsert() {}, async drain() { throw new Error('Offline ledger failure') } },
    provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { assert.fail('No judge during enrollment') } } } })
  subject.setTaskMode('plan')
  await subject.send('Ordinary read-only planning response')
  const f = controls(subject, true)
  await assert.rejects(selectApprovalMode(subject, f.io, async () => 'auto'), /healthy review ledger/)
  assert.equal(f.requests.length, 1); assert.equal(subject.taskMode, 'plan'); assert.equal(subject.approvalMode, 'manual')
  await subject.shutdown()
})

test('new and resumed hosts do not inherit Plan or approval authority from persisted conversation data', async () => {
  const store = persistence(), subject = host({ store })
  assert.equal(subject.taskMode, 'execute')
  subject.setTaskMode('plan'); await subject.send('Write an ordinary plan')
  const saved = store.snapshots.at(-1)
  assert(!Object.hasOwn(saved, 'taskMode')); assert(!Object.hasOwn(saved, 'approvalMode'))
  const resumed = host({ session: saved })
  assert.equal(resumed.taskMode, 'execute'); assert.equal(resumed.approvalMode, 'manual')
  await subject.shutdown(); await resumed.shutdown()
})
