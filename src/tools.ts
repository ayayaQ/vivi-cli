// SPDX-License-Identifier: Apache-2.0
import type { ToolCall, ToolDefinition, ToolResult } from '@ayayaq/vivi'
import { createExtensionScope, type ExtensionCleanup, type ToolExtension, type ToolRegistry } from '@ayayaq/vivi/extensions'
import { calculate, calculatorExtension } from '@ayayaq/vivi/extensions/calculator'
import { WORKSPACE_TOOL_NAMES } from './workspace.js'
import { COMMAND_TOOL_NAMES } from './commands.js'
import { PUBLIC_URL_TOOL_NAME } from './public-url-tools.js'
import { WORKSPACE_MUTATION_TOOL_NAMES } from './workspace-edit.js'
import { QUESTION_TOOL_NAME } from './questions.js'
import { MCP_SETUP_TOOL_NAMES } from './mcp-setup-tools.js'
import { isPlanTool, planModeRefusal } from './task-mode.js'
import type { TaskMode } from './task-mode.js'
export { calculate }

/** Closed set of host-owned reads/informational tools. Names alone are not execution evidence. */
export function isBuiltinReadTool(name: string): boolean {
  return builtinToolOutcomePolicy(name) === 'local-read'
}

export type CliToolOutcomePolicy = 'local-read' | 'local-mutation' | 'command' | 'public-url' | 'mcp' | 'extension'
/** Closed inventory. Adding an advertised owned tool requires an explicit evidence policy. */
export const BUILTIN_TOOL_OUTCOME_POLICIES = Object.freeze({
  calculate: 'local-read', current_time: 'local-read', note_read: 'local-read', note_set: 'local-mutation',
  list_memories: 'local-read', create_memory: 'local-mutation', edit_memory: 'local-mutation', delete_memory: 'local-mutation',
  workspace_list: 'local-read', workspace_read: 'local-read', workspace_search: 'local-read', workspace_glob: 'local-read',
  workspace_create_text: 'local-mutation', workspace_edit_text: 'local-mutation',
  list_skills: 'local-read', read_skill: 'local-read', request_user_input: 'local-read',
  command_start: 'command', command_poll: 'command', command_stop: 'command', fetch_url: 'public-url',
  mcp_list: 'local-read', mcp_setup: 'mcp', list_mcp_resources: 'local-read', read_mcp_resource: 'mcp', read_mcp_resource_template: 'mcp'
} as const satisfies Record<string, CliToolOutcomePolicy>)
export function builtinToolOutcomePolicy(name: string): CliToolOutcomePolicy | undefined {
  return Object.hasOwn(BUILTIN_TOOL_OUTCOME_POLICIES, name)
    ? BUILTIN_TOOL_OUTCOME_POLICIES[name as keyof typeof BUILTIN_TOOL_OUTCOME_POLICIES] : undefined
}

export interface NoteSnapshot { revision: number; notes: Readonly<Record<string, string>> }
export interface ApprovalRequest {
  call: ToolCall
  description: string
  currentRevision: number | string
  /** Presentation only: the host-prepared workspace diff already included in description. */
  workspaceDiff?: string
}
export interface ToolHost {
  enableNotes: boolean
  readNotes(): NoteSnapshot
  commitNote(key: string, value: string, expectedRevision: number): Promise<number>
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>
  /** Prepared note writes go through host-owned review/commit, never a replacement IO judge. */
  reviewNote?(call: ToolCall, before: NoteSnapshot, key: string, value: string, signal: AbortSignal): Promise<number | { readonly revision: number; readonly durabilityUnconfirmed: true } | undefined>
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
export function createBuiltinToolset(enableNotes = false, extensions: readonly ToolExtension[] = [], memory?: ToolExtension, workspace?: ToolExtension, skills?: ToolExtension, commands?: ToolExtension, mcp?: ToolExtension, publicUrl?: ToolExtension, taskMode: TaskMode = 'execute', questions?: ToolExtension, mcpSetup?: ToolExtension): {
  tools: ToolDefinition[]
  readonly signal: AbortSignal
  readonly outcomePolicies: ReadonlyMap<string, CliToolOutcomePolicy>
  defer(cleanup: ExtensionCleanup): void
  dispose(): Promise<void>
  executeTool(call: ToolCall, signal: AbortSignal, host: ToolHost): Promise<ToolResult>
} {
  if (taskMode !== 'execute' && taskMode !== 'plan') throw new Error('Unknown task mode')
  const scope = createExtensionScope({
    reservedNames: ['current_time', 'note_read', 'note_set', 'list_memories', 'create_memory', 'edit_memory', 'delete_memory', ...WORKSPACE_TOOL_NAMES, ...WORKSPACE_MUTATION_TOOL_NAMES, 'list_skills', 'read_skill', 'save_skill', ...COMMAND_TOOL_NAMES,
      PUBLIC_URL_TOOL_NAME, QUESTION_TOOL_NAME, ...MCP_SETUP_TOOL_NAMES, 'list_mcp_resources', 'read_mcp_resource', 'read_mcp_resource_template', ...(mcp?.tools.map(tool => tool.definition.name) ?? [])]
  })
  // The trusted built-in memory pack is separate from caller extensions. Custom
  // imports cannot claim a memory name, even while the feature is disabled.
  const builtins = createExtensionScope({ reservedNames: ['save_skill'] })
  scope.defer(() => builtins.dispose())
  try {
    scope.register(calculatorExtension)
    if (taskMode !== 'plan') for (const extension of extensions) scope.register(extension)
    for (const extension of [memory, workspace, skills, questions, mcpSetup, ...(taskMode === 'plan' ? [] : [commands, mcp, publicUrl])]) if (extension) {
      builtins.register(taskMode === 'plan' ? { ...extension, tools: extension.tools.filter(tool => isPlanTool(tool.definition.name)) } : extension)
    }
    const registry = scope.snapshot(), builtinRegistry = builtins.snapshot()
    const tools = [...registry.tools, ...hostTools(enableNotes), ...builtinRegistry.tools]
      .filter(tool => taskMode !== 'plan' || isPlanTool(tool.name))
    const allowed = new Set(tools.map(tool => tool.name))
    const outcomePolicies = new Map<string, CliToolOutcomePolicy>()
    const own = (name: string): void => {
      const policy = builtinToolOutcomePolicy(name)
      if (!policy) throw new Error(`Owned tool has no outcome policy: ${name}`)
      outcomePolicies.set(name, policy)
    }
    for (const tool of calculatorExtension.tools) own(tool.definition.name)
    for (const tool of hostTools(enableNotes)) if (allowed.has(tool.name)) own(tool.name)
    for (const extension of [memory, workspace, skills, questions, mcpSetup, ...(taskMode === 'plan' ? [] : [commands, publicUrl])]) {
      for (const tool of extension?.tools ?? []) if (allowed.has(tool.definition.name)) own(tool.definition.name)
    }
    for (const tool of mcp?.tools ?? []) if (allowed.has(tool.definition.name)) outcomePolicies.set(tool.definition.name, builtinToolOutcomePolicy(tool.definition.name) ?? 'mcp')
    for (const tool of tools) if (!outcomePolicies.has(tool.name)) outcomePolicies.set(tool.name, 'extension')
    return {
      tools,
      signal: scope.signal,
      outcomePolicies,
      defer: cleanup => scope.defer(cleanup),
      dispose: () => scope.dispose(),
      executeTool: async (call, signal, host) => {
        scope.signal.throwIfAborted()
        signal.throwIfAborted()
        // Advertisement is not the enforcement boundary: a direct or retained
        // dispatcher cannot invoke an omitted tool or reuse another turn's approval.
        if (taskMode === 'plan' && !allowed.has(call.name)) return planModeRefusal()
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
          : { content: JSON.stringify({ success: true, key, ...(typeof revision === 'number' ? { revision } : revision) }) }
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
