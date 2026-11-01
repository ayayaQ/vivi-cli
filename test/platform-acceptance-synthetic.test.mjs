// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { fakeCredentialBackend, fixtureSha256, main, runSyntheticAcceptance } from '../scripts/platform-acceptance-synthetic.mjs'
import { NativeCredentialStore } from '../dist/credentials.js'

test('synthetic helper/store report uses only fake commands and current encrypted ChatGPT records', async () => {
  const report = await runSyntheticAcceptance('e'.repeat(40))
  assert.equal(report.binding.artifactKind, 'synthetic-fixture')
  assert.equal(report.binding.artifactSha256, fixtureSha256)
  assert.equal(report.binding.platform, process.platform)
  assert.equal(report.binding.arch, process.arch)
  assert.equal(report.binding.node, process.version)
  assert.equal(report.syntheticResult, 'passed')
  assert(Object.values(report.manual).every(stage => stage.status === 'not_run'))
  assert(!/a8-fake|oaiapp_a8|a8-fixture-subject|accessToken|refreshToken|idToken|email|powershell\.exe/.test(JSON.stringify(report)))
})

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform} fake helper covers current provider slots and independent wrapping slots without spawning`, async () => {
    const fake = fakeCredentialBackend(platform)
    const store = new NativeCredentialStore({ platform, runner: fake.runner })
    assert.equal((await store.status()).available, true)
    for (const provider of ['openai', 'openrouter', 'deepseek', 'deepseek-web']) {
      await store.save(provider, `synthetic-${provider}`)
      assert.equal(await store.load(provider), `synthetic-${provider}`)
    }
    const key = Buffer.alloc(32, 9).toString('base64'), scope = 'f'.repeat(64)
    await store.mcpWrappingKey(scope).save(key)
    assert.equal(await store.mcpWrappingKey(scope).load(), key)
    assert.equal(await store.mcpWrappingKey('a'.repeat(64)).load(), undefined)
    for (const call of fake.calls) {
      assert(!call.args.join(' ').includes('synthetic-'))
      assert(!call.args.join(' ').includes(key))
    }
  })
}

test('synthetic command rejects implicit/native/live modes before running any backend', async () => {
  for (const args of [[], ['--native'], ['--live'], ['--synthetic'],
    ['--synthetic', '--candidate', 'HEAD', '--output', 'unused.json'],
    ['--synthetic', '--candidate', 'a'.repeat(40), '--output', 'unused.json', '--live']]) {
    await assert.rejects(main(args), /Usage/)
  }
  const script = fileURLToPath(new URL('../scripts/platform-acceptance-synthetic.mjs', import.meta.url))
  const child = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 5000 })
  assert.equal(child.status, 1)
  assert.match(child.stderr, /No live backend/)
  assert.equal(child.stdout, '')
  await assert.rejects(main(['--synthetic', '--candidate', '0'.repeat(40), '--output', 'unused.json']), /exact clean committed candidate/)
})
