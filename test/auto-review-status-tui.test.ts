// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TextRenderable, BoxRenderable } from '@opentui/core'
import type { Renderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import type { HistoryMessage } from '@ayayaq/vivi'
import { main } from '../src/main.js'
import { OpenTuiIO } from '../src/tui.js'
import { newSession } from '../src/session.js'
import { FileMemoryStore } from '../src/memory.js'
import { FileDecisionLedger } from '../src/decision-ledger.js'
import type { ApprovalRequest } from '../src/tools.js'
import type { ReviewNotice } from '../src/auto-review.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 3))
function contents(node: Renderable): string {
  return [node instanceof TextRenderable ? node.plainText : '',
    node instanceof BoxRenderable ? `${node.title ?? ''}` : '', ...node.getChildren().map(contents)].join('\n')
}
async function fixture() {
  const setup = await createTestRenderer({ width: 120, height: 40, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  cleanups.push(async () => { io.close(); await Promise.resolve() })
  const frame = async (): Promise<string> => { await tick(); await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const transcript = (): string => contents(setup.renderer.root.findDescendantById('vivi-transcript')!)
  return { io, setup, frame, transcript, input: setup.mockInput }
}

type Phase = { kind: 'choice'; names: string[] } | { kind: 'approval'; request: ApprovalRequest }
  | { kind: 'composer' } | { kind: 'fetch'; finish(response: Response): void; body: Record<string, unknown> }
async function application(callCount = 1, preliminaryTools = false) {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), 'vivi-review-status-'))
  const phases: Phase[] = []
  let wake: ((phase: Phase) => void) | undefined
  const announce = (phase: Phase): void => { if (wake) { const done = wake; wake = undefined; done(phase) } else phases.push(phase) }
  const next = (): Promise<Phase> => phases.length ? Promise.resolve(phases.shift()!) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { wake = undefined; reject(new Error('Expected application phase did not arrive')) }, 5000)
    wake = phase => { clearTimeout(timer); resolve(phase) }
  })
  // Only this offline test surface declares interactive capability. Approval is
  // still performed by native widgets; chat and HTTP replies are the only mocks.
  Object.defineProperty(f.io, 'canAutoReview', { get: () => !f.io.isClosed })
  const choose = f.io.choose.bind(f.io), approve = f.io.approve.bind(f.io), readLine = f.io.readLine.bind(f.io)
  f.io.choose = (title, choices, initial) => { const reply = choose(title, choices, initial); announce({ kind: 'choice', names: choices.map(choice => choice.name) }); return reply }
  f.io.approve = (request, signal) => { const reply = approve(request, signal); announce({ kind: 'approval', request }); return reply }
  f.io.readLine = (title, signal) => { const reply = readLine(title, signal); announce({ kind: 'composer' }); return reply }
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions')
    return await new Promise<Response>(finish => announce({ kind: 'fetch', finish, body: JSON.parse(init!.body as string) }))
  })
  let preliminaryPending = preliminaryTools, awaitingResult = false, turn = 0
  const running = main(['--no-workspace', '--provider', 'openrouter', '--model', 'deepseek/deepseek-v4.1-flash',
    '--tools', '--enable-memory', '--approval-mode', 'auto', '--session-dir', directory], { OPENROUTER_API_KEY: 'offline-test-key' }, {
    tuiIO: f.io,
    credentials: { async status() { return { available: false, label: 'Offline vault' } }, async load() {} },
    catalog: { async list() { return { state: 'fresh', models: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'Offline chat',
      conversation: 'supported', tools: 'supported', reasoning: 'unknown', efforts: [] }] } } },
    providerFactory: () => ({ async generate() {
      if (preliminaryPending) { preliminaryPending = false; return { content: 'Checking existing memories first.', toolCalls: [
        { id: 'listing', name: 'list_memories', arguments: {} }, { id: 'clock', name: 'current_time', arguments: {} }] } }
      if (!awaitingResult) { awaitingResult = true; return { content: '', toolCalls: Array.from({ length: callCount }, (_, index) =>
        ({ id: `memory-${turn}-${index}`, name: 'create_memory', arguments: { content: `On Thursdays, remind me to eat healthy ${turn}-${index}.` } })) } }
      awaitingResult = false; return { content: `Turn finished ${++turn}`, toolCalls: [] }
    } })
  })
  cleanups.push(async () => { f.io.close(); await running; fetch.mockRestore(); await rm(directory, { recursive: true, force: true }) })
  const mode = await next(); expect(mode.kind).toBe('choice')
  await f.frame(); f.input.pressArrow('down'); f.input.pressEnter()
  const enrollment = await next(); expect(enrollment.kind).toBe('approval')
  if (enrollment.kind === 'approval') expect(enrollment.request.call.name).toBe('enroll_auto_review')
  await f.frame(); f.input.pressArrow('right'); f.input.pressEnter()
  expect((await next()).kind).toBe('composer')
  const send = async (message: string): Promise<void> => { await f.frame(); await f.input.typeText(message); f.input.pressEnter() }
  const response = async (status: number, exact = 1): Promise<void> => {
    const phase = await next(); expect(phase.kind).toBe('fetch')
    if (phase.kind !== 'fetch') throw new Error('Expected review fetch')
    expect(f.transcript()).toContain('Reviewing create_memory')
    const questions = phase.body.questions as Record<string, unknown>
    phase.finish(status === 200 ? new Response(JSON.stringify({ model: 'typesafe/jev-1.13',
      answers: Object.fromEntries(Object.keys(questions).map(name => [name, { type: 'noul', noul: name === 'exact_action_requested' ? exact : 1 }])),
      usage: { input_tokens: 10, output_tokens: 4, cost: 0 } }), { headers: { 'content-type': 'application/json' } })
      : new Response('private-provider-error-body', { status }))
  }
  const review = async (action: 'approve' | 'deny' | 'cancel'): Promise<ApprovalRequest> => {
    const phase = await next(); expect(phase.kind).toBe('approval')
    if (phase.kind !== 'approval') throw new Error('Expected native review')
    await f.frame()
    expect(f.transcript()).not.toContain('Reviewing create_memory')
    if (action === 'approve') f.input.pressArrow('right')
    if (action === 'cancel') f.input.pressEscape()
    else f.input.pressEnter()
    return phase.request
  }
  const settled = async (): Promise<void> => { expect((await next()).kind).toBe('composer'); await f.frame() }
  return { ...f, directory, next, send, response, review, settled, fetch }
}

for (const action of ['approve', 'deny', 'cancel'] as const) test(`actual app HTTP failure and native ${action} replace progress in chronological history`, async () => {
  const f = await application()
  await f.send('Make a memory that on Tuesdays we start every sentence with howdy.')
  await f.response(403)
  expect((await f.review(action)).description).toContain('HTTP 403')
  await f.settled()
  const text = f.transcript()
  expect(text).not.toContain('Reviewing create_memory')
  expect(text).not.toContain('Needs your review')
  expect(text).not.toContain('private-provider-error-body')
  expect(text).not.toContain('Automatically approved')
  expect(text.match(/Review · create_memory/g)?.length).toBe(1)
  const final = action === 'approve' ? 'Approved by you; change saved' : action === 'deny' ? 'Denied by you; no save was made' : 'Review cancelled; no save was made'
  expect(text).toContain(final)
  expect(text.indexOf(final)).toBeLessThan(text.indexOf('Tool create_memory'))
  if (action !== 'cancel') expect(text.indexOf(final)).toBeLessThan(text.lastIndexOf('Assistant'))
  expect((await new FileMemoryStore(f.directory).list()).memories.length).toBe(action === 'approve' ? 1 : 0)
  const records = await new FileDecisionLedger(f.directory).list()
  expect(records.at(-1)?.state).toBe(action === 'approve' ? 'committed' : action === 'deny' ? 'denied' : 'cancelled')
  for (const [width, height] of [[40, 20], [80, 24], [120, 40]] as const) {
    f.setup.resize(width, height); await f.frame()
    const composer = f.setup.renderer.root.findDescendantById('vivi-composer-box')!
    expect(composer.y + composer.height).toBeLessThanOrEqual(height)
    expect(f.transcript()).not.toContain('Reviewing create_memory')
  }
})

test('actual app uncertain estimate stays concise beside the exact tool after unrelated earlier tools', async () => {
  const f = await application(1, true)
  await f.send('Make a memory that on Thursdays you remind me to eat healthy.')
  await f.response(200, 0.99899999)
  expect((await f.review('approve')).description).toContain('request match model estimate 99.8999% is below the 99.9% cutoff')
  await f.settled()
  const text = f.transcript()
  expect(text).toContain('Approved by you; change saved')
  expect(text).toContain('request match model estimate 99.8999% is below the 99.9% cutoff')
  expect(text).not.toContain('Reviewing create_memory')
  expect(text).not.toContain('Needs your review')
  expect(text.match(/Review · /g)?.length).toBe(1)
  expect(text.indexOf('Review · create_memory')).toBeGreaterThan(text.indexOf('Tool current_time'))
  expect(text.indexOf('Review · create_memory')).toBeLessThan(text.indexOf('Tool create_memory'))
})

test('actual app retains two distinct call outcomes across repeated turns', async () => {
  const f = await application(2)
  for (let turn = 0; turn < 2; turn++) {
    await f.send('Make two memories about ordinary preferences.')
    await f.response(200)
    await f.response(403)
    await f.review('approve')
    await f.settled()
    const text = f.transcript()
    expect(text.match(/Review · create_memory/g)?.length).toBe((turn + 1) * 2)
    expect(text.match(/Automatically approved by typesafe\/jev-1.13; change saved/g)?.length).toBe(turn + 1)
    expect(text.match(/Approved by you; change saved/g)?.length).toBe(turn + 1)
    expect(text).not.toContain('Reviewing create_memory')
    expect(text).not.toContain('Needs your review')
  }
  expect((await new FileMemoryStore(f.directory).list()).memories.length).toBe(4)
  expect(f.fetch).toHaveBeenCalledTimes(4)
})

function history(callId: string, prompt = 'Set a note'): HistoryMessage[] {
  return [{ kind: 'message', role: 'user', content: prompt },
    { kind: 'assistant', content: '', toolCalls: [{ id: callId, name: 'note_set', arguments: {} }] },
    { kind: 'tool_result', callId, name: 'note_set', content: 'Saved' },
    { kind: 'assistant', content: 'Done', toolCalls: [] }]
}
test('canonical refresh, reused call IDs, late events and resumed sessions never replace another run or infer approval', async () => {
  const f = await fixture(), session = newSession({ provider: 'openai', model: 'offline' })
  f.io.setSession(session)
  const first: ReviewNotice = { sessionId: session.id, runId: 'first', callId: 'same-id', toolName: 'note_set', state: 'reviewing' }
  f.io.runStarted(); f.io.reviewNotice('Reviewing note_set', first)
  f.io.reviewNotice('Approved by you; change saved', { ...first, state: 'saved', source: 'human' })
  session.history = history('same-id'); f.io.runFinished('completed'); f.io.setSession(session)
  f.io.runStarted()
  const second: ReviewNotice = { ...first, runId: 'second' }
  f.io.reviewNotice('Reviewing note_set', second)
  f.io.reviewNotice('Automatically approved; change saved', { ...second, state: 'saved', source: 'automatic' })
  session.history.push(...history('same-id', 'Set another note')); f.io.runFinished('completed'); f.io.setSession(session)
  f.io.reviewNotice('stale progress', first)
  expect(f.transcript()).not.toContain('stale progress')
  expect(f.transcript().match(/Review · note_set/g)?.length).toBe(2)
  expect(f.transcript().indexOf('Approved by you')).toBeLessThan(f.transcript().indexOf('Automatically approved'))
  const resumed = await fixture(); resumed.io.setSession(session)
  expect(resumed.transcript()).not.toContain('Review ·')
  expect(resumed.transcript()).not.toContain('Automatically approved')
  f.io.setSession(newSession({ provider: 'openai', model: 'offline' }))
  f.io.reviewNotice('wrong session', { ...first, state: 'needs_review' })
  expect(f.transcript()).not.toContain('Review ·')
  expect(f.transcript()).not.toContain('wrong session')
})
