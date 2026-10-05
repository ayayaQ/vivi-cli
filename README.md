# vivi CLI

Chat with OpenAI or OpenRouter from your terminal.

## Run from source

Requires Node.js 26.4+ and [Bun](https://bun.sh) 1.3+ for the full-screen interface.
The CLI is not yet published to npm.

```sh
git clone https://github.com/ayayaQ/vivi-cli.git
cd vivi-cli
npm ci --ignore-scripts
npm run build
bun dist/launcher.js
```

## Usage

Each launch starts a fresh conversation. Use `/provider` to set up your API key,
then choose a model.

- `/provider` — choose OpenAI or OpenRouter and enter a key
- `/models` — search and select a model
- `/effort` — choose a supported reasoning effort
- `/new` — start a fresh conversation
- `/resume` — continue a saved conversation
- `/settings` — change defaults for future conversations
- `/session` — show the current session ID and saved usage
- `/help` — show commands and shortcuts
- `/exit` — quit

Changing provider, model or effort starts a new conversation and keeps the old
transcript available through `/resume`.

Enter sends; Shift+Enter or Alt+Enter adds a line. Tab completes slash commands.
Escape or Ctrl+C cancels a running turn; Ctrl+C while idle exits.
In `/models`, type to filter by ID, name or provider; words can be in any order.
Use arrows or Page Up/Down to browse, Enter to select, Ctrl+U to clear,
Ctrl+R to refresh the catalog, and Escape to go back.

Model capabilities use the shared endpoint-aware normalizer with the CLI's existing
documented OpenAI Responses facts. OpenRouter metadata describes its Chat Completions
gateway. Unknown models remain unverified; catalog visibility does not prove a request
will succeed. Provider default sends no reasoning override. The explicit disable choice
is offered only when supported, including optional OpenRouter token-budget models that
have no named effort choices. A documented non-streaming model uses complete responses;
unknown streaming keeps your selected stream setting.

Keys can be saved in an available OS credential store or used for this launch only.
There is no plaintext key-storage fallback. Conversations are stored locally in
`~/.vivi/sessions`; keep secrets out of chat and command arguments.

## Line mode

Node.js 26.4+ supports line mode without Bun. Set `OPENAI_API_KEY` or
`OPENROUTER_API_KEY` in your environment, then supply a model ID:

```sh
node dist/launcher.js --no-tui --provider openai --model YOUR_MODEL
node dist/launcher.js --provider openrouter --model PROVIDER/MODEL --prompt 'Hello'
```

Use `node dist/launcher.js --help` for all options, including `--resume UUID` and
`--session-dir PATH`.

## Development

```sh
npm run check
npm run test:tui
```

See [RELEASING.md](RELEASING.md) for packaging and release checks.
Licensed under [Apache-2.0](LICENSE).

## Usage counts

Round and turn displays show provider-reported token counts. `/session` shows the
saved session aggregate. Cache read/write counts are input-token subsets already
included in input and total counts. A missing cache count is shown as `unreported`,
while an explicitly reported zero is shown as `0`. Each session cache count is
complete only if every accepted provider round reported that field. Old sessions
keep missing metrics unreported; no cache policy, price or savings is inferred.
