// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TrustedCommandWorkspace, COMMAND_LIMITS } from '../dist/commands.js'
import { USER_SHELL_LIMITS } from '../dist/user-shell.js'

// Every launch in this file is intercepted. The filesystem work only prepares
// an ordinary temp cwd and stats/access-checks existing executable paths.
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function processFixture(options = {}) {
  const ended = deferred(), stopped = deferred(), stdout = new PassThrough(), stderr = new PassThrough()
  let finished = false, stops = 0
  const finish = (result = { exitCode: 0 }) => { if (!finished) { finished = true; ended.resolve(result) } }
  const process = { stdout, stderr, completed: ended.promise,
    async stop() {
      stops++; stopped.resolve()
      await options.cleanup?.promise
      finish({ exitCode: null, signal: 'SIGKILL' })
      await ended.promise
    }
  }
  return { process, stdout, stderr, finish, stopped: stopped.promise, get stops() { return stops } }
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'vivi-user-shell-runner-'))
  const launched = deferred(), calls = [], processes = [], secrets = options.secrets ?? []
  const state = { current: true, available: true, account: 'owned-account', approvals: [] }
  const context = { launchId: 'owned-launch', sessionId: 'owned-session', runId: 'owned-run', allowFirstApproval: true,
    get accountRevision() { return state.account }, isCurrent: () => state.current, canApprove: () => state.available,
    async approve(request) { state.approvals.push(request); return options.approved ?? false }
  }
  const workspace = await TrustedCommandWorkspace.open(root, process.env, secrets, async input => {
    calls.push(structuredClone(input))
    const fake = processFixture(options); processes.push(fake); launched.resolve(fake)
    await options.launchWait?.promise
    return fake.process
  })
  t.after(async () => {
    options.launchWait?.resolve(); options.cleanup?.resolve()
    for (const fake of processes) fake.finish({ exitCode: null, signal: 'SIGKILL' })
    await workspace.shutdown(); await rm(root, { recursive: true, force: true })
  })
  return { workspace, root, context, state, secrets, calls, launched: launched.promise, processes }
}

test('explicit user script bypasses only the second confirmation; subsequent agent commands still require exact approval', { timeout: 10000 }, async t => {
  const f = await fixture(t), script = 'owned inert fixture script', signal = new AbortController().signal
  const pending = f.workspace.runUserShell(script, f.context, signal)
  const fake = await f.launched; await tick()
  fake.stdout.write('observed fixture stdout\n'); fake.stderr.write('observed fixture stderr\n'); fake.finish({ exitCode: 7 })
  const result = await pending
  assert.equal(f.calls.length, 1); assert.equal(f.state.approvals.length, 0)
  assert.equal(result.state, 'exited'); assert.equal(result.exitCode, 7)
  assert.equal(result.executionComplete, true); assert.equal(result.success, false)
  assert.equal(result.processEffects, 'unknown'); assert.equal(result.untrusted, true)
  assert.match(result.output, /observed fixture stdout/); assert.match(result.output, /observed fixture stderr/)
  assert.equal(f.calls[0].cwd, await realpath(f.root))
  if (process.platform !== 'win32') {
    assert.equal(f.calls[0].executable, await realpath('/bin/sh'))
    assert.deepEqual(f.calls[0].args, ['-c', script])
  }
  assert(!Object.hasOwn(f.calls[0].env, 'OPENAI_API_KEY'))
  const denied = JSON.parse((await f.workspace.start({ id: 'agent-after-user', name: 'command_start',
    arguments: { executable: process.execPath, args: ['--version'], yieldMs: 0 }
  }, f.context, signal)).content)
  assert.equal(denied.processEffects, 'not_attempted')
  assert.equal(f.state.approvals.length, 1)
  assert.equal(f.state.approvals[0].call.name, 'command_start')
  assert.equal(f.calls.length, 1, 'Denied agent proposal cannot use prior user-submission authority')
})

test('foreground polling aggregates observed chunks inside its separate output budget', { timeout: 10000 }, async t => {
  const f = await fixture(t), original = f.workspace.poll.bind(f.workspace)
  let polls = 0
  t.mock.method(f.workspace, 'poll', async (id, owner, _yieldMs, signal) => {
    const fake = f.processes[0]
    fake.stdout.write((polls++ === 0 ? 'A' : 'B').repeat(20 * 1024))
    if (polls > 1) { fake.finish({ exitCode: 0 }); await tick() }
    return original(id, owner, 0, signal)
  })
  const result = await f.workspace.runUserShell('owned inert fixture script', f.context, new AbortController().signal)
  assert.equal(polls, 2)
  assert.equal(result.state, 'exited'); assert.equal(result.exitCode, 0)
  assert.equal(result.truncated, true)
  assert(Buffer.byteLength(result.output) <= USER_SHELL_LIMITS.outputBytes)
  assert(Buffer.byteLength(result.output) < COMMAND_LIMITS.maximumOutputBytes)
  assert(result.output.startsWith('A')); assert(result.output.includes('B'))
  assert.equal(f.calls.length, 1)
})

test('aggregate byte clipping drops an incomplete UTF-8 suffix rather than expanding it into replacement bytes', { timeout: 10000 }, async t => {
  const f = await fixture(t), original = f.workspace.poll.bind(f.workspace)
  t.mock.method(f.workspace, 'poll', async (id, owner, _yieldMs, signal) => {
    const fake = f.processes[0]
    fake.stdout.write('x'.repeat(USER_SHELL_LIMITS.outputBytes - 1) + '🙂')
    fake.finish({ exitCode: 0 }); await tick()
    return original(id, owner, 0, signal)
  })
  const result = await f.workspace.runUserShell('owned inert fixture script', f.context, new AbortController().signal)
  assert.equal(result.state, 'exited')
  assert.equal(result.truncated, true)
  assert(Buffer.byteLength(result.output) <= USER_SHELL_LIMITS.outputBytes)
  assert(!result.output.includes('\ufffd'))
  assert.equal(result.output, 'x'.repeat(USER_SHELL_LIMITS.outputBytes - 1))
})

test('known credentials split across stdout chunks and registered during execution stay out of final output', { timeout: 10000 }, async t => {
  const known = 'owned-known-stream-credential', late = 'owned-late-stream-credential'
  const f = await fixture(t, { secrets: [known] })
  const pending = f.workspace.runUserShell('owned inert fixture script', f.context, new AbortController().signal)
  const fake = await f.launched; await tick()
  fake.stdout.write(`prefix ${known.slice(0, 10)}`)
  fake.stdout.write(known.slice(10))
  f.secrets.push(late)
  fake.stderr.write(`\nlate ${late.slice(0, 9)}`); fake.stderr.write(late.slice(9))
  fake.finish({ exitCode: 0 })
  const result = await pending
  assert(!result.output.includes(known)); assert(!result.output.includes(late))
  assert.match(result.output, /\[REDACTED\]/)
})

test('newly known raw-script credential invalidates the prepared user command before any launch', async t => {
  const secret = 'owned-prelaunch-user-secret', f = await fixture(t)
  const original = f.workspace.prepare.bind(f.workspace)
  t.mock.method(f.workspace, 'prepare', async args => {
    const prepared = await original(args)
    f.secrets.push(secret)
    return prepared
  })
  const result = await f.workspace.runUserShell(`echo ${secret}`, f.context, new AbortController().signal)
  assert.equal(f.calls.length, 0)
  assert.equal(result.processEffects, 'not_attempted')
  assert.equal(result.executionComplete, false)
  assert(!JSON.stringify(result).includes(secret))
})

test('cancellation waits for owned process cleanup and never claims confirmed effects', { timeout: 10000 }, async t => {
  const cleanup = deferred(), f = await fixture(t, { cleanup }), controller = new AbortController()
  let settled = false
  const pending = f.workspace.runUserShell('owned inert fixture script', f.context, controller.signal).then(value => { settled = true; return value })
  const fake = await f.launched; await tick()
  fake.stdout.write('partial observed output')
  controller.abort(); await fake.stopped; await tick()
  assert.equal(settled, false, 'Cancellation must not release the owner while cleanup remains active')
  cleanup.resolve()
  const result = await pending
  assert.equal(fake.stops, 1)
  assert.equal(result.state, 'cancelled')
  assert.equal(result.executionComplete, true)
  assert.equal(result.processEffects, 'unknown')
  assert.equal(result.success, false)
  assert.match(result.output, /partial observed output/)
})

test('revocation during asynchronous launch stops the captured process and reports uncertainty', { timeout: 10000 }, async t => {
  const launchWait = deferred(), f = await fixture(t, { launchWait })
  const pending = f.workspace.runUserShell('owned inert fixture script', f.context, new AbortController().signal)
  const fake = await f.launched
  f.state.current = false; launchWait.resolve()
  const result = await pending
  assert.equal(fake.stops, 1)
  assert.equal(f.calls.length, 1)
  assert.equal(f.state.approvals.length, 0)
  assert.equal(result.state, 'failed')
  assert.equal(result.executionComplete, false)
  assert.equal(result.processEffects, 'unknown')
})

test('unavailable owner and raw credential rejection never invoke even the injected launcher', async t => {
  const secret = 'owned-never-launched-secret', f = await fixture(t, { secrets: [secret] })
  await assert.rejects(f.workspace.runUserShell(`echo ${secret}`, f.context, new AbortController().signal), /credential|secret/i)
  f.state.available = false
  const result = await f.workspace.runUserShell('owned inert fixture script', f.context, new AbortController().signal)
  assert.equal(result.processEffects, 'not_attempted')
  assert.equal(f.calls.length, 0)
  assert.equal(f.state.approvals.length, 0)
})
