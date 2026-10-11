// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { HistoryMessage, ToolCall, ToolResult } from '@ayayaq/vivi'
import { assertMcpJson, mcpDigest } from '@ayayaq/vivi/extensions/mcp'
import { publicUrlContainsSecret } from './public-url.js'

export const MAX_PUBLIC_URL_OUTCOME_ROWS = 128
export const MAX_PUBLIC_URL_OUTCOME_BYTES = 2 * 1024 * 1024
/** Evidence only. These records never contain executable approval or resumable permits. */
export interface PublicUrlOutcomeRecord {
  readonly id: string
  readonly sessionId: string
  readonly runId: string
  readonly callId: string
  readonly toolName: string
  readonly callDigest: string
  /** Original exact-call hash bridges interrupted privacy-only identity rewrites. */
  readonly recoveryCallDigest?: string
  readonly bindingDigest: string
  readonly state: 'accepted' | 'intent' | 'settled'
  readonly result?: ToolResult
}
export interface PublicUrlOutcomeStore {
  load(sessionId: string): Promise<readonly PublicUrlOutcomeRecord[]>
  save(sessionId: string, records: readonly PublicUrlOutcomeRecord[], options?: { readonly assertCurrent?: () => void }): Promise<void>
  addSecrets?(secrets: readonly string[]): void
  drain?(): Promise<void>
}
export class PublicUrlOutcomeCommitError extends Error {
  constructor(cause: unknown) {
    super('public URL outcome evidence was replaced, but durable persistence could not be confirmed', { cause })
    this.name = 'PublicUrlOutcomeCommitError'
  }
}
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const digest = (value: unknown): boolean => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
function check(value: unknown): asserts value { if (!value) throw new Error('Invalid public URL outcome evidence') }
/** Closed JSON schema, complexity and byte bounds are checked before cloning or property access. */
export function validatePublicUrlOutcomes(sessionId: string, value: unknown): PublicUrlOutcomeRecord[] {
  check(uuid(sessionId))
  assertMcpJson(value, MAX_PUBLIC_URL_OUTCOME_BYTES)
  check(Array.isArray(value) && value.length <= MAX_PUBLIC_URL_OUTCOME_ROWS)
  const ids = new Set<string>(), calls = new Set<string>(), digests = new Map<string, string>()
  for (const record of value as PublicUrlOutcomeRecord[]) {
    check(record && !Array.isArray(record) && typeof record === 'object')
    check(Object.keys(record).every(key => ['id', 'sessionId', 'runId', 'callId', 'toolName', 'callDigest', 'recoveryCallDigest', 'bindingDigest', 'state', 'result'].includes(key)))
    check(uuid(record.id) && record.sessionId === sessionId && uuid(record.runId))
    check(typeof record.callId === 'string' && record.callId.length > 0 && record.callId.length <= 200)
    check(typeof record.toolName === 'string' && (record.toolName === 'fetch_url' || /^public_url_withheld_[a-z0-9]+$/.test(record.toolName)))
    if (Object.hasOwn(record, 'recoveryCallDigest')) check(digest(record.recoveryCallDigest))
    check(digest(record.callDigest) && digest(record.bindingDigest) && (record.state === 'accepted' || record.state === 'intent' || record.state === 'settled'))
    check(!ids.has(record.id) && !calls.has(record.callId)); ids.add(record.id); calls.add(record.callId)
    for (const exact of [record.callDigest, record.recoveryCallDigest].filter((value): value is string => value !== undefined)) {
      check(!digests.has(exact) || digests.get(exact) === record.id); digests.set(exact, record.id)
    }
    if (record.state === 'accepted' || record.state === 'intent') check(record.result === undefined)
    else {
      const result = record.result
      check(result && typeof result === 'object' && !Array.isArray(result))
      check(Object.keys(result).every(key => ['content', 'isError'].includes(key)))
      check(typeof result.content === 'string' && result.content.length <= 64 * 1024 && Buffer.byteLength(result.content) <= 64 * 1024)
      check(result.isError === undefined || typeof result.isError === 'boolean')
    }
  }
  return structuredClone(value) as PublicUrlOutcomeRecord[]
}
export function publicUrlOutcomeMatchesCall(record: PublicUrlOutcomeRecord, call: ToolCall): boolean {
  const exact = mcpDigest(call)
  return record.callId === call.id && record.toolName === call.name && record.callDigest === exact ||
    record.recoveryCallDigest === exact
}
export function publicUrlOutcomeResult(record: PublicUrlOutcomeRecord): ToolResult {
  return record.result ?? (record.state === 'accepted' ? unattemptedPublicUrlResult() : unresolvedPublicUrlResult())
}
export function unresolvedPublicUrlResult(): ToolResult {
  return { content: JSON.stringify({ success: false, source: 'public_url', untrusted: true,
    unknownOutcome: true, doNotRetry: true, transmission: 'unknown', serverEffects: 'unknown',
    error: { code: 'public_url_unknown_outcome', message: 'A durable public URL send intent exists, but no settled result is available. The request may have reached the server. Do not retry automatically' } }), isError: true }
}
export function unattemptedPublicUrlResult(code = 'cancelled'): ToolResult {
  return { content: JSON.stringify({ success: false, source: 'public_url', untrusted: true,
    transmission: 'not_attempted', serverEffects: 'not_attempted', requests: [], redirects: [], bytesRead: 0,
    error: { code, message: 'This public URL request was not sent; approval or the current turn was unavailable' } }), isError: true }
}
/** Identity is established only from the owned row and matching canonical assistant call. */
export function reconcilePublicUrlOutcomes(history: readonly HistoryMessage[], sessionId: string,
  records: readonly PublicUrlOutcomeRecord[]): HistoryMessage[] {
  const validated = validatePublicUrlOutcomes(sessionId, records), calls = new Map<string, ToolCall>()
  for (const message of history) if (message.kind === 'assistant') for (const call of message.toolCalls) {
    check(!calls.has(call.id)); calls.set(call.id, call)
  }
  return history.map(message => {
    if (message.kind !== 'tool_result') return structuredClone(message)
    const call = calls.get(message.callId)
    const record = call?.name === message.name ? validated.find(row => publicUrlOutcomeMatchesCall(row, call)) : undefined
    return record ? { kind: 'tool_result', callId: message.callId, name: message.name,
      ...publicUrlOutcomeResult(record) } : structuredClone(message)
  })
}
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
function privateOwned(info: Awaited<ReturnType<typeof lstat>>): boolean {
  return process.platform === 'win32' || ((Number(info.mode) & 0o077) === 0 && info.uid === process.getuid?.())
}
/** The session lease owns these standalone files. Atomic fsync-before-send writes cannot be
 * undone by a failed transcript checkpoint. Capacity is fail-closed, never an eviction policy. */
export class FilePublicUrlOutcomeStore implements PublicUrlOutcomeStore {
  readonly directory: string
  private readonly secrets = new Set<string>()
  private chain: Promise<void> = Promise.resolve()
  constructor(directory: string, secrets: readonly string[] = []) { this.directory = resolve(directory); this.addSecrets(secrets) }
  addSecrets(secrets: readonly string[]): void { for (const secret of secrets) if (secret) this.secrets.add(secret) }
  private path(sessionId: string): string { if (!uuid(sessionId)) throw new Error('Invalid public URL outcome session id'); return join(this.directory, `${sessionId}.public-url-outcomes.json`) }
  private assertSafe(records: readonly PublicUrlOutcomeRecord[]): void {
    if (publicUrlContainsSecret(records, [...this.secrets])) throw new Error('public URL outcome evidence contains a known credential')
  }
  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || !privateOwned(info)) throw new Error('public URL outcome directory must be private and owned')
  }
  async load(sessionId: string): Promise<readonly PublicUrlOutcomeRecord[]> {
    await this.chain
    const path = this.path(sessionId)
    let entry
    try { entry = await lstat(path) } catch (error) { if (missing(error)) return []; throw error }
    const directory = await lstat(this.directory)
    if (!directory.isDirectory() || directory.isSymbolicLink() || !privateOwned(directory) ||
      !entry.isFile() || entry.isSymbolicLink() || !privateOwned(entry) || entry.size > MAX_PUBLIC_URL_OUTCOME_BYTES) throw new Error('public URL outcome evidence must be a private regular file within the size limit')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile() || !privateOwned(info) || info.dev !== entry.dev || info.ino !== entry.ino || info.size > MAX_PUBLIC_URL_OUTCOME_BYTES) throw new Error('public URL outcome evidence changed while opening')
      const bytes = Buffer.alloc(MAX_PUBLIC_URL_OUTCOME_BYTES + 1)
      let offset = 0
      while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead }
      if (offset > MAX_PUBLIC_URL_OUTCOME_BYTES) throw new Error('public URL outcome evidence exceeds the size limit')
      return validatePublicUrlOutcomes(sessionId, JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown)
    } finally { await file.close() }
  }
  save(sessionId: string, records: readonly PublicUrlOutcomeRecord[], options: { readonly assertCurrent?: () => void } = {}): Promise<void> {
    const snapshot = validatePublicUrlOutcomes(sessionId, records)
    const operation = this.chain.then(async () => {
      const assertCurrent = (): void => { options.assertCurrent?.(); this.assertSafe(snapshot) }
      assertCurrent(); await this.prepare(); assertCurrent()
      const target = this.path(sessionId)
      try { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink() || !privateOwned(info)) throw new Error('Refusing to replace unsafe public URL outcome evidence') }
      catch (error) { if (!missing(error)) throw error }
      const temporary = join(this.directory, `.${sessionId}.${randomUUID()}.public-url-outcomes.tmp`)
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      let committed = false
      try {
        await file.writeFile(JSON.stringify(snapshot), 'utf8'); assertCurrent()
        await file.sync(); assertCurrent(); await file.close(); assertCurrent()
        await rename(temporary, target); committed = true
        if (process.platform !== 'win32') { const directory = await open(this.directory, constants.O_RDONLY); try { await directory.sync() } finally { await directory.close() } }
      } catch (error) { if (committed) throw new PublicUrlOutcomeCommitError(error); throw error }
      finally { await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined) }
    })
    this.chain = operation.catch(() => undefined)
    return operation
  }
  async drain(): Promise<void> { await this.chain }
}
