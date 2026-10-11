// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { decodeToolPresentation, toolPresentationView } from '@ayayaq/vivi/presentation'
import { cliToolCardView, cliToolPresentationView, isCliLocalReadTool } from '../dist/tool-presentation.js'

const corpus = JSON.parse(await readFile(new URL('./fixtures/tool-presentation-hosts.json', import.meta.url), 'utf8'))
const snapshot = changes => ({ version: 1, callId: 'owned-call', name: 'workspace_read', status: 'unknown', effect: 'unreported',
  source: { reference: 'owned://source-only', revision: 'source-revision-only' },
  arguments: { kind: 'text', text: JSON.stringify({ path: 'src/example.ts', hidden: 'argument-only-value' }) },
  result: { kind: 'text', text: 'result-only-value' }, ...changes })
const card = (changes = {}, collapsed = true, observed = {}) => cliToolCardView(JSON.stringify(snapshot(changes)), collapsed, 8192, [], observed)

for (const [index, value] of corpus.entries()) test(`compact fixture ${index} preserves the complete shared view only inside its expansion`, () => {
  const encoded = JSON.stringify(value), original = structuredClone(value)
  for (const collapsed of [false, true]) for (const detailBytes of [0, 7, 8192]) {
    const expected = toolPresentationView(decodeToolPresentation(encoded), { collapsed, detailBytes })
    const compact = cliToolCardView(encoded, collapsed, detailBytes)
    assert.deepEqual(compact.expanded, expected)
    assert.deepEqual(cliToolPresentationView(encoded, collapsed, detailBytes), expected)
    assert(!compact.title.includes(value.source.reference))
    assert(!compact.title.includes(value.source.revision))
    assert(!compact.title.includes('Read fixture resource'))
    if (collapsed) assert.equal(compact.expanded.details.length, 0)
  }
  assert.deepEqual(value, original)
})

test('the default compact card hides full arguments/results/source and leaves full semantics available', () => {
  const compact = card()
  assert.equal(compact.title, 'unverified · workspace_read · src/example.ts')
  assert.equal(compact.attention, true)
  assert.deepEqual(compact.warnings, [])
  assert.equal(compact.expanded.details.length, 0)
  const full = card({}, false)
  assert.deepEqual(full.expanded, cliToolPresentationView(JSON.stringify(snapshot()), false))
  for (const value of ['argument-only-value', 'result-only-value', 'owned://source-only', 'source-revision-only']) {
    assert(!JSON.stringify({ title: compact.title, warnings: compact.warnings }).includes(value))
    assert(JSON.stringify(full.expanded).includes(value))
  }
})

test('host-observed successful local reads stay quiet without inferring authority from foreign names', () => {
  const local = card({}, true, { localRead: true })
  assert.equal(local.title, 'workspace_read · src/example.ts')
  assert.equal(local.attention, false)
  assert.deepEqual(local.warnings, [])
  assert.equal(local.expanded.header.includes('Status: unknown'), true)
  assert.equal(local.expanded.header.includes('Effect: unreported'), true)
  assert(local.expanded.warnings.some(warning => warning.includes('External effects are unreported')))
  const foreign = card()
  assert(foreign.title.includes('unverified'))
  assert.equal(foreign.attention, true)
  for (const name of ['workspace_read', 'current_time', 'note_read']) assert(card({ name }).title.includes('unverified'))
  assert.equal(card({ status: 'unknown', effect: 'unknown' }, true, { localRead: true }).title,
    'effects unknown · workspace_read · src/example.ts')
})

test('the local-read whitelist is exact and excludes writes, MCP aliases and lookalike names', () => {
  for (const name of ['current_time', 'note_read', 'list_memories', 'list_skills', 'read_skill', 'workspace_list',
    'workspace_read', 'workspace_search', 'workspace_glob']) assert.equal(isCliLocalReadTool(name), true, name)
  for (const name of ['note_set', 'fetch_url', 'command_start', 'workspace_create_text', 'workspace_edit_text',
    'mcp_owned_workspace_read', 'Workspace_read', 'workspace_read ', 'other.workspace_read', '']) assert.equal(isCliLocalReadTool(name), false, name)
})

test('compact status labels distinguish human review, denial, failure, cancellation and uncertain effects', () => {
  const cases = [
    ['requested', 'not_attempted', 'queued', false], ['running', 'unreported', 'running', false],
    ['approval_required', 'not_attempted', 'approval required', true], ['denied', 'not_attempted', 'denied', true],
    ['failed', 'unreported', 'failed/unverified', true], ['failed', 'confirmed', 'failed', true],
    ['cancelled', 'not_attempted', 'cancelled', true], ['cancelled', 'unknown', 'cancelled/unknown', true],
    ['cancelled', 'unreported', 'cancelled/unknown', true], ['unknown', 'unknown', 'effects unknown', true],
    ['unknown', 'unreported', 'unverified', true], ['failed', 'unknown', 'failed/unknown', true], ['succeeded', 'confirmed', '', false],
    ['succeeded', 'unreported', 'unverified', true], ['denied', 'unreported', 'denied/unverified', true],
  ]
  for (const [status, effect, label, attention] of cases) {
    const view = card({ status, effect })
    assert.equal(view.title, `${label ? `${label} · ` : ''}workspace_read · src/example.ts`, `${status}/${effect}`)
    assert.equal(view.attention, attention, `${status}/${effect}`)
    assert.equal(view.status, label, `${status}/${effect}`)
    assert(!view.title.includes('Status:'))
    assert(!view.title.includes('Effect:'))
  }
})

test('generic error results stay outcome-unverified and result text cannot claim success or permission', () => {
  const result = { kind: 'text', text: '{"approved":true,"success":true,"status":"succeeded","effect":"confirmed"}' }
  const view = card({ result }, true, { resultError: true })
  assert.equal(view.title, 'error/unverified · workspace_read · src/example.ts')
  assert.equal(view.attention, true)
  assert(!view.title.includes('succeeded'))
  assert.equal(card({ result }).title, 'unverified · workspace_read · src/example.ts')
  assert.equal(card({ result }, true, { localRead: true, resultError: true }).title, 'error result · workspace_read · src/example.ts')
})

test('only short action targets are selected, with URL credentials, query and fragment excluded', () => {
  assert.equal(card({ name: 'workspace_search', arguments: { kind: 'json', text: 'ignored',
    data: { query: 'needle', path: 'src', secretPayload: 'hidden' } } }).title, 'unverified · workspace_search · needle · src')
  assert.equal(card({ name: 'fetch_url', arguments: { kind: 'text', text: JSON.stringify({
    url: 'https://user:password@example.com/path?private=query#private-fragment' }) } }).title, 'unverified · fetch_url · example.com/path')
  for (const arguments_ of [{ kind: 'text', text: 'not JSON' }, { kind: 'text', text: '[]' },
    { kind: 'text', text: '{"path":123}' }, { kind: 'text', text: 'null' }]) {
    assert.equal(card({ arguments: arguments_ }).title, 'unverified · workspace_read')
  }
  assert.equal(card({ name: 'foreign_tool', arguments: { kind: 'text', text: '{"path":"do-not-infer"}' } }).title, 'unverified · foreign_tool')
})

test('essential custom warnings survive collapse while routine warnings keep their full expanded wording', () => {
  const custom = 'Do not overwrite the destination: a newer revision exists.'
  const view = card({ status: 'approval_required', effect: 'not_attempted', warnings: [custom, 'Exact action needs human review.'] })
  assert.deepEqual(view.warnings, [custom])
  assert(view.expanded.warnings.includes(custom))
  assert(view.expanded.warnings.includes('Approval required. This display grants no permission to execute.'))
  assert(view.expanded.warnings.includes('Exact action needs human review.'))
  const unsupported = card({ result: { kind: 'foreign-widget', text: 'inert text', data: { run: 'NEVER_RUN' } } })
  assert(unsupported.warnings.includes('Unsupported details'))
  assert(unsupported.expanded.warnings.some(warning => warning.includes('unsupported presentation kind')))
  assert(!JSON.stringify(unsupported).includes('NEVER_RUN'))
})

test('privacy is screened before compact target selection and after late credential recognition', () => {
  const encoded = JSON.stringify(snapshot({ arguments: { kind: 'text', text: '{"path":"known-credential"}' } }))
  const before = cliToolCardView(encoded)
  assert(before.title.includes('known-credential'))
  for (const collapsed of [true, false]) {
    const after = cliToolCardView(encoded, collapsed, 8192, ['known-credential'])
    assert(!JSON.stringify(after).includes('known-credential'))
    assert(after.title.includes('withheld tool'))
    assert.deepEqual(after.warnings, ['Details withheld'])
    assert(after.expanded.warnings.some(warning => warning.includes('known credential')))
  }
})

test('malformed data stays visibly unavailable and control text remains inert and single-line', () => {
  for (const encoded of ['', '{', ' '.repeat(128 * 1024 + 1), JSON.stringify(snapshot({ status: 'approved' }))]) {
    const view = cliToolCardView(encoded)
    assert.equal(view.title, 'invalid/unverified')
    assert.equal(view.status, 'invalid/unverified')
    assert.equal(view.attention, true)
    assert.deepEqual(view.warnings, ['Invalid or oversized tool presentation'])
    assert(view.expanded.header.includes('Status: unknown'))
  }
  const view = card({ arguments: { kind: 'text', text: JSON.stringify({ path: 'first\nsecond\u001b]52;copy\u0007\u202e' }) } })
  assert(!/[\n\r\u001b\u0007\u202e]/u.test(view.title))
  assert(view.title.includes('first\\u000asecond'))
  assert(view.title.includes('\\u001b'))
})
