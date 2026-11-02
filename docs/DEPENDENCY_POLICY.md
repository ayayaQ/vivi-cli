# Dependency release-age policy

New npm-registry dependency resolutions use a seven-day cooldown:

- npm: `.npmrc` sets `min-release-age=7` (days).
- Bun: `bunfig.toml` sets `minimumReleaseAge = 604800` (seconds).

npm remains the primary lockfile and CI installer. The Bun setting covers
contributors who choose Bun for dependency resolution; it does not migrate the
lockfile or change the installer. CLI already uses Bun for native tests/builds.
A cooldown reduces exposure to newly published malicious releases; it is not a
vulnerability scan or a guarantee that an older version is safe.

## Toolchain and enforcement

Use **npm 11.17.0 or newer** for source development. npm 11.10 introduced the
window and 11.17 added package-name exceptions. `package.json` uses
`devEngines.packageManager` with `onFail: error`, so npm versions implementing
that guard reject unsupported install/ci/run commands, even with
`--ignore-scripts`. This is a contributor requirement, not a consumer runtime
engine change. npm 11.17 itself needs Node `^20.17.0 || >=22.9.0`; use a compatible
Node version that also meets this project's unchanged runtime requirement.

CI bootstraps exact **npm 11.17.0** into a runner-temporary prefix, with lifecycle
scripts disabled. It checks the installed version before selecting both its bin
path and npm CLI identity for subsequent steps, then runs the local policy
verifier and installs the locked graph. This avoids a successful global install
leaving an older bundled npm active on Windows. The pin was
published on June 11, 2026 (well outside the window when adopted); it is a
reviewed toolchain bootstrap, not a third-party dependency exception. Global npm
installation does not read project `.npmrc` or apply the project's contributor
guard. The bootstrap needs network access to the official npm registry.

To upgrade an older contributor npm, run:

```sh
npm install --global npm@11.17.0 --ignore-scripts --no-audit --no-fund
npm --version
node scripts/verify-dependency-policy.mjs npm
npm ci --ignore-scripts
```

Global installation changes the npm executable in your development toolchain;
use your normal Node/version-manager installation rather than elevated access.
Very old npm versions that do not implement `devEngines` cannot be made safe by
this field and are unsupported. Do not ignore unknown-config warnings, use
`--force`, weaken the cooldown, or bypass the contributor guard to resolve packages.

For optional Bun resolution, use **Bun 1.4.2 or newer**, then run
`node scripts/verify-dependency-policy.mjs bun`. npm's contributor guard is not a
Bun enforcement mechanism. Older/unverified Bun versions are unsupported; the
verifier and existing Bun CI jobs check the actual installed implementation.

The verifier reads this checkout's config and launches an isolated loopback
registry with synthetic publication times. It checks old/fresh exact versions,
exception boundaries and the existing-lock limitation. It uses no real registry,
credentials or lifecycle scripts, and never rewrites the project lockfile.
It locates npm's JavaScript entry point and invokes it through Node without a
Windows command shell. Unknown PATH shims fail closed rather than selecting a
different npm. With a supported version-manager shim, use
`npm run verify:dependency-policy -- npm` to pass the active npm CLI identity.
Run `npm --version` to see your active npm.

## Important limits

The age filter applies when **resolving new registry versions**, including
transitive dependencies. Existing `package-lock.json`/`bun.lock` entries are not
retrospectively audited: npm 11.17 `npm ci` and Bun 1.4.2 frozen installs can install
a locked version even when its registry publication time is within seven days.
The verifier deliberately records that boundary. CI's passing policy fixture is
proof that the configured resolver works, **not** proof that every locked package
meets the cooldown. Review dependency and lockfile changes; create new resolutions
with a supported, policy-aware toolchain.

Bun's documented stability heuristic may choose still older versions for ranges;
exact versions still obey the age filter. Bun allows packages without publication
timestamps. Missing metadata, Git/tarball/local dependencies, other package managers,
consumer/global installations outside this repository, and higher-priority CLI or
environment overrides are not secured by these project settings. The cooldown
can also delay a new security fix: flag that conflict for explicit review, never
silently disable it or broaden the trusted exception.

Keep tokens and registry credentials out of the tracked `.npmrc`.

## References

- [npm release-age configuration](https://docs.npmjs.com/cli/v11/using-npm/config/#min-release-age)
- [npm 11.17.0 release](https://github.com/npm/cli/releases/tag/v11.17.0)
- [npm contributor devEngines](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#devengines)
- [Bun release-age behavior](https://bun.com/docs/pm/cli/install#minimum-release-age)

## Trusted core releases

Only the exact package name **`@ayayaq/vivi`** is exempt, in both managers. CLI may
adopt a fresh Vivi core release immediately. This is not `@ayayaq/*`: other scoped
packages and third-party dependencies of core still obey the seven-day window.
The verifier tests all three boundaries, including a fresh transitive dependency
of the exempt core. No exception is needed for this checkout's root CLI package.
