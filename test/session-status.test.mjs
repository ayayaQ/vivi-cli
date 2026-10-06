// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs, { mkdtemp, readFile, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliHost } from '../dist/host.js'
import { FileSessionStore, newSession, SessionCommitError, validateSession } from '../dist/session.js'
import { listSessions } from '../dist/preferences.js'
import { formatSessionDate, normalizeSessionTitle, sessionDisplayTitle, sessionTitleFromPrompt,
  validSessionTitle } from '../dist/session-display.js'
import { RunStatus, formatRunElapsed } from '../dist/run-status.js'
import { runChatLoop, sendChatTurn } from '../dist/terminal.js'
import { main } from '../dist/main.js'
const settings = { provider: 'openai', model: 'fixture' }
const answer = { content: 'Done', toolCalls: [] }
const provider = { async generate() { return answer } }
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-session-status-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, store: new FileSessionStore(directory) }
}
function clock() {
  let now = 0, next = 0
  const timers = new Map()
  return { timers, now: () => now, every(callback, milliseconds) { assert.equal(milliseconds, 100); const id = next++; timers.set(id, callback); return id },
    clear(id) { timers.delete(id) }, advance(ms) { now += ms; for (const callback of timers.values()) callback() } }
}
function io(lines = [], texts = []) {
  return { output: '', states: [], sessions: [], names: [], choices: [], results: [], closed: false,
    get isClosed() { return this.closed }, readLine: async () => lines.shift(),
    async askText(title, initial) { this.names.push({ title, initial }); return texts.shift() },
    async choose(title, values) { this.choices.push({ title, values }); return undefined }, async chooseSearchable() {},
    setSession(session) { this.sessions.push(session) }, setDraft() {}, setWorkspace() {},
    write(text) { this.output += text }, event() {}, result(result) { this.results.push(result) }, approve: async () => false,
    runStarted() { this.states.push('working') }, runFinished(outcome) { this.states.push(outcome) },
    onCancel(callback) { this.cancel = callback; return () => { this.cancel = undefined } }, close() { this.closed = true } }
}
const services = { credentials: { status: async () => ({ available: false, label: 'Fixture' }), load: async () => undefined },
  catalog: { async list() { throw new Error('No catalog request expected') } } }

test('titles normalize readable Unicode, remove controls and truncate on grapheme boundaries', () => {
  assert.equal(sessionTitleFromPrompt('  Fix\r\n the\tlogin 日本語 👩🏽‍💻 bug  '), 'Fix the login 日本語 👩🏽‍💻 bug')
  assert.equal(sessionTitleFromPrompt('\x1b[31mRed\x1b[0m\u202e text\x1b]2;unsafe-title\x07'), 'Red text')
  assert.equal(normalizeSessionTitle('Cafe\u0301'), 'Café')
  assert.equal(normalizeSessionTitle('Alpha\u2060\u206a\u00adBeta'), 'AlphaBeta')
  const flag = 'England \u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}'
  assert.equal(normalizeSessionTitle(flag), flag); assert.equal(sessionTitleFromPrompt(flag), flag)
  assert.equal(validateSession({ ...newSession(settings), title: flag, titleRevision: 1 }).title, flag)
  assert.equal(sessionTitleFromPrompt('\x00\u202e\t\n'), undefined)
  for (const invisible of ['\u200d', '\u2060', '\ufe0f', '\u034f', '\u200c', '\u2800', '\u3164']) {
    assert.equal(validSessionTitle(invisible), false); assert.equal(sessionTitleFromPrompt(invisible), undefined)
  }
  const emoji = '👩🏽‍💻'.repeat(100), title = sessionTitleFromPrompt(emoji)
  assert(validSessionTitle(title)); assert(title.endsWith('…')); assert(title.length <= 240)
  assert.equal(title.slice(0, -1), '👩🏽‍💻'.repeat((title.length - 1) / '👩🏽‍💻'.length))
  assert.equal(sessionTitleFromPrompt('x'.repeat(100)), `${'x'.repeat(79)}…`)
  assert(validSessionTitle(normalizeSessionTitle('a\ud800b')))
  assert.equal(sessionDisplayTitle({ history: [] }), 'Untitled conversation')
})

test('schema-1 title metadata is optional, bounded and revision-validated', () => {
  const legacy = newSession(settings)
  assert.deepEqual(validateSession(legacy), legacy)
  assert.equal(validateSession({ ...legacy, title: 'Readable 日本語', titleRevision: 1 }).title, 'Readable 日本語')
  for (const extras of [{ title: '' }, { title: ' padded' }, { title: 'x'.repeat(81) }, { title: 'control\x1b' },
    { title: 'bidi\u202e' }, { title: '\ud800' }, { titleRevision: 0 }, { title: 'Name', titleRevision: -1 },
    { title: 'Name', titleRevision: 1.1 }, { title: 'Name', titleRevision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => validateSession({ ...legacy, ...extras }), /Invalid session/)
  }
})

test('first accepted prompt names once, with no extra provider request, through later turns and resume', async t => {
  const { store } = await fixture(t)
  let calls = 0
  const counted = { async generate() { calls++; return answer } }
  const host = await CliHost.create({ store, settings, provider: counted })
  await host.send('  Fix\nlogin 日本語  ')
  assert.equal(calls, 1); assert.equal(host.session.title, 'Fix login 日本語'); assert.equal(host.session.titleRevision, 1)
  await host.send('Different subject')
  const resumed = await CliHost.resume({ id: host.session.id, store, provider: counted })
  await resumed.send('A third subject')
  assert.equal(resumed.session.title, 'Fix login 日本語'); assert.equal(calls, 3)
  await resumed.renameSession('Manual title 👩🏽‍💻', 1)
  await resumed.send('Fourth subject')
  assert.equal((await store.load(host.session.id)).title, 'Manual title 👩🏽‍💻')
  assert.equal(resumed.session.titleRevision, 2)
})

test('explicit naming before first prompt survives automatic naming and unrelated notes/usage/history', async t => {
  const { store } = await fixture(t), host = await CliHost.create({ store, settings, provider })
  const before = host.session
  await host.renameSession('My project', 0)
  assert.deepEqual(host.session.history, before.history); assert.deepEqual(host.session.notes, before.notes)
  assert.deepEqual(host.session.usage, before.usage); assert.equal(host.session.noteRevision, before.noteRevision)
  await host.send('Different prompt')
  assert.equal(host.session.title, 'My project'); assert.equal(host.session.titleRevision, 1)
})

test('legacy titles are view-only in picker and are never overwritten by later runs', async t => {
  const { directory, store } = await fixture(t), legacy = newSession(settings)
  legacy.history = [{ kind: 'message', role: 'user', content: 'Original legacy prompt' }, { kind: 'assistant', content: 'Old answer', toolCalls: [] }]
  await store.save(legacy)
  const path = join(directory, `${legacy.id}.json`), before = await readFile(path, 'utf8')
  assert.equal((await listSessions(store))[0].title, 'Original legacy prompt')
  assert.equal(await readFile(path, 'utf8'), before)
  const host = await CliHost.resume({ id: legacy.id, store, provider })
  await host.send('New subject')
  assert.equal(host.session.title, undefined); assert.equal(sessionDisplayTitle(host.session), 'Original legacy prompt')
})

test('stale concurrent renames, invalid names and credential input cannot corrupt current or saved session', async () => {
  const saved = newSession(settings), snapshots = []
  const store = { load: async () => structuredClone(snapshots.at(-1) ?? saved), save: async value => { snapshots.push(structuredClone(value)) } }
  const host = new CliHost({ store, session: saved, provider, secrets: ['fixture-credential'] })
  const first = host.renameSession('First', 0), stale = host.renameSession('Second', 0)
  await first; await assert.rejects(stale, /name changed/)
  assert.equal(host.session.title, 'First'); assert.equal(snapshots.length, 1)
  for (const name of ['\n\t', 'x'.repeat(81), 'Use fixture-credential']) await assert.rejects(host.renameSession(name, 1))
  assert.equal(host.session.title, 'First'); assert.equal(snapshots.length, 1)
})

test('failed initial prompt/name persistence rolls back; rename failures retain the last successful title', async () => {
  const saved = newSession(settings)
  let fail = true, calls = 0
  const store = { load: async () => structuredClone(saved), async save(value) { if (fail) throw new Error('Fixture persistence unavailable'); Object.assign(saved, structuredClone(value)) } }
  const host = new CliHost({ store, session: saved, provider: { async generate() { calls++; return answer } } })
  await assert.rejects(host.send('First failed prompt'), /persistence unavailable/)
  assert.equal(host.session.title, undefined); assert.equal(host.session.history.length, 0); assert.equal(calls, 0)
  fail = false; await host.send('Accepted retry'); assert.equal(host.session.title, 'Accepted retry')
  const before = host.session
  fail = true; await assert.rejects(host.renameSession('Failed rename', 1), /persistence unavailable/)
  assert.deepEqual(host.session, before)
})

test('renaming is unavailable during a running turn; cancelled/error accepted prompts retain their names', async t => {
  const { store } = await fixture(t)
  let entered
  const waiting = new Promise(resolve => { entered = resolve })
  const host = await CliHost.create({ store, settings, provider: { async generate(_input, signal) {
    entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled fixture')), { once: true }))
  } } })
  const turn = host.send('Cancel this named turn'); await waiting
  await assert.rejects(host.renameSession('Too soon', 1), /current turn/)
  host.cancel(); assert.equal((await turn).status, 'cancelled'); assert.equal(host.session.title, 'Cancel this named turn')
  const failed = await CliHost.create({ store, settings, provider: { async generate() { throw new Error('Provider fixture error') } } })
  assert.equal((await failed.send('Provider failed turn')).status, 'error'); assert.equal(failed.session.title, 'Provider failed turn')
})

test('friendly dates use locale and local calendar days across midnight, DST and years without changing timestamps', () => {
  const options = { locales: 'en-US', timeZone: 'America/Los_Angeles', now: new Date('2026-10-06T10:58:00Z') }
  assert.equal(formatSessionDate('2026-10-06T10:58:00Z', options), 'Today 3:58 AM')
  assert.equal(formatSessionDate('2026-10-05T10:58:00Z', options), 'Yesterday 3:58 AM')
  assert.equal(formatSessionDate('2026-10-04T10:58:00Z', options), 'Oct 4 3:58 AM')
  assert.match(formatSessionDate('2025-10-04T10:58:00Z', options), /Oct 4, 2025/)
  assert.match(formatSessionDate('2026-11-01T07:15:00Z', { ...options, now: new Date('2026-11-02T08:30:00Z') }), /^Yesterday/)
  assert.match(formatSessionDate('2026-03-08T08:15:00Z', { ...options, now: new Date('2026-03-09T07:30:00Z') }), /^Yesterday/)
  assert.match(formatSessionDate('2026-10-06T06:59:00Z', { ...options, now: new Date('2026-10-06T07:01:00Z') }), /^Yesterday/)
  assert.match(formatSessionDate('2025-12-31T23:59:00Z', { locales: 'en-US', timeZone: 'UTC', now: new Date('2026-01-01T00:01:00Z') }), /^Yesterday/)
  assert.match(formatSessionDate('2026-10-06T10:58:00Z', { ...options, locales: 'fr-FR' }), /^Aujourd.hui 3:58$/)
  assert.equal(formatSessionDate('2026-10-06T10:58:00Z', { ...options, locales: 'en-GB' }), 'Today 3:58')
  assert.equal(formatSessionDate('invalid\x1bdate', options), 'Unknown date')
  assert.equal(formatSessionDate('2026-10-06T10:58:00Z', { ...options, timeZone: 'Invalid/Zone' }), 'Unknown date')
})

test('run indicator is monotonic, distinguishes waits, counts total elapsed time and cleans up every terminal lifecycle', () => {
  const fake = clock(); let updates = 0
  const run = new RunStatus(() => { updates++ }, fake)
  assert.equal(run.label, undefined); assert.equal(fake.timers.size, 0)
  for (const outcome of ['completed', 'cancelled', 'error']) {
    run.start(); assert.equal(fake.timers.size, 1); assert.match(run.label, /Working · 0s/)
    fake.advance(1250); assert.match(run.label, /Working · 1s/)
    run.setPhase('waiting_approval'); fake.advance(2000)
    assert.equal(run.label, 'Waiting for approval · 3s')
    run.setPhase('working'); assert.match(run.label, /Working · 3s/)
    run.setPhase('cancelling'); assert.equal(run.label, 'Cancelling · 3s')
    run.finish(outcome); assert.equal(fake.timers.size, 0)
    const finished = run.label, stoppedUpdates = updates
    fake.advance(5000); assert.equal(run.label, finished); assert.equal(updates, stoppedUpdates)
    run.reset(); assert.equal(run.label, undefined)
  }
  run.start(); run.start(); assert.equal(fake.timers.size, 1)
  run.reset(); assert.equal(fake.timers.size, 0)
  assert.equal(formatRunElapsed(59999), '59s'); assert.equal(formatRunElapsed(61000), '1m 1s')
  assert.equal(formatRunElapsed(3661000), '1h 1m 1s'); assert.equal(formatRunElapsed(-1000), '0s')
})

test('explicit run boundaries clean up completed, cancelled and thrown sends in chat and one-shot paths', async () => {
  for (const status of ['completed', 'cancelled', 'error']) {
    const display = io(), host = { send: async () => ({ status }) }
    assert.equal((await sendChatTurn(host, display, 'Prompt')).status, status)
    assert.deepEqual(display.states, ['working', status])
  }
  const thrown = io()
  await assert.rejects(sendChatTurn({ send: async () => { throw new Error('Checkpoint failure') } }, thrown, 'Prompt'))
  assert.deepEqual(thrown.states, ['working', 'error'])
  const failedStart = io(); failedStart.runStarted = () => { throw new Error('Fixture visual startup error') }
  await assert.rejects(sendChatTurn({ send: async () => ({ status: 'completed' }) }, failedStart, 'Prompt'), /visual startup error/)
  assert.deepEqual(failedStart.states, ['error'])
  const oneShot = io()
  await runChatLoop({ memoryEnabled: false, cancel() {}, send: async () => ({ status: 'completed' }) }, oneShot, 'Prompt')
  assert.deepEqual(oneShot.states, ['working', 'completed'])
})

test('interactive rename modal can cancel and rename, survives later prompts, and picker dates are friendly', async t => {
  const { directory, store } = await fixture(t)
  const legacy = newSession(settings); legacy.updatedAt = new Date().toISOString()
  legacy.history = [{ kind: 'message', role: 'user', content: 'Find this legacy conversation' }]
  await store.save(legacy)
  const display = io(['/rename', '/rename', 'First prompt', '/rename Inline name', 'Later prompt', '/resume', '/session', '/exit'], [undefined, 'Named before prompt'])
  assert.equal(await main(['--no-workspace', '--model', 'fixture'], { VIVI_SESSION_DIR: directory }, { tuiIO: display, ...services, providerFactory: () => provider }), 0)
  assert.equal(display.names.length, 2)
  assert.equal(display.sessions.at(-1).title, 'Inline name')
  assert.equal(display.sessions.at(-1).titleRevision, 2)
  assert.deepEqual(display.states, ['working', 'completed', 'working', 'completed'])
  const picker = display.choices.find(value => value.title === 'Resume a local session')
  assert.equal(picker.values.find(value => value.value === legacy.id).name, 'Find this legacy conversation')
  assert.match(picker.values.find(value => value.value === legacy.id).description, /^Today /)
  assert(!picker.values.find(value => value.value === legacy.id).description.includes(legacy.updatedAt))
  assert.match(display.output, /Name: Inline name/)
})

test('line rename command stays out of provider history and missing names are visible', async t => {
  const { store } = await fixture(t), host = await CliHost.create({ store, settings, provider })
  const display = io(['/rename', '/rename Line name', 'Hello', '/session', '/exit'])
  await runChatLoop(host, display)
  assert.equal(host.session.title, 'Line name'); assert.equal(host.session.titleRevision, 1)
  assert.deepEqual(host.session.history.filter(message => message.kind === 'message').map(message => message.content), ['Hello'])
  assert.match(display.output, /Use \/rename NAME/); assert.match(display.output, /Name: Line name/)
})

test('an already admitted rename settles before a concurrent turn accepts its prompt', async () => {
  let entered, release
  const started = new Promise(resolve => { entered = resolve }), blocked = new Promise(resolve => { release = resolve })
  const initial = newSession(settings), snapshots = [], seen = []
  const store = { load: async () => structuredClone(snapshots.at(-1) ?? initial), async save(value) {
    if (value.title === 'Renamed first' && value.history.length === 0) { entered(); await blocked }
    snapshots.push(structuredClone(value))
  } }
  const host = new CliHost({ store, session: initial, provider: { async generate({ messages }) { seen.push(messages); return answer } } })
  const naming = host.renameSession('Renamed first', 0); await started
  const sending = host.send('Accepted user prompt')
  await new Promise(resolve => setImmediate(resolve)); assert.equal(seen.length, 0)
  release(); await naming; assert.equal((await sending).status, 'completed')
  assert.equal(host.session.title, 'Renamed first')
  assert.equal(seen[0][0].content, 'Accepted user prompt')
  assert.equal(snapshots.at(-1).history[0].content, 'Accepted user prompt')
})


for (const action of ['rename', 'first prompt']) {
  test(`${action} post-rename directory sync failure preserves committed metadata and shows durability uncertainty`, { skip: process.platform === 'win32' }, async t => {
    const { store } = await fixture(t)
    let calls = 0
    const host = await CliHost.create({ store, settings, provider: { async generate() { calls++; return answer } } })
    const original = fs.open
    t.mock.method(fs, 'open', async (path, ...args) => {
      const handle = await original(path, ...args)
      return path === store.directory ? { sync: async () => { throw new Error('Fixture directory sync failure') }, close: () => handle.close() } : handle
    })
    syncBuiltinESMExports()
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
    await assert.rejects(action === 'rename' ? host.renameSession('Committed name', 0) : host.send('Committed first prompt'),
      error => error instanceof SessionCommitError && /saved.*not be confirmed/.test(error.message))
    const persisted = await store.load(host.session.id)
    assert.equal(host.session.title, action === 'rename' ? 'Committed name' : 'Committed first prompt')
    assert.equal(host.session.titleRevision, 1)
    assert.deepEqual(host.session, persisted)
    await assert.rejects(host.renameSession('Stale retry', 0), /name changed/)
    assert.equal(calls, 0)
    t.mock.restoreAll(); syncBuiltinESMExports()
    await host.send('Continue after warning')
    assert.equal(host.session.title, action === 'rename' ? 'Committed name' : 'Committed first prompt')
    assert.equal(host.session.history[0].content, action === 'rename' ? 'Continue after warning' : 'Committed first prompt')
  })
}
