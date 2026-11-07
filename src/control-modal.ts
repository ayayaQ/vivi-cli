// SPDX-License-Identifier: Apache-2.0
import { BoxRenderable, ScrollBoxRenderable, SelectRenderable, SelectRenderableEvents, StyledText,
  TextareaRenderable, TextAttributes, TextRenderable, TextBuffer, TextBufferView, RGBA, decodePasteBytes } from '@opentui/core'
import type { CliRenderer, KeyEvent, MouseEvent, PasteEvent } from '@opentui/core'
import { matchingChoiceIndices } from './picker.js'
import type { Choice, ControlDetails, SearchableOptions, SearchableSelection } from './picker.js'
import { MenuWheel, ModalScrollBoxRenderable, MouseActivation, pickerIndexAt, pickerHoverRegion } from './tui-mouse.js'
import type { MouseHover } from './tui-mouse.js'

interface ModalOptions {
  safe(text: string, limit?: number): string
  ready(): boolean
  completedFrame(): number
  hover: MouseHover
  foreground: RGBA
  accent: string
  selection: string
  selectedForeground: string
  rowBackground: string
}
type Picker = { choices: readonly Choice<unknown>[]; matches: number[]; query: string; refresh: boolean; sectioned: boolean }

/** A local control surface. Its data never enters the conversation transcript. */
export class ControlModal {
  readonly overlay: BoxRenderable
  private panel: BoxRenderable
  private heading: TextRenderable
  private closeButton: TextRenderable
  private noticeLine: TextRenderable
  private noticeBuffer: TextBuffer
  private noticeView: TextBufferView
  private query: TextareaRenderable
  private picker: SelectRenderable
  private sectionList: ScrollBoxRenderable
  private sectionRows = new Map<number, { row: BoxRenderable; label: TextRenderable }>()
  private sectionSelection = 0
  private scrollSelection = false
  private description: TextRenderable
  private body: ScrollBoxRenderable
  private footer: TextRenderable
  private footerBar: BoxRenderable
  private confirmButton: TextRenderable
  private refreshButton: TextRenderable
  private state: Picker | undefined
  private mode: 'picker' | 'text' | 'details' = 'picker'
  private details: ControlDetails | undefined
  private finish: ((value: unknown) => void) | undefined
  private mouse = new MouseActivation()
  private wheel = new MenuWheel()
  private token: object = {}
  private changedFrame = 0
  private changing = false
  private disposed = false
  private menuState = { query: '', index: 0 }
  private title = ''
  private notices = ''
  private shownNotices = ''
  private lastQuery = ''
  private lastIndex = 0
  private textRowCount = 2

  constructor(private renderer: CliRenderer, private options: ModalOptions) {
    this.noticeBuffer = TextBuffer.create(renderer.widthMethod)
    this.noticeView = TextBufferView.create(this.noticeBuffer)
    this.noticeView.setWrapMode('word')
    this.overlay = new BoxRenderable(renderer, { id: 'vivi-control-overlay', position: 'absolute', left: 0, top: 0,
      width: '100%', height: '100%', zIndex: 100, justifyContent: 'center', alignItems: 'center',
      onMouse: event => this.backdrop(event) })
    this.panel = new BoxRenderable(renderer, { id: 'vivi-control-panel', width: 76, height: 22,
      flexDirection: 'column', flexShrink: 0, border: true, borderStyle: 'rounded', borderColor: options.accent,
      paddingX: 1, paddingY: 0, backgroundColor: RGBA.defaultBackground() })
    this.overlay.add(this.panel)
    const header = new BoxRenderable(renderer, { height: 1, width: '100%', flexShrink: 0, flexDirection: 'row', marginBottom: 1 })
    this.heading = new TextRenderable(renderer, { id: 'vivi-control-title', flexGrow: 1, minWidth: 0,
      height: 1, fg: options.foreground, attributes: TextAttributes.BOLD, wrapMode: 'none' })
    this.closeButton = new TextRenderable(renderer, { id: 'vivi-control-back', content: ' Esc / Back ',
      width: 12, height: 1, fg: options.foreground, attributes: TextAttributes.DIM, selectable: false,
      onMouse: event => this.mouse.handle(event, this.closeButton, 'back', this.token, options.ready(), () => this.cancel()) })
    header.add(this.heading); header.add(this.closeButton)
    this.noticeLine = new TextRenderable(renderer, { id: 'vivi-control-notice', width: '100%', height: 2,
      flexShrink: 0, visible: false, fg: options.foreground, attributes: TextAttributes.DIM, wrapMode: 'word' })
    this.query = new TextareaRenderable(renderer, { id: 'vivi-control-query', width: '100%', height: 1,
      flexShrink: 0, marginBottom: 1, textColor: options.foreground, focusedTextColor: options.foreground,
      backgroundColor: 'transparent', focusedBackgroundColor: 'transparent', cursorColor: options.accent,
      placeholder: new StyledText([{ __isChunk: true, text: 'Search commands…', fg: options.foreground, attributes: TextAttributes.DIM }]),
      keyBindings: ['return', 'kpenter'].flatMap(name => [{ name, action: 'submit' as const },
        { name, shift: true, action: 'newline' as const }, { name, meta: true, action: 'newline' as const }]),
      onSubmit: () => this.submit(), onContentChange: () => this.inputChanged() })
    this.picker = new SelectRenderable(renderer, { id: 'vivi-control-picker', width: '100%', height: 12,
      flexShrink: 0, options: [], showDescription: false, showScrollIndicator: true, wrapSelection: false,
      backgroundColor: 'transparent', focusedBackgroundColor: 'transparent', textColor: options.foreground,
      focusedTextColor: options.foreground, selectedBackgroundColor: options.selection,
      selectedTextColor: options.selectedForeground, onMouse: event => this.pickMouse(event) })
    this.picker.focusable = false
    // Paint bands after native text rendering, before the independent hover layer.
    const renderPicker = this.picker.render
    const band = RGBA.fromHex(options.rowBackground)
    this.picker.render = (buffer, deltaTime) => {
      renderPicker.call(this.picker, buffer, deltaTime)
      if (!this.picker.visible || this.title !== 'Resume a local session' || this.mode !== 'picker' || !this.state?.matches.length) return
      const left = Math.max(0, this.picker.screenX)
      const right = Math.min(buffer.width, this.picker.screenX + this.picker.width - Number(this.picker.showScrollIndicator))
      const background = buffer.buffers.bg
      for (let row = 0; row < this.picker.height; row++) {
        const index = pickerIndexAt(this.picker, this.picker.x, this.picker.y + row)
        const y = this.picker.screenY + row
        if (index === undefined || index % 2 !== 0 || index === this.picker.getSelectedIndex() || y < 0 || y >= buffer.height) continue
        for (let x = left; x < right; x++) background.set(band.buffer, (y * buffer.width + x) * 4)
      }
    }
    this.picker.on(SelectRenderableEvents.SELECTION_CHANGED, () => { this.mouse.clear(); this.describe() })
    this.sectionList = new ModalScrollBoxRenderable(renderer, { id: 'vivi-control-sections', width: '100%', height: 12,
      flexShrink: 0, visible: false, scrollX: false, scrollY: true, viewportCulling: true,
      contentOptions: { flexDirection: 'column' }, onMouse: event => {
        if (event.type === 'scroll') options.hover.clear()
        event.preventDefault(); event.stopPropagation(); this.mouse.clear()
        if (event.type === 'scroll' && options.ready()) this.scrollSections(event)
      } })
    this.sectionList.focusable = false
    this.description = new TextRenderable(renderer, { id: 'vivi-control-description', width: '100%', height: 2,
      flexShrink: 0, fg: options.foreground, attributes: TextAttributes.DIM, wrapMode: 'word', marginTop: 1 })
    this.body = new ModalScrollBoxRenderable(renderer, { id: 'vivi-control-body', width: '100%', flexGrow: 1,
      minHeight: 1, scrollX: false, scrollY: true, visible: false, contentOptions: { flexDirection: 'column' } })
    this.footerBar = new BoxRenderable(renderer, { id: 'vivi-control-actions', width: '100%', height: 1,
      flexShrink: 0, flexDirection: 'row', gap: 1, marginTop: 1 })
    this.footer = new TextRenderable(renderer, { id: 'vivi-control-hints', flexGrow: 1, minWidth: 0, height: 1,
      fg: options.foreground, attributes: TextAttributes.DIM, wrapMode: 'none' })
    this.refreshButton = new TextRenderable(renderer, { id: 'vivi-control-refresh', content: ' Refresh ', width: 9,
      height: 1, fg: options.foreground, selectable: false, onMouse: event => this.mouse.handle(event, this.refreshButton,
        'refresh', this.token, options.ready() && !!this.state?.refresh, () => this.finish?.(-1)) })
    this.confirmButton = new TextRenderable(renderer, { id: 'vivi-control-confirm', content: ' Open ', width: 9,
      height: 1, fg: options.foreground, selectable: false, onMouse: event => this.mouse.handle(event, this.confirmButton,
        'confirm', this.token, options.ready() && (this.mode !== 'picker' || options.completedFrame() > this.changedFrame), () => this.submit()) })
    this.footerBar.add(this.footer); this.footerBar.add(this.refreshButton); this.footerBar.add(this.confirmButton)
    options.hover.bind(this.closeButton, () => options.ready())
    options.hover.bind(this.refreshButton, () => options.ready() && !!this.state?.refresh)
    options.hover.bind(this.confirmButton, () => options.ready() && (this.mode !== 'picker' ||
      options.completedFrame() > this.changedFrame && !!this.state?.matches.length))
    options.hover.bind(this.picker, () => options.ready() && options.completedFrame() > this.changedFrame,
      point => pickerHoverRegion(this.picker, point))
    for (const child of [header, this.noticeLine, this.query, this.picker, this.sectionList, this.description, this.body, this.footerBar]) this.panel.add(child)
    renderer.root.add(this.overlay)
    this.resize()
  }

  notice(text: string): void {
    this.notices = this.options.safe(`${this.notices}${text}`, 16384)
    this.noticeLine.content = this.notices.trim()
    this.noticeBuffer.setText(this.notices.trim())
    this.noticeLine.visible = !!this.notices.trim()
    this.resize()
  }
  private noticeFits(mode: typeof this.mode = this.mode): boolean {
    // Use target dimensions rather than the last rendered layout. A command can
    // write and open its next picker in the same event-loop turn.
    const width = Math.min(this.renderer.terminalWidth, Math.max(12, Math.min(80, this.renderer.terminalWidth - 4)))
    const desiredHeight = mode === 'text' ? Math.max(10, this.textRowCount + 9) : 24
    const height = Math.min(this.renderer.terminalHeight, Math.max(6, Math.min(desiredHeight, this.renderer.terminalHeight - 4)))
    return height >= 16 && (this.noticeView.measureForDimensions(Math.max(1, width - 4), 16384)?.lineCount ?? 3) <= 2
  }
  get hasOutput(): boolean { return !!this.notices.trim() && !this.noticeFits('picker') }
  async showOutput(includeUnseen = false): Promise<void> {
    if (includeUnseen ? !this.notices.trim() || this.notices === this.shownNotices : !this.hasOutput) return
    const body = this.notices
    this.notices = ''; this.shownNotices = ''; this.noticeLine.visible = false; this.noticeBuffer.setText('')
    await this.showDetails({ title: this.title, sections: [{ title: 'Details', body }] })
  }
  setTitle(title: string): void {
    this.title = title
    this.heading.content = this.options.safe(title === 'Conversation actions' ? 'Commands' : `Settings / ${title}`, 1024)
  }
  cancel(): void { this.finish?.(undefined) }
  private start(title: string, mode: typeof this.mode): Promise<unknown> {
    this.wheel.reset()
    this.cancel(); this.mode = mode; this.setTitle(title); this.token = {}; this.mouse.clear()
    this.changedFrame = this.renderer.frameId
    this.query.visible = mode !== 'details'; this.picker.visible = mode === 'picker'
    this.sectionList.visible = false
    this.description.visible = mode === 'picker'; this.body.visible = mode === 'details'
    this.footer.content = mode === 'picker' ? '↑↓ select · Enter open · Esc back' : mode === 'details'
      ? '↑↓ / wheel scroll · Enter or Esc back' : 'Enter confirm · Ctrl+J newline · Esc back'
    this.confirmButton.content = mode === 'picker' ? ' Open ' : mode === 'details' ? ' Back ' : ' Confirm '
    return new Promise(resolve => { this.finish = value => {
      this.lastQuery = mode === 'details' ? '' : this.query.plainText
      this.lastIndex = this.state?.matches[this.selectedIndex()] ?? 0
      this.finish = undefined; this.query.blur(); this.mouse.clear(); resolve(value)
    } })
  }
  async choose<T>(title: string, choices: readonly Choice<T>[], options: SearchableOptions = {}): Promise<SearchableSelection<T> | undefined> {
    if (this.disposed) return undefined
    const pending = this.start(title, 'picker')
    const remembered = title === 'Conversation actions' ? this.menuState : undefined
    const state: Picker = { choices, matches: [], query: '', refresh: options.refresh ?? false,
      sectioned: choices.some(choice => choice.section !== undefined) }
    this.state = state
    this.query.height = 1
    this.query.placeholder = new StyledText([{ __isChunk: true, text: title.startsWith('Models ·') ? 'Search models…'
      : title === 'Resume a local session' ? 'Search sessions…' : 'Search commands…',
      fg: this.options.foreground, attributes: TextAttributes.DIM }])
    this.setText(options.query ?? remembered?.query ?? '')
    this.filter(true)
    const index = options.initialIndex ?? remembered?.index ?? 0
    const selected = this.state.matches.indexOf(index)
    this.selectIndex(this.query.plainText && !remembered ? 0 : Math.max(0, selected))
    this.describe(); this.resize(); this.query.focus()
    if (this.noticeLine.visible && this.noticeFits()) this.shownNotices = this.notices
    const value = await pending
    const query = this.lastQuery
    if (remembered) this.menuState = { query, index: this.lastIndex }
    if (title === 'Conversation actions' && typeof value === 'number' && choices[value]) this.title = choices[value]!.name
    if (this.state === state) this.state = undefined
    return typeof value !== 'number' ? undefined : value === -1 ? { kind: 'refresh', query }
      : choices[value] ? { kind: 'selected', value: choices[value]!.value, query } : undefined
  }
  async text(title: string, initial: string): Promise<string | undefined> {
    const pending = this.start(title, 'text')
    this.state = undefined; this.query.height = 4
    this.setText(initial); this.resize(); this.query.focus(); this.query.gotoBufferEnd()
    if (this.noticeLine.visible && this.noticeFits()) this.shownNotices = this.notices
    const result = await pending
    return typeof result === 'string' ? result : undefined
  }
  async showDetails(details: ControlDetails): Promise<void> {
    this.details = details
    const pending = this.start(details.title, 'details')
    this.drawDetails(); this.resize(); this.body.scrollTo(0)
    if (this.noticeLine.visible && this.noticeFits()) this.shownNotices = this.notices
    await pending
    if (this.details === details) {
      this.details = undefined
      for (const child of this.body.getChildren()) child.destroyRecursively()
    }
  }
  private drawDetails(): void {
    for (const child of this.body.getChildren()) child.destroyRecursively()
    const add = (content: string, muted = false, accent = false) => this.body.add(new TextRenderable(this.renderer, {
      content: this.options.safe(content, 32768), width: '100%', flexShrink: 0, wrapMode: 'word',
      fg: accent ? this.options.accent : this.options.foreground, attributes: muted ? TextAttributes.DIM : 0, marginBottom: 1 }))
    const details = this.details
    if (!details) return
    if (details.meter && details.meter.capacity > 0) {
      const { value, capacity, label } = details.meter
      const percent = Math.max(0, Math.min(100, value / capacity * 100))
      const cells = Math.min(36, Math.max(4, this.renderer.terminalWidth - 16))
      const used = Math.round(percent / 100 * cells)
      add(`${label}  ${Math.round(percent)}%\n${'━'.repeat(used)}${'─'.repeat(cells - used)}`, false, true)
    }
    for (const field of details.fields ?? []) {
      const row = new BoxRenderable(this.renderer, { width: '100%', flexDirection: 'row', flexShrink: 0, marginBottom: 1 })
      row.add(new TextRenderable(this.renderer, { content: this.options.safe(field.label, 1024), width: Math.max(5, Math.min(18, Math.floor((Math.min(80, this.renderer.terminalWidth - 4) - 4) * 0.4))),
        flexShrink: 0, fg: this.options.foreground, attributes: TextAttributes.DIM, wrapMode: 'word' }))
      row.add(new TextRenderable(this.renderer, { content: this.options.safe(field.value, 8192), flexGrow: 1,
        minWidth: 0, fg: this.options.foreground, wrapMode: 'word' }))
      this.body.add(row)
    }
    for (const section of details.sections ?? []) { add(section.title, false, true); add(section.body) }
  }
  private setText(text: string): void {
    this.changing = true
    try { this.query.setText(this.options.safe(text, this.mode === 'picker' ? 200 : 65536)) }
    finally { this.changing = false }
  }
  private inputChanged(): void {
    if (this.changing || this.disposed) return
    const raw = this.query.plainText
    const safe = this.options.safe(raw, this.mode === 'picker' ? 200 : 65536)
    const text = this.mode === 'picker' ? safe.replace(/[\t\n]+/g, ' ').slice(0, 200) : safe
    if (raw !== text) this.setText(text)
    if (this.state) this.filter()
    else if (this.mode === 'text' && this.textRows() !== this.textRowCount) this.resize()
  }
  private filter(force = false): void {
    const state = this.state
    if (!state) return
    const query = this.query.plainText
    if (!force && state.query === query) return
    state.query = query; this.mouse.clear(); this.changedFrame = this.renderer.frameId
    state.matches = matchingChoiceIndices(state.choices.map(choice => ({ ...choice,
      searchTerms: [...choice.searchTerms ?? [], choice.description ?? '', choice.section ?? '', typeof choice.value === 'string' ? choice.value : ''] })), query)
    if (state.sectioned) {
      const sections = [...new Set(query.trim() ? state.matches.map(index => state.choices[index]!.section ?? 'Other')
        : state.choices.map(choice => choice.section ?? 'Other'))]
      state.matches = sections.flatMap(section => state.matches.filter(index => (state.choices[index]!.section ?? 'Other') === section))
    }
    this.picker.visible = !state.sectioned; this.sectionList.visible = state.sectioned
    const leading = state.choices.map(choice => this.options.safe(choice.leadingText ?? '', 32))
    const leadingWidth = leading.reduce((width, text) => Math.max(width, text.length), 0)
    this.picker.options = state.matches.length ? state.matches.map(index => ({
      name: `${leadingWidth ? `${leading[index]!.padEnd(leadingWidth)}  ` : ''}${this.options.safe(state.choices[index]!.name, 1024)}`,
      description: '', value: index
    })) : [{ name: this.title.startsWith('Models ·') ? 'No matching models'
      : this.title === 'Resume a local session' ? 'No matching sessions' : 'No matching commands', description: '', value: -1 }]
    if (state.sectioned) { this.sectionSelection = 0; this.drawSections(); this.sectionList.scrollTo(0) }
    this.selectIndex(0); this.describe()
  }
  private selectedIndex(): number { return this.state?.sectioned ? this.sectionSelection : this.picker.getSelectedIndex() }
  private selectIndex(index: number): void {
    if (!this.state?.sectioned) { this.picker.setSelectedIndex(index); return }
    this.mouse.clear()
    this.sectionSelection = Math.max(0, Math.min(this.state.matches.length - 1, index))
    for (const [position, { row, label }] of this.sectionRows) {
      const selected = position === this.sectionSelection
      row.backgroundColor = selected ? this.options.selection : 'transparent'
      label.fg = selected ? this.options.selectedForeground : this.options.foreground
      label.content = `${selected ? '›' : ' '} ${this.options.safe(this.state.choices[this.state.matches[position]!]!.name, 1024)}`
    }
    this.scrollSelection = true; this.describe()
  }
  private drawSections(): void {
    for (const child of this.sectionList.getChildren()) child.destroyRecursively()
    this.sectionRows.clear()
    const state = this.state!
    let section: string | undefined
    state.matches.forEach((index, position) => {
      const choice = state.choices[index]!
      const name = choice.section ?? 'Other'
      if (name !== section) {
        this.sectionList.add(new TextRenderable(this.renderer, { id: `vivi-control-section-${position}`,
          content: this.options.safe(name, 1024), width: '100%', height: 1, flexShrink: 0,
          marginTop: section === undefined ? 0 : 1, fg: this.options.foreground,
          attributes: TextAttributes.DIM, selectable: false, wrapMode: 'none' }))
        section = name
      }
      const row = new BoxRenderable(this.renderer, { id: `vivi-control-section-row-${index}`, width: '100%', height: 1,
        flexShrink: 0, onMouse: event => {
          if (event.type === 'scroll') { event.preventDefault(); event.stopPropagation(); this.mouse.clear(); if (this.options.ready()) this.scrollSections(event); return }
          this.mouse.handle(event, row, `${index}:${state.query}`, this.token,
            this.options.ready() && this.options.completedFrame() > this.changedFrame,
            () => { this.selectIndex(position); this.finish?.(index) })
        } })
      const label = new TextRenderable(this.renderer, { content: `  ${this.options.safe(choice.name, 1024)}`,
        width: '100%', height: 1, fg: this.options.foreground, selectable: false, wrapMode: 'none' })
      this.options.hover.bind(label, () => this.options.ready() && this.options.completedFrame() > this.changedFrame)
      row.add(label); this.sectionList.add(row); this.sectionRows.set(position, { row, label })
    })
    if (!state.matches.length) this.sectionList.add(new TextRenderable(this.renderer, { content: 'No matching commands',
      height: 1, fg: this.options.foreground, attributes: TextAttributes.DIM }))
  }
  private scrollSections(event: MouseEvent): void {
    const step = this.wheel.step(event.scroll?.direction)
    if (step) this.sectionList.scrollBy(step)
    this.scrollSelection = false
  }
  private revealSectionSelection(): void {
    if (!this.scrollSelection || !this.state?.sectioned) return
    this.scrollSelection = false
    const row = this.sectionRows.get(this.sectionSelection)?.row
    if (!row) return
    const viewport = this.sectionList.viewport
    if (row.y < viewport.y) this.sectionList.scrollTo(this.sectionList.scrollTop + row.y - viewport.y)
    else if (row.y + row.height > viewport.y + viewport.height)
      this.sectionList.scrollTo(this.sectionList.scrollTop + row.y + row.height - viewport.y - viewport.height)
  }
  private describe(): void {
    const index = this.state?.matches[this.selectedIndex()]
    const choice = index === undefined ? undefined : this.state?.choices[index]
    this.description.content = this.options.safe(choice ? `${choice.description ?? ''}${typeof choice.value === 'string' && choice.value.startsWith('/') ? `\n${choice.value}` : ''}` : 'Try another search', 4096)
  }
  private submit(): void {
    if (!this.options.ready()) return
    this.inputChanged()
    if (this.mode === 'text') this.finish?.(this.query.plainText)
    else if (this.mode === 'details') this.cancel()
    else {
      const index = this.state?.matches[this.selectedIndex()]
      if (index !== undefined) this.finish?.(index)
    }
  }
  handleKey(key: KeyEvent): void {
    this.wheel.reset()
    if (!this.finish) { key.preventDefault(); key.stopPropagation(); return }
    if (key.name === 'escape' || key.ctrl && key.name === 'c') { key.preventDefault(); key.stopPropagation(); this.cancel(); return }
    if (!this.options.ready() || key.eventType === 'repeat' && ['return', 'kpenter'].includes(key.name) || key.repeated && ['return', 'kpenter'].includes(key.name)) {
      key.preventDefault(); key.stopPropagation(); return
    }
    if (key.name === 'linefeed' || key.ctrl && key.name === 'j') {
      key.preventDefault(); key.stopPropagation()
      if (this.mode === 'text') this.query.insertText('\n')
      return
    }
    if (['return', 'kpenter'].includes(key.name) && !key.ctrl && !key.shift && !key.meta) {
      key.preventDefault(); key.stopPropagation(); this.submit(); return
    }
    if (this.mode === 'details') {
      key.preventDefault(); key.stopPropagation()
      const step = ['pageup', 'pagedown'].includes(key.name) ? Math.max(1, this.body.height - 1) : 1
      if (['up', 'pageup'].includes(key.name)) this.body.scrollBy(-step)
      else if (['down', 'pagedown'].includes(key.name)) this.body.scrollBy(step)
      else if (key.name === 'home') this.body.scrollTo(0)
      else if (key.name === 'end') this.body.scrollTo(this.body.scrollHeight)
      return
    }
    if (this.state && ['up', 'down', 'pageup', 'pagedown'].includes(key.name) && !key.ctrl && !key.meta) {
      key.preventDefault(); key.stopPropagation(); this.filter()
      const step = ['pageup', 'pagedown'].includes(key.name) ? Math.max(1, (this.state.sectioned ? this.sectionList.height : this.picker.height) - 1) : 1
      this.selectIndex(Math.max(0, Math.min(this.state.matches.length - 1,
        this.selectedIndex() + (['up', 'pageup'].includes(key.name) ? -step : step))))
    } else if (this.state && key.ctrl && key.name === 'r' && this.state.refresh) {
      key.preventDefault(); key.stopPropagation(); this.finish?.(-1)
    } else if (key.ctrl && key.name === 'u') { key.preventDefault(); key.stopPropagation(); this.setText(''); this.inputChanged() }
    else if (key.name === 'tab' || key.ctrl && !['a', 'b', 'e', 'f', 'h', 'k', 'w', 'z', 'y', 'left', 'right', 'home', 'end', 'backspace', 'delete', '-', '.'].includes(key.name)) { key.preventDefault(); key.stopPropagation() }
  }
  handlePaste(event: PasteEvent): void {
    this.wheel.reset()
    event.preventDefault(); event.stopPropagation(); this.mouse.clear()
    if (!this.options.ready() || this.mode === 'details') return
    const limit = this.mode === 'picker' ? 200 : 65536
    const decoded = decodePasteBytes(event.bytes).replace(/\r\n?/g, '\n')
    const text = this.options.safe(this.mode === 'picker' ? decoded.replace(/[\t\n]+/g, ' ') : decoded, limit + 1)
    if (text.length > limit - this.query.plainText.length) {
      const message = `Paste ignored: input limit is ${limit} characters`
      this.notice(`${message}\n`)
      this.footer.content = message
      return
    }
    this.query.insertText(text)
    this.inputChanged()
  }
  private pickMouse(event: MouseEvent): void {
    event.preventDefault(); event.stopPropagation()
    if (event.type === 'scroll' && this.state && this.options.ready()) {
      const step = this.wheel.step(event.scroll?.direction)
      if (step < 0) this.picker.moveUp()
      else if (step > 0) this.picker.moveDown()
      return
    }
    const index = pickerIndexAt(this.picker, event.x, event.y)
    this.mouse.handle(event, this.picker, `${index}:${this.state?.query}`, this.token,
      this.options.ready() && this.options.completedFrame() > this.changedFrame && index !== undefined && this.state?.matches[index] !== undefined,
      () => { this.picker.setSelectedIndex(index!); this.finish?.(this.state!.matches[index!]) })
  }
  private backdrop(event: MouseEvent): void {
    if (event.type === 'scroll') this.options.hover.clear()
    if (event.x >= this.panel.x && event.x < this.panel.x + this.panel.width && event.y >= this.panel.y && event.y < this.panel.y + this.panel.height) return
    this.mouse.handle(event, this.overlay, 'outside', this.token, this.options.ready(), () => this.cancel())
  }
  resize(): void {
    this.wheel.reset()
    this.mouse.clear(); this.changedFrame = this.renderer.frameId
    const width = Math.max(12, Math.min(80, this.renderer.terminalWidth - 4))
    this.textRowCount = this.textRows()
    const desiredHeight = this.mode === 'text' ? Math.max(10, this.textRowCount + 7 + Number(!!this.notices.trim()) * 2) : 24
    const height = Math.max(6, Math.min(desiredHeight, this.renderer.terminalHeight - 4))
    this.panel.width = Math.min(this.renderer.terminalWidth, width)
    this.panel.height = Math.min(this.renderer.terminalHeight, height)
    this.query.marginBottom = height >= 10 ? 1 : 0
    this.noticeLine.visible = !!this.notices.trim() && height >= 16
    this.description.visible = this.mode === 'picker' && height >= 14
    this.picker.height = Math.max(1, height - 9 - Number(this.noticeLine.visible) * 2 - Number(this.description.visible) * 3)
    this.sectionList.height = Math.max(1, height - 9 - Number(this.noticeLine.visible) * 2 - Number(this.description.visible) * 3)
    this.scrollSelection = true
    this.footerBar.visible = height >= 10
    this.footer.visible = width >= 54
    this.refreshButton.visible = this.mode === 'picker' && !!this.state?.refresh
    this.query.height = this.mode === 'text' ? Math.max(1, Math.min(this.textRowCount, height - 7)) : 1
    if (this.details) this.drawDetails()
  }
  redact(): void {
    this.setText(this.query.plainText); this.noticeLine.content = this.options.safe(this.notices)
    this.noticeBuffer.setText(this.options.safe(this.notices.trim()))
    this.heading.content = this.options.safe(this.title === 'Conversation actions' ? 'Commands' : `Settings / ${this.title}`, 1024)
    this.description.content = this.options.safe(this.description.plainText, 4096)
    if (this.state) this.filter(true)
    else this.picker.options = this.picker.options.map(option => ({ ...option, name: this.options.safe(option.name, 1024) }))
    if (this.details) this.drawDetails()
  }
  private textRows(): number {
    const width = Math.max(1, Math.min(80, this.renderer.terminalWidth - 4) - 4)
    return Math.max(2, Math.min(8, this.query.editorView.measureForDimensions(width, 65536)?.lineCount ?? 2))
  }
  sync(): void {
    if (this.state && this.query.plainText !== this.state.query || this.mode === 'text' && this.textRows() !== this.textRowCount) this.inputChanged()
    this.revealSectionSelection()
  }
  resetGesture(): void { this.mouse.clear(); this.wheel.reset() }
  close(): void {
    if (this.disposed) return
    this.cancel(); this.disposed = true; this.query.blur(); this.overlay.destroyRecursively()
    this.noticeView.destroy(); this.noticeBuffer.destroy()
  }
}
