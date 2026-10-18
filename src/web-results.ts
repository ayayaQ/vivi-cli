// SPDX-License-Identifier: Apache-2.0
import type { WebFetchResponse, WebSearchResponse } from '@ayayaq/vivi/web'
import { DEEPSEEK_WEB_LIMITS } from './web-tools.js'
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
function clip(value: string, budget: number): string {
  let output = '', used = 0
  for (const point of value) {
    const size = Buffer.byteLength(JSON.stringify(point)) - 2
    if (used + size > budget) break
    output += point; used += size
  }
  return output
}
/** Bound the complete JSON envelope and preserve exact retained citation URLs. Never clip a URL into another URL. */
export function boundedDeepSeekWebResult(response: WebFetchResponse | WebSearchResponse): string {
  const base = { success: true, source: 'web_provider', provider: 'deepseek', untrusted: true,
    requestState: 'response_received', networkActivity: 'possible', billing: 'unverified', doNotRetry: true,
    websiteVerification: 'Provider-reported content; original website status, redirect destination and completeness are unverified',
    provenance: response.provenance }
  if ('requestedUrl' in response) {
    const title = clip(response.title, 2048), contentMarkdown = clip(response.contentMarkdown, 48 * 1024)
    return JSON.stringify({ ...base, requestedUrl: response.requestedUrl, title, contentMarkdown,
      localTruncation: response.localTruncation,
      hostLocalTruncation: [title !== response.title ? 'title' : '', contentMarkdown !== response.contentMarkdown ? 'contentMarkdown' : ''].filter(Boolean) })
  }
  const results: Record<string, unknown>[] = []
  let omitted = 0
  const envelope = (): Record<string, unknown> => ({ ...base, resultLimitApplied: response.resultLimitApplied,
    hostOmittedResults: omitted, results })
  for (const row of response.results) {
    const result: Record<string, unknown> = { url: row.url, title: '', snippet: '', summary: '', content: '',
      localTruncation: row.localTruncation, hostLocalTruncation: [] }
    if (bytes({ ...envelope(), results: [...results, result] }) > DEEPSEEK_WEB_LIMITS.resultBytes - 128) { omitted++; continue }
    results.push(result)
    const shortened: string[] = []
    for (const field of ['title', 'snippet', 'summary', 'content'] as const) {
      const remaining = DEEPSEEK_WEB_LIMITS.resultBytes - bytes(envelope()) - 256
      result[field] = clip(row[field], Math.max(0, Math.min(remaining, field === 'title' ? 1024 : 4096)))
      if (result[field] !== row[field]) shortened.push(field)
    }
    result.hostLocalTruncation = shortened
  }
  const encoded = JSON.stringify(envelope())
  if (Buffer.byteLength(encoded) > DEEPSEEK_WEB_LIMITS.resultBytes) throw new Error('Web result exceeded its host bound')
  return encoded
}
