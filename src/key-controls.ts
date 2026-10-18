// SPDX-License-Identifier: Apache-2.0
import type { InteractiveIO } from './application.js'
import type { CredentialProviderName, CredentialStore } from './credentials.js'
import { validateApiKey } from './credentials.js'
/** Explicit masked key selection. No key is copied between feature slots implicitly. */
export async function chooseSecureKey(io: InteractiveIO, credentials: CredentialStore, options: {
  slot: CredentialProviderName; title: string; current?: string; currentDescription?: string; storageDescription?: string; reuse?: { label: string; key: string };
  register(secret: string): void
}): Promise<string | undefined> {
  const action = await io.choose(`${options.title} key`, [
    ...(options.current ? [{ name: 'Use current key', description: options.currentDescription ?? 'Already configured for this purpose', value: 'current' }] : []),
    ...(options.reuse ? [{ name: options.reuse.label, description: 'Explicitly copy this key for this separate purpose', value: 'reuse' }] : []),
    { name: 'Enter a key', description: 'Masked input; choose secure or launch-only storage', value: 'enter' }
  ])
  if (!action || io.isClosed) return
  if (action === 'current') return options.current
  const status = await credentials.status()
  if (io.isClosed) return
  const storage = await io.choose(`${options.title} key storage`, [
    ...(status.available ? [{ name: `Save in ${status.label}`, description: options.storageDescription ?? 'Separate feature slot; never plaintext settings', value: 'save' }] : []),
    { name: 'Use for this launch only', description: status.available ? 'Not saved for future launches' : `${status.detail ?? status.label}. No plaintext fallback`, value: 'temporary' }
  ])
  if (!storage || io.isClosed) return
  let entered: string | undefined
  if (action === 'reuse') entered = options.reuse?.key
  else {
    if (!io.askSecret) { io.write('Masked key input is unavailable; set the dedicated environment variable before launch\n'); return }
    entered = await io.askSecret(`${options.title} API key · masked · Escape cancels`)
  }
  if (entered === undefined || io.isClosed) return
  options.register(entered)
  const key = validateApiKey(entered); options.register(key)
  if (storage === 'save') {
    try { await credentials.save(options.slot, key); io.write(`Key saved in ${status.label}\n`) }
    catch {
      const use = await io.choose('Secure storage could not be verified', [
        { name: 'Cancel', description: 'The vault may already contain the key; its state is unverified', value: false },
        { name: 'Use for this launch only', description: 'No plaintext fallback; vault state remains unverified', value: true }
      ])
      if (!use || io.isClosed) return
    }
  }
  return key
}
