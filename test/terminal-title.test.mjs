// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTerminalTitleSink, formatTerminalTitle, TerminalTitleController } from '../dist/terminal-title.js'

test('short state comes first and idle has no prefix', () => {
  assert.equal(formatTerminalTitle('Fix login', 'input'), '[!] vivi · Fix login')
  assert.equal(formatTerminalTitle('Fix login', 'working'), '[~] vivi · Fix login')
  assert.equal(formatTerminalTitle('Fix login', 'idle'), 'vivi · Fix login')
})

test('title bounds preserve Unicode and exclude terminal controls, bidi, credentials and invalid surrogates', () => {
  const title = formatTerminalTitle('秘密 \x1b]2;injected\x07\n\u202e fake-credential \ud800 ' + '🙂中'.repeat(100), 'input', ['fake-credential'])
  assert(title.startsWith('[!] vivi · 秘密'))
  assert(!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800]/.test(title))
  assert(!title.includes('fake-credential'))
  assert(title.includes('[REDACTED]'))
  assert(title.endsWith('…'))
  assert(title.length < 180)
  assert.equal(formatTerminalTitle(' \x07 ', 'idle'), 'vivi · Untitled conversation')
  const combined = formatTerminalTitle('a' + '\u0301'.repeat(10000), 'working')
  assert.equal(combined, '[~] vivi · …')
})

test('controller suppresses duplicate lifecycle/timer/token updates and restores exactly once', () => {
  const titles = []; let restores = 0
  const title = new TerminalTitleController({ set(value) { titles.push(value) }, restore() { restores++ } })
  for (let i = 0; i < 20; i++) title.update('Fix login', 'working', [])
  title.update('Fix login', 'input', []); title.update('Fix login', 'idle', [])
  title.update('Different session', 'idle', [])
  title.close(); title.close(); title.update('Late callback', 'working', [])
  assert.deepEqual(titles, ['[~] vivi · Fix login', '[!] vivi · Fix login', 'vivi · Fix login', 'vivi · Different session'])
  assert.equal(restores, 1)
})

test('TTY sink preserves before the first title and restores once without a terminal query', () => {
  const emitted = [], sink = createTerminalTitleSink(value => emitted.push(value), { isTTY: true,
    write(value) { emitted.push(value); return true } }, 'xterm-256color')
  sink.set('vivi · A'); sink.set('[~] vivi · A'); sink.restore(); sink.restore(); sink.set('Late')
  assert.deepEqual(emitted, ['\x1b[22;0t', 'vivi · A', '[~] vivi · A', '\x1b[23;0t'])
  for (const isTTY of [false, undefined]) assert.equal(createTerminalTitleSink(() => { throw new Error('No writes') },
    { isTTY, write() { throw new Error('No writes') } }, 'xterm'), undefined)
  assert.equal(createTerminalTitleSink(() => {}, { isTTY: true, write() { throw new Error('No writes') } }, 'dumb'), undefined)
})

test('title sink failures remain isolated and still attempt restoration only once', () => {
  let sets = 0, restores = 0
  const controller = new TerminalTitleController({ set() { sets++; throw new Error('Offline title failure') },
    restore() { restores++; throw new Error('Offline restore failure') } })
  assert.doesNotThrow(() => controller.update('A', 'working', []))
  assert.equal(restores, 0, 'title failure must retain restoration until native cleanup')
  controller.update('B', 'working', []); controller.close()
  assert.equal(sets, 1); assert.equal(restores, 1)
})
