// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process'
import { win32 } from 'node:path'
import type { CliProviderName } from './session.js'

export const MAX_API_KEY_LENGTH = 4096
export const CREDENTIAL_PROCESS_TIMEOUT_MS = 10_000
export const MAX_CREDENTIAL_OUTPUT_BYTES = 16 * 1024
export const MAX_WINDOWS_CREDENTIAL_BYTES = 5 * 512
const MAX_CREDENTIAL_INPUT_BYTES = 32 * 1024
const MACOS_COMMAND_LINE_BYTES = 4095
const MACOS_SECRET_PREFIX = 'vivi-cli-api-key-v1:'
const LINUX_SECRET_INPUT_BYTES = 8191
const service = 'vivi-cli'

// Only this fixed, nonsecret source enters PowerShell's argv/script-block logging. All request
// parsing and secret I/O happen inside C#, never in cmdlet parameters or the PowerShell pipeline.
// Add-Type may compile temporary *source* files; that source never contains a credential.
// No profile, execution-policy changes, cmdkey password arguments or third-party modules are used.
// https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw
// https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credgetsessiontypes
// https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw
const WINDOWS_CREDENTIAL_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;

public static class ViviNativeCredentials {
  private const uint Generic = 1;
  private const uint LocalMachine = 2;
  private const int MaxBlobBytes = 2560;
  private const int MaxInputBytes = 32768;
  private const int Missing = 3;

  [StructLayout(LayoutKind.Sequential)]
  private struct Credential {
    public uint Flags;
    public uint Type;
    public IntPtr TargetName;
    public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredGetSessionTypes", ExactSpelling = true, SetLastError = true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CredGetSessionTypes(uint count, [Out] uint[] persistence);

  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", ExactSpelling = true, SetLastError = true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CredWrite(ref Credential credential, uint flags);

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

  [DllImport("advapi32.dll", EntryPoint = "CredFree", ExactSpelling = true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern void CredFree(IntPtr credential);

  private static void ClearNative(IntPtr pointer, int length) {
    if (pointer == IntPtr.Zero) return;
    for (int index = 0; index < length; index++) Marshal.WriteByte(pointer, index, 0);
  }

  private static int Save(string target, byte[] input, int offset, int length) {
    if (length < 1 || length > MaxBlobBytes) return 2;
    IntPtr targetPointer = IntPtr.Zero;
    IntPtr blobPointer = IntPtr.Zero;
    try {
      // Validate UTF-8 without passing the resulting string to PowerShell or any logger.
      new UTF8Encoding(false, true).GetString(input, offset, length);
      targetPointer = Marshal.StringToHGlobalUni(target);
      blobPointer = Marshal.AllocHGlobal(length);
      Marshal.Copy(input, offset, blobPointer, length);
      Credential credential = new Credential();
      credential.Type = Generic;
      credential.TargetName = targetPointer;
      credential.CredentialBlobSize = (uint)length;
      credential.CredentialBlob = blobPointer;
      credential.Persist = LocalMachine;
      return CredWrite(ref credential, 0) ? 0 : 2;
    } finally {
      ClearNative(blobPointer, length);
      if (blobPointer != IntPtr.Zero) Marshal.FreeHGlobal(blobPointer);
      if (targetPointer != IntPtr.Zero) Marshal.FreeHGlobal(targetPointer);
    }
  }

  private static int Load(string target) {
    IntPtr pointer = IntPtr.Zero;
    if (!CredRead(target, Generic, 0, out pointer)) {
      return Marshal.GetLastWin32Error() == 1168 ? Missing : 2;
    }
    IntPtr blobPointer = IntPtr.Zero;
    int length = 0;
    byte[] bytes = null;
    try {
      Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
      if (credential.Type != Generic || credential.Persist != LocalMachine ||
          credential.CredentialBlobSize < 1 || credential.CredentialBlobSize > MaxBlobBytes ||
          credential.CredentialBlob == IntPtr.Zero) return 2;
      length = (int)credential.CredentialBlobSize;
      blobPointer = credential.CredentialBlob;
      bytes = new byte[length];
      Marshal.Copy(blobPointer, bytes, 0, length);
      new UTF8Encoding(false, true).GetString(bytes);
      // Raw pipe output avoids PowerShell host formatting, transcription and pipeline/module logs.
      using (Stream stdout = Console.OpenStandardOutput()) stdout.Write(bytes, 0, length);
      return 0;
    } finally {
      if (bytes != null) Array.Clear(bytes, 0, bytes.Length);
      ClearNative(blobPointer, length);
      if (pointer != IntPtr.Zero) CredFree(pointer);
    }
  }

  public static int Run() {
    byte[] input = new byte[MaxInputBytes + 1];
    try {
      int length = 0;
      using (Stream stdin = Console.OpenStandardInput()) {
        int count;
        while (length < input.Length && (count = stdin.Read(input, length, input.Length - length)) != 0) {
          length += count;
        }
      }
      if (length > MaxInputBytes) return 2;
      int first = Array.IndexOf(input, (byte)10, 0, length);
      if (first < 0) return 2;
      string operation = Encoding.ASCII.GetString(input, 0, first);
      if (operation == "status" && first + 1 == length) {
        uint[] persistence = new uint[7];
        return CredGetSessionTypes((uint)persistence.Length, persistence) && persistence[Generic] >= LocalMachine ? 0 : 2;
      }
      int second = Array.IndexOf(input, (byte)10, first + 1, length - first - 1);
      if (second < 0) return 2;
      string provider = Encoding.ASCII.GetString(input, first + 1, second - first - 1);
      if (provider != "openai" && provider != "openrouter") return 2;
      string target = "vivi-cli/" + provider;
      if (operation == "load" && second + 1 == length) return Load(target);
      if (operation == "save") return Save(target, input, second + 1, length - second - 1);
      return 2;
    } catch {
      // Never emit exception messages, stdin, native error details or credential values.
      return 2;
    } finally {
      Array.Clear(input, 0, input.Length);
    }
  }
}
'@ -ErrorAction Stop | Out-Null
  exit ([ViviNativeCredentials]::Run())
} catch {
  exit 2
}`

function windowsCredentialCommand(operation: 'status' | 'load' | 'save', provider?: CliProviderName,
  key?: string): CredentialCommand {
  // Use the installed system helper rather than a PATH-searchable executable or user PowerShell profile.
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  if (!/^[a-z]:[\\/]/i.test(systemRoot) || systemRoot.includes('\0')) {
    throw new Error('OS credential helper could not start')
  }
  return {
    command: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_CREDENTIAL_SCRIPT],
    // Only ASCII allowlisted headers are interpreted. The UTF-8 remainder is opaque secret data.
    stdin: operation === 'status' ? 'status\n' : `${operation}\n${provider}\n${key ?? ''}`,
    captureStdout: operation === 'load'
  }
}

export interface CredentialStoreStatus {
  available: boolean
  label: string
  detail?: string
}

/** Credentials belong in the OS keyring, never preferences, sessions or environment variables. */
export interface CredentialStore {
  status(): Promise<CredentialStoreStatus>
  load(provider: CliProviderName): Promise<string | undefined>
  save(provider: CliProviderName, key: string): Promise<void>
}

/** Provider-independent syntax checks, not authentication or a provider-specific prefix check. */
export function validateApiKey(value: unknown): string {
  if (typeof value !== 'string' || value.length > MAX_API_KEY_LENGTH ||
    /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/.test(value) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) {
    throw new Error('API key must be 1–4096 characters without control characters')
  }
  const key = value.trim()
  if (!key) throw new Error('API key must be 1–4096 characters without control characters')
  return key
}

export interface CredentialCommand {
  command: string
  args: readonly string[]
  /** Secret input is sent over a pipe, never interpolated into argv or a shell. */
  stdin?: string
  captureStdout: boolean
  timeoutMs?: number
  maxOutputBytes?: number
}

export interface CredentialCommandResult {
  exitCode: number | null
  /** Only a load operation requests stdout; callers must treat it as secret. */
  stdout: string
  /** Stderr content is deliberately discarded, including on failure. */
  stderrPresent: boolean
}

export type CredentialProcessRunner = (command: CredentialCommand) => Promise<CredentialCommandResult>

/** Bounded, no-shell process execution. No child diagnostics or original errors escape. */
export const runCredentialCommand: CredentialProcessRunner = async (request) => {
  const timeoutMs = request.timeoutMs ?? CREDENTIAL_PROCESS_TIMEOUT_MS
  const maxOutputBytes = request.maxOutputBytes ?? MAX_CREDENTIAL_OUTPUT_BYTES
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CREDENTIAL_PROCESS_TIMEOUT_MS ||
    !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_CREDENTIAL_OUTPUT_BYTES ||
    Buffer.byteLength(request.stdin ?? '') > MAX_CREDENTIAL_INPUT_BYTES) {
    throw new Error('Invalid credential process limits')
  }
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(request.command, [...request.args], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch {
      reject(new Error('OS credential helper could not start'))
      return
    }
    let settled = false
    let outputBytes = 0
    let stderrPresent = false
    const chunks: Buffer[] = []
    const fail = (message: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
      // No cause: spawn errors can include argv, and helper errors can include credentials.
      reject(new Error(message))
    }
    const timer = setTimeout(() => fail('OS credential helper timed out'), timeoutMs)
    const receive = (chunk: Buffer, stderr: boolean): void => {
      if (settled) return
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) {
        fail('OS credential helper exceeded its output limit')
        return
      }
      if (stderr) stderrPresent = true
      else if (request.captureStdout) chunks.push(chunk)
    }
    child.stdout?.on('data', (chunk: Buffer) => receive(chunk, false))
    child.stderr?.on('data', (chunk: Buffer) => receive(chunk, true))
    child.stdout?.on('error', () => fail('OS credential helper failed'))
    child.stderr?.on('error', () => fail('OS credential helper failed'))
    child.stdin?.on('error', () => fail('OS credential helper failed'))
    child.on('error', () => fail('OS credential helper could not start'))
    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let stdout = ''
      try {
        if (request.captureStdout) stdout = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
      } catch {
        reject(new Error('OS credential helper returned invalid text'))
        return
      }
      resolve({ exitCode, stdout, stderrPresent })
    })
    child.stdin?.end(request.stdin ?? '', 'utf8')
  })
}

export interface NativeCredentialStoreOptions {
  platform?: NodeJS.Platform
  runner?: CredentialProcessRunner
}

/** Native-only persistence. Unsupported/unavailable hosts must use an explicit session-only flow. */
export class NativeCredentialStore implements CredentialStore {
  private readonly platform: NodeJS.Platform
  private readonly runner: CredentialProcessRunner
  constructor(options: NativeCredentialStoreOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.runner = options.runner ?? runCredentialCommand
  }

  private get supported(): boolean {
    return this.platform === 'darwin' || this.platform === 'linux' || this.platform === 'win32'
  }
  private get label(): string {
    if (this.platform === 'darwin') return 'macOS Keychain'
    if (this.platform === 'linux') return 'Linux Secret Service'
    if (this.platform === 'win32') return 'Windows Credential Manager'
    return 'OS credential storage'
  }

  private async run(request: CredentialCommand): Promise<CredentialCommandResult> {
    const result = await this.runner(request)
    if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > MAX_CREDENTIAL_OUTPUT_BYTES ||
      typeof result.stderrPresent !== 'boolean' ||
      (result.exitCode !== null && (!Number.isSafeInteger(result.exitCode) || result.exitCode < 0))) {
      throw new Error('OS credential helper returned an invalid result')
    }
    return result
  }

  async status(): Promise<CredentialStoreStatus> {
    const unavailable = (): CredentialStoreStatus => ({
      available: false, label: this.label,
      detail: this.supported
        ? 'OS credential storage is unavailable or locked. Use an API key for this session only.'
        : 'Secure credential persistence is not supported on this platform. Use an API key for this session only.'
    })
    if (!this.supported) return unavailable()
    try {
      const result = await this.run(this.platform === 'darwin'
        ? { command: '/usr/bin/security', args: ['default-keychain', '-d', 'user'], captureStdout: false }
        : this.platform === 'win32' ? windowsCredentialCommand('status')
        : { command: 'secret-tool', args: ['lookup', 'application', service, 'credential-probe', 'availability'],
          captureStdout: false })
      // libsecret returns 1 without stderr for a missing item, and 1 with stderr on service errors.
      const available = !result.stderrPresent && (result.exitCode === 0 ||
        (this.platform === 'linux' && result.exitCode === 1))
      return available ? { available: true, label: this.label } : unavailable()
    } catch { return unavailable() }
  }

  async load(provider: CliProviderName): Promise<string | undefined> {
    checkProvider(provider)
    if (!this.supported) return undefined
    try {
      const result = await this.run(this.platform === 'darwin'
        ? { command: '/usr/bin/security', args: ['find-generic-password', '-s', service, '-a', provider, '-w'],
          captureStdout: true }
        : this.platform === 'win32' ? windowsCredentialCommand('load', provider)
        : { command: 'secret-tool', args: ['lookup', 'application', service, 'provider', provider], captureStdout: true })
      // security exits 44 for errSecItemNotFound. Secret Service missing items produce no output/diagnostics.
      if ((this.platform === 'darwin' && result.exitCode === 44 && !result.stdout) ||
        (this.platform === 'win32' && result.exitCode === 3 && !result.stderrPresent && !result.stdout) ||
        (this.platform === 'linux' && result.exitCode === 1 && !result.stderrPresent && !result.stdout)) return undefined
      if (result.exitCode !== 0 || result.stderrPresent) throw new Error('Credential read failed')
      if (this.platform === 'win32' && Buffer.byteLength(result.stdout) > MAX_WINDOWS_CREDENTIAL_BYTES) {
        throw new Error('Invalid credential size')
      }
      const key = this.platform === 'darwin' ? decodeMacKey(result.stdout) : result.stdout
      const validated = validateApiKey(key)
      // User input may be trimmed before saving; native output must already be canonical.
      // Otherwise a helper that changes bytes at the edges could pass read-back verification.
      if (validated !== key) throw new Error('Invalid credential encoding')
      return validated
    } catch {
      throw new Error('Unable to read from OS credential storage. Use an API key for this session only.')
    }
  }

  async save(provider: CliProviderName, input: string): Promise<void> {
    checkProvider(provider)
    const key = validateApiKey(input)
    if (!this.supported) {
      throw new Error('Secure credential persistence is not supported on this platform. Use an API key for this session only.')
    }
    let request: CredentialCommand
    if (this.platform === 'darwin') {
      // Apple security.c reads -i commands from stdin. -X decodes hex, avoiding its quoting/parser pitfalls.
      // https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/security.c
      // One command only: a trailing quit command would hide an unsuccessful save's exit code.
      // security -w hex-prints non-ASCII bytes without a marker. A versioned ASCII envelope makes
      // its output unambiguous, even for a key that itself happens to contain only hexadecimal digits.
      // The OS keychain provides encryption; this envelope is just an encoding, not a fallback vault.
      const envelope = `${MACOS_SECRET_PREFIX}${Buffer.from(key, 'utf8').toString('base64')}`
      const line = `add-generic-password -U -s ${service} -a ${provider} -X ${Buffer.from(envelope).toString('hex')}\n`
      if (Buffer.byteLength(line) > MACOS_COMMAND_LINE_BYTES) {
        throw new Error('API key exceeds the macOS Keychain input limit. Use it for this session only.')
      }
      request = { command: '/usr/bin/security', args: ['-i', '-q'], stdin: line, captureStdout: false }
    } else if (this.platform === 'win32') {
      // Generic Credential Manager blobs are application-defined UTF-8, limited to 5 * 512 bytes.
      if (Buffer.byteLength(key) > MAX_WINDOWS_CREDENTIAL_BYTES) {
        throw new Error('API key exceeds the Windows Credential Manager input limit. Use it for this session only.')
      }
      request = windowsCredentialCommand('save', provider, key)
    } else {
      // libsecret's piped store reads through EOF (no trailing newline), with an 8192-byte buffer.
      // https://github.com/GNOME/libsecret/blob/main/tool/secret-tool.c
      if (Buffer.byteLength(key) > LINUX_SECRET_INPUT_BYTES) {
        throw new Error('API key exceeds the Linux Secret Service input limit. Use it for this session only.')
      }
      request = { command: 'secret-tool',
        args: ['store', '--label=Vivi CLI API key', 'application', service, 'provider', provider],
        stdin: key, captureStdout: false }
    }
    try {
      const result = await this.run(request)
      if (result.exitCode !== 0 || result.stderrPresent) throw new Error('Credential save failed')
      // A zero exit code is insufficient proof of persistence (especially for command-reader helpers).
      // Read-back stays in memory and is never returned, printed, or included in an error.
      if (await this.load(provider) !== key) throw new Error('Credential verification failed')
    } catch {
      throw new Error('Unable to save to OS credential storage. Use the API key for this session only.')
    }
  }
}

function checkProvider(provider: CliProviderName): void {
  if (provider !== 'openai' && provider !== 'openrouter') throw new Error('Unsupported credential provider')
}

function decodeMacKey(stdout: string): string {
  // https://github.com/apple-oss-distributions/Security/blob/main/SecurityTool/macOS/keychain_find.c
  const envelope = stdout.replace(/\n$/, '')
  if (!envelope.startsWith(MACOS_SECRET_PREFIX)) throw new Error('Invalid credential encoding')
  const encoded = envelope.slice(MACOS_SECRET_PREFIX.length)
  const bytes = Buffer.from(encoded, 'base64')
  if (!encoded || bytes.toString('base64') !== encoded) throw new Error('Invalid credential encoding')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

export function createCredentialStore(options: NativeCredentialStoreOptions = {}): CredentialStore {
  return new NativeCredentialStore(options)
}
