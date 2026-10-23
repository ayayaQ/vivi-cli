// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

// Keep this list aligned with summary.needs. Unexpected/missing jobs fail closed.
export const requiredJobs = ['check', 'candidate', 'mcp', 'headless', 'current-compatibility', 'bun', 'packaged-conpty']

export function expectedResult(event, job) {
  if (event === 'pull_request' && ['mcp', 'headless'].includes(job)) return 'skipped'
  if (event !== 'pull_request' && job === 'current-compatibility') return 'skipped'
  return 'success'
}

export function requireSuccessfulChecks(event, needs) {
  assert(['pull_request', 'push', 'workflow_dispatch'].includes(event), `Unexpected CI event: ${event}`)
  assert(needs && typeof needs === 'object' && !Array.isArray(needs), 'CI needs must be an object')
  assert.deepEqual(Object.keys(needs).sort(), [...requiredJobs].sort(), 'CI dependency set does not match the summary policy')
  const problems = []
  for (const job of requiredJobs) {
    // Only the event-specific broad/smoke alternatives may be skipped.
    const expected = expectedResult(event, job)
    const actual = needs[job]?.result
    if (actual !== expected) problems.push(`${job}: expected ${expected}, received ${actual}`)
  }
  assert.equal(problems.length, 0, problems.join('\n'))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  requireSuccessfulChecks(process.env.CI_EVENT_NAME, JSON.parse(process.env.CI_NEEDS ?? 'null'))
  console.log('All expected CI checks succeeded; only event-specific skips were accepted.')
}
