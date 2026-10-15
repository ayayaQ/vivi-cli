// SPDX-License-Identifier: Apache-2.0
// Offline compiled SQLite consumer. Only this process's synthetic local fixtures are used.
import assert from 'node:assert/strict'
import { mkdtemp, realpath, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InstalledSkillStore } from '../../dist/installed-skills.js'
import { parseSkillDocument } from '@ayayaq/vivi/extensions/skills'
import { CliHost } from '../../dist/host.js'
import { newSession } from '../../dist/session.js'
const profile = await realpath(await mkdtemp(join(tmpdir(), 'vivi-compiled-installed-skills-')))
const store = new InstalledSkillStore(profile)
const source = '---\nname: compiled-guide\ndescription: Return a concise factual answer.\n---\n\nUse supplied evidence.\n'
let reviews = 0, rounds = 0
try {
  const old = await store.snapshot()
  const host = new CliHost({ provider: { async generate(input) {
    assert(input.tools.some(tool => tool.name === 'save_skill'))
    return { content: '', toolCalls: ++rounds === 1 ? [{ id: 'compiled-save', name: 'save_skill', arguments: { name: 'compiled-guide', content: source, expectedRevision: null } }] : [] }
  } }, store: { async save() {} }, session: newSession({ provider: 'openai', model: 'synthetic-fixture' }),
    enableSkills: true, skills: store, skillSaveApproval: { isAvailable: () => true, accountRevision: () => 'compiled-fixture-account' },
    approve: async request => { reviews++; assert(request.description.includes(JSON.stringify(source))); return true } })
  assert.equal((await host.send('Create the supplied instruction-only guide')).status, 'completed')
  assert.equal(reviews, 1); assert.equal(old.document('compiled-guide'), undefined)
  const cold = new InstalledSkillStore(profile)
  try {
    const document = (await cold.snapshot()).document('compiled-guide')
    assert.equal(document.content, source); assert.equal(document.revision, parseSkillDocument(source).revision)
    await assert.rejects(cold.commit({ name: 'compiled-guide', before: null, expectedRevision: null, after: document }, { signal: new AbortController().signal }), /revision changed/)
    const updated = parseSkillDocument(source.replace('Use supplied evidence.', 'Check supplied evidence first.'))
    await cold.commit({ name: 'compiled-guide', before: document, expectedRevision: document.revision, after: updated }, { signal: new AbortController().signal })
    assert.equal((await store.snapshot()).document('compiled-guide').content, updated.content)
    assert.deepEqual(await readdir(store.directory), ['skills.sqlite'])
  } finally { await cold.drain({ close: true }) }
  console.log('Compiled installed-skill exact review, SQLite save/receipt, restart, stale revision and next-turn snapshot passed')
} finally { await store.drain({ close: true }); await rm(profile, { recursive: true, force: true }) }
