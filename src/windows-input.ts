// SPDX-License-Identifier: Apache-2.0
import { StringDecoder } from 'node:string_decoder'
import { Transform } from 'node:stream'

// Windows' stream input otherwise loses native modifiers on keys such as Enter.
// Negotiate the console's input-record VT format and translate it to encodings
// already supported by OpenTUI. No second console reader or native module is used.
// https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md
const QUERY_MODE = '\x1b[?9001$p'
const ENABLE_MODE = '\x1b[?9001h'
const DISABLE_MODE = '\x1b[?9001l'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const MAX_SEQUENCE = 128
const inputOwners = new WeakSet<NodeJS.ReadStream>()
const KEY_CODES: Readonly<Record<number, number>> = {
  8: 127, 9: 9, 13: 13, 27: 27, 32: 32, 33: 57354, 34: 57355, 35: 57357, 36: 57356,
  37: 57350, 38: 57352, 39: 57351, 40: 57353, 45: 57348, 46: 57349
}
const CONTROL_PUNCTUATION: Readonly<Record<number, number>> = {
  186: 59, 187: 61, 188: 44, 189: 45, 190: 46, 191: 47, 192: 96,
  219: 91, 220: 92, 221: 93, 222: 39
}
const keySequence = (code: number, modifiers: number): string => `\x1b[${code};${modifiers + 1}u`

/** Incremental decoder. Bracketed paste is opaque, including record-shaped text. */
export class WindowsInputDecoder {
  private pending = ''
  private pasted = false
  private readonly heldKeys = new Set<string>()
  private enterRecords = 0
  private surrogate: { code: number; modifiers: number; literal: boolean } | undefined
  constructor(private readonly modeReply: (status: number) => void = () => {}) {}
  get pendingLength(): number { return this.pending.length }
  get inPaste(): boolean { return this.pasted }
  get enterRecordsObserved(): number { return this.enterRecords }

  write(text: string): string {
    this.pending += text
    let output = ''
    while (this.pending) {
      if (this.pasted) {
        const end = this.pending.indexOf(PASTE_END)
        if (end < 0) {
          // Retain only a possible split end marker; all paste content stays raw.
          let keep = Math.min(PASTE_END.length - 1, this.pending.length)
          while (keep && !PASTE_END.startsWith(this.pending.slice(-keep))) keep--
          output += keep ? this.pending.slice(0, -keep) : this.pending
          this.pending = keep ? this.pending.slice(-keep) : ''
          break
        }
        output += this.pending.slice(0, end + PASTE_END.length)
        this.pending = this.pending.slice(end + PASTE_END.length)
        this.pasted = false
        continue
      }
      const escape = this.pending.indexOf('\x1b[')
      if (escape < 0) {
        const keep = this.pending.endsWith('\x1b') ? 1 : 0
        output += keep ? this.pending.slice(0, -keep) : this.pending
        this.pending = keep ? '\x1b' : ''
        break
      }
      output += this.pending.slice(0, escape)
      this.pending = this.pending.slice(escape)
      let end = 2
      while (end < this.pending.length && !/[\x40-\x7e]/.test(this.pending[end]!)) end++
      const restart = this.pending.indexOf('\x1b', 1)
      if (restart >= 0 && restart < end) {
        output += this.pending.slice(0, restart)
        this.pending = this.pending.slice(restart)
        continue
      }
      if (end === this.pending.length) {
        if (this.pending.length > MAX_SEQUENCE) { output += this.pending; this.pending = '' }
        break
      }
      const sequence = this.pending.slice(0, end + 1)
      this.pending = this.pending.slice(end + 1)
      if (sequence === PASTE_START) { this.pasted = true; output += sequence; continue }
      const reply = /^\x1b\[\?9001;([0-4])\$y$/.exec(sequence)
      if (reply) { this.modeReply(Number(reply[1])); continue }
      output += this.record(sequence) ?? sequence
    }
    return output
  }

  /** Flush incomplete sequences so Escape and unsupported CSI input stay usable. */
  flush(): string {
    if (this.pasted) return '' // A delayed split paste-end marker must stay intact.
    const text = this.pending
    this.pending = ''
    return text
  }

  reset(): void { this.pending = ''; this.pasted = false; this.surrogate = undefined; this.heldKeys.clear() }

  private character(code: number, modifiers: number, literal: boolean): string {
    if (code >= 0xd800 && code <= 0xdbff) {
      this.surrogate = { code, modifiers, literal }
      return ''
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      const high = this.surrogate
      this.surrogate = undefined
      if (!high) return '\ufffd'
      code = 0x10000 + ((high.code - 0xd800) << 10) + (code - 0xdc00)
      modifiers = high.modifiers
      literal = high.literal
    } else this.surrogate = undefined
    return literal ? String.fromCodePoint(code) : keySequence(code, modifiers)
  }

  private record(sequence: string): string | undefined {
    const match = /^\x1b\[([\d;]*)_$/.exec(sequence)
    if (!match) return undefined
    const parts = match[1]!.split(';')
    if (parts.length > 6) return undefined
    const defaults = [0, 0, 0, 0, 0, 1]
    const values = defaults.map((fallback, index) => parts[index] ? Number(parts[index]) : fallback)
    if (values.some(value => !Number.isInteger(value) || value < 0 || value > 65535)) return undefined
    const [virtual, scan, character, down, state, repeat] = values as [number, number, number, number, number, number]
    if (down !== 0 && down !== 1) return undefined
    if (virtual === 13) this.enterRecords++
    const identity = virtual && virtual !== 231 ? `${virtual}:${scan}:${state & 0x100}` : undefined
    const held = identity !== undefined && this.heldKeys.has(identity)
    if (!down && identity !== undefined) this.heldKeys.delete(identity)
    if (!repeat) return ''
    // Windows delivers Alt+numpad Unicode text on the Alt key's release.
    if (!down) return virtual === 18 && character ? this.character(character, 0, true).repeat(repeat) : ''
    if (identity !== undefined) this.heldKeys.add(identity)
    let modifiers = (state & 0x10 ? 1 : 0) | (state & 0x03 ? 2 : 0) | (state & 0x0c ? 4 : 0)
    if (virtual >= 96 && virtual <= 105 && modifiers === 2) return ''
    // With NumLock off, Alt-code numpad digits use navigation virtual keys.
    // Dedicated navigation keys carry ENHANCED_KEY and retain their bindings.
    if (modifiers === 2 && !(state & 0x100) &&
      [12, 33, 34, 35, 36, 37, 38, 39, 40, 45, 46].includes(virtual)) return ''
    let encoded: string
    if (!virtual || virtual === 231) {
      // Console responses and injected/IME text carry Unicode without a key.
      encoded = this.character(character, 0, true)
    } else if (KEY_CODES[virtual] !== undefined && (virtual !== 32 || character === 0 || character === 32)) {
      this.surrogate = undefined
      const code = virtual === 13 && (state & 0x100) ? 57414 : KEY_CODES[virtual]!
      encoded = keySequence(code, modifiers)
    } else if (virtual >= 112 && virtual <= 135) {
      this.surrogate = undefined
      encoded = keySequence(57364 + virtual - 112, modifiers)
    } else if (character || (modifiers & 6) &&
      (CONTROL_PUNCTUATION[virtual] !== undefined || virtual >= 65 && virtual <= 90)) {
      // Windows also aliases Ctrl+LeftAlt to AltGr. With supplied printable
      // Unicode, either Alt+Ctrl combination is text. Shift/CapsLock text is
      // already translated. Uc=0 Ctrl/Alt+letter/OEM records retain shortcuts.
      const altGr = !!(state & 0x03) && !!(state & 0x0c) && character >= 32
      if (altGr) modifiers = 0
      const literal = altGr || !(modifiers & 0b110)
      let code = character
      if (!literal && code < 32) {
        code = CONTROL_PUNCTUATION[virtual] ?? (virtual >= 65 && virtual <= 90 ? virtual + 32 : code)
      } else if (!literal && code >= 65 && code <= 90) code += 32
      encoded = this.character(code, modifiers, literal)
    } else return '' // Modifier-only and untranslated/dead-key records are not text.
    // Preserve repeats for functional keys and shortcuts. OpenTUI represents
    // Kitty ':2' as repeated=true; approvals must not treat held keys as fresh.
    const repeated = encoded.startsWith('\x1b[') && encoded.endsWith('u') ? `${encoded.slice(0, -1)}:2u` : encoded
    return (held ? repeated : encoded) + repeated.repeat(repeat - 1)
  }
}

export interface WindowsInputBridge {
  readonly stdin: NodeJS.ReadStream
  readonly failure: Error | undefined
  /** Nonsecret protocol state; never includes input text, bytes or paths. */
  readonly diagnostic: { started: boolean; waiting: boolean; closed: boolean;
    modeReply?: number; enableRequested: boolean; enterRecordsObserved: number; restorationFailed: boolean }
  start(): void
  close(): void
}

/** The caller opts in only for a real Windows TTY, never the Node line route. */
export function createWindowsInputBridge(source: NodeJS.ReadStream,
  write: (text: string) => void, onFailure: () => void = () => {}): WindowsInputBridge {
  if (inputOwners.has(source)) throw new Error('Windows console input is already in use')
  let closed = false
  let started = false
  let changedMode = false
  let waiting = false
  let modeReply: number | undefined
  let enableRequested = false
  let failure: Error | undefined
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let queryTimer: ReturnType<typeof setTimeout> | undefined
  const originalRaw = source.isRaw
  const originalFlowing = source.readableFlowing === true
  const utf8 = new StringDecoder('utf8')
  const decoder = new WindowsInputDecoder(status => {
    if (!waiting || closed) return
    waiting = false
    modeReply = status
    clearTimeout(queryTimer)
    if (status === 2) { changedMode = true; enableRequested = true; write(ENABLE_MODE) }
  })
  const stdin = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        clearTimeout(flushTimer)
        const text = decoder.write(utf8.write(chunk))
        if (text) this.push(Buffer.from(text))
        // Only a bare Escape needs a timer. A numeric input record or paste
        // marker may be split across delayed reads; keep it until completion.
        if (decoder.pendingLength === 1 && !decoder.inPaste) {
          flushTimer = setTimeout(() => {
            flushTimer = undefined
            if (!closed) this.push(Buffer.from(decoder.flush()))
          }, 20)
          flushTimer.unref()
        }
        callback()
      } catch (error) { callback(error instanceof Error ? error : new Error('Windows input decoding failed')) }
    }
  })
  Object.defineProperties(stdin, {
    isTTY: { value: source.isTTY },
    isRaw: { get: () => source.isRaw },
    fd: { value: (source as NodeJS.ReadStream & { fd?: number }).fd },
    setRawMode: { value: (mode: boolean) => { source.setRawMode(closed ? originalRaw : mode); return stdin } }
  })
  inputOwners.add(source)
  try { source.pipe(stdin, { end: false }) }
  catch (error) { inputOwners.delete(source); stdin.destroy(); throw error }
  const close = (): void => {
    if (closed) return
    closed = true
    inputOwners.delete(source)
    waiting = false
    clearTimeout(flushTimer)
    clearTimeout(queryTimer)
    process.off('exit', close)
    source.off('error', sourceError)
    source.off('end', sourceFinished)
    source.off('close', sourceFinished)
    source.unpipe(stdin)
    decoder.reset()
    utf8.end()
    try {
      if (changedMode) {
        // The reset is idempotent. Retry one transient output failure before
        // reporting that console restoration could not be established.
        try { write(DISABLE_MODE) }
        catch {
          try { write(DISABLE_MODE) }
          catch { failure = new Error('Windows console reporting restoration failed'); throw failure }
        }
        changedMode = false
      }
    }
    finally {
      try {
        source.setRawMode(originalRaw)
        if (originalFlowing) source.resume()
        else source.pause() // A neutral/null stdin must remain inactive after UI exit.
      } finally { stdin.destroy() }
    }
  }
  const sourceError = (): void => { stdin.destroy(new Error('Windows console input failed')) }
  const sourceFinished = (): void => {
    if (!closed) stdin.destroy(new Error('Windows console input closed'))
  }
  source.on('error', sourceError)
  source.once('end', sourceFinished)
  source.once('close', sourceFinished)
  stdin.on('error', () => {
    failure = new Error('Windows console input failed')
    try { close() } catch { /* Failure still reaches the owner if restoration also fails. */ }
    finally { onFailure() }
  })
  return { stdin: stdin as unknown as NodeJS.ReadStream, get failure() { return failure },
    get diagnostic() { return { started, waiting, closed, ...(modeReply === undefined ? {} : { modeReply }),
      enableRequested, enterRecordsObserved: decoder.enterRecordsObserved,
      restorationFailed: failure?.message === 'Windows console reporting restoration failed' } },
    close, start(): void {
    if (closed || started) return
    started = true
    waiting = true
    process.once('exit', close)
    queryTimer = setTimeout(() => { waiting = false }, 5000)
    queryTimer.unref()
    try { write(QUERY_MODE) }
    catch {
      failure = new Error('Windows console reporting setup failed')
      try { close() } catch { /* Keep the setup failure generic and finish ownership cleanup. */ }
      onFailure()
      throw failure
    }
  } }
}
