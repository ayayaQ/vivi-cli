// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import {
  createSkillCatalog, parseSkillDocument, SKILL_LIMITS, skillCreatorSource,
  validateSkillName, validateSkillResourcePath
} from '@ayayaq/vivi/extensions/skills'
import type {
  SkillCatalog, SkillDocument, SkillReadRequest, SkillSaveProposal, SkillSource
} from '@ayayaq/vivi/extensions/skills'

export const SKILL_LOCK_WAIT_MS = 2_000
const LOCK = '.skills.lock'
const PRIMARY = 'SKILL.md'
const BACKUP = 'SKILL.md.bak'
const MAXIMUM_SCAN_ENTRIES = 1_024

export interface SkillStoreOptions {
  /** Explicit host-approved additional roots. Never inferred from a working directory. */
  readonly readOnlyRoots?: readonly string[]
  readonly secrets?: readonly string[]
  readonly notice?: (message: string) => void
}
export interface SkillDiagnostic { readonly message: string; readonly name?: string }
export interface PreparedSkillSave {
  readonly destination: string
  readonly before: SkillDocument | null
  readonly after: SkillDocument
  readonly proposal: SkillSaveProposal
}
/** A committed receipt survives cancellation of the model's generic tool runner. */
export interface SkillCommitReceipt {
  readonly committed: true
  readonly futureTurn: true
  readonly name?: string
  readonly revision?: string
  readonly contentWithheld?: true
}
export interface CliSkillStore {
  readonly directory: string
  /** False where this Node host lacks validated handle-relative atomic saves. */
  readonly writable: boolean
  readonly diagnostics: readonly string[]
  readonly receipts: readonly SkillCommitReceipt[]
  snapshot(signal?: AbortSignal): Promise<SkillCatalog>
  prepare(proposal: SkillSaveProposal, signal?: AbortSignal): Promise<PreparedSkillSave>
  commit(proposal: SkillSaveProposal, options?: { readonly signal?: AbortSignal }): Promise<SkillCommitReceipt>
  takeReceipts(): readonly SkillCommitReceipt[]
  addSecrets(secrets: readonly string[]): void
  drain(options?: { readonly close?: boolean }): Promise<void>
}

interface PathEntry { readonly path: string; readonly entry: Stats }
interface Directory {
  readonly path: string
  readonly entry: Stats
  readonly ancestry: readonly PathEntry[]
  readonly handles: readonly FileHandle[]
  readonly handle: FileHandle | undefined
  readonly private: boolean
}
interface StoredFile { readonly entry: Stats; readonly bytes: Buffer; readonly content: string }
interface SourceBinding {
  readonly root: string
  readonly rootEntry: Stats
  readonly name: string
  readonly directoryName: string
  readonly ownedRoot: boolean
  readonly directoryEntry: Stats
  readonly revision: string
  readonly readOnly: boolean
}
interface Candidate { readonly source: SkillSource; readonly document: SkillDocument; readonly binding?: SourceBinding }

function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
function exists(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'EEXIST' }
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino }
function unchanged(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}
function ownedPrivate(info: Stats): boolean {
  return process.platform === 'win32' || ((info.mode & 0o077) === 0 && info.uid === process.getuid?.())
}
function regular(info: Stats, maximum: number, privateFile: boolean): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= maximum && (!privateFile || ownedPrivate(info))
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
/** Reject hooks before reading/copying an approval proposal. */
function plainData(value: unknown): void {
  const active = new WeakSet<object>()
  let remaining = SKILL_LIMITS.maximumDocumentBytes * 8
  const visit = (item: unknown, depth: number): void => {
    remaining -= typeof item === 'string' ? item.length + 1 : 1
    if (remaining < 0 || depth > 12) throw new Error('Skill proposal exceeds the host limit')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (!item || typeof item !== 'object' || active.has(item) ||
      (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) ||
      Object.getOwnPropertySymbols(item).length) throw new Error('Skill proposal must contain plain data')
    active.add(item)
    const descriptors = Object.getOwnPropertyDescriptors(item)
    if (Array.isArray(item)) {
      if (item.length > remaining) throw new Error('Skill proposal exceeds the host limit')
      for (let index = 0; index < item.length; index++) {
        if (!Object.hasOwn(descriptors, String(index))) throw new Error('Skill proposal must contain plain data')
      }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue
      if (!descriptor.enumerable || !('value' in descriptor) ||
        (Array.isArray(item) && (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length))) {
        throw new Error('Skill proposal must contain plain data')
      }
      remaining -= key.length
      visit(descriptor.value, depth + 1)
    }
    active.delete(item)
  }
  visit(value, 0)
}
function canonicalName(name: unknown): string {
  validateSkillName(name)
  const canonical = name.trim().normalize('NFKC')
  validateSkillResourcePath(canonical)
  if (name !== canonical) throw new Error('Skill save name must be canonical')
  return canonical
}
function containsPath(parent: string, child: string): boolean {
  const difference = relative(parent, child)
  return difference === '' || (!difference.startsWith(`..${sep}`) && difference !== '..' && !parse(difference).root)
}
function safeResource(path: string): void {
  validateSkillResourcePath(path)
  const forbidden = /^(?:\.git|\.aws|\.codex|\.env(?:[._-].*)?|credentials?(?:[._-].*)?|auth(?:[._-].*)?|tokens?(?:[._-].*)?|passwords?(?:[._-].*)?|secrets?(?:[._-].*)?|private[-_]keys?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|sessions?(?:[._-].*)?|preferences?(?:[._-].*)?|memories?(?:[._-].*)?|.*\.(?:pem|key|p12|pfx))$/iu
  if (path.split('/').some(component => forbidden.test(component))) {
    throw new Error('Credential, session and host-state paths are unavailable as skill resources')
  }
}

/**
 * Host-owned app-wide, instruction-only SKILL.md store. Approval occurs outside its
 * short lease; commit independently rereads the exact revision under a new lease.
 */
export class FileSkillStore implements CliSkillStore {
  readonly directory: string
  private readonly roots: readonly string[]
  private readonly secrets = new Set<string>()
  private readonly notice: SkillStoreOptions['notice']
  private chain: Promise<unknown> = Promise.resolve()
  private readonly jobs = new Set<Promise<unknown>>()
  private closed = false
  private latestDiagnostics: readonly SkillDiagnostic[] = Object.freeze([])
  private committedReceipts: SkillCommitReceipt[] = []
  private readonly pendingDurability = new Map<string, Stats>()

  constructor(directory: string, options: SkillStoreOptions = {}) {
    this.directory = resolve(directory)
    this.roots = Object.freeze([...new Set((options.readOnlyRoots ?? []).map(root => resolve(root)))])
    const profile = dirname(this.directory)
    if (this.roots.some(root => containsPath(profile, root) || containsPath(root, profile))) {
      throw new Error('Additional skill roots must be separate from the owned store and its host-state profile')
    }
    this.notice = options.notice
    this.addSecrets(options.secrets ?? [])
  }

  get writable(): boolean { return process.platform === 'linux' }
  private assertSaveSupported(): void {
    if (!this.writable) throw new Error('Skill saving is unavailable on this platform: safe handle-relative atomic transactions are required. Draft a standard SKILL.md for manual saving')
  }

  addSecrets(secrets: readonly string[]): void {
    for (const secret of secrets) if (typeof secret === 'string' && secret) this.secrets.add(secret)
  }
  private noSecrets(value: unknown): void {
    const pending = [value]
    while (pending.length) {
      const item = pending.pop()
      if (typeof item === 'string') {
        for (const secret of this.secrets) if (item.includes(secret)) {
          throw new Error('Skills must not contain known credentials; no content was exposed or changed')
        }
      } else if (Array.isArray(item)) pending.push(...item)
      else if (item && typeof item === 'object') {
        for (const [key, child] of Object.entries(item)) pending.push(key, child)
      }
    }
  }
  private safeError(error: unknown): Error {
    let message = error instanceof Error ? error.message : 'Skill operation failed'
    for (const secret of [...this.secrets].sort((left, right) => right.length - left.length)) {
      message = message.split(secret).join('[REDACTED]')
      message = message.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]')
    }
    message = message.replace(/[\u0000-\u001f\u007f]/gu, character => JSON.stringify(character).slice(1, -1))
    const result = new Error(message)
    if (error instanceof Error && error.name === 'AbortError') result.name = 'AbortError'
    return result
  }
  private report(message: string): void {
    try { this.notice?.(this.safeError(new Error(message)).message) } catch { /* A listener cannot roll back a rename. */ }
  }
  get diagnostics(): readonly string[] {
    return Object.freeze(this.latestDiagnostics.map(diagnostic => {
      try { this.noSecrets(diagnostic); return `${diagnostic.name ? `${JSON.stringify(diagnostic.name)}: ` : ''}${diagnostic.message}` }
      catch { return 'A skill containing known credentials was excluded' }
    }))
  }
  private safeReceipt(receipt: SkillCommitReceipt): SkillCommitReceipt {
    try { this.noSecrets(receipt); return receipt }
    catch { return Object.freeze({ committed: true, futureTurn: true, contentWithheld: true }) }
  }
  get receipts(): readonly SkillCommitReceipt[] { return Object.freeze(this.committedReceipts.map(item => this.safeReceipt(item))) }
  takeReceipts(): readonly SkillCommitReceipt[] {
    const receipts = this.receipts
    this.committedReceipts = []
    return receipts
  }

  /** Linux descriptor paths anchor operations even if a checked parent is renamed. */
  private ioPath(directory: Directory): string {
    return process.platform === 'linux' && directory.handle ? `/proc/self/fd/${directory.handle.fd}` : directory.path
  }
  private async checkDirectory(directory: Directory): Promise<void> {
    for (const ancestor of directory.ancestry) {
      const current = await lstat(ancestor.path)
      if (!current.isDirectory() || current.isSymbolicLink() || !sameFile(current, ancestor.entry)) {
        throw new Error('Skill directory changed during the operation; files were preserved')
      }
    }
    const canonical = await realpath(directory.path)
    if (resolve(canonical) !== directory.path) throw new Error('Skill roots and directories must not contain symlinks or junctions')
    const current = await lstat(directory.path)
    if (!sameFile(current, directory.entry) || (directory.private && !ownedPrivate(current))) {
      throw new Error('Skill directory changed or is not an owned private directory')
    }
  }
  private async closeDirectory(directory: Directory): Promise<void> {
    for (const handle of [...directory.handles].reverse()) await handle.close().catch(() => undefined)
  }
  private async openDirectory(path: string, privateDirectory: boolean, create = false): Promise<Directory> {
    const absolute = resolve(path)
    const root = parse(absolute).root
    const components = relative(root, absolute).split(sep).filter(Boolean)
    const ancestry: PathEntry[] = []
    const handles: FileHandle[] = []
    let current = root
    let parent: Directory | undefined
    try {
      for (const component of [undefined, ...components]) {
        if (component !== undefined) current = join(current, component)
        if (parent) await this.checkDirectory(parent)
        const io = parent && component !== undefined ? join(this.ioPath(parent), component) : current
        let entry: Stats
        try { entry = await lstat(io) }
        catch (error) {
          if (!create || !missing(error)) throw error
          await mkdir(io, { mode: 0o700 })
          entry = await lstat(io)
        }
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Skill roots and directories must be real directories without symlinks or junctions')
        let handle: FileHandle | undefined
        if (process.platform !== 'win32') {
          handle = await open(io, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          handles.push(handle)
          const info = await handle.stat()
          if (!info.isDirectory() || !sameFile(info, entry)) throw new Error('Skill directory changed while opening it')
        }
        ancestry.push({ path: current, entry })
        parent = { path: current, entry, ancestry: [...ancestry], handles, handle, private: false }
        await this.checkDirectory(parent)
      }
      if (!parent || (privateDirectory && !ownedPrivate(parent.entry))) {
        throw new Error('Owned skill root must be a private directory with permissions 0700')
      }
      const directory: Directory = { ...parent, private: privateDirectory }
      await this.checkDirectory(directory)
      return directory
    } catch (error) {
      for (const handle of handles.reverse()) await handle.close().catch(() => undefined)
      throw error
    }
  }
  private async childDirectory(parent: Directory, name: string, create = false): Promise<Directory | undefined> {
    validateSkillResourcePath(name)
    if (name.includes('/')) throw new Error('Skill directory must be one path component')
    await this.checkDirectory(parent)
    const path = join(parent.path, name)
    const io = join(this.ioPath(parent), name)
    let entry: Stats
    try { entry = await lstat(io) }
    catch (error) {
      if (!missing(error)) throw error
      if (!create) return undefined
      await mkdir(io, { mode: 0o700 })
      entry = await lstat(io)
    }
    if (!entry.isDirectory() || entry.isSymbolicLink() || (parent.private && !ownedPrivate(entry))) {
      throw new Error('Skill directory must be real, contained and private in the owned store')
    }
    let handle: FileHandle | undefined
    try {
      if (process.platform !== 'win32') {
        handle = await open(io, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
        const info = await handle.stat()
        if (!info.isDirectory() || !sameFile(entry, info)) throw new Error('Skill directory changed while opening it')
      }
      const directory: Directory = { path, entry, ancestry: [...parent.ancestry, { path, entry }],
        handles: handle ? [handle] : [], handle, private: parent.private }
      await this.checkDirectory(directory)
      return directory
    } catch (error) { await handle?.close().catch(() => undefined); throw error }
  }
  private async readFile(directory: Directory, name: string, maximum: number = SKILL_LIMITS.maximumDocumentBytes): Promise<StoredFile | undefined> {
    await this.checkDirectory(directory)
    const path = join(this.ioPath(directory), name)
    let entry: Stats
    try { entry = await lstat(path) } catch (error) { if (missing(error)) return undefined; throw error }
    if (!regular(entry, maximum, directory.private)) throw new Error('Skill file is read-only: expected a bounded regular file without symlinks')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!regular(info, maximum, directory.private) || !unchanged(entry, info)) throw new Error('Skill file changed while opening it')
      await this.checkDirectory(directory)
      const buffer = Buffer.alloc(maximum + 1)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset > maximum) throw new Error('Skill file exceeds the byte limit')
      const final = await file.stat()
      const pathEntry = await lstat(path)
      await this.checkDirectory(directory)
      if (!regular(final, maximum, directory.private) || !regular(pathEntry, maximum, directory.private) ||
        !unchanged(info, final) || !unchanged(final, pathEntry)) throw new Error('Skill file changed while reading it')
      const bytes = buffer.subarray(0, offset)
      let content: string
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
      catch { throw new Error('Skill file is read-only: invalid UTF-8; original bytes were preserved') }
      this.noSecrets(content)
      return { entry: final, bytes, content }
    } finally { await file.close() }
  }
  private document(file: StoredFile, name: string): SkillDocument {
    const document = parseSkillDocument(file.content, name)
    this.noSecrets(document)
    if (document.warnings.length) throw new Error('Skill is read-only: unsupported frontmatter fields must be reviewed before discovery or saving')
    return document
  }
  private async resource(binding: SourceBinding, request: SkillReadRequest, signal: AbortSignal): Promise<string> {
    return this.admit(signal, async () => {
      signal.throwIfAborted()
      safeResource(request.path)
      if (request.name !== binding.name || request.expectedRevision !== binding.revision) throw new Error('Skill resource revision is stale')
      const root = await this.openDirectory(binding.root, binding.ownedRoot)
      const directories: Directory[] = [root]
      try {
        if (!sameFile(root.entry, binding.rootEntry)) throw new Error('Approved skill root changed; take a fresh catalog')
        const skill = await this.childDirectory(root, binding.directoryName)
        if (!skill || !sameFile(skill.entry, binding.directoryEntry)) throw new Error('Skill source changed; take a fresh catalog')
        directories.push(skill)
        const checkRevision = async (): Promise<void> => {
          signal.throwIfAborted()
          const source = await this.readFile(skill, PRIMARY)
          if (!source || this.document(source, binding.name).revision !== binding.revision) throw new Error('Skill source revision changed; take a fresh catalog')
        }
        await checkRevision()
        const components = request.path.split('/')
        let directory = skill
        for (const component of components.slice(0, -1)) {
          const child = await this.childDirectory(directory, component)
          if (!child) throw new Error('Skill resource is unavailable')
          directories.push(child)
          directory = child
          await checkRevision()
        }
        const file = await this.readFile(directory, components.at(-1)!, SKILL_LIMITS.maximumResourceBytes)
        await checkRevision()
        signal.throwIfAborted()
        if (!file) throw new Error('Skill resource is unavailable')
        this.noSecrets(file.content)
        return file.content
      } finally { for (const directory of directories.reverse()) await this.closeDirectory(directory) }
    })
  }

  snapshot(signal?: AbortSignal): Promise<SkillCatalog> {
    return this.admit(signal, async owned => {
      const diagnostics: SkillDiagnostic[] = []
      const candidates: Candidate[] = [{ source: skillCreatorSource, document: parseSkillDocument(skillCreatorSource.content) }]
      let considered = 1
      let entries = 0
      let total = Buffer.byteLength(skillCreatorSource.content, 'utf8')
      const diagnose = (message: string, name?: string): void => {
        const diagnostic = { message: this.safeError(new Error(message)).message, ...(name ? { name } : {}) }
        try { this.noSecrets(diagnostic); diagnostics.push(Object.freeze(diagnostic)) }
        catch { diagnostics.push(Object.freeze({ message: 'A skill containing known credentials was excluded' })) }
      }
      for (const rootPath of [this.directory, ...this.roots]) {
        signal?.throwIfAborted()
        let root: Directory | undefined
        try {
          if (rootPath === this.directory && !owned) continue
          root = rootPath === this.directory ? owned! : await this.openDirectory(rootPath, false)
          const names: string[] = []
          const iterator = await opendir(this.ioPath(root))
          try {
            for await (const entry of iterator) {
              signal?.throwIfAborted()
              if (++entries > MAXIMUM_SCAN_ENTRIES) { diagnose('Skill scan entry limit reached; remaining entries were excluded'); break }
              if (entry.name === LOCK || entry.name.startsWith('.skills.')) continue
              if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
              if (++considered > SKILL_LIMITS.maximumSkills) { diagnose('Skill count limit reached; remaining entries were excluded'); break }
              names.push(entry.name)
            }
          } finally { await iterator.close().catch(() => undefined) }
          await this.checkDirectory(root)
          for (const name of names.sort()) {
            signal?.throwIfAborted()
            let skill: Directory | undefined
            try {
              validateSkillName(name)
              validateSkillResourcePath(name)
              validateSkillResourcePath(name.trim().normalize('NFKC'))
              skill = await this.childDirectory(root, name)
              if (!skill) throw new Error('Skill source changed during discovery')
              const remaining = SKILL_LIMITS.maximumTotalDocumentBytes - total
              if (remaining <= 0) throw new Error('Skill total document byte limit reached')
              const file = await this.readFile(skill, PRIMARY, Math.min(SKILL_LIMITS.maximumDocumentBytes, remaining))
              if (!file) throw new Error('Skill directory has no SKILL.md')
              total += file.bytes.length
              if (total > SKILL_LIMITS.maximumTotalDocumentBytes) throw new Error('Skill total document byte limit reached')
              const document = this.document(file, name)
              const binding: SourceBinding = { root: rootPath, rootEntry: root.entry, directoryEntry: skill.entry,
                name: document.metadata.name, directoryName: name, ownedRoot: rootPath === this.directory,
                revision: document.revision, readOnly: rootPath !== this.directory || name !== document.metadata.name }
              candidates.push({ document, binding, source: { content: file.content, readOnly: binding.readOnly,
                readResource: (request, context) => this.resource(binding, request, context.signal) } })
            } catch (error) {
              signal?.throwIfAborted()
              diagnose(this.safeError(error).message, name)
            } finally { if (skill) await this.closeDirectory(skill) }
          }
        } catch (error) { signal?.throwIfAborted(); diagnose(this.safeError(error).message) }
        finally { if (root && root !== owned) await this.closeDirectory(root) }
      }
      const counts = new Map<string, number>()
      for (const candidate of candidates) counts.set(candidate.document.metadata.name, (counts.get(candidate.document.metadata.name) ?? 0) + 1)
      const sources: SkillSource[] = []
      let summaryBytes = 2
      for (const candidate of candidates) {
        const name = candidate.document.metadata.name
        if ((counts.get(name) ?? 0) > 1 && candidate.binding) { diagnose('Duplicate skill name excluded; no source was silently shadowed', name); continue }
        this.noSecrets(candidate.document)
        const summary = { name, description: candidate.document.metadata.description, revision: candidate.document.revision,
          readOnly: candidate.source.readOnly ?? false }
        summaryBytes += Buffer.byteLength(JSON.stringify(summary), 'utf8') + (sources.length ? 1 : 0)
        if (summaryBytes > SKILL_LIMITS.maximumCatalogBytes) { diagnose('Skill catalog summary byte limit reached', name); continue }
        sources.push(candidate.source)
      }
      const catalog = createSkillCatalog(sources)
      this.latestDiagnostics = Object.freeze(diagnostics)
      signal?.throwIfAborted()
      this.noSecrets(catalog.skills)
      const guardedSkills = (): SkillCatalog['skills'] => {
        try { this.noSecrets(catalog.skills); return catalog.skills }
        catch (error) { throw this.safeError(error) }
      }
      return Object.freeze({
        get skills() { return guardedSkills() },
        document: (name: string) => {
          const document = catalog.document(name)
          this.noSecrets(document)
          return document
        },
        read: async (request: SkillReadRequest, context: { readonly signal: AbortSignal }) => {
          try {
            this.noSecrets(request)
            const content = await catalog.read(request, context)
            context.signal.throwIfAborted()
            this.noSecrets(content)
            return content
          } catch (error) { throw this.safeError(error) }
        }
      })
    })
  }

  private capture(proposal: SkillSaveProposal): SkillSaveProposal {
    plainData(proposal)
    this.noSecrets(proposal)
    if (Object.keys(proposal).length !== 4 || !['name', 'expectedRevision', 'before', 'after'].every(key => Object.hasOwn(proposal, key))) {
      throw new Error('Skill proposal has unsupported fields')
    }
    const name = canonicalName(proposal.name)
    if (name === 'skill-creator') throw new Error('Built-in skills are read-only')
    if (proposal.expectedRevision !== null && !/^[a-f0-9]{64}$/u.test(proposal.expectedRevision)) throw new Error('Skill expected revision must be null or SHA-256')
    const validate = (document: SkillDocument): SkillDocument => {
      const parsed = parseSkillDocument(document.content, name)
      if (parsed.warnings.length) throw new Error('Unsupported skill frontmatter must be reviewed before saving')
      if (JSON.stringify(parsed) !== JSON.stringify(document)) throw new Error('Skill proposal document does not match its exact source')
      this.noSecrets(parsed)
      return parsed
    }
    const before = proposal.before === null ? null : validate(proposal.before)
    const after = validate(proposal.after)
    if ((before?.revision ?? null) !== proposal.expectedRevision) throw new Error('Skill proposal before revision is stale')
    return freeze({ name, expectedRevision: proposal.expectedRevision, before, after })
  }
  private async assertWritableName(owned: Directory, name: string, signal?: AbortSignal): Promise<void> {
    let entries = 0
    for (const path of [this.directory, ...this.roots]) {
      signal?.throwIfAborted()
      const root = path === this.directory ? owned : await this.openDirectory(path, false)
      try {
        const iterator = await opendir(this.ioPath(root))
        try {
          for await (const entry of iterator) {
            signal?.throwIfAborted()
            if (++entries > MAXIMUM_SCAN_ENTRIES) throw new Error('Skill save cannot verify normalized aliases: scan entry limit reached')
            if (entry.name.trim().normalize('NFKC') === name &&
              (path !== this.directory || entry.name !== name)) {
              throw new Error('Additional-root or normalized-alias skills are read-only and cannot be shadowed')
            }
          }
        } finally { await iterator.close().catch(() => undefined) }
        await this.checkDirectory(root)
      } finally { if (root !== owned) await this.closeDirectory(root) }
    }
  }
  private async current(root: Directory, proposal: SkillSaveProposal): Promise<{ directory?: Directory; file?: StoredFile }> {
    const directory = await this.childDirectory(root, proposal.name)
    if (!directory) {
      if (proposal.expectedRevision !== null) throw new Error('Skill revision is stale; source no longer exists')
      return {}
    }
    try {
      const file = await this.readFile(directory, PRIMARY)
      const backup = await this.readFile(directory, BACKUP)
      if (backup) this.document(backup, proposal.name)
      if (!file && backup) throw new Error('Skill store is read-only: primary is missing but recovery evidence exists')
      const document = file ? this.document(file, proposal.name) : null
      if ((document?.revision ?? null) !== proposal.expectedRevision || document?.content !== proposal.before?.content) {
        throw new Error('Skill revision is stale; the exact current source differs from the approved draft')
      }
      return { directory, ...(file ? { file } : {}) }
    } catch (error) { await this.closeDirectory(directory); throw error }
  }
  /** Reject an approved write that a fresh bounded catalog could not discover next turn. */
  private async assertCapacity(owned: Directory, proposal: SkillSaveProposal, signal?: AbortSignal): Promise<void> {
    const creator = parseSkillDocument(skillCreatorSource.content)
    let count = 2 // The immutable creator and this proposal, replacing any owned source.
    let bytes = Buffer.byteLength(creator.content, 'utf8') + Buffer.byteLength(proposal.after.content, 'utf8')
    let entries = 0
    const summary = (document: SkillDocument, readOnly: boolean): number => Buffer.byteLength(JSON.stringify({
      name: document.metadata.name, description: document.metadata.description, revision: document.revision, readOnly
    }), 'utf8')
    let summaries = 3 + summary(creator, true) + summary(proposal.after, false)
    const withinLimits = (): void => {
      if (count > SKILL_LIMITS.maximumSkills || bytes > SKILL_LIMITS.maximumTotalDocumentBytes ||
        summaries > SKILL_LIMITS.maximumCatalogBytes) throw new Error('Skill save exceeds the next-turn catalog count, document or summary capacity; no skill was changed')
    }
    withinLimits()
    for (const path of [this.directory, ...this.roots]) {
      signal?.throwIfAborted()
      const root = path === this.directory ? owned : await this.openDirectory(path, false)
      try {
        const iterator = await opendir(this.ioPath(root))
        try {
          for await (const entry of iterator) {
            signal?.throwIfAborted()
            if (++entries > MAXIMUM_SCAN_ENTRIES) throw new Error('Skill save cannot verify capacity: scan entry limit reached')
            if (entry.name === LOCK || entry.name.startsWith('.skills.')) continue
            if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
            if (path === this.directory && entry.name === proposal.name) continue
            count++
            withinLimits()
            const child = await this.childDirectory(root, entry.name)
            if (!child) throw new Error('Skill source changed during capacity verification')
            try {
              const remaining = SKILL_LIMITS.maximumTotalDocumentBytes - bytes
              const file = await this.readFile(child, PRIMARY, Math.min(SKILL_LIMITS.maximumDocumentBytes, remaining))
              if (!file) continue
              bytes += file.bytes.length
              withinLimits()
              let document: SkillDocument
              try { document = this.document(file, entry.name) }
              catch (error) {
                // Unsupported/invalid documents are excluded from discovery, but their
                // candidates and bounded bytes still occupy conservative scan capacity.
                if (error instanceof Error && error.message.includes('known credentials')) throw error
                continue
              }
              summaries += summary(document, path !== this.directory || entry.name !== document.metadata.name) + 1
              withinLimits()
            } finally { await this.closeDirectory(child) }
          }
        } finally { await iterator.close().catch(() => undefined) }
        await this.checkDirectory(root)
      } finally { if (root !== owned) await this.closeDirectory(root) }
    }
    signal?.throwIfAborted()
    this.noSecrets(proposal)
  }
  prepare(proposal: SkillSaveProposal, signal?: AbortSignal): Promise<PreparedSkillSave> {
    let captured: SkillSaveProposal
    try { this.assertSaveSupported(); captured = this.capture(proposal) } catch (error) { return Promise.reject(this.safeError(error)) }
    return this.admit(signal, async root => {
      if (!root) throw new Error('Owned skill root is unavailable')
      await this.assertWritableName(root, captured.name, signal)
      const current = await this.current(root, captured)
      try { await this.assertCapacity(root, captured, signal) }
      finally { if (current.directory) await this.closeDirectory(current.directory) }
      signal?.throwIfAborted()
      this.noSecrets(captured)
      const result = freeze({ destination: join(this.directory, captured.name, PRIMARY),
        before: captured.before, after: captured.after, proposal: captured })
      this.noSecrets(result)
      return result
    })
  }
  private async checkTarget(directory: Directory, name: string, expected: StoredFile | undefined): Promise<void> {
    await this.checkDirectory(directory)
    let entry: Stats | undefined
    try { entry = await lstat(join(this.ioPath(directory), name)) } catch (error) { if (!missing(error)) throw error }
    if ((entry && !regular(entry, SKILL_LIMITS.maximumDocumentBytes, true)) || !!entry !== !!expected ||
      (entry && expected && !unchanged(entry, expected.entry))) throw new Error('Skill target changed before commit; files were preserved')
  }
  private async sync(directory: Directory): Promise<void> {
    if (process.platform === 'win32') return
    try {
      await this.checkDirectory(directory)
      await directory.handle!.sync()
      this.pendingDurability.delete(directory.path)
    } catch {
      this.pendingDurability.set(directory.path, directory.entry)
      this.report('Skill file replacement completed, but directory durability could not be confirmed; shutdown will retry')
    }
  }
  /** Resolve on committed rename. All later failures are safe notices, never rollback claims. */
  private async replace(directory: Directory, name: string, content: string, expected: StoredFile | undefined,
    beforeCommit: () => void, committed?: () => void): Promise<void> {
    const bytes = Buffer.from(content, 'utf8')
    if (bytes.length > SKILL_LIMITS.maximumDocumentBytes) throw new Error('Skill document exceeds the byte limit')
    await this.checkTarget(directory, name, expected)
    const temporary = `.skills.${randomUUID()}.tmp`
    const io = join(this.ioPath(directory), temporary)
    const file = await open(io, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
    let initial: Stats | undefined
    let renamed = false
    try {
      initial = await file.stat()
      if (!regular(initial, SKILL_LIMITS.maximumDocumentBytes, true)) throw new Error('Skill temporary file must be private and regular')
      await this.checkDirectory(directory)
      beforeCommit()
      await file.writeFile(bytes)
      await file.sync()
      const saved = await file.stat()
      await file.close()
      await this.checkTarget(directory, name, expected)
      const current = await lstat(io)
      if (!regular(current, SKILL_LIMITS.maximumDocumentBytes, true) || !unchanged(saved, current)) throw new Error('Skill temporary file changed before commit')
      beforeCommit()
      await rename(io, join(this.ioPath(directory), name))
      renamed = true
      committed?.()
      await this.sync(directory)
    } finally {
      await file.close().catch(() => undefined)
      try {
        await this.checkDirectory(directory)
        const current = await lstat(io)
        if (initial && sameFile(current, initial)) await unlink(io)
      } catch (error) { if (!missing(error) && renamed) this.report('Skill file replacement completed; temporary-file cleanup could not be confirmed') }
    }
  }
  commit(proposal: SkillSaveProposal, options: { readonly signal?: AbortSignal } = {}): Promise<SkillCommitReceipt> {
    let captured: SkillSaveProposal
    try { this.assertSaveSupported(); captured = this.capture(proposal) } catch (error) { return Promise.reject(this.safeError(error)) }
    return this.admit(options.signal, async root => {
      if (!root) throw new Error('Owned skill root is unavailable')
      await this.assertWritableName(root, captured.name, options.signal)
      const current = await this.current(root, captured)
      let directory = current.directory
      let receipt: SkillCommitReceipt | undefined
      try {
        await this.assertCapacity(root, captured, options.signal)
        options.signal?.throwIfAborted()
        this.noSecrets(captured)
        if (!directory) {
          directory = await this.childDirectory(root, captured.name, true)
          if (!directory) throw new Error('Could not create the owned skill directory')
          await this.sync(root)
        }
        const beforeCommit = (): void => { options.signal?.throwIfAborted(); this.noSecrets(captured) }
        if (current.file) {
          const backup = await this.readFile(directory, BACKUP)
          if (backup) this.document(backup, captured.name)
          await this.replace(directory, BACKUP, current.file.content, backup, beforeCommit)
        }
        beforeCommit()
        await this.replace(directory, PRIMARY, captured.after.content, current.file, beforeCommit, () => {
          receipt = Object.freeze({ committed: true, futureTurn: true, name: captured.name, revision: captured.after.revision })
          this.committedReceipts.push(receipt)
        })
        return this.safeReceipt(receipt!)
      } catch (error) {
        if (receipt) { this.report('Skill changes committed; post-commit verification could not be completed'); return this.safeReceipt(receipt) }
        throw error
      } finally { if (directory) await this.closeDirectory(directory) }
    })
  }
  private async acquire(directory: Directory, signal?: AbortSignal): Promise<() => Promise<void>> {
    const target = join(this.ioPath(directory), LOCK)
    const deadline = Date.now() + SKILL_LOCK_WAIT_MS
    let file: FileHandle
    while (true) {
      signal?.throwIfAborted()
      await this.checkDirectory(directory)
      try { file = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); break }
      catch (error) {
        if (!exists(error)) throw error
        if (Date.now() >= deadline) throw new Error('Skills are locked by another CLI process. Retry later; after a crash verify the owning process has stopped before removing .skills.lock. Locks are never stolen automatically')
        await new Promise<void>((done, reject) => {
          const finish = (): void => { signal?.removeEventListener('abort', abort); done() }
          const timer = setTimeout(finish, 25)
          const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason) }
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
        })
      }
    }
    let entry: Stats
    try { entry = await file.stat() } catch (error) { await file.close().catch(() => undefined); throw error }
    const release = async (): Promise<void> => {
      await this.checkDirectory(directory)
      const current = await lstat(target)
      if (!regular(current, 4096, true) || !sameFile(current, entry)) throw new Error('Skill lease changed; it was preserved')
      await unlink(target)
    }
    try {
      if (!regular(entry, 4096, true)) throw new Error('Skill lease must be private and regular')
      await this.checkDirectory(directory)
      await file.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() }), 'utf8')
      await file.sync()
      await file.close()
      await this.checkDirectory(directory)
    } catch (error) { await file.close().catch(() => undefined); await release().catch(() => undefined); throw error }
    return release
  }
  private admit<T>(signal: AbortSignal | undefined, action: (directory: Directory | undefined) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Skill store is closing; no new operations are accepted'))
    const job = this.chain.then(async () => {
      signal?.throwIfAborted()
      // Read-only fallback platforms do not create directories or lease files.
      // Existing roots are checked before/after reads; missing owned roots simply
      // leave the creator and explicitly supplied imports available.
      let directory: Directory | undefined
      try { directory = await this.openDirectory(this.directory, true, this.writable) }
      catch (error) { if (this.writable || !missing(error)) throw error }
      let release: (() => Promise<void>) | undefined
      try {
        if (directory && this.writable) release = await this.acquire(directory, signal)
        signal?.throwIfAborted()
        return await action(directory)
      } finally {
        if (release) await release().catch(() => this.report('Skill lease cleanup failed; inspect the owning process and lock before retrying'))
        if (directory) await this.closeDirectory(directory)
      }
    }).then(result => {
      // A credential may be registered while lease/directory cleanup is awaiting I/O.
      if (result && typeof result === 'object' && 'committed' in result && result.committed === true) {
        return this.safeReceipt(result as unknown as SkillCommitReceipt) as T
      }
      this.noSecrets(result)
      return result
    }).catch((error: unknown) => { throw this.safeError(error) })
    this.jobs.add(job)
    this.chain = job.catch(() => undefined)
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job))
    return job
  }
  async drain(options: { readonly close?: boolean } = {}): Promise<void> {
    if (options.close) this.closed = true
    while (this.jobs.size) await Promise.allSettled([...this.jobs])
    for (const [path, entry] of [...this.pendingDurability]) {
      let directory: Directory | undefined
      try {
        directory = await this.openDirectory(path, true)
        if (!sameFile(directory.entry, entry)) throw new Error('Skill directory changed while durability was pending')
        await this.sync(directory)
      } catch { this.report('Skill changes committed, but shutdown could not confirm directory durability; original files were retained') }
      finally { if (directory) await this.closeDirectory(directory) }
    }
  }
}
