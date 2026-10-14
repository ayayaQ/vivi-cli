// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os'
import { join } from 'node:path'
import { McpConfigStore, mcpDisplayJson, validateMcpEndpoint } from './mcp-config.js'
import { McpManager } from './mcp-manager.js'
import type { McpManagerOptions } from './mcp-manager.js'
import { McpOAuthControls } from './mcp-oauth-controls.js'
import type { McpOAuthControlsOptions } from './mcp-oauth-controls.js'
import { McpSetupService } from './mcp-setup.js'
import { environmentSecrets, redactSecrets } from './session.js'
import { TerminalIO } from './terminal.js'
import type { ChatIO } from './terminal.js'

export const MCP_HELP = `Usage: vivi mcp add NAME URL [options]
       vivi mcp list
       vivi mcp login NAME
       vivi mcp connect NAME
       vivi mcp logout NAME
       vivi mcp remove NAME

  --session-dir PATH          Private state directory (default ~/.vivi/sessions)
  --label TEXT                Display label for add (default NAME)
  --protocol VERSION          2026-07-28 (default) or legacy, for add
  --allow-loopback-http       Allow literal 127.0.0.1 or ::1 HTTP, for add
  --help                      Show this help

No model, provider or API key is needed. Add saves a disabled HTTP server.
List reads local configuration only. Login and connect need an interactive
terminal, fresh human trust approval and browser consent when sign-in is needed.
Logout and remove clear local authority; they do not revoke the issuer's grant.
Connections are owned by this command and close when it exits. Use /mcp in a chat
to keep a reviewed connection available for that launch.
`

type Action = 'add' | 'list' | 'login' | 'connect' | 'logout' | 'remove'
export interface McpCliOptions {
  readonly action?: Action
  readonly id?: string
  readonly endpoint?: string
  readonly label?: string
  readonly protocol: 'legacy' | '2026-07-28'
  readonly allowLoopbackHttp: boolean
  readonly sessionDirectory: string
  readonly help: boolean
}
export interface McpCliDependencies {
  readonly io?: ChatIO
  readonly mcpManagerFactory?: (options: McpManagerOptions) => McpManager
  readonly mcpOAuth?: Omit<McpOAuthControlsOptions, 'registerSecrets' | 'secrets'>
}

/** Recognize only this command's global options, never a chat prompt or model name. */
export function isMcpCliCommand(args: readonly string[]): boolean {
  let index = 0
  while (args[index] === '--session-dir' && args[index + 1] !== undefined) index += 2
  return args[index] === 'mcp'
}

/** No provider selection, credentials, browser or saved state are consulted here. */
export function parseMcpCliArguments(args: readonly string[], env: NodeJS.ProcessEnv = process.env): McpCliOptions {
  if (!isMcpCliCommand(args) || args.length > 32) throw new Error('Use vivi mcp --help')
  let sessionDirectory = env.VIVI_SESSION_DIR ?? join(homedir(), '.vivi', 'sessions')
  let label: string | undefined
  let protocol: McpCliOptions['protocol'] = '2026-07-28'
  let allowLoopbackHttp = false, help = false, sawCommand = false
  const positional: string[] = [], flags = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!
    if (!sawCommand && argument === 'mcp') { sawCommand = true; continue }
    if (!argument.startsWith('-')) { positional.push(argument); continue }
    if (flags.has(argument)) throw new Error('MCP options must not be repeated; use vivi mcp --help')
    flags.add(argument)
    const value = (): string => {
      const next = args[++index]
      if (!next || next.startsWith('-')) throw new Error('Missing MCP option value; use vivi mcp --help')
      return next
    }
    switch (argument) {
      case '--session-dir': sessionDirectory = value(); break
      case '--label': label = value(); break
      case '--protocol': {
        const version = value()
        if (version !== 'legacy' && version !== '2026-07-28') throw new Error('MCP protocol must be legacy or 2026-07-28')
        protocol = version; break
      }
      case '--allow-loopback-http': allowLoopbackHttp = true; break
      case '--help': case '-h': help = true; break
      default: throw new Error('Unknown MCP option; use vivi mcp --help')
    }
  }
  if (help || positional.length === 0 || positional[0] === 'help') {
    return { sessionDirectory, protocol, allowLoopbackHttp, help: true }
  }
  const action = positional[0]
  if (!['add', 'list', 'login', 'connect', 'logout', 'remove'].includes(action!)) throw new Error('Unknown MCP command; use vivi mcp --help')
  const expected = action === 'add' ? 3 : action === 'list' ? 1 : 2
  if (positional.length !== expected) throw new Error('Incorrect MCP command arguments; use vivi mcp --help')
  if (action !== 'add' && (label !== undefined || flags.has('--protocol') || allowLoopbackHttp)) {
    throw new Error('MCP label, protocol and loopback options apply only to add')
  }
  const id = positional[1]
  if (id !== undefined && !/^[a-z][a-z0-9_-]{0,15}$/.test(id)) throw new Error('MCP NAME must start with a lowercase letter and use up to 16 lowercase letters, digits, underscores or hyphens')
  const endpoint = action === 'add' ? validateMcpEndpoint(positional[2], allowLoopbackHttp) : undefined
  return { action: action as Action, sessionDirectory, protocol, allowLoopbackHttp, help: false,
    ...(id === undefined ? {} : { id }), ...(endpoint === undefined ? {} : { endpoint }),
    ...(label === undefined ? {} : { label }) }
}

/** Standalone human-owned controls, deliberately dispatched before chat/TUI startup. */
export async function runMcpCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env,
  dependencies: McpCliDependencies = {}): Promise<number> {
  const secrets = environmentSecrets(env), controller = new AbortController()
  let io = dependencies.io, manager: McpManager | undefined, oauth: McpOAuthControls | undefined
  let dispose: (() => void) | undefined
  const report = (message: string): void => {
    try { if (io && !io.failed) { io.write(message); return } } catch { /* A failed display must not prevent cleanup. */ }
    process.stderr.write(message)
  }
  try {
    const options = parseMcpCliArguments(args, env)
    // Never echo rejected argument values or allow environment credentials into configuration.
    if (!options.help && args.some(argument => secrets.some(secret => argument.includes(secret)))) {
      throw new Error('MCP command arguments must not contain environment credentials')
    }
    io ??= new TerminalIO({ stream: false, tui: false, secrets })
    if (options.help) { io.write(MCP_HELP); return 0 }
    dispose = io.onCancel(() => controller.abort())
    if ((options.action === 'login' || options.action === 'connect') && (io.canAutoReview !== true || io.isClosed)) {
      io.write('MCP login and connect require an interactive terminal with fresh human approval; piped approval is denied\n')
      return 1
    }
    if (options.action !== 'add' && options.action !== 'list') {
      oauth = new McpOAuthControls({ dynamicRegistration: 'explicit', ...dependencies.mcpOAuth, secrets,
        registerSecrets: values => {
          const fresh = values.filter(value => value && !secrets.includes(value))
          secrets.push(...fresh); manager?.addSecrets(fresh); io?.addSecrets?.(fresh)
        } })
    }
    manager = (dependencies.mcpManagerFactory ?? (settings => new McpManager(settings)))({
      store: new McpConfigStore(options.sessionDirectory, secrets), env, secrets, ...oauth?.managerOptions()
    })
    oauth?.bind(manager)
    await manager.reload()
    controller.signal.throwIfAborted()
    const service = new McpSetupService(manager, oauth)
    switch (options.action) {
      case 'add':
        await service.addHttp({ id: options.id!, endpoint: options.endpoint!, protocol: options.protocol,
          allowLoopbackHttp: options.allowLoopbackHttp, ...(options.label === undefined ? {} : { label: options.label }) },
        manager.configurationRevision())
        io.write(`MCP server ${mcpDisplayJson(options.id)} saved disabled. Run vivi mcp connect ${options.id} for reviewed setup\n`)
        return 0
      case 'list': {
        const snapshot = service.list()
        if (!snapshot.servers.length) io.write('No MCP servers configured. Use vivi mcp add NAME URL\n')
        for (const server of snapshot.servers) {
          io.write(`${mcpDisplayJson(server.id)} · ${mcpDisplayJson(server.label)} · ${server.transport} · ${server.protocol} · ${server.state}` +
            `${server.signInState ? ` · sign-in: ${server.signInState}` : ''}` +
            `${server.endpoint ? ` · ${mcpDisplayJson(server.endpoint)}` : ''}` +
            `${server.nextAction ? ` · next: ${server.nextAction}` : ''}\n`)
        }
        return 0
      }
      case 'connect': case 'login': {
        const connected = await service[options.action](options.id!, io, controller.signal)
        if (controller.signal.aborted || io.isClosed) return 130
        if (!connected) { io.write('MCP setup was not completed; no connection approval is retained\n'); return 1 }
        io.write(options.action === 'login' ? `MCP sign-in completed for ${mcpDisplayJson(options.id)}\n`
          : `MCP server ${mcpDisplayJson(options.id)} connected for this command; the connection closes on exit\n`)
        return 0
      }
      case 'logout':
        await service.logout(options.id!)
        io.write(`MCP server ${mcpDisplayJson(options.id)} signed out locally. Revoke its grant at the issuer to end remote access\n`)
        return 0
      case 'remove':
        await service.remove(options.id!, manager.configurationRevision())
        io.write(`MCP server ${mcpDisplayJson(options.id)} removed locally. Any issuer grant must be revoked at the issuer\n`)
        return 0
    }
    throw new Error('Use vivi mcp --help')
  } catch (error) {
    if (controller.signal.aborted) return 130
    const message = redactSecrets(error instanceof Error ? error.message : 'MCP command failed', secrets)
    report(`${message}\n`)
    return 1
  } finally {
    let mcpCleanupFailed = false, terminalCleanupFailed = false
    try { dispose?.() } catch { terminalCleanupFailed = true }
    try { try { await oauth?.close() } finally { await manager?.close() } }
    catch {
      mcpCleanupFailed = true
      report('MCP cleanup failed; owned connection cleanup could not be verified\n')
    }
    if (io) {
      const failedBeforeClose = io.failed
      try { io.close() } catch { terminalCleanupFailed = true }
      if (!failedBeforeClose && io.failed) terminalCleanupFailed = true
    }
    if (terminalCleanupFailed) process.stderr.write('vivi: terminal cleanup failed. Close this terminal window or tab before restarting vivi.\n')
    if (mcpCleanupFailed || terminalCleanupFailed) return 1
  }
}
