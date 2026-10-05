// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmInvocation, packageAcceptanceEvidence } from './platform-acceptance.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const temporary = await mkdtemp(join(tmpdir(), 'vivi-cli-consumer-'))
// This check prepares a fresh registry cache explicitly, then verifies an offline consumer.
// npm ci's tarball cache alone may not contain packuments needed to install an archive.
const cache = process.env.VIVI_TEST_NPM_CACHE ?? join(temporary, 'npm-cache')
const coreName = '@ayayaq/vivi'
const coreVersion = '0.2.1'
const coreIntegrity = 'sha512-iMuY7HbBfRljH9yTMS0unR98WctuNjYVUYrXOOuLYbwlscydW2TKwVKhw9ec6SVjtqFwjPQdn7tLkoYi4pUkmA=='
const corePath = 'node_modules/@ayayaq/vivi'

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' } })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

function runNpm(args, cwd = root) {
  const invocation = npmInvocation(args)
  return run(invocation.command, invocation.args, cwd)
}

const nodeGuard = ['--experimental-loader', new URL('./no-tui-loader.mjs', import.meta.url).href]

try {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  const installedLock = JSON.parse(await readFile(join(root, 'node_modules/.package-lock.json'), 'utf8'))
  const coreLock = lock.packages[corePath]
  assert.equal(manifest.dependencies[coreName], coreVersion, 'Shared core must use an exact registry version')
  assert.equal(lock.packages[''].dependencies[coreName], coreVersion, 'Root lock dependency mismatch')
  assert.equal(coreLock.version, coreVersion, 'Shared core lock version mismatch')
  const resolved = new URL(coreLock.resolved)
  assert.equal(resolved.protocol, 'https:', 'Shared core must resolve from the HTTPS npm registry')
  assert.equal(resolved.hostname, 'registry.npmjs.org', 'Shared core must resolve from the npm registry')
  assert.match(resolved.pathname, /^\/@ayayaq\/vivi\/-\/[^/]+\.tgz$/, 'Unexpected shared core registry artifact')
  assert.equal(coreLock.integrity, coreIntegrity, 'Shared core lock must match the reviewed 0.2.1 release bytes')
  for (const field of ['version', 'resolved', 'integrity']) {
    assert.equal(installedLock.packages[corePath][field], coreLock[field], `Installed shared core ${field} mismatch; run npm ci`)
  }
  const coreManifest = JSON.parse(await readFile(join(root, corePath, 'package.json'), 'utf8'))
  assert.equal(coreManifest.name, coreName)
  assert.equal(coreManifest.version, coreVersion)
  assert.equal(coreManifest.license, 'Apache-2.0')
  const [packed] = JSON.parse(runNpm(['pack', '--json', '--pack-destination', temporary, '--cache', cache]))
  const paths = new Set(packed.files.map((file) => file.path))
  for (const path of ['LICENSE', 'NOTICE', 'README.md', 'RELEASING.md', 'package.json', 'tsconfig.json',
    'scripts/platform-acceptance.mjs', 'scripts/no-tui-loader.mjs',
    'src/main.ts', 'src/index.ts', 'src/host.ts', 'src/session.ts',
    'src/models.ts', 'src/picker.ts', 'src/credentials.ts', 'dist/models.js', 'dist/picker.js', 'dist/picker.d.ts', 'dist/credentials.js',
    'src/tools.ts', 'src/terminal.ts', 'src/tui.ts', 'src/preferences.ts', 'src/application.ts', 'src/launcher.ts',
    'dist/tui.js', 'dist/preferences.js', 'dist/application.js', 'dist/launcher.js', 'dist/main.js', 'dist/index.js', 'dist/index.d.ts',
    'dist/host.d.ts', 'dist/session.d.ts', 'dist/terminal.d.ts']) assert(paths.has(path), `Missing ${path}`)
  for (const path of ['package.json', 'LICENSE', 'NOTICE', 'ATTRIBUTION.md',
    'src/index.ts', 'src/run-agent.ts', 'src/history.ts', 'src/providers/openai.ts',
    'src/providers/openrouter.ts', 'dist/index.js', 'dist/index.d.ts', 'dist/cjs/index.js']) {
    assert(paths.has(`${corePath}/${path}`), `Missing bundled shared core ${path}`)
  }
  assert.deepEqual(packed.bundled, [coreName], 'Shared core must remain bundled')
  assert([...paths].every((path) => !path.startsWith('vendor/')), 'Obsolete vendor snapshots must not be packed')
  assert(!paths.has('src/run-agent.ts') && !paths.has('src/providers/openai.ts'), 'CLI must not copy core or provider implementations')
  assert([...paths].every((path) => !path.startsWith('test/') && !path.startsWith('dist/cjs/')))
  const tarball = join(temporary, packed.filename)
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
  assert.equal(installedManifest.license, 'Apache-2.0')
  assert.equal(installedManifest.dependencies[coreName], coreVersion)
  assert.equal(packed.filename, `ayayaq-vivi-cli-${manifest.version}.tgz`)
  assert.deepEqual(await readFile(join(installed, 'LICENSE')), await readFile(join(root, 'LICENSE')))
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
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CliHost, FileSessionStore, calculate, builtinTools } from '@ayayaq/vivi-cli'
import { validateHistory, closeInterruptedHistory } from '@ayayaq/vivi'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter'
globalThis.fetch = async () => { throw new Error('Live networking is forbidden in the acceptance consumer') }
assert.equal(calculate('3 * (4 + 2)'), 18)
assert.deepEqual(builtinTools().map(tool => tool.name), ['calculate', 'current_time'])
const directory = await mkdtemp(join(tmpdir(), 'vivi-cli-packed-runtime-'))
try {
  const host = await CliHost.create({ store: new FileSessionStore(directory),
    settings: { provider: 'openai', model: 'fake' },
    provider: { generate: async () => ({ content: 'Packed host works', toolCalls: [] }) } })
  const result = await host.send('Test the installed host')
  assert.equal(result.status, 'completed')
  validateHistory(result.history)
  assert.deepEqual(closeInterruptedHistory(result.history), result.history)
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
import { CliHost, FileSessionStore, TerminalIO, newSession, type ChatIO, type CliHostOptions, type CliSession,
  type SessionPersistence, type ApprovalRequest } from '@ayayaq/vivi-cli'
import type { AgentEvent, AgentResult, ModelProvider } from '@ayayaq/vivi'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
const provider: ModelProvider = createOpenAIProvider({ model: 'fake', apiKey: 'fake' })
const session: CliSession = newSession({ provider: 'openai', model: 'fake' })
const store: SessionPersistence = new FileSessionStore('/tmp/fake-types-only')
const options: CliHostOptions = { provider, session, store, onEvent(event: AgentEvent) { void event },
  async approve(request: ApprovalRequest, signal: AbortSignal) { void request; return !signal.aborted } }
const host = new CliHost(options)
const result: Promise<AgentResult> = host.send('Types only')
const io: ChatIO = new TerminalIO({ tui: false })
void result; void io
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
  session.history = [{ kind: 'assistant', content: '## Packed heading' + String.fromCharCode(10, 10) + 'Packed Markdown works', toolCalls: [] }]
  io.setSession(session)
  const reading = io.readLine('Message')
  await setup.renderOnce()
  assert(setup.captureCharFrame().includes('packed-headless-model'))
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
  io.close()
} finally { io.close(); setup.renderer.destroy() }
`)
    run(process.env.VIVI_TEST_BUN, [join(installed, 'tui-consumer.ts')], temporary)
    assert.match(run(process.env.VIVI_TEST_BUN, [launcher, '--help'], temporary), /--provider/)
    console.log('Packed native renderer, model search and Bun CLI entrypoint passed')
  }
  const bytes = await readFile(tarball)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (process.env.VIVI_TEST_ACCEPTANCE_REPORT) {
    const bun = process.env.VIVI_TEST_BUN ? run(process.env.VIVI_TEST_BUN, ['--version']).trim() : undefined
    await writeFile(process.env.VIVI_TEST_ACCEPTANCE_REPORT, JSON.stringify(packageAcceptanceEvidence({
      filename: packed.filename, sha256, integrity: packed.integrity, size: bytes.length,
      cliVersion: manifest.version, bun
    }), null, 2) + '\n')
  }
  console.log(`Installed CLI bin, shared-provider runtime and TypeScript declarations passed (${packed.filename})`)
  console.log(`sha256 ${sha256}`)
  console.log(`integrity ${packed.integrity}`)
} finally { await rm(temporary, { recursive: true, force: true }) }
