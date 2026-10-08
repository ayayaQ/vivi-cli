// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

export const MAX_DECISION_LEDGER_ROWS = 256
export const MAX_DECISION_LEDGER_BYTES = 256 * 1024
export const DECISION_LEDGER_LOCK_WAIT_MS = 2_000
const LOCK_RETRY_MS = 25
const PRIMARY = 'decision-ledger.json'
const LOCK = `${PRIMARY}.lock`

export type DecisionLedgerToolName = 'note_set' | 'create_memory' | 'edit_memory' | 'delete_memory'
export type DecisionLedgerSource = 'automatic' | 'human-once' | 'human-deny'
export type DecisionLedgerState = 'reviewed' | 'commit_started' | 'committed' | 'denied' | 'cancelled' | 'failed' | 'unknown'
export type DecisionLedgerReasonCode = 'requirements_met' | 'provider_recommended_reject' | 'uncertain' |
  'refusal' | 'invalid_request' | 'invalid_response' | 'unsupported_model' | 'provider_mismatch' |
  'configuration' | 'http' | 'rate_limit' | 'transport' | 'timeout' | 'aborted' |
  'manual' | 'ineligible' | 'privacy' | 'budget' | 'stale' | 'audit_unavailable' | 'commit_failed' | 'commit_unknown' | 'cancelled'
export type DecisionLedgerPredicateName = 'exact_action_requested' | 'effects_within_scope' |
  'evidence_not_redirected' | 'ordinary_non_sensitive'
export interface DecisionLedgerCheck {
  readonly name: DecisionLedgerPredicateName
  readonly probability: number
  readonly reasonCode: 'allow_threshold_met' | 'deny_threshold_met' | 'between_thresholds'
}
/** Normalized reported usage only. Missing counts are never inferred. */
export interface DecisionLedgerUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens?: number
  readonly cachedTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
  readonly costUsd?: number
}
/** Closed, metadata-only audit projection. No text, arguments, credentials or model reasoning. */
export interface DecisionLedgerRecord {
  readonly id: string
  readonly sessionId: string
  readonly runId: string
  readonly callId: string
  readonly toolName: DecisionLedgerToolName
  readonly policyRevision: string
  readonly provider: 'openai' | 'openrouter'
  readonly model: string
  readonly snapshotDigest: string
  readonly source: DecisionLedgerSource
  readonly reasonCode: DecisionLedgerReasonCode
  readonly checks: readonly DecisionLedgerCheck[]
  readonly usage?: DecisionLedgerUsage
  readonly createdAt: string
  readonly updatedAt: string
  readonly state: DecisionLedgerState
  readonly resultRevision?: string | number
}
/** Stores are audit sinks, never sources of approval or resumable execution authority. */
export interface DecisionLedger {
  upsert(record: DecisionLedgerRecord, options?: { readonly signal?: AbortSignal }): Promise<void>
  addSecrets?(secrets: readonly string[]): void
  drain?(options?: { readonly close?: boolean }): Promise<void>
}

export class DecisionLedgerError extends Error {
  readonly code = 'audit_unavailable'
  constructor(message = 'Decision audit is unavailable') { super(message); this.name = 'DecisionLedgerError' }
}
/** Rename succeeded. The caller must not mistake uncertain audit durability for a rollback. */
export class DecisionLedgerCommitError extends DecisionLedgerError {
  readonly committed = true
  constructor(message = 'Decision audit was saved, but durable persistence could not be confirmed') {
    super(message); this.name = 'DecisionLedgerCommitError'
  }
}

const toolNames: readonly string[] = ['note_set', 'create_memory', 'edit_memory', 'delete_memory']
const sources: readonly string[] = ['automatic', 'human-once', 'human-deny']
const states: readonly string[] = ['reviewed', 'commit_started', 'committed', 'denied', 'cancelled', 'failed', 'unknown']
const reasons: readonly string[] = ['requirements_met', 'provider_recommended_reject', 'uncertain', 'refusal',
  'invalid_request', 'invalid_response', 'unsupported_model', 'provider_mismatch', 'configuration', 'http',
  'rate_limit', 'transport', 'timeout', 'aborted', 'manual', 'ineligible', 'privacy', 'budget', 'stale',
  'audit_unavailable', 'commit_failed', 'commit_unknown', 'cancelled']
const predicateNames: readonly string[] = ['exact_action_requested', 'effects_within_scope',
  'evidence_not_redirected', 'ordinary_non_sensitive']
const checkReasons: readonly string[] = ['allow_threshold_met', 'deny_threshold_met', 'between_thresholds']
const usageFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd']
const recordFields = ['id', 'sessionId', 'runId', 'callId', 'toolName', 'policyRevision', 'provider', 'model',
  'snapshotDigest', 'source', 'reasonCode', 'checks', 'usage', 'createdAt', 'updatedAt', 'state', 'resultRevision']
const identityFields = ['id', 'sessionId', 'runId', 'callId', 'toolName', 'policyRevision', 'provider', 'model',
  'snapshotDigest', 'createdAt'] as const

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DecisionLedgerError(`Invalid decision audit metadata: ${message}`)
}
/** Inspect descriptors before reading fields, so rejected getters/toJSON hooks never run. */
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object')
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, 'expected plain data')
  check(Object.getOwnPropertySymbols(value).length === 0, 'unexpected symbol')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  check(Object.keys(descriptors).every(key => allowed.includes(key)), 'unexpected field')
  for (const descriptor of Object.values(descriptors)) {
    check(descriptor.enumerable && 'value' in descriptor, 'expected enumerable data fields')
  }
  return value as Record<string, unknown>
}
function array(value: unknown, maximum: number): readonly unknown[] {
  check(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, 'expected plain array')
  check(value.length <= maximum && Object.getOwnPropertySymbols(value).length === 0, 'array exceeds limit')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (let index = 0; index < value.length; index++) check(Object.hasOwn(descriptors, String(index)), 'sparse array')
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (key === 'length') continue
    check(/^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length && descriptor.enumerable && 'value' in descriptor,
      'expected enumerable array data')
  }
  return value
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,199}$/.test(value)
}
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}
function member(value: unknown, values: readonly string[]): boolean { return typeof value === 'string' && values.includes(value) }
function count(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }

/** Capture a validated independent snapshot before queue admission. */
export function validateDecisionLedgerRecord(value: unknown): DecisionLedgerRecord {
  const record = object(value, recordFields)
  for (const field of ['id', 'sessionId', 'runId']) check(uuid(record[field]), 'invalid opaque UUID')
  for (const field of ['callId', 'policyRevision', 'model']) check(identifier(record[field]), 'invalid bounded identifier')
  check(member(record.toolName, toolNames), 'unknown tool')
  check(record.provider === 'openai' || record.provider === 'openrouter', 'unknown provider')
  check(typeof record.snapshotDigest === 'string' && /^[0-9a-f]{64}$/.test(record.snapshotDigest), 'invalid snapshot digest')
  check(member(record.source, sources), 'unknown decision source')
  check(member(record.reasonCode, reasons), 'unknown coded reason')
  check(member(record.state, states), 'unknown state')
  check(timestamp(record.createdAt) && timestamp(record.updatedAt) && record.updatedAt >= record.createdAt, 'invalid timestamp')
  const checks = array(record.checks, predicateNames.length)
  const seen = new Set<unknown>()
  for (const value of checks) {
    const predicate = object(value, ['name', 'probability', 'reasonCode'])
    check(member(predicate.name, predicateNames) && !seen.has(predicate.name), 'unknown or duplicate predicate')
    seen.add(predicate.name)
    check(typeof predicate.probability === 'number' && Number.isFinite(predicate.probability) &&
      predicate.probability >= 0 && predicate.probability <= 1, 'invalid predicate estimate')
    check(member(predicate.reasonCode, checkReasons), 'unknown predicate reason')
  }
  if (Object.hasOwn(record, 'usage')) {
    const usage = object(record.usage, usageFields)
    check(count(usage.inputTokens) && count(usage.outputTokens), 'invalid usage')
    for (const field of usageFields.slice(2)) {
      if (!Object.hasOwn(usage, field)) continue
      if (field === 'costUsd') check(typeof usage[field] === 'number' && Number.isFinite(usage[field]) && Number(usage[field]) >= 0, 'invalid cost')
      else check(count(usage[field]), 'invalid usage')
    }
  }
  if (Object.hasOwn(record, 'resultRevision')) check(identifier(record.resultRevision) || count(record.resultRevision), 'invalid result revision')
  return structuredClone(record) as unknown as DecisionLedgerRecord
}

interface Directory { readonly entry: Stats; readonly handle: FileHandle | undefined }
interface StoredFile { readonly entry: Stats; readonly bytes: Buffer }
interface Loaded { readonly records: readonly DecisionLedgerRecord[]; readonly file: StoredFile | undefined }
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
function exists(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'EEXIST' }
function ownedPrivate(info: Stats): boolean {
  return process.platform === 'win32' || ((info.mode & 0o077) === 0 && info.uid === process.getuid?.())
}
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino }
function unchangedFile(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}
function privateFile(info: Stats, maximum = MAX_DECISION_LEDGER_BYTES): boolean {
  return info.isFile() && !info.isSymbolicLink() && ownedPrivate(info) && info.size >= 0 && info.size <= maximum
}

/** Bounded app-wide metadata under the session directory, with a lease held only during writes.
 * Interrupted commit_started records become unknown, never executable approvals. Reads do not
 * create or repair files; a later admitted write persists the conservative recovery projection.
 */
export class FileDecisionLedger implements DecisionLedger {
  readonly directory: string
  private readonly secrets = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()
  private readonly jobs = new Set<Promise<unknown>>()
  private readonly liveStarts = new Map<string, string>()
  private closed = false
  private pendingDurability: Stats | undefined
  private failure: DecisionLedgerError | undefined

  constructor(sessionDirectory: string, secrets: readonly string[] = []) {
    this.directory = resolve(sessionDirectory)
    this.addSecrets(secrets)
  }
  get auditFailure(): DecisionLedgerError | undefined { return this.failure }
  addSecrets(secrets: readonly string[]): void {
    for (const secret of secrets) if (typeof secret === 'string' && secret) this.secrets.add(secret)
  }
  private assertNoSecrets(value: unknown): void {
    const pending = [value]
    while (pending.length) {
      const current = pending.pop()
      if (typeof current === 'string') {
        for (const secret of this.secrets) if (current.includes(secret)) throw new DecisionLedgerError('Decision audit must not contain known credentials')
      } else if (Array.isArray(current)) pending.push(...current)
      else if (current && typeof current === 'object') {
        for (const [key, child] of Object.entries(current)) pending.push(key, child)
      }
    }
  }
  private safeError(error: unknown): Error {
    let message = error instanceof Error ? error.message : 'Decision audit operation failed'
    for (const secret of [...this.secrets].sort((left, right) => right.length - left.length)) {
      message = message.split(secret).join('[REDACTED]')
      message = message.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]')
    }
    if (error instanceof Error && error.name === 'AbortError') {
      const safe = new Error(message); safe.name = 'AbortError'; return safe
    }
    const safe = error instanceof DecisionLedgerCommitError ? new DecisionLedgerCommitError(message) : new DecisionLedgerError(message)
    this.failure = safe
    return safe
  }
  private async directoryHandle(create: boolean): Promise<Directory | undefined> {
    if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 })
    let entry: Stats
    try { entry = await lstat(this.directory) } catch (error) { if (!create && missing(error)) return undefined; throw error }
    if (!entry.isDirectory() || entry.isSymbolicLink() || !ownedPrivate(entry)) {
      throw new DecisionLedgerError('Decision audit directory must be real, owned and private with permissions 0700')
    }
    if (process.platform === 'win32') {
      const directory = { entry, handle: undefined }
      await this.checkDirectory(directory)
      return directory
    }
    const handle = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isDirectory() || !ownedPrivate(info) || !sameFile(entry, info)) throw new DecisionLedgerError('Decision audit directory changed while opening')
      const directory = { entry, handle }
      await this.checkDirectory(directory)
      return directory
    } catch (error) { await handle.close().catch(() => undefined); throw error }
  }
  private async checkDirectory(directory: Directory): Promise<void> {
    const current = await lstat(this.directory)
    if (!current.isDirectory() || current.isSymbolicLink() || !ownedPrivate(current) || !sameFile(current, directory.entry)) {
      throw new DecisionLedgerError('Decision audit directory changed during the operation; files were preserved')
    }
  }
  private async readFile(directory: Directory): Promise<StoredFile | undefined> {
    await this.checkDirectory(directory)
    const path = join(this.directory, PRIMARY)
    let entry: Stats
    try { entry = await lstat(path) } catch (error) { if (missing(error)) return undefined; throw error }
    if (!privateFile(entry)) throw new DecisionLedgerError('Decision audit must be a private regular file within the size limit')
    // NONBLOCK also refuses a regular-file-to-FIFO swap without waiting on a writer.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!privateFile(info) || !unchangedFile(entry, info)) throw new DecisionLedgerError('Decision audit changed while opening')
      await this.checkDirectory(directory)
      const buffer = Buffer.alloc(MAX_DECISION_LEDGER_BYTES + 1)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset > MAX_DECISION_LEDGER_BYTES) throw new DecisionLedgerError('Decision audit exceeds the size limit')
      const final = await file.stat()
      const pathEntry = await lstat(path)
      await this.checkDirectory(directory)
      if (!privateFile(final) || !privateFile(pathEntry) || !unchangedFile(info, final) || !unchangedFile(final, pathEntry)) {
        throw new DecisionLedgerError('Decision audit changed while reading')
      }
      return { entry: final, bytes: buffer.subarray(0, offset) }
    } finally { await file.close() }
  }
  private async load(directory: Directory): Promise<Loaded> {
    const file = await this.readFile(directory)
    if (!file) return { records: [], file: undefined }
    let parsed: unknown
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)) }
    catch { throw new DecisionLedgerError('Decision audit is read-only: invalid JSON or UTF-8; original bytes were preserved') }
    const data = object(parsed, ['schemaVersion', 'records'])
    check(data.schemaVersion === 1, 'unsupported schema version')
    const records = array(data.records, MAX_DECISION_LEDGER_ROWS).map(validateDecisionLedgerRecord)
    const seen = new Set<string>()
    for (const record of records) { check(!seen.has(record.id), 'duplicate record UUID'); seen.add(record.id) }
    this.assertNoSecrets(records)
    return { records, file }
  }
  private recover(record: DecisionLedgerRecord, writing: boolean): DecisionLedgerRecord {
    if (record.state !== 'commit_started' || this.liveStarts.get(record.id) === record.snapshotDigest) return record
    return { ...record, state: 'unknown', reasonCode: 'commit_unknown',
      ...(writing ? { updatedAt: new Date(Math.max(Date.now(), Date.parse(record.updatedAt))).toISOString() } : {}) }
  }
  private async checkTarget(directory: Directory, expected: StoredFile | undefined): Promise<void> {
    await this.checkDirectory(directory)
    let current: Stats | undefined
    try { current = await lstat(join(this.directory, PRIMARY)) } catch (error) { if (!missing(error)) throw error }
    if ((current && !privateFile(current)) || (!!current !== !!expected) ||
      (current && expected && !unchangedFile(current, expected.entry))) {
      throw new DecisionLedgerError('Decision audit target changed during the operation; files were preserved')
    }
  }
  private async confirmDurability(directory: Directory): Promise<void> {
    if (process.platform === 'win32') return
    try {
      await this.checkDirectory(directory)
      await directory.handle!.sync()
      await this.checkDirectory(directory)
      this.pendingDurability = undefined
    } catch {
      this.pendingDurability = directory.entry
      throw new DecisionLedgerCommitError()
    }
  }
  private async replace(directory: Directory, bytes: Buffer, expected: StoredFile | undefined, beforeCommit: () => void): Promise<void> {
    check(bytes.length <= MAX_DECISION_LEDGER_BYTES, 'file exceeds byte limit')
    await this.checkTarget(directory, expected)
    const temporary = join(this.directory, `.decision-ledger.${randomUUID()}.tmp`)
    const file = await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    let temporaryEntry: Stats | undefined
    let committed = false
    try {
      temporaryEntry = await file.stat()
      if (!privateFile(temporaryEntry)) throw new DecisionLedgerError('Decision audit temporary file must be private and regular')
      await this.checkDirectory(directory)
      beforeCommit()
      await file.writeFile(bytes)
      await file.sync()
      const savedEntry = await file.stat()
      await file.close()
      await this.checkTarget(directory, expected)
      const currentTemporary = await lstat(temporary)
      if (!privateFile(savedEntry) || savedEntry.size !== bytes.length || !privateFile(currentTemporary) || !unchangedFile(savedEntry, currentTemporary)) {
        throw new DecisionLedgerError('Decision audit temporary file changed before commit')
      }
      beforeCommit()
      await rename(temporary, join(this.directory, PRIMARY))
      committed = true
      await this.confirmDurability(directory)
      const current = await lstat(join(this.directory, PRIMARY))
      await this.checkDirectory(directory)
      // Rename can update ctime, but must never alter file identity, length or data mtime.
      if (!privateFile(current) || !sameFile(current, savedEntry) || current.size !== savedEntry.size || current.mtimeMs !== savedEntry.mtimeMs) {
        throw new DecisionLedgerCommitError('Decision audit was saved, but its resulting identity could not be confirmed')
      }
      // A credential learned during rename must be exposed as a saved-but-unsafe audit failure.
      this.assertNoSecrets(new TextDecoder().decode(bytes))
    } catch (error) {
      if (committed && !(error instanceof DecisionLedgerCommitError)) throw new DecisionLedgerCommitError('Decision audit was saved, but its final safety and durability could not be confirmed')
      throw error
    } finally {
      await file.close().catch(() => undefined)
      // Never unlink a substituted temporary file or a path in a replacement directory.
      try {
        await this.checkDirectory(directory)
        const current = await lstat(temporary)
        if (temporaryEntry && sameFile(current, temporaryEntry) && privateFile(current)) await unlink(temporary)
      } catch (error) {
        if (!missing(error) && committed) throw new DecisionLedgerCommitError('Decision audit was saved, but temporary-file cleanup could not be confirmed')
      }
    }
  }
  private async acquire(directory: Directory, signal?: AbortSignal): Promise<() => Promise<void>> {
    const path = join(this.directory, LOCK)
    const deadline = Date.now() + DECISION_LEDGER_LOCK_WAIT_MS
    let file: FileHandle
    while (true) {
      signal?.throwIfAborted()
      await this.checkDirectory(directory)
      try {
        file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
        break
      } catch (error) {
        if (!exists(error)) throw error
        const current = await lstat(path).catch((failure: unknown) => { if (missing(failure)) return undefined; throw failure })
        if (current && !privateFile(current, 4096)) throw new DecisionLedgerError('Decision audit lease must be a private regular file')
        if (Date.now() >= deadline) throw new DecisionLedgerError('Decision audit is locked by another CLI process. Retry later; after a crash, verify its owner has stopped before removing decision-ledger.json.lock. Locks are never stolen automatically')
        await new Promise<void>((done, reject) => {
          const finish = (): void => { signal?.removeEventListener('abort', abort); done() }
          const timer = setTimeout(finish, LOCK_RETRY_MS)
          const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason) }
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
        })
      }
    }
    let entry: Stats | undefined
    let released = false
    const release = async (): Promise<void> => {
      if (released) return
      await this.checkDirectory(directory)
      const current = await lstat(path)
      if (!entry || !privateFile(current, 4096) || !unchangedFile(entry, current)) throw new DecisionLedgerError('Decision audit lease changed; the replacement was preserved')
      await unlink(path)
      released = true
    }
    try {
      const opened = await file.stat()
      if (!privateFile(opened, 4096)) throw new DecisionLedgerError('Decision audit lease must be a private regular file')
      entry = opened
      await this.checkDirectory(directory)
      await file.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }), 'utf8')
      await file.sync()
      entry = await file.stat()
      await file.close()
      await this.checkDirectory(directory)
      const current = await lstat(path)
      if (!privateFile(current, 4096) || !unchangedFile(entry, current)) throw new DecisionLedgerError('Decision audit lease changed while opening')
    } catch (error) {
      // Closing and cleanup are identity guarded, even if initialization failed.
      if (entry) entry = await file.stat().catch(() => entry)
      await file.close().catch(() => undefined)
      await release().catch(() => undefined)
      throw error
    }
    return release
  }
  private enqueue<T>(signal: AbortSignal | undefined, writing: boolean, action: (directory: Directory | undefined) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new DecisionLedgerError('Decision audit is closing; no new operations are accepted'))
    const job = this.chain.then(async () => {
      signal?.throwIfAborted()
      const directory = await this.directoryHandle(writing)
      if (!directory) return action(undefined)
      let release: (() => Promise<void>) | undefined
      let actionFailed = false
      try {
        if (writing) release = await this.acquire(directory, signal)
        signal?.throwIfAborted()
        if (writing && this.pendingDurability) {
          if (!sameFile(this.pendingDurability, directory.entry)) throw new DecisionLedgerCommitError('Decision audit directory changed while a saved audit had uncertain durability')
          await this.confirmDurability(directory)
        }
        return await action(directory)
      } catch (error) { actionFailed = true; throw error }
      finally {
        let cleanupFailure: unknown
        if (release) { try { await release() } catch (error) { cleanupFailure = error } }
        try { await directory.handle?.close() } catch (error) { cleanupFailure ??= error }
        if (cleanupFailure && !actionFailed) {
          if (writing) throw new DecisionLedgerCommitError('Decision audit was saved, but lease or directory cleanup could not be confirmed')
          throw new DecisionLedgerError('Decision audit operation finished, but directory cleanup could not be confirmed')
        }
      }
    }).catch((error: unknown) => { throw this.safeError(error) })
    this.jobs.add(job)
    this.chain = job.catch(() => undefined)
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job))
    return job
  }
  /** Informational projection only. No stored row can authorize an action. */
  list(signal?: AbortSignal): Promise<readonly DecisionLedgerRecord[]> {
    return this.enqueue(signal, false, async directory => {
      if (!directory) return []
      const loaded = await this.load(directory)
      signal?.throwIfAborted()
      return loaded.records.map(record => structuredClone(this.recover(record, false)))
    })
  }
  upsert(input: DecisionLedgerRecord, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    let captured: DecisionLedgerRecord
    try { captured = validateDecisionLedgerRecord(input); this.assertNoSecrets(captured) }
    catch (error) { return Promise.reject(this.safeError(error)) }
    return this.enqueue(options.signal, true, async directory => {
      if (!directory) throw new DecisionLedgerError('Decision audit directory is missing')
      const loaded = await this.load(directory)
      const previous = loaded.records.find(record => record.id === captured.id)
      if (previous) {
        check(identityFields.every(field => previous[field] === captured[field]), 'record identity cannot change')
        check(captured.updatedAt >= previous.updatedAt, 'record timestamp cannot move backwards')
        // Interrupted outcomes are facts to reconcile, never grants to retry a mutation.
        if (this.recover(previous, false).state === 'unknown') {
          check(captured.state !== 'reviewed' && captured.state !== 'commit_started', 'unknown outcome cannot become an approval')
        }
        if (['committed', 'denied', 'cancelled', 'failed'].includes(previous.state)) {
          check(captured.state === previous.state, 'terminal outcome cannot become an approval')
        }
      }
      let records = loaded.records.filter(record => record.id !== captured.id).map(record => this.recover(record, true))
      records.push(captured)
      let bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, records })}\n`, 'utf8')
      // Retain the most recently updated rows, always including the newly admitted row.
      while (records.length > MAX_DECISION_LEDGER_ROWS || bytes.length > MAX_DECISION_LEDGER_BYTES) {
        check(records.length > 1, 'record exceeds byte limit')
        records = records.slice(1)
        bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, records })}\n`, 'utf8')
      }
      this.assertNoSecrets(records)
      await this.replace(directory, bytes, loaded.file, () => { options.signal?.throwIfAborted(); this.assertNoSecrets(records) })
      this.failure = undefined
      if (captured.state === 'commit_started') this.liveStarts.set(captured.id, captured.snapshotDigest)
      else this.liveStarts.delete(captured.id)
      const retained = new Set(records.map(record => record.id))
      for (const id of this.liveStarts.keys()) if (!retained.has(id)) this.liveStarts.delete(id)
    })
  }
  append(record: DecisionLedgerRecord, options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    return this.upsert(record, options)
  }
  /** Wait for admitted writes, and retry only fsync, never any reviewed action or data write. */
  async drain(options: { readonly close?: boolean } = {}): Promise<void> {
    if (options.close) this.closed = true
    while (this.jobs.size) await Promise.allSettled([...this.jobs])
    if (!this.pendingDurability) return
    const pendingDurability = this.pendingDurability
    let directory: Directory | undefined
    let release: (() => Promise<void>) | undefined
    try {
      directory = await this.directoryHandle(false)
      if (!directory || !sameFile(pendingDurability, directory.entry)) throw new DecisionLedgerCommitError('Decision audit directory changed while durability was pending')
      release = await this.acquire(directory)
      await this.confirmDurability(directory)
      this.failure = undefined
    } catch (error) { throw this.safeError(error) }
    finally {
      try { if (release) await release() }
      catch (error) { throw this.safeError(error) }
      finally {
        try { await directory?.handle?.close() }
        catch (error) { throw this.safeError(error) }
      }
    }
  }
}
