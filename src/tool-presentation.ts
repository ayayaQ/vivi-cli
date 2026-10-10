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
export function cliToolPresentationView(encoded: string, collapsed = false, detailBytes = 8192,
  secrets: readonly string[] = []): ToolPresentationView {
  try {
    let snapshot = decodeToolPresentation(encoded)
    if (mcpContainsSecret(snapshot, secrets)) snapshot = decodeToolPresentation(JSON.stringify({
      version: 1, callId: 'withheld', name: 'withheld tool', source: { reference: 'cli:privacy-withheld' },
      status: snapshot.status, effect: snapshot.effect, arguments: { kind: 'text', text: '[Details withheld: known credential]' },
      warnings: ['Tool presentation content was withheld because it contains a known credential.'] }))
    return toolPresentationView(snapshot, { collapsed, detailBytes })
  }
  catch { return { header: ['Tool presentation unavailable', 'Status: unknown', 'Effect: unreported', 'Source: unavailable'],
    warnings: ['Invalid or oversized tool presentation. Inspect canonical history; this display grants no permission to execute.',
      'External effects are unreported. Do not infer that no effects occurred.'], details: [] } }
}
