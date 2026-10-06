// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { basicProbes, repeatProbes, paste, pasteText, finish, restorationProbe, expectedProbes }
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

export function assertTransportReport(host, child, expectation = 'fixed') {
  assert.equal(host.hostFailed, undefined, `Private ConPTY host failed in ${host.phase ?? 'unknown phase'}`)
  assert.equal(host.ExitCode, 0)
  assert.equal(host.Queries, 1, 'Child mode query must reach the simulated outer terminal')
  assert.equal(host.QueryReplies, 1, 'Only the known outer mode=1 response is sent')
  assert.ok(host.OuterEnablesAtReady >= 1, 'ConPTY must request the outer Win32 transport')
  assert.equal(host.OuterModeAtRestore, true, 'Outer Win32 transport must remain active after child close')
  assert.equal(host.OutputDrained, true)
  assert.equal(host.TeardownCompleted, true)
  assert.equal(child.platform, 'win32')
  assert.equal(child.stdinTTY, true)
  assert.equal(child.stdoutTTY, true)
  assert.equal(child.failed, false)
  assert.equal(child.windows.modeReply, 1)
  assert.equal(child.windows.closed, true)
  assert.equal(child.windows.waiting, false)
  assert.equal(child.windows.restorationFailed, false)
  assert.equal(child.paste.count, 1)
  assert.equal(child.paste.matchesKnownFixture, true, 'Bracketed paste and its CR/LF/Unicode must stay opaque')
  assert.equal(child.paste.byteCount, Buffer.byteLength(pasteText))
  assert.equal(child.unknownKeyCount, 0, 'Pasted text must not be treated as keys')
  assert.equal(child.releaseCount, 0, 'Key-up records must not generate extra editor actions')
  assert.deepEqual(child.restoration, { rawCR: true, win32Records: 0, rawModeRestored: true, flowingRestored: true })
  if (expectation === 'legacy') {
    assert.equal(child.windows.enableRequested, false)
    assert.equal(child.windows.enterRecordsObserved, 0)
    assert.deepEqual(child.controls, { query: 1, enable: 0, disable: 0 })
    assert.deepEqual(child.probes.slice(0, 3).map(tuple), [
      ['enter', false, false, 'press', 'raw'],
      ['enter', false, false, 'press', 'raw'],
      ['linefeed', false, false, 'press', 'raw']
    ], 'The original two-layer failure must be observed before calling this a regression reproduction')
    assert.equal(host.OuterRestorationReassertions, 0)
    assert.equal(host.OuterDisablesBeforeTeardown, 0)
  } else {
    assert.equal(expectation, 'fixed')
    assert.equal(child.windows.enableRequested, true, 'Mode=1 still needs an explicit inner-consumer request')
    assert.deepEqual(child.controls, { query: 1, enable: 1, disable: 1 })
    assert.ok(child.windows.enterRecordsObserved >= 9, 'Both Enter down and release records must reach the bridge')
    assert.deepEqual(child.probes.map(tuple), expectedProbes,
      'Shift+Enter, Ctrl+J, repeats and a fresh tap after release must retain their identity')
    assert.equal(host.OuterDisablesBeforeTeardown, 1, 'The consumer reset must reach the outer transport exactly once')
    assert.equal(host.OuterRestorationReassertions, 1, 'Count only the outer 9001l followed by 9001h restoration pair')
  }
}

// A normal npm test on other platforms records a skip, not synthetic Windows success.
test('real Windows ConPTY preserves Bun Enter modifiers, paste, repeats and restoration', {
  skip: process.platform !== 'win32' ? 'Requires a real Windows OS ConPTY' : false,
  timeout: 55000
}, async t => {
  assert.equal(process.arch, 'x64', 'This acceptance target is Windows x64')
  const repository = resolve(process.env.VIVI_TEST_CONPTY_REPOSITORY ?? defaultRepository)
  const expectation = process.env.VIVI_TEST_CONPTY_EXPECT ?? 'fixed'
  assert.ok(expectation === 'fixed' || expectation === 'legacy')
  await access(join(repository, 'src', 'windows-input.ts'))
  const env = environment()
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
  assert.ok(systemRoot && isAbsolute(systemRoot), 'Windows must provide SystemRoot')
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
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
      basic: basicProbes, repeats: repeatProbes, paste, finish, restore: restorationProbe, expectReset: expectation === 'fixed' }), { mode: 0o600 })
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
    assert.equal(hostProcess.status, 0, `ConPTY host failed in ${host.phase ?? 'unknown phase'}`)
    const child = JSON.parse(await readFile(`${prefix}.json`, 'utf8'))
    assert.equal(child.bun, version.stdout.trim())
    // The diagnostic contains only allowlisted probe events and protocol/restoration metadata.
    assertTransportReport(host, child, expectation)
    t.diagnostic(JSON.stringify({ expectation, bun: child.bun, os: host.OsVersion, conhost: host.ConhostVersion,
      modeReply: child.windows.modeReply, enableRequested: child.windows.enableRequested,
      enterRecordsObserved: child.windows.enterRecordsObserved, probes: child.probes,
      paste: child.paste, restoration: child.restoration, outerRestorationReassertions: host.OuterRestorationReassertions }))
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
