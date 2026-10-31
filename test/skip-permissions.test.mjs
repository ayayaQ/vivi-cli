// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { AutoReviewController } from '../dist/auto-review.js'
import { CliHost } from '../dist/host.js'
import { newSession, SessionCommitError } from '../dist/session.js'
import { TrustedCommandWorkspace } from '../dist/commands.js'
import { runModeControl, selectApprovalMode, SKIP_PERMISSIONS_DISCLOSURE } from '../dist/terminal.js'
import { conversationModeLabel } from '../dist/task-mode.js'

function controllerFixture({ eligible = true, review = 'model-review', secret = false, configuredReviewer = false } = {}) {
  const state = { binding: 'chat-account:workspace:trust-v1', available: true, human: 0, reviews: 0, audits: 0, commits: 0, notices: [], secrets: [] }
  const controller = new AutoReviewController(configuredReviewer ? { canAutoReview: true, accountRevision: () => 'independent-reviewer',
    provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { state.reviews++; throw new Error('Skip must not call a reviewer') } },
    ledger: { async drain() { throw new Error('Offline reviewer audit unavailable') }, async upsert() { state.audits++; throw new Error('Skip must not invent a model audit') } } } : undefined,
    () => state.secrets, async () => { state.human++; return false }, (message, context) => state.notices.push({ message, context }),
    { isAvailable: () => state.available, binding: () => state.binding })
  controller.beginTurn('session-one', 'Save the task note')
  const proposal = { approval: { call: { id: 'one', name: 'note_set', arguments: { key: 'task', value: secret ? 'fixture-credential' : 'blue', expectedRevision: 0 } },
      currentRevision: 0, description: 'Prepared task note' }, eligible: true, skipEligible: eligible,
    inputData: { before: null, after: secret ? 'fixture-credential' : 'blue' }, resourceRevisions: { note: 0 }, currentResourceRevisions: () => ({ note: 0 }),
    preparedAction: { complete: true, effects: [{ kind: 'write', resourceId: 'note', scope: 'outside-workspace', affectedData: {}, review }] }, isActive: () => true }
  if (secret) state.secrets.push('fixture-credential')
  const execute = onCommit => controller.execute(proposal, new AbortController().signal, async guard => { await onCommit?.(); guard(); state.commits++; return 'saved' })
  return { state, controller, proposal, execute }
}

test('Skip is explicit, ephemeral and independent of reviewer configuration or credentials', async () => {
  for (const configuredReviewer of [false, true]) {
    const f = controllerFixture({ configuredReviewer })
    assert.equal(f.controller.mode, 'manual')
    f.controller.setMode('skip')
    assert.equal(await f.execute(), 'saved')
    assert.equal(f.state.human, 0); assert.equal(f.state.reviews, 0); assert.equal(f.state.audits, 0)
    assert(f.state.notices.every(notice => notice.context.source === 'skip' && notice.context.evaluation === undefined))
    assert.match(f.state.notices.at(-1).message, /without human or AI review/)
    await assert.rejects(f.execute(), /already been admitted/)
    assert.equal(controllerFixture().controller.mode, 'manual')
  }
})

test('reviewer audit unavailability does not prevent independent Skip enrollment', async () => {
  const f = controllerFixture({ configuredReviewer: true })
  await f.controller.drain()
  assert.throws(() => f.controller.setMode('auto'), /healthy review ledger/)
  f.controller.setMode('skip')
  assert.equal(await f.execute(), 'saved')
  assert.equal(f.state.human, 0); assert.equal(f.state.reviews, 0); assert.equal(f.state.audits, 0)
})

test('unconfirmed local persistence revokes Skip and cannot be reset through fresh enrollment', async () => {
  const f = controllerFixture(); f.controller.setMode('skip')
  await assert.rejects(f.execute(async () => { throw new SessionCommitError(new Error('Offline durability fixture')) }), /durable persistence/)
  assert.equal(f.controller.mode, 'manual')
  assert.throws(() => f.controller.setMode('skip'), /healthy host state/)
  const replacement = controllerFixture().controller
  replacement.retainUncertainResource(f.controller)
  assert.throws(() => replacement.setMode('skip'), /healthy host state/)
})

test('Skip preserves hard route blocks, known-secret protection and host eligibility', async () => {
  for (const config of [{ review: 'blocked' }, { secret: true }, { eligible: false }]) {
    const f = controllerFixture(config); f.controller.setMode('skip')
    assert.equal(await f.execute(), undefined)
    assert.equal(f.state.commits, 0); assert.equal(f.state.reviews, 0); assert.equal(f.state.audits, 0)
    assert.equal(f.state.human, config.eligible === false ? 1 : 0)
  }
})

test('Skip revokes on account/trust or surface changes and rejects stale in-flight admission', async () => {
  for (const change of ['binding', 'surface', 'mode', 'credential']) {
    const f = controllerFixture(); f.controller.setMode('skip')
    await assert.rejects(f.execute(async () => {
      if (change === 'binding') f.state.binding = 'chat-account:workspace:trust-v2'
      if (change === 'surface') f.state.available = false
      if (change === 'mode') f.controller.setMode('manual')
      if (change === 'credential') f.state.secrets.push('blue')
    }), /stale|known credential/)
    assert.equal(f.state.commits, 0)
    if (change !== 'credential') assert.equal(f.controller.mode, 'manual')
  }
  const unavailable = controllerFixture(); unavailable.state.available = false
  assert.throws(() => unavailable.controller.setMode('skip'), /interactive/)
})

function enrollmentFixture({ plan = false, interactive = true, approve = true } = {}) {
  let task = plan ? 'plan' : 'execute', mode = 'manual', revision = 0
  const host = { session: newSession({ provider: 'openai', model: 'offline-skip' }),
    get taskMode() { return task }, get approvalMode() { return mode }, get approvalEnrollmentBinding() { return `binding-${revision}` },
    setTaskMode(value) { task = value; revision++; if (value === 'plan') mode = 'manual' },
    setApprovalMode(value) { mode = value; revision++ } }
  const io = { canAutoReview: interactive, isClosed: false, requests: [], output: '', write(value) { this.output += value },
    onCancel(callback) { this.cancel = callback; return () => {} }, setTaskMode() {}, setApprovalMode() {},
    async approve(request) { this.requests.push(request); return typeof approve === 'function' ? approve(host, this) : approve } }
  return { host, io }
}

test('explicit Skip enrollment warns once, needs no reviewer and is accurately labeled', async () => {
  const f = enrollmentFixture()
  await runModeControl(f.host, f.io, '/mode skip')
  assert.equal(f.host.approvalMode, 'skip')
  assert.equal(f.io.requests.length, 1); assert.equal(f.io.requests[0].call.name, 'enroll_skip_permissions')
  assert.equal(f.io.requests[0].description, SKIP_PERMISSIONS_DISCLOSURE)
  for (const wording of ['no human or AI review', 'paid web', 'already-connected MCP', 'unsandboxed', 'credential files', 'does not grant OS privileges', 'not saved']) {
    assert(SKIP_PERMISSIONS_DISCLOSURE.toLowerCase().includes(wording.toLowerCase()), wording)
  }
  assert.equal(conversationModeLabel('execute', 'skip'), 'Skip permissions')
  assert.equal(conversationModeLabel('plan', 'skip'), 'Plan')
  assert(!f.io.output.includes('Automatically approved'))
})

test('Skip cancellation/denial/headless or stale confirmation preserves Plan and cannot grant authority', async () => {
  for (const input of [{ approve: false }, { interactive: false }, { approve: (_host, io) => { io.cancel(); return true } },
    { approve: (_host, io) => { io.isClosed = true; return true } }, { approve: host => { host.setTaskMode('plan'); return true } }]) {
    const f = enrollmentFixture({ plan: true, ...input })
    await selectApprovalMode(f.host, f.io, async () => 'skip')
    assert.equal(f.host.taskMode, 'plan'); assert.equal(f.host.approvalMode, 'manual')
  }
  const f = enrollmentFixture({ plan: true })
  await selectApprovalMode(f.host, f.io, async () => 'skip')
  assert.equal(f.host.taskMode, 'execute'); assert.equal(f.host.approvalMode, 'skip')
})

async function commandFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vivi-skip-command-'))
  const state = { account: 'chat-account-v1', available: true, approvals: [], processes: [], rounds: 0 }
  const launch = async () => {
    let done
    const stdout = new PassThrough(), stderr = new PassThrough(), completed = new Promise(resolve => { done = resolve })
    const process = { stops: 0 }; state.processes.push(process)
    return { stdout, stderr, completed, async stop() { process.stops++; stdout.end(); stderr.end(); done({ exitCode: null, signal: 'SIGKILL' }) } }
  }
  // Exact minimal fixture environment: no saved provider keys or machine-local PATH assumptions.
  const environment = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' } : {}
  const workspace = await TrustedCommandWorkspace.open(root, environment, [], launch)
  const approval = { accountRevision: () => state.account, isAvailable: () => state.available }
  const options = { commandWorkspace: workspace, commandApproval: approval, permissionApproval: approval,
    session: newSession({ provider: 'openai', model: 'offline-skip' }), store: { async save() {} },
    async approve(request) { state.approvals.push(request); return false },
    provider: { async generate() { return ++state.rounds === 1 ? { content: '', toolCalls: [{ id: 'background', name: 'command_start', arguments: {
      executable: process.execPath, args: ['-e', 'fixture'], background: true, yieldMs: 0 } }] } : { content: 'Done', toolCalls: [] } } } }
  const host = new CliHost(options)
  t.after(async () => { await host.shutdown(); await rm(root, { recursive: true, force: true }) })
  return { host, state, options }
}

test('Skip starts and restarts controlled background commands without prompts, with cleanup and account revocation intact', async t => {
  const f = await commandFixture(t)
  f.host.setApprovalMode('skip')
  assert.equal((await f.host.send('Start the controlled background fixture')).status, 'completed')
  assert.equal(f.state.processes.length, 1); assert.equal(f.state.approvals.length, 0)
  const first = f.host.listBackgroundCommands()[0]
  const replacement = JSON.parse((await f.host.restartBackgroundCommand(first.executionId)).content)
  assert.notEqual(replacement.executionId, first.executionId)
  assert.equal(f.state.processes[0].stops, 1); assert.equal(f.state.approvals.length, 0)
  f.state.account = 'chat-account-v2'
  assert.equal(f.host.approvalMode, 'manual')
  await f.host.send('Continue after account switch')
  assert.equal(f.state.processes[1].stops, 1); assert.equal(f.host.commandsEnabled, false)
  await assert.rejects(f.host.restartBackgroundCommand(replacement.executionId))
  const fresh = new CliHost({ ...f.options, session: f.host.session })
  t.after(() => fresh.shutdown())
  assert.equal(fresh.approvalMode, 'manual')
})

test('Plan, disable and explicit host revocation remove Skip without replaying a pending action', async t => {
  const f = await commandFixture(t)
  f.host.setApprovalMode('skip'); f.host.setTaskMode('plan')
  assert.equal(f.host.approvalMode, 'manual')
  f.host.setTaskMode('execute'); assert.equal(f.host.approvalMode, 'manual')
  f.host.setApprovalMode('skip'); f.host.revokeApprovalEnrollment()
  assert.equal(f.host.approvalMode, 'manual')
  f.host.setApprovalMode('skip'); await f.host.disableCommands()
  assert.equal(f.host.approvalMode, 'manual'); assert.equal(f.state.processes.length, 0)
})
