// SPDX-License-Identifier: Apache-2.0
import type { CliProviderName } from './session.js'
export type ReviewProviderName = 'openai' | 'openrouter'
export function providerEnvironmentName(provider: CliProviderName): string {
  switch (provider) {
    case 'openai': return 'OPENAI_API_KEY'
    case 'openrouter': return 'OPENROUTER_API_KEY'
    case 'deepseek': return 'DEEPSEEK_API_KEY'
    default: throw new Error('Unsupported chat provider')
  }
}
export function isReviewProvider(provider: string): provider is ReviewProviderName {
  return provider === 'openai' || provider === 'openrouter'
}
