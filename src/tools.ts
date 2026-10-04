// SPDX-License-Identifier: Apache-2.0
import type { ToolCall, ToolDefinition, ToolResult } from '@ayayaq/vivi'

export interface NoteSnapshot { revision: number; notes: Readonly<Record<string, string>> }
export interface ApprovalRequest {
  call: ToolCall
  description: string
  currentRevision: number
}
export interface ToolHost {
  enableNotes: boolean
  readNotes(): NoteSnapshot
  commitNote(key: string, value: string, expectedRevision: number): Promise<number>
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>
  now?(): Date
}
const objectSchema = (properties: Record<string, unknown>, required: string[]): ToolDefinition['parameters'] =>
  ({ type: 'object', properties, required, additionalProperties: false }) as ToolDefinition['parameters']

export function builtinTools(enableNotes = false): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    { name: 'calculate', description: 'Evaluate bounded arithmetic (+ - * / % and parentheses). No code execution.',
      parameters: objectSchema({ expression: { type: 'string', maxLength: 256 } }, ['expression']) },
    { name: 'current_time', description: 'Return the current time in a requested IANA timezone, default UTC.',
      parameters: objectSchema({ timezone: { type: 'string', maxLength: 100 } }, []) }
  ]
  if (enableNotes) tools.push(
    { name: 'note_read', description: 'Read this CLI session’s host-owned notes and revision. No filesystem access.',
      parameters: objectSchema({}, []) },
    { name: 'note_set', description: 'Set one session note after explicit human approval. Use the latest note revision.',
      parameters: objectSchema({ key: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,40}$' },
        value: { type: 'string', maxLength: 4096 }, expectedRevision: { type: 'integer', minimum: 0 } },
      ['key', 'value', 'expectedRevision']) })
  return tools
}

/** A small parser, deliberately excluding JavaScript, functions, assignments and exponents. */
export function calculate(expression: string): number {
  if (expression.length === 0 || expression.length > 256) throw new Error('Expression must contain 1..256 characters')
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)|[()+\-*/%]|\S/g) ?? []
  if (tokens.length > 128) throw new Error('Expression has too many tokens')
  let index = 0
  let depth = 0
  const checked = (value: number): number => {
    if (!Number.isFinite(value) || Math.abs(value) > 1e100) throw new Error('Arithmetic result is out of range')
    return value
  }
  const atom = (): number => {
    if (++depth > 24) throw new Error('Expression is too deeply nested')
    try {
      const token = tokens[index++]
      if (token === '+' || token === '-') return checked((token === '-' ? -1 : 1) * atom())
      if (token === '(') {
        const value = sum()
        if (tokens[index++] !== ')') throw new Error('Expected closing parenthesis')
        return value
      }
      if (!token || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) throw new Error('Expected a number or parenthesis')
      return checked(Number(token))
    } finally { depth-- }
  }
  const product = (): number => {
    let value = atom()
    while (['*', '/', '%'].includes(tokens[index] ?? '')) {
      const operation = tokens[index++]
      const right = atom()
      if ((operation === '/' || operation === '%') && right === 0) throw new Error('Division by zero')
      value = checked(operation === '*' ? value * right : operation === '/' ? value / right : value % right)
    }
    return value
  }
  const sum = (): number => {
    let value = product()
    while (tokens[index] === '+' || tokens[index] === '-') {
      const operation = tokens[index++]
      const right = product()
      value = checked(operation === '+' ? value + right : value - right)
    }
    return value
  }
  const result = sum()
  if (index !== tokens.length) throw new Error('Unexpected arithmetic token')
  return result
}

function error(code: string, message: string): ToolResult {
  return { content: JSON.stringify({ success: false, error: { code, message } }), isError: true }
}
function exactArguments(call: ToolCall, allowed: string[]): void {
  if (Object.keys(call.arguments).some((key) => !allowed.includes(key))) throw new Error('Unexpected argument')
}
export async function executeBuiltin(call: ToolCall, signal: AbortSignal, host: ToolHost): Promise<ToolResult> {
  try {
    if (signal.aborted) return error('cancelled', 'Cancelled before tool execution')
    if (call.name === 'calculate') {
      exactArguments(call, ['expression'])
      if (typeof call.arguments.expression !== 'string') throw new Error('expression must be a string')
      return { content: JSON.stringify({ result: calculate(call.arguments.expression) }) }
    }
    if (call.name === 'current_time') {
      exactArguments(call, ['timezone'])
      const timezone = call.arguments.timezone ?? 'UTC'
      if (typeof timezone !== 'string' || timezone.length > 100) throw new Error('timezone must be a bounded IANA name')
      const now = host.now?.() ?? new Date()
      const local = new Intl.DateTimeFormat('en-GB', { timeZone: timezone,
        dateStyle: 'full', timeStyle: 'long' }).format(now)
      return { content: JSON.stringify({ iso: now.toISOString(), timezone, local }) }
    }
    if (!host.enableNotes) return error('unavailable_tool', 'Notes are disabled')
    if (call.name === 'note_read') {
      exactArguments(call, [])
      return { content: JSON.stringify(host.readNotes()) }
    }
    if (call.name === 'note_set') {
      exactArguments(call, ['key', 'value', 'expectedRevision'])
      const { key, value, expectedRevision } = call.arguments
      if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(key) ||
        ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid note key')
      if (typeof value !== 'string' || value.length > 4096) throw new Error('Note value must be at most 4096 characters')
      if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new Error('expectedRevision must be a nonnegative integer')
      }
      const before = host.readNotes()
      if (before.revision !== expectedRevision) return error('revision_conflict', 'Read the latest notes before changing them')
      if (!Object.hasOwn(before.notes, key) && Object.keys(before.notes).length >= 64) throw new Error('Session has reached its note limit')
      if (!await host.approve({ call, description: `Set session note ${JSON.stringify(key)} to ${JSON.stringify(value)}`,
        currentRevision: before.revision }, signal)) return error('approval_denied', 'Human denied this note change')
      if (signal.aborted) return error('cancelled', 'Cancelled before note change')
      // The host rechecks revision and durably commits before reporting success.
      const revision = await host.commitNote(key, value, expectedRevision)
      return { content: JSON.stringify({ success: true, key, revision }) }
    }
    return error('unavailable_tool', 'Tool is unavailable')
  } catch (failure) {
    return error('invalid_arguments', failure instanceof Error ? failure.message : 'Tool request failed')
  }
}
