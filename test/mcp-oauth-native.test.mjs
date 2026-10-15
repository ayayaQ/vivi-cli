// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { X509Certificate } from 'node:crypto'
import { Agent, request as httpsRequest } from 'node:https'
import { createMcpOAuthNativeFetch, MCP_OAUTH_NATIVE_LIMITS } from '../dist/mcp-oauth-native.js'
import { createPublicUrlTransport } from '../dist/public-url-transport.js'
import { McpOAuthError } from '../dist/mcp-oauth-callback.js'

// All DNS and sockets below are offline fixtures. This public certificate has
// example.com, 8.8.8.8 and 2606:4700:4700::1111 SANs; no private key is needed.
const certificate = new X509Certificate(`-----BEGIN CERTIFICATE-----
MIIBtDCCAVmgAwIBAgIUOkE8kLXTdiKMWkJhYb8oiebrF8cwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLZXhhbXBsZS5jb20wHhcNMjYxMDEwMjM0ODQyWhcNMzYxMDA3
MjM0ODQyWjAWMRQwEgYDVQQDDAtleGFtcGxlLmNvbTBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABEhXsCxGjS325ehaoZ4SwKEeeKnxE5OrNd48atKffa528YeksiC8
J2kohs26D3FWp9fOwW6CVgv3fla2xp1vo4OjgYQwgYEwHQYDVR0OBBYEFLv1Z9Tl
K2biEAB2CbBsKu96Z2WQMB8GA1UdIwQYMBaAFLv1Z9TlK2biEAB2CbBsKu96Z2WQ
MA8GA1UdEwEB/wQFMAMBAf8wLgYDVR0RBCcwJYILZXhhbXBsZS5jb22HBAgICAiH
ECYGRwBHAAAAAAAAAAAAEREwCgYIKoZIzj0EAwIDSQAwRgIhAK4Q42ti2pAehasW
97HRgEIKtCXT4KqQLt1BYWfYyReGAiEAoMopWjwpV54vUr6QDNVNH22BWty/DGd2
D4NVw3nUtbw=
-----END CERTIFICATE-----`).toLegacyObject()
const url = 'https://example.com/token', address = '8.8.8.8'
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
function safeFailure(code = 'authorization-failed') { return error => {
  assert(error instanceof McpOAuthError); assert.equal(error.code, code); assert.equal(error.cause, undefined)
  assert(!error.message.includes('PRIVATE_NATIVE_MARKER')); assert(!JSON.stringify(error).includes('PRIVATE_NATIVE_MARKER')); return true
} }
class TlsFixture extends Duplex {
  constructor({ remoteAddress = address, remotePort = 443, authorized = true, peer = certificate, reply } = {}) {
    super(); this.remoteAddress = remoteAddress; this.remotePort = remotePort; this.authorized = authorized; this.peer = peer
    this.encrypted = true; this.connecting = false; this.reply = reply; this.writes = []; this.destroyCalls = 0
  }
  _read() {}
  _write(chunk, _encoding, done) {
    this.writes.push(Buffer.from(chunk)); done()
    if (this.reply) { const reply = this.reply; this.reply = undefined; queueMicrotask(() => { if (!this.destroyed) this.push(Buffer.from(reply)) }) }
  }
  _destroy(_error, done) { this.destroyCalls++; done() }
  getPeerCertificate() { return this.peer }
  setNoDelay() { return this }
  setKeepAlive() { return this }
  setTimeout() { return this }
  destroySoon() { this.destroy() }
}
function fixture({ answers = [address], socketOptions = {}, secure = true, body = '{"ok":true}',
  status = 200, rawHeaders, deadlineMs, resolveHost, requestHook, reply = true } = {}) {
  const socket = new TlsFixture(socketOptions), state = { lookups: [], requests: [], ends: [], responses: [], dnsSignals: [] }
  let responseCallback
  const request = new EventEmitter()
  request.destroyed = false; request.destroyCalls = 0
  request.destroy = () => { request.destroyed = true; request.destroyCalls++; return request }
  request.end = value => {
    state.ends.push(value)
    if (reply) queueMicrotask(() => {
      const response = new PassThrough(); response.statusCode = status; response.statusMessage = 'OK'; response.httpVersion = '1.1'
      response.rawHeaders = rawHeaders ?? ['Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(body))]
      response.rawTrailers = []; response.complete = true; state.responses.push(response); responseCallback(response); response.end(body)
    })
  }
  const fetchFn = createMcpOAuthNativeFetch({
    async resolvePublicUrlHost(hostname, signal, guard) {
      state.lookups.push(hostname); state.dnsSignals.push(signal); guard?.()
      return resolveHost ? resolveHost(hostname, signal) : answers
    },
    request(options, callback) {
      state.requests.push(options); responseCallback = callback; requestHook?.(options, callback, request)
      queueMicrotask(() => { request.emit('socket', socket); if (secure) socket.emit('secureConnect') })
      return request
    },
  }, deadlineMs === undefined ? {} : { deadlineMs })
  return { fetchFn, state, request, socket, lateResponse(response) { responseCallback(response) } }
}

test('native OAuth GET resolves each invocation and fails closed when DNS later becomes private', async () => {
  let lookups = 0
  const f = fixture({ resolveHost: async () => ++lookups === 1 ? [address] : [address, '127.0.0.1'] })
  assert.deepEqual(await (await f.fetchFn(url)).json(), { ok: true })
  await assert.rejects(f.fetchFn(url), safeFailure())
  assert.deepEqual(f.state.lookups, ['example.com', 'example.com']); assert.equal(f.state.requests.length, 1)
  const options = f.state.requests[0]
  assert.equal(options.agent, false); assert.equal(options.rejectUnauthorized, true); assert.equal(options.servername, 'example.com')
  assert.equal(options.autoSelectFamily, false); assert.equal(options.family, 4); assert.equal(options.port, 443)
  assert.equal(options.insecureHTTPParser, false); assert.equal(options.maxHeaderSize, 16384)
  assert.equal(options.headers.host, 'example.com'); assert.equal(options.headers.connection, 'close')
  assert.equal(options.headers['accept-encoding'], 'identity'); assert.equal(options.method, 'GET')
})

test('native failures identify fixed DNS, TLS, request and response phases without native error text', async t => {
  for (const phase of ['dns', 'tls', 'request', 'response']) await t.test(phase, async () => {
    const f = fixture(phase === 'dns' ? { resolveHost() { throw new Error('PRIVATE_NATIVE_MARKER') } }
      : phase === 'tls' ? { socketOptions: { authorized: false } }
      : phase === 'request' ? { reply: false } : { rawHeaders: ['Content-Length', '65537'] })
    const pending = f.fetchFn(url, { method: 'POST', body: '{}' })
    if (phase === 'request') { await tick(); f.request.emit('error', new Error('PRIVATE_NATIVE_MARKER')) }
    await assert.rejects(pending, error => {
      assert.equal(error.networkPhase, phase); return safeFailure()(error)
    })
    assert.equal(f.state.ends.length, phase === 'dns' || phase === 'tls' ? 0 : 1)
    assert.equal(f.state.requests.length, phase === 'dns' ? 0 : 1)
  })
})
test('POST HTTP bytes wait for strict TLS and peer-IP checks; SDK form bodies are bounded strings', async () => {
  const f = fixture({ secure: false }), pending = f.fetchFn(url, { method: 'POST', credentials: 'omit', redirect: 'manual',
    headers: new Headers({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }),
    body: new URLSearchParams({ code: 'offline-code', code_verifier: 'offline-verifier' }) })
  await tick(); assert.deepEqual(f.state.ends, []); assert.equal(f.state.requests.length, 1)
  f.socket.emit('secureConnect'); await pending
  assert.deepEqual(f.state.ends, ['code=offline-code&code_verifier=offline-verifier'])
  assert.equal(f.state.requests[0].headers['content-length'], String(Buffer.byteLength(f.state.ends[0])))
  assert(f.socket.destroyed); assert(f.request.destroyed)
})
test('pinned lookup never re-resolves or selects another address after the initial complete check', async () => {
  const f = fixture({ secure: false, answers: [address, '1.1.1.1'] }), pending = f.fetchFn(url, { method: 'POST', body: '{}' })
  await tick()
  const lookup = f.state.requests[0].lookup
  for (const hostname of ['example.com', 'rebound.invalid']) lookup(hostname, {}, (error, ip, family) => {
    assert.equal(error, null); assert.equal(ip, address); assert.equal(family, 4)
  })
  lookup('example.com', { all: true }, (error, ips) => { assert.equal(error, null); assert.deepEqual(ips, [{ address, family: 4 }]) })
  assert.deepEqual(f.state.lookups, ['example.com']); f.socket.emit('secureConnect'); await pending
})
for (const [name, socketOptions] of [
  ['private rebound peer', { remoteAddress: '127.0.0.1' }], ['different public peer', { remoteAddress: '1.1.1.1' }],
  ['wrong port', { remotePort: 444 }], ['untrusted chain', { authorized: false }],
  ['hostname mismatch', { peer: { subjectaltname: 'DNS:other.example', subject: { CN: 'example.com' } } }],
  ['absent certificate', { peer: {} }],
]) test(`POST sends nothing for ${name}`, async () => {
  const f = fixture({ socketOptions })
  await assert.rejects(f.fetchFn(url, { method: 'POST', body: '{"client_name":"offline"}' }), safeFailure())
  assert.deepEqual(f.state.ends, []); assert.equal(f.state.requests.length, 1); assert(f.socket.destroyed); assert(f.request.destroyed)
})
for (const answers of [[address, '127.0.0.1'], [address, '::1'], [], Array(17).fill(address), ['not-an-ip']]) {
  test(`all DNS answers must be public and bounded: ${JSON.stringify(answers)}`, async () => {
    const f = fixture({ answers }); await assert.rejects(f.fetchFn(url, { method: 'POST', body: '{}' }), safeFailure())
    assert.deepEqual(f.state.requests, []); assert.deepEqual(f.state.ends, [])
  })
}
test('native helper uses the shared resolver full A/AAAA admission before allocating any request', async () => {
  const calls = [], transport = createPublicUrlTransport({ createResolver: () => ({
    async resolve4(host) { calls.push([4, host]); return [address] },
    async resolve6(host) { calls.push([6, host]); return ['::1'] }, cancel() { calls.push('cancel') },
  }), connect() { assert.fail('No TLS allowed') }, request() { assert.fail('No GET request allowed') } })
  const fetchFn = createMcpOAuthNativeFetch({ resolvePublicUrlHost: transport.resolvePublicUrlHost,
    request() { assert.fail('No OAuth HTTP request allowed') } })
  await assert.rejects(fetchFn(url, { method: 'POST', body: '{}' }), safeFailure())
  assert.deepEqual(calls, [[4, 'example.com'], [6, 'example.com'], 'cancel'])
})
for (const value of ['http://example.com/token', 'https://127.0.0.1/token', 'https://example.local/token',
  'https://name:password@example.com/token', 'https://example.com/token?x=1', 'https://example.com/token#x']) {
  test(`invalid OAuth endpoint never resolves or transmits: ${value}`, async () => {
    const f = fixture(); await assert.rejects(f.fetchFn(value, { method: 'POST', body: '{}' }), safeFailure())
    assert.deepEqual(f.state.lookups, []); assert.deepEqual(f.state.requests, [])
  })
}
test('public IPv4 and IPv6 literals require exact IP-SAN matches and retain pinned identities', async () => {
  for (const ip of [address, '2606:4700:4700::1111']) {
    const f = fixture({ answers: [ip], socketOptions: { remoteAddress: ip } })
    await f.fetchFn(`https://${ip.includes(':') ? `[${ip}]` : ip}/token`, { method: 'POST', body: '{}' })
    assert.equal(f.state.requests[0].servername, ''); assert.equal(f.state.ends.length, 1)
  }
  const f = fixture({ answers: ['2606:4700:4700::1111'], socketOptions: { remoteAddress: '2606:4700:4700::1111', peer: { raw: Buffer.from('invalid') } } })
  await assert.rejects(f.fetchFn('https://[2606:4700:4700::1111]/token', { method: 'POST', body: '{}' }), safeFailure())
  assert.deepEqual(f.state.ends, [])
})
test('pre-abort, DNS cancellation, and late DNS resolution cannot create requests', async () => {
  const controller = new AbortController(); controller.abort(); const f = fixture()
  await assert.rejects(f.fetchFn(url, { signal: controller.signal }), safeFailure('cancelled')); assert.deepEqual(f.state.lookups, [])
  const controller2 = new AbortController(), dns = deferred(), late = fixture({ resolveHost: () => dns.promise })
  const pending = late.fetchFn(url, { signal: controller2.signal }); controller2.abort()
  await assert.rejects(pending, safeFailure('cancelled')); dns.resolve([address]); await tick()
  assert(late.state.dnsSignals[0].aborted); assert.deepEqual(late.state.requests, [])
})
test('cancellation before TLS authorization destroys resources and late response cannot escape', async () => {
  const controller = new AbortController(), f = fixture({ secure: false }), pending = f.fetchFn(url, { method: 'POST', body: '{}', signal: controller.signal })
  await tick(); controller.abort(); await assert.rejects(pending, safeFailure('cancelled')); f.socket.emit('secureConnect')
  assert.deepEqual(f.state.ends, []); assert(f.request.destroyed); assert(f.socket.destroyed)
  const late = new PassThrough(); f.lateResponse(late); assert(late.destroyed)
})
test('cancellation during request creation still destroys a late-owned request and socket', async () => {
  const controller = new AbortController(), f = fixture({ requestHook() { controller.abort() } })
  await assert.rejects(f.fetchFn(url, { signal: controller.signal }), safeFailure('cancelled')); await tick()
  assert(f.request.destroyed); assert(f.socket.destroyed); assert.deepEqual(f.state.ends, [])
})
test('maximum deadline includes stalled DNS and stalled TLS and cannot be widened', async () => {
  assert.throws(() => createMcpOAuthNativeFetch(undefined, { deadlineMs: 15001 }), safeFailure())
  const dns = fixture({ resolveHost: () => new Promise(() => {}), deadlineMs: 10 })
  await assert.rejects(dns.fetchFn(url), safeFailure('timeout')); assert(dns.state.dnsSignals[0].aborted); assert.deepEqual(dns.state.requests, [])
  const tls = fixture({ secure: false, deadlineMs: 10 })
  await assert.rejects(tls.fetchFn(url, { method: 'POST', body: '{}' }), safeFailure('timeout'))
  assert(tls.socket.destroyed); assert(tls.request.destroyed); assert.deepEqual(tls.state.ends, [])
})
test('deadline and cancellation cover an incomplete body after an approved single POST', async () => {
  for (const cancel of [false, true]) {
    const controller = new AbortController(), f = fixture({ reply: false, deadlineMs: 20 })
    const pending = f.fetchFn(url, { method: 'POST', body: '{}', signal: controller.signal })
    await tick()
    const response = new PassThrough(); response.statusCode = 200; response.statusMessage = 'OK'; response.httpVersion = '1.1'
    response.rawHeaders = ['Content-Type', 'application/json']; response.rawTrailers = []; response.complete = false
    f.lateResponse(response); response.write('{"incomplete":'); if (cancel) controller.abort()
    await assert.rejects(pending, safeFailure(cancel ? 'cancelled' : 'timeout'))
    assert(response.destroyed); assert(f.socket.destroyed); assert(f.request.destroyed); assert.deepEqual(f.state.ends, ['{}'])
  }
})
test('a premature response during request construction fails closed and late-owned request is destroyed', async () => {
  const response = new PassThrough(), f = fixture({ requestHook(_options, callback) { callback(response) } })
  await assert.rejects(f.fetchFn(url, { method: 'POST', body: '{}' }), safeFailure()); await tick()
  assert(response.destroyed); assert(f.request.destroyed); assert(f.socket.destroyed); assert.deepEqual(f.state.ends, [])
})
test('transport failure is sanitized and does not retry any IP or POST', async () => {
  const f = fixture({ secure: false, answers: [address, '1.1.1.1'] }), pending = f.fetchFn(url, { method: 'POST', body: '{}' })
  await tick(); f.request.emit('error', new Error('PRIVATE_NATIVE_MARKER')); await assert.rejects(pending, safeFailure())
  await tick(); assert.equal(f.state.requests.length, 1); assert.equal(f.state.lookups.length, 1); assert.deepEqual(f.state.ends, [])
})
for (const [name, init] of [
  ['unsupported method', { method: 'PUT' }], ['GET body', { body: '{}' }], ['stream body', { method: 'POST', body: new PassThrough() }],
  ['oversized UTF-8 body', { method: 'POST', body: 'é'.repeat(32769) }], ['oversized headers', { headers: { 'X-Test': 'x'.repeat(16384) } }],
  ['credential mode', { credentials: 'include' }], ['redirect mode', { redirect: 'follow' }],
  ...['Cookie', 'Authorization', 'Host', 'Content-Length', 'Transfer-Encoding', 'Expect', 'Connection'].map(name => [name, { headers: { [name]: 'private' } }]),
  ['header injection', { headers: { 'X-Test': 'valid\r\nCookie: private' } }], ['compressed request', { headers: { 'Accept-Encoding': 'gzip' } }],
]) test(`unsupported or unbounded input fails before DNS: ${name}`, async () => {
  const f = fixture(); await assert.rejects(f.fetchFn(url, init), safeFailure()); assert.deepEqual(f.state.lookups, []); assert.deepEqual(f.state.ends, [])
})
for (const [name, options] of [
  ['redirect', { status: 302 }], ['oversized Content-Length', { rawHeaders: ['Content-Length', '65537'] }],
  ['oversized streamed body', { body: 'x'.repeat(65537), rawHeaders: ['Content-Type', 'application/json'] }],
  ['oversized raw header', { rawHeaders: ['X-Test', 'x'.repeat(16384)] }],
  ['duplicate Content-Length', { rawHeaders: ['Content-Length', '11', 'content-length', '11'] }],
  ['ambiguous framing', { rawHeaders: ['Content-Length', '11', 'Transfer-Encoding', 'chunked'] }],
  ['compression', { rawHeaders: ['Content-Encoding', 'gzip'] }], ['trailer promise', { rawHeaders: ['Trailer', 'X-End'] }],
  ['mismatched length', { rawHeaders: ['Content-Length', '12'] }],
]) test(`response is bounded and fails closed: ${name}`, async () => {
  const f = fixture(options); await assert.rejects(f.fetchFn(url, { method: 'POST', body: '{}' }), safeFailure())
  assert.equal(f.state.ends.length, 1); assert.equal(f.state.requests.length, 1); assert(f.state.responses[0].destroyed)
})
test('body limit admits exactly 64 KiB and response cookies never become request authority', async () => {
  const body = 'x'.repeat(MCP_OAUTH_NATIVE_LIMITS.bodyBytes), f = fixture({ body, rawHeaders: ['Content-Length', String(body.length), 'Set-Cookie', 'private=fixture'] })
  assert.equal((await (await f.fetchFn(url, { method: 'POST', body })).text()).length, body.length)
  assert.equal(f.state.requests[0].headers.cookie, undefined)
})
test('real native HTTP parser over an inert TLS duplex sends one bounded POST only after secureConnect', async () => {
  const socket = new TlsFixture({ reply: 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"ok":true}' }), calls = []
  const fetchFn = createMcpOAuthNativeFetch({ async resolvePublicUrlHost() { return [address] },
    request(options, callback) {
      calls.push(options); assert.equal(options.agent, false)
      // Native parser, but replace socket creation with our in-memory duplex.
      return httpsRequest({ ...options, agent: undefined, createConnection: () => socket }, callback)
    },
  })
  const pending = fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  await tick(); assert.equal(socket.writes.length, 0); socket.emit('secureConnect')
  assert.deepEqual(await (await pending).json(), { ok: true }); assert.equal(calls.length, 1)
  const wire = Buffer.concat(socket.writes).toString(); assert(wire.startsWith('POST /token HTTP/1.1\r\n'))
  assert(wire.includes('content-length: 2\r\n')); assert(wire.endsWith('\r\n\r\n{}')); assert(socket.destroyed)
})
test('agent:false native path allocates a fresh agent and carries pinned lookup and strict TLS options to socket creation', async () => {
  const original = Agent.prototype.createConnection, sockets = [], agents = [], tlsOptions = []
  // Only replace the TLS-creation leaf, keeping the actual Node https agent,
  // request, parser and byte queue. This cannot open a real socket.
  Agent.prototype.createConnection = function(options) {
    tlsOptions.push(options); agents.push(this)
    options.lookup(options.host, { all: true }, (error, answers) => {
      assert.equal(error, null); assert.deepEqual(answers, [{ address, family: 4 }])
    })
    const socket = new TlsFixture({ reply: 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}' }); sockets.push(socket)
    setImmediate(() => { assert.equal(socket.writes.length, 0); socket.emit('secureConnect') })
    return socket
  }
  try {
    const fetchFn = createMcpOAuthNativeFetch({ async resolvePublicUrlHost() { return [address] }, request: httpsRequest })
    await fetchFn(url, { method: 'POST', body: '{}' }); await fetchFn(url, { method: 'POST', body: '{}' })
    assert.equal(sockets.length, 2); assert.notEqual(agents[0], agents[1])
    for (let i = 0; i < sockets.length; i++) {
      assert.equal(agents[i].keepAlive, false); assert.equal(tlsOptions[i].rejectUnauthorized, true)
      assert.equal(tlsOptions[i].servername, 'example.com'); assert.equal(tlsOptions[i].autoSelectFamily, false)
      assert.deepEqual(tlsOptions[i].ALPNProtocols, ['http/1.1']); assert(sockets[i].destroyed)
      assert(Buffer.concat(sockets[i].writes).toString().endsWith('\r\n\r\n{}'))
    }
  } finally { Agent.prototype.createConnection = original }
})

test('explicit approved public HTTPS port is pinned and peer-checked without changing public URL tool policy', async () => {
  const f = fixture({ socketOptions: { remotePort: 8443 } })
  assert.deepEqual(await (await f.fetchFn('https://example.com:8443/token', { method: 'POST', body: 'code=fixture' })).json(), { ok: true })
  assert.equal(f.state.requests[0].port, 8443)
  assert.equal(f.state.requests[0].headers.host, 'example.com:8443')
  const wrong = fixture()
  await assert.rejects(wrong.fetchFn('https://example.com:8443/token', { method: 'POST', body: 'code=fixture' }), safeFailure())
  assert.equal(wrong.state.ends.length, 0)
})
