// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createMcpWrappingKeyStore } from './credentials.js'
import type { CredentialStoreStatus, McpWrappingKeyStore } from './credentials.js'
import { mcpFreeze, mcpRecord } from './mcp-config.js'
import { mcpOAuthRemoteUrl } from './mcp-oauth-network.js'
import { validateMcpOAuthRedirectPath } from './mcp-oauth-callback.js'

export interface McpOAuthSavedClient {
  readonly id: string
  readonly issuer: string
  readonly redirectPort: number
  readonly redirectPath: string
  readonly scopes: readonly string[]
  readonly resource?: string
}
/** Privileged-only credentials. Never expose to UI, models, config, transcripts or logs. */
export interface McpOAuthSavedTokens {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt?: number
  readonly issuer: string
  readonly resource: string
  readonly clientId: string
  readonly scopes: readonly string[]
}
export interface McpOAuthSavedRecord {
  readonly serverId: string
  readonly endpoint: string
  readonly client: McpOAuthSavedClient
  readonly revision: string
  readonly tokens?: McpOAuthSavedTokens
}
interface StoredRecord extends McpOAuthSavedRecord { readonly refreshPending?: boolean }
interface LeaseGuard {
  (): boolean
  protect<T>(action: () => Promise<T>): Promise<T>
}
export class McpOAuthStoreError extends Error {
  constructor(readonly code: 'unavailable' | 'busy' | 'changed' | 'needs-sign-in') {
    super({ unavailable: 'Secure MCP saved sign-in storage is unavailable. Choose session-only sign-in or unlock OS credential storage',
      busy: 'Another vivi process is updating saved MCP sign-in. Close it or wait for it to finish, then retry',
      changed: 'MCP saved sign-in changed. Reload it before continuing',
      'needs-sign-in': 'MCP saved sign-in needs a fresh browser sign-in' }[code])
    this.name = 'McpOAuthStoreError'
  }
}
const MAX_BYTES = 64 * 1024
const KEYS = ['serverId', 'endpoint', 'client', 'revision', 'tokens', 'refreshPending']
const refreshToken = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^[\x20-\x7e]+$/.test(value)
const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 8192 && /^[A-Za-z0-9._~+/-]+=*$/.test(value)
function identity(serverId: string, endpoint: string): string {
  if (!/^[a-z][a-z0-9_-]{0,15}$/.test(serverId)) throw new McpOAuthStoreError('unavailable')
  return mcpOAuthRemoteUrl(endpoint).href
}
function scopes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 32 && value.every(scope => typeof scope === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(scope)) && new Set(value).size === value.length
}
export function validateMcpOAuthSavedClient(value: unknown, endpoint: string): McpOAuthSavedClient {
  if (!mcpRecord(value) || !Object.keys(value).every(key => ['id', 'issuer', 'redirectPort', 'redirectPath', 'scopes', 'resource'].includes(key)) ||
    typeof value.id !== 'string' || !value.id || value.id.length > 1024 || /[\u0000-\u0020\u007f-\u009f]/.test(value.id) ||
    typeof value.issuer !== 'string' || typeof value.redirectPath !== 'string' || !Number.isInteger(value.redirectPort) ||
    (value.redirectPort as number) < 1 || (value.redirectPort as number) > 65535 || !scopes(value.scopes)) throw new McpOAuthStoreError('unavailable')
  mcpOAuthRemoteUrl(value.issuer); validateMcpOAuthRedirectPath(value.redirectPath)
  const resource = value.resource === undefined ? endpoint : value.resource
  if (typeof resource !== 'string' || ![mcpOAuthRemoteUrl(endpoint).href, mcpOAuthRemoteUrl(endpoint).origin + '/'].includes(mcpOAuthRemoteUrl(resource).href))
    throw new McpOAuthStoreError('unavailable')
  return mcpFreeze({ id: value.id, issuer: value.issuer, redirectPort: value.redirectPort as number, redirectPath: value.redirectPath,
    scopes: [...value.scopes], ...(value.resource === undefined ? {} : { resource }) })
}
export function validateMcpOAuthSavedTokens(value: unknown, client: Pick<McpOAuthSavedClient, 'id' | 'issuer' | 'scopes'>, resource: string): McpOAuthSavedTokens {
  if (!mcpRecord(value) || !Object.keys(value).every(key => ['accessToken', 'refreshToken', 'expiresAt', 'issuer', 'resource', 'clientId', 'scopes'].includes(key)) ||
    !token(value.accessToken) || value.refreshToken !== undefined && !refreshToken(value.refreshToken) || value.issuer !== client.issuer ||
    value.resource !== resource || value.clientId !== client.id || !scopes(value.scopes) || value.scopes.some(scope => !client.scopes.includes(scope)) ||
    value.expiresAt !== undefined && (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0))
    throw new McpOAuthStoreError('unavailable')
  return mcpFreeze({ accessToken: value.accessToken, ...(value.refreshToken === undefined ? {} : { refreshToken: value.refreshToken as string }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt as number }), issuer: value.issuer as string, resource,
    clientId: value.clientId as string, scopes: [...value.scopes] })
}
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
function privateEntry(info: Awaited<ReturnType<typeof lstat>>): boolean { return process.platform === 'win32' || info.uid === process.getuid?.() && (Number(info.mode) & 0o077) === 0 }
function base64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || value.length > MAX_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new McpOAuthStoreError('unavailable')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || length !== undefined && bytes.length !== length) throw new McpOAuthStoreError('unavailable')
  return bytes
}
/** Trusted, operation-scoped evidence only. Contains no saved client or token data. */
export interface McpOAuthStoreEffectReceipt {
  readonly kind: 'saved-client-replaced' | 'saved-credentials-replaced' | 'refresh-intent-replaced' | 'saved-sign-in-forgotten'
  readonly serverId: string
  readonly recordRevision?: string
  readonly durabilityUnverified: true
}
export interface McpOAuthStoreLifecycle {
  assertCurrent(): void
  effect(receipt: McpOAuthStoreEffectReceipt): void
}
export interface McpOAuthStoreOptions {
  /** Fixture/host seam. Production uses the existing OS helper; never plaintext fallback. */
  readonly keyStore?: (scope: string) => McpWrappingKeyStore
  readonly registerSecrets?: (values: readonly string[]) => void
  readonly transactionTimeoutMs?: number
}
/** MCP-only encrypted records. One private directory lock also serializes refresh rotation. */
export class McpOAuthStore {
  readonly directory: string
  private readonly transactions = new Set<Promise<unknown>>()
  constructor(directory: string, private readonly options: McpOAuthStoreOptions = {}) {
    this.directory = resolve(directory)
    if (options.transactionTimeoutMs !== undefined && (!Number.isInteger(options.transactionTimeoutMs) || options.transactionTimeoutMs < 1 || options.transactionTimeoutMs > 120_000)) throw new McpOAuthStoreError('unavailable')
  }
  private async directoryInfo(create = false): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const info = await lstat(this.directory)
      if (!info.isDirectory() || info.isSymbolicLink() || !privateEntry(info)) throw new McpOAuthStoreError('unavailable')
      return info
    } catch (error) { if (missing(error)) return undefined; throw new McpOAuthStoreError('unavailable') }
  }
  private async keyStore(): Promise<McpWrappingKeyStore> {
    const canonical = await realpath(this.directory)
    const scope = createHash('sha256').update(canonical).digest('hex')
    return this.options.keyStore?.(scope) ?? createMcpWrappingKeyStore(scope)
  }
  async status(): Promise<CredentialStoreStatus> {
    try {
      const present = await this.directoryInfo()
      const store = present ? await this.keyStore() : this.options.keyStore?.(createHash('sha256').update(this.directory).digest('hex'))
        ?? createMcpWrappingKeyStore(createHash('sha256').update(this.directory).digest('hex'))
      const result = await store.status()
      return { available: result.available, label: result.label, ...(result.available ? {} : { detail: 'Secure saved sign-in is unavailable or locked. Session-only sign-in requires an explicit choice' }) }
    } catch { return { available: false, label: 'OS-protected MCP saved sign-in', detail: 'Secure saved sign-in storage is unavailable' } }
  }
  private path(serverId: string): string { return join(this.directory, `mcp-oauth-${serverId}.json`) }
  private async leaseDatabase(): Promise<{ exec(sql: string): unknown; close(): void }> {
    const path = join(this.directory, 'mcp-oauth-lease.sqlite')
    let created
    try { created = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw new McpOAuthStoreError('unavailable') }
    await created?.close()
    for (const candidate of [path, path + '-journal']) {
      let info
      try { info = await lstat(candidate) } catch (error) { if (missing(error)) continue; throw error }
      if (!info.isFile() || info.isSymbolicLink() || !privateEntry(info) || info.nlink !== 1 || info.size > MAX_BYTES) throw new McpOAuthStoreError('unavailable')
    }
    if ('Bun' in globalThis) {
      // Bun 1.3 includes its native SQLite driver even before node:sqlite compatibility.
      // Only this minimal built-in driver surface is used; no extension or native dependency.
      const specifier = 'bun:sqlite'
      const module = await import(specifier) as { Database: new (path: string, options: { create: boolean }) => { exec(sql: string): unknown; close(): void } }
      return new module.Database(path, { create: true })
    }
    const { DatabaseSync } = await import('node:sqlite')
    return new DatabaseSync(path, { allowExtension: false, timeout: 0 })
  }
  /** Await this process's in-flight persistence before sign-out forgets its saved record. */
  async settle(): Promise<void> { await Promise.allSettled([...this.transactions]) }
  private lock<T>(action: (isCurrent: LeaseGuard) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const pending = this.transaction(action, signal)
    this.transactions.add(pending)
    void pending.then(() => this.transactions.delete(pending), () => this.transactions.delete(pending))
    return pending
  }
  private async transaction<T>(action: (isCurrent: LeaseGuard) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new McpOAuthStoreError('changed')
    const parent = await this.directoryInfo(true)
    const mutations = new Set<Promise<unknown>>()
    let live = true, timer: ReturnType<typeof setTimeout> | undefined
    let cancel: (() => void) | undefined
    let database: { exec(sql: string): unknown; close(): void } | undefined, acquired = false
    try {
      database = await this.leaseDatabase()
      // SQLite's native file lock is released by the OS on crash, including on Windows.
      // An exclusive transaction spans the bounded async helper/refresh work. No token data
      // enters SQLite. DELETE journals bound auxiliary files; timeout 0 never blocks the UI.
      database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
      acquired = true
      // The OS-released lease proves no cooperating writer is alive. Only encrypted
      // app-owned temporary records can remain from a crashed atomic save.
      const names = await readdir(this.directory)
      for (const name of names.filter(name => /^\.mcp-oauth\.[0-9a-f-]{36}\.tmp$/.test(name))) {
        const path = join(this.directory, name), info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink() || !privateEntry(info) || info.nlink !== 1 || info.size > MAX_BYTES) throw new McpOAuthStoreError('unavailable')
        await unlink(path)
      }
      const after = await this.directoryInfo()
      if (!parent || !after || parent.dev !== after.dev || parent.ino !== after.ino) throw new McpOAuthStoreError('unavailable')
      const expired = new Promise<never>((_resolve, reject) => {
        cancel = () => { live = false; reject(new McpOAuthStoreError('needs-sign-in')) }
        timer = setTimeout(cancel, this.options.transactionTimeoutMs ?? 120_000)
        signal?.addEventListener('abort', cancel, { once: true })
        if (signal?.aborted) cancel()
      })
      const guard: LeaseGuard = Object.assign(() => live && !signal?.aborted, {
        protect: async <R>(action: () => Promise<R>): Promise<R> => {
          if (!guard()) throw new McpOAuthStoreError('changed')
          const pending = Promise.resolve().then(action)
          mutations.add(pending)
          try { return await pending } finally { mutations.delete(pending) }
        }
      })
      const result = await Promise.race([Promise.resolve().then(() => action(guard)), expired])
      if (!live) throw new McpOAuthStoreError('needs-sign-in')
      database.exec('COMMIT'); acquired = false
      return result
    } catch (error) {
      // SQLite diagnostics contain filenames and must not escape the privileged boundary.
      if (error instanceof McpOAuthStoreError) throw error
      if (error && typeof error === 'object' && ('errcode' in error && (error.errcode === 5 || error.errcode === 6) ||
        'code' in error && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED'))) throw new McpOAuthStoreError('busy')
      throw new McpOAuthStoreError('unavailable')
    } finally {
      live = false; clearTimeout(timer)
      if (cancel) signal?.removeEventListener('abort', cancel)
      // A timed-out network callback can be abandoned. Already-started native key
      // saves and atomic filesystem mutations must settle before unlocking, or a
      // late save/rename could replace another process's fresh key or record.
      await Promise.allSettled([...mutations])
      if (acquired) { try { database?.exec('ROLLBACK') } catch { /* Closing still releases the native lease. */ } }
      try { database?.close() } catch { /* Never surface SQLite/helper diagnostics. */ }
    }
  }
  private async key(create: boolean, isCurrent: () => boolean = () => true): Promise<Buffer> {
    const store = await this.keyStore()
    let value = await store.load()
    if (!isCurrent()) throw new McpOAuthStoreError('changed')
    if (value === undefined) {
      if (!create || !(await store.status()).available || (await readdir(this.directory)).some(name => /^mcp-oauth-[a-z][a-z0-9_-]{0,15}\.json$/.test(name))) throw new McpOAuthStoreError('unavailable')
      value = randomBytes(32).toString('base64')
      // Only called under the directory lock. An existing key is never replaced.
      if (!isCurrent()) throw new McpOAuthStoreError('changed')
      await store.save(value)
      if (await store.load() !== value) throw new McpOAuthStoreError('unavailable')
    }
    return base64(value, 32)
  }
  private async bytes(serverId: string): Promise<Buffer | undefined> {
    const parent = await this.directoryInfo()
    if (!parent) return undefined
    let entry
    try { entry = await lstat(this.path(serverId)) } catch (error) { if (missing(error)) return undefined; throw new McpOAuthStoreError('unavailable') }
    if (!entry.isFile() || entry.isSymbolicLink() || !privateEntry(entry) || entry.size > MAX_BYTES || entry.nlink !== 1) throw new McpOAuthStoreError('unavailable')
    const file = await open(this.path(serverId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const current = await file.stat(), after = await this.directoryInfo()
      if (!current.isFile() || !privateEntry(current) || current.dev !== entry.dev || current.ino !== entry.ino ||
        !after || parent.dev !== after.dev || parent.ino !== after.ino) throw new McpOAuthStoreError('unavailable')
      const bytes = Buffer.alloc(MAX_BYTES + 1)
      let offset = 0
      while (offset < bytes.length) { const part = await file.read(bytes, offset, bytes.length - offset, null); if (!part.bytesRead) break; offset += part.bytesRead }
      if (offset > MAX_BYTES) throw new McpOAuthStoreError('unavailable')
      return bytes.subarray(0, offset)
    } finally { await file.close() }
  }
  private register(value: unknown): void {
    if (mcpRecord(value)) this.options.registerSecrets?.(['accessToken', 'refreshToken'].flatMap(key => typeof value[key] === 'string' ? [value[key] as string] : []))
  }
  private async read(serverId: string): Promise<StoredRecord | undefined> {
    const bytes = await this.bytes(serverId)
    if (!bytes) return undefined
    const key = await this.key(false)
    let clear: Buffer | undefined
    try {
      const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!mcpRecord(envelope) || Object.keys(envelope).length !== 4 || envelope.version !== 1) throw new McpOAuthStoreError('unavailable')
      const decipher = createDecipheriv('aes-256-gcm', key, base64(envelope.iv, 12), { authTagLength: 16 })
      decipher.setAAD(Buffer.from(`vivi-cli/mcp-oauth/v1/${serverId}`)); decipher.setAuthTag(base64(envelope.tag, 16))
      clear = Buffer.concat([decipher.update(base64(envelope.ciphertext)), decipher.final()])
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear))
      if (mcpRecord(parsed)) this.register(parsed.tokens)
      if (!mcpRecord(parsed) || !Object.keys(parsed).every(key => KEYS.includes(key)) || parsed.serverId !== serverId ||
        typeof parsed.endpoint !== 'string' || typeof parsed.revision !== 'string' || !/^[0-9a-f-]{36}$/.test(parsed.revision) ||
        parsed.refreshPending !== undefined && parsed.refreshPending !== true) throw new McpOAuthStoreError('unavailable')
      const endpoint = identity(serverId, parsed.endpoint), client = validateMcpOAuthSavedClient(parsed.client, endpoint)
      const tokens = parsed.tokens === undefined ? undefined : validateMcpOAuthSavedTokens(parsed.tokens, client, client.resource ?? endpoint)
      return mcpFreeze({ serverId, endpoint, client, revision: parsed.revision, ...(tokens ? { tokens } : {}), ...(parsed.refreshPending ? { refreshPending: true } : {}) })
    } finally { key.fill(0); clear?.fill(0) }
  }
  async load(serverId: string, endpoint: string): Promise<McpOAuthSavedRecord | undefined> {
    endpoint = identity(serverId, endpoint)
    try {
      const record = await this.read(serverId)
      if (!record || record.endpoint !== endpoint) return undefined
      // A crash after the marker could have consumed a rotating refresh token. Never reuse it.
      return record.refreshPending ? mcpFreeze({ serverId, endpoint, client: record.client, revision: record.revision }) : record
    } catch (error) { throw error instanceof McpOAuthStoreError ? error : new McpOAuthStoreError('unavailable') }
  }
  private async write(record: StoredRecord, isCurrent: () => boolean = () => true, lease?: LeaseGuard,
    lifecycle?: McpOAuthStoreLifecycle, kind?: McpOAuthStoreEffectReceipt['kind']): Promise<void> {
    if (lease) return lease.protect(() => this.write(record, isCurrent, undefined, lifecycle, kind))
    lifecycle?.assertCurrent()
    if (!isCurrent()) throw new McpOAuthStoreError('changed')
    const parent = await this.directoryInfo(), key = await this.key(true, isCurrent), iv = randomBytes(12)
    const clear = Buffer.from(JSON.stringify(record)), temporary = join(this.directory, `.mcp-oauth.${randomUUID()}.tmp`)
    try {
      if (clear.length > 47 * 1024) throw new McpOAuthStoreError('unavailable')
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
      cipher.setAAD(Buffer.from(`vivi-cli/mcp-oauth/v1/${record.serverId}`))
      const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()])
      const encoded = JSON.stringify({ version: 1, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }) + '\n'
      if (Buffer.byteLength(encoded) > MAX_BYTES) throw new McpOAuthStoreError('unavailable')
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(encoded); await file.sync() } finally { await file.close() }
      const after = await this.directoryInfo()
      if (!parent || !after || parent.dev !== after.dev || parent.ino !== after.ino) throw new McpOAuthStoreError('unavailable')
      if (!isCurrent()) throw new McpOAuthStoreError('changed')
      lifecycle?.assertCurrent()
      await rename(temporary, this.path(record.serverId))
      await this.replaced({ kind: kind ?? (record.refreshPending ? 'refresh-intent-replaced' : record.tokens ? 'saved-credentials-replaced' : 'saved-client-replaced'),
        serverId: record.serverId, recordRevision: record.revision, durabilityUnverified: true }, lifecycle)
    } finally { key.fill(0); clear.fill(0); await unlink(temporary).catch(() => undefined) }
  }
  /** Finish the same native mutation even if evidence delivery fails or cancels its owner. */
  private async replaced(receipt: McpOAuthStoreEffectReceipt, lifecycle?: McpOAuthStoreLifecycle): Promise<void> {
    let failed = false, failure: unknown
    try { lifecycle?.effect(mcpFreeze(receipt)) } catch (error) { failed = true; failure = error }
    await this.syncDirectory()
    if (failed) throw failure
  }
  private async forget(serverId: string, lifecycle?: McpOAuthStoreLifecycle): Promise<void> {
    lifecycle?.assertCurrent()
    try { await unlink(this.path(serverId)) } catch (error) { if (missing(error)) return; throw error }
    await this.replaced({ kind: 'saved-sign-in-forgotten', serverId, durabilityUnverified: true }, lifecycle)
  }
  private async syncDirectory(): Promise<void> {
    if (process.platform === 'win32') return
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
  }
  async saveClient(serverId: string, endpoint: string, input: McpOAuthSavedClient,
    isCurrent: () => boolean = () => true, signal?: AbortSignal, lifecycle?: McpOAuthStoreLifecycle): Promise<McpOAuthSavedRecord> {
    endpoint = identity(serverId, endpoint)
    const client = validateMcpOAuthSavedClient(input, endpoint)
    return this.lock(async leaseCurrent => {
      const existing = (await readdir(this.directory)).filter(name => /^mcp-oauth-[a-z][a-z0-9_-]{0,15}\.json$/.test(name))
      if (!existing.includes(`mcp-oauth-${serverId}.json`) && existing.length >= 8) throw new McpOAuthStoreError('unavailable')
      const record = mcpFreeze({ serverId, endpoint, client, revision: randomUUID() })
      await this.write(record, () => leaseCurrent() && isCurrent(), leaseCurrent, lifecycle); return record
    }, signal).catch(error => { throw error instanceof McpOAuthStoreError ? error : new McpOAuthStoreError('unavailable') })
  }
  private async current(serverId: string, endpoint: string, revision?: string): Promise<StoredRecord> {
    const record = await this.read(serverId)
    if (!record || record.endpoint !== endpoint || revision !== undefined && record.revision !== revision) throw new McpOAuthStoreError('changed')
    return record
  }
  async saveTokens(serverId: string, endpoint: string, expectedRevision: string, input: McpOAuthSavedTokens,
    isCurrent: () => boolean = () => true, signal?: AbortSignal, lifecycle?: McpOAuthStoreLifecycle): Promise<McpOAuthSavedRecord> {
    endpoint = identity(serverId, endpoint); this.register(input)
    return this.lock(async leaseCurrent => {
      const previous = await this.current(serverId, endpoint, expectedRevision)
      const tokens = validateMcpOAuthSavedTokens(input, previous.client, previous.client.resource ?? endpoint)
      const record = mcpFreeze({ serverId, endpoint, client: previous.client, tokens, revision: randomUUID() })
      await this.write(record, () => leaseCurrent() && isCurrent(), leaseCurrent, lifecycle); return record
    }, signal).catch(error => { throw error instanceof McpOAuthStoreError ? error : new McpOAuthStoreError('unavailable') })
  }
  async clearTokens(serverId: string, endpoint: string, expectedRevision?: string, lifecycle?: McpOAuthStoreLifecycle): Promise<McpOAuthSavedRecord | undefined> {
    endpoint = identity(serverId, endpoint)
    return this.lock(async leaseCurrent => {
      let previous: StoredRecord | undefined
      try { previous = await this.current(serverId, endpoint, expectedRevision) }
      catch (error) {
        // Sign-out must remain possible with a locked/lost OS key. Forget the whole local record.
        if (error instanceof McpOAuthStoreError && error.code === 'changed') return undefined
        // A denial for an older process/epoch cannot delete an unreadable newer
        // record. Explicit local logout (without a CAS revision) remains possible.
        if (expectedRevision !== undefined) throw new McpOAuthStoreError('unavailable')
        if (!leaseCurrent()) throw new McpOAuthStoreError('changed')
        await leaseCurrent.protect(async () => {
          await this.forget(serverId, lifecycle)
        })
        return undefined
      }
      const record = mcpFreeze({ serverId, endpoint, client: previous.client, revision: randomUUID() })
      await this.write(record, leaseCurrent, leaseCurrent, lifecycle, 'saved-sign-in-forgotten'); return record
    }).catch(error => { throw error instanceof McpOAuthStoreError ? error : new McpOAuthStoreError('unavailable') })
  }
  async remove(serverId: string, isCurrent: () => boolean | Promise<boolean> = () => true, lifecycle?: McpOAuthStoreLifecycle): Promise<void> {
    identity(serverId, 'https://identity.invalid/'); lifecycle?.assertCurrent()
    if (!await isCurrent()) throw new McpOAuthStoreError('changed')
    // Inert add/list/unknown cleanup must not initialize a profile key or lease.
    if (!await this.directoryInfo() || !await this.bytes(serverId)) return
    await this.lock(async leaseCurrent => leaseCurrent.protect(async () => {
      if (!leaseCurrent() || !await isCurrent() || !leaseCurrent()) throw new McpOAuthStoreError('changed')
      await this.forget(serverId, lifecycle)
    }))
      .catch(error => { throw error instanceof McpOAuthStoreError ? error : new McpOAuthStoreError('unavailable') })
  }
  /** Validated host configuration only. Unrelated server edits retain approved sign-in. */
  async reconcile(servers: readonly { readonly id: string; readonly endpoint: string }[], lifecycle?: McpOAuthStoreLifecycle): Promise<void> {
    const expected = new Map(servers.map(server => [server.id, identity(server.id, server.endpoint)]))
    if (!await this.directoryInfo()) return
    await this.lock(async lease => {
      const names = (await readdir(this.directory)).filter(name => /^mcp-oauth-[a-z][a-z0-9_-]{0,15}\.json$/.test(name))
      if (names.length > 8) throw new McpOAuthStoreError('unavailable')
      for (const name of names) {
        const id = name.slice('mcp-oauth-'.length, -'.json'.length), endpoint = expected.get(id)
        // Missing IDs can be forgotten even when the keyring is locked. Existing
        // unreadable records are preserved, never guessed to have a new identity.
        if (endpoint !== undefined && (await this.read(id))?.endpoint === endpoint) continue
        await lease.protect(async () => { await this.forget(id, lifecycle) })
      }
    })
  }
  async refreshTokens(serverId: string, endpoint: string, expectedRevision: string,
    perform: (tokens: McpOAuthSavedTokens) => Promise<McpOAuthSavedTokens>, isCurrent: () => boolean = () => true, signal?: AbortSignal, lifecycle?: McpOAuthStoreLifecycle): Promise<McpOAuthSavedRecord> {
    endpoint = identity(serverId, endpoint)
    return this.lock(async leaseCurrent => {
      const previous = await this.current(serverId, endpoint, expectedRevision)
      if (previous.refreshPending || !previous.tokens?.refreshToken) throw new McpOAuthStoreError('needs-sign-in')
      const pending = mcpFreeze({ ...previous, revision: randomUUID(), refreshPending: true as const })
      if (!leaseCurrent() || !isCurrent()) throw new McpOAuthStoreError('changed')
      await this.write(pending, () => leaseCurrent() && isCurrent(), leaseCurrent, lifecycle)
      try {
        if (!leaseCurrent() || !isCurrent()) throw new McpOAuthStoreError('changed')
        lifecycle?.assertCurrent()
        const input = await perform(previous.tokens); this.register(input)
        const tokens = validateMcpOAuthSavedTokens(input, previous.client, previous.client.resource ?? endpoint)
        if (tokens.scopes.some(scope => !previous.tokens!.scopes.includes(scope))) throw new McpOAuthStoreError('needs-sign-in')
        const record = mcpFreeze({ serverId, endpoint, client: previous.client, tokens, revision: randomUUID() })
        await this.write(record, () => leaseCurrent() && isCurrent(), leaseCurrent, lifecycle); return record
      } catch {
        // Any uncertain POST/rotation or failed durable save requires fresh sign-in. No retry.
        const cleared = mcpFreeze({ serverId, endpoint, client: previous.client, revision: randomUUID() })
        if (leaseCurrent()) await this.write(cleared, leaseCurrent, leaseCurrent, lifecycle && { assertCurrent() {}, effect: receipt => lifecycle.effect(receipt) }, 'saved-sign-in-forgotten').catch(() => undefined)
        throw new McpOAuthStoreError('needs-sign-in')
      }
    }, signal).catch(error => { throw error instanceof McpOAuthStoreError ? error : new McpOAuthStoreError('unavailable') })
  }
}
