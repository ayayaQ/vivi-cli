# vivi CLI

Chat with OpenAI or OpenRouter from your terminal.

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

Each launch starts a fresh conversation. Use `/provider` to set up your API key,
then choose a model.

- `/provider` — choose OpenAI or OpenRouter and enter a key
- `/models` — search and select a model
- `/effort` — choose a supported reasoning effort
- `/new` — start a fresh conversation
- `/resume` — continue a saved conversation
- `/settings` — change defaults for future conversations
- `/memories` — manage this launch’s app-wide saved context
- `/session` — show the current session ID and saved usage
- `/help` — show commands and shortcuts
- `/exit` — quit

Changing provider, model or effort starts a new conversation and keeps the old
transcript available through `/resume`.

Enter sends; Ctrl+J adds a line. Shift+Enter or Alt+Enter also adds a line when the
terminal reports those modifiers. Tab completes slash commands.
Some terminals send the same input for Enter and Shift+Enter, so the application
cannot distinguish them from that byte alone. For a native Windows TTY, vivi
requests [Windows input-record reporting](https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md)
to preserve reported Enter modifiers. Physical Shift+Enter behavior on Windows
Terminal 1.24 remains unverified after a user-reported failure. It restores the prior
reporting mode when the UI closes. Other terminals use the supported Kitty keyboard
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
Escape or Ctrl+C cancels a running turn; Ctrl+C while idle exits.
In `/models`, type to filter by ID, name or provider; words can be in any order.
Use arrows or Page Up/Down to browse, Enter to select, Ctrl+U to clear,
Ctrl+R to refresh the catalog, and Escape to go back.

### Mouse controls

The full-screen UI accepts terminal-reported mouse clicks. Click Menu, Models,
Effort, Memory or Settings below the composer to open an action when the draft
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
Saved OpenRouter selections are checked against the provider catalog before the
first session opens, so supported workspace tools are available on the first
turn. Explicit tools-off choices stay off; unavailable or unknown metadata stays
chat-only unless tool support was explicitly declared for this launch.

Keys can be saved in an available OS credential store or used for this launch only.
There is no plaintext key-storage fallback. Conversations are stored locally in
`~/.vivi/sessions`; keep secrets out of chat and command arguments.

## Line mode

Node.js 26.4+ supports line mode without Bun. Set `OPENAI_API_KEY` or
`OPENROUTER_API_KEY` in your environment, then supply a model ID:

```sh
node dist/launcher.js --no-tui --provider openai --model YOUR_MODEL
node dist/launcher.js --provider openrouter --model PROVIDER/MODEL --prompt 'Hello'
```

Use `node dist/launcher.js --help` for all options, including `--resume UUID` and
`--session-dir PATH`.

## Read-only workspace tools

The CLI uses the current working directory where you launch vivi as its read-only
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

The assistant can list files, read UTF-8 text, and search literal text. Reads may be
sent to your selected provider and saved in the local conversation transcript.
Choose a folder whose contents you are comfortable sharing. File names and contents
are treated as untrusted data. No writes, shell commands, automatic execution,
network tools, plugin discovery, or permanent folder trust are added.

The default applies to CLI launches only. Library users of `CliHost` must still
explicitly open and pass a `ReadOnlyWorkspace`; importing or constructing a host
does not grant access to the application’s working directory.

Root and nested `.gitignore` files apply to all three tools, including direct reads.
Symlinks, multi-link files, repository internals, common credential locations,
`.env`/`.env.*`, key files, `node_modules`, and `.cache` are unavailable. Ignore rules
cannot override these exclusions. The active CLI state folder is also excluded,
including a custom `--session-dir` inside the project. Ordinary config such as `package.json` and
`tsconfig.json` remains readable. This policy cannot identify every secret: move
sensitive files outside the selected folder or exclude them with `.gitignore`.

Output is bounded: listings have at most 100 entries; literal searches at most 50
matches; reads return up to 8 KiB from text files no larger than 256 KiB. Traversal
is at most 8 levels per call and stops after 1,000 entries, 200 search files, 2 MiB
of searched text, or 10 seconds. `truncated: true` means the result is incomplete,
including deeper directories not visited. Escape/Ctrl+C cancels a running turn.

Paths are workspace-relative, with forward slashes. Parent traversal, drive/UNC
paths, ambiguous Windows components, and link aliases are refused. The host checks
canonical paths and file identities and withholds results when it detects concurrent
changes. This is not an OS sandbox against hostile programs changing the tree;
use a project folder you control. Exact policy and verification limits are in
[RELEASING.md](RELEASING.md#read-only-workspace-policy).

## Persistent memory

Memory is off by default. Use `--enable-memory` for a launch, or choose the future
launch default in `/settings` in the full-screen UI. `--disable-memory` overrides
an enabled saved default. `/memories` enables or disables the current launch and
lets you list, add, edit and delete records. Back, Escape and Cancel never submit
a change. Each create, edit and delete shows the exact proposal and requires a
fresh interactive approval: select Approve in the full-screen UI, or type `allow`
in line mode. Piped input cannot approve writes.

Memories are stored as plaintext in `memories.json` alongside the CLI’s private
session files, normally `~/.vivi/sessions`. When enabled, saved context is sent to
the selected OpenAI or OpenRouter provider. Keep secrets out of memory. Disabling
memory retains existing records and stops reading or using them. Memory stays
enabled or disabled across provider/model changes, `/new` and `/resume` during
the launch. Changing its `/settings` default affects future launches only.

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

## Usage counts

Round and turn displays show provider-reported token counts. `/session` shows the
saved session aggregate. Cache read/write counts are input-token subsets already
included in input and total counts. A missing cache count is shown as `unreported`,
while an explicitly reported zero is shown as `0`. Each session cache count is
complete only if every accepted provider round reported that field. Old sessions
keep missing metrics unreported; no cache policy, price or savings is inferred.
