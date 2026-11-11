import { parseTranslationSourceStorageRequest, parseTranslationSourceStorageResult, type TranslationSourceStoredRead,
  type TranslationSourceStorageResult } from './translation-source-storage.js'
import { imageFileFormat, MAX_IMAGE_ORIGINAL_BYTES } from './image-translation.js'
import { sourceCodePointLength } from './translation-source-read.js'

/** Saved-history proof grants read access only; it cannot admit material or mutate its source. */
export interface LibrarySourceRequest {
  readonly stored: TranslationSourceStoredRead
  readonly namespaceId: string
  readonly prepareToken: string
  readonly action: 'page' | 'verify' | 'open' | 'image'
  readonly range?: { readonly start: number; readonly end: number }
  readonly sha256?: string
}
export type LibrarySourceValue = { readonly kind: 'page'; readonly text: string } | { readonly kind: 'verified' } | { readonly kind: 'opened' } | { readonly kind: 'image'; readonly base64: string }
export interface LibrarySourcesPort {
  readLibrarySource(request: LibrarySourceRequest, signal?: AbortSignal): Promise<TranslationSourceStorageResult<LibrarySourceValue>>
}
export function parseLibrarySourceRequest(raw: unknown): LibrarySourceRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid library source request')
  const value = raw as Record<string, unknown>, action = value.action
  const fields = ['stored', 'namespaceId', 'prepareToken', 'action', ...(action === 'page' || action === 'verify' ? ['range'] : []), ...(action === 'verify' ? ['sha256'] : [])]
  if (!['page', 'verify', 'open', 'image'].includes(String(action)) || fields.length !== Object.keys(value).length || fields.some(key => !Object.hasOwn(value, key)) ||
    typeof value.namespaceId !== 'string' || !value.namespaceId.trim() || value.namespaceId.length > 2048 || /[\u0000-\u001f\u007f]/u.test(value.namespaceId) ||
    typeof value.prepareToken !== 'string' || !/^source-prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value.prepareToken)) throw new TypeError('Invalid library source proof')
  const stored = parseTranslationSourceStorageRequest('restore', value.stored) as TranslationSourceStoredRead
  if (action === 'image' && (stored.source.encoding !== 'binary' || !imageFileFormat(stored.source.name))) throw new TypeError('Invalid library image')
  if (action === 'page' || action === 'verify') {
    const range = value.range as LibrarySourceRequest['range']
    if (!range || Object.keys(range).length !== 2 || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > stored.source.totalCodePoints ||
      action === 'page' && range.end - range.start > 4000) throw new TypeError('Invalid library source range')
  }
  if (action === 'verify' && (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sha256))) throw new TypeError('Invalid library source hash')
  return structuredClone({ ...value, stored }) as unknown as LibrarySourceRequest
}
export function parseLibrarySourceResult(raw: unknown): TranslationSourceStorageResult<LibrarySourceValue> {
  const value = raw as { ok?: unknown; value?: LibrarySourceValue }
  if (value?.ok === false) return parseTranslationSourceStorageResult('openOriginal', raw) as TranslationSourceStorageResult<LibrarySourceValue>
  if (!value || value.ok !== true || Object.keys(value).length !== 2 || !value.value || typeof value.value !== 'object') throw new TypeError('Invalid library source result')
  const result = value.value
  if (result.kind === 'page') {
    if (Object.keys(result).length !== 2 || typeof result.text !== 'string' || sourceCodePointLength(result.text) > 4000 || new TextEncoder().encode(result.text).byteLength > 32000) throw new TypeError('Invalid library source page')
  } else if (result.kind === 'image') {
    if (Object.keys(result).length !== 2 || typeof result.base64 !== 'string' || result.base64.length > Math.ceil(MAX_IMAGE_ORIGINAL_BYTES / 3) * 4) throw new TypeError('Invalid library image result')
  } else if (!['verified', 'opened'].includes(result.kind) || Object.keys(result).length !== 1) throw new TypeError('Invalid library source acknowledgment')
  return structuredClone(value) as TranslationSourceStorageResult<LibrarySourceValue>
}
export const LIBRARY_SOURCES_REMOTE = {
  package: 'dsh-translation-plugin',
  descriptors: [{ id: 'dsh-translation-plugin#translationSources/readLibrarySource', service: 'translationSources', namespace: 'translationSources', method: 'readLibrarySource',
    invocation: { kind: 'direct' as const }, cancellation: { parameter: 'signal' },
    parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: { mode: 'strict' as const,
      typeSymbol: 'dsh-translation-plugin#library-source-request', create: () => ({ parse: parseLibrarySourceRequest }) } }],
    result: { mode: 'strict' as const, typeSymbol: 'dsh-translation-plugin#library-source-result', create: () => ({ parse: parseLibrarySourceResult }) },
  }],
}
