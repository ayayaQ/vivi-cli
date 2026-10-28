// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../dist/main.js'
import { DEFAULT_PREFERENCES, PreferenceStore } from '../dist/preferences.js'

async function fixture(t, { surface = 'tui', lines = [], choices = [], texts = [], thresholds = { openai: 950, openrouter: 990 }, probability = 0.92, invalid = false, interactive = true, prompt } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-auto-threshold-app-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const preferences = new PreferenceStore(directory)
  await preferences.save({ ...DEFAULT_PREFERENCES, provider: 'openai', model: 'gpt-5.1', enableTools: true, autoReviewThresholds: thresholds })
  if (invalid) await writeFile(join(directory, 'preferences.json'), '{invalid', { mode: 0o600 })
  const reviews = [], notices = [], approvals = [], modes = [], sessions = []
  let round = 0
  const io = { output: '', closed: false, canAutoReview: interactive,
    get isClosed() { return this.closed },
    async choose(title, values) { const value = choices.shift(); assert(value === undefined || values.some(row => row.value === value), `${value} absent in ${title}`); return value },
    async chooseSearchable() { return undefined }, async askText() { return texts.shift() }, async askSecret() { return undefined },
    async readLine() { return lines.shift() },
    async approve(request) { approvals.push(request); return request.call.name === 'enroll_auto_review' },
    reviewNotice(message, context) { notices.push({ message, context }); this.output += message + '\n' },
    setSession(session) { sessions.push(session) }, setApprovalMode(mode) { modes.push(mode) }, setContext() {}, setTaskMode() {},
    write(text) { this.output += text }, event() {}, result() {}, addSecrets() {}, onCancel() { return () => {} }, close() { this.closed = true }
  }
  const args = ['--session-dir', directory, '--no-workspace', '--no-skills', '--provider', 'openai', '--model', 'gpt-5.1',
    ...(surface === 'line' ? ['--no-tui'] : []), ...(prompt === undefined ? [] : ['--prompt', prompt])]
  const run = () => main(args, { OPENAI_API_KEY: 'offline-fixture-key' }, {
    ...(surface === 'line' ? { io } : { tuiIO: io }),
    credentials: { async status() { return { available: false, label: 'offline' } }, async load() {} },
    catalog: { async list() { return { state: 'fresh', models: [] } } },
    providerFactory() { return { async generate() { round++;
      return round % 2 ? { content: '', toolCalls: [{ id: `note-${round}`, name: 'note_set', arguments: { key: 'tone', value: 'clear', expectedRevision: round === 1 ? 0 : 1 } }] }
        : { content: 'Done', toolCalls: [] }
    } } },
    decisionProviderFactory(session) { return { id: session.provider, model: session.provider === 'openai' ? 'gpt-6-luna' : 'typesafe/jev-1.13',
      async evaluate(request) { reviews.push(request); return { model: this.model, answers: request.policy.checks.map(check => ({ name: check.name, type: 'predicate', probability })), usage: { inputTokens: 1, outputTokens: 1 } } }
    } }
  })
  return { directory, preferences, io, reviews, notices, approvals, modes, sessions, run, get chatCalls() { return round } }
}

for (const surface of ['tui', 'line']) test(`${surface} saves selected reviewer threshold, reenrolls, and restores conservative default without touching other reviewer`, async t => {
  const f = await fixture(t, { surface, lines: ['/auto-threshold 90', '/mode', 'Set a note named tone to clear', '/auto-threshold default', '/mode', 'Set the note named tone to clear', '/exit'], choices: ['auto', 'auto'] })
  assert.equal(await f.run(), 0)
  assert.deepEqual(f.reviews.map(request => request.policy.checks[0].allowAt), [0.9, 0.995])
  assert.equal(f.approvals.filter(request => request.call.name === 'enroll_auto_review').length, 2)
  assert.deepEqual(f.approvals.filter(request => request.call.name === 'enroll_auto_review').map(request => request.call.arguments.thresholds.allowAt), [0.9, 0.995])
  assert.deepEqual((await f.preferences.load()).autoReviewThresholds, { openrouter: 990 })
  assert.equal((await f.preferences.load()).approvalMode, undefined)
  assert.equal(f.notices.filter(row => row.context?.evaluation?.kind === 'model').at(-1).context.evaluation.allowAt, 0.995)
  assert.match(f.io.output, /Lowest requirement estimate 92%/)
  assert.match(f.io.output, /required 90%/); assert.match(f.io.output, /required 99.5%/)
})

test('TUI picker custom and cancellation preserve exact settings and need fresh consent', async t => {
  const f = await fixture(t, { lines: ['/auto-threshold', '/auto-threshold', '/mode', 'Set a note named tone to clear', '/exit'], choices: ['custom', undefined, 'auto'], texts: ['96.2'] })
  assert.equal(await f.run(), 0)
  assert.deepEqual((await f.preferences.load()).autoReviewThresholds, { openai: 962, openrouter: 990 })
  assert.equal(f.reviews[0].policy.checks[0].allowAt, 0.962)
  assert.equal(f.approvals.filter(request => request.call.name === 'enroll_auto_review').length, 1)
})

for (const surface of ['tui', 'line']) test(`${surface} invalid command leaves saved threshold intact and remains usable`, async t => {
  const f = await fixture(t, { surface, lines: ['/auto-threshold 89.9', '/auto-threshold 99.55', '/auto-threshold', '/exit'], choices: [undefined] })
  assert.equal(await f.run(), 0)
  assert.deepEqual((await f.preferences.load()).autoReviewThresholds, { openai: 950, openrouter: 990 })
  assert.match(f.io.output, /Invalid Auto review threshold/)
  assert.equal(f.reviews.length, 0); assert.equal(f.approvals.length, 0)
})

for (const surface of ['tui', 'line']) test(`${surface} corrupted persisted settings cannot silently enroll at a looser default`, async t => {
  const f = await fixture(t, { surface, invalid: true, lines: ['/mode', 'Set a note named tone to clear', '/exit'], choices: ['auto'] })
  assert.equal(await f.run(), 0)
  assert.equal(f.reviews.length, 0)
  assert(!f.modes.includes('auto'))
  assert.equal(await readFile(join(f.directory, 'preferences.json'), 'utf8'), '{invalid')
  assert.match(f.io.output, /Auto enrollment is unavailable/)
})

for (const surface of ['tui', 'line']) test(`${surface} explicit threshold reset repairs invalid preferences without restoring enrollment`, async t => {
  const f = await fixture(t, { surface, invalid: true, lines: ['/auto-threshold default', '/mode', 'Set a note named tone to clear', '/exit'], choices: ['auto'] })
  assert.equal(await f.run(), 0)
  assert.deepEqual((await f.preferences.load()).autoReviewThresholds, {})
  assert.equal(f.reviews[0].policy.checks[0].allowAt, 0.995)
  assert.equal(f.approvals.filter(request => request.call.name === 'enroll_auto_review').length, 1)
})

for (const surface of ['tui', 'line']) test(`${surface} prompt and noninteractive commands never persist a threshold or enroll Auto`, async t => {
  for (const config of [{ prompt: '/auto-threshold 90' }, { interactive: false, lines: ['/auto-threshold 90', '/exit'] }]) {
    const f = await fixture(t, { surface, ...config })
    assert.equal(await f.run(), 0)
    assert.deepEqual((await f.preferences.load()).autoReviewThresholds, { openai: 950, openrouter: 990 })
    assert.equal(f.reviews.length, 0); assert.equal(f.approvals.length, 0); assert.equal(f.chatCalls, 0)
    assert.match(f.io.output, /idle interactive conversation|Choose this conversation’s Auto reviewer/)
  }
})

test('reviewer none and restore keep both saved cutoffs without restoring enrollment', async t => {
  const f = await fixture(t, { lines: ['/reviewer', '/reviewer', '/mode', 'Set a note named tone to clear', '/exit'], choices: ['none', 'openai', 'current', 'auto'] })
  assert.equal(await f.run(), 0)
  assert.equal(f.reviews[0].policy.checks[0].allowAt, 0.95)
  assert.deepEqual((await f.preferences.load()).autoReviewThresholds, { openai: 950, openrouter: 990 })
  assert.equal(f.approvals.filter(request => request.call.name === 'enroll_auto_review').length, 1)
})

for (const surface of ['tui', 'line']) test(`${surface} failed preference save restores the old cutoff but never restores Auto`, async t => {
  const f = await fixture(t, { surface, lines: ['/mode', '/auto-threshold 90', '/mode', 'Set a note named tone to clear', '/exit'], choices: ['auto', 'auto'] })
  const save = PreferenceStore.prototype.save
  t.mock.method(PreferenceStore.prototype, 'save', function (settings) {
    if (settings.autoReviewThresholds?.openai === 900) throw new Error('Offline preference save failure')
    return save.call(this, settings)
  })
  assert.equal(await f.run(), 0)
  assert.deepEqual((await f.preferences.load()).autoReviewThresholds, { openai: 950, openrouter: 990 })
  assert.equal(f.reviews[0].policy.checks[0].allowAt, 0.95)
  assert.equal(f.approvals.filter(request => request.call.name === 'enroll_auto_review').length, 2)
  assert.match(f.io.output, /Offline preference save failure/)
})
