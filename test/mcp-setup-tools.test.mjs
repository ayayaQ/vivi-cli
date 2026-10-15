// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createExtensionScope, createToolRegistry } from '@ayayaq/vivi/extensions'
import { createMcpSetupExtension, MCP_SETUP_GUIDANCE, MCP_SETUP_TOOL_NAMES } from '../dist/mcp-setup-tools.js'

const revision = 'a'.repeat(64)
const setup = (action = 'add', extra = {}) => ({ action, id: 'docs', expectedRevision: revision,
  ...(action === 'add' ? { endpoint: 'https://example.com/mcp' } : {}), ...extra })
const call = (name, arguments_ = {}) => ({ id: 'fixture-call', name, arguments: arguments_ })
const result = body => ({ content: JSON.stringify(body) })
const signal = () => new AbortController().signal

function fixture(overrides = {}) {
  const calls = [], secrets = []
  const host = { async listLocal() { calls.push('list'); return result({ source: 'mcp', localMetadataOnly: true,
    requestSent: false, revision, servers: [] }) },
    async executeSetup(value) { calls.push(value); return result({ success: true, state: 'disabled' }) },
    secrets: () => secrets, ...overrides }
  const extension = createMcpSetupExtension(host), registry = createToolRegistry([extension])
  return { calls, secrets, host, extension, registry,
    run: (name, args = {}, abortSignal = signal()) => registry.executeTool(call(name, args), { signal: abortSignal }) }
}

test('setup is a fixed separate two-tool pack available without connected catalogs', async () => {
  const subject = fixture()
  assert.equal(subject.extension.id, 'vivi-cli-mcp-setup')
  assert.deepEqual(subject.registry.tools.map(tool => tool.name), MCP_SETUP_TOOL_NAMES)
  const protocol = subject.registry.tools.find(tool => tool.name === 'mcp_setup').parameters.properties.protocol
  assert.deepEqual(protocol.enum, ['auto', 'legacy', '2026-07-28']); assert.equal(protocol.default, 'auto')
  for (const definition of subject.registry.tools) assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(JSON.parse((await subject.run('mcp_list')).content).servers, [])
  assert.deepEqual(subject.calls, ['list'])
  assert.match(MCP_SETUP_GUIDANCE, /fresh human review, including in Auto/)
  assert.match(MCP_SETUP_GUIDANCE, /freshness check, never approval/)
  assert.match(MCP_SETUP_GUIDANCE, /next turn/)
})

for (const action of ['add', 'connect', 'login', 'logout', 'remove']) test(`valid ${action} delegates once with exact immutable arguments`, async () => {
  const subject = fixture(), args = setup(action)
  assert.equal((await subject.run('mcp_setup', args)).isError, undefined)
  assert.equal(subject.calls.length, 1)
  assert.deepEqual(subject.calls[0], call('mcp_setup', args))
  assert(Object.isFrozen(subject.calls[0]))
  assert(Object.isFrozen(subject.calls[0].arguments))
  assert.deepEqual(subject.calls[0].arguments, args)
})

for (const protocol of ['auto', 'legacy', '2026-07-28']) test(`add preserves public endpoint, display label and protocol ${protocol} without expanding arguments`, async () => {
  const subject = fixture(), args = setup('add', { endpoint: 'https://example.com:8443/MCP', label: 'Docs', protocol })
  await subject.run('mcp_setup', args)
  assert.deepEqual(subject.calls[0].arguments, args)
})

for (const field of ['approved', 'settingsPath', 'executable', 'args', 'cwd', 'environment', 'headers', 'bearerToken', 'clientSecret', 'allowLoopbackHttp']) {
  test(`unsupported ${field} never reaches setup service`, async () => {
    const subject = fixture(), response = await subject.run('mcp_setup', setup('add', { [field]: 'untrusted' }))
    assert.equal(response.isError, true); assert.equal(JSON.parse(response.content).error.code, 'invalid_arguments')
    assert.deepEqual(subject.calls, [])
  })
}

for (const args of [
  {}, setup('update'), setup('register'), setup('add', { expectedRevision: undefined }),
  setup('add', { expectedRevision: 'A'.repeat(64) }), setup('add', { expectedRevision: 'a'.repeat(63) }),
  setup('add', { expectedRevision: 1 }), setup('add', { id: '../docs' }), setup('add', { id: 'Docs' }),
  setup('add', { id: 'x'.repeat(17) }), setup('add', { endpoint: undefined }),
  setup('add', { label: '' }), setup('add', { label: 'x'.repeat(81) }), setup('add', { protocol: 'unsupported' }),
  setup('add', { endpoint: 'https://name:password@example.com/mcp' }),
  setup('add', { endpoint: 'https://example.com/mcp?token=value' }), setup('add', { endpoint: 'https://example.com/mcp#fragment' }),
  setup('add', { endpoint: 'http://127.0.0.1/mcp' }), setup('add', { endpoint: 'file:///mcp' }),
  setup('add', { label: 'sk-proj-' + 'a'.repeat(20) }),
  ...['connect', 'login', 'logout', 'remove'].map(action => setup(action, { endpoint: 'https://example.com/mcp' }))
]) test(`invalid setup shape ${JSON.stringify(args)} has no host effects`, async () => {
  const subject = fixture(), response = await subject.run('mcp_setup', JSON.parse(JSON.stringify(args)))
  assert.equal(response.isError, true); assert.deepEqual(subject.calls, [])
})

test('local listing accepts no selector or arbitrary config field', async () => {
  const subject = fixture()
  for (const args of [{ id: 'docs' }, { path: '/private/config' }, { refresh: true }]) {
    assert.equal((await subject.run('mcp_list', args)).isError, true)
  }
  assert.deepEqual(subject.calls, [])
})

for (const label of ['known-private-value', 'known%2Dprivate%2Dvalue', String.raw`known\u002dprivate\u002dvalue`]) {
  test(`known credential screening precedes host execution: ${label}`, async () => {
    const subject = fixture(); subject.secrets.push('known-private-value')
    const response = await subject.run('mcp_setup', setup('add', { label }))
    assert.equal(response.isError, true); assert.deepEqual(subject.calls, [])
    assert(!response.content.includes('known-private-value'))
  })
}

for (const failed of [false, true]) test(`newly known credential in local listing is withheld preserving error=${failed}`, async () => {
  const subject = fixture({ async listLocal() {
    subject.secrets.push('new-private-value')
    return { ...result({ success: !failed, servers: [{ label: 'new-private-value' }] }), ...(failed ? { isError: true } : {}) }
  } })
  const response = await subject.run('mcp_list'), body = JSON.parse(response.content)
  assert(!response.content.includes('new-private-value'))
  assert.equal(body.success, !failed); assert.equal(body.requestSent, false)
  assert.equal(body.localMetadataOnly, true); assert.equal(Boolean(response.isError), failed)
})

for (const outcome of ['unknown', 'success', 'failed']) test(`setup privacy withholding preserves trusted ${outcome} evidence and prohibits replay`, async () => {
  const subject = fixture({ async executeSetup() {
    subject.secrets.push('new-private-value')
    return { ...result({ detail: 'new-private-value', ...(outcome === 'unknown' ? {} : {
      confirmedOutcome: true, success: outcome === 'success' }) }), ...(outcome === 'failed' ? { isError: true } : {}) }
  } })
  const response = await subject.run('mcp_setup', setup('login')), body = JSON.parse(response.content)
  assert(!response.content.includes('new-private-value'))
  assert.equal(body.doNotRetry, true); assert.equal(body.contentWithheld, true)
  assert.equal(body.success, outcome === 'success')
  assert.equal(body.unknownOutcome, outcome === 'unknown' ? true : undefined)
  assert.equal(body.confirmedOutcome, outcome === 'unknown' ? undefined : true)
  assert.equal(Boolean(response.isError), outcome !== 'success')
})

test('later callback replacement cannot change a registered trusted implementation', async () => {
  const subject = fixture()
  subject.host.listLocal = subject.host.executeSetup = async () => { throw new Error('Replaced callback executed') }
  await subject.run('mcp_list'); await subject.run('mcp_setup', setup())
  assert.equal(subject.calls.length, 2)
})

test('extra top-level tool-call data cannot enter trusted setup callbacks', async () => {
  const subject = fixture(), request = { ...call('mcp_setup', setup()), approved: true, settingsPath: '/private/config' }
  await subject.registry.executeTool(request, { signal: signal() })
  assert.deepEqual(subject.calls[0], call('mcp_setup', setup()))
})

test('already-aborted requests and retained closed scope dispatch cannot invoke service', async () => {
  const subject = fixture(), controller = new AbortController(); controller.abort()
  await assert.rejects(subject.run('mcp_setup', setup(), controller.signal), /abort/i)
  const scope = createExtensionScope(); scope.register(subject.extension)
  const retained = scope.snapshot(); await scope.dispose()
  await assert.rejects(retained.executeTool(call('mcp_list'), { signal: signal() }), /abort/i)
  assert.deepEqual(subject.calls, [])
})

test('the pack never retries a failed or uncertain setup result', async () => {
  const subject = fixture({ async executeSetup(value) { subject.calls.push(value)
    return { ...result({ success: false, unknownOutcome: true, doNotRetry: true }), isError: true } } })
  const response = await subject.run('mcp_setup', setup('login'))
  assert.equal(subject.calls.length, 1)
  assert.equal(JSON.parse(response.content).unknownOutcome, true)
})

for (const local of [true, false]) test(`callback exceptions do not expose diagnostics or claim zero effects (local=${local})`, async () => {
  const fail = async () => { throw new Error('unregistered-sensitive-diagnostic') }
  const subject = fixture({ listLocal: fail, executeSetup: fail })
  const response = await subject.run(local ? 'mcp_list' : 'mcp_setup', local ? {} : setup('login'))
  const body = JSON.parse(response.content)
  assert.equal(response.isError, true)
  assert(!response.content.includes('unregistered-sensitive-diagnostic'))
  assert.equal(body.requestSent, local ? false : undefined)
  assert.equal(body.unknownOutcome, local ? undefined : true)
  assert.equal(body.doNotRetry, local ? undefined : true)
})

test('credential-provider failure before execution is bounded and fails closed', async () => {
  const subject = fixture({ secrets() { throw new Error('private-diagnostic') } })
  for (const [name, args] of [['mcp_list', {}], ['mcp_setup', setup('login')]]) {
    const response = await subject.run(name, args), body = JSON.parse(response.content)
    assert.equal(response.isError, true); assert.equal(body.requestSent, false)
    assert(!response.content.includes('private-diagnostic'))
  }
  assert.deepEqual(subject.calls, [])
})

for (const confirmed of [false, true]) test(`credential-provider failure after execution preserves bounded confirmed=${confirmed} evidence`, async () => {
  let checks = 0
  const subject = fixture({ secrets() { if (++checks === 2) throw new Error('private-diagnostic'); return [] },
    async executeSetup(value) { subject.calls.push(value); return result(confirmed ? { success: true, confirmedOutcome: true } : { success: true }) }
  })
  const response = await subject.run('mcp_setup', setup('login')), body = JSON.parse(response.content)
  assert.equal(subject.calls.length, 1); assert(!response.content.includes('private-diagnostic'))
  assert.equal(body.success, confirmed); assert.equal(body.doNotRetry, true)
  assert.equal(body.confirmedOutcome, confirmed ? true : undefined)
  assert.equal(body.unknownOutcome, confirmed ? undefined : true)
  assert.match(body.message, /screening is unavailable/)
})

test('contradictory outcome flags cannot establish confirmation during privacy withholding', async () => {
  const subject = fixture({ async executeSetup() {
    subject.secrets.push('private-value')
    return result({ success: true, confirmedOutcome: true, unknownOutcome: true, detail: 'private-value' })
  } })
  const response = await subject.run('mcp_setup', setup('login')), body = JSON.parse(response.content)
  assert.equal(response.isError, true); assert.equal(body.success, false)
  assert.equal(body.unknownOutcome, true); assert.equal(body.confirmedOutcome, undefined)
  assert.equal(body.doNotRetry, true)
})

test('callback-owned result mutations after screening cannot enter registry output', async () => {
  const resultObject = result({ success: true }); let checks = 0
  const subject = fixture({ async executeSetup() { return resultObject }, secrets() {
    if (++checks === 2) queueMicrotask(() => { resultObject.content = 'known-private-value' })
    return ['known-private-value']
  } })
  const response = await subject.run('mcp_setup', setup('login'))
  assert.deepEqual(JSON.parse(response.content), { success: true })
  assert(!response.content.includes('known-private-value'))
  assert.equal(resultObject.content, 'known-private-value')
})

for (const local of [true, false]) for (const malformed of ['null', 'accessor', 'extra', 'oversized']) {
  test(`malformed ${malformed} callback result is bounded after completion (local=${local})`, async () => {
    const invalid = malformed === 'null' ? null : malformed === 'accessor'
      ? { content: 'private-value', get isError() { throw new Error('private-diagnostic') } }
      : malformed === 'extra' ? { content: '{}', privateMetadata: 'private-value' } : { content: 'x'.repeat(64 * 1024 + 1) }
    const returnInvalid = async () => invalid
    const subject = fixture({ listLocal: returnInvalid, executeSetup: returnInvalid, secrets: () => ['private-value'] })
    const response = await subject.run(local ? 'mcp_list' : 'mcp_setup', local ? {} : setup('login')), body = JSON.parse(response.content)
    assert.equal(response.isError, true)
    assert(!response.content.includes('private-value')); assert(!response.content.includes('private-diagnostic'))
    assert.equal(body.requestSent, local ? false : undefined)
    assert.equal(body.unknownOutcome, local ? undefined : true); assert.equal(body.doNotRetry, local ? undefined : true)
  })
}
