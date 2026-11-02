# Structured automation (protocol v1)

Use the existing single-turn CLI from CI or another program:

```sh
vivi --jsonl --model MODEL --prompt "Summarize the repository" >events.jsonl 2>diagnostics.log
vivi --jsonl --model MODEL --prompt "Return the repository status" --output-schema answer.schema.json
```

Provide the selected provider's normal environment credential, or an already configured explicit ChatGPT account. This surface does not sign in, enroll unattended permissions, or connect MCP servers. Node >=26.4 is sufficient; Bun and a TTY are not required. The feature does not publish or install a new CLI release by itself.

`--jsonl` requires a nonempty `--prompt`. `--output-schema` requires `--jsonl`. Do not combine JSONL with `--help`, `--tui`, nonmanual `--approval-mode`, auth/MCP management subcommands, or `--diagnose-input`. Invalid combinations fail before session, catalog or provider work. Existing plain `--prompt`, line mode and TUI behavior are unchanged.

The prompt is **literal model input** in JSONL mode. `/compact`, `/mcp`, `/processes`, `!command` and other interactive shortcuts do not execute CLI management commands. Resume uses `--resume ID --prompt TEXT`; it retains the selected session's provider/model. Pending launch-owned steering input is never replayed by automation. A turn may use the ordinary safe read tools. Human approval requests are denied, questions are unavailable, and Auto/Skip cannot enroll even if stdin/stdout happen to be terminals. This is not an OS sandbox.

## Consumer contract

Stdout contains UTF-8 newline-delimited JSON objects only. Stderr contains bounded, known-secret-redacted notices and diagnostics; drain **both** streams. There are no terminal escape/status sequences, banners, raw provider frames, or human prompts on stdout. Runtime/launcher/module-bootstrap failures may occur before any protocol bytes exist.

Every record contains:

- `protocol: "vivi.automation"` and `version: 1`.
- `run_id`: opaque UUID for this invocation, not a credential or session ID.
- `seq`: monotonically increasing integer starting at 1.
- `type`: the event discriminator below.

The installed [event schema](automation-v1.schema.json) describes each record. TypeScript types `AutomationEvent`, `AutomationPayload`, `AutomationExitCode` and constants `AUTOMATION_PROTOCOL`, `AUTOMATION_VERSION` are exported from the CLI package. This is a CLI protocol, not a promise that internal `ChatIO` or core events are stable SDK APIs.

Version 1 records:

- `run.started`: emitted before CLI/schema validation after successful runtime bootstrap.
- `session.started`: `session_id`, redacted `provider`, `model`, after session initialization. Use the ID for explicit resume. No prompt, history, cwd, account registration or credentials are included.
- `assistant.completed`: accepted assistant round, `round`, `tool_call_count`, and `text`. In schema mode **text is omitted** until validated terminal success. Accepted does not mean the whole invocation succeeded.
- `tool.started`: `call_id`, `name`. Arguments are deliberately omitted.
- `tool.completed`: `call_id`, `name`, `is_error`. Tool result text, images and provider state are deliberately omitted. A completion event is not proof of a successful external effect.
- `round.completed`: `round` and reported `usage`, or `null` when missing.
- `context.compaction.started`, `.completed`, `.failed`: reason and bounded completion measurements or failure code. These are lifecycle metadata, not summary contents.
- `approval.denied`: `reason: "interaction_required"` when an actual human-approval callback is reached. It denies immediately. Tool paths that reject an unavailable command/question/MCP surface before asking approval remain ordinary tool errors; an agent may handle them.
- `run.completed`: terminal success, `exit_code: 0`, `final_text`, optional `structured_output`, `rounds`, `usage` and an available `session_id`.
- `run.failed`: terminal failure, `exit_code`, stable `code`, safe generic `message`, available session and round/usage metadata.
- `run.cancelled`: terminal cancellation, `exit_code` 130/143 and `reason` SIGINT/SIGTERM.

There is at most one terminal record, and on a healthy output stream it is emitted **after** provider/host work, owned-process/MCP cleanup and writer-lease release settle. Cleanup failure overrides an otherwise successful answer. A session lock may intentionally remain when process cleanup is uncertain.

A consumer must require **both `run.completed` and process exit 0**. EOF without a terminal record means incomplete/unknown outcome. A process killed by the OS, a broken pipe, a partial final write or failed bootstrap cannot guarantee a terminal record. Do not infer success from accepted assistant or tool events. A completed agent turn does not prove its semantic task was accomplished; inspect its answer and tool-error events.

There are no provisional text-delta events in v1. Complete accepted messages and lifecycle events still arrive incrementally. This avoids confusing transient provider text with durable accepted output and prevents split-chunk known-secret leaks. Never treat protocol text or tool names as terminal commands or HTML without escaping.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Agent completed and requested final schema validation passed; cleanup completed. |
| 1 | Runtime/provider/context/storage/cleanup failure. Core codes such as `max_rounds` are preserved as failure codes; cleanup uses `cleanup_failed`. |
| 2 | Invalid CLI arguments or schema/configuration preflight (`invalid_configuration`). No provider/session work started. |
| 3 | Final `invalid_json`, `schema_mismatch`, `output_redacted`, or `output_too_large`. |
| 4 | An actual interactive approval callback was requested and denied (`interaction_required`). |
| 74 | Output failed, closed, exceeded its record/queue bound, or stopped acknowledging writes. A terminal event may be absent. |
| 130 | SIGINT/cancellation. |
| 143 | SIGTERM. |

Output failure takes priority. Genuine runtime/cleanup failures take priority over cancellation; an expected AbortError from this invocation's own cancellation does not become runtime failure. Cancellation takes priority over approval/schema outcomes. The first SIGINT/SIGTERM wins; repeated signals do not force an unsafe immediate exit. Uncatchable termination is outside these guarantees. Existing non-JSONL exit behavior is not changed.

`usage.reported` sums reported committed response-round counts, not a billing guarantee. `usage.complete` is true only when every committed response round supplied usage. Missing round usage is `null`; zero aggregates with `complete:false` do not mean zero tokens/cost. Optional cache fields remain omitted when unknown. Context-summary usage is not included in this turn's reported response-round total, so this is not total provider billing.

## Optional final-answer schema

Example `answer.schema.json`:

```json
{
  "type": "object",
  "properties": {
    "summary": { "type": "string" },
    "status": { "type": "string", "enum": ["ok", "action_required"] }
  },
  "required": ["summary", "status"],
  "additionalProperties": false
}
```

The schema is sent to the selected provider in an ephemeral instruction for ordinary response requests. The canonical saved user prompt is not rewritten, and context-summary generation does not receive this instruction. Core's context-estimate API has no summary-purpose field, so estimates conservatively include the schema even for possible summaries. Provider-neutral prompting plus strict local validation is **not provider-native constrained decoding**. Providers can produce invalid JSON; this then fails with exit 3. There is no extra paid repair/retry turn beyond the normal configured agent loop.

The final answer must be exactly one JSON value, with no Markdown fences or trailing text. The exact decoded value is validated without type coercion, default insertion, property removal or repairs. On success, `structured_output` is that parsed value. If known-secret filtering would alter decoded keys or values, the structured answer is withheld and fails, rather than emitting an altered value that no longer satisfies the schema. Invalid schema-mode assistant text is never emitted ahead of validation.

This version supports a **bounded structural subset** of JSON Schema draft 2020-12, using pinned Ajv 8.17.1:

- Boolean schemas; `type`, `properties`, `required`, `additionalProperties`, `items`, `prefixItems`.
- `minItems`, `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`.
- `enum`, `const`, `anyOf`, `allOf`, `oneOf`, `not`.
- `title`, `description`, `default`, `examples` are annotations only.
- `$defs`, fragment-only acyclic same-document `$ref`, and optional `$schema` exactly `https://json-schema.org/draft/2020-12/schema`.

Unsupported keywords fail before provider calls, not silently ignored. `$id`, remote refs, recursive/dynamic refs, `pattern`, `patternProperties`, `format`, `unevaluated*` and custom keywords are unsupported. No schema-directed network fetches or custom code are loaded.

Preflight accepts a local regular UTF-8 JSON file up to 64 KiB; JSON depth32; 256 schema nodes; 16 branches per combinator; 16 reference hops; 2048 expanded visits counting referenced subtrees for each use. Invalid/refused/complex/unsupported schemas exit2 with a generic message; file paths and compiler details are not copied into protocol errors. Schemas are screened against known secrets at load and again before each estimate/generation after dynamic credentials are registered. Do not put credentials or confidential information in schema descriptions unless you intend to send that data to your selected provider.

Final answers are bounded to256 KiB UTF-8 and decoded JSON depth128. Encoded records and pending writes are bounded to4 MiB. A writable that fails to acknowledge a pending write within30 seconds is treated as failed output; owned work is cancelled and pending writes are rejected so normal cleanup can proceed. No timeout falsely marks uncertain process cleanup as successful. Diagnostics are bounded separately to256 KiB per invocation. These limits are part of protocol v1; oversized content is not silently clipped into a successful machine answer.

## Privacy and testing limits

Known environment credentials and dynamically registered selected credentials are filtered. This cannot discover arbitrary unknown secrets in model output or retract a record emitted before a value was registered as secret. Raw history, opaque provider state, reasoning, tool arguments/results and image bytes are not part of the wire contract. Session persistence continues under the existing session policy; JSONL is not a no-storage mode.

Coverage is offline and deterministic: fake providers, isolated profiles, protocol/schema validation, ordinary permission denials, cancellation, cleanup, output backpressure/failure, and installed-package consumers. Live provider billing, OAuth/vault flows and physical terminal acceptance are separate checks, not implied by these tests.
