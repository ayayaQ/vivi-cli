// SPDX-License-Identifier: Apache-2.0
import {
  BoxRenderable, CliRenderEvents, CodeRenderable, createCliRenderer, decodePasteBytes, MarkdownRenderable,
  SelectRenderable, SelectRenderableEvents, SyntaxStyle, TextareaRenderable, TextRenderable,
  ScrollBoxRenderable, TreeSitterClient
} from '@opentui/core'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CliRenderer, KeyEvent, PasteEvent, Renderable } from '@opentui/core'
import type { AgentEvent, AgentResult, HistoryMessage, Usage } from '@ayayaq/vivi'
import type { CliSession } from './session.js'
import { redactSecrets } from './session.js'
import type { ChatIO } from './terminal.js'
import type { ApprovalRequest } from './tools.js'

export interface Choice<T> { name: string; description?: string; value: T }
export interface OpenTuiOptions { stream?: boolean; secrets?: readonly string[] }

const MAX_INPUT = 65536
const MAX_DISPLAY = 65536
const MAX_ENTRIES = 256
const HINTS = '/new /resume /settings /menu /help /exit · Enter send · Shift/Alt+Enter newline · PgUp/PgDn scroll'
type InputKind = 'chat' | 'text' | 'approval' | 'choice'
interface PendingInput {
  kind: InputKind
  armed: boolean
  finish(value: string | number | undefined, aborted?: boolean): void
}
interface DisplayEntry { label: string; content: string; markdown: boolean }

/** Strip entire terminal commands, including incomplete commands at a stream boundary.
 * Text is never sent to the terminal directly. Keep only ordinary text, tabs and newlines.
 */
function stripControls(text: string): string {
  let output = ''
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index)
    if (code === 0x1b || code === 0x9b || code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      const escape = code === 0x1b
      const next = escape ? text[++index] : undefined
      if (escape && next === undefined) break
      const csi = code === 0x9b || next === '['
      const string = [0x9d, 0x90, 0x98, 0x9e, 0x9f].includes(code) || (next !== undefined && ']PX^_'.includes(next))
      if (csi) {
        index++
        while (index < text.length && !(text.charCodeAt(index) >= 0x40 && text.charCodeAt(index) <= 0x7e)) index++
        if (index >= text.length) break
        index++
      } else if (string) {
        index++
        while (index < text.length && text.charCodeAt(index) !== 7 && text.charCodeAt(index) !== 0x9c &&
          !(text.charCodeAt(index) === 0x1b && text[index + 1] === '\\')) index++
        if (index >= text.length) break
        index += text.charCodeAt(index) === 0x1b ? 2 : 1
      } else {
        // ESC intermediate bytes (e.g. character-set selection) and their final byte.
        while (index < text.length && text.charCodeAt(index) >= 0x20 && text.charCodeAt(index) <= 0x2f) index++
        if (index >= text.length) break
        index++
      }
      continue
    }
    index++
    if ((code >= 0x20 && !(code >= 0x7f && code <= 0x9f) &&
      !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069)) || code === 9 || code === 10) {
      output += String.fromCharCode(code)
    }
  }
  return output
}

/** Imperative OpenTUI surface. Only the host's history is an accepted transcript. */
export class OpenTuiIO implements ChatIO {
  private readonly secrets: readonly string[]
  private readonly stream: boolean
  private style: SyntaxStyle | undefined
  private parser: TreeSitterClient | undefined
  private parserDirectory: string | undefined
  private shell!: BoxRenderable
  private header!: TextRenderable
  private transcript!: ScrollBoxRenderable
  private statusLine!: TextRenderable
  private composerBox!: BoxRenderable
  private composer!: TextareaRenderable
  private hintLine!: TextRenderable
  private pickerBox!: BoxRenderable
  private picker: SelectRenderable | undefined
  private partialBox: BoxRenderable | undefined
  private partial: MarkdownRenderable | undefined
  private entries: DisplayEntry[] = []
  private resultNotices: DisplayEntry[] = []
  private pending: PendingInput | undefined
  private closed = false
  private failure: Error | undefined
  private changingInput = false
  private cancelCallbacks = new Set<() => void>()
  private status = 'Ready'
  private sessionTitle = 'vivi · choose a session'
  private sessionId: string | undefined
  private usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  private streamed = ''
  private streamOverflow = false

  private readonly keyHandler = (key: KeyEvent): void => this.handleKey(key)
  private readonly pasteHandler = (event: PasteEvent): void => this.handlePaste(event)
  private readonly signalHandler = (): void => this.cancelOrClose()
  private readonly exitHandler = (): void => this.close()
  private readonly errorHandler = (event: { error?: unknown }): void => {
    this.failure = new Error(`OpenTUI renderer failed: ${this.safe(event.error instanceof Error ? event.error.message : 'native render or input handler error', 1024)}`)
    this.close()
  }
  private readonly destroyHandler = (): void => {
    this.dispose(false)
    this.renderer.off(CliRenderEvents.DESTROY, this.destroyHandler)
    // OpenTUI emits destroy immediately before recursively destroying its root.
    const style = this.style
    const parser = this.parser
    const directory = this.parserDirectory
    this.style = undefined
    this.parser = undefined
    this.parserDirectory = undefined
    queueMicrotask(() => {
      style?.destroy()
      // An IO owns its parser worker; closing a surface must not keep the CLI alive.
      // Only a private, disposable directory is used. Never touch OpenTUI's global cache.
      void (async () => {
        try { await parser?.destroy() }
        finally { if (directory) await rm(directory, { recursive: true, force: true }) }
      })().catch(() => undefined)
    })
  }

  constructor(private readonly renderer: CliRenderer, options: OpenTuiOptions = {}) {
    this.secrets = [...new Set(options.secrets ?? [])].filter(Boolean).sort((a, b) => b.length - a.length)
    this.stream = options.stream ?? true
    if (renderer.isDestroyed) throw new Error('Cannot use a destroyed OpenTUI renderer')
    renderer.once(CliRenderEvents.DESTROY, this.destroyHandler)
    try {
      this.style = SyntaxStyle.fromStyles({
        default: { fg: '#e4e4e7' }, 'markup.heading': { fg: '#a5b4fc', bold: true },
        'markup.strong': { bold: true }, 'markup.italic': { italic: true },
        'markup.raw': { fg: '#67e8f9' }, 'markup.link': { fg: '#93c5fd', underline: true },
        'markup.list': { fg: '#a5b4fc' }, 'markup.quote': { fg: '#a1a1aa', italic: true },
        conceal: { fg: '#71717a' }
      })
      this.shell = new BoxRenderable(renderer, { id: 'vivi-root', width: '100%', height: '100%',
        flexDirection: 'column', backgroundColor: '#18181b' })
      renderer.root.add(this.shell)
      this.header = new TextRenderable(renderer, { id: 'vivi-header', height: 2, flexShrink: 0,
        content: this.sessionTitle, fg: '#a5b4fc', wrapMode: 'word' })
      this.transcript = new ScrollBoxRenderable(renderer, { id: 'vivi-transcript', flexGrow: 1,
        minHeight: 1, width: '100%', scrollX: false, scrollY: true, stickyScroll: true,
        stickyStart: 'bottom', contentOptions: { flexDirection: 'column', paddingX: 1 },
        viewportCulling: true })
      this.statusLine = new TextRenderable(renderer, { id: 'vivi-status', height: 1, flexShrink: 0,
        fg: '#a1a1aa', content: this.status })
      this.composerBox = new BoxRenderable(renderer, { id: 'vivi-composer-box', height: 4,
        flexShrink: 0, border: true, borderColor: '#52525b', title: 'Message', paddingX: 1 })
      this.composer = new TextareaRenderable(renderer, { id: 'vivi-composer', width: '100%', height: 2,
        wrapMode: 'word', placeholder: 'Enter a message or /menu', backgroundColor: '#18181b',
        textColor: '#e4e4e7', focusedBackgroundColor: '#27272a', cursorColor: '#a5b4fc',
        keyBindings: ['return', 'kpenter', 'linefeed'].flatMap((name) => [
          { name, action: 'submit' as const }, { name, shift: true, action: 'newline' as const },
          { name, meta: true, action: 'newline' as const }
        ]), onSubmit: () => this.submit(), onContentChange: () => this.inputChanged() })
      this.composerBox.add(this.composer)
      this.hintLine = new TextRenderable(renderer, { id: 'vivi-hints', height: 1, flexShrink: 0,
        fg: '#71717a', content: HINTS, wrapMode: 'none' })
      this.pickerBox = new BoxRenderable(renderer, { id: 'vivi-picker-box', visible: false,
        height: 8, flexShrink: 0, border: true, borderColor: '#a5b4fc', paddingX: 1 })
      for (const child of [this.header, this.transcript, this.statusLine, this.composerBox,
        this.pickerBox, this.hintLine]) this.shell.add(child)
      this.disableComposer()
      renderer.keyInput.on('keypress', this.keyHandler)
      renderer.keyInput.on('paste', this.pasteHandler)
      renderer.on(CliRenderEvents.RENDER_ERROR, this.errorHandler)
      renderer.on(CliRenderEvents.HANDLER_ERROR, this.errorHandler)
      process.on('SIGINT', this.signalHandler)
      process.on('SIGTERM', this.exitHandler)
      process.on('SIGHUP', this.exitHandler)
      process.on('exit', this.exitHandler)
    } catch (error) {
      // Construction can fail before a widget is attached to the renderer's root.
      // Destroy detached widgets too; renderer.destroy only owns attached children.
      for (const widget of [this.composer, this.header, this.transcript, this.statusLine,
        this.composerBox, this.pickerBox, this.hintLine, this.shell]) {
        if (widget && !widget.parent && !widget.isDestroyed) {
          try { widget.destroyRecursively() } catch { /* Still release the renderer and hooks below. */ }
        }
      }
      this.close()
      throw error
    }
  }

  static async create(options: OpenTuiOptions = {}): Promise<OpenTuiIO> {
    // The official factory rolls back a failed async terminal setup.
    const renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [],
      screenMode: 'alternate-screen', consoleMode: 'disabled', openConsoleOnError: false,
      externalOutputMode: 'passthrough', useKittyKeyboard: { disambiguate: true, alternateKeys: true },
      backgroundColor: '#18181b' })
    try { return new OpenTuiIO(renderer, options) }
    catch (error) { if (!renderer.isDestroyed) renderer.destroy(); throw error }
  }

  get failed(): boolean { return this.failure !== undefined }
  get isClosed(): boolean { return this.closed }

  private safe(text: string, limit = MAX_DISPLAY): string {
    const safe = redactSecrets(stripControls(text), this.secrets)
    return safe.length > limit ? `${safe.slice(0, limit)}\n[display truncated]` : safe
  }
  private updateStatus(status = this.status): void {
    if (this.closed) return
    this.status = this.safe(status, 1024)
    this.statusLine.content = `${this.status} · ${this.usage.inputTokens} in / ${this.usage.outputTokens} out / ${this.usage.totalTokens} total`
  }
  private disableComposer(): void {
    this.composer?.blur()
    if (this.composer) {
      this.composer.traits = { suspend: true }
      this.composer.showCursor = false
    }
  }
  private clearInput(): void {
    if (!this.composer || this.composer.isDestroyed) return
    this.changingInput = true
    try { this.composer.setText('') } finally { this.changingInput = false }
  }
  private inputChanged(): void {
    if (this.closed || this.changingInput) return
    const raw = this.composer.plainText
    const safe = this.safe(raw, MAX_INPUT).slice(0, MAX_INPUT)
    if (raw === safe) return
    this.changingInput = true
    try { this.composer.setText(safe); this.composer.gotoBufferEnd() }
    finally { this.changingInput = false }
    this.updateStatus(raw.length > MAX_INPUT ? 'Input limit: 65536 characters' : 'Control text or known credential removed from input')
  }
  private consume(key: KeyEvent | PasteEvent): void { key.preventDefault(); key.stopPropagation() }
  private handlePaste(event: PasteEvent): void {
    this.consume(event)
    if (!this.pending?.armed || this.closed || this.pending.kind === 'choice') return
    if (this.cancelCallbacks.size && this.pending.kind !== 'approval') return
    if (this.pending.kind === 'approval') {
      this.clearInput()
      this.updateStatus('Approval requires typing allow or deny; pasted text ignored')
      return
    }
    const text = this.safe(decodePasteBytes(event.bytes), MAX_INPUT)
    const remaining = MAX_INPUT - this.composer.plainText.length
    if (text.length > remaining) { this.updateStatus('Paste ignored: input limit is 65536 characters'); return }
    this.composer.insertText(text)
  }
  private handleKey(key: KeyEvent): void {
    if (this.closed) { this.consume(key); return }
    if (key.eventType === 'release') { this.consume(key); return }
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      this.consume(key)
      if (key.name === 'escape' && (this.pending?.kind === 'choice' || this.pending?.kind === 'text')) {
        this.pending.finish(undefined)
      } else if (key.name === 'escape' && this.pending?.kind === 'chat' && !this.cancelCallbacks.size) {
        this.clearInput()
      } else this.cancelOrClose(key.name === 'escape')
      return
    }
    if (key.name === 'pageup' || key.name === 'pagedown' ||
      (key.ctrl && key.shift && (key.name === 'up' || key.name === 'down'))) {
      if (this.pending?.kind === 'choice') return
      this.consume(key)
      this.transcript.scrollTo(this.transcript.scrollTop + (key.name === 'pageup' || key.name === 'up' ? -1 : 1) *
        Math.max(1, this.transcript.viewport.height - 1))
      return
    }
    const pending = this.pending
    if (!pending?.armed) { this.consume(key); return }
    if (this.cancelCallbacks.size && pending.kind !== 'approval') { this.consume(key); return }
    if (pending.kind === 'chat' && key.ctrl && ['n', 'r', 'p'].includes(key.name)) {
      this.consume(key)
      if (!this.cancelCallbacks.size && !this.composer.plainText) {
        pending.finish(key.name === 'n' ? '/new' : key.name === 'r' ? '/resume' : '/menu')
      }
    }
  }
  private cancelOrClose(escape = false): void {
    if (this.closed) return
    if (this.pending?.kind === 'approval') this.pending.finish(undefined)
    this.clearInput()
    if (this.cancelCallbacks.size) {
      this.updateStatus('Cancelling…')
      for (const callback of [...this.cancelCallbacks]) callback()
    } else if (!escape) this.close()
    else this.pending?.finish(undefined)
  }
  private submit(): void {
    const pending = this.pending
    if (!pending?.armed || pending.kind === 'choice' || this.closed) return
    const text = this.composer.plainText
    if (pending.kind === 'approval') {
      const reply = text.trim().toLowerCase()
      if (reply === 'allow' || reply === 'deny' || !reply) pending.finish(reply || 'deny')
      else {
        this.clearInput()
        this.updateStatus('Please type allow or deny; Enter alone denies')
      }
      return
    }
    if (pending.kind === 'chat' && text.trim() && !text.trim().startsWith('/')) {
      this.appendEntry({ label: 'You', content: this.safe(text), markdown: false })
    }
    pending.finish(text)
  }
  private openInput(kind: InputKind, title: string, initial = '', signal?: AbortSignal): Promise<string | number | undefined> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closed) return Promise.resolve(undefined)
    if (signal?.aborted) return kind === 'chat' ? Promise.reject(new Error('Input cancelled')) : Promise.resolve(undefined)
    this.pending?.finish(undefined)
    this.clearInput()
    this.disableComposer()
    this.composerBox.visible = kind !== 'choice'
    this.composerBox.title = this.safe(title, 4096)
    this.hintLine.content = kind === 'chat' ? HINTS : kind === 'approval'
      ? 'Type allow or deny · Enter defaults to deny · Escape cancels · pasted approvals are ignored'
      : kind === 'choice' ? '↑/↓ select · Enter confirm · Escape back' : 'Enter confirm · Shift/Alt+Enter newline · Escape back'
    if (kind !== 'choice') this.composer.setText(this.safe(initial, MAX_INPUT).slice(0, MAX_INPUT))
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = (): void => pending.finish(undefined, true)
      const pending: PendingInput = { kind, armed: kind !== 'approval', finish: (value, aborted = false): void => {
        if (this.pending !== pending) return
        this.pending = undefined
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.disableComposer()
        this.clearInput()
        if (this.picker) { this.picker.destroyRecursively(); this.picker = undefined }
        this.pickerBox.visible = false
        this.composerBox.visible = true
        this.composerBox.title = 'Message'
        this.hintLine.content = HINTS
        if (this.failure) reject(this.failure)
        else if (aborted && kind === 'chat') reject(new Error('Input cancelled'))
        else resolve(value)
      } }
      this.pending = pending
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      if (kind === 'approval') {
        // Drain the input batch that preceded this newly displayed request. No buffered
        // Return, bracketed paste, draft text or editor undo can authorize a later action.
        timer = setTimeout(() => {
          if (this.pending !== pending || this.closed) return
          this.clearInput()
          pending.armed = true
          this.composer.traits = {}
          this.composer.showCursor = true
          this.composer.focus()
        }, 0)
      } else if (kind !== 'choice') {
        this.composer.traits = {}
        this.composer.showCursor = true
        this.composer.focus()
        this.composer.gotoBufferEnd()
      }
    })
  }
  async readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
    const value = await this.openInput('chat', prompt, '', signal)
    return typeof value === 'string' ? value : undefined
  }
  async askText(title: string, initial = ''): Promise<string | undefined> {
    const value = await this.openInput('text', title, initial)
    return typeof value === 'string' ? value : undefined
  }
  async choose<T>(title: string, choices: readonly Choice<T>[], initialIndex = 0): Promise<T | undefined> {
    if (this.failure) throw this.failure
    if (this.closed || choices.length === 0) return undefined
    if (choices.length > MAX_ENTRIES) throw new Error('A picker supports at most 256 choices')
    const selection = this.openInput('choice', title)
    this.pickerBox.title = this.safe(title, 4096)
    this.pickerBox.height = Math.max(4, Math.min(10, this.renderer.terminalHeight - 5, choices.length * 2 + 2))
    this.pickerBox.visible = true
    try {
      this.picker = new SelectRenderable(this.renderer, { id: 'vivi-picker', width: '100%', height: '100%',
        options: choices.map((choice, index) => ({ name: this.safe(choice.name, 1024),
          description: this.safe(choice.description ?? '', 2048), value: index })),
        selectedIndex: Math.max(0, Math.min(choices.length - 1, Number.isFinite(initialIndex) ? Math.trunc(initialIndex) : 0)),
        showDescription: true, showScrollIndicator: true, wrapSelection: true,
        backgroundColor: '#18181b', textColor: '#e4e4e7', selectedBackgroundColor: '#312e81',
        selectedTextColor: '#ffffff', descriptionColor: '#a1a1aa' })
      this.picker.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => this.pending?.finish(index))
      this.pickerBox.add(this.picker)
      this.picker.focus()
    } catch (error) {
      this.pending?.finish(undefined)
      throw error
    }
    const index = await selection
    return typeof index === 'number' ? choices[index]?.value : undefined
  }
  async approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    if (this.closed || signal.aborted) return false
    this.appendEntry({ label: `Approval required · current revision ${request.currentRevision}`,
      content: this.safe(request.description), markdown: false })
    this.updateStatus(`Approval required · revision ${request.currentRevision} · denial is the default`)
    const reply = await this.openInput('approval', 'Type allow or deny (default: deny)', '', signal)
    return reply === 'allow' && !signal.aborted && !this.closed
  }
  onCancel(callback: () => void): () => void {
    if (this.closed) { callback(); return () => undefined }
    this.cancelCallbacks.add(callback)
    this.resultNotices = []
    this.clearInput()
    this.disableComposer()
    this.updateStatus('Running · Escape / Ctrl+C cancels')
    return () => { this.cancelCallbacks.delete(callback) }
  }

  private markdown(content: string, streaming = false): MarkdownRenderable {
    if (!this.parser) {
      this.parserDirectory ??= mkdtempSync(join(tmpdir(), 'vivi-opentui-'))
      this.parser = new TreeSitterClient({ dataPath: this.parserDirectory })
    }
    return new MarkdownRenderable(this.renderer, { content, syntaxStyle: this.style!, streaming,
      width: '100%', fg: '#e4e4e7', treeSitterClient: this.parser,
      // Plain fenced code is readable offline and does not fetch language grammars.
      renderNode: (token, context) => {
        if (token.type === 'code') return new TextRenderable(this.renderer, {
          content: token.text, fg: '#67e8f9', width: '100%', wrapMode: 'word', flexShrink: 0 })
        const rendered = context.defaultRender()
        const readable = (node: Renderable): void => {
          if (node instanceof CodeRenderable) node.drawUnstyledText = true
          for (const child of node.getChildren()) readable(child)
        }
        if (rendered) readable(rendered)
        return rendered
      } })
  }
  private addEntry(entry: DisplayEntry): Renderable {
    const box = new BoxRenderable(this.renderer, { flexDirection: 'column', flexShrink: 0, width: '100%', marginBottom: 1 })
    box.add(new TextRenderable(this.renderer, { content: entry.label, fg: '#a5b4fc', flexShrink: 0, wrapMode: 'word' }))
    if (entry.content) box.add(entry.markdown ? this.markdown(entry.content) : new TextRenderable(this.renderer,
      { content: entry.content, fg: '#e4e4e7', width: '100%', wrapMode: 'word', flexShrink: 0 }))
    this.transcript.add(box)
    return box
  }
  private trimEntries(): void {
    let total = this.entries.reduce((sum, entry) => sum + entry.label.length + entry.content.length, 0)
    while (this.entries.length > 1 && (this.entries.length > MAX_ENTRIES || total > MAX_DISPLAY)) {
      const first = this.entries.shift()!
      total -= first.label.length + first.content.length
    }
  }
  private rebuild(): void {
    if (this.closed) return
    for (const child of [...this.transcript.getChildren()]) child.destroyRecursively()
    this.partial = undefined
    this.partialBox = undefined
    this.trimEntries()
    for (const entry of this.entries) this.addEntry(entry)
    if (this.streamed || this.streamOverflow) this.showPartial()
  }
  private appendEntry(entry: DisplayEntry): void {
    if (this.closed) return
    this.entries.push({ ...entry, label: this.safe(entry.label, 4096), content: this.safe(entry.content) })
    this.rebuild()
  }
  private historyEntries(history: readonly HistoryMessage[]): DisplayEntry[] {
    const entries: DisplayEntry[] = []
    let budget = MAX_DISPLAY
    for (let index = history.length - 1; index >= 0 && entries.length < MAX_ENTRIES - 1 && budget > 0; index--) {
      const message = history[index]!
      const label = message.kind === 'message' ? message.role === 'user' ? 'You' : 'System'
        : message.kind === 'assistant' ? 'Assistant' : `Tool ${message.name} · ${message.isError ? 'error' : 'done'}`
      const tools = message.kind === 'assistant' && message.toolCalls.length
        ? `\nTools requested: ${message.toolCalls.map((call) => call.name).join(', ')}` : ''
      const safeLabel = this.safe(label, 4096)
      const content = this.safe(message.content + tools, Math.max(0, budget - safeLabel.length))
      entries.unshift({ label: safeLabel, content, markdown: message.kind === 'assistant' })
      budget -= safeLabel.length + content.length
    }
    if (entries.length < history.length) entries.unshift({ label: 'Display limit',
      content: 'Earlier transcript is omitted from this bounded view; saved history is unchanged', markdown: false })
    return entries
  }
  setSession(session: CliSession): void {
    if (this.closed) return
    if (this.sessionId !== undefined && this.sessionId !== session.id) {
      this.resultNotices = []
      this.clearStream()
      this.status = 'Ready'
    }
    this.sessionId = session.id
    this.sessionTitle = this.safe(`vivi · ${session.provider} / ${session.model} · reasoning ${session.reasoning ?? 'default'}\nSession ${session.id}`, 4096)
    this.header.content = this.sessionTitle
    this.usage = { ...session.usage }
    this.entries = [...this.historyEntries(session.history), ...this.resultNotices]
    this.rebuild()
    this.updateStatus()
  }
  write(text: string): void {
    if (text) this.appendEntry({ label: 'vivi', content: this.safe(text.trimEnd()), markdown: false })
  }
  private safeStream(final = false): string {
    const text = stripControls(this.streamed)
    const hold = final ? 0 : Math.max(0, ...this.secrets.map((secret) => secret.length - 1))
    const limit = text.length - hold
    let output = ''
    for (let offset = 0; offset < limit;) {
      const secret = this.secrets.find((value) => text.startsWith(value, offset))
      if (secret) { output += '[REDACTED]'; offset += secret.length; continue }
      // Do not expose a credential prefix when a stream is cancelled or truncated.
      if (final && this.secrets.some((value) => value.startsWith(text.slice(offset)))) {
        output += '[REDACTED]'; break
      }
      output += text[offset++]
    }
    return this.safe(output)
  }
  private showPartial(): void {
    if (!this.partialBox) {
      this.partialBox = new BoxRenderable(this.renderer, { id: 'vivi-partial', flexDirection: 'column',
        flexShrink: 0, width: '100%', marginBottom: 1 })
      this.partialBox.add(new TextRenderable(this.renderer, { content: 'Assistant · streaming preview (not accepted)', fg: '#fbbf24' }))
      this.partial = this.markdown('', true)
      this.partialBox.add(this.partial)
      this.transcript.add(this.partialBox)
    }
    this.partial!.content = this.safeStream() + (this.streamOverflow ? '\n[display truncated; awaiting accepted response]' : '')
  }
  private clearStream(): void {
    this.streamed = ''
    this.streamOverflow = false
    this.partialBox?.destroyRecursively()
    this.partialBox = undefined
    this.partial = undefined
  }
  event(event: AgentEvent): void {
    if (this.closed) return
    if (event.type === 'text_delta' && this.stream) {
      const remaining = MAX_DISPLAY - this.streamed.length
      if (event.text.length > remaining) this.streamOverflow = true
      this.streamed += event.text.slice(0, remaining)
      this.showPartial()
      this.updateStatus('Receiving response · partial display only')
    } else if (event.type === 'assistant') {
      this.clearStream()
      this.appendEntry({ label: 'Assistant', content: event.message.content, markdown: true })
    } else if (event.type === 'tool_started') {
      this.updateStatus(`Tool running: ${event.call.name}`)
      this.appendEntry({ label: 'Tool activity', content: `${event.call.name} · running`, markdown: false })
    } else if (event.type === 'tool_completed') {
      this.appendEntry({ label: `Tool ${event.message.name} · ${event.message.isError ? 'error' : 'done'}`,
        content: event.message.content, markdown: false })
    } else if (event.type === 'round_completed' && event.usage) {
      this.usage = { ...event.usage }
      this.updateStatus('Round completed')
    }
  }
  result(result: AgentResult): void {
    if (this.closed) return
    const partial = result.status !== 'completed' && (this.streamed || this.streamOverflow)
      ? this.safeStream(true) + (this.streamOverflow ? '\n[display truncated]' : '') : undefined
    this.clearStream()
    this.entries = this.historyEntries(result.history)
    this.resultNotices = []
    if (partial !== undefined) this.resultNotices.push({ label: 'Partial display only · response was not accepted', content: partial, markdown: true })
    if (result.error) this.resultNotices.push({ label: 'Error', content: this.safe(result.error.message), markdown: false })
    this.entries.push(...this.resultNotices)
    this.rebuild()
    this.usage = { ...result.usage }
    this.updateStatus(result.status === 'completed' ? 'Completed' : result.status === 'cancelled' ? 'Cancelled' : 'Error')
  }
  private dispose(destroyRenderer: boolean): void {
    if (this.closed) return
    this.closed = true
    // Pending input is settled before the native widgets disappear.
    this.pending?.finish(undefined)
    for (const callback of [...this.cancelCallbacks]) {
      try { callback() } catch { /* Cleanup must finish even if host cancellation fails. */ }
    }
    this.cancelCallbacks.clear()
    this.renderer.keyInput.off('keypress', this.keyHandler)
    this.renderer.keyInput.off('paste', this.pasteHandler)
    this.renderer.off(CliRenderEvents.RENDER_ERROR, this.errorHandler)
    this.renderer.off(CliRenderEvents.HANDLER_ERROR, this.errorHandler)
    process.off('SIGINT', this.signalHandler)
    process.off('SIGTERM', this.exitHandler)
    process.off('SIGHUP', this.exitHandler)
    process.off('exit', this.exitHandler)
    this.streamed = ''
    this.entries = []
    if (destroyRenderer && !this.renderer.isDestroyed) this.renderer.destroy()
  }
  close(): void { this.dispose(true) }
}
