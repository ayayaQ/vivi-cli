// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ciTestGroups } from '../scripts/ci-tests.mjs'

test('CI inventories every Node and Bun test with explicit Windows native ownership', async () => {
  const groups = await ciTestGroups()
  const names = await readdir(new URL('./', import.meta.url))
  const node = names.filter(name => name.endsWith('.test.mjs')).map(name => `./test/${name}`).sort()
  const tui = names.filter(name => name.endsWith('.test.ts')).map(name => `./test/${name}`).sort()
  assert.deepEqual(groups['linux-node'], node)
  assert.deepEqual(groups['bun-tui'], tui)
  const minimum = ['windows-mcp', 'windows-headless', 'windows-stock', 'windows-modern', 'manual-system-mode1', 'linux-only']
    .flatMap(group => groups[group])
  assert.equal(new Set(minimum).size, minimum.length, 'Each Windows minimum-Node test has exactly one owner')
  assert.deepEqual(minimum.sort(), node, 'New test files must never fall out of the coverage inventory')
  for (const group of Object.values(groups)) {
    assert(group.length > 0)
    assert.equal(new Set(group).size, group.length)
    for (const file of group) assert([...node, ...tui].includes(file), `CI names an absent file: ${file}`)
  }
})

test('current Windows and Bun retain native process boundaries and all OAuth/setup fixtures', async () => {
  const groups = await ciTestGroups()
  for (const name of ['mcp-windows-real', 'mcp-windows-node-env', 'command-windows-real', 'platform-acceptance']) {
    assert(groups['windows-current'].includes(`./test/${name}.test.mjs`))
  }
  for (const file of groups['linux-node'].filter(file => file.includes('mcp-oauth') || file.includes('mcp-setup-'))) {
    assert(groups['windows-mcp'].includes(file))
    assert(groups['windows-current'].includes(file))
    assert(groups['bun-boundaries'].includes(file))
  }
  if (groups['linux-node'].includes('./test/mcp-http.test.mjs')) {
    assert(groups['windows-mcp'].includes('./test/mcp-http.test.mjs'))
    assert(groups['bun-boundaries'].includes('./test/mcp-http.test.mjs'))
  }
})

test('pending HTTP and five OAuth files enter all required runtime groups without workflow edits', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-ci-inventory-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const names = await readdir(new URL('./', import.meta.url))
  const added = ['mcp-http', 'mcp-oauth', 'mcp-oauth-controls', 'application-mcp-oauth',
    'mcp-oauth-registration', 'mcp-oauth-registration-controls', 'mcp-setup-tools', 'mcp-setup-service',
    'mcp-setup-host', 'mcp-setup-connect-guards', 'mcp-setup-oauth-effects'].map(name => `${name}.test.mjs`)
  for (const name of new Set([...names.filter(name => /\.test\.(mjs|ts)$/.test(name)), ...added])) {
    await writeFile(join(directory, name), '')
  }
  const groups = await ciTestGroups(directory)
  for (const name of added) {
    const file = `./test/${name}`
    for (const group of ['linux-node', 'windows-mcp', 'bun-boundaries']) assert(groups[group].includes(file))
    if (name.includes('mcp-oauth') || name.startsWith('mcp-setup-')) assert(groups['windows-current'].includes(file))
    assert(!groups['windows-headless'].includes(file))
  }
})

test('CI runner rejects unknown groups and propagates failed test subprocesses', () => {
  const script = fileURLToPath(new URL('../scripts/ci-tests.mjs', import.meta.url))
  const locateNode = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' })
  assert.equal(locateNode.status, 0)
  const node = locateNode.stdout.trim()
  const unknown = spawnSync(node, [script, 'absent-group'], { encoding: 'utf8' })
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /Unknown CI test group/)
  // Node cannot run Bun's `test` command. Its real nonzero subprocess status must
  // escape the wrapper rather than becoming a successful empty/ignored gate.
  const failed = spawnSync(node, [script, 'bun-boundaries'], {
    env: { ...process.env, VIVI_TEST_BUN: node }, encoding: 'utf8'
  })
  assert.equal(failed.status, 1)
  assert.match(failed.stderr, /Cannot find module/)
})
