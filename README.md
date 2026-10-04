# vivi CLI

Chat with OpenAI or OpenRouter from your terminal.

## Run from source

Requires Node.js 22+ and [Bun](https://bun.sh) 1.3+ for the full-screen interface.
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
- `/session` — show the current session ID
- `/help` — show commands and shortcuts
- `/exit` — quit

Changing provider, model or effort starts a new conversation and keeps the old
transcript available through `/resume`.

Enter sends; Shift+Enter or Alt+Enter adds a line. Tab completes slash commands.
Escape or Ctrl+C cancels a running turn; Ctrl+C while idle exits.

Keys can be saved in an available OS credential store or used for this launch only.
There is no plaintext key-storage fallback. Conversations are stored locally in
`~/.vivi/sessions`; keep secrets out of chat and command arguments.

## Line mode

Node.js 22+ supports line mode without Bun. Set `OPENAI_API_KEY` or
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
