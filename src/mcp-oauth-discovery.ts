// SPDX-License-Identifier: Apache-2.0
import { buildDiscoveryUrls, discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata } from '@modelcontextprotocol/client'
import type { FetchLike, OAuthDiscoveryState, OAuthProtectedResourceMetadata } from '@modelcontextprotocol/client'
import { McpOAuthError } from './mcp-oauth-callback.js'
import { createMcpOAuthFetch, mcpOAuthAbortable, mcpOAuthRemoteUrl, validateMcpOAuthDiscovery } from './mcp-oauth-network.js'
import { isPublicUrlAddress, resolvePublicUrlHost } from './public-url-transport.js'
import { fetchMcpOAuthNative } from './mcp-oauth-native.js'

export interface McpOAuthMetadataReadOptions {
  readonly signal?: AbortSignal
  readonly assertCurrent?: () => void
  /** Controlled offline seam. Omit (or supply native fetch) for DNS-pinned public HTTPS. */
  readonly fetchFn?: FetchLike
  /** Tests/callers may shorten, but cannot raise, the 15-second discovery deadline. */
  readonly deadlineMs?: number
}
export interface McpOAuthDiscoveryOptions extends McpOAuthMetadataReadOptions {
  /** Select an exact advertised issuer; absent this, select the first advertised issuer. */
  readonly issuer?: string
}
export interface McpOAuthDiscoveryResult {
  readonly info: OAuthDiscoveryState
  readonly resource: string
  readonly issuer: string
  readonly scopes: readonly string[]
}
const scopeToken = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/
function scopes(values: readonly string[]): readonly string[] {
  if (values.length > 32 || values.some(value => !scopeToken.test(value))) throw new McpOAuthError('authorization-failed')
  return Object.freeze([...new Set(values)])
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Parse auth parameters only from one Bearer challenge, including combined scheme headers. */
function bearerChallenge(header: string | null): { resourceMetadataUrl?: string; scope?: string } {
  if (header === null) return {}
  const parts: string[] = []; let part = '', quoted = false, escaped = false
  for (const char of header) {
    if (escaped) { part += char; escaped = false; continue }
    if (quoted && char === '\\') { part += char; escaped = true; continue }
    if (char === '"') quoted = !quoted
    if (char === ',' && !quoted) { parts.push(part.trim()); part = '' } else part += char
  }
  if (quoted || escaped) throw new McpOAuthError('authorization-failed')
  parts.push(part.trim())
  const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+", parameter = new RegExp(`^(${token})[ \\t]*=[ \\t]*(.*)$`)
  const scheme = new RegExp(`^(${token})(?:[ \\t]+(.*))?$`)
  const result: { resourceMetadataUrl?: string; scope?: string } = {}; let bearer = false, seenBearer = false
  const seen = new Set<string>()
  for (let item of parts) {
    if (!parameter.test(item)) {
      const match = scheme.exec(item)
      if (!match) throw new McpOAuthError('authorization-failed')
      bearer = match[1]!.toLowerCase() === 'bearer'
      if (bearer && seenBearer) throw new McpOAuthError('authorization-failed')
      if (bearer) seenBearer = true
      item = match[2] ?? ''
      if (!item || !bearer) continue
    }
    if (!bearer) continue
    const field = parameter.exec(item)
    if (!field) throw new McpOAuthError('authorization-failed')
    const key = field[1]!.toLowerCase(), raw = field[2]!
    if (seen.has(key)) throw new McpOAuthError('authorization-failed')
    seen.add(key)
    let value: string
    if (raw.startsWith('"')) {
      if (!/^"(?:[^"\\\u0000-\u001f\u007f]|\\[\x20-\x7e])*"$/.test(raw)) throw new McpOAuthError('authorization-failed')
      value = raw.slice(1, -1).replace(/\\([\x20-\x7e])/g, '$1')
    } else {
      if (!new RegExp(`^${token}$`).test(raw)) throw new McpOAuthError('authorization-failed')
      value = raw
    }
    if (key === 'resource_metadata') {
      if (!value) throw new McpOAuthError('authorization-failed')
      mcpOAuthRemoteUrl(value); result.resourceMetadataUrl = value
    } else if (key === 'scope') result.scope = value
  }
  return result
}

function discoveryContext(options: McpOAuthMetadataReadOptions) {
  const timeout = options.deadlineMs ?? 15_000
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 15_000) throw new McpOAuthError('authorization-failed')
  const deadline = new AbortController(), signal = AbortSignal.any([deadline.signal, ...(options.signal ? [options.signal] : [])])
  let expired = false
  const timer = setTimeout(() => { expired = true; deadline.abort() }, timeout)
  const guard = (): void => {
    if (expired) throw new McpOAuthError('timeout')
    if (signal.aborted) throw new McpOAuthError('cancelled')
    options.assertCurrent?.()
    if (signal.aborted) throw new McpOAuthError(expired ? 'timeout' : 'cancelled')
  }
  const injectedFetch = options.fetchFn && options.fetchFn !== globalThis.fetch ? options.fetchFn : undefined
  const publicAddresses = async (url: URL): Promise<readonly string[]> => {
    guard()
    const addresses = await mcpOAuthAbortable(resolvePublicUrlHost(url.hostname.replace(/^\[|\]$/g, ''), signal, guard), signal)
    guard()
    if (!addresses.length || addresses.some(address => !isPublicUrlAddress(address))) throw new McpOAuthError('authorization-failed')
    return addresses
  }
  const fetchFor = (urls: readonly string[], responseBytes = 64 * 1024): FetchLike => createMcpOAuthFetch({ fetchFn: injectedFetch ?? fetchMcpOAuthNative,
    signal, responseBytes, origins: [], getEndpoints: urls.map(value => mcpOAuthRemoteUrl(value).href), assertCurrent: guard,
    postEndpoint: () => undefined, registerSecrets: () => {} })
  return { guard, publicAddresses, injectedFetch, fetchFor,
    safeFailure(error: unknown): McpOAuthError {
      if (expired) return new McpOAuthError('timeout')
      if (signal.aborted || error instanceof McpOAuthError && error.code === 'cancelled') return new McpOAuthError('cancelled')
      return new McpOAuthError('authorization-failed')
    },
    close(): void { clearTimeout(timer); deadline.abort() },
  }
}

/** An optional CIMD read. This performs only one exact GET, never registration. */
export async function fetchMcpOAuthClientMetadata(url: string, options: McpOAuthMetadataReadOptions = {}): Promise<Record<string, unknown>> {
  const endpoint = mcpOAuthRemoteUrl(url), context = discoveryContext(options)
  try {
    context.guard()
    const response = await context.fetchFor([endpoint.href], 5 * 1024)(endpoint.href, { method: 'GET', headers: { Accept: 'application/json' } })
    context.guard()
    if (!response.ok || !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;.*)?$/i.test(response.headers.get('content-type') ?? ''))
      throw new McpOAuthError('authorization-failed')
    const document: unknown = await response.json()
    context.guard()
    if (!document || typeof document !== 'object' || Array.isArray(document)) throw new McpOAuthError('authorization-failed')
    return freeze(document as Record<string, unknown>)
  } catch (error) { throw context.safeFailure(error) }
  finally { context.close() }
}

/** URL-first discovery only: no client registration, browser, token exchange, or MCP replay. */
export async function discoverMcpOAuth(endpoint: string, options: McpOAuthDiscoveryOptions = {}): Promise<McpOAuthDiscoveryResult> {
  const endpointUrl = mcpOAuthRemoteUrl(endpoint)
  if (options.issuer !== undefined) mcpOAuthRemoteUrl(options.issuer)
  const context = discoveryContext(options), { guard, publicAddresses, injectedFetch, fetchFor } = context
  try {
    guard()
    const challengeResponse = await fetchFor([endpointUrl.href])(endpointUrl.href, { method: 'GET', headers: { Accept: 'application/json' } })
    guard()
    const challenge = bearerChallenge(challengeResponse.status === 401 ? challengeResponse.headers.get('www-authenticate') : null)
    const challengeScopes = challenge.scope === undefined ? undefined : scopes(challenge.scope ? challenge.scope.split(' ') : [])
    let pathname = endpointUrl.pathname
    if (pathname.endsWith('/')) pathname = pathname.slice(0, -1)
    const pathMetadata = `${endpointUrl.origin}/.well-known/oauth-protected-resource${pathname}`
    const rootMetadata = `${endpointUrl.origin}/.well-known/oauth-protected-resource`
    const candidates = challenge.resourceMetadataUrl
      ? [{ url: challenge.resourceMetadataUrl, resource: endpointUrl.href }]
      : [{ url: pathMetadata, resource: endpointUrl.href }, ...(pathMetadata === rootMetadata ? [] : [{ url: rootMetadata, resource: endpointUrl.origin }])]
    let resourceMetadata: OAuthProtectedResourceMetadata | undefined, resourceMetadataUrl: string | undefined, resource: string | undefined
    for (const candidate of candidates) {
      guard()
      const fetchCandidate = fetchFor([candidate.url])
      const response = await fetchCandidate(candidate.url, { method: 'GET', headers: { Accept: 'application/json' } })
      guard()
      if (!response.ok) {
        if (!challenge.resourceMetadataUrl && (response.status < 500 || response.status === 502)) continue
        throw new McpOAuthError('authorization-failed')
      }
      // Reuse the SDK schema without another network request or any URL fallback.
      resourceMetadata = await discoverOAuthProtectedResourceMetadata(endpointUrl.href, { resourceMetadataUrl: candidate.url },
        async () => { guard(); return response })
      guard()
      mcpOAuthRemoteUrl(resourceMetadata.resource)
      if (mcpOAuthRemoteUrl(resourceMetadata.resource).href !== mcpOAuthRemoteUrl(candidate.resource).href || !resourceMetadata.authorization_servers?.length ||
        resourceMetadata.authorization_servers.length > 16 || resourceMetadata.bearer_methods_supported &&
        !resourceMetadata.bearer_methods_supported.includes('header') || resourceMetadata.dpop_bound_access_tokens_required === true)
        throw new McpOAuthError('authorization-failed')
      resourceMetadataUrl = mcpOAuthRemoteUrl(candidate.url).href; resource = resourceMetadata.resource
      break
    }
    if (!resourceMetadata || !resource || !resourceMetadataUrl) throw new McpOAuthError('authorization-failed')
    for (const value of resourceMetadata.authorization_servers!) mcpOAuthRemoteUrl(value)
    const issuer = options.issuer ?? resourceMetadata.authorization_servers![0]!
    if (!resourceMetadata.authorization_servers!.includes(issuer)) throw new McpOAuthError('authorization-failed')
    const authorizationServerMetadata = await discoverAuthorizationServerMetadata(issuer, {
      fetchFn: fetchFor(buildDiscoveryUrls(issuer).map(candidate => candidate.url.href)) })
    guard()
    const info: OAuthDiscoveryState = { authorizationServerUrl: issuer, ...(authorizationServerMetadata ? { authorizationServerMetadata } : {}),
      resourceMetadata, resourceMetadataUrl }
    const metadata = validateMcpOAuthDiscovery(info, endpointUrl.href, issuer, resource)
    if (!metadata.token_endpoint_auth_methods_supported?.includes('none')) throw new McpOAuthError('authorization-failed')
    for (const value of [metadata.authorization_endpoint, metadata.token_endpoint, ...(metadata.registration_endpoint ? [metadata.registration_endpoint] : [])]) {
      guard(); const url = mcpOAuthRemoteUrl(value)
      if (!injectedFetch) await publicAddresses(url)
      guard()
    }
    const selectedScopes = challengeScopes ?? scopes(resourceMetadata.scopes_supported ?? [])
    guard()
    return freeze({ info, resource, issuer, scopes: selectedScopes })
  } catch (error) {
    throw context.safeFailure(error)
  } finally { context.close() }
}
