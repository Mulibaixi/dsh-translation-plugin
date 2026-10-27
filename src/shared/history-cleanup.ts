import type { TranslationSourceScope } from './translation-sources.js'
import type { HistoryScope } from './history-bundle.js'
import { referenceExact, referenceObject, referenceInteger } from './reference-memory.js'

/** Only resource identities survive a business deletion; no source, request or translation text. */
export interface HistoryCleanup {
  readonly scope: HistoryScope
  readonly unitId: string
  /** Topic-wide cleanup uses sessionId/unitId '*'; legacy file metadata also needs its owner. */
  readonly topicOwnerId?: string
  readonly sources: readonly { readonly sourceId: string; readonly sha256: string }[]
  readonly references: readonly { readonly scope: TranslationSourceScope; readonly referenceKey: string }[]
  /** File translation versions; whole-unit cleanup omits all version lists. */
  readonly resultVersions?: readonly number[]
  /** Exact document view identities, e.g. source:1:manifest:<id>. */
  readonly revisionIds?: readonly string[]
  /** Old sources; release their resources without clearing current-source tasks. */
  readonly sourceVersions?: readonly number[]
}
export interface HistoryCleanupResult { readonly complete: boolean; readonly removed: number; readonly retained: number }
export function parseHistoryCleanupResult(value: unknown): HistoryCleanupResult {
  referenceObject(value); referenceExact(value, ['complete', 'removed', 'retained'])
  if (typeof value.complete !== 'boolean') throw new TypeError('Invalid cleanup result')
  referenceInteger(value.removed); referenceInteger(value.retained); return value as unknown as HistoryCleanupResult
}
export function sourceReferenceKey(reference: HistoryCleanup['references'][number]): string {
  const scope = reference.scope
  return JSON.stringify([scope.namespaceId ?? null, scope.ownerId, scope.mainSessionId, scope.topicId, scope.translationSessionId, reference.referenceKey])
}
export function mergeHistoryCleanup(previous: HistoryCleanup | undefined, next: HistoryCleanup): HistoryCleanup {
  if (!previous) return next
  const partial = (task: HistoryCleanup): boolean => !!(task.resultVersions || task.revisionIds || task.sourceVersions)
  const sources = [...new Map([...previous.sources, ...next.sources].map(source => [JSON.stringify(source), source])).values()]
  const references = [...new Map([...previous.references, ...next.references].map(reference => [sourceReferenceKey(reference), reference])).values()]
  return { scope: next.scope, unitId: next.unitId, ...(next.topicOwnerId ?? previous.topicOwnerId ? { topicOwnerId: next.topicOwnerId ?? previous.topicOwnerId } : {}), sources, references, ...(partial(previous) && partial(next) ? {
    ...(previous.resultVersions || next.resultVersions ? { resultVersions: [...new Set([...previous.resultVersions ?? [], ...next.resultVersions ?? []])] } : {}),
    ...(previous.revisionIds || next.revisionIds ? { revisionIds: [...new Set([...previous.revisionIds ?? [], ...next.revisionIds ?? []])] } : {}),
    ...(previous.sourceVersions || next.sourceVersions ? { sourceVersions: [...new Set([...previous.sourceVersions ?? [], ...next.sourceVersions ?? []])] } : {}),
  } : {}) }
}
