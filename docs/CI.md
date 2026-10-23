# Development CI gates

Development branches run on `pull_request` (the merge result), rather than repeating
the same matrix on branch pushes. Main pushes and manual runs retain validation.
New runs of the same PR cancel obsolete runs of the same workflow;
main/manual runs have unique concurrency groups. There are no path filters.

## One workflow, distinct coverage

`.github/workflows/ci.yml` is the single entrypoint for PRs, main pushes and manual
runs. It combines the previously parallel CLI checks and Windows acceptance
preparation workflows; their test responsibilities were distinct, not duplicate.
No matrix legs or tests were removed. Linux correctness stays independent of the
Windows/package graph, and MCP and pinned ConPTY still start independently of the
candidate. Only archive-consuming jobs retain their existing candidate dependency.

Check names identify three responsibilities: `Linux correctness`, `Windows
compatibility`, and `Package/runtime`. Job IDs, runner isolation, matrix strategies,
step ordering, artifacts and runtime versions remain unchanged. Consolidating the
configuration does not reduce computation or serialize the existing parallel jobs.
PR cancellation now applies to the one combined workflow; main/manual runs remain
unique and are never superseded by another run.

PRs have eight execution jobs plus one summary job (nine total). Main/manual runs
have nine execution jobs plus one summary (ten total). The PR-only current
compatibility job is intentionally skipped on main/manual and is not counted as
an executed job (GitHub can therefore display eleven main/manual job entries,
including that skipped entry). Before consolidation there were two workflows and eight/nine
execution jobs, with no overall summary.

The execution coverage is unchanged:

- Linux Node 26.4.0 and current 26: build once, then every Node test file
- Linux candidate: pinned Bun 1.4.2 TUI suite, cold packed Node/Bun consumer
  acceptance, immutable archive/evidence export, standalone probe/build/help
- Windows minimum Node MCP: every MCP/OAuth test file, serial native helpers
- Windows minimum Node headless: remaining platform-compatible Node files
- Windows current Node compatibility: native MCP/command startup, exact argv and
  environment, binary I/O, cancellation, verified descendant cleanup, every OAuth
  callback/lifecycle file, and cold packed Node acceptance
- Windows pinned Bun: public URL/HTTP/OAuth boundaries, all TUI files, genuine stock
  ConPTY fallback, cold packed minimum-Node/Bun consumer acceptance, standalone
  probe/build/help
- Windows pinned modern ConPTY: independent hash-verified official Microsoft
  mode1 transport gate, with unconditional private-backend cleanup

Main/manual runs replace focused current-Node compatibility with the complete
current-Node Windows MCP and headless suites plus packed Node acceptance. The
minimum-Node Windows coverage is unchanged across these events. Wider current-Node
regressions can therefore surface after merge; critical native runtime boundaries
and OAuth lifecycle remain premerge on both versions.

## Overall result

`CI summary` directly depends on all seven execution job IDs (including both
matrix jobs and the Linux matrix) and uses `always()` to inspect their results.
Every expected job must report `success`; failures, cancellations, unknown results,
missing jobs and unexpected skips fail the summary. On main/manual only,
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

At this revision the inventory contains 111 Node files and 24 TUI files:

| Group | Files | Executed coverage |
| --- | ---: | --- |
| `linux-node` | 111 | Both Linux Node versions |
| `windows-mcp` | 35 | Minimum always, current on main/manual |
| `windows-headless` | 71 | Minimum always, current on main/manual |
| `windows-current` | 25 | Focused current Node on PRs |
| `bun-tui` | 24 | Linux candidate and Windows Bun |
| `bun-boundaries` | 28 | Windows Bun |
| `windows-stock` | 1 | Windows Bun stock fallback |
| `windows-modern` | 1 | Independent Windows pinned ConPTY |
| `linux-only` | 2 | Included in Linux Node, excluded on Windows |
| `manual-system-mode1` | 1 | Original OS-dependent diagnostic, not a CI Windows gate |

These counts describe file selection, not individual test cases or claims that
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

For focused CI-organization validation without running application assessments:

```sh
node --test .github/scripts/ci-summary.test.mjs test/ci-tests.test.mjs
node scripts/ci-tests.mjs --list
# If installed:
actionlint
```
