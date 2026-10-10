// SPDX-License-Identifier: Apache-2.0
import { collectMcpCategory as collectSharedMcpCategory, mcpAlias } from '@ayayaq/vivi/extensions/mcp'
import type { McpCatalogKind, McpCategory } from '@ayayaq/vivi/extensions/mcp'
import { createMcpSchemaValidator } from './mcp-schema.js'

export { assertMcpJson, emptyMcpCategory, MCP_LIMITS, mcpAlias } from '@ayayaq/vivi/extensions/mcp'
export type { McpCatalogEntry, McpCatalogKind, McpCatalogSnapshot, McpCategory } from '@ayayaq/vivi/extensions/mcp'

/** Keep the CLI API while supplying one bounded, synchronous SDK compiler per discovery pass. */
export function collectMcpCategory(serverId: string, kind: McpCatalogKind,
  readPage: (cursor: string | undefined, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal,
  aliasFor: typeof mcpAlias = mcpAlias): Promise<McpCategory> {
  return collectSharedMcpCategory(serverId, kind, readPage, signal, createMcpSchemaValidator(), aliasFor)
}
