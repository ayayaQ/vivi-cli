// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { launchWindowsCommand } from '../dist/command-windows.js'

const fixture = resolve('test/fixtures/windows-command-process.mjs')
const options = { skip: process.platform !== 'win32', timeout: 20_000 }
const env = { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows' }
const powershell = join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
function diagnostics(t, label) {
  const started = performance.now()
  return { onPhase: phase => t.diagnostic(`${label}:${phase}:${Math.round(performance.now() - started)}ms`) }
}
async function collect(stream) { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks) }
async function records(file) {
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    try { const entries = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse); if (entries.length >= 3) return entries }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    await sleep(10)
  }
  throw new Error('Process fixture did not become ready')
}
function assertGone(entries) {
  for (const { pid } of entries) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `fixture process ${pid} remained alive`)
}

test('Windows native backend preserves exact argv and raw binary output', options, async t => {
  const args = ['', 'white space', 'a"b', '\\', 'ends\\', '\\"', '&|<>^%PATH%', '$(Write-Output bad)', '中文🙂', 'line\nline']
  const command = await launchWindowsCommand({ executable: process.execPath, args: [fixture, 'argv', '-', ...args], cwd: process.cwd(), env }, diagnostics(t, 'raw-argv-SystemRoot-only'))
  t.after(() => command.stop())
  const out = collect(command.stdout), err = collect(command.stderr)
  assert.deepEqual(await command.completed, { exitCode: 0 })
  assert.deepEqual(JSON.parse((await out).toString()), args)
  assert.deepEqual(await err, Buffer.from([0, 255, 13, 10]))
})
test('Windows explicit PowerShell -File receives literal argv through the managed parser', options, async t => {
  const args = ['', 'white space', 'a"b', 'ends\\', '中文🙂']
  const command = await launchWindowsCommand({ executable: powershell,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', resolve('test/fixtures/windows-command-argv.ps1'), ...args],
    cwd: process.cwd(), env }, diagnostics(t, 'raw-File-SystemRoot-only'))
  t.after(() => command.stop())
  const out = collect(command.stdout), err = collect(command.stderr)
  assert.deepEqual(await command.completed, { exitCode: 0 })
  assert.deepEqual(JSON.parse((await out).toString('utf8').trim()), args)
  assert.equal((await err).length, 0)
})
test('Windows explicit PowerShell -EncodedCommand runs only the supplied fixed script', options, async t => {
  const encoded = Buffer.from('[Console]::Out.WriteLine("fixed-powershell-fixture")', 'utf16le').toString('base64')
  const command = await launchWindowsCommand({ executable: powershell,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], cwd: process.cwd(), env }, diagnostics(t, 'raw-EncodedCommand-SystemRoot-only'))
  t.after(() => command.stop())
  const out = collect(command.stdout), err = collect(command.stderr)
  assert.deepEqual(await command.completed, { exitCode: 0 })
  assert.equal((await out).toString('utf8').trim(), 'fixed-powershell-fixture')
  assert.equal((await err).length, 0)
})

test('Windows job cleans detached grandchildren after the approved root and middle exit', options, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'vivi-windows-job-'))
  try {
    const file = join(folder, 'pids.jsonl')
    const command = await launchWindowsCommand({ executable: process.execPath, args: [fixture, 'orphan', file], cwd: process.cwd(), env })
    const out = collect(command.stdout), err = collect(command.stderr)
    const entries = await records(file)
    assert.deepEqual(await command.completed, { exitCode: 17 })
    await Promise.all([out, err])
    assertGone(entries)
  } finally { await rm(folder, { recursive: true, force: true }) }
})

test('Windows stop cleans a running root and its detached orphaned grandchild', options, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'vivi-windows-stop-'))
  try {
    const file = join(folder, 'pids.jsonl')
    const command = await launchWindowsCommand({ executable: process.execPath, args: [fixture, 'hang', file], cwd: process.cwd(), env })
    const out = collect(command.stdout), err = collect(command.stderr)
    const entries = await records(file)
    await command.stop()
    assert.equal((await command.completed).signal, 'SIGTERM')
    await Promise.all([out, err])
    assertGone(entries)
  } finally { await rm(folder, { recursive: true, force: true }) }
})


test('Windows kill-on-close cleans descendants when the PowerShell helper is forcibly lost', options, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'vivi-windows-helper-loss-'))
  try {
    const file = join(folder, 'pids.jsonl')
    let helper
    const command = await launchWindowsCommand({ executable: process.execPath, args: [fixture, 'hang', file], cwd: process.cwd(), env }, {
      spawn(executable, args, options) { helper = spawn(executable, args, options); return helper },
    })
    const out = collect(command.stdout), err = collect(command.stderr)
    const entries = await records(file)
    helper.kill('SIGKILL')
    assert.match((await command.completed).error, /without verified tree cleanup/)
    await Promise.all([out, err])
    const until = Date.now() + 5000
    while (true) {
      try { assertGone(entries); break }
      catch (error) { if (Date.now() >= until) throw error; await sleep(10) }
    }
  } finally { await rm(folder, { recursive: true, force: true }) }
})


// One bounded harmless CI probe compares the failing stop path with temp setup
// present. Output contains only package constants; diagnostics log no paths/args.
test('Windows phase diagnostic verifies stop with SystemRoot and captured temp setup', options, async t => {
  const setup = { ...env }
  for (const name of ['WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    const entry = Object.entries(process.env).find(([key, value]) => key.toUpperCase() === name && value !== undefined)
    if (entry?.[1] !== undefined) setup[name] = entry[1]
  }
  const command = await launchWindowsCommand({ executable: process.execPath,
    args: ['-e', 'process.stdout.write("native-phase-fixture-ready\\n");setInterval(()=>{},1000)'],
    cwd: process.cwd(), env: setup }, diagnostics(t, 'stop-SystemRoot-with-temp'))
  t.after(() => command.stop())
  let text = '', ready
  const received = new Promise(resolve => { ready = resolve })
  command.stdout.on('data', chunk => {
    text += chunk.toString('utf8')
    if (text.includes('native-phase-fixture-ready\n')) ready()
  })
  const err = collect(command.stderr)
  let timer
  try {
    await Promise.race([received, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native phase fixture did not become ready within 5000ms')), 5000)
    })])
  } finally { clearTimeout(timer) }
  t.diagnostic('stop-SystemRoot-with-temp:fixture-ready')
  await command.stop()
  const result = await command.completed
  t.diagnostic(result.error ? 'stop-SystemRoot-with-temp:fixture-error' : 'stop-SystemRoot-with-temp:fixture-stopped')
  assert.equal(result.error, undefined)
  assert.equal(result.signal, 'SIGTERM')
  assert.equal(text, 'native-phase-fixture-ready\n')
  assert.equal((await err).length, 0)
})
