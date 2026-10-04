// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchingChoiceIndices } from '../dist/picker.js'

const choices = [
  { name: 'anthropic/claude-sonnet-4.5', searchTerms: ['Anthropic: Claude Sonnet 4.5', 'OpenRouter'], value: 'exact-claude' },
  { name: 'openai/gpt-5-mini', searchTerms: ['OpenAI: GPT-5 Mini', 'OpenRouter'], value: 'exact-mini' },
  { name: 'openai/gpt-5', searchTerms: ['OpenAI: GPT-5', 'OpenRouter'], value: 'exact-gpt' },
  { name: 'gpt-5', searchTerms: ['GPT-5', 'OpenAI'], value: 'exact-direct' },
  { name: 'vendor/another-model', description: 'tools supported · reasoning supported', searchTerms: ['Friendly Label', 'Other Gateway'], value: 'another' }
]
const found = query => matchingChoiceIndices(choices, query).map(index => choices[index].value)
test('search matches case-insensitive words across IDs, friendly names and provider labels in any order', () => {
  assert.deepEqual(found(' SONNET  ANTHROPIC 4.5 '), ['exact-claude'])
  assert.deepEqual(found('MINI openrouter GPT 5'), ['exact-mini'])
  assert.deepEqual(found('gateway friendly'), ['another'])
  assert.deepEqual(found('ClAuDe'), ['exact-claude'])
  assert.deepEqual(found('ＧＰＴ ５ MINI'), ['exact-mini'])
  assert.deepEqual(found('supported'), []) // Capabilities do not masquerade as model names.
  assert.deepEqual(found('claude mini'), []) // Every query token must match.
})
test('ranking prioritizes exact IDs then exact names and prefixes with deterministic stable ties', () => {
  assert.deepEqual(found('gpt-5'), ['exact-direct', 'exact-gpt', 'exact-mini'])
  assert.deepEqual(found('openai/gpt-5'), ['exact-gpt', 'exact-mini', 'exact-direct'])
  assert.deepEqual(found('GPT'), ['exact-direct', 'exact-mini', 'exact-gpt'])
  assert.deepEqual(found('openrouter'), ['exact-claude', 'exact-mini', 'exact-gpt'])
  assert.deepEqual(matchingChoiceIndices(choices, ''), [0, 1, 2, 3, 4])
  assert.deepEqual(matchingChoiceIndices(choices, ' \t '), [0, 1, 2, 3, 4])
  assert.deepEqual(matchingChoiceIndices([], 'anything'), [])
})
test('search reaches the end of large catalogs and keeps exact values and input order intact', () => {
  const catalog = Array.from({ length: 5000 }, (_, index) => ({ name: `vendor/model-${index}`, searchTerms: ['Any Provider'], value: { index } }))
  const before = structuredClone(catalog)
  assert.equal(matchingChoiceIndices(catalog, 'model 4999')[0], 4999)
  assert.equal(matchingChoiceIndices(catalog, 'PROVIDER 4999 vendor')[0], 4999)
  assert.deepEqual(catalog, before)
  assert.equal(matchingChoiceIndices(catalog, '').length, 5000)
})
