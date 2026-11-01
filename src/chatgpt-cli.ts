// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ChatGptAuthManager, CHATGPT_USAGE_URL } from './chatgpt-auth.js'
import type { ChatGptAuth } from './chatgpt-controls.js'
import { chatGptPlanStatus } from './chatgpt-controls.js'
import { TerminalIO } from './terminal.js'
import type { ChatIO } from './terminal.js'
import { environmentSecrets, redactSecrets } from './session.js'

export const CHATGPT_AUTH_HELP = `Usage: vivi auth login [--chatgpt-account ID] [--enable-plan-usage]
       vivi auth list
       vivi auth logout --chatgpt-account ID
       vivi auth usage

  --session-dir PATH          Private app state (default ~/.vivi/sessions)
  --chatgpt-account ID        Exact account/workspace registration from auth list
  --enable-plan-usage         Explicitly request consent again for a saved registration

Login uses official Continue with ChatGPT in your system browser and protected
storage. It never imports another app's tokens. Login requires an interactive
terminal; /provider also offers explicit launch-only sign-in. Accounts with the
same email remain distinct registrations. Logout clears local tokens, retains the
registration/host identity, and attempts to revoke the renewable session.
ChatGPT plan usage: ${CHATGPT_USAGE_URL}
`
export function isChatGptCliCommand(args: readonly string[]): boolean {
  let index = 0
  while (args[index] === '--session-dir' && args[index + 1] !== undefined) index += 2
  return args[index] === 'auth'
}

export function parseChatGptCliArguments(args: readonly string[], env: NodeJS.ProcessEnv = process.env): {
  action: 'login' | 'list' | 'logout' | 'usage' | 'help'; directory: string; accountId?: string; enablePlanUsage: boolean
} {
  if (!isChatGptCliCommand(args) || args.length > 16) throw new Error('Use vivi auth --help')
  let directory = env.VIVI_SESSION_DIR ?? join(homedir(), '.vivi', 'sessions'), accountId: string | undefined
  let enablePlanUsage = false, help = false
  const positional: string[] = [], flags = new Set<string>()
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === 'auth' && positional.length === 0) continue
    if (!arg.startsWith('-')) { positional.push(arg); continue }
    if (flags.has(arg)) throw new Error('Auth flags must not be repeated')
    flags.add(arg)
    const value = (): string => { const next = args[++index]; if (!next || next.startsWith('-')) throw new Error('Missing auth option value'); return next }
    if (arg === '--session-dir') directory = value()
    else if (arg === '--chatgpt-account') accountId = value()
    else if (arg === '--enable-plan-usage') enablePlanUsage = true
    else if (arg === '--help' || arg === '-h') help = true
    else throw new Error('Unknown auth option; use vivi auth --help')
  }
  const action = help || !positional.length || positional[0] === 'help' ? 'help' : positional[0]
  if (!['login', 'list', 'logout', 'usage', 'help'].includes(action!) || positional.length > 1) throw new Error('Use vivi auth --help')
  if (accountId !== undefined && !/^[a-f0-9]{64}$/.test(accountId)) throw new Error('Use an exact ChatGPT account registration ID from vivi auth list')
  if (action === 'logout' && !accountId) throw new Error('Logout requires --chatgpt-account ID')
  if (enablePlanUsage && (action !== 'login' || !accountId)) throw new Error('--enable-plan-usage requires login with a saved account registration')
  return { action: action as 'login' | 'list' | 'logout' | 'usage' | 'help', directory,
    ...(accountId ? { accountId } : {}), enablePlanUsage }
}

export async function runChatGptCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env,
  dependencies: { io?: ChatIO; chatgptAuth?: ChatGptAuth } = {}): Promise<number> {
  let io = dependencies.io, auth: ChatGptAuth | undefined, dispose: (() => void) | undefined
  const secrets = environmentSecrets(env), controller = new AbortController()
  try {
    const options = parseChatGptCliArguments(args, env)
    if (args.some(argument => secrets.some(secret => argument.includes(secret)))) throw new Error('Auth arguments must not contain credentials')
    io ??= new TerminalIO({ tui: false, secrets })
    if (options.action === 'help') { io.write(CHATGPT_AUTH_HELP); return 0 }
    if (options.action === 'usage') { io.write(`Manage ChatGPT usage: ${CHATGPT_USAGE_URL}\n`); return 0 }
    auth = dependencies.chatgptAuth ?? new ChatGptAuthManager({ directory: options.directory,
      registerSecrets: values => { secrets.push(...values.filter(value => !secrets.includes(value))); io?.addSecrets?.(values) } })
    dispose = io.onCancel(() => controller.abort())
    if (options.action === 'list') {
      const accounts = await auth.listAccounts()
      if (!accounts.length) io.write('No saved ChatGPT accounts. Use vivi auth login or /provider\n')
      for (const account of accounts) io.write(`${account.id} · ${JSON.stringify(account.label)} · ${account.signedIn ? account.planUsageEnabled ? 'ChatGPT plan enabled' : 'Plan usage disabled' : 'Signed out'}\n`)
      return 0
    }
    if (options.action === 'logout') {
      const result = await auth.signOut(options.accountId!, controller.signal)
      io.write(result.revoked ? 'ChatGPT signed out; renewable session revoked and local tokens cleared.\n'
        : `ChatGPT local tokens cleared. Remote revocation is unconfirmed; review connected apps in ChatGPT settings.\n`)
      return 0
    }
    if (io.canAutoReview !== true || io.isClosed) throw new Error('Continue with ChatGPT requires an interactive terminal; no browser or OAuth request was started')
    const status = await auth.storageStatus()
    if (!status.available) throw new Error('Protected ChatGPT storage is unavailable. Use /provider in an interactive launch for explicit launch-only sign-in; no plaintext fallback')
    const approved = await io.approve({ call: { id: randomUUID(), name: 'chatgpt_sign_in', arguments: {} }, currentRevision: 'chatgpt-sign-in-v1',
      description: `Continue with ChatGPT in your system browser. Save this account's credentials securely with ${status.label}; eligible inference uses your ChatGPT plan. No API-key billing fallback. Manage usage: ${CHATGPT_USAGE_URL}` }, controller.signal)
    if (!approved || controller.signal.aborted || io.isClosed) return 130
    const account = await auth.signIn({ ...(options.accountId ? { accountId: options.accountId } : {}),
      enablePlanUsage: options.enablePlanUsage, signal: controller.signal })
    io.write(chatGptPlanStatus(account))
    io.write(`Account registration: ${account.id}\nUse --provider chatgpt --chatgpt-account ${account.id} --model MODEL\n`)
    if (account.planUsageEnabled && !account.welcomeSeen) {
      io.write(`You're using your ChatGPT plan. Eligible AI requests in Vivi use your ChatGPT plan. Manage usage in ChatGPT settings.\n`)
      const acknowledged = await io.readLine('Got it · press Enter to continue')
      if (acknowledged !== undefined && !io.isClosed) await auth.markWelcomeSeen(account.id)
    }
    return 0
  } catch (error) {
    const message = `${redactSecrets(error instanceof Error ? error.message : 'ChatGPT account command failed', secrets)}\n`
    if (io && !io.failed) io.write(message); else process.stderr.write(message)
    return controller.signal.aborted ? 130 : 1
  } finally { dispose?.(); if (!dependencies.chatgptAuth) await auth?.close(); io?.close() }
}
