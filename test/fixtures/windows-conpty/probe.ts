// SPDX-License-Identifier: Apache-2.0
// Private ConPTY child using the exact production renderer factory and diagnostic route.
// No provider, user session, desktop, physical keyboard or clipboard is opened.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pasteText } from './protocol.mjs'

const [repository, prefix] = process.argv.slice(2)
if (!repository || !prefix || process.platform !== 'win32' || !process.versions.bun) process.exit(2)
if (process.env.OTUI_STDIN_LOG || ['OTUI_DEBUG', 'OTUI_DEBUG_FFI', 'OTUI_TRACE_FFI', 'OTUI_DUMP_CAPTURES']
  .some(name => ['true', '1', 'on', 'yes'].includes((process.env[name] ?? '').trim().toLowerCase()))) process.exit(2)
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(2)

const { StdinParser } = await import(pathToFileURL(Bun.resolveSync('@opentui/core', repository)).href)
const { WindowsInputDecoder } = await import(pathToFileURL(resolve(repository, 'src/windows-input.ts')).href)
const { inputProbe } = await import(pathToFileURL(resolve(repository, 'src/input-diagnostic.ts')).href)
const { OpenTuiIO } = await import(pathToFileURL(resolve(repository, 'src/tui.ts')).href)
const originalRaw = process.stdin.isRaw === true
const originalFlowing = process.stdin.readableFlowing === true
const controls = { query: 0, enable: 0, disable: 0 }
const pasteSummary = { count: 0, matchesKnownFixture: false, byteCount: 0 }
const restoration = { rawCR: false, win32Records: 0, rawModeRestored: false, flowingRestored: false }
const restorationDecoder = new WindowsInputDecoder()
let io: InstanceType<typeof OpenTuiIO> | undefined
let diagnostic: Awaited<ReturnType<InstanceType<typeof OpenTuiIO>['diagnoseInput']>> | undefined
let postCloseParser: InstanceType<typeof StdinParser> | undefined
let readyTimer: ReturnType<typeof setInterval> | undefined
let restorationTimer: ReturnType<typeof setTimeout> | undefined
let failed = false, finished = false, unknownKeyCount = 0, releaseCount = 0, closeObserved = false

// Observe only the bridge's exact protocol writes. Native rendering is left entirely unchanged.
const stdoutWrite = process.stdout.write.bind(process.stdout)
process.stdout.write = ((chunk: unknown, ...args: unknown[]) => {
  if (chunk === '\x1b[?9001$p') controls.query++
  if (chunk === '\x1b[?9001h') controls.enable++
  if (chunk === '\x1b[?9001l') controls.disable++
  return (stdoutWrite as (...values: unknown[]) => boolean)(chunk, ...args)
}) as typeof process.stdout.write

const saveAndExit = (exitCode: number): void => {
  if (finished) return
  finished = true
  clearTimeout(watchdog); clearInterval(readyTimer); clearTimeout(restorationTimer)
  try { io?.close() } catch { failed = true }
  postCloseParser?.destroy()
  process.stdin.removeListener('data', postCloseData)
  // Defensive cleanup is separate from the bridge-close observations recorded below.
  process.stdin.setRawMode(originalRaw)
  if (originalFlowing) process.stdin.resume(); else process.stdin.pause()
  process.stdout.write = stdoutWrite
  const report = {
    platform: process.platform, bun: process.versions.bun, nodeCompatibilityVersion: process.versions.node,
    stdinTTY: process.stdin.isTTY === true, stdoutTTY: process.stdout.isTTY === true,
    failed: failed || diagnostic?.failed === true, windows: diagnostic?.windows,
    controls, probes: diagnostic?.probes ?? [], paste: pasteSummary, unknownKeyCount, releaseCount, restoration
  }
  // Allowlisted metadata only. No input text/bytes, paths, environment, or full exceptions are persisted.
  writeFileSync(`${prefix}.json`, JSON.stringify(report))
  process.exit(exitCode || (failed ? 1 : 0))
}
const postCloseData = (chunk: Buffer): void => {
  const decoded = restorationDecoder.write(chunk.toString('utf8'))
  restoration.win32Records = restorationDecoder.enterRecordsObserved
  if (decoded) postCloseParser!.push(Buffer.from(decoded))
  postCloseParser!.drain(event => {
    if (event.type !== 'key') return
    const key = event.key
    if (key.name === 'return' && !key.shift && key.source === 'raw') {
      restoration.rawCR = true
      clearTimeout(restorationTimer)
      restorationTimer = setTimeout(() => saveAndExit(0), 40)
    }
  })
}
const watchdog = setTimeout(() => { failed = true; saveAndExit(1) }, 18000)
process.on('uncaughtException', () => { failed = true; saveAndExit(1) })
process.on('unhandledRejection', () => { failed = true; saveAndExit(1) })

try {
  // This is the real factory: native output setup occurs before bridge.start(), exactly as in the CLI.
  io = await OpenTuiIO.create({ stream: false })
  const bridge = io.windowsInput
  if (!bridge) throw new Error('Windows input bridge missing')
  const bridgeClose = bridge.close.bind(bridge)
  bridge.close = (): void => {
    try { bridgeClose() }
    finally {
      if (!closeObserved) {
        closeObserved = true
        // Record the production bridge's restoration before renderer or fixture cleanup can mask it.
        restoration.rawModeRestored = (process.stdin.isRaw === true) === originalRaw
        restoration.flowingRestored = (process.stdin.readableFlowing === true) === originalFlowing
      }
    }
  }
  // Prepend these observers because the diagnostic consumes key events before editor handlers.
  io.renderer.keyInput.prependListener('keypress', key => {
    if (key.name !== 'escape' && !inputProbe(key)) unknownKeyCount++
  })
  io.renderer.keyInput.prependListener('keyrelease', () => { releaseCount++ })
  io.renderer.keyInput.prependListener('paste', event => {
    const expected = Buffer.from(pasteText)
    pasteSummary.count++
    pasteSummary.byteCount += event.bytes.byteLength
    pasteSummary.matchesKnownFixture = pasteSummary.count === 1 &&
      createHash('sha256').update(event.bytes).digest('hex') === createHash('sha256').update(expected).digest('hex')
  })
  const pending = io.diagnoseInput()
  readyTimer = setInterval(() => {
    if (bridge.diagnostic.modeReply === undefined) return
    clearInterval(readyTimer)
    writeFileSync(`${prefix}.ready`, 'ready')
  }, 5)
  diagnostic = await pending // Synthetic Escape closes the exact production surface.
  clearInterval(readyTimer)
  // A fresh raw reader proves consumer 9001l reset the inner encoder, independently of an outer DECRQM reply.
  // It receives just one known Shift+Enter tap in this same private ConPTY, then restores original state.
  postCloseParser = new StdinParser({ useKittyKeyboard: true, onTimeoutFlush: () => {} })
  process.stdin.setRawMode(true)
  process.stdin.on('data', postCloseData)
  process.stdin.resume()
  writeFileSync(`${prefix}.restore-ready`, 'ready')
  restorationTimer = setTimeout(() => { failed = true; saveAndExit(1) }, 4000)
} catch {
  failed = true
  saveAndExit(1)
}
