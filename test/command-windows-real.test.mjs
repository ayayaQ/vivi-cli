// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { launchWindowsCommand } from '../dist/command-windows.js'
import { TrustedCommandWorkspace, COMMAND_LIMITS, captureCommandEnvironment, commandEnvironment } from '../dist/commands.js'

const fixture = resolve('test/fixtures/windows-command-process.mjs')
const options = { skip: process.platform !== 'win32', timeout: 20_000 }
const env = { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows' }
const powershell = join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const powershell7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const hostProbeSource = 'process.stdout.write(JSON.stringify(Object.keys(process.env).map(name=>name.toUpperCase()).sort())+"\\n");process.stdout.write("native-phase-fixture-ready\\n");setInterval(()=>{},1000)'
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

test('owned PowerShell argv fixture uses BCL encoding and the exact built-in JSON formatter', async () => {
  const source = await readFile(resolve('test/fixtures/windows-command-argv.ps1'), 'utf8')
  assert.ok(source.includes('[Text.UTF8Encoding]::new($false)'))
  assert.ok(source.includes("[IO.Path]::Combine($PSHOME, 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')"))
  assert.ok(source.includes('Import-Module -Name $manifest -ErrorAction Stop'))
  assert.ok(source.indexOf('Import-Module') < source.indexOf('Microsoft.PowerShell.Utility\\ConvertTo-Json'))
  assert.ok(!/New-Object|\$(?:HOME|Host|PID|PSHOME)\b\s*=/i.test(source))
})
test('realistic host snapshot forwards only explicit supported names and its target reports no values', () => {
  const host = { PATH: 'fixed-path', SystemRoot: env.SystemRoot, WINDIR: 'fixed-windir', TEMP: 'fixed-temp', TMP: 'fixed-tmp', TMPDIR: 'fixed-tmpdir', LANG: 'fixed-lang', LC_ALL: 'fixed-lc-all', LC_CTYPE: 'fixed-lc-ctype', TZ: 'fixed-tz' }
  const expectedNames = Object.keys(host).sort()
  Object.assign(host, { PSModulePath: 'hostile', OPENAI_API_KEY: 'private', ANTHROPIC_API_KEY: 'private', USERPROFILE: 'private', NODE_OPTIONS: 'private' })
  const snapshot = commandEnvironment(captureCommandEnvironment(host))
  assert.deepEqual(Object.keys(snapshot).sort(), expectedNames)
  assert.equal(snapshot.PSModulePath, undefined)
  assert.equal(snapshot.OPENAI_API_KEY, undefined)
  assert.equal(snapshot.NODE_OPTIONS, undefined)
  assert.ok(hostProbeSource.includes('Object.keys(process.env)'))
  assert.ok(!/Object\.(?:values|entries)\(process\.env\)/.test(hostProbeSource))
})

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
// Windows PowerShell 5.1 can serialize first-use module progress to stderr,
// including on a direct launch. Accept only that complete fixed record grammar;
// error/warning streams, arbitrary XML/text and extra output remain failures.
const progressNumber = '-?[0-9]{1,10}'
const progressType = '(?:<TN RefId="[0-9]{1,10}"><T>System\\.Management\\.Automation\\.PSCustomObject</T><T>System\\.Object</T></TN>|<TNRef RefId="[0-9]{1,10}" ?/>)'
const progressRecord = '<Obj S="progress" RefId="[0-9]{1,10}">' + progressType +
  '<MS><I64 N="SourceId">[0-9]{1,10}</I64><PR N="Record"><AV>Preparing modules for first use\\.</AV>' +
  '<AI>' + progressNumber + '</AI><Nil ?/><PI>' + progressNumber + '</PI><PC>' + progressNumber + '</PC>' +
  '<T>Completed</T><SR>' + progressNumber + '</SR><SD> *</SD></PR></MS></Obj>'
const progressEnvelope = new RegExp('^(?:#< CLIXML\\r?\\n<Objs Version="1\\.1\\.0\\.1" xmlns="http://schemas\\.microsoft\\.com/powershell/2004/04">(?:' + progressRecord + '){1,16}</Objs>\\r?\\n?){1,16}$')
function ordinaryPowerShellOutput(output) {
  const expected = 'ordinary-powershell-fixture\r\n'
  if (Buffer.byteLength(output) > 16_384 || output.split(expected).length !== 2) return false
  const remainder = output.replace(expected, '')
  return remainder === '' || ((remainder.match(/<Obj /g)?.length ?? 0) <= 16 && progressEnvelope.test(remainder))
}
test('ordinary PowerShell output accepts only the exact stdout and completed first-use progress', () => {
  const record = '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>'
  const expected = 'ordinary-powershell-fixture\r\n'
  const envelope = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' + record + '</Objs>'
  assert(ordinaryPowerShellOutput(expected))
  assert(ordinaryPowerShellOutput(envelope + expected))
  assert(ordinaryPowerShellOutput(expected + envelope))
  assert(ordinaryPowerShellOutput(expected + envelope.replace(record, record + record.replace('RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN>', 'RefId="1"><TNRef RefId="0" />'))))
  for (const output of [envelope, expected.repeat(2), 'other' + expected, expected + 'other', expected + envelope.repeat(17),
    expected + envelope.replace('S="progress"', 'S="error"'), expected + envelope.replace('S="progress"', 'S="warning"'),
    expected + envelope.replace('S="progress"', 'S="unknown"'), expected + envelope.replace('<T>Completed</T>', ''), expected + envelope.replace('<AI>0</AI>', ''),
    expected + envelope.replace('<Nil />', ''), expected + envelope.replace('<PI>-1</PI>', ''), expected + envelope.replace('<SD> </SD>', ''),
    expected + envelope.replace('Preparing modules for first use.', 'Different activity'), expected + envelope.replace('<SR>-1</SR>', '<Unknown />'),
    expected + envelope.replace('<SD> </SD>', '<SD>&amp;</SD>'), expected + '<!DOCTYPE Objs>' + envelope,
    expected + envelope.replace('</Objs>', '<S S="Error">unexpected</S></Objs>'), expected + 'x'.repeat(16_384)]) {
    assert.equal(ordinaryPowerShellOutput(output), false)
  }
})
test('ordinary unqualified PowerShell completes an explicitly approved bounded workspace request', { ...options, timeout: 80_000 }, async t => {
  // The direct-host baseline took 27s on the same Windows CI image. This
  // representative request chooses 50s within the existing public maximum;
  // the 30s product default and all short-timeout/lifecycle gates stay fixed.
  const timeoutMs = 50_000
  assert.equal(COMMAND_LIMITS.defaultTimeoutMs, 30_000)
  assert.ok(timeoutMs <= COMMAND_LIMITS.maximumTimeoutMs)
  const workspace = await TrustedCommandWorkspace.open(process.cwd(), captureCommandEnvironment(process.env))
  t.after(() => workspace.shutdown())
  const encoded = Buffer.from("Write-Output 'ordinary-powershell-fixture'", 'utf16le').toString('base64')
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
  const approvals = []
  const context = { launchId: 'native-fixture-launch', sessionId: 'native-fixture-session', runId: 'native-fixture-run', accountRevision: 'native-fixture-account',
    canApprove: () => true, isCurrent: () => true, async approve(request) {
      approvals.push(request)
      if (request.call.name === 'command_start') {
        assert.deepEqual(request.call.arguments.args, args)
        assert.equal(request.call.arguments.timeoutMs, timeoutMs)
        assert.ok(request.description.includes('Hard timeout: 50000 ms'))
        assert.ok(request.description.includes('unsandboxed'))
      }
      return true
    } }
  const signal = new AbortController().signal
  assert.equal(await workspace.enable(context, signal), true)
  const owner = 'native-fixture-launch:native-fixture-session:native-fixture-run'
  let result = JSON.parse((await workspace.start({ id: 'native-ordinary-start', name: 'command_start',
    arguments: { executable: powershell, args, timeoutMs, yieldMs: 0 } }, context, signal)).content)
  let output = result.output
  while (result.state === 'running') {
    result = JSON.parse((await workspace.poll(result.executionId, owner, 2000)).content)
    output += result.output
  }
  assert.equal(approvals.length, 2)
  assert.equal(result.state, 'exited')
  assert.equal(result.exitCode, 0)
  assert.equal(result.truncated, false)
  if (!ordinaryPowerShellOutput(output)) {
    const known = new Set(['Objs', 'Obj', 'TN', 'TNRef', 'T', 'MS', 'I64', 'PR', 'AV', 'AI', 'Nil', 'PI', 'PC', 'SR', 'SD'])
    t.diagnostic('first-use-progress-tag-shape:' + [...output.matchAll(/<([a-z0-9]+)\b/gi)].slice(0, 80).map(match => known.has(match[1]) ? match[1] : 'unknown').join(','))
  }
  assert.ok(ordinaryPowerShellOutput(output), 'Expected exact stdout and only completed first-use module progress')
})
for (const mode of ['ordinary', 'argv']) test(`installed PowerShell7 ${mode} compatibility under the actual generated environment`, options, async t => {
  const info = await lstat(powershell7)
  assert.ok(info.isFile() && !info.isSymbolicLink())
  assert.equal((await realpath(powershell7)).toLowerCase(), powershell7.toLowerCase())
  const targetEnv = commandEnvironment(captureCommandEnvironment(process.env))
  const literals = ['', 'white space', 'a"b', 'ends\\', '&|<>^%PATH%', '$(Write-Output bad)', '中文🙂']
  const args = mode === 'ordinary'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from("Write-Output 'ordinary-pwsh7-fixture'", 'utf16le').toString('base64')]
    : ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', resolve('test/fixtures/windows-command-argv.ps1'), ...literals]
  const command = await launchWindowsCommand({ executable: powershell7, args, cwd: process.cwd(), env: targetEnv }, diagnostics(t, `PowerShell7-${mode}-host-environment`))
  t.after(() => command.stop())
  const out = collect(command.stdout), err = collect(command.stderr)
  assert.deepEqual(await command.completed, { exitCode: 0 })
  if (mode === 'ordinary') assert.equal((await out).toString('utf8').trim(), 'ordinary-pwsh7-fixture')
  else assert.deepEqual(JSON.parse((await out).toString('utf8').trim()), literals)
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


// The realistic host snapshot is distinct from helper setup. Target output
// contains only environment names and a constant, never any environment value.
test('Windows phase diagnostic verifies stop with the supported captured host environment', options, async t => {
  const setup = commandEnvironment(captureCommandEnvironment(process.env))
  const command = await launchWindowsCommand({ executable: process.execPath,
    args: ['-e', hostProbeSource],
    cwd: process.cwd(), env: setup }, diagnostics(t, 'stop-host-allowlist'))
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
  t.diagnostic('stop-host-allowlist:fixture-ready')
  await command.stop()
  const result = await command.completed
  t.diagnostic(result.error ? 'stop-host-allowlist:fixture-error' : 'stop-host-allowlist:fixture-stopped')
  assert.equal(result.error, undefined)
  assert.equal(result.signal, 'SIGTERM')
  const lines = text.split('\n')
  assert.equal(lines.length, 3)
  const [namesLine, readyLine, trailing] = lines
  const names = JSON.parse(namesLine)
  assert.deepEqual(names, Object.keys(setup).map(name => name.toUpperCase()).sort())
  assert.ok(!names.includes('PSMODULEPATH') && !names.includes('VIVI_COMMAND_PHASES') && !names.some(name => name.endsWith('_API_KEY')))
  assert.equal(readyLine, 'native-phase-fixture-ready')
  assert.equal(trailing, '')
  assert.equal((await err).length, 0)
})
