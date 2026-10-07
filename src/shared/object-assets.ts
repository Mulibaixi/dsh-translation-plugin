/** Browser-safe identities for managed original files. Paths and DSH file references stay on Host. */
export type ObjectAssetKind = 'image' | 'table' | 'code' | 'formula' | 'document'
export interface ObjectAssetVersion {
  readonly objectId: string
  readonly assetId: string
  readonly version: 1
  readonly kind: ObjectAssetKind
  readonly name: string
  readonly bytes: number
}
export interface ObjectAssetRegistration extends ObjectAssetVersion { readonly persistence: 'saved' }
export interface ObjectAssetCapability { readonly ready: boolean; readonly nativeOpen: boolean; readonly reason?: string }
export interface ObjectAssetRegister {
  readonly ownerId: string
  readonly topicId: string
  readonly translationSessionId: string
  readonly unitId: string
  readonly side: 'source' | 'revision'
  readonly revisionId: string | null
  /** Unicode code-point insertion offset, validated against the canonical body by Client. */
  readonly offset: number
  readonly kind: ObjectAssetKind
  readonly receiptId: string
  readonly existingObjectId?: string
}
export interface ObjectAssetOpen { readonly ownerId: string; readonly topicId: string; readonly objectId: string; readonly assetId: string; readonly version: number }
export type ObjectAssetErrorCode = 'invalid_input' | 'scope_mismatch' | 'unavailable' | 'receipt_not_found' | 'not_found' | 'storage_failed' | 'integrity_failed' | 'open_failed'
export type ObjectAssetResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: ObjectAssetErrorCode; readonly message: string } }
export interface ObjectAssetPort {
  capabilities(): Promise<ObjectAssetResult<ObjectAssetCapability>>
  register(request: ObjectAssetRegister, signal: AbortSignal): Promise<ObjectAssetResult<ObjectAssetRegistration>>
  open(request: ObjectAssetOpen, signal: AbortSignal): Promise<ObjectAssetResult<{ readonly opened: true }>>
}

type Data = Record<string, unknown>
export const OBJECT_ASSET_KINDS: readonly ObjectAssetKind[] = ['image', 'table', 'code', 'formula', 'document']
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
function record(value: unknown): asserts value is Data { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected object') }
function exact(value: Data, fields: readonly string[]): void { if (Object.keys(value).some(key => !fields.includes(key))) throw new TypeError('Unexpected field') }
function text(value: unknown, limit = 2048): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f]/u.test(value)) throw new TypeError('Invalid text') }
function integer(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError('Invalid integer') }
function id(value: unknown, prefix: 'object' | 'asset'): asserts value is string { if (typeof value !== 'string' || !new RegExp(`^${prefix}-${uuid}$`, 'u').test(value)) throw new TypeError('Invalid identity') }
function kind(value: unknown): asserts value is ObjectAssetKind { if (!OBJECT_ASSET_KINDS.includes(value as ObjectAssetKind)) throw new TypeError('Invalid object kind') }
function asset(value: Data): void {
  id(value.objectId, 'object'); id(value.assetId, 'asset'); kind(value.kind); integer(value.bytes)
  if (value.version !== 1) throw new TypeError('Unsupported asset version')
  text(value.name, 255)
  if (/[\\/<>:"|?*\u007f]/u.test(value.name) || value.name === '.' || value.name === '..') throw new TypeError('Invalid file name')
}
export function parseObjectAssetVersion(value: unknown): ObjectAssetVersion {
  record(value); exact(value, ['objectId', 'assetId', 'version', 'kind', 'name', 'bytes']); asset(value)
  return structuredClone(value) as unknown as ObjectAssetVersion
}
export function parseObjectAssetRequest(method: 'register' | 'open', value: unknown): ObjectAssetRegister | ObjectAssetOpen {
  record(value); text(value.ownerId); text(value.topicId)
  if (method === 'register') {
    exact(value, ['ownerId', 'topicId', 'translationSessionId', 'unitId', 'side', 'revisionId', 'offset', 'kind', 'receiptId', 'existingObjectId'])
    text(value.translationSessionId); text(value.unitId); text(value.receiptId, 256); integer(value.offset); kind(value.kind)
    if (value.side !== 'source' && value.side !== 'revision' || value.side === 'source' && value.revisionId !== null) throw new TypeError('Invalid placement')
    if (value.side === 'revision') text(value.revisionId)
    if (value.existingObjectId !== undefined) id(value.existingObjectId, 'object')
  } else {
    exact(value, ['ownerId', 'topicId', 'objectId', 'assetId', 'version']); id(value.objectId, 'object'); id(value.assetId, 'asset'); integer(value.version)
    if (value.version < 1) throw new TypeError('Invalid version')
  }
  return structuredClone(value) as unknown as ObjectAssetRegister | ObjectAssetOpen
}
const methods = ['capabilities', 'register', 'open'] as const
export function parseObjectAssetResult(method: typeof methods[number], value: unknown): unknown {
  record(value)
  if (value.ok === false) {
    exact(value, ['ok', 'error']); record(value.error); exact(value.error, ['code', 'message']); text(value.error.message, 1000)
    if (!['invalid_input', 'scope_mismatch', 'unavailable', 'receipt_not_found', 'not_found', 'storage_failed', 'integrity_failed', 'open_failed'].includes(value.error.code as string)) throw new TypeError('Invalid error')
  } else {
    if (value.ok !== true) throw new TypeError('Invalid result')
    exact(value, ['ok', 'value']); record(value.value)
    if (method === 'capabilities') {
      exact(value.value, ['ready', 'nativeOpen', 'reason'])
      if (typeof value.value.ready !== 'boolean' || typeof value.value.nativeOpen !== 'boolean') throw new TypeError('Invalid capability')
      if (value.value.reason !== undefined) text(value.value.reason, 1000)
    } else if (method === 'register') {
      exact(value.value, ['objectId', 'assetId', 'version', 'kind', 'name', 'bytes', 'persistence']); asset(value.value)
      if (value.value.persistence !== 'saved') throw new TypeError('Invalid persistence')
    } else { exact(value.value, ['opened']); if (value.value.opened !== true) throw new TypeError('Invalid opening') }
  }
  return structuredClone(value)
}
export const OBJECT_ASSET_REMOTE = {
  package: 'dsh-translation-plugin',
  descriptors: methods.map(method => ({
    id: `dsh-translation-plugin#translationObjects/${method}`, service: 'translationObjects', namespace: 'translationObjects', method,
    invocation: { kind: 'direct' as const },
    parameters: method === 'capabilities' ? [] : [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#object-${method}-request`, create: () => ({ parse: (value: unknown) => parseObjectAssetRequest(method, value) }) } }],
    ...(method === 'capabilities' ? {} : { cancellation: { parameter: 'signal' } }),
    result: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#object-${method}-result`, create: () => ({ parse: (value: unknown) => parseObjectAssetResult(method, value) }) },
  })),
}
