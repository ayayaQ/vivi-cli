// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { main, parseArguments } from '../dist/main.js'
import { runChatLoop, TerminalIO } from '../dist/terminal.js'
import { DEFAULT_PREFERENCES } from '../dist/application.js'
import { PreferenceStore } from '../dist/preferences.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { McpConfigStore } from '../dist/mcp-config.js'
import { McpManager } from '../dist/mcp-manager.js'
import { McpStdioTransport } from '../dist/mcp-transport.js'

const fixtureFile = fileURLToPath(new URL('./fixtures/mcp-discovery-server.mjs', import.meta.url))
const scriptArgs = [...(process.versions.bun ? ['--no-install'] : []), fixtureFile]
const answer = (content = 'Ordinary response', toolCalls = []) => ({ content, toolCalls })
const credentials = { status: async () => ({ available: false, label: 'Offline test vault' }),
  load: async () => undefined, save: async () => { throw new Error('No credential writes in this test') } }
function fakeIO(lines = [], selections = [], allow = false) {
  const callbacks = new Set()
  return { output: '', sessions: [], events: [], results: [], choices: [], approvals: [], secrets: [], closed: false,
    get isClosed() { return this.closed },
    readLine: async () => { const value = lines.shift(); if (value instanceof Error) throw value; return value },
    async choose(title, choices, initialIndex) {
      this.choices.push({ title, choices, initialIndex })
      const selected = selections.shift()
      if (selected === undefined) return
      assert(choices.some(choice => choice.value === selected), `Missing ${String(selected)} in ${title}`)
      return selected
    },
    askText: async () => undefined, chooseSearchable: async () => undefined, askSecret: async () => undefined,
    setSession(session) { this.sessions.push(structuredClone(session)) }, addSecrets(values) { this.secrets.push(...values) },
    write(value) { this.output += value }, event(value) { this.events.push(value) }, result(value) { this.results.push(value) },
    async approve(request) { this.approvals.push(request); return allow },
    onCancel(callback) { callbacks.add(callback); return () => callbacks.delete(callback) },
    close() { this.closed = true; for (const callback of callbacks) callback(); callbacks.clear() }
  }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-integration-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new McpConfigStore(directory)
  const server = { id: 'docs', label: 'Private fixture catalog', executable: process.execPath,
    args: [...scriptArgs, 'normal', join(directory, 'fixture-log'), join(directory, 'fixture-pid')],
    cwd: directory, protocol: 'legacy', environment: [] }
  await store.save([server], (await store.load()).revision)
  const observed = { starts: 0, closes: 0, addedSecrets: [], managers: [], transports: [], launchOptions: [] }
  const factory = options => {
    observed.launchOptions.push(options)
    const manager = new McpManager({ ...options, transportFactory: launch => {
      observed.starts++; const transport = new McpStdioTransport(launch); observed.transports.push(transport); return transport
    } })
    const close = manager.close.bind(manager), addSecrets = manager.addSecrets.bind(manager)
    manager.close = async () => { observed.closes++; await close() }
    manager.addSecrets = values => { observed.addedSecrets.push(...values); addSecrets(values) }
    observed.managers.push(manager)
    return manager
  }
  return { directory, store, server, observed, factory,
    log: async () => (await readFile(join(directory, 'fixture-log'), 'utf8')).trim().split('\n').map(JSON.parse) }
}
async function run(subject, mode, io, args = [], providerFactory = () => ({ generate: async () => answer() }), extra = {}) {
  const deps = { credentials, providerFactory, mcpManagerFactory: subject.factory,
    [mode === 'tui' ? 'tuiIO' : 'io']: io, ...extra }
  return main(['--no-workspace', ...(args.includes('--resume') ? [] : ['--model', 'offline-test-model']), ...args],
    { VIVI_SESSION_DIR: subject.directory }, deps)
}

test('private /mcp routing consumes one-shot and composer commands without sending them to the host', async () => {
  let sends = 0, opens = 0
  const host = { skillsEnabled: false, memoryEnabled: false,
    send: async () => { sends++; throw new Error('MCP commands must never be host turns') } }
  for (const prompt of ['/mcp', ' /mcp ', '/mcp enable docs', '/mcp\nconnect']) {
    const io = fakeIO()
    await runChatLoop(host, io, prompt, { mcp: async () => { opens++ } })
    if (prompt.trim() !== '/mcp') assert.match(io.output, /Use \/mcp by itself/)
  }
  await runChatLoop(host, fakeIO(['/mcp', '/mcp connect', '/exit']), undefined,
    { mcp: async () => { opens++ } })
  await runChatLoop(host, fakeIO(), '/mcp')
  assert.equal(sends, 0); assert.equal(opens, 3)
})

for (const mode of ['line', 'tui']) {
  test(`${mode} /mcp prompt stays private and fresh startup approval defaults to denied`, async t => {
    const subject = await fixture(t), io = fakeIO([], ['server:docs', 'connect', 'back'])
    let generations = 0
    assert.equal(await run(subject, mode, io, ['--prompt', '/mcp'], () => ({ generate: async () => {
      generations++; return answer()
    } })), 0)
    assert.equal(generations, 0); assert.equal(subject.observed.starts, 0); assert.equal(subject.observed.closes, 1)
    assert.equal(io.approvals.length, 1); assert.equal(io.approvals[0].call.name, 'connect_mcp_server')
    assert.match(io.approvals[0].description, /installed code with your OS permissions/)
    assert(io.choices.every(choice => choice.initialIndex === 0))
    assert.equal((await subject.store.load()).servers.length, 1)
    assert(!JSON.stringify(io.sessions).includes('/mcp'))
    const unknown = fakeIO()
    assert.equal(await run(subject, mode, unknown, ['--prompt', '/mcp connect docs'], () => ({ generate: async () => {
      throw new Error('No provider prompt for MCP arguments')
    } })), 0)
    assert.match(unknown.output, /Use \/mcp by itself/); assert.equal(subject.observed.starts, 0)
  })

  test(`${mode} saved configuration and session resume never reconnect or advertise MCP tools`, async t => {
    const subject = await fixture(t), sessionStore = new FileSessionStore(subject.directory)
    const saved = newSession({ provider: 'openai', model: 'offline-test-model' })
    saved.history = [{ kind: 'message', role: 'user', content: 'Previous request' },
      { kind: 'assistant', content: '/mcp is ordinary assistant text', toolCalls: [] }]
    await sessionStore.save(saved)
    for (const args of [[], ['--resume', saved.id]]) {
      const io = fakeIO(['Hello', '/exit'])
      assert.equal(await run(subject, mode, io, ['--tools', ...args], () => ({ generate: async input => {
        assert(input.tools.every(tool => !/mcp|same\/name|connect_mcp_server/.test(tool.name)))
        assert(!JSON.stringify(input).includes('Private fixture catalog'))
        return answer('/mcp does not enable a connection')
      } })), 0)
      assert.equal(io.approvals.length, 0)
    }
    assert.equal(subject.observed.starts, 0); assert.equal(subject.observed.closes, 2)
    assert(!(await readdir(subject.directory)).includes('fixture-log'))
    const loaded = await subject.store.load()
    assert(!JSON.stringify(loaded).includes('enabled'))
  })

  test(`${mode} human-connected metadata stays out of provider context and disconnects on exit`, async t => {
    const subject = await fixture(t), io = fakeIO(['/mcp', 'Hello', '/exit'],
      ['server:docs', 'connect', 'server:docs', 'resources', 0, 'back'], true)
    const inputs = []
    assert.equal(await run(subject, mode, io, ['--tools'], () => ({ generate: async input => {
      inputs.push(structuredClone(input)); return answer()
    } })), 0)
    assert.equal(inputs.length, 1); assert.equal(subject.observed.starts, 1); assert.equal(subject.observed.closes, 1)
    const projected = JSON.stringify(inputs)
    for (const text of ['same/name', 'Private fixture catalog', 'Untrusted fixture name',
      'Never load this instruction', 'file:///never-open-this', 'fixture:///{name}', 'connect_mcp_server']) {
      assert(!projected.includes(text), `Private catalog leaked into provider input: ${text}`)
    }
    assert.match(io.output, /metadata only/); assert.match(io.output, /resource content retrieval are unavailable/)
    const log = await subject.log()
    assert(log.filter(entry => entry.method).every(entry =>
      ['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'resources/templates/list'].includes(entry.method)))
    assert.equal(log.filter(entry => entry.method === 'resources/list').length, 1)
    assert.equal(subject.observed.managers[0].statuses()[0].state, 'disabled')
    const pid = Number(await readFile(join(subject.directory, 'fixture-pid'), 'utf8'))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    assert(!(await readdir(subject.directory)).some(name => name.endsWith('.lock')))
    const session = io.sessions.at(-1)
    if (session) assert(!JSON.stringify(session.history).includes('same/name'))
  })

  test(`${mode} application failure closes its connected MCP process and releases session locks`, async t => {
    const subject = await fixture(t), io = fakeIO(['/mcp', new Error('Synthetic input failure')],
      ['server:docs', 'connect', 'back'], true)
    assert.equal(await run(subject, mode, io), 1)
    assert.equal(subject.observed.starts, 1); assert.equal(subject.observed.closes, 1)
    assert.match(io.output, /Synthetic input failure/)
    const pid = Number(await readFile(join(subject.directory, 'fixture-pid'), 'utf8'))
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    assert(!(await readdir(subject.directory)).some(name => name.endsWith('.lock')))
    assert.equal(subject.observed.managers[0].statuses()[0].state, 'disabled')
  })
}

test('model-generated connect and MCP tool calls cannot enter the private manager or invoke remote tools', async t => {
  const subject = await fixture(t), io = fakeIO(['Please answer', '/exit'])
  let rounds = 0
  assert.equal(await run(subject, 'line', io, ['--tools'], () => ({ generate: async input => {
    assert(input.tools.every(tool => !tool.name.includes('mcp')))
    return rounds++ === 0 ? answer('/mcp', [
      { id: 'connect', name: 'connect_mcp_server', arguments: { serverId: 'docs' } },
      { id: 'invoke', name: 'mcp__docs__same_name', arguments: {} }
    ]) : answer('Handled as unavailable tools')
  } })), 0)
  assert.equal(rounds, 2); assert.equal(subject.observed.starts, 0); assert.equal(io.approvals.length, 0)
  const completed = io.events.filter(event => event.type === 'tool_completed')
  assert.equal(completed.length, 2); assert(completed.every(event => event.message.isError === true))
})

test('secure-store key loading refreshes private MCP validation before configuration is displayed', async t => {
  const subject = await fixture(t), key = 'offline-key-marker-not-a-real-credential'
  const before = await subject.store.load()
  await subject.store.save([{ ...subject.server, label: key }], before.revision)
  await new PreferenceStore(subject.directory).save({ ...DEFAULT_PREFERENCES, model: 'offline-test-model' })
  const io = fakeIO(['/mcp', '/exit'])
  assert.equal(await run(subject, 'tui', io, [], () => ({ generate: async () => answer() }), {
    credentials: { ...credentials, load: async () => key }
  }), 0)
  assert(subject.observed.addedSecrets.includes(key)); assert(io.secrets.includes(key))
  assert.equal(subject.observed.starts, 0); assert.equal(subject.observed.closes, 1)
  assert.match(io.output, /MCP configuration is unavailable or invalid/); assert(!io.output.includes(key))
  await assert.rejects(subject.observed.launchOptions[0].store.load(), /Invalid MCP configuration/)
})

test('a setup failure closes the launch-owned manager without entering discovery', async t => {
  const subject = await fixture(t), io = fakeIO()
  assert.equal(await run(subject, 'line', io, [], () => { throw new Error('Synthetic provider setup failure') }), 1)
  assert.equal(subject.observed.closes, 1); assert.equal(subject.observed.starts, 0)
  assert(!(await readdir(subject.directory)).some(name => name.endsWith('.lock')))
})

for (const mode of ['line', 'tui']) test(`${mode} MCP cleanup failure reports an unsuccessful exit and still closes the UI`, async t => {
  const subject = await fixture(t), io = fakeIO(['/exit'])
  assert.equal(await run(subject, mode, io, [], undefined, { mcpManagerFactory: options => {
    const manager = subject.factory(options), close = manager.close.bind(manager)
    manager.close = async () => { await close(); throw new Error('Synthetic MCP cleanup failure') }
    return manager
  } }), 1)
  assert.equal(subject.observed.closes, 1); assert.equal(io.isClosed, true)
  assert.match(io.output, /Synthetic MCP cleanup failure/)
  assert(!(await readdir(subject.directory)).some(name => name.endsWith('.lock')))
})

test('accessible TerminalIO uses numbered MCP controls and noninteractive input cannot grant startup approval', async t => {
  const subject = await fixture(t), input = new PassThrough(), output = new PassThrough()
  const io = new TerminalIO({ input, output, stream: false })
  t.after(() => { io.close(); input.destroy(); output.destroy() })
  let displayed = '', generations = 0
  output.on('data', value => { displayed += value.toString() })
  const replies = ['/mcp', '3', '2', '', '/exit']
  const readLine = io.readLine.bind(io)
  io.readLine = async (...args) => {
    const pending = readLine(...args), reply = replies.shift()
    assert.notEqual(reply, undefined, 'No unexpected terminal prompts')
    queueMicrotask(() => input.write(`${reply}\n`))
    return pending
  }
  assert.equal(await run(subject, 'line', io, [], () => ({ generate: async () => { generations++; return answer() } })), 0)
  assert.equal(generations, 0); assert.equal(subject.observed.starts, 0); assert.equal(subject.observed.closes, 1)
  assert.match(displayed, /1\. Back/); assert.match(displayed, /Denied: interactive approval is required/)
})

const untouchedServices = { credentials: {
  status: async () => { throw new Error('MCP must not inspect credential status') },
  load: async () => { throw new Error('MCP must not read saved credentials') },
  save: async () => { throw new Error('MCP must not save credentials') }
}, catalog: { list: async () => { throw new Error('MCP must not query a provider catalog') } } }

for (const mode of ['line', 'tui']) {
  for (const prompt of ['/mcp', ' /mcp ', '/mcp connect docs']) test(`${mode} offline one-shot ${JSON.stringify(prompt)} needs no model, provider, credentials or workspace`, async t => {
    const subject = await fixture(t), io = fakeIO([], ['back'])
    await writeFile(join(subject.directory, 'preferences.json'), 'Invalid saved preferences must not be read', { mode: 0o600 })
    const original = (await readdir(subject.directory)).sort()
    // The real default provider factory would reject this keyless launch if it
    // were constructed. The missing workspace would likewise fail if opened.
    assert.equal(await main(['--prompt', prompt, '--workspace', join(subject.directory, 'missing-workspace')],
      { VIVI_SESSION_DIR: subject.directory }, { ...untouchedServices, mcpManagerFactory: subject.factory,
        [mode === 'tui' ? 'tuiIO' : 'io']: io }), 0)
    assert.equal(subject.observed.starts, 0); assert.equal(subject.observed.closes, 1)
    assert.equal(io.sessions.length, 0); assert.equal(io.results.length, 0)
    assert.deepEqual((await readdir(subject.directory)).sort(), original)
    assert(!io.output.includes('Saved defaults could not be loaded'))
    if (prompt.trim() === '/mcp') assert.match(io.output, /MCP connections|configured servers/)
    else { assert.match(io.output, /Use \/mcp by itself/); assert.equal(io.choices.length, 0) }
  })

  test(`${mode} offline MCP one-shot closes after invalid configuration without touching unrelated state`, async t => {
    const subject = await fixture(t), io = fakeIO()
    await writeFile(join(subject.directory, 'mcp-servers.json'), JSON.stringify({ schemaVersion: 1,
      servers: [{ transport: 'http', enabled: true }] }), { mode: 0o600 })
    const original = (await readdir(subject.directory)).sort()
    assert.equal(await main(['--prompt', '/mcp', '--workspace', join(subject.directory, 'missing-workspace')],
      { VIVI_SESSION_DIR: subject.directory }, { ...untouchedServices, mcpManagerFactory: subject.factory,
        [mode === 'tui' ? 'tuiIO' : 'io']: io }), 1)
    assert.equal(subject.observed.closes, 1); assert.equal(subject.observed.starts, 0)
    assert.equal(io.isClosed, true); assert.equal(io.sessions.length, 0)
    assert.match(io.output, /MCP configuration is unavailable or invalid/)
    assert.deepEqual((await readdir(subject.directory)).sort(), original)
  })
}

test('offline MCP prompt only waives absent-model setup; supplied selections and normal chat/resume still validate', () => {
  for (const prompt of ['/mcp', '/mcp connect']) assert.equal(parseArguments(['--prompt', prompt], {}).model, undefined)
  for (const args of [[], ['--prompt', 'Hello'], ['--prompt', '/mcp-other'], ['--prompt', '/MCP'],
    ['--prompt', '/mcp', '--model', ' invalid '], ['--prompt', '/mcp', '--model', 'x'.repeat(201)],
    ['--prompt', '/mcp', '--provider', 'other'], ['--prompt', '/mcp', '--reasoning', 'high'],
    ['--prompt', '/mcp', '--resume', 'invalid'], ['--prompt', '/mcp', '--max-rounds', '0'],
    ['--prompt', '/mcp', '--unknown'], ['--prompt', '/mcp', '--workspace', '/missing', '--no-workspace']]) {
    assert.throws(() => parseArguments(args, {}), `Expected invalid selection: ${args.join(' ')}`)
  }
  const id = newSession({ provider: 'openai', model: 'offline' }).id
  assert.throws(() => parseArguments(['--prompt', '/mcp', '--resume', id, '--model', 'offline'], {}), /omit selection flags/)
})

for (const mode of ['line', 'tui']) test(`${mode} invalid external MCP config closes the peer while ordinary chat continues`, async t => {
  const subject = await fixture(t), io = fakeIO(['/mcp', '/mcp', 'Hello after invalid config', '/exit'],
    ['server:docs', 'connect', 'back'], true)
  let reads = 0, generations = 0
  const readLine = io.readLine.bind(io)
  io.readLine = async () => {
    const line = await readLine()
    if (++reads === 2) await writeFile(join(subject.directory, 'mcp-servers.json'), '{fixture-private-text malformed JSON\n')
    return line
  }
  assert.equal(await run(subject, mode, io, [], () => ({ generate: async input => {
    generations++
    assert(!JSON.stringify(input).includes('Private fixture catalog'))
    assert(!input.tools.some(tool => tool.name.includes('mcp')))
    assert.equal(subject.observed.managers[0].statuses()[0].state, 'disabled')
    assert.equal(subject.observed.managers[0].statuses()[0].snapshot, undefined)
    return answer()
  } })), 0)
  assert.equal(generations, 1); assert.equal(subject.observed.starts, 1)
  assert.match(io.output, /configuration is unavailable or invalid/)
  assert(!io.output.includes('fixture-private-text'))
  const pid = Number(await readFile(join(subject.directory, 'fixture-pid'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), /ESRCH/)
})

for (const mode of ['line', 'tui']) test(`${mode} private UI refresh revokes a peer when config becomes malformed in flight`, async t => {
  const subject = await fixture(t), io = fakeIO(['/mcp', 'Hello after cancelled metadata', '/exit'],
    ['server:docs', 'connect', 'server:docs', 'refresh'], true)
  let generations = 0
  const choose = io.choose.bind(io)
  io.choose = async (...args) => {
    const selected = await choose(...args)
    if (selected === 'refresh') {
      const transport = subject.observed.transports[0], send = transport.send.bind(transport)
      transport.send = async message => {
        if (message.method === 'tools/list') await writeFile(join(subject.directory, 'mcp-servers.json'), '{fixture-private-text malformed JSON\n')
        await send(message)
      }
    }
    return selected
  }
  assert.equal(await run(subject, mode, io, [], () => ({ generate: async input => {
    generations++
    assert(!JSON.stringify(input).includes('Private fixture catalog'))
    assert.equal(subject.observed.managers[0].statuses()[0].state, 'disabled')
    assert.equal(subject.observed.managers[0].statuses()[0].snapshot, undefined)
    return answer()
  } })), 0)
  assert.equal(generations, 1); assert.equal(subject.observed.starts, 1)
  assert.match(io.output, /configuration is unavailable or invalid/)
  assert(!io.output.includes('fixture-private-text'))
  const pid = Number(await readFile(join(subject.directory, 'fixture-pid'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), /ESRCH/)
})
