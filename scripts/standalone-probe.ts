// SPDX-License-Identifier: Apache-2.0
// Compiled headless probe: real native UI/assets, no terminal automation or provider request.
import assert from 'node:assert/strict'
import { createTestRenderer } from '@opentui/core/testing'
import { CodeRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { OpenTuiIO } from '../src/tui.js'
import { WindowsInputDecoder } from '../src/windows-input.js'
import { newSession } from '../src/session.js'
import { parseModelCatalog, documentedOpenAIModel } from '../src/models.js'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileMemoryStore } from '../src/memory.js'
import { FileSessionStore } from '../src/session.js'
import { CliHost } from '../src/host.js'
import { ReadOnlyWorkspace, createWorkspaceExtension } from '../src/workspace.js'
import { createToolRegistry } from '@ayayaq/vivi/extensions'
import { TrustedCommandWorkspace } from '../src/commands.js'

// A controlled compiled child fixture, not an interpreter dependency or live shell.
if (process.argv[2] === '--command-fixture') {
  console.log(JSON.stringify({ args: process.argv.slice(3), credentialPresent: Object.keys(process.env).some(name => /API_KEY|TOKEN/.test(name)) }))
  process.exit(0)
}

// The optional pack must survive a compiled consumer, remain host-owned, and
// contribute context without storing the per-turn memory prefix in a session.
const directory = await mkdtemp(join(tmpdir(), 'vivi-compiled-memory-'))
try {
  const memory = new FileMemoryStore(directory)
  await memory.commit(await memory.prepareCreate('Prefer compiled test fixtures', 'user'))
  const host = await CliHost.create({ memory, enableMemory: true, enableTools: false,
    store: new FileSessionStore(directory), settings: { provider: 'openai', model: 'fake' },
    provider: { async generate({ messages, tools }) {
      assert.deepEqual(tools, [])
      assert.match(messages[1]!.content, /Prefer compiled test fixtures/)
      return { content: 'Compiled memory works', toolCalls: [] }
    } } })
  const result = await host.send('Use opted-in memory')
  assert.deepEqual(result.history.map(message => message.content), ['Use opted-in memory', 'Compiled memory works'])
  assert.deepEqual((await new FileSessionStore(directory).load(host.session.id)).history, result.history)
  await host.drainMemory()
  const project = join(directory, 'project')
  await mkdir(project)
  await writeFile(join(project, 'readme.txt'), 'Compiled workspace works')
  await writeFile(join(project, '.gitignore'), '*.log')
  await writeFile(join(project, 'ignored.log'), 'Compiled ignored fixture')
  const workspace = await ReadOnlyWorkspace.open(project)
  const registry = createToolRegistry([createWorkspaceExtension(workspace)])
  const listing = await registry.executeTool({ id: 'compiled-list', name: 'workspace_list', arguments: {} }, { signal: new AbortController().signal })
  assert(!JSON.parse(listing.content).entries.some((item: { path: string }) => item.path === 'ignored.log'))
  const glob = await registry.executeTool({ id: 'compiled-glob', name: 'workspace_glob', arguments: { pattern: '**/*.txt' } }, { signal: new AbortController().signal })
  assert.deepEqual(JSON.parse(glob.content).matches, [{ path: 'readme.txt', kind: 'file' }])
  assert.equal(JSON.parse(glob.content).truncated, false)
  let rounds = 0
  const workspaceHost = await CliHost.create({ workspace, store: new FileSessionStore(directory),
    settings: { provider: 'openai', model: 'fake' }, provider: { async generate() {
      return ++rounds === 1 ? { content: '', toolCalls: [{ id: 'compiled-read', name: 'workspace_read', arguments: { path: 'readme.txt' } }] }
        : { content: 'Compiled workspace accepted', toolCalls: [] }
    } } })
  const workspaceResult = await workspaceHost.send('Use selected workspace')
  assert.equal(workspaceResult.status, 'completed')
  assert.equal(JSON.parse(workspaceResult.history[2]!.content).content, 'Compiled workspace works')
  const commands = await TrustedCommandWorkspace.open(project, process.env)
  try {
    let approvals = 0
    const context = { launchId: 'compiled-launch', sessionId: 'compiled-session', runId: 'compiled-run', accountRevision: 'compiled-account',
      canApprove: () => true, isCurrent: () => true, async approve() { approvals++; return true } }
    const signal = new AbortController().signal
    assert.equal(await commands.enable(context, signal), true)
    const argv = ['spaces here', 'quote"and\\slash', '😀']
    let command = JSON.parse((await commands.start({ id: 'compiled-command', name: 'command_start',
      arguments: { executable: process.execPath, args: ['--command-fixture', ...argv], yieldMs: 1000 } }, context, signal)).content)
    let output = command.output
    while (command.state === 'running') {
      command = JSON.parse((await commands.poll(command.executionId, 'compiled-launch:compiled-session:compiled-run', 2000)).content)
      output += command.output
    }
    assert.equal(command.state, 'exited'); assert.equal(command.exitCode, 0)
    assert.deepEqual(JSON.parse(output), { args: argv, credentialPresent: false }); assert.equal(approvals, 2)
  } finally { await commands.shutdown() }
  let textRounds = 0
  const textHost = await CliHost.create({ workspace, store: new FileSessionStore(directory),
    approve: async request => { assert.match(request.description, /JSON-quoted lines/); return true },
    settings: { provider: 'openai', model: 'fake' }, provider: { async generate() {
      return ++textRounds === 1 ? { content: '', toolCalls: [{ id: 'compiled-create-text', name: 'workspace_create_text',
        arguments: { path: 'created.txt', content: 'compiled old' } }] } : { content: 'Created', toolCalls: [] }
    } } })
  assert.equal((await textHost.send('Create created.txt with compiled old')).status, 'completed')
  assert.equal(await readFile(join(project, 'created.txt'), 'utf8'), 'compiled old')
  const hash = JSON.parse((await workspace.execute('workspace_read', { path: 'created.txt' }, new AbortController().signal)).content).revision
  let editRounds = 0
  const editHost = await CliHost.create({ workspace, store: new FileSessionStore(directory),
    approve: async () => true,
    settings: { provider: 'openai', model: 'fake' }, provider: { async generate() {
      return ++editRounds === 1 ? { content: '', toolCalls: [{ id: 'compiled-edit-text', name: 'workspace_edit_text',
        arguments: { path: 'created.txt', expectedRevision: hash, before: 'old', after: 'new' } }] } : { content: 'Edited', toolCalls: [] }
    } } })
  assert.equal((await editHost.send('Replace old with new in created.txt')).status, 'completed')
  assert.equal(await readFile(join(project, 'created.txt'), 'utf8'), 'compiled new')
  assert(!(await readdir(project)).some(name => name.startsWith('.vivi-stage-')))

} finally { await rm(directory, { recursive: true, force: true }) }

const budget = parseModelCatalog('openrouter', { data: [{ id: 'vendor/embedded-budget',
  reasoning: { mandatory: false, supports_max_tokens: true } }] })[0]!
assert.deepEqual(budget.efforts, ['none'])
assert.equal(documentedOpenAIModel('gpt-6.1-sol').tools, 'supported')
assert.equal(documentedOpenAIModel('o3-pro').streaming, 'unsupported')

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
  const windowsInput = new WindowsInputDecoder()
  await setup.mockInput.pressKeys([windowsInput.write('\x1b[13;28;13;1;16;1_')])
  await setup.mockInput.typeText('second')
  setup.mockInput.pressKey('j', { ctrl: true })
  await setup.mockInput.typeText('third')
  await setup.mockInput.pressEnter()
  assert.equal(await reading, 'Embedded input works\nsecond\nthird')
  const models = Array.from({ length: 1500 }, (_, index) => ({ name: `vendor/model-${index}`,
    searchTerms: ['Embedded Provider'], value: `vendor/model-${index}` }))
  const selecting = io.chooseSearchable('Embedded models', models, { refresh: true })
  await setup.mockInput.typeText('PROVIDER model 1499')
  setup.mockInput.pressEnter()
  assert.deepEqual(await selecting, { kind: 'selected', value: 'vendor/model-1499', query: 'PROVIDER model 1499' })
  io.close()
  assert.equal(await io.readLine('Closed'), undefined)
  console.log('Compiled native OpenTUI assets, Markdown, input, model search, workspace reads/text creation/precise edits, trusted command execution and cache usage passed')
} finally { io.close(); setup.renderer.destroy() }
