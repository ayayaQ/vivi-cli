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

The development package pins `@ayayaq/vivi@0.2.0`, `@opentui/core@0.5.14` and
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

Set `OPENAI_API_KEY` or `OPENROUTER_API_KEY` in your own environment, then launch
`vivi` without arguments. The welcome screen lets you start or resume a conversation.
First-time setup selects provider, exact model identifier, reasoning capabilities and
tool support. Nonsecret defaults are saved atomically as private settings alongside
sessions. Credentials are never requested in the UI or saved in settings.

Model IDs are entered manually; there is no downloaded or guessed model catalog.
Reasoning defaults to the provider's behavior. Only explicitly declared, verified
reasoning efforts appear as choices. Default does not mean reasoning disabled.
Tool support defaults to chat only; declare checked support to enable the bounded
calculator/time tools, then optionally enable approval-gated session notes.
Declarations belong to a provider/model pair and are cleared when that pair changes.

The full-screen interface includes a multiline composer, scrollable Markdown chat,
streaming preview, tool activity, usage and session status. Enter sends;
Shift+Enter or Alt+Enter adds a line, depending on terminal keyboard support.
PageUp/PageDown scroll while keeping the composer intact. `/menu` opens actions;
Ctrl+P opens the same menu, Ctrl+N starts a new conversation, and Ctrl+R selects a
session when the composer is empty. `/help` shows shortcuts.

- `/new` starts with the saved defaults
- `/settings` changes provider/model/reasoning/tool defaults for future sessions
- `/resume` selects an unlocked, validated local session
- `/session` displays the current UUID; `/exit` quits

An existing session retains its provider/model/reasoning. Changing defaults does not
rewrite that session. The picker reads metadata only, scanning at most 1,000 directory
entries and showing up to 100 valid sessions, newest first within that bounded scan.
Locked sessions are excluded. A resumed nondefault effort without matching saved
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

No arbitrary endpoint, credential flag, automatic provider retry, key storage,
unrestricted filesystem tool or shell tool is provided.

## Development checks and local standalone builds

```sh
npm run check                  # Node baseline, application/settings and packed consumer
npm run test:tui               # Bun native in-memory rendering and mock input
VIVI_TEST_BUN=bun npm run test:package  # Packed native UI consumer too
npm run test:standalone        # Compiled in-memory UI/assets consumer
npm run build:standalone       # Current-platform local executable in build/
./build/vivi --help
```

Checks use fake providers and temporary directories, without API keys or live model
calls. The package check explicitly prepares a fresh registry dependency cache, verifies
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
usage and opt-in notes, so treat them as private conversation data. Known environment credentials
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
