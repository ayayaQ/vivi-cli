// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test'
import { TextareaRenderable } from '@opentui/core'
import { createTestRenderer } from '@opentui/core/testing'
import { OpenTuiIO } from '../src/tui.js'
import { createWindowsInputBridge } from '../src/windows-input.js'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const record = (vk: number, uc: number, state = 0, down = 1) => `\x1b[${vk};0;${uc};${down};${state};1_`

test('offline native diagnostic ignores ordinary text and paste, collects known probes and restores the bridge', async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer)
  const source = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode(mode: boolean): void }
  source.isTTY = true; source.isRaw = false; source.setRawMode = mode => { source.isRaw = mode }
  const writes: string[] = []
  const bridge = createWindowsInputBridge(source as never, text => { writes.push(text) })
  // Exact production adapter output goes through the native parser, not a key mock.
  bridge.stdin.on('data', chunk => setup.renderer.stdin.emit('data', chunk))
  Object.assign(io, { windowsInput: bridge })
  try {
    bridge.stdin.setRawMode(true); bridge.start(); source.write('\x1b[?9001;2$y')
    const pending = io.diagnoseInput()
    await setup.renderOnce(); await setup.renderOnce()
    const composer = setup.renderer.root.findDescendantById('vivi-composer') as TextareaRenderable
    source.write('private fixture text'); source.write('\x1b[200~private pasted fixture\x1b[201~')
    source.write(record(13, 13) + record(13, 0, 0, 0))
    source.write(record(13, 13, 16) + record(13, 0, 16, 0))
    source.write(record(74, 10, 8))
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(composer.plainText).toBe('')
    setup.mockInput.pressEscape()
    const report = await pending
    expect(report.probes.map(probe => [probe.key, probe.shift, probe.ctrl])).toEqual([
      ['enter', false, false], ['enter', true, false], ['ctrl-j', false, true]
    ])
    expect(JSON.stringify(report)).not.toContain('private')
    expect(writes).toEqual(['\x1b[?9001$p', '\x1b[?9001h', '\x1b[?9001l'])
    expect(report.windows?.modeReply).toBe(2)
    expect(report.windows?.enterRecordsObserved).toBe(4)
    expect(report.windows?.closed).toBe(true)
    expect(source.isRaw).toBe(false)
    expect(bridge.stdin.destroyed).toBe(true)
    expect(io.isClosed).toBe(true)
  } finally { io.close(); bridge.close(); source.destroy() }
})

test('native input diagnostic stays bounded and closes on renderer shutdown', async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer), pending = io.diagnoseInput()
  try {
    for (let i = 0; i < 100; i++) setup.mockInput.pressEnter({ shift: true })
    setup.renderer.destroy()
    expect((await pending).probes).toHaveLength(32)
  } finally { io.close() }
})

test('diagnostic preserves native Kitty repeated-key metadata', async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true,
    exitOnCtrlC: false, exitSignals: [], consoleMode: 'disabled' })
  const io = new OpenTuiIO(setup.renderer), pending = io.diagnoseInput()
  try {
    setup.renderer.stdin.emit('data', Buffer.from('\x1b[13;2u\x1b[13;2:2u'))
    setup.mockInput.pressEscape()
    expect((await pending).probes.map(probe => [probe.shift, probe.event])).toEqual([
      [true, 'press'], [true, 'repeat']
    ])
  } finally { io.close() }
})

for (const flag of ['OTUI_DEBUG_FFI', 'OTUI_TRACE_FFI']) {
  test(`production Linux TTY diagnostic blocks ${flag} and leaves no files`, async () => {
    if (process.platform !== 'linux') return // util-linux script is not a Windows requirement.
    const directory = await mkdtemp(join(tmpdir(), 'vivi-diagnostic-production-'))
    const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`
    const main = fileURLToPath(new URL('../dist/main.js', import.meta.url))
    try {
      const child = spawnSync('script', ['-q', '-e', '-c', `${quote(process.execPath)} ${quote(main)} --diagnose-input`, '/dev/null'], {
        cwd: directory, env: { PATH: process.env.PATH, TERM: 'xterm-256color', [flag]: '1' },
        encoding: 'utf8', timeout: 5000
      })
      expect(child.error).toBeUndefined()
      expect(child.status).toBe(1)
      expect(child.stdout).toContain('Input diagnostic failed')
      expect(child.stdout).not.toContain('Offline input probe:')
      expect(await readdir(directory)).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
}
