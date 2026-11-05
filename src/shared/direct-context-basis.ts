/** Content facts observed by the Client when preparing one direct call. */
export interface DirectTranslationBasis {
  readonly unitId: string
  readonly exists: boolean
  readonly sourceVersion: number
  readonly revisionId: string | null
  readonly final: { readonly revisionId: string; readonly selection: 'automatic' | 'user_fixed' } | null
}

function object(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))) throw new TypeError('Invalid direct translation basis')
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new TypeError('Invalid direct translation basis identity')
}
export function parseDirectTranslationBasis(value: unknown): DirectTranslationBasis {
  object(value, ['unitId', 'exists', 'sourceVersion', 'revisionId', 'final'])
  id(value.unitId)
  if (typeof value.exists !== 'boolean' || !Number.isSafeInteger(value.sourceVersion) || (value.sourceVersion as number) < 1) throw new TypeError('Invalid direct translation basis state')
  if (value.revisionId !== null) id(value.revisionId)
  if (value.final !== null) {
    object(value.final, ['revisionId', 'selection']); id(value.final.revisionId)
    if (value.final.selection !== 'automatic' && value.final.selection !== 'user_fixed') throw new TypeError('Invalid direct translation final selection')
  }
  if (!value.exists && (value.revisionId !== null || value.final !== null)) throw new TypeError('Missing direct translation unit has a revision')
  return structuredClone(value) as unknown as DirectTranslationBasis
}
