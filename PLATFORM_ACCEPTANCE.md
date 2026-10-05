# Platform acceptance preparation

CLI-05 is incomplete until the final integrated CLI artifact is verified on the
platforms selected for distribution. Windows with npm installation is the chosen
first release target; that target decision is not a completed acceptance or release
claim. macOS and Linux remain unverified for real vault and interactive terminal
behavior. Keep Linux headless compatibility checks running. Additional platform
support requires their real runtime/vault checks, rather than an application rewrite.

## Windows npm runtime requirements

The npm package requires Node.js 22+ for line mode and Bun >=1.3.0 for the full-screen
interface. Installing the npm package does not install Bun. Node's interactive
launcher delegates to Bun and explains the line-mode fallback if Bun is absent.
Node line mode and `--help` must work without resolving the native TUI. Native Bun
UI startup on a real Windows terminal is still a release gate.

The CLI remains private and unpublished. Do not advertise a public npm installation
command before its separately approved release. Test the final local tarball in a
fresh npm consumer first; install runtime/parser/native dependencies from the registry
or an explicitly populated cache. A compiled `.exe` is not the selected distribution
and its licensing/startup checks remain a separate future gate.

## Automated, fake/headless evidence

The existing Linux CI and exploratory Windows workflow verify installed Node
entrypoints, fake provider/application paths, fake native credential protocols,
headless Bun rendering and current-platform compiled probes. They do not use real
API keys, call a model service or invoke an actual native credential store.

`npm run test:package` tests the installed bin shim through npm, guards Node's
launcher and public host exports against native TUI imports, compares the bundled
core bytes/notices, checks declarations, and reinstalls the consumer from a prepared
npm cache. Preparation needs registry access. The tarball alone is not an offline
distribution. Windows uses npm's JS entrypoint instead of spawning a `.cmd` shim
with `shell: false`.

Set `VIVI_TEST_ACCEPTANCE_REPORT` to a local JSON filename to retain the exact
tarball SHA-256, npm integrity, byte size, runtime and observed OS. The report is
written only after package checks pass. Optional `VIVI_TEST_BUN=bun` adds installed
headless renderer evidence. Every native/interactive stage remains `not-run` in
this report. A Linux report cannot be relabeled as Windows/macOS acceptance.

For example, in PowerShell from a clean checkout:

```powershell
npm ci --ignore-scripts
$env:VIVI_TEST_BUN = 'bun'
$env:VIVI_TEST_ACCEPTANCE_REPORT = 'windows-package-evidence.json'
npm run test:package
```

This checks the current source artifact, not a future integrated CLI-02 build.
Rerun it after the published extension API is integrated. Keep the exact final
archive or executable and its SHA-256 with the manual results. Do not substitute
a build made from another commit, runtime or platform.

## Manual Windows acceptance still required

Use a real Windows machine and terminal, with the final artifact and a dedicated
local test account that has no existing Vivi credential records. The current
vault implementation uses fixed targets `vivi-cli/openai` and
`vivi-cli/openrouter`; saving a fake value in an everyday account could overwrite
an existing key. Nothing in the automated workflow performs these saves.

Use a deliberately fake, nonworking marker only. Do not enter a live API key,
send chat or fetch a provider catalog during vault-only validation. A scoped
manual probe must exercise `NativeCredentialStore` directly and stay offline.
Running such a probe and creating/removing its test records requires the user's
specific approval. This checklist does not authorize those actions.

- Record Windows edition/build, architecture, terminal/version, Node/Bun versions,
  CLI commit, exact artifact SHA-256 and whether package or executable is tested
- Install into a fresh consumer with no repository dependency fallback; run the
  installed bin's help and Node line-mode route without importing native TUI modules
- In the dedicated account, verify the read-only availability probe, missing record,
  fake save and exact-byte read-back separately for both fixed provider targets
- Restart the process and verify the saved fake value is still readable; check
  shell arguments, diagnostics, preferences and sessions contain no marker
- Check missing/unavailable helper and restricted or unavailable vault session
  behavior without weakening PowerShell execution policy or any security setting
- Verify a session-only fake key never invokes save and is absent after restart
- Start the final native Bun UI in an actual Windows terminal; verify masking,
  repeated setup cancellation, picker cancellation, resize and repeated reopen
- With an offline fake-provider harness, cancel a running turn; verify canonical
  persisted history, no late success, and a usable subsequent turn
- Exit normally and via idle Ctrl+C and termination; verify cursor, echo, raw-mode
  state and alternate screen are restored in the real terminal
- Remove test records only with authorization; report passes, failures and stages
  that could not safely be exercised separately

On Windows, "locked/unavailable" is the actual unsupported/restricted credential
session or helper failure path. Do not manufacture that condition by changing
security settings. Fake protocol errors are useful automated coverage, not proof
that the native failure path worked.

## macOS/Linux and later binary gates

If selected as support targets, macOS needs actual Keychain save/load and locked/
unavailable/session-only checks plus native Bun startup and terminal restoration.
Linux needs an actual supported Secret Service session and helper with equivalent
checks. CI's in-memory renderer or a missing Secret Service on a cloud host is
not a substitute. State skipped or unavailable conditions explicitly.

The package keeps `private: true` and `0.1.0-dev.0`; no npm release is authorized by
these checks. For binary distribution, first review the exact Bun release's MIT
and linked-library notices, LGPL relinking obligations and corresponding materials,
alongside the collected core/OpenTUI/parser notices. The generated local notice
file is supporting material, not a completed legal/release review.
