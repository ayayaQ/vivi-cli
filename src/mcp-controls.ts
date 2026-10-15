// SPDX-License-Identifier: Apache-2.0
import type { ChatIO } from './terminal.js'
import { MCP_ENV_NAMES, isMcpHttpServer, mcpDisplayJson, validateMcpServer } from './mcp-config.js'
import type { McpServerConfig } from './mcp-config.js'
import { McpManager } from './mcp-manager.js'
import type { McpServerStatus } from './mcp-manager.js'
import type { McpCatalogKind } from './mcp-catalog.js'
import type { McpOAuthControls } from './mcp-oauth-controls.js'
import { McpOAuthError } from './mcp-oauth-session.js'
import { mcpOAuthRegistrationFailureMessage } from './mcp-oauth-callback.js'
import { McpOAuthStoreError } from './mcp-oauth-store.js'
import { McpSetupService } from './mcp-setup.js'

interface McpIO extends ChatIO {
  choose?<T>(title: string, choices: readonly { name: string; description?: string; value: T }[], initialIndex?: number): Promise<T | undefined>
  askText?(title: string, initial?: string): Promise<string | undefined>
}
/** The same user-authored controls work in full-screen and accessible line mode. */
export async function manageMcp(manager: McpManager, io: McpIO, defaultCwd?: string, oauth?: McpOAuthControls): Promise<void> {
  const controller = new AbortController(), dispose = io.onCancel(() => controller.abort())
  const setup = new McpSetupService(manager, oauth)
  const choose = async <T>(title: string, choices: readonly { name: string; description?: string; value: T }[]): Promise<T | undefined> => {
    controller.signal.throwIfAborted()
    if (io.isClosed) return
    if (io.choose) return io.choose(title, choices, 0)
    io.write(`${title}\n${choices.map((choice, index) => `${index + 1}. ${choice.name}${choice.description ? ` · ${choice.description}` : ''}`).join('\n')}\n`)
    const value = await io.readLine('Choose a number; blank cancels: ', controller.signal)
    if (!value?.trim()) return
    const index = Number(value.trim()) - 1
    return Number.isSafeInteger(index) ? choices[index]?.value : undefined
  }
  const text = async (title: string, initial?: string): Promise<string | undefined> => {
    controller.signal.throwIfAborted()
    if (io.isClosed) return
    if (io.askText) return io.askText(title, initial)
    const value = await io.readLine(`${title}${initial ? ` [${initial}]` : ''}: `, controller.signal)
    return value === undefined ? undefined : value || initial || ''
  }
  const add = async (): Promise<void> => {
    const id = await text('Local server ID (a-z, 0-9, underscore or hyphen; max 16)')
    if (id === undefined || !id.trim()) return
    const label = await text('Server label', id)
    if (label === undefined) return
    const executable = await text('Absolute path to its already installed trusted executable')
    if (executable === undefined || !executable.trim()) return
    const cwd = await text('Working directory (absolute path)', defaultCwd)
    if (cwd === undefined || !cwd.trim()) return
    const countText = await text('Number of separate arguments (0 to 16; credentials and inline code are unsupported)', '0')
    if (countText === undefined) return
    const count = Number(countText)
    if (!Number.isSafeInteger(count) || count < 0 || count > 16) throw new Error('MCP argument count must be from 0 to 16')
    const args: string[] = []
    for (let index = 0; index < count; index++) {
      const argument = await text(`Argument ${index + 1} (one argument; no shell parsing or credentials)`)
      if (argument === undefined) return
      args.push(argument)
    }
    const protocol = await choose<McpServerConfig['protocol']>('Protocol compatibility', [
      { name: 'Legacy 2025 compatibility', value: 'legacy' },
      { name: 'Pin modern 2026-07-28', description: 'The server must support this exact revision; no fallback or extra process', value: '2026-07-28' }
    ])
    if (protocol === undefined) return
    const environment = await choose<readonly string[]>('Environment allowlist · credentials are unavailable in this slice', [
      { name: 'Empty environment', description: 'No inherited environment values', value: [] },
      { name: 'Minimal profile/temp paths', description: MCP_ENV_NAMES.join(', '), value: [...MCP_ENV_NAMES] }
    ])
    if (environment === undefined) return
    const server = validateMcpServer({ id, label, executable, args, cwd, protocol, environment })
    const save = await choose('Save a disabled MCP server? Starting requires a separate fresh approval', [
      { name: 'Cancel', value: false }, { name: `Add ${server.id} disabled`, value: true }
    ])
    if (save && !controller.signal.aborted && !io.isClosed) {
      await manager.configure(server)
      io.write(`MCP server ${server.id} saved disabled. Use Enable and connect for a fresh startup approval\n`)
    }
  }
  const addHttp = async (): Promise<void> => {
    const endpoint = await text('MCP server URL (HTTPS)')
    if (endpoint === undefined || !endpoint.trim()) return
    const id = await text('Server name (a-z, 0-9, underscore or hyphen; max 16)')
    if (id === undefined || !id.trim()) return
    let allowLoopbackHttp = false
    if (endpoint.startsWith('http:')) {
      const allowed = await choose('Allow unencrypted HTTP to this literal loopback endpoint?', [
        { name: 'Cancel', value: false }, { name: 'Allow 127.0.0.1 or ::1 only', value: true }
      ])
      if (!allowed) return
      allowLoopbackHttp = true
    }
    const server = validateMcpServer({ transport: 'http', id, label: id, endpoint, protocol: 'auto', allowLoopbackHttp })
    const revision = manager.configurationRevision()
    const affected = manager.statuses().filter(status => status.state !== 'disabled').map(status => status.server.id)
    const save = await choose(`Add ${server.id} at ${endpoint}?${affected.length ? ` Existing connections will disconnect: ${affected.join(', ')}` : ''}`, [
      { name: 'Cancel', value: false }, { name: 'Add server', description: 'Save disabled, then choose Connect; sign-in is discovered when needed', value: true }
    ])
    if (save && !controller.signal.aborted && !io.isClosed) {
      await setup.addHttp({ id, endpoint, allowLoopbackHttp }, revision)
      io.write(`MCP ${server.id} saved disabled. Choose Connect to use it; technical overrides are in Advanced\n`)
    }
  }
  const configureOAuth = async (serverId: string): Promise<void> => {
    if (!oauth) return
    const id = await text('Pre-registered public OAuth client ID (no client secret)')
    if (id === undefined || !id) return
    const issuer = await text('Pinned OAuth issuer (HTTPS; exact registered issuer)')
    if (issuer === undefined || !issuer) return
    const portText = await text('Exact registered IPv4 loopback callback port (1 to 65535)')
    if (portText === undefined || !portText) return
    const redirectPort = Number(portText)
    if (!/^[0-9]+$/.test(portText) || !Number.isInteger(redirectPort) || redirectPort < 1 || redirectPort > 65535)
      throw new Error('MCP OAuth callback port must be from 1 to 65535')
    const redirectPath = await text('Exact registered callback path (begins with /; no query or fragment)')
    if (redirectPath === undefined || !redirectPath) return
    const scopeText = await text('Requested OAuth scopes (space-separated; blank for none)')
    if (scopeText === undefined) return
    const scopes = scopeText.trim() ? scopeText.trim().split(/ +/) : []
    const remembered = oauth.savesSignIn()
    const save = await choose(remembered ? 'Save these public client settings securely? Existing saved tokens for this server will be cleared; no sign-in is started'
      : 'Use this public OAuth client for this launch? Nothing is saved or started', [
      { name: 'Cancel', value: false }, { name: remembered ? 'Save public client settings' : 'Use launch-only public client settings', description: 'A fresh reviewed sign-in and connection setup is still required', value: true }
    ])
    if (save && !controller.signal.aborted && !io.isClosed) {
      await oauth.configureClient(serverId, { id, issuer, redirectPort, redirectPath, scopes })
      io.write(`MCP ${serverId} public OAuth client ${remembered ? 'saved securely; previous saved tokens cleared' : 'set for this launch'}. Use Sign in and connect when ready\n`)
    }
  }
  const registerOAuth = async (serverId: string): Promise<void> => {
    if (!oauth?.canRegisterPublicClient()) return
    const issuer = await text('Pinned OAuth issuer for public client registration (HTTPS; exact issuer)')
    if (issuer === undefined || !issuer) return
    const portText = await text('Fixed IPv4 callback port on 127.0.0.1 (1 to 65535; no automatic port)')
    if (portText === undefined || !portText) return
    const redirectPort = Number(portText)
    if (!/^[0-9]+$/.test(portText) || !Number.isInteger(redirectPort) || redirectPort < 1 || redirectPort > 65535)
      throw new Error('MCP OAuth callback port must be from 1 to 65535')
    const redirectPath = await text('Exact callback path (begins with /; no query or fragment)')
    if (redirectPath === undefined || !redirectPath) return
    const scopeText = await text('Explicit requested OAuth scopes (space-separated; blank for none)')
    if (scopeText === undefined) return
    const scopes = scopeText.trim() ? scopeText.trim().split(/ +/) : []
    const clientName = await text('Public OAuth client display name', 'vivi-cli')
    if (clientName === undefined || !clientName) return
    const registered = await oauth.registerPublicClient(serverId, { issuer, redirectPort, redirectPath, scopes, clientName }, io, controller.signal)
    io.write(registered ? `MCP ${serverId} public OAuth client registered for this launch. Returning to the menu; use Sign in and connect for a fresh reviewed setup. The issuer may retain the registration after local disconnect\n`
      : `MCP ${serverId} public OAuth client registration declined; no registration request sent\n`)
  }
  const browse = async (status: McpServerStatus, kind: McpCatalogKind): Promise<void> => {
    const category = status.snapshot?.categories[kind]
    if (!category) return
    io.write(`${kind}: ${category.state} · ${category.entries.length} entries${category.reason ? ` · ${category.reason}` : ''}\n`)
    const entry = await choose(`${status.server.id} · ${kind} · metadata only`, [
      { name: 'Back', value: -1 }, ...category.entries.map((entry, index) => ({
        name: mcpDisplayJson(entry.remoteKey).slice(0, 100), description: entry.reason ?? `${entry.state} · ${entry.alias}`, value: index }))
    ])
    if (entry === undefined || entry < 0) return
    const selected = category.entries[entry]
    if (selected) io.write(`Server: ${status.server.id}\n${kind === 'tools' ? 'Tool name' : kind === 'resources' ? 'Resource URI' : 'URI template'}: ${mcpDisplayJson(selected.remoteKey)}\nStatus: ${selected.state}${selected.reason ? ` · ${selected.reason}` : ''}\n${kind === 'resourceTemplates' ? 'Admitted scalar URI templates can be expanded for a separately reviewed resource read; browsing retrieves no contents. Unsupported templates remain metadata only' : 'Ready tools and discovered concrete resources are available to the agent with separate human approval'}\n`)
  }
  const cleanupUnavailableConfiguration = async (): Promise<void> => {
    for (;;) {
      if (io.isClosed || controller.signal.aborted) return
      const retained = manager.statuses().filter(status => status.state === 'error')
      if (!retained.length) throw new Error('MCP saved configuration remains unavailable or invalid; owned connections are disabled')
      io.write(`MCP cleanup only · ${retained.length} owned connections retained · saved configuration unavailable\n`)
      const selected = await choose('MCP cleanup · saved configuration unavailable', [
        { name: 'Back', value: 'back' }, ...retained.map(status => ({
          name: `Disable ${status.server.id} and retry cleanup`,
          description: `${mcpDisplayJson(status.server.label)} · error · owned connection retained; no catalog is available`,
          value: `cleanup:${status.server.id}`
        }))
      ])
      if (selected === undefined || selected === 'back') {
        if (io.isClosed || controller.signal.aborted) return
        throw new Error('MCP saved configuration is unavailable; owned process cleanup remains unverified')
      }
      const status = retained.find(value => selected === `cleanup:${value.server.id}`)
      if (!status) continue
      try {
        // Disconnect deliberately avoids parsing the unavailable saved configuration.
        await manager.disconnect(status.server.id)
        if (manager.statuses().find(value => value.server.id === status.server.id)?.state === 'disabled') {
          io.write(`MCP ${status.server.id} disabled for this launch; owned connection cleanup completed\n`)
        } else io.write(`MCP ${status.server.id} cleanup could not be verified; use Disable to retry\n`)
      } catch {
        // Transport failure details can be untrusted. Keep the retained-ownership
        // warning bounded and explicit without exposing server text or credentials.
        io.write(`MCP ${status.server.id} cleanup could not be verified; owned connection retained for explicit Disable retry\n`)
      }
    }
  }
  try {
    for (;;) {
      if (io.isClosed || controller.signal.aborted) return
      try { await manager.reload() }
      catch (error) {
        if (!manager.statuses().some(status => status.state === 'error')) throw error
        await cleanupUnavailableConfiguration()
        return
      }
      const statuses = manager.statuses()
      const snapshotRevision = manager.configurationRevision()
      io.write(`MCP · ${statuses.length} configured servers · separate human approval for calls and reads · choose a server to connect or sign in\n`)
      const selected = await choose('MCP connections', [
        { name: 'Back', value: 'back' }, { name: 'Add MCP server (URL)', value: 'add-http' },
        ...statuses.map(status => ({ name: `${status.server.id} · ${mcpDisplayJson(status.server.label)}`, description: `${status.state}${oauth && isMcpHttpServer(status.server) ? ` · sign-in ${oauth.status(status.server.id).state}` : ''} · protocol ${status.snapshot?.protocolVersion ?? status.server.protocol}${status.snapshot ? ` · tools ${status.snapshot.categories.tools.state} (${status.snapshot.categories.tools.entries.length}) · resources ${status.snapshot.categories.resources.state} (${status.snapshot.categories.resources.entries.length})` : ''}${status.message || oauth?.connectionFailure(status.server.id) ? ` · ${status.message ?? oauth?.connectionFailure(status.server.id)}` : ''}`, value: `server:${status.server.id}` })),
        { name: 'Advanced · add installed server', description: 'Trusted existing executable; no package installation', value: 'add' }
      ])
      if (selected === undefined || selected === 'back') return
      if (selected === 'add') { await add(); continue }
      if (selected === 'add-http') { await addHttp(); continue }
      const status = statuses.find(value => value.server.id === selected.slice(7))
      if (!status) continue
      const serverId = status.server.id
      const authState = oauth && isMcpHttpServer(status.server) ? oauth.status(serverId).state : undefined
      const next = !oauth?.hasSavedSignIn(serverId) && authState && !['unconfigured', 'connected'].includes(authState) ? 'Sign in' : status.state === 'error' ? 'Reconnect' : 'Connect'
      const action = await choose(`${status.server.id} · ${status.state}`, [
        { name: 'Back', value: 'back' },
        ...(status.state === 'connected' ? [{ name: 'Disconnect', description: 'Close this connection and clear launch credentials', value: 'disable' }]
          : [{ name: next, description: 'Review the endpoint; browser sign-in is guided when needed', value: next === 'Sign in' ? 'sign-in' : 'connect' }]),
        ...(status.state === 'connected' ? [
          { name: 'Refresh tool metadata', value: 'refresh' }, { name: 'Browse tool names', value: 'tools' },
          { name: 'Discover resource metadata', description: 'List names/URIs and templates; retrieve no contents', value: 'resources' },
          { name: 'Browse URI templates', value: 'resourceTemplates' }
        ] : []),
        ...(isMcpHttpServer(status.server) ? [
          ...(oauth?.savesSignIn() ? [
            { name: 'Sign out', description: 'Forget saved sign-in locally; retain public client settings when readable', value: 'logout' },
            { name: 'Sign in again', description: 'Fresh reviewed browser sign-in; replaces saved credentials securely', value: 'sign-in' },
            { name: 'Session-only sign in', description: 'Explicitly keep this new sign-in in RAM for this launch', value: 'session-sign-in' }
          ] : []),
          { name: 'Advanced', description: 'Protocol compatibility and public OAuth client overrides', value: 'advanced' },
          ...(oauth?.hasActiveAttempt(serverId) ? [{ name: 'Cancel sign-in', value: 'cancel-sign-in' }] : [])
        ] : []),
        { name: 'Remove saved server entry', description: 'Disconnect first; no server files are deleted', value: 'remove' }
      ])
      if (action === undefined || action === 'back') continue
      try {
      if (action === 'advanced') {
        const advanced = await choose(`${serverId} · Advanced`, [
          { name: 'Back', value: 'back' },
          ...(oauth && isMcpHttpServer(status.server) && status.server.endpoint.startsWith('https:') ? [
            { name: 'Public client settings', description: 'Existing public registration: client ID, issuer, callback and scopes', value: 'oauth-client' },
            { name: 'Hosted client metadata document', description: 'Optional HTTPS JSON CIMD document; used only when supported', value: 'oauth-metadata' }
          ] : []),
          ...(oauth?.canRegisterPublicClient() ? [{ name: 'Register public client manually', description: 'Technical compatibility override; normal sign-in discovers this automatically', value: 'oauth-register' }] : []),
          { name: 'Protocol compatibility', description: 'Automatic negotiation (default), exact modern revision or legacy compatibility', value: 'protocol' }
        ])
        if (advanced === 'oauth-client') await configureOAuth(serverId)
        else if (advanced === 'oauth-register') await registerOAuth(serverId)
        else if (advanced === 'oauth-metadata' && oauth) {
          const url = await text('Hosted HTTPS client metadata URL (JSON; exact registered loopback callback)')
          if (url) { oauth.setClientMetadataUrl(serverId, url); io.write(`MCP ${serverId} client metadata URL set for this launch. Choose Sign in when ready\n`) }
        }
        else if (advanced === 'protocol' && isMcpHttpServer(status.server)) {
          const revision = snapshotRevision
          const protocol = await choose<McpServerConfig['protocol']>('Protocol compatibility', [
            { name: 'Back', value: status.server.protocol },
            { name: 'Automatic compatibility (default)', description: 'Negotiate a supported protocol with this server', value: 'auto' },
            { name: 'Pin modern 2026-07-28', description: 'Require this exact revision; no fallback', value: '2026-07-28' },
            { name: 'Legacy 2025 compatibility', value: 'legacy' }
          ])
          if (protocol && protocol !== status.server.protocol) {
            const affected = manager.statuses().filter(value => value.state !== 'disabled').map(value => value.server.id)
            const approved = await choose(`Save ${protocol} for ${serverId}?${affected.length ? ` Connections will disconnect: ${affected.join(', ')}` : ''}`, [
              { name: 'Cancel', value: false }, { name: 'Save protocol and disconnect', value: true }
            ])
            if (approved && !controller.signal.aborted && !io.isClosed) await manager.update({ ...status.server, protocol }, revision)
          }
        }
        continue
      }
      if (action === 'sign-in' && oauth) {
        const connected = await setup.login(serverId, io, controller.signal)
        io.write(connected ? `MCP ${serverId} signed in and connected for this launch\n` : `MCP ${serverId} is not connected; review the setup details above\n`)
        continue
      }
      if (action === 'session-sign-in' && oauth) {
        const connected = await setup.login(serverId, io, controller.signal, 'session-only')
        io.write(connected ? `MCP ${serverId} signed in for this launch only\n` : `MCP ${serverId} sign-in stopped\n`)
        continue
      }
      if (action === 'logout') { await setup.logout(serverId); io.write(`MCP ${serverId} signed out locally. Any issuer grant remains until revoked there\n`); continue }
      if (action === 'cancel-sign-in' && oauth) { await manager.disconnect(serverId); io.write(`MCP ${serverId} OAuth attempt cancelled and disconnected\n`); continue }
      if (action === 'connect') {
        const connected = await setup.connect(serverId, io, controller.signal)
        const current = manager.statuses().find(value => value.server.id === selected.slice(7))
        io.write(connected ? `MCP ${serverId} connected · tools ${current?.snapshot?.categories.tools.state} · ${current?.snapshot?.categories.tools.entries.length ?? 0} metadata entries\n`
          : `MCP ${serverId} remains unavailable or disabled${current?.message ? ` · ${current.message}` : ''}\n`)
      } else if (action === 'disable') { await manager.disconnect(serverId); io.write(`MCP ${serverId} disabled for this launch\n`) }
      else if (action === 'remove') {
        const revision = snapshotRevision
        const affected = manager.statuses().filter(status => status.state !== 'disabled').map(status => status.server.id)
        const confirmed = await choose(`Remove the saved entry ${serverId}?${affected.length ? ` Connections will disconnect: ${affected.join(', ')}` : ''}`, [{ name: 'Keep server', value: false }, { name: 'Remove entry and disconnect', value: true }])
        if (confirmed && !controller.signal.aborted && !io.isClosed) await setup.remove(serverId, revision)
      } else if (action === 'refresh') await manager.refresh(serverId, ['tools'], controller.signal)
      else if (action === 'tools' || action === 'resources' || action === 'resourceTemplates') {
        if (action === 'resources') await manager.refresh(serverId, ['resources', 'resourceTemplates'], controller.signal)
        const fresh = manager.statuses().find(value => value.server.id === selected.slice(7))
        if (fresh) await browse(fresh, action)
      }
      } catch (error) {
        // Native renderer failures must reach the application's fatal cleanup path.
        // A closed failed surface is different from ordinary user cancellation.
        if (io.failed) throw error
        if (controller.signal.aborted || io.isClosed) return
        if (error instanceof McpOAuthStoreError) io.write(`${error.message}\n`)
        else if (error instanceof McpOAuthError && error.code === 'client-registration-uncertain')
          io.write(`${mcpOAuthRegistrationFailureMessage(serverId, error)}\n`)
        else if (error instanceof McpOAuthError && error.code === 'client-registration-required')
          io.write(`MCP ${serverId} needs public client setup. Choose Sign in for discovery, or use Advanced for an existing registration\n`)
        else io.write(`MCP ${serverId} setup did not complete. Check the server URL and protocol or use Advanced for public client overrides. Ordinary chat remains available\n`)
      }
    }
  } finally { dispose() }
}
