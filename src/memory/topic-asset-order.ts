import type { TopicAssetMove } from '../shared/topic-asset-move.js'

type AssetEntry = { readonly id: string; readonly kind?: string }

/** Reorder only the matching category, retaining the slots of other categories. */
export function moveTopicAsset<S extends { readonly entries: readonly AssetEntry[]; readonly version: number; readonly updatedAt: string }>(
  snapshot: S, move: TopicAssetMove, at: string,
): { readonly status: 'updated' | 'unchanged' | 'stale' | 'invalid'; readonly snapshot: S; readonly entry: null } {
  const source = snapshot.entries.find(entry => entry.id === move.id)
  const target = snapshot.entries.find(entry => entry.id === move.targetId)
  if (!source || !target) return { status: 'stale', snapshot, entry: null }
  if (source.kind !== target.kind) return { status: 'invalid', snapshot, entry: null }
  if (source === target) return { status: 'unchanged', snapshot, entry: null }
  const category = snapshot.entries.filter(entry => entry.kind === source.kind)
  const from = category.indexOf(source)
  category.splice(from, 1)
  const to = category.indexOf(target) + Number(move.after)
  if (from === to) return { status: 'unchanged', snapshot, entry: null }
  category.splice(to, 0, source)
  let index = 0
  const entries = snapshot.entries.map(entry => entry.kind === source.kind ? category[index++]! : entry)
  return { status: 'updated', snapshot: { ...snapshot, entries, version: snapshot.version + 1, updatedAt: at }, entry: null }
}
