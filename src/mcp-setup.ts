// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import type { ToolCall, ToolResult } from '@ayayaq/vivi'
import { isMcpHttpServer, mcpDigest, mcpDisplayJson, mcpFreeze, mcpRecord, mcpText, validateMcpServer } from './mcp-config.js'
import type { McpHttpServerConfig } from './mcp-config.js'
import { McpConfigurationChangeError, McpManager, mcpStartDisclosure } from './mcp-manager.js'
import type { McpConfigurationLifecycle } from './mcp-manager.js'
import type { McpOAuthControls } from './mcp-oauth-controls.js'
import type { McpOAuthEffectReceipt, McpOAuthOperationLifecycle } from './mcp-oauth-controls.js'
import { McpOAuthStoreError } from './mcp-oauth-store.js'
import type { ChatIO } from './terminal.js'
import type { ApprovalRequest } from './tools.js'

export interface McpSetupHttpInput {
  readonly id: string
  readonly label?: string
  readonly endpoint: string
  readonly protocol?: McpHttpServerConfig['protocol']
  readonly allowLoopbackHttp?: boolean
}
export interface McpSetupLocalServer {
  readonly id: string
  readonly label: string
  readonly transport: 'http' | 'stdio'
  readonly endpoint?: string
  readonly protocol: string
  readonly state: string
  readonly signInState?: string
  readonly message?: string
  readonly nextAction?: 'Connect' | 'Sign in' | 'Reconnect'
}
export type McpSetupEffectReceipt = {
  readonly kind: 'configuration-saved'
  readonly serverId: string
  readonly revision: string
  readonly affectedServerIds: readonly string[]
} | {
  readonly kind: 'connected' | 'logged-out'
  readonly serverId: string
  readonly revision: string
} | McpOAuthEffectReceipt
/** Trusted, turn-owned host callbacks. These never enter model arguments. */
export interface McpSetupExecutionContext {
  readonly io: ChatIO
  assertCurrent(): void
  approve(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>
  beforeEffect(): Promise<void>
  settle(result: ToolResult): Promise<void>
  /** Immediate known evidence, retained even when later settlement fails. */
  effect?(receipt: McpSetupEffectReceipt): void
}
type SetupAction = 'add' | 'connect' | 'login' | 'logout' | 'remove'
function setupInput(call: ToolCall): { readonly action: SetupAction; readonly id: string; readonly expectedRevision: string; readonly server?: McpHttpServerConfig } {
  const args = call.arguments
  if (call.name !== 'mcp_setup' || !mcpText(call.id, 256) || !mcpRecord(args) ||
    Object.keys(args).some(key => !['action', 'id', 'expectedRevision', 'endpoint', 'label', 'protocol'].includes(key)) ||
    typeof args.action !== 'string' || !['add', 'connect', 'login', 'logout', 'remove'].includes(args.action) ||
    typeof args.id !== 'string' || !/^[a-z][a-z0-9_-]{0,15}$/.test(args.id) ||
    typeof args.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedRevision)) throw new Error('Invalid MCP setup proposal')
  const action = args.action as SetupAction
  if (action !== 'add') {
    if (Object.keys(args).length !== 3) throw new Error('Invalid MCP setup proposal')
    return { action, id: args.id, expectedRevision: args.expectedRevision }
  }
  if (!mcpText(args.endpoint, 4096) || Object.hasOwn(args, 'label') && !mcpText(args.label, 80) ||
    Object.hasOwn(args, 'protocol') && !['auto', 'legacy', '2026-07-28'].includes(String(args.protocol))) throw new Error('Invalid MCP setup proposal')
  const server = validateMcpServer({ transport: 'http', id: args.id, label: args.label ?? args.id,
    endpoint: args.endpoint, protocol: args.protocol ?? 'auto', allowLoopbackHttp: false }) as McpHttpServerConfig
  return { action, id: args.id, expectedRevision: args.expectedRevision, server }
}
function setupResult(body: Record<string, unknown>): ToolResult {
  return mcpFreeze({ content: JSON.stringify({ source: 'mcp-setup', ...body,
    ...(body.confirmedOutcome === true ? { doNotRetry: true } : {}) }), ...(body.success === false ? { isError: true } : {}) })
}

/** User-authored setup shared by the menu and provider-independent command line.
 * Listing is inert. Network/client/browser actions retain current-plan human consent.
 */
export class McpSetupService {
  constructor(readonly manager: McpManager, readonly oauth?: McpOAuthControls) {}
  /** A fresh local read, independent of mutable catalogs, auth refresh and reload. */
  async listLocal(signal: AbortSignal): Promise<{ readonly revision: string; readonly servers: readonly McpSetupLocalServer[] }> {
    signal.throwIfAborted()
    const snapshot = await this.manager.localStatuses()
    signal.throwIfAborted()
    return mcpFreeze({ revision: snapshot.revision, servers: snapshot.statuses.map(status => {
      const http = isMcpHttpServer(status.server)
      const signInState = http && snapshot.revision === this.manager.configurationRevision() ? this.oauth?.peekStatus(status.server.id).state : undefined
      const message = status.message ?? (http && snapshot.revision === this.manager.configurationRevision()
        ? this.oauth?.connectionFailure(status.server.id) : undefined)
      return { id: status.server.id, label: status.server.label, transport: http ? 'http' as const : 'stdio' as const,
        ...(http ? { endpoint: status.server.endpoint } : {}), protocol: status.server.protocol, state: status.state,
        ...(signInState ? { signInState } : {}),
        ...(message ? { message } : {}),
        ...(status.state === 'connected' ? {} : { nextAction: !this.oauth?.hasSavedSignIn(status.server.id) && signInState && !['unconfigured', 'connected'].includes(signInState)
          ? 'Sign in' as const : status.state === 'error' ? 'Reconnect' as const : 'Connect' as const }) }
    }) })
  }
  /** Same manager and OAuth operations as user setup, behind an additional exact
   * human proposal review. Auto mode and model revision text are never consent. */
  async executeSetup(call: ToolCall, signal: AbortSignal, context: McpSetupExecutionContext): Promise<ToolResult> {
    let attempted = false, receipt: McpSetupEffectReceipt | undefined, result: ToolResult
    const receipts: McpSetupEffectReceipt[] = []
    const assertCurrent = (): void => { signal.throwIfAborted(); context.assertCurrent(); if (context.io.isClosed) throw new Error('MCP setup owner closed') }
    const observe = (value: McpSetupEffectReceipt): void => { receipt = mcpFreeze(value); receipts.push(receipt); context.effect?.(receipt) }
    const known = (success: boolean, cleanupUnverified = false, durabilityUnverified = false): ToolResult => {
      const configuration = [...receipts].reverse().find(value => value.kind === 'configuration-saved')
      return setupResult({ success, confirmedOutcome: true, knownEffects: receipts, effectReceipt: receipt,
        ...(receipts.some(value => value.kind === 'connected') ? { requestSent: true } : {}),
        ...(configuration?.kind === 'configuration-saved' ? { configSaved: true, configRevision: configuration.revision, affectedServerIds: configuration.affectedServerIds } : {}),
        ...(!success ? { setupIncomplete: true, message: 'MCP setup did not complete. The listed effects were observed; account grants are not undone by cancellation. Inspect /mcp before retrying' } : {}),
        ...(cleanupUnverified ? { cleanupUnverified: true } : {}),
        ...(durabilityUnverified || receipts.some(value => 'durabilityUnverified' in value && value.durabilityUnverified) ? { durabilityUnverified: true } : {}) })
    }
    try {
      assertCurrent()
      const ownedCall = mcpFreeze({ id: call.id, name: call.name, arguments: structuredClone(call.arguments) })
      const input = setupInput(ownedCall), snapshot = await this.manager.localStatuses()
      assertCurrent()
      if (input.expectedRevision !== snapshot.revision) throw new Error('MCP setup revision changed')
      const existing = snapshot.statuses.find(status => status.server.id === input.id)?.server
      if (input.action === 'add' ? !!existing : !existing) throw new Error('MCP setup target changed')
      const affectedServerIds = input.action === 'add' || input.action === 'remove' ||
        !!this.manager.configurationRevision() && snapshot.revision !== this.manager.configurationRevision()
        ? [...new Set([...snapshot.statuses, ...this.manager.statuses()].map(status => status.server.id))] : [input.id]
      const proposal = mcpFreeze({ action: input.action, id: input.id, expectedRevision: input.expectedRevision,
        server: input.server ?? existing!, affectedServerIds })
      const assertRevision = async (): Promise<void> => {
        assertCurrent()
        if ((await this.manager.localStatuses()).revision !== input.expectedRevision) throw new Error('MCP setup revision changed')
        assertCurrent()
      }
      const description = `Review this exact MCP setup proposal. ${input.action === 'add'
        ? 'Save one disabled HTTPS entry. This does not connect, sign in or install anything.'
        : input.action === 'remove' ? 'Remove this local saved entry and clear its local authority. This does not revoke issuer-side grants.'
        : input.action === 'logout' ? 'Clear this server’s local connection and sign-in authority. This does not revoke issuer-side grants.'
        : 'Proceed to the trusted connection or browser sign-in controls. Protocol/discovery requests may be sent. The exact connection or bundled registration/sign-in/connection plan still needs fresh human approval; account access is granted by you in the browser.'}
Configuration changes invalidate all current MCP connections; affected existing server IDs are listed below. Remote effects cannot be undone by cancellation, and uncertain attempts must not be replayed automatically.
Exact proposal: ${mcpDisplayJson(proposal)}`
      const approved = await context.approve({ call: ownedCall, currentRevision: mcpDigest(proposal), description }, signal)
      await assertRevision()
      if (!approved) result = setupResult({ success: false, confirmedOutcome: true, requestSent: false, notAttempted: true,
        error: { code: 'mcp_setup_denied', message: 'This exact MCP setup proposal was not approved' } })
      else {
        // A failed durable intent hook must prevent every mutation/network dispatch.
        await context.beforeEffect()
        await assertRevision()
        attempted = true
        const lifecycle = { assertCurrent, saved: (configuration: { revision: string }): void => observe({
          kind: 'configuration-saved', serverId: input.id, revision: configuration.revision, affectedServerIds }) }
        const oauthLifecycle = { assertCurrent, effect: observe }
        const manager = this.manager
        const io = new Proxy(context.io, { get(target, key) {
          if (key === 'isClosed') { try {
            assertCurrent()
            // OAuth rechecks its IO owner after each manager reload and before
            // discovery/token/browser dispatch. Bind those checks to the exact
            // initial proposal too, rather than adopting a newer endpoint.
            return !!manager.configurationRevision() && manager.configurationRevision() !== input.expectedRevision
          } catch { return true } }
          if (key === 'approve') return async (request: ApprovalRequest, approvalSignal: AbortSignal): Promise<boolean> => {
            approvalSignal.throwIfAborted(); await assertRevision()
            const allowed = await context.approve(request, approvalSignal)
            approvalSignal.throwIfAborted(); await assertRevision()
            return allowed
          }
          const value: unknown = Reflect.get(target, key, target)
          return typeof value === 'function' ? value.bind(target) : value
        } })
        let completed = false
        if (input.action === 'add') { await this.addHttp(input.server!, input.expectedRevision, lifecycle); completed = true }
        else if (input.action === 'remove') { await this.remove(input.id, input.expectedRevision, lifecycle, oauthLifecycle); completed = true }
        else if (input.action === 'logout') { await this.logout(input.id, oauthLifecycle); completed = true; observe({ kind: 'logged-out', serverId: input.id, revision: input.expectedRevision }) }
        else {
          const connected = await (input.action === 'login' ? this.login(input.id, io, signal, undefined, oauthLifecycle) : this.connect(input.id, io, signal, undefined, oauthLifecycle))
          completed = connected
          if (connected) observe({ kind: 'connected', serverId: input.id, revision: input.expectedRevision })
        }
        result = receipt ? known(completed) : setupResult({ success: false, unknownOutcome: true, doNotRetry: true,
          message: 'MCP setup did not establish a confirmed final outcome. Inspect /mcp before retrying' })
      }
    } catch (error) {
      if (error instanceof McpConfigurationChangeError && receipts.some(value => value.kind === 'configuration-saved')) result = known(false, true, error.durabilityUnverified)
      else if (receipt) result = known(false, true)
      else result = setupResult({ success: false, ...(attempted ? { unknownOutcome: true, doNotRetry: true }
        : { confirmedOutcome: true, requestSent: false, notAttempted: true }),
        error: { code: attempted ? 'mcp_setup_outcome_unavailable' : 'mcp_setup_not_started',
          message: attempted ? 'MCP setup outcome is unavailable. Inspect /mcp before retrying' : 'MCP setup proposal was invalid, stale, cancelled or unavailable; no action was started' } })
    }
    // No freshness/abort guard here: recording an already observed effect does
    // not grant new authority and must survive late cancellation.
    await context.settle(result)
    return result
  }
  list(): { readonly revision: string; readonly servers: readonly McpSetupLocalServer[] } {
    return { revision: this.manager.configurationRevision(), servers: this.manager.statuses().map(status => {
      const http = isMcpHttpServer(status.server), signInState = http ? this.oauth?.status(status.server.id).state : undefined
      const message = status.message ?? this.oauth?.connectionFailure(status.server.id)
      const nextAction = status.state === 'connected' ? undefined
        : !this.oauth?.hasSavedSignIn(status.server.id) && signInState && !['unconfigured', 'connected'].includes(signInState) ? 'Sign in'
        : status.state === 'error' ? 'Reconnect' : 'Connect'
      return { id: status.server.id, label: status.server.label, transport: http ? 'http' : 'stdio',
        ...(http ? { endpoint: status.server.endpoint } : {}), protocol: status.server.protocol, state: status.state,
        ...(signInState ? { signInState } : {}),
        ...(message ? { message } : {}),
        ...(nextAction ? { nextAction } : {}) }
    }) }
  }
  async addHttp(input: McpSetupHttpInput, expectedRevision?: string, lifecycle?: McpConfigurationLifecycle): Promise<void> {
    const server = validateMcpServer({ transport: 'http', id: input.id, label: input.label ?? input.id,
      endpoint: input.endpoint, protocol: input.protocol ?? 'auto', allowLoopbackHttp: input.allowLoopbackHttp ?? false })
    await this.manager.configure(server, expectedRevision, lifecycle)
  }
  async connect(id: string, io: ChatIO, signal: AbortSignal, mode?: 'session-only', lifecycle?: McpOAuthOperationLifecycle): Promise<boolean> {
    await this.manager.reload(); signal.throwIfAborted()
    const server = this.manager.statuses().find(status => status.server.id === id)?.server
    if (!server) throw new Error('MCP server is no longer configured')
    if (mode !== 'session-only' && isMcpHttpServer(server) && server.endpoint.startsWith('https:') && this.oauth) {
      try {
        const saved = await this.oauth.connectSaved(id, io, signal, lifecycle)
        if (saved !== undefined) return saved
      } catch (error) {
        if (lifecycle || !(error instanceof McpOAuthStoreError) || !['unavailable', 'needs-sign-in'].includes(error.code)) throw error
        io.write(`${error.message}\n`)
        return this.login(id, io, signal, undefined, lifecycle)
      }
    }
    const authState = this.oauth?.status(id).state
    if (isMcpHttpServer(server) && server.endpoint.startsWith('https:') && authState && !['unconfigured', 'connected'].includes(authState))
      return this.login(id, io, signal, mode, lifecycle)
    await this.manager.disconnect(id)
    const connected = await this.manager.connect(id, async (launch, approvalSignal) => {
      const approved = await io.approve({ call: { id: randomUUID(), name: 'connect_mcp_server', arguments: {
        serverId: id, launchDigest: launch.digest, configRevision: launch.configRevision
      } }, currentRevision: launch.digest, description: mcpStartDisclosure(launch) }, approvalSignal)
      return approved && !approvalSignal.aborted && !io.isClosed
    }, signal, lifecycle)
    if (!connected && this.oauth?.status(id).state === 'needs-sign-in' && !signal.aborted && !io.isClosed)
      return this.login(id, io, signal, mode, lifecycle)
    return connected
  }
  async login(id: string, io: ChatIO, signal: AbortSignal, mode?: 'session-only', lifecycle?: McpOAuthOperationLifecycle): Promise<boolean> {
    if (!this.oauth) throw new Error('MCP browser sign-in is unavailable in this host')
    return this.oauth.guidedSignInAndConnect(id, io, signal, mode, lifecycle)
  }
  async logout(id: string, lifecycle?: McpOAuthOperationLifecycle): Promise<void> { if (this.oauth) await this.oauth.logout(id, lifecycle); else await this.manager.disconnect(id) }
  async remove(id: string, expectedRevision?: string, lifecycle?: McpConfigurationLifecycle, oauthLifecycle?: McpOAuthOperationLifecycle): Promise<void> {
    // Busy saved authority fails before deleting the visible server entry, so a
    // normal menu/CLI retry can finish cleanup without manual filesystem repair.
    if (this.oauth) await this.oauth.remove(id, expectedRevision, lifecycle, oauthLifecycle)
    else await this.manager.remove(id, expectedRevision, lifecycle)
  }
}
