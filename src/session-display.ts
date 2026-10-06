// SPDX-License-Identifier: Apache-2.0
import type { HistoryMessage } from '@ayayaq/vivi'

export const MAX_SESSION_TITLE_GRAPHEMES = 80
export const MAX_SESSION_TITLE_LENGTH = 240
const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Display metadata only: preserve readable Unicode, remove terminal commands and bidi controls. */
export function normalizeSessionTitle(input: string): string {
  return input.slice(0, 65536)
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, character => ['\n', '\r', '\t', '\u200c', '\u200d'].includes(character) ||
      /[\u{e0020}-\u{e007f}]/u.test(character) ? character : '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\ufffd')
    .normalize('NFC').replace(/\s+/gu, ' ').trim()
}

export function validSessionTitle(title: string): boolean {
  return title.length > 0 && title.length <= MAX_SESSION_TITLE_LENGTH && normalizeSessionTitle(title) === title &&
    [...segments.segment(title)].length <= MAX_SESSION_TITLE_GRAPHEMES &&
    title.replace(/[\p{Default_Ignorable_Code_Point}\p{M}\s\u2800]/gu, '').length > 0
}

/** Deterministic, bounded first-message title. No provider request or transcript rewriting. */
export function sessionTitleFromPrompt(prompt: string): string | undefined {
  const title = normalizeSessionTitle(prompt)
  if (!title || !title.replace(/[\p{Default_Ignorable_Code_Point}\p{M}\s\u2800]/gu, '')) return undefined
  if (validSessionTitle(title)) return title
  let output = '', count = 0
  for (const { segment } of segments.segment(title)) {
    if (count === MAX_SESSION_TITLE_GRAPHEMES - 1 || output.length + segment.length > MAX_SESSION_TITLE_LENGTH - 1) break
    output += segment; count++
  }
  return output.trimEnd() ? `${output.trimEnd()}…` : undefined
}

/** Legacy sessions get a view-only fallback; reading a picker never renames saved files. */
export function sessionDisplayTitle(session: { title?: string; history: readonly HistoryMessage[] }): string {
  if (session.title !== undefined && validSessionTitle(session.title)) return session.title
  const first = session.history.find(message => message.kind === 'message' && message.role === 'user')
  return first ? sessionTitleFromPrompt(first.content) ?? 'Untitled conversation' : 'Untitled conversation'
}

export interface SessionDateOptions {
  now?: Date
  locales?: Intl.LocalesArgument
  timeZone?: string
}

/** Local calendar dates, including DST boundaries; precise stored timestamps remain untouched. */
export function formatSessionDate(timestamp: string, options: SessionDateOptions = {}): string {
  const date = new Date(timestamp), now = options.now ?? new Date()
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(now.getTime())) return 'Unknown date'
  try {
    const zone = options.timeZone === undefined ? {} : { timeZone: options.timeZone }
    const calendar = new Intl.DateTimeFormat('en-US', { ...zone, year: 'numeric', month: 'numeric', day: 'numeric' })
    const parts = (value: Date): { year: number; day: number } => {
      const fields = calendar.formatToParts(value)
      const number = (type: string): number => Number(fields.find(part => part.type === type)!.value)
      return { year: number('year'), day: Date.UTC(number('year'), number('month') - 1, number('day')) }
    }
    const current = parts(now), stored = parts(date)
    const difference = (stored.day - current.day) / 86400000
    const time = new Intl.DateTimeFormat(options.locales, { ...zone, hour: 'numeric', minute: '2-digit' }).format(date)
    let label: string
    if (difference === 0 || difference === -1) {
      label = new Intl.RelativeTimeFormat(options.locales, { numeric: 'auto' }).format(difference, 'day')
      label = label.charAt(0).toLocaleUpperCase(options.locales) + label.slice(1)
    } else label = new Intl.DateTimeFormat(options.locales, { ...zone, month: 'short', day: 'numeric',
      ...(stored.year === current.year ? {} : { year: 'numeric' }) }).format(date)
    return `${label} ${time}`
  } catch { return 'Unknown date' }
}
