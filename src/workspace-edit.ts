// SPDX-License-Identifier: Apache-2.0
import { createHash } from 'node:crypto'
import type { JsonObject } from '@ayayaq/vivi'

export const WORKSPACE_MUTATION_TOOL_NAMES = Object.freeze(['workspace_create_text', 'workspace_edit_text'] as const)
export const WORKSPACE_MUTATION_LIMITS = Object.freeze({ maximumFileBytes: 256 * 1024, maximumDiffBytes: 48 * 1024 })
export type WorkspaceMutationName = typeof WORKSPACE_MUTATION_TOOL_NAMES[number]
/** Ephemeral exact preparation. Full file bytes are never persisted as recovery copies. */
export interface WorkspaceMutation {
  readonly kind: 'create' | 'edit'
  readonly path: string
  readonly expectedRevision: string
  readonly revision: string
  readonly before: string | null
  readonly after: string
  readonly beforeChange: string | null
  readonly afterChange: string
  readonly diff: string
}
export interface WorkspaceCommitResult { readonly path: string; readonly revision: string }
/** Publication succeeded; reporting a failed mutation would invite an unsafe retry. */
export class WorkspaceCommitError extends Error {
  readonly committed = true
  constructor(readonly result: WorkspaceCommitResult) {
    super('Workspace change was saved, but final durability or staging cleanup could not be confirmed. Check the file before retrying')
    this.name = 'WorkspaceCommitError'
  }
}
export function workspaceRevision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
/** Quoted diff lines keep CR/LF, tabs, BOM and terminal controls visible and exact. */
function quote(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
function lines(value: string): string[] { return value.match(/[^\n]*\n|[^\n]+$/g) ?? [] }
export function workspaceDiff(path: string, before: string | null, after: string): string {
  const oldLines = lines(before ?? ''), newLines = lines(after)
  let prefix = 0, suffix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++
  const start = Math.max(0, prefix - 3), oldEnd = Math.min(oldLines.length, oldLines.length - suffix + 3),
    newEnd = Math.min(newLines.length, newLines.length - suffix + 3)
  const diff = [`--- ${before === null ? '(new file)' : quote(path)}`, `+++ ${quote(path)}`,
    `@@ -${start + (oldLines.length ? 1 : 0)},${oldEnd - start} +${start + (newLines.length ? 1 : 0)},${newEnd - start} @@ (JSON-quoted lines)`]
  for (const line of oldLines.slice(start, prefix)) diff.push(` ${quote(line)}`)
  for (const line of oldLines.slice(prefix, oldLines.length - suffix)) diff.push(`-${quote(line)}`)
  for (const line of newLines.slice(prefix, newLines.length - suffix)) diff.push(`+${quote(line)}`)
  for (const line of oldLines.slice(oldLines.length - suffix, oldEnd)) diff.push(` ${quote(line)}`)
  return diff.join('\n')
}
export function validateWorkspaceMutation(name: string, arguments_: Readonly<JsonObject>): void {
  const edit = name === 'workspace_edit_text'
  if (!WORKSPACE_MUTATION_TOOL_NAMES.includes(name as WorkspaceMutationName) ||
    Object.keys(arguments_).some(key => !(edit ? ['path', 'expectedRevision', 'before', 'after'] : ['path', 'content']).includes(key))) {
    throw new Error('Unexpected workspace mutation argument')
  }
  if (typeof arguments_.path !== 'string') throw new Error('A workspace-relative file path is required')
  for (const key of edit ? ['before', 'after'] : ['content']) {
    const value = arguments_[key]
    if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > WORKSPACE_MUTATION_LIMITS.maximumFileBytes ||
      Buffer.from(value).toString('utf8') !== value) throw new Error('Use bounded valid UTF-8 text without NUL bytes')
  }
  if (edit && (typeof arguments_.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(arguments_.expectedRevision) ||
    arguments_.before === '' || arguments_.before === arguments_.after)) {
    throw new Error('Editing requires the latest SHA-256 revision, a nonempty literal before target, and a different after value')
  }
}
