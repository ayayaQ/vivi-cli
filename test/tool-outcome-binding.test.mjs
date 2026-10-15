// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliHost } from '../dist/host.js'
import { FileSessionStore } from '../dist/session.js'
import { TrustedCommandWorkspace, captureCommandEnvironment } from '../dist/commands.js'
import { cliHistoryToolPresentation } from '../dist/tool-presentation.js'
const settings = { provider: 'openai', model: 'offline-tool-binding-fixture' }
const signalTurn = () => new Promise(resolve => setImmediate(resolve))
const snapshot = (host, history = host.session.history, evidence = host.toolPresentationEvidence) =>
  cliHistoryToolPresentation(history, history.findLastIndex(message => message.kind === 'tool_result'), host.session.id, evidence)
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-tool-binding-'))
  const store = new FileSessionStore(join(directory, 'state'))
  const host = await CliHost.create({ settings, store, ...options })
  t.after(async () => { await host.shutdown(); await rm(directory, { recursive: true, force: true }) })
  return { host, directory }
}
async function twoReads(t) {
  let round = 0
  const { host } = await setup(t, { provider: { async generate() {
    return ++round <= 2 ? { content: '', toolCalls: [{ id: `binding-${round}`, name: 'calculate', arguments: { expression: `${round}+2` } }] }
      : { content: 'Done', toolCalls: [] }
  } } })
  await host.send('Calculate both fixture expressions')
  return host
}
test('moving an accepted call while preserving its result position cannot borrow projection evidence', async t => {
  const host = await twoReads(t), moved = host.session.history
  moved[1].toolCalls.push(moved[3].toolCalls.shift())
  assert.equal(snapshot(host, moved).status, 'unknown')
  assert.equal(snapshot(host, moved).effect, 'unreported')
})
test('a projection from another session cannot lend evidence through a matching outer wrapper', async t => {
  const host = await twoReads(t), evidence = host.toolPresentationEvidence
  evidence.projection.sessionId = 'foreign-session'
  evidence.decisions = []
  assert.equal(snapshot(host, host.session.history, evidence).effect, 'unreported')
})
test('cancelling inside an already delivered completion preserves the commit and emits completion once', async t => {
  let round = 0, completed = 0, host
  ;({ host } = await setup(t, { enableNotes: true, approve: async () => true,
    onEvent(event) { if (event.type === 'tool_completed') { completed++; host.cancel() } },
    provider: { async generate() { return ++round === 1 ? { content: '', toolCalls: [{ id: 'completion-once', name: 'note_set',
      arguments: { key: 'ordinary', value: 'fixture note', expectedRevision: 0 } }] } : { content: 'Done', toolCalls: [] } } }
  }))
  await host.send('Save the ordinary fixture note')
  assert.equal(completed, 1); assert.equal(host.session.noteRevision, 1)
  assert.equal(snapshot(host).status, 'succeeded'); assert.equal(snapshot(host).effect, 'confirmed')
})
test('late cancelled command preparation cannot mutate settled or replacement-turn evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-late-command-binding-'))
  const workspace = await TrustedCommandWorkspace.open(directory, captureCommandEnvironment(process.env))
  let release, entered
  const gate = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  const prepare = workspace.prepare.bind(workspace)
  t.mock.method(workspace, 'prepare', async (...args) => { const result = await prepare(...args); entered(); await gate; return result })
  let round = 0, approvals = 0
  const { host } = await setup(t, { commandWorkspace: workspace,
    commandApproval: { isAvailable: () => true, accountRevision: () => 'fixture-account' },
    approve: async () => { approvals++; return true }, provider: { async generate() { return ++round === 1
      ? { content: '', toolCalls: [{ id: 'late-command', name: 'command_start', arguments: { executable: process.execPath, args: ['--version'] } }] }
      : { content: 'Done', toolCalls: [] } } }
  })
  t.after(async () => { release(); await workspace.shutdown(); await rm(directory, { recursive: true, force: true }) })
  const sending = host.send('Prepare the inert version fixture')
  await started; host.cancel(); await sending
  const before = host.toolPresentationEvidence
  release(); await signalTurn(); await signalTurn()
  assert.equal(approvals, 0)
  assert.deepEqual(host.toolPresentationEvidence, before)
})
