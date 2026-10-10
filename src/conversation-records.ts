// SPDX-License-Identifier: Apache-2.0
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { closeInterruptedHistory } from '@ayayaq/vivi'
import type { AgentAcceptedUpdate, AgentResult, HistoryMessage, ProviderResult } from '@ayayaq/vivi'
import { AGENT_RECORD_LIMITS, agentArgumentsDigest, agentEvidenceDigest, applyAgentRecord,
  createAgentProjection, createRunSettlement, decodeAgentRecord } from '@ayayaq/vivi/events'
import type { AgentHistoryEntry, AgentOutcomeEvidence, AgentProjection, DurableAgentRecord } from '@ayayaq/vivi/events'
import { AGENT_RUN_RECORD_LIMITS, applyAgentRunRecord, assertAgentRunCurrent, createAgentAcceptedRecord,
  createAgentRunProjection, createAgentRunStart, createAgentRunTerminal } from '@ayayaq/vivi/events/stream'
import type { AgentRunProjection, AgentRunRecord } from '@ayayaq/vivi/events/stream'
import { isSessionId, validateSession, MAX_HISTORY_MESSAGES } from './session.js'
import type { CliSession } from './session.js'
import { assertMcpJson } from '@ayayaq/vivi/extensions/mcp'
import { mcpOutcomeMatchesCall } from './mcp-outcomes.js'
import type { McpOutcomeRecord } from './mcp-outcomes.js'

/** Complete-chain shadow storage. Canonical sessions and exact MCP receipts remain authoritative. */
export const CLI_CONVERSATION_LIMITS = Object.freeze({ bytes: 64 * 1024 * 1024,
  activeHistoryBytes: 384 * 1024, terminalReserveBytes: 3 * 1024 * 1024 })
export interface CliConversationDocument {
  readonly schemaVersion: 1
  readonly sessionId: string
  /** Screened original import, including titles, notes, IDs and aggregate usage. */
  readonly legacy: CliSession
  readonly records: readonly DurableAgentRecord[]
  readonly runs: readonly { readonly runId: string; readonly records: readonly AgentRunRecord[] }[]
}
export interface CliConversationQuarantine {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly state: 'quarantined'
  readonly previousDigest: string | null
}
export type CliConversationStored = CliConversationDocument | CliConversationQuarantine
export interface CliConversationStore {
  read(sessionId: string): Promise<{ readonly value: unknown; readonly digest: string } | undefined>
  /** The host serializes operations and supplies an exact stored-byte lease. */
  write(sessionId: string, value: CliConversationStored, expectedDigest: string | null,
    assertCurrent: () => void): Promise<string>
}
export interface CliConversationView {
  readonly state: 'shadow' | 'unavailable' | 'quarantined'
  readonly observedSequence: number
  /** This is a host storage acknowledgement, distinct from a core projection cursor. */
  readonly committedSequence: number
  readonly durability: 'memory' | 'disk'
  readonly committedRuns?: readonly { readonly runId: string; readonly sequence: number; readonly eventId: string | null }[]
  readonly projection?: AgentProjection
  readonly runs?: readonly AgentRunProjection[]
}
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
const hashBytes = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const hash = (value: unknown): string => hashBytes(JSON.stringify(value))
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const object = (value: unknown): value is Record<string, unknown> => value !== null &&
  typeof value === 'object' && !Array.isArray(value)
const keys = (value: Record<string, unknown>, names: readonly string[]): void => {
  if (Object.keys(value).length !== names.length || !names.every(name => Object.hasOwn(value, name))) throw new Error('Invalid conversation envelope')
}
function containsSecret(value: unknown, secrets: readonly string[]): boolean {
  const serialized = JSON.stringify(value)
  return secrets.some(secret => secret && (serialized.includes(secret) || serialized.includes(JSON.stringify(secret).slice(1, -1))))
}
function entries(session: CliSession, previous: readonly AgentHistoryEntry[] = []): AgentHistoryEntry[] {
  return session.history.map((message, index) => {
    const old = previous[index]
    if (old && same(old.message, message)) return old
    return { id: old?.id ?? `cli-history:${index}`, source: {
      reference: old?.source.reference ?? `cli-session:${session.id}:history:${index}`,
      revision: hash(message) }, message: message as AgentHistoryEntry['message'] }
  })
}

/** Effects are supplied only by exact host ledger rows, never parsed from arbitrary tools. */
export function cliMcpRecordEvidence(session: CliSession, rows: readonly McpOutcomeRecord[],
  previous: readonly AgentOutcomeEvidence[] = []): AgentOutcomeEvidence[] {
  const output = [...previous]
  for (const message of session.history) {
    if (message.kind !== 'assistant') continue
    for (const call of message.toolCalls) {
      const row = rows.find(item => mcpOutcomeMatchesCall(item, call))
      if (!row) continue
      const old = output.find(item => item.callId === call.id)
      let status: AgentOutcomeEvidence['status'] = 'unknown', effect: AgentOutcomeEvidence['effect'] = 'unknown'
      if (row.state === 'accepted') { status = 'cancelled'; effect = 'not_attempted' }
      if (row.state === 'settled' && row.result) {
        let body: Record<string, unknown> = {}
        try { const value: unknown = JSON.parse(row.result.content); if (object(value)) body = value } catch { /* No effect inferred. */ }
        if (body.requestSent === false && body.unknownOutcome !== true) {
          effect = 'not_attempted'; status = body.success === true ? 'unknown' : 'denied'
        } else if (body.unknownOutcome !== true && (body.confirmedOutcome === true ||
          body.source === 'mcp' && typeof body.success === 'boolean' && Array.isArray(body.content))) {
          effect = 'confirmed'; status = body.success === true && !row.result.isError ? 'succeeded' : 'failed'
        }
      }
      const evidence: AgentOutcomeEvidence = { callId: call.id, runId: row.runId, name: call.name,
        argumentsDigest: agentArgumentsDigest(call.arguments), status, effect,
        source: { reference: `cli-mcp-outcome:${row.id}`, revision: hash(row) } }
      if (old) {
        if (same(old, evidence) || old.effect === 'confirmed' || old.effect === 'not_attempted') continue
        const refined = { ...evidence, source: { ...evidence.source, reference: old.source.reference },
          supersedes: agentEvidenceDigest(old) }
        output[output.indexOf(old)] = refined
      } else output.push(evidence)
    }
  }
  return output
}

export function replayCliConversationDocument(value: unknown): { document: CliConversationDocument;
  projection: AgentProjection; runs: readonly AgentRunProjection[] } {
  assertMcpJson(value, CLI_CONVERSATION_LIMITS.bytes, { nodes: 8 * 1024 * 1024, depth: 40 })
  if (!object(value)) throw new Error('Invalid conversation envelope')
  keys(value, ['schemaVersion', 'sessionId', 'legacy', 'records', 'runs'])
  if (value.schemaVersion !== 1 || !isSessionId(value.sessionId) || bytes(value) > CLI_CONVERSATION_LIMITS.bytes) throw new Error('Unsupported or oversized conversation envelope')
  const legacy = validateSession(value.legacy)
  if (legacy.id !== value.sessionId || !Array.isArray(value.records) || value.records.length === 0 ||
    value.records.length > AGENT_RECORD_LIMITS.records || !Array.isArray(value.runs) || value.runs.length > AGENT_RECORD_LIMITS.records) throw new Error('Invalid conversation chains')
  let projection = createAgentProjection(value.sessionId)
  const anchors = new Map<number, AgentProjection>([[0, projection]])
  const records = value.records.map(record => decodeAgentRecord(record))
  if (records[0]?.type !== 'session_snapshot' || records[0].reason !== 'legacy_import' ||
    !same(records[0].snapshot.history.map(item => item.message), legacy.history) || !same(records[0].snapshot.usage, legacy.usage)) throw new Error('Legacy anchor mismatch')
  for (const record of records) { projection = applyAgentRecord(projection, record); anchors.set(projection.sequence, projection) }
  const ids = new Set<string>(), runs: AgentRunProjection[] = []
  for (const run of value.runs) {
    if (!object(run)) throw new Error('Invalid retained run')
    keys(run, ['runId', 'records'])
    if (typeof run.runId !== 'string' || ids.has(run.runId) || !Array.isArray(run.records) || run.records.length === 0 || run.records.length > AGENT_RUN_RECORD_LIMITS.records) throw new Error('Invalid retained run')
    ids.add(run.runId)
    const start = run.records[0]
    if (!object(start) || start.type !== 'run_started' || typeof start.baseSequence !== 'number') throw new Error('Missing run prefix')
    const base = anchors.get(start.baseSequence)
    if (!base) throw new Error('Missing session prefix')
    let replay = createAgentRunProjection(base, run.runId)
    for (const record of run.records) replay = applyAgentRunRecord(replay, record)
    if (replay.state === 'settled') {
      const terminal = projection.receipts.find(item => item.eventId === replay.session.eventId)
      if (!terminal || terminal.digest !== replay.session.receipts.at(-1)?.digest) throw new Error('Uncommitted run terminal')
    }
    runs.push(replay)
  }
  if (projection.runs.some(run => !runs.some(item => item.runId === run.runId && item.state === 'settled'))) throw new Error('Missing terminal run chain')
  return { document: structuredClone(value) as unknown as CliConversationDocument, projection, runs }
}

/** One serialized host owner; replay is data only and never restores an approval or executor. */
export class CliConversationRecords {
  private document: CliConversationDocument | undefined
  private projection: AgentProjection
  private runs: readonly AgentRunProjection[] = []
  private digest: string | null = null
  private committed = 0
  private state: CliConversationView['state'] = 'shadow'
  private tail: Promise<void> = Promise.resolve()
  private quarantineComplete = false
  constructor(private readonly sessionId: string, private readonly store?: CliConversationStore,
    private readonly secrets: readonly string[] = [], private readonly notice?: (message: string) => void) {
    this.projection = createAgentProjection(sessionId)
  }
  get anchorEventId(): string | undefined { return this.state === 'shadow' ? this.document?.records[0]?.eventId : undefined }
  get view(): CliConversationView {
    if (this.document && containsSecret(this.document, this.secrets)) {
      this.state = 'quarantined'
      void this.enqueue(() => this.quarantine()).catch(() => undefined)
    }
    return { state: this.state, durability: this.store ? 'disk' : 'memory',
      observedSequence: this.projection.sequence, committedSequence: this.committed,
      ...(this.state === 'shadow' && this.store && this.document ? { committedRuns: this.document.runs.map(run => ({ runId: run.runId,
        sequence: run.records.at(-1)?.sequence ?? 0, eventId: run.records.at(-1)?.eventId ?? null })) } : {}),
      ...(this.state === 'shadow' ? { projection: structuredClone(this.projection), runs: structuredClone(this.runs) } : {}) }
  }
  async drain(): Promise<void> { await this.tail }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.state !== 'shadow') { if (this.state === 'quarantined') await this.quarantine(); return }
      try { await work() }
      catch {
        if ((this.state as CliConversationView['state']) !== 'quarantined') this.state = 'unavailable'
        try { this.notice?.('Conversation record shadow stopped; canonical session history and exact MCP outcome recovery remain available') } catch { /* No authority. */ }
      }
    })
    this.tail = operation.catch(() => undefined)
    return operation
  }
  private async quarantine(): Promise<void> {
    this.state = 'quarantined'
    if (this.quarantineComplete) return
    try { this.notice?.('Conversation record shadow quarantined; canonical session and exact MCP receipts remain authoritative') } catch { /* Data-only notice. */ }
    if (!this.store) { this.document = undefined; this.runs = []; this.quarantineComplete = true; return }
    const current = await this.store.read(this.sessionId)
    const tombstone: CliConversationQuarantine = { schemaVersion: 1, sessionId: this.sessionId,
      state: 'quarantined', previousDigest: current?.digest ?? this.digest }
    this.digest = await this.store.write(this.sessionId, tombstone, current?.digest ?? null, () => {})
    this.document = undefined; this.runs = []; this.quarantineComplete = true
  }
  private async commit(next: CliConversationDocument): Promise<void> {
    const assertCurrent = (): void => {
      if (containsSecret(next, this.secrets)) throw new Error('Conversation privacy rejection')
    }
    if (containsSecret(next, this.secrets)) { await this.quarantine(); throw new Error('Conversation privacy rejection') }
    try {
      replayCliConversationDocument(next)
      if (this.store) {
        try { this.digest = await this.store.write(this.sessionId, next, this.digest, assertCurrent) }
        catch (error) {
          // Ambiguous append is acknowledged only after exact identity/byte readback.
          if (error instanceof CliConversationCommitError) throw error
          const stored = await this.store.read(this.sessionId)
          if (!stored || !same(stored.value, next)) {
            if ((stored?.digest ?? null) !== this.digest) await this.quarantine()
            throw error
          }
          assertCurrent(); replayCliConversationDocument(stored.value); this.digest = stored.digest
        }
        assertCurrent(); this.committed = this.projection.sequence
      }
    } catch (error) {
      if (containsSecret(next, this.secrets)) await this.quarantine()
      throw error
    }
    this.document = next
  }
  initialize(session: CliSession, rows: readonly McpOutcomeRecord[]): Promise<void> {
    return this.enqueue(async () => {
      if (this.document) return
      const stored = await this.store?.read(this.sessionId)
      if (!stored && session.recordAnchor) { await this.quarantine(); return }
      if (stored) {
        this.digest = stored.digest
        try { assertMcpJson(stored.value, CLI_CONVERSATION_LIMITS.bytes, { nodes: 8 * 1024 * 1024, depth: 40 }) }
        catch { await this.quarantine(); return }
        if (object(stored.value) && stored.value.state === 'quarantined') { this.state = 'quarantined'; this.quarantineComplete = true; return }
        if (containsSecret(stored.value, this.secrets)) { await this.quarantine(); return }
        let restored
        try { restored = replayCliConversationDocument(stored.value) } catch { await this.quarantine(); return }
        if (restored.document.sessionId !== this.sessionId || session.recordAnchor &&
          session.recordAnchor.eventId !== restored.document.records[0]?.eventId) { await this.quarantine(); return }
        this.document = restored.document; this.projection = restored.projection; this.runs = restored.runs; this.committed = this.projection.sequence
        if (!same(this.projection.history.map(item => item.message), session.history) || !same(this.projection.usage, session.usage)) {
          // Existing canonical recovery owns closure and usage. An exact current incomplete
          // run can retain that committed recovery as data, without inventing a settlement.
          const pending = this.runs.filter(run => run.state === 'running' && run.baseSequence === this.projection.sequence).at(-1)
          if (!pending || !same(pending.history.map(item => item.message), session.history.slice(0, pending.history.length)) ||
            session.history.length < pending.history.length) { await this.quarantine(); return }
          const record = decodeAgentRecord({ ...this.envelope(), type: 'session_snapshot', reason: 'reconciliation',
            snapshot: { history: entries(session, pending.history), usage: session.usage,
              outcomes: cliMcpRecordEvidence(session, rows, this.projection.outcomes) } })
          this.projection = applyAgentRecord(this.projection, record)
          await this.commit({ ...this.document, records: [...this.document.records, record] })
        }
        return
      }
      const legacy = validateSession(session)
      const record = decodeAgentRecord({ ...this.envelope(), type: 'session_snapshot', reason: 'legacy_import',
        snapshot: { history: entries(legacy), usage: legacy.usage, outcomes: cliMcpRecordEvidence(legacy, rows) } })
      this.projection = applyAgentRecord(this.projection, record)
      await this.commit({ schemaVersion: 1, sessionId: this.sessionId, legacy, records: [record], runs: [] })
    })
  }
  private envelope(): { version: 1; sessionId: string; eventId: string; sequence: number; previousEventId: string | null; source: { reference: string } } {
    return { version: 1, sessionId: this.sessionId, eventId: randomUUID(), sequence: this.projection.sequence + 1,
      previousEventId: this.projection.eventId, source: { reference: `cli-session:${this.sessionId}:records` } }
  }
  private runEnvelope(run: AgentRunProjection): { version: 1; scope: 'run'; sessionId: string; runId: string; eventId: string; sequence: number; previousEventId: string | null; source: { reference: string } } {
    return { version: 1, scope: 'run', sessionId: this.sessionId, runId: run.runId, eventId: randomUUID(),
      sequence: run.sequence + 1, previousEventId: run.eventId, source: { reference: `cli-run:${run.runId}` } }
  }
  private async assertStoredCurrent(): Promise<void> {
    if (!this.store) return
    const current = await this.store.read(this.sessionId)
    if (!current || current.digest !== this.digest) { await this.quarantine(); throw new Error('Stored conversation cursor changed') }
    try { replayCliConversationDocument(current.value) } catch { await this.quarantine(); throw new Error('Stored conversation prefix changed') }
    if (containsSecret(current.value, this.secrets)) { await this.quarantine(); throw new Error('Stored conversation privacy changed') }
  }
  begin(runId: string, session: CliSession): Promise<void> {
    return this.enqueue(async () => {
      if (!this.document) throw new Error('Missing conversation anchor')
      if (this.projection.sequence >= AGENT_RECORD_LIMITS.records) throw new Error('Final session record slot exhausted')
      await this.assertStoredCurrent()
      const input = entries(session, this.projection.history)
      if (!same(input.slice(0, this.projection.history.length), this.projection.history) ||
        input.length !== this.projection.history.length + 1 || input.at(-1)?.message.kind !== 'message') throw new Error('Canonical run prefix changed')
      const run = createAgentRunProjection(this.projection, runId)
      const start = createAgentRunStart(this.runEnvelope(run), this.projection, input.slice(this.projection.history.length))
      const next = applyAgentRunRecord(run, start)
      this.runs = [...this.runs, next]
      await this.commit({ ...this.document, runs: [...this.document.runs, { runId, records: [start] }] })
    })
  }
  /** A separate final-envelope budget, before provider output can advertise effects. */
  assertOutput(output: ProviderResult, history: readonly HistoryMessage[]): void {
    if (this.state !== 'shadow') return
    const closed = closeInterruptedHistory([...history, { kind: 'assistant', content: output.content, toolCalls: output.toolCalls,
      ...(output.providerState ? { providerState: output.providerState } : {}) }])
    // Keep the canonical store's established history-overflow recovery/error path.
    // The shadow budget only narrows output that canonical storage could admit.
    if (closed.length > MAX_HISTORY_MESSAGES) return
    const safeEntries = closed.map((message, index) => ({ id: `cli-history:${index}`,
      source: { reference: `cli-session:${this.sessionId}:history:${index}`, revision: hash(message) }, message }))
    if (bytes(safeEntries) > CLI_CONVERSATION_LIMITS.activeHistoryBytes ||
      bytes(safeEntries) + Buffer.byteLength(output.content) * 2 + 256 * 1024 > AGENT_RECORD_LIMITS.bytes ||
      (this.document && bytes(this.document) + bytes(output) + CLI_CONVERSATION_LIMITS.terminalReserveBytes > CLI_CONVERSATION_LIMITS.bytes)) throw new Error('Conversation record final headroom exhausted; start a new session')
  }
  accept(runId: string, update: AgentAcceptedUpdate): Promise<void> {
    return this.enqueue(async () => {
      if (!this.document) throw new Error('Missing conversation anchor')
      await this.assertStoredCurrent()
      const run = this.runs.find(item => item.runId === runId)
      if (!run) throw new Error('Missing run prefix')
      assertAgentRunCurrent(run, this.projection)
      const source = { reference: `cli-session:${this.sessionId}:history:${run.history.length}`, revision: hash(update.message) }
      const record = createAgentAcceptedRecord({ envelope: this.runEnvelope(run), update,
        historyId: `cli-history:${run.history.length}`, source })
      const next = applyAgentRunRecord(run, record)
      if (bytes(next.history) > CLI_CONVERSATION_LIMITS.activeHistoryBytes) throw new Error('Final session history headroom exhausted')
      this.runs = this.runs.map(item => item === run ? next : item)
      const runs = this.document.runs.map(item => item.runId === runId ? { ...item, records: [...item.records, record] } : item)
      if (bytes({ ...this.document, runs }) + CLI_CONVERSATION_LIMITS.terminalReserveBytes > CLI_CONVERSATION_LIMITS.bytes) throw new Error('Conversation terminal headroom exhausted')
      await this.commit({ ...this.document, runs })
    })
  }
  settle(runId: string, result: AgentResult, session: CliSession, rows: readonly McpOutcomeRecord[]): Promise<void> {
    return this.enqueue(async () => {
      if (!this.document) throw new Error('Missing conversation anchor')
      await this.assertStoredCurrent()
      const run = this.runs.find(item => item.runId === runId)
      if (!run) throw new Error('Missing run prefix')
      assertAgentRunCurrent(run, this.projection)
      const history = entries(session, run.history)
      const terminal = createRunSettlement({ envelope: this.envelope(), runId,
        inputHistoryLength: run.inputHistoryLength, result, history,
        outcomes: cliMcpRecordEvidence(session, rows, this.projection.outcomes), sessionUsage: session.usage })
      const wrapper = createAgentRunTerminal(this.runEnvelope(run), terminal)
      const next = applyAgentRunRecord(run, wrapper)
      this.projection = next.session; this.runs = this.runs.map(item => item === run ? next : item)
      await this.commit({ ...this.document, records: [...this.document.records, terminal],
        runs: this.document.runs.map(item => item.runId === runId ? { ...item, records: [...item.records, wrapper] } : item) })
    })
  }
}

export class CliConversationCommitError extends Error {
  constructor(cause: unknown) {
    super('Conversation record replacement succeeded, but durability was not confirmed', { cause })
    this.name = 'CliConversationCommitError'
  }
}

/** Private regular files, exact-byte CAS and atomic replacement; no approval or MCP acknowledgements. */
export class FileCliConversationStore implements CliConversationStore {
  readonly directory: string
  constructor(directory: string) { this.directory = resolve(directory) }
  private path(id: string): string {
    if (!isSessionId(id)) throw new Error('Invalid conversation session id')
    return join(this.directory, `${id}.records.json`)
  }
  private async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw new Error('Conversation directory must be private and owned')
  }
  async read(sessionId: string): Promise<{ value: unknown; digest: string } | undefined> {
    await this.prepare()
    const path = this.path(sessionId)
    let entry
    try { entry = await lstat(path) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > CLI_CONVERSATION_LIMITS.bytes) throw new Error('Conversation file must be a bounded private regular file')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino || info.size > CLI_CONVERSATION_LIMITS.bytes ||
        process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())) throw new Error('Conversation file must be private and owned')
      const buffer = Buffer.alloc(info.size + 1)
      let offset = 0
      while (offset < buffer.length) {
        const read = await file.read(buffer, offset, buffer.length - offset, null)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      if (offset > info.size) throw new Error('Conversation file changed during read')
      const body = buffer.subarray(0, offset)
      let value: unknown
      try { value = JSON.parse(body.toString('utf8')) as unknown } catch { value = { invalidConversationJson: true } }
      return { value, digest: hashBytes(body) }
    } finally { await file.close() }
  }
  async write(sessionId: string, value: CliConversationStored, expectedDigest: string | null,
    assertCurrent: () => void): Promise<string> {
    assertMcpJson(value, CLI_CONVERSATION_LIMITS.bytes, { nodes: 8 * 1024 * 1024, depth: 40 })
    if (value.sessionId !== sessionId) throw new Error('Conversation identity mismatch')
    const body = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(body) > CLI_CONVERSATION_LIMITS.bytes) throw new Error('Conversation storage limit exceeded')
    if ('state' in value) {
      keys(value as unknown as Record<string, unknown>, ['schemaVersion', 'sessionId', 'state', 'previousDigest'])
      if (value.previousDigest !== null && !/^[a-f0-9]{64}$/.test(value.previousDigest)) throw new Error('Invalid conversation quarantine digest')
      if (value.state !== 'quarantined' || value.schemaVersion !== 1) throw new Error('Invalid conversation quarantine')
    } else replayCliConversationDocument(value)
    await this.prepare(); assertCurrent()
    const compare = async (): Promise<void> => {
      const current = await this.read(sessionId)
      if ((current?.digest ?? null) !== expectedDigest) throw new Error('Conversation storage lease changed')
      assertCurrent()
    }
    await compare()
    const temporary = join(this.directory, `.${sessionId}.${randomUUID()}.records.tmp`)
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let replaced = false
    try {
      await file.writeFile(body, 'utf8'); await file.sync(); await file.close()
      await compare()
      await rename(temporary, this.path(sessionId))
      replaced = true
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, constants.O_RDONLY)
        try { await directory.sync() } finally { await directory.close() }
      }
      return hashBytes(body)
    } catch (error) {
      if (replaced) throw new CliConversationCommitError(error)
      throw error
    } finally { await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined) }
  }
}
