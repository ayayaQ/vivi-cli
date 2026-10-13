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
  const documents = new Map()
  return { directory: '/synthetic-owned-store', writable: false, documents, diagnostics: [], operations: [],
    addSecrets() {}, async snapshot(signal) {
      signal?.throwIfAborted(); this.operations.push('snapshot')
      return createSkillCatalog([skillCreatorSource, ...[...documents.values()].map(content => ({ content, readOnly: true }))])
    }, async drain() {}
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
  assert.equal(captures[0].tools.some(tool => tool.name === 'save_skill'), false)
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


test('no save authority is exposed or dispatched even if a supplied store claims writable', async () => {
  const skills = skillStore(); skills.writable = true
  skills.prepare = skills.commit = () => { throw new Error('Unexpected writer') }
  let rounds = 0; const reviews = []
  const subject = host(skills, { enableSkills: true, approve: async request => { reviews.push(request); return true }, provider: { async generate(input) {
    assert(!input.tools.some(tool => tool.name === 'save_skill'))
    return ++rounds === 1 ? answer('', [call('save_skill', { name: 'new-summary', content: source('new-summary'), expectedRevision: null })]) : answer()
  } } })
  const result = await subject.send('Draft a skill for manual saving')
  assert.equal(reviews.length, 0); assert.equal(skills.documents.size, 0)
  assert(result.history.some(message => message.kind === 'tool_result' && message.isError && message.content.includes('unavailable_tool')))
})
