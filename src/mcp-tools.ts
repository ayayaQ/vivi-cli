// SPDX-License-Identifier: Apache-2.0
import type { ToolResult } from '@ayayaq/vivi'
import type { ToolExtension } from '@ayayaq/vivi/extensions'
import { createMcpExtension as createSharedMcpExtension, MCP_GUIDANCE as SHARED_MCP_GUIDANCE } from '@ayayaq/vivi/extensions/mcp'
import type { McpCatalogSnapshot } from './mcp-catalog.js'
import { assertMcpAllowed } from './mcp-content.js'
import type { McpManager, McpPreparedOperation } from './mcp-manager.js'
import { createMcpSchemaValidator } from './mcp-schema.js'

export { MCP_RESOURCE_TOOL_NAMES } from '@ayayaq/vivi/extensions/mcp'
export const MCP_GUIDANCE = `${SHARED_MCP_GUIDANCE} Human approval also applies in Auto mode.`
type ReviewMcpOperation = (operation: McpPreparedOperation, signal: AbortSignal) => Promise<ToolResult>

/** Retain the CLI API and identity; the shared fixed extension owns selection and projection. */
export function createMcpExtension(manager: McpManager, catalogs: readonly McpCatalogSnapshot[],
  review: ReviewMcpOperation, secrets: readonly string[] = []): ToolExtension {
  return { ...createSharedMcpExtension(manager, catalogs, review, {
    validateSchema: createMcpSchemaValidator(), assertAllowed: value => assertMcpAllowed(value, secrets)
  }), id: 'vivi-cli-mcp' }
}
