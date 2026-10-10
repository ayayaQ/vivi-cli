// SPDX-License-Identifier: Apache-2.0
// Native Windows acceptance uses only this repository's harmless local fixture.
// No credential store, providers, live servers, command permission modes or CUA.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { McpConfigStore, prepareMcpLaunch } from '../dist/mcp-config.js'
import { McpManager } from '../dist/mcp-manager.js'
import { McpStdioTransport } from '../dist/mcp-transport.js'
import { launchWindowsMcp } from '../dist/mcp-windows.js'

const fixtureFile = fileURLToPath(new URL('./fixtures/mcp-discovery-server.mjs', import.meta.url))
const fixtureEnvironment = process.platform === 'win32' && !process.versions.bun ? ['SYSTEMROOT'] : []
const fixtureEnv = fixtureEnvironment.length ? { SYSTEMROOT: Object.entries(process.env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1]
  ?? assert.fail('Windows Node fixture requires an explicitly captured SystemRoot') } : {}
const closedInputFixtureFile = fileURLToPath(new URL('./fixtures/mcp-windows-closed-input.cs', import.meta.url))
const compileFixture = promisify(execFile)
const options = { skip: process.platform !== 'win32', timeout: 45_000 }
const nativeTest = (name, body) => test(`Windows real MCP: ${name}`, options, body)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const signal = () => new AbortController().signal
const allowedMethods = new Set(['initialize', 'server/discover', 'notifications/initialized', 'notifications/cancelled',
  'tools/list', 'resources/list', 'resources/templates/list'])

async function bounded(promise, label, ms = 15_000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its deadline`)), ms)
    })])
  } finally { clearTimeout(timer) }
}
async function until(predicate, label, ms = 15_000) {
  const expires = Date.now() + ms
  while (!await predicate()) {
    assert.ok(Date.now() < expires, `${label} exceeded its deadline`)
    await wait(10)
  }
}
function dead(pid) {
  try { process.kill(pid, 0); return false }
  catch (error) { if (error.code === 'ESRCH') return true; throw error }
}
function collect(stream) {
  const chunks = []
  stream.on('data', bytes => chunks.push(bytes))
  return () => Buffer.concat(chunks)
}
async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi mcp native-'))
  const log = join(directory, 'log'), pidFile = join(directory, 'pid')
  const closers = [], helpers = new Map(), knownPids = new Set()
  async function pids() {
    try {
      const text = (await readFile(pidFile, 'utf8')).trim()
      if (!text) return [] // Startup cancellation may interrupt the initial file write.
      const result = text.split('\n').map(Number)
      assert.ok(result.every(pid => Number.isInteger(pid) && pid > 0), 'invalid owned fixture PID')
      for (const pid of result) knownPids.add(pid)
      return result
    } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  t.after(async () => {
    const failures = []
    for (const close of closers.reverse()) {
      try { await bounded(close(), 'fixture cleanup', 8_000) } catch (error) { failures.push(error) }
    }
    // Keep a final safety net even when an assertion or native cleanup fails.
    // Every PID/ChildProcess here belongs to this test's local fixture/helper.
    for (const [helper, closed] of helpers) {
      if (closed) continue
      try {
        const close = new Promise(resolve => helper.once('close', resolve))
        helper.kill('SIGKILL')
        await bounded(close, 'helper failure cleanup', 5_000)
      } catch (error) { failures.push(error) }
    }
    await pids()
    for (const pid of knownPids) {
      if (!dead(pid)) {
        try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') failures.push(error) }
      }
    }
    try { await until(() => [...knownPids].every(dead), 'owned fixture death', 5_000) }
    catch (error) { failures.push(error) }
    await rm(directory, { recursive: true, force: true })
    if (failures.length) throw new AggregateError(failures, 'Windows fixture cleanup failed')
  }, { timeout: 30_000 })
  const subject = { directory, log, pidFile, pids,
    async messages() {
      try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) }
      catch (error) { if (error.code === 'ENOENT') return []; throw error }
    },
    async assertDead() {
      const owned = await pids()
      await until(() => owned.every(dead), 'verified fixture death', 5_000)
    },
    async launch(mode, args = [], env = fixtureEnv) {
      return subject.launchTarget(process.execPath, [fixtureFile, mode, log, pidFile, ...args], env)
    },
    async launchTarget(executable, args, env = {}) {
      const owned = await launchWindowsMcp({ executable, args, cwd: directory, env }, {
        hostEnv: { ...process.env, PSModulePath: directory, NODE_OPTIONS: '--invalid-owned-fixture-option' },
        cleanupTimeoutMs: 5_000,
        spawn(executable, argv, settings) {
          const helper = spawn(executable, argv, settings)
          helpers.set(helper, false)
          helper.once('close', () => helpers.set(helper, true))
          return helper
        },
      })
      closers.push(() => owned.stop())
      return { owned, stdout: collect(owned.stdout), stderr: collect(owned.stderr) }
    },
    async manager(mode = 'pages', protocol = 'legacy') {
      const store = new McpConfigStore(directory)
      const server = { id: 'fixture', label: 'Owned local fixture', executable: process.execPath,
        args: [fixtureFile, mode, log, pidFile], cwd: directory, protocol, environment: fixtureEnvironment }
      let starts = 0
      const manager = new McpManager({ store, env: { ...fixtureEnv, NODE_OPTIONS: '--invalid-owned-fixture-option', PATH: 'unused-owned-fixture-path' },
        transportFactory(launch) {
          starts++
          const transport = new McpStdioTransport(launch)
          closers.push(() => transport.close())
          return transport
        } })
      closers.push(() => manager.close())
      await manager.reload(); await manager.configure(server)
      return { manager, server, starts: () => starts }
    },
    own(closer) { closers.push(closer) },
  }
  return subject
}

nativeTest('standard argv, Unicode, exact target environment and binary stderr', async t => {
  const subject = await sandbox(t)
  const args = ['', 'white space', '"quote"', 'backslash\\"quote', 'trailing\\', 'trailing\\\\',
    '&|<>^%PATH%', '$(literal data)', '中文🙂']
  for (const environment of [fixtureEnv, { ...fixtureEnv, MCP_FIXTURE_VALUE: 'fixed literal & $ 中文🙂', FIXTURE_EMPTY: '', FIXTURE_UNICODE: '值🙂' }]) {
    const { owned, stdout, stderr } = await subject.launch('native-probe', args, environment)
    assert.deepEqual(await bounded(owned.completed, 'native environment probe'), { exitCode: 0 },
      stderr().subarray(0, 4096).toString('utf8'))
    const result = JSON.parse(stdout().toString('utf8'))
    assert.deepEqual(result.args, args)
    assert.equal(result.cwd.toLowerCase(), subject.directory.toLowerCase())
    assert.deepEqual(result.environment, environment)
    assert.deepEqual(result.env, Object.keys(environment).sort())
    assert.equal(result.markerMatches, 'MCP_FIXTURE_VALUE' in environment)
    assert.equal(result.helperSettingLeaked, false)
    assert.deepEqual(stderr(), Buffer.from([0, 255, 13, 10]))
    await subject.assertDead()
  }
})

nativeTest('stdin preserves binary and Unicode bytes up to the frame limit', async t => {
  const subject = await sandbox(t)
  const { owned, stdout, stderr } = await subject.launch('native-stdin')
  await until(() => stderr().includes(Buffer.from('native-stdin-ready\n')), 'stdin fixture readiness')
  const chunks = [Buffer.from([0, 255, 13, 10, 128]), Buffer.from('中文🙂 "opaque" & $\n'), Buffer.alloc(65_536, 97)]
  for (const chunk of chunks) await bounded(owned.write(chunk), 'native input write')
  const expected = Buffer.concat(chunks)
  await until(() => stdout().length === expected.length, 'native stdin round trip')
  assert.deepEqual(stdout(), expected)
  await assert.rejects(owned.write(Buffer.alloc(65_537)), /limit/)
  await bounded(owned.stop(), 'stdin fixture stop')
  assert.equal((await owned.completed).signal, 'SIGTERM')
  await assert.rejects(owned.write(Buffer.from('late')), /unavailable/)
  await subject.assertDead()
})

nativeTest('closed target stdin reports failure and cleans up without a manual stop', async t => {
  const subject = await sandbox(t)
  // Windows libuv deliberately does not close CRT fd 0-2. Compile this one
  // fixed console fixture directly, avoiding PowerShell/Node target host setup.
  const systemRoot = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1]
  assert.ok(systemRoot, 'Windows SystemRoot is unavailable')
  const framework = win32.join(systemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319')
  const compiler = win32.join(framework, 'csc.exe'), library = win32.join(framework, 'System.dll')
  for (const file of [compiler, library]) {
    const info = await lstat(file)
    assert.ok(info.isFile() && !info.isSymbolicLink(), 'Unexpected installed OS compiler component')
    let ancestor = win32.dirname(file)
    while (true) {
      const info = await lstat(ancestor)
      assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Unexpected installed OS compiler ancestor')
      const parent = win32.dirname(ancestor)
      if (parent === ancestor) break
      ancestor = parent
    }
  }
  const env = { SystemRoot: systemRoot }
  for (const name of ['TEMP', 'TMP']) {
    const value = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    if (value !== undefined) env[name] = value
  }
  const executable = join(subject.directory, 'owned-closed-input.exe')
  // No response file, package restore, tool download, shell, or product build.
  // Compiler output is bounded; the test's existing cleanup removes the EXE.
  await compileFixture(compiler, ['/nologo', '/noconfig', '/target:exe', `/reference:${library}`,
    `/out:${executable}`, closedInputFixtureFile], { cwd: subject.directory, env,
    windowsHide: true, timeout: 15_000, maxBuffer: 16_384 })
  const compiled = await lstat(executable)
  assert.ok(compiled.isFile() && !compiled.isSymbolicLink() && compiled.size > 0, 'Owned console fixture was not compiled')
  const launchedAt = Date.now()
  const { owned, stderr } = await subject.launchTarget(executable, [subject.log, subject.pidFile], env)
  let nativeResult
  void owned.completed.then(result => { nativeResult = result })
  try {
    await until(() => {
      if (stderr().includes(Buffer.from('native-stdin-closed\n'))) return true
      assert.equal(nativeResult, undefined, 'closed stdin fixture ended before readiness')
      return false
    }, 'closed stdin fixture readiness')
  } catch (error) {
    // These bytes come only from the fixed owned fixture, never a user's server.
    t.diagnostic(JSON.stringify({ event: 'owned-closed-input-readiness-failure', elapsedMs: Date.now() - launchedAt,
      nativeResult: nativeResult && { ...nativeResult, error: nativeResult.error?.slice(0, 1024) },
      fixturePidRecorded: (await subject.pids()).length > 0,
      startupEvents: (await subject.messages()).map(message => message.event).slice(0, 4),
      stderr: stderr().subarray(0, 1024).toString('utf8') }))
    throw error
  }
  const pids = await subject.pids()
  assert.equal(pids.length, 1)
  assert.ok(pids.every(pid => !dead(pid)), 'closed-input fixture must remain alive before the failed write')
  assert.equal((await subject.messages()).find(message => message.event === 'stdin-handle-closed')?.originalHandleInvalid, true)
  // The helper may accept this frame before its native pump sees the broken
  // target pipe. The authoritative lifecycle must still fail and close the job.
  await bounded(owned.write(Buffer.alloc(65_536, 97)), 'closed stdin write').catch(error => {
    assert.match(error.message, /Windows MCP input failed/)
  })
  const result = await bounded(owned.completed, 'closed stdin cleanup')
  assert.equal(result.exitCode, null)
  assert.ok(result.error)
  t.diagnostic(JSON.stringify({ event: 'owned-closed-input', error: result.error.slice(0, 256) }))
  await subject.assertDead()
})

for (const protocol of ['legacy', '2026-07-28']) nativeTest(`initialize, lists, resource metadata, refresh, reconnect and disable (${protocol})`, async t => {
  const subject = await sandbox(t), { manager, starts } = await subject.manager('pages', protocol)
  let approvals = 0
  const approve = async launch => { approvals++; assert.deepEqual(launch.environment, fixtureEnv); return true }
  assert.equal(await bounded(manager.connect('fixture', approve, signal()), 'native discovery connect'), true)
  let status = manager.statuses()[0]
  assert.equal(status.state, 'connected')
  assert.equal(status.snapshot.protocolVersion, protocol === 'legacy' ? '2025-11-25' : protocol)
  assert.deepEqual(status.snapshot.categories.tools.entries.map(entry => entry.remoteKey), ['same/name', 'second/name'])
  assert.equal(status.snapshot.categories.resources.state, 'not-requested')
  const generation = status.snapshot.catalogGeneration
  await bounded(manager.refresh('fixture', ['tools', 'resources', 'resourceTemplates'], signal()), 'native metadata refresh')
  status = manager.statuses()[0]
  assert.ok(status.snapshot.catalogGeneration > generation)
  assert.equal(status.snapshot.categories.resources.state, 'ready')
  assert.equal(status.snapshot.categories.resources.entries[0].descriptor.uri, 'file:///never-open-this')
  assert.equal(status.snapshot.categories.resourceTemplates.entries[0].descriptor.uriTemplate, 'fixture:///{name}')
  assert.equal(starts(), 1)
  const firstPids = await subject.pids()
  await bounded(manager.disconnect('fixture'), 'native disable')
  assert.equal(manager.statuses()[0].state, 'disabled')
  assert.ok(firstPids.every(dead))
  assert.equal(await bounded(manager.connect('fixture', approve, signal()), 'native reconnect'), true)
  assert.equal(approvals, 2)
  assert.equal(starts(), 2)
  assert.notEqual(manager.statuses()[0].snapshot.connectionGeneration, status.snapshot.connectionGeneration)
  await bounded(manager.disconnect('fixture'), 'native reconnect disable')
  await subject.assertDead()
  const messages = await subject.messages(), requests = messages.filter(message => message.method)
  assert.equal(messages.filter(message => message.event === 'start').length, 2)
  for (const message of messages.filter(message => message.event === 'start')) assert.deepEqual(message.env, fixtureEnvironment)
  assert.ok(requests.every(message => allowedMethods.has(message.method)))
  const handshake = requests.find(message => message.method === (protocol === 'legacy' ? 'initialize' : 'server/discover'))
  if (protocol === 'legacy') assert.deepEqual(handshake.params.capabilities, {})
  else assert.deepEqual(handshake.params._meta['io.modelcontextprotocol/clientCapabilities'], {})
  assert.equal(requests.find(message => message.method === 'tools/list').params.cursor, undefined)
  assert.equal(requests.filter(message => message.method === 'tools/list')[1].params.cursor, 'opaque cursor')
})

nativeTest('natural root exit kills detached descendants before verified completion', async t => {
  const subject = await sandbox(t), { owned, stdout, stderr } = await subject.launch('native-detached-exit')
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Owned fixture', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]
  await bounded(owned.write(Buffer.from(requests.map(message => JSON.stringify(message) + '\n').join(''))), 'natural-exit discovery input')
  assert.deepEqual(await bounded(owned.completed, 'natural root exit'), { exitCode: 0 },
    stderr().subarray(0, 4096).toString('utf8'))
  const pids = await subject.pids()
  assert.equal(pids.length, 2)
  assert.ok(pids.every(dead), 'verified completion left an owned root or detached descendant alive')
  const replies = stdout().toString('utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(replies.map(reply => reply.id), [1, 2])
})

nativeTest('disable kills a running root and detached descendants', async t => {
  const subject = await sandbox(t), { manager } = await subject.manager('native-detached')
  assert.equal(await bounded(manager.connect('fixture', async () => true, signal()), 'detached fixture connect'), true)
  const pids = await subject.pids()
  assert.equal(pids.length, 2)
  assert.ok(pids.every(pid => !dead(pid)))
  await bounded(manager.disconnect('fixture'), 'detached fixture disable')
  assert.ok(pids.every(dead), 'disable returned before the owned tree exited')
  assert.equal(manager.statuses()[0].state, 'disabled')
})

nativeTest('immediate startup cancellation completes verified cleanup', async t => {
  const subject = await sandbox(t), { owned } = await subject.launch('hang')
  await bounded(owned.stop(), 'immediate native startup cancellation')
  const result = await owned.completed
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(result.error, undefined)
  await subject.assertDead()
})

nativeTest('transport close during startup sends no discovery requests', async t => {
  const subject = await sandbox(t)
  const { server } = await subject.manager()
  const transport = new McpStdioTransport(await prepareMcpLaunch(server, 'fixture-revision', fixtureEnv))
  subject.own(() => transport.close())
  const start = transport.start()
  const rejected = assert.rejects(start, /closed before startup|closed during startup/)
  await bounded(transport.close(), 'transport startup close')
  await rejected
  assert.deepEqual(await subject.messages(), [])
  assert.deepEqual(await subject.pids(), [])
})

nativeTest('initialization cancellation kills the process and never reconnects', async t => {
  const subject = await sandbox(t), { manager, starts } = await subject.manager('hang')
  const controller = new AbortController()
  const connected = bounded(manager.connect('fixture', async () => true, controller.signal), 'cancelled initialization', 25_000)
  await until(async () => (await subject.messages()).some(message => message.method === 'initialize'), 'native initialize request')
  const pids = await subject.pids()
  controller.abort()
  assert.equal(await connected, false)
  assert.equal(starts(), 1)
  assert.equal(manager.statuses()[0].state, 'error')
  assert.ok(pids.every(dead))
  const before = (await subject.messages()).length
  await wait(50)
  assert.equal((await subject.messages()).length, before)
  assert.equal(starts(), 1)
})
