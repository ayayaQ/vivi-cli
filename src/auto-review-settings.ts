// SPDX-License-Identifier: Apache-2.0

export type ReviewProvider = 'openai' | 'openrouter'
/** Integer thousandths of one; 950 means a 95.0% per-requirement estimate cutoff. */
export type AutoReviewThresholdOverrides = Partial<Record<ReviewProvider, number>>
export const AUTO_REVIEW_DEFAULT_PERMILLE = Object.freeze({ openai: 995, openrouter: 999 })
export const AUTO_REVIEW_MIN_PERMILLE = 900
export const AUTO_REVIEW_MAX_PERMILLE = 1000

function invalid(): never { throw new Error('Invalid Auto review threshold: use 90–100% in 0.1 percentage-point steps') }
function validPermille(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= AUTO_REVIEW_MIN_PERMILLE && Number(value) <= AUTO_REVIEW_MAX_PERMILLE
}
function validProvider(provider: unknown): provider is ReviewProvider { return provider === 'openai' || provider === 'openrouter' }

/** Closed host settings only. Reject accessors without invoking them; never trust model data. */
export function validateAutoReviewThresholdOverrides(value: unknown): AutoReviewThresholdOverrides {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const copy: AutoReviewThresholdOverrides = {}
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!validProvider(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !validPermille(descriptor.value)) invalid()
    copy[key] = descriptor.value
  }
  return copy
}

/** Provider defaults differ; this UX range is not a calibrated safety guarantee. */
export function resolveAutoReviewThreshold(provider: ReviewProvider, overrides?: AutoReviewThresholdOverrides): {
  allowAt: number; denyAt: number; allowPermille: number
} {
  if (!validProvider(provider)) invalid()
  const validated = overrides === undefined ? {} : validateAutoReviewThresholdOverrides(overrides)
  const allowPermille = validated[provider] ?? AUTO_REVIEW_DEFAULT_PERMILLE[provider]
  return { allowAt: allowPermille / 1000, denyAt: 0.05, allowPermille }
}

/** Parse decimal percentages exactly, not JavaScript numeric syntax, without rounding input. */
export function parseAutoReviewThresholdPercent(input: string): number {
  if (typeof input !== 'string') invalid()
  const text = input.trim()
  if (!/^(?:9[0-9](?:\.[0-9])?|100(?:\.0)?)$/.test(text)) invalid()
  const [whole, fraction = '0'] = text.split('.')
  const value = Number(whole) * 10 + Number(fraction)
  if (!validPermille(value)) invalid()
  return value
}

export function formatAutoReviewThreshold(permille: number): string {
  if (!validPermille(permille)) invalid()
  return `${Math.floor(permille / 10)}${permille % 10 ? `.${permille % 10}` : ''}%`
}
