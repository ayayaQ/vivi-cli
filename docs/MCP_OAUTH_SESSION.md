# Session-only MCP OAuth

The CLI owns explicit `/mcp` sign-in controls and a launch-only session adapter.
The implementation is verified with synthetic OAuth responses and owned local
callbacks. OpenRouter is the first selected compatibility target; real registration,
loopback callback acceptance and sign-in have not been verified. No grant is created by saving an MCP entry or
configuring its public client details, and credentials are not stored on disk.

## CLI controls

For an HTTPS MCP entry, configure its already registered public client ID, pinned
issuer, exact callback path and port, and requested scopes. These settings last
only for the current launch. The registered redirect URI must match
`http://127.0.0.1:<port><path>`; the interactive controls require a fixed nonzero
port. Session test hooks may use port 0 and injected browser/fetch implementations.
Alternatively, explicitly register a public client as described below. Public
client settings stay in launch memory after disconnect; configuration replacement,
removal and app shutdown clear them. Bearer credentials are cleared on disconnect.

## Explicit client registration

Interactive hosts enable the generic `dynamicRegistration: 'explicit'` policy.
Embedders default to disabled and must opt in. Registration is a separate human
menu action. Connect, Sign In, transport challenges and model tools never perform it.

1. Enter a pinned issuer, exact fixed 127.0.0.1 callback port/path, requested scopes
   and a public client name. `prepareRegistration(signal)` performs bounded
   discovery and returns an immutable plan. No POST is sent
2. Review the validated registration endpoint and complete public metadata, then
   approve that exact current plan. `beginRegistration(plan, signal)` uses SDK
   2.3.1 `registerClient` for one JSON POST. There is no guessed `/register` fallback
3. Metadata declares native/public `none` authentication, authorization-code/code
   only and the exact callback. Client secrets, changed redirects, unexpected
   grants and broader scopes are rejected. Returned management tokens are
   registered as secrets and discarded; only public client settings are retained
4. Return to the menu. Sign In and MCP Connect require their own fresh approvals

Cancellation, configuration changes and timeout invalidate the registration epoch.
A late response cannot install a client. If a POST was sent but its response is
cancelled, malformed or invalid, the service may still have created a client. A
fixed uncertain-result message requires checking the service before trying again;
the adapter never retries automatically. Local disconnect does not delete the
service's client registration or revoke a provider-side key. DCR is an explicitly
selected compatibility mechanism, not automatic registration; CIMD is unsupported.

Sign-in first discovers a validated plan, then asks for explicit approval showing
the MCP endpoint, issuer, browser authorization endpoint, scopes, public client
and callback details. Denial opens no browser. Cancellation aborts the flow and
closes its listener. A successful sign-in still requires a separate fresh MCP
connect/catalog approval. If that connection is denied or fails, the credentials
are cleared. Disconnect, removal, configuration replacement and app shutdown
also revoke the session. An operation denied with 401/403 clears the credentials
and requires a new explicit sign-in without replaying that operation.

## Explicit lifecycle

An owner creates one `McpOAuthSession` for an immutable MCP endpoint and config
revision, supplying a pre-registered public client ID/issuer, requested scopes,
loopback port and optional exact registered callback path, fetch hook, browser-open hook, secret-registration hook, and a
`configurationIsCurrent` guard.

1. `prepareSignIn(signal)` performs bounded discovery and returns an immutable
   plan with endpoint, issuer, authorization endpoint, public client/callback
   details, exact requested scopes, registration mechanism, config revision and
   auth epoch. It does not open a browser
2. Present that plan for explicit authorization, then call
   `beginSignIn(plan, signal)`. Only the exact current plan object is accepted
3. The listener is ready before browser opening. SDK 2.3.1 generates S256 PKCE,
   constructs the authorization request and performs one code exchange
4. `cancelSignIn()` invalidates the epoch immediately, aborts network work and
   closes the owned listener/sockets. `disconnect()` also removes credentials
5. `requireSignIn()` synchronously revokes credentials after operation denial and
   returns an awaitable listener-cleanup result. It never starts authentication
6. Successful sign-in creates a fresh epoch. Expiration, configuration changes,
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
- Registered public clients only; no client secrets or CIMD; DCR requires its own
  reviewed endpoint/metadata and one explicit approval
- S256 support must be advertised; issuer and exact protected resource are bound
- IPv4 127.0.0.1 callback, exact configured path (random when omitted) and Host, GET only, bounded headers,
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

## Live acceptance and storage

A pre-registered client can supply an exact `redirectPath`, with a bounded ASCII
path that cannot contain URL authority, query, fragment, percent escapes or dot
segments. That exact path is used in the listener, authorization request and token
exchange; high-entropy state is mandatory even with a fixed path. When no path is
configured, the listener uses a fresh random path (used by the initial fixtures).
The selected client's registered URI must match the configured path and port;
port 0 is useful in fixtures and must not be assumed compatible with a service.

OpenRouter's [official MCP docs](https://openrouter.ai/docs/guides/overview/mcp-server)
and [public metadata](https://mcp.openrouter.ai/.well-known/oauth-authorization-server)
advertise `https://mcp.openrouter.ai/mcp`, issuer `https://mcp.openrouter.ai`, PKCE S256,
public-client authentication `none`, and `/oauth/register`. The adapter uses generic
policy and discovery, without a provider exception. Exact loopback callback
acceptance and the returned client metadata must be checked in a later user-driven
live test; the public documents do not establish that acceptance.

OpenRouter says browser consent creates a dedicated API key with seven-day expiry
and a default $10 spending cap, which can be changed before approval. The user must
review those terms and limits themselves. A spending cap does not authorize paid
inference. Initial live acceptance should use only read-only account/model listing,
not `send-message`, `generate-image` or feedback writes. No real registration,
sign-in, grant or paid request was used for these fixtures.

Persistence remains a separate product choice; existing
provider-specific key storage is not an OAuth store. This implementation has no
persistent credential storage, automatic registration or refresh flow.

## Fixture verification

`npm run build` and
`node --test test/mcp-oauth.test.mjs test/mcp-oauth-controls.test.mjs test/application-mcp-oauth.test.mjs test/mcp-oauth-registration.test.mjs test/mcp-oauth-registration-controls.test.mjs` exercise the pinned SDK
with logical HTTPS `.invalid` endpoints routed through an injected fetch and a
real local callback listener. Tests cover PKCE/resource/scope/client binding,
callback rejection/replay, cancellation and late response races, auth epochs,
expiry, browser failure, timeout, port conflicts, listener cleanup, body limits
and redirect rejection. Control fixtures cover explicit approval, cancellation,
fresh HTTP connection, credential invalidation and private host propagation.
Registration fixtures cover exact public metadata, fixed callbacks, single-POST
approval, disabled policy, cancellation, configuration epochs, uncertain outcomes,
response validation, redirect/body bounds and absence of automatic grants.
No external MCP or identity service is contacted.
