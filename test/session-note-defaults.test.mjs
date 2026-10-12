// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../dist/main.js'
import { FileMemoryStore } from '../dist/memory.js'
import { FileSessionStore, newSession } from '../dist/session.js'

const answer = (toolCalls = []) => ({ content: toolCalls.length ? '' : 'Done', toolCalls })
const noteCall = { id: 'set-note', name: 'note_set', arguments: { key: 'task', value: 'Fixture note', expectedRevision: 0 } }
const noteNames = tools => tools.map(tool => tool.name).filter(name => name === 'note_read' || name === 'note_set')
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-note-defaults-'))
  await chmod(directory, 0o700)
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, store: new FileSessionStore(directory) }
}
function io(approve = async () => false) {
  return { output: '', results: [], closed: false,
    async readLine() {}, write(text) { this.output += text }, event() {},
    result(result) { this.results.push(result) }, approve,
    onCancel() { return () => {} }, close() { this.closed = true }
  }
}
const argsFor = directory => ['--model', 'gpt-4.1', '--session-dir', directory, '--no-workspace', '--no-skills', '--prompt', 'Fixture request']
function forbidMemoryRead(t) {
  t.mock.method(FileMemoryStore.prototype, 'list', async () => assert.fail('Session-note defaults must not read persistent memory'))
}

for (const allowed of [false, true]) {
  test(`default session-note writes require human review before ${allowed ? 'committing' : 'denial'}`, async t => {
    const { directory, store } = await fixture(t)
    forbidMemoryRead(t)
    let sessionId, reviews = 0, rounds = 0
    const terminal = io(async (request, signal) => {
      reviews++
      assert.equal(signal.aborted, false)
      assert.equal(request.call.name, 'note_set')
      assert.equal(request.currentRevision, 0)
      const before = await store.load(sessionId)
      assert.deepEqual(before.notes, {})
      assert.equal(before.noteRevision, 0, 'the proposal must not write before human review')
      return allowed
    })
    assert.equal(await main(argsFor(directory), {}, { io: terminal, providerFactory(session, options) {
      sessionId = session.id
      assert.equal(options.enableNotes, true)
      assert.equal(options.enableTools, true)
      assert.equal(options.enableMemory, false)
      return { async generate(input) {
        rounds++
        assert.deepEqual(noteNames(input.tools), ['note_read', 'note_set'])
        assert(!input.tools.some(tool => tool.name.includes('memor')))
        if (rounds === 1) return answer([noteCall])
        const result = JSON.parse(input.messages.find(message => message.kind === 'tool_result').content)
        if (allowed) assert.deepEqual(result, { success: true, key: 'task', revision: 1 })
        else assert.equal(result.error.code, 'approval_denied')
        return answer()
      } }
    } }), 0)
    assert.equal(reviews, 1)
    assert.equal(rounds, 2)
    assert.equal(terminal.results[0].status, 'completed')
    const saved = await store.load(sessionId)
    assert.deepEqual(saved.notes, allowed ? { task: 'Fixture note' } : {})
    assert.equal(saved.noteRevision, allowed ? 1 : 0)
  })
}

test('launch note/tool opt-outs suppress advertisement and dispatch without opening review', async t => {
  forbidMemoryRead(t)
  for (const flags of [['--disable-notes'], ['--no-tools'], ['--no-tools', '--enable-notes'], ['--enable-notes', '--no-tools']]) {
    const { directory, store } = await fixture(t)
    let sessionId, rounds = 0
    const terminal = io(async () => assert.fail('Disabled notes must not request human review'))
    assert.equal(await main([...argsFor(directory), ...flags], {}, { io: terminal, providerFactory(session, options) {
      sessionId = session.id
      assert.equal(options.enableNotes, false)
      assert.equal(options.enableMemory, false)
      if (flags.includes('--no-tools')) assert.equal(options.enableTools, false)
      return { async generate(input) {
        assert.deepEqual(noteNames(input.tools), [])
        if (flags.includes('--no-tools')) assert.deepEqual(input.tools, [])
        if (++rounds === 1) return answer([noteCall])
        const result = JSON.parse(input.messages.find(message => message.kind === 'tool_result').content)
        assert.equal(result.error.code, 'unavailable_tool')
        return answer()
      } }
    } }), 0)
    assert.deepEqual((await store.load(sessionId)).notes, {})
    assert.equal((await store.load(sessionId)).noteRevision, 0)
  }
})

test('default note intent never grants tool support to an unverified line-mode model', async t => {
  forbidMemoryRead(t)
  for (const declaration of [[], ['--tools']]) {
    const { directory } = await fixture(t)
    const args = ['--model', 'unverified-fixture-model', '--session-dir', directory, '--no-workspace', '--no-skills', '--prompt', 'Fixture request', ...declaration]
    const enabled = declaration.length > 0
    assert.equal(await main(args, {}, { io: io(), providerFactory(_session, options) {
      assert.equal(options.enableTools, enabled)
      assert.equal(options.enableNotes, enabled)
      assert.equal(options.enableMemory, false)
      return { async generate(input) {
        assert.deepEqual(noteNames(input.tools), enabled ? ['note_read', 'note_set'] : [])
        if (!enabled) assert.deepEqual(input.tools, [])
        return answer()
      } }
    } }), 0)
  }
})

test('resumed tool-capable sessions expose their own notes by default without enabling persistent memory', async t => {
  const { directory, store } = await fixture(t)
  forbidMemoryRead(t)
  const session = newSession({ provider: 'openai', model: 'gpt-4.1' })
  session.notes = { task: 'Existing session note' }
  session.noteRevision = 1
  await store.save(session)
  let rounds = 0
  assert.equal(await main(['--resume', session.id, '--session-dir', directory, '--no-workspace', '--no-skills', '--prompt', 'Read notes'], {}, {
    io: io(), providerFactory(resumed, options) {
      assert.equal(resumed.id, session.id)
      assert.equal(options.enableNotes, true)
      assert.equal(options.enableMemory, false)
      return { async generate(input) {
        assert.deepEqual(noteNames(input.tools), ['note_read', 'note_set'])
        if (++rounds === 1) return answer([{ id: 'read-notes', name: 'note_read', arguments: {} }])
        const result = JSON.parse(input.messages.find(message => message.kind === 'tool_result').content)
        assert.deepEqual(result, { revision: 1, notes: { task: 'Existing session note' } })
        return answer()
      } }
    }
  }), 0)
  assert.equal(rounds, 2)
  assert.deepEqual((await store.load(session.id)).notes, session.notes)
})

test('persistent memory context remains available only through separate explicit opt-in', async t => {
  const { directory } = await fixture(t)
  const memory = new FileMemoryStore(directory)
  await memory.commit(await memory.prepareCreate('Persistent fixture context', 'user'))
  await memory.drain()
  for (const flags of [[], ['--enable-memory']]) {
    const optedIn = flags.length > 0
    const terminal = io()
    assert.equal(await main([...argsFor(directory), ...flags], {}, { io: terminal, providerFactory(_session, options) {
      assert.equal(options.enableNotes, true)
      assert.equal(options.enableMemory, optedIn)
      return { async generate(input) {
        assert.deepEqual(noteNames(input.tools), ['note_read', 'note_set'])
        assert.equal(input.tools.some(tool => tool.name === 'list_memories'), optedIn)
        assert.equal(input.messages.some(message => message.content.includes('Persistent fixture context')), optedIn)
        return answer()
      } }
    } }), 0)
  }
})
