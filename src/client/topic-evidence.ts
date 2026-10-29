import { isFileJobUnit } from './translation-history.js'
import { resolveTermEvidence, termEvidenceKey, type TermEvidenceRef, type TermEvidenceResolver } from '../memory/topic-terms.js'
import type { EvidenceReadRequest, EvidenceReadResult } from '../shared/translation-evidence.js'
import { TranslationSourceReader, type TranslationEvidenceReader } from './source-reader.js'
import type { SessionStore } from './session-store.js'
import { isDocumentEvidenceUnloaded } from './document-evidence.js'
import { isTextUnit } from './translation-history.js'

type Scope = { readonly ownerId: string; readonly topicId: string }
function requestKey(request: EvidenceReadRequest | null): string {
  return JSON.stringify(request && [request.ownerId, request.topicId, request.sessionId, request.unitId, request.sourceVersion,
    request.side, request.revisionId, request.selectionEventId, request.range?.start ?? null, request.range?.end ?? null])
}
function captureKey(value: EvidenceReadRequest | Exclude<EvidenceReadResult, { readonly status: 'ready' }>): string {
  return 'status' in value ? JSON.stringify([value.status, requestKey(value.request), value.reason, value.totalCodePoints ?? null]) : requestKey(value)
}
/** Compare immutable facts without serializing or copying their authoritative body strings. */
function sameFact(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null || Array.isArray(left) !== Array.isArray(right)) return false
  const leftFields = left as Record<string, unknown>, rightFields = right as Record<string, unknown>, keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(rightFields, key) && sameFact(leftFields[key], rightFields[key]))
}
function referencedFacts(sessions: SessionStore, ref: TermEvidenceRef): unknown {
  const history = sessions.getTranslationHistory(ref.sessionId), unit = history?.units.find(unit => unit.id === ref.unitId)
  if (unit && isFileJobUnit(unit)) return { sourceVersion: unit.sourceVersion }
  const source = unit?.sourceVersions.find(source => source.version === unit.sourceVersion)
  if (ref.kind === 'source') return { sourceVersion: unit?.sourceVersion, source }
  const revision = unit?.revisions.find(revision => revision.id === ref.revisionId)
  let selectionEventId: string | undefined
  for (let index = (history?.events.length ?? 0) - 1; index >= 0; index--) {
    const event = history!.events[index]!
    if (event.type === 'final.selected' && event.unitId === ref.unitId) { selectionEventId = event.id; break }
  }
  const chunks = unit && !isTextUnit(unit) && revision && 'entries' in revision ?
    revision.entries.map(entry => unit.chunkRevisions.find(chunk => chunk.id === entry.revisionId)) : []
  return { sourceVersion: unit?.sourceVersion, source, final: unit?.final, revision, selectionEventId, chunks }
}
/** Reconciliation uses already resolved evidence; unrelated session notifications are not changes. */
export function captureTopicEvidenceCurrent(sessions: SessionStore, scope: Scope, refs: readonly TermEvidenceRef[], resolver: TermEvidenceResolver): () => boolean {
  const captured = refs.map(ref => ({ ref, facts: structuredClone(referencedFacts(sessions, ref)), text: resolveTermEvidence(scope, ref, resolver), unloaded: isTopicEvidenceUnloaded(sessions, scope, ref) }))
  return () => captured.every(value => sameFact(value.facts, referencedFacts(sessions, value.ref)) && value.text === resolveTermEvidence(scope, value.ref, resolver) && value.unloaded === isTopicEvidenceUnloaded(sessions, scope, value.ref))
}
export interface PreparedTopicEvidence {
  readonly resolver: TermEvidenceResolver
  readonly isUnloaded: (ref: TermEvidenceRef) => boolean
  /** Synchronous validation for the structure lock; this never reads remote content. */
  readonly isCurrent: () => boolean
}

/** An authorization/structure conflict is not evidence that the original content is gone. */
export function isTopicEvidenceUnloaded(sessions: SessionStore, scope: Scope, ref: TermEvidenceRef): boolean {
  const session = sessions.getSession(ref.sessionId)
  return !!session && (session.topicId !== scope.topicId ||
    sessions.getStatus(session.id) === 'conflict') || isDocumentEvidenceUnloaded(sessions, scope, ref)
}

function matchingReady(request: EvidenceReadRequest, value: EvidenceReadResult): boolean {
  if (value.status !== 'ready' || requestKey(value.request) !== requestKey(request) || value.sourceVersion !== request.sourceVersion ||
    value.manifestRevisionId !== (request.side === 'final' ? request.revisionId : null) ||
    !Number.isSafeInteger(value.totalCodePoints) || value.totalCodePoints < 0 || !Number.isSafeInteger(value.range.start) ||
    !Number.isSafeInteger(value.range.end) || value.range.start < 0 || value.range.end < value.range.start || value.range.end > value.totalCodePoints) return false
  const range = request.range ?? { start: 0, end: value.totalCodePoints }
  return value.range.start === range.start && value.range.end === range.end &&
    Array.from(value.text).length === range.end - range.start && range.end - range.start <= 4000 &&
    new TextEncoder().encode(JSON.stringify({ ok: true, value })).byteLength <= 32768
}

/** Freeze every identity before starting I/O, then expose only exact resolved references to pure domain code. */
export async function prepareTopicEvidence(sessions: SessionStore, scope: Scope, refs: readonly TermEvidenceRef[],
  fallback: TermEvidenceResolver, reader?: TranslationEvidenceReader): Promise<PreparedTopicEvidence> {
  if (!reader) {
    const isUnloaded = (ref: TermEvidenceRef): boolean => isTopicEvidenceUnloaded(sessions, scope, ref)
    const resolver: TermEvidenceResolver = Object.assign((sessionId: string, unitId: string) => fallback(sessionId, unitId), {
      ...(fallback.resolveRef ? { resolveRef: fallback.resolveRef } : {}),
      isUnloaded: (requestedScope: Scope, ref: TermEvidenceRef) => requestedScope.ownerId === scope.ownerId && requestedScope.topicId === scope.topicId && isUnloaded(ref),
    })
    return { resolver, isUnloaded, isCurrent: () => true }
  }
  reader ??= new TranslationSourceReader({sessions})
  const unique = [...new Map(refs.map(ref => [termEvidenceKey(scope, ref), structuredClone(ref)])).values()]
  const captures = unique.map(ref => {
    const unit = sessions.getTranslationHistory(ref.sessionId)?.units.find(unit => unit.id === ref.unitId)
    return { ref, captured: reader.capture(scope.ownerId, scope.topicId, ref), inline: !!unit && isTextUnit(unit),
      facts: referencedFacts(sessions, ref) }
  })
  const results = new Map<string, EvidenceReadResult>()
  const inline = new Set(captures.filter(value => value.inline && !('status' in value.captured)).map(value => termEvidenceKey(scope, value.ref)))
  for (const { ref, captured, inline } of captures) {
    // Existing authoritative text bodies require no remote paging, including legacy whole refs over one page.
    if (inline && !('status' in captured)) continue
    let result: EvidenceReadResult
    if ('status' in captured) result = captured
    else {
      try { result = await reader.read(captured) }
      catch { result = { status: 'unloaded', request: captured, reason: 'transport_unavailable' } }
      if (result.status === 'ready' && !matchingReady(captured, result)) result = { status: 'unloaded', request: captured, reason: 'invalid_evidence_reply' }
    }
    results.set(termEvidenceKey(scope, ref), result)
  }
  const isUnloaded = (ref: TermEvidenceRef): boolean => {
    const key = termEvidenceKey(scope, ref)
    if (inline.has(key)) return isTopicEvidenceUnloaded(sessions, scope, ref)
    const result = results.get(key); return !result || result.status === 'unloaded' || result.status === 'forbidden'
  }
  const resolver: TermEvidenceResolver = Object.assign((sessionId: string, unitId: string) => fallback(sessionId, unitId), {
    resolveRef: (requestedScope: Scope, ref: TermEvidenceRef): string | undefined => {
      const key = termEvidenceKey(requestedScope, ref)
      if (inline.has(key)) return resolveTermEvidence(requestedScope, ref, fallback)
      const result = results.get(key)
      return result?.status === 'ready' ? result.text : undefined
    },
    isUnloaded: (requestedScope: Scope, ref: TermEvidenceRef) => requestedScope.ownerId === scope.ownerId && requestedScope.topicId === scope.topicId && isUnloaded(ref),
  })
  return { resolver, isUnloaded,
    isCurrent: () => captures.every(({ ref, captured, facts }) => {
      const current = reader.capture(scope.ownerId, scope.topicId, ref)
      return sameFact(referencedFacts(sessions, ref), facts) && captureKey(current) === captureKey(captured) &&
        ('status' in captured || reader.isCurrent(captured))
    }),
  }
}
