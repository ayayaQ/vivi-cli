// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
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
  return { host, store, inputs, workspace }
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
  for (const options of [{ codeMode: false }, { enableTools: false }, { workspace: undefined }]) {
    const f = await fixture(t, 'return 7', options)
    const result = await f.host.send('inspect')
    assert(!f.inputs[0].tools.some(tool => tool.name === 'code_mode'))
    assert(result.history.find(message => message.kind === 'tool_result').isError)
  }
})

test('failed script retains completed reads and cannot invoke a workspace write', async t => {
  const f = await fixture(t, 'await tools.workspace_read({path:"lib/sample.txt"}); return await tools.workspace_create_text({path:"new.txt",content:"x"})')
  const data = body(await f.host.send('inspect'))
  assert.equal(data.success, false)
  assert.deepEqual(data.reads.map(row => row.status), ['succeeded'])
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
