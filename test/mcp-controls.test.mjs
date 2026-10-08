// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { McpConfigStore } from '../dist/mcp-config.js'
import { McpManager } from '../dist/mcp-manager.js'
import { manageMcp } from '../dist/mcp-controls.js'
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-ui-'))
  const store = new McpConfigStore(directory)
  let starts = 0
  const manager = new McpManager({store, env: {}, transportFactory() {starts++;throw new Error('No fixture server should start in these control tests')}})
  t.after(async()=>{await manager.close();await rm(directory,{recursive:true,force:true})})
  await manager.reload()
  return {directory,store,manager,starts:()=>starts}
}
function ioFixture(selections = [], texts = []) {
  return {output:'',choices:[],approvals:[],closed:false, get isClosed(){return this.closed},
    write(value){this.output+=value}, async choose(title, choices, initial){this.choices.push({title,choices,initial});const index=selections.shift();return index===undefined?undefined:choices[index]?.value},
    async askText(){return texts.shift()}, async readLine(){return undefined},
    async approve(request){this.approvals.push(request);return false}, onCancel(callback){this.cancel=callback;return()=>{delete this.cancel}},close(){this.closed=true},event(){},result(){}}
}
test('plain configuration controls save only a disabled entry and do not start a server', async t=>{
  const subject=await fixture(t)
  const io=ioFixture([1,0,0,1,0],['docs','My docs',process.execPath,subject.directory,'0'])
  await manageMcp(subject.manager,io)
  assert.equal(subject.starts(),0);assert.equal(io.approvals.length,0)
  const saved=await subject.store.load();assert.equal(saved.servers.length,1);assert.equal(saved.servers[0].id,'docs')
  assert.equal(subject.manager.statuses()[0].state,'disabled')
  assert(io.choices.every(choice=>choice.initial===0));assert.match(io.output,/saved disabled/)
})
for (const stop of [0,1,2,3,4]) test(`cancelled server configuration at field ${stop} leaves no saved entry`,async t=>{
  const subject=await fixture(t), values=['docs','My docs',process.execPath,subject.directory,'0'].slice(0,stop)
  const io=ioFixture([1,0],values)
  await manageMcp(subject.manager,io)
  assert.equal((await subject.store.load()).servers.length,0);assert.equal(subject.starts(),0)
})
test('startup uses fresh deny-default human approval and never Auto review',async t=>{
  const subject=await fixture(t)
  await subject.manager.configure({id:'docs',label:'Docs',executable:process.execPath,args:[],cwd:subject.directory,protocol:'legacy',environment:[]})
  const io=ioFixture([2,1,0])
  await manageMcp(subject.manager,io)
  assert.equal(subject.starts(),0);assert.equal(io.approvals.length,1)
  assert.equal(io.approvals[0].call.name,'connect_mcp_server')
  assert.match(io.approvals[0].description,/before any tool-call approval/)
  assert.match(io.approvals[0].description,/Working directory:/)
  assert(!io.approvals[0].description.includes('Auto review'))
  assert.equal(subject.manager.statuses()[0].state,'disabled')
})
test('locally assigned IDs matching menu labels remain selectable without aliasing commands',async t=>{
  const subject=await fixture(t)
  await subject.manager.configure({id:'add',label:'Menu-like ID',executable:process.execPath,args:[],cwd:subject.directory,protocol:'legacy',environment:[]})
  const io=ioFixture([2,1,0])
  await manageMcp(subject.manager,io)
  assert.equal(io.approvals.length,1);assert.equal(io.approvals[0].call.arguments.serverId,'add')
  assert.equal(subject.starts(),0)
})
test('line controls present numbered choices and allow cancellation without configuration changes',async t=>{
  const subject=await fixture(t),io=ioFixture()
  delete io.choose;delete io.askText
  let lines=['']
  io.readLine=async()=>lines.shift()
  await manageMcp(subject.manager,io)
  assert.match(io.output,/1\. Back/);assert.equal((await subject.store.load()).servers.length,0)
})

async function retainedPeer(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-cleanup-ui-')), store = new McpConfigStore(directory)
  let blocked = false, starts = 0, closes = 0, reads = 0
  const methods = []
  const manager = new McpManager({ store, env: {}, transportFactory: () => {
    const transport = { start: async () => { starts++ }, close: async () => {
      closes++
      if (blocked) throw new Error('Untrusted transport detail must not appear ' + 'x'.repeat(5000))
      transport.onclose?.()
    }, send: async message => {
      if (!message.method) return
      methods.push(message.method)
      if (message.id === undefined) return
      const result = message.method === 'initialize' ? { resultType: 'complete', protocolVersion: '2025-11-25',
        capabilities: { tools: {} }, serverInfo: { name: 'Private peer', version: '1' } }
        : { resultType: 'complete', tools: [{ name: 'never-show-revoked-metadata', inputSchema: { type: 'object' } }] }
      queueMicrotask(() => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, result }))
    } }
    return transport
  } })
  t.after(async () => { blocked = false; await manager.close(); await rm(directory, { recursive: true, force: true }) })
  await manager.configure({ id: 'docs', label: 'Private peer', executable: process.execPath,
    args: [], cwd: directory, protocol: 'legacy', environment: [] })
  assert.equal(await manager.connect('docs', async () => true, new AbortController().signal), true)
  assert(manager.statuses()[0].snapshot)
  const invalid = '{owned-invalid-configuration', file = join(directory, 'mcp-servers.json')
  await writeFile(file, invalid, { mode: 0o600 })
  blocked = true
  const load = store.load.bind(store)
  store.load = async () => { reads++; return load() }
  store.save = async () => { throw new Error('Cleanup controls must never persist configuration') }
  return { manager, file, invalid, methods, starts: () => starts, closes: () => closes, reads: () => reads,
    allowCleanup: () => { blocked = false } }
}

for (const surface of ['picker', 'line']) test(`${surface} unavailable saved config exposes only retained-peer cleanup and an explicit retry`, async t => {
  const subject = await retainedPeer(t), io = ioFixture()
  let selections = 0
  const check = () => {
    assert.equal(subject.manager.statuses()[0].state, 'error')
    assert.equal(subject.manager.statuses()[0].snapshot, undefined)
    assert.equal(subject.closes(), selections + 1)
    if (selections++) subject.allowCleanup()
  }
  if (surface === 'picker') io.choose = async (title, choices, initial) => {
    io.choices.push({ title, choices, initial })
    assert.deepEqual(choices.map(choice => choice.value), ['back', 'cleanup:docs'])
    assert.equal(initial, 0); assert.match(title, /saved configuration unavailable/)
    check(); return 'cleanup:docs'
  }
  else {
    delete io.choose
    io.readLine = async () => { check(); return '2' }
  }
  await assert.rejects(manageMcp(subject.manager, io), /saved configuration remains unavailable or invalid/)
  assert.equal(selections, 2); assert.equal(subject.closes(), 3); assert.equal(subject.reads(), 1)
  assert.equal(subject.starts(), 1); assert.equal(io.approvals.length, 0)
  assert.equal(subject.manager.statuses()[0].state, 'disabled')
  assert.equal(subject.manager.statuses()[0].snapshot, undefined)
  assert.match(io.output, /owned connection retained for explicit Disable retry/)
  assert.match(io.output, /disabled for this launch; owned connection cleanup completed/)
  assert(!io.output.includes('never-show-revoked-metadata')); assert(!io.output.includes('Untrusted transport detail'))
  assert(!io.output.includes('Add trusted installed server'))
  assert.deepEqual(subject.methods, ['initialize', 'notifications/initialized', 'tools/list'])
  assert.equal(await readFile(subject.file, 'utf8'), subject.invalid)
})

test('Back from unavailable-config cleanup preserves the retained owned handle for later shutdown or explicit retry', async t => {
  const subject = await retainedPeer(t), io = ioFixture([0])
  await assert.rejects(manageMcp(subject.manager, io), /owned process cleanup remains unverified/)
  assert.equal(subject.closes(), 1); assert.equal(subject.starts(), 1); assert.equal(subject.reads(), 1)
  assert.equal(subject.manager.statuses()[0].state, 'error'); assert.equal(subject.manager.statuses()[0].snapshot, undefined)
  assert.deepEqual(io.choices[0].choices.map(choice => choice.value), ['back', 'cleanup:docs'])
  assert(!io.output.includes('disabled for this launch'))
})
