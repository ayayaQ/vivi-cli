// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { basicProbes, repeatProbes, paste, pasteText, finish, restorationProbe }
  from './fixtures/windows-conpty/protocol.mjs'

const fixtures = fileURLToPath(new URL('./fixtures/windows-conpty/', import.meta.url))
const defaultRepository = fileURLToPath(new URL('../', import.meta.url))
const tuple = probe => [probe.key, probe.shift, probe.ctrl, probe.event, probe.source]
const environment = () => {
  // Do not pass provider tokens, credentials, runtime debug flags, or arbitrary user environment to the child.
  const allowed = new Set(['path', 'systemroot', 'windir', 'temp', 'tmp', 'comspec', 'pathext'])
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toLowerCase()))),
    TERM: 'xterm-256color', NO_COLOR: '1', OTUI_DEBUG: '0', OTUI_DEBUG_FFI: '0', OTUI_TRACE_FFI: '0', OTUI_DUMP_CAPTURES: '0' }
}

// This is a distinct fallback contract, not a successful native-modifier assertion.
export function assertFallbackTransportReport(host, child) {
  assert.equal(host.hostFailed, undefined)
  assert.equal(host.ExitCode, 0)
  assert.equal(host.Backend, 'inbox')
  assert.equal(host.Queries, 0, 'This stock backend answers locally, rather than forwarding the query')
  assert.equal(host.QueryReplies, 0)
  assert.ok(host.OuterEnablesAtReady >= 1)
  assert.equal(host.OuterModeAtRestore, true)
  assert.equal(host.OuterDisablesBeforeTeardown, 0)
  assert.equal(host.OuterRestorationReassertions, 0)
  assert.equal(host.OutputDrained, true)
  assert.equal(host.TeardownCompleted, true)
  assert.equal(child.platform, 'win32')
  assert.equal(child.stdinTTY, true)
  assert.equal(child.stdoutTTY, true)
  assert.equal(child.failed, false)
  assert.equal(child.windows.modeReply, 2, 'Fallback must be exercised, not accidentally replaced by the modern mode-1 route')
  assert.equal(child.windows.enableRequested, false)
  assert.equal(child.windows.enterRecordsObserved, 0)
  assert.equal(child.windows.closed, true)
  assert.equal(child.windows.waiting, false)
  assert.equal(child.windows.restorationFailed, false)
  assert.deepEqual(child.controls, { query: 1, enable: 0, disable: 0 })
  assert.deepEqual(child.probes.map(tuple), [
    ['enter', false, false, 'press', 'raw'],
    ['enter', false, false, 'press', 'raw'],
    ['linefeed', false, false, 'press', 'raw'],
    ...Array.from({ length: 5 }, () => ['enter', false, false, 'press', 'raw'])
  ], 'Shift+Enter is indistinguishable from Enter here; Ctrl+J stays raw linefeed')
  assert.equal(child.paste.count, 1)
  assert.equal(child.paste.matchesKnownFixture, true)
  assert.equal(child.paste.byteCount, Buffer.byteLength(pasteText))
  assert.equal(child.paste.rawStartObserved, true)
  assert.equal(child.paste.rawEndObserved, true)
  assert.equal(child.unknownKeyCount, 0)
  assert.equal(child.releaseCount, 0)
  assert.deepEqual(child.restoration, { rawCR: true, win32Records: 0, rawModeRestored: true, flowingRestored: true })
}

// A normal npm test on other platforms records a skip, not synthetic Windows success.
test('stock Windows ConPTY keeps raw Enter/Ctrl+J fallback, literal paste and cleanup', {
  skip: process.platform !== 'win32' ? 'Requires a real Windows OS ConPTY' : false,
  timeout: 55000
}, async t => {
  assert.equal(process.arch, 'x64', 'This acceptance target is Windows x64')
  const repository = resolve(process.env.VIVI_TEST_CONPTY_REPOSITORY ?? defaultRepository)
  await access(join(repository, 'src', 'windows-input.ts'))
  const env = environment()
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
  assert.ok(systemRoot && isAbsolute(systemRoot), 'Windows must provide SystemRoot')
  const powershell = process.env.VIVI_TEST_POWERSHELL ?? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  assert.ok(isAbsolute(powershell), 'Select an absolute installed PowerShell executable')
  await access(powershell)
  const requestedBun = process.env.VIVI_TEST_BUN ?? 'bun'
  let bun = requestedBun
  if (!isAbsolute(bun)) {
    const found = spawnSync(join(systemRoot, 'System32', 'where.exe'), [requestedBun], { env, encoding: 'utf8', timeout: 5000 })
    assert.equal(found.status, 0, 'Install the pinned Bun runtime before running Windows ConPTY acceptance')
    bun = found.stdout.trim().split(/\r?\n/)[0]
  }
  await access(bun)
  const version = spawnSync(bun, ['--version'], { env, encoding: 'utf8', timeout: 5000 })
  assert.equal(version.status, 0)
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+(?:[-+].*)?$/)
  const directory = await mkdtemp(join(tmpdir(), 'vivi-conpty-known-probes-'))
  const prefix = join(directory, 'probe')
  const configuration = join(directory, 'configuration.json')
  try {
    await writeFile(configuration, JSON.stringify({ bun, child: join(fixtures, 'probe.ts'), repository, prefix,
      basic: basicProbes, repeats: repeatProbes, paste, finish, restore: restorationProbe, expectReset: false }), { mode: 0o600 })
    // No shell, no windows terminal UI, no keyboard hooks, and no redirected child stdin.
    const hostProcess = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      join(fixtures, 'host.ps1'), '-Configuration', configuration], {
      cwd: repository, env, encoding: 'utf8', timeout: 45000, maxBuffer: 64 * 1024, windowsHide: true,
      killSignal: 'SIGKILL'
    })
    assert.equal(hostProcess.error, undefined, 'Private ConPTY supervisor failed or exceeded its deadline')
    const line = hostProcess.stdout.trim().split(/\r?\n/).findLast(value => value.startsWith('{'))
    assert.ok(line, 'ConPTY host must return bounded protocol metadata')
    const host = JSON.parse(line)
    let progress = { unavailable: true }
    try { progress = JSON.parse(await readFile(`${prefix}.progress.json`, 'utf8')) } catch { }
    let child = { unavailable: true }
    try { child = JSON.parse(await readFile(`${prefix}.json`, 'utf8')) } catch { }
    assert.equal(hostProcess.status, 0, `ConPTY host failed: ${JSON.stringify({
      phase: host.phase, errorType: host.errorType, protocol: host.progress, child: progress, report: child
    })}`)
    assert.equal(child.bun, version.stdout.trim())
    // The diagnostic contains only allowlisted probe events and protocol/restoration metadata.
    assertFallbackTransportReport(host, child)
    t.diagnostic(JSON.stringify({ support: 'raw-fallback-only', bun: child.bun, os: host.OsVersion, conhost: host.ConhostVersion,
      modeReply: child.windows.modeReply, enableRequested: child.windows.enableRequested,
      enterRecordsObserved: child.windows.enterRecordsObserved, probes: child.probes,
      paste: child.paste, restoration: child.restoration, outerRestorationReassertions: host.OuterRestorationReassertions }))
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
