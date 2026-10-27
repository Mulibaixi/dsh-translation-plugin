import type { HistoryBundle, HistoryScope } from '../shared/history-bundle.js'
import { isDocumentUnit, isDeletedUnit } from '../memory/translation-history.js'
import { sourceReferenceKey, type HistoryCleanup } from '../shared/history-cleanup.js'
import type { SourceIdentity } from '../shared/translation-sources.js'

export function historyTargetMatches(scope: HistoryScope, unitId: string, target: unknown, sourceVersion?: number): boolean {
  const raw = target as { scope?: object } | undefined
  const value = raw && { ...raw.scope, ...raw } as { namespaceId?: string; topicId?: string; translationSessionId?: string; unitId?: string; materialId?: string; sourceVersion?: number }
  return !!value && (sourceVersion === undefined || value.sourceVersion === sourceVersion) && (value.namespaceId === undefined || value.namespaceId === scope.namespaceId) && (scope.sessionId === '*' ? value.topicId === scope.topicId && !!value.translationSessionId : (value.topicId === undefined || value.topicId === scope.topicId) && value.translationSessionId === scope.sessionId) && (unitId === '*' || value.unitId === unitId || value.materialId !== undefined && `unit:${value.materialId}` === unitId)
}

export function historyResources(bundles: readonly HistoryBundle[], scope: HistoryScope, unitId?: string): HistoryCleanup {
  const sources = new Map<string, HistoryCleanup['sources'][number]>(), references = new Map<string, HistoryCleanup['references'][number]>()
  const source = (value: SourceIdentity | undefined): void => { if (value) sources.set(value.sourceId, { sourceId: value.sourceId, sha256: value.sha256 }) }
  const reference = (value: HistoryCleanup['references'][number] | undefined): void => { if (value) references.set(sourceReferenceKey(value), { scope: value.scope, referenceKey: value.referenceKey }) }
  for (const bundle of bundles) {
    for (const unit of bundle.history.units) if ((!unitId || unit.id === unitId) && !isDeletedUnit(unit) && isDocumentUnit(unit)) {
      for (const version of unit.sourceVersions) if (!version.deletion) { if (version.body.kind === 'asset') source(version.body.reference); reference(version.historyCommit?.reference) }
    }
    for (const intake of bundle.intakes) if (!unitId || intake.unitId === unitId) { source(intake.source); reference(intake.historyCommit?.reference) }
    for (const job of bundle.fileJobs) if ((!unitId || job.summary.unitId === unitId) && !job.sources.some(source => source.version === job.summary.sourceVersion && source.deletion)) { source(job.summary.sourceRef); source(job.summary.sourceOrigin?.source); reference(job.summary.sourceOrigin) }
  }
  return { scope, unitId: unitId ?? '*', sources: [...sources.values()], references: [...references.values()] }
}
