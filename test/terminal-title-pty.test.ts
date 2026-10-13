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
      env: { ...process.env, TERM: 'xterm-256color', OTUI_DEBUG: 'false', OTUI_STDIN_LOG: '' }, timeout: 20000 })
    expect(result.status).toBe(0)
    const captured = JSON.parse(result.stdout) as { exitCode: number; output: string }
    expect(captured.exitCode).toBe(mode === 'error' ? 1 : 0)
    const bytes = captured.output
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
