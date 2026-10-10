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
import type { AgentEvent, AgentResult, HistoryMessage, ToolCall, Usage } from '@ayayaq/vivi'
import type { ToolPresentationEffect, ToolPresentationStatus } from '@ayayaq/vivi/presentation'
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
import { RunStatus } from './run-status.js'
import type { RunClock, RunOutcome } from './run-status.js'
import { sessionDisplayTitle } from './session-display.js'
import type { ApprovalMode, ReviewNotice } from './auto-review.js'
import { reviewNoticeSettled } from './auto-review.js'
import { createCliToolPresentation, cliHistoryToolPresentation, cliToolPresentationView, cliToolSource } from './tool-presentation.js'
import type { CliToolEvidence } from './tool-presentation.js'

export type { Choice } from './picker.js'
export interface OpenTuiOptions { stream?: boolean; secrets?: readonly string[]; runClock?: RunClock }

export const TUI_THEME = { pink: '#f87ea2', lavender: '#b08bfc', background: '#18181b',
  foreground: '#e4e4e7', selectedBackground: '#3d2946', userBackground: '#24212d',
  muted: '#a1a1aa', attention: '#fbbf24' } as const
export const SLASH_COMMANDS = [
  { command: '/provider', description: 'Choose a provider' },
  { command: '/models', description: 'Choose a model' },
  { command: '/effort', description: 'Choose reasoning effort' },
  { command: '/mode', description: 'Choose Manual or Auto review' },
  { command: '/new', description: 'Start a new session' },
  { command: '/resume', description: 'Resume a saved session' },
  { command: '/rename', description: 'Rename the current session' },
  { command: '/settings', description: 'Change future defaults' },
  { command: '/memories', description: 'Manage app-wide saved context' },
  { command: '/commands', description: 'Manage trusted workspace commands' },
  { command: '/skills', description: 'List, inspect and draft standard skills' },
  { command: '/mcp', description: 'Manage trusted server metadata connections' },
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
const statusSegments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
function statusTextColumns(text: string): number {
  return [...text].reduce((total, point) => total + (point.codePointAt(0)! <= 0x7f ? 1 : 2), 0)
}
/** Conservative cell budget keeps wide Unicode paths on one terminal row. */
function fitStatusColumns(text: string, columns: number, keepStart = false): string {
  const characters = [...statusSegments.segment(text)].map(item => item.segment)
  const width = statusTextColumns
  if (characters.reduce((total, character) => total + width(character), 0) <= columns) return text
  if (columns < 2) return columns > 0 ? '…' : ''
  if (keepStart) {
    let prefix = '', used = 0
    for (const character of characters) {
      if (used + width(character) > columns - 2) break
      prefix += character; used += width(character)
    }
    return `${prefix}…`
  }
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
const HINTS = 'Enter send · Ctrl+J newline · /new /resume /mode /memories /skills /mcp /settings /menu /help /exit'
type InputKind = 'chat' | 'text' | 'secret' | 'approval' | 'choice' | 'search'
interface PendingInput {
  kind: InputKind
  armed: boolean
  openedFrame: number
  approvalLabels?: { deny: string; allow: string }
  finish(value: string | number | undefined, aborted?: boolean): void
}
type EntryCategory = 'user' | 'assistant' | 'activity'
interface DisplayEntry {
  category: EntryCategory
  attention?: boolean
  label: string
  content: string
  markdown: boolean
  historyIndex?: number
  reviewKey?: string
  review?: ReviewNotice
  historyStart?: number
  tool?: { encoded: string; key: string }
}
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
  private headerBox!: BoxRenderable
  private headerRows = 2
  private header!: TextRenderable
  private tokenLine!: TextRenderable
  private modelLine!: TextRenderable
  private footer!: BoxRenderable
  private footerRows = 1
  private workspaceLine!: TextRenderable
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
  private toolEvidence: CliToolEvidence | undefined
  private readonly collapsedTools = new Set<string>()
  private liveToolCalls = new Map<string, { call: ToolCall; index: number; key: string; status?: ToolPresentationStatus; effect?: ToolPresentationEffect }>()
  private liveHistoryIndex = 0
  private resultNotices: DisplayEntry[] = []
  private reviewNotices: DisplayEntry[] = []
  private historyLength = 0
  private turnHistoryStart = 0
  private pending: PendingInput | undefined
  private closed = false
  private failure: Error | undefined
  private changingInput = false
  private cancelCallbacks = new Set<() => void>()
  private status = 'Ready'
  private readonly runStatus: RunStatus
  private workspaceDirectory: string | undefined
  private workspaceStatus = false
  private sessionTitle = 'Untitled conversation'
  private sessionModel = 'vivi · choose a model with /models'
  private sessionId: string | undefined
  private approvalMode: ApprovalMode = 'manual'
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
    this.updateChoiceLayout()
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
    this.updateHeader()
    if (this.workspaceStatus) this.updateStatus()
    this.renderDialogActions()
    this.updateChoiceLayout()
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
    this.runStatus = new RunStatus(() => this.updateStatus(), options.runClock)
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
      this.headerBox = new BoxRenderable(renderer, { id: 'vivi-header-box', height: 2, flexShrink: 0,
        width: '100%', flexDirection: 'column' })
      this.header = new TextRenderable(renderer, { id: 'vivi-header', height: 1, flexShrink: 0,
        content: this.sessionTitle, fg: TUI_THEME.pink, wrapMode: 'none' })
      this.tokenLine = new TextRenderable(renderer, { id: 'vivi-tokens', height: 1, flexShrink: 0,
        fg: TUI_THEME.muted, textAlign: 'right', wrapMode: 'none' })
      this.headerBox.add(this.header); this.headerBox.add(this.tokenLine)
      this.modelLine = new TextRenderable(renderer, { id: 'vivi-model', height: 1, flexShrink: 0,
        width: '100%', fg: TUI_THEME.pink, wrapMode: 'none' })
      this.footer = new BoxRenderable(renderer, { id: 'vivi-footer', height: 1, flexShrink: 0,
        width: '100%', flexDirection: 'row' })
      this.workspaceLine = new TextRenderable(renderer, { id: 'vivi-workspace', height: 1, flexShrink: 0,
        fg: TUI_THEME.muted, textAlign: 'right', wrapMode: 'none', visible: false })
      this.actionBar = new BoxRenderable(renderer, { id: 'vivi-actions', height: 1, flexShrink: 0,
        flexDirection: 'row', visible: false })
      for (const [label, command] of [['Menu', '/menu'], ['Models', '/models'], ['Effort', '/effort'],
        ['Mode', '/mode'], ['Memory', '/memories'], ['Skills', '/skills'], ['Settings', '/settings']] as const) {
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
      this.statusLine = new TextRenderable(renderer, { id: 'vivi-status', width: '100%', height: 1, flexShrink: 0,
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
      this.footer.add(this.actionBar); this.footer.add(this.workspaceLine)
      for (const child of [this.headerBox, this.transcript, this.statusLine, this.pickerBox,
        this.completionBox, this.modelLine, this.composerBox, this.footer, this.hintLine]) this.shell.add(child)
      this.updateHeader(); this.updateActionBar()
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
        this.pickerBox, this.hintLine, this.actionBar, this.tokenLine, this.headerBox,
        this.modelLine, this.workspaceLine, this.footer, this.shell]) {
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
  get canAutoReview(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY && !this.closed && !this.failed && !this.renderer.isDestroyed)
  }
  setApprovalMode(mode: ApprovalMode): void { this.approvalMode = mode; this.updateHeader() }

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
    this.reviewNotices = this.reviewNotices.map(redactEntry)
    this.sessionTitle = this.safe(this.sessionTitle, 4096)
    this.sessionModel = this.safe(this.sessionModel, 4096)
    this.updateHeader()
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
    if (this.closed) return
    this.statusLine.height = 1
    this.updateHeader()
    this.updateFooter()
  }
  private updateActionBar(): void {
    if (this.closed) return
    if (this.actionBar) this.actionBar.visible = this.pending?.kind === 'chat' &&
      !this.cancelCallbacks.size && !this.completions.length && this.renderer.terminalWidth >= 48 && this.renderer.terminalHeight >= 14
    // Chat controls and workspace share a row where they fit. Modal shortcuts
    // remain separate so a right-aligned path can never cover an action hitbox.
    this.updateFooter()
    this.updateComposerLayout()
  }
  private updateFooter(): void {
    if (this.closed || !this.footer) return
    const columns = Math.max(1, this.renderer.terminalWidth)
    const buttons = this.actionBar.getChildren() as TextRenderable[]
    const compact = columns < 72
    for (const button of buttons) {
      const label = button.plainText.trim()
      button.content = compact ? label : ` ${label} `
      button.width = label.length + (compact ? 0 : 2)
    }
    const controls = this.actionBar.visible ? buttons.reduce((sum, button) => sum + button.plainText.trim().length + (compact ? 0 : 2), 0) + Math.max(0, buttons.length - 1) : 0
    const stacked = this.workspaceStatus && controls > 0 && columns < controls + 21
    this.footer.flexDirection = stacked ? 'column' : 'row'
    this.footerRows = stacked ? 2 : 1
    this.footer.height = this.footerRows
    this.footer.visible = this.workspaceStatus || this.actionBar.visible
    this.hintLine.visible = !this.actionBar.visible && !(this.workspaceStatus && this.renderer.terminalHeight < 10)
    this.actionBar.width = controls
    this.workspaceLine.visible = this.workspaceStatus
    const width = stacked ? columns : Math.max(1, columns - controls)
    this.workspaceLine.width = width
    const folder = this.workspaceDirectory === undefined ? 'disabled' :
      `${fitStatusColumns(this.safe(JSON.stringify(this.workspaceDirectory)), Math.max(0, width - 23))} · reviewed text edits`
    this.workspaceLine.content = fitStatusColumns(`Workspace: ${folder}`, width)
  }
  private updateChoiceLayout(): void {
    if (this.pending?.kind !== 'choice' || !this.picker) return
    const fixedRows = this.headerRows + 2 + (this.footer.visible ? this.footerRows : 0) + (this.hintLine.visible ? 1 : 0)
    const height = Math.max(3, Math.min(10, this.renderer.terminalHeight - fixedRows - 1,
      this.picker.options.length * 2 + 2 + (this.dialogActions ? 1 : 0)))
    this.pickerBox.height = height
    // Renderable.height reflects the preceding Yoga layout until the next frame.
    this.picker.showDescription = height - 2 - (this.dialogActions ? 1 : 0) >= 2
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
        (!this.cancelCallbacks.size || pending?.kind !== 'chat') &&
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
      const labels = pending.approvalLabels ?? { deny: 'Deny', allow: 'Approve' }
      add('vivi-deny', `${this.approvalIndex === 0 ? '›' : ' '} ${labels.deny}`, () => pending.finish('deny'))
      add('vivi-approve', `${this.approvalIndex === 1 ? '›' : ' '} ${labels.allow}`, () => {
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
    const run = this.runStatus.label
    const detail = this.status.startsWith('Tool running:') ? ` · ${this.status}` : ''
    const summary = run === undefined ? this.status : `${run}${detail}`
    this.statusLine.content = fitStatusColumns(summary.replace(/[\t\n]+/g, ' '), columns)
    this.updateHeader()
    this.updateFooter()
  }
  private updateHeader(): void {
    if (this.closed || !this.headerBox) return
    const columns = Math.max(1, this.renderer.terminalWidth)
    const usage = `${this.usageScope} tokens: ${formatUsage(this.usage).replace('\n', ' · ')}`
    // Roomy terminals share one row. Smaller ones give the title its own row;
    // very short terminals keep one row to leave room for native modal input.
    const usageColumns = statusTextColumns(usage)
    const shared = columns >= usageColumns + 25 || this.renderer.terminalHeight < 14
    const total = String(this.usage.totalTokens)
    const tokenBudget = Math.min(usageColumns, Math.max(1, columns - 13, Math.min(columns, total.length + 6)))
    const titleWidth = shared ? Math.max(0, columns - tokenBudget - 1) : columns
    const gap = shared && titleWidth > 0 ? 1 : 0
    this.headerBox.flexDirection = shared ? 'row' : 'column'
    this.headerRows = shared ? 1 : 2
    this.headerBox.height = this.headerRows
    this.headerBox.gap = gap
    this.header.visible = titleWidth > 0
    this.header.width = titleWidth
    this.header.content = fitStatusColumns(this.sessionTitle, titleWidth, true)
    const tokenWidth = shared ? Math.max(1, columns - titleWidth - gap) : columns
    this.tokenLine.width = tokenWidth
    // Compact labels keep input/output/total and cache read/write distinct. An
    // unreported cache count is '?', never zero. /session retains full labels.
    const compactUsage = `${this.usageScope} I/O/T ${this.usage.inputTokens}/${this.usage.outputTokens}/${this.usage.totalTokens} · cache R/W ${this.usage.cachedInputTokens ?? '?'}/${this.usage.cacheWriteInputTokens ?? '?'}`
    // Never show a clipped number as though it were the total. Give the whole
    // count priority over its label, then over title space in very short terminals.
    const totalLabel = `Total ${total}`
    const priorityUsage = totalLabel.length <= tokenWidth ? totalLabel : total.length <= tokenWidth ? total : '…'
    const fittedUsage = usageColumns <= tokenWidth ? usage : statusTextColumns(compactUsage) <= tokenWidth ? compactUsage : priorityUsage
    this.tokenLine.content = fitStatusColumns(fittedUsage, tokenWidth, true)
    const mode = this.approvalMode === 'auto' ? 'Auto review' : 'Manual'
    const modelWidth = columns - statusTextColumns(` · ${mode}`)
    this.modelLine.content = modelWidth > 0 ? `${fitStatusColumns(this.sessionModel, modelWidth, true)} · ${mode}` : fitStatusColumns(mode, columns, true)
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
    if (this.cancelCallbacks.size && this.pending.kind === 'chat') return
    if (this.pending.kind === 'approval') {
      this.clearInput()
      this.approvalIndex = 0
      this.renderDialogActions()
      const labels = this.pending.approvalLabels ?? { deny: 'Deny', allow: 'Approve' }
      this.updateStatus(`Select ${labels.deny} or ${labels.allow}; pasted approvals are ignored`)
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
    // This shortcut changes display details only, including while an approval is open.
    if (key.ctrl && key.name === 'o') {
      this.consume(key)
      if (!key.repeated && key.eventType !== 'repeat') {
        const latest = [...this.entries].reverse().find(entry => entry.tool)
        if (latest?.tool) this.toggleToolDetails(latest.tool.key)
      }
      return
    }
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
    if (this.cancelCallbacks.size && pending.kind === 'chat') { this.consume(key); return }
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
    // Launch-owned managers may keep cancellation armed while a modal is open.
    // Settle that modal too, so Ctrl-C cannot leave a cancelled picker hanging.
    if (this.pending && this.pending.kind !== 'chat') this.pending.finish(undefined)
    this.clearInput()
    if (this.cancelCallbacks.size) {
      this.runStatus.setPhase('cancelling')
      this.updateStatus('Cancelling…')
      for (const callback of [...this.cancelCallbacks]) callback()
    } else if (!escape) this.close()
    else this.pending?.finish(undefined)
  }
  private submit(): void {
    const pending = this.pending
    if (!pending?.armed || pending.kind === 'choice' || this.closed) return
    // Native onSubmit and stale editor events must obey the same turn lock as keys.
    if (this.cancelCallbacks.size && pending.kind === 'chat') return
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
      this.appendEntry({ category: 'user', label: 'You', content: this.safe(text), markdown: false })
    }
    pending.finish(text)
  }
  private openInput(kind: InputKind, title: string, initial = '', signal?: AbortSignal,
    approvalLabels?: { deny: string; allow: string }): Promise<string | number | undefined> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closed) return Promise.resolve(undefined)
    if (signal?.aborted) return kind === 'chat' ? Promise.reject(new Error('Input cancelled')) : Promise.resolve(undefined)
    if (kind !== 'chat' && !this.runStatus.running && this.runStatus.label !== undefined) {
      this.runStatus.reset()
      if (['Completed', 'Cancelled', 'Error'].includes(this.status)) this.status = 'Ready'
      this.updateStatus()
    }
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
      ? `←/→ or Tab select · Enter confirm · Click ${approvalLabels?.deny ?? 'Deny'} / ${approvalLabels?.allow ?? 'Approve'} · Escape cancels`
      : kind === 'search' ? 'Type to search · ↑/↓ select · PgUp/PgDn · Home/End'
      : kind === 'choice' ? '↑/↓ select · Enter or click choose · Escape back'
      : kind === 'secret' ? 'Input hidden · Enter confirm · Escape back · Ctrl+U clear'
      : 'Enter confirm · Ctrl+J newline · Shift/Alt+Enter if supported · Escape back'
    if (kind !== 'choice' && kind !== 'secret') this.composer.setText(this.safe(initial, MAX_INPUT).slice(0, MAX_INPUT))
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const abort = (): void => pending.finish(undefined, true)
      const pending: PendingInput = { kind, armed: kind !== 'approval', openedFrame: this.renderer.frameId,
        ...(approvalLabels ? { approvalLabels } : {}), finish: (value, aborted = false): void => {
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
  private nextComposerDraft = ''
  setComposerDraft(content: string): void {
    if (this.closed) return
    if (content.length > 65536) throw new Error('Skill draft request exceeds composer limit')
    this.nextComposerDraft = this.safe(content)
  }
  async readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
    const initial = this.nextComposerDraft
    this.nextComposerDraft = ''
    const value = await this.openInput('chat', prompt, initial, signal)
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
      this.updateChoiceLayout()
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
    const enrollment = request.call.name === 'enroll_auto_review'
    if (request.description.length > 60 * 1024) { this.write('Approval denied: exact review exceeds the display limit\n'); return false }
    this.showTool(request.call.id, 'approval_required', 'not_attempted', 'Exact action needs human review')
    const scope = request.currentRevision === 'new memory' ? 'new memory' : `current revision ${request.currentRevision}`
    this.appendEntry({ category: 'activity', attention: true, label: enrollment ? 'Enable Auto review?' : `Approval required · ${scope}`,
      content: this.safe(request.description), markdown: false })
    const title = enrollment ? 'Enable Auto review? (default: cancel)' : 'Review this change (default: deny)'
    this.updateStatus(enrollment ? 'Enable Auto review? · Cancel is the default' : `Approval required · ${scope} · denial is the default`)
    const answer = this.openInput('approval', title, '', signal, enrollment ? { deny: 'Cancel', allow: 'Enable Auto' } : undefined)
    this.pickerBox.title = title
    this.pickerBox.height = 3
    this.pickerBox.visible = true
    this.runStatus.setPhase('waiting_approval')
    try {
      const reply = await answer
      this.showTool(request.call.id, reply === 'allow' && !signal.aborted && !this.closed ? 'running' : signal.aborted ? 'cancelled' : 'denied',
        reply === 'allow' && !signal.aborted && !this.closed ? 'unreported' : 'not_attempted')
      return reply === 'allow' && !signal.aborted && !this.closed
    } finally {
      this.runStatus.setPhase(signal.aborted ? 'cancelling' : 'working')
      if (!this.closed && !this.runStatus.running) this.updateStatus('Ready')
    }
  }
  runStarted(): void {
    if (this.closed) return
    this.settleReviews('cancelled')
    this.turnHistoryStart = this.historyLength
    this.liveHistoryIndex = this.historyLength
    this.liveToolCalls.clear()
    this.runStatus.start()
    this.updateStatus('Working · Escape / Ctrl+C cancels')
  }
  runFinished(outcome: RunOutcome): void {
    if (this.closed) return
    this.settleReviews(outcome)
    for (const [id, live] of this.liveToolCalls) {
      if (!['requested', 'approval_required', 'running'].includes(live.status ?? 'requested')) continue
      this.showTool(id, live.effect === 'not_attempted' ? 'cancelled' : 'unknown', live.effect === 'not_attempted' ? 'not_attempted' : 'unreported')
    }
    this.runStatus.finish(outcome)
    this.updateStatus(outcome === 'completed' ? 'Completed' : outcome === 'cancelled' ? 'Cancelled' : 'Error')
  }
  onCancel(callback: () => void): () => void {
    if (this.closed) { callback(); return () => undefined }
    if (!this.runStatus.running) this.runStatus.reset()
    this.cancelCallbacks.add(callback)
    this.mouseActivation.clear()
    this.updateActionBar()
    this.resultNotices = []
    this.clearInput()
    this.disableComposer()
    this.updateStatus('Running · Escape / Ctrl+C cancels')
    return () => {
      this.cancelCallbacks.delete(callback)
      this.updateActionBar()
      if (!this.closed && !this.cancelCallbacks.size && !this.runStatus.running &&
        (this.status === 'Running · Escape / Ctrl+C cancels' || this.status === 'Cancelling…')) this.updateStatus('Ready')
    }
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
    const user = entry.category === 'user'
    const activity = entry.category === 'activity'
    const headerColor = user ? TUI_THEME.lavender : entry.attention ? TUI_THEME.attention : activity ? TUI_THEME.muted : TUI_THEME.pink
    const bodyColor = activity && !entry.attention ? TUI_THEME.muted : TUI_THEME.foreground
    const box = new BoxRenderable(this.renderer, { flexDirection: 'column', flexShrink: 0, width: '100%', marginBottom: 1,
      ...(user ? { backgroundColor: TUI_THEME.userBackground, border: ['left'], borderColor: TUI_THEME.lavender, paddingLeft: 1 } : {}) })
    box.add(new TextRenderable(this.renderer, { content: entry.label, fg: headerColor, flexShrink: 0, wrapMode: 'word' }))
    if (entry.tool) {
      const key = entry.tool.key, collapsed = this.collapsedTools.has(key)
      const view = cliToolPresentationView(entry.tool.encoded, collapsed, 8192, this.secrets)
      for (const line of view.header) box.add(new TextRenderable(this.renderer,
        { content: this.safe(line), fg: TUI_THEME.muted, flexShrink: 0, width: '100%', wrapMode: 'word' }))
      // Safety and provenance are sibling rows, never part of the detail container/budget.
      for (const warning of view.warnings) box.add(new TextRenderable(this.renderer,
        { content: this.safe(`Warning: ${warning}`), fg: TUI_THEME.attention, flexShrink: 0, width: '100%', wrapMode: 'word' }))
      const button = new TextRenderable(this.renderer, { id: `vivi-tool-details-${key}`,
        content: `${collapsed ? 'Show' : 'Hide'} details · Ctrl+O latest`, fg: TUI_THEME.lavender,
        flexShrink: 0, width: '100%', wrapMode: 'word' })
      button.selectable = false
      button.onMouse = event => this.mouseActivation.handle(event, button, key, entry.tool, !this.closed && this.entries.includes(entry),
        () => this.toggleToolDetails(key))
      box.add(button)
      const details = new BoxRenderable(this.renderer, { id: `vivi-tool-body-${key}`, flexDirection: 'column',
        flexShrink: 0, width: '100%' })
      for (const section of view.details) details.add(new TextRenderable(this.renderer,
        { content: this.safe(`${section.label}:\n${section.text}`), fg: bodyColor, width: '100%', wrapMode: 'word', flexShrink: 0 }))
      box.add(details)
      if (view.notice) box.add(new TextRenderable(this.renderer,
        { content: view.notice, fg: TUI_THEME.muted, width: '100%', wrapMode: 'word', flexShrink: 0 }))
    }
    if (entry.content && !entry.tool) box.add(entry.markdown ? this.markdown(entry.content) : new TextRenderable(this.renderer,
      { content: entry.content, fg: bodyColor, width: '100%', wrapMode: 'word', flexShrink: 0 }))
    this.transcript.add(box)
    return box
  }
  private toggleToolDetails(key: string): void {
    this.mouseActivation.clear()
    if (this.collapsedTools.has(key)) this.collapsedTools.delete(key)
    else this.collapsedTools.add(key)
    this.rebuild()
  }
  setToolEvidence(evidence: CliToolEvidence): void { this.toolEvidence = evidence }
  /** Inert display sink for shared versioned data; it contains no action handlers. */
  toolPresentation(encoded: string): void {
    this.appendEntry({ category: 'activity', label: 'Tool presentation', content: '', markdown: false,
      tool: { encoded, key: `display-${this.liveHistoryIndex++}` } })
  }
  private toolKey(index: number, callId: string): string {
    // No user-controlled ID is a renderable ID or an executable link.
    return Buffer.from(JSON.stringify([this.sessionId ?? 'unreported', index, callId])).toString('hex')
  }
  private showTool(callId: string, status: ToolPresentationStatus, effect: ToolPresentationEffect,
    progress?: string): void {
    const live = this.liveToolCalls.get(callId)
    if (!live) return
    live.status = status; live.effect = effect
    let encoded: string
    try { encoded = JSON.stringify(createCliToolPresentation({ call: live.call, status, effect,
      source: cliToolSource(this.sessionId, live.index, live.call), secrets: this.secrets, ...(progress ? { progress } : {}) })) }
    catch { encoded = '' }
    const old = this.entries.find(entry => entry.tool?.key === live.key)
    const entry: DisplayEntry = { category: 'activity', label: this.safe(`Tool ${live.call.name}`, 4096), content: '',
      markdown: false, tool: { encoded, key: live.key }, historyIndex: live.index }
    if (old) this.entries[this.entries.indexOf(old)] = entry
    else this.entries.push(entry)
    this.rebuild()
  }
  private trimEntries(): void {
    const size = (entry: DisplayEntry): number => {
      if (!entry.tool) return entry.label.length + entry.content.length
      const view = cliToolPresentationView(entry.tool.encoded, false, 8192, this.secrets)
      return entry.label.length + [...view.header, ...view.warnings, ...view.details.map(section => section.text)].join('\n').length
    }
    let total = this.entries.reduce((sum, entry) => sum + size(entry), 0)
    while (this.entries.length > 1 && (this.entries.length > MAX_ENTRIES || total > MAX_DISPLAY)) {
      const first = this.entries.shift()!
      total -= size(first)
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
      if (message.kind === 'tool_result') {
        let encoded: string
        try { encoded = JSON.stringify(cliHistoryToolPresentation(history, index, this.sessionId, this.toolEvidence, this.secrets)) }
        catch { encoded = '' }
        let requestIndex = index
        for (let previous = index - 1; previous >= 0; previous--) {
          const candidate = history[previous]!
          if (candidate.kind === 'message' && candidate.role === 'user') break
          if (candidate.kind === 'assistant' && candidate.toolCalls.some(call => call.id === message.callId && call.name === message.name)) {
            requestIndex = previous; break
          }
        }
        const key = this.toolKey(requestIndex, message.callId)
        const view = cliToolPresentationView(encoded, false, Math.max(0, Math.min(8192, budget)), this.secrets)
        entries.unshift({ category: 'activity', label: safeLabel, content: '', markdown: false, historyIndex: index,
          attention: view.warnings.length > 0, tool: { encoded, key } })
        // Whole-history retention may omit old complete cards, never slice their safety rows.
        budget -= safeLabel.length + [...view.header, ...view.warnings, ...view.details.map(section => section.text)].join('\n').length
        continue
      }
      const content = this.safe(message.content + tools, Math.max(0, budget - safeLabel.length))
      entries.unshift({ category: message.kind === 'message' && message.role === 'user' ? 'user' : message.kind === 'assistant' ? 'assistant' : 'activity',
        label: safeLabel, content, markdown: message.kind === 'assistant', historyIndex: index })
      budget -= safeLabel.length + content.length
    }
    if (entries.length < history.length) entries.unshift({ category: 'activity', label: 'Display limit',
      content: 'Earlier transcript is omitted from this bounded view; saved history is unchanged', markdown: false })
    return entries
  }
  private transcriptEntries(history: readonly HistoryMessage[]): DisplayEntry[] {
    const entries = this.historyEntries(history)
    const placed = new Map<number, DisplayEntry[]>()
    for (const entry of this.reviewNotices) {
      const start = entry.historyStart ?? this.turnHistoryStart
      if (start >= history.length) continue
      let end = history.length
      for (let index = start + 1; index < history.length; index++) {
        const message = history[index]!
        if (message.kind === 'message' && message.role === 'user') { end = index; break }
      }
      let position = end
      if (entry.review) {
        // Call IDs can be reused on later turns. Only match inside this run's history span.
        const result = history.findIndex((message, index) => index >= start && index < end &&
          message.kind === 'tool_result' && message.callId === entry.review!.callId)
        if (result >= 0) position = result
        else {
          const assistant = history.findIndex((message, index) => index >= start && index < end &&
            message.kind === 'assistant' && message.toolCalls.some(call => call.id === entry.review!.callId))
          if (assistant >= 0) position = assistant + 1
        }
      } else {
        // A separate audit warning belongs to its turn, before the final answer.
        for (let index = end - 1; index >= start; index--) {
          const message = history[index]!
          if (message.kind === 'assistant' && !message.toolCalls.length) { position = index; break }
        }
      }
      const group = placed.get(position) ?? []
      group.push(entry); placed.set(position, group)
    }
    return entries.flatMap(entry => entry.historyIndex === undefined ? [entry]
      : [...(placed.get(entry.historyIndex) ?? []), entry]).concat(placed.get(history.length) ?? [])
  }
  private settleReviews(outcome: RunOutcome): void {
    for (const entry of [...this.reviewNotices]) {
      if (!entry.review || reviewNoticeSettled(entry.review)) continue
      const unknown = entry.review.state === 'saving'
      const mcp = entry.review.toolName.startsWith('mcp_') || ['list_mcp_resources', 'read_mcp_resource'].includes(entry.review.toolName)
      this.reviewNotice(mcp
        ? unknown ? 'The MCP operation outcome could not be confirmed; check the remote service before retrying'
          : outcome === 'cancelled' ? 'Review cancelled; no MCP operation was started' : 'Review ended before an MCP operation was started'
        : unknown ? 'The write outcome could not be confirmed; check the resource before retrying'
          : outcome === 'cancelled' ? 'Review cancelled; no save was made' : 'Review ended without a confirmed save',
      { ...entry.review, state: unknown ? 'unknown' : outcome === 'cancelled' ? 'cancelled' : 'failed' })
    }
  }
  setDraft(provider: CliProviderName): void {
    if (this.closed) return
    this.runStatus.reset()
    this.sessionId = undefined
    this.sessionTitle = 'Untitled conversation'
    this.sessionModel = `vivi · ${provider} · choose a model with /models`
    this.updateHeader()
    this.clearStream()
    this.entries = []
    this.resultNotices = []
    this.reviewNotices = []
    this.toolEvidence = undefined
    this.collapsedTools.clear()
    this.liveToolCalls.clear()
    this.historyLength = 0
    this.turnHistoryStart = 0
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
      this.runStatus.reset()
      this.resultNotices = []
      this.reviewNotices = []
      this.turnHistoryStart = 0
      this.clearStream()
      this.collapsedTools.clear()
      this.liveToolCalls.clear()
      this.status = 'Ready'
    }
    this.sessionId = session.id
    this.sessionTitle = this.safe(sessionDisplayTitle(session), 4096)
    this.sessionModel = this.safe(`${session.provider} / ${session.model} · reasoning ${session.reasoning ?? 'default'}`, 4096)
    this.updateHeader()
    this.usage = { ...session.usage }
    this.usageScope = 'Session'
    this.historyLength = session.history.length
    this.entries = [...this.transcriptEntries(session.history), ...this.resultNotices]
    this.rebuild()
    this.updateStatus()
  }
  write(text: string): void {
    if (text) this.appendEntry({ category: 'activity', label: 'vivi', content: this.safe(text.trimEnd()), markdown: false })
  }
  reviewNotice(message: string, context?: ReviewNotice): void {
    if (this.closed || !message) return
    if (context && this.sessionId !== undefined && context.sessionId !== this.sessionId) return
    const key = context ? JSON.stringify([context.sessionId, context.runId, context.callId]) : undefined
    const previous = key === undefined ? undefined : this.reviewNotices.find(entry => entry.reviewKey === key)
    if (previous?.review && reviewNoticeSettled(previous.review)) return
    if (context) {
      const state: Record<ReviewNotice['state'], readonly [ToolPresentationStatus, ToolPresentationEffect]> = {
        reviewing: ['running', 'not_attempted'], needs_review: ['approval_required', 'not_attempted'],
        saving: ['running', 'unknown'], saved: ['succeeded', 'confirmed'], denied: ['denied', 'not_attempted'],
        cancelled: ['cancelled', 'not_attempted'], failed: ['failed', 'not_attempted'], unknown: ['unknown', 'unknown'] }
      this.showTool(context.callId, ...state[context.state], message)
    }
    const content = this.safe(message, 2048)
    if (!context && this.reviewNotices.some(entry => !entry.review && entry.historyStart === this.turnHistoryStart && entry.content === content)) return
    const entry: DisplayEntry = { category: 'activity',
      attention: !context || ['needs_review', 'failed', 'unknown'].includes(context.state), label: context ? this.safe(`Review · ${context.toolName}`, 4096) : 'Review warning',
      content, markdown: false,
      historyStart: previous?.historyStart ?? this.turnHistoryStart,
      ...(context ? { review: { ...context }, reviewKey: key! } : {}) }
    if (previous) {
      this.reviewNotices[this.reviewNotices.indexOf(previous)] = entry
      const index = this.entries.findIndex(item => item.reviewKey === key)
      if (index >= 0) this.entries[index] = entry
      else this.entries.push(entry)
      this.rebuild()
    } else {
      this.reviewNotices = [...this.reviewNotices, entry].slice(-32)
      this.appendEntry(entry)
    }
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
      this.partialBox.add(new TextRenderable(this.renderer, { content: 'Assistant · streaming preview (not accepted)', fg: TUI_THEME.pink }))
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
      this.appendEntry({ category: 'assistant', label: 'Assistant', content: event.message.content, markdown: true })
      const index = this.liveHistoryIndex++
      for (const call of event.message.toolCalls) {
        this.liveToolCalls.set(call.id, { call, index, key: this.toolKey(index, call.id) })
        this.showTool(call.id, 'requested', 'not_attempted')
      }
    } else if (event.type === 'tool_started') {
      this.updateStatus(`Tool running: ${event.call.name}`)
      if (!this.liveToolCalls.has(event.call.id)) this.liveToolCalls.set(event.call.id,
        { call: event.call, index: this.liveHistoryIndex, key: this.toolKey(this.liveHistoryIndex, event.call.id) })
      this.showTool(event.call.id, 'running', 'unreported', `${event.call.name} · running`)
    } else if (event.type === 'tool_completed') {
      this.updateStatus('Working')
      const history = [{ kind: 'assistant', content: '', toolCalls: [this.liveToolCalls.get(event.message.callId)?.call ??
        { id: event.message.callId, name: event.message.name, arguments: {} }] }, event.message] as HistoryMessage[]
      let encoded: string
      try { encoded = JSON.stringify(cliHistoryToolPresentation(history, 1, this.sessionId, undefined, this.secrets)) }
      catch { encoded = '' }
      const old = this.entries.find(entry => entry.tool?.key === this.liveToolCalls.get(event.message.callId)?.key)
      const entry: DisplayEntry = { category: 'activity', attention: true,
        label: this.safe(`Tool ${event.message.name} · ${event.message.isError ? 'error' : 'done'}`, 4096), content: '', markdown: false,
        historyIndex: this.liveHistoryIndex++, tool: { encoded, key: this.liveToolCalls.get(event.message.callId)?.key ?? this.toolKey(this.liveHistoryIndex, event.message.callId) } }
      if (old) this.entries[this.entries.indexOf(old)] = entry
      else this.entries.push(entry)
      this.liveToolCalls.delete(event.message.callId)
      this.rebuild()
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
    this.settleReviews(result.status)
    this.historyLength = result.history.length
    this.entries = this.transcriptEntries(result.history)
    this.resultNotices = []
    if (partial !== undefined) this.resultNotices.push({ category: 'assistant', label: 'Partial display only · response was not accepted', content: partial, markdown: true })
    if (result.error) this.resultNotices.push({ category: 'activity', attention: true, label: 'Error', content: this.safe(result.error.message), markdown: false })
    this.entries.push(...this.resultNotices)
    this.rebuild()
    this.usage = { ...result.usage }
    this.usageScope = 'Turn'
    this.updateStatus(result.status === 'completed' ? 'Completed' : result.status === 'cancelled' ? 'Cancelled' : 'Error')
  }
  private dispose(destroyRenderer: boolean): void {
    if (this.closed) return
    this.closed = true
    this.runStatus.reset()
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
