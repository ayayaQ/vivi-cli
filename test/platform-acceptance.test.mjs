// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { npmInvocation, packageAcceptanceEvidence, supportsCliNode } from '../scripts/platform-acceptance.mjs'
import { resolve } from '../scripts/no-tui-loader.mjs'

const artifact = { filename: 'ayayaq-vivi-cli-0.1.0-dev.0.tgz', sha256: 'a'.repeat(64),
  integrity: 'sha512-Ynl0ZXM=', size: 1234, cliVersion: '0.1.0-dev.0', arch: 'x64', node: 'v26.4.0' }

test('CLI npm support starts at stable Node26.4 independently of the core requirement', () => {
  for (const version of ['26.4.0', 'v26.4.0', '26.10.0', '27.0.0']) assert.equal(supportsCliNode(version), true)
  for (const version of [undefined, '', 'invalid', '22.23.3', '24.19.0', '26.3.99',
    '26.4.0-rc.1', '26.4', '9999999999999999999999.4.0']) assert.equal(supportsCliNode(version), false)
})

test('npm runs through Node with no shell or .cmd shim on Windows', () => {
  const args = ['pack', '--json', 'C:\\Users\\A B\\archive.tgz']
  assert.deepEqual(npmInvocation(args, { npmPath: 'C:\\Program Files\\nodejs\\npm-cli.js',
    node: 'C:\\Program Files\\nodejs\\node.exe', platform: 'win32' }), {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Program Files\\nodejs\\npm-cli.js', ...args]
  })
  assert.deepEqual(args, ['pack', '--json', 'C:\\Users\\A B\\archive.tgz'])
  assert.throws(() => npmInvocation([], { npmPath: null, platform: 'win32' }), /through npm/)
  assert.deepEqual(npmInvocation(['pack'], { npmPath: null, platform: 'linux' }),
    { command: 'npm', args: ['pack'] })
})

test('observed headless evidence never marks real vault, TTY or platform acceptance passed', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const bun of [undefined, '1.4.2']) {
      const report = packageAcceptanceEvidence({ ...artifact, platform, bun,
        manual: { nativeVaultSaveLoad: 'passed' }, platformAcceptance: 'passed' })
      assert.equal(report.observed.platform, platform)
      assert.equal(report.automated.bunHeadlessRenderer, bun ? 'passed' : 'not-run')
      assert.ok(Object.values(report.manual).every(value => value === 'not-run'))
      assert.equal(report.platformAcceptance, 'pending-manual-validation')
      assert.equal(report.distributionDecision, 'windows-npm-selected')
      assert.deepEqual(report.releaseTarget, { platform: 'win32', arch: 'x64', distribution: 'npm',
        node: '>=26.4.0', bun: '>=1.3.0' })
      assert.equal(report.automated.strictNpmEngines, 'passed')
      assert.equal(Object.hasOwn(report.observed, 'bun'), Boolean(bun))
      assert.deepEqual(report.artifact, artifactWithoutRuntime())
    }
  }
})

function artifactWithoutRuntime() {
  const { arch, node, ...result } = artifact
  return result
}

test('invalid or path-bearing artifact identifiers cannot become evidence', () => {
  for (const override of [{ filename: '../artifact.tgz' }, { filename: 'C:\\artifact.tgz' },
    { sha256: 'wrong' }, { integrity: 'sha1-old' }, { size: 0 }, { size: 1.5 },
    { platform: 'freebsd' }, { cliVersion: '' }, { bun: 142 }, { node: 'v24.19.0' }]) {
    assert.throws(() => packageAcceptanceEvidence({ ...artifact, platform: 'win32', ...override }), /Invalid/)
  }
})

test('Node no-TUI loader blocks native routes before resolution and allows public host modules', async () => {
  let calls = 0
  const next = async value => { calls++; return { url: value } }
  for (const specifier of ['@opentui/core', '@opentui/core/testing', 'web-tree-sitter',
    'web-tree-sitter/subpath', './tui.js', 'file:///C:/package/dist/tui.js', './tui.js?cache=1']) {
    await assert.rejects(resolve(specifier, {}, next), /native TUI/)
  }
  assert.equal(calls, 0)
  for (const specifier of ['node:fs/promises', './terminal.js', '@ayayaq/vivi-cli', './host.js']) {
    assert.deepEqual(await resolve(specifier, {}, next), { url: specifier })
  }
  assert.equal(calls, 4)
  await assert.rejects(resolve('alias', {}, async () => ({ url: 'file:///package/node_modules/@opentui/core/index.js' })), /native TUI/)
})
