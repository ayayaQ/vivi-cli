#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter'
import type { ReasoningEffort, ReasoningSelection } from '@ayayaq/vivi/providers/openrouter'
import type { ModelProvider } from '@ayayaq/vivi'
import { CliHost } from './host.js'
import { FileSessionStore, environmentSecrets, isSessionId, newSession, redactSecrets } from './session.js'
import type { CliProviderName, CliSession } from './session.js'
import { TerminalIO, runChatLoop } from './terminal.js'
import type { ChatIO } from './terminal.js'

export interface CliOptions {
  provider?: CliProviderName
  model?: string
  reasoning?: string
  reasoningCapabilities: ReasoningEffort[]
  resume?: string
  sessionDirectory: string
  stream: boolean
  tui: boolean
  enableNotes: boolean
  maxRounds: number
  prompt?: string
  help: boolean
}
export const HELP = `vivi - a thin shared-agent CLI

Usage: vivi --provider openai|openrouter --model MODEL [options]
       vivi --resume SESSION_ID [options]

  --provider NAME             openai (default) or openrouter
  --model MODEL               Required for a new session
  --reasoning LEVEL           default, disabled/none, minimal, low, medium, high, xhigh, max
  --reasoning-capabilities CSV Host-declared supported efforts; needed for nondefault reasoning
  --new                       Start a new session (the default)
  --resume UUID               Resume a local session with its original provider/model
  --session-dir PATH          Private session directory (default ~/.vivi/sessions)
  --prompt TEXT               Run one turn and exit
  --no-stream                 Display accepted complete messages only
  --tui / --no-tui            Terminal UI (default on a TTY)
  --enable-notes              Enable session-only revisioned notes with allow/deny prompts
  --max-rounds NUMBER         Bounded provider rounds, 1..100 (default 25)
  --help                      Show this help

Credentials: OPENAI_API_KEY or OPENROUTER_API_KEY environment variables only.
Ctrl-C or Escape cancels an active turn; /exit quits; /session prints its id.
Streaming is display-only. Notes never access other files; piped approval is denied.
`
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export function parseArguments(args: readonly string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  const options: CliOptions = {
    reasoningCapabilities: [], sessionDirectory: env.VIVI_SESSION_DIR ?? join(homedir(), '.vivi', 'sessions'),
    stream: true, tui: true, enableNotes: false, maxRounds: 25, help: false
  }
  let explicitlyNew = false
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    const value = (): string => {
      const next = args[++index]
      if (next === undefined || next.startsWith('--') || next.length === 0) throw new Error('Missing option value; use --help')
      return next
    }
    switch (argument) {
      case '--help': case '-h': options.help = true; break
      case '--provider': {
        const name = value()
        if (name !== 'openai' && name !== 'openrouter') throw new Error('Provider must be openai or openrouter')
        options.provider = name
        break
      }
      case '--model': options.model = value(); break
      case '--reasoning': {
        const level = value()
        options.reasoning = level === 'disabled' ? 'none' : level
        break
      }
      case '--reasoning-capabilities': {
        const values = value().split(',')
        if (!values.every((effort) => efforts.includes(effort as ReasoningEffort))) throw new Error('Invalid reasoning capabilities')
        options.reasoningCapabilities = [...new Set(values)] as ReasoningEffort[]
        break
      }
      case '--resume': options.resume = value(); break
      case '--session-dir': options.sessionDirectory = value(); break
      case '--prompt': options.prompt = value(); break
      case '--new': explicitlyNew = true; break
      case '--no-stream': options.stream = false; break
      case '--tui': options.tui = true; break
      case '--no-tui': options.tui = false; break
      case '--enable-notes': options.enableNotes = true; break
      case '--max-rounds': {
        const count = Number(value())
        if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error('max-rounds must be an integer from 1 to 100')
        options.maxRounds = count
        break
      }
      default: throw new Error('Unknown argument; credentials are accepted only through environment variables. Use --help')
    }
  }
  if (options.help) return options
  if (options.resume && (!isSessionId(options.resume) || explicitlyNew)) throw new Error('Use a valid session UUID and either new or resume')
  if (options.resume && (options.provider !== undefined || options.model !== undefined || options.reasoning !== undefined)) {
    throw new Error('Resumed sessions retain their provider, model and reasoning; omit selection flags')
  }
  if (!options.resume && (!options.model || options.model.length > 200 || options.model.trim() !== options.model)) {
    throw new Error('A new session requires --model with a bounded model identifier')
  }
  if (options.reasoning !== undefined && options.reasoning !== 'default' &&
    !efforts.includes(options.reasoning as ReasoningEffort)) throw new Error('Invalid reasoning level')
  if (options.reasoning && options.reasoning !== 'default' &&
    !options.reasoningCapabilities.includes(options.reasoning as ReasoningEffort)) {
    throw new Error('Selected reasoning requires explicit --reasoning-capabilities from your model’s supported efforts')
  }
  // Never echo a rejected value. Credential-bearing flags are refused before provider construction.
  const secrets = environmentSecrets(env)
  for (const argument of args) {
    if (secrets.some((secret) => argument.includes(secret))) throw new Error('CLI arguments must not contain environment credentials')
  }
  return options
}

export function reasoningPolicy(level?: string): ReasoningSelection {
  if (level === undefined || level === 'default') return { mode: 'default' }
  if (level === 'none' || level === 'disabled') return { mode: 'disabled' }
  if (!efforts.includes(level as ReasoningEffort)) throw new Error('Invalid reasoning level')
  return { mode: 'effort', effort: level as Exclude<ReasoningEffort, 'none'> }
}

export function providerForSession(session: CliSession, options: CliOptions, env: NodeJS.ProcessEnv): ModelProvider {
  const apiKey = session.provider === 'openai' ? env.OPENAI_API_KEY : env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error(session.provider === 'openai' ? 'Set OPENAI_API_KEY in your environment' : 'Set OPENROUTER_API_KEY in your environment')
  const common = { model: session.model, apiKey, reasoning: reasoningPolicy(session.reasoning),
    supportedReasoningEfforts: options.reasoningCapabilities, stream: options.stream }
  return session.provider === 'openai' ? createOpenAIProvider(common) : createOpenRouterProvider(common)
}

/** Injection avoids provider calls and real terminal use in tests; importing this module does nothing. */
export async function main(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env,
  dependencies: { io?: ChatIO; providerFactory?: typeof providerForSession } = {}): Promise<number> {
  let io: ChatIO | undefined
  let release: (() => Promise<void>) | undefined
  const secrets = environmentSecrets(env)
  try {
    const options = parseArguments(args, env)
    io = dependencies.io ?? new TerminalIO({ stream: options.stream, tui: options.tui, secrets })
    if (options.help) { io.write(HELP); return 0 }
    const store = new FileSessionStore(options.sessionDirectory, secrets)
    const fresh = options.resume ? undefined : newSession({
      provider: options.provider ?? 'openai', model: options.model!,
      ...(options.reasoning ? { reasoning: options.reasoning } : {})
    })
    release = await store.acquire(options.resume ?? fresh!.id)
    const session = options.resume ? await store.load(options.resume) : fresh!
    const provider = (dependencies.providerFactory ?? providerForSession)(session, options, env)
    const host = new CliHost({ provider, store, session, secrets, enableNotes: options.enableNotes,
      maxRounds: options.maxRounds, approve: (request, signal) => io!.approve(request, signal),
      onEvent: (event) => io!.event(event) })
    await store.save(host.session)
    io.write(`Session: ${session.id}\nProvider: ${session.provider} | Model: ${session.model}\n`)
    const result = await runChatLoop(host, io, options.prompt)
    return result?.status === 'error' ? 1 : result?.status === 'cancelled' ? 130 : 0
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : 'CLI failed', secrets)
    if (io) io.write(`${message}\n`)
    else process.stderr.write(`${message}\n`)
    return 1
  } finally {
    await release?.().catch(() => undefined)
    io?.close()
  }
}

let isEntryPoint = false
try { isEntryPoint = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) }
catch { /* Importing the testable module does not require a real executable path. */ }
if (isEntryPoint) {
  void main().then((status) => { process.exitCode = status })
}
