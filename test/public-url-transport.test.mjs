// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { X509Certificate } from 'node:crypto'
import { Duplex, PassThrough } from 'node:stream'
import { globalAgent, request as httpsRequest } from 'node:https'
import { createPublicUrlTransport, isPublicUrlAddress, PUBLIC_URL_REQUEST_HEADERS,
  PUBLIC_URL_TRANSPORT_LIMITS, PublicUrlTransportError } from '../dist/public-url-transport.js'

// Every DNS answer and TLS socket is inert. Some fixtures use the real native
// HTTP parser over a controlled in-memory duplex, never a real network socket.
const address = '8.8.8.8', hostname = 'example.com', url = 'https://example.com/selected?ordinary=one'
// Public certificate only, generated offline for identity-matcher fixtures.
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
-----END CERTIFICATE-----
`).toLegacyObject()
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const noData = () => Object.assign(new Error('PRIVATE_NATIVE_MARKER'), { code: 'ENODATA' })
function resolverFixture({ v4 = [address], v6 = [], fail4, fail6, resolve4, resolve6, cancel } = {}) {
  const state = { creates: 0, calls: [], cancels: 0 }
  return { state, createResolver() { state.creates++; return {
    async resolve4(host) { state.calls.push([4, host]); if (resolve4) return resolve4(); if (fail4) throw fail4; return v4 },
    async resolve6(host) { state.calls.push([6, host]); if (resolve6) return resolve6(); if (fail6) throw fail6; return v6 },
    cancel() { state.cancels++; cancel?.() },
  } } }
}
class ControlledTlsSocket extends Duplex {
  constructor({ reply, authorized = true, peer = certificate, remoteAddress = address, remotePort = 443, finishWrites = true } = {}) {
    super(); this.authorized = authorized; this.peer = peer; this.remoteAddress = remoteAddress; this.remotePort = remotePort
    this.encrypted = true; this.connecting = false; this.reply = reply; this.finishWrites = finishWrites
    this.writes = []; this.writeCallbacks = []; this.destroyCalls = 0; this.sentReply = false
  }
  _read() {}
  _write(chunk, _encoding, done) {
    this.writes.push(Buffer.from(chunk))
    if (this.finishWrites) done(); else this.writeCallbacks.push(done)
    if (this.reply && !this.sentReply) { this.sentReply = true; queueMicrotask(() => { if (!this.destroyed) this.push(Buffer.from(this.reply)) }) }
  }
  _destroy(_error, done) { this.destroyCalls++; done() }
  getPeerCertificate() { return this.peer }
  setNoDelay() { return this }
  setKeepAlive() { return this }
  setTimeout() { return this }
  destroySoon() { this.destroy() }
  ready() { this.emit('secureConnect') }
}
function requestInput(controller = new AbortController(), overrides = {}) {
  const evidence = []
  return { controller, evidence, input: { url, hostname, origin: 'https://example.com', address, method: 'GET',
    headers: { ...PUBLIC_URL_REQUEST_HEADERS }, signal: controller.signal, onTransmit() { evidence.push('observed-local-send') },
    assertCurrent() {}, ...overrides } }
}
function rawFixture({ reply = 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello', socketOptions = {}, secure = true } = {}) {
  const socket = new ControlledTlsSocket({ reply, ...socketOptions }), state = { connects: [], requests: [] }
  const dns = resolverFixture()
  const transport = createPublicUrlTransport({ createResolver: dns.createResolver,
    connect(options) { state.connects.push(options); if (secure) queueMicrotask(() => socket.ready()); return socket },
    request(options, callback) { state.requests.push(options); return httpsRequest(options, callback) },
  })
  return { socket, state, transport, dns }
}
async function collect(body) { const chunks = []; for await (const chunk of body) chunks.push(chunk); return Buffer.concat(chunks).toString() }
function boundedFailure(code) { return error => {
  assert(error instanceof PublicUrlTransportError); assert.equal(error.code, code); assert.equal(error.message, code)
  assert.equal(error.cause, undefined); assert(!JSON.stringify(error).includes('PRIVATE_NATIVE_MARKER')); return true
} }

for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860:0:0:0:0:8888']) {
  test(`independent address admission permits global candidate ${ip}`, () => assert.equal(isPublicUrlAddress(ip), true))
}
for (const ip of ['0.1.2.3', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1',
  '192.0.0.1', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '203.0.113.1',
  '::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2001:db8::1', '2001::1', '2002::1', '3fff::1',
  'fe80::1', 'fc00::1', '2606:4700::1%eth0', '', '0177.0.0.1', {}, null]) {
  test(`independent address admission rejects special or malformed ${JSON.stringify(ip)}`, () => assert.equal(isPublicUrlAddress(ip), false))
}

test('DNS reads both complete record families and returns a frozen bounded public list', async () => {
  const dns = resolverFixture({ v4: [address, address], v6: ['2606:4700:4700::1111'] })
  const subject = createPublicUrlTransport({ createResolver: dns.createResolver, connect() { throw Error('no socket') }, request() { throw Error('no request') } })
  const answers = await subject.resolvePublicUrlHost(hostname, new AbortController().signal)
  assert.deepEqual(answers, [address, '2606:4700:4700::1111']); assert(Object.isFrozen(answers))
  assert.deepEqual(dns.state.calls, [[4, hostname], [6, hostname]]); assert.equal(dns.state.cancels, 0)
})
for (const [name, options, code] of [
  ['mixed private v4', { v4: [address, '127.0.0.1'] }, 'non_public_address'],
  ['mixed private v6', { v6: ['::1'] }, 'non_public_address'],
  ['wrong answer family', { v4: ['2606:4700:4700::1111'] }, 'non_public_address'],
  ['too many answers before deduplication', { v4: Array(17).fill(address) }, 'non_public_address'],
  ['partial query error', { fail6: new Error('PRIVATE_NATIVE_MARKER') }, 'dns_error'],
  ['missing both families', { fail4: noData(), fail6: noData() }, 'dns_error'],
]) test(`DNS fails closed for ${name}`, async () => {
  const dns = resolverFixture(options), subject = createPublicUrlTransport({ createResolver: dns.createResolver, connect() {}, request() {} })
  await assert.rejects(subject.resolvePublicUrlHost(hostname, new AbortController().signal), boundedFailure(code))
  assert.equal(dns.state.cancels, 1)
})
test('DNS permits only ENODATA as an absent family, not an arbitrary partial failure', async () => {
  const dns = resolverFixture({ fail6: noData() }), subject = createPublicUrlTransport({ createResolver: dns.createResolver, connect() {}, request() {} })
  assert.deepEqual(await subject.resolvePublicUrlHost(hostname, new AbortController().signal), [address])
})
test('public IP literals do not reveal anything to DNS', async () => {
  const fixture = rawFixture()
  assert.deepEqual(await fixture.transport.resolvePublicUrlHost(address, new AbortController().signal), [address])
  assert.equal(fixture.dns.state.creates, 0)
})
for (const host of ['localhost', 'printer.local', 'service.internal', 'example.home.arpa', 'singlelabel', 'bad..example', '127.0.0.1']) {
  test(`DNS blocks nonpublic host before resolver creation ${host}`, async () => {
    const fixture = rawFixture()
    await assert.rejects(fixture.transport.resolvePublicUrlHost(host, new AbortController().signal), boundedFailure('non_public_host'))
    assert.equal(fixture.dns.state.creates, 0)
  })
}
test('DNS cancellation stops both queries immediately and consumes late native rejections', async () => {
  const held4 = deferred(), held6 = deferred(), dns = resolverFixture({ resolve4: () => held4.promise, resolve6: () => held6.promise })
  const controller = new AbortController(), subject = createPublicUrlTransport({ createResolver: dns.createResolver, connect() {}, request() {} })
  const pending = subject.resolvePublicUrlHost(hostname, controller.signal), rejected = assert.rejects(pending, boundedFailure('cancelled'))
  await tick(); controller.abort(); await rejected
  assert.equal(dns.state.cancels, 1)
  held4.reject(new Error('PRIVATE_NATIVE_MARKER')); held6.reject(new Error('PRIVATE_NATIVE_MARKER')); await tick()
})
test('guard is repeated immediately before each DNS query', async () => {
  let current = true
  const dns = resolverFixture({ resolve4() { current = false; return [address] } })
  const subject = createPublicUrlTransport({ createResolver: dns.createResolver, connect() {}, request() {} })
  await assert.rejects(subject.resolvePublicUrlHost(hostname, new AbortController().signal, () => {
    if (!current) throw new Error('PRIVATE_NATIVE_MARKER')
  }), boundedFailure('stale_owner'))
  assert.deepEqual(dns.state.calls, [[4, hostname]])
})

test('real native HTTPS parser consumes inert TLS bytes with exact IP pinning and original TLS identity', async () => {
  const fixture = rawFixture(), { input, evidence } = requestInput()
  const response = await fixture.transport.requestPublicUrl(input)
  assert.equal(response.status, 200); assert.equal(response.headers['content-type'], 'text/plain')
  assert.equal(await collect(response.body), 'hello'); response.close()
  assert.equal(fixture.socket.destroyCalls, 1); assert.deepEqual(evidence, ['observed-local-send'])
  const tls = fixture.state.connects[0], request = fixture.state.requests[0]
  assert.equal(tls.host, address); assert.equal(tls.port, 443); assert.equal(tls.family, 4); assert.equal(tls.autoSelectFamily, false)
  assert.equal(tls.servername, hostname); assert.equal(tls.rejectUnauthorized, true); assert.equal(tls.minVersion, 'TLSv1.2')
  assert.deepEqual(tls.ALPNProtocols, ['http/1.1']); assert.equal(tls.session, undefined); assert.equal(tls.ca, undefined)
  assert.equal(tls.checkServerIdentity('attacker.example', certificate), undefined)
  assert(tls.checkServerIdentity(hostname, { subjectaltname: 'DNS:attacker.example' }) instanceof Error)
  assert.equal(request.agent, undefined); assert.equal(typeof request.createConnection, 'function'); assert.equal(request.lookup, undefined)
  assert.equal(request.hostname, hostname); assert.equal(request.port, 443); assert.equal(request.method, 'GET')
  assert.equal(request.path, '/selected?ordinary=one'); assert.equal(request.rejectUnauthorized, true)
  assert.equal(request.maxHeaderSize, 16 * 1024); assert.equal(request.insecureHTTPParser, false)
  const wire = Buffer.concat(fixture.socket.writes).toString()
  assert.match(wire, /^GET \/selected\?ordinary=one HTTP\/1\.1\r\n/)
  assert.match(wire, /accept: text\/plain, text\/html, application\/json\r\n/i)
  assert.match(wire, /accept-encoding: identity\r\n/i); assert.match(wire, /host: example.com\r\n/i)
  assert.match(wire, /connection: close\r\n/i)
  assert(!/authorization|cookie|proxy|user-agent|content-length|transfer-encoding/i.test(wire))
})

for (const [name, override, code] of [
  ['private address', { address: '127.0.0.1' }, 'non_public_address'],
  ['different hostname', { hostname: 'other.example' }, 'invalid_request'],
  ['different origin', { origin: 'https://other.example' }, 'invalid_request'],
  ['HTTP URL', { url: 'http://example.com/selected?ordinary=one', origin: 'http://example.com' }, 'invalid_request'],
  ['non443 port', { url: 'https://example.com:8443/', origin: 'https://example.com:8443' }, 'invalid_request'],
  ['URL credentials', { url: 'https://user:pass@example.com/' }, 'invalid_request'],
  ['fragment', { url: 'https://example.com/#private' }, 'invalid_request'],
  ['foreign header', { headers: { ...PUBLIC_URL_REQUEST_HEADERS, authorization: 'PRIVATE_NATIVE_MARKER' } }, 'invalid_request'],
  ['changed encoding', { headers: { ...PUBLIC_URL_REQUEST_HEADERS, 'accept-encoding': 'gzip' } }, 'invalid_request'],
  ['method', { method: 'POST' }, 'invalid_request'],
]) test(`request blocks ${name} before socket creation`, async () => {
  const fixture = rawFixture(), { input, evidence } = requestInput(undefined, override)
  await assert.rejects(fixture.transport.requestPublicUrl(input), boundedFailure(code))
  assert.equal(fixture.state.connects.length, 0); assert.deepEqual(evidence, [])
})
for (const [name, options] of [
  ['untrusted peer', { authorized: false }], ['wrong certificate', { peer: { subjectaltname: 'DNS:other.example' } }],
  ['wrong remote address', { remoteAddress: '1.1.1.1' }], ['wrong remote port', { remotePort: 8443 }],
]) test(`TLS ${name} fails before any HTTP request or transmission evidence`, async () => {
  const fixture = rawFixture({ socketOptions: options }), { input, evidence } = requestInput()
  await assert.rejects(fixture.transport.requestPublicUrl(input), boundedFailure('transport_failed'))
  assert.equal(fixture.state.requests.length, 0); assert.deepEqual(fixture.socket.writes, []); assert.deepEqual(evidence, [])
  assert.equal(fixture.socket.destroyCalls, 1)
})
test('cancellation while TLS connects closes the owned socket and never starts HTTPS', async () => {
  const fixture = rawFixture({ secure: false }), { input, controller, evidence } = requestInput()
  const pending = fixture.transport.requestPublicUrl(input), rejected = assert.rejects(pending, boundedFailure('cancelled'))
  controller.abort(); await rejected; fixture.socket.ready(); await tick()
  assert.equal(fixture.socket.destroyCalls, 1); assert.equal(fixture.state.requests.length, 0); assert.deepEqual(evidence, [])
})
test('ownership change during TLS handshake is rechecked before HTTP construction', async () => {
  let current = true
  const fixture = rawFixture({ secure: false }), { input, evidence } = requestInput(undefined, { assertCurrent() { if (!current) throw new Error('PRIVATE_NATIVE_MARKER') } })
  const pending = fixture.transport.requestPublicUrl(input), rejected = assert.rejects(pending, boundedFailure('stale_owner'))
  current = false; fixture.socket.ready(); await rejected
  assert.equal(fixture.state.requests.length, 0); assert.deepEqual(evidence, [])
})
test('guard immediately before HTTP end blocks mutation during request construction', async () => {
  const socket = new ControlledTlsSocket(), state = { ends: 0 }, request = new EventEmitter(), fixture = requestInput()
  let current = true
  request.destroyed = false; request.destroy = () => { request.destroyed = true }; request.end = () => { state.ends++ }
  const subject = createPublicUrlTransport({ createResolver() {}, connect() { queueMicrotask(() => socket.ready()); return socket },
    request() { current = false; return request } })
  fixture.input.assertCurrent = () => { if (!current) throw new Error('PRIVATE_NATIVE_MARKER') }
  await assert.rejects(subject.requestPublicUrl(fixture.input), boundedFailure('stale_owner'))
  assert.equal(state.ends, 0); assert.deepEqual(fixture.evidence, []); assert.equal(socket.destroyCalls, 1)
})

for (const [name, headers, code] of [
  ['duplicate length', 'Content-Length: 5\r\nContent-Length: 5\r\n', 'transport_failed'],
  ['conflicting framing', 'Content-Length: 5\r\nTransfer-Encoding: chunked\r\n', 'transport_failed'],
  ['duplicate type', 'Content-Type: text/plain\r\nContent-Type: text/html\r\nContent-Length: 5\r\n', 'invalid_response'],
  ['duplicate location', 'Location: /one\r\nLocation: /two\r\nContent-Length: 5\r\n', 'invalid_response'],
  ['duplicate encoding', 'Content-Encoding: identity\r\nContent-Encoding: gzip\r\nContent-Length: 5\r\n', 'invalid_response'],
  ['unsupported framing', 'Transfer-Encoding: gzip\r\n', 'invalid_response'],
  ['trailer declaration', 'Transfer-Encoding: chunked\r\nTrailer: X-Private\r\n', 'invalid_response'],
  ['too-large declaration', `Content-Length: ${PUBLIC_URL_TRANSPORT_LIMITS.bodyBytes + 1}\r\n`, 'body_limit'],
  ['overlarge raw headers', `X-Large: ${'x'.repeat(16 * 1024)}\r\nContent-Length: 5\r\n`, 'transport_failed'],
]) test(`real native framing rejects ${name} without exposing raw errors`, async () => {
  const fixture = rawFixture({ reply: `HTTP/1.1 200 OK\r\n${headers}\r\nhello` }), { input } = requestInput()
  await assert.rejects(fixture.transport.requestPublicUrl(input), boundedFailure(code))
  assert.equal(fixture.socket.destroyCalls, 1)
})
test('duplicate benign fields and inert cookie values remain visible for credential screening', async () => {
  const fixture = rawFixture({ reply: 'HTTP/1.1 200 OK\r\nX-Tag: one\r\nX-Tag: two\r\nSet-Cookie: private=one\r\nSet-Cookie: private=two\r\nContent-Length: 0\r\n\r\n' })
  const response = await fixture.transport.requestPublicUrl(requestInput().input)
  assert.equal(response.headers['x-tag'], 'one, two'); assert.equal(response.headers['set-cookie'], 'private=one, private=two')
  assert.equal(await collect(response.body), '')
})
test('redirect response is returned once, with no follow-up DNS, request, or automatic body read', async () => {
  const fixture = rawFixture({ reply: 'HTTP/1.1 302 Found\r\nLocation: https://other.example/\r\nContent-Length: 999\r\n\r\n' })
  const response = await fixture.transport.requestPublicUrl(requestInput().input)
  assert.equal(response.status, 302); assert.equal(response.headers.location, 'https://other.example/')
  response.close(); response.close(); assert.equal(fixture.socket.destroyCalls, 1)
  assert.equal(fixture.state.requests.length, 1); assert.equal(fixture.dns.state.calls.length, 0)
})
test('streaming body has an independent hard byte cap even without Content-Length', async () => {
  const fixture = rawFixture({ reply: 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\n' })
  const response = await fixture.transport.requestPublicUrl(requestInput().input), pending = collect(response.body)
  const rejected = assert.rejects(pending, boundedFailure('body_limit'))
  fixture.socket.push(Buffer.alloc(PUBLIC_URL_TRANSPORT_LIMITS.bodyBytes + 1, 120)); await rejected
  assert.equal(fixture.socket.destroyCalls, 1)
})
test('body cancellation interrupts a pending iterator without trusting late chunks', async () => {
  const fixture = rawFixture({ reply: 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 999\r\n\r\n' })
  const { input, controller } = requestInput(), response = await fixture.transport.requestPublicUrl(input)
  const pending = collect(response.body), rejected = assert.rejects(pending, boundedFailure('cancelled'))
  await tick(); controller.abort(); await rejected; assert.equal(fixture.socket.destroyCalls, 1)
})
test('body socket/native failure is sanitized after response admission', async () => {
  const fixture = rawFixture({ reply: 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 999\r\n\r\n' })
  const response = await fixture.transport.requestPublicUrl(requestInput().input), pending = collect(response.body)
  const rejected = assert.rejects(pending, boundedFailure('transport_failed'))
  fixture.socket.emit('error', new Error('PRIVATE_NATIVE_MARKER https://private.example/SECRET')); await rejected
})
test('body iterator early return closes response and socket without replay or reuse', async () => {
  const fixture = rawFixture({ reply: 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 999\r\n\r\nhello' })
  const response = await fixture.transport.requestPublicUrl(requestInput().input)
  for await (const chunk of response.body) { assert.equal(Buffer.from(chunk).toString(), 'hello'); break }
  assert.equal(fixture.socket.destroyCalls, 1); response.close()
  await assert.rejects(collect(response.body), boundedFailure('invalid_response'))
})
test('finish evidence waits for native local write completion, never mere end or socket creation', async () => {
  const fixture = rawFixture({ reply: undefined, socketOptions: { reply: undefined, finishWrites: false } }), { input, controller, evidence } = requestInput()
  const pending = fixture.transport.requestPublicUrl(input), rejected = assert.rejects(pending, boundedFailure('cancelled'))
  await tick(); assert.equal(fixture.state.requests.length, 1); assert.deepEqual(evidence, []); assert.equal(fixture.socket.writeCallbacks.length, 1)
  fixture.socket.writeCallbacks[0](); await tick(); assert.deepEqual(evidence, ['observed-local-send'])
  controller.abort(); await rejected
})
test('late response after cancellation is cleaned without reading or resurrecting a result', async () => {
  const socket = new ControlledTlsSocket(), fakeRequest = new EventEmitter(), state = { reads: 0, closes: 0 }; let callback
  fakeRequest.destroyed = false; fakeRequest.destroy = () => { fakeRequest.destroyed = true }; fakeRequest.end = () => {}
  const subject = createPublicUrlTransport({ createResolver() {}, connect() { queueMicrotask(() => socket.ready()); return socket },
    request(_options, onResponse) { callback = onResponse; return fakeRequest } })
  const { input, controller } = requestInput(), pending = subject.requestPublicUrl(input), rejected = assert.rejects(pending, boundedFailure('cancelled'))
  await tick(); controller.abort(); await rejected
  const late = new PassThrough(); late._read = () => { state.reads++ }; late.destroy = () => { state.closes++; return late }
  callback(late); assert.equal(state.closes, 1); assert.equal(state.reads, 0)
})

test('already cancelled work creates neither DNS resolver nor socket', async () => {
  const fixture = rawFixture(), controller = new AbortController(); controller.abort('PRIVATE_NATIVE_MARKER')
  await assert.rejects(fixture.transport.resolvePublicUrlHost(hostname, controller.signal), boundedFailure('cancelled'))
  await assert.rejects(fixture.transport.requestPublicUrl(requestInput(controller).input), boundedFailure('cancelled'))
  assert.equal(fixture.dns.state.creates, 0); assert.equal(fixture.state.connects.length, 0)
})
test('DNS has an independent deadline and cancels an adapter that never settles', { timeout: 6_000 }, async () => {
  const dns = resolverFixture({ resolve4: () => new Promise(() => {}), resolve6: () => new Promise(() => {}) })
  const subject = createPublicUrlTransport({ createResolver: dns.createResolver, connect() {}, request() {} })
  const started = performance.now()
  await assert.rejects(subject.resolvePublicUrlHost(hostname, new AbortController().signal), boundedFailure('dns_error'))
  assert(performance.now() - started >= PUBLIC_URL_TRANSPORT_LIMITS.dnsMilliseconds - 30)
  assert.equal(dns.state.cancels, 1)
})
test('DNS cancellation cleanup failure is surfaced with no native details', async () => {
  const dns = resolverFixture({ resolve4: () => new Promise(() => {}), resolve6: () => new Promise(() => {}),
    cancel() { throw new Error('PRIVATE_NATIVE_MARKER') } })
  const controller = new AbortController(), subject = createPublicUrlTransport({ createResolver: dns.createResolver, connect() {}, request() {} })
  const pending = subject.resolvePublicUrlHost(hostname, controller.signal), rejected = assert.rejects(pending, boundedFailure('cleanup_failed'))
  await tick(); controller.abort(); await rejected; assert.equal(dns.state.cancels, 1)
})
for (const stage of ['resolver creation', 'A query', 'AAAA query', 'TLS connect', 'HTTPS construction']) {
  test(`synchronous dependency error at ${stage} is sanitized`, async () => {
    const fixture = rawFixture(), deps = { createResolver: fixture.dns.createResolver,
      connect(options) { fixture.state.connects.push(options); queueMicrotask(() => fixture.socket.ready()); return fixture.socket },
      request(options, callback) { return httpsRequest(options, callback) } }
    const bad = () => { throw new Error('PRIVATE_NATIVE_MARKER https://private.example/SECRET Authorization: SECRET') }
    if (stage === 'resolver creation') deps.createResolver = bad
    if (stage === 'A query' || stage === 'AAAA query') deps.createResolver = () => ({
      resolve4: stage === 'A query' ? bad : async () => [address], resolve6: stage === 'AAAA query' ? bad : async () => [], cancel() {},
    })
    if (stage === 'TLS connect') deps.connect = bad
    if (stage === 'HTTPS construction') deps.request = bad
    const subject = createPublicUrlTransport(deps)
    if (stage === 'resolver creation' || stage.endsWith('query')) {
      await assert.rejects(subject.resolvePublicUrlHost(hostname, new AbortController().signal), boundedFailure('dns_error'))
    } else await assert.rejects(subject.requestPublicUrl(requestInput().input), boundedFailure('transport_failed'))
  })
}
for (const stage of ['connect', 'request']) test(`cancellation during ${stage} creation cleans the late-owned resource`, async () => {
  const socket = new ControlledTlsSocket(), fakeRequest = new EventEmitter(), { input, controller, evidence } = requestInput()
  let destroys = 0, ends = 0
  fakeRequest.destroyed = false; fakeRequest.destroy = () => { destroys++; fakeRequest.destroyed = true }; fakeRequest.end = () => { ends++ }
  const subject = createPublicUrlTransport({ createResolver() {}, connect() {
    if (stage === 'connect') controller.abort(); else queueMicrotask(() => socket.ready())
    return socket
  }, request() { controller.abort(); return fakeRequest } })
  await assert.rejects(subject.requestPublicUrl(input), boundedFailure('cancelled'))
  assert.equal(socket.destroyCalls, 1); assert.equal(destroys, stage === 'request' ? 1 : 0); assert.equal(ends, 0); assert.deepEqual(evidence, [])
})
test('native informational response is rejected before final headers and cannot create extra metadata work', async () => {
  const fixture = rawFixture({ reply: 'HTTP/1.1 103 Early Hints\r\nLink: </unsafe>; rel=preload\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello' })
  await assert.rejects(fixture.transport.requestPublicUrl(requestInput().input), boundedFailure('invalid_response'))
  assert.equal(fixture.socket.destroyCalls, 1)
})
test('undeclared chunked trailers fail before EOF is accepted', async () => {
  const fixture = rawFixture({ reply: 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\nX-Private: PRIVATE_NATIVE_MARKER\r\n\r\n' })
  const response = await fixture.transport.requestPublicUrl(requestInput().input)
  await assert.rejects(collect(response.body), boundedFailure('invalid_response'))
})
test('peer EOF before declared length cannot be reported as completed retrieval', async () => {
  const fixture = rawFixture({ reply: 'HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\nhello' })
  const response = await fixture.transport.requestPublicUrl(requestInput().input), pending = collect(response.body)
  const rejected = assert.rejects(pending, boundedFailure('transport_failed'))
  fixture.socket.push(null); await rejected
})
test('closing after admission interrupts a pending body iterator and is idempotent', async () => {
  const fixture = rawFixture({ reply: 'HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n' })
  const response = await fixture.transport.requestPublicUrl(requestInput().input), pending = collect(response.body)
  const rejected = assert.rejects(pending, boundedFailure('cancelled'))
  await tick(); response.close(); response.close(); await rejected
  assert.equal(fixture.socket.destroyCalls, 1)
})
test('guard rejection during response admission cleans headers without body consumption', async () => {
  const socket = new ControlledTlsSocket(), fakeRequest = new EventEmitter(); let callback, current = true, reads = 0
  fakeRequest.destroyed = false; fakeRequest.destroy = () => { fakeRequest.destroyed = true }; fakeRequest.end = () => {}
  const subject = createPublicUrlTransport({ createResolver() {}, connect() { queueMicrotask(() => socket.ready()); return socket },
    request(_options, onResponse) { callback = onResponse; return fakeRequest } })
  const { input } = requestInput(undefined, { assertCurrent() { if (!current) throw new PublicUrlTransportError('known_secret') } })
  const pending = subject.requestPublicUrl(input), rejected = assert.rejects(pending, boundedFailure('known_secret'))
  await tick(); current = false
  const response = new PassThrough(); response._read = () => { reads++ }
  callback(response); await rejected; assert.equal(reads, 0); assert.equal(response.destroyed, true); assert.equal(socket.destroyCalls, 1)
})
test('request validation cannot leak a throwing input header getter', async () => {
  const headers = { ...PUBLIC_URL_REQUEST_HEADERS }; Object.defineProperty(headers, 'accept', { enumerable: true, get() { throw new Error('PRIVATE_NATIVE_MARKER') } })
  const fixture = rawFixture()
  await assert.rejects(fixture.transport.requestPublicUrl(requestInput(undefined, { headers }).input), boundedFailure('invalid_request'))
  assert.equal(fixture.state.connects.length, 0)
})
test('an IPv6 literal connects directly with numeric family, no SNI, and original IP certificate verification', async () => {
  const ip = '2606:4700:4700::1111'
  const fixture = rawFixture({ socketOptions: { remoteAddress: '2606:4700:4700:0:0:0:0:1111', peer: certificate } })
  const response = await fixture.transport.requestPublicUrl(requestInput(undefined, {
    url: `https://[${ip}]/`, hostname: ip, origin: `https://[${ip}]`, address: ip,
  }).input)
  assert.equal(await collect(response.body), 'hello')
  assert.equal(fixture.state.connects[0].family, 6); assert.equal(fixture.state.connects[0].servername, '')
  assert.match(Buffer.concat(fixture.socket.writes).toString(), /host: \[2606:4700:4700::1111\]\r\n/i)
})
test('cleanup failure on iterator return is never hidden behind a successful early break', async () => {
  const socket = new ControlledTlsSocket(), fakeRequest = new EventEmitter(); let callback
  fakeRequest.destroyed = false; fakeRequest.destroy = () => { fakeRequest.destroyed = true }; fakeRequest.end = () => {}
  const subject = createPublicUrlTransport({ createResolver() {}, connect() { queueMicrotask(() => socket.ready()); return socket },
    request(_options, onResponse) { callback = onResponse; return fakeRequest } })
  const pending = subject.requestPublicUrl(requestInput().input); await tick()
  const response = new PassThrough(); response.statusCode = 200; response.statusMessage = 'OK'; response.httpVersion = '1.1'
  response.rawHeaders = ['Content-Length', '999']; response.rawTrailers = []; response.complete = false
  response.destroy = () => { throw new Error('PRIVATE_NATIVE_MARKER') }; callback(response)
  const owned = await pending, iterator = owned.body[Symbol.asyncIterator](), first = iterator.next()
  response.write('hello'); assert.equal(Buffer.from((await first).value).toString(), 'hello')
  await assert.rejects(iterator.return(), boundedFailure('cleanup_failed')); assert.equal(socket.destroyCalls, 1)
  assert.throws(() => owned.close(), boundedFailure('cleanup_failed'))
})

test('a poisoned global HTTPS agent is never consulted by the direct socket request', async () => {
  const previous = globalAgent.addRequest; let uses = 0
  globalAgent.addRequest = () => { uses++; throw new Error('PRIVATE_NATIVE_MARKER ambient agent must not run') }
  try {
    const fixture = rawFixture(), response = await fixture.transport.requestPublicUrl(requestInput().input)
    assert.equal(await collect(response.body), 'hello'); assert.equal(uses, 0)
  } finally { globalAgent.addRequest = previous }
})
test('cancellation during native response-header wait stops the socket without a retry', async () => {
  const fixture = rawFixture({ reply: 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n' }), { input, controller, evidence } = requestInput()
  const pending = fixture.transport.requestPublicUrl(input), rejected = assert.rejects(pending, boundedFailure('cancelled'))
  await tick(); assert.deepEqual(evidence, ['observed-local-send']); controller.abort(); await rejected
  assert.equal(fixture.socket.destroyCalls, 1); assert.equal(fixture.state.connects.length, 1); assert.equal(fixture.state.requests.length, 1)
})
for (const [name, peer] of [
  ['a text-only invented IPv6 SAN', { subjectaltname: 'IP Address:2001:4860:4860::8888' }],
  ['a valid certificate for a different IP', certificate],
]) test(`original IPv6 identity rejects ${name}`, async () => {
  const ip = '2001:4860:4860::8888', fixture = rawFixture({ socketOptions: { remoteAddress: ip, peer } })
  const { input, evidence } = requestInput(undefined, { url: `https://[${ip}]/`, hostname: ip, origin: `https://[${ip}]`, address: ip })
  await assert.rejects(fixture.transport.requestPublicUrl(input), boundedFailure('transport_failed'))
  assert.equal(fixture.state.requests.length, 0); assert.deepEqual(evidence, []); assert.equal(fixture.socket.destroyCalls, 1)
})
