// SPDX-License-Identifier: Apache-2.0
import { CliRenderEvents } from '@opentui/core'
import type { CliRenderer } from '@opentui/core'
import { OpenTuiIO } from '../../src/tui.js'
import { newSession } from '../../src/session.js'

// Scripted offline PTY coverage, with no provider, account or physical UI input.
const io = await OpenTuiIO.create({ secrets: ['fake-title-pty-secret'] })
io.setSession({ ...newSession({ provider: 'openai', model: 'offline' }),
  title: 'Restore fake-title-pty-secret', titleRevision: 1 })
io.runStarted()
const pending = io.askText('Private setup context')
const renderer = (io as unknown as { renderer: CliRenderer }).renderer
await new Promise(resolve => setTimeout(resolve, 20))
switch (process.argv[2]) {
  case 'external': renderer.destroy(); break
  case 'error': renderer.emit(CliRenderEvents.RENDER_ERROR, { error: new Error('Offline renderer failure') }); break
  case 'deferred':
    renderer.once(CliRenderEvents.FRAME, () => io.close())
    renderer.requestRender()
    break
  case 'exit-during-render':
    renderer.once(CliRenderEvents.FRAME, () => process.exit(0))
    renderer.requestRender()
    break
  case 'close-exit-during-render':
    renderer.once(CliRenderEvents.FRAME, () => { io.close(); process.exit(0) })
    renderer.requestRender()
    break
  default: io.close()
}
await pending
await new Promise(resolve => setTimeout(resolve, 20))
io.close()
process.stdout.write('\nEND-OFFLINE-TITLE-PROBE\n')
