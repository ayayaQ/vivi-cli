// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileSkillStore } from '../dist/skills.js'

const firstId = 2n ** 53n, secondId = firstId + 1n
const key = info => `${info.dev}:${info.ino}`
const source = name => `---\nname: ${name}\ndescription: Ordinary explicitly approved read-only text.\n---\n\nInert skill text.\n`
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'vivi-skill-identity-')))
  const profile = join(base, 'profile'), owned = join(profile, 'agent-skills')
  const external = join(base, 'external'), other = join(base, 'other')
  for (const directory of [owned, external, other]) await fs.mkdir(directory, { recursive: true })
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  return { profile, owned, external, other }
}
async function put(root, name) {
  const directory = join(root, name)
  await fs.mkdir(join(directory, 'references'), { recursive: true })
  await fs.writeFile(join(directory, 'SKILL.md'), source(name))
  await fs.writeFile(join(directory, 'references', 'detail.md'), `Resource for ${name}`)
  return join(directory, 'SKILL.md')
}

// Override only metadata on ordinary temporary files. Real filesystem operations,
// descriptors and all production path/permission checks still run normally.
async function identities(t, entries, { openedFile, timeShiftFile } = {}) {
  const actualLstat = fs.lstat, actualOpen = fs.open, mapping = new Map()
  for (const [path, id] of entries) mapping.set(key(await actualLstat(path, { bigint: true })), id)
  const changed = openedFile && key(await actualLstat(openedFile, { bigint: true }))
  const shifted = timeShiftFile && key(await actualLstat(timeShiftFile, { bigint: true }))
  const translate = (info, exact, opened = false) => {
    let id = mapping.get(key(exact))
    if (opened && key(exact) === changed) id = secondId
    const changes = { ...(id === undefined ? {} : { ino: typeof info.ino === 'bigint' ? id : Number(id) }),
      ...(opened && key(exact) === shifted ? { mtimeNs: exact.mtimeNs + 1n } : {}) }
    return Object.keys(changes).length ? Object.assign(Object.create(Object.getPrototypeOf(info)), info, changes) : info
  }
  t.mock.method(fs, 'lstat', async (path, options) => {
    const exact = await actualLstat(path, { bigint: true })
    return translate(options?.bigint ? exact : await actualLstat(path, options), exact)
  })
  t.mock.method(fs, 'open', async (...args) => {
    const handle = await actualOpen(...args), actualStat = handle.stat.bind(handle)
    handle.stat = async options => {
      const exact = await actualStat({ bigint: true })
      return translate(options?.bigint ? exact : await actualStat(options), exact, true)
    }
    return handle
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
}
async function read(catalog, name) {
  const document = catalog.document(name)
  assert(document, `Missing ${name}`)
  return catalog.read({ name, path: 'references/detail.md', expectedRevision: document.revision }, { signal: new AbortController().signal })
}

test('distinct 64-bit sibling identities never invent profile overlap for an approved import', async t => {
  const f = await fixture(t)
  await put(f.external, 'imported-guide')
  assert.equal(Number(firstId), Number(secondId))
  await identities(t, [[f.profile, firstId], [f.external, secondId]])
  const store = new FileSkillStore(f.owned, { readOnlyRoots: [f.external] }), catalog = await store.snapshot()
  assert.equal(await read(catalog, 'imported-guide'), 'Resource for imported-guide')
  assert(!store.diagnostics.some(message => message.includes('overlaps the host-state profile')))
})

test('owned and imported roots with distinct 64-bit identities are both scanned', async t => {
  const f = await fixture(t)
  await put(f.owned, 'owned-guide'); await put(f.external, 'imported-guide')
  await identities(t, [[f.owned, firstId], [f.external, secondId]])
  const store = new FileSkillStore(f.owned, { readOnlyRoots: [f.external] }), catalog = await store.snapshot()
  assert.equal(await read(catalog, 'owned-guide'), 'Resource for owned-guide')
  assert.equal(await read(catalog, 'imported-guide'), 'Resource for imported-guide')
  assert(!store.diagnostics.some(message => message.includes('Repeated import root')))
})

test('distinct large imported identities preserve both roots and exclude duplicate canonical names', async t => {
  const f = await fixture(t)
  await put(f.external, 'first-guide'); await put(f.other, 'second-guide')
  await put(f.external, 'summary'); await put(f.other, 'ｓｕｍｍａｒｙ')
  await identities(t, [[f.external, firstId], [f.other, secondId]])
  const store = new FileSkillStore(f.owned, { readOnlyRoots: [f.external, f.other] }), catalog = await store.snapshot()
  assert.equal(await read(catalog, 'first-guide'), 'Resource for first-guide')
  assert.equal(await read(catalog, 'second-guide'), 'Resource for second-guide')
  assert.equal(catalog.document('summary'), undefined)
  assert(store.diagnostics.some(message => message.includes('Duplicate skill name')))
})

test('an exact repeated 64-bit root identity is still deduplicated', async t => {
  const f = await fixture(t)
  await put(f.external, 'first-guide'); await put(f.other, 'second-guide')
  await identities(t, [[f.external, firstId], [f.other, firstId]])
  const store = new FileSkillStore(f.owned, { readOnlyRoots: [f.external, f.other] }), catalog = await store.snapshot()
  assert(catalog.document('first-guide')); assert.equal(catalog.document('second-guide'), undefined)
  assert(store.diagnostics.some(message => message.includes('Repeated import root')))
})

test('a changed open-file identity cannot be hidden by Number rounding', async t => {
  const f = await fixture(t), file = await put(f.external, 'changed-guide')
  await identities(t, [[file, firstId]], { openedFile: file })
  const store = new FileSkillStore(f.owned, { readOnlyRoots: [f.external] }), catalog = await store.snapshot()
  assert.equal(catalog.document('changed-guide'), undefined)
  assert(store.diagnostics.some(message => message.includes('Skill file changed while opening it')))
})

test('exact stat timestamps retain sub-millisecond file-change detection', async t => {
  const f = await fixture(t), file = await put(f.external, 'time-guide')
  await identities(t, [], { timeShiftFile: file })
  const store = new FileSkillStore(f.owned, { readOnlyRoots: [f.external] }), catalog = await store.snapshot()
  assert.equal(catalog.document('time-guide'), undefined)
  assert(store.diagnostics.some(message => message.includes('Skill file changed while opening it')))
})
