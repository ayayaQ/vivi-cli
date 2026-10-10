// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import { Client, isSpecType, CLIENT_CAPABILITIES_META_KEY, CLIENT_INFO_META_KEY, PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/client'
import type { JSONRPCMessage, JsonSchemaType, Tool, Transport } from '@modelcontextprotocol/client'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv'
import { prepareMcpOperation, mcpOperationRevisions as sharedOperationRevisions, assertMcpOperationCurrent as sharedAssertCurrent } from '@ayayaq/vivi/extensions/mcp'
import type { McpPreparedOperation } from '@ayayaq/vivi/extensions/mcp'
import { validateMcpSchema } from './mcp-schema.js'
import type { JsonObject, ToolCall, ToolResult } from '@ayayaq/vivi'
import { McpConfigStore, mcpDigest, mcpDisplayJson, mcpFreeze, prepareMcpLaunch } from './mcp-config.js'
import type { McpConfiguration, McpLaunchIdentity, McpServerConfig } from './mcp-config.js'
import { assertMcpJson, collectMcpCategory, emptyMcpCategory, MCP_LIMITS } from './mcp-catalog.js'
import type { McpCatalogEntry, McpCatalogKind, McpCatalogSnapshot } from './mcp-catalog.js'
import { McpStdioTransport } from './mcp-transport.js'
import { assertMcpOperationResult, MCP_OPERATION_LIMITS, mcpContainsSecret, mcpFailure, projectMcpResult } from './mcp-content.js'

export type { McpPreparedOperation } from '@ayayaq/vivi/extensions/mcp'
/** Trusted host persistence hooks; never provided by server metadata or a model extension. */
export interface McpInvocationLifecycle {
  beforeSend(): Promise<void>
  settle(result: ToolResult): Promise<void>
}
interface PendingOperation {
  readonly operation: McpPreparedOperation
  readonly signal: AbortSignal
  readonly assertCurrent: () => void
  readonly lifecycle?: McpInvocationLifecycle
  boundaryStarted: boolean
  boundaryWork?: Promise<void>
  boundaryFinished: boolean
  sent: boolean
  requestId?: string | number
  responseObserved: boolean
  confirmed?: ToolResult
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
  readonly closeOwned: () => Promise<void>
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
      await connection.closeOwned()
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
    const closeOwned = async (): Promise<void> => { await owned.close() }
    // The pinned SDK starts detached cleanup after a failed legacy handshake.
    // Observe that rejection here; host ownership paths still await strict cleanup.
    const transport: Transport = { start: () => owned.start(), close: () => closeOwned().catch(() => undefined), send: (message, options) => {
      if (!('method' in message) || !['tools/call', 'resources/read'].includes(message.method)) return owned.send(message, options)
      const pending = connection.pending
      if (!pending || pending.boundaryStarted || !('id' in message)) return Promise.reject(new Error('MCP operation has no one-shot approval'))
      pending.boundaryStarted = true
      // Protocol.request may reject on abort before its detached send continuation settles.
      // Own that continuation so the host cannot release its lease while it can still write.
      const task = (async (): Promise<void> => {
        await this.reload()
        this.assertSendCurrent(connection, pending, message)
        await pending.lifecycle?.beforeSend()
        // Persisting the intent is asynchronous; repeat every authority/privacy check after it.
        await this.reload()
        this.assertSendCurrent(connection, pending, message)
        pending.sent = true; pending.requestId = message.id
        await owned.send(message, options)
      })()
      pending.boundaryWork = task.finally(() => { pending.boundaryFinished = true })
      // The SDK attaches its own rejection handler; retain ours without an unhandled rejection.
      void pending.boundaryWork.catch(() => undefined)
      return pending.boundaryWork
    } }
    const connection: Connection = { client, transport, closeOwned, launch, controller: new AbortController(), generation: randomUUID(), catalogGeneration: 0, state: 'connecting' }
    owned.onclose = () => transport.onclose?.()
    owned.onerror = error => transport.onerror?.(error)
    owned.onmessage = (message: JSONRPCMessage) => {
      const pending = connection.pending
      if (pending?.sent && 'id' in message && message.id === pending.requestId && !('method' in message) &&
        ('result' in message || 'error' in message)) {
        // The first response is authoritative evidence. A duplicate cannot overwrite it
        // or turn a malformed first response into a later apparent success.
        if (pending.responseObserved) return
        pending.responseObserved = true
        try { pending.confirmed = this.confirmResponse(pending.operation, message) }
        catch {
          transport.onmessage?.({ jsonrpc: '2.0', id: message.id,
            error: { code: -32603, message: 'MCP result envelope is unavailable or exceeded its bounds' } }); return
        }
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
    const abort = (): void => { void closeOwned().catch(() => undefined) }
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
      await closeOwned()
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
    if (remoteKey !== entry.remoteKey) throw new Error('MCP resource selection differs from the captured URI')
    const connection = this.connections.get(snapshot.serverId)
    const operation = prepareMcpOperation(snapshot, entry, catalogKind, call, connection?.launch.digest ?? '', validateMcpSchema)
    this.assertOperationCurrent(operation); this.assertOperationPrivacy(operation)
    return operation
  }
  operationRevisions(operation: McpPreparedOperation): JsonObject {
    const connection = this.connections.get(operation.serverId)
    return sharedOperationRevisions(operation, connection?.snapshot, connection?.launch.digest ?? '',
      connection?.state === 'connected' && !connection.controller.signal.aborted && !this.closed, this.configuration.revision)
  }
  private assertOperationCurrent(operation: McpPreparedOperation): void {
    this.assertOpen()
    const connection = this.connections.get(operation.serverId)
    sharedAssertCurrent(operation, connection?.snapshot, connection?.launch.digest ?? '',
      connection?.state === 'connected' && !connection.controller.signal.aborted && !this.closed, this.configuration.revision)
  }
  private assertSendCurrent(connection: Connection, pending: PendingOperation, message: JSONRPCMessage): void {
    if (connection.pending !== pending || pending.sent || !('method' in message)) throw new Error('MCP operation approval changed before send')
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
  }
  private confirmResponse(operation: McpPreparedOperation, message: JSONRPCMessage): ToolResult {
    if ('result' in message && 'error' in message) throw new Error('Ambiguous MCP response')
    if ('error' in message) {
      assertMcpJson(message, MCP_OPERATION_LIMITS.resultBytes)
      if (!isSpecType.JSONRPCErrorResponse(message)) throw new Error('Invalid MCP protocol error')
      return this.withOutcome(mcpFailure('mcp_protocol_error', 'The server confirmed a protocol error; no automatic retry is permitted'), true, true)
    }
    if (!('result' in message)) throw new Error('Missing MCP result')
    if (!isSpecType.JSONRPCResultResponse(message)) throw new Error('Invalid MCP response envelope')
    const result = message.result
    const method = operation.catalogKind === 'tools' ? 'tools/call' : 'resources/read'
    assertMcpOperationResult(method, result)
    if (!(operation.catalogKind === 'tools' ? isSpecType.CallToolResult(result) : isSpecType.ReadResourceResult(result))) throw new Error('Invalid MCP result schema')
    const body = result as Record<string, unknown>
    if (operation.snapshot.protocolVersion === '2026-07-28') {
      if (body.resultType !== 'complete') throw new Error('Unsupported MCP result type')
      if (operation.catalogKind === 'resources' && (!Number.isSafeInteger(body.ttlMs) || (body.ttlMs as number) < 0 ||
        !['private', 'public'].includes(body.cacheScope as string))) throw new Error('Invalid MCP resource cache metadata')
    } else {
      if (body.structuredContent !== undefined && (!body.structuredContent || typeof body.structuredContent !== 'object' || Array.isArray(body.structuredContent))) throw new Error('Invalid legacy structured content')
      if (body._meta !== undefined && !isSpecType.RequestMeta(body._meta)) throw new Error('Invalid legacy result metadata')
    }
    if (operation.catalogKind === 'tools' && operation.descriptor.outputSchema && body.isError !== true) {
      if (body.structuredContent === undefined) throw new Error('Missing structured output')
      const validate = new AjvJsonSchemaValidator().getValidator(operation.descriptor.outputSchema as JsonSchemaType)
      if (!validate(body.structuredContent).valid) throw new Error('Structured output does not match the captured schema')
    }
    // Privacy and URI checks are host-owned and run even when SDK abort wins the race.
    if (mcpContainsSecret(result, this.secrets)) throw new Error('MCP result contains a known credential')
    if (operation.catalogKind === 'resources' && (body.contents as Record<string, unknown>[]).some(item => item.uri !== operation.remoteKey)) throw new Error('MCP resource URI differs from approval')
    let projection: ToolResult
    try { projection = projectMcpResult(operation.serverId, method, operation.remoteKey, result, this.secrets) }
    catch {
      // The raw SDK result is fully validated above. Projection envelope overhead
      // may exceed its separate budget; withhold content while retaining status.
      projection = { content: JSON.stringify({ success: body.isError !== true, source: 'mcp', untrusted: true, contentWithheld: true }),
        ...(body.isError === true ? { isError: true } : {}) }
    }
    return this.withOutcome(projection, true, true)
  }
  private withOutcome(result: ToolResult, requestSent: boolean, confirmedOutcome = false): ToolResult {
    const body = JSON.parse(result.content) as Record<string, unknown>
    const projection = { ...body, requestSent, ...(requestSent ? { doNotRetry: true } : {}), ...(confirmedOutcome ? { confirmedOutcome: true } : {}) }
    try { assertMcpJson(projection, MCP_OPERATION_LIMITS.resultBytes) }
    catch {
      // Adding outcome evidence can exceed the otherwise valid projection budget.
      // Preserve the confirmed status without clipping JSON or changing success into failure.
      const withheld = { success: body.success === true, source: 'mcp', untrusted: true, requestSent,
        ...(requestSent ? { doNotRetry: true } : {}), ...(confirmedOutcome ? { confirmedOutcome: true } : {}), contentWithheld: true }
      return { content: JSON.stringify(withheld), ...(result.isError ? { isError: true } : {}) }
    }
    return { ...result, content: JSON.stringify(projection) }
  }
  private assertOperationPrivacy(operation: McpPreparedOperation): void {
    if (mcpContainsSecret([operation.call, operation.descriptor, operation.binding, operation.snapshot], this.secrets)) throw new Error('MCP request contains a known credential')
  }
  /** One exact approved request, never an SDK retry or cache-served resource body. */
  async invoke(operation: McpPreparedOperation, signal: AbortSignal, assertCurrent: () => void,
    lifecycle?: McpInvocationLifecycle): Promise<ToolResult> {
    let pending: PendingOperation | undefined, connection: Connection | undefined
    const invocation = new AbortController()
    let result: ToolResult
    try {
      signal.throwIfAborted(); await this.reload(); signal.throwIfAborted(); assertCurrent()
      this.assertOperationCurrent(operation); this.assertOperationPrivacy(operation)
      connection = this.connections.get(operation.serverId)!
      if (connection.pending) throw new Error('MCP server already has an operation in flight')
      const combined = AbortSignal.any([signal, invocation.signal, connection.controller.signal, AbortSignal.timeout(MCP_OPERATION_LIMITS.operationMs)])
      pending = { operation, signal: combined, assertCurrent, ...(lifecycle ? { lifecycle } : {}), sent: false, boundaryStarted: false, boundaryFinished: false, responseObserved: false }
      connection.pending = pending
      const options = { signal: combined, timeout: MCP_OPERATION_LIMITS.operationMs, maxTotalTimeout: MCP_OPERATION_LIMITS.operationMs }
      if (operation.catalogKind === 'tools') await connection.client.callTool({ name: operation.remoteKey, arguments: operation.call.arguments },
        { ...options, toolDefinition: operation.descriptor as unknown as Tool })
      else await connection.client.readResource({ uri: operation.remoteKey }, { ...options, cacheMode: 'bypass' })
      // A response may arrive while an underlying write is backpressured. Keep the
      // write owned, but let cancellation/deadline close it rather than deadlock.
      await this.drainBoundary(pending, combined)
      if (!pending.confirmed) throw new Error('MCP result could not be confirmed')
      result = pending.confirmed
    } catch {
      // Stop detached SDK setup before draining it: it must never send after return.
      invocation.abort()
      if (pending && connection && (pending.sent && !pending.confirmed || pending.boundaryStarted && !pending.boundaryFinished)) {
        connection.state = 'error'; connection.message = 'MCP operation interrupted; disable before reconnecting with fresh approval'
        connection.catalogGeneration++; delete connection.snapshot; connection.controller.abort()
        try { await connection.closeOwned() } catch { connection.message += '; owned process cleanup remains unverified' }
      }
      await pending?.boundaryWork?.catch(() => undefined)
      if (pending?.confirmed) result = pending.confirmed
      else if (pending?.sent) result = this.withOutcome(mcpFailure('mcp_unknown_outcome',
        'The MCP operation was attempted, but its outcome could not be confirmed. Do not retry automatically; check the external resource before reconnecting', true), true)
      else result = this.withOutcome(mcpFailure(signal.aborted ? 'cancelled' : 'mcp_unavailable',
        'MCP request was not sent: approval, catalog, configuration, connection or arguments became unavailable'), false)
    } finally {
      invocation.abort()
      if (connection && connection.pending === pending) delete connection.pending
    }
    // Newly known credentials can be registered by result/review callbacks. Keep
    // exact outcome evidence while withholding now-sensitive content.
    if (mcpContainsSecret(result, this.secrets)) {
      const evidence = JSON.parse(result.content) as Record<string, unknown>
      result = { content: JSON.stringify({ success: evidence.success === true, source: 'mcp', untrusted: true,
        requestSent: evidence.requestSent === true, ...(evidence.confirmedOutcome ? { confirmedOutcome: true } : {}),
        ...(evidence.unknownOutcome ? { unknownOutcome: true } : {}), ...(evidence.doNotRetry ? { doNotRetry: true } : {}), contentWithheld: true }),
        ...(result.isError ? { isError: true } : {}) }
    }
    // A persistence acknowledgement failure cannot erase already observed outcome
    // evidence. The host separately retains its prior intent and checkpoint result.
    try { await lifecycle?.settle(result) } catch { /* Return the trusted in-memory outcome. */ }
    return result
  }
  private async drainBoundary(pending: PendingOperation, signal: AbortSignal): Promise<void> {
    if (!pending.boundaryWork) return
    signal.throwIfAborted()
    let abort: (() => void) | undefined
    try {
      await Promise.race([pending.boundaryWork, new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true })
      })])
    } finally { if (abort) signal.removeEventListener('abort', abort) }
  }
  async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id)
    if (!connection) return
    connection.controller.abort()
    await connection.closeOwned()
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
