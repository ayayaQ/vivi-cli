// SPDX-License-Identifier: Apache-2.0
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { resolve } from 'node:path'
import { IMAGE_LIMITS, imageMetadata } from './image-assets.js'

/** Only a complete pasted PNG/JPEG path is a candidate; prose and URLs remain text. */
export function pastedImagePath(text: string): string | undefined {
  let path = text.trim()
  if (!path || path.length > 32768 || /[\u0000-\u001f\u007f]/.test(path)) return undefined
  const quote = path[0]
  if (quote === '"' || quote === "'") {
    if (path.at(-1) !== quote) return undefined
    path = path.slice(1, -1)
  }
  if (/"/.test(path) || /^[a-z][a-z0-9+.-]*:\/\//i.test(path) || !/\.(?:png|jpe?g)$/i.test(path)) return undefined
  return path
}

/** Read only this explicitly pasted file, bounded before allocation and validated by encoding. */
export async function readPastedImagePath(path: string, directory: string, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  const file = await open(resolve(directory, path), constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    signal.throwIfAborted()
    const before = await file.stat()
    if (!before.isFile() || before.size <= 0 || before.size > IMAGE_LIMITS.bytes) throw new Error('Invalid image file size or type')
    const bytes = Buffer.alloc(before.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      signal.throwIfAborted()
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await file.stat()
    signal.throwIfAborted()
    if (offset !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Image changed while reading')
    }
    const image = bytes.subarray(0, offset)
    imageMetadata(image)
    return image
  } finally { await file.close() }
}
