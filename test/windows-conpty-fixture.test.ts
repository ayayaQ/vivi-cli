// SPDX-License-Identifier: Apache-2.0
// Cross-platform fixture validation only. This is deliberately not labelled native ConPTY evidence.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { basicProbes, repeatProbes, paste, pasteText, finish, expectedProbes } from './fixtures/windows-conpty/protocol.mjs'

const repository = resolve(process.env.VIVI_TEST_CONPTY_REPOSITORY ?? fileURLToPath(new URL('../', import.meta.url)))
const { WindowsInputDecoder } = await import(pathToFileURL(resolve(repository, 'src/windows-input.ts')).href)
const { inputProbe } = await import(pathToFileURL(resolve(repository, 'src/input-diagnostic.ts')).href)
const { StdinParser } = await import(pathToFileURL(Bun.resolveSync('@opentui/core', repository)).href)

const fixture = Buffer.from(basicProbes + repeatProbes + paste + finish)
for (let split = 0; split <= fixture.length; split++) {
  test(`synthetic ConPTY fixture retains probe and paste identity at split ${split}`, () => {
    const decoder = new WindowsInputDecoder()
    const utf8 = new StringDecoder('utf8')
    const parser = new StdinParser({ useKittyKeyboard: true, armTimeouts: false })
    const probes: unknown[] = [], pastes: string[] = []
    let escapes = 0, releases = 0, unknown = 0
    try {
      for (const part of [fixture.slice(0, split), fixture.slice(split)]) {
        const decoded = decoder.write(utf8.write(part))
        if (decoded) parser.push(Buffer.from(decoded))
        parser.drain(event => {
          if (event.type === 'paste') { pastes.push(Buffer.from(event.bytes).toString()); return }
          if (event.type !== 'key') return
          if (event.key.name === 'escape') { escapes++; return }
          if (event.key.eventType === 'release') releases++
          const probe = inputProbe(event.key)
          if (probe) probes.push([probe.key, probe.shift, probe.ctrl, probe.event, probe.source])
          else unknown++
        })
      }
      expect(probes).toEqual(expectedProbes)
      expect(pastes).toEqual([pasteText])
      expect(escapes).toBe(1)
      expect(releases).toBe(0)
      expect(unknown).toBe(0)
      expect(decoder.enterRecordsObserved).toBe(9)
    } finally { parser.destroy() }
  })
}
