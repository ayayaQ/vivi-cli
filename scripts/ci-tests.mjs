// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const nativeConpty = new Set([
  'windows-conpty-native.test.mjs',
  'windows-conpty-fallback-native.test.mjs',
  'windows-conpty-packaged-native.test.mjs'
])
// These existing suites assert POSIX file modes/symlink behavior unconditionally.
// They retain complete minimum/current Linux coverage, as before this change.
const linuxOnly = new Set(['cli.test.mjs', 'preferences.test.mjs'])
const currentCompatibility = new Set([
  'command-process.test.mjs', 'command-windows.test.mjs', 'command-windows-real.test.mjs',
  'mcp-windows.test.mjs', 'mcp-windows-real.test.mjs', 'mcp-windows-node-env.test.mjs',
  'platform-acceptance.test.mjs', 'windows-input.test.mjs', 'windows-conpty.test.mjs'
])
const isOAuth = name => name.includes('mcp-oauth')
const isAgentMcpSetup = name => name.startsWith('mcp-setup-')
const isMcp = name => name.startsWith('mcp-') || isOAuth(name)

export async function ciTestGroups(directory = new URL('../test/', import.meta.url)) {
  const names = (await readdir(directory)).sort()
  const node = names.filter(name => name.endsWith('.test.mjs'))
  const tui = names.filter(name => name.endsWith('.test.ts'))
  for (const name of [...nativeConpty, ...linuxOnly, ...currentCompatibility]) {
    assert(node.includes(name), `CI coverage file is missing: ${name}`)
  }
  const path = name => `./test/${name}`
  return {
    'linux-node': node.map(path),
    'windows-mcp': node.filter(isMcp).map(path),
    'windows-headless': node.filter(name => !isMcp(name) && !nativeConpty.has(name) && !linuxOnly.has(name)).map(path),
    'windows-current': node.filter(name => currentCompatibility.has(name) || isOAuth(name) || isAgentMcpSetup(name)).map(path),
    'bun-tui': tui.map(path),
    'bun-boundaries': node.filter(name => name.startsWith('public-url') || name === 'mcp-http.test.mjs' || name === 'mcp-auto-compatibility.test.mjs' || isOAuth(name) || isAgentMcpSetup(name)).map(path),
    'windows-stock': ['./test/windows-conpty-fallback-native.test.mjs'],
    'windows-modern': ['./test/windows-conpty-packaged-native.test.mjs'],
    'linux-only': node.filter(name => linuxOnly.has(name)).map(path),
    // This original OS-dependent mode1 diagnostic is manual. CI separately proves
    // stock mode2 and the hash-pinned modern mode1 backend on genuine Windows.
    'manual-system-mode1': ['./test/windows-conpty-native.test.mjs']
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [group, option] = process.argv.slice(2)
  const groups = await ciTestGroups()
  if (group === '--list') {
    console.log(JSON.stringify(groups, null, 2))
  } else {
    assert(Object.hasOwn(groups, group), `Unknown CI test group: ${group}`)
    assert(groups[group].length > 0, `CI test group must not be empty: ${group}`)
    assert(option === undefined || option === '--list', `Unknown CI option: ${option}`)
    if (option === '--list') console.log(JSON.stringify(groups[group], null, 2))
    else {
      const bun = group.startsWith('bun-')
      // Keep cold Windows native helpers serial within their isolated runner.
      // Explicit filenames work on Windows without shell wildcard expansion.
      const args = bun ? ['test', ...groups[group]]
        : ['--test', ...(group.startsWith('windows-') ? ['--test-concurrency=1'] : []), ...groups[group]]
      const result = spawnSync(bun ? process.env.VIVI_TEST_BUN ?? 'bun' : process.execPath,
        args, { cwd: root, stdio: 'inherit', shell: false })
      if (result.error) throw result.error
      assert.equal(result.signal, null, `CI test process was terminated: ${result.signal}`)
      process.exitCode = result.status ?? 1
    }
  }
}
