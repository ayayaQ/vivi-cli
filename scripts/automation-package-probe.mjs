// SPDX-License-Identifier: Apache-2.0
// Offline fixture executed from the installed package, never the source checkout.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { main } from '../dist/main.js'
import { AUTOMATION_PROTOCOL, AUTOMATION_VERSION } from '../dist/index.js'

const directory = await mkdtemp(join(tmpdir(), 'vivi-automation-installed-'))
const originalFetch = globalThis.fetch
globalThis.fetch = async () => { throw new Error('Installed automation fixture must be offline') }
const wireSchema = JSON.parse(await readFile(new URL('../docs/automation-v1.schema.json', import.meta.url), 'utf8'))
const checkEvent = new Ajv2020({ strict: true }).compile(wireSchema)
try {
  const schema = join(directory, 'answer.schema.json')
  await writeFile(schema, JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }))
  async function invoke(content, args = []) {
    let stdout = '', stderr = ''
    const status = await main(['--jsonl', '--model', 'offline', '--prompt', '/literal', '--no-workspace', '--no-tools', '--no-skills',
      '--session-dir', join(directory, 'sessions'), ...args], {}, {
      catalog: { list: async () => ({ models: [], state: 'fresh' }) },
      providerFactory: () => ({ generate: async input => {
        assert.equal(input.messages.at(-1).content, '/literal')
        return { content, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      } }),
      automation: { stdout: new Writable({ write(chunk, _encoding, callback) { stdout += chunk; callback() } }),
        stderr: new Writable({ write(chunk, _encoding, callback) { stderr += chunk; callback() } }) }
    })
    const events = stdout.trim().split('\n').map(line => JSON.parse(line))
    for (const event of events) {
      assert.equal(event.protocol, AUTOMATION_PROTOCOL); assert.equal(event.version, AUTOMATION_VERSION)
      assert(checkEvent(event), JSON.stringify(checkEvent.errors))
    }
    assert.deepEqual(events.map(e => e.seq), events.map((_, i) => i + 1))
    assert.equal(events.filter(e => /^run\.(completed|failed|cancelled)$/.test(e.type)).length, 1)
    assert(!stdout.includes('\x1b')); assert(!stderr.includes('offline fixture must'))
    return { status, final: events.at(-1), events }
  }
  const good = await invoke('{"ok":true}', ['--output-schema', schema])
  assert.equal(good.status, 0); assert.deepEqual(good.final.structured_output, { ok: true })
  assert(good.events.filter(e => e.type === 'assistant.completed').every(e => !Object.hasOwn(e, 'text')))
  const mismatch = await invoke('{"ok":"wrong"}', ['--output-schema', schema])
  assert.equal(mismatch.status, 3); assert.equal(mismatch.final.code, 'schema_mismatch')
  const plain = await invoke('Installed automation works')
  assert.equal(plain.status, 0); assert.equal(plain.final.final_text, 'Installed automation works')
  const invalid = await invoke('never', ['--approval-mode', 'skip'])
  assert.equal(invalid.status, 2); assert.equal(invalid.events.length, 2)
  const tty = 'data:text/javascript,' + encodeURIComponent("Object.defineProperty(process.stdin,'isTTY',{value:true});Object.defineProperty(process.stdout,'isTTY',{value:true})")
  const child = spawnSync(process.execPath, ['--import', tty, fileURLToPath(new URL('../dist/launcher.js', import.meta.url)),
    '--jsonl', '--model', 'offline', '--prompt', 'literal', '--approval-mode', 'skip'], { encoding: 'utf8', timeout: 10000, cwd: directory, env: { PATH: '', VIVI_SESSION_DIR: join(directory, 'never-created') } })
  assert.equal(child.status, 2, child.stderr)
  const launchEvents = child.stdout.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(launchEvents.at(-1).code, 'invalid_configuration')
  assert(!child.stdout.includes('\x1b')); assert(!child.stderr.includes('Bun'))
  console.log('Installed automation JSONL, output schema and failure contracts passed')
} finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }) }
