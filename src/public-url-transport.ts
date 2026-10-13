// SPDX-License-Identifier: Apache-2.0
import { X509Certificate } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import type { RequestOptions } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { checkServerIdentity, connect as tlsConnect } from 'node:tls'
import type { ConnectionOptions, PeerCertificate, TLSSocket } from 'node:tls'

export const PUBLIC_URL_TRANSPORT_LIMITS = Object.freeze({ addresses: 16, headerBytes: 16 * 1024,
  bodyBytes: 1024 * 1024, dnsMilliseconds: 5_000, urlBytes: 4_096 })
export const PUBLIC_URL_REQUEST_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  accept: 'text/plain, text/html, application/json', 'accept-encoding': 'identity',
})
export type PublicUrlTransportCode = 'cancelled' | 'stale_owner' | 'non_public_host' | 'non_public_address'
  | 'known_secret' | 'deadline' | 'invalid_request' | 'dns_error' | 'transport_failed' | 'invalid_response' | 'body_limit' | 'cleanup_failed'
/** Deliberately contains no native error, URL, hostname, headers, or body. */
export class PublicUrlTransportError extends Error {
  constructor(readonly code: PublicUrlTransportCode) { super(code); this.name = 'PublicUrlTransportError' }
}
export interface PublicUrlRequest {
  url: string
  hostname: string
  origin: string
  address: string
  method: 'GET'
  headers: Readonly<Record<string, string>>
  signal: AbortSignal
  onTransmit(): void
  assertCurrent(): void
}
export interface PublicUrlResponse {
  status: number
  headers: Record<string, string>
  body: AsyncIterable<Uint8Array>
  close(): void
}
interface PublicUrlResolver {
  resolve4(hostname: string): Promise<string[]>
  resolve6(hostname: string): Promise<string[]>
  cancel(): void
}
/** Test seam only: CLI input cannot select dependencies or TLS/network options. */
export interface PublicUrlTransportDependencies {
  createResolver(): PublicUrlResolver
  connect(options: ConnectionOptions & { family: number; autoSelectFamily: false }): TLSSocket
  request(options: RequestOptions, onResponse: (response: IncomingMessage) => void): ClientRequest
}
const nativeDependencies: PublicUrlTransportDependencies = {
  createResolver: () => new Resolver({ timeout: PUBLIC_URL_TRANSPORT_LIMITS.dnsMilliseconds, tries: 1 }),
  connect: options => tlsConnect(options),
  request: (options, callback) => httpsRequest(options, callback),
}
function fail(code: PublicUrlTransportCode): never { throw new PublicUrlTransportError(code) }
const knownCodes: ReadonlySet<string> = new Set<PublicUrlTransportCode>(['cancelled', 'stale_owner', 'non_public_host',
  'non_public_address', 'known_secret', 'deadline', 'invalid_request', 'dns_error', 'transport_failed', 'invalid_response', 'body_limit', 'cleanup_failed'])
function sanitized(error: unknown, fallback: PublicUrlTransportCode): PublicUrlTransportError {
  if (error instanceof PublicUrlTransportError && knownCodes.has(error.code)) return new PublicUrlTransportError(error.code)
  return new PublicUrlTransportError(fallback)
}
function guard(signal: AbortSignal, assertCurrent?: () => void): void {
  if (signal.aborted) fail('cancelled')
  try { assertCurrent?.() }
  catch (error) {
    // The engine's ownership/secret/deadline errors retain their safe code there;
    // transport never propagates an arbitrary callback message or native cause.
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && knownCodes.has(error.code)) {
      fail(error.code as PublicUrlTransportCode)
    }
    fail('stale_owner')
  }
  if (signal.aborted) fail('cancelled')
}
function ipv4(address: string): bigint { return address.split('.').reduce((value, item) => value * 256n + BigInt(item), 0n) }
function ipv6(address: string): bigint {
  const [first = '', second = ''] = address.split('::')
  const left = first.split(':').filter(Boolean), right = second.split(':').filter(Boolean)
  return [...left, ...Array(8 - left.length - right.length).fill('0') as string[], ...right]
    .reduce((value, item) => value * 65_536n + BigInt(`0x${item}`), 0n)
}
function within(value: bigint, prefix: bigint, size: number, total: number): boolean {
  const shift = BigInt(total - size)
  return value >> shift === prefix >> shift
}
const v4Denied = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.31.196.0/24', '192.52.193.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '192.175.48.0/24', '198.18.0.0/15', '198.51.100.0/24',
  '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4']
const v6Denied = ['2001::/23', '2001:db8::/32', '2002::/16', '2620:4f:8000::/48', '3fff::/20']
/** Conservative special-purpose snapshot; does not claim OS-level isolation. */
export function isPublicUrlAddress(address: unknown): address is string {
  if (typeof address !== 'string') return false
  const family = isIP(address)
  if (family === 4) {
    const value = ipv4(address)
    return !v4Denied.some(cidr => { const [prefix = '', size = ''] = cidr.split('/')
      return within(value, ipv4(prefix), Number(size), 32) })
  }
  if (family !== 6 || address.includes('.') || address.includes('%')) return false
  const value = ipv6(address)
  return within(value, ipv6('2000::'), 3, 128) && !v6Denied.some(cidr => {
    const [prefix = '', size = ''] = cidr.split('/')
    return within(value, ipv6(prefix), Number(size), 128)
  })
}
function publicHostname(hostname: string): boolean {
  if (isIP(hostname)) return isPublicUrlAddress(hostname)
  const domain = hostname.replace(/\.$/, '')
  return domain.includes('.') && domain.length <= 253 && domain.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) &&
    !/(?:^|\.)(?:localhost|local|internal|home\.arpa)$/i.test(domain)
}
function sameAddress(actual: string | undefined, expected: string): boolean {
  if (!actual || isIP(actual) !== isIP(expected)) return false
  return isIP(expected) === 4 ? ipv4(actual) === ipv4(expected) : ipv6(actual) === ipv6(expected)
}
function verifyIdentity(hostname: string, certificate: PeerCertificate): Error | undefined {
  if (isIP(hostname) !== 6) return checkServerIdentity(hostname, certificate)
  // Node 26.4's domainToASCII-based checkServerIdentity does not preserve a
  // bare IPv6 literal. Use the native X509 IP-SAN matcher for that case, while
  // retaining rejectUnauthorized=true and the separate chain-authorization
  // check. Neither a DNS SAN nor a CN can authorize an IP literal.
  try { if (new X509Certificate(certificate.raw).checkIP(hostname) !== undefined) return undefined }
  catch { /* A missing/malformed native certificate fails closed. */ }
  return new PublicUrlTransportError('transport_failed')
}
function validateRequest(input: PublicUrlRequest): URL {
  if (typeof input.url !== 'string' || Buffer.byteLength(input.url) > PUBLIC_URL_TRANSPORT_LIMITS.urlBytes ||
    /[\u0000-\u0020\u007f\\]/u.test(input.url) || input.method !== 'GET') fail('invalid_request')
  let url: URL
  try { url = new URL(input.url) } catch { return fail('invalid_request') }
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  if (url.protocol !== 'https:' || url.port && url.port !== '443' || url.username || url.password || url.hash ||
    url.href !== input.url || hostname !== input.hostname || url.origin !== input.origin) fail('invalid_request')
  if (!publicHostname(hostname)) fail('non_public_host')
  if (!isPublicUrlAddress(input.address) || isIP(hostname) && !sameAddress(hostname, input.address)) fail('non_public_address')
  if (!input.headers || Object.keys(input.headers).length !== 2 ||
    Object.entries(PUBLIC_URL_REQUEST_HEADERS).some(([key, value]) => input.headers[key] !== value)) fail('invalid_request')
  return url
}
const singletonHeaders = new Set(['content-type', 'content-length', 'content-encoding', 'content-disposition',
  'transfer-encoding', 'location', 'connection', 'upgrade', 'trailer'])
function responseHeaders(response: IncomingMessage): { headers: Record<string, string>; length: number | undefined } {
  const raw = response.rawHeaders, status = response.statusCode
  if (!Number.isInteger(status) || status === undefined || status < 200 || status > 599 ||
    !Array.isArray(raw) || raw.length % 2 !== 0 || !['1.0', '1.1'].includes(response.httpVersion)) fail('invalid_response')
  const statusMessage = response.statusMessage ?? ''
  if (/[\u0000-\u001f\u007f]/u.test(statusMessage)) fail('invalid_response')
  let size = Buffer.byteLength(`HTTP/${response.httpVersion} ${status} ${statusMessage}\r\n\r\n`, 'latin1')
  const headers: Record<string, string> = Object.create(null) as Record<string, string>
  const seen = new Set<string>()
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i], value = raw[i + 1]
    if (typeof name !== 'string' || typeof value !== 'string' || !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name) ||
      /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)) fail('invalid_response')
    size += Buffer.byteLength(name, 'latin1') + Buffer.byteLength(value, 'latin1') + 4
    if (size > PUBLIC_URL_TRANSPORT_LIMITS.headerBytes) fail('invalid_response')
    const key = name.toLowerCase()
    if (seen.has(key) && singletonHeaders.has(key)) fail('invalid_response')
    seen.add(key)
    // Retain every admitted value for engine credential screening. Received
    // cookies are inert strings: no cookie jar, persistence, or request replay.
    headers[key] = headers[key] === undefined ? value : `${headers[key]}, ${value}`
  }
  if (headers.upgrade !== undefined || headers.trailer !== undefined) fail('invalid_response')
  const transfer = headers['transfer-encoding'], contentLength = headers['content-length']
  if (transfer !== undefined && (transfer.trim().toLowerCase() !== 'chunked' || contentLength !== undefined || response.httpVersion !== '1.1')) fail('invalid_response')
  let length: number | undefined
  if (contentLength !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength))) fail('invalid_response')
    length = Number(contentLength)
    if (length > PUBLIC_URL_TRANSPORT_LIMITS.bodyBytes) fail('body_limit')
  }
  return { headers, length }
}

export function createPublicUrlTransport(dependencies: PublicUrlTransportDependencies = nativeDependencies): {
  resolvePublicUrlHost(hostname: string, signal: AbortSignal, assertCurrent?: () => void): Promise<readonly string[]>
  requestPublicUrl(input: PublicUrlRequest): Promise<PublicUrlResponse>
} {
  async function resolvePublicUrlHost(hostname: string, signal: AbortSignal, assertCurrent?: () => void): Promise<readonly string[]> {
    guard(signal, assertCurrent)
    if (typeof hostname !== 'string' || !publicHostname(hostname)) fail('non_public_host')
    if (isIP(hostname)) return Object.freeze([hostname])
    let resolver: PublicUrlResolver
    try { guard(signal, assertCurrent); resolver = dependencies.createResolver() }
    catch (error) { throw sanitized(error, 'dns_error') }
    let rejectCancellation: (error: PublicUrlTransportError) => void = () => {}
    let cleanupFailed = false, cancelled = false
    const cancel = (): void => {
      if (cancelled) return
      cancelled = true
      try { resolver.cancel() } catch { cleanupFailed = true }
    }
    const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject })
    const abort = (): void => { cancel(); rejectCancellation(new PublicUrlTransportError(cleanupFailed ? 'cleanup_failed' : 'cancelled')) }
    signal.addEventListener('abort', abort, { once: true })
    // Also bound independently of an engine deadline; cancel affects this
    // invocation only and does not leave a noncancellable libuv lookup behind.
    const timer = setTimeout(() => { cancel(); rejectCancellation(new PublicUrlTransportError(cleanupFailed ? 'cleanup_failed' : 'dns_error')) },
      PUBLIC_URL_TRANSPORT_LIMITS.dnsMilliseconds)
    try {
      // Scheduling both queries gives all promises rejection handlers before
      // either dependency executes, including synchronous adapter failures.
      const query = (family: 4 | 6): Promise<string[]> => Promise.resolve().then(() => {
        guard(signal, assertCurrent)
        return family === 4 ? resolver.resolve4(hostname) : resolver.resolve6(hostname)
      })
      const results = await Promise.race([Promise.allSettled([query(4), query(6)]), cancellation])
      guard(signal, assertCurrent)
      const answers: string[] = []
      for (let index = 0; index < results.length; index++) {
        const result = results[index]!
        if (result.status === 'rejected') {
          // A missing record family is normal. Any other query failure prevents
          // accepting a partial set whose omitted answers have not been checked.
          if (result.reason instanceof PublicUrlTransportError) throw result.reason
          if (!result.reason || typeof result.reason !== 'object' || result.reason.code !== 'ENODATA') fail('dns_error')
          continue
        }
        if (!Array.isArray(result.value) || answers.length + result.value.length > PUBLIC_URL_TRANSPORT_LIMITS.addresses) fail('non_public_address')
        if (result.value.some(address => !isPublicUrlAddress(address) || isIP(address) !== (index === 0 ? 4 : 6))) fail('non_public_address')
        answers.push(...result.value)
      }
      if (!answers.length) fail('dns_error')
      return Object.freeze([...new Set(answers)])
    } catch (error) { cancel(); throw cleanupFailed ? new PublicUrlTransportError('cleanup_failed') : sanitized(error, 'dns_error') }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  }

  async function requestPublicUrl(input: PublicUrlRequest): Promise<PublicUrlResponse> {
    let url: URL
    try { guard(input.signal, input.assertCurrent); url = validateRequest(input) }
    catch (error) { throw sanitized(error, 'invalid_request') }
    return new Promise<PublicUrlResponse>((resolve, reject) => {
      let socket: TLSSocket | undefined, request: ClientRequest | undefined, incoming: IncomingMessage | undefined
      let failure: PublicUrlTransportError | undefined, settled = false, closed = false, transmitted = false, cleanupFailed = false
      const disposed = new Set<IncomingMessage | ClientRequest | TLSSocket>()
      const close = (): void => {
        closed = true; input.signal.removeEventListener('abort', abort)
        // A dependency can synchronously trigger cancellation before returning
        // its resource. Revisit ownership on every close, without redestroying
        // resources already handled, so late sockets/requests cannot escape.
        for (const resource of [incoming, request, socket]) {
          if (!resource || disposed.has(resource)) continue
          disposed.add(resource)
          if (!resource.destroyed) try { resource.destroy() } catch { cleanupFailed = true }
        }
        if (cleanupFailed) { failure = new PublicUrlTransportError('cleanup_failed'); throw failure }
      }
      const stop = (error: unknown, code: PublicUrlTransportCode = closed ? 'cancelled' : 'transport_failed'): void => {
        failure ??= sanitized(error, code)
        try { close() } catch { failure = new PublicUrlTransportError('cleanup_failed') }
        if (!settled) { settled = true; reject(failure) }
      }
      const abort = (): void => stop(new PublicUrlTransportError('cancelled'))
      const current = (): void => {
        if (failure) throw failure
        if (closed) fail('cancelled')
        guard(input.signal, input.assertCurrent)
      }
      const onResponse = (response: IncomingMessage): void => {
        // A callback may arrive after cancellation/ownership loss. It still
        // belongs to this request and must be destroyed without reading it.
        if (closed || settled) {
          response.on('error', () => {})
          try { response.destroy() } catch { stop(new PublicUrlTransportError('cleanup_failed')) }
          return
        }
        incoming = response
        response.on('error', error => stop(error))
        response.on('aborted', () => { if (!closed) stop(new PublicUrlTransportError('transport_failed')) })
        try {
          current()
          const { headers, length } = responseHeaders(response)
          let reading = false
          const body: AsyncIterable<Uint8Array> = {
            async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
              if (reading) fail('invalid_response')
              reading = true
              let bytes = 0
              try {
                current()
                for await (const chunk of response) {
                  current()
                  if (!(chunk instanceof Uint8Array)) fail('invalid_response')
                  bytes += chunk.byteLength
                  if (bytes > PUBLIC_URL_TRANSPORT_LIMITS.bodyBytes) fail('body_limit')
                  if (length !== undefined && bytes > length) fail('invalid_response')
                  if (chunk.byteLength) yield chunk
                }
                current()
                if (!response.complete || length !== undefined && bytes !== length || response.rawTrailers.length) fail('invalid_response')
              } catch (error) { stop(error); throw failure! }
              finally {
                // Iterator return/break is terminal, including redirects and
                // extraction that reaches its limit before transport EOF.
                close()
              }
            },
          }
          settled = true
          resolve({ status: response.statusCode!, headers, body, close })
        } catch (error) { stop(error) }
      }
      const send = (): void => {
        try {
          current()
          if (!socket || !socket.authorized || socket.remotePort !== 443 || !sameAddress(socket.remoteAddress, input.address) ||
            verifyIdentity(input.hostname, socket.getPeerCertificate()) !== undefined) fail('transport_failed')
          // TLS authorization precedes request construction and all HTTP bytes.
          // No agent, proxy environment, DNS lookup, alternate IP, retry, or TLS
          // session reuse is involved in this direct connection.
          current()
          request = dependencies.request({ protocol: 'https:', hostname: input.hostname, port: 443,
            method: 'GET', path: `${url.pathname}${url.search}`, agent: undefined,
            createConnection: () => { current(); return socket! },
            rejectUnauthorized: true, servername: isIP(input.hostname) ? '' : input.hostname,
            checkServerIdentity: (_hostname, certificate) => verifyIdentity(input.hostname, certificate),
            maxHeaderSize: PUBLIC_URL_TRANSPORT_LIMITS.headerBytes, insecureHTTPParser: false,
            setDefaultHeaders: false, headers: { ...PUBLIC_URL_REQUEST_HEADERS, host: url.host, connection: 'close' },
          }, onResponse)
          request.maxHeadersCount = 0 // Preserve all raw multiplicity; never silently truncate.
          request.on('error', error => stop(error))
          request.on('information', () => stop(new PublicUrlTransportError('invalid_response')))
          request.on('upgrade', (_response, upgraded) => {
            try { upgraded.on('error', () => {}); upgraded.destroy() }
            catch { stop(new PublicUrlTransportError('cleanup_failed')); return }
            stop(new PublicUrlTransportError('invalid_response'))
          })
          request.once('finish', () => {
            // Node's finish means bytes were handed to the local OS. It is
            // evidence of local send only, never remote receipt or side effects.
            if (transmitted) return
            transmitted = true
            try { input.onTransmit() } catch (error) { stop(error) }
          })
          current()
          request.end()
        } catch (error) { stop(error) }
      }
      input.signal.addEventListener('abort', abort, { once: true })
      try {
        current()
        socket = dependencies.connect({ host: input.address, port: 443, family: isIP(input.address),
          autoSelectFamily: false, rejectUnauthorized: true, servername: isIP(input.hostname) ? '' : input.hostname,
          checkServerIdentity: (_hostname, certificate) => verifyIdentity(input.hostname, certificate),
          minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'],
        })
        socket.on('error', error => stop(error))
        socket.once('secureConnect', send)
        socket.once('close', () => {
          if (!closed && !incoming?.complete) stop(new PublicUrlTransportError('transport_failed'))
        })
        // An injected dependency may cancel during creation. Production signal
        // callbacks can also run before TLS completes; own the socket immediately.
        current()
      } catch (error) { stop(error) }
    })
  }
  return { resolvePublicUrlHost, requestPublicUrl }
}
const nativeTransport = createPublicUrlTransport()
export const resolvePublicUrlHost = nativeTransport.resolvePublicUrlHost
export const requestPublicUrl = nativeTransport.requestPublicUrl
