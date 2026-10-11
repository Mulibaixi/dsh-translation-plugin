import { parseTranslationSourceRequest, parseTranslationSourceResult, type TranslationSourceAssetRead,
  type TranslationSourceResult } from './translation-sources.js'

/** Hash the exact range's UTF-8 text. A BOM is never added to or removed from that text. */
export interface TranslationSourceRangeHash extends TranslationSourceAssetRead { readonly sha256: string }
export interface TranslationSourceIntegrityPort {
  verifyRangeHash(request: TranslationSourceRangeHash): Promise<TranslationSourceResult<{ readonly verified: true }>>
}
export function parseTranslationSourceRangeHash(value: unknown): TranslationSourceRangeHash {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid source range hash request')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).length !== 5 || !['scope', 'sourceId', 'version', 'range', 'sha256'].every(key => Object.hasOwn(raw, key)) ||
    typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(raw.sha256)) throw new TypeError('Invalid source range hash fields')
  const request = parseTranslationSourceRequest('readRange', { scope: raw.scope, sourceId: raw.sourceId, version: raw.version, range: raw.range }) as TranslationSourceAssetRead
  return { ...request, sha256: raw.sha256 }
}
export function parseTranslationSourceRangeHashResult(value: unknown): TranslationSourceResult<{ readonly verified: true }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid source range hash result')
  const raw = value as Record<string, unknown>
  if (raw.ok === false) return parseTranslationSourceResult('readRange', value) as TranslationSourceResult<{ readonly verified: true }>
  const result = raw.value as Record<string, unknown> | null
  if (Object.keys(raw).length !== 2 || !Object.hasOwn(raw, 'ok') || !Object.hasOwn(raw, 'value') || raw.ok !== true ||
    !result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 || result.verified !== true) throw new TypeError('Invalid source range hash acknowledgment')
  return { ok: true, value: { verified: true } }
}
export const TRANSLATION_SOURCE_INTEGRITY_REMOTE = {
  package: 'dsh-translation-plugin',
  descriptors: [{
    id: 'dsh-translation-plugin#translationSources/verifyRangeHash', service: 'translationSources', namespace: 'translationSources', method: 'verifyRangeHash',
    invocation: { kind: 'direct' as const },
    parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: { mode: 'strict' as const,
      typeSymbol: 'dsh-translation-plugin#source-range-hash-request', create: () => ({ parse: parseTranslationSourceRangeHash }) } }],
    result: { mode: 'strict' as const, typeSymbol: 'dsh-translation-plugin#source-range-hash-result', create: () => ({ parse: parseTranslationSourceRangeHashResult }) },
  }],
}
