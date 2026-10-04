# Development validation

This repository contains the application host and terminal UI. The shared agent loop,
canonical history helpers and provider implementations come from `@ayayaq/vivi`.

The current package remains private and versioned `0.1.0-dev.0`. It depends on
the exact immutable npm release `@ayayaq/vivi@0.2.0`, with the registry tarball URL
and SHA-512 integrity recorded by npm in the lockfile. Do not accept a same-version
artifact containing different bytes. The packed CLI bundles the installed shared
dependency, including its source, LICENSE, NOTICE and attribution records, so npm can
install the CLI artifact offline without a separate registry request.

## Shared registry dependency

The published shared vivi `0.2.0` registry archive was verified byte-for-byte against
the reviewed release artifact. The package check requires that reviewed SHA-512
integrity, an exact registry version and matching installed dependency metadata.
It also checks the bundled core's source, license, attribution and runtime/type exports.

For a future shared dependency update, publish and verify the compatible shared npm
release first, then change the exact dependency and regenerate the lockfile. Review
the diff and preserve every other dependency's locked version, resolution, integrity
and platform metadata. Do not commit npm pack outputs or vendor tarballs. Historical
snapshots remain recoverable from Git. Keep this CLI's version and `private: true`
unchanged unless a separate CLI release is requested.

## Check the checkout

Use Node.js 22 or newer:

```sh
npm ci --ignore-scripts
npm run check
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
