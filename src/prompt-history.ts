// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

export const MAX_PROMPT_HISTORY = 100
const MAX_PROMPT_LENGTH = 65536
// JSON can expand a UTF-16 code unit to six bytes.
const MAX_HISTORY_BYTES = MAX_PROMPT_HISTORY * (MAX_PROMPT_LENGTH * 6 + 4) + 64
interface Draft { text: string; cursor: number }

/** Oldest first. Browsing edits are temporary and never mutate submitted history. */
export class PromptHistory {
  private entries: string[]
  private index: number
  private drafts = new Map<number, Draft>()

  constructor(entries: readonly string[] = []) {
    this.entries = entries.filter(text => text.trim() && text.length <= MAX_PROMPT_LENGTH).slice(-MAX_PROMPT_HISTORY)
    this.index = this.entries.length
  }
  reset(): void { this.index = this.entries.length; this.drafts.clear() }
  add(text: string): void {
    if (text.trim() && text.length <= MAX_PROMPT_LENGTH && this.entries.at(-1) !== text) {
      this.entries.push(text)
      this.entries = this.entries.slice(-MAX_PROMPT_HISTORY)
    }
    this.reset()
  }
  move(direction: -1 | 1, current: Draft): Draft | undefined {
    const next = Math.max(0, Math.min(this.entries.length, this.index + direction))
    if (next === this.index) return undefined
    this.drafts.set(this.index, { ...current })
    this.index = next
    const saved = this.drafts.get(next)
    if (saved) return { ...saved }
    const text = this.entries[next] ?? ''
    // Start recalled multiline entries on their first line so repeated Up keeps browsing.
    return { text, cursor: direction === -1 && text.includes('\n') ? 0 : text.length }
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
function ownedPrivate(info: Stats): boolean {
  return process.platform === 'win32' || ((info.mode & 0o077) === 0 && info.uid === process.getuid?.())
}
function privateFile(info: Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && ownedPrivate(info) && info.size <= MAX_HISTORY_BYTES
}

/** One harness-wide file, independent of workspace, provider and conversation. */
export class PromptHistoryStore {
  readonly directory: string
  private chain: Promise<void> = Promise.resolve()
  constructor(directory: string) { this.directory = resolve(directory) }

  private async checkDirectory(): Promise<Stats | undefined> {
    let info: Stats
    try { info = await lstat(this.directory) }
    catch (error) { if (hasCode(error, 'ENOENT')) return; throw error }
    if (!info.isDirectory() || info.isSymbolicLink() || !ownedPrivate(info)) {
      throw new Error('Prompt history requires a private profile directory')
    }
    return info
  }
  async load(): Promise<string[]> {
    const directory = await this.checkDirectory()
    if (!directory) return []
    const target = join(this.directory, 'prompt-history.json')
    let entry: Stats
    try { entry = await lstat(target) }
    catch (error) { if (hasCode(error, 'ENOENT')) return []; throw error }
    if (!privateFile(entry)) throw new Error('Prompt history must be a bounded private regular file')
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      const currentDirectory = await this.checkDirectory()
      if (!privateFile(info) || info.dev !== entry.dev || info.ino !== entry.ino ||
        !currentDirectory || currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino) {
        throw new Error('Prompt history file changed')
      }
      const buffer = Buffer.alloc(info.size + 1)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null)
        if (!bytesRead) break
        offset += bytesRead
      }
      if (offset > info.size) throw new Error('Prompt history file changed')
      const parsed: unknown = JSON.parse(buffer.subarray(0, offset).toString('utf8'))
      if (!Array.isArray(parsed) || parsed.length > MAX_PROMPT_HISTORY ||
        !parsed.every(text => typeof text === 'string' && text.trim() && text.length <= MAX_PROMPT_LENGTH)) {
        throw new Error('Invalid prompt history')
      }
      return parsed
    } finally { await file.close() }
  }
  append(text: string): Promise<void> {
    if (!text.trim() || text.length > MAX_PROMPT_LENGTH) return Promise.resolve()
    const job = this.chain.then(() => this.save(text))
    this.chain = job.catch(() => undefined)
    return job
  }
  async drain(): Promise<void> { await this.chain }

  private async save(text: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const directory = await this.checkDirectory()
    if (!directory) throw new Error('Prompt history directory unavailable')
    const lockPath = join(this.directory, 'prompt-history.json.lock')
    const deadline = Date.now() + 2000
    let lock
    // Reload under a short writer lease so simultaneous harnesses retain each other's prompts.
    for (;;) {
      try { lock = await open(lockPath, 'wx', 0o600); break }
      catch (error) {
        if (!hasCode(error, 'EEXIST') || Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    const temporary = join(this.directory, `.prompt-history.${randomUUID()}.tmp`)
    try {
      const entries = await this.load()
      if (entries.at(-1) === text) return
      entries.push(text)
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(`${JSON.stringify(entries.slice(-MAX_PROMPT_HISTORY))}\n`, 'utf8')
        await file.sync()
      } finally { await file.close() }
      const current = await this.checkDirectory()
      if (!current || current.dev !== directory.dev || current.ino !== directory.ino) throw new Error('Prompt history directory changed')
      await rename(temporary, join(this.directory, 'prompt-history.json'))
    } finally {
      await unlink(temporary).catch(() => undefined)
      await lock.close()
      await unlink(lockPath)
    }
  }
}
