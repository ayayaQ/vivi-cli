# Session-only MCP OAuth adapter checkpoint

This is an isolated fixture-tested adapter, not a wired `/mcp` sign-in feature.
It does not change the shared core, install dependencies, open a real account,
register a client, or store credentials on disk.

## Explicit lifecycle

An owner creates one `McpOAuthSession` for an immutable MCP endpoint and config
revision, supplying a pre-registered public client ID/issuer, requested scopes,
loopback port, fetch hook, browser-open hook, secret-registration hook, and a
`configurationIsCurrent` guard.

1. `prepareSignIn(signal)` performs bounded discovery and returns an immutable
   plan with endpoint, issuer, exact requested scopes, registration mechanism,
   config revision and auth epoch. It does not open a browser
2. Present that plan for explicit authorization, then call
   `beginSignIn(plan, signal)`. Only the exact current plan object is accepted
3. The listener is ready before browser opening. SDK 2.3.1 generates S256 PKCE,
   constructs the authorization request and performs one code exchange
4. `cancelSignIn()` invalidates the epoch immediately, aborts network work and
   closes the owned listener/sockets. `disconnect()` also removes credentials
5. Successful sign-in creates a fresh epoch. Expiration, configuration changes,
   cancellation and disconnect invalidate prior snapshots/providers

The owner must cancel/disconnect on configuration replacement and app shutdown.
The guard is also checked before async transitions and token installation. Late
fetches cannot install credentials after cancellation, even if an injected fetch
ignores its AbortSignal.

## HTTP boundary

`authorizationSnapshot()` returns a synchronous trusted `{ revision,
bearerToken? }` snapshot for the HTTP manager. Bind the revision into connect
approval, catalog identity and operation checks. This snapshot contains a secret:
never include the bearer token in an approval, status, model context, transcript,
configuration file or log.

`bearerProvider()` returns a token-only SDK `AuthProvider` bound to the epoch at
creation. It has no `onUnauthorized`. Never pass the internal
`OAuthClientProvider` to a normal HTTP transport: that SDK shape can trigger
interactive authentication and request replay after 401/403. The HTTP operation
boundary must independently enforce one network send; this adapter does not
perform MCP operations or retry them. A 401/403 should produce a safe sign-in-needed
status and require a fresh explicit connect/catalog approval.

The OAuth coordinator uses the SDK's public `discoverOAuthServerInfo`,
`selectResourceURL`, `startAuthorization` and `exchangeAuthorization` helpers.
It avoids `auth()` recovery branches, automatic DCR, refresh, untrusted console
warnings and token-exchange retries.

## Bounds and privacy

- HTTPS-only MCP/issuer/authorization/token URLs without userinfo, query or fragment
- Discovery restricted to the configured MCP and pre-registered issuer origins;
  one token POST is allowed only to the validated token endpoint during exchange
- No HTTP redirects and no response over 64 KiB
- Pre-registered public clients only; no client secrets, DCR or CIMD
- S256 support must be advertised; issuer and exact protected resource are bound
- IPv4 127.0.0.1 callback, exact random path and Host, GET only, bounded headers,
  request URL and sockets, one valid response, duplicate query parameters rejected
- Active-flow state and issuer checked before consuming either success or error
  callbacks; issuer is also validated by SDK exchange
- Fixed browser response and fixed application errors; provider descriptions,
  codes and credentials are never displayed
- State/verifier/code/access/refresh/ID tokens are registered as secrets before
  browser callbacks or SDK result forwarding. Only bearer access tokens are kept;
  refresh tokens are discarded. Reference removal is not memory zeroization
- Requested scopes do not automatically include offline_access; unexpectedly
  broader returned scopes are rejected

## Deferred integration decisions

The first fixture adapter uses a random callback path and allows port 0 for tests.
A real pre-registered client must support the generated redirect path and the
configured port. Most registrations require an exact redirect URI, so its
registration/redirect constraints must be checked for the selected server before
wiring production sign-in. Port 0 must not be assumed compatible with a service.

The user has not selected a real MCP server or persistence backend. Existing
provider-specific key storage is not an OAuth store. No real authorization grant,
registration, login, persistent storage, refresh flow or broader UI integration
is enabled by this checkpoint.

## Fixture verification

`npm run build` and `node --test test/mcp-oauth.test.mjs` exercise the pinned SDK
with logical HTTPS `.invalid` endpoints routed through an injected fetch and a
real local callback listener. Tests cover PKCE/resource/scope/client binding,
callback rejection/replay, cancellation and late response races, auth epochs,
expiry, browser failure, timeout, port conflicts, listener cleanup, body limits
and redirect rejection. No external MCP or identity service is contacted.
