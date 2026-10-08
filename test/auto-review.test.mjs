// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AutoReviewController, AUTO_REVIEW_THRESHOLDS, autoReviewPolicy,
  reviewContainsSecret, reviewDigest, reviewIsSensitive, reviewFallbackDescription, AUTO_REVIEW_SHARING_REVISION } from '../dist/auto-review.js'
import { CliHost } from '../dist/host.js'
import { FileMemoryStore } from '../dist/memory.js'
import { FileSessionStore, newSession, SessionCommitError } from '../dist/session.js'
import { decisionProviderForSession, deferredDecisionProvider } from '../dist/main.js'
import { TerminalIO, runChatLoop } from '../dist/terminal.js'
import { PassThrough } from 'node:stream'

function fixture(options = {}) {
  const state = { calls: 0, human: 0, commits: 0, account: 'account-v1', revision: 1, active: true,
    requests: [], records: [], notices: [], reviewStates: [], secrets: [], ...options.state }
  const providerId = options.providerId ?? 'openai'
  const model = providerId === 'openai' ? 'gpt-6-luna' : 'typesafe/jev-1.13'
  const provider = { id: providerId, model, async evaluate(request, signal) {
    state.calls++; state.requests.push(request)
    await options.onEvaluate?.(state, request, signal)
    return options.response ?? { model, answers: request.policy.checks.map(check =>
      ({ name: check.name, type: 'predicate', probability: options.probabilities?.[check.name] ?? options.probability ?? 1 })),
    usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, ...(providerId === 'openrouter' ? { costUsd: 0.0001 } : {}) } }
  } }
  const ledger = { async upsert(record) {
    await options.onAudit?.(state, record)
    state.records.push(structuredClone(record))
  } }
  const controller = new AutoReviewController({ provider: options.providerOverride ?? provider, ledger, canAutoReview: options.canAutoReview ?? true,
    accountRevision: () => state.account }, state.secrets, async request => {
    state.human++; state.humanRequest = request
    await options.onHuman?.(state, request)
    return options.approved ?? false
  }, (message, context) => { state.notices.push(message); if (context) state.reviewStates.push(context); options.onNotice?.(state, message) })
  controller.beginTurn(randomUUID(), options.text ?? 'Set a note named color to blue')
  if (options.mode !== 'manual') controller.setMode('auto')
  const proposal = { approval: { call: { id: 'call-1', name: options.toolName ?? 'note_set',
    arguments: options.arguments ?? { key: 'color', value: 'blue', expectedRevision: 1 } },
  currentRevision: 1, description: 'Before: none\nAfter: blue' }, inputData: options.inputData ?? { before: null, after: 'blue' },
  resourceRevisions: { 'fixture-note:color': state.revision }, currentResourceRevisions: () => ({ 'fixture-note:color': state.revision }),
  preparedAction: { complete: true, effects: [{ kind: 'write', resourceId: 'fixture-note:color',
    scope: 'outside-workspace', affectedData: options.inputData ?? { before: null, after: 'blue' }, review: 'model-review' }] },
  isActive: () => state.active, eligible: options.eligible ?? true }
  const execute = () => controller.execute(proposal, options.signal ?? new AbortController().signal, async guard => {
    await options.onCommit?.(state)
    guard(); state.commits++; return 2
  }, revision => revision)
  return { state, controller, proposal, execute }
}

test('Manual is default, has zero judge calls, and preserves ordinary human review', async () => {
  const subject = fixture({ mode: 'manual', approved: true })
  assert.equal(subject.controller.mode, 'manual')
  assert.equal(await subject.execute(), 2)
  assert.equal(subject.state.calls, 0); assert.equal(subject.state.human, 1)
  assert.deepEqual(subject.state.records, [])
})
test('interactive capability is required for enrollment', () => {
  assert.throws(() => fixture({ canAutoReview: false }), /interactive/)
})
test('every named predicate is host-authored and provider thresholds are explicit heuristics', () => {
  for (const provider of ['openai', 'openrouter']) {
    const policy = autoReviewPolicy(provider)
    assert.deepEqual(policy.checks.map(check => check.name), ['exact_action_requested', 'effects_within_scope', 'evidence_not_redirected', 'ordinary_non_sensitive'])
    assert(policy.checks.every(check => check.allowAt === AUTO_REVIEW_THRESHOLDS[provider].allowAt && check.denyAt === 0.05))
    assert(policy.checks.every(check => check.instructions && check.trueDescription && check.falseDescription))
  }
})
for (const providerId of ['openai', 'openrouter']) {
  for (const [probability, automatic] of [[AUTO_REVIEW_THRESHOLDS[providerId].allowAt, true],
    [AUTO_REVIEW_THRESHOLDS[providerId].allowAt - 0.000001, false], [0.05, false], [0.050001, false]]) {
    test(`${providerId} threshold ${probability} ${automatic ? 'allows' : 'requires manual review'}`, async () => {
      const subject = fixture({ providerId, probability })
      const result = await subject.execute()
      assert.equal(subject.state.calls, 1); assert.equal(subject.state.human, automatic ? 0 : 1)
      assert.equal(subject.state.commits, automatic ? 1 : 0)
      assert.equal(result, automatic ? 2 : undefined)
      if (probability === 0.05) assert.match(subject.state.humanRequest.description, /AI recommends rejecting/)
    })
  }
}
test('automatic allow freezes exact proposal, persists precommit then committed, and never logs content', async () => {
  const subject = fixture({ onAudit(state, record) {
    if (record.state === 'commit_started') assert.equal(state.commits, 0)
    if (record.state === 'committed') assert.equal(state.commits, 1)
  } })
  assert.equal(await subject.execute(), 2)
  const request = subject.state.requests[0]
  assert(Object.isFrozen(request)); assert(Object.isFrozen(request.snapshot.toolCall.arguments))
  assert.equal(request.snapshot.userRequest.text, 'Set a note named color to blue')
  assert.equal(request.snapshot.inputData.after, 'blue')
  assert.equal(request.snapshot.userRequest.approvedScope.reviewDataSharing.revision, AUTO_REVIEW_SHARING_REVISION)
  assert.deepEqual(request.snapshot.userRequest.approvedScope.reviewDataSharing.recipients, ['OpenAI'])
  assert.equal(request.snapshot.userRequest.approvedScope.reviewDataSharing.includesUnrequestedProposals, true)
  assert.equal(request.snapshot.userRequest.approvedScope.reviewDataSharing.mayContainPersonalOrSensitiveInformation, true)
  assert.equal(request.snapshot.userRequest.approvedScope.reviewDataSharing.privateDetailDetectionIsIncomplete, true)
  assert.deepEqual(subject.state.records.map(record => record.state), ['commit_started', 'committed'])
  assert.equal(subject.state.records.at(-1).resultRevision, 2)
  assert(!JSON.stringify(subject.state.records).includes('blue'))
  assert(!JSON.stringify(subject.state.records).includes('Set a note'))
  await assert.rejects(subject.execute(), /already been reviewed/)
  assert.equal(subject.state.commits, 1)
})
for (const response of [
  { model: 'gpt-6-luna', answers: [], usage: { inputTokens: 1, outputTokens: 1 } },
  { model: 'unknown', answers: [], usage: { inputTokens: 1, outputTokens: 1 } },
  { model: 'gpt-6-luna', answers: [], usage: undefined }
]) test('invalid or unsupported answers ask a human, never auto-allow', async () => {
  const subject = fixture({ response })
  await subject.execute(); assert.equal(subject.state.human, 1); assert.equal(subject.state.commits, 0)
})
test('model rejection can be approved once only by the existing human path', async () => {
  const subject = fixture({ probability: 0.01, approved: true })
  assert.equal(await subject.execute(), 2)
  assert.equal(subject.state.human, 1); assert.equal(subject.state.records.at(-1).source, 'human-once')
  await assert.rejects(subject.execute(), /already been reviewed/)
})
test('review lifecycle identifies each call and records the real human or automatic source', async () => {
  for (const [probability, approved, expected, source] of [[1, false, ['reviewing', 'saving', 'saved'], 'automatic'],
    [0.5, true, ['reviewing', 'needs_review', 'saving', 'saved'], 'human'],
    [0.5, false, ['reviewing', 'needs_review', 'denied'], 'human']]) {
    const subject = fixture({ probability, approved })
    await subject.execute()
    assert.deepEqual(subject.state.reviewStates.map(notice => notice.state), expected)
    const terminal = subject.state.reviewStates.at(-1)
    assert.equal(terminal.source, source)
    assert(subject.state.reviewStates.every(notice => notice.sessionId === terminal.sessionId &&
      notice.runId === terminal.runId && notice.callId === 'call-1' && notice.toolName === 'note_set'))
    assert.match(subject.state.notices.at(-1), source === 'automatic' ? /Automatically approved/ : /(?:Approved|Denied) by you/)
  }
})
test('review cancellation and uncertain writes always settle progress without claiming a save', async () => {
  const abort = new AbortController()
  const subject = fixture({ signal: abort.signal, onEvaluate() { abort.abort() } })
  await assert.rejects(subject.execute())
  assert.equal(subject.state.reviewStates.at(-1).state, 'cancelled')
  assert.equal(subject.state.commits, 0)
  const uncertain = fixture({ onCommit() { throw new Error('private write failure') } })
  await assert.rejects(uncertain.execute())
  assert.equal(uncertain.state.reviewStates.at(-1).state, 'unknown')
  assert(!uncertain.state.notices.some(message => message.includes('private write failure')))
})
test('cancellation or staleness on the saving notice remains a definite no-effect terminal outcome', async () => {
  for (const cause of ['cancel', 'stale']) {
    const abort = new AbortController()
    const subject = fixture({ signal: abort.signal, onNotice(state, message) {
      if (!message.includes('saving the reviewed change')) return
      if (cause === 'cancel') abort.abort()
      else state.account = 'changed-account'
    } })
    await assert.rejects(subject.execute())
    assert.equal(subject.state.commits, 0)
    assert.equal(subject.state.records.at(-1).state, cause === 'cancel' ? 'cancelled' : 'failed')
    assert.equal(subject.state.reviewStates.at(-1).state, cause === 'cancel' ? 'cancelled' : 'failed')
    assert(!subject.state.notices.some(message => /write outcome could not be confirmed/.test(message)))
  }
})
test('stale tool-call mutation cannot change the lifecycle key during terminal reporting', async () => {
  const subject = fixture({ onNotice(_state, message) {
    if (!message.startsWith('Reviewing')) return
    subject.proposal.approval.call.id = 'changed-id'
    subject.proposal.approval.call.name = 'changed-name'
  } })
  await assert.rejects(subject.execute())
  assert.equal(subject.state.reviewStates.at(-1).state, 'failed')
  assert(subject.state.reviewStates.every(notice => notice.callId === 'call-1' && notice.toolName === 'note_set'))
  assert.equal(subject.state.calls, 0)
  assert.equal(subject.state.commits, 0)
})
test('fallback descriptions use closed friendly categories and bounded numeric HTTP statuses', () => {
  assert.equal(reviewFallbackDescription('http', 403), 'the review service returned HTTP 403')
  for (const invalid of [0, 600, 401.5, Infinity, '401', 'private-provider-body']) {
    assert.equal(reviewFallbackDescription('http', invalid), 'the review service returned an HTTP error')
  }
  assert.match(reviewFallbackDescription('rate_limit', 429), /rate limited.*HTTP 429/)
  assert.match(reviewFallbackDescription('timeout'), /timed out/)
  assert.match(reviewFallbackDescription('transport'), /could not be reached/)
  assert.match(reviewFallbackDescription('privacy'), /sensitive.*human/)
  assert(!reviewFallbackDescription('unexpected-private-reason').includes('unexpected-private-reason'))
  assert.equal(reviewFallbackDescription('constructor'), 'this change requires human review')
})
test('uncertain reviews summarize only known incomplete estimates without rounding them into approval', () => {
  const checks = [{ name: 'exact_action_requested', probability: 0.99899999, reasonCode: 'between_thresholds' },
    { name: 'effects_within_scope', probability: 0.999, reasonCode: 'allow_threshold_met' },
    { name: 'evidence_not_redirected', probability: 0.999, reasonCode: 'allow_threshold_met' },
    { name: 'ordinary_non_sensitive', probability: 1, reasonCode: 'allow_threshold_met' }]
  assert.equal(reviewFallbackDescription('uncertain', undefined, checks, 'openrouter'),
    'request match model estimate 99.8999% is below the 99.9% cutoff')
  assert.match(reviewFallbackDescription('uncertain', undefined, [...checks,
    { name: 'effects_within_scope', probability: 0.9, reasonCode: 'between_thresholds' }], 'openrouter'),
  /save scope model estimate 90%.*1 other check is also below/)
  assert.equal(reviewFallbackDescription('uncertain', undefined,
    [{ name: 'private-provider-text', probability: 0.5, reasonCode: 'between_thresholds' }], 'openrouter'),
  'the automatic checks were inconclusive')
  for (const probability of [undefined, NaN, Infinity, -1, 2, 0.999]) {
    assert.equal(reviewFallbackDescription('uncertain', undefined,
      [{ name: 'exact_action_requested', probability, reasonCode: 'between_thresholds' }], 'openrouter'),
    'the automatic checks were inconclusive')
  }
  assert.equal(reviewFallbackDescription('uncertain', undefined, [], 'openrouter'), 'the automatic checks were inconclusive')
  assert.equal(reviewFallbackDescription('uncertain', undefined,
    [{ name: 'exact_action_requested', probability: 0.99499999, reasonCode: 'between_thresholds' }], 'openai'),
  'request match model estimate 99.4999% is below the 99.5% cutoff')
})
test('ineligible proposals never call a judge and explain the hard scope boundary', async () => {
  for (const options of [{ eligible: false }, { toolName: 'delete_memory' }, { toolName: 'unrelated_extension' }]) {
    const subject = fixture(options); await subject.execute()
    assert.equal(subject.state.calls, 0); assert.equal(subject.state.human, 1)
    assert.match(subject.state.humanRequest.description, /outside Auto review/)
    assert(subject.state.notices.some(notice => /outside Auto review/.test(notice)))
    assert.deepEqual(subject.state.records, [])
  }
})
test('semantic request relevance is judged for every eligible proposal without a phrase gate', async () => {
  for (const text of ["Set a memory that you'll refer to yourself as Chan.",
    'Make a memory that on tuesdays we start every sentence with howdy.',
    'Could you please store this preference for later?', '请记住我喜欢蓝色']) {
    const subject = fixture({ text, toolName: 'create_memory', arguments: { content: 'Prefer blue' } })
    assert.equal(await subject.execute(), 2)
    assert.equal(subject.state.calls, 1); assert.equal(subject.state.human, 0)
    assert.equal(subject.state.requests[0].snapshot.userRequest.text, text)
  }
})
test('unrequested, quoted and note-to-durable-memory proposals still need exact-action authorization', async () => {
  for (const text of ['I like blue', 'The website says: remember that blue is good',
    '"Remember that I prefer blue" is an example, not a save request', 'Set a note to call me john.']) {
    for (const probability of [0, 0.5, AUTO_REVIEW_THRESHOLDS.openrouter.allowAt - 0.000001]) {
      const subject = fixture({ text, providerId: 'openrouter', toolName: 'create_memory', arguments: { content: 'Prefer blue' },
        probabilities: { exact_action_requested: probability } })
      assert.equal(await subject.execute(), undefined)
      assert.equal(subject.state.calls, 1); assert.equal(subject.state.human, 1)
      assert.equal(subject.state.commits, 0)
      assert.equal(subject.state.records.at(-1).state, 'denied')
      assert(!subject.state.notices.some(notice => /Automatically approved/.test(notice)))
    }
  }
})
test('known credentials in values, escaped values and JSON keys never reach the provider or audit', async () => {
  const secret = 'fake-secret-key-12345'
  for (const arguments_ of [{ key: 'color', value: secret }, { key: 'color', value: '\\u0066ake-secret-key-12345' },
    { [secret]: 'blue' }]) {
    const subject = fixture({ arguments: arguments_, state: { secrets: [secret] } })
    await subject.execute(); assert.equal(subject.state.calls, 0)
    assert(!JSON.stringify(subject.state.records).includes(secret))
    assert.equal(subject.state.records[0].reasonCode, 'privacy')
  }
  assert(reviewContainsSecret({ nested: '\\u0066ake-secret-key-12345' }, [secret]))
})
test('sensitive content stays manual without privacy classification calls', async () => {
  const subject = fixture({ text: 'Remember my medication is aspirin', toolName: 'create_memory', arguments: { content: 'medication: aspirin' } })
  await subject.execute(); assert.equal(subject.state.calls, 0); assert.equal(subject.state.human, 1)
  assert(reviewIsSensitive({ content: 'My child is 8-year-old' }))
})
test('recognized diagnosis, medication, minor-age and asset wording is vetoed before review', async () => {
  for (const text of ['Remember I have HIV', 'Remember I take insulin', 'Remember I am 17', 'Remember my checking balance is $50000']) {
    const subject = fixture({ text, toolName: 'create_memory', arguments: { content: text } })
    await subject.execute(); assert.equal(subject.state.calls, 0); assert.equal(subject.state.human, 1)
    assert.equal(subject.state.records[0].reasonCode, 'privacy')
  }
})
test('a credential discovered during review invalidates its allow and falls back manually', async () => {
  const subject = fixture({ arguments: { key: 'color', value: 'new-secret-123' },
    onEvaluate(state) { state.secrets.push('new-secret-123') } })
  await subject.execute(); assert.equal(subject.state.calls, 1); assert.equal(subject.state.human, 1)
  assert.equal(subject.state.commits, 0); assert.equal(subject.state.records[0].reasonCode, 'privacy')
})
for (const schedule of ['notice', 'microtask']) {
  test(`a secret registered by a ${schedule} before provider forwarding never reaches the provider`, async () => {
    const subject = fixture({ onNotice(state, message) {
      if (!message.startsWith('Reviewing')) return
      if (schedule === 'notice') state.secrets.push('blue')
      else queueMicrotask(() => state.secrets.push('blue'))
    } })
    await subject.execute(); assert.equal(subject.state.calls, 0)
    assert.equal(subject.state.human, 1); assert.equal(subject.state.records[0].reasonCode, 'privacy')
  })
}
test('account changes after the review notice cannot start a charged provider call', async () => {
  const subject = fixture({ onNotice(state, message) { if (message.startsWith('Reviewing')) state.account = 'account-v2' } })
  await assert.rejects(subject.execute(), /stale/)
  assert.equal(subject.state.calls, 0); assert.equal(subject.state.commits, 0); assert.equal(subject.state.human, 0)
})
test('official deferred transport rechecks secrets after asynchronous key resolution before fetch', async t => {
  const secrets = []
  let fetches = 0
  t.mock.method(globalThis, 'fetch', async () => { fetches++; throw new Error('Live transport must never be called') })
  const env = {}
  Object.defineProperty(env, 'OPENAI_API_KEY', { get() { queueMicrotask(() => secrets.push('blue')); return 'fake-test-key' } })
  const provider = deferredDecisionProvider({ provider: 'openai', model: 'fake' }, env, decisionProviderForSession)
  const subject = fixture({ providerOverride: provider, state: { secrets } })
  await subject.execute(); assert.equal(fetches, 0); assert.equal(subject.state.human, 1)
  assert.equal(subject.state.records[0].reasonCode, 'privacy')
})
for (const change of ['arguments', 'resource', 'account', 'active', 'endTurn']) {
  test(`a ${change} change during judging never commits or opens a late prompt`, async () => {
    let subject
    subject = fixture({ onEvaluate(state) {
      if (change === 'arguments') subject.proposal.approval.call.arguments.value = 'red'
      if (change === 'resource') state.revision++
      if (change === 'account') state.account = 'account-v2'
      if (change === 'active') state.active = false
      if (change === 'endTurn') subject.controller.endTurn()
    } })
    await assert.rejects(subject.execute(), /stale/)
    assert.equal(subject.state.commits, 0); assert.equal(subject.state.human, 0)
  })
}
test('only semantic object-key reordering preserves the bound proposal', async () => {
  let subject
  subject = fixture({ onEvaluate() { subject.proposal.approval.call.arguments = { expectedRevision: 1, value: 'blue', key: 'color' } } })
  assert.equal(await subject.execute(), 2)
  assert.equal(reviewDigest({ a: 1, b: 2 }), reviewDigest({ b: 2, a: 1 }))
})
test('account change resets enrollment and never resumes stored authority', () => {
  const subject = fixture(); subject.state.account = 'new-account'
  assert.equal(subject.controller.mode, 'manual')
  assert.equal(new AutoReviewController(undefined, [], async () => false).mode, 'manual')
})
test('queued commit must recheck account, content and cancellation', async () => {
  const subject = fixture({ onCommit(state) { state.account = 'account-v2' } })
  await assert.rejects(subject.execute(), /stale/)
  assert.equal(subject.state.commits, 0)
  assert.equal(subject.state.records.at(-1).state, 'unknown')
})
test('cancelled or late-allow providers never execute or prompt', async () => {
  const abort = new AbortController()
  const subject = fixture({ signal: abort.signal, async onEvaluate() { abort.abort(); await new Promise(resolve => setTimeout(resolve, 10)) } })
  await assert.rejects(subject.execute())
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(subject.state.commits, 0); assert.equal(subject.state.human, 0)
})
test('uncaught transport failure asks a human and never retries', async () => {
  const subject = fixture({ onEvaluate() { throw new Error('fake provider failure') } })
  await subject.execute(); assert.equal(subject.state.calls, 1); assert.equal(subject.state.human, 1)
  assert(!JSON.stringify(subject.state.records).includes('fake provider failure'))
})
test('end-to-end deadline asks once and discards an abort-ignoring late allow', async () => {
  let complete
  const subject = fixture({ onEvaluate() { return new Promise(resolve => { complete = resolve }) } })
  await subject.execute()
  assert.equal(subject.state.records[0].reasonCode, 'timeout')
  assert.equal(subject.state.calls, 1); assert.equal(subject.state.human, 1); assert.equal(subject.state.commits, 0)
  complete(); await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(subject.state.commits, 0)
})
test('oversized exact evidence stays manual without truncation', async () => {
  const subject = fixture({ text: 'Set a note ' + 'x'.repeat(17_000) })
  await subject.execute(); assert.equal(subject.state.calls, 0); assert.equal(subject.state.human, 1)
})
test('per-turn review budget allows only two requests, then manual; new turn resets it', async () => {
  const subject = fixture()
  for (let index = 0; index < 3; index++) {
    subject.proposal.approval.call.id = `call-${index}`
    await subject.execute()
  }
  assert.equal(subject.state.calls, 2); assert.equal(subject.state.commits, 2); assert.equal(subject.state.human, 1)
  subject.controller.beginTurn(randomUUID(), 'Set a note named color to blue')
  assert.equal(await subject.execute(), 2); assert.equal(subject.state.calls, 3)
})
test('precommit audit failure cannot automatically save and suspends further auto', async () => {
  const subject = fixture({ onAudit() { throw new Error('disk full') } })
  await subject.execute(); assert.equal(subject.state.human, 1); assert.equal(subject.state.commits, 0)
  assert.throws(() => subject.controller.setMode('auto'), /healthy review ledger/)
  subject.proposal.approval.call.id = 'call-2'; await subject.execute()
  assert.equal(subject.state.calls, 1)
})
test('precommit audit failure still permits an explicit ordinary human save once', async () => {
  const subject = fixture({ approved: true, onAudit() { throw new Error('disk full') } })
  assert.equal(await subject.execute(), 2); assert.equal(subject.state.human, 1); assert.equal(subject.state.commits, 1)
})
test('postcommit audit failure reports the saved outcome and never repeats the resource write', async () => {
  const subject = fixture({ onAudit(_state, record) { if (record.state === 'committed') throw new Error('disk full') } })
  assert.equal(await subject.execute(), 2); assert.equal(subject.state.commits, 1)
  assert(subject.state.notices.some(message => /change committed/.test(message)))
  await assert.rejects(subject.execute(), /already been reviewed/)
})
test('newly registered secrets before resource admission invalidate auto commit', async () => {
  const subject = fixture({ arguments: { key: 'color', value: 'late-secret' }, onAudit(state, record) {
    if (record.state === 'commit_started') state.secrets.push('late-secret')
  } })
  await assert.rejects(subject.execute(), /credential/)
  assert.equal(subject.state.commits, 0)
})
test('abort during precommit audit settles a definite no-effect cancellation', async () => {
  const abort = new AbortController()
  const subject = fixture({ signal: abort.signal, onAudit(_state, record) {
    if (record.state === 'commit_started') abort.abort()
  } })
  await assert.rejects(subject.execute())
  assert.equal(subject.state.commits, 0)
  assert.deepEqual(subject.state.records.map(record => record.state), ['commit_started', 'cancelled'])
})
test('stale account during precommit audit settles a definite no-effect failure', async () => {
  const subject = fixture({ onAudit(state, record) { if (record.state === 'commit_started') state.account = 'account-v2' } })
  await assert.rejects(subject.execute(), /stale/)
  assert.equal(subject.state.commits, 0)
  assert.deepEqual(subject.state.records.map(record => record.state), ['commit_started', 'failed'])
})

function makeHost(provider, memory, extra = {}, onJudge) {
  const records = [], notices = [], calls = []
  const store = { async save() {}, async load() { throw new Error('not used') } }
  const subject = new CliHost({ provider, memory, store, session: newSession({ provider: 'openai', model: 'fake' }),
    enableNotes: true, enableMemory: Boolean(memory), enableTools: true, approve: async () => false,
    onReviewNotice: message => notices.push(message), decisionReview: { canAutoReview: true, accountRevision: () => 'account-v1',
      ledger: { async upsert(record) { records.push(structuredClone(record)) } },
      provider: { id: 'openai', model: 'gpt-6-luna', async evaluate(request) {
        calls.push(request); await onJudge?.(request); return { model: 'gpt-6-luna', answers: request.policy.checks.map(check =>
          ({ name: check.name, type: 'predicate', probability: 1 })), usage: { inputTokens: 2, outputTokens: 1 } }
      } } }, ...extra })
  subject.setApprovalMode('auto')
  return { subject, records, notices, calls }
}
test('library host cannot route a selected OpenAI session to an implicit second provider', () => {
  assert.throws(() => makeHost({ generate: async () => ({ content: '', toolCalls: [] }) }, undefined,
    { decisionReview: { canAutoReview: true, accountRevision: () => 'x', ledger: { upsert: async () => {} },
      provider: { id: 'openrouter', model: 'typesafe/jev-1.13', evaluate: async () => { throw new Error('must not call') } } } }), /selected provider/)
})
test('host note auto review commits exactly the requested frozen note and leaves agent usage separate', async () => {
  let round = 0
  const { subject, calls, records } = makeHost({ async generate() {
    return ++round === 1 ? { content: '', toolCalls: [{ id: 'note-call', name: 'note_set', arguments: { key: 'color', value: 'blue', expectedRevision: 0 } }],
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } } : { content: 'Saved', toolCalls: [] }
  } })
  await subject.send('Set a note named color to blue')
  assert.equal(subject.session.notes.color, 'blue'); assert.equal(subject.session.noteRevision, 1)
  assert.equal(calls.length, 1); assert.equal(records.at(-1).state, 'committed')
  assert.equal(subject.session.usage.inputTokens, 3)
  assert(!JSON.stringify(calls).includes('history'))
})
test('unchanged Manual host accepts valid extension schemas beyond Decisions limits and remains reusable', async () => {
  let nested = { type: 'number', minimum: -0 }
  for (let index = 0; index < 45; index++) nested = { type: 'object', properties: { nested } }
  const extension = { id: 'deep-json', apiVersion: 1, tools: [{ definition: { name: 'deep_fixture', description: 'Valid JSON schema', parameters: nested },
    validateArguments() {}, execute() { return { content: 'unused' } } }] }
  const subject = new CliHost({ store: { async save() {}, async load() {} }, session: newSession({ provider: 'openai', model: 'fake' }),
    extensions: [extension], provider: { async generate() { return { content: 'Done', toolCalls: [] } } } })
  await subject.send('Hello'); assert.equal(subject.running, false)
  await subject.send('Hello again'); assert.equal(subject.running, false)
})
test('Manual note writes retain JSON negative-zero compatibility', async () => {
  let round = 0
  const subject = new CliHost({ store: { async save() {}, async load() {} }, session: newSession({ provider: 'openai', model: 'fake' }),
    enableNotes: true, approve: async () => true, provider: { async generate() { return ++round === 1
      ? { content: '', toolCalls: [{ id: 'negative-zero', name: 'note_set', arguments: { key: 'color', value: 'blue', expectedRevision: -0 } }] }
      : { content: 'Done', toolCalls: [] } } } })
  await subject.send('Set a note color to blue'); assert.equal(subject.session.notes.color, 'blue'); assert.equal(subject.running, false)
})
test('host memory auto create, manual manager and deletion keep their separate boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-auto-memory-'))
  try {
    const memory = new FileMemoryStore(directory)
    let round = 0
    const { subject, calls, records } = makeHost({ async generate() {
      return ++round === 1 ? { content: '', toolCalls: [{ id: 'memory-call', name: 'create_memory', arguments: { content: 'Prefer blue' } }] }
        : { content: 'Saved', toolCalls: [] }
    } }, memory)
    await subject.send('Remember I prefer blue')
    const stored = (await memory.list()).memories[0]
    assert.equal(stored.content, 'Prefer blue'); assert.equal(calls.length, 1); assert.equal(records.at(-1).state, 'committed')
    assert.equal(await subject.changeMemory({ kind: 'delete', id: stored.id, expectedRevision: stored.revision }), undefined)
    assert.equal(calls.length, 1); assert.equal((await memory.list()).memories.length, 1)
    assert.match(await readFile(join(directory, 'memories.json'), 'utf8'), /Prefer blue/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
test('memory resource queue repeats host guard before rename', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-auto-guard-'))
  try {
    const memory = new FileMemoryStore(directory)
    const proposal = await memory.prepareCreate('Prefer blue', 'agent')
    let checks = 0
    await assert.rejects(memory.commit(proposal, { assertCurrent() { if (++checks >= 4) throw new Error('account changed') } }), /account changed/)
    assert.equal((await memory.list()).memories.length, 0)
    assert(checks >= 4)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
for (const change of ['account', 'abort', 'secret', 'eof']) {
  test(`real note file checks ${change} again after temporary fsync and before rename`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'vivi-auto-note-race-'))
    const originalOpen = fs.open
    let subject, invalidated = false, account = 'account-v1'
    const secrets = []
    const input = new PassThrough(), output = new PassThrough()
    input.isTTY = true; input.setRawMode = () => {}; output.isTTY = true
    const io = new TerminalIO({ input, output })
    const dispose = io.onCancel(() => subject?.cancel())
    t.mock.method(fs, 'open', async (path, ...args) => {
      const handle = await originalOpen(path, ...args)
      if (String(path).endsWith('.tmp')) {
        let data = ''
        const write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle)
        handle.writeFile = async value => { data = String(value); return write(value) }
        handle.sync = async () => {
          await sync()
          if (!invalidated && data.includes('"noteRevision":1')) {
            invalidated = true
            if (change === 'account') account = 'account-v2'
            if (change === 'abort') subject.cancel()
            if (change === 'secret') secrets.push('blue')
            if (change === 'eof') { input.end(); await new Promise(resolve => setImmediate(resolve)) }
          }
        }
      }
      return handle
    })
    syncBuiltinESMExports()
    try {
      let round = 0
      const store = new FileSessionStore(directory, secrets)
      const records = []
      subject = new CliHost({ store, secrets, session: newSession({ provider: 'openai', model: 'fake' }),
        enableNotes: true, enableTools: true, approve: async () => false,
        provider: { async generate() { return ++round === 1 ? { content: '', toolCalls: [{ id: 'note-race', name: 'note_set',
          arguments: { key: 'color', value: 'blue', expectedRevision: 0 } }] } : { content: 'Done', toolCalls: [] } } },
        decisionReview: { canAutoReview: true, accountRevision: () => account,
          ...(change === 'eof' ? { isAvailable: () => io.canAutoReview } : {}), ledger: { async upsert(record) { records.push(structuredClone(record)) } },
          provider: { id: 'openai', model: 'gpt-6-luna', async evaluate(request) { return { model: 'gpt-6-luna',
            answers: request.policy.checks.map(check => ({ name: check.name, type: 'predicate', probability: 1 })),
            usage: { inputTokens: 1, outputTokens: 1 } } } } } })
      subject.setApprovalMode('auto')
      await subject.send('Set a note named color to blue')
      assert(invalidated)
      assert.equal(subject.session.noteRevision, 0); assert.equal(subject.session.notes.color, undefined)
      assert.equal((await store.load(subject.session.id)).notes.color, undefined)
      assert(!records.some(record => record.state === 'committed'))
      assert.equal(subject.running, false)
    } finally { dispose(); io.close(); t.mock.restoreAll(); syncBuiltinESMExports(); await rm(directory, { recursive: true, force: true }) }
  })
}
test('ledger drain failures suspend Auto but never strand the host or disable Manual', async () => {
  const notices = []
  const subject = new CliHost({ store: { async save() {}, async load() {} }, session: newSession({ provider: 'openai', model: 'fake' }),
    provider: { async generate() { return { content: 'Done', toolCalls: [] } } }, approve: async () => false,
    onReviewNotice: message => notices.push(message), decisionReview: { canAutoReview: true, accountRevision: () => 'account-v1',
      provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { throw new Error('must not call') } },
      ledger: { async upsert() {}, async drain() { throw new Error('directory fsync failed') } } } })
  subject.setApprovalMode('auto')
  await subject.send('Hello'); assert.equal(subject.running, false)
  subject.setApprovalMode('manual')
  await subject.send('Hello again'); assert.equal(subject.running, false)
  assert(notices.some(message => /durability could not be confirmed/.test(message)))
  assert.throws(() => subject.setApprovalMode('auto'), /healthy review ledger/)
})
test('a positively saved note with unconfirmed durability is reported committed and suspends Auto', async () => {
  let round = 0, failed = false
  const store = { snapshots: [], async save(session, options) {
    this.snapshots.push(structuredClone(session))
    if (options?.assertCurrent && !failed) { failed = true; throw new SessionCommitError(new Error('simulated directory fsync failure')) }
  }, async load() {} }
  const { subject, records, notices } = makeHost({ async generate() { return ++round === 1
    ? { content: '', toolCalls: [{ id: 'saved-uncertain', name: 'note_set', arguments: { key: 'color', value: 'blue', expectedRevision: 0 } }] }
    : { content: 'Done', toolCalls: [] } } }, undefined, { store })
  await subject.send('Set a note named color to blue')
  assert.equal(subject.session.notes.color, 'blue')
  assert.equal(store.snapshots.at(-1).notes.color, 'blue')
  assert.equal(records.at(-1).state, 'committed'); assert.equal(records.at(-1).resultRevision, 1)
  assert(notices.some(message => /was saved, but its durable persistence/.test(message)))
  assert.equal(subject.running, false)
  assert.throws(() => subject.setApprovalMode('auto'), /healthy review ledger/)
  subject.setApprovalMode('manual')
})
test('interactive line EOF during an abort-ignoring judge cancels without a save or late prompt', async () => {
  const input = new PassThrough(), output = new PassThrough()
  input.isTTY = true; input.setRawMode = () => {}; output.isTTY = true
  const io = new TerminalIO({ input, output })
  let round = 0
  const { subject, calls } = makeHost({ async generate() { return ++round === 1
    ? { content: '', toolCalls: [{ id: 'eof-note', name: 'note_set', arguments: { key: 'color', value: 'blue', expectedRevision: 0 } }] }
    : { content: 'Done', toolCalls: [] } } }, undefined, { approve: io.approve.bind(io) }, async () => {
    input.end(); await new Promise(resolve => setTimeout(resolve, 10))
  })
  try {
    const result = await runChatLoop(subject, io, 'Set a note named color to blue')
    assert.equal(result.status, 'cancelled'); assert.equal(subject.session.notes.color, undefined)
    assert.equal(calls.length, 1); assert.equal(io.isClosed, true); assert.equal(io.canAutoReview, false)
    assert.equal(subject.running, false)
  } finally { io.close() }
})

for (const classification of ['missing', 'incomplete', 'unknown', 'manual', 'ordinary-read', 'missing-resource']) {
  test(`prepared ${classification} metadata cannot fall through the old eligibility boolean`, async () => {
    const subject = fixture()
    const effect = subject.proposal.preparedAction.effects[0]
    if (classification === 'missing') delete subject.proposal.preparedAction
    if (classification === 'incomplete') subject.proposal.preparedAction.complete = false
    if (classification === 'unknown') effect.kind = 'unknown'
    if (classification === 'manual') effect.review = 'manual'
    if (classification === 'ordinary-read') { effect.kind = 'read'; effect.scope = 'workspace'; effect.review = 'ordinary-read' }
    if (classification === 'missing-resource') effect.resourceId = 'absent-literal-resource'
    assert.equal(await subject.execute(), undefined)
    assert.equal(subject.state.calls, 0); assert.equal(subject.state.human, 1); assert.equal(subject.state.commits, 0)
    assert.match(subject.state.humanRequest.description, /Host preparation requires manual/)
  })
}
test('a blocked effect remains blocked even when a human callback would approve', async () => {
  for (const mode of ['manual', 'auto']) {
    const subject = fixture({ mode, approved: true })
    subject.proposal.preparedAction.effects[0].review = 'blocked'
    assert.equal(await subject.execute(), undefined)
    assert.equal(subject.state.calls, 0); assert.equal(subject.state.human, 0); assert.equal(subject.state.commits, 0)
  }
})
for (const change of ['prepared-content', 'prepared-identity', 'classification', 'input-data', 'eligibility', 'current-classification']) {
  test(`changed ${change} at review completion invalidates the entire prepared action`, async () => {
    let subject
    subject = fixture({ onEvaluate() {
      if (change === 'prepared-content') subject.proposal.preparedAction.effects[0].affectedData.after = 'red'
      if (change === 'prepared-identity') subject.proposal.preparedAction.effects[0].resourceId = 'another-note'
      if (change === 'classification') subject.proposal.preparedAction.effects[0].scope = 'external'
      if (change === 'input-data') subject.proposal.inputData.after = 'red'
      if (change === 'eligibility') subject.proposal.eligible = false
      if (change === 'current-classification') subject.proposal.currentPreparedAction = () => ({ complete: false, effects: [] })
    } })
    await assert.rejects(subject.execute(), /stale/)
    assert.equal(subject.state.calls, 1); assert.equal(subject.state.human, 0); assert.equal(subject.state.commits, 0)
  })
}
test('the exact prepared metadata reaches the frozen shared decision request', async () => {
  const subject = fixture()
  assert.equal(await subject.execute(), 2)
  const snapshot = subject.state.requests[0].snapshot
  assert.equal(reviewDigest(snapshot.preparedAction), reviewDigest(subject.proposal.preparedAction))
  assert(Object.isFrozen(snapshot.preparedAction.effects[0].affectedData))
  assert(Object.hasOwn(snapshot.resourceRevisions, snapshot.preparedAction.effects[0].resourceId))
  assert.equal(snapshot.policyRevision, 'vivi-cli-auto-v4-openai')
})


test('sensitive prepared effect evidence stays manual even when inputData is ordinary', async () => {
  const subject = fixture()
  subject.proposal.preparedAction.effects[0].affectedData = { before: null, after: 'My medication is aspirin' }
  assert.equal(await subject.execute(), undefined)
  assert.equal(subject.state.calls, 0); assert.equal(subject.state.human, 1); assert.equal(subject.state.commits, 0)
  assert.equal(subject.state.records[0].reasonCode, 'privacy')
})
test('a credential newly known during audit invalidates prepared effect evidence before admission', async () => {
  const subject = fixture({ onAudit(state, record) {
    if (record.state === 'commit_started') state.secrets.push('late-known-effect-data')
  } })
  subject.proposal.preparedAction.effects[0].affectedData = { before: null, after: 'late-known-effect-data' }
  await assert.rejects(subject.execute(), /newly registered credential/)
  assert.equal(subject.state.calls, 1); assert.equal(subject.state.human, 0); assert.equal(subject.state.commits, 0)
  assert.equal(subject.state.records.at(-1).state, 'failed')
  await assert.rejects(subject.execute(), /already been reviewed/)
})
