// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const temporary = await mkdtemp(join(tmpdir(), 'vivi-cli-consumer-'))
const cache = process.env.VIVI_TEST_NPM_CACHE ?? join(tmpdir(), 'vivi-npm-cache')
const vendorName = 'ayayaq-vivi-0.2.0-dev.0.tgz'
const provenanceName = 'ayayaq-vivi-0.2.0-dev.0.provenance.json'

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' } })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

try {
  const provenance = JSON.parse(await readFile(join(root, 'vendor', provenanceName), 'utf8'))
  const vendorBytes = await readFile(join(root, 'vendor', vendorName))
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  assert.equal(createHash('sha256').update(vendorBytes).digest('hex'), provenance.sha256, 'Vendor archive provenance mismatch')
  assert.equal(lock.packages['node_modules/@ayayaq/vivi'].integrity, provenance.integrity, 'Vendor lock integrity mismatch')
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temporary, '--cache', cache]))
  const paths = new Set(packed.files.map((file) => file.path))
  for (const path of ['LICENSE', 'NOTICE', 'README.md', 'RELEASING.md', 'package.json', 'tsconfig.json',
    `vendor/${vendorName}`, `vendor/${provenanceName}`, 'src/main.ts', 'src/index.ts', 'src/host.ts', 'src/session.ts',
    'src/tools.ts', 'src/terminal.ts', 'dist/main.js', 'dist/index.js', 'dist/index.d.ts',
    'dist/host.d.ts', 'dist/session.d.ts', 'dist/terminal.d.ts']) assert(paths.has(path), `Missing ${path}`)
  assert(!paths.has('src/run-agent.ts') && !paths.has('src/providers/openai.ts'), 'CLI must not copy core or provider implementations')
  assert([...paths].every((path) => !path.startsWith('test/') && !path.startsWith('dist/cjs/')))
  const tarball = join(temporary, packed.filename)
  await writeFile(join(temporary, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  // Installed artifact must resolve its vendored dependency without registry access or custom install scripts.
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, tarball], temporary)
  const installed = join(temporary, 'node_modules/@ayayaq/vivi-cli')
  const installedManifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  assert.equal(installedManifest.name, '@ayayaq/vivi-cli')
  assert.equal(installedManifest.version, manifest.version)
  assert.equal(installedManifest.private, true)
  assert.equal(installedManifest.license, 'Apache-2.0')
  assert.equal(installedManifest.dependencies['@ayayaq/vivi'], `file:vendor/${vendorName}`)
  assert.equal(packed.filename, `ayayaq-vivi-cli-${manifest.version}.tgz`)
  assert.deepEqual(await readFile(join(installed, 'LICENSE')), await readFile(join(root, 'LICENSE')))
  assert.deepEqual(await readFile(join(installed, 'vendor', vendorName)), await readFile(join(root, 'vendor', vendorName)))
  assert.match(run(process.execPath, [join(temporary, 'node_modules/.bin/vivi'), '--help'], temporary), /--provider/)
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
  run(process.execPath, [join(installed, 'consumer.mjs')], temporary)
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
  const bytes = await readFile(tarball)
  console.log(`Installed CLI bin, shared-provider runtime and TypeScript declarations passed (${packed.filename})`)
  console.log(`sha256 ${createHash('sha256').update(bytes).digest('hex')}`)
  console.log(`integrity ${packed.integrity}`)
} finally { await rm(temporary, { recursive: true, force: true }) }
