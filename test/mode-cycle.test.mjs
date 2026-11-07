// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cycleApprovalMode, runChatLoop } from '../dist/terminal.js'
import { newSession } from '../dist/session.js'

function fixture({ mode = 'manual', interactive = true, allow = false, lines = [] } = {}) {
  let taskMode = 'execute'
  const host = { session: newSession({ provider: 'openai', model: 'offline' }), invalidateContext() {},
    get reviewProvider() { return this.session.provider }, get approvalMode() { return mode }, setApprovalMode(value) { mode = value },
    get taskMode() { return taskMode }, setTaskMode(value) { taskMode = value; if (value === 'plan') mode = 'manual' } }
  const requests = [], io = { canAutoReview: interactive, output: '', modes: [],
    async readLine() { return lines.shift() }, write(value) { this.output += value },
    event() {}, result() {}, close() {}, onCancel() { return () => {} },
    setApprovalMode(value) { this.modes.push(value) },
    async approve(request) { requests.push(request); return allow } }
  return { host, io, requests }
}

test('Manual -> Auto -> Skip -> Plan -> Manual visits every mode', async () => {
  const f = fixture({ allow: true })
  for (const [mode, task] of [['auto', 'execute'], ['skip', 'execute'], ['manual', 'plan'], ['manual', 'execute'], ['auto', 'execute']]) {
    await cycleApprovalMode(f.host, f.io)
    assert.equal(f.host.approvalMode, mode)
    assert.equal(f.host.taskMode, task)
  }
  assert.equal(f.requests.length, 0)
})

test('cycle enables Auto directly when interactive and stays Manual when unavailable', async () => {
  for (const interactive of [true, false]) {
    const f = fixture({ interactive })
    await cycleApprovalMode(f.host, f.io)
    assert.equal(f.host.approvalMode, interactive ? 'auto' : 'manual')
    assert.equal(f.requests.length, 0)
  }
})

test('line command cycle switches directly and revokes Auto while rejecting unsupported mode arguments', async () => {
  const f = fixture({ allow: true, lines: ['/mode auto', '/mode cycle', '/mode cycle', '/mode cycle', '/exit'] })
  await runChatLoop(f.host, f.io)
  assert.equal(f.requests.length, 0)
  assert.equal(f.host.approvalMode, 'manual')
  assert.match(f.io.output, /Use \/mode by itself/)
})
