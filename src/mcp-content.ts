// SPDX-License-Identifier: Apache-2.0
import type { ToolResult } from '@ayayaq/vivi'
import { MCP_OPERATION_LIMITS, projectMcpResult as projectSharedMcpResult } from '@ayayaq/vivi/extensions/mcp'
import { MCP_LIMITS } from './mcp-catalog.js'
import { decodeEscapes, reviewContainsSecret } from './auto-review.js'
import { MAX_SESSION_BYTES } from './session.js'

export { assertMcpOperationResult, MCP_OPERATION_LIMITS, mcpFailure } from '@ayayaq/vivi/extensions/mcp'
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
/** Mandatory host policy for shared MCP helpers; the CLI owns its known-credential detector. */
export function assertMcpAllowed(value: unknown, secrets: readonly string[]): void {
  if (mcpContainsSecret(value, secrets)) throw new Error('MCP data contains a known credential')
}
/** Retain the CLI API while delegating bounded result projection and exact URI checks. */
export function projectMcpResult(serverId: string, method: 'tools/call' | 'resources/read', remoteKey: string,
  result: unknown, secrets: readonly string[]): ToolResult {
  return projectSharedMcpResult(serverId, method, remoteKey, result, value => assertMcpAllowed(value, secrets))
}
