// SPDX-License-Identifier: Apache-2.0
import type { Writable } from 'node:stream'
import { redactSecrets } from './session.js'

export type TerminalTitleState = 'idle' | 'working' | 'input'
/** Trusted host output only. A sink owns preserving/restoring the prior title. */
export interface TerminalTitleSink {
  set(title: string): void
  restore(): void
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const MAX_NAME_COLUMNS = 56
const MAX_NAME_UNITS = 160

/** No terminal controls, bidi overrides, credentials or unpaired Unicode surrogates. */
export function formatTerminalTitle(name: string, state: TerminalTitleState, secrets: readonly string[] = []): string {
  const redacted = redactSecrets(name, secrets)
  const safe = Array.from(redacted.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, ' '))
    .map(point => point.length === 1 && /[\ud800-\udfff]/.test(point) ? '\ufffd' : point).join('')
    .replace(/\s+/g, ' ').trim() || 'Untitled conversation'
  let fitted = '', columns = 0
  for (const { segment } of segmenter.segment(safe)) {
    const width = Array.from(segment).reduce((count, point) => count + (point.codePointAt(0)! <= 0x7f ? 1 : 2), 0)
    if (columns + width > MAX_NAME_COLUMNS || fitted.length + segment.length > MAX_NAME_UNITS) {
      fitted += '…'; break
    }
    fitted += segment; columns += width
  }
  return `${state === 'input' ? '[!] ' : state === 'working' ? '[~] ' : ''}vivi · ${fitted || '…'}`
}

/** Dedupe lifecycle changes. Optional title failures never take down the conversation. */
export class TerminalTitleController {
  private previous: string | undefined
  private closed = false
  private failed = false
  constructor(private readonly sink?: TerminalTitleSink) {}
  update(name: string, state: TerminalTitleState, secrets: readonly string[]): void {
    if (this.closed || this.failed || !this.sink) return
    const title = formatTerminalTitle(name, state, secrets)
    if (this.previous === title) return
    try { this.sink.set(title); this.previous = title }
    catch { this.failed = true }
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.sink?.restore() } catch { /* Best-effort terminal decoration cleanup. */ }
  }
}

/** xterm title-stack constants; never query or parse an untrusted terminal title.
 * https://invisible-island.net/xterm/ctlseqs/ctlseqs.html (CSI 22/23;0t).
 * Unsupported terminals may ignore preservation. No bytes are written off-TTY. */
export function createTerminalTitleSink(setTitle: (title: string) => void,
  output: Pick<Writable, 'write'> & { readonly isTTY?: boolean }, term?: string): TerminalTitleSink | undefined {
  if (output.isTTY !== true || term === 'dumb') return undefined
  let pushed = false, restored = false
  return {
    set(title) {
      if (restored) return
      if (!pushed) { output.write('\x1b[22;0t'); pushed = true }
      setTitle(title)
    },
    restore() {
      if (restored) return
      restored = true
      if (pushed) output.write('\x1b[23;0t')
    }
  }
}
