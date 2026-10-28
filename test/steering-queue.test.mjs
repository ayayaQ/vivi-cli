// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SteeringQueue, STEERING_LIMITS } from '../dist/steering.js'

const user = content => ({ kind: 'message', role: 'user', content })
test('queue keeps identical inputs distinct and acknowledges exact FIFO history slots', () => {
  const queue = new SteeringQueue()
  const first = queue.add('same'), second = queue.add('same'), last = queue.add('last')
  assert.notEqual(first.id, second.id)
  assert.deepEqual(queue.stage(4), [user('same'), user('same'), user('last')])
  assert.equal(queue.takeLast(), undefined)
  queue.clear()
  assert.equal(queue.messages.length, 3)
  queue.acknowledge(user('same'), 4)
  assert.deepEqual(queue.messages.map(message => message.id), [second.id, last.id])
  assert.throws(() => queue.acknowledge(user('wrong'), 5), /did not match/)
  queue.reconcile([{}, {}, {}, {}, user('same'), user('same')])
  queue.release()
  assert.deepEqual(queue.messages, [last])
  assert.equal(queue.takeLast(), 'last')
  assert.deepEqual(queue.messages, [])
})
test('queue preserves unaccepted input across interruption and allows edit/clear only before admission', () => {
  const queue = new SteeringQueue(), first = queue.add('one')
  queue.add('two')
  queue.stage(0)
  queue.reconcile([user('one')])
  queue.release()
  assert.equal(queue.takeLast(), 'two')
  queue.add('edited')
  queue.claimInitial(queue.messages[0].id, 'edited', 1)
  queue.clear()
  assert.equal(queue.messages.length, 1)
  assert.throws(() => queue.claimInitial(first.id, 'one', 1), /changed/)
  queue.acknowledgeInitial(queue.messages[0].id)
  queue.release()
  assert.deepEqual(queue.messages, [])
})
test('rejected inputs leave the queue untouched and enforce bounded message and byte capacity', () => {
  const queue = new SteeringQueue()
  for (const text of ['', '  ', '/new', 'x'.repeat(STEERING_LIMITS.characters + 1)]) assert.throws(() => queue.add(text))
  assert.deepEqual(queue.messages, [])
  for (let i = 0; i < STEERING_LIMITS.messages; i++) queue.add('same')
  assert.throws(() => queue.add('overflow'), /full/)
  assert.equal(queue.messages.length, STEERING_LIMITS.messages)
  queue.clear()
  queue.add('x'.repeat(STEERING_LIMITS.characters)); queue.add('x'.repeat(STEERING_LIMITS.characters))
  assert.throws(() => queue.add('more'), /full/)
  assert.equal(queue.messages.length, 2)
  const snapshot = queue.messages
  snapshot[0].content = 'changed'
  assert.equal(queue.messages[0].content.length, STEERING_LIMITS.characters)
})
