// SPDX-License-Identifier: Apache-2.0
import { expandMcpResourceTemplate } from '@ayayaq/vivi/extensions/mcp'
import type { McpTemplateExpander } from '@ayayaq/vivi/extensions/mcp'
import { parseTemplate } from 'url-template'

/** Trusted scalar RFC 6570 expansion only: synchronous, deterministic and no I/O. */
export const expandMcpTemplate: McpTemplateExpander = (template, variables) =>
  // The library supports broader syntax; the published core admits our bounded scalar slice.
  expandMcpResourceTemplate(template, variables, (uriTemplate, values) => parseTemplate(uriTemplate).expand(values))
