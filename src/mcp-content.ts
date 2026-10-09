// SPDX-License-Identifier: Apache-2.0
import type { ToolResult } from '@ayayaq/vivi'
import { assertMcpJson, MCP_LIMITS } from './mcp-catalog.js'
import { mcpRecord } from './mcp-config.js'
import { decodeEscapes, reviewContainsSecret } from './auto-review.js'
import { MAX_SESSION_BYTES } from './session.js'

export const MCP_OPERATION_LIMITS = Object.freeze({ argumentBytes: 16 * 1024, resultBytes: 64 * 1024,
  projectionBytes: 128 * 1024, tools: 128, contentItems: 128, operationMs: 10000 })
export function mcpContainsSecret(value: unknown, secrets: readonly string[]): boolean {
  if (!secrets.some(secret => secret.length > 0)) return false
  // An unrelated malformed percent escape must not mask a credential in the
  // same untrusted MCP string. Decode valid byte runs without requiring the
  // whole string (or every UTF-8 byte) to be a valid URI component.
  const pending = [value], decoder = new TextDecoder(), seen = new WeakSet<object>()
  // Eight bounded server catalogs plus the admitted session and projected
  // definitions. Numeric examples count toward traversal, not credential matches.
  const maxNodes = 8 * MCP_LIMITS.bytes + MAX_SESSION_BYTES + MCP_OPERATION_LIMITS.projectionBytes
  let nodes = 0
  while (pending.length) {
    if (++nodes > maxNodes) return true
    const item = pending.pop()
    if (typeof item === 'string') {
      if (reviewContainsSecret(item, secrets)) return true
      let decoded = item
      for (let depth = 0; depth < 32 && /[%\\]/.test(decoded); depth++) {
        const next = decodeEscapes(decoded).replace(/(?:%[\da-f]{2})+/gi, run =>
          decoder.decode(Uint8Array.from(run.match(/%[\da-f]{2}/gi)!, byte => Number.parseInt(byte.slice(1), 16))))
        if (secrets.some(secret => secret && next.includes(secret))) return true
        if (next === decoded) break
        decoded = next
      }
    } else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item)
      if (Array.isArray(item)) for (const child of item) pending.push(child)
      else for (const [key, child] of Object.entries(item)) pending.push(key, child)
    }
  }
  return false
}
export function mcpFailure(code: string, message: string, unknownOutcome = false): ToolResult {
  return { content: JSON.stringify({ success: false, source: 'mcp', untrusted: true,
    ...(unknownOutcome ? { unknownOutcome: true, doNotRetry: true } : {}), error: { code, message } }), isError: true }
}
/** Stricter than the SDK's compatibility envelope: do not turn foreign result families into empty successes. */
export function assertMcpOperationResult(method: 'tools/call' | 'resources/read', result: unknown): void {
  assertMcpJson(result, MCP_OPERATION_LIMITS.resultBytes)
  if (!mcpRecord(result) || ['task', 'inputRequests', 'requestState', 'toolResult'].some(key => Object.hasOwn(result, key)) ||
    result.resultType !== undefined && result.resultType !== 'complete') throw new Error('Unsupported MCP result envelope')
  const content = result[method === 'tools/call' ? 'content' : 'contents']
  if (!Array.isArray(content) || content.length > MCP_OPERATION_LIMITS.contentItems ||
    result.isError !== undefined && typeof result.isError !== 'boolean') throw new Error('Invalid MCP result content')
}
function textResource(value: unknown): Record<string, unknown> {
  if (!mcpRecord(value) || typeof value.uri !== 'string') throw new Error('Invalid MCP resource content')
  return { uri: value.uri, ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
    ...(typeof value.text === 'string' ? { text: value.text } : { binaryOmitted: true }) }
}
/** No raw envelope, binary payload, instructions or follow-on actions enter model context. */
export function projectMcpResult(serverId: string, method: 'tools/call' | 'resources/read', remoteKey: string,
  result: unknown, secrets: readonly string[]): ToolResult {
  assertMcpOperationResult(method, result)
  if (mcpContainsSecret(result, secrets)) throw new Error('MCP result contains a known credential')
  const body = result as Record<string, unknown>
  let content: Record<string, unknown>[]
  if (method === 'resources/read') {
    content = (body.contents as unknown[]).map(item => {
      const resource = textResource(item)
      // This bounded slice permits only the exact approved URI, not subresource expansion.
      if (resource.uri !== remoteKey) throw new Error('MCP resource URI differs from the approved URI')
      return resource
    })
  } else content = (body.content as unknown[]).map(item => {
    if (!mcpRecord(item) || typeof item.type !== 'string') throw new Error('Invalid MCP content block')
    if (item.type === 'text' && typeof item.text === 'string') return { type: 'text', text: item.text }
    if (item.type === 'resource') return { type: 'resource', resource: textResource(item.resource) }
    if (item.type === 'resource_link' && typeof item.uri === 'string') return { type: 'resource_link', uri: item.uri,
      ...(typeof item.name === 'string' ? { name: item.name } : {}),
      ...(typeof item.description === 'string' ? { description: item.description } : {}) }
    if (item.type === 'image' || item.type === 'audio') return { type: item.type, binaryOmitted: true,
      ...(typeof item.mimeType === 'string' ? { mimeType: item.mimeType } : {}) }
    throw new Error('Unsupported MCP content block')
  })
  const projection = { success: body.isError !== true, source: 'mcp', untrusted: true, serverId,
    method, remoteKey, content, ...(Object.hasOwn(body, 'structuredContent') ? { structuredContent: body.structuredContent } : {}) }
  assertMcpJson(projection, MCP_OPERATION_LIMITS.resultBytes)
  return { content: JSON.stringify(projection), ...(body.isError === true ? { isError: true } : {}) }
}
