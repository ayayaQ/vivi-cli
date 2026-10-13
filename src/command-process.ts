// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import fs from 'node:fs/promises'
import { launchWindowsCommand } from './command-windows.js'

export interface CommandProcessInput {
  executable: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
}
export interface CommandProcessExit { exitCode: number | null; signal?: string; error?: string }
export interface CommandProcess {
  stdout: Readable
  stderr: Readable
  completed: Promise<CommandProcessExit>
  stop(): Promise<void>
}

async function liveGroupMembers(group: number): Promise<boolean> {
  try { process.kill(-group, 0) }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return false; throw error }
  if (process.platform === 'linux') {
    const directory = await fs.opendir('/proc')
    for await (const entry of directory) {
      if (!/^\d+$/.test(entry.name)) continue
      let stat: string
      try { stat = await fs.readFile(`/proc/${entry.name}/stat`, 'utf8') }
      catch (error) { if (error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ESRCH')) continue; throw error }
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/)
      if (Number(fields[2]) === group && fields[0] !== 'Z' && fields[0] !== 'X') return true
    }
    return false
  }
  // macOS has no /proc. This fixed host utility is cleanup bookkeeping, never
  // a model-controlled command or a shell string, and gets no ambient secrets.
  return new Promise<boolean>((resolve, reject) => {
    const query = spawn('/bin/ps', ['-axo', 'pgid=,stat='], { shell: false, env: { LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = '', failure: Error | undefined
    const timeout = setTimeout(() => { failure = new Error('Process group verification timed out'); query.kill('SIGKILL') }, 1000)
    query.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.length > 256 * 1024) { failure = new Error('Process group verification exceeded its output limit'); query.kill('SIGKILL') }
    })
    query.once('error', error => { failure = error })
    query.once('close', code => {
      clearTimeout(timeout)
      if (failure || code !== 0) { reject(failure ?? new Error('Process group verification failed')); return }
      resolve(output.trim().split('\n').some(line => { const [id, state] = line.trim().split(/\s+/)
        return Number(id) === group && state !== undefined && !state.startsWith('Z') && !state.startsWith('X') }))
    })
  })
}
async function waitForGroupDeath(group: number): Promise<void> {
  const deadline = performance.now() + 3_000
  while (await liveGroupMembers(group)) {
    if (performance.now() >= deadline) throw new Error('Process group cleanup could not be verified before its deadline')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** No shell interpolation. A detached POSIX group keeps descendants addressable after parent exit. */
export async function launchCommandProcess(input: CommandProcessInput): Promise<CommandProcess> {
  if (process.platform === 'win32') return launchWindowsCommand(input)
  const child = spawn(input.executable, [...input.args], { cwd: input.cwd, env: { ...input.env },
    shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let failure: string | undefined
  let stopped: Promise<void> | undefined
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const killGroup = (): void => {
    if (!child.pid) return
    try { process.kill(-child.pid, 'SIGKILL') }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')) throw error }
  }
  const boundedCleanup = (): void => {
    if (cleanupTimer) return
    cleanupTimer = setTimeout(() => {
      failure = 'Process group cleanup could not be verified; an escaped process may still hold output pipes'
      child.stdout.destroy(); child.stderr.destroy()
    }, 3_000)
    cleanupTimer.unref()
  }
  const completed = new Promise<CommandProcessExit>((resolve) => {
    child.once('error', error => { failure = error.message })
    // A parent may exit while a grandchild still owns its stdout. Kill the group
    // on exit, before waiting for close; otherwise inherited pipes can hang forever.
    child.once('exit', () => { try { killGroup() } catch (error) { failure = String(error) }; boundedCleanup() })
    child.once('close', (exitCode, signal) => { if (cleanupTimer) clearTimeout(cleanupTimer)
      closed = true
      void (async () => {
        if (child.pid) try { await waitForGroupDeath(child.pid) } catch (error) { failure = error instanceof Error ? error.message : 'Process group cleanup could not be verified' }
        resolve({ exitCode, ...(signal ? { signal } : {}), ...(failure ? { error: failure } : {}) })
      })() })
  })
  return { stdout: child.stdout, stderr: child.stderr, completed,
    stop: () => closed ? completed.then(() => undefined) : stopped ??= (async () => { killGroup(); boundedCleanup(); await completed })() }
}
