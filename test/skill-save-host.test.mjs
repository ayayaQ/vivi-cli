// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, realpath, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliHost } from '../dist/host.js'
import { InstalledSkillStore } from '../dist/installed-skills.js'
import { newSession } from '../dist/session.js'
const content = '---\nname: brief-summary\ndescription: Summarize supplied text.\n---\n\nReturn three factual points.\n'
const call = { id: 'save-1', name: 'save_skill', arguments: { name: 'brief-summary', content, expectedRevision: null } }
const answer = (toolCalls = []) => ({ content: '', toolCalls })
async function fixture(t, options = {}) {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'vivi-skill-review-'))), skills = new InstalledSkillStore(profile)
  t.after(async () => { await skills.drain({ close: true }); await rm(profile, { recursive: true, force: true }) })
  return { profile, skills, host: new CliHost({ store: { async save() {} }, session: newSession({ provider: 'openai', model: 'fixture' }), enableSkills: true,
    skills, skillSaveApproval: { isAvailable: () => true, accountRevision: () => 'account-1' }, ...options }) }
}

test('native save presents exact human review and activates only in the next turn', async t => {
  let reviews = 0, rounds = 0
  const { host, skills } = await fixture(t, { approve: async request => {
    reviews++; assert.equal(request.call.name, 'save_skill'); assert.match(request.description, /SQLite/); assert.match(request.description, /After exact source/)
    assert(request.description.includes(JSON.stringify(content))); assert.equal(request.currentRevision, 'new installed skill'); return true
  }, provider: { async generate(input) {
    assert(input.tools.some(tool => tool.name === 'save_skill'))
    if (++rounds === 1) return answer([call])
    if (rounds === 2) {
      assert.equal(JSON.parse(input.messages.find(message => message.kind === 'tool_result').content).saved, true)
      assert(!input.messages.some(message => message.role === 'user' && message.content.includes('Summarize supplied text.')))
    } else assert(input.messages.some(message => message.role === 'user' && message.content.includes('Summarize supplied text.')))
    return answer()
  } } })
  assert.equal((await host.send('Create this skill')).status, 'completed'); assert.equal(reviews, 1)
  assert.equal((await skills.snapshot()).document('brief-summary').content, content)
  await host.send('Use the saved skill')
})

for (const kind of ['denied', 'cancelled', 'account-changed']) test(`human review ${kind} preserves installed source`, async t => {
  let host, account = 'account-1', reviews = 0, rounds = 0
  const f = await fixture(t, { skillSaveApproval: { isAvailable: () => true, accountRevision: () => account }, approve: async () => {
    reviews++; if (kind === 'cancelled') host.cancel(); if (kind === 'account-changed') account = 'account-2'; return kind !== 'denied'
  }, provider: { async generate() { return ++rounds === 1 ? answer([call]) : answer() } } })
  host = f.host; await host.send('Create this skill'); assert.equal(reviews, 1)
  assert.equal((await f.skills.snapshot()).document('brief-summary'), undefined)
  assert.deepEqual(await readdir(f.profile), [])
})

for (const kind of ['headless', 'plan', 'no-tools', 'disabled']) test(`${kind} does not advertise or dispatch native saving`, async t => {
  let rounds = 0, reviews = 0
  const options = { provider: { async generate(input) { assert(!input.tools.some(tool => tool.name === 'save_skill')); return ++rounds === 1 ? answer([call]) : answer() } }, approve: async () => { reviews++; return true } }
  if (kind === 'headless') options.skillSaveApproval = undefined
  if (kind === 'no-tools') options.enableTools = false
  if (kind === 'disabled') options.enableSkills = false
  const f = await fixture(t, options)
  if (kind === 'plan') f.host.setTaskMode('plan')
  await f.host.send('Create this skill'); assert.equal(reviews, 0); assert.deepEqual(await readdir(f.profile), [])
})

test('Auto mode still requires human review and never calls the model reviewer for skill saving', async t => {
  let rounds = 0, human = 0, automatic = 0
  const f = await fixture(t, { decisionReview: {
    provider: { id: 'openai', model: 'gpt-6-luna', async evaluate() { automatic++; throw new Error('Unexpected automatic skill review') } },
    ledger: { async upsert() {} }, canAutoReview: true, accountRevision: () => 'account-1'
  }, approve: async () => { human++; return true }, provider: { async generate(input) {
    assert(input.tools.some(tool => tool.name === 'save_skill')); return ++rounds === 1 ? answer([call]) : answer()
  } } })
  f.host.setApprovalMode('auto'); await f.host.send('Create this skill')
  assert.equal(human, 1); assert.equal(automatic, 0); assert.equal((await f.skills.snapshot()).document('brief-summary').content, content)
})

test('oversized exact review is denied in the host before any approval callback or commit', async t => {
  let rounds = 0, reviews = 0
  const large = content.replace('Return three factual points.', 'x'.repeat(64_000))
  const f = await fixture(t, { approve: async () => { reviews++; return true }, provider: { async generate() {
    return ++rounds === 1 ? answer([{ ...call, arguments: { ...call.arguments, content: large } }]) : answer()
  } } })
  const result = await f.host.send('Create this large skill')
  assert.equal(reviews, 0); assert.equal((await f.skills.snapshot()).document('brief-summary'), undefined)
  assert(result.history.some(message => message.kind === 'tool_result' && message.content.includes('display limit')))
})

test('exact review preserves readable Unicode and escapes C1/bidi without changing source', async t => {
  let rounds = 0, reviews = 0
  const exact = content.replace('Return three factual points.', 'Return café ☕, 中文 and 日本語. Preserve literal C1: \u009b31m and bidi: \u202e.')
  const f = await fixture(t, { approve: async request => {
    reviews++
    const encoded = request.description.split('After exact source: ')[1]
    assert.equal(JSON.parse(encoded), exact)
    assert(encoded.includes('café ☕, 中文 and 日本語')); assert(!/[\u007f-\u009f\u202e]/.test(encoded))
    assert(encoded.includes('\\u009b')); assert(encoded.includes('\\u202e'))
    return true
  }, provider: { async generate() { return ++rounds === 1 ? answer([{ ...call, arguments: { ...call.arguments, content: exact } }]) : answer() } } })
  await f.host.send('Save this Unicode instruction text')
  assert.equal(reviews, 1); assert.equal((await f.skills.snapshot()).document('brief-summary').content, exact)
})

test('cancellation detaches an approval callback that ignores abort and cannot authorize a late save', async t => {
  let rounds = 0, releaseReview, reviewStarted
  const started = new Promise(resolve => { reviewStarted = resolve })
  const f = await fixture(t, { approve: async () => { reviewStarted(); return new Promise(resolve => { releaseReview = resolve }) },
    provider: { async generate() { return ++rounds === 1 ? answer([call]) : answer() } } })
  const sending = f.host.send('Create this skill'), timeout = AbortSignal.timeout(2_000)
  await started; f.host.cancel()
  try {
    const settled = await Promise.race([sending, new Promise((_resolve, reject) => timeout.addEventListener('abort', () => reject(new Error('Cancelled save waited for unresolved approval')), { once: true }))])
    assert.equal(settled.status, 'cancelled')
  } finally { releaseReview(true) }
  await Promise.resolve(); await f.host.drainSkills()
  assert.equal((await f.skills.snapshot()).document('brief-summary'), undefined)
  await f.host.send('Continue ordinary chat')
  assert.equal((await f.skills.snapshot()).document('brief-summary'), undefined)
})
