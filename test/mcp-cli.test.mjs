// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { main } from '../dist/main.js'
import { isMcpCliCommand, parseMcpCliArguments, runMcpCli } from '../dist/mcp-cli.js'
import { McpConfigStore } from '../dist/mcp-config.js'
import { McpManager } from '../dist/mcp-manager.js'
import { McpOAuthControls } from '../dist/mcp-oauth-controls.js'

function ioFixture(approval = false, interactive = false) {
  return { output: '', approvals: [], closed: false, canAutoReview: interactive,
    get isClosed() { return this.closed },
    async readLine() { throw new Error('Unexpected chat or setup input') },
    write(text) { this.output += text }, event() { throw new Error('Unexpected provider event') },
    result() { throw new Error('Unexpected provider result') },
    async approve(request, signal) { this.approvals.push(request); return typeof approval === 'function' ? approval(request, signal) : approval },
    onCancel(callback) { this.cancel = callback; return () => { delete this.cancel } },
    close() { this.closed = true } }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-cli-'))
  await chmod(directory, 0o700)
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, store: new McpConfigStore(directory) }
}
const http = (id = 'docs', endpoint = 'https://mcp.example.test/mcp') => ({
  id, label: 'Docs', transport: 'http', endpoint, protocol: 'legacy', allowLoopbackHttp: false
})
function noChat(io, extra = {}) {
  return { io, providerFactory() { assert.fail('MCP setup must never construct a model provider') },
    decisionProviderFactory() { assert.fail('MCP setup must never construct a decision provider') },
    credentials: { async get() { assert.fail('MCP setup must never read provider credentials') } },
    catalog: { async load() { assert.fail('MCP setup must never request model metadata') } }, ...extra }
}
function blockNetwork(t) {
  let requests = 0
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('No external requests in MCP CLI tests') })
  return () => requests
}

test('MCP argument parsing is provider-independent and accepts state directory before or after subcommands', () => {
  assert.equal(isMcpCliCommand(['mcp', 'list']), true)
  assert.equal(isMcpCliCommand(['--session-dir', '/private/state', 'mcp', 'list']), true)
  for (const args of [['--prompt', 'mcp'], ['--model', 'mcp'], ['--prompt', '/mcp']]) assert.equal(isMcpCliCommand(args), false)
  for (const args of [['mcp', 'list', '--session-dir', '/private/state'], ['--session-dir', '/private/state', 'mcp', 'list']]) {
    assert.deepEqual(parseMcpCliArguments(args, {}), { action: 'list', protocol: '2026-07-28',
      allowLoopbackHttp: false, sessionDirectory: '/private/state', help: false })
  }
  assert.equal(parseMcpCliArguments(['mcp', 'list'], { VIVI_SESSION_DIR: '/from-env' }).sessionDirectory, '/from-env')
  const added = parseMcpCliArguments(['mcp', 'add', 'docs', 'https://mcp.example.test', '--label', 'My docs', '--protocol', 'legacy'], {})
  assert.equal(added.endpoint, 'https://mcp.example.test/'); assert.equal(added.label, 'My docs'); assert.equal(added.protocol, 'legacy')
})

test('MCP parser rejects invalid arity, IDs, insecure endpoints and unsupported options without echoing them', () => {
  for (const args of [
    ['mcp', 'add', 'docs'], ['mcp', 'list', 'extra'], ['mcp', 'login'], ['mcp', 'remove', 'docs', 'extra'],
    ['mcp', 'add', 'UPPER', 'https://mcp.example.test'], ['mcp', 'add', 'docs', 'http://mcp.example.test'],
    ['mcp', 'add', 'docs', 'http://localhost/mcp', '--allow-loopback-http'],
    ['mcp', 'add', 'docs', 'https://user:password@mcp.example.test/mcp'],
    ['mcp', 'add', 'docs', 'https://mcp.example.test/mcp?token=private'],
    ['mcp', 'add', 'docs', 'https://mcp.example.test/mcp#private'],
    ['mcp', 'list', '--label', 'private'], ['mcp', 'list', '--provider', 'openai'],
    ['mcp', 'list', '--session-dir'], ['mcp', 'list', '--session-dir', '/first', '--session-dir', '/second'],
    ['mcp', 'add', 'docs', 'https://mcp.example.test', '--protocol', 'unsupported-private']
  ]) assert.throws(() => parseMcpCliArguments(args, {}), error => !error.message.includes('password') && !error.message.includes('unsupported-private'))
  assert.equal(parseMcpCliArguments(['mcp', 'add', 'local', 'http://127.0.0.1:43210/mcp', '--allow-loopback-http'], {}).allowLoopbackHttp, true)
})

test('provider-free MCP add/list/logout/remove work offline and create only MCP configuration', async t => {
  const { directory, store } = await fixture(t), requests = blockNetwork(t)
  let starts = 0, closes = 0
  const dependencies = io => noChat(io, { mcpManagerFactory(options) {
    const manager = new McpManager({ ...options, transportFactory() { starts++; assert.fail('No server may start') } })
    const close = manager.close.bind(manager)
    manager.close = async () => { closes++; await close() }
    return manager
  }, mcpOAuth: { fetchFn: async () => { assert.fail('No OAuth request expected') },
    openBrowser: async () => { assert.fail('No browser expected') } } })
  let io = ioFixture()
  assert.equal(await main(['mcp', 'add', 'docs', 'https://mcp.example.test/mcp', '--session-dir', directory], {}, dependencies(io)), 0)
  assert.match(io.output, /saved disabled/); assert.equal(io.closed, true)
  assert.equal((await store.load()).servers[0].protocol, '2026-07-28')
  io = ioFixture()
  assert.equal(await main(['--session-dir', directory, 'mcp', 'list'], {}, dependencies(io)), 0)
  assert.match(io.output, /"docs".*http.*disabled.*https:\/\/mcp\.example\.test\/mcp/)
  assert.equal(io.approvals.length, 0)
  assert.deepEqual(await readdir(directory), ['mcp-servers.json'])
  for (const action of ['logout', 'remove']) {
    io = ioFixture()
    assert.equal(await main(['mcp', action, 'docs', '--session-dir', directory], {}, dependencies(io)), 0)
    assert.equal(io.closed, true); assert.equal(io.approvals.length, 0)
    assert.match(io.output, /issuer/)
  }
  assert.deepEqual((await store.load()).servers, [])
  assert.equal(requests(), 0); assert.equal(starts, 0); assert.equal(closes, 4)
})

test('MCP help and empty list do not initialize chat or create state', async t => {
  const { directory } = await fixture(t), absent = join(directory, 'absent'), requests = blockNetwork(t)
  for (const args of [['mcp'], ['mcp', '--help'], ['mcp', 'help'], ['mcp', 'add', '--help']]) {
    const io = ioFixture()
    assert.equal(await main([...args, '--session-dir', absent], {}, noChat(io, {
      mcpManagerFactory() { assert.fail('Help must not initialize MCP or credentials') }
    })), 0)
    assert.match(io.output, /No model, provider or API key/); assert.equal(io.closed, true)
  }
  const io = ioFixture()
  assert.equal(await main(['mcp', 'list', '--session-dir', absent], {}, noChat(io)), 0)
  assert.match(io.output, /No MCP servers configured/)
  await assert.rejects(stat(absent), { code: 'ENOENT' })
  assert.equal(requests(), 0)
})

for (const action of ['login', 'connect']) test(`piped MCP ${action} fails closed before manager, OAuth or approvals`, async t => {
  const { directory } = await fixture(t), requests = blockNetwork(t), io = ioFixture(true)
  assert.equal(await main(['mcp', action, 'docs', '--session-dir', directory], {}, noChat(io, {
    mcpManagerFactory() { assert.fail('Piped MCP approval must fail before state or auth construction') }
  })), 1)
  assert.match(io.output, /interactive terminal.*piped approval is denied/)
  assert.equal(io.approvals.length, 0); assert.equal(requests(), 0); assert.equal(io.closed, true)
})

test('interactive denied MCP trust starts no server, auth flow or browser', async t => {
  const { directory, store } = await fixture(t), requests = blockNetwork(t), io = ioFixture(false, true)
  await store.save([http()], (await store.load()).revision)
  let starts = 0
  assert.equal(await main(['mcp', 'connect', 'docs', '--session-dir', directory], {}, noChat(io, {
    mcpManagerFactory(options) { return new McpManager({ ...options, transportFactory() { starts++; assert.fail('Denied trust cannot connect') } }) },
    mcpOAuth: { fetchFn: async () => { assert.fail('Denied trust cannot discover OAuth') }, openBrowser: async () => { assert.fail('Denied trust cannot open browser') } }
  })), 1)
  assert.equal(io.approvals.length, 1); assert.equal(io.approvals[0].call.name, 'connect_mcp_server')
  assert.match(io.approvals[0].description, /mcp\.example\.test/)
  assert.equal(starts, 0); assert.equal(requests(), 0); assert.match(io.output, /not completed/)
})

test('approved MCP connection uses injected offline discovery and closes owned transport on exit', async t => {
  const { directory, store } = await fixture(t), requests = blockNetwork(t), io = ioFixture(true, true)
  await store.save([http()], (await store.load()).revision)
  let starts = 0, closes = 0
  const methods = []
  assert.equal(await main(['mcp', 'connect', 'docs', '--session-dir', directory], {}, noChat(io, {
    mcpManagerFactory(options) { return new McpManager({ ...options, transportFactory() {
      const transport = { async start() { starts++ }, async close() { closes++; transport.onclose?.() },
        async send(message) {
          if (!message.method) return
          methods.push(message.method)
          if (message.id === undefined) return
          const result = message.method === 'initialize' ? { resultType: 'complete', protocolVersion: '2025-11-25',
            capabilities: { tools: {} }, serverInfo: { name: 'Offline fixture', version: '1' } }
            : { resultType: 'complete', tools: [] }
          queueMicrotask(() => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result }))
        } }
      return transport
    } }) }, mcpOAuth: { fetchFn: async () => { assert.fail('Anonymous fixture needs no OAuth') },
      openBrowser: async () => { assert.fail('Anonymous fixture needs no browser') } }
  })), 0)
  assert.equal(starts, 1); assert.ok(closes >= 1); assert.equal(requests(), 0)
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list'])
  assert.equal(io.approvals.length, 1); assert.match(io.output, /connected for this command.*closes on exit/)
})

test('MCP login dispatches to guided human OAuth controls without a model provider', async t => {
  const { directory, store } = await fixture(t), requests = blockNetwork(t), io = ioFixture(false, true)
  await store.save([http()], (await store.load()).revision)
  let logins = 0
  t.mock.method(McpOAuthControls.prototype, 'guidedSignInAndConnect', async function (id, suppliedIO, signal) {
    logins++; assert.equal(id, 'docs'); assert.equal(suppliedIO, io); assert.equal(signal.aborted, false)
    return true
  })
  assert.equal(await main(['mcp', 'login', 'docs', '--session-dir', directory], {}, noChat(io)), 0)
  assert.equal(logins, 1); assert.equal(requests(), 0); assert.match(io.output, /sign-in completed/)
  assert.equal(io.closed, true)
})

test('MCP cancellation while trust approval is pending returns 130 without starting a transport', async t => {
  const { directory, store } = await fixture(t), requests = blockNetwork(t)
  await store.save([http()], (await store.load()).revision)
  const io = ioFixture(() => { io.cancel(); return true }, true)
  assert.equal(await main(['mcp', 'connect', 'docs', '--session-dir', directory], {}, noChat(io, {
    mcpManagerFactory(options) { return new McpManager({ ...options, transportFactory() { assert.fail('Cancelled approval cannot start a transport') } }) }
  })), 130)
  assert.equal(requests(), 0); assert.equal(io.closed, true); assert.equal(io.cancel, undefined)
})

test('MCP list omits server descriptors and safely displays invisible characters', async t => {
  const { directory, store } = await fixture(t), requests = blockNetwork(t)
  await store.save([{ ...http(), label: 'Docs\u202eprivate' }], (await store.load()).revision)
  const io = ioFixture()
  assert.equal(await runMcpCli(['mcp', 'list', '--session-dir', directory], {}, {
    io, mcpManagerFactory(options) {
      const manager = new McpManager(options), statuses = manager.statuses.bind(manager)
      manager.statuses = () => statuses().map(status => ({ ...status, message: 'untrusted-private-detail',
        snapshot: { tools: [{ name: 'untrusted-tool-name' }] } }))
      return manager
    }
  }), 0)
  assert.equal(io.output.includes('\u202e'), false); assert.match(io.output, /\\u202e/)
  assert.equal(io.output.includes('untrusted-private-detail'), false); assert.equal(io.output.includes('untrusted-tool-name'), false)
  assert.equal(requests(), 0)
})

test('MCP argument credentials are rejected without leaks, network or state mutation', async t => {
  const { directory } = await fixture(t), secret = 'fixture-private-environment-key-123', io = ioFixture(), requests = blockNetwork(t)
  assert.equal(await main(['mcp', 'add', 'docs', `https://mcp.example.test/${secret}`, '--session-dir', directory],
    { OPENAI_API_KEY: secret }, noChat(io, { mcpManagerFactory() { assert.fail('Credentials must be refused before config mutation') } })), 1)
  assert.equal(io.output.includes(secret), false); assert.match(io.output, /must not contain environment credentials/)
  assert.deepEqual(await readdir(directory), []); assert.equal(requests(), 0)
})

test('owned MCP cleanup failures change a successful command to failure without leaking transport details', async t => {
  const { directory } = await fixture(t), io = ioFixture()
  assert.equal(await runMcpCli(['mcp', 'list', '--session-dir', directory], {}, {
    io, mcpManagerFactory(options) {
      const manager = new McpManager(options)
      manager.close = async () => { throw new Error('Untrusted private cleanup data') }
      return manager
    }
  }), 1)
  assert.match(io.output, /cleanup could not be verified/); assert.equal(io.output.includes('Untrusted private cleanup data'), false)
  assert.equal(io.closed, true)
})

test('TTY Node launcher runs MCP setup directly without Bun or provider credentials', { timeout: 10_000 }, async t => {
  const { directory } = await fixture(t), launcher = new URL('../dist/launcher.js', import.meta.url).href
  const script = `Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true });
process.argv = [process.execPath, 'vivi', 'mcp', 'list', '--session-dir', ${JSON.stringify(directory)}];
await import(${JSON.stringify(launcher)});`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: '', ...(process.platform === 'win32' ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}) }
  })
  t.after(() => { child.stdin.destroy(); if (child.exitCode === null) child.kill() })
  let output = '', errors = ''
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { errors += chunk })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  assert.equal(code, 0, errors); assert.match(output, /No MCP servers configured/)
  assert.equal(errors.includes('Bun'), false); assert.deepEqual(await readdir(directory), [])
})
