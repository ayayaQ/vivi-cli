# Development validation

This repository contains the application host and terminal UI. The shared agent loop,
canonical history helpers and provider implementations come from `@ayayaq/vivi`.

The current package is private and versioned `0.1.0-dev.0`. It depends on the exact
checked-in `vendor/ayayaq-vivi-0.2.0-dev.0.tgz` development archive through a `file:`
dependency. Its integrity is recorded in the lockfile and vendor provenance. Do not
silently replace that archive with a same-version archive containing different bytes.
The packed CLI bundles the installed shared dependency so npm can install the artifact
offline without resolving a relative archive before extracting the CLI package.

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

Before a future npm release, publish and validate the compatible shared vivi version,
replace the development archive dependency with that exact immutable registry version,
remove `private: true`, regenerate the lockfile, rerun the full checks and review the
packed files. No release workflow is enabled in this repository.
