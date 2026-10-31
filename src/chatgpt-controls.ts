// SPDX-License-Identifier: Apache-2.0
import type { InteractiveIO } from './application.js'
import { ChatGptAuthManager, CHATGPT_USAGE_URL } from './chatgpt-auth.js'
import type { ChatGptAccount } from './chatgpt-auth.js'
import { ChatGptAuthError } from './chatgpt-auth.js'
import { ChatGPTInferenceError } from './chatgpt-provider.js'
import type { ModelProvider } from '@ayayaq/vivi'

/** Host-owned account controls, never exposed as model tools. */
export type ChatGptAuth = Pick<ChatGptAuthManager, 'listAccounts' | 'signIn' | 'select' | 'accessToken' |
  'signOut' | 'markWelcomeSeen' | 'storageStatus' | 'close'>

/** Terminal credential/grant changes revoke unattended authority, not transient usage/transport errors. */
export function chatGptAccountRejected(error: unknown): boolean {
  if (error instanceof ChatGptAuthError) return ['needs-sign-in', 'plan-usage-disabled', 'account-changed', 'invalid-identity'].includes(error.code)
  return error instanceof ChatGPTInferenceError && (error.status === 401 ||
    ['subscription_sharing_invalid_user', 'subscription_sharing_user_not_eligible', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context'].includes(error.details?.code ?? ''))
}
export function bindChatGptAccount(provider: ModelProvider, binding: {
  isCurrent(): boolean; invalidate(): Promise<void>
}): ModelProvider {
  return { ...provider, async generate(input, signal, progress) {
    if (!binding.isCurrent()) throw new ChatGptAuthError('account-changed')
    try {
      const result = await provider.generate(input, signal, progress)
      if (!binding.isCurrent()) throw new ChatGptAuthError('account-changed')
      return result
    }
    catch (error) {
      if (chatGptAccountRejected(error)) await binding.invalidate()
      throw error
    }
  } }
}

export function chatGptPlanStatus(account: ChatGptAccount): string {
  return `ChatGPT account: ${account.label} · ${account.planUsageEnabled ? 'Using ChatGPT plan' : 'ChatGPT plan usage disabled'}${account.sessionOnly ? ' · launch-only sign-in' : ''}\nManage usage: ${CHATGPT_USAGE_URL}\n`
}

export async function confirmChatGptWelcome(io: Pick<InteractiveIO, 'choose' | 'write' | 'isClosed'>,
  auth: ChatGptAuth, account: ChatGptAccount): Promise<void> {
  if (!account.planUsageEnabled || account.welcomeSeen || io.isClosed) return
  io.write(`You're using your ChatGPT plan. Eligible AI requests in Vivi use your ChatGPT plan. Manage usage in ChatGPT settings: ${CHATGPT_USAGE_URL}\n`)
  const accepted = await io.choose("You're using your ChatGPT plan", [{ name: 'Got it', value: true }])
  if (accepted && !io.isClosed) await auth.markWelcomeSeen(account.id)
}

/** Returns only a fully validated selection; cancellation never selects another account. */
export async function chooseChatGptAccount(io: InteractiveIO, auth: ChatGptAuth,
  current?: string): Promise<ChatGptAccount | undefined> {
  if (io.canAutoReview !== true || io.isClosed) { io.write('Continue with ChatGPT requires an interactive terminal\n'); return }
  const accounts = await auth.listAccounts()
  if (io.isClosed) return
  const id = await io.choose('ChatGPT accounts and workspaces', [
    ...accounts.map(account => ({ name: account.label,
      description: `${account.signedIn ? account.planUsageEnabled ? 'ChatGPT plan enabled' : 'Plan usage disabled' : 'Signed out'} · ${account.id.slice(0, 12)}`,
      value: account.id })),
    { name: 'Continue with ChatGPT', description: 'Add another account or workspace in your system browser', value: 'add' }
  ], Math.max(0, accounts.findIndex(account => account.id === current)))
  if (!id || io.isClosed) return
  const previous = accounts.find(account => account.id === id)
  if (previous?.signedIn && previous.planUsageEnabled) {
    const selected = await auth.select(previous.id)
    await confirmChatGptWelcome(io, auth, selected)
    return selected
  }
  let enablePlanUsage = false
  if (previous?.signedIn && !previous.planUsageEnabled) {
    const consent = await io.choose('ChatGPT plan usage is not enabled', [
      { name: 'Cancel', description: 'Keep this sign-in; no inference or billing change', value: 'cancel' },
      { name: 'Enable ChatGPT plan usage', description: 'Request plan-usage consent explicitly in your system browser', value: 'enable' }
    ])
    if (consent !== 'enable' || io.isClosed) return
    enablePlanUsage = true
  }
  let sessionOnly = false
  const status = await auth.storageStatus()
  if (io.isClosed) return
  const storage = await io.choose('ChatGPT sign-in storage', [
    ...(status.available ? [{ name: `Save securely with ${status.label}`, description: 'Encrypted account credentials, never preferences or transcripts', value: 'save' }] : []),
    { name: 'Use for this launch only', description: status.available ? 'Tokens are discarded on exit; registration and host identity remain' : `${status.detail ?? status.label}; no plaintext fallback`, value: 'temporary' },
    { name: 'Cancel', value: 'cancel' }
  ], status.available ? 0 : 1)
  if (!storage || storage === 'cancel' || io.isClosed) return
  sessionOnly = storage === 'temporary'
  const controller = new AbortController()
  const dispose = io.onCancel(() => controller.abort())
  try {
    io.write('Continue with ChatGPT · complete sign-in in your system browser. Escape cancels this attempt.\n')
    const selected = await auth.signIn({ ...(previous ? { accountId: previous.id } : {}),
      ...(enablePlanUsage ? { enablePlanUsage: true } : {}), sessionOnly, signal: controller.signal })
    if (controller.signal.aborted || io.isClosed) return
    io.write(chatGptPlanStatus(selected))
    if (!selected.planUsageEnabled) { io.write('ChatGPT sign-in retained, but plan usage is disabled. Use /account to enable it or explicitly choose another provider.\n'); return }
    await confirmChatGptWelcome(io, auth, selected)
    return selected
  } finally { dispose() }
}
