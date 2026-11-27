// SPDX-License-Identifier: Apache-2.0
import type { HistoryMessage, ToolCall } from '@ayayaq/vivi'
import { mcpDigest } from '@ayayaq/vivi/extensions/mcp'
import { agentArgumentsDigest } from '@ayayaq/vivi/events'
import type { AgentHistoryEntry, AgentOutcomeEvidence } from '@ayayaq/vivi/events'
import type { McpOutcomeRecord } from './mcp-outcomes.js'
import type { PublicUrlOutcomeRecord } from './public-url-outcomes.js'

type RemoteRow = McpOutcomeRecord | PublicUrlOutcomeRecord
type Observation = Pick<AgentOutcomeEvidence, 'status' | 'effect'>
type Child = Observation & { id: string; name: string; callDigest: string }

/** This evidence belongs to the host's private session, never to tool arguments or a tool result. */
export class CodeModeParentRedactions {
  private readonly originals = new Map<string, string>()
  constructor(saved?: Readonly<Record<string, string>>) {
    for (const [current, original] of Object.entries(saved ?? {})) this.originals.set(current, original)
  }
  remember(before: ToolCall, after: ToolCall): void {
    if (before === after) return
    const beforeDigest = mcpDigest(before)
    const original = this.originals.get(beforeDigest) ?? (before.name === 'code_mode' ? beforeDigest : undefined)
    if (original) this.originals.set(mcpDigest(after), original)
  }
  exactDigest(parent: Pick<ToolCall, 'id' | 'name'> & { readonly arguments: unknown }): string | undefined {
    const digest = mcpDigest(parent)
    return this.originals.get(digest) ?? (parent.name === 'code_mode' ? digest : undefined)
  }
  forHistory(history: readonly HistoryMessage[]): Record<string, string> | undefined {
    if (!this.originals.size) return undefined
    const entries: [string, string][] = []
    for (const message of history) if (message.kind === 'assistant') for (const call of message.toolCalls) {
      const digest = mcpDigest(call), original = this.originals.get(digest)
      if (original) entries.push([digest, original])
    }
    return entries.length ? Object.fromEntries(entries) : undefined
  }
}

function matches(child: Child | null, row: RemoteRow): boolean {
  return !!child && (child.callDigest === row.callDigest || row.recoveryCallDigest !== undefined && child.callDigest === row.recoveryCallDigest)
}

function codeModeBody(content: string): Record<string, unknown> {
  try {
    const body = JSON.parse(content)
    if (body?.untrusted === true && typeof body.success === 'boolean') return body
  } catch { /* An interrupted query may only have a generic closure. */ }
  return {}
}

function childCalls(body: Record<string, unknown>): Child[] {
  return Array.isArray(body.calls) ? body.calls : []
}

/** Match only host ledger rows bound to the exact parent. Never replay a child to recover a result. */
export function recoverCodeModeChildren(history: HistoryMessage[], evidence: { row: RemoteRow; outcome: Observation }[], parentsRedacted = new CodeModeParentRedactions()): HistoryMessage[] {
  const nested = evidence.filter(({ row }) => row.codeModeParentDigest)
  if (!nested.length) return history
  let parents: readonly ToolCall[] = []
  return history.map(message => {
    if (message.kind === 'assistant') parents = message.toolCalls
    if (message.kind !== 'tool_result') return message
    const parent = parents.find(call => call.id === message.callId && call.name === message.name)
    if (!parent) return message
    const digest = parentsRedacted.exactDigest(parent)
    if (!digest) return message
    const rows = nested.filter(({ row }) => row.codeModeParentDigest === digest)
    if (!rows.length) return message
    const body = codeModeBody(message.content)
    const calls = childCalls(body)
    if (rows.every(({ row }) => calls.some(child => matches(child, row)))) return message
    const recovered = rows.filter(({ row }) => !calls.some(child => matches(child, row))).map(({ row, outcome }) =>
      ({ id: row.callId, name: row.toolName, callDigest: row.callDigest, ...outcome }))
    return { ...message, isError: true, content: JSON.stringify({ success: false, untrusted: true, doNotRetry: true,
      ...(body.contentWithheld === true ? { contentWithheld: true } : {}),
      ...(Array.isArray(body.reads) ? { reads: body.reads } : {}),
      ...(Array.isArray(body.writes) ? { writes: body.writes } : {}),
      calls: [...calls, ...recovered],
      error: 'Query interrupted. Remote call receipts were recovered. Other effects may be unknown. Inspect before retrying.' }) }
  })
}

export function settledCodeModeChild(row: RemoteRow, history: readonly HistoryMessage[], outcomes: readonly AgentOutcomeEvidence[], parentsRedacted = new CodeModeParentRedactions()): boolean {
  if (!row.codeModeParentDigest) return false
  const parent = history.flatMap(message => message.kind === 'assistant' ? message.toolCalls : [])
    .find(call => parentsRedacted.exactDigest(call) === row.codeModeParentDigest)
  if (!parent || !outcomes.some(item => item.runId === row.runId && item.callId === parent.id &&
    item.name === parent.name && item.argumentsDigest === agentArgumentsDigest(parent.arguments))) return false
  const result = history.find(message => message.kind === 'tool_result' && message.callId === parent.id && message.name === parent.name)
  if (!result) return false
  return childCalls(codeModeBody(result.content)).some(child => matches(child, row))
}

/** A recovered child can be durable even when its interrupted parent has no settlement. */
export function recordedCodeModeChild(row: RemoteRow, outcome: Observation, history: readonly AgentHistoryEntry['message'][],
  parentsRedacted: CodeModeParentRedactions): boolean {
  if (!row.codeModeParentDigest) return false
  let parent: Pick<ToolCall, 'id' | 'name'> | undefined
  for (const message of history) {
    if (message.kind === 'assistant') {
      parent = message.toolCalls.find(call => parentsRedacted.exactDigest(call) === row.codeModeParentDigest)
    } else if (message.kind === 'tool_result' && parent && message.name === parent.name && message.callId === parent.id &&
        childCalls(codeModeBody(message.content)).some(child => matches(child, row) && child.id === row.callId &&
          child.name === row.toolName && child.status === outcome.status && child.effect === outcome.effect)) return true
  }
  return false
}
