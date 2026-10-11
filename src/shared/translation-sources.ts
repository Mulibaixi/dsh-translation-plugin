import { MAX_TRANSLATION_SOURCE_PAGE_BYTES, MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, sourceCodePointLength,
  type TranslationSourceRange } from './translation-source-read.js'

export const MAX_TRANSLATION_SOURCE_BYTES = 2 * 1024 * 1024

/** Fixed source storage scope; it does not create a translation unit or a history row. */
export interface TranslationSourceScope {
  readonly ownerId: string
  readonly mainSessionId: string
  readonly topicId: string
  readonly translationSessionId: string
}
export interface TranslationSourceImport {
  readonly scope: TranslationSourceScope
  readonly receiptId: string
  readonly idempotencyKey: string
}
export interface SourceIdentity {
  /** Opaque identity of this immutable source asset, not a native attachment or host path. */
  readonly sourceId: string
  /** Asset version, independent of a future material sourceVersion. Corrections use a new asset. */
  readonly version: 1
  readonly name: string
  readonly bytes: number
  readonly totalCodePoints: number
  readonly encoding: 'utf-8'
  readonly bom: boolean
  readonly sha256: string
}
export interface TranslationSourceAsset extends SourceIdentity { readonly persistence: 'runtime_only' }
export interface TranslationSourceAssetRead {
  readonly scope: TranslationSourceScope
  readonly sourceId: string
  readonly version: number
  readonly range: TranslationSourceRange
}
export interface TranslationSourceAssetPage {
  readonly scope: TranslationSourceScope
  readonly source: TranslationSourceAsset
  readonly range: TranslationSourceRange
  readonly text: string
}
export interface TranslationSourceCapability {
  readonly ready: boolean
  readonly storage: 'runtime_only'
  readonly encoding: 'utf-8'
  readonly maxBytes: number
  readonly maxPageCodePoints: number
  readonly maxPageBytes: number
  readonly reason?: string
}
const errors = ['invalid_input', 'scope_mismatch', 'unavailable', 'receipt_not_found', 'idempotency_conflict', 'unsupported_file',
  'source_too_large', 'integrity_failed', 'invalid_utf8', 'empty_source', 'not_found', 'stale_version', 'invalid_range',
  'range_out_of_bounds', 'page_too_large'] as const
export type TranslationSourceErrorCode = typeof errors[number]
export type TranslationSourceResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: TranslationSourceErrorCode; readonly message: string; readonly stage: string } }
export interface TranslationSourcesPort {
  capabilities(): Promise<TranslationSourceResult<TranslationSourceCapability>>
  importReceipt(request: TranslationSourceImport, signal: AbortSignal): Promise<TranslationSourceResult<TranslationSourceAsset>>
  readRange(request: TranslationSourceAssetRead): Promise<TranslationSourceResult<TranslationSourceAssetPage>>
}

type Data = Record<string, unknown>
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('Unexpected source fields')
}
function text(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || sourceCodePointLength(value) > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Invalid source identity')
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new TypeError('Invalid source number')
}
const scopeFields = ['ownerId', 'mainSessionId', 'topicId', 'translationSessionId'] as const
export function parseTranslationSourceScope(value: unknown): TranslationSourceScope {
  exact(value, scopeFields)
  text(value.ownerId, 1000); text(value.mainSessionId, 1000); text(value.topicId, 3000); text(value.translationSessionId, 2048)
  if (value.ownerId !== value.mainSessionId) throw new TypeError('Source requires its own main Session')
  return { ownerId: value.ownerId, mainSessionId: value.mainSessionId, topicId: value.topicId, translationSessionId: value.translationSessionId }
}
function sourceId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^source-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value)) throw new TypeError('Invalid source asset identity')
}
export function parseSourceIdentity(value: unknown): SourceIdentity {
  exact(value, ['sourceId', 'version', 'name', 'bytes', 'totalCodePoints', 'encoding', 'bom', 'sha256'])
  sourceId(value.sourceId); text(value.name, 255)
  if (/[\\/<>:"|?*]/u.test(value.name) || !/\.txt$/iu.test(value.name)) throw new TypeError('Invalid TXT file name')
  integer(value.bytes, 1, MAX_TRANSLATION_SOURCE_BYTES); integer(value.totalCodePoints, 1, value.bytes)
  if (value.version !== 1 || value.encoding !== 'utf-8' || typeof value.bom !== 'boolean' ||
    typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sha256)) throw new TypeError('Invalid immutable source descriptor')
  return { sourceId: value.sourceId, version: value.version, name: value.name, bytes: value.bytes, totalCodePoints: value.totalCodePoints,
    encoding: value.encoding, bom: value.bom, sha256: value.sha256 }
}
export function toSourceIdentity(value: TranslationSourceAsset): SourceIdentity {
  const { persistence, ...identity } = value
  if (persistence !== 'runtime_only') throw new TypeError('Invalid runtime source persistence')
  return parseSourceIdentity(identity)
}
export function parseTranslationSourceAsset(value: unknown): TranslationSourceAsset {
  exact(value, ['sourceId', 'version', 'name', 'bytes', 'totalCodePoints', 'encoding', 'bom', 'sha256', 'persistence'])
  if (value.persistence !== 'runtime_only') throw new TypeError('Invalid runtime source persistence')
  return { ...toSourceIdentity(value as unknown as TranslationSourceAsset), persistence: 'runtime_only' }
}
export function parseTranslationSourceRequest(method: 'importReceipt' | 'readRange', value: unknown): TranslationSourceImport | TranslationSourceAssetRead {
  if (method === 'importReceipt') {
    exact(value, ['scope', 'receiptId', 'idempotencyKey']); const scope = parseTranslationSourceScope(value.scope)
    text(value.receiptId, 256); text(value.idempotencyKey, 256)
    return { scope, receiptId: value.receiptId, idempotencyKey: value.idempotencyKey }
  }
  exact(value, ['scope', 'sourceId', 'version', 'range']); const scope = parseTranslationSourceScope(value.scope)
  sourceId(value.sourceId); integer(value.version, 1); exact(value.range, ['start', 'end'])
  if (!Number.isSafeInteger(value.range.start) || !Number.isSafeInteger(value.range.end) || (value.range.start as number) < 0 ||
    (value.range.end as number) <= (value.range.start as number)) throw Object.assign(new TypeError('Invalid Unicode source range [start, end)'), { code: 'invalid_range' })
  return { scope, sourceId: value.sourceId, version: value.version, range: { start: value.range.start as number, end: value.range.end as number } }
}
/** Includes the unary Gateway RemoteResult wrapper and this service's business result. */
export function translationSourceResultBytes(result: unknown): number {
  return new TextEncoder().encode(JSON.stringify({ ok: true, value: result })).byteLength
}
const methods = ['capabilities', 'importReceipt', 'readRange'] as const
export function parseTranslationSourceResult(method: typeof methods[number], value: unknown): unknown {
  exact(value, ['ok'], ['value', 'error'])
  if (value.ok === false) {
    exact(value, ['ok', 'error']); exact(value.error, ['code', 'message', 'stage'])
    if (!errors.includes(value.error.code as TranslationSourceErrorCode)) throw new TypeError('Invalid source error')
    text(value.error.message, 1000); text(value.error.stage, 80)
  } else {
    if (value.ok !== true) throw new TypeError('Invalid source result')
    exact(value, ['ok', 'value'])
    if (method === 'capabilities') {
      exact(value.value, ['ready', 'storage', 'encoding', 'maxBytes', 'maxPageCodePoints', 'maxPageBytes'], ['reason'])
      if (typeof value.value.ready !== 'boolean' || value.value.storage !== 'runtime_only' || value.value.encoding !== 'utf-8' ||
        value.value.maxBytes !== MAX_TRANSLATION_SOURCE_BYTES || value.value.maxPageCodePoints !== MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS ||
        value.value.maxPageBytes !== MAX_TRANSLATION_SOURCE_PAGE_BYTES) throw new TypeError('Invalid source capability')
      if (value.value.reason !== undefined) text(value.value.reason, 1000)
    } else if (method === 'importReceipt') parseTranslationSourceAsset(value.value)
    else {
      exact(value.value, ['scope', 'source', 'range', 'text']); parseTranslationSourceScope(value.value.scope)
      const asset = parseTranslationSourceAsset(value.value.source)
      const request = parseTranslationSourceRequest('readRange', { scope: value.value.scope, sourceId: asset.sourceId, version: asset.version, range: value.value.range }) as TranslationSourceAssetRead
      if (typeof value.value.text !== 'string' || request.range.end > asset.totalCodePoints || request.range.end - request.range.start > MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS ||
        sourceCodePointLength(value.value.text) !== request.range.end - request.range.start || translationSourceResultBytes(value) > MAX_TRANSLATION_SOURCE_PAGE_BYTES) throw new TypeError('Invalid source page or byte budget')
    }
  }
  return structuredClone(value)
}
export const TRANSLATION_SOURCES_REMOTE = {
  package: 'dsh-translation-plugin',
  descriptors: methods.map(method => ({
    id: `dsh-translation-plugin#translationSources/${method}`, service: 'translationSources', namespace: 'translationSources', method,
    invocation: { kind: 'direct' as const },
    parameters: method === 'capabilities' ? [] : [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#source-${method}-request`, create: () => ({ parse: (value: unknown) => parseTranslationSourceRequest(method, value) }) } }],
    ...(method === 'importReceipt' ? { cancellation: { parameter: 'signal' } } : {}),
    result: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#source-${method}-result`, create: () => ({ parse: (value: unknown) => parseTranslationSourceResult(method, value) }) },
  })),
}
