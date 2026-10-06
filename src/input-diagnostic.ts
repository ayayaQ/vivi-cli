// SPDX-License-Identifier: Apache-2.0
import type { KeyEvent } from '@opentui/core'
import type { WindowsInputBridge } from './windows-input.js'

export interface InputProbe {
  key: 'enter' | 'keypad-enter' | 'linefeed' | 'ctrl-j'
  shift: boolean; ctrl: boolean; alt: boolean
  event: 'press' | 'repeat' | 'release'
  source: 'raw' | 'kitty'
}
export interface InputDiagnosticReport {
  platform: string; nodeCompatibilityVersion: string; bun?: string
  stdinTTY: boolean; stdoutTTY: boolean
  windows?: WindowsInputBridge['diagnostic']
  probes: InputProbe[]
  failed: boolean
}
/** Allowlisted probe metadata only: ordinary characters and paste never enter it. */
export function inputProbe(key: Pick<KeyEvent, 'name' | 'shift' | 'ctrl' | 'meta' | 'eventType' | 'source' | 'repeated'>): InputProbe | undefined {
  const name = key.name === 'return' ? 'enter' : key.name === 'kpenter' ? 'keypad-enter'
    : key.name === 'linefeed' ? 'linefeed' : key.name === 'j' && key.ctrl ? 'ctrl-j' : undefined
  if (!name) return undefined
  return { key: name, shift: key.shift === true, ctrl: key.ctrl === true, alt: key.meta === true,
    event: key.eventType === 'release' ? 'release' : key.eventType === 'repeat' || key.repeated === true ? 'repeat' : 'press',
    source: key.source === 'kitty' ? 'kitty' : 'raw' }
}
export function formatInputDiagnostic(report: InputDiagnosticReport): string {
  return `Input diagnostic (offline; probe metadata only)\n${JSON.stringify(report, null, 2)}\nReview this output before sharing it. Nothing was saved or sent.\n`
}
export async function runInputDiagnostic(): Promise<string> {
  const captureFlags = ['OTUI_DEBUG', 'OTUI_DEBUG_FFI', 'OTUI_TRACE_FFI', 'OTUI_DUMP_CAPTURES']
  if (process.env.OTUI_STDIN_LOG || captureFlags.some(name =>
    ['true', '1', 'on', 'yes'].includes((process.env[name] ?? '').trim().toLowerCase()))) {
    throw new Error('Disable raw input capture before running an input diagnostic')
  }
  // Import the native UI only on the full-screen Bun diagnostic route.
  const { OpenTuiIO } = await import('./tui.js')
  const io = await OpenTuiIO.create({ stream: false })
  try { return formatInputDiagnostic(await io.diagnoseInput()) }
  finally { io.close() }
}
