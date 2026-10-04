// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const launcher = new URL('../dist/launcher.js', import.meta.url).href
const wrapper = `Object.defineProperty(process.stdin,'isTTY',{value:true});
Object.defineProperty(process.stdout,'isTTY',{value:true}); await import(${JSON.stringify(launcher)});`

for (const signal of ['SIGTERM', 'SIGHUP']) {
  test(`Node launcher stays alive for child Ctrl-C cancellation and forwards ${signal}`, { skip: process.platform === 'win32', timeout: 6000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'vivi-launcher-signals-'))
    const bin = join(directory, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'bun'), `#!/usr/bin/env node
process.on('SIGINT',()=>process.stdout.write('BUN_CANCEL\\n'));
process.on('SIGTERM',()=>{process.stdout.write('BUN_TERM\\n');process.exit(0)});
process.on('SIGHUP',()=>{process.stdout.write('BUN_HUP\\n');process.exit(0)});
process.stdout.write('BUN_READY\\n');setInterval(()=>{},1000);
`, { mode: 0o700 })
    const child = spawn(process.execPath, ['--input-type=module', '-e', wrapper], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
    })
    let output = ''; let errors = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { errors += chunk })
    const exiting = new Promise(resolve => child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal })))
    t.after(async () => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* already reaped */ }
      await rm(directory, { recursive: true, force: true })
    })
    const waitFor = text => new Promise((resolve, reject) => {
      if (output.includes(text)) { resolve(); return }
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Missing ${text}: ${output}\n${errors}`)) }, 3000)
      const check = () => { if (output.includes(text)) { cleanup(); resolve() } }
      const cleanup = () => { clearTimeout(timer); child.stdout.off('data', check) }
      child.stdout.on('data', check)
    })
    await waitFor('BUN_READY')
    process.kill(-child.pid, 'SIGINT')
    await waitFor('BUN_CANCEL')
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null)
    child.kill(signal)
    assert.deepEqual(await exiting, { code: 0, signal: null })
    assert.match(output, signal === 'SIGTERM' ? /BUN_TERM/ : /BUN_HUP/)
  })
}
