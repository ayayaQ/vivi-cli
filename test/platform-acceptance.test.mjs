// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { manualStageChecks, manualStageEvidence, npmInvocation, packageAcceptanceEvidence,
  supportsCliNode, syntheticAcceptanceEvidence, syntheticChecks, targetPreflight } from '../scripts/platform-acceptance.mjs'
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

const binding = { candidateSha: 'b'.repeat(40), artifactSha256: 'c'.repeat(64),
  artifactKind: 'synthetic-fixture', platform: 'win32', arch: 'x64', node: 'v26.10.0' }
const generatedAt = '2026-11-01T00:00:00.000Z'
const checks = () => Object.fromEntries(syntheticChecks.map(name => [name, true]))
const evidence = (override = {}) => syntheticAcceptanceEvidence({ binding, generatedAt, checks: checks(), ...override })

test('synthetic report binds exact source/runtime/stage while all live stages remain not_run', () => {
  const report = evidence()
  assert.equal(report.schemaVersion, 2)
  assert.equal(report.kind, 'synthetic-platform-acceptance')
  assert.deepEqual(report.binding, binding)
  assert.equal(report.stage, 'synthetic-helper-store-report')
  assert.equal(report.syntheticResult, 'passed')
  assert.equal(report.platformAcceptance, 'pending_manual_validation')
  assert.equal(report.authSuccessIsInferenceSuccess, false)
  assert.equal(report.apiKeyBillingFallback, false)
  assert.deepEqual(Object.keys(report.manual), Object.keys(manualStageChecks))
  assert(Object.values(report.manual).every(stage => stage.status === 'not_run'))
  for (const name of syntheticChecks) {
    const result = evidence({ checks: { ...checks(), [name]: false } })
    assert.equal(result.syntheticResult, 'failed'); assert.equal(result.checks[name], 'failed')
  }
})

test('report rejects missing checks, incomplete outcomes and arbitrary secret-bearing fields', () => {
  const incomplete = checks(); delete incomplete.chatgptEnvelope
  for (const override of [
    { checks: incomplete }, { checks: { ...checks(), chatgptEnvelope: 'passed' } },
    { checks: { ...checks(), accessToken: 'secret-fixture' } }, { generatedAt: 'yesterday' },
    { generatedAt: '2026-02-30T00:00:00.000Z' }, { generatedAt: '2026-11-01T00:00:00Z' },
    { binding: { ...binding, node: 'v24.14.0' } }, { binding: { ...binding, platform: 'mac' } },
    { binding: { ...binding, candidateSha: 'HEAD' } }, { binding: { ...binding, artifactSha256: 'abc' } },
    { binding: { ...binding, artifactKind: 'native' } }, { binding: { ...binding, arch: '' } },
    { binding: { ...binding, email: 'secret-fixture' } }, { manual: { chatgptInference: 'passed' } },
    { rawOutput: 'secret-fixture' }, { stage: 'live' }
  ]) assert.throws(() => evidence(override), error => error.message === 'Invalid acceptance evidence')
})

test('metadata-only preflight fails closed without ever reading existing values', async () => {
  const targets = ['openai', 'openrouter', 'deepseek', 'deepseek-web', `mcp-oauth-key-v1-${'a'.repeat(64)}`]
  let reads = 0
  for (const state of ['absent', 'occupied', 'uncertain', undefined, { value: 'never-copy' }]) {
    const observed = []
    const result = await targetPreflight(targets, { available: async () => true,
      presence: async target => { observed.push(target); return state }, load: () => { reads++; throw Error('forbidden') } })
    assert.equal(result.status, state === 'absent' ? 'eligible' : 'blocked')
    assert(!JSON.stringify(result).includes('never-copy'))
    assert(observed.includes('openai'))
  }
  assert.equal(reads, 0)
  for (const available of [false, undefined, 'yes']) {
    assert.deepEqual(await targetPreflight(targets, { available: async () => available,
      presence: () => assert.fail('unavailable helper must not be queried') }), { status: 'blocked', reason: 'helper_unavailable' })
  }
  assert.deepEqual(await targetPreflight(targets, { available: async () => { throw Error('secret-fixture') } }),
    { status: 'blocked', reason: 'uncertain' })
  for (const bad of [[], ['openai', 'openai'], ['chatgpt'], ['unknown'], ['openai\n']]) {
    await assert.rejects(targetPreflight(bad, {}), /Invalid acceptance evidence/)
  }
  const mixed = await targetPreflight(targets, { available: async () => true,
    presence: async target => target === 'deepseek' ? 'occupied' : 'absent' })
  assert.deepEqual(mixed, { status: 'blocked', reason: 'occupied' })
})

const canonical = { ...binding, artifactKind: 'canonical-package' }
const receiptFor = stage => ({ binding: canonical, stage, completedAt: generatedAt,
  checks: [...manualStageChecks[stage]], receiptSha256: 'd'.repeat(64) })

test('manual stage assertions require exact canonical receipt binding and complete stage checks', () => {
  for (const stage of Object.keys(manualStageChecks)) {
    const receipt = receiptFor(stage)
    assert.equal(manualStageEvidence(canonical, stage, { status: 'passed', receipt }).status, 'passed')
    assert.equal(manualStageEvidence(canonical, stage, { status: 'failed', receipt: { ...receipt, checks: [] } }).status, 'failed')
    assert.deepEqual(manualStageEvidence(binding, stage, { status: 'not_run' }), { status: 'not_run' })
    assert.deepEqual(manualStageEvidence(binding, stage, { status: 'blocked', reason: 'interactive_required' }),
      { status: 'blocked', reason: 'interactive_required' })
    assert.throws(() => manualStageEvidence(binding, stage, { status: 'passed', receipt }), /Invalid/)
    for (const changed of [
      { stage: 'wrong' }, { completedAt: '' }, { checks: receipt.checks.slice(1) },
      { checks: [...receipt.checks, 'apiKeyBillingFallback'] }, { receiptSha256: '' }, { accessToken: 'secret-fixture' },
      ...Object.keys(canonical).map(key => ({ binding: { ...canonical, [key]: key === 'platform' ? 'darwin' : 'wrong' } }))
    ]) assert.throws(() => manualStageEvidence(canonical, stage, { status: 'passed', receipt: { ...receipt, ...changed } }), /Invalid/)
  }
  assert.throws(() => manualStageEvidence(canonical, 'unknown', { status: 'passed' }), /Invalid/)
  assert.throws(() => manualStageEvidence(canonical, 'chatgptInference', { status: 'passed' }), /Invalid/)
  assert.throws(() => manualStageEvidence(canonical, 'chatgptInference', { status: 'blocked', reason: 'secret-fixture' }), /Invalid/)
  assert.throws(() => manualStageEvidence(canonical, 'chatgptInference', { status: 'not_run', token: 'secret-fixture' }), /Invalid/)
  const mac = { ...canonical, platform: 'darwin' }
  assert.throws(() => manualStageEvidence(mac, 'windowsPhysicalKeys', { status: 'passed',
    receipt: { ...receiptFor('windowsPhysicalKeys'), binding: mac } }), /Invalid/)
})

test('deleted receipt check elements never satisfy manual stage completion', () => {
  for (const stage of Object.keys(manualStageChecks)) {
    const receipt = receiptFor(stage)
    assert.deepEqual(manualStageEvidence(canonical, stage, { status: 'passed', receipt }), { status: 'passed', receipt })
    for (let index = 0; index < receipt.checks.length; index++) {
      const sparse = [...receipt.checks]; delete sparse[index]
      for (const status of ['passed', 'failed']) {
        assert.throws(() => manualStageEvidence(canonical, stage, { status,
          receipt: { ...receipt, checks: sparse } }), /Invalid acceptance evidence/)
      }
    }
    for (const incomplete of [receipt.checks.slice(1), [...receipt.checks.slice(1), undefined],
      [...receipt.checks.slice(1), ''], [...receipt.checks.slice(1), receipt.checks[1]]]) {
      assert.throws(() => manualStageEvidence(canonical, stage, { status: 'passed',
        receipt: { ...receipt, checks: incomplete } }), /Invalid acceptance evidence/)
    }
    assert.equal(manualStageEvidence(canonical, stage, { status: 'failed', receipt: { ...receipt, checks: [] } }).status, 'failed')
  }
})

test('sparse target lists reject before fake metadata is queried', async () => {
  let metadataCalls = 0
  const metadata = { available: async () => { metadataCalls++; return true },
    presence: async () => { metadataCalls++; return 'absent' } }
  const sparse = ['openai', 'openrouter']; delete sparse[0]
  for (const targets of [sparse, new Array(1), [undefined], [''], ['openai', 'openai']]) {
    await assert.rejects(targetPreflight(targets, metadata), /Invalid acceptance evidence/)
  }
  assert.equal(metadataCalls, 0)
  assert.deepEqual(await targetPreflight(['openai', 'openrouter'], metadata), { status: 'eligible', reason: 'all_absent' })
  assert.equal(metadataCalls, 3)
})

const malformedHashes = value => [
  [value], { toString: () => value, accessToken: 'A8_REVIEW_FAKE_MARKER' }, new String(value)
]

test('synthetic and manual binding hashes require primitive strings without nested marker propagation', () => {
  for (const key of ['candidateSha', 'artifactSha256']) {
    for (const value of malformedHashes(binding[key])) {
      const malformed = { ...binding, [key]: value }
      assert.throws(() => evidence({ binding: malformed }), /Invalid acceptance evidence/)
      const malformedCanonical = { ...canonical, [key]: value }
      for (const status of ['not_run', 'blocked', 'passed', 'failed']) {
        const input = status === 'not_run' ? { status } : status === 'blocked'
          ? { status, reason: 'interactive_required' } : { status, receipt: receiptFor('chatgptInference') }
        assert.throws(() => manualStageEvidence(malformedCanonical, 'chatgptInference', input), /Invalid acceptance evidence/)
      }
      for (const status of ['passed', 'failed']) {
        assert.throws(() => manualStageEvidence(canonical, 'chatgptInference', { status,
          receipt: { ...receiptFor('chatgptInference'), binding: malformedCanonical } }), /Invalid acceptance evidence/)
      }
    }
  }
  const report = evidence()
  assert.deepEqual(report.binding, binding)
  assert(Object.values(report.binding).every(value => typeof value === 'string'))
  assert(!JSON.stringify(report).includes('A8_REVIEW_FAKE_MARKER'))
})

test('manual receipt hashes require primitive strings and preserve legitimate evidence', () => {
  const receipt = receiptFor('chatgptInference')
  for (const receiptSha256 of malformedHashes(receipt.receiptSha256)) {
    for (const status of ['passed', 'failed']) {
      assert.throws(() => manualStageEvidence(canonical, 'chatgptInference', { status,
        receipt: { ...receipt, receiptSha256 } }), /Invalid acceptance evidence/)
    }
  }
  const valid = { status: 'passed', receipt }
  const result = manualStageEvidence(canonical, 'chatgptInference', valid)
  assert.deepEqual(result, valid)
  assert.notEqual(result.receipt.binding, canonical)
  assert(!JSON.stringify(result).includes('A8_REVIEW_FAKE_MARKER'))
})
