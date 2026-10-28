// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import type { HistoryMessage, Message } from '@ayayaq/vivi'

export interface SteeringMessage {
  readonly id: string
  readonly content: string
  /** A captured boundary batch cannot be edited while canonical admission settles. */
  readonly state?: 'sending'
}
export interface SteeringControls {
  submit(content: string, interrupt: boolean): boolean
  takeLast(): string | undefined
  clear(): void
}
export const STEERING_LIMITS = Object.freeze({ messages: 32, characters: 65536, bytes: 128 * 1024 })
interface Claim { readonly id: string; readonly index: number; readonly content: string }

/** Launch-local input only. Records never restore a queue, approval or executor. */
export class SteeringQueue {
  private pending: SteeringMessage[] = []
  private claims: Claim[] = []
  get messages(): readonly SteeringMessage[] {
    return this.pending.map(message => ({ ...message,
      ...(this.claims.some(claim => claim.id === message.id) ? { state: 'sending' as const } : {}) }))
  }
  add(content: string): SteeringMessage {
    if (!content.trim() || content.length > STEERING_LIMITS.characters) throw new Error('Message must contain 1..65536 characters')
    if (content.trim().startsWith('/')) throw new Error('Run slash commands after this turn; queued messages must be ordinary chat')
    if (this.pending.length >= STEERING_LIMITS.messages ||
      this.pending.reduce((total, message) => total + Buffer.byteLength(message.content), 0) +
        Buffer.byteLength(content) > STEERING_LIMITS.bytes) throw new Error('Message queue is full; edit or remove a queued message first')
    const message = Object.freeze({ id: randomUUID(), content })
    this.pending.push(message)
    return message
  }
  takeLast(): string | undefined {
    const message = this.pending.at(-1)
    if (!message || this.claims.some(claim => claim.id === message.id)) return undefined
    this.pending.pop()
    return message.content
  }
  clear(): void { this.pending = this.pending.filter(message => this.claims.some(claim => claim.id === message.id)) }
  /** Leave the first input queued until the new run checkpoints it successfully. */
  first(): SteeringMessage | undefined { return this.pending[0] }
  claimInitial(id: string, content: string, index: number): void {
    const message = this.pending[0]
    if (message?.id !== id || message.content !== content) throw new Error('Queued input changed before the next run started')
    this.claims.push({ id, content, index })
  }
  acknowledgeInitial(id: string): void {
    if (this.pending[0]?.id === id) this.pending.shift()
  }
  stage(historyLength: number): readonly Message[] {
    const messages = this.pending.filter(message => !this.claims.some(claim => claim.id === message.id))
    for (const [offset, message] of messages.entries()) this.claims.push({ id: message.id,
      index: historyLength + offset, content: message.content })
    return messages.map(message => ({ kind: 'message', role: 'user', content: message.content }))
  }
  acknowledge(message: Message, index: number): void {
    const claim = this.claims.find(item => item.index === index)
    if (!claim || message.kind !== 'message' || message.role !== 'user' || message.content !== claim.content) {
      throw new Error('Queued message admission did not match its current owner and FIFO history slot')
    }
    this.pending = this.pending.filter(item => item.id !== claim.id)
  }
  reconcile(history: readonly HistoryMessage[]): void {
    for (const claim of this.claims) {
      const message = history[claim.index]
      if (message?.kind === 'message' && message.role === 'user' && message.content === claim.content) {
        this.pending = this.pending.filter(item => item.id !== claim.id)
      }
    }
  }
  release(): void { this.claims = [] }
}
