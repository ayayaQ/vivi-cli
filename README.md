# vivi CLI

Chat with your ChatGPT plan, an OpenAI API key, OpenRouter or DeepSeek from your terminal.

## Run from source

Requires Node.js 26.4+ and [Bun](https://bun.sh) 1.3+ for the full-screen interface.
The CLI is not yet published to npm.

```sh
git clone https://github.com/ayayaQ/vivi-cli.git
cd vivi-cli
npm ci --ignore-scripts
npm run build
bun dist/launcher.js
```

## Usage

Each launch starts a fresh conversation. An unconfigured interactive launch opens
the existing provider/key and model pickers automatically. Escape cancels; use
`/provider` to retry. Configured launches use saved defaults without repeating setup.

- `/provider` — choose official Continue with ChatGPT or an API-key provider
- `/web` — independently choose Direct, DeepSeek or Disabled web access
- `/reviewer` — explicitly choose this conversation’s OpenAI/OpenRouter Auto reviewer
- `/account` — choose a ChatGPT account/workspace, enable plan usage or sign out
- `/usage` — show the ChatGPT usage settings link
- `/models` — search and select a model
- `/effort` — choose a supported reasoning effort
- `/mode` — choose Manual, Auto review or explicit Skip permissions for this conversation
- `/new` — start a fresh conversation
- `/resume` — continue a saved conversation
- `/rename` — rename the current conversation (or `/rename NAME` in line mode)
- `/notes` — change the session-note default for new conversations
- `/menu` — open independent actions (`/settings` remains a legacy alias)
- `/memories` — manage this launch’s app-wide saved context and its future-launch default
- `/commands` — inspect or disable reviewed unsandboxed command proposals
- `/skills` — inspect instruction-only skills and prepare creator drafts
- `/instructions` — inspect, reload or disable scoped `AGENTS.md` guidance
- `/mcp` — configure and explicitly connect trusted installed stdio servers or HTTP endpoints for reviewed tools and resource reads
- `/context` — show effective-request occupancy, model capacity, source freshness and output reserve
- `/compact` — summarize eligible older provider context, retaining the full local transcript
- `/queue` — inspect, send, undo-to-edit or clear retained messages
- `/session` — show the current session ID and saved usage
- `/help` — show commands and shortcuts
- `/exit` — quit

### Continue with ChatGPT

Choose **Continue with ChatGPT** in `/provider`, or use line-mode controls:

```sh
vivi auth login
vivi auth list
vivi --provider chatgpt --chatgpt-account ACCOUNT_ID --model MODEL --no-tui
vivi auth logout --chatgpt-account ACCOUNT_ID
```

Use the exact registration ID from `auth list`; account/workspace registrations
remain separate even with the same email. `/models` shows the signed-in account's
catalog in server order. Model capabilities remain unknown unless advertised or
explicitly declared for this launch; no model availability or reasoning effort is
inferred from the login. In line mode, `--tools` explicitly declares function-tool
support, and nondefault reasoning still needs `--reasoning-capabilities`.

Official dynamic registration uses Vivi's own issued client ID, PKCE and verified
OIDC identity. No legacy Codex client IDs, shared `auth.json`, or ChatGPT private
backend endpoints are used. Saved token records are encrypted using an OS-protected
wrapping key; there is no plaintext fallback. The UI offers an explicit launch-only
choice when secure storage is unavailable. Signing out clears tokens and attempts
remote refresh-session revocation, while retaining the nonsecret registration and
stable opaque host ID. Unconfirmed revocation is reported.

Eligible requests use your ChatGPT plan, never an automatic API-key billing fallback.
[Manage ChatGPT usage](https://chatgpt.com/settings/usage). Local history is replayed
with `store: false`; HTTP always uses SSE, even when `--no-stream` buffers the UI.
Auto review requires a separately, explicitly selected supported API reviewer; ChatGPT
OAuth is never sent to the Decisions API. Manual and Skip need no reviewer.

### Skip permissions

Use `/mode` → **Skip permissions**, `/mode skip`, or `--approval-mode skip` and
confirm the warning in a live interactive terminal. This is a fresh session-only
opt-in, never a saved default or a consequence of signing in. It skips ordinary
prompts without human **or AI** review for eligible, host-prepared local changes,
public/paid web requests, trusted commands and already-connected MCP operations.

Hard denials, path/workspace and known-secret checks, validation, cancellation and
session/account/trust boundaries remain. Skill installation, MCP setup/connect/sign-in
and credential/trust administration still require human action. Account/workspace/trust
changes revoke enrollment. Unsandboxed commands still run as your OS user and can act
outside the workspace or read credential files; Skip neither grants OS privileges nor
adds a sandbox. Shift+Tab retains the existing Manual → Auto → Plan cycle and never
enables Skip automatically.

### User shell commands (`!`)

Start a submitted message with `!` to run the remaining text as a shell script,
then let the agent continue from its actual output and exit status. **Send approves
that exact unsandboxed command**; there is no second confirmation. Agent-proposed
`command_start` calls require fresh human approval in Manual and Auto; deliberately
enrolled Skip permissions skips that ordinary prompt.
The composer marks shell input before submission. A busy `!` waits until the
current turn and its cleanup finish; queued commands run in FIFO order. Interrupt
& send cancels the current turn first. Ordinary Escape/Ctrl-C stops the active
command/turn and retains unstarted queued input; `/queue clear` removes it.
Entering Plan or disabling commands revokes unstarted queued shell commands.

This requires a selected workspace, enabled command tools and an interactive
terminal in Execute mode. The script starts in that workspace and uses `/bin/sh -c`
on Linux/macOS or explicit profile-free Windows PowerShell on Windows, **not**
necessarily your login shell. Quoting, pipes, redirects and multiline scripts are
passed intact (up to 4 KiB); no whitespace splitting is performed. In line mode,
each submitted line is one script. Shell processes have closed stdin, so interactive
editors, password prompts and background sessions are unsupported. Each command
gets a fresh shell and the existing minimal command environment; `cd`/`export` do
not change later commands or the CLI's selected workspace.

Commands use the existing hard timeout (30 seconds by default, at most 5 minutes)
and 1 MiB total-output stop limit. Their agent context retains at most 24 KiB of
output, with explicit truncation and a further encoded-message bound. Output is
untrusted data and is saved locally and sent to the selected provider. Known
credentials are blocked in scripts and screened in output, but this is not a
sandbox or a guarantee that arbitrary output contains no secrets. A successful
shell exit does not verify file changes or remote effects.

Normal cancellation waits for process cleanup and saves the observed outcome.
Provider/checkpoint failures retain only inert outcome context, never an executable
retry. Resuming a saved session never runs `!` text. Abrupt termination or a crash
before the outcome checkpoint can lose that command's transcript observation;
it never causes automatic replay. Check external effects before manually retrying.

Changing chat provider, model or effort starts a new conversation and keeps the old
transcript available through `/resume`.

The host loads scoped `AGENTS.md` guidance fresh before each dispatch. Mention an
image path normally; the agent can inspect PNG/JPEG pixels with
`workspace_read_image`, subject to workspace policy and verified model support.
There is no `/attach` command or automatic image upload.

Sessions get a readable name from the first accepted message, without an extra
model call. Rename keeps that name through later turns and resumes. The resume
picker shows names and local dates such as Today or Yesterday, with the model
and session ID still available. Older unnamed sessions use a display-only
first-message fallback; browsing them does not rewrite saved files.

The full-screen status shows an animated Working indicator and total elapsed
turn time, including time spent waiting for approval. Waiting for approval and
Cancelling have separate labels. The timer stops when the turn settles or the UI
closes, including non-streaming requests and failed turns.
The full-screen terminal tab shows `vivi · session name`, with `[~]` at the
start while working and `[!]` when a dialog needs input. The title is bounded and
updates only when its state or session name changes. The prior title is restored
on exit where the terminal supports xterm title stacks. Line and JSON output do
not change the terminal title.

Enter sends; Ctrl+J adds a line. Shift+Enter or Alt+Enter also adds a line when the
terminal reports those modifiers. Tab completes slash commands. Shift+Tab cycles
Manual / Auto review / Plan while the composer is idle and preserves an unfinished
draft. Entering Auto still needs the fresh enrollment confirmation. Entering Plan
revokes Auto enrollment; leaving Plan returns to Manual. During a turn and inside
dialogs, the shortcut does not change mode. `/mode cycle` provides the same cycle
through the command interface. `/mode` opens Manual, Auto review, Skip permissions and Plan choices in full-screen mode;
`/mode plan` enters planning directly and `/mode manual` returns to reviewed execution.

Plan is a read-only task policy, separate from Manual/Auto approval. It advertises
and dispatches only enabled local reads: informational clarification, arithmetic, current time, session-note
reads, memory listing, skill listing/reading, credential-free local MCP status,
and bounded workspace reads/searches.
Existing feature opt-ins, model tool support, secret screening and read permissions
still apply. Workspace/note/memory mutations, every unsandboxed command, public URL
GETs, MCP setup changes and remote calls/resources, and imported extensions are unavailable, even if described
as read-only. The assistant describes its plan in a normal response and stays in
Plan until you explicitly change mode. Switching does not execute old proposals.
Choosing Auto from Plan leaves Plan only after successful fresh enrollment;
cancelling, denying or closing that confirmation keeps Plan active.
Plan does not mean zero filesystem writes: normal conversation checkpoints,
transcripts, local store locks/recovery and shutdown bookkeeping still run. Explicit
host controls such as session renaming and memory management keep their existing
review rules. Explicit new/resumed conversations start in Manual execution mode.
Model and reasoning-effort changes preserve Plan when it is selected, while
revoking any Auto review enrollment.
The assistant can ask 1–3 clarification questions in the native full-screen UI.
Choose an option, write an answer, skip, or cancel; review the answers and select
Submit to send them. Questions work in Manual, Auto review and Plan, and never
approve an action or enroll Auto review. Questions and action approvals share one
input queue. Line mode, pipes and headless hosts omit this capability.

Some terminals send the same input for Enter and Shift+Enter, so the application
cannot distinguish them from that byte alone. For a native Windows TTY, vivi
requests [Windows input-record reporting](https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md)
to preserve reported Enter modifiers. ConPTY has separate outer and application-facing
encoders; vivi requests the application encoder even after an "already enabled"
mode-1 reply, then resets it on close. The query cannot reveal that encoder's prior
state. This targets modern Windows Terminal's active outer transport. Mode-2,
unsupported or unanswered queries leave reporting off; use Ctrl+J for a newline
when Enter and Shift+Enter arrive identically. Legacy native-framed paste support
is outside this scope.
Physical Shift+Enter behavior on Windows Terminal 1.24 remains unverified after a
user-reported failure. Raw-framed bracketed paste retains Unicode and line breaks;
chat drafts normalize CRLF or CR to LF. Other terminals use the supported Kitty keyboard
protocol automatically, or Ctrl+J when modifiers are unavailable. Alt+Enter may be
intercepted by the terminal's own fullscreen shortcut.
The composer grows as explicit or wrapped lines are added, up to ten editable
rows where the terminal has room. Larger drafts scroll inside the composer.

If reported modifiers do not work, run `vivi --diagnose-input` by itself in the
same terminal. It opens the normal native input transport without loading
credentials, preferences, workspaces, sessions or providers. Press Enter,
Shift+Enter, then Ctrl+J once each; press Escape to restore the terminal and print
the report. It collects only those key names and modifier flags, runtime/TTY
facts and Windows negotiation state. Ordinary typing and paste are ignored.
Raw input logging/debug capture must be disabled. No report is saved or sent;
review it before sharing it voluntarily. This is a diagnostic, not evidence that
physical Shift+Enter has been fixed.

While working, Enter queues messages in order at the next safe boundary, after the
complete tool batch or a text-only response. Pending input has a count and previews;
accepted input joins the transcript. Sending messages cannot be edited or removed.
Ctrl+Enter (if reported) or **Interrupt & send** queues the draft and requests
cancellation, then waits for owned cleanup before continuing. Cancellation cannot
undo completed writes, requests or command effects. Physical modifier reporting
is unverified; the button does not depend on it.

Escape or Ctrl+C stops the turn but retains queued input. `/queue send` continues,
`/queue undo` edits the latest pending message in the full-screen composer, and
`/queue clear` removes pending input. Send or clear the queue before changing
conversations, provider, model or effort. Pending input is launch-local and discarded
on exit; accepted history is saved normally. Ctrl+C while idle exits.
Interactive line mode uses `/interrupt TEXT`; piped input remains sequential.

In `/models`, type to filter by ID, name or provider; words can be in any order.
Use arrows or Page Up/Down to browse, Enter to select, Ctrl+U to clear,
Ctrl+R to refresh the catalog, and Escape to go back.

### Mouse controls

The full-screen UI accepts terminal-reported mouse clicks. Click Menu, Models,
Effort, Mode, Memory or Skills below the composer to open an action when the draft
is empty. Click a picker row to choose its exact value; the wheel moves through
picker options or scrolls the transcript. Clicking a slash-command suggestion
fills the composer without sending it. Dialogs have Choose/Confirm, Back/Cancel
and, where available, Refresh buttons. Smaller terminals hide optional action
bars to preserve space; the same commands, Enter and Escape still work.

Approval prompts show separate Deny and Approve buttons. Deny starts selected.
Use arrows or Tab to select, then Enter to confirm, or click the desired button.
Typing or pasting `allow` cannot approve in the full-screen UI. Escape, abort and
close deny. A click must start and finish on the same displayed request and
button without dragging; rapid repeated approval clicks cannot accept the next
request. Line mode continues to require its fresh typed `allow` response.

Mouse reporting varies by terminal and multiplexer. [Windows Terminal supports
VT mouse input](https://learn.microsoft.com/en-us/windows/terminal/selection);
this implementation still needs interactive validation on your actual terminal.
In Windows Terminal, hold Shift to select text using the terminal instead of
sending mouse input to the application. Clipboard behavior and the OS pointer
are controlled by your terminal, not vivi. All actions remain keyboard-accessible.

Model capabilities use the shared endpoint-aware normalizer with the CLI's existing
documented OpenAI Responses facts. OpenRouter metadata describes its Chat Completions
gateway. Unknown models remain unverified; catalog visibility does not prove a request
will succeed. Provider default sends no reasoning override. The explicit disable choice
is offered only when supported, including optional OpenRouter token-budget models that
have no named effort choices. A documented non-streaming model uses complete responses;
unknown streaming keeps your selected stream setting.
OpenRouter selections in both full-screen and line mode are checked against the provider catalog before the
first session opens, so supported workspace tools are available on the first
turn. Explicit tools-off choices stay off; unavailable or unknown metadata stays
chat-only unless tool support was explicitly declared for this launch.

Keys can be saved in an available OS credential store or used for this launch only.
There is no plaintext key-storage fallback. Conversations are stored locally in
`~/.vivi/sessions`; keep secrets out of chat and command arguments.

## Line mode

Interactive TTY input can queue ordinary chat while a turn runs. `/interrupt TEXT`
requests cancellation and queues that follow-up; `/queue` controls retained input once
idle. Approval prompts keep their fresh typed allow/deny input separate. Piped input
keeps sequential line behavior and never becomes a steering or approval source.


Node.js 26.4+ supports line mode without Bun. Set `OPENAI_API_KEY` or
`OPENROUTER_API_KEY` or `DEEPSEEK_API_KEY` in your environment, then supply a model ID:

```sh
node dist/launcher.js --no-tui --provider openai --model YOUR_MODEL
node dist/launcher.js --provider openrouter --model PROVIDER/MODEL --prompt 'Hello'
```

Use `node dist/launcher.js --help` for all options, including `--resume UUID` and
`--session-dir PATH`.

## Optional MCP tools

Use `/mcp` to add an HTTPS server URL and name, then choose Connect or Sign in.
The same provider-independent controls are available as `vivi mcp add NAME URL`,
`list`, `connect`, `login`, `logout`, and `remove`. Add saves a disabled entry;
no model or API key is needed. New HTTP servers use automatic protocol
compatibility; exact `2026-07-28` and legacy overrides are in Advanced or
`--protocol`. Existing pins are preserved; choose Automatic in Advanced to
explicitly change an existing HTTP pin.

You can also ask the agent to add an MCP URL or start guided setup. `mcp_list`
reads fresh local entries, status and configuration revision without starting a
process, refreshing metadata, signing in or making a network request. It works
in Plan. `mcp_setup` proposes one add/connect/login/logout/remove action through
the same trusted service as `/mcp` and the CLI. Each exact proposal needs fresh
human approval, including in Auto; Plan cannot run setup actions. Add saves a
disabled HTTPS entry. Connection and account-access approvals remain with you.
The agent cannot supply credentials, arbitrary headers/settings or executable,
download and installation commands. Newly connected tools are available on the
next turn. Setup is offered only when interactive human review and durable local
outcome evidence are available.

Setup evidence records accepted proposals, durable intent and confirmed effects
separately from transcript checkpoints. Cancellation or a failed cleanup cannot
hide an already saved entry, issued grant, local sign-in change or established connection. Interrupted or uncertain
setup is never resumed or replayed automatically; inspect `/mcp` before retrying.

For local stdio servers, Advanced can add an already installed executable,
its separate arguments, working directory and explicit legacy or pinned modern
protocol. Entries start disabled every launch. Enable requires fresh human
approval showing that exact launch; Disable closes the owned process tree.
For Bun servers, use `--no-install` followed by an absolute installed JS/TS
script path and its separate arguments. Inline code and package commands are unsupported.
Windows Node servers should explicitly allow `SYSTEMROOT` (included in the minimal
profile/temp option); an empty environment can prevent Node 26.4 from starting.
Windows native stdio startup allows up to 45 seconds for cold helper readiness.
Other startup and protocol/category deadlines remain 10 seconds; each metadata
page remains bounded to 5 seconds. Cancellation requests stop immediately, with
the existing 5-second Windows cleanup bound. If native cleanup cannot be verified,
the connection remains an error and cannot restart until explicit cleanup succeeds.
The startup allowance does not resolve cold-cancellation cleanup uncertainty.
For account-independent line management, run
`node dist/launcher.js --no-tui --prompt /mcp`; no model or provider key is needed.

Starting a trusted server runs its code with your OS permissions before any
tool-call approval. It can access files and network; this is not a sandbox.
Connected, ready catalogs expose bounded tool aliases and schemas to the agent.
Remote tool calls and resource reads require human approval in Manual and Auto
review; explicitly enrolled Skip permissions skips ordinary prompts only for already-connected servers. Reads use exact discovered resource URIs. Admitted scalar RFC 6570 templates can
propose one expanded absolute URI with every variable supplied as a string; the
existing human approval shows the template, exact values and expanded URI.
Unsupported templates remain metadata only. Expansion performs no I/O, URI
normalization, completion or linked reads.
Unsupported schemas are quarantined; stale catalogs and changed connections block
calls. Results are bounded, untrusted data; uncertain outcomes disable the connection
without retry. Send intent and outcomes are persisted separately from transcript
checkpoints; interrupted sessions recover the known or uncertain result without
replaying the operation. Requests cancelled before sending stay marked as not sent.
HTTP entries use an exact trusted Streamable HTTP endpoint. HTTPS is required;
unencrypted HTTP is available only for explicitly allowed literal `127.0.0.1` or
`[::1]` endpoints. URL credentials, queries, fragments and arbitrary headers are
unavailable. Legacy seven-field stdio entries remain compatible. HTTP servers
receive protocol/catalog requests only after fresh endpoint approval. Redirects,
background GET streams, automatic sign-in, stream resumption and operation replay
are disabled. Modern `2026-07-28` uses POST JSON or request-scoped SSE without
transport sessions; legacy compatibility accepts an in-memory session ID and
uses the same POST endpoint without an old separate HTTP+SSE fallback. Explicit
metadata refresh remains available. Responses are byte-bounded before SDK parsing
and cancellation aborts the request and its response stream.

Embedders may provide a trusted session-only `httpAuthorization(server)` snapshot
with `{ revision, bearerToken? }`. Tokens stay outside saved server configuration,
approval bindings, transcripts and model context; the revision must change whenever
account, issuer, scope or token changes. A changed/expired snapshot revokes the old
connection, requires fresh approval, and never replays an operation.

HTTPS sign-in discovers protected-resource and authorization-server metadata,
selects advertised scopes, and prepares supported public client setup. One reviewed
setup approval covers the exact public registration metadata when DCR is needed,
browser sign-in, and connection to the same MCP endpoint. You still grant account
access yourself in the browser. Existing issuer-bound public clients are preferred;
a configured, validated hosted JSON client metadata document is used when supported,
then advertised DCR. There is no assumed hosted vivi client identity. Unsupported
issuers are guided to Advanced preregistration settings.

Approved public client settings and sign-in credentials can be saved in
OS-protected encrypted storage for the current profile. Restarting still needs a
fresh Connect approval; eligible credentials refresh once before connection,
without repeating browser or public-client setup. Disconnect and shutdown clear
RAM and retain saved sign-in. Sign out forgets saved tokens locally; removal or
identity changes forget the affected record. Unrelated server edits retain it.
HTTP 401/403 clears the denied saved credentials and never replays an operation
or signs in automatically. Locked/unavailable secure storage needs an explicit
session-only choice, also available with `vivi mcp login NAME --session-only`.
Local logout does not revoke issuer grants. Saving/editing configuration currently
disconnects all launch-owned MCP connections; the menu discloses affected servers.
Fixture validation does not establish live provider/callback acceptance. Review
provider permissions, expiry and spending limits before granting access; a cap is
not permission to spend. See [OAuth setup details](docs/MCP_OAUTH_SESSION.md) and
[saved sign-in details](docs/MCP_OAUTH_PERSISTENCE.md).
Credential environment values, repository auto-discovery, package installation
and automatic reconnects remain unsupported.
Windows requires Windows 10+/Server 2016+ and built-in Windows PowerShell
FullLanguage for owned Job Object cleanup.

## Public page retrieval

`fetch_url` retrieves bounded UTF-8 text, JSON or inert HTML text from one selected
public HTTPS URL through host review. It sends the full path/query and network
metadata; GET may have server-side effects. Every redirect is validated, and a
changed origin needs a fresh decision. Limits are 3 redirects, 15 seconds active
work, 16 KiB headers, 1 MiB wire body, 1 MiB decoded body and 64 KiB text/result.
Identity, gzip, Brotli and zlib-wrapped deflate responses are supported; coding
chains, raw deflate and invalid/truncated compressed data fail closed. No login, cookies,
JavaScript, search, downloads or private/local addresses are supported. Returned
text is untrusted; uncertain sends are recorded and never automatically replayed.
Failures include a fixed local stage and a validated HTTP status when available,
without returning native diagnostics or error bodies.

## Independent web providers

Direct is the keyless default and provides only `fetch_url`. It never executes
JavaScript and never falls back to a paid provider. `/web` independently selects
Direct, DeepSeek or Disabled; chat setup does not enable web access.

DeepSeek web adds `web_search` and routes `fetch_url` through its fixed paid API.
It uses a separate `deepseek-web` OS credential slot or launch-only key. Reusing a
DeepSeek chat key requires an explicit choice. In line mode use
`--web-provider deepseek` and `DEEPSEEK_WEB_API_KEY`; `/web direct|deepseek|disabled`
changes this launch’s selection. No key is accepted in command arguments or saved
in plaintext preferences.

The exact query/count/content choice or full URL/path/query goes to DeepSeek,
and bounded results enter the local transcript and selected chat provider’s
context. The CLI adds no original question or localization IP. The documented
estimate is US$0.00075 per successful nonempty request, not an enforceable billing
cap or receipt; DeepSeek controls pricing and actual charges. Each call has one
API dispatch and no automatic retry or fallback. Manual reviews every call;
freshly enrolled Auto can review exact current-request search/fetch proposals,
with visible human fallback on uncertainty. Changing web provider/key revokes
unattended enrollment. Explicit Skip permissions also skips ordinary web prompts. Plan continues to omit remote web requests.

Results are untrusted, provider-reported content with source URLs and explicit
local truncation. A successful API response does not verify original website
facts, HTTP status, final redirect URL or completeness. DeepSeek’s remote
JavaScript/redirect behavior is not independently verified. Local public-target
checks do not attest to DeepSeek’s remote DNS or redirects.

## Optional Auto review

Manual is always the default. OpenAI/OpenRouter chat keeps its same-provider
reviewer by default. DeepSeek and ChatGPT-plan chat start without a reviewer; `/reviewer` or Auto
setup explicitly selects an OpenAI/OpenRouter account for this conversation.
DeepSeek and ChatGPT OAuth are not decision backends; ChatGPT Auto requires a separately configured API reviewer credential. A reviewer/account change revokes enrollment,
and every new recipient needs fresh disclosure and confirmation. `/mode` opens the current conversation’s mode
choice. The full-screen picker defaults to Manual; choosing Auto review then
requires a separate fresh, deny-default human confirmation of the disclosure.
Line mode shows the same disclosure and requires fresh typed `allow` to enroll;
`deny`, Escape, cancellation or closing keep Manual. `--approval-mode auto`
requests this enrollment at launch, and does not bypass it. Piped, headless and
unavailable approval surfaces stay Manual, even with that flag. Use `/mode` again
to return to Manual. Approval mode is never stored in preferences or sessions,
restored by `/resume`, or carried into a new conversation, provider, model or account.
Replacing an API key revokes enrollment immediately, including if the subsequent
model picker is cancelled; start a new conversation before enrolling again.

When enrolled, only tool calls implementing the current user’s requested
session `note_set`, app-wide memory create/edit, selected-workspace text creation/precise edits, or exact public URL GET requests may be automatically approved.
The corresponding notes/memory/workspace and tool feature gates must already be enabled.
Delete, `/memories` manager mutations, excluded actions and hard denials remain
outside Auto review. A model recommendation never relaxes host policy or skips
the exact proposal’s final freshness and revision checks.

The review sends the exact current user request, tool arguments and prepared
before/after changed text, workspace-relative paths and full-file hashes, or full URL/destination/method/limits/redirect scope to the currently selected existing account: OpenAI
`gpt-6-luna`, or OpenRouter routed to TypeSafe `typesafe/jev-1.13`. It uses only
that account’s existing key, with no copied credential store, account discovery,
cross-provider fallback or live model selection. The fresh in-app confirmation
asks for consent to share this bounded request/proposal text with those named
recipients for decision review, including eligible agent proposals you did not
request, to assess whether you authorized the exact change. It may contain personal or sensitive information
about you or others. Known credentials are excluded; content recognized as
sensitive stays Manual and is not sent to the decision provider. This lexical
filter cannot reliably identify every private detail. Keep Manual if you do not
want potentially private text shared. A conversation or provider/account change
invalidates the versioned consent; this product setting is not global permission
to transmit credentials or unrelated content. The automatic-save policy remains
ordinary non-sensitive note/memory create/edit, scoped text creation/precise edits and exact public URL GET requests only; the sharing consent does not expand
which actions may execute automatically. This adds API charges. Review
is limited to two calls per turn, an eight-second deadline and 16 KiB for the
full decision request. Larger exact evidence stays Manual without truncation;
there is no hard prepaid USD cost guarantee. Returned review usage and any
reported cost are recorded separately from chat/session usage.

The versioned host heuristics require **every** check to meet the selected
reviewer's threshold: **99.5% for OpenAI** and **99.9% for OpenRouter** by default.
`/auto-threshold` opens the full-screen threshold picker (also in `/settings`);
in line mode it shows the current reviewer threshold and usage.
`/auto-threshold 95` saves a 95% override for the selected reviewer;
`/auto-threshold default` removes that reviewer's override and restores its
conservative default without changing the other reviewer. The picker offers
Default, 90%, 95%, 99%, and Custom. Custom values are **90–100% inclusive, in
0.1 percentage-point steps** (for example `99.5`); a 100% cutoff requires an
estimate of exactly 1 for every check. These nonsecret settings persist across
launches and apply in both the full-screen and line interfaces, but never
restore Auto enrollment. Changes require an idle interactive conversation,
revoke existing Auto enrollment, and require fresh `/mode` consent.

Lower thresholds allow more uncertain proposals. The 90% minimum is a product
input bound, **not a validated safety floor**. These thresholds are uncalibrated
and do not establish comparable behavior between providers. Model estimates
can be wrong and do not prove authorization. Any check at or below `0.05`
still recommends rejection; changing the allow threshold never changes this
fixed rejection cutoff, host blocks, sensitive-data handling, or human-only actions.
Review summaries show the lowest requirement estimate, the threshold actually
used, and the coded outcome, with each requirement's estimate available in the
details. These are estimates for individual requirements, **not an overall
probability of approval or safety**. Local reads do not receive fabricated
reviewer scores. Human-only and blocked actions retain their existing routing;
missing or invalid reviewer scores are never shown as 0%. Audit metadata retains
the effective threshold used for a decision.
A model rejection may still be reviewed by a human when host policy allows it.
Uncertain, malformed, failed, stale or over-budget reviews use the ordinary
human approval path; cancelled reviews cannot commit. The UI reports review
progress and settled outcomes without exposing model reasoning or credentials.

## Workspace tools

The CLI uses the current working directory where you launch vivi as its selected
workspace. Use `--workspace PATH` to choose another folder, or `--no-workspace` to
disable workspace access for that launch. These flags cannot be combined. Relative
paths are resolved from the launch directory, not the installed CLI or private
profile folder. The active canonical folder is shown at startup in both interfaces.
The full-screen status keeps it visible through conversation changes; long paths
are shortened there. Use `/session` in the full-screen UI to see the full folder.
Its root is never saved as a preference or restored from a session; a resumed
conversation uses the current launch’s folder. The model cannot select or switch
folders. For an unverified model, also declare its tool support with `--tools`;
`--no-tools` always omits these tools.

```sh
bun dist/launcher.js --workspace ./my-project
node dist/launcher.js --no-tui --model YOUR_MODEL --tools --workspace ./my-project
bun dist/launcher.js --no-workspace
```

The assistant can list files, match file paths with `workspace_glob`, read UTF-8 text, and search literal text. Reads may be
sent to your selected provider and saved in the local conversation transcript.
Choose a folder whose contents you are comfortable sharing. File names and contents
are treated as untrusted data. Text creation and precise edits require host review.
Commands need separate trust as described below. Workspace file tools do not grant
deletion, renaming, network tools, plugin discovery or permanent folder trust.

The default applies to CLI launches only. Library users of `CliHost` must still
explicitly open and pass a `ReadOnlyWorkspace`; importing or constructing a host
does not grant access to the application’s working directory.

Root and nested `.gitignore` files apply to all workspace tools, including direct reads.
Symlinks, multi-link files, repository internals, common credential locations,
`.env`/`.env.*`, key files, `node_modules`, and `.cache` are unavailable. Ignore rules
cannot override these exclusions. The active CLI state folder is also excluded,
including a custom `--session-dir` inside the project. Ordinary config such as `package.json` and
`tsconfig.json` remains readable. This policy cannot identify every secret: move
sensitive files outside the selected folder or exclude them with `.gitignore`.

`workspace_create_text` proposes one new UTF-8 file; it never overwrites an existing
entry or creates parent folders. `workspace_edit_text` replaces one unique literal
`before` target with `after`. First read the file and use its returned `revision`
(the SHA-256 of all raw bytes) as `expectedRevision`; stale or ambiguous edits fail.
BOM, line endings and every byte outside the replacement are preserved. Files are
bounded at 256 KiB and the complete JSON-quoted unified review diff at 48 KiB.
Larger diffs are refused; exact Auto requests above 16 KiB stay Manual without
truncation. Manual shows the diff and asks each time; piped/headless writes are denied.

Publication uses an exclusive temporary sibling `.vivi-stage-*.tmp`, then exclusive
hard-link creation or replacement rename. Staging is cleaned up; no persistent
backup is retained. Creation fails closed if the filesystem cannot create hard links.
An uncertain outcome requires reading the file before retrying. These are ordinary
workspace checks, not hostile-filesystem containment or compare-and-swap guarantees;
portable Windows directory crash durability is not claimed.

`workspace_glob` matches file names without reading contents. Its pattern is relative
to its optional `path`, with forward slashes and case-sensitive matching on every OS.
Use `*`, `?`, or standalone `**`, such as `**/*test*.ts`; escapes, double quotes,
negation, brackets, braces, extglobs and regex are unavailable. Dotfiles follow the same exclusions.
It defaults to depth 8 and 50 results; returned paths stay workspace-relative.

Output is bounded: listings and globs have at most 100 entries; literal searches at most 50
matches; reads return up to 8 KiB from text files no larger than 256 KiB. Traversal
is at most 8 levels per call and stops after 1,000 entries, 200 search/glob files, 2 MiB
of searched text, or 10 seconds. `truncated: true` means the result is incomplete,
including deeper directories not visited. Escape/Ctrl+C cancels a running turn.

Paths are workspace-relative, with forward slashes. Parent traversal, drive/UNC
paths, ambiguous Windows components, and link aliases are refused. The host checks
canonical paths and file identities and withholds results when it detects concurrent
changes. This is not an OS sandbox against hostile programs changing the tree;
use a project folder you control. Exact policy and verification limits are in
[RELEASING.md](RELEASING.md#read-only-workspace-policy).

## Project instructions

The host loads scoped `AGENTS.md` guidance from the selected workspace, never its
parents. User instructions, permissions and required reviews still take precedence.
Use `/instructions` for status, `reload` to refresh or `disable` for this launch.
See [project instructions and image input](docs/PROJECT_INPUTS.md) for details.

## Reviewed commands

Command proposals are available from startup with a selected workspace, supported
tools and an interactive approval surface. The first exact `command_start` approval
includes the unsandboxed-execution disclosure; there is no separate enablement
approval. Every new process needs fresh human approval in Manual and Auto.
Explicitly enrolled Skip permissions skips that ordinary prompt, not command validation.
`/commands off` or `--disable-commands` disables proposals; `/commands on` restores
them for this launch/session. Execution permission is never saved or restored
from history. Piped/headless input cannot approve a process.

The approval shows the resolved executable, exact argv array, resolved working
directory, environment variable names, and hard timeout. Execution uses
`shell:false`; to use shell syntax, explicitly request a shell executable and its
arguments. Ordinary commands stay foreground/turn-scoped: `command_poll` reads
bounded output and `command_stop` halts the process tree; turn completion or
cancellation stops them. Output is untrusted and may be sent to your provider and
saved in history.

For noninteractive dev servers/watchers, explicitly request `command_start` with
`background:true`. Approval identifies this longer lifetime. The CLI owns these
jobs independently of model history: they survive completed/cancelled turns and
context compaction, and the agent receives a fresh current-job snapshot. Use
`command_list`, `command_logs`, `command_stop` and `command_restart`, or
`/processes`, `/processes logs ID`, `/processes stop ID`, `/processes restart ID`
and `/processes stop-all`. Restart verifies old-tree cleanup first and requires
fresh command admission under the current mode; it never automatically retries or revives a job.
The compact process bar has independent Next, Stop and Stop All controls; F6
stops its selected job and F7 stops all jobs, even during inference or a dialog.
Line mode supports the same commands and F6/F7 (F6 targets the latest active job).
These cleanup controls do not cancel inference or consume the composer draft.

Background log tails are byte-capped and mark older output as truncated; noisy
servers are not killed just for producing lifetime output. No interactive stdin
or PTY is provided. `!` remains an explicitly approved one-shot foreground shell
command. Leaving the owning session, changing command trust/account, or normal
CLI shutdown stops background jobs. Unconfirmed cleanup remains visible and
blocks restart; inspect it instead of starting a replacement. IDs are opaque and
valid only in this CLI launch/session, never raw PIDs or saved execution authority.
There is no cross-launch persistence or automatic restart. Abrupt host termination
such as SIGKILL, escaped POSIX descendants and external services are outside the
normal cleanup guarantee.

This is **unsandboxed**: commands have your OS account’s file and network access,
including outside cwd. The fixed minimal environment excludes saved provider keys,
but it does not prevent reading credential files. Only approve commands you trust.
Cleanup covers inherited POSIX process groups and Windows Job Object descendants;
commands deliberately escaping those boundaries or using external services remain
outside that guarantee. Windows needs Windows 10+/Server 2016+ and built-in
PowerShell FullLanguage; unsupported or locked-down native setup fails before execution.
Windows argv uses standard C-runtime/managed parsing. `cmd.exe`, `command.com`,
and `.bat`/`.cmd` files are unsupported; explicit PowerShell is supported.
Windows PowerShell 5.1 may take tens of seconds preparing built-in modules on first
use and emit progress on stderr. That output is preserved; request an explicit
`timeoutMs` when needed (30 seconds by default, maximum 5 minutes).

## Session notes

Session-only notes are enabled by default for tool-capable models. Every note
write still requires review; `--disable-notes`, saved notes-off defaults or
`--no-tools` suppress them. Notes do not enable tools for unverified models and
do not opt you into app-wide persistent-memory sharing.

## Persistent memory

Memory is off by default. Use `--enable-memory` for a launch, or choose the future
launch default in `/memories` → Future launch default in the full-screen UI.
`--disable-memory` overrides an enabled saved default. `/memories` enables or disables the current launch and
lets you list, add, edit and delete records. Back, Escape and Cancel never submit
a change. Manager create, edit and delete actions show the exact proposal and
require a fresh interactive approval: select Approve in the full-screen UI, or
type `allow` in line mode. Model-requested create/edit calls use the same human
path unless eligible under explicitly enrolled Auto review. Piped input cannot
approve writes or enroll Auto review.

Memories are stored as plaintext in `memories.json` alongside the CLI’s private
session files, normally `~/.vivi/sessions`. When enabled, saved context is sent to
the selected OpenAI or OpenRouter provider. Keep secrets out of memory. Disabling
memory retains existing records and stops reading or using them. Memory stays
enabled or disabled across provider/model changes, `/new` and `/resume` during
the launch. Changing its future-launch default affects future launches only.

The store is shared by CLI sessions using that state directory. A custom
`--session-dir` (or `VIVI_SESSION_DIR`) isolates its memory; desktop memory is
separate. Existing session notes remain session-only. Saved context works with
chat-only models too, but model-requested memory writes are available only when
tools are supported or explicitly declared with `--tools`. Unknown line-mode
models omit tools unless declared; `--no-tools` always omits them. Human
`/memories` actions still use the reviewed mutation path.

In line mode, first use `/memories on` or launch with `--enable-memory`, then:

```text
/memories list
/memories add I prefer concise replies
/memories edit ID REVISION Updated content
/memories delete ID REVISION
/memories off
```

Use the ID and revision shown by `list` for edits and deletions. A concurrent edit
requires refreshing and reviewing again; it is never silently overwritten.

## Development

```sh
npm run check
npm run test:tui
```

See [RELEASING.md](RELEASING.md) for packaging and release checks.
Licensed under [Apache-2.0](LICENSE).

Each CLI turn owns its shared extension registrations and cancellation listeners.
Closing a turn seals dispatch and awaits admitted checkpoints and resource drains;
MCP connections stay launch-owned. Trusted imports grant no extra permissions.

## Usage counts

The top-right `Context ~63k/128k` measures the effective provider request, including
fresh guidance, enabled memory/skills, tools and provider-native state. `~` marks an
estimate; `?` means capacity is unknown. `/context` shows the output reserve and
trusted model-limit source/freshness. Near a known limit, the shared core summarizes
older complete tool groups; `/compact` requests this explicitly. Cancellation or a
failed summary retains the prior view. Source-bound checkpoints survive resume;
full raw history, approvals and exact tool evidence remain authoritative and retained.
The 2 MiB/2000-message transcript and 384 KiB active record limits still apply;
compaction does not bypass local storage caps.

`/session` shows cumulative accepted response-round usage, with reported summary
request usage listed separately. Cache read/write counts are input-token subsets already
included in input and total counts. A missing cache count is shown as `unreported`,
while an explicitly reported zero is shown as `0`. Each session cache count is
complete only if every accepted provider round reported that field. Old sessions
keep missing metrics unreported; no cache policy, price or savings is inferred.

## Instruction-only Agent Skills

`/skills` lists and inspects standard SKILL.md documents, prepares creator requests
in the composer, and enables or disables skills for this launch. Existing
`<session-dir>/agent-skills/<name>/SKILL.md` folders and up to eight explicit
`--skills-dir PATH` roots remain read-only. No workspace, home, ancestor, or community
discovery is performed. `--no-skills` disables skills. Metadata goes to the selected
provider; instructions and imported UTF-8 text resources load progressively through
`list_skills` and `read_skill`, without running scripts.

The bundled read-only `skill-creator` can draft an instruction-only skill, then propose
`save_skill`. Interactive Execute mode shows the exact before/after SKILL.md source,
canonical name and SHA-256 revisions for a deny-default human review. Auto and Skip permissions still
require that same human review; the automatic reviewer cannot approve skill saves.
Plan, noninteractive launches and models without tools cannot save. A successful save
becomes discoverable on the next turn; the current turn keeps its fixed catalog.

Reviewed creation and replacement store exact standard SKILL.md source in
`<session-dir>/installed-skills/skills.sqlite`, using Node/Bun's built-in SQLite driver.
The database holds instruction text, canonical names, exact-source revisions and immutable
commit receipts. No scripts, resources or binary assets are installed. Legacy folders,
explicit imports and the bundled creator are never migrated or overwritten. Name collisions
are excluded with diagnostics instead of silently shadowing a source. Incomplete import-name
discovery withholds installed skills and blocks new saves until refreshed.

Approval holds no database lock. A short transaction rechecks the stored revision after
review, then atomically commits source and receipt. A stale proposal must be reviewed again.
Native commit errors are reconciled against the durable receipt through a fresh connection;
an unresolved outcome is explicitly unknown with a receipt correlation and must not be
retried blindly. SQLite storage is capped at 8 MiB. The store requires a stable private
app-owned local profile; it does not claim isolation from hostile filesystem replacement.
Existing workspace tools cannot target that private state profile. Skill hints grant no
tools, permissions or automatic approval eligibility.

Discovery uses canonical filesystem identity for ordinary Windows path aliases, preserves
original files, and reports unavailable roots, invalid formats and duplicate names.
Bounds are 100 skills including the creator, 64 KiB per UTF-8 document/resource, 2 MiB total
documents, and 24 KiB catalog metadata; serialized tool reads must also fit the session
transcript limit. Exact human approval displays are bounded too; oversized proposals are
denied rather than truncated. Existing credential/private-state exclusions remain. Prior
restricted filesystem assessments stay excluded and unrun; new tests cover only the new
installed-store functionality and ordinary SQLite transactions.

### Tool completion and effects

Tool cards keep completion separate from effects. Reserved local reads have an observed local outcome. A workspace, note, memory or installed-skill write is confirmed only after its owned commit receipt; a later cancellation or durability warning cannot turn a published write into a failed save. A denied or cancelled request before its effect boundary is shown as not attempted. A failure after commit admission remains uncertain unless publication was observed.

Command cards report the observed process lifecycle. A running process is not a completed command; a zero exit code confirms process completion, while arbitrary file and network effects remain unknown. MCP success confirms the protocol response, not an intended third-party change. Local MCP configuration changes can have confirmed host receipts; incomplete setup retains known effects in the details and leaves the overall effects uncertain. Public URL cards distinguish retrieval status, HTTP transmission, and possible DNS/TLS metadata disclosure. Failure before any network operation differs from a request that may have reached a server.

Imported extension results confirm only that their executor returned or failed. Claims inside result JSON cannot establish effects, approval or permission. Historical result bodies alone never acquire new receipts. Exact current-run call, occurrence, arguments and canonical result binding is required for live and saved outcomes; cold replay restores saved evidence without executing tools. If evidence persistence fails, replay keeps the uncertainty visible. Skill saving receives a local-mutation policy only when its separate human-reviewed capability is enabled; outcome reporting grants no save authority.

The registration coverage test inventories every enabled owned pack, conditional MCP resource tools, dynamic MCP aliases, Plan mode and disabled tools. Adding an owned tool without an explicit outcome policy fails registration instead of silently inheriting a generic success label.

DeepSeek chat uses the native adapter, live catalog context/effort metadata, native
reasoning history and reported usage. Unknown limits remain unknown. Unsupported
imported or inconsistent reasoning/tool history fails before HTTP with `/new`
guidance; it is never silently rewritten or retried. Context compaction uses only
core-validated provider views and retains the original local transcript.
