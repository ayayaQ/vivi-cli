// SPDX-License-Identifier: Apache-2.0
// This module is the worker entry point. Guest source runs exclusively inside QuickJS.
import { parentPort, workerData } from 'node:worker_threads'
import variant from '@jitl/quickjs-singlefile-cjs-release-sync'
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core'
import type { QuickJSDeferredPromise, QuickJSHandle } from 'quickjs-emscripten-core'
import { CODE_LIMITS } from './code-mode-contract.js'

const port = parentPort!
async function run(): Promise<void> {
  const { code, interrupt, names } = workerData as { code: string; interrupt: SharedArrayBuffer; names: string[] }
  const stop = new Int32Array(interrupt)
  const vm = (await newQuickJSWASMModuleFromVariant(Promise.resolve(variant))).newContext()
  let deadline = performance.now() + CODE_LIMITS.timeoutMs
  vm.runtime.setMemoryLimit(CODE_LIMITS.heapBytes)
  vm.runtime.setMaxStackSize(256 * 1024)
  vm.runtime.setInterruptHandler(() => Atomics.load(stop, 0) !== 0 || performance.now() >= deadline)
  const pending = new Map<number, QuickJSDeferredPromise>()
  let sequence = 0
  let root: QuickJSHandle | undefined
  try {
    const invoke = vm.newFunction('invoke', (nameHandle, argsHandle) => {
      if (vm.typeof(nameHandle) !== 'string' || vm.typeof(argsHandle) !== 'string') throw new Error('Expected tool arguments')
      const name = vm.getString(nameHandle)
      if (!names.includes(name) || ++sequence > CODE_LIMITS.calls || pending.size >= CODE_LIMITS.concurrent) throw new Error('Tool unavailable or call limit exceeded')
      const args = vm.getString(argsHandle)
      if (Buffer.byteLength(args) > CODE_LIMITS.argumentBytes) throw new Error('Arguments too large')
      const deferred = vm.newPromise()
      pending.set(sequence, deferred)
      port.postMessage({ kind: 'call', id: sequence, name, args })
      return deferred.handle.dup()
    })
    vm.setProp(vm.global, '__invoke', invoke)
    invoke.dispose()
    const bootstrap = 'const tools = Object.freeze(Object.fromEntries(' + JSON.stringify(names) + '.map(name => [name, async args => JSON.parse(await __invoke(name, JSON.stringify(args)))])));'
    const result = vm.evalCode(bootstrap + '\n(async () => JSON.stringify((await (async () => {\n' + code + '\n})()) ?? null))()')
    if (result.error) { result.error.dispose(); throw new Error('Invalid program') }
    root = result.value
    while (true) {
      if (Atomics.load(stop, 0) !== 0 || performance.now() >= deadline) throw new Error('Deadline exceeded')
      const jobs = vm.runtime.executePendingJobs(32)
      if (jobs.error) { jobs.error.dispose(); throw new Error('Guest evaluation failed') }
      const state = vm.getPromiseState(root)
      if (state.type === 'rejected') { state.error.dispose(); throw new Error('Program rejected') }
      if (state.type === 'fulfilled') {
        try {
          if (pending.size) throw new Error('Await all tool calls before returning')
          if (vm.typeof(state.value) !== 'string') throw new Error('Return a JSON value')
          const json = vm.getString(state.value)
          if (Buffer.byteLength(json) > CODE_LIMITS.outputBytes) throw new Error('Result too large')
          port.postMessage({ kind: 'result', json })
          return
        } finally { state.value.dispose() }
      }
      if (vm.runtime.hasPendingJob()) continue
      if (!pending.size) throw new Error('Promise has no pending tools')
      const waiting = performance.now()
      port.postMessage({ kind: 'waiting' })
      const reply = await new Promise<{ id: number; content: string; failed: boolean }>(resolve => port.once('message', resolve))
      deadline += performance.now() - waiting
      port.postMessage({ kind: 'running' })
      const deferred = pending.get(reply.id)
      if (!deferred) throw new Error('Unexpected host response')
      pending.delete(reply.id)
      const data = vm.newString(reply.content)
      try {
        if (reply.failed) deferred.reject(data)
        else deferred.resolve(data)
      } finally { data.dispose(); deferred.dispose() }
    }
  } finally {
    for (const deferred of pending.values()) deferred.dispose()
    root?.dispose()
    vm.dispose()
  }
}
run().catch(error => {
  // Only literal worker diagnostics cross this boundary. Guest exceptions can contain file data.
  const known = ['Invalid program', 'Guest evaluation failed', 'Deadline exceeded', 'Program rejected', 'Return a JSON value', 'Result too large', 'Promise has no pending tools', 'Await all tool calls before returning']
  port.postMessage({ kind: 'error', message: error instanceof Error && known.includes(error.message) ? error.message : 'Worker failed' })
})
