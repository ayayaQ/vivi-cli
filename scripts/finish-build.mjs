// SPDX-License-Identifier: Apache-2.0
import { chmod } from 'node:fs/promises'

await chmod(new URL('../dist/main.js', import.meta.url), 0o755)
await chmod(new URL('../dist/launcher.js', import.meta.url), 0o755)
