# Terminal program status (OSC 7501)

## Placement decision

Implement in **vivi-cli**, not vivi core. Core 0.17.0's `AgentEvent`/`AgentResult`
provide provider/tool progress and completed/cancelled/error outcomes, but core
cannot know whether a human dialog is actually visible, whether output is a TTY,
or when a native renderer has restored the terminal. Its desktop/server/embedded
consumers must not acquire terminal output side effects.

CLI `sendChatTurn` and `compactChatContext` already bracket the entire host operation,
including persistence/drain, with `ChatIO.runStarted`/`runFinished`. CLI approval and
question surfaces distinguish a queued request from an actual user wait. The new
small `terminal-program-status.ts` module shares a pure lifecycle adapter and guarded
writer between `TerminalIO` and `OpenTuiIO`; it does not change core or its version.
The optional `continuing` finish argument suppresses task-completion reports during
immediate queued continuation, while preserving existing per-turn visual outcomes.

## Wire contract and sources

- [OSC 7501 specification, revision 0.4](https://www.superlogical.com/rex/docs/build/program-status)
- [Herdr root-state consumer](https://github.com/herdrdev/herdr-core/blob/277f6a61348f67d76a4a60943009a4de2d01642e/crates/herdr-core/src/status.rs)
- [Herdr parser tests](https://github.com/herdrdev/herdr-core/blob/277f6a61348f67d76a4a60943009a4de2d01642e/crates/ghostty-vt/src/tests.rs)
- [Codex reference implementation](https://github.com/openai/codex/blob/cb1bc0ae4ed996c67a6e118bf79a7435f0d3f0d2/codex-rs/tui/src/terminal_program_status.rs)

Each root report is `ESC ] 7501 ; state=STATE:app=vivi-cli ESC \\` with no spaces.
A blocked report adds `:kind=permission`, `:kind=question` or `:kind=auth`.
Clear is `ESC ] 7501 ; state=clear ESC \\`. Records replace rather than patch;
the application name is repeated, and no id/msg/progress/unknown extensions are sent.
Only fixed enum values cross this boundary (including runtime validation for JS callers).

| Local event | Report |
| --- | --- |
| IO startup | idle |
| Real turn / user shell / manual compaction starts | working |
| Tool execution, provider retries, streaming, automatic review | remain working |
| Visible approval | blocked, permission |
| Visible question or setup/manager input | blocked, question |
| Visible hidden credential input | blocked, auth |
| Dialog resolves or aborts | prior lifecycle state (working if still running) |
| Queued dialog not yet visible | no change |
| Host cancellation requested but still draining | remain working |
| Completed turn, no immediate continuation | done |
| Cancelled turn settled | idle |
| Failed turn settled | error |
| Idle composer/redraw after done/error | retain done/error |
| Interactive native cleanup/line close | clear once |
| One-shot close after done/error (line or explicit `--prompt --tui`) | retain terminal outcome |
| One-shot close before a final outcome | clear |

Background tools do not create separate child-agent records. No status is inferred
from tool names, generated text, transcript errors, or cancel-listener counts.
The CLI does not introduce shell handoff or job-control support as part of this feature.

## Output safety and ownership

No bytes on non-TTY output, help, `TERM=dumb`, `VIVI_OSC7501=0|false|off`, or known
`VTE_VERSION < 5400`. Detection is optional in the spec; no probing or stdin parsing.
The same ANSI bytes are used on Windows. No tmux/screen bypass wrapping is emitted.
Consumers may choose not to forward OSC across multiplexers. Direct Herdr pane
consumption is the compatibility target; consumer process-exit cleanup may clear even
a retained one-shot outcome.

Both controller and writer deduplicate. A backpressured writer retains only the
latest pending fixed-size record, replacing obsolete transitions; shutdown appends
at most one final record and never hangs waiting for drain. Optional write failures
disable status output without failing the run. Interactive cleanup follows native
terminal restoration, including destruction deferred during a render and synchronous
process exit. Late callbacks cannot resurrect a closed report.

## Verification boundary

Offline tests cover exact frames, all states/kinds, injection rejection, deduplication,
TTY/opt-out/VTE gating, errors, backpressure, line approvals, native modal waits,
queued continuation, sticky outcomes, cancellation and teardown. Linux PTY tests
exercise the real Bun/OpenTUI factory, including deferred destruction and exit during
render. Existing ordinary package/native checks remain applicable. They do not prove
real Windows/macOS terminals, actual Herdr UI, live model/auth flows, or multiplexer
forwarding. No claim of such verification is made.
