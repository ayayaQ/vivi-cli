// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import { fromJsonSchema } from '@modelcontextprotocol/client'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv'
import type { JsonSchemaType } from '@modelcontextprotocol/client'
import { mcpDigest, mcpFreeze, mcpRecord, mcpText } from './mcp-config.js'

export const MCP_LIMITS = Object.freeze({ pages: 16, entries: 256, bytes: 1024 * 1024,
  descriptorBytes: 64 * 1024, cursorBytes: 4096, depth: 32, nodes: 4096, categoryMs: 10000, pageMs: 5000 })
export type McpCatalogKind = 'tools' | 'resources' | 'resourceTemplates'
export interface McpCatalogEntry {
  readonly remoteKey: string
  readonly alias: string
  readonly descriptor: Readonly<Record<string, unknown>>
  readonly state: 'available' | 'quarantined'
  readonly reason?: string
}
export interface McpCategory {
  readonly state: 'not-requested' | 'unsupported' | 'ready' | 'stale' | 'error'
  readonly entries: readonly McpCatalogEntry[]
  readonly digest: string
  readonly reason?: string
}
export interface McpCatalogSnapshot {
  readonly serverId: string
  readonly configRevision: string
  readonly connectionGeneration: string
  readonly protocolVersion: string
  readonly catalogGeneration: number
  readonly categories: Readonly<Record<McpCatalogKind, McpCategory>>
}
const listKey = { tools: 'tools', resources: 'resources', resourceTemplates: 'resourceTemplates' } as const
export function mcpAlias(serverId: string, kind: McpCatalogKind, remoteKey: string): string {
  // Authority is a local ID, never a server-supplied name. Domain separation prevents kind collisions.
  return `mcp_${serverId}_${createHash('sha256').update(JSON.stringify([kind, remoteKey])).digest('hex').slice(0, 32)}`
}
export function emptyMcpCategory(state: McpCategory['state'] = 'not-requested'): McpCategory {
  return mcpFreeze({ state, entries: [], digest: mcpDigest([]) })
}
function boundedJson(value: unknown, depth = 0, budget = { nodes: MCP_LIMITS.nodes }): void {
  if (--budget.nodes < 0 || depth > MCP_LIMITS.depth) throw new Error('MCP descriptor complexity limit exceeded')
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string') return
  if (!Array.isArray(value) && !mcpRecord(value)) throw new Error('MCP descriptor must be plain JSON')
  for (const child of Object.values(value)) boundedJson(child, depth + 1, budget)
}
/** Bound untrusted JSON before cloning, hashing, validation or provider projection. */
export function assertMcpJson(value: unknown, maxBytes: number): void {
  boundedJson(value)
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new Error('MCP JSON exceeds its byte limit')
}
const keywords = new Set(['$schema', '$id', '$ref', '$defs', 'definitions', '$comment', 'title', 'description', 'type',
  'properties', 'required', 'additionalProperties', 'items', 'prefixItems', 'additionalItems', 'enum', 'const', 'allOf', 'anyOf', 'oneOf', 'not',
  'if', 'then', 'else', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'default', 'examples', 'readOnly', 'writeOnly', 'deprecated'])
function schemaReason(value: unknown, root = true): string | undefined {
  if (typeof value === 'boolean' && !root) return undefined
  if (!mcpRecord(value)) return 'Schema is not an object'
  if (value.$schema !== undefined && !['https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft-07/schema#',
    'https://json-schema.org/draft/2019-09/schema', 'http://json-schema.org/draft-06/schema#'].includes(String(value.$schema))) return 'Unsupported schema dialect'
  const types = ['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']
  if (value.type !== undefined && !(typeof value.type === 'string' ? types.includes(value.type)
    : Array.isArray(value.type) && value.type.length > 0 && value.type.length <= types.length &&
      value.type.every(type => typeof type === 'string' && types.includes(type)) && new Set(value.type).size === value.type.length)) return 'Invalid schema type'
  for (const [key, child] of Object.entries(value)) {
    if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].includes(key) &&
      (typeof child !== 'number' || !Number.isFinite(child) || key === 'multipleOf' && child <= 0)) return 'Invalid numeric schema constraint'
    if (['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'].includes(key) &&
      (typeof child !== 'number' || !Number.isSafeInteger(child) || child < 0)) return 'Invalid size schema constraint'
    if (['uniqueItems', 'readOnly', 'writeOnly', 'deprecated'].includes(key) && typeof child !== 'boolean') return 'Invalid boolean schema constraint'
    if (['title', 'description', '$comment', '$schema'].includes(key) && typeof child !== 'string') return 'Invalid schema metadata'
    if (key === 'required' && (!Array.isArray(child) || child.length > 256 || !child.every(value => typeof value === 'string') || new Set(child).size !== child.length)) return 'Invalid required schema fields'
    if (key === 'enum' && (!Array.isArray(child) || child.length === 0 || child.length > 256 || new Set(child.map(value => mcpDigest(value))).size !== child.length)) return 'Invalid schema enum'
    if (key === 'examples' && !Array.isArray(child)) return 'Invalid schema examples'
    if (!keywords.has(key)) return key === 'x-mcp-header' ? 'Header declarations are unavailable in stdio discovery' : 'Unsupported schema keyword'
    if (['$id', '$ref', '$defs', 'definitions', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'prefixItems'].includes(key)) return 'Referenced or compound schemas are unavailable in discovery'
    if (key === '$ref' && (typeof child !== 'string' || !child.startsWith('#/'))) return 'Only local schema references are supported'
    if (['properties', '$defs', 'definitions'].includes(key)) {
      if (!mcpRecord(child)) return 'Malformed schema map'
      for (const nested of Object.values(child)) { const reason = schemaReason(nested, false); if (reason) return reason }
    } else if (['items', 'additionalItems', 'additionalProperties', 'not', 'if', 'then', 'else'].includes(key)) {
      if (Array.isArray(child)) return 'Tuple schemas are unavailable in discovery'
      const reason = schemaReason(child, false); if (reason) return reason
    } else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key)) {
      if (!Array.isArray(child) || child.length === 0 || child.length > 64) return 'Malformed schema alternatives'
      for (const nested of child) { const reason = schemaReason(nested, false); if (reason) return reason }
    }
  }
  return undefined
}
function toolReason(descriptor: Record<string, unknown>, validator: AjvJsonSchemaValidator): string | undefined {
  if (mcpRecord(descriptor.execution) && descriptor.execution.taskSupport === 'required') return 'Required task execution is unavailable'
  if (descriptor['x-mcp-header'] !== undefined) return 'Header declarations are unavailable in stdio discovery'
  if (!mcpRecord(descriptor.inputSchema) || descriptor.inputSchema.type !== 'object') return 'Tool input schema must have object type'
  for (const schema of [descriptor.inputSchema, ...(descriptor.outputSchema === undefined ? [] : [descriptor.outputSchema])]) {
    const reason = schemaReason(schema); if (reason) return reason
    try { fromJsonSchema(schema as JsonSchemaType, validator) } catch { return 'Invalid schema' }
  }
  return undefined
}
/** Exactly one request per page, including an omitted first cursor. No SDK auto-aggregation. */
export async function collectMcpCategory(serverId: string, kind: McpCatalogKind,
  readPage: (cursor: string | undefined, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal,
  aliasFor: typeof mcpAlias = mcpAlias): Promise<McpCategory> {
  const cursors = new Set<string>(), keys = new Set<string>(), aliases = new Set<string>(), entries: McpCatalogEntry[] = []
  let cursor: string | undefined, bytes = 0
  // Compiler caches are bounded to this discovery pass, never the SDK’s process-global default.
  const validator = new AjvJsonSchemaValidator(), deadline = performance.now() + MCP_LIMITS.categoryMs
  for (let index = 0; index < MCP_LIMITS.pages; index++) {
    signal.throwIfAborted()
    const page = await readPage(cursor, signal)
    signal.throwIfAborted()
    if (!mcpRecord(page) || !Array.isArray(page[listKey[kind]])) throw new Error('Malformed MCP catalog page')
    const items = page[listKey[kind]] as unknown[]
    // The transport frame bound precedes JSON decoding; this budget precedes cloning/compilation.
    bytes += Buffer.byteLength(JSON.stringify(page))
    if (bytes > MCP_LIMITS.bytes || entries.length + items.length > MCP_LIMITS.entries) throw new Error('MCP catalog limit exceeded; category unavailable')
    for (const item of items) {
      signal.throwIfAborted()
      if (performance.now() > deadline) throw new Error('MCP catalog discovery deadline exceeded')
      boundedJson(item)
      if (!mcpRecord(item) || Buffer.byteLength(JSON.stringify(item)) > MCP_LIMITS.descriptorBytes) throw new Error('MCP descriptor limit exceeded')
      const remoteKey = kind === 'tools' ? item.name : kind === 'resources' ? item.uri : item.uriTemplate
      if (!mcpText(remoteKey, kind === 'tools' ? 256 : 4096) || keys.has(remoteKey)) throw new Error('Invalid or duplicate MCP catalog identity')
      keys.add(remoteKey)
      const alias = aliasFor(serverId, kind, remoteKey)
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(alias) || aliases.has(alias)) throw new Error('MCP catalog alias collision')
      aliases.add(alias)
      const reason = kind === 'tools' ? toolReason(item, validator) : undefined
      entries.push(mcpFreeze({ remoteKey, alias, descriptor: structuredClone(item), state: reason ? 'quarantined' : 'available', ...(reason ? { reason } : {}) }))
    }
    if (page.nextCursor === undefined) {
      entries.sort((a, b) => a.remoteKey < b.remoteKey ? -1 : a.remoteKey > b.remoteKey ? 1 : 0)
      return mcpFreeze({ state: 'ready', entries, digest: mcpDigest(entries) })
    }
    if (!mcpText(page.nextCursor, MCP_LIMITS.cursorBytes) || Buffer.byteLength(page.nextCursor) > MCP_LIMITS.cursorBytes || cursors.has(page.nextCursor)) throw new Error('Invalid or repeated MCP cursor')
    cursors.add(page.nextCursor); cursor = page.nextCursor
  }
  throw new Error('MCP pagination limit exceeded; category unavailable')
}
