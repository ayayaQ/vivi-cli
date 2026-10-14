# Saved MCP sign-in and refresh

The CLI hosts wire privileged saved-credential hooks for reviewed browser sign-in
and later approved Connect actions. Existing custom embedders remain session-only
unless they explicitly supply `savedStore`; no injected test/host automatically
accesses the native credential store.

## Storage

`McpOAuthStore` keeps one OS-keyring wrapping key per canonical private profile
(`--session-dir`), in a narrowly allowlisted namespace separate from provider keys.
The existing provider credential API and its OpenAI/OpenRouter slots are unchanged.
A 32-byte key fits the Windows 2560-byte credential limit and the existing macOS
helper bound. Individual OAuth credentials can be substantially larger.

Public-client settings and tokens live together in bounded AES-256-GCM encrypted
per-server records. They never enter `mcp-servers.json`, preferences, transcript,
model context, approval text or logs. Authentication binds record/server identity,
endpoint, issuer, client ID, exact resource and granted scopes. Reads reject
malformed data, tampering, symlinks, hard links and nonprivate POSIX files.
Windows files rely on inherited directory ACLs plus user-bound OS credential
protection; this slice does not modify permissions or claim to validate NTFS ACLs.

Records use private temporary files, file sync and atomic replacement. POSIX
parent directories are synced. Windows does not expose the same directory-sync
path here; power-loss durability and real native credential behavior require
Windows acceptance. Normal operation is limited to eight records. Crashed
app-owned encrypted temporaries are cleaned during the next mutation.

A tiny SQLite database contains no credentials and serves only as a cross-process
mutex. Node's built-in SQLite and Bun's built-in SQLite supply OS-released locks.
No package/native dependency, custom PID lease, timeout-based stealing or
persistent generation tree is added. A crashed writer releases the native mutex.
The pending-refresh marker remains durable, so its potentially rotated refresh
token cannot be reused. Normal Sign in again writes fresh approved credentials.
The store is intended for a local private profile, not a shared/network drive.

Locked, missing, corrupt or unsupported secure storage gives a fixed safe error.
The host must offer an explicit session-only choice. No plaintext fallback occurs.
A lost wrapping key is never silently regenerated over existing records.

## Privileged APIs

- `load(serverId, endpoint)` returns a bound record; a pending refresh returns its
  public client and revision without credentials
- `saveClient(serverId, endpoint, client, isCurrent, signal)` saves public settings
  without a grant, under the same cancellation/identity guard
- `saveTokens(serverId, endpoint, revision, tokens, isCurrent)` checks revision and
  persists a validated bundle before it can become active
- `refreshTokens(serverId, endpoint, revision, perform, isCurrent, signal)` serializes
  one refresh, marks it pending before network work, and atomically stores the result
- `clearTokens(serverId, endpoint, revision?)` forgets credentials while retaining
  public client settings. Explicit logout can forget an unreadable entire record;
  an old HTTP-denial revision cannot delete an unreadable replacement
- `remove(serverId)` forgets the local record
- `settle()` waits for this process's in-flight persistence before logout/removal
- `reconcile(servers)` prunes stale identities during an approved Connect action

All credential-bearing objects stay inside the privileged host. Register loaded
and returned secrets with the existing redaction pipeline before anything can
reach output. Do not pass an internal OAuth provider to an HTTP transport.

## Session and host wiring

`McpOAuthSession` accepts `initialCredentials`, `saveCredentials(tokens, context)`
and `refreshCredentials(perform, context)`. The immutable context contains
`signal` and `isCurrent`; both must reach the store. A closure must retain the
latest saved record/revision after each update. Supplied discovery is validated
against configured resource/issuer before restored bearer authority is exposed.

Refresh is an explicit pre-connect host step, after fresh human Connect approval.
The host uses validated challenge/path/root discovery, then the session uses the SDK's
`refreshAuthorization` helper for one token POST with the existing client/resource.
No scope expansion, browser interaction, automatic registration, MCP request
replay or transport `onUnauthorized` hook occurs. Omitted expiry remains unknown.
Rotated refresh credentials must be durable before the new bearer epoch is usable.
Failed or uncertain refresh clears authority and requires fresh browser sign-in.

The transaction deadline revokes its guard immediately. An idle refresh callback
can be abandoned. A key save or atomic filesystem mutation already in progress
must settle before unlocking, because releasing early can corrupt a fresh write
from another process. Native helpers already have bounded process deadlines.

Host lifecycle requirements:

1. Restore a saved record only for the current approved server identity
2. Before reconnecting, restore/refresh as needed, then ask for fresh catalog/connect
   approval bound to the final authorization epoch
3. Disconnect and shutdown clear RAM but retain approved saved sign-in
4. Logout excludes new per-server attempts, cancels current work and clears RAM
   immediately, waits for `settle()`, then clears saved tokens. Public client settings
   normally remain. Removal holds the same exclusion through its configuration commit
5. Removal or a changed endpoint/client/issuer/resource/scopes removes the old record
6. Specific current-epoch HTTP 401/403 invalidation clears saved tokens too; global
   expiry/catalog invalidation retains eligible refresh credentials. Do not silently
   restore or retry denied authority
7. Another process's live transaction returns actionable busy status; retry approved
   cleanup after it finishes rather than changing permissions or stealing a lock

Local disconnect/logout/removal does not revoke an issuer's grant, API key or
public client registration. Provider-side revocation is a separate explicit action.

## Verification

Offline fixtures use synthetic OAuth responses, loopback callbacks and fake key
adapters. They cover restart, large and opaque tokens, identity/scopes binding,
tamper/private-file rejection, lost keys, cross-process contention and crash,
uncertain rotation, timeout/cancellation, key-save joining, pending durability and
late-result rejection. The compiled Bun fixture exercises the same native SQLite
lease and crash recovery in a standalone executable. No real credentials, client
registration, authorization grant or authenticated service request is used.

The existing CI inventory includes these OAuth fixtures on minimum/current Windows
Node and pinned Windows Bun. The acceptance workflow also compiles and runs the
synthetic standalone crash probe on Linux and Windows. Windows symlink checks skip
only when the fixture host lacks symlink privilege; other coverage still runs.
Adding these gates does not claim they have already passed on Windows.

Primary references:

- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [OAuth security best practices](https://www.rfc-editor.org/rfc/rfc9700.html)
- [Token revocation](https://www.rfc-editor.org/rfc/rfc7009.html)
- [Windows native credential limits](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)
- [Node crypto](https://nodejs.org/api/crypto.html)
- [Node SQLite](https://nodejs.org/api/sqlite.html)
- [Bun SQLite](https://bun.sh/docs/runtime/sqlite)
