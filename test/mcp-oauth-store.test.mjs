// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile, readdir, chmod, link, symlink, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { McpOAuthStore } from '../dist/mcp-oauth-store.js'
import { NativeCredentialStore } from '../dist/credentials.js'

const endpoint = 'https://mcp.fixture.invalid/mcp'
const client = { id: 'fixture-public-client', issuer: 'https://auth.fixture.invalid', redirectPort: 9876, redirectPath: '/callback', scopes: ['read'] }
const tokens = { accessToken: 'fixture-secret-access', refreshToken: 'fixture-secret-refresh', expiresAt: 61_000,
  issuer: client.issuer, resource: endpoint, clientId: client.id, scopes: ['read'] }
const safeError = code => error => error.code === code && !/fixture-secret|Keychain|native-diagnostic/.test(error.message)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
// Cold Windows filesystem/SQLite startup is slower; these are fixture deadlines,
// not longer production helper timeouts or timeout-based lock stealing.
const shortDeadline = process.platform === 'win32' ? 300 : 40
const pastDeadline = () => new Promise(resolve => setTimeout(resolve, shortDeadline + 20))
function ready(promise) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Synthetic fixture did not become ready')), 10_000)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}
function fakeKeys(available = true) {
  const entries = new Map(), calls = []
  return { entries, calls, keyStore: scope => ({
    status: async () => ({ available, label: 'Fixture OS keyring' }),
    load: async () => { calls.push('load'); if (!available) throw Error('native-diagnostic'); return entries.get(scope) },
    save: async value => { calls.push('save'); if (!available) throw Error('native-diagnostic'); entries.set(scope, value) }
  }) }
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-oauth-fixture-')), secrets = [], keys = fakeKeys(options.available)
  t.after(() => rm(directory, { recursive: true, force: true }))
  const make = () => new McpOAuthStore(directory, { keyStore: keys.keyStore, registerSecrets: values => secrets.push(...values) })
  const store = make(), saved = options.available === false ? undefined : await store.saveClient('example', endpoint, client)
  return { directory, store, saved, make, keys, secrets, file: join(directory, 'mcp-oauth-example.json') }
}

test('encrypted per-server sign-in survives restart without plaintext, key regeneration or provider slots', async t => {
  const { store, saved, make, directory, keys, secrets, file } = await fixture(t)
  const long = { ...tokens, accessToken: 'A'.repeat(8192), refreshToken: 'R'.repeat(8192) }
  const updated = await store.saveTokens('example', endpoint, saved.revision, long)
  assert.equal((await make().load('example', endpoint)).tokens.accessToken, long.accessToken)
  assert.equal(keys.calls.filter(call => call === 'save').length, 1)
  const bytes = await readFile(file, 'utf8')
  assert(!bytes.includes(long.accessToken)); assert(!bytes.includes(long.refreshToken)); assert(!bytes.includes(client.id))
  assert(secrets.includes(long.accessToken)); assert(secrets.includes(long.refreshToken))
  assert.deepEqual((await readdir(directory)).sort(), ['mcp-oauth-example.json', 'mcp-oauth-lease.sqlite'])
  assert.notEqual(updated.revision, saved.revision)
  assert.equal(await make().load('example', 'https://other.fixture.invalid/mcp'), undefined)
  const cleared = await store.clearTokens('example', endpoint)
  assert.deepEqual(cleared.client, client); assert.equal(cleared.tokens, undefined)
  assert.equal((await make().load('example', endpoint)).tokens, undefined)
  await store.remove('example'); assert.equal(await make().load('example', endpoint), undefined)
})

test('saved tokens bind issuer, client, resource and scopes; stale writes cannot undo sign-out', async t => {
  const { store, saved } = await fixture(t)
  for (const change of [{ issuer: 'https://other.fixture.invalid' }, { clientId: 'other' }, { resource: endpoint + '/other' }, { scopes: ['write'] },
    { accessToken: 'fixture-secret-access\n' }, { expiresAt: Infinity }, { idToken: 'fixture-secret-id' }])
    await assert.rejects(store.saveTokens('example', endpoint, saved.revision, { ...tokens, ...change }), safeError('unavailable'))
  const updated = await store.saveTokens('example', endpoint, saved.revision, tokens)
  const cleared = await store.clearTokens('example', endpoint)
  await assert.rejects(store.saveTokens('example', endpoint, updated.revision, tokens), safeError('changed'))
  assert.equal((await store.load('example', endpoint)).revision, cleared.revision)
  assert.equal(await store.clearTokens('example', endpoint + '/stale'), undefined)
  assert.equal((await store.load('example', endpoint)).revision, cleared.revision)
})

test('ciphertext tamper, another server identity, hard links and unsafe modes fail closed', async t => {
  const { store, saved, file, directory } = await fixture(t)
  await store.saveTokens('example', endpoint, saved.revision, tokens)
  const original = await readFile(file)
  const parsed = JSON.parse(original)
  parsed.tag = Buffer.alloc(16).toString('base64'); await writeFile(file, JSON.stringify(parsed))
  await assert.rejects(store.load('example', endpoint), safeError('unavailable'))
  await writeFile(file, original)
  await writeFile(join(directory, 'mcp-oauth-other.json'), original, { mode: 0o600 })
  await assert.rejects(store.load('other', endpoint), safeError('unavailable'))
  await link(file, join(directory, 'linked-record'))
  await assert.rejects(store.load('example', endpoint), safeError('unavailable'))
  await rm(join(directory, 'linked-record'))
  if (process.platform !== 'win32') { await chmod(file, 0o644); await assert.rejects(store.load('example', endpoint), safeError('unavailable')) }
})

test('symlinked record and lease files fail closed when the OS permits fixture symlinks', async t => {
  for (const kind of ['record', 'lease']) {
    const { store, directory, file } = await fixture(t)
    const target = kind === 'record' ? file : join(directory, 'mcp-oauth-lease.sqlite')
    const linked = join(directory, 'synthetic-link-target')
    await writeFile(linked, 'synthetic-target', { mode: 0o600 }); await rm(target)
    try { await symlink(linked, target, 'file') }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.skip('Windows fixture symlink privilege is unavailable'); return
      }
      throw error
    }
    await assert.rejects(kind === 'record' ? store.load('example', endpoint) : store.saveClient('other', endpoint, client), safeError('unavailable'))
  }
})

test('unavailable or lost OS key never falls back to plaintext or overwrites existing ciphertext', async t => {
  const locked = await fixture(t, { available: false })
  assert.equal((await locked.store.status()).available, false)
  await assert.rejects(locked.store.saveClient('example', endpoint, client), safeError('unavailable'))
  assert.deepEqual(await readdir(locked.directory), ['mcp-oauth-lease.sqlite'])
  const { store, saved, keys, file } = await fixture(t)
  await store.saveTokens('example', endpoint, saved.revision, tokens)
  const before = await readFile(file)
  keys.entries.clear()
  await assert.rejects(store.load('example', endpoint), safeError('unavailable'))
  await assert.rejects(store.saveClient('other', endpoint, client), safeError('unavailable'))
  assert.deepEqual(await readFile(file), before)
  assert.equal(await store.clearTokens('example', endpoint), undefined)
  assert.equal(await store.load('example', endpoint), undefined)
})

test('refresh persists rotated tokens once; failed or uncertain refresh cannot reuse authority', async t => {
  const { store, saved, make } = await fixture(t)
  let record = await store.saveTokens('example', endpoint, saved.revision, tokens), calls = 0
  record = await store.refreshTokens('example', endpoint, record.revision, async initial => {
    calls++; assert.equal(initial.refreshToken, tokens.refreshToken)
    assert.equal((await make().load('example', endpoint)).tokens, undefined)
    return { ...tokens, accessToken: 'fixture-secret-rotated-access', refreshToken: 'fixture-secret-rotated-refresh' }
  })
  assert.equal(calls, 1); assert.equal((await make().load('example', endpoint)).tokens.refreshToken, 'fixture-secret-rotated-refresh')
  await assert.rejects(store.refreshTokens('example', endpoint, record.revision, async () => { calls++; throw Error('fixture-secret-unknown-post') }), safeError('needs-sign-in'))
  const empty = await make().load('example', endpoint)
  assert.equal(empty.tokens, undefined)
  await assert.rejects(store.refreshTokens('example', endpoint, empty.revision, async () => { calls++; return tokens }), safeError('needs-sign-in'))
  assert.equal(calls, 2)
})

test('parallel initialization creates one key and concurrent refresh holds an exclusive transaction', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-oauth-init-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const keys = fakeKeys(), initializing = deferred(), finishInitialization = deferred()
  t.after(() => finishInitialization.resolve())
  const first = new McpOAuthStore(directory, { keyStore: scope => {
    const adapter = keys.keyStore(scope)
    return { ...adapter, save: async value => { initializing.resolve(); await finishInitialization.promise; await adapter.save(value) } }
  } }), second = new McpOAuthStore(directory, { keyStore: keys.keyStore })
  const saving = first.saveClient('example', endpoint, client)
  await ready(initializing.promise)
  await assert.rejects(second.saveClient('other', endpoint, client), safeError('busy'))
  finishInitialization.resolve(); await saving
  assert.equal(keys.calls.filter(call => call === 'save').length, 1)
  await first.saveClient('example', endpoint, client)
  const record = await first.load('example', endpoint), withTokens = await first.saveTokens('example', endpoint, record.revision, tokens)
  const entered = deferred(), release = deferred()
  const refreshing = first.refreshTokens('example', endpoint, withTokens.revision, async () => { entered.resolve(); await release.promise; return tokens })
  await ready(entered.promise)
  await assert.rejects(second.clearTokens('example', endpoint), safeError('busy'))
  await assert.rejects(second.refreshTokens('example', endpoint, withTokens.revision, async () => tokens), safeError('busy'))
  release.resolve(); await refreshing
  await second.clearTokens('example', endpoint); assert.equal((await first.load('example', endpoint)).tokens, undefined)
})

test('separate processes cannot race refresh; OS releases crash lease and normal sign-in resets uncertain tokens', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-oauth-process-'))
  let child, closed
  t.after(async () => { child?.kill('SIGKILL'); await closed; await rm(directory, { recursive: true, force: true }) })
  const syntheticKey = Buffer.alloc(32, 7).toString('base64')
  const keyStore = () => ({ status: async () => ({ available: true, label: 'Fixture' }), load: async () => syntheticKey, save: async () => { throw Error('unexpected synthetic key save') } })
  const store = new McpOAuthStore(directory, { keyStore }), saved = await store.saveClient('example', endpoint, client)
  const record = await store.saveTokens('example', endpoint, saved.revision, tokens)
  const module = new URL('../dist/mcp-oauth-store.js', import.meta.url).href
  const source = `import { McpOAuthStore } from ${JSON.stringify(module)}; const store = new McpOAuthStore(${JSON.stringify(directory)}, {keyStore:()=>({status:async()=>({available:true,label:'Fixture'}),load:async()=>${JSON.stringify(syntheticKey)},save:async()=>{throw Error('unexpected')}})}); await store.refreshTokens('example', ${JSON.stringify(endpoint)}, ${JSON.stringify(record.revision)}, async initial => { process.stdout.write('locked\\n'); await new Promise(resolve=>process.stdin.once('data',resolve)); return initial });`
  child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] })
  closed = new Promise(resolve => child.once('close', resolve))
  await ready(new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', code => reject(Error(`fixture child exited ${code}`))) }))
  await assert.rejects(store.clearTokens('example', endpoint), safeError('busy'))
  child.kill('SIGKILL'); await closed
  assert.equal((await store.load('example', endpoint)).tokens, undefined)
  const pending = await store.load('example', endpoint)
  await assert.rejects(store.refreshTokens('example', endpoint, pending.revision, async () => tokens), safeError('needs-sign-in'))
  const fresh = await store.saveClient('example', endpoint, client)
  assert.equal(fresh.tokens, undefined)
  const signedIn = await store.saveTokens('example', endpoint, fresh.revision, { ...tokens, refreshToken: 'fixture-secret-fresh-browser' })
  assert.equal((await store.load('example', endpoint)).tokens.refreshToken, signedIn.tokens.refreshToken)
  assert.deepEqual((await readdir(directory)).sort(), ['mcp-oauth-example.json', 'mcp-oauth-lease.sqlite'])
})

test('narrow native wrapping-key adapters preserve provider API restrictions and secret pipe-only I/O', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const requests = [], secret = Buffer.alloc(32, 11).toString('base64'), scope = 'a'.repeat(64)
    let value
    const runner = async request => {
      requests.push(request)
      const saving = request.stdin?.startsWith('save\n') || request.args[0] === 'store' || request.args[0] === '-i'
      if (saving) { value = secret; return { exitCode: 0, stdout: '', stderrPresent: false } }
      if (!value) return { exitCode: platform === 'darwin' ? 44 : platform === 'win32' ? 3 : 1, stdout: '', stderrPresent: false }
      return { exitCode: 0, stdout: platform === 'darwin' ? 'vivi-cli-api-key-v1:' + Buffer.from(value).toString('base64') + '\n' : value, stderrPresent: false }
    }
    const native = new NativeCredentialStore({ platform, runner }), keyStore = native.mcpWrappingKey(scope)
    assert.equal(await keyStore.load(), undefined); await keyStore.save(secret); assert.equal(await keyStore.load(), secret)
    assert(requests.every(request => !request.args.join(' ').includes(secret)))
    await assert.rejects(native.load('mcp-oauth-key-v1-' + scope), /Unsupported credential provider/)
    assert.throws(() => native.mcpWrappingKey('../unsafe'), /Invalid MCP credential storage scope/)
  }
})

test('transaction cancellation and timeout release OS lease; late completion cannot overwrite a fresh sign-in', async t => {
  for (const cause of ['timeout', 'cancel']) {
    const { directory, keys, store, saved } = await fixture(t)
    const short = new McpOAuthStore(directory, { keyStore: keys.keyStore, transactionTimeoutMs: shortDeadline })
    const withTokens = await store.saveTokens('example', endpoint, saved.revision, tokens)
    const entered = deferred(), release = deferred(), abort = new AbortController()
    const running = short.refreshTokens('example', endpoint, withTokens.revision, async () => { entered.resolve(); await release.promise; return { ...tokens, refreshToken: 'fixture-secret-late-refresh' } }, () => true, abort.signal)
    const rejection = assert.rejects(running, safeError('needs-sign-in'))
    await ready(entered.promise); if (cause === 'cancel') abort.abort(); await rejection
    assert.equal((await store.load('example', endpoint)).tokens, undefined)
    const fresh = await store.saveClient('example', endpoint, client)
    const final = await store.saveTokens('example', endpoint, fresh.revision, { ...tokens, refreshToken: 'fixture-secret-current-refresh' })
    release.resolve(); await new Promise(resolve => setTimeout(resolve, 20))
    const restored = await store.load('example', endpoint)
    assert.equal(restored.revision, final.revision); assert.equal(restored.tokens.refreshToken, 'fixture-secret-current-refresh')
    assert.equal(keys.calls.filter(call => call === 'save').length, 1)
  }
})

test('normal save cleans crashed encrypted temporary files and bounds records to eight servers', async t => {
  const { store, directory } = await fixture(t)
  const temporary = join(directory, '.mcp-oauth.11111111-1111-1111-1111-111111111111.tmp')
  await writeFile(temporary, 'synthetic-encrypted-temporary', { mode: 0o600 })
  for (let index = 1; index < 8; index++) await store.saveClient('server' + index, endpoint, client)
  assert(!(await readdir(directory)).includes(basename(temporary)))
  await assert.rejects(store.saveClient('server8', endpoint, client), safeError('unavailable'))
  await store.remove('server1'); await store.saveClient('server8', endpoint, client)
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.json')).length, 8)
})

test('malformed or shared lease files fail closed without PID guessing', async t => {
  for (const invalid of ['malformed', 'mode']) {
    if (invalid === 'mode' && process.platform === 'win32') continue
    const { store, directory } = await fixture(t)
    const lease = join(directory, 'mcp-oauth-lease.sqlite')
    if (invalid === 'malformed') await writeFile(lease, 'synthetic-invalid-sqlite-file')
    if (invalid === 'mode') await chmod(lease, 0o644)
    await assert.rejects(store.saveClient('other', endpoint, client), safeError('unavailable'))
  }
})

test('timeout during wrapping-key initialization keeps the native lease until the helper settles', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-oauth-key-init-timeout-')); t.after(() => rm(directory, { recursive: true, force: true }))
  const entered = deferred(), release = deferred(), keys = new Map()
  let writes = 0
  const keyStore = scope => ({ status: async () => ({ available: true, label: 'Fixture' }), load: async () => keys.get(scope),
    save: async value => { writes++; entered.resolve(); await release.promise; keys.set(scope, value) } })
  const short = new McpOAuthStore(directory, { keyStore, transactionTimeoutMs: shortDeadline }), normal = new McpOAuthStore(directory, { keyStore })
  const running = short.saveClient('example', endpoint, client), rejection = assert.rejects(running, safeError('needs-sign-in'))
  await ready(entered.promise); await pastDeadline()
  await assert.rejects(normal.saveClient('other', endpoint, client), safeError('busy'))
  let settled = false
  const waiting = short.settle().then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(settled, false)
  release.resolve(); await rejection; await waiting; assert.equal(settled, true)
  const saved = await normal.saveClient('other', endpoint, client)
  assert.equal((await normal.load('other', endpoint)).revision, saved.revision)
  assert.equal(writes, 1)
  assert.equal(await normal.load('example', endpoint), undefined)
})

test('opaque RFC refresh tokens preserve printable punctuation without trimming or leaking to files', async t => {
  const { store, saved, file } = await fixture(t)
  const refreshToken = ' fixture-secret-refresh:with"opaque\\characters '
  const record = await store.saveTokens('example', endpoint, saved.revision, { ...tokens, refreshToken })
  assert.equal((await store.load('example', endpoint)).tokens.refreshToken, refreshToken)
  assert.equal(record.tokens.refreshToken, refreshToken)
  assert(!(await readFile(file, 'utf8')).includes(refreshToken))
})

test('cancellation while pending marker becomes durable never invokes a stale refresh callback', async t => {
  const { directory, keys, store, saved } = await fixture(t)
  const record = await store.saveTokens('example', endpoint, saved.revision, tokens)
  const short = new McpOAuthStore(directory, { keyStore: keys.keyStore, transactionTimeoutMs: shortDeadline })
  const entered = deferred(), release = deferred(), normalSync = short.syncDirectory.bind(short)
  short.syncDirectory = async () => { entered.resolve(); await release.promise; await normalSync() }
  let calls = 0
  const running = short.refreshTokens('example', endpoint, record.revision, async () => { calls++; return tokens })
  const rejection = assert.rejects(running, safeError('needs-sign-in'))
  await ready(entered.promise); await pastDeadline()
  await assert.rejects(store.clearTokens('example', endpoint), safeError('busy'))
  release.resolve(); await rejection
  assert.equal(calls, 0); assert.equal((await store.load('example', endpoint)).tokens, undefined)
  await store.saveClient('example', endpoint, client)
})
