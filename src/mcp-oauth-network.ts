// SPDX-License-Identifier: Apache-2.0
import type { AuthorizationServerMetadata, FetchLike, OAuthDiscoveryState } from '@modelcontextprotocol/client'
import { McpOAuthError } from './mcp-oauth-callback.js'
import { preparePublicUrl } from './public-url.js'

export function mcpOAuthRemoteUrl(value: string): URL {
  let url
  try { url = new URL(value) } catch { throw new McpOAuthError('authorization-failed') }
  if (url.protocol !== 'https:' || url.username || url.password || value.includes('?') || value.includes('#') ||
    value.length > 4096 || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) throw new McpOAuthError('authorization-failed')
  try { preparePublicUrl(value) } catch { throw new McpOAuthError('authorization-failed') }
  return url
}
export function mcpOAuthAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new McpOAuthError('cancelled'))
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new McpOAuthError('cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
export function validateMcpOAuthDiscovery(info: OAuthDiscoveryState, endpoint: string, issuer: string,
  expectedResource = endpoint): AuthorizationServerMetadata {
  const endpointUrl = mcpOAuthRemoteUrl(endpoint), resourceUrl = mcpOAuthRemoteUrl(expectedResource)
  // Root metadata is the sole supported broader resource. A caller cannot use
  // this parameter to bless an unrelated resource or a different endpoint path.
  if (resourceUrl.href !== endpointUrl.href && resourceUrl.href !== `${endpointUrl.origin}/`)
    throw new McpOAuthError('authorization-failed')
  const metadata = info.authorizationServerMetadata
  if (!metadata || metadata.issuer !== issuer || info.authorizationServerUrl !== issuer ||
    !metadata.code_challenge_methods_supported?.includes('S256') || !metadata.response_types_supported.includes('code') ||
    metadata.grant_types_supported && !metadata.grant_types_supported.includes('authorization_code') ||
    metadata.token_endpoint_auth_methods_supported && !metadata.token_endpoint_auth_methods_supported.includes('none'))
    throw new McpOAuthError('authorization-failed')
  mcpOAuthRemoteUrl(metadata.issuer); mcpOAuthRemoteUrl(metadata.authorization_endpoint); mcpOAuthRemoteUrl(metadata.token_endpoint)
  if (info.resourceMetadata && (mcpOAuthRemoteUrl(info.resourceMetadata.resource).href !== resourceUrl.href ||
    info.resourceMetadata.bearer_methods_supported && !info.resourceMetadata.bearer_methods_supported.includes('header')))
    throw new McpOAuthError('authorization-failed')
  return metadata
}
interface McpOAuthFetchOptions {
  readonly fetchFn: FetchLike
  readonly signal: AbortSignal
  readonly origins: readonly string[]
  /** When set, GETs are limited to these exact validated metadata candidates. */
  readonly getEndpoints?: readonly string[]
  /** May tighten the 64 KiB response ceiling, never raise it. */
  readonly responseBytes?: number
  readonly assertCurrent: () => void
  readonly postEndpoint: () => string | undefined
  readonly registerSecrets: (values: readonly string[]) => void
  /** Called immediately before the single approved POST reaches the injected/native fetch. */
  readonly posting?: () => void
  /** Inspect bounded raw data before SDK parsing can discard security-relevant fields. */
  readonly inspectResponse?: (record: Record<string, unknown>, url: URL, response: Response) => void
}
/** OAuth-only bounded SDK fetch seam. No redirects, credentials in URLs or implicit POSTs. */
export function createMcpOAuthFetch(options: McpOAuthFetchOptions): FetchLike {
  const responseBytes = options.responseBytes ?? 64 * 1024
  if (!Number.isSafeInteger(responseBytes) || responseBytes <= 0 || responseBytes > 64 * 1024)
    throw new McpOAuthError('authorization-failed')
  let posted = false
  return async (input, init) => {
    options.assertCurrent()
    const url = mcpOAuthRemoteUrl(String(input instanceof Request ? input.url : input))
    const configuredPost = options.postEndpoint(), post = configuredPost && mcpOAuthRemoteUrl(configuredPost).href
    const signal = AbortSignal.any([options.signal, ...(init?.signal ? [init.signal] : []),
      ...(input instanceof Request ? [input.signal] : [])])
    if (signal.aborted) throw new McpOAuthError('cancelled')
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    if (method === 'GET' && (options.getEndpoints ? !options.getEndpoints.includes(url.href)
      : !options.origins.includes(url.origin) && url.href !== post)) throw new McpOAuthError('authorization-failed')
    if (method !== 'GET') {
      if (method !== 'POST' || !post || url.href !== post || posted) throw new McpOAuthError('authorization-failed')
      posted = true // Consume before any asynchronous SDK continuation can retry.
      options.posting?.()
    }
    const response = await mcpOAuthAbortable(options.fetchFn(input, { ...init, redirect: 'manual', credentials: 'omit', signal }), signal)
    options.assertCurrent()
    if (response.redirected || response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => undefined); throw new McpOAuthError('authorization-failed')
    }
    let headerBytes = 0
    for (const [name, value] of response.headers) headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4
    const contentLength = response.headers.get('content-length')
    if (headerBytes > 16 * 1024 || contentLength !== null &&
      (!/^(?:0|[1-9]\d*)$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > responseBytes)) {
      void response.body?.cancel().catch(() => undefined); throw new McpOAuthError('authorization-failed')
    }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let length = 0
    try {
      if (reader) while (true) {
        options.assertCurrent()
        const part = await mcpOAuthAbortable(reader.read(), signal)
        options.assertCurrent()
        if (part.done) break
        length += part.value.byteLength
        if (length > responseBytes) throw new McpOAuthError('authorization-failed')
        chunks.push(part.value)
      }
    } finally { void reader?.cancel().catch(() => undefined) }
    options.assertCurrent()
    const body = Buffer.concat(chunks).toString('utf8')
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { /* The SDK handles malformed metadata using fixed application errors. */ }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      options.registerSecrets(['access_token', 'refresh_token', 'id_token', 'client_secret', 'registration_access_token']
        .flatMap(key => typeof record[key] === 'string' ? [record[key] as string] : []))
      options.assertCurrent(); options.inspectResponse?.(record, url, response)
    }
    const safeBody = !response.ok ? JSON.stringify({ error: 'server_error' }) : body
    const challenge = response.headers.get('www-authenticate'), contentType = response.headers.get('content-type')
    return new Response(safeBody || null, { status: response.status, headers: { ...(contentType === null ? {} : { 'Content-Type': contentType }),
      ...(challenge === null ? {} : { 'WWW-Authenticate': challenge }) } })
  }
}
