// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { CliHost } from '../dist/host.js'
import { FileMemoryStore } from '../dist/memory.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { main, parseArguments } from '../dist/main.js'
import { TerminalIO, runChatLoop, runMemoryCommand, reviewMemoryChange } from '../dist/terminal.js'

const answer = () => ({ content: 'Done', toolCalls: [] })
function fakeIO(lines = [], approvals = []) {
  return { output: '', requests: [], results: [], async readLine() { return lines.shift() },
    write(text) { this.output += text }, event() {}, result(value) { this.results.push(value) },
    async approve(request) { this.requests.push(request); return approvals.shift() ?? false },
    onCancel(callback) { this.cancel = callback; return () => { this.cancel = undefined } }, close() {} }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-memory-controls-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}
async function hostFor(directory, io, enableMemory = true) {
  return new CliHost({ store: new FileSessionStore(directory),
    session: newSession({ provider: 'openai', model: 'fake-model' }),
    provider: { generate: async () => answer() }, memory: new FileMemoryStore(directory),
    enableMemory, enableTools: false, approve: (request, signal) => io.approve(request, signal) })
}
async function seed(directory, content = 'I prefer concise replies') {
  await writeFile(join(directory, 'memories.json'), JSON.stringify({ version: 1, memories: [{
    id: 'known-memory', content, createdAt: '2026-10-01', updatedAt: '2026-10-01', createdBy: 'user', updatedBy: 'user'
  }] }), { mode: 0o600 })
}

test('launch memory flags default off, accept chat-only use, and use the final explicit override', () => {
  assert.equal(parseArguments(['--model', 'fake-model'], {}).enableMemory, false)
  assert.equal(parseArguments(['--model', 'fake-model', '--enable-memory', '--no-tools'], {}).enableMemory, true)
  assert.equal(parseArguments(['--model', 'fake-model', '--enable-memory', '--disable-memory'], {}).enableMemory, false)
  assert.equal(parseArguments(['--model', 'fake-model', '--disable-memory', '--enable-memory'], {}).enableMemory, true)
})

test('a committed change with newly detected credentials is reported accurately without displaying its withheld projection', async () => {
  const io = fakeIO()
  await reviewMemoryChange({ changeMemory: async () => ({ contentWithheld: true, memories: [], limits: {
    maximumMemories: 100, maximumMemoryCharacters: 1000, maximumTotalCharacters: 20000
  } }) }, io, { kind: 'create', content: 'Already committed content' })
  assert.match(io.output, /Memory change committed; contents were withheld/)
  assert(!io.output.includes('No saved memories'))
  assert(!io.output.includes('no records changed'))
})

test('line manager reviews every create/edit/delete, preserves IDs and displayed revisions, and handles stale edits', async t => {
  const directory = await fixture(t), io = fakeIO([], [true, false, true, false, true])
  const host = await hostFor(directory, io)
  assert.equal(await runMemoryCommand(host, io, '/not-memories'), false)
  await runMemoryCommand(host, io, '/memories add I prefer concise replies')
  const first = (await host.listMemories()).memories[0]
  assert.equal(first.createdBy, 'user'); assert.equal(first.updatedBy, 'user')
  assert.equal(io.requests[0].currentRevision, 'new memory')
  assert.match(io.requests[0].description, /app-wide.*plaintext/)
  assert.match(io.requests[0].description, /After: "I prefer concise replies"/)
  await runMemoryCommand(host, io, '/memories list')
  assert(io.output.includes(first.id)); assert(io.output.includes(first.revision))
  const edit = `/memories edit ${first.id} ${first.revision} I prefer detailed replies`
  await runMemoryCommand(host, io, edit)
  assert.equal((await host.listMemories()).memories[0].content, first.content)
  await runMemoryCommand(host, io, edit)
  const changed = (await host.listMemories()).memories[0]
  assert.equal(changed.id, first.id); assert.notEqual(changed.revision, first.revision)
  assert.equal(io.requests[2].currentRevision, first.revision)
  assert.match(io.requests[2].description, /Before: "I prefer concise replies"/)
  await assert.rejects(runMemoryCommand(host, io, edit), /[Ss]tale/)
  assert.equal(io.requests.length, 3)
  const deletion = `/memories delete ${changed.id} ${changed.revision}`
  await runMemoryCommand(host, io, deletion)
  assert.equal((await host.listMemories()).memories.length, 1)
  await runMemoryCommand(host, io, deletion)
  assert.equal((await host.listMemories()).memories.length, 0)
  assert.equal(io.requests.length, 5)
  assert.match(io.output, /Memory change denied/)
  assert.match(io.output, /Memory saved/); assert.match(io.output, /Memory updated/); assert.match(io.output, /Memory deleted/)
})

test('disabled memory commands perform no reads; malformed commands never create a proposal', async t => {
  const directory = await fixture(t), io = fakeIO([], [true]), host = await hostFor(directory, io, false)
  await writeFile(join(directory, 'memories.json'), 'unreadable-as-memory', { mode: 0o600 })
  await runMemoryCommand(host, io, '/memories')
  await runMemoryCommand(host, io, '/memories add Should not be stored')
  assert.equal(io.requests.length, 0)
  assert.match(io.output, /Memory is disabled/)
  assert.deepEqual(await readdir(directory), ['memories.json'])
  assert.equal(await readFile(join(directory, 'memories.json'), 'utf8'), 'unreadable-as-memory')
  await seed(directory)
  await runMemoryCommand(host, io, '/memories on')
  for (const command of ['/memories add', '/memories edit known-memory', '/memories delete known-memory abc extra', '/memories other']) {
    assert.equal(await runMemoryCommand(host, io, command), true)
  }
  assert.equal(io.requests.length, 0)
  await runMemoryCommand(host, io, '/memories off')
  assert.equal(host.memoryEnabled, false)
  assert.match(io.output, /existing records retained/)
  assert.equal(JSON.parse(await readFile(join(directory, 'memories.json'), 'utf8')).memories.length, 1)
})

test('piped line memory creation is denied even when allow is queued', async t => {
  const directory = await fixture(t), input = new PassThrough(), output = new PassThrough()
  let displayed = ''; output.on('data', chunk => { displayed += chunk.toString() })
  const io = new TerminalIO({ input, output, stream: false })
  t.after(() => io.close())
  const host = await hostFor(directory, io)
  input.end('/memories add I prefer concise replies\nallow\n/exit\n')
  await runChatLoop(host, io)
  assert.match(displayed, /Approval required \(new memory\)/)
  assert.match(displayed, /Denied: interactive approval is required/)
  assert.match(displayed, /Memory change denied/)
  assert.equal((await host.listMemories()).memories.length, 0)
  assert(!(await readdir(directory)).includes('memories.json'))
})

test('line main omits tools for unknown/no-tools models while memory context remains opt-in and ephemeral', async t => {
  const directory = await fixture(t); await seed(directory)
  for (const [model, flags, expectedTools] of [
    ['future-model', [], false], ['future-model', ['--tools'], true],
    ['future-model', ['--tools', '--no-tools'], false], ['gpt-5.1', [], true], ['gpt-5.1', ['--no-tools'], false]
  ]) {
    const io = fakeIO(), captures = []
    assert.equal(await main(['--model', model, '--session-dir', directory, '--enable-memory', '--prompt', 'Hello', ...flags], {}, {
      io, providerFactory: (_session, options) => {
        assert.equal(options.enableTools, expectedTools)
        return { generate: async input => { captures.push(input); return answer() } }
      }
    }), 0)
    assert.equal(captures.length, 1)
    assert.equal(captures[0].tools.length > 0, expectedTools)
    assert(captures[0].messages.some(message => message.content.includes('I prefer concise replies')))
    assert.deepEqual(io.results[0].history.map(message => message.content), ['Hello', 'Done'])
    assert.match(io.output, /plaintext/)
  }
  const off = fakeIO()
  assert.equal(await main(['--model', 'future-model', '--session-dir', directory, '--prompt', 'Hello'], {}, {
    io: off, providerFactory: () => ({ generate: async input => {
      assert.deepEqual(input.tools, [])
      assert.equal(input.messages.at(-1).content, 'Hello')
      assert(!input.messages.some(message => message.content.includes('I prefer concise replies')))
      assert(input.messages.some(message => message.role === 'user' && message.content.includes('skill-creator')))
      return answer()
    } })
  }), 0)
})
