import { languageMatches } from '../shared/language-tag.js'
import type { FileJobProposal } from '../shared/file-jobs.js'
import type { TopicTerm, TermEvidenceRef } from '../memory/topic-terms.js'
import type { TopicArchiveEntry } from '../memory/topic-archive.js'
import type { FileJobRecord } from './file-jobs-store.js'
import { namesEntity } from '../shared/asset-classification.js'

export type FileProposalReview =
  | { readonly kind: 'new' }
  | { readonly kind: 'update'; readonly entry: TopicTerm | TopicArchiveEntry }
  | { readonly kind: 'blocked'; readonly message: string }
export type FileProposalReviews = Readonly<Record<string, FileProposalReview>>
// Preserve case: case folding can merge distinct symbols and proper names.
const label = (value: string): string => value.normalize('NFC').trim().replace(/\s+/gu, ' ')
const overlap = (left: readonly string[], right: readonly string[]): boolean => left.some(a => right.some(b => label(a) === label(b)))
const idsEqual = (left: readonly string[], right: readonly string[]): boolean => JSON.stringify([...new Set(left)].sort()) === JSON.stringify([...new Set(right)].sort())

/** Topic-scoped identity, separate from candidate IDs and mutable descriptions. No fuzzy semantic merging. */
export function reviewFileProposals(record: FileJobRecord, terms: readonly TopicTerm[], archive: readonly TopicArchiveEntry[]): FileProposalReviews {
  const reviews: Record<string, FileProposalReview> = Object.create(null)
  const choose = (entries: readonly (TopicTerm | TopicArchiveEntry)[]): FileProposalReview => entries.length > 1
    ? { kind: 'blocked', message: '匹配到多个既有条目，请编辑名称或提交意见，尚未新增或覆盖。' }
    : entries[0]?.status === 'disabled' ? { kind: 'blocked', message: '匹配的既有条目已停用，请先在主题资料中核对，尚未新增或启用。' }
      : entries[0] ? { kind: 'update', entry: structuredClone(entries[0]) } : { kind: 'new' }
  const current = record.proposals.map(proposal => record.cards.find(card => card.candidateId === proposal.candidateId)?.draft ?? proposal)
  const entities = [...archive.filter(entry => entry.kind === 'entity'), ...current.filter(proposal => proposal.kind === 'entity')]
  for (const proposal of current) {
    if (proposal.kind === 'term') reviews[proposal.candidateId] = namesEntity(proposal.sourceForms, proposal.preferred, entities)
      ? { kind: 'blocked', message: '此名称已有对应实体，人物等实体名称不重复采纳为术语档案。请审阅实体条目。' }
      : choose(terms.filter(entry => languageMatches(entry.targetLanguage, record.summary.targetLanguage) && overlap([...entry.sourceForms, ...entry.aliases], proposal.sourceForms)))
    else if (proposal.kind === 'entity') reviews[proposal.candidateId] = choose(archive.filter(entry => entry.kind === 'entity' &&
      overlap([entry.name, ...entry.aliases], [proposal.name, ...proposal.aliases])))
  }
  const entity = (candidateId: string): string => {
    const adopted = record.cards.find(card => card.candidateId === candidateId)
    if (adopted?.status === 'adopted' && adopted.assetId) return adopted.assetId
    const review = reviews[candidateId]
    return review?.kind === 'update' ? review.entry.id : `candidate:${candidateId}`
  }
  for (const proposal of current) {
    if (proposal.kind === 'fact') reviews[proposal.candidateId] = choose(archive.filter(entry => entry.kind === 'fact' &&
      label(entry.title) === label(proposal.title) && idsEqual(entry.entityIds, proposal.entityCandidateIds.map(entity))))
    else if (proposal.kind === 'relation') reviews[proposal.candidateId] = choose(archive.filter(entry => entry.kind === 'relation' &&
      entry.sourceEntityId === entity(proposal.sourceEntityCandidateId) && entry.targetEntityId === entity(proposal.targetEntityCandidateId) && label(entry.relation) === label(proposal.relation)))
  }
  return reviews
}

export function proposalPreviousContent(entry: TopicTerm | TopicArchiveEntry): string {
  return 'sourceForms' in entry ? `${entry.sourceForms.join('、')} → ${entry.preferred}\n${entry.sense}`
    : entry.kind === 'entity' ? `${entry.name}${entry.aliases.length ? `（${entry.aliases.join('、')}）` : ''}\n${entry.description}`
      : entry.kind === 'fact' ? `${entry.title}\n${entry.body}` : `${entry.relation}\n${entry.description}`
}

/** A new revision uses its new source basis; older references remain examples within the schema limit. */
export function fileRevisionEvidence(evidence: readonly TermEvidenceRef[], old: readonly TermEvidenceRef[], origin: FileJobProposal['origin']): readonly TermEvidenceRef[] {
  const result = [...evidence]
  for (const ref of [...old].reverse()) {
    if (result.length >= 100) break
    const example = { ...ref, role: 'example' as const }
    if (!result.some(value => JSON.stringify({ ...value, role: 'example' }) === JSON.stringify(example))) result.push(example)
  }
  return result
}
