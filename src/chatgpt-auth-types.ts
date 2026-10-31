// SPDX-License-Identifier: Apache-2.0
export const CHATGPT_ISSUER = 'https://auth.openai.com'
export const CHATGPT_RESOURCE = 'https://api.openai.com/v1'
export const CHATGPT_SCOPES = Object.freeze(['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'])
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct'
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

export type ChatGptAuthErrorCode = 'cancelled' | 'timeout' | 'busy' | 'storage-unavailable' | 'callback-unavailable' |
  'authorization-denied' | 'invalid-callback' | 'invalid-identity' | 'token-exchange-failed' | 'needs-sign-in' |
  'plan-usage-disabled' | 'refresh-unconfirmed' | 'network-unavailable' | 'account-changed' | 'invalid-client'
/** Fixed messages only. Never include provider bodies, authorization URLs or credential values. */
export class ChatGptAuthError extends Error {
  constructor(readonly code: ChatGptAuthErrorCode, readonly status?: number, readonly requestId?: string) {
    super({ cancelled: 'ChatGPT sign-in cancelled', timeout: 'ChatGPT sign-in timed out', busy: 'Another Vivi process is updating ChatGPT sign-in. Wait for it to finish, then retry',
      'storage-unavailable': 'Secure ChatGPT saved sign-in is unavailable. Unlock OS credential storage or explicitly choose session-only sign-in',
      'callback-unavailable': 'ChatGPT sign-in loopback callback is unavailable', 'authorization-denied': 'ChatGPT sign-in was declined',
      'invalid-callback': 'ChatGPT sign-in callback could not be verified', 'invalid-identity': 'ChatGPT identity could not be verified',
      'token-exchange-failed': 'ChatGPT token exchange failed. Start a fresh sign-in', 'needs-sign-in': 'This ChatGPT account needs a fresh sign-in',
      'plan-usage-disabled': 'ChatGPT plan usage is not enabled for this account. Enable it explicitly or choose another configured provider',
      'refresh-unconfirmed': 'ChatGPT token renewal was not confirmed. Credentials were retained; sign in again before renewing this session',
      'network-unavailable': 'ChatGPT authentication is temporarily unavailable. Credentials were retained; try again later',
      'invalid-client': 'ChatGPT rejected this client configuration. Credentials were retained; fix the client configuration before retrying',
      'account-changed': 'The selected ChatGPT account changed. Choose it again before continuing' }[code])
    this.name = 'ChatGptAuthError'
  }
}

/** Safe UI metadata. The issued client ID distinguishes registrations/workspaces with the same email. */
export interface ChatGptAccount {
  readonly id: string
  readonly clientId: string
  readonly subject: string
  readonly email?: string
  readonly label: string
  readonly planUsageEnabled: boolean
  readonly signedIn: boolean
  readonly welcomeSeen: boolean
  readonly sessionOnly: boolean
}
/** Privileged internal records. Never send these objects to the UI, model, sessions or logs. */
export interface ChatGptTokens {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly idToken: string
  /** Original OIDC nonce, retained to check an optional nonce on a refresh ID token. */
  readonly idTokenNonce?: string
  readonly scopes: readonly string[]
  readonly expiresAt: number
  readonly savedAt: number
  readonly earliestRefreshAt?: number
}
export interface ChatGptRegistration {
  readonly id: string
  readonly clientId: string
  readonly subject: string
  readonly email?: string
  readonly welcomeSeen: boolean
  readonly revision: string
  readonly tokens?: ChatGptTokens
  /** A crashed/uncertain rotating-token POST must not reuse the old refresh token. */
  readonly refreshPending?: boolean
}
export interface ChatGptAuthData {
  readonly version: 1
  readonly hostId: string
  readonly accounts: readonly ChatGptRegistration[]
}
export const authRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
export function authText(value: unknown, maximum = 8192): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u0020\u007f-\u009f\u2028-\u202e\u2066-\u2069]/u.test(value)
}
export function authCheck(signal?: AbortSignal): void { if (signal?.aborted) throw new ChatGptAuthError('cancelled') }
