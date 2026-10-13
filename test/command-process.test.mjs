// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { launchCommandProcess } from '../dist/command-process.js'
import { commandEnvironment } from '../dist/commands.js'

const input = args => ({ executable: process.execPath, args, cwd: process.cwd(), env: commandEnvironment(process.env) })
async function absent(pid) {
    try { process.kill(pid, 0) }
    catch (error) { if (error.code === 'ESRCH') return true; throw error }
    if (process.platform !== 'win32') {
      // A killed orphan may remain a zombie until the container's init reaps it;
      // it is terminated and can no longer execute or retain pipe handles.
      const fs = await import('node:fs/promises')
      try { if ((await fs.readFile(`/proc/${pid}/stat`, 'utf8')).split(') ')[1]?.startsWith('Z ')) return true }
      catch { return true }
    }
  return false
}
test('process cleanup terminates an inherited grandchild after its command parent exits', async t => {
  const process_ = await launchCommandProcess(input(['--input-type=module', '-e', `import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);child.unref();process.exit(0)`]))
  t.after(() => process_.stop())
  let output = ''; process_.stdout.on('data', chunk => { output += chunk })
  const result = await process_.completed
  assert.equal(result.exitCode, 0)
  const pid = Number(output.trim()); assert(Number.isInteger(pid) && pid > 0)
  assert.equal(await absent(pid), true)
})
test('stopping a process cleans up both command and inherited grandchild before completion', async t => {
  const process_ = await launchCommandProcess(input(['--input-type=module', '-e', `import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`]))
  t.after(() => process_.stop())
  let output = '', ready
  const received = new Promise(resolve => { ready = resolve })
  process_.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) ready() })
  await received; const pids = JSON.parse(output.trim())
  await process_.stop(); for (const pid of pids) assert.equal(await absent(pid), true)
  await process_.stop()
})
test('process launch errors settle without creating reusable sessions', async () => {
  const process_ = await launchCommandProcess({ ...input([]), executable: process.platform === 'win32' ? 'C:\\missing-fixture.exe' : '/missing-fixture-executable' })
  const result = await process_.completed; assert(result.error); await process_.stop()
})
