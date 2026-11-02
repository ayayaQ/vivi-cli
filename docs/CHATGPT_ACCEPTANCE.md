# ChatGPT acceptance evidence

This guide prepares user-run checks against the selected canonical private npm
archive. It authorizes no browser login, OAuth grant, native vault access,
revocation or inference. Audit tooling runs only synthetic fixtures. Independent
Mac shell validation uses the exact frozen source and project-local Node >=26.4;
native/manual checks still require separate observations on each OS.

Use the [v2 report contract](../PLATFORM_ACCEPTANCE.md#synthetic-report-contract).
Keep a sanitized receipt tied to candidate SHA, canonical archive SHA-256, actual
OS/architecture/runtime, exact stage and UTC completion time. Retain the receipt
and its SHA-256 outside source. Only fixed stage/check identifiers enter the
structured evidence; omit emails, subjects, account/client/host IDs, tokens,
authorization URLs, callback codes, native output and screen captures containing
private data. `not_run` and `blocked` are valid outcomes. A failed or incomplete
stage must never be promoted to a pass by a successful neighboring stage.

## User-run stages

| Stage | Observation required for a pass |
| --- | --- |
| `chatgptRegistration` | Explicit sign-in issues a registration bound to this host/client flow; cancellation or rejection is not registration success. |
| `chatgptBrowserReturn` | The intended browser flow returns to the CLI and verified identity is bound to the issued registration. A browser success screen alone is insufficient. |
| `chatgptCancellation` | Cancel before return and during a pending flow; the CLI remains usable with no late sign-in or unintended saved credentials. |
| `chatgptAccountWorkspace` | Distinct registrations/workspaces, including the same email where available, remain distinguishable; explicit selection binds the next operation to that registration. Never record the actual email or IDs. |
| `chatgptEntitlement` | Verified sign-in and plan-usage entitlement are separate observations. Missing `chatgpt.tokens.use.direct` prevents inference; enabling plan usage requires explicit consent. No API-key billing fallback. |
| `chatgptRestart` | A new process using the same artifact restores the selected saved sign-in through OS-protected wrapping storage. Locked storage is recorded separately. |
| `chatgptLogout` | The selected registration is signed out and cannot silently reuse saved tokens; other registrations remain intact. Local logout alone does not prove remote revocation. |
| `chatgptRevocation` | Separately authorized remote revocation is actually confirmed. Offline, failed or uncertain revocation is blocked/failed, never inferred from logout. |
| `chatgptSessionOnly` | Explicit session-only choice works when persistence is unavailable, makes no native save and leaves the registration signed out after restart. Do not silently reactivate an older saved token set. |
| `chatgptInference` | Only after separate explicit authorization, one selected plan account completes the approved request with no API-key fallback. Authentication success does not establish request success. |

The exact required check identifiers are exported as `manualStageChecks` from
`scripts/platform-acceptance.mjs`. For entitlement, `planUsageChecked` means the
actual entitlement state was observed, including a correct refusal when absent;
it does not assert inference succeeded. Never send a request merely to validate
registration, browser return, saved storage, cancellation, logout or entitlement.
An account/workspace scenario that cannot be exercised remains `blocked` or
`not_run`; substitute synthetic scenarios do not count as live observations.

## Storage boundaries

Current ChatGPT records are encrypted account envelopes, not plaintext token
JSON and not an imported third-party `auth.json`. The native store contains only
a 32-byte wrapping key in a domain-separated scoped slot. Host/registration
metadata persists separately from account credentials, including for explicitly
session-only registration. The synthetic fixture uses temporary fake registrations
and a mandatory in-memory key store; it tests the current encryption envelope,
AAD, restart, tamper and unavailable-storage behavior without opening a real store.

Before any separately authorized future native probe, establish absence of every
intended target through metadata only. Existing or uncertain targets block the
probe. Never use a value-reading API to test presence; never replace/delete an
existing credential to make a test possible. The production credential API does
not expose an A8 metadata-only presence implementation, so an unavailable safe
probe must stay blocked. Real native writes, logout/deletion and revocation need
their own authorization and are not executed by the report tooling.

## Interpretation

`syntheticResult: passed` proves only the named fake helper/store/report stage.
All live stages remain `not_run` in shell-generated reports, and
`platformAcceptance` remains `pending_manual_validation`. A blocked live stage
does not prevent shipping honest report tooling. Windows and Mac synthetic
results, browser/OAuth observations, actual native-vault behavior, physical key
presses and release authorization remain distinct evidence.
