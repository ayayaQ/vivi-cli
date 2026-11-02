// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { npmCommand, supportsPolicy } from '../scripts/dependency-toolchain.mjs'

test('dependency policy rejects old and unrecognized manager versions', () => {
  for (const value of ['10.9.0', '11.9.0', '11.16.9', '11.17.0-beta.1', 'garbage']) {
    assert.equal(supportsPolicy('npm', value), false)
  }
  for (const value of ['11.17.0', '11.18.0', '12.0.0']) assert.equal(supportsPolicy('npm', value), true)
  for (const value of ['1.3.0', '1.4.1', '1.4.2-canary']) assert.equal(supportsPolicy('bun', value), false)
  for (const value of ['1.4.2', '1.4.4', '2.0.0']) assert.equal(supportsPolicy('bun', value), true)
  assert.equal(supportsPolicy('unknown', '99.0.0'), false)
})

test('contributor npm requirement does not alter application runtime engines', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.devEngines, { packageManager: { name: 'npm', version: '>=11.17.0', onFail: 'error' } })
  assert.deepEqual(manifest.engines, { node: manifest.name === '@ayayaq/vivi' ? '>=22' : '>=26.4.0' })
})

test('active PATH npm is selected and unsupported shims fail closed and paths remain shell-free arguments', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'vivi-npm-path-')))
  try {
    const active = join(root, 'active npm', 'node_modules/npm/bin')
    const bundled = join(root, 'bundled node', 'node_modules/npm/bin')
    await mkdir(active, { recursive: true }); await mkdir(bundled, { recursive: true })
    await writeFile(join(active, 'npm-cli.js'), '')
    await writeFile(join(root, 'active npm', 'npm.cmd'), 'synthetic Windows npm launcher')
    await writeFile(join(bundled, 'npm-cli.js'), '')
    const node = join(root, 'bundled node', process.platform === 'win32' ? 'node.exe' : 'node')
    const result = npmCommand({ PATH: join(root, 'active npm') }, node, 'win32')
    assert.deepEqual(result, [node, [join(active, 'npm-cli.js')]])
    await writeFile(join(root, 'active npm', 'npm'), '#!/bin/sh\necho 11.9.0\n')
    assert.throws(() => npmCommand({ PATH: join(root, 'active npm') }, node, 'linux'), /unsupported shim/)
    assert.deepEqual(npmCommand({ npm_execpath: join(bundled, 'npm-cli.js') }, node),
      [node, [join(bundled, 'npm-cli.js')]])
    assert.throws(() => npmCommand({ npm_execpath: join(root, 'missing') }, node), /Cannot locate active npm-cli/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
