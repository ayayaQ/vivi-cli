// SPDX-License-Identifier: Apache-2.0
export type RunOutcome = 'completed' | 'cancelled' | 'error'
export type RunPhase = 'working' | 'waiting_approval' | 'cancelling'
export interface RunClock {
  now(): number
  every(callback: () => void, milliseconds: number): unknown
  clear(handle: unknown): void
}
const systemClock: RunClock = {
  now: () => performance.now(),
  every: (callback, milliseconds) => {
    const timer = setInterval(callback, milliseconds)
    timer.unref?.()
    return timer
  },
  clear: handle => clearInterval(handle as ReturnType<typeof setInterval>)
}
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
export function formatRunElapsed(milliseconds: number): string {
  const seconds = Math.floor(Math.max(0, milliseconds) / 1000)
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`
}

/** Total turn elapsed time includes approval waits. Lifecycle is explicit, never inferred from cancel listeners. */
export class RunStatus {
  private startedAt: number | undefined
  private elapsed = 0
  private handle: unknown
  private phase: RunPhase = 'working'
  private outcome: RunOutcome | undefined
  constructor(private readonly changed: () => void, private readonly clock: RunClock = systemClock) {}
  get running(): boolean { return this.startedAt !== undefined }
  get label(): string | undefined {
    if (!this.running && this.outcome === undefined) return undefined
    const elapsed = this.running ? Math.max(this.elapsed, this.clock.now() - this.startedAt!) : this.elapsed
    const duration = formatRunElapsed(elapsed)
    if (this.outcome !== undefined) return `${this.outcome === 'completed' ? 'Completed' : this.outcome === 'cancelled' ? 'Cancelled' : 'Error'} · ${duration}`
    if (this.phase === 'waiting_approval') return `Waiting for approval · ${duration}`
    if (this.phase === 'cancelling') return `Cancelling · ${duration}`
    return `${frames[Math.floor(elapsed / 100) % frames.length]} Working · ${duration}`
  }
  start(): void {
    this.reset()
    this.startedAt = this.clock.now(); this.phase = 'working'
    this.handle = this.clock.every(() => { if (this.running) this.changed() }, 100)
    this.changed()
  }
  setPhase(phase: RunPhase): void {
    if (!this.running) return
    this.phase = phase; this.changed()
  }
  finish(outcome: RunOutcome): void {
    if (!this.running) return
    this.elapsed = Math.max(this.elapsed, this.clock.now() - this.startedAt!)
    this.startedAt = undefined; this.outcome = outcome
    this.clearTimer(); this.changed()
  }
  reset(): void {
    this.clearTimer()
    this.startedAt = undefined; this.elapsed = 0; this.outcome = undefined
  }
  private clearTimer(): void {
    if (this.handle !== undefined) { this.clock.clear(this.handle); this.handle = undefined }
  }
}
