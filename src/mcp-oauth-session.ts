// SPDX-License-Identifier: Apache-2.0
import { randomBytes, randomUUID } from 'node:crypto'
import { discoverOAuthServerInfo, exchangeAuthorization, refreshAuthorization, selectResourceURL, startAuthorization } from '@modelcontextprotocol/client'
import type { AuthProvider, FetchLike, OAuthClientInformationContext, OAuthClientMetadata, OAuthClientProvider,
  OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client'
import { McpOAuthCallback, McpOAuthError, validateMcpOAuthRedirectPath } from './mcp-oauth-callback.js'
import { createMcpOAuthFetch, mcpOAuthAbortable as abortable, mcpOAuthRemoteUrl as remoteUrl, validateMcpOAuthDiscovery } from './mcp-oauth-network.js'
import { McpOAuthStoreError, validateMcpOAuthSavedTokens } from './mcp-oauth-store.js'
import type { McpOAuthSavedTokens } from './mcp-oauth-store.js'
export { McpOAuthError } from './mcp-oauth-callback.js'

export interface McpOAuthPersistenceContext {
  readonly signal: AbortSignal
  readonly isCurrent: () => boolean
}
export interface McpOAuthSessionOptions {
  readonly endpoint: string
  readonly configRevision: string
  readonly client?: { readonly id: string; readonly issuer: string; readonly redirectPort: number; readonly redirectPath?: string }
  readonly scopes: readonly string[]
  readonly discovery?: OAuthDiscoveryState
  readonly discoveryResource?: string
  readonly initialCredentials?: McpOAuthSavedTokens
  /** Trusted evidence only; no credentials are delivered and no authority is granted. */
  readonly authorizationIssued?: (kind: 'authorization-granted' | 'authorization-refreshed') => void
  /** Persist the validated bundle before its bearer authority becomes usable. */
  readonly saveCredentials?: (tokens: McpOAuthSavedTokens, context: McpOAuthPersistenceContext) => Promise<void>
  /** Host transaction must serialize refresh and make uncertain rotation unrecoverable. */
  readonly refreshCredentials?: (perform: (initial: McpOAuthSavedTokens) => Promise<McpOAuthSavedTokens>, context: McpOAuthPersistenceContext) => Promise<McpOAuthSavedTokens>
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
  readonly authorizationEndpoint: string
  readonly clientId: string
  readonly redirectPort: number
  readonly redirectPath?: string
  readonly scopes: readonly string[]
  readonly registration: 'pre-registered-public-client'
  readonly revision: string
}
export type McpOAuthState = 'disconnected' | 'preparing' | 'prepared' | 'awaiting-user' | 'exchanging' |
  'connected' | 'refreshing' | 'cancelled' | 'failed' | 'needs-sign-in'
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
/** Explicit OAuth coordinator. Optional privileged persistence hooks; no MCP operation replay. */
export class McpOAuthSession {
  private flow: Flow | undefined
  private token: string | undefined
  private credentials: McpOAuthSavedTokens | undefined
  private refreshing: { readonly abort: AbortController; readonly revision: string; timer: ReturnType<typeof setTimeout> | undefined } | undefined
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
      if (options.client.redirectPath !== undefined) validateMcpOAuthRedirectPath(options.client.redirectPath)
      if (!options.client.id || options.client.id.length > 1024 || /[\u0000-\u0020\u007f-\u009f]/.test(options.client.id) ||
        !Number.isInteger(options.client.redirectPort) || options.client.redirectPort < 0 || options.client.redirectPort > 65535)
        throw new McpOAuthError('client-registration-required')
    }
    this.timeoutMs = options.timeoutMs ?? 120_000
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 600_000) throw new McpOAuthError('authorization-failed')
    if (options.discoveryResource !== undefined && ![remoteUrl(options.endpoint).href, remoteUrl(options.endpoint).origin + '/'].includes(remoteUrl(options.discoveryResource).href)) throw new McpOAuthError('authorization-failed')
    this.options = { ...options, ...(options.discovery ? { discovery: structuredClone(options.discovery) } : {}), scopes: Object.freeze([...options.scopes]), ...(options.client ? { client: Object.freeze({ ...options.client }) } : {}) }
    if (options.discovery?.resourceMetadata && ![remoteUrl(options.endpoint).href, remoteUrl(options.endpoint).origin + '/'].includes(remoteUrl(options.discovery.resourceMetadata.resource).href)) throw new McpOAuthError('authorization-failed')
    if (options.discovery && options.client) validateMcpOAuthDiscovery(options.discovery, options.endpoint, options.client.issuer, options.discoveryResource)
    if (options.initialCredentials) {
      this.registerSecrets([options.initialCredentials.accessToken, ...(options.initialCredentials.refreshToken ? [options.initialCredentials.refreshToken] : [])])
      try {
        const saved = validateMcpOAuthSavedTokens(options.initialCredentials, { ...this.client(), scopes: this.options.scopes }, this.resource())
        this.installCredentials(saved)
        this.authorizationSnapshot()
      } catch { throw new McpOAuthError('authorization-failed') }
    }
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
  private resource(): string { return this.options.discovery?.resourceMetadata?.resource ?? this.options.discoveryResource ?? this.options.endpoint }
  private installCredentials(credentials: McpOAuthSavedTokens): void {
    this.credentials = credentials; this.token = credentials.accessToken; this.expiresAt = credentials.expiresAt
    this.revision = randomUUID(); this.state = 'connected'
  }
  private clearToken(forget = true): void {
    this.token = undefined; this.expiresAt = undefined; this.revision = randomUUID()
    if (forget) this.credentials = undefined
  }
  private savedTokens(tokens: StoredOAuthTokens, expiresAt?: number, grantedScopes = this.options.scopes): McpOAuthSavedTokens {
    return validateMcpOAuthSavedTokens({ accessToken: tokens.access_token, ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      ...(expiresAt === undefined ? {} : { expiresAt }), issuer: this.client().issuer, clientId: this.client().id,
      resource: this.resource(), scopes: tokens.scope === undefined ? [...grantedScopes] : tokens.scope.split(' ') }, { ...this.client(), scopes: this.options.scopes }, this.resource())
  }
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
      const info = this.options.discovery ? structuredClone(this.options.discovery)
        : await discoverOAuthServerInfo(this.options.endpoint, { fetchFn: this.fetchFor(flow) })
      this.assertProvider(provider)
      const metadata = validateMcpOAuthDiscovery(info, this.options.endpoint, client.issuer, this.options.discoveryResource)
      if (info.resourceMetadata) await selectResourceURL(this.options.endpoint, provider, info.resourceMetadata)
      this.assertProvider(provider); provider.saveDiscoveryState(info)
      const plan: McpOAuthSignInPlan = Object.freeze({ endpoint: this.options.endpoint, configRevision: this.options.configRevision,
        issuer: metadata.issuer, authorizationEndpoint: metadata.authorization_endpoint, clientId: client.id,
        redirectPort: client.redirectPort, ...(client.redirectPath === undefined ? {} : { redirectPath: client.redirectPath }),
        scopes: this.options.scopes, registration: 'pre-registered-public-client', revision: this.revision })
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
        ...(this.client().redirectPath === undefined ? {} : { path: this.client().redirectPath! }),
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
      const credentials = this.savedTokens(staged, expiresAt)
      this.options.authorizationIssued?.('authorization-granted'); this.assertProvider(provider)
      if (this.options.saveCredentials) await abortable(this.options.saveCredentials(credentials, Object.freeze({ signal: flow.abort.signal,
        isCurrent: () => this.flow === flow && !flow.abort.signal.aborted && this.options.configurationIsCurrent() })), flow.abort.signal)
      this.assertProvider(provider)
      await this.cleanup(flow); this.assertProvider(provider)
      this.installCredentials(credentials); this.flow = undefined
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
      tokens.refresh_token !== undefined && (typeof tokens.refresh_token !== 'string' || !/^[\x20-\x7e]+$/.test(tokens.refresh_token) || tokens.refresh_token.length > 8192) ||
      tokens.expires_in !== undefined && (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0)) throw new McpOAuthError('authorization-failed')
    const flow = this.flow!
    flow.pendingTokens = { access_token: tokens.access_token, token_type: 'Bearer', issuer: tokens.issuer,
      ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
      ...((this.options.saveCredentials || this.options.refreshCredentials) && tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}) }
    if (tokens.expires_in !== undefined) {
      const expiresAt = this.now() + tokens.expires_in * 1000
      if (!Number.isFinite(expiresAt)) throw new McpOAuthError('authorization-failed')
      flow.expiresAt = expiresAt
    }
  }
  private fetchFor(flow: Flow): FetchLike {
    return createMcpOAuthFetch({ fetchFn: this.options.fetchFn, signal: flow.abort.signal,
      origins: [remoteUrl(this.options.endpoint).origin, remoteUrl(this.client().issuer).origin],
      assertCurrent: () => this.assertProvider(flow.provider), registerSecrets: values => this.registerSecrets(values),
      // Only the explicit authorization-code exchange POST is permitted; no registration or refresh.
      postEndpoint: () => this.state === 'exchanging' ? flow.provider.discoveryState()?.authorizationServerMetadata?.token_endpoint : undefined })
  }
  private safeError(flow: Flow, error: unknown): McpOAuthError | McpOAuthStoreError {
    if (flow.timedOut) return new McpOAuthError('timeout')
    return error instanceof McpOAuthError || error instanceof McpOAuthStoreError ? error : new McpOAuthError(flow.abort.signal.aborted ? 'cancelled' : 'authorization-failed')
  }
  private async failed(flow: Flow, error: unknown): Promise<void> {
    flow.abort.abort(); await this.cleanup(flow)
    if (this.flow === flow) { this.flow = undefined; this.clearToken(); this.state = error instanceof McpOAuthError && error.code === 'cancelled' ? 'cancelled' : 'failed' }
  }
  async cancelSignIn(): Promise<void> {
    const refreshing = this.refreshing; this.refreshing = undefined; refreshing?.abort.abort(); clearTimeout(refreshing?.timer)
    const flow = this.flow; this.flow = undefined; this.clearToken(); this.state = 'cancelled'
    flow?.abort.abort(); if (flow) await this.cleanup(flow)
  }
  /** Before a fresh connect approval only. Never called by HTTP 401/403 recovery or a token provider. */
  async refresh(signal?: AbortSignal): Promise<void> {
    if (!this.options.configurationIsCurrent() || signal?.aborted || this.flow || this.refreshing) throw new McpOAuthError('cancelled')
    const initial = this.credentials
    if (!initial) throw new McpOAuthError('authorization-failed')
    if (initial.expiresAt === undefined || this.now() < initial.expiresAt - 30_000) return
    if (!initial.refreshToken || !this.options.refreshCredentials) { await this.requireSignIn(); throw new McpOAuthError('authorization-failed') }
    this.clearToken(false)
    const work = { abort: new AbortController(), revision: this.revision, timer: undefined as ReturnType<typeof setTimeout> | undefined }
    this.refreshing = work; this.state = 'refreshing'
    const abort = (): void => work.abort.abort()
    signal?.addEventListener('abort', abort, { once: true })
    work.timer = setTimeout(abort, this.timeoutMs)
    const assertCurrent = (): void => {
      if (this.refreshing !== work || this.revision !== work.revision || work.abort.signal.aborted || !this.options.configurationIsCurrent()) throw new McpOAuthError('cancelled')
    }
    try {
      const credentials = await abortable(this.options.refreshCredentials(async saved => {
        assertCurrent()
        const checked = validateMcpOAuthSavedTokens(saved, { ...this.client(), scopes: this.options.scopes }, this.resource())
        if (checked.refreshToken !== initial.refreshToken || !checked.refreshToken) throw new McpOAuthError('invalid-plan')
        let postEndpoint: string | undefined
        const fetchFn = createMcpOAuthFetch({ fetchFn: this.options.fetchFn, signal: work.abort.signal,
          origins: [remoteUrl(this.options.endpoint).origin, remoteUrl(this.client().issuer).origin], assertCurrent,
          postEndpoint: () => postEndpoint, registerSecrets: values => this.registerSecrets(values) })
        const info = this.options.discovery ? structuredClone(this.options.discovery)
          : await discoverOAuthServerInfo(this.options.endpoint, { fetchFn })
        assertCurrent()
        const metadata = validateMcpOAuthDiscovery(info, this.options.endpoint, this.client().issuer, this.options.discoveryResource)
        if (metadata.grant_types_supported && !metadata.grant_types_supported.includes('refresh_token')) throw new McpOAuthError('authorization-failed')
        postEndpoint = metadata.token_endpoint
        const response = await refreshAuthorization(info.authorizationServerUrl, { metadata,
          clientInformation: { client_id: this.client().id, issuer: this.client().issuer }, refreshToken: checked.refreshToken,
          resource: checked.resource, fetchFn })
        this.registerSecrets([response.access_token, ...(response.refresh_token ? [response.refresh_token] : [])])
        assertCurrent()
        if (response.token_type.toLowerCase() !== 'bearer' || response.expires_in !== undefined && (!Number.isFinite(response.expires_in) || response.expires_in <= 0)) throw new McpOAuthError('authorization-failed')
        const expiresAt = response.expires_in === undefined ? undefined : this.now() + response.expires_in * 1000
        const updated = this.savedTokens({ ...response, issuer: checked.issuer }, expiresAt, checked.scopes)
        if (updated.scopes.some(scope => !checked.scopes.includes(scope))) throw new McpOAuthError('authorization-failed')
        this.options.authorizationIssued?.('authorization-refreshed'); assertCurrent()
        return updated
      }, Object.freeze({ signal: work.abort.signal, isCurrent: () => this.refreshing === work && this.revision === work.revision &&
        !work.abort.signal.aborted && this.options.configurationIsCurrent() })), work.abort.signal)
      assertCurrent()
      const checked = validateMcpOAuthSavedTokens(credentials, { ...this.client(), scopes: this.options.scopes }, this.resource())
      this.installCredentials(checked)
    } catch (error) {
      if (this.refreshing === work) { this.clearToken(); this.state = 'needs-sign-in' }
      throw error instanceof McpOAuthError || error instanceof McpOAuthStoreError ? error : new McpOAuthError(work.abort.signal.aborted ? 'cancelled' : 'authorization-failed')
    } finally {
      clearTimeout(work.timer); signal?.removeEventListener('abort', abort)
      if (this.refreshing === work) this.refreshing = undefined
    }
  }
  async disconnect(): Promise<void> { const closing = this.cancelSignIn(); this.state = 'disconnected'; await closing }
  /** Revoke credentials synchronously after an operation is denied; never start sign-in or replay. */
  async requireSignIn(): Promise<void> { const closing = this.cancelSignIn(); this.state = 'needs-sign-in'; await closing }
  /** Synchronous trusted HTTP seam. Its revision must be included in catalog/operation identity. */
  authorizationSnapshot(): McpOAuthAuthorizationSnapshot {
    if (!this.options.configurationIsCurrent() || this.token && this.expiresAt !== undefined && this.now() >= this.expiresAt) {
      if (this.token) { this.clearToken(false); this.state = 'needs-sign-in' }
      if (this.flow) { void this.cancelSignIn() }
    }
    return { revision: this.revision, ...(this.token ? { bearerToken: this.token } : {}) }
  }
  bearerProvider(): AuthProvider {
    const revision = this.authorizationSnapshot().revision
    return { token: async () => { const current = this.authorizationSnapshot(); return current.revision === revision ? current.bearerToken : undefined } }
  }
  /** Inert projection for local listing. Never expires authority, rotates epochs or cancels work. */
  peekStatus(): { readonly state: McpOAuthState; readonly revision: string } {
    const expired = !!this.token && this.expiresAt !== undefined && this.now() >= this.expiresAt
    const current = this.options.configurationIsCurrent()
    return { state: !current ? this.flow || this.refreshing ? 'cancelled' : 'needs-sign-in' : expired ? 'needs-sign-in' : this.state,
      revision: this.revision }
  }
  status(): { readonly state: McpOAuthState; readonly revision: string } {
    this.authorizationSnapshot(); return { state: this.state, revision: this.revision }
  }
}
