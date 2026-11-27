// SPDX-License-Identifier: Apache-2.0
export const CODE_LIMITS = Object.freeze({
  calls: 8, concurrent: 4, sourceBytes: 8192, argumentBytes: 4096, outputBytes: 8192,
  heapBytes: 8 * 1024 * 1024, timeoutMs: 10000
})
export const CODE_READS = ['workspace_search', 'workspace_read', 'workspace_list', 'workspace_glob'] as const
export const CODE_WRITES = ['workspace_create_text', 'workspace_edit_text'] as const
export function isCodeWrite(name: string): boolean { return CODE_WRITES.some(tool => tool === name) }
