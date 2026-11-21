export const ASSET_CLASSIFICATION_GUIDANCE = 'Use entity names and aliases for named referents such as people, places and organizations, including their original spellings and renderings. Use terms for specialized concepts and reusable translation rules. Do not record the same referent in both categories. If identical spellings have distinct meanings, identify those senses explicitly for review.'

export const ASSET_PROPOSAL_GUIDE = [
  ASSET_CLASSIFICATION_GUIDANCE,
  'Propose one rendering for one term concept. A fact is a reusable source-supported statement; keep its conditions and uncertainty. A relation connects specific entities, including how one addresses another. General style and honorific policy belong in other_memory when the user requests a reusable setting. Keep one-off wording in the translation itself.',
  'Before submitting, compare candidate names and aliases across this batch and the topic’s existing terminology and entities. Check existing pending entries too when a label might overlap. Use the original wording and context to distinguish senses; defer unresolved clashes for human review.',
  'Submit one batch with translation_submit_proposals for the latest completed reviewed revision, after any corrections. Use the recorded unit target and revisionId, and exact unique source quotes. Candidates are pending adoption. Report the returned count and any conflicts or skipped entries.',
].join('\n')

interface EntityLabels { readonly name: string; readonly aliases: readonly string[] }
const normalize = (value: string): string => value.normalize('NFC').trim().replace(/\s+/gu, ' ')
/** Exact labels only: semantic classification belongs to the preparation/review model. */
export function namesEntity(sourceForms: readonly string[], preferred: string, entities: readonly EntityLabels[]): boolean {
  const forms = [...sourceForms, preferred].map(normalize)
  return entities.some(entity => [entity.name, ...entity.aliases].some(name => forms.includes(normalize(name))))
}
