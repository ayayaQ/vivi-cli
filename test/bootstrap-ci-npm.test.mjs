// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ciNpmPlan, bootstrapCiNpm } from '../scripts/bootstrap-ci-npm.mjs'

const windows = { RUNNER_TEMP: 'C:\\runner temp', GITHUB_PATH: 'C:\\runner temp\\path', GITHUB_ENV: 'C:\\runner temp\\env' }
const unix = { RUNNER_TEMP: '/runner temp', GITHUB_PATH: '/runner temp/path', GITHUB_ENV: '/runner temp/env' }

test('CI npm prefix layouts and install arguments are exact and preserve spaces', () => {
  const win = ciNpmPlan(windows, 'win32')
  assert.equal(win.prefix, 'C:\\runner temp\\vivi-npm-toolchain')
  assert.equal(win.bin, win.prefix)
  assert.equal(win.cli, 'C:\\runner temp\\vivi-npm-toolchain\\node_modules\\npm\\bin\\npm-cli.js')
  const posix = ciNpmPlan(unix, 'linux')
  assert.equal(posix.bin, '/runner temp/vivi-npm-toolchain/bin')
  assert.equal(posix.cli, '/runner temp/vivi-npm-toolchain/lib/node_modules/npm/bin/npm-cli.js')
  for (const plan of [win, posix]) assert.deepEqual(plan.installArgs, ['install', '--global', '--prefix', plan.prefix,
    'npm@11.17.0', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'])
})

test('CI bootstrap rejects absent, relative or multiline environment paths', () => {
  for (const key of Object.keys(unix)) {
    for (const value of [undefined, '', 'relative', '/path\nextra']) {
      assert.throws(() => ciNpmPlan({ ...unix, [key]: value }, 'linux'), new RegExp(key))
    }
  }
})

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'vivi npm bootstrap '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const env = { RUNNER_TEMP: root, GITHUB_PATH: join(root, 'github path'), GITHUB_ENV: join(root, 'github env'),
    npm_execpath: join(root, 'bundled npm', 'npm-cli.js') }
  mkdirSync(dirname(env.npm_execpath)); writeFileSync(env.npm_execpath, '')
  writeFileSync(env.GITHUB_PATH, ''); writeFileSync(env.GITHUB_ENV, '')
  return { env, plan: ciNpmPlan(env) }
}

test('CI bootstrap activates only its verified CLI with shell-free bounded subprocesses', t => {
  const { env, plan } = fixture(t)
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    if (calls.length === 1) {
      mkdirSync(dirname(plan.cli), { recursive: true }); writeFileSync(plan.cli, '')
      return { status: 0, stdout: '', stderr: '' }
    }
    return { status: 0, stdout: '11.17.0\n', stderr: '' }
  }
  bootstrapCiNpm(env, { spawn })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].command, process.execPath)
  assert.deepEqual(calls[0].args.slice(1), plan.installArgs)
  assert.deepEqual(calls[1].args, [plan.cli, '--version'])
  for (const call of calls) { assert.equal(call.options.shell, false); assert(call.options.timeout > 0) }
  assert.equal(readFileSync(env.GITHUB_PATH, 'utf8'), `${plan.bin}\n`)
  assert.equal(readFileSync(env.GITHUB_ENV, 'utf8'), `npm_execpath=${plan.cli}\n`)
})

for (const failure of ['install', 'spawn', 'signal', 'wrong-version', 'missing-cli']) {
  test(`CI bootstrap ${failure} failure never activates the toolchain`, t => {
    const { env, plan } = fixture(t)
    let calls = 0
    const spawn = () => {
      calls++
      if (failure === 'install') return { status: 1, stdout: '', stderr: 'install failed' }
      if (failure === 'spawn') return { error: new Error('synthetic spawn failure') }
      if (failure === 'signal') return { status: null, signal: 'SIGTERM', stdout: '', stderr: '' }
      if (calls === 1 && failure !== 'missing-cli') {
        mkdirSync(dirname(plan.cli), { recursive: true }); writeFileSync(plan.cli, '')
      }
      return { status: 0, stdout: calls === 1 ? '' : '10.9.9\n', stderr: '' }
    }
    assert.throws(() => bootstrapCiNpm(env, { spawn }))
    assert.equal(readFileSync(env.GITHUB_PATH, 'utf8'), '')
    assert.equal(readFileSync(env.GITHUB_ENV, 'utf8'), '')
  })
}
