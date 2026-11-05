// SPDX-License-Identifier: Apache-2.0
import { RGBA, StyledText, TextAttributes, TextRenderable } from '@opentui/core'
import type { OptimizedBuffer, Renderable, RenderContext, TextOptions } from '@opentui/core'

// Localized opaque rows have explicit contrasting text on any terminal palette.
export const WORKSPACE_DIFF_COLORS = { addedBackground: '#173f2a', addedForeground: '#d5f7dc',
  removedBackground: '#51252b', removedForeground: '#ffdce0' } as const
type RowKind = 'added' | 'removed' | 'context' | 'header' | undefined

/** Escape terminal controls without quoting ordinary source text. */
function visibleText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufeff]/g, char =>
    char === '\t' ? '\\t' : char === '\r' ? '\\r' : char === '\n' ? '\\n'
      : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** Present only a matching host-generated diff; retain the exact review data upstream. */
export function workspaceDiffPresentation(description: string, diff: string): { path: string; content: string } | undefined {
  if (!description.endsWith(`\n${diff}`)) return undefined
  const rows = diff.split('\n')
  if (!/^--- (?:\(new file\)|".*")$/.test(rows[0] ?? '') || !/^\+\+\+ ".*"$/.test(rows[1] ?? '') ||
    !/^@@ -\d+,\d+ \+\d+,\d+ @@ \(JSON-quoted lines\)$/.test(rows[2] ?? '') ||
    rows.slice(3).some(row => !/^[ +\-]".*"$/.test(row))) return undefined
  try {
    const path: unknown = JSON.parse(rows[1]!.slice(4))
    if (typeof path !== 'string' || (rows[0] !== '--- (new file)' && JSON.parse(rows[0]!.slice(4)) !== path)) return undefined
    const content = [rows[2]!.replace(' (JSON-quoted lines)', '')]
    for (const row of rows.slice(3)) {
      const line: unknown = JSON.parse(row.slice(1))
      if (typeof line !== 'string' || line.replace(/\n$/, '').includes('\n')) return undefined
      content.push(row[0] + visibleText(line.replace(/\n$/, '')))
      if (!line.endsWith('\n')) content.push('\\ No newline at end of file')
    }
    return { path: visibleText(path), content: content.join('\n') }
  } catch { return undefined }
}

/** Style only the prepared display diff, never a lookalike in arbitrary text. */
function rowKinds(content: string, diff: string): RowKind[] {
  if (content !== diff) return []
  const rows = diff.split('\n')
  if (!/^@@ -\d+,\d+ \+\d+,\d+ @@$/.test(rows[0] ?? '') ||
    rows.slice(1).some(row => !/^[ +\-]/.test(row) && row !== '\\ No newline at end of file')) return []
  return rows.map((row, index): RowKind => index === 0 ? 'header'
    : row[0] === '+' ? 'added' : row[0] === '-' ? 'removed' : 'context')
}
function rowColors(kind: RowKind): { fg: RGBA; bg: RGBA } | undefined {
  return kind === 'added' ? { fg: RGBA.fromHex(WORKSPACE_DIFF_COLORS.addedForeground), bg: RGBA.fromHex(WORKSPACE_DIFF_COLORS.addedBackground) }
    : kind === 'removed' ? { fg: RGBA.fromHex(WORKSPACE_DIFF_COLORS.removedForeground), bg: RGBA.fromHex(WORKSPACE_DIFF_COLORS.removedBackground) } : undefined
}

/** One native text buffer keeps exact selection/copy and wrapping across all review lines. */
export class WorkspaceDiffRenderable extends TextRenderable {
  private readonly kinds: RowKind[]
  constructor(context: RenderContext, options: TextOptions & { content: string }, diff: string, private readonly viewport?: Renderable) {
    const kinds = rowKinds(options.content, diff)
    const rows = options.content.split('\n')
    const content = new StyledText(rows.map((row, index) => ({ __isChunk: true as const,
      text: row + (index < rows.length - 1 ? '\n' : ''), ...rowColors(kinds[index]),
      attributes: kinds[index] === 'header' ? TextAttributes.BOLD : kinds[index] === 'context' ? TextAttributes.DIM : options.attributes ?? 0 })))
    super(context, { ...options, content })
    this.kinds = kinds
  }
  protected override renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer)
    // Native visual-line sources follow word wrapping and Unicode column widths.
    // Recolor only visible cells, retaining native glyphs, attributes and selections.
    // Raw color views do not apply the native scissor stack. Bound them to the
    // current public transcript viewport so scrolling cannot tint fixed chrome.
    const top = Math.max(0, this.y, this.viewport?.y ?? 0)
    const bottom = Math.min(buffer.height, this.y + this.height, this.viewport ? this.viewport.y + this.viewport.height : buffer.height)
    const left = Math.max(0, this.x, this.viewport?.x ?? 0)
    const right = Math.min(buffer.width, this.x + this.width, this.viewport ? this.viewport.x + this.viewport.width : buffer.width)
    const first = top - this.y, count = Math.max(0, bottom - top)
    const sources = this.getLineSources(this.scrollY + first, count)
    const { fg, bg } = buffer.buffers
    const selected = this.hasSelection() ? this.selectionBg : undefined
    for (const [offset, source] of sources.entries()) {
      const colors = rowColors(this.kinds[source])
      if (!colors) continue
      const y = this.y + first + offset
      for (let x = left; x < right; x++) {
        const cell = (y * buffer.width + x) * 4
        if (selected?.equals(RGBA.fromArray(bg.subarray(cell, cell + 4)))) continue
        fg.set(colors.fg.buffer, cell); bg.set(colors.bg.buffer, cell)
      }
    }
  }
}
