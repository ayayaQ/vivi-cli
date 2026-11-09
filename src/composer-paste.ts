// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto'
import type { TextareaRenderable } from '@opentui/core'
import { imageMetadata, IMAGE_LIMITS } from './image-assets.js'
import type { PastedImage } from './image-assets.js'

interface PasteData { content: string; label: string; image?: PastedImage }
export interface ComposerDraft {
  text: string
  cursor: number
  marks: { start: number; end: number; data: PasteData }[]
}
export const COLLAPSE_PASTE_CHARACTERS = 1000
export const COLLAPSE_PASTE_LINES = 10

/** Native virtual extmarks keep tokens atomic through movement, selection and undo. */
export class ComposerPastes {
  private readonly type: number
  private readonly images = new Map<string, PastedImage>()
  private imageNumber = 0
  constructor(private readonly editor: TextareaRenderable) {
    this.type = editor.extmarks.registerType('vivi-paste')
    // OpenTUI 0.5.14 keeps its extmark undo snapshots when setText resets the
    // native text history. Never restore marks without a matching text edit:
    // otherwise undo on a cleared/new prompt can resurrect invisible content.
    const buffer = editor.editBuffer
    const undo = buffer.undo.bind(buffer), redo = buffer.redo.bind(buffer)
    buffer.undo = () => buffer.canUndo() ? undo() : null
    buffer.redo = () => buffer.canRedo() ? redo() : null
  }
  // OpenTUI restores getAll() on undo; its secondary type index is not restored.
  private marks() {
    return this.editor.extmarks.getAll().filter(mark => {
      const data = mark.data as PasteData | undefined
      return mark.typeId === this.type && typeof data?.label === 'string' && mark.start >= 0 && mark.end > mark.start &&
        this.editor.editBuffer.getTextRange(mark.start, mark.end) === data.label
    }).sort((a, b) => a.start - b.start)
  }
  snapshot(): ComposerDraft {
    return { text: this.editor.plainText, cursor: this.editor.cursorOffset,
      marks: this.marks().map(mark => ({ start: mark.start, end: mark.end, data: mark.data as PasteData })) }
  }
  restore(draft: ComposerDraft): void {
    this.editor.setText(draft.text)
    for (const mark of draft.marks) {
      if (mark.data.image) this.images.set(mark.data.image.path, mark.data.image)
      this.editor.extmarks.create({ ...mark, virtual: true, typeId: this.type })
    }
    this.editor.cursorOffset = draft.cursor
  }
  resetImages(): void { this.images.clear(); this.imageNumber = 0 }
  get text(): string {
    if (!this.marks().length) return this.editor.plainText
    let text = '', offset = 0
    for (const mark of this.marks()) {
      text += this.editor.editBuffer.getTextRange(offset, mark.start) + (mark.data as PasteData).content
      offset = mark.end
    }
    return text + this.editor.plainText.slice(this.editor.editBuffer.getTextRange(0, offset).length)
  }
  private expandable(text: string) {
    return !this.editor.hasSelection() ? this.marks().find(mark => mark.end === this.editor.cursorOffset &&
      !(mark.data as PasteData).image && (mark.data as PasteData).content === text) : undefined
  }
  fits(text: string, limit: number): boolean {
    if (this.expandable(text)) return true
    const selection = this.editor.getSelection()
    let selected = this.editor.getSelectedText().length
    if (selection) for (const mark of this.marks()) {
      if (mark.start >= selection.start && mark.end <= selection.end) selected += (mark.data as PasteData).content.length -
        this.editor.editBuffer.getTextRange(mark.start, mark.end).length
    }
    return this.text.length - selected + text.length <= limit
  }
  private insert(label: string, data: Omit<PasteData, 'label'>): void {
    this.editor.insertText(label)
    const end = this.editor.cursorOffset
    this.editor.extmarks.create({ start: end - label.length, end, virtual: true, typeId: this.type, data: { ...data, label } })
  }
  paste(text: string): void {
    const adjacent = this.expandable(text)
    if (adjacent) {
      const marks = this.marks().map(mark => ({ ...mark }))
      const before = this.editor.editBuffer.getTextRange(0, adjacent.start)
      const after = this.editor.plainText.slice(before.length + adjacent.end - adjacent.start)
      this.editor.gotoBufferEnd()
      const oldEnd = this.editor.cursorOffset
      this.editor.replaceText(before + text + after)
      this.editor.gotoBufferEnd()
      const delta = this.editor.cursorOffset - oldEnd
      for (const mark of marks) if (mark.id !== adjacent.id) {
        this.editor.extmarks.create({ ...mark, start: mark.start + (mark.start >= adjacent.end ? delta : 0),
          end: mark.end + (mark.end >= adjacent.end ? delta : 0) })
      }
      this.editor.cursorOffset = adjacent.end + delta
    } else if (text.length >= COLLAPSE_PASTE_CHARACTERS || text.split('\n').length >= COLLAPSE_PASTE_LINES) {
      this.insert(`[Pasted Content ${text.length} chars]`, { content: text })
    } else this.editor.insertText(text)
  }
  pasteImage(bytes: Uint8Array): void {
    const metadata = imageMetadata(bytes)
    if (this.images.size >= IMAGE_LIMITS.sessionImages || [...this.images.values()].reduce((sum, image) => sum + image.bytes.length, bytes.length) > IMAGE_LIMITS.sessionBytes) {
      throw new Error('Pasted image limit reached; start a new conversation')
    }
    const path = `vivi-paste/${randomUUID()}.${metadata.mimeType === 'image/png' ? 'png' : 'jpg'}`
    const image = { path, bytes: Uint8Array.from(bytes) }, number = ++this.imageNumber
    const content = `[Image #${number}: ${path}] (Use workspace_read_image with this path to inspect the attached image.)`
    if (!this.fits(content, 65536)) throw new Error('Image attachment exceeds the composer input limit')
    this.images.set(path, image)
    this.insert(`[Image #${number}]`, { image, content })
  }
  imagesFor(text = this.text): PastedImage[] {
    return [...this.images.values()].filter(image => text.includes(image.path))
  }
}
