export interface TranscriptTextAnchor {
  readonly text: string
  readonly offset: number
}

function textareaText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function firstVisibleOffset(node: Text, top: number, bottom: number): number | undefined {
  if (!node.length) return
  const range = node.ownerDocument.createRange()
  range.selectNodeContents(node)
  const rect = range.getBoundingClientRect()
  if (rect.bottom <= top || rect.top >= bottom) return
  // Find the shortest prefix that reaches the visible area, including soft-wrapped lines.
  let low = 1, high = node.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    range.setEnd(node, middle)
    if (range.getBoundingClientRect().bottom > top) high = middle
    else low = middle + 1
  }
  range.setStart(node, low - 1)
  range.setEnd(node, low)
  const line = range.getBoundingClientRect()
  if (line.bottom > top && line.top < bottom) return low - 1
}

function textNodes(body: HTMLElement): Text[] {
  return Array.from(body.childNodes).filter((node): node is Text => node.nodeType === 3 && !!node.textContent)
}

/** RecordObjectText renders the editable text as direct text nodes, separate from object labels. */
export function captureVisibleText(body: HTMLElement, visibleTop: number, visibleBottom: number, text: string): TranscriptTextAnchor | undefined {
  const bounds = body.getBoundingClientRect()
  const top = Math.max(visibleTop, bounds.top)
  const bottom = Math.min(visibleBottom, bounds.bottom)
  if (bottom <= top) return

  const nodes = textNodes(body)
  const value = textareaText(text)
  if (textareaText(nodes.map(node => node.data).join('')) !== value) return

  let prefix = ''
  for (const node of nodes) {
    const offset = firstVisibleOffset(node, top, bottom)
    if (offset !== undefined) return { text: value, offset: textareaText(prefix + node.data.slice(0, offset)).length }
    prefix += node.data
  }
}

function characterRect(node: Text, offset: number): DOMRect {
  const range = node.ownerDocument.createRange()
  range.setStart(node, offset)
  range.setEnd(node, Math.min(node.length, offset + 1))
  return range.getBoundingClientRect()
}

export function transcriptTextRect(body: HTMLElement, anchor: TranscriptTextAnchor): DOMRect | undefined {
  const nodes = textNodes(body)
  if (textareaText(nodes.map(node => node.data).join('')) !== anchor.text || !anchor.text.length) return
  let offset = Math.min(anchor.offset, anchor.text.length - 1)
  for (const node of nodes) {
    const length = textareaText(node.data).length
    if (offset < length) {
      // The textarea normalizes CRLF to LF, while a read-only body can retain CRLF.
      let rawOffset = offset
      if (node.data.includes('\r')) {
        rawOffset = 0
        for (let i = 0; i < offset; i++) rawOffset += node.data.startsWith('\r\n', rawOffset) ? 2 : 1
      }
      return characterRect(node, rawOffset)
    }
    offset -= length
  }
}

const textLayoutProperties = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant',
  'font-feature-settings', 'font-variation-settings', 'line-height', 'letter-spacing', 'word-spacing',
  'white-space', 'overflow-wrap', 'word-break', 'tab-size', 'direction', 'text-indent', 'text-align',
]

function measureEditor<T>(editor: HTMLTextAreaElement, measure: (node: Text, mirror: HTMLElement, paddingTop: number) => T): T | undefined {
  const document = editor.ownerDocument
  const view = document.defaultView
  if (!view || !editor.parentElement) return
  const computed = view.getComputedStyle(editor)
  const width = editor.clientWidth - parseFloat(computed.paddingLeft) - parseFloat(computed.paddingRight)
  if (width <= 0) return

  // A hidden copy lets the browser wrap the same text at the textarea's usable width.
  const mirror = document.createElement('div')
  mirror.style.cssText = 'position:fixed;inset:0 auto auto 0;visibility:hidden;pointer-events:none;box-sizing:content-box;padding:0;border:0;'
  mirror.style.width = `${width}px`
  for (const property of textLayoutProperties) mirror.style.setProperty(property, computed.getPropertyValue(property))
  const text = document.createTextNode(editor.value)
  mirror.append(text)
  editor.parentElement.append(mirror)
  try { return measure(text, mirror, parseFloat(computed.paddingTop) || 0) }
  finally { mirror.remove() }
}

export function restoreVisibleText(editor: HTMLTextAreaElement, anchor: TranscriptTextAnchor): void {
  if (editor.value !== anchor.text || anchor.offset === 0 || editor.scrollHeight <= editor.clientHeight) return
  measureEditor(editor, node => {
    const offset = characterRect(node, anchor.offset).top - characterRect(node, 0).top
    editor.scrollTop = Math.max(0, Math.min(offset, editor.scrollHeight - editor.clientHeight))
  })
}

export function captureEditorVisibleText(editor: HTMLTextAreaElement, visibleTop: number, visibleBottom: number): TranscriptTextAnchor | undefined {
  if (!editor.value) return
  const bounds = editor.getBoundingClientRect()
  const editorTop = bounds.top + editor.clientTop, editorBottom = editorTop + editor.clientHeight
  const top = Math.max(editorTop, visibleTop), bottom = Math.min(editorBottom, visibleBottom)
  // If the user scrolled the form offscreen to reach its buttons, use the editor's own viewport.
  return measureEditor(editor, (node, mirror, paddingTop) => {
    const origin = mirror.getBoundingClientRect().top + editor.scrollTop - paddingTop
    const visible = top < bottom ? firstVisibleOffset(node, origin + top - editorTop, origin + bottom - editorTop) : undefined
    const offset = visible ?? firstVisibleOffset(node, origin, origin + editor.clientHeight)
    return offset === undefined ? undefined : { text: editor.value, offset }
  })
}

/** Map a reading position in a discarded draft back to the closest surviving text. */
export function remapTranscriptAnchor(anchor: TranscriptTextAnchor, target: string): TranscriptTextAnchor {
  const text = textareaText(target), draft = anchor.text, offset = anchor.offset
  if (text === draft) return anchor
  let start = 0, draftEnd = draft.length, targetEnd = text.length
  while (start < draftEnd && start < targetEnd && draft[start] === text[start]) start++
  while (draftEnd > start && targetEnd > start && draft[draftEnd - 1] === text[targetEnd - 1]) { draftEnd--; targetEnd-- }
  if (offset < start) return { text, offset }
  if (offset >= draftEnd) return { text, offset: targetEnd + offset - draftEnd }

  // The logical line and its column approximate the position when a changed paragraph has no match.
  const prefix = draft.slice(start, offset)
  const lastBreak = prefix.lastIndexOf('\n')
  let nearby = start
  for (const character of prefix) if (character === '\n') {
    const next = text.indexOf('\n', nearby)
    if (next < 0 || next >= targetEnd) { nearby = targetEnd; break }
    nearby = next + 1
  }
  const endOfLine = text.indexOf('\n', nearby)
  nearby = Math.min(targetEnd, endOfLine < 0 ? text.length : endOfLine, nearby + prefix.length - lastBreak - 1)
  const clue = draft.slice(offset, offset + 32)
  if (clue.trim().length >= 8) {
    const before = text.lastIndexOf(clue, nearby), after = text.indexOf(clue, nearby)
    if (before >= start || after >= 0 && after <= targetEnd) {
      if (before < start) nearby = after
      else if (after < 0 || after > targetEnd || nearby - before <= after - nearby) nearby = before
      else nearby = after
    }
  }
  return { text, offset: nearby }
}
