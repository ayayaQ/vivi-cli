# Windows command helper build proof (stage 1)

This source-only stage does not change the production command runner. The C# in
`ViviCommandJob.cs` is an exact canonical-LF copy of `nativeSource` in
`src/command-windows.ts`. Only CRLF checkout line endings of that TypeScript
anchor are normalized when comparing it. The ABI/spec anchors both C# files,
source hashes, the public static `Run` signature, AnyCPU and .NET Framework 4.6.2.
The separate assembly metadata is neutral; approval state belongs in proof data.

## API

Run on an existing Windows CI image:

    node scripts/build-windows-command-helper.mjs --artifact-dir <new absolute directory> --source-revision <40-hex workflow head>

The artifact directory must be new and either external to the Git worktree or
inside the reserved, ignored `.vivi-build/` directory. It must not be in `dist`,
so normal clean-build cannot erase it. Existing output directories are refused.
There is no source/path/compiler override on the CLI. The exported
`buildWindowsCommandHelper(options, testRuntime)` and subprocess runner support
controlled tests; runtime injection is not exposed as a CLI capability.

## Prerequisites and discovery

Only already-installed Microsoft tools are used: Windows PowerShell, system
`taskkill.exe`, installer `vswhere.exe`, installed Visual Studio Roslyn `csc.exe`
and the explicit .NET Framework 4.6.2 targeting pack. Missing prerequisites,
a different declared SDK version/location, incomplete installations, reparse
paths, changed inputs, cancellation and unverified cleanup stop the proof. The
script never downloads tools, installs packages, modifies trust settings or
forwards PATH, HOME, provider keys or blanket environment values.

The explicit trust boundary is the controlled GitHub-hosted Windows image,
with Visual Studio Enterprise 18.10.12217.157 at its expected installed location,
Roslyn under its installed MSBuild directory and the official 4.6.2 reference pack.
The script requires declared hosted-runner metadata and checks canonical paths,
reparse ancestors and before/after tool hashes. These environment declarations
are not cryptographic attestation of an arbitrary host. This stage is not a
general-purpose tool authenticator and contains no new Authenticode framework.

PE company/version resources are informational only, never signer authentication.
Executable/version, colocated Roslyn dependency/config and framework-reference
hashes are **observations**, not approved pins. No toolchain lock is self-approved.
Independent review must establish exact accepted pins and build provenance before
later canonical packaging or runtime integration. Missing prerequisites or changed
SDK/image/tooling are blockers; the script does not install or silently update them.

## Reproducibility and supervision

Two exclusive compile directories receive exact source and reference snapshots.
Compilation uses `/noconfig`, `/nostdlib+`, explicit reference files,
`/target:library`, `/platform:anycpu`, deterministic options and path mapping.
There are no implicit response files, analyzers, shared compiler servers or
executed C# methods. Source, snapshot, toolchain and original reference hashes
are checked again before proof output. The two DLLs must be byte-identical.
A bounded structural PE/CLR check verifies CLR4, IL-only AnyCPU and library flags;
loaded-method signature verification remains a later loader-stage gate.

Each compiler is bounded at 120 seconds; discovery/metadata tools at 20 seconds.
Combined stdout/stderr is bounded at 256 KiB (metadata at 16 KiB), and content is
not included in proof logs. The supervisor distinguishes root `exit` from pipe
`close`. On timeout/cancel/overflow/pipe error while the root is alive it runs
fixed system `taskkill /PID <captured PID> /T /F`, bounds and observes that cleanup
helper, and waits for the compiler pipes to close before discarding files.

If the root already exited while a descendant retains a pipe, or cleanup cannot
be established, the script fails closed and retains an unapproved quarantine.
It does not reuse the dead PID, destroy pipes to claim successful cleanup, or
publish success evidence. This build-only supervision is not the production
Job Object containment mechanism. No assertion of crash-proof build containment
or immunity to hostile administrator mutation is made.

## Success artifact contract

The explicit success upload allowlist is:

- `ViviCommandJob.dll`
- `ViviCommandJob.cs`
- `ViviCommandJob.AssemblyInfo.cs`
- `windows-command-helper.spec.json`
- `discovery-proof.json`

The manifest always has `approvalState: unapproved-discovery`, `canonical: false`
and `runtimeEligible: false`. It records a declared workflow revision, exact
source/spec hashes, observed tool/reference hashes, normalized compiler options,
two-build evidence and DLL hash. The revision is declared by the workflow, not
independently verified by this script. Private compile directories are removed
before this success contract appears. Failure/quarantine files are excluded from
this upload allowlist. No DLL, base64 or generated byte module belongs in Git.

This stage does not load the helper, invoke `Run`, modify consent/enrollment,
change command environments/timeouts/limits, alter production Job Objects,
consume proof as canonical assets or introduce an MCP transport. A reviewed
future stage can package verified DLL bytes and a manifest under `dist/assets`
and embed those same bytes in standalone Bun builds without runtime compilation.
