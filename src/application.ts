// SPDX-License-Identifier: Apache-2.0
import { chooseSecureKey } from './key-controls.js'
import { DEEPSEEK_WEB_DISCLOSURE } from './web-tools.js'
import type { CliWebConfiguration } from './web-tools.js'
import type { ModelProvider } from '@ayayaq/vivi'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ReasoningEffort } from '@ayayaq/vivi/providers/openrouter'
import { providerEnvironmentName, isReviewProvider } from './provider-selection.js'
import type { CliOptions } from './main.js'
import { decisionProviderForSession, deferredDecisionProvider } from './main.js'
import { CliHost } from './host.js'
import { FileMemoryStore } from './memory.js'
import { InstalledSkillStore } from './installed-skills.js'
import { ReadOnlyWorkspace } from './workspace.js'
import { TrustedCommandWorkspace, captureCommandEnvironment } from './commands.js'
import { USER_SHELL_DISCLOSURE } from './user-shell.js'
import { FileSessionStore, newSession, redactSecrets } from './session.js'
import { FileImageAssets } from './image-assets.js'
import type { CliProviderName, CliSession } from './session.js'
import { formatUsage } from './usage.js'
import type { ChatIO } from './terminal.js'
import { bindBackgroundProcessControls, runProcessControl } from './process-controls.js'
import { compactChatContext, refreshChatContext, displayMemories, MEMORY_DISCLOSURE, reviewMemoryChange, sendChatTurn, runSteeringCommand, selectApprovalMode, runModeControl, AUTO_REVIEW_UNAVAILABLE, runCommandControl, displaySkills, SKILLS_DISCLOSURE, skillCreationPrompt, runInstructionsCommand, isMcpCommand, runMcpCommand } from './terminal.js'
import { formatContextDetails, formatContextSummaryUsage } from './context-status.js'
import { conversationModeLabel } from './task-mode.js'
import { formatSessionDate, sessionDisplayTitle } from './session-display.js'
import { PreferenceStore, listSessions, DEFAULT_PREFERENCES } from './preferences.js'
import { chooseAutoReviewThreshold } from './auto-review-controls.js'
import { formatAutoReviewThreshold, parseAutoReviewThresholdPercent, resolveAutoReviewThreshold } from './auto-review-settings.js'
import { reviewDigest } from './auto-review.js'
import type { TuiPreferences } from './preferences.js'
import { ModelCatalog, unknownModel, documentedOpenAIModel, modelAccessDenied, hydrateModelCapabilities, modelToolsEnabled, contextLimitsForModel } from './models.js'
import type { Catalog, ModelEntry } from './models.js'
import { createCredentialStore, validateApiKey } from './credentials.js'
import type { CredentialStore } from './credentials.js'
import type { Choice, SearchableOptions, SearchableSelection } from './picker.js'
import { FileDecisionLedger } from './decision-ledger.js'
import { McpConfigStore } from './mcp-config.js'
import { McpManager } from './mcp-manager.js'
import type { McpManagerOptions } from './mcp-manager.js'
import { manageMcp } from './mcp-controls.js'
import { McpOAuthControls } from './mcp-oauth-controls.js'
import { McpOAuthStore } from './mcp-oauth-store.js'
import type { McpOAuthControlsOptions } from './mcp-oauth-controls.js'
import { McpSetupService } from './mcp-setup.js'
import { ChatGptAuthManager, CHATGPT_USAGE_URL } from './chatgpt-auth.js'
import { ChatGPTModelCatalog } from './chatgpt-models.js'
import { bindChatGptAccount, chatGptPlanStatus, chooseChatGptAccount, confirmChatGptWelcome } from './chatgpt-controls.js'
import type { ChatGptAuth } from './chatgpt-controls.js'

export interface InteractiveIO extends ChatIO {
  choose<T>(title: string, choices: readonly { name: string; description?: string; value: T }[], initialIndex?: number): Promise<T | undefined>
  chooseSearchable<T>(title: string, choices: readonly Choice<T>[], options?: SearchableOptions): Promise<SearchableSelection<T> | undefined>
  askText(title: string, initial?: string): Promise<string | undefined>
  askSecret?(title: string): Promise<string | undefined>
  addSecrets?(secrets: readonly string[]): void
  setDraft?(provider: CliProviderName): void
  setComposerDraft?(content: string): void
  setSession(session: CliSession): void
  setWorkspace?(directory?: string): void
}
export interface ApplicationOptions {
  io: InteractiveIO
  options: CliOptions
  args: readonly string[]
  env: NodeJS.ProcessEnv
  secrets: readonly string[]
  credentials?: CredentialStore
  catalog?: Catalog
  chatgptAuth?: ChatGptAuth
  registerSecret?(secret: string): void
  providerFactory(session: CliSession, options: CliOptions, env: NodeJS.ProcessEnv): ModelProvider
  decisionProviderFactory?: typeof decisionProviderForSession
  /** Trusted launch wiring only; never configured by the model. */
  mcpManagerFactory?(options: McpManagerOptions): McpManager
  /** Trusted launch/fixture browser and network hooks; no credentials or persisted OAuth settings. */
  mcpOAuth?: Omit<McpOAuthControlsOptions, 'registerSecrets' | 'secrets'>
}
export { DEFAULT_PREFERENCES } from './preferences.js'
const envName = providerEnvironmentName

export function settingsForModel(base: TuiPreferences, model: ModelEntry): TuiPreferences {
  const same = base.model === model.id
  const reasoning = same && (base.reasoning === 'default' || model.efforts.includes(base.reasoning as ReasoningEffort))
    ? base.reasoning : 'default'
  return { ...base, model: model.id, reasoning, reasoningCapabilities: [...model.efforts],
    enableTools: model.tools === 'supported' }
}
export async function chooseEffort(io: InteractiveIO, base: TuiPreferences): Promise<TuiPreferences | undefined> {
  if (!base.model) { io.write('Choose a model with /models first\n'); return }
  if (base.provider === 'openai' && documentedOpenAIModel(base.model).conversation === 'unsupported') {
    io.write('Choose a compatible text-conversation model with /models first\n'); return
  }
  const levels = ['default', ...base.reasoningCapabilities]
  const selected = await io.choose(`Reasoning effort · ${base.model}`, levels.map(value => ({
    name: value === 'none' ? 'None (disable reasoning)' : value === 'default' ? 'Provider default' : value,
    description: value === 'default' ? base.reasoningCapabilities.length ? 'Use this model’s default behavior' : 'Specific efforts unavailable: capability metadata is unknown or absent' : 'Supported by this model', value
  })), Math.max(0, levels.indexOf(base.reasoning)))
  return selected === undefined ? undefined : { ...base, reasoning: selected }
}
const COMMAND_HELP = `${USER_SHELL_DISCLOSURE}\nEnter submits; Ctrl+J adds a line. Shift/Alt+Enter also adds a line when the terminal reports it. Tab completes slash commands above the composer.
/provider sets up an OpenAI, OpenRouter or DeepSeek chat key; /web independently selects Direct, DeepSeek or Disabled; /reviewer explicitly selects this conversation’s supported Auto reviewer; /models opens the model picker; /effort selects supported reasoning.
/new starts fresh; /resume explicitly resumes a local session; /rename names the current session; /notes changes the session-note default for new conversations.
/memories manages this launch’s app-wide saved context and its future-launch default; it is plaintext locally and sent to the selected provider when enabled.
/mode chooses Manual / Auto review / Skip permissions / Plan for this conversation. /mode plan enters read-only planning; /mode manual returns to human-reviewed execution.
Shift+Tab cycles Manual / Auto review / Skip permissions / Plan in the idle composer and preserves your draft; entering Auto still needs confirmation.
/processes lists background jobs; logs ID, stop ID, restart ID and stop-all manage them. F6 stops the selected job; F7 stops all, even while working or in a dialog.
/commands proposes workspace commands by default; every exact unsandboxed command needs fresh human approval in Manual/Auto; explicitly enrolled Skip permissions skips ordinary prompts. /commands off disables proposals; /commands on restores them.
/skills lists and inspects standard skills and prepares creator drafts for human-reviewed saving.
/instructions status|reload|disable manages launch-local AGENTS.md guidance.
/mcp manages trusted installed server connections; each launch starts disabled. Remote tool calls/resources need human approval in Manual/Auto; enrolled Skip applies only to already-connected servers.
MCP sign-in can be saved securely and refreshed before an approved Connect. Disconnect retains it; Sign out forgets saved tokens locally. Session-only sign-in is an explicit choice.
/context shows effective-request tokens, capacity and output reserve; /compact summarizes older provider context while keeping the full local transcript.\n/menu opens actions (/settings is a legacy alias); /session shows the current ID and usage; /exit quits.
Mouse: click action buttons, picker rows, tool headers and dialog choices; wheel scrolls. Tool details start collapsed. Ctrl+O toggles the latest call. Approvals select Deny by default.
Enter while working queues a message; Ctrl+Enter or Interrupt & send cancels first, then sends after cleanup. Modifier reporting varies by terminal.
/queue shows retained input; /queue send sends it; /queue undo edits the latest; /queue clear removes pending input.
Escape or Ctrl-C cancels a running turn and retains queued input. Ctrl-C while idle exits.
Provider/model/effort changes start a fresh conversation; existing transcripts remain available with /resume.
Keys are masked and saved only in an available OS credential store, or used for this launch after your choice.
`

/** Navigation and host policy; the shared core owns conversation/tool execution. */
interface ApplicationSecretRegistration {
  readonly secrets: string[]
  register(values: readonly string[]): void
  targets(values: readonly string[]): void
}
export async function runApplication(input: ApplicationOptions): Promise<number> {
  if (input.options.prompt !== undefined && /^\/auto-threshold(?:\s|$)/.test(input.options.prompt.trim())) {
    input.io.write('Auto threshold changes require an idle interactive conversation; no setting changed\n')
    return 0
  }
  let manager: McpManager
  const registration: ApplicationSecretRegistration = { secrets: [...input.secrets], targets: () => undefined,
    register: values => {
      const fresh = values.filter(value => value && !registration.secrets.includes(value))
      registration.secrets.push(...fresh)
      manager.addSecrets(fresh); registration.targets(fresh); input.io.addSecrets?.(fresh)
      for (const secret of fresh) input.registerSecret?.(secret)
    } }
  const oauth = new McpOAuthControls({ dynamicRegistration: 'explicit',
    // Existing custom embedders stay session-only unless they supply a store.
    ...(input.mcpOAuth === undefined ? { savedStore: new McpOAuthStore(input.options.sessionDirectory, { registerSecrets: registration.register }) } : {}),
    ...input.mcpOAuth, secrets: registration.secrets, registerSecrets: registration.register })
  manager = (input.mcpManagerFactory ?? (options => new McpManager(options)))({
    store: new McpConfigStore(input.options.sessionDirectory, registration.secrets), env: input.env,
    secrets: registration.secrets, ...oauth.managerOptions()
  })
  oauth.bind(manager)
  const chatgptAuth = input.chatgptAuth ?? new ChatGptAuthManager({ directory: input.options.sessionDirectory,
    registerSecrets: registration.register })
  try {
    if (input.options.prompt !== undefined && await runMcpCommand(input.io, input.options.prompt, {
      mcp: () => manageMcp(manager, input.io, input.options.workspace, oauth)
    })) return 0
    return await runManagedApplication({ ...input, chatgptAuth }, manager, oauth, registration)
  }
  finally { try { if (!input.chatgptAuth) await chatgptAuth.close() } finally { try { await oauth.close() } finally { await manager.close() } } }
}

async function runManagedApplication(input: ApplicationOptions, mcp: McpManager, oauth: McpOAuthControls,
  registration: ApplicationSecretRegistration): Promise<number> {
  const { io, options, args, providerFactory } = input
  const mcpSetup = { service: new McpSetupService(mcp, oauth), io }
  const env = { ...input.env }
  const commandEnv = captureCommandEnvironment(input.env)
  const secrets = registration.secrets
  const credentials = input.credentials ?? createCredentialStore()
  const chatgptAuth = input.chatgptAuth!
  const chatgptModels = new ChatGPTModelCatalog({ accessToken: (id, signal) => chatgptAuth.accessToken(id, signal) })
  const apiCatalog = new ModelCatalog()
  const catalog: Catalog = input.catalog ?? { list: (provider, credential, signal, refresh) => provider === 'chatgpt'
    ? chatgptModels.list(credential ?? '', signal, refresh) : apiCatalog.list(provider, credential, signal, refresh) }
  const store = new FileSessionStore(options.sessionDirectory, secrets)
  const preferences = new PreferenceStore(options.sessionDirectory, secrets)
  const memory = new FileMemoryStore(options.sessionDirectory, secrets, message => io.write(`${message}\n`))
  const decisions = new FileDecisionLedger(options.sessionDirectory, secrets)
  const skills = new InstalledSkillStore(options.sessionDirectory, { readOnlyRoots: options.skillsDirectories, secrets, notice: message => io.write(`${message}\n`) })
  let activeSkills = options.enableSkills
  let activeCommands = options.enableCommands
  const workspace = options.workspace === undefined ? undefined : await ReadOnlyWorkspace.open(options.workspace, secrets, [options.sessionDirectory])
  io.setWorkspace?.(workspace?.directory)
  const knownModels = new Map<string, ModelEntry>()
  const declaredToolModels = new Set<string>()
  const modelKey = (provider: CliProviderName, id: string, accountId = settings.chatgptAccountId): string =>
    provider === 'chatgpt' ? `${provider}:${accountId ?? 'unselected'}:${id}` : `${provider}:${id}`
  const report = (error: unknown): void => io.write(`${redactSecrets(error instanceof Error ? error.message : 'Application failed', secrets)}\n`)
  const register = (key: string): void => registration.register([key])
  let settings = structuredClone(DEFAULT_PREFERENCES)
  let savedSettings: TuiPreferences | undefined
  let thresholdPreferencesAvailable = true
  try { savedSettings = await preferences.load(); settings = savedSettings ? structuredClone(savedSettings) : settings }
  catch (error) { thresholdPreferencesAvailable = false; io.write('Saved defaults could not be loaded; Auto enrollment is unavailable until /auto-threshold explicitly saves a valid setting. Use /provider or /resume\n'); report(error) }
  // App-wide consent belongs to the launch, not to a model's session settings.
  let activeMemory = args.includes('--enable-memory') || args.includes('--disable-memory')
    ? options.enableMemory : settings.enableMemory
  if ((options.provider !== undefined && options.provider !== settings.provider) ||
    (options.model !== undefined && options.model !== settings.model)) {
    settings = { ...settings, reasoning: 'default', reasoningCapabilities: [], enableTools: false }
  }
  if (args.includes('--provider')) settings.provider = options.provider!
  if (options.chatgptAccountId) settings.chatgptAccountId = options.chatgptAccountId
  if (args.includes('--model')) settings.model = options.model!
  if (args.includes('--reasoning')) settings.reasoning = options.reasoning!
  if (args.includes('--reasoning-capabilities')) {
    settings.reasoningCapabilities = options.reasoningCapabilities
    if (!args.includes('--reasoning') && !settings.reasoningCapabilities.includes(settings.reasoning as ReasoningEffort)) settings.reasoning = 'default'
  }
  if (args.includes('--no-stream')) settings.stream = false
  if (args.includes('--tools')) settings.enableTools = true
  if (args.includes('--no-tools')) settings.enableTools = false
  if (args.includes('--enable-notes') || args.includes('--disable-notes')) settings.enableNotes = options.enableNotes
  if (args.includes('--max-rounds')) settings.maxRounds = options.maxRounds
  if (settings.provider === 'openai' && settings.model) {
    const verified = documentedOpenAIModel(settings.model)
    if (verified.tools !== 'unknown') {
      const previousEffort = settings.reasoning
      settings = settingsForModel(settings, verified)
      if (previousEffort !== settings.reasoning) io.write('Saved reasoning is no longer verified for this model; using provider default. Use /effort to select a supported level\n')
      if (args.includes('--no-tools') || savedSettings?.provider === settings.provider &&
        savedSettings.model === settings.model && !savedSettings.enableTools && !args.includes('--tools')) settings.enableTools = false
    }
  }
  if (options.webProvider !== undefined) settings.webProvider = options.webProvider
  let webKey = env.DEEPSEEK_WEB_API_KEY
  let webGeneration = randomUUID()
  let reviewerGeneration = randomUUID()
  // Explicit reviewer credentials are launch-owned and never replace chat env state.
  const reviewerKeys = new Map<'openai' | 'openrouter', string>()
  const declaredToolTarget = { provider: settings.provider, model: settings.model }
  let host: CliHost | undefined
  let releaseProcesses: (() => void) | undefined
  // Opaque launch-owned revisions never expose, derive from or persist credentials.
  let accountGeneration = randomUUID()
  let hostAccountGeneration: string | undefined
  let launchModePending = options.approvalMode !== 'manual'
  let activeSettings: TuiPreferences | undefined
  let release: (() => Promise<void>) | undefined
  let candidate: { host?: CliHost; release: () => Promise<void>; shutdownConfirmed?: boolean; releaseFailed?: boolean } | undefined
  let sessionCleanupFailed = false
  registration.targets = values => {
    preferences.addSecrets(values); memory.addSecrets(values); decisions.addSecrets(values); skills.addSecrets(values)
    workspace?.addSecrets(values); host?.refreshSecretFilters(); candidate?.host?.refreshSecretFilters()
  }
  const discardCandidate = async (): Promise<void> => {
    if (!candidate) return
    try {
      // Keep the lease while shutdown is unconfirmed: this host may still write.
      if (!candidate.shutdownConfirmed) { await candidate.host?.shutdown(); candidate.shutdownConfirmed = true }
      // FileSessionStore's release is one-shot, including failed unlink attempts.
      if (candidate.releaseFailed) return
      try { await candidate.release() }
      catch (error) { candidate.releaseFailed = true; throw error }
      candidate = undefined
    } catch (error) {
      sessionCleanupFailed = true
      // A secondary cleanup/display failure must not replace the setup error.
      try { io.write('Candidate session cleanup failed; its session may remain locked\n'); report(error) } catch { /* Preserve the primary error. */ }
    }
  }
  let selected: { resume?: string; fresh?: boolean; preservePlan?: boolean } | undefined = options.resume ? { resume: options.resume }
    : settings.model ? { fresh: true } : undefined
  const loadKey = async (provider: CliProviderName): Promise<string | undefined> => {
    if (provider === 'chatgpt') return settings.chatgptAccountId
    const name = envName(provider)
    if (env[name]) { register(env[name]!); return env[name] }
    try {
      const key = await credentials.load(provider)
      if (key) { register(key); env[name] = validateApiKey(key) }
      return env[name]
    } catch (error) { report(error); return undefined }
  }
  // OpenRouter capability metadata is live catalog data, not a persisted toggle.
  // Hydrate it before the first fresh host, just as /models does before /new.
  // Already-selected models in this launch need no second discovery request.
  const hydrateModel = async (): Promise<string | false | undefined> => {
    if (settings.provider === 'openai' || knownModels.has(modelKey(settings.provider, settings.model))) return
    const key = await loadKey(settings.provider)
    const controller = new AbortController()
    const dispose = io.onCancel(() => controller.abort())
    try {
      io.write(`Loading ${settings.provider} model capabilities…\n`)
      const hydrated = await hydrateModelCapabilities(catalog, settings.provider, settings.model, key, controller.signal)
      if (io.isClosed || controller.signal.aborted) return false
      const result = hydrated.catalog!
      let notice = ''
      for (const model of result.models) knownModels.set(modelKey(settings.provider, model.id), model)
      const model = hydrated.model
      if (settings.provider === 'chatgpt' && !result.models.some(model => model.id === settings.model)) throw new Error('This model is not listed for the selected ChatGPT account. Choose a current model with /models')
      knownModels.set(modelKey(settings.provider, model.id), model)
      const previous = settings
      settings = settingsForModel(settings, model)
      // A saved chat-only choice and an explicit launch opt-out remain off.
      // Unknown tool metadata cannot promote a saved claim into permission;
      // openSession still requires this launch's explicit --tools declaration.
      if (model.tools === 'unknown') settings.enableTools = previous.enableTools
      if (args.includes('--no-tools') || savedSettings?.provider === settings.provider &&
        savedSettings.model === settings.model && !savedSettings.enableTools && !args.includes('--tools')) {
        settings.enableTools = false
      }
      if (model.reasoning === 'unknown' && args.includes('--reasoning-capabilities')) {
        settings.reasoning = previous.reasoning; settings.reasoningCapabilities = previous.reasoningCapabilities
      }
      if (previous.reasoning !== settings.reasoning) notice += 'Saved reasoning is no longer verified for this model; using provider default. Use /effort to select a supported level\n'
      notice += result.warning ? `${redactSecrets(result.warning, secrets)}. Using a stale cached catalog\n`
        : result.state === 'cached' ? 'Using the cached model catalog (up to 15 minutes old)\n' : ''
      return notice || undefined
    } catch (error) {
      if (io.isClosed || controller.signal.aborted) return false
      // Authentication denial is not an offline fallback and cannot authorize a
      // provider attempt, even when --tools was explicitly declared this launch.
      if (modelAccessDenied(error) || settings.provider === 'chatgpt') throw error
      return `${redactSecrets(error instanceof Error ? error.message : 'Model capabilities could not be loaded', secrets)}\n`
    } finally { dispose() }
  }
  const setupProvider = async (base: TuiPreferences): Promise<TuiPreferences | undefined> => {
    const provider = await io.choose('Provider', [
      { name: 'Continue with ChatGPT', description: 'Official sign-in · use your ChatGPT plan', value: 'chatgpt' as const },
      { name: 'OpenAI API key', description: 'Responses API · separate API billing', value: 'openai' as const },
      { name: 'OpenRouter', description: 'Chat Completions gateway', value: 'openrouter' as const },
      { name: 'DeepSeek', description: 'Native Chat Completions; separate from web', value: 'deepseek' as const }
    ], ['chatgpt', 'openai', 'openrouter', 'deepseek'].indexOf(base.provider))
    if (!provider || io.isClosed) return
    if (provider === 'chatgpt') {
      const account = await chooseChatGptAccount(io, chatgptAuth, base.chatgptAccountId)
      if (!account || io.isClosed) return
      // Even reauthorization of the same registration requires fresh task authority.
      {
        await host?.disableCommands(); host?.revokeApprovalEnrollment(); io.setApprovalMode?.('manual')
        accountGeneration = randomUUID(); chatgptModels.clear()
        for (const id of knownModels.keys()) if (id.startsWith('chatgpt:')) knownModels.delete(id)
        host?.invalidateContext(); io.setContext?.(undefined, false)
      }
      return { ...base, provider: 'chatgpt', chatgptAccountId: account.id,
        model: '', reasoning: 'default', reasoningCapabilities: [], enableTools: false }
    }
    const current = await loadKey(provider)
    if (io.isClosed) return
    const action = current ? await io.choose(`${provider} API key`, [
      { name: 'Use current key', description: input.env[envName(provider)] ? 'From your environment; never copied to settings' : 'Already available for this launch', value: 'current' },
      { name: 'Enter a different key', description: 'Masked input; choose storage explicitly', value: 'enter' }
    ]) : 'enter'
    if (!action || io.isClosed) return
    if (action === 'enter') {
      if (!io.askSecret) { io.write(`Masked key input is unavailable. Set ${envName(provider)} in your environment\n`); return }
      const status = await credentials.status()
      if (io.isClosed) return
      const mode = await io.choose('API key storage', [
        ...(status.available ? [{ name: `Save in ${status.label}`, description: 'Available on your next launch; never stored in settings or transcripts', value: 'save' }] : []),
        { name: 'Use for this launch only', description: status.available ? 'You’ll need to enter it again next time' : `${status.detail ?? status.label}. No plaintext fallback`, value: 'temporary' }
      ])
      if (!mode || io.isClosed) return
      const entered = await io.askSecret(`${provider} API key · masked · Escape cancels`)
      if (entered === undefined || io.isClosed) return
      register(entered)
      const key = validateApiKey(entered)
      register(key)
      if (mode === 'save') {
        try { await credentials.save(provider, key); io.write(`API key saved in ${status.label}\n`) }
        catch (error) {
          report(error)
          const fallback = await io.choose('Key storage could not be verified', [{ name: 'Cancel setup', description: 'The OS vault may already contain this key; its state was not verified', value: false },
            { name: 'Use it for this launch only', description: 'The OS vault may already contain this key; no plaintext file will be created', value: true }])
          if (!fallback) return
        }
      } else io.write('API key is available for this launch only\n')
      // A cancelled model picker can follow a real key replacement. Revoke
      // enrollment immediately and prevent the old host from re-enrolling.
      if (env[envName(provider)] !== key) {
        await host?.disableCommands()
        host?.setApprovalMode('manual')
        io.setApprovalMode?.('manual')
        accountGeneration = randomUUID()
        for (const id of knownModels.keys()) if (id.startsWith(`${provider}:`)) knownModels.delete(id)
        host?.invalidateContext(); io.setContext?.(undefined, false)
      }
      env[envName(provider)] = key
    }
    return provider === base.provider ? { ...base } : { ...base, provider, model: '', reasoning: 'default',
      reasoningCapabilities: [], enableTools: false }
  }
  const chooseModel = async (base: TuiPreferences): Promise<TuiPreferences | undefined> => {
    const key = base.provider === 'chatgpt' ? base.chatgptAccountId : await loadKey(base.provider)
    const controller = new AbortController()
    const dispose = io.onCancel(() => controller.abort())
    let result
    try { io.write(`Loading ${base.provider} models…\n`); result = await catalog.list(base.provider, key, controller.signal) }
    catch (error) { if (!controller.signal.aborted) report(error); if (modelAccessDenied(error)) return }
    finally { dispose() }
    if (io.isClosed || controller.signal.aborted) return
    if (!result) {
      if (base.provider === 'chatgpt' || !base.model || base.provider === 'openai' && documentedOpenAIModel(base.model).conversation === 'unsupported') {
        io.write('No compatible model catalog available. Check /provider and try /models again\n'); return
      }
      const keep = await io.choose('Model catalog unavailable', [
        { name: `Keep ${base.model}`, description: 'Saved selection; availability and capabilities are unverified', value: true },
        { name: 'Cancel', value: false }
      ])
      return keep ? settingsForModel(base, unknownModel(base.model)) : undefined
    }
    const remember = (): void => {
      for (const key of knownModels.keys()) if (key.startsWith(`${base.provider}:`)) knownModels.delete(key)
      host?.invalidateContext(); io.setContext?.(undefined, false)
      for (const model of result!.models) knownModels.set(modelKey(base.provider, model.id, base.chatgptAccountId), model)
    }
    remember()
    if (result.warning) io.write(`${result.warning}. Showing a stale cached catalog\n`)
    else if (result.state === 'cached') io.write('Using the cached model catalog (up to 15 minutes old)\n')
    let search = ''
    for (;;) {
      const choices = result.models.map(model => ({ name: base.provider === 'chatgpt' ? model.name : model.id,
        description: `${model.name} · conversation ${model.conversation} · tools ${model.tools} · reasoning ${model.reasoning}`,
        searchTerms: [model.name, base.provider], value: model.id }))
      const selection = await io.chooseSearchable(`Models · ${base.provider} · ${result.state}`, choices,
        { query: search, initialIndex: Math.max(0, choices.findIndex(choice => choice.value === base.model)), refresh: true })
      if (selection === undefined) return
      search = selection.query
      if (selection.kind === 'refresh') {
        const refreshController = new AbortController()
        const cleanup = io.onCancel(() => refreshController.abort())
        try {
          io.write(`Refreshing ${base.provider} models…\n`)
          result = await catalog.list(base.provider, key, refreshController.signal, true)
          remember()
          if (result.warning) io.write(`${result.warning}. Showing stale cached models\n`)
        } catch (error) { if (!refreshController.signal.aborted) report(error); if (modelAccessDenied(error)) return }
        finally { cleanup() }
        if (io.isClosed || refreshController.signal.aborted) return
        continue
      }
      const model = result.models.find(model => model.id === selection.value)
      if (!model) continue
      if (model.conversation === 'unknown') {
        const use = await io.choose(`Text conversation compatibility is unverified · ${model.id}`, [
          { name: 'Back to models', description: 'Choose a documented conversation model', value: false },
          { name: 'Use this unverified model', description: `This provider’s catalog does not verify compatibility with ${base.provider === 'openai' ? 'Responses' : 'text chat'}. Requests may fail`, value: true }
        ])
        if (!use) continue
      }
      let declaredTools = false
      if (base.provider === 'chatgpt' && model.tools === 'unknown') {
        const use = await io.choose(`Function-tool support is not advertised · ${model.name}`, [
          { name: 'Use chat only', description: 'Default; do not assume tool support', value: false },
          { name: 'Enable host function tools', description: 'I verified this model supports function tools. Requests may still be rejected by account/workspace policy', value: true }
        ])
        if (use === undefined || io.isClosed) return
        declaredTools = use
        if (use) declaredToolModels.add(modelKey(base.provider, model.id, base.chatgptAccountId))
      }
      if (model.tools === 'unknown' && !declaredTools) io.write('Tool capabilities are unknown; this model will use chat only\n')
      if (model.reasoning === 'unknown') io.write('Reasoning capabilities are unknown; using provider default\n')
      return { ...settingsForModel(base, model), ...(declaredTools ? { enableTools: true } : {}) }
    }
  }
  const save = async (next: TuiPreferences, changed: { notes?: boolean; memory?: boolean } = {}): Promise<void> => {
    // Active model controls must preserve independently chosen future-only defaults.
    const defaults = { ...next, ...(settings.webProvider ? { webProvider: settings.webProvider } : {}), enableNotes: changed.notes ? next.enableNotes : settings.enableNotes,
      enableMemory: changed.memory ? next.enableMemory : settings.enableMemory }
    if (settings.autoReviewThresholds) defaults.autoReviewThresholds = settings.autoReviewThresholds
    await preferences.save(defaults); settings = defaults
  }
  const configureProviderModel = async (): Promise<void> => {
    const configured = await setupProvider(activeSettings ?? settings)
    if (!configured || io.isClosed) return
    const model = await chooseModel(configured)
    if (io.isClosed) return
    if (model) { await save(model); selected = { fresh: true, preservePlan: true } }
    else if ((!host && configured.provider !== settings.provider) || configured.provider === 'chatgpt') {
      // Keep a completed provider choice after cancelling model selection, so
      // /models can continue setup without a wizard loop or storing credentials.
      await save(configured); if (!host) io.setDraft?.(configured.provider)
    }
  }
  const configureChatGptAccount = async (): Promise<void> => {
    const current = host?.session.provider === 'chatgpt' ? host.session.chatgptAccountId : settings.chatgptAccountId
    const accounts = await chatgptAuth.listAccounts()
    const active = accounts.find(account => account.id === current)
    if (active) io.write(chatGptPlanStatus(active))
    const action = await io.choose('ChatGPT account controls', [
      { name: 'Back', value: 'back' },
      { name: 'Choose account / Continue with ChatGPT', description: 'Account and workspace changes start a fresh conversation', value: 'choose' },
      ...(active?.signedIn ? [{ name: 'Sign out this ChatGPT account', description: 'Stop owned commands, revoke renewable session and clear local tokens', value: 'logout' }] : []),
      { name: 'Manage usage', description: CHATGPT_USAGE_URL, value: 'usage' }
    ])
    if (!action || action === 'back' || io.isClosed) return
    if (action === 'usage') { io.write(`Manage ChatGPT usage: ${CHATGPT_USAGE_URL}\n`); return }
    if (action === 'logout' && active) {
      host?.revokeApprovalEnrollment(); io.setApprovalMode?.('manual'); accountGeneration = randomUUID()
      await host?.disableCommands()
      const result = await chatgptAuth.signOut(active.id)
      chatgptModels.clear(); for (const key of knownModels.keys()) if (key.startsWith('chatgpt:')) knownModels.delete(key)
      host?.invalidateContext(); io.setContext?.(undefined, false)
      io.write(result.revoked ? 'ChatGPT signed out. Renewable session revoked; local tokens cleared.\n'
        : 'ChatGPT signed out locally. Remote revocation is unconfirmed; review connected apps in ChatGPT settings.\n')
      return
    }
    const account = await chooseChatGptAccount(io, chatgptAuth, current)
    if (!account || io.isClosed) return
    host?.revokeApprovalEnrollment(); io.setApprovalMode?.('manual'); accountGeneration = randomUUID()
    await host?.disableCommands(); chatgptModels.clear()
    for (const key of knownModels.keys()) if (key.startsWith('chatgpt:')) knownModels.delete(key)
    host?.invalidateContext(); io.setContext?.(undefined, false)
    const configured = { ...(activeSettings ?? settings), provider: 'chatgpt' as const, chatgptAccountId: account.id,
      model: '', reasoning: 'default', reasoningCapabilities: [], enableTools: false }
    const model = await chooseModel(configured)
    if (model) { await save(model); selected = { fresh: true, preservePlan: true } }
    else { await save(configured); if (!host) io.setDraft?.('chatgpt') }
  }
  const webConfiguration = async (): Promise<CliWebConfiguration> => {
    const provider = settings.webProvider ?? 'direct'
    if (provider !== 'deepseek') return { provider }
    if (!webKey) {
      try { webKey = await credentials.load('deepseek-web'); if (webKey) register(webKey) }
      catch (error) { report(error) }
    }
    const key = webKey, revision = webGeneration
    return { provider: 'deepseek', revision, apiKey: () => {
      if (!key) throw new Error('Configure a separate DeepSeek web key with /web')
      return key
    } }
  }
  const configureWeb = async (): Promise<void> => {
    const provider = await io.choose('Web provider · independent of chat', [
      { name: 'Direct', description: 'Keyless public HTTPS fetch; no search or JavaScript', value: 'direct' as const },
      { name: 'DeepSeek', description: 'Paid search and fetch with a separate key and disclosure', value: 'deepseek' as const },
      { name: 'Disabled', description: 'No web tools', value: 'disabled' as const }
    ], ['direct', 'deepseek', 'disabled'].indexOf(settings.webProvider ?? 'direct'))
    if (!provider || io.isClosed) return
    if (provider === 'deepseek') {
      io.write(`${DEEPSEEK_WEB_DISCLOSURE}\n`)
      // Deliberate paid-provider opt-in is separate from each Manual/Auto request approval.
      const use = await io.choose('Enable paid DeepSeek web?', [
        { name: 'Cancel', value: false }, { name: 'Configure DeepSeek web', description: 'Separate from chat; each request follows the selected review mode', value: true }
      ])
      if (!use || io.isClosed) return
      if (!webKey) { try { webKey = await credentials.load('deepseek-web'); if (webKey) register(webKey) } catch (error) { report(error) } }
      const key = await chooseSecureKey(io, credentials, { slot: 'deepseek-web', title: 'DeepSeek web',
        ...(webKey ? { current: webKey } : {}),
        ...(env.DEEPSEEK_API_KEY ? { reuse: { label: 'Reuse my DeepSeek chat key for web', key: env.DEEPSEEK_API_KEY } } : {}), register })
      if (!key || io.isClosed) return
      webKey = key; webGeneration = randomUUID()
    }
    await preferences.save({ ...settings, webProvider: provider })
    settings = { ...settings, webProvider: provider }
    host?.setWebConfiguration(await webConfiguration())
    io.setApprovalMode?.('manual'); io.setContext?.(undefined, false)
    io.write(`Web provider: ${provider}. Unattended enrollment revoked; chat provider is ${host?.session.provider ?? settings.provider}.\n`)
  }
  const configureReviewer = async (): Promise<boolean> => {
    if (!host) { io.write('Choose a chat model before selecting this conversation’s reviewer\n'); return false }
    const provider = await io.choose('Auto reviewer · this conversation only', [
      { name: 'None', description: 'Manual and Plan remain available', value: 'none' as const },
      { name: 'OpenAI', description: 'Fixed gpt-6-luna review model; explicit account selection', value: 'openai' as const },
      { name: 'OpenRouter', description: 'Fixed typesafe/jev-1.13 reviewer; sends data to OpenRouter and TypeSafe', value: 'openrouter' as const }
    ], host.reviewProvider === 'openai' ? 1 : host.reviewProvider === 'openrouter' ? 2 : 0)
    if (!provider || io.isClosed) return false
    if (provider === 'none') { host.setDecisionReview(undefined); io.setApprovalMode?.('manual'); io.write('Auto reviewer: none\n'); return false }
    const reviewerKey = reviewerKeys.get(provider)
    const current = reviewerKey ?? await loadKey(provider)
    const key = await chooseSecureKey(io, credentials, { slot: provider, title: `${provider} reviewer`,
      ...(current ? { current, currentDescription: reviewerKey ? 'Explicit reviewer key selected during this launch' : 'Existing environment or OS provider key; explicitly choose it for review' } : {}),
      storageDescription: 'Replaces this provider’s saved OS key and may change future chat launches; never plaintext settings', register })
    if (!key || io.isClosed) return false
    reviewerKeys.set(provider, key)
    reviewerGeneration = randomUUID()
    const generation = reviewerGeneration, selectedHost = host
    const reviewEnv = { ...env, [envName(provider)]: key }
    const reviewSession = { ...host.session, provider }
    host.setDecisionReview({ provider: deferredDecisionProvider(reviewSession, reviewEnv, input.decisionProviderFactory ?? decisionProviderForSession),
      explicitReviewer: true, ledger: decisions, canAutoReview: io.canAutoReview === true,
      autoReviewThresholds: settings.autoReviewThresholds ?? {},
      accountRevision: () => generation, isAvailable: () => thresholdPreferencesAvailable && io.canAutoReview === true && !io.isClosed && host === selectedHost && reviewerGeneration === generation })
    io.setApprovalMode?.('manual')
    io.write(`Auto reviewer: ${provider}, this conversation only. Use /mode for fresh enrollment.\n`)
    return true
  }
  const configureAutoThreshold = async (line: string): Promise<void> => {
    const selectedHost = host, provider = selectedHost?.reviewProvider
    if (!selectedHost || !provider) { io.write('Choose this conversation’s Auto reviewer with /reviewer first\n'); return }
    if (io.canAutoReview !== true || io.isClosed || selectedHost.running || options.prompt !== undefined) {
      io.write('Auto threshold changes require an idle interactive conversation; no setting changed\n'); return
    }
    const binding = selectedHost.approvalEnrollmentBinding, previous = selectedHost.autoReviewThresholds
    const settingsRevision = reviewDigest(settings.autoReviewThresholds ?? {})
    const argument = line.trim().replace(/^\/auto-threshold\s*/, '')
    let next = { ...previous }
    if (!argument) {
      const picked = await chooseAutoReviewThreshold(io, provider, previous)
      if (!picked) return
      next = picked
    } else if (argument === 'default') delete next[provider]
    else next[provider] = parseAutoReviewThresholdPercent(argument)
    if (host !== selectedHost || provider !== selectedHost.reviewProvider || io.isClosed || io.canAutoReview !== true || selectedHost.running ||
      binding !== selectedHost.approvalEnrollmentBinding || settingsRevision !== reviewDigest(settings.autoReviewThresholds ?? {})) {
      io.write('Auto threshold context changed; reopen /auto-threshold. No setting changed\n'); return
    }
    // Revoke before persistence; failed settings writes cannot leave relaxed Auto authority.
    selectedHost.setAutoReviewThresholds(next); selectedHost.setApprovalMode('manual'); io.setApprovalMode?.('manual')
    const appliedBinding = selectedHost.approvalEnrollmentBinding
    try { await preferences.save({ ...settings, autoReviewThresholds: next }) }
    catch (error) {
      if (host === selectedHost && !selectedHost.running && selectedHost.approvalEnrollmentBinding === appliedBinding) selectedHost.setAutoReviewThresholds(previous)
      throw error
    }
    settings = { ...settings, autoReviewThresholds: next }; thresholdPreferencesAvailable = true
    io.write(`Auto threshold: ${provider} ${formatAutoReviewThreshold(resolveAutoReviewThreshold(provider, next).allowPermille)} saved. Auto enrollment revoked; use /mode for fresh consent.\n`)
  }
  const configureNotes = async (): Promise<void> => {
    const enableNotes = await io.choose('Session notes · new-conversation default', [
      { name: 'Disable session notes by default', description: 'Other supported tools remain available', value: false },
      { name: 'Enable session notes by default', description: 'Requires model tool support; writes are reviewed', value: true }
    ], settings.enableNotes ? 1 : 0)
    if (enableNotes === undefined || io.isClosed) return
    await save({ ...settings, enableNotes }, { notes: true })
    io.write('Session-note default saved for new conversations. Use /new when ready\n')
  }
  const configureMemoryDefault = async (): Promise<void> => {
    const enableMemory = await io.choose('Persistent memory default · future launches', [
      { name: 'Disable memory by default', description: 'No saved memory is read or sent unless you enable it', value: false },
      { name: 'Enable memory by default', description: MEMORY_DISCLOSURE, value: true }
    ], settings.enableMemory ? 1 : 0)
    if (enableMemory === undefined || io.isClosed) return
    await save({ ...settings, enableMemory }, { memory: true })
    io.write('Memory default saved for future launches; this launch is unchanged\n')
  }
  const selectResume = async (): Promise<string | undefined> => {
    const sessions = await listSessions(store)
    const choices = sessions.filter(session => !session.locked).map(session => ({
      name: session.title, description: `${formatSessionDate(session.updatedAt)} · ${session.model} · ${session.provider} · ${session.id}`, value: session.id
    }))
    if (!choices.length) { io.write('No unlocked valid sessions found. Check the previous process before removing a session lock\n'); return }
    return io.choose('Resume a local session', choices)
  }
  const manageMemories = async (): Promise<void> => {
    io.write(`${MEMORY_DISCLOSURE}\n`)
    for (;;) {
      if (io.isClosed) return
      let snapshot: Awaited<ReturnType<CliHost['listMemories']>> | undefined
      if (activeMemory && host) {
        try { snapshot = await host.listMemories(); displayMemories(io, snapshot) }
        catch (error) { report(error) }
      }
      if (activeMemory && !host) io.write('Choose a model with /models before listing or changing saved memories\n')
      const choices = [{ name: 'Back', description: 'Return to the conversation without changing memory', value: 'back' },
        ...(activeMemory ? [{ name: 'Disable for this launch', description: 'Stop using saved context; retain existing records', value: 'off' }]
          : [{ name: 'Enable for this launch', description: MEMORY_DISCLOSURE, value: 'on' }]),
        { name: 'Future launch default', description: `Memory ${settings.enableMemory ? 'enabled' : 'disabled'} by default; this launch is unchanged`, value: 'default' },
        ...(activeMemory && host ? [
          { name: 'Refresh memories', description: 'Reload current app-wide records', value: 'refresh' },
          ...(snapshot ? [{ name: 'Add memory', description: 'Enter content, then review the exact proposed change', value: 'add' },
            ...(snapshot.memories.length ? [{ name: 'Edit memory', description: 'Choose a displayed ID and revision', value: 'edit' },
              { name: 'Delete memory', description: 'Choose a displayed ID and revision, then review deletion', value: 'delete' }] : [])] : [])
        ] : [])]
      const action = await io.choose(`Persistent memories · ${activeMemory ? 'enabled' : 'disabled'} for this launch`, choices)
      if (action === undefined || action === 'back') return
      if (action === 'default') { await configureMemoryDefault(); continue }
      if (action === 'on' || action === 'off') {
        activeMemory = action === 'on'; host?.setMemoryEnabled(activeMemory); io.setContext?.(undefined, host?.canCompact ?? false)
        io.write(activeMemory ? 'Memory enabled for this launch\n' : 'Memory disabled for this launch; existing records retained\n')
        continue
      }
      if (action === 'refresh' || !host || !snapshot) continue
      try {
        if (action === 'add') {
          const content = await io.askText('New app-wide memory · Escape cancels')
          if (content !== undefined && content.trim()) await reviewMemoryChange(host, io, { kind: 'create', content })
          continue
        }
        const index = await io.choose(`Choose memory to ${action}`, [
          { name: 'Back', description: 'No memory change', value: -1 },
          ...snapshot.memories.map((item, index) => ({ name: item.id,
            description: `revision ${item.revision} · ${JSON.stringify(item.content)}`, value: index }))
        ])
        if (index === undefined || index < 0) continue
        const selectedMemory = snapshot.memories[index]
        if (!selectedMemory) continue
        if (action === 'edit') {
          const content = await io.askText(`Edit ${selectedMemory.id} · revision ${selectedMemory.revision} · Escape cancels`, selectedMemory.content)
          if (content !== undefined && content.trim()) await reviewMemoryChange(host, io,
            { kind: 'update', id: selectedMemory.id, expectedRevision: selectedMemory.revision, content })
        } else if (action === 'delete') await reviewMemoryChange(host, io,
          { kind: 'delete', id: selectedMemory.id, expectedRevision: selectedMemory.revision })
      } catch (error) { report(error) }
      // Reload after approval, cancellation or conflicts; never reuse a stale edit revision.
    }
  }
  const manageSkills = async (): Promise<void> => {
    io.write(`${SKILLS_DISCLOSURE}\n`)
    for (;;) {
      if (io.isClosed) return
      let snapshot: Awaited<ReturnType<CliHost['listSkills']>> | undefined
      if (activeSkills) {
        try { snapshot = await skills.snapshot(); displaySkills(io, snapshot, skills.diagnostics) }
        catch (error) { report(error) }
      }
      const action = await io.choose(`Skills · ${activeSkills ? 'enabled' : 'disabled'} for this launch`, [
        { name: 'Back', description: 'Return to the conversation', value: 'back' },
        { name: activeSkills ? 'Disable for this launch' : 'Enable for this launch', description: SKILLS_DISCLOSURE, value: 'toggle' },
        ...(activeSkills ? [{ name: 'Refresh skills', description: 'Reload metadata and diagnostics', value: 'refresh' },
          ...(snapshot?.skills.length ? [{ name: 'Inspect SKILL.md', description: 'View exact source as inert text', value: 'inspect' }] : []),
          { name: 'Create with agent', description: 'Put a reviewed-save skill request in the composer', value: 'create' }] : [])
      ])
      if (action === undefined || action === 'back') return
      if (action === 'toggle') { activeSkills = !activeSkills; host?.setSkillsEnabled(activeSkills); io.setContext?.(undefined, host?.canCompact ?? false); continue }
      if (action === 'inspect' && snapshot) {
        const name = await io.choose('Inspect a skill', [{ name: 'Back', value: '' },
          ...snapshot.skills.map(skill => ({ name: skill.name, description: `${skill.readOnly ? 'read only · ' : ''}${skill.description}`, value: skill.name }))])
        if (name) {
          const content = snapshot.document(name)!.content
          const pages = Math.max(1, Math.ceil(content.length / 8192))
          let page = 0
          for (;;) {
            io.write(`SKILL.md ${JSON.stringify(name)} · page ${page + 1}/${pages} (inert exact-source portion):\n${JSON.stringify(content.slice(page * 8192, (page + 1) * 8192))}\n`)
            const navigation = await io.choose('Inspect SKILL.md', [{ name: 'Close', value: 'close' },
              ...(page > 0 ? [{ name: 'Previous page', value: 'previous' }] : []),
              ...(page + 1 < pages ? [{ name: 'Next page', value: 'next' }] : [])])
            if (navigation === undefined || navigation === 'close') break
            page += navigation === 'next' ? 1 : -1
          }
        }
      } else if (action === 'create') {
        if (!host) { io.write('Choose a provider and model before drafting a skill\n'); continue }
        const description = await io.askText('What should the new skill do? · Escape cancels')
        if (description?.trim()) {
          const prompt = skillCreationPrompt(description)
          if (io.setComposerDraft) io.setComposerDraft(prompt)
          else io.write(`Send this request to draft the skill:\n${prompt}\n`)
          return
        }
      }
    }
  }
  const openSession = async (selection: { resume?: string; fresh?: boolean; preservePlan?: boolean }): Promise<boolean> => {
    if (!selection.resume && !settings.model) return false
    const capabilityNotice = selection.resume ? undefined : await hydrateModel()
    if (capabilityNotice === false) return false
    await host?.drainMemory()
    await host?.drainSkills()
    const fresh = selection.resume ? undefined : newSession({ provider: settings.provider, model: settings.model, reasoning: settings.reasoning,
      ...(settings.provider === 'chatgpt' && settings.chatgptAccountId ? { chatgptAccountId: settings.chatgptAccountId } : {}) })
    const nextRelease = await store.acquire(selection.resume ?? fresh!.id)
    candidate = { release: nextRelease }
    let nextHost: CliHost, nextSettings: TuiPreferences
    const previousRelease = release, previousHost = host
    try {
      const session = selection.resume ? await store.load(selection.resume) : fresh!
      if (session.provider === 'chatgpt') {
        const account = await chatgptAuth.select(session.chatgptAccountId!)
        if (!account.planUsageEnabled) throw new Error('ChatGPT plan usage is disabled. Use /account to enable it or explicitly choose another provider')
        if (host?.session.chatgptAccountId !== session.chatgptAccountId) chatgptModels.clear()
        await confirmChatGptWelcome(io, chatgptAuth, account)
      }
      const sameModel = session.provider === settings.provider && session.model === settings.model
      const explicitResume = session.id === options.resume
      let metadata = knownModels.get(modelKey(session.provider, session.model, session.chatgptAccountId)) ??
        (session.provider === 'openai' ? documentedOpenAIModel(session.model) : undefined)
      if (!metadata && selection.resume) {
        const key = session.provider === 'chatgpt' ? session.chatgptAccountId : await loadKey(session.provider), controller = new AbortController()
        const dispose = io.onCancel(() => controller.abort())
        try {
          const hydrated = await hydrateModelCapabilities(catalog, session.provider, session.model, key, controller.signal)
          metadata = hydrated.model
          if (session.provider === 'chatgpt' && !hydrated.catalog?.models.some(model => model.id === session.model)) throw new Error('This model is not listed for the selected ChatGPT account. Choose a current model with /models')
          knownModels.set(modelKey(session.provider, session.model, session.chatgptAccountId), metadata)
        } catch (error) { if (modelAccessDenied(error) || session.provider === 'chatgpt') throw error; if (!controller.signal.aborted) report(error) }
        finally { dispose() }
        if (controller.signal.aborted || io.isClosed) { await discardCandidate(); return false }
      }
      if (metadata?.conversation === 'unsupported') throw new Error('This model is incompatible with vivi’s text-conversation endpoint. Choose a supported model with /models')
      let capabilities = explicitResume && args.includes('--reasoning-capabilities') ? options.reasoningCapabilities
        : metadata?.reasoning === 'supported' ? metadata.efforts : sameModel ? settings.reasoningCapabilities : []
      if (session.reasoning && session.reasoning !== 'default' && !capabilities.includes(session.reasoning as ReasoningEffort)) {
        const declared = await io.choose(`Resume requires verified support for reasoning '${session.reasoning}'`, [
          { name: 'Cancel resume', value: false }, { name: 'I verified this model supports that effort', value: true }
        ])
        if (!declared) { await discardCandidate(); return false }
        capabilities = [session.reasoning as ReasoningEffort]
      }
      const declaredTools = args.includes('--tools') &&
        (explicitResume || session.provider === declaredToolTarget.provider && session.model === declaredToolTarget.model) ||
        declaredToolModels.has(modelKey(session.provider, session.model, session.chatgptAccountId))
      const enableTools = modelToolsEnabled(metadata, { disabled: args.includes('--no-tools'),
        declared: declaredTools, enabled: !sameModel || settings.enableTools })
      const effective: CliOptions = { ...options, reasoningCapabilities: capabilities,
        ...(session.provider === 'chatgpt' ? { chatgptAuth } : {}),
        stream: metadata?.streaming === 'unsupported' ? false : settings.stream,
        enableTools, enableNotes: enableTools && settings.enableNotes,
        enableMemory: activeMemory, enableSkills: activeSkills,
        maxRounds: settings.maxRounds }
      await loadKey(session.provider)
      if (io.isClosed) { await discardCandidate(); return false }
      const selectedReviewer = options.reviewer === 'none' ? undefined : options.reviewer ?? (isReviewProvider(session.provider) ? session.provider : undefined)
      if (options.reviewer && selectedReviewer) await loadKey(selectedReviewer)
      const images = new FileImageAssets(join(options.sessionDirectory, 'images'), session.id)
      effective.imageAssets = images
      effective.imageCapability = metadata?.vision ?? 'unknown'
      if (metadata?.modelCapabilities) effective.imageModelCapabilities = metadata.modelCapabilities
      const generation = accountGeneration
      const accountAvailable = (): boolean => session.provider !== 'chatgpt' || accountGeneration === generation
      if (session.provider === 'chatgpt') effective.chatgptIsCurrent = accountAvailable
      const rawProvider = providerFactory(session, effective, env)
      const provider = session.provider === 'chatgpt' ? bindChatGptAccount(rawProvider, {
        isCurrent: () => accountGeneration === generation && !io.isClosed,
        invalidate: async () => {
          if (accountGeneration !== generation) return
          accountGeneration = randomUUID(); chatgptModels.clear()
          for (const key of knownModels.keys()) if (key.startsWith('chatgpt:')) knownModels.delete(key)
          nextHost.revokeApprovalEnrollment(); nextHost.invalidateContext(); io.setApprovalMode?.('manual'); io.setContext?.(undefined, false)
          io.write('ChatGPT account access needs attention. Unattended permissions revoked; stopping owned background commands. Credentials were not deleted solely because inference was denied.\n')
          await nextHost.stopAllBackgroundCommands()
        }
      }) : rawProvider
      const web = await webConfiguration()
      if (io.isClosed) { await discardCandidate(); return false }
      nextHost = new CliHost({ provider, images, imageCapability: metadata?.vision ?? 'unknown', ...(metadata?.modelCapabilities ? { imageModelCapabilities: metadata.modelCapabilities } : {}), web, store, session, secrets, getContextLimits: () => contextLimitsForModel(knownModels.get(modelKey(session.provider, session.model, session.chatgptAccountId)) ??
        (session.provider === 'openai' ? documentedOpenAIModel(session.model) : undefined)), mcp, mcpSetup, onMcpNotice: message => io.write(`${message}\n`), onConversationNotice: message => io.write(`${message}\n`), enableTools: effective.enableTools,
        enableNotes: effective.enableNotes, enableCommands: activeCommands, enableMemory: activeMemory, memory, enableSkills: activeSkills, skills,
        permissionApproval: { accountRevision: () => accountGeneration, isAvailable: () => accountAvailable() && io.canAutoReview === true && !io.isClosed },
        skillSaveApproval: { isAvailable: () => accountAvailable() && io.canAutoReview === true && !io.isClosed, accountRevision: () => accountGeneration },
        onSkillsNotice: message => io.write(`${message}\n`), ...(workspace ? { workspace } : {}), maxRounds: effective.maxRounds,
        ...(workspace ? { commandWorkspaceFactory: () => TrustedCommandWorkspace.open(workspace.directory, commandEnv, secrets), commandApproval: { accountRevision: () => accountGeneration,
          isAvailable: () => accountAvailable() && io.canAutoReview === true && !io.isClosed } } : {}),
        onMemoryNotice: message => io.write(`${message}\n`),
        onReviewNotice: (message, context) => io.reviewNotice ? io.reviewNotice(message, context) : io.write(`${message}\n`),
        ...(io.canAutoReview === true && selectedReviewer ? { decisionReview: {
          provider: deferredDecisionProvider({ ...session, provider: selectedReviewer }, env, input.decisionProviderFactory ?? decisionProviderForSession),
          ...(options.reviewer ? { explicitReviewer: true as const } : {}),
          ledger: decisions, canAutoReview: true, accountRevision: () => accountGeneration,
          autoReviewThresholds: settings.autoReviewThresholds ?? {},
          isAvailable: () => accountAvailable() && thresholdPreferencesAvailable && io.canAutoReview === true && !io.isClosed
        } } : {}),
        ...(io.canAskQuestions === true && io.askQuestions ? { questionHost: {
          ask: (request, { signal }) => io.askQuestions!(request, signal),
          isAvailable: () => accountAvailable() && io.canAskQuestions === true && !io.isClosed,
          accountRevision: () => accountGeneration
        } } : {}),
        approve: (request, signal) => io.approve(request, signal), onEvent: event => io.event(event) })
      candidate.host = nextHost
      if (selection.preservePlan && previousHost?.taskMode === 'plan') nextHost.setTaskMode('plan')
      await nextHost.initialize()
      if (workspace && !effective.enableTools) io.write('Workspace tools are unavailable for this model; choose a tool-capable model to read files\n')
      if (io.isClosed) { await discardCandidate(); return false }
      nextSettings = { ...settings, provider: session.provider, model: session.model,
        ...(session.provider === 'chatgpt' ? { chatgptAccountId: session.chatgptAccountId! } : {}),
        reasoning: session.reasoning ?? 'default', reasoningCapabilities: [...capabilities],
        enableTools: effective.enableTools, enableNotes: settings.enableNotes }
      try { await previousHost?.shutdown() }
      catch (error) { sessionCleanupFailed = true; throw error }
      if (io.isClosed) { await discardCandidate(); return false }
    } catch (error) { await discardCandidate(); throw error }
    releaseProcesses?.()
    release = nextRelease; host = nextHost; hostAccountGeneration = accountGeneration
    releaseProcesses = bindBackgroundProcessControls(host, io)
    activeSettings = nextSettings; candidate = undefined
    await previousRelease?.().catch(report)
    await refreshChatContext(host, io)
    io.setToolEvidence?.(host.toolPresentationEvidence)
    io.setConversationErrors?.(host.conversationErrors)
    io.setSession(host.session)
    io.setContext?.(host.contextUsage, host.canCompact)
    io.setTaskMode?.(host.taskMode)
    io.setApprovalMode?.('manual')
    io.write(host.taskMode === 'plan' ? 'Mode: Plan · local-read task policy preserved; unattended enrollment revoked\n' : 'Approval mode: Manual\n')
    // Native transcript setup clears earlier loading output. Keep stale-cache
    // disclosure visible after that rebuild and before the first provider turn.
    if (capabilityNotice) io.write(capabilityNotice)
    if (host.session.provider === 'chatgpt') {
      const account = (await chatgptAuth.listAccounts()).find(account => account.id === host!.session.chatgptAccountId)
      if (account) io.write(chatGptPlanStatus(account))
    }
    return true
  }
  let workspaceNoticePending = true
  try {
    if (activeSkills) io.write(`${SKILLS_DISCLOSURE}\n`)
    if (activeMemory) io.write(`Memory enabled for this launch\n${MEMORY_DISCLOSURE}\n`)
    // Every launch begins in a clean composer, even before the first provider setup.
    if (!settings.model) {
      if (io.setDraft) io.setDraft(settings.provider)
      else if (settings.provider !== 'chatgpt' || settings.chatgptAccountId) io.setSession(newSession({ provider: settings.provider,
        ...(settings.provider === 'chatgpt' && settings.chatgptAccountId ? { chatgptAccountId: settings.chatgptAccountId } : {}), model: 'Choose a model with /models' }))
    }
    if (!settings.model) io.write('vivi · fresh conversation · use /provider to set up, then /models and /effort\n')
    // Offer the existing minimal setup once per unconfigured interactive launch.
    // Cancellation returns to a clean composer; explicit commands can retry.
    if (!settings.model && !options.resume && options.prompt === undefined && !io.isClosed) {
      try { await configureProviderModel() } catch (error) { report(error) }
    }
    for (;;) {
      if (io.isClosed) { if (io.failed) await io.readLine(''); return 0 }
      if (selected) {
        try { await openSession(selected) } catch (error) { report(error); if (options.prompt !== undefined) return 1 }
        // A failed shutdown may have partially revoked its owner. Do not run again.
        if (sessionCleanupFailed) return 1
        selected = undefined
      }
      if (io.isClosed) continue
      if (launchModePending && host) {
        launchModePending = false
        if (options.approvalMode === 'skip') {
          if (io.canAutoReview !== true || io.isClosed) io.write('Skip permissions requires a live interactive terminal and fresh confirmation. Using Manual; piped and headless launches cannot enroll.\n')
          else await selectApprovalMode(host, io, async () => 'skip', configureReviewer)
        } else await selectApprovalMode(host, io, (title, choices, initialIndex) => io.choose(title, choices, initialIndex), configureReviewer)
      } else if (launchModePending && io.canAutoReview !== true) {
        launchModePending = false
        io.write(`${AUTO_REVIEW_UNAVAILABLE}\n`)
      }
      // Session/draft setup rebuilds the native transcript; disclose after that, before any turn.
      if (workspaceNoticePending) {
        workspaceNoticePending = false
        if (workspace) io.write(`${USER_SHELL_DISCLOSURE}\nWorkspace: ${JSON.stringify(workspace.directory)} · reads and reviewed text edits for this launch\nFiles read by tools are sent to the selected provider and saved in session history\n`)
      }
      if (options.prompt !== undefined) {
        if (!host) { io.write('Choose a provider and model before running a prompt\n'); return 1 }
        if (options.prompt.trim() === '/compact') { return await compactChatContext(host, io) === 'cancelled' ? 130 : 0 }
        if (options.prompt.trim() === '/context') {
          await refreshChatContext(host, io)
          io.write(`${formatContextDetails(host.contextUsage, knownModels.get(modelKey(host.session.provider, host.session.model, host.session.chatgptAccountId)))}\n`)
          return 0
        }
        if (await runProcessControl(host, io, options.prompt)) return 0
        const controller = new AbortController()
        const dispose = io.onCancel(() => { controller.abort(); host!.cancel() })
        try {
          const result = await sendChatTurn(host, io, options.prompt, controller.signal)
          if (io.failed) await io.readLine('')
          io.result(result)
          return result.status === 'error' ? 1 : result.status === 'cancelled' ? 130 : 0
        } finally { dispose() }
      }
      let line = await io.readLine('Message')
      if (io.isClosed) continue
      if (line === undefined || line.trim() === '/exit') return 0
      let command = line.trim()
      if (command === '/menu' || command === '/settings') {
        const action = await io.choose('Conversation actions', [
          { name: 'Continue conversation', value: 'continue' }, { name: 'Chat provider', value: '/provider' },
          { name: 'ChatGPT accounts', description: 'Choose account/workspace or sign out', value: '/account' },
          { name: 'ChatGPT usage', description: CHATGPT_USAGE_URL, value: '/usage' },
          { name: 'Web provider', description: settings.webProvider ?? 'direct', value: '/web' },
          { name: 'Auto reviewer', description: host?.reviewProvider ?? 'None selected', value: '/reviewer' },
          { name: 'Auto threshold', description: host?.reviewProvider ? formatAutoReviewThreshold(resolveAutoReviewThreshold(host.reviewProvider, host.autoReviewThresholds).allowPermille) : 'Choose a reviewer first', value: '/auto-threshold' },
          { name: 'Choose model', value: '/models' }, { name: 'Reasoning effort', value: '/effort' },
          { name: 'New conversation', value: '/new' }, { name: 'Resume conversation', value: '/resume' },
          { name: 'Rename conversation', value: '/rename' },
          ...(host ? [{ name: 'Context details', description: 'Request occupancy, capacity and output reserve', value: '/context' }] : []),
          ...(host?.canCompact ? [{ name: 'Compact context', description: 'Summarize older provider context; retain the full transcript', value: '/compact' }] : []),
          { name: 'Mode', description: 'Manual / Auto review / Skip permissions / Plan', value: '/mode' },
          { name: 'Trusted commands', value: '/commands' },
          { name: 'Background processes', value: '/processes' },
          { name: 'Session notes', description: 'Default for new conversations', value: '/notes' },
          { name: 'Persistent memories', description: 'This launch and future-launch default', value: '/memories' },
          { name: 'Skills', value: '/skills' },
          { name: 'Project instructions', value: '/instructions' },
          { name: 'MCP connections', description: 'Trusted installed servers; human-reviewed tools and resource reads', value: '/mcp' },
          { name: 'Help', value: '/help' }, { name: 'Quit', value: '/exit' }
        ])
        if (!action || action === 'continue') continue
        if (action === '/exit') return 0
        command = action; line = action
      }
      try {
        if (host && /^\/queue(?:\s|$)/.test(line.trim())) {
          try { await runSteeringCommand(host, io, line) }
          finally { io.setSession(host.session) }
          continue
        }
        if (host?.queuedMessages.length && ['/new', '/resume', '/provider', '/account', '/models', '/effort'].includes(command)) {
          io.write('Send or clear this conversation’s queued messages with /queue before changing conversations\n')
          continue
        }
        if (command === '/new') {
          if (settings.model) selected = { fresh: true }
          else io.write('Use /provider and /models to configure this fresh conversation\n')
          continue
        }
        if (command === '/resume') { const id = await selectResume(); if (id && id !== host?.session.id) selected = { resume: id }; continue }
        if (/^\/rename(?:\s|$)/.test(command)) {
          if (!host) { io.write('Choose a model before naming a session\n'); continue }
          const current = host.session
          const supplied = command.replace(/^\/rename(?:\s+|$)/, '')
          const name = supplied || await io.askText('Session name · Escape cancels', sessionDisplayTitle(current))
          if (name === undefined) continue
          try { await host.renameSession(name, current.titleRevision ?? 0) }
          finally { io.setSession(host.session) }
          io.write(`Session renamed: ${sessionDisplayTitle(host.session)}\n`)
          continue
        }
        if (command === '/web') { await configureWeb(); continue }
        if (command === '/account') { await configureChatGptAccount(); continue }
        if (command === '/usage') { io.write(`Manage ChatGPT usage: ${CHATGPT_USAGE_URL}\n`); continue }
        if (command === '/reviewer') { await configureReviewer(); continue }
        if (/^\/auto-threshold(?:\s|$)/.test(command)) { await configureAutoThreshold(command); continue }
        if (command === '/provider') {
          await configureProviderModel()
          continue
        }
        if (command === '/models') { const model = await chooseModel(hostAccountGeneration === accountGeneration ? activeSettings ?? settings : settings); if (model) { await save(model); selected = { fresh: true, preservePlan: true } }; continue }
        if (command === '/effort') { const effort = await chooseEffort(io, hostAccountGeneration === accountGeneration ? activeSettings ?? settings : settings); if (effort) { await save(effort); selected = { fresh: true, preservePlan: true } }; continue }
        if (command === '/notes') { await configureNotes(); continue }
        if (/^\/instructions(?:\s|$)/.test(command)) {
          if (!host) { io.write('Choose a model before inspecting project instructions\n'); continue }
          try { await runInstructionsCommand(host, io, command) } finally { host.invalidateContext(); io.setContext?.(undefined, false) }
          continue
        }
        if (command === '/skills') {
          try { await manageSkills() } finally { host?.invalidateContext(); io.setContext?.(undefined, false) }
          continue
        }
        if (isMcpCommand(command)) {
          try { await runMcpCommand(io, command, { mcp: () => manageMcp(mcp, io, options.workspace, oauth) }) }
          finally { host?.invalidateContext(); io.setContext?.(undefined, false) }
          continue
        }
        if (command === '/memories') {
          try { await manageMemories() } finally { host?.invalidateContext(); io.setContext?.(undefined, false) }
          continue
        }
        if (/^\/processes(?:\s|$)/.test(command)) {
          if (!host) io.write('No background processes in this session\n')
          else await runProcessControl(host, io, command)
          continue
        }
        if (/^\/commands(?:\s|$)/.test(command)) {
          if (!host && /^\/commands\s+off$/.test(command)) {
            activeCommands = false
            io.write('Command proposals disabled for this launch\n')
            continue
          }
          if (!host) { io.write('Choose a provider and model before enabling trusted commands\n'); continue }
          await runCommandControl(host, io, command)
          io.setContext?.(undefined, host.canCompact)
          if (/^\/commands\s+off$/.test(command)) activeCommands = false
          else if (/^\/commands\s+on$/.test(command) && host.commandsEnabled) activeCommands = true
          continue
        }
        if (/^\/mode(?:\s|$)/.test(command)) {
          if (!host) { io.write('Choose a provider and model before selecting approval mode\n'); continue }
          if (hostAccountGeneration !== accountGeneration && command !== '/mode plan' && command !== '/mode manual' &&
            !(command === '/mode cycle' && host.taskMode === 'plan')) {
            host.setApprovalMode('manual'); io.setApprovalMode?.('manual')
            io.write('Approval mode: Manual. The selected account changed; use /new or /models before enrolling unattended permissions again\n')
            continue
          }
          await runModeControl(host, io, command, (title, choices, initialIndex) => io.choose(title, choices, initialIndex), configureReviewer)
          io.setContext?.(undefined, host.canCompact)
          continue
        }
        if (command === '/compact') {
          if (host && host.session.provider === 'chatgpt' && hostAccountGeneration !== accountGeneration) { io.write('The selected ChatGPT account changed. Use /new or /models before compacting; no request was sent.\n'); continue }
          if (!host) { io.write('Choose a provider and model before compacting context\n'); continue }
          await compactChatContext(host, io)
          continue
        }
        if (command === '/context') {
          if (!host) { io.write('Choose a model before measuring context\n'); continue }
          await refreshChatContext(host, io)
          io.write(`${formatContextDetails(host.contextUsage, knownModels.get(modelKey(host.session.provider, host.session.model, host.session.chatgptAccountId)))}\n`)
          continue
        }
        if (command === '/help') { io.write(COMMAND_HELP); continue }
        if (command === '/session') {
          const session = host?.session
          io.write(session ? `Session: ${session.id}\nName: ${sessionDisplayTitle(session)}\nMode: ${conversationModeLabel(host!.taskMode, host!.approvalMode)}\nSession tokens: ${formatUsage(session.usage)}\n${formatContextSummaryUsage(session)}${formatContextDetails(host!.contextUsage, knownModels.get(modelKey(session.provider, session.model, session.chatgptAccountId)))}\n`
            : 'Fresh conversation has no saved session until a model is selected\n')
          io.write(workspace ? `Workspace: ${JSON.stringify(workspace.directory)} · reads and reviewed text edits for this launch\n` : 'Workspace: disabled\n')
          continue
        }
        if (command.startsWith('/')) { io.write('Unknown slash command. Use /help or Tab completion\n'); continue }
        if (!line.trim()) continue
        if (!host) { io.write('Use /provider and /models before sending a message\n'); continue }
        if (hostAccountGeneration !== accountGeneration && (host.session.provider === 'chatgpt' || settings.provider === 'chatgpt')) { io.write('The selected account changed. Use /new or /models before sending another message; no previous-account request was sent.\n'); continue }
        const controller = new AbortController()
        const dispose = io.onCancel(() => { controller.abort(); host!.cancel() })
        try { const result = await sendChatTurn(host, io, line, controller.signal); io.result(result) }
        finally { dispose(); io.setSession(host.session) }
      } catch (error) { report(error) }
    }
  } finally {
    releaseProcesses?.()
    await discardCandidate()
    if (sessionCleanupFailed) {
      // Preserve the original failure and keep any incompletely shut-down owner locked.
      const reportCleanup = (error: unknown): void => { try { report(error) } catch { /* Preserve the primary error. */ } }
      let shutdownConfirmed = false
      try { await host?.shutdown(); shutdownConfirmed = true }
      catch (error) { reportCleanup(error) }
      await skills.drain({ close: true }).catch(reportCleanup)
      if (shutdownConfirmed) await release?.().catch(reportCleanup)
    } else {
      const errors: unknown[] = []
      let shutdownConfirmed = false
      try { await host?.shutdown(); shutdownConfirmed = true } catch (error) { errors.push(error) }
      // Independent domain drains still run when process cleanup is uncertain.
      try { await skills.drain({ close: true }) } catch (error) { errors.push(error) }
      // Keep writer ownership when this host may still have an active tree/effect.
      if (shutdownConfirmed) try { await release?.() } catch (error) { errors.push(error) }
      if (!shutdownConfirmed) throw new AggregateError(errors, 'Process/session cleanup unconfirmed; session lock retained; inspect owned processes before restarting')
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, 'CLI session cleanup failed')
    }
  }
}
