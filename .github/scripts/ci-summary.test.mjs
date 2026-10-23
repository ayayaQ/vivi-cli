// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { requiredJobs, requireSuccessfulChecks } from './ci-summary.mjs'

const events = ['pull_request', 'push', 'workflow_dispatch']
const successfulNeeds = event => Object.fromEntries(requiredJobs.map(job => [job, {
  result: (event === 'pull_request' ? ['mcp', 'headless'].includes(job) : job === 'current-compatibility') ? 'skipped' : 'success'
}]))

for (const event of events) {
  test(`${event}: accepts exactly the intended successful checks`, () => {
    requireSuccessfulChecks(event, successfulNeeds(event))
  })
  test(`${event}: every failure, cancellation and unexpected skip fails closed`, () => {
    for (const job of requiredJobs) {
      for (const result of ['success', 'failure', 'cancelled', 'skipped', 'neutral', undefined]) {
        const needs = successfulNeeds(event)
        if (needs[job].result === result) continue
        needs[job] = { result }
        assert.throws(() => requireSuccessfulChecks(event, needs), new RegExp(job))
      }
    }
  })
  test(`${event}: missing and untracked dependencies are rejected`, () => {
    for (const job of requiredJobs) {
      const needs = successfulNeeds(event)
      delete needs[job]
      assert.throws(() => requireSuccessfulChecks(event, needs), /dependency set/)
    }
    assert.throws(() => requireSuccessfulChecks(event, { ...successfulNeeds(event), extra: { result: 'success' } }), /dependency set/)
  })
}

test('invalid event or dependency data cannot pass', () => {
  for (const event of ['', undefined, 'workflow_run']) assert.throws(() => requireSuccessfulChecks(event, successfulNeeds('pull_request')))
  for (const needs of [undefined, null, [], 'success']) assert.throws(() => requireSuccessfulChecks('pull_request', needs))
})

test('the CLI returns nonzero on failed or malformed dependencies', () => {
  const script = fileURLToPath(new URL('./ci-summary.mjs', import.meta.url))
  for (const [needs, status] of [[JSON.stringify(successfulNeeds('pull_request')), 0], ['{}', 1], ['not JSON', 1]]) {
    const run = spawnSync(process.execPath, [script], {
      env: { ...process.env, CI_EVENT_NAME: 'pull_request', CI_NEEDS: needs }, encoding: 'utf8'
    })
    assert.equal(run.status, status)
  }
  const needs = successfulNeeds('pull_request')
  needs.candidate.result = 'failure'
  assert.equal(spawnSync(process.execPath, [script], {
    env: { ...process.env, CI_EVENT_NAME: 'pull_request', CI_NEEDS: JSON.stringify(needs) }
  }).status, 1)
})

test('summary names every workflow job and always evaluates prerequisite outcomes', () => {
  const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8')
  const jobs = [...workflow.matchAll(/^  ([a-z][a-z-]*):$/gm)].map(match => match[1])
    .filter(name => !['push', 'pull_request', 'workflow_dispatch'].includes(name))
  assert.deepEqual(jobs.sort(), [...requiredJobs, 'summary'].sort())
  assert.doesNotMatch(workflow, /continue-on-error:/, 'A failing execution job must not be allowed to pass')
  const summary = workflow.split('\n  summary:\n')[1]
  assert.match(summary, /if: \$\{\{ always\(\) \}\}/)
  const dependencies = summary.match(/needs: \[([^\]]+)\]/)[1].split(',').map(job => job.trim())
  assert.deepEqual(dependencies.sort(), [...requiredJobs].sort())
  assert.match(summary, /CI_EVENT_NAME: \$\{\{ github.event_name \}\}/)
  assert.match(summary, /CI_NEEDS: \$\{\{ toJSON\(needs\) \}\}/)
})

test('workflow implements the exact PR and main/manual coverage topology', () => {
  const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8')
  const job = name => workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z][a-z-]*:\n/)[0]
  for (const name of ['mcp', 'headless']) {
    assert.match(job(name), /if: github.event_name != 'pull_request'/)
    assert.match(job(name), /node: \['26\.4\.0', '26'\]/)
    assert.match(job(name), new RegExp(`run: node scripts/ci-tests.mjs windows-${name}`))
  }
  assert.match(job('current-compatibility'), /if: github.event_name == 'pull_request'/)
  assert.match(job('current-compatibility'), /run: node scripts\/ci-tests.mjs windows-current/)
  assert.match(job('check'), /node: '26\.4\.0'\s+group: linux-node/)
  assert.match(job('check'), /group: \$\{\{ github.event_name == 'pull_request' && 'linux-current' \|\| 'linux-node' \}\}/)
  assert.match(job('check'), /run: node scripts\/ci-tests.mjs \$\{\{ matrix.group \}\}/)
  assert.match(job('bun'), /if: github.event_name == 'pull_request'\s+run: node scripts\/ci-tests.mjs windows-minimum/)
  for (const name of ['bun', 'candidate', 'packaged-conpty']) assert.match(job(name), /bun-version: 1\.4\.2/)
  for (const name of ['bun', 'candidate']) assert.match(job(name), /run: node scripts\/ci-tests.mjs bun-tui/)
  for (const name of ['bun', 'current-compatibility', 'headless']) {
    assert.match(job(name), /uses: actions\/download-artifact@v4/)
    assert.match(job(name), /name: canonical-private-npm-candidate/)
    assert.match(job(name), /run: npm run test:package:built/)
    assert.match(job(name), /VIVI_TEST_PACKAGE_ARCHIVE:.*ayayaq-vivi-cli-0\.1\.0-dev\.0.tgz/)
    assert.match(job(name), /VIVI_TEST_PACKAGE_METADATA:.*candidate.json/)
  }
  assert.match(workflow, /push:\s+branches: \[main\]/)
  assert.match(workflow, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/)
})
