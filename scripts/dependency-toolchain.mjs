// SPDX-License-Identifier: Apache-2.0
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export function supportsPolicy(manager, version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!parts) return false
  const actual = parts.slice(1).map(Number)
  const minimum = manager === 'npm' ? [11, 17, 0] : manager === 'bun' ? [1, 4, 2] : null
  if (!minimum) return false
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index]
  }
  return true
}

// Resolve the active PATH npm, including npm.cmd's sibling CLI. Refuse unknown
// shims rather than verifying another npm. Never use a Windows command shell.
export function npmCommand(env = process.env, node = process.execPath, platform = process.platform) {
  const resolveCli = candidate => {
    if (!existsSync(candidate)) return null
    const resolved = realpathSync(candidate)
    return resolved.endsWith('npm-cli.js') ? [node, [resolved]] : null
  }
  if (env.npm_execpath) {
    const explicit = resolveCli(env.npm_execpath)
    if (explicit) return explicit
    throw new Error('Cannot locate active npm-cli.js from npm_execpath')
  }
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    const launchers = (platform === 'win32' ? ['npm', 'npm.cmd', 'npm.ps1', 'npm.exe', 'npm.bat'] : ['npm'])
      .map(name => join(directory, name)).filter(existsSync)
    if (!launchers.length) continue
    const direct = resolveCli(launchers[0])
    if (direct) return direct
    if (platform === 'win32') {
      const sibling = resolveCli(join(directory, 'node_modules/npm/bin/npm-cli.js'))
      if (sibling) return sibling
    }
    // Never verify a later npm while the install command uses an earlier shim.
    throw new Error('Active npm launcher is an unsupported shim; run this verifier via npm run with npm_execpath')
  }
  throw new Error('Cannot locate active npm-cli.js on PATH; install npm >=11.17.0 or run via npm run')
}
