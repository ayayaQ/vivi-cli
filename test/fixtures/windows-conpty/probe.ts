// SPDX-License-Identifier: Apache-2.0
// Private ConPTY child using the exact production renderer factory and diagnostic route.
// No provider, user session, desktop, physical keyboard or clipboard is opened.
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { pasteText } from './protocol.mjs'

const [repository, prefix] = process.argv.slice(2)
if (!repository || !prefix) process.exit(2)
// Fixed phase/protocol metadata helps diagnose a failed private harness without
// ever retaining native output, ordinary input, exceptions or environment data.
let phase = 'startup-checks'
const progressPath = `${prefix}.progress.json`
writeFileSync(progressPath, JSON.stringify({ phase, platform: process.platform, bun: process.versions.bun }))
const startup = { platform: process.platform, bun: process.versions.bun,
  stdinTTY: process.stdin.isTTY === true, stdoutTTY: process.stdout.isTTY === true }
const loading = (next: string): void => { phase = next; writeFileSync(progressPath, JSON.stringify({ phase, ...startup })) }
loading(phase)
if (process.platform !== 'win32' || !process.versions.bun) process.exit(2)
if (process.env.OTUI_STDIN_LOG || ['OTUI_DEBUG', 'OTUI_DEBUG_FFI', 'OTUI_TRACE_FFI', 'OTUI_DUMP_CAPTURES']
  .some(name => ['true', '1', 'on', 'yes'].includes((process.env[name] ?? '').trim().toLowerCase()))) process.exit(2)
if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(2)

loading('load-parser')
const { StdinParser } = await import(pathToFileURL(Bun.resolveSync('@opentui/core', repository)).href)
loading('load-decoder')
const { WindowsInputDecoder } = await import(pathToFileURL(resolve(repository, 'src/windows-input.ts')).href)
loading('load-diagnostic')
const { inputProbe } = await import(pathToFileURL(resolve(repository, 'src/input-diagnostic.ts')).href)
loading('load-tui')
const { OpenTuiIO } = await import(pathToFileURL(resolve(repository, 'src/tui.ts')).href)
const originalRaw = process.stdin.isRaw === true
const originalFlowing = process.stdin.readableFlowing === true
const controls = { query: 0, enable: 0, disable: 0 }
const pasteSummary = { count: 0, matchesKnownFixture: false, byteCount: 0, knownTransform: 'unknown',
  rawStartObserved: false, rawEndObserved: false }
const knownPasteVariants = new Map([
  [pasteText, 'literal'],
  [pasteText.replace(/\r/g, '\x1b[13;1u').replace(/\n/g, '\x1b[13;5u'), 'translated-return-linebreaks'],
  [pasteText.replace(/\r/g, '\x1b[13;1u').replace(/\n/g, '\x1b[106;5u'), 'translated-ctrl-j-linebreaks'],
  [pasteText.replace(/[\r\n]/g, '\x1b[13;1u'), 'translated-enter-linebreaks'],
  [`\x1b[200~${pasteText}\x1b[201~`, 'nested-raw-markers'],
  [`\0[200~${pasteText}\0[201~`, 'nested-neutralized-markers']
])
let markerTail = ''
const observeKnownMarkers = (chunk: Buffer): void => {
  const text = markerTail + chunk.toString('utf8')
  if (text.includes('\x1b[200~')) pasteSummary.rawStartObserved = true
  if (text.includes('\x1b[201~')) pasteSummary.rawEndObserved = true
  markerTail = text.slice(-5)
}
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
  clearTimeout(watchdog); clearInterval(readyTimer); clearTimeout(restorationTimer); clearInterval(progressTimer)
  try { io?.close() } catch { failed = true }
  postCloseParser?.destroy()
  process.stdin.removeListener('data', postCloseData)
  process.stdin.removeListener('data', observeKnownMarkers)
  markerTail = ''
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
const progressTimer = setInterval(() => writeFileSync(progressPath, JSON.stringify({
  phase, ...startup, controls, windows: io?.windowsInput?.diagnostic
})), 250)
process.on('uncaughtException', () => { failed = true; saveAndExit(1) })
process.on('unhandledRejection', () => { failed = true; saveAndExit(1) })

try {
  // This is the real factory: native output setup occurs before bridge.start(), exactly as in the CLI.
  loading('create-renderer')
  io = await OpenTuiIO.create({ stream: false })
  // Add a non-consuming known-marker observer only after the production factory
  // has captured original raw/flow state; never change its startup ownership.
  process.stdin.on('data', observeKnownMarkers)
  phase = 'input-diagnostic'
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
    pasteSummary.knownTransform = knownPasteVariants.get(Buffer.from(event.bytes).toString('utf8')) ?? 'unknown'
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
  phase = 'post-close'
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
