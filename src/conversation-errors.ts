// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import type { HistoryMessage } from '@ayayaq/vivi'

/** Display-only run failure. Never insert these host diagnostics into model history. */
export interface CliConversationError {
  readonly id: string
  readonly historyLength: number
  readonly historyDigest: string
  readonly message: string
}
export interface CliConversationErrors {
  readonly sessionId: string
  readonly errors: readonly CliConversationError[]
}
export function conversationHistoryDigest(history: readonly HistoryMessage[]): string {
  return createHash('sha256').update(JSON.stringify(history)).digest('hex')
}
/** Do not attach old failures to a replaced, privacy-filtered or different transcript. */
export function matchingConversationErrors(history: readonly HistoryMessage[], errors: readonly CliConversationError[]): CliConversationError[] {
  const prefixes = new Map<number, string>()
  return errors.filter(error => {
    if (!Number.isSafeInteger(error.historyLength) || error.historyLength < 0 || error.historyLength > history.length) return false
    let digest = prefixes.get(error.historyLength)
    if (digest === undefined) {
      digest = conversationHistoryDigest(history.slice(0, error.historyLength))
      prefixes.set(error.historyLength, digest)
    }
    return digest === error.historyDigest
  })
}
