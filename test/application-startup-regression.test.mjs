// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../dist/main.js'
import { DEFAULT_PREFERENCES } from '../dist/application.js'
import { PreferenceStore } from '../dist/preferences.js'
import { ModelCatalog, parseModelCatalog } from '../dist/models.js'
import { WORKSPACE_TOOL_NAMES } from '../dist/workspace.js'

const modelId = 'vendor/startup-chat'
const modelData = (supported_parameters = ['tools', 'tool_choice']) => ({ id: modelId,
  supported_parameters, architecture: { input_modalities: ['text'], output_modalities: ['text'] } })
const preferencesFor = changes => ({ ...DEFAULT_PREFERENCES, provider: 'openrouter', model: modelId,
  enableTools: true, ...changes })
const answer = () => ({ content: 'Done', toolCalls: [] })

async function fixture(t, settings = preferencesFor()) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-startup-tools-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'project'), state = join(directory, 'state')
  await mkdir(workspace)
  await writeFile(join(workspace, 'readme.txt'), 'Startup workspace fixture\n')
  if (settings) await new PreferenceStore(state).save(settings)
  return { directory, workspace, state }
}
function fakeIO(lines, choices = []) {
  return { output: '', sessions: [], results: [], closed: false, choices: [],
    get isClosed() { return this.closed },
    async readLine() { return lines.shift() },
    async choose(title, values) {
      this.choices.push(title)
      const value = choices.shift()
      if (value !== undefined) assert(values.some(item => item.value === value), `${value} absent from ${title}`)
      return value
    },
    async chooseSearchable(title, values) {
      this.choices.push(title)
      const value = choices.shift()
      if (value === undefined) return
      assert(values.some(item => item.value === value), `${value} absent from ${title}`)
      return { kind: 'selected', value, query: '' }
    },
    async askText() {}, setDraft() {}, setWorkspace() {},
    setSession(session) { this.sessions.push(structuredClone(session)) },
    write(text) { this.output += text }, event() {}, result(result) { this.results.push(result) },
    async approve() { return false },
    onCancel(callback) { this.cancel = callback; return () => { this.cancel = undefined } },
    close() { this.closed = true }
  }
}
function services(data = [modelData()]) {
  const calls = [], loads = []
  return { calls, loads,
    credentials: { async load(provider) { loads.push(provider); return 'fake-startup-key' },
      async status() { return { available: false, label: 'Fixture vault' } }, async save() { assert.fail('must not save keys') } },
    catalog: { async list(provider, key, signal, refresh) {
      assert(!signal?.aborted)
      calls.push({ provider, key, refresh })
      return { models: parseModelCatalog(provider, { data }), state: 'fresh' }
    } }
  }
}
async function run(context, io, supplied, args = [], factory) {
  return main(args, { VIVI_SESSION_DIR: context.state }, { launchDirectory: context.workspace,
    tuiIO: io, credentials: supplied.credentials, catalog: supplied.catalog,
    providerFactory: factory ?? (() => ({ generate: async () => answer() })) })
}
function inspectTurns(launches, turns) {
  return (session, options) => {
    launches.push({ id: session.id, tools: options.enableTools })
    return { async generate(input) {
      turns.push(input.tools.map(tool => tool.name))
      return answer()
    } }
  }
}

function assertToolTurns(enabled, launches, turns) {
  assert.deepEqual(launches.map(launch => launch.tools), launches.map(() => enabled))
  for (const tools of turns) assert.deepEqual(tools.filter(name => WORKSPACE_TOOL_NAMES.includes(name)),
    enabled ? WORKSPACE_TOOL_NAMES : [])
}

test('saved OpenRouter tools are available in the actual first provider turn and unchanged by plain /new', async t => {
  const context = await fixture(t), supplied = services(), io = fakeIO(['First', '/new', 'Second', '/exit'])
  const launches = [], turns = []
  assert.equal(await run(context, io, supplied, [], inspectTurns(launches, turns)), 0)
  assert.equal(supplied.calls.length, 1)
  assert.deepEqual(supplied.calls[0], { provider: 'openrouter', key: 'fake-startup-key', refresh: undefined })
  assert.equal(turns.length, 2)
  assert.deepEqual(turns[0], turns[1])
  assertToolTurns(true, launches, turns)
  assert.notEqual(launches[0].id, launches[1].id)
  assert.equal(io.choices.length, 0)
})

test('startup tools can actually read a workspace file before any model picker or /new', async t => {
  const context = await fixture(t), supplied = services(), io = fakeIO(['Read readme.txt', '/exit'])
  let rounds = 0
  assert.equal(await run(context, io, supplied, [], () => ({ async generate(input) {
    rounds++
    assert(input.tools.some(tool => tool.name === 'workspace_read'))
    if (rounds === 1) return { content: '', toolCalls: [{ id: 'startup-read', name: 'workspace_read', arguments: { path: 'readme.txt' } }] }
    const result = input.messages.find(message => message.kind === 'tool_result')
    assert(result)
    assert.equal(JSON.parse(result.content).content, 'Startup workspace fixture\n')
    return answer()
  } })), 0)
  assert.equal(rounds, 2)
  assert.equal(io.results[0].status, 'completed')
})

test('saved startup and verified /settings then /new use the same workspace tools without changing the active host', async t => {
  const context = await fixture(t), supplied = services()
  const io = fakeIO(['First', '/settings', 'Still first', '/new', 'Second', '/exit'],
    ['openrouter', 'current', modelId, 'default', false, false])
  const launches = [], turns = []
  assert.equal(await run(context, io, supplied, [], inspectTurns(launches, turns)), 0)
  assert.equal(launches.length, 2)
  assert.equal(turns.length, 3)
  assert.deepEqual(turns[0], turns[1])
  assertToolTurns(true, launches, turns)
  assert.deepEqual(turns[0], turns[2])
})

test('known-supported fresh OpenRouter selection hydrates without borrowing saved model capabilities', async t => {
  const context = await fixture(t, preferencesFor({ model: 'vendor/old', enableTools: false }))
  const supplied = services(), launches = [], turns = [], io = fakeIO(['First', '/new', 'Second', '/exit'])
  assert.equal(await run(context, io, supplied, ['--model', modelId], inspectTurns(launches, turns)), 0)
  assert.equal(launches.length, 2)
  assert.equal(turns.length, 2)
  assertToolTurns(true, launches, turns)
  assert.equal((await new PreferenceStore(context.state).load()).model, 'vendor/old')
})

test('fresh explicit OpenRouter model discovers tool capabilities without saved preferences or provider probes', async t => {
  const context = await fixture(t, null), supplied = services(), launches = [], turns = []
  assert.equal(await run(context, fakeIO(['First', '/exit']), supplied, ['--provider', 'openrouter', '--model', modelId],
    inspectTurns(launches, turns)), 0)
  assert.equal(launches.length, 1)
  assert.equal(turns.length, 1)
  assert.equal(supplied.calls.length, 1)
  assertToolTurns(true, launches, turns)
  assert.equal(await new PreferenceStore(context.state).load(), undefined)
})

test('startup reasoning uses verified catalog efforts and resets incompatible saved defaults before creating the session', async t => {
  for (const efforts of [['high'], ['low']]) {
    const context = await fixture(t, preferencesFor({ reasoning: 'high', reasoningCapabilities: ['high'] }))
    const supplied = services([{ ...modelData(), reasoning: { supported_efforts: efforts, mandatory: true } }])
    const io = fakeIO(['First', '/exit']), selected = []
    assert.equal(await run(context, io, supplied, [], (session, options) => {
      selected.push({ reasoning: session.reasoning, capabilities: options.reasoningCapabilities })
      return { generate: async () => answer() }
    }), 0)
    assert.deepEqual(selected, [{ reasoning: efforts.includes('high') ? 'high' : 'default', capabilities: efforts }])
    assert.equal(io.choices.length, 0)
    assert.equal(io.results[0].status, 'completed')
    assert.equal((await new PreferenceStore(context.state).load()).reasoning, 'high')
    if (!efforts.includes('high')) assert.match(io.output, /no longer verified/)
  }
})

test('saved OpenRouter tools-off and explicit --no-tools survive startup verification and /new', async t => {
  for (const [settings, args] of [[preferencesFor({ enableTools: false }), []], [preferencesFor(), ['--no-tools']],
    [preferencesFor(), ['--tools', '--no-tools']]]) {
    const context = await fixture(t, settings), supplied = services(), launches = [], turns = []
    assert.equal(await run(context, fakeIO(['First', '/new', 'Second', '/exit']), supplied, args,
      inspectTurns(launches, turns)), 0)
    assert.equal(turns.length, 2)
    assertToolTurns(false, launches, turns)
    assert.equal((await new PreferenceStore(context.state).load()).enableTools, settings.enableTools)
  }
})

test('unknown, absent and known-unsupported startup metadata never grants tools from saved defaults', async t => {
  for (const data of [[{ id: modelId, architecture: { input_modalities: ['text'], output_modalities: ['text'] } }],
    [{ ...modelData(), id: 'vendor/different' }], [modelData([])]]) {
    const context = await fixture(t), supplied = services(data), launches = [], turns = []
    assert.equal(await run(context, fakeIO(['First', '/new', 'Second', '/exit']), supplied, [],
      inspectTurns(launches, turns)), 0)
    assert.equal(turns.length, 2)
    assertToolTurns(false, launches, turns)
  }
})

test('explicit tool declarations stay scoped and known unsupported metadata defeats them at startup', async t => {
  for (const [data, expected] of [[[{ id: modelId, architecture: { input_modalities: ['text'], output_modalities: ['text'] } }], true],
    [[modelData([])], false]]) {
    const context = await fixture(t), supplied = services(data), launches = [], turns = []
    assert.equal(await run(context, fakeIO(['First', '/new', 'Second', '/exit']), supplied, ['--tools'],
      inspectTurns(launches, turns)), 0)
    assert.equal(turns.length, 2)
    assertToolTurns(expected, launches, turns)
  }
})

test('unavailable startup catalog retains chat-only behavior without a hidden provider probe', async t => {
  const context = await fixture(t), supplied = services(), launches = [], turns = [], io = fakeIO(['First', '/new', 'Second', '/exit'])
  supplied.catalog.list = async () => { throw new Error('Fixture catalog offline') }
  assert.equal(await run(context, io, supplied, [], inspectTurns(launches, turns)), 0)
  assert.equal(turns.length, 2)
  assertToolTurns(false, launches, turns)
  assert.match(io.output, /Fixture catalog offline/)
  assert(!io.output.includes('fake-startup-key'))
  assert.equal((await new PreferenceStore(context.state).load()).enableTools, true)
})

test('stale startup metadata is disclosed, while access denial never reuses a cached tool catalog or constructs a provider', async t => {
  const context = await fixture(t), supplied = services(), launches = [], turns = []
  let now = 0, response = 200, requests = 0
  supplied.catalog = new ModelCatalog(async (_url, request) => {
    requests++
    assert.equal(request.headers.Authorization, 'Bearer fake-startup-key')
    return response === 200 ? new Response(JSON.stringify({ data: [modelData()] })) : new Response('fake-private-response', { status: response })
  }, () => now)
  await supplied.catalog.list('openrouter', 'fake-startup-key')
  now = 20 * 60 * 1000; response = 503
  const staleIO = fakeIO(['First', '/new', 'Second', '/exit'])
  // The native setSession rebuild clears loading output. Disclosure must survive it.
  staleIO.setSession = session => { staleIO.sessions.push(structuredClone(session)); staleIO.output = '' }
  let disclosedBeforeFirstTurn = false
  const factory = inspectTurns(launches, turns)
  assert.equal(await run(context, staleIO, supplied, [], (session, options) => {
    const provider = factory(session, options)
    return { async generate(input) {
      if (!turns.length) disclosedBeforeFirstTurn = /stale cached catalog/.test(staleIO.output)
      return provider.generate(input)
    } }
  }), 0)
  assert.equal(turns.length, 2)
  assertToolTurns(true, launches, turns)
  assert.equal(disclosedBeforeFirstTurn, true)
  response = 403
  const deniedIO = fakeIO(['First', '/new', 'Second', '/exit'])
  let providers = 0
  assert.equal(await run(context, deniedIO, supplied, ['--tools'], () => { providers++; return { generate: async () => answer() } }), 0)
  assert.equal(providers, 0)
  assert.match(deniedIO.output, /access was denied/)
  assert(!deniedIO.output.includes('fake-private-response'))
  assert(requests >= 3)
  assert(!(await readdir(context.state)).some(file => file.endsWith('.lock')))
  assert.equal((await new PreferenceStore(context.state).load()).enableTools, true)
})

test('cancelled startup metadata loading does not construct a provider or save a session', async t => {
  const context = await fixture(t), supplied = services(), io = fakeIO(['/exit'])
  supplied.catalog.list = async (_provider, _key, signal) => { io.cancel(); assert.equal(signal.aborted, true); throw new Error('cancelled') }
  let providers = 0
  assert.equal(await run(context, io, supplied, [], () => { providers++; return { generate: async () => answer() } }), 0)
  assert.equal(providers, 0)
  assert.deepEqual(await readdir(context.state), ['preferences.json'])
  assert(!io.output.includes('cancelled'))
})

test('normal first-time provider/model setup uses its verified catalog without a second startup discovery call', async t => {
  const context = await fixture(t, null), supplied = services(), io = fakeIO(['/models', 'First', '/new', 'Second', '/exit'], [modelId])
  // Start in an unconfigured OpenRouter draft; no key is saved during model setup.
  await new PreferenceStore(context.state).save({ ...DEFAULT_PREFERENCES, provider: 'openrouter' })
  const launches = [], turns = []
  assert.equal(await run(context, io, supplied, [], inspectTurns(launches, turns)), 0)
  assert.equal(supplied.calls.length, 1)
  assert.equal(turns.length, 2)
  assertToolTurns(true, launches, turns)
})
