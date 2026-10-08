// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { CliHost } from '../dist/host.js'
import { FileSessionStore, newSession } from '../dist/session.js'
import { ReadOnlyWorkspace } from '../dist/workspace.js'
import { workspaceRevision, WORKSPACE_MUTATION_TOOL_NAMES } from '../dist/workspace-edit.js'
import { FileDecisionLedger } from '../dist/decision-ledger.js'
import { autoReviewSharingScope, AUTO_REVIEW_POLICY_REVISION, AUTO_REVIEW_SHARING_REVISION } from '../dist/auto-review.js'
import { TerminalIO, autoReviewDisclosure, selectApprovalMode } from '../dist/terminal.js'
import { routePreparedAction } from '@ayayaq/vivi/decisions'
async function fixture(t, config = {}) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'vivi-text-host-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'project'); await fs.mkdir(root)
  const workspace = await ReadOnlyWorkspace.open(root), records = [], requests = [], approvals = [], secrets = []
  const arguments_ = config.arguments ?? { path: 'new.txt', content: 'ordinary project text\n' }
  if (config.initial !== undefined) await fs.writeFile(join(root, 'new.txt'), config.initial)
  if (config.name === 'workspace_edit_text' && !config.arguments) {
    Object.assign(arguments_, { path: 'new.txt', expectedRevision: workspaceRevision(Buffer.from(config.initial)), before: 'old', after: 'new' }); delete arguments_.content
  }
  let round = 0, host
  const options = { session: newSession({ provider: config.providerId ?? 'openai', model: 'fixture' }), workspace,
    store: new FileSessionStore(join(directory, 'state'), secrets), secrets,
    approve: async (request, signal) => { approvals.push(request); await config.onHuman?.({ host, options, request, signal }); return config.allow ?? false },
    decisionReview: { canAutoReview: true, accountRevision: () => 'fixture-account', isAvailable: () => true,
      provider: { id: config.providerId ?? 'openai', model: config.providerId === 'openrouter' ? 'typesafe/jev-1.13' : 'gpt-6-luna',
        async evaluate(request, signal) {
          requests.push(request); await config.onEvaluate?.({ host, options, request, signal })
          return { model: config.providerId === 'openrouter' ? 'typesafe/jev-1.13' : 'gpt-6-luna',
            answers: request.policy.checks.map(check => ({ name: check.name, type: 'predicate', probability: config.probability ?? 1 })),
            usage: { inputTokens: 1, outputTokens: 1 } }
        } }, ledger: { async upsert(record) { records.push(structuredClone(record)); await config.onAudit?.({ host, options, record }) } } },
    provider: { async generate(input) {
      if (config.inspectTools) config.inspectTools(input.tools)
      if (++round === 1) return { content: '', toolCalls: [{ id: 'workspace-mutation-call', name: config.name ?? 'workspace_create_text', arguments: arguments_ }] }
      return { content: 'Done', toolCalls: [] }
    } } }
  host = new CliHost(options); if (config.auto) host.setApprovalMode('auto')
  return { root, directory, workspace, host, options, records, requests, approvals, secrets, arguments_ }
}
const mutationResult = result => JSON.parse(result.history.find(message => message.kind === 'tool_result').content)
async function noStages(root) { assert(!(await fs.readdir(root)).some(name => name.startsWith('.vivi-stage-'))) }

test('Manual shows the exact full diff and requires one approval for every actual workspace write', async t => {
  for (const allow of [false, true]) {
    const subject = await fixture(t, { allow })
    const result = mutationResult(await subject.host.send('Create new.txt with ordinary project text'))
    assert.equal(result.success, allow); assert.equal(subject.approvals.length, 1); assert.equal(subject.requests.length, 0)
    const review = subject.approvals[0].description
    assert.match(review, /Create workspace text file "new.txt"/); assert.match(review, /Before SHA-256: absent/)
    assert.match(review, /\+"ordinary project text\\n"/); assert.match(review, /temporary sibling/)
    if (allow) assert.equal(await fs.readFile(join(subject.root, 'new.txt'), 'utf8'), 'ordinary project text\n')
    else await assert.rejects(fs.readFile(join(subject.root, 'new.txt')), { code: 'ENOENT' })
    await noStages(subject.root)
  }
})
for (const providerId of ['openai', 'openrouter']) for (const name of WORKSPACE_MUTATION_TOOL_NAMES) {
  test(`${providerId} Auto prepares exact trusted ${name} effects, hashes and changed text`, async t => {
    const subject = await fixture(t, { providerId, name, auto: true, ...(name === 'workspace_edit_text' ? { initial: 'header\nold\nfooter\n' } : {}) })
    const result = mutationResult(await subject.host.send(name === 'workspace_create_text' ? 'Create new.txt with ordinary project text' : 'Replace old with new in new.txt'))
    assert.equal(result.success, true); assert.equal(subject.requests.length, 1); assert.equal(subject.approvals.length, 0)
    const snapshot = subject.requests[0].snapshot, effect = snapshot.preparedAction.effects[0]
    assert.equal(routePreparedAction(snapshot).route, 'model-review'); assert.equal(effect.scope, 'workspace'); assert.equal(effect.kind, 'write')
    assert.deepEqual(effect.affectedData, snapshot.inputData); assert.equal(effect.affectedData.path, 'new.txt')
    assert.equal(snapshot.resourceRevisions[effect.resourceId], effect.affectedData.beforeRevision)
    assert.equal(effect.affectedData.afterRevision, workspaceRevision(await fs.readFile(join(subject.root, 'new.txt'))))
    if (name === 'workspace_edit_text') { assert.equal(effect.affectedData.before, 'old'); assert.equal(effect.affectedData.after, 'new') }
    else { assert.equal(effect.affectedData.before, null); assert.equal(effect.affectedData.after, 'ordinary project text\n') }
    assert.equal(snapshot.policyRevision, `${AUTO_REVIEW_POLICY_REVISION}-${providerId}`)
    assert.equal(snapshot.userRequest.approvedScope.reviewDataSharing.revision, AUTO_REVIEW_SHARING_REVISION)
    assert.deepEqual(snapshot.userRequest.approvedScope.reviewDataSharing.recipients, providerId === 'openai' ? ['OpenAI'] : ['OpenRouter', 'TypeSafe'])
    assert.deepEqual(subject.records.map(record => record.state), ['commit_started', 'committed'])
    assert.equal(subject.records.at(-1).toolName, name); assert.equal(subject.records.at(-1).resultRevision, result.revision)
    assert(!JSON.stringify(subject.records).includes('ordinary project text')); assert(!JSON.stringify(snapshot).includes(subject.root))
    await noStages(subject.root)
  })
}
test('a large file small-hunk edit stays Auto with exact limited evidence and no unchanged-file dump', async t => {
  const initial = 'unshared-context\n'.repeat(10000) + 'old\n'
  const subject = await fixture(t, { auto: true, name: 'workspace_edit_text', initial })
  const result = mutationResult(await subject.host.send('Replace old with new in new.txt'))
  assert.equal(result.success, true); assert.equal(subject.requests.length, 1)
  assert.equal(subject.requests[0].snapshot.inputData.before, 'old')
  assert(JSON.stringify(subject.requests[0]).length < 16000)
})
test('oversized exact decision evidence uses full Manual diff without any judge call or truncation', async t => {
  const content = 'a'.repeat(8000)
  const subject = await fixture(t, { auto: true, allow: true, arguments: { path: 'new.txt', content } })
  assert.equal(mutationResult(await subject.host.send('Create new.txt with the supplied text')).success, true)
  assert.equal(subject.requests.length, 0); assert.equal(subject.approvals.length, 1)
  assert(subject.approvals[0].description.includes(content)); assert(!subject.approvals[0].description.includes('truncated'))
  assert.equal(await fs.readFile(join(subject.root, 'new.txt'), 'utf8'), content)
})
test('sensitive changed text stays Manual and known credentials are withheld before human/model review', async t => {
  const sensitive = await fixture(t, { auto: true, arguments: { path: 'new.txt', content: 'My medication is aspirin' } })
  assert.equal(mutationResult(await sensitive.host.send('Create this text file')).success, false)
  assert.equal(sensitive.requests.length, 0); assert.equal(sensitive.approvals.length, 1)
  const known = await fixture(t, { auto: true, allow: true, arguments: { path: 'new.txt', content: 'ordinary fixture-secret text' } })
  known.secrets.push('fixture-secret')
  const result = await known.host.send('Create an ordinary text file')
  assert.equal(mutationResult(result).success, false); assert.equal(known.requests.length, 0); assert.equal(known.approvals.length, 0)
  assert(!JSON.stringify(mutationResult(result)).includes('fixture-secret'))
  assert(!(await fs.readFile(join(known.directory, 'state', `${known.host.session.id}.json`), 'utf8')).includes('fixture-secret'))
})
test('Auto rejection can be manually approved once for the exact diff', async t => {
  const subject = await fixture(t, { auto: true, probability: 0.01, allow: true })
  assert.equal(mutationResult(await subject.host.send('Create new.txt with ordinary project text')).success, true)
  assert.equal(subject.requests.length, 1); assert.equal(subject.approvals.length, 1)
  assert.match(subject.approvals[0].description, /AI recommends rejecting/)
  assert.equal(subject.records.at(-1).source, 'human-once'); await noStages(subject.root)
})
for (const cause of ['workspace', 'tools', 'account', 'provider', 'evaluator', 'ledger', 'surface']) {
  test(`actual host refuses stale ${cause} after review before file publication`, async t => {
    const subject = await fixture(t, { auto: true, onEvaluate({ options }) {
      if (cause === 'workspace') options.workspace = undefined
      if (cause === 'tools') options.enableTools = false
      if (cause === 'account') options.decisionReview.accountRevision = () => 'changed-account'
      if (cause === 'provider') options.decisionReview.provider = { ...options.decisionReview.provider }
      if (cause === 'evaluator') options.decisionReview.provider.evaluate = async () => { throw new Error('Do not evaluate') }
      if (cause === 'ledger') options.decisionReview.ledger = { async upsert() {} }
      if (cause === 'surface') options.decisionReview.isAvailable = () => false
    } })
    assert.equal(mutationResult(await subject.host.send('Create new.txt with ordinary project text')).success, false)
    await assert.rejects(fs.readFile(join(subject.root, 'new.txt')), { code: 'ENOENT' }); await noStages(subject.root)
    assert.equal(subject.approvals.length, 0)
  })
}
test('resource revision is re-read after human approval and stale content is never overwritten', async t => {
  let subject
  subject = await fixture(t, { allow: true, name: 'workspace_edit_text', initial: 'old', onHuman: () => fs.writeFile(join(subject.root, 'new.txt'), 'concurrent edit') })
  const result = mutationResult(await subject.host.send('Replace old with new in new.txt'))
  assert.equal(result.success, false); assert.equal(await fs.readFile(join(subject.root, 'new.txt'), 'utf8'), 'concurrent edit'); await noStages(subject.root)
})
test('actual final staging fsync rechecks enrollment, cancellation and newly registered credentials', async t => {
  for (const cause of ['account', 'cancel', 'secret']) {
    const subject = await fixture(t, { auto: true })
    const open = fs.open
    t.mock.method(fs, 'open', async (path, ...args) => {
      const handle = await open(path, ...args)
      if (basename(String(path)).startsWith('.vivi-stage-')) {
        const sync = handle.sync.bind(handle)
        handle.sync = async () => {
          await sync()
          if (cause === 'account') subject.options.decisionReview.accountRevision = () => 'changed-account'
          if (cause === 'cancel') subject.host.cancel()
          if (cause === 'secret') subject.secrets.push('ordinary project text')
        }
      }
      return handle
    })
    await subject.host.send('Create new.txt with ordinary project text')
    await subject.workspace.drainMutations()
    await assert.rejects(fs.readFile(join(subject.root, 'new.txt')), { code: 'ENOENT' }); await noStages(subject.root)
    assert(!subject.records.some(record => record.state === 'committed'))
    t.mock.restoreAll()
  }
})
test('saved-but-unconfirmed publication returns success with warning, audit revision, and suspends Auto', { skip: process.platform !== 'linux' }, async t => {
  const subject = await fixture(t, { auto: true }), open = fs.open
  t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await open(path, ...args)
    if (String(path) === subject.root) handle.sync = async () => { throw new Error('directory sync unavailable') }
    return handle
  })
  const result = mutationResult(await subject.host.send('Create new.txt with ordinary project text'))
  assert.equal(result.success, true); assert.equal(result.durabilityUnconfirmed, true)
  assert.equal(subject.records.at(-1).state, 'committed'); assert.equal(subject.records.at(-1).resultRevision, result.revision)
  assert.equal(await fs.readFile(join(subject.root, 'new.txt'), 'utf8'), 'ordinary project text\n'); await noStages(subject.root)
  assert.throws(() => subject.host.setApprovalMode('auto'), /healthy review ledger/)
})
test('no workspace, chat-only models and resumed unselected sessions have no mutation capability', async t => {
  for (const cause of ['workspace', 'tools']) {
    const subject = await fixture(t, { inspectTools(tools) { assert(!tools.some(tool => WORKSPACE_MUTATION_TOOL_NAMES.includes(tool.name))) } })
    if (cause === 'workspace') subject.options.workspace = undefined
    else subject.options.enableTools = false
    assert.equal(mutationResult(await subject.host.send('Create a file')).success, false)
    assert.equal(subject.approvals.length, 0); assert.equal(subject.requests.length, 0); assert.deepEqual(await fs.readdir(subject.root), [])
  }
})
test('headless TerminalIO cannot approve a text write or enroll expanded Auto', async t => {
  const input = new PassThrough(), output = new PassThrough(), io = new TerminalIO({ input, output, tui: false })
  t.after(() => io.close())
  const subject = await fixture(t); subject.options.approve = (request, signal) => io.approve(request, signal)
  // Controller captures its human callback at construction; use a fresh host.
  const host = new CliHost(subject.options)
  input.write('allow\n')
  assert.equal(mutationResult(await host.send('Create new.txt with ordinary project text')).success, false)
  await selectApprovalMode(host, io)
  assert.equal(host.approvalMode, 'manual'); assert.equal(io.canAutoReview, false); assert.deepEqual(await fs.readdir(subject.root), [])
})
test('expanded fresh enrollment discloses paths, exact before/after data, named recipients and extra charges in two short sentences', () => {
  for (const provider of ['openai', 'openrouter']) {
    const disclosure = autoReviewDisclosure(provider), sharing = autoReviewSharingScope(provider)
    assert.equal(disclosure.split('. ').length, 2); assert(disclosure.length < 400)
    assert.match(disclosure, /workspace text creation\/precise edits/); assert.match(disclosure, /paths, before and after/)
    assert.match(disclosure, /private information/); assert.match(disclosure, /extra API charges/)
    assert.equal(sharing.revision, 'vivi-cli-review-sharing-v3'); assert.equal(AUTO_REVIEW_POLICY_REVISION, 'vivi-cli-auto-v4')
    assert(sharing.data.some(item => item.includes('workspace-relative')))
  }
})
test('closed decision ledger accepts metadata-only records for both new mutation tools', async t => {
  const subject = await fixture(t, { auto: true })
  await subject.host.send('Create new.txt with ordinary project text')
  const ledger = new FileDecisionLedger(join(subject.directory, 'audit'))
  for (const toolName of WORKSPACE_MUTATION_TOOL_NAMES) {
    const original = subject.records.at(-1)
    await ledger.upsert({ ...original, id: crypto.randomUUID(), toolName })
  }
  const raw = await fs.readFile(join(subject.directory, 'audit', 'decision-ledger.json'), 'utf8')
  assert(raw.includes('workspace_create_text')); assert(raw.includes('workspace_edit_text')); assert(!raw.includes('ordinary project text'))
})

test('source arguments cannot redirect the core-frozen captured proposal during review', async t => {
  let subject
  subject = await fixture(t, { auto: true, onEvaluate({ request }) {
    subject.arguments_.content = 'source changed after capture'
    assert(Object.isFrozen(request.snapshot.toolCall.arguments))
    assert.throws(() => { request.snapshot.toolCall.arguments.content = 'provider attempted redirect' }, TypeError)
  } })
  assert.equal(mutationResult(await subject.host.send('Create new.txt with ordinary project text')).success, true)
  assert.equal(await fs.readFile(join(subject.root, 'new.txt'), 'utf8'), 'ordinary project text\n')
})


test('Manual saved-but-unconfirmed outcome also prevents later Auto enrollment', { skip: process.platform !== 'linux' }, async t => {
  const subject = await fixture(t, { allow: true }), open = fs.open
  t.mock.method(fs, 'open', async (path, ...args) => {
    const handle = await open(path, ...args)
    if (String(path) === subject.root) handle.sync = async () => { throw new Error('directory sync unavailable') }
    return handle
  })
  const result = mutationResult(await subject.host.send('Create new.txt with ordinary project text'))
  assert.equal(result.success, true); assert.equal(result.durabilityUnconfirmed, true)
  assert.throws(() => subject.host.setApprovalMode('auto'), /healthy review ledger/)
  await noStages(subject.root)
})
