import { captureEditorVisibleText, captureVisibleText, remapTranscriptAnchor, restoreVisibleText, transcriptTextRect, type TranscriptTextAnchor } from './transcript-edit-text.js'

export interface TranscriptPositionItem {
  readonly id: string
  readonly events: readonly string[]
  readonly active: boolean
}

export interface TranscriptEditPosition {
  readonly heading: HTMLElement
  readonly anchor: TranscriptTextAnchor | undefined
}

export interface TranscriptReadingPosition {
  readonly sessionId: string
  readonly unitId: string
  readonly revisionId: string | null
  readonly anchor: TranscriptTextAnchor
}

export function captureTranscriptExit(editor: HTMLTextAreaElement, text: string): TranscriptTextAnchor | undefined {
  const viewport = editor.closest<HTMLElement>('.dsh-tp-transcript')
  const heading = editor.closest('.dsh-tp-version-editor')?.parentElement?.firstElementChild
  if (!viewport || !heading) return
  const top = viewport.getBoundingClientRect().top + viewport.clientTop
  const anchor = captureEditorVisibleText(editor, Math.max(top, heading.getBoundingClientRect().bottom), top + viewport.clientHeight)
  return anchor && remapTranscriptAnchor(anchor, text)
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

function titleSpace(viewport: HTMLElement, heading: Element): number {
  const view = heading.ownerDocument.defaultView
  if (!view) return 0
  const stickyTop = parseFloat(view.getComputedStyle(heading).top)
  if (!Number.isFinite(stickyTop)) return 0
  // The transcript's sticky rule offsets its top padding to sit at the visible edge.
  const paddingTop = parseFloat(view.getComputedStyle(viewport).paddingTop) || 0
  return Math.max(0, paddingTop + stickyTop + heading.getBoundingClientRect().height)
}

function positionEditor(viewport: HTMLElement, { heading, anchor }: TranscriptEditPosition): boolean {
  if (!viewport.contains(heading)) return false
  const editor = heading.parentElement?.querySelector<HTMLElement>(':scope > .dsh-tp-version-editor')
  const view = heading.ownerDocument.defaultView
  if (!editor || !view) return false
  const gap = parseFloat(view.getComputedStyle(editor).marginTop) || 0
  scrollToTop(viewport, editor.getBoundingClientRect().top, titleSpace(viewport, heading) + gap)
  const textarea = anchor && editor.querySelector('textarea')
  if (textarea) restoreVisibleText(textarea, anchor)
  return true
}

function positionReading(viewport: HTMLElement, { unitId, revisionId, anchor }: TranscriptReadingPosition): boolean {
  const unit = Array.from(viewport.children).find(node => node.getAttribute('data-unit-id') === unitId)
  const block = revisionId === null ? unit?.querySelector('[data-transcript-source]')
    : Array.from(unit?.querySelectorAll('[data-transcript-revision]') ?? []).find(node => node.getAttribute('data-transcript-revision') === revisionId)
  const body = block?.querySelector<HTMLElement>('[data-translation-edit-body]'), heading = block?.firstElementChild
  if (!body || !heading) return false
  const rect = transcriptTextRect(body, anchor)
  if (!rect || rect.height === 0) return false
  const inset = titleSpace(viewport, heading)
  const top = viewport.getBoundingClientRect().top + viewport.clientTop + inset
  const visibleTop = Math.max(top, heading.getBoundingClientRect().bottom)
  if (rect.top < visibleTop - 1 || rect.bottom > visibleTop + rect.height * 2) scrollToTop(viewport, rect.top, inset + 2)
  return true
}

/** A positioning target belongs to the current view, never to persisted translation history. */
export class TranscriptPosition {
  private sessionId: string | undefined
  private previous: readonly TranscriptPositionItem[] = []
  private readonly targets = new Set<string>()
  private following = false
  private pending: string | undefined

  update(sessionId: string | undefined, items: readonly TranscriptPositionItem[], viewport: HTMLElement | null,
    editPosition?: TranscriptEditPosition, readingPosition?: TranscriptReadingPosition): void {
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
    if (editPosition && positionEditor(viewport, editPosition) ||
      readingPosition && readingPosition.sessionId === sessionId && positionReading(viewport, readingPosition)) {
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
