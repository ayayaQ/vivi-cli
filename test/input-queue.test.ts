// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test'
import { InputQueue } from '../src/input-queue.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const signal = (): AbortSignal => new AbortController().signal
const tick = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

test('starts synchronously, serializes heterogeneous dialogs FIFO, and tracks pending work', async () => {
  const queue = new InputQueue(), first = deferred<string>(), second = deferred<number>()
  const started: string[] = []
  expect(queue.pending).toBe(false)
  const one = queue.enqueue(signal(), () => 'cancelled', async () => { started.push('approval'); return first.promise })
  const two = queue.enqueue(signal(), () => -1, async () => { started.push('question'); return second.promise })
  const three = queue.enqueue(signal(), () => false, async () => { started.push('approval 2'); return true })
  expect(started).toEqual(['approval'])
  expect(queue.pending).toBe(true)
  first.resolve('allow')
  expect(await one).toBe('allow')
  expect(started).toEqual(['approval', 'question'])
  second.resolve(2)
  expect(await two).toBe(2)
  expect(await three).toBe(true)
  expect(started).toEqual(['approval', 'question', 'approval 2'])
  expect(queue.pending).toBe(false)
})

test('a blocked queue retains FIFO order until wake and does not interrupt an active dialog', async () => {
  const queue = new InputQueue(), active = deferred<string>(), started: number[] = []
  let activeSignal: AbortSignal | undefined
  queue.setBlocked(true)
  const one = queue.enqueue(signal(), () => 'cancelled', async internal => {
    activeSignal = internal; started.push(1); return active.promise
  })
  const two = queue.enqueue(signal(), () => 'cancelled', async () => { started.push(2); return 'second' })
  expect(started).toEqual([])
  expect(queue.pending).toBe(true)
  queue.setBlocked(false)
  expect(started).toEqual([1])
  queue.setBlocked(true)
  expect(activeSignal?.aborted).toBe(false)
  active.resolve('first')
  expect(await one).toBe('first')
  expect(started).toEqual([1])
  expect(queue.pending).toBe(true)
  queue.setBlocked(false)
  expect(started).toEqual([1, 2])
  expect(await two).toBe('second')
  expect(queue.pending).toBe(false)
})

test('queued abort resolves its cancellation value without running or disturbing FIFO order', async () => {
  const queue = new InputQueue(), active = deferred<number>(), abort = new AbortController()
  const started: number[] = []
  const one = queue.enqueue(signal(), () => -1, async () => { started.push(1); return active.promise })
  const two = queue.enqueue(abort.signal, () => -2, async () => { started.push(2); return 2 })
  const three = queue.enqueue(signal(), () => -3, async () => { started.push(3); return 3 })
  abort.abort('cancel queued')
  expect(await two).toBe(-2)
  expect(started).toEqual([1])
  active.resolve(1)
  expect(await one).toBe(1)
  expect(await three).toBe(3)
  expect(started).toEqual([1, 3])
  expect(queue.pending).toBe(false)
})

test('active abort forwards the reason and frees a permanently unsettled dialog after a cleanup microtask', async () => {
  const queue = new InputQueue(), abort = new AbortController(), started: string[] = []
  let activeSignal: AbortSignal | undefined
  const one = queue.enqueue(abort.signal, () => 'cancelled', internal => {
    activeSignal = internal; started.push('first')
    internal.addEventListener('abort', () => started.push('cleaned'), { once: true })
    return new Promise<string>(() => {})
  })
  const two = queue.enqueue(signal(), () => 'cancelled', async () => { started.push('second'); return 'done' })
  const reason = new Error('request cancelled')
  abort.abort(reason)
  expect(activeSignal?.aborted).toBe(true)
  expect(activeSignal?.reason).toBe(reason)
  expect(started).toEqual(['first', 'cleaned'])
  expect(await one).toBe('cancelled')
  await tick()
  expect(started).toEqual(['first', 'cleaned', 'second'])
  expect(await two).toBe('done')
  expect(queue.pending).toBe(false)
})

test('late fulfillment or rejection from cancelled dialogs cannot release another active slot', async () => {
  for (const late of ['resolve', 'reject'] as const) {
    const queue = new InputQueue(), abort = new AbortController(), first = deferred<number>(), second = deferred<number>()
    const started: number[] = []
    const one = queue.enqueue(abort.signal, () => -1, async () => { started.push(1); return first.promise })
    const two = queue.enqueue(signal(), () => -2, async () => { started.push(2); return second.promise })
    const three = queue.enqueue(signal(), () => -3, async () => { started.push(3); return 3 })
    abort.abort()
    expect(await one).toBe(-1)
    if (late === 'resolve') first.resolve(100)
    else first.reject(new Error('late failure'))
    await tick()
    expect(started).toEqual([1, 2])
    expect(queue.pending).toBe(true)
    second.resolve(2)
    expect(await two).toBe(2)
    expect(await three).toBe(3)
    expect(queue.pending).toBe(false)
  }
})

test('close aborts active input, drains queued cancellation values, and cancels future requests', async () => {
  const queue = new InputQueue(), cancelled: number[] = [], started: number[] = []
  let activeSignal: AbortSignal | undefined
  const one = queue.enqueue(signal(), () => { cancelled.push(1); return -1 }, internal => {
    activeSignal = internal; started.push(1); return new Promise<number>(() => {})
  })
  const two = queue.enqueue(signal(), () => { cancelled.push(2); return -2 }, async () => { started.push(2); return 2 })
  const three = queue.enqueue(signal(), () => { cancelled.push(3); return -3 }, async () => { started.push(3); return 3 })
  queue.close(); queue.close()
  expect(activeSignal?.aborted).toBe(true)
  expect(await Promise.all([one, two, three])).toEqual([-1, -2, -3])
  expect(cancelled).toEqual([1, 2, 3])
  expect(started).toEqual([1])
  expect(queue.pending).toBe(false)
  queue.setBlocked(false)
  expect(await queue.enqueue(signal(), () => -4, async () => { started.push(4); return 4 })).toBe(-4)
  expect(started).toEqual([1])
})

test('already aborted requests never run and a cancellation callback may reject', async () => {
  const queue = new InputQueue(), abort = new AbortController(), failure = new Error('cancel failed')
  let runs = 0
  abort.abort()
  expect(await queue.enqueue(abort.signal, () => -1, async () => { runs++; return 1 })).toBe(-1)
  await expect(queue.enqueue(abort.signal, () => { throw failure }, async () => { runs++; return 1 })).rejects.toBe(failure)
  expect(runs).toBe(0)
  expect(queue.pending).toBe(false)
})

test('a throwing cancellation callback still aborts active input and releases the slot', async () => {
  const queue = new InputQueue(), abort = new AbortController(), failure = new Error('cancel failed')
  let activeSignal: AbortSignal | undefined
  const one = queue.enqueue(abort.signal, () => { throw failure }, internal => {
    activeSignal = internal; return new Promise<string>(() => {})
  })
  const rejected = one.catch(error => error)
  const two = queue.enqueue(signal(), () => 'cancelled', async () => 'second')
  abort.abort()
  expect(await rejected).toBe(failure)
  expect(activeSignal?.aborted).toBe(true)
  expect(await two).toBe('second')
  expect(queue.pending).toBe(false)
})

test('run rejection and synchronous exceptions release the slot without invoking cancellation', async () => {
  const queue = new InputQueue(), failure = new Error('dialog failed')
  let cancellations = 0
  const cancelled = (): string => { cancellations++; return 'cancelled' }
  await expect(queue.enqueue(signal(), cancelled, async () => { throw failure })).rejects.toBe(failure)
  await expect(queue.enqueue(signal(), cancelled, () => { throw failure })).rejects.toBe(failure)
  expect(await queue.enqueue(signal(), cancelled, async () => 'next')).toBe('next')
  expect(cancellations).toBe(0)
  expect(queue.pending).toBe(false)
})

test('synchronous self-abort and reentrant enqueue preserve FIFO without recursive draining', async () => {
  const queue = new InputQueue(), abort = new AbortController(), started: string[] = []
  let child: Promise<string> | undefined
  queue.setBlocked(true)
  const one = queue.enqueue(abort.signal, () => 'cancelled', () => {
    started.push('first')
    child = queue.enqueue(signal(), () => 'cancelled', async () => { started.push('child'); return 'child' })
    abort.abort()
    return new Promise<string>(() => {})
  })
  const two = queue.enqueue(signal(), () => 'cancelled', async () => { started.push('second'); return 'second' })
  queue.setBlocked(false)
  expect(await one).toBe('cancelled')
  expect(await two).toBe('second')
  expect(await child).toBe('child')
  expect(started).toEqual(['first', 'second', 'child'])
  expect(queue.pending).toBe(false)
})

test('settled jobs detach their external abort listener and cannot invoke cancellation later', async () => {
  const queue = new InputQueue(), abort = new AbortController()
  let cancellations = 0
  expect(await queue.enqueue(abort.signal, () => { cancellations++; return 'cancelled' }, async () => 'done')).toBe('done')
  abort.abort()
  queue.close()
  expect(cancellations).toBe(0)
  expect(queue.pending).toBe(false)
})

test('active cancellation lets async finally cleanup complete before starting the next dialog', async () => {
  const queue = new InputQueue(), abort = new AbortController(), order: string[] = []
  const one = queue.enqueue(abort.signal, () => 'cancelled', async internal => {
    try {
      await new Promise<void>(resolve => internal.addEventListener('abort', () => resolve(), { once: true }))
      return 'stale'
    } finally { order.push('old finally') }
  })
  const two = queue.enqueue(signal(), () => 'cancelled', async () => { order.push('new run'); return 'new' })
  abort.abort()
  expect(await one).toBe('cancelled')
  expect(await two).toBe('new')
  expect(order).toEqual(['old finally', 'new run'])
})

test('close drains blocked jobs even if one cancellation callback rejects', async () => {
  const queue = new InputQueue(), failure = new Error('cancel failed'), cancelled: number[] = []
  let runs = 0
  queue.setBlocked(true)
  const one = queue.enqueue(signal(), () => { cancelled.push(1); throw failure }, async () => { runs++; return 1 })
  const rejected = one.catch(error => error)
  const two = queue.enqueue(signal(), () => { cancelled.push(2); return -2 }, async () => { runs++; return 2 })
  queue.close()
  expect(await rejected).toBe(failure)
  expect(await two).toBe(-2)
  expect(cancelled).toEqual([1, 2])
  expect(queue.pending).toBe(false)
  queue.setBlocked(false)
  expect(runs).toBe(0)
})

test('active abort respects a blocker until an explicit wake', async () => {
  const queue = new InputQueue(), abort = new AbortController()
  let secondStarted = false
  const one = queue.enqueue(abort.signal, () => 'cancelled', () => new Promise<string>(() => {}))
  const two = queue.enqueue(signal(), () => 'cancelled', async () => { secondStarted = true; return 'second' })
  queue.setBlocked(true)
  abort.abort()
  expect(await one).toBe('cancelled')
  await tick()
  expect(secondStarted).toBe(false)
  expect(queue.pending).toBe(true)
  queue.setBlocked(false)
  expect(await two).toBe('second')
  expect(queue.pending).toBe(false)
})
