// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createMcpWrappingKeyStore } from './credentials.js'
import type { CredentialStoreStatus, McpWrappingKeyStore } from './credentials.js'
import { ChatGptAuthError, CHATGPT_ISSUER, authCheck, authRecord, authText } from './chatgpt-auth-types.js'
import type { ChatGptAuthData, ChatGptRegistration, ChatGptTokens } from './chatgpt-auth-types.js'

const MAX_BYTES = 1024 * 1024
const missing = (error: unknown): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
const privateEntry = (info: Awaited<ReturnType<typeof lstat>>): boolean => process.platform === 'win32' || info.uid === process.getuid?.() && (Number(info.mode) & 0o077) === 0
const storageError = (): ChatGptAuthError => new ChatGptAuthError('storage-unavailable')
const validHostId = (value: unknown): value is string => typeof value === 'string' && /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
export const chatGptAccountId = (clientId: string, subject: string): string => createHash('sha256').update(JSON.stringify([CHATGPT_ISSUER, clientId, subject])).digest('hex')
function fields(value: Record<string, unknown>, names: readonly string[]): boolean { return Object.keys(value).every(name => names.includes(name)) }
function validTokens(value: unknown): value is ChatGptTokens {
  return authRecord(value) && fields(value, ['accessToken', 'refreshToken', 'idToken', 'idTokenNonce', 'scopes', 'expiresAt', 'savedAt', 'earliestRefreshAt']) &&
    authText(value.accessToken, 65_536) && authText(value.idToken, 65_536) && (value.refreshToken === undefined || authText(value.refreshToken, 16_384)) &&
    (value.idTokenNonce === undefined || authText(value.idTokenNonce, 512)) &&
    Array.isArray(value.scopes) && value.scopes.length <= 64 && value.scopes.every(scope => authText(scope, 256)) && new Set(value.scopes).size === value.scopes.length &&
    typeof value.expiresAt === 'number' && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0 &&
    typeof value.savedAt === 'number' && Number.isSafeInteger(value.savedAt) && value.savedAt > 0 &&
    (value.earliestRefreshAt === undefined || typeof value.earliestRefreshAt === 'number' && Number.isSafeInteger(value.earliestRefreshAt) && value.earliestRefreshAt > 0)
}
function validRegistration(value: unknown): value is ChatGptRegistration {
  return authRecord(value) && fields(value, ['id', 'clientId', 'subject', 'email', 'welcomeSeen', 'revision', 'tokens', 'refreshPending']) &&
    authText(value.clientId, 1024) && value.clientId !== 'dynamic_agent_client' && authText(value.subject, 1024) &&
    value.id === chatGptAccountId(value.clientId, value.subject) && (value.email === undefined || authText(value.email, 1024)) &&
    typeof value.welcomeSeen === 'boolean' && typeof value.revision === 'string' && /^[0-9a-f-]{36}$/.test(value.revision) &&
    (value.tokens === undefined || validTokens(value.tokens)) && (value.refreshPending === undefined || value.refreshPending === true && value.tokens !== undefined)
}
function validateData(value: unknown, hostId: string): ChatGptAuthData {
  if (!authRecord(value) || !fields(value, ['version', 'hostId', 'accounts']) || value.version !== 1 || value.hostId !== hostId ||
    !Array.isArray(value.accounts) || value.accounts.length > 32 || !value.accounts.every(validRegistration) ||
    new Set(value.accounts.map(account => account.id)).size !== value.accounts.length ||
    new Set(value.accounts.map(account => account.clientId)).size !== value.accounts.length) throw storageError()
  return structuredClone(value as unknown as ChatGptAuthData)
}
function base64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || value.length > MAX_BYTES * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw storageError()
  const result = Buffer.from(value, 'base64')
  if (result.toString('base64') !== value || length !== undefined && result.length !== length) throw storageError()
  return result
}
export interface ChatGptAuthStoreOptions {
  /** Trusted fixture seam. Production always uses the platform credential store, never plaintext. */
  readonly keyStore?: (scope: string) => McpWrappingKeyStore
  readonly registerSecrets?: (values: readonly string[]) => void
}
export interface ChatGptAuthTransaction {
  readonly data: ChatGptAuthData
  write(data: ChatGptAuthData): Promise<void>
}
/** Encrypted per-host account database. A native SQLite OS lease serializes token rotation across processes. */
export class ChatGptAuthStore {
  readonly directory: string
  constructor(directory: string, private readonly options: ChatGptAuthStoreOptions = {}) { this.directory = resolve(directory) }
  private async directoryInfo(create = false): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const info = await lstat(this.directory)
      if (!info.isDirectory() || info.isSymbolicLink() || !privateEntry(info)) throw storageError()
      return info
    } catch (error) { if (missing(error)) return undefined; throw storageError() }
  }
  private async bytes(path: string, limit = MAX_BYTES): Promise<Buffer | undefined> {
    const parent = await this.directoryInfo()
    if (!parent) return undefined
    let before
    try { before = await lstat(path) } catch (error) { if (missing(error)) return undefined; throw storageError() }
    if (!before.isFile() || before.isSymbolicLink() || !privateEntry(before) || before.nlink !== 1 || before.size > limit) throw storageError()
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const current = await file.stat(), after = await this.directoryInfo()
      if (!current.isFile() || !privateEntry(current) || current.nlink !== 1 || current.dev !== before.dev || current.ino !== before.ino ||
        !after || parent.dev !== after.dev || parent.ino !== after.ino) throw storageError()
      const result = Buffer.alloc(limit + 1); let offset = 0
      while (offset < result.length) { const part = await file.read(result, offset, result.length - offset, null); if (!part.bytesRead) break; offset += part.bytesRead }
      if (offset > limit) throw storageError()
      return result.subarray(0, offset)
    } finally { await file.close() }
  }
  private async atomic(path: string, bytes: string): Promise<void> {
    const parent = await this.directoryInfo(), temporary = join(this.directory, `.chatgpt.${randomUUID()}.tmp`)
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
      const after = await this.directoryInfo()
      if (!parent || !after || parent.dev !== after.dev || parent.ino !== after.ino) throw storageError()
      await rename(temporary, path)
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { await directory.sync() } finally { await directory.close() }
      }
    } finally { await unlink(temporary).catch(() => undefined) }
  }
  private async leaseDatabase(): Promise<{ exec(sql: string): unknown; close(): void }> {
    const path = join(this.directory, 'lease.sqlite')
    let created
    try { created = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw storageError() }
    await created?.close()
    for (const candidate of [path, path + '-journal']) {
      let info
      try { info = await lstat(candidate) } catch (error) { if (missing(error)) continue; throw storageError() }
      if (!info.isFile() || info.isSymbolicLink() || !privateEntry(info) || info.nlink !== 1 || info.size > MAX_BYTES) throw storageError()
    }
    if ('Bun' in globalThis) {
      const specifier = 'bun:sqlite'
      const module = await import(specifier) as { Database: new (path: string, options: { create: boolean }) => { exec(sql: string): unknown; close(): void } }
      return new module.Database(path, { create: true })
    }
    const { DatabaseSync } = await import('node:sqlite')
    return new DatabaseSync(path, { allowExtension: false, timeout: 0 })
  }
  private async locked<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    authCheck(signal); await this.directoryInfo(true)
    let database: { exec(sql: string): unknown; close(): void } | undefined, acquired = false
    try {
      database = await this.leaseDatabase()
      database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); acquired = true
      authCheck(signal)
      const result = await action()
      database.exec('COMMIT'); acquired = false; return result
    } catch (error) {
      if (error instanceof ChatGptAuthError) throw error
      if (error && typeof error === 'object' && ('errcode' in error && (error.errcode === 5 || error.errcode === 6) ||
        'code' in error && (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED'))) throw new ChatGptAuthError('busy')
      throw storageError()
    } finally {
      if (acquired) { try { database?.exec('ROLLBACK') } catch { /* Closing releases the native lease. */ } }
      try { database?.close() } catch { /* No native diagnostic paths leave this boundary. */ }
    }
  }
  private async host(): Promise<string> {
    const bytes = await this.bytes(join(this.directory, 'host.json'), 1024)
    if (bytes) {
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw storageError() }
      if (!authRecord(value) || !fields(value, ['version', 'hostId']) || value.version !== 1 || !validHostId(value.hostId)) throw storageError()
      return value.hostId
    }
    const hostId = `urn:uuid:${randomUUID()}`
    // A missing host record must never silently rebind an existing encrypted account database.
    if ((await readdir(this.directory)).some(name => name === 'registrations.json' || /^account-[0-9a-f]{64}\.json$/.test(name))) throw storageError()
    await this.atomic(join(this.directory, 'host.json'), JSON.stringify({ version: 1, hostId }) + '\n'); return hostId
  }
  /** Nonsecret host identity persists even for explicitly session-only sign-in. */
  async hostId(signal?: AbortSignal): Promise<string> { return this.locked(() => this.host(), signal) }
  private async keyStore(): Promise<McpWrappingKeyStore> {
    const canonical = await realpath(this.directory)
    // The existing native helper stores only a 32-byte wrapping key; domain separation
    // keeps ChatGPT and MCP records independent even under the same settings root.
    const scope = createHash('sha256').update(`vivi-cli/chatgpt-auth/v1\0${canonical}`).digest('hex')
    return this.options.keyStore?.(scope) ?? createMcpWrappingKeyStore(scope)
  }
  async status(): Promise<CredentialStoreStatus> {
    try {
      await this.directoryInfo(true)
      const status = await (await this.keyStore()).status()
      return { available: status.available, label: 'OS-protected ChatGPT sign-in', ...(status.available ? {} : { detail: 'Unlock OS credential storage or explicitly choose session-only sign-in' }) }
    } catch { return { available: false, label: 'OS-protected ChatGPT sign-in', detail: 'Secure saved sign-in storage is unavailable' } }
  }
  private async key(create: boolean): Promise<Buffer> {
    const store = await this.keyStore(); let value = await store.load()
    if (value === undefined) {
      if (!create || !(await store.status()).available || (await readdir(this.directory)).some(name => /^account-[0-9a-f]{64}\.json$/.test(name))) throw storageError()
      value = randomBytes(32).toString('base64'); await store.save(value)
      if (await store.load() !== value) throw storageError()
    }
    return base64(value, 32)
  }
  private register(data: ChatGptAuthData): void {
    for (const account of data.accounts) if (account.tokens) this.options.registerSecrets?.([account.tokens.accessToken, account.tokens.idToken,
      ...(account.tokens.idTokenNonce ? [account.tokens.idTokenNonce] : []), ...(account.tokens.refreshToken ? [account.tokens.refreshToken] : [])])
  }
  private async metadata(hostId: string): Promise<ChatGptAuthData> {
    const bytes = await this.bytes(join(this.directory, 'registrations.json'))
    if (!bytes) return { version: 1, hostId, accounts: [] }
    const data = validateData(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), hostId)
    if (data.accounts.some(account => account.tokens !== undefined || account.refreshPending !== undefined)) throw storageError()
    return data
  }
  private path(id: string): string {
    if (!/^[0-9a-f]{64}$/.test(id)) throw storageError()
    return join(this.directory, `account-${id}.json`)
  }
  private async readAccount(metadata: ChatGptRegistration, hostId: string): Promise<ChatGptRegistration> {
    const bytes = await this.bytes(this.path(metadata.id))
    if (!bytes) return metadata
    const key = await this.key(false); let clear: Buffer | undefined
    try {
      const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (!authRecord(envelope) || !fields(envelope, ['version', 'iv', 'tag', 'ciphertext']) || envelope.version !== 1) throw storageError()
      const cipher = createDecipheriv('aes-256-gcm', key, base64(envelope.iv, 12), { authTagLength: 16 })
      cipher.setAAD(Buffer.from(`vivi-cli/chatgpt-auth/v1/${hostId}/${metadata.id}`)); cipher.setAuthTag(base64(envelope.tag, 16))
      clear = Buffer.concat([cipher.update(base64(envelope.ciphertext)), cipher.final()])
      const record: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(clear))
      if (!validRegistration(record) || record.id !== metadata.id || record.clientId !== metadata.clientId || record.subject !== metadata.subject) throw storageError()
      this.register({ version: 1, hostId, accounts: [record] }); return record
    } finally { key.fill(0); clear?.fill(0) }
  }
  private async read(hostId: string): Promise<ChatGptAuthData> {
    const data = await this.metadata(hostId), accounts: ChatGptRegistration[] = []
    for (const account of data.accounts) accounts.push(await this.readAccount(account, hostId))
    return { ...data, accounts }
  }
  private withoutTokens(account: ChatGptRegistration): ChatGptRegistration {
    const { tokens: _tokens, refreshPending: _pending, ...metadata } = account
    return metadata
  }
  private async writeMetadata(data: ChatGptAuthData): Promise<void> {
    await this.atomic(join(this.directory, 'registrations.json'), JSON.stringify({ ...data, accounts: data.accounts.map(account => this.withoutTokens(account)) }) + '\n')
  }
  private async writeAccount(record: ChatGptRegistration, hostId: string): Promise<void> {
    if (!record.tokens) { await unlink(this.path(record.id)).catch(error => { if (!missing(error)) throw error }); return }
    const clear = Buffer.from(JSON.stringify(record)), key = await this.key(true), iv = randomBytes(12)
    try {
      if (clear.length > 700 * 1024) throw storageError()
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
      cipher.setAAD(Buffer.from(`vivi-cli/chatgpt-auth/v1/${hostId}/${record.id}`))
      const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()])
      await this.atomic(this.path(record.id), JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }) + '\n')
    } finally { clear.fill(0); key.fill(0) }
  }
  private async write(data: ChatGptAuthData): Promise<void> {
    data = validateData(data, await this.host()); this.register(data)
    // Persist the verified mapping before credentials so a crash never leaves tokens
    // attached to an unknown registration. Each token set is independently protected.
    await this.writeMetadata(data)
    for (const account of data.accounts) await this.writeAccount(account, data.hostId)
  }
  /** Basic verified registration mapping only. No credentials are read or required. */
  async readMetadata(signal?: AbortSignal): Promise<ChatGptAuthData> {
    return this.locked(async () => this.metadata(await this.host()), signal)
  }
  async saveMetadata(record: ChatGptRegistration, signal?: AbortSignal, clearTokens = false): Promise<void> {
    if (!validRegistration(record)) throw storageError()
    await this.locked(async () => {
      const data = await this.metadata(await this.host()), previous = data.accounts.find(account => account.id === record.id)
      const metadata = this.withoutTokens({ ...record, welcomeSeen: previous?.welcomeSeen === true || record.welcomeSeen })
      const next = validateData({ ...data, accounts: [...data.accounts.filter(account => account.id !== record.id), metadata] }, data.hostId)
      authCheck(signal)
      // Choosing transient credentials for this verified registration must not
      // silently reactivate an older saved token set on the next launch.
      if (clearTokens) await unlink(this.path(record.id)).catch(error => { if (!missing(error)) throw error })
      await this.writeMetadata(next)
    }, signal)
  }
  /** Sign-out remains possible if the OS credential store is locked. Never touches other accounts. */
  async clearSavedTokens(accountId: string): Promise<boolean> {
    return this.locked(async () => {
      const data = await this.metadata(await this.host()), previous = data.accounts.find(account => account.id === accountId)
      if (!previous) return false
      const existed = !!await this.bytes(this.path(accountId))
      await unlink(this.path(accountId)).catch(error => { if (!missing(error)) throw error })
      await this.writeMetadata({ ...data, accounts: data.accounts.map(account => account.id === accountId ? { ...account, revision: randomUUID() } : account) })
      return existed
    })
  }
  /** Privileged transaction only; never pass this data to display or inference. */
  async transaction<T>(action: (transaction: ChatGptAuthTransaction) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.locked(async () => {
      const hostId = await this.host(), data = await this.read(hostId)
      return action({ data, write: async next => { authCheck(signal); await this.write(next) } })
    }, signal)
  }
  async readData(signal?: AbortSignal): Promise<ChatGptAuthData> { return this.transaction(async transaction => transaction.data, signal) }
}
