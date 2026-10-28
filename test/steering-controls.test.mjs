// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PassThrough } from 'node:stream'
import { TerminalIO } from '../dist/terminal.js'
import { AutoReviewController } from '../dist/auto-review.js'
import { setImmediate as tick } from 'node:timers/promises'

test('interactive line input steers only outside fresh approval and retains rejected drafts', async t => {
  const input = new PassThrough(), output = new PassThrough()
  input.isTTY = true; output.isTTY = true
  const io = new TerminalIO({ input, output }); t.after(() => io.close())
  const submitted = []
  const dispose = io.onSteering({ submit(content, interrupt) { submitted.push({ content, interrupt }); return content !== '/new' },
    takeLast() {}, clear() {} })
  input.write('First\n/interrupt Second\n'); await tick()
  assert.deepEqual(submitted, [{ content: 'First', interrupt: false }, { content: 'Second', interrupt: true }])
  input.write('/new\n'); await tick()
  assert.equal(io.readline.line, '/new')
  const approval = io.approve({ call: { id: 'owned-call', name: 'note_set', arguments: {} },
    currentRevision: 0, description: 'Owned exact proposal' }, new AbortController().signal)
  input.write('allow\n'); assert.equal(await approval, true)
  assert.equal(submitted.length, 3, 'Approval input was never queued as a user instruction')
  assert.equal(io.readline.line, '/new')
  io.clearEditableInput()
  input.write('After\n'); await tick()
  assert.equal(submitted.at(-1).content, 'After')
  dispose()
})

test('piped input remains ordinary line sequencing and never opts into concurrent steering', async t => {
  const input = new PassThrough(), output = new PassThrough(), io = new TerminalIO({ input, output })
  t.after(() => io.close())
  let touched = 0
  const dispose = io.onSteering({ submit() { touched++; return true }, takeLast() {}, clear() {} })
  input.write('one\ntwo\n'); await tick()
  assert.equal(await io.readLine(''), 'one'); assert.equal(await io.readLine(''), 'two')
  assert.equal(touched, 0); dispose()
})

test('accepted steering changes the exact request without restoring review budget or old authority', async () => {
  const captured = [], ledger = []
  let release, entered
  const pause = new Promise(resolve => { release = resolve }), started = new Promise(resolve => { entered = resolve })
  const controller = new AutoReviewController({ canAutoReview: true, accountRevision: () => 'owned-account',
    ledger: { async upsert(record) { ledger.push(record) } },
    provider: { id: 'openai', model: 'gpt-6-luna', async evaluate(request) {
      captured.push(request); if (captured.length === 1) { entered(); await pause }
      return { model: 'gpt-6-luna', answers: request.policy.checks.map(check => ({ name: check.name, type: 'predicate', probability: 1 })),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    } } }, [], async () => false)
  controller.beginTurn('owned-session', 'Set color blue'); controller.setMode('auto')
  const proposal = id => ({ approval: { call: { id, name: 'note_set', arguments: { key: 'color', value: 'blue', expectedRevision: 0 } },
    currentRevision: 0, description: 'Exact note' }, inputData: { before: null, after: 'blue' }, resourceRevisions: { note: 0 },
    currentResourceRevisions: () => ({ note: 0 }), isActive: () => true, eligible: true,
    preparedAction: { complete: true, effects: [{ kind: 'write', resourceId: 'note', scope: 'outside-workspace',
      affectedData: { before: null, after: 'blue' }, review: 'model-review' }] } })
  let commits = 0
  const execute = id => controller.execute(proposal(id), new AbortController().signal, async guard => { guard(); commits++; return 1 })
  const stale = execute('a'); await started
  controller.steer('Set color green'); release()
  await assert.rejects(stale, /changed|current|stale|review/i)
  assert.equal(commits, 0)
  await execute('b')
  assert.equal(captured[1].snapshot.userRequest.text, 'Set color green')
  assert.equal(captured[1].snapshot.runId, captured[0].snapshot.runId)
  assert.notEqual(captured[1].snapshot.userRequest.id, captured[0].snapshot.userRequest.id)
  controller.steer('Set color yellow')
  await execute('c')
  assert.equal(captured.length, 2, 'Steering cannot renew the two-call review budget')
  assert.equal(commits, 1)
  controller.endTurn()
})

test('interactive line steering drafts survive approval and ordinary cancellation without becoming approval input', async t => {
  const input = new PassThrough(), output = new PassThrough()
  input.isTTY = true; output.isTTY = true
  const io = new TerminalIO({ input, output }); t.after(() => io.close())
  const submitted = []
  const dispose = io.onSteering({ submit(content) { submitted.push(content); return true }, takeLast() {}, clear() {} })
  const stop = io.onCancel(() => {})
  input.write('draft'); await tick()
  const approve = io.approve({ call: { id: 'draft-approval', name: 'note_set', arguments: {} },
    currentRevision: 0, description: 'Exact review' }, new AbortController().signal)
  assert.equal(io.readline.line, '')
  input.write('deny\nallow\n')
  assert.equal(await approve, false)
  assert.equal(io.readline.line, 'draft')
  assert.deepEqual(submitted, [])
  io.readline.emit('SIGINT')
  assert.equal(io.readline.line, 'draft')
  dispose(); stop()
})
