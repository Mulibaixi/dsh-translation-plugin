interface EntityLabels { readonly name: string; readonly aliases: readonly string[] }
const normalize = (value: string): string => value.normalize('NFC').trim().replace(/\s+/gu, ' ')
/** Exact labels only: semantic classification belongs to the preparation/review model. */
export function namesEntity(sourceForms: readonly string[], preferred: string, entities: readonly EntityLabels[]): boolean {
  const forms = [...sourceForms, preferred].map(normalize)
  return entities.some(entity => [entity.name, ...entity.aliases].some(name => forms.includes(normalize(name))))
}
