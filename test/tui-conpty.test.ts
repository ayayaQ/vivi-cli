// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test'
import { TextareaRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import { createWindowsInputBridge } from '../src/windows-input.js'
import { conptyFixture } from './helpers/conpty-fixture.mjs'

async function fixture() {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer), conpty = conptyFixture(createWindowsInputBridge)
  conpty.bridge.stdin.on('data', (chunk: Buffer) => setup.renderer.stdin.emit('data', chunk))
  Object.assign(io, { windowsInput: conpty.bridge })
  conpty.bridge.stdin.setRawMode(true); conpty.bridge.start()
  await new Promise(resolve => setImmediate(resolve))
  const frame = async () => { await setup.renderOnce(); await setup.renderOnce() }
  return { setup, io, conpty, frame, close: () => { try { io.close() } finally { conpty.close() } } }
}

test('native diagnostic corrects the reported outer-enabled/inner-disabled ConPTY topology', async () => {
  const f = await fixture()
  try {
    const pending = f.io.diagnoseInput(); await f.frame()
    f.conpty.tap(13, 13); f.conpty.tap(13, 13, 16); f.conpty.tap(74, 10, 8)
    f.conpty.key(27, 27) // Key-down closes the UI before its release reaches the shell.
    const report = await pending
    expect(report.windows?.modeReply).toBe(1)
    expect(report.windows?.enableRequested).toBe(true)
    expect(report.windows?.enterRecordsObserved).toBe(4)
    expect(report.probes.map(probe => [probe.key, probe.shift, probe.ctrl])).toEqual([
      ['enter', false, false], ['enter', true, false], ['ctrl-j', false, true]
    ])
    expect(report.failed).toBe(false)
    expect(f.conpty.state).toEqual({ innerRecords: false, outerRecords: true })
    expect(f.conpty.source.isRaw).toBe(false)
  } finally { f.close() }
})

test('ConPTY Shift+Enter edits without submission and multiline paste stays opaque before fresh Enter', async () => {
  const f = await fixture()
  try {
    const reading = f.io.readLine('Message'); let submitted = false
    void reading.then(() => { submitted = true })
    await f.frame(); await f.setup.mockInput.typeText('first')
    f.conpty.tap(13, 13, 16)
    await f.frame()
    expect(submitted).toBe(false)
    const composer = f.setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
    expect(composer.plainText).toBe('first\n')
    f.conpty.paste('second\r\nthird\rfourth'); await f.frame()
    expect(submitted).toBe(false)
    expect(composer.plainText).toBe('first\nsecond\nthird\nfourth')
    f.conpty.tap(13, 13)
    expect(await reading).toBe('first\nsecond\nthird\nfourth')
  } finally { f.close() }
})

test('ConPTY delayed paste-start prefixes preserve lines while native Escape still cancels normally', async () => {
  const f = await fixture()
  try {
    const reading = f.io.readLine('Message'); await f.frame()
    f.conpty.source.write('\x1b'); await new Promise(resolve => setTimeout(resolve, 35))
    f.conpty.source.write('[200~one\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_two' +
      '\x1b[13;28;10;1;8;1_\x1b[13;28;10;0;8;1_three\x1b[201~')
    await f.frame()
    expect((f.setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable).plainText).toBe('one\ntwo\nthree')
    f.conpty.tap(13, 13)
    expect(await reading).toBe('one\ntwo\nthree')
    const editing = f.io.askText('Fixed test edit'); await f.frame()
    f.conpty.tap(27, 27)
    expect(await editing).toBeUndefined()
  } finally { f.close() }
})

test('ConPTY pasted native functional records cannot select or confirm approval', async () => {
  const f = await fixture()
  try {
    const approving = f.io.approve({ call: { id: 'fixture', name: 'memory_create', arguments: {} },
      currentRevision: 'new memory', description: 'Fixed test proposal' }, new AbortController().signal)
    let settled = false; void approving.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 2)); await f.frame()
    f.conpty.source.write('\x1b[200~\x1b[39;0;0;1;0;1_\x1b[13;0;13;1;0;1_\x1b[201~')
    await f.frame()
    expect(settled).toBe(false)
    f.conpty.tap(13, 13)
    expect(await approving).toBe(false)
  } finally { f.close() }
})

test('ConPTY native Unicode records cannot forge paste framing and approve a proposal', async () => {
  const f = await fixture()
  try {
    const approving = f.io.approve({ call: { id: 'fixture', name: 'memory_create', arguments: {} },
      currentRevision: 'new memory', description: 'Fixed test proposal' }, new AbortController().signal)
    let settled = false; void approving.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 2)); await f.frame()
    const attack = [...'\x1b[201~\x1b[C\r'].map(character => `\x1b[0;0;${character.charCodeAt(0)};1;0;1_`).join('')
    f.conpty.source.write('\x1b[200~' + attack + '\x1b[201~')
    await f.frame()
    expect(settled).toBe(false)
    const suffix = [...'[201~\x1b[C\r'].map(character => `\x1b[0;0;${character.charCodeAt(0)};1;0;1_`).join('')
    f.conpty.source.write('\x1b[200~\x1b' + suffix + '\x1b[201~'); await f.frame()
    expect(settled).toBe(false)
    f.conpty.tap(13, 13)
    expect(await approving).toBe(false)
  } finally { f.close() }
})

test('ConPTY multiline secret paste remains rejected without rendering or submitting it', async () => {
  const f = await fixture()
  try {
    const reading = f.io.askSecret('Fixed test secret'); let submitted = false
    void reading.then(() => { submitted = true })
    await f.frame()
    f.conpty.paste('fixture-secret\r\nsecond'); await f.frame()
    expect(submitted).toBe(false)
    f.conpty.source.write('\x1b[200~fixture-secret\x1b[0;0;27;1;0;1_\x1b[201~'); await f.frame()
    expect(submitted).toBe(false)
    f.conpty.source.write('\x1b[200~fixture-secret\x1b[32;0;0;1;8;1_\x1b[201~'); await f.frame()
    expect(submitted).toBe(false)
    expect((f.setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable).plainText).toBe('')
    expect(f.setup.captureCharFrame()).not.toContain('fixture-secret')
    f.conpty.tap(13, 13)
    expect(await reading).toBe('')
  } finally { f.close() }
})

test('ConPTY held Enter cannot confirm a subsequent approval after inner reporting is enabled', async () => {
  const f = await fixture()
  try {
    const reading = f.io.readLine('Message'); await f.frame()
    await f.setup.mockInput.typeText('first')
    f.conpty.key(13, 13); expect(await reading).toBe('first') // Held, with no release yet.
    const approving = f.io.approve({ call: { id: 'fixture', name: 'memory_create', arguments: {} },
      currentRevision: 'new memory', description: 'Fixed test proposal' }, new AbortController().signal)
    let settled = false; void approving.then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 2)); await f.frame()
    f.setup.mockInput.pressArrow('right')
    f.conpty.key(13, 13); await f.frame()
    expect(settled).toBe(false)
    f.conpty.key(13, 0, 0, 0); f.conpty.tap(13, 13)
    expect(await approving).toBe(true)
  } finally { f.close() }
})
