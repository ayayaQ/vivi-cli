// SPDX-License-Identifier: Apache-2.0
// This is a bounded text tokenizer, not a browser or a DOM parser. In particular,
// it never evaluates scripts, loads resources, or follows document links.

export const PUBLIC_URL_HTML_EXTRACTION_VERSION = 'inert-html-text-v1-common-named-entities-subset'
export const PUBLIC_URL_HTML_VERSION = PUBLIC_URL_HTML_EXTRACTION_VERSION

const MAX_SOURCE_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 2 * MAX_SOURCE_BYTES
const WORK_QUANTUM = 4096
const MAX_ENTITY_LENGTH = 32

// Deliberately a documented subset, rather than claiming HTML5's full table.
// Unknown names and entities without a semicolon remain literal text.
const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'",
  nbsp: '\u00a0', copy: '\u00a9', COPY: '\u00a9', reg: '\u00ae', REG: '\u00ae', trade: '\u2122',
  cent: '\u00a2', pound: '\u00a3', yen: '\u00a5', euro: '\u20ac', sect: '\u00a7', para: '\u00b6',
  middot: '\u00b7', bull: '\u2022', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab', raquo: '\u00bb',
  times: '\u00d7', divide: '\u00f7', plusmn: '\u00b1', deg: '\u00b0', micro: '\u00b5',
  acute: '\u00b4', uml: '\u00a8', frac14: '\u00bc', frac12: '\u00bd', frac34: '\u00be',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', hairsp: '\u200a',
  zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e', rlm: '\u200f',
  colon: ':', sol: '/', bsol: '\\', equals: '=', num: '#', percnt: '%', commat: '@', dollar: '$',
  lpar: '(', rpar: ')', ast: '*', lowbar: '_', period: '.', semi: ';', vert: '|', Tab: '\t', NewLine: '\n',
})

const WINDOWS_1252: Readonly<Record<number, number>> = Object.freeze({
  128: 0x20ac, 130: 0x201a, 131: 0x0192, 132: 0x201e, 133: 0x2026, 134: 0x2020,
  135: 0x2021, 136: 0x02c6, 137: 0x2030, 138: 0x0160, 139: 0x2039, 140: 0x0152,
  142: 0x017d, 145: 0x2018, 146: 0x2019, 147: 0x201c, 148: 0x201d, 149: 0x2022,
  150: 0x2013, 151: 0x2014, 152: 0x02dc, 153: 0x2122, 154: 0x0161, 155: 0x203a,
  156: 0x0153, 158: 0x017e, 159: 0x0178,
})

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'details', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'legend', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table',
  'tbody', 'tfoot', 'thead', 'tr', 'ul',
])
const SUPPRESSED_RAW_TAGS = new Set(['script', 'style', 'noscript', 'iframe', 'noembed'])
const DISPLAY_RAW_TAGS = new Set(['title', 'textarea', 'xmp'])

function invalidExtraction(): Error & { code: 'invalid_extraction' } {
  return Object.assign(new Error('HTML extraction did not complete'), { code: 'invalid_extraction' as const })
}

function admitSource(source: string, maximumBytes: number = MAX_SOURCE_BYTES): void {
  // Check code units first so byteLength cannot be asked to traverse unbounded input.
  if (typeof source !== 'string' || source.length > maximumBytes || Buffer.byteLength(source, 'utf8') > maximumBytes) {
    throw invalidExtraction()
  }
}

function asciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function asciiSpace(code: number): boolean {
  return code === 9 || code === 10 || code === 12 || code === 13 || code === 32
}

function asciiLower(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code
}

interface Entity {
  text: string
  end: number
}

function entityAt(source: string, start: number): Entity | undefined {
  // At most 32 code units are inspected for any '&', including unknown names.
  // Repeated malformed ampersands therefore cannot cause quadratic scanning.
  const limit = Math.min(source.length, start + MAX_ENTITY_LENGTH)
  let end = start + 1
  while (end < limit && source.charCodeAt(end) !== 59) {
    const code = source.charCodeAt(end)
    if (!(asciiLetter(code) || (code >= 48 && code <= 57) || code === 35)) return undefined
    end++
  }
  if (end >= limit || source.charCodeAt(end) !== 59) return undefined
  if (source.charCodeAt(start + 1) !== 35) {
    const name = source.slice(start + 1, end)
    // Object.hasOwn excludes names such as constructor and __proto__.
    return Object.hasOwn(NAMED_ENTITIES, name) ? { text: NAMED_ENTITIES[name]!, end: end + 1 } : undefined
  }

  let index = start + 2
  let base = 10
  if (asciiLower(source.charCodeAt(index)) === 120) { base = 16; index++ }
  if (index === end) return undefined
  let value = 0
  for (; index < end; index++) {
    const code = asciiLower(source.charCodeAt(index))
    const digit = code >= 48 && code <= 57 ? code - 48 : code >= 97 && code <= 102 ? code - 87 : -1
    if (digit < 0 || digit >= base) return undefined
    // Saturation avoids overflow while preserving HTML's replacement behavior.
    value = Math.min(0x110000, value * base + digit)
  }
  if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) value = 0xfffd
  value = WINDOWS_1252[value] ?? value
  return { text: String.fromCodePoint(value), end: end + 1 }
}

/** Decode the same subset throughout the full source, including hidden content.
 * This synchronous, linear helper does not strip markup or recursively decode.
 * It admits at most 2 MiB UTF-8, including bounded extracted output that the
 * caller must rescreen. It never expands that source, and calls guard every
 * fixed work quantum.
 */
export function decodePublicUrlHtmlEntities(source: string, guard?: () => void): string {
  guard?.()
  admitSource(source, MAX_OUTPUT_BYTES)
  const chunks: string[] = []
  let chunk = ''
  let index = 0
  let nextGuard = WORK_QUANTUM
  while (index < source.length) {
    if (index >= nextGuard) { guard?.(); nextGuard = index + WORK_QUANTUM }
    const entity = source.charCodeAt(index) === 38 ? entityAt(source, index) : undefined
    if (entity) { chunk += entity.text; index = entity.end }
    else { chunk += source[index]!; index++ }
    if (chunk.length >= WORK_QUANTUM) { chunks.push(chunk); chunk = '' }
  }
  chunks.push(chunk)
  guard?.()
  return chunks.join('')
}

class BoundedText {
  private readonly chunks: string[] = []
  private chunk = ''
  private bytes = 0
  private started = false
  private pending: 0 | 1 | 2 = 0

  boundary(line: boolean): void {
    if (this.started) this.pending = line ? 2 : Math.max(this.pending, 1) as 1 | 2
  }

  append(text: string): void {
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index)
      if (asciiSpace(code) || code === 0xa0) { this.boundary(false); continue }
      if (this.pending) { this.write(this.pending === 2 ? '\n' : ' ', 1); this.pending = 0 }
      let character = code === 0 ? '\ufffd' : text[index]!
      let bytes = code === 0 ? 3 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        const low = text.charCodeAt(index + 1)
        if (low >= 0xdc00 && low <= 0xdfff) { character += text[++index]!; bytes = 4 }
      }
      this.write(character, bytes)
      this.started = true
    }
  }

  finish(): string {
    return [...this.chunks, this.chunk].join('')
  }

  private write(text: string, bytes: number): void {
    if (this.bytes + bytes > MAX_OUTPUT_BYTES) throw invalidExtraction()
    this.bytes += bytes
    this.chunk += text
    if (this.chunk.length >= WORK_QUANTUM) { this.chunks.push(this.chunk); this.chunk = '' }
  }
}

function matchesRawTag(source: string, start: number, name: string, closing: boolean): boolean {
  if (source.charCodeAt(start) !== 60 || (closing && source.charCodeAt(start + 1) !== 47)) return false
  const nameStart = start + (closing ? 2 : 1)
  for (let index = 0; index < name.length; index++) {
    if (asciiLower(source.charCodeAt(nameStart + index)) !== name.charCodeAt(index)) return false
  }
  const next = source.charCodeAt(nameStart + name.length)
  return next === 62 || next === 47 || asciiSpace(next)
}

type State = 'data' | 'tag' | 'comment' | 'declaration' | 'raw' | 'display-raw' | 'plaintext'
type ScriptMode = 'data' | 'escaped' | 'double-escaped'

/** Extract all admitted text before the caller screens and clips it.
 * EOF in a tag, comment, template, or suppressed raw element discards its rest.
 * That conservative malformed-input behavior cannot reveal suppressed content.
 */
export async function extractPublicUrlHtml(source: string, guard: () => void): Promise<string> {
  guard()
  admitSource(source)
  const output = new BoundedText()
  let index = 0
  let work = 0
  let state: State = 'data'
  let templateDepth = 0
  let rawName = ''
  let scriptMode: ScriptMode = 'data'
  let scriptDashes: 0 | 1 | 2 = 0
  let tagContext: 'data' | 'raw' | 'display-raw' = 'data'
  let tagClosing = false
  let tagName = ''
  let tagNameDone = false
  let tagNameTooLong = false
  let quote = 0

  function resetTag(closing: boolean, context: typeof tagContext): void {
    tagClosing = closing
    tagContext = context
    tagName = ''
    tagNameDone = false
    tagNameTooLong = false
    quote = 0
  }

  while (index < source.length) {
    if (work >= WORK_QUANTUM) {
      work = 0
      guard()
      await new Promise<void>(resolve => setImmediate(resolve))
      guard()
    }
    work++
    const code = source.charCodeAt(index)

    if (state === 'comment') {
      if (source.startsWith('-->', index)) { index += 3; work += 2; state = 'data' }
      else index++
      continue
    }

    if (state === 'declaration') {
      if (quote) { if (code === quote) quote = 0 }
      else if (code === 34 || code === 39) quote = code
      else if (code === 62) state = 'data'
      index++
      continue
    }

    if (state === 'tag') {
      if (!tagNameDone) {
        if (asciiSpace(code) || code === 47 || code === 62) tagNameDone = true
        else {
          if (tagName.length < 128 && !tagNameTooLong) tagName += String.fromCharCode(asciiLower(code))
          else { tagName = ''; tagNameTooLong = true }
          index++
          continue
        }
      }
      if (quote) { if (code === quote) quote = 0; index++; continue }
      if (code === 34 || code === 39) { quote = code; index++; continue }
      if (code !== 62) { index++; continue }
      index++
      state = 'data'
      if (tagContext !== 'data') {
        rawName = ''
        if (!templateDepth) output.boundary(true)
        continue
      }
      if (tagClosing) {
        if (tagName === 'template' && templateDepth) templateDepth--
        if (!templateDepth && BLOCK_TAGS.has(tagName)) output.boundary(true)
        else if (!templateDepth && (tagName === 'td' || tagName === 'th')) output.boundary(false)
      } else if (tagName === 'template') {
        if (!templateDepth) output.boundary(false)
        templateDepth++
      } else if (SUPPRESSED_RAW_TAGS.has(tagName)) {
        if (!templateDepth) output.boundary(false)
        rawName = tagName
        scriptMode = 'data'
        scriptDashes = 0
        state = 'raw'
      } else if (DISPLAY_RAW_TAGS.has(tagName)) {
        if (!templateDepth) output.boundary(true)
        rawName = tagName
        state = 'display-raw'
      } else if (tagName === 'plaintext') {
        if (!templateDepth) output.boundary(true)
        state = 'plaintext'
      } else if (!templateDepth) {
        if (BLOCK_TAGS.has(tagName)) output.boundary(true)
        else if (tagName === 'td' || tagName === 'th') output.boundary(false)
      }
      continue
    }

    if (state === 'raw' || state === 'display-raw') {
      if (state === 'raw' && rawName === 'script') {
        // Only script-data's escape transitions affect where suppression ends.
        // Fixed-size prefix checks and a saturated dash count avoid buffering
        // tag-like script text or treating double-escaped </script> as a close.
        // See HTML's script data escape and double escape tokenizer states.
        if (scriptMode === 'data') {
          if (source.startsWith('<!--', index)) {
            scriptMode = 'escaped'
            scriptDashes = 2
            index += 4
            work += 3
            continue
          }
        } else if (code === 60) {
          scriptDashes = 0
          if (scriptMode === 'escaped' && matchesRawTag(source, index, 'script', false)) {
            scriptMode = 'double-escaped'
            // Consume the delimiter too: it is script text, not a fresh tag.
            index += 8
            work += 7
            continue
          }
          if (scriptMode === 'double-escaped' && matchesRawTag(source, index, 'script', true)) {
            scriptMode = 'escaped'
            index += 9
            work += 8
            continue
          }
        } else if (code === 45) {
          scriptDashes = Math.min(2, scriptDashes + 1) as 1 | 2
        } else {
          if (code === 62 && scriptDashes === 2) scriptMode = 'data'
          scriptDashes = 0
        }
      }
      if (code === 60 && !(rawName === 'script' && scriptMode === 'double-escaped') && matchesRawTag(source, index, rawName, true)) {
        resetTag(true, state)
        state = 'tag'
        index += 2
        work++
        continue
      }
      if (state === 'raw' || templateDepth) { index++; continue }
    } else if (state === 'data' && code === 60) {
      if (source.startsWith('<!--', index)) { state = 'comment'; index += 4; work += 3; continue }
      const next = source.charCodeAt(index + 1)
      if (next === 33 || next === 63) { state = 'declaration'; quote = 0; index += 2; work++; continue }
      const closing = next === 47
      if (asciiLetter(source.charCodeAt(index + (closing ? 2 : 1)))) {
        resetTag(closing, 'data')
        state = 'tag'
        index += closing ? 2 : 1
        work += closing ? 1 : 0
        continue
      }
    }

    if (templateDepth) { index++; continue }
    const entity = code === 38 && state !== 'plaintext' && rawName !== 'xmp' ? entityAt(source, index) : undefined
    if (entity) {
      output.append(entity.text)
      work += entity.end - index - 1
      index = entity.end
    } else {
      const next = source.charCodeAt(index + 1)
      const width = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1
      output.append(source.slice(index, index + width))
      index += width
      work += width - 1
    }
  }
  guard()
  return output.finish()
}
