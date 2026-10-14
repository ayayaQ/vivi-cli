// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import { isMcpHttpServer, validateMcpServer } from './mcp-config.js'
import type { McpHttpServerConfig } from './mcp-config.js'
import { McpManager, mcpStartDisclosure } from './mcp-manager.js'
import type { McpOAuthControls } from './mcp-oauth-controls.js'
import type { ChatIO } from './terminal.js'

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
  readonly nextAction?: 'Connect' | 'Sign in' | 'Reconnect'
}

/** User-authored setup shared by the menu and provider-independent command line.
 * Listing is inert. Network/client/browser actions retain current-plan human consent.
 */
export class McpSetupService {
  constructor(readonly manager: McpManager, readonly oauth?: McpOAuthControls) {}
  list(): { readonly revision: string; readonly servers: readonly McpSetupLocalServer[] } {
    return { revision: this.manager.configurationRevision(), servers: this.manager.statuses().map(status => {
      const http = isMcpHttpServer(status.server), signInState = http ? this.oauth?.status(status.server.id).state : undefined
      const nextAction = status.state === 'connected' ? undefined
        : signInState && !['unconfigured', 'connected'].includes(signInState) ? 'Sign in'
        : status.state === 'error' ? 'Reconnect' : 'Connect'
      return { id: status.server.id, label: status.server.label, transport: http ? 'http' : 'stdio',
        ...(http ? { endpoint: status.server.endpoint } : {}), protocol: status.server.protocol, state: status.state,
        ...(signInState ? { signInState } : {}), ...(nextAction ? { nextAction } : {}) }
    }) }
  }
  async addHttp(input: McpSetupHttpInput, expectedRevision?: string): Promise<void> {
    const server = validateMcpServer({ transport: 'http', id: input.id, label: input.label ?? input.id,
      endpoint: input.endpoint, protocol: input.protocol ?? '2026-07-28', allowLoopbackHttp: input.allowLoopbackHttp ?? false })
    await this.manager.configure(server, expectedRevision)
  }
  async connect(id: string, io: ChatIO, signal: AbortSignal): Promise<boolean> {
    await this.manager.reload(); signal.throwIfAborted()
    const server = this.manager.statuses().find(status => status.server.id === id)?.server
    if (!server) throw new Error('MCP server is no longer configured')
    if (isMcpHttpServer(server) && server.endpoint.startsWith('https:') && this.oauth?.status(id).state === 'needs-sign-in')
      return this.login(id, io, signal)
    await this.manager.disconnect(id)
    const connected = await this.manager.connect(id, async (launch, approvalSignal) => {
      const approved = await io.approve({ call: { id: randomUUID(), name: 'connect_mcp_server', arguments: {
        serverId: id, launchDigest: launch.digest, configRevision: launch.configRevision
      } }, currentRevision: launch.digest, description: mcpStartDisclosure(launch) }, approvalSignal)
      return approved && !approvalSignal.aborted && !io.isClosed
    }, signal)
    if (!connected && this.oauth?.status(id).state === 'needs-sign-in' && !signal.aborted && !io.isClosed)
      return this.login(id, io, signal)
    return connected
  }
  async login(id: string, io: ChatIO, signal: AbortSignal): Promise<boolean> {
    if (!this.oauth) throw new Error('MCP browser sign-in is unavailable in this host')
    return this.oauth.guidedSignInAndConnect(id, io, signal)
  }
  async logout(id: string): Promise<void> { await this.manager.disconnect(id) }
  async remove(id: string, expectedRevision?: string): Promise<void> { await this.manager.remove(id, expectedRevision) }
}
