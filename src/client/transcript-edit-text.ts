export interface TranscriptTextAnchor {
  readonly text: string
  readonly offset: number
}

function textareaText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/** RecordObjectText renders the editable text as direct text nodes, separate from object labels. */
export function captureVisibleText(body: HTMLElement, visibleTop: number, visibleBottom: number, text: string): TranscriptTextAnchor | undefined {
  const bounds = body.getBoundingClientRect()
  const top = Math.max(visibleTop, bounds.top)
  const bottom = Math.min(visibleBottom, bounds.bottom)
  if (bottom <= top) return

  const nodes = Array.from(body.childNodes).filter((node): node is Text => node.nodeType === 3 && !!node.textContent)
  const value = textareaText(text)
  if (textareaText(nodes.map(node => node.data).join('')) !== value) return

  const range = body.ownerDocument.createRange()
  let prefix = ''
  for (const node of nodes) {
    range.selectNodeContents(node)
    const rect = range.getBoundingClientRect()
    if (rect.top >= bottom) return
    if (rect.bottom > top) {
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
      if (line.bottom > top && line.top < bottom) {
        return { text: value, offset: textareaText(prefix + node.data.slice(0, low - 1)).length }
      }
    }
    prefix += node.data
  }
}

const textLayoutProperties = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant',
  'font-feature-settings', 'font-variation-settings', 'line-height', 'letter-spacing', 'word-spacing',
  'white-space', 'overflow-wrap', 'word-break', 'tab-size', 'direction', 'text-indent', 'text-align',
]

export function restoreVisibleText(editor: HTMLTextAreaElement, anchor: TranscriptTextAnchor): void {
  if (editor.value !== anchor.text || anchor.offset === 0 || editor.scrollHeight <= editor.clientHeight) return
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
  try {
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 1)
    const firstTop = range.getBoundingClientRect().top
    range.setStart(text, anchor.offset)
    range.setEnd(text, anchor.offset + 1)
    editor.scrollTop = Math.max(0, Math.min(range.getBoundingClientRect().top - firstTop, editor.scrollHeight - editor.clientHeight))
  } finally {
    mirror.remove()
  }
}
