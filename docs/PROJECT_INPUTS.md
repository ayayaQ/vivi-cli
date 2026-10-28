# Project instructions and image input

## Project instructions

For a selected workspace, the host loads canonical `AGENTS.md` at its root and
the ancestor directories of active file scopes. Discovery never climbs outside
that workspace. Embedders may explicitly supply an optional guarded profile
source through `CliHostOptions.instructionProfile`; no home-directory scan occurs.

Sources are inert Markdown. Broader guidance comes first, then more specific
directory guidance. They remain below user and host policy and never grant file,
command, network or approval authority. Ordinary file contents remain untrusted
data; only the separately labelled host-loaded channel supplies project guidance.
The complete applicable text is bounded to 32 KiB; source errors or excess text
are explicit, not silently truncated.

Root and active sources are refreshed before every provider dispatch, before
context measurement/compaction. This derived prefix is not a canonical user turn,
stored memory, approval or part of the historical summary.
Chat-only mode does not automatically read workspace instructions or images.

For owned text mutations, the host compares the relevant source chain with the
one the model actually saw in the originating dispatch. Unseen or changed nested
guidance yields `instructions_required` without attempting a mutation; the next
dispatch includes that guidance so the agent can replan. Reading and writing in
one tool batch does not satisfy this requirement. The chain is checked again
before review and commit. This preflight does **not** intercept arbitrary shell,
MCP or imported-extension operations.

`/instructions` shows status, `/instructions reload` refreshes the active sources,
and `/instructions disable` disables this channel for the current host (restart
to re-enable). No watcher
or automatic import/execution is added.

## Workspace images

A path in a message remains ordinary text until the agent explicitly calls
`workspace_read_image({path})`. The tool reads actual PNG/JPEG pixels through the
same guarded workspace paths used by text tools. Ignored/private files, aliases
and paths outside the selected workspace remain unavailable. No new external-path
approval bypass, URL fetch, screenshot, image generation or attachment UI is added.

The host verifies encoding envelopes, dimensions and content hashes. Supported
inputs are at most 5 MiB, 16 megapixels and 8192 pixels per side. Each session keeps
at most 32 immutable snapshots / 64 MiB under its private session state. Images may
contain sensitive visual information: permitted image reads send pixels to the
selected model provider and retain the snapshot locally in plaintext. This is not
OCR-only input or base64 stored as ordinary result text.

Tool results retain text metadata plus generic core image references. Payloads are
resolved only into the final prepared provider request; estimation uses metadata
and a conservative image-token allowance, not base64 character counts. OpenAI
Responses receives image-bearing function outputs. Chat gateway adapters preserve
the whole real tool-result batch, then add a provider-only image observation
labelled by source call ID—not a canonical user request or approval.

Vision and tool support must be verified for the exact selected model/provider/
protocol. Unknown or unsupported support is explicit; no adapter silently drops
pixels. Provider compatibility is fixture-tested, not a claim of live endpoint or
account qualification.

Replay reads immutable snapshots, never changed original paths. Compaction can
summarize older metadata without loading historical pixels and retains snapshot
identities/hashes; it does not invent a visual description. Missing recent assets
block image dispatch with a recovery message. Restore the private session image
files or start a new session. Unaccepted snapshots are cleaned on turn closure;
owned interrupted staging files are recovered while the application holds its
exclusive session lease. Accepted snapshots are retained for replay.

The fixed automatic reviewer remains text-only. Conservatively, sessions with
image observations require fresh human review for otherwise automatic actions;
unseen pixels cannot become review evidence or permission.

## Published core dependency

The CLI pins the verified registry release `@ayayaq/vivi@0.16.0` for fresh context
prefixes, generic image references, provider projection and version-2 event records.
Image sessions use CLI schema 3; legacy text schemas remain readable. Older strict
decoders do not understand the new fields/versions.

`npm ci` installs that exact published package using the registry URL and integrity
in the lockfile. No local package override, vendor archive or local-path dependency
is required.

Core publication does not publish this CLI or establish native-platform readiness.
