import { documentSourceLength, type DocumentUnit } from '../shared/translation-batch.js'
import type { VersionDeletion } from '../shared/version-deletion.js'
import { currentDocumentFinal, parseDocumentUnit } from './document-task.js'

/** Live manifests, edit bases and approved reuse retain their exact chunk identities. */
export function documentOrphanChunks(unit: DocumentUnit): readonly string[] {
  if (unit.deletion) return []
  const held = new Set(unit.revisions.filter(revision => !revision.deletion).flatMap(revision => revision.entries.map(entry => entry.revisionId)))
  for (const chunk of unit.chunkRevisions) if (!chunk.deletion && chunk.manualBase) held.add(chunk.manualBase.revisionId)
  for (const approval of unit.reuseApprovals ?? []) held.add(approval.reuseRef.revisionId)
  return unit.chunkRevisions.filter(chunk => !chunk.deletion && !held.has(chunk.id)).map(chunk => chunk.id)
}
export function documentChunkCleanupBlockedReason(unit: DocumentUnit): string | undefined {
  if (unit.deletion) return '此单元已删除。'
  if (unit.tasks.some(task => ['running', 'paused', 'waiting_context', 'waiting_user', 'unknown'].includes(task.status)) || unit.chunkRevisions.some(chunk => !chunk.deletion && ['running', 'unknown'].includes(chunk.status))) return '此文档仍有未结算任务，请先结束或查询。'
  if (!documentOrphanChunks(unit).length) return '没有可清理的未采用翻译块。'
  return undefined
}
export function deleteDocumentChunks(unit: DocumentUnit, ids: readonly string[], deletion: VersionDeletion): DocumentUnit {
  const blocked = documentChunkCleanupBlockedReason(unit), available = new Set(documentOrphanChunks(unit))
  if (blocked || !ids.length || ids.some(id => !available.has(id))) throw new Error(blocked ?? '翻译块仍被保留版本、人工修订或复用许可使用。')
  return parseDocumentUnit({ ...unit, chunkRevisions: unit.chunkRevisions.map(chunk => ids.includes(chunk.id) ? { ...chunk, deletion, content: chunk.content.kind === 'text' ? { kind: 'text', text: '' } : chunk.content } : chunk) })
}

export function documentRevisionDeletionBlockedReason(unit: DocumentUnit, revisionId: string): string | undefined {
  const target = unit.revisions.find(revision => revision.id === revisionId)
  if (!target || target.deletion || unit.deletion) return '此文档版本已删除或不存在。'
  if (currentDocumentFinal(unit)?.id === revisionId) return '当前最终译文不能删除，请先选择其他最终版本。'
  if (unit.revisions.at(-1)?.id === revisionId) return '最新文档版本不能删除。'
  if (unit.tasks.some(task => ['running', 'paused', 'waiting_context', 'waiting_user', 'unknown'].includes(task.status)) || unit.chunkRevisions.some(chunk => !chunk.deletion && ['running', 'unknown'].includes(chunk.status))) return '此文档仍有未结算任务，请先结束或查询。'
  if (unit.revisions.some(revision => !revision.deletion && revision.parentRevisionId === revisionId) || unit.chunkRevisions.some(chunk => !chunk.deletion && chunk.manualBase?.manifestRevisionId === revisionId)) return '此版本仍是保留修订或复核的基础，请先处理依赖它的版本。'
  return undefined
}
/** Manifest and call identities remain; only chunks without another live consumer lose text. */
export function deleteDocumentRevision(unit: DocumentUnit, revisionId: string, deletion: VersionDeletion): DocumentUnit {
  const blocked = documentRevisionDeletionBlockedReason(unit, revisionId)
  if (blocked) throw new Error(blocked)
  const target = unit.revisions.find(revision => revision.id === revisionId)!, retained = unit.revisions.filter(revision => revision.id !== revisionId && !revision.deletion)
  const held = new Set(retained.flatMap(revision => revision.entries.map(entry => entry.revisionId)))
  const pending = [...held]
  while (pending.length) {
    const id = pending.pop(), chunk = unit.chunkRevisions.find(chunk => chunk.id === id)
    if (chunk?.manualBase && !held.has(chunk.manualBase.revisionId)) { held.add(chunk.manualBase.revisionId); pending.push(chunk.manualBase.revisionId) }
  }
  const released = new Set(target.entries.map(entry => entry.revisionId).filter(id => !held.has(id)))
  const auditDeleted = (audit: NonNullable<DocumentUnit['reviewAudits']>[number]): boolean => audit.reviewedRevisionId === revisionId || audit.manifestRevisionId === revisionId && !retained.some(revision => revision.reviewAuditId === audit.id)
  return parseDocumentUnit({ ...unit,
    revisions: unit.revisions.map(revision => revision.id === revisionId ? { ...revision, deletion, review: { ...revision.review, issues: [] }, eligibility: { ...revision.eligibility, finalEligible: false } } : revision),
    chunkRevisions: unit.chunkRevisions.map(chunk => !chunk.deletion && released.has(chunk.id) ? { ...chunk, deletion, content: chunk.content.kind === 'text' ? { kind: 'text', text: '' } : chunk.content } : chunk),
    reviewAudits: unit.reviewAudits?.map(audit => !audit.deletion && auditDeleted(audit) ? { ...audit, deletion, mechanical: { ...audit.mechanical, issues: [], criticalIssues: [], suspicions: [] }, semantic: { ...audit.semantic, issues: [], resolvedIssues: [], summary: '' } } : audit),
    final: unit.final?.revisionId === revisionId ? null : unit.final,
  })
}

export function documentSourceDeletionBlockedReason(unit: DocumentUnit, version: number): string | undefined {
  const source = unit.sourceVersions.find(source => source.version === version)
  if (!source || source.deletion || unit.deletion) return '此旧原稿已删除或不存在。'
  if (version === unit.sourceVersion) return '当前原稿不能删除。'
  if (unit.tasks.some(task => ['running', 'paused', 'waiting_context', 'waiting_user', 'unknown'].includes(task.status)) || unit.chunkRevisions.some(chunk => !chunk.deletion && ['running', 'unknown'].includes(chunk.status))) return '此文档仍有未结算任务，请先结束或查询。'
  const needed = (id: string): boolean => {
    const chunk = unit.chunkRevisions.find(chunk => chunk.id === id)
    return !!chunk && (chunk.sourceVersion === version || chunk.content.kind === 'source_copy' && chunk.content.sourceVersion === version)
  }
  if (unit.revisions.some(revision => !revision.deletion && revision.sourceVersion !== version && revision.entries.some(entry => needed(entry.revisionId))) || unit.chunkRevisions.some(chunk => !chunk.deletion && chunk.sourceVersion !== version && chunk.content.kind === 'source_copy' && chunk.content.sourceVersion === version)) return '其他原稿的保留译文仍在复用此原稿或翻译块，暂不能删除。'
  return undefined
}
/** An old source owns its obsolete translations; current shared dependencies are checked first. */
export function deleteDocumentSource(unit: DocumentUnit, version: number, deletion: VersionDeletion): DocumentUnit {
  const blocked = documentSourceDeletionBlockedReason(unit, version)
  if (blocked) throw new Error(blocked)
  const source = unit.sourceVersions.find(source => source.version === version)!, revisions = new Set(unit.revisions.filter(revision => revision.sourceVersion === version).map(revision => revision.id))
  return parseDocumentUnit({ ...unit,
    sourceVersions: unit.sourceVersions.map(value => { if (value.version !== version) return value; const { historyCommit: _commit, ...metadata } = value
      return { ...metadata, body: value.body.kind === 'inline' ? { kind: 'inline', text: '' } : value.body, deletion: { ...deletion, totalCodePoints: documentSourceLength(value) } } }),
    revisions: unit.revisions.map(revision => revision.sourceVersion === version && !revision.deletion ? { ...revision, deletion, review: { ...revision.review, issues: [] }, eligibility: { ...revision.eligibility, finalEligible: false } } : revision),
    chunkRevisions: unit.chunkRevisions.map(chunk => chunk.sourceVersion === version && !chunk.deletion ? { ...chunk, deletion, content: chunk.content.kind === 'text' ? { kind: 'text', text: '' } : chunk.content } : chunk),
    reviewAudits: unit.reviewAudits?.map(audit => audit.sourceVersion === version && !audit.deletion ? { ...audit, deletion, mechanical: { ...audit.mechanical, issues: [], criticalIssues: [], suspicions: [] }, semantic: { ...audit.semantic, issues: [], resolvedIssues: [], summary: '' } } : audit),
    tasks: unit.tasks.map(task => { if (task.sourceVersion !== version || !task.executionFacts) return task
      const { supplements: _supplements, ...facts } = task.executionFacts; return { ...task, executionFacts: { ...facts, reviewIssues: [] } } }),
    reuseApprovals: unit.reuseApprovals?.filter(approval => approval.sourceVersion !== version && approval.reuseRef.sourceVersion !== version),
    final: unit.final && revisions.has(unit.final.revisionId) ? null : unit.final,
  })
}
