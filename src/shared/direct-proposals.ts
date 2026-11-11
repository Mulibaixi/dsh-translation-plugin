import { parseDirectUnitRequest, type DirectUnitTarget } from './normal-translation.js'
import { referenceExact, referenceObject, referenceString } from './reference-memory.js'
import type { FileJobProposal } from './file-jobs.js'

export type DirectAssetProposal = FileJobProposal extends infer P ? P extends FileJobProposal
  ? Omit<P, 'evidence' | 'origin' | 'disposition'> & { readonly quotes: readonly string[] } : never : never
export interface DirectProposalSubmission { readonly target: DirectUnitTarget; readonly revisionId: string; readonly proposals: readonly DirectAssetProposal[] }
export interface DirectProposalReceipt { readonly count: number; readonly skipped: readonly string[]; readonly persistence: 'saved' | 'runtime_only' }

export function parseDirectProposalSubmission(value: unknown): DirectProposalSubmission {
  referenceObject(value); referenceExact(value, ['target', 'revisionId', 'proposals']); referenceString(value.revisionId)
  const target = parseDirectUnitRequest({ target: value.target, operationId: 'asset-proposal-read' }).target, revisionId = value.revisionId
  if (!Array.isArray(value.proposals) || value.proposals.length > 100) throw new TypeError('资产提案每次最多 100 条。')
  const ids = new Set<string>(), entities = new Set<string>()
  // Omitted descriptive fields have simple defaults; no second candidate schema is stored.
  value = { ...value, proposals: value.proposals.map(raw => {
    referenceObject(raw)
    return raw.kind === 'term' || raw.kind === 'relation' ? { description: '', ...raw }
      : raw.kind === 'entity' ? { aliases: [], description: '', ...raw }
        : raw.kind === 'fact' ? { entityCandidateIds: [], ...raw } : raw
  }) }
  referenceObject(value)
  const proposals = value.proposals as Record<string, unknown>[]
  for (const p of proposals) {
    referenceObject(p); referenceString(p.candidateId); if (ids.has(p.candidateId)) throw new TypeError('提案编号重复。'); ids.add(p.candidateId)
    const fields = p.kind === 'term' ? ['sourceForms', 'preferred', 'description'] : p.kind === 'entity' ? ['name', 'aliases', 'description']
      : p.kind === 'fact' ? ['title', 'body', 'entityCandidateIds'] : p.kind === 'relation' ? ['sourceEntityCandidateId', 'relation', 'targetEntityCandidateId', 'description'] : undefined
    if (!fields) throw new TypeError('未知资产提案类型。')
    try { referenceExact(p, ['kind', 'candidateId', 'quotes', ...fields]) }
    catch { throw new TypeError(`候选 ${p.candidateId}（${p.kind}）字段不正确；应为 ${['candidateId', 'kind', 'quotes', ...fields].join('、')}。事实使用 title/body，关系端点使用 entity candidateId，不使用人物名称字段。`) }
    for (const field of fields) {
      if (['sourceForms', 'aliases', 'entityCandidateIds'].includes(field)) {
        if (!Array.isArray(p[field]) || (p[field] as unknown[]).length > 100 || field === 'sourceForms' && !(p[field] as unknown[]).length) throw new TypeError('提案列表无效。')
        for (const text of p[field] as unknown[]) referenceString(text, 300)
      } else if (field !== 'description' || p[field] !== '') referenceString(p[field], ['description', 'body'].includes(field) ? 4000 : 300)
    }
    if (!Array.isArray(p.quotes) || !p.quotes.length || p.quotes.length > 10) throw new TypeError('提案需要原文依据。')
    for (const quote of p.quotes) referenceString(quote, 4000)
    if (p.kind === 'entity') entities.add(p.candidateId)
  }
  for (const p of proposals) {
    const dependencies = p.kind === 'fact' ? p.entityCandidateIds as string[] : p.kind === 'relation' ? [p.sourceEntityCandidateId as string, p.targetEntityCandidateId as string] : []
    if (dependencies.some(id => !entities.has(id))) throw new TypeError('事实或关系引用了本批次不存在的实体提案。')
  }
  return { target, revisionId, proposals: structuredClone(value.proposals) as DirectAssetProposal[] }
}
