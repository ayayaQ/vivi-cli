// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import { Client, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/client'
import type { JSONRPCMessage, JsonSchemaType, Tool, Transport } from '@modelcontextprotocol/client'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv'
import type { JsonObject, ToolCall, ToolResult } from '@ayayaq/vivi'
import { McpConfigStore, mcpDigest, mcpDisplayJson, mcpFreeze, prepareMcpLaunch } from './mcp-config.js'
import type { McpConfiguration, McpLaunchIdentity, McpServerConfig } from './mcp-config.js'
import { assertMcpJson, collectMcpCategory, emptyMcpCategory, MCP_LIMITS } from './mcp-catalog.js'
import type { McpCatalogEntry, McpCatalogKind, McpCatalogSnapshot } from './mcp-catalog.js'
import { McpStdioTransport } from './mcp-transport.js'
import { assertMcpOperationResult, MCP_OPERATION_LIMITS, mcpContainsSecret, mcpFailure, projectMcpResult } from './mcp-content.js'

export interface McpPreparedOperation {
  readonly call: ToolCall
  readonly serverId: string
  readonly catalogKind: 'tools' | 'resources'
  readonly remoteKey: string
  readonly descriptor: Readonly<Record<string, unknown>>
  readonly snapshot: McpCatalogSnapshot
  readonly binding: JsonObject
}
interface PendingOperation {
  readonly operation: McpPreparedOperation
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
  sent: boolean
  requestId?: string | number
}

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
  readonly launch: McpLaunchIdentity
  catalogGeneration: number
  snapshot?: McpCatalogSnapshot
  state: 'connecting' | 'connected' | 'error'
  message?: string
  refresh?: Promise<void>
  pending?: PendingOperation
}
const categoryMethods = { tools: 'tools/list', resources: 'resources/list', resourceTemplates: 'resources/templates/list' } as const
const kinds: readonly McpCatalogKind[] = ['tools', 'resources', 'resourceTemplates']
class ConfigurationLoadError extends Error {}
export const MCP_START_WARNING = 'Starting this trusted server runs its installed code with your OS permissions, before any tool-call approval. It can access your files and network. This is not a sandbox. Ready tool metadata is advertised to the selected model; discovered resource metadata can also be listed in its context. Every tool call and resource read requires separate human approval; returned text enters the local transcript and selected provider context.'
export function mcpStartDisclosure(launch: McpLaunchIdentity): string {
  const disclosure = `${MCP_START_WARNING}\nServer: ${launch.server.id} · ${mcpDisplayJson(launch.server.label)}\nExecutable: ${mcpDisplayJson(launch.server.executable)}\nArguments: ${launch.server.args.map(mcpDisplayJson).join(' ') || '(none)'}\nWorking directory: ${mcpDisplayJson(launch.server.cwd)}\nProtocol: ${launch.server.protocol}\nEnvironment: ${Object.entries(launch.environment).map(([name, value]) => `${name}=${mcpDisplayJson(value)}`).join(', ') || '(empty)'}\nThis connection is for this launch only; a new launch or configuration change requires fresh approval.`
  if (disclosure.length > 48 * 1024) throw new Error('MCP approval display exceeds its limit; use a smaller configuration')
  return disclosure
}
export function mcpOperationDisclosure(operation: McpPreparedOperation): string {
  const description = `${operation.catalogKind === 'tools' ? 'Call MCP tool' : 'Read MCP resource'} on trusted server ${mcpDisplayJson(operation.serverId)}.\n` +
    'This sends the exact request below to that server. Tool effects cannot be verified from metadata; read-only and other annotations are not authority. Resource fetches are server operations, including file URIs, not scoped workspace reads.\n' +
    'Bounded returned text/structured data is untrusted and will enter this local transcript and the selected provider context. No binary data or linked resources are fetched. Approval is for one attempt; cancellation cannot undo effects and uncertain outcomes are never retried automatically.\n' +
    `Exact ${operation.catalogKind === 'tools' ? 'tool name' : 'resource URI'}: ${mcpDisplayJson(operation.remoteKey)}\n` +
    `Arguments: ${mcpDisplayJson(operation.call.arguments)}\nCatalog descriptor (untrusted): ${mcpDisplayJson(operation.descriptor)}\nBinding: ${mcpDisplayJson(operation.binding)}`
  if (Buffer.byteLength(description) > 96 * 1024) throw new Error('MCP approval display exceeds its limit')
  return description
}
/** Explicit connection ownership and one-shot approved invocation; no automatic reconnect or input fulfilment. */
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
    signal.throwIfAborted(); this.assertOpen()
    if (this.configuration.revision !== revision || this.connections.has(id)) throw new Error('MCP launch changed; request fresh connection approval')
    const client = new Client({ name: 'vivi-cli-discovery', version: '0.1.0-dev.0' }, { capabilities: {},
      jsonSchemaValidator: { getValidator: <T>(schema: JsonSchemaType) => new AjvJsonSchemaValidator().getValidator<T>(schema) },
      inputRequired: { autoFulfill: false }, enforceStrictCapabilities: true,
      versionNegotiation: { mode: server.protocol === 'legacy' ? 'legacy' : { pin: server.protocol } } })
    const owned = (this.options.transportFactory ?? (value => new McpStdioTransport(value)))(launch)
    // Keep the guard at the actual transport boundary, including SDK async setup.
    // The SDK may attach only its fixed modern protocol envelope to our params.
    const transport: Transport = { start: () => owned.start(), close: () => owned.close(), send: async (message, options) => {
      if ('method' in message && ['tools/call', 'resources/read'].includes(message.method)) {
        const pending = connection.pending
        if (!pending || pending.sent || !('id' in message)) throw new Error('MCP operation has no one-shot approval')
        // SDK call setup is asynchronous. Re-read persisted configuration here,
        // after that setup, rather than trusting the earlier cached revision.
        await this.reload()
        if (connection.pending !== pending) throw new Error('MCP operation approval changed before send')
        pending.signal.throwIfAborted(); pending.assertCurrent(); this.assertOperationCurrent(pending.operation)
        const operation = pending.operation
        const expected: Record<string, unknown> = operation.catalogKind === 'tools'
          ? { name: operation.remoteKey, arguments: operation.call.arguments } : { uri: operation.remoteKey }
        if (operation.snapshot.protocolVersion === '2026-07-28') expected._meta = {
          [PROTOCOL_VERSION_META_KEY]: operation.snapshot.protocolVersion,
          [CLIENT_INFO_META_KEY]: { name: 'vivi-cli-discovery', version: '0.1.0-dev.0' }, [CLIENT_CAPABILITIES_META_KEY]: {} }
        if (message.method !== (operation.catalogKind === 'tools' ? 'tools/call' : 'resources/read') ||
          mcpDigest(message.params) !== mcpDigest(expected)) throw new Error('MCP outgoing request differs from approval')
        this.assertOperationPrivacy(operation)
        pending.sent = true; pending.requestId = message.id
      }
      await owned.send(message, options)
    } }
    const connection: Connection = { client, transport, launch, controller: new AbortController(), generation: randomUUID(), catalogGeneration: 0, state: 'connecting' }
    owned.onclose = () => transport.onclose?.()
    owned.onerror = error => transport.onerror?.(error)
    owned.onmessage = (message: JSONRPCMessage) => {
      const pending = connection.pending
      if (pending?.sent && 'id' in message && message.id === pending.requestId && 'result' in message) {
        try { assertMcpOperationResult(pending.operation.catalogKind === 'tools' ? 'tools/call' : 'resources/read', message.result) }
        catch { transport.onmessage?.({ jsonrpc: '2.0', id: message.id,
          error: { code: -32603, message: 'MCP result envelope is unavailable or exceeded its bounds' } }); return }
      }
      transport.onmessage?.(message)
    }
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
  /** Local immutable metadata only. This never connects or fetches a catalog. */
  async captureCatalogs(signal: AbortSignal): Promise<readonly McpCatalogSnapshot[]> {
    this.assertOpen(); signal.throwIfAborted(); await this.reload(); signal.throwIfAborted(); this.assertOpen()
    return mcpFreeze([...this.connections.values()].filter(connection => connection.state === 'connected' && connection.snapshot)
      .map(connection => connection.snapshot!))
  }
  prepareOperation(snapshot: McpCatalogSnapshot, entry: McpCatalogEntry, catalogKind: 'tools' | 'resources',
    call: ToolCall, remoteKey = entry.remoteKey): McpPreparedOperation {
    assertMcpJson(call, MCP_OPERATION_LIMITS.argumentBytes + 1024)
    if (catalogKind !== 'tools' && catalogKind !== 'resources' || remoteKey !== entry.remoteKey ||
      entry.state !== 'available' || snapshot.categories[catalogKind].state !== 'ready' ||
      !snapshot.categories[catalogKind].entries.some(value => value === entry)) throw new Error('MCP catalog entry is unavailable')
    const connection = this.connections.get(snapshot.serverId)
    const captured = { call: structuredClone(call), serverId: snapshot.serverId, catalogKind, remoteKey,
      descriptor: entry.descriptor, snapshot }
    const binding: JsonObject = { serverId: snapshot.serverId, configRevision: snapshot.configRevision,
      connectionGeneration: snapshot.connectionGeneration, protocolVersion: snapshot.protocolVersion,
      catalogGeneration: snapshot.catalogGeneration, categoryDigest: snapshot.categories[catalogKind].digest,
      descriptorDigest: mcpDigest(entry.descriptor), launchDigest: connection?.launch.digest ?? '',
      operationDigest: mcpDigest(captured) }
    const operation = mcpFreeze({ ...captured, binding })
    this.assertOperationCurrent(operation); this.assertOperationPrivacy(operation)
    if (catalogKind === 'tools') {
      const validate = new AjvJsonSchemaValidator().getValidator(entry.descriptor.inputSchema as JsonSchemaType)
      if (!validate(operation.call.arguments).valid) throw new Error('MCP arguments do not match the captured input schema')
    } else if (Object.keys(call.arguments).sort().join(',') !== 'serverId,uri' ||
      call.arguments.serverId !== snapshot.serverId || call.arguments.uri !== entry.remoteKey) throw new Error('MCP resource selection differs from the captured URI')
    return operation
  }
  operationRevisions(operation: McpPreparedOperation): JsonObject {
    const connection = this.connections.get(operation.serverId), snapshot = connection?.snapshot
    const category = snapshot?.categories[operation.catalogKind]
    const entry = category?.entries.find(value => value.remoteKey === operation.remoteKey)
    return { serverId: operation.serverId, configRevision: this.configuration.revision,
      connectionGeneration: connection?.generation ?? '', protocolVersion: snapshot?.protocolVersion ?? '',
      catalogGeneration: snapshot?.catalogGeneration ?? -1, categoryDigest: category?.digest ?? '',
      descriptorDigest: mcpDigest(entry?.descriptor ?? null), launchDigest: connection?.launch.digest ?? '',
      operationDigest: mcpDigest({ call: operation.call, serverId: operation.serverId, catalogKind: operation.catalogKind,
        remoteKey: operation.remoteKey, descriptor: operation.descriptor, snapshot: operation.snapshot }),
      connected: connection?.state === 'connected' && !connection.controller.signal.aborted && !this.closed,
      categoryReady: category?.state === 'ready', bindingDigest: mcpDigest(operation.binding) }
  }
  private assertOperationCurrent(operation: McpPreparedOperation): void {
    this.assertOpen()
    const current = this.operationRevisions(operation)
    if (!current.connected || !current.categoryReady || Object.entries(operation.binding).some(([key, value]) => current[key] !== value)) {
      throw new Error('MCP operation became stale; request fresh approval after metadata refresh')
    }
  }
  private assertOperationPrivacy(operation: McpPreparedOperation): void {
    if (mcpContainsSecret([operation.call, operation.descriptor], this.secrets)) throw new Error('MCP request contains a known credential')
  }
  /** One exact approved request, never an SDK retry or cache-served resource body. */
  async invoke(operation: McpPreparedOperation, signal: AbortSignal, assertCurrent: () => void): Promise<ToolResult> {
    let pending: PendingOperation | undefined, connection: Connection | undefined
    try {
      signal.throwIfAborted(); await this.reload(); signal.throwIfAborted(); assertCurrent()
      this.assertOperationCurrent(operation); this.assertOperationPrivacy(operation)
      connection = this.connections.get(operation.serverId)!
      if (connection.pending) throw new Error('MCP server already has an operation in flight')
      const combined = AbortSignal.any([signal, connection.controller.signal, AbortSignal.timeout(MCP_OPERATION_LIMITS.operationMs)])
      pending = { operation, signal: combined, assertCurrent, sent: false }; connection.pending = pending
      const options = { signal: combined, timeout: MCP_OPERATION_LIMITS.operationMs, maxTotalTimeout: MCP_OPERATION_LIMITS.operationMs }
      const result = operation.catalogKind === 'tools'
        ? await connection.client.callTool({ name: operation.remoteKey, arguments: operation.call.arguments },
          { ...options, toolDefinition: operation.descriptor as unknown as Tool })
        : await connection.client.readResource({ uri: operation.remoteKey }, { ...options, cacheMode: 'bypass' })
      combined.throwIfAborted(); assertCurrent(); this.assertOperationCurrent(operation)
      // Check persisted configuration after a request as well; output from a revoked connection is withheld.
      await this.reload(); combined.throwIfAborted(); assertCurrent(); this.assertOperationCurrent(operation)
      return projectMcpResult(operation.serverId, operation.catalogKind === 'tools' ? 'tools/call' : 'resources/read', operation.remoteKey, result, this.secrets)
    } catch {
      if (pending?.sent && connection) {
        connection.state = 'error'; connection.message = 'MCP operation outcome is unconfirmed; do not retry automatically. Disable before reconnecting with fresh approval'
        connection.catalogGeneration++; delete connection.snapshot; connection.controller.abort()
        try { await connection.transport.close() } catch { connection.message += '; owned process cleanup remains unverified' }
        return mcpFailure('mcp_unknown_outcome', 'The MCP operation was sent, but its outcome could not be confirmed. Do not retry automatically; check the external resource before reconnecting', true)
      }
      return mcpFailure(signal.aborted ? 'cancelled' : 'mcp_unavailable', 'MCP request was not sent: approval, catalog, configuration, connection or arguments became unavailable')
    } finally { if (connection && connection.pending === pending) delete connection.pending }
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
