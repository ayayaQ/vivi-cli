// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import fs, { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FileDecisionLedger, DecisionLedgerError, DecisionLedgerCommitError, validateDecisionLedgerRecord,
  MAX_DECISION_LEDGER_ROWS, MAX_DECISION_LEDGER_BYTES
} from '../dist/decision-ledger.js';

const test = (name, fn) => nodeTest(name, { timeout: 20_000 }, fn);
const moduleUrl = new URL('../dist/decision-ledger.js', import.meta.url).href;
const time = '2026-10-08T00:00:00.000Z';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function record(overrides = {}) {
  return {
    id: randomUUID(), sessionId: randomUUID(), runId: randomUUID(), callId: 'call_opaque-123',
    toolName: 'note_set', policyRevision: 'vivi-cli-auto-v1-openai', provider: 'openai',
    model: 'gpt-5.2', snapshotDigest: 'a'.repeat(64), source: 'automatic', reasonCode: 'requirements_met',
    checks: [{ name: 'exact_action_requested', probability: 0.99, reasonCode: 'allow_threshold_met' }],
    createdAt: time, updatedAt: time, state: 'reviewed', ...overrides
  };
}
const encoded = records => `${JSON.stringify({ schemaVersion: 1, records })}\n`;
async function fixture(t, secrets = []) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-decision-ledger-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, primary: join(directory, 'decision-ledger.json'), lock: join(directory, 'decision-ledger.json.lock'),
    store: new FileDecisionLedger(directory, secrets) };
}
function mockFs(t, name, replacement) {
  t.mock.method(fs, name, replacement); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}
async function child(code, args = []) {
  const processChild = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let error = '';
  processChild.stdout.on('data', data => { output += data; });
  processChild.stderr.on('data', data => { error += data; });
  const status = await new Promise((resolve, reject) => { processChild.once('error', reject); processChild.once('close', resolve); });
  assert.equal(status, 0, error); return output;
}
async function fifo(path) {
  const processChild = spawn('mkfifo', [path], { stdio: 'ignore' });
  const status = await new Promise((resolve, reject) => { processChild.once('error', reject); processChild.once('close', resolve); });
  assert.equal(status, 0);
}

test('construction and missing reads never create files, directories or leases', async t => {
  const { directory } = await fixture(t); const isolated = join(directory, 'absent');
  const store = new FileDecisionLedger(isolated);
  assert.deepEqual(await readdir(directory), []);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(lstat(isolated), { code: 'ENOENT' });
  await store.upsert(record());
  assert.deepEqual(await readdir(isolated), ['decision-ledger.json']);
  if (process.platform !== 'win32') {
    assert.equal((await lstat(isolated)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(isolated, 'decision-ledger.json'))).mode & 0o777, 0o600);
  }
});

test('strict audit projection retains only bounded named estimates and reported usage', async t => {
  const { store, primary } = await fixture(t);
  const item = record({ usage: { inputTokens: 31, outputTokens: 7, cachedTokens: 4, reasoningTokens: 2, costUsd: 0.0001 } });
  await store.append(item);
  assert.deepEqual(await store.list(), [item]);
  const stored = JSON.parse(await readFile(primary, 'utf8'));
  assert.equal(stored.schemaVersion, 1);
  assert.deepEqual(stored.records, [item]);
  assert.equal(Object.hasOwn(stored.records[0].usage, 'totalTokens'), false);
  assert.equal(Object.hasOwn(stored.records[0].usage, 'cacheWriteTokens'), false);
});

test('closed schemas reject content, arguments, requests, credentials, reasoning and arbitrary extras', () => {
  for (const field of ['content', 'arguments', 'request', 'credentials', 'reasoning', 'description', 'httpStatus', 'extra']) {
    assert.throws(() => validateDecisionLedgerRecord(record({ [field]: 'private material' })), /unexpected field/);
  }
  assert.throws(() => validateDecisionLedgerRecord(record({ checks: [{ name: 'exact_action_requested', probability: 0.99,
    reasonCode: 'allow_threshold_met', reasoning: 'private material' }] })), /unexpected field/);
  assert.throws(() => validateDecisionLedgerRecord(record({ usage: { inputTokens: 1, outputTokens: 1, details: 'private' } })), /unexpected field/);
});

test('invalid identifiers, tools, revisions, states, reasons, timestamps and numeric estimates are refused', () => {
  const invalid = [
    { id: 'model-chosen-id' }, { sessionId: '../escape' }, { runId: 'not-a-uuid' },
    { callId: 'x'.repeat(201) }, { callId: 'prompt with spaces' }, { callId: '' },
    { policyRevision: '' }, { model: 'model\nprivate' }, { snapshotDigest: 'a'.repeat(63) },
    { toolName: 'unknown_extension' }, { provider: 'external-provider' }, { source: 'pre-approved' },
    { state: 'approved' }, { reasonCode: 'free form reasoning' }, { resultRevision: 'x'.repeat(201) },
    { resultRevision: -1 }, { resultRevision: Number.MAX_SAFE_INTEGER + 1 },
    { createdAt: '2026-02-30T00:00:00.000Z' }, { updatedAt: '2026-10-08T00:00:00Z' },
    { updatedAt: '2026-10-07T00:00:00.000Z' },
    { checks: [{ name: 'unknown_predicate', probability: 1, reasonCode: 'allow_threshold_met' }] },
    { checks: [{ name: 'exact_action_requested', probability: Infinity, reasonCode: 'allow_threshold_met' }] },
    { checks: [{ name: 'exact_action_requested', probability: -0.1, reasonCode: 'allow_threshold_met' }] },
    { checks: [{ name: 'exact_action_requested', probability: 1.1, reasonCode: 'allow_threshold_met' }] },
    { checks: [{ name: 'exact_action_requested', probability: 0.99, reasonCode: 'free-text' }] },
    { usage: { inputTokens: 1, outputTokens: -1 } }, { usage: { inputTokens: 1 } },
    { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 1.5 } },
    { usage: { inputTokens: 1, outputTokens: 1, cachedTokens: NaN } },
    { usage: { inputTokens: 1, outputTokens: 1, costUsd: Infinity } }
  ];
  for (const override of invalid) assert.throws(() => validateDecisionLedgerRecord(record(override)), DecisionLedgerError);
  const same = { name: 'exact_action_requested', probability: 0.99, reasonCode: 'allow_threshold_met' };
  assert.throws(() => validateDecisionLedgerRecord(record({ checks: [same, same] })), /duplicate/);
  assert.throws(() => validateDecisionLedgerRecord(record({ checks: Array(5).fill(same) })), /limit/);
  assert.throws(() => validateDecisionLedgerRecord(record({ checks: Array(1) })), /sparse/);
});

test('rejected getters, serialization hooks, hidden fields, symbols and prototype instances never run', async t => {
  const { store } = await fixture(t); let reads = 0;
  const getter = Object.defineProperty(record(), 'model', { enumerable: true, get() { reads++; return 'gpt-5.2'; } });
  await assert.rejects(store.upsert(getter), /enumerable data/); assert.equal(reads, 0);
  const hook = record({ toJSON() { reads++; return record(); } });
  await assert.rejects(store.upsert(hook), /unexpected field/); assert.equal(reads, 0);
  const hidden = Object.defineProperty(record(), 'usage', { value: {}, enumerable: false });
  assert.throws(() => validateDecisionLedgerRecord(hidden), /enumerable/);
  assert.throws(() => validateDecisionLedgerRecord({ ...record(), [Symbol('hidden')]: 'private' }), /symbol/);
  assert.throws(() => validateDecisionLedgerRecord(Object.assign(new (class Metadata {})(), record())), /plain data/);
  const checkGetter = Object.defineProperty({}, 'name', { enumerable: true, get() { reads++; return 'exact_action_requested'; } });
  assert.throws(() => validateDecisionLedgerRecord(record({ checks: [checkGetter] })), /enumerable data/); assert.equal(reads, 0);
});

test('upsert snapshots input before admission and protects immutable review identity', async t => {
  const { store } = await fixture(t); const item = record(); const original = structuredClone(item);
  const saving = store.upsert(item); item.model = 'unapproved-model'; item.checks[0].probability = 0;
  await saving; assert.deepEqual(await store.list(), [original]);
  await assert.rejects(store.upsert({ ...original, snapshotDigest: 'b'.repeat(64) }), /identity cannot change/);
  await assert.rejects(store.upsert({ ...original, updatedAt: '2026-10-07T00:00:00.000Z' }), /timestamp/);
  assert.deepEqual(await store.list(), [original]);
});

test('live commit checkpoints can complete, while interrupted rows are informational unknown outcomes', async t => {
  const { store, primary, directory } = await fixture(t); const item = record();
  await store.upsert(item); await store.upsert({ ...item, state: 'commit_started' });
  assert.equal((await store.list())[0].state, 'commit_started');
  const interrupted = new FileDecisionLedger(directory); const before = await readFile(primary, 'utf8');
  const unknown = (await interrupted.list())[0];
  assert.equal(unknown.state, 'unknown'); assert.equal(unknown.reasonCode, 'commit_unknown');
  assert.equal(await readFile(primary, 'utf8'), before);
  assert.deepEqual(await readdir(directory), ['decision-ledger.json']);
  await assert.rejects(interrupted.upsert({ ...item, state: 'commit_started' }), /cannot become an approval/);
  await assert.rejects(interrupted.upsert(item), /cannot become an approval/);
  await store.upsert({ ...item, state: 'committed', resultRevision: 2 });
  assert.equal((await interrupted.list())[0].state, 'committed');
  assert.equal((await interrupted.list())[0].resultRevision, 2);
});

test('the next admitted write persists recovery without repeating effects or reviews', async t => {
  const { directory, primary } = await fixture(t); const interrupted = record({ state: 'commit_started' });
  await writeFile(primary, encoded([interrupted]), { mode: 0o600 }); const before = await readFile(primary, 'utf8');
  const store = new FileDecisionLedger(directory);
  assert.equal((await store.list())[0].state, 'unknown'); assert.equal(await readFile(primary, 'utf8'), before);
  const next = record({ source: 'human-deny', state: 'denied', reasonCode: 'manual', checks: [] });
  await store.upsert(next);
  const data = JSON.parse(await readFile(primary, 'utf8')).records;
  assert.equal(data[0].state, 'unknown'); assert.equal(data[0].reasonCode, 'commit_unknown');
  assert.equal(data[0].snapshotDigest, interrupted.snapshotDigest); assert.deepEqual(data[1], next);
});

test('terminal audit outcomes can never be changed into reviewed approvals or restarted commits', async t => {
  const { store } = await fixture(t);
  for (const state of ['committed', 'denied', 'cancelled', 'failed', 'unknown']) {
    const item = record({ state }); await store.upsert(item);
    await assert.rejects(store.upsert({ ...item, state: 'reviewed' }), /cannot become an approval/);
    await assert.rejects(store.upsert({ ...item, state: 'commit_started' }), /cannot become an approval/);
  }
});

// This fixture intentionally performs 517 real durable writes. Windows hosted
// filesystem latency is not a production review deadline; retain all iterations
// and assertions while allowing this one stress case a bounded platform budget.
nodeTest('retention stays within both row and serialized byte bounds and retains the latest update',
  { timeout: process.platform === 'win32' ? 90_000 : 20_000 }, async t => {
  const { store, primary } = await fixture(t);
  for (let index = 0; index < MAX_DECISION_LEDGER_ROWS + 4; index++) await store.upsert(record({ callId: `call-${index}` }));
  let rows = await store.list(); assert.equal(rows.length, MAX_DECISION_LEDGER_ROWS);
  assert.equal(rows[0].callId, 'call-4'); assert.equal(rows.at(-1).callId, `call-${MAX_DECISION_LEDGER_ROWS + 3}`);
  const first = rows[0]; await store.upsert({ ...first, state: 'denied' });
  assert.equal((await store.list()).at(-1).id, first.id);
  const checkNames = ['exact_action_requested', 'effects_within_scope', 'evidence_not_redirected', 'ordinary_non_sensitive'];
  for (let index = 0; index < MAX_DECISION_LEDGER_ROWS; index++) await store.upsert(record({
    callId: `call-${index}-` + 'x'.repeat(180), model: 'm'.repeat(200), policyRevision: 'p'.repeat(200),
    resultRevision: 'r'.repeat(200), checks: checkNames.map(name => ({ name, probability: 0.9999999999999999, reasonCode: 'allow_threshold_met' })),
    usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: Number.MAX_SAFE_INTEGER, totalTokens: Number.MAX_SAFE_INTEGER,
      cachedTokens: Number.MAX_SAFE_INTEGER, cacheWriteTokens: Number.MAX_SAFE_INTEGER, reasoningTokens: Number.MAX_SAFE_INTEGER, costUsd: Number.MAX_VALUE }
  }));
  rows = await store.list();
  assert.ok(rows.length < MAX_DECISION_LEDGER_ROWS); assert.ok(rows.length > 0);
  assert.ok((await lstat(primary)).size <= MAX_DECISION_LEDGER_BYTES);
  assert.equal(rows.at(-1).callId, `call-${MAX_DECISION_LEDGER_ROWS - 1}-` + 'x'.repeat(180));
});

test('malformed, oversized, duplicate and unsupported stores remain intact and read-only', async t => {
  const { store, primary } = await fixture(t); const item = record();
  const invalid = ['{broken original evidence', encoded([item, item]),
    JSON.stringify({ schemaVersion: 2, records: [] }), JSON.stringify({ schemaVersion: 1, records: [], extra: 'private' }),
    encoded([record({ arguments: { secret: 'private' } })]), encoded(Array.from({ length: MAX_DECISION_LEDGER_ROWS + 1 }, () => record()))];
  for (const raw of invalid) {
    await writeFile(primary, raw, { mode: 0o600 });
    await assert.rejects(store.list(), DecisionLedgerError); await assert.rejects(store.upsert(record()), DecisionLedgerError);
    assert.equal(await readFile(primary, 'utf8'), raw);
  }
  const invalidUtf8 = Buffer.from([0xff, 0x7b, 0x00]); await writeFile(primary, invalidUtf8);
  await assert.rejects(store.list(), /UTF-8/); assert.deepEqual(await readFile(primary), invalidUtf8);
  const oversized = Buffer.alloc(MAX_DECISION_LEDGER_BYTES + 1, 32); await writeFile(primary, oversized);
  await assert.rejects(store.list(), /size limit/); assert.deepEqual(await readFile(primary), oversized);
});

test('symlinked, public, directory and FIFO targets are refused without following or replacing them', async t => {
  const { store, primary, directory } = await fixture(t); const outside = join(directory, 'outside');
  await writeFile(outside, encoded([record()]), { mode: 0o600 }); await symlink(outside, primary);
  await assert.rejects(store.list(), /private regular/); await assert.rejects(store.upsert(record()), /private regular/);
  assert.ok((await lstat(primary)).isSymbolicLink()); await unlink(primary);
  await mkdir(primary, { mode: 0o700 }); await assert.rejects(store.list(), /private regular/); await rm(primary, { recursive: true });
  if (process.platform !== 'win32') {
    await fifo(primary); await assert.rejects(store.list(), /private regular/); await assert.rejects(store.upsert(record()), /private regular/);
    assert.ok((await lstat(primary)).isFIFO()); await unlink(primary);
    await writeFile(primary, encoded([]), { mode: 0o600 }); await chmod(primary, 0o644);
    await assert.rejects(store.list(), /private regular/); await assert.rejects(store.upsert(record()), /private regular/);
  }
});

test('directory symlinks and non-private directories are rejected', async t => {
  const { directory } = await fixture(t); const real = join(directory, 'real'); const alias = join(directory, 'alias');
  await mkdir(real, { mode: 0o700 }); await symlink(real, alias);
  await assert.rejects(new FileDecisionLedger(alias).upsert(record()), /real, owned and private/);
  await assert.rejects(new FileDecisionLedger(alias).list(), /real, owned and private/);
  if (process.platform !== 'win32') {
    await chmod(real, 0o755); await assert.rejects(new FileDecisionLedger(real).upsert(record()), /private/);
  }
});

test('read identity swaps and regular-file-to-FIFO races never expose replacement data or hang', async t => {
  const { store, primary, directory } = await fixture(t); await writeFile(primary, encoded([record()]), { mode: 0o600 });
  const originalOpen = fs.open; let reads = 0;
  mockFs(t, 'open', async (path, ...args) => {
    if (path === primary) {
      await rename(primary, join(directory, 'old-primary'));
      if (process.platform === 'win32') await writeFile(primary, encoded([record()]), { mode: 0o600 });
      else await fifo(primary);
    }
    const handle = await originalOpen(path, ...args);
    if (path === primary) { const read = handle.read.bind(handle); handle.read = (...values) => { reads++; return read(...values); }; }
    return handle;
  });
  await assert.rejects(store.list(), /changed while opening/); assert.equal(reads, 0);
});

test('file growth after descriptor stat is bounded to one extra detection byte', async t => {
  const { store, primary } = await fixture(t); await writeFile(primary, encoded([record()]), { mode: 0o600 });
  const originalOpen = fs.open; let readBytes = 0;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (path === primary) {
      const stat = handle.stat.bind(handle); const read = handle.read.bind(handle); let first = true;
      handle.stat = async () => { const info = await stat(); if (first) { first = false; await writeFile(primary, Buffer.alloc(MAX_DECISION_LEDGER_BYTES + 100)); } return info; };
      handle.read = async (...values) => { const result = await read(...values); readBytes += result.bytesRead; return result; };
    }
    return handle;
  });
  await assert.rejects(store.list(), /size limit/); assert.equal(readBytes, MAX_DECISION_LEDGER_BYTES + 1);
});

test('reads detect directory replacement and never remove replacement files or locks', async t => {
  if (process.platform === 'win32') return;
  const { store, primary, lock, directory } = await fixture(t); await writeFile(primary, encoded([record()]), { mode: 0o600 });
  const moved = `${directory}-moved`; t.after(() => rm(moved, { recursive: true, force: true })); const originalOpen = fs.open;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (path === primary) {
      await rename(directory, moved); await mkdir(directory, { mode: 0o700 });
      await writeFile(primary, 'replacement evidence', { mode: 0o600 }); await writeFile(lock, 'replacement owner', { mode: 0o600 });
    }
    return handle;
  });
  await assert.rejects(store.list(), /directory changed/);
  assert.equal(await readFile(primary, 'utf8'), 'replacement evidence'); assert.equal(await readFile(lock, 'utf8'), 'replacement owner');
});

test('writes sync exclusive private temporary bytes before rename, then sync the directory', async t => {
  if (process.platform === 'win32') return;
  const { store, primary, directory } = await fixture(t); const events = []; const originalOpen = fs.open; const originalRename = fs.rename;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args); const sync = handle.sync.bind(handle);
    handle.sync = async () => { events.push(path === directory ? 'directory-sync' : String(path).endsWith('.tmp') ? 'temporary-sync' : 'lease-sync'); return sync(); };
    return handle;
  });
  mockFs(t, 'rename', async (from, to) => { assert.equal(to, primary); events.push('rename'); return originalRename(from, to); });
  await store.upsert(record()); assert.deepEqual(events, ['lease-sync', 'temporary-sync', 'rename', 'directory-sync']);
  assert.deepEqual(await readdir(directory), ['decision-ledger.json']);
});

test('precommit temporary fsync and rename failures preserve the previous audit bytes', async t => {
  const { store, primary } = await fixture(t); await store.upsert(record()); const before = await readFile(primary, 'utf8');
  const originalOpen = fs.open;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path).endsWith('.tmp')) handle.sync = async () => { throw new Error('simulated temporary sync failure'); };
    return handle;
  });
  await assert.rejects(store.upsert(record()), error => error instanceof DecisionLedgerError && !(error instanceof DecisionLedgerCommitError));
  assert.equal(await readFile(primary, 'utf8'), before); assert.ok(store.auditFailure);
});

test('precommit rename failure is reported without false success or loss of the prior audit', async t => {
  const { store, primary } = await fixture(t); await store.upsert(record()); const before = await readFile(primary, 'utf8');
  mockFs(t, 'rename', async () => { throw new Error('simulated rename failure'); });
  await assert.rejects(store.upsert(record()), error => error instanceof DecisionLedgerError && !(error instanceof DecisionLedgerCommitError));
  assert.equal(await readFile(primary, 'utf8'), before);
});

test('temporary and target substitutions before rename are rejected and substituted files stay intact', async t => {
  const { store, primary, directory } = await fixture(t); await store.upsert(record()); const before = await readFile(primary, 'utf8');
  const originalOpen = fs.open; let replacement;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path).endsWith('.tmp')) {
      const sync = handle.sync.bind(handle); handle.sync = async () => {
        await sync(); await rename(path, `${path}.old`); replacement = path;
        await writeFile(path, 'replacement temporary evidence', { mode: 0o600 });
      };
    }
    return handle;
  });
  await assert.rejects(store.upsert(record()), /temporary file changed/);
  assert.equal(await readFile(primary, 'utf8'), before); assert.equal(await readFile(replacement, 'utf8'), 'replacement temporary evidence');
  assert.ok((await readdir(directory)).some(name => name.endsWith('.tmp.old')));
});

test('target replacement during temporary fsync is preserved instead of overwritten', async t => {
  const { store, primary } = await fixture(t); await store.upsert(record()); const originalOpen = fs.open;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args);
    if (String(path).endsWith('.tmp')) {
      const sync = handle.sync.bind(handle); handle.sync = async () => {
        await sync(); await rename(primary, `${primary}.old`);
        await writeFile(primary, 'replacement primary evidence', { mode: 0o600 });
      };
    }
    return handle;
  });
  await assert.rejects(store.upsert(record()), /target changed/);
  assert.equal(await readFile(primary, 'utf8'), 'replacement primary evidence');
});

test('same-inode data modification after rename is exposed as a saved audit uncertainty', async t => {
  const { store, primary } = await fixture(t); const originalRename = fs.rename;
  mockFs(t, 'rename', async (from, to) => { await originalRename(from, to); await writeFile(primary, 'modified after rename', { mode: 0o600 }); });
  await assert.rejects(store.upsert(record()), error => error instanceof DecisionLedgerCommitError && error.committed);
  assert.equal(await readFile(primary, 'utf8'), 'modified after rename');
});

test('postrename directory substitution preserves its new primary and lease', async t => {
  if (process.platform === 'win32') return;
  const { store, primary, lock, directory } = await fixture(t); const moved = `${directory}-moved`;
  t.after(() => rm(moved, { recursive: true, force: true })); const originalRename = fs.rename;
  mockFs(t, 'rename', async (from, to) => {
    await originalRename(from, to); await originalRename(directory, moved); await mkdir(directory, { mode: 0o700 });
    await writeFile(primary, 'replacement audit evidence', { mode: 0o600 }); await writeFile(lock, 'replacement lease owner', { mode: 0o600 });
  });
  await assert.rejects(store.upsert(record()), error => error instanceof DecisionLedgerCommitError && error.committed);
  assert.equal(await readFile(primary, 'utf8'), 'replacement audit evidence'); assert.equal(await readFile(lock, 'utf8'), 'replacement lease owner');
  await assert.rejects(store.drain(), DecisionLedgerCommitError);
});

test('Windows descriptor-free directory checks reject identity replacement before reading data', async t => {
  const { store, primary, directory } = await fixture(t); const item = record(); await writeFile(primary, encoded([item]), { mode: 0o600 });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform'); Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const originalOpen = fs.open; const originalLstat = fs.lstat; let changed = false; let reads = 0;
  mockFs(t, 'lstat', async (path, ...args) => {
    const info = await originalLstat(path, ...args);
    if (path === directory && changed) return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { ino: info.ino === 0 ? 1 : 0 });
    return info;
  });
  mockFs(t, 'open', async (path, ...args) => {
    assert.notEqual(path, directory, 'Windows must not open unsupported directory handles');
    const handle = await originalOpen(path, ...args);
    if (path === primary) { const read = handle.read.bind(handle); handle.read = (...values) => { reads++; return read(...values); }; changed = true; }
    return handle;
  });
  await assert.rejects(store.list(), /directory changed/); assert.equal(reads, 0);
  assert.equal(await readFile(primary, 'utf8'), encoded([item]));
});

test('postrename fsync uncertainty is a committed audit error and drain retries only durability', async t => {
  if (process.platform === 'win32') return;
  const { store, primary, directory } = await fixture(t); const item = record({ state: 'commit_started' });
  const originalOpen = fs.open; const originalRename = fs.rename; let renamed = false; let failures = 1; let syncs = 0; let writes = 0;
  mockFs(t, 'rename', async (from, to) => { await originalRename(from, to); renamed = true; writes++; });
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args); const sync = handle.sync.bind(handle);
    if (path === directory) handle.sync = async () => { if (renamed) { syncs++; if (failures-- > 0) throw new Error('simulated durability failure'); } return sync(); };
    return handle;
  });
  await assert.rejects(store.upsert(item), error => error instanceof DecisionLedgerCommitError && error.committed === true);
  assert.equal(JSON.parse(await readFile(primary, 'utf8')).records[0].state, 'commit_started');
  assert.equal((await store.list())[0].state, 'unknown'); assert.ok(store.auditFailure instanceof DecisionLedgerCommitError);
  await store.drain(); assert.equal(writes, 1); assert.equal(syncs, 2); assert.equal(store.auditFailure, undefined);
});

test('drain never silently discards continued durability failures', async t => {
  if (process.platform === 'win32') return;
  const { store, directory } = await fixture(t); const originalOpen = fs.open;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args); if (path === directory) handle.sync = async () => { throw new Error('durability remains unavailable'); }; return handle;
  });
  await assert.rejects(store.upsert(record()), DecisionLedgerCommitError);
  await assert.rejects(store.drain(), DecisionLedgerCommitError); assert.ok(store.auditFailure);
});

test('lease replacements and in-place modifications are preserved and surfaced after saved writes', async t => {
  const { store, primary, lock } = await fixture(t); const originalRename = fs.rename;
  mockFs(t, 'rename', async (from, to) => { await originalRename(from, to); await writeFile(lock, 'replacement lease owner', { mode: 0o600 }); });
  await assert.rejects(store.upsert(record()), error => error instanceof DecisionLedgerCommitError && error.committed);
  assert.equal(JSON.parse(await readFile(primary, 'utf8')).records.length, 1);
  assert.equal(await readFile(lock, 'utf8'), 'replacement lease owner');
});

test('lease contention waits for release, but stale leases are never stolen', async t => {
  const { store, lock } = await fixture(t); await writeFile(lock, 'live owner', { mode: 0o600 });
  const saving = store.upsert(record()); setTimeout(() => { void unlink(lock); }, 70); await saving;
  const bytes = '{"pid":99999999,"stale":true}'; await writeFile(lock, bytes, { mode: 0o600 });
  await assert.rejects(store.upsert(record()), /never stolen automatically/); assert.equal(await readFile(lock, 'utf8'), bytes);
});

test('unsafe symlink and FIFO leases are rejected without being followed, read or removed', async t => {
  const { store, lock, directory } = await fixture(t); const target = join(directory, 'owner');
  await writeFile(target, 'owner evidence', { mode: 0o600 }); await symlink(target, lock);
  await assert.rejects(store.upsert(record()), /lease must be a private regular/); assert.ok((await lstat(lock)).isSymbolicLink());
  assert.equal(await readFile(target, 'utf8'), 'owner evidence'); await unlink(lock);
  if (process.platform !== 'win32') { await fifo(lock); await assert.rejects(store.upsert(record()), /lease must be a private regular/); assert.ok((await lstat(lock)).isFIFO()); }
});

test('aborting a lease wait preserves the owner and cancels before any audit write', async t => {
  const { store, lock, primary } = await fixture(t); await writeFile(lock, 'existing owner', { mode: 0o600 });
  const controller = new AbortController(); const saving = store.upsert(record(), { signal: controller.signal });
  setTimeout(() => controller.abort(), 40);
  await assert.rejects(saving, { name: 'AbortError' }); await store.drain();
  assert.equal(await readFile(lock, 'utf8'), 'existing owner'); await assert.rejects(lstat(primary), { code: 'ENOENT' });
});

test('queued cancellation and close drain wait for the admitted write to settle', async t => {
  const { store, primary } = await fixture(t); const entered = deferred(); const release = deferred(); const originalRename = fs.rename;
  mockFs(t, 'rename', async (from, to) => { entered.resolve(); await release.promise; return originalRename(from, to); });
  const first = store.upsert(record()); await entered.promise;
  const controller = new AbortController(); const queued = store.upsert(record(), { signal: controller.signal });
  const rejected = assert.rejects(queued, { name: 'AbortError' }); controller.abort();
  let drained = false; const draining = store.drain({ close: true }).then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(drained, false);
  release.resolve(); await first; await rejected; await draining;
  assert.equal(JSON.parse(await readFile(primary, 'utf8')).records.length, 1);
  await assert.rejects(store.upsert(record()), /closing/); await assert.rejects(store.list(), /closing/);
});

test('abort after rename starts does not invent a rollback or truncate drain', async t => {
  const { store, primary } = await fixture(t); const entered = deferred(); const release = deferred(); const originalRename = fs.rename;
  mockFs(t, 'rename', async (from, to) => { entered.resolve(); await release.promise; return originalRename(from, to); });
  const controller = new AbortController(); const saving = store.upsert(record(), { signal: controller.signal });
  await entered.promise; controller.abort(); let drained = false; const draining = store.drain().then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(drained, false);
  release.resolve(); await saving; await draining;
  assert.equal(JSON.parse(await readFile(primary, 'utf8')).records.length, 1);
});

test('known credentials are vetoed in every identifier and decoded stored data without exposure', async t => {
  const secret = 'known-vault-secret'; const { store, primary } = await fixture(t, [secret]);
  for (const field of ['callId', 'policyRevision', 'model', 'resultRevision']) {
    await assert.rejects(store.upsert(record({ [field]: secret })), error => /known credentials/.test(error.message) && !error.message.includes(secret));
  }
  const item = record({ callId: secret }); const escaped = [...secret].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const raw = encoded([item]).replaceAll(secret, escaped); await writeFile(primary, raw, { mode: 0o600 });
  await assert.rejects(store.list(), /known credentials/); await assert.rejects(store.upsert(record()), /known credentials/);
  assert.equal(await readFile(primary, 'utf8'), raw);
});

test('new credentials matching UUID and digest metadata block the next read without changing bytes', async t => {
  const { store, primary } = await fixture(t); const item = record(); await store.upsert(item); const before = await readFile(primary, 'utf8');
  store.addSecrets([item.id, item.sessionId, item.runId, item.snapshotDigest]);
  await assert.rejects(store.list(), /known credentials/); await assert.rejects(store.upsert(item), /known credentials/);
  assert.equal(await readFile(primary, 'utf8'), before);
});

test('credential registration before rename prevents saving, and after rename exposes committed uncertainty', async t => {
  const { store, primary } = await fixture(t); const item = record({ callId: 'newly-known-credential' }); const originalOpen = fs.open;
  mockFs(t, 'open', async (path, ...args) => {
    const handle = await originalOpen(path, ...args); const sync = handle.sync.bind(handle);
    if (String(path).endsWith('.tmp')) handle.sync = async () => { await sync(); store.addSecrets(['newly-known-credential']); };
    return handle;
  });
  await assert.rejects(store.upsert(item), /known credentials/); await assert.rejects(lstat(primary), { code: 'ENOENT' });
});

test('credentials learned after rename cannot be hidden behind a successful audit return', async t => {
  const { store, primary } = await fixture(t); const item = record({ callId: 'postrename-credential' }); const originalRename = fs.rename;
  mockFs(t, 'rename', async (from, to) => { await originalRename(from, to); store.addSecrets(['postrename-credential']); });
  await assert.rejects(store.upsert(item), error => error instanceof DecisionLedgerCommitError && !error.message.includes('postrename-credential'));
  assert.equal(JSON.parse(await readFile(primary, 'utf8')).records[0].id, item.id);
  await assert.rejects(store.list(), /known credentials/);
});

test('filesystem errors are sanitized and exposed as an audit failure', async t => {
  const secret = 'filesystem-secret'; const { store } = await fixture(t, [secret]);
  mockFs(t, 'open', async () => { throw new Error(`read denied for ${secret}`); });
  await assert.rejects(store.upsert(record()), error => error instanceof DecisionLedgerError &&
    error.message.includes('[REDACTED]') && !error.message.includes(secret));
  assert.equal(store.auditFailure.code, 'audit_unavailable');
});

test('separate processes serialize fresh loads and cannot overwrite each other audit rows', async t => {
  const { store, directory } = await fixture(t);
  const code = `import { FileDecisionLedger } from ${JSON.stringify(moduleUrl)};
    import { randomUUID } from 'node:crypto';
    const store = new FileDecisionLedger(process.argv[1]);
    for (let index = 0; index < 5; index++) {
      await store.upsert({ id: randomUUID(), sessionId: randomUUID(), runId: randomUUID(), callId: process.argv[2] + '-' + index,
        toolName: 'note_set', policyRevision: 'vivi-cli-auto-v1-openai', provider: 'openai', model: 'gpt-5.2',
        snapshotDigest: 'a'.repeat(64), source: 'human-deny', reasonCode: 'manual', checks: [],
        createdAt: ${JSON.stringify(time)}, updatedAt: ${JSON.stringify(time)}, state: 'denied' });
    }
    await store.drain();`;
  await Promise.all([child(code, [directory, 'first']), child(code, [directory, 'second'])]);
  const rows = await store.list(); assert.equal(rows.length, 10);
  assert.equal(rows.filter(row => row.callId.startsWith('first')).length, 5);
  assert.equal(rows.filter(row => row.callId.startsWith('second')).length, 5);
});


test('fetch_url audit rows distinguish network admission from transmission and never contain URL or body', async t => {
  const { store, primary } = await fixture(t)
  const item = record({ toolName: 'fetch_url', actionKind: 'network-admission', state: 'commit_started' })
  await store.upsert(item)
  await store.upsert({ ...item, state: 'committed' })
  assert.deepEqual(await store.list(), [{ ...item, state: 'committed' }])
  const stored = await readFile(primary, 'utf8')
  assert(stored.includes('network-admission'))
  assert(!stored.includes('https://')); assert(!stored.includes('body'))
  assert.throws(() => validateDecisionLedgerRecord(record({ toolName: 'fetch_url' })), /invalid action kind/)
  assert.throws(() => validateDecisionLedgerRecord(record({ toolName: 'fetch_url', actionKind: 'network-admission', resultRevision: 'a'.repeat(64) })), /no retrieval revision/)
  for (const actionKind of ['retrieved', 'transmitted', 'network-admission-extra']) {
    assert.throws(() => validateDecisionLedgerRecord(record({ toolName: 'fetch_url', actionKind })), /invalid action kind/)
  }
  assert.throws(() => validateDecisionLedgerRecord(record({ actionKind: 'network-admission' })), /invalid action kind/)
  for (const field of ['url', 'destination', 'requestBody', 'responseText']) {
    assert.throws(() => validateDecisionLedgerRecord(record({ toolName: 'fetch_url', actionKind: 'network-admission', [field]: 'private' })), /unexpected field/)
  }
})
