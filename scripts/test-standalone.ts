// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const directory = await mkdtemp(join(tmpdir(), 'vivi-compiled-consumer-'))
try {
  const executable = join(directory, process.platform === 'win32' ? 'probe.exe' : 'probe')
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL('./standalone-probe.ts', import.meta.url))],
    compile: { outfile: executable },
    ...(process.platform === 'linux' ? { define: { 'process.env.OPENTUI_LIBC': JSON.stringify(process.env.OPENTUI_LIBC === 'musl' ? 'musl' : 'glibc') } } : {})
  })
  if (!result.success) throw new AggregateError(result.logs, 'Compiled headless consumer build failed')
  const run = spawnSync(executable, [], { cwd: directory, encoding: 'utf8', timeout: 30000 })
  if (run.error || run.status !== 0) throw new Error(`Compiled headless consumer failed: ${run.error?.message ?? ''}\n${run.stdout}\n${run.stderr}`)
  console.log(run.stdout.trim())
} finally { await rm(directory, { recursive: true, force: true }) }
