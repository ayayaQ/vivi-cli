// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, parse, relative, resolve, sep } from 'node:path'
import {
  createSkillCatalog, parseSkillDocument, SKILL_LIMITS, skillCreatorSource,
  validateSkillName, validateSkillResourcePath
} from '@ayayaq/vivi/extensions/skills'
import type {
  SkillCatalog, SkillDocument, SkillReadRequest, SkillSource
} from '@ayayaq/vivi/extensions/skills'

const LOCK = '.skills.lock'
const PRIMARY = 'SKILL.md'
const MAXIMUM_SCAN_ENTRIES = 1_024

export interface SkillStoreOptions {
  /** Explicit host-approved additional roots. Never inferred from a working directory. */
  readonly readOnlyRoots?: readonly string[]
  readonly secrets?: readonly string[]
  readonly notice?: (message: string) => void
}
export interface SkillDiagnostic { readonly message: string; readonly name?: string }
export interface CliSkillStore {
  readonly directory: string
  /** All skill sources are read-only in this release. */
  readonly writable: false
  readonly diagnostics: readonly string[]
  snapshot(signal?: AbortSignal): Promise<SkillCatalog>
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
  readonly directoryEntry: Stats
  readonly revision: string
  readonly readOnly: boolean
}
interface Candidate { readonly source: SkillSource; readonly document: SkillDocument; readonly binding?: SourceBinding }

function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT' }
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino !== 0 && left.ino === right.ino }
function unchanged(left: Stats, right: Stats): boolean {
  return sameFile(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}
function ownedPrivate(info: Stats): boolean {
  return process.platform === 'win32' || ((info.mode & 0o077) === 0 && info.uid === process.getuid?.())
}
function regular(info: Stats, maximum: number, privateFile: boolean): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= maximum && (!privateFile || ownedPrivate(info))
}
function safeResource(path: string): void {
  validateSkillResourcePath(path)
  const forbidden = /^(?:\.git|\.aws|\.codex|\.env(?:[._-].*)?|credentials?(?:[._-].*)?|auth(?:[._-].*)?|tokens?(?:[._-].*)?|passwords?(?:[._-].*)?|secrets?(?:[._-].*)?|private[-_]keys?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|sessions?(?:[._-].*)?|preferences?(?:[._-].*)?|memories?(?:[._-].*)?|.*\.(?:pem|key|p12|pfx))$/iu
  if (path.split('/').some(component => forbidden.test(component))) {
    throw new Error('Credential, session and host-state paths are unavailable as skill resources')
  }
}

/** App-wide read-only SKILL.md discovery and bounded progressive text reads. */
export class FileSkillStore implements CliSkillStore {
  readonly directory: string
  private readonly roots: readonly string[]
  private readonly secrets = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()
  private readonly jobs = new Set<Promise<unknown>>()
  private closed = false
  private latestDiagnostics: readonly SkillDiagnostic[] = Object.freeze([])

  constructor(directory: string, options: SkillStoreOptions = {}) {
    this.directory = resolve(directory)
    this.roots = Object.freeze([...new Set((options.readOnlyRoots ?? []).map(root => resolve(root)))])
    if (this.roots.length > 8) throw new Error('At most eight explicitly supplied skill roots are supported')
    this.addSecrets(options.secrets ?? [])
  }

  get writable(): false { return false }

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
    message = message.replace(/[\u0000-\u001f\u007f-\u009f]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
    const result = new Error(message)
    if (error instanceof Error && error.name === 'AbortError') result.name = 'AbortError'
    return result
  }
  get diagnostics(): readonly string[] {
    return Object.freeze(this.latestDiagnostics.map(diagnostic => {
      try { this.noSecrets(diagnostic); return `${diagnostic.name ? `${JSON.stringify(diagnostic.name).replace(/[\u0000-\u001f\u007f-\u009f]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)}: ` : ''}${diagnostic.message}` }
      catch { return 'A skill containing known credentials was excluded' }
    }))
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
    // Windows may expand 8.3 paths and normalize letter case. Identity, not
    // byte equality (or blanket case folding on APFS), proves that this canonical
    // spelling denotes the already checked directory. Every supplied ancestor
    // remains independently checked for reparse/symlink entries and identity.
    const canonicalEntry = await lstat(canonical)
    if (!canonicalEntry.isDirectory() || canonicalEntry.isSymbolicLink() || !sameFile(canonicalEntry, directory.entry)) {
      throw new Error('Canonical skill directory identity differs from the approved directory')
    }
    const current = await lstat(directory.path)
    if (!sameFile(current, directory.entry) || (directory.private && !ownedPrivate(current))) {
      throw new Error('Skill directory changed or is not an owned private directory')
    }
  }
  private async closeDirectory(directory: Directory): Promise<void> {
    for (const handle of [...directory.handles].reverse()) await handle.close().catch(() => undefined)
  }
  private async openDirectory(path: string, privateDirectory: boolean): Promise<Directory> {
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
        const entry = await lstat(io)
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
  private async childDirectory(parent: Directory, name: string): Promise<Directory | undefined> {
    validateSkillResourcePath(name)
    if (name.includes('/')) throw new Error('Skill directory must be one path component')
    await this.checkDirectory(parent)
    const path = join(parent.path, name)
    const io = join(this.ioPath(parent), name)
    let entry: Stats
    try { entry = await lstat(io) }
    catch (error) { if (missing(error)) return undefined; throw error }
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
    if (document.warnings.length) throw new Error('Skill is read-only: unsupported frontmatter fields must be reviewed before discovery')
    return document
  }
  private async approvedExternalRoot(path: string, signal?: AbortSignal): Promise<Directory> {
    const root = await this.openDirectory(path, false)
    let profile: Directory | undefined
    try {
      let nearest = dirname(this.directory)
      let complete = true
      for (;;) {
        signal?.throwIfAborted()
        try { profile = await this.openDirectory(nearest, false); break }
        catch (error) {
          if (!missing(error)) throw error
          const parent = dirname(nearest)
          if (parent === nearest) throw error
          nearest = parent; complete = false
        }
      }
      const rootContainsProfile = profile.ancestry.some(item => sameFile(item.entry, root.entry))
      const profileContainsRoot = complete && root.ancestry.some(item => sameFile(item.entry, profile!.entry))
      if (rootContainsProfile || profileContainsRoot) {
        throw new Error('Additional skill root overlaps the host-state profile; it was excluded')
      }
      await this.checkDirectory(root)
      await this.checkDirectory(profile)
      return root
    } catch (error) { await this.closeDirectory(root); throw error }
    finally { if (profile) await this.closeDirectory(profile) }
  }
  private async resource(binding: SourceBinding, request: SkillReadRequest, signal: AbortSignal): Promise<string> {
    return this.admit(signal, async (_owned, ownedError) => {
      signal.throwIfAborted()
      if (binding.root === this.directory && ownedError) throw ownedError
      safeResource(request.path)
      if (request.name !== binding.name || request.expectedRevision !== binding.revision) throw new Error('Skill resource revision is stale')
      const root = binding.root === this.directory ? await this.openDirectory(binding.root, false) : await this.approvedExternalRoot(binding.root, signal)
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
    return this.admit(signal, async (owned, ownedError) => {
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
      if (ownedError) diagnose(`Owned skill folder unavailable: ${this.safeError(ownedError).message}`)
      const scannedRoots = new Set<string>()
      for (const [rootIndex, rootPath] of [this.directory, ...this.roots].entries()) {
        signal?.throwIfAborted()
        let root: Directory | undefined
        try {
          if (rootIndex === 0 && !owned) continue
          root = rootIndex === 0 ? owned! : await this.approvedExternalRoot(rootPath, signal)
          const identity = `${root.entry.dev}:${root.entry.ino}`
          if (scannedRoots.has(identity)) { diagnose('Repeated import root denotes an already scanned directory; duplicate discovery omitted'); continue }
          scannedRoots.add(identity)
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
                name: document.metadata.name, directoryName: name,
                revision: document.revision, readOnly: true }
              candidates.push({ document, binding, source: { content: file.content, readOnly: binding.readOnly,
                readResource: (request, context) => this.resource(binding, request, context.signal) } })
            } catch (error) {
              signal?.throwIfAborted()
              diagnose(this.safeError(error).message, name)
            } finally { if (skill) await this.closeDirectory(skill) }
          }
        } catch (error) { signal?.throwIfAborted(); diagnose(`Root ${JSON.stringify(this.safeError(new Error(rootPath)).message)}: ${this.safeError(error).message}`) }
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

  private admit<T>(signal: AbortSignal | undefined, action: (directory: Directory | undefined, ownedError?: Error) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Skill store is closed'))
    const job = this.chain.then(async () => {
      signal?.throwIfAborted()
      let directory: Directory | undefined
      let ownedError: Error | undefined
      try { directory = await this.openDirectory(this.directory, false) }
      catch (error) { if (!missing(error)) ownedError = this.safeError(error) }
      try { return await action(directory, ownedError) }
      finally { if (directory) await this.closeDirectory(directory) }
    }).then(result => { this.noSecrets(result); return result }).catch(error => { throw this.safeError(error) })
    this.jobs.add(job)
    this.chain = job.catch(() => undefined)
    void job.then(() => this.jobs.delete(job), () => this.jobs.delete(job))
    return job
  }

  async drain(options: { readonly close?: boolean } = {}): Promise<void> {
    if (options.close) this.closed = true
    while (this.jobs.size) await Promise.allSettled([...this.jobs])
  }
}
