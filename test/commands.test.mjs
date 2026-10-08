// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rename, rm, writeFile, chmod } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { TrustedCommandWorkspace, commandEnvironment, COMMAND_LIMITS, COMMAND_DISCLOSURE } from '../dist/commands.js'
import { routePreparedAction } from '@ayayaq/vivi/decisions'
import { createBuiltinToolset } from '../dist/tools.js'

async function fixture(t, { secrets = [], available = true, approved = true, approval } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vivi-command-fixture-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = await TrustedCommandWorkspace.open(root, process.env, secrets)
  t.after(() => workspace.shutdown())
  const state = { available, approved, active: true, account: 'fixture-account', approvals: [] }
  const context = { launchId: 'fixture-launch', sessionId: 'fixture-session', runId: 'fixture-run', get accountRevision() { return state.account },
    canApprove: () => state.available, isCurrent: () => state.active,
    async approve(request, signal) { state.approvals.push(request); return await approval?.(request, state, signal) ?? state.approved } }
  return { root, workspace, state, context, signal: new AbortController().signal }
}
const call = (args, id = 'fixture-start') => ({ id, name: 'command_start', arguments: { executable: process.execPath,
  args: ['--input-type=module', '-e', 'console.log("fixture-output")'], yieldMs: 1000, ...args } })
const parse = result => JSON.parse(result.content)
async function terminal(subject, result) {
  let value = parse(result)
  while (value.state === 'running') {
    const next = parse(await subject.workspace.poll(value.executionId, 'fixture-launch:fixture-session:fixture-run', 2000))
    next.output = value.output + next.output; value = next
  }
  return value
}
async function enable(subject) { assert.equal(await subject.workspace.enable(subject.context, subject.signal), true) }

test('command environment is a fixed allowlist and never forwards provider keys, HOME or blanket host values', () => {
  const env = commandEnvironment({ PATH: '/fixture/bin', LANG: 'C.UTF-8', HOME: '/private/home', USERPROFILE: 'C:\\private',
    OPENAI_API_KEY: 'fixture-provider-key', OPENROUTER_API_KEY: 'another-key', VIVI_SAVED_KEY: 'key', NODE_OPTIONS: '--inspect',
    AWS_ACCESS_KEY_ID: 'cloud-key', arbitrary: 'private' })
  assert.deepEqual({ ...env }, { PATH: '/fixture/bin', LANG: 'C.UTF-8' }); assert(Object.isFrozen(env))
  assert.throws(() => commandEnvironment({ PATH: '/fixture/key-value' }, ['key-value']), /known credential/)
  assert.match(COMMAND_DISCLOSURE, /unsandboxed/); assert.match(COMMAND_DISCLOSURE, /credential files/)
})
test('commands are off by default, and unavailable approval surfaces cannot enable them', async t => {
  const subject = await fixture(t, { available: false })
  assert.equal(subject.workspace.isEnabled, false)
  assert.equal(await subject.workspace.enable(subject.context, subject.signal), false)
  assert.equal(subject.state.approvals.length, 0)
  await assert.rejects(subject.workspace.start(call(), subject.context, subject.signal), /interactive human approval/)
})
test('trust enrollment is bound to session/account and cannot be reused by another session', async t => {
  const subject = await fixture(t); await enable(subject)
  await assert.rejects(subject.workspace.start(call(), { ...subject.context, sessionId: 'another-session' }, subject.signal), /interactive human approval/)
  subject.state.account = 'different-account'
  await assert.rejects(subject.workspace.start(call(), subject.context, subject.signal), /interactive human approval/)
  assert.equal(subject.state.approvals.length, 1)
})
test('disabling commands during pending enrollment cannot resurrect permission', async t => {
  let subject
  subject = await fixture(t, { approval: async () => { await subject.workspace.disable(); return true } })
  await assert.rejects(subject.workspace.enable(subject.context, subject.signal), /enrollment changed/)
  assert.equal(subject.workspace.isEnabled, false)
})
test('every new command is human-reviewed with resolved executable, argv, cwd, env names and timeout', async t => {
  const subject = await fixture(t); await enable(subject)
  const prepared = await subject.workspace.prepare(call().arguments)
  const metadata = prepared.preparedAction
  assert.deepEqual(metadata.effects.map(effect => effect.review), ['manual']); assert.equal(metadata.complete, false)
  assert.equal(routePreparedAction({ sessionId: 'fixture', runId: 'fixture', toolCall: call(),
    userRequest: { id: 'fixture', text: 'fixture', approvedScope: {} }, policyRevision: 'fixture',
    resourceRevisions: { [metadata.effects[0].resourceId]: 'fixture' }, inputData: {}, preparedAction: metadata }).route, 'manual')
  for (const id of ['one', 'two']) {
    const result = await terminal(subject, await subject.workspace.start(call({}, id), subject.context, subject.signal))
    assert.equal(result.state, 'exited'); assert.equal(result.exitCode, 0); assert.match(result.output, /fixture-output/)
    assert.equal(parse(await subject.workspace.poll(result.executionId, 'fixture-launch:fixture-session:fixture-run')).output, '')
  }
  assert.equal(subject.state.approvals.length, 3)
  const approval = subject.state.approvals[1]
  for (const label of ['Executable:', 'Arguments:', 'Working directory:', 'Environment names:', 'Hard timeout:', 'shell:false']) assert(approval.description.includes(label))
  assert(approval.description.includes(JSON.stringify(subject.workspace.directory))); assert(approval.description.includes('fixture-output'))
})
test('denial cannot launch, duplicate proposals cannot launch, and IDs are scoped to the current run', async t => {
  const subject = await fixture(t); await enable(subject); subject.state.approved = false
  assert.equal(parse(await subject.workspace.start(call(), subject.context, subject.signal)).error.code, 'approval_denied')
  await assert.rejects(subject.workspace.start(call(), subject.context, subject.signal), /already been used/)
  subject.state.approved = true
  const result = parse(await subject.workspace.start(call({}, 'new-command'), subject.context, subject.signal))
  await assert.rejects(subject.workspace.poll(result.executionId, 'fixture-launch:fixture-session:another-run'), /unavailable/)
  await subject.workspace.endRun()
  await assert.rejects(subject.workspace.poll(result.executionId, 'fixture-launch:fixture-session:fixture-run'), /unavailable/)
  assert.equal(subject.workspace.isEnabled, true)
})
for (const change of ['call', 'approval', 'account', 'surface', 'run', 'new-secret', 'cwd']) {
  test(`a changed ${change} during human command approval cannot start a process`, async t => {
    let subject, proposal
    subject = await fixture(t, { secrets: [], approval: async (request, state) => {
      if (request.call.name !== 'command_start') return true
      if (change === 'call') proposal.arguments.args.push('changed')
      if (change === 'approval') request.description += 'changed'
      if (change === 'account') state.account = 'changed'
      if (change === 'surface') state.available = false
      if (change === 'run') state.active = false
      if (change === 'new-secret') subject.secrets.push('fixture-output')
      if (change === 'cwd') { await rename(join(subject.root, 'cwd'), join(subject.root, 'old-cwd')); await mkdir(join(subject.root, 'cwd')) }
      return true
    } })
    subject.secrets = []
    if (change === 'new-secret') {
      await subject.workspace.shutdown()
      subject.workspace = await TrustedCommandWorkspace.open(subject.root, process.env, subject.secrets)
      t.after(() => subject.workspace.shutdown())
    }
    await mkdir(join(subject.root, 'cwd')); await enable(subject)
    proposal = call({ cwd: 'cwd' })
    await assert.rejects(subject.workspace.start(proposal, subject.context, subject.signal), /changed|credential/)
  })
}
test('hard timeout is separate from the yield interval and stops a running process', async t => {
  const subject = await fixture(t); await enable(subject)
  const initial = parse(await subject.workspace.start(call({ args: ['-e', 'setInterval(()=>{},1000)'], yieldMs: 0, timeoutMs: process.platform === 'win32' ? 5000 : 50 }), subject.context, subject.signal))
  assert.equal(initial.state, 'running')
  const final = await terminal(subject, { content: JSON.stringify(initial) })
  assert.equal(final.state, 'timed_out')
})
test('stop requires no new approval and shutdown revokes execution IDs', async t => {
  const subject = await fixture(t); await enable(subject)
  const initial = parse(await subject.workspace.start(call({ args: ['-e', 'setInterval(()=>{},1000)'], yieldMs: 0 }), subject.context, subject.signal))
  assert.equal(parse(await subject.workspace.stop(initial.executionId, 'fixture-launch:fixture-session:fixture-run')).state, 'cancelled')
  assert.equal(subject.state.approvals.length, 2)
  await subject.workspace.shutdown()
  await assert.rejects(subject.workspace.poll(initial.executionId, 'fixture-launch:fixture-session:fixture-run'), /unavailable/)
})
test('cancellation waits for process cleanup before publishing a terminal state', async t => {
  const subject = await fixture(t); await enable(subject)
  const controller = new AbortController()
  const initial = parse(await subject.workspace.start(call({ args: ['-e', 'setInterval(()=>{},1000)'], yieldMs: 0 }), subject.context, controller.signal))
  controller.abort()
  const result = await terminal(subject, { content: JSON.stringify(initial) })
  assert.equal(result.state, 'cancelled'); assert(Object.hasOwn(result, 'exitCode'))
})
test('changing the resolved executable during approval requires a fresh approval', async t => {
  const subject = await fixture(t)
  const executable = join(subject.root, process.platform === 'win32' ? 'fixture.exe' : 'fixture-command')
  await writeFile(executable, 'controlled non-running fixture'); await chmod(executable, 0o755)
  await enable(subject)
  subject.context.approve = async () => { await writeFile(executable, 'changed controlled fixture bytes'); return true }
  await assert.rejects(subject.workspace.start(call({ executable, args: [] }), subject.context, subject.signal), /Executable or working directory changed/)
})
test('streamed credentials split across writes are redacted; inherited environment omits saved keys', async t => {
  const key = 'fixture-provider-secret', subject = await fixture(t, { secrets: [key] }); await enable(subject)
  const script = join(subject.root, 'fixture.mjs')
  await writeFile(script, `process.stdout.write('fixture-provider-');setTimeout(()=>{process.stdout.write('secret\\n');console.log(JSON.stringify(process.env))},20)`)
  const result = await terminal(subject, await subject.workspace.start(call({ args: [script] }), subject.context, subject.signal))
  assert.equal(result.state, 'exited'); assert(!result.output.includes(key)); assert(result.output.includes('[REDACTED]'))
  assert(!result.output.includes('OPENAI_API_KEY')); assert(!result.output.includes('HOME'))
})
test('a known credential prefix held at stream end is withheld rather than exposed', async t => {
  const subject = await fixture(t, { secrets: ['fixture-long-provider-secret'] }); await enable(subject)
  const script = join(subject.root, 'partial.mjs')
  await writeFile(script, `process.stdout.write('fixture-long-provider-')`)
  const result = await terminal(subject, await subject.workspace.start(call({ args: [script] }), subject.context, subject.signal))
  assert.equal(result.output, '[REDACTED]')
})
test('pending output is bounded and total output overflow stops the process', async t => {
  const subject = await fixture(t); await enable(subject)
  const initial = await terminal(subject, await subject.workspace.start(call({ args: ['-e', 'process.stdout.write("x".repeat(2*1024*1024));setInterval(()=>{},1000)'], yieldMs: 1000 }), subject.context, subject.signal))
  assert.equal(initial.state, 'output_limit'); assert(initial.truncated)
  assert(Buffer.byteLength(initial.output) <= COMMAND_LIMITS.maximumPendingBytes)
})
test('argv is passed literally without quote concatenation or automatic shell expansion', async t => {
  const subject = await fixture(t); await enable(subject)
  const args = ['spaces here', 'quotes"and\\slashes\\', '$HOME', '; echo redirected', 'trailing\\', '', '😀']
  const result = await terminal(subject, await subject.workspace.start(call({ args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args] }), subject.context, subject.signal))
  assert.deepEqual(JSON.parse(result.output.trim()), args)
})
test('approval display escapes formatting/control characters without changing executed arguments', async t => {
  const subject = await fixture(t); await enable(subject)
  const args = ['bidi\u202ehere', 'c1\u009bhere', 'zero\u200bwidth', 'line\u2028separator', '\u180e', '\u{e0001}', '\u{e0061}', '\u034f', '\ufe0f']
  const result = await terminal(subject, await subject.workspace.start(call({ args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args] }), subject.context, subject.signal))
  assert.deepEqual(JSON.parse(result.output.trim()), args)
  const description = subject.state.approvals.at(-1).description
  for (const character of ['\u202e', '\u009b', '\u200b', '\u2028', '\u180e', '\u{e0001}', '\u{e0061}', '\u034f', '\ufe0f']) assert(!description.includes(character))
  for (const escaped of ['\\u202e', '\\u009b', '\\u200b', '\\u2028', '\\u180e', '\\udb40\\udc01', '\\udb40\\udc61', '\\u034f', '\\ufe0f']) assert(description.includes(escaped))
})
test('relative executables resolve before approval against cwd; bare executables use only captured absolute PATH entries', async t => {
  const subject = await fixture(t); await enable(subject)
  const absolute = await subject.workspace.prepare(call().arguments)
  const fromPath = await subject.workspace.prepare({ ...call().arguments, executable: basename(process.execPath) })
  assert.equal(fromPath.executable, absolute.executable)
  await assert.rejects(subject.workspace.prepare({ ...call().arguments, cwd: '..' }), /inside/)
  await assert.rejects(subject.workspace.prepare({ ...call().arguments, environment: {} }), /Unexpected/)
  await assert.rejects(subject.workspace.prepare({ ...call().arguments, timeoutMs: 0 }), /milliseconds/)
  const result = parse(await subject.workspace.start(call(), subject.context, subject.signal))
  await assert.rejects(subject.workspace.poll(result.executionId, 'fixture-launch:fixture-session:fixture-run', COMMAND_LIMITS.maximumYieldMs + 1), /milliseconds/)
})
test('caller extensions cannot impersonate command tools, even while commands are disabled', () => {
  for (const name of ['command_start', 'command_poll', 'command_stop']) assert.throws(() => createBuiltinToolset(false, [{
    id: 'fixture', apiVersion: 1, tools: [{ definition: { name, description: 'fixture', parameters: {} }, validateArguments() {}, execute() { return { content: '' } } }]
  }]), /Tool name collision/)
})
