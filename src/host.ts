// SPDX-License-Identifier: Apache-2.0
import { runAgent } from '@ayayaq/vivi'
import { closeInterruptedHistory } from '@ayayaq/vivi'
import type { AgentEvent, AgentResult, HistoryMessage, ModelProvider, ToolCall, ToolResult, Usage } from '@ayayaq/vivi'
import { randomUUID } from 'node:crypto'
import { createMemoryExtension, formatMemoryContext, MEMORY_GUIDANCE } from '@ayayaq/vivi/extensions/memory'
import type { MemoryActor, MemoryListResult, MemoryMutation, MemoryToolCall } from '@ayayaq/vivi/extensions/memory'
import type { CliMemoryStore, MemoryCommitResult } from './memory.js'
import { createBuiltinToolset } from './tools.js'
import type { ToolExtension } from '@ayayaq/vivi/extensions'
import type { ApprovalRequest, NoteSnapshot } from './tools.js'
import { newSession, redactSecrets, validateSession } from './session.js'
import type { CliSession, SessionPersistence } from './session.js'
import { aggregateUsage } from './usage.js'
import { createWorkspaceExtension, WORKSPACE_GUIDANCE, WORKSPACE_TOOL_NAMES } from './workspace.js'
import type { ReadOnlyWorkspace } from './workspace.js'

const memoryToolNames = new Set(['list_memories', 'create_memory', 'edit_memory', 'delete_memory'])
const workspaceToolNames = new Set<string>(WORKSPACE_TOOL_NAMES)

function memoryContextContainsSecret(value: unknown, secrets: readonly string[]): boolean {
  const pending = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') {
      if (secrets.some(secret => secret.length > 0 && item.includes(secret))) return true
    } else if (Array.isArray(item)) {
      for (const child of item) pending.push(child)
    }
    else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) pending.push(key, child)
    }
  }
  return false
}

/** Stored legacy extras/revision bytes remain intact; tools expose a bounded whitelist. */
function memoryToolResult(result: MemoryCommitResult, committed = false): ToolResult {
  const projection = {
    ...(committed ? { success: true } : {}),
    memories: result.memories.map(memory => ({ id: memory.id, content: memory.content,
      createdAt: memory.createdAt, updatedAt: memory.updatedAt, createdBy: memory.createdBy,
      updatedBy: memory.updatedBy, revision: memory.revision })),
    limits: result.limits, ...(result.contentWithheld ? { contentWithheld: true } : {})
  }
  const content = JSON.stringify(projection)
  if (content.length <= 64 * 1024) return { content }
  // Do not truncate reviewed content or turn a committed mutation into failure.
  return { content: JSON.stringify({ success: committed, listingOmitted: true, limits: result.limits,
    error: { code: 'memory_listing_too_large', message: committed
      ? 'Memory change committed; its listing exceeds CLI transcript limits. Use /memories to view records'
      : 'Memory listing exceeds CLI transcript limits. Use /memories to view records' } }),
    ...(committed ? {} : { isError: true }) }
}

export interface CliHostOptions {
  provider: ModelProvider
  store: SessionPersistence
  session: CliSession
  enableNotes?: boolean
  /** Opt-in, app-wide state, independent of session-only notes. */
  enableMemory?: boolean
  memory?: CliMemoryStore
  /** Explicit launch-only read capability; never recovered from a session or preferences. */
  workspace?: ReadOnlyWorkspace
  /** Trusted, explicitly imported tool packs. Registration is captured once per turn. */
  extensions?: readonly ToolExtension[]
  /** A host can omit tools when the selected model's tool support is undeclared. */
  enableTools?: boolean
  secrets?: readonly string[]
  maxRounds?: number
  approve?(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>
  onMemoryNotice?(message: string): void
  onEvent?(event: AgentEvent): void | Promise<void>
}

export type MemoryChangeRequest =
  | { kind: 'create'; content: string }
  | { kind: 'update'; id: string; expectedRevision: string; content: string }
  | { kind: 'delete'; id: string; expectedRevision: string }

/** Thin application host: the shared core is the only provider/tool conversation loop. */
export class CliHost {
  private current: CliSession
  private controller: AbortController | undefined
  private persistence: Promise<void> = Promise.resolve()
  private enabledMemory: boolean
  constructor(private readonly options: CliHostOptions) {
    this.enabledMemory = options.enableMemory ?? false
    if (this.enabledMemory && !options.memory) throw new Error('Persistent memory requires a host-owned memory store')
    this.reportMemoryCapability()
    this.current = validateSession(options.session)
    this.current.history = closeInterruptedHistory(this.current.history)
    validateSession(this.current)
  }
  static async create(options: Omit<CliHostOptions, 'session'> & {
    settings: Parameters<typeof newSession>[0]
  }): Promise<CliHost> {
    const host = new CliHost({ ...options, session: newSession(options.settings) })
    await host.options.store.save(host.current)
    return host
  }
  static async resume(options: Omit<CliHostOptions, 'session'> & { id: string }): Promise<CliHost> {
    const host = new CliHost({ ...options, session: await options.store.load(options.id) })
    // Persist recovered unknown-outcome results before the next model request.
    await host.options.store.save(host.current)
    return host
  }
  get session(): CliSession { return structuredClone(this.current) }
  get running(): boolean { return this.controller !== undefined }
  get memoryEnabled(): boolean { return this.enabledMemory }
  private reportMemoryCapability(): void {
    if (this.enabledMemory && this.options.enableTools === false) {
      try { this.options.onMemoryNotice?.('Saved memory context is enabled. This model uses chat only, so the agent cannot save memory changes; /memories remains available') }
      catch { /* Display failures do not alter memory policy. */ }
    }
  }
  setMemoryEnabled(enabled: boolean): void {
    if (this.running) throw new Error('Wait for the current turn before changing persistent memory')
    if (enabled && !this.options.memory) throw new Error('Persistent memory requires a host-owned memory store')
    this.enabledMemory = enabled
    this.reportMemoryCapability()
  }
  async listMemories(signal?: AbortSignal): Promise<MemoryListResult> {
    if (!this.enabledMemory || !this.options.memory) throw new Error('Persistent memory is disabled; enable it with /memories')
    this.options.memory.addSecrets(this.options.secrets ?? [])
    return this.options.memory.list(signal)
  }
  async drainMemory(): Promise<void> { await this.options.memory?.drain() }
  private async prepareMemory(request: MemoryChangeRequest, actor: MemoryActor, signal: AbortSignal): Promise<MemoryMutation> {
    signal.throwIfAborted()
    if (!this.enabledMemory || !this.options.memory) throw new Error('Persistent memory is disabled')
    this.options.memory.addSecrets(this.options.secrets ?? [])
    if (request.kind === 'create') return this.options.memory.prepareCreate(request.content, actor, signal)
    if (request.kind === 'update') return this.options.memory.prepareUpdate(request.id, request.expectedRevision, request.content, actor, signal)
    return this.options.memory.prepareDelete(request.id, request.expectedRevision, signal)
  }
  private async reviewMemory(request: MemoryChangeRequest, actor: MemoryActor, call: ToolCall, signal: AbortSignal): Promise<MemoryCommitResult | undefined> {
    const mutation = await this.prepareMemory(request, actor, signal)
    signal.throwIfAborted()
    const action = mutation.kind === 'create' ? 'Create' : mutation.kind === 'update' ? 'Edit' : 'Delete'
    const approved = await (this.options.approve ?? (async () => false))({ call,
      currentRevision: mutation.kind === 'create' ? 'new memory' : mutation.expectedRevision,
      description: `${action} app-wide persistent memory. Stored locally as plaintext and sent to the selected provider when enabled.\nBefore: ${mutation.before ? JSON.stringify(mutation.before.content) : '(new memory)'}\nAfter: ${mutation.after ? JSON.stringify(mutation.after.content) : '(deleted)'}`
    }, signal)
    // Human review holds no file lease. Commit loads again and checks the exact
    // reviewed revision, so another session cannot be silently overwritten.
    if (!approved) return undefined
    signal.throwIfAborted()
    if (!this.enabledMemory || !this.options.memory) throw new Error('Persistent memory is disabled')
    this.options.memory.addSecrets(this.options.secrets ?? [])
    return this.options.memory.commit(mutation, { signal })
  }
  /** Explicit manager action still uses the same review and fresh commit policy. */
  async changeMemory(request: MemoryChangeRequest, signal = new AbortController().signal): Promise<MemoryCommitResult | undefined> {
    if (this.running) throw new Error('Wait for the current turn before managing persistent memory')
    const name = request.kind === 'create' ? 'create_memory' : request.kind === 'update' ? 'edit_memory' : 'delete_memory'
    const { kind: _kind, ...arguments_ } = request
    return this.reviewMemory(request, 'user', { id: randomUUID(), name, arguments: arguments_ }, signal)
  }
  private async executeMemory(call: MemoryToolCall, signal: AbortSignal): Promise<ToolResult> {
    try {
      signal.throwIfAborted()
      if (!this.enabledMemory || this.options.enableTools === false) throw new Error('Memory tools are unavailable for this turn')
      const arguments_ = call.arguments as { content: string; id: string; expectedRevision: string }
      const request: MemoryChangeRequest = call.name === 'create_memory'
        ? { kind: 'create', content: arguments_.content }
        : call.name === 'edit_memory' ? { kind: 'update', id: arguments_.id, expectedRevision: arguments_.expectedRevision, content: arguments_.content }
        : { kind: 'delete', id: arguments_.id, expectedRevision: arguments_.expectedRevision }
      const result = await this.reviewMemory(request, 'agent', call, signal)
      return result ? memoryToolResult(result, true)
        : { content: JSON.stringify({ success: false, error: { code: 'approval_denied', message: 'Human denied this memory change' } }), isError: true }
    } catch (error) {
      return { content: JSON.stringify({ success: false, error: { code: signal.aborted ? 'cancelled' : 'memory_change_failed',
        message: redactSecrets(error instanceof Error ? error.message : 'Memory change failed', this.options.secrets ?? []) } }), isError: true }
    }
  }
  cancel(): void { this.controller?.abort() }
  private async save(): Promise<void> {
    this.current.updatedAt = new Date().toISOString()
    const snapshot = structuredClone(this.current)
    const operation = this.persistence.then(() => this.options.store.save(snapshot))
    this.persistence = operation.catch(() => undefined)
    await operation
  }
  private notes(): NoteSnapshot {
    return { revision: this.current.noteRevision, notes: structuredClone(this.current.notes) }
  }
  private async commitNote(key: string, value: string, expectedRevision: number, signal: AbortSignal): Promise<number> {
    const operation = this.persistence.then(async () => {
      if (signal.aborted) throw new Error('Cancelled before note commit')
      if (this.current.noteRevision !== expectedRevision) throw new Error('Note revision changed while awaiting approval')
      if (this.current.noteRevision === Number.MAX_SAFE_INTEGER) throw new Error('Note revision limit reached')
      const next = structuredClone(this.current)
      next.notes[key] = redactSecrets(value, this.options.secrets ?? [])
      next.noteRevision++
      next.updatedAt = new Date().toISOString()
      await this.options.store.save(next)
      this.current = next
      return next.noteRevision
    })
    this.persistence = operation.then(() => undefined, () => undefined)
    return operation
  }
  async send(content: string, signal?: AbortSignal): Promise<AgentResult> {
    if (this.running) throw new Error('A CLI turn is already running')
    if (!content.trim() || content.length > 64 * 1024) throw new Error('Message must contain 1..65536 characters')
    const secrets = this.options.secrets ?? []
    if (secrets.some((secret) => secret.length > 0 && content.includes(secret))) {
      throw new Error('Message contains an environment credential; remove it before sending')
    }
    const enableNotes = this.options.enableNotes ?? false
    const enableTools = this.options.enableTools !== false
    const memory = this.enabledMemory && enableTools ? createMemoryExtension({
      listMemories: async ({ signal }) => memoryToolResult(await this.listMemories(signal)),
      executeMutation: (call, { signal }) => this.executeMemory(call, signal)
    }) : undefined
    const workspace = enableTools && this.options.workspace ? createWorkspaceExtension(this.options.workspace, secrets) : undefined
    const toolset = createBuiltinToolset(enableNotes, this.options.extensions, memory, workspace)
    const controller = new AbortController()
    this.controller = controller
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const baseUsage = structuredClone(this.current.usage)
    // An empty new session has no prior rounds. Historical assistant rounds with
    // omitted cache fields must remain unknown, including old schema-1 sessions.
    const priorUsage = this.current.history.some((message) => message.kind === 'assistant') ||
      Object.values(baseUsage).some((count) => count !== 0) ||
      Object.hasOwn(baseUsage, 'cachedInputTokens') || Object.hasOwn(baseUsage, 'cacheWriteInputTokens')
      ? [baseUsage] : []
    const roundUsage: (Usage | undefined)[] = []
    let prefix: HistoryMessage[] = []
    let memoryContents: readonly string[] = []
    try {
      if (this.enabledMemory) {
        const memories = await this.listMemories(controller.signal)
        memoryContents = memories.memories.map(memory => memory.content)
        prefix = [{ kind: 'message', role: 'system', content: `${MEMORY_GUIDANCE}\nEvery memory write requires explicit human approval.${enableTools ? '' : '\nMemory tools are unavailable this turn; do not claim memory changes were saved.'}` },
          { kind: 'message', role: 'user', content: formatMemoryContext(memories.memories) }]
      }
      if (workspace) prefix.push({ kind: 'message', role: 'system', content: WORKSPACE_GUIDANCE })
      this.current.history.push({ kind: 'message', role: 'user', content })
      await this.save()
      const generate = this.options.provider.generate.bind(this.options.provider)
      const result = await runAgent({
        provider: { generate: async (input, signal, options) => {
          // A checkpoint, approval or prior round may register a new credential
          // after the turn snapshot loaded. Reject it immediately before every
          // provider request, without silently rewriting approved context.
          const memoryToolContext: unknown[] = []
          for (const message of input.messages) {
            if (message.kind === 'tool_result' && (memoryToolNames.has(message.name) || workspaceToolNames.has(message.name))) {
              // Decode quoted/escaped content before checking, including resumed
              // canonical results that were serialized by an older host.
              try { memoryToolContext.push(JSON.parse(message.content)) }
              catch { memoryToolContext.push(message.content) }
            } else if (message.kind === 'assistant') {
              for (const call of message.toolCalls) if (memoryToolNames.has(call.name) || workspaceToolNames.has(call.name)) memoryToolContext.push(call.arguments)
            }
          }
          if (memoryContextContainsSecret([memoryContents, memoryToolContext], this.options.secrets ?? [])) {
            throw new Error('Saved memory or workspace context contains a known credential; provider request was blocked')
          }
          const output = await generate(input, signal, options)
          // Reject session-wide overflow before this response enters canonical history.
          aggregateUsage([...priorUsage, ...roundUsage, output.usage])
          return output
        } }, messages: [...prefix, ...this.current.history],
        tools: enableTools ? toolset.tools : [], signal: controller.signal,
        ...(this.options.maxRounds === undefined ? {} : { maxRounds: this.options.maxRounds }),
        executeTool: (call, context) => toolset.executeTool(call, context.signal, {
          enableNotes,
          readNotes: () => this.notes(),
          commitNote: (key, value, revision) => this.commitNote(key, value, revision, context.signal),
          approve: this.options.approve ?? (async () => false)
        }),
        onEvent: async (event) => {
          if (event.type === 'assistant') {
            this.current.history.push(structuredClone(event.message))
            // This checkpoint precedes round telemetry. A crash here cannot leave
            // a stale cache sum looking like a complete aggregate of the new history.
            delete this.current.usage.cachedInputTokens
            delete this.current.usage.cacheWriteInputTokens
            await this.save()
          } else if (event.type === 'tool_completed') {
            this.current.history.push(structuredClone(event.message))
            await this.save()
          } else if (event.type === 'round_completed') {
            roundUsage.push(event.usage)
            this.current.usage = aggregateUsage([...priorUsage, ...roundUsage])
            await this.save()
          }
          if (!controller.signal.aborted) await this.options.onEvent?.(event)
        }
      })
      // Await any in-flight atomic write, including a committed note whose result raced abort.
      await this.persistence
      await this.drainMemory()
      // Core abort cleanup intentionally skips callbacks. Always use its final canonical transcript.
      // The per-turn prefix is provider context only. Persisting it would revive
      // deleted preferences on resume and accumulate stale snapshots each turn.
      if (prefix.some((message, index) => JSON.stringify(result.history[index]) !== JSON.stringify(message))) {
        throw new Error('Agent returned an unexpected persistent-memory context prefix')
      }
      const canonicalResult = { ...result, history: structuredClone(result.history.slice(prefix.length)) }
      this.current.history = canonicalResult.history
      // Reconcile from the original baseline, never add final usage to event sums.
      // A cancelled/unaccepted response contributes no round and preserves prior metrics.
      this.current.usage = aggregateUsage([...priorUsage, ...(result.rounds > 0 ? [result.usage] : [])])
      await this.save()
      return canonicalResult
    } finally {
      // runAgent aborts uncooperative tools without awaiting their I/O. A save
      // already admitted by memory still owns its commit and lease until settled.
      await this.drainMemory()
      signal?.removeEventListener('abort', abort)
      this.controller = undefined
    }
  }
}
