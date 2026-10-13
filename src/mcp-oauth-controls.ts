// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { FetchLike } from '@modelcontextprotocol/client'
import { isMcpHttpServer, mcpDisplayJson } from './mcp-config.js'
import type { McpHttpServerConfig } from './mcp-config.js'
import { mcpContainsSecret } from './mcp-content.js'
import { McpManager, mcpStartDisclosure } from './mcp-manager.js'
import type { McpManagerOptions } from './mcp-manager.js'
import { McpOAuthError, McpOAuthSession } from './mcp-oauth-session.js'
import type { McpOAuthState } from './mcp-oauth-session.js'
import { validateMcpOAuthRedirectPath } from './mcp-oauth-callback.js'
import { McpOAuthRegistration } from './mcp-oauth-registration.js'
import type { McpOAuthRegistrationSettings } from './mcp-oauth-registration.js'
import type { ChatIO } from './terminal.js'

export interface McpOAuthPublicClient {
  readonly id: string
  readonly issuer: string
  readonly redirectPort: number
  readonly redirectPath: string
  readonly scopes: readonly string[]
}
export interface McpOAuthControlsOptions {
  /** Human-only opt-in. Transport challenges and sign-in never register a client. */
  readonly dynamicRegistration?: 'explicit' | 'disabled'
  readonly fetchFn?: FetchLike
  readonly openBrowser?: (url: URL, signal: AbortSignal) => Promise<void>
  readonly registerSecrets: (values: readonly string[]) => void
  readonly secrets?: readonly string[]
  readonly now?: () => number
  readonly timeoutMs?: number
}
interface Registration {
  readonly client: McpOAuthPublicClient
  readonly endpoint: string
  readonly configRevision: string
  revision: string
  state: 'disconnected' | 'needs-sign-in'
  session?: McpOAuthSession
}
interface Attempt {
  readonly abort: AbortController
  readonly revision: string
  registration?: McpOAuthRegistration
  session?: McpOAuthSession
}
type InvalidationReason = 'configuration' | 'disconnect' | 'closed' | 'needs-sign-in'

function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new McpOAuthError('cancelled'))
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new McpOAuthError('cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** Small shell-free OS opener. Provider URLs and subprocess output are never printed. */
export async function openMcpOAuthBrowser(url: URL, signal: AbortSignal): Promise<void> {
  if (url.protocol !== 'https:' || url.username || url.password || signal.aborted) throw new McpOAuthError('authorization-failed')
  const command = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href]
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const child = spawn(command, args, { shell: false, stdio: 'ignore', windowsHide: true })
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort)
      if (ok) resolve(); else reject(new McpOAuthError(signal.aborted ? 'cancelled' : 'authorization-failed'))
    }
    const abort = (): void => { child.kill(); finish(false) }
    const timer = setTimeout(abort, 5000)
    child.once('error', () => finish(false)); child.once('exit', code => finish(code === 0))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** Launch-owned UI coordinator. Public client settings and credentials never enter saved configuration. */
export class McpOAuthControls {
  private manager: McpManager | undefined
  private readonly registrations = new Map<string, Registration>()
  private readonly attempts = new Map<string, Attempt>()
  private internalDisconnect: { readonly serverId: string; readonly attempt: Attempt } | undefined
  private readonly secrets: string[] = []
  private readonly anonymousRevision = randomUUID()
  private closed = false
  constructor(private readonly options: McpOAuthControlsOptions) { this.secrets.push(...options.secrets ?? []) }
  bind(manager: McpManager): void {
    if (this.manager || this.closed) throw new McpOAuthError('invalid-plan')
    this.manager = manager
  }
  managerOptions(): Pick<McpManagerOptions, 'httpAuthorization' | 'httpAuthorizationInvalidated'> {
    return { httpAuthorization: server => this.authorization(server),
      httpAuthorizationInvalidated: (id, reason) => this.invalidate(id, reason) }
  }
  private get knownSecrets(): readonly string[] { return [...this.options.secrets ?? [], ...this.secrets] }
  private owner(): McpManager {
    if (!this.manager || this.closed) throw new McpOAuthError('cancelled')
    return this.manager
  }
  private register(values: readonly string[]): void {
    const fresh = values.filter(value => value && !this.secrets.includes(value))
    this.secrets.push(...fresh)
    // Propagate before any SDK parsing, approval, display, persistence or model context.
    this.manager?.addSecrets(fresh); this.options.registerSecrets(fresh)
  }
  async configureClient(serverId: string, client: McpOAuthPublicClient): Promise<void> {
    const manager = this.owner(); await manager.reload()
    const server = manager.statuses().find(status => status.server.id === serverId)?.server
    if (!server || !isMcpHttpServer(server) || !server.endpoint.startsWith('https:')) throw new McpOAuthError('authorization-failed')
    if (mcpContainsSecret(client, this.knownSecrets)) throw new McpOAuthError('authorization-failed')
    validateMcpOAuthRedirectPath(client.redirectPath)
    // Reuse the adapter's strict public client/issuer/scope checks without discovering or granting anything.
    const validation = new McpOAuthSession({ endpoint: server.endpoint, configRevision: manager.configurationRevision(), client,
      scopes: client.scopes, fetchFn: this.options.fetchFn ?? fetch, openBrowser: this.options.openBrowser ?? openMcpOAuthBrowser,
      registerSecrets: () => undefined, configurationIsCurrent: () => true })
    const configRevision = manager.configurationRevision(), previous = this.registrations.get(serverId)
    await validation.disconnect()
    await manager.disconnect(serverId)
    await manager.reload()
    if (this.closed || manager.configurationRevision() !== configRevision || this.registrations.get(serverId) !== previous) throw new McpOAuthError('cancelled')
    if (mcpContainsSecret(client, this.knownSecrets)) throw new McpOAuthError('authorization-failed')
    this.installClient(serverId, client, server.endpoint, configRevision)
  }
  private installClient(serverId: string, client: McpOAuthPublicClient, endpoint: string, configRevision: string): void {
    this.registrations.set(serverId, { client: Object.freeze({ ...client, scopes: Object.freeze([...client.scopes]) }),
      endpoint, configRevision, revision: randomUUID(), state: 'disconnected' })
  }
  canRegisterPublicClient(): boolean { return !this.closed && this.options.dynamicRegistration === 'explicit' }
  hasActiveAttempt(serverId: string): boolean { return this.attempts.has(serverId) }
  registrationStatus(serverId: string): { readonly state: string; readonly revision: string } {
    const attempt = this.attempts.get(serverId)
    return attempt?.registration?.status() ?? { state: 'idle', revision: attempt?.revision ?? this.anonymousRevision }
  }
  private claim(serverId: string): Attempt {
    if (this.attempts.has(serverId)) throw new McpOAuthError('invalid-plan')
    const attempt = { abort: new AbortController(), revision: randomUUID() }
    this.attempts.set(serverId, attempt)
    return attempt
  }
  private disconnectOwned(serverId: string, attempt: Attempt): Promise<void> {
    // The manager invokes its invalidation hook synchronously. Exempt only this
    // exact call's attempt; an external disconnect always cancels the attempt.
    this.internalDisconnect = { serverId, attempt }
    try {
      if (!this.manager) throw new McpOAuthError('cancelled')
      return this.manager.disconnect(serverId)
    }
    finally { this.internalDisconnect = undefined }
  }
  async registerPublicClient(serverId: string, settings: McpOAuthRegistrationSettings, io: ChatIO, signal: AbortSignal): Promise<boolean> {
    const manager = this.owner()
    if (!this.canRegisterPublicClient()) throw new McpOAuthError('client-registration-failed')
    const attempt = this.claim(serverId), combined = AbortSignal.any([signal, attempt.abort.signal])
    let submitted = false
    try {
      combined.throwIfAborted(); await manager.reload(); combined.throwIfAborted()
      const server = manager.statuses().find(status => status.server.id === serverId)?.server
      if (!server || !isMcpHttpServer(server) || !server.endpoint.startsWith('https:')) throw new McpOAuthError('authorization-failed')
      const configRevision = manager.configurationRevision(), previous = this.registrations.get(serverId)
      const current = (): boolean => !this.closed && !combined.aborted && !io.isClosed &&
        this.attempts.get(serverId) === attempt && this.registrations.get(serverId) === previous &&
        manager.configurationRevision() === configRevision
      if (mcpContainsSecret(settings, this.knownSecrets)) throw new McpOAuthError('authorization-failed')
      await this.disconnectOwned(serverId, attempt)
      if (!current()) throw new McpOAuthError('cancelled')
      const registration = new McpOAuthRegistration({ ...settings, endpoint: server.endpoint, configRevision,
        fetchFn: async (input, init) => {
          await manager.reload(); if (!current()) throw new McpOAuthError('cancelled')
          const response = await (this.options.fetchFn ?? fetch)(input, init)
          await manager.reload(); if (!current()) { void response.body?.cancel().catch(() => undefined); throw new McpOAuthError('cancelled') }
          return response
        }, registerSecrets: values => this.register(values), configurationIsCurrent: current,
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }) })
      attempt.registration = registration
      const plan = await registration.prepareRegistration(combined)
      const description = `Register one public OAuth client with this issuer. This sends the exact public metadata below to the validated registration endpoint once. The issuer may retain this registration. Local disconnect clears bearer authority; public client settings remain only for this launch. Configuration changes, removal and app close clear those settings, and do not delete the issuer's record. No browser, authorization grant, token exchange, MCP connection or persistence is started. Return to the menu afterward; sign-in and connecting each need separate fresh human approval. Browser sign-in may create billable API access: inspect the provider's spending limits, expiry and consent before granting access.\nServer: ${mcpDisplayJson(serverId)}\nEndpoint: ${mcpDisplayJson(plan.endpoint)}\nIssuer: ${mcpDisplayJson(plan.issuer)}\nRegistration endpoint: ${mcpDisplayJson(plan.registrationEndpoint)}\nPublic client metadata: ${mcpDisplayJson(plan.clientMetadata)}\nConfiguration revision: ${mcpDisplayJson(plan.configRevision)}\nRegistration revision: ${mcpDisplayJson(plan.revision)}`
      if (!current() || mcpContainsSecret([settings, plan, description], this.knownSecrets)) throw new McpOAuthError('authorization-failed')
      const approved = await cancellable(io.approve({ call: { id: randomUUID(), name: 'register_mcp_oauth_client', arguments: {
        serverId, configRevision: plan.configRevision, registrationRevision: plan.revision
      } }, currentRevision: plan.revision, description }, combined), combined)
      await manager.reload()
      if (!current()) throw new McpOAuthError('cancelled')
      if (!approved) return false
      if (mcpContainsSecret([settings, plan], this.knownSecrets)) throw new McpOAuthError('authorization-failed')
      submitted = true
      const client = await registration.beginRegistration(plan, combined)
      await manager.reload()
      if (!current()) throw new McpOAuthError('client-registration-uncertain')
      if (mcpContainsSecret(client, this.knownSecrets)) throw new McpOAuthError('authorization-failed')
      this.installClient(serverId, client, server.endpoint, configRevision)
      return true
    } catch (error) {
      if (error instanceof McpOAuthError && error.code.startsWith('client-registration-')) throw error
      throw new McpOAuthError(submitted ? 'client-registration-uncertain' : combined.aborted || io.isClosed || this.closed
        ? 'client-registration-cancelled' : 'client-registration-failed')
    } finally {
      try { await attempt.registration?.cancelRegistration() }
      finally { if (this.attempts.get(serverId) === attempt) this.attempts.delete(serverId) }
    }
  }
  status(serverId: string): { readonly state: McpOAuthState | 'unconfigured'; readonly revision: string } {
    const entry = this.registrations.get(serverId)
    return entry?.session?.status() ?? { state: entry?.state ?? 'unconfigured', revision: entry?.revision ?? this.anonymousRevision }
  }
  authorization(server: McpHttpServerConfig): { readonly revision: string; readonly bearerToken?: string } {
    const entry = this.registrations.get(server.id)
    if (!entry || entry.endpoint !== server.endpoint || entry.configRevision !== this.manager?.configurationRevision())
      return { revision: this.anonymousRevision }
    return entry.session?.authorizationSnapshot() ?? { revision: entry.revision }
  }
  async invalidate(serverId?: string, reason: InvalidationReason = 'disconnect'): Promise<void> {
    if (reason === 'closed') this.closed = true
    const entries = serverId === undefined ? [...this.registrations.entries()] : [...this.registrations.entries()].filter(([id]) => id === serverId)
    // Revoke authority synchronously before the first asynchronous cleanup,
    // including registration discovery/approval before any client entry exists.
    const active = serverId === undefined ? [...this.attempts.entries()] : [...this.attempts.entries()].filter(([id]) => id === serverId)
    const pending: Promise<void>[] = []
    for (const [id, attempt] of active) {
      if (reason === 'disconnect' && this.internalDisconnect?.serverId === id && this.internalDisconnect.attempt === attempt) continue
      attempt.abort.abort()
      if (attempt.registration) pending.push(attempt.registration.cancelRegistration())
      if (attempt.session) pending.push(attempt.session.disconnect())
    }
    const cleanups = entries.map(([id, entry]) => {
      entry.revision = randomUUID()
      const session = entry.session
      if (reason === 'configuration' || reason === 'closed') this.registrations.delete(id)
      if (reason === 'needs-sign-in') { entry.state = 'needs-sign-in'; return session?.requireSignIn() ?? Promise.resolve() }
      entry.state = 'disconnected'; delete entry.session
      return session?.disconnect() ?? Promise.resolve()
    })
    await Promise.all([...pending, ...cleanups])
  }
  async signInAndConnect(serverId: string, io: ChatIO, signal: AbortSignal): Promise<boolean> {
    const manager = this.owner()
    const attempt = this.claim(serverId), combined = AbortSignal.any([signal, attempt.abort.signal])
    let connected = false
    try {
      combined.throwIfAborted(); await manager.reload(); await this.disconnectOwned(serverId, attempt)
      const entry = this.registrations.get(serverId)
      if (!entry) throw new McpOAuthError('client-registration-required')
      const current = (): boolean => !this.closed && !combined.aborted && !io.isClosed &&
        this.registrations.get(serverId) === entry && manager.configurationRevision() === entry.configRevision
      const session = new McpOAuthSession({ endpoint: entry.endpoint, configRevision: entry.configRevision,
        client: entry.client, scopes: entry.client.scopes, fetchFn: async (input, init) => {
          await manager.reload(); if (!current()) throw new McpOAuthError('cancelled')
          const response = await (this.options.fetchFn ?? fetch)(input, init)
          await manager.reload(); if (!current()) { void response.body?.cancel().catch(() => undefined); throw new McpOAuthError('cancelled') }
          return response
        }, openBrowser: async (url, browserSignal) => {
          if (!current() || mcpContainsSecret([entry.client, entry.endpoint, url.origin + url.pathname], this.knownSecrets))
            throw new McpOAuthError('authorization-failed')
          await (this.options.openBrowser ?? openMcpOAuthBrowser)(url, browserSignal)
        }, registerSecrets: values => this.register(values),
        configurationIsCurrent: current, ...(this.options.now ? { now: this.options.now } : {}),
        ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }) })
      entry.session = session; attempt.session = session
      const plan = await session.prepareSignIn(combined)
      const description = `Sign in to this MCP server using your browser for this launch only. This opens the validated authorization endpoint, sends the public client ID and requested scopes, and receives the response on an owned loopback callback. Credentials remain in memory; connecting to MCP needs a separate fresh approval. Browser sign-in may create billable API access: inspect the provider's spending limits, expiry and consent before granting access. Local disconnect clears launch credentials; it does not revoke provider-side grants or keys. The issuer may retain the public client registration.\nServer: ${mcpDisplayJson(serverId)}\nEndpoint: ${mcpDisplayJson(plan.endpoint)}\nAuthorization endpoint: ${mcpDisplayJson(plan.authorizationEndpoint)}\nIssuer: ${mcpDisplayJson(plan.issuer)}\nRequested scopes: ${mcpDisplayJson(plan.scopes)}\nRegistration: pre-registered public client\nClient ID: ${mcpDisplayJson(entry.client.id)}\nRegistered callback: ${mcpDisplayJson(`http://127.0.0.1:${entry.client.redirectPort}${entry.client.redirectPath}`)}\nConfiguration revision: ${mcpDisplayJson(plan.configRevision)}\nAuthorization revision: ${mcpDisplayJson(plan.revision)}`
      if (mcpContainsSecret(description, this.knownSecrets)) throw new McpOAuthError('authorization-failed')
      const approved = await cancellable(io.approve({ call: { id: randomUUID(), name: 'sign_in_mcp_server', arguments: {
        serverId, configRevision: plan.configRevision, authorizationRevision: plan.revision
      } }, currentRevision: plan.revision, description }, combined), combined)
      await manager.reload()
      if (!approved) return false
      if (!current()) throw new McpOAuthError('cancelled')
      if (mcpContainsSecret([entry.client, plan], this.knownSecrets)) throw new McpOAuthError('authorization-failed')
      await session.beginSignIn(plan, combined)
      if (!current()) throw new McpOAuthError('cancelled')
      connected = await manager.connect(serverId, async (launch, approvalSignal) => {
        const approved = await io.approve({ call: { id: randomUUID(), name: 'connect_mcp_server', arguments: {
          serverId, launchDigest: launch.digest, configRevision: launch.configRevision
        } }, currentRevision: launch.digest, description: mcpStartDisclosure(launch) }, approvalSignal)
        return approved && !approvalSignal.aborted && !io.isClosed && current()
      }, combined)
      if (connected) {
        const generation = manager.statuses().find(status => status.server.id === serverId)?.snapshot?.connectionGeneration
        connected = false // A failed final recheck must still revoke the new grant.
        await manager.reload()
        if (!current()) throw new McpOAuthError('cancelled')
        const fresh = manager.statuses().find(status => status.server.id === serverId)
        if (!generation || fresh?.state !== 'connected' || fresh.snapshot?.connectionGeneration !== generation)
          throw new McpOAuthError('invalid-plan')
        connected = true
      }
      return connected
    } catch (error) {
      throw error instanceof McpOAuthError ? error : new McpOAuthError(combined.aborted || io.isClosed || this.closed ? 'cancelled' : 'authorization-failed')
    } finally {
      try {
        // Keep the claim while cleanup can still close this attempt's connection.
        // A successful grant without an approved usable fresh connection must not stay active.
        if (!connected) {
          const cleanupEntry = this.registrations.get(serverId)
          const needsSignIn = cleanupEntry?.session?.status().state === 'needs-sign-in'
          try { await this.disconnectOwned(serverId, attempt) } catch { throw new McpOAuthError('authorization-failed') }
          const entry = this.registrations.get(serverId)
          if (entry && entry === cleanupEntry && needsSignIn) entry.state = 'needs-sign-in'
        }
      } finally { if (this.attempts.get(serverId) === attempt) this.attempts.delete(serverId) }
    }
  }

  async close(): Promise<void> { await this.invalidate(undefined, 'closed') }
}
