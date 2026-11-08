// SPDX-License-Identifier: Apache-2.0
import type { CatalogResult, ModelEntry } from './models.js'
import { unknownModel } from './models.js'
import { unknownChatGPTCapabilities } from './chatgpt-provider.js'
import type { ReasoningEffort } from '@ayayaq/vivi/providers/openrouter'

const MAX_BYTES = 4 * 1024 * 1024
const MAX_MODELS = 5000
const reviewedOn = '2026-11-08'
const signInDocumentation = 'https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference'
const codexCatalog = 'https://github.com/openai/codex/blob/c9b4267c370a755da12ec1c8648c2451163212b7/codex-rs/models-manager/models.json'
const ordinaryEfforts: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const standardWorkingBudget = 258_400
const extendedWorkingBudget = 475_000
// Exact intersection of reviewed Codex and pi subscription catalogs. This is
// enrichment only: the selected account's response remains the availability gate.
// See docs/CHATGPT_MODEL_METADATA.md for provenance, omissions and budget policy.
const reviewedModels = new Map([
  ['gpt-6-astra', { budget: standardWorkingBudget, reasoningRequired: true }],
  ['gpt-6.1-sol', { budget: extendedWorkingBudget, reasoningRequired: true }],
  ['gpt-6.1-terra', { budget: extendedWorkingBudget, reasoningRequired: false }],
  ['gpt-6-sol', { budget: standardWorkingBudget, reasoningRequired: false }],
  ['gpt-6-luna', { budget: standardWorkingBudget, reasoningRequired: false }],
  ['gpt-5.6-sol', { budget: standardWorkingBudget, reasoningRequired: false }],
  ['gpt-5.6-terra', { budget: standardWorkingBudget, reasoningRequired: false }],
  ['gpt-5.6-luna', { budget: standardWorkingBudget, reasoningRequired: false }]
])

/** Reviewed exact-slug metadata is separate from account availability. Never
 * import the API-key registry's context window or infer aliases/future models. */
function reviewedModel(id: string): ModelEntry {
  const model = unknownModel(id), capabilities = unknownChatGPTCapabilities(id)
  model.modelCapabilities = capabilities
  const reviewed = reviewedModels.get(id)
  if (!reviewed) return model
  const modelDocumentation = `https://developers.openai.com/api/docs/models/${id}`
  capabilities.chat = model.conversation = 'supported'
  capabilities.stream = model.streaming = 'supported'
  model.efforts = [...ordinaryEfforts]
  model.reasoning = 'supported'; model.reasoningMandatory = reviewed.reasoningRequired
  // The reviewed subscription catalog does not offer none. For models whose
  // API docs allow it, leave disabling/requirement unknown on this route rather
  // than turning a conservative omission into a claim that reasoning is required.
  capabilities.reasoning = { support: 'supported', disable: reviewed.reasoningRequired ? 'unsupported' : 'unknown',
    effortSelection: 'supported', efforts: [...model.efforts], requirement: reviewed.reasoningRequired ? 'required' : 'unknown' }
  capabilities.sources = [{ kind: 'official-model-documentation', url: signInDocumentation, reviewedOn },
    { kind: 'official-model-documentation', url: modelDocumentation, reviewedOn },
    { kind: 'official-model-documentation', url: codexCatalog, reviewedOn }]
  // Intentionally conservative local input + output budgets, never advertised
  // server limits. Apply the 95% choice once, then Vivi's own output reserve and
  // compaction threshold inside it; do not copy pi's maxTokens/output reserve.
  model.contextBudget = { tokens: reviewed.budget,
    source: { kind: 'official-model-documentation', url: id === 'gpt-6.1-sol' ? modelDocumentation : codexCatalog, reviewedOn } }
  return model
}
class ChatGPTModelCatalogError extends Error {}
const field = (value: unknown, name: string): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}
const identifier = (value: unknown): value is string => typeof value === 'string' &&
  /^[^\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,200}$/.test(value)
const label = (value: unknown, fallback: string): string => typeof value === 'string' && value.length > 0 && value.length <= 300 &&
  !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value) ? value : fallback

/** ChatGPT's account-specific schema is not API-key GET /models. Preserve server ordering.
 * Documentation can establish a route capability, never account availability. */
export function parseChatGPTModelCatalog(input: unknown): ModelEntry[] {
  const entries = field(input, 'models')
  if (!Array.isArray(entries) || entries.length > MAX_MODELS) throw new ChatGPTModelCatalogError('ChatGPT model catalog has an unsupported format or size')
  const models: ModelEntry[] = [], seen = new Set<string>()
  for (let index = 0; index < entries.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(entries, String(index))
    const entry: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined
    const id = field(entry, 'slug')
    if (field(entry, 'visibility') !== 'list' || !identifier(id) || seen.has(id)) continue
    seen.add(id)
    const model = reviewedModel(id)
    models.push({ ...model, name: label(field(entry, 'display_name'), id),
      source: model.conversation === 'supported'
        ? 'Selected ChatGPT account model catalog; reviewed text, streaming and reasoning documentation; local context budget (account limits unverified)'
        : 'Selected ChatGPT account model catalog; capabilities not advertised' })
  }
  if (!models.length) throw new ChatGPTModelCatalogError('No selectable models were returned for this ChatGPT account')
  return models
}
export interface ChatGPTModelCatalogOptions {
  accessToken(accountId: string, signal?: AbortSignal): Promise<string>
  fetch?: typeof fetch
  now?: () => number
}
/** Read-only discovery is bound to an exact validated registration, never the current email. */
export class ChatGPTModelCatalog {
  private readonly cache = new Map<string, CatalogResult>()
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  constructor(private readonly options: ChatGPTModelCatalogOptions) {
    this.fetcher = options.fetch ?? fetch; this.now = options.now ?? Date.now
  }
  clear(accountId?: string): void { if (accountId === undefined) this.cache.clear(); else this.cache.delete(accountId) }
  async list(accountId: string, signal?: AbortSignal, refresh = false): Promise<CatalogResult> {
    if (!identifier(accountId)) throw new ChatGPTModelCatalogError('Choose a ChatGPT account before loading models')
    if (signal?.aborted) throw new ChatGPTModelCatalogError('ChatGPT model loading cancelled')
    const cached = this.cache.get(accountId)
    if (!refresh && cached?.fetchedAt && this.now() - Date.parse(cached.fetchedAt) < 15 * 60 * 1000)
      return { ...structuredClone(cached), state: 'cached' }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, 20_000)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let rejectAborted: (error: unknown) => void = () => undefined
    const cancelled = new Promise<never>((_, reject) => { rejectAborted = reject })
    const onAbort = (): void => {
      if (reader) void reader.cancel().catch(() => undefined)
      rejectAborted(new ChatGPTModelCatalogError('ChatGPT model loading cancelled or timed out'))
    }
    controller.signal.addEventListener('abort', onAbort, { once: true })
    const check = (): void => {
      if (controller.signal.aborted) throw new ChatGPTModelCatalogError('ChatGPT model loading cancelled or timed out')
    }
    try {
      const work = (async (): Promise<CatalogResult> => {
        check()
        const token = await this.options.accessToken(accountId, controller.signal)
        check()
        const response = await this.fetcher('https://api.openai.com/v1/models', {
          method: 'GET', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: controller.signal
        })
        if (controller.signal.aborted) {
          if (response.body) void response.body.cancel().catch(() => undefined)
          check()
        }
        if (!response.ok) {
          if (response.body) void response.body.cancel().catch(() => undefined)
          this.cache.delete(accountId)
          throw new ChatGPTModelCatalogError(`ChatGPT model catalog is unavailable (HTTP ${response.status}); check the selected account and grant`)
        }
        if (Number(response.headers.get('content-length')) > MAX_BYTES) {
          if (response.body) void response.body.cancel().catch(() => undefined)
          throw new ChatGPTModelCatalogError('ChatGPT model catalog exceeds its size limit')
        }
        reader = response.body?.getReader()
        if (!reader) throw new ChatGPTModelCatalogError('ChatGPT model catalog returned an empty response')
        const chunks: Uint8Array[] = []; let length = 0
        for (;;) {
          const chunk = await reader.read()
          check()
          if (chunk.done) break
          length += chunk.value.byteLength
          if (length > MAX_BYTES) throw new ChatGPTModelCatalogError('ChatGPT model catalog exceeds its size limit')
          chunks.push(chunk.value)
        }
        let parsed: unknown
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
        catch { throw new ChatGPTModelCatalogError('ChatGPT model catalog did not return valid JSON') }
        const result: CatalogResult = { models: parseChatGPTModelCatalog(parsed), state: 'fresh', fetchedAt: new Date(this.now()).toISOString() }
        check()
        this.cache.set(accountId, structuredClone(result))
        return result
      })()
      return await Promise.race([work, cancelled])
    } catch (error) {
      if (controller.signal.aborted) throw new ChatGPTModelCatalogError('ChatGPT model loading cancelled or timed out')
      // Arbitrary transport/resolver errors can contain credential-bearing request data.
      if (error instanceof ChatGPTModelCatalogError) throw error
      throw new ChatGPTModelCatalogError('ChatGPT model catalog could not be loaded; check the selected account and connection')
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', onAbort)
      controller.abort(); if (reader) void reader.cancel().catch(() => undefined)
    }
  }
}
