// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliHost } from '../dist/host.js'
import { TrustedCommandWorkspace, COMMAND_TOOL_NAMES } from '../dist/commands.js'
import { newSession } from '../dist/session.js'
import { main, parseArguments } from '../dist/main.js'
import { runCommandControl } from '../dist/terminal.js'
import { ReadOnlyWorkspace } from '../dist/workspace.js'

async function fixture(t, input = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vivi-command-host-'))
  const commandWorkspace = await TrustedCommandWorkspace.open(root, process.env)
  const approvals = [], state = { available: true, account: 'fixture-account', judges: 0, rounds: 0 }
  const options = { session: newSession({ provider: 'openai', model: 'fixture' }), store: { async save() {} }, commandWorkspace,
    commandApproval: { isAvailable: () => state.available, accountRevision: () => state.account },
    async approve(request) { approvals.push(request); return input.approved ?? true },
    decisionReview: { canAutoReview: true, accountRevision: () => state.account,
      provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { state.judges++; throw new Error('Commands must never use model review') } },
      ledger: { async upsert() { throw new Error('Command metadata must not enter the note/memory review ledger') } } },
    provider: { async generate({ tools, messages }) {
      state.rounds++
      if (input.generate) return input.generate({ tools, messages, state })
      return { content: 'Fixture done', toolCalls: [] }
    } }, ...input.options }
  const host = new CliHost(options)
  t.after(async () => { await host.shutdown(); await rm(root, { recursive: true, force: true }) })
  return { root, host, options, commandWorkspace, state, approvals }
}
test('host command capability stays absent until separately enrolled and cannot be enabled by a model tool', async t => {
  const subject = await fixture(t, { generate({ tools, state }) {
    assert(!tools.some(tool => COMMAND_TOOL_NAMES.includes(tool.name)))
    return state.rounds === 1 ? { content: '', toolCalls: [{ id: 'invalid-enable', name: 'enable_trusted_commands', arguments: {} }] }
      : { content: 'Fixture done', toolCalls: [] }
  } })
  const result = await subject.host.send('Fixture request')
  assert.equal(subject.host.commandsEnabled, false); assert.equal(subject.approvals.length, 0)
  assert(result.history.find(message => message.kind === 'tool_result').isError)
})
for (const mode of ['manual', 'auto']) test(`actual ${mode} host always uses human approval for every command and supports bounded polling`, async t => {
  let subject
  subject = await fixture(t, { generate({ tools, messages, state }) {
    assert(tools.some(tool => tool.name === 'command_start'))
    assert(messages.some(message => message.role === 'system' && /unsandboxed/.test(message.content)))
    if (state.rounds === 1) return { content: '', toolCalls: [{ id: 'start', name: 'command_start', arguments: {
      executable: process.execPath, args: ['-e', 'console.log("started");setInterval(()=>{},1000)'], yieldMs: 0, timeoutMs: process.platform === 'win32' ? 5000 : 100 } }] }
    const result = JSON.parse(messages.at(-1).content)
    if (result.state === 'running') return { content: '', toolCalls: [{ id: `poll-${state.rounds}`, name: 'command_poll', arguments: { executionId: result.executionId, yieldMs: 2000 } }] }
    assert.equal(result.state, 'timed_out')
    return { content: 'Fixture done', toolCalls: [] }
  } })
  assert.equal(await subject.host.enableCommands(), true)
  subject.host.setApprovalMode(mode)
  assert.equal((await subject.host.send('Run the fixture')).status, 'completed')
  assert.equal(subject.state.judges, 0); assert.equal(subject.approvals.length, 2)
  assert.deepEqual(subject.approvals.map(request => request.call.name), ['enable_trusted_commands', 'command_start'])
  assert(!subject.host.session.history.some(message => message.role === 'system'))
})
test('a finished run cannot reuse an execution ID in the next run', async t => {
  let previous
  const subject = await fixture(t, { generate({ messages, state }) {
    if (state.rounds === 1) return { content: '', toolCalls: [{ id: 'first', name: 'command_start', arguments: {
      executable: process.execPath, args: ['-e', 'console.log("first")'], yieldMs: 1000 } }] }
    if (state.rounds === 2) { previous = JSON.parse(messages.at(-1).content).executionId; return { content: 'Done', toolCalls: [] } }
    if (state.rounds === 3) return { content: '', toolCalls: [{ id: 'old-poll', name: 'command_poll', arguments: { executionId: previous } }] }
    assert(messages.at(-1).isError); return { content: 'Done', toolCalls: [] }
  } })
  await subject.host.enableCommands(); await subject.host.send('First fixture'); await subject.host.send('Second fixture')
  assert.equal(subject.approvals.length, 2)
})
test('new and resumed hosts never restore trust from a saved session or a reused workspace object', async t => {
  const subject = await fixture(t); await subject.host.enableCommands()
  const next = new CliHost({ ...subject.options, session: newSession({ provider: 'openai', model: 'fixture' }),
    provider: { async generate() { return { content: 'Done', toolCalls: [] } } } })
  t.after(() => next.shutdown())
  assert.equal(next.commandsEnabled, false)
  await assert.rejects(subject.commandWorkspace.start({ id: 'wrong-owner', name: 'command_start', arguments: {
    executable: process.execPath, args: [] } }, { launchId: 'different-launch', sessionId: next.session.id, runId: 'fixture', accountRevision: 'fixture-account',
      isCurrent: () => true, canApprove: () => true, approve: async () => true }, new AbortController().signal), /interactive human approval/)
  const freshCapability = await TrustedCommandWorkspace.open(subject.root, process.env)
  const resumed = await CliHost.resume({ ...subject.options, commandWorkspace: freshCapability, id: subject.host.session.id,
    store: { async save() {}, async load() { return subject.host.session } } })
  t.after(() => resumed.shutdown()); assert.equal(resumed.commandsEnabled, false)
  const reused = await CliHost.resume({ ...subject.options, id: subject.host.session.id,
    store: { async save() {}, async load() { return subject.host.session } },
    provider: { async generate({ tools }) { assert(!tools.some(tool => COMMAND_TOOL_NAMES.includes(tool.name))); return { content: 'Done', toolCalls: [] } } } })
  t.after(() => reused.shutdown()); assert.equal(reused.commandsEnabled, false)
  await reused.send('Fixture continuation')
  assert.equal(subject.approvals.length, 1)
})
test('command flags are launch-only enrollment requests and piped/headless allow callbacks cannot grant trust', async t => {
  const subject = await fixture(t)
  const options = parseArguments(['--model', 'fixture', '--enable-commands'], {}, false, subject.root)
  assert.equal(options.enableCommands, true)
  const io = { output: '', write(value) { this.output += value }, canAutoReview: false, onCancel() { return () => {} } }
  assert.equal(await runCommandControl(subject.host, io, '/commands on'), true)
  assert.equal(subject.approvals.length, 0); assert.equal(subject.host.commandsEnabled, false)
  const appIO = { ...io, async readLine() {}, event() {}, result() {}, async approve() { throw new Error('No headless approval') }, close() {} }
  const status = await main(['--model', 'fixture', '--tools', '--enable-commands', '--no-tui', '--session-dir', join(subject.root, 'state'), '--prompt', 'Fixture'], {},
    { io: appIO, launchDirectory: subject.root, providerFactory: () => ({ async generate({ tools }) {
      assert(!tools.some(tool => COMMAND_TOOL_NAMES.includes(tool.name))); return { content: 'Done', toolCalls: [] }
    } }) })
  assert.equal(status, 0); assert.match(appIO.output, /interactive human approval/)
})
test('disabled commands cannot expand a chat-only host and shutdown disables existing trust', async t => {
  const subject = await fixture(t, { options: { enableTools: false } })
  assert.equal(await subject.host.enableCommands(), false)
  subject.options.enableTools = true; assert.equal(await subject.host.enableCommands(), true)
  await subject.host.shutdown(); assert.equal(subject.host.commandsEnabled, false)
})
test('disabled command-only environment validation cannot break ordinary chat startup', async t => {
  const subject = await fixture(t), io = { output: '', write(value) { this.output += value }, async readLine() {},
    event() {}, result() {}, approve: async () => { throw new Error('No command approval expected') }, onCancel: () => () => {}, close() {} }
  let requests = 0
  const status = await main(['--model', 'fixture', '--no-tools', '--no-tui', '--session-dir', join(subject.root, 'state'), '--prompt', 'Fixture'],
    { INTERNAL_API_TOKEN: 'fixture-private-value', PATH: '/fixture-private-value/bin', SystemRoot: 'relative', PSModulePath: 'C:\\private-user-modules' },
    { io, launchDirectory: subject.root, providerFactory: () => ({ async generate({ tools }) { requests++; assert.deepEqual(tools, []); return { content: 'Done', toolCalls: [] } } }) })
  assert.equal(status, 0); assert.equal(requests, 1)
})
test('shutdown during lazy creation cannot resurrect command trust or prompt after shutdown', async t => {
  const subject = await fixture(t)
  let resolveOpening, opened
  const began = new Promise(resolve => { opened = resolve })
  const host = new CliHost({ ...subject.options, commandWorkspace: undefined,
    commandWorkspaceFactory: () => { opened(); return new Promise(resolve => { resolveOpening = resolve }) } })
  const pending = host.enableCommands()
  await began; await host.shutdown(); resolveOpening(subject.commandWorkspace)
  await assert.rejects(pending, /no longer active/)
  assert.equal(host.commandsEnabled, false); assert.equal(subject.approvals.length, 0)
  await assert.rejects(host.enableCommands(), /shut down/)
  await assert.rejects(host.send('Fixture'), /shut down/)
})
test('enable after shutdown does not invoke a dormant capability factory', async t => {
  const subject = await fixture(t); let openings = 0
  const host = new CliHost({ ...subject.options, commandWorkspace: undefined,
    commandWorkspaceFactory: async () => { openings++; return subject.commandWorkspace } })
  await host.shutdown(); await assert.rejects(host.enableCommands(), /shut down/)
  assert.equal(openings, 0); assert.equal(subject.approvals.length, 0)
})
test('disable during lazy creation revokes the pending enrollment and permits a fresh retry', async t => {
  const subject = await fixture(t)
  let resolveOpening, opened, openings = 0
  const began = new Promise(resolve => { opened = resolve })
  const host = new CliHost({ ...subject.options, commandWorkspace: undefined,
    commandWorkspaceFactory: async () => {
      if (++openings === 1) { opened(); return new Promise(resolve => { resolveOpening = resolve }) }
      return TrustedCommandWorkspace.open(subject.root, process.env)
    } })
  t.after(() => host.shutdown())
  const pending = host.enableCommands()
  await began; await host.disableCommands(); resolveOpening(subject.commandWorkspace)
  await assert.rejects(pending, /no longer active/)
  assert.equal(host.commandsEnabled, false); assert.equal(subject.approvals.length, 0)
  assert.equal(await host.enableCommands(), true)
  assert.equal(openings, 2); assert.equal(subject.approvals.length, 1)
})
test('integrated Auto workspace creation keeps the following command on fresh human approval', async t => {
  const subject = await fixture(t, { generate({ messages, state }) {
    if (state.rounds === 1) return { content: '', toolCalls: [{ id: 'create', name: 'workspace_create_text', arguments: { path: 'created.txt', content: 'fixture text' } }] }
    if (state.rounds === 2) return { content: '', toolCalls: [{ id: 'start', name: 'command_start', arguments: {
      executable: process.execPath, args: ['-e', 'console.log(require("node:fs").readFileSync("created.txt","utf8"))'], yieldMs: 1000 } }] }
    const result = JSON.parse(messages.at(-1).content)
    if (result.state === 'running') return { content: '', toolCalls: [{ id: `poll-${state.rounds}`, name: 'command_poll', arguments: { executionId: result.executionId, yieldMs: 2000 } }] }
    assert.equal(result.state, 'exited'); return { content: 'Done', toolCalls: [] }
  } })
  subject.options.workspace = await ReadOnlyWorkspace.open(subject.root)
  subject.options.decisionReview.ledger = { async upsert() {} }
  subject.options.decisionReview.provider.evaluate = async request => {
    subject.state.judges++; assert.equal(request.snapshot.toolCall.name, 'workspace_create_text')
    return { model: 'gpt-6-luna', answers: request.policy.checks.map(check => ({ name: check.name, type: 'predicate', probability: 1 })),
      usage: { inputTokens: 1, outputTokens: 1 } }
  }
  await subject.host.enableCommands(); subject.host.setApprovalMode('auto')
  assert.equal((await subject.host.send('Create created.txt with fixture text and run the controlled fixture')).status, 'completed')
  assert.equal(subject.state.judges, 1)
  assert.deepEqual(subject.approvals.map(request => request.call.name), ['enable_trusted_commands', 'command_start'], subject.approvals[1]?.description)
})
