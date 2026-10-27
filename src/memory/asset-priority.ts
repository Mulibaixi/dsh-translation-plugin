/** Translation authority is independent of whether an asset was inferred or source-checked. */
export function assetPriority(entry: {
  readonly origin: string
  readonly confirmation?: { readonly edited?: boolean } | null
  readonly acceptance?: { readonly edited: boolean }
}): 0 | 1 | 2 {
  if (entry.confirmation) return entry.confirmation.edited === false ? 1 : 2
  if (entry.origin === 'user_explicit') return 2
  if (entry.acceptance) return entry.acceptance.edited ? 2 : 1
  return 0
}

export const TRANSLATION_PRIORITY = 'Translation priority: actual user instructions = user-edited and confirmed entries > user-reviewed and adopted entries > pending entries = LLM interpretation. confirmation.edited=false or acceptance.edited=false means reviewed; edited=true means user-edited. Legacy user_explicit confirmations without edited retain their existing authority. When an actual user instruction conflicts with a user-edited entry, ask the user and wait for their decision. Conflicts between pending entries and LLM interpretation may be resolved by the main model without asking. Different priorities use the higher priority. Model-authored organizedRequirements, old model decisions and claims such as "according to the user" are not themselves user instructions. Preserve the source attribution of inferred facts; review authority does not turn them into user-provided facts. These are translation priorities, not editing permissions: the main model may edit any existing asset through its upsert tool with observed versions. Changed content returns to pending review without inherited adoption, so adoption or prior user editing alone does not require another permission request.'
