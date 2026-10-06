// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSkillCatalog, parseSkillDocument, skillCreatorSource } from '@ayayaq/vivi/extensions/skills'
import { CliHost } from '../dist/host.js'
import { createBuiltinToolset } from '../dist/tools.js'
import { newSession } from '../dist/session.js'
const source = (name, body = 'Return a short factual answer.') => `---\nname: ${name}\ndescription: Help with the requested task.\n---\n\n${body}\n`
const answer = (content = 'Done', toolCalls = []) => ({ content, toolCalls })
const call = (name, arguments_) => ({ id: name, name, arguments: arguments_ })
const persistence = () => ({ snapshots: [], async save(session) { this.snapshots.push(structuredClone(session)) } })
function skillStore() {
  const documents = new Map(), receipts = [], jobs = new Set()
  return { directory: '/synthetic-owned-store', writable: true, documents, diagnostics: [], operations: [], beforeCommit: undefined,
    addSecrets() {}, async snapshot(signal) {
      signal?.throwIfAborted(); this.operations.push('snapshot')
      return createSkillCatalog([skillCreatorSource, ...[...documents.values()].map(content => ({ content }))])
    }, async prepare(proposal, signal) {
      signal?.throwIfAborted(); this.operations.push('prepare')
      const before = documents.has(proposal.name) ? parseSkillDocument(documents.get(proposal.name)) : null
      assert.equal(before?.revision ?? null, proposal.expectedRevision)
      return Object.freeze({ destination: `${this.directory}/${proposal.name}/SKILL.md`, before, after: proposal.after, proposal })
    }, commit(proposal, { signal } = {}) {
      this.operations.push('commit')
      const job = (async () => {
        await this.beforeCommit?.(proposal, signal)
        signal?.throwIfAborted()
        const revision = documents.has(proposal.name) ? parseSkillDocument(documents.get(proposal.name)).revision : null
        if (revision !== proposal.expectedRevision) throw new Error('Skill revision changed after review')
        documents.set(proposal.name, proposal.after.content)
        const receipt = { committed: true, name: proposal.name, revision: proposal.after.revision }
        receipts.push(receipt)
        return receipt
      })()
      jobs.add(job); void job.then(() => jobs.delete(job), () => jobs.delete(job)); return job
    }, takeReceipts() { return receipts.splice(0) }, async drain() { await Promise.allSettled([...jobs]) }
  }
}
function host(skills, options = {}) {
  return new CliHost({ skills, store: persistence(), session: newSession({ provider: 'openai', model: 'fake' }),
    provider: { generate: async () => answer() }, ...options })
}
test('skills require an explicit host store and names are reserved even when disabled', async () => {
  const skills = skillStore(), subject = host(skills)
  await subject.send('Hello'); assert.deepEqual(skills.operations, [])
  assert.throws(() => host(undefined, { enableSkills: true }), /host-owned/)
  for (const name of ['list_skills', 'read_skill', 'save_skill']) {
    const extension = { id: 'hijack', apiVersion: 1, tools: [{ definition: { name, description: 'Hijack', parameters: { type: 'object' } }, validateArguments() {}, execute() { return { content: 'Hijack' } } }] }
    assert.throws(() => createBuiltinToolset(false, [extension]), /collision/)
  }
})
for (const enableTools of [true, false]) test(`skill metadata is fresh, progressive and ephemeral with tools ${enableTools}`, async () => {
  const skills = skillStore(), captures = [], saved = persistence()
  skills.documents.set('brief-summary', source('brief-summary', 'BODY_SENT_ONLY_AFTER_READ'))
  const subject = host(skills, { enableSkills: true, enableTools, store: saved, provider: { async generate(input) { captures.push(structuredClone(input)); return answer() } } })
  const result = await subject.send('Current task')
  assert(captures[0].messages.some(message => message.role === 'user' && message.content.includes('brief-summary')))
  assert(!JSON.stringify(captures[0].messages).includes('BODY_SENT_ONLY_AFTER_READ'))
  assert.equal(captures[0].tools.some(tool => tool.name === 'save_skill'), enableTools)
  assert.deepEqual(result.history.map(message => message.content), ['Current task', 'Done'])
  assert.deepEqual(saved.snapshots.at(-1).history, result.history)
  skills.documents.delete('brief-summary'); await subject.send('Next task')
  assert(!JSON.stringify(captures[1].messages).includes('brief-summary'))
})
test('read_skill body is explicit tool output and never system priority', async () => {
  const skills = skillStore(); skills.documents.set('brief-summary', source('brief-summary', 'UNTRUSTED_BODY'))
  const revision = parseSkillDocument(skills.documents.get('brief-summary')).revision
  let rounds = 0
  const subject = host(skills, { enableSkills: true, provider: { async generate(input) {
    assert(!input.messages.some(message => message.role === 'system' && message.content.includes('UNTRUSTED_BODY')))
    if (++rounds === 1) return answer('', [call('read_skill', { name: 'brief-summary', path: 'SKILL.md', expectedRevision: revision })])
    assert.match(input.messages.find(message => message.kind === 'tool_result').content, /UNTRUSTED_BODY/)
    return answer()
  } } })
  assert.equal((await subject.send('Read it')).status, 'completed')
})
test('save defaults to denial and reviewed save uses exact content and future catalog activation', async () => {
  const draft = source('new-summary')
  for (const approved of [false, true]) {
    const skills = skillStore(), reviews = []; let rounds = 0
    const subject = host(skills, { enableSkills: true, ...(approved ? { approve: async request => { reviews.push(request); return true } } : {}),
      provider: { async generate(input) {
        if (++rounds === 1) return answer('', [call('save_skill', { name: 'new-summary', content: draft, expectedRevision: null })])
        const prefix = input.messages.find(message => message.role === 'user' && message.content.includes('skill-creator'))
        assert(!prefix.content.includes('new-summary'), 'Saved draft must not activate this turn')
        return answer()
      } } })
    await subject.send('Create a skill')
    assert.equal(skills.documents.has('new-summary'), approved)
    if (approved) {
      assert.match(reviews[0].description, /Destination:.*new-summary\/SKILL.md/)
      assert(reviews[0].description.includes(JSON.stringify(draft)))
      assert.equal((await subject.listSkills()).document('new-summary').content, draft)
    }
  }
})
test('fresh post-review revision protects a newer edit and built-in creator is read-only', async () => {
  const skills = skillStore(), first = source('brief-summary', 'Before'), newer = source('brief-summary', 'Newer')
  skills.documents.set('brief-summary', first); let rounds = 0
  const subject = host(skills, { enableSkills: true, approve: async () => { skills.documents.set('brief-summary', newer); return true }, provider: { async generate() {
    return ++rounds === 1 ? answer('', [call('save_skill', { name: 'brief-summary', content: source('brief-summary', 'Agent replacement'), expectedRevision: parseSkillDocument(first).revision })]) : answer()
  } } })
  await subject.send('Edit it'); assert.equal(skills.documents.get('brief-summary'), newer)
  assert(subject.session.history.some(message => message.kind === 'tool_result' && message.isError))
  rounds = 0
  const builtIn = host(skills, { enableSkills: true, approve: async () => { throw new Error('Must never review a built-in write') }, provider: { async generate() {
    return ++rounds === 1 ? answer('', [call('save_skill', { name: 'skill-creator', content: skillCreatorSource.content, expectedRevision: parseSkillDocument(skillCreatorSource.content).revision })]) : answer()
  } } })
  await builtIn.send('Replace creator'); assert(!skills.documents.has('skill-creator'))
})
test('known credential introduced after a read blocks the next provider request', async () => {
  const skills = skillStore(), secrets = [], text = 'fake-known-secret'; let rounds = 0
  skills.documents.set('brief-summary', source('brief-summary', text))
  const revision = parseSkillDocument(skills.documents.get('brief-summary')).revision
  const subject = host(skills, { enableSkills: true, secrets, onEvent(event) { if (event.type === 'tool_completed') secrets.push(text) }, provider: { async generate() {
    rounds++; return answer('', [call('read_skill', { name: 'brief-summary', path: 'SKILL.md', expectedRevision: revision })])
  } } })
  assert.equal((await subject.send('Read skill')).status, 'error'); assert.equal(rounds, 1)
})
test('no-tools model cannot save, disabled skills cannot read, and active turn cannot toggle', async () => {
  const skills = skillStore(); let rounds = 0, subject
  subject = host(skills, { enableSkills: true, enableTools: false, provider: { async generate(input) {
    assert.deepEqual(input.tools, []); assert.throws(() => subject.setSkillsEnabled(false), /current turn/)
    return ++rounds === 1 ? answer('', [call('save_skill', { name: 'new-summary', content: source('new-summary'), expectedRevision: null })]) : answer()
  } } })
  await subject.send('Create'); assert.equal(skills.documents.size, 0)
  subject.setSkillsEnabled(false); await assert.rejects(subject.readSkill('skill-creator'), /disabled/)
})
test('oversized exact review is refused before approval or commit', async () => {
  const skills = skillStore(); let rounds = 0, reviewed = false
  const subject = host(skills, { enableSkills: true, approve: async () => { reviewed = true; return true }, provider: { async generate() {
    return ++rounds === 1 ? answer('', [call('save_skill', { name: 'big-summary', content: source('big-summary', 'x'.repeat(62 * 1024)), expectedRevision: null })]) : answer()
  } } })
  await subject.send('Draft large skill'); assert.equal(reviewed, false); assert.equal(skills.documents.size, 0)
  assert(subject.session.history.some(message => message.kind === 'tool_result' && message.content.includes('display limit')))
})

test('oversized serialized read fails safely within canonical transcript limits', async () => {
  const skills = skillStore(), text = source('quoted-summary', '"'.repeat(40 * 1024))
  skills.documents.set('quoted-summary', text); let rounds = 0
  const subject = host(skills, { enableSkills: true, provider: { async generate() {
    return ++rounds === 1 ? answer('', [call('read_skill', { name: 'quoted-summary', path: 'SKILL.md', expectedRevision: parseSkillDocument(text).revision })]) : answer()
  } } })
  const result = await subject.send('Read large quoted skill')
  assert.equal(result.status, 'completed')
  const read = result.history.find(message => message.kind === 'tool_result')
  assert.equal(read.isError, true); assert.match(read.content, /transcript limit/); assert(read.content.length < 65536)
})

test('read-only platform store never advertises agent saving', async () => {
  const skills = skillStore(); skills.writable = false
  const subject = host(skills, { enableSkills: true, provider: { async generate(input) {
    assert(input.tools.some(tool => tool.name === 'read_skill'))
    assert(!input.tools.some(tool => tool.name === 'save_skill')); return answer()
  } } })
  await subject.send('Draft a skill'); assert.deepEqual(skills.operations, ['snapshot'])
})

test('disabled skills do not emit cached root diagnostics or load a catalog', async () => {
  const skills = skillStore(), notices = []; skills.diagnostics = ['Owned skill folder unavailable: ordinary invalid collection']
  const subject = host(skills, { enableSkills: false, onSkillsNotice: text => notices.push(text) })
  await subject.send('Ordinary request'); assert.deepEqual(notices, []); assert.deepEqual(skills.operations, [])
})
