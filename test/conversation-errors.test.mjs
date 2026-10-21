// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliHost } from '../dist/host.js'
import { FileSessionStore } from '../dist/session.js'
import { sendChatTurn } from '../dist/terminal.js'
import { conversationHistoryDigest, matchingConversationErrors } from '../dist/conversation-errors.js'

// Bounded offline fixtures: private regular files, inert providers, no external calls.
test('saved host failures remain ordered after later success and restart without entering provider history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-error-display-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new FileSessionStore(directory), inputs = [], errors = []
  let calls = 0
  const provider = { async generate(input) {
    inputs.push(structuredClone(input))
    if (++calls <= 2) throw new Error(`Offline provider failure ${calls}`)
    return { content: 'Recovered answer', toolCalls: [] }
  } }
  let host = await CliHost.create({ store, settings: { provider: 'deepseek', model: 'offline-error-model' }, provider })
  const io = { setConversationErrors(value) { errors.push(value) } }
  const first = await sendChatTurn(host, io, 'First question')
  assert.equal(first.status, 'error')
  const firstHistory = structuredClone(first.history)
  const second = await sendChatTurn(host, io, 'Second question')
  assert.equal(second.status, 'error')
  const third = await sendChatTurn(host, io, 'Third question')
  assert.equal(third.status, 'completed')
  assert.equal(host.conversationErrors.errors.length, 2)
  assert.deepEqual(host.conversationErrors.errors.map(item => item.historyLength), [1, 2])
  assert.equal(host.conversationErrors.errors[0].historyDigest, conversationHistoryDigest(firstHistory))
  assert.equal(errors.at(-1).errors.length, 2)
  assert(!JSON.stringify(inputs).includes('Offline provider failure'))
  const expected = host.conversationErrors, id = host.session.id
  await host.shutdown()
  host = await CliHost.resume({ id, store, provider })
  assert.deepEqual(host.conversationErrors, expected)
  assert.equal(matchingConversationErrors(host.session.history, expected.errors).length, 2)
  await host.shutdown()
})

test('failure display binds the exact prior prefix rather than only its length', () => {
  const first = [{ kind: 'message', role: 'user', content: 'original' }]
  const failure = { id: 'run-error', historyLength: 1, historyDigest: conversationHistoryDigest(first), message: 'Failure' }
  assert.deepEqual(matchingConversationErrors([...first, { kind: 'message', role: 'user', content: 'next' }], [failure]), [failure])
  assert.deepEqual(matchingConversationErrors([{ ...first[0], content: 'different' }], [failure]), [])
  assert.deepEqual(matchingConversationErrors([], [failure]), [])
})

test('dynamic credentials quarantine retained journal errors before restoration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-error-private-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new FileSessionStore(directory), secrets = []
  const host = await CliHost.create({ store, secrets, settings: { provider: 'deepseek', model: 'offline-error-model' },
    provider: { async generate() { throw new Error('Offline failure with later-secret') } } })
  await host.send('Question')
  assert.equal(host.conversationErrors.errors.length, 1)
  secrets.push('later-secret')
  assert.deepEqual(host.conversationErrors.errors, [])
  await host.shutdown()
})
