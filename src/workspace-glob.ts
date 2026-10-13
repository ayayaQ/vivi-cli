// SPDX-License-Identifier: Apache-2.0
import { Worker } from 'node:worker_threads'
import picomatch from 'picomatch'

export class WorkspaceGlobError extends Error {}

// Only the fixed matcher code runs in this worker. Patterns and candidate names
// are data; filesystem access and every read-policy check stay in the host.
const matcherSource = `
import('node:worker_threads').then(({ parentPort, workerData }) => {
  const pattern = new RegExp(workerData.source, workerData.flags);
  parentPort.on('message', path => parentPort.postMessage(pattern.test(path)));
});
`

/** RegExp matching is isolated so a synchronous match cannot outrun cancellation. */
export function createWorkspaceGlobMatcher(pattern: string, signal: AbortSignal, milliseconds: number): {
  matches(path: string): Promise<boolean>
  close(): Promise<void>
} {
  signal.throwIfAborted()
  const expression = picomatch.makeRe(pattern, { windows: false, nocase: false, dot: true,
    nobrace: true, nobracket: true, noextglob: true, nonegate: true, regex: false,
    strictSlashes: true, keepQuotes: true, maxLength: 200, flags: 's', debug: true })
  const worker = new Worker(matcherSource, { eval: true,
    workerData: { source: expression.source, flags: expression.flags } })
  let pending: { resolve(value: boolean): void; reject(error: Error): void } | undefined
  let failure: Error | undefined
  let closed = false
  let termination: Promise<number> | undefined
  const stop = (): Promise<number> => termination ??= worker.terminate()
  const fail = (error: Error): void => {
    failure ??= error
    pending?.reject(failure); pending = undefined
    void stop().catch(() => undefined)
  }
  const abort = (): void => fail(new WorkspaceGlobError('Workspace pattern matching was cancelled'))
  const timer = setTimeout(() => fail(new WorkspaceGlobError('Workspace operation exceeded its time limit')), Math.max(1, milliseconds))
  signal.addEventListener('abort', abort, { once: true })
  worker.on('message', (value: unknown) => {
    if (typeof value !== 'boolean') { fail(new WorkspaceGlobError('Workspace pattern matching failed')); return }
    pending?.resolve(value); pending = undefined
  })
  worker.on('error', () => fail(new WorkspaceGlobError('Workspace pattern matching failed')))
  worker.on('exit', () => { if (!closed) fail(new WorkspaceGlobError('Workspace pattern matching stopped')) })
  return {
    matches(path) {
      signal.throwIfAborted()
      if (failure) return Promise.reject(failure)
      if (closed || pending) return Promise.reject(new WorkspaceGlobError('Workspace pattern matcher is unavailable'))
      return new Promise<boolean>((resolve, reject) => {
        pending = { resolve, reject }
        try { worker.postMessage(path) }
        catch { fail(new WorkspaceGlobError('Workspace pattern matching failed')) }
      })
    },
    async close() {
      closed = true
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      fail(new WorkspaceGlobError('Workspace pattern matcher is closed'))
      await stop()
    }
  }
}
