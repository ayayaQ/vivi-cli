// SPDX-License-Identifier: Apache-2.0
export interface Choice<T> { name: string; description?: string; value: T; searchTerms?: readonly string[] }
export interface SearchableOptions {
  query?: string
  initialIndex?: number
  refresh?: boolean
}
export type SearchableSelection<T> = { kind: 'selected'; value: T; query: string } | { kind: 'refresh'; query: string }

const normalize = (text: string): string => text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')
const words = (text: string): string => normalize(text).replace(/[\p{P}\p{S}]+/gu, ' ').trim().replace(/\s+/gu, ' ')

/** AND matching across searchable labels, with exact IDs first and stable catalog-order ties.
 * Punctuation separates words, so "gpt 5 mini" also finds "gpt-5-mini".
 * Values and capability descriptions are never altered or used as search metadata.
 */
export function matchingChoiceIndices<T>(choices: readonly Choice<T>[], query: string): number[] {
  const phrase = words(query)
  if (!phrase) return choices.map((_, index) => index)
  const tokens = phrase.split(' ')
  const raw = normalize(query)
  const ranked: { index: number; rank: number }[] = []
  choices.forEach((choice, index) => {
    const labels = [choice.name, ...choice.searchTerms ?? []].map(normalize)
    const fields = labels.map(words)
    const suffix = normalize(choice.name.slice(choice.name.lastIndexOf('/') + 1))
    const suffixWords = words(suffix)
    if (!tokens.every(token => fields.some(field => field.includes(token)))) return
    const rank = labels[0] === raw ? 0 : fields[0] === phrase ? 1
      : suffix === raw ? 2 : suffixWords === phrase ? 3
      : labels.includes(raw) ? 4 : fields.includes(phrase) ? 5
      : fields[0]!.startsWith(phrase) ? 6 : suffixWords.startsWith(phrase) ? 7
      : fields.some(field => field.startsWith(phrase)) ? 8 : fields.some(field => field.includes(phrase)) ? 9
      : 10 + tokens.reduce((score, token) => score + Math.min(...fields.map(field => {
        const parts = field.split(' ')
        return parts.includes(token) ? 0 : parts.some(part => part.startsWith(token)) ? 1 : 2
      })), 0)
    ranked.push({ index, rank })
  })
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ index }) => index)
}
