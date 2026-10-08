// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchWindowsCommand } from '../dist/command-windows.js'

// This diagnostic-only file runs serially before native product fixtures in CI.
// Production timeouts and command lifecycle assertions remain unchanged.
const options = { skip: process.platform !== 'win32', timeout: 60_000 }
const env = { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows' }
const powershell = join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

// Compile A/B only: extract the exact package-authored C# payload through the
// injected launcher, then compile it without ever calling its Run method.
let compressedCompileSource
async function packageCompileSource() {
  if (compressedCompileSource) return compressedCompileSource
  const fake = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill() { return true },
  })
  fake.stdin.on('data', () => {})
  let encoded
  const command = await launchWindowsCommand({ executable: 'C:\\fixture.exe', args: [], cwd: 'C:\\', env }, {
    spawn(_executable, args) { encoded = args.at(-1); return fake },
  })
  fake.emit('close', 0, null)
  await command.completed
  const bootstrap = Buffer.from(encoded, 'base64').toString('utf16le')
  compressedCompileSource = bootstrap.match(/\$compressed = '([A-Za-z0-9+/=]+)'/)[1]
  return compressedCompileSource
}

async function compileProbe(t, label, setup, mode) {
  const compressed = await packageCompileSource()
  const started = performance.now()
  const phases = new Set()
  const permitted = new Set(['probe-start', 'probe-request-start', 'probe-request-consumed',
    'probe-input-eof', 'probe-compile-start', 'probe-compile-ready', 'probe-error'])
  const beforeCompile = mode === 'request-before-compile-eof' ? `
  Phase 'probe-request-start'
  $request = [Console]::ReadLine()
  if ($request -ne '{"fixture":"compile-ab"}') { throw 'Invalid compile fixture request' }
  Phase 'probe-request-consumed'
  $null = [Console]::In.ReadToEnd()
  Phase 'probe-input-eof'
` : ''
  // Only fixed test source and the fixed package C# source are embedded here.
  const source = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Phase([string]$value) { [Console]::Out.WriteLine($value); [Console]::Out.Flush() }
try {
  Phase 'probe-start'
${beforeCompile}
  $memory = [IO.MemoryStream]::new([Convert]::FromBase64String('${compressed}'))
  $gzip = [IO.Compression.GZipStream]::new($memory, [IO.Compression.CompressionMode]::Decompress)
  $reader = [IO.StreamReader]::new($gzip, [Text.Encoding]::UTF8)
  $fixedSource = $reader.ReadToEnd()
  $reader.Dispose()
  Phase 'probe-compile-start'
  Add-Type -TypeDefinition $fixedSource -ErrorAction Stop
  Phase 'probe-compile-ready'
  exit 0
} catch {
  Phase 'probe-error'
  exit 1
}
`
  const encoded = Buffer.from(source, 'utf16le').toString('base64')
  assert.ok(encoded.length + powershell.length + 200 < 32767)
  const helper = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    shell: false, windowsHide: true, env: setup, stdio: [mode === 'ignored-stdin' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  let helperClosed = false, pending = '', settle, timer
  const closed = new Promise(resolve => helper.once('close', code => { helperClosed = true; resolve(code) }))
  const observed = new Promise(resolve => { settle = resolve })
  helper.stderr.on('data', () => {}) // Never log raw diagnostics, paths, or source.
  helper.stdin?.on('error', () => {})
  helper.stdin?.once('finish', () => t.diagnostic(`${label}:stdin-write-finished:${Math.round(performance.now() - started)}ms`))
  helper.stdin?.once('close', () => t.diagnostic(`${label}:stdin-handle-closed:${Math.round(performance.now() - started)}ms`))
  helper.stdout.setEncoding('utf8')
  helper.stdout.on('data', chunk => {
    pending += chunk
    if (pending.length > 8192) { settle('invalid-probe-output'); return }
    let newline
    while ((newline = pending.indexOf('\n')) !== -1) {
      const phase = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      if (!permitted.has(phase)) { settle('invalid-probe-output'); return }
      if (phases.has(phase)) continue
      phases.add(phase)
      t.diagnostic(`${label}:${phase}:${Math.round(performance.now() - started)}ms`)
      if (phase === 'probe-error') { settle('helper-error'); return }
      if (phase === 'probe-request-consumed' && mode === 'request-before-compile-eof') {
        // Flush only after the helper confirms consumption, then close the native
        // pipe handle; this variant supplies actual EOF before invoking Add-Type.
        helper.stdin.end(() => helper.stdin.destroy())
      }
    }
  })
  helper.once('error', () => settle('helper-error'))
  helper.once('close', code => {
    settle(code === 0 && phases.has('probe-compile-ready') ? 'compiled' : 'helper-error')
  })
  async function cleanup() {
    if (!helperClosed && Number.isInteger(helper.pid) && helper.pid > 0) {
      // This is bounded harmless compiler-fixture cleanup while its parent is
      // still alive. Production containment continues to use its Job Object.
      const killer = spawn(join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(helper.pid), '/T', '/F'], {
        shell: false, windowsHide: true, env: setup, stdio: 'ignore',
      })
      await new Promise(resolve => {
        const bound = setTimeout(() => { killer.kill('SIGKILL'); resolve() }, 2000)
        killer.once('error', () => { clearTimeout(bound); resolve() })
        killer.once('close', () => { clearTimeout(bound); resolve() })
      })
      helper.stdin?.destroy()
      if (!helperClosed) helper.kill('SIGKILL')
    }
    let bound
    try { await Promise.race([closed, new Promise((_, reject) => {
      bound = setTimeout(() => reject(new Error('Compiler fixture cleanup did not finish')), 2000)
    })]) } finally { clearTimeout(bound) }
  }
  t.after(cleanup)
  if (mode !== 'ignored-stdin') helper.stdin.write('{"fixture":"compile-ab"}\n')
  timer = setTimeout(() => settle(phases.has('probe-compile-ready')
    ? 'compile-ready-helper-close-not-observed-within-bound'
    : 'compile-not-observed-within-bound'), 50_000)
  const outcome = await observed
  clearTimeout(timer)
  t.diagnostic(`${label}:outcome-${outcome}:${Math.round(performance.now() - started)}ms`)
  await cleanup()
  // A censored timing observation is not a product pass or an EOF/deadlock claim.
  // The unchanged native command lifecycle assertions remain the product gates.
  assert.ok(['compiled', 'compile-not-observed-within-bound',
    'compile-ready-helper-close-not-observed-within-bound'].includes(outcome),
    'The compile-only fixture failed outside its bounded observation window')
}

const compileCases = [
  ['compile-ignored-SystemRoot-only', 'ignored-stdin', false],
  ['compile-ignored-with-temp', 'ignored-stdin', true],
  ['compile-queued-with-temp', 'queued-open-stdin', true],
  ['compile-request-before-eof-with-temp', 'request-before-compile-eof', true],
]
for (const [label, mode, includeTemp] of compileCases) test(`Windows compile-only A/B ${label}`, options, async t => {
  const setup = { ...env }
  if (includeTemp) for (const name of ['WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    const entry = Object.entries(process.env).find(([key, value]) => key.toUpperCase() === name && value !== undefined)
    if (entry?.[1] !== undefined) setup[name] = entry[1]
  }
  await compileProbe(t, label, setup, mode)
})
