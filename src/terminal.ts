// SPDX-License-Identifier: Apache-2.0
import { createInterface, emitKeypressEvents } from 'node:readline'
import { randomUUID } from 'node:crypto'
import type { Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import type { AgentEvent, AgentResult, ContextUsage } from '@ayayaq/vivi'
import type { QuestionRequest, QuestionResponse } from '@ayayaq/vivi/extensions/questions'
import type { CliHost } from './host.js'
import { bindBackgroundProcessControls, runProcessControl } from './process-controls.js'
import type { BackgroundProcessControls } from './process-controls.js'
import type { SteeringControls, SteeringMessage } from './steering.js'
import type { MemoryChangeRequest } from './host.js'
import { redactSecrets } from './session.js'
import type { ApprovalRequest } from './tools.js'
import { aggregateUsage, formatUsage } from './usage.js'
import type { RunOutcome } from './run-status.js'
import { formatContextDetails, formatContextSummaryUsage } from './context-status.js'
import { sessionDisplayTitle } from './session-display.js'
import type { ApprovalMode, ReviewNotice } from './auto-review.js'
import { DEEPSEEK_WEB_DISCLOSURE } from './web-tools.js'
import { autoReviewSharingScope } from './auto-review.js'
import { resolveAutoReviewThreshold, formatAutoReviewThreshold } from './auto-review-settings.js'
import type { AutoReviewThresholdOverrides } from './auto-review-settings.js'
import { COMMAND_DISCLOSURE } from './commands.js'
import { parseUserShellInput, USER_SHELL_DISCLOSURE } from './user-shell.js'
import type { CliToolEvidence } from './tool-presentation.js'
import type { CliConversationErrors } from './conversation-errors.js'
import { conversationModeLabel } from './task-mode.js'
import type { ConversationMode, TaskMode } from './task-mode.js'

export interface ChatIO {
  /** Independent cleanup controls remain available during inference and dialogs. */
  onProcessControls?(controls: BackgroundProcessControls): () => void
  /** Dynamic credentials must reach copied display filters before any further output. */
  addSecrets?(secrets: readonly string[]): void
  /** Scoped actual-turn composer; managers and approvals never become steering sources. */
  onSteering?(controls: SteeringControls): () => void
  setSteeringQueue?(messages: readonly SteeringMessage[]): void
  steeringAccepted?(content: string, initial?: boolean): void
  setComposerDraft?(content: string): void
  /** Display-only host evidence, re-screened by the consumer before rendering. */
  setToolEvidence?(evidence: CliToolEvidence): void
  /** Persisted display-only host errors, not provider messages or tool outcomes. */
  setConversationErrors?(errors: CliConversationErrors): void
  setContext?(usage: ContextUsage | undefined, canCompact?: boolean): void
  /** Fatal native UI failure means output should go to stderr after terminal restoration. */
  readonly failed?: boolean
  readonly isClosed?: boolean
  /** Enrollment requires a real interactive approval surface; omitted means unavailable. */
  readonly canAutoReview?: boolean
  /** A genuine human question surface. Piped/headless and line-only flows are unavailable. */
  readonly canAskQuestions?: boolean
  askQuestions?(request: QuestionRequest, signal: AbortSignal): Promise<QuestionResponse>
  setApprovalMode?(mode: ApprovalMode): void
  setTaskMode?(mode: TaskMode): void
  /** Optional safe display sink that survives canonical transcript refresh. */
  reviewNotice?(message: string, context?: ReviewNotice): void
  /** Optional visual run lifecycle. Generic cancellation listeners also cover non-turn dialogs. */
  runStarted?(): void
  runFinished?(outcome: RunOutcome): void
  readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined>
  write(text: string): void
  event(event: AgentEvent): void
  result(result: AgentResult): void
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>
  onCancel(callback: () => void): () => void
  close(): void
}

/** Share explicit turn boundaries across interactive, one-shot and accessible line flows. */
export async function sendChatTurn(host: CliHost, io: ChatIO, content: string, signal?: AbortSignal,
  queuedId?: string): Promise<AgentResult> {
  const shell = queuedId === undefined && parseUserShellInput(content) !== undefined
  // Only live user submission is parsed. Stored continuation envelopes and raw
  // host.send() inputs are data, not executable instructions.
  if (shell) {
    try { const queued = host.queueUserShell(content); queuedId = queued.id }
    catch (error) { io.setComposerDraft?.(content); throw error }
    const first = host.queuedMessages[0]!
    content = first.content; queuedId = first.id
  }
  // A later idle submit joins retained input instead of overtaking it.
  if (queuedId === undefined && host.queuedMessages?.length) {
    try { host.queueMessage(content) }
    catch (error) { io.setComposerDraft?.(content); throw error }
    const first = host.queuedMessages[0]!
    content = first.content; queuedId = first.id
  }
  let interrupt = false, active = true
  const update = (): void => io.setSteeringQueue?.(host.queuedMessages ?? [])
  const dispose = io.onSteering?.({
    submit: (message, force): boolean => {
      if (!active || io.isClosed || signal?.aborted) return false
      try { if (parseUserShellInput(message) !== undefined) host.queueUserShell(message); else host.queueMessage(message) }
      catch (error) {
        io.write(`${error instanceof Error ? error.message : 'Message was not queued'}\n`)
        return false
      }
      update()
      if (force) { interrupt = true; host.cancel() }
      return true
    },
    takeLast: (): string | undefined => { const message = host.takeLastQueuedMessage(); update(); return message },
    clear: (): void => { host.clearQueuedMessages(); update() }
  })
  update()
  try {
    let next = { content, id: queuedId }
    for (;;) {
      let outcome: RunOutcome = 'error'
      let result: AgentResult
      try {
        io.setApprovalMode?.(host.approvalMode)
        io.setToolEvidence?.(host.toolPresentationEvidence)
        io.setConversationErrors?.(host.conversationErrors)
        io.runStarted?.()
        const accepted = (message: string, initial?: boolean): void => { io.steeringAccepted?.(message, initial); update() }
        const pending = host.queuedMessages?.[0]
        result = pending !== undefined && pending.id === next.id && pending.kind === 'shell'
          ? await host.sendUserShell(pending.id, signal, accepted, update, context => io.write(`Shell result · untrusted output\n${context}\n`))
          : await host.send(next.content, signal, accepted, next.id, update)
        outcome = result.status
      } catch (error) { if (signal?.aborted) outcome = 'cancelled'; throw error }
      finally {
        io.setToolEvidence?.(host.toolPresentationEvidence)
        io.setConversationErrors?.(host.conversationErrors)
        await refreshChatContext(host, io); io.setApprovalMode?.(host.approvalMode); io.runFinished?.(outcome); update()
      }
      const pending = host.queuedMessages?.[0]
      // Ordinary cancel/error leaves input visibly queued. Explicit interrupt and
      // final-boundary overflow may continue only after the host has fully settled.
      if (!pending || io.isClosed || signal?.aborted ||
        result.status !== 'completed' && !(result.status === 'cancelled' && interrupt)) return result
      interrupt = false
      io.result(result)
      next = { content: pending.content, id: pending.id }
    }
  } finally { active = false; dispose?.(); update() }
}

/** Idle queue control stays with the current host and never changes an account. */
export async function runSteeringCommand(host: CliHost, io: ChatIO, line: string): Promise<boolean> {
  if (!/^\/queue(?:\s|$)/.test(line.trim())) return false
  const command = line.trim()
  if (command === '/queue clear') host.clearQueuedMessages()
  else if (command === '/queue undo') {
    if (io.setComposerDraft) {
      const content = host.takeLastQueuedMessage()
      if (content !== undefined) io.setComposerDraft(content)
    } else io.write('Editing queued input requires the full-screen composer; use /queue clear\n')
  } else if (command === '/queue send') {
    const message = host.queuedMessages[0]
    if (message) {
      const controller = new AbortController()
      const dispose = io.onCancel(() => { controller.abort(); host.cancel() })
      try { io.result(await sendChatTurn(host, io, message.content, controller.signal, message.id)) }
      finally { dispose() }
    }
  } else if (command !== '/queue') io.write('Use /queue, /queue send, /queue undo or /queue clear\n')
  io.setSteeringQueue?.(host.queuedMessages)
  io.write(host.queuedMessages.length ? `Queued messages (${host.queuedMessages.length}):\n` : 'No queued messages\n')
  for (const [index, message] of host.queuedMessages.entries()) io.write(`${index + 1}. ${JSON.stringify(message.content)}${message.state ? ' (sending)' : ''}\n`)
  if (host.queuedMessages.length) io.write('/queue send · send; /queue undo · edit latest; /queue clear · remove pending input\n')
  return true
}
/** Refresh uses only local snapshots and a pure estimator; it never calls a provider. */
export async function refreshChatContext(host: CliHost, io: ChatIO): Promise<void> {
  if ((io instanceof TerminalIO ? io.isDisposed : io.isClosed) || host.running) return
  try { await host.refreshContext?.(); io.setContext?.(host.contextUsage, host.canCompact) }
  catch { io.setContext?.(undefined, false) }
}

export async function compactChatContext(host: CliHost, io: ChatIO): Promise<RunOutcome> {
  await refreshChatContext(host, io)
  if (!host.canCompact) { io.write('No older complete conversation to compact yet\n'); return 'completed' }
  const controller = new AbortController(), dispose = io.onCancel(() => { controller.abort(); host.cancel() })
  let outcome: RunOutcome = 'error'
  try {
    io.runStarted?.()
    await host.compact(controller.signal)
    outcome = 'completed'
    io.write('Context compacted; full transcript retained\n')
  } catch (error) {
    if (controller.signal.aborted) { outcome = 'cancelled'; io.write('Context compaction cancelled; full transcript retained\n') }
    else throw error
  } finally { dispose(); await refreshChatContext(host, io); io.runFinished?.(outcome) }
  return outcome
}

export interface TerminalOptions {
  input?: Readable
  output?: Writable
  tui?: boolean
  stream?: boolean
  secrets?: readonly string[]
}
export const MEMORY_DISCLOSURE = 'Saved memories are plaintext in this CLI’s local state directory and are sent to the selected provider when enabled. Manual is the default; eligible current-request create/edit tool calls may use enrolled Auto review. Explicit session-only Skip permissions bypasses ordinary agent create/edit/delete prompts with no human or AI review. Manager changes still require human allow/deny review. Disabling retains existing records.'
export const AUTO_REVIEW_UNAVAILABLE = 'Auto review requires an interactive terminal with fresh human enrollment. Using Manual; piped, headless and unavailable approval surfaces cannot enroll.'

/** Human controls proposal availability; exact execution approval is always separate. */
export async function runCommandControl(host: CliHost, io: ChatIO, line: string): Promise<boolean> {
  const command = line.trim()
  if (!/^\/commands(?:\s|$)/.test(command)) return false
  const action = command.replace(/^\/commands\s*/, '') || 'status'
  if (action === 'off') { await host.disableCommands(); io.write('Trusted commands disabled for this launch/session\n'); return true }
  if (action === 'on') {
    if (io.canAutoReview !== true || io.isClosed) { io.write('Trusted commands remain disabled: interactive human approval is required\n'); return true }
    const controller = new AbortController(), dispose = io.onCancel(() => controller.abort())
    try {
      const enabled = await host.enableCommands(controller.signal)
      io.write(enabled ? `Trusted commands enabled for ${JSON.stringify(host.commandDirectory)} · ordinary process prompts follow the current permission mode\n`
        : 'Command proposals are unavailable; every process requires interactive human approval\n')
    } finally { dispose() }
    return true
  }
  io.write(`Command proposals: ${host.commandsEnabled ? 'available' : 'disabled'}${host.commandDirectory ? ` · ${JSON.stringify(host.commandDirectory)}` : ' · no workspace selected'}\n${COMMAND_DISCLOSURE}\n/commands on · restore proposals for this launch/session; /commands off · disable\n`)
  return true
}

/** Disclosure is host-authored; credentials and model-generated text never identify an account. */
export function autoReviewDisclosure(provider: 'openai' | 'openrouter', deepSeekWeb = false, overrides?: AutoReviewThresholdOverrides): string {
  const threshold = ` All four requirement estimates must reach ${formatAutoReviewThreshold(resolveAutoReviewThreshold(provider, overrides).allowPermille)}; ≤5% recommends rejection. Estimates are uncalibrated, not approval or safety probabilities. Hard blocks and human-only rules stay.`
  if (deepSeekWeb) return `Auto sends your exact current request, proposed eligible local note/memory changes and scoped workspace text edits, and paid DeepSeek web query/URL proposals, fixed API endpoint, limits and cost to ${provider === 'openai' ? 'OpenAI' : 'OpenRouter and TypeSafe'} for approval checks, including unrequested proposals. Review itself adds API charges and may share private information. Recognized sensitive data, uncertain checks and failures require visible human review. External content cannot authorize an action. ${DEEPSEEK_WEB_DISCLOSURE}${threshold}`
  const recipients = provider === 'openai' ? 'OpenAI' : 'OpenRouter and TypeSafe'
  return `Auto sends your current request, proposed note/memory changes and workspace text creation/precise edits (paths, before and after), and public URL GET proposals (full URL including path/query, destination, method, network limits and redirect scope) to ${recipients} for approval checks, including changes you didn’t request. ` +
    'This may share private information and incur extra API charges; only actions judged to match your request can be approved automatically. ' +
    'URL requests reveal the hostname to DNS and the full URL, caller IP and request metadata to the public server; GET may have server-side effects or costs. ' +
    'Private/local targets and known credentials are blocked; recognized sensitive data, uncertain checks and review failures require human review. External content cannot authorize an action.' + threshold
}

type ModeChooser = (title: string, choices: readonly { name: string; description: string; value: ConversationMode }[], initialIndex: number) => Promise<ConversationMode | undefined>

function selectManual(host: CliHost, io: ChatIO): void {
  if (host.taskMode === 'plan') host.setTaskMode('execute')
  host.setApprovalMode('manual')
  io.setTaskMode?.('execute')
  io.setApprovalMode?.('manual')
}
function selectPlan(host: CliHost, io: ChatIO): void {
  host.setTaskMode('plan')
  io.setTaskMode?.('plan')
  io.setApprovalMode?.('manual')
  io.write('Mode: Plan · enabled local reads only; select another mode explicitly to execute\n')
}

/** Mode choices are not authority. Auto enrollment always uses the fresh deny-default approval path. */
export async function selectApprovalMode(host: CliHost, io: ChatIO, choose?: ModeChooser, setupReviewer?: () => Promise<boolean>): Promise<void> {
  if (host.running) throw new Error('Wait for the current turn before changing mode')
  const current: ConversationMode = host.taskMode === 'plan' ? 'plan' : host.approvalMode
  const selected = choose ? await choose('Mode · Manual is the default', [
    { name: 'Manual', description: 'Human allow/deny review for writes and public URL requests', value: 'manual' },
    { name: 'Auto review', description: 'Check proposed note, memory, workspace text and public URL GET actions through your selected provider', value: 'auto' },
    { name: 'Skip permissions', description: 'Explicit session-only opt-in; skip ordinary prompts with no human or AI review', value: 'skip' },
    { name: 'Plan', description: 'Investigate with enabled local reads and describe a plan; no task changes or remote requests', value: 'plan' }
  ], ['manual', 'auto', 'skip', 'plan'].indexOf(current)) : 'auto'
  if (selected === undefined || (choose && io.isClosed)) return
  if (selected === 'plan') { selectPlan(host, io); return }
  if (selected === 'skip') { await enrollSkipPermissions(host, io, current === 'plan'); return }
  if (selected !== 'auto') { selectManual(host, io); io.write('Approval mode: Manual\n'); return }
  // Leaving Plan for Auto is contingent on successful fresh enrollment. While
  // consent is pending, Plan remains the task policy even if its dialog closes.
  const fromPlan = current === 'plan'
  if (fromPlan) host.setApprovalMode('manual')
  else selectManual(host, io)
  if (io.canAutoReview !== true || io.isClosed) {
    io.write(`${fromPlan ? AUTO_REVIEW_UNAVAILABLE.replace('Using Manual;', 'Plan remains active;') : AUTO_REVIEW_UNAVAILABLE}\n`)
    return
  }
  if (!host.reviewProvider && setupReviewer) await setupReviewer()
  const reviewer = host.reviewProvider
  if (!reviewer) { io.write('Choose an OpenAI or OpenRouter reviewer explicitly with /reviewer before enrolling Auto. DeepSeek chat does not inherit another account.\n'); return }
  const deepSeekWeb = host.webProvider === 'deepseek'
  const disclosure = autoReviewDisclosure(reviewer, deepSeekWeb, host.autoReviewThresholds)
  const binding = host.approvalEnrollmentBinding
  io.write(fromPlan ? 'Mode: Plan · Auto review requires fresh enrollment; cancel keeps Plan\n' : 'Approval mode: Manual\n')
  const controller = new AbortController()
  const dispose = io.onCancel(() => controller.abort())
  try {
    const enrolled = await io.approve({ call: { id: randomUUID(), name: 'enroll_auto_review', arguments: {
      mode: 'auto', provider: reviewer, sessionId: host.session.id,
      thresholds: resolveAutoReviewThreshold(reviewer, host.autoReviewThresholds),
      reviewDataSharing: autoReviewSharingScope(reviewer, deepSeekWeb), ...(binding ? { enrollmentBinding: binding } : {})
    } }, currentRevision: 'fresh Auto review enrollment',
    description: disclosure }, controller.signal)
    if (enrolled && !controller.signal.aborted && !io.isClosed && io.canAutoReview === true && binding === host.approvalEnrollmentBinding) {
      try {
        if (fromPlan) host.setTaskMode('execute')
        host.setApprovalMode('auto')
      } catch (error) {
        // A suspended ledger or unavailable enrollment cannot relax Plan's
        // task policy after the human confirmation. No await/effect lies between
        // these setters; restore the policy before propagating the failure.
        if (fromPlan && host.taskMode === 'execute') host.setTaskMode('plan')
        io.setTaskMode?.(host.taskMode ?? 'execute')
        io.setApprovalMode?.(host.approvalMode)
        throw error
      }
      io.setTaskMode?.('execute')
      io.setApprovalMode?.('auto')
      io.write('Approval mode: Auto review · enrolled for this conversation and selected account\n')
    } else {
      const changed = binding !== host.approvalEnrollmentBinding
      // A stale dialog cannot override a newer explicit mode choice.
      if (!changed) host.setApprovalMode('manual')
      io.setTaskMode?.(host.taskMode ?? 'execute')
      io.setApprovalMode?.(host.approvalMode)
      const label = conversationModeLabel(host.taskMode, host.approvalMode)
      io.write(changed ? `Mode: ${label}. Enrollment changed; open /mode for a fresh confirmation\n` : `Mode: ${label}\n`)
    }
  } finally { dispose() }
}

export const SKIP_PERMISSIONS_DISCLOSURE = 'Skip permissions is session-only and skips ordinary approval prompts for enabled host-prepared local note/memory and workspace changes, public URL requests and configured paid web requests, trusted commands, and calls or resource reads on already-connected MCP servers. There is no human or AI review of those actions. Remote requests disclose their arguments and can have effects or costs. Trusted commands are unsandboxed: they run with your OS account’s file and network access, can act outside the workspace, and can read credential files your account can access. Existing hard denials, workspace/path and known-credential protections, tool validation, cancellation and session isolation remain; this does not grant OS privileges or add a sandbox. Skill installation, MCP setup/connections/sign-in and credential/trust administration still require human action. This enrollment is not saved; changing account, workspace or trust revokes it. Enable only for a task and environment you trust.'

async function enrollSkipPermissions(host: CliHost, io: ChatIO, fromPlan: boolean): Promise<void> {
  if (fromPlan) host.setApprovalMode('manual')
  else selectManual(host, io)
  if (io.canAutoReview !== true || io.isClosed) {
    io.write(`Skip permissions requires a live interactive terminal and fresh confirmation. ${fromPlan ? 'Plan remains active' : 'Using Manual'}; piped and headless launches cannot enroll.\n`)
    return
  }
  const binding = host.approvalEnrollmentBinding
  const controller = new AbortController(), dispose = io.onCancel(() => controller.abort())
  try {
    const enrolled = await io.approve({ call: { id: randomUUID(), name: 'enroll_skip_permissions', arguments: {
      mode: 'skip', sessionId: host.session.id, enrollmentBinding: binding
    } }, currentRevision: 'fresh session-only Skip permissions enrollment', description: SKIP_PERMISSIONS_DISCLOSURE }, controller.signal)
    const changed = binding !== host.approvalEnrollmentBinding
    if (enrolled && !changed && !controller.signal.aborted && !io.isClosed && io.canAutoReview === true) {
      try {
        if (fromPlan) host.setTaskMode('execute')
        host.setApprovalMode('skip')
      } catch (error) {
        if (fromPlan && host.taskMode === 'execute') host.setTaskMode('plan')
        io.setTaskMode?.(host.taskMode); io.setApprovalMode?.(host.approvalMode)
        throw error
      }
      io.setTaskMode?.('execute'); io.setApprovalMode?.('skip')
      io.write('Approval mode: Skip permissions · session-only; no human or AI review of ordinary actions\n')
    } else {
      if (!changed) host.setApprovalMode('manual')
      io.setTaskMode?.(host.taskMode); io.setApprovalMode?.(host.approvalMode)
      io.write(`Mode: ${conversationModeLabel(host.taskMode, host.approvalMode)}${changed ? '. Enrollment changed; open /mode for a fresh confirmation' : ''}\n`)
    }
  } finally { dispose() }
}

/** Manual -> freshly enrolled Auto -> Plan -> Manual. No task implicitly leaves Plan. */
export async function cycleApprovalMode(host: CliHost, io: ChatIO, setupReviewer?: () => Promise<boolean>): Promise<void> {
  if (host.running) throw new Error('Wait for the current turn before changing mode')
  if (host.taskMode === 'plan') {
    selectManual(host, io)
    io.write('Approval mode: Manual\n')
    return
  }
  if (host.approvalMode === 'auto' || host.approvalMode === 'skip') {
    selectPlan(host, io)
    return
  }
  await selectApprovalMode(host, io, undefined, setupReviewer)
}
/** Direct Plan/Manual choices require no enrollment; Auto still uses /mode's fresh confirmation. */
export async function runModeControl(host: CliHost, io: ChatIO, line: string, choose?: ModeChooser, setupReviewer?: () => Promise<boolean>): Promise<void> {
  if (host.running) throw new Error('Wait for the current turn before changing mode')
  switch (line.trim()) {
    case '/mode plan': selectPlan(host, io); return
    case '/mode manual': selectManual(host, io); io.write('Approval mode: Manual\n'); return
    case '/mode cycle': await cycleApprovalMode(host, io, setupReviewer); return
    case '/mode skip': await selectApprovalMode(host, io, async () => 'skip', setupReviewer); return
    case '/mode': await selectApprovalMode(host, io, choose, setupReviewer); return
    default: io.write('Use /mode by itself for a fresh Manual / Auto review / Skip permissions / Plan choice, /mode skip, /mode plan, /mode manual, or /mode cycle\n')
  }
}
export const SKILLS_DISCLOSURE = 'Skills are instruction-only standard SKILL.md files in this CLI’s app-wide local store. Metadata and selected text are sent to your provider when enabled. Creator drafts can be saved to the app-owned SQLite installed store after exact-content human review, including in Auto and Skip permissions modes; changes are available next turn. Plan and noninteractive launches cannot save. Legacy folders and bundled skills remain read-only; scripts and binary assets are never executed. Extra --skills-dir roots are read-only. No workspace skills are loaded automatically.'
const MEMORY_COMMAND_HELP = `/memories list · show IDs, revisions and content
/memories add TEXT · review a new saved memory
/memories edit ID REVISION TEXT · review an edit to the displayed revision
/memories delete ID REVISION · review deletion of the displayed revision
/memories on · enable for this launch; /memories off · disable without deleting\n`

export function displayMemories(io: Pick<ChatIO, 'write'>, result: Awaited<ReturnType<CliHost['listMemories']>>): void {
  io.write(result.memories.length ? `Saved memories (${result.memories.length}):\n` : 'No saved memories\n')
  for (const memory of result.memories) {
    // JSON quoting makes each record's content visibly distinct from IDs and commands.
    io.write(`ID ${memory.id} · revision ${memory.revision}\n${JSON.stringify(memory.content)}\n`)
  }
  io.write(`Limits: ${result.limits.maximumMemories} memories, ${result.limits.maximumMemoryCharacters} characters each, ${result.limits.maximumTotalCharacters} total characters\n`)
}

/** Explicit human management uses the same exact-proposal approval as model-requested writes. */
export async function reviewMemoryChange(host: CliHost, io: ChatIO, request: MemoryChangeRequest): Promise<void> {
  const controller = new AbortController()
  const dispose = io.onCancel(() => controller.abort())
  try {
    const result = await host.changeMemory(request, controller.signal)
    if (result === undefined) io.write('Memory change denied; no records changed\n')
    else if (result.contentWithheld) io.write('Memory change committed; contents were withheld after a credential was detected\n')
    else {
      io.write(`Memory ${request.kind === 'create' ? 'saved' : request.kind === 'update' ? 'updated' : 'deleted'}\n`)
      displayMemories(io, result)
    }
  } finally { dispose() }
}

/** Accessible command surface; no command text is ever treated as a provider prompt. */
export async function runMemoryCommand(host: CliHost, io: ChatIO, line: string): Promise<boolean> {
  const command = line.trim()
  if (!/^\/memories(?:\s|$)/.test(command)) return false
  const match = /^\/memories(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(command)!
  const action = match[1] ?? 'list'
  const input = match[2] ?? ''
  if (action === 'on' && !input) {
    host.setMemoryEnabled(true)
    io.write(`Memory enabled for this launch\n${MEMORY_DISCLOSURE}\n`)
    return true
  }
  if (action === 'off' && !input) {
    host.setMemoryEnabled(false)
    io.write('Memory disabled for this launch; existing records retained\n')
    return true
  }
  if (action === 'help') { io.write(`${MEMORY_DISCLOSURE}\n${MEMORY_COMMAND_HELP}`); return true }
  if (!host.memoryEnabled) {
    io.write(`Memory is disabled. Use /memories on to enable it for this launch\n${MEMORY_DISCLOSURE}\n`)
    return true
  }
  if (action === 'list' && !input) {
    io.write(`${MEMORY_DISCLOSURE}\n`)
    displayMemories(io, await host.listMemories())
    io.write(MEMORY_COMMAND_HELP)
  } else if (action === 'add' && input) {
    await reviewMemoryChange(host, io, { kind: 'create', content: input })
  } else if (action === 'edit' || action === 'delete') {
    const fields = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(input)
    if (!fields || (action === 'edit' ? !fields[3] : fields[3] !== undefined)) {
      io.write(MEMORY_COMMAND_HELP)
      return true
    }
    await reviewMemoryChange(host, io, action === 'edit'
      ? { kind: 'update', id: fields[1]!, expectedRevision: fields[2]!, content: fields[3]! }
      : { kind: 'delete', id: fields[1]!, expectedRevision: fields[2]! })
  } else io.write(MEMORY_COMMAND_HELP)
  return true
}
export async function runInstructionsCommand(host: CliHost, io: Pick<ChatIO, 'write'>, line: string): Promise<boolean> {
  if (!/^\/instructions(?:\s|$)/.test(line.trim())) return false
  const action = line.trim().split(/\s+/).slice(1)
  if (action.length > 1 || !['status', 'reload', 'disable'].includes(action[0] ?? 'status')) {
    io.write('/instructions status · show loaded sources and errors\n/instructions reload · refresh active guidance now\n/instructions disable · disable for this launch (restart to re-enable)\n')
    return true
  }
  if (action[0] === 'disable') host.disableInstructions()
  else await host.reloadInstructions()
  io.write(`${host.instructionsStatus}\n`)
  return true
}
const SKILLS_COMMAND_HELP = '/skills list · names, descriptions, revisions and diagnostics\n/skills inspect NAME · exact SKILL.md\n/skills create DESCRIPTION · draft a standard skill and request human-reviewed saving\n/skills on · enable for this launch; /skills off · disable without deleting\n'
export function displaySkills(io: Pick<ChatIO, 'write'>, catalog: Awaited<ReturnType<CliHost['listSkills']>>, diagnostics: readonly string[] = []): void {
  io.write(`Skills (${catalog.skills.length}):\n`)
  for (const skill of catalog.skills) io.write(`${JSON.stringify(skill.name)} · ${skill.readOnly ? 'read only' : 'owned store'} · revision ${skill.revision}\n${JSON.stringify(skill.description)}\n`)
  for (const diagnostic of diagnostics) io.write(`Skill diagnostic: ${diagnostic}\n`)
}
export function skillCreationPrompt(description: string): string {
  return `Use the bundled skill-creator to draft an ordinary instruction-only SKILL.md for this request: ${description}\nShow the exact draft, keep it limited to available tools, propose honest example checks, and request save_skill for explicit human review if available. Never claim it is saved before the successful save result; the skill becomes available next turn. Do not create scripts/resources, run commands, install dependencies or claim unrun evaluations.`
}
export async function runSkillsCommand(host: CliHost, io: ChatIO, line: string): Promise<boolean> {
  if (!/^\/skills(?:\s|$)/.test(line.trim())) return false
  const match = /^\/skills(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(line.trim())!
  const action = match[1] ?? 'list'
  const input = match[2] ?? ''
  if ((action === 'on' || action === 'off') && !input) {
    host.setSkillsEnabled(action === 'on')
    io.write(`Skills ${host.skillsEnabled ? 'enabled' : 'disabled'} for this launch\n`)
  } else if (action === 'help') io.write(`${SKILLS_DISCLOSURE}\n${SKILLS_COMMAND_HELP}`)
  else if (!host.skillsEnabled) io.write('Skills are disabled. Use /skills on to enable them\n')
  else if (action === 'list' && !input) {
    io.write(`${SKILLS_DISCLOSURE}\n`)
    displaySkills(io, await host.listSkills(), host.skillsDiagnostics)
    io.write(SKILLS_COMMAND_HELP)
  } else if (action === 'inspect' && input && !/\s/.test(input)) {
    io.write(`SKILL.md ${JSON.stringify(input)} (exact source, inert text):\n${JSON.stringify(await host.readSkill(input))}\n`)
  } else if (action === 'create' && input) {
    const dispose = io.onCancel(() => host.cancel())
    try { io.result(await sendChatTurn(host, io, skillCreationPrompt(input))) } finally { dispose() }
  } else io.write(SKILLS_COMMAND_HELP)
  return true
}
type TtyReadable = Readable & { isTTY?: boolean }
type TtyWritable = Writable & { isTTY?: boolean; rows?: number; columns?: number }

/** Node builtins only; the renderer never turns display text into accepted transcript content. */
export class TerminalIO implements ChatIO {
  private readonly input: TtyReadable
  private readonly output: TtyWritable
  private readonly readline: Interface
  private secrets: readonly string[]
  private readonly tui: boolean
  private readonly stream: boolean
  private lines: string[] = []
  private waiters: { resolve(value: string | undefined): void; reject(error: Error): void }[] = []
  private ended = false
  private disposed = false
  private cancelCallbacks = new Set<() => void>()
  private steeringControls: SteeringControls | undefined
  private processControls: BackgroundProcessControls | undefined
  private reviewing = false
  private display = ''
  private status = 'Ready'
  private prompt = ''
  private waiting = false
  private streamed = ''
  private streamedOffset = 0
  private streamOverflow = false
  private readonly keyHandler: (_text: string, key: { name?: string }) => void
  private readonly signalHandler: () => void
  get canAutoReview(): boolean { return Boolean(this.input.isTTY && this.output.isTTY && !this.disposed && !this.ended &&
    !this.input.destroyed && !this.output.destroyed && !this.output.writableEnded) }
  readonly canAskQuestions = false
  async askQuestions(request: QuestionRequest, _signal: AbortSignal): Promise<QuestionResponse> {
    this.write('Questions are unavailable in line mode; use the native interactive terminal UI\n')
    return { requestId: request.requestId, status: 'cancelled' }
  }
  get isClosed(): boolean { return this.disposed || this.ended }
  /** EOF can leave queued/prompt work to consume; disposal ends the launch. */
  get isDisposed(): boolean { return this.disposed }
  constructor(options: TerminalOptions = {}) {
    this.input = options.input ?? process.stdin
    this.output = options.output ?? process.stdout
    this.secrets = options.secrets ?? []
    this.tui = Boolean(options.tui && this.input.isTTY && this.output.isTTY)
    this.stream = options.stream ?? true
    this.readline = createInterface({ input: this.input, output: this.output, terminal: Boolean(this.input.isTTY && this.output.isTTY),
      historySize: 0, removeHistoryDuplicates: true, crlfDelay: Infinity })
    this.readline.on('line', (line: string) => {
      if (this.steeringControls && this.canAutoReview && !this.reviewing && !this.waiters.length) {
        const interrupt = /^\/interrupt\s+/.test(line)
        const content = interrupt ? line.replace(/^\/interrupt\s+/, '') : line
        if (!this.steeringControls.submit(content, interrupt)) { this.readline.write(content); this.write('Message was not queued; draft kept\n') }
        return
      }
      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(line.length <= 65536 ? line : '')
      else if (this.lines.length < 32 && line.length <= 65536) this.lines.push(line)
    })
    this.readline.on('close', () => {
      this.ended = true
      // Interactive EOF revokes an enrolled run. Preserve ordinary piped read-only
      // completion: a closed pipe was never an Auto review authority surface.
      if (this.input.isTTY && this.output.isTTY) for (const callback of [...this.cancelCallbacks]) {
        try { callback() } catch { /* Closing must still settle every input waiter. */ }
      }
      for (const waiter of this.waiters.splice(0)) waiter.resolve(undefined)
    })
    const cancel = (): void => {
      // Do not carry a half-typed approval into a later chat or approval prompt.
      if (!this.steeringControls || this.reviewing) this.clearEditableInput()
      if (this.cancelCallbacks.size) for (const callback of this.cancelCallbacks) callback()
      else this.close()
    }
    this.readline.on('SIGINT', cancel)
    this.signalHandler = cancel
    process.on('SIGINT', this.signalHandler)
    emitKeypressEvents(this.input, this.readline)
    this.keyHandler = (_text, key): void => {
      if (this.canAutoReview && this.processControls && (key.name === 'f6' || key.name === 'f7')) {
        if (key.name === 'f7') void this.processControls.stopAll()
        else { const job = [...this.processControls.list()].reverse().find(job => !job.cleanupConfirmed); if (job) void this.processControls.stop(job.executionId) }
      } else if (key.name === 'escape') cancel()
    }
    this.input.on('keypress', this.keyHandler)
    if (this.tui) this.output.write('\x1b[?1049h')
  }
  addSecrets(secrets: readonly string[]): void {
    this.secrets = [...new Set([...this.secrets, ...secrets])].filter(Boolean)
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
  onProcessControls(controls: BackgroundProcessControls): () => void {
    this.processControls = controls
    return () => { if (this.processControls === controls) this.processControls = undefined }
  }
  onCancel(callback: () => void): () => void {
    this.cancelCallbacks.add(callback)
    return () => { this.cancelCallbacks.delete(callback) }
  }
  onSteering(controls: SteeringControls): () => void {
    if (!this.canAutoReview) return () => undefined
    this.steeringControls = controls
    this.write('Enter queues while working; /interrupt TEXT interrupts and queues a follow-up\n')
    return () => { if (this.steeringControls === controls) this.steeringControls = undefined }
  }
  setSteeringQueue(messages: readonly SteeringMessage[]): void {
    if (this.canAutoReview) this.status = messages.length ? `${messages.length} queued` : 'Working'
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
    } else if (event.type === 'compaction_started') {
      this.write('Compacting context…\n')
    } else if (event.type === 'compaction_failed') {
      this.write('Context compaction failed; full transcript retained\n')
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
    const steering = this.steeringControls
    const draft = steering ? this.readline.line : ''
    this.reviewing = true
    try {
    // An approval starts with fresh input, including text typed without a newline.
    this.lines = []
    this.clearEditableInput()
    const scope = request.currentRevision === 'new memory' ? 'new memory' : `revision ${request.currentRevision}`
    this.write(`Approval required (${scope}): ${request.description}\n`)
    // Piped or queued text cannot grant approval for an action that has not been shown yet.
    if (!this.input.isTTY || !this.output.isTTY) { this.write('Denied: interactive approval is required\n'); return false }
    for (;;) {
      const reply = await this.readLine('Type allow or deny: ', signal)
      if (reply === undefined || reply.trim().toLowerCase() === 'deny') return false
      if (reply.trim().toLowerCase() === 'allow') return true
      this.write('Please type allow or deny\n')
    }
    } finally {
      this.reviewing = false
      this.lines = []
      this.clearEditableInput()
      if (draft && this.canAutoReview && (!this.steeringControls || this.steeringControls === steering)) {
        this.readline.write(this.safe(draft))
      }
    }
  }
  close(): void {
    if (this.disposed) return
    this.disposed = true
    this.processControls = undefined
    this.steeringControls = undefined
    this.lines = []
    process.removeListener('SIGINT', this.signalHandler)
    this.input.removeListener('keypress', this.keyHandler)
    this.readline.close()
    if (this.tui) this.output.write('\x1b[?1049l')
  }
}

/** These controls are supplied by the launch owner, never exposed as model tools. */
interface UserChatControls { mcp?(): Promise<void>; web?(line: string): Promise<void>; reviewer?(line: string): Promise<void>; autoThreshold?(line: string): Promise<void> }

export function isMcpCommand(line: string): boolean { return /^\/mcp(?:\s|$)/.test(line.trim()) }

export async function runMcpCommand(io: ChatIO, line: string, controls: UserChatControls): Promise<boolean> {
  if (!isMcpCommand(line)) return false
  if (line.trim() !== '/mcp') io.write('Use /mcp by itself to manage reviewed server connections\n')
  else if (controls.mcp) await controls.mcp()
  else io.write('MCP connection management is unavailable in this chat surface\n')
  return true
}

export async function runChatLoop(host: CliHost, io: ChatIO, prompt?: string,
  controls: UserChatControls = {}): Promise<AgentResult | undefined> {
  const releaseProcesses = bindBackgroundProcessControls(host, io)
  try {
  if (host.skillsEnabled) io.write(`${SKILLS_DISCLOSURE}\n`)
  if (host.memoryEnabled) io.write(`Memory enabled for this launch\n${MEMORY_DISCLOSURE}\n`)
  if (host.commandsEnabled) io.write(`${USER_SHELL_DISCLOSURE}\n`)
  if (prompt !== undefined) {
    if (/^\/web(?:\s|$)/.test(prompt.trim())) { if (controls.web) await controls.web(prompt); return }
    if (/^\/reviewer(?:\s|$)/.test(prompt.trim())) { if (controls.reviewer) await controls.reviewer(prompt); return }
    if (/^\/auto-threshold(?:\s|$)/.test(prompt.trim())) { if (controls.autoThreshold) await controls.autoThreshold(prompt); return }
    if (prompt.trim() === '/compact') {
      const status = await compactChatContext(host, io)
      return { status, history: host.session.history, content: '', rounds: 0, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }
    }
    if (prompt.trim() === '/context') {
      await refreshChatContext(host, io); io.write(`${formatContextDetails(host.contextUsage)}\n`); return
    }
    if (await runProcessControl(host, io, prompt)) return
    if (await runMcpCommand(io, prompt, controls)) return
    const controller = new AbortController()
    const dispose = io.onCancel(() => { controller.abort(); host.cancel() })
    try {
      const result = await sendChatTurn(host, io, prompt, controller.signal)
      io.result(result)
      return result
    } finally { dispose() }
  }
  io.write('Enter a message; /exit quits, /session shows the session id, /context shows request capacity, /compact compacts older provider context, /rename NAME renames it, /mode selects Manual / Auto review / Skip permissions / Plan, /mode plan enters read-only planning, /memories manages saved context, /commands controls reviewed unsandboxed proposals, /processes manages background jobs (F6 Stop, F7 Stop All), /skills manages skills, /instructions shows project guidance, /mcp manages reviewed server connections\n')
  for (;;) {
    const line = await io.readLine('You: ')
    if (line === undefined || line.trim() === '/exit') return
    if (line.trim() === '/compact') {
      try { await compactChatContext(host, io) }
      catch (error) { io.write(`${error instanceof Error ? error.message : 'Context compaction failed'}\n`) }
      continue
    }
    if (line.trim() === '/context') {
      await refreshChatContext(host, io)
      io.write(`${formatContextDetails(host.contextUsage)}\n`)
      continue
    }
    if (line.trim() === '/session') {
      const session = host.session
      io.write(`Session: ${session.id}\nName: ${sessionDisplayTitle(session)}\nMode: ${conversationModeLabel(host.taskMode, host.approvalMode)}\nSession tokens: ${formatUsage(session.usage)}\n${formatContextSummaryUsage(session)}${formatContextDetails(host.contextUsage)}\n`)
      continue
    }
    if (!line.trim()) continue
    if (/^\/web(?:\s|$)/.test(line.trim())) { if (controls.web) await controls.web(line); else io.write('Web settings unavailable in this surface\n'); continue }
    if (/^\/reviewer(?:\s|$)/.test(line.trim())) { if (controls.reviewer) await controls.reviewer(line); else io.write('Reviewer settings unavailable in this surface\n'); continue }
    if (/^\/auto-threshold(?:\s|$)/.test(line.trim())) {
      try { if (controls.autoThreshold) await controls.autoThreshold(line); else io.write('Auto threshold settings unavailable in this surface\n') }
      catch (error) { io.write(`${error instanceof Error ? error.message : 'Auto threshold setting failed'}\n`) }
      continue
    }
    if (/^\/queue(?:\s|$)/.test(line.trim())) {
      try { await runSteeringCommand(host, io, line) }
      catch (error) { io.write(`${error instanceof Error ? error.message : 'Queued turn failed'}\n`) }
      continue
    }
    if (isMcpCommand(line)) {
      try { await runMcpCommand(io, line, controls) }
      catch (error) { io.write(`${error instanceof Error ? error.message : 'MCP connection management failed'}\n`) }
      finally { host.invalidateContext(); io.setContext?.(undefined, false) }
      continue
    }
    if (/^\/processes(?:\s|$)/.test(line.trim())) {
      try { await runProcessControl(host, io, line) }
      catch (error) { io.write(`${error instanceof Error ? error.message : 'Process cleanup unconfirmed'}\n`) }
      continue
    }
    if (/^\/commands(?:\s|$)/.test(line.trim())) {
      try { await runCommandControl(host, io, line) }
      catch (error) { io.write(`${error instanceof Error ? error.message : 'Trusted command setup failed'}\n`) }
      finally { host.invalidateContext(); io.setContext?.(undefined, false) }
      continue
    }
    if (/^\/mode(?:\s|$)/.test(line.trim())) {
      try { await runModeControl(host, io, line) }
      catch (error) { io.write(`${error instanceof Error ? error.message : 'Approval mode selection failed'}\n`) }
      finally { host.invalidateContext(); io.setContext?.(undefined, false) }
      continue
    }
    if (/^\/rename(?:\s|$)/.test(line.trim())) {
      const name = line.trim().replace(/^\/rename(?:\s+|$)/, '')
      if (!name) io.write('Use /rename NAME to name this session\n')
      else try { await host.renameSession(name, host.session.titleRevision ?? 0); io.write(`Session renamed: ${sessionDisplayTitle(host.session)}\n`) }
      catch (error) { io.write(`${error instanceof Error ? error.message : 'Session rename failed'}\n`) }
      continue
    }
    if (/^\/instructions(?:\s|$)/.test(line.trim())) {
      try { await runInstructionsCommand(host, io, line) }
      catch (error) { io.write(`${error instanceof Error ? error.message : 'Instruction management failed'}\n`) }
      finally { host.invalidateContext(); io.setContext?.(undefined, false) }
      continue
    }
    if (/^\/skills(?:\s|$)/.test(line.trim())) {
      try { await runSkillsCommand(host, io, line) }
      catch (error) { io.write(`${error instanceof Error ? error.message : 'Skill management failed'}\n`) }
      finally { host.invalidateContext(); io.setContext?.(undefined, false) }
      continue
    }
    if (/^\/memories(?:\s|$)/.test(line.trim())) {
      try { await runMemoryCommand(host, io, line) }
      catch (error) { io.write(`${error instanceof Error ? error.message : 'Memory management failed'}\n`) }
      finally { host.invalidateContext(); io.setContext?.(undefined, false) }
      continue
    }
    const controller = new AbortController()
    const dispose = io.onCancel(() => { controller.abort(); host.cancel() })
    try { io.result(await sendChatTurn(host, io, line, controller.signal)) }
    catch (error) { io.write(`${error instanceof Error ? error.message : 'CLI turn failed'}\n`) }
    finally { dispose() }
  }
  } finally { releaseProcesses() }
}
