// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { CliHost } from '../dist/host.js'
import { FileMemoryStore } from '../dist/memory.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { ReadOnlyWorkspace, WORKSPACE_TOOL_NAMES } from '../dist/workspace.js'
import { createBuiltinToolset } from '../dist/tools.js'
import { main, parseArguments } from '../dist/main.js'
import { runApplication } from '../dist/application.js'

const answer = () => ({ content: 'Done', toolCalls: [] })
const call = (name, arguments_ = {}, id = 'workspace-call') => ({ id, name, arguments: arguments_ })
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-workspace-host-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'project')
  const { mkdir } = await import('node:fs/promises'); await mkdir(root)
  await writeFile(join(root, 'readme.txt'), 'Ordinary project context')
  return { directory, root, workspace: await ReadOnlyWorkspace.open(root), store: new FileSessionStore(join(directory, 'state')) }
}
function fakeIO(lines = []) {
  return { output: '', results: [], async readLine() { return lines.shift() },
    write(value) { this.output += value }, event() {}, result(value) { this.results.push(value) },
    async approve() { throw new Error('Read tools never request write approval') },
    onCancel() { return () => {} }, close() {}, setSession() {}, setDraft() {},
    async choose() { return undefined }, async chooseSearchable() { return undefined }, async askText() { return undefined } }
}

test('argument parsing without a CLI launch directory and library toolsets keep workspace access explicit', () => {
  assert.equal(parseArguments(['--model', 'fixture'], { VIVI_WORKSPACE: '/unused' }).workspace, undefined)
  assert.equal(parseArguments(['--model', 'fixture', '--workspace', 'project']).workspace, 'project')
  assert.equal(parseArguments(['--model', 'fixture', '--workspace', 'one', '--workspace', 'two']).workspace, 'two')
  assert.equal(parseArguments(['--model', 'fixture', '--workspace', 'project', '--no-tools']).enableTools, false)
  assert.throws(() => parseArguments(['--model', 'fixture', '--workspace']), /Missing option/)
  assert(!createBuiltinToolset().tools.some(tool => WORKSPACE_TOOL_NAMES.includes(tool.name)))
})

test('workspace tool names are reserved even when disabled', () => {
  for (const name of WORKSPACE_TOOL_NAMES) assert.throws(() => createBuiltinToolset(false, [{ id: 'fixture', apiVersion: 1, tools: [{
    definition: { name, description: 'Fixture', parameters: {} }, validateArguments() {}, execute() { return { content: '' } }
  }] }]), /Tool name collision/)
})

test('host pairs workspace definitions with read-only execution and persists only canonical results', async t => {
  const { directory, root, workspace, store } = await fixture(t)
  const memory = new FileMemoryStore(join(directory, 'state'))
  await memory.commit(await memory.prepareCreate('Use fixture context', 'user'))
  let rounds = 0
  const host = await CliHost.create({ settings: { provider: 'openai', model: 'fixture' }, store, workspace, memory,
    enableMemory: true, enableNotes: true, provider: { async generate({ messages, tools }) {
      assert(tools.some(tool => tool.name === 'workspace_read'))
      assert(tools.some(tool => tool.name === 'list_memories'))
      assert(tools.some(tool => tool.name === 'note_set'))
      assert(messages.some(message => message.role === 'system' && /untrusted data/.test(message.content)))
      if (++rounds === 1) return { content: '', toolCalls: [call('workspace_read', { path: 'readme.txt' })] }
      assert.equal(JSON.parse(messages.at(-1).content).content, 'Ordinary project context')
      assert.equal(JSON.parse(messages.at(-1).content).untrusted, true)
      return answer()
    } } })
  const result = await host.send('Read the selected project')
  assert.equal(result.status, 'completed')
  assert.deepEqual((await store.load(host.session.id)).history, result.history)
  assert(!result.history.some(message => message.role === 'system'))
  const encoded = await readFile(join(directory, 'state', `${host.session.id}.json`), 'utf8')
  assert(!encoded.includes(root))
  assert.equal(host.session.noteRevision, 0)
  assert.deepEqual(await readdir(root), ['readme.txt'])
  const resumed = await CliHost.resume({ id: host.session.id, store, provider: { async generate({ tools }) {
    assert(!tools.some(tool => WORKSPACE_TOOL_NAMES.includes(tool.name))); return answer()
  } } })
  assert.equal((await resumed.send('Continue without workspace selection')).status, 'completed')
})

test('chat-only capability omits workspace tools and context without reading files', async t => {
  const { root, workspace, store } = await fixture(t)
  await writeFile(join(root, '.gitignore'), 'x'.repeat(20 * 1024))
  let rounds = 0
  const host = await CliHost.create({ settings: { provider: 'openai', model: 'fixture' }, store, workspace,
    enableTools: false, provider: { async generate({ tools, messages }) {
      assert.deepEqual(tools, []); assert(!messages.some(message => message.role === 'system'))
      if (++rounds === 1) return { content: '', toolCalls: [call('workspace_read', { path: 'readme.txt' })] }
      return answer()
    } } })
  const result = await host.send('Chat only')
  assert.equal(result.status, 'completed')
  const refused = result.history.find(message => message.kind === 'tool_result')
  assert(refused?.isError)
  assert.match(refused.content, /unavailable|not.*registered|not.*available/i)
  assert(!refused.content.includes('Ordinary project context'))
})

test('late-known workspace credentials block the next provider call', async t => {
  const { workspace, store, root } = await fixture(t)
  const secrets = []
  await writeFile(join(root, 'readme.txt'), 'Ordinary late-known-fixture context')
  let calls = 0
  const host = await CliHost.create({ settings: { provider: 'openai', model: 'fixture' }, store, workspace, secrets,
    provider: { async generate() { calls++; return { content: '', toolCalls: [call('workspace_read', { path: 'readme.txt' })] } } },
    onEvent(event) { if (event.type === 'tool_completed') secrets.push('late-known-fixture') } })
  const result = await host.send('Read fixture')
  assert.equal(result.status, 'error')
  assert.equal(calls, 1)
  assert.match(result.error.message, /known credential/)
})

test('public host propagates its known credentials into an independently constructed workspace adapter', async t => {
  const { workspace, root, store } = await fixture(t)
  await writeFile(join(root, 'readme.txt'), 'Fixture includes host-known-value')
  let calls = 0
  const host = await CliHost.create({ settings: { provider: 'openai', model: 'fixture' }, store, workspace,
    secrets: ['host-known-value'], provider: { async generate({ messages }) {
      if (++calls === 1) return { content: '', toolCalls: [call('workspace_read', { path: 'readme.txt' })] }
      const result = JSON.parse(messages.at(-1).content)
      assert.equal(result.success, false); assert(!messages.at(-1).content.includes('host-known-value'))
      return answer()
    } } })
  assert.equal((await host.send('Read ordinary fixture')).status, 'completed')
  assert(!JSON.stringify(host.session).includes('host-known-value'))
})

test('host credentials registered during read I/O are withheld before events and persistence', async t => {
  const { workspace, root, store } = await fixture(t), secrets = []
  await writeFile(join(root, 'readme.txt'), 'Fixture includes newly-known-while-reading')
  const open = fs.open
  t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await open(path, ...args)
    if (basename(String(path)) === 'readme.txt') secrets.push('newly-known-while-reading')
    return handle
  })
  let calls = 0
  const host = await CliHost.create({ settings: { provider: 'openai', model: 'fixture' }, store, workspace, secrets,
    provider: { async generate({ messages }) {
      if (++calls === 1) return { content: '', toolCalls: [call('workspace_read', { path: 'readme.txt' })] }
      assert.equal(JSON.parse(messages.at(-1).content).success, false)
      assert(!messages.at(-1).content.includes('newly-known-while-reading'))
      return answer()
    } }, onEvent(event) {
      if (event.type === 'tool_completed') assert(!event.message.content.includes('newly-known-while-reading'))
    } })
  assert.equal((await host.send('Read ordinary fixture')).status, 'completed')
  assert(!JSON.stringify(await store.load(host.session.id)).includes('newly-known-while-reading'))
})

test('line launch selects a folder for the launch and keeps capability gating explicit', async t => {
  const { root, directory } = await fixture(t)
  for (const declared of [true, false]) {
    const io = fakeIO()
    let calls = 0
    const code = await main(['--no-tui', '--model', 'fixture', '--session-dir', join(directory, declared ? 'declared' : 'unknown'),
      '--workspace', root, '--prompt', 'Read fixture', ...(declared ? ['--tools'] : [])], {}, {
      io, providerFactory: () => ({ async generate({ tools }) {
        assert.equal(tools.some(tool => tool.name === 'workspace_read'), declared)
        if (declared && ++calls === 1) return { content: '', toolCalls: [call('workspace_read', { path: 'readme.txt' })] }
        return answer()
      } }) })
    assert.equal(code, 0)
    assert.match(io.output, /reads and reviewed text edits for this launch/)
    assert.match(io.output, /sent to the selected provider and saved/)
    if (!declared) assert.match(io.output, /tools unavailable/)
  }
})

test('line launch protects an active custom state folder inside the workspace', async t => {
  const { root } = await fixture(t)
  const io = fakeIO(), state = join(root, 'private-state')
  let calls = 0
  const code = await main(['--no-tui', '--model', 'fixture', '--tools', '--workspace', root, '--session-dir', state,
    '--prompt', 'List the selected project'], {}, { io, providerFactory: () => ({ async generate({ messages }) {
      if (++calls === 1) return { content: '', toolCalls: [call('workspace_list')] }
      assert.deepEqual(JSON.parse(messages.at(-1).content).entries, [{ path: 'readme.txt', kind: 'file' }])
      return answer()
    } }) })
  assert.equal(code, 0)
  const denied = fakeIO()
  const rejected = await main(['--no-tui', '--model', 'fixture', '--workspace', state, '--session-dir', state,
    '--prompt', 'Read fixture'], {}, { io: denied, providerFactory() { throw new Error('No provider expected') } })
  assert.equal(rejected, 1); assert.match(denied.output, /outside.*private state/)
})

test('interactive launch uses one explicit root across new sessions without saving folder trust', async t => {
  const { root, directory } = await fixture(t)
  const io = fakeIO(['Read fixture', '/new', 'Read fixture again', '/exit'])
  const args = ['--model', 'fixture', '--tools', '--workspace', root, '--session-dir', join(directory, 'interactive')]
  let calls = 0
  const code = await runApplication({ io, args, options: parseArguments(args, {}, true), env: {}, secrets: [],
    credentials: { async status() { return { available: false, label: 'Fixture' } }, async load() { return undefined } },
    catalog: { async list() { throw new Error('No catalog needed') } },
    providerFactory: () => ({ async generate({ tools }) { calls++; assert(tools.some(tool => tool.name === 'workspace_list')); return answer() } }) })
  assert.equal(code, 0); assert.equal(calls, 2)
  assert.equal(io.output.match(/Workspace:/g).length, 1)
  const stateFiles = await readdir(join(directory, 'interactive'))
  for (const file of stateFiles.filter(file => file.endsWith('.json'))) {
    const saved = await readFile(join(directory, 'interactive', file), 'utf8')
    assert(!saved.includes(root)); assert(!saved.includes('"workspace"'))
  }
})
