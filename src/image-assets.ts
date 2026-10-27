// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs'
import { lstat, mkdir, open, link, unlink, opendir } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { HistoryMessage, ToolImageReference } from '@ayayaq/vivi'
import { isSessionId } from './session.js'

export const IMAGE_LIMITS = Object.freeze({ bytes: 5 * 1024 * 1024, pixels: 16_000_000,
  dimension: 8192, sessionBytes: 64 * 1024 * 1024, sessionImages: 32 })
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return (value ^ 0xffffffff) >>> 0
}

/** Inspect the actual local encoding, never the extension or caller-provided metadata. */
export function imageMetadata(input: Uint8Array): Omit<ToolImageReference, 'id' | 'sha256'> {
  const bytes = Buffer.from(input)
  check(bytes.length > 0 && bytes.length <= IMAGE_LIMITS.bytes, 'Image exceeds the 5 MiB byte limit')
  let mimeType: ToolImageReference['mimeType'], width = 0, height = 0
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    mimeType = 'image/png'
    check(bytes.length >= 45 && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR', 'Invalid PNG header')
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20)
    let offset = 8, ended = false, pixels = false
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), name = bytes.toString('ascii', offset + 4, offset + 8)
      check(size <= bytes.length - offset - 12, 'Invalid PNG chunk length')
      check(crc32(bytes.subarray(offset + 4, offset + 8 + size)) === bytes.readUInt32BE(offset + 8 + size), 'Invalid PNG chunk checksum')
      if (name === 'IDAT') pixels = true
      offset += size + 12
      if (name === 'IEND') { check(size === 0 && offset === bytes.length, 'Invalid PNG ending'); ended = true; break }
    }
    check(ended && pixels, 'PNG image data is incomplete')
  } else {
    mimeType = 'image/jpeg'
    check(bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9,
      'Only PNG and JPEG image encodings are supported')
    let offset = 2, scan = false
    while (offset < bytes.length - 2) {
      check(bytes[offset++] === 0xff, 'Invalid JPEG marker')
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]!
      if (marker === 0xda) {
        check(offset + 2 <= bytes.length, 'Invalid JPEG scan')
        const length = bytes.readUInt16BE(offset)
        scan = length >= 2 && offset + length < bytes.length - 2
        break
      }
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue
      check(offset + 2 <= bytes.length, 'Invalid JPEG segment')
      const size = bytes.readUInt16BE(offset)
      check(size >= 2 && size <= bytes.length - offset, 'Invalid JPEG segment length')
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        check(size >= 8, 'Invalid JPEG frame')
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5)
      }
      offset += size
    }
    check(scan && width > 0 && height > 0, 'JPEG requires a baseline or progressive frame and image data')
  }
  check(width > 0 && height > 0 && width <= IMAGE_LIMITS.dimension && height <= IMAGE_LIMITS.dimension &&
    width * height <= IMAGE_LIMITS.pixels, 'Image exceeds the 8192-pixel dimension or 16-megapixel limit')
  return { mimeType, width, height, byteLength: bytes.length }
}

export interface CliImageAssets {
  snapshot(bytes: Uint8Array, signal: AbortSignal): Promise<ToolImageReference>
  preload(history: readonly HistoryMessage[], signal: AbortSignal): Promise<void>
  resolve(reference: ToolImageReference): Uint8Array
  accepted(references: readonly ToolImageReference[]): void
  finish(): Promise<void>
}

/** Host-owned immutable snapshots. The transcript contains metadata, never image payloads or local source paths. */
export class FileImageAssets implements CliImageAssets {
  readonly directory: string
  private readonly root: string
  private readonly cache = new Map<string, { reference: ToolImageReference; bytes: Buffer }>()
  private readonly created = new Set<string>()
  private readonly retained = new Set<string>()
  private recovered = false
  constructor(directory: string, sessionId: string) {
    check(isSessionId(sessionId), 'Invalid image session identity')
    this.root = resolve(directory)
    this.directory = join(this.root, sessionId)
  }
  private path(id: string): string {
    check(/^sha256:[a-f0-9]{64}$/.test(id), 'Invalid image snapshot identity')
    return join(this.directory, `${id.slice(7)}.image`)
  }
  private async prepare(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const root = await lstat(this.root)
    check(root.isDirectory() && !root.isSymbolicLink() && (process.platform === 'win32' ||
      (root.mode & 0o077) === 0 && root.uid === process.getuid?.()), 'Image root must be a private owned directory')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    check(info.isDirectory() && !info.isSymbolicLink() && (process.platform === 'win32' ||
      (info.mode & 0o077) === 0 && info.uid === process.getuid?.()), 'Image store must be a private owned directory')
    if (!this.recovered) {
      // The application holds its exclusive session lease before using this
      // store. Recover only this writer's bounded UUID staging names; accepted
      // content-addressed snapshots are never garbage-collected here.
      const entries = await opendir(this.directory)
      let count = 0
      try {
        for await (const entry of entries) {
          check(++count <= IMAGE_LIMITS.sessionImages + 8, 'Image store recovery entry limit reached')
          if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(entry.name)) continue
          const staged = await lstat(join(this.directory, entry.name))
          check(staged.isFile() && !staged.isSymbolicLink() && staged.size <= IMAGE_LIMITS.bytes &&
            (process.platform === 'win32' || staged.uid === process.getuid?.()), 'Invalid image staging entry')
          await unlink(join(this.directory, entry.name))
        }
      } finally { await entries.close().catch(() => undefined) }
      this.recovered = true
    }
  }
  private verify(reference: ToolImageReference, bytes: Buffer): void {
    const metadata = imageMetadata(bytes), sha256 = hash(bytes)
    check(reference.id === `sha256:${sha256}` && reference.sha256 === sha256 &&
      Object.entries(metadata).every(([key, value]) => reference[key as keyof ToolImageReference] === value),
    'Image snapshot is missing, changed, or inconsistent; no image request was dispatched')
  }
  private admit(reference: ToolImageReference, bytes: Buffer): void {
    this.verify(reference, bytes)
    if (!this.cache.has(reference.id)) {
      check(this.cache.size < IMAGE_LIMITS.sessionImages && bytes.length + [...this.cache.values()].reduce((sum, value) => sum + value.bytes.length, 0) <= IMAGE_LIMITS.sessionBytes,
        'Image context exceeds the 32-snapshot / 64 MiB active-session limit; start a new session')
      this.cache.set(reference.id, { reference: structuredClone(reference), bytes: Buffer.from(bytes) })
    }
  }
  private async load(reference: ToolImageReference, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted(); await this.prepare(); signal.throwIfAborted()
    const handle = await open(this.path(reference.id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await handle.stat()
      check(before.isFile() && before.nlink === 1 && before.size === reference.byteLength && before.size <= IMAGE_LIMITS.bytes,
        'Image snapshot is unavailable or has an invalid size')
      const bytes = Buffer.alloc(before.size + 1)
      let offset = 0
      while (offset < bytes.length) {
        signal.throwIfAborted()
        const read = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (!read.bytesRead) break
        offset += read.bytesRead
      }
      const after = await handle.stat()
      check(offset === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs,
        'Image snapshot changed while reading')
      signal.throwIfAborted(); this.admit(reference, bytes.subarray(0, offset))
    } finally { await handle.close() }
  }
  async snapshot(input: Uint8Array, signal: AbortSignal): Promise<ToolImageReference> {
    signal.throwIfAborted()
    const bytes = Buffer.from(input), metadata = imageMetadata(bytes), sha256 = hash(bytes)
    const reference: ToolImageReference = { id: `sha256:${sha256}`, sha256, ...metadata }
    this.admit(reference, bytes)
    await this.prepare(); signal.throwIfAborted()
    let existing = false, count = 0, total = 0
    const entries = await opendir(this.directory)
    try {
      for await (const entry of entries) {
        signal.throwIfAborted()
        check(++count <= IMAGE_LIMITS.sessionImages + 8, 'Image store entry limit reached; start a new session')
        check(entry.isFile() && /^[a-f0-9]{64}\.image$/.test(entry.name), 'Image store contains an unexpected entry')
        const info = await lstat(join(this.directory, entry.name))
        check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= IMAGE_LIMITS.bytes, 'Invalid stored image snapshot')
        total += info.size
        if (entry.name === `${sha256}.image`) existing = true
      }
    } finally { await entries.close().catch(() => undefined) }
    check(existing || count < IMAGE_LIMITS.sessionImages && total + bytes.length <= IMAGE_LIMITS.sessionBytes,
      'Image store exceeds the 32-snapshot / 64 MiB session limit; start a new session')
    const temporary = join(this.directory, `${randomUUID()}.tmp`)
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    let published = false
    try {
      await file.writeFile(bytes); await file.sync(); await file.close(); signal.throwIfAborted()
      try { await link(temporary, this.path(reference.id)); published = true; this.created.add(reference.id) }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
      await unlink(temporary)
      await this.load(reference, signal)
      if (process.platform !== 'win32') {
        const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { await directory.sync() } finally { await directory.close() }
      }
      signal.throwIfAborted()
      return structuredClone(reference)
    } catch (error) {
      await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined)
      if (published && !this.retained.has(reference.id)) { await unlink(this.path(reference.id)).catch(() => undefined); this.created.delete(reference.id) }
      throw error
    }
  }
  async preload(history: readonly HistoryMessage[], signal: AbortSignal): Promise<void> {
    try {
      const references = history.flatMap(message => message.kind === 'tool_result' ? message.images ?? [] : [])
      // Stage a fresh verified map for the final prepared request, after compaction.
      // Never reopen an original workspace path or load pixels for summaries.
      this.cache.clear()
      for (const reference of references) {
        signal.throwIfAborted()
        if (!this.cache.has(reference.id)) await this.load(reference, signal)
        else this.verify(reference, this.cache.get(reference.id)!.bytes)
        this.retained.add(reference.id)
      }
      signal.throwIfAborted()
    } catch {
      this.cache.clear(); signal.throwIfAborted()
      throw new Error('A required image snapshot is unavailable, invalid, or exceeds image-context limits. Restore the private session image files or start a new session. Original workspace paths will not be reopened; no image request was dispatched.')
    }
  }
  resolve(reference: ToolImageReference): Uint8Array {
    const found = this.cache.get(reference.id)
    check(found, 'Image snapshot was not prepared for this dispatch')
    this.verify(reference, found.bytes)
    return Uint8Array.from(found.bytes)
  }
  accepted(references: readonly ToolImageReference[]): void { for (const reference of references) this.retained.add(reference.id) }
  async finish(): Promise<void> {
    this.cache.clear()
    for (const id of this.created) if (!this.retained.has(id)) await unlink(this.path(id)).catch(() => undefined)
    this.created.clear()
  }
}
