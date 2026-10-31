// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm, writeFile, readFile, realpath, access } from 'node:fs/promises'
import { join, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { TrustedCommandWorkspace, COMMAND_LIMITS, createCommandExtension } from '../dist/commands.js'
import { createToolRegistry } from '@ayayaq/vivi/extensions'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value }); return { promise, resolve } }
const parse = result => JSON.parse(result.content)
const owner = 'launch:session:run'
const call = (id, args = {}) => ({ id, name: 'command_start', arguments: {
  executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], yieldMs: 0, background: true, ...args } })
function fakeProcess(options = {}) {
  const completed = deferred(), stopped = deferred(), stdout = new PassThrough(), stderr = new PassThrough()
  let stops = 0
  return { stdout, stderr, stopped: stopped.promise, finish: completed.resolve, get stops() { return stops },
    process: { stdout, stderr, completed: completed.promise, async stop() {
      stops++; stopped.resolve(); await options.cleanup?.promise
      if (options.stopError) throw options.stopError
      completed.resolve(options.result ?? { exitCode: null, signal: 'SIGKILL' }); await completed.promise
    } } }
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vivi-background-')), launched = deferred(), processes = [], inputs = []
  const state = { current: true, available: true, approved: true, approvals: [] }, secrets = options.secrets ?? []
  const context = { launchId: 'launch', sessionId: 'session', runId: 'run', allowFirstApproval: true, accountRevision: 'account',
    canApprove: () => state.available, isCurrent: () => state.current,
    async approve(request, signal) { state.approvals.push(request); await options.approval?.(request, signal); return state.approved } }
  const workspace = await TrustedCommandWorkspace.open(root, process.env, secrets, async input => {
    inputs.push(input); const fake = fakeProcess(options); processes.push(fake); launched.resolve(fake)
    await options.launchWait?.promise; await options.beforeReturn?.(fake, processes.length); return fake.process
  })
  t.after(async () => {
    options.launchWait?.resolve(); options.cleanup?.resolve()
    for (const fake of processes) fake.finish({ exitCode: null, signal: 'SIGKILL' })
    await workspace.shutdown().catch(() => undefined); await rm(root, { recursive: true, force: true })
  })
  return { root, workspace, context, state, inputs, processes, launched: launched.promise, signal: new AbortController().signal }
}

test('only explicit background jobs survive turn completion and inference cancellation; registry IDs work across turns', async t => {
  const f = await fixture(t), controller = new AbortController()
  const background = parse(await f.workspace.start(call('bg'), f.context, controller.signal, controller.signal))
  const foreground = parse(await f.workspace.start(call('fg', { background: false }), f.context, controller.signal, controller.signal))
  await f.workspace.endRun(); controller.abort(); await tick()
  assert.equal(f.processes[0].stops, 0); assert.equal(f.processes[1].stops, 1)
  const nextOwner = 'launch:session:next-run'
  assert.equal(parse(await f.workspace.poll(background.executionId, nextOwner)).state, 'running')
  assert.equal(f.workspace.list(nextOwner).length, 1)
  await assert.rejects(f.workspace.poll(background.executionId, 'launch:other-session:next'), /unavailable/)
  await assert.rejects(f.workspace.poll(background.executionId, 'other-launch:session:next'), /unavailable/)
  await assert.rejects(f.workspace.poll(foreground.executionId, nextOwner), /unavailable/)
  const stopped = parse(await f.workspace.stop(background.executionId, nextOwner))
  assert.equal(stopped.cleanupConfirmed, true); assert.equal(stopped.state, 'cancelled')
  await f.workspace.stop(background.executionId, nextOwner); assert.equal(f.processes[0].stops, 1)
})

test('background approval says session-owned and rejects foreground hard timeout combinations', async t => {
  const f = await fixture(t)
  await assert.rejects(f.workspace.start(call('bad-timeout', { timeoutMs: 5 }), f.context, f.signal), /omit timeoutMs/)
  assert.equal(f.inputs.length, 0)
  await f.workspace.start(call('bg'), f.context, f.signal)
  assert.match(f.state.approvals[0].description, /BACKGROUND/)
  assert.match(f.state.approvals[0].description, /no hard runtime timeout/)
  assert.equal(f.state.approvals.length, 1)
})

test('background logs retain a bounded UTF-8 tail without lifetime output-limit termination and screen split secrets', async t => {
  const secret = 'owned-background-secret', f = await fixture(t, { secrets: [secret] })
  const value = parse(await f.workspace.start(call('logs'), f.context, f.signal)), fake = f.processes[0]
  fake.stdout.write('a'.repeat(COMMAND_LIMITS.maximumOutputBytes + 100))
  fake.stdout.write('🙂'.repeat(20_000)); fake.stderr.write('TAIL ' + secret.slice(0, 8)); fake.stderr.write(secret.slice(8) + ' END')
  await tick()
  const first = parse(await f.workspace.logs(value.executionId, owner)), second = parse(await f.workspace.logs(value.executionId, 'launch:session:next'))
  assert.equal(first.state, 'running'); assert.equal(fake.stops, 0)
  assert(first.totalBytes > COMMAND_LIMITS.maximumOutputBytes); assert.equal(first.truncated, true)
  assert.equal(first.outputMode, 'tail'); assert(Buffer.byteLength(first.output) <= COMMAND_LIMITS.maximumPendingBytes)
  assert(!first.output.includes('\ufffd')); assert(!first.output.includes(secret)); assert.match(first.output, /TAIL \[REDACTED\] END/)
  assert.equal(first.output, second.output)
})

test('stop/restart wait for tree verification; restart always requests fresh approval and cannot duplicate an old ID', async t => {
  const cleanup = deferred(), f = await fixture(t, { cleanup })
  const original = parse(await f.workspace.start(call('original'), f.context, f.signal))
  let settled = false
  const restarting = f.workspace.restart(original.executionId, { ...f.context, runId: 'next' }, f.signal).then(result => { settled = true; return parse(result) })
  await f.processes[0].stopped; await tick()
  assert.equal(settled, false); assert.equal(f.inputs.length, 1); assert.equal(f.state.approvals.length, 1)
  await assert.rejects(f.workspace.restart(original.executionId, f.context, f.signal), /already restarting/)
  cleanup.resolve(); const replacement = await restarting
  assert.notEqual(replacement.executionId, original.executionId); assert.equal(f.inputs.length, 2); assert.equal(f.state.approvals.length, 2)
  assert.deepEqual(f.inputs[1], f.inputs[0])
  await assert.rejects(f.workspace.restart(original.executionId, f.context, f.signal), /replaced/)
  assert.equal(f.inputs.length, 2)
})

test('uncertain platform cleanup remains visible and blocks replacement, Stop All and normal shutdown success', async t => {
  const f = await fixture(t, { result: { exitCode: null, error: 'Owned job-empty verification failed' } })
  const value = parse(await f.workspace.start(call('uncertain'), f.context, f.signal))
  const stopped = parse(await f.workspace.stop(value.executionId, owner))
  assert.equal(stopped.state, 'failed'); assert.equal(stopped.cleanupConfirmed, false); assert.equal(stopped.executionComplete, false)
  assert.equal(f.workspace.list('launch:session:next')[0].executionId, value.executionId)
  await assert.rejects(f.workspace.restart(value.executionId, f.context, f.signal), /unconfirmed/)
  assert.equal(f.inputs.length, 1); assert.equal(f.state.approvals.length, 1)
  await assert.rejects(f.workspace.stopAllBackground(owner), /unconfirmed/)
  await assert.rejects(f.workspace.shutdown(), /unconfirmed/)
  assert.equal(f.workspace.list(owner).length, 1)
})

test('stop rejection retains a retryable visible row instead of erasing the only process handle', async t => {
  const f = await fixture(t, { stopError: new Error('owned stop transport failed') })
  const value = parse(await f.workspace.start(call('stop-fails'), f.context, f.signal))
  assert.equal(parse(await f.workspace.stop(value.executionId, owner)).cleanupConfirmed, false)
  assert.equal(f.workspace.list(owner)[0].state, 'failed')
  await f.workspace.stop(value.executionId, owner); assert.equal(f.processes[0].stops, 2)
})

test('shutdown and Stop All own asynchronous launch races and do not return before cleanup', async t => {
  for (const action of ['shutdown', 'stopAllBackground', 'disable']) {
    const launchWait = deferred(), cleanup = deferred(), f = await fixture(t, { launchWait, cleanup })
    const starting = f.workspace.start(call(action), f.context, f.signal)
    const rejected = assert.rejects(starting)
    const fake = await f.launched
    let settled = false
    const closing = (action === 'stopAllBackground' ? f.workspace.stopAllBackground(owner) : f.workspace[action]()).then(() => { settled = true })
    await tick(); assert.equal(settled, false)
    launchWait.resolve(); await fake.stopped; await tick(); assert.equal(settled, false)
    cleanup.resolve(); await Promise.all([closing, rejected])
    assert.equal(fake.stops, 1)
    if (action === 'shutdown') assert.equal(f.workspace.list(owner).length, 0)
    else assert.equal(f.workspace.list(owner)[0].cleanupConfirmed, true)
  }
})

test('pending foreground approval is revoked at endRun while established background jobs remain owned', async t => {
  const entered = deferred(), release = deferred()
  const f = await fixture(t, { approval: async request => { if (request.call.id === 'pending') { entered.resolve(); await release.promise } } })
  await f.workspace.start(call('background'), f.context, f.signal)
  const starting = f.workspace.start(call('pending', { background: false }), f.context, f.signal)
  const rejected = assert.rejects(starting)
  await entered.promise; const ending = f.workspace.endRun(); await tick(); release.resolve()
  await Promise.all([ending, rejected]); assert.equal(f.inputs.length, 1); assert.equal(f.processes[0].stops, 0)
})

test('live and pending job limits reserve capacity across concurrent approvals without evicting live jobs', async t => {
  const release = deferred(), entered = deferred(); let approvals = 0
  const f = await fixture(t, { approval: async () => { if (++approvals === COMMAND_LIMITS.maximumSessions) entered.resolve(); await release.promise } })
  const starts = Array.from({ length: COMMAND_LIMITS.maximumSessions }, (_, i) => f.workspace.start(call(`job-${i}`), f.context, f.signal))
  await entered.promise
  await assert.rejects(f.workspace.start(call('over-limit'), f.context, f.signal), /live command limit/)
  release.resolve(); await Promise.all(starts)
  assert.equal(f.workspace.list(owner).length, COMMAND_LIMITS.maximumSessions)
  assert(f.processes.every(fake => fake.stops === 0))
  await f.workspace.stopAllBackground(owner)
  assert(f.processes.every(fake => fake.stops === 1))
})

test('model tools discover/list/log/stop across turns and never revive transcript IDs on another launch', async t => {
  const f = await fixture(t)
  const first = createToolRegistry([createCommandExtension(f.workspace, f.context)])
  const started = parse(await first.executeTool(call('model-background'), { signal: f.signal }))
  const next = createToolRegistry([createCommandExtension(f.workspace, { ...f.context, runId: 'next' })])
  const listed = parse(await next.executeTool({ id: 'list', name: 'command_list', arguments: {} }, { signal: f.signal }))
  assert.equal(listed.jobs[0].executionId, started.executionId)
  const logs = parse(await next.executeTool({ id: 'logs', name: 'command_logs', arguments: { executionId: started.executionId } }, { signal: f.signal }))
  assert.equal(logs.state, 'running')
  const other = await fixture(t), restored = createToolRegistry([createCommandExtension(other.workspace, other.context)])
  const unknown = await restored.executeTool({ id: 'old-id', name: 'command_stop', arguments: { executionId: started.executionId } }, { signal: other.signal })
  assert.equal(unknown.isError, true); assert.equal(other.inputs.length, 0)
})

async function absent(pid) {
  try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') return true; throw error }
  if (process.platform === 'linux') { try { return /\) [ZX] /.test(await readFile(`/proc/${pid}/stat`, 'utf8')) } catch { return true } }
  return false
}
async function npmCli() {
  const candidates = [process.env.npm_execpath, ...String(process.env.PATH ?? '').split(delimiter).map(path => join(path, 'npm'))].filter(Boolean)
  for (const path of candidates) { try { const canonical = await realpath(path); if (canonical.endsWith('npm-cli.js')) return canonical } catch {} }
}
test('real npm dev root, shell, server and descendant remain usable across turn then all terminate on Stop', { timeout: 20_000 }, async t => {
  const npm = await npmCli(); if (!npm) { t.skip('No npm CLI JavaScript entry is installed on this host'); return }
  await access(npm)
  const root = await mkdtemp(join(tmpdir(), 'vivi-background-npm-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node dev.mjs' }, type: 'module' }))
  await writeFile(join(root, 'dev.mjs'), `import {spawn} from 'node:child_process';import http from 'node:http';
const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
const server=http.createServer((_,r)=>r.end('owned-background-ready'));server.listen(0,'127.0.0.1',()=>console.log('VIVI_READY '+JSON.stringify({pid:process.pid,descendant:descendant.pid,port:server.address().port})));`)
  const workspace = await TrustedCommandWorkspace.open(root, process.env)
  t.after(async () => { await workspace.shutdown(); await rm(root, { recursive: true, force: true }) })
  const context = { launchId: 'launch', sessionId: 'session', runId: 'run', allowFirstApproval: true,
    accountRevision: 'account', canApprove: () => true, isCurrent: () => true, approve: async () => true }
  const started = parse(await workspace.start(call('npm-dev', { args: [npm, 'run', 'dev'] }), context, new AbortController().signal))
  let ready
  const deadline = Date.now() + 10_000
  while (!ready && Date.now() < deadline) {
    const value = parse(await workspace.poll(started.executionId, owner, 100))
    const match = /VIVI_READY (\{[^\n]+\})/.exec(value.output)
    if (match) ready = JSON.parse(match[1]); else assert.equal(value.state, 'running', value.output)
  }
  assert(ready, 'npm dev server did not become ready')
  await workspace.endRun()
  assert.equal(await (await fetch(`http://127.0.0.1:${ready.port}`)).text(), 'owned-background-ready')
  const stopped = parse(await workspace.stop(started.executionId, 'launch:session:next'))
  assert.equal(stopped.cleanupConfirmed, true)
  assert.equal(await absent(ready.pid), true); assert.equal(await absent(ready.descendant), true)
  await assert.rejects(fetch(`http://127.0.0.1:${ready.port}`))
})

test('verified absence remains separate from execution failure and does not wedge a foreground owner', async t => {
  const f = await fixture(t)
  const value = parse(await f.workspace.start(call('spawn-failed', { background: false }), f.context, f.signal))
  f.processes[0].finish({ exitCode: null, error: 'Owned executable launch failed', cleanupConfirmed: true }); await tick()
  const failed = parse(await f.workspace.poll(value.executionId, owner))
  assert.equal(failed.state, 'failed'); assert.equal(failed.cleanupConfirmed, true); assert.equal(failed.executionComplete, false)
  await f.workspace.endRun(); assert.equal(f.workspace.list(owner).length, 0)
})

test('terminal record cap reserves pending slots and prunes only verified dead rows', async t => {
  const f = await fixture(t)
  for (let i = 0; i < COMMAND_LIMITS.maximumRecords - 1; i++) {
    await f.workspace.start(call(`old-${i}`), f.context, f.signal)
    f.processes.at(-1).finish({ exitCode: 0 }); await tick()
  }
  const release = deferred(), entered = deferred(); let approvals = 0
  f.context.approve = async () => { if (++approvals === COMMAND_LIMITS.maximumSessions) entered.resolve(); await release.promise; return true }
  const starts = Array.from({ length: COMMAND_LIMITS.maximumSessions }, (_, i) => f.workspace.start(call(`concurrent-${i}`), f.context, f.signal))
  await entered.promise; release.resolve(); await Promise.all(starts)
  assert.equal(f.workspace.list(owner).length, COMMAND_LIMITS.maximumRecords)
  assert.equal(f.workspace.list(owner).filter(row => row.state === 'running').length, COMMAND_LIMITS.maximumSessions)
})

test('Stop All revokes a restart still awaiting the old tree cleanup before any replacement approval', async t => {
  const cleanup = deferred(), f = await fixture(t, { cleanup })
  const value = parse(await f.workspace.start(call('restart-old'), f.context, f.signal))
  const restart = assert.rejects(f.workspace.restart(value.executionId, f.context, f.signal), /revoked/)
  await f.processes[0].stopped
  const all = f.workspace.stopAllBackground(owner)
  cleanup.resolve(); await Promise.all([restart, all])
  assert.equal(f.inputs.length, 1); assert.equal(f.state.approvals.length, 1)
})

test('a replacement remains linked when cancellation loses its initial background result', async t => {
  const f = await fixture(t)
  const first = parse(await f.workspace.start(call('restart-yield', { yieldMs: 100 }), f.context, f.signal))
  const controller = new AbortController()
  const restarted = assert.rejects(f.workspace.restart(first.executionId, f.context, controller.signal))
  const deadline = Date.now() + 1000
  while (f.inputs.length < 2 && Date.now() < deadline) await tick()
  assert.equal(f.inputs.length, 2)
  // The launch itself has completed; cancellation during initial output wait
  // leaves this explicitly backgrounded replacement discoverable.
  await tick(); controller.abort(); await restarted
  const live = f.workspace.list(owner).filter(value => value.state === 'running')
  assert.equal(live.length, 1)
  await assert.rejects(f.workspace.restart(first.executionId, f.context, f.signal), /replaced/)
  assert.equal(f.inputs.length, 2)
})

test('a replacement is linked even when asynchronous launch loses ownership and tree cleanup is uncertain', async t => {
  const options = {}, f = await fixture(t, options)
  const first = parse(await f.workspace.start(call('old-owned'), f.context, f.signal))
  options.beforeReturn = async (_fake, count) => {
    if (count === 2) { options.result = { exitCode: null, error: 'Owned replacement cleanup unconfirmed' }; f.state.current = false }
  }
  await assert.rejects(f.workspace.restart(first.executionId, f.context, f.signal))
  assert.equal(f.inputs.length, 2)
  const uncertain = f.workspace.list(owner).find(row => row.executionId !== first.executionId)
  assert.equal(uncertain.cleanupConfirmed, false); assert.equal(uncertain.state, 'failed')
  f.state.current = true
  await assert.rejects(f.workspace.restart(first.executionId, f.context, f.signal), /replaced/)
  assert.equal(f.inputs.length, 2)
})

test('late secret redaction expansion cannot exceed the retained log read byte cap', async t => {
  const secrets = [], f = await fixture(t, { secrets })
  const value = parse(await f.workspace.start(call('late-redaction'), f.context, f.signal))
  f.processes[0].stdout.write('x'.repeat(COMMAND_LIMITS.maximumPendingBytes)); secrets.push('x')
  const output = parse(await f.workspace.logs(value.executionId, owner))
  assert(Buffer.byteLength(output.output) <= COMMAND_LIMITS.maximumPendingBytes)
  assert.equal(output.truncated, true); assert(!output.output.includes('x'))
})

test('revoked prelaunch preparation cannot block session exit or launch after its owner is gone', { timeout: 10_000 }, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred()
  t.after(() => release.resolve())
  const prepare = f.workspace.prepare.bind(f.workspace)
  t.mock.method(f.workspace, 'prepare', async args => { const value = await prepare(args); entered.resolve(); await release.promise; return value })
  const starting = assert.rejects(f.workspace.start(call('late-prepare'), f.context, f.signal))
  await entered.promise
  let closed = false
  const closing = f.workspace.shutdown().then(() => { closed = true })
  await tick(); assert.equal(closed, true, 'Preparation has no process handle and must not hold an exiting session hostage')
  release.resolve(); await Promise.all([starting, closing])
  assert.equal(f.inputs.length, 0); assert.equal(f.state.approvals.length, 0)
})
