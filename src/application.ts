// SPDX-License-Identifier: Apache-2.0
import type { ModelProvider } from '@ayayaq/vivi'
import type { ReasoningEffort } from '@ayayaq/vivi/providers/openrouter'
import type { CliOptions } from './main.js'
import { CliHost } from './host.js'
import { FileSessionStore, newSession, redactSecrets } from './session.js'
import type { CliSession } from './session.js'
import type { ChatIO } from './terminal.js'
import { PreferenceStore, listSessions } from './preferences.js'
import type { TuiPreferences } from './preferences.js'

export interface InteractiveIO extends ChatIO {
  choose<T>(title: string, choices: readonly { name: string; description?: string; value: T }[], initialIndex?: number): Promise<T | undefined>
  askText(title: string, initial?: string): Promise<string | undefined>
  setSession(session: CliSession): void
}
export interface ApplicationOptions {
  io: InteractiveIO
  options: CliOptions
  args: readonly string[]
  env: NodeJS.ProcessEnv
  secrets: readonly string[]
  providerFactory(session: CliSession, options: CliOptions, env: NodeJS.ProcessEnv): ModelProvider
}
const effortNames: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const defaults: TuiPreferences = { schemaVersion: 1, provider: 'openai', model: '', reasoning: 'default',
  reasoningCapabilities: [], stream: true, enableNotes: false, enableTools: false, maxRounds: 25 }

/** Capabilities are explicit user declarations. No model catalog or live credential discovery. */
export async function configure(io: InteractiveIO, base: TuiPreferences, secrets: readonly string[]): Promise<TuiPreferences | undefined> {
  const provider = await io.choose('Provider (credentials come from your environment)', [
    { name: 'OpenAI', description: 'OPENAI_API_KEY', value: 'openai' as const },
    { name: 'OpenRouter', description: 'OPENROUTER_API_KEY', value: 'openrouter' as const }
  ], base.provider === 'openrouter' ? 1 : 0)
  if (provider === undefined) return
  let model: string | undefined
  for (;;) {
    model = await io.askText('Model identifier (enter the exact provider model ID)', base.model)
    if (model === undefined) return
    if (/^[^\s\u0000-\u001f\u007f-\u009f]{1,200}$/.test(model) && !secrets.some(secret => secret && model!.includes(secret))) break
    io.write('Enter a model ID of 1..200 characters without whitespace, controls or credentials\n')
  }
  const declare = await io.choose('Reasoning capabilities for this model', [
    { name: 'Use provider default', description: 'No capability claims; default does not mean disabled', value: false },
    { name: 'Declare verified efforts', description: 'Only efforts you have checked in the provider model documentation', value: true }
  ], base.reasoningCapabilities.length ? 1 : 0)
  if (declare === undefined) return
  let reasoningCapabilities: ReasoningEffort[] = []
  let reasoning = 'default'
  if (declare) {
    for (;;) {
      const csv = await io.askText('Verified efforts: none,minimal,low,medium,high,xhigh,max (comma-separated)', base.reasoningCapabilities.join(','))
      if (csv === undefined) return
      const names = csv.split(',').map(value => value.trim())
      if (names.length && names.every(value => effortNames.includes(value as ReasoningEffort))) {
        reasoningCapabilities = [...new Set(names)] as ReasoningEffort[]
        break
      }
      io.write('Enter only supported effort names from the list, or Escape to cancel\n')
    }
    const levels = ['default', ...reasoningCapabilities]
    const choice = await io.choose('Reasoning for new sessions', levels.map(value => ({ name: value === 'none' ? 'Disabled (verified support)' : value,
      value })), Math.max(0, levels.indexOf(base.reasoning)))
    if (choice === undefined) return
    reasoning = choice
  }
  const enableTools = await io.choose('Tool capabilities for this model', [
    { name: 'Chat only', description: 'Safe default when model tool support is unknown', value: false },
    { name: 'Enable verified tool support', description: 'I checked this model supports tool calls: calculator and current time', value: true }
  ], base.enableTools ? 1 : 0)
  if (enableTools === undefined) return
  let enableNotes = false
  if (enableTools) {
    const choice = await io.choose('Session notes', [
      { name: 'Keep notes disabled', description: 'Calculator and time only', value: false },
      { name: 'Enable session-only notes', description: 'Each write still requires a scoped allow/deny approval', value: true }
    ], base.enableNotes ? 1 : 0)
    if (choice === undefined) return
    enableNotes = choice
  }
  return { ...base, provider, model, reasoning, reasoningCapabilities, enableTools, enableNotes }
}

const COMMAND_HELP = `Enter submits; Shift/Alt+Enter adds a line. PageUp/PageDown scroll the transcript.
/menu opens actions; /new starts with saved defaults; /settings changes defaults for new sessions.
/resume selects a validated local session; /session shows its ID; /exit quits.
Escape or Ctrl-C cancels a running turn. Ctrl-C while idle exits.
Provider/model/reasoning stay fixed in an existing session. Keys are never stored.
`

/** Application navigation only; CliHost and the shared core own every conversation and tool turn. */
export async function runApplication(input: ApplicationOptions): Promise<number> {
  const { io, options, args, env, secrets, providerFactory } = input
  const store = new FileSessionStore(options.sessionDirectory, secrets)
  const preferences = new PreferenceStore(options.sessionDirectory, secrets)
  const report = (error: unknown): void => io.write(`${redactSecrets(error instanceof Error ? error.message : 'Application failed', secrets)}\n`)
  let settings = { ...defaults }
  try { settings = await preferences.load() ?? settings }
  catch (error) { io.write('Saved defaults could not be loaded; you can choose settings or resume a session\n'); report(error) }
  // A declaration belongs to one provider/model pair; selection flags cannot transfer it.
  if ((options.provider !== undefined && options.provider !== settings.provider) ||
    (options.model !== undefined && options.model !== settings.model)) {
    settings.reasoning = 'default'
    settings.reasoningCapabilities = []
    settings.enableTools = false
    settings.enableNotes = false
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
  let host: CliHost | undefined
  let release: (() => Promise<void>) | undefined
  let selected: { resume?: string; fresh?: boolean } | undefined = options.resume ? { resume: options.resume }
    : options.startNew || options.model ? { fresh: true } : undefined
  const saveDefaults = async (): Promise<boolean> => {
    const configured = await configure(io, settings, secrets)
    if (!configured) return false
    await preferences.save(configured)
    settings = configured
    return true
  }
  const selectResume = async (): Promise<string | undefined> => {
    const sessions = await listSessions(store)
    const choices = sessions.filter(session => !session.locked).map(session => ({
      name: `${session.model} · ${session.provider}`, description: `${session.updatedAt} · ${session.id}`, value: session.id
    }))
    if (!choices.length) { io.write('No unlocked valid sessions found. Locked sessions require checking that the previous process has stopped\n'); return }
    return io.choose('Resume a local session', choices)
  }
  const openSession = async (selection: { resume?: string; fresh?: boolean }): Promise<boolean> => {
    if (!selection.resume && !settings.model && !await saveDefaults()) return false
    const fresh = selection.resume ? undefined : newSession({ provider: settings.provider,
      model: settings.model, reasoning: settings.reasoning })
    // The exclusive lease precedes the authoritative load, provider construction and recovery write.
    const nextRelease = await store.acquire(selection.resume ?? fresh!.id)
    let nextHost: CliHost
    try {
      const session = selection.resume ? await store.load(selection.resume) : fresh!
      const sameModel = session.provider === settings.provider && session.model === settings.model
      const explicitResume = session.id === options.resume
      let capabilities = explicitResume && args.includes('--reasoning-capabilities') ? options.reasoningCapabilities
        : sameModel ? settings.reasoningCapabilities : []
      if (session.reasoning && session.reasoning !== 'default' && !capabilities.includes(session.reasoning as ReasoningEffort)) {
        const declared = await io.choose(`Resume requires verified support for reasoning '${session.reasoning}'`, [
          { name: 'Cancel resume', value: false }, { name: 'I verified this model supports that effort', value: true }
        ])
        if (!declared) { await nextRelease(); return false }
        capabilities = [session.reasoning as ReasoningEffort]
      }
      const enableTools = sameModel ? settings.enableTools : explicitResume && (args.includes('--tools') || args.includes('--enable-notes'))
      const effective: CliOptions = { ...options, reasoningCapabilities: capabilities, stream: settings.stream,
        enableTools, enableNotes: enableTools && settings.enableNotes, maxRounds: settings.maxRounds }
      if (io.isClosed) { await nextRelease(); return false }
      const provider = providerFactory(session, effective, env)
      if (io.isClosed) { await nextRelease(); return false }
      nextHost = new CliHost({ provider, store, session, secrets, enableTools: effective.enableTools,
        enableNotes: effective.enableNotes, maxRounds: effective.maxRounds,
        approve: (request, signal) => io.approve(request, signal), onEvent: event => io.event(event) })
      await store.save(nextHost.session)
      if (io.isClosed) { await nextRelease(); return false }
    } catch (error) { await nextRelease().catch(report); throw error }
    const previousRelease = release
    release = nextRelease
    host = nextHost
    await previousRelease?.().catch(report)
    io.setSession(host.session)
    return true
  }
  try {
    io.write('vivi · Choose a provider and model once; nonsecret defaults are saved locally\n')
    for (;;) {
      if (io.isClosed) {
        if (io.failed) await io.readLine('') // A fatal UI error rejects with its safe diagnostic.
        return 0
      }
      if (selected) {
        try { await openSession(selected) } catch (error) { report(error); if (options.prompt !== undefined) return 1 }
        selected = undefined
      }
      if (!host) {
        const action = await io.choose('Welcome to vivi', [
          { name: settings.model ? `New conversation · ${settings.model}` : 'Set up a new conversation', value: 'new' },
          { name: 'Resume a conversation', value: 'resume' },
          { name: 'Choose provider, model and capabilities', value: 'settings' },
          { name: 'Quit', value: 'exit' }
        ])
        if (!action || action === 'exit') return 0
        try {
          if (action === 'settings') { if (await saveDefaults()) selected = { fresh: true } }
          else if (action === 'resume') { const id = await selectResume(); if (id) selected = { resume: id } }
          else selected = { fresh: true }
        } catch (error) { report(error) }
        continue
      }
      if (options.prompt !== undefined) {
        if (io.isClosed) continue
        const controller = new AbortController()
        const dispose = io.onCancel(() => { controller.abort(); host!.cancel() })
        try {
          const result = await host.send(options.prompt, controller.signal)
          // Renderer failure cancels the host too, but must retain its safe fatal diagnostic.
          if (io.failed) await io.readLine('')
          io.result(result)
          return result.status === 'error' ? 1 : result.status === 'cancelled' ? 130 : 0
        }
        finally { dispose() }
      }
      let line = await io.readLine('Message')
      if (io.isClosed) continue
      if (line === undefined || line.trim() === '/exit') return 0
      let command = line.trim()
      if (command === '/menu') {
        const action = await io.choose('Conversation actions', [
          { name: 'Continue conversation', value: 'continue' }, { name: 'New conversation', value: '/new' },
          { name: 'Resume a conversation', value: '/resume' }, { name: 'Provider/model defaults', value: '/settings' },
          { name: 'Help and shortcuts', value: '/help' }, { name: 'Quit', value: '/exit' }
        ])
        if (!action || action === 'continue') continue
        if (action === '/exit') return 0
        command = action
        line = action
      }
      try {
        if (command === '/new') { selected = { fresh: true }; continue }
        if (command === '/resume') { const id = await selectResume(); if (id && id !== host.session.id) selected = { resume: id }; continue }
        if (command === '/settings') { await saveDefaults(); io.write('Defaults apply to new conversations. Use /new when ready\n'); continue }
        if (command === '/help') { io.write(COMMAND_HELP); continue }
        if (command === '/session') { io.write(`Session: ${host.session.id}\n`); continue }
        if (!line.trim()) continue
        const controller = new AbortController()
        const dispose = io.onCancel(() => { controller.abort(); host!.cancel() })
        try { const result = await host.send(line, controller.signal); io.result(result); io.setSession(host.session) }
        finally { dispose() }
      } catch (error) { report(error) }
    }
  } finally { await release?.() }
}
