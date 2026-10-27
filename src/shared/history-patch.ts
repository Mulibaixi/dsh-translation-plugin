import { splitHistoryBundle, joinHistoryBundle, type HistoryBundle, type HistoryPart, type HistoryScope } from './history-bundle.js'
import type { LocalSession } from './sessions.js'

/** The directory contains labels and settings, never draft or translation bodies. */
export function historySessionMetadata(session: LocalSession): LocalSession {
  return { ...session, input: '', legacyManualText: '', instruction: '' }
}
const identity = (part: Pick<HistoryPart, 'kind' | 'parent' | 'id'>): string => JSON.stringify([part.kind, part.parent, part.id])
export interface HistoryPatch { readonly header: string | null; readonly upsert: readonly HistoryPart[]; readonly remove: readonly string[] }
export function diffHistoryBundle(before: HistoryBundle, next: HistoryBundle): HistoryPatch {
  const a = splitHistoryBundle(before), b = splitHistoryBundle(next), old = new Map(a.parts.map(part => [identity(part), part]))
  const wanted = new Set(b.parts.map(identity))
  return { header: a.header === b.header ? null : b.header,
    upsert: b.parts.filter(part => { const prior = old.get(identity(part)); return !prior || prior.position !== part.position || prior.payload !== part.payload }),
    remove: [...old.keys()].filter(id => !wanted.has(id)) }
}
export function applyHistoryPatch(before: HistoryBundle, value: unknown, scope: HistoryScope): HistoryBundle {
  const patch = value as HistoryPatch
  if (!patch || Object.keys(patch).sort().join(',') !== 'header,remove,upsert' || !(patch.header === null || typeof patch.header === 'string') || !Array.isArray(patch.upsert) || !Array.isArray(patch.remove)) throw new TypeError('Invalid history patch')
  const split = splitHistoryBundle(before), parts = new Map(split.parts.map(part => [identity(part), part])), touched = new Set<string>()
  for (const id of patch.remove) { if (typeof id !== 'string' || !parts.delete(id) || touched.has(id)) throw new TypeError('Invalid removed history part'); touched.add(id) }
  for (const part of patch.upsert) {
    if (!part || Object.keys(part).sort().join(',') !== 'id,kind,parent,payload,position' || ['id', 'kind', 'parent', 'payload'].some(field => typeof (part as any)[field] !== 'string') || !Number.isSafeInteger(part.position) || part.position < 0) throw new TypeError('Invalid changed history part')
    const id = identity(part); if (touched.has(id)) throw new TypeError('Duplicate history patch part'); touched.add(id); parts.set(id, part)
  }
  return joinHistoryBundle(patch.header ?? split.header, [...parts.values()], scope, 'current')
}
