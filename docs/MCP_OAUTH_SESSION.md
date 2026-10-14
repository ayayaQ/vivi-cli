# MCP browser setup

The first onboarding slice supports URL/name-first HTTP setup and launch-only
browser authentication. Saved authentication/refresh and agent setup follow in
separate slices. No live registration, grant, paid call, or physical-terminal
acceptance is claimed by fixture tests.

## User flow

- `/mcp`: Add MCP server (URL), then choose Connect. A challenge leads directly
  to guided sign-in. Known sign-in needs show Sign in; a failed connection shows
  Reconnect. Connected servers offer Disconnect and metadata browsing
- `vivi mcp add NAME URL`, `list`, `login NAME`, `connect NAME`, `logout NAME`,
  and `remove NAME` work without a model/provider key. Add saves disabled;
  standalone connections close when the command exits. Piped approval is denied
- Advanced contains protocol, existing public client/issuer/callback/scopes,
  optional hosted JSON client metadata, and manual DCR overrides

Discovery reads a Bearer challenge and its protected-resource metadata URL, or
path/root well-known metadata, then RFC8414/OIDC issuer metadata. Each candidate
has an expected resource; root metadata may bind the origin resource. Issuer
comparison is exact. Initial scopes come from the challenge, otherwise protected
resource metadata, otherwise no scope. The authorization server's full scope
catalog is never guessed as requested access.

Existing issuer-bound public clients are preferred. If configured and supported,
a hosted HTTPS JSON CIMD document must identify its exact URL and a supported
fixed 127.0.0.1 callback, public `none` authentication, authorization-code/code,
and no client secret. No hosted vivi document is assumed. Otherwise advertised
DCR is prepared with native/public metadata, default callback
`http://127.0.0.1:52147/oauth/callback`, and discovered scopes. Unsupported setups
receive an Advanced preregistration path. DCR is retained for compatibility;
current MCP recommends CIMD for new implementations.

One exact guided approval discloses endpoint, resource, issuer, authorization
URL, scopes, client/callback or registration metadata, protocol, and configuration
revision. It covers that public registration once if needed, browser sign-in,
and fresh connection/tool metadata discovery. Browser consent stays human;
subsequent calls and resource reads require separate human approval even in Auto.
Manual Advanced registration remains a separate reviewed compatibility action.

## Security and lifetime

- HTTPS public targets, no URL credentials/query/fragment, redirects or cookies
- Bounded metadata (64 KiB; CIMD 5 KiB), aborts and deadlines; public DNS-pinned
  discovery, registration and token requests, with TLS/peer checks before sending
- Validated resource/issuer, advertised S256, public client and exact callback
- Random state, PKCE, exact callback Host/path, duplicate parameter rejection,
  and RFC9207 issuer validation before code exchange, including error responses
- Fresh configuration/auth epochs and immutable single-use registration/sign-in
  plans; late cancellation/configuration responses cannot install authority
- One registration POST and code exchange; uncertain registration is not retried
- Secret registration before SDK results/display; no tokens in configuration,
  approvals, model context, transcripts or logs
- Token-only normal HTTP provider: no interactive auth hooks, operation replay,
  silent registration, refresh or automatic browser opening on 401/403

Session credentials clear on disconnect, removal, configuration changes and
shutdown. Public client settings remain only for the launch. Local logout does
not revoke issuer-side grants/keys or delete their registration. Configuration
edits currently disconnect all MCP connections because their catalog/approval
identities bind the whole configuration revision; affected servers are disclosed.

## Verification and compatibility

Offline `.invalid` fetch fixtures and owned local callbacks cover discovery order,
resource/issuer validation, scope selection, DCR/CIMD selection, consent denial,
PKCE/resource/client binding, callback rejection, cancellation/stale races,
uncertain registration, fresh catalogs, CLI isolation and privacy boundaries.
No external identity service is contacted.

The implementation follows [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
and the URL-first [Claude Code flow](https://code.claude.com/docs/en/mcp).
Actual issuer registration policy and exact loopback acceptance still need a
user-driven live test. Provider consent may create billable account access;
review its permissions, expiry and spending limits yourself. No spending limit
in a consent page authorizes paid inference.
