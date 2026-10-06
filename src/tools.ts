// SPDX-License-Identifier: Apache-2.0
import type { ToolCall, ToolDefinition, ToolResult } from '@ayayaq/vivi'
import { createToolRegistry, type ToolExtension, type ToolRegistry } from '@ayayaq/vivi/extensions'
import { calculate, calculatorExtension } from '@ayayaq/vivi/extensions/calculator'
import { WORKSPACE_TOOL_NAMES } from './workspace.js'
export { calculate }

export interface NoteSnapshot { revision: number; notes: Readonly<Record<string, string>> }
export interface ApprovalRequest {
  call: ToolCall
  description: string
  currentRevision: number | string
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

function hostTools(enableNotes = false): ToolDefinition[] {
  const tools: ToolDefinition[] = [
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

/** Explicit imports only; one fixed registry pairs advertised tools with their executors. */
export function createBuiltinToolset(enableNotes = false, extensions: readonly ToolExtension[] = [], memory?: ToolExtension, workspace?: ToolExtension): {
  tools: ToolDefinition[]
  executeTool(call: ToolCall, signal: AbortSignal, host: ToolHost): Promise<ToolResult>
} {
  const registry = createToolRegistry([calculatorExtension, ...extensions], {
    reservedNames: ['current_time', 'note_read', 'note_set', 'list_memories', 'create_memory', 'edit_memory', 'delete_memory', ...WORKSPACE_TOOL_NAMES]
  })
  // The trusted built-in memory pack is separate from caller extensions. Custom
  // imports cannot claim a memory name, even while the feature is disabled.
  const memoryRegistry = memory ? createToolRegistry([memory]) : undefined
  const workspaceRegistry = workspace ? createToolRegistry([workspace]) : undefined
  return {
    tools: [...registry.tools, ...hostTools(enableNotes), ...(memoryRegistry?.tools ?? []), ...(workspaceRegistry?.tools ?? [])],
    executeTool: (call, signal, host) => memoryRegistry?.has(call.name)
      ? memoryRegistry.executeTool(call, { signal }) : workspaceRegistry?.has(call.name)
        ? workspaceRegistry.executeTool(call, { signal }) : executeHostTool(call, signal, host, registry)
  }
}

export function builtinTools(enableNotes = false): ToolDefinition[] {
  return structuredClone(createBuiltinToolset(enableNotes).tools)
}

export function executeBuiltin(call: ToolCall, signal: AbortSignal, host: ToolHost): Promise<ToolResult> {
  return createBuiltinToolset(host.enableNotes).executeTool(call, signal, host)
}

function error(code: string, message: string): ToolResult {
  return { content: JSON.stringify({ success: false, error: { code, message } }), isError: true }
}
function exactArguments(call: ToolCall, allowed: string[]): void {
  if (Object.keys(call.arguments).some((key) => !allowed.includes(key))) throw new Error('Unexpected argument')
}
async function executeHostTool(call: ToolCall, signal: AbortSignal, host: ToolHost, registry: ToolRegistry): Promise<ToolResult> {
  try {
    if (signal.aborted) return error('cancelled', 'Cancelled before tool execution')
    if (registry.has(call.name)) return await registry.executeTool(call, { signal })
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
