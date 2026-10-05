# Development validation

This repository contains the application host and terminal UI. The shared agent loop,
canonical history helpers and provider implementations come from `@ayayaq/vivi`.

The current package remains private and versioned `0.1.0-dev.0`. It depends on
the exact immutable npm release `@ayayaq/vivi@0.3.0`, with the registry tarball URL
and SHA-512 integrity recorded by npm in the lockfile. Do not accept a same-version
artifact containing different bytes. The packed CLI bundles the installed shared
dependency, including its source, LICENSE, NOTICE and attribution records, so the shared core needs no separate registry request. OpenTUI and its native platform
dependencies remain registry dependencies; offline installs need a populated npm cache.

## Shared registry dependency

The published shared vivi `0.3.0` registry archive was verified byte-for-byte against
the reviewed release artifact. The package check requires that reviewed SHA-512
integrity, an exact registry version and matching installed dependency metadata.
It also checks the bundled core's source, license, attribution and runtime/type exports.

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
