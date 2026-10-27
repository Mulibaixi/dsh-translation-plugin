import type { TopicTerm, TopicTermPut } from '../memory/topic-terms.js'
import type { PreparationFrozenTerm } from '../shared/translation-preparation.js'
import { newTermId } from '../shared/term-id.js'

export interface DocumentTermSedimentInput {
  /** Terms actually frozen in the task preparation version. */
  readonly terms: readonly PreparationFrozenTerm[]
  readonly existing: readonly TopicTerm[]
  readonly sessionId: string
  readonly unitId: string
  readonly sourceVersion: number
}

export interface DocumentTermSedimentPlan {
  readonly entries: readonly TopicTermPut[]
  readonly skipped: number
}

function sameMeaning(entry: TopicTerm, term: PreparationFrozenTerm): boolean {
  if (entry.targetLanguage !== term.targetLanguage || entry.preferred !== term.preferred) return false
  const known = [...entry.sourceForms, ...entry.aliases]
  return [...term.sourceForms, ...term.aliases].some(form => known.includes(form))
}

/**
 * Task adoption stays local; this only turns each adopted task term into one pending topic proposal.
 * Existing topic entries are never edited, and an already present meaning is skipped instead of duplicated.
 */
export function planDocumentTermSedimentation(input: DocumentTermSedimentInput,
  idFactory: () => string = newTermId): DocumentTermSedimentPlan {
  const entries: TopicTermPut[] = [], seen = new Set<string>()
  let skipped = 0
  for (const term of input.terms) {
    // Topic terms already exist in the asset, and user-fixed rules never need a proposal copy.
    if (term.ref.kind === 'topic_term' || term.userFixed || !term.sourceForms.length || !term.ranges.length) { skipped++; continue }
    const identity = JSON.stringify([term.targetLanguage, term.preferred, [...term.sourceForms].sort()])
    if (seen.has(identity) || input.existing.some(entry => sameMeaning(entry, term))) { skipped++; continue }
    seen.add(identity)
    entries.push({
      id: idFactory(), expectedEntryVersion: null,
      sourceLanguage: term.sourceLanguage, targetLanguage: term.targetLanguage,
      sourceForms: [...term.sourceForms], aliases: [...term.aliases],
      sense: term.sense, preferred: term.preferred, forbidden: [...term.forbidden],
      // The ranges are real preparation coordinates for this exact source version, never invented.
      evidence: term.ranges.slice(0, 100).map(range => ({ kind: 'source' as const, sessionId: input.sessionId, unitId: input.unitId,
        sourceVersion: input.sourceVersion, revisionId: null, selectionEventId: null, range: { start: range.start, end: range.end }, role: 'basis' as const })),
      origin: 'inferred', status: 'proposal',
    })
  }
  return { entries, skipped }
}
