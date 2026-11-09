// SPDX-License-Identifier: Apache-2.0
import { conversationHistoryDigest, matchingConversationErrors } from './conversation-errors.js'
import type { CliConversationError, CliConversationErrors } from './conversation-errors.js'
import {
  BoxRenderable, CliRenderEvents, CodeRenderable, createCliRenderer, createClipboard, createHostClipboard,
  createRendererClipboardAdapter, decodePasteBytes, ImageRenderable, MarkdownRenderable,
  RGBA, SelectRenderable, SelectRenderableEvents, StyledText, SyntaxStyle, TextareaRenderable, TextAttributes, TextBufferRenderable, TextRenderable, TextTableRenderable,
  ScrollBoxRenderable, TreeSitterClient, resolveRenderLib
} from '@opentui/core'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClipboardService, CliRenderer, KeyEvent, MouseEvent, PasteEvent, Renderable, Selection } from '@opentui/core'
import type { AgentEvent, AgentResult, HistoryMessage, ToolCall, ToolImageReference, ContextUsage } from '@ayayaq/vivi'
import type { ToolPresentation, ToolPresentationEffect, ToolPresentationStatus } from '@ayayaq/vivi/presentation'
import type { CliProviderName, CliSession } from './session.js'
import { redactSecrets } from './session.js'
import { parseUserShellInput, USER_SHELL_DISCLOSURE } from './user-shell.js'
import type { ChatIO } from './terminal.js'
import type { BackgroundProcessControls } from './process-controls.js'
import type { SteeringControls, SteeringMessage } from './steering.js'
import type { ApprovalRequest } from './tools.js'
import { matchingChoiceIndices } from './picker.js'
import { createWindowsInputBridge } from './windows-input.js'
import type { WindowsInputBridge } from './windows-input.js'
import { inputProbe } from './input-diagnostic.js'
import type { InputDiagnosticReport, InputProbe } from './input-diagnostic.js'
import type { Choice, SearchableOptions, SearchableSelection } from './picker.js'
import { formatContextStatus } from './context-status.js'
import { MouseActivation, MouseHover, pickerIndexAt, pickerHoverRegion } from './tui-mouse.js'
import { RunStatus } from './run-status.js'
import type { RunClock, RunOutcome } from './run-status.js'
import { sessionDisplayTitle } from './session-display.js'
import type { ApprovalMode, ReviewNotice } from './auto-review.js'
import { conversationModeLabel } from './task-mode.js'
import type { TaskMode } from './task-mode.js'
import { reviewNoticeSettled } from './auto-review.js'
import { createCliToolPresentation, cliHistoryToolPresentation, cliToolPresentationView, cliToolCardView, cliToolSource, cliToolResultDecision, isCliLocalReadTool } from './tool-presentation.js'
import type { CliToolEvidence } from './tool-presentation.js'
import { mcpContainsSecret } from './mcp-content.js'
import { WorkspaceDiffRenderable, workspaceDiffPresentation } from './tui-diff.js'
import { createTerminalTitleSink, TerminalTitleController } from './terminal-title.js'
import type { TerminalTitleSink } from './terminal-title.js'
import type { QuestionRequest, QuestionResponse } from '@ayayaq/vivi/extensions/questions'
import { TerminalProgramStatus, createProgramStatusSink } from './terminal-program-status.js'
import type { ProgramStatusSink } from './terminal-program-status.js'
import { InputQueue } from './input-queue.js'
import { ComposerPastes } from './composer-paste.js'
import type { ComposerDraft } from './composer-paste.js'
import type { CliImageSource, PastedImage } from './image-assets.js'
import { IMAGE_LIMITS } from './image-assets.js'
import { pastedImagePath, readPastedImagePath } from './pasted-image-path.js'
import { FileImagePreviewer } from './image-preview.js'
import type { ImagePreviewService } from './image-preview.js'
import { QuestionDialog } from './question-dialog.js'
import { PromptHistory } from './prompt-history.js'
import type { PromptHistoryStore } from './prompt-history.js'
import { ControlModal } from './control-modal.js'
import type { ControlDetails } from './picker.js'

export type { Choice } from './picker.js'
export interface OpenTuiOptions { oneShot?: boolean; stream?: boolean; loading?: boolean; secrets?: readonly string[]; runClock?: RunClock;
  promptHistory?: readonly string[]; promptHistoryStore?: PromptHistoryStore;
  /** Trusted production wiring or an offline test sink; omitted on directly constructed test surfaces. */
  terminalTitle?: TerminalTitleSink; programStatus?: ProgramStatusSink; statusEnvironment?: NodeJS.ProcessEnv;
  clipboard?: Pick<ClipboardService, 'writeText' | 'dispose'> & Partial<Pick<ClipboardService, 'read'>>;
  imagePreview?: ImagePreviewService }

// Ordinary surfaces and text inherit the terminal palette. Dark localized
// highlights need their own foreground, including native text selections.
export const TUI_THEME = { pink: '#f87ea2', lavender: '#b08bfc', background: 'transparent',
  foreground: RGBA.defaultForeground(), highlightForeground: '#e4e4e7',
  selectedBackground: '#3d2946', hoverBackground: '#56395f', userBackground: '#24212d', rowBackground: '#24212d',
  muted: RGBA.defaultForeground(), attention: '#fbbf24' } as const
const TEXT_SELECTION = { selectionBg: RGBA.fromHex(TUI_THEME.selectedBackground),
  selectionFg: RGBA.fromHex(TUI_THEME.highlightForeground) } as const
const guardedTables = new WeakSet<TextTableRenderable>()
function guardMarkdownSelection(node: Renderable): void {
  if (node instanceof TextBufferRenderable) {
    if (!node.selectionBg?.equals(TEXT_SELECTION.selectionBg)) node.selectionBg = TEXT_SELECTION.selectionBg
    if (!node.selectionFg?.equals(TEXT_SELECTION.selectionFg)) node.selectionFg = TEXT_SELECTION.selectionFg
  }
  if (node instanceof TextTableRenderable && !guardedTables.has(node)) {
    guardedTables.add(node)
    const after = node.renderAfter
    // OpenTUI 0.5 tables lack selection setters. Keep the native table and its
    // layout/capability updates; only selections paint opaque cells in its
    // otherwise-transparent buffer. Public post-render color views preserve
    // glyphs, attributes, links and copied text, including nested tables.
    node.renderAfter = function(buffer, deltaTime) {
      after?.call(this, buffer, deltaTime)
      if (!node.hasSelection()) return
      const { fg, bg } = buffer.buffers
      for (let offset = 0; offset < bg.length; offset += 4) {
        if (RGBA.fromArray(bg.subarray(offset, offset + 4)).a === 0) continue
        fg.set(TEXT_SELECTION.selectionFg.buffer, offset)
        bg.set(TEXT_SELECTION.selectionBg.buffer, offset)
      }
    }
  }
  for (const child of node.getChildren()) guardMarkdownSelection(child)
}
export const SLASH_COMMANDS = [
  { command: '/provider', description: 'Choose a chat provider' },
  { command: '/account', description: 'Manage ChatGPT accounts and sign-in' },
  { command: '/usage', description: 'Show usage and ChatGPT plan settings' },
  { command: '/web', description: 'Choose an independent web provider' },
  { command: '/reviewer', description: 'Choose this conversation’s Auto reviewer' },
  { command: '/auto-threshold', description: 'Set the reviewer’s saved requirement cutoff' },
  { command: '/models', description: 'Choose a model' },
  { command: '/effort', description: 'Choose reasoning effort' },
  { command: '/mode', description: 'Choose Manual / Auto review / Skip permissions / Plan' },
  { command: '/new', description: 'Start a new session' },
  { command: '/resume', description: 'Resume a saved session' },
  { command: '/rename', description: 'Rename the current session' },
  { command: '/notes', description: 'Change the session-note default for new conversations' },
  { command: '/settings', description: 'Open the menu (legacy alias)' },
  { command: '/memories', description: 'Manage app-wide saved context' },
  { command: '/compact', description: 'Compact the provider context; retain the full transcript' },
  { command: '/context', description: 'Show context capacity and output reserve' },
  { command: '/commands', description: 'Manage trusted workspace commands' },
  { command: '/processes', description: 'List, inspect or stop background jobs' },
  { command: '/instructions', description: 'Inspect, reload or disable project guidance' },
  { command: '/skills', description: 'List, inspect and draft standard skills' },
  { command: '/mcp', description: 'Manage trusted server metadata connections' },
  { command: '/menu', description: 'Open the menu' },
  { command: '/help', description: 'Show commands and shortcuts' },
  { command: '/queue', description: 'Inspect, send, edit or clear pending messages' },
  { command: '/session', description: 'Show the current session' },
  { command: '/exit', description: 'Exit vivi' }
] as const
export type SlashCommand = typeof SLASH_COMMANDS[number]

/** Complete only the whole, first slash token. Ordinary text and arguments are untouched. */
export function getSlashCommandCompletions(input: string, canCompact = true): readonly SlashCommand[] {
  return /^\/[a-z]*$/.test(input) ? SLASH_COMMANDS.filter(({ command }) => command.startsWith(input) && (command !== '/compact' || canCompact))
    .sort((a, b) => Number(b.command === input) - Number(a.command === input)) : []
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
function toolHeader(card: { readonly title: string; readonly status: string }, collapsed: boolean, columns: number): string {
  const chevron = collapsed ? '▸' : '▾'
  if (!card.status) return fitStatusColumns(`${chevron} ${card.title}`, columns, true)
  // Required safety words survive narrow terminals; only the target is clipped.
  const prefix = `${chevron} ${card.status}`
  const remaining = columns - statusTextColumns(prefix) - 3
  if (remaining < 3) return prefix
  return `${prefix} · ${fitStatusColumns(card.title.slice(card.status.length + 3), remaining, true)}`
}
// OpenTUI 0.5.14 groups repeated clicks for 500ms; allow a frame-timing margin.
const APPROVAL_REPEAT_WINDOW_MS = 600
const COPY_TOAST_MS = 1200
const HINTS = 'Enter send · Ctrl+J newline · / menu'
const COMPOSER_PLACEHOLDER = new StyledText([{ __isChunk: true, text: 'What would you like to work on?',
  fg: TUI_THEME.muted, attributes: TextAttributes.DIM }])
type InputKind = 'chat' | 'steering' | 'text' | 'secret' | 'approval' | 'choice' | 'search' | 'question' | 'control'
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
  approval?: object
  workspaceDiff?: string
  images?: readonly ToolImageReference[]
  tool?: { encoded: string; key: string; detailBytes?: number; retained?: boolean; localRead?: boolean; resultError?: boolean }
}
interface SteeringInput {
  readonly controls: SteeringControls
  pending?: PendingInput | undefined
  draft: string
  pasteDraft?: ComposerDraft | undefined
  timer?: ReturnType<typeof setTimeout>
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
  private loadingBox!: BoxRenderable
  private loadingLine!: TextRenderable
  private loadingMessage: string | undefined
  private loadingFrame = 0
  private loadingTimer: ReturnType<typeof setInterval> | undefined
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
  private processBar!: BoxRenderable
  private processLabel!: TextRenderable
  private processControls: BackgroundProcessControls | undefined
  private processSelection: string | undefined
  private processGesture: object = {}
  private processStopping = new Map<string, object>()
  private processTimer: ReturnType<typeof setInterval> | undefined
  private dialogActions: BoxRenderable | undefined
  private approvalIndex = 1
  private approvalMouseNotBefore = 0
  private readonly mouseActivation = new MouseActivation()
  private readonly hover: MouseHover
  private readonly clipboard: OpenTuiOptions['clipboard']
  private readonly imagePreview: ImagePreviewService
  private readonly openingImages = new Set<string>()
  private imageSource: CliImageSource | undefined
  private imageSourceController = new AbortController()
  private readonly resultImageBytes = new Map<string, Promise<Uint8Array>>()
  private resultImageByteCount = 0
  private pickerChangedFrame = 0
  private completionChangedFrame = 0
  private lastRenderedFrame = 0
  private transcript!: ScrollBoxRenderable
  private statusLine!: TextRenderable
  private shellNotice!: TextRenderable
  private steeringQueueLine!: TextRenderable
  private steeringActions!: BoxRenderable
  private steering: SteeringInput | undefined
  private steeringHasDraft = false
  private steeringMessage: string | undefined
  private steeringQueue: readonly SteeringMessage[] = []
  private composerBox!: BoxRenderable
  private copyToast!: TextRenderable
  private copyToastTimer: ReturnType<typeof setTimeout> | undefined
  private composer!: TextareaRenderable
  private pastes!: ComposerPastes
  private imagePreviews!: BoxRenderable
  private previewPaths = ''
  private clipboardRead: AbortController | undefined
  private imagePathRead: AbortController | undefined
  private imagePathJobs: Promise<void> = Promise.resolve()
  private promptHistory: PromptHistory<ComposerDraft>
  private readonly promptHistoryStore: PromptHistoryStore | undefined
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
  private readonly expandedTools = new Set<string>()
  private liveToolCalls = new Map<string, { call: ToolCall; index: number; resultIndex?: number; key: string; source: ToolPresentation['source']; status?: ToolPresentationStatus; effect?: ToolPresentationEffect }>()
  private liveHistoryIndex = 0
  private activeApproval: { token: object; toolKey: string | undefined } | undefined
  private displaySequence = 0
  private resultNotices: DisplayEntry[] = []
  private conversationErrors: CliConversationErrors | undefined
  private liveErrors: CliConversationError[] = []
  private reviewNotices: DisplayEntry[] = []
  private historyLength = 0
  private turnHistoryStart = 0
  private pending: PendingInput | undefined
  private readonly inputQueue = new InputQueue()
  private dialogOwner = new AbortController()
  private activeDialog: object | undefined
  private questionDialog: QuestionDialog | undefined
  private controls: ControlModal | undefined
  private suspendedChat: { pending: PendingInput; title: string; pasteDraft: ComposerDraft } | undefined
  private closed = false
  private failure: Error | undefined
  private changingInput = false
  private cancelCallbacks = new Set<() => void>()
  private status = 'Ready'
  private readonly runStatus: RunStatus
  private readonly terminalTitle: TerminalTitleController
  private readonly programStatus: TerminalProgramStatus
  private workspaceDirectory: string | undefined
  private workspaceStatus = false
  private sessionTitle = 'Untitled conversation'
  private sessionProvider = 'vivi'
  private sessionModel = 'choose a model with /models'
  private sessionEffort = ''
  private sessionPlan = false
  private footerTargets: { start: number; end: number; command: string }[] = []
  private footerChangedFrame = -1
  private sessionId: string | undefined
  private approvalMode: ApprovalMode = 'manual'
  private taskMode: TaskMode = 'execute'
  private contextUsage: ContextUsage | undefined
  private canCompact = false
  private streamed = ''
  private streamOverflow = false
  private windowsInput: WindowsInputBridge | undefined
  private diagnosticKey: ((key: KeyEvent) => void) | undefined
  private finishDiagnostic: (() => void) | undefined

  private readonly keyHandler = (key: KeyEvent): void => {
    this.hover.clear()
    try { this.handleKey(key) } catch (error) { this.errorHandler({ error }) }
  }
  private readonly frameHandler = (event: { frameId: number }): void => {
    this.lastRenderedFrame = event.frameId
    // Native undo/deletion notifications can precede the new buffer contents.
    // Reconcile after a completed frame as well as at ordinary edit callbacks.
    this.updateChoiceLayout()
    this.controls?.sync()
    if (this.pending?.kind === 'steering' && this.steeringHasDraft !== !!this.composerText.trim()) this.updateFooter()
    this.updateComposerLayout()
  }
  private readonly focusHandler = (): void => {
    this.hover.clear()
    this.mouseActivation.clear()
    this.questionDialog?.resetGesture()
    this.controls?.resetGesture()
  }
  private readonly blurHandler = (): void => {
    this.hover.clear()
    this.mouseActivation.clear()
    this.questionDialog?.resetGesture()
    this.controls?.resetGesture()
    if (this.pending?.kind === 'approval') { this.approvalIndex = 1; this.renderDialogActions() }
  }
  private readonly resizeHandler = (): void => {
    this.renderLoading()
    this.hover.clear()
    this.mouseActivation.clear()
    this.updateActionBar()
    this.updateApprovalLayout()
    this.updateHeader()
    if (this.workspaceStatus) this.updateStatus()
    this.renderDialogActions()
    this.updateChoiceLayout()
    if (this.searchPicker) this.renderSearchPicker(false)
    if (this.completions.length) this.renderCompletions()
    this.refreshProcesses()
    this.updateComposerLayout()
    this.questionDialog?.resize()
    this.controls?.resize()
    this.updateSteeringQueue()
    this.rebuild()
  }
  private readonly pasteHandler = (event: PasteEvent): void => {
    try { this.handlePaste(event) } catch (error) { this.errorHandler({ error }) }
  }
  private readonly selectionHandler = (selection: Selection): void => {
    if (this.closed || selection.isDragging || !this.clipboard) return
    const text = selection.getSelectedText()
    if (!text) return
    // OpenTUI emits SELECTION on mouse release, including word/line selections.
    // Preserve the native text and highlight; clipboard failures must not end a session.
    void (async () => {
      try {
        const result = await this.clipboard!.writeText(text, { destination: 'best-available' })
        if (result.host.status === 'written' || result.terminal.status === 'attempted') {
          this.showCopyToast()
          return
        }
      } catch { /* Report clipboard failure without exposing selected text or backend errors. */ }
      if (!this.closed) this.updateStatus('Could not copy selection; use your terminal copy controls')
    })()
  }
  private showCopyToast(): void {
    if (this.closed) return
    if (this.copyToastTimer !== undefined) clearTimeout(this.copyToastTimer)
    this.copyToast.visible = true
    this.copyToastTimer = setTimeout(() => {
      this.copyToastTimer = undefined
      if (!this.closed) this.copyToast.visible = false
    }, COPY_TOAST_MS)
    this.copyToastTimer.unref()
  }
  private readonly signalHandler = (): void => { if (this.loadingMessage !== undefined) this.close(); else this.cancelOrClose() }
  private readonly exitHandler = (): void => this.close()
  private readonly processExitHandler = (): void => {
    this.close()
    // Synchronous process exit cannot await a destroy deferred during a render.
    // Native suspend/cleanup has already run; no later JS finalizer can follow.
    this.restoreTerminalTitle()
  }
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
      // Directly constructed surfaces have no factory onDestroy callback. The
      // DESTROY event precedes native cleanup, so restore after its stack returns.
      this.restoreTerminalTitle()
      style?.destroy()
      // An IO owns its parser worker; closing a surface must not keep the CLI alive.
      // Only a private, disposable directory is used. Never touch OpenTUI's global cache.
      void (async () => {
        try { await parser?.destroy() }
        finally { if (directory) await rm(directory, { recursive: true, force: true }) }
      })().catch(() => undefined)
    })
  }

  constructor(private readonly renderer: CliRenderer, options: OpenTuiOptions = {}, terminalTitle?: TerminalTitleController,
    programStatus?: TerminalProgramStatus) {
    if (renderer.isDestroyed) throw new Error('Cannot use a destroyed OpenTUI renderer')
    this.hover = new MouseHover(renderer, RGBA.fromHex(TUI_THEME.hoverBackground), RGBA.fromHex(TUI_THEME.highlightForeground))
    this.terminalTitle = terminalTitle ?? new TerminalTitleController(options.terminalTitle)
    this.programStatus = programStatus ?? new TerminalProgramStatus(options.programStatus, !options.oneShot)
    this.runStatus = new RunStatus(() => this.updateStatus(), options.runClock)
    this.secrets = [...new Set(options.secrets ?? [])].filter(Boolean).sort((a, b) => b.length - a.length)
    this.stream = options.stream ?? true
    this.promptHistory = new PromptHistory<ComposerDraft>(options.promptHistory)
    this.promptHistoryStore = options.promptHistoryStore
    this.clipboard = options.clipboard
    this.imagePreview = options.imagePreview ?? new FileImagePreviewer()
    renderer.once(CliRenderEvents.DESTROY, this.destroyHandler)
    try {
      this.style = SyntaxStyle.fromStyles({
        default: { fg: TUI_THEME.foreground }, 'markup.heading': { fg: TUI_THEME.lavender, bold: true },
        'markup.strong': { bold: true }, 'markup.italic': { italic: true },
        'markup.raw': { fg: TUI_THEME.pink }, 'markup.link': { fg: TUI_THEME.lavender, underline: true },
        'markup.list': { fg: TUI_THEME.lavender }, 'markup.quote': { fg: TUI_THEME.muted, dim: true, italic: true },
        conceal: { fg: TUI_THEME.muted, dim: true }
      })
      this.shell = new BoxRenderable(renderer, { id: 'vivi-root', width: '100%', height: '100%',
        flexDirection: 'column', backgroundColor: TUI_THEME.background, onMouse: (event) => {
          if (event.type === 'scroll') this.hover.clear()
          if (event.type !== 'over') this.mouseActivation.clear()
          // Transcript scrolling must not steal the next keystroke from an input.
          if (event.type === 'down' && this.pending) event.preventDefault()
        } })
      renderer.root.add(this.shell)
      this.headerBox = new BoxRenderable(renderer, { id: 'vivi-header-box', height: 2, flexShrink: 0,
        width: '100%', flexDirection: 'column' })
      this.header = new TextRenderable(renderer, { ...TEXT_SELECTION, id: 'vivi-header', height: 1, flexShrink: 0,
        content: 'vivi', fg: TUI_THEME.foreground, wrapMode: 'none' })
      this.tokenLine = new TextRenderable(renderer, { ...TEXT_SELECTION, id: 'vivi-tokens', height: 1, flexShrink: 0,
        fg: TUI_THEME.muted, attributes: TextAttributes.DIM, textAlign: 'right', wrapMode: 'none' })
      this.headerBox.add(this.header); this.headerBox.add(this.tokenLine)
      this.modelLine = new TextRenderable(renderer, { ...TEXT_SELECTION, id: 'vivi-model', height: 1, flexShrink: 0,
        width: '100%', fg: TUI_THEME.muted, attributes: TextAttributes.DIM, wrapMode: 'none', selectable: false,
        onMouse: event => this.handleFooterMouse(event) })
      this.hover.bind(this.modelLine, () => this.pending?.kind === 'chat' && !this.cancelCallbacks.size &&
        this.ready() && this.lastRenderedFrame > this.footerChangedFrame, point => {
        const target = this.footerTargets.find(target => point.x >= target.start && point.x < target.end)
        return target ? { x: target.start, y: 0, width: target.end - target.start, height: 1 } : undefined
      })
      this.footer = new BoxRenderable(renderer, { id: 'vivi-footer', height: 1, flexShrink: 0,
        width: '100%', flexDirection: 'row' })
      this.workspaceLine = new TextRenderable(renderer, { ...TEXT_SELECTION, id: 'vivi-workspace', height: 1, flexShrink: 0,
        fg: TUI_THEME.muted, attributes: TextAttributes.DIM, wrapMode: 'none', visible: false })
      this.actionBar = new BoxRenderable(renderer, { id: 'vivi-actions', height: 1, flexShrink: 0,
        flexDirection: 'row', visible: false })
      {
        const menu = this.mouseButton('vivi-action-menu', '/ menu', () => {
          const pending = this.pending
          if (pending?.kind === 'chat' && !this.composerText) pending.finish('/menu')
          else this.updateStatus('Finish or clear your draft before opening an action')
        })
        menu.fg = TUI_THEME.muted
        menu.bg = TUI_THEME.background
        menu.attributes = TextAttributes.DIM
        this.actionBar.add(menu)
      }
      this.transcript = new ScrollBoxRenderable(renderer, { id: 'vivi-transcript', flexGrow: 1,
        minHeight: 1, width: '100%', scrollX: false, scrollY: true, stickyScroll: true,
        stickyStart: 'bottom', contentOptions: { flexDirection: 'column', paddingX: 1 },
        viewportCulling: true })
      this.statusLine = new TextRenderable(renderer, { ...TEXT_SELECTION, id: 'vivi-status', width: '100%', height: 1, flexShrink: 0,
        fg: TUI_THEME.muted, attributes: TextAttributes.DIM, wrapMode: 'word', content: this.status, visible: false })
      this.shellNotice = new TextRenderable(renderer, { ...TEXT_SELECTION, id: 'vivi-shell-notice', width: '100%',
        flexShrink: 0, content: USER_SHELL_DISCLOSURE, fg: TUI_THEME.foreground, wrapMode: 'word', visible: false })
      this.composerBox = new BoxRenderable(renderer, { id: 'vivi-composer-box', height: 3,
        flexShrink: 0, border: ['top', 'bottom'], borderColor: TUI_THEME.pink, titleColor: TUI_THEME.pink,
        paddingX: 1 })
      this.copyToast = new TextRenderable(renderer, { id: 'vivi-copy-toast', content: ' Copied! ',
        position: 'absolute', right: 0, top: -2, width: 9, height: 1, zIndex: 1,
        fg: TUI_THEME.highlightForeground, bg: TUI_THEME.selectedBackground,
        selectable: false, visible: false, wrapMode: 'none' })
      this.composerBox.add(this.copyToast)
      this.composer = new TextareaRenderable(renderer, { id: 'vivi-composer', width: '100%', height: 1,
        wrapMode: 'word', placeholder: COMPOSER_PLACEHOLDER, backgroundColor: TUI_THEME.background,
        textColor: TUI_THEME.foreground, focusedBackgroundColor: TUI_THEME.background,
        focusedTextColor: TUI_THEME.foreground, placeholderColor: TUI_THEME.muted,
        ...TEXT_SELECTION, cursorColor: TUI_THEME.lavender,
        keyBindings: ['return', 'kpenter', 'linefeed'].flatMap((name) => [
          { name, action: 'submit' as const }, { name, shift: true, action: 'newline' as const },
          { name, meta: true, action: 'newline' as const }
        ]), onSubmit: () => this.submit(), onContentChange: () => this.inputChanged() })
      this.composer.onMouse = (event) => {
        if (event.type === 'down' && event.button === 0 && this.ready() &&
          (!this.cancelCallbacks.size || this.pending?.kind === 'steering') &&
          ['chat', 'steering', 'text', 'search'].includes(this.pending!.kind)) this.composer.focus()
      }
      this.pastes = new ComposerPastes(this.composer)
      this.imagePreviews = new BoxRenderable(renderer, { id: 'vivi-pasted-images', height: 4,
        flexShrink: 0, flexDirection: 'row', visible: false })
      this.composerBox.add(this.imagePreviews)
      this.composerBox.add(this.composer)
      this.secretMask = new TextRenderable(renderer, { ...TEXT_SELECTION, id: 'vivi-secret-mask', width: '100%', height: 2,
        visible: false, content: '', fg: TUI_THEME.lavender, wrapMode: 'none' })
      this.composerBox.add(this.secretMask)
      this.completionBox = new BoxRenderable(renderer, { id: 'vivi-completions', visible: false,
        flexDirection: 'column', height: 6, flexShrink: 0, border: true, borderColor: TUI_THEME.lavender,
        titleColor: TUI_THEME.lavender, title: 'Commands · ↑/↓ choose · Enter run · Tab fill', paddingX: 1 })
      this.completionList = new TextRenderable(renderer, { ...TEXT_SELECTION, id: 'vivi-completion-list', width: '100%',
        height: '100%', fg: TUI_THEME.lavender, wrapMode: 'none' })
      this.completionList.selectable = false
      this.completionList.onMouse = (event) => this.handleCompletionMouse(event)
      this.hover.bind(this.completionList, () => this.ready() && this.pending?.kind === 'chat' &&
        this.lastRenderedFrame > this.completionChangedFrame, point => {
        const rows = this.completionBox.height - 2
        const first = Math.min(Math.max(0, this.completionIndex - rows + 1), this.completions.length - rows)
        return this.completions[first + point.y]
          ? { x: 0, y: point.y, width: this.completionList.width, height: 1 } : undefined
      })
      this.completionBox.add(this.completionList)
      this.hintLine = new TextRenderable(renderer, { ...TEXT_SELECTION, id: 'vivi-hints', height: 1, flexShrink: 0,
        fg: TUI_THEME.muted, attributes: TextAttributes.DIM, content: HINTS, wrapMode: 'none' })
      this.pickerBox = new BoxRenderable(renderer, { id: 'vivi-picker-box', visible: false,
        height: 8, flexShrink: 0, flexDirection: 'column', border: true, borderColor: TUI_THEME.lavender,
        titleColor: TUI_THEME.lavender, paddingX: 1 })
      this.steeringQueueLine = new TextRenderable(renderer, { ...TEXT_SELECTION, id: 'vivi-steering-queue',
        width: '100%', height: 1, flexShrink: 0, visible: false, fg: TUI_THEME.lavender, wrapMode: 'none' })
      this.steeringActions = new BoxRenderable(renderer, { id: 'vivi-steering-actions', width: 0,
        height: 1, flexShrink: 0, flexDirection: 'row', gap: 1, visible: false })
      this.processBar = new BoxRenderable(renderer, { id: 'vivi-processes', width: '100%', height: 1,
        flexShrink: 0, flexDirection: 'row', gap: 1, visible: false })
      this.processLabel = new TextRenderable(renderer, { ...TEXT_SELECTION, id: 'vivi-process-label',
        height: 1, flexGrow: 1, minWidth: 0, fg: TUI_THEME.attention, wrapMode: 'none' })
      this.processBar.add(this.processLabel)
      for (const [id, label, action] of [
        ['vivi-process-next', 'Next', () => this.selectNextProcess()],
        ['vivi-process-stop', 'Stop F6', () => this.stopProcess(false)],
        ['vivi-process-stop-all', 'Stop All F7', () => this.stopProcess(true)]
      ] as const) {
        const button = new TextRenderable(renderer, { ...TEXT_SELECTION, id, content: ` ${label} `,
          width: label.length + 2, height: 1, flexShrink: 0, fg: TUI_THEME.lavender,
          bg: TUI_THEME.selectedBackground, wrapMode: 'none' })
        button.selectable = false
        button.onMouse = event => this.mouseActivation.handle(event, button, id, this.processGesture,
          !this.closed && !!this.processControls && this.processBar.visible, action)
        this.hover.bind(button, () => !this.closed && !!this.processControls && this.processBar.visible)
        this.processBar.add(button)
      }
      this.footer.add(this.modelLine); this.footer.add(this.actionBar); this.footer.add(this.steeringActions)
      for (const child of [this.headerBox, this.workspaceLine, this.transcript, this.statusLine, this.pickerBox,
        this.completionBox, this.steeringQueueLine, this.shellNotice, this.composerBox, this.processBar, this.footer, this.hintLine]) this.shell.add(child)
      this.loadingBox = new BoxRenderable(renderer, { id: 'vivi-loading', position: 'absolute', top: 0, left: 0,
        width: '100%', height: '100%', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1, visible: false })
      this.loadingBox.add(new TextRenderable(renderer, { id: 'vivi-loading-title', content: 'vivi', height: 1,
        width: '100%', textAlign: 'center', fg: TUI_THEME.lavender }))
      this.loadingLine = new TextRenderable(renderer, { id: 'vivi-loading-stage', height: 1, width: '100%',
        textAlign: 'center', fg: TUI_THEME.foreground, wrapMode: 'none' })
      this.loadingBox.add(this.loadingLine)
      this.loadingBox.add(new TextRenderable(renderer, { id: 'vivi-loading-hint', content: 'Ctrl+C to exit', height: 1,
        width: '100%', textAlign: 'center', fg: TUI_THEME.muted, attributes: TextAttributes.DIM }))
      renderer.root.add(this.loadingBox)
      if (options.loading) this.setLoading('Starting vivi…')
      this.updateHeader(); this.updateActionBar()
      this.disableComposer()
      renderer.keyInput.on('keypress', this.keyHandler)
      renderer.keyInput.on('paste', this.pasteHandler)
      renderer.on(CliRenderEvents.RESIZE, this.resizeHandler)
      renderer.on(CliRenderEvents.FRAME, this.frameHandler)
      renderer.on(CliRenderEvents.BLUR, this.blurHandler)
      renderer.on(CliRenderEvents.FOCUS, this.focusHandler)
      renderer.on(CliRenderEvents.SELECTION, this.selectionHandler)
      renderer.on(CliRenderEvents.RENDER_ERROR, this.errorHandler)
      renderer.on(CliRenderEvents.HANDLER_ERROR, this.errorHandler)
      process.on('SIGINT', this.signalHandler)
      process.on('SIGTERM', this.exitHandler)
      process.on('SIGHUP', this.exitHandler)
      process.on('exit', this.processExitHandler)
      this.updateTerminalTitle()
    } catch (error) {
      // Construction can fail before a widget is attached to the renderer's root.
      // Destroy detached widgets too; renderer.destroy only owns attached children.
      for (const widget of [this.composer, this.secretMask, this.completionList, this.header,
        this.transcript, this.statusLine, this.shellNotice, this.copyToast, this.composerBox, this.completionBox,
        this.pickerBox, this.hintLine, this.actionBar, this.tokenLine, this.headerBox,
        this.modelLine, this.workspaceLine, this.steeringQueueLine, this.steeringActions, this.processBar, this.footer, this.shell, this.loadingBox]) {
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
    let terminalTitle: TerminalTitleController | undefined
    let programStatus: TerminalProgramStatus | undefined
    let io: OpenTuiIO | undefined
    let clipboard: OpenTuiOptions['clipboard']
    const windowsInput = process.platform === 'win32' && process.stdin.isTTY
      ? createWindowsInputBridge(process.stdin, text => { process.stdout.write(text) }, () => {
        renderer?.emit(CliRenderEvents.HANDLER_ERROR, { error: new Error('Windows console input failed') })
      }) : undefined
    // The official factory rolls back a failed async terminal setup.
    try {
      renderer = await createCliRenderer({ exitOnCtrlC: false, exitSignals: [],
        // Unlike DESTROY, the supported callback follows native output cleanup,
        // including a destruction request deferred until the current render ends.
        onDestroy: () => { if (io) io.restoreTerminalTitle(); else { terminalTitle?.close(); programStatus?.close() } },
        ...(windowsInput ? { stdin: windowsInput.stdin } : {}),
        screenMode: 'alternate-screen', consoleMode: 'disabled', openConsoleOnError: false,
        externalOutputMode: 'passthrough', useKittyKeyboard: { disambiguate: true, alternateKeys: true },
        useMouse: true, backgroundColor: TUI_THEME.background })
      if (windowsInput?.failure) throw windowsInput.failure
      const titleSink = options.terminalTitle ?? createTerminalTitleSink(title => renderer!.setTerminalTitle(title), process.stdout, process.env.TERM)
      terminalTitle = new TerminalTitleController(titleSink)
      programStatus = new TerminalProgramStatus(options.programStatus ?? createProgramStatusSink(process.stdout, options.statusEnvironment), !options.oneShot)
      clipboard = options.clipboard ?? createClipboard({ host: createHostClipboard(), terminal: createRendererClipboardAdapter(renderer) })
      io = new OpenTuiIO(renderer, { ...options, loading: true, clipboard }, terminalTitle, programStatus)
      io.windowsInput = windowsInput
      windowsInput?.start()
      if (options.promptHistoryStore && options.promptHistory === undefined) {
        io.setLoading('Loading prompt history…')
        try { io.promptHistory = new PromptHistory<ComposerDraft>(await options.promptHistoryStore.load()) }
        catch { io.updateStatus('Saved prompt history unavailable; history works for this launch') }
      }
      return io
    } catch (error) {
      if (!io) void clipboard?.dispose().catch(() => undefined)
      try { windowsInput?.close() } finally {
        if (renderer && !renderer.isDestroyed) renderer.destroy()
        if (!renderer || renderer.isDestroyed) programStatus?.close()
      }
      throw error
    }
  }

  get failed(): boolean { return this.failure !== undefined }
  get isClosed(): boolean { return this.closed }
  get canAutoReview(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY && !this.closed && !this.failed && !this.renderer.isDestroyed)
  }
  get canAskQuestions(): boolean { return this.canAutoReview }
  readonly compactStartup = true
  setLoading(message?: string): void {
    if (this.closed) return
    if (message === undefined && this.loadingMessage === undefined) return
    this.loadingMessage = message === undefined ? undefined : this.safe(message, 256)
    this.loadingBox.visible = message !== undefined
    this.shell.visible = message === undefined
    this.hover.clear(); this.mouseActivation.clear()
    if (message === undefined) {
      if (this.loadingTimer !== undefined) clearInterval(this.loadingTimer)
      this.loadingTimer = undefined
    } else {
      this.composer.blur()
      this.renderLoading()
      this.loadingTimer ??= setInterval(() => { this.loadingFrame++; this.renderLoading() }, 100)
      this.loadingTimer.unref?.()
    }
    this.updateTerminalTitle()
  }
  private renderLoading(): void {
    if (this.closed || this.loadingMessage === undefined) return
    const spinner = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'[this.loadingFrame % 10]
    this.loadingLine.content = fitStatusColumns(`${spinner} ${this.loadingMessage}`, Math.max(1, this.renderer.terminalWidth), true)
  }
  setApprovalMode(mode: ApprovalMode): void { this.approvalMode = mode; this.updateHeader() }
  setTaskMode(mode: TaskMode): void { this.taskMode = mode; this.updateHeader() }

  /** Explicit offline probe. No editable text, provider or session is opened. */
  async diagnoseInput(): Promise<InputDiagnosticReport> {
    this.setLoading()
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
    this.liveErrors = this.liveErrors.map(error => ({ ...error, message: this.safe(error.message) }))
    if (this.conversationErrors) this.conversationErrors = { ...this.conversationErrors,
      errors: this.conversationErrors.errors.map(error => ({ ...error, message: this.safe(error.message) })) }
    this.reviewNotices = this.reviewNotices.map(redactEntry)
    this.sessionTitle = this.safe(this.sessionTitle, 4096)
    this.sessionProvider = this.safe(this.sessionProvider, 4096)
    this.sessionModel = this.safe(this.sessionModel, 4096)
    this.sessionEffort = this.safe(this.sessionEffort, 256)
    this.updateHeader()
    this.composerBox.title = this.safe(this.composerBox.title ?? '', 4096)
    this.pickerBox.title = this.safe(this.pickerBox.title ?? '', 4096)
    if (this.picker) this.picker.options = this.picker.options.map((option) => ({ ...option,
      name: this.safe(option.name, 1024), description: this.safe(option.description, 2048) }))
    this.inputChanged()
    this.questionDialog?.redact()
    this.controls?.redact()
    this.rebuild()
    this.updateSteeringQueue()
    this.updateStatus()
  }

  private safe(text: string, limit = MAX_DISPLAY): string {
    const redacted = redactSecrets(stripControls(text), this.secrets)
    // Labels, summaries and late credential registration use the same complete
    // encoded-credential screen as cards; clipping cannot hide a private suffix.
    const safe = mcpContainsSecret(redacted, this.secrets) ? '[Display content withheld: known credential]' : redacted
    const notice = '\n[display truncated]'
    // A truncation notice is part of this exact body budget, not an extra tail
    // that can evict an otherwise admitted final answer during aggregate trim.
    return safe.length > limit ? limit >= notice.length
      ? `${safe.slice(0, limit - notice.length)}${notice}` : safe.slice(0, Math.max(0, limit)) : safe
  }
  private ready(pending = this.pending): boolean {
    return !!pending?.armed && !this.closed &&
      (!['approval', 'question', 'steering', 'control'].includes(pending.kind) || this.lastRenderedFrame > pending.openedFrame)
  }
  private updateApprovalLayout(): void {
    if (this.closed) return
    if (this.pending?.kind === 'approval') this.pickerBox.bottomTitle = this.renderer.terminalHeight < 10 ? '↑↓ · Enter · Esc' : undefined
    this.updateHeader()
  }
  private updateActionBar(): void {
    if (this.closed) return
    if (this.actionBar) this.actionBar.visible = this.pending?.kind === 'chat' &&
      !this.cancelCallbacks.size && this.renderer.terminalWidth >= 24 && this.renderer.terminalHeight >= 6
    // One menu entry shares the metadata row; dialogs retain their own shortcuts.
    this.updateFooter()
    this.updateComposerLayout()
  }
  private updateFooter(): void {
    if (this.closed || !this.footer) return
    const columns = Math.max(1, this.renderer.terminalWidth)
    const steering = this.pending?.kind === 'steering' && this.steering !== undefined
    const draft = this.composerText.trim().length > 0
    this.steeringHasDraft = draft
    const queue = this.steeringQueue.length > 0
    this.steeringActions.visible = steering && columns >= 24
    const actions = this.steeringActions.getChildren() as TextRenderable[]
    for (const action of actions) {
      action.visible = action.id === 'vivi-steering-hint' ? (!draft && (!queue || columns < 72) || columns >= 100)
        : action.id === 'vivi-steering-interrupt' ? draft : queue && columns >= 72
    }
    const visible = actions.filter(action => action.visible)
    const steeringWidth = this.steeringActions.visible
      ? visible.reduce((width, action) => width + statusTextColumns(action.plainText), 0) + Math.max(0, visible.length - 1) : 0
    this.steeringActions.width = steeringWidth
    const menuWidth = this.actionBar.visible ? 8 : 0
    const controls = menuWidth + steeringWidth
    this.footerRows = 1
    this.footer.height = 1
    this.footer.visible = this.pending?.kind !== 'question' || this.renderer.terminalHeight > 15
    this.hintLine.visible = this.pending !== undefined && !this.actionBar.visible && this.pending.kind !== 'chat' && this.pending.kind !== 'steering' && this.pending.kind !== 'control' &&
      !(this.pending.kind === 'question' && this.renderer.terminalHeight <= 15) &&
      !(this.pending.kind === 'approval' && this.renderer.terminalHeight < 10)
    this.actionBar.width = menuWidth
    this.modelLine.visible = this.footer.visible
    const width = Math.max(1, columns - controls)
    this.modelLine.width = width
    const mode = conversationModeLabel(this.taskMode, this.approvalMode)
    const modelWidth = width - statusTextColumns(` · ${mode}`)
    const providerPrefix = `${this.sessionProvider} · `
    const metadata = `${providerPrefix}${this.sessionModel}${this.sessionEffort ? ` · ${this.sessionEffort}` : ''}${this.sessionPlan ? ' · ChatGPT plan' : ''}`
    const displayed = modelWidth > 0 ? fitStatusColumns(metadata, modelWidth, true) : ''
    const content = modelWidth > 0 ? `${displayed} · ${mode}` : fitStatusColumns(mode, width, true)
    if (this.modelLine.plainText !== content) this.footerChangedFrame = this.renderer.frameId
    this.modelLine.content = content
    // Visible provider, model, effort and mode cells open their settings. Separators,
    // truncation markers and unused space stay inactive.
    const visibleWidth = this.footerColumns(displayed.replace(/…$/, ''))
    const providerEnd = this.footerColumns(this.sessionProvider)
    const modelStart = this.footerColumns(providerPrefix)
    const modelEnd = modelStart + this.footerColumns(this.sessionModel)
    const effortStart = modelEnd + this.footerColumns(' · ')
    this.footerTargets = [
      { start: 0, end: Math.min(providerEnd, visibleWidth), command: '/provider' },
      { start: modelStart, end: Math.min(modelEnd, visibleWidth), command: '/models' }
    ]
    if (this.sessionEffort) this.footerTargets.push({ start: effortStart,
      end: Math.min(effortStart + this.footerColumns(this.sessionEffort), visibleWidth), command: '/effort' })
    this.footerTargets.push({ start: modelWidth > 0 ? this.footerColumns(`${displayed} · `) : 0,
      end: this.footerColumns(content.replace(/…$/, '')), command: '/mode' })
  }
  private footerColumns(text: string): number {
    if (/^[\x20-\x7e]*$/.test(text)) return text.length
    const lib = resolveRenderLib(), encoded = lib.encodeUnicode(text, this.renderer.widthMethod)
    if (!encoded) return 0
    try { return encoded.data.reduce((width, cell) => width + cell.width, 0) }
    finally { lib.freeUnicode(encoded) }
  }
  private handleFooterMouse(event: MouseEvent): void {
    const pending = this.pending
    const cell = event.x - this.modelLine.x
    const target = this.footerTargets.find(target => cell >= target.start && cell < target.end)
    this.mouseActivation.handle(event, this.modelLine, `${target?.command}:${this.modelLine.plainText}`, pending,
      !!target && pending?.kind === 'chat' && !this.cancelCallbacks.size && this.ready(pending) &&
      this.lastRenderedFrame > this.footerChangedFrame, () => {
        this.saveComposerDraft()
        pending!.finish(target!.command)
      })
  }
  private updateChoiceLayout(): void {
    if (this.pending?.kind !== 'choice' || !this.picker) return
    const fixedRows = this.headerRows + Number(this.workspaceLine.visible) + 1 + Number(this.statusLine.visible) +
      Number(this.processBar.visible) + (this.footer.visible ? this.footerRows : 0) + Number(this.hintLine.visible)
    const height = Math.max(3, Math.min(10, this.renderer.terminalHeight - fixedRows - 1,
      this.picker.options.length * 2 + 2 + (this.dialogActions ? 1 : 0)))
    this.pickerBox.height = height
    // Renderable.height reflects the preceding Yoga layout until the next frame.
    this.picker.showDescription = height - 2 - (this.dialogActions ? 1 : 0) >= 2
  }
  private updateComposerLayout(): void {
    if (!this.composer || !this.composerBox || this.closed) return
    const kind = this.pending?.kind
    const multiline = kind === 'chat' || kind === 'steering' || kind === 'text'
    const shell = (kind === 'chat' || kind === 'steering') && parseUserShellInput(this.composerText) !== undefined
    if (this.shellNotice.visible !== shell) this.shellNotice.visible = shell
    if (shell) {
      const disclosure = this.renderer.terminalHeight < 20
        ? 'Runs unsandboxed as your OS account. Send approves. Output is saved and sent to your provider. /session for details.'
        : USER_SHELL_DISCLOSURE
      if (this.shellNotice.plainText !== disclosure) this.shellNotice.content = disclosure
    }
    const simple = (kind === undefined || kind === 'chat' || kind === 'steering' || kind === 'control') && !shell
    const border = this.composerBox.border
    if (simple ? !Array.isArray(border) || border.length !== 2 || border[0] !== 'top' || border[1] !== 'bottom' : border !== true) {
      this.composerBox.border = simple ? ['top', 'bottom'] : true
    }
    if (simple && this.composerBox.title !== undefined) this.composerBox.title = undefined
    // Measure wrapped terminal cells using the same native editor as the draft.
    // Its current viewport only counts visible lines, so measuring the complete
    // buffer is essential for both explicit newlines and long wrapped lines.
    const width = Math.max(1, this.renderer.terminalWidth - (simple ? 2 : 4))
    const measured = simple && !this.composerText ? 1
      : multiline || simple ? this.composer.editorView.measureForDimensions(width, 65536)?.lineCount : 2
    const otherRows = this.shell.getChildren().reduce((rows, child) => child.visible &&
      child !== this.transcript && child !== this.composerBox ? rows + Number(child.height) : rows, 0)
    // Keep a transcript viewport and leave bounded drafts scrollable. Tiny
    // terminals retain an editable row without reserving empty input lines.
    this.updateImagePreviews()
    const previewRows = this.imagePreviews.visible ? Math.min(4, Math.max(0, this.renderer.terminalHeight - otherRows - 5)) : 0
    this.imagePreviews.height = previewRows
    const maximum = Math.max(1, Math.min(10, this.renderer.terminalHeight - otherRows - previewRows - 4))
    const height = multiline || simple ? Math.min(maximum, Math.max(simple || shell ? 1 : 2, measured ?? this.composer.lineCount)) : Math.min(2, maximum)
    if (this.composer.height !== height) this.composer.height = height
    if (this.composerBox.height !== height + previewRows + 2) this.composerBox.height = height + previewRows + 2
  }
  private mouseButton(id: string, label: string, activate: () => void): TextRenderable {
    const button = new TextRenderable(this.renderer, { ...TEXT_SELECTION, id, content: ` ${label} `, width: label.length + 2,
      height: 1, flexShrink: 0, fg: TUI_THEME.lavender, bg: TUI_THEME.selectedBackground, wrapMode: 'none' })
    button.selectable = false
    button.onMouse = (event) => {
      const pending = this.pending
      this.mouseActivation.handle(event, button, id, pending, this.ready(pending) &&
        (!this.cancelCallbacks.size || pending?.kind !== 'chat') &&
        (id !== 'vivi-approve' || performance.now() >= this.approvalMouseNotBefore), activate)
    }
    this.hover.bind(button, () => {
      const pending = this.pending
      return this.ready(pending) && (!this.cancelCallbacks.size || pending?.kind !== 'chat') &&
        (id !== 'vivi-approve' || performance.now() >= this.approvalMouseNotBefore) &&
        (id !== 'vivi-confirm' || !['choice', 'search'].includes(pending?.kind ?? '') ||
          !!this.picker?.options.length && this.picker.getSelectedOption()?.value !== -1)
    })
    return button
  }
  private renderDialogActions(): void {
    this.mouseActivation.clear()
    if (this.dialogActions) { this.dialogActions.destroyRecursively(); this.dialogActions = undefined }
    const pending = this.pending
    if (!pending || pending.kind === 'chat' || pending.kind === 'question' || pending.kind === 'steering') return
    // Preserve room for the query in very small terminals; keyboard paths remain.
    if (pending.kind !== 'approval' && this.renderer.terminalHeight < (pending.kind === 'search' ? 20 : 16)) return
    this.dialogActions = new BoxRenderable(this.renderer, { id: 'vivi-dialog-actions', height: pending.kind === 'approval' ? 2 : 1,
      width: '100%', flexShrink: 0, flexDirection: pending.kind === 'approval' ? 'column' : 'row', gap: pending.kind === 'approval' ? 0 : 1 })
    const add = (id: string, label: string, activate: () => void): void => {
      const button = this.mouseButton(id, label, activate)
      if (pending.kind === 'approval') {
        const selected = id === (this.approvalIndex === 1 ? 'vivi-approve' : 'vivi-deny')
        button.width = '100%'
        button.fg = selected ? TUI_THEME.highlightForeground : TUI_THEME.foreground
        button.bg = selected ? TUI_THEME.selectedBackground : TUI_THEME.background
        const row = new BoxRenderable(this.renderer, { id: `${id}-row`, width: '100%', height: 1,
          flexShrink: 0, backgroundColor: button.bg })
        row.add(button)
        this.dialogActions!.add(row)
      } else this.dialogActions!.add(button)
    }
    if (pending.kind === 'approval') {
      const labels = pending.approvalLabels ?? { deny: 'Deny', allow: 'Approve' }
      add('vivi-approve', `${this.approvalIndex === 1 ? '›' : ' '} ${labels.allow}`, () => {
        // Mouse protocols have no cross-dialog click identity. Treat a rapid second
        // click as part of the first gesture, never approval of the next proposal.
        this.approvalMouseNotBefore = performance.now() + APPROVAL_REPEAT_WINDOW_MS
        pending.finish('allow')
      })
      add('vivi-deny', `${this.approvalIndex === 0 ? '›' : ' '} ${labels.deny}`, () => pending.finish('deny'))
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
    if (pending.kind === 'search' && this.searchPicker?.query !== this.composerText) this.inputChanged()
    if (event.type === 'scroll') {
      this.mouseActivation.clear()
      event.preventDefault(); event.stopPropagation()
      if (this.ready() && event.scroll && ['up', 'down'].includes(event.scroll.direction)) {
        if (event.scroll.direction === 'up') picker.moveUp()
        else picker.moveDown()
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
  private bindPickerHover(picker: SelectRenderable): void {
    this.hover.bind(picker, () => this.ready() && this.lastRenderedFrame > this.pickerChangedFrame &&
      (this.pending?.kind === 'choice' || this.pending?.kind === 'search'), point => pickerHoverRegion(picker, point))
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
    this.mouseActivation.handle(event, this.completionList, `${index}:${item?.command}:${this.composerText}`,
      this.pending, this.ready() && this.lastRenderedFrame > this.completionChangedFrame && this.pending?.kind === 'chat' && !!item, () => this.acceptCompletion(index))
  }
  private updateStatus(status = this.status): void {
    if (this.closed) return
    this.status = this.safe(status, 1024)
    const columns = Math.max(1, this.renderer.terminalWidth)
    const run = this.runStatus.label
    const detail = this.pending?.kind === 'steering' && this.steeringMessage ? ` · ${this.steeringMessage}`
      : this.status.startsWith('Tool running:') ? ` · ${this.status}` : ''
    const summary = run === undefined ? this.status : `${run}${detail}`
    this.statusLine.content = fitStatusColumns(summary.replace(/[\t\n]+/g, ' '), columns)
    this.statusLine.visible = summary !== 'Ready'
    this.updateHeader()
    this.updateComposerLayout()
    this.updateTerminalTitle()
  }
  private updateTerminalTitle(): void {
    if (this.closed) return
    const input = this.pending !== undefined && ['text', 'secret', 'approval', 'choice', 'search', 'question', 'control'].includes(this.pending.kind)
    this.programStatus.setBlocked(input ? this.pending!.kind === 'approval' ? 'permission'
      : this.pending!.kind === 'secret' ? 'auth' : 'question' : undefined)
    this.terminalTitle.update(this.sessionTitle, input ? 'input'
      : this.loadingMessage !== undefined || this.runStatus.running || this.cancelCallbacks.size ? 'working' : 'idle', this.secrets)
  }
  private updateHeader(): void {
    if (this.closed || !this.headerBox) return
    const columns = Math.max(1, this.renderer.terminalWidth)
    const context = formatContextStatus(this.contextUsage)
    const usage = this.contextUsage
    const capacity = Math.min(usage?.maxInputTokens ?? Infinity,
      usage?.contextWindow === undefined ? Infinity : usage.contextWindow - usage.outputReserveTokens)
    const showContext = this.historyLength > 0 || (usage !== undefined && capacity > 0 && usage.inputTokens >= capacity * 0.8)
    const contextColumns = showContext ? statusTextColumns(context) : 0
    // Keep the request occupancy in the top-right corner. Narrow terminals put
    // it on its own row rather than clipping a number or hiding unknown capacity.
    const shared = !showContext || columns >= contextColumns + 20 || this.renderer.terminalHeight < 14
    const tokenWidth = Math.min(columns, contextColumns)
    const titleWidth = shared ? Math.max(0, columns - tokenWidth - Number(showContext)) : columns
    const gap = shared && titleWidth > 0 && showContext ? 1 : 0
    this.headerBox.flexDirection = shared ? 'row' : 'column'
    this.headerRows = shared ? 1 : 2
    this.headerBox.height = this.headerRows
    this.headerBox.gap = gap
    this.header.visible = titleWidth > 0
    this.header.width = titleWidth
    this.header.content = fitStatusColumns(this.sessionTitle === 'Untitled conversation' ? 'vivi' : this.sessionTitle, titleWidth, true)
    const contextWidth = shared ? Math.max(1, columns - titleWidth - gap) : columns
    this.tokenLine.width = contextWidth
    this.tokenLine.visible = showContext
    this.tokenLine.content = contextColumns <= contextWidth ? context : contextWidth >= 9 ? 'Context ?' : '…'
    this.workspaceLine.visible = this.workspaceStatus && this.renderer.terminalHeight >= 14 && this.pending?.kind !== 'question'
    this.workspaceLine.width = columns
    const directory = this.workspaceDirectory
    const home = homedir()
    const inHome = directory !== undefined && (process.platform === 'win32' ? directory.toLowerCase() : directory)
      .startsWith((process.platform === 'win32' ? home.toLowerCase() : home) + (process.platform === 'win32' ? '\\' : '/'))
    const folder = directory === home ? '~' : inHome ? `~${directory!.slice(home.length)}` : directory
    this.workspaceLine.content = fitStatusColumns(this.safe(folder ?? 'Workspace disabled', 65536), columns)
    this.updateFooter()
    this.updateTerminalTitle()
  }
  /** Only an actual agent turn opts into editable, owner-scoped steering. */
  onSteering(controls: SteeringControls): () => void {
    if (this.closed) return () => undefined
    if (this.steering) this.releaseSteering(this.steering)
    if (this.pending?.kind === 'chat') this.pending.finish(undefined)
    const steering: SteeringInput = { controls, draft: this.nextComposerDraft, pasteDraft: this.nextPasteDraft }
    this.nextPasteDraft = undefined
    this.nextComposerDraft = ''
    this.steering = steering
    if (!this.pending) this.restoreSteering(steering)
    return () => this.releaseSteering(steering)
  }
  private releaseSteering(steering: SteeringInput): void {
    if (this.steering !== steering) return
    const editing = this.pending === steering.pending && steering.pending !== undefined
    const draft = editing ? this.composerText : steering.draft
    if (draft) {
      this.nextComposerDraft = this.safe(draft, MAX_INPUT)
      this.nextPasteDraft = editing ? this.pastes.snapshot() : steering.pasteDraft
    }
    if (steering.timer !== undefined) clearTimeout(steering.timer)
    this.steering = undefined
    this.steeringMessage = undefined
    this.mouseActivation.clear()
    if (editing) {
      this.pending = undefined
      this.clearInput()
      this.disableComposer()
      this.composerBox.title = 'Message'
      this.hintLine.content = HINTS
    }
    for (const child of this.steeringActions.getChildren()) child.destroyRecursively()
    this.steeringActions.visible = false
    this.updateActionBar()
    this.updateSteeringQueue()
  }
  private restoreSteering(steering: SteeringInput): void {
    if (this.closed || this.steering !== steering || this.pending) return
    this.mouseActivation.clear()
    this.clearInput()
    const pending: PendingInput = { kind: 'steering', armed: false, openedFrame: this.renderer.frameId,
      finish: () => undefined }
    steering.pending = pending
    this.pending = pending
    this.steeringMessage = undefined
    this.composerBox.visible = true
    this.composer.visible = true
    this.secretMask.visible = false
    this.composerBox.title = undefined
    this.composerBox.bottomTitle = undefined
    this.composer.placeholder = COMPOSER_PLACEHOLDER
    this.composer.setText(this.safe(steering.draft, MAX_INPUT))
    if (steering.pasteDraft) this.pastes.restore(steering.pasteDraft)
    this.inputChanged()
    this.composer.gotoBufferEnd()
    this.composer.traits = {}
    this.composer.showCursor = true
    this.composer.focus()
    for (const child of this.steeringActions.getChildren()) child.destroyRecursively()
    const live = (activate: () => void): (() => void) => () => {
      if (this.steering === steering && this.pending === pending && this.ready(pending)) activate()
    }
    this.steeringActions.add(new TextRenderable(this.renderer, { ...TEXT_SELECTION, id: 'vivi-steering-hint',
      content: ' Enter queues ', width: 14, height: 1, flexShrink: 0, fg: TUI_THEME.muted,
      attributes: TextAttributes.DIM, wrapMode: 'none' }))
    this.steeringActions.add(this.mouseButton('vivi-steering-interrupt', 'Interrupt & send', live(() => this.submitSteering(true))))
    this.steeringActions.add(this.mouseButton('vivi-steering-undo', 'Undo latest', live(() => this.editLatestSteering())))
    this.steeringActions.add(this.mouseButton('vivi-steering-clear', 'Clear', live(() => steering.controls.clear())))
    for (const action of this.steeringActions.getChildren() as TextRenderable[]) {
      action.fg = TUI_THEME.muted
      action.bg = TUI_THEME.background
      action.attributes = TextAttributes.DIM
    }
    this.updateActionBar()
    this.updateSteeringQueue()
    // A run or modal replacement drains the previous input batch before accepting
    // new keys, and needs a completed frame before any submit/click is enabled.
    steering.timer = setTimeout(() => {
      if (this.steering === steering && this.pending === pending && !this.closed) pending.armed = true
    }, 0)
  }
  setSteeringQueue(messages: readonly SteeringMessage[]): void {
    if (this.closed) return
    // The host owns IDs/order and queue admission. This is only a bounded preview.
    this.steeringQueue = messages.slice(0, 32).map(message => ({ ...message }))
    this.mouseActivation.clear()
    this.updateSteeringQueue()
  }
  private updateSteeringQueue(): void {
    if (this.closed || !this.steeringQueueLine) return
    const columns = Math.max(1, this.renderer.terminalWidth)
    const modal = this.pending && this.pending.kind !== 'chat' && this.pending.kind !== 'steering'
    const previews = modal || this.renderer.terminalHeight < 16 ? 0 : Math.min(3, this.steeringQueue.length)
    const first = this.steeringQueue.length - previews
    const lines = [`Queued · ${this.steeringQueue.length} · next safe boundary`]
    if (first > 0 && previews) lines[0] += ` · ${first} earlier`
    for (let index = first; index < this.steeringQueue.length; index++) {
      const content = this.safe(this.steeringQueue[index]!.content).replace(/[\t\n]+/g, ' ')
      const sending = this.steeringQueue[index]!.state === 'sending' ? '[sending] ' : ''
      lines.push(`${index + 1}. ${sending}${fitStatusColumns(content, Math.max(0, columns - 4 - sending.length), true)}`)
    }
    this.steeringQueueLine.content = lines.map(line => fitStatusColumns(line, columns, true)).join('\n')
    this.steeringQueueLine.height = lines.length
    this.steeringQueueLine.visible = this.steeringQueue.length > 0
    this.updateFooter()
    this.updateComposerLayout()
  }
  private editLatestSteering(): void {
    const steering = this.steering
    if (!steering || this.pending !== steering.pending || !this.ready()) return
    if (this.composerText) {
      this.steeringFeedback('Clear your draft before Undo latest')
      return
    }
    const content = steering.controls.takeLast()
    if (content === undefined) {
      if (this.steeringQueue.at(-1)?.state === 'sending') this.steeringFeedback('Latest queued message is sending')
      return
    }
    if (this.steering !== steering || this.pending !== steering.pending) return
    this.composer.setText(this.safe(content, MAX_INPUT))
    this.composer.gotoBufferEnd()
    this.composer.focus()
    this.saveSteeringDraft(steering)
    this.updateComposerLayout()
  }
  private submitSteering(interrupt: boolean): void {
    const steering = this.steering
    if (!steering || this.pending !== steering.pending || !this.ready()) return
    if (this.clipboardRead || this.imagePathRead) { this.steeringFeedback('Reading pasted image...'); return }
    this.inputChanged()
    const content = this.composerText
    if (!content.trim()) { this.steeringFeedback('Write a message first'); return }
    if (!steering.controls.submit(content, interrupt)) {
      if (this.steering === steering) this.steeringFeedback('Message not queued · draft kept')
      return
    }
    this.rememberPrompt(content)
    // Submission only records host queue ownership. The accepted callback below
    // is the sole place a steering message becomes a displayed user message.
    if (this.steering === steering && this.pending === steering.pending) {
      steering.draft = ''
      steering.pasteDraft = undefined
      this.clearInput()
      this.composer.focus()
    }
  }
  private steeringFeedback(message: string): void {
    if (this.pending?.kind === 'steering') this.steeringMessage = this.safe(message, 1024)
    this.updateStatus(message)
  }
  steeringAccepted(content: string, initial = false): void {
    if (this.closed) return
    this.appendEntry({ category: 'user', label: 'You', content: this.safe(content), markdown: false })
    if (!initial) this.liveHistoryIndex++
  }
  private disableComposer(): void {
    this.composer?.blur()
    if (this.composer) {
      this.composer.traits = { suspend: true }
      this.composer.showCursor = false
    }
  }
  private clearInput(): void {
    this.clipboardRead?.abort(); this.clipboardRead = undefined
    this.imagePathRead?.abort(); this.imagePathRead = undefined
    this.imagePathJobs = Promise.resolve()
    this.promptHistory.reset()
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
    if (this.pending?.kind === 'steering' && this.steeringMessage !== undefined) {
      this.steeringMessage = undefined
      this.updateStatus()
    }
    const raw = this.composer.plainText
    const resolved = this.composerText
    if (this.pending?.kind === 'chat' || this.pending?.kind === 'steering') {
      this.composerBox.title = parseUserShellInput(raw) !== undefined
        ? this.pending.kind === 'steering' ? 'Shell · queued after turn · Send approves unsandboxed' : 'Shell · Send approves unsandboxed'
        : undefined
    }
    const safe = this.pending?.kind === 'search'
      ? this.safe(raw, MAX_INPUT).replace(/[\t\n]+/g, ' ').slice(0, MAX_QUERY)
      : this.safe(resolved, MAX_INPUT).slice(0, MAX_INPUT)
    if ((this.pending?.kind === 'search' ? raw : resolved) !== safe) {
      this.changingInput = true
      try { this.composer.setText(safe); this.composer.gotoBufferEnd() }
      finally { this.changingInput = false }
      const limit = this.pending?.kind === 'search' ? MAX_QUERY : MAX_INPUT
      this.updateStatus(resolved.length > limit ? `Input limit: ${limit} characters` : 'Control text or known credential removed from input')
    }
    if (this.searchPicker) this.renderSearchPicker(this.composerText !== this.searchPicker.query)
    else this.updateCompletions()
    this.updateComposerLayout()
  }
  private renderSearchPicker(queryChanged: boolean): void {
    const search = this.searchPicker
    if (!search || !this.picker || this.closed) return
    const previous = search.matches[this.picker.getSelectedIndex()]
    const query = this.composerText
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
    const height = Math.max(3, Math.min(10, this.renderer.terminalHeight - 9 - Number(this.processBar.visible), Math.max(1, search.matches.length) * 2 + 2 + (this.dialogActions ? 1 : 0)))
    this.pickerBox.height = height
    this.picker.showDescription = height - 2 - (this.dialogActions ? 1 : 0) >= 2
  }
  private handleSearchKey(key: KeyEvent): boolean {
    const search = this.searchPicker
    if (!search || !this.picker) return false
    // Native content-change notifications may be deferred until the next frame.
    // Navigation/refresh must use the query typed in this input batch immediately.
    if (this.composerText !== search.query) this.inputChanged()
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
    const input = this.composerText
    if (input !== this.acceptedCompletion) this.acceptedCompletion = undefined
    if (this.pending?.kind !== 'chat' || !this.pending.armed || this.cancelCallbacks.size ||
      input === this.acceptedCompletion) { this.hideCompletions(); return }
    this.completions = getSlashCommandCompletions(input, this.canCompact)
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
  private get composerText(): string { return this.pastes?.text ?? this.composer.plainText }
  pastedImages(content: string): readonly PastedImage[] {
    return this.pastes.imagesFor(content).map(image => ({ path: image.path, bytes: Uint8Array.from(image.bytes) }))
  }
  private updateImagePreviews(): void {
    if (!this.imagePreviews) return
    const images = this.pending?.kind === 'chat' || this.pending?.kind === 'steering'
      ? this.pastes.imagesFor().slice(-Math.max(1, Math.floor((this.renderer.terminalWidth - 4) / 12))) : []
    const paths = images.map(image => image.path).join(',')
    this.imagePreviews.visible = images.length > 0
    if (paths === this.previewPaths) return
    this.previewPaths = paths
    for (const child of this.imagePreviews.getChildren()) child.destroyRecursively()
    for (const [index, image] of images.entries()) {
      const thumbnail = new ImageRenderable(this.renderer, { id: `vivi-pasted-image-${index}`,
        width: 12, height: '100%', flexShrink: 0, source: image.bytes, fit: 'fit', protocol: 'auto' })
      thumbnail.onMouse = event => {
        const pending = this.pending
        const enabled = !thumbnail.isDestroyed && this.imagePreviews.visible && this.ready(pending) &&
          (pending?.kind === 'chat' || pending?.kind === 'steering') &&
          this.pastes.imagesFor().some(attached => attached.path === image.path)
        this.mouseActivation.handle(event, thumbnail, image.path, pending, enabled,
          () => { void this.openImagePreview(image) })
      }
      this.imagePreviews.add(thumbnail)
    }
  }
  private async openImagePreview(image: PastedImage): Promise<void> {
    if (this.closed || this.openingImages.has(image.path)) return
    this.openingImages.add(image.path)
    try { await this.imagePreview.open(image) }
    catch { if (!this.closed) this.updateStatus('Could not open the image in the system viewer') }
    finally { this.openingImages.delete(image.path) }
  }
  setImageSource(source: CliImageSource | undefined): void {
    if (this.closed || source === this.imageSource) return
    this.imageSourceController.abort()
    this.imageSourceController = new AbortController()
    this.resultImageBytes.clear(); this.resultImageByteCount = 0
    this.imageSource = source
    this.mouseActivation.clear()
    this.rebuild()
  }
  private privateImage(bytes: Uint8Array): boolean {
    return this.secrets.some(secret => secret && Buffer.from(bytes).includes(Buffer.from(secret)))
  }
  private loadResultImage(reference: ToolImageReference): Promise<Uint8Array> {
    const source = this.imageSource
    if (!source || this.sessionId !== undefined && source.sessionId !== this.sessionId) return Promise.reject(new Error('Image source unavailable'))
    const key = JSON.stringify(reference), existing = this.resultImageBytes.get(key)
    if (existing) return existing
    if (!Number.isSafeInteger(reference.byteLength) || reference.byteLength <= 0 || reference.byteLength > IMAGE_LIMITS.bytes ||
      this.resultImageBytes.size >= IMAGE_LIMITS.sessionImages || this.resultImageByteCount + reference.byteLength > IMAGE_LIMITS.sessionBytes) {
      return Promise.reject(new Error('Image preview limit reached'))
    }
    this.resultImageByteCount += reference.byteLength
    const signal = this.imageSourceController.signal
    const bytes = Promise.resolve().then(() => { signal.throwIfAborted(); return source.read(structuredClone(reference), signal) })
    this.resultImageBytes.set(key, bytes)
    return bytes
  }
  private addResultImages(box: BoxRenderable, entry: DisplayEntry): void {
    if (!entry.images?.length) return
    const columns = Math.max(1, Math.floor((this.renderer.width - 4) / 16))
    const images = entry.images.slice(0, IMAGE_LIMITS.sessionImages)
    const row = new BoxRenderable(this.renderer, { id: `vivi-tool-images-${entry.tool!.key}`, width: '100%',
      height: Math.ceil(images.length / columns) * 5, flexShrink: 0, flexDirection: 'row', flexWrap: 'wrap' })
    box.add(row)
    for (const [index, reference] of images.entries()) {
      const cell = new BoxRenderable(this.renderer, { width: Math.min(16, Math.max(1, this.renderer.width - 4)), height: 5, flexShrink: 0 })
      const thumbnail = new ImageRenderable(this.renderer, { id: `vivi-tool-image-${entry.tool!.key}-${index}`,
        width: '100%', height: 4, flexShrink: 0, fit: 'fit', protocol: 'auto' })
      const caption = new TextRenderable(this.renderer, { content: 'Loading image...', height: 1, width: '100%',
        fg: TUI_THEME.muted, wrapMode: 'none', selectable: false })
      cell.add(thumbnail); cell.add(caption); row.add(cell)
      const source = this.imageSource, controller = this.imageSourceController
      const current = () => !this.closed && !controller.signal.aborted && source === this.imageSource &&
        !!source && (this.sessionId === undefined || source.sessionId === this.sessionId) && !thumbnail.isDestroyed && this.entries.includes(entry)
      let loaded: Uint8Array | undefined
      void this.loadResultImage(reference).then(bytes => {
        if (!current()) return
        if (this.privateImage(bytes)) throw new Error('Private image')
        loaded = bytes; thumbnail.source = bytes
        caption.content = this.safe(`${reference.width} x ${reference.height} - open`, 128)
      }).catch(() => { if (!thumbnail.isDestroyed && !this.closed) caption.content = 'Unavailable' })
      thumbnail.onMouse = event => {
        if (event.type === 'scroll') { this.mouseActivation.clear(); return }
        this.mouseActivation.handle(event, thumbnail, reference.id, entry,
          current() && !!loaded && !this.privateImage(loaded) && !this.controls?.overlay.visible &&
          (!this.pending || this.pending.kind === 'chat' || this.pending.kind === 'steering'),
          () => { if (loaded) void this.openImagePreview({ path: reference.id, bytes: loaded }) })
      }
    }
  }
  private async pasteClipboardImage(): Promise<void> {
    const pending = this.pending
    if (!this.clipboard?.read || this.clipboardRead || !pending) return
    const controller = new AbortController()
    this.clipboardRead = controller
    try {
      const result = await this.clipboard.read({ preferredTypes: ['image/png', 'image/jpeg', 'text/plain'], signal: controller.signal })
      if (controller.signal.aborted || this.closed || this.pending !== pending) return
      if (result.status !== 'read') { this.updateStatus('No clipboard image available; use your terminal’s text paste shortcut'); return }
      if (result.representation.mimeType.startsWith('image/')) {
        this.pastes.pasteImage(result.representation.bytes)
      } else {
        const text = this.safe(decodePasteBytes(result.representation.bytes).replace(/\r\n?/g, '\n'), MAX_INPUT + 1)
        if (!await this.pasteImagePath(text, pending, controller.signal)) this.insertPastedText(text)
      }
      this.inputChanged()
    } catch { if (!controller.signal.aborted) this.updateStatus('Clipboard image could not be pasted within the PNG/JPEG image limits') }
    finally { if (this.clipboardRead === controller) this.clipboardRead = undefined }
  }
  private insertPastedText(text: string): void {
    if (!this.pastes.fits(text, MAX_INPUT)) { this.updateStatus('Paste ignored: input limit is 65536 characters'); return }
    if (this.pending?.kind === 'chat' || this.pending?.kind === 'steering') this.pastes.paste(text)
    else this.composer.insertText(text)
    this.inputChanged()
  }
  private async pasteImagePath(text: string, pending: PendingInput, signal: AbortSignal): Promise<boolean> {
    const path = pastedImagePath(text)
    if (path === undefined) return false
    try {
      const bytes = await readPastedImagePath(path, this.workspaceDirectory ?? process.cwd(), signal)
      if (signal.aborted || this.closed || this.pending !== pending) return true
      this.pastes.pasteImage(bytes)
      this.inputChanged()
    } catch {
      if (!signal.aborted && !this.closed && this.pending === pending) {
        this.insertPastedText(text)
        this.updateStatus('Image path could not be attached; pasted as text. Check the file and PNG/JPEG image limits')
      }
    }
    return true
  }
  private queueImagePathPaste(text: string): void {
    const pending = this.pending
    if (!pending) return
    const controller = this.imagePathRead ??= new AbortController()
    const job = this.imagePathJobs.then(async () => {
      if (controller.signal.aborted || this.closed || this.pending !== pending) return
      if (!await this.pasteImagePath(text, pending, controller.signal)) this.insertPastedText(text)
    }).catch(error => { if (!controller.signal.aborted) this.errorHandler({ error }) })
    this.imagePathJobs = job
    void job.finally(() => { if (this.imagePathJobs === job && this.imagePathRead === controller) this.imagePathRead = undefined })
  }
  private handlePaste(event: PasteEvent): void {
    this.hover.clear()
    this.mouseActivation.clear()
    this.consume(event)
    if (this.diagnosticKey) return
    if (this.pending?.kind === 'control') { this.controls?.handlePaste(event); return }
    if (this.pending?.kind === 'question') { this.questionDialog?.handlePaste(event); return }
    if (!this.pending?.armed || this.closed || this.pending.kind === 'choice' ||
      this.pending.kind === 'steering' && !this.ready()) return
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
    const text = this.safe(decodePasteBytes(event.bytes).replace(/\r\n?/g, '\n'), MAX_INPUT + 1)
    if ((this.pending.kind === 'chat' || this.pending.kind === 'steering') && (this.imagePathRead || pastedImagePath(text) !== undefined)) {
      this.queueImagePathPaste(text)
    } else this.insertPastedText(text)
  }
  private handleKey(key: KeyEvent): void {
    this.mouseActivation.clear()
    if (this.closed) { this.consume(key); return }
    if (this.diagnosticKey) { this.consume(key); this.diagnosticKey(key); return }
    if (key.eventType === 'release') { this.consume(key); return }
    if (this.loadingMessage !== undefined) {
      this.consume(key)
      if (key.ctrl && key.name === 'c' && !key.repeated) this.close()
      return
    }
    if ((key.name === 'f6' || key.name === 'f7') && !key.ctrl && !key.shift && !key.meta && !key.super && !key.hyper) {
      this.consume(key)
      if (!key.repeated && key.eventType !== 'repeat') this.stopProcess(key.name === 'f7')
      return
    }
    if (this.pending?.kind === 'control') { this.controls?.handleKey(key); return }
    // This shortcut changes display details only, including while an approval is open.
    if (key.ctrl && key.name === 'o') {
      this.consume(key)
      if (!key.repeated && key.eventType !== 'repeat') {
        const latest = [...this.entries].reverse().find(entry => entry.tool)
        if (latest?.tool) this.toggleToolDetails(latest.tool.key)
      }
      return
    }
    if (this.pending?.kind === 'question' && !(key.ctrl && key.name === 'c')) {
      this.questionDialog?.handleKey(key)
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
      if (['up', 'home', 'right'].includes(key.name)) this.approvalIndex = 1
      else if (['down', 'end', 'left'].includes(key.name)) this.approvalIndex = 0
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
    if (!pending?.armed || pending.kind === 'steering' && !this.ready(pending)) { this.consume(key); return }
    if (pending.kind === 'steering') {
      // Repeat/release events and batched keys from another input cannot dispatch a new request.
      if ((key.repeated || key.eventType === 'repeat') &&
        (['return', 'kpenter', 'linefeed'].includes(key.name) || key.ctrl || key.meta || key.super || key.hyper)) { this.consume(key); return }
      if (['return', 'kpenter'].includes(key.name) && key.ctrl && !key.shift && !key.meta && !key.super && !key.hyper) {
        this.consume(key); this.submitSteering(true); return
      }
      if (key.name === 'backspace' && key.meta && !key.ctrl && !key.shift && !key.super && !key.hyper) {
        this.consume(key); this.editLatestSteering(); return
      }
      if (key.name === 'k' && key.ctrl && key.shift && !key.meta && !key.super && !key.hyper) {
        this.consume(key); this.steering?.controls.clear(); return
      }
      if (key.ctrl && ['n', 'r', 'p'].includes(key.name)) {
        this.consume(key); this.steeringFeedback('Navigation is unavailable while working'); return
      }
    }
    if (this.cancelCallbacks.size && pending.kind === 'chat') { this.consume(key); return }
    if (pending.kind === 'secret') { this.handleSecretKey(key); return }
    if ((pending.kind === 'chat' || pending.kind === 'steering') && key.name === 'v' && (key.ctrl !== key.meta) && !key.shift && !key.super && !key.hyper && this.clipboard?.read) {
      this.consume(key)
      if (!key.repeated && key.eventType !== 'repeat') void this.pasteClipboardImage()
      return
    }
    // Modes change only between turns. Dialogs keep their own Tab navigation,
    // and the draft never becomes input to the enrollment approval.
    if (pending.kind === 'chat' && key.name === 'tab' && key.shift &&
      !key.ctrl && !key.meta && !key.super && !key.hyper) {
      this.consume(key)
      if (key.repeated || key.eventType === 'repeat' || this.runStatus.running) return
      this.saveComposerDraft()
      pending.finish('/mode cycle')
      return
    }
    // Legacy terminals encode Ctrl+J as LF and may encode Shift+Enter exactly
    // like Enter (CR). Only chat/text editors use LF as a newline fallback;
    // search, secret, choice and approval prompts keep their confirmation keys.
    if ((pending.kind === 'chat' || pending.kind === 'steering' || pending.kind === 'text') && !key.shift && !key.meta && !key.super && !key.hyper &&
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
      if (key.name === 'tab' && !key.shift) {
        this.consume(key)
        this.acceptCompletion()
        return
      }
    }
    if ((pending.kind === 'chat' || pending.kind === 'steering') &&
      !key.ctrl && !key.shift && !key.meta && !key.super && !key.hyper &&
      (key.name === 'up' || key.name === 'down')) {
      const row = this.composer.visualCursor.visualRow
      if (key.name === 'up' ? row === 0 : row === this.composer.virtualLineCount - 1) {
        this.consume(key)
        const draft = this.promptHistory.move(key.name === 'up' ? -1 : 1,
          { text: this.composerText, cursor: this.composer.cursorOffset, view: this.pastes.snapshot() })
        if (draft) {
          this.changingInput = true
          try {
            this.composer.setText(this.safe(draft.text, MAX_INPUT))
            if (draft.view) this.pastes.restore(draft.view)
            else this.composer.cursorOffset = draft.cursor
          } finally { this.changingInput = false }
          // A recalled slash command is ready to edit/send; its menu must not trap history arrows.
          this.acceptedCompletion = this.composerText
          this.inputChanged()
        }
        return
      }
    }
    if (pending.kind === 'chat' && key.ctrl && ['n', 'r', 'p'].includes(key.name)) {
      this.consume(key)
      if (!this.cancelCallbacks.size && !this.composerText) {
        pending.finish(key.name === 'n' ? '/new' : key.name === 'r' ? '/resume' : '/menu')
      }
    }
  }
  private cancelOrClose(escape = false): void {
    if (this.closed) return
    // Launch-owned managers may keep cancellation armed while a modal is open.
    // Settle that modal too, so Ctrl-C cannot leave a cancelled picker hanging.
    const chat = this.pending?.kind === 'chat' ? this.pending : undefined
    if (this.pending && this.pending.kind !== 'chat') this.pending.finish(undefined)
    // Cancelling a run retains both its queued messages and unfinished steering draft.
    if (!this.steering) this.clearInput()
    else if (this.pending === this.steering.pending) this.saveSteeringDraft(this.steering)
    if (this.cancelCallbacks.size) {
      this.runStatus.setPhase('cancelling')
      this.updateStatus('Cancelling…')
      for (const callback of [...this.cancelCallbacks]) callback()
      if (chat && this.pending === chat) chat.finish(undefined)
    } else if (!escape) this.close()
    else this.pending?.finish(undefined)
  }
  private submit(): void {
    const pending = this.pending
    if (!pending?.armed || pending.kind === 'choice' || pending.kind === 'control' || this.closed) return
    if (pending.kind === 'steering') { this.submitSteering(false); return }
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
    if (pending.kind === 'chat') {
      this.updateCompletions()
      this.acceptCompletion()
    }
    if (this.clipboardRead || this.imagePathRead) { this.updateStatus('Reading pasted image...'); return }
    this.inputChanged()
    const text = this.composerText
    if (pending.kind === 'approval' || pending.kind === 'question') return
    if (pending.kind === 'chat') this.lastSubmittedDraft = { content: text, view: this.pastes.snapshot() }
    if (pending.kind === 'chat') this.rememberPrompt(text)
    if (pending.kind === 'chat' && !this.steeringQueue.length && text.trim() && !text.trim().startsWith('/') && parseUserShellInput(text) === undefined) {
      this.appendEntry({ category: 'user', label: 'You', content: this.safe(text), markdown: false })
    }
    pending.finish(text)
  }
  private rememberPrompt(text: string): void {
    const safe = this.safe(text, MAX_INPUT)
    this.promptHistory.add(safe)
    void this.promptHistoryStore?.append(safe).catch(() => {
      if (!this.closed) this.updateStatus('Could not save prompt history; history works for this launch')
    })
  }
  private openInput(kind: InputKind, title: string, initial = '', signal?: AbortSignal,
    approvalLabels?: { deny: string; allow: string }): Promise<string | number | undefined> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.pending?.kind === 'question') return Promise.resolve(undefined)
    if (this.closed) return Promise.resolve(undefined)
    if (signal?.aborted) return kind === 'chat' ? Promise.reject(new Error('Input cancelled')) : Promise.resolve(undefined)
    this.setLoading()
    if (kind !== 'chat' && !this.runStatus.running && this.runStatus.label !== undefined) {
      this.runStatus.reset()
      if (['Completed', 'Cancelled', 'Error'].includes(this.status)) this.status = 'Ready'
      this.updateStatus()
    }
    if (this.steering?.pending && this.pending === this.steering.pending) {
      this.saveSteeringDraft(this.steering)
      this.steering.pending = undefined
      if (this.steering.timer !== undefined) clearTimeout(this.steering.timer)
      this.pending = undefined
      this.steeringActions.visible = false
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
    this.composer.placeholder = kind === 'chat' ? COMPOSER_PLACEHOLDER : ''
    this.hintLine.content = kind === 'chat' ? HINTS : kind === 'approval'
      ? '↑/↓ select · Enter confirm · Esc cancel'
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
        if (this.pending !== pending) {
          if (this.suspendedChat?.pending !== pending) return
          this.suspendedChat = undefined
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', abort)
          if (aborted && kind === 'chat') reject(new Error('Input cancelled'))
          else resolve(value)
          return
        }
        this.pending = undefined
        this.updateTerminalTitle()
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
        this.updateSteeringQueue()
        if (this.steering && !this.closed) this.restoreSteering(this.steering)
        if (this.failure) reject(this.failure)
        else if (aborted && kind === 'chat') reject(new Error('Input cancelled'))
        else resolve(value)
        this.inputQueue.setBlocked(false)
      } }
      this.pending = pending
      this.inputQueue.setBlocked(kind !== 'chat' && kind !== 'approval')
      this.updateTerminalTitle()
      this.updateSteeringQueue()
      this.approvalIndex = 1
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
  private lastSubmittedDraft: { content: string; view: ComposerDraft } | undefined
  private nextPasteDraft: ComposerDraft | undefined
  private saveComposerDraft(): void {
    this.nextComposerDraft = this.composerText
    this.nextPasteDraft = this.pastes.snapshot()
  }
  private saveSteeringDraft(steering: SteeringInput): void {
    steering.draft = this.composerText
    steering.pasteDraft = this.pastes.snapshot()
  }
  setControlMode(active: boolean, title?: string): void {
    if (this.closed) return
    if (!active) {
      this.controls?.close(); this.controls = undefined; this.shell.opacity = 1
      return
    }
    this.setLoading()
    if (this.controls) return
    this.controls = new ControlModal(this.renderer, { safe: (text, limit) => this.safe(text, limit),
      hover: this.hover,
      ready: () => this.pending?.kind === 'control' && this.ready(), completedFrame: () => this.lastRenderedFrame,
      foreground: TUI_THEME.foreground, accent: TUI_THEME.lavender, selection: TUI_THEME.selectedBackground,
      selectedForeground: TUI_THEME.highlightForeground, rowBackground: TUI_THEME.rowBackground })
    this.controls.setTitle(title ?? 'Conversation actions')
    this.shell.opacity = 0.35
  }
  async showControlDetails(details: ControlDetails): Promise<void> {
    await this.controlInput(modal => modal.showDetails(details))
  }
  async showControlOutput(includeUnseen = false): Promise<void> {
    if (!this.controls || !includeUnseen && !this.controls.hasOutput) return
    await this.controlInput(modal => modal.showOutput(includeUnseen))
  }
  private async controlInput<T>(run: (modal: ControlModal) => Promise<T>): Promise<T | undefined> {
    const modal = this.controls
    if (!modal || this.closed) return undefined
    this.pending?.finish(undefined)
    const pending: PendingInput = { kind: 'control', armed: false, openedFrame: this.renderer.frameId, finish: () => modal.cancel() }
    this.pending = pending
    this.updateTerminalTitle()
    const timer = setTimeout(() => { if (this.pending === pending && !this.closed) pending.armed = true }, 0)
    try { return await run(modal) }
    finally {
      clearTimeout(timer)
      if (this.pending === pending) this.pending = undefined
      this.updateTerminalTitle()
    }
  }
  private suspendControls(): () => void {
    const modal = this.controls
    if (!modal) return () => undefined
    modal.overlay.visible = false; this.shell.opacity = 1
    return () => {
      if (this.controls === modal && !this.closed) { modal.overlay.visible = true; this.shell.opacity = 0.35 }
    }
  }
  setComposerDraft(content: string): void {
    if (this.closed) return
    if (content.length > 65536) throw new Error('Skill draft request exceeds composer limit')
    this.nextComposerDraft = this.safe(content)
    this.nextPasteDraft = this.lastSubmittedDraft?.content === content ? this.lastSubmittedDraft.view : undefined
  }
  async readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
    const initial = this.nextComposerDraft
    this.nextComposerDraft = ''
    const draft = this.nextPasteDraft; this.nextPasteDraft = undefined
    const reading = this.openInput('chat', prompt, initial, signal)
    if (draft && this.pending?.kind === 'chat') { this.pastes.restore(draft); this.inputChanged() }
    const value = await reading
    return typeof value === 'string' ? value : undefined
  }
  async askText(title: string, initial = ''): Promise<string | undefined> {
    if (this.controls) {
      if (this.controls.hasOutput) await this.showControlOutput()
      return this.controlInput(modal => modal.text(title, initial))
    }
    const value = await this.openInput('text', title, initial)
    return typeof value === 'string' ? value : undefined
  }
  async askSecret(title: string): Promise<string | undefined> {
    const restore = this.suspendControls()
    try {
      const value = await this.openInput('secret', title)
      return typeof value === 'string' ? value : undefined
    } finally { restore() }
  }
  async choose<T>(title: string, choices: readonly Choice<T>[], initialIndex = 0): Promise<T | undefined> {
    if (this.failure) throw this.failure
    if (this.closed || this.pending?.kind === 'question' || choices.length === 0) return undefined
    if (choices.length > MAX_ENTRIES) throw new Error('A picker supports at most 256 choices')
    if (this.controls) {
      if (this.controls.hasOutput) await this.showControlOutput()
      const result = await this.controlInput(modal => modal.choose(title, choices, title === 'Conversation actions' ? {} : { initialIndex }))
      return result?.kind === 'selected' ? result.value : undefined
    }
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
        backgroundColor: TUI_THEME.background, focusedBackgroundColor: TUI_THEME.background,
        textColor: TUI_THEME.foreground, focusedTextColor: TUI_THEME.foreground,
        selectedBackgroundColor: TUI_THEME.selectedBackground, selectedTextColor: TUI_THEME.pink,
        descriptionColor: TUI_THEME.muted, selectedDescriptionColor: TUI_THEME.lavender })
      this.picker.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => this.pending?.finish(index))
      this.bindPickerHover(this.picker)
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
    if (this.closed || this.pending?.kind === 'question') return undefined
    if (this.controls) {
      if (this.controls.hasOutput) await this.showControlOutput()
      return this.controlInput(modal => modal.choose(title, choices, options))
    }
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
        backgroundColor: TUI_THEME.background, focusedBackgroundColor: TUI_THEME.background,
        textColor: TUI_THEME.foreground, focusedTextColor: TUI_THEME.foreground,
        selectedBackgroundColor: TUI_THEME.selectedBackground, selectedTextColor: TUI_THEME.pink,
        descriptionColor: TUI_THEME.muted, selectedDescriptionColor: TUI_THEME.lavender })
      // This is a result view, not a second input target. Mouse autofocus must not
      // redirect later query typing into SelectRenderable's own key handler.
      this.picker.focusable = false
      this.bindPickerHover(this.picker)
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
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    if (this.closed || signal.aborted) return Promise.resolve(false)
    // Preserve the existing approval preemption path, but never reorder a queued dialog.
    if (!this.inputQueue.pending && this.pending && !['chat', 'steering', 'approval', 'question'].includes(this.pending.kind)) this.pending.finish(undefined)
    return this.queueDialog(signal, () => false, activeSignal => this.showApproval(request, activeSignal))
  }
  private async showApproval(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    if (this.closed || signal.aborted) return false
    const publicUrl = request.call.name === 'fetch_url'
    const skillSave = request.call.name === 'save_skill'
    if (request.description.length > 60 * 1024) { this.write('Approval denied: exact review exceeds the display limit\n'); return false }
    const restoreControls = this.suspendControls()
    this.showTool(request.call.id, 'approval_required', 'not_attempted', 'Exact action needs human review')
    const approval = { token: {}, toolKey: this.liveToolCalls.get(request.call.id)?.key }
    this.activeApproval = approval
    const scope = request.currentRevision === 'new memory' ? 'new memory' : `current revision ${request.currentRevision}`
    const workspace = ['workspace_create_text', 'workspace_edit_text'].includes(request.call.name) && request.workspaceDiff
      ? workspaceDiffPresentation(request.description, request.workspaceDiff) : undefined
    this.appendEntry({ category: 'activity', attention: true, label: workspace ? workspace.path : `Approval required · ${scope}`,
      content: this.safe(workspace?.content ?? request.description), markdown: false, approval: approval.token,
      ...(workspace ? { workspaceDiff: workspace.content } : {}) })
    const title = publicUrl
      ? 'Review this public URL request' : skillSave ? 'Save skill?' : 'Review this change'
    this.updateStatus(`Approval required${workspace ? '' : ` · ${scope}`}`)
    const answer = this.openInput('approval', title, '', signal, skillSave ? { deny: 'Deny', allow: 'Save skill' } : undefined)
    this.pickerBox.title = title
    this.pickerBox.height = 4
    this.pickerBox.visible = true
    this.runStatus.setPhase('waiting_approval')
    try {
      const reply = await answer
      this.showTool(request.call.id, reply === 'allow' && !signal.aborted && !this.closed ? 'running' : signal.aborted ? 'cancelled' : 'denied',
        reply === 'allow' && !signal.aborted && !this.closed && !publicUrl ? 'unreported' : 'not_attempted')
      return reply === 'allow' && !signal.aborted && !this.closed
    } finally {
      if (this.activeApproval === approval) this.activeApproval = undefined
      this.runStatus.setPhase(signal.aborted ? 'cancelling' : 'working')
      if (!this.closed && !this.runStatus.running) this.updateStatus('Ready')
      restoreControls()
    }
  }
  private queueDialog<T>(signal: AbortSignal, cancelled: () => T, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.resolve(cancelled())
    this.inputQueue.setBlocked(!!this.pending && !['chat', 'steering', 'approval', 'question'].includes(this.pending.kind))
    const bound = AbortSignal.any([signal, this.dialogOwner.signal])
    return this.inputQueue.enqueue(bound, () => { if (this.failure) throw this.failure; return cancelled() }, async activeSignal => {
      const token = {}; this.activeDialog = token
      if (this.steering?.pending && this.pending === this.steering.pending) {
        this.saveSteeringDraft(this.steering)
        this.steering.pending = undefined
        if (this.steering.timer !== undefined) clearTimeout(this.steering.timer)
        this.pending = undefined
        this.steeringActions.visible = false
        this.clearInput(); this.disableComposer()
      }
      if (this.pending?.kind === 'chat') {
        this.suspendedChat = { pending: this.pending,
          title: this.composerBox.title ?? 'Message', pasteDraft: this.pastes.snapshot() }
        this.pending = undefined
        this.hideCompletions(); this.disableComposer()
      }
      try { return await run(activeSignal) }
      finally {
        if (this.activeDialog === token) {
          this.activeDialog = undefined
          const chat = this.suspendedChat; this.suspendedChat = undefined
          if (chat && !this.closed) {
            this.pending = chat.pending
            this.composerBox.visible = true; this.composer.visible = true; this.secretMask.visible = false
            this.composerBox.title = chat.title
            this.changingInput = true
            try { this.pastes.restore(chat.pasteDraft) }
            finally { this.changingInput = false }
            this.inputChanged()
            if (!this.cancelCallbacks.size) { this.composer.traits = {}; this.composer.showCursor = true; this.composer.focus() }
            this.hintLine.content = HINTS
            this.updateCompletions(); this.updateActionBar(); this.updateComposerLayout()
          }
          if (this.steering && !this.closed && !this.pending) this.restoreSteering(this.steering)
          this.updateTerminalTitle()
        }
      }
    })
  }
  askQuestions(request: QuestionRequest, signal: AbortSignal): Promise<QuestionResponse> {
    const requestId = request.requestId
    const cancelled = (): QuestionResponse => ({ requestId, status: 'cancelled' })
    if (request.questions.length < 1 || request.questions.length > 3 || !request.requestId || request.requestId.length > 128) return Promise.resolve(cancelled())
    // Capture the exact request before it waits in the shared approval/question FIFO.
    const captured = structuredClone(request)
    return this.queueDialog(signal, cancelled, activeSignal => this.showQuestions(captured, activeSignal))
  }
  private showQuestions(request: QuestionRequest, signal: AbortSignal): Promise<QuestionResponse> {
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const cancelled = (): QuestionResponse => ({ requestId: request.requestId, status: 'cancelled' })
      let finished = false
      const finish = (response: QuestionResponse, mouse = false): void => {
        if (finished || this.pending !== pending) return
        finished = true
        if (mouse) this.approvalMouseNotBefore = performance.now() + APPROVAL_REPEAT_WINDOW_MS
        if (timer !== undefined) clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.questionDialog?.close(); this.questionDialog = undefined
        this.pending = undefined
        this.composerBox.visible = true
        this.hintLine.content = HINTS
        if (!this.closed && response.status === 'cancelled') this.appendEntry({ category: 'activity', label: 'Questions cancelled', content: 'No answers submitted', markdown: false })
        this.runStatus.setPhase(signal.aborted ? 'cancelling' : 'working')
        if (!this.closed) this.updateStatus(this.runStatus.running ? 'Working' : 'Ready')
        resolve(signal.aborted || this.closed ? cancelled() : response)
      }
      const abort = (): void => finish(cancelled())
      const pending: PendingInput = { kind: 'question', armed: false, openedFrame: this.renderer.frameId,
        finish: () => finish(cancelled()) }
      this.pending = pending
      this.composerBox.visible = false
      this.hideCompletions(); this.disableComposer()
      this.pickerBox.visible = false
      if (this.dialogActions) { this.dialogActions.destroyRecursively(); this.dialogActions = undefined }
      this.updateActionBar(); this.updateHeader(); this.updateSteeringQueue()
      try {
        this.questionDialog = new QuestionDialog(this.renderer, request, {
          hover: this.hover,
          safe: (text, limit) => this.safe(text, limit), clean: stripControls, ready: () => this.pending === pending && this.ready(pending),
          mouseReady: () => performance.now() >= this.approvalMouseNotBefore,
          // Keep transcript context, status, and every visible shell footer.
          availableHeight: () => this.renderer.terminalHeight - this.headerRows -
            (this.renderer.terminalHeight > 15 ? 3 : 2) - Number(this.workspaceLine.visible)
            - Number(this.processBar.visible) - (this.footer.visible ? this.footerRows : 0) - Number(this.hintLine.visible)
            - (this.steeringQueueLine.visible ? this.steeringQueueLine.height : 0),
          status: text => this.updateStatus(text), finish, foreground: TUI_THEME.foreground,
          accent: TUI_THEME.lavender, background: TUI_THEME.background,
          selectedBackground: TUI_THEME.selectedBackground, selectedForeground: TUI_THEME.highlightForeground })
        this.shell.insertBefore(this.questionDialog.box, this.composerBox)
        this.hintLine.content = '↑/↓ select · PgUp/PgDn read · Enter choose · Tab actions · Ctrl+Enter submit · Esc cancel'
        this.runStatus.setPhase('waiting_question')
        this.updateActionBar(); this.updateStatus('Questions need your answer · Submit when ready')
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted || this.closed) { abort(); return }
        timer = setTimeout(() => { if (this.pending === pending && !this.closed) pending.armed = true }, 0)
      } catch (error) {
        finish(cancelled())
        if (!this.closed) this.updateStatus(`Question dialog unavailable: ${error instanceof Error ? error.message : 'native setup failed'}`)
      }
    })
  }
  private invalidateDialogs(): void { this.dialogOwner.abort(); this.dialogOwner = new AbortController() }
  runStarted(): void {
    if (this.closed) return
    this.setLoading()
    this.invalidateDialogs()
    if (this.steering?.pending && this.pending === this.steering.pending) {
      this.saveSteeringDraft(this.steering)
      if (this.steering.timer !== undefined) clearTimeout(this.steering.timer)
      this.steering.pending = undefined
      this.pending = undefined
      this.restoreSteering(this.steering)
    }
    this.settleReviews('cancelled')
    this.turnHistoryStart = this.historyLength
    // The host accepts this turn's user message before its first assistant event.
    this.liveHistoryIndex = this.historyLength + 1
    this.liveToolCalls.clear()
    for (const entry of this.entries) if (entry.tool) entry.tool.retained = false
    this.programStatus.runStarted()
    this.runStatus.start()
    this.updateStatus('Working · Escape / Ctrl+C cancels')
  }
  runFinished(outcome: RunOutcome, continuing = false): void {
    if (this.closed) return
    this.steeringMessage = undefined
    this.invalidateDialogs()
    this.mouseActivation.clear()
    if (this.pending?.kind === 'steering') {
      this.pending.armed = false
      this.disableComposer()
    }
    this.settleReviews(outcome)
    for (const [id, live] of this.liveToolCalls) {
      if (!['requested', 'approval_required', 'running'].includes(live.status ?? 'requested')) continue
      this.showTool(id, live.effect === 'not_attempted' ? 'cancelled' : 'unknown', live.effect === 'not_attempted' ? 'not_attempted' : 'unreported')
    }
    if (!continuing) this.programStatus.runFinished(outcome)
    this.runStatus.finish(outcome)
    this.updateStatus(outcome === 'completed' ? 'Completed' : outcome === 'cancelled' ? 'Cancelled' : 'Error')
  }
  onProcessControls(controls: BackgroundProcessControls): () => void {
    if (this.processTimer !== undefined) clearInterval(this.processTimer)
    this.processControls = controls; this.processSelection = undefined; this.processStopping = new Map()
    this.processGesture = {}; this.mouseActivation.clear()
    this.refreshProcesses()
    this.processTimer = setInterval(() => this.refreshProcesses(), 250)
    this.processTimer.unref()
    return () => {
      if (this.processControls !== controls) return
      if (this.processTimer !== undefined) clearInterval(this.processTimer)
      this.processTimer = undefined; this.processControls = undefined; this.processSelection = undefined
      this.processStopping = new Map(); this.processGesture = {}; this.mouseActivation.clear()
      this.refreshProcesses()
    }
  }
  private refreshProcesses(): void {
    if (this.closed || !this.processBar) return
    const jobs = this.processControls?.list().filter(job => !job.cleanupConfirmed) ?? []
    const selected = jobs.find(job => job.executionId === this.processSelection) ?? jobs[jobs.length - 1]
    if (this.processSelection !== selected?.executionId) {
      this.processSelection = selected?.executionId; this.processGesture = {}; this.mouseActivation.clear()
    }
    // A hidden/unbound process surface must be inert. Rewriting native text or
    // layout during every frame can disrupt the separate question editor/page.
    if (!jobs.length) {
      if (this.processBar.visible) { this.processBar.visible = false; this.updateComposerLayout() }
      return
    }
    const becameVisible = !this.processBar.visible
    if (becameVisible) this.processBar.visible = true
    const compact = this.renderer.terminalWidth < 44
    const buttons = this.processBar.getChildren().filter(child => child !== this.processLabel) as TextRenderable[]
    for (const button of buttons) {
      const buttonVisible = button.id !== 'vivi-process-next' || !compact
      if (button.visible !== buttonVisible) button.visible = buttonVisible
      const label = button.id === 'vivi-process-next' ? 'Next' : button.id === 'vivi-process-stop' ? compact ? 'Stop' : 'Stop F6' : compact ? 'Stop All' : 'Stop All F7'
      const content = ` ${label} `
      if (button.plainText !== content) { button.content = content; button.width = label.length + 2 }
    }
    const visible = buttons.filter(button => button.visible)
    const controlsWidth = visible.reduce((width, button) => width + Number(button.width), 0) + visible.length
    if (selected) {
      const content = fitStatusColumns(this.safe(
        `${this.processStopping.size ? 'Stopping…' : `Processes ${jobs.length}`} · ${selected.executionId.slice(0, 8)} · ${selected.background ? selected.state : 'cleanup unconfirmed'}`),
        Math.max(1, this.renderer.terminalWidth - controlsWidth), true)
      if (this.processLabel.plainText !== content) this.processLabel.content = content
    }
    if (becameVisible) this.updateComposerLayout()
  }
  private selectNextProcess(): void {
    const jobs = this.processControls?.list().filter(job => !job.cleanupConfirmed) ?? []
    const index = jobs.findIndex(job => job.executionId === this.processSelection)
    this.processSelection = jobs[(index + 1) % jobs.length]?.executionId
    this.processGesture = {}; this.mouseActivation.clear(); this.refreshProcesses()
  }
  private stopProcess(all: boolean): void {
    const controls = this.processControls
    if (!controls || this.closed) return
    this.refreshProcesses()
    const id = this.processSelection
    if (!all && !id) return
    const key = all ? '*' : id!
    if (this.processStopping.has(key)) return
    const token = {}; this.processStopping.set(key, token)
    this.processGesture = {}; this.mouseActivation.clear(); this.refreshProcesses()
    void (all ? controls.stopAll() : controls.stop(id!)).catch(error => {
      if (this.processControls === controls && !this.closed) this.write(`Process cleanup unconfirmed: ${error instanceof Error ? error.message : 'inspect /processes'}\n`)
    }).finally(() => {
      if (this.processStopping.get(key) === token) { this.processStopping.delete(key); this.refreshProcesses() }
    })
  }
  onCancel(callback: () => void): () => void {
    if (this.closed) { callback(); return () => undefined }
    if (!this.runStatus.running) this.runStatus.reset()
    this.cancelCallbacks.add(callback)
    this.mouseActivation.clear()
    this.updateActionBar()
    this.resultNotices = []
    if (!this.steering) { this.clearInput(); this.disableComposer() }
    this.updateStatus('Running · Escape / Ctrl+C cancels')
    return () => {
      this.cancelCallbacks.delete(callback)
      this.updateActionBar()
      this.updateTerminalTitle()
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
      width: '100%', fg: TUI_THEME.foreground, treeSitterClient: this.parser,
      // Native streaming can append list/table descendants after renderNode.
      renderBefore() { guardMarkdownSelection(this) },
      // Plain fenced code is readable offline and does not fetch language grammars.
      renderNode: (token, context) => {
        if (token.type === 'code') return new TextRenderable(this.renderer, { ...TEXT_SELECTION,
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
    const bodyColor = user ? TUI_THEME.highlightForeground : TUI_THEME.foreground
    const bodyAttributes = activity && !entry.attention ? TextAttributes.DIM : 0
    const box = new BoxRenderable(this.renderer, { flexDirection: 'column', flexShrink: 0, width: '100%', marginBottom: entry.tool ? 0 : 1,
      ...(user ? { backgroundColor: TUI_THEME.userBackground, border: ['left'], borderColor: TUI_THEME.lavender, paddingLeft: 1 } : {}) })
    if (!entry.tool && entry.label) box.add(new TextRenderable(this.renderer, { ...TEXT_SELECTION, content: entry.label, fg: headerColor, attributes: activity && !entry.attention ? TextAttributes.DIM : 0, flexShrink: 0, wrapMode: 'word' }))
    if (entry.tool) {
      const key = entry.tool.key, collapsed = !this.expandedTools.has(key)
      const card = cliToolCardView(entry.tool.encoded, collapsed, entry.tool.detailBytes ?? 8192, this.secrets, entry.tool)
      const view = card.expanded
      const button = new TextRenderable(this.renderer, { ...TEXT_SELECTION, id: `vivi-tool-details-${key}`,
        content: toolHeader(card, collapsed, Math.max(1, this.renderer.width - 3)),
        fg: card.attention ? TUI_THEME.attention : TUI_THEME.lavender,
        flexShrink: 0, width: '100%', height: 1, wrapMode: 'none' })
      button.selectable = false
      button.onMouse = event => {
        // Wheel events bubble to the transcript; they never toggle a call.
        if (event.type === 'scroll') { this.mouseActivation.clear(); return }
        this.mouseActivation.handle(event, button, key, entry.tool, !this.closed && this.entries.includes(entry),
          () => this.toggleToolDetails(key))
      }
      this.hover.bind(button, () => !this.closed && this.entries.includes(entry) && !this.controls?.overlay.visible)
      box.add(button)
      // Actionable custom warnings stay outside the detail budget, even when collapsed.
      for (const warning of collapsed ? card.warnings : []) box.add(new TextRenderable(this.renderer,
        { ...TEXT_SELECTION, content: this.safe(warning), fg: TUI_THEME.attention, flexShrink: 0, width: '100%', wrapMode: 'word' }))
      const details = new BoxRenderable(this.renderer, { id: `vivi-tool-body-${key}`, flexDirection: 'column',
        flexShrink: 0, width: '100%' })
      if (!collapsed) {
        for (const line of view.header) details.add(new TextRenderable(this.renderer,
          { ...TEXT_SELECTION, content: this.safe(line), fg: bodyColor, attributes: bodyAttributes, flexShrink: 0, width: '100%', wrapMode: 'word' }))
        for (const warning of view.warnings) details.add(new TextRenderable(this.renderer,
          { ...TEXT_SELECTION, content: this.safe(`Warning: ${warning}`), fg: TUI_THEME.attention, flexShrink: 0, width: '100%', wrapMode: 'word' }))
      }
      for (const section of view.details) details.add(new TextRenderable(this.renderer,
        { ...TEXT_SELECTION, content: this.safe(`${section.label}:\n${section.text}`), fg: bodyColor, attributes: bodyAttributes, width: '100%', wrapMode: 'word', flexShrink: 0 }))
      box.add(details)
      this.addResultImages(box, entry)
      if (!collapsed && view.notice) details.add(new TextRenderable(this.renderer,
        { ...TEXT_SELECTION, content: view.notice, fg: TUI_THEME.muted, attributes: TextAttributes.DIM, width: '100%', wrapMode: 'word', flexShrink: 0 }))
    }
    if (entry.content && !entry.tool) {
      const options = { ...TEXT_SELECTION, content: entry.content, fg: bodyColor, attributes: bodyAttributes,
        width: '100%' as const, wrapMode: 'word' as const, flexShrink: 0 }
      box.add(entry.markdown ? this.markdown(entry.content) : entry.workspaceDiff
        ? new WorkspaceDiffRenderable(this.renderer, options, entry.workspaceDiff, this.transcript.viewport) : new TextRenderable(this.renderer, options))
    }
    this.transcript.add(box)
    return box
  }
  private toggleToolDetails(key: string): void {
    this.mouseActivation.clear()
    if (this.expandedTools.has(key)) this.expandedTools.delete(key)
    else this.expandedTools.add(key)
    this.rebuild()
  }
  setToolEvidence(evidence: CliToolEvidence): void { this.toolEvidence = evidence }
  setConversationErrors(errors: CliConversationErrors): void {
    this.conversationErrors = { sessionId: errors.sessionId, errors: errors.errors.map(error => ({ ...error, message: this.safe(error.message) })) }
  }
  /** Inert display sink for shared versioned data; it contains no action handlers. */
  toolPresentation(encoded: string): void {
    this.appendEntry({ category: 'activity', label: 'Tool presentation', content: '', markdown: false,
      tool: { encoded, key: `display-${this.displaySequence++}` } })
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
      source: live.source, secrets: this.secrets, ...(progress ? { progress } : {}) })) }
    catch { encoded = '' }
    const old = this.entries.find(entry => entry.tool?.key === live.key)
    const entry: DisplayEntry = { category: 'activity', label: this.safe(`Tool ${live.call.name}`, 4096), content: '',
      markdown: false, tool: { encoded, key: live.key, retained: true }, historyIndex: live.index }
    if (old) this.entries[this.entries.indexOf(old)] = entry
    else this.entries.push(entry)
    this.rebuild()
  }
  private trimEntries(): void {
    // The generic transcript budget bounds bodies, not required semantic/source rows.
    // The separate entry cap bounds whole-card retention across long conversations.
    const size = (entry: DisplayEntry): number => {
      if (!entry.tool) return entry.content.length
      const view = cliToolPresentationView(entry.tool.encoded, false, entry.tool.detailBytes ?? 8192, this.secrets)
      return view.details.reduce((sum, section) => sum + section.text.length, 0)
    }
    let total = this.entries.reduce((sum, entry) => sum + size(entry), 0)
    // Reduce noisy detail first. Persist that exact budget through addEntry/toggle,
    // rather than restoring 8 KiB after history retention computed a smaller view.
    for (const entry of this.entries) {
      if (total <= MAX_DISPLAY) break
      if (!entry.tool) continue
      const previous = size(entry)
      entry.tool.detailBytes = 0
      total -= previous
    }
    while (this.entries.length > 1 && (this.entries.length > MAX_ENTRIES || total > MAX_DISPLAY)) {
      // Current-turn cards survive body pressure, including early unknown effects
      // followed by later cards. Old complete turns may be omitted as whole cards.
      const required = (entry: DisplayEntry): boolean => this.activeApproval !== undefined &&
        (entry.approval === this.activeApproval.token || this.activeApproval.toolKey !== undefined && entry.tool?.key === this.activeApproval.toolKey)
      let index = this.entries.findIndex(entry => !required(entry) && !entry.tool?.retained)
      if (index < 0) index = this.entries.findIndex(entry => !required(entry))
      if (index < 0) break // Never remove the exact pending review or its card.
      const [first] = this.entries.splice(index, 1)
      if (!first) break
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
    let earliestIndex = history.length, omitted = false
    let latestTurn = 0
    for (let index = history.length - 1; index >= 0; index--) {
      const message = history[index]!
      if (message.kind === 'message' && message.role === 'user') { latestTurn = index; break }
    }
    for (let index = history.length - 1; index >= 0 && entries.length < MAX_ENTRIES - 1 && (budget > 0 || index >= latestTurn); index--) {
      earliestIndex = index
      const message = history[index]!
      const label = message.kind === 'message' ? message.role === 'user' ? 'You' : 'System'
        : message.kind === 'assistant' ? '' : `Tool ${message.name} · ${message.isError ? 'error result' : 'result'}`
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
        const detailBytes = Math.max(0, Math.min(8192, budget))
        const view = cliToolPresentationView(encoded, false, detailBytes, this.secrets)
        entries.unshift({ category: 'activity', label: safeLabel, content: '', markdown: false, historyIndex: index,
          ...(!message.isError && message.images?.length ? { images: structuredClone(message.images) } : {}),
          attention: !!message.isError, tool: { encoded, key, detailBytes, retained: index >= latestTurn,
            localRead: requestIndex !== index && isCliLocalReadTool(message.name), resultError: !!message.isError } })
        // Whole-history retention may omit old complete cards, never slice their safety rows.
        budget -= view.details.reduce((sum, section) => sum + section.text.length, 0)
        continue
      }
      if (message.kind === 'assistant') {
        // Incomplete saved turns still expose each unresolved call. A matching
        // result is already represented once at its canonical chronology slot.
        const unresolved = message.toolCalls.filter(call => {
          for (let following = index + 1; following < history.length; following++) {
            const candidate = history[following]!
            if (candidate.kind === 'message' && candidate.role === 'user' || candidate.kind === 'assistant') break
            if (candidate.kind === 'tool_result' && candidate.callId === call.id && candidate.name === call.name) return false
          }
          return true
        }).map(call => {
          let encoded: string
          try { encoded = JSON.stringify(createCliToolPresentation({ call, status: 'unknown', effect: 'unreported',
            source: cliToolSource(this.sessionId, index, message), secrets: this.secrets })) }
          catch { encoded = '' }
          return { category: 'activity' as const, label: '', content: '', markdown: false, historyIndex: index,
            tool: { encoded, key: this.toolKey(index, call.id), detailBytes: Math.max(0, Math.min(8192, budget)), retained: index >= latestTurn } }
        })
        entries.unshift(...unresolved)
      }
      if (budget <= 0) { if (message.content) omitted = true; continue }
      const content = this.safe(message.content, Math.max(0, budget - safeLabel.length))
      if (!content) continue
      entries.unshift({ category: message.kind === 'message' && message.role === 'user' ? 'user' : message.kind === 'assistant' ? 'assistant' : 'activity',
        label: safeLabel, content, markdown: message.kind === 'assistant', historyIndex: index })
      budget -= safeLabel.length + content.length
    }
    if (earliestIndex > 0 || omitted) entries.unshift({ category: 'activity', label: 'Display limit',
      content: 'Earlier transcript is omitted from this bounded view; saved history is unchanged', markdown: false })
    return entries
  }
  private transcriptEntries(history: readonly HistoryMessage[]): DisplayEntry[] {
    const entries = this.historyEntries(history)
    const placed = new Map<number, DisplayEntry[]>()
    const durable = this.conversationErrors && this.conversationErrors.sessionId === this.sessionId ? this.conversationErrors.errors : []
    const errors = [...durable, ...this.liveErrors.filter(error => !durable.some(saved =>
      saved.historyDigest === error.historyDigest && saved.message === error.message))]
    for (const error of matchingConversationErrors(history, errors)) {
      const group = placed.get(error.historyLength) ?? []
      group.push({ category: 'activity', attention: true, label: 'Error', content: this.safe(error.message), markdown: false })
      placed.set(error.historyLength, group)
    }
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
      const publicUrl = entry.review.toolName === 'fetch_url'
      const mcp = entry.review.toolName.startsWith('mcp_') || ['list_mcp_resources', 'read_mcp_resource', 'read_mcp_resource_template'].includes(entry.review.toolName)
      this.reviewNotice(publicUrl
        ? unknown ? 'Public URL admission could not be confirmed; no fetch result was confirmed'
          : outcome === 'cancelled' ? 'Review cancelled; this public URL request was not approved' : 'Review ended before this public URL request was approved'
        : mcp
        ? unknown ? 'The MCP operation outcome could not be confirmed; check the remote service before retrying'
          : outcome === 'cancelled' ? 'Review cancelled; no MCP operation was started' : 'Review ended before an MCP operation was started'
        : unknown ? 'The write outcome could not be confirmed; check the resource before retrying'
          : outcome === 'cancelled' ? 'Review cancelled; no save was made' : 'Review ended without a confirmed save',
      { ...entry.review, state: unknown ? 'unknown' : outcome === 'cancelled' ? 'cancelled' : 'failed' })
    }
  }
  setDraft(provider: CliProviderName): void {
    if (this.closed) return
    this.invalidateDialogs()
    this.runStatus.reset()
    this.sessionId = undefined
    this.contextUsage = undefined
    this.canCompact = false
    this.sessionTitle = 'Untitled conversation'
    this.sessionProvider = provider
    this.sessionModel = 'choose a model with /models'
    this.sessionEffort = ''; this.sessionPlan = false
    this.updateHeader()
    this.clearStream()
    this.entries = []
    this.resultNotices = []
    this.reviewNotices = []
    this.toolEvidence = undefined
    this.conversationErrors = undefined
    this.liveErrors = []
    this.expandedTools.clear()
    this.liveToolCalls.clear()
    this.historyLength = 0
    this.turnHistoryStart = 0
    this.contextUsage = undefined
    this.canCompact = false
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
    this.questionDialog?.resize()
  }
  setContext(usage: ContextUsage | undefined, canCompact = false): void {
    if (this.closed) return
    this.contextUsage = usage ? { ...usage } : undefined
    this.canCompact = canCompact
    this.updateHeader()
    this.updateCompletions()
  }
  setSession(session: CliSession): void {
    if (this.closed) return
    if (this.sessionId !== session.id) {
      this.invalidateDialogs()
      this.contextUsage = undefined
      this.canCompact = false
    }
    if (this.sessionId !== undefined && this.sessionId !== session.id) {
      this.pastes.resetImages()
      this.runStatus.reset()
      this.liveErrors = []
      this.resultNotices = []
      this.reviewNotices = []
      this.turnHistoryStart = 0
      this.clearStream()
      this.expandedTools.clear()
      this.liveToolCalls.clear()
      this.status = 'Ready'
    }
    this.sessionId = session.id
    this.sessionTitle = this.safe(sessionDisplayTitle(session), 4096)
    this.sessionProvider = this.safe(session.provider, 4096)
    this.sessionModel = this.safe(session.model, 4096)
    this.sessionEffort = this.safe(session.reasoning ?? 'default', 256)
    this.sessionPlan = session.provider === 'chatgpt'
    this.historyLength = session.history.length
    this.updateHeader()

    this.entries = [...this.transcriptEntries(session.history), ...this.resultNotices]
    this.rebuild()
    this.updateStatus()
  }
  write(text: string): void {
    if (text && this.controls?.overlay.visible) { this.controls.notice(text); return }
    if (text) this.appendEntry({ category: 'activity', label: 'vivi', content: this.safe(text.trimEnd()), markdown: false })
  }
  reviewNotice(message: string, context?: ReviewNotice): void {
    if (this.closed || !message) return
    if (context && this.sessionId !== undefined && context.sessionId !== this.sessionId) return
    const key = context ? JSON.stringify([context.sessionId, context.runId, context.callId]) : undefined
    const previous = key === undefined ? undefined : this.reviewNotices.find(entry => entry.reviewKey === key)
    if (previous?.review && reviewNoticeSettled(previous.review)) return
    if (context && (previous?.historyStart ?? this.turnHistoryStart) === this.turnHistoryStart &&
      this.liveToolCalls.get(context.callId)?.call.name === context.toolName) {
      const state: Record<ReviewNotice['state'], readonly [ToolPresentationStatus, ToolPresentationEffect]> = {
        reviewing: ['running', 'not_attempted'], needs_review: ['approval_required', 'not_attempted'],
        saving: ['running', 'unknown'], saved: ['succeeded', 'confirmed'], denied: ['denied', 'not_attempted'],
        cancelled: ['cancelled', 'not_attempted'], failed: ['failed', 'not_attempted'], unknown: ['unknown', 'unknown'] }
      // URL review settles admission only; the owned fetch/result events supply network evidence.
      const presentation = context.toolName === 'fetch_url' && ['saving', 'saved'].includes(context.state)
        ? ['running', 'not_attempted'] as const : state[context.state]
      this.showTool(context.callId, ...presentation, message)
    }
    const content = this.safe(message, 2048)
    if (!context && this.reviewNotices.some(entry => !entry.review && entry.historyStart === this.turnHistoryStart && entry.content === content)) return
    const entry: DisplayEntry = { category: 'activity',
      attention: !context || ['needs_review', 'failed', 'unknown'].includes(context.state), label: context ? this.safe(`${context.source === 'skip' ? 'Skip permissions' : 'Review'} · ${context.toolName}`, 4096) : 'Review warning',
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
      this.partialBox.add(new TextRenderable(this.renderer, { ...TEXT_SELECTION, content: 'streaming preview (not accepted)', fg: TUI_THEME.pink }))
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
      if (event.message.content) this.appendEntry({ category: 'assistant', label: '', content: event.message.content, markdown: true })
      const index = this.liveHistoryIndex++
      for (const [ordinal, call] of event.message.toolCalls.entries()) {
        // Canonical results occupy ordered batch slots even when cancellation
        // closes a generic tool without delivering its tool_completed callback.
        this.liveToolCalls.set(call.id, { call, index, resultIndex: index + 1 + ordinal,
          key: this.toolKey(index, call.id), source: cliToolSource(this.sessionId, index, event.message) })
        this.showTool(call.id, 'requested', 'not_attempted')
      }
    } else if (event.type === 'tool_started') {
      this.updateStatus(`Tool running: ${event.call.name}`)
      if (!this.liveToolCalls.has(event.call.id)) this.liveToolCalls.set(event.call.id,
        { call: event.call, index: this.liveHistoryIndex, key: this.toolKey(this.liveHistoryIndex, event.call.id),
          source: { ...cliToolSource(undefined, this.liveHistoryIndex, event.call), reference: 'cli-live:unreported-request' } })
      this.showTool(event.call.id, 'running', 'unreported', `${event.call.name} · running`)
    } else if (event.type === 'tool_completed') {
      this.updateStatus('Working')
      const candidate = this.liveToolCalls.get(event.message.callId)
      const live = candidate?.call.name === event.message.name ? candidate : undefined
      const call = live?.call ?? { id: event.message.callId, name: event.message.name, arguments: {} }
      const resultIndex = live?.resultIndex
      const source = resultIndex === undefined
        ? { ...cliToolSource(undefined, 0, event.message), reference: 'cli-live:unreported-result' }
        : cliToolSource(this.sessionId, resultIndex, event.message)
      const decision = live && this.toolEvidence?.sessionId === this.sessionId
        ? cliToolResultDecision(call, event.message, live.index, this.toolEvidence) : undefined
      let encoded: string
      try { encoded = JSON.stringify(createCliToolPresentation({ call, result: event.message,
        status: decision?.status ?? 'unknown', effect: decision?.effect ?? 'unreported',
        source: decision?.source ?? source, secrets: this.secrets })) }
      catch { encoded = '' }
      const old = this.entries.find(entry => entry.tool?.key === live?.key)
      const entry: DisplayEntry = { category: 'activity', attention: !!event.message.isError,
        ...(!event.message.isError && event.message.images?.length ? { images: structuredClone(event.message.images) } : {}),
        label: this.safe(`Tool ${event.message.name} · ${event.message.isError ? 'error result' : 'result'}`, 4096), content: '', markdown: false,
        ...(resultIndex === undefined ? {} : { historyIndex: resultIndex }),
        tool: { encoded, key: live?.key ?? `display-${this.displaySequence++}`, retained: true,
          localRead: !!live && isCliLocalReadTool(call.name), resultError: !!event.message.isError } }
      if (old) this.entries[this.entries.indexOf(old)] = entry
      else this.entries.push(entry)
      this.liveToolCalls.delete(event.message.callId)
      if (resultIndex !== undefined) this.liveHistoryIndex = Math.max(this.liveHistoryIndex, resultIndex + 1)
      this.rebuild()
    } else if (event.type === 'context_usage') {
      this.contextUsage = { ...event.usage }
      this.updateHeader()
    } else if (event.type === 'compaction_started') {
      this.runStatus.setPhase('compacting')
      this.updateStatus('Compacting context')
    } else if (event.type === 'compaction_completed') {
      this.runStatus.setPhase('working')
      this.updateStatus('Context compacted')
    } else if (event.type === 'compaction_failed') {
      this.runStatus.setPhase('working')
      this.updateStatus('Context compaction failed; original transcript retained')
    } else if (event.type === 'round_completed') {
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
    if (result.error && this.sessionId !== undefined) {
      const historyDigest = conversationHistoryDigest(result.history), message = this.safe(result.error.message)
      if (!this.liveErrors.some(error => error.historyDigest === historyDigest && error.message === message)) {
        this.liveErrors.push({ id: `live-error:${this.displaySequence++}`, historyLength: result.history.length, historyDigest, message })
        this.liveErrors = this.liveErrors.slice(-MAX_ENTRIES)
      }
    }
    this.entries = this.transcriptEntries(result.history)
    this.resultNotices = []
    if (partial !== undefined) this.resultNotices.push({ category: 'assistant', label: 'Partial display only · response was not accepted', content: partial, markdown: true })
    if (result.error && this.sessionId === undefined) this.resultNotices.push({ category: 'activity', attention: true, label: 'Error', content: this.safe(result.error.message), markdown: false })
    this.entries.push(...this.resultNotices)
    this.rebuild()
    if (result.contextUsage && !this.contextUsage) this.contextUsage = { ...result.contextUsage }
    this.updateStatus(result.status === 'completed' ? 'Completed' : result.status === 'cancelled' ? 'Cancelled' : 'Error')
  }
  private dispose(destroyRenderer: boolean): void {
    if (this.closed) return
    if (this.loadingTimer !== undefined) clearInterval(this.loadingTimer)
    this.loadingTimer = undefined
    this.hover.clear()
    if (this.steering) this.releaseSteering(this.steering)
    this.steeringQueue = []
    this.closed = true
    if (this.copyToastTimer !== undefined) clearTimeout(this.copyToastTimer)
    this.copyToastTimer = undefined
    if (this.processTimer !== undefined) clearInterval(this.processTimer)
    this.processTimer = undefined; this.processControls = undefined; this.processStopping = new Map()
    this.inputQueue.close()
    this.dialogOwner.abort()
    this.suspendedChat?.pending.finish(undefined)
    this.runStatus.reset()
    // Pending input is settled before the native widgets disappear.
    this.pending?.finish(undefined)
    this.controls?.close(); this.controls = undefined
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
    this.renderer.off(CliRenderEvents.SELECTION, this.selectionHandler)
    this.clipboardRead?.abort()
    this.imagePathRead?.abort()
    this.imageSourceController.abort(); this.resultImageBytes.clear()
    void this.clipboard?.dispose().catch(() => undefined)
    void this.imagePreview.dispose().catch(() => undefined)
    this.renderer.off(CliRenderEvents.RENDER_ERROR, this.errorHandler)
    this.renderer.off(CliRenderEvents.HANDLER_ERROR, this.errorHandler)
    process.off('SIGINT', this.signalHandler)
    process.off('SIGTERM', this.exitHandler)
    process.off('SIGHUP', this.exitHandler)
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
  private restoreTerminalTitle(): void {
    this.terminalTitle.close()
    this.programStatus.close()
    // Keep this finalizer while native destruction is deferred. A synchronous
    // exit immediately after close still needs the final title-stack pop.
    process.off('exit', this.processExitHandler)
  }
  close(): void { this.dispose(true) }
}
