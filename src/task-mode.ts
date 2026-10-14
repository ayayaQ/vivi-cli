// SPDX-License-Identifier: Apache-2.0
import type { ToolResult } from '@ayayaq/vivi'
import type { ApprovalMode } from './auto-review.js'
import { WORKSPACE_TOOL_NAMES } from './workspace.js'

/** Task permissions are independent of how eligible execution actions are reviewed. */
export type TaskMode = 'execute' | 'plan'
export type ConversationMode = ApprovalMode | 'plan'

// Host-owned local capabilities only. Descriptions, MCP readOnly hints and
// extension-supplied metadata cannot expand this permission set.
const localReadTools = new Set<string>([
  'request_user_input', 'calculate', 'current_time', 'note_read', 'list_memories', 'list_skills', 'read_skill', 'mcp_list',
  ...WORKSPACE_TOOL_NAMES
])
export function isPlanTool(name: string): boolean { return localReadTools.has(name) }
export function planModeRefusal(): ToolResult {
  return { content: JSON.stringify({ success: false, error: { code: 'plan_mode_read_only',
    message: 'Plan mode allows enabled local read tools and informational clarification only. Select Manual or enroll Auto review before executing task changes or remote requests.' } }), isError: true }
}
export const PLAN_MODE_GUIDANCE = 'Plan mode is active. Investigate using only the enabled local read tools and informational clarification, then describe a plan in your ordinary response. mcp_list can inspect credential-free local MCP status without networking or changing connections. Do not change workspace files, session notes or saved memories, execute commands, request public URLs, use mcp_setup, or call remote MCP tools/resources. Imported extensions are unavailable. A proposed plan is not execution approval. Remain in Plan mode until the user explicitly selects another mode; do not claim planned changes were made.'
export function conversationModeLabel(taskMode: TaskMode, approvalMode: ApprovalMode): string {
  return taskMode === 'plan' ? 'Plan' : approvalMode === 'auto' ? 'Auto review' : 'Manual'
}
