/** Display preferences contain only session IDs, independently of saved history. */
export const SESSION_ORDER_PREFIX = 'dsh-translation-plugin:session-order:v1:'
export function sessionOrderKey(ownerId: string): string { return SESSION_ORDER_PREFIX + encodeURIComponent(ownerId) }
export function encodeSessionOrder(ids: readonly string[]): string { return JSON.stringify({ schemaVersion: 1, ids }) }
export function decodeSessionOrder(raw: string): readonly string[] | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (Object.keys(record).length !== 2 || record.schemaVersion !== 1 || !Array.isArray(record.ids) ||
      record.ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(record.ids).size !== record.ids.length) return undefined
    return record.ids
  } catch { return undefined }
}
export function reconcileSessionOrder(preferred: readonly string[], available: readonly string[]): readonly string[] {
  const known = new Set(available), kept = preferred.filter(id => known.has(id)), ordered = new Set(kept)
  return [...kept, ...available.filter(id => !ordered.has(id))]
}
export function moveSessionOrder(ids: readonly string[], id: string, targetId: string, after: boolean): readonly string[] {
  if (id === targetId || !ids.includes(id) || !ids.includes(targetId)) return ids
  const next = ids.filter(value => value !== id)
  next.splice(next.indexOf(targetId) + (after ? 1 : 0), 0, id)
  return next
}
