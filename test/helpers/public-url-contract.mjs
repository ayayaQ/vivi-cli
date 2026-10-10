// SPDX-License-Identifier: Apache-2.0
// Test-only policy prototype. No resolver, network client or product tool exists.
import { isIP } from 'node:net'
import { createHash } from 'node:crypto'

export const PROPOSED_URL_LIMITS = Object.freeze({ redirects: 3, milliseconds: 15_000,
  bodyBytes: 1024 * 1024, textBytes: 64 * 1024, headerBytes: 16 * 1024, addresses: 16, urlBytes: 4096 })
class ContractError extends Error { constructor(code) { super(code); this.code = code } }
const fail = code => { throw new ContractError(code) }
const bytes = value => Buffer.byteLength(value, 'utf8')
function ipv4(address) { return address.split('.').reduce((value, item) => value * 256n + BigInt(item), 0n) }
function ipv6(address) {
  const halves = address.split('::'), left = halves[0].split(':').filter(Boolean), right = (halves[1] ?? '').split(':').filter(Boolean)
  return [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    .reduce((value, item) => value * 65536n + BigInt(`0x${item}`), 0n)
}
function within(value, prefix, size, total) {
  const shift = BigInt(total - size)
  return value >> shift === prefix >> shift
}
// Conservative snapshot: special-purpose exceptions also fail closed. Not a
// claim of routability or complete operating-system/network isolation.
const v4Denied = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.31.196.0/24', '192.52.193.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24',
  '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4']
const v6Denied = ['2001::/23', '2001:db8::/32', '2002::/16', '2620:4f:8000::/48', '3fff::/20']
export function proposedPublicAddress(address) {
  if (typeof address !== 'string') return false
  const family = isIP(address)
  if (family === 4) {
    const value = ipv4(address)
    return !v4Denied.some(cidr => { const [prefix, size] = cidr.split('/'); return within(value, ipv4(prefix), Number(size), 32) })
  }
  // Embedded IPv4, mapped, transition and non-current global-unicast ranges are
  // deliberately excluded rather than normalized into a broader accepted range.
  if (family !== 6 || address.includes('.') || address.includes('%')) return false
  const value = ipv6(address)
  return within(value, ipv6('2000::'), 3, 128) && !v6Denied.some(cidr => {
    const [prefix, size] = cidr.split('/'); return within(value, ipv6(prefix), Number(size), 128)
  })
}
export function proposedContainsSecret(value, secrets) {
  let text = typeof value === 'string' ? value : JSON.stringify(value)
  for (let depth = 0; depth < 32; depth++) {
    if (secrets.some(secret => secret && text.includes(secret))) return true
    const next = text.replace(/(?:%[\da-f]{2})+/gi, run => Buffer.from(run.match(/%[\da-f]{2}/gi).map(byte => Number.parseInt(byte.slice(1), 16))).toString('utf8'))
      .replace(/\\(?:u([\da-f]{4})|(["\\/bfnrt]))/gi, (_, code, escape) => code
        ? String.fromCharCode(Number.parseInt(code, 16))
        : ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[escape] ?? escape)
    if (next === text) return false
    text = next
  }
  return true
}
export function proposedPrepareUrl(value, secrets = []) {
  if (typeof value !== 'string' || bytes(value) > PROPOSED_URL_LIMITS.urlBytes || /[\u0000-\u0020\u007f\\]/u.test(value)) fail('invalid_url')
  if (proposedContainsSecret(value, secrets)) fail('known_secret')
  if (!/^https:\/\/[^/]/i.test(value)) fail('unsupported_origin')
  if (/^https:\/\/[^/?#]*@/i.test(value)) fail('credential_url')
  let url
  try { url = new URL(value) } catch { fail('invalid_url') }
  if (url.protocol !== 'https:' || url.port && url.port !== '443') fail('unsupported_origin')
  if (url.username || url.password) fail('credential_url')
  for (const rawKey of url.searchParams.keys()) {
    let key = rawKey
    for (let depth = 0; depth < 32; depth++) {
      if (/^(?:password|passwd|pass|api[-_]?key|access[-_]?token|token|secret|auth|authorization|signature|sig|x-amz-.*|x-goog-.*)$/i.test(key)) fail('credential_query')
      let next
      try { next = decodeURIComponent(key) } catch { break }
      if (next === key) break
      key = next
    }
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const domain = hostname.replace(/\.$/, '')
  if (isIP(hostname) ? !proposedPublicAddress(hostname)
    : !domain.includes('.') || domain.length > 253 ||
      domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) ||
      /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/i.test(domain)) fail('non_public_host')
  url.hash = ''
  if (bytes(url.href) > PROPOSED_URL_LIMITS.urlBytes) fail('invalid_url')
  if (proposedContainsSecret(url.href, secrets)) fail('known_secret')
  return Object.freeze({ url: url.href, hostname, origin: url.origin })
}
const clip = (text, limit) => { let out = '', count = 0; for (const point of text) { const size = bytes(point); if (count + size > limit) break; out += point; count += size } return out }

export async function exerciseUrlContract(input, adapters, options = {}) {
  const limits = { ...PROPOSED_URL_LIMITS, ...options.limits }
  const secrets = options.secrets ?? [], controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  let timeout = false, active, requested, current, reads = 0, cleanupFailed = false
  const requests = [], redirects = []
  const safeEvidence = () => {
    const safeUrl = value => proposedContainsSecret(value, secrets) ? '[URL withheld: known credential]' : value
    return { requests: requests.map(record => ({ ...record, url: safeUrl(record.url) })),
      redirects: redirects.map(record => ({ ...record, from: safeUrl(record.from), to: safeUrl(record.to) })) }
  }
  function closeResponse(response) {
    try {
      const closing = response.close()
      if (closing && typeof closing.then === 'function') {
        // The prototype's cleanup contract is synchronous. Do not leak a raw
        // asynchronous rejection or claim that unawaited closure was verified.
        cleanupFailed = true; void Promise.resolve(closing).catch(() => {})
      }
    } catch { cleanupFailed = true }
  }
  let timer, startedAt, remaining = limits.milliseconds
  const pauseBudget = () => {
    clearTimeout(timer); timer = undefined
    if (startedAt !== undefined) remaining -= performance.now() - startedAt
    startedAt = undefined
  }
  const resumeBudget = () => {
    startedAt = performance.now()
    timer = setTimeout(() => { timeout = true; controller.abort() }, Math.max(0, remaining))
  }
  const guard = () => {
    // A hot sequence of immediately resolved mock chunks must not starve the
    // timer callback and evade the cumulative active deadline.
    if (remaining <= 0 || startedAt !== undefined && performance.now() - startedAt >= remaining) {
      timeout = true; controller.abort(); fail('deadline')
    }
    if (signal.aborted) fail(timeout ? 'deadline' : 'cancelled')
    if (adapters.isCurrent?.() === false) fail('stale_owner')
    if (current && proposedContainsSecret(current.url, secrets)) fail('known_secret')
  }
  async function owned(operation, abandon) {
    guard()
    let abort
    const cancellation = new Promise((_, reject) => {
      abort = () => reject(new ContractError(timeout ? 'deadline' : 'cancelled'))
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const result = await Promise.race([operation(), cancellation])
      try { guard() } catch (error) { abandon?.(result); throw error }
      return result
    }
    finally { signal.removeEventListener('abort', abort) }
  }
  try {
    requested = current = proposedPrepareUrl(input, secrets)
    let approvalNeeded = true
    for (;;) {
      guard()
      if (approvalNeeded) {
        pauseBudget()
        if (!await owned(() => adapters.approve({ ...current, method: 'GET', limits: { ...limits }, redirects: [...redirects] }, signal))) fail('approval_denied')
        resumeBudget()
      }
      const answers = await owned(() => adapters.resolve(current.hostname, signal))
      if (!Array.isArray(answers) || !answers.length || answers.length > limits.addresses || answers.some(address => !proposedPublicAddress(address))) fail('non_public_address')
      guard()
      const record = { url: current.url, transmission: 'unknown' }; requests.push(record)
      // The future adapter must pin this exact address and verify original host
      // identity. This fake contract cannot prove the real connection does so.
      active = await owned(async () => {
        const response = await adapters.request({ ...current, address: answers[0], method: 'GET', signal,
        headers: { accept: 'text/plain, text/html, application/json', 'accept-encoding': 'identity' },
          onTransmit: () => { record.transmission = 'observed' } })
        // A late response still belongs to the cancelled owner. Clean it up even
        // when the outer cancellation race has already settled.
        try { guard() } catch (error) { closeResponse(response); throw error }
        return response
      }, closeResponse)
      const { status, headers } = active
      if (!Number.isInteger(status) || status < 100 || status > 599 || !headers || typeof headers !== 'object' ||
        Array.isArray(headers) || Object.values(headers).some(value => typeof value !== 'string') ||
        bytes(JSON.stringify(headers)) > limits.headerBytes) fail('invalid_response')
      if (proposedContainsSecret(headers, secrets)) fail('known_secret')
      const location = headers.location
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (typeof location !== 'string' || bytes(location) > limits.urlBytes || /[\u0000-\u0020\u007f\\]/u.test(location)) fail('invalid_redirect')
        if (redirects.length >= limits.redirects) fail('redirect_limit')
        if (proposedContainsSecret(location, secrets)) fail('known_secret')
        let destination
        try { destination = new URL(location, current.url).href } catch { fail('invalid_redirect') }
        const next = proposedPrepareUrl(destination, secrets)
        redirects.push({ from: current.url, to: next.url, status })
        approvalNeeded = next.origin !== current.origin
        closeResponse(active); active = undefined
        if (cleanupFailed) fail('cleanup_failed')
        current = next; continue
      }
      if (status < 200 || status > 299) fail('http_error')
      if (headers['content-disposition'] && !/^inline(?:;|$)/i.test(headers['content-disposition'])) fail('download_response')
      if (headers['content-encoding'] && headers['content-encoding'].toLowerCase() !== 'identity') fail('compressed_response')
      const type = headers['content-type'] ?? ''
      const mime = type.split(';')[0].trim().toLowerCase()
      if (!['text/plain', 'text/html', 'application/json'].includes(mime)) fail('unsupported_content')
      const parameters = type.split(';').slice(1)
      const charsets = parameters.filter(parameter => /^\s*charset\s*=/i.test(parameter))
      if (charsets.length > 1 || charsets.length && !/^\s*charset\s*=\s*(?:"utf-8"|utf-8)\s*$/i.test(charsets[0])) fail('unsupported_charset')
      const length = headers['content-length']
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limits.bodyBytes)) fail('body_limit')
      const bodyStorage = Buffer.alloc(limits.bodyBytes)
      const iterator = active.body[Symbol.asyncIterator]()
      for (;;) {
        const next = await owned(() => iterator.next())
        if (next.done) break
        if (!(next.value instanceof Uint8Array)) fail('invalid_response')
        const offset = reads
        reads += next.value.byteLength
        if (reads > limits.bodyBytes) fail('body_limit')
        if (next.value.byteLength) bodyStorage.set(next.value, offset)
      }
      const body = bodyStorage.subarray(0, reads)
      if (length !== undefined && Number(length) !== body.length) fail('incomplete_response')
      let source
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(body) } catch { fail('invalid_utf8') }
      if (proposedContainsSecret(source, secrets)) fail('known_secret')
      // A mock adapter only; product HTML parser choice remains pending.
      if (mime === 'text/html' && !adapters.extractHtml) fail('html_extractor_missing')
      const extracted = mime === 'text/html' ? await owned(() => adapters.extractHtml(source, signal)) : source
      if (typeof extracted !== 'string') fail('invalid_extraction')
      if (proposedContainsSecret(extracted, secrets)) fail('known_secret')
      guard()
      const text = clip(extracted, limits.textBytes)
      closeResponse(active); active = undefined
      if (cleanupFailed) fail('cleanup_failed')
      const result = { success: true, source: 'public_url', untrusted: true, requestedUrl: requested.url,
        finalUrl: current.url, redirects: structuredClone(redirects), requests: structuredClone(requests), httpStatus: status, mimeType: mime,
        retrievedAt: adapters.now?.() ?? '2000-01-01T00:00:00.000Z', bytesRead: reads,
        bodySha256: createHash('sha256').update(body).digest('hex'),
        representation: mime === 'text/html' ? 'mock_html_extraction' : 'utf8_source',
        representationVersion: 'offline-prototype-v1',
        text, truncated: text !== extracted, serverEffects: 'unknown' }
      if (proposedContainsSecret([source, extracted, result], secrets)) fail('known_secret')
      guard()
      return result
    }
  } catch (error) {
    if (active) { closeResponse(active); active = undefined }
    return { success: false, source: 'public_url', untrusted: true, ...safeEvidence(), bytesRead: reads,
      serverEffects: requests.length ? 'unknown' : 'not_attempted',
      ...(cleanupFailed ? { warnings: ['Response cleanup failed; resource closure was not verified'] } : {}),
      error: { code: error instanceof ContractError ? error.code : 'transport_failed', message: 'Public URL contract did not complete' } }
  } finally { pauseBudget(); if (active) closeResponse(active) }
}
