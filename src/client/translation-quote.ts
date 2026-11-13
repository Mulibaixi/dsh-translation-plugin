import { h, react } from './react.js'

export type InsertTranslationQuote = (text: string) => boolean

/** The action belongs to the transcript, while insertion belongs to the main chat. */
export function TranslationQuote({ transcript, insertQuote }: {
  readonly transcript: { readonly current: HTMLElement | null }
  readonly insertQuote: InsertTranslationQuote
}): unknown {
  const anchor = react.useRef<HTMLDivElement | null>(null)
  const button = react.useRef<HTMLButtonElement | null>(null)
  const [position, setPosition] = react.useState<{ left: number; top: number } | null>(null)
  const [blocked, setBlocked] = react.useState(false)

  function readSelection() {
    const viewport = transcript.current
    const selection = viewport?.ownerDocument.getSelection()
    if (!viewport || selection?.rangeCount !== 1 || selection.isCollapsed) return
    const range = selection.getRangeAt(0)
    const start = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement
    const end = range.endContainer.nodeType === 1 ? range.endContainer as Element : range.endContainer.parentElement
    const body = start?.closest('[data-translation-quote]')
    if (!body || !viewport.contains(body) || body !== end?.closest('[data-translation-quote]')) return
    const object = '[data-object-ref-id]'
    if (Array.from(body.querySelectorAll(object)).some(node => range.intersectsNode(node))) return
    const text = range.toString()
    const source = body.getAttribute('data-translation-quote')
    if (source && text.trim()) return { selection, range, text, source }
  }

  react.useEffect(() => {
    const viewport = transcript.current, element = anchor.current
    const action = button.current
    const document = viewport?.ownerDocument, view = document?.defaultView
    if (!viewport || !element || !action || !document || !view) return
    let selecting = false
    const dismiss = () => { setPosition(null); setBlocked(false) }
    const update = () => {
      if (selecting) return
      const selected = readSelection()
      const bounds = viewport.getBoundingClientRect()
      const rects = selected ? Array.from(selected.range.getClientRects()) : []
      const firstLine = rects.find(rect =>
        rect.width > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom)
      if (!selected || !firstLine) { dismiss(); return }
      const origin = element.getBoundingClientRect()
      const size = action.getBoundingClientRect()
      const lineRects = rects.filter(rect => rect.width > 0 && rect.top < firstLine.bottom && rect.bottom > firstLine.top)
      const lineLeft = Math.min(...lineRects.map(rect => rect.left))
      const lineRight = Math.max(...lineRects.map(rect => rect.right))
      const center = (lineLeft + lineRight) / 2
      const left = Math.max(bounds.left + size.width / 2, Math.min(center, bounds.right - size.width / 2))
      const selectionBounds = selected.range.getBoundingClientRect()
      const gap = 8
      const above = selectionBounds.top - gap - size.height
      const below = selectionBounds.bottom + gap
      const top = above >= origin.top ? above : below
      if (top + size.height > bounds.bottom) { dismiss(); return }
      setPosition({ left: left - origin.left, top: top - origin.top })
      setBlocked(false)
    }
    const pointerDown = (event: PointerEvent) => {
      if (event.composedPath().includes(element)) return
      selecting = event.button === 0 && event.composedPath().includes(viewport)
      dismiss()
    }
    const pointerUp = () => {
      if (!selecting) return
      selecting = false
      update()
    }
    const cancel = () => { selecting = false; dismiss() }
    const keyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel() }
    document.addEventListener('selectionchange', update)
    document.addEventListener('pointerdown', pointerDown, true)
    document.addEventListener('pointerup', pointerUp)
    document.addEventListener('pointercancel', cancel)
    document.addEventListener('keydown', keyDown)
    document.addEventListener('scroll', dismiss, true)
    view.addEventListener('resize', dismiss)
    view.addEventListener('blur', cancel)
    return () => {
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('pointerdown', pointerDown, true)
      document.removeEventListener('pointerup', pointerUp)
      document.removeEventListener('pointercancel', cancel)
      document.removeEventListener('keydown', keyDown)
      document.removeEventListener('scroll', dismiss, true)
      view.removeEventListener('resize', dismiss)
      view.removeEventListener('blur', cancel)
    }
  }, [transcript])

  return h('div', { ref: anchor, className: 'dsh-tp-quote-anchor' }, h('button', {
    ref: button, type: 'button', className: 'dsh-tp-quote-selection', style: position ?? { visibility: 'hidden' },
    onPointerDown: (event: PointerEvent) => event.preventDefault(),
    onClick: () => {
      const selected = readSelection()
      if (selected && !insertQuote(`${selected.text}\n\n出处：${selected.source}`)) { setBlocked(true); return }
      // Insertion can move focus and the DOM selection into the main composer.
      const selection = selected?.selection
      if (selection?.anchorNode && transcript.current?.contains(selection.anchorNode)) selection.removeAllRanges()
      setPosition(null)
      setBlocked(false)
    },
  }, blocked ? '暂无法引用' : '引用文本'))
}
