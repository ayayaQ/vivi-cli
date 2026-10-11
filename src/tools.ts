// SPDX-License-Identifier: Apache-2.0
import type { ToolCall, ToolDefinition, ToolResult } from '@ayayaq/vivi'
import { createExtensionScope, type ExtensionCleanup, type ToolExtension, type ToolRegistry } from '@ayayaq/vivi/extensions'
import { calculate, calculatorExtension } from '@ayayaq/vivi/extensions/calculator'
import { WORKSPACE_TOOL_NAMES } from './workspace.js'
import { COMMAND_TOOL_NAMES } from './commands.js'
import { PUBLIC_URL_TOOL_NAME } from './public-url-tools.js'
import { WORKSPACE_MUTATION_TOOL_NAMES } from './workspace-edit.js'
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
  /** Prepared note writes go through host-owned review/commit, never a replacement IO judge. */
  reviewNote?(call: ToolCall, before: NoteSnapshot, key: string, value: string, signal: AbortSignal): Promise<number | undefined>
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
    { name: 'note_set', description: 'Propose one session note change for host review. Use the latest note revision; never claim a save before its success result.',
      parameters: objectSchema({ key: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,40}$' },
        value: { type: 'string', maxLength: 4096 }, expectedRevision: { type: 'integer', minimum: 0 } },
      ['key', 'value', 'expectedRevision']) })
  return tools
}

/** Explicit imports only; one fixed registry pairs advertised tools with their executors. */
export function createBuiltinToolset(enableNotes = false, extensions: readonly ToolExtension[] = [], memory?: ToolExtension, workspace?: ToolExtension, skills?: ToolExtension, commands?: ToolExtension, mcp?: ToolExtension, publicUrl?: ToolExtension): {
  tools: ToolDefinition[]
  readonly signal: AbortSignal
  defer(cleanup: ExtensionCleanup): void
  dispose(): Promise<void>
  executeTool(call: ToolCall, signal: AbortSignal, host: ToolHost): Promise<ToolResult>
} {
  const scope = createExtensionScope({
    reservedNames: ['current_time', 'note_read', 'note_set', 'list_memories', 'create_memory', 'edit_memory', 'delete_memory', ...WORKSPACE_TOOL_NAMES, ...WORKSPACE_MUTATION_TOOL_NAMES, 'list_skills', 'read_skill', 'save_skill', ...COMMAND_TOOL_NAMES,
      PUBLIC_URL_TOOL_NAME, 'list_mcp_resources', 'read_mcp_resource', ...(mcp?.tools.map(tool => tool.definition.name) ?? [])]
  })
  // The trusted built-in memory pack is separate from caller extensions. Custom
  // imports cannot claim a memory name, even while the feature is disabled.
  const builtins = createExtensionScope({ reservedNames: ['save_skill'] })
  scope.defer(() => builtins.dispose())
  try {
    scope.register(calculatorExtension)
    for (const extension of extensions) scope.register(extension)
    for (const extension of [memory, workspace, skills, commands, mcp, publicUrl]) if (extension) builtins.register(extension)
    const registry = scope.snapshot(), builtinRegistry = builtins.snapshot()
    return {
      tools: [...registry.tools, ...hostTools(enableNotes), ...builtinRegistry.tools],
      signal: scope.signal,
      defer: cleanup => scope.defer(cleanup),
      dispose: () => scope.dispose(),
      executeTool: async (call, signal, host) => {
        scope.signal.throwIfAborted()
        // Host tools and built-in packs are restricted by this same turn owner.
        const ownedSignal = AbortSignal.any([signal, scope.signal])
        return builtinRegistry.has(call.name) ? builtinRegistry.executeTool(call, { signal: ownedSignal })
          : executeHostTool(call, ownedSignal, host, registry)
      }
    }
  } catch (error) {
    // No caller resource can have transferred yet. Seal every partial registration.
    void scope.dispose().catch(() => {})
    throw error
  }
}

export function builtinTools(enableNotes = false): ToolDefinition[] {
  const toolset = createBuiltinToolset(enableNotes)
  try { return structuredClone(toolset.tools) }
  finally { void toolset.dispose() }
}

export async function executeBuiltin(call: ToolCall, signal: AbortSignal, host: ToolHost): Promise<ToolResult> {
  const toolset = createBuiltinToolset(host.enableNotes)
  try { return await toolset.executeTool(call, signal, host) }
  finally { await toolset.dispose() }
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
      if (host.reviewNote) {
        const revision = await host.reviewNote(call, before, key, value, signal)
        return revision === undefined ? error('approval_denied', 'This note change was not approved')
          : { content: JSON.stringify({ success: true, key, revision }) }
      }
      if (!await host.approve({ call, description: `Set session note ${JSON.stringify(key)} to ${JSON.stringify(value)}`,
        currentRevision: before.revision }, signal)) return error('approval_denied', 'Human denied this note change')
      if (signal.aborted) return error('cancelled', 'Cancelled before note change')
      // The host rechecks revision and durably commits before reporting success.
      const revision = await host.commitNote(key, value, expectedRevision)
      return { content: JSON.stringify({ success: true, key, revision }) }
    }
    return error('unavailable_tool', 'Tool is unavailable')
  } catch (failure) {
    signal.throwIfAborted()
    return error('invalid_arguments', failure instanceof Error ? failure.message : 'Tool request failed')
  }
}
