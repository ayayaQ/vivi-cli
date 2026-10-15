// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSkillCatalog, parseSkillDocument, SKILL_LIMITS } from '@ayayaq/vivi/extensions/skills'
import type { SkillCatalog, SkillReadRequest, SkillSaveProposal, SkillSource } from '@ayayaq/vivi/extensions/skills'
import { FileSkillStore } from './skills.js'
import type { CliSkillStore, SkillSaveReceipt, SkillStoreOptions } from './skills.js'

const DATABASE = 'skills.sqlite'
const MAX_DATABASE_BYTES = 8 * 1024 * 1024
/** Commit admission occurred, but its durable receipt could not be recovered. Never retry blindly. */
export class SkillSaveCommitError extends Error {
  readonly unknownOutcome = true
  constructor(readonly receiptId: string) { super('Installed skill save outcome is unknown; inspect installed skills before retrying'); this.name = 'SkillSaveCommitError' }
}
/** Trusted store rejection after proving that no skill document was committed. */
export class SkillSaveNotCommittedError extends Error {}
interface Statement {
  all(...values: (string | number | null)[]): unknown[]
  get(...values: (string | number | null)[]): unknown
  run(...values: (string | number | null)[]): unknown
}
interface Database { exec(sql: string): unknown; prepare(sql: string): Statement; close(throwOnError?: boolean): void }
interface Entry { readonly path: string; readonly info: BigIntStats }
interface Row { readonly name: string; readonly content: string; readonly revision: string }
const absent = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'
const same = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino !== 0n && left.ino === right.ino
const privateEntry = (info: BigIntStats): boolean => process.platform === 'win32' ||
  info.uid === BigInt(process.getuid?.() ?? -1) && (info.mode & 0o077n) === 0n

/**
 * SKILL.md-only installed documents, in a fixed app-owned local profile. This uses the
 * same built-in SQLite drivers as the MCP lease store. It is not hostile-filesystem
 * isolation: the profile must remain privately owned, and its ancestors must stay stable.
 * Legacy folders and explicit imports stay read-only; nothing is migrated or overwritten.
 */
export class InstalledSkillStore implements CliSkillStore {
  readonly directory: string
  readonly writable = true
  private readonly imports: FileSkillStore
  private readonly secrets = new Set<string>()
  private latestDiagnostics: readonly string[] = []
  private jobs = new Set<Promise<unknown>>()
  private chain: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(profile: string, options: SkillStoreOptions = {}) {
    this.directory = join(resolve(profile), 'installed-skills')
    this.imports = new FileSkillStore(join(resolve(profile), 'agent-skills'), options)
    this.addSecrets(options.secrets ?? [])
  }
  addSecrets(secrets: readonly string[]): void {
    this.imports.addSecrets(secrets)
    for (const secret of secrets) if (typeof secret === 'string' && secret) this.secrets.add(secret)
  }
  private screen(value: unknown): void {
    const pending = [value]
    while (pending.length) {
      const item = pending.pop()
      if (typeof item === 'string') {
        if ([...this.secrets].some(secret => item.includes(secret))) throw new Error('Skills must not contain known credentials; no content was exposed or changed')
      } else if (Array.isArray(item)) pending.push(...item)
      else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) pending.push(key, child)
    }
  }
  get diagnostics(): readonly string[] {
    return Object.freeze(this.latestDiagnostics.map(value => { try { this.screen(value); return value } catch { return 'A skill containing known credentials was excluded' } }))
  }
  private async ancestry(destination = this.directory): Promise<Entry[]> {
    const root = parse(destination).root
    const entries: Entry[] = []
    let path = root
    for (const component of [undefined, ...relative(root, destination).split(sep).filter(Boolean)]) {
      if (component !== undefined) path = join(path, component)
      const info = await lstat(path, { bigint: true })
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Installed skill storage requires real stable directories')
      if ((path === this.directory || path === dirname(this.directory)) && !privateEntry(info)) throw new Error('Installed skill storage requires an owned private profile')
      entries.push({ path, info })
    }
    return entries
  }
  private async check(entries: readonly Entry[]): Promise<void> {
    for (const entry of entries) {
      const info = await lstat(entry.path, { bigint: true })
      if (!info.isDirectory() || info.isSymbolicLink() || !same(info, entry.info) ||
        (entry.path === this.directory || entry.path === dirname(this.directory)) && !privateEntry(info)) throw new Error('Installed skill storage changed; take a fresh catalog')
    }
  }
  private async database(create: boolean): Promise<{ database: Database; entries: Entry[] } | undefined> {
    try { await lstat(this.directory, { bigint: true }) }
    catch (error) {
      if (!absent(error)) throw error
      if (!create) return undefined
      // The existing app profile is checked before creating our one fixed child directory.
      await this.ancestry(dirname(this.directory))
      const profile = dirname(this.directory), info = await lstat(profile, { bigint: true })
      if (!info.isDirectory() || info.isSymbolicLink() || !privateEntry(info)) throw new Error('Installed skill storage requires an owned private profile')
      await mkdir(this.directory, { mode: 0o700 }).catch(error => {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      })
    }
    const entries = await this.ancestry(), path = join(this.directory, DATABASE)
    if (create) {
      let file
      try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
      await file?.close()
    }
    let original: BigIntStats | undefined
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      let info
      try { info = await lstat(path + suffix, { bigint: true }) }
      catch (error) { if (absent(error)) continue; throw error }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || !privateEntry(info) || info.size > BigInt(MAX_DATABASE_BYTES) || suffix === '-wal' || suffix === '-shm')
        throw new Error('Installed skill database or auxiliary file is unavailable')
      if (!suffix) original = info
    }
    if (!original) return undefined
    let database: Database | undefined
    try {
      if ('Bun' in globalThis) {
        const specifier = 'bun:sqlite'
        const module = await import(specifier) as { Database: new (path: string, options: { create: boolean; readwrite: boolean; readonly: boolean }) => Database }
        const native = new module.Database(path, { create: false, readwrite: create, readonly: !create })
        // Bun's default close defers prepare() statements and file handles until GC.
        // Every operation owns its statements, so release them before returning.
        database = { exec: sql => native.exec(sql), prepare: sql => native.prepare(sql), close: () => native.close(true) }
      } else {
        const { DatabaseSync } = await import('node:sqlite')
        database = new DatabaseSync(path, { readOnly: !create, allowExtension: false, timeout: 0 }) as Database
      }
      await this.check(entries)
      const current = await lstat(path, { bigint: true })
      if (!same(original, current)) throw new Error('Installed skill database changed while opening')
      database.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0;')
      if (create) database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;')
      const page = database.prepare('PRAGMA page_size').get() as { page_size?: unknown }
      if (page.page_size !== 4096) throw new Error('Installed skill database page size is unavailable')
      if (create) database.exec(`PRAGMA max_page_count=${MAX_DATABASE_BYTES / 4096}`)
      return { database, entries }
    } catch (error) { try { database?.close() } catch { /* Preserve the original failure. */ } throw error }
  }
  private rows(database: Database): Row[] {
    const rows = database.prepare('SELECT name, content, revision FROM installed_skills ORDER BY name LIMIT ?').all(SKILL_LIMITS.maximumSkills + 1)
    if (rows.length > SKILL_LIMITS.maximumSkills) throw new Error('Installed skill count limit reached')
    let total = 0
    return rows.map(value => {
      const row = value as Row
      if (!row || typeof row.name !== 'string' || typeof row.content !== 'string' || typeof row.revision !== 'string') throw new Error('Installed skill record is invalid')
      const document = parseSkillDocument(row.content, row.name)
      if (document.metadata.name !== row.name || document.revision !== row.revision || document.warnings.length) throw new Error('Installed skill record is invalid')
      total += Buffer.byteLength(row.content, 'utf8')
      if (total > SKILL_LIMITS.maximumTotalDocumentBytes) throw new Error('Installed skill byte limit reached')
      this.screen(row)
      return row
    })
  }
  private admit<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new SkillSaveNotCommittedError('Skill store is closed'))
    const job = this.chain.then(action).catch(error => {
      if (error instanceof SkillSaveCommitError) throw error
      // SQLite errors include paths. Use closed diagnostics, never native exception text.
      const aborted = error instanceof Error && error.name === 'AbortError'
      const message = aborted ? 'Skill save cancelled before commit' : error instanceof Error &&
        /^Skills must not contain|^Installed skill|^Skill (?:revision|name|proposal)|^Read-only skill/.test(error.message)
        ? error.message : 'Installed skill storage is unavailable or busy; refresh the catalog before retrying'
      const failure = new SkillSaveNotCommittedError(message)
      if (aborted) failure.name = 'AbortError'
      throw failure
    })
    this.chain = job.catch(() => undefined); this.jobs.add(job)
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job))
    return job
  }
  snapshot(signal?: AbortSignal): Promise<SkillCatalog> {
    return this.admit(async () => {
      signal?.throwIfAborted()
      const imported = await this.imports.snapshot(signal), diagnostics = [...this.imports.diagnostics]
      let installed: Row[] = [], opened
      try {
        opened = await this.database(false)
        if (opened) { installed = this.rows(opened.database); await this.check(opened.entries) }
      } catch { signal?.throwIfAborted(); diagnostics.push('Installed skill storage is unavailable; imported skills remain read-only') }
      finally { try { opened?.database.close() } catch { /* Read-only projection is already captured. */ } }
      if (!this.imports.discoveryComplete) { diagnostics.push('Installed skills were withheld because read-only import name discovery is incomplete'); installed = [] }
      const collisions = new Set(installed.filter(row => this.imports.discoveredNames.includes(row.name)).map(row => row.name))
      const sources: SkillSource[] = imported.skills.filter(skill => !collisions.has(skill.name) || skill.name === 'skill-creator').map(skill => ({
        content: imported.document(skill.name)!.content, readOnly: true,
        readResource: (request, context) => imported.read(request, context)
      }))
      for (const row of installed) {
        if (collisions.has(row.name)) { diagnostics.push(`Duplicate skill name excluded; no source was silently shadowed: ${JSON.stringify(row.name)}`); continue }
        sources.push({ content: row.content, readOnly: false })
      }
      // The shared constructor applies the combined count, byte and summary limits.
      let catalog: SkillCatalog
      try { catalog = createSkillCatalog(sources) }
      catch { diagnostics.push('Combined skill catalog limit reached; installed skills were excluded'); catalog = imported }
      this.latestDiagnostics = Object.freeze(diagnostics)
      signal?.throwIfAborted(); this.screen(catalog.skills)
      const guard = <T>(value: T): T => { this.screen(value); return value }
      return Object.freeze({ get skills() { return guard(catalog.skills) },
        document: (name: string) => guard(catalog.document(name)),
        read: async (request: SkillReadRequest, context: { readonly signal: AbortSignal }) => {
          guard(request); const content = await catalog.read(request, context); context.signal.throwIfAborted(); return guard(content)
        } })
    })
  }
  commit(proposal: SkillSaveProposal, context: { readonly signal: AbortSignal; readonly assertCurrent?: () => void }): Promise<SkillSaveReceipt> {
    // Copy only semantic data before the first await. The host binds this to exact human review.
    const saved = structuredClone(proposal)
    return this.admit(async () => {
      const assertCurrent = (): void => { context.signal.throwIfAborted(); context.assertCurrent?.(); this.screen(saved) }
      assertCurrent()
      const after = parseSkillDocument(saved.after.content, saved.name)
      if (after.metadata.name !== saved.name || after.revision !== saved.after.revision || after.warnings.length ||
        saved.expectedRevision !== (saved.before?.revision ?? null) || saved.before &&
        parseSkillDocument(saved.before.content, saved.name).revision !== saved.before.revision) throw new Error('Skill proposal changed; request a fresh exact-content review')
      const imported = await this.imports.snapshot(context.signal)
      if (!this.imports.discoveryComplete) throw new Error('Installed skill saving requires complete read-only import name discovery; refresh the catalog')
      if (this.imports.discoveredNames.includes(saved.name)) throw new Error('Read-only skill names cannot be created or replaced in installed storage')
      const opened = await this.database(true)
      if (!opened) throw new Error('Installed skill storage is unavailable')
      let transaction = false
      try {
        await this.check(opened.entries); assertCurrent()
        const database = opened.database
        database.exec('BEGIN IMMEDIATE'); transaction = true
        database.exec('CREATE TABLE IF NOT EXISTS installed_skills (name TEXT PRIMARY KEY NOT NULL, content TEXT NOT NULL, revision TEXT NOT NULL, receipt_id TEXT NOT NULL, before_revision TEXT) STRICT; CREATE TABLE IF NOT EXISTS skill_save_receipts (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, before_revision TEXT, revision TEXT NOT NULL) STRICT')
        const rows = this.rows(database), before = rows.find(row => row.name === saved.name)
        if ((before?.revision ?? null) !== saved.expectedRevision) throw new Error('Skill revision changed after review; refresh the catalog before saving')
        const next = rows.filter(row => row.name !== saved.name).concat({ name: saved.name, content: after.content, revision: after.revision })
        const collisions = new Set(next.filter(row => this.imports.discoveredNames.includes(row.name)).map(row => row.name))
        try {
          createSkillCatalog([
            ...imported.skills.filter(skill => !collisions.has(skill.name) || skill.name === 'skill-creator').map(skill => ({ content: imported.document(skill.name)!.content, readOnly: true })),
            ...next.filter(row => !collisions.has(row.name)).map(row => ({ content: row.content }))
          ])
        } catch { throw new Error('Installed skill save would exceed the combined catalog limits; shorten the proposal before saving') }
        const receipt: SkillSaveReceipt = Object.freeze({ id: randomUUID(), name: saved.name, beforeRevision: saved.expectedRevision, revision: after.revision, available: 'next_turn' })
        assertCurrent()
        database.prepare('INSERT INTO installed_skills (name, content, revision, receipt_id, before_revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET content=excluded.content, revision=excluded.revision, receipt_id=excluded.receipt_id, before_revision=excluded.before_revision')
          .run(saved.name, after.content, after.revision, receipt.id, receipt.beforeRevision)
        database.prepare('INSERT INTO skill_save_receipts (id, name, before_revision, revision) VALUES (?, ?, ?, ?)')
          .run(receipt.id, receipt.name, receipt.beforeRevision, receipt.revision)
        try { database.exec('COMMIT'); transaction = false }
        catch {
          // A native COMMIT exception does not itself establish rollback. Release any
          // still-open transaction, then recover this immutable operation receipt.
          // Keeping receipts separate also proves a commit superseded by another writer.
          let rolledBack = false
          try { database.exec('ROLLBACK'); rolledBack = true; transaction = false } catch { /* It may already have committed. */ }
          if (rolledBack) throw new Error('Installed skill save did not commit; refresh the catalog before retrying')
          // Never read an uncertain connection's own pending writes as commit evidence.
          // A fresh connection only observes committed receipts, including superseded saves.
          try { database.close(); transaction = false } catch { /* A fresh reader still cannot observe pending changes. */ }
          let recovery
          try {
            recovery = await this.database(false)
            const recovered = recovery?.database.prepare('SELECT name, before_revision, revision FROM skill_save_receipts WHERE id = ?').get(receipt.id) as { name?: unknown; before_revision?: unknown; revision?: unknown } | undefined
            if (recovered?.name === receipt.name && recovered.before_revision === receipt.beforeRevision && recovered.revision === receipt.revision) return receipt
          } catch { /* Preserve the indeterminate outcome and durable correlation. */ }
          finally { try { recovery?.database.close() } catch { /* Recovery never repeats the save. */ } }
          throw new SkillSaveCommitError(receipt.id)
        }
        // Receipt and exact document publish together. No cancellation or fallible await follows.
        return receipt
      } finally {
        if (transaction) { try { opened.database.exec('ROLLBACK') } catch { /* Close releases the transaction. */ } }
        try { opened.database.close() } catch { /* A committed document stays committed. */ }
      }
    })
  }
  async drain(options: { readonly close?: boolean } = {}): Promise<void> {
    if (options.close) this.closed = true
    while (this.jobs.size) await Promise.allSettled([...this.jobs])
    await this.imports.drain(options)
  }
}
