// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { FetchLike } from '@modelcontextprotocol/client'
import { isMcpHttpServer, mcpDisplayJson } from './mcp-config.js'
import type { McpHttpServerConfig, McpServerConfig } from './mcp-config.js'
import { mcpContainsSecret } from './mcp-content.js'
import { McpManager, mcpStartDisclosure } from './mcp-manager.js'
import type { McpConfigurationLifecycle, McpManagerOptions } from './mcp-manager.js'
import { McpOAuthError, McpOAuthSession } from './mcp-oauth-session.js'
import type { McpOAuthSessionOptions, McpOAuthState } from './mcp-oauth-session.js'
import { McpOAuthStoreError } from './mcp-oauth-store.js'
import type { McpOAuthSavedRecord, McpOAuthStore, McpOAuthStoreLifecycle } from './mcp-oauth-store.js'
import { validateMcpOAuthRedirectPath } from './mcp-oauth-callback.js'
import { McpOAuthRegistration } from './mcp-oauth-registration.js'
import type { McpOAuthRegistrationSettings } from './mcp-oauth-registration.js'
import { discoverMcpOAuth, fetchMcpOAuthClientMetadata } from './mcp-oauth-discovery.js'
import { mcpOAuthRemoteUrl } from './mcp-oauth-network.js'
import { fetchMcpOAuthNative } from './mcp-oauth-native.js'
import type { ChatIO } from './terminal.js'

export interface McpOAuthPublicClient {
  readonly id: string
  readonly issuer: string
  readonly redirectPort: number
  readonly redirectPath: string
  readonly scopes: readonly string[]
  readonly resource?: string
}
/** Trusted boundary evidence only. Never contains credential or provider response data. */
export interface McpOAuthEffectReceipt {
  readonly kind: 'authorization-granted' | 'authorization-refreshed' | 'public-client-registered' |
    'saved-client-replaced' | 'saved-credentials-replaced' | 'refresh-intent-replaced' | 'saved-sign-in-forgotten'
  readonly serverId: string
  readonly revision: string
  readonly recordRevision?: string
  readonly durabilityUnverified?: boolean
}
export interface McpOAuthOperationLifecycle {
  assertCurrent(): void
  effect(receipt: McpOAuthEffectReceipt): void
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
  /** Optional hosted, JSON CIMD document; never assume another client's identity. */
  readonly clientMetadataUrl?: string
  readonly redirectPort?: number
  readonly redirectPath?: string
  /** Privileged host only. Omitting this keeps existing embedders session-only. */
  readonly savedStore?: McpOAuthStore
}
interface Registration {
  readonly client: McpOAuthPublicClient
  readonly endpoint: string
  readonly configRevision: string
  revision: string
  state: 'disconnected' | 'needs-sign-in'
  session?: McpOAuthSession
  saved?: McpOAuthSavedRecord
  connectionFailure?: string
}
interface Attempt {
  active: boolean
  readonly lifecycle?: McpOAuthOperationLifecycle
  readonly persistence: Set<Promise<unknown>>
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
  private readonly cleanups = new Set<string>()
  private internalDisconnect: { readonly serverId: string; readonly attempt: Attempt } | undefined
  private readonly secrets: string[] = []
  private readonly anonymousRevision = randomUUID()
  private readonly clientMetadataUrls = new Map<string, string>()
  private readonly uncertainRegistrations = new Set<string>()
  private readonly signInRequired = new Set<string>()
  private closed = false
  constructor(private readonly options: McpOAuthControlsOptions) { this.secrets.push(...options.secrets ?? []) }
  bind(manager: McpManager): void {
    if (this.manager || this.closed) throw new McpOAuthError('invalid-plan')
    this.manager = manager
  }
  managerOptions(): Pick<McpManagerOptions, 'httpAuthorization' | 'httpAuthorizationInvalidated'> {
    return { httpAuthorization: server => this.authorization(server),
      httpAuthorizationInvalidated: (id, reason, next) => this.invalidate(id, reason, next) }
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
    if (this.cleanups.has(serverId)) throw new McpOAuthError('cancelled')
    const manager = this.owner(); await manager.reload()
    const server = manager.statuses().find(status => status.server.id === serverId)?.server
    if (!server || !isMcpHttpServer(server) || !server.endpoint.startsWith('https:')) throw new McpOAuthError('authorization-failed')
    if (mcpContainsSecret(client, this.knownSecrets)) throw new McpOAuthError('authorization-failed')
    validateMcpOAuthRedirectPath(client.redirectPath)
    // Reuse the adapter's strict public client/issuer/scope checks without discovering or granting anything.
    const validation = new McpOAuthSession({ endpoint: server.endpoint, configRevision: manager.configurationRevision(), client,
      scopes: client.scopes, fetchFn: this.options.fetchFn ?? fetchMcpOAuthNative, openBrowser: this.options.openBrowser ?? openMcpOAuthBrowser,
      registerSecrets: () => undefined, configurationIsCurrent: () => true })
    const configRevision = manager.configurationRevision(), previous = this.registrations.get(serverId)
    await validation.disconnect()
    await manager.disconnect(serverId)
    await manager.reload()
    if (this.closed || manager.configurationRevision() !== configRevision || this.registrations.get(serverId) !== previous) throw new McpOAuthError('cancelled')
    if (mcpContainsSecret(client, this.knownSecrets)) throw new McpOAuthError('authorization-failed')
    const saved = await this.options.savedStore?.saveClient(serverId, server.endpoint, client,
      () => !this.closed && !this.cleanups.has(serverId) && manager.configurationRevision() === configRevision && this.registrations.get(serverId) === previous)
    if (this.closed || this.cleanups.has(serverId) || manager.configurationRevision() !== configRevision || this.registrations.get(serverId) !== previous) throw new McpOAuthError('cancelled')
    this.installClient(serverId, client, server.endpoint, configRevision)
    if (saved) this.registrations.get(serverId)!.saved = saved
  }
  private installClient(serverId: string, client: McpOAuthPublicClient, endpoint: string, configRevision: string): void {
    this.registrations.set(serverId, { client: Object.freeze({ ...client, scopes: Object.freeze([...client.scopes]) }),
      endpoint, configRevision, revision: randomUUID(), state: 'disconnected' })
  }
  private lifecycleCurrent(lifecycle?: McpOAuthOperationLifecycle): boolean {
    try { lifecycle?.assertCurrent(); return true } catch { return false }
  }
  private observe(serverId: string, revision: string, lifecycle: McpOAuthOperationLifecycle | undefined, kind: McpOAuthEffectReceipt['kind']): void {
    lifecycle?.effect(Object.freeze({ kind, serverId, revision }))
    lifecycle?.assertCurrent()
  }
  private storeLifecycle(lifecycle: McpOAuthOperationLifecycle | undefined, revision: string, cleanup = false): McpOAuthStoreLifecycle | undefined {
    return lifecycle ? { assertCurrent: () => { if (!cleanup) lifecycle.assertCurrent() },
      effect: receipt => lifecycle.effect(Object.freeze({ ...receipt, revision })) } : undefined
  }
  private trackPersistence<T>(attempt: Attempt, work: Promise<T>): Promise<T> {
    attempt.persistence.add(work)
    void work.then(() => attempt.persistence.delete(work), () => attempt.persistence.delete(work))
    return work
  }
  /** Aborted SDK waits cannot abandon a protected native save past final setup settlement. */
  private async drainPersistence(attempt: Attempt): Promise<void> {
    while (attempt.persistence.size) await Promise.allSettled([...attempt.persistence])
  }
  private persistence(entry: Registration, attempt: Attempt): Pick<McpOAuthSessionOptions, 'saveCredentials' | 'refreshCredentials'> {
    const store = this.options.savedStore
    if (!store || !entry.saved) return {}
    return {
      saveCredentials: async (tokens, context) => {
        const saved = entry.saved!
        entry.saved = await this.trackPersistence(attempt, store.saveTokens(saved.serverId, entry.endpoint, saved.revision, tokens,
          context.isCurrent, context.signal, this.storeLifecycle(attempt.lifecycle, entry.configRevision)))
        attempt.lifecycle?.assertCurrent()
      },
      refreshCredentials: async (perform, context) => {
        const saved = entry.saved!
        entry.saved = await this.trackPersistence(attempt, store.refreshTokens(saved.serverId, entry.endpoint, saved.revision, perform,
          context.isCurrent, context.signal, this.storeLifecycle(attempt.lifecycle, entry.configRevision)))
        attempt.lifecycle?.assertCurrent()
        return entry.saved.tokens!
      }
    }
  }
  canRegisterPublicClient(): boolean { return !this.closed && this.options.dynamicRegistration === 'explicit' }
  savesSignIn(): boolean { return Boolean(this.options.savedStore) }
  /** Inert launch-local evidence only. Never reads or unlocks secure storage. */
  hasSavedSignIn(serverId: string): boolean {
    const entry = this.registrations.get(serverId)
    return !this.closed && !this.signInRequired.has(serverId) && entry?.state !== 'needs-sign-in' &&
      entry?.configRevision === this.manager?.configurationRevision() && Boolean(entry?.saved?.tokens)
  }
  connectionFailure(serverId: string): string | undefined {
    const entry = this.registrations.get(serverId)
    return !this.closed && entry?.configRevision === this.manager?.configurationRevision() ? entry?.connectionFailure : undefined
  }
  private connectionRejected(serverId: string): boolean {
    return this.manager?.statuses().find(status => status.server.id === serverId)?.message ===
      'MCP HTTP needs sign-in; explicit sign-in and fresh connection approval are required'
  }
  private reportConnectionFailure(serverId: string, entry: Registration, io: ChatIO, signedIn = false): void {
    const status = this.manager?.statuses().find(status => status.server.id === serverId)
    const rejected = this.connectionRejected(serverId)
    // Manager messages contain fixed host classifications, never remote error text.
    const reason = status?.message ?? 'MCP connection was not established'
    const recovery = rejected ? 'The server rejected the credentials; choose Sign in again'
      : entry.saved?.tokens ? 'Saved sign-in was retained. Choose Connect to retry without browser sign-in'
      : 'No connection is active'
    const protocolEvidence = reason === 'MCP protocol handshake failed' ? `Configured protocol: ${status!.server.protocol}. ` : ''
    entry.connectionFailure = `${signedIn ? 'Browser sign-in completed, but the MCP connection failed. ' : ''}${reason}. ${protocolEvidence}${recovery}`
    io.write(`MCP ${serverId}: ${entry.connectionFailure}\n`)
  }
  hasActiveAttempt(serverId: string): boolean { return this.attempts.has(serverId) }
  setClientMetadataUrl(serverId: string, value: string): void {
    const url = mcpOAuthRemoteUrl(value)
    if (url.pathname === '/' || mcpContainsSecret(value, this.knownSecrets)) throw new McpOAuthError('authorization-failed')
    this.clientMetadataUrls.set(serverId, url.href)
    this.signInRequired.add(serverId)
  }
  registrationStatus(serverId: string): { readonly state: string; readonly revision: string } {
    const attempt = this.attempts.get(serverId)
    return attempt?.registration?.status() ?? { state: 'idle', revision: attempt?.revision ?? this.anonymousRevision }
  }
  private claim(serverId: string, lifecycle?: McpOAuthOperationLifecycle): Attempt {
    lifecycle?.assertCurrent()
    if (this.attempts.has(serverId) || this.cleanups.has(serverId)) throw new McpOAuthError('invalid-plan')
    const entry = this.registrations.get(serverId)
    if (entry) delete entry.connectionFailure
    const attempt: Attempt = { active: true, abort: new AbortController(), revision: randomUUID(), persistence: new Set(), ...(lifecycle ? { lifecycle } : {}) }
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
          const response = await (this.options.fetchFn ?? fetchMcpOAuthNative)(input, init)
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
  /** Local listing must not revoke expired tokens or cancel a stale active flow. */
  peekStatus(serverId: string): { readonly state: McpOAuthState | 'unconfigured'; readonly revision: string } {
    const entry = this.registrations.get(serverId)
    return entry?.session?.peekStatus() ?? { state: entry?.state ?? (this.signInRequired.has(serverId) ? 'needs-sign-in' : 'unconfigured'),
      revision: entry?.revision ?? this.anonymousRevision }
  }
  status(serverId: string): { readonly state: McpOAuthState | 'unconfigured'; readonly revision: string } {
    const entry = this.registrations.get(serverId)
    return entry?.session?.status() ?? { state: entry?.state ?? (this.signInRequired.has(serverId) ? 'needs-sign-in' : 'unconfigured'), revision: entry?.revision ?? this.anonymousRevision }
  }
  authorization(server: McpHttpServerConfig): { readonly revision: string; readonly bearerToken?: string } {
    const entry = this.registrations.get(server.id)
    if (!entry || entry.endpoint !== server.endpoint || entry.configRevision !== this.manager?.configurationRevision())
      return { revision: this.anonymousRevision }
    return entry.session?.authorizationSnapshot() ?? { revision: entry.revision }
  }
  invalidate(serverId?: string, reason: InvalidationReason = 'disconnect', nextServers?: readonly McpServerConfig[]): Promise<void> {
    // Capture ownership before synchronous revocation. Even delayed denial cleanup
    // belongs to this attempt until its entire CAS invalidation has settled.
    const owners = [...this.attempts.entries()].filter(([id, attempt]) => (serverId === undefined || id === serverId) &&
      !(reason === 'disconnect' && this.internalDisconnect?.serverId === id && this.internalDisconnect.attempt === attempt))
    const work = this.performInvalidate(serverId, reason, nextServers)
    for (const [, attempt] of owners) this.trackPersistence(attempt, work)
    return work
  }
  private async performInvalidate(serverId?: string, reason: InvalidationReason = 'disconnect', nextServers?: readonly McpServerConfig[]): Promise<void> {
    // A known configuration commit adopts its new identity before cleanup settles.
    // Capture changed IDs synchronously while the manager still exposes the old set.
    const next = reason === 'configuration' && nextServers
      ? new Map(nextServers.filter(isMcpHttpServer).map(server => [server.id, server.endpoint])) : undefined
    const changed = next ? this.manager?.statuses().filter(status => isMcpHttpServer(status.server) &&
      next.get(status.server.id) !== status.server.endpoint).map(status => status.server.id) ?? [] : []
    if (reason === 'closed') this.closed = true
    if (reason === 'needs-sign-in' && serverId !== undefined) this.signInRequired.add(serverId)
    if (reason === 'configuration' || reason === 'closed') {
      if (serverId === undefined) { this.signInRequired.clear(); this.clientMetadataUrls.clear() }
      else { this.signInRequired.delete(serverId); this.clientMetadataUrls.delete(serverId) }
    }
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
    const store = this.options.savedStore
    if (!store) return
    if (reason === 'closed') await store.settle()
    // Global expiry/catalog invalidation is not an HTTP denial. Retain eligible
    // refresh credentials and unrelated servers; specific denials forget one CAS epoch.
    if (reason === 'needs-sign-in' && serverId !== undefined) {
      await store.settle()
      const entry = entries.find(([id]) => id === serverId)?.[1]
      if (entry?.saved) {
        const attempt = active.find(([id]) => id === serverId)?.[1]
        const work = store.clearTokens(serverId, entry.endpoint, entry.saved.revision,
          this.storeLifecycle(attempt?.lifecycle, entry.configRevision, true))
        const saved = await (attempt ? this.trackPersistence(attempt, work) : work)
        if (saved) entry.saved = saved; else delete entry.saved
      }
    }
    if (reason === 'configuration' && nextServers) {
      if (changed.length) { await store.settle(); for (const id of changed) await store.remove(id) }
    }
  }
  /** Local sign-out, including a fresh command process with no RAM registration. */
  async logout(serverId: string, lifecycle?: McpOAuthOperationLifecycle): Promise<void> {
    lifecycle?.assertCurrent()
    await this.withCleanup(serverId, () => this.logoutOwned(serverId, lifecycle))
  }
  private async withCleanup(serverId: string, action: () => Promise<void>): Promise<void> {
    if (this.cleanups.has(serverId)) throw new McpOAuthError('invalid-plan')
    this.cleanups.add(serverId)
    try { await action() } finally { this.cleanups.delete(serverId) }
  }
  private async logoutOwned(serverId: string, lifecycle?: McpOAuthOperationLifecycle): Promise<void> {
    lifecycle?.assertCurrent()
    const manager = this.owner()
    const previous = this.registrations.get(serverId)
    if (previous) delete previous.connectionFailure
    const closing = manager.disconnect(serverId)
    await closing
    await this.options.savedStore?.settle()
    await manager.reload()
    lifecycle?.assertCurrent()
    const server = manager.statuses().find(status => status.server.id === serverId)?.server
    const effects = this.storeLifecycle(lifecycle, manager.configurationRevision())
    if (server && isMcpHttpServer(server)) {
      const saved = await this.options.savedStore?.clearTokens(serverId, server.endpoint, undefined, effects)
      const entry = this.registrations.get(serverId)
      if (entry) { if (saved) entry.saved = saved; else delete entry.saved; entry.state = 'needs-sign-in' }
      this.signInRequired.add(serverId)
    } else await this.options.savedStore?.remove(serverId, () => this.lifecycleCurrent(lifecycle), effects)
  }
  async forgetSaved(serverId: string): Promise<void> {
    await this.withCleanup(serverId, () => this.forgetOwned(serverId))
  }
  private async forgetOwned(serverId: string, expectedRevision?: string, lifecycle?: McpOAuthOperationLifecycle): Promise<void> {
    lifecycle?.assertCurrent()
    const manager = this.owner()
    const previous = this.registrations.get(serverId)
    if (previous) delete previous.connectionFailure
    await manager.disconnect(serverId)
    await this.options.savedStore?.settle()
    if (expectedRevision !== undefined) {
      await manager.reload()
      if (manager.configurationRevision() !== expectedRevision) throw new Error('MCP configuration changed; review the current configuration')
    }
    await this.options.savedStore?.remove(serverId, async () => !this.closed && this.lifecycleCurrent(lifecycle) &&
      (expectedRevision === undefined || await manager.configurationMatches(expectedRevision)),
      this.storeLifecycle(lifecycle, expectedRevision ?? manager.configurationRevision()))
    const entry = this.registrations.get(serverId)
    if (entry) delete entry.saved
  }
  async remove(serverId: string, expectedRevision?: string, lifecycle?: McpConfigurationLifecycle,
    operationLifecycle?: McpOAuthOperationLifecycle): Promise<void> {
    operationLifecycle?.assertCurrent()
    const manager = this.owner()
    await manager.reload()
    const revision = expectedRevision ?? manager.configurationRevision()
    if (manager.configurationRevision() !== revision) throw new Error('MCP configuration changed; review the current configuration')
    await this.withCleanup(serverId, async () => {
      await this.forgetOwned(serverId, revision, operationLifecycle)
      operationLifecycle?.assertCurrent()
      await manager.remove(serverId, revision, lifecycle)
    })
  }
  /** Restore only after a human Connect action. Listing never reads/unlocks keys. */
  async connectSaved(serverId: string, io: ChatIO, signal: AbortSignal, lifecycle?: McpOAuthOperationLifecycle): Promise<boolean | undefined> {
    const store = this.options.savedStore
    if (!store) return undefined
    const manager = this.owner(), attempt = this.claim(serverId, lifecycle), combined = AbortSignal.any([signal, attempt.abort.signal])
    let connected = false
    try {
      combined.throwIfAborted(); await manager.reload()
      const server = manager.statuses().find(status => status.server.id === serverId)?.server
      if (!server || !isMcpHttpServer(server) || !server.endpoint.startsWith('https:')) return undefined
      const configRevision = manager.configurationRevision()
      const current = (): boolean => this.lifecycleCurrent(lifecycle) && !this.closed && !combined.aborted && !io.isClosed &&
        this.attempts.get(serverId) === attempt && manager.configurationRevision() === configRevision
      await this.disconnectOwned(serverId, attempt)
      if (!current()) throw new McpOAuthError('cancelled')
      const saved = await store.load(serverId, server.endpoint)
      if (!current()) throw new McpOAuthError('cancelled')
      if (!saved) return undefined
      if (saved.tokens) this.register([saved.tokens.accessToken, ...(saved.tokens.refreshToken ? [saved.tokens.refreshToken] : [])])
      this.installClient(serverId, saved.client, server.endpoint, configRevision)
      const entry = this.registrations.get(serverId)!
      entry.saved = saved
      if (!saved.tokens) { entry.state = 'needs-sign-in'; return undefined }
      if (mcpContainsSecret(saved.client, this.knownSecrets)) throw new McpOAuthError('authorization-failed')
      const checkedFetch: FetchLike = async (input, init) => {
        await manager.reload(); if (!current()) throw new McpOAuthError('cancelled')
        const destination = String(input instanceof Request ? input.url : input)
        if (mcpContainsSecret(destination, this.knownSecrets)) throw new McpOAuthError('authorization-failed')
        const response = await (this.options.fetchFn ?? fetchMcpOAuthNative)(input, init)
        await manager.reload(); if (!current()) { void response.body?.cancel().catch(() => undefined); throw new McpOAuthError('cancelled') }
        return response
      }
      const refreshNeeded = saved.tokens.expiresAt !== undefined && (this.options.now ?? Date.now)() >= saved.tokens.expiresAt - 30_000
      // Read-only discovery prepares the exact destination for human consent;
      // no refresh authority or MCP request is sent before that approval.
      const discovery = refreshNeeded ? await discoverMcpOAuth(server.endpoint, { signal: combined,
        assertCurrent: () => { if (!current()) throw new McpOAuthError('cancelled') }, issuer: saved.client.issuer, fetchFn: checkedFetch }) : undefined
      if (discovery && discovery.resource !== (saved.client.resource ?? server.endpoint)) throw new McpOAuthStoreError('needs-sign-in')
      const description = `Reconnect to this trusted MCP server using saved sign-in. ${discovery ? 'Vivi sends one refresh request to the exact validated token endpoint below using the existing public client, resource and granted scopes. Refreshed credentials are saved securely before use.' : 'The current saved credentials do not need a refresh request.'} No browser or public client registration is started. Then protocol and tool metadata requests go to the same endpoint; ready metadata enters the selected model/provider context. Calls and resource reads need separate approval. Denied or uncertain authority is never replayed. Disconnect retains saved sign-in; Sign out forgets it locally and does not revoke the issuer's grant.\nServer: ${mcpDisplayJson(serverId)}\nEndpoint: ${mcpDisplayJson(server.endpoint)}\nIssuer: ${mcpDisplayJson(saved.client.issuer)}\n${discovery ? `Token endpoint: ${mcpDisplayJson(discovery.info.authorizationServerMetadata!.token_endpoint)}\n` : ''}Resource: ${mcpDisplayJson(saved.client.resource ?? server.endpoint)}\nGranted scopes: ${mcpDisplayJson(saved.tokens.scopes)}\nPublic client ID: ${mcpDisplayJson(saved.client.id)}\nProtocol: ${server.protocol}\nConfiguration revision: ${mcpDisplayJson(configRevision)}`
      if (mcpContainsSecret([description, discovery, saved.client], this.knownSecrets)) throw new McpOAuthError('authorization-failed')
      const approved = await cancellable(io.approve({ call: { id: randomUUID(), name: 'connect_saved_mcp_server', arguments: {
        serverId, configRevision, authorizationRevision: attempt.revision
      } }, currentRevision: attempt.revision, description }, combined), combined)
      await manager.reload()
      if (!current()) throw new McpOAuthError('cancelled')
      if (!approved) return false
      // A no-refresh consent cannot gain a token POST while the human reviews it.
      if (!refreshNeeded && saved.tokens.expiresAt !== undefined && (this.options.now ?? Date.now)() >= saved.tokens.expiresAt - 30_000)
        throw new McpOAuthStoreError('changed')
      // Prune stale disk identities only under an approved connection action.
      await store.reconcile(manager.statuses().map(status => status.server).filter(isMcpHttpServer)
        .filter(item => item.endpoint.startsWith('https:')).map(item => ({ id: item.id, endpoint: item.endpoint })), this.storeLifecycle(lifecycle, configRevision))
      if ((await store.load(serverId, server.endpoint))?.revision !== saved.revision) throw new McpOAuthStoreError('changed')
      const session = new McpOAuthSession({ endpoint: server.endpoint, configRevision,
        authorizationIssued: kind => this.observe(serverId, configRevision, lifecycle, kind), client: saved.client,
        scopes: saved.client.scopes, discoveryResource: saved.client.resource ?? server.endpoint, initialCredentials: saved.tokens,
        ...(discovery ? { discovery: discovery.info } : {}), ...this.persistence(entry, attempt), fetchFn: checkedFetch,
        openBrowser: async () => { throw new McpOAuthError('authorization-failed') }, registerSecrets: values => this.register(values),
        configurationIsCurrent: () => !this.closed && manager.configurationRevision() === configRevision && this.registrations.get(serverId) === entry &&
          (!attempt.active || current()),
        ...(this.options.now ? { now: this.options.now } : {}), ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }) })
      entry.session = session; attempt.session = session
      if (!discovery && saved.tokens.expiresAt !== undefined && (this.options.now ?? Date.now)() >= saved.tokens.expiresAt - 30_000)
        throw new McpOAuthStoreError('changed')
      if (discovery) await session.refresh(combined)
      if (!current()) throw new McpOAuthError('cancelled')
      const epoch = session.authorizationSnapshot().revision
      connected = await manager.connect(serverId, async (launch, approvalSignal) => current() && !approvalSignal.aborted &&
        launch.configRevision === configRevision && JSON.stringify(launch.server) === JSON.stringify(server) &&
        session.authorizationSnapshot().revision === epoch && session.status().state === 'connected', combined, { assertCurrent: () => { if (!current()) throw new McpOAuthError('cancelled') } })
      if (connected) {
        const generation = manager.statuses().find(status => status.server.id === serverId)?.snapshot?.connectionGeneration
        connected = false
        await manager.reload()
        const fresh = manager.statuses().find(status => status.server.id === serverId)
        if (!current() || !generation || fresh?.state !== 'connected' || fresh.snapshot?.connectionGeneration !== generation ||
          session.authorizationSnapshot().revision !== epoch) throw new McpOAuthError('invalid-plan')
        connected = true
        this.signInRequired.delete(serverId)
      }
      if (!connected && (current() || this.connectionRejected(serverId)) && !signal.aborted && !io.isClosed && !this.closed && this.registrations.get(serverId) === entry &&
        manager.configurationRevision() === entry.configRevision) this.reportConnectionFailure(serverId, entry, io)
      return connected
    } finally {
      try { if (!connected) await this.disconnectOwned(serverId, attempt) }
      finally { await this.drainPersistence(attempt); attempt.active = false; if (this.attempts.get(serverId) === attempt) this.attempts.delete(serverId) }
    }
  }
  /** URL-first human setup: discover, prepare a supported public client, then sign
   * in and connect under one exact disclosed approval. Browser consent stays human.
   * No transport challenge invokes this method or replays a refused operation.
   */
  async guidedSignInAndConnect(serverId: string, io: ChatIO, signal: AbortSignal, mode?: 'session-only', lifecycle?: McpOAuthOperationLifecycle): Promise<boolean> {
    const manager = this.owner(), attempt = this.claim(serverId, lifecycle)
    const combined = AbortSignal.any([signal, attempt.abort.signal])
    let connected = false, registrationSubmitted = false, registrationCompleted = false
    try {
      combined.throwIfAborted(); await manager.reload()
      const server = manager.statuses().find(status => status.server.id === serverId)?.server
      if (!server || !isMcpHttpServer(server) || !server.endpoint.startsWith('https:')) throw new McpOAuthError('authorization-failed')
      const configRevision = manager.configurationRevision()
      const current = (): boolean => this.lifecycleCurrent(lifecycle) && !this.closed && !combined.aborted && !io.isClosed &&
        this.attempts.get(serverId) === attempt && manager.configurationRevision() === configRevision
      const assertCurrent = (): void => { if (!current()) throw new McpOAuthError('cancelled') }
      const checkedFetch: FetchLike = async (input, init) => {
        await manager.reload(); assertCurrent()
        const destination = String(input instanceof Request ? input.url : input)
        if (mcpContainsSecret(destination, this.knownSecrets)) throw new McpOAuthError('authorization-failed')
        const response = await (this.options.fetchFn ?? fetchMcpOAuthNative)(input, init)
        await manager.reload()
        if (!current()) { void response.body?.cancel().catch(() => undefined); throw new McpOAuthError('cancelled') }
        return response
      }
      await this.disconnectOwned(serverId, attempt); assertCurrent()
      const store = this.options.savedStore
      let remember = Boolean(store) && mode !== 'session-only'
      if (remember) {
        let available = (await store!.status()).available
        assertCurrent()
        if (available) {
          try {
            const saved = await store!.load(serverId, server.endpoint)
            assertCurrent()
            if (saved) {
              if (saved.tokens) this.register([saved.tokens.accessToken, ...(saved.tokens.refreshToken ? [saved.tokens.refreshToken] : [])])
              if (mcpContainsSecret(saved.client, this.knownSecrets)) throw new McpOAuthError('authorization-failed')
              this.installClient(serverId, saved.client, server.endpoint, configRevision)
              this.registrations.get(serverId)!.saved = saved
            }
          } catch (error) { if (error instanceof McpOAuthStoreError) available = false; else throw error }
        }
        if (!available) {
          const description = 'Secure saved MCP sign-in is unavailable or locked. You can unlock OS credential storage or use Sign out to reset the local saved record, then try again. Choose session-only sign-in explicitly to continue for this launch; no credentials or client settings will be saved. Browser sign-in and connecting still need their own reviewed approval.'
          const accepted = await cancellable(io.approve({ call: { id: randomUUID(), name: 'use_session_only_mcp_sign_in', arguments: {
            serverId, configRevision, authorizationRevision: attempt.revision
          } }, currentRevision: attempt.revision, description }, combined), combined)
          await manager.reload(); assertCurrent()
          if (!accepted) return false
          remember = false
        }
      }
      const existing = this.registrations.get(serverId)
      io.write(`Discovering sign-in for MCP ${serverId}…\n`)
      const discovery = await discoverMcpOAuth(server.endpoint, { signal: combined, assertCurrent,
        ...(this.options.fetchFn ? { fetchFn: checkedFetch } : {}), ...(existing ? { issuer: existing.client.issuer } : {}) })
      await manager.reload(); assertCurrent()
      let client = existing?.client, registrationPlan: Awaited<ReturnType<McpOAuthRegistration['prepareRegistration']>> | undefined
      let mechanism = client ? 'existing public client' : ''
      const metadata = discovery.info.authorizationServerMetadata!
      const metadataUrl = this.clientMetadataUrls.get(serverId) ?? this.options.clientMetadataUrl
      if (!client && metadata.client_id_metadata_document_supported === true && metadataUrl) {
        const document = await fetchMcpOAuthClientMetadata(metadataUrl, { signal: combined, assertCurrent,
          ...(this.options.fetchFn ? { fetchFn: checkedFetch } : {}) })
        assertCurrent()
        const redirect = Array.isArray(document.redirect_uris) && document.redirect_uris.length === 1
          ? document.redirect_uris[0] : undefined
        let callback: URL | undefined
        try { if (typeof redirect === 'string') callback = new URL(redirect) } catch { /* fixed error below */ }
        if (document.client_id !== metadataUrl || document.token_endpoint_auth_method !== 'none' ||
          Object.hasOwn(document, 'client_secret') || Object.hasOwn(document, 'client_secret_expires_at') ||
          !callback || callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || !callback.port ||
          callback.username || callback.password || callback.search || callback.hash ||
          !Array.isArray(document.grant_types) || document.grant_types.length !== 1 || document.grant_types[0] !== 'authorization_code' ||
          !Array.isArray(document.response_types) || document.response_types.length !== 1 || document.response_types[0] !== 'code')
          throw new McpOAuthError('client-registration-failed')
        validateMcpOAuthRedirectPath(callback.pathname)
        client = { id: metadataUrl, issuer: discovery.issuer, redirectPort: Number(callback.port),
          redirectPath: callback.pathname, scopes: discovery.scopes }
        mechanism = 'hosted client metadata document'
      }
      if (!client) {
        if (this.uncertainRegistrations.has(serverId)) throw new McpOAuthError('client-registration-uncertain')
        if (!this.canRegisterPublicClient() || !metadata.registration_endpoint) {
          io.write('This server needs a pre-registered public client. Open Advanced → Public client settings, or supply a hosted client metadata document supported by the issuer. No browser or registration was started\n')
          return false
        }
        const registration = new McpOAuthRegistration({ endpoint: server.endpoint, configRevision,
          issuer: discovery.issuer, scopes: discovery.scopes, redirectPort: this.options.redirectPort ?? 52147,
          redirectPath: this.options.redirectPath ?? '/oauth/callback', clientName: 'vivi-cli',
          discovery: discovery.info, discoveryResource: discovery.resource, fetchFn: checkedFetch,
          registered: () => this.observe(serverId, configRevision, lifecycle, 'public-client-registered'),
          registerSecrets: values => this.register(values), configurationIsCurrent: current,
          ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }) })
        attempt.registration = registration
        registrationPlan = await registration.prepareRegistration(combined); assertCurrent()
        mechanism = 'automatic public client registration'
      }
      const scopes = existing ? existing.client.scopes : discovery.scopes
      const description = `Sign in and connect to this trusted MCP server. ${registrationPlan ? 'This sends the exact public client metadata below once to the validated registration endpoint, then opens browser sign-in.' : 'This opens browser sign-in using the public client below.'} After you grant access in the browser, vivi will connect to the same endpoint and discover tool metadata. Ready tool aliases and schemas will be exposed to your selected model/provider automatically; remote metadata is untrusted. Calls and resource reads still require their own approval. ${remember ? 'Public client settings and sign-in credentials will be saved in OS-protected encrypted storage for this profile. Later approved Connect actions may refresh the same grant without repeating browser setup. Disconnect retains saved sign-in; Sign out forgets it locally.' : 'Credentials last for this launch only; no settings or tokens will be saved.'} The issuer may retain a public client registration or account grant; local logout does not revoke it. Review the provider’s permissions, expiry and any spending limits before granting access.\nServer: ${mcpDisplayJson(serverId)}\nEndpoint: ${mcpDisplayJson(server.endpoint)}\nResource: ${mcpDisplayJson(discovery.resource)}\nIssuer: ${mcpDisplayJson(discovery.issuer)}\nAuthorization endpoint: ${mcpDisplayJson(metadata.authorization_endpoint)}\nToken endpoint: ${mcpDisplayJson(metadata.token_endpoint)}\nRequested scopes: ${mcpDisplayJson(scopes)}\nClient setup: ${mechanism}\n${registrationPlan ? `Registration endpoint: ${mcpDisplayJson(registrationPlan.registrationEndpoint)}\nPublic client metadata: ${mcpDisplayJson(registrationPlan.clientMetadata)}` : `Client ID: ${mcpDisplayJson(client!.id)}\nCallback: ${mcpDisplayJson(`http://127.0.0.1:${client!.redirectPort}${client!.redirectPath}`)}`}\nProtocol: ${server.protocol}\nConfiguration revision: ${mcpDisplayJson(configRevision)}`
      if (mcpContainsSecret([description, discovery, client, registrationPlan], this.knownSecrets)) throw new McpOAuthError('authorization-failed')
      const approved = await cancellable(io.approve({ call: { id: randomUUID(), name: 'sign_in_mcp_server', arguments: {
        serverId, configRevision, authorizationRevision: attempt.revision,
        ...(registrationPlan ? { registrationRevision: registrationPlan.revision } : {})
      } }, currentRevision: attempt.revision, description }, combined), combined)
      await manager.reload(); assertCurrent()
      if (!approved) return false
      if (mcpContainsSecret([description, discovery, client, registrationPlan], this.knownSecrets)) throw new McpOAuthError('authorization-failed')
      if (registrationPlan) {
        registrationSubmitted = true
        client = await attempt.registration!.beginRegistration(registrationPlan, combined)
        registrationCompleted = true
        await manager.reload(); assertCurrent()
      }
      if (!client || client.issuer !== discovery.issuer) throw new McpOAuthError('authorization-failed')
      if (mcpContainsSecret([description, discovery, client, registrationPlan], this.knownSecrets)) throw new McpOAuthError('authorization-failed')
      client = { ...client, scopes, resource: discovery.resource }
      const saved = remember ? await this.trackPersistence(attempt, store!.saveClient(serverId, server.endpoint, client, current, combined,
        this.storeLifecycle(lifecycle, configRevision))) : undefined
      await manager.reload(); assertCurrent()
      this.installClient(serverId, client, server.endpoint, configRevision)
      const entry = this.registrations.get(serverId)!
      if (saved) entry.saved = saved
      const session = new McpOAuthSession({ endpoint: server.endpoint, configRevision,
        authorizationIssued: kind => this.observe(serverId, configRevision, lifecycle, kind), client, scopes,
        ...this.persistence(entry, attempt),
        discovery: discovery.info, discoveryResource: discovery.resource, fetchFn: checkedFetch,
        openBrowser: async (url, browserSignal) => { assertCurrent();
          if (mcpContainsSecret([client, server.endpoint, url.origin + url.pathname], this.knownSecrets)) throw new McpOAuthError('authorization-failed')
          io.write('Opening your browser. Review access there, then return to vivi. Escape or Ctrl-C cancels\n');
          await (this.options.openBrowser ?? openMcpOAuthBrowser)(url, browserSignal); assertCurrent() },
        registerSecrets: values => this.register(values), configurationIsCurrent: () => !this.closed &&
          manager.configurationRevision() === configRevision && this.registrations.get(serverId) === entry && (!attempt.active || current()),
        ...(this.options.now ? { now: this.options.now } : {}), ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }) })
      entry.session = session; attempt.session = session
      const plan = await session.prepareSignIn(combined); assertCurrent()
      await session.beginSignIn(plan, combined); await manager.reload(); assertCurrent()
      // A newly validated grant replaces the previously denied authorization epoch.
      this.signInRequired.delete(serverId)
      // The bundled approval covers only the server/issuer/scopes above. The manager
      // still pins and rechecks a fresh token-bound launch before any MCP send.
      connected = await manager.connect(serverId, async (launch, approvalSignal) => current() &&
        !approvalSignal.aborted && launch.configRevision === configRevision &&
        JSON.stringify(launch.server) === JSON.stringify(server) && session.status().state === 'connected', combined, { assertCurrent })
      if (connected) {
        const generation = manager.statuses().find(status => status.server.id === serverId)?.snapshot?.connectionGeneration
        connected = false
        await manager.reload(); assertCurrent()
        const fresh = manager.statuses().find(status => status.server.id === serverId)
        if (!generation || fresh?.state !== 'connected' || fresh.snapshot?.connectionGeneration !== generation) throw new McpOAuthError('invalid-plan')
        connected = true
        this.signInRequired.delete(serverId)
      }
      if (!connected && (current() || this.connectionRejected(serverId)) && !signal.aborted && !io.isClosed && !this.closed && this.registrations.get(serverId) === entry &&
        manager.configurationRevision() === entry.configRevision) this.reportConnectionFailure(serverId, entry, io, true)
      return connected
    } catch (error) {
      if (registrationSubmitted && !registrationCompleted) this.uncertainRegistrations.add(serverId)
      throw error instanceof McpOAuthError || error instanceof McpOAuthStoreError ? error : new McpOAuthError(combined.aborted || io.isClosed ? 'cancelled' : 'authorization-failed')
    } finally {
      try {
        await attempt.registration?.cancelRegistration()
        if (!connected) await this.disconnectOwned(serverId, attempt)
      } finally { await this.drainPersistence(attempt); attempt.active = false; if (this.attempts.get(serverId) === attempt) this.attempts.delete(serverId) }
    }
  }
  async signInAndConnect(serverId: string, io: ChatIO, signal: AbortSignal, lifecycle?: McpOAuthOperationLifecycle): Promise<boolean> {
    const manager = this.owner()
    const attempt = this.claim(serverId, lifecycle), combined = AbortSignal.any([signal, attempt.abort.signal])
    let connected = false
    try {
      combined.throwIfAborted(); await manager.reload(); await this.disconnectOwned(serverId, attempt)
      const entry = this.registrations.get(serverId)
      if (!entry) throw new McpOAuthError('client-registration-required')
      const current = (): boolean => this.lifecycleCurrent(lifecycle) && !this.closed && !combined.aborted && !io.isClosed &&
        this.registrations.get(serverId) === entry && manager.configurationRevision() === entry.configRevision
      const session = new McpOAuthSession({ endpoint: entry.endpoint, configRevision: entry.configRevision,
        authorizationIssued: kind => this.observe(serverId, entry.configRevision, lifecycle, kind),
        client: entry.client, scopes: entry.client.scopes, fetchFn: async (input, init) => {
          await manager.reload(); if (!current()) throw new McpOAuthError('cancelled')
          const response = await (this.options.fetchFn ?? fetchMcpOAuthNative)(input, init)
          await manager.reload(); if (!current()) { void response.body?.cancel().catch(() => undefined); throw new McpOAuthError('cancelled') }
          return response
        }, openBrowser: async (url, browserSignal) => {
          if (!current() || mcpContainsSecret([entry.client, entry.endpoint, url.origin + url.pathname], this.knownSecrets))
            throw new McpOAuthError('authorization-failed')
          await (this.options.openBrowser ?? openMcpOAuthBrowser)(url, browserSignal)
        }, registerSecrets: values => this.register(values),
        configurationIsCurrent: () => !this.closed && manager.configurationRevision() === entry.configRevision &&
          this.registrations.get(serverId) === entry && (!attempt.active || current()),
        ...(this.options.now ? { now: this.options.now } : {}),
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
      }, combined, { assertCurrent: () => { if (!current()) throw new McpOAuthError('cancelled') } })
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
      } finally { await this.drainPersistence(attempt); attempt.active = false; if (this.attempts.get(serverId) === attempt) this.attempts.delete(serverId) }
    }
  }

  async close(): Promise<void> { await this.invalidate(undefined, 'closed') }
}
