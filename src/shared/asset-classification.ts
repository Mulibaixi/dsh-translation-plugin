export const ASSET_CLASSIFICATION_GUIDANCE = 'Use entity names and aliases for named referents such as people, places and organizations, including their original spellings and renderings. Use terms for specialized concepts and deliberate recurring translation decisions. Do not record the same referent in both categories. If identical spellings have distinct meanings, identify those senses explicitly for review.'

export const ASSET_PROPOSAL_GUIDE = [
  ASSET_CLASSIFICATION_GUIDANCE,
  'Propose one rendering for one term concept. A fact is a reusable source-supported statement; keep its conditions and uncertainty. A relation connects specific entities, including how one addresses another. General style and honorific policy belong in other_memory when the user requests a reusable setting. Keep routine vocabulary, compositional phrases and line-specific renderings in the translation itself. For example, デビュー決定 → 确定出道 is ordinary wording and does not need a term proposal. Confidence in a translation does not establish a reusable asset.',
  'Before submitting, compare candidate names and aliases across this batch and the topic’s existing terminology and entities. Check existing pending entries, known name components with honorifics, and mixed hiragana/katakana spellings when a label might overlap. A known surname plus an honorific uses the existing entity. A term already recorded for a named referent stays with that entry unless the user asks to reorganize it. Use the original wording and context to distinguish senses; defer unresolved clashes for human review.',
  'Submit one batch with translation_submit_proposals for the latest completed reviewed revision, after any corrections. Use the recorded unit target and revisionId, and exact unique source quotes. Candidates are pending adoption. Report the returned count and any conflicts or skipped entries.',
].join('\n')

interface EntityLabels { readonly name: string; readonly aliases: readonly string[] }
export function foldKana(value: string): string {
  return value.replace(/[ァ-ヶ]/gu, character => String.fromCharCode(character.charCodeAt(0) - 0x60))
}

function label(value: string): string {
  return foldKana(value.normalize('NFKC').trim().replace(/\s+/gu, ' '))
}

/** Compare spellings for proposal screening without changing stored labels. */
export function overlapsAssetLabels(left: readonly string[], right: readonly string[]): boolean {
  const labels = new Set(right.map(label))
  return left.some(value => labels.has(label(value)))
}

export function namesEntity(sourceForms: readonly string[], preferred: string, entities: readonly EntityLabels[]): boolean {
  const forms = [...sourceForms, preferred], names = entities.flatMap(entity => [entity.name, ...entity.aliases])
  if (overlapsAssetLabels(forms, names)) return true
  const addressedNames = sourceForms.map(form => label(form).match(/^(.+?)\s*(?:さん|ちゃん|くん|君|さま|様|先輩|先生)$/u)?.[1])
    .filter((name): name is string => !!name && Array.from(name).length >= 2)
  return addressedNames.length > 0 && overlapsAssetLabels(addressedNames, names.flatMap(name => [name, ...label(name).split(/[\s・]+/u)]))
}
