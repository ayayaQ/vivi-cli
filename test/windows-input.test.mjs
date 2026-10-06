// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { createWindowsInputBridge, WindowsInputDecoder } from '../dist/windows-input.js'

const record = (vk, uc, state = 0, down = 1, repeat = 1) => `\x1b[${vk};0;${uc};${down};${state};${repeat}_`
const tap = (vk, uc, state = 0, down = 1, repeat = 1) => record(vk, uc, state, down, repeat) +
  (down ? record(vk, 0, state, 0) : '')
const nextTick = () => new Promise(resolve => setImmediate(resolve))

test('Windows records preserve Enter modifiers, keypad identity and all supported navigation keys', () => {
  const input = new WindowsInputDecoder()
  assert.equal(input.write(tap(13, 13)), '\x1b[13;1u')
  assert.equal(input.write(tap(13, 13, 16)), '\x1b[13;2u')
  assert.equal(input.write(tap(13, 13, 272)), '\x1b[57414;2u')
  assert.equal(input.write(tap(13, 13, 2)), '\x1b[13;3u')
  assert.equal(input.write(tap(13, 13, 8)), '\x1b[13;5u')
  for (const [vk, code] of [[8, 127], [9, 9], [27, 27], [33, 57354], [34, 57355],
    [35, 57357], [36, 57356], [37, 57350], [38, 57352], [39, 57351], [40, 57353], [45, 57348], [46, 57349]]) {
    assert.equal(input.write(tap(vk, 0, 16 | 8)), `\x1b[${code};6u`)
  }
  for (let vk = 112; vk <= 135; vk++) assert.equal(input.write(record(vk, 0)), `\x1b[${57364 + vk - 112};1u`)
})

test('typing, Ctrl shortcuts, AltGr and Unicode/IME records keep their translated text', () => {
  const input = new WindowsInputDecoder()
  assert.equal(input.write(record(65, 65, 16 | 128)), 'A')
  assert.equal(input.write(record(65, 97)), 'a')
  assert.equal(input.write(record(74, 10, 8)), '\x1b[106;5u')
  assert.equal(input.write(tap(189, 31, 8)), '\x1b[45;5u')
  assert.equal(input.write(tap(190, 30, 8)), '\x1b[46;5u')
  assert.equal(input.write(tap(189, 0, 8)), '\x1b[45;5u')
  assert.equal(input.write(tap(190, 0, 8)), '\x1b[46;5u')
  assert.equal(input.write(record(66, 0, 2)), '\x1b[98;3u')
  assert.equal(input.write(record(70, 0, 2)), '\x1b[102;3u')
  assert.equal(input.write(record(81, 64, 1 | 8)), '@')
  assert.equal(input.write(record(81, 64, 2 | 8)), '@')
  assert.equal(input.write(record(0, 20013) + record(0, 25991)), '中文')
  assert.equal(input.write(record(231, 20013, 8) + record(231, 25991, 16 | 8)), '中文')
  assert.equal(input.write(record(0, 0xd83d)), '')
  assert.equal(input.write(record(0, 0xde42, 0, 0) + record(0, 0xde42)), '🙂')
  assert.equal(input.write(record(16, 0, 16) + record(17, 0, 8)), '')
  assert.equal(input.write(record(65, 97, 0, 0)), '')
  assert.equal(input.write(record(65, 97, 0, 1, 3)), 'aaa')
  assert.equal(input.write(record(97, 49, 2)), '')
  for (const vk of [12, 33, 34, 35, 36, 37, 38, 39, 40, 45, 46]) assert.equal(input.write(record(vk, 0, 2)), '')
  assert.equal(input.write(record(38, 0, 2 | 256)), '\x1b[57352;3u')
  assert.equal(input.write(record(18, 233, 0, 0)), 'é')
  assert.equal(input.write(record(18, 0xd83d, 0, 0) + record(18, 0xde42, 0, 0)), '🙂')
  assert.equal(input.write(tap(32, 160, 1 | 8)), '\u00a0')
})

test('native repeat counts and held key-down records retain repeat identity until key-up', () => {
  const input = new WindowsInputDecoder()
  for (const [vk, uc, code] of [[9, 9, 9], [13, 13, 57414], [32, 32, 32], [39, 0, 57351]]) {
    assert.equal(input.write(record(vk, uc, 256, 1, 3)), `\x1b[${code};1u\x1b[${code};1:2u\x1b[${code};1:2u`)
    assert.equal(input.write(record(vk, uc, 256)), `\x1b[${code};1:2u`)
    assert.equal(input.write(record(vk, uc, 256, 0)), '')
    assert.equal(input.write(record(vk, uc, 256)), `\x1b[${code};1u`)
    input.reset()
  }
})

test('Win32 records and mode replies survive every byte boundary', () => {
  const replies = []
  const text = '\x1b[?9001;2$y' + record(13, 13, 16) + record(74, 10, 8) + record(0, 0xd83d) + record(0, 0xde42)
  for (let split = 0; split <= text.length; split++) {
    const input = new WindowsInputDecoder(status => replies.push(status))
    assert.equal(input.write(text.slice(0, split)) + input.write(text.slice(split)), '\x1b[13;2u\x1b[106;5u🙂')
    assert.equal(input.pendingLength, 0)
  }
  assert.deepEqual(replies, Array(text.length + 1).fill(2))
  const input = new WindowsInputDecoder()
  assert.equal(input.write('\x1b[13;;;1;16_'), '\x1b[13;2u')
})

test('paste, mouse, Kitty and other terminal input are passed through without record interpretation', () => {
  const input = new WindowsInputDecoder()
  const pasted = `\x1b[200~one\n${record(13, 13, 16)}\x1b[?9001;2$ytwo\x1b[201~`
  let output = ''
  for (const byte of pasted) output += input.write(byte)
  assert.equal(output, pasted)
  for (const text of ['\x1b[<0;10;20M', '\x1b[<0;10;20m', '\x1b[13;2u', '\x1b[27;2;13~',
    '\x1b[I', '\x1b[O', '\x1b]10;rgb:00/00/00\x07', 'ordinary 中文🙂']) {
    assert.equal(input.write(text), text)
  }
  assert.equal(input.write('\x1b'), '')
  assert.equal(input.flush(), '\x1b')
})

test('owned ConPTY paste records decode Unicode only across every fragmented boundary', () => {
  const replies = []
  const mixed = `\x1b[200~first${tap(13, 13, 16)}${tap(74, 10, 8)}second` +
    record(0, 0xd83d) + record(0, 0xde42) + record(65, 97, 2 | 8, 1, 3) +
    record(39, 0) + record(16, 0, 16) + record(0, 0) + record(65, 65, 0, 0) +
    record(18, 233, 0, 0) + '\x1b[?9001;2$y\x1b[201~' + tap(13, 13, 16)
  const expected = '\x1b[200~first\r\nsecond🙂aaaé\x1b[?9001;2$y\x1b[201~\x1b[13;2u'
  for (let split = 0; split <= mixed.length; split++) {
    const input = new WindowsInputDecoder(status => replies.push(status), () => true)
    assert.equal(input.write(mixed.slice(0, split)) + input.write(mixed.slice(split)), expected)
    assert.equal(input.pendingLength, 0)
    assert.equal(input.inPaste, false)
  }
  const input = new WindowsInputDecoder(status => replies.push(status), () => true)
  let output = ''
  for (const character of mixed) output += input.write(character)
  assert.equal(output, expected)
  assert.deepEqual(replies, [], 'Mode-shaped pasted text must not negotiate reporting')
})

test('owned pasted key records never change held-key consent state', () => {
  const input = new WindowsInputDecoder(() => {}, () => true)
  assert.equal(input.write(record(13, 13)), '\x1b[13;1u') // Held before paste.
  assert.equal(input.write('\x1b[200~' + record(13, 0, 0, 0) + record(39, 0) +
    record(13, 13, 8, 1, 2) + '\x1b[201~'), '\x1b[200~\r\r\x1b[201~')
  assert.equal(input.write(record(13, 13)), '\x1b[13;1:2u', 'A pasted release cannot authorize the held key')
  assert.equal(input.write(record(13, 0, 0, 0) + record(13, 13)), '\x1b[13;1u')
  input.reset()
  assert.equal(input.write('\x1b[200~' + record(13, 13) + '\x1b[201~' + record(13, 13)),
    '\x1b[200~\r\x1b[201~\x1b[13;1u', 'A pasted down record cannot mark a later fresh key held')
})

test('decoded terminal framing controls cannot escape owned paste', () => {
  const input = new WindowsInputDecoder(() => { assert.fail('Pasted reply executed') }, () => true)
  const encoded = [...'\x1b[201~\x1b[C\r'].map(character => record(0, character.charCodeAt(0))).join('')
  assert.equal(input.write('\x1b[200~' + encoded + '\x1b[201~'), '\x1b[200~\0[201~\0[C\r\x1b[201~')
  const suffix = [...'[201~\x1b[C\r'].map(character => record(0, character.charCodeAt(0))).join('')
  assert.equal(input.write('\x1b[200~\x1b' + suffix + '\x1b[201~'), '\x1b[200~\0[201~\0[C\r\x1b[201~')
  for (const content of [encoded, '\x1b' + suffix]) {
    const paste = '\x1b[200~' + content + '\x1b[201~'
    for (let split = 0; split <= paste.length; split++) {
      const fragmented = new WindowsInputDecoder(() => { assert.fail('Pasted reply executed') }, () => true)
      assert.equal(fragmented.write(paste.slice(0, split)) + fragmented.write(paste.slice(split)),
        '\x1b[200~\0[201~\0[C\r\x1b[201~')
    }
  }
  assert.equal(input.write('\x1b[200~' + record(32, 0, 8) + '\x1b[201~'), '\x1b[200~\0\x1b[201~')
  for (const code of [0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f]) {
    assert.equal(input.write('\x1b[200~' + record(0, code) + '\x1b[201~'), '\x1b[200~\0\x1b[201~')
  }
})

test('pasted surrogate state cannot cross raw text or paste boundaries', () => {
  const input = new WindowsInputDecoder(() => {}, () => true)
  assert.equal(input.write(record(0, 0xd83d) + '\x1b[200~' + record(0, 0xde42)), '\x1b[200~\ufffd')
  assert.equal(input.write(record(0, 0xd83d) + 'raw' + record(0, 0xde42)), 'raw\ufffd')
  assert.equal(input.write(record(0, 0xd83d) + '\x1b[?9001;2$y' + record(0, 0xde42)), '\x1b[?9001;2$y\ufffd')
  assert.equal(input.write(record(0, 0xd83d) + '\x1b[201~' + record(0, 0xde42)), '\x1b[201~\ufffd')
  assert.equal(input.write('\x1b[200~' + record(0, 0xd83d) + record(32, 0, 8) + record(0, 0xde42) + '\x1b[201~'),
    '\x1b[200~\0\ufffd\x1b[201~')
  assert.equal(input.write('\x1b[200~' + record(0, 0xd83d) + record(0, 0, 0, 0) + record(0, 0xde42) + '\x1b[201~'),
    '\x1b[200~🙂\x1b[201~')
})

test('malformed owned pasted records remain literal and buffering stays bounded', () => {
  const input = new WindowsInputDecoder(() => { assert.fail('Pasted reply executed') }, () => true)
  const malformed = '\x1b[13;0;65536;1;16;1_'
  assert.equal(input.write('\x1b[200~' + malformed), '\x1b[200~' + malformed)
  const oversized = '\x1b[' + '1'.repeat(129)
  assert.equal(input.write(oversized), '\0' + oversized.slice(1))
  assert.equal(input.pendingLength, 0)
  assert.equal(input.write('\x1b[13;'), '')
  assert.equal(input.flush(), '', 'Paste record fragments must not time out into key actions')
  assert.equal(input.write('0;13;1;0;1_\x1b[20'), '\r')
  assert.equal(input.write('1~' + tap(13, 13)), '\x1b[201~\x1b[13;1u')
  assert.equal(input.inPaste, false)
})

test('malformed records are not interpreted and incomplete input has a bounded buffer', () => {
  const input = new WindowsInputDecoder()
  for (const sequence of ['\x1b[13;0;13;2;16;1_', '\x1b[13;0;65536;1;16;1_', '\x1b[13;0;13;1;16;1;1_',
    '\x1b[13;-1;13;1;16;1_']) assert.equal(input.write(sequence), sequence)
  const oversized = '\x1b[' + '1'.repeat(129)
  assert.equal(input.write(oversized), oversized)
  assert.equal(input.pendingLength, 0)
})

function fixture() {
  const source = new PassThrough()
  source.isTTY = true
  source.isRaw = false
  source.fd = 0
  source.setRawMode = value => { source.isRaw = value; return source }
  source.pause()
  const writes = []
  const input = createWindowsInputBridge(source, text => writes.push(text))
  const chunks = []
  input.stdin.on('data', chunk => chunks.push(chunk))
  return { source, input, writes, text: () => Buffer.concat(chunks).toString('utf8') }
}

test('query timeout and late replies never enable reporting or interrupt ordinary input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { source, input, writes, text } = fixture()
  try {
    input.stdin.setRawMode(true)
    input.start()
    source.write('before')
    source.write('\x1b[?9001;') // Delayed mode reply must not win after the query window.
    t.mock.timers.tick(5001)
    source.write('2$y')
    source.write('after\n')
    await nextTick()
    assert.equal(text(), 'beforeafter\n')
    assert.deepEqual(writes, ['\x1b[?9001$p'])
    assert.equal(input.failure, undefined)
    assert.equal(source.isRaw, true)
    input.close()
    source.write('\x1b[?9001;2$y')
    t.mock.timers.tick(5000)
    assert.deepEqual(writes, ['\x1b[?9001$p'])
    assert.equal(source.isRaw, false)
    assert.equal(source.isPaused(), true)
  } finally { input.close(); source.destroy() }
})

test('dispose during query removes timers and exit listeners before a late positive reply', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const exits = process.listenerCount('exit')
  const { source, input, writes, text } = fixture()
  try {
    input.stdin.setRawMode(true)
    input.start()
    input.close()
    source.write('\x1b[?9001;2$y' + record(13, 13, 16))
    t.mock.timers.tick(6000)
    await nextTick()
    assert.deepEqual(writes, ['\x1b[?9001$p'])
    assert.equal(text(), '')
    assert.equal(process.listenerCount('exit'), exits)
    assert.equal(source.isRaw, false)
    assert.equal(source.listenerCount('data'), 0)
  } finally { input.close(); source.destroy() }
})

test('query write failure closes input ownership before returning a generic setup error', () => {
  const source = new PassThrough()
  source.isTTY = true
  source.isRaw = false
  source.setRawMode = value => { source.isRaw = value; return source }
  let failed = false
  const exits = process.listenerCount('exit')
  const input = createWindowsInputBridge(source, () => { throw new Error('fake-output-detail') }, () => { failed = true })
  try {
    input.stdin.setRawMode(true)
    assert.throws(() => input.start(), { message: 'Windows console reporting setup failed' })
    assert.equal(input.failure?.message, 'Windows console reporting setup failed')
    assert.equal(failed, true)
    assert.equal(input.stdin.destroyed, true)
    assert.equal(source.isRaw, false)
    assert.equal(source.isPaused(), true)
    assert.equal(source.listenerCount('data'), 0)
    assert.equal(process.listenerCount('exit'), exits)
    const retry = createWindowsInputBridge(source, () => {})
    retry.close()
  } finally { input.close(); source.destroy() }
})

test('an enable-write failure still attempts reset and restores raw/input ownership', async () => {
  const source = new PassThrough()
  source.isTTY = true
  source.isRaw = false
  source.setRawMode = value => { source.isRaw = value; return source }
  const writes = []
  let reporting = false
  const input = createWindowsInputBridge(source, text => {
    writes.push(text)
    if (text === '\x1b[?9001h') { reporting = true; throw new Error('fake-output-detail') }
    if (text === '\x1b[?9001l') reporting = false
  })
  try {
    input.stdin.setRawMode(true)
    input.start()
    source.write('\x1b[?9001;2$y')
    await nextTick()
    assert.deepEqual(writes, ['\x1b[?9001$p', '\x1b[?9001h', '\x1b[?9001l'])
    assert.equal(reporting, false)
    assert.equal(input.failure?.message, 'Windows console input failed')
    assert.equal(input.stdin.destroyed, true)
    assert.equal(source.isRaw, false)
    assert.equal(source.listenerCount('data'), 0)
  } finally { input.close(); source.destroy() }
})

test('a transient reset-write failure is retried before closing while permanent failure is explicit', () => {
  for (const permanent of [false, true]) {
    const source = new PassThrough()
    source.isTTY = true
    source.isRaw = false
    source.setRawMode = value => { source.isRaw = value; return source }
    let reporting = false
    let resets = 0
    const input = createWindowsInputBridge(source, text => {
      if (text === '\x1b[?9001h') reporting = true
      if (text === '\x1b[?9001l') {
        if (++resets === 1 || permanent) throw new Error('fake-output-detail')
        reporting = false
      }
    })
    try {
      input.stdin.setRawMode(true)
      input.start()
      source.write('\x1b[?9001;2$y')
      if (permanent) assert.throws(() => input.close(), { message: 'Windows console reporting restoration failed' })
      else input.close()
      assert.equal(resets, 2)
      assert.equal(reporting, permanent) // Unwritable output cannot establish terminal-mode restoration.
      assert.equal(input.failure?.message, permanent ? 'Windows console reporting restoration failed' : undefined)
      assert.equal(input.stdin.destroyed, true)
      assert.equal(source.isRaw, false)
      assert.equal(source.isPaused(), true)
      assert.equal(source.listenerCount('data'), 0)
    } finally { input.close(); source.destroy() }
  }
})

test('process-exit hook resets an owned mode and releases neutral stdin in a fake child process', () => {
  const module = new URL('../dist/windows-input.js', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { PassThrough } from 'node:stream'
    import { writeSync } from 'node:fs'
    import { createWindowsInputBridge } from ${JSON.stringify(module)}
    const source = new PassThrough()
    source.isTTY = true; source.isRaw = false
    source.setRawMode = value => { source.isRaw = value; return source }
    const writes = []
    const input = createWindowsInputBridge(source, text => writes.push(text))
    input.stdin.resume(); input.stdin.setRawMode(true); input.start()
    source.write('\\x1b[?9001;2$y')
    process.once('exit', () => writeSync(1, JSON.stringify({ writes, raw: source.isRaw,
      flowing: source.readableFlowing, detached: source.listenerCount('data') === 0, destroyed: input.stdin.destroyed })))
    process.exit(0)
  `], { encoding: 'utf8', timeout: 5000 })
  assert.equal(child.error, undefined)
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { writes: ['\x1b[?9001$p', '\x1b[?9001h', '\x1b[?9001l'],
    raw: false, flowing: false, detached: true, destroyed: true })
})

test('bridge requests supported consumer reporting, resets its request, preserves raw mode and detaches input', async () => {
  for (const status of [0, 1, 2, 3, 4]) {
    const { source, input, writes, text } = fixture()
    try {
      input.stdin.setRawMode(true)
      input.start()
      input.start()
      source.write(`\x1b[?9001;${status}$y`)
      source.write(record(13, 13, 16))
      await nextTick()
      assert.equal(text(), '\x1b[13;2u')
      assert.equal(source.isRaw, true)
      assert.deepEqual(writes, ['\x1b[?9001$p', ...(status === 1 || status === 2 ? ['\x1b[?9001h'] : [])])
      input.close()
      input.close()
      assert.deepEqual(writes, ['\x1b[?9001$p', ...(status === 1 || status === 2 ? ['\x1b[?9001h', '\x1b[?9001l'] : [])])
      assert.equal(source.isRaw, false)
      assert.equal(source.isPaused(), true)
      assert.equal(input.stdin.destroyed, true)
      assert.equal(source.listenerCount('data'), 0)
      assert.equal(source.listenerCount('error'), 0)
      assert.equal(source.listenerCount('end'), 0)
      assert.equal(source.listenerCount('close'), 0)
    } finally { input.close(); source.destroy() }
  }
})

test('bridge keeps UTF-8 and fragmented records intact and flushes an ordinary Escape', async () => {
  const { source, input, text } = fixture()
  try {
    const bytes = Buffer.from('中文🙂' + record(13, 13, 16))
    for (const byte of bytes) source.write(Buffer.from([byte]))
    await nextTick()
    assert.equal(text(), '中文🙂\x1b[13;2u')
    source.write('\x1b')
    await new Promise(resolve => setTimeout(resolve, 35))
    assert.equal(text(), '中文🙂\x1b[13;2u\x1b')
  } finally { input.close(); source.destroy() }
})

test('bridge restores an originally flowing, raw source and discards partial decoder state on close', async () => {
  const source = new PassThrough()
  source.isTTY = true
  source.isRaw = true
  source.setRawMode = value => { source.isRaw = value; return source }
  source.resume()
  const input = createWindowsInputBridge(source, () => {})
  input.stdin.resume()
  try {
    input.stdin.setRawMode(true)
    source.write('\x1b[13;0;13;1;16;')
    input.close()
    assert.equal(source.isRaw, true)
    assert.equal(source.isPaused(), false)
    input.stdin.setRawMode(false) // Renderer cleanup must retain the prior raw mode.
    assert.equal(source.isRaw, true)
    await nextTick()
    assert.equal(input.stdin.read(), null)
  } finally { input.close(); source.destroy() }
})

test('one input stream has one bridge owner and can be reused after close', () => {
  const { source, input } = fixture()
  try {
    assert.throws(() => createWindowsInputBridge(source, () => {}), /already in use/)
    input.close()
    const next = createWindowsInputBridge(source, () => {})
    next.close()
    assert.equal(source.listenerCount('data'), 0)
  } finally { input.close(); source.destroy() }
})

test('a neutral stdin remains inactive on close so the CLI can exit', () => {
  const source = new PassThrough()
  source.isTTY = true
  source.isRaw = false
  source.setRawMode = value => { source.isRaw = value; return source }
  assert.equal(source.readableFlowing, null)
  const input = createWindowsInputBridge(source, () => {})
  try {
    input.stdin.resume()
    input.stdin.setRawMode(true)
    input.start()
    input.close()
    assert.equal(source.isPaused(), true)
    assert.equal(source.readableFlowing, false)
    assert.equal(source.isRaw, false)
  } finally { input.close(); source.destroy() }
})

test('a delayed split paste-end marker cannot leave subsequent Windows keys in paste mode', async () => {
  const { source, input, text } = fixture()
  try {
    source.write('\x1b[200~pasted\x1b[')
    await new Promise(resolve => setTimeout(resolve, 150))
    source.write('201~')
    source.write(record(13, 13, 16))
    await nextTick()
    assert.equal(text(), '\x1b[200~pasted\x1b[201~\x1b[13;2u')
  } finally { input.close(); source.destroy() }
})

test('delayed record fragments preserve modifiers and a fresh Escape sequence recovers malformed input', async () => {
  const { source, input, text } = fixture()
  try {
    source.write('\x1b[13;0;13;1;16;')
    await new Promise(resolve => setTimeout(resolve, 150))
    source.write('1_')
    await nextTick()
    assert.equal(text(), '\x1b[13;2u')
    source.write('\x1b[13;0;')
    source.write(record(27, 27))
    await nextTick()
    assert.equal(text(), '\x1b[13;2u\x1b[13;0;\x1b[27;1u')
  } finally { input.close(); source.destroy() }
})

test('source EOF and closure restore owned reporting and settle the input bridge as a failure', async () => {
  for (const ending of ['end', 'destroy']) {
    const { source, input, writes } = fixture()
    try {
      input.stdin.setRawMode(true)
      input.start()
      source.write('\x1b[?9001;2$y')
      if (ending === 'end') source.end()
      else source.destroy()
      await nextTick()
      assert.equal(input.failure?.message, 'Windows console input failed')
      assert.equal(input.stdin.destroyed, true)
      assert.equal(source.isRaw, false)
      assert.deepEqual(writes, ['\x1b[?9001$p', '\x1b[?9001h', '\x1b[?9001l'])
    } finally { input.close(); source.destroy() }
  }
})

test('bridge input failures restore reporting and never expose input bytes in errors', async () => {
  const source = new PassThrough()
  source.isTTY = true
  source.isRaw = false
  source.setRawMode = value => { source.isRaw = value; return source }
  const writes = []
  let failed = false
  const input = createWindowsInputBridge(source, text => writes.push(text), () => { failed = true })
  try {
    input.start()
    source.write('\x1b[?9001;2$y')
    source.emit('error', new Error('fake-secret-must-not-be-copied'))
    await nextTick()
    assert.equal(failed, true)
    assert.equal(input.failure?.message, 'Windows console input failed')
    assert.equal(input.stdin.destroyed, true)
    assert.equal(source.isRaw, false)
    assert.deepEqual(writes, ['\x1b[?9001$p', '\x1b[?9001h', '\x1b[?9001l'])
  } finally { input.close(); source.destroy() }
})
