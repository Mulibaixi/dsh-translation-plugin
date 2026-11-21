import { captureVisibleText, restoreVisibleText, type TranscriptTextAnchor } from './transcript-edit-text.js'

export interface TranscriptPositionItem {
  readonly id: string
  readonly events: readonly string[]
  readonly active: boolean
}

export interface TranscriptEditPosition {
  readonly heading: HTMLElement
  readonly anchor: TranscriptTextAnchor | undefined
}

export function isTranscriptHeadingStuck(heading: HTMLElement): boolean {
  const block = heading.parentElement
  const view = heading.ownerDocument.defaultView
  if (!block || block.firstElementChild !== heading || !view) return false
  if (view.getComputedStyle(heading).position !== 'sticky') return false
  // The heading is the first child. The block's content edge stays at its natural position.
  const inset = block.clientTop + (parseFloat(view.getComputedStyle(block).paddingTop) || 0)
  return heading.getBoundingClientRect().top - (block.getBoundingClientRect().top + inset) > 1
}

export function captureTranscriptEdit(viewport: HTMLElement, heading: HTMLElement, text: string): TranscriptEditPosition | undefined {
  if (!viewport.contains(heading) || !isTranscriptHeadingStuck(heading)) return
  const body = heading.parentElement?.querySelector<HTMLElement>('[data-translation-edit-body]')
  const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop
  const visibleTop = Math.max(viewportTop, heading.getBoundingClientRect().bottom)
  const anchor = body && captureVisibleText(body, visibleTop, viewportTop + viewport.clientHeight, text)
  return { heading, anchor: anchor ?? undefined }
}

function scrollToTop(viewport: HTMLElement, targetTop: number, inset = 0): void {
  const viewportTop = viewport.getBoundingClientRect().top + viewport.clientTop
  const offset = viewport.scrollTop + targetTop - viewportTop - inset
  viewport.scrollTop = Math.max(0, Math.min(offset, viewport.scrollHeight - viewport.clientHeight))
}

function positionEditor(viewport: HTMLElement, { heading, anchor }: TranscriptEditPosition): boolean {
  if (!viewport.contains(heading)) return false
  const editor = heading.parentElement?.querySelector<HTMLElement>(':scope > .dsh-tp-version-editor')
  const view = heading.ownerDocument.defaultView
  if (!editor || !view) return false
  const stickyTop = parseFloat(view.getComputedStyle(heading).top)
  if (!Number.isFinite(stickyTop)) return false
  // The transcript's sticky rule offsets its top padding to sit at the visible edge.
  const paddingTop = parseFloat(view.getComputedStyle(viewport).paddingTop) || 0
  const titleSpace = Math.max(0, paddingTop + stickyTop + heading.getBoundingClientRect().height)
  const gap = parseFloat(view.getComputedStyle(editor).marginTop) || 0
  scrollToTop(viewport, editor.getBoundingClientRect().top, titleSpace + gap)
  const textarea = anchor && editor.querySelector('textarea')
  if (textarea) restoreVisibleText(textarea, anchor)
  return true
}

/** A positioning target belongs to the current view, never to persisted translation history. */
export class TranscriptPosition {
  private sessionId: string | undefined
  private previous: readonly TranscriptPositionItem[] = []
  private readonly targets = new Set<string>()
  private following = false
  private pending: string | undefined

  update(sessionId: string | undefined, items: readonly TranscriptPositionItem[], viewport: HTMLElement | null, editPosition?: TranscriptEditPosition): void {
    const previous = new Map(this.previous.map(item => [item.id, item]))
    if (sessionId !== this.sessionId || !this.previous.length) {
      this.targets.clear()
      this.pending = items.at(-1)?.id
    } else {
      const changed = items.filter(item => {
        const old = previous.get(item.id)
        return !old || item.events.some(event => !old.events.includes(event))
      })
      if (changed.length) {
        // New material starts its own positioning; overlapping translations keep their earliest unit.
        if (!this.following || changed.some(item => !previous.has(item.id))) this.targets.clear()
        for (const item of changed) this.targets.add(item.id)
        this.pending = items.find(item => this.targets.has(item.id))?.id
      }
    }
    this.sessionId = sessionId
    this.previous = items
    this.following = items.some(item => this.targets.has(item.id) && item.active)
    if (!items.some(item => item.id === this.pending)) this.pending = undefined
    for (const id of this.targets) if (!items.some(item => item.id === id)) this.targets.delete(id)
    if (!viewport || viewport.scrollHeight === 0) return
    if (editPosition && positionEditor(viewport, editPosition)) {
      this.pending = undefined
      return
    }
    if (!this.pending) return
    const attributes = { u: 'data-unit-id', m: 'data-material-id', o: 'data-operation-id' } as const
    const attribute = attributes[this.pending[0] as keyof typeof attributes]
    const target = Array.from(viewport.children).find(node => node.getAttribute(attribute) === this.pending!.slice(2))
    if (!target) return
    scrollToTop(viewport, target.getBoundingClientRect().top)
    this.pending = undefined
  }
}
