# vivi CLI

A standalone conversational terminal application using the shared `@ayayaq/vivi` agent loop, canonical
history helpers and OpenAI/OpenRouter provider factories. This repository contains
application policy, bounded tools, persistence and UI only. It does not copy the agent
loop or provider protocols.

## Install and launch

The full-screen interface uses [OpenTUI](https://github.com/anomalyco/opentui) with
[Bun](https://bun.sh) 1.3.0 or newer. Node.js 22 or newer remains supported for
plain line mode and piped input/output. Install dependencies and build:

```sh
npm ci --ignore-scripts
npm run build
bun dist/launcher.js
```

The development package pins `@ayayaq/vivi@0.2.1`, `@opentui/core@0.5.14` and
`web-tree-sitter@0.25.10`. npm on Node 22/24 can warn about OpenTUI's newer Node
engine requirement; this application loads the native UI only under Bun. It does
not use Node's experimental FFI. Native dependencies must not be omitted for TUI use.

After installing a local `npm pack` archive, run `vivi`. Its Node launcher starts
Bun from PATH for full-screen TTY use and explains how to install it if missing.
It never silently substitutes a different UI. Piped input/output, `--no-tui`,
`--help`, and ordinary one-shot `--prompt` calls use the Node-compatible line route.
From the checkout, use `bun dist/launcher.js` for TUI or `node dist/launcher.js`
for line mode. OpenTUI is evolving; screen-reader users should use `--no-tui`.

The package bundles the reviewed shared vivi dependency, including its licenses.
OpenTUI and its platform-specific native dependencies install from the npm registry.
An offline install of the CLI archive requires those dependencies already in npm's
cache; the archive alone is not an all-platform offline distribution. No binaries,
archives or copied provider implementations are committed to this repository.

## Interactive conversations

Launch `vivi` without arguments to enter a fresh conversation immediately. The interface uses
pink `#f87ea2` and lavender `#b08bfc` accents inspired by kikirara vivi. There is no welcome
menu and no automatic resume; `/resume` explicitly selects an older conversation.
Nonsecret defaults and provider setup carry over to the next launch.

Use `/provider` to choose OpenAI or OpenRouter and enter a key in a masked modal.
An environment key takes precedence over a saved key. Secure persistence is offered only
when the platform's credential service is available; otherwise choose “this launch only”.
There is no plaintext fallback, and a failed save needs an explicit session-only choice.
Keys never enter the composer, transcript, settings, command arguments or helper diagnostics.
OpenTUI raw-stdin logging/debug capture must be disabled before masked key entry is allowed.

Native storage uses Windows Credential Manager (the current user's local-machine vault),
macOS Keychain or Linux Secret Service via `secret-tool`. Windows uses the installed system
PowerShell helper without a profile or execution-policy changes; no extra credential package
is required. A disabled/constrained helper, locked vault or missing Secret Service is reported
explicitly. Save success requires an exact in-memory read-back. Native vault integration is
fake-tested here; no real Windows/macOS/Linux vault calls have been validated on this Linux host.
Windows credential blobs are limited to 2,560 UTF-8 bytes; macOS helper framing has a smaller
limit than the 4,096-character input bound. Oversized native writes fail before helper execution.

`/models` loads provider model IDs into a picker. Search accepts partial names, and Refresh
reloads the catalog. OpenAI uses the authenticated Models API; OpenRouter uses its authenticated
account-filtered model catalog when a key is available. A global unauthenticated catalog does
not establish account eligibility. Model discovery is bounded, cancellable and cached in memory
for up to 15 minutes. Offline/stale results are labelled; authentication denial never reuses
cached results. With no catalog, an existing saved model can be retained explicitly with unknown
capabilities. The routine setup flow never asks you to type an exact model identifier.

`/effort` offers provider default and only this model's verified supported efforts.
OpenRouter reasoning metadata drives the options dynamically, including mandatory reasoning
which hides disabled/none. OpenAI's Models API does not publish capability metadata, so exact
Responses-model IDs use a small official-documentation registry. Known embedding, audio-only,
image-only and other incompatible endpoint models are excluded. Unknown IDs are visibly
unverified and require a separate compatibility choice, with tools disabled and default reasoning. Provider default always means omitting an effort override.
Calculator/time tools are enabled automatically only for verified model capabilities; session
notes remain opt-in and each write requires approval. Known nonstreaming OpenAI models use
accepted complete messages instead of streaming. Capability claims are scoped to provider/model. OpenRouter requests that use tools or an
explicit reasoning override require routes supporting all supplied parameters, through the
published `@ayayaq/vivi@0.2.1` provider contract. If no suitable route is available, the gateway
returns an error instead of silently ignoring those capabilities. Chat-only requests omit tool
fields, and default reasoning remains an omitted override.

Metadata contracts: [OpenAI Models API](https://developers.openai.com/api/reference/resources/models/methods/list),
[OpenAI model documentation](https://developers.openai.com/api/docs/models),
[OpenRouter model reasoning metadata](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#discovering-per-model-reasoning-options).

The full-screen interface includes a multiline composer, scrollable Markdown chat,
streaming preview, tool activity, usage and session status. Enter sends;
Shift+Enter or Alt+Enter adds a line, depending on terminal keyboard support.
PageUp/PageDown scroll while keeping the composer intact. Slash-command suggestions appear
above the composer; Up/Down selects a suggestion and Tab accepts it without sending.
Ordinary input and command arguments do not trigger completion.
`/menu` or Ctrl+P opens actions, Ctrl+N starts fresh, and Ctrl+R selects a session
when the composer is empty. `/help` shows shortcuts.

- `/provider` configures the provider and key, then opens the model picker
- `/models` selects a model; `/effort` selects its supported reasoning effort
- Provider/model/effort changes start a fresh conversation and preserve the old transcript
- `/new` starts with saved defaults; `/settings` changes defaults for future conversations
- `/resume` selects an unlocked validated session; `/session` displays the current UUID; `/exit` quits

An existing session retains its provider/model/reasoning. Changing defaults does not
rewrite that session. The picker reads metadata only, scanning at most 1,000 directory
entries and showing up to 100 valid sessions, newest first within that bounded scan.
Locked sessions are excluded. A resumed nondefault effort without matching saved or documented
capabilities requires a fresh explicit declaration before provider construction.

Escape or Ctrl+C cancels a running turn or approval; Ctrl+C while idle exits.
Approval shows the exact session-note mutation and revision, starts with empty input,
and requires typing `allow` or `deny`. Enter alone denies; pasted approval text is
ignored. Closing the UI cancels active work and restores the terminal.
Streaming text is a preview only; accepted history always comes from the shared core.
Display is bounded independently from persisted history and older display entries
may be omitted without deleting conversation data.

## Line mode and scripts

Use an explicit model in Node-compatible line mode:

```sh
vivi --no-tui --provider openai --model YOUR_MODEL --new
vivi --provider openrouter --model PROVIDER/MODEL --prompt 'What is 14 multiplied by 9?'
printf 'Hello\n/exit\n' | vivi --provider openai --model YOUR_MODEL
```

Streaming is enabled by default; `--no-stream` displays only accepted complete
messages. `--tui` selects the full-screen route on an interactive terminal.
`--tools` declares checked model tool support; `--no-tools` uses chat only.
Line mode retains the original default calculator/time tools for compatibility.
No API keys belong in arguments, prompts or session files.

Nondefault reasoning requires checked capabilities, for example:

```sh
vivi --provider openai --model YOUR_MODEL --reasoning high --reasoning-capabilities low,medium,high
vivi --provider openrouter --model PROVIDER/MODEL --reasoning disabled --reasoning-capabilities none
```

No arbitrary endpoint, credential flag, automatic provider retry, plaintext key storage,
unrestricted filesystem tool or shell tool is provided. Line mode continues to accept environment keys.

## Development checks and local standalone builds

```sh
npm run check                  # Node baseline, application/settings and packed consumer
npm run test:tui               # Bun native in-memory rendering and mock input
VIVI_TEST_BUN=bun npm run test:package  # Packed native UI consumer too
npm run test:standalone        # Compiled in-memory UI/assets consumer
npm run build:standalone       # Current-platform local executable in build/
./build/vivi --help
```

Checks use fake providers, fake keys, mocked OS credential helpers and temporary directories,
without real API keys, native vault mutations or live model calls. The package check explicitly prepares a fresh registry dependency cache, verifies
OpenTUI/parser resolution and integrity against the lockfile, then reinstalls the isolated
consumer offline from that prepared cache. Registry access is required for preparation. Native UI tests use OpenTUI's official headless test renderer, not terminal UI
automation. CI retains Node 22/24 checks and adds a standard Ubuntu Bun job.
Strict application typechecking remains enabled; dependency declaration checks are
skipped because OpenTUI 0.5.14's KeyHandler declaration conflicts with Node typings.

The executable embeds the Bun runtime and OpenTUI assets. Local native rendering,
packed startup and executable checks are verified on Linux x64 only; this repository
makes no tested Windows/macOS or production cross-platform claim. Build output is
ignored and never uploaded by CI. Bun includes libraries with separate licensing and
relinking requirements: review [Bun's licensing information](https://github.com/oven-sh/bun/blob/main/LICENSE.md)
and the exact runtime/native notices before distributing executables. The local build
writes dependency notices beside the binary, but is not a release pipeline.
See [RELEASING.md](RELEASING.md) for separate publication requirements.

## Sessions and recovery

Use the displayed UUID with `--resume UUID`. Provider/model/reasoning remain those of the saved
session; use a new session to change them. For nondefault reasoning, repeat the checked
`--reasoning-capabilities` declaration when resuming. `--session-dir DIRECTORY` chooses the CLI's own
storage location. Session files contain canonical history, optional native continuation state,
usage and opt-in notes, so treat them as private conversation data. Known environment and configured credentials
are rejected in outgoing prompts and redacted from persisted/displayed data; this is defense in
depth, not a general secret scanner. Do not type secrets into conversations.

Session writes are bounded and atomic with private file modes. Symlinks, malformed files,
unmatched/reordered tool results and oversized input are rejected. A checkpoint containing an
unfinished tool group is closed with unknown-outcome errors when resumed. Historical tools and
approvals are never executed during recovery. Partial streaming text is never saved as an
assistant response. After cancellation the host reconciles the complete transcript returned by
the shared core, including its synthetic cancellation results.

An exclusive session lease prevents two CLI processes overwriting the same session. A crashed
process can leave a `.json.lock` file. Verify that the old process has stopped before removing
that session's lock file and resuming; the CLI never removes an uncertain live lock automatically.
Sessions are capped at 2 MiB and 2,000 messages, with bounded per-message/native JSON complexity.

There is no automatic transcript truncation or compaction. At the storage/history limit, start a
new session; silent truncation could break tool pairing or native continuation.
Both limits include the mandatory synthetic results needed to close any pending tool calls
after a crash. A checkpoint without enough recovery room is rejected before tools execute.

## Bounded tools and approvals

Calculator accepts only the advertised bounded arithmetic operations and numeric operands;
it does not evaluate code. Time returns the current time without contacting a service.

`--enable-notes` adds CLI-session notes. Reads expose revisioned snapshots. A write requires an
explicit allow decision and the expected current revision, with cancellation checked again after
approval. Notes remain within that session; there is no arbitrary path or unrestricted file tool.
A cancelled write that was already atomically committed cannot be rolled back. Read current
state before retrying if an interrupted tool's outcome is unknown.

Hosts using vivi in other domains can supply their own validated tools, persistence, policy and
interface. The CLI and desktop consume the same provider factories and headless loop.
