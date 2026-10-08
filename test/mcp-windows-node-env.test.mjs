// SPDX-License-Identifier: Apache-2.0
// Diagnostic only. Existing native MCP protocol gates remain authoritative.
// Both launch paths receive the same owned fixture, argv, cwd and frozen env.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { launchWindowsMcp } from '../dist/mcp-windows.js'

const fixtureFile = fileURLToPath(new URL('./fixtures/mcp-discovery-server.mjs', import.meta.url))
const directScript = fileURLToPath(new URL('./fixtures/mcp-windows-direct-node.ps1', import.meta.url))
const literals = Object.freeze(['', 'white space', '"quote"', 'backslash\\"quote', 'trailing\\', 'trailing\\\\', '&|<>^%PATH%', '$(literal data)', '中文🙂'])
const outputLimit = 65_536
const hostValue = name => Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]

function collectBounded(stream, limit = outputLimit) {
  const chunks = []
  let total = 0, overflow = false
  stream.on('data', chunk => {
    if (total + chunk.length > limit) overflow = true
    if (total < limit) chunks.push(chunk.subarray(0, limit - total))
    total += chunk.length
  })
  return { bytes: () => Buffer.concat(chunks), overflow: () => overflow }
}
async function bounded(promise, label, ms = 15_000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded its deadline`)), ms) })])
  } finally { clearTimeout(timer) }
}
function dead(pid) {
  try { process.kill(pid, 0); return false }
  catch (error) { if (error.code === 'ESRCH') return true; throw error }
}
async function cleanOwnedPid(pid, label) {
  assert.ok(Number.isInteger(pid) && pid > 0, `Invalid ${label} PID`)
  if (!dead(pid)) {
    try { process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    await bounded((async () => { while (!dead(pid)) await new Promise(resolve => setTimeout(resolve, 10)) })(), `${label} cleanup`, 5_000)
  }
}
async function installedPowerShell7() {
  const programFiles = hostValue('ProgramFiles')
  assert.ok(programFiles && win32.isAbsolute(programFiles), 'Direct Windows Node probe requires an absolute host ProgramFiles')
  const candidate = win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe')
  let info
  try { info = await lstat(candidate) }
  catch (error) { throw new Error(`Installed PowerShell 7 is unavailable at ${candidate}: ${error.code}`) }
  assert.ok(info.isFile() && !info.isSymbolicLink(), `Installed PowerShell 7 must be a regular file: ${candidate}`)
  const executable = await realpath(candidate)
  assert.equal(executable.toLowerCase(), candidate.toLowerCase(), `Unexpected installed PowerShell 7 path: ${executable}`)
  return executable
}
async function directProbe(powershell, input, spawnProbe = spawn) {
  const hostEnv = { PSModulePath: win32.join(win32.dirname(powershell), 'Modules') }
  for (const name of ['SystemRoot', 'TEMP', 'TMP']) {
    const value = hostValue(name)
    if (value !== undefined) hostEnv[name] = value
  }
  const child = spawnProbe(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', directScript], {
    shell: false, windowsHide: true, env: hostEnv, stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout = collectBounded(child.stdout, 200_000), stderr = collectBounded(child.stderr, 4096)
  let firstLine = '', ownedPid, completed = false
  child.stdout.on('data', chunk => {
    if (ownedPid !== undefined || firstLine.length > 4096) return
    firstLine += chunk.toString('utf8')
    const newline = firstLine.indexOf('\n')
    if (newline === -1) return
    try {
      const start = JSON.parse(firstLine.slice(0, newline))
      if (start.type === 'start' && Number.isInteger(start.pid) && start.pid > 0) ownedPid = start.pid
    } catch { /* The terminal parse below reports malformed wrapper output. */ }
  })
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })) })
  let inputError, finishInput, rejectInput
  const inputWritten = new Promise((resolve, reject) => { finishInput = resolve; rejectInput = reject })
  // Keep the listener attached through wrapper cleanup, including late errors.
  const failInput = error => { inputError ??= error; rejectInput(inputError) }
  child.stdin.on('error', failInput)
  inputWritten.catch(() => {})
  try {
    try { child.stdin.end(JSON.stringify(input) + '\n', error => { if (error) failInput(error); else finishInput() }) }
    catch (error) { failInput(error) }
    const [wrapper] = await bounded(Promise.all([closed, inputWritten]), 'direct probe wrapper and cleanup', 25_000)
    if (inputError) throw inputError
    assert.equal(stdout.overflow(), false, 'Direct probe wrapper exceeded its output limit')
    assert.equal(stderr.overflow(), false, 'Direct probe wrapper exceeded its diagnostic limit')
    assert.equal(wrapper.code, 0, stderr.bytes().toString('utf8') || stdout.bytes().toString('utf8'))
    const lines = stdout.bytes().toString('utf8').trim().split('\n')
    assert.equal(lines.length, 2, 'Direct probe omitted its start or terminal result')
    const result = JSON.parse(lines[1])
    assert.equal(result.pid, ownedPid)
    assert.equal(result.cleanupVerified, true, 'Direct probe did not verify owned target cleanup')
    assert.equal(result.timedOut, false, 'Direct owned probe exceeded its 15s deadline')
    assert.equal(result.outputLimitExceeded, false, 'Direct owned probe exceeded its output limit')
    assert.equal(result.error, null)
    assert.ok(Number.isInteger(result.pid) && result.pid > 0)
    assert.equal(dead(result.pid), true, 'Direct owned probe is still alive')
    completed = true
    return { exitCode: result.exitCode, stdout: Buffer.from(result.stdout, 'base64'), stderr: Buffer.from(result.stderr, 'base64') }
  } finally {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await bounded(closed.catch(() => {}), 'direct wrapper cleanup', 5_000)
      try {
        const recorded = Number((await readFile(join(input.cwd, 'direct-target.pid'), 'utf8')).trim())
        assert.ok(Number.isInteger(recorded) && recorded > 0, 'Invalid direct owned target PID file')
        if (ownedPid !== undefined) assert.equal(recorded, ownedPid, 'Direct owned PID announcement and file disagree')
        ownedPid = recorded
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (ownedPid !== undefined) await cleanOwnedPid(ownedPid, 'direct owned target')
      else if (!completed && child.pid !== undefined) throw new Error('Direct target cleanup could not be verified: no owned PID was recorded')
    } catch (error) {
      error.cleanupUnverified = true
      throw error
    }
  }
}
async function helperProbe(input, launchProbe = launchWindowsMcp, completionMs = 15_000) {
  const owned = await launchProbe(input, { hostEnv: process.env, cleanupTimeoutMs: 5_000 })
  const stdout = collectBounded(owned.stdout), stderr = collectBounded(owned.stderr)
  try {
    const result = await bounded(owned.completed, 'owned helper probe', completionMs)
    if (result.error !== undefined) {
      const error = new Error(result.error)
      error.cleanupUnverified = true
      throw error
    }
    assert.equal(stdout.overflow() || stderr.overflow(), false, 'Owned helper probe exceeded its output limit')
    return { exitCode: result.exitCode, stdout: stdout.bytes(), stderr: stderr.bytes() }
  } finally {
    try {
      await bounded(owned.stop(), 'owned helper probe cleanup', 5_000)
      const finalResult = await owned.completed
      if (finalResult.error !== undefined) throw new Error(finalResult.error)
    }
    catch (error) { error.cleanupUnverified = true; throw error }
  }
}

test('inert helper probe retains final native cleanup error after initial completion timeout', async () => {
  let complete, stops = 0
  const completed = new Promise(resolve => { complete = resolve })
  const owned = { stdout: new PassThrough(), stderr: new PassThrough(), completed, stop: async () => {
    stops++; complete({ exitCode: null, error: 'Owned inert cleanup unverified after stop' })
  } }
  await assert.rejects(helperProbe({}, async () => owned, 1), error =>
    error.cleanupUnverified === true && /cleanup unverified after stop/.test(error.message))
  assert.equal(stops, 1)
})

test('direct probe contains inert bootstrap throws, callback failures and stream errors and always closes its wrapper', async () => {
  for (const failure of ['throw', 'callback', 'error']) {
    const directory = await mkdtemp(join(tmpdir(), 'vivi inert node probe-'))
    const child = new EventEmitter()
    child.stdin = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.signalCode = null
    // No PID: this child is entirely inert and never represents a real process.
    let killed = 0, settings
    child.kill = () => { killed++; child.signalCode = 'SIGKILL'; child.emit('close', null, 'SIGKILL'); return true }
    const error = Object.assign(new Error(`owned inert bootstrap ${failure}`), { code: 'EPIPE' })
    child.stdin.end = (_data, callback) => {
      if (failure === 'throw') throw error
      queueMicrotask(() => { if (failure === 'callback') callback(error); else child.stdin.emit('error', error) })
    }
    try {
      await assert.rejects(directProbe('C:\\Program Files\\PowerShell\\7\\pwsh.exe', { cwd: directory, env: {} }, (_executable, _argv, options) => { settings = options; return child }), caught => caught === error)
      assert.equal(killed, 1, `Failed ${failure} bootstrap skipped wrapper cleanup`)
      assert.equal(settings.shell, false)
      assert.ok(Object.keys(settings.env).every(name => ['SystemRoot', 'TEMP', 'TMP', 'PSModulePath'].includes(name)))
      assert.ok(child.stdin.listenerCount('error') > 0)
      child.stdin.emit('error', new Error('owned inert late input error'))
    } finally { await rm(directory, { recursive: true, force: true }) }
  }
})

test('direct Windows Node control uses fixed source, exact JSON data and bounded owned output', async () => {
  const source = await readFile(directScript, 'utf8')
  for (const literal of ['[Console]::ReadLine()', '-AsHashtable', "$request.args[1] -cne 'native-probe'", '$start.UseShellExecute = $false', '$start.Environment.Clear()', '$start.ArgumentList.Add([string]$argument)', '$start.RedirectStandardOutput = $true', '$start.RedirectStandardError = $true', '[byte[]]::new(65537)', '[Environment]::TickCount64 + 15000', '$process.Kill()', '$process.WaitForExit(5000)', '{"type":"start","pid":', "'direct-target.pid'", "[Environment]::SetEnvironmentVariable('PSModulePath', $moduleDirectory)", "$name -notin @('SystemRoot', 'TEMP', 'TMP', 'PSModulePath')", 'Import-Module -Name $manifest', 'Microsoft.PowerShell.Utility\\ConvertFrom-Json', 'Microsoft.PowerShell.Utility\\ConvertTo-Json']) assert.ok(source.includes(literal), literal)
  assert.ok(source.indexOf('$start.Environment.Clear()') < source.indexOf('$start.Environment.Add('))
  assert.ok(source.indexOf('Import-Module -Name $manifest') < source.indexOf('Microsoft.PowerShell.Utility\\ConvertFrom-Json'))
  assert.doesNotMatch(source, /Add-Type|Invoke-Expression|Start-Process|Download|\$env:|NODE_OPTIONS|PATH=|StandardInput\.Close/i)
})

test('Windows Node startup diagnostics: direct host versus owned helper for exact empty and explicit SYSTEMROOT env', { skip: process.platform !== 'win32', timeout: 90_000 }, async t => {
  const powershell = await installedPowerShell7()
  const systemRoot = hostValue('SystemRoot')
  assert.ok(systemRoot && win32.isAbsolute(systemRoot), 'Explicit SYSTEMROOT control requires an absolute captured host SystemRoot')
  const environments = [Object.freeze({}), Object.freeze({ SYSTEMROOT: systemRoot })]
  const failures = []
  for (const environment of environments) {
    for (const [path, probe] of [['direct', input => directProbe(powershell, input)], ['helper', helperProbe]]) {
      const directory = await mkdtemp(join(tmpdir(), 'vivi mcp node env-'))
      const pidFile = join(directory, 'pid')
      const input = Object.freeze({ executable: process.execPath, args: Object.freeze([fixtureFile, 'native-probe', join(directory, 'log'), pidFile, ...literals]), cwd: directory, env: environment })
      const started = Date.now()
      let cleanupUnverified = false
      try {
        const result = await probe(input)
        t.diagnostic(JSON.stringify({ node: process.version, path, environment: Object.keys(environment), exitCode: result.exitCode, elapsedMs: Date.now() - started, stderr: result.stderr.subarray(0, 4096).toString('utf8') }))
        assert.ok(Number.isInteger(result.exitCode), 'Probe must report a measured target exit code')
        if (result.stdout.length) {
          assert.equal(result.exitCode, 0, 'Owned native-probe emitted stdout but did not exit successfully')
          const response = JSON.parse(result.stdout.toString('utf8'))
          assert.deepEqual(response.args, literals)
          assert.equal(response.cwd.toLowerCase(), directory.toLowerCase())
          assert.deepEqual(response.environment, environment)
          assert.deepEqual(response.env, Object.keys(environment).sort())
          assert.equal(response.helperSettingLeaked, false)
          assert.deepEqual(result.stderr, Buffer.from([0, 255, 13, 10]))
        } else assert.notEqual(result.exitCode, 0, 'Successful owned native-probe omitted its result')
      } catch (error) {
        failures.push(error)
        cleanupUnverified = error.cleanupUnverified === true
        t.diagnostic(JSON.stringify({ node: process.version, path, environment: Object.keys(environment), error: error.message.slice(0, 4096) }))
      } finally {
        try {
          const pid = Number((await readFile(pidFile, 'utf8')).trim())
          await cleanOwnedPid(pid, 'owned fixture')
        } catch (error) { if (error.code !== 'ENOENT') { failures.push(error); cleanupUnverified = true } }
        if (cleanupUnverified) t.diagnostic(`Owned probe cleanup is unverified; retained its directory: ${directory}`)
        else await rm(directory, { recursive: true, force: true })
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, 'Windows Node environment diagnostics failed')
})
