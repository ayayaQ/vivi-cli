// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inputProbe, formatInputDiagnostic, runInputDiagnostic } from '../dist/input-diagnostic.js'
import { main } from '../dist/main.js'

const key = (name, extra = {}) => ({ name, shift: false, ctrl: false, meta: false, eventType: 'press', source: 'raw', ...extra })
test('input probes allow only fixed Enter and Ctrl+J metadata, never text or raw bytes', () => {
  for (const name of ['a', 'secret_fixture', 'paste', 'j', 'c', 'escape', '/provider']) {
    assert.equal(inputProbe(key(name, { raw: 'private fixture text', sequence: 'private fixture bytes' })), undefined)
  }
  const probe = inputProbe(key('return', { shift: true, raw: 'private fixture text', sequence: 'private fixture bytes' }))
  assert.deepEqual(probe, { key: 'enter', shift: true, ctrl: false, alt: false, event: 'press', source: 'raw' })
  assert.equal(inputProbe(key('j', { ctrl: true })).key, 'ctrl-j')
  assert.equal(inputProbe(key('kpenter')).key, 'keypad-enter')
  assert.equal(inputProbe(key('linefeed')).key, 'linefeed')
  assert.equal(inputProbe(key('return', { repeated: true })).event, 'repeat')
  assert.equal(inputProbe(key('return', { repeated: true, eventType: 'release' })).event, 'release')
  const output = formatInputDiagnostic({ platform: 'win32', nodeCompatibilityVersion: '26.4.0', bun: '1.4.2',
    stdinTTY: true, stdoutTTY: true, probes: [probe], failed: false })
  assert(!output.includes('private fixture')); assert(!output.includes('sequence')); assert(!output.includes('raw:'))
})

test('diagnostic CLI bypasses environment keys, configuration, cwd, providers and stores', async t => {
  const output = [], write = process.stdout.write
  process.stdout.write = value => { output.push(String(value)); return true }
  t.after(() => { process.stdout.write = write })
  let calls = 0
  const forbidden = () => { throw new Error('Diagnostic must not touch provider configuration') }
  const env = new Proxy({}, { get: forbidden, ownKeys: forbidden })
  const code = await main(['--diagnose-input'], env, { inputDiagnostic: async () => { calls++; return 'fixed probe report\n' },
    providerFactory: forbidden, credentials: { load: forbidden, status: forbidden, save: forbidden },
    catalog: { list: forbidden }, launchDirectory: '/must-not-be-opened' })
  assert.equal(code, 0); assert.equal(calls, 1); assert.deepEqual(output, ['fixed probe report\n'])
})

test('diagnostic rejects extra arguments and non-TTY use without leaking values or reading keys', async t => {
  const output = [], write = process.stderr.write
  process.stderr.write = value => { output.push(String(value)); return true }
  t.after(() => { process.stderr.write = write })
  let calls = 0
  assert.equal(await main(['--diagnose-input', '--prompt', 'private fixture value'], {},
    { inputDiagnostic: async () => { calls++; return '' } }), 1)
  assert.equal(calls, 0); assert(!output.join('').includes('private fixture'))
  if (!process.stdin.isTTY || !process.stdout.isTTY) assert.equal(await main(['--diagnose-input'], {}), 1)
})

test('diagnostic refuses raw-input capture before importing or starting native input', async t => {
  const previous = process.env.OTUI_STDIN_LOG
  process.env.OTUI_STDIN_LOG = 'fixture-only-forbidden-capture'
  t.after(() => { if (previous === undefined) delete process.env.OTUI_STDIN_LOG; else process.env.OTUI_STDIN_LOG = previous })
  await assert.rejects(runInputDiagnostic(), /Disable raw input capture/)
})

for (const flag of ['OTUI_DEBUG', 'OTUI_DEBUG_FFI', 'OTUI_TRACE_FFI', 'OTUI_DUMP_CAPTURES']) {
  test(`isolated diagnostic rejects ${flag} before native imports and creates no files`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'vivi-diagnostic-capture-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const module = new URL('../dist/input-diagnostic.js', import.meta.url).href
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import assert from 'node:assert/strict'; import {runInputDiagnostic} from ${JSON.stringify(module)};
      await assert.rejects(runInputDiagnostic(), /Disable raw input capture/); console.log('capture blocked')`],
    { cwd: directory, env: { PATH: process.env.PATH, [flag]: '1' }, encoding: 'utf8', timeout: 5000 })
    assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /capture blocked/); assert.deepEqual(await readdir(directory), [])
  })
}
