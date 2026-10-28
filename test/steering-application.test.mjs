// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CliHost } from '../dist/host.js'
import { main } from '../dist/main.js'
import { PreferenceStore } from '../dist/preferences.js'
import { DEFAULT_PREFERENCES } from '../dist/application.js'

test('queued input cannot cross conversation/account/model ownership; clearing explicitly permits navigation', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-steering-app-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, model: 'gpt-5.1', enableTools: false, enableNotes: false })
  const lines = ['Start', '/new', '/resume', '/provider', '/models', '/effort', '/queue', '/queue clear', '/new', 'Fresh', '/exit']
  const sessions = [], inputs = [], outputs = []
  let steering, cancel, providerCalls = 0
  const io = {
    async readLine() { return lines.shift() },
    async choose() { assert.fail('Queued input must prevent owner-changing pickers') },
    async chooseSearchable() { assert.fail('Queued input must prevent owner-changing pickers') }, async askText() {},
    setSession(session) { sessions.push(session) }, setDraft() {}, write(text) { outputs.push(text) }, event() {}, result() {},
    async approve() { return false }, onCancel(callback) { cancel = callback; return () => { cancel = undefined } },
    onSteering(controls) { steering = controls; return () => { steering = undefined } }, close() {}
  }
  const providerFactory = () => ({ async generate(input) {
    inputs.push(input)
    if (++providerCalls === 1) { assert.equal(steering.submit('Stay here', false), true); cancel() }
    return { content: 'Done', toolCalls: [] }
  } })
  assert.equal(await main(['--no-workspace', '--no-skills'], { VIVI_SESSION_DIR: directory, OPENAI_API_KEY: 'owned-inert-fixture-key' }, {
    tuiIO: io, providerFactory, credentials: { async load() {}, async status() { return { available: false, label: 'Inert' } }, async save() {} }
  }), 0)
  assert.equal(providerCalls, 2)
  assert.equal(outputs.filter(text => text.includes('before changing conversations')).length, 5)
  assert(outputs.some(text => text.includes('Stay here')))
  assert.equal(new Set(sessions.map(session => session.id)).size, 2)
  assert.deepEqual(inputs[1].messages.filter(message => message.kind === 'message' && message.role === 'user').map(message => message.content), ['Fresh'])
})

test('queue send refreshes canonical session even when admitted work later throws', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-steering-recovery-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await new PreferenceStore(directory).save({ ...DEFAULT_PREFERENCES, model: 'gpt-5.1', enableTools: false, enableNotes: false })
  const originalSend = CliHost.prototype.send
  t.mock.method(CliHost.prototype, 'send', async function (...args) {
    const result = await originalSend.apply(this, args)
    if (args[3]) throw new Error('Owned cleanup failed after admission')
    return result
  })
  const lines = ['Start', '/queue send', '/exit'], sessions = [], output = []
  let steering, cancel, calls = 0
  const io = {
    async readLine() { return lines.shift() }, async choose() {}, async chooseSearchable() {}, async askText() {},
    setSession(session) { sessions.push(session) }, setDraft() {}, write(text) { output.push(text) }, event() {}, result() {},
    async approve() { return false }, onCancel(callback) { cancel = callback; return () => { cancel = undefined } },
    onSteering(controls) { steering = controls; return () => { steering = undefined } }, close() {}
  }
  assert.equal(await main(['--no-workspace', '--no-skills'], { VIVI_SESSION_DIR: directory, OPENAI_API_KEY: 'owned-inert-fixture-key' }, {
    tuiIO: io, providerFactory: () => ({ async generate() {
      if (++calls === 1) { steering.submit('Accepted follow-up', false); cancel() }
      return { content: 'Done', toolCalls: [] }
    } }), credentials: { async load() {}, async status() { return { available: false, label: 'Inert' } }, async save() {} }
  }), 0)
  assert(output.some(text => text.includes('Owned cleanup failed after admission')))
  assert.equal(sessions.at(-1).history.filter(message => message.content === 'Accepted follow-up').length, 1)
})
