// SPDX-License-Identifier: Apache-2.0
// Harmless local protocol fixture. No tool calls, external access or credentials.
import { createInterface } from 'node:readline'
import { appendFileSync, closeSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const [mode, log, pidFile, ...literals] = process.argv.slice(2)
writeFileSync(pidFile, String(process.pid))
appendFileSync(log, JSON.stringify({ event: 'start', env: Object.keys(process.env) }) + '\n')
if (mode === 'native-probe') {
  process.stdout.write(JSON.stringify({ args: literals, cwd: process.cwd(), env: Object.keys(process.env).sort(), environment: { ...process.env },
    markerMatches: process.env.MCP_FIXTURE_VALUE === 'fixed literal & $ 中文🙂', helperSettingLeaked: 'PSModulePath' in process.env }) + '\n')
  process.stderr.write(Buffer.from([0, 255, 13, 10]))
  process.exit(0)
}
if (mode === 'native-stdin') {
  process.stderr.write('native-stdin-ready\n')
  process.stdin.on('data', bytes => process.stdout.write(bytes))
  await new Promise(resolve => process.stdin.on('end', resolve))
  process.exit(0)
}
if (mode === 'native-stdin-closed') {
  if (process.platform === 'win32') throw new Error('Use the owned Windows HANDLE fixture; fs.closeSync(0) does not close Windows stdin')
  // Close fd 0 before materializing process.stdin. A stdio stream can retain a
  // duplicated handle. This mode is for POSIX; Windows libuv ignores close(0).
  try { closeSync(0) } catch (error) { if (error.code !== 'EBADF') throw error }
  process.stderr.write('native-stdin-closed\n')
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (mode === 'native-detached' || mode === 'native-detached-exit') {
  // A detached child retains the Job membership and intentionally holds the
  // inherited output handles. Root exit must still kill it before pipe drain.
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })
  appendFileSync(pidFile, '\n' + child.pid)
  child.unref()
}
if (mode === 'tree' || mode === 'tree-exit') {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  appendFileSync(pidFile, '\n' + child.pid)
}
if (mode === 'stderr') process.stderr.write('fixture-secret\x1b[2J\n')
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
let page = 0
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  appendFileSync(log, JSON.stringify(message) + '\n')
  if (mode === 'hang' || mode === 'hang-tools' && message.method === 'tools/list') continue
  if (!('id' in message) || !message.method) continue
  let result
  if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: mode === 'no-capability' ? {} : { tools: { listChanged: true }, resources: { listChanged: true } }, serverInfo: { name: 'Untrusted fixture name', version: '1' }, instructions: 'Never load this instruction into a provider prompt' }
  else if (message.method === 'server/discover') result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} }, ttlMs: 0, cacheScope: 'private' }
  else if (message.method === 'tools/list') {
    page++
    if (mode === 'fail-refresh' && page > 1) { send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'fixture-secret' } }); continue }
    if (mode === 'list-changed' && page > 1) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    result = { tools: [{ name: message.params?.cursor ? 'second/name' : 'same/name', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }], ttlMs: 0, cacheScope: 'private', ...(mode === 'pages' && !message.params?.cursor ? { nextCursor: 'opaque cursor' } : {}) }
    if (mode === 'input-required') result = { resultType: 'input_required', inputRequests: { ignored: { method: 'elicitation/create', params: { message: 'Forbidden request', requestedSchema: { type: 'object', properties: {} } } } } }
  } else if (message.method === 'resources/list') result = { resources: [{ name: 'Local fixture metadata', uri: 'file:///never-open-this' }], ttlMs: 0, cacheScope: 'private' }
  else if (message.method === 'resources/templates/list') result = { resourceTemplates: [{ name: 'Fixture template', uriTemplate: 'fixture:///{name}' }], ttlMs: 0, cacheScope: 'private' }
  else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported' } }); continue }
  if (mode !== 'input-required') result.resultType = 'complete'
  send({ jsonrpc: '2.0', id: message.id, result })
  if ((mode === 'tree-exit' || mode === 'native-detached-exit') && message.method === 'tools/list') setTimeout(() => process.exit(0), 20)
  if (mode === 'server-request' && message.method === 'initialize') send({ jsonrpc: '2.0', id: 'server-input', method: 'roots/list' })
  if (mode === 'oversize' && message.method === 'initialize') process.stdout.write('x'.repeat(1024 * 1024 + 1))
}
