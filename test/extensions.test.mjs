// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CliHost } from '../dist/host.js'
import { createBuiltinToolset } from '../dist/tools.js'
import { newSession } from '../dist/session.js'
import { createToolRegistry } from '@ayayaq/vivi/extensions'
import { calculatorExtension } from '@ayayaq/vivi/extensions/calculator'

const call = (name, arguments_ = {}, id = 'call-1') => ({ id, name, arguments: arguments_ })
const pack = () => ({ id: 'fixture', apiVersion: 1, tools: [{
  definition: { name: 'fixture', description: 'Original', parameters: { type: 'object' } },
  validateArguments() {}, execute() { return { content: 'original' } }
}] })
const store = () => ({ saved: undefined,
  async save(session) { this.saved = structuredClone(session) },
  async load() { return structuredClone(this.saved) }
})
const settings = { provider: 'openai', model: 'fake' }

test('CLI uses the exact shared calculator definitions and results', async () => {
  const shared = createToolRegistry([calculatorExtension])
  const toolset = createBuiltinToolset()
  assert.deepEqual(toolset.tools[0], shared.tools[0])
  const request = call('calculate', { expression: '2*(3+4)-.5' })
  const signal = new AbortController().signal
  const host = { enableNotes: false, readNotes() { throw new Error('No notes') },
    async commitNote() { throw new Error('No mutation') }, async approve() { throw new Error('No approval') } }
  assert.deepEqual(await toolset.executeTool(request, signal, host), await shared.executeTool(request, { signal }))
})

test('CLI captures registry before asynchronous save and keeps canonical/persisted history', async () => {
  const extension = pack()
  const persistence = store()
  let mutate = false
  const originalSave = persistence.save
  persistence.save = async function (session) {
    await originalSave.call(this, session)
    if (mutate) {
      extension.tools[0].definition.description = 'Changed'
      extension.tools[0].validateArguments = () => { throw new Error('Changed') }
      extension.tools[0].execute = () => ({ content: 'changed' })
    }
  }
  let rounds = 0
  const host = await CliHost.create({ settings, store: persistence, extensions: [extension], provider: {
    async generate({ messages, tools }) {
      assert.equal(tools.find((tool) => tool.name === 'fixture').description, 'Original')
      if (++rounds === 1) return { content: '', toolCalls: [call('fixture')] }
      assert.equal(messages.at(-1).content, 'original')
      return { content: 'Done', toolCalls: [] }
    }
  } })
  mutate = true
  const result = await host.send('Use extension')
  assert.equal(result.status, 'completed')
  assert.equal(result.history[2].content, 'original')
  assert.deepEqual(persistence.saved.history, result.history)
})

test('CLI reserves disabled built-ins and rejects collisions before changing history', async () => {
  for (const name of ['calculate', 'current_time', 'note_read', 'note_set']) {
    const extension = pack()
    extension.tools[0].definition.name = name
    const host = new CliHost({ session: newSession(settings), store: store(), extensions: [extension],
      provider: { async generate() { throw new Error('No provider expected') } } })
    await assert.rejects(host.send('Use extension'), /Tool name collision/)
    assert.deepEqual(host.session.history, [])
    assert.equal(host.running, false)
  }
})

test('CLI cancels uncooperative extension, persists closed results, and ignores late success', async () => {
  const extension = pack()
  let ready
  const started = new Promise((resolve) => { ready = resolve })
  let finish
  const pending = new Promise((resolve) => { finish = resolve })
  extension.tools[0].execute = () => { ready(); return pending }
  const persistence = store()
  let rounds = 0
  const host = await CliHost.create({ settings, store: persistence, extensions: [extension], provider: {
    async generate() { rounds++; return { content: '', toolCalls: [call('fixture')] } }
  } })
  const run = host.send('Use extension')
  await started
  host.cancel()
  const result = await run
  assert.equal(result.status, 'cancelled')
  assert.equal(JSON.parse(result.history.at(-1).content).error.code, 'cancelled')
  finish({ content: 'late' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(persistence.saved.history, result.history)
  assert.equal(rounds, 1)
  assert.equal(JSON.stringify(persistence.saved).includes('late'), false)
})

test('the model tool-support gate also disables custom extension dispatch', async () => {
  const extension = pack()
  let executions = 0
  extension.tools[0].execute = () => { executions++; return { content: 'must not execute' } }
  let rounds = 0
  const persistence = store()
  const host = await CliHost.create({ settings, store: persistence, extensions: [extension],
    enableTools: false, provider: { async generate({ tools, messages }) {
      assert.deepEqual(tools, [])
      if (++rounds === 1) return { content: '', toolCalls: [call('fixture')] }
      assert.equal(JSON.parse(messages.at(-1).content).error.code, 'unavailable_tool')
      return { content: 'No extension dispatched', toolCalls: [] }
    } } })
  const result = await host.send('Tools disabled')
  assert.equal(result.status, 'completed')
  assert.equal(executions, 0)
  assert.deepEqual(persistence.saved.history, result.history)
})
