import { parseOtherMemoryEntry, type OtherMemoryReference } from './other-memory.js'
import { referenceExact, referenceInteger, referenceObject, referenceString } from './reference-memory.js'
import { MAX_TRANSLATION_SOURCE_BYTES } from './translation-sources.js'

export interface OtherMemoryFilesCapability {
  readonly ready: boolean; readonly nativeOpen: boolean; readonly maxBytes: number; readonly reason?: string
}
export interface OtherMemoryFileImport {
  readonly namespaceId: string; readonly topicId: string; readonly mainSessionId: string
  readonly receiptId: string; readonly category: 'full_text'; readonly rememberHistory: boolean
}
export interface OtherMemoryFileOpen { readonly namespaceId: string; readonly topicId: string; readonly id: string; readonly version: number }
export interface OtherMemorySegmentationRequest extends OtherMemoryFileOpen { readonly mainSessionId: string }
const errors = ['invalid_input', 'scope_mismatch', 'unavailable', 'receipt_not_found', 'source_too_large', 'integrity_failed', 'not_found', 'stale_version', 'storage_failed', 'open_failed', 'busy'] as const
export type OtherMemoryFilesError = typeof errors[number]
export type OtherMemoryFilesResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly code: OtherMemoryFilesError; readonly message: string } }
export interface OtherMemoryFilesPort {
  capabilities(): Promise<OtherMemoryFilesResult<OtherMemoryFilesCapability>>
  importReceipt(request: OtherMemoryFileImport, signal: AbortSignal): Promise<OtherMemoryFilesResult<OtherMemoryReference>>
  open(request: OtherMemoryFileOpen, signal: AbortSignal): Promise<OtherMemoryFilesResult<{ readonly opened: true }>>
  requestSegmentation(request: OtherMemorySegmentationRequest, signal: AbortSignal): Promise<OtherMemoryFilesResult<{ readonly queued: true }>>
}
export type OtherMemoryFilesRemotePort = { [K in keyof OtherMemoryFilesPort]: (...args: Parameters<OtherMemoryFilesPort[K]>) => Promise<unknown> }
export function parseOtherMemoryFilesRequest(method: 'importReceipt' | 'open' | 'requestSegmentation', value: unknown): OtherMemoryFileImport | OtherMemoryFileOpen | OtherMemorySegmentationRequest {
  referenceObject(value); referenceString(value.namespaceId); referenceString(value.topicId, 3000)
  if (method === 'importReceipt') {
    referenceExact(value, ['namespaceId', 'topicId', 'mainSessionId', 'receiptId', 'category', 'rememberHistory'])
    referenceString(value.mainSessionId); referenceString(value.receiptId, 256)
    if (value.category !== 'full_text' || typeof value.rememberHistory !== 'boolean') throw new TypeError('Only original/bilingual files can be registered')
  } else {
    referenceExact(value, ['namespaceId', 'topicId', 'id', 'version', ...(method === 'requestSegmentation' ? ['mainSessionId'] : [])]); referenceString(value.id); referenceInteger(value.version, 1)
    if (method === 'requestSegmentation') referenceString(value.mainSessionId)
  }
  return structuredClone(value) as unknown as OtherMemoryFileImport | OtherMemoryFileOpen
}
const methods = ['capabilities', 'importReceipt', 'open', 'requestSegmentation'] as const
export function parseOtherMemoryFilesResult(method: typeof methods[number], value: unknown): unknown {
  referenceObject(value)
  if (value.ok === false) {
    referenceExact(value, ['ok', 'error']); referenceObject(value.error); referenceExact(value.error, ['code', 'message']); referenceString(value.error.message, 1000)
    if (!errors.includes(value.error.code as OtherMemoryFilesError)) throw new TypeError('Invalid reference error')
  } else {
    referenceExact(value, ['ok', 'value']); if (value.ok !== true) throw new TypeError('Invalid reference result')
    if (method === 'importReceipt') { if (parseOtherMemoryEntry(value.value).kind !== 'reference') throw new TypeError('Invalid reference entry') }
    else {
      referenceObject(value.value)
      if (method === 'capabilities') {
        referenceExact(value.value, ['ready', 'nativeOpen', 'maxBytes'], ['reason'])
        if (typeof value.value.ready !== 'boolean' || typeof value.value.nativeOpen !== 'boolean' || value.value.maxBytes !== MAX_TRANSLATION_SOURCE_BYTES) throw new TypeError('Invalid reference capability')
        if (value.value.reason !== undefined) referenceString(value.value.reason, 1000)
      } else if (method === 'requestSegmentation') { referenceExact(value.value, ['queued']); if (value.value.queued !== true) throw new TypeError('Invalid segmentation notice') }
      else { referenceExact(value.value, ['opened']); if (value.value.opened !== true) throw new TypeError('Invalid original open') }
    }
  }
  return structuredClone(value)
}
export const OTHER_MEMORY_FILES_REMOTE = {
  package: 'dsh-translation-plugin',
  descriptors: methods.map(method => ({
    id: `dsh-translation-plugin#translationOtherMemoryFiles/${method}`, service: 'translationOtherMemoryFiles', namespace: 'translationOtherMemoryFiles', method,
    invocation: { kind: 'direct' as const },
    parameters: method === 'capabilities' ? [] : [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#other-memory-file-${method}-request`, create: () => ({ parse: (value: unknown) => parseOtherMemoryFilesRequest(method, value) }) } }],
    ...(method === 'capabilities' ? {} : { cancellation: { parameter: 'signal' } }),
    result: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#other-memory-file-${method}-result`, create: () => ({ parse: (value: unknown) => parseOtherMemoryFilesResult(method, value) }) },
  })),
}
