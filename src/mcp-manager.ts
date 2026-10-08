// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/client'
import type { Transport } from '@modelcontextprotocol/client'
import { McpConfigStore, mcpDisplayJson, mcpFreeze, prepareMcpLaunch } from './mcp-config.js'
import type { McpConfiguration, McpLaunchIdentity, McpServerConfig } from './mcp-config.js'
import { collectMcpCategory, emptyMcpCategory, MCP_LIMITS } from './mcp-catalog.js'
import type { McpCatalogKind, McpCatalogSnapshot } from './mcp-catalog.js'
import { McpStdioTransport } from './mcp-transport.js'

export interface McpServerStatus {
  readonly server: McpServerConfig
  readonly state: 'disabled' | 'connecting' | 'connected' | 'error'
  readonly message?: string
  readonly snapshot?: McpCatalogSnapshot
}
export interface McpManagerOptions {
  readonly store: McpConfigStore
  readonly env: NodeJS.ProcessEnv
  readonly secrets?: readonly string[]
  /** Trusted application wiring only; not a model extension or persisted option. */
  readonly transportFactory?: (launch: McpLaunchIdentity) => Transport
}
interface Connection {
  readonly client: Client
  readonly transport: Transport
  readonly controller: AbortController
  readonly generation: string
  catalogGeneration: number
  snapshot?: McpCatalogSnapshot
  state: 'connecting' | 'connected' | 'error'
  message?: string
  refresh?: Promise<void>
}
const categoryMethods = { tools: 'tools/list', resources: 'resources/list', resourceTemplates: 'resources/templates/list' } as const
const kinds: readonly McpCatalogKind[] = ['tools', 'resources', 'resourceTemplates']
class ConfigurationLoadError extends Error {}
export const MCP_START_WARNING = 'Starting this trusted server runs its installed code with your OS permissions, before any tool-call approval. It can access your files and network. This is not a sandbox. Only metadata catalogs are displayed; no model tools or resource contents are enabled.'
export function mcpStartDisclosure(launch: McpLaunchIdentity): string {
  const disclosure = `${MCP_START_WARNING}\nServer: ${launch.server.id} · ${mcpDisplayJson(launch.server.label)}\nExecutable: ${mcpDisplayJson(launch.server.executable)}\nArguments: ${launch.server.args.map(mcpDisplayJson).join(' ') || '(none)'}\nWorking directory: ${mcpDisplayJson(launch.server.cwd)}\nProtocol: ${launch.server.protocol}\nEnvironment: ${Object.entries(launch.environment).map(([name, value]) => `${name}=${mcpDisplayJson(value)}`).join(', ') || '(empty)'}\nThis connection is for this launch only; a new launch or configuration change requires fresh approval.`
  if (disclosure.length > 48 * 1024) throw new Error('MCP approval display exceeds its limit; use a smaller configuration')
  return disclosure
}
/** Discovery only. There is deliberately no callTool/readResource, provider projection or automatic reconnect API. */
export class McpManager {
  private configuration: McpConfiguration = mcpFreeze({ revision: '', servers: [] })
  private readonly connections = new Map<string, Connection>()
  private readonly secrets: string[]
  private closed = false
  constructor(private readonly options: McpManagerOptions) { this.secrets = [...options.secrets ?? []] }
  addSecrets(secrets: readonly string[]): void { this.secrets.push(...secrets.filter(value => value && !this.secrets.includes(value))); this.options.store.addSecrets(secrets) }
  private async revokeConnections(): Promise<void> {
    // Do not await refresh here: revocation can run inside that same task.
    const outcomes = await Promise.allSettled([...this.connections].map(async ([id, connection]) => {
      connection.state = 'error'; connection.message = 'MCP configuration changed or is unavailable'
      connection.catalogGeneration++; delete connection.snapshot; connection.controller.abort()
      await connection.transport.close()
      if (this.connections.get(id) === connection) this.connections.delete(id)
    }))
    if (outcomes.some(outcome => outcome.status === 'rejected')) {
      // Retain failed cleanup handles; never permit a replacement launch to
      // conceal an owned process whose cleanup could not be verified.
      throw new ConfigurationLoadError('MCP configuration changed or is unavailable, and owned process cleanup could not be verified')
    }
  }
  private async loadConfiguration(): Promise<McpConfiguration> {
    try { return await this.options.store.load() }
    catch {
      // An invalid external configuration revokes the old catalog and launch.
      await this.revokeConnections()
      throw new ConfigurationLoadError('MCP configuration is unavailable or invalid; all server connections are disabled')
    }
  }
  async reload(): Promise<void> {
    const current = await this.loadConfiguration()
    if (this.configuration.revision && current.revision !== this.configuration.revision) await this.revokeConnections()
    this.configuration = current
  }
  statuses(): readonly McpServerStatus[] {
    return mcpFreeze(this.configuration.servers.map(server => {
      const connection = this.connections.get(server.id)
      return { server, state: connection?.state ?? 'disabled', ...(connection?.message ? { message: connection.message } : {}),
        ...(connection?.snapshot ? { snapshot: connection.snapshot } : {}) }
    }))
  }
  async configure(server: McpServerConfig): Promise<void> {
    this.assertOpen(); await this.reload()
    if (this.configuration.servers.some(value => value.id === server.id)) throw new Error('That MCP server ID already exists; remove it before adding a replacement')
    const updated = await this.options.store.save([...this.configuration.servers, server], this.configuration.revision)
    await this.disconnectAll(); this.configuration = updated
  }
  async remove(id: string): Promise<void> {
    this.assertOpen(); await this.reload()
    const updated = await this.options.store.save(this.configuration.servers.filter(server => server.id !== id), this.configuration.revision)
    await this.disconnectAll(); this.configuration = updated
  }
  async connect(id: string, approve: (launch: McpLaunchIdentity, signal: AbortSignal) => Promise<boolean>, signal: AbortSignal): Promise<boolean> {
    this.assertOpen(); signal.throwIfAborted(); await this.reload()
    const server = this.configuration.servers.find(value => value.id === id)
    if (!server) throw new Error('MCP server is no longer configured')
    if (this.connections.has(id)) throw new Error('Disable the current MCP connection before reconnecting')
    const revision = this.configuration.revision
    const launch = await prepareMcpLaunch(server, revision, this.options.env, this.secrets)
    signal.throwIfAborted()
    if (!await approve(launch, signal)) return false
    signal.throwIfAborted(); this.assertOpen(); await this.reload()
    if (this.configuration.revision !== revision || this.connections.has(id)) throw new Error('MCP launch changed; request fresh connection approval')
    const current = await prepareMcpLaunch(server, revision, this.options.env, this.secrets)
    if (current.digest !== launch.digest) throw new Error('MCP executable, working directory or environment changed; request fresh approval')
    if ((await this.loadConfiguration()).revision !== revision) throw new Error('MCP configuration changed; request fresh approval')
    signal.throwIfAborted()
    const client = new Client({ name: 'vivi-cli-discovery', version: '0.1.0-dev.0' }, { capabilities: {},
      inputRequired: { autoFulfill: false }, enforceStrictCapabilities: true,
      versionNegotiation: { mode: server.protocol === 'legacy' ? 'legacy' : { pin: server.protocol } } })
    const transport = (this.options.transportFactory ?? (value => new McpStdioTransport(value)))(launch)
    const connection: Connection = { client, transport, controller: new AbortController(), generation: randomUUID(), catalogGeneration: 0, state: 'connecting' }
    this.connections.set(id, connection)
    const invalidate = (changed: readonly McpCatalogKind[]): void => {
      connection.catalogGeneration++
      if (connection.snapshot) connection.snapshot = mcpFreeze({ ...connection.snapshot,
        catalogGeneration: connection.catalogGeneration,
        categories: Object.fromEntries(kinds.map(kind => {
          const category = connection.snapshot!.categories[kind]
          return [kind, changed.includes(kind) && ['ready', 'stale'].includes(category.state)
            ? { ...category, state: 'stale', reason: 'Server catalog changed or connection closed; refresh metadata' } : category]
        })) as unknown as McpCatalogSnapshot['categories'] })
    }
    client.setNotificationHandler('notifications/tools/list_changed', () => invalidate(['tools']))
    client.setNotificationHandler('notifications/resources/list_changed', () => invalidate(['resources', 'resourceTemplates']))
    client.onclose = () => { connection.state = 'error'; connection.message = 'MCP connection closed; reconnect requires fresh approval'; invalidate(kinds); connection.controller.abort() }
    client.onerror = () => { /* Untrusted server details are never logged, persisted or sent to a provider. */ }
    const combined = AbortSignal.any([signal, connection.controller.signal, AbortSignal.timeout(MCP_LIMITS.categoryMs)])
    const abort = (): void => { void transport.close().catch(() => undefined) }
    combined.addEventListener('abort', abort, { once: true })
    try {
      await client.connect(transport, { signal: combined, timeout: MCP_LIMITS.pageMs, maxTotalTimeout: MCP_LIMITS.categoryMs })
      combined.throwIfAborted()
      if (this.connections.get(id) !== connection || this.configuration.revision !== revision) throw new Error('MCP connection changed during startup')
      connection.state = 'connected'
      connection.snapshot = mcpFreeze({ serverId: id, configRevision: revision, connectionGeneration: connection.generation,
        protocolVersion: client.getNegotiatedProtocolVersion() ?? 'unknown', catalogGeneration: connection.catalogGeneration,
        categories: { tools: emptyMcpCategory(), resources: emptyMcpCategory(), resourceTemplates: emptyMcpCategory() } })
      await this.refresh(id, ['tools'], signal)
      return true
    } catch {
      connection.state = 'error'; connection.message = signal.aborted ? 'MCP connection cancelled' : 'MCP connection failed or timed out; ordinary chat remains available'
      connection.controller.abort()
      await transport.close()
      return false
    } finally { combined.removeEventListener('abort', abort) }
  }
  async refresh(id: string, selected: readonly McpCatalogKind[], signal: AbortSignal): Promise<void> {
    this.assertOpen(); signal.throwIfAborted(); await this.reload()
    const connection = this.connections.get(id)
    if (!connection || connection.state !== 'connected' || !connection.snapshot) throw new Error('Connect this MCP server explicitly before discovering metadata')
    if (connection.refresh) throw new Error('MCP metadata refresh is already running')
    const task = this.collect(connection, selected, signal)
    connection.refresh = task
    try { await task } finally { delete connection.refresh }
  }
  private async collect(connection: Connection, selected: readonly McpCatalogKind[], signal: AbortSignal): Promise<void> {
    const snapshot = connection.snapshot!, generation = connection.catalogGeneration
    const categories = { ...snapshot.categories }, capabilities = connection.client.getServerCapabilities()
    for (const kind of selected) {
      if (!kinds.includes(kind)) throw new Error('Unsupported MCP catalog category')
      if (!(kind === 'tools' ? capabilities?.tools : capabilities?.resources)) { categories[kind] = emptyMcpCategory('unsupported'); continue }
      const combined = AbortSignal.any([signal, connection.controller.signal, AbortSignal.timeout(MCP_LIMITS.categoryMs)])
      try {
        const category = await collectMcpCategory(snapshot.serverId, kind, (cursor, pageSignal) => connection.client.request({ method: categoryMethods[kind],
          params: cursor === undefined ? {} : { cursor } }, { signal: pageSignal, timeout: MCP_LIMITS.pageMs, maxTotalTimeout: MCP_LIMITS.categoryMs }), combined)
        combined.throwIfAborted()
        const latest = await this.loadConfiguration()
        if (latest.revision !== snapshot.configRevision) {
          await this.revokeConnections()
          this.configuration = latest
          throw new Error('MCP configuration changed during discovery')
        }
        if (connection.catalogGeneration !== generation || this.configuration.revision !== snapshot.configRevision || connection.state !== 'connected') throw new Error('MCP catalog changed during discovery')
        categories[kind] = category
      } catch (error) {
        if (error instanceof ConfigurationLoadError) throw error
        const previous = categories[kind]
        categories[kind] = mcpFreeze({ ...previous, state: previous.entries.length ? 'stale' : 'error',
          reason: combined.aborted ? 'Metadata discovery cancelled or timed out' : 'Metadata discovery failed, changed or exceeded its bounds' })
      }
    }
    if (connection.catalogGeneration !== generation || this.configuration.revision !== snapshot.configRevision || connection.state !== 'connected') return
    const total = kinds.reduce((bytes, kind) => bytes + Buffer.byteLength(JSON.stringify(categories[kind].entries)), 0)
    if (total > MCP_LIMITS.bytes) {
      for (const kind of selected) categories[kind] = mcpFreeze({ ...snapshot.categories[kind], state: 'error', reason: 'Combined catalog byte limit exceeded' })
    }
    connection.catalogGeneration++
    connection.snapshot = mcpFreeze({ ...snapshot, catalogGeneration: connection.catalogGeneration, categories })
  }
  async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id)
    if (!connection) return
    connection.controller.abort()
    await connection.transport.close()
    await connection.refresh?.catch(() => undefined)
    this.connections.delete(id)
  }
  private async disconnectAll(): Promise<void> {
    const outcomes = await Promise.allSettled([...this.connections.keys()].map(id => this.disconnect(id)))
    const failure = outcomes.find(outcome => outcome.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  async close(): Promise<void> { this.closed = true; await this.disconnectAll() }
  private assertOpen(): void { if (this.closed) throw new Error('MCP manager is closed') }
}
