// SPDX-License-Identifier: Apache-2.0
import type { ToolCall, ToolResult } from '@ayayaq/vivi'
import type { ToolExtension } from '@ayayaq/vivi/extensions'
import { mcpFreeze, mcpRecord, mcpText, validateMcpServer } from './mcp-config.js'
import { mcpContainsSecret } from './mcp-content.js'

export const MCP_SETUP_TOOL_NAMES = ['mcp_list', 'mcp_setup'] as const
export const MCP_SETUP_GUIDANCE = 'mcp_list reads only local, credential-free MCP configuration and connection status. mcp_setup proposes a bounded HTTP endpoint setup action through the same trusted host controls as /mcp. Every configuration change, connection and sign-in action requires fresh human review, including in Auto. An expectedRevision is only a freshness check, never approval. Add saves a disabled entry and does not connect. Login opens the host-guided browser flow; the user grants account access in the browser. Trusted controls review the exact connection or bundled registration/sign-in/connection plan. Never request or supply passwords, tokens, headers, environment values, OAuth client secrets, arbitrary settings or installation commands. Newly connected MCP tools become available in the next turn. Do not retry uncertain setup outcomes; inspect /mcp first.'

/** Trusted application callbacks only. This pack exposes no store, credentials or IO object.
 * listLocal must be an inert local projection: no reload-driven revocation, refresh or network.
 * executeSetup owns exact proposal preparation, human review and commit-time freshness guards.
 * It must preserve confirmed effects across late cancellation and never replay uncertain sends. */
export interface McpSetupToolHost {
  listLocal(signal: AbortSignal): Promise<ToolResult>
  executeSetup(call: ToolCall, signal: AbortSignal): Promise<ToolResult>
  /** Read again around each callback; OAuth can register credentials during the call. */
  secrets?(): readonly string[]
}

function validateSetupArguments(args: unknown): void {
  if (!mcpRecord(args) || Object.keys(args).some(key => !['action', 'id', 'expectedRevision', 'endpoint', 'label', 'protocol'].includes(key)) ||
    !['add', 'connect', 'login', 'logout', 'remove'].includes(String(args.action)) ||
    typeof args.action !== 'string' || typeof args.id !== 'string' || !/^[a-z][a-z0-9_-]{0,15}$/.test(args.id) ||
    typeof args.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(args.expectedRevision)) {
    throw new Error('mcp_setup requires an exact supported action, local server ID and configuration revision')
  }
  if (args.action !== 'add') {
    if (Object.keys(args).length !== 3) throw new Error('Only add accepts endpoint, label or protocol')
    return
  }
  if (!mcpText(args.endpoint, 4096) || Object.hasOwn(args, 'label') && !mcpText(args.label, 80) ||
    Object.hasOwn(args, 'protocol') && !['legacy', '2026-07-28'].includes(String(args.protocol))) {
    throw new Error('MCP add requires a bounded HTTPS endpoint and optional label/protocol')
  }
  // Reuse the existing exact HTTP validator. The model cannot enable insecure
  // loopback, headers, credentials, queries, fragments, process execution or installation.
  validateMcpServer({ transport: 'http', id: args.id, label: args.label ?? args.id,
    endpoint: args.endpoint, protocol: args.protocol ?? '2026-07-28', allowLoopbackHttp: false })
}

function withheldResult(result: ToolResult, local: boolean, screeningUnavailable = false): ToolResult {
  let body: unknown
  try { body = JSON.parse(result.content) } catch { /* Unreported effects remain uncertain. */ }
  const record = mcpRecord(body) ? body : undefined
  if (local) {
    const success = !result.isError && record?.success !== false
    return { content: JSON.stringify({ success, source: 'mcp', localMetadataOnly: true,
      requestSent: false, contentWithheld: true, confirmedOutcome: true,
      message: screeningUnavailable ? 'Local MCP status content was withheld because credential screening is unavailable. No remote request was sent'
        : 'Local MCP status content was withheld because it contains a known credential. No remote request was sent' }),
      ...(!success ? { isError: true } : {}) }
  }
  const confirmed = record?.unknownOutcome !== true && record?.confirmedOutcome === true && typeof record.success === 'boolean'
  return { content: JSON.stringify({ success: confirmed ? record?.success : false, source: 'mcp-setup',
    contentWithheld: true, doNotRetry: true,
    ...(confirmed ? { confirmedOutcome: true } : { unknownOutcome: true }),
    message: screeningUnavailable ? 'MCP setup content was withheld because credential screening is unavailable. Inspect /mcp before retrying'
      : 'MCP setup content was withheld because it contains a known credential. Inspect /mcp before retrying' }),
    ...(result.isError || !confirmed || record?.success === false ? { isError: true } : {}) }
}

/** Detach exact inert fields before screening. Host callbacks can retain their
 * own result object; accessors, mutable metadata and oversized results are not admitted. */
function captureResult(value: unknown): ToolResult {
  if (!mcpRecord(value) || Object.keys(value).some(key => !['content', 'isError'].includes(key)) ||
    typeof value.content !== 'string' || Buffer.byteLength(value.content, 'utf8') > 64 * 1024 ||
    Object.hasOwn(value, 'isError') && typeof value.isError !== 'boolean') throw new Error('Invalid MCP setup result')
  return mcpFreeze({ content: value.content, ...(Object.hasOwn(value, 'isError') ? { isError: value.isError as boolean } : {}) })
}

/** A separate built-in pack, independent of connected catalogs and their remote-operation ledger. */
export function createMcpSetupExtension(host: McpSetupToolHost): ToolExtension {
  // Retained toolsets cannot swap trusted implementations by editing this object.
  const listLocal = host.listLocal.bind(host), executeSetup = host.executeSetup.bind(host)
  const secrets = host.secrets?.bind(host) ?? (() => [])
  const run = async (call: ToolCall, signal: AbortSignal, local: boolean): Promise<ToolResult> => {
    signal.throwIfAborted()
    let containsSecret: boolean
    try { containsSecret = mcpContainsSecret(call, secrets()) }
    catch {
      return { content: JSON.stringify({ success: false, source: 'mcp-setup', requestSent: false,
        error: { code: 'mcp_setup_screening_unavailable', message: 'MCP credential screening is unavailable; no setup action was started' } }), isError: true }
    }
    if (containsSecret) return { content: JSON.stringify({ success: false, source: 'mcp-setup', requestSent: false,
      error: { code: 'mcp_setup_credentials_blocked', message: 'MCP setup request contains a known credential; no action was started' } }), isError: true }
    const ownedCall = mcpFreeze({ id: call.id, name: local ? 'mcp_list' : 'mcp_setup', arguments: structuredClone(call.arguments) })
    let result: ToolResult
    try { result = captureResult(local ? await listLocal(signal) : await executeSetup(ownedCall, signal)) }
    catch {
      // Never propagate provider/OS diagnostics or exception text into model
      // context. A setup callback may have committed before throwing; only a
      // returned host outcome can establish whether the action was attempted.
      return { content: JSON.stringify({ success: false, source: local ? 'mcp' : 'mcp-setup',
        ...(local ? { localMetadataOnly: true, requestSent: false } : { unknownOutcome: true, doNotRetry: true }),
        error: { code: local ? 'mcp_local_status_unavailable' : 'mcp_setup_outcome_unavailable',
          message: local ? 'Local MCP status is unavailable' : 'MCP setup outcome is unavailable. Inspect /mcp before retrying' } }), isError: true }
    }
    // Do not discard a trusted confirmed outcome merely because cancellation
    // happened after its effect. The service owns effect/unknown-outcome reporting.
    try { return mcpContainsSecret(result, secrets()) ? withheldResult(result, local) : result }
    catch { return withheldResult(result, local, true) }
  }
  return { id: 'vivi-cli-mcp-setup', apiVersion: 1, tools: [
    { definition: { name: 'mcp_list',
      description: 'List local MCP entries, credential-free status and configuration revision. No network, process start, metadata refresh or sign-in.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
      validateArguments(args) { if (!mcpRecord(args) || Object.keys(args).length) throw new Error('mcp_list accepts no arguments') },
      execute: (call, { signal }) => run(call, signal, true) },
    { definition: { name: 'mcp_setup',
      description: 'Propose adding a disabled HTTPS MCP endpoint, connecting, guided login, local logout or removing its saved entry. Each action uses fresh human host review, including in Auto. Read mcp_list for expectedRevision. No commands, credentials or arbitrary settings. Newly connected tools are next-turn only.',
      parameters: { type: 'object', properties: {
        action: { type: 'string', enum: ['add', 'connect', 'login', 'logout', 'remove'] },
        id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,15}$' },
        expectedRevision: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        endpoint: { type: 'string', maxLength: 4096 }, label: { type: 'string', maxLength: 80 },
        protocol: { type: 'string', enum: ['legacy', '2026-07-28'] }
      }, required: ['action', 'id', 'expectedRevision'], additionalProperties: false } },
      validateArguments: validateSetupArguments,
      execute: (call, { signal }) => run(call, signal, false) }
  ] }
}
