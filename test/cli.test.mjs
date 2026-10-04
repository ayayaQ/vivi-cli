// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test as nodeTest } from 'node:test';
import { mkdtemp, chmod, readFile, writeFile, readdir, rm, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { CliHost } from '../dist/host.js';
import { FileSessionStore, newSession, validateSession, environmentSecrets, redactSecrets, MAX_SESSION_BYTES, MAX_HISTORY_MESSAGES } from '../dist/session.js';
import { TerminalIO, runChatLoop } from '../dist/terminal.js';
import { calculate, builtinTools } from '../dist/tools.js';
import { main, parseArguments, providerForSession } from '../dist/main.js';
import { validateHistory, closeInterruptedHistory } from '@ayayaq/vivi';
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai';
import { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter';

const test = (name, fn) => nodeTest(name, { timeout: 4000 }, fn);
const answer = (content = 'Done', toolCalls = [], extras = {}) => ({ content, toolCalls, ...extras });
const call = (id, name, args = {}) => ({ id, name, arguments: args });
const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 7 };
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function fixture(t, secrets = []) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-cli-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new FileSessionStore(directory, secrets) };
}
const settings = { provider: 'openai', model: 'fake-model' };
function fakeIO(lines = []) {
  return {
    output: '', events: [], results: [], closed: false, cancel: undefined,
    async readLine() { return lines.shift(); },
    write(text) { this.output += text; },
    event(event) { this.events.push(event); },
    result(result) { this.results.push(result); },
    async approve() { return false; },
    onCancel(callback) { this.cancel = callback; return () => { this.cancel = undefined; }; },
    close() { this.closed = true; },
  };
}

test('headless CLI new session uses shared core, persists native state and usage, and resumes exact history', async (t) => {
  const { store } = await fixture(t);
  const state = { provider: 'openai:fake-model', items: [{ type: 'reasoning', encrypted_content: 'opaque-reasoning' }] };
  const host = await CliHost.create({ store, settings, provider: { generate: async () => answer('First', [], { providerState: state, usage }) } });
  const first = await host.send('Hello');
  assert.equal(first.status, 'completed');
  const saved = await store.load(host.session.id);
  assert.deepEqual(saved.history, first.history);
  assert.deepEqual(saved.usage, usage);
  assert.deepEqual(saved.history[1].providerState, state);
  let received;
  const resumed = await CliHost.resume({ id: saved.id, store, provider: { generate: async ({ messages }) => {
    received = messages; return answer('Second', [], { usage });
  } } });
  assert.equal((await resumed.send('Continue')).status, 'completed');
  assert.deepEqual(received.slice(0, -1), first.history);
  assert.equal(received.at(-1).content, 'Continue');
  assert.deepEqual(resumed.session.usage, { inputTokens: 6, outputTokens: 4, totalTokens: 14 });
});

test('CLI displays provider progress but only complete assistant output enters persisted history', async (t) => {
  const { store } = await fixture(t);
  const events = [];
  const host = await CliHost.create({ store, settings, onEvent: (event) => events.push(event), provider: {
    generate: async (_input, _signal, progress) => {
      await progress.onProgress({ type: 'text_delta', text: 'provisional' });
      return answer('Accepted canonical output');
    },
  } });
  await host.send('Hi');
  assert.equal(events[0].type, 'text_delta');
  const saved = await store.load(host.session.id);
  assert.equal(saved.history.at(-1).content, 'Accepted canonical output');
  assert.ok(!JSON.stringify(saved).includes('provisional'));
});

for (const [providerName, factory] of [['openai', createOpenAIProvider], ['openrouter', createOpenRouterProvider]]) {
  test(`CLI rejects ${providerName} streaming completion after a blocking progress callback without dispatching tools`, async (t) => {
    const { store } = await fixture(t);
    const frames = providerName === 'openai' ? [
      { type: 'response.output_text.delta', delta: 'Unaccepted partial' },
      { type: 'response.completed', response: { status: 'completed', output: [
        { type: 'function_call', call_id: 'late_note', name: 'note_set',
          arguments: JSON.stringify({ key: 'task', value: 'late mutation', expectedRevision: 0 }) },
      ] } },
    ] : [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Unaccepted partial' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'late_note', type: 'function',
        function: { name: 'note_set', arguments: JSON.stringify({ key: 'task', value: 'late mutation', expectedRevision: 0 }) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ];
    const body = frames.map((frame) => `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`).join('');
    let elapsed = 0; let requests = 0; let approvals = 0;
    // Advance monotonic time inside the callback, before a timer can run. The
    // shared transport must check the deadline before accepting terminal tools.
    t.mock.method(globalThis.performance, 'now', () => elapsed);
    const events = [];
    const provider = factory({ model: 'fake-model', apiKey: 'fake-key', timeoutMs: 1000, stream: true,
      fetch: async () => { requests++; return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }); },
    });
    const host = await CliHost.create({ store, settings: { ...settings, provider: providerName }, provider,
      enableNotes: true, approve: async () => { approvals++; return true; },
      onEvent: (event) => { events.push(event.type); if (event.type === 'text_delta') elapsed = 1001; },
    });
    const result = await host.send('Try a late note');
    assert.equal(approvals, 0);
    assert.deepEqual(events, ['text_delta']);
    assert.equal(result.status, 'error');
    assert.equal(result.error.code, 'provider_error');
    assert.match(result.error.message, /timed out/);
    assert.equal(requests, 1);
    assert.deepEqual(result.history, [{ kind: 'message', role: 'user', content: 'Try a late note' }]);
    const saved = await store.load(host.session.id);
    assert.deepEqual(saved.history, result.history);
    assert.deepEqual(saved.notes, {});
    assert.equal(saved.noteRevision, 0);
    assert.deepEqual(saved.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    assert.ok(!JSON.stringify(saved).includes('Unaccepted partial'));
    assert.ok(!JSON.stringify(saved).includes('late_note'));
  });
}

test('calculator and time are bounded, read-only builtins; notes are absent by default', async (t) => {
  assert.equal(calculate('2 * (3 + 4) - .5'), 13.5);
  for (const expression of ['process.exit()', '1/0', '2**3', '1;2', '('.repeat(30) + '1' + ')'.repeat(30), '1'.repeat(257)]) {
    assert.throws(() => calculate(expression));
  }
  assert.deepEqual(builtinTools().map((tool) => tool.name), ['calculate', 'current_time']);
  const { store } = await fixture(t);
  let round = 0;
  let results;
  const host = await CliHost.create({ store, settings, provider: { generate: async ({ messages }) => {
    if (++round === 1) return answer('', [call('calc', 'calculate', { expression: '4/2' }), call('time', 'current_time', { timezone: 'UTC' })]);
    results = messages.filter((message) => message.kind === 'tool_result'); return answer();
  } } });
  await host.send('Use the safe tools');
  assert.equal(JSON.parse(results[0].content).result, 2);
  assert.equal(JSON.parse(results[1].content).timezone, 'UTC');
  assert.ok(Number.isFinite(Date.parse(JSON.parse(results[1].content).iso)));
});

test('optional note mutation requires explicit approval and commits a checked revision', async (t) => {
  const { store } = await fixture(t);
  let prompts = 0; let round = 0;
  const host = await CliHost.create({ store, settings, enableNotes: true,
    approve: async (request, signal) => {
      prompts++; assert.equal(signal.aborted, false); assert.equal(request.currentRevision, 0);
      assert.match(request.description, /shopping/); return true;
    },
    provider: { generate: async () => ++round === 1
      ? answer('', [call('note', 'note_set', { key: 'shopping', value: 'oat milk', expectedRevision: 0 })]) : answer() },
  });
  const result = await host.send('Remember oat milk');
  assert.equal(result.status, 'completed');
  assert.equal(prompts, 1);
  assert.equal(host.session.notes.shopping, 'oat milk');
  assert.equal(host.session.noteRevision, 1);
  assert.equal(JSON.parse(result.history[2].content).success, true);
  assert.equal((await store.load(host.session.id)).notes.shopping, 'oat milk');
});

test('explicit denial and missing approval callback cannot mutate notes', async (t) => {
  const { store } = await fixture(t);
  for (const approve of [undefined, async () => false]) {
    let round = 0;
    const host = await CliHost.create({ store, settings, enableNotes: true, ...(approve ? { approve } : {}),
      provider: { generate: async () => ++round === 1
        ? answer('', [call('deny', 'note_set', { key: 'task', value: 'no', expectedRevision: 0 })]) : answer() },
    });
    const result = await host.send('Try a note');
    assert.equal(JSON.parse(result.history[2].content).error.code, 'approval_denied');
    assert.deepEqual(host.session.notes, {});
    assert.equal(host.session.noteRevision, 0);
  }
});

test('stale note revisions are rejected before asking for approval', async (t) => {
  const { store } = await fixture(t);
  let round = 0; let approvals = 0;
  const host = await CliHost.create({ store, settings, enableNotes: true, approve: async () => { approvals++; return true; },
    provider: { generate: async () => ++round === 1
      ? answer('', [call('stale', 'note_set', { key: 'task', value: 'no', expectedRevision: 99 })]) : answer() },
  });
  const result = await host.send('Try a stale mutation');
  assert.equal(approvals, 0);
  assert.equal(JSON.parse(result.history[2].content).error.code, 'revision_conflict');
});

test('unadvertised filesystem/shell/note tools are never dispatched', async (t) => {
  const { store } = await fixture(t);
  let round = 0; let approvals = 0;
  const host = await CliHost.create({ store, settings, approve: async () => { approvals++; return true; },
    provider: { generate: async () => ++round === 1 ? answer('', [
      call('shell', 'shell', { command: 'echo bad' }), call('file', 'read_file', { path: '/etc/passwd' }),
      call('note', 'note_set', { key: 'task', value: 'bad', expectedRevision: 0 })]) : answer() },
  });
  const result = await host.send('Tool availability test');
  assert.equal(approvals, 0);
  for (const message of result.history.filter((message) => message.kind === 'tool_result')) {
    assert.equal(JSON.parse(message.content).error.code, 'unavailable_tool');
  }
});

test('cancel during approval closes pending calls using the final core transcript, and late approval cannot mutate', async (t) => {
  const { store } = await fixture(t);
  const entered = deferred(); const approve = deferred();
  const host = await CliHost.create({ store, settings, enableNotes: true,
    approve: async () => { entered.resolve(); return approve.promise; },
    provider: { generate: async () => answer('', [call('pending', 'note_set', { key: 'task', value: 'bad', expectedRevision: 0 })]) },
  });
  const running = host.send('Ask approval');
  await entered.promise;
  host.cancel();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(JSON.parse(result.history[2].content).error.code, 'cancelled');
  assert.deepEqual((await store.load(host.session.id)).history, result.history);
  validateHistory(host.session.history);
  approve.resolve(true); await tick();
  assert.deepEqual(host.session.notes, {});
  assert.deepEqual((await store.load(host.session.id)).notes, {});
});

test('cancel during provider streaming saves user history without inventing a partial assistant message', async (t) => {
  const { store } = await fixture(t); const entered = deferred();
  const host = await CliHost.create({ store, settings, provider: { generate: async (_input, _signal, progress) => {
    await progress.onProgress({ type: 'text_delta', text: 'partial' }); entered.resolve(); return new Promise(() => {});
  } } });
  const running = host.send('Hi'); await entered.promise; host.cancel();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(host.session.history, [{ kind: 'message', role: 'user', content: 'Hi' }]);
  assert.deepEqual((await store.load(host.session.id)).history, result.history);
});

test('cancel races an atomic note commit safely and persists an unknown-outcome closed transcript', async (t) => {
  const { store: real } = await fixture(t); const started = deferred(); const finish = deferred();
  let saves = 0;
  const store = { load: (id) => real.load(id), save: async (session) => {
    if (++saves === 4) { started.resolve(); await finish.promise; }
    await real.save(session);
  } };
  const host = await CliHost.create({ store, settings, enableNotes: true, approve: async () => true,
    provider: { generate: async () => answer('', [call('atomic', 'note_set', { key: 'task', value: 'saved', expectedRevision: 0 })]) },
  });
  const running = host.send('Note'); await started.promise; host.cancel(); finish.resolve();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  const saved = await real.load(host.session.id);
  assert.equal(saved.notes.task, 'saved');
  assert.equal(saved.noteRevision, 1);
  assert.deepEqual(saved.history, result.history);
  assert.equal(JSON.parse(saved.history.at(-1).content).error.code, 'cancelled');
});

test('crash recovery closes persisted pending tools without approving or executing them', async (t) => {
  const { store } = await fixture(t);
  const session = newSession(settings);
  session.history = [{ kind: 'message', role: 'user', content: 'Before crash' },
    { kind: 'assistant', content: '', toolCalls: [call('crashed', 'note_set', { key: 'task', value: 'bad', expectedRevision: 0 })],
      providerState: { provider: 'openai:fake-model', items: [{ opaque: 'retained' }] } }];
  await store.save(session);
  let approvals = 0; let received;
  const resumed = await CliHost.resume({ store, id: session.id, enableNotes: true,
    approve: async () => { approvals++; return true; }, provider: { generate: async ({ messages }) => { received = messages; return answer(); } } });
  assert.equal(JSON.parse(resumed.session.history.at(-1).content).error.code, 'interrupted');
  await resumed.send('Continue');
  assert.equal(approvals, 0);
  assert.deepEqual(resumed.session.notes, {});
  assert.equal(received[1].providerState.items[0].opaque, 'retained');
  validateHistory(received);
});

test('message limit reserves mandatory recovery results while preserving the pending checkpoint', async (t) => {
  const { store, directory } = await fixture(t);
  const session = newSession(settings);
  const messages = (count) => Array.from({ length: count }, () => ({ kind: 'message', role: 'user', content: 'small' }));
  const pending = { kind: 'assistant', content: '', toolCalls: [call('limit-pending', 'calculate', { expression: '1+1' })] };
  session.history = [...messages(MAX_HISTORY_MESSAGES - 2), pending];
  await store.save(session);
  const path = join(directory, `${session.id}.json`);
  const checkpoint = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(checkpoint.history.length, MAX_HISTORY_MESSAGES - 1);
  assert.equal(checkpoint.history.at(-1).kind, 'assistant', 'saving must not mark an unexecuted tool as interrupted');
  const recovered = await store.load(session.id);
  assert.equal(recovered.history.length, MAX_HISTORY_MESSAGES);
  assert.equal(JSON.parse(recovered.history.at(-1).content).error.code, 'interrupted');
  validateHistory(recovered.history);
  await store.save(recovered);
  assert.deepEqual((await store.load(session.id)).history, recovered.history);
  const before = await readFile(path);
  session.history = [...messages(MAX_HISTORY_MESSAGES - 1), pending];
  await assert.rejects(store.save(session), /history limit.*recovery/);
  assert.deepEqual(await readFile(path), before, 'a rejected reservation must leave the last recoverable file intact');
});

test('byte limit reserves exact recovery and trailing-newline room for a load/save roundtrip', async (t) => {
  const { store, directory } = await fixture(t);
  const session = newSession(settings);
  session.history = Array.from({ length: 32 }, () => ({ kind: 'message', role: 'user', content: 'x'.repeat(64000) }));
  const padding = { kind: 'message', role: 'user', content: '' };
  session.history.push(padding, { kind: 'assistant', content: '', toolCalls: [call('bytes-pending', 'calculate', { expression: '1+1' })] });
  const closed = () => ({ ...session, history: closeInterruptedHistory(session.history) });
  const reservedPadding = MAX_SESSION_BYTES - 1 - Buffer.byteLength(JSON.stringify(closed()));
  assert.ok(reservedPadding > 0 && reservedPadding < 65536);
  padding.content = 'p'.repeat(reservedPadding);
  assert.equal(Buffer.byteLength(JSON.stringify(closed())) + 1, MAX_SESSION_BYTES);
  await store.save(session);
  const path = join(directory, `${session.id}.json`);
  assert.ok((await stat(path)).size < MAX_SESSION_BYTES);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).history.at(-1).kind, 'assistant');
  const recovered = await store.load(session.id);
  await store.save(recovered);
  assert.equal((await stat(path)).size, MAX_SESSION_BYTES, 'the physical newline is part of the file limit');
  assert.deepEqual(await store.load(session.id), recovered);
  const before = await readFile(path);
  padding.content += 'p';
  assert.ok(Buffer.byteLength(JSON.stringify(session)) + 1 < MAX_SESSION_BYTES, 'raw pending data still fits');
  await assert.rejects(store.save(session), /size limit.*recovery/);
  assert.deepEqual(await readFile(path), before);
  const completeOverflow = structuredClone(recovered);
  completeOverflow.history.at(-3).content += 'p';
  await assert.rejects(store.save(completeOverflow), /size limit/);
});

test('an unrecoverable assistant checkpoint is rejected before any approval or tool execution', async (t) => {
  const { store } = await fixture(t);
  const session = newSession(settings);
  session.history = Array.from({ length: MAX_HISTORY_MESSAGES - 2 }, () => ({ kind: 'message', role: 'user', content: 'prior' }));
  await store.save(session);
  let approvals = 0; const events = [];
  const host = new CliHost({ store, session, enableNotes: true,
    approve: async () => { approvals++; return true; }, onEvent: (event) => events.push(event.type),
    provider: { generate: async () => answer('', [call('must-not-execute', 'note_set', { key: 'task', value: 'bad', expectedRevision: 0 })]) } });
  await assert.rejects(host.send('The last available user checkpoint'), /history is too large/);
  assert.equal(approvals, 0);
  assert.ok(!events.includes('tool_started'));
  assert.deepEqual(host.session.notes, {});
  const saved = await store.load(session.id);
  assert.equal(saved.history.length, MAX_HISTORY_MESSAGES - 1);
  validateHistory(saved.history);
});

test('reserved recovery bytes include any growth from credential redaction of synthetic results', async (t) => {
  const secret = 'before';
  const { store, directory } = await fixture(t, [secret]);
  const session = newSession(settings);
  session.history = Array.from({ length: 32 }, () => ({ kind: 'message', role: 'user', content: 'x'.repeat(64000) }));
  const padding = { kind: 'message', role: 'user', content: '' };
  session.history.push(padding, { kind: 'assistant', content: '', toolCalls: [call('redaction-pending', 'calculate', { expression: '1+1' })] });
  const preview = () => redactSecrets(JSON.stringify({ ...session, history: closeInterruptedHistory(session.history) }), [secret]);
  padding.content = 'p'.repeat(MAX_SESSION_BYTES - 1 - Buffer.byteLength(preview()));
  await store.save(session);
  const recovered = await store.load(session.id);
  await store.save(recovered);
  const path = join(directory, `${session.id}.json`);
  assert.equal((await stat(path)).size, MAX_SESSION_BYTES);
  assert.ok(!(await readFile(path, 'utf8')).includes(secret));
  padding.content += 'p';
  await assert.rejects(store.save(session), /size limit.*recovery/);
});

test('credentials are never stored in session/native state and credential-bearing user input is refused', async (t) => {
  const secret = 'vivi-secret-abc123'; const { store, directory } = await fixture(t, [secret]);
  let calls = 0;
  const host = await CliHost.create({ store, settings, secrets: [secret], provider: { generate: async () => {
    calls++; return answer(secret, [], { providerState: { provider: 'openai:fake-model', items: [{ leaked: secret }] } });
  } } });
  await assert.rejects(host.send(`Please use ${secret}`), /environment credential/);
  assert.equal(calls, 0);
  await host.send('Normal prompt');
  const bytes = await readFile(join(directory, `${host.session.id}.json`), 'utf8');
  assert.ok(!bytes.includes(secret)); assert.ok(bytes.includes('[REDACTED]'));
  assert.ok(!bytes.includes('apiKey'));
  assert.deepEqual(environmentSecrets({ OPENAI_API_KEY: secret, NAME: 'ordinary', APP_SECRET: 'second' }), [secret, 'second']);
});

test('malformed or overbounded session input is rejected without provider calls', async (t) => {
  const { directory, store } = await fixture(t); const valid = newSession(settings);
  const invalid = [null, [], {}, { ...valid, schemaVersion: 2 }, { ...valid, id: '../bad' },
    { ...valid, apiKey: 'must-not-accept' }, { ...valid, usage: { ...usage, totalTokens: -1 } },
    { ...valid, notes: { bad: 'x'.repeat(4097) } },
    { ...valid, history: [{ kind: 'tool_result', callId: 'orphan', name: 'calculate', content: 'bad' }] },
    { ...valid, history: [{ kind: 'assistant', content: '', toolCalls: [call('dup', 'calculate'), call('dup', 'calculate')] }] },
    { ...valid, history: [{ kind: 'assistant', content: '', toolCalls: [], providerState: { provider: '', items: [] } }] },
  ];
  for (const input of invalid) assert.throws(() => validateSession(input));
  await writeFile(join(directory, `${valid.id}.json`), '{broken', { mode: 0o600 });
  await assert.rejects(store.load(valid.id), /valid JSON/);
  await writeFile(join(directory, `${valid.id}.json`), 'x'.repeat(MAX_SESSION_BYTES + 1));
  await assert.rejects(store.load(valid.id), /size limit/);
  await assert.rejects(store.load('../escape'), /session id/);
  let getterReads = 0;
  const getter = Object.defineProperty({}, 'content', { enumerable: true, get() { getterReads++; return 'unsafe'; } });
  const cyclic = {}; cyclic.self = cyclic;
  for (const malformed of [{ ...valid, history: [getter] }, { ...valid, notes: cyclic },
    { ...valid, history: [new Date()] }, { ...valid, history: [1, , 3] }]) assert.throws(() => validateSession(malformed));
  assert.equal(getterReads, 0);
});

test('private atomic persistence rejects symlinks and public file/directory modes', async (t) => {
  const { directory, store } = await fixture(t); const session = newSession(settings);
  await store.save(session);
  const target = join(directory, `${session.id}.json`);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.ok(!(await readdir(directory)).some((name) => name.endsWith('.tmp')));
  await chmod(target, 0o644); await assert.rejects(store.load(session.id), /private regular/);
  await rm(target); await symlink(join(directory, 'missing'), target);
  await assert.rejects(store.load(session.id), /private regular/);
  await assert.rejects(store.save(session), /nonregular/);
  await rm(target); await chmod(directory, 0o755);
  await assert.rejects(store.save(session), /0700/);
});

test('session lease prevents simultaneous CLI writers and releases cleanly', async (t) => {
  const { store } = await fixture(t); const session = newSession(settings);
  const release = await store.acquire(session.id);
  await assert.rejects(store.acquire(session.id), /locked/);
  await release(); await release();
  await (await store.acquire(session.id))();
});

test('OS SIGINT with piped stdin cancels through the shared core and reconciles the saved session', async (t) => {
  const { directory } = await fixture(t);
  const hostURL = new URL('../dist/host.js', import.meta.url).href;
  const sessionURL = new URL('../dist/session.js', import.meta.url).href;
  const terminalURL = new URL('../dist/terminal.js', import.meta.url).href;
  const source = `
    import { CliHost } from ${JSON.stringify(hostURL)};
    import { FileSessionStore } from ${JSON.stringify(sessionURL)};
    import { TerminalIO, runChatLoop } from ${JSON.stringify(terminalURL)};
    const io = new TerminalIO({ tui: false });
    let id;
    const host = await CliHost.create({ store: new FileSessionStore(${JSON.stringify(directory)}),
      settings: { provider: 'openai', model: 'fake' }, onEvent: (event) => io.event(event),
      provider: { generate: async () => {
        process.stderr.write('READY ' + id + '\\n');
        return new Promise(() => {});
      } } });
    id = host.session.id;
    const result = await runChatLoop(host, io, 'hold');
    io.close(); process.exitCode = result.status === 'cancelled' ? 130 : 1;
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = ''; let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  const ready = new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); if (/READY [a-f0-9-]{36}\n/.test(stderr)) resolve(); });
    child.once('error', reject);
    child.once('exit', () => { if (!/READY [a-f0-9-]{36}\n/.test(stderr)) reject(new Error(stderr || 'CLI child exited before ready')); });
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  await ready;
  const id = stderr.match(/READY ([a-f0-9-]+)/)[1];
  child.kill('SIGINT');
  const outcome = await exited;
  assert.equal(outcome.signal, null);
  assert.equal(outcome.code, 130);
  assert.match(output, /cancelled/);
  const saved = await new FileSessionStore(directory).load(id);
  validateHistory(saved.history);
  assert.equal(saved.history.length, 1);
});

test('CLI argument selection rejects credential flags, unknown arguments, invalid reasoning and resume overrides', () => {
  const parsed = parseArguments(['--provider', 'openrouter', '--model', 'fake', '--reasoning', 'high', '--reasoning-capabilities', 'none,high', '--no-stream', '--enable-notes'], {});
  assert.equal(parsed.provider, 'openrouter'); assert.equal(parsed.stream, false); assert.equal(parsed.enableNotes, true);
  assert.equal(parsed.reasoning, 'high');
  assert.equal(parseArguments(['--model', 'fake', '--reasoning', 'disabled', '--reasoning-capabilities', 'none'], {}).reasoning, 'none');
  for (const args of [['--api-key', 'abc'], ['--model'], ['--model', 'x', '--reasoning', 'high'],
    ['--model', 'x', '--max-rounds', '101'], ['--resume', '../file'], ['--model', 'x', '--wat'],
    ['--resume', newSession(settings).id, '--model', 'other']]) assert.throws(() => parseArguments(args, {}));
  assert.throws(() => parseArguments(['--model', 'fake', '--prompt', 'my-token'], { OPENAI_API_KEY: 'my-token' }), /credentials/);
  assert.throws(() => providerForSession(newSession(settings), parseArguments(['--model', 'fake'], {}), {}), /OPENAI_API_KEY/);
});

test('testable main creates/resumes local sessions without import-time work or model calls', async (t) => {
  const { directory } = await fixture(t); const firstIO = fakeIO(); let factories = 0;
  const providerFactory = (session) => { factories++; assert.equal(session.model, 'fake-model'); return { generate: async () => answer('CLI answer') }; };
  assert.equal(await main(['--model', 'fake-model', '--session-dir', directory, '--prompt', 'hello'], {}, { io: firstIO, providerFactory }), 0);
  assert.equal(firstIO.results[0].content, 'CLI answer'); assert.equal(firstIO.closed, true);
  const id = firstIO.output.match(/Session: ([a-f0-9-]+)/)[1];
  const secondIO = fakeIO();
  assert.equal(await main(['--resume', id, '--session-dir', directory, '--prompt', 'continue'], {}, { io: secondIO, providerFactory }), 0);
  const saved = await new FileSessionStore(directory).load(id);
  assert.equal(saved.history.length, 4); assert.equal(factories, 2);
  assert.ok(!(await readdir(directory)).some((name) => name.endsWith('.lock')));
});

test('one-shot main returns distinct failure and cancellation exit statuses', async (t) => {
  const { directory } = await fixture(t);
  const errorIO = fakeIO();
  assert.equal(await main(['--model', 'fake', '--session-dir', directory, '--prompt', 'hi'], {}, {
    io: errorIO, providerFactory: () => ({ generate: async () => { throw new Error('offline failure'); } }),
  }), 1);
  assert.equal(errorIO.results[0].status, 'error');
  const cancelIO = fakeIO(); const entered = deferred();
  const running = main(['--model', 'fake', '--session-dir', directory, '--prompt', 'hi'], {}, {
    io: cancelIO, providerFactory: () => ({ generate: async () => { entered.resolve(); return new Promise(() => {}); } }),
  });
  await entered.promise; cancelIO.cancel();
  assert.equal(await running, 130);
  assert.equal(cancelIO.results[0].status, 'cancelled');
  assert.ok(!(await readdir(directory)).some((name) => name.endsWith('.lock')));
});

test('custom session stores also recover pending tools without executing them', async () => {
  const session = newSession(settings);
  session.history = [{ kind: 'assistant', content: '', toolCalls: [call('pending-custom', 'note_set', {
    key: 'task', value: 'bad', expectedRevision: 0,
  })] }];
  let saved;
  const store = { load: async () => structuredClone(session), save: async (value) => { saved = structuredClone(value); } };
  const host = await CliHost.resume({ store, id: session.id, provider: { generate: async () => answer() }, enableNotes: true });
  assert.equal(JSON.parse(saved.history[1].content).error.code, 'interrupted');
  assert.deepEqual(host.session.notes, {});
  validateHistory(saved.history);
});

test('headless chat loop handles session/exit commands, approval denial and cancellation callback', async (t) => {
  const { store } = await fixture(t); let calls = 0;
  const host = await CliHost.create({ store, settings, provider: { generate: async () => { calls++; return answer('Hi'); } } });
  const io = fakeIO(['/session', 'hello', '/exit']);
  await runChatLoop(host, io);
  assert.match(io.output, new RegExp(host.session.id)); assert.equal(calls, 1); assert.equal(io.results.length, 1);
  const entered = deferred();
  const cancelHost = await CliHost.create({ store, settings, provider: { generate: async () => { entered.resolve(); return new Promise(() => {}); } } });
  const cancelIO = fakeIO(); const running = runChatLoop(cancelHost, cancelIO, 'Cancel me');
  await entered.promise; cancelIO.cancel(); await running;
  assert.equal(cancelIO.results[0].status, 'cancelled');
});

test('stream renderer is bounded, strips terminal controls and redacts split credentials', async () => {
  const input = new PassThrough(); const output = new PassThrough(); let displayed = '';
  output.on('data', (chunk) => { displayed += chunk.toString(); });
  const io = new TerminalIO({ input, output, stream: true, secrets: ['secret-token'] });
  io.event({ type: 'text_delta', text: 'safe sec' });
  io.event({ type: 'text_delta', text: 'ret-token text' });
  io.event({ type: 'assistant', message: { kind: 'assistant', content: 'safe secret-token text', toolCalls: [] } });
  io.write('\x1b[2J bad');
  io.event({ type: 'text_delta', text: 'x'.repeat(100000) });
  io.result({ status: 'cancelled', content: '', rounds: 0, history: [], usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
  assert.ok(!displayed.includes('secret-token')); assert.ok(displayed.includes('[REDACTED]'));
  assert.ok(!displayed.includes('\x1b')); assert.ok(displayed.length < 65536);
  assert.equal(await io.approve({ description: 'Set note', currentRevision: 0, call: call('n', 'note_set') }, new AbortController().signal), false);
  io.close(); input.destroy(); output.destroy();
});

test('TTY Ctrl-C and Escape call cancellation and interactive prompts require exact allow or deny', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  input.isTTY = true; input.setRawMode = () => {}; output.isTTY = true; output.columns = 80; output.rows = 24;
  const io = new TerminalIO({ input, output, tui: true });
  let cancels = 0; const dispose = io.onCancel(() => { cancels++; });
  input.write('\x03'); await tick();
  input.write('\x1b');
  // readline's escape decoder uses a small timeout to disambiguate escape sequences.
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(cancels, 2);
  const approval = io.approve({ description: 'Set this exact note', currentRevision: 1, call: call('n', 'note_set') }, new AbortController().signal);
  input.write('yes\n'); await tick(); input.write('allow\n');
  assert.equal(await approval, true);
  const denial = io.approve({ description: 'Set this other note', currentRevision: 2, call: call('m', 'note_set') }, new AbortController().signal);
  input.write('deny\n'); assert.equal(await denial, false);
  dispose();
  const controller = new AbortController();
  const disposeAbort = io.onCancel(() => controller.abort());
  const cancelled = io.approve({ description: 'Cancelled note', currentRevision: 2, call: call('cancel', 'note_set') }, controller.signal);
  const rejected = assert.rejects(cancelled, /cancelled/);
  input.write('all'); input.write('\x03');
  await rejected;
  disposeAbort();
  const afterCancel = io.approve({ description: 'Fresh note', currentRevision: 2, call: call('fresh', 'note_set') }, new AbortController().signal);
  input.write('deny\n');
  assert.equal(await afterCancel, false, 'partial approval input must not survive cancellation');
  io.close(); input.destroy(); output.destroy();
});

test('approval boundary discards a half-typed allow from before the displayed request', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  input.isTTY = true; input.setRawMode = () => {}; output.isTTY = true; output.columns = 80; output.rows = 24;
  const io = new TerminalIO({ input, output, tui: true });
  try {
    input.write('allow');
    let settled = false;
    const approval = io.approve({ description: 'Fresh request after old input', currentRevision: 0,
      call: call('fresh-boundary', 'note_set') }, new AbortController().signal).then((decision) => {
      settled = true; return decision;
    });
    input.write('\n');
    await tick();
    assert.equal(settled, false, 'Enter must not submit the allow typed before the request');
    input.write('deny\n');
    assert.equal(await approval, false);
  } finally { io.close(); input.destroy(); output.destroy(); }
});

test('nonstreaming renderer emits accepted content only and cleans up its SIGINT listener', () => {
  const before = process.listenerCount('SIGINT');
  const input = new PassThrough(); const output = new PassThrough(); let displayed = '';
  output.on('data', (chunk) => { displayed += chunk.toString(); });
  const io = new TerminalIO({ input, output, stream: false, secrets: ['test-credential'] });
  assert.equal(process.listenerCount('SIGINT'), before + 1);
  io.event({ type: 'text_delta', text: 'provisional test-credential' });
  assert.equal(displayed, '');
  io.event({ type: 'assistant', message: { kind: 'assistant', content: 'accepted test-credential', toolCalls: [] } });
  assert.equal(displayed, 'accepted [REDACTED]\n');
  io.close(); io.close();
  assert.equal(process.listenerCount('SIGINT'), before);
  input.destroy(); output.destroy();
});
