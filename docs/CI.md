# Development CI gates

Development branches run on `pull_request` (the merge result), rather than repeating
the same matrix on branch pushes. Main pushes and manual runs retain validation.
New runs of the same PR cancel obsolete runs of the same workflow;
main/manual runs have unique concurrency groups. There are no path filters.

## One workflow, distinct coverage

`.github/workflows/ci.yml` is the single entrypoint for PRs, main pushes and manual
runs. It combines the previously parallel CLI checks and Windows acceptance
preparation workflows; their test responsibilities were distinct, not duplicate.
Linux correctness stays independent of the Windows/package graph, and MCP and
pinned ConPTY still start independently of the
candidate. Only archive-consuming jobs retain their existing candidate dependency.

Check names identify three responsibilities: `Linux correctness`, `Windows
compatibility`, and `Package/runtime`. Job IDs, runner isolation, matrix strategies,
relative build/test ordering, artifacts and Node/Bun runtime versions remain unchanged. Consolidating the
configuration keeps the independent jobs parallel.
PR cancellation now applies to the one combined workflow; main/manual runs remain
unique and are never superseded by another run.

PRs use focused latest-Node smoke groups and minimum-Windows boundaries. Main/manual
runs use the broad Windows matrices and full latest-Linux coverage. Skipped matrix
jobs can appear in GitHub's job list; they are not executed coverage.

The workflow selects these groups:

- Linux Node 26.4.0: build once, then `linux-node`; current 26 uses `linux-current`
  on PRs and `linux-node` on main/manual
- Linux candidate: pinned Bun 1.4.2 TUI suite, cold packed Node/Bun consumer
  acceptance, immutable archive/evidence export, standalone probe/build/help
- Windows MCP and headless matrices: `windows-mcp` and `windows-headless` on both
  minimum and current Node on main/manual, with serial native helpers
- Windows current Node compatibility: native MCP/command startup, exact argv and
  environment, binary I/O, cancellation, verified descendant cleanup, every OAuth
  callback/lifecycle file, and cold packed Node acceptance
- Windows pinned Bun: public URL/HTTP/OAuth boundaries, all TUI files, genuine stock
  ConPTY fallback, cold packed minimum-Node/Bun consumer acceptance, standalone
  probe/build/help; PRs also run `windows-minimum` with Node
- Windows pinned modern ConPTY: independent hash-verified official Microsoft
  mode1 transport gate, with unconditional private-backend cleanup

Main/manual runs replace focused current-Node compatibility with the complete
current-Node Windows MCP and headless suites plus packed Node acceptance. The
minimum-Node Windows PR boundaries run in the Bun job before its Bun suites.
Wider Windows regressions can therefore surface after merge; critical native runtime boundaries
and OAuth lifecycle remain premerge on both versions.

## Overall result

`CI summary` directly depends on all seven execution job IDs (including both
matrix jobs and the Linux matrix) and uses `always()` to inspect their results.
Every expected executed job must report `success`; failures, cancellations,
unknown results, missing jobs and unexpected skips fail the summary. On PRs,
`mcp` and `headless` must report `skipped` because focused Windows gates run instead.
On main/manual,
`current-compatibility` must report `skipped`, because the complete current-Node
Windows MCP/headless matrix legs run instead. No job uses `continue-on-error`.
A failed matrix leg therefore prevents a passing matrix result. If GitHub cancels
the entire workflow before the summary can execute, that is not a passing gate.

The policy is in `.github/scripts/ci-summary.mjs`; its focused regression tests run
in the summary job before evaluating the dependency results. It is a proposed
single review signal, not a branch-protection change. Existing required-check
settings are not modified here; a maintainer must review those separately before
requiring the new name or removing old required names.

## Test ownership and runtime evidence

File selection comes from `ciTestGroups()` in `scripts/ci-tests.mjs`. Generate the
current file map and counts from the checkout instead of copying numbers here:

```sh
node scripts/ci-tests.mjs --list
node --input-type=module -e "import {ciTestGroups} from './scripts/ci-tests.mjs'; console.log(JSON.stringify(Object.fromEntries(Object.entries(await ciTestGroups()).map(([name, files]) => [name, files.length])), null, 2))"
```

| Group | Executed coverage |
| --- | --- |
| `linux-node` | Every Node file; minimum always, current on main/manual |
| `linux-current` | Focused current Node on PRs |
| `windows-minimum` | Minimum Node PR boundaries in the Windows Bun job |
| `windows-mcp` | Both Node versions on main/manual |
| `windows-headless` | Both Node versions on main/manual |
| `windows-current` | Focused current Node on PRs |
| `bun-tui` | Linux candidate and Windows Bun |
| `bun-boundaries` | Windows Bun |
| `windows-stock` | Windows Bun stock fallback |
| `windows-modern` | Independent Windows pinned ConPTY |
| `linux-only` | Included in Linux Node, excluded on Windows |
| `manual-system-mode1` | Original OS-dependent diagnostic, not a CI Windows gate |

Generated counts describe file selection, not individual test cases or claims that
platform-specific skipped fixtures executed. The seven restricted/adversarial
skills-store assessments remain unconditionally skipped; neither this reorganization
nor summary validation enables or reruns them.

`node scripts/ci-tests.mjs --list` prints the exact file ownership map. New MCP/OAuth,
headless Node, and TUI files enter their groups automatically. The inventory test
checks that every file has an explicit owner, names resolve, and native/OAuth/HTTP
compatibility gates remain present. Existing `cli`/`preferences` POSIX permission
fixtures remain Linux-only. The original system-dependent mode1 diagnostic remains
manual; genuine stock mode2 and hash-pinned modern mode1 are separate Windows gates.
Platform skips remain recorded skips, including Linux PTY fixtures on Windows and
Windows native fixtures on Linux. No fixture deadline or assertion is relaxed.

All Windows packed checks consume the same validated candidate bytes and metadata.
Fresh temporary registry caches and the offline reinstall are preserved. Uploads
remain limited to the private archive and nonsecret JSON evidence. Automated CI
does not establish physical-terminal, native-vault, or binary-release acceptance.

Run `npm run build` before a leaf test group or `npm run test:package:built`.
The ordinary `npm test`, `npm run check`, and other developer commands still build
as before. Run the full main/manual gates before development release validation.
Audit lane checks select explicit ordinary files and never run
`test/skills-store.test.mjs`, broad groups containing it, or blanket `npm test`.

The separate [synthetic acceptance report](../PLATFORM_ACCEPTANCE.md#synthetic-report-contract)
requires an explicit backend and a clean committed source SHA. Its fixture hash is
not a package hash. Windows and macOS reports must be generated independently on
the same frozen source with Node >=26.4; Node24 does not qualify. Synthetic
helper/store results never cover real OAuth, vault or physical-input stages.

For focused CI-organization validation without running application assessments:

```sh
node --test .github/scripts/ci-summary.test.mjs test/ci-tests.test.mjs
node scripts/ci-tests.mjs --list
# If installed:
actionlint
```


## Dependency resolution policy

Before each `npm ci`, CI installs the exact mature npm **11.17.0** toolchain with
lifecycle scripts disabled, then runs `node scripts/verify-dependency-policy.mjs npm`.
The verifier is a required pre-install step: unsupported npm or failed cooldown
fixtures stop the job. npm 11.17.0 introduced the exact-package exclusion needed
for trusted Vivi releases and was released on 2026-06-11. This contributor/CI
requirement does not raise the published package's Node runtime requirement;
the selected CI Node versions satisfy npm's own engine requirement.

The bootstrap changes the CI runner's npm tool only; it does not update project
dependencies or the lockfile. It does not lower the project's seven-day window.
`npm ci` remains a locked install, **not** a retrospective release-age audit of
already-locked versions. See [the dependency policy](DEPENDENCY_POLICY.md) for
new-resolution scope, supported tools, trusted-package scope, and lockfile limits.

Every job that installs Bun 1.4.2 also runs
`node scripts/verify-dependency-policy.mjs bun` before dependency installation.
The existing native/runtime/acceptance gates and seven excluded assessments retain
their scope; no new provider, credential-store, or physical-input checks are added.
The CI inventory regression test rejects missing, conditional, or obsolete-toolchain
policy steps in each existing dependency-installing job.
