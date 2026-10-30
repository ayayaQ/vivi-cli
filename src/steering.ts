// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import type { HistoryMessage, Message } from '@ayayaq/vivi'

export interface SteeringMessage {
  readonly id: string
  readonly content: string
  /** Launch-local executable input; never admitted as mid-turn steering. */
  readonly kind?: 'shell'
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
  add(content: string, kind?: 'shell'): SteeringMessage {
    if (!content.trim() || content.length > STEERING_LIMITS.characters) throw new Error('Message must contain 1..65536 characters')
    if (content.trim().startsWith('/')) throw new Error('Run slash commands after this turn; queued messages must be ordinary chat')
    if (this.pending.length >= STEERING_LIMITS.messages ||
      this.pending.reduce((total, message) => total + Buffer.byteLength(message.content), 0) +
        Buffer.byteLength(content) > STEERING_LIMITS.bytes) throw new Error('Message queue is full; edit or remove a queued message first')
    const message = Object.freeze({ id: randomUUID(), content, ...(kind ? { kind } : {}) })
    this.pending.push(message)
    return message
  }
  takeLast(): string | undefined {
    const message = this.pending.at(-1)
    if (!message || this.claims.some(claim => claim.id === message.id)) return undefined
    this.pending.pop()
    return message.content
  }
  revokeShells(): void { this.pending = this.pending.filter(message => message.kind !== 'shell') }
  clear(): void { this.pending = this.pending.filter(message => this.claims.some(claim => claim.id === message.id)) }
  /** Leave the first input queued until the new run checkpoints it successfully. */
  first(): SteeringMessage | undefined { return this.pending[0] }
  claimInitial(id: string, content: string, index: number): void {
    const message = this.pending[0]
    if (message?.id !== id || message.content !== content) throw new Error('Queued input changed before the next run started')
    this.claims.push({ id, content, index })
  }
  claimShell(id: string, content: string): void {
    const message = this.pending[0]
    if (message?.id !== id || message.content !== content || message.kind !== 'shell' || this.claims.some(claim => claim.id === id)) {
      throw new Error('Shell input is no longer owned by this launch')
    }
    this.claims.push({ id, content, index: -1 })
  }
  /** Consume execution authority before any fallible continuation checkpoint. */
  shellResult(id: string, content: string): void {
    if (this.pending[0]?.id !== id || this.pending[0].kind !== 'shell' || !this.claims.some(claim => claim.id === id && claim.index === -1)) {
      throw new Error('Shell input changed before its outcome settled')
    }
    this.pending[0] = Object.freeze({ id, content })
    this.claims = this.claims.filter(claim => claim.id !== id)
  }
  reviseInitial(id: string, content: string, index: number): void {
    const claim = this.claims.find(item => item.id === id && item.index === index)
    if (!claim || this.pending[0]?.id !== id || this.pending[0].kind === 'shell') throw new Error('Shell observation lost its input owner')
    this.pending[0] = Object.freeze({ id, content })
    this.claims = this.claims.map(item => item === claim ? { id, content, index } : item)
  }
  acknowledgeInitial(id: string): void {
    if (this.pending[0]?.id === id) this.pending.shift()
  }
  stage(historyLength: number): readonly Message[] {
    const barrier = this.pending.findIndex(message => message.kind === 'shell')
    const messages = this.pending.slice(0, barrier < 0 ? undefined : barrier)
      .filter(message => !this.claims.some(claim => claim.id === message.id))
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
