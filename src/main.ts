#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createOpenAIProvider } from '@ayayaq/vivi/providers/openai'
import { createOpenRouterProvider } from '@ayayaq/vivi/providers/openrouter'
import type { ReasoningEffort, ReasoningSelection } from '@ayayaq/vivi/providers/openrouter'
import type { ModelProvider } from '@ayayaq/vivi'
import { createOpenAIDecisionProvider, createOpenRouterDecisionProvider } from '@ayayaq/vivi/decisions'
import type { DecisionProvider } from '@ayayaq/vivi/decisions'
import { CliHost } from './host.js'
import { FileMemoryStore } from './memory.js'
import { FileSkillStore } from './skills.js'
import { ReadOnlyWorkspace } from './workspace.js'
import { TrustedCommandWorkspace, captureCommandEnvironment } from './commands.js'
import { FileSessionStore, environmentSecrets, isSessionId, newSession, redactSecrets } from './session.js'
import type { CliProviderName, CliSession } from './session.js'
import { TerminalIO, isMcpCommand, runMcpCommand, runChatLoop, selectApprovalMode, runCommandControl } from './terminal.js'
import type { ChatIO } from './terminal.js'
import type { InteractiveIO } from './application.js'
import type { Catalog } from './models.js'
import { documentedOpenAIModel } from './models.js'
import type { CredentialStore } from './credentials.js'
import type { ApprovalMode } from './auto-review.js'
import { assertReviewTransportCurrent } from './auto-review.js'
import { FileDecisionLedger } from './decision-ledger.js'
import { McpConfigStore } from './mcp-config.js'
import { McpManager } from './mcp-manager.js'
import type { McpManagerOptions } from './mcp-manager.js'
import { manageMcp } from './mcp-controls.js'

export interface CliOptions {
  /** Launch-only request to open enrollment; never a saved approval. */
  approvalMode: ApprovalMode
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
  /** A request for fresh interactive enrollment, never command authority itself. */
  enableCommands: boolean
  enableSkills: boolean
  skillsDirectories: string[]
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
  --workspace PATH            Folder for reads and reviewed text edits (default: launch directory)
  --no-workspace              Disable workspace files for this launch
  --diagnose-input            Offline full-screen Enter modifier probe; no provider or saved state
  --prompt TEXT               Run one turn and exit
  --no-stream                 Display accepted complete messages only
  --approval-mode MODE        manual (default) or auto; auto still needs fresh interactive enrollment
  --tui / --no-tui            OpenTUI full-screen / accessible line mode
  --tools / --no-tools        Declare tool support / use chat only
  --enable-notes              Enable session-only revisioned notes with allow/deny prompts
  --enable-memory             Use reviewed app-wide saved context (plaintext local storage)
  --disable-memory            Override saved memory defaults for this launch
  --enable-commands           Request fresh interactive workspace trust (off by default)
  --skills-dir PATH           Explicit read-only standard skills root (repeatable, max 8)
  --no-skills                 Disable skills for this launch
  --max-rounds NUMBER         Bounded provider rounds, 1..100 (default 25)
  --help                      Show this help

Credentials: environment variables, or masked /provider setup in the full-screen UI.
Full-screen UI requires Bun >=1.3.0; Node >=26.4 supports line/piped mode.
Ctrl-C or Escape cancels an active turn; /exit quits; /session prints its name, id and usage; /rename NAME changes its name.
Streaming is display-only. Notes never access other files; piped approval is denied.
Saved memory is off by default. When enabled, it is sent to the selected provider.
Workspace defaults to the directory where vivi was launched; --workspace overrides it, --no-workspace disables it.
Selected files may be sent to your provider and saved in session history.
Workspace tools omit symlinks and private/ignored files; text writes require review; this is not an OS sandbox.
/commands on enables separate trusted, unsandboxed commands for this launch/session. Every process requires human approval, even in Auto; piped approval is denied.
/memories lists, adds, edits, deletes, enables or disables saved memory.
/mode selects Manual or optional Auto review for the current conversation and selected account.
Public fetch_url reads bounded public HTTPS pages through host review; no login, cookies, JavaScript, downloads or private/local targets.
Auto review adds API charges; eligible current-request note/memory, scoped text creation/precise-edit and public URL GET tool calls can use it.
/skills lists and inspects instruction-only skills; creation uses reviewed agent drafts.
/mcp configures trusted installed stdio servers; fresh human startup approval is required.
MCP connections start disabled each launch. Connected catalogs can expose model tools and exact resource reads; every remote operation needs human approval, even in Auto. Credentials are unsupported.
Skills are app-wide standard SKILL.md files. Metadata and selected text go to your provider.
The bundled creator is read-only. Scripts are never executed; workspace skills are never auto-loaded.
`
const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
/** Only CLI callers supplying their captured launch directory get a default workspace. */
export function parseArguments(args: readonly string[], env: NodeJS.ProcessEnv = process.env,
  interactiveSetup = false, launchDirectory?: string): CliOptions {
  const options: CliOptions = {
    reasoningCapabilities: [], sessionDirectory: env.VIVI_SESSION_DIR ?? join(homedir(), '.vivi', 'sessions'),
    approvalMode: 'manual', stream: true, tui: true, enableNotes: false, enableMemory: false, enableCommands: false, enableSkills: true, skillsDirectories: [], enableTools: true, startNew: false, maxRounds: 25, help: false,
    ...(launchDirectory === undefined ? {} : { workspace: launchDirectory })
  }
  let explicitlyNew = false
  let explicitWorkspace = false
  let noWorkspace = false
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
      case '--workspace': explicitWorkspace = true; options.workspace = value(); break
      case '--no-workspace': noWorkspace = true; delete options.workspace; break
      case '--enable-commands': options.enableCommands = true; break
      case '--prompt': options.prompt = value(); break
      case '--new': explicitlyNew = true; options.startNew = true; break
      case '--no-stream': options.stream = false; break
      case '--approval-mode': {
        const mode = value()
        if (mode !== 'manual' && mode !== 'auto') throw new Error('Approval mode must be manual or auto')
        options.approvalMode = mode
        break
      }
      case '--tui': options.tui = true; break
      case '--no-tui': options.tui = false; break
      case '--enable-notes': options.enableNotes = true; break
      case '--enable-memory': options.enableMemory = true; break
      case '--disable-memory': options.enableMemory = false; break
      case '--no-skills': options.enableSkills = false; break
      case '--skills-dir': {
        if (options.skillsDirectories.length >= 8) throw new Error('At most eight explicit skills directories are supported')
        const directory = value()
        options.skillsDirectories.push(launchDirectory === undefined ? resolve(directory) : resolve(launchDirectory, directory))
        break
      }
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
  if (explicitWorkspace && noWorkspace) throw new Error('Use either --workspace PATH or --no-workspace, not both')
  if (options.workspace !== undefined && launchDirectory !== undefined) {
    options.workspace = resolve(launchDirectory, options.workspace)
  }
  if (options.help) return options
  if (options.resume && (!isSessionId(options.resume) || explicitlyNew)) throw new Error('Use a valid session UUID and either new or resume')
  if (options.resume && (options.provider !== undefined || options.model !== undefined || options.reasoning !== undefined)) {
    throw new Error('Resumed sessions retain their provider, model and reasoning; omit selection flags')
  }
  const mcpPrompt = options.prompt !== undefined && isMcpCommand(options.prompt)
  if (!options.resume && ((!options.model && !interactiveSetup && !mcpPrompt) || (options.model !== undefined &&
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

/** Dedicated fixed-model review on the selected existing account; never discover or copy credentials. */
export function decisionProviderForSession(session: CliSession, env: NodeJS.ProcessEnv, beforeRequest?: () => void): DecisionProvider {
  const name = session.provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY'
  const apiKey = (): string => {
    beforeRequest?.()
    const key = env[name]
    if (!key) throw new Error(`The selected ${session.provider} account has no existing API key`)
    return key
  }
  const guardedFetch: typeof fetch = (input, init) => { beforeRequest?.(); return globalThis.fetch(input, init) }
  return session.provider === 'openai' ? createOpenAIDecisionProvider({ apiKey, timeoutMs: 8_000, fetch: guardedFetch })
    : createOpenRouterDecisionProvider({ apiKey, timeoutMs: 8_000, fetch: guardedFetch })
}

/** Construct only when an enrolled eligible action actually requests review. */
export function deferredDecisionProvider(session: CliSession, env: NodeJS.ProcessEnv,
  factory: typeof decisionProviderForSession): DecisionProvider {
  const model = session.provider === 'openai' ? 'gpt-6-luna' : 'typesafe/jev-1.13'
  return { id: session.provider, model,
    evaluate: (request, signal) => {
      // A new request-bound closure cannot be confused with a later review after timeout.
      const provider = factory(session, env, () => assertReviewTransportCurrent(request))
      if (provider.id !== session.provider || provider.model !== model) throw new Error('Decision provider does not match the selected account and fixed review model')
      return provider.evaluate(request, signal)
    } }
}

/** Injection avoids provider calls and real terminal use in tests; importing this module does nothing. */
export async function main(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env,
  dependencies: { io?: ChatIO; tuiIO?: InteractiveIO; providerFactory?: typeof providerForSession;
    decisionProviderFactory?: typeof decisionProviderForSession;
    credentials?: CredentialStore; catalog?: Catalog; launchDirectory?: string;
    mcpManagerFactory?: (options: McpManagerOptions) => McpManager;
    inputDiagnostic?: () => Promise<string> } = {}): Promise<number> {
  // This isolated path never reads credentials, preferences, workspace or sessions.
  if (args.includes('--diagnose-input')) {
    if (args.length !== 1) { process.stderr.write('Use --diagnose-input by itself\n'); return 1 }
    if (!dependencies.inputDiagnostic && (!supportsBunTui() || !process.stdin.isTTY || !process.stdout.isTTY)) {
      process.stderr.write('Input diagnostics require Bun >=1.3.0 in an interactive terminal. Run vivi --diagnose-input there.\n')
      return 1
    }
    try {
      const diagnose = dependencies.inputDiagnostic ?? (await import('./input-diagnostic.js')).runInputDiagnostic
      process.stdout.write(await diagnose())
      return 0
    } catch {
      process.stderr.write('Input diagnostic failed; no input contents were saved or reported. Close this terminal tab if restoration failed.\n')
      return 1
    }
  }
  let io: ChatIO | undefined
  let release: (() => Promise<void>) | undefined
  let host: CliHost | undefined
  let mcp: McpManager | undefined
  const secrets = environmentSecrets(env)
  const closeIO = (): boolean => {
    const closing = io
    if (!closing) return false
    io = undefined
    const failedBeforeClose = closing.failed
    closing.close()
    if (!failedBeforeClose && closing.failed) {
      process.stderr.write('vivi: terminal cleanup failed. Close this terminal window or tab before restarting vivi.\n')
      return true
    }
    return false
  }
  try {
    // Capture before any async setup. Never use the install/bin or private profile folder.
    // Help and opt-outs do not need a usable cwd; injected directories keep tests isolated.
    const launchDirectory = dependencies.launchDirectory ?? (args.includes('--no-workspace') || args.includes('--help') ||
      args.includes('-h') ? undefined : process.cwd())
    const interactive = dependencies.tuiIO !== undefined || (!dependencies.io && Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
      !args.includes('--no-tui') && (!args.includes('--prompt') || args.includes('--tui')) && !args.includes('--help') && !args.includes('-h'))
    if (interactive && !dependencies.tuiIO && !supportsBunTui()) {
      throw new Error('The full-screen UI requires Bun >=1.3.0. Install Bun from https://bun.sh, then run bun dist/main.js. Use --no-tui --model MODEL for Node line mode.')
    }
    const options = parseArguments(args, env, interactive, launchDirectory)
    if (interactive) {
      const { runApplication } = await import('./application.js')
      const tui = dependencies.tuiIO ?? await (await import('./tui.js')).OpenTuiIO.create({ stream: options.stream, secrets })
      io = tui
      const status = await runApplication({ io: tui, options, args, env, secrets,
        ...(dependencies.credentials ? { credentials: dependencies.credentials } : {}),
        ...(dependencies.catalog ? { catalog: dependencies.catalog } : {}),
        ...(dependencies.mcpManagerFactory ? { mcpManagerFactory: dependencies.mcpManagerFactory } : {}),
        registerSecret: secret => { if (!secrets.includes(secret)) secrets.push(secret) },
        providerFactory: dependencies.providerFactory ?? providerForSession,
        decisionProviderFactory: dependencies.decisionProviderFactory ?? decisionProviderForSession })
      const cleanupFailed = closeIO()
      return cleanupFailed && status === 0 ? 1 : status
    }
    io = dependencies.io ?? new TerminalIO({ stream: options.stream, tui: false, secrets })
    if (options.help) { io.write(HELP); return 0 }
    mcp = (dependencies.mcpManagerFactory ?? (options => new McpManager(options)))({
      store: new McpConfigStore(options.sessionDirectory, secrets), env, secrets
    })
    if (options.prompt !== undefined && await runMcpCommand(io, options.prompt, {
      mcp: () => manageMcp(mcp!, io!, options.workspace)
    })) return 0
    const workspace = options.workspace === undefined ? undefined : await ReadOnlyWorkspace.open(options.workspace, secrets, [options.sessionDirectory])
    const store = new FileSessionStore(options.sessionDirectory, secrets)
    const memory = new FileMemoryStore(options.sessionDirectory, secrets, message => io!.write(`${message}\n`))
    const skills = new FileSkillStore(join(options.sessionDirectory, 'agent-skills'), { readOnlyRoots: options.skillsDirectories, secrets, notice: message => io!.write(`${message}\n`) })
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
    const accountRevision = randomUUID()
    const commandEnv = captureCommandEnvironment(env)
    host = new CliHost({ provider, store, session, secrets, mcp, onMcpNotice: message => io!.write(`${message}\n`), onConversationNotice: message => io!.write(`${message}\n`), enableNotes: effective.enableNotes,
      enableTools, enableMemory: options.enableMemory, memory, enableSkills: options.enableSkills, skills,
      onSkillsNotice: message => io!.write(`${message}\n`), ...(workspace ? { workspace } : {}),
      ...(workspace ? { commandWorkspaceFactory: () => TrustedCommandWorkspace.open(workspace.directory, commandEnv, secrets), commandApproval: { accountRevision: () => accountRevision,
        isAvailable: () => io?.canAutoReview === true && !io.isClosed } } : {}),
      onMemoryNotice: message => io!.write(`${message}\n`),
      onReviewNotice: (message, context) => io!.reviewNotice ? io!.reviewNotice(message, context) : io!.write(`${message}\n`),
      ...(io.canAutoReview === true ? { decisionReview: {
        provider: deferredDecisionProvider(session, env, dependencies.decisionProviderFactory ?? decisionProviderForSession),
        ledger: new FileDecisionLedger(options.sessionDirectory, secrets), canAutoReview: true,
        accountRevision: () => accountRevision, isAvailable: () => io?.canAutoReview === true && !io.isClosed
      } } : {}),
      maxRounds: options.maxRounds, approve: (request, signal) => io!.approve(request, signal),
      onEvent: (event) => io!.event(event) })
    await host.initialize()
    io.setApprovalMode?.('manual')
    io.write(`Session: ${session.id}\nProvider: ${session.provider} | Model: ${session.model}\nApproval mode: Manual\n`)
    if (workspace) io.write(`Workspace: ${JSON.stringify(workspace.directory)} · reads and reviewed text edits for this launch${enableTools ? '' : ' · tools unavailable for this model'}\nFiles read by tools are sent to the selected provider and saved in session history\n`)
    if (options.approvalMode === 'auto') await selectApprovalMode(host, io)
    if (options.enableCommands) await runCommandControl(host, io, '/commands on')
    const result = await runChatLoop(host, io, options.prompt, {
      mcp: () => manageMcp(mcp!, io!, options.workspace)
    })
    return result?.status === 'error' ? 1 : result?.status === 'cancelled' ? 130 : 0
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : 'CLI failed', secrets)
    if (io && !io.failed) io.write(`${message}\n`)
    else process.stderr.write(`${message}\n`)
    return 1
  } finally {
    let mcpCleanupFailed = false
    try { await mcp?.close() }
    catch (error) {
      mcpCleanupFailed = true
      const message = redactSecrets(error instanceof Error ? error.message : 'Owned server cleanup failed', secrets)
      try {
        if (io && !io.failed) io.write(`MCP cleanup failed: ${message}\n`)
        else process.stderr.write(`MCP cleanup failed: ${message}\n`)
      } catch { process.stderr.write('MCP cleanup failed; terminal reporting was unavailable\n') }
    }
    await host?.shutdown().catch(() => undefined)
    await release?.().catch(() => undefined)
    closeIO()
    if (mcpCleanupFailed) return 1
  }
}

let isEntryPoint = false
try { isEntryPoint = process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) }
catch { /* Importing the testable module does not require a real executable path. */ }
if (isEntryPoint) {
  void main().then((status) => { process.exitCode = status })
}
