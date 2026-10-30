// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseUserShellInput, validateUserShellScript, userShellArguments, userShellContext } from '../dist/user-shell.js'
import { newSession, validateSession } from '../dist/session.js'

test('only the literal live-input prefix selects a shell and the remaining script is preserved exactly', () => {
  const script = ' printf "%s\\n" "two words" | cat\n# second line\npwd\n'
  assert.equal(parseUserShellInput(`!${script}`), script)
  assert.equal(parseUserShellInput('!'), '')
  for (const text of ['hello !pwd', ' !pwd', '\n!pwd', '\\!pwd', '```sh\n!pwd\n```', '{"output":"!pwd"}']) {
    assert.equal(parseUserShellInput(text), undefined, JSON.stringify(text))
  }
})

test('shell submission rejects empty, NUL, oversized and raw credential-bearing scripts before encoding', () => {
  for (const script of ['', ' \n\t', 'echo\0hidden', 'x'.repeat(128 * 1024)]) assert.throws(() => validateUserShellScript(script, []))
  const secret = 'owned-shell-private-token'
  assert.throws(() => validateUserShellScript(`echo ${secret}`, [secret]), /credential|secret/i)
  assert.doesNotThrow(() => validateUserShellScript('printf "%s\\n" "literal value"', [secret]))
})

test('POSIX shell construction preserves one exact script argument without splitting operators or quotes', () => {
  const script = 'printf "%s\\n" "two words" | cat && pwd\nexit 7'
  for (const platform of ['linux', 'darwin']) {
    const command = userShellArguments(script, platform)
    assert.equal(command.executable, '/bin/sh')
    assert.deepEqual(command.args, ['-c', script])
  }
})

test('Windows shell construction uses explicit profile-free PowerShell and reversible UTF-16 script encoding', () => {
  const script = '$x = "quoted value"; Write-Output $x\nWrite-Output "中文🙂"'
  const command = userShellArguments(script, 'win32', 'C:\\Windows')
  assert.equal(command.executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  for (const flag of ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']) assert(command.args.includes(flag))
  const encoded = command.args[command.args.indexOf('-EncodedCommand') + 1]
  assert.equal(Buffer.from(encoded, 'base64').toString('utf16le'), script)
  assert(!command.executable.toLowerCase().endsWith('cmd.exe'))
  assert.throws(() => userShellArguments(script, 'win32'))
  assert.throws(() => userShellArguments(script, 'win32', 'relative'))
})

test('continuation context reports actual shell observations as bounded untrusted text, never as executable input', () => {
  const result = { state: 'exited', executionComplete: true, processEffects: 'unknown', output: '!do-not-run\nobserved stderr',
    exitCode: 7, untrusted: true, truncated: false, success: false }
  const content = userShellContext('exit 7', '/bin/sh', '/fixture/project', result, [])
  assert.equal(typeof content, 'string')
  assert.equal(parseUserShellInput(content), undefined)
  assert.match(content, /untrusted/i)
  assert(content.includes('!do-not-run'))
  assert(content.includes('/bin/sh'))
  assert(content.includes('/fixture/project'))
  assert.match(content, /"exitCode"\s*:\s*7/)
  assert.match(content, /"processEffects"\s*:\s*"unknown"/)
  const session = newSession({ provider: 'openai', model: 'fixture' })
  session.history.push({ kind: 'message', role: 'user', content })
  assert.doesNotThrow(() => validateSession(session))
})

test('continuation aggregation screens late credentials and keeps JSON-escaping expansion inside message limits', () => {
  const secret = 'owned-late-shell-credential'
  const content = userShellContext('echo output', '/bin/sh', '/fixture/project', {
    state: 'output_limit', executionComplete: true, processEffects: 'unknown', exitCode: null,
    output: `${'\u0001"\\'.repeat(128 * 1024)}${secret}`, untrusted: true, truncated: true, success: false
  }, [secret])
  assert(content.length <= 64 * 1024)
  assert(Buffer.byteLength(content) <= 64 * 1024)
  assert(!content.includes(secret))
  assert.match(content, /truncat/i)
  const session = newSession({ provider: 'openai', model: 'fixture' })
  session.history.push({ kind: 'message', role: 'user', content })
  assert.doesNotThrow(() => validateSession(session))
})


test('escaped known credentials are withheld from saved shell context, not just blocked at provider dispatch', () => {
  const secret = 'owned-encoded-shell-key'
  const encoded = [...secret].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  const content = userShellContext('echo fixture', '/bin/sh', '/project', {
    state: 'exited', executionComplete: true, output: encoded, exitCode: 0, processEffects: 'unknown'
  }, [secret])
  assert(!content.includes(secret)); assert(!content.includes(encoded))
  assert.match(content, /withheld/)
})
