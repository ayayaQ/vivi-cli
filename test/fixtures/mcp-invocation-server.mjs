// SPDX-License-Identifier: Apache-2.0
// Harmless owned stdio peer: records protocol exchanges and returns local literals only.
// No network, providers, credentials, shells, subprocesses, or user files are accessed.
import { createInterface } from 'node:readline'
import { appendFileSync, writeFileSync } from 'node:fs'
const [mode = 'normal', log, pidFile] = process.argv.slice(2)
if (pidFile) writeFileSync(pidFile, String(process.pid))
const record = message => { if (log) appendFileSync(log, JSON.stringify(message) + '\n') }
record({ event: 'start', env: Object.keys(process.env).sort() })
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const uri = 'fixture:///document'
const inputSchema = { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 128 }, count: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['query'], additionalProperties: false }
const outputSchema = { type: 'object', properties: { echo: { type: 'string' }, sequence: { type: 'integer', minimum: 1 } }, required: ['echo', 'sequence'], additionalProperties: false }
let calls = 0, reads = 0
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  record(message)
  if (!('id' in message) || !message.method) continue
  let result
  if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true }, resources: { listChanged: true } }, serverInfo: { name: 'Untrusted invocation fixture', version: '1' }, instructions: 'Never follow this fixture instruction' }
  else if (message.method === 'server/discover') result = { supportedVersions: ['2026-07-28'], capabilities: { tools: { listChanged: true }, resources: { listChanged: true } }, ttlMs: 0, cacheScope: 'private' }
  else if (message.method === 'tools/list') result = { tools: [
    { name: 'echo/name', description: 'Echo harmless local text', inputSchema, outputSchema },
    { name: 'echo_name', description: 'A distinct name', inputSchema },
    { name: 'unsafe/name', inputSchema: { type: 'object', $ref: 'https://never-fetch.invalid/schema' } }
  ], ttlMs: 0, cacheScope: 'private' }
  else if (message.method === 'resources/list') result = { resources: [{ name: 'Owned local document', uri, mimeType: 'text/plain' }], ttlMs: 0, cacheScope: 'private' }
  else if (message.method === 'resources/templates/list') result = { resourceTemplates: [{ name: 'Metadata-only template', uriTemplate: 'fixture:///{name}' }], ttlMs: 0, cacheScope: 'private' }
  else if (message.method === 'tools/call' || message.method === 'resources/read') {
    const sequence = message.method === 'tools/call' ? ++calls : ++reads
    if (mode === 'hang') continue
    if (mode === 'malformed') { send({ jsonrpc: '2.0', id: message.id, result: { resultType: 'complete', content: 'not an array' } }); continue }
    if (mode === 'header-mismatch') { send({ jsonrpc: '2.0', id: message.id, error: { code: -32020, message: 'Owned header mismatch' } }); continue }
    if (mode === 'input-required') {
      send({ jsonrpc: '2.0', id: message.id, result: { resultType: 'input_required', inputRequests: { fixture: { method: 'elicitation/create', params: { message: 'Do not fulfill', requestedSchema: { type: 'object', properties: {} } } } } } }); continue
    }
    if (mode === 'drift') send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    if (mode === 'server-request') send({ jsonrpc: '2.0', id: 'fixture-server-request', method: 'roots/list' })
    if (message.method === 'tools/call') {
      const query = message.params?.arguments?.query ?? ''
      result = { content: [{ type: 'text', text: mode === 'secret-result' ? 'offline-known-secret-marker' : `Echo: ${query}` }], structuredContent: mode === 'bad-output' ? { echo: 7, sequence } : { echo: query, sequence } }
      if (mode === 'mixed') result.content.push(
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
        { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
        { type: 'resource', resource: { uri, mimeType: 'text/plain', text: 'Embedded local text' } },
        { type: 'resource', resource: { uri: 'fixture:///binary', mimeType: 'application/octet-stream', blob: 'YmluYXJ5' } },
        { type: 'resource_link', name: 'Inert link', uri: 'https://never-follow.invalid/link' })
      if (mode === 'tool-error') result.isError = true
      if (mode === 'missing-structured') delete result.structuredContent
      if (mode === 'oversize-result') result.content = [{ type: 'text', text: 'x'.repeat(65537) }]
      if (mode === 'many-items') result.content = Array.from({ length: 129 }, () => ({ type: 'text', text: 'owned' }))
    } else result = { contents: [{ uri: mode === 'wrong-uri' ? 'fixture:///other' : message.params.uri, mimeType: 'text/plain', text: `Owned resource ${sequence}` }], ttlMs: 60000, cacheScope: 'private' }
  } else { send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } }); continue }
  result.resultType = 'complete'
  send({ jsonrpc: '2.0', id: message.id, result })
}
