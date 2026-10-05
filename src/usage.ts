// SPDX-License-Identifier: Apache-2.0
import type { Usage } from '@ayayaq/vivi'

const requiredFields = ['inputTokens', 'outputTokens', 'totalTokens'] as const
const cacheFields = ['cachedInputTokens', 'cacheWriteInputTokens'] as const

function validateCount(value: number, field: keyof Usage): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Usage ${field} must be a nonnegative safe integer`)
  }
}

function addCount(total: number, value: number, field: keyof Usage): number {
  validateCount(value, field)
  const sum = total + value
  if (!Number.isSafeInteger(sum)) throw new RangeError(`Usage ${field} sum exceeds the safe integer range`)
  return sum
}

/** Sum reported counts without inferring totals or treating cache subsets as extra input.
 * A missing segment or cache field makes that cache aggregate unreported. */
export function aggregateUsage(usages: readonly (Usage | undefined)[]): Usage {
  const result: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  const complete = { cachedInputTokens: usages.length > 0, cacheWriteInputTokens: usages.length > 0 }
  for (const usage of usages) {
    if (usage === undefined) {
      complete.cachedInputTokens = false
      complete.cacheWriteInputTokens = false
      continue
    }
    for (const field of requiredFields) result[field] = addCount(result[field], usage[field], field)
    for (const field of cacheFields) {
      const value = usage[field]
      if (value === undefined) complete[field] = false
      else validateCount(value, field)
    }
  }
  // Only complete cache aggregates exist. Validate individual reports above,
  // but do not sum a partial collection whose total would remain unreported.
  for (const field of cacheFields) {
    if (!complete[field]) continue
    let sum = 0
    for (const usage of usages) {
      const value = usage?.[field]
      if (value !== undefined) sum = addCount(sum, value, field)
    }
    result[field] = sum
  }
  return result
}

/** Keep reported cache reads and writes distinct from unreported values. */
export function formatUsage(usage: Usage): string {
  const valid = aggregateUsage([usage])
  return `${valid.inputTokens} in / ${valid.outputTokens} out / ${valid.totalTokens} total\n` +
    `Cache input: read ${valid.cachedInputTokens ?? 'unreported'} / write ${valid.cacheWriteInputTokens ?? 'unreported'}`
}
