// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { HistoryMessage, Usage } from '@ayayaq/vivi'
import { closeInterruptedHistory } from '@ayayaq/vivi'
import { validSessionTitle } from './session-display.js'
import { FileMcpOutcomeStore, reconcileMcpOutcomes } from './mcp-outcomes.js'

export const MAX_SESSION_BYTES = 2 * 1024 * 1024
export const MAX_HISTORY_MESSAGES = 2000
export type CliProviderName = 'openai' | 'openrouter'
export interface CliSession {
  schemaVersion: 1 | 2
  /** Schema-2 points to an existing shadow anchor; it grants no replay/send authority. */
  recordAnchor?: { version: 1; eventId: string }
  id: string
  provider: CliProviderName
  model: string
  reasoning?: string
  createdAt: string
  updatedAt: string
  /** Optional schema-1 metadata; legacy sessions derive a title only for display. */
  title?: string
  titleRevision?: number
  history: HistoryMessage[]
  /** Cache subsets are optional complete-session totals; omission means unreported. */
  usage: Usage
  noteRevision: number
  notes: Record<string, string>
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[REDACTED]')
  }
  return text
}

/** Only secret-valued environment variables are inspected, never persisted or sent to models. */
export function environmentSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    /(?:API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)$/i.test(name) && value ? [value] : [])
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid session: ${message}`)
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  check(Object.keys(value).every((key) => allowed.includes(key)), 'unexpected field')
}
function text(value: unknown, limit = 64 * 1024): value is string {
  return typeof value === 'string' && value.length <= limit
}
function identifier(value: unknown): value is string {
  return text(value, 200) && value.length > 0 && value.trim() === value
}
function json(value: unknown, depth = 0, budget = { remaining: 100000 }): void {
  check(--budget.remaining >= 0 && depth <= 40, 'JSON data exceeds complexity limit')
  if (value === null || typeof value === 'boolean' || text(value)) return
  if (typeof value === 'number') { check(Number.isFinite(value), 'nonfinite number'); return }
  check(Array.isArray(value) || object(value), 'expected JSON data')
  check(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    'JSON objects must be plain')
  check(Object.getOwnPropertySymbols(value).length === 0, 'JSON data must not contain symbols')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Array.isArray(value)) {
    check(value.length <= 100000, 'JSON array exceeds complexity limit')
    for (let index = 0; index < value.length; index++) check(Object.hasOwn(descriptors, String(index)), 'sparse JSON array')
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue
    check(descriptor.enumerable && 'value' in descriptor, 'JSON properties must be enumerable data')
    if (Array.isArray(value)) check(/^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length, 'invalid array property')
    json(descriptor.value, depth + 1, budget)
  }
}

/** Validate parsed JSON before any provider or tool sees it; a pending suffix is recoverable. */
export function validateSession(value: unknown): CliSession {
  json(value)
  check(object(value), 'expected object')
  keys(value, ['schemaVersion', 'id', 'provider', 'model', 'reasoning', 'createdAt', 'updatedAt',
    'history', 'usage', 'noteRevision', 'notes', 'title', 'titleRevision', 'recordAnchor'])
  check(value.schemaVersion === 1 || value.schemaVersion === 2, 'unsupported schema version')
  if (value.schemaVersion === 1) check(!('recordAnchor' in value), 'schema-1 must not contain a record anchor')
  else {
    check(object(value.recordAnchor), 'schema-2 requires a record anchor')
    keys(value.recordAnchor, ['version', 'eventId'])
    check(value.recordAnchor.version === 1 && identifier(value.recordAnchor.eventId), 'invalid record anchor')
  }
  check(isSessionId(value.id), 'invalid id')
  check(value.provider === 'openai' || value.provider === 'openrouter', 'unsupported provider')
  check(identifier(value.model), 'invalid model')
  if ('title' in value) check(typeof value.title === 'string' && validSessionTitle(value.title), 'invalid title')
  if ('titleRevision' in value) check('title' in value && Number.isSafeInteger(value.titleRevision) &&
    Number(value.titleRevision) >= 0, 'invalid title revision')
  if ('reasoning' in value) check(typeof value.reasoning === 'string' &&
    ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.reasoning), 'invalid reasoning')
  for (const field of ['createdAt', 'updatedAt']) {
    check(text(value[field], 40) && /^\d{4}-\d\d-\d\dT/.test(value[field]) &&
      Number.isFinite(Date.parse(value[field])), 'invalid timestamp')
  }
  check(object(value.usage), 'invalid usage')
  const usage = value.usage
  keys(usage, ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteInputTokens'])
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens',
    ...['cachedInputTokens', 'cacheWriteInputTokens'].filter((field) => field in usage)]) {
    check(Number.isSafeInteger(usage[field]) && Number(usage[field]) >= 0, 'invalid usage')
  }
  check(Number.isSafeInteger(value.noteRevision) && Number(value.noteRevision) >= 0, 'invalid note revision')
  check(object(value.notes) && Object.keys(value.notes).length <= 64, 'invalid notes')
  for (const [key, note] of Object.entries(value.notes)) {
    check(/^[a-zA-Z0-9_-]{1,40}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key) &&
      text(note, 4096), 'invalid note')
  }
  check(Array.isArray(value.history) && value.history.length <= MAX_HISTORY_MESSAGES, 'history is too large')
  const ids = new Set<string>()
  let pending: { id: string; name: string }[] = []
  for (const message of value.history) {
    check(object(message) && text(message.content), 'invalid history message')
    if (message.kind === 'tool_result') {
      keys(message, ['kind', 'callId', 'name', 'content', 'isError'])
      const next = pending.shift()
      check(next && message.callId === next.id && message.name === next.name, 'unmatched tool result')
      if ('isError' in message) check(typeof message.isError === 'boolean', 'invalid tool result')
      continue
    }
    check(pending.length === 0, 'interleaved pending tool calls')
    if (message.kind === 'message') {
      keys(message, ['kind', 'role', 'content'])
      check(message.role === 'user' || message.role === 'system', 'invalid role')
    } else {
      check(message.kind === 'assistant', 'invalid history kind')
      keys(message, ['kind', 'content', 'toolCalls', 'providerState'])
      check(Array.isArray(message.toolCalls) && message.toolCalls.length <= 128, 'invalid tool calls')
      for (const call of message.toolCalls) {
        check(object(call), 'invalid call')
        keys(call, ['id', 'name', 'arguments'])
        check(identifier(call.id) && identifier(call.name) && object(call.arguments), 'invalid call')
        check(!ids.has(call.id), 'duplicate call id')
        ids.add(call.id)
        pending.push({ id: call.id, name: call.name })
      }
      if ('providerState' in message) {
        check(object(message.providerState), 'invalid provider state')
        keys(message.providerState, ['provider', 'items'])
        check(identifier(message.providerState.provider) && Array.isArray(message.providerState.items),
          'invalid provider state')
      }
    }
  }
  return structuredClone(value) as unknown as CliSession
}

export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}
export function newSession(settings: { provider: CliProviderName; model: string; reasoning?: string }): CliSession {
  const now = new Date().toISOString()
  return validateSession({ schemaVersion: 1, id: randomUUID(), ...settings, createdAt: now, updatedAt: now,
    history: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, noteRevision: 0, notes: {} })
}

export interface SessionPersistence {
  load(id: string): Promise<CliSession>
  /** A supplied guard must be repeated after queued/awaited I/O at the actual replacement boundary. */
  save(session: CliSession, options?: { readonly signal?: AbortSignal; readonly assertCurrent?: () => void }): Promise<void>
}

/** The atomic replacement succeeded; only its durability confirmation failed. */
export class SessionCommitError extends Error {
  constructor(cause: unknown) {
    super('Session was saved, but durable persistence could not be confirmed', { cause })
    this.name = 'SessionCommitError'
  }
}

/** Host-owned session files only. No arbitrary paths or model-controlled filenames. */
export class FileSessionStore implements SessionPersistence {
  readonly directory: string
  constructor(directory: string, private readonly secrets: readonly string[] = []) {
    this.directory = resolve(directory)
  }
  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Session directory must be a real directory')
    if (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) {
      throw new Error('Session directory must be owned by you with permissions 0700')
    }
  }
  private path(id: string): string {
    if (!isSessionId(id)) throw new Error('Invalid session id; expected a session UUID')
    return join(this.directory, `${id}.json`)
  }
  /** Exclusive host lease prevents concurrent CLI processes overwriting a resumed session. */
  async acquire(id: string): Promise<() => Promise<void>> {
    await this.prepare()
    const path = `${this.path(id)}.lock`
    let file
    try {
      file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new Error('Session is locked by another CLI process. After a crash, verify that process has stopped before removing its .json.lock file')
      }
      throw error
    }
    try { await file.writeFile(JSON.stringify({ pid: process.pid }), 'utf8') }
    catch (error) { await unlink(path).catch(() => undefined); throw error }
    finally { await file.close() }
    let released = false
    return async () => {
      if (released) return
      released = true
      await unlink(path)
    }
  }
  async load(id: string): Promise<CliSession> {
    await this.prepare()
    const path = this.path(id)
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Session must be a private regular file within the size limit')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino || info.size > MAX_SESSION_BYTES ||
        (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
        throw new Error('Session must be a private regular file within the size limit')
      }
      // Read at most the limit even if a file grows after stat.
      const buffer = Buffer.alloc(MAX_SESSION_BYTES + 1)
      let offset = 0
      while (offset < buffer.length) {
        const read = await file.read(buffer, offset, buffer.length - offset, null)
        if (read.bytesRead === 0) break
        offset += read.bytesRead
      }
      if (offset > MAX_SESSION_BYTES) throw new Error('Session exceeds the size limit')
      let parsed: unknown
      try { parsed = JSON.parse(buffer.subarray(0, offset).toString('utf8')) }
      catch { throw new Error('Session is not valid JSON') }
      const session = validateSession(parsed)
      if (session.id !== id) throw new Error('Session id does not match its filename')
      session.history = reconcileMcpOutcomes(closeInterruptedHistory(session.history), id,
        await new FileMcpOutcomeStore(this.directory, this.secrets).load(id))
      validateSession(session)
      return session
    } finally { await file.close() }
  }
  async save(input: CliSession, options: { readonly signal?: AbortSignal; readonly assertCurrent?: () => void } = {}): Promise<void> {
    const assertCurrent = (): void => { options.signal?.throwIfAborted(); options.assertCurrent?.() }
    assertCurrent()
    const session = validateSession(input)
    const encoded = JSON.stringify(session)
    // Replace JSON-escaped values too; no credential value can survive in opaque state or errors.
    const encodedSecrets = this.secrets.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])
    const safe = redactSecrets(encoded, encodedSecrets)
    const persisted = validateSession(JSON.parse(safe) as unknown)
    // A crash can occur before any pending tool finishes. Reserve the exact mandatory
    // recovery results now, while preserving the pending checkpoint we actually save.
    const recovery = { ...persisted, history: closeInterruptedHistory(persisted.history) }
    if (recovery.history.length > MAX_HISTORY_MESSAGES) {
      throw new Error('Session history limit includes mandatory pending recovery results')
    }
    validateSession(recovery)
    const safeRecovery = redactSecrets(JSON.stringify(recovery), encodedSecrets)
    validateSession(JSON.parse(safeRecovery) as unknown)
    const recoveryBytes = Buffer.byteLength(safeRecovery) + 1
    if (Buffer.byteLength(safe) + 1 > MAX_SESSION_BYTES || recoveryBytes > MAX_SESSION_BYTES) {
      throw new Error('Session size limit includes mandatory pending recovery results')
    }
    await this.prepare()
    assertCurrent()
    const target = this.path(session.id)
    try {
      const info = await lstat(target)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Refusing to replace a nonregular session file')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const temporary = join(this.directory, `.${session.id}.${randomUUID()}.tmp`)
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let committed = false
    try {
      await file.writeFile(`${safe}\n`, 'utf8')
      assertCurrent()
      await file.sync()
      assertCurrent()
      await file.close()
      // Recheck immediately before the actual resource replacement, after all awaited I/O.
      assertCurrent()
      await rename(temporary, target)
      committed = true
      // Ensure rename is durable where directory fsync is supported.
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, constants.O_RDONLY)
        try { await directory.sync() } finally { await directory.close() }
      }
    } catch (error) {
      if (committed) throw new SessionCommitError(error)
      throw error
    } finally {
      await file.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  }
}
