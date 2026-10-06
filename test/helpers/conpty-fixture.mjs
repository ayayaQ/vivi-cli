// SPDX-License-Identifier: Apache-2.0
import { PassThrough } from 'node:stream'

/** Two distinct encoders, based on Microsoft Terminal v1.24.12741.0:
 * outputStream.cpp suppresses local replies; _stream.cpp forwards the query;
 * inputBuffer.cpp re-encodes native records according to its inner mode.
 * The outer terminal starts in Win32 mode while the inner consumer starts off.
 * https://github.com/microsoft/terminal/blob/v1.24.12741.0/src/host/outputStream.cpp#L34-L42
 * https://github.com/microsoft/terminal/blob/v1.24.12741.0/src/host/_stream.cpp#L335-L386
 * https://github.com/microsoft/terminal/blob/v1.24.12741.0/src/host/inputBuffer.cpp#L682-L713
 */
export function conptyFixture(createBridge, status = 1, failWrite = () => false) {
  const source = new PassThrough()
  source.isTTY = true; source.isRaw = false; source.fd = 0
  source.setRawMode = value => { source.isRaw = value; return source }
  source.pause()
  const state = { outerRecords: true, innerRecords: false }, writes = [], chunks = []
  const bridge = createBridge(source, text => {
    writes.push(text)
    if (failWrite(text)) throw new Error('Untrusted output detail must stay private')
    if (text === '\x1b[?9001$p') {
      // The reply describes only the outer layer. It cannot snapshot the inner one.
      queueMicrotask(() => source.write(`\x1b[?9001;${status}$y`))
    } else if (text === '\x1b[?9001h') {
      state.innerRecords = true; state.outerRecords = true
    } else if (text === '\x1b[?9001l') {
      state.innerRecords = false
      state.outerRecords = false
      // ConPTY injects this reassertion after forwarding the consumer's reset.
      state.outerRecords = true
    }
  })
  bridge.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)))
  const key = (vk, uc, modifiers = 0, down = 1, repeat = 1) => {
    if (!source.isRaw) throw new Error('The fixture must use the production raw-input route')
    if (state.innerRecords) source.write(`\x1b[${vk};0;${uc};${down};${modifiers};${repeat}_`)
    else if (down) {
      // The legacy inner mapping discards Shift from Unicode Enter.
      if (vk === 13) source.write('\r'.repeat(repeat))
      else if (uc) source.write(String.fromCodePoint(uc).repeat(repeat))
    }
  }
  const tap = (...args) => { key(...args); key(args[0], 0, args[2] ?? 0, 0) }
  return { source, bridge, state, writes, key, tap,
    // Raw delimiters surround a mixed representation: C0 execution regenerates
    // CR/LF as native records when inner reporting is enabled.
    paste: text => source.write(`\x1b[200~${state.innerRecords ? text.replace(/\r/g, '\x1b[13;0;13;1;0;1_')
      .replace(/\n/g, '\x1b[74;0;10;1;8;1_') : text}\x1b[201~`),
    text: () => Buffer.concat(chunks).toString('utf8'),
    close: () => { try { bridge.close() } finally { source.destroy() } } }
}
