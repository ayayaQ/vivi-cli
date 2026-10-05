# Platform acceptance preparation

The shared extension API, cache usage and endpoint-aware model normalization are current in the CLI.
CLI-05 is incomplete until that final integrated CLI artifact is verified on the
platforms selected for distribution. Windows x64 with npm installation is the chosen
first release target; that target decision is not a completed acceptance or release
claim. macOS and Linux remain unverified for real vault and interactive terminal
behavior. Keep Linux headless compatibility checks running. Additional platform
support requires their real runtime/vault checks, rather than an application rewrite.

Acceptance evidence is tied to the exact archive hash. A successful manual check of an
earlier candidate does not cover a later dependency or model-behavior change. Recheck
the final candidate's model/effort/default/disable flows before a public CLI release.

## Windows npm runtime requirements

The npm package requires Node.js 26.4+ for line mode and Bun >=1.3.0 for the full-screen
interface. Installing the npm package does not install Bun. Node's interactive
launcher delegates to Bun and explains the line-mode fallback if Bun is absent.
Node line mode and `--help` must work without resolving the native TUI. Native Bun
UI startup on a real Windows terminal is still a release gate.

OpenTUI 0.5.14 declares Node >=26.4.0 and Bun >=1.3.0 in its package metadata.
The selected Node 26.4+ npm installation requirement matches that metadata.
Both clean checkout and packed-consumer checks use engine-strict npm and reject
engine warnings. Node 22/24 installation is no longer a supported CLI path; the
shared core package retains its own separate Node 22+ requirement.
Windows ARM64 requires Bun >=1.4.0, but is not part of the initial validated target.

The CLI remains private and unpublished. Do not advertise a public npm installation
command before its separately approved release. Test the final local tarball in a
fresh npm consumer first; install runtime/parser/native dependencies from the registry
or an explicitly populated cache. A compiled `.exe` is not the selected distribution
and its licensing/startup checks remain a separate future gate.

## Automated, fake/headless evidence

The Linux CI and Windows acceptance workflow verify installed Node
entrypoints, fake provider/application paths, fake native credential protocols,
headless Bun rendering and current-platform compiled probes. They do not use real
API keys, call a model service or invoke an actual native credential store.

`npm run test:package` tests the installed bin shim through npm, guards Node's
launcher and public host exports against native TUI imports, compares the bundled
core bytes/notices, checks declarations, and reinstalls the consumer from a prepared
npm cache. Preparation needs registry access. The tarball alone is not an offline
distribution. Windows uses npm's JS entrypoint instead of spawning a `.cmd` shim
with `shell: false`.

The Windows acceptance workflow first builds and checks one canonical private npm
archive on Ubuntu with Node 26.4.0 and Bun 1.4.2. Only after all package and installed
native/headless consumer checks pass does `VIVI_TEST_CANDIDATE_DIR` expose a new
directory containing the exact `.tgz`, `candidate.json` and `package-evidence.json`.
The metadata preserves actual npm pack metadata, byte size, SHA-256 and SHA-512.
The artifact upload includes only those three files, with no standalone binaries,
credentials or sessions. The npm package remains `private: true` and unpublished.
This CI test artifact is not a release. The repository is public, and artifact
access follows its existing permissions.

Both Windows x64 Node jobs (26.4.0 and latest 26) download that same artifact. Set
`VIVI_TEST_PACKAGE_ARCHIVE` and `VIVI_TEST_PACKAGE_METADATA` together to test it
without repacking. The check validates the expected package name/version/filename,
byte size, both digests and npm integrity/shasum, then asks npm to inspect the actual
archive's complete pack metadata before installation. Missing, altered or mismatched
inputs fail before an acceptance report. Imports cannot be re-exported as a new
candidate, and an existing export directory is never reused.

Set `VIVI_TEST_ACCEPTANCE_REPORT` to a local JSON filename to retain the exact
archive SHA-256, npm integrity, byte size, runtime and observed OS. The report is
written only after package checks pass. Optional `VIVI_TEST_BUN=bun` adds installed
headless renderer evidence. One archive gets separate Linux and Windows reports;
each report records its actual OS. Every native-vault/interactive stage remains
`not-run`. A Linux report cannot be relabeled as Windows/macOS acceptance.

For example, in PowerShell from a clean checkout, with the canonical candidate
downloaded into `C:\vivi-candidate`:

```powershell
npm ci --ignore-scripts --engine-strict
$env:VIVI_TEST_BUN = 'bun'
$env:VIVI_TEST_PACKAGE_ARCHIVE = 'C:\vivi-candidate\ayayaq-vivi-cli-0.1.0-dev.0.tgz'
$env:VIVI_TEST_PACKAGE_METADATA = 'C:\vivi-candidate\candidate.json'
$env:VIVI_TEST_ACCEPTANCE_REPORT = 'windows-package-evidence.json'
npm run test:package
```

Keep that exact archive and its SHA-256 with the manual results. Do not substitute
a platform-local repack or a build from another commit. Only the CLI root LICENSE
comparison normalizes Windows checkout CRLF to LF; its legal text must otherwise
match. Every bundled published core file, including its legal notices, remains
byte-exact.

## Manual Windows acceptance still required

Use a real Windows machine and terminal with the same final canonical npm archive.
The safe offline native probe must default to read-only availability and record
presence checks. It must never display existing record values. The current vault
implementation uses fixed targets `vivi-cli/openai` and `vivi-cli/openrouter`;
saving a fake value could overwrite an existing key. Refuse every save if either
target already has a Vivi record, or if safe absence cannot be established.
No account creation, security-setting change or deletion is required. Nothing in
the automated workflow invokes the real vault or performs these saves.

Use a deliberately fake, nonworking marker only. Do not enter a live API key,
send chat or fetch a provider catalog during vault-only validation. A scoped
manual probe must exercise `NativeCredentialStore` directly and stay offline.
The separate manual harness is not part of this CI artifact. These are intended
safe steps, not a claim that native execution occurred. Running a write-mode probe
and creating any fake records requires the user's specific approval after the
read-only preflight. This checklist does not authorize those actions. Leave
existing records untouched; unavailable or unsafe steps must be reported as such.

- Record Windows edition/build, architecture, terminal/version, Node/Bun versions,
  CLI commit, exact artifact SHA-256 and whether package or executable is tested
- Install into a fresh consumer with no repository dependency fallback; run the
  installed bin's help and Node line-mode route without importing native TUI modules
- Verify read-only availability and presence/absence for both fixed provider targets
- Only after explicit write approval and confirmed absence of both records, verify
  fake save and exact-byte read-back separately; recheck absence before any save
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
- Report passes, failures and stages that could not safely be exercised separately;
  deletion is optional and requires separate authorization if cleanup is desired

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
