// Native DOM method shapes for Pointer Events; this fixture does not render a browser DOM.
export function reorderSurface(ids) {
  const doc = new EventTarget(), view = new EventTarget(), frames = new Map()
  let nextFrame = 0
  view.requestAnimationFrame = callback => { const id = ++nextFrame; frames.set(id, callback); return id }
  view.cancelAnimationFrame = id => frames.delete(id)
  doc.defaultView = view
  const list = { scrollTop: 0, closest: () => list, getBoundingClientRect: () => ({ top: 0, bottom: 100, height: 100 }) }
  const rows = ids.map((id, index) => {
    const row = new EventTarget()
    Object.assign(row, { dataset: { sessionSortId: id }, ownerDocument: doc, closest: () => list,
      getBoundingClientRect: () => ({ top: index * 30 - list.scrollTop, bottom: index * 30 + 30 - list.scrollTop, height: 30 }),
      setPointerCapture(pointerId) { row.capture = pointerId }, hasPointerCapture(pointerId) { return row.capture === pointerId }, releasePointerCapture() { row.capture = undefined },
    })
    return row
  })
  list.querySelectorAll = () => rows
  return { doc, view, list, rows, frames, frame() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback() } }
}
export function pointer(type, y = 15, overrides = {}) {
  return Object.assign(new Event(type, { cancelable: true }), { button: 0, isPrimary: true, pointerId: 1, clientX: 10, clientY: y, ...overrides })
}
