// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { main } from '../dist/main.js'
import { TrustedCommandWorkspace } from '../dist/commands.js'

for (const interactive of [false, true]) for (const prompt of [undefined, 'Start the offline fixture']) test(`${interactive ? 'interactive application' : 'accessible'} ${prompt ? 'one-shot' : 'exit'} reports unconfirmed tree cleanup, fails and retains the session lock`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'vivi-main-process-cleanup-')), directory = join(root, 'state')
  t.after(() => rm(root, { recursive: true, force: true }))
  const open = TrustedCommandWorkspace.open
  let stops = 0
  TrustedCommandWorkspace.open = (path, env, secrets) => open.call(TrustedCommandWorkspace, path, env, secrets, async () => {
    const stdout = new PassThrough(), stderr = new PassThrough(); let complete
    const completed = new Promise(resolve => { complete = resolve })
    return { stdout, stderr, completed, async stop() { stops++; stdout.end(); stderr.end(); complete({ exitCode: null, signal: 'SIGKILL', error: 'offline fixture tree cleanup unconfirmed' }) } }
  })
  t.after(() => { TrustedCommandWorkspace.open = open })
  let output = '', closed = false, rounds = 0
  const lines = ['Start the offline fixture', '/exit']
  const io = { canAutoReview: true, setSession() {}, async choose() {}, async chooseSearchable() {}, async askText() {}, write(text) { output += text }, async readLine() { return lines.shift() },
    event() {}, result() {}, async approve() { return true }, onCancel() { return () => {} }, close() { closed = true } }
  const code = await main(['--workspace', root, '--model', 'gpt-5.1', '--tools', ...(prompt ? ['--prompt', prompt] : [])], { ...process.env, OPENAI_API_KEY: 'fake-cleanup-fixture-key', VIVI_SESSION_DIR: directory }, {
    ...(interactive ? { tuiIO: io } : { io }), providerFactory: () => ({ async generate() { rounds++; return rounds === 1 ? { content: '', toolCalls: [{ id: 'main-cleanup-fixture', name: 'command_start', arguments: {
      executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], background: true, yieldMs: 0 } }] } : { content: 'Fixture remains available for manual inspection.', toolCalls: [] } } })
  })
  assert.equal(code, 1); assert.equal(stops, 1); assert.equal(closed, true)
  assert.match(output, /Process\/session cleanup unconfirmed/); assert.match(output, /[Ss]ession lock retained/)
  assert((await readdir(directory)).some(name => name.endsWith('.json.lock')), 'Unconfirmed ownership cannot release the writer lease')
})
