// SPDX-License-Identifier: Apache-2.0
// Fixture-only instrumentation of fixed package source. Request bytes are untouched.
import assert from 'node:assert/strict'
import { gzipSync, gunzipSync } from 'node:zlib'

export const phaseNames = Object.freeze(['wrapper-entry', 'module-import-start', 'module-import-ready',
  'compile-start', 'compile-ready', 'request-read-start', 'request-read-ready', 'native-entry',
  'job-ready', 'control-reader-entered', 'control-eof', 'target-create-start', 'target-created',
  'target-resumed', 'job-empty'])
const prefix = 'vivi-mcp-diagnostic-phase:'
function replaceOne(source, before, after) {
  assert.equal(source.split(before).length, 2, 'Fixed diagnostic source marker must occur exactly once')
  return source.replace(before, after)
}
const ps = name => `[Console]::Error.WriteLine('${prefix}${name}'); [Console]::Error.Flush()`
const cs = name => `Console.Error.WriteLine("${prefix}${name}"); Console.Error.Flush();`

export function instrumentWindowsMcpArgv(args) {
  assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand'])
  assert.equal(args.length, 5)
  let wrapper = Buffer.from(args[4], 'base64').toString('utf16le')
  const matches = [...wrapper.matchAll(/\$compressed = '([A-Za-z0-9+/=]+)'/g)]
  assert.equal(matches.length, 1)
  let native = gunzipSync(Buffer.from(matches[0][1], 'base64'), { maxOutputLength: 128 * 1024 }).toString('utf8')
  native = replaceOne(native, 'public static void Run(string executable, string[] args, string cwd, Dictionary<string,string> env) {',
    `public static void Run(string executable, string[] args, string cwd, Dictionary<string,string> env) {\n${cs('native-entry')}`)
  native = replaceOne(native, 'lock (jobLock) { activeJob = job; }', `lock (jobLock) { activeJob = job; }\n${cs('job-ready')}`)
  native = replaceOne(native, 'static void StopOnInputEnd() {', `static void StopOnInputEnd() {\n${cs('control-reader-entered')}`)
  native = replaceOne(native, 'cancelled = true;\n      inputQueue.CompleteAdding();', `${cs('control-eof')}\n      cancelled = true;\n      inputQueue.CompleteAdding();`)
  native = replaceOne(native, 'Check(CreateProcessW(executable, command,', `${cs('target-create-start')}\n        Check(CreateProcessW(executable, command,`)
  native = replaceOne(native, 'if (ResumeThread(process.thread) == UInt32.MaxValue)', `${cs('target-created')}\n        if (ResumeThread(process.thread) == UInt32.MaxValue)`)
  native = replaceOne(native, 'Close(ref inRead); Close(ref outWrite); Close(ref errWrite); Close(ref process.thread);',
    `${cs('target-resumed')}\n      Close(ref inRead); Close(ref outWrite); Close(ref errWrite); Close(ref process.thread);`)
  native = replaceOne(native, 'if (accounting.activeProcesses == 0) return;', `if (accounting.activeProcesses == 0) { ${cs('job-empty')} return; }`)
  wrapper = wrapper.replace(matches[0][0], `$compressed = '${gzipSync(Buffer.from(native)).toString('base64')}'`)
  wrapper = replaceOne(wrapper, "$ErrorActionPreference = 'Stop'", `${ps('wrapper-entry')}\n$ErrorActionPreference = 'Stop'`)
  wrapper = replaceOne(wrapper, 'Import-Module -Name $manifest -ErrorAction Stop',
    `${ps('module-import-start')}\n  Import-Module -Name $manifest -ErrorAction Stop\n  ${ps('module-import-ready')}`)
  wrapper = replaceOne(wrapper, 'Microsoft.PowerShell.Utility\\Add-Type -TypeDefinition $source -ErrorAction Stop',
    `${ps('compile-start')}\n  Microsoft.PowerShell.Utility\\Add-Type -TypeDefinition $source -ErrorAction Stop\n  ${ps('compile-ready')}`)
  wrapper = replaceOne(wrapper, '$line = [Console]::ReadLine()', `${ps('request-read-start')}\n  $line = [Console]::ReadLine()\n  ${ps('request-read-ready')}`)
  const result = [...args.slice(0, 4), Buffer.from(wrapper, 'utf16le').toString('base64')]
  assert(result.join(' ').length < 32_000, 'Instrumented fixed helper must retain its bounded command line')
  return result
}

export function phaseCollector(now) {
  const phases = [], seen = new Set()
  let pending = '', overflow = false
  return { phases, get overflow() { return overflow }, accept(chunk) {
    if (chunk.length > 8192) overflow = true
    pending += chunk.subarray(0, 8192).toString('utf8')
    let newline
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      const name = line.startsWith(prefix) ? line.slice(prefix.length) : ''
      if (phaseNames.includes(name) && !seen.has(name)) { seen.add(name); phases.push({ name, afterMs: Math.round(now()) }) }
    }
    if (Buffer.byteLength(pending, 'utf8') > 4096) { overflow = true; pending = '' }
  } }
}
