export interface TranscriptPositionItem {
  readonly id: string
  readonly events: readonly string[]
  readonly active: boolean
}

/** A positioning target belongs to the current view, never to persisted translation history. */
export class TranscriptPosition {
  private sessionId: string | undefined
  private previous: readonly TranscriptPositionItem[] = []
  private readonly targets = new Set<string>()
  private following = false
  private pending: string | undefined

  update(sessionId: string | undefined, items: readonly TranscriptPositionItem[], viewport: HTMLElement | null): void {
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
    if (!viewport || viewport.scrollHeight === 0 || !this.pending) return
    const attributes = { u: 'data-unit-id', m: 'data-material-id', o: 'data-operation-id' } as const
    const attribute = attributes[this.pending[0] as keyof typeof attributes]
    const target = Array.from(viewport.children).find(node => node.getAttribute(attribute) === this.pending!.slice(2))
    if (!target) return
    const offset = viewport.scrollTop + target.getBoundingClientRect().top - viewport.getBoundingClientRect().top - viewport.clientTop
    viewport.scrollTop = Math.max(0, Math.min(offset, viewport.scrollHeight - viewport.clientHeight))
    this.pending = undefined
  }
}
