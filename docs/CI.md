# Development CI gates

Development branches run on `pull_request` (the merge result), rather than repeating
the same matrix on branch pushes. Main pushes and manual runs retain validation.
New runs of the same PR cancel obsolete runs of the same workflow;
main/manual runs have unique concurrency groups. There are no path filters.

PRs have eight jobs:

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
