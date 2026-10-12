// SPDX-License-Identifier: Apache-2.0
interface InputJob {
  run(): void
  cancel(reason?: unknown): void
}

/**
 * Serializes input dialogs in FIFO order. An idle, unblocked queue starts a job
 * synchronously; blocking defers queued jobs without interrupting the active one.
 * Cancellation releases the slot even when the dialog's promise never settles,
 * with a microtask before starting another job so abort cleanup can finish.
 * The caller supplies its cancellation value, or throws to reject cancellation.
 */
export class InputQueue {
  #jobs: InputJob[] = []
  #active: InputJob | undefined
  #blocked = false
  #closed = false
  #draining = false
  #drainScheduled = false

  get pending(): boolean { return this.#active !== undefined || this.#jobs.length > 0 }

  enqueue<T>(signal: AbortSignal, cancelled: () => T, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.#closed || signal.aborted) {
        try { resolve(cancelled()) } catch (error) { reject(error) }
        return
      }

      const controller = new AbortController()
      let settled = false
      const onAbort = (): void => job.cancel(signal.reason)
      const settle = (complete: () => void, cancelled = false): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        const index = this.#jobs.indexOf(job)
        if (index >= 0) this.#jobs.splice(index, 1)
        try { complete() }
        finally {
          // A stale completion may only release its own slot.
          const wasActive = this.#active === job
          if (wasActive) this.#active = undefined
          if (wasActive && cancelled && !this.#closed) this.#scheduleDrain()
          else this.#drain()
        }
      }
      const job: InputJob = {
        run: () => {
          if (settled) return
          try {
            Promise.resolve(run(controller.signal)).then(
              value => settle(() => resolve(value)),
              error => settle(() => reject(error)),
            )
          } catch (error) { settle(() => reject(error)) }
        },
        cancel: reason => settle(() => {
          // Keep the slot occupied until synchronous abort cleanup has finished.
          controller.abort(reason)
          try { resolve(cancelled()) } catch (error) { reject(error) }
        }, true),
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.#jobs.push(job)
      this.#drain()
    })
  }

  setBlocked(blocked: boolean): void {
    this.#blocked = blocked
    if (!blocked) this.#drain()
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    const queued = this.#jobs.splice(0)
    this.#active?.cancel()
    for (const job of queued) job.cancel()
  }

  #drain(): void {
    if (this.#draining || this.#drainScheduled) return
    this.#draining = true
    try {
      while (!this.#closed && !this.#blocked && !this.#drainScheduled && this.#active === undefined) {
        const job = this.#jobs.shift()
        if (!job) break
        this.#active = job
        job.run()
      }
    } finally { this.#draining = false }
  }

  #scheduleDrain(): void {
    if (this.#drainScheduled) return
    this.#drainScheduled = true
    queueMicrotask(() => { this.#drainScheduled = false; this.#drain() })
  }
}
