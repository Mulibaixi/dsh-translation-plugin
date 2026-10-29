import type { TermEvidenceRef } from '../memory/topic-terms.js'
import { isDocumentUnit } from './translation-history.js'
import type { SessionStore } from './session-store.js'
import { TranslationSourceReader } from './source-reader.js'

/** Metadata can establish a stale reference without pretending its body has been loaded. */
export function isDocumentEvidenceUnloaded(sessions: SessionStore, scope: { readonly ownerId: string; readonly topicId: string }, ref: TermEvidenceRef): boolean {
  const history = sessions.getTranslationHistory(ref.sessionId)
  const unit = history?.units.find(unit => unit.id === ref.unitId)
  if (!unit || !isDocumentUnit(unit)) return false
  const request = new TranslationSourceReader({ sessions, maxCachedPages: 0 }).capture(scope.ownerId, scope.topicId, ref)
  return !('status' in request) || request.status === 'unloaded' || request.status === 'forbidden'
}
