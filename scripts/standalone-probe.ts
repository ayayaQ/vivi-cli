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
  assert(!setup.captureCharFrame().includes('# Embedded renderer'), 'Embedded Markdown grammar did not conceal markup')
  await setup.mockInput.typeText('Embedded input works')
  await setup.mockInput.pressEnter()
  assert.equal(await reading, 'Embedded input works')
  io.close()
  assert.equal(await io.readLine('Closed'), undefined)
  console.log('Compiled native OpenTUI assets, Markdown and input passed')
} finally { io.close(); setup.renderer.destroy() }
