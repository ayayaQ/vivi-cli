// SPDX-License-Identifier: Apache-2.0
import type { Writable } from 'node:stream'
import type { RunOutcome } from './run-status.js'

export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error'
export type ProgramBlockKind = 'permission' | 'question' | 'auth'
export interface ProgramStatusSink {
  report(state: ProgramState, kind?: ProgramBlockKind): void
  close(clear: boolean): void
}

/** UI-owned lifecycle, independent of token events, animation ticks and transcript text. */
export class TerminalProgramStatus {
  private state: ProgramState = 'idle'
  private blocked: ProgramBlockKind | undefined
  private closed = false
  private previous: string | undefined
  constructor(private readonly sink?: ProgramStatusSink, private readonly interactive = true) {
    this.update()
  }
  runStarted(): void { this.state = 'working'; this.blocked = undefined; this.update() }
  runFinished(outcome: RunOutcome): void {
    this.state = outcome === 'completed' ? 'done' : outcome === 'cancelled' ? 'idle' : 'error'
    this.blocked = undefined; this.update()
  }
  setBlocked(kind?: ProgramBlockKind): void { this.blocked = kind; this.update() }
  private update(): void {
    if (this.closed) return
    const state = this.blocked ? 'blocked' : this.state
    const key = `${state}:${this.blocked ?? ''}`
    if (key === this.previous) return
    try { this.sink?.report(state, this.blocked); this.previous = key }
    catch { /* Optional terminal decoration cannot fail a conversation. */ }
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.sink?.close(this.interactive || (this.state !== 'done' && this.state !== 'error') || this.blocked !== undefined) } catch { /* Best effort, no user data. */ }
  }
}

type StatusOutput = Pick<Writable, 'write' | 'on' | 'off' | 'once'> & { readonly isTTY?: boolean }
/** OSC 7501 rev 0.4. Fixed vocabulary only: never include prompts, paths, tools or credentials.
 * Detection is optional; do not query stdin or wrap in multiplexer passthrough escapes.
 * Older VTE versions cannot safely ignore unknown OSCs (same guard used by Codex).
 */
export function createProgramStatusSink(output: StatusOutput, env: NodeJS.ProcessEnv = process.env): ProgramStatusSink | undefined {
  if (output.isTTY !== true || env.TERM === 'dumb' || /^(0|false|off)$/i.test(env.VIVI_OSC7501 ?? '')) return undefined
  if (env.VTE_VERSION && /^\d+$/.test(env.VTE_VERSION) && Number(env.VTE_VERSION) < 5400) return undefined
  let previous: string | undefined, pending: string | undefined
  let blocked = false, closed = false, failed = false, writes = 0
  const release = (): void => {
    if (!closed || writes !== 0) return
    // Writable emits error after its write callback. Keep the handler through that
    // event, including writes still pending when the final status is retained.
    setImmediate(() => { if (closed && writes === 0) output.off('error', fail) })
  }
  const send = (bytes: string): boolean => {
    writes++
    let settled = false
    const settle = (error?: Error | null): void => {
      if (settled) return
      settled = true; writes--
      if (error) fail()
      release()
    }
    try { return output.write(bytes, settle) }
    catch { settle(new Error('Terminal status output failed')); return false }
  }
  const fail = (): void => { failed = true; pending = undefined; output.off('drain', drain) }
  const drain = (): void => {
    blocked = false
    const next = pending; pending = undefined
    if (next !== undefined && !closed && !failed) write(next)
  }
  const write = (bytes: string): void => {
    if (failed || bytes === previous) return
    if (blocked) { pending = bytes; return }
    try {
      const ready = send(bytes)
      if (failed) return
      previous = bytes
      if (!ready) { blocked = true; output.once('drain', drain) }
    } catch { fail() }
  }
  output.on('error', fail)
  return {
    report(state, kind) {
      if (closed || failed) return
      // Validate at runtime too: a JS caller cannot inject controls through a typed union.
      if (!['idle', 'working', 'done', 'blocked', 'error'].includes(state)) return
      if (kind !== undefined && !['permission', 'question', 'auth'].includes(kind)) return
      const bytes = `\x1b]7501;state=${state}:app=vivi-cli${state === 'blocked' && kind ? `:kind=${kind}` : ''}\x1b\\`
      // Latest-state coalescing also removes an obsolete queued transition back to previous.
      if (blocked) { pending = bytes === previous ? undefined : bytes; return }
      write(bytes)
    },
    close(clear) {
      if (closed) return
      closed = true
      output.off('drain', drain)
      // At most one final fixed-size record even on a backpressured stream. Never wait
      // indefinitely for drain during native teardown or synchronous process exit.
      const final = clear && previous !== undefined ? '\x1b]7501;state=clear\x1b\\' : clear ? undefined : pending
      pending = undefined
      if (!failed && final !== undefined && final !== previous) {
        send(final)
      }
      release()
    }
  }
}
