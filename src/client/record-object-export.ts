import type { RecordObjectReference } from '../shared/record-objects.js'
import { currentFinalRevision, isTextUnit } from './translation-history.js'
import { projectRecordObjects } from './record-object-projection.js'
import { buildBilingualExport, buildFinalTextExport, buildTopicBilingualExport, buildTopicFinalTextExport, type TranslationExportTopic, type TranslationExportSession, type TopicTranslationExport } from './translation-export.js'

export interface RecordObjectExportRequest {
  readonly topic: TranslationExportTopic; readonly entries: readonly TranslationExportSession[]; readonly scope: 'session' | 'topic'
  readonly format: 'txt' | 'json'; readonly exportedAt: string; readonly references?: readonly RecordObjectReference[]
}
export function recordObjectPlainText(text: string, target: Parameters<typeof projectRecordObjects>[1], references: readonly RecordObjectReference[]): string {
  return projectRecordObjects(text, target, references).segments.map(segment => segment.kind === 'text' ? segment.text : `[${segment.label}]`).join('')
}
/** Frozen references decorate exports; canonical source and revision bodies stay unchanged. */
export function buildRecordObjectExport(request: RecordObjectExportRequest, allowPartial = false): TopicTranslationExport {
  if (request.scope === 'session' && request.entries.length !== 1 || request.entries.some(({ session }) => session.ownerId !== request.topic.ownerId || session.topicId !== request.topic.topicId)) throw new Error('Record object export scope mismatch')
  const refs = request.references ?? []
  const entries = request.entries
  const first = entries[0]!
  const result = request.scope === 'topic' ? (request.format === 'txt' ? buildTopicFinalTextExport : buildTopicBilingualExport)(request.topic, entries, request.exportedAt, { allowPartial }) : request.format === 'json' ? buildBilingualExport(first.session, first.history, request.exportedAt, { allowPartial }) : (() => {
    const exported = buildFinalTextExport(first.session, first.history, request.exportedAt, { allowPartial })
    return { ...exported, missingUnits: exported.missingUnits.map(unit => ({ ...unit, sessionId: first.session.id, sessionName: first.session.name, sessionSequence: first.session.sequence })) }
  })()
  if (!result.content || !refs.length) return result
  if (request.format === 'txt') {
    const texts = [...entries].sort((a, b) => a.session.sequence - b.session.sequence || a.session.id.localeCompare(b.session.id)).flatMap(({ session, history }) => [...history.units].sort((a, b) => a.order - b.order).flatMap(unit => {
      const final = currentFinalRevision(unit)
      return final ? [recordObjectPlainText(final.text, { ownerId: session.ownerId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, side: 'revision', revisionId: final.id }, refs)] : []
    }))
    return { ...result, content: texts.join('\n\n') }
  }
  const included = refs.filter(ref => entries.some(({ session, history }) => session.ownerId === ref.ownerId && session.topicId === ref.topicId && session.id === ref.sessionId && history.units.some(unit => isTextUnit(unit) && unit.id === ref.unitId && (ref.side === 'source' ? ref.revisionId === null : currentFinalRevision(unit)?.id === ref.revisionId))))
  return included.length ? { ...result, content: JSON.stringify({ ...JSON.parse(result.content), schemaVersion: 2, objectReferences: included }, null, 2) } : result
}
