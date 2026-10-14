// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runApplication } from '../dist/application.js'
import { HELP, main, parseArguments } from '../dist/main.js'
import { McpConfigStore } from '../dist/mcp-config.js'
import { McpManager } from '../dist/mcp-manager.js'

const endpoint = 'https://mcp.application.fixture.invalid/mcp', issuer = 'https://auth.application.fixture.invalid'
const token = 'fixture-secret-app-access-token', refresh = 'fixture-secret-app-refresh-token', code = 'fixture-secret-app-code'
const server = { transport: 'http', id: 'remote', label: 'Application OAuth fixture', endpoint,
  protocol: '2026-07-28', allowLoopbackHttp: false }
const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
  response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true }
const clean = value => assert(!JSON.stringify(value).includes('fixture-secret'), 'OAuth credentials escaped an application surface')
test('CLI help describes reviewed saved OAuth and explicit session-only choice without automatic reconnect', () => {
  assert.match(HELP, /Streamable HTTP endpoints/)
  assert.match(HELP, /guide reviewed browser sign-in and public client setup/)
  assert.match(HELP, /browser sign-in and connection use one reviewed setup approval/)
  assert.match(HELP, /saved in OS-protected encrypted storage/)
  assert.match(HELP, /Explicit session-only sign-in/)
  assert.match(HELP, /Sign out forgets saved tokens locally/)
  assert.doesNotMatch(HELP, /Credentials are unsupported/)
})
const json = (message, result) => Response.json({ jsonrpc: '2.0', id: message.id,
  result: { ...result, resultType: 'complete', ttlMs: 0, cacheScope: 'private' } })
async function availablePort() {
  const listener = createServer()
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve) })
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}
async function noListener(port) {
  const listener = createServer()
  try { await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', resolve) }) }
  finally { await new Promise(resolve => listener.close(resolve)) }
}
async function fixture(t, { approved = true, prompt = false, tool = false, cancelAtBrowser = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-application-mcp-oauth-')), port = await availablePort()
  t.after(() => rm(directory, { recursive: true, force: true }))
  const store = new McpConfigStore(directory), initial = await store.load()
  await store.save([server], initial.revision)
  const selections = ['server:remote', 'advanced', 'oauth-client', true, 'server:remote', 'sign-in', 'back']
  const texts = ['owned-app-public-client', issuer, String(port), '/app/oauth/callback', 'read']
  const lines = tool ? ['Before sign-in', '/mcp', 'Use the connected fixture', '/exit'] : ['/mcp', 'After management', '/exit']
  const io = { output: '', choices: [], approvals: [], sessions: [], events: [], results: [], protected: [], closed: false,
    get isClosed() { return this.closed },
    async choose(title, values, initial) {
      this.choices.push({ title, values: structuredClone(values), initial })
      const selection = selections.shift()
      if (selection !== undefined) assert(values.some(item => item.value === selection), `${String(selection)} absent from ${title}`)
      return selection
    },
    async chooseSearchable() { return undefined }, async askText() { return texts.shift() }, async readLine() { return lines.shift() },
    async approve(request, abort) { assert(!abort.aborted); this.approvals.push(structuredClone(request)); return approved },
    addSecrets(values) { this.protected.push(...values) }, setSession(value) { this.sessions.push(structuredClone(value)) },
    write(value) { this.output += value }, event(value) { this.events.push(structuredClone(value)) },
    result(value) { this.results.push(structuredClone(value)) },
    onCancel(callback) { this.cancel = callback; return () => { delete this.cancel } }, close() { this.closed = true }
  }
  const oauthRequests = [], requests = [], browserUrls = [], registered = [], inputs = []
  let manager, managerOptions, providerCreations = 0, generated = 0
  const args = ['--no-workspace', '--provider', 'openai', '--model', 'gpt-5.1', '--tools', '--no-skills', '--no-stream',
    ...(prompt ? ['--prompt', '/mcp'] : [])]
  const env = { OPENAI_API_KEY: 'owned-fake-provider-key', VIVI_SESSION_DIR: directory }
  const input = { io, args, env, options: parseArguments(args, env), secrets: [env.OPENAI_API_KEY],
    registerSecret(value) { registered.push(value) },
    credentials: { async status() { return { available: false, label: 'Owned fixture' } }, async load() { return undefined }, async save() { assert.fail('No credential storage expected') } },
    mcpManagerFactory(options) {
      managerOptions = options
      manager = new McpManager({ ...options, httpFetch: async (url, init) => {
        assert.equal(String(url), endpoint); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual')
        const message = JSON.parse(init.body)
        requests.push({ message, headers: new Headers(init.headers) })
        if (message.method === 'server/discover') return json(message, { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } })
        if (message.method === 'tools/list') return json(message, { tools: [{ name: 'owned-app-echo', inputSchema: { type: 'object',
          properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }] })
        if (message.method === 'tools/call') return json(message, { content: [{ type: 'text', text: `${token} ${refresh} ${code}` }] })
        assert.fail(`Unexpected application MCP request ${message.method}`)
      } })
      return manager
    },
    mcpOAuth: { timeoutMs: 5000,
      fetchFn: async (input, init) => {
        const url = new URL(String(input)); assert([new URL(endpoint).origin, issuer].includes(url.origin))
        oauthRequests.push({ url: url.href, method: init?.method ?? 'GET', body: init?.body })
        if (url.href === endpoint) return new Response(null, { status: 405 })
        if (url.origin === new URL(endpoint).origin && url.pathname.startsWith('/.well-known/oauth-protected-resource'))
          return Response.json({ resource: endpoint, authorization_servers: [issuer] })
        if (url.origin === issuer && url.pathname.includes('/.well-known/')) return Response.json(metadata)
        if (url.href === metadata.token_endpoint && init.method === 'POST')
          return Response.json({ access_token: token, refresh_token: refresh, token_type: 'Bearer', expires_in: 60 })
        assert.fail(`Unexpected application OAuth request ${url.href}`)
      },
      openBrowser: async url => {
        browserUrls.push(new URL(url)); assert.equal(url.origin, issuer)
        if (cancelAtBrowser) { io.close(); io.cancel?.(); return }
        const callback = new URL(url.searchParams.get('redirect_uri'))
        assert.equal(callback.port, String(port)); assert.equal(callback.pathname, '/app/oauth/callback')
        callback.searchParams.set('state', url.searchParams.get('state')); callback.searchParams.set('iss', issuer); callback.searchParams.set('code', code)
        const response = await fetch(callback); assert.equal(response.status, 200); clean(await response.text())
      }
    },
    providerFactory(_session, options) {
      providerCreations++; assert.equal(options.enableTools, true)
      return { async generate(input) {
        generated++; inputs.push(structuredClone(input))
        if (tool && generated === 2) {
          const remote = input.tools.find(item => item.name.startsWith('mcp_remote_'))
          assert(remote, 'The freshly authenticated catalog was absent from model tools')
          return { content: '', toolCalls: [{ id: 'owned-app-tool-call', name: remote.name, arguments: { query: 'ordinary' } }] }
        }
        return { content: 'Owned application answer', toolCalls: [] }
      } }
    }
  }
  return { directory, io, input, port, oauthRequests, requests, browserUrls, registered, inputs,
    manager: () => manager, managerOptions: () => managerOptions, providerCreations: () => providerCreations,
    selections, texts }
}
async function inspectFiles(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name)
    if (entry.isDirectory()) await inspectFiles(file)
    else clean(await readFile(file, 'utf8'))
  }
}

test('application sign-in updates an existing host privacy boundary, exposes fresh catalog and revokes auth on exit', async t => {
  const subject = await fixture(t, { tool: true })
  assert.equal(await runApplication(subject.input), 0)
  assert.equal(subject.io.approvals[0].call.name, 'sign_in_mcp_server')
  assert.equal(subject.io.approvals.length, 2); assert.equal(subject.requests.filter(item => item.message.method === 'tools/call').length, 1)
  assert.equal(subject.browserUrls.length, 1); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
  assert(subject.requests.every(item => item.headers.get('authorization') === `Bearer ${token}`))
  assert.equal(subject.providerCreations(), 1, 'OAuth UI must update the current host, rather than replace its conversation')
  assert.equal(subject.io.sessions.at(-1).history[0].content, 'Before sign-in')
  assert(subject.registered.includes(token)); assert(subject.registered.includes(refresh)); assert(subject.registered.includes(code))
  assert(subject.io.protected.includes(token)); assert(subject.io.protected.includes(refresh)); assert(subject.io.protected.includes(code))
  assert(subject.inputs.every(input => input.tools.every(item => !/sign_in_mcp|oauth|refresh_token/.test(item.name))))
  assert(!subject.inputs[0].tools.some(item => item.name.startsWith('mcp_remote_')))
  assert(subject.inputs[0].tools.some(item => item.name === 'mcp_list'))
  assert(!subject.inputs[0].tools.some(item => item.name === 'mcp_setup'), 'noninteractive IO cannot expose setup effects')
  clean([subject.io.output, subject.io.approvals, subject.io.sessions, subject.io.events, subject.io.results, subject.inputs])
  await inspectFiles(subject.directory)
  assert.equal(subject.managerOptions().httpAuthorization(server).bearerToken, undefined)
  assert.equal(subject.manager().statuses()[0].state, 'disabled')
  assert(subject.io.choices.filter(item => /MCP|OAuth|remote/.test(item.title)).every(item => item.initial === 0))
  assert.equal(subject.selections.length, 0); assert.equal(subject.texts.length, 0)
  await noListener(subject.port)
})

test('application denied sign-in does no browser/token/MCP work and saves no client settings', async t => {
  const subject = await fixture(t, { approved: false })
  const before = await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8')
  assert.equal(await runApplication(subject.input), 0)
  assert.deepEqual(subject.io.approvals.map(item => item.call.name), ['sign_in_mcp_server'])
  assert.equal(subject.browserUrls.length, 0); assert.equal(subject.requests.length, 0)
  assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 0)
  assert.equal(subject.managerOptions().httpAuthorization(server).bearerToken, undefined)
  assert.equal(await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8'), before)
  clean([subject.io.output, subject.io.sessions, subject.inputs]); await inspectFiles(subject.directory)
  await noListener(subject.port)
})

test('application /mcp prompt supports explicit OAuth without creating a provider or conversation and closes grant', async t => {
  const subject = await fixture(t, { prompt: true })
  assert.equal(await runApplication(subject.input), 0)
  assert.equal(subject.providerCreations(), 0); assert.equal(subject.io.sessions.length, 0)
  assert.equal(subject.browserUrls.length, 1); assert.equal(subject.requests.filter(item => item.message.method === 'tools/list').length, 1)
  assert.deepEqual(subject.io.approvals.map(item => item.call.name), ['sign_in_mcp_server'])
  assert.equal(subject.managerOptions().httpAuthorization(server).bearerToken, undefined)
  assert(subject.registered.includes(token)); assert(subject.io.protected.includes(token))
  clean([subject.io.output, subject.io.approvals]); await inspectFiles(subject.directory)
  const config = await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8')
  assert(!config.includes('owned-app-public-client')); assert(!config.includes('/app/oauth/callback'))
  await noListener(subject.port)
})

test('closing application during OAuth callback wait aborts the listener without granting or connecting', async t => {
  const subject = await fixture(t, { cancelAtBrowser: true })
  assert.equal(await runApplication(subject.input), 0)
  assert.equal(subject.browserUrls.length, 1); assert.equal(subject.requests.length, 0)
  assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 0)
  assert.equal(subject.managerOptions().httpAuthorization(server).bearerToken, undefined)
  clean([subject.io.output, subject.io.approvals, subject.io.sessions])
  await noListener(subject.port)
})

for (const surface of ['interactive', 'line']) test(`${surface} main entrypoint wires injected SDK OAuth controls and owns grant shutdown`, async t => {
  const subject = await fixture(t, { prompt: true })
  const dependencies = { providerFactory: subject.input.providerFactory, credentials: subject.input.credentials,
    mcpManagerFactory: subject.input.mcpManagerFactory, mcpOAuth: subject.input.mcpOAuth,
    ...(surface === 'interactive' ? { tuiIO: subject.io } : { io: subject.io }) }
  assert.equal(await main([...subject.input.args, ...(surface === 'line' ? ['--no-tui'] : [])], subject.input.env, dependencies), 0)
  assert.equal(subject.providerCreations(), 0); assert.equal(subject.io.sessions.length, 0)
  assert.equal(subject.browserUrls.length, 1); assert.equal(subject.oauthRequests.filter(item => item.method === 'POST').length, 1)
  assert.equal(subject.requests.filter(item => item.message.method === 'tools/list').length, 1)
  assert.deepEqual(subject.io.approvals.map(item => item.call.name), ['sign_in_mcp_server'])
  assert.equal(subject.managerOptions().httpAuthorization(server).bearerToken, undefined)
  assert(subject.io.protected.includes(token)); assert(subject.io.protected.includes(refresh)); assert(subject.io.protected.includes(code))
  assert.equal(subject.io.closed, true); clean([subject.io.output, subject.io.approvals]); await inspectFiles(subject.directory)
  await noListener(subject.port)
})
