// SPDX-License-Identifier: Apache-2.0
import { OpenTuiIO } from '../../src/tui.js'

// Real native terminal teardown, without a provider, credentials or human input.
const io = await OpenTuiIO.create({ oneShot: true })
io.runStarted()
const outcome = process.argv[2]
if (outcome === 'completed' || outcome === 'error' || outcome === 'cancelled') io.runFinished(outcome)
io.close()
await new Promise(resolve => setTimeout(resolve, 20))
io.close()
