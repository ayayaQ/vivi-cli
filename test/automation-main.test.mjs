// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test as nodeTest } from 'node:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { main } from '../dist/main.js'
import { CliHost } from '../dist/host.js'
import { McpManager } from '../dist/mcp-manager.js'
import { FileSessionStore } from '../dist/session.js'

const test = (name, fn) => nodeTest(name, { timeout: 15_000 }, fn)
const reported = { inputTokens: 4, outputTokens: 2, totalTokens: 6 }
const reply = (content = 'Done', toolCalls = [], usage = reported) => ({ content, toolCalls, ...(usage ? { usage } : {}) })
const call = (id, name, args = {}) => ({ id, name, arguments: args })
const terminalTypes = new Set(['run.completed', 'run.failed', 'run.cancelled'])
function capture() {
  let text = ''
  const stream = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback() } })
  return { stream, text: () => text }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vivi-automation-main-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'state')
  return { root, directory, env: { VIVI_SESSION_DIR: directory, OPENAI_API_KEY: 'offline-automation-key' } }
}
function events(text, status) {
  assert(text.endsWith('\n'), 'Healthy protocol ends with a newline')
  assert(!text.includes('\u001b'), 'No terminal controls may contaminate JSONL')
  const rows = text.trimEnd().split('\n').map(line => JSON.parse(line))
  assert.equal(rows[0].type, 'run.started')
  assert.equal(new Set(rows.map(row => row.run_id)).size, 1)
  assert.match(rows[0].run_id, /^[a-f0-9-]{36}$/)
  for (const [index, row] of rows.entries()) {
    assert.equal(row.protocol, 'vivi.automation'); assert.equal(row.version, 1); assert.equal(row.seq, index + 1)
  }
  assert.equal(rows.filter(row => terminalTypes.has(row.type)).length, 1)
  assert(terminalTypes.has(rows.at(-1).type)); assert.equal(rows.at(-1).exit_code, status)
  return rows
}
async function run(f, options = {}) {
  const stdout = capture(), stderr = capture()
  const args = options.args ?? ['--jsonl', '--model', 'offline-model', '--no-workspace', '--no-skills', '--disable-commands',
    '--prompt', options.prompt ?? 'Hello', ...(options.flags ?? [])]
  const before = { interrupt: process.listenerCount('SIGINT'), terminate: process.listenerCount('SIGTERM') }
  const status = await main(args, options.env ?? f.env, {
    launchDirectory: f.root,
    providerFactory: () => options.provider ?? { generate: async () => reply() },
    catalog: { list: async () => ({ models: [], state: 'fresh' }) },
    ...(options.dependencies ?? {}),
    automation: { stdout: stdout.stream, stderr: stderr.stream, ...(options.automation ?? {}) }
  })
  assert.equal(process.listenerCount('SIGINT'), before.interrupt, 'Run removes its SIGINT listener')
  assert.equal(process.listenerCount('SIGTERM'), before.terminate, 'Run removes its SIGTERM listener')
  return { status, rows: events(stdout.text(), status), stdout: stdout.text(), stderr: stderr.text() }
}

test('JSONL one-turn success has a pure ordered envelope, accepted text and reported usage', async t => {
  const f = await fixture(t)
  let tools, sent
  const result = await run(f, { flags: ['--no-tools'], provider: { async generate(input, _signal, options) {
    tools = input.tools; sent = input.messages.at(-1).content
    await options.onProgress?.({ type: 'text_delta', text: 'PROVISIONAL_NOT_ACCEPTED' })
    return { ...reply('Accepted final'), providerState: { provider: 'fixture', items: [{ opaque: 'PRIVATE_PROVIDER_STATE' }] } }
  } } })
  assert.equal(result.status, 0); assert.deepEqual(tools, []); assert.equal(sent, 'Hello')
  assert.equal(result.rows.at(-1).final_text, 'Accepted final')
  assert.deepEqual(result.rows.at(-1).usage, { reported, complete: true })
  assert.equal(result.rows.at(-1).rounds, 1)
  assert.equal(result.rows.find(row => row.type === 'assistant.completed').text, 'Accepted final')
  assert(!result.stdout.includes('PROVISIONAL_NOT_ACCEPTED')); assert(!result.stdout.includes('PRIVATE_PROVIDER_STATE'))
  assert(!result.stdout.includes('offline-automation-key')); assert(!result.stdout.includes(f.root))
  const saved = await new FileSessionStore(f.directory).load(result.rows.at(-1).session_id)
  assert.equal(saved.history.at(-1).content, 'Accepted final')
  assert(!(await readdir(f.directory)).some(name => name.endsWith('.lock')), 'Terminal success follows writer lease release')
})

test('JSONL resume explicitly uses the saved session while emitting only the new turn', async t => {
  const f = await fixture(t)
  const first = await run(f, { provider: { generate: async () => reply('Prior answer') } })
  const id = first.rows.at(-1).session_id
  let messages
  const second = await run(f, { args: ['--jsonl', '--resume', id, '--no-workspace', '--no-skills', '--disable-commands', '--prompt', 'Continue'],
    provider: { async generate(input) { messages = input.messages; return reply('Current answer') } } })
  assert.equal(second.status, 0); assert.equal(second.rows.at(-1).session_id, id)
  assert(messages.some(message => message.content === 'Prior answer'))
  assert(!second.stdout.includes('Prior answer')); assert.equal(second.rows.at(-1).final_text, 'Current answer')
  assert.notEqual(first.rows[0].run_id, second.rows[0].run_id)
})

for (const prompt of ['/mcp list', '/web disabled', '/context', '/compact', '/reviewer none', '/processes stop-all', '!echo never-execute']) {
  test(`JSONL treats ${JSON.stringify(prompt)} as literal provider input`, async t => {
    const f = await fixture(t); let sent, calls = 0
    const result = await run(f, { prompt, provider: { async generate(input) { sent = input.messages.at(-1).content; calls++; return reply() } } })
    assert.equal(result.status, 0); assert.equal(calls, 1); assert.equal(sent, prompt)
    assert.equal(result.rows.at(-1).type, 'run.completed')
  })
}

test('JSONL accepted tool lifecycle omits tool arguments, results and images', async t => {
  const f = await fixture(t); let rounds = 0
  const result = await run(f, { flags: ['--tools'], provider: { async generate(input) {
    rounds++
    if (rounds === 1) return reply('', [call('calculator-1', 'calculate', { expression: '271828 + 1' })])
    assert(input.messages.some(message => message.kind === 'tool_result' && message.content.includes('271829')))
    return reply('Computed')
  } } })
  assert.equal(result.status, 0)
  const start = result.rows.find(row => row.type === 'tool.started'), end = result.rows.find(row => row.type === 'tool.completed')
  assert.equal(start.call_id, 'calculator-1'); assert.equal(end.call_id, start.call_id); assert.equal(end.is_error, false)
  assert(!result.stdout.includes('271828')); assert(!result.stdout.includes('271829'))
  assert(!Object.hasOwn(start, 'arguments')); assert(!Object.hasOwn(end, 'content')); assert(!Object.hasOwn(end, 'images'))
  assert.deepEqual(result.rows.at(-1).usage, { reported: { inputTokens: 8, outputTokens: 4, totalTokens: 12 }, complete: true })
})

test('JSONL actual approval request is denied without stdin or a mutation and returns interaction-required', async t => {
  const f = await fixture(t); let rounds = 0
  const result = await run(f, { flags: ['--tools'], provider: { async generate(input) {
    if (++rounds === 1) return reply('', [call('note-1', 'note_set', { key: 'task', value: 'private proposed note', expectedRevision: 0 })])
    assert(input.messages.some(message => message.kind === 'tool_result' && message.content.includes('approval_denied')))
    return reply('I could not save that note')
  } } })
  assert.equal(result.status, 4); assert.equal(result.rows.at(-1).code, 'interaction_required')
  assert.equal(result.rows.filter(row => row.type === 'approval.denied').length, 1)
  assert(!result.stdout.includes('private proposed note'))
  const saved = await new FileSessionStore(f.directory).load(result.rows.at(-1).session_id)
  assert.deepEqual(saved.notes, {}); assert.equal(saved.noteRevision, 0)
})

test('JSONL missing round usage remains explicitly incomplete rather than asserted zero billing', async t => {
  const f = await fixture(t)
  const missing = await run(f, { provider: { generate: async () => ({ content: 'No counters', toolCalls: [] }) } })
  assert.equal(missing.status, 0)
  assert.equal(missing.rows.find(row => row.type === 'round.completed').usage, null)
  assert.deepEqual(missing.rows.at(-1).usage, { reported: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, complete: false })
})

for (const flags of [[], ['--prompt', 'Hello', '--tui'], ['--prompt', 'Hello', '--approval-mode', 'auto'],
  ['--prompt', 'Hello', '--approval-mode', 'skip'], ['--prompt', 'Hello', '--help'], ['--diagnose-input'], ['--prompt', 'Hello', '--unknown']]) {
  test(`JSONL rejects invalid arguments before provider or session side effects: ${JSON.stringify(flags)}`, async t => {
    const f = await fixture(t); let constructed = 0
    const result = await run(f, { args: ['--jsonl', '--model', 'offline-model', ...flags], dependencies: { providerFactory() { constructed++; throw new Error('must not run') } } })
    assert.equal(result.status, 2); assert.equal(result.rows.at(-1).code, 'invalid_configuration'); assert.equal(constructed, 0)
    assert.deepEqual(await readdir(f.root), [])
  })
}

test('JSONL startup failure emits generic failure with no stack or thrown provider detail', async t => {
  const f = await fixture(t)
  const result = await run(f, { dependencies: { providerFactory() { throw new Error('RAW_FAILURE_DETAIL offline-automation-key') } } })
  assert.equal(result.status, 1); assert.equal(result.rows.at(-1).type, 'run.failed')
  assert(!result.stdout.includes('RAW_FAILURE_DETAIL')); assert(!result.stdout.includes('offline-automation-key'))
  assert(!result.stderr.includes('offline-automation-key'))
})

test('JSONL provider failure uses a machine code and never publishes provider error detail', async t => {
  const f = await fixture(t)
  const result = await run(f, { provider: { async generate() { throw new Error('DO_NOT_SERIALIZE_PROVIDER_PAYLOAD') } } })
  assert.equal(result.status, 1); assert.equal(result.rows.at(-1).code, 'provider_error')
  assert(!result.stdout.includes('DO_NOT_SERIALIZE_PROVIDER_PAYLOAD'))
})

test('JSONL cancellation before setup emits cancelled without constructing provider or a session', async t => {
  const f = await fixture(t), controller = new AbortController(); controller.abort()
  let constructed = 0
  const result = await run(f, { automation: { signal: controller.signal }, dependencies: { providerFactory() { constructed++; throw new Error('must not run') } } })
  assert.equal(result.status, 130); assert.equal(result.rows.at(-1).type, 'run.cancelled')
  assert.equal(constructed, 0); assert.deepEqual(await readdir(f.root), [])
})

test('JSONL cancellation during inference drains owned work and keeps one terminal cancellation', async t => {
  const f = await fixture(t), controller = new AbortController(); let observedAbort = false
  const result = await run(f, { automation: { signal: controller.signal }, provider: { async generate(_input, signal) {
    const settled = new Promise((_, reject) => signal.addEventListener('abort', () => { observedAbort = true; reject(new DOMException('Cancelled fixture', 'AbortError')) }, { once: true }))
    controller.abort(); return settled
  } } })
  assert.equal(result.status, 130); assert(observedAbort); assert.equal(result.rows.at(-1).reason, 'SIGINT')
  assert(!result.rows.some(row => row.type === 'run.completed'))
  assert(!(await readdir(f.directory)).some(name => name.endsWith('.lock')))
})

test('JSONL a genuine cleanup failure overrides an otherwise successful result', async t => {
  const f = await fixture(t), shutdown = CliHost.prototype.shutdown
  t.mock.method(CliHost.prototype, 'shutdown', async function () { await shutdown.call(this); throw new Error('offline cleanup failure') })
  const result = await run(f)
  assert.equal(result.status, 1); assert.equal(result.rows.at(-1).code, 'cleanup_failed')
  assert(!result.rows.some(row => row.type === 'run.completed'))
  assert((await readdir(f.directory)).some(name => name.endsWith('.lock')), 'Unconfirmed ownership retains lock')
})

test('JSONL redacts known secrets from accepted text without exposing provisional split deltas', async t => {
  const f = await fixture(t)
  const result = await run(f, { provider: { async generate(_input, _signal, options) {
    await options.onProgress?.({ type: 'text_delta', text: 'offline-' })
    await options.onProgress?.({ type: 'text_delta', text: 'automation-key' })
    return reply('Answer: offline-automation-key')
  } } })
  assert.equal(result.status, 0); assert(!result.stdout.includes('offline-automation-key'))
  assert.equal(result.rows.at(-1).final_text, 'Answer: [REDACTED]')
})

test('JSONL valid final schema output is parsed exactly and intermediate assistant text is withheld', async t => {
  const f = await fixture(t), schema = join(f.root, 'result-schema.json')
  await writeFile(schema, JSON.stringify({ type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false }))
  let sent
  const result = await run(f, { flags: ['--output-schema', schema], provider: { async generate(input) { sent = input.messages; return reply('{"result":"ok"}') } } })
  assert.equal(result.status, 0); assert.deepEqual(result.rows.at(-1).structured_output, { result: 'ok' })
  assert.equal(result.rows.at(-1).final_text, '{"result":"ok"}')
  assert(!Object.hasOwn(result.rows.find(row => row.type === 'assistant.completed'), 'text'))
  assert(sent.some(message => message.kind === 'message' && message.role === 'system' && message.content.includes('additionalProperties')))
  const saved = await new FileSessionStore(f.directory).load(result.rows.at(-1).session_id)
  assert(!saved.history.some(message => message.kind === 'message' && message.role === 'system' && message.content.includes('additionalProperties')))
})

for (const [content, code] of [['not JSON', 'invalid_json'], ['{"result":3}', 'schema_mismatch']]) {
  test(`JSONL final schema failure ${code} withholds invalid answer`, async t => {
    const f = await fixture(t), schema = join(f.root, 'result-schema.json')
    await writeFile(schema, JSON.stringify({ type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false }))
    const result = await run(f, { flags: ['--output-schema', schema], provider: { generate: async () => reply(content) } })
    assert.equal(result.status, 3); assert.equal(result.rows.at(-1).code, code)
    assert(!Object.hasOwn(result.rows.at(-1), 'final_text')); assert(!Object.hasOwn(result.rows.at(-1), 'structured_output'))
    assert(result.rows.filter(row => row.type === 'assistant.completed').every(row => !Object.hasOwn(row, 'text')))
  })
}

test('JSONL rejects an unsupported schema before provider/session side effects', async t => {
  const f = await fixture(t), schema = join(f.root, 'result-schema.json'); let constructed = 0
  await writeFile(schema, JSON.stringify({ type: 'string', pattern: 'unsupported' }))
  const result = await run(f, { flags: ['--output-schema', schema], dependencies: { providerFactory() { constructed++; throw new Error('must not run') } } })
  assert.equal(result.status, 2); assert.equal(constructed, 0)
  assert.deepEqual(await readdir(f.root), ['result-schema.json'])
})

test('JSONL final schema output rejects an escaped known secret rather than succeeding after redaction', async t => {
  const f = await fixture(t), schema = join(f.root, 'result-schema.json')
  await writeFile(schema, JSON.stringify({ type: 'object', properties: { result: { type: 'string' } }, required: ['result'], additionalProperties: false }))
  const result = await run(f, { flags: ['--output-schema', schema], provider: { generate: async () => reply('{"result":"offline-automation-\\u006bey"}') } })
  assert.equal(result.status, 3); assert.equal(result.rows.at(-1).code, 'output_redacted')
  assert(!result.stdout.includes('offline-automation')); assert(!Object.hasOwn(result.rows.at(-1), 'structured_output'))
})

test('Plain one-shot compatibility retains slash-command behavior outside JSONL', async t => {
  const f = await fixture(t); let calls = 0, output = ''
  const io = { write(text) { output += text }, event() {}, result() {}, async readLine() {}, async approve() { return false }, onCancel() { return () => {} }, close() {} }
  const status = await main(['--model', 'offline-model', '--no-workspace', '--no-skills', '--disable-commands', '--prompt', '/context'], f.env,
    { io, launchDirectory: f.root, providerFactory: () => ({ async generate() { calls++; return reply() } }) })
  assert.equal(status, 0); assert.equal(calls, 0); assert(!output.includes('"protocol":"vivi.automation"'))
})


test('JSONL MCP cleanup failure overrides success after the provider turn completes', async t => {
  const f = await fixture(t); let closes = 0
  const result = await run(f, { dependencies: { mcpManagerFactory(options) {
    const manager = new McpManager(options), close = manager.close.bind(manager)
    manager.close = async () => { closes++; await close(); throw new Error('offline MCP cleanup failure') }
    return manager
  } } })
  assert.equal(closes, 1); assert.equal(result.status, 1)
  assert.equal(result.rows.at(-1).code, 'cleanup_failed')
  assert(!result.rows.some(row => row.type === 'run.completed'))
})

test('JSONL cancellation during catalog startup exits130 without dispatching a provider', async t => {
  const f = await fixture(t), controller = new AbortController(); let constructed = 0
  const result = await run(f, { args: ['--jsonl', '--provider', 'openrouter', '--model', 'offline-model', '--no-workspace', '--no-skills', '--prompt', 'Hello'],
    env: { ...f.env, OPENROUTER_API_KEY: 'offline-router-key' }, automation: { signal: controller.signal }, dependencies: {
      providerFactory() { constructed++; throw new Error('must not run') },
      catalog: { async list(_provider, _key, signal) {
        controller.abort(); assert(signal.aborted)
        throw new DOMException('Cancelled catalogue fixture', 'AbortError')
      } }
    } })
  assert.equal(constructed, 0); assert.equal(result.status, 130); assert.equal(result.rows.at(-1).type, 'run.cancelled')
  assert(!(await readdir(f.directory)).some(name => name.endsWith('.lock')))
})

test('JSONL first termination signal wins over a later cancellation request', async t => {
  const f = await fixture(t), controller = new AbortController()
  const result = await run(f, { automation: { signal: controller.signal }, provider: { async generate(_input, signal) {
    const settled = new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Terminated fixture', 'AbortError')), { once: true }))
    process.emit('SIGTERM'); controller.abort(); return settled
  } } })
  assert.equal(result.status, 143); assert.equal(result.rows.at(-1).reason, 'SIGTERM')
})

test('JSONL provider round exhaustion never emits terminal success', async t => {
  const f = await fixture(t)
  const result = await run(f, { flags: ['--tools', '--max-rounds', '1'], provider: { generate: async () => reply('', [call('calculator-limit', 'calculate', { expression: '1+1' })]) } })
  assert.equal(result.status, 1); assert.equal(result.rows.at(-1).code, 'max_rounds')
  assert(!result.rows.some(row => row.type === 'run.completed'))
})


test('JSONL genuine cleanup failure takes precedence over a requested cancellation', async t => {
  const f = await fixture(t), controller = new AbortController()
  const result = await run(f, { automation: { signal: controller.signal }, dependencies: { mcpManagerFactory(options) {
    const manager = new McpManager(options), close = manager.close.bind(manager)
    manager.close = async () => { await close(); throw new Error('offline MCP cleanup failure after cancel') }
    return manager
  } }, provider: { async generate(_input, signal) {
    const settled = new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('Cancelled fixture', 'AbortError')), { once: true }))
    controller.abort(); return settled
  } } })
  assert.equal(result.status, 1); assert.equal(result.rows.at(-1).code, 'cleanup_failed')
  assert(!result.rows.some(row => row.type === 'run.cancelled'))
})
