// SPDX-License-Identifier: Apache-2.0
export const CODE_LIMITS = Object.freeze({
  calls: 8, concurrent: 4, sourceBytes: 8192, argumentBytes: 4096, outputBytes: 8192,
  heapBytes: 8 * 1024 * 1024, timeoutMs: 10000
})
export function isCodeRead(name: unknown): name is 'workspace_read' | 'workspace_search' {
  return name === 'workspace_search' || name === 'workspace_read'
}
