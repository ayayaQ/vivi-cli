// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from 'node:crypto'
import { discoverOAuthServerInfo, exchangeAuthorization, selectResourceURL, startAuthorization } from '@modelcontextprotocol/client'
import type { AuthProvider, FetchLike, OAuthClientInformationContext, OAuthClientMetadata, OAuthClientProvider,
  OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client'
import { McpOAuthCallback, McpOAuthError } from './mcp-oauth-callback.js'
export { McpOAuthError } from './mcp-oauth-callback.js'

export interface McpOAuthSessionOptions {
  readonly endpoint: string
  readonly configRevision: string
  readonly client?: { readonly id: string; readonly issuer: string; readonly redirectPort: number }
  readonly scopes: readonly string[]
  readonly fetchFn: FetchLike
  readonly openBrowser: (url: URL, signal: AbortSignal) => Promise<void>
  readonly registerSecrets: (values: readonly string[]) => void
  /** The owner must invalidate the session when its endpoint/configuration changes. */
  readonly configurationIsCurrent: () => boolean
  readonly timeoutMs?: number
  readonly now?: () => number
}
export interface McpOAuthSignInPlan {
  readonly endpoint: string
  readonly configRevision: string
  readonly issuer: string
  readonly scopes: readonly string[]
  readonly registration: 'pre-registered-public-client'
  readonly revision: string
}
export type McpOAuthState = 'disconnected' | 'preparing' | 'prepared' | 'awaiting-user' | 'exchanging' |
  'connected' | 'cancelled' | 'failed' | 'needs-sign-in'
export interface McpOAuthAuthorizationSnapshot { readonly revision: string; readonly bearerToken?: string }
interface Flow {
  readonly abort: AbortController
  readonly state: string
  readonly provider: SessionOAuthClientProvider
  callback?: McpOAuthCallback
  plan?: McpOAuthSignInPlan
  pendingTokens?: StoredOAuthTokens
  expiresAt?: number
  timedOut?: boolean
  timer?: ReturnType<typeof setTimeout>
}
function remoteUrl(value: string): URL {
  let url
  try { url = new URL(value) } catch { throw new McpOAuthError('authorization-failed') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
    value.length > 4096 || /[\u0000-\u0020\u007f-\u009f]/.test(value)) throw new McpOAuthError('authorization-failed')
  return url
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new McpOAuthError('cancelled'))
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new McpOAuthError('cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
/** Internal SDK OAuth shape. The HTTP transport must receive bearerProvider(), never this provider. */
class SessionOAuthClientProvider implements OAuthClientProvider {
  private redirect: URL | undefined
  private verifier: string | undefined
  private discovery: OAuthDiscoveryState | undefined
  constructor(private readonly owner: McpOAuthSession, readonly stateValue: string) {}
  private assert(): void { this.owner.assertProvider(this) }
  get redirectUrl(): URL | undefined { this.assert(); return this.redirect && new URL(this.redirect) }
  setRedirect(url: URL): void { this.assert(); this.redirect = new URL(url) }
  get clientMetadata(): OAuthClientMetadata {
    this.assert()
    return { redirect_uris: this.redirect ? [this.redirect.href] : [], application_type: 'native',
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'] }
  }
  state(): string { this.assert(); return this.stateValue }
  clientInformation(ctx?: OAuthClientInformationContext): StoredOAuthClientInformation {
    this.assert()
    const client = this.owner.client()
    if (ctx && ctx.issuer !== client.issuer) throw new McpOAuthError('authorization-failed')
    return { client_id: client.id, issuer: client.issuer }
  }
  tokens(ctx?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    this.assert()
    if (ctx && ctx.issuer !== this.owner.client().issuer) return undefined
    return undefined // Each explicit sign-in is a fresh authorization-code flow; no refresh or recovery.
  }
  saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void {
    this.assert(); this.owner.stageTokens(this, tokens, ctx)
  }
  async redirectToAuthorization(url: URL): Promise<void> { this.assert(); await this.owner.openAuthorization(this, url); this.assert() }
  saveCodeVerifier(verifier: string): void { this.assert(); this.owner.registerSecrets([verifier]); this.verifier = verifier }
  codeVerifier(): string { this.assert(); if (!this.verifier) throw new McpOAuthError('authorization-failed'); return this.verifier }
  saveDiscoveryState(state: OAuthDiscoveryState): void { this.assert(); this.discovery = structuredClone(state) }
  discoveryState(): OAuthDiscoveryState | undefined { this.assert(); return this.discovery && structuredClone(this.discovery) }
  clear(): void { this.verifier = undefined; this.discovery = undefined; this.redirect = undefined }
}
/** Session-only explicit OAuth coordinator. No persistence, registration, refresh or MCP operation replay. */
export class McpOAuthSession {
  private flow: Flow | undefined
  private token: string | undefined
  private expiresAt: number | undefined
  private revision = randomUUID()
  private state: McpOAuthState = 'disconnected'
  private readonly options: McpOAuthSessionOptions
  private readonly timeoutMs: number
  constructor(options: McpOAuthSessionOptions) {
    remoteUrl(options.endpoint)
    if (!options.configRevision || options.configRevision.length > 256 || options.scopes.length > 32 ||
      options.scopes.some(scope => !/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(scope)) || new Set(options.scopes).size !== options.scopes.length)
      throw new McpOAuthError('authorization-failed')
    if (options.client) {
      remoteUrl(options.client.issuer)
      if (!options.client.id || options.client.id.length > 1024 || /[\u0000-\u0020\u007f-\u009f]/.test(options.client.id) ||
        !Number.isInteger(options.client.redirectPort) || options.client.redirectPort < 0 || options.client.redirectPort > 65535)
        throw new McpOAuthError('client-registration-required')
    }
    this.timeoutMs = options.timeoutMs ?? 120_000
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 600_000) throw new McpOAuthError('authorization-failed')
    this.options = { ...options, scopes: Object.freeze([...options.scopes]), ...(options.client ? { client: Object.freeze({ ...options.client }) } : {}) }
  }
  private now(): number { return (this.options.now ?? Date.now)() }
  client(): NonNullable<McpOAuthSessionOptions['client']> {
    if (!this.options.client) throw new McpOAuthError('client-registration-required')
    return this.options.client
  }
  registerSecrets(values: readonly string[]): void { this.options.registerSecrets(values) }
  assertProvider(provider: SessionOAuthClientProvider): void {
    if (this.flow?.provider !== provider || this.flow.abort.signal.aborted || !this.options.configurationIsCurrent())
      throw new McpOAuthError('cancelled')
  }
  private startDeadline(flow: Flow): void {
    flow.timer = setTimeout(() => { if (this.flow === flow) { flow.timedOut = true; flow.abort.abort(); this.clearToken(); this.state = 'failed'; void flow.callback?.close() } }, this.timeoutMs)
  }
  private clearToken(): void { this.token = undefined; this.expiresAt = undefined; this.revision = randomUUID() }
  private attachSignal(flow: Flow, signal?: AbortSignal): () => void {
    const abort = (): void => { if (this.flow === flow) { void this.cancelSignIn() } }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    return () => signal?.removeEventListener('abort', abort)
  }
  private async cleanup(flow: Flow): Promise<void> {
    clearTimeout(flow.timer); delete flow.timer
    await flow.callback?.close(); delete flow.callback
    flow.provider.clear(); delete flow.pendingTokens; delete flow.expiresAt
  }
  async prepareSignIn(signal?: AbortSignal): Promise<McpOAuthSignInPlan> {
    const closing = this.disconnect(), revision = this.revision
    await closing
    if (this.revision !== revision) throw new McpOAuthError('invalid-plan')
    const state = randomBytes(32).toString('base64url')
    const provider = new SessionOAuthClientProvider(this, state)
    const flow: Flow = { abort: new AbortController(), state, provider }
    this.flow = flow; this.state = 'preparing'; this.registerSecrets([state]); this.startDeadline(flow)
    const detach = this.attachSignal(flow, signal)
    try {
      this.assertProvider(provider); const client = this.client()
      const info = await discoverOAuthServerInfo(this.options.endpoint, { fetchFn: this.fetchFor(flow) })
      this.assertProvider(provider)
      const metadata = info.authorizationServerMetadata
      if (!metadata || metadata.issuer !== client.issuer || info.authorizationServerUrl !== client.issuer ||
        !metadata.code_challenge_methods_supported?.includes('S256') || !metadata.response_types_supported.includes('code') ||
        metadata.token_endpoint_auth_methods_supported && !metadata.token_endpoint_auth_methods_supported.includes('none'))
        throw new McpOAuthError('authorization-failed')
      remoteUrl(metadata.issuer); remoteUrl(metadata.authorization_endpoint); remoteUrl(metadata.token_endpoint)
      if (info.resourceMetadata) {
        await selectResourceURL(this.options.endpoint, provider, info.resourceMetadata)
        if (remoteUrl(info.resourceMetadata.resource).href !== remoteUrl(this.options.endpoint).href) throw new McpOAuthError('authorization-failed')
      }
      this.assertProvider(provider); provider.saveDiscoveryState(info)
      const plan: McpOAuthSignInPlan = Object.freeze({ endpoint: this.options.endpoint, configRevision: this.options.configRevision,
        issuer: metadata.issuer, scopes: this.options.scopes, registration: 'pre-registered-public-client', revision: this.revision })
      flow.plan = plan; this.state = 'prepared'; clearTimeout(flow.timer); delete flow.timer
      return plan
    } catch (error) { const safe = this.safeError(flow, error); await this.failed(flow, safe); throw safe }
    finally { detach() }
  }
  async beginSignIn(plan: McpOAuthSignInPlan, signal?: AbortSignal): Promise<void> {
    const flow = this.flow
    if (!flow || flow.plan !== plan || this.state !== 'prepared' || plan.revision !== this.revision || !this.options.configurationIsCurrent())
      throw new McpOAuthError('invalid-plan')
    const provider = flow.provider
    this.state = 'awaiting-user' // Claim the plan before any await; repeated Connect cannot start another listener.
    const detach = this.attachSignal(flow, signal); this.startDeadline(flow)
    try {
      this.assertProvider(provider)
      flow.callback = await McpOAuthCallback.listen({ state: flow.state, issuer: plan.issuer, port: this.client().redirectPort,
        requireIssuer: provider.discoveryState()?.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true,
        signal: flow.abort.signal, isActive: () => this.flow === flow && this.options.configurationIsCurrent(), registerSecrets: values => this.registerSecrets(values) })
      this.assertProvider(provider); provider.setRedirect(flow.callback.redirectUrl)
      const info = provider.discoveryState()!, metadata = info.authorizationServerMetadata!
      const authorization = await startAuthorization(info.authorizationServerUrl, { metadata,
        clientInformation: provider.clientInformation({ issuer: plan.issuer }), redirectUrl: provider.redirectUrl!,
        state: provider.state(), ...(plan.scopes.length ? { scope: plan.scopes.join(' ') } : {}),
        resource: info.resourceMetadata?.resource ?? this.options.endpoint })
      this.assertProvider(provider); provider.saveCodeVerifier(authorization.codeVerifier); this.state = 'awaiting-user'
      await provider.redirectToAuthorization(authorization.authorizationUrl)
      const callback = await flow.callback.result
      this.assertProvider(provider); this.state = 'exchanging'
      const tokens = await exchangeAuthorization(info.authorizationServerUrl, { metadata,
        clientInformation: provider.clientInformation({ issuer: plan.issuer }), authorizationCode: callback.code,
        ...(callback.iss ? { iss: callback.iss } : {}), codeVerifier: provider.codeVerifier(), redirectUri: provider.redirectUrl!,
        resource: info.resourceMetadata?.resource ?? this.options.endpoint, fetchFn: this.fetchFor(flow) })
      provider.saveTokens({ ...tokens, issuer: plan.issuer }, { issuer: plan.issuer })
      const staged = flow.pendingTokens!, expiresAt = flow.expiresAt
      await this.cleanup(flow); this.assertProvider(provider)
      this.token = staged.access_token; this.expiresAt = expiresAt; this.revision = randomUUID(); this.state = 'connected'; this.flow = undefined
    } catch (error) { const safe = this.safeError(flow, error); await this.failed(flow, safe); throw safe }
    finally { detach() }
  }
  async openAuthorization(provider: SessionOAuthClientProvider, url: URL): Promise<void> {
    this.assertProvider(provider)
    const expected = provider.discoveryState()?.authorizationServerMetadata?.authorization_endpoint
    if (!expected || url.origin !== remoteUrl(expected).origin || url.pathname !== remoteUrl(expected).pathname) throw new McpOAuthError('authorization-failed')
    await abortable(Promise.resolve().then(() => this.options.openBrowser(new URL(url), this.flow!.abort.signal)), this.flow!.abort.signal)
  }
  stageTokens(provider: SessionOAuthClientProvider, tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): void {
    this.assertProvider(provider)
    this.registerSecrets([tokens.access_token, ...(tokens.refresh_token ? [tokens.refresh_token] : [])])
    if (tokens.issuer !== this.client().issuer || ctx?.issuer !== this.client().issuer || tokens.token_type.toLowerCase() !== 'bearer' ||
      !tokens.access_token || !/^[A-Za-z0-9._~+/-]+=*$/.test(tokens.access_token) || tokens.access_token.length > 8192 ||
      tokens.scope !== undefined && tokens.scope.split(' ').some(scope => !this.options.scopes.includes(scope)) ||
      tokens.expires_in !== undefined && (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)) throw new McpOAuthError('authorization-failed')
    const flow = this.flow!
    flow.pendingTokens = { access_token: tokens.access_token, token_type: 'Bearer', issuer: tokens.issuer }
    if (tokens.expires_in !== undefined) {
      const expiresAt = this.now() + tokens.expires_in * 1000
      if (!Number.isFinite(expiresAt)) throw new McpOAuthError('authorization-failed')
      flow.expiresAt = expiresAt
    }
  }
  private fetchFor(flow: Flow): FetchLike {
    return async (input, init) => {
      this.assertProvider(flow.provider)
      const url = remoteUrl(String(input instanceof Request ? input.url : input))
      const issuer = remoteUrl(this.client().issuer)
      const configuredTokenEndpoint = flow.provider.discoveryState()?.authorizationServerMetadata?.token_endpoint
      const tokenEndpoint = configuredTokenEndpoint && remoteUrl(configuredTokenEndpoint).href
      if (url.origin !== remoteUrl(this.options.endpoint).origin && url.origin !== issuer.origin &&
        url.href !== tokenEndpoint) throw new McpOAuthError('authorization-failed')
      const signal = AbortSignal.any([flow.abort.signal, ...(init?.signal ? [init.signal] : [])])
      // Only discovery GETs and the one token exchange POST are allowed; registration is unreachable.
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      if (method !== 'GET' && !(method === 'POST' && tokenEndpoint === url.href && this.state === 'exchanging')) throw new McpOAuthError('authorization-failed')
      const response = await abortable(this.options.fetchFn(input, { ...init, redirect: 'manual', signal }), signal)
      this.assertProvider(flow.provider)
      if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => undefined); throw new McpOAuthError('authorization-failed') }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let length = 0
      try {
        if (reader) while (true) {
          const part = await abortable(reader.read(), signal)
          if (part.done) break
          length += part.value.byteLength
          if (length > 64 * 1024) throw new McpOAuthError('authorization-failed')
          chunks.push(part.value)
        }
      } finally { void reader?.cancel().catch(() => undefined) }
      this.assertProvider(flow.provider)
      const body = Buffer.concat(chunks).toString('utf8')
      let parsed: unknown
      try { parsed = JSON.parse(body) } catch { /* SDK handles malformed/empty metadata without exposing it. */ }
      if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>
        this.registerSecrets(['access_token', 'refresh_token', 'id_token'].flatMap(key => typeof record[key] === 'string' ? [record[key] as string] : []))
      }
      const safeBody = !response.ok ? JSON.stringify({ error: 'server_error' }) : body
      return new Response(safeBody || null, { status: response.status, headers: { 'Content-Type': 'application/json' } })
    }
  }
  private safeError(flow: Flow, error: unknown): McpOAuthError {
    if (flow.timedOut) return new McpOAuthError('timeout')
    return error instanceof McpOAuthError ? error : new McpOAuthError(flow.abort.signal.aborted ? 'cancelled' : 'authorization-failed')
  }
  private async failed(flow: Flow, error: unknown): Promise<void> {
    flow.abort.abort(); await this.cleanup(flow)
    if (this.flow === flow) { this.flow = undefined; this.clearToken(); this.state = error instanceof McpOAuthError && error.code === 'cancelled' ? 'cancelled' : 'failed' }
  }
  async cancelSignIn(): Promise<void> {
    const flow = this.flow; this.flow = undefined; this.clearToken(); this.state = 'cancelled'
    flow?.abort.abort(); if (flow) await this.cleanup(flow)
  }
  async disconnect(): Promise<void> { const closing = this.cancelSignIn(); this.state = 'disconnected'; await closing }
  /** Synchronous trusted HTTP seam. Its revision must be included in catalog/operation identity. */
  authorizationSnapshot(): McpOAuthAuthorizationSnapshot {
    if (!this.options.configurationIsCurrent() || this.token && this.expiresAt !== undefined && this.now() >= this.expiresAt) {
      if (this.token) { this.clearToken(); this.state = 'needs-sign-in' }
      if (this.flow) { void this.cancelSignIn() }
    }
    return { revision: this.revision, ...(this.token ? { bearerToken: this.token } : {}) }
  }
  bearerProvider(): AuthProvider {
    const revision = this.authorizationSnapshot().revision
    return { token: async () => { const current = this.authorizationSnapshot(); return current.revision === revision ? current.bearerToken : undefined } }
  }
  status(): { readonly state: McpOAuthState; readonly revision: string } {
    this.authorizationSnapshot(); return { state: this.state, revision: this.revision }
  }
}
