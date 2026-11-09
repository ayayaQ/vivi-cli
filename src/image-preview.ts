// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { imageMetadata } from './image-assets.js'
import type { PastedImage } from './image-assets.js'

export interface ImagePreviewService {
  open(image: PastedImage): Promise<void>
  dispose(): Promise<void>
}

export function imageViewerCommand(path: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  const file = resolve(path)
  if (platform === 'win32') return { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', pathToFileURL(file).href] }
  return { command: platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', args: [file] }
}

async function openImageFile(path: string): Promise<void> {
  const { command, args } = imageViewerCommand(path)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    // The viewer owns its lifetime. Closing vivi must never terminate the viewer or wait for it.
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

/** Open the attached pixels, even if their original file or clipboard has since changed. */
export class FileImagePreviewer implements ImagePreviewService {
  private directory: Promise<string> | undefined
  private readonly files = new Map<string, Promise<string>>()
  private readonly active = new Set<Promise<void>>()
  private closed = false
  private disposal: Promise<void> | undefined
  constructor(private readonly launch: (path: string) => Promise<void> = openImageFile) {}

  async open(image: PastedImage): Promise<void> {
    if (this.closed) throw new Error('Image previews are closed')
    const bytes = Uint8Array.from(image.bytes), metadata = imageMetadata(bytes)
    const digest = createHash('sha256').update(bytes).digest('hex')
    let file = this.files.get(digest)
    if (!file) {
      this.directory ??= mkdtemp(join(tmpdir(), 'vivi-image-preview-'))
      file = this.directory.then(async directory => {
        const path = join(directory, `${digest}.${metadata.mimeType === 'image/png' ? 'png' : 'jpg'}`)
        try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }) }
        catch (error) { await rm(path, { force: true }).catch(() => undefined); throw error }
        return path
      })
      this.files.set(digest, file)
      const snapshot = file
      void snapshot.catch(() => { if (this.files.get(digest) === snapshot) this.files.delete(digest) })
    }
    const operation = file.then(async path => {
      if (this.closed) return
      await this.launch(path)
    })
    this.active.add(operation)
    try { await operation }
    finally { this.active.delete(operation) }
  }

  dispose(): Promise<void> {
    this.closed = true
    return this.disposal ??= (async () => {
      await Promise.allSettled([...this.active])
      const directory = await this.directory?.catch(() => undefined)
      if (directory) await rm(directory, { recursive: true, force: true })
      this.files.clear()
    })()
  }
}
