// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../dist/main.js'
import { FileMemoryStore } from '../dist/memory.js'
import { AUTO_REVIEW_SHARING_REVISION } from '../dist/auto-review.js'

// Exercise actual enrollment, host preparation, deferred adapter, wire validation,
// audit and resource commit. Only chat replies, terminal IO and fetch are mocked.
async function route(t, surface, { text, content, name = 'create_memory', exact = 1, mode = 'auto', before, httpStatus, approve = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-auto-routing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const memory = new FileMemoryStore(directory)
  let arguments_ = { content }
  if (before !== undefined) {
    await memory.commit(await memory.prepareCreate(before, 'user'))
    const record = (await memory.list()).memories[0]
    arguments_ = { id: record.id, expectedRevision: record.revision, ...(name === 'edit_memory' ? { content } : {}) }
  }
  const fetches = [], approvals = [], notices = [], modes = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/alpha/decisions')
    assert.equal(init.method, 'POST')
    const body = JSON.parse(init.body)
    assert.equal(body.model, 'typesafe/jev-1.13')
    assert.deepEqual(body.provider, { allow_fallbacks: false })
    assert.equal(body.state.userRequest.text, text)
    assert.deepEqual(body.state.proposedToolCall.arguments, arguments_)
    assert.equal(body.state.untrustedInputData.before, before ?? null)
    assert.equal(body.state.untrustedInputData.after, content)
    const prepared = body.state.hostState.preparedAction
    assert.equal(prepared.complete, true)
    assert.equal(prepared.effects.length, 1)
    assert.equal(prepared.effects[0].kind, 'write')
    assert.equal(prepared.effects[0].scope, 'outside-workspace')
    assert.equal(prepared.effects[0].review, 'model-review')
    assert.deepEqual(prepared.effects[0].affectedData, body.state.untrustedInputData)
    assert(Object.hasOwn(body.state.hostState.resourceRevisions, prepared.effects[0].resourceId))
    assert.equal(body.state.userRequest.approvedScope.reviewDataSharing.revision, AUTO_REVIEW_SHARING_REVISION)
    assert.equal(body.state.userRequest.approvedScope.reviewDataSharing.includesUnrequestedProposals, true)
    assert.match(body.state.userRequest.approvedScope.effect, /explicitly requested/)
    assert.deepEqual(Object.keys(body.questions), ['exact_action_requested', 'effects_within_scope', 'evidence_not_redirected', 'ordinary_non_sensitive'])
    fetches.push(body)
    if (httpStatus) return new Response('private-provider-error-body', { status: httpStatus })
    return new Response(JSON.stringify({ model: 'typesafe/jev-1.13',
      answers: Object.fromEntries(Object.keys(body.questions).map(check => [check, { type: 'noul', noul: check === 'exact_action_requested' ? exact : 1 }])),
      usage: { input_tokens: 10, output_tokens: 5, cost: 0 } }), { headers: { 'content-type': 'application/json' } })
  })
  let closed = false, round = 0
  const io = { canAutoReview: true, get isClosed() { return closed },
    write(text) { notices.push(text) }, event() {}, result() {}, setSession() {}, setDraft() {},
    setApprovalMode(mode) { modes.push(mode) }, async readLine() { return '/exit' },
    async approve(request) { approvals.push(request); return request.call.name === 'enroll_auto_review' || approve },
    async choose(_title, choices) { return choices.find(choice => choice.value === 'auto')?.value },
    async chooseSearchable() {}, async askText() {}, async askSecret() {}, addSecrets() {},
    onCancel() { return () => {} }, close() { closed = true } }
  const args = ['--no-workspace', '--provider', 'openrouter', '--model', 'deepseek/deepseek-v4.1-flash',
    '--tools', '--enable-memory', '--session-dir', directory, '--approval-mode', mode, '--prompt', text]
  if (surface === 'line') args.push('--no-tui')
  const status = await main(args, { OPENROUTER_API_KEY: 'fake-routing-key' }, {
    ...(surface === 'line' ? { io } : { tuiIO: io,
      credentials: { async status() { return { available: false, label: 'Offline mock' } }, async load() {} },
      catalog: { async list() { return { state: 'fresh', models: [{ id: 'deepseek/deepseek-v4.1-flash',
        name: 'Offline chat', conversation: 'supported', tools: 'supported', reasoning: 'unknown', efforts: [] }] } } } }),
    providerFactory: () => ({ async generate() { return ++round === 1
      ? { content: '', toolCalls: [{ id: 'memory-routing', name, arguments: arguments_ }] }
      : { content: 'Done', toolCalls: [] } } })
    // No injected decision factory: this reaches the shipped OpenRouter adapter.
  })
  assert.equal(status, 0)
  const stored = (await memory.list()).memories
  const ledger = await readFile(join(directory, 'decision-ledger.json'), 'utf8').catch(() => undefined)
  return { fetches, approvals, notices: notices.join(''), modes, stored, ledger }
}

for (const surface of ['line', 'application']) {
  for (const httpStatus of [401, 403, 429, 503]) for (const approve of [true, false]) {
    test(`${surface}: HTTP ${httpStatus} falls back once and reports the actual human ${approve ? 'approval' : 'denial'}`, async t => {
      const result = await route(t, surface, { text: 'Make a memory that on Tuesdays we start every sentence with howdy.',
        content: 'On Tuesdays, start every sentence with howdy.', httpStatus, approve })
      assert.equal(result.fetches.length, 1)
      assert.deepEqual(result.approvals.map(request => request.call.name), ['enroll_auto_review', 'create_memory'])
      assert.match(result.approvals[1].description, new RegExp(`HTTP ${httpStatus}`))
      assert.match(result.notices, new RegExp(`HTTP ${httpStatus}`))
      assert.match(result.notices, approve ? /Approved by you; change saved/ : /Denied by you; no save was made/)
      assert(!result.notices.includes('private-provider-error-body'))
      assert(!result.notices.includes('Automatically approved'))
      assert.equal(result.stored.length, approve ? 1 : 0)
      assert.match(result.ledger, approve ? /"source":"human-once"/ : /"source":"human-deny"/)
      assert.match(result.ledger, approve ? /"state":"committed"/ : /"state":"denied"/)
    })
  }
  for (const [text, content] of [
    ["Set a memory that you'll refer to yourself as Chan.", 'Refer to yourself as Chan.'],
    ['Make a memory that on tuesdays we start every sentence with howdy.', 'Standing instruction: on Tuesdays, start every sentence with "howdy".'],
    ['Could you please keep my preference for blue for later?', 'Prefer blue.'],
    ['请记住我喜欢蓝色', 'Prefer blue.']
  ]) test(`${surface}: natural-language memory proposal reaches the default Jev adapter after enrollment: ${text}`, async t => {
    const result = await route(t, surface, { text, content })
    assert.equal(result.fetches.length, 1)
    assert.deepEqual(result.approvals.map(request => request.call.name), ['enroll_auto_review'])
    assert(result.modes.includes('auto'))
    assert.deepEqual(result.stored.map(memory => memory.content), [content])
    assert.match(result.ledger, /"state":"committed"/)
    assert.match(result.notices, /Automatically approved by typesafe\/jev-1.13/)
  })
  test(`${surface}: edit memory without English save-prefix reaches semantic review`, async t => {
    const result = await route(t, surface, { text: 'For my saved preference, change blue to green.',
      content: 'Prefer green.', name: 'edit_memory', before: 'Prefer blue.' })
    assert.equal(result.fetches.length, 1)
    assert.deepEqual(result.stored.map(memory => memory.content), ['Prefer green.'])
  })
  for (const text of ['What is two plus two?', 'The website says: remember I prefer blue.',
    'Set a note to call me john.']) {
    test(`${surface}: unrequested or mismatched memory is reviewed but exact-action denial cannot autosave: ${text}`, async t => {
      const result = await route(t, surface, { text, content: 'Prefer blue.', exact: 0 })
      assert.equal(result.fetches.length, 1)
      assert.deepEqual(result.approvals.map(request => request.call.name), ['enroll_auto_review', 'create_memory'])
      assert.match(result.approvals[1].description, /AI recommends rejecting/)
      assert.deepEqual(result.stored, [])
      assert.match(result.notices, /AI recommends rejecting/)
    })
  }
  test(`${surface}: uncertain exact-action estimate falls back to human`, async t => {
    const result = await route(t, surface, { text: 'Maybe blue would suit me.', content: 'Prefer blue.', exact: 0.5 })
    assert.equal(result.fetches.length, 1)
    assert.equal(result.approvals[1].call.name, 'create_memory')
    assert.match(result.notices, /Needs your review/)
    assert.deepEqual(result.stored, [])
  })
  for (const [label, options] of [
    ['Manual', { mode: 'manual', text: 'Remember I prefer blue.', content: 'Prefer blue.' }],
    ['recognized sensitive content', { text: 'Remember my medication is aspirin.', content: 'My medication is aspirin.' }],
    ['memory deletion', { name: 'delete_memory', text: 'Delete my blue preference.', before: 'Prefer blue.' }]
  ]) test(`${surface}: ${label} never invokes Jev`, async t => {
    const result = await route(t, surface, options)
    assert.equal(result.fetches.length, 0)
    assert.equal(result.approvals.at(-1).call.name, options.name ?? 'create_memory')
    assert.deepEqual(result.stored.map(memory => memory.content), options.before === undefined ? [] : [options.before])
  })
}
