// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpConfigStore, prepareMcpLaunch, validateMcpServer } from '../dist/mcp-config.js'
import { McpManager } from '../dist/mcp-manager.js'
import { McpStdioTransport } from '../dist/mcp-transport.js'

const script = fileURLToPath(new URL('./fixtures/mcp-discovery-server.mjs', import.meta.url))
const executable = runtime => join(dirname(process.execPath), runtime + (process.platform === 'win32' ? '.exe' : ''))
const base = { id: 'docs', label: 'Installed fixture', executable: executable('node'), args: [script],
  cwd: tmpdir(), protocol: 'legacy', environment: [] }
const rejected = [
  ['node', ['-pe', '0']], ['node', ['-ep', '0']],
  ['python3', ['-Ic', 'pass']], ['python3', ['-cpass']], ['python3', ['-BScpass']],
  ['perl', ['-weprint 0']], ['perl', ['-E', '0']], ['perl', ['-0wpeprint 0']],
  ['ruby', ['-eputs 0']], ['ruby', ['-weputs 0']], ['ruby', ['-Ueputs 0']],
  ['bun', ['-pe', '0']], ['bun', ['-e0']], ['bun', ['-p0']],
  ['node', ['--import', 'data:text/javascript,0', script]],
  ['node', ['--import=DATA:text/javascript,0', script]],
  ['node', ['--entry-url', 'DaTa:text/javascript,0']],
  ['node', ['--entry-url=dAtA:text/javascript,0']],
  ...['node', 'python3', 'perl', 'ruby'].flatMap(runtime => ['--eval', '--eval=0', '--print', '--print=0', '-e', '-p', '-c']
    .map(flag => [runtime, [flag, '0']])),
  ...[[], [script], ['run', script], ['x', 'fixture-package'], ['exec', 'echo fixture'],
    ['--no-install', 'fixture-package'], ['--no-install', 'relative.js'], ['--no-install', join(tmpdir(), 'package.json')],
    ['--no-install', join(tmpdir(), 'fixture.sh')], ['--no-install', script, '--install=force'],
    ['--no-install', script, '--install', 'auto'], ['--no-install', script, '-i'],
    ['--no-install', script, '--no-install'], ['--no-install', script, '--shell=bun'],
    ['--no-install', script, '--import=DATA:text/javascript,0'], ['--no-install', script, '-e0']]
    .map(args => ['bun', args])
]

test('inline interpreter, data URL and Bun dispatcher shapes fail before approval or transport', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-contract-')), store = new McpConfigStore(directory)
  let approvals = 0, starts = 0
  const manager = new McpManager({ store, env: {}, transportFactory: () => { starts++; throw new Error('No rejected launch may start') } })
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }) })
  for (const [runtime, args] of rejected) {
    const server = { ...base, executable: executable(runtime), args, cwd: directory }
    assert.throws(() => validateMcpServer(server), /Invalid MCP/, `${runtime} ${JSON.stringify(args)}`)
    await assert.rejects(prepareMcpLaunch(server, 'fixture', {}), /Invalid MCP/)
    await assert.rejects(store.save([server], (await store.load()).revision), /Invalid MCP/)
    await writeFile(join(directory, 'mcp-servers.json'), JSON.stringify({ schemaVersion: 1, servers: [server] }), { mode: 0o600 })
    await assert.rejects(manager.connect('docs', async () => { approvals++; return true }, new AbortController().signal), /configuration is unavailable or invalid/)
    await rm(join(directory, 'mcp-servers.json'))
  }
  assert.equal(approvals, 0); assert.equal(starts, 0)
})

test('trusted installed scripts retain exact argv and ordinary interpreter option values', () => {
  for (const [runtime, args] of [['node', ['--trace-warnings', script, '--evaluation=fixture']],
    ['python3', ['-I', '-Wonce', script]], ['perl', ['-Iinstalled-module', script]], ['ruby', ['-Iinstalled-module', script]],
    ['bun', ['--no-install', script, 'run', 'ordinary-script-argument']]]) {
    const server = validateMcpServer({ ...base, executable: executable(runtime), args })
    assert.deepEqual(server.args, args); assert(Object.isFrozen(server.args))
  }
  // Node does not accept glued -eCODE; the supported combined inline switch is -pe, tested above.
  assert.deepEqual(validateMcpServer({ ...base, args: ['--eval-fixture', script] }).args, ['--eval-fixture', script])
})

const bun = process.versions.bun ? process.execPath : process.env.VIVI_TEST_BUN
test('Bun executable symlinks still require an installed script after canonical path resolution', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-bun-alias-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const target = join(directory, 'installed-bun-fixture'), alias = join(directory, 'bun')
  await writeFile(target, 'Owned inert executable fixture; never launched', { mode: 0o700 }); await symlink(target, alias)
  await assert.rejects(prepareMcpLaunch({ ...base, executable: alias, cwd: directory,
    args: ['--no-install', join(directory, 'missing.js')] }, 'fixture', {}), { code: 'ENOENT' })
})
test('Bun requires an existing installed script and preserves explicit no-install argv through fresh approval', { skip: !bun }, async t => {
  assert.match(basename(bun), /^bun(?:\.exe)?$/i)
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-bun-contract-')), store = new McpConfigStore(directory)
  let approvals = 0, starts = 0
  const manager = new McpManager({ store, env: {}, transportFactory: launch => { starts++; return new McpStdioTransport(launch) } })
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }) })
  const server = { ...base, executable: bun, cwd: directory,
    args: ['--no-install', script, 'normal', join(directory, 'log'), join(directory, 'pid')] }
  const folder = join(directory, 'directory.js'); await mkdir(folder)
  for (const target of [join(directory, 'missing.js'), folder]) {
    const invalid = { ...server, args: ['--no-install', target] }
    await manager.configure(invalid)
    await assert.rejects(manager.connect('docs', async () => { approvals++; return true }, new AbortController().signal))
    assert.equal(approvals, 0); assert.equal(starts, 0)
    await manager.remove('docs')
  }
  await manager.configure(server)
  const approve = async launch => { approvals++; assert.deepEqual(launch.server.args, server.args); return approvals > 1 }
  assert.equal(await manager.connect('docs', approve, new AbortController().signal), false)
  assert.equal(starts, 0)
  assert.equal(await manager.connect('docs', approve, new AbortController().signal), true)
  assert.equal(approvals, 2); assert.equal(starts, 1)
  assert.equal(manager.statuses()[0].snapshot.categories.tools.state, 'ready')
  const log = (await readFile(join(directory, 'log'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert(log.filter(entry => entry.method).every(entry => ['initialize', 'notifications/initialized', 'tools/list'].includes(entry.method)))
})
