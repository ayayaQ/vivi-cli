// SPDX-License-Identifier: Apache-2.0
import type { QuestionHost, QuestionRequest, QuestionResponse } from '@ayayaq/vivi/extensions/questions'
import { mcpContainsSecret } from './mcp-content.js'

export const QUESTION_TOOL_NAME = 'request_user_input'
export const QUESTION_GUIDANCE = 'Use request_user_input only when clarification would materially help the current task. Questions collect information, never tool approval, permission, Auto review enrollment or authority to act. The user may skip or cancel; do not invent an answer. Do not request passwords, API keys or access tokens; use host credential setup controls. Tool confirmations must use the existing exact action-review path.'

/** Launch-local genuine human input. Availability and account binding are host facts. */
export interface CliQuestionHost {
  readonly ask: QuestionHost
  readonly isAvailable: () => boolean
  readonly accountRevision?: () => string
}

/** Bound before display and after the host settles, including hosts that ignore abort. */
export async function askCurrentQuestion(host: CliQuestionHost, request: QuestionRequest, signal: AbortSignal,
  isCurrent: () => boolean, secrets: () => readonly string[]): Promise<QuestionResponse> {
  const cancelled = (): QuestionResponse => ({ requestId: request.requestId, status: 'cancelled' })
  const current = (): boolean => { try { return isCurrent() } catch { return false } }
  if (signal.aborted || !current()) return cancelled()
  if (mcpContainsSecret(request, secrets())) throw new Error('Question contains a known credential; the prompt was withheld')
  const stale = new AbortController(), ownedSignal = AbortSignal.any([signal, stale.signal])
  // A plugin/account can be revoked outside the chat input loop. Dismiss its live
  // prompt promptly instead of accepting a later answer under a changed account.
  const timer = setInterval(() => { if (!current()) stale.abort() }, 50)
  timer.unref?.()
  try {
    return await new Promise<QuestionResponse>((resolve, reject) => {
      let settled = false
      const finish = (response?: QuestionResponse, error?: unknown): void => {
        if (settled) return
        settled = true
        ownedSignal.removeEventListener('abort', abort)
        if (signal.aborted || ownedSignal.aborted || !current()) { resolve(cancelled()); return }
        if (error !== undefined) { reject(new Error('Question input failed; no answer was delivered')); return }
        if (mcpContainsSecret(response, secrets())) { reject(new Error('Question answer contains a known credential; its content was withheld')); return }
        resolve(response!)
      }
      const abort = (): void => finish(cancelled())
      ownedSignal.addEventListener('abort', abort, { once: true })
      void Promise.resolve().then(() => {
        if (ownedSignal.aborted || !current()) return cancelled()
        return host.ask(request, { signal: ownedSignal })
      }).then(response => finish(response), error => finish(undefined, error))
      if (ownedSignal.aborted) abort()
    })
  } finally { clearInterval(timer) }
}
