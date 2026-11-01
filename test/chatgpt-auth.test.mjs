// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { ChatGptAuthManager } from '../dist/chatgpt-auth.js'
import { ChatGptAuthStore } from '../dist/chatgpt-auth-store.js'
import { listenChatGptCallback } from '../dist/chatgpt-auth-callback.js'
import { CHATGPT_ISSUER, CHATGPT_RESOURCE, CHATGPT_SCOPES } from '../dist/chatgpt-auth-types.js'

const discovery = { issuer: CHATGPT_ISSUER, authorization_endpoint: `${CHATGPT_ISSUER}/api/accounts/authorize`,
  token_endpoint: `${CHATGPT_ISSUER}/api/accounts/oauth/token`, jwks_uri: `${CHATGPT_ISSUER}/.well-known/jwks.json`,
  revocation_endpoint: `${CHATGPT_ISSUER}/api/accounts/oauth/revoke` }
const safeError = code => error => error.code === code && !/fixture-access|fixture-refresh|fixture-code|eyJ/.test(error.message)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'x-request-id': 'fixture_request' } })
async function fixture(t, initial = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-chatgpt-auth-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const pair = await generateKeyPair('RS256'), jwk = { ...await exportJWK(pair.publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }
  let now = Date.parse('2026-10-31T12:00:00Z'), callback, opened, authorizeCount = 0, tokenCount = 0, refreshCount = 0
  const config = { available: true, subject: 'fixture-subject', email: 'fixture@example.invalid', scopes: CHATGPT_SCOPES.join(' '), ...initial }
  const secrets = [], keys = new Map(), calls = [], authorizations = [], tokenBodies = [], revocations = []
  const keyStore = scope => ({ status: async () => ({ available: config.available, label: 'Fixture native keyring' }),
    load: async () => { if (!config.available) throw Error('synthetic locked native keyring'); return keys.get(scope) },
    save: async value => { if (!config.available) throw Error('synthetic locked native keyring'); keys.set(scope, value) } })
  const makeStore = () => new ChatGptAuthStore(join(directory, 'chatgpt-auth'), { keyStore, registerSecrets: values => secrets.push(...values) })
  const signIdentity = async (claims = {}, clientId = opened.searchParams.get('client_id')) => new SignJWT({ nonce: opened.searchParams.get('nonce'), email: config.email, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(CHATGPT_ISSUER).setAudience(clientId).setSubject(config.subject)
    .setIssuedAt(Math.floor(now / 1000)).setExpirationTime(Math.floor(now / 1000) + 3600).sign(pair.privateKey)
  const dependencies = {
    fetchFn: async (input, init) => {
      const url = String(input); calls.push({ url, init })
      assert.equal(new URL(url).origin, CHATGPT_ISSUER, 'fixture must never make external requests')
      assert.equal(init.redirect, 'manual'); assert.equal(init.credentials, 'omit')
      if (url === `${CHATGPT_ISSUER}/.well-known/openid-configuration`) return json(config.discovery ?? discovery)
      if (url === discovery.jwks_uri) return json({ keys: [jwk] })
      if (url === discovery.revocation_endpoint) {
        const body = new URLSearchParams(init.body); revocations.push(body)
        return config.revoke ? config.revoke(body, revocations.length) : new Response(null, { status: 200 })
      }
      assert.equal(url, discovery.token_endpoint)
      const body = new URLSearchParams(init.body); tokenBodies.push(body)
      assert.equal(body.get('resource'), CHATGPT_RESOURCE); assert.equal(body.has('client_secret'), false)
      if (body.get('grant_type') === 'refresh_token') {
        refreshCount++; assert.equal(body.has('scope'), false); assert.notEqual(body.get('client_id'), 'dynamic_agent_client')
        return config.refresh ? config.refresh(body, refreshCount) : json({ access_token: `fixture-access-refresh-${refreshCount}`, refresh_token: `fixture-refresh-replacement-${refreshCount}`,
          token_type: 'Bearer', expires_in: 3600, scope: config.scopes })
      }
      tokenCount++
      assert.equal(body.get('grant_type'), 'authorization_code'); assert.notEqual(body.get('client_id'), 'dynamic_agent_client')
      assert.equal(body.get('redirect_uri'), callback.redirectUri)
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), opened.searchParams.get('code_challenge'))
      if (config.exchange) return config.exchange(body, tokenCount)
      const identity = config.identity ? await config.identity({ signIdentity, body, now, opened }) : await signIdentity({}, body.get('client_id'))
      return json({ access_token: `fixture-access-${tokenCount}`, refresh_token: `fixture-refresh-${tokenCount}`, id_token: identity,
        token_type: 'Bearer', expires_in: 3600, scope: config.scopes })
    },
    callback: async options => {
      const result = deferred()
      callback = { ...options, redirectUri: 'http://127.0.0.1:48123/auth/callback', result: result.promise, close: async () => undefined, resolve: result.resolve }
      return callback
    },
    openBrowser: async (url, signal) => {
      assert.equal(signal.aborted, false)
      opened = new URL(url); authorizations.push(opened); authorizeCount++
      assert.equal(opened.origin + opened.pathname, discovery.authorization_endpoint)
      assert.equal(opened.searchParams.get('state'), callback.state)
      assert.equal(opened.searchParams.get('redirect_uri'), callback.redirectUri)
      const selected = opened.searchParams.get('client_id')
      callback.resolve({ code: `fixture-code-${authorizeCount}`, ...(config.omitClient ? {} : { clientId: config.callbackClient ?? (selected === 'dynamic_agent_client' ? `oaiapp_fixture_${authorizeCount}` : selected) }) })
    }
  }
  const make = (extra = {}) => new ChatGptAuthManager({ directory, store: makeStore(), ...dependencies, registerSecrets: values => secrets.push(...values), now: () => now, ...extra })
  return { directory, config, calls, authorizations, tokenBodies, revocations, keys, secrets, make, makeStore, pair, jwk,
    get now() { return now }, advance: milliseconds => { now += milliseconds }, signIdentity,
    get refreshCount() { return refreshCount } }
}

test('official dynamic registration binds PKCE, host, issued client, verified identity and granted scope without legacy credentials', async t => {
  const f = await fixture(t), auth = f.make(), account = await auth.signIn()
  t.after(() => auth.close())
  assert.match(account.id, /^[0-9a-f]{64}$/); assert.equal(account.subject, f.config.subject); assert.equal(account.planUsageEnabled, true)
  assert.equal(account.sessionOnly, false); assert.equal(account.signedIn, true)
  const url = f.authorizations[0]
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client'); assert.equal(url.searchParams.get('agent_name_hint'), 'Vivi')
  assert.match(url.searchParams.get('ext_agent_host_id'), /^urn:uuid:/)
  assert.equal(url.searchParams.get('resource'), CHATGPT_RESOURCE); assert.equal(url.searchParams.get('scope'), CHATGPT_SCOPES.join(' '))
  assert.equal(url.searchParams.get('prompt'), null)
  assert.equal(await auth.accessToken(account.id), 'fixture-access-1')
  assert.equal(JSON.stringify(await auth.listAccounts()).includes('fixture-access'), false)
  const files = await readdir(join(f.directory, 'chatgpt-auth'))
  assert(files.includes(`account-${account.id}.json`)); assert(files.includes('host.json')); assert(files.includes('registrations.json'))
  const bytes = await readFile(join(f.directory, 'chatgpt-auth', `account-${account.id}.json`), 'utf8')
  assert(!bytes.includes('fixture-access')); assert(!bytes.includes('fixture-refresh')); assert(!bytes.includes('fixture@example'))
  if (process.platform !== 'win32') for (const file of files) assert.equal((await stat(join(f.directory, 'chatgpt-auth', file))).mode & 0o077, 0)
  assert(f.secrets.includes('fixture-access-1')); assert(f.secrets.includes('fixture-refresh-1'))
  assert(f.calls.every(call => !/backend-api|auth\.json/.test(call.url)))
})

test('reauthorization reuses the selected issued registration and host, then validates identity before replacing credentials', async t => {
  const f = await fixture(t), first = f.make(), account = await first.signIn()
  await first.markWelcomeSeen(account.id); await first.close()
  const auth = f.make(); t.after(() => auth.close())
  const selected = await auth.signIn({ accountId: account.id })
  assert.equal(selected.id, account.id); assert.equal(selected.welcomeSeen, true)
  const before = f.authorizations[0], after = f.authorizations[1]
  assert.equal(after.searchParams.get('client_id'), account.clientId); assert.equal(after.searchParams.has('agent_name_hint'), false)
  assert.equal(after.searchParams.get('ext_agent_host_id'), before.searchParams.get('ext_agent_host_id'))
  assert(after.searchParams.get('id_token_hint')); assert.equal(after.searchParams.get('login_hint'), account.email)
  assert.notEqual(after.searchParams.get('state'), before.searchParams.get('state')); assert.notEqual(after.searchParams.get('nonce'), before.searchParams.get('nonce'))
  f.config.subject = 'different-fixture-subject'
  await assert.rejects(auth.signIn({ accountId: account.id }), safeError('invalid-identity'))
  assert.equal(await auth.accessToken(account.id), 'fixture-access-2')
})

test('accounts with the same email remain distinct across issued workspace registrations', async t => {
  const f = await fixture(t), auth = f.make(); t.after(() => auth.close())
  const first = await auth.signIn(), second = await auth.signIn()
  assert.equal(first.email, second.email); assert.notEqual(first.clientId, second.clientId); assert.notEqual(first.id, second.id); assert.notEqual(first.label, second.label)
  assert.equal(await auth.accessToken(first.id), 'fixture-access-1'); assert.equal(await auth.accessToken(second.id), 'fixture-access-2')
  await auth.signOut(first.id)
  assert.equal((await auth.listAccounts()).find(account => account.id === second.id).signedIn, true)
})

test('missing direct grant retains verified sign-in but prevents inference and ordinary sign-in does not force consent', async t => {
  const f = await fixture(t, { scopes: 'openid profile email offline_access resource.invoke' }), auth = f.make(); t.after(() => auth.close())
  const account = await auth.signIn()
  assert.equal(account.signedIn, true); assert.equal(account.planUsageEnabled, false)
  await assert.rejects(auth.accessToken(account.id), safeError('plan-usage-disabled'))
  assert.equal((await auth.listAccounts()).length, 1)
  f.config.scopes = CHATGPT_SCOPES.join(' ')
  const enabled = await auth.signIn({ accountId: account.id, enablePlanUsage: true })
  assert.equal(enabled.planUsageEnabled, true); assert.equal(f.authorizations[1].searchParams.get('prompt'), 'consent')
})

test('new callback must supply issued client; returning callback cannot replace selected client', async t => {
  const f = await fixture(t, { omitClient: true }), auth = f.make(); t.after(() => auth.close())
  await assert.rejects(auth.signIn(), safeError('invalid-callback')); assert.equal(f.tokenBodies.length, 0)
  f.config.omitClient = false; const account = await auth.signIn()
  f.config.callbackClient = 'oaiapp_wrong_fixture'
  await assert.rejects(auth.signIn({ accountId: account.id }), safeError('invalid-callback'))
  assert.equal(f.tokenBodies.length, 1); assert.equal(await auth.accessToken(account.id), 'fixture-access-1')
  delete f.config.callbackClient; f.config.omitClient = true
  assert.equal((await auth.signIn({ accountId: account.id })).id, account.id)
})

test('ID token nonce, audience, issuer, expiration and signature are verified before any registration is retained', async t => {
  for (const kind of ['nonce', 'audience', 'issuer', 'expiration', 'signature']) {
    const f = await fixture(t), auth = f.make(); t.after(() => auth.close())
    f.config.identity = async ({ signIdentity, body, now }) => {
      if (kind === 'nonce') return signIdentity({ nonce: 'wrong-fixture-nonce' }, body.get('client_id'))
      if (kind === 'audience') return signIdentity({}, 'wrong-fixture-client')
      const jwt = new SignJWT({ nonce: f.authorizations.at(-1).searchParams.get('nonce') }).setProtectedHeader({ alg: 'RS256', kid: f.jwk.kid })
        .setIssuer(kind === 'issuer' ? 'https://wrong.fixture.invalid' : CHATGPT_ISSUER).setAudience(body.get('client_id')).setSubject(f.config.subject)
        .setIssuedAt(Math.floor(now / 1000)).setExpirationTime(Math.floor(now / 1000) + (kind === 'expiration' ? -60 : 3600))
      return jwt.sign(kind === 'signature' ? (await generateKeyPair('RS256')).privateKey : f.pair.privateKey)
    }
    await assert.rejects(auth.signIn(), safeError('invalid-identity'), kind)
    assert.deepEqual(await auth.listAccounts(), [], kind)
  }
})

test('invalid_grant code retry stays inside one interaction with issued client; later add starts dynamic registration', async t => {
  const f = await fixture(t), auth = f.make(); t.after(() => auth.close())
  f.config.exchange = async (body, count) => {
    if (count === 1) return json({ error: 'invalid_grant' }, 400)
    return json({ access_token: `fixture-access-${count}`, refresh_token: `fixture-refresh-${count}`, id_token: await f.signIdentity({}, body.get('client_id')),
      token_type: 'Bearer', expires_in: 3600, scope: CHATGPT_SCOPES.join(' ') })
  }
  await auth.signIn(); await auth.signIn()
  assert.equal(f.authorizations.length, 3)
  assert.equal(f.authorizations[0].searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(f.authorizations[1].searchParams.get('client_id'), 'oaiapp_fixture_1')
  assert.equal(f.authorizations[1].searchParams.has('agent_name_hint'), false)
  assert.notEqual(f.authorizations[0].searchParams.get('state'), f.authorizations[1].searchParams.get('state'))
  assert.equal(f.authorizations[2].searchParams.get('client_id'), 'dynamic_agent_client')
})

test('secure storage failure never opens browser or silently falls back; explicit session-only persists no tokens and reuses registration after restart', async t => {
  const f = await fixture(t, { available: false }), first = f.make()
  await assert.rejects(first.signIn(), safeError('storage-unavailable')); assert.equal(f.authorizations.length, 0)
  const account = await first.signIn({ sessionOnly: true })
  assert.equal(account.sessionOnly, true); assert.equal(await first.accessToken(account.id), 'fixture-access-1')
  await first.markWelcomeSeen(account.id); await first.close()
  const directory = join(f.directory, 'chatgpt-auth'), files = await readdir(directory)
  assert(!files.some(file => /^account-/.test(file))); assert.equal(f.keys.size, 0)
  const all = (await Promise.all(files.filter(file => file.endsWith('.json')).map(file => readFile(join(directory, file), 'utf8')))).join('')
  assert(!all.includes('fixture-access')); assert(!all.includes('fixture-refresh')); assert(!all.includes('eyJ'))
  const restarted = f.make(); t.after(() => restarted.close())
  const saved = (await restarted.listAccounts())[0]
  assert.equal(saved.id, account.id); assert.equal(saved.signedIn, false); assert.equal(saved.welcomeSeen, true)
  await restarted.signIn({ accountId: saved.id, sessionOnly: true })
  assert.equal(f.authorizations[1].searchParams.get('client_id'), account.clientId)
  assert.equal(f.authorizations[1].searchParams.get('ext_agent_host_id'), f.authorizations[0].searchParams.get('ext_agent_host_id'))
})

test('rotating refresh is serialized, atomic and uses issued client without scope; restart consumes latest replacement', async t => {
  const f = await fixture(t), auth = f.make(); t.after(() => auth.close())
  const account = await auth.signIn(); f.advance(3_601_000)
  const values = await Promise.all([auth.accessToken(account.id), auth.accessToken(account.id)])
  assert.deepEqual(values, ['fixture-access-refresh-1', 'fixture-access-refresh-1']); assert.equal(f.refreshCount, 1)
  const refreshed = (await f.makeStore().readData()).accounts[0]
  assert.equal(refreshed.tokens.refreshToken, 'fixture-refresh-replacement-1'); assert.equal(refreshed.refreshPending, undefined)
  const restarted = f.make(); t.after(() => restarted.close())
  assert.equal(await restarted.accessToken(account.id), 'fixture-access-refresh-1')
})

test('explicit session-only reauthorization replaces saved credentials without reactivating an older token set after exit', async t => {
  const f = await fixture(t), auth = f.make(), account = await auth.signIn()
  const temporary = await auth.signIn({ accountId: account.id, sessionOnly: true })
  assert.equal(temporary.id, account.id); assert.equal(temporary.sessionOnly, true)
  assert.equal(await auth.accessToken(account.id), 'fixture-access-2')
  assert.equal((await f.makeStore().readData()).accounts[0].tokens, undefined)
  await auth.close()
  const restarted = f.make(); t.after(() => restarted.close())
  assert.equal((await restarted.listAccounts())[0].signedIn, false)
  await assert.rejects(restarted.accessToken(account.id), safeError('needs-sign-in'))
})

test('two managers cannot race the same rotating refresh across the native lease', async t => {
  const f = await fixture(t), first = f.make(), second = f.make(); t.after(() => first.close()); t.after(() => second.close())
  const account = await first.signIn(); f.advance(3_601_000)
  const entered = deferred(), release = deferred()
  f.config.refresh = async () => { entered.resolve(); await release.promise; return json({ access_token: 'fixture-access-rotated', refresh_token: 'fixture-refresh-rotated', token_type: 'Bearer', expires_in: 3600 }) }
  const pending = first.accessToken(account.id); await entered.promise
  await assert.rejects(second.accessToken(account.id), safeError('busy'))
  release.resolve(); assert.equal(await pending, 'fixture-access-rotated')
  assert.equal(await second.accessToken(account.id), 'fixture-access-rotated'); assert.equal(f.refreshCount, 1)
})

test('a second process cannot acquire the persisted lease while refresh is in flight', async t => {
  const f = await fixture(t), auth = f.make(); t.after(() => auth.close())
  const account = await auth.signIn(); f.advance(3_601_000)
  const entered = deferred(), release = deferred()
  f.config.refresh = async () => { entered.resolve(); await release.promise; return json({ access_token: 'fixture-access-rotated', refresh_token: 'fixture-refresh-rotated', token_type: 'Bearer', expires_in: 3600 }) }
  const pending = auth.accessToken(account.id); await entered.promise
  const module = new URL('../dist/chatgpt-auth-store.js', import.meta.url).href
  const script = `import { ChatGptAuthStore } from ${JSON.stringify(module)};
    try { await new ChatGptAuthStore(process.argv[1]).hostId(); process.exitCode = 2 }
    catch (error) { process.exitCode = error.code === 'busy' ? 0 : 3 }`
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, join(f.directory, 'chatgpt-auth')], { stdio: 'ignore', env: {} })
      child.once('error', reject); child.once('exit', resolve)
    })
    assert.equal(code, 0)
  } finally { release.resolve(); await pending }
})

test('closing a pending sign-in cancels and settles it without account activation or credential writes', async t => {
  const f = await fixture(t), entered = deferred()
  const auth = f.make({ openBrowser: async (_url, signal) => {
    entered.resolve()
    await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Error('fixture cancelled browser')), { once: true })
      if (signal.aborted) resolve()
    })
  } })
  const pending = auth.signIn(); await entered.promise
  const rejected = assert.rejects(pending, safeError('cancelled'))
  await auth.close(); await rejected
  const fresh = f.make(); t.after(() => fresh.close())
  assert.deepEqual(await fresh.listAccounts(), []); assert.equal(f.tokenBodies.length, 0)
})

test('transient refresh responses retain credentials and allow later renewal; terminal invalid grant clears only selected tokens', async t => {
  const f = await fixture(t), auth = f.make(); t.after(() => auth.close())
  const first = await auth.signIn(), other = await auth.signIn(); f.advance(3_601_000)
  f.config.refresh = async () => json({ error: 'temporarily_unavailable' }, 503)
  await assert.rejects(auth.accessToken(first.id), safeError('network-unavailable'))
  let records = (await f.makeStore().readData()).accounts
  assert(records.find(account => account.id === first.id).tokens); assert.equal(records.find(account => account.id === first.id).refreshPending, undefined)
  f.config.refresh = async () => json({ error: 'invalid_grant' }, 400)
  await assert.rejects(auth.accessToken(first.id), safeError('needs-sign-in'))
  records = (await f.makeStore().readData()).accounts
  assert.equal(records.find(account => account.id === first.id).tokens, undefined); assert(records.find(account => account.id === other.id).tokens)
  assert.equal(records.find(account => account.id === first.id).clientId, first.clientId)
})

test('uncertain refresh preserves encrypted credentials but durable marker prevents replay after restart', async t => {
  const f = await fixture(t), auth = f.make(); t.after(() => auth.close())
  const account = await auth.signIn(); f.advance(3_601_000)
  f.config.refresh = async () => { throw Error('fixture ambiguous transport termination') }
  await assert.rejects(auth.accessToken(account.id), safeError('refresh-unconfirmed'))
  const stored = (await f.makeStore().readData()).accounts[0]
  assert(stored.tokens); assert.equal(stored.refreshPending, true)
  const restarted = f.make(); t.after(() => restarted.close())
  await assert.rejects(restarted.accessToken(account.id), safeError('needs-sign-in')); assert.equal(f.refreshCount, 1)
})

test('invalid refresh client reports a configuration failure without erasing credentials or starting reauthorization', async t => {
  const f = await fixture(t), auth = f.make(); t.after(() => auth.close())
  const account = await auth.signIn(); f.advance(3_601_000)
  f.config.refresh = async () => json({ error: 'invalid_client' }, 400)
  await assert.rejects(auth.accessToken(account.id), safeError('invalid-client'))
  const stored = (await f.makeStore().readData()).accounts[0]
  assert(stored.tokens); assert.equal(stored.refreshPending, undefined); assert.equal(f.authorizations.length, 1)
})

test('refresh identity remains account-bound and an optional refresh nonce must match the original authorization', async t => {
  for (const kind of ['subject', 'nonce']) {
    const f = await fixture(t), auth = f.make(); t.after(() => auth.close())
    const account = await auth.signIn(); f.advance(3_601_000)
    f.config.refresh = async () => {
      if (kind === 'subject') f.config.subject = 'different-fixture-subject'
      return json({ access_token: 'fixture-access-invalid-refresh', refresh_token: 'fixture-refresh-invalid-refresh',
        id_token: await f.signIdentity(kind === 'nonce' ? { nonce: 'different-fixture-nonce' } : {}, account.clientId), token_type: 'Bearer', expires_in: 3600 })
    }
    await assert.rejects(auth.accessToken(account.id), safeError('invalid-identity'))
    const record = (await f.makeStore().readData()).accounts[0]
    assert.equal(record.tokens.accessToken, 'fixture-access-1'); assert.equal(record.refreshPending, true)
  }
})

test('refresh may omit its ID-token nonce while retaining the original nonce for later refresh validation', async t => {
  const f = await fixture(t), auth = f.make(); t.after(() => auth.close())
  const account = await auth.signIn(), nonce = f.authorizations[0].searchParams.get('nonce'); f.advance(3_601_000)
  f.config.refresh = async () => json({ access_token: 'fixture-access-refreshed', refresh_token: 'fixture-refresh-refreshed', token_type: 'Bearer', expires_in: 3600,
    id_token: await new SignJWT({ email: f.config.email }).setProtectedHeader({ alg: 'RS256', kid: f.jwk.kid }).setIssuer(CHATGPT_ISSUER).setAudience(account.clientId)
      .setSubject(account.subject).setIssuedAt(Math.floor(f.now / 1000)).setExpirationTime(Math.floor(f.now / 1000) + 3600).sign(f.pair.privateKey) })
  assert.equal(await auth.accessToken(account.id), 'fixture-access-refreshed')
  assert.equal((await f.makeStore().readData()).accounts[0].tokens.idTokenNonce, nonce)
})

test('sign-out revokes renewable session, clears all token types, retains mapping/host and clears hints for later reauthorization', async t => {
  const f = await fixture(t), auth = f.make(); t.after(() => auth.close())
  const account = await auth.signIn(), result = await auth.signOut(account.id)
  assert.deepEqual(result, { revoked: true }); assert.equal(f.revocations.length, 1)
  assert.equal(f.revocations[0].get('client_id'), account.clientId); assert.equal(f.revocations[0].get('token'), 'fixture-refresh-1')
  assert.equal(f.revocations[0].get('token_type_hint'), 'refresh_token')
  assert.equal((await auth.listAccounts())[0].signedIn, false); assert.equal((await f.makeStore().readData()).accounts[0].tokens, undefined)
  await auth.signIn({ accountId: account.id })
  assert.equal(f.authorizations[1].searchParams.has('id_token_hint'), false)
  assert.equal(f.authorizations[1].searchParams.get('client_id'), account.clientId)
  assert.equal(f.authorizations[1].searchParams.get('ext_agent_host_id'), f.authorizations[0].searchParams.get('ext_agent_host_id'))
})

test('unconfirmed revocation retries with backoff then clears locally; a locked keyring still permits selected-account local sign-out', async t => {
  const f = await fixture(t), auth = f.make(); t.after(() => auth.close())
  const first = await auth.signIn(), second = await auth.signIn()
  f.config.revoke = async () => new Response(null, { status: 503 })
  assert.deepEqual(await auth.signOut(first.id), { revoked: false }); assert.equal(f.revocations.length, 2)
  f.config.available = false
  assert.deepEqual(await auth.signOut(second.id), { revoked: false })
  assert.equal((await f.makeStore().readMetadata()).accounts.length, 2)
  assert(!(await readdir(join(f.directory, 'chatgpt-auth'))).some(file => file === `account-${second.id}.json`))
})

test('loopback callback binds state before denial, accepts issued client, and consumes one result only', async t => {
  const controller = new AbortController(), secrets = [], callback = await listenChatGptCallback({ state: 'fixture-private-state', signal: controller.signal, registerSecrets: values => secrets.push(...values) })
  t.after(() => callback.close())
  const invalid = new URL(callback.redirectUri); invalid.search = new URLSearchParams({ state: 'wrong-state', error: 'access_denied' }).toString()
  assert.equal((await fetch(invalid)).status, 400)
  const valid = new URL(callback.redirectUri); valid.search = new URLSearchParams({ state: 'fixture-private-state', code: 'fixture-code', client_id: 'oaiapp_fixture' }).toString()
  assert.equal((await fetch(valid)).status, 200)
  assert.deepEqual(await callback.result, { code: 'fixture-code', clientId: 'oaiapp_fixture' }); assert.deepEqual(secrets, ['fixture-code'])
  assert.equal((await fetch(valid)).status, 400)
})

test('loopback declined consent and cancellation terminate without exchanging a code', async t => {
  const controller = new AbortController(), callback = await listenChatGptCallback({ state: 'fixture-private-state', signal: controller.signal, registerSecrets() {} })
  t.after(() => callback.close())
  const url = new URL(callback.redirectUri); url.search = new URLSearchParams({ state: 'fixture-private-state', error: 'access_denied' }).toString()
  assert.equal((await fetch(url)).status, 200); await assert.rejects(callback.result, safeError('authorization-denied'))
  const otherController = new AbortController(), other = await listenChatGptCallback({ state: 'fixture-other-state', signal: otherController.signal, registerSecrets() {} })
  t.after(() => other.close()); otherController.abort(); await assert.rejects(other.result, safeError('cancelled'))
})
