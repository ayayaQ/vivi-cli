// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, statSync } from 'node:fs'
import { posix, win32, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmCommand } from './dependency-toolchain.mjs'

export const CI_NPM_VERSION = '11.17.0'

// Global install layouts differ: Windows launchers live at the prefix root.
// Keep all derived paths as data, including spaces, never command-shell text.
export function ciNpmPlan(env, platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix
  for (const key of ['RUNNER_TEMP', 'GITHUB_PATH', 'GITHUB_ENV']) {
    assert(typeof env[key] === 'string' && path.isAbsolute(env[key]) && !/[\r\n]/.test(env[key]),
      `${key} must be an absolute, single-line CI path`)
  }
  const prefix = path.join(env.RUNNER_TEMP, 'vivi-npm-toolchain')
  const bin = platform === 'win32' ? prefix : path.join(prefix, 'bin')
  const cli = path.join(prefix, ...(platform === 'win32' ? [] : ['lib']), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return { prefix, bin, cli, installArgs: ['install', '--global', '--prefix', prefix,
    `npm@${CI_NPM_VERSION}`, '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org'] }
}

export function bootstrapCiNpm(env = process.env, { platform = process.platform,
  node = process.execPath, spawn = spawnSync } = {}) {
  const plan = ciNpmPlan(env, platform)
  for (const key of ['GITHUB_PATH', 'GITHUB_ENV']) assert(statSync(env[key]).isFile(), `${key} must name an existing CI file`)
  const [command, prefixArgs] = npmCommand(env, node, platform)
  mkdirSync(plan.prefix, { recursive: true })
  const run = (args, timeout) => {
    const result = spawn(command, args, { env, shell: false, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 })
    if (result.error) throw result.error
    assert(result.status === 0 && !result.signal,
      `npm bootstrap failed (${result.signal ?? result.status}): ${result.stderr ?? ''}`)
    return result.stdout.trim()
  }
  run([...prefixArgs, ...plan.installArgs], 120_000)
  assert(statSync(plan.cli).isFile(), 'Pinned npm CLI was not installed in the owned CI prefix')
  const version = run([plan.cli, '--version'], 10_000)
  assert.equal(version, CI_NPM_VERSION, 'Refusing to activate an unexpected npm version')
  // GitHub applies these files to later steps; write neither until install and
  // exact version verification succeed. No user/global npm prefix is changed.
  appendFileSync(env.GITHUB_PATH, `${plan.bin}\n`, 'utf8')
  appendFileSync(env.GITHUB_ENV, `npm_execpath=${plan.cli}\n`, 'utf8')
  console.log(`Selected npm ${version} from the isolated CI prefix`)
  return plan
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) bootstrapCiNpm()
