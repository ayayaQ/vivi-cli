// SPDX-License-Identifier: Apache-2.0
import { RGBA, StyledText, TextAttributes, TextRenderable } from '@opentui/core'
import type { OptimizedBuffer, RenderContext, TextOptions } from '@opentui/core'

// Localized opaque rows have explicit contrasting text on any terminal palette.
export const WORKSPACE_DIFF_COLORS = { addedBackground: '#173f2a', addedForeground: '#d5f7dc',
  removedBackground: '#51252b', removedForeground: '#ffdce0' } as const
type RowKind = 'added' | 'removed' | 'context' | 'header' | undefined

/** Style only the host's generated JSON-quoted diff, never a lookalike in arbitrary text. */
function rowKinds(content: string, diff: string): RowKind[] {
  if (!content.endsWith(`\n${diff}`)) return []
  const rows = diff.split('\n')
  if (!/^--- (?:\(new file\)|".*")$/.test(rows[0] ?? '') || !/^\+\+\+ ".*"$/.test(rows[1] ?? '') ||
    !/^@@ -\d+,\d+ \+\d+,\d+ @@ \(JSON-quoted lines\)$/.test(rows[2] ?? '') ||
    rows.slice(3).some(row => !/^[ +\-]".*"$/.test(row))) return []
  const prefix = content.slice(0, -diff.length).split('\n').length - 1
  return [...Array<RowKind>(prefix).fill(undefined), ...rows.map((row, index): RowKind => index < 3 ? 'header'
    : row[0] === '+' ? 'added' : row[0] === '-' ? 'removed' : 'context')]
}
function rowColors(kind: RowKind): { fg: RGBA; bg: RGBA } | undefined {
  return kind === 'added' ? { fg: RGBA.fromHex(WORKSPACE_DIFF_COLORS.addedForeground), bg: RGBA.fromHex(WORKSPACE_DIFF_COLORS.addedBackground) }
    : kind === 'removed' ? { fg: RGBA.fromHex(WORKSPACE_DIFF_COLORS.removedForeground), bg: RGBA.fromHex(WORKSPACE_DIFF_COLORS.removedBackground) } : undefined
}

/** One native text buffer keeps exact selection/copy and wrapping across all review lines. */
export class WorkspaceDiffRenderable extends TextRenderable {
  private readonly kinds: RowKind[]
  constructor(context: RenderContext, options: TextOptions & { content: string }, diff: string) {
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
    const first = Math.max(0, -this.y), count = Math.max(0, Math.min(this.height, buffer.height - this.y) - first)
    const sources = this.getLineSources(this.scrollY + first, count)
    const { fg, bg } = buffer.buffers
    const selected = this.hasSelection() ? this.selectionBg : undefined
    for (const [offset, source] of sources.entries()) {
      const colors = rowColors(this.kinds[source])
      if (!colors) continue
      const y = this.y + first + offset
      for (let x = Math.max(0, this.x); x < Math.min(buffer.width, this.x + this.width); x++) {
        const cell = (y * buffer.width + x) * 4
        if (selected?.equals(RGBA.fromArray(bg.subarray(cell, cell + 4)))) continue
        fg.set(colors.fg.buffer, cell); bg.set(colors.bg.buffer, cell)
      }
    }
  }
}
