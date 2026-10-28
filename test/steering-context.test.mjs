// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { CliHost } from '../dist/host.js'
import { FileImageAssets } from '../dist/image-assets.js'
import { ReadOnlyWorkspace } from '../dist/workspace.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { replayCliConversationDocument } from '../dist/conversation-records.js'

test('steering preserves image tool batches, fresh project guidance and version-2 canonical replay', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'vivi-steering-context-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'project'); await fs.mkdir(root)
  const pixels = await fs.readFile(new URL('./fixtures/tool-image-1x1.jpg', import.meta.url))
  await fs.writeFile(join(root, 'image.jpg'), pixels)
  await fs.writeFile(join(root, 'AGENTS.md'), 'Project guidance version one')
  const session = newSession({ provider: 'openai', model: 'gpt-4.1' })
  const store = new FileSessionStore(join(directory, 'state'))
  const images = new FileImageAssets(join(directory, 'state', 'images'), session.id)
  const workspace = await ReadOnlyWorkspace.open(root, [], [store.directory])
  const requests = [], accepted = []
  let host
  const provider = createOpenAIProvider({ model: 'gpt-4.1', apiKey: 'offline-key', stream: false,
    resolveImage: reference => images.resolve(reference), fetch: async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body)
      if (requests.length === 1) {
        assert(JSON.stringify(body).includes('Project guidance version one'))
        host.queueMessage('Same follow-up'); host.queueMessage('Same follow-up')
        await fs.writeFile(join(root, 'AGENTS.md'), 'Project guidance version two')
        return Response.json({ status: 'completed', output: [
          { type: 'function_call', id: 'item-image', call_id: 'image', name: 'workspace_read_image',
            arguments: '{"path":"image.jpg"}', status: 'completed' },
          { type: 'function_call', id: 'item-calculate', call_id: 'calculate', name: 'calculate',
            arguments: '{"expression":"1+1"}', status: 'completed' }
        ] })
      }
      assert(JSON.stringify(body).includes('Project guidance version two'))
      assert(!JSON.stringify(body).includes('Project guidance version one'))
      const image = body.input.find(item => item.type === 'function_call_output' && item.call_id === 'image')
      assert.equal(image.output[1].image_url, `data:image/jpeg;base64,${pixels.toString('base64')}`)
      const calculation = body.input.findIndex(item => item.type === 'function_call_output' && item.call_id === 'calculate')
      const users = body.input.map((item, index) => ({ item, index })).filter(({ item }) =>
        item.role === 'user' && JSON.stringify(item.content).includes('Same follow-up'))
      assert.equal(users.length, 2)
      assert(users.every(({ index }) => index > calculation), 'Steering follows the complete tool batch')
      return Response.json({ status: 'completed', output: [{ type: 'message', id: 'answer', role: 'assistant',
        status: 'completed', content: [{ type: 'output_text', text: 'Observed and steered.', annotations: [] }] }] })
    } })
  host = new CliHost({ workspace, store, session, images, imageCapability: 'supported', provider })
  t.after(() => host.shutdown())
  const result = await host.send('Inspect image.jpg', undefined, text => accepted.push(text))
  assert.equal(result.status, 'completed', JSON.stringify(result.error))
  assert.equal(requests.length, 2)
  assert.deepEqual(accepted, ['Same follow-up', 'Same follow-up'])
  assert.deepEqual(host.queuedMessages, [])
  assert.equal(host.session.schemaVersion, 3)
  assert(!JSON.stringify(host.session.history).includes('Project guidance'))
  assert(!JSON.stringify(host.session.history).includes(pixels.toString('base64')))
  assert.deepEqual(host.session.history.map(message => message.kind),
    ['message', 'assistant', 'tool_result', 'tool_result', 'message', 'message', 'assistant'])
  const saved = await store.load(session.id)
  assert.deepEqual(saved.history, result.history)
  const records = JSON.parse(await fs.readFile(join(store.directory, `${session.id}.records.json`), 'utf8'))
  const replay = replayCliConversationDocument(records)
  assert.deepEqual(replay.projection.history.map(entry => entry.message), result.history)
  assert.equal(host.conversationRecords.state, 'shadow')
})
