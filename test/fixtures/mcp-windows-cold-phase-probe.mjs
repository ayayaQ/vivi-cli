// SPDX-License-Identifier: Apache-2.0
// Diagnostic only: no provider, network, MCP invocation or resource read.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchWindowsMcp } from '../../dist/mcp-windows.js'
import { MCP_LIMITS } from '../../dist/mcp-catalog.js'
import { instrumentWindowsMcpArgv, phaseCollector } from '../helpers/mcp-cold-phases.mjs'

assert.equal(process.platform, 'win32', 'Cold native phases require actual Windows')
const [mode, instrumentation] = process.argv.slice(2)
assert(['cancel', 'observe'].includes(mode)); assert(['phases', 'baseline'].includes(instrumentation))
const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-cold-phase-'))
const startedAt = performance.now(), phases = phaseCollector(() => performance.now() - startedAt)
let child, owned, result, startup = 'pending', readyAfterMs, stopAfterMs, helperClosed = false, fixtureCleanupFailed = false
async function bounded(promise, ms) {
  let timer
  try { return await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms) })]) }
  finally { clearTimeout(timer) }
}
const deadlineMs = mode === 'cancel' ? MCP_LIMITS.categoryMs : 90_000
const systemRoot = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1]
assert(systemRoot)
try {
  owned = await launchWindowsMcp({ executable: process.execPath,
    args: [fileURLToPath(new URL('./mcp-discovery-server.mjs', import.meta.url)), 'normal', join(directory, 'log'), join(directory, 'pid')],
    cwd: directory, env: { SYSTEMROOT: systemRoot } }, { hostEnv: process.env, cleanupTimeoutMs: 5000,
    spawn(executable, args, options) {
      child = spawn(executable, instrumentation === 'phases' ? instrumentWindowsMcpArgv(args) : args, options)
      child.stderr.on('data', chunk => phases.accept(chunk))
      child.once('close', () => { helperClosed = true })
      return child
    } })
  owned.stdout.resume(); owned.stderr.resume()
  const ready = owned.ready.then(() => { startup = 'ready'; readyAfterMs = Math.round(performance.now() - startedAt) }, () => { if (startup === 'pending') startup = 'rejected' })
  await bounded(ready, deadlineMs)
  if (startup === 'pending') startup = 'deadline'
  stopAfterMs = Math.round(performance.now() - startedAt)
  void owned.stop().catch(() => undefined)
  result = await bounded(owned.completed, 8000)
} finally {
  if (child && !helperClosed) {
    child.kill('SIGKILL')
    await bounded(new Promise(resolve => child.once('close', resolve)), 5000)
  }
}
const pidText = await readFile(join(directory, 'pid'), 'utf8').catch(() => '')
const logText = await readFile(join(directory, 'log'), 'utf8').catch(() => '')
let fixtureAlive = false
if (/^\d+\s*$/.test(pidText)) {
  const pid = Number(pidText.trim())
  try { process.kill(pid, 0); fixtureAlive = true; process.kill(pid, 'SIGKILL') }
  catch (error) { if (error.code !== 'ESRCH') fixtureCleanupFailed = true }
}
try { await rm(directory, { recursive: true, force: true }) } catch { fixtureCleanupFailed = true }
const output = { event: 'owned-windows-mcp-cold-phases', node: process.version, mode, instrumentation,
  deadlineMs, elapsedMs: Math.round(performance.now() - startedAt), startup, readyAfterMs, stopAfterMs,
  phases: phases.phases, phaseOverflow: phases.overflow, helperClosed, completionObserved: result !== undefined,
  exitCode: Number.isSafeInteger(result?.exitCode) ? result.exitCode : null,
  signal: ['SIGTERM', 'SIGKILL'].includes(result?.signal) ? result.signal : null,
  errorPresent: typeof result?.error === 'string',
  nativeCleanupReported: result !== undefined && result.error === undefined,
  fixturePidRecorded: /^\d+\s*$/.test(pidText), fixtureStartRecorded: logText.split('\n').some(line => line.includes('"event":"start"')),
  fixtureAliveAfterCompletion: fixtureAlive, fixtureCleanupFailed }
console.log(JSON.stringify(output))
// Unknown cleanup or incomplete startup is evidence, never a passing native gate.
if (startup !== 'ready' || !output.nativeCleanupReported || !helperClosed || fixtureAlive || fixtureCleanupFailed || phases.overflow) process.exitCode = 1
