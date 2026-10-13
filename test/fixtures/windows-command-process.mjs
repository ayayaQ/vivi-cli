// SPDX-License-Identifier: Apache-2.0
// Harmless process-tree fixture. Its safety timeout bounds leaks if cleanup fails.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const [mode, file, ...args] = process.argv.slice(2)
if (mode === 'argv') {
  process.stdout.write(JSON.stringify(args))
  process.stderr.write(Buffer.from([0, 255, 13, 10]))
} else {
  appendFileSync(file, JSON.stringify({ mode, pid: process.pid }) + '\n')
  const deadline = setTimeout(() => process.exit(0), 30_000)
  deadline.unref()
  if (mode === 'leaf') setInterval(() => {}, 100)
  else if (mode === 'middle') {
    const child = spawn(process.execPath, [import.meta.filename, 'leaf', file], { detached: true, stdio: 'ignore' })
    child.unref()
    const wait = setInterval(() => {
      if (existsSync(file) && readFileSync(file, 'utf8').includes('"mode":"leaf"')) { clearInterval(wait); process.exit(0) }
    }, 10)
  } else {
    const child = spawn(process.execPath, [import.meta.filename, 'middle', file], { detached: true, stdio: 'ignore' })
    child.unref()
    const wait = setInterval(() => {
      if (existsSync(file) && readFileSync(file, 'utf8').includes('"mode":"leaf"')) {
        clearInterval(wait)
        if (mode === 'orphan') process.exit(17)
        else setInterval(() => {}, 100)
      }
    }, 10)
  }
}
