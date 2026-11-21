// SPDX-License-Identifier: Apache-2.0
import type { ToolCall } from '@ayayaq/vivi'
import type { PreparedActionMetadata } from '@ayayaq/vivi/decisions'
import { agentArgumentsDigest } from '@ayayaq/vivi/events'
import { reviewDigest, type AutoReviewController, type ReviewSource } from './auto-review.js'
import { isCodeWrite } from './code-mode-contract.js'
import { mcpContainsSecret } from './mcp-content.js'
import { WorkspaceError, type ReadOnlyWorkspace } from './workspace.js'
import { WorkspaceCommitError, type WorkspaceMutation } from './workspace-edit.js'

export interface CodeWriteReceipt {
  id: string
  name: string
  path: string
  argumentsDigest: string
  status: 'not_attempted' | 'denied' | 'failed' | 'succeeded' | 'unknown'
  revision?: string
  reviewSource?: ReviewSource
  durabilityUnconfirmed?: true
}
export interface StagedWrite { call: ToolCall; receipt: CodeWriteReceipt }
export type ApplyCodeWrites = (parent: ToolCall, writes: StagedWrite[], signal: AbortSignal) => Promise<string | undefined>

export function stageCodeWrite(call: ToolCall): StagedWrite {
  return { call, receipt: { id: call.id, name: call.name, path: String(call.arguments.path),
    argumentsDigest: agentArgumentsDigest(call.arguments), status: 'not_attempted' } }
}

interface BatchContext {
  workspace: ReadOnlyWorkspace
  reviews: AutoReviewController
  userRequest: string
  secrets(): readonly string[]
  isActive(): boolean
  assertInstructions(path: string, signal: AbortSignal): Promise<void>
}

export async function applyCodeWrites(context: BatchContext, parent: ToolCall, writes: StagedWrite[], signal: AbortSignal): Promise<string | undefined> {
  const { workspace } = context
  const prepared: { mutation: WorkspaceMutation; receipt: CodeWriteReceipt }[] = []
  const checkCurrent = (): void => {
    signal.throwIfAborted()
    if (!context.isActive()) throw new WorkspaceError('Code Mode workspace tools changed during the query')
    const secrets = context.secrets()
    if (mcpContainsSecret([parent, writes, context.userRequest, prepared.map(item => item.mutation)], secrets)) {
      throw new WorkspaceError('Code Mode review contains a known credential')
    }
    workspace.addSecrets(secrets)
  }
  try {
    for (const { call, receipt } of writes) {
      checkCurrent()
      if (!isCodeWrite(call.name) || typeof call.arguments.path !== 'string') throw new WorkspaceError('Invalid workspace text change')
      await context.assertInstructions(call.arguments.path, signal)
      const mutation = await workspace.prepareMutation(call.name, call.arguments, signal)
      if (prepared.some(item => item.mutation.path === mutation.path)) throw new WorkspaceError('Combine changes to the same file into one edit per query')
      prepared.push({ mutation, receipt })
    }
    checkCurrent()
    const effects = prepared.map(({ mutation, receipt }) => ({
      kind: 'write', scope: 'workspace', resourceId: 'cli-workspace:' + mutation.path, review: 'model-review',
      affectedData: { tool: receipt.name, argumentsDigest: receipt.argumentsDigest, path: mutation.path,
        beforeRevision: mutation.expectedRevision, afterRevision: mutation.revision, before: mutation.beforeChange,
        after: mutation.afterChange, diff: mutation.diff }
    } satisfies PreparedActionMetadata['effects'][number]))
    const revisions = Object.fromEntries(prepared.map(({ mutation }) => ['cli-workspace:' + mutation.path, mutation.expectedRevision]))
    const description = ['Review these workspace changes in order. Completed changes are kept if a later change fails.',
      'User request', context.userRequest, 'Code Mode script', String(parent.arguments.code), 'Proposed changes',
      ...prepared.map(({ mutation }) => [mutation.diff, 'Before revision ' + mutation.expectedRevision, 'After revision ' + mutation.revision].join('\n'))].join('\n\n')
    const approved = await context.reviews.execute({
      approval: { call: parent, currentRevision: reviewDigest(revisions), description },
      eligible: true, skipEligible: true, inputData: { orderedPaths: prepared.map(({ mutation }) => mutation.path) },
      preparedAction: { complete: true, effects }, resourceRevisions: revisions, currentResourceRevisions: () => revisions, isActive: context.isActive
    }, signal, async (assertCurrent, source) => {
      for (const { mutation, receipt } of prepared) {
        const assertFresh = async (): Promise<void> => {
          checkCurrent(); assertCurrent()
          await context.assertInstructions(mutation.path, signal)
          checkCurrent(); assertCurrent()
        }
        await assertFresh()
        receipt.reviewSource = source
        try {
          const result = await workspace.commitMutation(mutation, signal, assertFresh)
          receipt.status = 'succeeded'
          receipt.revision = result.revision
        } catch (error) {
          if (error instanceof WorkspaceCommitError) {
            receipt.status = 'succeeded'
            receipt.revision = error.result.revision
            receipt.durabilityUnconfirmed = true
          } else receipt.status = error instanceof WorkspaceError ? 'failed' : 'unknown'
          throw error
        }
      }
      return true
    })
    if (!approved) {
      for (const { receipt } of writes) receipt.status = signal.aborted ? 'not_attempted' : 'denied'
      return signal.aborted ? 'Code Mode cancelled' : 'Workspace changes were denied'
    }
  } catch (error) {
    if (signal.aborted) return 'Code Mode cancelled'
    return error instanceof WorkspaceError || error instanceof WorkspaceCommitError ? error.message : 'Workspace batch stopped. Check individual write outcomes before retrying.'
  }
  return undefined
}
