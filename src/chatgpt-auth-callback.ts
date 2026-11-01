// SPDX-License-Identifier: Apache-2.0
import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { Socket } from 'node:net'
import { ChatGptAuthError, CHATGPT_ISSUER, authCheck, authText } from './chatgpt-auth-types.js'

export interface ChatGptCallbackResult { readonly code: string; readonly clientId?: string }
export interface ChatGptCallbackOptions {
  readonly state: string
  readonly signal: AbortSignal
  readonly registerSecrets: (secrets: readonly string[]) => void
}
export interface ChatGptCallback {
  readonly redirectUri: string
  readonly result: Promise<ChatGptCallbackResult>
  close(): Promise<void>
}
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
/** Fresh one-shot IPv4 listener, started before the system browser. Only the port varies. */
class LoopbackCallback implements ChatGptCallback {
  readonly result: Promise<ChatGptCallbackResult>
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private resolve!: (result: ChatGptCallbackResult) => void
  private reject!: (error: ChatGptAuthError) => void
  private settled = false
  private url: URL | undefined
  private closing: Promise<void> | undefined
  private connections = 0
  private readonly abort = (): void => { this.fail(new ChatGptAuthError('cancelled')); void this.close() }
  constructor(private readonly options: ChatGptCallbackOptions) {
    this.result = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    void this.result.catch(() => undefined)
    this.server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      const invalid = (): void => { response.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', Connection: 'close' }); response.end('Invalid ChatGPT sign-in callback.') }
      const raw = request.url ?? ''
      const hosts = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index]?.toLowerCase() === 'host')
      if (this.settled || options.signal.aborted || !this.url || request.method !== 'GET' || hosts.length !== 1 ||
        request.headers.host !== this.url.host || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') ||
        raw.includes('#') || Buffer.byteLength(raw) > 16_384 || /%(?![\da-f]{2})/i.test(raw) || request.headers['transfer-encoding'] ||
        request.headers['content-length'] && request.headers['content-length'] !== '0') { invalid(); return }
      let url: URL
      try { url = new URL(raw, this.url) } catch { invalid(); return }
      if (url.origin !== this.url.origin || url.pathname !== '/auth/callback') { invalid(); return }
      const params = url.searchParams
      if ([...new Set(params.keys())].some(key => params.getAll(key).length !== 1) || !equal(params.get('state') ?? '', options.state) ||
        params.has('iss') && params.get('iss') !== CHATGPT_ISSUER) { invalid(); return }
      const code = params.get('code'), error = params.get('error'), clientId = params.get('client_id')
      if (code !== null && error !== null || !authText(code) && !authText(error) || clientId !== null && !authText(clientId, 1024)) { invalid(); return }
      if (code) {
        try { options.registerSecrets([code]) }
        catch { invalid(); this.fail(new ChatGptAuthError('invalid-callback')); void this.close(); return }
      }
      this.settled = true
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', Connection: 'close' })
      response.end('ChatGPT sign-in received. You can return to Vivi.')
      if (error) this.reject(new ChatGptAuthError('authorization-denied'))
      else this.resolve({ code: code!, ...(clientId === null ? {} : { clientId }) })
    })
    this.server.headersTimeout = 5000; this.server.requestTimeout = 5000; this.server.maxConnections = 16
    this.server.on('connection', socket => {
      if (++this.connections > 64) { socket.destroy(); this.fail(new ChatGptAuthError('callback-unavailable')); void this.close(); return }
      this.sockets.add(socket); socket.setTimeout(5000, () => socket.destroy()); socket.once('close', () => this.sockets.delete(socket))
    })
    this.server.on('error', () => { this.fail(new ChatGptAuthError('callback-unavailable')); void this.close() })
    options.signal.addEventListener('abort', this.abort, { once: true })
  }
  async listen(): Promise<void> {
    authCheck(this.options.signal)
    await new Promise<void>((resolve, reject) => {
      const failed = (): void => { cleanup(); reject(new ChatGptAuthError('callback-unavailable')) }
      const aborted = (): void => { cleanup(); reject(new ChatGptAuthError('cancelled')) }
      const cleanup = (): void => { this.server.removeListener('error', failed); this.options.signal.removeEventListener('abort', aborted) }
      this.server.once('error', failed); this.options.signal.addEventListener('abort', aborted, { once: true })
      this.server.listen(0, '127.0.0.1', () => { cleanup(); resolve() })
      if (this.options.signal.aborted) aborted()
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new ChatGptAuthError('callback-unavailable')
    this.url = new URL(`http://127.0.0.1:${address.port}/auth/callback`)
    authCheck(this.options.signal)
  }
  get redirectUri(): string { if (!this.url) throw new ChatGptAuthError('callback-unavailable'); return this.url.href }
  private fail(error: ChatGptAuthError): void { if (!this.settled) { this.settled = true; this.reject(error) } }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.options.signal.removeEventListener('abort', this.abort); this.fail(new ChatGptAuthError('cancelled'))
    this.closing = new Promise(resolve => { this.server.close(() => resolve()); for (const socket of this.sockets) socket.destroy() })
    return this.closing
  }
}
export async function listenChatGptCallback(options: ChatGptCallbackOptions): Promise<ChatGptCallback> {
  const callback = new LoopbackCallback(options)
  try { await callback.listen(); return callback } catch (error) { await callback.close(); throw error }
}
