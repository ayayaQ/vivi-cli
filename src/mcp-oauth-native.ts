// SPDX-License-Identifier: Apache-2.0
import { X509Certificate } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import type { RequestOptions } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { checkServerIdentity } from 'node:tls'
import type { PeerCertificate, TLSSocket } from 'node:tls'
import type { FetchLike } from '@modelcontextprotocol/client'
import { McpOAuthError } from './mcp-oauth-callback.js'
import { mcpOAuthAbortable, mcpOAuthRemoteUrl } from './mcp-oauth-network.js'
import { isPublicUrlAddress, resolvePublicUrlHost } from './public-url-transport.js'

export const MCP_OAUTH_NATIVE_LIMITS = Object.freeze({ bodyBytes: 64 * 1024, headerBytes: 16 * 1024,
  addresses: 16, deadlineMs: 15_000 })
/** Offline test seams only. CLI input cannot supply network or TLS options. */
export interface McpOAuthNativeDependencies {
  resolvePublicUrlHost: typeof resolvePublicUrlHost
  request(options: RequestOptions & { autoSelectFamily: false; ALPNProtocols: string[] },
    callback: (response: IncomingMessage) => void): ClientRequest
}
const nativeDependencies: McpOAuthNativeDependencies = { resolvePublicUrlHost,
  request: (options, callback) => httpsRequest(options, callback) }
function fail(): never { throw new McpOAuthError('authorization-failed') }
function ipNumber(value: string): bigint {
  if (isIP(value) === 4) return value.split('.').reduce((result, part) => result * 256n + BigInt(part), 0n)
  const [left = '', right = ''] = value.split('::'), first = left.split(':').filter(Boolean), last = right.split(':').filter(Boolean)
  return [...first, ...Array(8 - first.length - last.length).fill('0') as string[], ...last]
    .reduce((result, part) => result * 65_536n + BigInt(`0x${part}`), 0n)
}
function sameAddress(actual: string | undefined, expected: string): boolean {
  return !!actual && isPublicUrlAddress(actual) && isIP(actual) === isIP(expected) && ipNumber(actual) === ipNumber(expected)
}
function verifyIdentity(hostname: string, certificate: PeerCertificate): Error | undefined {
  if (isIP(hostname) !== 6) return checkServerIdentity(hostname, certificate)
  // Node's hostname matcher normalizes bare IPv6 as a domain. IP SANs must
  // authorize literals; a DNS SAN or common name cannot authorize one.
  try { if (new X509Certificate(certificate.raw).checkIP(hostname) !== undefined) return undefined }
  catch { /* Malformed/missing peer certificates fail closed. */ }
  return new McpOAuthError('authorization-failed')
}
const forbiddenHeaders = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'content-length', 'expect', 'cookie', 'cookie2', 'authorization', 'proxy-authorization', 'proxy-connection'])
function requestHeaders(init: RequestInit | undefined, url: URL, body: string | undefined): Record<string, string> {
  const headers: Record<string, string> = Object.create(null) as Record<string, string>
  let bytes = 0
  const add = (name: unknown, value: unknown): void => {
    if (typeof name !== 'string' || typeof value !== 'string' || !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name) ||
      /[\u0000-\u0008\u000a-\u001f\u007f\u0100-\uffff]/u.test(value)) fail()
    const key = name.toLowerCase()
    if (forbiddenHeaders.has(key) || headers[key] !== undefined || key === 'accept-encoding' && value !== 'identity') fail()
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4
    if (bytes > MCP_OAUTH_NATIVE_LIMITS.headerBytes) fail()
    headers[key] = value
  }
  const source = init?.headers
  if (source instanceof Headers) for (const [name, value] of source) add(name, value)
  else if (Array.isArray(source)) for (const pair of source) {
    if (!Array.isArray(pair) || pair.length !== 2) fail()
    add(pair[0], pair[1])
  }
  else if (source !== undefined) {
    if (!source || typeof source !== 'object') fail()
    for (const [name, value] of Object.entries(source)) add(name, value)
  }
  if (headers['accept-encoding'] === undefined) add('accept-encoding', 'identity')
  headers.host = url.host; headers.connection = 'close'
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body))
  bytes += Buffer.byteLength(`host: ${url.host}\r\nconnection: close\r\n\r\n`) +
    (body === undefined ? 0 : Buffer.byteLength(`content-length: ${headers['content-length']}\r\n`))
  if (bytes > MCP_OAUTH_NATIVE_LIMITS.headerBytes) fail()
  return headers
}
const singletonHeaders = new Set(['content-type', 'content-length', 'content-encoding', 'transfer-encoding', 'location',
  'connection', 'upgrade', 'trailer'])
function readHeaders(response: IncomingMessage): { headers: Headers; length: number | undefined } {
  const status = response.statusCode, raw = response.rawHeaders, version = response.httpVersion
  if (!Number.isInteger(status) || status === undefined || status < 200 || status > 599 || status >= 300 && status < 400 ||
    !Array.isArray(raw) || raw.length % 2 || !['1.0', '1.1'].includes(version) ||
    /[\u0000-\u001f\u007f]/u.test(response.statusMessage ?? '')) fail()
  let bytes = Buffer.byteLength(`HTTP/${version} ${status} ${response.statusMessage ?? ''}\r\n\r\n`, 'latin1')
  if (bytes > MCP_OAUTH_NATIVE_LIMITS.headerBytes) fail()
  const headers = new Headers(), seen = new Set<string>()
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i], value = raw[i + 1]
    if (typeof name !== 'string' || typeof value !== 'string' || !/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name) ||
      /[\u0000-\u0008\u000a-\u001f\u007f]/u.test(value)) fail()
    bytes += Buffer.byteLength(name, 'latin1') + Buffer.byteLength(value, 'latin1') + 4
    if (bytes > MCP_OAUTH_NATIVE_LIMITS.headerBytes) fail()
    const key = name.toLowerCase()
    if (seen.has(key) && singletonHeaders.has(key)) fail()
    seen.add(key); headers.append(name, value)
  }
  const transfer = headers.get('transfer-encoding'), lengthValue = headers.get('content-length'), encoding = headers.get('content-encoding')
  if (headers.has('upgrade') || headers.has('trailer') || encoding !== null && encoding.toLowerCase().trim() !== 'identity' ||
    transfer !== null && (transfer.trim().toLowerCase() !== 'chunked' || lengthValue !== null || version !== '1.1')) fail()
  let length: number | undefined
  if (lengthValue !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(lengthValue) || !Number.isSafeInteger(Number(lengthValue))) fail()
    length = Number(lengthValue)
    if (length > MCP_OAUTH_NATIVE_LIMITS.bodyBytes) fail()
  }
  return { headers, length }
}

/** OAuth-only native fetch. Exact URL/method consent remains in createMcpOAuthFetch. */
export function createMcpOAuthNativeFetch(dependencies: McpOAuthNativeDependencies = nativeDependencies,
  options: { readonly deadlineMs?: number } = {}): FetchLike {
  const deadlineMs = options.deadlineMs ?? MCP_OAUTH_NATIVE_LIMITS.deadlineMs
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > MCP_OAUTH_NATIVE_LIMITS.deadlineMs) fail()
  return async (input, init) => {
    // Accept the SDK's JSON strings and URLSearchParams; never arbitrary streams,
    // multipart bodies, credentials, redirects, or caller TLS/network options.
    const url = mcpOAuthRemoteUrl(String(input)), hostname = url.hostname.replace(/^\[|\]$/g, '')
    const method = (init?.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'POST' || init?.redirect !== undefined && init.redirect !== 'manual' ||
      init?.credentials !== undefined && init.credentials !== 'omit' ||
      init?.body !== undefined && init.body !== null && typeof init.body !== 'string' && !(init.body instanceof URLSearchParams)) fail()
    const body = init?.body == null ? undefined : String(init.body)
    if (method === 'GET' && body !== undefined || body !== undefined && Buffer.byteLength(body) > MCP_OAUTH_NATIVE_LIMITS.bodyBytes) fail()
    const headers = requestHeaders(init, url, body)
    const deadline = new AbortController(), signal = AbortSignal.any([deadline.signal, ...(init?.signal ? [init.signal] : [])])
    let expired = false
    const timer = setTimeout(() => { expired = true; deadline.abort() }, deadlineMs)
    const guard = (): void => { if (signal.aborted) throw new McpOAuthError(expired ? 'timeout' : 'cancelled') }
    try {
      guard()
      const addresses = await mcpOAuthAbortable(dependencies.resolvePublicUrlHost(hostname, signal, guard), signal)
      guard()
      if (!Array.isArray(addresses) || !addresses.length || addresses.length > MCP_OAUTH_NATIVE_LIMITS.addresses ||
        addresses.some(address => !isPublicUrlAddress(address))) fail()
      const address = addresses[0]!
      if (isIP(hostname) && !sameAddress(hostname, address)) fail()
      return await new Promise<Response>((resolve, reject) => {
        let request: ClientRequest | undefined, socket: TLSSocket | undefined, incoming: IncomingMessage | undefined
        let settled = false, sent = false, cleanupFailed = false
        const disposed = new Set<ClientRequest | TLSSocket | IncomingMessage>()
        const close = (): void => {
          signal.removeEventListener('abort', abort)
          for (const resource of [incoming, request, socket]) {
            if (!resource || disposed.has(resource)) continue
            disposed.add(resource)
            if (!resource.destroyed) try { resource.destroy() } catch { cleanupFailed = true }
          }
        }
        const stop = (): void => {
          const wasSettled = settled; settled = true; close()
          if (!wasSettled) reject(new McpOAuthError(signal.aborted ? expired ? 'timeout' : 'cancelled' : 'authorization-failed'))
        }
        const abort = (): void => stop()
        const current = (): void => { guard(); if (settled) fail() }
        const onResponse = (response: IncomingMessage): void => {
          response.on('error', stop)
          if (settled) { try { response.destroy() } catch { /* Already terminal; never expose native errors. */ } return }
          incoming = response
          try {
            current(); if (!sent) fail()
            const metadata = readHeaders(response), chunks: Buffer[] = []; let bytes = 0
            response.on('aborted', stop)
            response.on('close', () => { if (!response.complete) stop() })
            response.on('data', (chunk: unknown) => {
              try {
                current(); if (!(chunk instanceof Uint8Array)) fail()
                bytes += chunk.byteLength
                if (bytes > MCP_OAUTH_NATIVE_LIMITS.bodyBytes || metadata.length !== undefined && bytes > metadata.length) fail()
                chunks.push(Buffer.from(chunk))
              } catch { stop() }
            })
            response.on('end', () => {
              try {
                current()
                if (!response.complete || response.rawTrailers.length || metadata.length !== undefined && bytes !== metadata.length) fail()
                const result = new Response(bytes ? Buffer.concat(chunks) : null, { status: response.statusCode!, headers: metadata.headers })
                settled = true; close()
                if (cleanupFailed) reject(new McpOAuthError('authorization-failed')); else resolve(result)
              } catch { stop() }
            })
          } catch { stop() }
        }
        const ready = (): void => {
          try {
            current()
            if (sent || !request || request.destroyed || !socket || socket.destroyed || !socket.authorized || socket.remotePort !== 443 || !sameAddress(socket.remoteAddress, address) ||
              verifyIdentity(hostname, socket.getPeerCertificate()) !== undefined) fail()
            // No HTTP headers or POST bytes are queued before TLS authorization
            // and the pinned peer-IP check. No retries or alternate IP fallback.
            current(); sent = true; request!.end(body)
          } catch { stop() }
        }
        const onSocket = (connected: TLSSocket): void => {
          connected.on('error', stop)
          if (socket || settled) { try { connected.destroy() } catch { /* Terminal or duplicate socket. */ } if (!settled) stop(); return }
          socket = connected
          connected.once('close', () => { if (!incoming?.complete) stop() })
          connected.once('secureConnect', ready)
        }
        signal.addEventListener('abort', abort, { once: true })
        try {
          current()
          request = dependencies.request({ protocol: 'https:', hostname, port: 443, method, path: url.pathname,
            agent: false, family: isIP(address), autoSelectFamily: false,
            lookup: (_host, lookupOptions, callback) => {
              try {
                current()
                if (typeof lookupOptions === 'object' && lookupOptions.all) callback(null, [{ address, family: isIP(address) }])
                else callback(null, address, isIP(address))
              } catch { callback(new McpOAuthError(signal.aborted ? expired ? 'timeout' : 'cancelled' : 'authorization-failed'), '', 0) }
            },
            rejectUnauthorized: true, servername: isIP(hostname) ? '' : hostname,
            checkServerIdentity: (_host, peer) => verifyIdentity(hostname, peer), minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'],
            maxHeaderSize: MCP_OAUTH_NATIVE_LIMITS.headerBytes, insecureHTTPParser: false, setDefaultHeaders: false, headers,
          }, onResponse)
          request.maxHeadersCount = 0
          request.on('error', stop); request.on('information', stop)
          request.on('upgrade', (_response, upgraded) => { upgraded.on('error', () => {}); upgraded.destroy(); stop() })
          request.on('socket', onSocket)
          current()
        } catch { stop(); close() }
      })
    } catch {
      throw new McpOAuthError(signal.aborted ? expired ? 'timeout' : 'cancelled' : 'authorization-failed')
    } finally { clearTimeout(timer); deadline.abort() }
  }
}
export const fetchMcpOAuthNative: FetchLike = createMcpOAuthNativeFetch()
