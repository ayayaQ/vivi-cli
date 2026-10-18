// SPDX-License-Identifier: Apache-2.0
import type { ContextUsage } from '@ayayaq/vivi'
import type { CliSession } from './session.js'
import { formatUsage } from './usage.js'
import type { ModelEntry } from './models.js'

function shortTokens(value: number): string {
  if (value < 1000) return String(value)
  if (value < 10000) return `${Math.round(value / 100) / 10}k`
  if (value < 1000000) return `${Math.round(value / 1000)}k`
  return `${Math.round(value / 100000) / 10}m`
}

/** Header values describe one effective request; cumulative usage lives in /session. */
export function formatContextStatus(usage?: ContextUsage): string {
  if (!usage) return 'Context unknown'
  return `Context ${usage.estimated ? '~' : ''}${shortTokens(usage.inputTokens)}/${usage.contextWindow === undefined ? '?' : shortTokens(usage.contextWindow)}`
}
export function formatContextDetails(usage?: ContextUsage, model?: ModelEntry): string {
  const source = usage?.limitSource ?? model?.contextLimitsSource
  return [formatContextStatus(usage),
    usage ? `Input: ${usage.inputTokens} tokens${usage.estimated ? ' (estimated effective request, including current guidance and tools)' : ' (effective request)'}` : 'Input: not measured yet',
    `Capacity: ${usage?.contextWindow ?? 'unknown'}`,
    ...(usage?.maxInputTokens === undefined ? [] : [`Endpoint input limit: ${usage.maxInputTokens} tokens`]),
    `Output reserve: ${usage?.outputReserveTokens ?? 'unknown'} tokens`,
    ...(model?.maxOutputTokens === undefined ? [] : [`Provider maximum output: ${model.maxOutputTokens} tokens`]),
    ...(source ? [`Limits: ${source.kind} · ${source.url} · reviewed ${source.reviewedOn}`] : ['Limits: metadata unavailable; capacity is not inferred from the model name']),
    ...(usage?.limitSource?.fetchedAt ? [`Catalog: ${usage.limitSource.freshness ?? 'unknown'} · fetched ${usage.limitSource.fetchedAt}`] :
      model?.contextMetadata ? [`Catalog: ${model.contextMetadata.state} · fetched ${model.contextMetadata.fetchedAt}`] : []),
    'Compaction changes only the provider view; the complete local transcript and exact tool evidence are retained',
    'Session/turn token totals count accepted response rounds; any context-summary request usage is separate',
    'Local transcript limits still apply: 2 MiB / 2000 messages; active conversation-record history is capped at 384 KiB'
  ].join('\n')
}

export function formatContextSummaryUsage(session: CliSession): string {
  if (!session.contextSummaryUsage && !session.contextSummaryUnreported) return ''
  return `Context-summary tokens (reported separately): ${session.contextSummaryUsage ? formatUsage(session.contextSummaryUsage) : 'unreported'}${session.contextSummaryUnreported ? '\nSome summary requests did not report usage; these totals are incomplete' : ''}\n`
}
