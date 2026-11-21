// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliHost } from '../dist/host.js'
import { parseArguments } from '../dist/main.js'
import { createBuiltinToolset } from '../dist/tools.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { ReadOnlyWorkspace } from '../dist/workspace.js'

async function fixture(t, code, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'vivi-code-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const root = join(dir, 'project')
  await mkdir(join(root, 'lib'), { recursive: true })
  await writeFile(join(root, 'lib', 'sample.txt'), 'first\nneedLe\nlast')
  await writeFile(join(root, 'lib', 'AGENTS.md'), 'Nested scope guidance')
  const workspace = await ReadOnlyWorkspace.open(root)
  const store = new FileSessionStore(join(dir, 'state'))
  const inputs = []
  const host = new CliHost({ workspace, codeMode: true, ...options, store,
    session: newSession({ provider: 'openai', model: 'fixture' }), provider: { async generate(input) {
      inputs.push(input)
      return { content: '', toolCalls: inputs.length === 1 ? [{ id: 'parent', name: 'code_mode', arguments: { code } }] : [] }
    } } })
  t.after(() => host.shutdown())
  return { host, store, inputs, workspace, root }
}
const body = result => JSON.parse(result.history.find(message => message.kind === 'tool_result').content)

for (const mode of ['execute', 'plan']) test('composes guarded reads in ' + mode, async t => {
  const f = await fixture(t, `const hits = await tools.workspace_search({query:"needLe"});
    const files = await Promise.all(hits.matches.map(hit => tools.workspace_read({path:hit.path,startLine:hit.line,maxLines:1})));
    return files.map(file => file.content)`)
  f.host.setTaskMode(mode)
  const result = await f.host.send('Find the matching line')
  assert.equal(result.status, 'completed')
  assert.deepEqual(body(result).value, ['needLe'])
  assert.deepEqual(body(result).reads.map(row => [row.name, row.status]), [['workspace_search','succeeded'], ['workspace_read','succeeded']])
  assert.equal(new Set(body(result).reads.map(row => row.id)).size, 2)
  assert.equal(result.history.filter(message => message.kind === 'tool_result').length, 1)
  assert(JSON.stringify(f.inputs[1]).includes('Nested scope guidance'))
  assert.deepEqual((await f.store.load(f.host.session.id)).history, result.history)
})

test('launch flag, tool ownership and unavailable scope', async t => {
  assert.equal(parseArguments(['--code-mode', '--model', 'fixture'], {}).codeMode, true)
  assert.throws(() => createBuiltinToolset(false, [{ id: 'fake', apiVersion: 1, tools: [{
    definition: { name: 'code_mode', description: 'fake', parameters: { type: 'object' } },
    validateArguments() {}, execute() { assert.fail() }
  }] }]), /collision/i)
  for (const options of [{ codeMode: false }, { enableTools: false }]) {
    const f = await fixture(t, 'return 7', options)
    const result = await f.host.send('inspect')
    assert(!f.inputs[0].tools.some(tool => tool.name === 'code_mode'))
    assert(result.history.find(message => message.kind === 'tool_result').isError)
  }
})

test('uses the active catalog without a workspace and preserves nested arguments and plain text', async t => {
  const seen = []
  const tool = { definition: { name: 'format_record', description: 'Format a record', parameters: { type: 'object' } },
    validateArguments() {}, async execute(call) { seen.push(call.arguments); return { content: 'formatted record' } } }
  const f = await fixture(t, `const catalog = Object.keys(tools).sort()
    const text = await tools.format_record({items:[{value:null}, {value:42}]})
    return {catalog,text,status:(await tools.session_status({})).taskMode}`,
    { workspace: undefined, extensions: [{ id:'fixture', apiVersion:1, tools:[tool] }] })
  const data = body(await f.host.send('Format the record'))
  assert.deepEqual(data.value.catalog, f.inputs[0].tools.map(tool => tool.name).filter(name => name !== 'code_mode').sort())
  assert.deepEqual(seen, [{items:[{value:null},{value:42}]}])
  assert.equal(data.value.text, 'formatted record')
  assert.equal(data.value.status, 'execute')
  assert.equal(data.calls[0].effect, 'unknown')
})

test('Plan exposes exactly the same tools to the guest as to direct calls', async t => {
  const f = await fixture(t, 'return Object.keys(tools).sort()', { enableNotes: true })
  f.host.setTaskMode('plan')
  assert.deepEqual(body(await f.host.send('Inspect')).value,
    f.inputs[0].tools.map(tool => tool.name).filter(name => name !== 'code_mode').sort())
})

test('commits staged writes before another tool and resumes without replay', async t => {
  const events = []
  const code = `await tools.workspace_create_text({path:"first.txt",content:"one"})
    const content = await tools.inspect_first({})
    await tools.workspace_create_text({path:"second.txt",content})
    return content`
  const f = await fixture(t, code, { approve: request => { events.push(request.call.id); return true },
    extensions: [{ id:'fixture', apiVersion:1, tools:[{ definition:{name:'inspect_first', description:'Read first',parameters:{type:'object'}},
      validateArguments() {}, async execute() { events.push('read'); return {content:await readFile(join(f.root,'first.txt'),'utf8')} } }] }] })
  const result = body(await f.host.send('Create both files'))
  assert.equal(result.value, 'one')
  assert.equal(await readFile(join(f.root, 'second.txt'), 'utf8'), 'one')
  assert.equal(events.length, 3)
  assert.equal(events[1], 'read')
  assert.notEqual(events[0], events[2])
})

test('cancelling a noncooperative extension releases the script and records uncertain effects', {timeout:5000}, async t => {
  const started = Promise.withResolvers(), late = Promise.withResolvers()
  const f = await fixture(t, 'return await tools.slow_tool({})', {extensions:[{id:'fixture',apiVersion:1,tools:[{
    definition:{name:'slow_tool',description:'Wait',parameters:{type:'object'}},validateArguments(){},
    execute(){started.resolve(); return late.promise}
  }]}]})
  const turn = f.host.send('Wait')
  await started.promise
  f.host.cancel()
  try {
    const result = await turn
    assert.equal(result.status,'cancelled')
    assert.equal(body(result).calls[0].effect,'unknown')
  } finally { late.resolve({content:'late'}) }
})

test('a tool wait longer than the guest time budget resumes the same script', { timeout: 20000 }, async t => {
  let calls = 0
  const f = await fixture(t, 'return 1 + await tools.wait_for_input({})', {extensions:[{id:'fixture',apiVersion:1,tools:[{
    definition:{name:'wait_for_input',description:'Wait for input',parameters:{type:'object'}},validateArguments(){},
    async execute(){calls++; await new Promise(resolve => setTimeout(resolve, 10200)); return {content:'41'}}
  }]}]})
  assert.equal(body(await f.host.send('Wait for input')).value, 42)
  assert.equal(calls, 1)
})

test('Plan retains completed reads and cannot invoke a computed workspace write', async t => {
  const f = await fixture(t, 'await tools.workspace_read({path:"lib/sample.txt"}); return await tools["workspace_"+"create_text"]({path:"new.txt",content:"x"})')
  f.host.setTaskMode('plan')
  const data = body(await f.host.send('inspect'))
  assert.equal(data.success, false)
  assert.deepEqual(data.reads.map(row => row.status), ['succeeded'])
})

const threeChanges = `const old = await tools.workspace_read({path:"old.txt"});
await tools.workspace_edit_text({path:"old.txt",expectedRevision:old.revision,before:"old",after:"new"});
for (const path of ["a.txt","b.txt"]) await tools.workspace_create_text({path,content:"new"});
return (await tools.workspace_read({path:"old.txt"})).content`

for (const mode of ['allow', 'deny', 'stale', 'cancel']) test('grouped workspace changes: ' + mode, async t => {
  const approvals = []
  const f = await fixture(t, threeChanges, { approve: async request => {
    approvals.push(request)
    assert.equal(await readFile(join(f.root, 'old.txt'), 'utf8'), 'old')
    assert.equal(request.call.arguments.code, threeChanges)
    assert(request.description.includes('Update all three files'))
    for (const path of ['old.txt','a.txt','b.txt']) assert(request.description.includes('+++ "' + path + '"'))
    if (mode === 'stale') await writeFile(join(f.root, 'a.txt'), 'outside change')
    if (mode === 'cancel') f.host.cancel()
    return mode !== 'deny'
  } })
  await writeFile(join(f.root, 'old.txt'), 'old')
  const result = await f.host.send('Update all three files')
  const data = body(result)
  assert.equal(approvals.length, 1)
  assert.equal(data.success, mode === 'allow')
  const statuses = mode === 'allow' ? ['succeeded','succeeded','succeeded'] : mode === 'stale' ? ['succeeded','failed','not_attempted']
    : Array(3).fill(mode === 'deny' ? 'denied' : 'not_attempted')
  assert.deepEqual(data.writes.map(row => row.status), statuses)
  assert.equal(new Set(data.writes.map(row => row.id)).size, 3)
  assert.deepEqual((await f.store.load(f.host.session.id)).history, result.history)
  assert.equal(await readFile(join(f.root, 'old.txt'), 'utf8'), statuses[0] === 'succeeded' ? 'new' : 'old')
  if (mode === 'allow') {
    assert.equal(data.value, 'old')
    assert.equal(await readFile(join(f.root, 'b.txt'), 'utf8'), 'new')
  } else await assert.rejects(readFile(join(f.root, 'b.txt')), { code: 'ENOENT' })
  if (mode === 'stale') assert.equal(await readFile(join(f.root, 'a.txt'), 'utf8'), 'outside change')
})

test('script failure discards staged writes before review', async t => {
  let approvals = 0
  const f = await fixture(t, 'await tools.workspace_create_text({path:"a.txt",content:"new"}); throw 1',
    { approve: async () => { approvals++; return true } })
  const data = body(await f.host.send('Create a.txt'))
  assert.equal(data.success, false)
  assert.equal(data.writes[0].status, 'not_attempted')
  assert.equal(approvals, 0)
  await assert.rejects(readFile(join(f.root, 'a.txt')), { code: 'ENOENT' })
})

test('cancellation releases a pending review and late approval cannot publish', { timeout: 8000 }, async t => {
  const pending = Promise.withResolvers(), reviewing = Promise.withResolvers()
  const f = await fixture(t, 'return await tools.workspace_create_text({path:"late.txt",content:"late"})',
    { approve: () => { reviewing.resolve(); return pending.promise } })
  const turn = f.host.send('Create late.txt')
  await reviewing.promise
  f.host.cancel()
  assert.equal((await turn).status, 'cancelled')
  pending.resolve(true)
  await assert.rejects(readFile(join(f.root, 'late.txt')), { code: 'ENOENT' })
})

test('Skip applies prepared changes with a receipt per path', async t => {
  let prompts = 0
  const f = await fixture(t, threeChanges, { permissionApproval: { isAvailable: () => true, accountRevision: () => 'fixture' },
    approve: () => { prompts++; return false } })
  await writeFile(join(f.root, 'old.txt'), 'old')
  f.host.setApprovalMode('skip')
  const data = body(await f.host.send('Update the three files'))
  assert.equal(prompts, 0)
  assert.deepEqual(data.writes.map(row => [row.status, row.reviewSource]), Array(3).fill(['succeeded', 'skip']))
})

test('cancellation after publication keeps the completed receipt and stops later writes', async t => {
  const f = await fixture(t, threeChanges, { approve: async () => true })
  await writeFile(join(f.root, 'old.txt'), 'old')
  const commit = f.workspace.commitMutation.bind(f.workspace)
  f.workspace.commitMutation = async (...args) => {
    const result = await commit(...args)
    f.host.cancel()
    return result
  }
  const result = await f.host.send('Update all three files')
  assert.equal(result.status, 'cancelled')
  assert.deepEqual(body(result).writes.map(row => row.status), ['succeeded','not_attempted','not_attempted'])
  assert.deepEqual((await f.store.load(f.host.session.id)).history, result.history)
  assert.equal(await readFile(join(f.root, 'old.txt'), 'utf8'), 'new')
  await assert.rejects(readFile(join(f.root, 'a.txt')), { code: 'ENOENT' })
})

test('an invalid later proposal stops preparation before prompting or saving', async t => {
  let prompts = 0
  const f = await fixture(t, `await tools.workspace_create_text({path:"first.txt",content:"first"});
    await tools.workspace_create_text({path:"lib/sample.txt",content:"replacement"})`,
    { approve: () => { prompts++; return true } })
  const data = body(await f.host.send('Create both files'))
  assert.equal(data.success, false)
  assert.deepEqual(data.writes.map(row => row.status), ['not_attempted', 'not_attempted'])
  assert.equal(prompts, 0)
  await assert.rejects(readFile(join(f.root, 'first.txt')), { code: 'ENOENT' })
})

test('Auto reviews the script and all prepared workspace diffs in one decision', async t => {
  const requests = [], ledger = []
  const f = await fixture(t, threeChanges, { decisionReview: {
    canAutoReview: true, accountRevision: () => 'fixture', isAvailable: () => true,
    ledger: { upsert: async record => { ledger.push(record) } },
    provider: { id: 'openai', model: 'gpt-6-luna', async evaluate(request) {
      requests.push(request)
      return { model: 'gpt-6-luna', usage: { inputTokens: 1, outputTokens: 1 },
        answers: request.policy.checks.map(check => ({ name: check.name, type: 'predicate', probability: 1 })) }
    } }
  } })
  await writeFile(join(f.root, 'old.txt'), 'old')
  f.host.setApprovalMode('auto')
  const data = body(await f.host.send('Change old.txt from old to new and create a.txt and b.txt containing new'))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].snapshot.toolCall.arguments.code, threeChanges)
  assert.equal(requests[0].snapshot.preparedAction.effects.length, 3)
  assert.deepEqual(data.writes.map(row => row.reviewSource), Array(3).fill('automatic'), JSON.stringify({ data, audit: ledger.at(-1) }))
  assert.equal(ledger.at(-1).state, 'committed')
})

test('withholds a derived credential before persistence', async t => {
  const f = await fixture(t, 'return ["owned", "sensitive"].join("-")', { secrets: ['owned-sensitive'] })
  const result = await f.host.send('inspect')
  assert.equal(body(result).success, false)
  assert(!JSON.stringify((await f.store.load(f.host.session.id)).history).includes('owned-sensitive'))
})

test('cancelling a busy program drains the guest and preserves completed child receipts', { timeout: 8000 }, async t => {
  const f = await fixture(t, 'await tools.workspace_read({path:"lib/sample.txt"}); while(true) {}')
  const execute = f.workspace.execute.bind(f.workspace)
  f.workspace.execute = async (...args) => {
    const read = await execute(...args)
    setTimeout(() => f.host.cancel(), 50)
    return read
  }
  const result = await f.host.send('inspect')
  assert.equal(result.status, 'cancelled')
  assert.equal(body(result).reads[0].status, 'succeeded')
  assert.equal(body(result).success, false)
  assert.deepEqual((await f.store.load(f.host.session.id)).history, result.history)
})

test('preserves ordering and truncation for four concurrent reads', async t => {
  const f = await fixture(t, `return await Promise.all([1,2,3,4].map(async startLine =>
    (await tools.workspace_read({path:"lib/sample.txt",startLine,maxLines:1})).content))`)
  const data = body(await f.host.send('inspect'))
  assert.deepEqual(data.value, ['first', 'needLe', 'last', ''])
  assert.deepEqual(data.reads.map(row => row.status), Array(4).fill('succeeded'))
  assert.equal(data.reads[0].truncated, true)
  assert.equal(data.reads[0].path, 'lib/sample.txt')
})

for (const [label, code, count] of [
  ['output budget', 'return "x".repeat(9000)', 0],
  ['guest heap budget', 'return new Uint8Array(16 * 1024 * 1024).length', 0],
  ['read budget', 'for(let i=0;i<9;i++) await tools.workspace_read({path:"lib/sample.txt"})', 8],
  ['missing file', 'return await tools.workspace_read({path:"missing.txt"})', 1]
]) test('reports ' + label + ' and retains admitted reads', async t => {
  const f = await fixture(t, code)
  const data = body(await f.host.send('inspect'))
  assert.equal(data.success, false)
  assert.equal(data.reads.length, count)
  if (label === 'missing file') assert.equal(data.reads[0].status, 'failed')
})

test('checks credentials registered during a child read before returning file data', async t => {
  const secrets = []
  const f = await fixture(t, 'return await tools.workspace_read({path:"lib/sample.txt"})', { secrets })
  const execute = f.workspace.execute.bind(f.workspace)
  f.workspace.execute = async (...args) => {
    const result = await execute(...args)
    secrets.push('needLe')
    return result
  }
  const result = await f.host.send('inspect')
  assert.equal(body(result).reads[0].status, 'failed')
  assert(!JSON.stringify(result.history).includes('needLe'))
})
