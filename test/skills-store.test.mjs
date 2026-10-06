// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import fs, { link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSkillDocument, SKILL_LIMITS } from '@ayayaq/vivi/extensions/skills';
import { FileSkillStore } from '../dist/skills.js';

const test = (name, fn) => nodeTest(name, { timeout: 20_000, skip: process.platform !== 'linux' ? 'Requires validated Linux descriptor-relative writes; fallback hosts are read-only' : false }, fn);
const signal = () => new AbortController().signal;
const source = (name = 'concise-summary', body = 'Return three factual bullets.', extra = '') =>
  `---\nname: ${name}\ndescription: Summarize supplied text when requested.\n${extra}---\n\n${body}\n`;
const proposal = (content, before = null) => {
  const after = parseSkillDocument(content);
  return { name: after.metadata.name, expectedRevision: before?.revision ?? null, before, after };
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'vivi-skills-'));
  const directory = join(base, 'profile', 'agent-skills');
  const external = join(base, 'external');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(external, { mode: 0o700 });
  t.after(() => rm(base, { recursive: true, force: true }));
  const store = new FileSkillStore(directory, options);
  return { base, directory, external, store };
}
async function put(root, name, content = source(name)) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, 'SKILL.md'), content, { mode: 0o600 });
  return directory;
}
async function save(store, content, before = null) {
  const prepared = await store.prepare(proposal(content, before));
  return store.commit(prepared.proposal);
}
function mockFs(t, name, replacement) {
  t.mock.method(fs, name, replacement);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
async function child(code, args) {
  const processChild = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let error = '';
  processChild.stdout.on('data', data => { output += data; });
  processChild.stderr.on('data', data => { error += data; });
  const status = await new Promise((resolve, reject) => {
    processChild.once('error', reject); processChild.once('close', resolve);
  });
  assert.equal(status, 0, error);
  return output;
}

test('construction is lazy; fresh catalog includes the immutable creator and no data files', async t => {
  const { base } = await fixture(t);
  const directory = join(base, 'new-profile', 'agent-skills');
  const store = new FileSkillStore(directory);
  await assert.rejects(lstat(directory), { code: 'ENOENT' });
  const catalog = await store.snapshot();
  assert.deepEqual(catalog.skills.map(item => [item.name, item.readOnly]), [['skill-creator', true]]);
  assert.deepEqual(await readdir(directory), []);
  assert.ok(Object.isFrozen(catalog));
  assert.ok(Object.isFrozen(catalog.skills));
  if (process.platform !== 'win32') assert.equal((await lstat(directory)).mode & 0o777, 0o700);
});

test('save review freezes exact standard source, destination and before/after; catalogs stay per-turn', async t => {
  const { store, directory } = await fixture(t);
  const empty = await store.snapshot();
  const raw = source('concise-summary', ' Preserve spacing exactly. \r\n');
  const input = proposal(raw);
  const prepared = await store.prepare(input);
  assert.equal(prepared.destination, join(directory, input.name, 'SKILL.md'));
  assert.equal(prepared.before, null);
  assert.equal(prepared.after.content, raw);
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(prepared.proposal.after.metadata));
  input.after = parseSkillDocument(source('concise-summary', 'Changed after preparation'));
  const receipt = await store.commit(prepared.proposal);
  assert.deepEqual(receipt, { committed: true, futureTurn: true, name: 'concise-summary', revision: prepared.after.revision });
  assert.equal(await readFile(prepared.destination, 'utf8'), raw);
  assert.equal(empty.document('concise-summary'), undefined);
  const next = await store.snapshot();
  assert.equal(next.document('concise-summary').content, raw);
  const revised = source('concise-summary', 'Use five bullets.');
  await save(store, revised, next.document('concise-summary'));
  assert.equal(next.document('concise-summary').content, raw);
  assert.equal(await readFile(join(directory, 'concise-summary', 'SKILL.md.bak'), 'utf8'), raw);
  assert.equal(new FileSkillStore(directory).directory, store.directory);
  assert.equal((await new FileSkillStore(directory).snapshot()).document('concise-summary').content, revised);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(prepared.destination)).mode & 0o777, 0o600);
    assert.equal((await lstat(join(directory, input.name))).mode & 0o777, 0o700);
  }
  assert.equal(store.receipts.length, 2);
  assert.equal(store.takeReceipts().length, 2);
  assert.equal(store.receipts.length, 0);
});

test('extra roots are explicit and read-only; built-ins and external names cannot be overwritten or shadowed', async t => {
  const { directory, external } = await fixture(t);
  await put(external, 'external-guide');
  const ordinary = new FileSkillStore(directory);
  assert.equal((await ordinary.snapshot()).document('external-guide'), undefined);
  const store = new FileSkillStore(directory, { readOnlyRoots: [external] });
  const catalog = await store.snapshot();
  assert.equal(catalog.skills.find(item => item.name === 'external-guide').readOnly, true);
  await assert.rejects(store.prepare(proposal(source('external-guide'))), /read-only/);
  await assert.rejects(store.commit(proposal(source('skill-creator'))), /read-only/);
  assert.throws(() => new FileSkillStore(directory, { readOnlyRoots: [join(directory, '..')] }), /host-state profile/);
  assert.throws(() => new FileSkillStore(directory, { readOnlyRoots: [directory] }), /host-state profile/);
});

test('unknown frontmatter, invalid sources and duplicate canonical names are diagnosed and excluded', async t => {
  const { directory, external } = await fixture(t);
  await put(directory, 'unknown-semantics', source('unknown-semantics', 'Text', 'disable-model-invocation: true\n'));
  await put(directory, 'wrong-name', source('other-name'));
  await put(directory, 'duplicate-guide');
  await put(external, 'duplicate-guide');
  await put(directory, 'skill-creator');
  const store = new FileSkillStore(directory, { readOnlyRoots: [external] });
  const catalog = await store.snapshot();
  assert.deepEqual(catalog.skills.map(item => item.name), ['skill-creator']);
  assert.ok(store.diagnostics.some(message => /unsupported frontmatter/i.test(message)));
  assert.ok(store.diagnostics.some(message => /directory name/.test(message)));
  assert.ok(store.diagnostics.some(message => /Duplicate/.test(message)));
  await assert.rejects(store.prepare(proposal(source('unknown-semantics', 'Text', 'new-field: value\n'))), /Unsupported/);
});

test('strict UTF-8, byte, catalog-count and summary bounds are enforced without replacing originals', async t => {
  const { directory, store } = await fixture(t);
  const invalid = await put(directory, 'invalid-encoding');
  await writeFile(join(invalid, 'SKILL.md'), Buffer.from([0xff, 0xfe, 0x00]));
  const oversized = await put(directory, 'oversized');
  await writeFile(join(oversized, 'SKILL.md'), Buffer.alloc(SKILL_LIMITS.maximumDocumentBytes + 1, 0x61));
  let catalog = await store.snapshot();
  assert.equal(catalog.document('invalid-encoding'), undefined);
  assert.equal(catalog.document('oversized'), undefined);
  assert.ok(store.diagnostics.some(message => /UTF-8/.test(message)));
  assert.ok(store.diagnostics.some(message => /bounded regular file/.test(message)));
  await rm(invalid, { recursive: true }); await rm(oversized, { recursive: true });
  for (let index = 0; index < 110; index++) await put(directory, `guide-${index}`);
  catalog = await store.snapshot();
  assert.equal(catalog.skills.length, 100);
  assert.ok(store.diagnostics.some(message => /count limit/.test(message)));
});

test('scan total-document and catalog-summary limits exclude excess sources', async t => {
  const { directory, store } = await fixture(t);
  for (let index = 0; index < 40; index++) await put(directory, `large-${index}`, source(`large-${index}`, 'x'.repeat(60_000)));
  const catalog = await store.snapshot();
  assert.ok(catalog.skills.length < 40);
  assert.ok(catalog.skills.reduce((total, item) => total + Buffer.byteLength(catalog.document(item.name).content), 0) <= SKILL_LIMITS.maximumTotalDocumentBytes);
  assert.ok(store.diagnostics.length > 0);
  for (const name of await readdir(directory)) await rm(join(directory, name), { recursive: true, force: true });
  for (let index = 0; index < 40; index++) {
    const name = `long-description-${index}`;
    await put(directory, name, source(name).replace('Summarize supplied text when requested.', 'd'.repeat(1_000)));
  }
  const summaries = await store.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(summaries.skills)) <= SKILL_LIMITS.maximumCatalogBytes);
  assert.ok(store.diagnostics.some(message => /summary byte limit/.test(message)));
});

test('source and ancestor symlinks are refused, including owned-root and explicit external-root substitutions', async t => {
  const { base, directory, external, store } = await fixture(t);
  const outside = await put(external, 'outside-guide');
  await symlink(outside, join(directory, 'escaped-guide'), process.platform === 'win32' ? 'junction' : 'dir');
  const unsafeFile = await put(directory, 'unsafe-file');
  await unlink(join(unsafeFile, 'SKILL.md'));
  await symlink(join(outside, 'SKILL.md'), join(unsafeFile, 'SKILL.md'));
  assert.deepEqual((await store.snapshot()).skills.map(item => item.name), ['skill-creator']);
  await assert.rejects(store.prepare(proposal(source('escaped-guide'))), /real, contained/);
  await symlink(directory, join(base, 'linked-root'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new FileSkillStore(join(base, 'linked-root')).snapshot(), /symlinks|junctions/);
  await rename(directory, join(base, 'old-owned'));
  await symlink(external, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.snapshot(), /symlinks|junctions/);
});

test('resource reads return inert text and bind exact revision and root; traversal and protected host-state names fail', async t => {
  const { directory, store } = await fixture(t);
  const skill = await put(directory, 'resource-guide');
  await mkdir(join(skill, 'references'), { mode: 0o700 });
  await writeFile(join(skill, 'references', 'notes.txt'), 'Inert reference text', { mode: 0o600 });
  await writeFile(join(skill, '.env'), 'private', { mode: 0o600 });
  const catalog = await store.snapshot();
  const document = catalog.document('resource-guide');
  const request = path => ({ name: 'resource-guide', path, expectedRevision: document.revision });
  assert.equal(await catalog.read(request('references/notes.txt'), { signal: signal() }), 'Inert reference text');
  await assert.rejects(catalog.read(request('../sessions/session.json'), { signal: signal() }), /safe components/);
  await assert.rejects(catalog.read(request('.env'), { signal: signal() }), /host-state paths/);
  await assert.rejects(catalog.read(request('credentials.json'), { signal: signal() }), /host-state paths/);
  await writeFile(join(skill, 'SKILL.md'), source('resource-guide', 'Changed instructions'));
  await assert.rejects(catalog.read(request('references/notes.txt'), { signal: signal() }), /revision changed/);
  // The document remains an immutable turn snapshot.
  assert.equal(await catalog.read(request('SKILL.md'), { signal: signal() }), document.content);
});

test('resource symlinks, invalid UTF-8, root swaps and async document changes never expose text', async t => {
  const { base, directory, external, store } = await fixture(t);
  const skill = await put(directory, 'resource-guide');
  await writeFile(join(external, 'outside.txt'), 'outside data');
  await symlink(join(external, 'outside.txt'), join(skill, 'link.txt'));
  await writeFile(join(skill, 'invalid.txt'), Buffer.from([0xff]), { mode: 0o600 });
  await writeFile(join(skill, 'large.txt'), Buffer.alloc(SKILL_LIMITS.maximumResourceBytes + 1), { mode: 0o600 });
  let catalog = await store.snapshot();
  const request = path => ({ name: 'resource-guide', path, expectedRevision: catalog.document('resource-guide').revision });
  await assert.rejects(catalog.read(request('link.txt'), { signal: signal() }), /bounded regular/);
  await assert.rejects(catalog.read(request('invalid.txt'), { signal: signal() }), /UTF-8/);
  await assert.rejects(catalog.read(request('large.txt'), { signal: signal() }), /bounded regular/);
  await writeFile(join(skill, 'notes.txt'), 'must stay hidden', { mode: 0o600 });
  const originalOpen = fs.open;
  let changed = false;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path).endsWith('/notes.txt') && !changed) {
      changed = true;
      await writeFile(join(skill, 'SKILL.md'), source('resource-guide', 'Changed across an async boundary'));
    }
    return handle;
  });
  await assert.rejects(catalog.read(request('notes.txt'), { signal: signal() }), /revision changed/);
  catalog = await store.snapshot();
  await rename(directory, join(base, 'old-root'));
  await mkdir(directory, { mode: 0o700 });
  await put(directory, 'resource-guide', catalog.document('resource-guide').content);
  await assert.rejects(catalog.read(request('notes.txt'), { signal: signal() }), /root changed/);
});

test('resource allocation and reads remain bounded if a file grows across descriptor stat', async t => {
  const { directory, store } = await fixture(t);
  const skill = await put(directory, 'growing-guide');
  const target = join(skill, 'notes.txt');
  await writeFile(target, 'small', { mode: 0o600 });
  const catalog = await store.snapshot();
  const originalOpen = fs.open;
  let bytes = 0;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path).endsWith('/notes.txt')) {
      const originalStat = handle.stat.bind(handle);
      const originalRead = handle.read.bind(handle);
      let first = true;
      handle.stat = async () => {
        const info = await originalStat();
        if (first) { first = false; await writeFile(target, 'x'.repeat(SKILL_LIMITS.maximumResourceBytes + 100)); }
        return info;
      };
      handle.read = async (...values) => { const result = await originalRead(...values); bytes += result.bytesRead; return result; };
    }
    return handle;
  });
  await assert.rejects(catalog.read({ name: 'growing-guide', path: 'notes.txt', expectedRevision: catalog.document('growing-guide').revision }, { signal: signal() }), /byte limit/);
  assert.ok(bytes <= SKILL_LIMITS.maximumResourceBytes + 1);
});

test('hard-linked documents and resources cannot alias data beyond their approved directories', async t => {
  const { directory, external, store } = await fixture(t);
  const skill = await put(directory, 'hard-link-guide');
  const outside = join(external, 'outside.txt');
  await writeFile(outside, 'outside private data', { mode: 0o600 });
  await link(outside, join(skill, 'notes.txt'));
  const catalog = await store.snapshot();
  await assert.rejects(catalog.read({ name: 'hard-link-guide', path: 'notes.txt', expectedRevision: catalog.document('hard-link-guide').revision }, { signal: signal() }), /bounded regular/);
  const target = join(skill, 'SKILL.md');
  await link(target, join(external, 'document-alias'));
  assert.equal((await store.snapshot()).document('hard-link-guide'), undefined);
  await assert.rejects(store.prepare(proposal(source('hard-link-guide'))), /bounded regular/);
});

test('prepare and post-approval commit enforce fresh count, document and summary capacity', async t => {
  const { directory, store } = await fixture(t);
  const draft = proposal(source('new-guide'));
  const approved = await store.prepare(draft);
  for (let index = 0; index < 99; index++) await put(directory, `count-${index}`);
  await assert.rejects(store.prepare(draft), /capacity/);
  await assert.rejects(store.commit(approved.proposal), /capacity/);
  await assert.rejects(lstat(join(directory, 'new-guide')), { code: 'ENOENT' });
  const before = (await store.snapshot()).document('count-0');
  await save(store, source('count-0', 'Replacement occupies the existing slot'), before);
  for (const name of await readdir(directory)) await rm(join(directory, name), { recursive: true, force: true });
  for (let index = 0; index < 34; index++) await put(directory, `large-${index}`, source(`large-${index}`, 'x'.repeat(60_000)));
  await assert.rejects(store.prepare(proposal(source('large-proposal', 'x'.repeat(60_000)))), /capacity|bounded regular file/);
  for (const name of await readdir(directory)) await rm(join(directory, name), { recursive: true, force: true });
  for (let index = 0; index < 24; index++) {
    const name = `description-${index}`;
    await put(directory, name, source(name).replace('Summarize supplied text when requested.', 'd'.repeat(1_000)));
  }
  await assert.rejects(store.prepare(draft), /capacity/);
});

test('known credentials are excluded from source, parsed metadata, resources, diagnostics and late reads', async t => {
  const { directory, store } = await fixture(t, { secrets: ['known-secret'] });
  await put(directory, 'source-secret', source('source-secret', 'known-secret'));
  await put(directory, 'metadata-secret', source('metadata-secret', 'Text', 'metadata:\n  secret: "known\\u002dsecret"\n'));
  const safe = await put(directory, 'safe-guide');
  await writeFile(join(safe, 'notes.txt'), 'known-secret', { mode: 0o600 });
  const catalog = await store.snapshot();
  assert.equal(catalog.document('source-secret'), undefined);
  assert.equal(catalog.document('metadata-secret'), undefined);
  assert.ok(!JSON.stringify(store.diagnostics).includes('known-secret'));
  await assert.rejects(catalog.read({ name: 'safe-guide', path: 'notes.txt', expectedRevision: catalog.document('safe-guide').revision }, { signal: signal() }), /known credentials/);
  await assert.rejects(store.prepare(proposal(source('new-guide', 'known-secret'))), /known credentials/);
  store.addSecrets(['Summarize supplied text when requested.']);
  assert.throws(() => catalog.document('safe-guide'), /known credentials/);
  assert.throws(() => catalog.skills, /known credentials/);
});

test('diagnostics render malicious directory names as inert escaped text', async t => {
  if (process.platform === 'win32') { t.skip('Windows disallows control characters in filenames'); return; }
  const { directory, store } = await fixture(t);
  await mkdir(join(directory, 'invalid-\u001b[31m-name'), { mode: 0o700 });
  await store.snapshot();
  assert.ok(store.diagnostics.some(message => message.includes('\\u001b')));
  assert.ok(store.diagnostics.every(message => !/[\u0000-\u001f\u007f]/u.test(message)));
});

test('proposal getters, unsupported data, forged revisions and stale writes are rejected before persistence', async t => {
  const { directory, store } = await fixture(t);
  const raw = source('cas-guide');
  await save(store, raw);
  const before = (await store.snapshot()).document('cas-guide');
  const prepared = await store.prepare(proposal(source('cas-guide', 'approved change'), before));
  await writeFile(join(directory, 'cas-guide', 'SKILL.md'), source('cas-guide', 'another process change'));
  await assert.rejects(store.commit(prepared.proposal), /stale/);
  const create = proposal(source('new-guide'));
  let getterCalls = 0;
  const getter = { ...create };
  Object.defineProperty(getter, 'after', { enumerable: true, get() { getterCalls++; return create.after; } });
  await assert.rejects(store.commit(getter), /plain data/);
  assert.equal(getterCalls, 0);
  await assert.rejects(store.prepare({ ...create, extra: true }), /unsupported fields/);
  await assert.rejects(store.commit({ ...create, after: { ...create.after, revision: '0'.repeat(64) } }), /exact source/);
  await assert.rejects(store.commit({ ...create, name: '../escape' }), /Skill name/);
  assert.equal(await readFile(join(directory, 'cas-guide', 'SKILL.md'), 'utf8'), source('cas-guide', 'another process change'));
});

test('corrupt primary/backup and unexpected recovery evidence stay read-only and untouched', async t => {
  const { directory, store } = await fixture(t);
  const raw = source('corruption-guide');
  await save(store, raw);
  const before = (await store.snapshot()).document('corruption-guide');
  const target = join(directory, 'corruption-guide', 'SKILL.md');
  const backup = `${target}.bak`;
  await writeFile(backup, '{broken YAML', { mode: 0o600 });
  await assert.rejects(store.prepare(proposal(source('corruption-guide', 'change'), before)), /frontmatter/);
  assert.equal(await readFile(target, 'utf8'), raw);
  assert.equal(await readFile(backup, 'utf8'), '{broken YAML');
  await writeFile(backup, raw, { mode: 0o600 }); await unlink(target);
  await assert.rejects(store.commit(proposal(source('corruption-guide'))), /read-only.*recovery/);
  await writeFile(target, Buffer.from([0xff]), { mode: 0o600 });
  await assert.rejects(store.commit(proposal(source('corruption-guide'))), /read-only.*UTF-8/);
  assert.deepEqual(await readFile(target), Buffer.from([0xff]));
});

test('cancellation after primary rename retains the committed receipt', async t => {
  const { directory, store } = await fixture(t);
  const raw = source('cancel-guide');
  await save(store, raw);
  const before = (await store.snapshot()).document('cancel-guide');
  store.takeReceipts();
  const controller = new AbortController();
  const originalRename = fs.rename;
  mockFs(t, 'rename', async (from, to) => {
    await originalRename(from, to);
    if (String(to).endsWith('/SKILL.md')) controller.abort(new Error('Cancelled after commit'));
  });
  const revised = source('cancel-guide', 'Committed replacement');
  const result = await store.commit(proposal(revised, before), { signal: controller.signal });
  assert.equal(result.committed, true);
  assert.equal(await readFile(join(directory, 'cancel-guide', 'SKILL.md'), 'utf8'), revised);
  assert.equal(store.receipts.length, 1);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(store.commit(proposal(source('never-created')), { signal: aborted.signal }), { name: 'AbortError' });
  await assert.rejects(lstat(join(directory, 'never-created', 'SKILL.md')), { code: 'ENOENT' });
});

test('abort during backup rename prevents primary replacement and keeps the last valid backup', async t => {
  const { directory, store } = await fixture(t);
  const raw = source('abort-guide');
  await save(store, raw);
  const before = (await store.snapshot()).document('abort-guide');
  store.takeReceipts();
  const controller = new AbortController();
  const originalRename = fs.rename;
  mockFs(t, 'rename', async (from, to) => {
    await originalRename(from, to);
    if (String(to).endsWith('/SKILL.md.bak')) controller.abort(new Error('Cancelled before primary rename'));
  });
  await assert.rejects(store.commit(proposal(source('abort-guide', 'Never committed'), before), { signal: controller.signal }), /Cancelled before/);
  const target = join(directory, 'abort-guide', 'SKILL.md');
  assert.equal(await readFile(target, 'utf8'), raw);
  assert.equal(await readFile(`${target}.bak`, 'utf8'), raw);
  assert.equal(store.receipts.length, 0);
  assert.deepEqual((await readdir(join(directory, 'abort-guide'))).sort(), ['SKILL.md', 'SKILL.md.bak']);
});

test('secrets registered across cleanup withhold unsafe results but retain a safe committed receipt', async t => {
  const { directory, store } = await fixture(t);
  const originalUnlink = fs.unlink;
  let committed = false;
  const originalRename = fs.rename;
  mockFs(t, 'rename', async (from, to) => {
    await originalRename(from, to);
    if (String(to).endsWith('/SKILL.md')) { committed = true; store.addSecrets(['safe-guide']); }
  });
  mockFs(t, 'unlink', async path => {
    if (committed && String(path).endsWith('/.skills.lock')) store.addSecrets(['late-secret']);
    return originalUnlink(path);
  });
  const receipt = await store.commit(proposal(source('safe-guide', 'late-secret')));
  assert.deepEqual(receipt, { committed: true, futureTurn: true, contentWithheld: true });
  assert.deepEqual(store.receipts, [receipt]);
  assert.equal(await readFile(join(directory, 'safe-guide', 'SKILL.md'), 'utf8'), source('safe-guide', 'late-secret'));
  assert.deepEqual((await store.snapshot()).skills.map(item => item.name), ['skill-creator']);
});

test('cross-process compare-and-swap permits one creator and never steals stale leases', async t => {
  const { directory, store } = await fixture(t);
  const module = new URL('../dist/skills.js', import.meta.url).href;
  const code = `import { FileSkillStore } from ${JSON.stringify(module)};
import { parseSkillDocument } from '@ayayaq/vivi/extensions/skills';
const after = parseSkillDocument(process.argv[2]);
try { await new FileSkillStore(process.argv[1]).commit({name:after.metadata.name,expectedRevision:null,before:null,after}); console.log('saved'); }
catch(error) { console.log(error.message.includes('stale') ? 'stale' : error.message); }`;
  const results = await Promise.all([child(code, [directory, source('process-guide', 'writer one')]), child(code, [directory, source('process-guide', 'writer two')])]);
  assert.deepEqual(results.map(item => item.trim()).sort(), ['saved', 'stale']);
  await writeFile(join(directory, '.skills.lock'), 'old lease', { mode: 0o600 });
  await assert.rejects(store.snapshot(), /never stolen/);
  assert.equal(await readFile(join(directory, '.skills.lock'), 'utf8'), 'old lease');
});

test('drain waits for admitted commit and closes future admission', async t => {
  const notices = [];
  const { directory, store } = await fixture(t, { notice: message => notices.push(message) });
  const ready = deferred(); const proceed = deferred();
  const originalRename = fs.rename;
  mockFs(t, 'rename', async (from, to) => {
    if (String(to).endsWith('/SKILL.md')) { ready.resolve(); await proceed.promise; }
    return originalRename(from, to);
  });
  const commit = store.commit(proposal(source('drain-guide')));
  await ready.promise;
  let drained = false;
  const drain = store.drain({ close: true }).then(() => { drained = true; });
  await assert.rejects(store.snapshot(), /closing/);
  await new Promise(done => setTimeout(done, 20)); assert.equal(drained, false);
  proceed.resolve();
  assert.equal((await commit).committed, true);
  await drain;
  assert.equal(await readFile(join(directory, 'drain-guide', 'SKILL.md'), 'utf8'), source('drain-guide'));
  assert.equal(store.receipts.length, 1);
  assert.deepEqual(notices, []);
});

test('post-commit directory durability failure becomes a safe notice and drain retries it', async t => {
  const notices = [];
  const { store } = await fixture(t, { notice: message => notices.push(message) });
  const originalOpen = fs.open;
  let failed = false;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    const info = await handle.stat();
    if (info.isDirectory() && String(path).endsWith('/durability-guide')) {
      const originalSync = handle.sync.bind(handle);
      handle.sync = async () => { if (!failed) { failed = true; throw new Error('secret-looking untrusted OS error'); } return originalSync(); };
    }
    return handle;
  });
  const receipt = await store.commit(proposal(source('durability-guide')));
  assert.equal(receipt.committed, true);
  assert.ok(notices.some(message => /durability could not be confirmed/.test(message)));
  assert.ok(!JSON.stringify(notices).includes('secret-looking'));
  await store.drain();
  assert.equal(store.receipts.length, 1);
});

test('NFKC-equivalent physical directories stay unchanged, read-only and revision-bound', async t => {
  const { directory, external } = await fixture(t);
  const name = 'ｓｕｍｍａｒｙ';
  const content = source(name);
  const physical = await put(directory, name, content);
  await mkdir(join(physical, 'references'), { mode: 0o700 });
  await writeFile(join(physical, 'references', 'guide.md'), 'Read the original resource inertly.', { mode: 0o600 });
  const store = new FileSkillStore(directory);
  const catalog = await store.snapshot();
  assert.equal(catalog.skills.find(item => item.name === 'summary').readOnly, true);
  assert.equal(catalog.document('summary').content, content);
  assert.equal(await catalog.read({ name: 'summary', path: 'references/guide.md', expectedRevision: catalog.document('summary').revision }, { signal: signal() }), 'Read the original resource inertly.');
  await assert.rejects(store.prepare(proposal(source('summary'))), /normalized-alias.*read-only/);
  assert.equal(await readFile(join(physical, 'SKILL.md'), 'utf8'), content);
  const externalPhysical = await put(external, 'ｅｘｔｅｒｎａｌ', source('ｅｘｔｅｒｎａｌ'));
  const imported = new FileSkillStore(directory, { readOnlyRoots: [external] });
  assert.equal((await imported.snapshot()).document('external').metadata.name, 'external');
  await assert.rejects(imported.prepare(proposal(source('external'))), /read-only.*shadowed/);
  assert.equal(await readFile(join(externalPhysical, 'SKILL.md'), 'utf8'), source('ｅｘｔｅｒｎａｌ'));
});

test('duplicate canonical Unicode aliases are excluded rather than shadowed', async t => {
  const { directory, external } = await fixture(t);
  await put(directory, 'summary');
  await put(external, 'ｓｕｍｍａｒｙ', source('ｓｕｍｍａｒｙ'));
  const store = new FileSkillStore(directory, { readOnlyRoots: [external] });
  assert.equal((await store.snapshot()).document('summary'), undefined);
  assert(store.diagnostics.some(message => message.includes('Duplicate skill name')));
});

nodeTest('read-only capability lists/reads without creating state and refuses every save', async t => {
  const { base, external } = await fixture(t);
  const root = join(base, 'absent-profile', 'agent-skills');
  const physical = await put(external, 'external-summary');
  await mkdir(join(physical, 'references'), { mode: 0o700 });
  await writeFile(join(physical, 'references', 'guide.md'), 'Imported inert text', { mode: 0o600 });
  class ReadOnlySkillStore extends FileSkillStore { get writable() { return false; } }
  const store = new ReadOnlySkillStore(root, { readOnlyRoots: [external] });
  assert.equal(store.writable, false);
  const catalog = await store.snapshot();
  assert(catalog.document('skill-creator'));
  const document = catalog.document('external-summary');
  assert(document); assert.equal(catalog.skills.find(item => item.name === 'external-summary').readOnly, true);
  assert.equal(await catalog.read({ name: 'external-summary', path: 'references/guide.md', expectedRevision: document.revision }, { signal: signal() }), 'Imported inert text');
  await assert.rejects(store.prepare(proposal(source('new-summary'))), /handle-relative/);
  await assert.rejects(store.commit(proposal(source('new-summary'))), /handle-relative/);
  await assert.rejects(lstat(root), { code: 'ENOENT' });
  assert.equal(await readFile(join(physical, 'SKILL.md'), 'utf8'), source('external-summary'));
  await store.drain({ close: true });
});
