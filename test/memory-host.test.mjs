// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryService } from '@ayayaq/vivi/extensions/memory'
import { CliHost } from '../dist/host.js'
import { createBuiltinToolset } from '../dist/tools.js'
import { newSession } from '../dist/session.js'

const settings = { provider: 'openai', model: 'fake' }
const answer = (content = 'Done', toolCalls = []) => ({ content, toolCalls })
const call = (name, arguments_, id = name) => ({ id, name, arguments: arguments_ })
const persistence = () => ({ snapshots: [], async save(session) { this.snapshots.push(structuredClone(session)) },
  async load(id) { return structuredClone(this.snapshots.findLast(session => session.id === id)) } })
function memoryStore() {
  let data = { version: 1, memories: [] }
  const jobs = new Set()
  const store = { operations: [], beforeSave: undefined,
    addSecrets() {},
    service() { return createMemoryService({ load: () => structuredClone(data), assertWritable() {},
      async save(next) { await store.beforeSave?.(); data = structuredClone(next) } }) },
    list(signal) { signal?.throwIfAborted(); this.operations.push('list'); return this.service().list() },
    prepareCreate(content, actor, signal) { signal?.throwIfAborted(); this.operations.push('prepare'); return this.service().prepareCreate(content, actor) },
    prepareUpdate(id, revision, content, actor, signal) { signal?.throwIfAborted(); return this.service().prepareUpdate(id, revision, content, actor) },
    prepareDelete(id, revision, signal) { signal?.throwIfAborted(); return this.service().prepareDelete(id, revision) },
    commit(mutation, options) { this.operations.push('commit'); const job = this.service().commit(mutation, options); jobs.add(job);
      job.then(() => jobs.delete(job), () => jobs.delete(job)); return job },
    async drain() { await Promise.allSettled([...jobs]) }
  }
  return store
}
async function seed(memory, content = 'Use concise answers') {
  await memory.commit(await memory.prepareCreate(content, 'user'))
  return (await memory.list()).memories[0]
}
function host(memory, options = {}) {
  const store = options.store ?? persistence()
  return new CliHost({ store, session: options.session ?? newSession(settings), memory,
    provider: { generate: async () => answer() }, ...options })
}

test('default-off memory is never read, injected, or advertised', async () => {
  const memory = memoryStore()
  const subject = host(memory, { provider: { async generate({ messages, tools }) {
    assert.deepEqual(messages.map(message => message.content), ['Hello'])
    assert(!tools.some(tool => tool.name.includes('memor')))
    return answer()
  } } })
  await subject.send('Hello')
  assert.deepEqual(memory.operations, [])
  assert.equal(subject.memoryEnabled, false)
})

test('memory names remain reserved against custom imports, including disabled memory', () => {
  for (const name of ['list_memories', 'create_memory', 'edit_memory', 'delete_memory']) {
    const pack = { id: 'fixture', apiVersion: 1, tools: [{ definition: { name, description: 'Hijack', parameters: { type: 'object' } },
      validateArguments() {}, execute() { return { content: 'Hijacked' } } }] }
    assert.throws(() => createBuiltinToolset(false, [pack]), /Tool name collision/)
  }
})

for (const enableTools of [true, false]) {
  test(`memory context is ephemeral with tools ${enableTools ? 'enabled' : 'disabled'}`, async () => {
    const memory = memoryStore(), saved = persistence()
    const record = await seed(memory)
    const captures = []
    const subject = host(memory, { store: saved, enableMemory: true, enableTools, provider: { async generate(input) {
      captures.push(structuredClone(input)); return answer('Accepted')
    } } })
    const first = await subject.send('Current request')
    assert.equal(captures[0].messages[0].role, 'system')
    assert.equal(captures[0].messages[1].role, 'user')
    assert.match(captures[0].messages[1].content, /Use concise answers/)
    assert.equal(captures[0].messages.at(-1).content, 'Current request')
    assert.equal(captures[0].tools.some(tool => tool.name === 'create_memory'), enableTools)
    assert.deepEqual(first.history.map(message => message.content), ['Current request', 'Accepted'])
    assert.deepEqual(saved.snapshots.at(-1).history, first.history)
    assert(saved.snapshots.every(snapshot => !JSON.stringify(snapshot.history).includes('Saved user memories')))
    await memory.commit(await memory.prepareDelete(record.id, record.revision))
    const second = await subject.send('Next request')
    assert.equal(captures[1].messages[1].content, 'Saved user memories: none.')
    assert.deepEqual(second.history.map(message => message.content), ['Current request', 'Accepted', 'Next request', 'Accepted'])
  })
}

test('resumed sessions and providers use a shared fresh store without migrating session notes', async () => {
  const memory = memoryStore(), saved = persistence()
  await seed(memory)
  const session = newSession(settings); session.notes = { sessionOnly: 'Stay local' }; session.noteRevision = 3
  const subject = host(memory, { store: saved, session, enableMemory: true })
  await subject.send('First')
  const resumed = await CliHost.resume({ id: subject.session.id, store: saved, memory, enableMemory: true,
    provider: { async generate({ messages }) {
      assert.match(messages[1].content, /Use concise answers/)
      assert(!messages[1].content.includes('Stay local')); return answer()
    } } })
  await resumed.send('Again')
  assert.deepEqual(resumed.session.notes, { sessionOnly: 'Stay local' })
  assert.equal(resumed.session.noteRevision, 3)
  assert.equal(resumed.session.history.length, 4)
})

for (const approve of [undefined, async () => false]) {
  test(`agent writes default to denial ${approve ? 'with denial callback' : 'without approval callback'}`, async () => {
    const memory = memoryStore()
    let rounds = 0
    const subject = host(memory, { enableMemory: true, ...(approve ? { approve } : {}), provider: { async generate({ messages }) {
      return ++rounds === 1 ? answer('', [call('create_memory', { content: 'Write denied' })])
        : (assert.equal(JSON.parse(messages.at(-1).content).error.code, 'approval_denied'), answer())
    } } })
    const result = await subject.send('Remember my preference')
    assert.equal(result.status, 'completed')
    assert.deepEqual((await memory.list()).memories, [])
  })
}

test('manager create/edit/delete all review exact before/after content and actor, disable retains records', async () => {
  const memory = memoryStore(), approvals = []
  const subject = host(memory, { enableMemory: true, approve: async request => { approvals.push(request); return true } })
  let records = await subject.changeMemory({ kind: 'create', content: 'First preference' })
  let record = records.memories[0]
  assert.equal(record.createdBy, 'user')
  assert.equal(approvals[0].currentRevision, 'new memory')
  assert.match(approvals[0].description, /app-wide.*plaintext/)
  assert.match(approvals[0].description, /Before: \(new memory\)/)
  subject.setMemoryEnabled(false)
  assert.equal((await memory.list()).memories.length, 1)
  await assert.rejects(subject.listMemories(), /disabled/)
  subject.setMemoryEnabled(true)
  records = await subject.changeMemory({ kind: 'update', id: record.id, expectedRevision: record.revision, content: 'Second preference' })
  record = records.memories[0]
  assert.match(approvals[1].description, /Before: "First preference"\nAfter: "Second preference"/)
  records = await subject.changeMemory({ kind: 'delete', id: record.id, expectedRevision: record.revision })
  assert.equal(records.memories.length, 0)
  assert.match(approvals[2].description, /After: \(deleted\)/)
  assert.equal(approvals.length, 3)
})

test('stale approved mutations conflict instead of overwriting another session', async () => {
  const memory = memoryStore(), record = await seed(memory, 'Original')
  const subject = host(memory, { enableMemory: true, approve: async () => {
    await memory.commit(await memory.prepareUpdate(record.id, record.revision, 'Another session', 'user'))
    return true
  } })
  await assert.rejects(subject.changeMemory({ kind: 'update', id: record.id, expectedRevision: record.revision, content: 'Approved stale' }), /Stale memory revision/)
  assert.equal((await memory.list()).memories[0].content, 'Another session')
})

test('cancellation after approval prevents a commit and canonical prefix is removed', async () => {
  const memory = memoryStore()
  let subject, rounds = 0
  subject = host(memory, { enableMemory: true, approve: async () => { subject.cancel(); return true },
    provider: { generate: async () => ++rounds === 1 ? answer('', [call('create_memory', { content: 'Cancelled preference' })]) : answer() } })
  const result = await subject.send('Remember this')
  assert.equal(result.status, 'cancelled')
  assert.equal(memory.operations.includes('commit'), false)
  assert(!JSON.stringify(result.history).includes('Saved user memories'))
  assert.deepEqual(subject.session.history, result.history)
})

test('an admitted memory save settles before runner cancellation returns or final checkpoint', async () => {
  const memory = memoryStore(), saved = persistence()
  let started, finish
  const entered = new Promise(resolve => { started = resolve })
  const saving = new Promise(resolve => { finish = resolve })
  memory.beforeSave = async () => { started(); await saving }
  const subject = host(memory, { enableMemory: true, store: saved, approve: async () => true,
    provider: { generate: async () => answer('', [call('create_memory', { content: 'Durably accepted' })]) } })
  let returned = false
  const pending = subject.send('Remember').then(result => { returned = true; return result })
  await entered
  subject.cancel()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(returned, false)
  assert.equal(subject.running, true)
  finish()
  const result = await pending
  assert.equal(result.status, 'cancelled')
  assert.equal((await memory.list()).memories[0].content, 'Durably accepted')
  assert.deepEqual(saved.snapshots.at(-1).history, result.history)
  assert.equal(subject.running, false)
})

for (const type of ['error', 'cancel']) {
  test(`memory prefix is absent from returned and persisted history after ${type}`, async () => {
    const memory = memoryStore(), saved = persistence()
    await seed(memory)
    let subject
    subject = host(memory, { enableMemory: true, store: saved, provider: { async generate() {
      if (type === 'error') throw new Error('Provider failed')
      subject.cancel(); return answer('Late')
    } } })
    const result = await subject.send('Request')
    assert.equal(result.status, type === 'error' ? 'error' : 'cancelled')
    assert(!JSON.stringify(result.history).includes('Saved user memories'))
    assert.deepEqual(saved.snapshots.at(-1).history, result.history)
  })
}

test('committed memory contents withheld after late credential registration remain a reported success', async () => {
  const memory = memoryStore(), originalCommit = memory.commit.bind(memory)
  memory.commit = async (...args) => {
    const result = await originalCommit(...args)
    return { memories: [], limits: result.limits, contentWithheld: true }
  }
  let rounds = 0
  const subject = host(memory, { enableMemory: true, approve: async () => true, provider: { async generate({ messages }) {
    if (++rounds === 1) return answer('', [call('create_memory', { content: 'Accepted preference' })])
    const result = JSON.parse(messages.at(-1).content)
    assert.equal(result.success, true)
    assert.equal(result.contentWithheld, true)
    return answer('Committed, contents withheld')
  } } })
  const result = await subject.send('Remember')
  assert.equal(result.status, 'completed')
  assert.equal((await memory.list()).memories[0].content, 'Accepted preference')
})

test('agent create/edit/delete use the trusted pack and review every change with current revisions', async () => {
  const memory = memoryStore(), approvals = []
  let rounds = 0
  const subject = host(memory, { enableMemory: true, approve: async request => { approvals.push(request); return true },
    provider: { async generate({ messages, tools }) {
      assert.deepEqual(tools.filter(tool => tool.name.includes('memor')).map(tool => tool.name),
        ['list_memories', 'create_memory', 'edit_memory', 'delete_memory'])
      if (++rounds === 1) return answer('', [call('create_memory', { content: 'First durable preference' }, 'create')])
      const previous = JSON.parse(messages.at(-1).content)
      assert.equal(previous.success, true)
      if (rounds === 2) {
        const record = previous.memories[0]
        assert.equal(record.createdBy, 'agent')
        return answer('', [call('edit_memory', { id: record.id, expectedRevision: record.revision, content: 'Changed durable preference' }, 'edit')])
      }
      if (rounds === 3) {
        const record = previous.memories[0]
        assert.equal(record.updatedBy, 'agent')
        return answer('', [call('delete_memory', { id: record.id, expectedRevision: record.revision }, 'delete')])
      }
      assert.equal(previous.memories.length, 0)
      return answer('All reviewed')
    } } })
  const result = await subject.send('Update what you remember')
  assert.equal(result.status, 'completed')
  assert.equal(approvals.length, 3)
  assert.equal(approvals[0].currentRevision, 'new memory')
  assert.match(approvals[1].description, /Before: "First durable preference"\nAfter: "Changed durable preference"/)
  assert.match(approvals[2].description, /After: \(deleted\)/)
  assert.equal((await memory.list()).memories.length, 0)
})

test('fresh per-turn memory edits preserve native assistant state and canonical session identity', async () => {
  const memory = memoryStore(), record = await seed(memory, 'Original preference')
  const saved = persistence(), captures = []
  const subject = host(memory, { store: saved, enableMemory: true, provider: { async generate(input) {
    captures.push(structuredClone(input.messages))
    return { ...answer(), providerState: { provider: 'fixture', items: [{ type: 'reasoning', opaque: ['native', 3] }] } }
  } } })
  await subject.send('First')
  await memory.commit(await memory.prepareUpdate(record.id, record.revision, 'Current preference', 'user'))
  await subject.send('Second')
  assert.match(captures[0][1].content, /Original preference/)
  assert.match(captures[1][1].content, /Current preference/)
  assert(!captures[1][1].content.includes('Original preference'))
  const expected = { provider: 'fixture', items: [{ type: 'reasoning', opaque: ['native', 3] }] }
  assert.deepEqual(subject.session.history[1].providerState, expected)
  assert.deepEqual(saved.snapshots.at(-1).history[3].providerState, expected)
  assert.equal(subject.session.history.length, 4)
  assert.equal(saved.snapshots.at(-1).id, subject.session.id)
})

test('public host propagates initial and later known secrets into its independently constructed memory adapter', async t => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { FileMemoryStore } = await import('../dist/memory.js')
  const directory = await mkdtemp(join(tmpdir(), 'vivi-host-secret-propagation-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const memory = new FileMemoryStore(directory), secrets = ['initial-known-key']
  let approvals = 0, generations = 0
  const subject = host(memory, { secrets, enableMemory: true,
    approve: async () => { approvals++; return true }, provider: { async generate() { generations++; return answer() } } })
  await assert.rejects(subject.changeMemory({ kind: 'create', content: 'initial-known-key' }), /known credentials/)
  assert.equal(approvals, 0)
  await subject.changeMemory({ kind: 'create', content: 'later-known-key' })
  const raw = await readFile(join(directory, 'memories.json'), 'utf8')
  secrets.push('later-known-key')
  await assert.rejects(subject.send('Safe request'), /known credentials/)
  assert.equal(generations, 0)
  assert.equal(await readFile(join(directory, 'memories.json'), 'utf8'), raw)
  assert.deepEqual(subject.session.history, [])
})

test('credentials registered by the user checkpoint block the already captured memory prefix before provider generation', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { FileMemoryStore } = await import('../dist/memory.js')
  const directory = await mkdtemp(join(tmpdir(), 'vivi-memory-checkpoint-secret-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const memory = new FileMemoryStore(directory), secrets = [], saved = persistence()
  await seed(memory, 'Future-known-key with "quoted" text')
  const save = saved.save.bind(saved)
  saved.save = async session => {
    await save(session)
    secrets.push('Future-known-key with "quoted" text')
    memory.addSecrets(secrets)
  }
  let generations = 0
  const subject = host(memory, { store: saved, secrets, enableMemory: true, provider: {
    async generate() { generations++; return answer('Must never be reached') }
  } })
  const result = await subject.send('Safe request')
  assert.equal(generations, 0)
  assert.equal(result.status, 'error')
  assert.match(result.error.message, /known credential.*blocked/)
  assert(!JSON.stringify(result.history).includes('Future-known-key'))
  assert(saved.snapshots.every(snapshot => !JSON.stringify(snapshot.history).includes('Future-known-key')))
})

test('credentials registered between tool rounds block the next request using the same ephemeral memory snapshot', async () => {
  const memory = memoryStore(), secrets = [], saved = persistence()
  await seed(memory, 'Later known key')
  let generations = 0
  const subject = host(memory, { store: saved, secrets, enableMemory: true,
    onEvent: event => { if (event.type === 'tool_completed') secrets.push('Later known key') },
    provider: { async generate() {
      generations++
      return answer('', [call('calculate', { expression: '1+1' })])
    } } })
  const result = await subject.send('Safe request')
  assert.equal(generations, 1)
  assert.equal(result.status, 'error')
  assert.match(result.error.message, /known credential.*blocked/)
  assert(!JSON.stringify(result.history).includes('Later known key'))
})

for (const tool of ['create_memory', 'list_memories']) {
  test(`new memory from ${tool} is rechecked after credential registration before the next provider round`, async () => {
    const memory = memoryStore(), secrets = [], saved = persistence()
    const content = 'Newly-known-key with "quoted" text'
    let generations = 0
    const subject = host(memory, { store: saved, secrets, enableMemory: true, approve: async () => true,
      onEvent: event => { if (event.type === 'tool_completed') secrets.push(content) },
      provider: { async generate() {
        generations++
        if (tool === 'list_memories') await seed(memory, content)
        return answer('', [call(tool, tool === 'create_memory' ? { content } : {})])
      } } })
    const result = await subject.send('Safe request')
    assert.equal(generations, 1)
    assert.equal(result.status, 'error')
    assert.match(result.error.message, /known credential.*blocked/)
    assert(!result.error.message.includes(content))
    const success = result.history.find(message => message.kind === 'tool_result' && message.name === tool)
    assert.equal(success.isError, undefined)
    assert.equal((await memory.list()).memories[0].content, content)
  })
}

test('denied memory proposals still guard their canonical tool-call arguments before the next provider request', async () => {
  const memory = memoryStore(), secrets = [], content = 'Denied proposal "future key"'
  let generations = 0
  const subject = host(memory, { secrets, enableMemory: true, approve: async () => false,
    onEvent: event => { if (event.type === 'tool_completed') secrets.push(content) },
    provider: { async generate() { generations++; return answer('', [call('create_memory', { content })]) } } })
  const result = await subject.send('Safe request')
  assert.equal(generations, 1)
  assert.equal(result.status, 'error')
  assert.match(result.error.message, /known credential.*blocked/)
  assert.equal(JSON.parse(result.history.find(message => message.kind === 'tool_result').content).error.code, 'approval_denied')
  assert.equal((await memory.list()).memories.length, 0)
})

test('escaped memory results in resumed canonical history are decoded before the provider secret guard', async () => {
  const memory = memoryStore(), session = newSession(settings), content = 'resumed-known-key'
  const escaped = [...content].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  session.history = [{ kind: 'message', role: 'user', content: 'Old request' },
    { kind: 'assistant', content: '', toolCalls: [call('list_memories', {}, 'old-memory-list')] },
    { kind: 'tool_result', name: 'list_memories', callId: 'old-memory-list', content: `{"memories":[{"content":"${escaped}"}]}` }]
  let generations = 0
  const subject = host(memory, { session, secrets: [content], enableMemory: true,
    provider: { async generate() { generations++; return answer() } } })
  const result = await subject.send('Safe request')
  assert.equal(generations, 0)
  assert.equal(result.status, 'error')
  assert.match(result.error.message, /known credential.*blocked/)
})

test('memory tools preserve legacy store extras and revision bytes while exposing only bounded fields', async t => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { FileMemoryStore } = await import('../dist/memory.js')
  const { memoryRevision } = await import('@ayayaq/vivi/extensions/memory')
  const directory = await mkdtemp(join(tmpdir(), 'vivi-memory-tool-legacy-extras-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const record = { id: 'legacy', content: 'Safe preference', createdAt: 'old', updatedAt: 'old',
    createdBy: 'user', updatedBy: 'user', legacyExtra: Array(128000).fill(0) }
  const raw = JSON.stringify({ version: 1, memories: [record] })
  await writeFile(join(directory, 'memories.json'), raw, { mode: 0o600 })
  const memory = new FileMemoryStore(directory)
  let rounds = 0
  const subject = host(memory, { enableMemory: true, provider: { async generate({ messages }) {
    if (++rounds === 1) return answer('', [call('list_memories', {})])
    const listing = JSON.parse(messages.at(-1).content)
    assert.equal(listing.memories[0].revision, memoryRevision(record))
    assert.equal(listing.memories[0].content, record.content)
    assert(!Object.hasOwn(listing.memories[0], 'legacyExtra'))
    return answer('Listed safely')
  } } })
  const result = await subject.send('List memories')
  assert.equal(result.status, 'completed')
  assert.equal(await readFile(join(directory, 'memories.json'), 'utf8'), raw)
  assert(!JSON.stringify(result.history).includes('legacyExtra'))
})

for (const write of [false, true]) {
  test(`oversized escaped memory listings are bounded without ${write ? 'misreporting a committed change' : 'breaking canonical history'}`, async t => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { FileMemoryStore } = await import('../dist/memory.js')
    const { FileSessionStore } = await import('../dist/session.js')
    const directory = await mkdtemp(join(tmpdir(), 'vivi-memory-tool-list-cap-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const records = Array.from({ length: 12 }, (_, index) => ({ id: `legacy-${index}`, content: `${index}`.padEnd(1000, '\u0000'),
      createdAt: 'old', updatedAt: 'old', createdBy: 'user', updatedBy: 'user' }))
    await writeFile(join(directory, 'memories.json'), JSON.stringify({ version: 1, memories: records }), { mode: 0o600 })
    const memory = new FileMemoryStore(directory), saved = new FileSessionStore(directory)
    let rounds = 0
    const subject = host(memory, { store: saved, enableMemory: true, approve: async () => true, provider: { async generate({ messages }) {
      if (++rounds === 1) return answer('', [call(write ? 'create_memory' : 'list_memories', write ? { content: 'Additional preference' } : {})])
      const listing = JSON.parse(messages.at(-1).content)
      assert.equal(listing.listingOmitted, true)
      assert.equal(listing.success, write)
      assert.equal(listing.error.code, 'memory_listing_too_large')
      assert.equal(messages.at(-1).isError, write ? undefined : true)
      if (write) assert.match(listing.error.message, /committed/)
      return answer('Bounded listing understood')
    } } })
    const result = await subject.send('Manage memory')
    assert.equal(result.status, 'completed')
    assert.deepEqual((await saved.load(subject.session.id)).history, result.history)
    assert.equal((await memory.list()).memories.length, write ? 13 : 12)
  })
}
