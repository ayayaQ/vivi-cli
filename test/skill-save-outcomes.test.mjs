// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliHost } from '../dist/host.js'
import { InstalledSkillStore, SkillSaveCommitError } from '../dist/installed-skills.js'
import { FileSessionStore } from '../dist/session.js'
import { cliHistoryToolPresentation } from '../dist/tool-presentation.js'
import { parseSkillDocument } from '@ayayaq/vivi/extensions/skills'
const content = '---\nname: brief-summary\ndescription: Summarize supplied text.\n---\n\nReturn three factual points.\n'
const call = { id: 'save-1', name: 'save_skill', arguments: { name: 'brief-summary', content, expectedRevision: null } }
function outcome(host, history = host.session.history) {
  const index = history.findIndex(message => message.kind === 'tool_result' && message.name === 'save_skill')
  assert(index >= 0)
  return cliHistoryToolPresentation(history, index, host.session.id, host.toolPresentationEvidence)
}
function assertOutcome(value, status, effect) {
  assert.equal(value.status, status); assert.equal(value.effect, effect)
  assert(value.source.reference.startsWith('cli-')); assert(!value.source.reference.startsWith('cli-session:'))
}
async function fixture(t, options = {}) {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'vivi-skill-outcome-')))
  const store = new FileSessionStore(profile), skills = new InstalledSkillStore(profile), resumed = [], live = []
  let rounds = 0, host
  host = await CliHost.create({ store, settings: { provider: 'openai', model: 'offline-skill-outcome' }, skills, enableSkills: true,
    skillSaveApproval: { isAvailable: () => true, accountRevision: () => 'account-1' },
    approve: async () => true, ...options, onEvent(event) { if (event.type === 'tool_completed') live.push(outcome(host)) },
    provider: { async generate() { return { content: '', toolCalls: ++rounds === 1 ? [call] : [] } } } })
  t.after(async () => { await host.shutdown(); for (const item of resumed) await item.shutdown(); await skills.drain({ close: true }); await rm(profile, { recursive: true, force: true }) })
  const cold = async () => {
    const value = await CliHost.resume({ id: host.session.id, store, provider: { async generate() { assert.fail('Cold replay must not execute a provider') } } })
    resumed.push(value); return value
  }
  return { profile, store, skills, host, live, cold }
}

test('save_skill has exact live, final and cold-replay local-mutation receipts after an actual SQLite commit', async t => {
  const f = await fixture(t), result = await f.host.send('Create this instruction-only skill')
  assert.equal(result.status, 'completed'); assert.equal(f.live.length, 1)
  assertOutcome(f.live[0], 'succeeded', 'confirmed'); assertOutcome(outcome(f.host), 'succeeded', 'confirmed')
  assertOutcome(outcome(await f.cold()), 'succeeded', 'confirmed')
  assert.equal((await f.skills.snapshot()).document('brief-summary').content, content)
  const changed = structuredClone(f.host.session.history)
  changed.find(message => message.kind === 'tool_result').content = '{"saved":true,"revision":"forged"}'
  assert.notEqual(outcome(f.host, changed).effect, 'confirmed', 'Result JSON cannot recreate a receipt')
})

test('cancellation after the actual SQLite commit preserves confirmed save evidence through cold replay', async t => {
  const f = await fixture(t), commit = f.skills.commit.bind(f.skills)
  f.skills.commit = async (...arguments_) => { const receipt = await commit(...arguments_); f.host.cancel(); return receipt }
  const result = await f.host.send('Create this instruction-only skill')
  assert.equal(result.status, 'cancelled')
  assert.equal(JSON.parse(result.history.find(message => message.kind === 'tool_result').content).saved, true)
  assertOutcome(outcome(f.host), 'succeeded', 'confirmed'); assertOutcome(outcome(await f.cold()), 'succeeded', 'confirmed')
})

test('terminal settlement waits for an admitted save receipt while cancellation cannot erase its committed effect', async t => {
  const f = await fixture(t), commit = f.skills.commit.bind(f.skills)
  let release, entered, settled = false
  const committed = new Promise(resolve => { entered = resolve })
  f.skills.commit = async (...arguments_) => {
    const receipt = await commit(...arguments_); entered(); await new Promise(resolve => { release = resolve }); return receipt
  }
  const pending = f.host.send('Create this instruction-only skill').then(result => { settled = true; return result })
  await committed; f.host.cancel(); await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(settled, false, 'Admitted save completion is drained before final records settle')
  release(); const result = await pending
  assert.equal(result.status, 'cancelled'); assertOutcome(outcome(f.host), 'succeeded', 'confirmed')
  assertOutcome(outcome(await f.cold()), 'succeeded', 'confirmed')
})

test('uncertain commit preserves unknown effects and receipt correlation through live, final and cold evidence', async t => {
  const f = await fixture(t), commit = f.skills.commit.bind(f.skills)
  let id
  f.skills.commit = async (...arguments_) => { const receipt = await commit(...arguments_); id = receipt.id; throw new SkillSaveCommitError(receipt.id) }
  await f.host.send('Create this instruction-only skill')
  const message = f.host.session.history.find(message => message.kind === 'tool_result'), body = JSON.parse(message.content)
  assert.equal(body.unknownOutcome, true); assert.equal(body.doNotRetry, true); assert.equal(body.receiptId, id)
  assertOutcome(f.live[0], 'unknown', 'unknown'); assertOutcome(outcome(f.host), 'unknown', 'unknown')
  assertOutcome(outcome(await f.cold()), 'unknown', 'unknown')
  assert.equal((await f.skills.snapshot()).document('brief-summary').content, content)
})

test('denied saving has exact not-attempted evidence in live, final and cold replay', async t => {
  const f = await fixture(t, { approve: async () => false })
  await f.host.send('Create this instruction-only skill')
  assertOutcome(f.live[0], 'denied', 'not_attempted'); assertOutcome(outcome(f.host), 'denied', 'not_attempted')
  assertOutcome(outcome(await f.cold()), 'denied', 'not_attempted')
  assert.equal((await f.skills.snapshot()).document('brief-summary'), undefined)
})

test('a stale revision rejected by the owned transaction has failed/not-attempted evidence', async t => {
  let other
  const f = await fixture(t, { approve: async () => {
    const after = parseSkillDocument(content.replace('three factual points', 'two factual points'))
    await other.commit({ name: 'brief-summary', before: null, expectedRevision: null, after }, { signal: new AbortController().signal })
    return true
  } })
  other = new InstalledSkillStore(f.profile); t.after(() => other.drain({ close: true }))
  await f.host.send('Create this instruction-only skill')
  assertOutcome(f.live[0], 'failed', 'not_attempted'); assertOutcome(outcome(f.host), 'failed', 'not_attempted')
  assertOutcome(outcome(await f.cold()), 'failed', 'not_attempted')
  assert.match((await f.skills.snapshot()).document('brief-summary').content, /two factual points/)
})
