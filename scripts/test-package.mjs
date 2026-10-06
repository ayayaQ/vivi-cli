// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmInvocation, packageAcceptanceEvidence, supportsCliNode } from './platform-acceptance.mjs'
import { candidateOptions, createCandidate, exportCandidate, normalizeLicense, readCandidate,
  requireNewCandidateDirectory, verifyNpmMetadata } from './package-candidate.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const candidateInput = candidateOptions()
await requireNewCandidateDirectory(candidateInput.directory)
const temporary = await mkdtemp(join(tmpdir(), 'vivi-cli-consumer-'))
// This check prepares a fresh registry cache explicitly, then verifies an offline consumer.
// npm ci's tarball cache alone may not contain packuments needed to install an archive.
const cache = process.env.VIVI_TEST_NPM_CACHE ?? join(temporary, 'npm-cache')
const coreName = '@ayayaq/vivi'
const coreVersion = '0.5.0'
const coreIntegrity = 'sha512-9Y8PJF4EGKEJRfNoP1adJ3zhCe3mGebSl9bX3u6RmBPC6IOzflAo6wJyFeZV4JLsgFrfMzi0WrGMCYRbNeXPmA=='
const corePath = 'node_modules/@ayayaq/vivi'

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false', npm_config_engine_strict: 'true' } })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`)
  }
  assert.doesNotMatch(result.stderr, /EBADENGINE/, 'Supported package checks must not produce npm engine warnings')
  return result.stdout
}

function runNpm(args, cwd = root) {
  const invocation = npmInvocation(args)
  return run(invocation.command, invocation.args, cwd)
}

const nodeGuard = ['--experimental-loader', new URL('./no-tui-loader.mjs', import.meta.url).href]

try {
  assert(supportsCliNode(process.versions.node), 'CLI package acceptance requires supported Node >=26.4.0')
  assert.equal(manifest.engines.node, '>=26.4.0', 'CLI npm requirement must match its native dependency metadata')
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const installedLock = JSON.parse(await readFile(join(root, 'node_modules/.package-lock.json'), 'utf8'))
  const coreLock = lock.packages[corePath]
  assert.equal(lock.packages[''].engines.node, manifest.engines.node, 'CLI lock engine mismatch')
  assert.equal(coreLock.engines.node, '>=22', 'Shared core runtime support must remain unchanged')
  assert.equal(manifest.dependencies[coreName], coreVersion, 'Shared core must use an exact registry version')
  assert.equal(lock.packages[''].dependencies[coreName], coreVersion, 'Root lock dependency mismatch')
  assert.equal(coreLock.version, coreVersion, 'Shared core lock version mismatch')
  const resolved = new URL(coreLock.resolved)
  assert.equal(resolved.protocol, 'https:', 'Shared core must resolve from the HTTPS npm registry')
  assert.equal(resolved.hostname, 'registry.npmjs.org', 'Shared core must resolve from the npm registry')
  assert.match(resolved.pathname, /^\/@ayayaq\/vivi\/-\/[^/]+\.tgz$/, 'Unexpected shared core registry artifact')
  assert.equal(coreLock.integrity, coreIntegrity, 'Shared core lock must match the reviewed 0.5.0 release bytes')
  for (const field of ['version', 'resolved', 'integrity']) {
    assert.equal(installedLock.packages[corePath][field], coreLock[field], `Installed shared core ${field} mismatch; run npm ci`)
  }
  const coreManifest = JSON.parse(await readFile(join(root, corePath, 'package.json'), 'utf8'))
  assert.equal(coreManifest.name, coreName)
  assert.equal(coreManifest.version, coreVersion)
  assert.equal(coreManifest.license, 'Apache-2.0')
  let bytes, candidate
  if (candidateInput.archive) {
    ;({ bytes, candidate } = await readCandidate(candidateInput.archive, candidateInput.metadata, manifest))
    // Install an immutable temporary copy of the bytes just validated, not a mutable input path.
    await writeFile(join(temporary, candidate.artifact.filename), bytes, { flag: 'wx' })
  } else {
    const packedOutput = JSON.parse(runNpm(['pack', '--json', '--pack-destination', temporary, '--cache', cache]))
    assert(Array.isArray(packedOutput) && packedOutput.length === 1, 'Expected exactly one packed CLI archive')
    bytes = await readFile(join(temporary, packedOutput[0].filename))
    candidate = createCandidate(packedOutput[0], bytes, manifest)
  }
  const packed = candidate.npm
  const tarball = join(temporary, packed.filename)
  // npm inspects the archive itself: file metadata must agree before any consumer installation.
  verifyNpmMetadata(candidate, JSON.parse(runNpm(['pack', '--dry-run', '--json', '--ignore-scripts', tarball])))
  const paths = new Set(packed.files.map((file) => file.path))
  for (const path of ['LICENSE', 'NOTICE', 'README.md', 'RELEASING.md', 'package.json', 'tsconfig.json',
    'scripts/platform-acceptance.mjs', 'scripts/package-candidate.mjs', 'scripts/no-tui-loader.mjs',
    'src/main.ts', 'src/index.ts', 'src/host.ts', 'src/session.ts',
    'src/models.ts', 'src/picker.ts', 'src/credentials.ts', 'dist/models.js', 'dist/picker.js', 'dist/picker.d.ts', 'dist/credentials.js',
    'src/tools.ts', 'src/terminal.ts', 'src/tui.ts', 'src/preferences.ts', 'src/application.ts', 'src/launcher.ts',
    'dist/tui.js', 'dist/preferences.js', 'dist/application.js', 'dist/launcher.js', 'dist/main.js', 'dist/index.js', 'dist/index.d.ts',
    'dist/host.d.ts', 'dist/session.d.ts', 'dist/terminal.d.ts',
    'src/usage.ts', 'dist/usage.js', 'dist/usage.d.ts',
    'src/tui-mouse.ts', 'dist/tui-mouse.js', 'dist/tui-mouse.d.ts',
    'src/memory.ts', 'dist/memory.js', 'dist/memory.d.ts']) assert(paths.has(path), `Missing ${path}`)
  for (const path of ['package.json', 'LICENSE', 'NOTICE', 'ATTRIBUTION.md',
    'docs/API.md', 'examples/headless.mjs', 'src/extensions.ts', 'src/extensions/calculator.ts',
    'dist/extensions.js', 'dist/extensions.d.ts', 'dist/extensions/calculator.js',
    'dist/cjs/extensions.js', 'dist/cjs/extensions/calculator.js',
    'CAPABILITIES.md', 'examples/model-capabilities.mjs', 'src/providers/models.ts',
    'examples/memory.mjs', 'src/extensions/memory.ts', 'dist/extensions/memory.js', 'dist/extensions/memory.d.ts',
    'dist/cjs/extensions/memory.js', 'dist/cjs/extensions/memory.d.ts',
    'dist/providers/models.js', 'dist/providers/models.d.ts',
    'dist/cjs/providers/models.js', 'dist/cjs/providers/models.d.ts',
    'src/index.ts', 'src/run-agent.ts', 'src/history.ts', 'src/providers/openai.ts',
    'src/providers/openrouter.ts', 'dist/index.js', 'dist/index.d.ts', 'dist/cjs/index.js']) {
    assert(paths.has(`${corePath}/${path}`), `Missing bundled shared core ${path}`)
  }
  assert.deepEqual(packed.bundled, [coreName], 'Shared core must remain bundled')
  assert([...paths].every((path) => !path.startsWith('vendor/')), 'Obsolete vendor snapshots must not be packed')
  assert(!paths.has('src/run-agent.ts') && !paths.has('src/providers/openai.ts'), 'CLI must not copy core or provider implementations')
  assert([...paths].every((path) => !path.startsWith('test/') && !path.startsWith('dist/cjs/')))
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  // Prepare runtime dependency metadata/bytes from the registry without running install scripts.
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, tarball], temporary)
  const consumerLock = JSON.parse(await readFile(join(temporary, 'package-lock.json'), 'utf8'))
  for (const name of ['@opentui/core', 'web-tree-sitter']) {
    const path = `node_modules/${name}`
    for (const field of ['version', 'resolved', 'integrity']) {
      assert.equal(consumerLock.packages[path][field], lock.packages[path][field], `Consumer ${name} ${field} must match the reviewed lock`)
    }
  }
  await rm(join(temporary, 'node_modules'), { recursive: true, force: true })
  runNpm(['ci', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache], temporary)
  const installed = join(temporary, 'node_modules/@ayayaq/vivi-cli')
  const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(installedManifest.name, '@ayayaq/vivi-cli')
  assert.equal(installedManifest.version, manifest.version)
  assert.equal(installedManifest.private, true)
  assert.equal(installedManifest.engines.node, manifest.engines.node)
  assert.equal(installedManifest.license, 'Apache-2.0')
  assert.equal(installedManifest.dependencies[coreName], coreVersion)
  assert.equal(packed.filename, `ayayaq-vivi-cli-${manifest.version}.tgz`)
  assert.deepEqual(normalizeLicense(await readFile(join(installed, 'LICENSE'))),
    normalizeLicense(await readFile(join(root, 'LICENSE'))), 'CLI LICENSE legal text mismatch')
  const bundledCore = join(installed, corePath)
  async function compareDirectory(relative = '') {
    const entries = await readdir(join(root, corePath, relative), { withFileTypes: true })
    assert.deepEqual((await readdir(join(bundledCore, relative))).sort(), entries.map(entry => entry.name).sort(),
      `Bundled shared core directory mismatch: ${relative}`)
    for (const entry of entries) {
      const path = join(relative, entry.name)
      if (entry.isDirectory()) await compareDirectory(path)
      else {
        assert(entry.isFile(), `Unexpected shared core file type: ${path}`)
        assert.deepEqual(await readFile(join(bundledCore, path)), await readFile(join(root, corePath, path)),
          `Bundled shared core bytes mismatch: ${path}`)
      }
    }
  }
  await compareDirectory()
  // npm exec resolves the platform's installed bin shim, including vivi.cmd on Windows.
  assert.match(runNpm(['exec', '--offline', '--', 'vivi', '--help'], temporary), /--provider/)
  const launcher = join(installed, installedManifest.bin.vivi)
  assert.match(run(process.execPath, [...nodeGuard, launcher, '--no-tui', '--help'], temporary), /--provider/)
  // Anchor runtime/type consumers beside the installed package: its bundled core is an
  // implementation dependency, not a promise that npm hoists that package for other consumers.
  await writeFile(join(installed, 'consumer.mjs'), `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliHost, FileSessionStore, FileMemoryStore, calculate, builtinTools, createBuiltinToolset, aggregateUsage, formatUsage } from '@ayayaq/vivi-cli'
import { validateHistory, closeInterruptedHistory } from '@ayayaq/vivi'
import { createToolRegistry } from '@ayayaq/vivi/extensions'
import { calculatorExtension, calculate as sharedCalculate } from '@ayayaq/vivi/extensions/calculator'
import { createMemoryService, decodeMemories, encodeMemories, formatMemoryContext } from '@ayayaq/vivi/extensions/memory'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter'
import { normalizeModelCapabilities, reasoningSelectionSupport } from '@ayayaq/vivi/providers/models'
import { parseModelCatalog, documentedOpenAIModel } from './dist/models.js'
globalThis.fetch = async () => { throw new Error('Live networking is forbidden in the acceptance consumer') }
const cjsModels = createRequire(import.meta.url)('@ayayaq/vivi/providers/models')
const budgetModel = { id: 'vendor/budget-only', supported_parameters: ['reasoning'],
  reasoning: { mandatory: false, supports_max_tokens: true } }
const budget = normalizeModelCapabilities({ apiVersion: 1, provider: 'openrouter', protocol: 'chat-completions', model: budgetModel })
assert.deepEqual(cjsModels.normalizeModelCapabilities({ apiVersion: 1, provider: 'openrouter', protocol: 'chat-completions', model: budgetModel }), budget)
assert.equal(budget.reasoning.disable, 'supported')
assert.deepEqual(budget.reasoning.efforts, [])
assert.equal(reasoningSelectionSupport(budget, { mode: 'disabled' }), 'supported')
assert.equal(reasoningSelectionSupport(budget, { mode: 'effort', effort: 'high' }), 'unsupported')
assert.deepEqual(parseModelCatalog('openrouter', { data: [budgetModel] })[0].efforts, ['none'])
assert.equal(documentedOpenAIModel('gpt-6.1-sol').tools, 'supported', 'Unseeded documented host facts must remain available')
assert.equal(documentedOpenAIModel('gpt-4.1').reasoning, 'unsupported')
assert.equal(documentedOpenAIModel('o3-pro').streaming, 'unsupported')
assert.equal(documentedOpenAIModel('o3-pro').reasoning, 'supported')
assert.deepEqual(documentedOpenAIModel('o3-pro').efforts, [])
assert.equal(documentedOpenAIModel('gpt-image-2').conversation, 'unsupported')
assert.equal(calculate('3 * (4 + 2)'), 18)
assert.equal(calculate, sharedCalculate, 'CLI must re-export the shared calculator, not a duplicate parser')
assert.deepEqual(builtinTools().map(tool => tool.name), ['calculate', 'current_time'])
assert.deepEqual(createBuiltinToolset().tools[0], createToolRegistry([calculatorExtension]).tools[0])
const fixture = { id: 'packed-fixture', apiVersion: 1, tools: [{
  definition: { name: 'packed_fixture', description: 'Packed extension', parameters: { type: 'object' } },
  validateArguments() {}, execute() { return { content: 'packed extension works' } }
}] }
const directory = await mkdtemp(join(tmpdir(), 'vivi-cli-packed-runtime-'))
try {
  const host = await CliHost.create({ store: new FileSessionStore(directory),
    settings: { provider: 'openai', model: 'fake' },
    provider: { generate: async () => ({ content: 'Packed host works', toolCalls: [],
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 7, cachedInputTokens: 0 } }) } })
  const result = await host.send('Test the installed host')
  assert.equal(result.status, 'completed')
  validateHistory(result.history)
  assert.deepEqual(closeInterruptedHistory(result.history), result.history)
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 7, cachedInputTokens: 0 })
  assert.deepEqual((await new FileSessionStore(directory).load(host.session.id)).usage, result.usage)
  assert.deepEqual(aggregateUsage([result.usage, result.usage]),
    { inputTokens: 6, outputTokens: 4, totalTokens: 14, cachedInputTokens: 0 })
  assert.match(formatUsage(result.usage), /Cache input: read 0 \\/ write unreported/)
  const memory = new FileMemoryStore(directory)
  const prepared = await memory.prepareCreate('Packed persistent preference', 'user')
  await memory.commit(prepared)
  assert.equal((await memory.list()).memories[0].content, 'Packed persistent preference')
  const memoryHost = await CliHost.create({ store: new FileSessionStore(directory),
    memory, enableMemory: true, enableTools: false,
    settings: { provider: 'openai', model: 'fake' },
    provider: { generate: async ({ messages, tools }) => {
      assert.deepEqual(tools, [])
      assert.match(messages[1].content, /Packed persistent preference/)
      return { content: 'Packed context works', toolCalls: [] }
    } } })
  const memoryResult = await memoryHost.send('Use opted-in context')
  assert.deepEqual(memoryResult.history.map(message => message.content), ['Use opted-in context', 'Packed context works'])
  assert.deepEqual((await new FileSessionStore(directory).load(memoryHost.session.id)).history, memoryResult.history)
  await memoryHost.drainMemory()
  const cjsMemory = createRequire(import.meta.url)('@ayayaq/vivi/extensions/memory')
  assert.equal(cjsMemory.encodeMemories(cjsMemory.decodeMemories('{"version":1,"memories":[]}')), encodeMemories(decodeMemories('{"version":1,"memories":[]}')))
  assert.equal(cjsMemory.formatMemoryContext([]), formatMemoryContext([]))
  assert.equal(typeof createMemoryService, 'function')
  let extensionRounds = 0
  const extensionHost = await CliHost.create({ store: new FileSessionStore(directory),
    settings: { provider: 'openai', model: 'fake' }, extensions: [fixture],
    provider: { generate: async () => ++extensionRounds === 1
      ? { content: '', toolCalls: [{ id: 'packed-call', name: 'packed_fixture', arguments: {} }] }
      : { content: 'Packed extension accepted', toolCalls: [] } } })
  const extensionResult = await extensionHost.send('Test the installed extension')
  assert.equal(extensionResult.status, 'completed')
  assert.equal(extensionResult.history[2].content, 'packed extension works')
  assert.deepEqual((await new FileSessionStore(directory).load(extensionHost.session.id)).history, extensionResult.history)
  const openai = createOpenAIProvider({ model: 'fake', apiKey: 'fake', fetch: async () => new Response(JSON.stringify({
    status: 'completed', output: [{ type: 'message', id: 'fake-message', role: 'assistant', content: [{ type: 'output_text', text: 'OpenAI shared', annotations: [] }] }]
  })) })
  const router = createOpenRouterProvider({ model: 'fake', apiKey: 'fake', fetch: async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OpenRouter shared' } }]
  })) })
  assert.equal((await openai.generate({ messages: [], tools: [] }, new AbortController().signal)).content, 'OpenAI shared')
  assert.equal((await router.generate({ messages: [], tools: [] }, new AbortController().signal)).content, 'OpenRouter shared')
} finally { await rm(directory, { recursive: true, force: true }) }
`)
  run(process.execPath, [...nodeGuard, join(installed, 'consumer.mjs')], temporary)
  await writeFile(join(installed, 'consumer.ts'), `
import { CliHost, FileSessionStore, FileMemoryStore, TerminalIO, newSession, createBuiltinToolset, aggregateUsage, formatUsage, type CliMemoryStore, type MemoryChangeRequest, type ChatIO, type CliHostOptions, type CliSession,
  type SessionPersistence, type ApprovalRequest } from '@ayayaq/vivi-cli'
import type { AgentEvent, AgentResult, ModelProvider } from '@ayayaq/vivi'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import type { ToolExtension } from '@ayayaq/vivi/extensions'
import { normalizeModelCapabilities, reasoningSelectionSupport, type ModelCapabilities, type Capability } from '@ayayaq/vivi/providers/models'
const capabilities: ModelCapabilities = normalizeModelCapabilities({ apiVersion: 1, provider: 'openai', protocol: 'responses', model: { id: 'gpt-5.1' } })
const selection: Capability = reasoningSelectionSupport(capabilities, { mode: 'disabled' })
const provider: ModelProvider = createOpenAIProvider({ model: 'fake', apiKey: 'fake' })
const session: CliSession = newSession({ provider: 'openai', model: 'fake' })
session.usage = { inputTokens: 3, outputTokens: 2, totalTokens: 7, cachedInputTokens: 0, cacheWriteInputTokens: 0 }
const usageText: string = formatUsage(aggregateUsage([session.usage, undefined]))
const store: SessionPersistence = new FileSessionStore('/tmp/fake-types-only')
const memory: CliMemoryStore = new FileMemoryStore('/tmp/fake-types-only')
const change: MemoryChangeRequest = { kind: 'create', content: 'Type fixture' }
void memory; void change
const extension: ToolExtension = { id: 'typed-fixture', apiVersion: 1, tools: [] }
const options: CliHostOptions = { provider, session, store, extensions: [extension], onEvent(event: AgentEvent) { void event },
  async approve(request: ApprovalRequest, signal: AbortSignal) { void request; return !signal.aborted } }
const host = new CliHost(options)
const result: Promise<AgentResult> = host.send('Types only')
const io: ChatIO = new TerminalIO({ tui: false })
void result; void io; void usageText; void selection; void createBuiltinToolset(false, [extension])
`)
  const typeRoots = join(root, 'node_modules/@types')
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--module', 'NodeNext',
    '--target', 'ES2022', '--lib', 'ES2022,DOM', '--types', 'node', '--typeRoots', typeRoots, join(installed, 'consumer.ts')], temporary)
  if (process.env.VIVI_TEST_BUN) {
    await writeFile(join(installed, 'tui-consumer.ts'), `
import assert from 'node:assert/strict'
import { createTestRenderer } from '@opentui/core/testing'
import { CodeRenderable } from '@opentui/core'
import { OpenTuiIO } from './dist/tui.js'
import { newSession } from './dist/session.js'
const setup = await createTestRenderer({ width: 80, height: 24 })
const io = new OpenTuiIO(setup.renderer, { stream: true })
try {
  const session = newSession({ provider: 'openai', model: 'packed-headless-model' })
  session.usage = { inputTokens: 3, outputTokens: 2, totalTokens: 7, cachedInputTokens: 0 }
  session.history = [{ kind: 'assistant', content: '## Packed heading' + String.fromCharCode(10, 10) + 'Packed Markdown works', toolCalls: [] }]
  io.setSession(session)
  const reading = io.readLine('Message')
  await setup.renderOnce()
  assert(setup.captureCharFrame().includes('packed-headless-model'))
  assert(setup.captureCharFrame().includes('Session tokens: 3 in / 2 out / 7 total'))
  assert(setup.captureCharFrame().includes('Cache input: read 0 / write unreported'))
  const codeNodes = node => [...(node instanceof CodeRenderable ? [node] : []), ...node.getChildren().flatMap(codeNodes)]
  const blocks = codeNodes(setup.renderer.root)
  assert(blocks.length > 0)
  await Promise.all(blocks.map(block => block.highlightingDone))
  await setup.renderOnce()
  assert(setup.captureCharFrame().includes('Packed Markdown works'))
  assert(!setup.captureCharFrame().includes('## Packed heading'))
  const models = Array.from({ length: 1500 }, (_, index) => ({ name: 'vendor/model-' + index,
    searchTerms: ['Packed Provider'], value: 'vendor/model-' + index }))
  const selecting = io.chooseSearchable('Packed models', models, { refresh: true })
  assert.equal(await reading, undefined)
  await setup.mockInput.typeText('PROVIDER model 1499')
  setup.mockInput.pressEnter()
  assert.deepEqual(await selecting, { kind: 'selected', value: 'vendor/model-1499', query: 'PROVIDER model 1499' })
  const request = { call: { id: 'packed-approval', name: 'memory_create', arguments: {} },
    description: 'Packed fake approval only', currentRevision: 'new memory' }
  const approve = io.approve(request, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 2)); await setup.renderOnce()
  const button = setup.renderer.root.findDescendantById('vivi-approve')
  assert(button && button.y >= 0 && button.y < 24)
  await setup.mockMouse.click(button.x + 1, button.y)
  assert.equal(await approve, true)
  const deny = io.approve(request, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 2)); await setup.renderOnce()
  setup.mockInput.pressEnter()
  assert.equal(await deny, false)
  io.close()
} finally { io.close(); setup.renderer.destroy() }
`)
    run(process.env.VIVI_TEST_BUN, [join(installed, 'tui-consumer.ts')], temporary)
    assert.match(run(process.env.VIVI_TEST_BUN, [launcher, '--help'], temporary), /--provider/)
    console.log('Packed native renderer, model search, mouse approvals and Bun CLI entrypoint passed')
  }
  const sha256 = candidate.artifact.sha256
  const bun = process.env.VIVI_TEST_BUN ? run(process.env.VIVI_TEST_BUN, ['--version']).trim() : undefined
  const evidence = packageAcceptanceEvidence({ filename: packed.filename, sha256,
    integrity: packed.integrity, size: bytes.length, cliVersion: manifest.version, bun })
  if (process.env.VIVI_TEST_ACCEPTANCE_REPORT) {
    await writeFile(process.env.VIVI_TEST_ACCEPTANCE_REPORT, JSON.stringify(evidence, null, 2) + '\n')
  }
  if (candidateInput.directory) {
    await exportCandidate(candidateInput.directory, { bytes, candidate, evidence, manifest })
    console.log(`Canonical private npm candidate exported to ${candidateInput.directory}`)
  }
  console.log(`Installed CLI bin, shared-provider runtime and TypeScript declarations passed (${packed.filename})`)
  console.log(`sha256 ${sha256}`)
  console.log(`integrity ${packed.integrity}`)
} finally { await rm(temporary, { recursive: true, force: true }) }
