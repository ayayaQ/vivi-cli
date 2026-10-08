// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpConfigStore, prepareMcpLaunch, validateMcpServer } from '../dist/mcp-config.js'
import { collectMcpCategory, mcpAlias, MCP_LIMITS } from '../dist/mcp-catalog.js'
import { McpManager, mcpStartDisclosure } from '../dist/mcp-manager.js'
import { CliHost } from '../dist/host.js'
import { newSession } from '../dist/session.js'
import { McpStdioTransport } from '../dist/mcp-transport.js'
const fixtureFile = fileURLToPath(new URL('./fixtures/mcp-discovery-server.mjs', import.meta.url))
const signal = () => new AbortController().signal
async function fixture(t, mode = 'normal', protocol = 'legacy') {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-discovery-'))
  const store = new McpConfigStore(directory, ['fixture-secret'])
  const server = { id: 'docs', label: 'Fixture', executable: process.execPath, args: [fixtureFile, mode, join(directory, 'log'), join(directory, 'pid')], cwd: directory, protocol, environment: [] }
  let starts = 0
  const manager = new McpManager({ store, env: { OPENAI_API_KEY: 'fixture-secret', NODE_OPTIONS: '--invalid', PATH: '/unexpected' }, secrets: ['fixture-secret'], transportFactory: launch => { starts++; return new McpStdioTransport(launch) } })
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }) })
  await manager.reload(); await manager.configure(server)
  return { directory, store, server, manager, starts: () => starts,
    log: async () => (await readFile(join(directory, 'log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) }
}
const tool = (name, schema = { type: 'object', properties: {} }) => ({ name, inputSchema: schema })
const collect = (items, kind = 'tools', aliasFor) => collectMcpCategory('docs', kind, async () => ({ [kind]: items }), signal(), aliasFor)

test('configuration is app-private, bounded and loads disabled without startup', async t => {
  const subject = await fixture(t)
  assert.equal(subject.starts(), 0)
  assert.equal(subject.manager.statuses()[0].state, 'disabled')
  const raw = JSON.parse(await readFile(join(subject.directory, 'mcp-servers.json'), 'utf8'))
  assert.deepEqual(Object.keys(raw).sort(), ['schemaVersion', 'servers'])
  assert(!JSON.stringify(raw).includes('enabled'))
  if (process.platform !== 'win32') assert.equal((await stat(join(subject.directory, 'mcp-servers.json'))).mode & 0o777, 0o600)
  const replacement = new McpManager({ store: subject.store, env: {} }); await replacement.reload()
  assert.equal(replacement.statuses()[0].state, 'disabled'); await replacement.close()
})
test('invalid configuration rejects remote/shell/package runners and secret environment or arguments', () => {
  const base = { id: 'docs', label: 'Docs', executable: process.execPath, args: [], cwd: tmpdir(), protocol: 'legacy', environment: [] }
  for (const invalid of [{ ...base, id: 'BAD' }, { ...base, executable: 'node' }, { ...base, executable: '/usr/bin/npx' }, { ...base, executable: '/bin/sh' },
    { ...base, transport: 'http' }, { ...base, environment: ['OPENAI_API_KEY'] }, { ...base, args: ['fixture-secret'] }, { ...base, label: '\x1b[2J' }, { ...base, protocol: 'auto' }, { ...base, protocol: ['legacy'] }, { ...base, protocol: ['2026-07-28'] }, { ...base, args: ['--token', 'unknown-private-value'] }, { ...base, args: ['sk-proj-' + 'a'.repeat(40)] }, { ...base, args: ['--eval', 'setInterval(()=>{},1000)'] }])
    assert.throws(() => validateMcpServer(invalid, ['fixture-secret']))
})
test('configuration revision prevents overwrites and imported enabled entries are rejected', async t => {
  const subject = await fixture(t), current = await subject.store.load()
  await assert.rejects(subject.store.save([], 'stale'), /changed/)
  await writeFile(join(subject.directory, 'mcp-servers.json'), JSON.stringify({ schemaVersion: 1, servers: [{ ...subject.server, enabled: true }] }), { mode: 0o600 })
  await assert.rejects(subject.store.load(), /Invalid MCP/)
  assert.equal(subject.starts(), 0); assert(current.revision)
})
test('denied or cancelled startup sends no requests and spawns no process', async t => {
  const subject = await fixture(t)
  assert.equal(await subject.manager.connect('docs', async launch => { assert.match(mcpStartDisclosure(launch), /OS permissions/); return false }, signal()), false)
  assert.equal(subject.starts(), 0)
  const controller = new AbortController()
  await assert.rejects(subject.manager.connect('docs', async () => { controller.abort(); return true }, controller.signal))
  assert.equal(subject.starts(), 0)
})
test('configuration changes during approval invalidate the exact launch', async t => {
  const subject = await fixture(t)
  await assert.rejects(subject.manager.connect('docs', async () => { const current = await subject.store.load(); await subject.store.save([{ ...subject.server, label: 'Changed' }], current.revision); return true }, signal()), /changed/)
  assert.equal(subject.starts(), 0)
})
test('safe launch environment is exact and credentials are absent', async t => {
  const subject = await fixture(t)
  const launch = await prepareMcpLaunch(subject.server, 'revision', { OPENAI_API_KEY: 'fixture-secret', NODE_OPTIONS: '--inspect' }, ['fixture-secret'])
  assert.deepEqual(launch.environment, {}); assert(Object.isFrozen(launch.server.args)); assert.equal(launch.server.executable, process.execPath)
})
for (const protocol of ['legacy', '2026-07-28']) test(`real harmless stdio discovery: ${protocol}, one process, no call/read or client capabilities`, {}, async t => {
  const subject = await fixture(t, 'pages', protocol)
  assert.equal(await subject.manager.connect('docs', async () => true, signal()), true)
  const status = subject.manager.statuses()[0]
  assert.equal(status.state, 'connected'); assert.equal(status.snapshot.protocolVersion, protocol === 'legacy' ? '2025-11-25' : protocol)
  assert.equal(status.snapshot.categories.tools.state, 'ready'); assert.equal(status.snapshot.categories.tools.entries.length, 2)
  assert(Object.isFrozen(status.snapshot.categories.tools.entries[0].descriptor.inputSchema))
  await subject.manager.refresh('docs', ['resources', 'resourceTemplates'], signal())
  assert.equal(subject.starts(), 1)
  const log = await subject.log(), requests = log.filter(value => value.method)
  assert.deepEqual(log[0].env, [])
  assert(requests.every(value => ['initialize', 'server/discover', 'notifications/initialized', 'tools/list', 'resources/list', 'resources/templates/list'].includes(value.method)))
  const first = requests.find(value => value.method === 'tools/list')
  assert.equal(first.params.cursor, undefined)
  assert.equal(requests.filter(value => value.method === 'tools/list')[1].params.cursor, 'opaque cursor')
  if (protocol === 'legacy') assert.deepEqual(requests[0].params.capabilities, {})
  else assert.deepEqual(requests[0].params._meta['io.modelcontextprotocol/clientCapabilities'], {})
  assert.equal(status.snapshot.categories.resources.state, 'not-requested')
  await subject.manager.disconnect('docs'); assert.equal(subject.manager.statuses()[0].state, 'disabled')
})
test('names are exact, aliases stable, namespaces and kinds remain distinct', async () => {
  const a = await collect([tool('a/b'), tool('a_b')])
  assert.notEqual(a.entries[0].alias, a.entries[1].alias)
  assert.equal(mcpAlias('docs', 'tools', 'same'), mcpAlias('docs', 'tools', 'same'))
  assert.notEqual(mcpAlias('docs', 'tools', 'same'), mcpAlias('other', 'tools', 'same'))
  assert.notEqual(mcpAlias('docs', 'tools', 'same'), mcpAlias('docs', 'resources', 'same'))
  assert.deepEqual(a.entries.map(value => value.remoteKey), ['a/b', 'a_b'])
  await assert.rejects(collect([tool('same'), tool('same')]), /duplicate/)
  await assert.rejects(collect([tool('a'), tool('b')], 'tools', () => 'forced_collision'), /collision/)
})
for (const [name, schema] of Object.entries({ regex: { type: 'object', pattern: '(a+)+$' }, external: { type: 'object', $ref: 'https://never-fetch/schema' },
  header: { type: 'object', properties: { token: { type: 'string', 'x-mcp-header': 'Authorization' } } }, dialect: { type: 'object', $schema: 'https://unsupported/schema' },
  unknown: { type: 'object', unknownConstraint: true }, invalid: { type: 'invalid' } })) test(`unsafe ${name} schema is quarantined without mutation`, async () => {
  const descriptor = tool('unsafe', schema), before = structuredClone(descriptor)
  const category = await collect([descriptor])
  assert.equal(category.entries[0].state, 'quarantined'); assert(category.entries[0].reason); assert.deepEqual(descriptor, before)
})
test('catalog rejects repeated/invalid cursors, too many pages/items, large and deep descriptors', async () => {
  await assert.rejects(collectMcpCategory('docs', 'tools', async () => ({ tools: [], nextCursor: 'repeat' }), signal()), /repeated/)
  let page = 0
  await assert.rejects(collectMcpCategory('docs', 'tools', async () => ({ tools: [], nextCursor: String(++page) }), signal()), /pagination/)
  assert.equal(page, MCP_LIMITS.pages)
  await assert.rejects(collect(Array.from({ length: MCP_LIMITS.entries + 1 }, (_, index) => tool(String(index)))), /limit/)
  await assert.rejects(collect([tool('a', { type: 'object', description: 'x'.repeat(MCP_LIMITS.descriptorBytes) })]), /limit/)
  let schema = { type: 'object' }; for (let index = 0; index < 40; index++) schema = { type: 'object', properties: { nested: schema } }
  await assert.rejects(collect([tool('deep', schema)]), /complexity/)
})
for (const mode of ['fail-refresh', 'list-changed']) test(`failed or changed refresh keeps a stale display snapshot: ${mode}`, {}, async t => {
  const subject = await fixture(t, mode)
  assert.equal(await subject.manager.connect('docs', async () => true, signal()), true)
  const before = subject.manager.statuses()[0].snapshot
  await subject.manager.refresh('docs', ['tools'], signal())
  const after = subject.manager.statuses()[0].snapshot
  assert.equal(after.categories.tools.state, 'stale'); assert.equal(after.categories.tools.entries[0].remoteKey, before.categories.tools.entries[0].remoteKey)
  assert.notEqual(after.catalogGeneration, before.catalogGeneration)
  assert.equal(after.categories.resources.state, 'not-requested')
})
test('absent capabilities are unsupported rather than empty catalogs', {}, async t => {
  const subject = await fixture(t, 'no-capability')
  assert.equal(await subject.manager.connect('docs', async () => true, signal()), true)
  assert.equal(subject.manager.statuses()[0].snapshot.categories.tools.state, 'unsupported')
  assert(!(await subject.log()).some(value => value.method === 'tools/list'))
})
test('server requests have no roots/sampling/elicitation handler and are never fulfilled', {}, async t => {
  const subject = await fixture(t, 'server-request')
  assert.equal(await subject.manager.connect('docs', async () => true, signal()), true)
  await new Promise(resolve => setTimeout(resolve, 30))
  const response = (await subject.log()).find(value => value.id === 'server-input' && value.error)
  assert.equal(response.error.code, -32601)
})
test('cancellation during initialization closes the process and never reconnects', {}, async t => {
  const subject = await fixture(t, 'hang'), controller = new AbortController()
  const pending = subject.manager.connect('docs', async () => true, controller.signal)
  const deadline = Date.now() + 10000
  while (true) {
    try { await readFile(join(subject.directory, 'pid'), 'utf8'); break } catch {}
    assert(Date.now() < deadline, 'fixture did not start')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  controller.abort()
  assert.equal(await pending, false)
  assert.equal(subject.starts(), 1)
  const pid = Number(await readFile(join(subject.directory, 'pid'), 'utf8'))
  assert.throws(() => process.kill(pid, 0), /ESRCH/)
  assert.equal(subject.manager.statuses()[0].state, 'error')
})
test('transport refuses tool calls, resource reads and forbidden workflows', async t => {
  const subject = await fixture(t), launch = await prepareMcpLaunch(subject.server, 'rev', {})
  const transport = new McpStdioTransport(launch)
  for (const method of ['tools/call', 'resources/read', 'prompts/get', 'subscriptions/listen']) await assert.rejects(transport.send({ jsonrpc: '2.0', id: 1, method }), /Only MCP discovery/)
  await transport.close()
})

async function dead(pid) {
  try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') return true; throw error }
  if (process.platform === 'linux') {
    try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return ['Z', 'X'].includes(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[0]) }
    catch (error) { if (error.code === 'ENOENT') return true; throw error }
  }
  return false
}
test('disable verifies root and owned descendant death, and reconnect requires fresh consent', async t => {
  const subject = await fixture(t, 'tree')
  assert.equal(await subject.manager.connect('docs', async () => true, signal()), true)
  const pids = (await readFile(join(subject.directory, 'pid'), 'utf8')).trim().split('\n').map(Number)
  assert.equal(pids.length, 2)
  await subject.manager.disconnect('docs')
  for (const pid of pids) assert(await dead(pid), `process ${pid} still alive`)
  const generation = subject.manager.statuses()[0].snapshot?.connectionGeneration
  assert.equal(await subject.manager.connect('docs', async () => false, signal()), false)
  assert.equal(subject.starts(), 1); assert.equal(generation, undefined)
})
test('schema constraints are retained exactly; invalid sizes and compound compilation are quarantined', async () => {
  const schema = {type: 'object', properties: {query: {type: 'string', minLength: 2, maxLength: 20}, count: {type: 'integer', minimum: 1, maximum: 9}}, required: ['query'], additionalProperties: false}
  const category = await collect([tool('supported', schema), tool('negative', {type: 'object', minProperties: -1}), tool('compound', {type: 'object', anyOf: [{type:'object'}]})])
  assert.equal(category.entries.find(entry=>entry.remoteKey==='supported').state, 'available')
  assert.deepEqual(category.entries.find(entry=>entry.remoteKey==='supported').descriptor.inputSchema, schema)
  assert.equal(category.entries.find(entry=>entry.remoteKey==='negative').state, 'quarantined')
  assert.equal(category.entries.find(entry=>entry.remoteKey==='compound').state, 'quarantined')
})
test('input_required metadata is unavailable and is never automatically fulfilled', async t => {
  const subject = await fixture(t, 'input-required', '2026-07-28')
  assert.equal(await subject.manager.connect('docs', async () => true, signal()), true)
  assert.equal(subject.manager.statuses()[0].snapshot.categories.tools.state, 'error')
  const log = await subject.log()
  assert.equal(log.filter(value=>value.method==='tools/list').length, 1)
  assert(!log.some(value => JSON.stringify(value).includes('inputResponses')))
})
test('server stderr and error messages are never surfaced in status metadata', async t => {
  const subject = await fixture(t, 'stderr')
  assert.equal(await subject.manager.connect('docs', async () => true, signal()), true)
  assert(!JSON.stringify(subject.manager.statuses()).includes('fixture-secret'))
})
test('MCP catalogs never enter model tools, messages or automatic configuration actions', async t => {
  const subject = await fixture(t)
  assert.equal(await subject.manager.connect('docs', async () => true, signal()), true)
  let calls = 0
  const host = new CliHost({store:{async save() {}}, session:newSession({provider:'openai', model:'fixture'}), provider:{async generate({messages,tools}) {
    assert(!JSON.stringify(messages).includes('Untrusted fixture'))
    assert(!tools.some(tool=>tool.name.startsWith('mcp_') || tool.name==='connect_mcp_server'))
    if (++calls === 1) return {content:'',toolCalls:[{id:'forbidden-config', name:'connect_mcp_server', arguments:{serverId:'docs'}}]}
    return {content:'Done',toolCalls:[]}
  }}})
  await host.send('Show me the discovered MCP tools')
  assert.equal(subject.starts(), 1)
  assert(!(await subject.log()).some(value=>value.method==='tools/call' || value.method==='resources/read'))
})

test('concurrent configuration saves have one winner and never silently overwrite', async t => {
  const subject = await fixture(t), current = await subject.store.load()
  const saves = await Promise.allSettled([subject.store.save([{...subject.server,label:'First'}],current.revision), subject.store.save([{...subject.server,label:'Second'}],current.revision)])
  assert.equal(saves.filter(result=>result.status==='fulfilled').length,1)
  assert.equal(saves.filter(result=>result.status==='rejected').length,1)
  assert.equal((await subject.store.load()).servers.length,1)
})
test('external configuration changes during a discovery request invalidate and close the connection', async t => {
  const subject = await fixture(t)
  await subject.manager.close()
  let lists=0
  const manager = new McpManager({store:subject.store,env:{},transportFactory(launch) {
    const transport=new McpStdioTransport(launch),send=transport.send.bind(transport)
    transport.send=async message=>{
      if (message.method==='tools/list' && ++lists===2) {
        const current=await subject.store.load()
        await subject.store.save([{...subject.server,label:'Updated externally'}],current.revision)
      }
      await send(message)
    }
    return transport
  }})
  t.after(()=>manager.close())
  await manager.reload();assert.equal(await manager.connect('docs',async()=>true,signal()),true)
  await manager.refresh('docs',['tools'],signal())
  assert.equal(manager.statuses()[0].state,'disabled')
  assert.equal(manager.statuses()[0].snapshot,undefined)
  const pid=Number(await readFile(join(subject.directory,'pid'),'utf8'));assert(await dead(pid))
})

test('natural root exit completes helper shutdown and closes owned descendants without a manual stop', async t=>{
  const subject=await fixture(t,'tree-exit')
  await subject.manager.connect('docs',async()=>true,signal())
  const deadline=Date.now()+10000
  while(subject.manager.statuses()[0].state!=='error') {
    assert(Date.now()<deadline,'helper did not complete after natural root exit')
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  const pids=(await readFile(join(subject.directory,'pid'),'utf8')).trim().split('\n').map(Number)
  for(const pid of pids)assert(await dead(pid),`process ${pid} remains alive`)
})
