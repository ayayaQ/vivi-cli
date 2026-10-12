// SPDX-License-Identifier: Apache-2.0
// Temporary owned-fixture evidence. No providers, network, credentials or UI.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { MCP_LIMITS } from '../dist/mcp-catalog.js'
import { launchWindowsMcp } from '../dist/mcp-windows.js'

const frameKinds = new Set(['started', 'stdout', 'stderr', 'error', 'exit'])
// Observe only first fixed frame kinds. Never retain or report frame payloads.
function frameObserver(record) {
  let pending = '', discarding = false
  const observed = new Set()
  return chunk => {
    for (const part of chunk.toString('utf8').split(/(?<=\n)/)) {
      if (!discarding) pending += part
      if (pending.length > 24_001) { pending = ''; discarding = true }
      if (!part.endsWith('\n')) continue
      if (!discarding) {
        try {
          const kind = JSON.parse(pending).type
          if (frameKinds.has(kind) && !observed.has(kind)) {
            observed.add(kind); record(`frame-${kind}`)
          }
        } catch { /* Invalid bytes remain the production parser's responsibility. */ }
      }
      pending = ''; discarding = false
    }
  }
}

async function bounded(promise, ms, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label)), ms)
    })])
  } finally { clearTimeout(timer) }
}

test('diagnostic records only first fixed frame kinds across chunks', () => {
  const records = [], observe = frameObserver(kind => records.push(kind))
  const secret = 'never-report-owned-fixture-payload'
  observe(Buffer.from('{"type":"sta'))
  observe(Buffer.from('rted"}\n{"type":"stdout","data":"' + secret + '"}\n'))
  observe(Buffer.from('{"type":"stdout","data":"duplicate"}\n{"type":"unknown"}\n'))
  observe(Buffer.from('x'.repeat(30_000)))
  observe(Buffer.from('\n{"type":"exit","exitCode":0,"stopped":false}\n'))
  assert.deepEqual(records, ['frame-started', 'frame-stdout', 'frame-exit'])
  assert.equal(JSON.stringify(records).includes(secret), false)
})

test('Windows startup boundary after cold legacy discovery (warm observation)', {
  skip: process.platform !== 'win32', timeout: 45_000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-startup-evidence-'))
  const logFile = join(directory, 'log'), pidFile = join(directory, 'pid')
  const fixture = fileURLToPath(new URL('./fixtures/mcp-discovery-server.mjs', import.meta.url))
  const root = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'systemroot')?.[1]
  assert.ok(root, 'Existing Windows Node fixture requires SystemRoot')
  const events = [], seen = new Set(), startedAt = performance.now()
  const record = kind => {
    if (seen.has(kind)) return
    seen.add(kind); events.push({ kind, afterMs: Math.round(performance.now() - startedAt) })
  }
  let helper, helperClosed = false, owned, categoryTimer, nativeResult, readyResolved = false
  t.after(async () => {
    clearTimeout(categoryTimer)
    try {
      if (owned) await bounded(owned.stop(), 8_000, 'Owned diagnostic cleanup exceeded its existing fixture bound')
    } finally {
      try {
        if (helper && !helperClosed) {
          const closed = new Promise(resolve => helper.once('close', resolve))
          helper.kill('SIGKILL')
          await bounded(closed, 5_000, 'Owned diagnostic helper failed to close')
        }
        const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''))
        if (Number.isSafeInteger(pid) && pid > 0) {
          let alive = true
          try { process.kill(pid, 0) } catch (error) {
            if (error.code !== 'ESRCH') throw error
            alive = false
          }
          assert.equal(alive, false, 'Owned diagnostic target must be dead after helper cleanup')
        }
      } finally { await rm(directory, { recursive: true, force: true }) }
    }
  }, { timeout: 30_000 })
  // Same 10s category / 5s helper cleanup as McpManager + McpStdioTransport.
  // This measures readiness only, not an SDK handshake or metadata operation.
  categoryTimer = setTimeout(() => {
    record('category-deadline')
    void owned?.stop().catch(() => undefined)
  }, MCP_LIMITS.categoryMs)
  let readyFailure = false
  try {
    owned = await launchWindowsMcp({ executable: process.execPath,
      args: [fixture, 'pages', logFile, pidFile], cwd: directory, env: { SYSTEMROOT: root } }, {
      hostEnv: process.env, cleanupTimeoutMs: 5_000,
      spawn(executable, argv, settings) {
        record('spawn-call')
        helper = spawn(executable, argv, settings)
        helper.once('spawn', () => record('helper-spawn'))
        helper.once('error', () => record('helper-error'))
        helper.once('close', () => { helperClosed = true; record('helper-close') })
        helper.stdin.once('finish', () => record('control-finished'))
        helper.stdout.on('data', frameObserver(record))
        return helper
      },
    })
    owned.stdout.on('data', () => undefined)
    owned.stderr.on('data', () => undefined)
    try { await owned.ready; readyResolved = true; record('ready-resolved') }
    catch { readyFailure = true; record('ready-rejected') }
    clearTimeout(categoryTimer)
    record('stop-requested')
    await bounded(owned.stop(), 8_000, 'Owned diagnostic stop exceeded its existing fixture bound')
    nativeResult = await owned.completed
    record('completed')
  } finally {
    clearTimeout(categoryTimer)
    const pidText = await readFile(pidFile, 'utf8').catch(() => '')
    const logText = await readFile(logFile, 'utf8').catch(() => '')
    t.diagnostic(JSON.stringify({ event: 'owned-windows-startup-boundary', observation: 'after-cold-legacy-warm',
      node: process.version, availableParallelism: availableParallelism(), logicalCpus: cpus().length,
      categoryMs: MCP_LIMITS.categoryMs, cleanupMs: 5_000, events,
      readyResolved, helperClosed, fixturePidRecorded: /^\d+\s*$/.test(pidText),
      fixtureStartRecorded: logText.split('\n').some(line => line.includes('"event":"start"')),
      nativeResult: nativeResult && { exitCode: nativeResult.exitCode,
        errorPresent: Boolean(nativeResult.error), signal: nativeResult.signal ?? null,
        cleanupUnverified: nativeResult.error?.startsWith('Windows MCP helper closed without verified tree cleanup') ?? false } }))
  }
  assert.equal(readyFailure, false, 'Owned helper readiness must meet the unchanged category deadline')
  assert.equal(readyResolved, true)
  assert.equal(nativeResult.error, undefined, 'Owned helper must verify tree cleanup')
  assert.equal(helperClosed, true)
})
