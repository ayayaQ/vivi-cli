// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import type { Writable } from 'node:stream'
import type { AgentEvent, AgentResult, Usage } from '@ayayaq/vivi'
import type { ChatIO } from './terminal.js'
import type { ApprovalRequest } from './tools.js'
import { redactSecrets } from './session.js'

export const AUTOMATION_PROTOCOL = 'vivi.automation' as const
export const AUTOMATION_VERSION = 1 as const
export const AUTOMATION_LIMITS = Object.freeze({ recordBytes: 4 * 1024 * 1024, pendingBytes: 4 * 1024 * 1024,
  finalBytes: 256 * 1024, diagnosticBytes: 256 * 1024, writeTimeoutMs: 30_000 })
export type AutomationExitCode = 0 | 1 | 2 | 3 | 4 | 74 | 130 | 143
export type AutomationJson = null | boolean | number | string | AutomationJson[] | { [key: string]: AutomationJson }
export interface AutomationEnvelope {
  protocol: typeof AUTOMATION_PROTOCOL
  version: typeof AUTOMATION_VERSION
  run_id: string
  seq: number
}
export interface AutomationUsage { reported: Usage; complete: boolean }
export type AutomationPayload =
  | { type: 'run.started' }
  | { type: 'session.started'; session_id: string; provider: string; model: string }
  | { type: 'assistant.completed'; round: number; tool_call_count: number; text?: string }
  | { type: 'tool.started'; call_id: string; name: string }
  | { type: 'tool.completed'; call_id: string; name: string; is_error: boolean }
  | { type: 'round.completed'; round: number; usage: Usage | null }
  | { type: 'context.compaction.started'; reason: string }
  | { type: 'context.compaction.completed'; reason: string; before_tokens: number; after_tokens: number }
  | { type: 'context.compaction.failed'; reason: string; code: string }
  | { type: 'approval.denied'; reason: 'interaction_required' }
  | { type: 'run.completed'; exit_code: 0; session_id?: string; final_text: string; structured_output?: AutomationJson; rounds: number; usage: AutomationUsage }
  | { type: 'run.failed'; exit_code: 1 | 2 | 3 | 4; code: string; message: string; session_id?: string; rounds?: number; usage?: AutomationUsage }
  | { type: 'run.cancelled'; exit_code: 130 | 143; reason: 'SIGINT' | 'SIGTERM'; session_id?: string }
export type AutomationEvent = AutomationEnvelope & AutomationPayload
export interface AutomationDependencies {
  stdout?: Writable
  stderr?: Writable
  /** Test/embedding cancellation is equivalent to SIGINT; no stdin is ever consumed. */
  signal?: AbortSignal
  writeTimeoutMs?: number
}

/** Bounded acknowledgements, not an unbounded stream.write queue. Never destroys a caller-owned stream. */
class AutomationWriter {
  private pending = new Set<Promise<void>>()
  private rejectPending = new Set<(error: Error) => void>()
  private queuedBytes = 0
  failed = false
  private readonly error = (): void => this.fail()
  private readonly closed = (): void => this.fail()
  constructor(private readonly stream: Writable, private readonly timeout: number, private readonly onFailure: () => void) {
    stream.on('error', this.error)
    stream.on('close', this.closed)
  }
  fail(): void {
    if (this.failed) return
    this.failed = true
    for (const reject of this.rejectPending) reject(new Error('Automation output is unavailable'))
    this.onFailure()
  }
  write(text: string): Promise<void> {
    const bytes = Buffer.byteLength(text)
    if (this.failed || this.stream.destroyed || this.stream.writableEnded || bytes > AUTOMATION_LIMITS.recordBytes ||
      this.queuedBytes + bytes > AUTOMATION_LIMITS.pendingBytes) {
      this.fail(); return Promise.reject(new Error('Automation output is unavailable'))
    }
    this.queuedBytes += bytes
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error | null): void => {
        if (settled) return
        settled = true; clearTimeout(timer); this.rejectPending.delete(fail); this.queuedBytes -= bytes
        if (error) reject(new Error('Automation output is unavailable')); else resolve()
      }
      const fail = (error: Error): void => finish(error)
      const timer = setTimeout(() => this.fail(), this.timeout)
      this.rejectPending.add(fail)
      try { this.stream.write(text, error => { if (error) this.fail(); finish(error) }) }
      catch { this.fail() }
    })
    this.pending.add(promise)
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise))
    return promise
  }
  async flush(): Promise<void> {
    await Promise.all([...this.pending])
    if (this.failed) throw new Error('Automation output is unavailable')
  }
  dispose(): void {
    this.stream.off('close', this.closed)
    // A failed Writable can emit its error after the write callback. Keep the
    // already-installed inert handler until that stream is collected.
    if (!this.failed) this.stream.off('error', this.error)
  }
}

/** CLI-owned projection. Never serializes arbitrary AgentEvent, history, providerState or tool bodies. */
export class AutomationIO implements ChatIO {
  readonly canAutoReview = false
  readonly canAskQuestions = false
  readonly runId = randomUUID()
  private seq = 0
  private closed = false
  private diagnosticBytes = 0
  private readonly controller = new AbortController()
  private readonly listeners = new Set<() => void>()
  private readonly stdout: AutomationWriter
  private readonly stderr: AutomationWriter
  private readonly externalSignal: AbortSignal | undefined
  private readonly externalAbort = (): void => this.cancel('SIGINT')
  private readonly interrupt = (): void => this.cancel('SIGINT')
  private readonly terminate = (): void => this.cancel('SIGTERM')
  private terminal = false
  private sessionId: string | undefined
  private assistantRounds = 0
  private usageRounds = 0
  private missingUsage = false
  private denied = false
  private resultValue: AgentResult | undefined
  private problem: { code: string; exit: 1 | 2 | 3; message: string } | undefined
  private cleanupFailed = false
  private signalName: 'SIGINT' | 'SIGTERM' | undefined
  schemaMode = false
  readonly secrets: string[]
  constructor(secrets: readonly string[], options: AutomationDependencies = {}) {
    this.secrets = [...secrets]
    const timeout = options.writeTimeoutMs ?? AUTOMATION_LIMITS.writeTimeoutMs
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('Invalid automation output timeout')
    const failed = (): void => this.abort()
    this.stdout = new AutomationWriter(options.stdout ?? process.stdout, timeout, failed)
    this.stderr = new AutomationWriter(options.stderr ?? process.stderr, timeout, failed)
    process.on('SIGINT', this.interrupt); process.on('SIGTERM', this.terminate)
    this.externalSignal = options.signal
    options.signal?.addEventListener('abort', this.externalAbort, { once: true })
    if (options.signal?.aborted) this.cancel('SIGINT')
  }
  get signal(): AbortSignal { return this.controller.signal }
  get failed(): boolean { return this.stdout.failed || this.stderr.failed }
  get isClosed(): boolean { return this.closed || this.signal.aborted }
  private abort(): void {
    if (this.signal.aborted) return
    this.controller.abort()
    for (const callback of [...this.listeners]) callback()
  }
  private cancel(signal: 'SIGINT' | 'SIGTERM'): void {
    this.signalName ??= signal
    this.abort()
  }
  addSecrets(values: readonly string[]): void { for (const value of values) if (value && !this.secrets.includes(value)) this.secrets.push(value) }
  private safe(value: string): string { return redactSecrets(value, this.secrets) }
  async emit(payload: AutomationPayload): Promise<void> {
    if (this.terminal) throw new Error('Automation run already finalized')
    const terminal = payload.type === 'run.completed' || payload.type === 'run.failed' || payload.type === 'run.cancelled'
    const record: AutomationEvent = { protocol: AUTOMATION_PROTOCOL, version: AUTOMATION_VERSION, run_id: this.runId,
      seq: ++this.seq, ...payload }
    if (terminal) this.terminal = true
    await this.stdout.write(`${JSON.stringify(record)}\n`)
  }
  async started(): Promise<void> { await this.emit({ type: 'run.started' }) }
  async sessionStarted(id: string, provider: string, model: string): Promise<void> {
    this.sessionId = this.safe(id)
    await this.emit({ type: 'session.started', session_id: this.sessionId, provider: this.safe(provider), model: this.safe(model) })
  }
  write(text: string): void {
    if (this.failed || this.diagnosticBytes >= AUTOMATION_LIMITS.diagnosticBytes) return
    // Redact before truncation. Diagnostics are not a framing channel and never
    // accept an unbounded provider error, banner or repeating notice queue.
    const safe = this.safe(text).slice(0, 8192)
    this.diagnosticBytes += Buffer.byteLength(safe)
    if (this.diagnosticBytes > AUTOMATION_LIMITS.diagnosticBytes) return
    void this.stderr.write(safe).catch(() => undefined)
  }
  async event(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'text_delta': return // Provisional text is intentionally not part of protocol v1.
      case 'assistant':
        await this.emit({ type: 'assistant.completed', round: ++this.assistantRounds, tool_call_count: event.message.toolCalls.length,
          ...(!this.schemaMode ? { text: this.safe(event.message.content) } : {}) }); return
      case 'tool_started':
        await this.emit({ type: 'tool.started', call_id: this.safe(event.call.id), name: this.safe(event.call.name) }); return
      case 'tool_completed':
        await this.emit({ type: 'tool.completed', call_id: this.safe(event.message.callId), name: this.safe(event.message.name), is_error: event.message.isError === true }); return
      case 'round_completed':
        this.usageRounds++; if (!event.usage) this.missingUsage = true
        await this.emit({ type: 'round.completed', round: this.usageRounds, usage: event.usage ? this.usage(event.usage) : null }); return
      case 'compaction_started': await this.emit({ type: 'context.compaction.started', reason: event.reason }); return
      case 'compaction_completed': await this.emit({ type: 'context.compaction.completed', reason: event.reason, before_tokens: event.beforeTokens, after_tokens: event.afterTokens }); return
      case 'compaction_failed': await this.emit({ type: 'context.compaction.failed', reason: event.reason, code: this.safe(event.code) }); return
      default: return
    }
  }
  private usage(value: Usage): Usage {
    return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens,
      ...(value.cachedInputTokens === undefined ? {} : { cachedInputTokens: value.cachedInputTokens }),
      ...(value.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: value.cacheWriteInputTokens }) }
  }
  result(value: AgentResult): void { this.resultValue = value }
  async approve(_request: ApprovalRequest, _signal: AbortSignal): Promise<boolean> {
    this.denied = true
    await this.emit({ type: 'approval.denied', reason: 'interaction_required' })
    return false
  }
  async readLine(): Promise<undefined> { return undefined }
  onCancel(callback: () => void): () => void {
    if (this.signal.aborted) callback()
    else this.listeners.add(callback)
    return () => { this.listeners.delete(callback) }
  }
  close(): void { this.closed = true }
  failure(code: string, exit: 1 | 2 | 3 = 1, message = 'Automation run failed'): void { this.problem ??= { code, exit, message } }
  cleanupFailure(): void { this.cleanupFailed = true }
  caught(error: unknown): void {
    if (this.signalName && error instanceof Error && error.name === 'AbortError') return
    this.failure('runtime_error')
  }
  async finish(status: number, validate?: (content: string, secrets: readonly string[]) => AutomationJson): Promise<AutomationExitCode> {
    try {
      await this.stderr.flush()
      if (this.failed) return 74
      const result = this.resultValue
      const session = this.sessionId === undefined ? {} : { session_id: this.sessionId }
      const totals = result ? { rounds: result.rounds, usage: { reported: this.usage(result.usage),
        complete: !this.missingUsage && this.usageRounds === result.rounds } } : {}
      if (this.cleanupFailed) this.problem = { code: 'cleanup_failed', exit: 1, message: 'Owned resource cleanup could not be confirmed' }
      if (this.problem) {
        await this.emit({ type: 'run.failed', exit_code: this.problem.exit, code: this.problem.code, message: this.problem.message, ...session, ...totals })
        return this.problem.exit
      }
      if (this.signalName || status === 130 || result?.status === 'cancelled') {
        const reason = this.signalName ?? 'SIGINT', exit = reason === 'SIGTERM' ? 143 : 130
        await this.emit({ type: 'run.cancelled', exit_code: exit, reason, ...session }); return exit
      }
      if (status !== 0 || !result || result.status !== 'completed') {
        await this.emit({ type: 'run.failed', exit_code: 1, code: result?.error?.code ?? 'runtime_error', message: 'Automation run did not complete', ...session, ...totals }); return 1
      }
      if (this.denied) {
        await this.emit({ type: 'run.failed', exit_code: 4, code: 'interaction_required', message: 'An action required interactive approval', ...session, ...totals }); return 4
      }
      if (Buffer.byteLength(result.content) > AUTOMATION_LIMITS.finalBytes) {
        await this.emit({ type: 'run.failed', exit_code: 3, code: 'output_too_large', message: 'Final answer exceeded the output limit', ...session, ...totals }); return 3
      }
      let structured: AutomationJson | undefined
      if (validate) {
        try { structured = validate(result.content, this.secrets) }
        catch (error) {
          // The validator deliberately returns only a small fixed code vocabulary.
          const code = error instanceof Error && 'code' in error && typeof error.code === 'string' &&
            ['invalid_json', 'schema_mismatch', 'output_redacted', 'output_too_large'].includes(error.code) ? error.code : 'schema_mismatch'
          await this.emit({ type: 'run.failed', exit_code: 3, code, message: 'Final answer did not satisfy the output contract', ...session, ...totals }); return 3
        }
      }
      await this.emit({ type: 'run.completed', exit_code: 0, ...session, final_text: this.safe(result.content),
        ...(validate ? { structured_output: structured! } : {}), rounds: result.rounds,
        usage: { reported: this.usage(result.usage), complete: !this.missingUsage && this.usageRounds === result.rounds } })
      await this.stdout.flush()
      return this.failed ? 74 : 0
    } catch { return 74 }
    finally { this.dispose() }
  }
  dispose(): void {
    process.off('SIGINT', this.interrupt); process.off('SIGTERM', this.terminate)
    this.externalSignal?.removeEventListener('abort', this.externalAbort)
    this.listeners.clear(); this.stdout.dispose(); this.stderr.dispose()
  }
}
