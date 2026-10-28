// SPDX-License-Identifier: Apache-2.0
import type { InteractiveIO } from './application.js'
import { AUTO_REVIEW_DEFAULT_PERMILLE, formatAutoReviewThreshold, parseAutoReviewThresholdPercent,
  resolveAutoReviewThreshold, validateAutoReviewThresholdOverrides } from './auto-review-settings.js'
import type { AutoReviewThresholdOverrides, ReviewProvider } from './auto-review-settings.js'

type ThresholdChoice = 'default' | 900 | 950 | 990 | 'custom'
/** Display/selection only. The caller owns idle checks, persistence, revocation and fresh enrollment. */
export async function chooseAutoReviewThreshold(io: Pick<InteractiveIO, 'choose' | 'askText' | 'write' | 'isClosed'>,
  provider: ReviewProvider, overrides?: AutoReviewThresholdOverrides): Promise<AutoReviewThresholdOverrides | undefined> {
  const captured = validateAutoReviewThresholdOverrides(overrides ?? {})
  const current = resolveAutoReviewThreshold(provider, captured)
  if (io.isClosed) return undefined
  io.write('Auto review uses one estimate for each required check, not an overall approval probability. Estimates are uncalibrated and may be wrong. Lower thresholds allow more uncertain proposals; hard blocks and human-only actions do not change. Changing a threshold revokes Auto and requires fresh enrollment.\n')
  const selectedValue: ThresholdChoice = captured[provider] === undefined ? 'default'
    : current.allowPermille === 900 || current.allowPermille === 950 || current.allowPermille === 990 ? current.allowPermille : 'custom'
  const choices: readonly { name: string; description: string; value: ThresholdChoice }[] = [
    { name: 'Default', description: `Reset ${provider} to ${formatAutoReviewThreshold(AUTO_REVIEW_DEFAULT_PERMILLE[provider])}`, value: 'default' },
    { name: '90%', description: 'Require every check to reach at least 90%', value: 900 },
    { name: '95%', description: 'Require every check to reach at least 95%', value: 950 },
    { name: '99%', description: 'Require every check to reach at least 99%', value: 990 },
    { name: 'Custom', description: '90–100%, in 0.1 percentage-point steps', value: 'custom' }
  ]
  const selected = await io.choose(`Auto review threshold · ${provider} · current ${formatAutoReviewThreshold(current.allowPermille)}`,
    choices, choices.findIndex(choice => choice.value === selectedValue))
  if (selected === undefined || io.isClosed) return undefined
  if (selected === 'default') { delete captured[provider]; return captured }
  if (selected === 'custom') {
    while (!io.isClosed) {
      const text = await io.askText('Minimum requirement estimate (%) · 90–100, at most one decimal',
        formatAutoReviewThreshold(current.allowPermille).slice(0, -1))
      if (text === undefined || io.isClosed) return undefined
      try { captured[provider] = parseAutoReviewThresholdPercent(text); return captured }
      catch { io.write('Enter a percentage from 90 to 100 with at most one decimal place, for example 95 or 99.5. No setting was changed.\n') }
    }
    return undefined
  }
  // Runtime defense for trusted/custom IO adapters returning an unadvertised choice.
  if (selected !== 900 && selected !== 950 && selected !== 990) throw new Error('Invalid Auto review threshold choice')
  captured[provider] = selected
  return captured
}
