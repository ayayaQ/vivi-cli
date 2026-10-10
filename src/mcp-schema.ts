// SPDX-License-Identifier: Apache-2.0
import type { McpSchemaValidator } from '@ayayaq/vivi/extensions/mcp'
import type { JsonSchemaType } from '@modelcontextprotocol/client'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv'

/** The pinned official SDK compiles and validates synchronously, without fetching schemas. */
export function createMcpSchemaValidator(): McpSchemaValidator {
  // Own this cache for one discovery pass or fixed extension, never process-global SDK defaults.
  const compiler = new AjvJsonSchemaValidator()
  return schema => {
    const validate = compiler.getValidator(schema as JsonSchemaType)
    return arguments_ => {
      if (!validate(arguments_).valid) throw new Error('MCP arguments do not match the captured schema')
    }
  }
}

/** An isolated proposal needs no compiler cache shared with another operation. */
export const validateMcpSchema: McpSchemaValidator = schema => createMcpSchemaValidator()(schema)
