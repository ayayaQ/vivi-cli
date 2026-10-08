// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpConfigStore, MCP_ENV_NAMES, mcpDisplayJson, prepareMcpLaunch } from '../dist/mcp-config.js'
import { McpManager, mcpStartDisclosure } from '../dist/mcp-manager.js'
import { McpStdioTransport } from '../dist/mcp-transport.js'
const fixtureFile = fileURLToPath(new URL('./fixtures/mcp-discovery-server.mjs', import.meta.url))
const scriptArgs = [...(process.versions.bun ? ['--no-install'] : []), fixtureFile]
const fixtureEnvironment = process.platform === 'win32' && !process.versions.bun ? ['SYSTEMROOT'] : []
const fixtureEnv = fixtureEnvironment.length ? { SYSTEMROOT: Object.entries(process.env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1]
  ?? assert.fail('Windows Node fixture requires an explicitly captured SystemRoot') } : {}
const signal = () => new AbortController().signal
async function fixture(t, mode = 'normal', wrapTransport) {
  const directory = await mkdtemp(join(tmpdir(), 'vivi-mcp-lifecycle-'))
  const store = new McpConfigStore(directory)
  const server = { id: 'fixture', label: 'Fixture', executable: process.execPath,
    args: [...scriptArgs, mode, join(directory, 'log'), join(directory, 'pid')], cwd: directory,
    protocol: 'legacy', environment: fixtureEnvironment }
  let starts = 0
  const manager = new McpManager({ store, env: fixtureEnv, transportFactory: launch => { assert.deepEqual(launch.environment, fixtureEnv); starts++; const transport = new McpStdioTransport(launch); wrapTransport?.(transport, launch); return transport } })
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }) })
  await manager.configure(server)
  return { directory, store, server, manager, starts: () => starts }
}
test('safe path environment rejects known provider-key aliases and recognized credential values', async t => {
  const subject = await fixture(t), name = MCP_ENV_NAMES[0]
  const server = { ...subject.server, environment: [name] }
  for (const value of ['fixture-provider-key', 'sk-proj-' + 'a'.repeat(40), 'Bearer ' + 'b'.repeat(40)]) {
    await assert.rejects(prepareMcpLaunch(server, 'revision', { [name]: value, OPENAI_API_KEY: 'fixture-provider-key' }), /unsafe/)
  }
  const ordinary = await prepareMcpLaunch(server, 'revision', { [name]: subject.directory, OPENAI_API_KEY: 'fixture-provider-key', PATH: '/do-not-forward' })
  assert.deepEqual(ordinary.environment, { [name]: subject.directory })
})
test('invisible approval values remain exact JSON while rendering every hidden code point', async t => {
  const subject = await fixture(t)
  const value = 'visible\u202ehidden\u200b\ufe0f\u{e0100}\u2028end'
  const rendered = mcpDisplayJson(value)
  assert.equal(JSON.parse(rendered), value)
  assert(!/[\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u.test(rendered))
  const launch = await prepareMcpLaunch({ ...subject.server, label: value, args: [...scriptArgs, value] }, 'revision', fixtureEnv)
  const disclosure = mcpStartDisclosure(launch)
  assert(disclosure.includes(rendered))
  assert.match(disclosure, /before any tool-call approval/)
  assert.match(disclosure, /no model tools or resource contents/)
  assert(!disclosure.includes(value))
})
test('an oversized escaped approval is refused before any startup', async t => {
  const subject = await fixture(t)
  const launch = await prepareMcpLaunch(subject.server, 'revision', fixtureEnv)
  const oversized = { ...launch, server: { ...launch.server, args: Array(3).fill('\u200b'.repeat(3000)) } }
  assert.throws(() => mcpStartDisclosure(oversized), /approval display exceeds/)
  assert.equal(subject.starts(), 0)
})
test('reconnect has fresh human consent and a distinct immutable connection identity', async t => {
  const subject = await fixture(t)
  let approvals = 0
  const approve = async () => { approvals++; return true }
  assert.equal(await subject.manager.connect('fixture', approve, signal()), true)
  const first = subject.manager.statuses()[0].snapshot
  await assert.rejects(subject.manager.connect('fixture', approve, signal()), /Disable/)
  assert.equal(approvals, 1)
  await subject.manager.disconnect('fixture')
  assert.equal(await subject.manager.connect('fixture', approve, signal()), true)
  const second = subject.manager.statuses()[0].snapshot
  assert.equal(approvals, 2); assert.equal(subject.starts(), 2)
  assert.notEqual(first.connectionGeneration, second.connectionGeneration)
  assert.equal(first.configRevision, second.configRevision)
  assert.equal(first.categories.tools.digest, second.categories.tools.digest)
  assert(Object.isFrozen(first.categories.tools.entries[0].descriptor))
})
test('closing while a fresh startup approval is pending prevents late process startup', async t => {
  const subject = await fixture(t)
  let release, entered
  const ready = new Promise(resolve => { entered = resolve })
  const pending = subject.manager.connect('fixture', async () => {
    entered(); return new Promise(resolve => { release = resolve })
  }, signal())
  await ready; await subject.manager.close(); release(true)
  await assert.rejects(pending, /manager is closed/)
  assert.equal(subject.starts(), 0)
})
test('changed configuration reload disconnects and invalidates live catalogs before showing disabled entries', async t => {
  const subject = await fixture(t)
  assert.equal(await subject.manager.connect('fixture', async () => true, signal()), true)
  const old = subject.manager.statuses()[0].snapshot
  const current = await subject.store.load()
  await subject.store.save([{ ...subject.server, label: 'Explicitly changed' }], current.revision)
  await subject.manager.reload()
  const status = subject.manager.statuses()[0]
  assert.equal(status.server.label, 'Explicitly changed')
  assert.equal(status.state, 'disabled'); assert.equal(status.snapshot, undefined)
  assert(Object.isFrozen(old)); assert.equal(subject.starts(), 1)
})
test('resource metadata cancellation neither retries nor retrieves resource bodies', async t => {
  const subject = await fixture(t)
  assert.equal(await subject.manager.connect('fixture', async () => true, signal()), true)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(subject.manager.refresh('fixture', ['resources', 'resourceTemplates'], controller.signal))
  const log = (await readFile(join(subject.directory, 'log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert(!log.some(message => message.method === 'resources/read' || message.method === 'resources/list'))
  assert.equal(subject.manager.statuses()[0].snapshot.categories.resources.state, 'not-requested')
  assert.equal(subject.starts(), 1)
})

for (const kind of ['malformed', 'unsafe', 'protocol-type']) test(`invalid external config revokes live metadata and processes: ${kind}`, async t => {
  const subject = await fixture(t)
  assert.equal(await subject.manager.connect('fixture', async () => true, signal()), true)
  const pid = Number(await readFile(join(subject.directory, 'pid'), 'utf8'))
  const invalid = kind === 'malformed' ? '{fixture-private-text malformed JSON\n'
    : JSON.stringify({ schemaVersion: 1, servers: [{ ...subject.server,
      ...(kind === 'unsafe' ? { environment: ['OPENAI_API_KEY'] } : { protocol: ['legacy'] }) }] })
  await writeFile(join(subject.directory, 'mcp-servers.json'), invalid)
  await assert.rejects(subject.manager.reload(), error => {
    assert.match(error.message, /configuration is unavailable or invalid/)
    assert(!error.message.includes('fixture-private-text'))
    return true
  })
  assert.equal(subject.manager.statuses()[0].state, 'disabled')
  assert.equal(subject.manager.statuses()[0].snapshot, undefined)
  assert.throws(() => process.kill(pid, 0), /ESRCH/)
  assert.equal(subject.starts(), 1)
  // Repairing a user-owned configuration never restores a prior connection.
  await writeFile(join(subject.directory, 'mcp-servers.json'), JSON.stringify({ schemaVersion: 1, servers: [subject.server] }))
  await subject.manager.reload()
  assert.equal(subject.manager.statuses()[0].state, 'disabled')
  assert.equal(subject.starts(), 1)
})

test('a malformed config introduced during discovery closes the process without refresh self-deadlock', async t => {
  let lists = 0
  const subject = await fixture(t, 'normal', (transport, launch) => {
    const send = transport.send.bind(transport)
    transport.send = async message => {
      if (message.method === 'tools/list' && ++lists === 2) {
        await writeFile(join(launch.server.cwd, 'mcp-servers.json'), '{fixture-private-text malformed JSON\n')
      }
      await send(message)
    }
  })
  assert.equal(await subject.manager.connect('fixture', async () => true, signal()), true)
  const pid = Number(await readFile(join(subject.directory, 'pid'), 'utf8'))
  await assert.rejects(subject.manager.refresh('fixture', ['tools'], signal()), /configuration is unavailable or invalid/)
  assert.equal(subject.manager.statuses()[0].state, 'disabled')
  assert.equal(subject.manager.statuses()[0].snapshot, undefined)
  assert.throws(() => process.kill(pid, 0), /ESRCH/)
  assert.equal(subject.starts(), 1)
})

for (const change of ['malformed', 'valid']) test(`configuration revocation preserves cleanup failure: ${change}`, async t => {
  let failCleanup = false
  const subject = await fixture(t, 'normal', (transport, launch) => {
    const send = transport.send.bind(transport), close = transport.close.bind(transport)
    let lists = 0
    transport.send = async message => {
      if (message.method === 'tools/list' && ++lists === 2) {
        const raw = change === 'malformed' ? '{fixture-private-text malformed JSON\n'
          : JSON.stringify({ schemaVersion: 1, servers: [{ ...launch.server, label: 'Changed' }] })
        await writeFile(join(launch.server.cwd, 'mcp-servers.json'), raw)
        failCleanup = true
      }
      await send(message)
    }
    transport.close = async () => {
      await close()
      if (failCleanup) throw new Error('fixture-private-cleanup-detail')
    }
  })
  assert.equal(await subject.manager.connect('fixture', async () => true, signal()), true)
  try {
    await assert.rejects(subject.manager.refresh('fixture', ['tools'], signal()), error => {
      assert.match(error.message, /owned process cleanup could not be verified/)
      assert(!error.message.includes('fixture-private'))
      return true
    })
    assert.equal(subject.manager.statuses()[0].state, 'error')
    assert.equal(subject.manager.statuses()[0].snapshot, undefined)
    assert.equal(subject.starts(), 1)
    await assert.rejects(subject.manager.close(), /fixture-private-cleanup-detail/)
  } finally { failCleanup = false }
  // Explicit disconnect still owns and drains the retained handle, without
  // parsing the malformed or changed saved configuration.
  await subject.manager.disconnect('fixture')
  assert.equal(subject.manager.statuses()[0].state, 'disabled')
  assert.equal(subject.manager.statuses()[0].snapshot, undefined)
})
