# vivi CLI

A small terminal application using the shared `@ayayaq/vivi` agent loop, canonical
history helpers and OpenAI/OpenRouter provider factories. This repository contains
application policy, bounded tools, persistence and UI only. It does not copy the agent
loop or provider protocols.

## Install the development checkout

Use Node.js 22 or newer:

```sh
npm ci --ignore-scripts
npm run check
node dist/main.js --help
```

The private `@ayayaq/vivi-cli@0.1.0-dev.0` development package pins the compatible
shared npm release `@ayayaq/vivi@0.2.0`. Its registry artifact was verified against the
reviewed release bytes; the immutable registry URL and SHA-512 integrity are recorded
in the lockfile. Shared vivi `0.1.0` does not contain the required provider/history
APIs. See [RELEASING.md](RELEASING.md) for validation and future-release requirements.
No API key is needed for checks.

`npm pack` includes the installed shared dependency as a bundled dependency, so the
CLI archive can be installed offline with `npm install ./ayayaq-vivi-cli-0.1.0-dev.0.tgz`.
The source checkout requires the exact registry artifact recorded in the lockfile;
`npm run test:package` rejects a local archive dependency or a stale installed core.

In the commands below, replace `vivi` with `node dist/main.js` when running from the checkout.

## Start a conversation

Set `OPENAI_API_KEY` or `OPENROUTER_API_KEY` in your own environment. Do not put credentials in
arguments, prompts or session files. Then choose a provider and an explicit model:

```sh
vivi --provider openai --model YOUR_MODEL --new
vivi --provider openrouter --model PROVIDER/MODEL --new
vivi --provider openai --model YOUR_MODEL --prompt 'What is 14 multiplied by 9?'
```

Streaming is enabled by default. `--no-stream` requests a completed response without partial
display. A terminal uses the interactive display; piped input/output uses line mode. `--tui`
explicitly selects terminal interaction. The CLI shows accepted assistant text, tool activity,
usage and the session ID. Ctrl-C or Escape cancels a running turn or approval; Ctrl-C while
idle exits. Allow/deny prompts authorize only the shown mutation. Denial is the default.

Reasoning defaults to provider behavior. Request a nondefault setting only with model capabilities
you have checked, for example:

```sh
vivi --provider openai --model YOUR_MODEL --reasoning high --reasoning-capabilities low,medium,high
vivi --provider openrouter --model PROVIDER/MODEL --reasoning disabled --reasoning-capabilities none
```

Capabilities are explicit host declarations, not downloaded metadata. Unsupported choices fail
before a generation request. `default` does not mean reasoning disabled. No arbitrary endpoint,
credential flag, automatic retry or key-storage mechanism is provided.

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
