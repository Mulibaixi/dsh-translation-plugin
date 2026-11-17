export const SESSION_REORDER_HOLD_MS = 400
const MOVE_TOLERANCE = 6
export interface SessionDrop { readonly id: string; readonly targetId: string; readonly after: boolean }
export type SessionPointerEvent = Pick<PointerEvent, 'button' | 'isPrimary' | 'pointerId' | 'clientX' | 'clientY'> & { readonly currentTarget: HTMLElement }

/** Pointer capture starts only after the hold, preserving ordinary scrolling. */
export function createSessionReorder(onPreview: (drop: SessionDrop | undefined) => void, onCommit: (drop: SessionDrop) => void,
  listKind: 'session' | 'asset' = 'session',
): {
  down(id: string, event: SessionPointerEvent): void
  consumeClick(id: string): boolean
  cancel(): void
  dispose(): void
} {
  let pending: { id: string; source: HTMLElement; list: HTMLElement; scroll: HTMLElement; pointerId: number; x: number; y: number; timer: ReturnType<typeof setTimeout>; frame: number | undefined; active: boolean; drop: SessionDrop | undefined } | undefined
  let suppressedId: string | undefined
  let clickTimer: ReturnType<typeof setTimeout> | undefined

  function scrollFrame(): void {
    if (!pending?.active) return
    const { scroll, y } = pending, rect = scroll.getBoundingClientRect(), edge = Math.min(28, rect.height / 3)
    const step = y < rect.top + edge ? -Math.min(7, (rect.top + edge - y) / 4)
      : y > rect.bottom - edge ? Math.min(7, (y - rect.bottom + edge) / 4) : 0
    if (step) { scroll.scrollTop += step; preview(y) }
    pending.frame = pending.source.ownerDocument.defaultView?.requestAnimationFrame(scrollFrame)
  }

  function preview(y: number): void {
    if (!pending?.active) return
    const all = [...pending.list.querySelectorAll<HTMLElement>(`[data-${listKind}-sort-id]`)]
    const from = all.indexOf(pending.source)
    const rows = all.filter(row => row !== pending!.source)
    const before = rows.find(row => { const rect = row.getBoundingClientRect(); return y < rect.top + rect.height / 2 })
    const target = before ?? rows.at(-1)
    const targetId = listKind === 'session' ? target?.dataset.sessionSortId : target?.dataset.assetSortId
    const to = before ? rows.indexOf(before) : rows.length
    const drop = targetId && from >= 0 && from !== to ? { id: pending.id, targetId, after: !before } : undefined
    if (drop?.targetId === pending.drop?.targetId && drop?.after === pending.drop?.after) return
    pending.drop = drop; onPreview(drop ?? { id: pending.id, targetId: pending.id, after: false })
  }
  function finish(commit = false, notify = true): void {
    const drag = pending
    if (!drag) return
    pending = undefined; clearTimeout(drag.timer)
    const doc = drag.source.ownerDocument
    doc.removeEventListener('pointermove', move, true)
    doc.removeEventListener('pointerup', up, true)
    doc.removeEventListener('pointercancel', cancel, true)
    doc.removeEventListener('scroll', scrolled, true)
    doc.removeEventListener('keydown', keydown, true)
    doc.defaultView?.removeEventListener('blur', cancel)
    if (drag.frame !== undefined) doc.defaultView?.cancelAnimationFrame(drag.frame)
    drag.source.removeEventListener('lostpointercapture', cancel)
    if (drag.active) {
      if (drag.source.hasPointerCapture(drag.pointerId)) drag.source.releasePointerCapture(drag.pointerId)
      suppressedId = drag.id
      clearTimeout(clickTimer)
      clickTimer = setTimeout(() => { suppressedId = undefined }, 0)
      if (notify) onPreview(undefined)
      if (commit && drag.drop) onCommit(drag.drop)
    }
  }
  function cancel(): void { finish() }
  function scrolled(): void { if (pending?.active) preview(pending.y); else finish() }
  function keydown(event: KeyboardEvent): void { if (event.key === 'Escape') finish() }
  function move(event: PointerEvent): void {
    if (!pending || event.pointerId !== pending.pointerId) return
    if (!pending.active) {
      if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > MOVE_TOLERANCE) finish()
      return
    }
    pending.y = event.clientY
    event.preventDefault(); event.stopPropagation(); preview(event.clientY)
    pending.frame ??= pending.source.ownerDocument.defaultView?.requestAnimationFrame(scrollFrame)
  }
  function up(event: PointerEvent): void {
    if (!pending || event.pointerId !== pending.pointerId) return
    if (pending.active) { event.preventDefault(); event.stopPropagation(); preview(event.clientY) }
    finish(true)
  }
  return {
    down(id, event) {
      finish()
      if (event.button !== 0 || !event.isPrimary) return
      const source = event.currentTarget, pointerId = event.pointerId, list = source.closest<HTMLElement>(`[data-${listKind}-sort-list]`)
      if (!list) return
      const timer = setTimeout(() => {
        if (!pending) return
        try { source.setPointerCapture(pointerId) } catch { finish(); return }
        pending.active = true; onPreview({ id, targetId: id, after: false })
        preview(pending.y)
      }, SESSION_REORDER_HOLD_MS)
      const scroll = listKind === 'session' ? list.closest<HTMLElement>('.dsh-tp-popup, .dsh-tp-session-sidebar') ?? list : list
      pending = { id, source, list, scroll, pointerId, x: event.clientX, y: event.clientY, timer, frame: undefined, active: false, drop: undefined }
      const doc = source.ownerDocument
      doc.addEventListener('pointermove', move, { capture: true, passive: false })
      doc.addEventListener('pointerup', up, true)
      doc.addEventListener('pointercancel', cancel, true)
      doc.addEventListener('scroll', scrolled, true)
      doc.addEventListener('keydown', keydown, true)
      doc.defaultView?.addEventListener('blur', cancel)
      source.addEventListener('lostpointercapture', cancel)
    },
    consumeClick(id) {
      if (suppressedId !== id) return false
      suppressedId = undefined; clearTimeout(clickTimer); return true
    },
    cancel,
    dispose() { finish(false, false); clearTimeout(clickTimer); suppressedId = undefined },
  }
}
