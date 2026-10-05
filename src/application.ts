// SPDX-License-Identifier: Apache-2.0
import type { ModelProvider } from '@ayayaq/vivi'
import type { ReasoningEffort } from '@ayayaq/vivi/providers/openrouter'
import type { CliOptions } from './main.js'
import { CliHost } from './host.js'
import { FileSessionStore, newSession, redactSecrets } from './session.js'
import type { CliProviderName, CliSession } from './session.js'
import { formatUsage } from './usage.js'
import type { ChatIO } from './terminal.js'
import { PreferenceStore, listSessions } from './preferences.js'
import type { TuiPreferences } from './preferences.js'
import { ModelCatalog, unknownModel, documentedOpenAIModel, modelAccessDenied } from './models.js'
import type { Catalog, ModelEntry } from './models.js'
import { createCredentialStore, validateApiKey } from './credentials.js'
import type { CredentialStore } from './credentials.js'
import type { Choice, SearchableOptions, SearchableSelection } from './picker.js'

export interface InteractiveIO extends ChatIO {
  choose<T>(title: string, choices: readonly { name: string; description?: string; value: T }[], initialIndex?: number): Promise<T | undefined>
  chooseSearchable<T>(title: string, choices: readonly Choice<T>[], options?: SearchableOptions): Promise<SearchableSelection<T> | undefined>
  askText(title: string, initial?: string): Promise<string | undefined>
  askSecret?(title: string): Promise<string | undefined>
  addSecrets?(secrets: readonly string[]): void
  setDraft?(provider: CliProviderName): void
  setSession(session: CliSession): void
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
}
export const DEFAULT_PREFERENCES: TuiPreferences = { schemaVersion: 1, provider: 'openai', model: '', reasoning: 'default',
  reasoningCapabilities: [], stream: true, enableNotes: false, enableTools: false, maxRounds: 25 }
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
const COMMAND_HELP = `Enter submits; Shift/Alt+Enter adds a line. Tab completes slash commands above the composer.
/provider sets up an OpenAI or OpenRouter key; /models opens the model picker; /effort selects supported reasoning.
/new starts fresh; /resume explicitly resumes a local session; /settings changes future defaults.
/menu opens actions; /session shows the current ID and usage; /exit quits.
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
  const knownModels = new Map<string, ModelEntry>()
  const modelKey = (provider: CliProviderName, id: string): string => `${provider}:${id}`
  const report = (error: unknown): void => io.write(`${redactSecrets(error instanceof Error ? error.message : 'Application failed', secrets)}\n`)
  const register = (key: string): void => {
    if (!key || secrets.includes(key)) return
    secrets.push(key); preferences.addSecrets([key]); io.addSecrets?.([key]); input.registerSecret?.(key)
  }
  let settings = structuredClone(DEFAULT_PREFERENCES)
  try { settings = await preferences.load() ?? settings }
  catch (error) { io.write('Saved defaults could not be loaded; use /provider or /resume\n'); report(error) }
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
  let host: CliHost | undefined
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
  const save = async (next: TuiPreferences): Promise<void> => { await preferences.save(next); settings = next }
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
    await save({ ...effort, enableNotes: notes }); return true
  }
  const selectResume = async (): Promise<string | undefined> => {
    const sessions = await listSessions(store)
    const choices = sessions.filter(session => !session.locked).map(session => ({
      name: `${session.model} · ${session.provider}`, description: `${session.updatedAt} · ${session.id}`, value: session.id
    }))
    if (!choices.length) { io.write('No unlocked valid sessions found. Check the previous process before removing a session lock\n'); return }
    return io.choose('Resume a local session', choices)
  }
  const openSession = async (selection: { resume?: string; fresh?: boolean }): Promise<boolean> => {
    if (!selection.resume && !settings.model) return false
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
      const enableTools = args.includes('--no-tools') ? false : sameModel ? settings.enableTools
        : metadata?.tools === 'supported' || explicitResume && (args.includes('--tools') || args.includes('--enable-notes'))
      const effective: CliOptions = { ...options, reasoningCapabilities: capabilities,
        stream: metadata?.streaming === 'unsupported' ? false : settings.stream,
        enableTools, enableNotes: enableTools && (sameModel ? settings.enableNotes : explicitResume && args.includes('--enable-notes')),
        maxRounds: settings.maxRounds }
      await loadKey(session.provider)
      if (io.isClosed) { await nextRelease(); return false }
      const provider = providerFactory(session, effective, env)
      if (io.isClosed) { await nextRelease(); return false }
      nextHost = new CliHost({ provider, store, session, secrets, enableTools: effective.enableTools,
        enableNotes: effective.enableNotes, maxRounds: effective.maxRounds,
        approve: (request, signal) => io.approve(request, signal), onEvent: event => io.event(event) })
      await store.save(nextHost.session)
      if (io.isClosed) { await nextRelease(); return false }
      activeSettings = { ...settings, provider: session.provider, model: session.model,
        reasoning: session.reasoning ?? 'default', reasoningCapabilities: [...capabilities],
        enableTools: effective.enableTools, enableNotes: effective.enableNotes }
    } catch (error) { await nextRelease().catch(report); throw error }
    const previousRelease = release
    release = nextRelease; host = nextHost
    await previousRelease?.().catch(report)
    io.setSession(host.session)
    return true
  }
  try {
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
      if (options.prompt !== undefined) {
        if (!host) { io.write('Choose a provider and model before running a prompt\n'); return 1 }
        const controller = new AbortController()
        const dispose = io.onCancel(() => { controller.abort(); host!.cancel() })
        try {
          const result = await host.send(options.prompt, controller.signal)
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
          { name: 'Future defaults', value: '/settings' }, { name: 'Help', value: '/help' }, { name: 'Quit', value: '/exit' }
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
        if (command === '/settings') { if (await configure()) io.write('Defaults apply to new conversations. Use /new when ready\n'); continue }
        if (command === '/help') { io.write(COMMAND_HELP); continue }
        if (command === '/session') {
          const session = host?.session
          io.write(session ? `Session: ${session.id}\nSession tokens: ${formatUsage(session.usage)}\n`
            : 'Fresh conversation has no saved session until a model is selected\n')
          continue
        }
        if (command.startsWith('/')) { io.write('Unknown slash command. Use /help or Tab completion\n'); continue }
        if (!line.trim()) continue
        if (!host) { io.write('Use /provider and /models before sending a message\n'); continue }
        const controller = new AbortController()
        const dispose = io.onCancel(() => { controller.abort(); host!.cancel() })
        try { const result = await host.send(line, controller.signal); io.result(result); io.setSession(host.session) }
        finally { dispose() }
      } catch (error) { report(error) }
    }
  } finally { await release?.() }
}
