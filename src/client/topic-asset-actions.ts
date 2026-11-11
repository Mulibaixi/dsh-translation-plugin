import type { TopicTermsViewPort } from './topic-terms-view.js'
import type { TopicMemoryStore } from './topic-memory-store.js'
import type { TopicArchiveStore } from './topic-archive-store.js'
import type { FileJobProposal } from '../shared/file-jobs.js'
import type { TopicTerm, TermEvidenceRef } from '../memory/topic-terms.js'
import type { TopicArchiveEntry, TopicArchivePut } from '../memory/topic-archive.js'
import { namesEntity } from '../shared/asset-classification.js'

const label = (s: string): string => s.normalize('NFC').trim().replace(/\s+/gu, ' ')
const overlap = (a: readonly string[], b: readonly string[]): boolean => a.some(x => b.some(y => label(x) === label(y)))
const sameIds = (a: readonly string[], b: readonly string[]): boolean => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort())
const content = (entry: TopicTerm | TopicArchiveEntry): string => JSON.stringify({ ...entry, version: null, status: null, updatedAt: null })
export type TopicAssetKind = 'terms' | TopicArchiveEntry['kind']

/** All new candidates use the ordinary four archives and remain pending human adoption. */
export async function putAssetProposals(terms: TopicMemoryStore, archive: TopicArchiveStore,
  scope: { ownerId: string; topicId: string; sessionId: string; unitId: string; sourceVersion?: number | undefined; targetLanguage: string },
  proposals: readonly FileJobProposal[], check: () => void): Promise<{ count: number; skipped: string[] }> {
  await terms.ensureLoaded(scope.ownerId, scope.topicId); await archive.ensureLoaded(scope.ownerId, scope.topicId)
  const entities = new Map<string, string>(), saved = new Set<string>(), skipped: string[] = []
  for (const p of [...proposals.filter(p => p.kind === 'entity'), ...proposals.filter(p => p.kind === 'term'), ...proposals.filter(p => p.kind === 'fact'), ...proposals.filter(p => p.kind === 'relation')]) {
    check()
    const title = p.kind === 'term' ? p.sourceForms.join('、') : p.kind === 'entity' ? p.name : p.kind === 'fact' ? p.title : p.relation
    const evidence: TermEvidenceRef[] = (scope.sourceVersion === undefined ? p.evidence.slice(0, 1) : p.evidence).map(e => ({
      kind: 'source', sessionId: scope.sessionId, unitId: scope.unitId,
      ...(scope.sourceVersion === undefined ? {} : { sourceVersion: scope.sourceVersion }),
      revisionId: null, selectionEventId: null, role: 'basis', range: scope.sourceVersion === undefined ? null : e.range,
    }))
    if (p.kind === 'term') {
      const entitiesInTopic = archive.getSnapshot(scope.ownerId, scope.topicId).entries.filter(entry => entry.kind === 'entity')
      if (namesEntity(p.sourceForms, p.preferred, entitiesInTopic)) {
        skipped.push(`${title}：匹配实体名称或别名，请在实体档案中审阅`)
        continue
      }
      const snapshot = terms.getSnapshot(scope.ownerId, scope.topicId), matches = snapshot.entries.filter(e => e.targetLanguage === scope.targetLanguage && overlap([...e.sourceForms, ...e.aliases], p.sourceForms))
      if (matches.length > 1) { skipped.push(`${title}：匹配多个既有条目`); continue }
      const old = matches[0]
      if (old && old.status !== 'proposal') { skipped.push(`${title}：保留既有${old.status === 'active' ? '生效' : '待处理'}条目`); continue }
      const result = await terms.apply(scope.ownerId, scope.topicId, snapshot.version, { kind: 'put', input: {
        id: old?.id ?? `term:${crypto.randomUUID()}`, expectedEntryVersion: old?.version ?? null, sourceLanguage: old?.sourceLanguage ?? null,
        targetLanguage: scope.targetLanguage, sourceForms: p.sourceForms, aliases: old?.aliases ?? [], sense: p.description, preferred: p.preferred,
        forbidden: old?.forbidden ?? [], evidence, origin: 'inferred', status: 'proposal' } })
      if (result.status === 'save_failed') throw new Error('术语提案保存未确认，请重新读取后重试。')
      if (['updated', 'unchanged'].includes(result.status) && result.entry) saved.add(result.entry.id)
      else skipped.push(`${title}：${result.status}`)
      continue
    }
    const snapshot = archive.getSnapshot(scope.ownerId, scope.topicId)
    const resolve = (id: string): string | undefined => entities.get(id)
    const related = p.kind === 'fact' ? p.entityCandidateIds.map(resolve) : p.kind === 'relation' ? [resolve(p.sourceEntityCandidateId), resolve(p.targetEntityCandidateId)] : []
    if (related.some(id => !id)) { skipped.push(`${title}：依赖实体未写入`); continue }
    const matches = snapshot.entries.filter(e => p.kind === 'entity' ? e.kind === 'entity' && overlap([e.name, ...e.aliases], [p.name, ...p.aliases])
      : p.kind === 'fact' ? e.kind === 'fact' && label(e.title) === label(p.title) && sameIds(e.entityIds, related as string[])
        : e.kind === 'relation' && e.sourceEntityId === related[0] && e.targetEntityId === related[1] && label(e.relation) === label(p.relation))
    if (matches.length > 1) { skipped.push(`${title}：匹配多个既有条目`); continue }
    const old = matches[0], id = old?.id ?? `archive:${crypto.randomUUID()}`
    if (p.kind === 'entity') entities.set(p.candidateId, id)
    if (old && !['proposal', 'review_required'].includes(old.status)) { skipped.push(`${title}：保留既有${old.status === 'active' ? '生效' : '待处理'}条目`); continue }
    const semantic = p.kind === 'entity' ? { kind: p.kind, name: p.name, aliases: p.aliases, description: p.description }
      : p.kind === 'fact' ? { kind: p.kind, title: p.title, body: p.body, entityIds: related as string[] }
        : { kind: p.kind, sourceEntityId: related[0]!, relation: p.relation, targetEntityId: related[1]!, description: p.description }
    const input = { ...semantic, id, expectedEntryVersion: old?.version ?? null, evidence, origin: 'inferred', status: 'proposal' } as TopicArchivePut
    const result = await archive.apply(scope.ownerId, scope.topicId, snapshot.version, { kind: 'put', input })
    if (result.status === 'save_failed') throw new Error('档案提案保存未确认，请重新读取后重试。')
    if (['updated', 'unchanged'].includes(result.status) && result.entry) saved.add(result.entry.id)
    else { if (p.kind === 'entity') entities.delete(p.candidateId); skipped.push(`${title}：${result.status}`) }
  }
  check(); return { count: saved.size, skipped }
}

/** Human action: freeze only this category; dependencies in other categories stay unchanged. */
export async function adoptTopicAssets(terms: TopicTermsViewPort, archive: TopicArchiveStore, ownerId: string, topicId: string, kind: TopicAssetKind): Promise<{ adopted: number; remaining: number }> {
  const assets = kind === 'terms' ? terms : archive, snapshot = await assets.ensureLoaded(ownerId, topicId)
  const pending = (e: TopicTerm | TopicArchiveEntry): boolean => ['proposal', 'review_required'].includes(e.status)
  const candidates = snapshot.entries.filter(e => pending(e) && (kind === 'terms' || ('kind' in e && e.kind === kind))).map(e => structuredClone(e))
  let adopted = 0
  for (const before of candidates) {
    const current = assets.getSnapshot(ownerId, topicId)
    const entry = current.entries.find(e => e.id === before.id)
    if (!entry || !pending(entry) || content(entry) !== content(before)) continue
    const command = { kind: 'adopt' as const, id: entry.id, expectedEntryVersion: entry.version }
    const result = await assets.apply(ownerId, topicId, current.version, command)
    const status = assets.getStatus(ownerId, topicId)
    if (result.status === 'save_failed' || ['error', 'conflict'].includes(status)) throw new Error(`采用后保存未确认，已完成 ${adopted} 条，请刷新核对后重试。`)
    if (['updated', 'unchanged'].includes(result.status) && result.entry?.status === 'active') adopted++
  }
  return { adopted, remaining: candidates.length - adopted }
}
