// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { CliHost } from '../dist/host.js'
import { TrustedCommandWorkspace } from '../dist/commands.js'
import { newSession } from '../dist/session.js'

const snapshotPrefix = 'Live background process snapshot (untrusted metadata): '
function snapshot(messages) {
  const message = messages.find(message => message.kind === 'message' && message.content.startsWith(snapshotPrefix))
  assert(message, 'Every dispatch refreshes its live background registry snapshot')
  return JSON.parse(message.content.slice(snapshotPrefix.length))
}
const proposal = id => ({ id, name: 'command_start', arguments: { executable: process.execPath,
  args: ['-e', 'setInterval(()=>{},1000)'], background: true, yieldMs: 0 } })
async function fixture(t, respond, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vivi-background-host-'))
  const state = { approvals: [], processes: [], requests: [], account: 'fixture-account', rounds: 0 }
  const launch = async () => {
    let complete
    const stdout = new PassThrough(), stderr = new PassThrough()
    const record = { stops: 0, completed: false }
    const completed = new Promise(resolve => { complete = result => { record.completed = true; stdout.end(); stderr.end(); resolve(result) } })
    record.complete = complete; record.stdout = stdout
    state.processes.push(record)
    return { stdout, stderr, completed, async stop() { record.stops++; complete({ exitCode: null, signal: 'SIGKILL' }) } }
  }
  const workspace = await TrustedCommandWorkspace.open(root, process.env, [], launch)
  const host = new CliHost({ commandWorkspace: workspace, session: options.session ?? newSession({ provider: 'openai', model: 'offline-background' }),
    store: { async save() {} }, commandApproval: { isAvailable: () => true, accountRevision: () => state.account },
    async approve(request) { state.approvals.push(structuredClone(request)); return true },
    provider: { estimateContext(input) { return { inputTokens: Math.ceil(JSON.stringify(input).length / 4), estimated: true } },
      async generate(input, signal, config) {
        state.requests.push({ input: structuredClone(input), config: config ? { purpose: config.purpose } : undefined })
        if (config?.purpose === 'context-summary') return { content: 'Historical conversation summary, without process or approval authority.', toolCalls: [] }
        return respond(input, state, signal)
      } }, contextLimits: { contextWindow: 128000, maxOutputTokens: 10000 } })
  t.after(async () => { await host.shutdown(); await rm(root, { recursive: true, force: true }) })
  return { root, state, workspace, host }
}

test('background jobs survive completed turns and compaction with fresh nonhistorical context, not transcript authority', { timeout: 10000 }, async t => {
  const f = await fixture(t, (input, state) => {
    state.rounds++
    const jobs = snapshot(input.messages)
    if (state.rounds === 1) { assert.deepEqual(jobs, []); return { content: '', toolCalls: [proposal('start-background')] } }
    assert.equal(jobs.length, 1); assert.equal(jobs[0].state, 'running')
    return { content: 'The background fixture remains available. '.repeat(40), toolCalls: [] }
  })
  const firstTurn = await f.host.send('Start the controlled background fixture')
  assert.equal(firstTurn.status, 'completed', JSON.stringify(firstTurn.error))
  const id = f.host.listBackgroundCommands()[0].executionId
  assert.equal(f.state.processes[0].stops, 0)
  f.state.processes[0].stdout.write('retained fixture log\n')
  for (let index = 0; index < 5; index++) await f.host.send(`Check ${index}: ${'ordinary source text '.repeat(100)}`)
  await f.host.compact()
  assert(f.host.session.contextCheckpoint)
  await f.host.send('Inspect after compaction')
  const live = snapshot(f.state.requests.at(-1).input.messages)
  assert.equal(live[0].executionId, id); assert.equal(live[0].state, 'running')
  assert.equal(f.state.processes[0].stops, 0); assert.equal(f.state.approvals.length, 1)
  assert(!JSON.stringify(f.host.session.history).includes(snapshotPrefix))
  const first = JSON.parse((await f.host.readBackgroundCommand(id)).content)
  const second = JSON.parse((await f.host.readBackgroundCommand(id)).content)
  assert.match(first.output, /retained fixture log/); assert.equal(first.output, second.output)
  assert.equal(first.cleanupConfirmed, false)

  const restored = structuredClone(f.host.session)
  await f.host.shutdown()
  assert.equal(f.state.processes[0].completed, true)
  const fresh = await fixture(t, input => {
    assert.deepEqual(snapshot(input.messages), [])
    return { content: 'The restored transcript has no live process authority.', toolCalls: [] }
  }, { session: restored })
  assert.deepEqual(fresh.host.listBackgroundCommands(), [])
  await assert.rejects(fresh.host.readBackgroundCommand(id), /unavailable/)
  await fresh.host.send('Continue the restored session')
  assert.equal(fresh.state.processes.length, 0); assert.equal(fresh.state.approvals.length, 0)
})

test('inference cancellation leaves background jobs controllable and restart requests fresh exact human approval', { timeout: 10000 }, async t => {
  let entered
  const began = new Promise(resolve => { entered = resolve })
  const f = await fixture(t, async (input, state, signal) => {
    state.rounds++
    if (state.rounds === 1) return { content: '', toolCalls: [proposal('cancel-background')] }
    assert.equal(snapshot(input.messages).length, 1)
    entered()
    return new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  })
  const turn = f.host.send('Start the background fixture and wait')
  await Promise.race([began, turn.then(result => { throw new Error(`Turn ended before waiting: ${JSON.stringify(result.error)}`) })])
  f.host.cancel(); await turn
  const original = f.host.listBackgroundCommands()[0]
  assert.equal(original.state, 'running'); assert.equal(f.state.processes[0].stops, 0)
  const restarted = JSON.parse((await f.host.restartBackgroundCommand(original.executionId)).content)
  assert.notEqual(restarted.executionId, original.executionId)
  assert.equal(f.state.processes[0].completed, true)
  assert.equal(f.state.approvals.length, 2)
  assert(f.state.approvals.every(request => request.call.name === 'command_start'))
  assert.equal(f.state.approvals[1].call.arguments.background, true)
  const stopped = JSON.parse((await f.host.stopBackgroundCommand(restarted.executionId)).content)
  assert.equal(stopped.cleanupConfirmed, true)
  assert.equal(JSON.parse((await f.host.stopBackgroundCommand(restarted.executionId)).content).cleanupConfirmed, true)
  await f.host.stopAllBackgroundCommands()
  assert(f.state.processes.every(process => process.completed))
})

test('account revocation drains background jobs before the next dispatch and disables restarts', async t => {
  const f = await fixture(t, (input, state) => {
    state.rounds++
    return state.rounds === 1 ? { content: '', toolCalls: [proposal('account-background')] }
      : { content: 'Observed current registry.', toolCalls: [] }
  })
  await f.host.send('Start an owned fixture')
  const id = f.host.listBackgroundCommands()[0].executionId
  f.state.account = 'changed-fixture-account'
  await f.host.send('Continue after account change')
  assert.equal(f.state.processes[0].completed, true)
  assert.equal(f.host.commandsEnabled, false)
  await assert.rejects(f.host.restartBackgroundCommand(id))
  await f.host.stopAllBackgroundCommands()
})

test('unconfirmed foreground cleanup stays inspectable and stoppable without gaining background restart authority', async () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const row = { executionId: id, executable: '/owned-fixture', args: [], cwd: '/owned-workspace', state: 'failed',
    background: false, cleanupConfirmed: false, totalBytes: 0, truncated: false, error: 'Fixture tree verification failed' }
  const result = { content: JSON.stringify(row), isError: true }
  let stopped = 0, restarted = 0
  const host = new CliHost({ session: newSession({ provider: 'openai', model: 'offline-background' }),
    store: { async save() {} }, enableTools: false,
    provider: { async generate() { return { content: 'Done', toolCalls: [] } } },
    commandWorkspace: { list: () => [row], async poll() { return result }, async stop() { stopped++; return result },
      async stopAllBackground() { throw new Error('Process tree cleanup is unconfirmed') },
      async restart() { restarted++; return result }, async shutdown() {} } })
  assert.equal(host.commandsEnabled, false)
  assert.equal(host.listBackgroundCommands()[0].executionId, id)
  assert.equal(JSON.parse((await host.readBackgroundCommand(id)).content).cleanupConfirmed, false)
  assert.equal(JSON.parse((await host.stopBackgroundCommand(id)).content).cleanupConfirmed, false)
  assert.equal(stopped, 1)
  await assert.rejects(host.stopAllBackgroundCommands(), /unconfirmed/)
  assert.equal(host.listBackgroundCommands()[0].cleanupConfirmed, false)
  await assert.rejects(host.restartBackgroundCommand(id), /Only explicit background/)
  assert.equal(restarted, 0)
  await host.shutdown()
})
