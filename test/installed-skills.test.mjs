// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, realpath, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseSkillDocument } from '@ayayaq/vivi/extensions/skills'
import { InstalledSkillStore } from '../dist/installed-skills.js'
const signal = () => new AbortController().signal
const source = (name = 'brief-summary', body = 'Return three factual points.') => `---\r\nname: ${name}\r\ndescription: Summarize supplied text.\r\n---\r\n\r\n${body}\r\n`
const proposal = (content, before = null) => { const after = parseSkillDocument(content); return { name: after.metadata.name, expectedRevision: before?.revision ?? null, before, after } }
async function fixture(t) {
  const profile = await realpath(await mkdtemp(join(tmpdir(), 'vivi-installed-skills-')))
  const store = new InstalledSkillStore(profile)
  t.after(async () => { await store.drain({ close: true }); await rm(profile, { recursive: true, force: true }) })
  return { profile, store }
}

test('installed storage is lazy and exact standard source plus commit receipt publish atomically', async t => {
  const { profile, store } = await fixture(t)
  const old = await store.snapshot()
  assert.deepEqual(await readdir(profile), [])
  const content = source(), draft = proposal(content), receipt = await store.commit(draft, { signal: signal() })
  assert.equal(receipt.revision, draft.after.revision); assert.equal(receipt.beforeRevision, null); assert.equal(receipt.available, 'next_turn')
  assert.equal(old.document('brief-summary'), undefined)
  const fresh = await store.snapshot(), document = fresh.document('brief-summary')
  assert.equal(document.content, content); assert.equal(fresh.skills.find(item => item.name === 'brief-summary').readOnly, false)
  assert.equal(await fresh.read({ name: 'brief-summary', path: 'SKILL.md', expectedRevision: document.revision }, { signal: signal() }), content)
  await assert.rejects(fresh.read({ name: 'brief-summary', path: 'scripts/check.js', expectedRevision: document.revision }, { signal: signal() }), /unavailable|resource/i)
  assert.deepEqual(await readdir(store.directory), ['skills.sqlite'])
  assert.equal((await readFile(join(store.directory, 'skills.sqlite'))).subarray(0, 16).toString(), 'SQLite format 3\0')
  if (!('Bun' in globalThis)) {
    const { DatabaseSync } = await import('node:sqlite'), database = new DatabaseSync(join(store.directory, 'skills.sqlite'), { readOnly: true })
    try { assert.deepEqual({ ...database.prepare('SELECT name, content, revision, receipt_id, before_revision FROM installed_skills').get() }, { name: 'brief-summary', content, revision: receipt.revision, receipt_id: receipt.id, before_revision: null }) }
    finally { database.close() }
  }
})

test('replacement rechecks stored revision after review and preserves the winning exact source', async t => {
  const { profile, store } = await fixture(t), other = new InstalledSkillStore(profile)
  t.after(() => other.drain({ close: true }))
  await store.commit(proposal(source()), { signal: signal() })
  const before = (await store.snapshot()).document('brief-summary')
  const winner = source('brief-summary', 'An explicitly reviewed replacement.')
  await other.commit(proposal(winner, before), { signal: signal() })
  await assert.rejects(store.commit(proposal(source('brief-summary', 'Older proposal.'), before), { signal: signal() }), /revision changed/)
  assert.equal((await store.snapshot()).document('brief-summary').content, winner)
})

test('two cooperating stores serialize creation with one successful compare-and-swap', async t => {
  const { profile, store } = await fixture(t), other = new InstalledSkillStore(profile)
  t.after(() => other.drain({ close: true }))
  const results = await Promise.allSettled([store.commit(proposal(source()), { signal: signal() }), other.commit(proposal(source()), { signal: signal() })])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal((await store.snapshot()).document('brief-summary').content, source())
})

test('legacy folders and explicit imports remain unchanged, read-only, and unshadowed', async t => {
  const { profile, store } = await fixture(t), root = join(profile, 'agent-skills'), folder = join(root, 'legacy-guide')
  await mkdir(folder, { recursive: true }); const content = source('legacy-guide'); await writeFile(join(folder, 'SKILL.md'), content)
  assert.equal((await store.snapshot()).skills.find(item => item.name === 'legacy-guide').readOnly, true)
  await assert.rejects(store.commit(proposal(source('legacy-guide', 'Replacement.')), { signal: signal() }), /Read-only/)
  await assert.rejects(store.commit(proposal(source('skill-creator')), { signal: signal() }), /Read-only/)
  assert.equal(await readFile(join(folder, 'SKILL.md'), 'utf8'), content)
  assert.deepEqual((await readdir(profile)).sort(), ['agent-skills'])
  await store.commit(proposal(source()), { signal: signal() })
  const collision = join(root, 'brief-summary'); await mkdir(collision); await writeFile(join(collision, 'SKILL.md'), source())
  const catalog = await store.snapshot()
  assert.equal(catalog.document('brief-summary'), undefined); assert(store.diagnostics.some(item => item.includes('Duplicate')))
  assert(catalog.document('skill-creator'))
})

test('cancelled or changed review context and known credentials cannot commit', async t => {
  const { profile, store } = await fixture(t), controller = new AbortController()
  controller.abort()
  await assert.rejects(store.commit(proposal(source()), { signal: controller.signal }), /abort/i)
  await assert.rejects(store.commit(proposal(source()), { signal: signal(), assertCurrent() { throw new Error('Context changed') } }))
  store.addSecrets(['SYNTHETIC_TEST_CREDENTIAL'])
  await assert.rejects(store.commit(proposal(source('brief-summary', 'SYNTHETIC_TEST_CREDENTIAL')), { signal: signal() }), /credentials/)
  assert.deepEqual(await readdir(profile), [])
  await store.commit(proposal(source()), { signal: signal() })
  await store.drain({ close: true }); await assert.rejects(store.snapshot(), /closed/)
})

test('incomplete read-only import discovery withholds installed names and prevents new saving', async t => {
  const { profile, store } = await fixture(t)
  await store.commit(proposal(source()), { signal: signal() })
  const unavailable = join(profile, 'agent-skills'); await writeFile(unavailable, 'Ordinary unavailable legacy collection')
  assert.equal((await store.snapshot()).document('brief-summary'), undefined)
  await assert.rejects(store.commit(proposal(source('another-guide')), { signal: signal() }), /complete read-only import/)
  assert(store.diagnostics.some(item => item.includes('incomplete')))
})

for (const stage of ['before-commit', 'after-commit']) test(`native ${stage} exception is reconciled using the atomic receipt`, { skip: 'Bun' in globalThis }, async t => {
  const { store } = await fixture(t), { DatabaseSync } = await import('node:sqlite')
  const exec = DatabaseSync.prototype.exec
  let injected = false
  DatabaseSync.prototype.exec = function (sql) {
    if (sql === 'COMMIT' && !injected) {
      injected = true
      if (stage === 'after-commit') exec.call(this, sql)
      throw new Error('Synthetic native commit diagnostic')
    }
    return exec.call(this, sql)
  }
  try {
    if (stage === 'before-commit') {
      await assert.rejects(store.commit(proposal(source()), { signal: signal() }), /did not commit/)
      assert.equal((await store.snapshot()).document('brief-summary'), undefined)
    } else {
      const receipt = await store.commit(proposal(source()), { signal: signal() })
      assert.equal(receipt.revision, parseSkillDocument(source()).revision)
      assert.equal((await store.snapshot()).document('brief-summary').content, source())
    }
  } finally { DatabaseSync.prototype.exec = exec }
})

test('saving cannot exceed the combined creator/import/installed catalog bound', async t => {
  const { profile, store } = await fixture(t), root = join(profile, 'agent-skills')
  await mkdir(root)
  for (let index = 0; index < 99; index++) {
    const name = `import-${index}`, directory = join(root, name)
    await mkdir(directory); await writeFile(join(directory, 'SKILL.md'), source(name))
  }
  assert.equal((await store.snapshot()).skills.length, 100)
  await assert.rejects(store.commit(proposal(source()), { signal: signal() }), /combined catalog limits/)
  assert.equal((await store.snapshot()).document('brief-summary'), undefined)
})
