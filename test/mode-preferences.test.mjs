// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../dist/main.js'
import { DEFAULT_PREFERENCES, PreferenceStore, validatePreferences } from '../dist/preferences.js'

async function fixture(t, initial = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mode-preferences-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const preferences = new PreferenceStore(directory)
  await preferences.save({ ...DEFAULT_PREFERENCES, provider: 'openai', model: 'gpt-5.1', enableTools: true, ...initial })
  const vault = new Map(), reviews = [], reviewKeys = []
  const credentials = { async status() { return { available: true, label: 'Offline vault' } },
    async load(slot) { return vault.get(slot) }, async save(slot, key) { vault.set(slot, key) } }
  const run = async ({ surface = 'tui', lines = ['/exit'], choices = [], env = { OPENAI_API_KEY: 'offline-openai-key' },
    args = [], interactive = true, deny = false, note = false } = {}) => {
    let mode = 'manual', task = 'execute', round = 0
    const io = { output: '', closed: false, canAutoReview: interactive, choices: [], approvals: [], sessions: [], reads: [],
      get isClosed() { return this.closed },
      async choose(title, values) {
        this.choices.push(title); const value = choices.shift()
        assert(value === undefined || values.some(row => row.value === value), `${value} absent in ${title}`)
        return value
      },
      async chooseSearchable() { return undefined }, async askSecret() { return 'offline-saved-reviewer-key' }, async askText() {},
      async readLine() { const line = lines.shift(); this.reads.push({ line, mode, task }); return line },
      async approve(request) { this.approvals.push(request); return !deny },
      setApprovalMode(value) { mode = value }, setTaskMode(value) { task = value },
      setSession(session) { this.sessions.push(session) }, setContext() {}, addSecrets() {},
      write(text) { this.output += text }, event() {}, result() {}, onCancel() { return () => {} }, close() { this.closed = true }
    }
    const saved = await preferences.load()
    const status = await main(['--session-dir', directory, '--no-workspace', '--no-skills',
      ...(args.includes('--resume') ? [] : ['--provider', saved.provider, '--model', saved.model]),
      '--tools', ...(surface === 'line' ? ['--no-tui'] : []), ...args], env, {
      ...(surface === 'line' ? { io } : { tuiIO: io }), credentials,
      catalog: { async list() { return { state: 'fresh', models: [{ id: saved.model, name: saved.model,
        conversation: 'supported', tools: 'supported', reasoning: 'unsupported', efforts: [] }] } } },
      providerFactory: session => ({ async generate() {
        const output = note && ++round % 2 ? { content: '', toolCalls: [{ id: `note-${round}`, name: 'note_set',
          arguments: { key: 'tone', value: 'clear', expectedRevision: 0 } }] } : { content: 'Done', toolCalls: [] }
        return session.provider !== 'deepseek' ? output : { ...output, providerState: {
          provider: `deepseek:${session.model}`, items: [{ role: 'assistant', content: output.content || null,
            reasoning_content: 'Offline reasoning', ...(output.toolCalls.length ? { tool_calls: output.toolCalls.map(call => ({
              id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) }
            })) } : {}) }]
        } }
      } }),
      decisionProviderFactory(session, reviewEnv) {
        reviewKeys.push(reviewEnv[session.provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY'])
        return { id: session.provider, model: session.provider === 'openai' ? 'gpt-6-luna' : 'typesafe/jev-1.13',
          async evaluate(request) { reviews.push({ provider: session.provider, request }); return { model: this.model,
            answers: request.policy.checks.map(check => ({ name: check.name, type: 'predicate', probability: 1 })),
            usage: { inputTokens: 1, outputTokens: 1 } } }
        }
      }
    })
    assert.equal(status, 0, io.output)
    return io
  }
  return { directory, preferences, vault, reviews, reviewKeys, run }
}

test('mode and reviewer preferences validate all choices without accepting credentials or getters', () => {
  for (const mode of ['manual', 'auto', 'skip', 'plan']) for (const reviewer of ['none', 'openai', 'openrouter']) {
    const input = { ...DEFAULT_PREFERENCES, mode, reviewer }
    assert.deepEqual(validatePreferences(input), input)
  }
  let called = false
  for (const field of ['mode', 'reviewer']) {
    for (const value of [undefined, null, true, 'unknown', {}, []]) assert.throws(() => validatePreferences({ ...DEFAULT_PREFERENCES, [field]: value }))
    const input = { ...DEFAULT_PREFERENCES }
    Object.defineProperty(input, field, { enumerable: true, get() { called = true; return 'auto' } })
    assert.throws(() => validatePreferences(input))
  }
  assert.equal(called, false)
})

for (const surface of ['tui', 'line']) for (const mode of ['manual', 'auto', 'skip', 'plan']) {
  test(`${surface} remembers ${mode} across launches${surface === 'tui' ? ' and new conversations' : ''}`, async t => {
    const f = await fixture(t)
    const command = surface === 'tui' ? '/mode' : mode === 'auto' ? '/mode cycle' : `/mode ${mode}`
    const first = await f.run({ surface, lines: [command, ...(surface === 'tui' ? ['/new'] : []), '/session', '/exit'], choices: [mode] })
    assert.equal((await f.preferences.load()).mode, mode)
    const current = first.reads.find(row => row.line === '/session')
    assert.equal(current.mode, mode === 'plan' ? 'manual' : mode)
    assert.equal(current.task, mode === 'plan' ? 'plan' : 'execute')
    const second = await f.run({ surface, lines: ['/session', '/exit'] })
    assert.equal(second.reads[0].mode, mode === 'plan' ? 'manual' : mode)
    assert.equal(second.reads[0].task, mode === 'plan' ? 'plan' : 'execute')
    assert.deepEqual(second.choices, [])
    assert.deepEqual(second.approvals, [])
  })
}

test('saved reviewer and secure key are reused across new conversations and launches independently of chat', async t => {
  const f = await fixture(t, { provider: 'deepseek', model: 'deepseek-flash' })
  const env = { DEEPSEEK_API_KEY: 'offline-deepseek-chat-key' }
  const first = await f.run({ env, lines: ['/mode', 'Set note tone to clear', '/new', 'Set note tone to clear', '/exit'],
    choices: ['auto', 'openai', 'enter', 'save'], note: true })
  assert.equal(first.choices.filter(title => title === 'Auto reviewer').length, 1)
  assert.equal((await f.preferences.load()).reviewer, 'openai')
  assert.equal((await f.preferences.load()).mode, 'auto')
  assert.equal(f.reviews.length, 2, first.output)
  const second = await f.run({ env, lines: ['Set note tone to clear', '/exit'], note: true })
  assert.deepEqual(second.choices, [])
  assert.deepEqual(second.approvals, [])
  assert.equal(f.reviews.length, 3)
  assert(f.reviews.every(row => row.provider === 'openai'))
  assert(f.reviewKeys.every(key => key === 'offline-saved-reviewer-key'))
  const raw = await readFile(join(f.directory, 'preferences.json'), 'utf8')
  assert(!raw.includes('offline-saved-reviewer-key')); assert(!raw.includes('offline-deepseek-chat-key'))
})

test('line mode reuses a saved reviewer and OS key configured in the full-screen UI', async t => {
  const f = await fixture(t, { provider: 'deepseek', model: 'deepseek-flash', mode: 'auto', reviewer: 'openrouter' })
  f.vault.set('openrouter', 'offline-router-review-key')
  const io = await f.run({ surface: 'line', env: { DEEPSEEK_API_KEY: 'offline-chat-key' }, lines: ['Set note tone to clear', '/exit'], note: true })
  assert.deepEqual(io.approvals, [])
  assert.equal(f.reviews[0].provider, 'openrouter')
  assert.deepEqual(f.reviewKeys, ['offline-router-review-key'])
})

for (const surface of ['tui', 'line']) test(`${surface} explicit Manual overrides saved Auto and is remembered`, async t => {
  const f = await fixture(t, { mode: 'auto', reviewer: 'openai' })
  const io = await f.run({ surface, args: ['--approval-mode', 'manual'] })
  assert.equal(io.reads[0].mode, 'manual')
  assert.equal((await f.preferences.load()).mode, 'manual')
})

for (const mode of ['auto', 'skip']) test(`noninteractive launches cannot restore ${mode} or overwrite the saved mode`, async t => {
  const f = await fixture(t, { mode, reviewer: 'openai' })
  const io = await f.run({ surface: 'line', interactive: false, lines: ['/mode manual', '/exit'] })
  assert.equal(io.reads[0].mode, 'manual')
  assert.deepEqual(io.approvals, [])
  assert.equal((await f.preferences.load()).mode, mode)
})

test('resuming a transcript uses the current mode preference', async t => {
  const f = await fixture(t)
  const first = await f.run({ lines: ['/mode plan', 'A real saved conversation', '/exit'] })
  const id = first.sessions[0].id
  await f.preferences.save({ ...await f.preferences.load(), mode: 'auto', reviewer: 'openai' })
  const resumed = await f.run({ args: ['--resume', id] })
  assert.equal(resumed.reads[0].mode, 'auto')
  assert.equal(resumed.reads[0].task, 'execute')
})

test('a launch-only key requires key setup again while retaining the selected reviewer', async t => {
  const f = await fixture(t, { provider: 'deepseek', model: 'deepseek-flash', mode: 'auto', reviewer: 'openai' })
  const io = await f.run({ env: { DEEPSEEK_API_KEY: 'offline-chat-key' }, choices: ['enter', 'temporary'],
    lines: ['Set note tone to clear', '/exit'], note: true })
  assert(!io.choices.includes('Auto reviewer'))
  assert(io.choices.includes('openai reviewer key'))
  assert.equal(f.reviews.length, 1)
  assert.equal(f.vault.size, 0)
})

for (const surface of ['tui', 'line']) test(`${surface} remembers an explicit reviewer flag without changing Manual`, async t => {
  const f = await fixture(t)
  await f.run({ surface, args: ['--reviewer', 'openrouter'], env: { OPENAI_API_KEY: 'offline-chat-key', OPENROUTER_API_KEY: 'offline-review-key' } })
  assert.equal((await f.preferences.load()).reviewer, 'openrouter')
})

for (const surface of ['tui', 'line']) test(`${surface} remembers disabling the reviewer and does not infer one again`, async t => {
  const f = await fixture(t, { mode: 'auto', reviewer: 'openai' })
  await f.run({ surface, lines: [surface === 'tui' ? '/reviewer' : '/reviewer none', '/exit'], choices: ['none'] })
  assert.equal((await f.preferences.load()).reviewer, 'none')
  assert.equal((await f.preferences.load()).mode, 'manual')
  const second = await f.run({ surface, lines: ['Set note tone to clear', '/exit'], note: true })
  assert.equal(second.approvals.length, 1)
  assert.equal(f.reviews.length, 0)
})

test('a failed preference write reports the error without claiming the new mode was saved', async t => {
  const f = await fixture(t, { mode: 'manual' })
  const save = PreferenceStore.prototype.save
  t.mock.method(PreferenceStore.prototype, 'save', function (settings) {
    if (settings.mode === 'auto') throw new Error('Offline mode save failure')
    return save.call(this, settings)
  })
  const io = await f.run({ lines: ['/mode', '/exit'], choices: ['auto'] })
  assert.match(io.output, /Offline mode save failure/)
  assert.equal((await f.preferences.load()).mode, 'manual')
})
