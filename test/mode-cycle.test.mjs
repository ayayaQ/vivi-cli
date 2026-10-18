// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cycleApprovalMode, runChatLoop } from '../dist/terminal.js'
import { newSession } from '../dist/session.js'

function fixture({ mode = 'manual', interactive = true, allow = false, lines = [] } = {}) {
  let taskMode = 'execute'
  const host = { session: newSession({ provider: 'openai', model: 'offline' }), invalidateContext() {},
    get approvalMode() { return mode }, setApprovalMode(value) { mode = value },
    get taskMode() { return taskMode }, setTaskMode(value) { taskMode = value; if (value === 'plan') mode = 'manual' } }
  const requests = [], io = { canAutoReview: interactive, output: '', modes: [],
    async readLine() { return lines.shift() }, write(value) { this.output += value },
    event() {}, result() {}, close() {}, onCancel() { return () => {} },
    setApprovalMode(value) { this.modes.push(value) },
    async approve(request) { requests.push(request); return allow } }
  return { host, io, requests }
}

test('Manual -> enrolled Auto -> Plan -> Manual revokes Auto and needs fresh enrollment next time', async () => {
  const f = fixture({ allow: true })
  await cycleApprovalMode(f.host, f.io)
  assert.equal(f.host.approvalMode, 'auto')
  assert.equal(f.requests[0].call.name, 'enroll_auto_review')
  assert.match(f.requests[0].description, /extra API charges/)
  await cycleApprovalMode(f.host, f.io)
  assert.equal(f.host.approvalMode, 'manual')
  assert.equal(f.host.taskMode, 'plan')
  assert.equal(f.requests.length, 1)
  await cycleApprovalMode(f.host, f.io)
  assert.equal(f.host.taskMode, 'execute')
  assert.equal(f.host.approvalMode, 'manual')
  assert.equal(f.requests.length, 1)
  await cycleApprovalMode(f.host, f.io)
  assert.equal(f.host.approvalMode, 'auto')
  assert.equal(f.requests.length, 2)
  assert.notEqual(f.requests[0].call.id, f.requests[1].call.id)
})

test('denied and unavailable cycle enrollment stays Manual', async () => {
  for (const interactive of [true, false]) {
    const f = fixture({ interactive })
    await cycleApprovalMode(f.host, f.io)
    assert.equal(f.host.approvalMode, 'manual')
    assert.equal(f.requests.length, interactive ? 1 : 0)
  }
})

test('line command cycle uses the same enrollment and revocation without allowing mode arguments to bypass it', async () => {
  const f = fixture({ allow: true, lines: ['/mode auto', '/mode cycle', '/mode cycle', '/exit'] })
  await runChatLoop(f.host, f.io)
  assert.equal(f.requests.length, 1)
  assert.equal(f.host.approvalMode, 'manual')
  assert.match(f.io.output, /Use \/mode by itself/)
})
