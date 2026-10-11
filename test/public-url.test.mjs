// SPDX-License-Identifier: Apache-2.0
// Actual engine with controlled DNS/response seams; no external network access.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { fetchPublicUrl, preparePublicUrl, publicUrlContainsSecret, PUBLIC_URL_LIMITS } from '../dist/public-url.js'
import { PublicUrlTransportError } from '../dist/public-url-transport.js'
const selected = 'https://example.com/selected?ordinary=value'
const tick = () => new Promise(resolve => setImmediate(resolve))
function bodyResponse(text, fields = {}) {
  let closes = 0
  return { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: { async *[Symbol.asyncIterator]() { yield Buffer.from(text) } },
    close() { closes++ }, get closes() { return closes }, ...fields }
}
function controlled(response, overrides = {}) {
  const state = { requests: [], lookups: 0, decisions: [], intents: [] }
  const adapters = { async approve(disclosure) { state.decisions.push(disclosure); return true },
    async resolve(_, __, assertCurrent) { assertCurrent(); state.lookups++; return ['8.8.8.8'] },
    async onBeforeRequest(disclosure) { state.intents.push(disclosure) },
    async request(request) { state.requests.push(request); request.assertCurrent(); request.onTransmit(); return response },
    ...overrides }
  return { adapters, state, run: (input = selected, options = {}) => fetchPublicUrl(input, adapters, options) }
}

test('decision objects freeze exact URL, method, limits and redirect records', async () => {
  const response = bodyResponse('plain text'), subject = controlled(response)
  const result = await subject.run()
  assert.equal(result.success, true)
  for (const disclosure of [subject.state.decisions[0], subject.state.intents[0]]) {
    assert.equal(disclosure.url, selected); assert.equal(disclosure.method, 'GET')
    assert(Object.isFrozen(disclosure)); assert(Object.isFrozen(disclosure.limits)); assert(Object.isFrozen(disclosure.redirects))
    assert.throws(() => { disclosure.url = 'https://other.example/' }, TypeError)
    assert.throws(() => { disclosure.limits.bodyBytes++ }, TypeError)
    assert.throws(() => { disclosure.redirects.push({ from: selected, to: selected, status: 302 }) }, TypeError)
  }
  assert(Object.isFrozen(result)); assert(Object.isFrozen(result.requests)); assert(Object.isFrozen(result.requests[0]))
  assert(Object.isFrozen(subject.state.requests[0].headers))
})
test('durable send-intent failure stops before entering transport', async () => {
  const response = bodyResponse('plain text'), subject = controlled(response, {
    async onBeforeRequest() { throw new Error('private write failure https://private.example/credential') }
  })
  const result = await subject.run()
  assert.equal(result.success, false); assert.equal(result.error.code, 'transport_failed')
  assert.equal(subject.state.lookups, 1); assert.equal(subject.state.requests.length, 0)
  assert.deepEqual(result.requests, []); assert.equal(result.serverEffects, 'not_attempted')
  assert(!JSON.stringify(result).includes('private.example'))
})
test('durable send-intent await rechecks secrets and owner before transport', async () => {
  for (const change of ['owner', 'credential']) {
    const secrets = [], secret = 'newly-learned-credential', response = bodyResponse('plain text')
    let current = true
    const subject = controlled(response, {
      isCurrent: () => current,
      async onBeforeRequest() { await tick(); if (change === 'owner') current = false; else secrets.push(secret) }
    })
    const result = await subject.run(`https://example.com/${secret}`, { secrets })
    assert.equal(result.success, false); assert.equal(result.error.code, change === 'owner' ? 'stale_owner' : 'known_secret')
    assert.equal(subject.state.requests.length, 0)
    assert(!JSON.stringify(result).includes(secret))
  }
})
test('transport receives a live guard and stale ownership immediately before transmission revokes the hop', async () => {
  let current = true
  const subject = controlled(bodyResponse('plain text'), {
    isCurrent: () => current,
    async request(request) { current = false; request.assertCurrent(); assert.fail('must not transmit') }
  })
  const result = await subject.run()
  assert.equal(result.success, false); assert.equal(result.error.code, 'stale_owner')
  assert.deepEqual(result.requests, [{ url: selected, transmission: 'unknown' }])
})
test('all complete result bytes fit the 64KiB serialized envelope even when escaping expands text', async () => {
  for (const text of ['x'.repeat(PUBLIC_URL_LIMITS.bodyBytes), '\u0000'.repeat(50_000), '😀'.repeat(100_000)]) {
    const response = bodyResponse(text), result = await controlled(response).run()
    assert.equal(result.success, true); assert.equal(result.doNotRetry, true)
    assert(Buffer.byteLength(result.text) <= PUBLIC_URL_LIMITS.textBytes)
    assert(Buffer.byteLength(JSON.stringify(result)) <= PUBLIC_URL_LIMITS.resultBytes)
    assert.equal(result.truncated, true); assert.equal(result.bytesRead, Buffer.byteLength(text))
    assert.equal(response.closes, 1)
  }
})
test('maximum redirect metadata reserves space before bounded text and still fits complete envelope', async () => {
  const suffix = 'x'.repeat(3_900), initial = `https://example.com/zero?ordinary=${suffix}`
  let index = 0
  const responses = []
  const subject = controlled(undefined, { async request(request) {
    request.assertCurrent(); request.onTransmit()
    const response = index < 3 ? bodyResponse('', { status: 302, headers: { location: `/hop-${index++}?ordinary=${suffix}` } })
      : bodyResponse('z'.repeat(100_000))
    responses.push(response); return response
  } })
  const result = await subject.run(initial)
  assert.equal(result.success, true); assert.equal(result.redirects.length, 3); assert.equal(result.requests.length, 4)
  assert(Buffer.byteLength(JSON.stringify(result)) <= PUBLIC_URL_LIMITS.resultBytes)
  assert(result.text.length > 0); assert(result.text.length < PUBLIC_URL_LIMITS.textBytes)
  assert(responses.every(response => response.closes === 1))
})
test('fixture limits may only tighten ceilings; invalid or enlarged limits perform no decision or network work', async () => {
  for (const limits of [{ bodyBytes: PUBLIC_URL_LIMITS.bodyBytes + 1 }, { milliseconds: Infinity },
    { redirects: -1 }, { addresses: 1.5 }, { unsafe: 1 }]) {
    const subject = controlled(bodyResponse('plain text')), result = await subject.run(selected, { limits })
    assert.equal(result.success, false); assert.equal(result.error.code, 'invalid_limits')
    assert.equal(subject.state.decisions.length, 0); assert.equal(subject.state.lookups, 0); assert.equal(subject.state.requests.length, 0)
  }
})
test('known secrets in headers are rescreened after closure, including cookie data', async () => {
  const secrets = [], secret = 'known-after-close'
  const response = bodyResponse('ordinary', { headers: { 'content-type': 'text/plain', 'set-cookie': `sid=${secret}` },
    close() { secrets.push(secret) } })
  const result = await controlled(response).run(selected, { secrets })
  assert.equal(result.success, false); assert.equal(result.error.code, 'known_secret')
  assert(!JSON.stringify(result).includes(secret))
})
test('dynamic secret reader screens credentials learned during final closure beyond text clipping', async () => {
  let secrets = []
  const marker = 'live-secret-reader-marker', response = bodyResponse(`safe prefix ${marker}`, {
    close() { secrets = [marker] }
  })
  const result = await controlled(response).run(selected, { secrets: () => secrets, limits: { textBytes: 4 } })
  assert.equal(result.success, false); assert.equal(result.error.code, 'known_secret')
  assert(!JSON.stringify(result).includes(marker))
})
test('safe transport error codes survive while native details remain withheld', async () => {
  const subject = controlled(bodyResponse('unused'), { async resolve() { throw new PublicUrlTransportError('dns_error') } })
  const result = await subject.run()
  assert.equal(result.success, false); assert.equal(result.error.code, 'dns_error'); assert.deepEqual(result.requests, [])
  assert.equal(result.error.message, 'Public URL retrieval did not complete')
})
test('credential query names are blocked under repeatedly decoded and semicolon-separated interpretations', () => {
  for (const selected of ['https://example.com/?ordinary=x;token=value',
    'https://example.com/?ordinary=x%26api_key%3Dvalue', 'https://example.com/?ordinary=x%253bpassword%253dvalue']) {
    assert.throws(() => preparePublicUrl(selected), error => error.code === 'credential_query')
  }
})
test('full-source credential screening understands numeric/common entities and malformed-neighbor percent escapes', () => {
  assert.equal(publicUrlContainsSecret('<!--&#115;&#101;&#99;&#114;&#101;&#116;-->', ['secret']), true)
  assert.equal(publicUrlContainsSecret('hidden &amp; credential', ['& credential']), true)
  assert.equal(publicUrlContainsSecret('%GG%73%65%63%72%65%74%Q0', ['secret']), true)
  const cyclic = { value: 'secret' }; cyclic.self = cyclic
  assert.equal(publicUrlContainsSecret(cyclic, ['secret']), true)
})

test('bounded extractor failures use their closed code and never expose oversized source', async () => {
  const response = bodyResponse('\u0000'.repeat(700_000), { headers: { 'content-type': 'text/html' } })
  const result = await controlled(response).run()
  assert.equal(result.success, false); assert.equal(result.error.code, 'invalid_extraction')
  assert.equal(result.bytesRead, 700_000); assert.equal(response.closes, 1)
  assert.equal(result.text, undefined); assert(Buffer.byteLength(JSON.stringify(result)) < 1024)
})
test('expanded HTML output remains fully screened beyond the clipped result', async () => {
  const marker = 'expanded-source-secret', secrets = []
  const response = bodyResponse(`${'\u0000'.repeat(400_000)}${marker}`, {
    headers: { 'content-type': 'text/html' }, close() { secrets.push(marker) }
  })
  const result = await controlled(response).run(selected, { secrets, limits: { textBytes: 4 } })
  assert.equal(result.success, false); assert.equal(result.error.code, 'known_secret')
  assert(!JSON.stringify(result).includes(marker))
})
test('all failure evidence fits a tightened result envelope while retaining transmission uncertainty', async () => {
  const longUrl = `https://example.com/${'x'.repeat(3_900)}`
  const result = await controlled(bodyResponse('ordinary')).run(longUrl, { limits: { resultBytes: 1024 } })
  assert.equal(result.success, false); assert.equal(result.error.code, 'result_limit')
  assert(Buffer.byteLength(JSON.stringify(result)) <= 1024)
  assert.deepEqual(result.requests, [{ url: '[URL withheld: result budget]', transmission: 'observed' }])
  assert.equal(result.serverEffects, 'unknown')
})
test('minimum fixture result envelope prevents an unrepresentable zero-byte error budget', async () => {
  const subject = controlled(bodyResponse('ordinary')), result = await subject.run(selected, { limits: { resultBytes: 0 } })
  assert.equal(result.success, false); assert.equal(result.error.code, 'invalid_limits')
  assert.equal(subject.state.requests.length, 0)
})

test('attempted request failure explicitly blocks automatic retry even without observed transmission', async () => {
  const subject = controlled(bodyResponse('unused'), { async request() { throw new Error('local send uncertain') } })
  const result = await subject.run()
  assert.equal(result.success, false); assert.equal(result.doNotRetry, true)
  assert.deepEqual(result.requests, [{ url: selected, transmission: 'unknown' }])
  assert.equal(result.serverEffects, 'unknown')
})

test('output clipping performs owner checks at fixed work quanta instead of once per Unicode point', async () => {
  const text = 'x'.repeat(64 * 1024), config = { policy: 'fixed', revisions: 'x'.repeat(4096) }
  let ownershipChecks = 0
  const subject = controlled(bodyResponse(text), { assertCurrent() {
    ownershipChecks++
    // Mirrors the real host's cryptographic owner/config check cost.
    createHash('sha256').update(JSON.stringify(config)).digest('hex')
  } })
  const result = await subject.run()
  assert.equal(result.success, true)
  assert(result.text.length > 60 * 1024)
  assert(ownershipChecks > 0 && ownershipChecks < 256, `owner checks: ${ownershipChecks}`)
})
test('fixed-quantum clipping still checks the final processing deadline before returning text', async t => {
  let elapsed = 0, points = 0
  const byteLength = Buffer.byteLength.bind(Buffer)
  t.mock.method(performance, 'now', () => elapsed)
  t.mock.method(Buffer, 'byteLength', (value, ...args) => {
    if (value === 'x') { elapsed++; points++ }
    return byteLength(value, ...args)
  })
  const response = bodyResponse('x'.repeat(100)), result = await controlled(response).run(selected,
    { limits: { milliseconds: 25, bodyBytes: 100, textBytes: 100 } })
  assert.equal(result.success, false); assert.equal(result.error.code, 'deadline')
  assert.equal(points, 100); assert.equal(result.text, undefined)
  assert.equal(response.closes, 1); assert.equal(result.doNotRetry, true)
})

test('thrown error code accessors and proxy traps cannot escape the closed error boundary', async () => {
  let getterReads = 0
  const marker = 'raw-private-error-marker'
  const accessor = Object.defineProperty(new Error('private original'), 'code', { get() {
    getterReads++; throw new Error(marker)
  } })
  const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(marker) } })
  const typed = Object.defineProperty(new PublicUrlTransportError('dns_error'), 'code', { get() {
    getterReads++; throw new Error(marker)
  } })
  for (const error of [accessor, proxy, typed]) {
    const subject = controlled(bodyResponse('unused'), { async resolve() { throw error } })
    const result = await subject.run()
    assert.equal(result.success, false); assert.equal(result.error.code, 'transport_failed')
    assert(!JSON.stringify(result).includes(marker)); assert.deepEqual(result.requests, [])
  }
  assert.equal(getterReads, 0)
})
