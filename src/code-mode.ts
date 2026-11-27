// SPDX-License-Identifier: Apache-2.0
import { Worker } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import type { JsonObject, ToolCall, ToolImageReference, ToolResult } from '@ayayaq/vivi'
import type { ExtensionTool } from '@ayayaq/vivi/extensions'
import { agentArgumentsDigest } from '@ayayaq/vivi/events'
import { assertMcpJson, mcpDigest } from '@ayayaq/vivi/extensions/mcp'
import { CODE_LIMITS, CODE_READS, isCodeWrite } from './code-mode-contract.js'
import type { CliToolReceipt } from './conversation-records.js'
import { stageCodeWrite, type ApplyCodeWrites, type StagedWrite } from './code-mode-writes.js'
import { validateWorkspaceMutation } from './workspace-edit.js'
import { mcpContainsSecret } from './mcp-content.js'
import { publicUrlContainsSecret } from './public-url.js'

type ChildOutcome = { status: CliToolReceipt['status']; effect: CliToolReceipt['effect'] }
export type ChildDispatch = (call: ToolCall, signal: AbortSignal, parent: ToolCall) => Promise<ToolResult & { outcome?: ChildOutcome }>
type ReadReceipt = { id: string; name: string; argumentsDigest: string; path?: string; truncated?: true; status: 'failed' | 'succeeded' | 'cancelled' }
export function codeModeContainsSecret(value: unknown, secrets: readonly string[]): boolean {
  return mcpContainsSecret(value, secrets) || publicUrlContainsSecret(value, secrets)
}
/** The guest owns value only. Privacy withholding never treats it as host evidence. */
export function withholdCodeModeResult(result: ToolResult, secrets: readonly string[], valueWithheld = false): ToolResult {
  if (!valueWithheld && !codeModeContainsSecret(result, secrets)) return result
  let body: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(result.content)
    if (parsed?.untrusted === true && typeof parsed.success === 'boolean') body = parsed
  } catch { /* An interrupted or legacy result may have no structured receipts. */ }
  const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
  const safeIdentity = (value: string, digest: string): string | undefined => {
    if (!codeModeContainsSecret(value, secrets)) return value
    if (digest && !codeModeContainsSecret(digest, secrets)) {
      const alias = 'withheld-' + digest.slice(0, 16)
      if (!codeModeContainsSecret(alias, secrets)) return alias
    }
    for (let attempt = 0; attempt < 16; attempt++) {
      const alias = randomUUID()
      if (!codeModeContainsSecret(alias, secrets)) return alias
    }
    return undefined
  }
  const projection = (kind: 'calls' | 'writes' | 'reads', fields: readonly string[]): unknown[] => {
    const rows = body[kind]
    if (!Array.isArray(rows)) return []
    return rows.slice(0, CODE_LIMITS.calls).flatMap(row => {
      if (!row || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || !row.name ||
          !['succeeded', 'failed', 'denied', 'cancelled', 'unknown', 'not_attempted'].includes(row.status) ||
          (kind === 'calls' && !['not_attempted', 'confirmed', 'unknown', 'unreported'].includes(row.effect))) return []
      const exactDigest = kind === 'calls' ? row.callDigest : row.argumentsDigest
      if (!isDigest(exactDigest) && !(body.contentWithheld === true && exactDigest === undefined)) return []
      const identityDigest = isDigest(exactDigest) ? exactDigest : ''
      const id = safeIdentity(row.id, identityDigest), name = safeIdentity(row.name, identityDigest)
      if (id === undefined || name === undefined) return []
      const safe = { id, name, ...Object.fromEntries(fields.filter(key =>
        (typeof row[key] === 'string' || typeof row[key] === 'boolean') && !codeModeContainsSecret(row[key], secrets))
        .map(key => [key, row[key]])) }
      return !codeModeContainsSecret(safe, secrets) ? [safe] : []
    })
  }
  const calls = projection('calls', ['argumentsDigest', 'callDigest', 'status', 'effect'])
  const writes = projection('writes', ['path', 'argumentsDigest', 'status', 'revision', 'reviewSource', 'durabilityUnconfirmed'])
  const reads = projection('reads', ['path', 'argumentsDigest', 'status', 'truncated'])
  const content = JSON.stringify({ success: false, untrusted: true, contentWithheld: true, doNotRetry: true, reads,
    ...(calls.length ? { calls } : {}), ...(writes.length ? { writes } : {}),
    error: 'Code Mode result withheld because it contains a known credential. Inspect recorded effects before retrying.' })
  return { content: codeModeContainsSecret(content, secrets) ? 'Code mode result withheld' : content, isError: true }
}
function validate(args: Readonly<JsonObject>): void {
  if (Object.keys(args).length !== 1 || typeof args.code !== 'string' || !args.code.trim() ||
      Buffer.byteLength(args.code) > CODE_LIMITS.sourceBytes) throw new Error('Expected code with at most 8192 UTF-8 bytes')
}

async function run(call: ToolCall, signal: AbortSignal, dispatch: ChildDispatch, secrets: () => readonly string[],
  names: readonly string[], applyWrites?: ApplyCodeWrites): Promise<ToolResult> {
  const receipts: ReadReceipt[] = []
  const calls: (ChildOutcome & { id: string; name: string; argumentsDigest: string; callDigest: string })[] = []
  const images = new Map<string, ToolImageReference>()
  const writes: StagedWrite[] = []
  let nextWrite = 0
  let effects = Promise.resolve()
  const takeBatch = () => {
    const start = nextWrite
    nextWrite = writes.length
    const batch = writes.slice(start)
    return async (signal: AbortSignal) => {
      if (!applyWrites || !batch.length) return
      const parent = start ? { ...call, id: randomUUID() } : call
      const failure = await applyWrites(parent, batch, signal)
      if (failure) throw new Error(failure)
    }
  }
  const active = new Set<Promise<void>>()
  const end = new AbortController()
  const timeout = new AbortController()
  const scope = AbortSignal.any([signal, end.signal, timeout.signal])
  let remaining = Number(CODE_LIMITS.timeoutMs), started = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => timeout.abort(), remaining)
  const interrupt = new Int32Array(new SharedArrayBuffer(4))
  let worker: Worker | undefined, onAbort: (() => void) | undefined
  let value: unknown = null, error: string | undefined
  try {
    scope.throwIfAborted()
    if (codeModeContainsSecret(call, secrets())) throw new Error('Code contains a known credential')
    const guest = new Worker(new URL('./code-mode-guest.js', import.meta.url), {
      workerData: { code: call.arguments.code, interrupt: interrupt.buffer, names }, execArgv: [], env: {}
    })
    worker = guest
    value = await new Promise<unknown>((resolve, reject) => {
      onAbort = () => reject(new Error(timeout.signal.aborted ? 'Code mode deadline exceeded' : 'Code mode cancelled'))
      scope.addEventListener('abort', onAbort, { once: true })
      guest.once('error', () => reject(new Error('Code mode worker failed')))
      guest.once('exit', () => reject(new Error('Code mode worker ended')))
      guest.on('message', message => {
        if (scope.aborted) return
        if (message.kind === 'waiting' || message.kind === 'running') {
          if (message.kind === 'waiting' && timer) {
            clearTimeout(timer); timer = undefined
            remaining -= performance.now() - started
          } else if (message.kind === 'running' && !timer) {
            started = performance.now()
            timer = setTimeout(() => timeout.abort(), Math.max(1, remaining))
          }
          return
        }
        if (message.kind === 'error') { reject(new Error(message.message)); return }
        if (message.kind === 'result') {
          try {
            if (typeof message.json !== 'string' || Buffer.byteLength(message.json) > CODE_LIMITS.outputBytes) throw new Error()
            resolve(JSON.parse(message.json))
          } catch { reject(new Error('Expected a bounded JSON result')) }
          return
        }
        if (message.kind !== 'call' || !names.includes(message.name) || receipts.length + calls.length + writes.length >= CODE_LIMITS.calls ||
            active.size >= CODE_LIMITS.concurrent || typeof message.args !== 'string' || Buffer.byteLength(message.args) > CODE_LIMITS.argumentBytes) {
          reject(new Error('Tool unavailable or call limit exceeded')); return
        }
        let args: JsonObject
        try {
          args = JSON.parse(message.args)
          assertMcpJson(args, CODE_LIMITS.argumentBytes)
          if (!args || typeof args !== 'object' || Array.isArray(args) ||
              codeModeContainsSecret(args, secrets())) throw new Error()
        } catch {
          guest.postMessage({ id: message.id, content: 'Invalid tool arguments', failed: true })
          return
        }
        const child: ToolCall = { id: randomUUID(), name: message.name, arguments: args }
        if (applyWrites && isCodeWrite(child.name)) {
          try { validateWorkspaceMutation(child.name, args) }
          catch {
            guest.postMessage({ id: message.id, content: 'Invalid workspace change arguments', failed: true })
            return
          }
          writes.push(stageCodeWrite(child))
          guest.postMessage({ id: message.id, content: '{"staged":true}', failed: false })
          return
        }
        const workspaceRead = CODE_READS.some(name => name === child.name)
        const identity = { id: child.id, name: child.name, argumentsDigest: agentArgumentsDigest(args) }
        const read: ReadReceipt = { ...identity, ...(typeof args.path === 'string' ? { path: args.path } : {}), status: 'failed' }
        const receipt: (typeof calls)[number] = { ...identity, callDigest: mcpDigest(child), status: 'failed', effect: 'not_attempted' }
        if (workspaceRead) receipts.push(read)
        else calls.push(receipt)
        const flush = workspaceRead ? undefined : takeBatch()
        const invoke = async () => {
          if (flush) await flush(scope)
          scope.throwIfAborted()
          let content = 'Tool call failed', failed = true
          try {
            receipt.effect = 'unknown'
            const result = await dispatch(child, scope, call)
            Object.assign(receipt, result.outcome ?? { status: result.isError ? 'failed' : 'succeeded', effect: 'unknown' })
            if (!scope.aborted && Buffer.byteLength(result.content) <= CODE_LIMITS.heapBytes / 4 && !codeModeContainsSecret(result, secrets())) {
              let value: unknown
              try { value = JSON.parse(result.content) } catch { value = result.content }
              content = result.isError ? result.content : JSON.stringify(value)
              failed = result.isError === true
              if (!failed) {
                if (value && typeof value === 'object' && 'truncated' in value && value.truncated === true) read.truncated = true
                read.status = 'succeeded'
                for (const image of result.images ?? []) images.set(image.id, image)
                if (images.size > 4) { reject(new Error('At most four distinct image observations per query')); return }
              }
            }
          } catch { /* Untrusted executor exceptions are withheld. */ }
          if (scope.aborted) read.status = 'cancelled'
          else guest.postMessage({ id: message.id, content, failed })
        }
        const job = workspaceRead ? invoke() : effects.then(invoke)
        if (!workspaceRead) effects = job
        active.add(job)
        void job.then(() => active.delete(job), error => { active.delete(job); reject(error) })
      })
    })
  } catch (failure) {
    error = failure instanceof Error ? failure.message : 'Code mode failed'
  } finally {
    clearTimeout(timer)
    if (onAbort) scope.removeEventListener('abort', onAbort)
    end.abort()
    Atomics.store(interrupt, 0, 1)
    await Promise.allSettled([...active, ...(worker ? [worker.terminate()] : [])])
  }
  const valueWithheld = codeModeContainsSecret(value, secrets())
  if (valueWithheld) error = 'Result contains a known credential'
  if (!error && nextWrite < writes.length) {
    try { await takeBatch()(signal) } catch (failure) { error = failure instanceof Error ? failure.message : 'Workspace changes failed' }
  }
  const body = { success: !error, untrusted: true, reads: receipts,
    ...(calls.length ? { calls } : {}),
    ...(writes.length ? { writes: writes.map(item => item.receipt) } : {}), ...(error ? { error } : { value }) }
  return withholdCodeModeResult({ content: JSON.stringify(body), ...(error ? { isError: true } : {}),
    ...(!error && images.size && !codeModeContainsSecret([...images.values()], secrets()) ? { images: [...images.values()] } : {}) }, secrets(), valueWithheld)
}

export function codeModeTool(dispatch: ChildDispatch, secrets: () => readonly string[], track: (call: ToolCall, work: Promise<ToolResult>) => void,
  available: () => readonly string[] = () => CODE_READS, applyWrites?: ApplyCodeWrites): ExtensionTool {
  return {
    definition: { name: 'code_mode', description: 'Run a JavaScript async function body. Object.keys(tools) lists the other tools available this turn. Await tools[name](args) using the advertised direct schema. Calls return parsed JSON or plain text and reject on tool errors. Permissions apply to each action. ' +
      (applyWrites ? 'Workspace text creates and edits stage one change per path. Workspace search, list, glob and text reads see on-disk contents. The host reviews pending changes together before another kind of tool runs or the script finishes. ' : '') +
      'Return a JSON value. Up to 8 calls, 4 in flight, 10 seconds of script time and 8192 result bytes.',
      parameters: { type: 'object', properties: { code: { type: 'string', maxLength: CODE_LIMITS.sourceBytes } }, required: ['code'], additionalProperties: false } },
    validateArguments: validate,
    execute(call, { signal }) {
      const work = run(call, signal, dispatch, secrets, available().filter(name => name !== 'code_mode'), applyWrites)
      track(call, work)
      return work
    }
  }
}
