// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWindowsInputBridge } from '../dist/windows-input.js'
import { conptyFixture } from './helpers/conpty-fixture.mjs'
const tick = () => new Promise(resolve => setImmediate(resolve))

test('outer 9001 already-enabled reply must enable the separate inner application encoder', async () => {
  const f = conptyFixture(createWindowsInputBridge)
  try {
    assert.equal(f.state.outerRecords, true); assert.equal(f.state.innerRecords, false)
    f.bridge.stdin.setRawMode(true); f.bridge.start(); await tick()
    assert.equal(f.bridge.diagnostic.modeReply, 1)
    assert.equal(f.bridge.diagnostic.enableRequested, true)
    assert.equal(f.state.innerRecords, true)
    f.tap(13, 13); f.tap(13, 13, 16); f.tap(74, 10, 8)
    await tick()
    assert.equal(f.text(), '\x1b[13;1u\x1b[13;2u\x1b[106;5u')
    assert.equal(f.bridge.diagnostic.enterRecordsObserved, 4)
    f.bridge.close()
    assert.equal(f.state.innerRecords, false)
    assert.equal(f.state.outerRecords, true)
    assert.equal(f.source.isRaw, false); assert.equal(f.source.isPaused(), true)
    assert.deepEqual(f.writes, ['\x1b[?9001$p', '\x1b[?9001h', '\x1b[?9001l'])
  } finally { f.close() }
})

test('inner consumer reporting preserves opaque multiline paste, other replies and held-key metadata', async () => {
  const f = conptyFixture(createWindowsInputBridge)
  try {
    f.bridge.stdin.setRawMode(true); f.bridge.start(); await tick()
    const text = 'first\r\nsecond🙂'
    f.paste(text)
    f.source.write('\x1b[?25;2$y') // An unrelated capability reply remains untouched.
    f.key(13, 13, 16); f.key(13, 13, 16); f.key(13, 0, 16, 0)
    await tick()
    assert.equal(f.text(), `\x1b[200~${text}\x1b[201~\x1b[?25;2$y\x1b[13;2u\x1b[13;2:2u`)
    assert.equal(f.bridge.diagnostic.enterRecordsObserved, 4)
  } finally { f.close() }
})

test('unsupported outer mode stays legacy and a disposed query cannot acquire consumer reporting', async () => {
  const unsupported = conptyFixture(createWindowsInputBridge, 0)
  try {
    unsupported.bridge.stdin.setRawMode(true); unsupported.bridge.start(); await tick()
    unsupported.tap(13, 13, 16); await tick()
    assert.equal(unsupported.text(), '\r')
    assert.equal(unsupported.bridge.diagnostic.enableRequested, false)
    assert.equal(unsupported.bridge.diagnostic.enterRecordsObserved, 0)
    assert.deepEqual(unsupported.writes, ['\x1b[?9001$p'])
  } finally { unsupported.close() }
  const disposed = conptyFixture(createWindowsInputBridge)
  try {
    disposed.bridge.stdin.setRawMode(true); disposed.bridge.start(); disposed.bridge.close(); await tick()
    assert.equal(disposed.state.innerRecords, false)
    assert.deepEqual(disposed.writes, ['\x1b[?9001$p'])
  } finally { disposed.close() }
})

test('status-one acquisition failures reset consumer reporting and surface only a generic error', async () => {
  const f = conptyFixture(createWindowsInputBridge, 1, text => text === '\x1b[?9001h')
  try {
    f.bridge.stdin.setRawMode(true); f.bridge.start(); await tick()
    assert.equal(f.bridge.failure?.message, 'Windows console input failed')
    assert.equal(f.state.innerRecords, false); assert.equal(f.state.outerRecords, true)
    assert.equal(f.source.isRaw, false)
    assert.deepEqual(f.writes, ['\x1b[?9001$p', '\x1b[?9001h', '\x1b[?9001l'])
  } finally { f.close() }
})

test('status-one permanent reset failure is explicit after raw/input ownership cleanup', async () => {
  const f = conptyFixture(createWindowsInputBridge, 1, text => text === '\x1b[?9001l')
  try {
    f.bridge.stdin.setRawMode(true); f.bridge.start(); await tick()
    assert.throws(() => f.bridge.close(), { message: 'Windows console reporting restoration failed' })
    assert.equal(f.bridge.diagnostic.restorationFailed, true)
    assert.equal(f.source.isRaw, false); assert.equal(f.bridge.stdin.destroyed, true)
    assert.deepEqual(f.writes, ['\x1b[?9001$p', '\x1b[?9001h', '\x1b[?9001l', '\x1b[?9001l'])
  } finally { f.close() }
})
