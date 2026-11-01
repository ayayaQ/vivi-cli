// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createLocalJWKSet, jwtVerify } from 'jose'
import type { JSONWebKeySet } from 'jose'
import type { CredentialStoreStatus } from './credentials.js'
import { listenChatGptCallback } from './chatgpt-auth-callback.js'
import type { ChatGptCallback } from './chatgpt-auth-callback.js'
import { ChatGptAuthStore, chatGptAccountId } from './chatgpt-auth-store.js'
import { CHATGPT_ISSUER, CHATGPT_RESOURCE, CHATGPT_SCOPES, CHATGPT_PLAN_SCOPE, ChatGptAuthError, authCheck, authRecord, authText } from './chatgpt-auth-types.js'
import type { ChatGptAccount, ChatGptAuthData, ChatGptRegistration, ChatGptTokens } from './chatgpt-auth-types.js'
export { CHATGPT_USAGE_URL, ChatGptAuthError } from './chatgpt-auth-types.js'
export type { ChatGptAccount } from './chatgpt-auth-types.js'

const AUTHORIZE = `${CHATGPT_ISSUER}/api/accounts/authorize`
const TOKEN = `${CHATGPT_ISSUER}/api/accounts/oauth/token`
const DISCOVERY = `${CHATGPT_ISSUER}/.well-known/openid-configuration`
const terminalRefreshErrors = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])
interface Discovery { readonly jwksUri: string; readonly revocationEndpoint?: string }
interface HttpResult { readonly status: number; readonly body: unknown; readonly requestId?: string }
class TokenFailure extends ChatGptAuthError {
  constructor(readonly oauthCode: string | undefined, readonly confirmedResponse: boolean, status?: number, requestId?: string) {
    super('token-exchange-failed', status, requestId)
  }
}
export interface ChatGptSignInOptions {
  readonly accountId?: string
  readonly signal?: AbortSignal
  /** Explicit user choice only; never inferred from a failed secure save. */
  readonly sessionOnly?: boolean
  /** Explicit enable-plan-use action; routine sign-in never forces consent. */
  readonly enablePlanUsage?: boolean
}
export interface ChatGptAuthManagerOptions {
  /** App settings root. ChatGPT records live in its own chatgpt-auth subdirectory. */
  readonly directory: string
  /** Trusted launch/fixture hooks only; never configured by model or saved settings. */
  readonly fetchFn?: typeof fetch
  readonly openBrowser?: (url: URL, signal: AbortSignal) => Promise<void>
  readonly callback?: typeof listenChatGptCallback
  readonly store?: ChatGptAuthStore
  readonly registerSecrets?: (values: readonly string[]) => void
  readonly now?: () => number
}
function safeAccount(record: ChatGptRegistration, sessionOnly: boolean): ChatGptAccount {
  return Object.freeze({ id: record.id, clientId: record.clientId, subject: record.subject, ...(record.email ? { email: record.email } : {}),
    label: `${record.email ?? 'ChatGPT account'} · ${record.id.slice(0, 8)}`,
    planUsageEnabled: !!record.tokens?.scopes.includes(CHATGPT_PLAN_SCOPE), signedIn: !!record.tokens && !record.refreshPending,
    welcomeSeen: record.welcomeSeen, sessionOnly })
}
function remoteEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new ChatGptAuthError('invalid-identity')
  let url: URL
  try { url = new URL(value) } catch { throw new ChatGptAuthError('invalid-identity') }
  if (url.origin !== CHATGPT_ISSUER || url.username || url.password || url.hash || url.search || url.href !== value) throw new ChatGptAuthError('invalid-identity')
  return value
}
async function openSystemBrowser(url: URL, signal: AbortSignal): Promise<void> {
  if (url.origin !== CHATGPT_ISSUER || url.pathname !== '/api/accounts/authorize' || url.username || url.password || url.hash) throw new ChatGptAuthError('invalid-callback')
  authCheck(signal)
  const command = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href]
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const child = spawn(command, args, { shell: false, stdio: 'ignore', windowsHide: true })
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (ok) resolve(); else reject(new ChatGptAuthError(signal.aborted ? 'cancelled' : 'callback-unavailable'))
    }
    const abort = (): void => { child.kill(); finish(false) }
    const timer = setTimeout(abort, 5000)
    child.once('error', () => finish(false)); child.once('exit', code => finish(code === 0))
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
  })
}
function replace(data: ChatGptAuthData, record: ChatGptRegistration): ChatGptAuthData {
  return { ...data, accounts: [...data.accounts.filter(account => account.id !== record.id), record] }
}
/** CLI-owned public OAuth client. It never reads another harness's credentials or falls back to API billing. */
export class ChatGptAuthManager {
  private readonly store: ChatGptAuthStore
  private readonly sessionAccounts = new Map<string, ChatGptRegistration>()
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly pending = new Set<AbortController>()
  private readonly completions = new Map<AbortController, Promise<void>>()
  private attempt: AbortController | undefined
  private closed = false
  constructor(private readonly options: ChatGptAuthManagerOptions) {
    this.store = options.store ?? new ChatGptAuthStore(join(options.directory, 'chatgpt-auth'), {
      ...(options.registerSecrets ? { registerSecrets: options.registerSecrets } : {}) })
  }
  private now(): number { return Math.floor((this.options.now ?? Date.now)()) }
  private check(signal?: AbortSignal): void { authCheck(signal); if (this.closed) throw new ChatGptAuthError('cancelled') }
  private register(tokens: ChatGptTokens): void { this.options.registerSecrets?.([tokens.accessToken, tokens.idToken,
    ...(tokens.idTokenNonce ? [tokens.idTokenNonce] : []), ...(tokens.refreshToken ? [tokens.refreshToken] : [])]) }
  private operation(signal?: AbortSignal): { controller: AbortController; signal: AbortSignal; finish(): void } {
    this.check(signal)
    const controller = new AbortController(); this.pending.add(controller)
    let complete!: () => void
    this.completions.set(controller, new Promise<void>(resolve => { complete = resolve }))
    return { controller, signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]), finish: () => {
      this.pending.delete(controller); this.completions.delete(controller); complete()
    } }
  }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve()
    const pending = previous.catch(() => undefined).then(action)
    this.queues.set(id, pending)
    void pending.then(() => { if (this.queues.get(id) === pending) this.queues.delete(id) }, () => { if (this.queues.get(id) === pending) this.queues.delete(id) })
    return pending
  }
  async storageStatus(): Promise<CredentialStoreStatus> { this.check(); return this.store.status() }
  async listAccounts(): Promise<readonly ChatGptAccount[]> {
    this.check()
    let saved: readonly ChatGptRegistration[]
    try { saved = (await this.store.readData()).accounts }
    catch (error) {
      if (!(error instanceof ChatGptAuthError) || error.code !== 'storage-unavailable') throw error
      saved = (await this.store.readMetadata()).accounts
    }
    return Object.freeze([...saved.filter(account => !this.sessionAccounts.has(account.id)).map(account => safeAccount(account, false)),
      ...[...this.sessionAccounts.values()].map(account => safeAccount(account, true))])
  }
  private async registration(id: string, signal?: AbortSignal): Promise<ChatGptRegistration> {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new ChatGptAuthError('account-changed')
    let record = this.sessionAccounts.get(id)
    if (!record) {
      try { record = (await this.store.readData(signal)).accounts.find(account => account.id === id) }
      catch (error) {
        if (!(error instanceof ChatGptAuthError) || error.code !== 'storage-unavailable') throw error
        record = (await this.store.readMetadata(signal)).accounts.find(account => account.id === id)
      }
    }
    if (!record) throw new ChatGptAuthError('account-changed')
    if (record.tokens) this.register(record.tokens)
    return record
  }
  /** Selection does not activate an account globally. The host binds this ID to a fresh local conversation. */
  async select(accountId: string): Promise<ChatGptAccount> {
    this.check(); const record = await this.registration(accountId)
    if (!record.tokens || record.refreshPending) throw new ChatGptAuthError('needs-sign-in')
    return safeAccount(record, this.sessionAccounts.has(accountId))
  }
  private async http(url: string, init: RequestInit, signal: AbortSignal): Promise<HttpResult> {
    remoteEndpoint(url); this.check(signal)
    const deadline = AbortSignal.timeout(15_000), requestSignal = AbortSignal.any([signal, deadline])
    try {
      const response = await (this.options.fetchFn ?? fetch)(url, { ...init, redirect: 'manual', credentials: 'omit', signal: requestSignal })
      this.check(signal)
      if (response.status >= 300 && response.status < 400) throw new ChatGptAuthError('network-unavailable', response.status)
      const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0
      try {
        if (reader) while (true) {
          const result = await reader.read(); this.check(signal)
          if (result.done) break
          length += result.value.length; if (length > 256 * 1024) throw new ChatGptAuthError('invalid-identity')
          chunks.push(result.value)
        }
      } finally { await reader?.cancel().catch(() => undefined); reader?.releaseLock() }
      let body: unknown = null
      if (length) { try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) } catch { throw new ChatGptAuthError('invalid-identity', response.status) } }
      const id = response.headers.get('x-request-id') ?? response.headers.get('openai-request-id')
      const requestId = id && /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? id : undefined
      return { status: response.status, body, ...(requestId ? { requestId } : {}) }
    } catch (error) {
      if (signal.aborted || this.closed) throw new ChatGptAuthError('cancelled')
      if (error instanceof ChatGptAuthError) throw error
      throw new ChatGptAuthError(deadline.aborted ? 'timeout' : 'network-unavailable')
    }
  }
  private async discovery(signal: AbortSignal): Promise<Discovery> {
    const result = await this.http(DISCOVERY, { headers: { Accept: 'application/json' } }, signal), value = result.body
    if (result.status !== 200 || !authRecord(value) || value.issuer !== CHATGPT_ISSUER || value.authorization_endpoint !== AUTHORIZE || value.token_endpoint !== TOKEN) throw new ChatGptAuthError('invalid-identity', result.status, result.requestId)
    const jwksUri = remoteEndpoint(value.jwks_uri)
    return { jwksUri, ...(value.revocation_endpoint === undefined ? {} : { revocationEndpoint: remoteEndpoint(value.revocation_endpoint) }) }
  }
  private async verifyIdToken(idToken: string, clientId: string, discovery: Discovery, signal: AbortSignal, expectedNonce?: string, refresh = false): Promise<{ subject: string; email?: string }> {
    const result = await this.http(discovery.jwksUri, { headers: { Accept: 'application/json' } }, signal)
    if (result.status !== 200 || !authRecord(result.body) || !Array.isArray(result.body.keys) || result.body.keys.length > 64) throw new ChatGptAuthError('invalid-identity')
    try {
      const { payload } = await jwtVerify(idToken, createLocalJWKSet(result.body as unknown as JSONWebKeySet), { issuer: CHATGPT_ISSUER, audience: clientId,
        algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'], requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5, currentDate: new Date(this.now()) })
      this.check(signal)
      if (!authText(payload.sub, 1024) || expectedNonce !== undefined && (!refresh || payload.nonce !== undefined) && payload.nonce !== expectedNonce ||
        Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId || payload.azp !== undefined && payload.azp !== clientId ||
        typeof payload.iat !== 'number' || payload.iat > this.now() / 1000 + 5 || payload.email !== undefined && !authText(payload.email, 1024)) throw new ChatGptAuthError('invalid-identity')
      return { subject: payload.sub, ...(typeof payload.email === 'string' ? { email: payload.email } : {}) }
    } catch (error) { if (error instanceof ChatGptAuthError) throw error; throw new ChatGptAuthError('invalid-identity') }
  }
  private async tokenRequest(body: URLSearchParams, signal: AbortSignal): Promise<Record<string, unknown>> {
    let result: HttpResult
    try { result = await this.http(TOKEN, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body }, signal) }
    catch (error) { throw new TokenFailure(undefined, false, error instanceof ChatGptAuthError ? error.status : undefined) }
    if (result.status !== 200 || !authRecord(result.body)) {
      const code = authRecord(result.body) && authText(result.body.error, 128) ? result.body.error : undefined
      throw new TokenFailure(code, true, result.status, result.requestId)
    }
    return result.body
  }
  private parseTokens(value: Record<string, unknown>, previous?: ChatGptTokens): ChatGptTokens {
    // Register candidate secrets before any later validation or UI-visible failure.
    this.options.registerSecrets?.(['access_token', 'refresh_token', 'id_token'].flatMap(key => typeof value[key] === 'string' ? [value[key] as string] : []))
    if (!authText(value.access_token, 65_536) || value.token_type !== 'Bearer' || typeof value.expires_in !== 'number' || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 86_400 ||
      (value.id_token === undefined ? !previous : !authText(value.id_token, 65_536)) || value.refresh_token !== undefined && !authText(value.refresh_token, 16_384) ||
      value.scope !== undefined && (typeof value.scope !== 'string' || value.scope.length > 16_384)) throw new ChatGptAuthError('invalid-identity')
    const scopes = value.scope === undefined ? previous?.scopes : [...new Set((value.scope as string).split(' ').filter(Boolean))]
    if (!scopes || scopes.length > 64 || scopes.some(scope => !authText(scope, 256)) || !previous && value.scope === undefined ||
      previous && scopes.some(scope => !previous.scopes.includes(scope)) || scopes.includes('offline_access') && !authText(value.refresh_token, 16_384)) throw new ChatGptAuthError('invalid-identity')
    const savedAt = this.now(), idToken = (value.id_token ?? previous?.idToken) as string
    let earliestRefreshAt: number | undefined
    if (value.earliest_refresh_at !== undefined) {
      if (typeof value.earliest_refresh_at !== 'number' || !Number.isSafeInteger(value.earliest_refresh_at) || value.earliest_refresh_at <= 0) throw new ChatGptAuthError('invalid-identity')
      earliestRefreshAt = value.earliest_refresh_at * 1000
    }
    return { accessToken: value.access_token, idToken, scopes: [...scopes], expiresAt: savedAt + value.expires_in * 1000, savedAt,
      ...(previous?.idTokenNonce ? { idTokenNonce: previous.idTokenNonce } : {}),
      ...(value.refresh_token === undefined ? {} : { refreshToken: value.refresh_token as string }), ...(earliestRefreshAt === undefined ? {} : { earliestRefreshAt }) }
  }
  async signIn(input: ChatGptSignInOptions = {}): Promise<ChatGptAccount> {
    this.check(input.signal); if (this.attempt) throw new ChatGptAuthError('busy')
    const operation = this.operation(input.signal), timeout = AbortSignal.timeout(10 * 60 * 1000), signal = AbortSignal.any([operation.signal, timeout])
    this.attempt = operation.controller
    let callback: ChatGptCallback | undefined
    try {
      if (!input.sessionOnly && !(await this.storageStatus()).available) throw new ChatGptAuthError('storage-unavailable')
      const selected = input.accountId ? await this.registration(input.accountId, signal) : undefined
      const sessionOnly = input.sessionOnly === true || !!selected && this.sessionAccounts.has(selected.id)
      if (!selected && (await this.store.readMetadata(signal)).accounts.length >= 32) throw new ChatGptAuthError('storage-unavailable')
      const hostId = await this.store.hostId(signal), discovery = await this.discovery(signal)
      let clientId = selected?.clientId ?? 'dynamic_agent_client'
      // An expired one-use code is retried once inside this same explicit interaction.
      // Its issued client ID never leaks into a later unrelated Add account action.
      for (let retry = 0; retry < 2; retry++) {
        const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'), verifier = randomBytes(64).toString('base64url')
        this.options.registerSecrets?.([state, nonce, verifier])
        callback = await (this.options.callback ?? listenChatGptCallback)({ state, signal, registerSecrets: values => this.options.registerSecrets?.(values) })
        const url = new URL(AUTHORIZE)
        url.search = new URLSearchParams({ client_id: clientId, ext_agent_host_id: hostId, response_type: 'code', redirect_uri: callback.redirectUri,
          scope: CHATGPT_SCOPES.join(' '), resource: CHATGPT_RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString()
        if (clientId === 'dynamic_agent_client') url.searchParams.set('agent_name_hint', 'Vivi')
        if (selected?.tokens?.idToken) url.searchParams.set('id_token_hint', selected.tokens.idToken)
        if (selected?.email) url.searchParams.set('login_hint', selected.email)
        if (input.enablePlanUsage) url.searchParams.set('prompt', 'consent')
        await (this.options.openBrowser ?? openSystemBrowser)(url, signal)
        const result = await callback.result; this.check(signal)
        const issuedClientId = result.clientId ?? (clientId === 'dynamic_agent_client' ? undefined : clientId)
        if (!authText(issuedClientId, 1024) || issuedClientId === 'dynamic_agent_client' || clientId !== 'dynamic_agent_client' && issuedClientId !== clientId) throw new ChatGptAuthError('invalid-callback')
        const redirectUri = callback.redirectUri
        await callback.close(); callback = undefined
        let value: Record<string, unknown>
        try { value = await this.tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', client_id: issuedClientId, code: result.code,
          code_verifier: verifier, redirect_uri: redirectUri, resource: CHATGPT_RESOURCE }), signal) }
        catch (error) {
          if (error instanceof TokenFailure && error.oauthCode === 'invalid_grant' && retry === 0) { clientId = issuedClientId; continue }
          throw error
        }
        const tokens = { ...this.parseTokens(value), idTokenNonce: nonce }, identity = await this.verifyIdToken(tokens.idToken, issuedClientId, discovery, signal, nonce)
        if (selected && identity.subject !== selected.subject) throw new ChatGptAuthError('invalid-identity')
        const id = chatGptAccountId(issuedClientId, identity.subject)
        let record: ChatGptRegistration = { id, clientId: issuedClientId, subject: identity.subject, ...(identity.email ? { email: identity.email } : {}),
          welcomeSeen: selected?.welcomeSeen ?? false, revision: randomUUID(), tokens }
        this.check(signal)
        if (sessionOnly) {
          await this.store.saveMetadata(record, signal, true); this.check(signal)
          this.sessionAccounts.set(id, record)
        }
        else await this.store.transaction(async transaction => {
          const previous = transaction.data.accounts.find(account => account.id === id)
          if (selected && previous?.revision !== selected.revision || transaction.data.accounts.some(account => account.clientId === issuedClientId && account.subject !== identity.subject)) throw new ChatGptAuthError('account-changed')
          record = { ...record, welcomeSeen: previous?.welcomeSeen ?? record.welcomeSeen }
          this.check(signal); await transaction.write(replace(transaction.data, record))
        }, signal)
        return safeAccount(record, sessionOnly)
      }
      throw new ChatGptAuthError('token-exchange-failed')
    } catch (error) {
      if (timeout.aborted) throw new ChatGptAuthError('timeout')
      if (signal.aborted || this.closed) throw new ChatGptAuthError('cancelled')
      if (error instanceof ChatGptAuthError) throw error
      throw new ChatGptAuthError('token-exchange-failed')
    } finally { await callback?.close(); this.attempt = undefined; operation.finish() }
  }
  async markWelcomeSeen(accountId: string): Promise<void> {
    this.check()
    await this.serial(accountId, async () => {
      const record = await this.registration(accountId), next = { ...record, welcomeSeen: true, revision: randomUUID() }
      if (this.sessionAccounts.has(accountId)) { await this.store.saveMetadata(next); this.sessionAccounts.set(accountId, next) }
      else await this.store.transaction(async transaction => {
        const previous = transaction.data.accounts.find(account => account.id === accountId)
        if (previous?.revision !== record.revision) throw new ChatGptAuthError('account-changed')
        await transaction.write(replace(transaction.data, next))
      })
    })
  }
  async accessToken(accountId: string, signal?: AbortSignal): Promise<string> {
    this.check(signal)
    return this.serial(accountId, async () => {
      const operation = this.operation(signal)
      try {
        const sessionOnly = this.sessionAccounts.has(accountId)
        const use = async (record: ChatGptRegistration, write: (record: ChatGptRegistration) => Promise<void>): Promise<string> => {
          const tokens = record.tokens
          if (!tokens || record.refreshPending) throw new ChatGptAuthError('needs-sign-in')
          this.register(tokens)
          if (!tokens.scopes.includes(CHATGPT_PLAN_SCOPE)) throw new ChatGptAuthError('plan-usage-disabled')
          this.check(operation.signal)
          if (tokens.expiresAt > this.now() + 60_000 || tokens.earliestRefreshAt !== undefined && tokens.earliestRefreshAt > this.now() && tokens.expiresAt > this.now()) return tokens.accessToken
          if (!tokens.refreshToken) throw new ChatGptAuthError('needs-sign-in')
          if (tokens.earliestRefreshAt !== undefined && tokens.earliestRefreshAt > this.now()) throw new ChatGptAuthError('network-unavailable')
          const pending: ChatGptRegistration = { ...record, revision: randomUUID(), refreshPending: true }
          await write(pending)
          let response: Record<string, unknown>
          try { response = await this.tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', client_id: record.clientId,
            refresh_token: tokens.refreshToken, resource: CHATGPT_RESOURCE }), operation.signal) }
          catch (error) {
            if (error instanceof TokenFailure && error.confirmedResponse) {
              if (error.oauthCode && terminalRefreshErrors.has(error.oauthCode)) {
                const { tokens: _tokens, refreshPending: _pending, ...metadata } = record
                await write({ ...metadata, revision: randomUUID() }); throw new ChatGptAuthError('needs-sign-in', error.status, error.requestId)
              }
              await write({ ...record, revision: randomUUID() })
              if (error.oauthCode === 'invalid_client') throw new ChatGptAuthError('invalid-client', error.status, error.requestId)
              throw new ChatGptAuthError('network-unavailable', error.status, error.requestId)
            }
            // Do not erase credentials on a transient network failure. The durable marker
            // prevents reusing a possibly consumed rotating token after uncertainty/crash.
            throw new ChatGptAuthError(operation.signal.aborted ? 'cancelled' : 'refresh-unconfirmed')
          }
          const fresh = this.parseTokens(response, tokens)
          if (response.id_token !== undefined) {
            const identity = await this.verifyIdToken(fresh.idToken, record.clientId, await this.discovery(operation.signal), operation.signal, tokens.idTokenNonce, true)
            if (identity.subject !== record.subject) throw new ChatGptAuthError('invalid-identity')
          }
          this.check(operation.signal); await write({ ...record, tokens: fresh, revision: randomUUID() })
          if (!fresh.scopes.includes(CHATGPT_PLAN_SCOPE)) throw new ChatGptAuthError('plan-usage-disabled')
          return fresh.accessToken
        }
        if (sessionOnly) {
          const record = await this.registration(accountId, operation.signal)
          return await use(record, async next => { this.check(operation.signal); this.sessionAccounts.set(accountId, next) })
        }
        return await this.store.transaction(async transaction => {
          const record = transaction.data.accounts.find(account => account.id === accountId)
          if (!record) throw new ChatGptAuthError('account-changed')
          return use(record, next => transaction.write(replace(transaction.data, next)))
        }, operation.signal)
      } finally { operation.finish() }
    })
  }
  /** The host must cancel active inference before calling this. Local clearing proceeds even when remote revocation cannot be confirmed. */
  async signOut(accountId: string, signal?: AbortSignal): Promise<{ revoked: boolean }> {
    this.check(signal)
    if (this.attempt) {
      const completed = this.completions.get(this.attempt)
      this.attempt.abort(); await completed
    }
    return this.serial(accountId, async () => {
      const operation = this.operation(signal)
      try {
        const clear = async (record: ChatGptRegistration, write: (record: ChatGptRegistration) => Promise<void>): Promise<{ revoked: boolean }> => {
          let revoked = !record.tokens?.refreshToken
          if (record.tokens?.refreshToken) {
            this.register(record.tokens)
            try {
              const discovery = await this.discovery(operation.signal)
              if (discovery.revocationEndpoint) {
                for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
                  try {
                    const response = await this.http(discovery.revocationEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
                      body: new URLSearchParams({ token: record.tokens.refreshToken, token_type_hint: 'refresh_token', client_id: record.clientId }) }, operation.signal)
                    revoked = response.status === 200
                    if (response.status < 500) break
                  } catch { /* One bounded retry while the refresh token remains available. */ }
                  if (!revoked && attempt === 0) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 200); timer.unref?.() })
                }
              }
            } catch { /* Local sign-out still clears all three token types. */ }
          }
          const { tokens: _tokens, refreshPending: _pending, ...metadata } = record
          await write({ ...metadata, revision: randomUUID() }); return { revoked }
        }
        if (this.sessionAccounts.has(accountId)) {
          const result = await clear(await this.registration(accountId), async next => { this.sessionAccounts.set(accountId, next); await this.store.saveMetadata(next) })
          const otherSavedSession = await this.store.clearSavedTokens(accountId)
          return { revoked: result.revoked && !otherSavedSession }
        }
        try { return await this.store.transaction(async transaction => {
          const record = transaction.data.accounts.find(account => account.id === accountId)
          if (!record) throw new ChatGptAuthError('account-changed')
          return clear(record, next => transaction.write(replace(transaction.data, next)))
        }) } catch (error) {
          if (!(error instanceof ChatGptAuthError) || error.code !== 'storage-unavailable') throw error
          await this.store.clearSavedTokens(accountId); return { revoked: false }
        }
      } finally { operation.finish() }
    })
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true; for (const pending of this.pending) pending.abort()
    await Promise.allSettled([...this.completions.values(), ...this.queues.values()]); this.sessionAccounts.clear()
  }
}
