// SPDX-License-Identifier: Apache-2.0
import { BoxRenderable, RGBA, ScrollBoxRenderable, TextAttributes } from '@opentui/core'
import type { CliRenderer, MouseEvent, Renderable, SelectRenderable } from '@opentui/core'

/** Bound rapid terminal wheel reports without delaying the first step or a reversal. */
export class MenuWheel {
  private direction: 'up' | 'down' | undefined
  private acceptedAt = -Infinity
  constructor(private now = () => performance.now()) {}

  reset(): void { this.direction = undefined; this.acceptedAt = -Infinity }

  step(direction: 'up' | 'down' | 'left' | 'right' | undefined): number {
    if (direction !== 'up' && direction !== 'down') return 0
    const now = this.now()
    if (direction === this.direction && now - this.acceptedAt < 75) return 0
    this.direction = direction; this.acceptedAt = now
    return direction === 'up' ? -1 : 1
  }
}

/** Dialog wheel gestures move one line, without native scroll acceleration. */
export class ModalScrollBoxRenderable extends ScrollBoxRenderable {
  protected override onMouseEvent(event: MouseEvent): void {
    if (event.type !== 'scroll') { super.onMouseEvent(event); return }
    // A menu row or the section list may already have handled this gesture.
    if (!event.defaultPrevented) {
      if (event.scroll?.direction === 'up') this.scrollBy(-1)
      else if (event.scroll?.direction === 'down') this.scrollBy(1)
    }
    event.preventDefault(); event.stopPropagation()
  }
}

interface HoverRegion { x: number; y: number; width: number; height: number }
type HoverPoint = { x: number; y: number }

/** Paint feedback without changing selection, focus, text, or click identity. */
export class MouseHover {
  private active: { target: Renderable; point: HoverPoint } | undefined
  constructor(private renderer: CliRenderer, private background: RGBA, private foreground: RGBA) {}

  clear(): void {
    if (!this.active) return
    this.active = undefined
    this.renderer.requestRender()
  }

  bind(target: Renderable, enabled: () => boolean,
    region: (point: HoverPoint) => HoverRegion | undefined = () => ({ x: 0, y: 0, width: target.width, height: target.height })): void {
    const enter = (event: MouseEvent) => {
      if (event.isDragging) { this.clear(); return }
      this.active = { target, point: { x: event.x - target.x, y: event.y - target.y } }
      target.requestRender()
    }
    // Use physical movement: OpenTUI also synthesizes `over` after layout
    // changes, which must not revive feedback cleared by blur or keyboard input.
    target.onMouseMove = enter
    target.onMouseOut = () => { if (this.active?.target === target) this.clear() }
    target.onMouseScroll = () => this.clear()
    target.onMouseDrag = () => this.clear()
    target.once('destroyed', () => { if (this.active?.target === target) this.clear() })
    // Text and Select override render() in the pinned OpenTUI version and skip
    // renderAfter. Wrap the public render method after its native buffer copy.
    const render = target.render
    target.render = (buffer, deltaTime) => {
      render.call(target, buffer, deltaTime)
      if (this.active?.target !== target || !enabled()) return
      const area = region(this.active.point)
      if (!area) return
      // Clip against scroll viewports and bordered ancestors before touching the
      // public color views. Preserve native glyphs (including wide text), links,
      // and all attributes except dim, which would obscure the hover highlight.
      let left = target.x + area.x, top = target.y + area.y
      let right = left + area.width, bottom = top + area.height
      for (let node: Renderable | null = target; node; node = node.parent) {
        if (!node.visible || node.opacity < 1) return
        if (node !== target && node.overflow === 'visible') continue
        const border = node instanceof BoxRenderable ? node.border : false
        const inset = (side: 'left' | 'right' | 'top' | 'bottom') => Number(border === true || Array.isArray(border) && border.includes(side))
        left = Math.max(left, node.x + inset('left')); right = Math.min(right, node.x + node.width - inset('right'))
        top = Math.max(top, node.y + inset('top')); bottom = Math.min(bottom, node.y + node.height - inset('bottom'))
      }
      const originX = target.x - target.screenX
      const originY = target.y - target.screenY
      left = Math.max(0, left - originX); right = Math.min(buffer.width, right - originX)
      top = Math.max(0, top - originY); bottom = Math.min(buffer.height, bottom - originY)
      const { fg, bg, attributes } = buffer.buffers
      for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
        const cell = y * buffer.width + x
        fg.set(this.foreground.buffer, cell * 4)
        bg.set(this.background.buffer, cell * 4)
        attributes[cell] = (attributes[cell]! & ~TextAttributes.DIM) | TextAttributes.BOLD
      }
    }
  }
}

/** Highlight the pointed row without moving the keyboard selection. */
export function pickerHoverRegion(picker: SelectRenderable, point: HoverPoint): HoverRegion | undefined {
  const index = pickerIndexAt(picker, picker.x + point.x, picker.y + point.y)
  if (index === undefined || picker.options[index]?.value === -1) return undefined
  const height = picker.showDescription ? 2 : 1
  return { x: 0, y: Math.floor(point.y / height) * height,
    width: picker.width - Number(picker.showScrollIndicator), height }
}

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
