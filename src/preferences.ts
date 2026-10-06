// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import type { ReasoningEffort } from '@ayayaq/vivi/providers/openrouter'
import { isSessionId } from './session.js'
import type { CliProviderName, FileSessionStore } from './session.js'
import { sessionDisplayTitle } from './session-display.js'

export const MAX_PREFERENCES_BYTES = 8 * 1024
export const MAX_SESSION_PICKER_ITEMS = 100
export const MAX_SESSION_LIST_ENTRIES = 1000
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const preferenceKeys = ['schemaVersion', 'provider', 'model', 'reasoning',
  'reasoningCapabilities', 'stream', 'enableTools', 'enableNotes', 'enableMemory', 'maxRounds'] as const
const legacyPreferenceKeys = preferenceKeys.filter(key => key !== 'enableMemory')

/** Host preferences only. Credentials, transcripts, prompts and paths are never settings. */
export interface TuiPreferences {
  schemaVersion: 1
  provider: CliProviderName
  model: string
  reasoning: string
  reasoningCapabilities: ReasoningEffort[]
  stream: boolean
  enableTools: boolean
  enableNotes: boolean
  /** Future launch default; persistent context is independent of model tool support. */
  enableMemory: boolean
  maxRounds: number
}

export interface SessionPickerEntry {
  id: string
  title: string
  provider: CliProviderName
  model: string
  reasoning?: string
  updatedAt: string
  locked: boolean
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid TUI preferences: ${message}`)
}

function secretPresent(encoded: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.length > 0 &&
    (encoded.includes(secret) || encoded.includes(JSON.stringify(secret).slice(1, -1))))
}

/** Build a fresh whitelist object without invoking getters or user-defined JSON hooks. */
export function validatePreferences(value: unknown, secrets: readonly string[] = []): TuiPreferences {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected object')
  check(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    'expected plain object')
  check(Object.getOwnPropertySymbols(value).length === 0, 'unexpected field')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors)
  const legacy = keys.length === legacyPreferenceKeys.length &&
    keys.every(key => legacyPreferenceKeys.includes(key as typeof legacyPreferenceKeys[number]))
  check(legacy || (keys.length === preferenceKeys.length &&
    keys.every((key) => preferenceKeys.includes(key as typeof preferenceKeys[number]))),
  'unexpected or missing field')
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of preferenceKeys) {
    if (key === 'enableMemory' && legacy) { fields[key] = false; continue }
    const descriptor = descriptors[key]
    check(descriptor && descriptor.enumerable && 'value' in descriptor, 'expected enumerable data fields')
    fields[key] = descriptor.value
  }
  check(fields.schemaVersion === 1, 'unsupported schema version')
  check(fields.provider === 'openai' || fields.provider === 'openrouter', 'unsupported provider')
  check(typeof fields.model === 'string' && fields.model.length <= 200 &&
    fields.model.trim() === fields.model && !/[\u0000-\u001f\u007f-\u009f]/.test(fields.model), 'invalid model')
  check(typeof fields.reasoning === 'string' &&
    (fields.reasoning === 'default' || efforts.includes(fields.reasoning as ReasoningEffort)), 'invalid reasoning')
  const capabilities = fields.reasoningCapabilities
  check(Array.isArray(capabilities) && Object.getPrototypeOf(capabilities) === Array.prototype &&
    capabilities.length <= efforts.length && Object.getOwnPropertySymbols(capabilities).length === 0,
  'invalid reasoning capabilities')
  const capabilityDescriptors = Object.getOwnPropertyDescriptors(capabilities)
  check(Object.keys(capabilityDescriptors).length === capabilities.length + 1, 'invalid reasoning capabilities')
  const supported: ReasoningEffort[] = []
  for (let index = 0; index < capabilities.length; index++) {
    const descriptor = capabilityDescriptors[String(index)]
    check(descriptor && descriptor.enumerable && 'value' in descriptor &&
      efforts.includes(descriptor.value as ReasoningEffort) && !supported.includes(descriptor.value as ReasoningEffort),
    'invalid reasoning capabilities')
    supported.push(descriptor.value as ReasoningEffort)
  }
  check(fields.reasoning === 'default' || supported.includes(fields.reasoning as ReasoningEffort),
    'selected reasoning requires an explicit supported capability')
  check(typeof fields.stream === 'boolean' && typeof fields.enableTools === 'boolean' &&
    typeof fields.enableNotes === 'boolean' && typeof fields.enableMemory === 'boolean', 'invalid toggle')
  check(!fields.enableNotes || fields.enableTools, 'notes require explicitly enabled tools')
  check(fields.model !== '' || (fields.reasoning === 'default' && supported.length === 0 && !fields.enableTools && !fields.enableNotes),
    'unselected model cannot declare capabilities')
  check(Number.isSafeInteger(fields.maxRounds) && Number(fields.maxRounds) >= 1 && Number(fields.maxRounds) <= 100,
    'maxRounds must be an integer from 1 to 100')
  const preferences: TuiPreferences = {
    schemaVersion: 1, provider: fields.provider, model: fields.model, reasoning: fields.reasoning,
    reasoningCapabilities: supported, stream: fields.stream, enableTools: fields.enableTools,
    enableNotes: fields.enableNotes, enableMemory: fields.enableMemory,
    maxRounds: fields.maxRounds as number
  }
  const encoded = JSON.stringify(preferences)
  check(!secretPresent(encoded, secrets), 'settings must not contain environment credentials')
  check(Buffer.byteLength(encoded) + 1 <= MAX_PREFERENCES_BYTES, 'size limit exceeded')
  return preferences
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function ownedPrivate(info: Stats): boolean {
  return process.platform === 'win32' || ((info.mode & 0o077) === 0 && info.uid === process.getuid?.())
}

async function privateDirectory(directory: string): Promise<Stats | undefined> {
  let info: Stats
  try { info = await lstat(directory) }
  catch (error) { if (isMissing(error)) return undefined; throw error }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Session directory must be a real directory')
  if (!ownedPrivate(info)) throw new Error('Session directory must be owned by you with permissions 0700')
  return info
}

function privateFile(info: Stats): boolean {
  return info.isFile() && !info.isSymbolicLink() && ownedPrivate(info) && info.size <= MAX_PREFERENCES_BYTES
}

/** Private, bounded JSON; writes use a unique 0600 temporary file and durable atomic rename. */
export class PreferenceStore {
  readonly directory: string
  private readonly secrets: string[]
  constructor(directory: string, secrets: readonly string[] = []) {
    this.directory = resolve(directory)
    this.secrets = [...secrets]
  }
  addSecrets(secrets: readonly string[]): void { this.secrets.push(...secrets.filter(secret => secret && !this.secrets.includes(secret))) }
  async load(): Promise<TuiPreferences | undefined> {
    const directory = await privateDirectory(this.directory)
    if (!directory) return undefined
    const target = join(this.directory, 'preferences.json')
    let entry: Stats
    try { entry = await lstat(target) }
    catch (error) { if (isMissing(error)) return undefined; throw error }
    if (!privateFile(entry)) throw new Error('Preferences must be a private regular file within the size limit')
    // NONBLOCK also prevents an adversarial regular-file-to-FIFO swap from hanging open.
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      const currentDirectory = await privateDirectory(this.directory)
      if (!privateFile(info) || info.dev !== entry.dev || info.ino !== entry.ino ||
        !currentDirectory || currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino) {
        throw new Error('Preferences must be a private regular file within the size limit')
      }
      const buffer = Buffer.alloc(MAX_PREFERENCES_BYTES + 1)
      let offset = 0
      while (offset < buffer.length) {
        const read = await file.read(buffer, offset, buffer.length - offset, null)
        if (read.bytesRead === 0) break
        offset += read.bytesRead
      }
      if (offset > MAX_PREFERENCES_BYTES) throw new Error('Preferences exceed the size limit')
      const encoded = buffer.subarray(0, offset).toString('utf8')
      if (secretPresent(encoded, this.secrets)) throw new Error('Preferences must not contain environment credentials')
      let parsed: unknown
      try { parsed = JSON.parse(encoded) }
      catch { throw new Error('Preferences are not valid JSON') }
      return validatePreferences(parsed, this.secrets)
    } finally { await file.close() }
  }
  async save(input: TuiPreferences): Promise<void> {
    const preferences = validatePreferences(input, this.secrets)
    const encoded = `${JSON.stringify(preferences)}\n`
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const directory = await privateDirectory(this.directory)
    if (!directory) throw new Error('Session directory is unavailable')
    const target = join(this.directory, 'preferences.json')
    try {
      const info = await lstat(target)
      if (!privateFile(info)) throw new Error('Refusing to replace nonprivate or nonregular preferences')
    } catch (error) { if (!isMissing(error)) throw error }
    const temporary = join(this.directory, `.preferences.${randomUUID()}.tmp`)
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      await file.writeFile(encoded, 'utf8')
      await file.sync()
      await file.close()
      const currentDirectory = await privateDirectory(this.directory)
      if (!currentDirectory || currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino) {
        throw new Error('Session directory changed while saving preferences')
      }
      await rename(temporary, target)
      if (process.platform !== 'win32') {
        const handle = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        try { await handle.sync() } finally { await handle.close() }
      }
    } finally {
      await file.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  }
}

/** Full session validation stays in FileSessionStore; only a bounded metadata projection escapes. */
export async function listSessions(store: FileSessionStore, limit = MAX_SESSION_PICKER_ITEMS): Promise<SessionPickerEntry[]> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_SESSION_PICKER_ITEMS) {
    throw new Error(`Session picker limit must be an integer from 0 to ${MAX_SESSION_PICKER_ITEMS}`)
  }
  if (limit === 0 || !await privateDirectory(store.directory)) return []
  const directory = await opendir(store.directory, { bufferSize: 32 })
  const sessions: SessionPickerEntry[] = []
  let scanned = 0
  try {
    while (scanned < MAX_SESSION_LIST_ENTRIES) {
      const entry = await directory.read()
      if (!entry) break
      scanned++
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const id = entry.name.slice(0, -5)
      if (!isSessionId(id)) continue
      try {
        const session = await store.load(id)
        // Model IDs are identifiers, never terminal control sequences or transcript previews.
        if (/[\u0000-\u001f\u007f-\u009f]/.test(session.model)) continue
        let locked = true
        try { await lstat(join(store.directory, `${id}.json.lock`)) }
        catch (error) { if (isMissing(error)) locked = false }
        const metadata: SessionPickerEntry = {
          id: session.id, title: sessionDisplayTitle(session), provider: session.provider, model: session.model,
          updatedAt: session.updatedAt, locked
        }
        if (session.reasoning !== undefined) metadata.reasoning = session.reasoning
        sessions.push(metadata)
      } catch {
        // Malformed, mismatched, public, oversized, symlinked or concurrently removed entries are omitted.
      }
    }
  } finally { await directory.close() }
  return sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, limit)
}
