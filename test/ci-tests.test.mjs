// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { ciTestGroups } from '../scripts/ci-tests.mjs'

test('CI documentation inventories selector groups without stale file counts', async () => {
  const groups = await ciTestGroups()
  const docs = await readFile(new URL('../docs/CI.md', import.meta.url), 'utf8')
  const documented = [...docs.matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1])
  assert.deepEqual(documented.sort(), Object.keys(groups).sort())
  assert(!/^\| `[^`]+` \| \d+ \|/m.test(docs), 'Generate file counts from selectors')
  assert(docs.includes('node scripts/ci-tests.mjs --list'))
  assert(docs.includes('files.length'))
  assert(groups['linux-node'].includes('./test/platform-acceptance-synthetic.test.mjs'))
  assert(groups['windows-headless'].includes('./test/platform-acceptance-synthetic.test.mjs'))
  for (const group of ['windows-minimum', 'windows-current']) {
    assert(groups[group].includes('./test/ci-tests.test.mjs'), `${group}: workflow policy regression must run on Windows PRs`)
  }
})

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

test('PR smoke groups preserve runtime boundaries without repeating broad suites', async () => {
  const groups = await ciTestGroups()
  assert.deepEqual(groups['linux-current'], [
    'automation-main', 'automation-output', 'chatgpt-auth', 'chatgpt-integration', 'chatgpt-provider', 'command-process', 'installed-skills', 'launcher', 'mcp-http', 'mcp-lifecycle',
    'mcp-oauth-native', 'mcp-oauth-store', 'output-schema', 'platform-acceptance'
  ].map(name => `./test/${name}.test.mjs`))
  for (const name of ['automation-main', 'automation-output', 'output-schema']) {
    for (const group of ['linux-node', 'linux-current', 'windows-minimum', 'windows-current']) assert(groups[group].includes(`./test/${name}.test.mjs`))
  }
  for (const file of groups['windows-current']) assert(groups['windows-minimum'].includes(file))
  for (const name of ['mcp-http', 'mcp-integration', 'mcp-invocation', 'mcp-lifecycle',
    'mcp-transport', 'mcp-send-boundary', 'installed-skills', 'skills-store', 'memory-store',
    'credentials', 'workspace', 'workspace-edit', 'conpty-package']) {
    assert(groups['windows-minimum'].includes(`./test/${name}.test.mjs`))
  }
  const broadWindows = [...groups['windows-mcp'], ...groups['windows-headless']]
  for (const file of groups['windows-minimum']) assert(broadWindows.includes(file))
  assert(groups['windows-minimum'].length < broadWindows.length / 2)
  for (const file of broadWindows.filter(file => !groups['windows-minimum'].includes(file))) {
    assert(groups['linux-node'].includes(file), `Deferred Windows file lost baseline Node coverage: ${file}`)
  }
})

test('new OAuth/setup fixtures automatically retain minimum Windows PR coverage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-ci-minimum-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const names = await readdir(new URL('./', import.meta.url))
  const added = ['chatgpt-new.test.mjs', 'mcp-oauth-new.test.mjs', 'application-mcp-oauth-new.test.mjs', 'mcp-setup-new.test.mjs']
  for (const name of [...names.filter(name => /\.test\.(mjs|ts)$/.test(name)), ...added]) {
    await writeFile(join(directory, name), '')
  }
  const groups = await ciTestGroups(directory)
  for (const name of added) assert(groups['windows-minimum'].includes(`./test/${name}`))
})


test('every CI install first bootstraps supported npm and verifies the dependency policy', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const verify = source => {
    // Git may check out workflow text with CRLF on Windows.
    source = source.replace(/\r\n/g, '\n')
    const blocks = [...source.matchAll(/^  ([a-z][a-z0-9-]*):\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|$(?![\s\S]))/gm)]
    const installing = blocks.filter(([, , body]) => body.includes('      - run: npm ci --ignore-scripts\n'))
    assert.deepEqual(installing.map(([, name]) => name), [
      'check', 'candidate', 'mcp', 'headless', 'current-compatibility', 'bun', 'packaged-conpty'
    ])
    const required = [
      '      - name: Install policy-aware npm',
      '        run: node scripts/bootstrap-ci-npm.mjs',
      '      - name: Verify dependency resolution policy',
      '        run: node scripts/verify-dependency-policy.mjs npm',
      '      - run: npm ci --ignore-scripts', ''
    ].join('\n')
    for (const [, name, body] of installing) {
      assert(body.includes(required), `${name}: supported npm and policy fixture must precede npm ci`)
      assert.equal(body.match(/      - run: npm ci --ignore-scripts\n/g)?.length, 1)
      assert(!body.includes('continue-on-error:'), `${name}: dependency policy must be required`)
    }
    const bunJobs = blocks.filter(([, , body]) => body.includes('      - uses: oven-sh/setup-bun@v2\n'))
    assert.deepEqual(bunJobs.map(([, name]) => name), ['candidate', 'bun', 'packaged-conpty'])
    for (const [, name, body] of bunJobs) {
      assert(body.includes([
        '          bun-version: 1.4.2',
        '      - name: Verify Bun dependency resolution policy',
        '        run: node scripts/verify-dependency-policy.mjs bun', ''
      ].join('\n')), `${name}: pinned Bun setup must be followed by the policy fixture`)
      assert(body.indexOf('node scripts/verify-dependency-policy.mjs bun') < body.indexOf('npm ci --ignore-scripts'))
    }
  }
  const lf = workflow.replace(/\r\n/g, '\n')
  for (const eol of ['\n', '\r\n']) {
    const checkout = source => source.replace(/\n/g, eol)
    verify(checkout(lf))
    for (const [before, after] of [
      ['node scripts/bootstrap-ci-npm.mjs', 'echo skipped-bootstrap'],
      ['        run: node scripts/verify-dependency-policy.mjs npm\n', ''],
      ['      - name: Verify dependency resolution policy\n', '      - name: Verify dependency resolution policy\n        if: false\n'],
      ['        run: node scripts/verify-dependency-policy.mjs bun\n', '']
    ]) {
      assert(lf.includes(before), 'Mutation must change the workflow')
      assert.throws(() => verify(checkout(lf.replace(before, after))))
    }
  }
})
