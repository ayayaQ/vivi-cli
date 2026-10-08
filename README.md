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
- `/mode` — choose Manual or enroll optional Auto review for the current conversation
- `/new` — start a fresh conversation
- `/resume` — continue a saved conversation
- `/rename` — rename the current conversation (or `/rename NAME` in line mode)
- `/settings` — change defaults for future conversations
- `/memories` — manage this launch’s app-wide saved context
- `/mcp` — configure and explicitly connect trusted installed stdio servers for metadata discovery
- `/session` — show the current session ID and saved usage
- `/help` — show commands and shortcuts
- `/exit` — quit

Changing provider, model or effort starts a new conversation and keeps the old
transcript available through `/resume`.

Sessions get a readable name from the first accepted message, without an extra
model call. Rename keeps that name through later turns and resumes. The resume
picker shows names and local dates such as Today or Yesterday, with the model
and session ID still available. Older unnamed sessions use a display-only
first-message fallback; browsing them does not rewrite saved files.

The full-screen status shows an animated Working indicator and total elapsed
turn time, including time spent waiting for approval. Waiting for approval and
Cancelling have separate labels. The timer stops when the turn settles or the UI
closes, including non-streaming requests and failed turns.

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
Effort, Mode, Memory or Settings below the composer to open an action when the draft
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

## Optional MCP discovery

Use `/mcp` in full-screen or line mode to add an already installed executable,
its separate arguments, working directory and explicit legacy or pinned modern
protocol. Entries start disabled every launch. Enable requires fresh human
approval showing that exact launch; Disable closes the owned process tree.
For account-independent line management, run
`node dist/launcher.js --no-tui --prompt /mcp`; no model or provider key is needed.

Starting a trusted server runs its code with your OS permissions before any
tool-call approval. It can access files and network; this is not a sandbox.
Catalogs show bounded tool names, resource URIs and templates only. They are
never model tools or provider context. Unsupported schemas are quarantined.
There are no resource reads, OAuth, HTTP, credential environment values,
repository auto-discovery, package installation or automatic reconnects.
Windows requires Windows 10+/Server 2016+ and built-in Windows PowerShell
FullLanguage for owned Job Object cleanup.

## Optional Auto review

Manual is always the default. `/mode` opens the current conversation’s mode
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
session `note_set`, app-wide memory create/edit, or selected-workspace text creation/precise edits may be automatically approved.
The corresponding notes/memory/workspace and tool feature gates must already be enabled.
Delete, `/memories` manager mutations, excluded actions and hard denials remain
outside Auto review. A model recommendation never relaxes host policy or skips
the exact proposal’s final freshness and revision checks.

The review sends the exact current user request, tool arguments and prepared
before/after changed text, workspace-relative paths and full-file hashes to the currently selected existing account: OpenAI
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
ordinary non-sensitive note/memory create/edit and scoped text creation/precise edits only; the sharing consent does not expand
which actions may execute automatically. This adds API charges. Review
is limited to two calls per turn, an eight-second deadline and 16 KiB for the
full decision request. Larger exact evidence stays Manual without truncation;
there is no hard prepaid USD cost guarantee. Returned review usage and any
reported cost are recorded separately from chat/session usage.

The versioned host heuristics require every check to reach at least `0.995` for
OpenAI or `0.999` for OpenRouter; any check at or below `0.05` recommends rejection.
These thresholds are uncalibrated and do not establish comparable behavior
between providers. Model estimates can be wrong and do not prove authorization.
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

## Trusted commands (optional)

Use `/commands on`, or `--enable-commands`, to request a fresh interactive
confirmation for the selected workspace and current launch/session. Commands are
off by default; trust is never saved or restored from history. `/commands off`
disables the capability. Every `command_start` needs a separate human approval,
even in Auto. Piped/headless input cannot approve it.

The approval shows the resolved executable, exact argv array, resolved working
directory, environment variable names, and hard timeout. Execution uses
`shell:false`; to use shell syntax, explicitly request a shell executable and its
arguments. `command_poll` reads bounded output; `command_stop` halts that run’s
process tree. IDs expire at the end of the agent run, which also stops any running
processes. Output is untrusted and may be sent to your provider and saved in history.

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

## Persistent memory

Memory is off by default. Use `--enable-memory` for a launch, or choose the future
launch default in `/settings` in the full-screen UI. `--disable-memory` overrides
an enabled saved default. `/memories` enables or disables the current launch and
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

## Instruction-only Agent Skills

`/skills` lists and inspects standard `<name>/SKILL.md` folders, prepares creator requests
in the composer, and enables or disables skills for this launch. The app-wide folder is
`<session-dir>/agent-skills`; `--skills-dir PATH` adds up to eight explicit read-only roots.
No workspace, home, ancestor, or community discovery is performed. `--no-skills` disables
skills. Metadata goes to the selected provider; instructions and UTF-8 text resources load
progressively through `list_skills` and `read_skill`, without running scripts.

The bundled read-only `skill-creator` drafts SKILL.md content in chat. Save the draft
manually as `<name>/SKILL.md`, then refresh or start a new turn. Automatic skill saving is
disabled on Windows, macOS, and Linux. There is no skill writer, save tool, or save approval.
All skills are read-only to the agent. Existing workspace tools cannot target the owned
private state profile. Skill hints grant no tools, permissions, or Auto eligibility.

Discovery uses canonical filesystem identity for ordinary Windows path aliases, preserves
original files, and reports unavailable roots, invalid formats, and duplicate names.
Bounds are 100 skills including the creator, 64 KiB per UTF-8 document/resource, 2 MiB total
documents, and 24 KiB catalog metadata; serialized tool reads must also fit the session
transcript limit. Existing credential/private-state exclusions remain. Prior restricted
assessments stay excluded; this release does not accept automatic skill saving.
