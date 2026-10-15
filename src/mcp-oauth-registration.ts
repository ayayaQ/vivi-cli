// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import { discoverOAuthServerInfo, registerClient } from '@modelcontextprotocol/client'
import type { FetchLike, OAuthClientMetadata, OAuthDiscoveryState } from '@modelcontextprotocol/client'
import { McpOAuthError, validateMcpOAuthRedirectPath } from './mcp-oauth-callback.js'
import type { McpOAuthRegistrationDiagnostic } from './mcp-oauth-callback.js'
import { createMcpOAuthFetch, mcpOAuthRemoteUrl, validateMcpOAuthDiscovery } from './mcp-oauth-network.js'

export interface McpOAuthRegistrationSettings {
  readonly issuer: string
  readonly redirectPort: number
  readonly redirectPath: string
  readonly scopes: readonly string[]
  readonly clientName: string
}
export interface McpOAuthRegistrationOptions extends McpOAuthRegistrationSettings {
  readonly endpoint: string
  readonly configRevision: string
  readonly fetchFn: FetchLike
  readonly registerSecrets: (values: readonly string[]) => void
  readonly configurationIsCurrent: () => boolean
  /** Trusted, credential-free evidence delivered after exact public-response validation. */
  readonly registered?: () => void
  readonly timeoutMs?: number
  readonly discovery?: OAuthDiscoveryState
  readonly discoveryResource?: string
}
interface PublicClientMetadata {
  readonly redirect_uris: readonly string[]
  readonly application_type: 'native'
  readonly client_name: string
  readonly token_endpoint_auth_method: 'none'
  readonly grant_types: readonly string[]
  readonly response_types: readonly string[]
  readonly scope?: string
}
export interface McpOAuthRegistrationPlan {
  readonly endpoint: string
  readonly configRevision: string
  readonly issuer: string
  readonly registrationEndpoint: string
  readonly redirectUri: string
  readonly clientMetadata: PublicClientMetadata
  readonly revision: string
}
export interface McpOAuthRegisteredClient {
  readonly id: string
  readonly issuer: string
  readonly redirectPort: number
  readonly redirectPath: string
  readonly scopes: readonly string[]
}
export type McpOAuthRegistrationState = 'disconnected' | 'preparing-registration' | 'registration-prepared' | 'registering' | 'registered' | 'cancelled' | 'failed'
interface RegistrationFlow {
  readonly abort: AbortController
  info?: OAuthDiscoveryState
  plan?: McpOAuthRegistrationPlan
  posted: boolean
  diagnostic?: McpOAuthRegistrationDiagnostic
  timer?: ReturnType<typeof setTimeout>
}
const exactly = (actual: unknown, expected: readonly string[]): boolean =>
  Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => actual[index] === value)

/** Field names come from this fixed list, never provider-controlled values. */
function incompatibleFields(client: Record<string, unknown>, plan: McpOAuthRegistrationPlan): readonly string[] {
  const fields: string[] = []
  if (typeof client.client_id !== 'string' || !client.client_id || client.client_id.length > 1024 ||
    /[\u0000-\u0020\u007f-\u009f]/.test(client.client_id)) fields.push('client_id')
  if (client.token_endpoint_auth_method !== 'none') fields.push('token_endpoint_auth_method')
  if (Object.hasOwn(client, 'client_secret')) fields.push('client_secret')
  if (client.issuer !== undefined && client.issuer !== plan.issuer) fields.push('issuer')
  // Servers that do not implement the OIDC application_type extension may omit
  // it. An explicit contradictory type remains unsafe. Display names are
  // negotiated metadata and are neither authority nor persisted by this flow.
  if (client.application_type !== undefined && client.application_type !== 'native') fields.push('application_type')
  if (client.client_name !== undefined && typeof client.client_name !== 'string') fields.push('client_name')
  if (!exactly(client.redirect_uris, [plan.redirectUri])) fields.push('redirect_uris')
  if (!exactly(client.grant_types, ['authorization_code'])) fields.push('grant_types')
  if (!exactly(client.response_types, ['code'])) fields.push('response_types')
  if (client.scope !== plan.clientMetadata.scope) fields.push('scope')
  return Object.freeze(fields)
}

/** One explicitly approved compatibility DCR POST. Never signs in, starts MCP or persists a client. */
export class McpOAuthRegistration {
  private readonly options: McpOAuthRegistrationOptions
  private readonly timeoutMs: number
  private flow: RegistrationFlow | undefined
  private state: McpOAuthRegistrationState = 'disconnected'
  private revision = randomUUID()
  constructor(options: McpOAuthRegistrationOptions) {
    mcpOAuthRemoteUrl(options.endpoint); mcpOAuthRemoteUrl(options.issuer); validateMcpOAuthRedirectPath(options.redirectPath)
    if (!options.configRevision || options.configRevision.length > 256 || !Number.isInteger(options.redirectPort) ||
      options.redirectPort < 1 || options.redirectPort > 65535 || !options.clientName.trim() || options.clientName.length > 128 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(options.clientName) || options.scopes.length > 32 ||
      options.scopes.some(scope => !/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(scope)) || new Set(options.scopes).size !== options.scopes.length)
      throw new McpOAuthError('client-registration-failed')
    this.timeoutMs = options.timeoutMs ?? 120_000
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 600_000) throw new McpOAuthError('client-registration-failed')
    this.options = Object.freeze({ ...options, scopes: Object.freeze([...options.scopes]) })
  }
  private assertCurrent(flow: RegistrationFlow): void {
    if (this.flow !== flow || flow.abort.signal.aborted || !this.options.configurationIsCurrent()) throw new McpOAuthError('cancelled')
  }
  private deadline(flow: RegistrationFlow): void { flow.timer = setTimeout(() => flow.abort.abort(), this.timeoutMs) }
  private attach(flow: RegistrationFlow, signal?: AbortSignal): () => void {
    const abort = (): void => { if (this.flow === flow) void this.cancelRegistration() }
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    return () => signal?.removeEventListener('abort', abort)
  }
  private clear(flow: RegistrationFlow): void { clearTimeout(flow.timer); delete flow.timer; delete flow.info; delete flow.plan }
  private safeFailure(flow: RegistrationFlow, error: unknown): McpOAuthError {
    // A sent POST cannot safely be retried when cancellation, parsing or validation obscures its outcome.
    if (flow.posted) return new McpOAuthError('client-registration-uncertain', flow.diagnostic ??
      (error instanceof McpOAuthError && error.networkPhase ? { kind: 'transport-failure', phase: error.networkPhase } : undefined))
    return new McpOAuthError(error instanceof McpOAuthError && error.code === 'cancelled' || flow.abort.signal.aborted
      ? 'client-registration-cancelled' : 'client-registration-failed')
  }
  private fetchFor(flow: RegistrationFlow): FetchLike {
    return createMcpOAuthFetch({ fetchFn: this.options.fetchFn, signal: flow.abort.signal,
      origins: [mcpOAuthRemoteUrl(this.options.endpoint).origin, mcpOAuthRemoteUrl(this.options.issuer).origin],
      assertCurrent: () => this.assertCurrent(flow), registerSecrets: this.options.registerSecrets,
      postEndpoint: () => this.state === 'registering' ? flow.plan?.registrationEndpoint : undefined,
      posting: () => { flow.posted = true }, responseStatus: (status, url) => {
        if (url.href === flow.plan?.registrationEndpoint)
          flow.diagnostic = status >= 400 ? { kind: 'http-rejected', status } : { kind: 'invalid-response' }
      }, inspectResponse: (record, url, response) => {
        if (url.href !== flow.plan?.registrationEndpoint) return
        if (!response.ok) {
          flow.diagnostic = { kind: 'http-rejected', status: response.status }
          return
        }
        const fields = incompatibleFields(record, flow.plan)
        flow.diagnostic = fields.length ? { kind: 'response-mismatch', fields } : { kind: 'invalid-response' }
        if (fields.includes('issuer') || fields.includes('client_secret')) throw new McpOAuthError('client-registration-failed')
      } })
  }
  async prepareRegistration(signal?: AbortSignal): Promise<McpOAuthRegistrationPlan> {
    const closing = this.cancelRegistration(), revision = this.revision
    await closing
    if (this.revision !== revision) throw new McpOAuthError('invalid-plan')
    const flow: RegistrationFlow = { abort: new AbortController(), posted: false }
    this.flow = flow; this.state = 'preparing-registration'; this.deadline(flow)
    const detach = this.attach(flow, signal)
    try {
      this.assertCurrent(flow)
      const info = this.options.discovery ? structuredClone(this.options.discovery)
        : await discoverOAuthServerInfo(this.options.endpoint, { fetchFn: this.fetchFor(flow) })
      this.assertCurrent(flow)
      const metadata = validateMcpOAuthDiscovery(info, this.options.endpoint, this.options.issuer, this.options.discoveryResource)
      if (!metadata.registration_endpoint) throw new McpOAuthError('client-registration-failed')
      const registrationEndpoint = mcpOAuthRemoteUrl(metadata.registration_endpoint).href
      const redirectUri = `http://127.0.0.1:${this.options.redirectPort}${this.options.redirectPath}`
      const clientMetadata: PublicClientMetadata = Object.freeze({ redirect_uris: Object.freeze([redirectUri]),
        application_type: 'native', client_name: this.options.clientName, token_endpoint_auth_method: 'none',
        grant_types: Object.freeze(['authorization_code']), response_types: Object.freeze(['code']),
        ...(this.options.scopes.length ? { scope: this.options.scopes.join(' ') } : {}) })
      const plan = Object.freeze({ endpoint: this.options.endpoint, configRevision: this.options.configRevision, issuer: this.options.issuer,
        registrationEndpoint, redirectUri, clientMetadata, revision: this.revision })
      flow.info = structuredClone(info); flow.plan = plan; this.state = 'registration-prepared'; clearTimeout(flow.timer); delete flow.timer
      return plan
    } catch (error) { const safe = this.safeFailure(flow, error); this.fail(flow); throw safe }
    finally { detach() }
  }
  async beginRegistration(plan: McpOAuthRegistrationPlan, signal?: AbortSignal): Promise<McpOAuthRegisteredClient> {
    const flow = this.flow
    if (!flow || flow.plan !== plan || this.state !== 'registration-prepared' || plan.revision !== this.revision || !this.options.configurationIsCurrent())
      throw new McpOAuthError('invalid-plan')
    this.state = 'registering' // Claim before any await; this approval authorizes only one POST.
    const detach = this.attach(flow, signal); this.deadline(flow)
    try {
      this.assertCurrent(flow)
      const metadata: OAuthClientMetadata = { ...plan.clientMetadata, redirect_uris: [...plan.clientMetadata.redirect_uris],
        grant_types: [...plan.clientMetadata.grant_types], response_types: [...plan.clientMetadata.response_types] }
      const client = await registerClient(plan.issuer, { metadata: flow.info!.authorizationServerMetadata!,
        clientMetadata: metadata, fetchFn: this.fetchFor(flow) })
      this.assertCurrent(flow)
      const fields = incompatibleFields(client, plan)
      if (fields.length) {
        flow.diagnostic = { kind: 'response-mismatch', fields }
        throw new McpOAuthError('client-registration-failed')
      }
      delete flow.diagnostic
      this.options.registered?.(); this.assertCurrent(flow)
      const result = Object.freeze({ id: client.client_id, issuer: plan.issuer, redirectPort: this.options.redirectPort,
        redirectPath: this.options.redirectPath, scopes: this.options.scopes })
      this.clear(flow); this.assertCurrent(flow); this.flow = undefined; this.state = 'registered'; this.revision = randomUUID()
      return result // Registration management tokens and other response fields are deliberately discarded.
    } catch (error) { const safe = this.safeFailure(flow, error); this.fail(flow); throw safe }
    finally { detach() }
  }
  private fail(flow: RegistrationFlow): void {
    flow.abort.abort(); this.clear(flow)
    if (this.flow === flow) { this.flow = undefined; this.state = 'failed'; this.revision = randomUUID() }
  }
  async cancelRegistration(): Promise<void> {
    const flow = this.flow; this.flow = undefined; this.state = 'cancelled'; this.revision = randomUUID()
    flow?.abort.abort(); if (flow) this.clear(flow)
  }
  status(): { readonly state: McpOAuthRegistrationState; readonly revision: string } { return { state: this.state, revision: this.revision } }
}
