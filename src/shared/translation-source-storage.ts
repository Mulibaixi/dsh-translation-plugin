import { MAX_TRANSLATION_SOURCE_BYTES, parseSourceIdentity, parseTranslationSourceAsset, parseTranslationSourceScope,
  type SourceIdentity, type TranslationSourceAsset, type TranslationSourceScope } from './translation-sources.js'
import { sourceCodePointLength } from './translation-source-read.js'

export interface TranslationSourceStorageCapability {
  readonly ready: boolean
  readonly storage: 'saved' | 'runtime_only'
  readonly nativeOpen: boolean
  readonly referenceProtocol: 1
  readonly maxBytes: number
  readonly reason?: string
}
export interface TranslationSourcePrepareSave {
  readonly namespaceId?: string
  readonly scope: TranslationSourceScope
  readonly sourceRef: TranslationSourceAsset
  readonly referenceKey: string
  readonly operationId: string
}
export interface TranslationSourceConfirmReference {
  readonly namespaceId?: string
  readonly scope: TranslationSourceScope
  readonly referenceKey: string
  readonly prepareToken: string
  readonly historyToken: string
  readonly operationId: string
}
export interface TranslationSourceQueryReference { readonly namespaceId?: string; readonly scope: TranslationSourceScope; readonly referenceKey: string }
export interface TranslationSourceStoredRead extends TranslationSourceQueryReference {
  readonly source: SourceIdentity
  readonly historyToken: string
}
export interface TranslationSourceReleaseReference extends TranslationSourceQueryReference {
  readonly expectedVersion: number
  readonly operationId: string
}
/** The byte copy remains saved after release; only confirmed references authorize access. */
export interface TranslationSourceReference extends TranslationSourceQueryReference {
  readonly source: SourceIdentity
  readonly prepareToken: string
  readonly referenceVersion: number
  readonly storage: 'saved'
  readonly state: 'prepared' | 'confirmed' | 'released'
  readonly historyToken: string | null
}
export interface TranslationSourceRestored extends TranslationSourceQueryReference {
  readonly source: TranslationSourceAsset
  readonly referenceVersion: number
  readonly storage: 'saved'
  readonly state: 'confirmed'
}
const errors = ['invalid_input', 'scope_mismatch', 'unavailable', 'not_found', 'idempotency_conflict', 'stale_version',
  'reference_unconfirmed', 'reference_released', 'token_mismatch', 'source_missing', 'source_corrupt', 'storage_failed', 'open_failed'] as const
export type TranslationSourceStorageErrorCode = typeof errors[number]
export type TranslationSourceStorageResult<T> = { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: TranslationSourceStorageErrorCode; readonly message: string; readonly stage: string } }
export interface TranslationSourceStoragePort {
  storageCapabilities(): Promise<TranslationSourceStorageResult<TranslationSourceStorageCapability>>
  prepareSave(request: TranslationSourcePrepareSave): Promise<TranslationSourceStorageResult<TranslationSourceReference>>
  confirmReference(request: TranslationSourceConfirmReference): Promise<TranslationSourceStorageResult<TranslationSourceReference>>
  queryReference(request: TranslationSourceQueryReference): Promise<TranslationSourceStorageResult<TranslationSourceReference>>
  restore(request: TranslationSourceStoredRead): Promise<TranslationSourceStorageResult<TranslationSourceRestored>>
  openOriginal(request: TranslationSourceStoredRead, signal: AbortSignal): Promise<TranslationSourceStorageResult<{ readonly opened: true }>>
  releaseReference(request: TranslationSourceReleaseReference): Promise<TranslationSourceStorageResult<TranslationSourceReference>>
}
export const TRANSLATION_SOURCE_STORAGE_METHODS = ['storageCapabilities', 'prepareSave', 'confirmReference', 'queryReference', 'restore', 'openOriginal', 'releaseReference'] as const
export type TranslationSourceStorageMethod = typeof TRANSLATION_SOURCE_STORAGE_METHODS[number]
export type TranslationSourceStorageRequest = TranslationSourcePrepareSave | TranslationSourceConfirmReference | TranslationSourceQueryReference
  | TranslationSourceStoredRead | TranslationSourceReleaseReference
type Data = Record<string, unknown>
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('Unexpected source storage fields')
}
function text(value: unknown, maximum = 256): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || sourceCodePointLength(value) > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError('Invalid source storage identity')
}
function version(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError('Invalid reference version')
}
function token(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^source-prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value)) throw new TypeError('Invalid source prepare token')
}
export function parseTranslationSourceStorageRequest(method: Exclude<TranslationSourceStorageMethod, 'storageCapabilities'>, value: unknown): TranslationSourceStorageRequest {
  const extra = method === 'prepareSave' ? ['sourceRef', 'operationId'] : method === 'confirmReference' ? ['prepareToken', 'historyToken', 'operationId']
    : method === 'restore' || method === 'openOriginal' ? ['source', 'historyToken'] : method === 'releaseReference' ? ['expectedVersion', 'operationId'] : []
  exact(value, ['scope', 'referenceKey', ...extra], ['namespaceId'])
  if (value.namespaceId !== undefined) text(value.namespaceId)
  const scope = parseTranslationSourceScope(value.scope); text(value.referenceKey)
  const base = { scope, referenceKey: value.referenceKey, ...(value.namespaceId === undefined ? {} : { namespaceId: value.namespaceId as string }) }
  if (method === 'prepareSave') { text(value.operationId); return { ...base, sourceRef: parseTranslationSourceAsset(value.sourceRef), operationId: value.operationId } }
  if (method === 'confirmReference') {
    token(value.prepareToken); text(value.historyToken); text(value.operationId)
    return { ...base, prepareToken: value.prepareToken, historyToken: value.historyToken, operationId: value.operationId }
  }
  if (method === 'restore' || method === 'openOriginal') { text(value.historyToken); return { ...base, source: parseSourceIdentity(value.source), historyToken: value.historyToken } }
  if (method === 'releaseReference') { version(value.expectedVersion); text(value.operationId); return { ...base, expectedVersion: value.expectedVersion, operationId: value.operationId } }
  return base
}
export function parseTranslationSourceReference(value: unknown): TranslationSourceReference {
  exact(value, ['scope', 'referenceKey', 'source', 'prepareToken', 'referenceVersion', 'storage', 'state', 'historyToken'])
  const scope = parseTranslationSourceScope(value.scope), source = parseSourceIdentity(value.source)
  text(value.referenceKey); token(value.prepareToken); version(value.referenceVersion)
  if (value.storage !== 'saved' || !['prepared', 'confirmed', 'released'].includes(value.state as string)) throw new TypeError('Invalid source storage state')
  if (value.historyToken !== null) text(value.historyToken)
  if (value.state === 'prepared' && (value.historyToken !== null || value.referenceVersion !== 1) ||
    value.state === 'confirmed' && (value.historyToken === null || value.referenceVersion !== 1) ||
    value.state === 'released' && value.referenceVersion !== 2) throw new TypeError('Invalid source reference settlement')
  return { scope, source, referenceKey: value.referenceKey, prepareToken: value.prepareToken, referenceVersion: value.referenceVersion,
    storage: 'saved', state: value.state as TranslationSourceReference['state'], historyToken: value.historyToken as string | null }
}
export function parseTranslationSourceStorageResult(method: TranslationSourceStorageMethod, value: unknown): unknown {
  exact(value, ['ok'], ['value', 'error'])
  if (value.ok === false) {
    exact(value, ['ok', 'error']); exact(value.error, ['code', 'message', 'stage'])
    if (!errors.includes(value.error.code as TranslationSourceStorageErrorCode)) throw new TypeError('Invalid source storage error')
    text(value.error.message, 1000); text(value.error.stage, 80)
  } else {
    if (value.ok !== true) throw new TypeError('Invalid source storage result')
    exact(value, ['ok', 'value'])
    if (method === 'storageCapabilities') {
      exact(value.value, ['ready', 'storage', 'nativeOpen', 'referenceProtocol', 'maxBytes'], ['reason'])
      if (typeof value.value.ready !== 'boolean' || typeof value.value.nativeOpen !== 'boolean' || value.value.referenceProtocol !== 1 ||
        value.value.maxBytes !== MAX_TRANSLATION_SOURCE_BYTES || value.value.storage !== (value.value.ready ? 'saved' : 'runtime_only') ||
        !value.value.ready && value.value.nativeOpen) throw new TypeError('Invalid source storage capability')
      if (value.value.reason !== undefined) text(value.value.reason, 1000)
    } else if (method === 'restore') {
      exact(value.value, ['scope', 'source', 'referenceKey', 'referenceVersion', 'storage', 'state'])
      parseTranslationSourceScope(value.value.scope); parseTranslationSourceAsset(value.value.source); text(value.value.referenceKey)
      if (value.value.referenceVersion !== 1 || value.value.storage !== 'saved' || value.value.state !== 'confirmed') throw new TypeError('Invalid restored source')
    } else if (method === 'openOriginal') {
      exact(value.value, ['opened']); if (value.value.opened !== true) throw new TypeError('Invalid source open result')
    } else {
      const reference = parseTranslationSourceReference(value.value)
      if (method === 'confirmReference' && reference.state !== 'confirmed' || method === 'releaseReference' && reference.state !== 'released') throw new TypeError('Invalid reference result state')
    }
  }
  return structuredClone(value)
}
export const TRANSLATION_SOURCE_STORAGE_REMOTE = {
  package: 'dsh-translation-plugin',
  descriptors: TRANSLATION_SOURCE_STORAGE_METHODS.map(method => ({
    id: `dsh-translation-plugin#translationSources/${method}`, service: 'translationSources', namespace: 'translationSources', method,
    invocation: { kind: 'direct' as const },
    parameters: method === 'storageCapabilities' ? [] : [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#source-storage-${method}-request`, create: () => ({ parse: (value: unknown) => parseTranslationSourceStorageRequest(method, value) }) } }],
    ...(method === 'openOriginal' ? { cancellation: { parameter: 'signal' } } : {}),
    result: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#source-storage-${method}-result`, create: () => ({ parse: (value: unknown) => parseTranslationSourceStorageResult(method, value) }) },
  })),
}
