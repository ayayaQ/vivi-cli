// SPDX-License-Identifier: Apache-2.0
import { BoxRenderable, TextareaRenderable, TextRenderable, decodePasteBytes } from '@opentui/core'
import type { CliRenderer, KeyEvent, MouseEvent, PasteEvent } from '@opentui/core'
import type { QuestionAnswer, QuestionRequest, QuestionResponse } from '@ayayaq/vivi/extensions/questions'
import { MouseActivation } from './tui-mouse.js'

const MAX_ANSWER = 4000
type Focus = 'choices' | 'text' | 'actions'
interface Draft { answer?: QuestionAnswer; text: string }
interface DialogOptions {
  safe(text: string, limit?: number): string
  /** Human answers are screened by the host; this only removes display controls. */
  clean(text: string): string
  ready(): boolean
  mouseReady(): boolean
  status(text: string): void
  finish(response: QuestionResponse, mouse?: boolean): void
  foreground: string | import('@opentui/core').RGBA
  accent: string
  background: string
}

/** A per-request native editor. Choices are drafts until the human presses Submit. */
export class QuestionDialog {
  readonly box: BoxRenderable
  private readonly heading!: TextRenderable
  private readonly choices!: BoxRenderable
  private readonly editorBox!: BoxRenderable
  private readonly editor!: TextareaRenderable
  private readonly actions!: BoxRenderable
  private readonly progress!: TextRenderable
  private readonly mouse = new MouseActivation()
  private readonly drafts: Draft[]
  private page = 0
  private selected = 0
  private action = 0
  private focus: Focus = 'choices'
  private changing = false
  private disposed = false
  private context: object = {}
  private frame = 0

  constructor(private readonly renderer: CliRenderer, readonly request: QuestionRequest,
    private readonly options: DialogOptions) {
    this.drafts = request.questions.map(() => ({ text: '' }))
    this.box = new BoxRenderable(renderer, { id: 'vivi-questions', width: '100%', height: 12,
      flexShrink: 0, flexDirection: 'column', border: true, borderColor: options.accent,
      titleColor: options.accent, title: 'Questions · answers only', bottomTitle: 'Tab · Enter · ^Enter Submit · Esc', paddingX: 1 })
    try {
      this.progress = new TextRenderable(renderer, { id: 'vivi-question-progress', height: 1,
        flexShrink: 0, fg: options.accent, wrapMode: 'none' })
      this.heading = new TextRenderable(renderer, { id: 'vivi-question-heading', width: '100%',
        height: 2, flexShrink: 0, fg: options.foreground, wrapMode: 'word' })
      this.choices = new BoxRenderable(renderer, { id: 'vivi-question-choices', width: '100%',
        height: 4, flexShrink: 0, flexDirection: 'column' })
      this.editorBox = new BoxRenderable(renderer, { id: 'vivi-question-editor-box', width: '100%',
        height: 2, flexShrink: 0 })
      this.editor = new TextareaRenderable(renderer, { id: 'vivi-question-editor', width: '100%',
        height: '100%', wrapMode: 'word', backgroundColor: options.background,
        focusedBackgroundColor: options.background, textColor: options.foreground,
        focusedTextColor: options.foreground, cursorColor: options.accent,
        placeholder: 'Your answer · Enter reviews; Ctrl+J adds a newline',
        keyBindings: ['return', 'kpenter'].flatMap(name => [{ name, action: 'submit' as const },
          { name, shift: true, action: 'newline' as const }, { name, meta: true, action: 'newline' as const }]),
        onSubmit: () => this.reviewText(), onContentChange: () => this.changed() })
      this.editor.onMouse = event => {
        if (event.type === 'down' && event.button === 0 && this.live()) { this.focus = 'text'; this.editor.focus() }
      }
      this.editorBox.add(this.editor)
      this.actions = new BoxRenderable(renderer, { id: 'vivi-question-actions', height: 1,
        flexShrink: 0, flexDirection: 'row', gap: 1 })
      for (const child of [this.progress, this.heading, this.choices, this.editorBox, this.actions]) this.box.add(child)
      this.render()
    } catch (error) {
      // Construction may fail before a child is attached to the dialog root.
      for (const node of [this.editor, this.editorBox, this.heading, this.choices, this.actions, this.progress, this.box]) {
        if (node && !node.parent && !node.isDestroyed) { try { node.destroyRecursively() } catch { /* Finish detached-widget cleanup. */ } }
      }
      throw error
    }
  }

  private live(): boolean { return !this.disposed && this.options.ready() && this.renderer.frameId > this.frame }
  private current(): Draft { return this.drafts[this.page]! }
  private consume(event: KeyEvent | PasteEvent): void { event.preventDefault(); event.stopPropagation() }
  private button(id: string, label: string, action: () => void): TextRenderable {
    const safe = this.options.safe(label, 1200).replace(/[\t\n]+/g, ' ')
    const node = new TextRenderable(this.renderer, { id, content: safe, width: '100%', height: 1,
      flexShrink: 0, fg: this.options.accent, wrapMode: 'none', selectable: false })
    node.onMouse = (event: MouseEvent): void => this.mouse.handle(event, node, id, this.context, this.live() && this.options.mouseReady(), action)
    return node
  }
  private setFocus(focus: Focus): void {
    this.focus = focus
    if (focus === 'choices' && this.request.questions[this.page]!.options) this.editorBox.visible = false
    if (focus === 'text') this.editorBox.visible = true
    if (focus === 'text' && this.editorBox.visible) this.editor.focus()
    else this.editor.blur()
    this.renderChoices(); this.renderActions(); this.resize()
  }
  private changed(): void {
    if (this.changing || this.disposed) return
    const raw = this.editor.plainText
    if (raw.length > MAX_ANSWER) {
      this.changing = true
      try { this.editor.setText(this.current().text); this.editor.gotoBufferEnd() } finally { this.changing = false }
      this.options.status(`Edit ignored: answer limit is ${MAX_ANSWER} characters`)
      return
    }
    const text = this.options.clean(raw)
    if (text !== raw) {
      this.changing = true
      try { this.editor.setText(text); this.editor.gotoBufferEnd() } finally { this.changing = false }
      this.options.status('Terminal control text removed from the answer editor')
    }
    this.current().text = text
    if (text.trim()) this.current().answer = { kind: 'text', text }
    else delete this.current().answer
    this.renderProgress()
  }
  private renderProgress(): void {
    const question = this.request.questions[this.page]!
    const answered = this.drafts.filter(draft => draft.answer).length
    const answer = this.current().answer
    this.progress.content = this.options.safe(`${this.page + 1}/${this.drafts.length} · ${question.header} · ${answered}/${this.drafts.length} ready${answer ? answer.kind === 'skipped' ? ' · Skipped' : ' · Answer saved' : ''}`, 200)
  }
  private renderChoices(): void {
    this.mouse.clear()
    for (const child of this.choices.getChildren()) child.destroyRecursively()
    const question = this.request.questions[this.page]!
    this.choices.visible = Boolean(question.options) && !this.editorBox.visible
    if (!question.options) return
    const answer = this.current().answer
    question.options.forEach((option, index) => {
      const marker = answer?.kind === 'option' && answer.optionId === option.id ? '●' : '○'
      this.choices.add(this.button(`vivi-question-option-${index}`, `${this.focus === 'choices' && this.selected === index ? '›' : ' '} ${marker} ${option.label}${option.description ? ` · ${option.description}` : ''}`, () => this.choose(index)))
    })
    this.choices.add(this.button('vivi-question-other', `${this.focus === 'choices' && this.selected === question.options.length ? '›' : ' '} ${answer?.kind === 'text' ? '●' : '○'} Other / write an answer`, () => this.choose(question.options!.length)))
  }
  private actionNames(): string[] { return ['Prev', 'Next', 'Skip', 'Submit', 'Cancel'] }
  private renderActions(): void {
    this.mouse.clear()
    for (const child of this.actions.getChildren()) child.destroyRecursively()
    const width = Math.max(1, this.renderer.terminalWidth - 4)
    this.actions.visible = width >= 27
    const compact = width < 45
    const names = compact ? ['‹', '›', 'Skip', 'Submit', 'Cancel'] : this.actionNames()
    names.forEach((name, index) => {
      const label = `${this.focus === 'actions' && this.action === index ? '›' : ' '}${name}`
      const button = this.button(`vivi-question-${this.actionNames()[index]!.toLowerCase()}`, label, () => this.activate(index, true))
      button.width = label.length
      this.actions.add(button)
    })
  }
  private choose(index: number): void {
    if (!this.live()) return
    const question = this.request.questions[this.page]!
    const option = question.options?.[index]
    this.selected = index
    if (option) {
      this.current().answer = { kind: 'option', optionId: option.id }
      this.focus = 'actions'; this.action = this.page < this.drafts.length - 1 ? 1 : 3
      this.editor.blur()
      this.editorBox.visible = false
    } else {
      if (this.current().text.trim()) this.current().answer = { kind: 'text', text: this.current().text }
      else delete this.current().answer
      this.editorBox.visible = true
      this.setFocus('text')
    }
    this.renderProgress(); this.renderChoices(); this.renderActions(); this.resize()
  }
  private reviewText(): void {
    if (!this.live() || this.focus !== 'text') return
    this.changed(); this.action = this.page < this.drafts.length - 1 ? 1 : 3; this.setFocus('actions')
  }
  private activate(index: number, mouse = false): void {
    if (!this.live()) return
    if (index === 0 || index === 1) {
      const page = this.page + (index === 0 ? -1 : 1)
      if (page < 0 || page >= this.drafts.length) return
      this.page = page; this.render(); return
    }
    if (index === 2) {
      this.current().answer = { kind: 'skipped' }; this.editor.blur(); this.focus = 'actions'
      this.action = this.page < this.drafts.length - 1 ? 1 : 3
      this.renderProgress(); this.renderChoices(); this.renderActions(); return
    }
    if (index === 4) { this.options.finish({ requestId: this.request.requestId, status: 'cancelled' }, mouse); return }
    if (this.drafts.some(draft => !draft.answer)) { this.options.status('Answer or explicitly Skip every question before Submit'); return }
    this.options.finish({ requestId: this.request.requestId, status: 'answered',
      answers: this.request.questions.map((question, page) => ({ id: question.id, answer: this.drafts[page]!.answer! })) }, mouse)
  }
  private render(): void {
    this.context = {}; this.mouse.clear(); this.frame = this.renderer.frameId
    const question = this.request.questions[this.page]!, draft = this.current()
    this.heading.content = this.options.safe(question.question, 1200)
    this.focus = !question.options || draft.answer?.kind === 'text' ? 'text' : 'choices'
    this.selected = draft.answer?.kind === 'option' ? question.options!.findIndex(option => option.id === (draft.answer as { kind: 'option'; optionId: string }).optionId) : 0
    this.changing = true
    try { this.editor.setText(draft.text); this.editor.gotoBufferEnd() } finally { this.changing = false }
    this.editorBox.visible = this.focus === 'text'
    this.renderProgress(); this.renderChoices(); this.renderActions(); this.resize(); this.setFocus(this.focus)
  }
  resize(): void {
    if (this.disposed) return
    this.mouse.clear()
    const height = Math.max(5, Math.min(14, this.renderer.terminalHeight - (this.renderer.terminalHeight <= 14 ? 3 : 6)))
    const fixed = 4 + (this.choices.visible ? this.request.questions[this.page]!.options!.length + 1 : 0)
    this.heading.height = Math.max(1, Math.min(3, height - fixed - (this.editorBox.visible ? 1 : 0)))
    this.choices.height = this.choices.visible ? this.request.questions[this.page]!.options!.length + 1 : 0
    this.editorBox.height = Math.max(1, Math.min(4, height - fixed - Number(this.heading.height)))
    this.box.height = 3 + Number(this.heading.height) + Number(this.choices.height) + (this.editorBox.visible ? Number(this.editorBox.height) : 0)
    this.renderActions()
  }
  handlePaste(event: PasteEvent): void {
    this.consume(event); this.mouse.clear()
    if (!this.live() || this.focus !== 'text') return
    const text = this.options.clean(decodePasteBytes(event.bytes))
    if (this.editor.plainText.length + text.length > MAX_ANSWER) { this.options.status(`Paste ignored: answer limit is ${MAX_ANSWER} characters`); return }
    this.editor.insertText(text); this.changed()
  }
  handleKey(key: KeyEvent): void {
    this.mouse.clear()
    if (key.name === 'escape') { this.consume(key); this.options.finish({ requestId: this.request.requestId, status: 'cancelled' }); return }
    if (!this.live()) { this.consume(key); return }
    if (key.ctrl && ['return', 'kpenter'].includes(key.name) && !key.repeated && key.eventType !== 'repeat') { this.consume(key); this.activate(3); return }
    if (key.name === 'tab' && !key.ctrl && !key.meta && !key.super && !key.hyper) {
      this.consume(key)
      const focuses: Focus[] = [...(this.request.questions[this.page]!.options ? ['choices' as const] : []), ...(this.current().answer?.kind === 'text' || !this.request.questions[this.page]!.options || this.editorBox.visible ? ['text' as const] : []), 'actions']
      this.setFocus(focuses[(focuses.indexOf(this.focus) + (key.shift ? -1 : 1) + focuses.length) % focuses.length]!); return
    }
    if (this.focus === 'text') {
      if ((!key.ctrl && key.name === 'linefeed') || key.ctrl && key.name === 'j') { this.consume(key); this.editor.insertText('\n'); this.changed(); return }
      if (key.ctrl && !['a', 'b', 'e', 'f', 'h', 'k', 'u', 'w', 'z'].includes(key.name) || key.super || key.hyper) this.consume(key)
      return
    }
    this.consume(key)
    if (key.ctrl || key.meta || key.super || key.hyper || key.repeated || key.eventType === 'repeat') return
    if (['left', 'up', 'right', 'down', 'home', 'end'].includes(key.name)) {
      const count = this.focus === 'choices' ? this.request.questions[this.page]!.options!.length + 1 : 5
      const current = this.focus === 'choices' ? this.selected : this.action
      const next = key.name === 'home' ? 0 : key.name === 'end' ? count - 1 : (current + (['left', 'up'].includes(key.name) ? -1 : 1) + count) % count
      if (this.focus === 'choices') this.selected = next
      else this.action = next
      this.renderChoices(); this.renderActions(); return
    }
    if (['return', 'kpenter', 'linefeed', 'space'].includes(key.name) && !key.shift) {
      if (this.focus === 'choices') this.choose(this.selected)
      else this.activate(this.action)
    }
  }
  /** Terminal focus transitions interrupt any incomplete mouse gesture. */
  resetGesture(): void { this.mouse.clear() }
  redact(): void { if (!this.disposed) { this.renderProgress(); this.heading.content = this.options.safe(this.request.questions[this.page]!.question, 1200); this.renderChoices() } }
  close(): void {
    if (this.disposed) return
    this.disposed = true; this.mouse.clear(); this.editor.blur(); this.box.destroyRecursively()
    for (const draft of this.drafts) { draft.text = ''; delete draft.answer }
  }
}
