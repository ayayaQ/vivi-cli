// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { main } from '../dist/main.js'
import { TrustedCommandWorkspace } from '../dist/commands.js'
import { documentedOpenAIModel } from '../dist/models.js'

for (const navigation of ['/new', '/provider']) test(`${navigation} drains background jobs before the next composer and revokes obsolete controls`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'vivi-process-app-')), stateDirectory = join(root, 'state')
  t.after(() => rm(root, { recursive: true, force: true }))
  const open = TrustedCommandWorkspace.open, processes = [], bindings = []
  TrustedCommandWorkspace.open = (directory, env, secrets) => open.call(TrustedCommandWorkspace, directory, env, secrets, async () => {
    const stdout = new PassThrough(), stderr = new PassThrough(); let complete
    const record = { stops: 0 }; processes.push(record)
    const completed = new Promise(resolve => { complete = resolve })
    return { stdout, stderr, completed, async stop() { record.stops++; stdout.end(); stderr.end(); complete({ exitCode: null, signal: 'SIGKILL' }) } }
  })
  t.after(() => { TrustedCommandWorkspace.open = open })
  const choices = ['openai', 'enter', 'temporary'], lines = ['launch fixture', navigation, '/exit']
  let output = '', rounds = 0, read = 0
  const io = { canAutoReview: true, sessions: [],
    setSession(session) { this.sessions.push(structuredClone(session)) },
    onProcessControls(controls) { const binding = { controls, released: false }; bindings.push(binding); return () => { binding.released = true } },
    async readLine() {
      read++
      if (read === 2) { assert.equal(bindings.at(-1).controls.list()[0].state, 'running'); assert.equal(processes[0].stops, 0) }
      if (read === 3) {
        assert.equal(processes[0].stops, 1, 'Background tree cleanup precedes the next composer')
        if (navigation === '/new') { assert.equal(bindings[0].released, true); assert.deepEqual(bindings[0].controls.list(), []); assert.deepEqual(bindings.at(-1).controls.list(), []) }
        else { assert.equal(bindings.at(-1).controls.list()[0].cleanupConfirmed, true); assert.equal(bindings.length, 1, 'Cancelled model picker retains the same host, with jobs already stopped') }
      }
      return lines.shift()
    },
    async choose(title, values) { const value = choices.shift(); assert(values.some(item => item.value === value), `Missing ${value} from ${title}`); return value },
    async chooseSearchable() { return undefined }, async askText() {}, async askSecret() { return 'fake-replaced-application-key' },
    write(text) { output += text }, event() {}, result() {}, async approve() { return true }, onCancel() { return () => {} }, close() {} }
  const credentials = { async status() { return { available: false, label: 'Offline fake vault' } }, async load() {}, async save() { throw new Error('Never save fixture credentials') } }
  const catalog = { async list() { return { models: [documentedOpenAIModel('gpt-5.1')], state: 'fresh' } } }
  const code = await main(['--workspace', root, '--model', 'gpt-5.1', '--tools'], { ...process.env, OPENAI_API_KEY: 'fake-initial-application-key', VIVI_SESSION_DIR: stateDirectory }, {
    tuiIO: io, credentials, catalog, providerFactory: () => ({ async generate() {
      rounds++
      return rounds === 1 ? { content: '', toolCalls: [{ id: 'background-app-fixture', name: 'command_start', arguments: {
        executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], background: true, yieldMs: 0 } }] } : { content: 'Fixture server available.', toolCalls: [] }
    } })
  })
  assert.equal(code, 0, output); assert.equal(processes.length, 1); assert.equal(processes[0].stops, 1)
  assert(bindings.every(binding => binding.released)); assert(!output.includes('fake-initial-application-key')); assert(!output.includes('fake-replaced-application-key'))
})
