// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliHost } from '../dist/host.js'
import { ReadOnlyWorkspace } from '../dist/workspace.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { runInstructionsCommand } from '../dist/terminal.js'
const call = (name, arguments_, id) => ({ name, arguments: arguments_, id })
const create = (id = 'create') => call('workspace_create_text', { path: 'src/new.txt', content: 'Ordinary project text\n' }, id)
const results = result => result.history.filter(message => message.kind === 'tool_result').map(message => ({ ...message, body: JSON.parse(message.content) }))
async function fixture(t, respond, approve) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'vivi-instructions-host-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'project'); await fs.mkdir(join(root, 'src'), { recursive: true })
  const requests = [], approvals = [], estimates = []
  const workspace = await ReadOnlyWorkspace.open(root)
  let round = 0
  const host = new CliHost({ workspace, store: new FileSessionStore(join(directory, 'state')),
    session: newSession({ provider: 'openai', model: 'offline-instructions' }),
    provider: { estimateContext(input) { estimates.push(structuredClone(input)); return { inputTokens: Math.ceil(JSON.stringify(input).length / 4), estimated: true } },
      async generate(input, signal, options) {
        requests.push(structuredClone(input))
        if (options?.purpose === 'context-summary') return { content: 'A derived historical summary', toolCalls: [] }
        return await respond({ root, round: ++round, input, signal }) ?? { content: 'Done', toolCalls: [] }
      } },
    approve: async request => { approvals.push(request); return approve ? approve({ root, request }) : true }
  })
  return { root, directory, requests, approvals, estimates, host }
}
test('initial root guidance is fresh every provider dispatch, noncanonical and not elevated to system text', async t => {
  const f = await fixture(t, async ({ root, round, input }) => {
    const context = input.messages.filter(message => message.content?.includes('Root style'))
    assert.equal(context.length, 1); assert.equal(context[0].role, 'user')
    assert(!input.messages.some(message => message.role === 'system' && message.content.includes('Root style')))
    if (round === 1) {
      await fs.writeFile(join(root, 'AGENTS.md'), 'Root style version two')
      return { content: '', toolCalls: [call('calculate', { expression: '1+1' }, 'calculate')] }
    }
    assert(context[0].content.includes('version two'))
  })
  await fs.writeFile(join(f.root, 'AGENTS.md'), 'Root style version one')
  const result = await f.host.send('Inspect the project')
  assert.equal(result.status, 'completed'); assert.equal(f.requests.length, 2)
  assert(!JSON.stringify(f.host.session.history).includes('Root style'))
  assert(f.estimates.some(input => JSON.stringify(input.messages).includes('Root style version two')))
})
test('new nested mutation scope declines before review, refreshes context, then permits a replanned call', async t => {
  const f = await fixture(t, ({ round, input }) => {
    if (round === 1) { assert(!JSON.stringify(input).includes('Source conventions')); return { content: '', toolCalls: [create('unplanned')] } }
    if (round === 2) { assert(JSON.stringify(input).includes('Source conventions')); return { content: '', toolCalls: [create('replanned')] } }
  })
  await fs.writeFile(join(f.root, 'AGENTS.md'), 'Root conventions')
  await fs.writeFile(join(f.root, 'src', 'AGENTS.md'), 'Source conventions')
  const result = await f.host.send('Create src/new.txt')
  const [first, second] = results(result)
  assert.equal(first.isError, true); assert.equal(first.body.error.code, 'instructions_required')
  assert.equal(first.body.serverEffects, 'not_attempted'); assert.equal(second.body.success, true)
  assert.equal(f.approvals.length, 1)
  assert.equal(await fs.readFile(join(f.root, 'src', 'new.txt'), 'utf8'), 'Ordinary project text\n')
})
test('same-batch read activation cannot authorize a sibling write from the old dispatch', async t => {
  const f = await fixture(t, ({ round, input }) => {
    if (round === 1) return { content: '', toolCalls: [call('workspace_read', { path: 'src/readme.txt' }, 'read'), create('same-batch-write')] }
    assert(JSON.stringify(input).includes('Source conventions'))
  })
  await fs.writeFile(join(f.root, 'src', 'AGENTS.md'), 'Source conventions')
  await fs.writeFile(join(f.root, 'src', 'readme.txt'), 'Read-only source text')
  const result = await f.host.send('Read src/readme.txt and create src/new.txt')
  const write = results(result).find(message => message.name === 'workspace_create_text')
  assert.equal(write.body.error.code, 'instructions_required'); assert.equal(f.approvals.length, 0)
  await assert.rejects(fs.readFile(join(f.root, 'src', 'new.txt')), { code: 'ENOENT' })
})
test('guidance changed after originating dispatch is refused before review', async t => {
  const f = await fixture(t, async ({ root, round }) => {
    if (round !== 1) return
    await fs.writeFile(join(root, 'AGENTS.md'), 'Revised conventions')
    return { content: '', toolCalls: [create()] }
  })
  await fs.writeFile(join(f.root, 'AGENTS.md'), 'Original conventions')
  const result = await f.host.send('Create src/new.txt')
  assert.equal(results(result)[0].body.error.code, 'instructions_required')
  assert.equal(f.approvals.length, 0)
  await assert.rejects(fs.readFile(join(f.root, 'src', 'new.txt')), { code: 'ENOENT' })
})
test('guidance changed during human approval is rechecked and the mutation is not attempted', async t => {
  const f = await fixture(t, ({ round }) => round === 1 ? { content: '', toolCalls: [create()] } : undefined,
    async ({ root }) => { await fs.writeFile(join(root, 'AGENTS.md'), 'Revised conventions'); return true })
  await fs.writeFile(join(f.root, 'AGENTS.md'), 'Original conventions')
  const result = await f.host.send('Create src/new.txt')
  assert.equal(results(result)[0].body.error.code, 'instructions_required')
  assert.equal(f.approvals.length, 1)
  await assert.rejects(fs.readFile(join(f.root, 'src', 'new.txt')), { code: 'ENOENT' })
})
test('refresh and manual compaction use current guidance without persisting it in canonical history', async t => {
  const f = await fixture(t, () => ({ content: 'Ordinary prior answer '.repeat(120), toolCalls: [] }))
  await fs.writeFile(join(f.root, 'AGENTS.md'), 'Current root conventions one')
  for (let i = 0; i < 5; i++) await f.host.send(`Historical request ${i}: ${'ordinary context '.repeat(100)}`)
  const canonical = f.host.session.history
  await f.host.compact()
  await fs.writeFile(join(f.root, 'AGENTS.md'), 'Current root conventions two')
  await f.host.refreshContext()
  assert(JSON.stringify(f.estimates.at(-1)).includes('Current root conventions two'))
  await f.host.send('Continue the project')
  assert(JSON.stringify(f.requests.at(-1)).includes('Current root conventions two'))
  assert(!JSON.stringify(f.requests.at(-1)).includes('Current root conventions one'))
  assert.deepEqual(f.host.session.history.slice(0, canonical.length), canonical)
  assert(!JSON.stringify(f.host.session.history).includes('Current root conventions'))
})
test('instructions status, reload and launch disable controls never send model requests', async t => {
  const f = await fixture(t, () => undefined), output = [], io = { write: value => output.push(value) }
  await fs.writeFile(join(f.root, 'AGENTS.md'), 'Ordinary conventions')
  assert.equal(await runInstructionsCommand(f.host, io, '/instructions status'), true)
  assert.match(output.at(-1), /1 loaded source/)
  await runInstructionsCommand(f.host, io, '/instructions reload')
  assert.equal(f.requests.length, 0)
  await runInstructionsCommand(f.host, io, '/instructions disable')
  assert.equal(f.host.instructionsEnabled, false)
  await f.host.send('Chat without derived instructions')
  assert(!JSON.stringify(f.requests.at(-1)).includes('Ordinary conventions'))
  assert.equal(await runInstructionsCommand(f.host, io, '/unrelated'), false)
})
