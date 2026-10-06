// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileSessionStore, MAX_SESSION_BYTES, newSession } from '../dist/session.js';
import { MAX_PREFERENCES_BYTES, MAX_SESSION_LIST_ENTRIES, MAX_SESSION_PICKER_ITEMS,
  PreferenceStore, listSessions, validatePreferences } from '../dist/preferences.js';

const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);
const settings = { provider: 'openai', model: 'fake-model' };
const preferences = () => ({ schemaVersion: 1, ...settings, reasoning: 'default', reasoningCapabilities: [],
  stream: true, enableTools: false, enableNotes: false, enableMemory: false, maxRounds: 25 });
async function fixture(t, secrets = []) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-preferences-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new PreferenceStore(directory, secrets), sessions: new FileSessionStore(directory, secrets) };
}

function mockFs(t, name, replacement) {
  t.mock.method(fs, name, replacement);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test('preferences round-trip only nonsecret whitelist settings with atomic private persistence', async (t) => {
  const { directory, store } = await fixture(t);
  assert.equal(await store.load(), undefined);
  const expected = { ...preferences(), provider: 'openrouter', model: 'vendor/example', reasoning: 'high',
    reasoningCapabilities: ['none', 'high'], stream: false, enableTools: true, enableNotes: true, maxRounds: 100 };
  await store.save(expected);
  assert.deepEqual(await store.load(), expected);
  const file = join(directory, 'preferences.json');
  assert.ok(Buffer.byteLength(await readFile(file)) <= MAX_PREFERENCES_BYTES);
  if (process.platform !== 'win32') assert.equal((await lstat(file)).mode & 0o777, 0o600);
  expected.maxRounds = 1;
  await store.save(expected);
  assert.deepEqual(await store.load(), expected);
  assert.deepEqual(await readdir(directory), ['preferences.json']);
  const loaded = await store.load(); loaded.reasoningCapabilities.push('low');
  assert.deepEqual(await store.load(), expected);
});

test('absent preference directories return no settings; saving creates a private directory', async (t) => {
  const { directory } = await fixture(t);
  const child = join(directory, 'new-session-directory');
  const store = new PreferenceStore(child, []);
  assert.equal(await store.load(), undefined);
  assert.deepEqual(await readdir(directory), []);
  await store.save(preferences());
  if (process.platform !== 'win32') assert.equal((await lstat(child)).mode & 0o777, 0o700);
  assert.deepEqual(await store.load(), preferences());
});

test('old exact schema-1 preferences load memory disabled and save a complete current whitelist', async (t) => {
  const { directory, store } = await fixture(t);
  const old = preferences(); delete old.enableMemory;
  await writeFile(join(directory, 'preferences.json'), JSON.stringify(old), { mode: 0o600 });
  const loaded = await store.load();
  assert.deepEqual(loaded, preferences());
  assert.deepEqual(validatePreferences(old), preferences());
  await store.save(loaded);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'preferences.json'), 'utf8')), preferences());
  assert.equal(validatePreferences({ ...preferences(), model: '', enableMemory: true }).enableMemory, true);
  for (const invalid of [{ ...old, extra: false }, { ...preferences(), enableMemory: 'true' },
    { ...preferences(), enableMemory: undefined }]) assert.throws(() => validatePreferences(invalid));
});

test('preferences reject unsupported, credential, extra and out-of-bounds settings without altering saved data', async (t) => {
  const { store } = await fixture(t);
  await store.save(preferences());
  const missing = preferences(); delete missing.stream;
  const invalid = [null, [], {}, missing, { ...preferences(), schemaVersion: 2 },
    { ...preferences(), apiKey: 'a-credential' }, { ...preferences(), history: [] },
    { ...preferences(), provider: 'arbitrary-provider' }, { ...preferences(), model: '', enableTools: true },
    { ...preferences(), model: ' padded' }, { ...preferences(), model: 'x'.repeat(201) },
    { ...preferences(), model: 'model\u001b[31m' }, { ...preferences(), reasoning: 'disabled' },
    { ...preferences(), reasoning: 'high' }, { ...preferences(), reasoningCapabilities: ['default'] },
    { ...preferences(), reasoningCapabilities: ['high', 'high'] },
    { ...preferences(), reasoningCapabilities: Array(8).fill('low') },
    { ...preferences(), stream: 1 }, { ...preferences(), enableTools: 'true' },
    { ...preferences(), enableNotes: 'true' }, { ...preferences(), enableNotes: true }, { ...preferences(), enableMemory: 1 },
    ...[0, 101, 1.5, NaN, Infinity, '25'].map((maxRounds) => ({ ...preferences(), maxRounds }))];
  for (const input of invalid) {
    assert.throws(() => validatePreferences(input));
    await assert.rejects(store.save(input));
  }
  assert.deepEqual(await store.load(), preferences());
});

test('preference validation rejects getters, hooks, sparse arrays and hidden fields without executing them', () => {
  let reads = 0;
  const getter = Object.defineProperty(preferences(), 'model', { enumerable: true, get() { reads++; return 'bad'; } });
  const memoryGetter = Object.defineProperty(preferences(), 'enableMemory', { enumerable: true, get() { reads++; return true; } });
  const hidden = Object.defineProperty(preferences(), 'credential', { value: 'secret' });
  const symbol = { ...preferences(), [Symbol('credential')]: 'secret' };
  const hooked = { ...preferences(), toJSON() { reads++; return preferences(); } };
  const inherited = Object.assign(Object.create({ secret: 'inherited' }), preferences());
  const sparse = { ...preferences(), reasoningCapabilities: Array(1) };
  const capabilities = ['high'];
  Object.defineProperty(capabilities, '0', { enumerable: true, get() { reads++; return 'high'; } });
  const extraArrayField = Object.assign([], { credential: 'secret' });
  for (const input of [getter, memoryGetter, hidden, symbol, hooked, inherited, sparse,
    { ...preferences(), reasoningCapabilities: capabilities }, { ...preferences(), reasoningCapabilities: extraArrayField }]) {
    assert.throws(() => validatePreferences(input));
  }
  assert.equal(reads, 0);
});

test('preference load and save refuse raw, escaped and unicode-escaped environment credentials', async (t) => {
  const secret = 'known-key-123'; const escapedSecret = 'quote"backslash\\key';
  const { directory, store } = await fixture(t, [secret, escapedSecret]);
  await store.save(preferences());
  for (const model of [secret, `vendor/${secret}`, escapedSecret]) {
    await assert.rejects(store.save({ ...preferences(), model }), /environment credentials/);
    assert.ok(!(await readFile(join(directory, 'preferences.json'), 'utf8')).includes(secret));
  }
  const file = join(directory, 'preferences.json');
  await writeFile(file, JSON.stringify({ ...preferences(), model: escapedSecret }), { mode: 0o600 });
  await assert.rejects(store.load(), /environment credentials/);
  const escaped = [...secret].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  await writeFile(file, JSON.stringify({ ...preferences(), model: secret }).replace(secret, escaped));
  await assert.rejects(store.load(), /environment credentials/);
});

test('preferences reject invalid JSON, unknown loaded fields and oversized files', async (t) => {
  const { directory, store } = await fixture(t);
  const file = join(directory, 'preferences.json');
  await writeFile(file, '{broken', { mode: 0o600 });
  await assert.rejects(store.load(), /valid JSON/);
  await writeFile(file, JSON.stringify({ ...preferences(), apiKey: 'forbidden' }));
  await assert.rejects(store.load(), /unexpected/);
  await writeFile(file, ' '.repeat(MAX_PREFERENCES_BYTES + 1));
  await assert.rejects(store.load(), /size limit/);
});

test('preference reads reject a regular-file replacement between lstat and open before reading it', async (t) => {
  const { directory, store } = await fixture(t);
  await store.save(preferences());
  const target = join(directory, 'preferences.json'); const originalOpen = fs.open;
  let reads = 0;
  mockFs(t, 'open', async (path, ...args) => {
    if (path === target) {
      await fs.rename(target, join(directory, 'original.json'));
      await writeFile(target, JSON.stringify({ ...preferences(), model: 'replacement' }), { mode: 0o600 });
    }
    const handle = await originalOpen(path, ...args);
    if (path === target) {
      const originalRead = handle.read.bind(handle);
      handle.read = (...readArgs) => { reads++; return originalRead(...readArgs); };
    }
    return handle;
  });
  await assert.rejects(store.load(), /private regular/);
  assert.equal(reads, 0);
});

test('preference reads stay bounded when a private file grows after its descriptor stat', async (t) => {
  const { directory, store } = await fixture(t);
  await store.save(preferences());
  const target = join(directory, 'preferences.json'); const originalOpen = fs.open;
  let bytesRead = 0;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (path === target) {
      const originalStat = handle.stat.bind(handle); const originalRead = handle.read.bind(handle);
      handle.stat = async () => {
        const info = await originalStat();
        await writeFile(target, `${JSON.stringify(preferences())}${' '.repeat(MAX_PREFERENCES_BYTES + 100)}`);
        return info;
      };
      handle.read = async (...readArgs) => {
        const result = await originalRead(...readArgs); bytesRead += result.bytesRead; return result;
      };
    }
    return handle;
  });
  await assert.rejects(store.load(), /size limit/);
  assert.equal(bytesRead, MAX_PREFERENCES_BYTES + 1);
});

test('preference saves sync the file before rename and the directory afterwards', async (t) => {
  if (process.platform === 'win32') return;
  const { directory, store } = await fixture(t);
  const originalOpen = fs.open; const originalRename = fs.rename; const calls = [];
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args); const originalSync = handle.sync.bind(handle);
    handle.sync = async () => { calls.push(path === directory ? 'directory-sync' : 'file-sync'); return originalSync(); };
    return handle;
  });
  mockFs(t, 'rename', async (...args) => { calls.push('rename'); return originalRename(...args); });
  await store.save(preferences());
  assert.deepEqual(calls, ['file-sync', 'rename', 'directory-sync']);
  assert.deepEqual(await store.load(), preferences());
});

test('failed preference file fsync leaves the old settings intact and removes the temporary file', async (t) => {
  const { directory, store } = await fixture(t);
  await store.save(preferences());
  const originalOpen = fs.open;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path).endsWith('.tmp')) handle.sync = async () => { throw new Error('simulated fsync failure'); };
    return handle;
  });
  await assert.rejects(store.save({ ...preferences(), model: 'updated-model' }), /simulated fsync failure/);
  assert.deepEqual(await store.load(), preferences());
  assert.deepEqual(await readdir(directory), ['preferences.json']);
});

test('failed preference rename leaves old settings intact and removes the synced temporary file', async (t) => {
  const { directory, store } = await fixture(t);
  await store.save(preferences());
  mockFs(t, 'rename', async () => { throw new Error('simulated rename failure'); });
  await assert.rejects(store.save({ ...preferences(), model: 'updated-model' }), /simulated rename failure/);
  assert.deepEqual(await store.load(), preferences());
  assert.deepEqual(await readdir(directory), ['preferences.json']);
});

test('preferences refuse symlink and nonregular targets without changing other files', async (t) => {
  const { directory, store } = await fixture(t);
  const outside = join(directory, 'untouched'); const target = join(directory, 'preferences.json');
  await writeFile(outside, 'original', { mode: 0o600 });
  await symlink(outside, target);
  await assert.rejects(store.load(), /private regular/);
  await assert.rejects(store.save(preferences()), /nonregular/);
  assert.equal(await readFile(outside, 'utf8'), 'original');
  await rm(target); await mkdir(target, { mode: 0o700 });
  await assert.rejects(store.load(), /private regular/);
  await assert.rejects(store.save(preferences()), /nonregular/);
});

test('preferences enforce private owner file and directory permission rules', async (t) => {
  if (process.platform === 'win32') return;
  const { directory, store } = await fixture(t);
  await store.save(preferences());
  const target = join(directory, 'preferences.json');
  await chmod(target, 0o644);
  await assert.rejects(store.load(), /private regular/);
  await assert.rejects(store.save(preferences()), /nonprivate/);
  await chmod(target, 0o600); await chmod(directory, 0o755);
  await assert.rejects(store.load(), /0700/);
  await assert.rejects(store.save(preferences()), /0700/);
});

test('preference stores and session listing refuse symlinked directories', async (t) => {
  const { directory } = await fixture(t);
  const actual = join(directory, 'actual'); const link = join(directory, 'link');
  await mkdir(actual, { mode: 0o700 }); await symlink(actual, link);
  const store = new PreferenceStore(link, []);
  await assert.rejects(store.load(), /real directory/);
  await assert.rejects(store.save(preferences()), /real directory/);
  await assert.rejects(listSessions(new FileSessionStore(link)), /real directory/);
  assert.deepEqual(await readdir(actual), []);
});

test('session picker emits validated metadata, newest first, with live lock flags and no transcript snippets', async (t) => {
  const { sessions } = await fixture(t);
  const older = newSession(settings); older.updatedAt = '2024-01-01T00:00:00.000Z';
  older.history = [{ kind: 'message', role: 'user', content: 'private-transcript' }]; older.notes = { private: 'private-note' };
  const newer = newSession({ provider: 'openrouter', model: 'vendor/model', reasoning: 'high' });
  newer.updatedAt = '2025-01-01T00:00:00.000Z';
  await sessions.save(older); await sessions.save(newer);
  const release = await sessions.acquire(newer.id);
  const listed = await listSessions(sessions);
  assert.deepEqual(listed, [
    { id: newer.id, provider: newer.provider, model: newer.model, reasoning: 'high', updatedAt: newer.updatedAt, locked: true },
    { id: older.id, provider: older.provider, model: older.model, updatedAt: older.updatedAt, locked: false },
  ]);
  assert.ok(!JSON.stringify(listed).includes('private-'));
  assert.deepEqual(await listSessions(sessions, 1), [listed[0]]);
  await release(); assert.equal((await listSessions(sessions))[0].locked, false);
});

test('session picker skips malformed, public, oversized, mismatched, symlink and unsafe identifier files', async (t) => {
  const { directory, sessions } = await fixture(t);
  const valid = newSession(settings); await sessions.save(valid);
  const malformed = newSession(settings);
  await writeFile(join(directory, `${malformed.id}.json`), '{broken', { mode: 0o600 });
  const oversized = newSession(settings);
  await writeFile(join(directory, `${oversized.id}.json`), 'x'.repeat(MAX_SESSION_BYTES + 1), { mode: 0o600 });
  const mismatched = newSession(settings);
  await writeFile(join(directory, `${mismatched.id}.json`), JSON.stringify(valid), { mode: 0o600 });
  const publicSession = newSession(settings); await sessions.save(publicSession);
  await chmod(join(directory, `${publicSession.id}.json`), 0o644);
  const unsafeModel = newSession({ ...settings, model: 'terminal\u001b[31m' }); await sessions.save(unsafeModel);
  const link = newSession(settings);
  await symlink(join(directory, `${valid.id}.json`), join(directory, `${link.id}.json`));
  await writeFile(join(directory, 'not-a-session.json'), JSON.stringify(valid), { mode: 0o600 });
  await writeFile(join(directory, 'preferences.json'), JSON.stringify(preferences()), { mode: 0o600 });
  const listed = await listSessions(sessions);
  const expectedIds = process.platform === 'win32' ? [valid.id, publicSession.id].sort() : [valid.id];
  assert.deepEqual(listed.map(({ id }) => id).sort(), expectedIds);
});

test('session picker treats unexpected lock objects conservatively and does not follow them', async (t) => {
  const { directory, sessions } = await fixture(t);
  const session = newSession(settings); await sessions.save(session);
  await symlink(join(directory, 'missing'), join(directory, `${session.id}.json.lock`));
  assert.equal((await listSessions(sessions))[0].locked, true);
});

test('session picker bounds result counts and rejects invalid limits without scanning', async (t) => {
  const { directory, sessions } = await fixture(t);
  const all = Array.from({ length: MAX_SESSION_PICKER_ITEMS + 7 }, (_, index) => {
    const session = newSession(settings); session.updatedAt = new Date(Date.UTC(2020, 0, index + 1)).toISOString(); return session;
  });
  await Promise.all(all.map((session) => writeFile(join(directory, `${session.id}.json`), JSON.stringify(session), { mode: 0o600 })));
  const listed = await listSessions(sessions);
  assert.equal(listed.length, MAX_SESSION_PICKER_ITEMS);
  assert.equal(listed[0].id, all.at(-1).id);
  assert.deepEqual(await listSessions(sessions, 0), []);
  for (const limit of [-1, 101, 1.5, NaN, Infinity]) await assert.rejects(listSessions(sessions, limit), /limit/);
});

test('session picker scan is bounded even when every candidate fails validation', async (t) => {
  const { directory, sessions } = await fixture(t);
  const files = Array.from({ length: MAX_SESSION_LIST_ENTRIES + 7 }, () => `${randomUUID()}.json`);
  await Promise.all(files.map((name) => writeFile(join(directory, name), '{broken', { mode: 0o600 })));
  let loads = 0; const original = sessions.load.bind(sessions);
  sessions.load = async (id) => { loads++; return original(id); };
  assert.deepEqual(await listSessions(sessions), []);
  assert.equal(loads, MAX_SESSION_LIST_ENTRIES);
});

test('session picker tolerates absent directories and refuses public directories', async (t) => {
  const { directory } = await fixture(t);
  const missing = join(directory, 'missing');
  assert.deepEqual(await listSessions(new FileSessionStore(missing)), []);
  assert.deepEqual(await readdir(directory), []);
  if (process.platform !== 'win32') {
    await chmod(directory, 0o755);
    await assert.rejects(listSessions(new FileSessionStore(directory)), /0700/);
  }
});

test('provider setup can be saved before selecting a model, without any capability claims', () => {
  assert.equal(validatePreferences({ ...preferences(), model: '' }).model, '');
  assert.throws(() => validatePreferences({ ...preferences(), model: '', reasoning: 'high', reasoningCapabilities: ['high'] }));
});
