// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const python = String.raw`
import errno,json,os,pty,select,signal,sys,time
pid,fd=pty.fork()
if pid==0:
    os.execv(sys.argv[1],[sys.argv[1],sys.argv[2],sys.argv[3]])
chunks=[]
deadline=time.monotonic()+15
try:
    while time.monotonic()<deadline:
        if not select.select([fd],[],[],0.1)[0]: continue
        try: chunk=os.read(fd,65536)
        except OSError as error:
            if error.errno==errno.EIO: break
            raise
        if not chunk: break
        chunks.append(chunk)
    else:
        os.kill(pid,signal.SIGKILL)
        raise RuntimeError('Offline title probe did not terminate')
    _,status=os.waitpid(pid,0)
    print(json.dumps({'exitCode':os.waitstatus_to_exitcode(status),'output':b''.join(chunks).decode('utf-8','replace')}))
finally:
    os.close(fd)
`
const fixture = fileURLToPath(new URL('./fixtures/terminal-title-native.ts', import.meta.url))
const hasPty = process.platform !== 'win32' && spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' }).status === 0

for (const mode of ['close', 'external', 'error', 'deferred', 'exit-during-render', 'close-exit-during-render']) {
  test.skipIf(!hasPty)(`production title restoration follows native cleanup exactly once: ${mode}`, () => {
    const result = spawnSync('python3', ['-c', python, process.execPath, fixture, mode], { encoding: 'utf8',
      env: { ...process.env, TERM: 'xterm-256color', VIVI_OSC7501: '1', VTE_VERSION: '', OTUI_DEBUG: 'false', OTUI_STDIN_LOG: '' }, timeout: 20000 })
    expect(result.status).toBe(0)
    const captured = JSON.parse(result.stdout) as { exitCode: number; output: string }
    expect(captured.exitCode).toBe(mode === 'error' ? 1 : 0)
    const bytes = captured.output
    const statusFrames = bytes.match(/\x1b\]7501;[^\x1b]*\x1b\\/g)
    expect(statusFrames).toEqual([
      '\x1b]7501;state=idle:app=vivi-cli\x1b\\',
      '\x1b]7501;state=working:app=vivi-cli\x1b\\',
      '\x1b]7501;state=blocked:app=vivi-cli:kind=question\x1b\\',
      '\x1b]7501;state=clear\x1b\\'
    ])
    expect(bytes.lastIndexOf('\x1b]7501;state=clear')).toBeGreaterThan(bytes.lastIndexOf('\x1b[23;0t'))
    expect(bytes.split('\x1b[22;0t')).toHaveLength(2)
    expect(bytes.split('\x1b[23;0t')).toHaveLength(2)
    const restored = bytes.lastIndexOf('\x1b[23;0t')
    expect(restored).toBeGreaterThan(bytes.lastIndexOf('\x1b]0;\x07'))
    expect(bytes.slice(restored + '\x1b[23;0t'.length)).not.toMatch(/\x1b\][012];/)
    expect(bytes).not.toContain('fake-title-pty-secret')
    expect(bytes).toContain('[~] vivi · Restore [REDACTED]')
    expect(bytes).toContain('[!] vivi · Restore [REDACTED]')
  }, 25000)
}

for (const gate of [{ VIVI_OSC7501: '0' }, { TERM: 'dumb' }, { VTE_VERSION: '5399' }]) {
  test.skipIf(!hasPty)(`production program status is silent for ${JSON.stringify(gate)}`, () => {
    const result = spawnSync('python3', ['-c', python, process.execPath, fixture, 'close'], { encoding: 'utf8',
      env: { ...process.env, TERM: 'xterm-256color', VIVI_OSC7501: '1', VTE_VERSION: '',
        OTUI_DEBUG: 'false', OTUI_STDIN_LOG: '', ...gate }, timeout: 20000 })
    expect(result.status).toBe(0)
    const captured = JSON.parse(result.stdout) as { exitCode: number; output: string }
    expect(captured.exitCode).toBe(0)
    expect(captured.output).not.toContain('\x1b]7501;')
  }, 25000)
}
test.skipIf(!hasPty)('TTY --help emits no program status', () => {
  const main = fileURLToPath(new URL('../dist/main.js', import.meta.url))
  const result = spawnSync('python3', ['-c', python, process.execPath, main, '--help'], { encoding: 'utf8',
    env: { ...process.env, TERM: 'xterm-256color', VIVI_OSC7501: '1' }, timeout: 20000 })
  expect(result.status).toBe(0)
  const captured = JSON.parse(result.stdout) as { exitCode: number; output: string }
  expect(captured.exitCode).toBe(0)
  expect(captured.output).toContain('vivi')
  expect(captured.output).not.toContain('\x1b]7501;')
}, 25000)

for (const outcome of ['completed', 'error', 'cancelled', 'unfinished']) {
  test.skipIf(!hasPty)(`one-shot native teardown retains only final done/error: ${outcome}`, () => {
    const statusFixture = fileURLToPath(new URL('./fixtures/terminal-program-status-native.ts', import.meta.url))
    const result = spawnSync('python3', ['-c', python, process.execPath, statusFixture, outcome], { encoding: 'utf8',
      env: { ...process.env, TERM: 'xterm-256color', VIVI_OSC7501: '1', VTE_VERSION: '',
        OTUI_DEBUG: 'false', OTUI_STDIN_LOG: '' }, timeout: 20000 })
    expect(result.status).toBe(0)
    const captured = JSON.parse(result.stdout) as { exitCode: number; output: string }
    expect(captured.exitCode).toBe(0)
    const frames = captured.output.match(/\x1b\]7501;[^\x1b]*\x1b\\/g)
    const final = outcome === 'completed' ? 'done' : outcome === 'error' ? 'error' : 'clear'
    expect(frames?.at(-1)).toBe(`\x1b]7501;state=${final}${final === 'clear' ? '' : ':app=vivi-cli'}\x1b\\`)
    expect(frames?.filter(frame => frame.includes('state=clear')).length).toBe(final === 'clear' ? 1 : 0)
  }, 25000)
}
