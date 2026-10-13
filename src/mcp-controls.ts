// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import type { ChatIO } from './terminal.js'
import { MCP_ENV_NAMES, mcpDisplayJson, validateMcpServer } from './mcp-config.js'
import type { McpServerConfig } from './mcp-config.js'
import { McpManager, mcpStartDisclosure } from './mcp-manager.js'
import type { McpServerStatus } from './mcp-manager.js'
import type { McpCatalogKind } from './mcp-catalog.js'

interface McpIO extends ChatIO {
  choose?<T>(title: string, choices: readonly { name: string; description?: string; value: T }[], initialIndex?: number): Promise<T | undefined>
  askText?(title: string, initial?: string): Promise<string | undefined>
}
/** The same user-authored controls work in full-screen and accessible line mode. */
export async function manageMcp(manager: McpManager, io: McpIO, defaultCwd?: string): Promise<void> {
  const controller = new AbortController(), dispose = io.onCancel(() => controller.abort())
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
    if (selected) io.write(`Server: ${status.server.id}\n${kind === 'tools' ? 'Tool name' : kind === 'resources' ? 'Resource URI' : 'URI template'}: ${mcpDisplayJson(selected.remoteKey)}\nStatus: ${selected.state}${selected.reason ? ` · ${selected.reason}` : ''}\n${kind === 'resourceTemplates' ? 'URI templates are metadata-only; expansion is unavailable' : 'Ready tools and discovered concrete resources are available to the agent with separate human approval'}\n`)
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
      io.write(`MCP · ${statuses.length} configured servers · separate human approval for calls and reads · connections start disabled each launch\n`)
      const selected = await choose('MCP connections', [
        { name: 'Back', value: 'back' }, { name: 'Add trusted installed server', value: 'add' },
        ...statuses.map(status => ({ name: `${status.server.id} · ${mcpDisplayJson(status.server.label)}`, description: `${status.state} · protocol ${status.snapshot?.protocolVersion ?? status.server.protocol}${status.snapshot ? ` · tools ${status.snapshot.categories.tools.state} (${status.snapshot.categories.tools.entries.length}) · resources ${status.snapshot.categories.resources.state} (${status.snapshot.categories.resources.entries.length})` : ''}${status.message ? ` · ${status.message}` : ''}`, value: `server:${status.server.id}` }))
      ])
      if (selected === undefined || selected === 'back') return
      if (selected === 'add') { await add(); continue }
      const status = statuses.find(value => value.server.id === selected.slice(7))
      if (!status) continue
      const serverId = status.server.id
      const action = await choose(`${status.server.id} · ${status.state}`, [
        { name: 'Back', value: 'back' },
        ...(status.state === 'disabled' ? [{ name: 'Enable and connect for this launch', description: 'Requires fresh startup approval', value: 'connect' }]
          : [{ name: 'Disable for this launch', description: 'Close and clean up the owned server process', value: 'disable' }]),
        ...(status.state === 'connected' ? [
          { name: 'Refresh tool metadata', value: 'refresh' }, { name: 'Browse tool names', value: 'tools' },
          { name: 'Discover resource metadata', description: 'List resource names/URIs and templates; retrieve no contents', value: 'resources' },
          { name: 'Browse URI templates', value: 'resourceTemplates' }
        ] : []),
        { name: 'Remove saved server entry', description: 'Disconnect first; no server files are deleted', value: 'remove' }
      ])
      if (action === undefined || action === 'back') continue
      if (action === 'connect') {
        const connected = await manager.connect(serverId, async (launch, signal) => {
          const approved = await io.approve({ call: { id: randomUUID(), name: 'connect_mcp_server', arguments: {
            serverId: launch.server.id, launchDigest: launch.digest, configRevision: launch.configRevision
          } }, currentRevision: launch.digest, description: mcpStartDisclosure(launch) }, signal)
          return approved && !signal.aborted && !io.isClosed
        }, controller.signal)
        const current = manager.statuses().find(value => value.server.id === selected.slice(7))
        io.write(connected ? `MCP ${serverId} connected · tools ${current?.snapshot?.categories.tools.state} · ${current?.snapshot?.categories.tools.entries.length ?? 0} metadata entries\n`
          : `MCP ${serverId} remains unavailable or disabled${current?.message ? ` · ${current.message}` : ''}\n`)
      } else if (action === 'disable') { await manager.disconnect(serverId); io.write(`MCP ${serverId} disabled for this launch\n`) }
      else if (action === 'remove') {
        const confirmed = await choose(`Remove the saved entry ${serverId}?`, [{ name: 'Keep server', value: false }, { name: 'Remove entry and disconnect', value: true }])
        if (confirmed) await manager.remove(serverId)
      } else if (action === 'refresh') await manager.refresh(serverId, ['tools'], controller.signal)
      else if (action === 'tools' || action === 'resources' || action === 'resourceTemplates') {
        if (action === 'resources') await manager.refresh(serverId, ['resources', 'resourceTemplates'], controller.signal)
        const fresh = manager.statuses().find(value => value.server.id === selected.slice(7))
        if (fresh) await browse(fresh, action)
      }
    }
  } finally { dispose() }
}
