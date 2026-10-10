// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runApplication, DEFAULT_PREFERENCES } from '../dist/application.js'
import { CliHost } from '../dist/host.js'
import { FileSessionStore } from '../dist/session.js'
import { PreferenceStore } from '../dist/preferences.js'
import { FileMcpOutcomeStore } from '../dist/mcp-outcomes.js'

function replace(t, object, name, replacement) {
  const original = object[name]
  object[name] = replacement
  t.after(() => { object[name] = original })
  return original
}

async function fixture(t, behavior = {}) {
  const acquired = [], released = [], activeLeases = new Set(), hosts = [], shutdowns = []
  const order = [], displayed = [], messages = [], forbiddenCalls = []
  const lines = ['/new', '/exit'], settings = { ...structuredClone(DEFAULT_PREFERENCES),
    provider: 'openai', model: 'gpt-4.1', enableTools: false, enableNotes: false, enableMemory: false }
  const never = label => () => { forbiddenCalls.push(label); assert.fail(`Unexpected fixture path: ${label}`) }
  let managerCloses = 0, generations = 0, reads = 0, failedOldShutdown = false, failedCandidateShutdown = false
  const io = {
    isClosed: false, canAutoReview: false,
    async readLine() { reads++; return lines.shift() },
    choose: never('dialog'), chooseSearchable: never('model picker'), askText: never('text input'),
    setSession(session) { displayed.push(structuredClone(session)) },
    write(text) {
      messages.push(text)
      if (behavior.throwCleanupReporter && text.includes(behavior.throwCleanupReporter.message)) throw new Error('Cleanup reporter failed')
    }, event: never('turn event'), result: never('model result'),
    approve: never('approval'), onCancel: never('input cancellation'), close: never('native/terminal cleanup')
  }
  // Every store and lease is in memory. No real state, credentials, transport or model requests.
  replace(t, PreferenceStore.prototype, 'load', async () => structuredClone(settings))
  replace(t, PreferenceStore.prototype, 'save', never('preferences mutation'))
  replace(t, FileSessionStore.prototype, 'acquire', async function (id) {
    assert(!activeLeases.has(id), 'Duplicate fixture lease')
    acquired.push(id); activeLeases.add(id); order.push(['acquire', id])
    let didRelease = false
    return async () => {
      assert(!didRelease, 'Fixture lease released twice')
      didRelease = true; released.push(id); order.push(['release', id])
      if (behavior.releaseError && id === acquired[1]) throw behavior.releaseError
      activeLeases.delete(id)
    }
  })
  replace(t, FileSessionStore.prototype, 'save', async () => {})
  replace(t, FileSessionStore.prototype, 'load', never('resume read'))
  replace(t, FileMcpOutcomeStore.prototype, 'load', async () => [])
  replace(t, FileMcpOutcomeStore.prototype, 'save', never('MCP evidence mutation'))
  const initialize = replace(t, CliHost.prototype, 'initialize', async function () {
    hosts.push(this)
    await initialize.call(this)
    const target = behavior.initial ? hosts[0] : hosts[1]
    if (this === target) {
      if (behavior.initializeError) throw behavior.initializeError
      if (behavior.closeDuringInitialize) io.isClosed = true
    }
  })
  const drainMemory = replace(t, CliHost.prototype, 'drainMemory', async function () {
    if (behavior.failDuringOldDrain && this === hosts[0] && shutdowns.includes(this)) throw behavior.failDuringOldDrain
    await drainMemory.call(this)
  })
  const shutdown = replace(t, CliHost.prototype, 'shutdown', async function () {
    shutdowns.push(this); order.push(['shutdown', this.session.id])
    await shutdown.call(this)
    if (behavior.oldShutdownError && this === hosts[0] && (!failedOldShutdown || behavior.oldShutdownAlways)) {
      const error = failedOldShutdown ? behavior.oldRetryError ?? behavior.oldShutdownError : behavior.oldShutdownError
      failedOldShutdown = true; throw error
    }
    if (behavior.closeDuringOldShutdown && this === hosts[0]) io.isClosed = true
    if (behavior.candidateShutdownError && this === hosts[1] && (!behavior.candidateShutdownOnce || !failedCandidateShutdown)) {
      failedCandidateShutdown = true; throw behavior.candidateShutdownError
    }
  })
  const manager = { addSecrets() {}, async close() { managerCloses++ } }
  const status = await runApplication({
    io, options: { sessionDirectory: '/__owned_in_memory_fixture_only__', provider: 'openai', model: 'gpt-4.1',
      skillsDirectories: [], enableSkills: false, enableMemory: false, enableTools: false, enableNotes: false,
      enableCommands: false, approvalMode: 'manual', stream: false, maxRounds: 25, reasoningCapabilities: [],
      ...(behavior.initial ? { prompt: 'Never submit a turn' } : {}) }, args: ['--no-tools'],
    env: { OPENAI_API_KEY: 'owned-offline-noncredential-marker' }, secrets: [],
    credentials: { load: never('credential read'), status: never('credential status'), save: never('credential save') },
    catalog: { list: never('provider metadata fetch') }, mcpManagerFactory: () => manager,
    providerFactory: () => {
      if (behavior.providerError && acquired.length === 2) throw behavior.providerError
      if (behavior.closeDuringProvider && acquired.length === 2) io.isClosed = true
      return { generate: async () => { generations++; assert.fail('Unexpected provider generation') } }
    }
  })
  assert.deepEqual(forbiddenCalls, [], 'Caught exceptions cannot hide entry into excluded paths')
  assert.equal(generations, 0); assert.equal(managerCloses, 1)
  return { status, acquired, released, activeLeases, hosts, shutdowns, order, displayed, messages, reads }
}

function assertDiscarded(subject, candidate = subject.hosts[1]) {
  assert.deepEqual([...subject.activeLeases], [])
  const id = candidate.session.id
  const cleanup = subject.order.findIndex(([kind, session]) => kind === 'shutdown' && session === id)
  const release = subject.order.findIndex(([kind, session]) => kind === 'release' && session === id)
  assert(cleanup >= 0 && release > cleanup, 'Candidate host cleanup precedes candidate lease release')
  assert.equal(subject.shutdowns.filter(host => host === candidate).length, 1)
}

test('failed previous-host shutdown rolls back the candidate and exits without entering another turn', async t => {
  const error = new Error('Previous-host cleanup failed'), subject = await fixture(t, { oldShutdownError: error })
  assert.equal(subject.status, 1); assert.equal(subject.reads, 1)
  assert.deepEqual(subject.displayed.map(session => session.id), [subject.acquired[0]], 'Previous host remains the published owner')
  assert.deepEqual(subject.released, [subject.acquired[1], subject.acquired[0]])
  assertDiscarded(subject)
  assert(subject.messages.some(message => message.includes(error.message)))
})

test('candidate initialization failure cleans up the candidate while keeping the previous session selected', async t => {
  const error = new Error('Candidate checkpoint failed'), subject = await fixture(t, { initializeError: error })
  assert.equal(subject.status, 0)
  assert.deepEqual(subject.displayed.map(session => session.id), [subject.acquired[0]])
  assertDiscarded(subject)
  assert(subject.messages.some(message => message.includes(error.message)))
})

test('initial host initialization failure shuts it down before releasing its lease', async t => {
  const subject = await fixture(t, { initial: true, initializeError: new Error('Initial checkpoint failed') })
  assert.equal(subject.status, 1); assert.equal(subject.reads, 0); assert.deepEqual(subject.displayed, [])
  assert.equal(subject.acquired.length, 1); assertDiscarded(subject, subject.hosts[0])
})

for (const initial of [false, true]) test(`closed IO during ${initial ? 'initial' : 'replacement'} initialization discards its host and lease`, async t => {
  const subject = await fixture(t, { initial, closeDuringInitialize: true })
  assert.equal(subject.status, 0)
  assert.deepEqual(subject.displayed.map(session => session.id), initial ? [] : [subject.acquired[0]])
  assertDiscarded(subject, subject.hosts[initial ? 0 : 1])
})

test('failure before host construction releases the unadopted lease without changing the selected session', async t => {
  const error = new Error('Provider construction failed'), subject = await fixture(t, { providerError: error })
  assert.equal(subject.status, 0); assert.equal(subject.hosts.length, 1)
  assert.deepEqual(subject.displayed.map(session => session.id), [subject.acquired[0]])
  assert.deepEqual([...subject.activeLeases], [])
  assert(subject.messages.some(message => message.includes(error.message)))
})

test('successful replacement adopts the new owner and shuts down each session before its lease release', async t => {
  const subject = await fixture(t)
  assert.equal(subject.status, 0); assert.deepEqual([...subject.activeLeases], [])
  assert.deepEqual(subject.displayed.map(session => session.id), subject.acquired)
  for (const host of subject.hosts) {
    assert.equal(subject.shutdowns.filter(value => value === host).length, 1)
    const id = host.session.id
    assert(subject.order.findIndex(([kind, session]) => kind === 'shutdown' && session === id) <
      subject.order.findIndex(([kind, session]) => kind === 'release' && session === id))
  }
})


test('candidate shutdown failure keeps its lease until final cleanup can confirm shutdown', async t => {
  const primary = new Error('Previous-host cleanup failed'), secondary = new Error('Candidate cleanup failed once')
  const subject = await fixture(t, { oldShutdownError: primary, candidateShutdownError: secondary, candidateShutdownOnce: true })
  assert.equal(subject.status, 1); assert.equal(subject.reads, 1)
  assert.deepEqual(subject.displayed.map(session => session.id), [subject.acquired[0]])
  const candidate = subject.hosts[1], id = candidate.session.id
  assert.deepEqual(subject.order.filter(([, session]) => session === id).map(([kind]) => kind),
    ['acquire', 'shutdown', 'shutdown', 'release'])
  assert.deepEqual([...subject.activeLeases], [])
  for (const error of [primary, secondary]) assert(subject.messages.some(message => message.includes(error.message)))
})

test('unconfirmed candidate shutdown retains the lease and reports both failures', async t => {
  const primary = new Error('Candidate checkpoint failed'), secondary = new Error('Candidate cleanup never confirmed')
  const subject = await fixture(t, { initializeError: primary, candidateShutdownError: secondary })
  assert.equal(subject.status, 1); assert.equal(subject.reads, 1)
  assert.deepEqual([...subject.activeLeases], [subject.acquired[1]])
  assert.deepEqual(subject.released, [subject.acquired[0]])
  assert.equal(subject.shutdowns.filter(host => host === subject.hosts[1]).length, 2)
  assert(subject.messages.some(message => message.includes('session may remain locked')))
  for (const error of [primary, secondary]) assert(subject.messages.some(message => message.includes(error.message)))
})

test('candidate release failure is observed once without masking the original initialization error', async t => {
  const primary = new Error('Candidate checkpoint failed'), secondary = new Error('Candidate unlink failed')
  const subject = await fixture(t, { initializeError: primary, releaseError: secondary })
  assert.equal(subject.status, 1); assert.equal(subject.reads, 1)
  assert.equal(subject.released.filter(id => id === subject.acquired[1]).length, 1)
  assert.deepEqual([...subject.activeLeases], [subject.acquired[1]])
  assert.equal(subject.shutdowns.filter(host => host === subject.hosts[1]).length, 1)
  for (const error of [primary, secondary]) assert(subject.messages.some(message => message.includes(error.message)))
})


test('failed final retry preserves the previous shutdown failure and retains the old owner lease', async t => {
  const primary = new Error('Previous-host cleanup failed'), secondary = new Error('Previous-host retry failed')
  const subject = await fixture(t, { oldShutdownError: primary, oldShutdownAlways: true, oldRetryError: secondary })
  assert.equal(subject.status, 1); assert.equal(subject.reads, 1)
  assert.deepEqual(subject.displayed.map(session => session.id), [subject.acquired[0]])
  assert.deepEqual([...subject.activeLeases], [subject.acquired[0]])
  assert.deepEqual(subject.released, [subject.acquired[1]])
  for (const error of [primary, secondary]) assert(subject.messages.some(message => message.includes(error.message)))
})

test('partial previous shutdown cannot release its owner or admit another turn', async t => {
  const error = new Error('Previous-host memory drain failed'), subject = await fixture(t, { failDuringOldDrain: error })
  assert.equal(subject.status, 1); assert.equal(subject.reads, 1)
  assert.deepEqual(subject.displayed.map(session => session.id), [subject.acquired[0]])
  assert.deepEqual([...subject.activeLeases], [subject.acquired[0]])
  assert.deepEqual(subject.released, [subject.acquired[1]])
  await assert.rejects(subject.hosts[0].send('No stale turn'), /host is shut down/)
  assert(subject.messages.some(message => message.includes(error.message)))
})


test('secondary cleanup reporting failures cannot mask the primary failure or release unconfirmed ownership', async t => {
  const primary = new Error('Previous-host cleanup failed'), secondary = new Error('Candidate cleanup failed')
  const subject = await fixture(t, { oldShutdownError: primary, candidateShutdownError: secondary, throwCleanupReporter: secondary })
  assert.equal(subject.status, 1); assert.equal(subject.reads, 1)
  assert.deepEqual([...subject.activeLeases], [subject.acquired[1]])
  assert(subject.messages.some(message => message.includes(primary.message)))
})

test('IO closing during provider construction releases the candidate lease before any host is built', async t => {
  const subject = await fixture(t, { closeDuringProvider: true })
  assert.equal(subject.status, 0); assert.equal(subject.hosts.length, 1)
  assert.deepEqual(subject.displayed.map(session => session.id), [subject.acquired[0]])
  assert.deepEqual([...subject.activeLeases], [])
})

test('IO closing while the previous host shuts down discards the candidate without publishing it', async t => {
  const subject = await fixture(t, { closeDuringOldShutdown: true })
  assert.equal(subject.status, 0)
  assert.deepEqual(subject.displayed.map(session => session.id), [subject.acquired[0]])
  assertDiscarded(subject)
})
