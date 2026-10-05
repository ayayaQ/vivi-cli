// SPDX-License-Identifier: Apache-2.0
import { runAgent } from '@ayayaq/vivi'
import { closeInterruptedHistory } from '@ayayaq/vivi'
import type { AgentEvent, AgentResult, ModelProvider } from '@ayayaq/vivi'
import { createBuiltinToolset } from './tools.js'
import type { ToolExtension } from '@ayayaq/vivi/extensions'
import type { ApprovalRequest, NoteSnapshot } from './tools.js'
import { newSession, redactSecrets, validateSession } from './session.js'
import type { CliSession, SessionPersistence } from './session.js'

export interface CliHostOptions {
  provider: ModelProvider
  store: SessionPersistence
  session: CliSession
  enableNotes?: boolean
  /** Trusted, explicitly imported tool packs. Registration is captured once per turn. */
  extensions?: readonly ToolExtension[]
  /** A host can omit tools when the selected model's tool support is undeclared. */
  enableTools?: boolean
  secrets?: readonly string[]
  maxRounds?: number
  approve?(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>
  onEvent?(event: AgentEvent): void | Promise<void>
}

/** Thin application host: the shared core is the only provider/tool conversation loop. */
export class CliHost {
  private current: CliSession
  private controller: AbortController | undefined
  private persistence: Promise<void> = Promise.resolve()
  constructor(private readonly options: CliHostOptions) {
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
    const toolset = createBuiltinToolset(enableNotes, this.options.extensions)
    const controller = new AbortController()
    this.controller = controller
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const baseUsage = structuredClone(this.current.usage)
    try {
      this.current.history.push({ kind: 'message', role: 'user', content })
      await this.save()
      const result = await runAgent({
        provider: this.options.provider, messages: this.current.history,
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
            await this.save()
          } else if (event.type === 'tool_completed') {
            this.current.history.push(structuredClone(event.message))
            await this.save()
          } else if (event.type === 'round_completed' && event.usage) {
            for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
              this.current.usage[key] += event.usage[key]
            }
            await this.save()
          }
          if (!controller.signal.aborted) await this.options.onEvent?.(event)
        }
      })
      // Await any in-flight atomic write, including a committed note whose result raced abort.
      await this.persistence
      // Core abort cleanup intentionally skips callbacks. Always use its final canonical transcript.
      this.current.history = structuredClone(result.history)
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
        this.current.usage[key] = baseUsage[key] + result.usage[key]
      }
      await this.save()
      return result
    } finally {
      signal?.removeEventListener('abort', abort)
      this.controller = undefined
    }
  }
}
