// SPDX-License-Identifier: Apache-2.0
import { createInterface, emitKeypressEvents } from 'node:readline'
import type { Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { AgentEvent, AgentResult } from '@ayayaq/vivi'
import type { CliHost } from './host.js'
import { redactSecrets } from './session.js'
import type { ApprovalRequest } from './tools.js'
import { aggregateUsage, formatUsage } from './usage.js'

export interface ChatIO {
  /** Fatal native UI failure means output should go to stderr after terminal restoration. */
  readonly failed?: boolean
  readonly isClosed?: boolean
  readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined>
  write(text: string): void
  event(event: AgentEvent): void
  result(result: AgentResult): void
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>
  onCancel(callback: () => void): () => void
  close(): void
}
export interface TerminalOptions {
  input?: Readable
  output?: Writable
  tui?: boolean
  stream?: boolean
  secrets?: readonly string[]
}
type TtyReadable = Readable & { isTTY?: boolean }
type TtyWritable = Writable & { isTTY?: boolean; rows?: number; columns?: number }

/** Node builtins only; the renderer never turns display text into accepted transcript content. */
export class TerminalIO implements ChatIO {
  private readonly input: TtyReadable
  private readonly output: TtyWritable
  private readonly readline: Interface
  private readonly secrets: readonly string[]
  private readonly tui: boolean
  private readonly stream: boolean
  private lines: string[] = []
  private waiters: { resolve(value: string | undefined): void; reject(error: Error): void }[] = []
  private ended = false
  private disposed = false
  private cancelCallbacks = new Set<() => void>()
  private display = ''
  private status = 'Ready'
  private prompt = ''
  private waiting = false
  private streamed = ''
  private streamedOffset = 0
  private streamOverflow = false
  private readonly keyHandler: (_text: string, key: { name?: string }) => void
  private readonly signalHandler: () => void
  constructor(options: TerminalOptions = {}) {
    this.input = options.input ?? process.stdin
    this.output = options.output ?? process.stdout
    this.secrets = options.secrets ?? []
    this.tui = Boolean(options.tui && this.input.isTTY && this.output.isTTY)
    this.stream = options.stream ?? true
    this.readline = createInterface({ input: this.input, output: this.output, terminal: Boolean(this.input.isTTY && this.output.isTTY),
      historySize: 0, removeHistoryDuplicates: true, crlfDelay: Infinity })
    this.readline.on('line', (line: string) => {
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(line.length <= 65536 ? line : '')
      else if (this.lines.length < 32 && line.length <= 65536) this.lines.push(line)
    })
    this.readline.on('close', () => {
      this.ended = true
      for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined)
    })
    const cancel = (): void => {
      // Do not carry a half-typed approval into a later chat or approval prompt.
      this.clearEditableInput()
      if (this.cancelCallbacks.size) for (const callback of this.cancelCallbacks) callback()
      else this.close()
    }
    this.readline.on('SIGINT', cancel)
    this.signalHandler = cancel
    process.on('SIGINT', this.signalHandler)
    emitKeypressEvents(this.input, this.readline)
    this.keyHandler = (_text, key): void => { if (key.name === 'escape') cancel() }
    this.input.on('keypress', this.keyHandler)
    if (this.tui) this.output.write('\x1b[?1049h')
  }
  private clearEditableInput(): void {
    if (!this.input.isTTY || !this.output.isTTY || this.disposed || this.ended) return
    this.readline.write(null, { ctrl: true, name: 'u' })
    // Some terminal implementations ignore synthetic control keys. Keep the documented
    // line and cursor properties synchronized when clearing the remaining input.
    if (this.readline.line) Object.assign(this.readline, { line: '', cursor: 0 })
  }
  private safe(text: string): string {
    // Strip terminal control characters, including model-provided escape sequences.
    return redactSecrets(text, this.secrets).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
  }
  private render(): void {
    if (!this.tui) return
    const columns = Math.max(20, Math.min(this.output.columns ?? 80, 200))
    const rows = Math.max(6, Math.min(this.output.rows ?? 24, 100))
    const wrap = (text: string): string[] => text.split('\n').flatMap((line) => {
      const chunks: string[] = []
      for (let index = 0; index < Math.max(1, line.length); index += columns) chunks.push(line.slice(index, index + columns))
      return chunks
    })
    const status = wrap(this.status).slice(0, rows - 3)
    const bodyRows = rows - 3 - status.length
    const body = bodyRows > 0 ? wrap(this.display).slice(-bodyRows) : []
    this.output.write(`\x1b[2J\x1b[H${[
      'vivi | Ctrl-C / Escape cancels'.slice(0, columns), ...body, '-'.repeat(columns), ...status
    ].join('\n')}\n`)
    if (this.waiting) this.readline.prompt(true)
  }
  write(text: string): void {
    const safe = this.safe(text)
    if (!this.tui) this.output.write(safe)
    else {
      this.display = (this.display + safe).slice(-65536)
      this.render()
    }
  }
  async readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) throw new Error('Input cancelled')
    if (this.lines.length) return this.lines.shift()
    if (this.ended) return undefined
    this.prompt = this.safe(prompt)
    this.waiting = true
    this.readline.setPrompt(this.prompt)
    if (this.tui) this.render()
    else this.readline.prompt()
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const waiter = {
          resolve: (value: string | undefined): void => { cleanup(); resolve(value) },
          reject: (error: Error): void => { cleanup(); reject(error) }
        }
        const abort = (): void => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          waiter.reject(new Error('Input cancelled'))
        }
        const cleanup = (): void => signal?.removeEventListener('abort', abort)
        this.waiters.push(waiter)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    } finally { this.waiting = false }
  }
  onCancel(callback: () => void): () => void {
    this.cancelCallbacks.add(callback)
    return () => { this.cancelCallbacks.delete(callback) }
  }
  private flushStream(final = false): void {
    const secrets = [...new Set(this.secrets)].filter(Boolean).sort((a, b) => b.length - a.length)
    const hold = final ? 0 : Math.max(0, ...secrets.map((secret) => secret.length - 1))
    const limit = this.streamed.length - hold
    let offset = this.streamedOffset
    let display = ''
    while (offset < limit) {
      const secret = secrets.find((value) => this.streamed.startsWith(value, offset))
      if (secret) { display += '[REDACTED]'; offset += secret.length }
      else display += this.streamed[offset++]
    }
    this.streamedOffset = offset
    if (display) this.write(display)
  }
  event(event: AgentEvent): void {
    if (event.type === 'text_delta' && this.stream) {
      // Redact before buffering. Delay output by the longest secret length so split chunks cannot leak it.
      if (this.streamed.length + event.text.length <= 65536) this.streamed += event.text
      else this.streamOverflow = true
      this.status = 'Receiving response'
      this.flushStream()
    } else if (event.type === 'assistant') {
      const content = event.message.content
      if (this.streamed && this.streamed === content && !this.streamOverflow) {
        this.flushStream(true)
        this.write('\n')
      } else {
        if (this.streamedOffset > 0) this.write('\n[accepted response]\n')
        this.write(content ? `${content}\n` : '')
      }
      this.streamed = ''
      this.streamedOffset = 0
      this.streamOverflow = false
    } else if (event.type === 'tool_started') {
      this.status = `Tool: ${this.safe(event.call.name)}`
      this.write(`[tool ${event.call.name}]\n`)
    } else if (event.type === 'tool_completed') {
      this.write(`[tool ${event.message.name}: ${event.message.isError ? 'error' : 'done'}] ${event.message.content}\n`)
    } else if (event.type === 'round_completed') {
      this.status = `Round tokens: ${formatUsage(aggregateUsage([event.usage]))}`
      this.render()
    }
  }
  result(result: AgentResult): void {
    if (result.status !== 'completed' && (this.streamed || this.streamOverflow)) {
      this.flushStream(true)
      this.write(`${this.streamOverflow ? ' [display truncated]' : ''}\n[Partial display only; this response was not accepted]\n`)
    }
    this.streamed = ''
    this.streamedOffset = 0
    this.streamOverflow = false
    this.status = `${result.status} | Turn tokens: ${formatUsage(result.usage)}`
    this.write(`[${this.status}]${result.error ? ` ${result.error.message}` : ''}\n`)
  }
  async approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    // An approval starts with fresh input, including text typed without a newline.
    this.lines = []
    this.clearEditableInput()
    this.write(`Approval required (revision ${request.currentRevision}): ${request.description}\n`)
    // Piped or queued text cannot grant approval for an action that has not been shown yet.
    if (!this.input.isTTY || !this.output.isTTY) { this.write('Denied: interactive approval is required\n'); return false }
    for (;;) {
      const reply = await this.readLine('Type allow or deny: ', signal)
      if (reply === undefined || reply.trim().toLowerCase() === 'deny') return false
      if (reply.trim().toLowerCase() === 'allow') return true
      this.write('Please type allow or deny\n')
    }
  }
  close(): void {
    if (this.disposed) return
    this.disposed = true
    this.lines = []
    process.removeListener('SIGINT', this.signalHandler)
    this.input.removeListener('keypress', this.keyHandler)
    this.readline.close()
    if (this.tui) this.output.write('\x1b[?1049l')
  }
}

export async function runChatLoop(host: CliHost, io: ChatIO, prompt?: string): Promise<AgentResult | undefined> {
  if (prompt !== undefined) {
    const dispose = io.onCancel(() => host.cancel())
    try {
      const result = await host.send(prompt)
      io.result(result)
      return result
    } finally { dispose() }
  }
  io.write('Enter a message; /exit quits and /session shows the session id\n')
  for (;;) {
    const line = await io.readLine('You: ')
    if (line === undefined || line.trim() === '/exit') return
    if (line.trim() === '/session') {
      const session = host.session
      io.write(`Session: ${session.id}\nSession tokens: ${formatUsage(session.usage)}\n`)
      continue
    }
    if (!line.trim()) continue
    const dispose = io.onCancel(() => host.cancel())
    try { io.result(await host.send(line)) }
    catch (error) { io.write(`${error instanceof Error ? error.message : 'CLI turn failed'}\n`) }
    finally { dispose() }
  }
}
