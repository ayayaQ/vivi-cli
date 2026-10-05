// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aggregateUsage, formatUsage } from '../dist/usage.js'

const counts = { inputTokens: 3, outputTokens: 2, totalTokens: 5 }
const fields = ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens', 'cacheWriteInputTokens']
const maximum = Number.MAX_SAFE_INTEGER
const permutations = values => values.length === 0 ? [[]] : values.flatMap((value, index) =>
  permutations(values.filter((_, other) => index !== other)).map(rest => [value, ...rest]))

test('empty usage and unknown committed segments return reported zero counts without cache fields', () => {
  for (const segments of [[], [undefined], [undefined, undefined]]) {
    const actual = aggregateUsage(segments)
    assert.deepEqual(actual, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    assert.equal(Object.hasOwn(actual, 'cachedInputTokens'), false)
    assert.equal(Object.hasOwn(actual, 'cacheWriteInputTokens'), false)
  }
})

test('required counts are summed independently and cache subsets do not increase input or total', () => {
  const segments = [
    { inputTokens: 10, outputTokens: 4, totalTokens: 18, cachedInputTokens: 7, cacheWriteInputTokens: 3 },
    { inputTokens: 5, outputTokens: 2, totalTokens: 8, cachedInputTokens: 2, cacheWriteInputTokens: 1 }
  ]
  assert.deepEqual(aggregateUsage(segments), {
    inputTokens: 15, outputTokens: 6, totalTokens: 26, cachedInputTokens: 9, cacheWriteInputTokens: 4
  })
})

test('explicit zero reports are retained, including all-zero usage', () => {
  const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 }
  assert.deepEqual(aggregateUsage([zero, zero]), zero)
  assert.deepEqual(aggregateUsage([{ ...counts, cachedInputTokens: 0, cacheWriteInputTokens: 0 }, zero]), {
    ...counts, cachedInputTokens: 0, cacheWriteInputTokens: 0
  })
})

test('cache read and write completeness are independent in every segment order', () => {
  const complete = { ...counts, cachedInputTokens: 2, cacheWriteInputTokens: 1 }
  const readOnly = { ...counts, cachedInputTokens: 0 }
  const writeOnly = { ...counts, cacheWriteInputTokens: 0 }
  const required = { inputTokens: 6, outputTokens: 4, totalTokens: 10 }
  for (const segments of permutations([complete, readOnly])) {
    assert.deepEqual(aggregateUsage(segments), { ...required, cachedInputTokens: 2 })
  }
  for (const segments of permutations([complete, writeOnly])) {
    assert.deepEqual(aggregateUsage(segments), { ...required, cacheWriteInputTokens: 1 })
  }
  for (const segments of permutations([complete, readOnly, writeOnly])) {
    assert.deepEqual(aggregateUsage(segments), { inputTokens: 9, outputTokens: 6, totalTokens: 15 })
  }
})

test('absent and explicitly undefined optional counts stay unreported', () => {
  assert.deepEqual(aggregateUsage([counts]), counts)
  assert.deepEqual(aggregateUsage([{ ...counts, cachedInputTokens: undefined, cacheWriteInputTokens: undefined }]), counts)
  assert.deepEqual(aggregateUsage([
    { ...counts, cachedInputTokens: undefined, cacheWriteInputTokens: 0 },
    { ...counts, cachedInputTokens: 0, cacheWriteInputTokens: 0 }
  ]), { inputTokens: 6, outputTokens: 4, totalTokens: 10, cacheWriteInputTokens: 0 })
})

test('an unknown committed segment invalidates both cache aggregates in every position', () => {
  const reported = { ...counts, cachedInputTokens: 0, cacheWriteInputTokens: 1 }
  const another = { inputTokens: 7, outputTokens: 4, totalTokens: 13, cachedInputTokens: 3, cacheWriteInputTokens: 2 }
  for (const segments of permutations([reported, undefined, another])) {
    assert.deepEqual(aggregateUsage(segments), { inputTokens: 10, outputTokens: 6, totalTokens: 18 })
  }
  const sparse = [reported, , another]
  assert.deepEqual(aggregateUsage(sparse), { inputTokens: 10, outputTokens: 6, totalTokens: 18 })
})

test('valid maximum counts and nonstandard totals are kept without cross-field inference', () => {
  const unusual = { inputTokens: maximum, outputTokens: maximum, totalTokens: 0, cachedInputTokens: maximum, cacheWriteInputTokens: maximum }
  assert.deepEqual(aggregateUsage([unusual]), unusual)
  assert.deepEqual(aggregateUsage([
    { inputTokens: 1, outputTokens: 1, totalTokens: 0, cachedInputTokens: 8, cacheWriteInputTokens: 9 },
    { inputTokens: 0, outputTokens: 0, totalTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0 }
  ]), { inputTokens: 1, outputTokens: 1, totalTokens: 10, cachedInputTokens: 8, cacheWriteInputTokens: 9 })
})

test('all count fields reject negative, fractional, nonfinite, unsafe and nonnumeric reports', () => {
  const invalid = [-1, -0.5, 0.5, NaN, Infinity, -Infinity, maximum + 1, '3', null, true, false, 3n, {}, []]
  for (const field of fields) {
    for (const value of invalid) {
      const usage = { ...counts, cachedInputTokens: 0, cacheWriteInputTokens: 0, [field]: value }
      for (const operation of [() => aggregateUsage([usage]), () => formatUsage(usage)]) {
        assert.throws(operation, { name: 'RangeError', message: new RegExp(field) }, `${field}: ${String(value)}`)
      }
    }
  }
})

test('required fields must be reported rather than absent or undefined', () => {
  for (const field of fields.slice(0, 3)) {
    const missing = { ...counts }
    delete missing[field]
    for (const usage of [missing, { ...counts, [field]: undefined }]) {
      assert.throws(() => aggregateUsage([usage]), { name: 'RangeError', message: new RegExp(field) })
      assert.throws(() => formatUsage(usage), { name: 'RangeError', message: new RegExp(field) })
    }
  }
})

test('each aggregate rejects unsafe sums and accepts sums at the safe boundary', () => {
  const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 }
  for (const field of fields) {
    const first = { ...zero, [field]: maximum - 1 }
    const second = { ...zero, [field]: 1 }
    assert.deepEqual(aggregateUsage([first, second]), { ...zero, [field]: maximum })
    for (const segments of permutations([{ ...zero, [field]: maximum }, second])) {
      assert.throws(() => aggregateUsage(segments), { name: 'RangeError', message: new RegExp(`${field} sum`) })
    }
  }
})

test('unreported cache completeness never hides invalid individual reported counts', () => {
  for (const field of fields.slice(3)) {
    for (const value of [-1, maximum + 1, NaN, null]) {
      for (const missing of [counts, undefined]) {
        for (const segments of permutations([missing, { ...counts, [field]: value }])) {
          assert.throws(() => aggregateUsage(segments), { name: 'RangeError', message: new RegExp(field) })
        }
      }
    }
  }
})

test('unknown cache aggregates do not sum otherwise valid individual cache reports', () => {
  const maximumCache = { ...counts, cachedInputTokens: maximum, cacheWriteInputTokens: maximum }
  for (const segments of permutations([undefined, maximumCache, maximumCache])) {
    assert.deepEqual(aggregateUsage(segments), { inputTokens: 6, outputTokens: 4, totalTokens: 10 })
  }
  for (const field of fields.slice(3)) {
    for (const segments of permutations([counts, { ...counts, [field]: maximum }, { ...counts, [field]: maximum }])) {
      assert.deepEqual(aggregateUsage(segments), { inputTokens: 9, outputTokens: 6, totalTokens: 15 })
    }
  }
})

test('one incomplete cache field skips only its own sum and preserves the other complete aggregate', () => {
  for (const [missing, complete] of [['cachedInputTokens', 'cacheWriteInputTokens'], ['cacheWriteInputTokens', 'cachedInputTokens']]) {
    const segments = [{ ...counts, [complete]: 1 },
      { ...counts, [missing]: maximum, [complete]: 2 }, { ...counts, [missing]: maximum, [complete]: 3 }]
    for (const ordered of permutations(segments)) {
      assert.deepEqual(aggregateUsage(ordered), { inputTokens: 9, outputTokens: 6, totalTokens: 15, [complete]: 6 })
    }
    for (const ordered of permutations([
      { ...counts, [complete]: 1 }, { ...counts, [missing]: maximum, [complete]: maximum }
    ])) {
      assert.throws(() => aggregateUsage(ordered), { name: 'RangeError', message: new RegExp(`${complete} sum`) })
    }
  }
})

test('unknown segments and incomplete cache fields never suppress required total overflow', () => {
  for (const segments of permutations([undefined, { ...counts, totalTokens: maximum }, { ...counts, totalTokens: 1 }])) {
    assert.throws(() => aggregateUsage(segments), { name: 'RangeError', message: /totalTokens sum/ })
  }
})

test('aggregation and formatting leave frozen inputs unchanged and return fresh results', () => {
  const first = Object.freeze({ ...counts, cachedInputTokens: 0, cacheWriteInputTokens: 1 })
  const second = Object.freeze({ inputTokens: 7, outputTokens: 4, totalTokens: 13, cachedInputTokens: 3, cacheWriteInputTokens: 2 })
  const segments = Object.freeze([first, second])
  const before = structuredClone(segments)
  const actual = aggregateUsage(segments)
  assert.deepEqual(actual, { inputTokens: 10, outputTokens: 6, totalTokens: 18, cachedInputTokens: 3, cacheWriteInputTokens: 3 })
  formatUsage(first)
  assert.deepEqual(segments, before)
  assert.notEqual(aggregateUsage([first]), first)
  assert.notEqual(aggregateUsage(segments), actual)
  assert.notEqual(aggregateUsage([]), aggregateUsage([]))
  actual.inputTokens = 100
  actual.cachedInputTokens = 100
  assert.deepEqual(segments, before)
  const invalid = Object.freeze({ ...counts, cachedInputTokens: -1 })
  assert.throws(() => aggregateUsage(Object.freeze([first, invalid])), RangeError)
  assert.deepEqual(invalid, { ...counts, cachedInputTokens: -1 })
})

test('formatter preserves the familiar totals line and labels absent cache counts as unreported', () => {
  assert.equal(formatUsage(counts), '3 in / 2 out / 5 total\nCache input: read unreported / write unreported')
  assert.equal(formatUsage({ ...counts, cachedInputTokens: 0 }), '3 in / 2 out / 5 total\nCache input: read 0 / write unreported')
  assert.equal(formatUsage({ ...counts, cacheWriteInputTokens: 0 }), '3 in / 2 out / 5 total\nCache input: read unreported / write 0')
  assert.equal(formatUsage({ ...counts, cachedInputTokens: 0, cacheWriteInputTokens: 0 }), '3 in / 2 out / 5 total\nCache input: read 0 / write 0')
  assert.equal(formatUsage({ inputTokens: 10, outputTokens: 3, totalTokens: 99, cachedInputTokens: 4, cacheWriteInputTokens: 6 }),
    '10 in / 3 out / 99 total\nCache input: read 4 / write 6')
  assert.equal(formatUsage(aggregateUsage([])), '0 in / 0 out / 0 total\nCache input: read unreported / write unreported')
})
