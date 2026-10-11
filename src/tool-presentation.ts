// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import type { HistoryMessage, ToolCall, ToolResultMessage } from '@ayayaq/vivi'
import { agentArgumentsDigest } from '@ayayaq/vivi/events'
import type { AgentOutcomeEvidence, AgentProjection } from '@ayayaq/vivi/events'
import { decodeToolPresentation, toolPresentationView, TOOL_PRESENTATION_LIMITS } from '@ayayaq/vivi/presentation'
import type { ToolPresentation, ToolPresentationEffect, ToolPresentationStatus, ToolPresentationView } from '@ayayaq/vivi/presentation'
import { mcpContainsSecret } from './mcp-content.js'

/** Host-observed evidence only. A replay, result body or source string supplies no authority. */
export interface CliToolDecision {
  readonly requestIndex: number
  readonly callId: string
  readonly name: string
  readonly argumentsDigest: string
  readonly status: 'denied' | 'cancelled'
  readonly effect: 'not_attempted'
  readonly source: ToolPresentation['source']
}
export interface CliToolEvidence { readonly sessionId: string; readonly projection?: AgentProjection; readonly decisions?: readonly CliToolDecision[] }
export interface CliToolPresentationInput {
  readonly call: ToolCall
  readonly source: ToolPresentation['source']
  readonly status: ToolPresentationStatus
  readonly effect: ToolPresentationEffect
  readonly result?: ToolResultMessage
  readonly progress?: string
  readonly warnings?: readonly string[]
  readonly secrets?: readonly string[]
}
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8')
function clip(text: string, budget: number): string {
  let result = '', used = 0
  for (const point of text) { const size = bytes(point); if (used + size > budget) break; result += point; used += size }
  return result
}
function detail(text: string, limit: number): { kind: 'text'; text: string } {
  // JSON escaping can expand controls sixfold. Bound encoded section bytes, not UTF-16 length.
  let bounded = clip(text, Math.max(0, limit - 64))
  while (bytes(JSON.stringify({ kind: 'text', text: bounded })) > limit) bounded = clip(bounded, Math.floor(bytes(bounded) / 2))
  return { kind: 'text', text: bounded }
}
/** Privacy screening happens on the complete data before any display clipping. */
export function createCliToolPresentation(input: CliToolPresentationInput): ToolPresentation {
  const privateData = mcpContainsSecret([input.call, input.source, input.result ?? null, input.progress ?? null,
    input.warnings ?? []], input.secrets ?? [])
  const callId = privateData ? `withheld:${hash(input.call.id)}` : input.call.id
  const name = privateData ? 'withheld tool' : input.call.name
  const source = privateData ? { reference: 'cli:privacy-withheld', revision: hash(input.source) } : input.source
  const argumentsText = privateData ? '[Arguments withheld: known credential]' : JSON.stringify(input.call.arguments)
  const resultText = privateData ? '[Result withheld: known credential]' : input.result?.content
  const warnings = privateData ? ['Tool presentation content was withheld because it contains a known credential.'] : [...input.warnings ?? []]
  const arguments_ = detail(argumentsText, TOOL_PRESENTATION_LIMITS.argumentBytes)
  const result = resultText === undefined ? undefined : detail(resultText, TOOL_PRESENTATION_LIMITS.resultBytes)
  if (arguments_.text !== argumentsText || result && result.text !== resultText) warnings.push('Presentation details were bounded; canonical history is unchanged.')
  return decodeToolPresentation(JSON.stringify({ version: 1, callId, name, source, status: input.status, effect: input.effect,
    arguments: arguments_, ...(result ? { result } : {}),
    ...(input.progress && !privateData ? { progress: { text: clip(input.progress, 2048) } } : {}),
    ...(warnings.length ? { warnings: warnings.slice(0, 8).map(warning => clip(warning, 512)) } : {}) }))
}

/** Exact call occurrence and argument binding; ambiguous reused IDs remain unreported. */
export function cliToolOutcome(call: ToolCall, history: readonly HistoryMessage[], evidence?: CliToolEvidence): AgentOutcomeEvidence | undefined {
  const count = history.reduce((total, message) => total + (message.kind === 'assistant'
    ? message.toolCalls.filter(item => item.id === call.id).length : 0), 0)
  if (count !== 1) return undefined
  return evidence?.projection?.outcomes.find(outcome => outcome.callId === call.id && outcome.name === call.name &&
    outcome.argumentsDigest === agentArgumentsDigest(call.arguments))
}
export function cliToolSource(sessionId: string | undefined, historyIndex: number, message: unknown): ToolPresentation['source'] {
  return { reference: `cli-session:${sessionId ?? 'unreported'}:history:${historyIndex}`, revision: hash(message) }
}
export function cliHistoryToolPresentation(history: readonly HistoryMessage[], index: number, sessionId?: string,
  evidence?: CliToolEvidence, secrets: readonly string[] = []): ToolPresentation {
  const result = history[index]
  if (result?.kind !== 'tool_result') throw new Error('Expected canonical tool result')
  let call: ToolCall | undefined, requestIndex = -1
  for (let previous = index - 1; previous >= 0; previous--) {
    const message = history[previous]!
    if (message.kind === 'message' && message.role === 'user') break
    if (message.kind === 'assistant') { call = message.toolCalls.find(item => item.id === result.callId && item.name === result.name); if (call) { requestIndex = previous; break } }
  }
  const exactCall = call ?? { id: result.callId, name: result.name, arguments: {} }
  const exact = evidence && evidence.sessionId === sessionId && call &&
    JSON.stringify(evidence.projection?.history[index]?.message) === JSON.stringify(result)
    ? cliToolOutcome(call, history, evidence) : undefined
  const decision = evidence && evidence.sessionId === sessionId && call ? evidence.decisions?.find(item => item.requestIndex === requestIndex &&
    item.callId === call.id && item.name === call.name && item.argumentsDigest === agentArgumentsDigest(call.arguments)) : undefined
  return createCliToolPresentation({ call: exactCall, result, status: exact?.status ?? decision?.status ?? 'unknown', effect: exact?.effect ?? decision?.effect ?? 'unreported',
    source: exact?.source ?? decision?.source ?? cliToolSource(sessionId, index, result), secrets,
    ...(!call ? { warnings: ['Legacy tool arguments are unavailable; no approval or effect evidence was restored.'] } : {}) })
}
/** Invalid foreign/legacy data gets a fixed visible error. It is never hidden or relabeled as success. */
function displaySnapshot(encoded: string, secrets: readonly string[]): ToolPresentation {
    let snapshot = decodeToolPresentation(encoded)
    if (mcpContainsSecret(snapshot, secrets)) snapshot = decodeToolPresentation(JSON.stringify({
      version: 1, callId: 'withheld', name: 'withheld tool', source: { reference: 'cli:privacy-withheld' },
      status: snapshot.status, effect: snapshot.effect, arguments: { kind: 'text', text: '[Details withheld: known credential]' },
      warnings: ['Tool presentation content was withheld because it contains a known credential.'] }))
    return snapshot
}
export function cliToolPresentationView(encoded: string, collapsed = false, detailBytes = 8192,
  secrets: readonly string[] = []): ToolPresentationView {
  try {
    return toolPresentationView(displaySnapshot(encoded, secrets), { collapsed, detailBytes })
  }
  catch { return { header: ['Tool presentation unavailable', 'Status: unknown', 'Effect: unreported', 'Source: unavailable'],
    warnings: ['Invalid or oversized tool presentation. Inspect canonical history; this display grants no permission to execute.',
      'External effects are unreported. Do not infer that no effects occurred.'], details: [] } }
}

/** Reserved host-owned reads have no external operation to verify. This is display
 * context supplied by the CLI, never inferred from a foreign presentation name. */
export function isCliLocalReadTool(name: string): boolean {
  return ['current_time', 'note_read', 'list_memories', 'list_skills', 'read_skill',
    'workspace_list', 'workspace_read', 'workspace_search', 'workspace_glob'].includes(name)
}
export interface CliToolCardView {
  readonly title: string
  readonly status: string
  readonly attention: boolean
  readonly warnings: readonly string[]
  readonly expanded: ToolPresentationView
}
function oneLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]|[\ud800-\udfff]/gu,
    unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
function targetSummary(snapshot: ToolPresentation): string | undefined {
  // Only action arguments supply a target. Result text cannot label itself a success.
  let arguments_: unknown
  try { arguments_ = snapshot.arguments.kind === 'json' ? snapshot.arguments.data : JSON.parse(snapshot.arguments.text) }
  catch { return undefined }
  if (!arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) return undefined
  const values = arguments_ as Record<string, unknown>
  const keys: Record<string, readonly string[]> = {
    workspace_list: ['path'], workspace_read: ['path'], workspace_search: ['query', 'path'], workspace_glob: ['pattern', 'path'],
    workspace_create_text: ['path'], workspace_edit_text: ['path'], note_set: ['key'], current_time: ['timezone'],
    read_skill: ['name', 'path'], create_memory: ['title'], edit_memory: ['id'], delete_memory: ['id'], command_start: ['executable'] }
  if (snapshot.name === 'fetch_url' && typeof values.url === 'string') {
    try { const url = new URL(values.url); return oneLine(url.hostname + url.pathname) }
    catch { return undefined }
  }
  const parts = (Object.hasOwn(keys, snapshot.name) ? keys[snapshot.name]! : []).flatMap(key => typeof values[key] === 'string' && values[key] ? [oneLine(values[key])] : [])
  return parts.length ? parts.join(' · ') : undefined
}
/** CLI-only compact layout. Shared semantics, sanitizing, bounds and evidence are
 * unchanged and remain inspectable inside the expanded card. */
export function cliToolCardView(encoded: string, collapsed = true, detailBytes = 8192,
  secrets: readonly string[] = [], observed: { readonly localRead?: boolean; readonly resultError?: boolean } = {}): CliToolCardView {
  const expanded = cliToolPresentationView(encoded, collapsed, detailBytes, secrets)
  try {
    const snapshot = displaySnapshot(encoded, secrets)
    const external = !observed.localRead
    let status = snapshot.status === 'requested' ? 'queued' : snapshot.status === 'running' ? 'running'
      : snapshot.status === 'approval_required' ? 'approval required' : snapshot.status === 'succeeded' ? ''
      : snapshot.status === 'unknown' ? external ? 'unverified' : '' : snapshot.status
    if (observed.resultError && snapshot.status === 'unknown') status = external ? 'error/unverified' : 'error result'
    if (snapshot.effect === 'unknown') status = !status || status === 'unverified' ? 'effects unknown'
      : `${snapshot.status === 'approval_required' ? 'approval' : status.split('/')[0]}/unknown`
    else if (external && snapshot.effect === 'unreported' && ['failed', 'cancelled', 'denied', 'succeeded'].includes(snapshot.status))
      status = status === 'cancelled' ? 'cancelled/unknown' : status ? `${status}/unverified` : 'unverified'
    const warnings = expanded.warnings.filter(warning =>
      !['Approval required. This display grants no permission to execute.', 'Tool request denied. This display grants no permission to execute.',
        'Tool failed. Failure does not establish that no effects occurred.', 'Tool outcome is unknown. Inspect the resource before retrying.',
        'External effects are unknown. Do not retry automatically; cancellation cannot undo effects.',
        'External effects are unreported. Do not infer that no effects occurred.', 'Exact action needs human review.',
        'Presentation details were bounded; canonical history is unchanged.',
        'Legacy tool arguments are unavailable; no approval or effect evidence was restored.'].includes(warning))
      .map(warning => warning === 'Tool presentation content was withheld because it contains a known credential.' ? 'Details withheld'
        : /^\w+: unsupported presentation kind /.test(warning) ? 'Unsupported details' : warning)
    const summary = targetSummary(snapshot)
    return { title: [status, oneLine(snapshot.name), summary].filter(Boolean).join(' · '), status,
      attention: observed.resultError === true || ['approval_required', 'failed', 'denied', 'cancelled'].includes(snapshot.status) ||
        snapshot.effect === 'unknown' || external && (snapshot.status === 'unknown' || snapshot.effect === 'unreported' && snapshot.status === 'succeeded'), warnings, expanded }
  } catch { return { title: 'invalid/unverified', status: 'invalid/unverified', attention: true,
    warnings: ['Invalid or oversized tool presentation'], expanded } }
}
