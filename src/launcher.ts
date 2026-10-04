#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const fullScreen = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !args.includes('--no-tui') &&
  !args.includes('--help') && !args.includes('-h') && (!args.includes('--prompt') || args.includes('--tui'))
if (fullScreen && !('bun' in process.versions)) {
  const child = spawn('bun', [fileURLToPath(new URL('./main.js', import.meta.url)), ...args], { stdio: 'inherit', shell: false })
  // Both processes receive foreground-group Ctrl-C. Bun owns cancel/exit semantics;
  // the wrapper must remain alive and must not forward a duplicate SIGINT.
  const interrupt = (): void => undefined
  const terminate = (): void => { child.kill('SIGTERM') }
  const hangup = (): void => { child.kill('SIGHUP') }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  process.on('SIGHUP', hangup)
  try {
    process.exitCode = await new Promise<number>((resolve) => {
      child.once('error', () => {
        process.stderr.write('The full-screen UI requires Bun >=1.3.0. Install Bun from https://bun.sh and run vivi again.\nUse vivi --no-tui --model MODEL for accessible Node line mode.\n')
        resolve(1)
      })
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)))
    })
  } finally {
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
    process.off('SIGHUP', hangup)
  }
} else {
  const { main } = await import('./main.js')
  process.exitCode = await main(args)
}
