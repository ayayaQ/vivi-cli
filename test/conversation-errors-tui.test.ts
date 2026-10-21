// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { TextRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import type { AgentResult, HistoryMessage } from '@ayayaq/vivi'
import { OpenTuiIO } from '../src/tui.js'
import { newSession } from '../src/session.js'
import { conversationHistoryDigest } from '../src/conversation-errors.js'

const instances: OpenTuiIO[] = []
afterEach(() => { for (const io of instances.splice(0)) io.close() })
async function fixture() {
  const setup = await createTestRenderer({ width: 100, height: 40, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer); instances.push(io)
  const read = (node: Renderable): string => [node instanceof TextRenderable ? node.plainText : '', ...node.getChildren().map(read)].join('\n')
  return { io, async text() { await setup.renderOnce(); await setup.renderOnce(); return read(setup.renderer.root.findDescendantById('vivi-transcript')!) } }
}
const result = (history: HistoryMessage[], message?: string): AgentResult => ({ history, status: message ? 'error' : 'completed',
  content: '', rounds: 1, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  ...(message ? { error: { code: 'provider_error' as const, message } } : {}) })
const user = (content: string): HistoryMessage => ({ kind: 'message', role: 'user', content })

test('live error survives later failed and successful turns at its original boundary without duplicates', async () => {
  const f = await fixture(), session = newSession({ provider: 'deepseek', model: 'offline' })
  f.io.setSession(session)
  const first = [user('First question')]
  f.io.result(result(first, 'First failure'))
  f.io.setSession({ ...session, history: first })
  const dispose = f.io.onCancel(() => {})
  const second = [...first, user('Second question')]
  f.io.result(result(second, 'Second failure')); dispose()
  const third = [...second, user('Third question')]
  f.io.result(result(third))
  f.io.setSession({ ...session, history: third })
  f.io.setSession({ ...session, history: third })
  const text = await f.text()
  expect(text.split('First failure')).toHaveLength(2)
  expect(text.split('Second failure')).toHaveLength(2)
  expect(text.indexOf('First question')).toBeLessThan(text.indexOf('First failure'))
  expect(text.indexOf('First failure')).toBeLessThan(text.indexOf('Second question'))
  expect(text.indexOf('Second failure')).toBeLessThan(text.indexOf('Third question'))
  f.io.setSession(newSession({ provider: 'deepseek', model: 'offline' }))
  expect(await f.text()).not.toContain('failure')
})

test('restored journal errors merge with live error once, redact credentials, and reject unrelated prefixes', async () => {
  const f = await fixture(), session = newSession({ provider: 'deepseek', model: 'offline' })
  const first = [user('First question')], message = 'Provider failure with credential'
  const errors = { sessionId: session.id, errors: [{ id: 'settled-run', historyLength: 1,
    historyDigest: conversationHistoryDigest(first), message }] }
  f.io.setConversationErrors(errors)
  f.io.setSession({ ...session, history: first })
  f.io.result(result(first, message))
  f.io.setSession({ ...session, history: [...first, user('Next question')] })
  expect((await f.text()).split(message)).toHaveLength(2)
  f.io.addSecrets(['credential'])
  expect(await f.text()).not.toContain('credential')
  expect(await f.text()).toContain('Provider failure with [REDACTED]')
  f.io.setSession({ ...session, history: [user('Replaced question')] })
  expect(await f.text()).not.toContain('Provider failure')
  const restarted = await fixture()
  restarted.io.setConversationErrors(errors)
  restarted.io.setSession({ ...session, history: [...first, user('Next question')] })
  expect((await restarted.text()).split(message)).toHaveLength(2)
})
