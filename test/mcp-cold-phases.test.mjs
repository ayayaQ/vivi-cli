// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import { launchWindowsMcp } from '../dist/mcp-windows.js'
import { instrumentWindowsMcpArgv, phaseCollector, phaseNames } from './helpers/mcp-cold-phases.mjs'

test('cold phase instrumentation changes only fixed helper source and preserves request data', async () => {
  const child = new EventEmitter(), input = { executable: 'C:\\fixture\\node.exe', args: ['private-fixture-argv'], cwd: 'C:\\fixture', env: { SYSTEMROOT: 'C:\\Windows' } }
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true
  let argv, delivered
  child.stdin = new Writable({ write(bytes, _encoding, callback) {
    delivered = JSON.parse(bytes.toString('utf8')); callback()
    queueMicrotask(() => { child.stdout.write('{"type":"exit","exitCode":null,"stopped":true}\n'); child.emit('close') })
  } })
  const owned = await launchWindowsMcp(input, { hostEnv: { SystemRoot: 'C:\\Windows' }, spawn(_executable, args) { argv = args; return child } })
  await owned.completed
  assert.deepEqual(delivered, input)
  const instrumented = instrumentWindowsMcpArgv(argv)
  assert.deepEqual(instrumented.slice(0, 4), argv.slice(0, 4)); assert.notEqual(instrumented[4], argv[4])
  const wrapper = Buffer.from(instrumented[4], 'base64').toString('utf16le')
  const compressed = /\$compressed = '([A-Za-z0-9+/=]+)'/.exec(wrapper)[1]
  const native = gunzipSync(Buffer.from(compressed, 'base64')).toString('utf8')
  for (const name of phaseNames) assert((wrapper + native).includes(`vivi-mcp-diagnostic-phase:${name}`))
  assert(!wrapper.includes('private-fixture-argv')); assert(!native.includes('private-fixture-argv'))
  assert(instrumented.join(' ').length < 32_000)
})

test('cold phase instrumentation fails closed if fixed source or argv changed', () => {
  assert.throws(() => instrumentWindowsMcpArgv(['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('not fixed helper source', 'utf16le').toString('base64')]))
  assert.throws(() => instrumentWindowsMcpArgv(['-File', 'unrecognized']))
})

test('cold phase output contains only closed names and monotonic fixture times', () => {
  let elapsed = 1
  const collector = phaseCollector(() => elapsed++)
  collector.accept(Buffer.from('private-error-and-path\nvivi-mcp-diagnostic-phase:module-import-start\r\n'))
  collector.accept(Buffer.from('vivi-mcp-diagnostic-phase:unknown-private-value\nvivi-mcp-diagnostic-phase:compile-'))
  collector.accept(Buffer.from('ready\nvivi-mcp-diagnostic-phase:compile-ready\n'))
  assert.deepEqual(collector.phases, [{ name: 'module-import-start', afterMs: 1 }, { name: 'compile-ready', afterMs: 2 }])
  assert.equal(collector.overflow, false)
  assert(!JSON.stringify(collector).includes('private'))
})

test('cold phase collection remains bounded and reports dropped native diagnostics', () => {
  const collector = phaseCollector(() => 0)
  collector.accept(Buffer.alloc(100_000, 120))
  collector.accept(Buffer.from('vivi-mcp-diagnostic-phase:job-empty\n'))
  assert.equal(collector.overflow, true)
  assert.deepEqual(collector.phases, [{ name: 'job-empty', afterMs: 0 }])
})

test('cold phase partial ceiling counts UTF-8 bytes rather than JavaScript string units', () => {
  const collector = phaseCollector(() => 0)
  collector.accept(Buffer.from('€'.repeat(2000), 'utf8'))
  assert.equal(collector.overflow, true)
  collector.accept(Buffer.from('vivi-mcp-diagnostic-phase:job-empty\n'))
  assert.deepEqual(collector.phases, [{ name: 'job-empty', afterMs: 0 }])
})
