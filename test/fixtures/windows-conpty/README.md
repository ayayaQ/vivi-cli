# Private headless Windows ConPTY regression

Status: prepared and cross-platform fixture-validated. Actual Windows C#/PowerShell/ConPTY execution is still unverified. A Linux skip is not Windows evidence.

The native test has a distinct name, `windows-conpty-native.test.mjs`, so it does not replace the existing topology simulation. It is included in the Windows acceptance workflow alongside that simulation.

## Run on Windows x64

Use the repository's existing Node 26.4.0 and Bun 1.4.2 setup and installed dependencies. Windows PowerShell 5.1 and OS CreatePseudoConsole are required. The host is compiled locally by Add-Type, without a native package or downloaded binary.

Normal candidate regression:

```powershell
node --test test/windows-conpty-native.test.mjs
```

The same test and child can target a separate baseline checkout without editing it:

```powershell
$env:VIVI_TEST_CONPTY_REPOSITORY = 'C:\path\cli-windows-input-baseline'
$env:VIVI_TEST_CONPTY_EXPECT = 'legacy'
node --test C:\path\candidate\test\windows-conpty-native.test.mjs
$env:VIVI_TEST_CONPTY_REPOSITORY = 'C:\path\candidate'
$env:VIVI_TEST_CONPTY_EXPECT = 'fixed'
node --test C:\path\candidate\test\windows-conpty-native.test.mjs
```

Both checkouts need their unchanged installed dependencies. `VIVI_TEST_BUN` may select an absolute Bun executable. The wrapper reports the observed Bun, OS and system conhost versions. It never downloads a runtime. For existing Windows CI, add the native test to the explicit Node test invocation or run it as a separate step after dependency setup. The existing Bun/Node pins do not need changes.

Cross-platform fixture checks, independently labelled synthetic:

```sh
bun test test/windows-conpty-fixture.test.ts
```

## What runs

- Real Kernel32 CreatePseudoConsole and CreateProcessW, with pointer-sized HANDLE/HPCON values represented by IntPtr
- A private real Bun child calling the production `OpenTuiIO.create({ stream: false })` and `diagnoseInput()` source route, including native renderer output setup before bridge.start and the renderer's real Bun stdin raw mode
- An outer terminal simulator already in 9001 mode. It answers the forwarded child DECRQM with status 1 using specified Win32 Unicode-character records; the OS ConPTY must consume and regenerate input
- Only known synthetic Enter, Shift+Enter, Ctrl+J, repeat-count/held-key/release probes, bracketed paste containing CR, LF and Unicode, and Escape-down. Nothing reads or injects physical keys, a clipboard, a desktop window, or the user's current terminal
- After production close, one fresh raw reader receives one synthetic Shift+Enter. Raw CR with zero Enter input records verifies the inner encoder reset. Raw/flow restoration is separately sampled immediately inside production bridge.close, before fixture cleanup can mask a defect
- The outer host counts only an actual 9001l followed by 9001h pair as restoration. It waits for that pair instead of using a timing guess

Fixed expectations: modeReply=1, enableRequested=true, exact eight native diagnostic probes with retained modifiers/repeat identity, at least nine Enter records, one exact opaque paste, zero key-up/editor actions, consumer disable once, inner reset, outer transport reassertion, original raw/flow restoration, drained output and joined teardown.

Legacy expectations: modeReply=1, enableRequested=false, zero Enter records, Enter and Shift+Enter both raw/unshifted, Ctrl+J as raw linefeed. The known paste and cleanup checks still apply. A legacy run is useful only if this actual transport failure is observed.

## Bounds and privacy

The test uses a fresh temporary directory and removes it in finally. The child saves only allowlisted diagnostic/protocol metadata and booleans describing the known paste. Input text/bytes, environment, paths and full exceptions are not saved. Native rendering is continuously drained and discarded apart from short allowlisted control-sequence counters.

The child has an 18-second watchdog, the supervisor a 45-second deadline, finite phase waits, bounded input queue/output budget and bounded close/worker joins. An unnamed kill-on-job-close object contains only the suspended-then-resumed private Bun child and descendants. Thus killing the private supervisor closes that job and terminates the child. Pipes, attributes, process/thread/job handles and HPCON are owned by the host and closed; ClosePseudoConsole remains concurrently drained. Teardown success requires the child to stop and both I/O workers to join. Output-drained success requires an actual broken-pipe observation, rather than merely a return from ClosePseudoConsole.

The supervisor passes a small OS environment allowlist and runs Bun with `--no-env-file --no-install`, so repository .env files and automatic package fetches are excluded. Raw-capture flags are rejected in the child. No user credentials, provider requests, session saves, publication, or remote data transmission are involved.

The supervisor explicitly supplies null standard handles with `STARTF_USESTDHANDLES`. Windows otherwise duplicates a redirected parent's pipe handles even when ordinary handle inheritance is disabled, bypassing the attached ConPTY. The child must independently report genuine stdin/stdout TTYs; that guard is never forged or skipped. See the [Microsoft Terminal maintainer's explanation](https://github.com/microsoft/terminal/discussions/15814).

## Limits

This uses the runner's OS Kernel32/ConPTY backend, not necessarily Windows Terminal 1.24's packaged OpenConsole/ConPTY build. It emulates an outer terminal and does not test physical Windows Terminal keys, its forceVT preference, actual terminal focus, IME/layout mappings, account integration, or visual presentation. C#/PowerShell compilation and actual mode forwarding on that OS must succeed before calling it real Windows evidence. Old or different ConPTY implementations may fail the required transport assertions; do not convert that failure into a successful skip.

The exact native paste assertion is an important gate: source review identifies a CR/LF re-encoding path after inner 9001 enable. The bridge therefore decodes native character records inside paste only while it owns consumer reporting, preserving literal characters instead of generating key actions. A passing pure-parser fixture does not resolve the actual transport question. Keep the native assertion strict if the first Windows run fails.

The restoration claim is the standard topology of inner consumer disabled and outer Win32 transport enabled. DECRQM cannot prove an unknown inherited inner mode, so this does not claim exact preservation of every possible inherited state.

## Primary implementation references

- [Microsoft CreatePseudoConsole](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole)
- [Microsoft pseudoconsole creation/lifetime guidance](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)
- [Microsoft ClosePseudoConsole](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole)
- [Microsoft CancelSynchronousIo](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelsynchronousio)
- [Microsoft job object lifetime](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Microsoft Win32 input-mode protocol specification](https://github.com/microsoft/terminal/blob/v1.24.12741.0/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md)
- [Exact 1.24 inner mode/reset and outer reassertion](https://github.com/microsoft/terminal/blob/v1.24.12741.0/src/terminal/adapter/adaptDispatch.cpp#L1922-L1933)
- [Exact 1.24 forwarded output/injections](https://github.com/microsoft/terminal/blob/v1.24.12741.0/src/host/_stream.cpp#L335-L386)
- [Bun module resolution](https://bun.sh/docs/runtime/utils#bun-resolvesync)
- [Bun environment-file control](https://bun.sh/docs/runtime/environment-variables)
