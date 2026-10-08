// SPDX-License-Identifier: Apache-2.0
import type { ModelProvider } from '@ayayaq/vivi'
import { randomUUID } from 'node:crypto'
import type { ReasoningEffort } from '@ayayaq/vivi/providers/openrouter'
import type { CliOptions } from './main.js'
import { decisionProviderForSession, deferredDecisionProvider } from './main.js'
import { CliHost } from './host.js'
import { FileMemoryStore } from './memory.js'
import { FileSkillStore } from './skills.js'
import { join } from 'node:path'
import { ReadOnlyWorkspace } from './workspace.js'
import { FileSessionStore, newSession, redactSecrets } from './session.js'
import type { CliProviderName, CliSession } from './session.js'
import { formatUsage } from './usage.js'
import type { ChatIO } from './terminal.js'
import { displayMemories, MEMORY_DISCLOSURE, reviewMemoryChange, sendChatTurn, selectApprovalMode, AUTO_REVIEW_UNAVAILABLE, displaySkills, SKILLS_DISCLOSURE, skillCreationPrompt } from './terminal.js'
import { formatSessionDate, sessionDisplayTitle } from './session-display.js'
import { PreferenceStore, listSessions } from './preferences.js'
import type { TuiPreferences } from './preferences.js'
import { ModelCatalog, unknownModel, documentedOpenAIModel, modelAccessDenied } from './models.js'
import type { Catalog, ModelEntry } from './models.js'
import { createCredentialStore, validateApiKey } from './credentials.js'
import type { CredentialStore } from './credentials.js'
import type { Choice, SearchableOptions, SearchableSelection } from './picker.js'
import { FileDecisionLedger } from './decision-ledger.js'

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
  registerSecret?(secret: string): void
  providerFactory(session: CliSession, options: CliOptions, env: NodeJS.ProcessEnv): ModelProvider
  decisionProviderFactory?: typeof decisionProviderForSession
}
export const DEFAULT_PREFERENCES: TuiPreferences = { schemaVersion: 1, provider: 'openai', model: '', reasoning: 'default',
  reasoningCapabilities: [], stream: true, enableNotes: false, enableMemory: false, enableTools: false, maxRounds: 25 }
const envName = (provider: CliProviderName): string => provider === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY'

export function settingsForModel(base: TuiPreferences, model: ModelEntry): TuiPreferences {
  const same = base.model === model.id
  const reasoning = same && (base.reasoning === 'default' || model.efforts.includes(base.reasoning as ReasoningEffort))
    ? base.reasoning : 'default'
  return { ...base, model: model.id, reasoning, reasoningCapabilities: [...model.efforts],
    enableTools: model.tools === 'supported', enableNotes: model.tools === 'supported' && base.enableNotes }
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
const COMMAND_HELP = `Enter submits; Ctrl+J adds a line. Shift/Alt+Enter also adds a line when the terminal reports it. Tab completes slash commands above the composer.
/provider sets up an OpenAI or OpenRouter key; /models opens the model picker; /effort selects supported reasoning.
/new starts fresh; /resume explicitly resumes a local session; /rename names the current session; /settings changes future defaults.
/memories manages this launch’s app-wide saved context; it is plaintext locally and sent to the selected provider when enabled.
/mode chooses Manual or optional Auto review for this conversation and selected account; Manual is always the default.
/skills lists and inspects standard skills and prepares creator drafts for manual saving.
/menu opens actions; /session shows the current ID and usage; /exit quits.
Mouse: click action buttons, picker rows and dialog choices; wheel scrolls. Approvals select Deny by default.
Escape or Ctrl-C cancels a running turn. Ctrl-C while idle exits.
Provider/model/effort changes start a fresh conversation; existing transcripts remain available with /resume.
Keys are masked and saved only in an available OS credential store, or used for this launch after your choice.
`

/** Navigation and host policy; the shared core owns conversation/tool execution. */
export async function runApplication(input: ApplicationOptions): Promise<number> {
  const { io, options, args, providerFactory } = input
  const env = { ...input.env }
  const secrets = [...input.secrets]
  const credentials = input.credentials ?? createCredentialStore()
  const catalog = input.catalog ?? new ModelCatalog()
  const store = new FileSessionStore(options.sessionDirectory, secrets)
  const preferences = new PreferenceStore(options.sessionDirectory, secrets)
  const memory = new FileMemoryStore(options.sessionDirectory, secrets, message => io.write(`${message}\n`))
  const decisions = new FileDecisionLedger(options.sessionDirectory, secrets)
  const skills = new FileSkillStore(join(options.sessionDirectory, 'agent-skills'), { readOnlyRoots: options.skillsDirectories, secrets, notice: message => io.write(`${message}\n`) })
  let activeSkills = options.enableSkills
  const workspace = options.workspace === undefined ? undefined : await ReadOnlyWorkspace.open(options.workspace, secrets, [options.sessionDirectory])
  io.setWorkspace?.(workspace?.directory)
  const knownModels = new Map<string, ModelEntry>()
  const modelKey = (provider: CliProviderName, id: string): string => `${provider}:${id}`
  const report = (error: unknown): void => io.write(`${redactSecrets(error instanceof Error ? error.message : 'Application failed', secrets)}\n`)
  const register = (key: string): void => {
    if (!key || secrets.includes(key)) return
    secrets.push(key); preferences.addSecrets([key]); memory.addSecrets([key]); decisions.addSecrets([key]); skills.addSecrets([key]); io.addSecrets?.([key]); input.registerSecret?.(key)
  }
  let settings = structuredClone(DEFAULT_PREFERENCES)
  let savedSettings: TuiPreferences | undefined
  try { savedSettings = await preferences.load(); settings = savedSettings ? structuredClone(savedSettings) : settings }
  catch (error) { io.write('Saved defaults could not be loaded; use /provider or /resume\n'); report(error) }
  // App-wide consent belongs to the launch, not to a model's session settings.
  let activeMemory = args.includes('--enable-memory') || args.includes('--disable-memory')
    ? options.enableMemory : settings.enableMemory
  if ((options.provider !== undefined && options.provider !== settings.provider) ||
    (options.model !== undefined && options.model !== settings.model)) {
    settings = { ...settings, reasoning: 'default', reasoningCapabilities: [], enableTools: false, enableNotes: false }
  }
  if (args.includes('--provider')) settings.provider = options.provider!
  if (args.includes('--model')) settings.model = options.model!
  if (args.includes('--reasoning')) settings.reasoning = options.reasoning!
  if (args.includes('--reasoning-capabilities')) {
    settings.reasoningCapabilities = options.reasoningCapabilities
    if (!args.includes('--reasoning') && !settings.reasoningCapabilities.includes(settings.reasoning as ReasoningEffort)) settings.reasoning = 'default'
  }
  if (args.includes('--no-stream')) settings.stream = false
  if (args.includes('--tools')) settings.enableTools = true
  if (args.includes('--no-tools')) { settings.enableTools = false; settings.enableNotes = false }
  if (args.includes('--enable-notes')) { settings.enableTools = true; settings.enableNotes = true }
  if (args.includes('--max-rounds')) settings.maxRounds = options.maxRounds
  if (settings.provider === 'openai' && settings.model) {
    const verified = documentedOpenAIModel(settings.model)
    if (verified.tools !== 'unknown') {
      const previousEffort = settings.reasoning
      settings = settingsForModel(settings, verified)
      if (previousEffort !== settings.reasoning) io.write('Saved reasoning is no longer verified for this model; using provider default. Use /effort to select a supported level\n')
      if (args.includes('--no-tools')) { settings.enableTools = false; settings.enableNotes = false }
    }
  }
  const declaredToolTarget = { provider: settings.provider, model: settings.model }
  let host: CliHost | undefined
  // Opaque launch-owned revisions never expose, derive from or persist credentials.
  let accountGeneration = randomUUID()
  let hostAccountGeneration: string | undefined
  let launchModePending = options.approvalMode === 'auto'
  let activeSettings: TuiPreferences | undefined
  let release: (() => Promise<void>) | undefined
  let selected: { resume?: string; fresh?: boolean } | undefined = options.resume ? { resume: options.resume }
    : settings.model ? { fresh: true } : undefined
  const loadKey = async (provider: CliProviderName): Promise<string | undefined> => {
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
    if (settings.provider !== 'openrouter' || knownModels.has(modelKey(settings.provider, settings.model))) return
    const key = await loadKey(settings.provider)
    const controller = new AbortController()
    const dispose = io.onCancel(() => controller.abort())
    try {
      io.write(`Loading ${settings.provider} model capabilities…\n`)
      const result = await catalog.list(settings.provider, key, controller.signal)
      if (io.isClosed || controller.signal.aborted) return false
      let notice = ''
      for (const model of result.models) knownModels.set(modelKey(settings.provider, model.id), model)
      const model = result.models.find(model => model.id === settings.model)
      if (model) {
        const previous = settings
        settings = settingsForModel(settings, model)
        // A saved chat-only choice and an explicit launch opt-out remain off.
        // Unknown tool metadata cannot promote a saved claim into permission;
        // openSession still requires this launch's explicit --tools declaration.
        if (model.tools === 'unknown') {
          settings.enableTools = previous.enableTools; settings.enableNotes = previous.enableNotes
        }
        if (args.includes('--no-tools') || savedSettings?.provider === settings.provider &&
          savedSettings.model === settings.model && !savedSettings.enableTools &&
          !args.includes('--tools') && !args.includes('--enable-notes')) {
          settings.enableTools = false; settings.enableNotes = false
        }
        if (model.reasoning === 'unknown' && args.includes('--reasoning-capabilities')) {
          settings.reasoning = previous.reasoning; settings.reasoningCapabilities = previous.reasoningCapabilities
        }
        if (previous.reasoning !== settings.reasoning) notice += 'Saved reasoning is no longer verified for this model; using provider default. Use /effort to select a supported level\n'
      }
      notice += result.warning ? `${result.warning}. Using a stale cached catalog\n`
        : result.state === 'cached' ? 'Using the cached model catalog (up to 15 minutes old)\n' : ''
      return notice || undefined
    } catch (error) {
      if (io.isClosed || controller.signal.aborted) return false
      // Authentication denial is not an offline fallback and cannot authorize a
      // provider attempt, even when --tools was explicitly declared this launch.
      if (modelAccessDenied(error)) throw error
      return `${redactSecrets(error instanceof Error ? error.message : 'Model capabilities could not be loaded', secrets)}\n`
    } finally { dispose() }
  }
  const setupProvider = async (base: TuiPreferences): Promise<TuiPreferences | undefined> => {
    const provider = await io.choose('Provider', [
      { name: 'OpenAI', description: 'Responses API', value: 'openai' as const },
      { name: 'OpenRouter', description: 'Chat Completions gateway', value: 'openrouter' as const }
    ], base.provider === 'openrouter' ? 1 : 0)
    if (!provider) return
    const current = await loadKey(provider)
    const action = current ? await io.choose(`${provider} API key`, [
      { name: 'Use current key', description: input.env[envName(provider)] ? 'From your environment; never copied to settings' : 'Already available for this launch', value: 'current' },
      { name: 'Enter a different key', description: 'Masked input; choose storage explicitly', value: 'enter' }
    ]) : 'enter'
    if (!action) return
    if (action === 'enter') {
      if (!io.askSecret) { io.write(`Masked key input is unavailable. Set ${envName(provider)} in your environment\n`); return }
      const status = await credentials.status()
      const mode = await io.choose('API key storage', [
        ...(status.available ? [{ name: `Save in ${status.label}`, description: 'Available on your next launch; never stored in settings or transcripts', value: 'save' }] : []),
        { name: 'Use for this launch only', description: status.available ? 'You’ll need to enter it again next time' : `${status.detail ?? status.label}. No plaintext fallback`, value: 'temporary' }
      ])
      if (!mode) return
      const entered = await io.askSecret(`${provider} API key · masked · Escape cancels`)
      if (entered === undefined) return
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
        host?.setApprovalMode('manual')
        io.setApprovalMode?.('manual')
        accountGeneration = randomUUID()
      }
      env[envName(provider)] = key
    }
    return provider === base.provider ? { ...base } : { ...base, provider, model: '', reasoning: 'default',
      reasoningCapabilities: [], enableTools: false, enableNotes: false }
  }
  const chooseModel = async (base: TuiPreferences): Promise<TuiPreferences | undefined> => {
    const key = await loadKey(base.provider)
    const controller = new AbortController()
    const dispose = io.onCancel(() => controller.abort())
    let result
    try { io.write(`Loading ${base.provider} models…\n`); result = await catalog.list(base.provider, key, controller.signal) }
    catch (error) { if (!controller.signal.aborted) report(error); if (modelAccessDenied(error)) return }
    finally { dispose() }
    if (io.isClosed || controller.signal.aborted) return
    if (!result) {
      if (!base.model || base.provider === 'openai' && documentedOpenAIModel(base.model).conversation === 'unsupported') {
        io.write('No compatible model catalog available. Check /provider and try /models again\n'); return
      }
      const keep = await io.choose('Model catalog unavailable', [
        { name: `Keep ${base.model}`, description: 'Saved selection; availability and capabilities are unverified', value: true },
        { name: 'Cancel', value: false }
      ])
      return keep ? settingsForModel(base, unknownModel(base.model)) : undefined
    }
    const remember = (): void => {
      for (const model of result!.models) knownModels.set(modelKey(base.provider, model.id), model)
    }
    remember()
    if (result.warning) io.write(`${result.warning}. Showing a stale cached catalog\n`)
    else if (result.state === 'cached') io.write('Using the cached model catalog (up to 15 minutes old)\n')
    let search = ''
    for (;;) {
      const choices = result.models.map(model => ({ name: model.id,
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
      if (model.tools === 'unknown') io.write('Tool capabilities are unknown; this model will use chat only\n')
      if (model.reasoning === 'unknown') io.write('Reasoning capabilities are unknown; using provider default\n')
      return settingsForModel(base, model)
    }
  }
  const save = async (next: TuiPreferences, changeMemoryDefault = false): Promise<void> => {
    const defaults = { ...next, enableMemory: changeMemoryDefault ? next.enableMemory : settings.enableMemory }
    await preferences.save(defaults); settings = defaults
  }
  const configure = async (): Promise<boolean> => {
    const provider = await setupProvider(settings)
    if (!provider) return false
    const model = await chooseModel(provider)
    if (!model) return false
    const effort = await chooseEffort(io, model)
    if (!effort) return false
    const notes = effort.enableTools ? await io.choose('Session notes', [
      { name: 'Keep notes disabled', description: 'Calculator and current time only', value: false },
      { name: 'Enable session notes', description: 'Each write requires an allow/deny approval', value: true }
    ], effort.enableNotes ? 1 : 0) : false
    if (notes === undefined) return false
    const enableMemory = await io.choose('Persistent memory default · future launches', [
      { name: 'Keep memory disabled by default', description: 'No saved memory is read or sent unless you enable it', value: false },
      { name: 'Enable memory by default', description: MEMORY_DISCLOSURE, value: true }
    ], settings.enableMemory ? 1 : 0)
    if (enableMemory === undefined) return false
    await save({ ...effort, enableNotes: notes, enableMemory }, true); return true
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
        ...(activeMemory && host ? [
          { name: 'Refresh memories', description: 'Reload current app-wide records', value: 'refresh' },
          ...(snapshot ? [{ name: 'Add memory', description: 'Enter content, then review the exact proposed change', value: 'add' },
            ...(snapshot.memories.length ? [{ name: 'Edit memory', description: 'Choose a displayed ID and revision', value: 'edit' },
              { name: 'Delete memory', description: 'Choose a displayed ID and revision, then review deletion', value: 'delete' }] : [])] : [])
        ] : [])]
      const action = await io.choose(`Persistent memories · ${activeMemory ? 'enabled' : 'disabled'} for this launch`, choices)
      if (action === undefined || action === 'back') return
      if (action === 'on' || action === 'off') {
        activeMemory = action === 'on'; host?.setMemoryEnabled(activeMemory)
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
          { name: 'Create with agent', description: 'Put a manual-save draft request in the composer', value: 'create' }] : [])
      ])
      if (action === undefined || action === 'back') return
      if (action === 'toggle') { activeSkills = !activeSkills; host?.setSkillsEnabled(activeSkills); continue }
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
  const openSession = async (selection: { resume?: string; fresh?: boolean }): Promise<boolean> => {
    if (!selection.resume && !settings.model) return false
    const capabilityNotice = selection.resume ? undefined : await hydrateModel()
    if (capabilityNotice === false) return false
    await host?.drainMemory()
    await host?.drainSkills()
    const fresh = selection.resume ? undefined : newSession({ provider: settings.provider, model: settings.model, reasoning: settings.reasoning })
    const nextRelease = await store.acquire(selection.resume ?? fresh!.id)
    let nextHost: CliHost
    try {
      const session = selection.resume ? await store.load(selection.resume) : fresh!
      const sameModel = session.provider === settings.provider && session.model === settings.model
      const explicitResume = session.id === options.resume
      const metadata = knownModels.get(modelKey(session.provider, session.model)) ??
        (session.provider === 'openai' ? documentedOpenAIModel(session.model) : undefined)
      if (metadata?.conversation === 'unsupported') throw new Error('This model is incompatible with vivi’s text-conversation endpoint. Choose a supported model with /models')
      let capabilities = explicitResume && args.includes('--reasoning-capabilities') ? options.reasoningCapabilities
        : metadata?.reasoning === 'supported' ? metadata.efforts : sameModel ? settings.reasoningCapabilities : []
      if (session.reasoning && session.reasoning !== 'default' && !capabilities.includes(session.reasoning as ReasoningEffort)) {
        const declared = await io.choose(`Resume requires verified support for reasoning '${session.reasoning}'`, [
          { name: 'Cancel resume', value: false }, { name: 'I verified this model supports that effort', value: true }
        ])
        if (!declared) { await nextRelease(); return false }
        capabilities = [session.reasoning as ReasoningEffort]
      }
      const declaredTools = (args.includes('--tools') || args.includes('--enable-notes')) &&
        (explicitResume || session.provider === declaredToolTarget.provider && session.model === declaredToolTarget.model)
      const enableTools = !args.includes('--no-tools') && metadata?.tools !== 'unsupported' &&
        (metadata?.tools === 'supported' ? !sameModel || settings.enableTools : declaredTools)
      const effective: CliOptions = { ...options, reasoningCapabilities: capabilities,
        stream: metadata?.streaming === 'unsupported' ? false : settings.stream,
        enableTools, enableNotes: enableTools && (sameModel ? settings.enableNotes : explicitResume && args.includes('--enable-notes')),
        enableMemory: activeMemory, enableSkills: activeSkills,
        maxRounds: settings.maxRounds }
      await loadKey(session.provider)
      if (io.isClosed) { await nextRelease(); return false }
      const provider = providerFactory(session, effective, env)
      if (io.isClosed) { await nextRelease(); return false }
      nextHost = new CliHost({ provider, store, session, secrets, enableTools: effective.enableTools,
        enableNotes: effective.enableNotes, enableMemory: activeMemory, memory, enableSkills: activeSkills, skills,
        onSkillsNotice: message => io.write(`${message}\n`), ...(workspace ? { workspace } : {}), maxRounds: effective.maxRounds,
        onMemoryNotice: message => io.write(`${message}\n`),
        onReviewNotice: (message, context) => io.reviewNotice ? io.reviewNotice(message, context) : io.write(`${message}\n`),
        ...(io.canAutoReview === true ? { decisionReview: {
          provider: deferredDecisionProvider(session, env, input.decisionProviderFactory ?? decisionProviderForSession),
          ledger: decisions, canAutoReview: true, accountRevision: () => accountGeneration,
          isAvailable: () => io.canAutoReview === true && !io.isClosed
        } } : {}),
        approve: (request, signal) => io.approve(request, signal), onEvent: event => io.event(event) })
      await store.save(nextHost.session)
      if (workspace && !effective.enableTools) io.write('Workspace tools are unavailable for this model; choose a tool-capable model to read files\n')
      if (io.isClosed) { await nextRelease(); return false }
      activeSettings = { ...settings, provider: session.provider, model: session.model,
        reasoning: session.reasoning ?? 'default', reasoningCapabilities: [...capabilities],
        enableTools: effective.enableTools, enableNotes: effective.enableNotes }
    } catch (error) { await nextRelease().catch(report); throw error }
    const previousRelease = release
    release = nextRelease; host = nextHost; hostAccountGeneration = accountGeneration
    await previousRelease?.().catch(report)
    io.setSession(host.session)
    io.setApprovalMode?.('manual')
    io.write('Approval mode: Manual\n')
    // Native transcript setup clears earlier loading output. Keep stale-cache
    // disclosure visible after that rebuild and before the first provider turn.
    if (capabilityNotice) io.write(capabilityNotice)
    return true
  }
  let workspaceNoticePending = true
  try {
    if (activeSkills) io.write(`${SKILLS_DISCLOSURE}\n`)
    if (activeMemory) io.write(`Memory enabled for this launch\n${MEMORY_DISCLOSURE}\n`)
    // Every launch begins in a clean composer, even before the first provider setup.
    if (!settings.model) {
      if (io.setDraft) io.setDraft(settings.provider)
      else io.setSession(newSession({ provider: settings.provider, model: 'Choose a model with /models' }))
    }
    if (!settings.model) io.write('vivi · fresh conversation · use /provider to set up, then /models and /effort\n')
    for (;;) {
      if (io.isClosed) { if (io.failed) await io.readLine(''); return 0 }
      if (selected) {
        try { await openSession(selected) } catch (error) { report(error); if (options.prompt !== undefined) return 1 }
        selected = undefined
      }
      if (io.isClosed) continue
      if (launchModePending && host) {
        launchModePending = false
        await selectApprovalMode(host, io, (title, choices, initialIndex) => io.choose(title, choices, initialIndex))
      } else if (launchModePending && io.canAutoReview !== true) {
        launchModePending = false
        io.write(`${AUTO_REVIEW_UNAVAILABLE}\n`)
      }
      // Session/draft setup rebuilds the native transcript; disclose after that, before any turn.
      if (workspaceNoticePending) {
        workspaceNoticePending = false
        if (workspace) io.write(`Workspace: ${JSON.stringify(workspace.directory)} · reads and reviewed text edits for this launch\nFiles read by tools are sent to the selected provider and saved in session history\n`)
      }
      if (options.prompt !== undefined) {
        if (!host) { io.write('Choose a provider and model before running a prompt\n'); return 1 }
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
      if (command === '/menu') {
        const action = await io.choose('Conversation actions', [
          { name: 'Continue conversation', value: 'continue' }, { name: 'Set up provider', value: '/provider' },
          { name: 'Choose model', value: '/models' }, { name: 'Reasoning effort', value: '/effort' },
          { name: 'New conversation', value: '/new' }, { name: 'Resume conversation', value: '/resume' },
          { name: 'Rename conversation', value: '/rename' },
          { name: 'Approval mode', value: '/mode' },
          { name: 'Future defaults', value: '/settings' }, { name: 'Persistent memories', value: '/memories' },
          { name: 'Skills', value: '/skills' },
          { name: 'Help', value: '/help' }, { name: 'Quit', value: '/exit' }
        ])
        if (!action || action === 'continue') continue
        if (action === '/exit') return 0
        command = action; line = action
      }
      try {
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
        if (command === '/provider') {
          const configured = await setupProvider(activeSettings ?? settings)
          if (configured) {
            const model = await chooseModel(configured)
            if (model) { await save(model); selected = { fresh: true } }
            else if (!host) { await save(configured); io.setDraft?.(configured.provider) }
          }
          continue
        }
        if (command === '/models') { const model = await chooseModel(activeSettings ?? settings); if (model) { await save(model); selected = { fresh: true } }; continue }
        if (command === '/effort') { const effort = await chooseEffort(io, activeSettings ?? settings); if (effort) { await save(effort); selected = { fresh: true } }; continue }
        if (command === '/settings') { if (await configure()) io.write('Defaults apply to new conversations. Use /new when ready. Memory defaults apply to future launches; use /memories for this launch\n'); continue }
        if (command === '/skills') { await manageSkills(); continue }
        if (command === '/memories') { await manageMemories(); continue }
        if (/^\/mode(?:\s|$)/.test(command)) {
          if (command !== '/mode') { io.write('Use /mode by itself for a fresh Manual / Auto review choice\n'); continue }
          if (!host) { io.write('Choose a provider and model before selecting approval mode\n'); continue }
          if (hostAccountGeneration !== accountGeneration) {
            host.setApprovalMode('manual'); io.setApprovalMode?.('manual')
            io.write('Approval mode: Manual. The selected account changed; use /new or /models before enrolling Auto review again\n')
            continue
          }
          await selectApprovalMode(host, io, (title, choices, initialIndex) => io.choose(title, choices, initialIndex))
          continue
        }
        if (command === '/help') { io.write(COMMAND_HELP); continue }
        if (command === '/session') {
          const session = host?.session
          io.write(session ? `Session: ${session.id}\nName: ${sessionDisplayTitle(session)}\nApproval mode: ${host!.approvalMode === 'auto' ? 'Auto review' : 'Manual'}\nSession tokens: ${formatUsage(session.usage)}\n`
            : 'Fresh conversation has no saved session until a model is selected\n')
          io.write(workspace ? `Workspace: ${JSON.stringify(workspace.directory)} · reads and reviewed text edits for this launch\n` : 'Workspace: disabled\n')
          continue
        }
        if (command.startsWith('/')) { io.write('Unknown slash command. Use /help or Tab completion\n'); continue }
        if (!line.trim()) continue
        if (!host) { io.write('Use /provider and /models before sending a message\n'); continue }
        const controller = new AbortController()
        const dispose = io.onCancel(() => { controller.abort(); host!.cancel() })
        try { const result = await sendChatTurn(host, io, line, controller.signal); io.result(result); io.setSession(host.session) }
        finally { dispose() }
      } catch (error) { report(error) }
    }
  } finally { try { await host?.drainMemory(); await skills.drain({ close: true }) } finally { await release?.() } }
}
