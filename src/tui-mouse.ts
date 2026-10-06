// SPDX-License-Identifier: Apache-2.0
import type { MouseEvent, Renderable, SelectRenderable } from '@opentui/core'

/** One complete unmodified left click on the same live input and rendered target.
 * A release, drag/drop, resize or replacement input is never a new activation.
 */
export class MouseActivation {
  private press: { key: string; context: object; bounds: string } | undefined
  clear(): void { this.press = undefined }
  handle(event: MouseEvent, target: Renderable, key: string, context: object | undefined,
    enabled: boolean, activate: () => void): void {
    event.preventDefault()
    event.stopPropagation()
    if (event.type === 'over') return
    const plainLeft = event.button === 0 && !event.modifiers.shift && !event.modifiers.alt && !event.modifiers.ctrl
    const inside = event.x >= target.x && event.x < target.x + target.width &&
      event.y >= target.y && event.y < target.y + target.height
    const bounds = `${target.num}:${target.x}:${target.y}:${target.width}:${target.height}`
    if (event.type === 'down') {
      this.press = plainLeft && !event.isDragging && enabled && context && inside
        ? { key, context, bounds } : undefined
      return
    }
    const press = this.press
    this.clear()
    if (event.type === 'up' && plainLeft && !event.isDragging && enabled && inside &&
      context && press?.context === context && press.key === key && press.bounds === bounds) activate()
  }
}

/** Cell mapping for OpenTUI 0.5.14's default-font, zero-spacing Select.
 * Its public API exposes selection and size, but no mouse handling or visible offset.
 * The pinned component centers the selection in floor(height / rowHeight) rows.
 * Keep this adapter in sync with that version; reject blank and scrollbar cells.
 */
export function pickerIndexAt(picker: SelectRenderable, x: number, y: number): number | undefined {
  if (x < picker.x || x >= picker.x + picker.width - (picker.showScrollIndicator ? 1 : 0) ||
    y < picker.y || y >= picker.y + picker.height) return undefined
  const rowHeight = picker.showDescription ? 2 : 1
  const visible = Math.max(1, Math.floor(picker.height / rowHeight))
  const first = Math.max(0, Math.min(picker.getSelectedIndex() - Math.floor(visible / 2), picker.options.length - visible))
  const row = Math.floor((y - picker.y) / rowHeight)
  const index = first + row
  return row < Math.floor(picker.height / rowHeight) && index < picker.options.length ? index : undefined
}
