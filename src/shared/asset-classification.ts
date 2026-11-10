export const ASSET_CLASSIFICATION_GUIDANCE = 'Use entity names and aliases for named referents such as people, places and organizations, including their original spellings and renderings. Use terms for specialized concepts and reusable translation rules. Do not record the same referent in both categories. If identical spellings have distinct meanings, identify those senses explicitly for review.'

interface EntityLabels { readonly name: string; readonly aliases: readonly string[] }
const normalize = (value: string): string => value.normalize('NFC').trim().replace(/\s+/gu, ' ')
/** Exact labels only: semantic classification belongs to the preparation/review model. */
export function namesEntity(sourceForms: readonly string[], preferred: string, entities: readonly EntityLabels[]): boolean {
  const forms = [...sourceForms, preferred].map(normalize)
  return entities.some(entity => [entity.name, ...entity.aliases].some(name => forms.includes(normalize(name))))
}
