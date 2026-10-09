// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { McpConfigStore } from '../dist/mcp-config.js'
import { McpManager } from '../dist/mcp-manager.js'
import { collectMcpCategory, mcpAlias } from '../dist/mcp-catalog.js'
import { mcpContainsSecret } from '../dist/mcp-content.js'

const fixtureFile = fileURLToPath(new URL('./fixtures/mcp-invocation-server.mjs', import.meta.url))
const fixtureEnvironment = process.platform === 'win32' && !process.versions.bun ? ['SYSTEMROOT'] : []
const fixtureEnv = fixtureEnvironment.length ? { SYSTEMROOT: Object.entries(process.env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1]
  ?? assert.fail('Windows Node fixture requires an explicitly captured SystemRoot') } : {}
const signal = () => new AbortController().signal
test('MCP credential scan preserves escaped and valid percent bytes beside malformed bytes', () => {
  const secrets = ['fixture-known-secret']
  for (const value of ['fixture%2Dknown%2Dsecret invalid-%', 'fixture%2Dknown%2Dsecret%FF',
    'fixture\\u0025%32%44known%2Dsecret invalid-%', { 'fixture%2Dknown%2Dsecret': 'ordinary' }]) {
    assert.equal(mcpContainsSecret(value, secrets), true)
  }
  assert.equal(mcpContainsSecret('ordinary invalid-% and %FF', secrets), false)
})
test('admitted large numeric schema examples are not misclassified as known credentials', async () => {
  const category = await collectMcpCategory('fixture', 'tools', async () => ({ tools: Array.from({ length: 32 }, (_, index) => ({
    name: `numeric-${index}`, inputSchema: { type: 'object', examples: [Array(3500).fill(0)] }
  })) }), signal())
  assert.equal(category.state, 'ready'); assert.equal(category.entries.length, 32)
  assert(category.entries.every(entry => entry.state === 'available'))
  assert.equal(mcpContainsSecret(category, []), false)
  assert.equal(mcpContainsSecret(category, ['unrelated-credential-marker']), false)
  const sensitive = structuredClone(category)
  sensitive.entries.at(-1).descriptor.inputSchema.description = 'unrelated%2Dcredential%2Dmarker invalid-%'
  assert.equal(mcpContainsSecret(sensitive, ['unrelated-credential-marker']), true)
})
test('admitted large numeric session arrays are scanned without argument-stack overflow', () => {
  const items = Array(200_000).fill(0), secrets = ['unrelated-credential-marker']
  assert.equal(mcpContainsSecret({ providerState: { items } }, secrets), false)
  items.push('unrelated%2Dcredential%2Dmarker invalid-%')
  assert.equal(mcpContainsSecret({ providerState: { items } }, secrets), true)
})
async function fixture(t, mode = 'normal', protocol = 'legacy') {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-invocation-'))
  const store = new McpConfigStore(directory)
  const server = { id: 'fixture', label: 'Owned invocation fixture', executable: process.execPath,
    args: [...(process.versions.bun ? ['--no-install'] : []), fixtureFile, mode, join(directory, 'log'), join(directory, 'pid')],
    cwd: directory, protocol, environment: fixtureEnvironment }
  const manager = new McpManager({ store, env: { ...fixtureEnv, OPENAI_API_KEY: 'offline-known-secret-marker' }, secrets: ['offline-known-secret-marker'] })
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }) })
  await manager.configure(server)
  assert.equal((await manager.captureCatalogs(signal())).length, 0)
  assert.equal(await manager.connect('fixture', async () => true, signal()), true)
  return { manager, store, server, directory,
    log: async () => (await readFile(join(directory, 'log'), 'utf8')).trim().split('\n').map(JSON.parse) }
}
function operation(manager, snapshot, kind = 'tools', key = 'echo/name', arguments_ = { query: 'hello' }) {
  const entry = snapshot.categories[kind].entries.find(item => item.remoteKey === key)
  assert(entry, `Missing fixture entry ${key}`)
  const call = { id: `invoke-${kind}`, name: kind === 'tools' ? entry.alias : 'read_mcp_resource', arguments: arguments_ }
  return manager.prepareOperation(snapshot, entry, kind, call, kind === 'resources' ? key : undefined)
}
const invoke = (manager, prepared, abortSignal = signal(), assertCurrent = () => {}) => manager.invoke(prepared, abortSignal, assertCurrent)
const content = result => JSON.parse(result.content)
const requests = async (subject, method) => (await subject.log()).filter(message => message.method === method)

for (const protocol of ['legacy', '2026-07-28']) test(`owned stdio ${protocol} calls an exact captured tool once without another discovery request`, async t => {
  const subject = await fixture(t, 'normal', protocol)
  const [snapshot] = await subject.manager.captureCatalogs(signal())
  assert(Object.isFrozen(snapshot)); assert(Object.isFrozen(snapshot.categories.tools.entries))
  const entry = snapshot.categories.tools.entries.find(item => item.remoteKey === 'echo/name')
  assert.equal(entry.alias, mcpAlias('fixture', 'tools', 'echo/name'))
  assert.notEqual(entry.alias, snapshot.categories.tools.entries.find(item => item.remoteKey === 'echo_name').alias)
  assert.deepEqual(entry.descriptor.inputSchema.required, ['query'])
  const prepared = operation(subject.manager, snapshot)
  assert(Object.isFrozen(prepared)); assert(Object.keys(subject.manager.operationRevisions(prepared)).length > 0)
  const result = await invoke(subject.manager, prepared), projected = content(result)
  assert.equal(result.isError, undefined)
  assert.equal(projected.source, 'mcp'); assert.equal(projected.untrusted, true)
  assert.match(JSON.stringify(projected), /Echo: hello/)
  assert.match(JSON.stringify(projected), /"echo":"hello"/)
  assert.equal((await requests(subject, 'tools/call')).length, 1)
  assert.deepEqual((await requests(subject, 'tools/call'))[0].params.arguments, { query: 'hello' })
  assert.equal((await requests(subject, 'tools/call'))[0].params.name, 'echo/name')
  assert.equal((await requests(subject, 'tools/list')).length, 1)
  assert.equal((await subject.log())[0].env.some(name => /API_KEY|TOKEN|NODE_OPTIONS/.test(name)), false)
})

test('input validation preserves constraints and rejects unknown or quarantined tools before any send', async t => {
  const subject = await fixture(t), [snapshot] = await subject.manager.captureCatalogs(signal())
  for (const arguments_ of [{}, { query: '' }, { query: 1 }, { query: 'hello', count: 4 }, { query: 'hello', unexpected: true }, { query: 'offline-known-secret-marker' }]) {
    assert.throws(() => operation(subject.manager, snapshot, 'tools', 'echo/name', arguments_))
  }
  assert.throws(() => operation(subject.manager, snapshot, 'tools', 'unsafe/name'))
  const entry = snapshot.categories.tools.entries.find(item => item.remoteKey === 'echo/name')
  assert.throws(() => subject.manager.prepareOperation(snapshot, { ...entry, remoteKey: 'invented' }, 'tools', { id: 'invented', name: entry.alias, arguments: { query: 'hello' } }))
  assert.equal((await requests(subject, 'tools/call')).length, 0)
})

for (const protocol of ['legacy', '2026-07-28']) test(`owned stdio ${protocol} reads an exact discovered URI and bypasses the SDK resource cache`, async t => {
  const subject = await fixture(t, 'normal', protocol)
  await subject.manager.refresh('fixture', ['resources', 'resourceTemplates'], signal())
  const [snapshot] = await subject.manager.captureCatalogs(signal())
  for (let sequence = 1; sequence <= 2; sequence++) {
    const result = await invoke(subject.manager, operation(subject.manager, snapshot, 'resources', 'fixture:///document', { serverId: 'fixture', uri: 'fixture:///document' }))
    assert.equal(result.isError, undefined)
    assert.match(result.content, new RegExp(`Owned resource ${sequence}`))
  }
  assert.equal((await requests(subject, 'resources/read')).length, 2)
  assert((await requests(subject, 'resources/read')).every(request => request.params.uri === 'fixture:///document'))
  const entry = snapshot.categories.resources.entries[0]
  assert.throws(() => subject.manager.prepareOperation(snapshot, entry, 'resources', { id: 'arbitrary', name: 'read_mcp_resource', arguments: { serverId: 'fixture', uri: 'file:///not-discovered' } }, 'file:///not-discovered'))
  assert.throws(() => operation(subject.manager, snapshot, 'resourceTemplates', 'fixture:///{name}', { serverId: 'fixture', uri: 'fixture:///invented' }))
  assert.equal((await requests(subject, 'resources/read')).length, 2)
})

test('catalog, connection and configuration changes block prepared operations before the remote send', async t => {
  const subject = await fixture(t), [snapshot] = await subject.manager.captureCatalogs(signal())
  const stale = operation(subject.manager, snapshot)
  await subject.manager.refresh('fixture', ['tools'], signal())
  assert.equal((await invoke(subject.manager, stale)).isError, true)
  const [current] = await subject.manager.captureCatalogs(signal()), disconnected = operation(subject.manager, current)
  await subject.manager.disconnect('fixture')
  assert.equal((await invoke(subject.manager, disconnected)).isError, true)
  assert.equal(await subject.manager.connect('fixture', async () => true, signal()), true)
  const [reconnected] = await subject.manager.captureCatalogs(signal()), changed = operation(subject.manager, reconnected)
  const configuration = await subject.store.load()
  await subject.store.save([{ ...subject.server, label: 'Changed local configuration' }], configuration.revision)
  assert.equal((await invoke(subject.manager, changed)).isError, true)
  assert.equal((await requests(subject, 'tools/call')).length, 0)
  assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
})

test('newly known secrets and a failed current-turn assertion block the send', async t => {
  const subject = await fixture(t), [snapshot] = await subject.manager.captureCatalogs(signal())
  const prepared = operation(subject.manager, snapshot, 'tools', 'echo/name', { query: 'late-known-marker' })
  subject.manager.addSecrets(['late-known-marker'])
  const withheld = await invoke(subject.manager, prepared)
  assert.equal(withheld.isError, true); assert(!withheld.content.includes('late-known-marker'))
  const rejected = await invoke(subject.manager, operation(subject.manager, snapshot), signal(), () => { throw new Error('Turn ended') })
  assert.equal(rejected.isError, true)
  assert.equal((await requests(subject, 'tools/call')).length, 0)
})

for (const protocol of ['legacy', '2026-07-28']) for (const kind of ['tools', 'resources']) {
  test(`${protocol} ${kind} revalidates persisted configuration after SDK setup and before sending`, async t => {
    const subject = await fixture(t, 'normal', protocol)
    if (kind === 'resources') await subject.manager.refresh('fixture', ['resources'], signal())
    const [snapshot] = await subject.manager.captureCatalogs(signal())
    const prepared = kind === 'tools' ? operation(subject.manager, snapshot)
      : operation(subject.manager, snapshot, 'resources', 'fixture:///document', { serverId: 'fixture', uri: 'fixture:///document' })
    let checks = 0
    const result = await invoke(subject.manager, prepared, signal(), () => {
      // This trusted fixture seam runs after invoke's initial reload. The final
      // transport must observe this removal before the effect request is sent.
      if (++checks === 1) writeFileSync(join(subject.directory, 'mcp-servers.json'), JSON.stringify({ schemaVersion: 1, servers: [] }), { mode: 0o600 })
    })
    assert.equal(result.isError, true); assert.equal(content(result).unknownOutcome, undefined)
    assert.equal((await requests(subject, kind === 'tools' ? 'tools/call' : 'resources/read')).length, 0)
    assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
  })
}

for (const mode of ['malformed', 'bad-output', 'missing-structured', 'oversize-result', 'many-items', 'drift', 'input-required', 'header-mismatch', 'secret-result']) test(`post-send ${mode} fails closed with an unknown outcome and no automatic retry`, async t => {
  const subject = await fixture(t, mode, '2026-07-28'), [snapshot] = await subject.manager.captureCatalogs(signal())
  const result = await invoke(subject.manager, operation(subject.manager, snapshot)), projected = content(result)
  assert.equal(result.isError, true); assert.equal(projected.unknownOutcome, true)
  assert(!result.content.includes('offline-known-secret-marker'))
  assert(['disabled', 'error'].includes(subject.manager.statuses()[0].state))
  assert.equal((await requests(subject, 'tools/call')).length, 1)
  assert.equal((await requests(subject, 'tools/list')).length, 1)
  assert(!(await subject.log()).some(message => JSON.stringify(message).includes('inputResponses')))
  assert.equal((await subject.manager.captureCatalogs(signal())).length, 0)
})

test('post-send cancellation reports unknown outcome and disables the owned connection', async t => {
  const subject = await fixture(t, 'hang'), [snapshot] = await subject.manager.captureCatalogs(signal())
  const controller = new AbortController(), pending = invoke(subject.manager, operation(subject.manager, snapshot), controller.signal)
  const deadline = Date.now() + 10000
  while ((await requests(subject, 'tools/call')).length === 0) {
    assert(Date.now() < deadline, 'Owned fixture never received the invocation')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  controller.abort()
  const result = await pending
  assert.equal(result.isError, true); assert.equal(content(result).unknownOutcome, true)
  assert(['disabled', 'error'].includes(subject.manager.statuses()[0].state))
  assert.equal((await requests(subject, 'tools/call')).length, 1)
})

test('a mismatched returned resource URI is an unknown outcome and is not published', async t => {
  const subject = await fixture(t, 'wrong-uri')
  await subject.manager.refresh('fixture', ['resources'], signal())
  const [snapshot] = await subject.manager.captureCatalogs(signal())
  const result = await invoke(subject.manager, operation(subject.manager, snapshot, 'resources', 'fixture:///document', { serverId: 'fixture', uri: 'fixture:///document' }))
  assert.equal(result.isError, true); assert.equal(content(result).unknownOutcome, true)
  assert(!result.content.includes('Owned resource')); assert(!result.content.includes('fixture:///other'))
  assert.equal((await requests(subject, 'resources/read')).length, 1)
})

test('mixed results preserve text and structured data, omit binary payloads and leave links inert', async t => {
  const subject = await fixture(t, 'mixed'), [snapshot] = await subject.manager.captureCatalogs(signal())
  const result = await invoke(subject.manager, operation(subject.manager, snapshot))
  assert.match(result.content, /Echo: hello/); assert.match(result.content, /Embedded local text/)
  assert.match(result.content, /never-follow.invalid/)
  for (const payload of ['aW1hZ2U=', 'YXVkaW8=', 'YmluYXJ5']) assert(!result.content.includes(payload))
  assert.equal((await requests(subject, 'tools/call')).length, 1)
  assert.equal((await requests(subject, 'resources/read')).length, 0)
})

test('server requests during a call receive no roots, sampling or elicitation data', async t => {
  const subject = await fixture(t, 'server-request'), [snapshot] = await subject.manager.captureCatalogs(signal())
  const result = await invoke(subject.manager, operation(subject.manager, snapshot))
  assert.equal(result.isError, undefined)
  const deadline = Date.now() + 10000
  let response
  while (!(response = (await subject.log()).find(message => message.id === 'fixture-server-request' && message.error))) {
    assert(Date.now() < deadline, 'Owned fixture never received the unsupported-request response')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(response.error.code, -32601)
  assert(!('result' in response)); assert.equal((await requests(subject, 'tools/call')).length, 1)
})


test('a confirmed tool error stays a bounded untrusted error without disabling the connection', async t => {
  const subject = await fixture(t, 'tool-error'), [snapshot] = await subject.manager.captureCatalogs(signal())
  const result = await invoke(subject.manager, operation(subject.manager, snapshot))
  assert.equal(result.isError, true); assert.equal(content(result).success, false)
  assert.equal(content(result).unknownOutcome, undefined)
  assert.match(result.content, /Echo: hello/)
  assert.equal(subject.manager.statuses()[0].state, 'connected')
  assert.equal((await requests(subject, 'tools/call')).length, 1)
})

test('a post-send deadline is unknown and is never automatically retried', { timeout: 30_000 }, async t => {
  const subject = await fixture(t, 'hang'), [snapshot] = await subject.manager.captureCatalogs(signal())
  const result = await invoke(subject.manager, operation(subject.manager, snapshot))
  assert.equal(result.isError, true); assert.equal(content(result).unknownOutcome, true)
  assert.equal(content(result).doNotRetry, true)
  assert.equal(subject.manager.statuses()[0].state, 'error')
  assert.equal((await requests(subject, 'tools/call')).length, 1)
})
