// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { createDecipheriv, createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { syntheticAcceptanceEvidence, supportsCliNode, targetPreflight } from './platform-acceptance.mjs'

// Only a deterministic fixture identity, never a claim about a package archive.
export const fixtureSha256 = createHash('sha256').update('vivi-cli/a8/synthetic-helper-store-report/v1').digest('hex')

/** All native commands terminate in this in-memory function. It never spawns. */
export function fakeCredentialBackend(platform) {
  const values = new Map(), calls = []
  const result = (exitCode = 0, stdout = '') => ({ exitCode, stdout, stderrPresent: false })
  const runner = async request => {
    calls.push(request)
    if (platform === 'darwin') {
      assert.equal(request.command, '/usr/bin/security')
      if (request.args[0] === 'default-keychain') return result()
      if (request.args[0] === '-i') {
        const match = /^add-generic-password -U -s vivi-cli -a ([a-z0-9-]+) -X ([a-f0-9]+)\n$/.exec(request.stdin)
        assert(match); values.set(match[1], Buffer.from(match[2], 'hex').toString()); return result()
      }
      assert.equal(request.args[0], 'find-generic-password')
      const value = values.get(request.args[4])
      return value === undefined ? result(44) : result(0, value + '\n')
    }
    if (platform === 'win32') {
      assert.match(request.command, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/)
      const [operation, slot] = request.stdin.split('\n')
      if (operation === 'status') return result()
      if (operation === 'save') { values.set(slot, request.stdin.slice(`save\n${slot}\n`.length)); return result() }
      assert.equal(operation, 'load')
      return values.has(slot) ? result(0, values.get(slot)) : result(3)
    }
    assert.equal(platform, 'linux'); assert.equal(request.command, 'secret-tool')
    if (request.args.includes('credential-probe')) return result(1)
    const slot = request.args.at(-1)
    if (request.args[0] === 'store') { values.set(slot, request.stdin); return result() }
    assert.equal(request.args[0], 'lookup')
    return values.has(slot) ? result(0, values.get(slot)) : result(1)
  }
  return { runner, values, calls }
}

/** Runs only on a newly allocated temporary directory with mandatory fake seams. */
export async function runSyntheticAcceptance(candidateSha) {
  if (!supportsCliNode(process.version) || !['win32', 'darwin', 'linux'].includes(process.platform)) throw Error('Unsupported synthetic runtime')
  // Validate identity before importing built application modules or allocating files.
  const binding = { candidateSha, artifactSha256: fixtureSha256, artifactKind: 'synthetic-fixture',
    platform: process.platform, arch: process.arch, node: process.version }
  const checks = Object.fromEntries((await import('./platform-acceptance.mjs')).syntheticChecks.map(name => [name, false]))
  syntheticAcceptanceEvidence({ binding, generatedAt: new Date().toISOString(), checks })
  const { NativeCredentialStore } = await import('../dist/credentials.js')
  const { ChatGptAuthStore, chatGptAccountId } = await import('../dist/chatgpt-auth-store.js')
  const directory = await mkdtemp(join(tmpdir(), 'vivi-a8-synthetic-'))
  try {
    const backend = fakeCredentialBackend(process.platform)
    const store = new NativeCredentialStore({ platform: process.platform, runner: backend.runner })
    assert.equal((await store.status()).available, true)
    for (const provider of ['openai', 'openrouter', 'deepseek', 'deepseek-web']) {
      assert.equal(await store.load(provider), undefined)
      await store.save(provider, `a8-fake-${provider}`)
      assert.equal(await new NativeCredentialStore({ platform: process.platform, runner: backend.runner }).load(provider), `a8-fake-${provider}`)
    }
    checks.providerSlots = true
    const scope = 'a'.repeat(64), other = 'b'.repeat(64), fakeKey = Buffer.alloc(32, 7).toString('base64')
    await store.mcpWrappingKey(scope).save(fakeKey)
    assert.equal(await store.mcpWrappingKey(scope).load(), fakeKey)
    assert.equal(await store.mcpWrappingKey(other).load(), undefined)
    checks.scopedWrappingKeys = true
    const unavailable = new NativeCredentialStore({ platform: process.platform, runner: async () => { throw Error('fixture unavailable') } })
    assert.equal((await unavailable.status()).available, false)
    await assert.rejects(unavailable.load('openai'), /Unable to read/)
    checks.helperUnavailable = true
    for (const [state, check] of [['absent', 'absentPreflight'], ['occupied', 'occupiedPreflight'], ['uncertain', 'uncertainPreflight']]) {
      const outcome = await targetPreflight(['openai', 'openrouter', 'deepseek', 'deepseek-web', `mcp-oauth-key-v1-${scope}`], {
        available: async () => true, presence: async () => state,
        load: () => { throw Error('presence preflight must never read a value') }
      })
      assert.equal(outcome.status, state === 'absent' ? 'eligible' : 'blocked'); checks[check] = true
    }
    const seenScopes = new Set()
    const keyStore = nextScope => { seenScopes.add(nextScope); return store.mcpWrappingKey(nextScope) }
    const authDirectory = join(directory, 'chatgpt-auth')
    const makeAuth = () => new ChatGptAuthStore(authDirectory, { keyStore })
    const auth = makeAuth(), hostId = await auth.hostId()
    const clientId = 'oaiapp_a8_fixture', subject = 'a8-fixture-subject', id = chatGptAccountId(clientId, subject)
    const account = { id, clientId, subject, welcomeSeen: false, revision: randomUUID(),
      tokens: { accessToken: 'a8-fake-access', refreshToken: 'a8-fake-refresh', idToken: 'a8-fake-id',
        scopes: ['openid'], expiresAt: 2_000_000_000_000, savedAt: 1_800_000_000_000 } }
    await auth.transaction(async transaction => transaction.write({ version: 1, hostId, accounts: [account] }))
    const path = join(authDirectory, `account-${id}.json`), bytes = await readFile(path, 'utf8'), envelope = JSON.parse(bytes)
    assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'iv', 'tag', 'version'])
    assert.equal(envelope.version, 1); assert.equal(Buffer.from(envelope.iv, 'base64').length, 12)
    assert.equal(Buffer.from(envelope.tag, 'base64').length, 16)
    assert(!bytes.includes('a8-fake-'))
    const metadata = JSON.parse(await readFile(join(authDirectory, 'registrations.json'), 'utf8'))
    assert.equal(metadata.accounts[0].tokens, undefined)
    checks.chatgptEnvelope = true
    assert.deepEqual((await makeAuth().readData()).accounts, [account]); checks.chatgptRestart = true
    const canonical = await realpath(authDirectory)
    const expectedScope = createHash('sha256').update(`vivi-cli/chatgpt-auth/v1\0${canonical}`).digest('hex')
    assert.deepEqual([...seenScopes], [expectedScope])
    assert.notEqual(expectedScope, createHash('sha256').update(canonical).digest('hex'))
    const wrappingKey = await store.mcpWrappingKey(expectedScope).load()
    assert.equal(Buffer.from(wrappingKey, 'base64').length, 32)
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(wrappingKey, 'base64'), Buffer.from(envelope.iv, 'base64'))
    decipher.setAAD(Buffer.from(`vivi-cli/chatgpt-auth/v1/${hostId}/${id}`))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString()), account)
    checks.chatgptDomainSeparation = true
    const tampered = { ...envelope, tag: Buffer.alloc(16).toString('base64') }
    await writeFile(path, JSON.stringify(tampered), { mode: 0o600 })
    await assert.rejects(makeAuth().readData()); checks.chatgptTamperRejected = true
    await writeFile(path, bytes, { mode: 0o600 })
    const locked = new ChatGptAuthStore(authDirectory, { keyStore: () => ({
      status: async () => ({ available: false, label: 'fixture locked' }), load: async () => { throw Error('fixture locked') },
      save: async () => { throw Error('must not save') }
    }) })
    assert.equal((await locked.status()).available, false); await assert.rejects(locked.readData()); checks.chatgptLocked = true
    const callsBefore = backend.calls.length
    await auth.saveMetadata(account, undefined, true)
    const afterRestart = await makeAuth().readData()
    assert.equal(afterRestart.accounts[0].tokens, undefined)
    assert.equal(backend.calls.length, callsBefore); checks.chatgptSessionOnly = true
    return syntheticAcceptanceEvidence({ binding, generatedAt: new Date().toISOString(), checks })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

export async function main(args) {
  // No default backend; reject unknown/duplicate flags before any application import.
  if (args.length !== 5 || args[0] !== '--synthetic' || args[1] !== '--candidate' ||
    !/^[a-f0-9]{40}$/.test(args[2]) || args[3] !== '--output' || !args[4]) {
    throw Error('Usage: node scripts/platform-acceptance-synthetic.mjs --synthetic --candidate <40-hex-SHA> --output <new-report.json>')
  }
  const root = fileURLToPath(new URL('../', import.meta.url))
  const git = arguments_ => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/').replace(/\/$/, '')}`, ...arguments_],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (git(['rev-parse', 'HEAD']) !== args[2] || git(['status', '--porcelain', '--untracked-files=normal'])) throw Error('Synthetic report requires the exact clean committed candidate')
  const report = await runSyntheticAcceptance(args[2])
  await writeFile(args[4], JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)) }
  catch { console.error('Synthetic acceptance failed; use explicit --synthetic, exact clean --candidate SHA and a new --output file. No live backend is available.'); process.exitCode = 1 }
}
