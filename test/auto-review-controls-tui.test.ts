// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test'
import { BoxRenderable, CliRenderEvents, SelectRenderable, TextRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import type { TestRendererSetup } from '@opentui/core/testing'
import type { Renderable } from '@opentui/core'
import type { CliHost } from '../src/host.js'
import type { ApprovalMode } from '../src/auto-review.js'
import type { ChatIO } from '../src/terminal.js'
import { selectApprovalMode } from '../src/terminal.js'
import { OpenTuiIO } from '../src/tui.js'
import { newSession } from '../src/session.js'

const fixtures: OpenTuiIO[] = []
afterEach(async () => { for (const io of fixtures.splice(0)) io.close(); await Promise.resolve() })
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 3))
function text(node: Renderable): string {
  return [node instanceof TextRenderable ? node.plainText : '',
    node instanceof BoxRenderable ? `${node.title ?? ''}` : '',
    node instanceof SelectRenderable ? JSON.stringify(node.options) : '',
    ...node.getChildren().map(text)].join('\n')
}
async function fixture() {
  const setup: TestRendererSetup = await createTestRenderer({ width: 120, height: 40,
    kittyKeyboard: true, exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  fixtures.push(io)
  const session = newSession({ provider: 'openai', model: 'offline-chat' })
  io.setSession(session)
  let mode: ApprovalMode = 'manual'
  const host = { get session() { return session }, get approvalMode() { return mode },
    setApprovalMode(value: ApprovalMode) { mode = value } } as unknown as CliHost
  // The test renderer is deliberately headless. Only this injected test surface
  // declares interactive capability; no provider, account or key is involved.
  const enrollmentIO: ChatIO = { canAutoReview: true,
    get isClosed() { return io.isClosed }, write: value => io.write(value),
    setApprovalMode: value => io.setApprovalMode(value),
    readLine: (...args) => io.readLine(...args), event: value => io.event(value), result: value => io.result(value),
    approve: (...args) => io.approve(...args), onCancel: value => io.onCancel(value), close: () => io.close() }
  const frame = async (): Promise<string> => { await setup.renderOnce(); await setup.renderOnce(); return setup.captureCharFrame() }
  const enroll = (): Promise<void> => selectApprovalMode(host, enrollmentIO,
    (title, choices, initialIndex) => io.choose(title, choices, initialIndex))
  const selectAuto = async (): Promise<void> => {
    await frame()
    setup.mockInput.pressArrow('down'); setup.mockInput.pressEnter()
    await tick(); await frame()
    expect(text(setup.renderer.root)).toContain('Enable Auto review?')
    // Selection continuations can open the confirmation during a render. Complete
    // another input-drain tick and native frame before sending a fresh gesture.
    await tick(); await frame()
  }
  return { io, setup, host, enrollmentIO, frame, enroll, selectAuto, input: setup.mockInput }
}

test('native mode picker defaults Manual, shows selected-account disclosure, and Manual requires no enrollment', async () => {
  const f = await fixture(), selecting = f.enroll()
  await f.frame()
  const picker = f.setup.renderer.root.findDescendantById('vivi-picker') as SelectRenderable
  expect(picker.getSelectedIndex()).toBe(0)
  expect(picker.options.map(option => option.name)).toEqual(['Manual', 'Auto review'])
  const contents = text(f.setup.renderer.root)
  expect(contents).toContain('Check proposed note, memory, workspace text and public URL GET actions through your selected provider')
  expect(contents).not.toContain('Auto sends your current request')
  f.input.pressEnter()
  await selecting
  expect(f.host.approvalMode).toBe('manual')
  expect(text(f.setup.renderer.root)).not.toContain('enroll_auto_review')
})

test('Auto picker selection cannot enroll before a fresh completed approval frame, and paste keeps deny selected', async () => {
  const f = await fixture(), selecting = f.enroll()
  await f.frame()
  f.input.pressArrow('down'); f.input.pressEnter()
  await Promise.resolve(); await Promise.resolve()
  // The picker selection is not authority, nor is a queued/repeated confirmation.
  f.input.pressArrow('right'); f.input.pressEnter()
  await tick()
  expect(f.host.approvalMode).toBe('manual')
  f.setup.renderer.keyInput.emit('keypress', {
    name: 'return', sequence: '\r', repeated: true, eventType: 'repeat', ctrl: false, meta: false,
    shift: false, super: false, hyper: false, preventDefault() {}, stopPropagation() {}
  })
  expect(f.host.approvalMode).toBe('manual')
  await f.frame()
  expect(text(f.setup.renderer.root)).toContain('Enable Auto review?')
  expect(text(f.setup.renderer.root)).toContain('to OpenAI for approval checks')
  expect(text(f.setup.renderer.root)).toContain('including changes you didn’t request')
  expect(text(f.setup.renderer.root)).toContain('extra API charges')
  expect(text(f.setup.renderer.root)).toContain('full URL including path/query')
  expect(text(f.setup.renderer.root)).toContain('network limits and redirect scope')
  expect(text(f.setup.renderer.root)).toContain('GET may have server-side effects or costs')
  expect(text(f.setup.renderer.root)).toContain('Cancel is the default')
  expect(await f.frame()).toContain('› Cancel')
  await f.input.pasteBracketedText('allow')
  await f.frame()
  expect(f.host.approvalMode).toBe('manual')
  f.input.pressEnter()
  await selecting
  expect(f.host.approvalMode).toBe('manual')
})

test('only a fresh explicit native Approve enrolls Auto, while reopening mode and closing revokes it', async () => {
  const f = await fixture(), selecting = f.enroll()
  await f.selectAuto()
  f.input.pressTab()
  expect(await f.frame()).toContain('› Enable Auto')
  f.input.pressEnter()
  await selecting
  expect(f.host.approvalMode).toBe('auto')
  expect(await f.frame()).toContain('Auto review')
  const next = f.enroll()
  expect(f.host.approvalMode).toBe('manual')
  await f.selectAuto()
  f.io.close()
  await next
  expect(f.host.approvalMode).toBe('manual')
})

test('native enrollment Escape and cancellation leave Manual and no working timer', async () => {
  for (const cancel of ['escape', 'cancel'] as const) {
    const f = await fixture(), selecting = f.enroll()
    await f.selectAuto()
    if (cancel === 'escape') f.input.pressEscape()
    else f.setup.renderer.keyInput.emit('keypress', {
      name: 'c', sequence: '\x03', ctrl: true, meta: false, shift: false, super: false, hyper: false,
      preventDefault() {}, stopPropagation() {}
    })
    await selecting
    expect(f.host.approvalMode).toBe('manual')
    expect(text(f.setup.renderer.root)).not.toContain('Working ·')
  }
})

test('a real native surface reports Auto unavailable after close, renderer failure or destruction', async () => {
  for (const state of ['close', 'failure', 'destroy'] as const) {
    const f = await fixture()
    expect(f.io.canAutoReview).toBe(Boolean(process.stdin.isTTY && process.stdout.isTTY))
    if (state === 'close') f.io.close()
    else if (state === 'failure') f.setup.renderer.emit(CliRenderEvents.RENDER_ERROR, { error: new Error('Offline failure') })
    else f.setup.renderer.destroy()
    expect(f.io.canAutoReview).toBe(false)
  }
})

test('review progress settles and separate audit warnings stay safe beside their completed turn', async () => {
  const f = await fixture()
  const session = f.host.session
  const context = { sessionId: session.id, runId: 'offline-review-run', callId: 'review-note', toolName: 'note_set', state: 'reviewing' as const }
  f.io.runStarted()
  f.io.reviewNotice('Reviewing note_set with gpt-6-luna (up to 8s)…', context)
  f.io.reviewNotice('Committed, but audit unavailable: offline-private-key\x1b[31m')
  f.io.reviewNotice('Approved by you; change saved', { ...context, state: 'saved', source: 'human' })
  f.io.addSecrets(['offline-private-key'])
  f.io.runFinished('completed')
  session.history = [{ kind: 'message', role: 'user', content: 'Set note tone to concise' },
    { kind: 'assistant', content: '', toolCalls: [{ id: 'review-note', name: 'note_set', arguments: {} }] },
    { kind: 'tool_result', callId: 'review-note', name: 'note_set', content: 'Done' },
    { kind: 'assistant', content: 'Done', toolCalls: [] }]
  f.io.result({ status: 'completed', content: 'Done', rounds: 1,
    history: session.history,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })
  f.io.setSession(session)
  const contents = text(f.setup.renderer.root)
  expect(contents).not.toContain('Reviewing note_set with gpt-6-luna')
  expect(contents).toContain('Approved by you; change saved')
  expect(contents).toContain('Committed, but audit unavailable: [REDACTED]')
  expect(contents).not.toContain('offline-private-key')
  expect(contents).not.toContain('\x1b')
  f.io.runStarted()
  expect(text(f.setup.renderer.root)).toContain('audit unavailable')
  expect(text(f.setup.renderer.root)).not.toContain('Reviewing note_set')
  f.io.runFinished('cancelled')
  f.io.setSession(newSession({ provider: 'openai', model: 'offline-chat' }))
  expect(text(f.setup.renderer.root)).not.toContain('audit unavailable')
})

test('native workspace diff is shown exactly with terminal controls escaped and deny selected', async () => {
  const f = await fixture(), abort = new AbortController()
  const diff = '--- "file.txt"\n+++ "file.txt"\n@@ -1,1 +1,1 @@ (JSON-quoted lines)\n-"old\\r\\n"\n+"new\\u001b[31m\\r\\n"'
  const pending = f.io.approve({ call: { id: 'workspace-diff', name: 'workspace_edit_text', arguments: {} },
    currentRevision: 'a'.repeat(64), description: `Precisely edit workspace text file "file.txt".\n${diff}` }, abort.signal)
  await tick(); await f.frame()
  const contents = text(f.setup.renderer.root)
  expect(contents).toContain(diff)
  expect(contents).not.toContain('[display truncated]')
  expect(await f.frame()).toContain('› Deny')
  await f.input.pasteBracketedText('allow')
  await tick(); await f.frame()
  f.input.pressEnter()
  expect(await pending).toBe(false)
})

for (const toolName of ['mcp_docs_offline_alias', 'list_mcp_resources', 'read_mcp_resource']) {
  for (const state of ['reviewing', 'needs_review', 'saving'] as const) {
    test(`interrupted ${toolName} ${state} uses remote-operation wording without claiming a save`, async () => {
      for (const outcome of ['cancelled', 'error', 'completed'] as const) {
        const f = await fixture()
        f.io.runStarted()
        f.io.reviewNotice('Offline MCP review in progress', { sessionId: f.host.session.id,
          runId: 'offline-mcp-review', callId: 'offline-mcp-call', toolName, state })
        f.io.runFinished(outcome)
        await f.frame()
        const contents = text(f.setup.renderer.root)
        expect(contents).not.toContain('Offline MCP review in progress')
        expect(contents).not.toContain('save was made')
        expect(contents).not.toContain('confirmed save')
        expect(contents).not.toContain('change saved')
        expect(contents).not.toContain('The write outcome')
        if (state === 'saving') {
          expect(contents).toContain('The MCP operation outcome could not be confirmed')
          expect(contents).toContain('check the remote service before retrying')
        } else if (outcome === 'cancelled') expect(contents).toContain('Review cancelled; no MCP operation was started')
        else expect(contents).toContain('Review ended before an MCP operation was started')
      }
    })
  }
}

for (const state of ['reviewing', 'needs_review', 'saving'] as const) {
  test(`interrupted public URL ${state} uses request/result wording without claiming retrieval`, async () => {
    for (const outcome of ['cancelled', 'error', 'completed'] as const) {
      const f = await fixture()
      f.io.runStarted()
      f.io.reviewNotice('Offline URL review in progress', { sessionId: f.host.session.id,
        runId: 'offline-url-review', callId: 'offline-url-call', toolName: 'fetch_url', state })
      f.io.runFinished(outcome)
      await f.frame()
      const contents = text(f.setup.renderer.root)
      expect(contents).not.toContain('Offline URL review in progress')
      for (const unsupported of ['save was made', 'confirmed save', 'change saved', 'The write outcome', 'successfully fetched']) {
        expect(contents).not.toContain(unsupported)
      }
      if (state === 'saving') {
        expect(contents).toContain('Public URL admission could not be confirmed')
        expect(contents).toContain('no fetch result was confirmed')
      } else if (outcome === 'cancelled') expect(contents).toContain('Review cancelled; this public URL request was not approved')
      else expect(contents).toContain('Review ended before this public URL request was approved')
    }
  })
}


test('native public URL approval displays the exact GET destination and defaults to deny', async () => {
  const f = await fixture()
  const pending = f.io.approve({ call: { id: 'public-url-approval', name: 'fetch_url',
    arguments: { url: 'https://example.com/docs?topic=color' } }, currentRevision: 'opaque-url-revision',
    description: 'Fetch public page with GET: https://example.com/docs?topic=color\nDestination hostname: example.com\nFull URL/path/query and caller IP are transmitted; GET may have server-side effects' }, new AbortController().signal)
  const contents = await f.frame()
  expect(contents).toContain('Review this public URL request (default: deny)')
  expect(contents).toContain('https://example.com/docs?topic=color')
  expect(contents).toContain('› Deny')
  expect(contents).not.toContain('Review this change')
  await f.input.pasteBracketedText('allow')
  await tick(); await f.frame()
  f.input.pressEnter()
  expect(await pending).toBe(false)
})
