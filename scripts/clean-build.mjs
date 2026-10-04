// SPDX-License-Identifier: Apache-2.0
import { rm } from 'node:fs/promises'

await rm(new URL('../dist/', import.meta.url), { recursive: true, force: true })
