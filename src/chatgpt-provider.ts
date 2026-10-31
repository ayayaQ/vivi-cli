// SPDX-License-Identifier: Apache-2.0
import type { HistoryMessage, JsonObject, JsonValue, ModelProvider, ProviderGenerateOptions } from '@ayayaq/vivi'
import { createOpenAIProvider, ProviderRequestError } from '@ayayaq/vivi/providers/openai'
import type { OpenAIProviderOptions } from '@ayayaq/vivi/providers/openai'
import type { ModelCapabilities } from '@ayayaq/vivi/providers/models'

import { CHATGPT_RESOURCE, CHATGPT_USAGE_URL, ChatGptAuthError } from './chatgpt-auth-types.js'
export { CHATGPT_USAGE_URL } from './chatgpt-auth-types.js'
export const CHATGPT_TOOL_NAMESPACE = 'vivi'
const unsupported = new Set(['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata',
  'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature',
  'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id'])
const record = (value: JsonValue | undefined): value is JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Route-specific policy is CLI-owned. No OAuth credential enters this pure projection. */
export function projectChatGPTRequest(body: JsonObject): JsonObject {
  const projected: JsonObject = {}
  for (const [key, value] of Object.entries(body)) if (!unsupported.has(key)) projected[key] = value
  if (!Array.isArray(projected.input)) throw new Error('ChatGPT requests require local input history')
  projected.input = projected.input.map(item => {
    if (!record(item)) throw new Error('ChatGPT input item must be an object')
    if (item.role === 'system') return { ...item, role: 'developer' }
    if (item.type === 'function_call') {
      if (item.namespace !== undefined && item.namespace !== CHATGPT_TOOL_NAMESPACE) throw new Error('Incompatible ChatGPT tool namespace')
      return { ...item, namespace: CHATGPT_TOOL_NAMESPACE }
    }
    return item
  })
  if (Array.isArray(projected.tools) && projected.tools.length) {
    if (projected.tools.some(tool => !record(tool) || tool.type !== 'function')) throw new Error('Unsupported ChatGPT tool type')
    projected.tools = [{ type: 'namespace', name: CHATGPT_TOOL_NAMESPACE,
      description: 'Vivi host tools. The host independently validates and authorizes every operation.', tools: projected.tools }]
  }
  projected.store = false
  projected.stream = true
  return projected
}

/** No static API-key model registry is evidence about a ChatGPT account's capabilities. */
export function unknownChatGPTCapabilities(model: string): ModelCapabilities {
  return { apiVersion: 1, provider: 'openai', protocol: 'responses', id: model,
    chat: 'unknown', tools: 'unknown', vision: 'unknown', stream: 'unknown',
    reasoning: { support: 'unknown', disable: 'unknown', effortSelection: 'unknown', efforts: [], requirement: 'unknown' }, sources: [] }
}
export type ChatGPTProviderOptions = Pick<OpenAIProviderOptions, 'model' | 'reasoning' | 'supportedReasoningEfforts' |
  'timeoutMs' | 'fetch' | 'resolveImage' | 'modelCapabilities'> & {
  /** Exact validated registration, including its workspace/client binding. */
  accountId: string
  accessToken(signal?: AbortSignal): Promise<string>
  /** Trusted launch-local generation guard. Never persisted or model-controlled. */
  isCurrent?(): boolean
  /** Display choice only: the authenticated HTTP route always uses SSE. */
  stream?: boolean
}
export class ChatGPTInferenceError extends Error {
  readonly status: number | undefined
  readonly details: ProviderRequestError['details']
  constructor(error: ProviderRequestError) {
    const code = error.details?.code
    const recovery = code === 'subscription_sharing_usage_limit_exceeded'
      ? `ChatGPT usage limit reached. Manage usage: ${CHATGPT_USAGE_URL}`
      : code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable'
        ? 'ChatGPT plan usage is temporarily unavailable; credentials were retained. Try again later.'
      : code === 'subscription_sharing_user_not_eligible'
        ? 'ChatGPT plan usage is unavailable for this account or workspace. Choose another supported billing path explicitly.'
      : code === 'subscription_sharing_unsupported_capability'
        ? 'ChatGPT rejected an unsupported request capability; change the indicated setting before retrying.'
      : code === 'subscription_sharing_invalid_user' || error.status === 401
        ? 'ChatGPT did not accept this account or grant. Check the selected account and sign in again if access was revoked.'
      : error.message.replaceAll('OpenAI', 'ChatGPT')
    const diagnostics = [error.status === undefined ? undefined : `HTTP ${error.status}`, code,
      error.details?.param ? `parameter ${error.details.param}` : undefined,
      error.details?.requestId ? `request ${error.details.requestId}` : undefined].filter(Boolean).join('; ')
    super(`${recovery}${diagnostics ? ` (${diagnostics})` : ''}`)
    this.name = error.name === 'AbortError' ? 'AbortError' : 'ChatGPTInferenceError'
    this.status = error.status
    this.details = error.details
  }
}

/** Fresh selected-registration credentials for each dispatch; never a paid-provider fallback. */
export function createChatGPTProvider(options: ChatGPTProviderOptions): ModelProvider {
  const { accessToken, accountId, isCurrent, stream = false, ...adapterOptions } = options
  if (!/^[a-f0-9]{64}$/.test(accountId)) throw new Error('ChatGPT provider requires a validated account registration')
  if (isCurrent !== undefined && typeof isCurrent !== 'function') throw new Error('ChatGPT account generation guard must be a function')
  let invalidated = false
  const assertCurrent = (): void => {
    try { if (!invalidated && (isCurrent === undefined || isCurrent() === true)) return }
    catch { /* A failing trusted guard cannot authorize use of a credential. */ }
    invalidated = true
    throw new ChatGptAuthError('account-changed')
  }
  const fetcher = adapterOptions.fetch ?? globalThis.fetch
  if (typeof fetcher !== 'function') throw new Error('ChatGPT inference transport is unavailable')
  const binding = `chatgpt:${accountId}:${options.model}`
  const history = (messages: readonly HistoryMessage[]): HistoryMessage[] => messages.map(message => {
    if (message.kind !== 'assistant' || !message.providerState) return message
    if (message.providerState.provider !== binding) throw new Error('ChatGPT native history belongs to another account or model')
    return { ...message, providerState: { ...message.providerState, provider: `openai:${options.model}` } }
  })
  if (typeof accessToken !== 'function') throw new Error('ChatGPT credential resolver is required')
  if (typeof stream !== 'boolean') throw new Error('ChatGPT display streaming choice must be a boolean')
  let projectionObserved = false
  const project = (body: JsonObject): JsonObject => {
    const result = projectChatGPTRequest(body)
    projectionObserved = true
    return result
  }
  const fixed = { ...adapterOptions, ...(adapterOptions.reasoning ? { reasoning: structuredClone(adapterOptions.reasoning) } : {}),
    ...(adapterOptions.supportedReasoningEfforts ? { supportedReasoningEfforts: [...adapterOptions.supportedReasoningEfforts] } : {}), modelCapabilities: structuredClone(adapterOptions.modelCapabilities ?? unknownChatGPTCapabilities(options.model)),
    baseURL: CHATGPT_RESOURCE, stream: true, errorDetails: true, transformRequest: project,
    fetch: ((url, init) => { assertCurrent(); return fetcher(url, init) }) as typeof fetch }
  const estimate = createOpenAIProvider({ ...fixed, apiKey: 'unused-context-estimate' })
  // Older cores ignore unknown options. Prove the route projection is active
  // with a pure synthetic estimate before resolving credentials or network I/O.
  try { estimate.estimateContext?.({ messages: [], tools: [] }) } catch { /* Fail closed below. */ }
  if (!projectionObserved) throw new Error('ChatGPT sign-in inference requires a Vivi core release with request projection support. No credential or request was sent')
  return {
    estimateContext(input, limits) { return estimate.estimateContext!({ ...input, messages: history(input.messages) }, limits) },
    async generate(input, signal, progress?: ProviderGenerateOptions) {
      assertCurrent()
      const projected = { ...input, messages: history(input.messages) }
      // Resolve outside the core API-key callback so a safe account/refresh error is not hidden.
      let token: string
      try { token = await accessToken(signal) }
      catch (error) {
        assertCurrent()
        if (error instanceof ChatGptAuthError) throw error
        if (signal.aborted) throw new ProviderRequestError('OpenAI', 'aborted', 'ChatGPT request cancelled')
        throw new Error('ChatGPT credential renewal failed; check the selected account and sign-in status')
      }
      assertCurrent()
      if (signal.aborted) throw new ProviderRequestError('OpenAI', 'aborted', 'ChatGPT request cancelled')
      const provider = createOpenAIProvider({ ...fixed, apiKey: token })
      try {
        const display = { ...progress }
        if (!stream) delete display.onProgress
        else if (progress?.onProgress) display.onProgress = async event => {
          assertCurrent(); await progress.onProgress!(event); assertCurrent()
        }
        const result = await provider.generate(projected, signal, display)
        assertCurrent()
        // A namespace is part of executable identity, not display metadata. Never route another
        // namespace's function into a local tool with the same short name.
        for (const item of result.providerState?.items ?? []) if (record(item) && item.type === 'function_call' &&
            item.namespace !== CHATGPT_TOOL_NAMESPACE) throw new Error('ChatGPT returned an incompatible tool namespace')
        return { ...result, ...(result.providerState ? { providerState: { ...result.providerState, provider: binding } } : {}) }
      } catch (error) {
        assertCurrent()
        if (error instanceof ProviderRequestError) throw new ChatGPTInferenceError(error)
        throw error
      }
    }
  }
}
