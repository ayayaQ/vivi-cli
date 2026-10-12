// SPDX-License-Identifier: Apache-2.0
// Compiled headless probe: real native UI/assets, no terminal automation or provider request.
import assert from 'node:assert/strict'
import type { ProviderResult } from '@ayayaq/vivi'
import { createTestRenderer } from '@opentui/core/testing'
import { CodeRenderable, TextRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { OpenTuiIO } from '../src/tui.js'
import { WindowsInputDecoder } from '../src/windows-input.js'
import { newSession } from '../src/session.js'
import { parseModelCatalog, documentedOpenAIModel } from '../src/models.js'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSkillStore } from '../src/skills.js'
import { skillCreatorSource, parseSkillDocument } from '@ayayaq/vivi/extensions/skills'
import { FileMemoryStore } from '../src/memory.js'
import { FileSessionStore } from '../src/session.js'
import { FileCliConversationStore, replayCliConversationDocument } from '../src/conversation-records.js'
import { CliHost } from '../src/host.js'
import type { CliHostOptions } from '../src/host.js'
import type { CliQuestionHost } from '../src/questions.js'
import { createQuestionExtension, QUESTION_LIMITS } from '@ayayaq/vivi/extensions/questions'
import type { Question, QuestionOption, QuestionRequest, QuestionHost, QuestionResponse, QuestionAnswer, QuestionAnswerEntry } from '@ayayaq/vivi/extensions/questions'
import { ReadOnlyWorkspace, createWorkspaceExtension } from '../src/workspace.js'
import { createToolRegistry } from '@ayayaq/vivi/extensions'
import type { Transport } from '@modelcontextprotocol/client'
import { McpConfigStore } from '../src/mcp-config.js'
import { McpManager } from '../src/mcp-manager.js'
import { TrustedCommandWorkspace } from '../src/commands.js'

// A controlled compiled child fixture, not an interpreter dependency or live shell.
if (process.argv[2] === '--command-fixture') {
  console.log(JSON.stringify({ args: process.argv.slice(3), credentialPresent: Object.keys(process.env).some(name => /API_KEY|TOKEN/.test(name)) }))
  process.exit(0)
}

// The optional pack must survive a compiled consumer, remain host-owned, and
// contribute context without storing the per-turn memory prefix in a session.
function expectCompiledCreator(content: string | undefined): void { assert.equal(content, skillCreatorSource.content) }
const directory = await mkdtemp(join(tmpdir(), 'vivi-compiled-memory-'))
const mcpMethods: string[] = []
let mcpBadOutput = false
let mcpCancellationHost: CliHost | undefined
// Compiler/runtime acceptance uses an owned in-memory invocation peer, never a live server.
const mcp = new McpManager({ store: new McpConfigStore(directory), env: {}, transportFactory: () => {
  const transport: Transport = { start: async () => {}, close: async () => transport.onclose?.(),
    send: async message => {
      if (!('method' in message)) return
      mcpMethods.push(message.method)
      if (!('id' in message)) return
      if (message.method === 'tools/call' && mcpCancellationHost) { mcpCancellationHost.cancel(); return }
      const result = message.method === 'initialize'
        ? { resultType: 'complete', protocolVersion: '2025-11-25', capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'Owned compiled peer', version: '1' } }
        : message.method === 'tools/list'
          ? { resultType: 'complete', tools: [{ name: 'compiled/name', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
            outputSchema: { type: 'object', properties: { echo: { type: 'string' } }, required: ['echo'], additionalProperties: false } }] }
          : message.method === 'tools/call'
            ? { resultType: 'complete', content: [{ type: 'text', text: 'Owned compiled echo' }], structuredContent: { echo: mcpBadOutput ? 7 : 'compiled' } }
            : message.method === 'resources/read'
              ? { resultType: 'complete', contents: [{ uri: 'fixture:///document', text: 'Owned compiled resource' }], ttlMs: 60000, cacheScope: 'private' }
              : { resultType: 'complete', resources: [{ name: 'Owned document', uri: 'fixture:///document' }] }
      const id = message.id
      queueMicrotask(() => transport.onmessage?.({ jsonrpc: '2.0', id, result }))
    } }
  return transport
} })
try {
  {
    // Real compiled consumer of the published renderer-neutral question API.
    const option: QuestionOption = { id: 'short', label: 'Short', description: 'Concise' }
    const question: Question = { id: 'style', header: 'Style', question: 'Which style?', options: [option, { id: 'long', label: 'Long' }] }
    const questions: readonly Question[] = [question, { id: 'detail', header: 'Details', question: 'Anything else?' },
      { id: 'skip', header: 'Optional', question: 'Any optional detail?' }]
    const choice: QuestionAnswer = { kind: 'option', optionId: 'long' }
    const entries: readonly QuestionAnswerEntry[] = [{ id: 'style', answer: choice },
      { id: 'detail', answer: { kind: 'text', text: 'Compiled Unicode 你好 🌱\nSecond line' } }, { id: 'skip', answer: { kind: 'skipped' } }]
    const sample: QuestionRequest = { requestId: 'compiled-types', callId: 'compiled-types', questions }
    const cancelled: QuestionResponse = { requestId: sample.requestId, status: 'cancelled' }
    void cancelled
    assert.equal(QUESTION_LIMITS.questions, 3)
    let compiledQuestionRequest: QuestionRequest | undefined, questionAsks = 0
    const ask: QuestionHost = (request, { signal }): QuestionResponse => {
      assert.equal(signal.aborted, false); questionAsks++; compiledQuestionRequest = request
      return { requestId: request.requestId, status: 'answered', answers: entries }
    }
    const cliQuestionHost: CliQuestionHost = { ask, isAvailable: () => true, accountRevision: () => 'compiled-owned-account' }
    const registry = createToolRegistry([createQuestionExtension({ ask })])
    const direct = await registry.executeTool({ id: 'compiled-question-direct', name: 'request_user_input', arguments: { questions: JSON.parse(JSON.stringify(questions)) } },
      { signal: new AbortController().signal })
    assert.deepEqual(JSON.parse(direct.content).answers, entries)
    assert.equal(createQuestionExtension().tools.length, 0)
    for (const mode of ['execute', 'plan'] as const) {
      const snapshots: unknown[] = []
      let rounds = 0, approvals = 0
      const options: CliHostOptions = { session: newSession({ provider: 'openai', model: 'compiled-offline-questions' }),
        store: { async save(session) { snapshots.push(structuredClone(session.history)) },
          async load() { throw new Error('No compiled question session replay') } },
        questionHost: cliQuestionHost, enableNotes: true, approve: async () => { approvals++; return false },
        provider: { async generate({ messages, tools }) {
          assert(tools.some(tool => tool.name === 'request_user_input'))
          if (++rounds === 1) return { content: '', toolCalls: [{ id: 'compiled-question-host', name: 'request_user_input', arguments: { questions: JSON.parse(JSON.stringify(questions)) } }] }
          const result = messages.at(-1)!
          assert.equal(result.kind, 'tool_result')
          if (result.kind !== 'tool_result') throw new Error('Compiled question result missing')
          assert.equal(result.callId, 'compiled-question-host'); assert.equal(result.name, 'request_user_input')
          assert.deepEqual(JSON.parse(result.content), { requestId: compiledQuestionRequest!.requestId, status: 'answered', answers: entries })
          return { content: 'Compiled questions accepted', toolCalls: [] }
        } } }
      const host = new CliHost(options)
      try {
        host.setTaskMode(mode)
        const result = await host.send('Clarify the offline compiled fixture')
        assert.equal(result.status, 'completed'); assert.equal(approvals, 0)
        assert.equal(host.approvalMode, 'manual'); assert.equal(host.session.noteRevision, 0)
        assert.deepEqual(snapshots.at(-1), result.history)
        assert.equal(result.history.filter(message => message.kind === 'tool_result').length, 1)
      } finally { await host.shutdown() }
    }
    assert.equal(questionAsks, 3)
  }
  await mcp.configure({ id: 'compiled', label: 'Owned compiled fixture', executable: process.execPath,
    args: [], cwd: directory, protocol: 'legacy', environment: [] })
  assert.equal(mcp.statuses()[0]!.state, 'disabled')
  assert.equal(await mcp.connect('compiled', async () => false, new AbortController().signal), false)
  assert.equal(await mcp.connect('compiled', async () => true, new AbortController().signal), true)
  assert.equal(mcp.statuses()[0]!.snapshot!.categories.tools.entries[0]!.state, 'available')
  await mcp.refresh('compiled', ['resources'], new AbortController().signal)
  assert.equal(mcp.statuses()[0]!.snapshot!.categories.resources.entries[0]!.remoteKey, 'fixture:///document')
  const alias = mcp.statuses()[0]!.snapshot!.categories.tools.entries[0]!.alias
  let mcpRounds = 0, mcpApprovals = 0
  const mcpHost = await CliHost.create({ mcp, store: new FileSessionStore(directory),
    settings: { provider: 'openai', model: 'fake' }, approve: async () => { mcpApprovals++; return true },
    provider: { async generate({ tools }): Promise<ProviderResult> {
      assert(tools.some(tool => tool.name === alias))
      if (++mcpRounds === 1) return { content: '', toolCalls: [{ id: 'compiled-mcp-call', name: alias, arguments: { query: 'compiled' } },
        { id: 'compiled-mcp-list', name: 'list_mcp_resources', arguments: { serverId: 'compiled' } }] }
      if (mcpRounds === 2) return { content: '', toolCalls: [{ id: 'compiled-mcp-read', name: 'read_mcp_resource', arguments: { serverId: 'compiled', uri: 'fixture:///document' } }] }
      return { content: 'Compiled MCP invocation accepted', toolCalls: [] }
    } } })
  const mcpResult = await mcpHost.send('Use the owned compiled MCP fixture')
  assert.equal(mcpResult.status, 'completed'); assert.equal(mcpApprovals, 2)
  assert.match(JSON.stringify(mcpResult.history), /Owned compiled echo/)
  assert.match(JSON.stringify(mcpResult.history), /Owned compiled resource/)
  let denyRounds = 0
  const deniedMcpHost = await CliHost.create({ mcp, store: new FileSessionStore(directory),
    settings: { provider: 'openai', model: 'fake' }, approve: async () => false,
    provider: { async generate() { return ++denyRounds === 1
      ? { content: '', toolCalls: [{ id: 'compiled-mcp-denied', name: alias, arguments: { query: 'denied' } }] }
      : { content: 'Compiled MCP denied', toolCalls: [] } } } })
  assert.equal((await deniedMcpHost.send('Review the owned echo')).status, 'completed')
  assert.equal(mcpMethods.filter(method => method === 'tools/call').length, 1)
  assert.equal(mcpMethods.filter(method => method === 'resources/read').length, 1)
  mcpBadOutput = true
  const [unknownCatalog] = await mcp.captureCatalogs(new AbortController().signal)
  const unknownEntry = unknownCatalog!.categories.tools.entries[0]!
  const unknownOperation = mcp.prepareOperation(unknownCatalog!, unknownEntry, 'tools', { id: 'compiled-unknown', name: alias, arguments: { query: 'uncertain' } })
  const uncertain = await mcp.invoke(unknownOperation, new AbortController().signal, () => {})
  assert.equal(uncertain.isError, true); assert.equal(JSON.parse(uncertain.content).unknownOutcome, true)
  assert.equal(mcp.statuses()[0]!.state, 'error')
  assert.equal(mcpMethods.filter(method => method === 'tools/call').length, 2)
  assert.equal(mcpMethods.filter(method => method === 'tools/list').length, 1)
  await mcp.disconnect('compiled')
  assert.equal(mcp.statuses()[0]!.state, 'disabled')
  // A real compiled host must retain the attempted outcome when the shared runner cancels.
  mcpBadOutput = false
  assert.equal(await mcp.connect('compiled', async () => true, new AbortController().signal), true)
  const cancelledStore = new FileSessionStore(directory)
  let cancelledRounds = 0, cancelledApprovals = 0
  const beforeCancellation = mcpMethods.filter(method => method === 'tools/call').length
  mcpCancellationHost = await CliHost.create({ mcp, store: cancelledStore,
    settings: { provider: 'openai', model: 'fake' }, approve: async () => { cancelledApprovals++; return true },
    provider: { async generate() { return ++cancelledRounds === 1
      ? { content: '', toolCalls: [{ id: 'compiled-cancelled', name: alias, arguments: { query: 'cancelled' } }] }
      : { content: 'No retry', toolCalls: [] } } } })
  const cancelled = await mcpCancellationHost.send('Cancel after the owned compiled request frame')
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelledApprovals, 1)
  assert.equal(mcpMethods.filter(method => method === 'tools/call').length, beforeCancellation + 1)
  for (const history of [cancelled.history, (await cancelledStore.load(mcpCancellationHost.session.id)).history]) {
    const result = history.find(message => message.kind === 'tool_result' && message.callId === 'compiled-cancelled')
    assert(result?.kind === 'tool_result'); assert.equal(result.name, alias)
    const outcome = JSON.parse(result.content)
    assert.equal(outcome.unknownOutcome, true); assert.equal(outcome.doNotRetry, true); assert.notEqual(outcome.requestSent, false)
  }
  const resumed = await CliHost.resume({ store: cancelledStore, id: mcpCancellationHost.session.id,
    provider: { async generate() { return { content: 'Compiled recovery does not replay', toolCalls: [] } } } })
  assert.equal((await resumed.send('Continue without repeating the uncertain operation')).status, 'completed')
  assert.equal(mcpMethods.filter(method => method === 'tools/call').length, beforeCancellation + 1)
  await resumed.shutdown(); await mcpCancellationHost.shutdown(); mcpCancellationHost = undefined
  await mcp.disconnect('compiled')
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
  assert.equal(host.conversationRecords.state, 'shadow')
  assert.deepEqual(host.conversationRecords.projection!.history.map(entry => entry.message), result.history)
  const storedRecords = await new FileCliConversationStore(directory).read(host.session.id)
  assert.deepEqual(replayCliConversationDocument(storedRecords!.value).projection, host.conversationRecords.projection)
  const recordResume = await CliHost.resume({ store: new FileSessionStore(directory), id: host.session.id,
    provider: { async generate() { assert.fail('Compiled replay cannot execute') } } })
  assert.deepEqual(recordResume.conversationRecords.projection, host.conversationRecords.projection)
  await recordResume.shutdown()
  await host.drainMemory()
  const skills = new FileSkillStore(join(directory, 'agent-skills'))
  const catalog = await skills.snapshot()
  expectCompiledCreator(catalog.document('skill-creator')?.content)
  assert.equal(catalog.skills.find(skill => skill.name === 'skill-creator')?.readOnly, true)
  assert.equal(parseSkillDocument(skillCreatorSource.content).metadata.name, 'skill-creator')
  await skills.drain({ close: true })
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

  let planRounds = 0
  const planMethods = mcpMethods.length
  const planHost = await CliHost.create({ workspace, commandWorkspace: commands, mcp, enableNotes: true,
    store: new FileSessionStore(directory), settings: { provider: 'openai', model: 'fake' },
    approve: async () => { assert.fail('Compiled Plan cannot request execution approval') },
    provider: { async generate({ tools, messages }): Promise<ProviderResult> {
      assert(!tools.some(tool => ['note_set', 'workspace_edit_text', 'command_start', 'fetch_url', 'read_mcp_resource'].includes(tool.name)))
      assert(messages.some(message => message.kind === 'message' && message.role === 'system' && message.content.startsWith('Plan mode is active')))
      return ++planRounds === 1 ? { content: '', toolCalls: [
        { id: 'compiled-plan-read', name: 'workspace_read', arguments: { path: 'created.txt' } },
        { id: 'compiled-plan-note', name: 'note_set', arguments: { key: 'blocked', value: 'blocked', expectedRevision: 0 } },
        { id: 'compiled-plan-command', name: 'command_start', arguments: {} },
        { id: 'compiled-plan-url', name: 'fetch_url', arguments: { url: 'https://example.com/' } },
        { id: 'compiled-plan-mcp', name: 'read_mcp_resource', arguments: {} }
      ] } : { content: 'Compiled read-only plan', toolCalls: [] }
    } } })
  planHost.setTaskMode('plan')
  const planResult = await planHost.send('Investigate and plan without changing anything')
  assert.equal(planResult.status, 'completed'); assert.equal(planHost.taskMode, 'plan')
  assert.equal(planHost.session.noteRevision, 0); assert.equal(mcpMethods.length, planMethods)
  assert.equal(await readFile(join(project, 'created.txt'), 'utf8'), 'compiled new')
  const planResults = planResult.history.filter(message => message.kind === 'tool_result')
  assert.equal(planResults.length, 5)
  assert.equal(planResults[0]!.isError, undefined); assert(planResults.slice(1).every(message => message.isError))
  planHost.setTaskMode('execute'); assert.equal(planHost.approvalMode, 'manual')
  await planHost.shutdown()

} finally { await mcp.close(); await rm(directory, { recursive: true, force: true }) }

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
  io.toolPresentation(JSON.stringify({ version: 1, callId: 'compiled-card', name: 'offline_tool', status: 'approval_required', effect: 'unknown',
    source: { reference: 'owned://compiled/presentation', revision: 'compiled-1' }, arguments: { kind: 'text', text: 'review arguments' },
    result: { kind: 'future-card', text: 'Compiled safe fallback', data: { approved: true, execute: 'NEVER_EXECUTE' } } }))
  const allText = (node: Renderable): string => [node instanceof TextRenderable ? node.plainText : '', ...node.getChildren().map(allText)].join('\n')
  await setup.renderOnce(); await setup.renderOnce()
  const collapsed = allText(setup.renderer.root.findDescendantById('vivi-transcript')!)
  assert(collapsed.includes('approval/unknown'))
  assert(!collapsed.includes('owned://compiled/presentation')); assert(!collapsed.includes('review arguments'))
  assert.equal(setup.renderer.root.findDescendantById('vivi-tool-body-display-0')!.getChildren().length, 0)
  setup.mockInput.pressKey('o', { ctrl: true }); await setup.renderOnce(); await setup.renderOnce()
  const card = allText(setup.renderer.root.findDescendantById('vivi-transcript')!)
  assert(card.includes('Approval required')); assert(card.includes('External effects are unknown'))
  assert(card.includes('owned://compiled/presentation')); assert(card.includes('unsupported presentation kind'))
  assert(card.includes('Compiled safe fallback')); assert(!card.includes('NEVER_EXECUTE'))
  const toolHeader = setup.renderer.root.findDescendantById('vivi-tool-details-display-0')!
  await setup.mockMouse.click(toolHeader.x + toolHeader.width - 1, toolHeader.y)
  await setup.renderOnce(); await setup.renderOnce()
  assert.equal(setup.renderer.root.findDescendantById('vivi-tool-body-display-0')!.getChildren().length, 0)
  // Native questions and action approvals share one focus/FIFO owner.
  assert.equal(io.canAskQuestions, Boolean(process.stdin.isTTY && process.stdout.isTTY))
  const nativeRequest: QuestionRequest = { requestId: 'compiled-native-question', callId: 'compiled-native-call', questions: [
    { id: 'style', header: 'Style', question: 'Which native style?', options: [{ id: 'short', label: 'Short' }, { id: 'long', label: 'Long' }] }
  ] }
  let globalCancels = 0
  const stopCancel = io.onCancel(() => { globalCancels++ })
  const nativeAnswer = io.askQuestions(nativeRequest, new AbortController().signal)
  const queuedApproval = io.approve({ call: { id: 'compiled-after-question', name: 'note_set', arguments: {} },
    description: 'Owned compiled approval after question', currentRevision: 0 }, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 2)); await setup.renderOnce(); await setup.renderOnce()
  assert(setup.renderer.root.findDescendantById('vivi-questions'))
  assert.equal(setup.renderer.root.findDescendantById('vivi-approve'), undefined)
  const long = setup.renderer.root.findDescendantById('vivi-question-option-1')!
  await setup.mockMouse.click(long.x + 1, long.y)
  await setup.renderOnce(); await setup.renderOnce()
  const submit = setup.renderer.root.findDescendantById('vivi-question-submit')!
  await setup.mockMouse.click(submit.x + 1, submit.y)
  assert.deepEqual(await nativeAnswer, { requestId: nativeRequest.requestId, status: 'answered',
    answers: [{ id: 'style', answer: { kind: 'option', optionId: 'long' } }] })
  await new Promise(resolve => setTimeout(resolve, 2)); await setup.renderOnce(); await setup.renderOnce()
  assert(setup.renderer.root.findDescendantById('vivi-approve'))
  setup.mockInput.pressEnter(); assert.equal(await queuedApproval, false)
  const cancelling = io.askQuestions({ ...nativeRequest, requestId: 'compiled-native-cancel' }, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 2)); await setup.renderOnce(); await setup.renderOnce()
  setup.mockInput.pressEscape()
  assert.deepEqual(await cancelling, { requestId: 'compiled-native-cancel', status: 'cancelled' })
  assert.equal(globalCancels, 0); stopCancel()
  io.close()
  assert.equal(await io.readLine('Closed'), undefined)
  console.log('Compiled native OpenTUI assets, Markdown, input, model search, workspace reads/text creation/precise edits, read-only Plan policy, informational host/native questions and approval FIFO separation, read-only skills creator/parser, trusted command execution, MCP invocation/read/denial/cancellation/recovery/unknown-outcome boundaries and cache usage passed')
} finally { io.close(); setup.renderer.destroy() }
