// SPDX-License-Identifier: Apache-2.0
// Offline native-codec fixtures only; no browser, DNS, server or provider calls.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { gzipSync, brotliCompressSync, deflateSync, deflateRawSync,
  Gunzip, BrotliDecompress, Inflate } from 'node:zlib'
import { fetchPublicUrl, PUBLIC_URL_LIMITS } from '../dist/public-url.js'
import { PublicUrlTransportError } from '../dist/public-url-transport.js'

const url = 'https://example.com/selected', tick = () => new Promise(resolve => setImmediate(resolve))
const codecs = [['gzip', gzipSync, Gunzip], ['br', brotliCompressSync, BrotliDecompress], ['deflate', deflateSync, Inflate]]
function fixture(wire, encoding, { headers = {}, status = 200, body, close, adapters = {} } = {}) {
  const state = { requests: 0, closes: 0, pulls: 0 }
  return { state, run: options => fetchPublicUrl(url, {
    approve: async () => true, resolve: async () => ['8.8.8.8'],
    async request(request) {
      state.requests++; request.onTransmit()
      return { status, headers: { 'content-type': 'text/plain; charset=utf-8',
        ...(encoding === undefined ? {} : { 'content-encoding': encoding }), ...headers },
        body: body ?? { async *[Symbol.asyncIterator]() {
          for (let offset = 0; offset < wire.length; offset += 7) { state.pulls++; yield wire.subarray(offset, offset + 7) }
        } }, close() { state.closes++; close?.() } }
    }, ...adapters,
  }, options) }
}
function failed(result, code, stage) {
  assert.equal(result.success, false); assert.equal(result.error.code, code)
  assert.equal(result.failureStage, stage); assert.equal(result.doNotRetry, true)
  assert.equal(result.serverEffects, 'unknown'); assert.equal(result.text, undefined)
  assert(Buffer.byteLength(JSON.stringify(result)) <= PUBLIC_URL_LIMITS.resultBytes)
}
for (const [encoding, compress, Decoder] of codecs) {
  test(`${encoding} decodes UTF-8 source, with distinct wire/decoded provenance and full-source hash`, async () => {
    const source = Buffer.from('ordinary UTF-8 雪 '.repeat(100)), wire = compress(source)
    const subject = fixture(wire, ` \t${encoding.toUpperCase()} \t`, { headers: { 'content-length': String(wire.length) } })
    const result = await subject.run()
    assert.equal(result.success, true); assert.equal(result.text, source.toString())
    assert.equal(result.contentEncoding, encoding); assert.equal(result.decodedBytes, source.length)
    assert.equal(result.bytesRead, wire.length); assert.notEqual(wire.length, source.length)
    assert.equal(result.bodySha256, createHash('sha256').update(source).digest('hex'))
    assert.equal(subject.state.requests, 1); assert.equal(subject.state.closes, 1)
  })
  test(`${encoding} handles an empty decoded representation and the exact decoded ceiling`, async () => {
    for (const source of [Buffer.alloc(0), Buffer.alloc(4096, 'x')]) {
      const wire = compress(source), result = await fixture(wire, encoding).run({ limits: { bodyBytes: 4096 } })
      assert.equal(result.success, true); assert.equal(result.decodedBytes, source.length)
    }
  })
  test(`${encoding} stops a compression bomb under backpressure and destroys its native decoder`, async t => {
    const limit = 1024, wire = compress(Buffer.alloc(4 * PUBLIC_URL_LIMITS.bodyBytes, 'x'))
    assert(wire.length <= PUBLIC_URL_LIMITS.bodyBytes)
    let expanded = 0, destroys = 0
    const push = Decoder.prototype.push, destroy = Decoder.prototype.destroy
    t.mock.method(Decoder.prototype, 'push', function(chunk, ...args) {
      if (chunk) expanded += chunk.byteLength
      return push.call(this, chunk, ...args)
    })
    t.mock.method(Decoder.prototype, 'destroy', function(...args) { destroys++; return destroy.apply(this, args) })
    // The compressed wire also fits the tightened cap for the ordinary smaller
    // bomb; the large fixture uses product wire cap and decoded content > 1 MiB.
    const smallWire = compress(Buffer.alloc(64 * 1024, 'x'))
    const subject = fixture(smallWire, encoding), result = await subject.run({ limits: { bodyBytes: limit } })
    failed(result, 'body_limit', 'decompression'); assert.equal(subject.state.closes, 1)
    assert(destroys > 0); assert(expanded <= limit + 2 * 16 * 1024, `expanded bytes before destroy: ${expanded}`)
    const stoppedAt = expanded; await tick(); await tick(); assert.equal(expanded, stoppedAt)
    failed(await fixture(wire, encoding).run(), 'body_limit', 'decompression')
  })
  test(`${encoding} rejects invalid, truncated and trailing bytes without exposing source/native details`, async () => {
    const wire = compress(Buffer.from('private-source-marker'))
    for (const body of [Buffer.from('private-native-marker'), wire.subarray(0, wire.length - 1),
      Buffer.concat([wire, Buffer.from('unexpected trailing input')]), Buffer.alloc(0)]) {
      const subject = fixture(body, encoding), result = await subject.run()
      failed(result, 'invalid_compression', 'decompression'); assert.equal(subject.state.closes, 1)
      assert.equal(result.httpStatus, 200)
      assert(!JSON.stringify(result).includes('private-')); assert.equal(subject.state.requests, 1)
    }
  })
  test(`${encoding} keeps wire-byte limits and framing separate from decoded-byte limits`, async () => {
    const wire = compress(Buffer.from('short source'))
    const over = fixture(wire, encoding), result = await over.run({ limits: { bodyBytes: wire.length - 1 } })
    failed(result, 'body_limit', 'body'); assert.equal(over.state.closes, 1)
    const framing = fixture(wire, encoding, { headers: { 'content-length': String(wire.length + 1) } })
    failed(await framing.run(), 'incomplete_response', 'body'); assert.equal(framing.state.closes, 1)
    const advertised = fixture(wire, encoding, { headers: { 'content-length': String(PUBLIC_URL_LIMITS.bodyBytes + 1) } })
    failed(await advertised.run(), 'body_limit', 'response'); assert.equal(advertised.state.pulls, 0)
  })
  test(`${encoding} cancellation during native decompression destroys and drains before returning`, async t => {
    const wire = compress(Buffer.alloc(128 * 1024, 'x')), controller = new AbortController()
    let destroys = 0, pushes = 0
    const push = Decoder.prototype.push, destroy = Decoder.prototype.destroy
    t.mock.method(Decoder.prototype, 'push', function(chunk, ...args) {
      pushes++; if (chunk) controller.abort()
      return push.call(this, chunk, ...args)
    })
    t.mock.method(Decoder.prototype, 'destroy', function(...args) { destroys++; return destroy.apply(this, args) })
    const subject = fixture(wire, encoding), result = await subject.run({ signal: controller.signal })
    failed(result, 'cancelled', 'decompression'); assert.equal(subject.state.closes, 1); assert(destroys > 0)
    const stoppedAt = pushes; await tick(); await tick(); assert.equal(pushes, stoppedAt)
  })
  test(`${encoding} live owner, deadline and secrets are enforced during/after decoded work`, async t => {
    let current = true, elapsed = 0
    const wire = compress(Buffer.alloc(128 * 1024, 'x')), push = Decoder.prototype.push
    t.mock.method(Decoder.prototype, 'push', function(chunk, ...args) { if (chunk) current = false; return push.call(this, chunk, ...args) })
    const stale = fixture(wire, encoding, { adapters: { isCurrent: () => current } })
    failed(await stale.run(), 'stale_owner', 'decompression'); assert.equal(stale.state.closes, 1)
    t.mock.restoreAll()
    t.mock.method(performance, 'now', () => elapsed)
    t.mock.method(Decoder.prototype, 'push', function(chunk, ...args) { if (chunk) elapsed = 100; return push.call(this, chunk, ...args) })
    const deadline = fixture(wire, encoding)
    failed(await deadline.run({ limits: { milliseconds: 50 } }), 'deadline', 'decompression')
    assert.equal(deadline.state.closes, 1)
    t.mock.restoreAll()
    const marker = 'credential-outside-clipped-text', secrets = []
    const secretWire = compress(Buffer.from(`safe ${marker}`))
    const learned = fixture(secretWire, encoding, { close() { secrets.push(marker) } })
    const result = await learned.run({ secrets: () => secrets, limits: { textBytes: 1 } })
    failed(result, 'known_secret', 'extraction'); assert(!JSON.stringify(result).includes(marker))
    const known = await fixture(secretWire, encoding).run({ secrets: [marker], limits: { textBytes: 1 } })
    failed(known, 'known_secret', 'decoding')
  })
}

test('identity responses retain their provenance fields and JSON/text output ceilings', async () => {
  for (const encoding of [undefined, 'identity', ' IDENTITY ']) {
    const source = Buffer.from('x'.repeat(100_000)), result = await fixture(source, encoding).run()
    assert.equal(result.success, true); assert.equal(result.contentEncoding, undefined); assert.equal(result.decodedBytes, undefined)
    assert.equal(result.bytesRead, source.length); assert.equal(result.truncated, true)
    assert.equal(result.bodySha256, createHash('sha256').update(source).digest('hex'))
    assert(Buffer.byteLength(JSON.stringify(result)) <= PUBLIC_URL_LIMITS.resultBytes)
  }
})
test('compressed escaped text still fits the complete transcript result envelope', async () => {
  const source = Buffer.from('\0'.repeat(200_000))
  const result = await fixture(gzipSync(source), 'gzip').run()
  assert.equal(result.success, true); assert.equal(result.truncated, true)
  assert.equal(result.decodedBytes, source.length); assert(Buffer.byteLength(JSON.stringify(result)) <= PUBLIC_URL_LIMITS.resultBytes)
})
test('raw deflate is rejected; no second decoder or format retry is attempted', async () => {
  const subject = fixture(deflateRawSync(Buffer.from('ordinary text')), 'deflate'), result = await subject.run()
  failed(result, 'invalid_compression', 'decompression'); assert.equal(subject.state.requests, 1); assert.equal(subject.state.closes, 1)
})
for (const encoding of ['zstd', 'compress', 'gzip, br', 'identity, gzip', 'gzip, gzip', 'gzip;q=1', '']) {
  test(`unsupported or chained coding ${JSON.stringify(encoding)} is rejected before body pulls`, async () => {
    const subject = fixture(gzipSync(Buffer.from('ordinary')), encoding), result = await subject.run()
    failed(result, 'compressed_response', 'response'); assert.equal(subject.state.pulls, 0); assert.equal(subject.state.closes, 1)
  })
}
test('numeric HTTP failure statuses and local stages are safe; no reason phrase/header/error body is returned', async () => {
  for (const status of [401, 403, 404, 429, 500, 503]) {
    const subject = fixture(Buffer.from('private-error-body'), 'gzip', { status, headers: { 'x-native': 'private-header' } })
    const result = await subject.run()
    failed(result, 'http_error', 'response'); assert.equal(result.httpStatus, status)
    assert.equal(subject.state.pulls, 0); assert.equal(subject.state.closes, 1); assert(!JSON.stringify(result).includes('private-'))
  }
  for (const status of [101, 199, 600, NaN, '404', 404.5]) {
    const result = await fixture(Buffer.alloc(0), undefined, { status }).run()
    failed(result, 'invalid_response', 'response'); assert.equal(result.httpStatus, undefined)
  }
})
test('pre-response failures report their local stage without an invented HTTP status', async () => {
  for (const [adapters, code, stage] of [
    [{ approve: async () => false }, 'approval_denied', 'approval'],
    [{ resolve: async () => { throw new PublicUrlTransportError('dns_error') } }, 'dns_error', 'dns'],
    [{ onBeforeRequest: async () => { throw new Error('private-native-error') } }, 'transport_failed', 'send_intent'],
    [{ request: async () => { throw new Error('private-native-error') } }, 'transport_failed', 'request'],
  ]) {
    const result = await fixture(Buffer.alloc(0), undefined, { adapters }).run()
    assert.equal(result.success, false); assert.equal(result.error.code, code); assert.equal(result.failureStage, stage)
    assert.equal(result.httpStatus, undefined); assert(!JSON.stringify(result).includes('private-'))
  }
})

test('compressed invalid UTF-8 fails after content decoding and never returns a source prefix', async () => {
  const wire = gzipSync(Buffer.from([0x61, 0xc3, 0x28])), result = await fixture(wire, 'gzip').run()
  failed(result, 'invalid_utf8', 'decoding'); assert.equal(result.bytesRead, wire.length)
})
test('compressed inert HTML still screens suppressed source beyond output clipping', async () => {
  const marker = 'hidden-script-credential', wire = gzipSync(Buffer.from(`<p>visible</p><script>${marker}</script>`))
  const result = await fixture(wire, 'gzip', { headers: { 'content-type': 'text/html' } }).run({ secrets: [marker], limits: { textBytes: 1 } })
  failed(result, 'known_secret', 'decoding'); assert(!JSON.stringify(result).includes(marker))
})
test('gzip and zlib checksum corruption fails even when the original source is complete', async () => {
  for (const [encoding, compress] of [codecs[0], codecs[2]]) {
    const wire = compress(Buffer.from('source with integrity trailer')); wire[wire.length - 1] ^= 0xff
    failed(await fixture(wire, encoding).run(), 'invalid_compression', 'decompression')
  }
})
test('an approved redirect clears its status before a later DNS or approval failure', async () => {
  for (const failure of ['dns', 'approval']) {
    let approvals = 0, lookups = 0
    const result = await fixture(Buffer.alloc(0), undefined, { status: 302, headers: { location: 'https://other.example/target' }, adapters: {
      approve: async () => ++approvals === 1 || failure !== 'approval',
      resolve: async () => { if (++lookups > 1) throw new PublicUrlTransportError('dns_error'); return ['8.8.8.8'] },
    } }).run()
    failed(result, failure === 'dns' ? 'dns_error' : 'approval_denied', failure)
    assert.equal(result.httpStatus, undefined); assert.equal(result.redirects.length, 1)
  }
})
