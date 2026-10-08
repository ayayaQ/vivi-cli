// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  createMemoryService, decodeMemories, encodeMemories
} from '@ayayaq/vivi/extensions/memory'
import type {
  MemoriesData, MemoryActor, MemoryListResult, MemoryMutation, MemoryPersistence, MemoryService
} from '@ayayaq/vivi/extensions/memory'

// Independent of semantic character limits: escaped JSON and compatible legacy extras need room.
export const MAX_MEMORY_STORE_BYTES = 256 * 1024
export const MEMORY_LOCK_WAIT_MS = 2_000
const LOCK_RETRY_MS = 25
const PRIMARY = 'memories.json'
const BACKUP = `${PRIMARY}.bak`
const LOCK = `${PRIMARY}.lock`

export interface CliMemoryStore {
  list(signal?: AbortSignal): Promise<MemoryListResult>
  prepareCreate(content: string, actor: MemoryActor, signal?: AbortSignal): Promise<MemoryMutation>
  prepareUpdate(id: string, revision: string, content: string, actor: MemoryActor, signal?: AbortSignal): Promise<MemoryMutation>
  prepareDelete(id: string, revision: string, signal?: AbortSignal): Promise<MemoryMutation>
  /** Enforce a supplied guard inside queue/lease admission and immediately before resource replacement. */
  commit(mutation: MemoryMutation, options?: { readonly signal?: AbortSignal; readonly assertCurrent?: () => void }): Promise<MemoryCommitResult>
  addSecrets(secrets: readonly string[]): void
  drain(options?: { readonly close?: boolean }): Promise<void>
}

/** A credential registered after commit can require withholding the result, never rollback. */
export interface MemoryCommitResult extends MemoryListResult { readonly contentWithheld?: true }

interface Directory { entry: Stats; handle: FileHandle | undefined }
interface StoredFile { entry: Stats; bytes: Buffer }
interface Loaded { data: MemoriesData; primary: StoredFile | undefined }

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
function exists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
function ownedPrivate(info: Stats): boolean {
  return process.platform === 'win32' || ((info.mode & 0o077) === 0 && info.uid === process.getuid?.())
}
function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}
function unchangedFile(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}
function privateFile(info: Stats, maximum = MAX_MEMORY_STORE_BYTES): boolean {
  return info.isFile() && !info.isSymbolicLink() && ownedPrivate(info) && info.size <= maximum
}

/** Reject hooks/getters before copying an approved snapshot; never silently alter approved text. */
function plainJson(value: unknown): void {
  const pending: { value: unknown; leave: boolean }[] = [{ value, leave: false }]
  const active = new WeakSet<object>()
  // Larger than two complete bounded snapshots, so compatible legacy extras are not
  // rejected by a stricter semantic depth/node limit than the shared v1 decoder.
  let remaining = MAX_MEMORY_STORE_BYTES * 4
  while (pending.length) {
    const item = pending.pop()!
    const current = item.value
    if (item.leave) { active.delete(current as object); continue }
    remaining -= typeof current === 'string' ? current.length + 1 : 1
    if (remaining < 0) throw new Error('Memory JSON exceeds the host size limit')
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue
    if (typeof current === 'number' && Number.isFinite(current)) continue
    if (typeof current !== 'object' || !current || active.has(current) ||
      (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) ||
      Object.getOwnPropertySymbols(current).length !== 0) throw new Error('Memory must contain plain JSON data')
    active.add(current)
    pending.push({ value: current, leave: true })
    const descriptors = Object.getOwnPropertyDescriptors(current)
    if (Array.isArray(current)) {
      if (current.length > remaining) throw new Error('Memory JSON exceeds the host size limit')
      for (let index = 0; index < current.length; index++) {
        if (!Object.hasOwn(descriptors, String(index))) throw new Error('Memory must contain plain JSON data')
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(current) && key === 'length') continue
      if (!descriptor.enumerable || !('value' in descriptor) ||
        (Array.isArray(current) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length))) {
        throw new Error('Memory must contain plain JSON data')
      }
      if (!Array.isArray(current)) remaining -= key.length
      pending.push({ value: descriptor.value, leave: false })
    }
  }
}

/**
 * Host-owned, opt-in app-wide store. Each admitted operation acquires a short lease and
 * creates a fresh core service. Human approval belongs to the host, outside this lease.
 */
export class FileMemoryStore implements CliMemoryStore {
  readonly directory: string
  private readonly secrets = new Set<string>()
  private readonly notice: ((message: string) => void) | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private readonly jobs = new Set<Promise<unknown>>()
  private closed = false
  private pendingDurability: Stats | undefined

  constructor(directory: string, secrets: readonly string[] = [], notice?: (message: string) => void) {
    this.directory = resolve(directory)
    this.notice = notice
    this.addSecrets(secrets)
  }

  addSecrets(secrets: readonly string[]): void {
    for (const secret of secrets) if (typeof secret === 'string' && secret) this.secrets.add(secret)
  }

  private report(message: string): void {
    try { this.notice?.(message) } catch { /* A listener cannot roll back a committed write. */ }
  }

  private assertNoSecrets(value: unknown): void {
    const pending = [value]
    while (pending.length) {
      const item = pending.pop()
      if (typeof item === 'string') {
        for (const secret of this.secrets) {
          if (item.includes(secret)) throw new Error('Memory must not contain known credentials; no content was exposed or changed')
        }
      } else if (Array.isArray(item)) {
        for (const child of item) pending.push(child)
      } else if (item && typeof item === 'object') {
        for (const [key, child] of Object.entries(item)) { pending.push(key, child) }
      }
    }
  }

  private safeError(error: unknown): Error {
    let message = error instanceof Error ? error.message : 'Memory operation failed'
    for (const secret of [...this.secrets].sort((left, right) => right.length - left.length)) {
      message = message.split(secret).join('[REDACTED]')
      message = message.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]')
    }
    const safe = new Error(message)
    if (error instanceof Error && error.name === 'AbortError') safe.name = 'AbortError'
    return safe
  }

  private assertNoSecretBytes(bytes: Buffer): void {
    const raw = bytes.toString('utf8')
    this.assertNoSecrets(raw)
    // Recovery evidence may be malformed JSON. Decode JSON escape fragments conservatively
    // so an escaped known credential is not copied to a new evidence file either.
    const unescaped = raw.replace(/\\(?:u([\da-fA-F]{4})|(["\\/bfnrt]))/g, (_match, unicode: string | undefined, escape: string | undefined) => {
      if (unicode) return String.fromCharCode(Number.parseInt(unicode, 16))
      return ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' } as Record<string, string>)[escape!] ?? escape!
    })
    this.assertNoSecrets(unescaped)
  }

  private async directoryHandle(): Promise<Directory> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const entry = await lstat(this.directory)
    if (!entry.isDirectory() || entry.isSymbolicLink() || !ownedPrivate(entry)) {
      throw new Error('Memory directory must be a real, owned private directory with permissions 0700')
    }
    // Windows does not portably support opening directories through Node's file API.
    // Keep identity/path checks there; POSIX additionally holds an O_DIRECTORY descriptor.
    if (process.platform === 'win32') {
      const directory = { entry, handle: undefined }
      await this.checkDirectory(directory)
      return directory
    }
    const handle = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isDirectory() || !ownedPrivate(info) || !sameFile(entry, info)) {
        throw new Error('Memory directory changed while opening it')
      }
      const directory = { entry, handle }
      await this.checkDirectory(directory)
      return directory
    } catch (error) { await handle.close().catch(() => undefined); throw error }
  }

  private async checkDirectory(directory: Directory): Promise<void> {
    const current = await lstat(this.directory)
    if (!current.isDirectory() || current.isSymbolicLink() || !ownedPrivate(current) || !sameFile(current, directory.entry)) {
      throw new Error('Memory directory changed during the operation; files were not replaced')
    }
  }

  private async readFile(directory: Directory, name: string): Promise<StoredFile | undefined> {
    await this.checkDirectory(directory)
    const path = join(this.directory, name)
    let entry: Stats
    try { entry = await lstat(path) } catch (error) { if (missing(error)) return undefined; throw error }
    if (!privateFile(entry)) throw new Error('Memory store is read-only: file must be a private regular file within the size limit')
    // NONBLOCK prevents a regular-file-to-FIFO swap from hanging open.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!privateFile(info) || !unchangedFile(entry, info)) throw new Error('Memory store changed while opening; retry the operation')
      await this.checkDirectory(directory)
      const buffer = Buffer.alloc(MAX_MEMORY_STORE_BYTES + 1)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      if (offset > MAX_MEMORY_STORE_BYTES) throw new Error('Memory store is read-only: file exceeds the size limit')
      const final = await file.stat()
      const pathEntry = await lstat(path)
      await this.checkDirectory(directory)
      if (!privateFile(final) || !privateFile(pathEntry) || !unchangedFile(info, final) || !unchangedFile(final, pathEntry)) {
        throw new Error('Memory store changed while reading; retry the operation')
      }
      return { entry: final, bytes: buffer.subarray(0, offset) }
    } finally { await file.close() }
  }

  private decode(file: StoredFile): MemoriesData {
    let data: MemoriesData
    try {
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)
      data = decodeMemories(raw)
    } catch { throw new Error('Memory store is read-only: invalid or unsupported memory data; original files were preserved') }
    this.assertNoSecrets(data)
    return data
  }

  private async syncDirectory(directory: Directory, outcome = 'Memory file replacement completed'): Promise<void> {
    if (process.platform === 'win32') return
    try {
      await this.checkDirectory(directory)
      await directory.handle!.sync()
      if (!this.pendingDurability || sameFile(this.pendingDurability, directory.entry)) this.pendingDurability = undefined
    } catch {
      this.pendingDurability = directory.entry
      this.report(`${outcome}, but directory durability could not be confirmed. The store will retry during the next operation or shutdown`)
    }
  }

  private async checkTarget(directory: Directory, name: string, expected: StoredFile | undefined): Promise<void> {
    await this.checkDirectory(directory)
    let current: Stats | undefined
    try { current = await lstat(join(this.directory, name)) } catch (error) { if (!missing(error)) throw error }
    if ((current && !privateFile(current)) || (!!current !== !!expected) ||
      (current && expected && !unchangedFile(current, expected.entry))) {
      throw new Error('Memory target changed during the operation; files were not replaced')
    }
  }

  /** Resolve once rename commits; all cleanup/durability failures afterwards are notices. */
  private async replace(directory: Directory, name: string, bytes: Buffer, expected: StoredFile | undefined,
    checkSecrets?: () => void): Promise<StoredFile> {
    if (bytes.length > MAX_MEMORY_STORE_BYTES) throw new Error('Memory exceeds the host file size limit')
    await this.checkTarget(directory, name, expected)
    const temporary = join(this.directory, `.memories.${randomUUID()}.tmp`)
    const file = await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    let temporaryEntry: Stats | undefined
    let committed = false
    const outcome = name === PRIMARY ? 'Memory changes committed' : 'Memory file replacement completed'
    try {
      temporaryEntry = await file.stat()
      if (!privateFile(temporaryEntry)) throw new Error('Memory temporary file must be private and regular')
      await this.checkDirectory(directory)
      checkSecrets?.()
      await file.writeFile(bytes)
      await file.sync()
      const savedEntry = await file.stat()
      await file.close()
      await this.checkTarget(directory, name, expected)
      const currentTemporary = await lstat(temporary)
      if (!privateFile(currentTemporary) || !unchangedFile(savedEntry, currentTemporary)) {
        throw new Error('Memory temporary file changed before commit')
      }
      checkSecrets?.()
      await rename(temporary, join(this.directory, name))
      committed = true
      await this.syncDirectory(directory, outcome)
      // Rename may change ctime. Never reject after this commit boundary if stat fails.
      let entry = savedEntry
      try {
        await this.checkDirectory(directory)
        const current = await lstat(join(this.directory, name))
        if (!privateFile(current) || !sameFile(current, savedEntry)) throw new Error('Memory target changed after commit')
        entry = current
      } catch { this.report(`${outcome}; the resulting file identity could not be confirmed`) }
      return { entry, bytes }
    } finally {
      await file.close().catch(() => undefined)
      // Never clean up a swapped directory or a substituted temporary file.
      try {
        await this.checkDirectory(directory)
        const current = await lstat(temporary)
        if (temporaryEntry && sameFile(current, temporaryEntry)) await unlink(temporary)
      } catch (error) {
        if (!missing(error) && committed) this.report(`${outcome}; temporary-file cleanup could not be confirmed`)
      }
    }
  }

  private async preserve(directory: Directory, file: StoredFile, name: string): Promise<void> {
    // The primary/backup remains intact until this exclusive, synced evidence file exists.
    await this.checkTarget(directory, name, file)
    this.assertNoSecretBytes(file.bytes)
    const evidence = `memories.${name === PRIMARY ? 'primary' : 'backup'}.corrupt.${randomUUID()}.json`
    await this.replace(directory, evidence, file.bytes, undefined, () => this.assertNoSecretBytes(file.bytes))
    await this.checkTarget(directory, name, file)
    this.report('Damaged memory bytes were preserved in a private recovery file before repair')
  }

  private async load(directory: Directory, signal?: AbortSignal): Promise<Loaded> {
    signal?.throwIfAborted()
    const primary = await this.readFile(directory, PRIMARY)
    if (primary) {
      try { return { data: this.decode(primary), primary } }
      catch (error) {
        // Known credentials are never offered as recovery data or copied to a new file.
        if (error instanceof Error && error.message.includes('known credentials')) throw error
      }
    }
    const backup = await this.readFile(directory, BACKUP)
    if (!primary && !backup) return { data: { version: 1, memories: [] }, primary: undefined }
    if (!backup) throw new Error('Memory store is read-only: damaged primary has no valid backup; original files were preserved')
    const data = this.decode(backup)
    signal?.throwIfAborted()
    if (primary) await this.preserve(directory, primary, PRIMARY)
    signal?.throwIfAborted()
    const recovered = await this.replace(directory, PRIMARY, backup.bytes, primary, () => this.assertNoSecrets(data))
    this.report('Memories were recovered from the validated backup')
    return { data, primary: recovered }
  }

  private async save(directory: Directory, data: MemoriesData, loaded: Loaded, signal?: AbortSignal, assertCurrent?: () => void): Promise<void> {
    assertCurrent?.()
    plainJson(data)
    this.assertNoSecrets(data)
    const bytes = Buffer.from(`${encodeMemories(data)}\n`, 'utf8')
    if (bytes.length > MAX_MEMORY_STORE_BYTES) throw new Error('Memory exceeds the host file size limit')
    signal?.throwIfAborted()
    const backup = await this.readFile(directory, BACKUP)
    if (backup) {
      try { this.decode(backup) }
      catch (error) {
        if (error instanceof Error && error.message.includes('known credentials')) throw error
        await this.preserve(directory, backup, BACKUP)
      }
    }
    signal?.throwIfAborted()
    // Keep the last validated primary as backup. On first save, back up the empty state.
    const backupData = loaded.data
    this.assertNoSecrets(backupData)
    const backupBytes = loaded.primary?.bytes ?? Buffer.from(`${encodeMemories(backupData)}\n`, 'utf8')
    await this.replace(directory, BACKUP, backupBytes, backup, () => {
      signal?.throwIfAborted(); assertCurrent?.(); this.assertNoSecrets(backupData)
    })
    signal?.throwIfAborted()
    await this.replace(directory, PRIMARY, bytes, loaded.primary, () => {
      signal?.throwIfAborted(); assertCurrent?.(); this.assertNoSecrets(data)
    })
  }

  private async acquire(directory: Directory, signal?: AbortSignal): Promise<() => Promise<void>> {
    const target = join(this.directory, LOCK)
    const deadline = Date.now() + MEMORY_LOCK_WAIT_MS
    let file: FileHandle
    while (true) {
      signal?.throwIfAborted()
      await this.checkDirectory(directory)
      try {
        file = await open(target,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
        break
      } catch (error) {
        if (!exists(error)) throw error
        if (Date.now() >= deadline) {
          throw new Error('Memories are locked by another CLI process. Retry later. After a crash, verify that process has stopped before removing memories.json.lock; locks are never stolen automatically')
        }
        await new Promise<void>((resolveWait, reject) => {
          const done = (): void => { signal?.removeEventListener('abort', abort); resolveWait() }
          const timer = setTimeout(done, LOCK_RETRY_MS)
          const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason) }
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
        })
      }
    }
    let entry: Stats
    try { entry = await file.stat() }
    catch (error) { await file.close().catch(() => undefined); throw error }
    const release = async (): Promise<void> => {
      await this.checkDirectory(directory)
      const current = await lstat(target)
      if (!sameFile(entry, current) || !privateFile(current, 4096)) throw new Error('Memory lease changed; it was preserved')
      await unlink(target)
    }
    try {
      if (!privateFile(entry, 4096)) throw new Error('Memory lease must be a private regular file')
      await this.checkDirectory(directory)
      await file.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }), 'utf8')
      await file.sync()
      await file.close()
      await this.checkDirectory(directory)
    } catch (error) {
      await file.close().catch(() => undefined)
      await release().catch(() => undefined)
      throw error
    }
    return release
  }

  private admit<T>(signal: AbortSignal | undefined, action: (directory: Directory) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Memory store is closing; no new operations are accepted'))
    const job = this.chain.then(async () => {
      signal?.throwIfAborted()
      const directory = await this.directoryHandle()
      let release: (() => Promise<void>) | undefined
      try {
        release = await this.acquire(directory, signal)
        signal?.throwIfAborted()
        if (this.pendingDurability) {
          if (!sameFile(this.pendingDurability, directory.entry)) throw new Error('Memory directory changed while durability was pending')
          await this.syncDirectory(directory)
        }
        return await action(directory)
      } finally {
        if (release) {
          try { await release() }
          catch { this.report('Memory lease cleanup failed; retry may require checking the owning process and its lock file') }
        }
        await directory.handle?.close().catch(() => undefined)
      }
    }).catch((error: unknown) => { throw this.safeError(error) })
    this.jobs.add(job)
    this.chain = job.catch(() => undefined)
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job))
    return job
  }

  private operation<T>(signal: AbortSignal | undefined, action: (service: MemoryService) => Promise<T>,
    committedProjection?: (result: T) => T, assertCurrent?: () => void): Promise<T> {
    return this.admit(signal, async directory => {
      assertCurrent?.()
      let loaded: Loaded | undefined
      let committed = false
      const persistence: MemoryPersistence = {
        load: async () => { loaded = await this.load(directory, signal); return loaded.data },
        assertWritable: () => { signal?.throwIfAborted(); assertCurrent?.() },
        save: async data => {
          if (!loaded) throw new Error('Memory store must be loaded before saving')
          await this.save(directory, data, loaded, signal, assertCurrent)
          committed = true
        }
      }
      const result = await action(createMemoryService(persistence))
      try { this.assertNoSecrets(result) }
      catch (error) {
        if (!committed || !committedProjection) throw error
        this.report('Memory changes committed before a newly registered credential was detected. Result content was withheld, and future memory context will remain blocked until the stored content is safe')
        return committedProjection(result)
      }
      return result
    })
  }

  list(signal?: AbortSignal): Promise<MemoryListResult> {
    return this.operation(signal, async service => { const result = await service.list(); signal?.throwIfAborted(); return result })
  }

  prepareCreate(content: string, actor: MemoryActor, signal?: AbortSignal): Promise<MemoryMutation> {
    return this.operation(signal, async service => {
      this.assertNoSecrets(content)
      const mutation = await service.prepareCreate(content, actor)
      signal?.throwIfAborted()
      return mutation
    })
  }

  prepareUpdate(id: string, revision: string, content: string, actor: MemoryActor, signal?: AbortSignal): Promise<MemoryMutation> {
    return this.operation(signal, async service => {
      this.assertNoSecrets(content)
      const mutation = await service.prepareUpdate(id, revision, content, actor)
      signal?.throwIfAborted()
      return mutation
    })
  }

  prepareDelete(id: string, revision: string, signal?: AbortSignal): Promise<MemoryMutation> {
    return this.operation(signal, async service => {
      const mutation = await service.prepareDelete(id, revision)
      signal?.throwIfAborted()
      return mutation
    })
  }

  commit(mutation: MemoryMutation, options: { readonly signal?: AbortSignal; readonly assertCurrent?: () => void } = {}): Promise<MemoryCommitResult> {
    let captured: MemoryMutation
    try { plainJson(mutation); this.assertNoSecrets(mutation); captured = structuredClone(mutation) }
    catch (error) { return Promise.reject(this.safeError(error)) }
    return this.operation<MemoryCommitResult>(options.signal, service => {
      options.assertCurrent?.()
      this.assertNoSecrets(captured)
      return service.commit(captured, { ...(options.signal ? { signal: options.signal } : {}) })
    }, result => ({ memories: [], limits: result.limits, contentWithheld: true }), options.assertCurrent)
  }

  /** Drain admission, not merely a runner's abortable filesystem promise. Reusable between turns. */
  async drain(options: { readonly close?: boolean } = {}): Promise<void> {
    if (options.close) this.closed = true
    while (this.jobs.size) await Promise.allSettled([...this.jobs])
    if (!this.pendingDurability) return
    // Reconciliation never changes memory contents and cannot falsely report a rollback.
    let directory: Directory | undefined
    let release: (() => Promise<void>) | undefined
    try {
      directory = await this.directoryHandle()
      if (!sameFile(this.pendingDurability, directory.entry)) throw new Error('Memory directory changed')
      release = await this.acquire(directory)
      await this.syncDirectory(directory)
    } catch { this.report('Memory file replacement completed, but shutdown could not confirm directory durability; recovery files were retained') }
    finally {
      if (release) await release().catch(() => this.report('Memory lease cleanup failed during shutdown'))
      await directory?.handle?.close().catch(() => undefined)
    }
  }
}
