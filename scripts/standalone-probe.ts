// SPDX-License-Identifier: Apache-2.0
// Compiled headless probe: real native UI/assets, no terminal automation or provider request.
import assert from 'node:assert/strict'
import { createTestRenderer } from '@opentui/core/testing'
import { CodeRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { OpenTuiIO } from '../src/tui.js'
import { newSession } from '../src/session.js'

const setup = await createTestRenderer({ width: 80, height: 24 })
const io = new OpenTuiIO(setup.renderer)
try {
  const session = newSession({ provider: 'openai', model: 'embedded-headless-model' })
  session.usage = { inputTokens: 3, outputTokens: 2, totalTokens: 7, cachedInputTokens: 0 }
  session.history = [{ kind: 'assistant', content: '# Embedded renderer\n\nNative Markdown works\n\n```ts\nconst embedded = true\n```', toolCalls: [] }]
  io.setSession(session)
  const reading = io.readLine('Message')
  await setup.waitForFrame(frame => frame.includes('Native Markdown works') && frame.includes('const embedded = true'))
  const codeNodes = (node: Renderable): CodeRenderable[] => [
    ...(node instanceof CodeRenderable ? [node] : []), ...node.getChildren().flatMap(codeNodes)
  ]
  const blocks = codeNodes(setup.renderer.root)
  assert(blocks.length > 0, 'Markdown parser blocks were not created')
  await Promise.all(blocks.map(block => block.highlightingDone))
  await setup.renderOnce()
  assert(setup.captureCharFrame().includes('Session tokens: 3 in / 2 out / 7 total'))
  assert(setup.captureCharFrame().includes('Cache input: read 0 / write unreported'))
  assert(!setup.captureCharFrame().includes('# Embedded renderer'), 'Embedded Markdown grammar did not conceal markup')
  await setup.mockInput.typeText('Embedded input works')
  await setup.mockInput.pressEnter()
  assert.equal(await reading, 'Embedded input works')
  const models = Array.from({ length: 1500 }, (_, index) => ({ name: `vendor/model-${index}`,
    searchTerms: ['Embedded Provider'], value: `vendor/model-${index}` }))
  const selecting = io.chooseSearchable('Embedded models', models, { refresh: true })
  await setup.mockInput.typeText('PROVIDER model 1499')
  setup.mockInput.pressEnter()
  assert.deepEqual(await selecting, { kind: 'selected', value: 'vendor/model-1499', query: 'PROVIDER model 1499' })
  io.close()
  assert.equal(await io.readLine('Closed'), undefined)
  console.log('Compiled native OpenTUI assets, Markdown, input, model search and cache usage passed')
} finally { io.close(); setup.renderer.destroy() }
