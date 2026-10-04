// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main, parseArguments } from '../dist/main.js'
import { configure } from '../dist/application.js'
import { FileSessionStore, newSession } from '../dist/session.js'

function fakeIO(choices = [], texts = [], lines = []) {
  return { output: '', sessions: [], events: [], results: [], closed: false,
    async choose(_title, values) {
      const value = choices.shift()
      if (value === undefined) return
      assert(values.some(choice => choice.value === value), `Choice ${String(value)} is absent from ${_title}`)
      return value
    },
    async askText() { return texts.shift() }, async readLine() { return lines.shift() },
    setSession(session) { this.sessions.push(structuredClone(session)) },
    write(text) { this.output += text }, event(event) { this.events.push(event) }, result(result) { this.results.push(result) },
    async approve() { return false }, onCancel(callback) { this.cancel = callback; return () => { this.cancel = undefined } },
    close() { this.closed = true }
  }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-tui-application-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
const answer = content => ({ content, toolCalls: [] })
const base = { schemaVersion: 1, provider: 'openai', model: '', reasoning: 'default', reasoningCapabilities: [],
  stream: true, enableTools: false, enableNotes: false, maxRounds: 25 }

test('first no-argument interactive launch saves nonsecret defaults and runs the canonical host', async t => {
  const directory = await fixture(t)
  const io = fakeIO(['new', 'openai', false, false], ['fake-model'], ['Hello', '/exit'])
  let turns = 0
  const code = await main([], { VIVI_SESSION_DIR: directory, OPENAI_API_KEY: 'test-key-no-network' }, { tuiIO: io,
    providerFactory: (session, options) => {
      assert.equal(session.model, 'fake-model'); assert.equal(options.enableTools, false)
      return { generate: async input => { turns++; assert.equal(input.tools.length, 0); return answer('Hello back') } }
    } })
  assert.equal(code, 0); assert.equal(turns, 1); assert.equal(io.closed, true)
  const prefs = await readFile(join(directory, 'preferences.json'), 'utf8')
  assert.equal(JSON.parse(prefs).model, 'fake-model'); assert(!prefs.includes('test-key-no-network'))
  const session = io.sessions.at(-1)
  assert.equal(session.history[0].content, 'Hello'); assert.equal(session.history[1].content, 'Hello back')
  assert(!(await readdir(directory)).some(name => name.endsWith('.lock')))
})

test('saved defaults remove repeated flags; settings affect new sessions while the old conversation stays fixed', async t => {
  const directory = await fixture(t)
  const initial = fakeIO(['new', 'openai', false, false], ['model-one'], ['/exit'])
  const factory = () => ({ generate: async () => answer('Done') })
  assert.equal(await main([], { VIVI_SESSION_DIR: directory }, { tuiIO: initial, providerFactory: factory }), 0)
  const io = fakeIO(['new', 'openrouter', false, false], ['model-two'], ['First', '/settings', 'Still first', '/new', 'Second', '/exit'])
  const models = []
  assert.equal(await main([], { VIVI_SESSION_DIR: directory }, { tuiIO: io,
    providerFactory: session => ({ generate: async () => { models.push(session.model); return answer('Done') } }) }), 0)
  assert.deepEqual(models, ['model-one', 'model-one', 'model-two'])
  assert.equal(io.sessions.at(-1).provider, 'openrouter')
  assert(!(await readdir(directory)).some(name => name.endsWith('.lock')))
})

test('configuration offers only default reasoning until capabilities are explicitly declared', async () => {
  const io = fakeIO(['openrouter', true, 'high', false], ['provider/model', 'wrong', 'low,high'])
  const configured = await configure(io, base, [])
  assert.equal(configured.reasoning, 'high')
  assert.deepEqual(configured.reasoningCapabilities, ['low', 'high'])
  assert.match(io.output, /supported effort/)
  assert.equal(configured.enableTools, false)
})

test('cancelled onboarding makes no provider call or saved session', async t => {
  const directory = await fixture(t)
  const io = fakeIO(['new', undefined, 'exit'])
  let calls = 0
  assert.equal(await main([], { VIVI_SESSION_DIR: directory }, { tuiIO: io, providerFactory: () => { calls++; throw new Error('Should not construct') } }), 0)
  assert.equal(calls, 0); assert.deepEqual(await readdir(directory), [])
})

test('provider configuration error returns to selection without leaking secrets or retaining a lease', async t => {
  const directory = await fixture(t)
  const io = fakeIO(['new', 'openai', false, false, 'exit'], ['fake'])
  assert.equal(await main([], { VIVI_SESSION_DIR: directory, OPENAI_API_KEY: 'known-secret' }, { tuiIO: io,
    providerFactory: () => { throw new Error('Missing known-secret') } }), 0)
  assert.match(io.output, /Missing \[REDACTED\]/); assert(!io.output.includes('known-secret'))
  assert(!(await readdir(directory)).some(name => name.endsWith('.lock')))
})

test('resume preserves original selections and does not borrow verified tools from a different saved model', async t => {
  const directory = await fixture(t)
  const store = new FileSessionStore(directory)
  const saved = newSession({ provider: 'openrouter', model: 'original', reasoning: 'high' })
  await store.save(saved)
  const io = fakeIO([true], [], ['Continue', '/exit'])
  assert.equal(await main(['--resume', saved.id], { VIVI_SESSION_DIR: directory }, { tuiIO: io,
    providerFactory: (session, options) => {
      assert.equal(session.model, 'original'); assert.equal(options.enableTools, false)
      assert.deepEqual(options.reasoningCapabilities, ['high'])
      return { generate: async input => { assert.deepEqual(input.tools, []); return answer('Resumed') } }
    } }), 0)
  assert.equal(io.sessions.at(-1).id, saved.id)
  assert.equal((await store.load(saved.id)).history[1].content, 'Resumed')
})

test('line arguments still require an explicit model while interactive parsing defers model selection', () => {
  assert.throws(() => parseArguments([]), /requires --model/)
  assert.equal(parseArguments([], {}, true).model, undefined)
  assert.throws(() => parseArguments(['--no-tools', '--enable-notes', '--model', 'fake']), /notes require/)
})

test('explicit model or provider changes cannot inherit saved capability declarations', async t => {
  const directory = await fixture(t)
  const { PreferenceStore } = await import('../dist/preferences.js')
  await new PreferenceStore(directory).save({ ...base, provider: 'openai', model: 'verified-A', reasoning: 'high',
    reasoningCapabilities: ['high'], enableTools: true, enableNotes: true })
  for (const args of [['--model', 'unverified-B'], ['--provider', 'openrouter', '--model', 'verified-A']]) {
    const io = fakeIO([], [], ['/exit'])
    assert.equal(await main(args, { VIVI_SESSION_DIR: directory }, { tuiIO: io, providerFactory: (session, options) => {
      assert.equal(session.reasoning, 'default'); assert.deepEqual(options.reasoningCapabilities, [])
      assert.equal(options.enableTools, false); assert.equal(options.enableNotes, false)
      return { generate: async () => answer('Unused') }
    } }), 0)
  }
})

test('resume holds the lease during capability confirmation and loads authoritative history inside it', async t => {
  const directory = await fixture(t)
  const store = new FileSessionStore(directory)
  const saved = newSession({ provider: 'openrouter', model: 'target', reasoning: 'high' })
  saved.history = [{ kind: 'message', role: 'user', content: 'Existing history' }]
  await store.save(saved)
  const io = fakeIO([], [], ['/exit'])
  io.choose = async () => {
    await assert.rejects(store.acquire(saved.id), /locked/)
    return true
  }
  assert.equal(await main(['--resume', saved.id], { VIVI_SESSION_DIR: directory }, { tuiIO: io,
    providerFactory: session => { assert.deepEqual(session.history, saved.history); return { generate: async () => answer('Unused') } } }), 0)
  assert.deepEqual((await store.load(saved.id)).history, saved.history)
  await (await store.acquire(saved.id))()
})

test('declining a required resume capability releases the session lease', async t => {
  const directory = await fixture(t)
  const store = new FileSessionStore(directory)
  const saved = newSession({ provider: 'openai', model: 'target', reasoning: 'high' })
  await store.save(saved)
  const io = fakeIO([false, 'exit'])
  assert.equal(await main(['--resume', saved.id], { VIVI_SESSION_DIR: directory }, { tuiIO: io,
    providerFactory: () => { throw new Error('Declined resume must not construct a provider') } }), 0)
  await (await store.acquire(saved.id))()
})

test('settings changed within the app replace command-line capabilities for later new sessions', async t => {
  const directory = await fixture(t)
  const io = fakeIO(['openrouter', true, 'low', false], ['other-model', 'low'], ['/settings', '/new', '/exit'])
  const seen = []
  assert.equal(await main(['--model', 'first-model', '--reasoning', 'high', '--reasoning-capabilities', 'high', '--tools'],
    { VIVI_SESSION_DIR: directory }, { tuiIO: io, providerFactory: (session, options) => {
      seen.push({ model: session.model, capabilities: options.reasoningCapabilities, tools: options.enableTools })
      return { generate: async () => answer('Unused') }
    } }), 0)
  assert.deepEqual(seen, [{ model: 'first-model', capabilities: ['high'], tools: true },
    { model: 'other-model', capabilities: ['low'], tools: false }])
})

test('TUI runtime guard rejects absent or old Bun without loading native modules', async () => {
  const { supportsBunTui } = await import('../dist/main.js')
  for (const version of [undefined, '', 'invalid', '0.9.0', '1.2.99']) assert.equal(supportsBunTui(version), false)
  for (const version of ['1.3.0', '1.4.2', '2.0.0']) assert.equal(supportsBunTui(version), true)
})
