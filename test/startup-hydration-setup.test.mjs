// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../dist/main.js'
import { DEFAULT_PREFERENCES, settingsForModel } from '../dist/application.js'
import { PreferenceStore } from '../dist/preferences.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { ModelCatalog, hydrateModelCapabilities, modelToolsEnabled, unknownModel } from '../dist/models.js'

const id = 'vendor/startup-defaults'
const key = 'offline-fixture-key-no-network'
const entry = changes => ({ ...unknownModel(id), conversation: 'supported', tools: 'supported', streaming: 'supported', ...changes })
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-startup-defaults-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
function fakeIO(choices = [], lines = ['Hello', '/exit'], secrets = []) {
  return { output: '', closed: false, sessions: [], choices: [], results: [], drafts: [], protected: [],
    get isClosed() { return this.closed },
    async readLine() { return lines.shift() },
    async choose(title, values) {
      this.choices.push(title)
      const selected = choices.shift()
      if (selected !== undefined) assert(values.some(value => value.value === selected), `${String(selected)} absent from ${title}`)
      return selected
    },
    async chooseSearchable(title, values) {
      this.choices.push(title)
      const selected = choices.shift()
      if (selected === undefined) return
      assert(values.some(value => value.value === selected), `${String(selected)} absent from ${title}`)
      return { kind: 'selected', value: selected, query: '' }
    },
    async askText() {}, async askSecret() { return secrets.shift() },
    addSecrets(values) { this.protected.push(...values) },
    setDraft(provider) { this.drafts.push(provider) }, setWorkspace() {},
    setSession(session) { this.sessions.push(structuredClone(session)) },
    write(text) { this.output += text }, event() {}, result(result) { this.results.push(result) },
    async approve() { return false }, onCancel(callback) { this.cancel = callback; return () => { this.cancel = undefined } },
    close() { this.closed = true }
  }
}
function services(models = [entry()]) {
  const calls = [], loads = [], saves = []
  return { calls, loads, saves,
    catalog: { async list(provider, apiKey, signal) {
      assert(!signal?.aborted)
      calls.push({ provider, key: apiKey })
      return { state: 'fresh', models: structuredClone(models) }
    } },
    credentials: { async load(provider) { loads.push(provider) },
      async status() { return { available: false, label: 'Offline fixture vault' } },
      async save(provider, value) { saves.push({ provider, value }) } }
  }
}
async function launch(directory, mode, io, supplied, args = [], factory, env = { OPENROUTER_API_KEY: key }) {
  return main(['--no-workspace', ...args], { VIVI_SESSION_DIR: directory, ...env }, {
    [mode === 'tui' ? 'tuiIO' : 'io']: io, catalog: supplied.catalog, credentials: supplied.credentials,
    providerFactory: factory ?? (() => ({ generate: async () => ({ content: 'Done', toolCalls: [] }) }))
  })
}
const selections = ['--provider', 'openrouter', '--model', id]

test('exact-ID shared hydration never turns a name, missing metadata or host declaration into catalog evidence', async () => {
  const supplied = services([entry({ id: 'vendor/other', name: id })])
  const hydrated = await hydrateModelCapabilities(supplied.catalog, 'openrouter', id, key)
  assert.deepEqual(hydrated.model, unknownModel(id))
  assert.equal(modelToolsEnabled(hydrated.model), false)
  assert.equal(modelToolsEnabled(hydrated.model, { declared: true }), true)
  assert.equal(hydrated.model.tools, 'unknown')
  assert.equal(modelToolsEnabled(entry(), { disabled: true, declared: true }), false)
  assert.equal(modelToolsEnabled(entry({ tools: 'unsupported' }), { declared: true }), false)
  let catalogs = 0
  const openai = await hydrateModelCapabilities({ async list() { catalogs++; assert.fail('OpenAI startup uses exact documented metadata') } }, 'openai', 'gpt-5.1')
  assert.equal(openai.model.tools, 'supported'); assert.equal(catalogs, 0)
})

for (const mode of ['line', 'tui']) {
  test(`${mode} OpenRouter startup hydrates verified tools, notes and reasoning before its actual first turn`, async t => {
    const directory = await fixture(t), io = fakeIO(), supplied = services([entry({ reasoning: 'supported', efforts: ['none', 'high'], streaming: 'unsupported' })])
    let requests = 0
    assert.equal(await launch(directory, mode, io, supplied, selections, (_session, options) => {
      assert.equal(options.enableTools, true); assert.equal(options.enableNotes, true)
      assert.equal(options.enableMemory, false); assert.equal(options.stream, false)
      assert.deepEqual(options.reasoningCapabilities, ['none', 'high'])
      return { async generate(input) {
        requests++; assert(input.tools.some(tool => tool.name === 'note_set'))
        return { content: 'Hydrated first turn', toolCalls: [] }
      } }
    }), 0)
    assert.equal(requests, 1); assert.deepEqual(supplied.calls, [{ provider: 'openrouter', key }])
    assert.equal(io.choices.length, 0); assert.equal(io.results[0].status, 'completed')
  })

  for (const [label, models, args, expected] of [
    ['unknown', [entry({ tools: 'unknown' })], [], false],
    ['missing', [entry({ id: 'vendor/other' })], [], false],
    ['unsupported', [entry({ tools: 'unsupported' })], ['--tools'], false],
    ['fresh declaration', [entry({ tools: 'unknown' })], ['--tools'], true],
    ['notes intent alone', [entry({ tools: 'unknown' })], ['--enable-notes'], false],
    ['explicit opt-out', [entry()], ['--tools', '--no-tools', '--enable-notes'], false]
  ]) test(`${mode} startup tool policy: ${label}`, async t => {
    const directory = await fixture(t), supplied = services(models), io = fakeIO()
    assert.equal(await launch(directory, mode, io, supplied, [...selections, ...args], (_session, options) => {
      assert.equal(options.enableTools, expected); assert.equal(options.enableNotes, expected)
      return { async generate(input) {
        assert.equal(input.tools.length > 0, expected)
        return { content: 'Done', toolCalls: [] }
      } }
    }), 0)
    assert.equal(io.results.length, 1); assert.equal(io.results[0].status, 'completed')
  })

  test(`${mode} catalog failure stays chat-only and redacts keys without a provider probe`, async t => {
    const directory = await fixture(t), supplied = services(), io = fakeIO()
    supplied.catalog.list = async () => { throw new Error(`Offline catalog ${key}`) }
    let constructed = 0, turns = 0
    assert.equal(await launch(directory, mode, io, supplied, selections, (_session, options) => {
      constructed++; assert.equal(options.enableTools, false); assert.equal(options.enableNotes, false)
      return { async generate(input) { turns++; assert.deepEqual(input.tools, []); return { content: 'Chat still works', toolCalls: [] } } }
    }), 0)
    assert.equal(constructed, 1); assert.equal(turns, 1)
    assert.match(io.output, /Offline catalog \[REDACTED\]/); assert(!io.output.includes(key))
  })

  test(`${mode} authentication denial cannot authorize a provider even with --tools`, async t => {
    const directory = await fixture(t), supplied = services(), io = fakeIO()
    supplied.catalog = new ModelCatalog(async () => new Response('private-body', { status: 403 }))
    let constructed = 0
    assert.equal(await launch(directory, mode, io, supplied, [...selections, '--tools'], () => { constructed++; assert.fail('Must not construct a denied provider') }), mode === 'line' ? 1 : 0)
    assert.equal(constructed, 0); assert.match(io.output, /access was denied/); assert(!io.output.includes('private-body'))
    assert(!(await readdir(directory)).some(file => file.endsWith('.lock') || /^[0-9a-f-]+\.json$/.test(file)))
  })

  test(`${mode} cancelled catalog hydration cannot create a provider or save a session`, async t => {
    const directory = await fixture(t), supplied = services(), io = fakeIO([], ['/exit'])
    supplied.catalog.list = async (_provider, _apiKey, signal) => { io.cancel(); assert(signal.aborted); return { state: 'fresh', models: [entry()] } }
    assert.equal(await launch(directory, mode, io, supplied, selections, () => { assert.fail('Cancelled startup cannot construct a provider') }), mode === 'line' ? 130 : 0)
    assert.deepEqual(await readdir(directory), [])
  })

  test(`${mode} stale startup catalog disclosure is visible before the first provider turn`, async t => {
    const directory = await fixture(t), supplied = services(), io = fakeIO()
    supplied.catalog.list = async () => ({ models: [entry()], state: 'stale', warning: 'Offline fixture' })
    if (mode === 'tui') io.setSession = session => { io.sessions.push(structuredClone(session)); io.output = '' }
    assert.equal(await launch(directory, mode, io, supplied, selections, () => ({ async generate() {
      assert.match(io.output, /Using a stale cached catalog/)
      return { content: 'Done', toolCalls: [] }
    } })), 0)
  })
}

test('fresh TUI immediately opens only provider/model setup, saves safe defaults and avoids a second wizard', async t => {
  const directory = await fixture(t), supplied = services(), io = fakeIO(['openrouter', 'current', id])
  let turns = 0
  assert.equal(await launch(directory, 'tui', io, supplied, [], () => ({ async generate() { turns++; return { content: 'Done', toolCalls: [] } } })), 0)
  assert.deepEqual(io.choices, ['Provider', 'openrouter API key', 'Models · openrouter · fresh'])
  assert.equal(supplied.calls.length, 1); assert.equal(turns, 1)
  assert.equal(supplied.saves.length, 0); assert.equal(supplied.loads.length, 0)
  const saved = await new PreferenceStore(directory).load()
  assert.equal(saved.model, id); assert.equal(saved.enableNotes, true); assert.equal(saved.enableMemory, false)
  const next = fakeIO([], ['/new', 'Again', '/exit'])
  assert.equal(await launch(directory, 'tui', next, supplied), 0)
  assert.equal(next.choices.length, 0); assert.equal(next.sessions.at(-1).history[0].content, 'Again')
})

test('automatic setup cancellation leaves a clean composer and explicit retries do not loop or call a provider', async t => {
  const directory = await fixture(t), supplied = services(), io = fakeIO([undefined, undefined, undefined], ['/provider', '/provider', 'Hello', '/exit'])
  assert.equal(await launch(directory, 'tui', io, supplied, [], () => { assert.fail('Cancelled setup cannot construct a provider') }), 0)
  assert.deepEqual(io.choices, ['Provider', 'Provider', 'Provider'])
  assert.equal(supplied.loads.length, 0); assert.equal(supplied.calls.length, 0)
  assert.deepEqual(await readdir(directory), []); assert.deepEqual(io.drafts, ['openai'])
  assert.match(io.output, /before sending a message/)
})

test('cancelled model setup retains selected provider and note intent, then /models safely finishes once', async t => {
  const directory = await fixture(t), supplied = services(), io = fakeIO(['openrouter', 'current', undefined, id], ['/models', 'Hello', '/exit'])
  assert.equal(await launch(directory, 'tui', io, supplied), 0)
  assert.deepEqual(io.choices, ['Provider', 'openrouter API key', 'Models · openrouter · fresh', 'Models · openrouter · fresh'])
  assert.deepEqual(io.drafts, ['openai', 'openrouter'])
  assert.equal(io.sessions.at(-1).model, id)
  assert.equal((await new PreferenceStore(directory).load()).enableNotes, true)
  assert(!(await readdir(directory)).some(file => file.endsWith('.lock')))
})

test('closing automatic provider setup cannot read a credential, open a second dialog or save anything', async t => {
  const directory = await fixture(t), supplied = services(), io = fakeIO()
  io.choose = async title => { io.choices.push(title); io.closed = true; return 'openrouter' }
  assert.equal(await launch(directory, 'tui', io, supplied, [], () => { assert.fail('Closed setup cannot construct a provider') }), 0)
  assert.deepEqual(io.choices, ['Provider']); assert.deepEqual(supplied.loads, [])
  assert.deepEqual(await readdir(directory), [])
})

test('an explicit resume bypasses automatic setup and line hydration uses the original OpenRouter model', async t => {
  for (const mode of ['line', 'tui']) {
    const directory = await fixture(t), supplied = services(), io = fakeIO(), store = new FileSessionStore(directory)
    const session = newSession({ provider: 'openrouter', model: id }); await store.save(session)
    assert.equal(await launch(directory, mode, io, supplied, ['--resume', session.id], selected => {
      assert.equal(selected.id, session.id); assert.equal(selected.model, id)
      return { generate: async () => ({ content: 'Resumed', toolCalls: [] }) }
    }), 0)
    assert.equal(io.choices.length, 0); assert.equal(io.results.length, 1); assert.equal(io.results[0].status, 'completed')
    if (mode === 'line') assert.equal(supplied.calls.length, 1)
  }
})

test('model changes preserve explicit notes intent even through an unknown chat-only selection', async () => {
  for (const enableNotes of [true, false]) {
    const unknown = settingsForModel({ ...DEFAULT_PREFERENCES, model: id, enableTools: true, enableNotes }, unknownModel('vendor/future'))
    assert.equal(unknown.enableTools, false); assert.equal(unknown.enableNotes, enableNotes)
    assert.equal(settingsForModel(unknown, entry()).enableNotes, enableNotes)
  }
})

test('saved OpenAI and OpenRouter chat-only choices survive fresh capability hydration', async t => {
  for (const [provider, model] of [['openai', 'gpt-5.1'], ['openrouter', id]]) {
    const directory = await fixture(t), supplied = services(), io = fakeIO()
    await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, provider, model, enableTools: false })
    assert.equal(await launch(directory, 'tui', io, supplied, [], (_session, options) => {
      assert.equal(options.enableTools, false); assert.equal(options.enableNotes, false)
      return { generate: async () => ({ content: 'Done', toolCalls: [] }) }
    }), 0)
    assert.equal(io.choices.length, 0); assert.equal(io.results.length, 1); assert.equal(io.results[0].status, 'completed')
    assert.equal((await new PreferenceStore(directory).load()).enableNotes, true)
  }
})

test('a cancelled replacement-key setup cannot reuse the old account catalog for a later fresh session', async t => {
  const directory = await fixture(t), supplied = services(), replacement = 'offline-replacement-key'
  const io = fakeIO(['openrouter', 'enter', 'temporary'], ['First', '/provider', '/new', 'Still current', '/exit'], [replacement])
  await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, provider: 'openrouter', model: id, enableTools: true })
  const requestedKeys = [], constructedKeys = []
  supplied.catalog = new ModelCatalog(async (_url, request) => {
    const authorization = request.headers.Authorization
    requestedKeys.push(authorization)
    return authorization === `Bearer ${key}`
      ? new Response(JSON.stringify({ data: [{ id, supported_parameters: ['tools'],
        architecture: { input_modalities: ['text'], output_modalities: ['text'] } }] }))
      : new Response('private-denied-body', { status: 403 })
  })
  assert.equal(await launch(directory, 'tui', io, supplied, [], (_session, _options, env) => {
    constructedKeys.push(env.OPENROUTER_API_KEY)
    return { generate: async () => ({ content: 'Original provider remains current', toolCalls: [] }) }
  }), 0)
  assert.deepEqual(constructedKeys, [key])
  assert.deepEqual(requestedKeys, [`Bearer ${key}`, `Bearer ${replacement}`, `Bearer ${replacement}`])
  assert.equal(io.results.length, 2); assert(io.results.every(result => result.status === 'completed'))
  assert.match(io.output, /access was denied/)
  assert(!io.output.includes(key)); assert(!io.output.includes(replacement)); assert(!io.output.includes('private-denied-body'))
  assert.equal((await new PreferenceStore(directory).load()).model, id)
  assert(!(await readdir(directory)).some(file => file.endsWith('.lock')))
})
