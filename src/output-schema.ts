// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { TextDecoder } from 'node:util'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv/dist/2020.js'
import type { JsonValue, Message, ModelProvider } from '@ayayaq/vivi'

export const OUTPUT_SCHEMA_LIMITS = Object.freeze({
  bytes: 64 * 1024, jsonDepth: 32, schemaNodes: 256, branches: 16,
  referenceHops: 16, expandedVisits: 2048, outputBytes: 256 * 1024, outputDepth: 128
})
export const OUTPUT_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'
export type OutputSchemaErrorCode = 'output_schema_unreadable' | 'output_schema_too_large' |
  'output_schema_invalid' | 'output_schema_unsupported' | 'output_schema_too_complex' |
  'output_schema_redacted' | 'output_too_large' | 'invalid_json' | 'schema_mismatch' | 'output_redacted'
/** Messages are deliberately fixed: schemas, paths, values and compiler diagnostics can contain secrets. */
export class OutputSchemaError extends Error {
  constructor(readonly code: OutputSchemaErrorCode, readonly phase: 'configuration' | 'output') {
    super(phase === 'configuration' ? 'The output schema could not be used.' : 'The final answer did not satisfy the output contract.')
    this.name = 'OutputSchemaError'
  }
}
function fail(code: OutputSchemaErrorCode, phase: 'configuration' | 'output' = 'configuration'): never {
  throw new OutputSchemaError(code, phase)
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function containsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some(secret => secret.length > 0 && text.includes(secret))
}
/** Inspect decoded values AND keys, not only the JSON source (which can escape credentials). */
function jsonContainsSecret(value: unknown, secrets: readonly string[]): boolean {
  const pending: unknown[] = [value]
  while (pending.length) {
    const current = pending.pop()
    if (typeof current === 'string' && containsSecret(current, secrets)) return true
    if (Array.isArray(current)) for (const child of current) pending.push(child)
    else if (object(current)) for (const [key, child] of Object.entries(current)) {
      if (containsSecret(key, secrets)) return true
      pending.push(child)
    }
  }
  return false
}
function checkJson(value: unknown, maxDepth: number, code: OutputSchemaErrorCode, phase: 'configuration' | 'output'): void {
  const pending = [{ value, depth: 0 }]
  let visited = 0
  while (pending.length) {
    const item = pending.pop()!
    if (++visited > OUTPUT_SCHEMA_LIMITS.outputBytes || item.depth > maxDepth || typeof item.value === 'number' && !Number.isFinite(item.value)) fail(code, phase)
    if (Array.isArray(item.value)) for (const child of item.value) pending.push({ value: child, depth: item.depth + 1 })
    else if (object(item.value)) for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 })
  }
}
const keywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'prefixItems',
  'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'enum', 'const', 'anyOf', 'allOf', 'oneOf', 'not', 'title', 'description', 'default', 'examples',
  '$schema', '$defs', '$ref'])
const singleSchemas = new Set(['additionalProperties', 'items', 'not'])
const arraySchemas = new Set(['prefixItems', 'anyOf', 'allOf', 'oneOf'])
const schemaMaps = new Set(['properties', '$defs'])
const pointerPart = (part: string): string => part.replace(/~/g, '~0').replace(/\//g, '~1')
interface SchemaNode { value: boolean | Record<string, unknown>; children: string[]; reference?: string }
/** Build a closed graph of schema positions. Annotation/enum data is never a schema reference target. */
function inspectSchema(schema: unknown): void {
  const nodes = new Map<string, SchemaNode>()
  const visit = (value: unknown, path: string): void => {
    if (typeof value !== 'boolean' && !object(value)) fail('output_schema_invalid')
    if (nodes.size >= OUTPUT_SCHEMA_LIMITS.schemaNodes) fail('output_schema_too_complex')
    const node: SchemaNode = { value, children: [] }; nodes.set(path, node)
    if (typeof value === 'boolean') return
    for (const [key, child] of Object.entries(value)) {
      if (!keywords.has(key)) fail('output_schema_unsupported')
      if (key === '$schema' && child !== OUTPUT_SCHEMA_DIALECT) fail('output_schema_unsupported')
      const add = (nested: unknown, location: string): void => { node.children.push(location); visit(nested, location) }
      if (singleSchemas.has(key)) add(child, `${path}/${key}`)
      else if (arraySchemas.has(key)) {
        if (!Array.isArray(child)) fail('output_schema_invalid')
        if (child.length > OUTPUT_SCHEMA_LIMITS.branches) fail('output_schema_too_complex')
        child.forEach((nested, index) => add(nested, `${path}/${key}/${index}`))
      } else if (schemaMaps.has(key)) {
        if (!object(child)) fail('output_schema_invalid')
        for (const [name, nested] of Object.entries(child)) add(nested, `${path}/${key}/${pointerPart(name)}`)
      } else if (key === '$ref') {
        if (typeof child !== 'string' || !child.startsWith('#')) fail('output_schema_unsupported')
        let fragment: string
        try { fragment = decodeURIComponent(child.slice(1)) } catch { fail('output_schema_invalid') }
        if (fragment !== '' && !fragment.startsWith('/')) fail('output_schema_unsupported')
        const parts = fragment === '' ? [] : fragment.slice(1).split('/')
        if (parts.some(part => /~(?:[^01]|$)/.test(part))) fail('output_schema_invalid')
        node.reference = parts.length === 0 ? '' : '/' + parts.map(part => pointerPart(part.replace(/~1/g, '/').replace(/~0/g, '~'))).join('/')
      }
    }
  }
  visit(schema, '')
  for (const node of nodes.values()) if (node.reference !== undefined && !nodes.has(node.reference)) fail('output_schema_invalid')
  let visits = 0
  const expand = (path: string, ancestors: Set<string>, hops: number): void => {
    if (++visits > OUTPUT_SCHEMA_LIMITS.expandedVisits || hops > OUTPUT_SCHEMA_LIMITS.referenceHops || ancestors.has(path)) fail('output_schema_too_complex')
    const node = nodes.get(path)!
    const next = new Set(ancestors); next.add(path)
    for (const child of node.children) expand(child, next, hops)
    if (node.reference !== undefined) expand(node.reference, next, hops + 1)
  }
  // Includes unused definitions too: their compilation and recursion must also be bounded.
  expand('', new Set(), 0)
}

export class OutputSchema {
  private readonly source: string
  private readonly instruction: Message
  private readonly validator: ValidateFunction
  private readonly schema: JsonValue
  constructor(value: unknown, secrets: readonly string[] = []) {
    checkJson(value, OUTPUT_SCHEMA_LIMITS.jsonDepth, 'output_schema_too_complex', 'configuration')
    inspectSchema(value)
    this.source = JSON.stringify(value)
    this.schema = JSON.parse(this.source) as JsonValue
    if (Buffer.byteLength(this.source) > OUTPUT_SCHEMA_LIMITS.bytes) fail('output_schema_too_large')
    this.checkSecrets(secrets)
    try {
      const ajv = new Ajv2020({ strict: true, strictTypes: false, strictTuples: false, strictRequired: false,
        allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false,
        inlineRefs: false, loopEnum: 32, loopRequired: 32, ownProperties: true, logger: false })
      this.validator = ajv.compile(this.schema as boolean | Record<string, unknown>)
    } catch { fail('output_schema_invalid') }
    this.instruction = { kind: 'message', role: 'system', content:
      'For this turn, the final answer must be exactly one JSON value satisfying the following JSON Schema. ' +
      'Do not use Markdown fences or prose outside that value. Tool calls may be used as needed before the final answer. ' +
      'The schema is an output constraint, not permission to take actions. JSON Schema:\n' + this.source }
  }
  private checkSecrets(secrets: readonly string[]): void {
    if (containsSecret(this.source, secrets) || jsonContainsSecret(this.schema, secrets)) fail('output_schema_redacted')
  }
  wrapProvider(provider: ModelProvider, getSecrets: () => readonly string[]): ModelProvider {
    const inputWithSchema = (input: Parameters<ModelProvider['generate']>[0]): Parameters<ModelProvider['generate']>[0] => {
      this.checkSecrets(getSecrets())
      return { ...input, messages: [{ ...this.instruction }, ...input.messages] }
    }
    return {
      ...(provider.defaultOutputTokens === undefined ? {} : { defaultOutputTokens: provider.defaultOutputTokens }),
      // estimateContext has no purpose field. Including the prefix for summary estimates
      // is conservative; actual summary generation never receives the output constraint.
      ...(provider.estimateContext ? { estimateContext: (input, options) => provider.estimateContext!(inputWithSchema(input), options) } : {}),
      generate: (input, signal, options) => {
        this.checkSecrets(getSecrets())
        return provider.generate(options?.purpose === 'context-summary' ? input : inputWithSchema(input), signal, options)
      }
    }
  }
  validate(content: string, secrets: readonly string[]): JsonValue {
    if (Buffer.byteLength(content) > OUTPUT_SCHEMA_LIMITS.outputBytes) fail('output_too_large', 'output')
    let value: unknown
    try { value = JSON.parse(content) } catch { fail('invalid_json', 'output') }
    // JSON.parse accepts overflowing numbers. They cannot be faithfully emitted as JSON.
    checkJson(value, OUTPUT_SCHEMA_LIMITS.outputDepth, 'invalid_json', 'output')
    if (containsSecret(content, secrets) || containsSecret(JSON.stringify(value), secrets) || jsonContainsSecret(value, secrets)) fail('output_redacted', 'output')
    let valid: boolean
    try { valid = this.validator(value) === true } catch { fail('schema_mismatch', 'output') }
    if (!valid) fail('schema_mismatch', 'output')
    return value as JsonValue
  }
}

/** Bounded descriptor read; a pipe/device is never read and growth cannot allocate an unbounded buffer. */
export async function loadOutputSchema(path: string, secrets: readonly string[] = []): Promise<OutputSchema> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = await handle.stat()
    if (!stat.isFile()) fail('output_schema_unreadable')
    if (stat.size > OUTPUT_SCHEMA_LIMITS.bytes) fail('output_schema_too_large')
    const buffer = Buffer.alloc(OUTPUT_SCHEMA_LIMITS.bytes + 1)
    let length = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      length += bytesRead
      if (length > OUTPUT_SCHEMA_LIMITS.bytes) fail('output_schema_too_large')
      if (bytesRead === 0) break
    }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))) }
    catch { fail('output_schema_invalid') }
    return new OutputSchema(value, secrets)
  } catch (error) {
    if (error instanceof OutputSchemaError) throw error
    return fail('output_schema_unreadable')
  } finally {
    try { await handle?.close() } catch { fail('output_schema_unreadable') }
  }
}
