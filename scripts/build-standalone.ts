// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Build only the current platform. Cross-target claims require testing on each target.
await mkdir(new URL('../build/', import.meta.url), { recursive: true })
const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL('../dist/launcher.js', import.meta.url))],
  compile: { outfile: fileURLToPath(new URL(`../build/vivi${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url)) },
  ...(process.platform === 'linux' ? { define: { 'process.env.OPENTUI_LIBC': JSON.stringify(process.env.OPENTUI_LIBC === 'musl' ? 'musl' : 'glibc') } } : {})
})
if (!result.success) throw new AggregateError(result.logs, 'Standalone build failed')
// Preserve installed dependency notices alongside local artifacts. This is not a release pipeline.
const root = fileURLToPath(new URL('../', import.meta.url))
let notices = '# Local standalone dependency notices\n\nBun runtime licensing and relinking information: https://github.com/oven-sh/bun/blob/main/LICENSE.md\n\nReview the exact runtime release and all redistribution requirements before distributing an executable.\n\n'
async function collect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await collect(path)
    else if (entry.isFile() && /^(?:license|notice|attribution|thirdpartynotice)/i.test(entry.name)) {
      notices += `## ${path.slice(root.length)}\n\n${await readFile(path, 'utf8')}\n\n`
    }
  }
}
await collect(join(root, 'node_modules'))
for (const name of ['LICENSE', 'NOTICE']) notices += `## ${name}\n\n${await readFile(join(root, name), 'utf8')}\n\n`
await writeFile(new URL('../build/THIRD_PARTY_NOTICES.md', import.meta.url), notices)
console.log('Built the current-platform local executable and dependency notices in build/ (not a release)')
