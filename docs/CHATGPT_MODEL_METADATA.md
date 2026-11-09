# Reviewed ChatGPT model metadata

Reviewed on 2026-11-08. This is a local metadata policy, not an account entitlement
list or a verified service limit. No account credentials or live inference requests
were used to validate it.

## Availability and route

The [official Sign in with ChatGPT guide](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
requires discovery from `https://api.openai.com/v1/models` using the selected
account's OAuth access token. Vivi preserves the visible slugs, account labels and
server ordering. Reviewed metadata never inserts a missing model, exposes a hidden
entry, or provides a fallback when discovery fails. Requests still use the public
Responses endpoint with `store: false` and `stream: true`.

The exact reviewed slugs are the intersection of the visible entries in the
[pinned official Codex catalog](https://github.com/openai/codex/blob/c9b4267c370a755da12ec1c8648c2451163212b7/codex-rs/models-manager/models.json)
and the explicit entries in the
[pinned pi subscription catalog](https://github.com/earendil-works/pi/blob/6e2222a8dda06e3d69fad46d630f152f5873567a/packages/ai/catalog/providers/openai-codex.ts).
Those clients use a different ChatGPT backend; their catalogs are supporting
evidence for this intentionally small reviewed subset, not proof of compatibility
or capacity for Vivi's public token-sharing route. No private backend, client ID,
authentication or account-policy behavior is imported from either client.

## Reasoning and capabilities

Each model's official Responses documentation supports `low`, `medium`, `high`,
`xhigh` and `max`. Those are also ordinary effort choices in the reviewed Codex
catalog. Vivi offers this overlap only. Provider default sends no effort override
and does not copy another client's default effort.

- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [GPT-6.1 Terra](https://developers.openai.com/api/docs/models/gpt-6.1-terra)
- [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
- [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

`none` is not in the reviewed subscription catalog's choices. Although several API
model pages allow it, disabling reasoning remains unverified on this route and is
not offered. Only Astra and 6.1 Sol's model documentation establishes required
reasoning; the other six retain an unknown requirement. `ultra` in Codex entails
automatic task delegation and is not implemented by Vivi's subscription adapter.
Vivi assumes function-tool support for every model returned by the selected
ChatGPT subscription account's visible catalog, including new slugs. Selecting a
model enables host tools without an additional capability confirmation. Explicit
tools-off choices and host approval policies still apply. This is a local policy
assumption, not a verified account entitlement. Vision remains unknown on this
route. Account/workspace policy can still reject tools or a documented effort.

Beyond function-tool support, aliases, future models and other slugs keep unknown
metadata. For example, the bundled Codex catalog includes `gpt-5.5`, while pi explicitly excludes it because
its ChatGPT backend rejected it. That is not proof that the public token-sharing
route rejects it. If an account lists it, Vivi still shows it conservatively rather
than claiming reviewed support or hiding it.

## Intentional local context budgets

Vivi chooses the following total input-plus-output working budgets:

| Exact model | Local budget | Reviewed basis before local headroom |
| --- | ---: | --- |
| gpt-6.1-sol | 475,000 | 500,000, official model page and pi |
| gpt-6.1-terra | 475,000 | 500,000, Codex and pi |
| gpt-6-astra | 258,400 | 272,000, Codex and pi |
| gpt-6-sol | 258,400 | 272,000, Codex and pi |
| gpt-6-luna | 258,400 | 272,000, Codex and pi |
| gpt-5.6-sol | 258,400 | 272,000, Codex and pi |
| gpt-5.6-terra | 258,400 | 272,000, Codex and pi |
| gpt-5.6-luna | 258,400 | 272,000, Codex and pi |

These are intentionally conservative local policy values: 95% of the reviewed
default, inspired by [Codex's usable-window calculation](https://github.com/openai/codex/blob/c9b4267c370a755da12ec1c8648c2451163212b7/codex-rs/protocol/src/openai_models.rs#L568-L589).
They are not measured maxima, account quotas, advertised capacities, or a promise
that a request of that size will succeed. The pinned Codex bundled catalog still
lists 272,000 for 6.1 Sol; its official model page explicitly documents a 500K
Codex/Work default, consistent with pi. Vivi retains its existing 475K policy.

Apply this 95% choice once. Vivi does not import pi's `maxTokens: 128000`, treat it
as a reserved output allowance, or take a second 5% from pi's context value. Its
own output reserve and compaction policy then operate **inside** the chosen budget:

- With the default 4,096-token output reserve, input has 470,904 tokens in a 475K
  budget or 254,304 tokens in a 258,400 budget.
- Vivi normally compacts above 85% of that available input: 400,269 or 216,159
  input tokens respectively. This is deliberately earlier than the local ceiling.
- Codex's separate 90%-of-raw-window compaction policy is not copied.

This layering deliberately leaves local safety headroom; it is not a calculation
of the service's remaining space. The API model pages' 1,050,000-token capacity,
Codex's `max_context_window` configuration-override ceiling, and pi's output limit
are not imported as subscription capacities. `/context` keeps capacity unknown
and labels the working budget, its provenance and the separate output reserve.
No context-window, budget or `max_output_tokens` parameter is sent on this route.

Automated fixtures verify exact matching, account visibility/order, detached
metadata, effort selection, request projection, budget labels, output reserves
and compaction thresholds. They do not establish live account acceptance.
