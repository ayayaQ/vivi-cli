// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { decodeMemories, memoryRevision } from '@ayayaq/vivi/extensions/memory';
import { FileMemoryStore, MAX_MEMORY_STORE_BYTES } from '../dist/memory.js';

const test = (name, fn) => nodeTest(name, { timeout: 15_000 }, fn);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const record = (content = 'Prefer concise answers', extras = {}) => ({
  id: 'legacy-id', content, createdAt: 'old timestamp', updatedAt: 'arbitrary string',
  createdBy: 'user', updatedBy: 'agent', ...extras
});
const encoded = memories => `${JSON.stringify({ version: 1, memories })}\n`;
async function fixture(t, secrets = [], notice) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-memory-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, primary: join(directory, 'memories.json'), backup: join(directory, 'memories.json.bak'),
    store: new FileMemoryStore(directory, secrets, notice) };
}
async function create(store, content, signal) {
  return store.commit(await store.prepareCreate(content, 'user', signal), signal ? { signal } : {});
}
function mockFs(t, name, replacement) {
  t.mock.method(fs, name, replacement);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
async function child(code, args = []) {
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

test('construction is lazy; an empty opted-in read creates no memory data or backup', async t => {
  const { directory } = await fixture(t);
  const isolated = join(directory, 'isolated');
  const store = new FileMemoryStore(isolated);
  assert.deepEqual(await readdir(directory), []);
  assert.deepEqual((await store.list()).memories, []);
  assert.deepEqual(await readdir(isolated), []);
  if (process.platform !== 'win32') assert.equal((await lstat(isolated)).mode & 0o777, 0o700);
});

test('fresh operations share app-wide records and keep custom directories isolated', async t => {
  const { directory, store, primary, backup } = await fixture(t);
  const other = new FileMemoryStore(directory);
  const first = (await create(store, '  Prefer concise answers  ')).memories[0];
  assert.equal(first.content, 'Prefer concise answers');
  assert.equal(first.revision.length, 16);
  assert.deepEqual(await other.list(), await store.list());
  const edited = (await other.commit(await other.prepareUpdate(first.id, first.revision, 'Prefer detailed answers', 'agent'))).memories[0];
  assert.equal((await store.list()).memories[0].content, edited.content);
  assert.equal(decodeMemories(await readFile(backup, 'utf8')).memories[0].content, first.content);
  await store.commit(await store.prepareDelete(edited.id, edited.revision));
  assert.deepEqual((await other.list()).memories, []);
  const isolated = new FileMemoryStore(join(directory, 'profile'));
  assert.deepEqual((await isolated.list()).memories, []);
  assert.ok(Buffer.byteLength(await readFile(primary)) <= MAX_MEMORY_STORE_BYTES);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(primary)).mode & 0o777, 0o600);
    assert.equal((await lstat(backup)).mode & 0o777, 0o600);
  }
});

test('legacy v1 decoding preserves arbitrary timestamps, extras, property order and untrimmed content', async t => {
  const { store, primary } = await fixture(t);
  const legacy = { content: '  Still valid  ', custom: { retained: true }, id: 'old-id',
    updatedAt: 'not a date', createdBy: 'user', createdAt: '', updatedBy: 'agent' };
  const raw = JSON.stringify({ memories: [legacy], rootExtra: 'retained during reads' });
  await writeFile(primary, raw, { mode: 0o600 });
  const listed = (await store.list()).memories[0];
  assert.deepEqual(listed, { ...legacy, revision: memoryRevision(legacy) });
  assert.equal(await readFile(primary, 'utf8'), raw);
});

test('compatible legacy extras are not rejected by a stricter host depth or node-count decoder', async t => {
  const { store, primary } = await fixture(t);
  let nested = 'retained'; for (let index = 0; index < 60; index++) nested = { child: nested };
  const legacy = record('Keep compatible extras', { nested, many: Array(105_000).fill(0) });
  const raw = encoded([legacy]); assert.ok(Buffer.byteLength(raw) < MAX_MEMORY_STORE_BYTES);
  await writeFile(primary, raw, { mode: 0o600 });
  const existing = (await store.list()).memories[0];
  const updated = await store.commit(await store.prepareUpdate(existing.id, existing.revision, 'Updated compatible extras', 'user'));
  assert.deepEqual(updated.memories[0].nested, nested);
  assert.equal(updated.memories[0].many.length, 105_000);
});

test('unrecoverable corruption stays read-only and is never replaced by an empty store', async t => {
  const { store, directory, primary } = await fixture(t);
  const raw = '{broken\u0000 original evidence';
  await writeFile(primary, raw, { mode: 0o600 });
  await assert.rejects(store.list(), /read-only/);
  await assert.rejects(store.prepareCreate('A new preference', 'user'), /read-only/);
  assert.equal(await readFile(primary, 'utf8'), raw);
  assert.deepEqual(await readdir(directory), ['memories.json']);
});

test('corrupt primary recovery preserves exact private evidence before checkpointing a validated backup', async t => {
  const notices = [];
  const { store, directory, primary, backup } = await fixture(t, [], message => notices.push(message));
  const raw = Buffer.from([0xff, 0x7b, 0x00, 0x61]);
  await writeFile(primary, raw, { mode: 0o600 });
  await writeFile(backup, encoded([record()]), { mode: 0o600 });
  assert.equal((await store.list()).memories[0].content, record().content);
  const evidence = (await readdir(directory)).find(name => name.startsWith('memories.primary.corrupt.'));
  assert.ok(evidence);
  assert.deepEqual(await readFile(join(directory, evidence)), raw);
  assert.deepEqual(decodeMemories(await readFile(primary, 'utf8')).memories, [record()]);
  if (process.platform !== 'win32') assert.equal((await lstat(join(directory, evidence))).mode & 0o777, 0o600);
  assert.ok(notices.some(message => /preserved/.test(message)));
  assert.ok(notices.some(message => /recovered/.test(message)));
});

test('missing primary recovers from backup and can commit in the same fresh transaction', async t => {
  const { store, primary, backup } = await fixture(t);
  await writeFile(backup, encoded([record()]), { mode: 0o600 });
  const mutation = { kind: 'create', before: null, after: record('A second preference', { id: 'new-id' }) };
  const result = await store.commit(mutation);
  assert.equal(result.memories.length, 2);
  assert.equal(decodeMemories(await readFile(primary, 'utf8')).memories.length, 2);
});

test('invalid primary and backup both remain intact and read-only', async t => {
  const { store, primary, backup } = await fixture(t);
  await writeFile(primary, '{one', { mode: 0o600 });
  await writeFile(backup, '{two', { mode: 0o600 });
  await assert.rejects(store.list(), /read-only/);
  assert.equal(await readFile(primary, 'utf8'), '{one');
  assert.equal(await readFile(backup, 'utf8'), '{two');
});

test('damaged backup is preserved before the next save replaces it with a validated primary', async t => {
  const { store, directory, primary, backup } = await fixture(t);
  await writeFile(primary, encoded([record()]), { mode: 0o600 });
  await writeFile(backup, '{bad backup', { mode: 0o600 });
  assert.equal((await store.list()).memories.length, 1);
  await create(store, 'Prefer metric units');
  const evidence = (await readdir(directory)).find(name => name.startsWith('memories.backup.corrupt.'));
  assert.equal(await readFile(join(directory, evidence), 'utf8'), '{bad backup');
  assert.deepEqual(decodeMemories(await readFile(backup, 'utf8')).memories, [record()]);
});

test('malformed, duplicate and over-limit records are preserved without semantic repair', async t => {
  const { store, primary } = await fixture(t);
  for (const memories of [[record('', {})], [record(), record('Different', {})],
    [record(), record(' prefer concise answers ', { id: 'other' })],
    [record('x'.repeat(1001))], Array.from({ length: 101 }, (_, i) => record(`item ${i}`, { id: String(i) }))]) {
    const raw = encoded(memories);
    await writeFile(primary, raw, { mode: 0o600 });
    await assert.rejects(store.list(), /read-only/);
    assert.equal(await readFile(primary, 'utf8'), raw);
  }
});

test('primary symlinks, directories, public files and oversized files are refused without replacement', async t => {
  const { store, directory, primary } = await fixture(t);
  const outside = join(directory, 'outside');
  await writeFile(outside, encoded([record()]), { mode: 0o600 });
  await symlink(outside, primary);
  await assert.rejects(store.list(), /private regular/);
  assert.ok((await lstat(primary)).isSymbolicLink());
  await unlink(primary);
  await mkdir(primary, { mode: 0o700 });
  await assert.rejects(store.list(), /private regular/);
  await rm(primary, { recursive: true });
  await writeFile(primary, ' '.repeat(MAX_MEMORY_STORE_BYTES + 1), { mode: 0o600 });
  await assert.rejects(store.list(), /size limit/);
  assert.equal((await lstat(primary)).size, MAX_MEMORY_STORE_BYTES + 1);
  if (process.platform !== 'win32') {
    await writeFile(primary, encoded([record()])); await chmod(primary, 0o644);
    await assert.rejects(store.list(), /private regular/);
  }
});

test('unsafe backup refuses a save while a valid primary remains unchanged', async t => {
  const { store, directory, primary, backup } = await fixture(t);
  await writeFile(primary, encoded([record()]), { mode: 0o600 });
  await symlink(primary, backup);
  const proposed = await store.prepareCreate('Use metric units', 'user');
  await assert.rejects(store.commit(proposed), /private regular/);
  assert.equal(await readFile(primary, 'utf8'), encoded([record()]));
  assert.ok((await lstat(backup)).isSymbolicLink());
  assert.deepEqual((await readdir(directory)).sort(), ['memories.json', 'memories.json.bak']);
});

test('unreadable primary cannot silently recover or erase its evidence', async t => {
  const { store, primary, backup } = await fixture(t);
  await writeFile(primary, encoded([record()]), { mode: 0o600 });
  await writeFile(backup, encoded([]), { mode: 0o600 });
  const originalOpen = fs.open;
  mockFs(t, 'open', async (path, ...args) => {
    if (path === primary) throw Object.assign(new Error('read denied'), { code: 'EACCES' });
    return originalOpen(path, ...args);
  });
  await assert.rejects(store.list(), /read denied/);
  assert.equal(await readFile(primary, 'utf8'), encoded([record()]));
});

test('reads reject file identity swaps before exposing data', async t => {
  const { store, primary, directory } = await fixture(t);
  await writeFile(primary, encoded([record()]), { mode: 0o600 });
  const originalOpen = fs.open;
  let reads = 0;
  mockFs(t, 'open', async (path, ...args) => {
    if (path === primary) {
      await rename(primary, join(directory, 'old-primary'));
      await writeFile(primary, encoded([record('replacement')]), { mode: 0o600 });
    }
    const handle = await originalOpen(path, ...args);
    if (path === primary) { const originalRead = handle.read.bind(handle); handle.read = (...values) => { reads++; return originalRead(...values); }; }
    return handle;
  });
  await assert.rejects(store.list(), /changed while opening/);
  assert.equal(reads, 0);
});

test('reads remain bounded if a file grows after its descriptor stat', async t => {
  const { store, primary } = await fixture(t);
  await writeFile(primary, encoded([record()]), { mode: 0o600 });
  const originalOpen = fs.open;
  let bytes = 0;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (path === primary) {
      const originalStat = handle.stat.bind(handle); const originalRead = handle.read.bind(handle); let first = true;
      handle.stat = async () => {
        const info = await originalStat();
        if (first) { first = false; await writeFile(primary, ' '.repeat(MAX_MEMORY_STORE_BYTES + 100)); }
        return info;
      };
      handle.read = async (...values) => { const result = await originalRead(...values); bytes += result.bytesRead; return result; };
    }
    return handle;
  });
  await assert.rejects(store.list(), /size limit/);
  assert.equal(bytes, MAX_MEMORY_STORE_BYTES + 1);
});

test('a directory swap during read is detected and replacement-directory files stay untouched', async t => {
  const { store, primary, directory } = await fixture(t);
  await writeFile(primary, encoded([record()]), { mode: 0o600 });
  const moved = `${directory}-moved`; t.after(() => rm(moved, { recursive: true, force: true }));
  const originalOpen = fs.open;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (path === primary) {
      await rename(directory, moved); await mkdir(directory, { mode: 0o700 });
      await writeFile(primary, 'replacement evidence', { mode: 0o600 });
      await writeFile(join(directory, 'memories.json.lock'), 'replacement lock', { mode: 0o600 });
    }
    return handle;
  });
  await assert.rejects(store.list(), /directory changed/);
  assert.equal(await readFile(primary, 'utf8'), 'replacement evidence');
  assert.equal(await readFile(join(directory, 'memories.json.lock'), 'utf8'), 'replacement lock');
});

test('saves sync each exclusive temporary file before rename and the directory afterwards', async t => {
  if (process.platform === 'win32') return;
  const { store, directory, primary, backup } = await fixture(t);
  const originalOpen = fs.open; const originalRename = fs.rename; const events = [];
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args); const originalSync = handle.sync.bind(handle);
    handle.sync = async () => { events.push(path === directory ? 'directory-sync' : String(path).endsWith('.tmp') ? 'temporary-sync' : 'lock-sync'); return originalSync(); };
    return handle;
  });
  mockFs(t, 'rename', async (from, to) => { events.push(to === primary ? 'primary-rename' : to === backup ? 'backup-rename' : 'evidence-rename'); return originalRename(from, to); });
  await create(store, 'Use Celsius');
  assert.deepEqual(events, ['lock-sync', 'lock-sync', 'temporary-sync', 'backup-rename', 'directory-sync', 'temporary-sync', 'primary-rename', 'directory-sync']);
  assert.deepEqual((await readdir(directory)).sort(), ['memories.json', 'memories.json.bak']);
});

test('primary rename failure is precommit and preserves the previous validated primary', async t => {
  const { store, primary } = await fixture(t);
  await create(store, 'Use Celsius'); const before = await readFile(primary, 'utf8');
  const proposal = await store.prepareCreate('Use kilometers', 'user');
  const originalRename = fs.rename;
  mockFs(t, 'rename', async (from, to) => { if (to === primary) throw new Error('simulated rename failure'); return originalRename(from, to); });
  await assert.rejects(store.commit(proposal), /simulated rename failure/);
  assert.equal(await readFile(primary, 'utf8'), before);
});

test('temporary file sync failure cannot commit or replace the primary', async t => {
  const { store, primary } = await fixture(t);
  await create(store, 'Use Celsius'); const before = await readFile(primary, 'utf8');
  const proposal = await store.prepareCreate('Use kilometers', 'user'); const originalOpen = fs.open;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path).endsWith('.tmp')) handle.sync = async () => { throw new Error('simulated file sync failure'); };
    return handle;
  });
  await assert.rejects(store.commit(proposal), /simulated file sync failure/);
  assert.equal(await readFile(primary, 'utf8'), before);
});

test('postrename directory fsync failure resolves committed and drain retries durability', async t => {
  if (process.platform === 'win32') return;
  const notices = []; const { store, directory, primary } = await fixture(t, [], value => notices.push(value));
  const originalOpen = fs.open; const originalRename = fs.rename; let committed = false; let failures = 1; let retries = 0;
  mockFs(t, 'rename', async (from, to) => { await originalRename(from, to); if (to === primary) committed = true; });
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args); const originalSync = handle.sync.bind(handle);
    if (path === directory) handle.sync = async () => {
      if (committed) { retries++; if (failures-- > 0) throw new Error('simulated directory sync failure'); }
      return originalSync();
    };
    return handle;
  });
  assert.equal((await create(store, 'Use Celsius')).memories[0].content, 'Use Celsius');
  assert.equal(decodeMemories(await readFile(primary, 'utf8')).memories[0].content, 'Use Celsius');
  assert.ok(notices.some(message => /committed.*durability/.test(message)));
  await store.drain();
  assert.equal(retries, 2);
});

test('throwing recovery/durability notice listeners cannot change committed outcomes', async t => {
  const { store, primary, backup } = await fixture(t, [], () => { throw new Error('listener failed'); });
  await writeFile(primary, '{bad', { mode: 0o600 }); await writeFile(backup, encoded([record()]), { mode: 0o600 });
  assert.equal((await store.list()).memories.length, 1);
  assert.equal((await create(store, 'Use kilometers')).memories.length, 2);
});

test('approved stale updates and deletes conflict against fresh disk state', async t => {
  const { store, directory } = await fixture(t); const other = new FileMemoryStore(directory);
  const first = (await create(store, 'Use Celsius')).memories[0];
  const update = await store.prepareUpdate(first.id, first.revision, 'Use Fahrenheit', 'user');
  const deletion = await store.prepareDelete(first.id, first.revision);
  await other.commit(await other.prepareUpdate(first.id, first.revision, 'Use kelvin', 'agent'));
  await assert.rejects(store.commit(update), /Stale memory revision/);
  await assert.rejects(store.commit(deletion), /Stale memory revision/);
  assert.equal((await store.list()).memories[0].content, 'Use kelvin');
});

test('concurrent prepared creates recheck duplicates and collection limits at commit', async t => {
  const { store, directory, primary } = await fixture(t); const other = new FileMemoryStore(directory);
  const first = await store.prepareCreate('Use Celsius', 'user'); const duplicate = await other.prepareCreate('use celsius', 'agent');
  await store.commit(first); await assert.rejects(other.commit(duplicate), /identical memory/);
  await writeFile(primary, encoded(Array.from({ length: 99 }, (_, i) => record(`preference ${i}`, { id: `id-${i}` }))));
  const last = await store.prepareCreate('The hundredth item', 'user'); const overflow = await other.prepareCreate('One item too many', 'user');
  await store.commit(last); await assert.rejects(other.commit(overflow), /maximum of 100/);
  assert.equal((await store.list()).memories.length, 100);
});

test('two processes with different session identities cannot lose app-wide creates', async t => {
  const { store, directory } = await fixture(t);
  const module = fileURLToPath(new URL('../dist/memory.js', import.meta.url));
  const code = `import { FileMemoryStore } from ${JSON.stringify(module)};
    const store = new FileMemoryStore(process.argv[1]);
    const proposal = await store.prepareCreate('Preference from session ' + process.argv[2], 'user');
    await new Promise(resolve => setTimeout(resolve, 40));
    await store.commit(proposal); await store.drain();`;
  await Promise.all([child(code, [directory, '11111111-1111-4111-8111-111111111111']),
    child(code, [directory, '22222222-2222-4222-8222-222222222222'])]);
  assert.equal((await store.list()).memories.length, 2);
});

test('contention retries a live short lease but never steals a stale lease', async t => {
  const { store, directory } = await fixture(t); const lock = join(directory, 'memories.json.lock');
  await writeFile(lock, '{"pid":99999999}', { mode: 0o600 });
  const promise = store.list(); setTimeout(() => { void unlink(lock); }, 70);
  assert.deepEqual((await promise).memories, []);
  const bytes = '{"pid":99999999,"stale":true}'; await writeFile(lock, bytes, { mode: 0o600 });
  await assert.rejects(store.list(), /never stolen automatically/);
  assert.equal(await readFile(lock, 'utf8'), bytes);
});

test('aborting a lease wait preserves its existing owner and drains quickly', async t => {
  const { store, directory } = await fixture(t); const lock = join(directory, 'memories.json.lock');
  await writeFile(lock, 'existing owner', { mode: 0o600 });
  const controller = new AbortController(); const promise = store.list(controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(promise, { name: 'AbortError' }); await store.drain();
  assert.equal(await readFile(lock, 'utf8'), 'existing owner');
});

test('queued cancellation cannot start a write; drain includes queued admitted operations', async t => {
  const { store, directory, primary } = await fixture(t);
  const first = await store.prepareCreate('Use Celsius', 'user'); const second = await store.prepareCreate('Use kilometers', 'user');
  const entered = deferred(); const release = deferred(); const originalRename = fs.rename;
  mockFs(t, 'rename', async (from, to) => { if (to === primary) { entered.resolve(); await release.promise; } return originalRename(from, to); });
  const saving = store.commit(first); await entered.promise;
  const controller = new AbortController(); const queued = store.commit(second, { signal: controller.signal });
  const rejected = assert.rejects(queued, { name: 'AbortError' }); controller.abort();
  let drained = false; const draining = store.drain().then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(drained, false);
  release.resolve(); await saving; await rejected; await draining;
  assert.equal(decodeMemories(await readFile(primary, 'utf8')).memories.length, 1);
  assert.deepEqual((await readdir(directory)).sort(), ['memories.json', 'memories.json.bak']);
});

test('abort after primary rename has started cannot report rollback; drain waits for save settlement', async t => {
  const { store, primary } = await fixture(t); const proposal = await store.prepareCreate('Use Celsius', 'user');
  const entered = deferred(); const release = deferred(); const originalRename = fs.rename;
  mockFs(t, 'rename', async (from, to) => { if (to === primary) { entered.resolve(); await release.promise; } return originalRename(from, to); });
  const controller = new AbortController(); const saving = store.commit(proposal, { signal: controller.signal });
  await entered.promise; controller.abort();
  let drained = false; const draining = store.drain().then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(drained, false);
  release.resolve(); assert.equal((await saving).memories[0].content, 'Use Celsius'); await draining;
});

test('commit snapshots admitted proposals and rejects hooks without invoking them', async t => {
  const { store } = await fixture(t); const proposal = await store.prepareCreate('Use Celsius', 'user');
  const saving = store.commit(proposal); proposal.after.content = 'Unapproved replacement';
  assert.equal((await saving).memories[0].content, 'Use Celsius');
  let reads = 0; const malicious = Object.defineProperty({}, 'kind', { enumerable: true, get() { reads++; return 'delete'; } });
  await assert.rejects(store.commit(malicious), /plain JSON/); assert.equal(reads, 0);
});

test('known credentials are rejected before proposal, commit and subsequent context reads', async t => {
  const secret = 'secret-value-with-"quotes\\slash'; const { store, primary } = await fixture(t, [secret]);
  await assert.rejects(store.prepareCreate(`Remember ${secret}`, 'user'), /known credentials/);
  await assert.rejects(store.prepareUpdate('missing', 'revision', secret, 'user'), /known credentials/);
  assert.deepEqual((await store.list()).memories, []);
  const proposed = await store.prepareCreate('later-vault-key', 'user'); store.addSecrets(['later-vault-key']);
  await assert.rejects(store.commit(proposed), /known credentials/);
  await writeFile(primary, encoded([record(secret)]), { mode: 0o600 });
  await assert.rejects(store.list(), error => /known credentials/.test(error.message) && !error.message.includes(secret));
  const encodedSecret = [...'later-vault-key'].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  await writeFile(primary, encoded([record('later-vault-key')]).replaceAll('later-vault-key', encodedSecret));
  await assert.rejects(store.list(), /known credentials/);
  await writeFile(primary, encoded([record('safe content', { legacyExtra: secret })]));
  await assert.rejects(store.list(), /known credentials/);
});

test('newly registered credentials already on disk are blocked on the very next read', async t => {
  const { store, primary } = await fixture(t);
  await create(store, 'A future-known-credential'); const raw = await readFile(primary, 'utf8');
  store.addSecrets(['future-known-credential']);
  await assert.rejects(store.list(), /known credentials/);
  assert.equal(await readFile(primary, 'utf8'), raw);
});

test('credentials registered during temporary-file sync prevent the primary rename', async t => {
  const { store, primary } = await fixture(t); const proposal = await store.prepareCreate('late-register-key', 'user');
  const originalOpen = fs.open;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args); const originalSync = handle.sync.bind(handle);
    if (String(path).endsWith('.tmp')) handle.sync = async () => { await originalSync(); store.addSecrets(['late-register-key']); };
    return handle;
  });
  await assert.rejects(store.commit(proposal), /known credentials/);
  await assert.rejects(lstat(primary), { code: 'ENOENT' });
});

test('closing drain rejects new admission and ordinary drain remains reusable', async t => {
  const { store } = await fixture(t);
  await create(store, 'Use Celsius'); await store.drain();
  assert.equal((await store.list()).memories.length, 1);
  await store.drain({ close: true });
  await assert.rejects(store.list(), /closing/);
  await assert.rejects(store.prepareCreate('Use kilometers', 'user'), /closing/);
});

test('credential registration after primary rename preserves success while withholding secret results', async t => {
  const notices = []; const { store, primary } = await fixture(t, [], message => notices.push(message));
  const proposal = await store.prepareCreate('newly-known-after-commit', 'user'); const originalRename = fs.rename;
  mockFs(t, 'rename', async (from, to) => {
    await originalRename(from, to);
    if (to === primary) store.addSecrets(['newly-known-after-commit']);
  });
  const result = await store.commit(proposal);
  assert.equal(result.contentWithheld, true);
  assert.deepEqual(result.memories, []);
  assert.equal(decodeMemories(await readFile(primary, 'utf8')).memories.length, 1);
  assert.ok(notices.some(message => /committed.*withheld/.test(message)));
  assert.ok(notices.every(message => !message.includes('newly-known-after-commit')));
  await assert.rejects(store.list(), /known credentials/);
});

test('Windows route does not try to open a directory as a regular Node file handle', async t => {
  const { store, directory } = await fixture(t); const originalOpen = fs.open;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  mockFs(t, 'open', async (path, ...args) => {
    assert.notEqual(path, directory, 'Windows must not open directories with fs.open');
    return originalOpen(path, ...args);
  });
  assert.equal((await create(store, 'Use Celsius')).memories.length, 1);
  assert.equal((await store.list()).memories.length, 1);
  await store.drain();
});

test('FIFO memory entries and regular-file-to-FIFO swaps never block a read', async t => {
  if (process.platform === 'win32') return;
  const { store, directory, primary } = await fixture(t);
  const fifo = join(directory, 'fifo');
  await child(`import { spawnSync } from 'node:child_process';
    const result = spawnSync('mkfifo', [process.argv[1]]); if(result.status) process.exit(result.status);`, [fifo]);
  await rename(fifo, primary); await assert.rejects(store.list(), /private regular/); await unlink(primary);
  await writeFile(primary, encoded([record()]), { mode: 0o600 });
  await child(`import { spawnSync } from 'node:child_process';
    const result = spawnSync('mkfifo', [process.argv[1]]); if(result.status) process.exit(result.status);`, [fifo]);
  const originalOpen = fs.open;
  mockFs(t, 'open', async (path, ...args) => {
    if (path === primary) { await unlink(primary); await rename(fifo, primary); }
    return originalOpen(path, ...args);
  });
  await assert.rejects(store.list(), /changed while opening/);
});

test('a primary replaced during temporary sync is never overwritten', async t => {
  const { store, primary } = await fixture(t); await create(store, 'Use Celsius');
  const proposal = await store.prepareCreate('Use kilometers', 'user'); const originalOpen = fs.open; let syncs = 0;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args); const originalSync = handle.sync.bind(handle);
    if (String(path).endsWith('.tmp')) handle.sync = async () => {
      await originalSync();
      if (++syncs === 2) await writeFile(primary, encoded([record('external replacement')]));
    };
    return handle;
  });
  await assert.rejects(store.commit(proposal), /target changed/);
  assert.equal(decodeMemories(await readFile(primary, 'utf8')).memories[0].content, 'external replacement');
});

test('a substituted temporary file is preserved and cannot be committed', async t => {
  const { store, primary } = await fixture(t); const proposal = await store.prepareCreate('Use Celsius', 'user');
  const originalOpen = fs.open;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args); const originalSync = handle.sync.bind(handle);
    if (String(path).endsWith('.tmp')) handle.sync = async () => {
      await originalSync(); await unlink(path); await writeFile(path, 'substituted evidence', { mode: 0o600 });
    };
    return handle;
  });
  await assert.rejects(store.commit(proposal), /temporary file changed/);
  await assert.rejects(lstat(primary), { code: 'ENOENT' });
});

test('a symlinked or public memory directory is rejected before acquiring a lease', async t => {
  const { directory } = await fixture(t); const link = `${directory}-link`;
  t.after(() => rm(link, { force: true })); await symlink(directory, link);
  await assert.rejects(new FileMemoryStore(link).list(), /real, owned private directory/);
  assert.deepEqual(await readdir(directory), []);
  if (process.platform !== 'win32') {
    await chmod(directory, 0o755);
    await assert.rejects(new FileMemoryStore(directory).list(), /permissions 0700/);
    assert.deepEqual(await readdir(directory), []);
  }
});

test('concurrent approved creates recheck the total character budget', async t => {
  const { store, directory, primary } = await fixture(t); const other = new FileMemoryStore(directory);
  await writeFile(primary, encoded(Array.from({ length: 19 }, (_, i) => record(`${i}`.padEnd(1000, 'a'), { id: String(i) }))), { mode: 0o600 });
  const first = await store.prepareCreate('b'.repeat(1000), 'user'); const second = await other.prepareCreate('c'.repeat(1000), 'user');
  await store.commit(first); await assert.rejects(other.commit(second), /20000 total characters/);
  assert.equal((await store.list()).memories.length, 20);
});

test('failed recovery evidence sync leaves both original corruption and backup intact', async t => {
  const { store, primary, backup } = await fixture(t);
  await writeFile(primary, '{corrupt', { mode: 0o600 }); await writeFile(backup, encoded([record()]), { mode: 0o600 });
  const originalOpen = fs.open;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path).endsWith('.tmp')) handle.sync = async () => { throw new Error('evidence sync failed'); };
    return handle;
  });
  await assert.rejects(store.list(), /evidence sync failed/);
  assert.equal(await readFile(primary, 'utf8'), '{corrupt');
  assert.equal(await readFile(backup, 'utf8'), encoded([record()]));
});

test('known credentials in malformed escaped evidence are never copied during recovery', async t => {
  const key = 'key-with-"quote'; const { store, primary, backup, directory } = await fixture(t, [key]);
  const raw = `{broken ${JSON.stringify(key)}`;
  await writeFile(primary, raw, { mode: 0o600 }); await writeFile(backup, encoded([record()]), { mode: 0o600 });
  await assert.rejects(store.list(), /known credentials/);
  assert.equal(await readFile(primary, 'utf8'), raw);
  assert.deepEqual((await readdir(directory)).sort(), ['memories.json', 'memories.json.bak']);
});

test('abort errors preserve their classification without leaking registered credentials', async t => {
  const { store } = await fixture(t, ['private-abort-key']); const controller = new AbortController();
  controller.abort(new DOMException('private-abort-key', 'AbortError'));
  await assert.rejects(store.list(controller.signal), error => error.name === 'AbortError' && !error.message.includes('private-abort-key'));
});

for (const recovery of [false, true]) {
  test(`${recovery ? 'evidence' : 'backup'} durability notices cannot falsely report an uncommitted primary change`, async t => {
    if (process.platform === 'win32') return;
    const notices = []; const { store, directory, primary, backup } = await fixture(t, [], value => notices.push(value));
    let proposal;
    if (recovery) {
      await writeFile(primary, '{corrupt', { mode: 0o600 });
      await writeFile(backup, encoded([record()]), { mode: 0o600 });
    } else proposal = await store.prepareCreate('Uncommitted preference', 'user');
    const originalOpen = fs.open; const originalRename = fs.rename;
    mockFs(t, 'open', async (path, ...args) => {
      const handle = await originalOpen(path, ...args);
      if (path === directory) handle.sync = async () => { throw new Error('directory sync failed'); };
      return handle;
    });
    mockFs(t, 'rename', async (from, to) => {
      if (to === primary) throw new Error('primary rename failed');
      return originalRename(from, to);
    });
    await assert.rejects(recovery ? store.list() : store.commit(proposal), /primary rename failed/);
    await store.drain();
    assert(notices.some(value => value.startsWith('Memory file replacement completed')));
    assert(!notices.some(value => value.startsWith('Memory changes committed')));
    if (recovery) assert.equal(await readFile(primary, 'utf8'), '{corrupt');
    else await assert.rejects(lstat(primary), { code: 'ENOENT' });
  });
}
