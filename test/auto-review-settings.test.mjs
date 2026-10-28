// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUTO_REVIEW_DEFAULT_PERMILLE, formatAutoReviewThreshold, parseAutoReviewThresholdPercent,
  resolveAutoReviewThreshold, validateAutoReviewThresholdOverrides } from '../dist/auto-review-settings.js'
import { chooseAutoReviewThreshold } from '../dist/auto-review-controls.js'

test('reviewer-specific defaults and overrides preserve fixed rejection threshold', () => {
  assert.deepEqual(AUTO_REVIEW_DEFAULT_PERMILLE, { openai: 995, openrouter: 999 })
  assert.deepEqual(resolveAutoReviewThreshold('openai'), { allowAt: 0.995, denyAt: 0.05, allowPermille: 995 })
  assert.deepEqual(resolveAutoReviewThreshold('openrouter'), { allowAt: 0.999, denyAt: 0.05, allowPermille: 999 })
  const overrides = { openai: 900, openrouter: 973 }
  assert.deepEqual(resolveAutoReviewThreshold('openai', overrides), { allowAt: 0.9, denyAt: 0.05, allowPermille: 900 })
  assert.deepEqual(resolveAutoReviewThreshold('openrouter', overrides), { allowAt: 0.973, denyAt: 0.05, allowPermille: 973 })
  assert.deepEqual(resolveAutoReviewThreshold('openrouter', { openai: 900 }), { allowAt: 0.999, denyAt: 0.05, allowPermille: 999 })
  assert.throws(() => resolveAutoReviewThreshold('deepseek'), /Invalid Auto review threshold/)
})

test('decimal input is exact from 90 through 100 at 0.1 percentage-point precision without rounding', () => {
  for (let value = 900; value <= 1000; value++) {
    const text = formatAutoReviewThreshold(value)
    assert.equal(parseAutoReviewThresholdPercent(text.slice(0, -1)), value)
  }
  for (const [text, value] of [['90', 900], ['90.0', 900], ['99.9', 999], ['100', 1000], ['100.0', 1000], [' 95.5 ', 955]]) {
    assert.equal(parseAutoReviewThresholdPercent(text), value)
  }
  for (const invalid of ['', '89.9', '100.1', '95.00', '99.99', '90%', '+95', '-95', '9e1', '090', '0.95', '95,5', 'NaN', 'Infinity', '95\n96', null, 95]) {
    assert.throws(() => parseAutoReviewThresholdPercent(invalid), /Invalid Auto review threshold/)
  }
  assert.equal(formatAutoReviewThreshold(900), '90%')
  assert.equal(formatAutoReviewThreshold(995), '99.5%')
  for (const invalid of [899, 1001, 999.1, NaN, Infinity, '995']) assert.throws(() => formatAutoReviewThreshold(invalid))
})

test('threshold metadata validator is a closed copied whitelist without getter calls', () => {
  const input = { openai: 955, openrouter: 1000 }
  const captured = validateAutoReviewThresholdOverrides(input)
  input.openai = 900
  assert.deepEqual(captured, { openai: 955, openrouter: 1000 })
  assert.deepEqual(validateAutoReviewThresholdOverrides(Object.assign(Object.create(null), { openai: 995 })), { openai: 995 })
  let called = 0
  const getter = Object.defineProperty({}, 'openai', { enumerable: true, get() { called++; return 900 } })
  for (const invalid of [null, [], false, 955, { deepseek: 950 }, { openai: undefined }, { openai: 89 }, { openai: 899 },
    { openai: 1001 }, { openai: 999.5 }, { openai: NaN }, { openai: Infinity }, { openai: '950' },
    { openai: 950, extra: 900 }, { toJSON() { called++; return {} } }, getter,
    Object.create({ openai: 950 }), Object.defineProperty({}, 'openai', { value: 950 }), { [Symbol('openai')]: 950 }]) {
    assert.throws(() => validateAutoReviewThresholdOverrides(invalid), /Invalid Auto review threshold/)
  }
  assert.equal(called, 0)
})

function ioFixture({ selection, text = [], closed = false, onChoose, onAsk } = {}) {
  const state = { writes: [], choices: [], asks: [] }
  const io = { isClosed: closed,
    write(value) { state.writes.push(value) },
    async choose(title, choices, index) { state.choices.push({ title, choices, index }); await onChoose?.(io); return selection },
    async askText(title, initial) { state.asks.push({ title, initial }); await onAsk?.(io); return text.shift() }
  }
  return { io, state }
}

test('threshold menu offers exact agreed choices and resets only selected reviewer', async () => {
  const input = { openai: 900, openrouter: 955 }
  const { io, state } = ioFixture({ selection: 'default' })
  const reset = await chooseAutoReviewThreshold(io, 'openai', input)
  assert.deepEqual(reset, { openrouter: 955 })
  assert.deepEqual(input, { openai: 900, openrouter: 955 })
  assert.deepEqual(state.choices[0].choices.map(choice => choice.name), ['Default', '90%', '95%', '99%', 'Custom'])
  assert.equal(state.choices[0].index, 1)
  assert.match(state.choices[0].choices[0].description, /99\.5%/)
  assert.match(state.writes.join(''), /not an overall approval probability/)
  assert.match(state.writes.join(''), /uncalibrated.*Lower thresholds.*fresh enrollment/)
  const router = ioFixture({ selection: 'default' })
  await chooseAutoReviewThreshold(router.io, 'openrouter')
  assert.match(router.state.choices[0].choices[0].description, /99\.9%/)
  assert.equal(router.state.choices[0].index, 0)
})

test('menu presets and custom preserve the other reviewer and return independent data', async () => {
  for (const selection of [900, 950, 990]) {
    const { io } = ioFixture({ selection })
    assert.deepEqual(await chooseAutoReviewThreshold(io, 'openai', { openrouter: 999 }), { openai: selection, openrouter: 999 })
  }
  const input = { openai: 995, openrouter: 990 }
  const { io, state } = ioFixture({ selection: 'custom', text: ['99.99', '89.9', '97.3'], onChoose() { input.openrouter = 900 } })
  assert.deepEqual(await chooseAutoReviewThreshold(io, 'openai', input), { openai: 973, openrouter: 990 })
  assert.equal(state.asks.length, 3)
  assert.equal(state.asks[0].initial, '99.5')
  assert.equal(state.choices[0].index, 4)
  assert.equal(state.writes.filter(text => text.includes('No setting was changed')).length, 2)
})

test('dismissed picker/custom prompt and closed surface cannot change settings', async () => {
  const original = { openai: 955, openrouter: 999 }
  for (const options of [{ selection: undefined }, { selection: 'custom', text: [undefined] },
    { selection: 900, onChoose(io) { io.isClosed = true } },
    { selection: 'custom', text: ['90'], onAsk(io) { io.isClosed = true } }]) {
    const { io } = ioFixture(options)
    assert.equal(await chooseAutoReviewThreshold(io, 'openai', original), undefined)
    assert.deepEqual(original, { openai: 955, openrouter: 999 })
  }
  const closed = ioFixture({ selection: 900, closed: true })
  assert.equal(await chooseAutoReviewThreshold(closed.io, 'openai', original), undefined)
  assert.equal(closed.state.choices.length, 0)
  const { io } = ioFixture({ selection: 'unexpected' })
  await assert.rejects(chooseAutoReviewThreshold(io, 'openai', original), /Invalid Auto review threshold choice/)
})
