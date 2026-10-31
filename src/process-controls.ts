// SPDX-License-Identifier: Apache-2.0
import type { CliHost } from './host.js'
import type { ChatIO } from './terminal.js'
import type { CommandExecutionSnapshot } from './commands.js'
import type { ToolResult } from '@ayayaq/vivi'

/** Launch-owned controls, never supplied by a provider or restored transcript. */
export interface BackgroundProcessControls {
  list(): readonly CommandExecutionSnapshot[]
  stop(executionId: string): Promise<void>
  stopAll(): Promise<void>
}
const display = (value: unknown): string => JSON.stringify(value).replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}\u007f-\u009f\u2028\u2029]/gu, character => character.split('').map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''))
const HELP = '/processes · list; /processes logs ID; /processes stop ID; /processes restart ID (fresh approval); /processes stop-all\nF6 stops the selected background job; F7 stops all background jobs, including while the agent is working.\n'
function displayResult(io: ChatIO, result: ToolResult): void {
  const value = JSON.parse(result.content) as { executionId?: string; state?: string; cleanupConfirmed?: boolean; output?: string; truncated?: boolean; error?: unknown }
  io.write(`Process ${value.executionId ?? '(unavailable)'} · ${value.state ?? 'unknown'}${value.state === 'running' ? '' : value.cleanupConfirmed === true ? ' · tree cleanup verified' : ' · cleanup not confirmed'}\n`)
  if (value.output) io.write(`Untrusted log tail${value.truncated ? ' (older output truncated)' : ''}:\n${value.output}\n`)
  if (value.error) io.write(`${display(value.error)}\n`)
}

/** Binding is session scoped. Old callbacks become inert before a host is replaced. */
export function bindBackgroundProcessControls(host: CliHost, io: ChatIO): () => void {
  if (!io.onProcessControls) return () => undefined
  let active = true
  const pending = new Map<string, Promise<void>>()
  const act = (key: string, operation: () => Promise<void>): Promise<void> => {
    if (!active || io.isClosed) return Promise.resolve()
    const previous = pending.get(key)
    if (previous) return previous
    const task = (async () => {
      try { await operation() }
      catch (error) { if (active && !io.isClosed) try { io.write(`Process cleanup unconfirmed: ${error instanceof Error ? error.message : 'inspect /processes before retrying'}\n`) } catch { /* A failed display cannot turn cleanup into an unhandled rejection. */ } }
    })()
    pending.set(key, task)
    void task.then(() => { if (pending.get(key) === task) pending.delete(key) })
    return task
  }
  const controls: BackgroundProcessControls = {
    list: () => active && !io.isClosed ? host.listBackgroundCommands() : [],
    stop: executionId => act(executionId, async () => { const result = await host.stopBackgroundCommand(executionId); if (active && !io.isClosed) displayResult(io, result) }),
    stopAll: () => act('*', async () => { await host.stopAllBackgroundCommands(); if (active && !io.isClosed) io.write('Owned process trees stopped; cleanup verified\n') })
  }
  const dispose = io.onProcessControls(controls)
  return () => { active = false; dispose() }
}

export async function runProcessControl(host: CliHost, io: ChatIO, line: string): Promise<boolean> {
  if (!/^\/processes(?:\s|$)/.test(line.trim())) return false
  const match = /^\/processes(?:\s+(list|logs|stop|restart|stop-all)(?:\s+(\S+))?)?$/.exec(line.trim())
  if (!match) { io.write(HELP); return true }
  const action = match[1] ?? 'list', id = match[2]
  if (action === 'list' && !id) {
    const jobs = host.listBackgroundCommands()
    io.write(jobs.length ? `Session processes (${jobs.length}):\n` : 'No background processes in this session\n')
    for (const job of jobs) io.write(`${job.executionId} · ${job.state}${!job.background ? ' · foreground cleanup unconfirmed' : ''}${job.cleanupConfirmed ? ' · cleanup verified' : ''} · ${display([job.executable, ...job.args])}\n`)
    io.write(HELP)
  } else if (action === 'stop-all' && !id) {
    await host.stopAllBackgroundCommands()
    io.write('Owned process trees stopped; cleanup verified\n')
  } else if (id && ['logs', 'stop', 'restart'].includes(action)) {
    if (action === 'logs') displayResult(io, await host.readBackgroundCommand(id))
    else if (action === 'stop') displayResult(io, await host.stopBackgroundCommand(id))
    else {
      const controller = new AbortController(), dispose = io.onCancel(() => controller.abort())
      try { displayResult(io, await host.restartBackgroundCommand(id, controller.signal)) }
      finally { dispose() }
    }
  } else io.write(HELP)
  return true
}
