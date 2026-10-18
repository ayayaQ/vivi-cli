// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main, parseArguments } from '../dist/main.js'
import { chooseEffort, settingsForModel, DEFAULT_PREFERENCES } from '../dist/application.js'
import { FileSkillStore } from '../dist/skills.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { PreferenceStore } from '../dist/preferences.js'
import { parseModelCatalog, unknownModel } from '../dist/models.js'
const answer = content => ({ content, toolCalls: [] })
const defaultFactory = () => ({ generate: async () => answer('Done') })
function fakeIO(choices = [], texts = [], lines = [], secretInputs = []) {
  return { output: '', sessions: [], events: [], results: [], closed: false, choices: [], searches: [], secretTitles: [], protected: [],
    get isClosed() { return this.closed },
    async choose(title, values, initial) {
      this.choices.push({ title, values: structuredClone(values), initial })
      const value = choices.shift()
      if (value === undefined) return
      assert(values.some(choice => choice.value === value), `Choice ${String(value)} is absent from ${title}`)
      return value
    },
    async chooseSearchable(title, values, options = {}) {
      this.choices.push({ title, values: structuredClone(values), initial: options.initialIndex })
      this.searches.push({ title, values: structuredClone(values), options: structuredClone(options) })
      const selection = choices.shift()
      if (selection === undefined) return
      if (selection?.kind === 'refresh') { assert.equal(options.refresh, true); return selection }
      const value = selection?.kind === 'selected' ? selection.value : selection
      assert(values.some(choice => choice.value === value), `Choice ${String(value)} is absent from ${title}`)
      return { kind: 'selected', value, query: selection?.query ?? options.query ?? '' }
    },
    async askText() { return texts.shift() }, async readLine() { return lines.shift() },
    async askSecret(title) { this.secretTitles.push(title); return secretInputs.shift() },
    addSecrets(secrets) { this.protected.push(...secrets) },
    setSession(session) { this.sessions.push(structuredClone(session)) },
    write(text) { this.output += text }, event(event) { this.events.push(event) }, result(result) { this.results.push(result) },
    async approve() { return false }, onCancel(callback) { this.cancel = callback; return () => { this.cancel = undefined } },
    close() { this.closed = true }
  }
}
function fakeServices(models = [{ id: 'fake-model' }], { available = false, failSave = false } = {}) {
  const vault = new Map(), loads = [], saves = [], catalogCalls = []
  const credentials = { async status() { return { available, label: 'Fake secure vault', detail: 'No secure vault available' } },
    async load(provider) { loads.push(provider); return vault.get(provider) },
    async save(provider, key) { saves.push({ provider, key }); if (failSave) throw new Error('Storage unavailable'); vault.set(provider, key) } }
  const catalog = { async list(provider, key, signal, refresh) {
    catalogCalls.push({ provider, key, refresh }); assert(!signal?.aborted)
    return { models: parseModelCatalog(provider, { data: models }).map(model => ({ ...model, conversation: 'supported' })), state: 'fresh' }
  } }
  return { credentials, catalog, vault, loads, saves, catalogCalls }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-setup-application-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
const base = { ...DEFAULT_PREFERENCES, model: 'saved-model' }
async function run(directory, io, services, providerFactory = defaultFactory, args = [], env = {}) {
  return main(['--no-workspace', ...args], { VIVI_SESSION_DIR: directory, ...env }, { tuiIO: io, providerFactory, ...services })
}
test('first launch offers minimal provider setup and cancellation retains a fresh composer without provider calls or saved state', async t => {
  const directory = await fixture(t), io = fakeIO([], [], ['Hello', '/exit']), services = fakeServices()
  let calls = 0
  assert.equal(await run(directory, io, services, () => { calls++; return defaultFactory() }), 0)
  assert.equal(calls, 0); assert.deepEqual(io.choices.map(choice => choice.title), ['Provider']); assert.equal(services.loads.length, 0)
  assert.match(io.output, /\/provider/); assert(!io.output.includes('Welcome'))
  assert.equal(io.sessions[0].history.length, 0); assert.deepEqual(await readdir(directory), [])
})
test('slash provider setup masks and securely saves keys, model picker selects without manual names', async t => {
  const directory = await fixture(t), services = fakeServices([{ id: 'gpt-5.1' }], { available: true })
  const key = 'fake-key-only-no-network'
  const io = fakeIO([undefined, 'openai', 'save', 'gpt-5.1'], [], ['/provider', 'Hello', '/exit'], [key])
  let turns = 0
  assert.equal(await run(directory, io, services, (session, options, env) => {
    assert.equal(session.model, 'gpt-5.1'); assert.equal(env.OPENAI_API_KEY, key); assert.equal(options.enableTools, true)
    return { generate: async input => { turns++; const names = input.tools.map(tool => tool.name); for (const name of ['calculate', 'current_time', 'list_skills', 'read_skill']) assert(names.includes(name)); assert.equal(names.includes('save_skill'), new FileSkillStore(join(directory, 'agent-skills')).writable); return answer('Hello back') } }
  }), 0)
  assert.equal(turns, 1); assert.deepEqual(services.saves, [{ provider: 'openai', key }])
  assert.equal(io.secretTitles.length, 1); assert(io.protected.includes(key)); assert(!io.output.includes(key))
  const prefs = await readFile(join(directory, 'preferences.json'), 'utf8')
  assert.equal(JSON.parse(prefs).model, 'gpt-5.1'); assert(!prefs.includes(key))
  const session = io.sessions.at(-1); assert.equal(session.history[1].content, 'Hello back')
  const inspectFiles = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name)
      if (entry.isDirectory()) await inspectFiles(file)
      else assert(!(await readFile(file, 'utf8')).includes(key))
    }
  }
  await inspectFiles(directory)
  const next = fakeIO([], [], ['Again', '/exit'])
  assert.equal(await run(directory, next, services, (_session, _options, env) => { assert.equal(env.OPENAI_API_KEY, key); return defaultFactory() }), 0)
  assert.equal(next.choices.length, 0); assert.notEqual(next.sessions.at(-1).id, session.id)
  assert.deepEqual(next.sessions.at(-1).history.map(m => m.content), ['Again', 'Done'])
})
test('unavailable storage explicitly offers this-launch only and never writes plaintext credentials', async t => {
  const directory = await fixture(t), services = fakeServices([{ id: 'vendor/chat', supported_parameters: [] }])
  const io = fakeIO([undefined, 'openrouter', 'temporary', 'vendor/chat'], [], ['/provider', '/exit'], ['fake-router-key'])
  assert.equal(await run(directory, io, services), 0)
  assert.equal(services.saves.length, 0); assert.match(io.output, /this launch only/)
  assert.match(io.choices.find(c => c.title === 'API key storage').values[0].description, /No plaintext fallback/)
  assert.equal(JSON.parse(await readFile(join(directory, 'preferences.json'))).enableTools, false)
})
test('failed secure save requires an explicit temporary fallback and cancel retains no provider settings', async t => {
  const directory = await fixture(t), services = fakeServices([{ id: 'fake-model' }], { available: true, failSave: true })
  const io = fakeIO([undefined, 'openai', 'save', false], [], ['/provider', '/exit'], ['fake-key'])
  assert.equal(await run(directory, io, services), 0)
  assert.equal(services.catalogCalls.length, 0); assert.equal(services.saves.length, 1)
  assert.deepEqual(await readdir(directory), []); assert(!io.output.includes('fake-key'))
})
test('cancelled provider/key/model/effort flows retain clean input and no unintended provider calls', async t => {
  for (const choices of [[undefined], ['openai', undefined], ['openai', 'temporary', undefined]]) {
    const directory = await fixture(t), services = fakeServices(), io = fakeIO([undefined, ...choices], [], ['/provider', '/exit'], choices.length === 3 ? ['fake-key'] : [])
    let calls = 0
    assert.equal(await run(directory, io, services, () => { calls++; return defaultFactory() }), 0)
    assert.equal(calls, 0); assert.equal(services.saves.length, 0)
    assert(!(await readdir(directory)).some(file => file.endsWith('.lock')))
  }
})
test('environment key precedes saved key and is never copied to credential storage', async t => {
  const directory = await fixture(t), services = fakeServices([{ id: 'gpt-5.1' }], { available: true })
  services.vault.set('openai', 'fake-vault-key')
  const io = fakeIO([undefined, 'openai', 'current', 'gpt-5.1'], [], ['/provider', '/exit'])
  assert.equal(await run(directory, io, services, (_s, _o, env) => { assert.equal(env.OPENAI_API_KEY, 'fake-environment-key'); return defaultFactory() }, [], { OPENAI_API_KEY: 'fake-environment-key' }), 0)
  assert.equal(services.loads.length, 0); assert.equal(services.saves.length, 0)
})
test('model switch auto-resolves capabilities, resets incompatible effort and starts fresh with old session resumable', async t => {
  const directory = await fixture(t), services = fakeServices([{ id: 'gpt-5.1' }, { id: 'future-unknown' }])
  await new PreferenceStore(directory).save({ ...base, model: 'gpt-5.1', reasoning: 'high', reasoningCapabilities: ['none', 'low', 'medium', 'high'], enableTools: true })
  const io = fakeIO(['future-unknown'], [], ['First', '/models', 'Second', '/exit']), seen = []
  assert.equal(await run(directory, io, services, (session, options) => { seen.push([session.model, session.reasoning, options.enableTools]); return defaultFactory() }), 0)
  assert.deepEqual(seen, [['gpt-5.1', 'high', true], ['future-unknown', 'default', false]])
  const actual = io.sessions.filter(s => s.history.length === 2)
  assert.notEqual(actual[0].id, actual[1].id); assert.equal((await new FileSessionStore(directory).load(actual[0].id)).history[0].content, 'First')
  assert.match(io.output, /capabilities are unknown/)
})
test('effort picker offers exact supported levels and leaves defaults unchanged on cancellation', async () => {
  const io = fakeIO(['high'])
  const selected = await chooseEffort(io, { ...base, reasoningCapabilities: ['none', 'high'] })
  assert.equal(selected.reasoning, 'high'); assert.deepEqual(io.choices[0].values.map(v => v.value), ['default', 'none', 'high'])
  assert.equal(await chooseEffort(fakeIO([undefined]), { ...base, reasoningCapabilities: ['high'] }), undefined)
  assert.deepEqual(settingsForModel({ ...base, reasoning: 'high', reasoningCapabilities: ['high'], enableTools: true }, unknownModel('other')).reasoningCapabilities, [])
})
test('catalog failure keeps saved selection explicit and downgrades unknown capabilities safely', async t => {
  const directory = await fixture(t), services = fakeServices()
  services.catalog.list = async () => { throw new Error('Catalog offline') }
  await new PreferenceStore(directory).save({ ...base, enableTools: true })
  const io = fakeIO([true], [], ['/models', '/exit']), seen = []
  assert.equal(await run(directory, io, services, (_s, options) => { seen.push(options.enableTools); return defaultFactory() }), 0)
  assert.deepEqual(seen, [false, false]); assert.match(io.output, /Catalog offline/)
})
test('live model picker gets the full catalog and retains the query across explicit refresh', async t => {
  const directory = await fixture(t), services = fakeServices([{ id: 'alpha' }, { id: 'beta' }])
  const io = fakeIO([undefined, { kind: 'refresh', query: 'OPENAI bet' }, 'beta'], [], ['/models', '/exit'])
  assert.equal(await run(directory, io, services, defaultFactory, [], { OPENAI_API_KEY: 'fake' }), 0)
  assert.equal(services.catalogCalls.length, 2); assert.equal(services.catalogCalls[1].refresh, true)
  assert.equal(JSON.parse(await readFile(join(directory, 'preferences.json'))).model, 'beta')
  assert.equal(io.searches.length, 2)
  assert.deepEqual(io.searches[1].options, { query: 'OPENAI bet', initialIndex: 0, refresh: true })
  assert.deepEqual(io.searches[1].values.map(choice => choice.value), ['alpha', 'beta'])
  assert.deepEqual(io.searches[1].values[1].searchTerms, ['beta', 'openai'])
})
test('model picker reaches saved and selected IDs beyond the old 250-row cutoff without sentinel collisions', async t => {
  const directory = await fixture(t)
  const ids = ['__refresh', '__search', ...Array.from({ length: 2000 }, (_, index) => `vendor/model-${String(index).padStart(4, '0')}`)]
  const services = fakeServices(ids.map(id => ({ id })))
  await new PreferenceStore(directory).save({ ...base, provider: 'openrouter', model: ids.at(-1) })
  const io = fakeIO(['__refresh'], [], ['/models', '/exit'])
  assert.equal(await run(directory, io, services), 0)
  assert.equal(io.searches[0].values.length, 2002)
  assert.equal(io.searches[0].values[io.searches[0].options.initialIndex].value, ids.at(-1))
  // Saved OpenRouter selections verify capabilities at startup, then /models loads its picker.
  assert.equal(services.catalogCalls.length, 2)
  assert.equal(JSON.parse(await readFile(join(directory, 'preferences.json'))).model, '__refresh')
})
test('session-note default changes independently and applies only to new conversations', async t => {
  const directory = await fixture(t), services = fakeServices()
  await new PreferenceStore(directory).save({ ...base, model: 'gpt-5.1', enableTools: true, enableNotes: true })
  const io = fakeIO([false], [], ['First', '/notes', 'Still first', '/new', 'Second', '/exit']), notes = []
  assert.equal(await run(directory, io, services, (_session, options) => ({ generate: async () => {
    notes.push(options.enableNotes); return answer('Done')
  } })), 0)
  assert.deepEqual(notes, [true, true, false])
  assert.deepEqual(io.choices.map(choice => choice.title), ['Session notes · new-conversation default'])
  assert.equal(services.catalogCalls.length, 0)
  assert.deepEqual(await new PreferenceStore(directory).load(), { ...base, model: 'gpt-5.1', enableTools: true,
    reasoningCapabilities: ['none', 'low', 'medium', 'high'], enableNotes: false })
})
test('every former settings-wizard field is independently reachable from Menu', async t => {
  const routes = [
    { action: '/provider', title: 'Provider' },
    { action: '/models', title: 'Models · openai · fresh' },
    { action: '/effort', title: 'Reasoning effort · gpt-5.1' },
    { action: '/notes', title: 'Session notes · new-conversation default' },
    { action: '/memories', title: 'Persistent memories · disabled for this launch',
      rest: ['default', undefined, 'back'] }
  ]
  for (const route of routes) {
    const directory = await fixture(t), services = fakeServices([{ id: 'gpt-5.1' }])
    await new PreferenceStore(directory).save({ ...base, model: 'gpt-5.1' })
    const before = await readFile(join(directory, 'preferences.json'), 'utf8')
    const io = fakeIO([route.action, ...(route.rest ?? [undefined])], [], ['/menu', '/exit'])
    assert.equal(await run(directory, io, services, () => ({ generate: async () => { throw new Error('Navigation must not call the model') } })), 0)
    const menu = io.choices[0]
    assert.equal(menu.title, 'Conversation actions')
    for (const { action } of routes) assert(menu.values.some(choice => choice.value === action))
    assert(!menu.values.some(choice => choice.value === '/settings' || choice.name === 'Future defaults'))
    assert.match(menu.values.find(choice => choice.value === '/notes').description, /new conversations/)
    assert.equal(io.choices[1].title, route.title)
    assert.deepEqual(io.choices.map(choice => choice.title), route.rest
      ? ['Conversation actions', route.title, 'Persistent memory default · future launches', route.title]
      : ['Conversation actions', route.title])
    assert.equal(await readFile(join(directory, 'preferences.json'), 'utf8'), before)
    assert.equal(services.catalogCalls.length, route.action === '/models' ? 1 : 0)
  }
})

test('legacy /settings opens the same menu and repeated cancellation never begins a wizard or changes saved preferences', async t => {
  const directory = await fixture(t), services = fakeServices()
  await new PreferenceStore(directory).save(base)
  const before = await readFile(join(directory, 'preferences.json'), 'utf8')
  const io = fakeIO([undefined, 'continue', undefined], [], ['/settings', '/settings', '/menu', '/exit'])
  assert.equal(await run(directory, io, services), 0)
  assert.deepEqual(io.choices.map(choice => choice.title), ['Conversation actions', 'Conversation actions', 'Conversation actions'])
  assert.deepEqual(io.choices[0].values, io.choices[2].values)
  assert.equal(await readFile(join(directory, 'preferences.json'), 'utf8'), before)
  assert.equal(services.catalogCalls.length, 0)
  assert.equal(new Set(io.sessions.map(session => session.id)).size, 1)
})

test('note and memory-default picker cancellation preserves every saved preference and the active conversation', async t => {
  const directory = await fixture(t), services = fakeServices()
  await new PreferenceStore(directory).save({ ...base, stream: false, maxRounds: 7, enableNotes: false })
  const before = await readFile(join(directory, 'preferences.json'), 'utf8')
  const io = fakeIO([undefined, 'default', undefined, 'back'], [], ['/notes', '/memories', '/exit'])
  assert.equal(await run(directory, io, services), 0)
  assert.equal(await readFile(join(directory, 'preferences.json'), 'utf8'), before)
  assert.equal(new Set(io.sessions.map(session => session.id)).size, 1)
  assert.equal(services.catalogCalls.length, 0)
  assert(!io.output.includes('default saved'))
})

test('session-note default survives later effort, model and provider changes without borrowing the active default', async t => {
  const directory = await fixture(t), services = fakeServices([{ id: 'gpt-5.1' }, { id: 'gpt-5' }])
  await new PreferenceStore(directory).save({ ...base, model: 'gpt-5.1', enableTools: true, stream: false, maxRounds: 7 })
  const io = fakeIO([false, 'high', 'gpt-5', 'openai', 'current', 'gpt-5.1'], [], ['/notes', '/effort', '/models', '/provider', '/exit']), seen = []
  assert.equal(await run(directory, io, services, (session, options) => {
    seen.push([session.model, options.enableNotes]); return defaultFactory()
  }, [], { OPENAI_API_KEY: 'fake-key' }), 0)
  assert.deepEqual(seen, [['gpt-5.1', true], ['gpt-5.1', false], ['gpt-5', false], ['gpt-5.1', false]])
  const saved = await new PreferenceStore(directory).load()
  assert.equal(saved.enableNotes, false); assert.equal(saved.enableMemory, false)
  assert.equal(saved.stream, false); assert.equal(saved.maxRounds, 7)
})

test('session-note and memory defaults remain configurable before selecting a model', async t => {
  const directory = await fixture(t), services = fakeServices()
  const io = fakeIO([undefined, false, 'default', true, 'back'], [], ['/notes', '/memories', '/exit'])
  assert.equal(await run(directory, io, services, () => { throw new Error('No model selected') }), 0)
  const saved = await new PreferenceStore(directory).load()
  assert.deepEqual(saved, { ...DEFAULT_PREFERENCES, enableNotes: false, enableMemory: true })
  assert.equal(services.catalogCalls.length, 0)
  assert.deepEqual(io.choices.map(choice => choice.title), ['Provider', 'Session notes · new-conversation default',
    'Persistent memories · disabled for this launch', 'Persistent memory default · future launches',
    'Persistent memories · disabled for this launch'])
  assert.match(io.choices[3].values.find(choice => choice.value === true).description, /plaintext.*selected provider/s)
})

test('resume preserves original model, acquires lease before capability confirmation and releases after decline', async t => {
  const directory = await fixture(t), services = fakeServices(), store = new FileSessionStore(directory)
  const saved = newSession({ provider: 'openrouter', model: 'original', reasoning: 'high' }); await store.save(saved)
  const io = fakeIO([], [], ['Continue', '/exit'])
  io.choose = async () => { await assert.rejects(store.acquire(saved.id), /locked/); return true }
  assert.equal(await run(directory, io, services, (session, options) => {
    assert.equal(session.model, 'original'); assert.equal(options.enableTools, false); assert.deepEqual(options.reasoningCapabilities, ['high'])
    return defaultFactory()
  }, ['--resume', saved.id]), 0)
  assert.equal(io.sessions.at(-1).id, saved.id); assert.equal((await store.load(saved.id)).history[1].content, 'Done')
  const decline = fakeIO([false], [], ['/exit'])
  assert.equal(await run(directory, decline, services, () => { throw new Error('must not construct') }, ['--resume', saved.id]), 0)
  await (await store.acquire(saved.id))()
})
test('newly entered keys redact provider errors and are refused in prompts or settings', async t => {
  const directory = await fixture(t), services = fakeServices(), key = 'fake-new-protected-key'
  const io = fakeIO([undefined, 'openai', 'temporary', 'fake-model'], [], ['/provider', '/exit'], [key])
  assert.equal(await run(directory, io, services, () => { throw new Error(`Failure ${key}`) }), 0)
  assert.match(io.output, /Failure \[REDACTED\]/); assert(!io.output.includes(key))
  assert(!(await readdir(directory)).some(file => file.endsWith('.lock')))
})
test('explicit selections cannot borrow saved capability claims and known no-stream models disable streaming', async t => {
  const directory = await fixture(t), services = fakeServices()
  await new PreferenceStore(directory).save({ ...base, reasoning: 'high', reasoningCapabilities: ['high'], enableTools: true })
  for (const args of [['--model', 'different'], ['--provider', 'openrouter', '--model', 'saved-model']]) {
    const io = fakeIO([], [], ['/exit'])
    assert.equal(await run(directory, io, services, (session, options) => { assert.equal(session.reasoning, 'default'); assert.equal(options.enableTools, false); assert.deepEqual(options.reasoningCapabilities, []); return defaultFactory() }, args), 0)
  }
  assert.equal(await run(directory, fakeIO([], [], ['/exit']), services, (_s, o) => { assert.equal(o.stream, false); return defaultFactory() }, ['--model', 'gpt-5.5-pro']), 0)
})
test('unknown slash commands never become provider prompts and line parsing remains explicit', async t => {
  const directory = await fixture(t), services = fakeServices()
  await new PreferenceStore(directory).save(base)
  const io = fakeIO([], [], ['/unknown', '/exit'])
  let calls = 0
  assert.equal(await run(directory, io, services, () => ({ generate: async () => { calls++; return answer('Never') } })), 0)
  assert.equal(calls, 0); assert.match(io.output, /Unknown slash command/)
  assert.throws(() => parseArguments([]), /requires --model/)
  assert.equal(parseArguments([], {}, true).model, undefined)
  assert.equal(parseArguments(['--no-tools', '--enable-notes', '--model', 'fake']).enableTools, false)
})
test('TUI runtime guard rejects absent or old Bun without loading native modules', async () => {
  const { supportsBunTui } = await import('../dist/main.js')
  for (const version of [undefined, '', 'invalid', '0.9.0', '1.2.99']) assert.equal(supportsBunTui(version), false)
  for (const version of ['1.3.0', '1.4.2', '2.0.0']) assert.equal(supportsBunTui(version), true)
})

test('cancelled provider/model change preserves the current conversation and existing defaults', async t => {
  const directory = await fixture(t), services = fakeServices([{ id: 'vendor/router' }])
  await new PreferenceStore(directory).save(base)
  const io = fakeIO(['openrouter', 'temporary', undefined], [], ['/provider', 'Still original', '/exit'], ['fake-new-router-key'])
  const used = []
  assert.equal(await run(directory, io, services, session => ({ generate: async () => { used.push(session.provider); return answer('Original') } })), 0)
  assert.deepEqual(used, ['openai'])
  assert.equal((await new PreferenceStore(directory).load()).provider, 'openai')
  assert.equal(io.sessions.at(-1).model, 'saved-model')
})
test('known model defaults refresh exact capability options and honor explicit no-tools', async t => {
  const directory = await fixture(t), services = fakeServices()
  await new PreferenceStore(directory).save({ ...base, model: 'gpt-5', reasoning: 'none', reasoningCapabilities: ['none'], enableTools: true })
  const io = fakeIO([], [], ['/exit'])
  assert.equal(await run(directory, io, services, (session, options) => {
    assert.equal(session.reasoning, 'default'); assert.equal(options.enableTools, false)
    assert.deepEqual(options.reasoningCapabilities, ['minimal', 'low', 'medium', 'high'])
    return defaultFactory()
  }, ['--no-tools']), 0)
  assert.match(io.output, /no longer verified/)
})

test('authenticated catalog refresh denial exits picker without offering the previous cached catalog', async t => {
  const { ModelCatalog } = await import('../dist/models.js')
  const directory = await fixture(t), services = fakeServices()
  let deny = false
  services.catalog = new ModelCatalog(async () => deny ? new Response('secret-body', { status: 401 }) : new Response(JSON.stringify({ data: [{ id: 'saved-model' }] })))
  await new PreferenceStore(directory).save(base)
  const io = fakeIO([], [], ['/models', '/exit'])
  io.chooseSearchable = async (title, choices) => { io.choices.push({ title, values: choices }); deny = true; return { kind: 'refresh', query: 'saved' } }
  assert.equal(await run(directory, io, services, defaultFactory, [], { OPENAI_API_KEY: 'fake-key' }), 0)
  assert.equal(io.choices.length, 1); assert.match(io.output, /access was denied/)
  assert(!io.output.includes('secret-body'))
  assert.equal((await new PreferenceStore(directory).load()).model, 'saved-model')
})

test('effort/model/provider pickers scope to the resumed current model', async t => {
  const directory = await fixture(t), services = fakeServices([{ id: 'gpt-5' }, { id: 'gpt-5.1' }])
  await new PreferenceStore(directory).save({ ...base, model: 'gpt-5.1' })
  const store = new FileSessionStore(directory)
  const resumed = newSession({ provider: 'openai', model: 'gpt-5', reasoning: 'default' })
  await store.save(resumed)
  const io = fakeIO(['high', 'gpt-5', 'openai', 'current', undefined], [], ['/effort', '/models', '/provider', '/exit']), models = []
  assert.equal(await run(directory, io, services, (session, options) => {
    models.push(session.model)
    assert.deepEqual(options.reasoningCapabilities, ['minimal', 'low', 'medium', 'high'])
    return defaultFactory()
  }, ['--resume', resumed.id], { OPENAI_API_KEY: 'fake-key' }), 0)
  assert.equal(io.choices[0].title, 'Reasoning effort · gpt-5')
  assert.deepEqual(io.choices[0].values.map(v => v.value), ['default', 'minimal', 'low', 'medium', 'high'])
  assert.deepEqual(models, ['gpt-5', 'gpt-5', 'gpt-5'])
  assert.equal(io.choices.find(c => c.title.startsWith('Models ·')).values.findIndex(v => v.value === 'gpt-5'), io.choices.find(c => c.title.startsWith('Models ·')).initial)
  assert.equal((await store.load(resumed.id)).reasoning, 'default')
})

test('unknown conversation eligibility requires a separate explicit choice and picker cancellation is safe', async t => {
  const directory = await fixture(t), services = fakeServices([{ id: 'future-text-model' }])
  services.catalog.list = async provider => ({ state: 'fresh', models: parseModelCatalog(provider, { data: [{ id: 'future-text-model' }] }) })
  const io = fakeIO([undefined, 'future-text-model', undefined, 'future-text-model', true], [], ['/models', '/exit'])
  let calls = 0
  assert.equal(await run(directory, io, services, (session, options) => { calls++; assert.equal(session.model, 'future-text-model'); assert.equal(options.enableTools, false); return defaultFactory() }), 0)
  assert.equal(calls, 1)
  assert.equal(io.choices.filter(c => c.title.startsWith('Text conversation compatibility')).length, 2)
  assert.match(io.choices.find(c => c.title.startsWith('Text conversation compatibility')).values[1].description, /Requests may fail/)
})
test('known nonconversation saved or explicit interactive models never construct a Responses provider', async t => {
  const directory = await fixture(t), services = fakeServices(), io = fakeIO([], [], ['/exit'])
  let calls = 0
  assert.equal(await run(directory, io, services, () => { calls++; return defaultFactory() }, ['--model', 'text-embedding-3-small']), 0)
  assert.equal(calls, 0); assert.match(io.output, /text-conversation endpoint/)
  assert(!(await readdir(directory)).some(file => file.endsWith('.lock')))
})

test('a post-write verification failure is disclosed as uncertain storage, never proof the vault is empty', async t => {
  const directory = await fixture(t), services = fakeServices([{ id: 'gpt-5.1' }], { available: true })
  services.credentials.save = async (provider, key) => { services.vault.set(provider, key); throw new Error('Read-back could not be verified') }
  const io = fakeIO([undefined, 'openai', 'save', false], [], ['/provider', '/exit'], ['fake-key-written-before-verification'])
  assert.equal(await run(directory, io, services), 0)
  assert.equal(services.vault.get('openai'), 'fake-key-written-before-verification')
  const uncertain = io.choices.find(c => c.title === 'Key storage could not be verified')
  assert(uncertain); assert(uncertain.values.every(choice => choice.description.includes('may already contain')))
  assert(!io.output.includes('Key was not saved')); assert.equal(services.catalogCalls.length, 0)
})

test('nonstreaming model capability stays effective-only when effort and model changes preserve user stream preference', async t => {
  const directory = await fixture(t), services = fakeServices([{ id: 'gpt-5.1' }]), seen = []
  await new PreferenceStore(directory).save({ ...base, model: 'gpt-5.5-pro', stream: true })
  const io = fakeIO(['high', 'gpt-5.1'], [], ['/effort', '/models', '/exit'])
  assert.equal(await run(directory, io, services, (session, options) => { seen.push([session.model, options.stream]); return defaultFactory() }), 0)
  assert.deepEqual(seen, [['gpt-5.5-pro', false], ['gpt-5.5-pro', false], ['gpt-5.1', true]])
  assert.equal((await new PreferenceStore(directory).load()).stream, true)
})
test('resuming another supported model keeps launch notes intent and supports an explicit opt-out', async t => {
  const directory = await fixture(t), services = fakeServices(), store = new FileSessionStore(directory)
  await new PreferenceStore(directory).save({ ...base, model: 'gpt-5.1', enableTools: true, enableNotes: true })
  const original = newSession({ provider: 'openai', model: 'gpt-5', reasoning: 'default' }); await store.save(original)
  assert.equal(await run(directory, fakeIO([], [], ['/exit']), services, (_session, options) => {
    assert.equal(options.enableTools, true); assert.equal(options.enableNotes, true); return defaultFactory()
  }, ['--resume', original.id]), 0)
  assert.equal(await run(directory, fakeIO([], [], ['/exit']), services, (_session, options) => {
    assert.equal(options.enableNotes, false); return defaultFactory()
  }, ['--resume', original.id, '--disable-notes']), 0)
})

test('optional OpenRouter token-budget reasoning offers explicit disable and preserves its saved none sentinel', async t => {
  const directory = await fixture(t)
  const services = fakeServices([{ id: 'vendor/budget-only', supported_parameters: ['reasoning'],
    architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    reasoning: { mandatory: false, supports_max_tokens: true } }])
  const io = fakeIO([undefined, 'openrouter', 'temporary', 'vendor/budget-only', 'none'], [],
    ['/provider', '/effort', 'Hello', '/exit'], ['fake-budget-key'])
  const seen = []
  assert.equal(await run(directory, io, services, (session, options) => {
    seen.push(session.reasoning)
    assert.deepEqual(options.reasoningCapabilities, ['none'])
    assert.equal(options.enableTools, false)
    return defaultFactory()
  }), 0)
  assert.deepEqual(seen, ['default', 'none'])
  assert.deepEqual(io.choices.find(choice => choice.title.startsWith('Reasoning effort')).values.map(value => value.value), ['default', 'none'])
  assert.equal((await new PreferenceStore(directory).load()).reasoning, 'none')
  const saved = io.sessions.at(-1)
  assert.equal((await new FileSessionStore(directory).load(saved.id)).reasoning, 'none')
  const next = fakeIO([], [], ['Again', '/exit'])
  assert.equal(await run(directory, next, services, (session, options) => {
    assert.equal(session.reasoning, 'none')
    assert.deepEqual(options.reasoningCapabilities, ['none'])
    return defaultFactory()
  }), 0)
  assert.equal(next.choices.length, 0)
})

test('known non-reasoning and unknown reasoning overrides fall back to default without offering an unverified choice', async t => {
  for (const model of ['gpt-4.1', 'o3-pro']) {
    const directory = await fixture(t)
    await new PreferenceStore(directory).save({ ...base, model, reasoning: 'high', reasoningCapabilities: ['high'] })
    const io = fakeIO(['default'], [], ['/effort', '/exit'])
    assert.equal(await run(directory, io, fakeServices(), (session, options) => {
      assert.equal(session.reasoning, 'default')
      assert.deepEqual(options.reasoningCapabilities, [])
      if (model === 'o3-pro') assert.equal(options.stream, false)
      return defaultFactory()
    }), 0)
    assert.deepEqual(io.choices[0].values.map(value => value.value), ['default'])
    assert.match(io.output, /no longer verified/)
  }
})

test('unknown streaming retains the user toggle while documented unsupported streaming remains effective-only', async t => {
  for (const stream of [true, false]) {
    const directory = await fixture(t)
    await new PreferenceStore(directory).save({ ...base, model: 'future-text-model', stream })
    assert.equal(await run(directory, fakeIO([], [], ['/exit']), fakeServices(), (_session, options) => {
      assert.equal(options.stream, stream)
      assert.equal(options.enableTools, false)
      assert.deepEqual(options.reasoningCapabilities, [])
      return defaultFactory()
    }), 0)
    const saved = newSession({ provider: 'openai', model: 'o3-pro', reasoning: 'default' })
    await new FileSessionStore(directory).save(saved)
    assert.equal(await run(directory, fakeIO([], [], ['/exit']), fakeServices(), (_session, options) => {
      assert.equal(options.stream, false)
      assert.deepEqual(options.reasoningCapabilities, [])
      return defaultFactory()
    }, ['--resume', saved.id]), 0)
    assert.equal((await new PreferenceStore(directory).load()).stream, stream)
  }
})

async function seedMemory(directory, content = 'I prefer concise replies') {
  await writeFile(join(directory, 'memories.json'), JSON.stringify({ version: 1, memories: [{ id: 'seed-memory', content,
    createdAt: '2026-10-01', updatedAt: '2026-10-01', createdBy: 'user', updatedBy: 'user' }] }), { mode: 0o600 })
}
const hasMemory = input => input.messages.some(message => message.content.includes('I prefer concise replies'))

test('default-off TUI memory manager reads no store and Back leaves corrupt evidence untouched', async t => {
  const directory = await fixture(t)
  await new PreferenceStore(directory).save(base)
  await writeFile(join(directory, 'memories.json'), 'corrupt evidence', { mode: 0o600 })
  const io = fakeIO(['back'], [], ['/memories', 'Hello', '/exit'])
  assert.equal(await run(directory, io, fakeServices(), () => ({ generate: async input => {
    assert.equal(hasMemory(input), false); assert.deepEqual(input.tools, []); return answer('Done')
  } })), 0)
  assert.equal(await readFile(join(directory, 'memories.json'), 'utf8'), 'corrupt evidence')
  assert(!(await readdir(directory)).some(name => name.includes('memories.json.') || name.endsWith('.lock')))
  assert.match(io.choices[0].title, /disabled for this launch/)
  assert(io.choices[0].values.some(choice => choice.value === 'on'))
  assert(!io.choices[0].values.some(choice => choice.value === 'add'))
})

test('app-wide memory opt-in survives new, model, other-provider resume and provider transitions without entering history', async t => {
  const directory = await fixture(t), services = fakeServices([{ id: 'gpt-5.1' }, { id: 'gpt-5' }])
  await new PreferenceStore(directory).save({ ...base, model: 'gpt-5.1', enableMemory: true })
  await seedMemory(directory)
  const original = newSession({ provider: 'openrouter', model: 'original-other-model' })
  await new FileSessionStore(directory).save(original)
  const io = fakeIO(['gpt-5', original.id, 'openrouter', 'current', 'gpt-5'], [],
    ['First', '/new', 'Second', '/models', 'Third', '/resume', 'Fourth', '/provider', 'Fifth', '/exit'])
  const launches = []
  assert.equal(await run(directory, io, services, (session, options) => {
    launches.push([session.provider, session.model, options.enableMemory])
    return { generate: async input => { assert.equal(hasMemory(input), true); return answer('Done') } }
  }, [], { OPENAI_API_KEY: 'fake-openai-key', OPENROUTER_API_KEY: 'fake-router-key' }), 0)
  assert.equal(launches.length, 5); assert(launches.every(([, , enabled]) => enabled))
  assert.deepEqual(launches[3].slice(0, 2), ['openrouter', 'original-other-model'])
  assert.equal(io.results.length, 5)
  for (const session of io.sessions) assert(!session.history.some(message => message.content.includes('Saved user memories')))
  assert.equal((await new PreferenceStore(directory).load()).enableMemory, true)
})

test('explicit disable overrides saved default and /memories toggles only this launch across new sessions', async t => {
  const directory = await fixture(t), services = fakeServices()
  await new PreferenceStore(directory).save({ ...base, enableMemory: true })
  await seedMemory(directory)
  const io = fakeIO(['on', 'back', 'off', 'back'], [], ['Before', '/memories', 'Enabled', '/new', 'Still enabled', '/memories', 'Disabled', '/new', 'Still disabled', '/exit'])
  const seen = []
  assert.equal(await run(directory, io, services, () => ({ generate: async input => { seen.push(hasMemory(input)); return answer('Done') } }), ['--disable-memory']), 0)
  assert.deepEqual(seen, [false, true, true, false, false])
  assert.equal((await new PreferenceStore(directory).load()).enableMemory, true)
  assert.equal(JSON.parse(await readFile(join(directory, 'memories.json'), 'utf8')).memories.length, 1)
  assert.match(io.output, /existing records retained/)
})

test('memory-manager future defaults stay distinct from this launch through /new and the next launch', async t => {
  for (const active of [false, true]) {
    const directory = await fixture(t), services = fakeServices([{ id: 'future-selected' }])
    await new PreferenceStore(directory).save({ ...base, enableMemory: active })
    await seedMemory(directory)
    const io = fakeIO(['default', !active, 'back'], [], ['First', '/memories', 'Still first', '/new', 'Second', '/exit'])
    const seen = []
    assert.equal(await run(directory, io, services, () => ({ generate: async input => { seen.push(hasMemory(input)); return answer('Done') } }), [], { OPENAI_API_KEY: 'fake-key' }), 0)
    assert.deepEqual(seen, [active, active, active])
    assert.equal((await new PreferenceStore(directory).load()).enableMemory, !active)
    assert.match(io.output, /Memory default saved for future launches; this launch is unchanged/)
    const next = fakeIO([], [], ['Next launch', '/exit'])
    assert.equal(await run(directory, next, services, () => ({ generate: async input => {
      assert.equal(hasMemory(input), !active); return answer('Done')
    } })), 0)
  }
})

test('TUI manager repeats reviewed actions, refreshes stale revisions, and Back/Cancel never submits', async t => {
  const directory = await fixture(t), services = fakeServices()
  await new PreferenceStore(directory).save({ ...base, enableMemory: true })
  await seedMemory(directory)
  const io = fakeIO(['add', 'add', 'edit', -1, 'edit', 0, 'edit', 0, 'edit', 0, 'delete', 0, 'back'],
    [undefined, 'I prefer careful explanations', undefined, 'Stale edit should fail', 'Fresh approved edit'], ['/memories', '/exit'])
  const approvals = []
  io.approve = async request => {
    approvals.push(request)
    if (approvals.length === 1) return false
    if (approvals.length === 2) {
      const stored = JSON.parse(await readFile(join(directory, 'memories.json'), 'utf8'))
      stored.memories[0].content = 'Changed by another process'
      stored.memories[0].updatedAt = '2026-10-02'
      await writeFile(join(directory, 'memories.json'), JSON.stringify(stored), { mode: 0o600 })
    }
    return true
  }
  assert.equal(await run(directory, io, services), 0)
  assert.deepEqual(approvals.map(request => request.call.name), ['create_memory', 'edit_memory', 'edit_memory', 'delete_memory'])
  assert.equal(approvals[1].currentRevision !== approvals[2].currentRevision, true)
  assert.match(approvals[2].description, /Changed by another process/)
  assert.match(approvals[2].description, /Fresh approved edit/)
  assert.match(io.output, /[Ss]tale memory revision/)
  assert.match(io.output, /Memory change denied/)
  assert.equal(JSON.parse(await readFile(join(directory, 'memories.json'), 'utf8')).memories.length, 0)
  assert(io.choices.filter(choice => choice.title.startsWith('Persistent memories')).length > 6)
})

test('memory can be enabled or disabled before model setup without reading or creating its store', async t => {
  const directory = await fixture(t), io = fakeIO([undefined, 'on', 'off', 'back'], [], ['/memories', '/exit'])
  let calls = 0
  assert.equal(await run(directory, io, fakeServices(), () => { calls++; return defaultFactory() }), 0)
  assert.equal(calls, 0); assert.deepEqual(await readdir(directory), [])
  assert.match(io.output, /Choose a model.*before listing or changing/)
})

test('unknown saved and resumed models omit tools without a current declaration while memory context stays enabled', async t => {
  const directory = await fixture(t), services = fakeServices()
  await new PreferenceStore(directory).save({ ...base, enableTools: true, enableMemory: true })
  await seedMemory(directory)
  const resumed = newSession({ provider: 'openrouter', model: 'unverified-resume-model' })
  await new FileSessionStore(directory).save(resumed)
  for (const [args, expected] of [[[], false], [['--tools'], true], [['--tools', '--no-tools'], false],
    [['--resume', resumed.id], false], [['--resume', resumed.id, '--tools'], true],
    [['--resume', resumed.id, '--tools', '--no-tools'], false]]) {
    const io = fakeIO([], [], ['Hello', '/exit'])
    assert.equal(await run(directory, io, services, (_session, options) => {
      assert.equal(options.enableTools, expected)
      return { generate: async input => {
        assert.equal(input.tools.length > 0, expected); assert.equal(hasMemory(input), true); return answer('Done')
      } }
    }, args), 0)
  }
})

test('verified unsupported tool metadata overrides an explicit launch declaration without disabling memory context', async t => {
  const directory = await fixture(t), services = fakeServices()
  await new PreferenceStore(directory).save({ ...base, enableTools: true, enableMemory: true })
  await seedMemory(directory)
  services.catalog.list = async () => ({ state: 'fresh', models: [{ ...unknownModel(base.model), conversation: 'supported', tools: 'unsupported' }] })
  const seen = [], io = fakeIO([base.model], [], ['Before verification', '/models', 'After verification', '/exit'])
  assert.equal(await run(directory, io, services, (_session, options) => {
    seen.push(options.enableTools)
    return { generate: async input => { assert.equal(hasMemory(input), true); return answer('Done') } }
  }, ['--tools']), 0)
  assert.deepEqual(seen, [true, false])
})

test('context menu/commands stay out of user history, compact only eligible history and retain discoverable usage', async t => {
  const directory = await fixture(t)
  await new PreferenceStore(directory).save(base)
  const lines = [0, 1, 2, 3, 4].map(i => `User request ${i}: ${'historical source '.repeat(100)}`)
  const io = fakeIO(['/compact', 'continue'], [], [...lines, '/menu', '/context', '/session', '/menu', '/exit'])
  io.contexts = []; io.setContext = (usage, canCompact) => io.contexts.push({ usage, canCompact })
  let generations = 0, summaries = 0
  await run(directory, io, fakeServices(), () => ({ async generate(input, _signal, options) {
    if (options?.purpose === 'context-summary') { summaries++; assert.deepEqual(input.tools, []); return answer('Historical user goals and constraints') }
    generations++; return answer('Response '.repeat(100))
  } }))
  assert.equal(generations, 5); assert.equal(summaries, 1)
  const menus = io.choices.filter(choice => choice.title === 'Conversation actions')
  assert(menus[0].values.some(choice => choice.value === '/compact'))
  assert(!menus[1].values.some(choice => choice.value === '/compact'))
  assert(menus.every(menu => menu.values.some(choice => choice.value === '/context')))
  assert.match(io.output, /Output reserve: 4096 tokens/); assert.match(io.output, /Session tokens:/)
  assert.match(io.output, /Context-summary tokens \(reported separately\): unreported/)
  assert(io.contexts.some(context => context.canCompact)); assert.equal(io.contexts.at(-1).canCompact, false)
  const latest = (await new FileSessionStore(directory).load(io.sessions.at(-1).id))
  assert.equal(latest.history.filter(message => message.kind === 'message').length, 5)
  assert(!latest.history.some(message => message.content === '/compact' || message.content === '/context'))
})

test('one-shot context details are local-only and do not become a model prompt', async t => {
  const directory = await fixture(t), io = fakeIO()
  let calls = 0
  const code = await run(directory, io, fakeServices(), () => ({ async generate() { calls++; return answer('Unexpected') } }), ['--model', 'fake-model', '--prompt', '/context'])
  assert.equal(code, 0); assert.equal(calls, 0); assert.match(io.output, /Capacity: unknown/)
  assert.equal(io.sessions.at(-1).history.length, 0)
})

for (const [initial, refreshed] of [[8000, 16000], [16000, 8000]]) test(`cancelled catalog picker updates the active model capacity ${initial} to ${refreshed}`, async t => {
  const directory = await fixture(t), io = fakeIO([undefined], [], ['/context', '/models', '/context', '/exit'])
  const services = fakeServices(); let lists = 0
  services.catalog.list = async () => ({ state: 'fresh', models: parseModelCatalog('openrouter', { data: [{ id: 'vendor/model',
    architecture: { input_modalities: ['text'], output_modalities: ['text'] }, context_length: ++lists === 1 ? initial : refreshed }] }) })
  const code = await run(directory, io, services, defaultFactory, ['--provider', 'openrouter', '--model', 'vendor/model'], { OPENROUTER_API_KEY: 'offline-key' })
  assert.equal(code, 0)
  const capacities = [...io.output.matchAll(/Capacity: (\d+)/g)].map(match => Number(match[1]))
  assert.deepEqual(capacities, [initial, refreshed])
})

test('cold resume never falls back to generation after catalog authentication denial', async t => {
  const { ModelCatalog } = await import('../dist/models.js')
  const directory = await fixture(t), session = newSession({ provider: 'openrouter', model: 'vendor/model' })
  await new FileSessionStore(directory).save(session)
  const io = fakeIO([], [], ['Hello', '/exit']), services = fakeServices()
  services.catalog = new ModelCatalog(async () => new Response('{}', { status: 401 }))
  let factories = 0, calls = 0
  await run(directory, io, services, () => { factories++; return { async generate() { calls++; return answer('Unexpected') } } },
    ['--resume', session.id], { OPENROUTER_API_KEY: 'offline-key' })
  assert.equal(factories, 0); assert.equal(calls, 0); assert.match(io.output, /Model access was denied/)
})

test('accessible one-shot context details use documented model capacity without a provider call', async t => {
  const directory = await fixture(t), io = fakeIO(); let calls = 0
  const code = await main(['--no-tui', '--no-workspace', '--no-skills', '--model', 'gpt-4.1', '--prompt', '/context'],
    { VIVI_SESSION_DIR: directory }, { io, providerFactory: () => ({ async generate() { calls++; throw new Error('Unexpected') } }) })
  assert.equal(code, 0); assert.equal(calls, 0); assert.match(io.output, /Capacity: 1047576/)
})

test('accessible small-model limits block an oversized current prompt before generation', async t => {
  const directory = await fixture(t), io = fakeIO(); let calls = 0
  const catalog = { async list() { return { state: 'fresh', models: parseModelCatalog('openrouter', { data: [{ id: 'vendor/small', context_length: 100 }] }) } } }
  const code = await main(['--no-tui', '--no-workspace', '--no-skills', '--provider', 'openrouter', '--model', 'vendor/small', '--prompt', 'Current prompt '.repeat(100)],
    { VIVI_SESSION_DIR: directory, OPENROUTER_API_KEY: 'offline-key' }, { io, catalog,
      providerFactory: () => ({ async generate() { calls++; return answer('Unexpected') } }) })
  assert.equal(code, 1); assert.equal(calls, 0); assert.equal(io.results[0].error.code, 'context_cannot_fit')
})

test('returning from idle skill and memory management clears stale request details', async t => {
  const directory = await fixture(t); await new PreferenceStore(directory).save(base)
  const io = fakeIO(['back', 'back'], [], ['/context', '/skills', '/session', '/memories', '/session', '/exit'])
  const contexts = []; io.setContext = usage => contexts.push(usage)
  await run(directory, io, fakeServices())
  assert.equal([...io.output.matchAll(/Input: not measured yet/g)].length, 2)
  assert.equal(contexts.at(-1), undefined)
})

test('actual accessible one-shot context still measures after ordinary stdin EOF', async t => {
  const { PassThrough } = await import('node:stream'), { TerminalIO } = await import('../dist/terminal.js')
  const directory = await fixture(t), input = new PassThrough(), output = new PassThrough(); let text = ''
  output.on('data', chunk => { text += chunk })
  const io = new TerminalIO({ input, output, tui: false }); input.end(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(io.isClosed, true); assert.equal(io.isDisposed, false)
  const code = await main(['--no-tui', '--no-workspace', '--no-skills', '--model', 'gpt-4.1', '--prompt', '/context'],
    { VIVI_SESSION_DIR: directory }, { io, providerFactory: () => ({ async generate() { throw new Error('No provider expected') } }) })
  assert.equal(code, 0); assert.match(text, /Capacity: 1047576/)
})

for (const cancel of [false, true]) test(`actual accessible one-shot compact after EOF ${cancel ? 'cancels with status130' : 'persists its checkpoint'}`, async t => {
  const { PassThrough } = await import('node:stream'), { TerminalIO } = await import('../dist/terminal.js')
  const directory = await fixture(t), session = newSession({ provider: 'openai', model: 'offline-context-model' })
  session.history = Array.from({ length: 12 }, (_, i) => i % 2 ? { kind: 'assistant', content: 'Historical answer '.repeat(100), toolCalls: [] }
    : { kind: 'message', role: 'user', content: `Historical request ${i} ${'source '.repeat(100)}` })
  const store = new FileSessionStore(directory); await store.save(session)
  const input = new PassThrough(), output = new PassThrough(); let text = '', calls = 0, release
  output.on('data', chunk => { text += chunk })
  const io = new TerminalIO({ input, output, tui: false }); input.end(); await new Promise(resolve => setImmediate(resolve))
  const code = await main(['--no-tui', '--no-workspace', '--no-skills', '--resume', session.id, '--prompt', '/compact'],
    { VIVI_SESSION_DIR: directory }, { io, providerFactory: () => ({ async generate(input_, _signal, options) {
      calls++; assert.equal(options.purpose, 'context-summary'); assert.deepEqual(input_.tools, [])
      if (cancel) { queueMicrotask(() => input.emit('keypress', '', { name: 'escape' })); return new Promise(resolve => { release = resolve }) }
      return answer('Historical goals and observations')
    } }) })
  assert.equal(code, cancel ? 130 : 0); assert.equal(calls, 1)
  const saved = await store.load(session.id)
  assert.deepEqual(saved.history, session.history)
  if (cancel) {
    assert.equal(saved.contextCheckpoint, undefined); assert.equal(saved.contextSummaryUnreported, true)
    release(answer('Late summary')); await new Promise(resolve => setImmediate(resolve))
    assert.match(text, /compaction cancelled/)
  } else { assert(saved.contextCheckpoint); assert.match(text, /Context compacted/) }
})
