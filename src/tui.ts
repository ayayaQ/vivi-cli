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
import type { CliRenderer, KeyEvent, MouseEvent, PasteEvent, Renderable } from '@opentui/core'
import type { AgentEvent, AgentResult, HistoryMessage, Usage } from '@ayayaq/vivi'
import type { CliProviderName, CliSession } from './session.js'
import { redactSecrets } from './session.js'
import type { ChatIO } from './terminal.js'
import type { ApprovalRequest } from './tools.js'
import { matchingChoiceIndices } from './picker.js'
import { createWindowsInputBridge } from './windows-input.js'
import type { WindowsInputBridge } from './windows-input.js'
import { inputProbe } from './input-diagnostic.js'
import type { InputDiagnosticReport, InputProbe } from './input-diagnostic.js'
import type { Choice, SearchableOptions, SearchableSelection } from './picker.js'
import { aggregateUsage, formatUsage } from './usage.js'
import { MouseActivation, pickerIndexAt } from './tui-mouse.js'

export type { Choice } from './picker.js'
export interface OpenTuiOptions { stream?: boolean; secrets?: readonly string[] }

export const TUI_THEME = { pink: '#f87ea2', lavender: '#b08bfc', background: '#18181b',
  foreground: '#e4e4e7', selectedBackground: '#3d2946' } as const
export const SLASH_COMMANDS = [
  { command: '/provider', description: 'Choose a provider' },
  { command: '/models', description: 'Choose a model' },
  { command: '/effort', description: 'Choose reasoning effort' },
  { command: '/new', description: 'Start a new session' },
  { command: '/resume', description: 'Resume a saved session' },
  { command: '/settings', description: 'Change future defaults' },
  { command: '/memories', description: 'Manage app-wide saved context' },
  { command: '/menu', description: 'Open the menu' },
  { command: '/help', description: 'Show commands and shortcuts' },
  { command: '/session', description: 'Show the current session' },
  { command: '/exit', description: 'Exit vivi' }
] as const
export type SlashCommand = typeof SLASH_COMMANDS[number]

/** Complete only the whole, first slash token. Ordinary text and arguments are untouched. */
export function getSlashCommandCompletions(input: string): readonly SlashCommand[] {
  return /^\/[a-z]*$/.test(input) ? SLASH_COMMANDS.filter(({ command }) => command.startsWith(input)) : []
}

const MAX_INPUT = 65536
const MAX_SECRET = 4096
const MAX_DISPLAY = 65536
const MAX_ENTRIES = 256
const MAX_QUERY = 200
/** Conservative cell budget keeps wide Unicode paths on one terminal row. */
function fitStatusColumns(text: string, columns: number): string {
  const characters = [...text]
  const width = (character: string): number => character.codePointAt(0)! <= 0x7f ? 1 : 2
  if (characters.reduce((total, character) => total + width(character), 0) <= columns) return text
  if (columns < 2) return columns > 0 ? '…' : ''
  const leftBudget = Math.ceil((columns - 2) / 2), rightBudget = Math.floor((columns - 2) / 2)
  let left = '', right = '', used = 0
  for (const character of characters) {
    if (used + width(character) > leftBudget) break
    left += character; used += width(character)
  }
  used = 0
  for (const character of characters.reverse()) {
    if (used + width(character) > rightBudget) break
    right = character + right; used += width(character)
  }
  return `${left}…${right}`
}
// OpenTUI 0.5.14 groups repeated clicks for 500ms; allow a frame-timing margin.
const APPROVAL_REPEAT_WINDOW_MS = 600
const HINTS = 'Enter send · Ctrl+J newline · /new /resume /memories /settings /menu /help /exit'
type InputKind = 'chat' | 'text' | 'secret' | 'approval' | 'choice' | 'search'
interface PendingInput {
  kind: InputKind
  armed: boolean
  openedFrame: number
  finish(value: string | number | undefined, aborted?: boolean): void
}
interface DisplayEntry { label: string; content: string; markdown: boolean }
interface SearchPicker {
  choices: readonly Choice<unknown>[]
  matches: number[]
  query: string
  refresh: boolean
}

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
  private secrets: readonly string[]
  private readonly stream: boolean
  private style: SyntaxStyle | undefined
  private parser: TreeSitterClient | undefined
  private parserDirectory: string | undefined
  private shell!: BoxRenderable
  private header!: TextRenderable
  private actionBar!: BoxRenderable
  private dialogActions: BoxRenderable | undefined
  private approvalIndex = 0
  private approvalMouseNotBefore = 0
  private readonly mouseActivation = new MouseActivation()
  private pickerChangedFrame = 0
  private completionChangedFrame = 0
  private lastRenderedFrame = 0
  private transcript!: ScrollBoxRenderable
  private statusLine!: TextRenderable
  private composerBox!: BoxRenderable
  private composer!: TextareaRenderable
  private secretMask!: TextRenderable
  // Secret characters never enter an editable/renderable buffer or its undo history.
  private secretInput: string[] = []
  private secretCursor = 0
  private completionBox!: BoxRenderable
  private completionList!: TextRenderable
  private completions: readonly SlashCommand[] = []
  private completionIndex = 0
  private completionInput = ''
  private acceptedCompletion: string | undefined
  private hintLine!: TextRenderable
  private pickerBox!: BoxRenderable
  private picker: SelectRenderable | undefined
  private searchPicker: SearchPicker | undefined
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
  private workspaceDirectory: string | undefined
  private workspaceStatus = false
  private sessionTitle = 'vivi · fresh conversation'
  private sessionId: string | undefined
  private usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  private usageScope: 'Session' | 'Round' | 'Turn' = 'Session'
  private streamed = ''
  private streamOverflow = false
  private windowsInput: WindowsInputBridge | undefined
  private diagnosticKey: ((key: KeyEvent) => void) | undefined
  private finishDiagnostic: (() => void) | undefined

  private readonly keyHandler = (key: KeyEvent): void => {
    try { this.handleKey(key) } catch (error) { this.errorHandler({ error }) }
  }
  private readonly frameHandler = (event: { frameId: number }): void => {
    this.lastRenderedFrame = event.frameId
    // Native undo/deletion notifications can precede the new buffer contents.
    // Reconcile after a completed frame as well as at ordinary edit callbacks.
    this.updateComposerLayout()
  }
  private readonly focusHandler = (): void => { this.mouseActivation.clear() }
  private readonly blurHandler = (): void => {
    this.mouseActivation.clear()
    if (this.pending?.kind === 'approval') { this.approvalIndex = 0; this.renderDialogActions() }
  }
  private readonly resizeHandler = (): void => {
    this.mouseActivation.clear()
    this.updateActionBar()
    this.updateApprovalLayout()
    if (this.workspaceStatus) this.updateStatus()
    this.renderDialogActions()
    if (this.searchPicker) this.renderSearchPicker(false)
    if (this.completions.length) this.renderCompletions()
    this.updateComposerLayout()
  }
  private readonly pasteHandler = (event: PasteEvent): void => {
    try { this.handlePaste(event) } catch (error) { this.errorHandler({ error }) }
  }
  private readonly signalHandler = (): void => this.cancelOrClose()
  private readonly exitHandler = (): void => this.close()
  private readonly errorHandler = (event: { error?: unknown }): void => {
    // Hidden-input failures can contain only part of the entered key. Suppress their
    // diagnostics entirely rather than trying to match one currently complete value.
    const message = this.pending?.kind === 'secret' ? 'failure while reading hidden input'
      : event.error instanceof Error ? event.error.message : 'native render or input handler error'
    this.failure = new Error(`OpenTUI renderer failed: ${this.safe(message, 1024)}`)
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
        default: { fg: TUI_THEME.foreground }, 'markup.heading': { fg: TUI_THEME.lavender, bold: true },
        'markup.strong': { bold: true }, 'markup.italic': { italic: true },
        'markup.raw': { fg: TUI_THEME.pink }, 'markup.link': { fg: TUI_THEME.lavender, underline: true },
        'markup.list': { fg: TUI_THEME.lavender }, 'markup.quote': { fg: '#a1a1aa', italic: true },
        conceal: { fg: '#71717a' }
      })
      this.shell = new BoxRenderable(renderer, { id: 'vivi-root', width: '100%', height: '100%',
        flexDirection: 'column', backgroundColor: '#18181b', onMouse: (event) => {
          if (event.type !== 'over') this.mouseActivation.clear()
          // Transcript scrolling must not steal the next keystroke from an input.
          if (event.type === 'down' && this.pending) event.preventDefault()
        } })
      renderer.root.add(this.shell)
      this.header = new TextRenderable(renderer, { id: 'vivi-header', height: 2, flexShrink: 0,
        content: this.sessionTitle, fg: TUI_THEME.pink, wrapMode: 'word' })
      this.actionBar = new BoxRenderable(renderer, { id: 'vivi-actions', height: 1, flexShrink: 0,
        flexDirection: 'row', visible: false })
      for (const [label, command] of [['Menu', '/menu'], ['Models', '/models'], ['Effort', '/effort'],
        ['Memory', '/memories'], ['Settings', '/settings']] as const) {
        this.actionBar.add(this.mouseButton(`vivi-action-${command.slice(1)}`, label, () => {
          const pending = this.pending
          if (pending?.kind === 'chat' && !this.composer.plainText) pending.finish(command)
          else this.updateStatus('Finish or clear your draft before opening an action')
        }))
      }
      this.transcript = new ScrollBoxRenderable(renderer, { id: 'vivi-transcript', flexGrow: 1,
        minHeight: 1, width: '100%', scrollX: false, scrollY: true, stickyScroll: true,
        stickyStart: 'bottom', contentOptions: { flexDirection: 'column', paddingX: 1 },
        viewportCulling: true })
      this.statusLine = new TextRenderable(renderer, { id: 'vivi-status', width: '100%', flexShrink: 0,
        fg: '#a1a1aa', wrapMode: 'word', content: this.status })
      this.composerBox = new BoxRenderable(renderer, { id: 'vivi-composer-box', height: 4,
        flexShrink: 0, border: true, borderColor: TUI_THEME.pink, titleColor: TUI_THEME.pink,
        title: 'Message', paddingX: 1 })
      this.composer = new TextareaRenderable(renderer, { id: 'vivi-composer', width: '100%', height: 2,
        wrapMode: 'word', placeholder: 'Enter a message or /menu', backgroundColor: '#18181b',
        textColor: '#e4e4e7', focusedBackgroundColor: '#27272a', cursorColor: TUI_THEME.lavender,
        keyBindings: ['return', 'kpenter', 'linefeed'].flatMap((name) => [
          { name, action: 'submit' as const }, { name, shift: true, action: 'newline' as const },
          { name, meta: true, action: 'newline' as const }
        ]), onSubmit: () => this.submit(), onContentChange: () => this.inputChanged() })
      this.composer.onMouse = (event) => {
        if (event.type === 'down' && event.button === 0 && this.ready() && !this.cancelCallbacks.size &&
          ['chat', 'text', 'search'].includes(this.pending!.kind)) this.composer.focus()
      }
      this.composerBox.add(this.composer)
      this.secretMask = new TextRenderable(renderer, { id: 'vivi-secret-mask', width: '100%', height: 2,
        visible: false, content: '', fg: TUI_THEME.lavender, wrapMode: 'none' })
      this.composerBox.add(this.secretMask)
      this.completionBox = new BoxRenderable(renderer, { id: 'vivi-completions', visible: false,
        flexDirection: 'column', height: 6, flexShrink: 0, border: true, borderColor: TUI_THEME.lavender,
        titleColor: TUI_THEME.lavender, title: 'Commands · ↑/↓ choose · Tab complete', paddingX: 1 })
      this.completionList = new TextRenderable(renderer, { id: 'vivi-completion-list', width: '100%',
        height: '100%', fg: TUI_THEME.lavender, wrapMode: 'none' })
      this.completionList.selectable = false
      this.completionList.onMouse = (event) => this.handleCompletionMouse(event)
      this.completionBox.add(this.completionList)
      this.hintLine = new TextRenderable(renderer, { id: 'vivi-hints', height: 1, flexShrink: 0,
        fg: '#71717a', content: HINTS, wrapMode: 'none' })
      this.pickerBox = new BoxRenderable(renderer, { id: 'vivi-picker-box', visible: false,
        height: 8, flexShrink: 0, flexDirection: 'column', border: true, borderColor: TUI_THEME.lavender,
        titleColor: TUI_THEME.lavender, paddingX: 1 })
      for (const child of [this.header, this.transcript, this.statusLine, this.pickerBox,
        this.completionBox, this.composerBox, this.actionBar, this.hintLine]) this.shell.add(child)
      this.disableComposer()
      renderer.keyInput.on('keypress', this.keyHandler)
      renderer.keyInput.on('paste', this.pasteHandler)
      renderer.on(CliRenderEvents.RESIZE, this.resizeHandler)
      renderer.on(CliRenderEvents.FRAME, this.frameHandler)
      renderer.on(CliRenderEvents.BLUR, this.blurHandler)
      renderer.on(CliRenderEvents.FOCUS, this.focusHandler)
      renderer.on(CliRenderEvents.RENDER_ERROR, this.errorHandler)
      renderer.on(CliRenderEvents.HANDLER_ERROR, this.errorHandler)
      process.on('SIGINT', this.signalHandler)
      process.on('SIGTERM', this.exitHandler)
      process.on('SIGHUP', this.exitHandler)
      process.on('exit', this.exitHandler)
    } catch (error) {
      // Construction can fail before a widget is attached to the renderer's root.
      // Destroy detached widgets too; renderer.destroy only owns attached children.
      for (const widget of [this.composer, this.secretMask, this.completionList, this.header,
        this.transcript, this.statusLine, this.composerBox, this.completionBox,
        this.pickerBox, this.hintLine, this.actionBar, this.shell]) {
        if (widget && !widget.parent && !widget.isDestroyed) {
          try { widget.destroyRecursively() } catch { /* Still release the renderer and hooks below. */ }
        }
      }
      this.close()
      throw error
    }
  }

  static async create(options: OpenTuiOptions = {}): Promise<OpenTuiIO> {
    let renderer: CliRenderer | undefined
    const windowsInput = process.platform === 'win32' && process.stdin.isTTY
      ? createWindowsInputBridge(process.stdin, text => { process.stdout.write(text) }, () => {
        renderer?.emit(CliRenderEvents.HANDLER_ERROR, { error: new Error('Windows console input failed') })
      }) : undefined
    // The official factory rolls back a failed async terminal setup.
    try {
      renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [],
        ...(windowsInput ? { stdin: windowsInput.stdin } : {}),
        screenMode: 'alternate-screen', consoleMode: 'disabled', openConsoleOnError: false,
        externalOutputMode: 'passthrough', useKittyKeyboard: { disambiguate: true, alternateKeys: true },
        useMouse: true, backgroundColor: '#18181b' })
      if (windowsInput?.failure) throw windowsInput.failure
      const io = new OpenTuiIO(renderer, options)
      io.windowsInput = windowsInput
      windowsInput?.start()
      return io
    } catch (error) {
      try { windowsInput?.close() } finally { if (renderer && !renderer.isDestroyed) renderer.destroy() }
      throw error
    }
  }

  get failed(): boolean { return this.failure !== undefined }
  get isClosed(): boolean { return this.closed }

  /** Explicit offline probe. No editable text, provider or session is opened. */
  async diagnoseInput(): Promise<InputDiagnosticReport> {
    if (this.closed || this.pending || this.diagnosticKey) throw new Error('Input diagnostic requires a fresh surface')
    const bridge = this.windowsInput
    const probes: InputProbe[] = []
    this.write('Offline input probe: press Enter, Shift+Enter, then Ctrl+J, once each. Press Escape to finish.\nOnly these key names and modifiers are collected. Ordinary typing and paste are ignored.\n')
    return new Promise(resolve => {
      this.finishDiagnostic = (): void => {
        this.finishDiagnostic = undefined
        this.diagnosticKey = undefined
        resolve({ platform: process.platform, nodeCompatibilityVersion: process.versions.node,
          ...(process.versions.bun ? { bun: process.versions.bun } : {}),
          stdinTTY: process.stdin.isTTY === true, stdoutTTY: process.stdout.isTTY === true,
          ...(bridge ? { windows: bridge.diagnostic } : {}), probes, failed: this.failed })
      }
      this.diagnosticKey = (key): void => {
        if (key.name === 'escape' || key.name === 'c' && key.ctrl) { this.close(); return }
        const probe = inputProbe(key)
        if (probe && probes.length < 32) {
          probes.push(probe)
          this.updateStatus(`Input probe: ${probes.length} known key events collected · Escape finishes`)
        }
      }
    })
  }

  /** Register credentials before any provider output can reach the surface. */
  addSecrets(secrets: readonly string[]): void {
    this.secrets = [...new Set([...this.secrets, ...secrets])].filter(Boolean).sort((a, b) => b.length - a.length)
    if (this.closed) return
    const redactEntry = (entry: DisplayEntry): DisplayEntry => ({ ...entry,
      label: this.safe(entry.label, 4096), content: this.safe(entry.content) })
    this.entries = this.entries.map(redactEntry)
    this.resultNotices = this.resultNotices.map(redactEntry)
    this.sessionTitle = this.safe(this.sessionTitle, 4096)
    this.header.content = this.sessionTitle
    this.composerBox.title = this.safe(this.composerBox.title ?? '', 4096)
    this.pickerBox.title = this.safe(this.pickerBox.title ?? '', 4096)
    if (this.picker) this.picker.options = this.picker.options.map((option) => ({ ...option,
      name: this.safe(option.name, 1024), description: this.safe(option.description, 2048) }))
    this.inputChanged()
    this.rebuild()
    this.updateStatus()
  }

  private safe(text: string, limit = MAX_DISPLAY): string {
    const safe = redactSecrets(stripControls(text), this.secrets)
    return safe.length > limit ? `${safe.slice(0, limit)}\n[display truncated]` : safe
  }
  private ready(pending = this.pending): boolean {
    return !!pending?.armed && !this.closed &&
      (pending.kind !== 'approval' || this.lastRenderedFrame > pending.openedFrame)
  }
  private updateApprovalLayout(): void {
    const compactApproval = this.pending?.kind === 'approval' && this.renderer.terminalHeight < 12
    const compactWorkspace = this.workspaceStatus && this.renderer.terminalHeight < 14
    this.header.height = compactApproval || compactWorkspace ? 1 : 2
    this.statusLine.height = compactApproval ? 1 : compactWorkspace ? 2 : 'auto'
  }
  private updateActionBar(): void {
    if (this.actionBar) this.actionBar.visible = this.pending?.kind === 'chat' &&
      !this.cancelCallbacks.size && !this.completions.length && this.renderer.terminalWidth >= 40 && this.renderer.terminalHeight >= 14
    // The actions occupy the footer row formerly used by chat shortcut hints.
    // Modal input still has its own explicit confirmation/navigation guidance.
    if (this.hintLine) this.hintLine.visible = !this.actionBar?.visible
    this.updateComposerLayout()
  }
  private updateComposerLayout(): void {
    if (!this.composer || !this.composerBox || this.closed) return
    const kind = this.pending?.kind
    const multiline = kind === 'chat' || kind === 'text'
    // Measure wrapped terminal cells using the same native editor as the draft.
    // Its current viewport only counts visible lines, so measuring the complete
    // buffer is essential for both explicit newlines and long wrapped lines.
    const width = Math.max(1, this.renderer.terminalWidth - 4) // border + padding
    const measured = multiline ? this.composer.editorView.measureForDimensions(width, 65536)?.lineCount : 2
    const otherRows = this.shell.getChildren().reduce((rows, child) => child.visible &&
      child !== this.transcript && child !== this.composerBox ? rows + Number(child.height) : rows, 0)
    // Keep a transcript viewport and leave bounded drafts scrollable. Tiny
    // terminals can reduce the two-row idle composer to one editable row.
    const maximum = Math.max(1, Math.min(10, this.renderer.terminalHeight - otherRows - 4))
    const height = multiline ? Math.min(maximum, Math.max(2, measured ?? this.composer.lineCount)) : Math.min(2, maximum)
    if (this.composer.height !== height) this.composer.height = height
    if (this.composerBox.height !== height + 2) this.composerBox.height = height + 2
  }
  private mouseButton(id: string, label: string, activate: () => void): TextRenderable {
    const button = new TextRenderable(this.renderer, { id, content: ` ${label} `, width: label.length + 2,
      height: 1, flexShrink: 0, fg: TUI_THEME.lavender, bg: TUI_THEME.selectedBackground, wrapMode: 'none' })
    button.selectable = false
    button.onMouse = (event) => {
      const pending = this.pending
      this.mouseActivation.handle(event, button, id, pending, this.ready(pending) &&
        (!this.cancelCallbacks.size || pending?.kind === 'approval') &&
        (id !== 'vivi-approve' || performance.now() >= this.approvalMouseNotBefore), activate)
    }
    return button
  }
  private renderDialogActions(): void {
    this.mouseActivation.clear()
    if (this.dialogActions) { this.dialogActions.destroyRecursively(); this.dialogActions = undefined }
    const pending = this.pending
    if (!pending || pending.kind === 'chat') return
    // Preserve room for the query in very small terminals; keyboard paths remain.
    if (pending.kind !== 'approval' && this.renderer.terminalHeight < (pending.kind === 'search' ? 20 : 16)) return
    this.dialogActions = new BoxRenderable(this.renderer, { id: 'vivi-dialog-actions', height: 1,
      flexShrink: 0, flexDirection: 'row', gap: 1 })
    const add = (id: string, label: string, activate: () => void): void => {
      this.dialogActions!.add(this.mouseButton(id, label, activate))
    }
    if (pending.kind === 'approval') {
      add('vivi-deny', this.approvalIndex === 0 ? '› Deny' : '  Deny', () => pending.finish('deny'))
      add('vivi-approve', this.approvalIndex === 1 ? '› Approve' : '  Approve', () => {
        // Mouse protocols have no cross-dialog click identity. Treat a rapid second
        // click as part of the first gesture, never approval of the next proposal.
        this.approvalMouseNotBefore = performance.now() + APPROVAL_REPEAT_WINDOW_MS
        pending.finish('allow')
      })
    } else {
      add('vivi-confirm', pending.kind === 'choice' || pending.kind === 'search' ? 'Choose' : 'Confirm', () => {
        if (pending.kind === 'choice') pending.finish(this.picker?.getSelectedIndex())
        else this.submit()
      })
      if (pending.kind === 'search' && this.searchPicker?.refresh) {
        add('vivi-refresh', 'Refresh', () => { this.inputChanged(); pending.finish(-1) })
      }
      add('vivi-back', pending.kind === 'choice' || pending.kind === 'search' ? 'Back' : 'Cancel', () => pending.finish(undefined))
    }
    if (pending.kind === 'choice' || pending.kind === 'search' || pending.kind === 'approval') {
      this.pickerBox.add(this.dialogActions)
    } else this.shell.insertBefore(this.dialogActions, this.hintLine)
  }
  private handlePickerMouse(event: MouseEvent): void {
    const picker = this.picker
    const pending = this.pending
    if (!picker || !pending) return
    if (pending.kind === 'search' && this.searchPicker?.query !== this.composer.plainText) this.inputChanged()
    if (event.type === 'scroll') {
      this.mouseActivation.clear()
      event.preventDefault(); event.stopPropagation()
      if (this.ready() && event.scroll && ['up', 'down'].includes(event.scroll.direction)) {
        const delta = Math.max(1, Math.min(20, event.scroll.delta))
        if (event.scroll.direction === 'up') picker.moveUp(delta)
        else picker.moveDown(delta)
      }
      return
    }
    const index = pickerIndexAt(picker, event.x, event.y)
    const option = index === undefined ? undefined : picker.options[index]
    const key = `${index}:${option?.value}:${this.searchPicker?.query ?? ''}`
    this.mouseActivation.handle(event, picker, key, pending, this.ready() && this.lastRenderedFrame > this.pickerChangedFrame && index !== undefined &&
      (pending.kind === 'choice' || pending.kind === 'search') && option?.value !== -1, () => {
        if (pending.kind === 'search') pending.finish(option!.value)
        else pending.finish(index)
      })
  }
  private acceptCompletion(index = this.completionIndex): void {
    const item = this.completions[index]
    if (!item) return
    this.acceptedCompletion = item.command
    this.composer.setText(this.acceptedCompletion)
    this.composer.gotoBufferEnd()
    this.hideCompletions()
    this.composer.focus()
  }
  private handleCompletionMouse(event: MouseEvent): void {
    const rows = this.completionBox.height - 2
    const first = Math.min(Math.max(0, this.completionIndex - rows + 1), this.completions.length - rows)
    const index = first + event.y - this.completionList.y
    const item = this.completions[index]
    this.mouseActivation.handle(event, this.completionList, `${index}:${item?.command}:${this.composer.plainText}`,
      this.pending, this.ready() && this.lastRenderedFrame > this.completionChangedFrame && this.pending?.kind === 'chat' && !!item, () => this.acceptCompletion(index))
  }
  private updateStatus(status = this.status): void {
    if (this.closed) return
    this.status = this.safe(status, 1024)
    const columns = Math.max(1, this.renderer.terminalWidth)
    const folder = this.workspaceDirectory === undefined ? 'disabled'
      : `${fitStatusColumns(this.safe(JSON.stringify(this.workspaceDirectory)), Math.max(0, columns - 23))} · read only`
    const workspace = this.workspaceStatus ? `\n${fitStatusColumns(`Workspace: ${folder}`, columns)}` : ''
    const summary = this.workspaceStatus ? fitStatusColumns(this.status.replace(/[\t\n]+/g, ' '), columns) : this.status
    this.statusLine.content = `${summary}${workspace}\n${this.usageScope} tokens: ${formatUsage(this.usage)}`
  }
  private disableComposer(): void {
    this.composer?.blur()
    if (this.composer) {
      this.composer.traits = { suspend: true }
      this.composer.showCursor = false
    }
  }
  private clearInput(): void {
    this.clearSecret()
    this.acceptedCompletion = undefined
    this.hideCompletions()
    if (!this.composer || this.composer.isDestroyed) return
    this.changingInput = true
    try { this.composer.setText('') } finally { this.changingInput = false }
    this.updateComposerLayout()
  }
  private inputChanged(): void {
    if (this.closed || this.changingInput) return
    const raw = this.composer.plainText
    const safe = this.pending?.kind === 'search'
      ? this.safe(raw, MAX_INPUT).replace(/[\t\n]+/g, ' ').slice(0, MAX_QUERY)
      : this.safe(raw, MAX_INPUT).slice(0, MAX_INPUT)
    if (raw !== safe) {
      this.changingInput = true
      try { this.composer.setText(safe); this.composer.gotoBufferEnd() }
      finally { this.changingInput = false }
      const limit = this.pending?.kind === 'search' ? MAX_QUERY : MAX_INPUT
      this.updateStatus(raw.length > limit ? `Input limit: ${limit} characters` : 'Control text or known credential removed from input')
    }
    if (this.searchPicker) this.renderSearchPicker(this.composer.plainText !== this.searchPicker.query)
    else this.updateCompletions()
    this.updateComposerLayout()
  }
  private renderSearchPicker(queryChanged: boolean): void {
    const search = this.searchPicker
    if (!search || !this.picker || this.closed) return
    const previous = search.matches[this.picker.getSelectedIndex()]
    const query = this.composer.plainText
    if (queryChanged || query !== search.query) {
      this.mouseActivation.clear()
      this.pickerChangedFrame = this.renderer.frameId
      search.query = query
      search.matches = matchingChoiceIndices(search.choices, query)
      this.picker.options = search.matches.length ? search.matches.map(index => {
        const choice = search.choices[index]!
        return { name: this.safe(choice.name, 1024), description: this.safe(choice.description ?? '', 2048), value: index }
      }) : [{ name: query ? 'No matching models' : 'No models available',
        description: 'Backspace or Ctrl+U clears search' + (search.refresh ? ' · Ctrl+R refreshes catalog' : ''), value: -1 }]
      // A changed query starts at the best-ranked match, never an old row number.
      this.picker.setSelectedIndex(0)
    } else if (previous !== undefined) this.picker.setSelectedIndex(search.matches.indexOf(previous))
    this.composerBox.title = `Search models · ${search.matches.length} / ${search.choices.length} results`
    const height = Math.max(3, Math.min(10, this.renderer.terminalHeight - 9, Math.max(1, search.matches.length) * 2 + 2 + (this.dialogActions ? 1 : 0)))
    this.pickerBox.height = height
    this.picker.showDescription = height - 2 - (this.dialogActions ? 1 : 0) >= 2
  }
  private handleSearchKey(key: KeyEvent): boolean {
    const search = this.searchPicker
    if (!search || !this.picker) return false
    // Native content-change notifications may be deferred until the next frame.
    // Navigation/refresh must use the query typed in this input batch immediately.
    if (this.composer.plainText !== search.query) this.inputChanged()
    if (['return', 'kpenter', 'linefeed'].includes(key.name)) { this.consume(key); this.submit(); return true }
    if (key.ctrl && key.name === 'u') { this.consume(key); this.composer.setText(''); return true }
    if (key.ctrl && key.name === 'r' && search.refresh) { this.consume(key); this.pending?.finish(-1); return true }
    if (key.name === 'tab') { this.consume(key); return true }
    if (!key.ctrl && !key.meta && !key.super && !key.hyper && ['up', 'down', 'pageup', 'pagedown', 'home', 'end'].includes(key.name)) {
      this.consume(key)
      if (!search.matches.length) return true
      const step = Math.max(1, Math.floor((Number(this.pickerBox.height) - 2) / (this.picker.showDescription ? 2 : 1)))
      const current = this.picker.getSelectedIndex()
      const next = key.name === 'home' ? 0 : key.name === 'end' ? search.matches.length - 1
        : current + (key.name === 'up' ? -1 : key.name === 'down' ? 1 : key.name === 'pageup' ? -step : step)
      this.picker.setSelectedIndex(Math.max(0, Math.min(search.matches.length - 1, next)))
      return true
    }
    return false
  }
  private hideCompletions(): void {
    this.completions = []
    this.completionIndex = 0
    this.completionInput = ''
    if (this.completionBox) this.completionBox.visible = false
    if (this.completionList && !this.completionList.isDestroyed) this.completionList.content = ''
    this.updateActionBar()
  }
  private updateCompletions(): void {
    const input = this.composer.plainText
    if (input !== this.acceptedCompletion) this.acceptedCompletion = undefined
    if (this.pending?.kind !== 'chat' || !this.pending.armed || this.cancelCallbacks.size ||
      input === this.acceptedCompletion) { this.hideCompletions(); return }
    this.completions = getSlashCommandCompletions(input)
    if (!this.completions.length) { this.hideCompletions(); return }
    if (input !== this.completionInput) this.completionIndex = 0
    this.completionInput = input
    this.renderCompletions()
  }
  private renderCompletions(): void {
    const rows = Math.max(1, Math.min(4, this.completions.length, this.renderer.terminalHeight - 11))
    const first = Math.min(Math.max(0, this.completionIndex - rows + 1), this.completions.length - rows)
    this.completionChangedFrame = this.renderer.frameId
    this.completionList.content = this.completions.slice(first, first + rows).map((item, offset) =>
      `${first + offset === this.completionIndex ? '›' : ' '} ${item.command}  ${item.description}`).join('\n')
    this.completionBox.height = rows + 2
    this.completionBox.visible = true
    this.updateActionBar()
  }
  private clearSecret(): void {
    this.secretInput.fill('')
    this.secretInput = []
    this.secretCursor = 0
    if (this.secretMask && !this.secretMask.isDestroyed) this.secretMask.content = ''
  }
  private renderSecret(): void {
    // Limit the mask to one terminal row without disclosing any entered characters.
    const capacity = Math.max(1, this.renderer.terminalWidth - 10)
    const start = Math.max(0, this.secretCursor - capacity)
    const end = Math.min(this.secretInput.length, start + capacity)
    this.secretMask.content = `${start ? '…' : ''}${'•'.repeat(this.secretCursor - start)}│${'•'.repeat(end - this.secretCursor)}${end < this.secretInput.length ? '…' : ''}`
  }
  private insertSecret(text: string): void {
    if (/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(text) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)) {
      this.updateStatus('API key input rejected: controls, line breaks or invalid Unicode are not allowed')
      return
    }
    if (text.length > MAX_SECRET - this.secretInput.reduce((length, character) => length + character.length, 0)) {
      this.updateStatus('API key input limit: 4096 characters')
      return
    }
    const characters = [...text]
    this.secretInput.splice(this.secretCursor, 0, ...characters)
    this.secretCursor += characters.length
    this.renderSecret()
  }
  private handleSecretKey(key: KeyEvent): void {
    this.consume(key)
    if (['return', 'kpenter', 'linefeed'].includes(key.name)) { this.submit(); return }
    if (key.ctrl && key.name === 'u') { this.clearSecret(); this.renderSecret(); return }
    if (key.name === 'backspace') {
      if (this.secretCursor) this.secretInput.splice(--this.secretCursor, 1)
    } else if (key.name === 'delete') this.secretInput.splice(this.secretCursor, 1)
    else if (key.name === 'left') this.secretCursor = Math.max(0, this.secretCursor - 1)
    else if (key.name === 'right') this.secretCursor = Math.min(this.secretInput.length, this.secretCursor + 1)
    else if (key.name === 'home' || (key.ctrl && key.name === 'a')) this.secretCursor = 0
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) this.secretCursor = this.secretInput.length
    else if (!key.ctrl && !key.meta && !key.super && !key.hyper) {
      this.insertSecret(key.name === 'space' ? ' ' : key.sequence)
      return
    }
    this.renderSecret()
  }
  private consume(key: KeyEvent | PasteEvent): void { key.preventDefault(); key.stopPropagation() }
  private handlePaste(event: PasteEvent): void {
    this.mouseActivation.clear()
    this.consume(event)
    if (this.diagnosticKey) return
    if (!this.pending?.armed || this.closed || this.pending.kind === 'choice') return
    if (this.cancelCallbacks.size && this.pending.kind !== 'approval') return
    if (this.pending.kind === 'approval') {
      this.clearInput()
      this.approvalIndex = 0
      this.renderDialogActions()
      this.updateStatus('Select Deny or Approve; pasted approvals are ignored')
      return
    }
    if (this.pending.kind === 'secret') { this.insertSecret(decodePasteBytes(event.bytes)); return }
    const text = this.safe(decodePasteBytes(event.bytes), MAX_INPUT)
    const remaining = MAX_INPUT - this.composer.plainText.length
    if (text.length > remaining) { this.updateStatus('Paste ignored: input limit is 65536 characters'); return }
    this.composer.insertText(text)
  }
  private handleKey(key: KeyEvent): void {
    this.mouseActivation.clear()
    if (this.closed) { this.consume(key); return }
    if (this.diagnosticKey) { this.consume(key); this.diagnosticKey(key); return }
    if (key.eventType === 'release') { this.consume(key); return }
    if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
      this.consume(key)
      if (key.name === 'escape' && (this.pending?.kind === 'choice' || this.pending?.kind === 'search' || this.pending?.kind === 'text' || this.pending?.kind === 'secret')) {
        this.pending.finish(undefined)
      } else if (key.name === 'escape' && this.pending?.kind === 'chat' && !this.cancelCallbacks.size) {
        this.clearInput()
      } else this.cancelOrClose(key.name === 'escape')
      return
    }
    if (this.pending?.kind === 'approval') {
      this.consume(key)
      if (key.name === 'pageup' || key.name === 'pagedown') {
        this.transcript.scrollTo(this.transcript.scrollTop + (key.name === 'pageup' ? -1 : 1) *
          Math.max(1, this.transcript.viewport.height - 1)); return
      }
      if (!this.ready() || key.eventType === 'repeat' || key.repeated || key.ctrl || key.meta || key.super || key.hyper) return
      if (['left', 'up', 'home'].includes(key.name)) this.approvalIndex = 0
      else if (['right', 'down', 'end'].includes(key.name)) this.approvalIndex = 1
      else if (key.name === 'tab') this.approvalIndex = 1 - this.approvalIndex
      else if (['return', 'kpenter', 'linefeed', 'space'].includes(key.name) && !key.shift) {
        this.pending.finish(this.approvalIndex === 1 ? 'allow' : 'deny'); return
      }
      else return
      this.renderDialogActions()
      return
    }
    if (this.pending?.armed && this.pending.kind === 'search' && this.handleSearchKey(key)) return
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
    if (pending.kind === 'secret') { this.handleSecretKey(key); return }
    // Legacy terminals encode Ctrl+J as LF and may encode Shift+Enter exactly
    // like Enter (CR). Only chat/text editors use LF as a newline fallback;
    // search, secret, choice and approval prompts keep their confirmation keys.
    if ((pending.kind === 'chat' || pending.kind === 'text') && !key.shift && !key.meta && !key.super && !key.hyper &&
      ((!key.ctrl && key.name === 'linefeed') || (key.ctrl && key.name === 'j'))) {
      this.consume(key)
      this.composer.insertText('\n')
      this.inputChanged()
      return
    }
    if (pending.kind === 'chat' && this.completions.length && !key.ctrl && !key.meta && !key.super && !key.hyper) {
      if (key.name === 'up' || key.name === 'down') {
        this.consume(key)
        this.completionIndex = (this.completionIndex + (key.name === 'up' ? -1 : 1) + this.completions.length) % this.completions.length
        this.renderCompletions()
        return
      }
      if (key.name === 'tab') {
        this.consume(key)
        this.acceptCompletion()
        return
      }
    }
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
    if (pending.kind === 'search') {
      this.inputChanged()
      const index = this.searchPicker?.matches[this.picker?.getSelectedIndex() ?? -1]
      if (index !== undefined) pending.finish(index)
      return
    }
    if (pending.kind === 'secret') {
      const value = this.secretInput.join('')
      // Register before resolving, so immediate host/provider errors are already redacted.
      if (value) this.addSecrets([value])
      pending.finish(value)
      return
    }
    const text = this.composer.plainText
    if (pending.kind === 'approval') return
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
    this.mouseActivation.clear()
    this.clearInput()
    this.disableComposer()
    if (kind === 'secret') {
      // OpenTUI 0.5.14 captures raw stdin before global key/paste handlers. Its public
      // API has no per-input logging switch, so fail closed rather than expose a key.
      const capture = this.renderer as unknown as { readonly stdinLogPath?: string; readonly _debugModeEnabled?: boolean }
      const debugRequested = ['true', '1', 'on', 'yes'].includes((process.env.OTUI_DEBUG ?? '').toLowerCase())
      if (process.env.OTUI_STDIN_LOG || debugRequested || capture.stdinLogPath || capture._debugModeEnabled) {
        this.updateStatus('API key entry blocked: raw input capture is enabled')
        throw new Error('Disable OTUI_STDIN_LOG and OTUI_DEBUG, then restart vivi before entering an API key')
      }
    }
    this.composerBox.visible = kind !== 'choice' && kind !== 'approval'
    this.composer.visible = kind !== 'secret'
    this.secretMask.visible = kind === 'secret'
    this.composerBox.title = this.safe(title, 4096)
    this.hintLine.content = kind === 'chat' ? HINTS : kind === 'approval'
      ? '←/→ or Tab select · Enter confirm · Click Deny / Approve · Escape denies'
      : kind === 'search' ? 'Type to search · ↑/↓ select · PgUp/PgDn · Home/End'
      : kind === 'choice' ? '↑/↓ select · Enter or click choose · Escape back'
      : kind === 'secret' ? 'Input hidden · Enter confirm · Escape back · Ctrl+U clear'
      : 'Enter confirm · Ctrl+J newline · Shift/Alt+Enter if supported · Escape back'
    if (kind !== 'choice' && kind !== 'secret') this.composer.setText(this.safe(initial, MAX_INPUT).slice(0, MAX_INPUT))
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = (): void => pending.finish(undefined, true)
      const pending: PendingInput = { kind, armed: kind !== 'approval', openedFrame: this.renderer.frameId, finish: (value, aborted = false): void => {
        if (this.pending !== pending) return
        this.pending = undefined
        this.mouseActivation.clear()
        if (this.dialogActions) { this.dialogActions.destroyRecursively(); this.dialogActions = undefined }
        this.updateActionBar()
        this.updateApprovalLayout()
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.disableComposer()
        this.searchPicker = undefined
        this.clearInput()
        if (this.picker) { this.picker.destroyRecursively(); this.picker = undefined }
        this.pickerBox.visible = false
        this.pickerBox.bottomTitle = undefined
        this.composerBox.visible = true
        this.composer.visible = true
        this.secretMask.visible = false
        this.composerBox.title = 'Message'
        this.composerBox.bottomTitle = undefined
        this.hintLine.content = HINTS
        if (this.failure) reject(this.failure)
        else if (aborted && kind === 'chat') reject(new Error('Input cancelled'))
        else resolve(value)
      } }
      this.pending = pending
      this.approvalIndex = 0
      this.updateApprovalLayout()
      this.updateActionBar()
      this.renderDialogActions()
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      if (kind === 'approval') {
        // Drain the input batch that preceded this newly displayed request. No buffered
        // Return, bracketed paste, draft text or editor undo can authorize a later action.
        timer = setTimeout(() => {
          if (this.pending !== pending || this.closed) return
          this.clearInput()
          pending.armed = true
        }, 0)
      } else if (kind === 'secret') this.renderSecret()
      else if (kind !== 'choice') {
        this.composer.traits = {}
        this.composer.showCursor = true
        this.composer.focus()
        this.composer.gotoBufferEnd()
        this.updateCompletions()
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
  async askSecret(title: string): Promise<string | undefined> {
    const value = await this.openInput('secret', title)
    return typeof value === 'string' ? value : undefined
  }
  async choose<T>(title: string, choices: readonly Choice<T>[], initialIndex = 0): Promise<T | undefined> {
    if (this.failure) throw this.failure
    if (this.closed || choices.length === 0) return undefined
    if (choices.length > MAX_ENTRIES) throw new Error('A picker supports at most 256 choices')
    const selection = this.openInput('choice', title)
    this.pickerChangedFrame = this.renderer.frameId
    this.pickerBox.title = this.safe(title, 4096)
    this.pickerBox.height = Math.max(4, Math.min(10, this.renderer.terminalHeight - 5, choices.length * 2 + 2 + (this.dialogActions ? 1 : 0)))
    this.pickerBox.visible = true
    try {
      this.picker = new SelectRenderable(this.renderer, { id: 'vivi-picker', width: '100%', height: '100%',
        minHeight: 1, flexShrink: 1, onMouse: (event) => this.handlePickerMouse(event),
        options: choices.map((choice, index) => ({ name: this.safe(choice.name, 1024),
          description: this.safe(choice.description ?? '', 2048), value: index })),
        selectedIndex: Math.max(0, Math.min(choices.length - 1, Number.isFinite(initialIndex) ? Math.trunc(initialIndex) : 0)),
        showDescription: true, showScrollIndicator: true, wrapSelection: true,
        backgroundColor: TUI_THEME.background, textColor: TUI_THEME.foreground,
        selectedBackgroundColor: TUI_THEME.selectedBackground, selectedTextColor: TUI_THEME.pink,
        descriptionColor: '#a1a1aa', selectedDescriptionColor: TUI_THEME.lavender })
      this.picker.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => this.pending?.finish(index))
      this.picker.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
        this.mouseActivation.clear(); this.pickerChangedFrame = this.renderer.frameId
      })
      this.pickerBox.add(this.picker, 0)
      this.renderDialogActions()
      this.picker.focus()
    } catch (error) {
      this.pending?.finish(undefined)
      throw error
    }
    const index = await selection
    return typeof index === 'number' ? choices[index]?.value : undefined
  }
  async chooseSearchable<T>(title: string, choices: readonly Choice<T>[], options: SearchableOptions = {}): Promise<SearchableSelection<T> | undefined> {
    if (this.failure) throw this.failure
    if (this.closed) return undefined
    // Display is viewport-bounded, but every catalog entry remains reachable/searchable.
    const query = this.safe(options.query ?? '', MAX_INPUT).replace(/[\t\n]+/g, ' ').slice(0, MAX_QUERY)
    const selection = this.openInput('search', 'Search models', query)
    this.pickerBox.title = this.safe(title, 4096)
    this.pickerBox.visible = true
    this.pickerBox.bottomTitle = 'Enter choose · Esc back'
    this.composerBox.bottomTitle = 'Ctrl+U clear' + (options.refresh ? ' · Ctrl+R refresh' : '')
    try {
      this.searchPicker = { choices, matches: [], query, refresh: options.refresh ?? false }
      this.picker = new SelectRenderable(this.renderer, { id: 'vivi-picker', width: '100%', height: '100%',
        minHeight: 1, flexShrink: 1, onMouse: (event) => this.handlePickerMouse(event),
        options: [], showDescription: true, showScrollIndicator: true, wrapSelection: false,
        backgroundColor: TUI_THEME.background, textColor: TUI_THEME.foreground,
        selectedBackgroundColor: TUI_THEME.selectedBackground, selectedTextColor: TUI_THEME.pink,
        descriptionColor: '#a1a1aa', selectedDescriptionColor: TUI_THEME.lavender })
      // This is a result view, not a second input target. Mouse autofocus must not
      // redirect later query typing into SelectRenderable's own key handler.
      this.picker.focusable = false
      this.picker.on(SelectRenderableEvents.SELECTION_CHANGED, () => {
        this.mouseActivation.clear(); this.pickerChangedFrame = this.renderer.frameId
      })
      this.pickerBox.add(this.picker, 0)
      this.renderDialogActions()
      this.renderSearchPicker(true)
      const initial = Number.isFinite(options.initialIndex) ? Math.trunc(options.initialIndex!) : 0
      const selected = this.searchPicker.matches.indexOf(initial)
      // A persisted query uses relevance ranking rather than restoring a hidden selection.
      this.picker.setSelectedIndex(query ? 0 : Math.max(0, selected))
    } catch (error) { this.pending?.finish(undefined); throw error }
    // Keep the editable query focused; list navigation is handled without focus changes.
    const search = this.searchPicker!
    const index = await selection
    return typeof index !== 'number' ? undefined : index === -1 ? { kind: 'refresh', query: search.query }
      : choices[index] ? { kind: 'selected', value: choices[index]!.value, query: search.query } : undefined
  }
  async approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    if (this.closed || signal.aborted) return false
    const scope = request.currentRevision === 'new memory' ? 'new memory' : `current revision ${request.currentRevision}`
    this.appendEntry({ label: `Approval required · ${scope}`,
      content: this.safe(request.description), markdown: false })
    this.updateStatus(`Approval required · ${scope} · denial is the default`)
    const answer = this.openInput('approval', 'Review this change (default: deny)', '', signal)
    this.pickerBox.title = 'Review this change (default: deny)'
    this.pickerBox.height = 3
    this.pickerBox.visible = true
    const reply = await answer
    return reply === 'allow' && !signal.aborted && !this.closed
  }
  onCancel(callback: () => void): () => void {
    if (this.closed) { callback(); return () => undefined }
    this.cancelCallbacks.add(callback)
    this.mouseActivation.clear()
    this.updateActionBar()
    this.resultNotices = []
    this.clearInput()
    this.disableComposer()
    this.updateStatus('Running · Escape / Ctrl+C cancels')
    return () => { this.cancelCallbacks.delete(callback); this.updateActionBar() }
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
          content: token.text, fg: TUI_THEME.pink, width: '100%', wrapMode: 'word', flexShrink: 0 })
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
    box.add(new TextRenderable(this.renderer, { content: entry.label, fg: TUI_THEME.pink, flexShrink: 0, wrapMode: 'word' }))
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
  setDraft(provider: CliProviderName): void {
    if (this.closed) return
    this.sessionId = undefined
    this.sessionTitle = `vivi · fresh conversation · ${provider} · choose a model with /models`
    this.header.content = this.sessionTitle
    this.clearStream()
    this.entries = []
    this.resultNotices = []
    this.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    this.usageScope = 'Session'
    this.rebuild()
    this.updateStatus('Ready')
  }
  /** Launch-owned context survives conversation changes and transcript rebuilds. */
  setWorkspace(directory?: string): void {
    if (this.closed) return
    this.workspaceDirectory = directory
    this.workspaceStatus = true
    this.updateApprovalLayout()
    this.updateStatus()
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
    this.usageScope = 'Session'
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
    } else if (event.type === 'round_completed') {
      this.usage = aggregateUsage([event.usage])
      this.usageScope = 'Round'
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
    this.usageScope = 'Turn'
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
    this.renderer.off(CliRenderEvents.RESIZE, this.resizeHandler)
    this.renderer.off(CliRenderEvents.FRAME, this.frameHandler)
    this.renderer.off(CliRenderEvents.BLUR, this.blurHandler)
    this.renderer.off(CliRenderEvents.FOCUS, this.focusHandler)
    this.renderer.off(CliRenderEvents.RENDER_ERROR, this.errorHandler)
    this.renderer.off(CliRenderEvents.HANDLER_ERROR, this.errorHandler)
    process.off('SIGINT', this.signalHandler)
    process.off('SIGTERM', this.exitHandler)
    process.off('SIGHUP', this.exitHandler)
    process.off('exit', this.exitHandler)
    this.streamed = ''
    this.entries = []
    this.clearSecret()
    this.secrets = []
    try { this.windowsInput?.close() }
    catch { this.failure ??= new Error('Windows console reporting restoration failed') }
    this.windowsInput = undefined
    if (destroyRenderer && !this.renderer.isDestroyed) this.renderer.destroy()
    this.finishDiagnostic?.()
  }
  close(): void { this.dispose(true) }
}
