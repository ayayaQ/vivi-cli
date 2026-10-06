# Development validation

This repository contains the application host and terminal UI. The shared agent loop,
canonical history helpers and provider implementations come from `@ayayaq/vivi`.

The current package remains private and versioned `0.1.0-dev.0`. It depends on
the exact immutable npm release `@ayayaq/vivi@0.5.0`, with the registry tarball URL
and SHA-512 integrity recorded by npm in the lockfile. Do not accept a same-version
artifact containing different bytes. The packed CLI bundles the installed shared
dependency, including its source, LICENSE, NOTICE and attribution records, so the shared core needs no separate registry request. OpenTUI and its native platform
dependencies remain registry dependencies; offline installs need a populated npm cache.

## Shared registry dependency

The published shared vivi `0.5.0` registry archive was verified byte-for-byte against
the reviewed release artifact. The package check requires that reviewed SHA-512
integrity, an exact registry version and matching installed dependency metadata.
It also checks the bundled core's source, license, attribution and runtime/type exports.

The optional shared `providers/models` module normalizes capability facts for OpenAI
Responses and OpenRouter Chat Completions. The CLI retains its 52 documented OpenAI
conversation/tool IDs and 72 task-specific exclusions wherever shared coverage is
unknown. Tests pin that prior host coverage, the shared source cases, and the explicit
reasoning corrections for GPT-4.1 and o3-pro. Fetching, cache/key scope, selection,
preferences, explicit host declarations and unknown-stream behavior remain host policy.
Explicit disable is checked separately from named effort choices, then mapped to the
existing provider factory's `none` capability sentinel. Defaults omit an override.

The CLI reuses the shared calculator extension and accepts explicitly imported,
trusted `ToolExtension` values in `CliHostOptions.extensions`. Each turn captures
one registry before its first asynchronous save, including reserved disabled built-in
names. Hosts retain note approvals, cancellation and canonical-history persistence.
This does not add package discovery, a loader, installation, sandboxing or new tool
permissions. The private CLI remains a consuming package; publishing core does not
publish the CLI.

Schema-1 sessions accept optional complete-session cache input read/write counts.
Old sessions retain missing fields. A cache aggregate is reported only when every
accepted provider round reports that field, including an explicit zero. Cache counts
are already included in provider input and total counts, which are never recomputed
from the cache breakdown. Assistant checkpoints omit cache aggregates until round
telemetry is saved; final cancellation/error reconciliation counts accepted usage once.
Round, turn and session displays label their scope and distinguish unreported from zero.
No cache policy, pricing or estimated savings is added.

For a future shared dependency update, publish and verify the compatible shared npm
release first, then change the exact dependency and regenerate the lockfile. Review
the diff and preserve every other dependency's locked version, resolution, integrity
and platform metadata. Do not commit npm pack outputs or vendor tarballs. Historical
snapshots remain recoverable from Git. Keep this CLI's version and `private: true`
unchanged unless a separate CLI release is requested.

## Read-only workspace policy

`--workspace PATH` grants a host-owned, launch-only read capability. The shared core
does not load extensions or own filesystem policy. The CLI reserves `workspace_list`,
`workspace_read` and `workspace_search` even when disabled, and advertises/executed
tools share a fixed registry. Tool support gating remains unchanged: selecting a
folder alone does not declare unknown model support. Chat-only turns neither expose
workspace tools nor add their guidance. Folder roots are not in preferences or
session records; already read tool results remain part of normal session history.

The fixed, case-insensitive exclusions are `.git`, `.hg`, `.svn`, `.ssh`, `.aws`,
`.azure`, `.gcloud`, `.gnupg`, `.vivi`, `.kube`, `.docker`, `.codex`, `.claude`,
`.gemini`, `node_modules`, `.cache`, `.config/gcloud` and `.config/gh`; `.npmrc`,
`.pypirc`, `.netrc`, `_netrc`, `.git-credentials`, `credentials`, `credentials.json`,
`auth.json`, `token.json`, `secrets`, `secrets.json`, `secrets.yaml`, `secrets.yml`,
`id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `.env`, `.env.*`, `.envrc`, and filenames ending
in `.pem`, `.key`, `.p12`, `.pfx` or `.keystore`. There is no override in this slice.
Filesystem roots and known private-directory roots cannot be selected.
The active CLI state/profile folder is excluded by canonical path and, when it
already exists, directory identity. A workspace equal to or inside that private
folder is refused. Missing custom state folders are resolved through their nearest
existing ancestor and excluded before the CLI creates them. Ordinary siblings
remain available. As with the rest of the policy, this cannot guarantee privacy
against a hostile process moving newly created directories between checks.

The exact MIT dependency `ignore@7.0.12` interprets root and nested `.gitignore`
rules, with case-insensitive matching on Windows and case-sensitive matching
elsewhere. No Git command, index, global excludes, `.git/info/exclude`, or files
outside the selected root are consulted. Ignored files are excluded even when
tracked by Git. The package's documented Unicode/glob differences from Git apply.
Ignore files must be regular single-link UTF-8 text, at most 8 KiB each and 32 KiB/
256 noncomment rules per operation; failures refuse the entire result. The runtime
dependency's `LICENSE-MIT` remains in its npm archive/installation. The shared vivi
pin, bundled inventory, CLI version and private status stay unchanged.

Each tool result is marked `untrusted: true`; fixed per-turn system guidance says
file data grants no instructions or authority. This guidance is removed from the
canonical saved history. Known environment/vault credentials are withheld from
results, and host checks reject known credentials before each provider request,
including decoded workspace results from resumed history. This does not detect all
unknown credentials or other sensitive data.

Hard limits: 8 traversal levels per operation, 1,000 examined directory entries,
200 search files, 256 KiB per file, 2 MiB searched bytes, 8 KiB read output, 56 KiB
serialized result output, 100 list entries, 50 matched search lines, 200 requested
read lines and 10 seconds. Budgets are checked between bounded filesystem calls;
cancellation cannot interrupt an OS filesystem call already in progress, but its
late result is discarded and handles are closed. There are no writes or replays.

Canonical roots, ancestor identities, final file identities and byte/timestamp
snapshots are checked. Linux child opens use verified pinned directory handles;
other platforms use canonical-path and identity rechecks, including Windows
junction/symlink rejection. All detected changes fail without returning the partial
result. These safeguards are not an OS sandbox against a malicious process doing
undetectable path swaps; use a stable tree you control. Native Windows/macOS and
live-provider acceptance are separate gates, never implied by cloud Linux tests.

## Persistent app-wide memory

Memory is opt-in via `--enable-memory` or `/memories`; `--disable-memory` overrides
saved defaults. The default remains off. Memory is separate from existing session
notes and is stored as private plaintext `memories.json` in the configured state
directory. A custom `--session-dir` isolates its store. Enabled memories are sent to
the selected provider as user-level context. Their turn-only prefix is removed from
canonical session history, so edits/deletes do not leave obsolete saved snapshots.

The shared `extensions/memory` API supplies v1 codecs, limits, revisions, prepared
mutations and static tools. The CLI owns fresh disk loads, an app-wide commit lease,
backup/evidence recovery, atomic durability, explicit review and shutdown draining.
Every create/edit/delete requires a fresh human approval (select Approve in the
full-screen UI, or type allow in line mode); pipe, EOF and cancellation
default to denial. Memory context remains available in chat-only mode, but memory
tools are omitted when tools are disabled or their support is unverified. Records
are retained when the feature is disabled. No notes migration, embeddings or
automatic summarization is added.

Full-screen mouse regression tests send SGR sequences through the real OpenTUI
0.5.14 parser and native hit grid. They cover approval default-deny, stale/repeated
press-release gestures, query/resize boundaries, picker rows, wheel scrolling,
modal actions, keyboard paths and composer focus. Picker cell mapping is an
explicit adapter for the pinned Select's default-font, zero-spacing layout;
revalidate it before changing OpenTUI or picker geometry. Mouse reporting is
terminal-dependent; OS pointer styling and native clipboard integration are not
added. Windows Terminal VT mouse support is documented by Microsoft, but offline
native tests are not interactive Windows-terminal acceptance.

Offline regression tests and native in-memory TUI tests do not claim real-device,
interactive-terminal, OS-vault or live-provider acceptance.

## Check the checkout

Use Node.js 26.4 or newer for the CLI; install Bun >=1.3.0 for native UI checks:

```sh
npm ci --ignore-scripts
npm run check
npm run test:tui
VIVI_TEST_BUN=bun npm run test:package
npm run test:standalone
npm run build:standalone
./build/vivi --help
```

Checks use fake providers and local streams. They make no real model calls and need
no API keys. The package check packs the CLI, installs it in an isolated consumer,
launches the installed `vivi --help` bin, verifies runtime exports and checks emitted
TypeScript declarations. Session tests write only to private temporary directories.

`npm pack` creates a local archive; it does not publish anything. Uploading to GitHub,
publishing to npm or accepting external agreements needs separate authorization.

A future public CLI npm release requires a separate decision to remove `private: true`
and select its release version. Regenerate the lockfile, rerun the full checks and
review the packed files for that release. This shared dependency transition does not
publish or release the CLI. No release workflow is enabled in this repository.

## UI runtime and standalone artifacts

OpenTUI 0.5.14 is loaded lazily under Bun only. The Node 26.4+ line route and public
host exports must never import native TUI modules. Check both installed entrypoints,
not just source imports. The standalone build targets the current platform only,
embeds native assets, and writes dependency notices beside the local binary.

The standard Ubuntu Bun CI lane uses native in-memory rendering and mock input;
it makes no real provider calls and does not upload build artifacts. Windows x64 is
the selected npm release target; real vault and interactive-terminal acceptance is
still pending. macOS/Linux need those checks before additional platform claims.
CI tests the minimum Node 26.4.0 and latest Node 26 with engine-strict npm; packed
consumer checks also reject engine warnings. This changes the CLI requirement,
not the shared core's Node 22+ support. Packaging tests prepare dependency metadata and bytes from the registry in a fresh
cache, verify OpenTUI/parser resolution and integrity against the reviewed lock, then
reinstall the isolated consumer offline from that cache. This requires registry access
for preparation; the archive alone is not an offline distribution.

A binary release is a separate action. Before distributing one, review the exact
Bun release's MIT/linked-library licensing and LGPL relinking obligations, preserve
all runtime/native dependency notices, supply the required corresponding materials,
and check clean-machine startup on each advertised platform. The local build's
notice collection is an aid, not a substitute for that release review. No binaries
or native archives are vendored into Git, and no executable publishing workflow is
enabled. npm publication, GitHub publication and binary release remain separately
authorized operations.
