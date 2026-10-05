// SPDX-License-Identifier: Apache-2.0
import type { ReasoningEffort } from '@ayayaq/vivi/providers/openrouter'
import { normalizeModelCapabilities } from '@ayayaq/vivi/providers/models'
import type { ModelCapabilities } from '@ayayaq/vivi/providers/models'
import type { CliProviderName } from './session.js'
import { createHash } from 'node:crypto'

export type Capability = 'supported' | 'unsupported' | 'unknown'
export interface ModelEntry {
  id: string
  name: string
  tools: Capability
  conversation: Capability
  streaming: Capability
  efforts: ReasoningEffort[]
  reasoning: Capability
  reasoningMandatory: boolean
  source: string
}
export interface CatalogResult { models: ModelEntry[]; state: 'fresh' | 'cached' | 'stale'; warning?: string }
export interface Catalog {
  list(provider: CliProviderName, apiKey?: string, signal?: AbortSignal, refresh?: boolean): Promise<CatalogResult>
}
const MAX_BYTES = 4 * 1024 * 1024
const MAX_MODELS = 5000
class ModelCatalogError extends Error {}
const ACCESS_DENIED = 'Model access was denied; check this provider’s key with /provider'
export function modelAccessDenied(error: unknown): boolean {
  return error instanceof ModelCatalogError && error.message === ACCESS_DENIED
}
const endpoints = { openai: 'https://api.openai.com/v1/models', openrouter: 'https://openrouter.ai/api/v1/models' }

// GET /v1/models has no capability metadata. These exact Responses model IDs are
// verified against their official model pages; unknown IDs remain chat-only/default.
// https://developers.openai.com/api/docs/models/{id}
interface VerifiedModel { efforts: ReasoningEffort[]; streaming: Capability }
const openaiCapabilities: Record<string, VerifiedModel> = Object.create(null) as Record<string, VerifiedModel>
// Exact documented models whose task-specific endpoint cannot accept a text
// conversation through the CLI's Responses adapter. Unknown future IDs are not guessed.
// Sources: official /api/docs/models/{id} pages and their explicit Snapshots;
// /api/docs/guides/{embeddings,image-generation,speech-to-text,text-to-speech,
// audio-chat-completions,realtime,tools-web-search} and /api/docs/deprecations.
const nonConversationOpenAI = new Set([
  'text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002',
  'gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-1.5-2025-12-16', 'gpt-image-2',
  'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'chatgpt-image-latest', 'dall-e-2', 'dall-e-3',
  'whisper-1', 'gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe-diarize',
  'gpt-4o-mini-transcribe-2025-03-20', 'gpt-4o-mini-transcribe-2025-12-15',
  'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-03-20', 'gpt-4o-mini-tts-2025-12-15', 'tts-1', 'tts-1-hd',
  'gpt-live-1', 'gpt-live-transcribe', 'gpt-realtime-whisper', 'gpt-realtime-translate',
  'gpt-realtime', 'gpt-realtime-mini', 'gpt-realtime-1.5', 'gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini',
  'gpt-realtime-2025-08-28', 'gpt-realtime-mini-2025-10-06', 'gpt-realtime-mini-2025-12-15',
  'gpt-audio', 'gpt-audio-mini', 'gpt-audio-1.5', 'gpt-audio-2025-08-28', 'gpt-audio-mini-2025-10-06', 'gpt-audio-mini-2025-12-15',
  'gpt-4o-audio-preview', 'gpt-4o-audio-preview-2024-10-01', 'gpt-4o-audio-preview-2024-12-17', 'gpt-4o-audio-preview-2025-06-03',
  'gpt-4o-mini-audio-preview', 'gpt-4o-mini-audio-preview-2024-12-17',
  'gpt-4o-realtime-preview', 'gpt-4o-realtime-preview-2024-10-01', 'gpt-4o-realtime-preview-2024-12-17', 'gpt-4o-realtime-preview-2025-06-03',
  'gpt-4o-mini-realtime-preview', 'gpt-4o-mini-realtime-preview-2024-12-17',
  'omni-moderation-latest', 'omni-moderation-2024-09-26', 'text-moderation-latest', 'text-moderation-stable', 'text-moderation-007',
  'sora-2', 'sora-2-pro', 'babbage-002', 'davinci-002', 'gpt-3.5-turbo-instruct',
  'gpt-4o-search-preview', 'gpt-4o-search-preview-2025-03-11', 'gpt-4o-mini-search-preview', 'gpt-4o-mini-search-preview-2025-03-11',
  'gpt-5-search-api', 'chatgpt-4o-latest'
])
function documented(ids: string[], supported: ReasoningEffort[], streaming: Capability = 'supported'): void {
  for (const id of ids) openaiCapabilities[id] = { efforts: supported, streaming }
}
documented(['gpt-6-astra', 'gpt-6.1-sol'], ['low', 'medium', 'high', 'xhigh', 'max'])
documented(['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6'], ['none', 'low', 'medium', 'high', 'xhigh', 'max'])
documented(['gpt-5', 'gpt-5-2025-08-07', 'gpt-5-mini', 'gpt-5-mini-2025-08-07', 'gpt-5-nano', 'gpt-5-nano-2025-08-07'], ['minimal', 'low', 'medium', 'high'])
documented(['gpt-5-pro', 'gpt-5-pro-2025-10-06'], ['high'])
documented(['gpt-5.1', 'gpt-5.1-2025-11-13'], ['none', 'low', 'medium', 'high'])
documented(['gpt-5.2', 'gpt-5.2-2025-12-11', 'gpt-5.4', 'gpt-5.4-2026-03-05', 'gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17', 'gpt-5.5', 'gpt-5.5-2026-04-23'], ['none', 'low', 'medium', 'high', 'xhigh'])
documented(['gpt-5.2-pro', 'gpt-5.2-pro-2025-12-11', 'gpt-5.4-pro', 'gpt-5.4-pro-2026-03-05'], ['medium', 'high', 'xhigh'])
documented(['gpt-5.5-pro', 'gpt-5.5-pro-2026-04-23'], ['medium', 'high', 'xhigh'], 'unsupported')
documented(['o3', 'o3-2025-04-16', 'o3-mini', 'o3-mini-2025-01-31', 'o4-mini', 'o4-mini-2025-04-16'], ['low', 'medium', 'high'])
documented(['o3-pro', 'o3-pro-2025-06-10'], [], 'unsupported')
documented(['gpt-4.1', 'gpt-4.1-2025-04-14', 'gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14', 'gpt-4.1-nano', 'gpt-4.1-nano-2025-04-14',
  'gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20', 'gpt-4o-mini', 'gpt-4o-mini-2024-07-18'], [])

const object = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
// Catalog entries are data. Never invoke an accessor while reading untrusted fields.
const field = (value: unknown, key: string): unknown => {
  if (!object(value)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[^\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,200}$/.test(value)
const label = (value: unknown, fallback: string): string => typeof value === 'string' && value.length <= 300 &&
  !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value) ? value : fallback
export function unknownModel(id: string): ModelEntry {
  return { id, name: id, tools: 'unknown', conversation: 'unknown', streaming: 'unknown', efforts: [], reasoning: 'unknown', reasoningMandatory: false, source: 'Capability metadata unavailable' }
}
function applyCapabilities(model: ModelEntry, shared: ModelCapabilities): void {
  if (shared.tools !== 'unknown') model.tools = shared.tools
  if (shared.chat !== 'unknown') model.conversation = shared.chat
  if (shared.stream !== 'unknown') model.streaming = shared.stream
  if (shared.reasoning.support !== 'unknown') model.reasoning = shared.reasoning.support
  if (shared.reasoning.requirement !== 'unknown') model.reasoningMandatory = shared.reasoning.requirement === 'required'
  // The existing factory/UI uses none as its explicit-disable sentinel. Named
  // efforts alone cannot describe optional token-budget reasoning without a selector.
  const disable = shared.reasoning.disable === 'supported' ||
    shared.reasoning.disable === 'unknown' && model.efforts.includes('none')
  const named = shared.reasoning.effortSelection === 'unknown' ? model.efforts :
    shared.reasoning.effortSelection === 'supported' ? shared.reasoning.efforts : []
  model.efforts = named.filter(effort => effort !== 'none')
  if (disable && !model.reasoningMandatory) model.efforts.unshift('none')
}
export function documentedOpenAIModel(id: string): ModelEntry {
  const model = unknownModel(id)
  if (!identifier(id)) return model
  const verified = openaiCapabilities[id]
  if (nonConversationOpenAI.has(id)) {
    model.conversation = 'unsupported'
    return model
  }
  if (verified) Object.assign(model, { tools: 'supported', conversation: 'supported', streaming: verified.streaming,
    reasoning: verified.efforts.length ? 'supported' : 'unknown', efforts: [...verified.efforts],
    reasoningMandatory: verified.efforts.length > 0 && !verified.efforts.includes('none'), source: 'Official OpenAI Responses model documentation' })
  // The shared seed enriches these exact host facts; unknown shared fields never
  // replace the CLI's broader documented registry or task-specific exclusions.
  const shared = normalizeModelCapabilities({ apiVersion: 1, provider: 'openai', protocol: 'responses', model: { id } })
  applyCapabilities(model, shared)
  if (shared.sources.length) model.source = 'Official OpenAI Responses model documentation'
  return model
}
export function parseModelCatalog(provider: CliProviderName, input: unknown): ModelEntry[] {
  const data = field(input, 'data')
  if (!Array.isArray(data) || data.length > MAX_MODELS) throw new ModelCatalogError('Model catalog has an unsupported format or size')
  const models = new Map<string, ModelEntry>()
  for (let index = 0; index < data.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(data, String(index))
    const raw: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined
    const id = field(raw, 'id')
    if (!identifier(id)) continue
    const model = unknownModel(id)
    model.name = label(field(raw, 'name'), id)
    if (provider === 'openai') {
      Object.assign(model, documentedOpenAIModel(id))
    } else {
      // OpenRouter model metadata describes its Chat Completions gateway. Never
      // infer capabilities from model names. Unknown/future efforts are omitted.
      applyCapabilities(model, normalizeModelCapabilities({ apiVersion: 1, provider: 'openrouter', protocol: 'chat-completions', model: raw }))
      model.source = 'OpenRouter model catalog metadata'
    }
    if (model.conversation === 'unsupported') continue
    models.set(model.id, model)
  }
  if (!models.size) throw new ModelCatalogError('No selectable models were returned by the provider')
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** Bounded read-only discovery. Only fixed official endpoints can receive keys.
 * Cache stays in memory, contains no credentials, and stale results are explicit. */
export class ModelCatalog implements Catalog {
  private readonly cache = new Map<CliProviderName, { result: ModelEntry[]; at: number; fingerprint: string }>()
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {}
  async list(provider: CliProviderName, apiKey?: string, signal?: AbortSignal, refresh = false): Promise<CatalogResult> {
    if (signal?.aborted) throw new ModelCatalogError('Model loading cancelled')
    const fingerprint = createHash('sha256').update(apiKey ?? '').digest('hex')
    const cached = this.cache.get(provider)
    // OpenAI visibility is account-specific; never reuse another key's catalog.
    const usable = cached?.fingerprint === fingerprint ? cached : undefined
    if (!refresh && usable && this.now() - usable.at < 15 * 60 * 1000) return { models: structuredClone(usable.result), state: 'cached' }
    if (provider === 'openai' && !apiKey) throw new ModelCatalogError('Set up OpenAI with /provider before loading its models')
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) controller.abort()
    const timeout = setTimeout(abort, 10000)
    let accessDenied = false
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const endpoint = provider === 'openrouter' && apiKey ? `${endpoints.openrouter}/user` : endpoints[provider]
      const response = await this.fetcher(endpoint, { headers, signal: controller.signal, redirect: 'error' })
      if (response.status === 401 || response.status === 403) { accessDenied = true; this.cache.delete(provider) }
      if (!response.ok) throw new ModelCatalogError(response.status === 401 || response.status === 403
        ? ACCESS_DENIED
        : `Model catalog is unavailable (HTTP ${response.status})`)
      if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new ModelCatalogError('Model catalog exceeds its size limit')
      const reader = response.body?.getReader()
      if (!reader) throw new ModelCatalogError('Model catalog returned an empty response')
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          length += chunk.value.byteLength
          if (length > MAX_BYTES) throw new ModelCatalogError('Model catalog exceeds its size limit')
          chunks.push(chunk.value)
        }
      } finally { await reader.cancel().catch(() => undefined) }
      let parsed: unknown
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch { throw new ModelCatalogError('Model catalog did not return valid JSON') }
      const models = parseModelCatalog(provider, parsed)
      this.cache.set(provider, { result: models, at: this.now(), fingerprint })
      return { models: structuredClone(models), state: 'fresh' }
    } catch (error) {
      if (signal?.aborted) throw new ModelCatalogError('Model loading cancelled')
      // Never echo response bodies or fetch errors (which may include request headers).
      const warning = error instanceof ModelCatalogError
        ? error.message : 'Model catalog could not be loaded; check your connection and try again'
      if (usable && !accessDenied) return { models: structuredClone(usable.result), state: 'stale', warning }
      throw new ModelCatalogError(warning)
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
  }
}
