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
const coreVersion = '0.16.0'
const coreIntegrity = 'sha512-Df2VOeDwf6/20jt0MT0eiq1oSH7Jaf/wa6wmsy0X0G5vYgVRxvF8gnpyyVni5zs6o+6o+z5BxBvTRSiwPCGR3g=='
const yamlVersion = '2.9.1'
const yamlIntegrity = 'sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw=='
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
  assert.equal(coreLock.integrity, coreIntegrity, 'Shared core lock must match the reviewed 0.16.0 release bytes')
  assert.equal(coreLock.dependencies.yaml, yamlVersion, 'Shared YAML parser must retain its exact reviewed version')
  assert.equal(lock.packages['node_modules/yaml'].integrity, yamlIntegrity, 'YAML parser integrity must remain unchanged')
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
    'src/context-status.ts', 'dist/context-status.js', 'dist/context-status.d.ts',
    'src/tui-mouse.ts', 'dist/tui-mouse.js', 'dist/tui-mouse.d.ts',
    'src/memory.ts', 'dist/memory.js', 'dist/memory.d.ts',
    'src/auto-review.ts', 'dist/auto-review.js', 'dist/auto-review.d.ts',
    'src/auto-review-settings.ts', 'dist/auto-review-settings.js', 'dist/auto-review-settings.d.ts',
    'src/auto-review-controls.ts', 'dist/auto-review-controls.js', 'dist/auto-review-controls.d.ts',
    'src/decision-ledger.ts', 'dist/decision-ledger.js', 'dist/decision-ledger.d.ts',
    'src/skills.ts', 'dist/skills.js', 'dist/skills.d.ts',
    'src/installed-skills.ts', 'dist/installed-skills.js', 'dist/installed-skills.d.ts',
    'src/workspace.ts', 'dist/workspace.js', 'dist/workspace.d.ts',
    'src/workspace-glob.ts', 'dist/workspace-glob.js', 'dist/workspace-glob.d.ts',
    'src/conversation-records.ts', 'dist/conversation-records.js', 'dist/conversation-records.d.ts',
    'src/tool-presentation.ts', 'dist/tool-presentation.js', 'dist/tool-presentation.d.ts',
    'src/commands.ts', 'dist/commands.js', 'dist/commands.d.ts',
    'src/process-controls.ts', 'dist/process-controls.js', 'dist/process-controls.d.ts',
    'src/command-process.ts', 'dist/command-process.js', 'dist/command-process.d.ts',
    'src/command-windows.ts', 'dist/command-windows.js', 'dist/command-windows.d.ts',
    'src/workspace-edit.ts', 'dist/workspace-edit.js', 'dist/workspace-edit.d.ts',
    'src/windows-input.ts', 'dist/windows-input.js', 'dist/windows-input.d.ts',
    'src/provider-selection.ts', 'dist/provider-selection.js', 'dist/provider-selection.d.ts',
    'src/key-controls.ts', 'dist/key-controls.js', 'dist/key-controls.d.ts',
    'src/web-tools.ts', 'dist/web-tools.js', 'dist/web-tools.d.ts',
    'src/web-results.ts', 'dist/web-results.js', 'dist/web-results.d.ts',
    'src/questions.ts', 'dist/questions.js', 'dist/questions.d.ts',
    'src/input-queue.ts', 'dist/input-queue.js', 'dist/input-queue.d.ts']) assert(paths.has(path), `Missing ${path}`)
  for (const path of ['docs/PROJECT_INPUTS.md', 'src/instructions.ts', 'dist/instructions.js', 'dist/instructions.d.ts',
    'src/image-assets.ts', 'dist/image-assets.js', 'dist/image-assets.d.ts']) assert(paths.has(path), `Missing project-input artifact ${path}`)
  for (const name of ['config', 'catalog', 'manager', 'controls', 'transport', 'http-transport', 'process-group', 'windows', 'tools', 'content', 'schema', 'outcomes', 'templates']) {
    for (const path of [`src/mcp-${name}.ts`, `dist/mcp-${name}.js`, `dist/mcp-${name}.d.ts`]) {
      assert(paths.has(path), `Missing ${path}`)
    }
  }
  for (const path of ['package.json', 'LICENSE', 'NOTICE', 'ATTRIBUTION.md',
    'docs/API.md', 'examples/headless.mjs', 'src/extensions.ts', 'src/extensions/calculator.ts',
    'dist/extensions.js', 'dist/extensions.d.ts', 'dist/extensions/calculator.js',
    'dist/cjs/extensions.js', 'dist/cjs/extensions/calculator.js',
    'CAPABILITIES.md', 'examples/model-capabilities.mjs', 'src/providers/models.ts',
    'examples/memory.mjs', 'src/extensions/memory.ts', 'dist/extensions/memory.js', 'dist/extensions/memory.d.ts',
    'dist/cjs/extensions/memory.js', 'dist/cjs/extensions/memory.d.ts',
    'docs/SKILLS.md', 'examples/skills.mjs', 'skills/skill-creator/SKILL.md',
    'src/extensions/skills.ts', 'dist/extensions/skills.js', 'dist/extensions/skills.d.ts',
    'dist/cjs/extensions/skills.js', 'dist/cjs/extensions/skills.d.ts',
    'dist/providers/models.js', 'dist/providers/models.d.ts',
    'dist/cjs/providers/models.js', 'dist/cjs/providers/models.d.ts',
    'docs/QUESTIONS.md', 'examples/questions.mjs', 'src/extensions/questions.ts',
    'dist/extensions/questions.js', 'dist/extensions/questions.d.ts',
    'dist/cjs/extensions/questions.js', 'dist/cjs/extensions/questions.d.ts',
    'docs/DECISIONS.md', 'src/decisions.ts', 'dist/decisions.js', 'dist/decisions.d.ts',
    'dist/cjs/decisions.js', 'dist/cjs/decisions.d.ts', 'examples/decisions.mjs',
    'docs/MCP.md', 'src/extensions/mcp.ts', 'dist/extensions/mcp.js', 'dist/extensions/mcp.d.ts',
    'dist/cjs/extensions/mcp.js', 'dist/cjs/extensions/mcp.d.ts',
    'src/extensions/mcp/catalog.ts', 'src/extensions/mcp/operations.ts', 'src/extensions/mcp/content.ts', 'src/extensions/mcp/templates.ts',
    'src/presentation.ts', 'dist/presentation.js', 'dist/presentation.d.ts', 'dist/cjs/presentation.js',
    'dist/cjs/presentation.d.ts', 'docs/TOOL_PRESENTATION.md', 'examples/tool-presentation.mjs',
    'src/index.ts', 'src/run-agent.ts', 'src/history.ts', 'src/providers/openai.ts',
    'src/providers/openrouter.ts', 'src/providers/deepseek.ts', 'src/web.ts', 'src/web/deepseek.ts', 'docs/WEB.md', 'docs/DEEPSEEK.md',
    'dist/providers/deepseek.js', 'dist/providers/deepseek.d.ts', 'dist/cjs/providers/deepseek.js', 'dist/cjs/providers/deepseek.d.ts',
    'dist/web.js', 'dist/web.d.ts', 'dist/cjs/web.js', 'dist/cjs/web.d.ts',
    'dist/web/deepseek.js', 'dist/web/deepseek.d.ts', 'dist/cjs/web/deepseek.js', 'dist/cjs/web/deepseek.d.ts',
    'dist/index.js', 'dist/index.d.ts', 'dist/cjs/index.js']) {
    assert(paths.has(`${corePath}/${path}`), `Missing bundled shared core ${path}`)
  }
  assert.deepEqual(packed.bundled.sort(), [coreName, 'yaml'].sort(), 'Shared core and its exact transitive YAML dependency must remain bundled')
  for (const path of ['package.json', 'LICENSE', 'dist/index.js', 'browser/dist/index.js']) {
    assert(paths.has(`node_modules/yaml/${path}`), `Missing bundled YAML ${path}`)
  }
  assert([...paths].every((path) => !path.startsWith('vendor/')), 'Obsolete vendor snapshots must not be packed')
  assert(!paths.has('src/run-agent.ts') && !paths.has('src/providers/openai.ts'), 'CLI must not copy core or provider implementations')
  assert([...paths].every((path) => !path.startsWith('test/') && !path.startsWith('dist/cjs/')))
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  // Prepare runtime dependency metadata/bytes from the registry without running install scripts.
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, tarball], temporary)
  const consumerLock = JSON.parse(await readFile(join(temporary, 'package-lock.json'), 'utf8'))
  for (const name of ['@opentui/core', 'web-tree-sitter', 'ignore', 'picomatch', '@modelcontextprotocol/client', '@modelcontextprotocol/core', 'url-template']) {
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
  assert.equal(installedManifest.dependencies['@modelcontextprotocol/client'], '2.3.1')
  for (const name of ['@modelcontextprotocol/client', '@modelcontextprotocol/core']) {
    const sdk = JSON.parse(await readFile(join(temporary, 'node_modules', name, 'package.json'), 'utf8'))
    assert.equal(sdk.version, '2.3.1'); assert.equal(sdk.license, 'Apache-2.0')
    assert.deepEqual(normalizeLicense(await readFile(join(temporary, 'node_modules', name, 'LICENSE'))),
      normalizeLicense(await readFile(join(root, 'node_modules', name, 'LICENSE'))), 'MCP SDK legal text mismatch')
  }
  assert.equal(installedManifest.dependencies.ignore, '7.0.12')
  const ignoreManifest = JSON.parse(await readFile(join(temporary, 'node_modules/ignore/package.json'), 'utf8'))
  assert.equal(ignoreManifest.version, '7.0.12')
  assert.equal(ignoreManifest.license, 'MIT')
  assert.deepEqual(normalizeLicense(await readFile(join(temporary, 'node_modules/ignore/LICENSE-MIT'))),
    normalizeLicense(await readFile(join(root, 'node_modules/ignore/LICENSE-MIT'))), 'Ignore MIT legal text mismatch')
  assert.equal(installedManifest.dependencies.picomatch, '4.0.7')
  const globManifest = JSON.parse(await readFile(join(temporary, 'node_modules/picomatch/package.json'), 'utf8'))
  assert.equal(globManifest.version, '4.0.7'); assert.equal(globManifest.license, 'MIT')
  assert.deepEqual(normalizeLicense(await readFile(join(temporary, 'node_modules/picomatch/LICENSE'))),
    normalizeLicense(await readFile(join(root, 'node_modules/picomatch/LICENSE'))), 'Picomatch MIT legal text mismatch')
  assert.equal(installedManifest.dependencies['url-template'], '3.1.1')
  assert.equal(lock.packages['node_modules/url-template'].integrity, 'sha512-4oszoaEKE/mQOtAmdMWqIRHmkxWkUZMnXFnjQ5i01CuRSK3uluxcH1MRVVVWmhlnzT1SCDfKxxficm2G37qzCA==')
  const templateManifest = JSON.parse(await readFile(join(temporary, 'node_modules/url-template/package.json'), 'utf8'))
  assert.equal(templateManifest.version, '3.1.1'); assert.equal(templateManifest.license, 'BSD-3-Clause')
  assert.deepEqual(templateManifest.dependencies ?? {}, {})
  assert.deepEqual(normalizeLicense(await readFile(join(temporary, 'node_modules/url-template/LICENSE'))),
    normalizeLicense(await readFile(join(root, 'node_modules/url-template/LICENSE'))), 'Template BSD legal text mismatch')
  assert.equal(packed.filename, `ayayaq-vivi-cli-${manifest.version}.tgz`)
  assert.deepEqual(normalizeLicense(await readFile(join(installed, 'LICENSE'))),
    normalizeLicense(await readFile(join(root, 'LICENSE'))), 'CLI LICENSE legal text mismatch')
  async function compareDirectory(relative = '', dependency = corePath) {
    const entries = await readdir(join(root, dependency, relative), { withFileTypes: true })
    assert.deepEqual((await readdir(join(installed, dependency, relative))).sort(), entries.map(entry => entry.name).sort(),
      `Bundled dependency directory mismatch: ${dependency}/${relative}`)
    for (const entry of entries) {
      const path = join(relative, entry.name)
      if (entry.isDirectory()) await compareDirectory(path, dependency)
      else {
        assert(entry.isFile(), `Unexpected shared core file type: ${path}`)
        assert.deepEqual(await readFile(join(installed, dependency, path)), await readFile(join(root, dependency, path)),
          `Bundled dependency bytes mismatch: ${dependency}/${path}`)
      }
    }
  }
  await compareDirectory()
  await compareDirectory('', 'node_modules/yaml')
  // npm exec resolves the platform's installed bin shim, including vivi.cmd on Windows.
  assert.match(runNpm(['exec', '--offline', '--', 'vivi', '--help'], temporary), /--provider/)
  const launcher = join(installed, installedManifest.bin.vivi)
  assert.match(run(process.execPath, [...nodeGuard, launcher, '--no-tui', '--help'], temporary), /--provider/)
  // Anchor runtime/type consumers beside the installed package: its bundled core is an
  // implementation dependency, not a promise that npm hoists that package for other consumers.
  // The installed invocation consumer executes only this package-authored local fixture.
  await writeFile(join(installed, 'mcp-fixture.mjs'), await readFile(join(root, 'test/fixtures/mcp-invocation-server.mjs')))
  await writeFile(join(installed, 'consumer.mjs'), `
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, realpath, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { CliHost, FileSessionStore, FileMemoryStore, FileSkillStore, InstalledSkillStore, ReadOnlyWorkspace, TrustedCommandWorkspace, createWorkspaceExtension, WORKSPACE_LIMITS, calculate, builtinTools, createBuiltinToolset, aggregateUsage, formatUsage, FileCliConversationStore, replayCliConversationDocument, FileImageAssets, ProjectInstructions, newSession } from '@ayayaq/vivi-cli'
import { validateHistory, closeInterruptedHistory } from '@ayayaq/vivi'
import { createToolRegistry } from '@ayayaq/vivi/extensions'
import { createQuestionExtension, QUESTION_LIMITS } from '@ayayaq/vivi/extensions/questions'
import { calculatorExtension, calculate as sharedCalculate } from '@ayayaq/vivi/extensions/calculator'
import { createMemoryService, decodeMemories, encodeMemories, formatMemoryContext } from '@ayayaq/vivi/extensions/memory'
import { parseSkillDocument, skillCreatorSource } from '@ayayaq/vivi/extensions/skills'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter'
import { createDeepSeekProvider, projectDeepSeekHistory } from '@ayayaq/vivi/providers/deepseek'
import { WebProviderError } from '@ayayaq/vivi/web'
import { createDeepSeekWebProvider } from '@ayayaq/vivi/web/deepseek'
import { normalizeModelCapabilities, reasoningSelectionSupport } from '@ayayaq/vivi/providers/models'
import { createDecisionRequest, evaluateDecision, isDecisionCurrent, createOpenAIDecisionProvider, createOpenRouterDecisionProvider } from '@ayayaq/vivi/decisions'
import { parseModelCatalog, documentedOpenAIModel } from './dist/models.js'
import { McpConfigStore } from './dist/mcp-config.js'
import { McpManager } from './dist/mcp-manager.js'
import { decodeToolPresentation, toolPresentationView } from '@ayayaq/vivi/presentation'
import { createCliToolPresentation, cliToolPresentationView } from './dist/tool-presentation.js'
globalThis.fetch = async () => { throw new Error('Live networking is forbidden in the acceptance consumer') }
let steeringRounds = 0
const steeringAccepted = []
const steeringHost = await CliHost.create({ settings: { provider: 'openai', model: 'packed-steering' },
  store: { async save() {} }, provider: { async generate(input) {
    if (++steeringRounds === 1) {
      steeringHost.queueMessage('Packed follow-up'); steeringHost.queueMessage('Packed follow-up')
      return { content: '', toolCalls: [{ id: 'packed-steering-calc', name: 'calculate', arguments: { expression: '1+1' } }] }
    }
    assert.deepEqual(input.messages.slice(-3).map(message => message.kind), ['tool_result', 'message', 'message'])
    assert.deepEqual(input.messages.slice(-2).map(message => message.content), ['Packed follow-up', 'Packed follow-up'])
    return { content: 'Packed steering accepted', toolCalls: [] }
  } } })
try {
  assert.equal((await steeringHost.send('Start', undefined, text => steeringAccepted.push(text))).status, 'completed')
  assert.deepEqual(steeringAccepted, ['Packed follow-up', 'Packed follow-up'])
  assert.deepEqual(steeringHost.queuedMessages, [])
} finally { await steeringHost.shutdown() }
const presentation = createCliToolPresentation({ call: { id: 'packed-presentation', name: 'offline_tool', arguments: {} },
  source: { reference: 'owned://packed/presentation', revision: 'packed-1' }, status: 'approval_required', effect: 'unknown' })
const cjsPresentation = createRequire(import.meta.url)('@ayayaq/vivi/presentation')
for (const module of [{ decodeToolPresentation, toolPresentationView }, cjsPresentation]) {
  const view = module.toolPresentationView(module.decodeToolPresentation(JSON.stringify(presentation)), { collapsed: true, detailBytes: 0 })
  assert(view.header.some(line => line.includes('owned://packed/presentation')))
  assert(view.warnings.some(line => line.includes('Approval required')))
  assert(view.warnings.some(line => line.includes('External effects are unknown')))
  assert.equal(view.details.length, 0)
}
assert(cliToolPresentationView('{').warnings.some(line => line.includes('Invalid or oversized')))
const cjsModels = createRequire(import.meta.url)('@ayayaq/vivi/providers/models')
const cjsDecisions = createRequire(import.meta.url)('@ayayaq/vivi/decisions')
assert.equal(createOpenAIDecisionProvider({ apiKey: 'fake' }).model, 'gpt-6-luna')
assert.equal(createOpenRouterDecisionProvider({ apiKey: 'fake' }).model, 'typesafe/jev-1.13')
for (const module of [{ createDecisionRequest, evaluateDecision, isDecisionCurrent }, cjsDecisions]) {
  const snapshot = { sessionId: 'packed', runId: 'packed-run', toolCall: { id: 'packed-review', name: 'note_set', arguments: { key: 'color', value: 'blue' } },
    userRequest: { id: 'packed-request', text: 'Set a note color to blue', approvedScope: { tool: 'note_set' } },
    policyRevision: 'packed-v1', resourceRevisions: { noteRevision: 0 }, inputData: { before: null, after: 'blue' } }
  const request = module.createDecisionRequest(snapshot, { provider: 'openai', checks: [{ name: 'requested', instructions: 'The exact save was requested',
    trueDescription: 'Requested', falseDescription: 'Not requested', allowAt: 0.995, denyAt: 0.05 }] })
  const result = await module.evaluateDecision(request, { id: 'openai', model: 'gpt-6-luna', evaluate: async () => ({ model: 'gpt-6-luna',
    answers: [{ name: 'requested', type: 'predicate', probability: 1 }], usage: { inputTokens: 1, outputTokens: 1 } }) })
  assert.equal(result.outcome, 'allow'); assert(module.isDecisionCurrent(result, snapshot))
}
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
const scopedTools = createBuiltinToolset(true, [fixture]), scopedCleanup = []
scopedTools.defer(() => { scopedCleanup.push('first') })
scopedTools.defer(async () => { await Promise.resolve(); scopedCleanup.push('last') })
const scopedHost = { enableNotes: true, readNotes() { assert.fail('Closed note dispatch') },
  async commitNote() { assert.fail('Closed note commit') }, async approve() { assert.fail('Closed approval') } }
assert.equal((await scopedTools.executeTool({ id: 'packed-scoped', name: 'packed_fixture', arguments: {} },
  new AbortController().signal, scopedHost)).content, 'packed extension works')
const scopedDisposal = scopedTools.dispose()
assert.equal(scopedTools.signal.aborted, true)
assert.equal(scopedTools.dispose(), scopedDisposal)
await scopedDisposal
assert.deepEqual(scopedCleanup, ['last', 'first'])
for (const name of ['packed_fixture', 'current_time', 'note_read']) {
  await assert.rejects(scopedTools.executeTool({ id: 'packed-closed', name, arguments: {} },
    new AbortController().signal, scopedHost), { name: 'AbortError' })
}
const directory = await realpath(await mkdtemp(join(tmpdir(), 'vivi-cli-packed-runtime-')))
// Installed ESM and CJS consumers must use the published question entrypoint.
const cjsQuestions = createRequire(import.meta.url)('@ayayaq/vivi/extensions/questions')
const questionArguments = { questions: [
  { id: 'choice', header: 'Style', question: 'Which style?', options: [{ id: 'short', label: 'Short' }, { id: 'long', label: 'Long' }] },
  { id: 'text', header: 'Details', question: 'Anything else?' },
  { id: 'skip', header: 'Optional', question: 'Any optional detail?' }
] }
const humanAnswers = [{ id: 'choice', answer: { kind: 'option', optionId: 'long' } },
  { id: 'text', answer: { kind: 'text', text: 'Packed Unicode 你好 🌱' + String.fromCharCode(10) + 'Second line' } },
  { id: 'skip', answer: { kind: 'skipped' } }]
for (const module of [{ createQuestionExtension, QUESTION_LIMITS }, cjsQuestions]) {
  assert.equal(module.QUESTION_LIMITS.questions, 3)
  assert.equal(module.createQuestionExtension().tools.length, 0)
  const registry = createToolRegistry([module.createQuestionExtension({ ask: (request, { signal }) => {
    assert.equal(signal.aborted, false); assert.equal(request.callId, 'packed-question-entrypoint')
    return { requestId: request.requestId, status: 'answered', answers: humanAnswers }
  } })])
  const result = await registry.executeTool({ id: 'packed-question-entrypoint', name: 'request_user_input', arguments: questionArguments },
    { signal: new AbortController().signal })
  assert.deepEqual(JSON.parse(result.content).answers, humanAnswers)
}
for (const mode of ['execute', 'plan']) {
  const snapshots = [], approvals = []
  let rounds = 0, asks = 0, activeRequest
  const host = await CliHost.create({ settings: { provider: 'openai', model: 'packed-offline-questions' },
    store: { async save(session) { snapshots.push(structuredClone(session)) } }, enableNotes: true,
    approve: async request => { approvals.push(request); return false },
    questionHost: { accountRevision: () => 'owned-packed-account', isAvailable: () => true, ask: (request, { signal }) => {
      assert.equal(signal.aborted, false); asks++; activeRequest = request
      return { requestId: request.requestId, status: 'answered', answers: humanAnswers }
    } }, provider: { async generate({ messages, tools }) {
      assert(tools.some(tool => tool.name === 'request_user_input'))
      if (++rounds === 1) return { content: '', toolCalls: [{ id: 'packed-question-host', name: 'request_user_input', arguments: questionArguments }] }
      const result = messages.at(-1)
      assert.equal(result.callId, 'packed-question-host'); assert.equal(result.name, 'request_user_input')
      assert.deepEqual(JSON.parse(result.content), { requestId: activeRequest.requestId, status: 'answered', answers: humanAnswers })
      return { content: 'Packed questions accepted', toolCalls: [] }
    } } })
  try {
    host.setTaskMode(mode)
    const result = await host.send('Clarify the offline package fixture')
    assert.equal(result.status, 'completed'); assert.equal(asks, 1); assert.deepEqual(approvals, [])
    assert.equal(host.approvalMode, 'manual'); assert.equal(host.session.noteRevision, 0)
    assert.deepEqual(snapshots.at(-1).history, result.history)
    assert.equal(result.history.filter(message => message.kind === 'tool_result').length, 1)
  } finally { await host.shutdown() }
}
const fixtureEnvironment = process.platform === 'win32' && !process.versions.bun ? ['SYSTEMROOT'] : []
const fixtureEnv = fixtureEnvironment.length ? { SYSTEMROOT: Object.entries(process.env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1]
  ?? assert.fail('Windows Node fixture requires an explicitly captured SystemRoot') } : {}
const mcp = new McpManager({ store: new McpConfigStore(directory), env: { ...fixtureEnv, OPENAI_API_KEY: 'fake-provider-key' } })
try {
  await mcp.configure({ id: 'packed', label: 'Owned package fixture', executable: process.execPath,
    args: [...(process.versions.bun ? ['--no-install'] : []), fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url)), 'normal', join(directory, 'mcp-log'), join(directory, 'mcp-pid')],
    cwd: directory, protocol: 'legacy', environment: fixtureEnvironment })
  assert.equal(mcp.statuses()[0].state, 'disabled')
  assert.equal(await mcp.connect('packed', async () => false, new AbortController().signal), false)
  assert.equal(await mcp.connect('packed', async launch => { assert.deepEqual(launch.environment, fixtureEnv); return true }, new AbortController().signal), true)
  const packedMcp = mcp.statuses()[0].snapshot
  assert.equal(packedMcp.categories.tools.state, 'ready')
  assert.equal(packedMcp.categories.tools.entries[0].remoteKey, 'echo/name')
  assert(Object.isFrozen(packedMcp.categories.tools.entries[0].descriptor))
  await mcp.refresh('packed', ['resources', 'resourceTemplates'], new AbortController().signal)
  assert.equal(mcp.statuses()[0].snapshot.categories.resources.state, 'ready')
  const alias = packedMcp.categories.tools.entries[0].alias
  let mcpRounds = 0, mcpApprovals = 0
  const mcpHost = await CliHost.create({ store: new FileSessionStore(directory), mcp,
    settings: { provider: 'openai', model: 'fake' }, approve: async () => { mcpApprovals++; return true },
    provider: { async generate(input) {
      assert(input.tools.some(tool => tool.name === alias))
      assert(input.tools.some(tool => tool.name === 'read_mcp_resource_template'))
      if (++mcpRounds === 1) return { content: '', toolCalls: [{ id: 'packed-mcp-call', name: alias, arguments: { query: 'packed' } },
        { id: 'packed-mcp-list', name: 'list_mcp_resources', arguments: { serverId: 'packed' } }] }
      if (mcpRounds === 2) return { content: '', toolCalls: [{ id: 'packed-mcp-read', name: 'read_mcp_resource', arguments: { serverId: 'packed', uri: 'fixture:///document' } },
        { id: 'packed-mcp-template', name: 'read_mcp_resource_template', arguments: { serverId: 'packed', uriTemplate: 'fixture:///{name}', variables: { name: 'from template/é' } } }] }
      return { content: 'Packed MCP invocation accepted', toolCalls: [] }
    } } })
  const mcpResult = await mcpHost.send('Use the owned packed MCP fixture')
  assert.equal(mcpResult.status, 'completed'); assert.equal(mcpApprovals, 3)
  assert.match(JSON.stringify(mcpResult.history), /Echo: packed/)
  assert.match(JSON.stringify(mcpResult.history), /Owned resource 1/)
  assert.equal(mcpHost.conversationRecords.state, 'shadow')
  assert.deepEqual(mcpHost.conversationRecords.projection.history.map(entry => entry.message), mcpResult.history)
  assert(mcpHost.conversationRecords.projection.outcomes.some(item => item.effect === 'confirmed' && item.status === 'succeeded'))
  const packedRecords = await new FileCliConversationStore(directory).read(mcpHost.session.id)
  assert.deepEqual(replayCliConversationDocument(packedRecords.value).projection, mcpHost.conversationRecords.projection)
  let denyRounds = 0
  const deniedMcpHost = await CliHost.create({ store: new FileSessionStore(directory), mcp,
    settings: { provider: 'openai', model: 'fake' }, approve: async () => false,
    provider: { async generate() { return ++denyRounds === 1
      ? { content: '', toolCalls: [{ id: 'packed-mcp-denied', name: alias, arguments: { query: 'denied' } }] }
      : { content: 'Packed MCP denied', toolCalls: [] } } } })
  assert.equal((await deniedMcpHost.send('Review the owned echo')).status, 'completed')
  assert.equal(deniedMcpHost.conversationRecords.state, 'shadow')
  assert(deniedMcpHost.conversationRecords.projection.outcomes.some(item => item.effect === 'not_attempted'))
  const protocolLog = (await readFile(join(directory, 'mcp-log'), 'utf8')).trim().split('\\n').map(JSON.parse)
  assert.equal(protocolLog.filter(message => message.method === 'tools/call').length, 1)
  assert.equal(protocolLog.filter(message => message.method === 'resources/read').length, 2)
  assert.equal(protocolLog.filter(message => message.method === 'resources/read')[1].params.uri, 'fixture:///from%20template%2F%C3%A9')
  await mcp.disconnect('packed')
  assert.equal(mcp.statuses()[0].state, 'disabled')
  await mcp.remove('packed')
  await mcp.configure({ id: 'unknown', label: 'Owned unknown-outcome fixture', executable: process.execPath,
    args: [...(process.versions.bun ? ['--no-install'] : []), fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url)), 'bad-output', join(directory, 'unknown-log'), join(directory, 'unknown-pid')],
    cwd: directory, protocol: 'legacy', environment: fixtureEnvironment })
  assert.equal(await mcp.connect('unknown', async () => true, new AbortController().signal), true)
  const [unknownCatalog] = await mcp.captureCatalogs(new AbortController().signal)
  const unknownEntry = unknownCatalog.categories.tools.entries.find(entry => entry.remoteKey === 'echo/name')
  const unknownOperation = mcp.prepareOperation(unknownCatalog, unknownEntry, 'tools', { id: 'packed-unknown', name: unknownEntry.alias, arguments: { query: 'uncertain' } })
  const uncertain = await mcp.invoke(unknownOperation, new AbortController().signal, () => {})
  assert.equal(uncertain.isError, true); assert.equal(JSON.parse(uncertain.content).unknownOutcome, true)
  assert.equal(mcp.statuses()[0].state, 'error')
  const unknownLog = (await readFile(join(directory, 'unknown-log'), 'utf8')).trim().split('\\n').map(JSON.parse)
  assert.equal(unknownLog.filter(message => message.method === 'tools/call').length, 1)
  await mcp.disconnect('unknown')
  let httpEffects = 0
  const remoteMcp = new McpManager({ store: new McpConfigStore(join(directory, 'http-state')), env: {}, httpFetch: async (input, init) => {
    assert.equal(String(input), 'https://mcp.example.test/packed'); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'manual')
    const message = JSON.parse(init.body)
    const result = message.method === 'server/discover' ? { supportedVersions: ['2026-07-28'], capabilities: { tools: {}, resources: {} }, ttlMs: 0, cacheScope: 'private' }
      : message.method === 'tools/list' ? { tools: [{ name: 'packed_http_echo', inputSchema: { type: 'object', additionalProperties: false } }], ttlMs: 0, cacheScope: 'private' }
      : message.method === 'resources/templates/list' ? { resourceTemplates: [{ uriTemplate: 'fixture:///{name}', name: 'Packed HTTP template' }], ttlMs: 0, cacheScope: 'private' }
      : message.method === 'resources/read' ? (httpEffects++, { contents: [{ uri: message.params.uri, text: 'Packed HTTP template accepted' }], ttlMs: 0, cacheScope: 'private' })
      : message.method === 'tools/call' ? (httpEffects++, { content: [{ type: 'text', text: 'Packed HTTP fixture accepted' }] })
      : assert.fail('Unexpected HTTP request ' + message.method)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ...result, resultType: 'complete' } }), { headers: { 'content-type': 'application/json' } })
  } })
  try {
    await remoteMcp.configure({ transport: 'http', id: 'packed_http', label: 'Owned packed HTTP fixture', endpoint: 'https://mcp.example.test/packed', protocol: '2026-07-28', allowLoopbackHttp: false })
    assert.equal(await remoteMcp.connect('packed_http', async launch => { assert.equal(launch.authRevision, 'anonymous'); return true }, new AbortController().signal), true)
    const [snapshot] = await remoteMcp.captureCatalogs(new AbortController().signal), entry = snapshot.categories.tools.entries[0]
    const operation = remoteMcp.prepareOperation(snapshot, entry, 'tools', { id: 'packed-http-call', name: entry.alias, arguments: {} })
    const outcome = await remoteMcp.invoke(operation, new AbortController().signal, () => {})
    assert.equal(JSON.parse(outcome.content).confirmedOutcome, true); assert.equal(httpEffects, 1)
    await remoteMcp.refresh('packed_http', ['resourceTemplates'], new AbortController().signal)
    const [templateSnapshot] = await remoteMcp.captureCatalogs(new AbortController().signal), template = templateSnapshot.categories.resourceTemplates.entries[0]
    const templateOperation = remoteMcp.prepareOperation(templateSnapshot, template, 'resourceTemplates', { id: 'packed-http-template', name: 'read_mcp_resource_template',
      arguments: { serverId: 'packed_http', uriTemplate: template.remoteKey, variables: { name: 'from HTTP/é' } } })
    assert.equal(templateOperation.resourceUri, 'fixture:///from%20HTTP%2F%C3%A9')
    const templateOutcome = await remoteMcp.invoke(templateOperation, new AbortController().signal, () => {})
    assert.equal(JSON.parse(templateOutcome.content).confirmedOutcome, true); assert.equal(httpEffects, 2)
    assert.equal(JSON.parse(templateOutcome.content).remoteKey, templateOperation.resourceUri)
  } finally { await remoteMcp.close() }
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
  assert.deepEqual(memoryHost.conversationRecords.projection.history.map(entry => entry.message), memoryResult.history)
  assert.deepEqual(memoryHost.conversationRecords.projection.usage, memoryHost.session.usage)
  const recordResume = await CliHost.resume({ store: new FileSessionStore(directory), id: memoryHost.session.id,
    provider: { async generate() { assert.fail('Replay must never execute') } } })
  assert.deepEqual(recordResume.conversationRecords.projection, memoryHost.conversationRecords.projection)
  await recordResume.shutdown()
  await memoryHost.drainMemory()
  const cjsMemory = createRequire(import.meta.url)('@ayayaq/vivi/extensions/memory')
  assert.equal(cjsMemory.encodeMemories(cjsMemory.decodeMemories('{"version":1,"memories":[]}')), encodeMemories(decodeMemories('{"version":1,"memories":[]}')))
  assert.equal(cjsMemory.formatMemoryContext([]), formatMemoryContext([]))
  assert.equal(typeof createMemoryService, 'function')
  const skills = new FileSkillStore(join(directory, 'agent-skills'))
  const skillCatalog = await skills.snapshot()
  assert.equal(skills.discoveryComplete, true, JSON.stringify(skills.diagnostics))
  assert.equal(skillCatalog.skills.find(item => item.name === 'skill-creator').readOnly, true)
  assert.equal(skillCatalog.document('skill-creator').content, skillCreatorSource.content)
  const cjsSkills = createRequire(import.meta.url)('@ayayaq/vivi/extensions/skills')
  assert.deepEqual(cjsSkills.parseSkillDocument(skillCreatorSource.content), parseSkillDocument(skillCreatorSource.content))
  let skillRounds = 0
  const skillsHost = await CliHost.create({ store: new FileSessionStore(directory), skills, enableSkills: true,
    settings: { provider: 'openai', model: 'fake' }, provider: { generate: async ({ messages, tools }) => {
      assert(tools.some(tool => tool.name === 'read_skill'))
      assert(!tools.some(tool => tool.name === 'save_skill'))
      assert(messages.some(message => message.role === 'user' && message.content.includes('skill-creator')))
      return ++skillRounds === 1 ? { content: '', toolCalls: [{ id: 'packed-skill-read', name: 'read_skill', arguments: {
        name: 'skill-creator', path: 'SKILL.md', expectedRevision: skillCatalog.document('skill-creator').revision } }] }
        : { content: 'Packed skills work', toolCalls: [] }
    } } })
  const skillsResult = await skillsHost.send('Use the bundled creator')
  assert.equal(skillsResult.status, 'completed')
  assert(!skillsResult.history.some(message => message.role === 'user' && message.content.startsWith('Available instruction-only skills')))
  assert.equal(skills.writable, false)
  assert.equal(typeof skills.prepare, 'undefined')
  assert.equal(typeof skills.commit, 'undefined')
  assert(!skillsResult.history.some(message => message.name === 'save_skill'))
  await skills.drain({ close: true })
  const installedSkills = new InstalledSkillStore(directory)
  await installedSkills.snapshot()
  assert.deepEqual(installedSkills.diagnostics, [], 'Owned packed fixture discovery must complete before saving')
  const installedText = '---\\nname: packed-guide\\ndescription: Installed package fixture.\\n---\\nUse supplied facts.\\n'
  const installedDocument = parseSkillDocument(installedText)
  const installedReceipt = await installedSkills.commit({ name: 'packed-guide', before: null, expectedRevision: null, after: installedDocument }, { signal: new AbortController().signal })
  assert.equal(installedReceipt.revision, installedDocument.revision)
  assert.equal((await new InstalledSkillStore(directory).snapshot()).document('packed-guide').content, installedText)
  await installedSkills.drain({ close: true })
  const project = join(directory, 'project')
  await mkdir(project)
  await writeFile(join(project, 'readme.txt'), 'Packed workspace works')
  await writeFile(join(project, '.gitignore'), '*.log')
  await writeFile(join(project, 'ignored.log'), 'Packed ignored fixture')
  const workspace = await ReadOnlyWorkspace.open(project)
  await writeFile(join(project, 'AGENTS.md'), 'Packaged scoped project guidance')
  const imagePixels = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
  await writeFile(join(project, 'image.png'), imagePixels)
  const imageSession = newSession({ provider: 'openai', model: 'gpt-4.1' })
  const imageAssets = new FileImageAssets(join(directory, 'images'), imageSession.id)
  assert.equal(typeof ProjectInstructions, 'function')
  let imageRounds = 0
  const imageHost = new CliHost({ session: imageSession, store: new FileSessionStore(directory), workspace,
    images: imageAssets, imageCapability: 'supported', provider: { async generate({ messages, tools }) {
      assert(tools.some(tool => tool.name === 'workspace_read_image'))
      assert(messages.some(message => message.role === 'user' && message.content.includes('Packaged scoped project guidance')))
      if (++imageRounds === 1) return { content: '', toolCalls: [{ id: 'packed-image', name: 'workspace_read_image', arguments: { path: 'image.png' } }] }
      const observation = messages.find(message => message.kind === 'tool_result' && message.images)
      assert.deepEqual(Buffer.from(imageAssets.resolve(observation.images[0])), imagePixels)
      return { content: 'Packed image observed', toolCalls: [] }
    } } })
  assert.equal((await imageHost.send('Inspect image.png')).status, 'completed')
  assert.equal(imageHost.session.schemaVersion, 3)
  assert(!JSON.stringify(imageHost.session).includes(imagePixels.toString('base64')))
  assert(!JSON.stringify(imageHost.session).includes('Packaged scoped project guidance'))
  assert(imageHost.conversationRecords.projection.history.some(entry => entry.message.images?.length))
  await imageHost.shutdown()
  await rm(join(project, 'AGENTS.md')); await rm(join(project, 'image.png'))
  const workspaceRegistry = createToolRegistry([createWorkspaceExtension(workspace)])
  const listing = await workspaceRegistry.executeTool({ id: 'packed-workspace', name: 'workspace_list', arguments: {} }, { signal: new AbortController().signal })
  assert.equal(JSON.parse(listing.content).untrusted, true)
  assert(!JSON.parse(listing.content).entries.some(item => item.path === 'ignored.log'))
  const glob = await workspaceRegistry.executeTool({ id: 'packed-glob', name: 'workspace_glob', arguments: { pattern: '**/*.txt' } }, { signal: new AbortController().signal })
  assert.deepEqual(JSON.parse(glob.content).matches, [{ path: 'readme.txt', kind: 'file' }])
  assert.equal(JSON.parse(glob.content).truncated, false)
  assert.equal(WORKSPACE_LIMITS.maximumReadBytes, 8192)
  let workspaceRounds = 0
  const workspaceHost = await CliHost.create({ store: new FileSessionStore(directory), workspace,
    settings: { provider: 'openai', model: 'fake' }, provider: { generate: async () => ++workspaceRounds === 1
      ? { content: '', toolCalls: [{ id: 'packed-read', name: 'workspace_read', arguments: { path: 'readme.txt' } }] }
      : { content: 'Packed workspace accepted', toolCalls: [] } } })
  const workspaceResult = await workspaceHost.send('Test opted-in workspace')
  assert.equal(workspaceResult.status, 'completed')
  assert.equal(JSON.parse(workspaceResult.history[2].content).content, 'Packed workspace works')
  assert.deepEqual((await new FileSessionStore(directory).load(workspaceHost.session.id)).history, workspaceResult.history)
  const commands = await TrustedCommandWorkspace.open(project, process.env)
  try {
    let approvals = 0
    const context = { launchId: 'packed-launch', sessionId: 'packed-session', runId: 'packed-run', accountRevision: 'packed-account',
      canApprove: () => true, isCurrent: () => true, async approve() { approvals++; return true } }
    const signal = new AbortController().signal
    assert.equal(await commands.enable(context, signal), true)
    const argv = ['spaces here', 'quote' + String.fromCharCode(34, 92), '😀']
    let result = JSON.parse((await commands.start({ id: 'packed-command', name: 'command_start', arguments: {
      executable: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...argv], yieldMs: 1000 } }, context, signal)).content)
    let output = result.output
    while (result.state === 'running') {
      result = JSON.parse((await commands.poll(result.executionId, 'packed-launch:packed-session:packed-run', 2000)).content)
      output += result.output
    }
    assert.equal(result.state, 'exited'); assert.equal(result.exitCode, 0)
    assert.deepEqual(JSON.parse(output), argv); assert.equal(approvals, 2)
  } finally { await commands.shutdown() }
  let textRounds = 0
  const textHost = await CliHost.create({ store: new FileSessionStore(directory), workspace,
    approve: async request => { assert.match(request.description, /JSON-quoted lines/); return true },
    settings: { provider: 'openai', model: 'fake' }, provider: { generate: async () => ++textRounds === 1
      ? { content: '', toolCalls: [{ id: 'packed-create-text', name: 'workspace_create_text', arguments: { path: 'created.txt', content: 'packed old' } }] }
      : { content: 'Packed text accepted', toolCalls: [] } } })
  assert.equal((await textHost.send('Create created.txt with packed old')).status, 'completed')
  assert.equal(await readFile(join(project, 'created.txt'), 'utf8'), 'packed old')
  const readRevision = JSON.parse((await workspace.execute('workspace_read', { path: 'created.txt' }, new AbortController().signal)).content).revision
  let editRounds = 0, decisions = 0
  const editNotices = [], editAudits = []
  const editHost = await CliHost.create({ store: new FileSessionStore(directory), workspace,
    approve: async () => { throw new Error('Packed eligible edit unexpectedly needed manual review') },
    onReviewNotice: (message, context) => editNotices.push({ message, context }),
    decisionReview: { canAutoReview: true, autoReviewThresholds: { openai: 950, openrouter: 990 }, accountRevision: () => 'packed-account', ledger: { async upsert(row) { editAudits.push(row) } },
      provider: { id: 'openai', model: 'gpt-6-luna', async evaluate(request) {
        decisions++; assert.equal(request.snapshot.preparedAction.effects[0].scope, 'workspace')
        assert(request.policy.checks.every(check => check.allowAt === 0.95 && check.denyAt === 0.05))
        assert.match(request.snapshot.policyRevision, /-t950$/)
        assert.equal(request.snapshot.inputData.before, 'old'); assert.equal(request.snapshot.inputData.after, 'new')
        return { model: 'gpt-6-luna', answers: request.policy.checks.map(check => ({ name: check.name, type: 'predicate', probability: 0.95 })),
          usage: { inputTokens: 1, outputTokens: 1 } }
      } } },
    settings: { provider: 'openai', model: 'fake' }, provider: { generate: async () => ++editRounds === 1
      ? { content: '', toolCalls: [{ id: 'packed-edit-text', name: 'workspace_edit_text', arguments: {
        path: 'created.txt', expectedRevision: readRevision, before: 'old', after: 'new' } }] }
      : { content: 'Packed precise edit accepted', toolCalls: [] } } })
  editHost.setApprovalMode('auto')
  assert.equal((await editHost.send('Replace old with new in created.txt')).status, 'completed')
  assert.equal(decisions, 1); assert.equal(await readFile(join(project, 'created.txt'), 'utf8'), 'packed new')
  assert(!(await readdir(project)).some(name => name.startsWith('.vivi-stage-')))
  assert.deepEqual(editAudits.at(-1).thresholds, { allowAt: 0.95, denyAt: 0.05 })
  assert.equal(editNotices.at(-1).context.evaluation.checks.length, 4)
  assert(editNotices.at(-1).message.includes('Lowest requirement estimate 95%'))
  assert(editNotices.at(-1).message.includes('required 95%'))
  editHost.setAutoReviewThresholds({ openrouter: 990 })
  assert.equal(editHost.approvalMode, 'manual')
  assert.deepEqual(editHost.autoReviewThresholds, { openrouter: 990 })
  const copiedThresholds = editHost.autoReviewThresholds; copiedThresholds.openrouter = 900
  assert.equal(editHost.autoReviewThresholds.openrouter, 990)
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
  let planRounds = 0
  const planHost = await CliHost.create({ store: new FileSessionStore(directory), workspace, enableNotes: true,
    settings: { provider: 'openai', model: 'fake' }, extensions: [fixture],
    approve: async () => { assert.fail('Packed Plan cannot request execution approval') },
    provider: { async generate({ tools }) {
      assert(!tools.some(tool => ['note_set', 'workspace_edit_text', 'packed_fixture', 'command_start', 'fetch_url', 'read_mcp_resource'].includes(tool.name)))
      return ++planRounds === 1 ? { content: '', toolCalls: [
        { id: 'packed-plan-read', name: 'workspace_read', arguments: { path: 'created.txt' } },
        ...['note_set', 'packed_fixture', 'command_start', 'fetch_url', 'read_mcp_resource'].map(name => ({ id: 'packed-plan-' + name, name, arguments: {} }))
      ] } : { content: 'Packed read-only plan', toolCalls: [] }
    } } })
  planHost.setTaskMode('plan')
  const planResult = await planHost.send('Investigate without changing anything')
  assert.equal(planResult.status, 'completed'); assert.equal(planHost.taskMode, 'plan')
  assert.equal(planHost.session.noteRevision, 0); assert.equal(await readFile(join(project, 'created.txt'), 'utf8'), 'packed new')
  const planResults = planResult.history.filter(message => message.kind === 'tool_result')
  assert.equal(planResults.length, 6); assert.equal(planResults[0].isError, undefined)
  assert(planResults.slice(1).every(message => message.isError))
  planHost.setTaskMode('execute'); assert.equal(planHost.approvalMode, 'manual')
  await planHost.shutdown()
  const openai = createOpenAIProvider({ model: 'fake', apiKey: 'fake', fetch: async () => new Response(JSON.stringify({
    status: 'completed', output: [{ type: 'message', id: 'fake-message', role: 'assistant', content: [{ type: 'output_text', text: 'OpenAI shared', annotations: [] }] }]
  })) })
  const router = createOpenRouterProvider({ model: 'fake', apiKey: 'fake', fetch: async () => new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'OpenRouter shared' } }]
  })) })
  assert.equal((await openai.generate({ messages: [], tools: [] }, new AbortController().signal)).content, 'OpenAI shared')
  assert.equal((await router.generate({ messages: [], tools: [] }, new AbortController().signal)).content, 'OpenRouter shared')
  const require = createRequire(import.meta.url)
  for (const module of [{ createDeepSeekProvider, projectDeepSeekHistory }, require('@ayayaq/vivi/providers/deepseek')]) {
    const deepseek = module.createDeepSeekProvider({ model: 'deepseek-flash', apiKey: 'packed-chat-fixture', fetch: async (input, init) => {
      assert.equal(String(input), 'https://api.deepseek.com/chat/completions')
      assert.equal(init.headers.Authorization, 'Bearer packed-chat-fixture')
      return new Response(JSON.stringify({ model: 'deepseek-flash', choices: [{ finish_reason: 'stop',
        message: { role: 'assistant', content: 'DeepSeek shared', reasoning_content: 'Packed native reasoning' } }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_cache_hit_tokens: 1 } }))
    } })
    const result = await deepseek.generate({ messages: [], tools: [] }, new AbortController().signal)
    assert.equal(result.content, 'DeepSeek shared'); assert.equal(result.providerState.provider, 'deepseek:deepseek-flash')
    assert.equal(result.usage.cachedInputTokens, 1)
    assert.equal(module.projectDeepSeekHistory([{ kind: 'assistant', ...result }], 'deepseek-flash', { tools: true })[0].reasoning_content, 'Packed native reasoning')
  }
  for (const module of [{ createDeepSeekWebProvider, WebProviderError }, { ...require('@ayayaq/vivi/web/deepseek'), ...require('@ayayaq/vivi/web') }]) {
    const intents = [], sends = []
    const web = module.createDeepSeekWebProvider({ apiKey: 'packed-web-fixture', beforeRequest: intent => { intents.push(intent) }, fetch: async (input, init) => {
      sends.push({ input, request: JSON.parse(init.body) })
      assert.equal(init.headers.Authorization, 'Bearer packed-web-fixture')
      return new Response(JSON.stringify(String(input).endsWith('/search')
        ? { results: [{ title: 'Packed source', url: 'https://example.com/source', snippet: 'Packed snippet', summary: 'Packed summary', content: '' }] }
        : { title: 'Packed page', content: 'Packed untrusted content' }))
    } })
    const searched = await web.search({ query: 'packed public query', count: 1 })
    const fetched = await web.fetch({ url: 'https://example.com/source' })
    assert.equal(searched.results[0].url, 'https://example.com/source'); assert.equal(searched.provenance.untrusted, true)
    assert.equal(fetched.requestedUrl, 'https://example.com/source'); assert.equal(fetched.contentMarkdown, 'Packed untrusted content')
    assert.deepEqual(sends.map(row => String(row.input)), ['https://api.deepseek.com/v1/tools/search', 'https://api.deepseek.com/v1/tools/fetch'])
    assert.equal(intents.length, 2); assert.equal(intents[0].request.query, 'packed public query'); assert(Object.isFrozen(intents[0]))
    const error = new module.WebProviderError('deepseek', 'preflight', 'Packed veto')
    assert.equal(error.requestState, 'not_started')
  }

} finally { await mcp.close(); await rm(directory, { recursive: true, force: true }) }
`)
  run(process.execPath, [...nodeGuard, join(installed, 'consumer.mjs')], temporary)
  await writeFile(join(installed, 'consumer.ts'), `
import { CliHost, FileSessionStore, FileMemoryStore, FileSkillStore, InstalledSkillStore, ReadOnlyWorkspace, TrustedCommandWorkspace, createWorkspaceExtension, WORKSPACE_LIMITS, TerminalIO, newSession, createBuiltinToolset, aggregateUsage, formatUsage, FileImageAssets, ProjectInstructions, type CliImageAssets, type InstructionSnapshot, type CommandApprovalContext, type PreparedCommand, type CliMemoryStore, type CliSkillStore, type SkillSaveReceipt, type MemoryChangeRequest, type ChatIO, type CliHostOptions, type CliSession, type CliQuestionHost,
  type SessionPersistence, type ApprovalRequest, type TaskMode, type ConversationMode, McpConfigStore, McpManager, createMcpExtension, type McpCatalogSnapshot, type McpPreparedOperation, type McpOutcomeStore, FileMcpOutcomeStore, type McpInvocationLifecycle, FileCliConversationStore, type CliConversationStore, type CliConversationView, createCliToolPresentation, cliToolPresentationView, type CliToolEvidence, type CliToolDecision } from '@ayayaq/vivi-cli'
import type { AgentEvent, AgentResult, ModelProvider, ToolImageReference } from '@ayayaq/vivi'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createDeepSeekProvider, projectDeepSeekHistory } from '@ayayaq/vivi/providers/deepseek'
import { createDeepSeekWebProvider } from '@ayayaq/vivi/web/deepseek'
import { WebProviderError, type WebProvider, type WebRequestIntent } from '@ayayaq/vivi/web'
import type { CliWebConfiguration } from '@ayayaq/vivi-cli'
import type { ToolExtension } from '@ayayaq/vivi/extensions'
import { createQuestionExtension, QUESTION_LIMITS, type Question, type QuestionOption, type QuestionRequest, type QuestionHost, type QuestionResponse, type QuestionAnswer, type QuestionAnswerEntry } from '@ayayaq/vivi/extensions/questions'
import { parseSkillDocument, type SkillCatalog } from '@ayayaq/vivi/extensions/skills'
import { normalizeModelCapabilities, reasoningSelectionSupport, type ModelCapabilities, type Capability } from '@ayayaq/vivi/providers/models'
const capabilities: ModelCapabilities = normalizeModelCapabilities({ apiVersion: 1, provider: 'openai', protocol: 'responses', model: { id: 'gpt-5.1' } })
const selection: Capability = reasoningSelectionSupport(capabilities, { mode: 'disabled' })
const provider: ModelProvider = createOpenAIProvider({ model: 'fake', apiKey: 'fake' })
const deepseekProvider: ModelProvider = createDeepSeekProvider({ model: 'deepseek-flash', apiKey: 'fake' })
const webProvider: WebProvider = createDeepSeekWebProvider({ apiKey: 'fake', beforeRequest(intent: WebRequestIntent) { void intent } })
const webConfiguration: CliWebConfiguration = { provider: 'deepseek', revision: 'types-only', apiKey: () => 'fake' }
const deepseekSession: CliSession = newSession({ provider: 'deepseek', model: 'deepseek-flash' })
const nativeProjection = projectDeepSeekHistory(deepseekSession.history, deepseekSession.model, { tools: true })
const webError: WebProviderError = new WebProviderError('deepseek', 'preflight', 'Types only')
void deepseekProvider; void webProvider; void webConfiguration; void nativeProjection; void webError
const session: CliSession = newSession({ provider: 'openai', model: 'fake' })
session.usage = { inputTokens: 3, outputTokens: 2, totalTokens: 7, cachedInputTokens: 0, cacheWriteInputTokens: 0 }
const usageText: string = formatUsage(aggregateUsage([session.usage, undefined]))
const store: SessionPersistence = new FileSessionStore('/tmp/fake-types-only')
const conversationStore: CliConversationStore = new FileCliConversationStore('/tmp/fake-types-only')
const conversationView: CliConversationView = { state: 'shadow', observedSequence: 0, committedSequence: 0, durability: 'memory' }
void conversationStore; void conversationView
const memory: CliMemoryStore = new FileMemoryStore('/tmp/fake-types-only')
const skills: CliSkillStore = new FileSkillStore('/tmp/fake-types-only/agent-skills', { readOnlyRoots: [], secrets: [] })
const catalog: Promise<SkillCatalog> = skills.snapshot()
const writable: boolean = skills.writable
const legacyWritable: false = new FileSkillStore('/tmp/fake-types-only/agent-skills').writable
const installedSkills = new InstalledSkillStore('/tmp/fake-types-only')
const installedWritable: true = installedSkills.writable
const typedDocument = parseSkillDocument('---\\nname: types-only\\ndescription: Type fixture\\n---\\nType fixture')
const installedCommit: Promise<SkillSaveReceipt> = installedSkills.commit({ name: 'types-only', before: null, expectedRevision: null, after: typedDocument }, { signal: new AbortController().signal })
void catalog; void writable; void legacyWritable; void installedWritable; void installedCommit
const change: MemoryChangeRequest = { kind: 'create', content: 'Type fixture' }
void memory; void change
const workspace: Promise<ReadOnlyWorkspace> = ReadOnlyWorkspace.open('/tmp/fake-types-only')
void workspace; void createWorkspaceExtension; void WORKSPACE_LIMITS
const imageAssets: CliImageAssets = new FileImageAssets('/tmp/fake-types-only', session.id)
const snapshot: Promise<ToolImageReference> = imageAssets.snapshot(new Uint8Array(), new AbortController().signal)
const instructionSource: ProjectInstructions = new ProjectInstructions()
const instructionSnapshot: Promise<InstructionSnapshot> = instructionSource.refresh(new AbortController().signal)
void snapshot; void instructionSnapshot
const commandWorkspace: Promise<TrustedCommandWorkspace> = TrustedCommandWorkspace.open('/tmp/fake-types-only', {})
const commandContext: CommandApprovalContext = { launchId: 'types', sessionId: 'types', runId: 'types', accountRevision: 'types',
  canApprove: () => false, isCurrent: () => false, approve: async () => false }
let preparedCommand: PreparedCommand | undefined
void commandWorkspace; void commandContext; void preparedCommand
const extension: ToolExtension = { id: 'typed-fixture', apiVersion: 1, tools: [] }
const mcp: McpManager = new McpManager({ store: new McpConfigStore('/tmp/fake-types-only'), env: {} })
const catalogs: Promise<readonly McpCatalogSnapshot[]> = mcp.captureCatalogs(new AbortController().signal)
let operation: McpPreparedOperation | undefined
void catalogs; void operation; void createMcpExtension
const outcomes: McpOutcomeStore = new FileMcpOutcomeStore('/tmp/fake-types-only')
let lifecycle: McpInvocationLifecycle | undefined
void lifecycle
const questionOption: QuestionOption = { id: 'short', label: 'Short', description: 'Concise' }
const question: Question = { id: 'style', header: 'Style', question: 'Which style?', options: [questionOption, { id: 'long', label: 'Long' }] }
const questionRequest: QuestionRequest = { requestId: 'typed-request', callId: 'typed-call', questions: [question] }
const questionAnswer: QuestionAnswer = { kind: 'text', text: 'Typed Unicode 你好' }
const questionEntry: QuestionAnswerEntry = { id: question.id, answer: questionAnswer }
const questionResponse: QuestionResponse = { requestId: questionRequest.requestId, status: 'answered', answers: [questionEntry] }
const questionHost: QuestionHost = async (request, { signal }): Promise<QuestionResponse> => signal.aborted
  ? { requestId: request.requestId, status: 'cancelled' } : { ...questionResponse, requestId: request.requestId }
const cliQuestionHost: CliQuestionHost = { ask: questionHost, isAvailable: () => true, accountRevision: () => 'typed-account' }
const questionExtension: ToolExtension = createQuestionExtension({ ask: questionHost })
const questionLimit: number = QUESTION_LIMITS.questions
// @ts-expect-error A question response cannot grant action authority.
const questionApproval: QuestionResponse = { requestId: 'typed', status: 'cancelled', approved: true }
void questionApproval; void questionExtension; void questionLimit
const options: CliHostOptions = { provider, session, store, questionHost: cliQuestionHost, mcp, mcpOutcomes: outcomes, skills, enableSkills: true, extensions: [extension], onEvent(event: AgentEvent) { void event },
  async approve(request: ApprovalRequest, signal: AbortSignal) { void request; return !signal.aborted } }
const host = new CliHost(options)
const taskMode: TaskMode = host.taskMode
const conversationMode: ConversationMode = 'plan'
host.setTaskMode(taskMode)
const result: Promise<AgentResult> = host.send('Types only')
const io: ChatIO = new TerminalIO({ tui: false })
io.setTaskMode?.(taskMode)
const canAskQuestions: boolean | undefined = io.canAskQuestions
const askQuestions: Promise<QuestionResponse> | undefined = io.askQuestions?.(questionRequest, new AbortController().signal)
void canAskQuestions; void askQuestions
void conversationMode
const toolEvidence: CliToolEvidence = host.toolPresentationEvidence
let toolDecision: CliToolDecision | undefined
io.setToolEvidence?.(toolEvidence)
const presentationView = cliToolPresentationView(JSON.stringify(createCliToolPresentation({ call: { id: 'typed', name: 'offline', arguments: {} },
  source: { reference: 'owned://type-fixture' }, status: 'unknown', effect: 'unreported' })))
void presentationView; void toolDecision
void result; void io; void usageText; void selection; void createBuiltinToolset(false, [extension])
`)
  const typeRoots = join(root, 'node_modules/@types')
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--module', 'NodeNext',
    '--target', 'ES2022', '--lib', 'ES2022,DOM', '--types', 'node', '--typeRoots', typeRoots, join(installed, 'consumer.ts')], temporary)
  if (process.env.VIVI_TEST_BUN) {
    run(process.env.VIVI_TEST_BUN, [join(installed, 'consumer.mjs')], temporary)
    await writeFile(join(installed, 'tui-consumer.ts'), `
import assert from 'node:assert/strict'
import { createTestRenderer } from '@opentui/core/testing'
import { CodeRenderable, TextRenderable } from '@opentui/core'
import { OpenTuiIO } from './dist/tui.js'
import { WindowsInputDecoder } from './dist/windows-input.js'
import { newSession } from './dist/session.js'
const setup = await createTestRenderer({ width: 80, height: 24 })
const io = new OpenTuiIO(setup.renderer, { stream: true })
try {
  const session = newSession({ provider: 'openai', model: 'packed-headless-model' })
  session.usage = { inputTokens: 3, outputTokens: 2, totalTokens: 7, cachedInputTokens: 0 }
  session.history = [{ kind: 'assistant', content: '## Packed heading' + String.fromCharCode(10, 10) + 'Packed Markdown works', toolCalls: [] }]
  io.setSession(session)
  io.setContext({ inputTokens: 63000, estimated: true, contextWindow: 128000, outputReserveTokens: 4096 })
  const reading = io.readLine('Message')
  await setup.renderOnce()
  assert(setup.captureCharFrame().includes('packed-headless-model'))
  assert(setup.captureCharFrame().includes('Context ~63k/128k'))
  assert(!setup.captureCharFrame().includes('7 total'))
  const codeNodes = node => [...(node instanceof CodeRenderable ? [node] : []), ...node.getChildren().flatMap(codeNodes)]
  const blocks = codeNodes(setup.renderer.root)
  assert(blocks.length > 0)
  await Promise.all(blocks.map(block => block.highlightingDone))
  await setup.renderOnce()
  assert(setup.captureCharFrame().includes('Packed Markdown works'))
  assert(!setup.captureCharFrame().includes('## Packed heading'))
  await setup.mockInput.typeText('Packed input')
  const windowsInput = new WindowsInputDecoder()
  await setup.mockInput.pressKeys([windowsInput.write(String.fromCharCode(27) + '[13;28;13;1;16;1_')])
  await setup.mockInput.typeText('second')
  setup.mockInput.pressKey('j', { ctrl: true })
  await setup.mockInput.typeText('third')
  setup.mockInput.pressEnter()
  assert.equal(await reading, 'Packed input\\nsecond\\nthird')
  const models = Array.from({ length: 1500 }, (_, index) => ({ name: 'vendor/model-' + index,
    searchTerms: ['Packed Provider'], value: 'vendor/model-' + index }))
  const selecting = io.chooseSearchable('Packed models', models, { refresh: true })
  await setup.mockInput.typeText('PROVIDER model 1499')
  setup.mockInput.pressEnter()
  assert.deepEqual(await selecting, { kind: 'selected', value: 'vendor/model-1499', query: 'PROVIDER model 1499' })
  io.toolPresentation(JSON.stringify({ version: 1, callId: 'packed-card', name: 'offline_tool', status: 'failed', effect: 'unknown',
    source: { reference: 'owned://packed/presentation', revision: 'packed-1' }, arguments: { kind: 'text', text: 'review arguments' },
    result: { kind: 'future-card', text: 'Packed safe fallback', data: { approved: true, execute: 'NEVER_EXECUTE' } } }))
  const allText = node => [node instanceof TextRenderable ? node.plainText : '', ...node.getChildren().map(allText)].join(String.fromCharCode(10))
  await setup.renderOnce(); await setup.renderOnce()
  const collapsed = allText(setup.renderer.root.findDescendantById('vivi-transcript'))
  assert(collapsed.includes('failed/unknown'))
  assert(!collapsed.includes('owned://packed/presentation')); assert(!collapsed.includes('review arguments'))
  assert.equal(setup.renderer.root.findDescendantById('vivi-tool-body-display-0').getChildren().length, 0)
  setup.mockInput.pressKey('o', { ctrl: true }); await setup.renderOnce(); await setup.renderOnce()
  const card = allText(setup.renderer.root.findDescendantById('vivi-transcript'))
  assert(card.includes('Tool failed')); assert(card.includes('External effects are unknown'))
  assert(card.includes('owned://packed/presentation')); assert(card.includes('unsupported presentation kind'))
  assert(card.includes('Packed safe fallback')); assert(!card.includes('NEVER_EXECUTE'))
  const toolHeader = setup.renderer.root.findDescendantById('vivi-tool-details-display-0')
  await setup.mockMouse.click(toolHeader.x + toolHeader.width - 1, toolHeader.y)
  await setup.renderOnce(); await setup.renderOnce()
  assert.equal(setup.renderer.root.findDescendantById('vivi-tool-body-display-0').getChildren().length, 0)
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
  assert.equal(io.canAskQuestions, Boolean(process.stdin.isTTY && process.stdout.isTTY))
  const nativeRequest = { requestId: 'packed-native-question', callId: 'packed-native-call', questions: [
    { id: 'style', header: 'Style', question: 'Which native style?', options: [{ id: 'short', label: 'Short' }, { id: 'long', label: 'Long' }] }
  ] }
  let globalCancels = 0
  const stopCancel = io.onCancel(() => { globalCancels++ })
  const nativeAnswer = io.askQuestions(nativeRequest, new AbortController().signal)
  const queuedApproval = io.approve({ call: { id: 'packed-after-question', name: 'note_set', arguments: {} },
    description: 'Owned packed approval after question', currentRevision: 0 }, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 2)); await setup.renderOnce(); await setup.renderOnce()
  assert(setup.renderer.root.findDescendantById('vivi-questions'))
  assert.equal(setup.renderer.root.findDescendantById('vivi-approve'), undefined)
  // The preceding mouse approval deliberately disarms new dialog mouse actions
  // for 600ms, so the next independent human gesture must occur after that guard.
  await new Promise(resolve => setTimeout(resolve, 650))
  const long = setup.renderer.root.findDescendantById('vivi-question-option-1')
  await setup.mockMouse.click(long.x + 1, long.y)
  await setup.renderOnce(); await setup.renderOnce()
  const submit = setup.renderer.root.findDescendantById('vivi-question-submit')
  await setup.mockMouse.click(submit.x + 1, submit.y)
  assert.deepEqual(await nativeAnswer, { requestId: nativeRequest.requestId, status: 'answered',
    answers: [{ id: 'style', answer: { kind: 'option', optionId: 'long' } }] })
  await new Promise(resolve => setTimeout(resolve, 2)); await setup.renderOnce(); await setup.renderOnce()
  assert(setup.renderer.root.findDescendantById('vivi-approve'))
  setup.mockInput.pressEnter(); assert.equal(await queuedApproval, false)
  const cancelling = io.askQuestions({ ...nativeRequest, requestId: 'packed-native-cancel' }, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 2)); await setup.renderOnce(); await setup.renderOnce()
  setup.mockInput.pressEscape()
  assert.deepEqual(await cancelling, { requestId: 'packed-native-cancel', status: 'cancelled' })
  assert.equal(globalCancels, 0); stopCancel()
  io.close()
} finally { io.close(); setup.renderer.destroy() }
`)
    run(process.env.VIVI_TEST_BUN, [join(installed, 'tui-consumer.ts')], temporary)
    assert.match(run(process.env.VIVI_TEST_BUN, [launcher, '--help'], temporary), /--provider/)
    console.log('Packed native renderer, model search, human questions/approval FIFO, mouse approvals and Bun CLI entrypoint passed')
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
