import type { TermEvidenceRef } from '../memory/topic-terms.js'
import { documentSourceLength } from '../shared/translation-batch.js'
import { currentDocumentFinalRevision, isDocumentUnit } from './translation-history.js'
import type { SessionStore } from './session-store.js'

/** Metadata can establish a stale reference without pretending its body has been loaded. */
export function isDocumentEvidenceUnloaded(sessions: SessionStore, scope: { readonly ownerId: string; readonly topicId: string }, ref: TermEvidenceRef): boolean {
  const session = sessions.getSession(ref.sessionId), history = sessions.getTranslationHistory(ref.sessionId)
  if (!session || session.ownerId !== scope.ownerId || session.topicId !== scope.topicId || sessions.isSessionDeleted(session.id) || sessions.getStatus(session.id) === 'conflict') return false
  const unit = history?.units.find(unit => unit.id === ref.unitId)
  if (!unit || !isDocumentUnit(unit)) return false
  if (ref.kind === 'source') {
    const source = unit.sourceVersions.find(source => source.version === unit.sourceVersion)
    return !!source && (ref.sourceVersion ?? 1) === unit.sourceVersion && (ref.range === null || ref.range.end <= documentSourceLength(source))
  }
  const final = currentDocumentFinalRevision(unit), event = [...history!.events].reverse().find(event => event.type === 'final.selected' && event.unitId === unit.id)
  return !!final && final.id === ref.revisionId && final.sourceVersion === unit.sourceVersion && event?.revisionId === final.id && event.id === ref.selectionEventId
}
