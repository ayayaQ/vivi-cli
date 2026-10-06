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
import { FileMemoryStore } from './memory.js'
import { ReadOnlyWorkspace } from './workspace.js'
import { FileSessionStore, environmentSecrets, isSessionId, newSession, redactSecrets } from './session.js'
import type { CliProviderName, CliSession } from './session.js'
import { TerminalIO, runChatLoop } from './terminal.js'
import type { ChatIO } from './terminal.js'
import type { InteractiveIO } from './application.js'
import type { Catalog } from './models.js'
import { documentedOpenAIModel } from './models.js'
import type { CredentialStore } from './credentials.js'

export interface CliOptions {
  provider?: CliProviderName
  model?: string
  reasoning?: string
  reasoningCapabilities: ReasoningEffort[]
  resume?: string
  sessionDirectory: string
  workspace?: string
  stream: boolean
  tui: boolean
  enableNotes: boolean
  enableMemory: boolean
  enableTools: boolean
  startNew: boolean
  maxRounds: number
  prompt?: string
  help: boolean
}
export const HELP = `vivi - a shared-agent terminal application

Usage: vivi --provider openai|openrouter --model MODEL [options]
       vivi --resume SESSION_ID [options]
       vivi                       Interactive setup and saved defaults (Bun)

  --provider NAME             openai (default) or openrouter
  --model MODEL               Required for a new session
  --reasoning LEVEL           default, disabled/none, minimal, low, medium, high, xhigh, max
  --reasoning-capabilities CSV Host-declared supported efforts; needed for nondefault reasoning
  --new                       Start a new session (the default)
  --resume UUID               Resume a local session with its original provider/model
  --session-dir PATH          Private session directory (default ~/.vivi/sessions)
  --workspace PATH            Opt in to read-only files in one folder for this launch
  --prompt TEXT               Run one turn and exit
  --no-stream                 Display accepted complete messages only
  --tui / --no-tui            OpenTUI full-screen / accessible line mode
  --tools / --no-tools        Declare tool support / use chat only
  --enable-notes              Enable session-only revisioned notes with allow/deny prompts
  --enable-memory             Use reviewed app-wide saved context (plaintext local storage)
  --disable-memory            Override saved memory defaults for this launch
  --max-rounds NUMBER         Bounded provider rounds, 1..100 (default 25)
  --help                      Show this help

Credentials: environment variables, or masked /provider setup in the full-screen UI.
Full-screen UI requires Bun >=1.3.0; Node >=26.4 supports line/piped mode.
Ctrl-C or Escape cancels an active turn; /exit quits; /session prints its id and usage.
Streaming is display-only. Notes never access other files; piped approval is denied.
Saved memory is off by default. When enabled, it is sent to the selected provider.
Workspace reads are off by default. Selected files may be sent to your provider and saved in session history.
Workspace tools omit symlinks, private/ignored files, writes and commands; this is not an OS sandbox.
/memories lists, adds, edits, deletes, enables or disables saved memory.
`
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export function parseArguments(args: readonly string[], env: NodeJS.ProcessEnv = process.env,
  interactiveSetup = false): CliOptions {
  const options: CliOptions = {
    reasoningCapabilities: [], sessionDirectory: env.VIVI_SESSION_DIR ?? join(homedir(), '.vivi', 'sessions'),
    stream: true, tui: true, enableNotes: false, enableMemory: false, enableTools: true, startNew: false, maxRounds: 25, help: false
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
      case '--workspace': options.workspace = value(); break
      case '--prompt': options.prompt = value(); break
      case '--new': explicitlyNew = true; options.startNew = true; break
      case '--no-stream': options.stream = false; break
      case '--tui': options.tui = true; break
      case '--no-tui': options.tui = false; break
      case '--enable-notes': options.enableNotes = true; break
      case '--enable-memory': options.enableMemory = true; break
      case '--disable-memory': options.enableMemory = false; break
      case '--tools': options.enableTools = true; break
      case '--no-tools': options.enableTools = false; break
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
  if (!options.resume && ((!options.model && !interactiveSetup) || (options.model !== undefined &&
    (!options.model || options.model.length > 200 || options.model.trim() !== options.model)))) {
    throw new Error('A new session requires --model with a bounded model identifier')
  }
  if (options.reasoning !== undefined && options.reasoning !== 'default' &&
    !efforts.includes(options.reasoning as ReasoningEffort)) throw new Error('Invalid reasoning level')
  if (options.reasoning && options.reasoning !== 'default' &&
    !options.reasoningCapabilities.includes(options.reasoning as ReasoningEffort)) {
    throw new Error('Selected reasoning requires explicit --reasoning-capabilities from your model’s supported efforts')
  }
  if (options.enableNotes && !options.enableTools) throw new Error('Session notes require declared tool support; omit --enable-notes or --no-tools')
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

export function supportsBunTui(version: string | undefined = process.versions.bun): boolean {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)/)
  return Boolean(match && (Number(match[1]) > 1 || Number(match[1]) === 1 && Number(match[2]) >= 3))
}

export function providerForSession(session: CliSession, options: CliOptions, env: NodeJS.ProcessEnv): ModelProvider {
  const apiKey = session.provider === 'openai' ? env.OPENAI_API_KEY : env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error(session.provider === 'openai' ? 'Set OPENAI_API_KEY in your environment' : 'Set OPENROUTER_API_KEY in your environment')
  const common = { model: session.model, apiKey, reasoning: reasoningPolicy(session.reasoning),
    supportedReasoningEfforts: options.reasoningCapabilities, stream: options.stream }
  return session.provider === 'openai' ? createOpenAIProvider(common) : createOpenRouterProvider({ ...common,
    requireSupportedParameters: options.enableTools || (session.reasoning !== undefined && session.reasoning !== 'default') })
}

/** Injection avoids provider calls and real terminal use in tests; importing this module does nothing. */
export async function main(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env,
  dependencies: { io?: ChatIO; tuiIO?: InteractiveIO; providerFactory?: typeof providerForSession;
    credentials?: CredentialStore; catalog?: Catalog } = {}): Promise<number> {
  let io: ChatIO | undefined
  let release: (() => Promise<void>) | undefined
  let host: CliHost | undefined
  const secrets = environmentSecrets(env)
  try {
    const interactive = dependencies.tuiIO !== undefined || (!dependencies.io && Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
      !args.includes('--no-tui') && (!args.includes('--prompt') || args.includes('--tui')) && !args.includes('--help') && !args.includes('-h'))
    if (interactive && !dependencies.tuiIO && !supportsBunTui()) {
      throw new Error('The full-screen UI requires Bun >=1.3.0. Install Bun from https://bun.sh, then run bun dist/main.js. Use --no-tui --model MODEL for Node line mode.')
    }
    const options = parseArguments(args, env, interactive)
    if (interactive) {
      const { runApplication } = await import('./application.js')
      const tui = dependencies.tuiIO ?? await (await import('./tui.js')).OpenTuiIO.create({ stream: options.stream, secrets })
      io = tui
      return await runApplication({ io: tui, options, args, env, secrets,
        ...(dependencies.credentials ? { credentials: dependencies.credentials } : {}),
        ...(dependencies.catalog ? { catalog: dependencies.catalog } : {}),
        registerSecret: secret => { if (!secrets.includes(secret)) secrets.push(secret) },
        providerFactory: dependencies.providerFactory ?? providerForSession })
    }
    io = dependencies.io ?? new TerminalIO({ stream: options.stream, tui: false, secrets })
    if (options.help) { io.write(HELP); return 0 }
    const workspace = options.workspace === undefined ? undefined : await ReadOnlyWorkspace.open(options.workspace, secrets, [options.sessionDirectory])
    const store = new FileSessionStore(options.sessionDirectory, secrets)
    const memory = new FileMemoryStore(options.sessionDirectory, secrets, message => io!.write(`${message}\n`))
    const fresh = options.resume ? undefined : newSession({
      provider: options.provider ?? 'openai', model: options.model!,
      ...(options.reasoning ? { reasoning: options.reasoning } : {})
    })
    release = await store.acquire(options.resume ?? fresh!.id)
    const session = options.resume ? await store.load(options.resume) : fresh!
    const metadata = session.provider === 'openai' ? documentedOpenAIModel(session.model) : undefined
    const enableTools = !args.includes('--no-tools') && (metadata?.tools === 'supported' ||
      metadata?.tools !== 'unsupported' && (args.includes('--tools') || args.includes('--enable-notes')))
    const effective = { ...options, enableTools, enableNotes: options.enableNotes && enableTools }
    const provider = (dependencies.providerFactory ?? providerForSession)(session, effective, env)
    host = new CliHost({ provider, store, session, secrets, enableNotes: effective.enableNotes,
      enableTools, enableMemory: options.enableMemory, memory, ...(workspace ? { workspace } : {}),
      onMemoryNotice: message => io!.write(`${message}\n`),
      maxRounds: options.maxRounds, approve: (request, signal) => io!.approve(request, signal),
      onEvent: (event) => io!.event(event) })
    await store.save(host.session)
    io.write(`Session: ${session.id}\nProvider: ${session.provider} | Model: ${session.model}\n`)
    if (workspace) io.write(`Workspace: ${JSON.stringify(workspace.directory)} · read only for this launch${enableTools ? '' : ' · tools unavailable for this model'}\nFiles read by tools are sent to the selected provider and saved in session history\n`)
    const result = await runChatLoop(host, io, options.prompt)
    return result?.status === 'error' ? 1 : result?.status === 'cancelled' ? 130 : 0
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : 'CLI failed', secrets)
    if (io && !io.failed) io.write(`${message}\n`)
    else process.stderr.write(`${message}\n`)
    return 1
  } finally {
    await host?.drainMemory().catch(() => undefined)
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
