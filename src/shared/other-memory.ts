import { referenceBytes, referenceExact, referenceInteger, referenceObject, referenceString } from './reference-memory.js'
import { parseSourceIdentity, type SourceIdentity } from './translation-sources.js'
import { parseReferenceSegmentation, type ReferenceSegmentation } from './reference-segmentation.js'

export const OTHER_MEMORY_SETTING_BYTES = 32768
export const OTHER_MEMORY_RESPONSE_BYTES = 196608
export interface OtherMemoryScope { readonly namespaceId: string; readonly topicId: string | null }
interface OtherMemoryBase extends OtherMemoryScope {
  readonly id: string
  readonly version: number
  readonly persistence: 'saved' | 'runtime_only'
}
/** Explicit user requirements, independent of their source or provenance. */
export interface OtherMemorySetting extends OtherMemoryBase {
  readonly kind: 'setting'; readonly title: string; readonly body: string; readonly enabled: boolean
}
/** The original is held by this topic registration. Only full_text can be created/read/indexed; reference remains decodable solely for opening/removing old files. */
export interface OtherMemoryReference extends OtherMemoryBase {
  readonly kind: 'reference'; readonly topicId: string; readonly category: 'full_text' | 'reference'; readonly source: SourceIdentity
  readonly segmentation?: ReferenceSegmentation
}
export type OtherMemoryEntry = OtherMemorySetting | OtherMemoryReference
export interface OtherMemoryPutSetting extends OtherMemoryScope {
  readonly id: string | null; readonly expectedVersion: number | null
  readonly title: string; readonly body: string; readonly enabled: boolean
}
export interface OtherMemoryRemove extends OtherMemoryScope { readonly id: string; readonly expectedVersion: number }
export interface OtherMemoryList extends OtherMemoryScope { readonly after?: string }
export interface OtherMemoryPage { readonly entries: readonly OtherMemoryEntry[]; readonly next: string | null }
export interface OtherMemoryRemotePort {
  list(request: OtherMemoryList): Promise<OtherMemoryPage>
  putSetting(request: OtherMemoryPutSetting): Promise<OtherMemorySetting>
  removeEntry(request: OtherMemoryRemove): Promise<{ readonly removed: true }>
  clearTopic(request: { readonly namespaceId: string; readonly topicId: string }): Promise<{ readonly cleared: true }>
}
export function parseOtherMemoryScope(value: unknown): OtherMemoryScope {
  referenceObject(value); referenceString(value.namespaceId)
  if (value.topicId !== null) referenceString(value.topicId, 3000)
  return { namespaceId: value.namespaceId, topicId: value.topicId as string | null }
}
export function parseOtherMemoryEntry(value: unknown): OtherMemoryEntry {
  referenceObject(value)
  const common = ['id', 'namespaceId', 'topicId', 'version', 'persistence', 'kind']
  referenceString(value.id); parseOtherMemoryScope(value); referenceInteger(value.version, 1)
  if (value.persistence !== 'saved' && value.persistence !== 'runtime_only') throw new TypeError('Invalid memory persistence')
  if (value.kind === 'setting') {
    referenceExact(value, [...common, 'title', 'body', 'enabled']); referenceString(value.title, 200); referenceString(value.body, OTHER_MEMORY_SETTING_BYTES)
    if (typeof value.enabled !== 'boolean' || referenceBytes(value.body) > OTHER_MEMORY_SETTING_BYTES) throw new TypeError('Invalid setting body or size')
  } else if (value.kind === 'reference') {
    referenceExact(value, [...common, 'category', 'source'], ['segmentation']); referenceString(value.topicId, 3000)
    const source = parseSourceIdentity(value.source)
    if (value.segmentation !== undefined) parseReferenceSegmentation(value.segmentation, source.totalCodePoints)
    if (value.category !== 'full_text' && value.category !== 'reference') throw new TypeError('Invalid reference category')
  } else throw new TypeError('Invalid memory kind')
  if (referenceBytes({ ok: true, value: { entries: [value], next: value.id } }) > OTHER_MEMORY_RESPONSE_BYTES)
    throw new RangeError('其他记忆条目完整编码超过读取预算，请精简正文后重试；未截断保存。')
  return structuredClone(value) as unknown as OtherMemoryEntry
}
export type OtherMemoryMethod = keyof OtherMemoryRemotePort
export function parseOtherMemoryRequest(method: OtherMemoryMethod, value: unknown): unknown {
  referenceObject(value)
  parseOtherMemoryScope(value)
  if (method === 'putSetting') {
    referenceExact(value, ['namespaceId', 'topicId', 'id', 'expectedVersion', 'title', 'body', 'enabled'])
    if (value.id !== null) referenceString(value.id)
    if (value.expectedVersion !== null) referenceInteger(value.expectedVersion, 1)
    if ((value.id === null) !== (value.expectedVersion === null)) throw new TypeError('Invalid setting edit identity')
    referenceString(value.title, 200); referenceString(value.body, OTHER_MEMORY_SETTING_BYTES)
    if (referenceBytes(value.body) > OTHER_MEMORY_SETTING_BYTES || typeof value.enabled !== 'boolean') throw new TypeError('Invalid setting input')
  } else if (method === 'removeEntry') {
    referenceExact(value, ['namespaceId', 'topicId', 'id', 'expectedVersion']); referenceString(value.id); referenceInteger(value.expectedVersion, 1)
  } else if (method === 'list') {
    referenceExact(value, ['namespaceId', 'topicId'], ['after'])
    if (Object.hasOwn(value, 'after')) referenceString(value.after)
  } else {
    referenceExact(value, ['namespaceId', 'topicId'])
    if (method === 'clearTopic') referenceString(value.topicId, 3000)
  }
  return structuredClone(value)
}
export function parseOtherMemoryEntries(value: unknown): readonly OtherMemoryEntry[] {
  if (!Array.isArray(value)) throw new TypeError('Invalid memory list')
  const entries = value.map(parseOtherMemoryEntry)
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new TypeError('Duplicate memory identity')
  return entries
}
export function parseOtherMemoryPage(value: unknown): OtherMemoryPage {
  referenceObject(value); referenceExact(value, ['entries', 'next'])
  const entries = parseOtherMemoryEntries(value.entries)
  if (value.next !== null) referenceString(value.next)
  if (referenceBytes({ ok: true, value }) > OTHER_MEMORY_RESPONSE_BYTES) throw new RangeError('其他记忆分页超过读取预算。')
  return { entries, next: value.next as string | null }
}
export function parseOtherMemoryResult(method: OtherMemoryMethod, value: unknown): unknown {
  if (method === 'list') return parseOtherMemoryPage(value)
  if (method === 'putSetting') { const entry = parseOtherMemoryEntry(value); if (entry.kind !== 'setting') throw new TypeError('Invalid setting result'); return entry }
  referenceObject(value)
  const field = method === 'removeEntry' ? 'removed' : 'cleared'
  referenceExact(value, [field]); if (value[field] !== true) throw new TypeError('Invalid memory removal receipt')
  return value
}
const methods: readonly OtherMemoryMethod[] = ['list', 'putSetting', 'removeEntry', 'clearTopic']
export const OTHER_MEMORY_REMOTE = {
  package: 'dsh-translation-plugin',
  descriptors: methods.map(method => ({
    id: `dsh-translation-plugin#translationOtherMemory/${method}`, service: 'translationOtherMemory', namespace: 'translationOtherMemory', method,
    invocation: { kind: 'direct' as const },
    parameters: [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#other-memory-${method}-request`, create: () => ({ parse: (value: unknown) => parseOtherMemoryRequest(method, value) }) } }],
    result: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#other-memory-${method}-result`, create: () => ({ parse: (value: unknown) => parseOtherMemoryResult(method, value) }) },
  })),
}
