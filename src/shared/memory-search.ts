import { referenceExact, referenceInteger, referenceObject, referenceString } from './reference-memory.js'

export interface MemoryIndexStatus {
  readonly enabled: boolean; readonly building: boolean; readonly total: number; readonly indexed: number
  readonly unsupported: number; readonly unsegmented: number; readonly unavailable: number; readonly unavailableRecords: number; readonly reason?: string
}
export interface MemoryIndexScope { readonly namespaceId: string; readonly topicId?: string }
export interface MemoryIndexBuild { readonly namespaceId: string; readonly rebuild: boolean }
export interface MemorySearchPort {
  status(request: MemoryIndexScope): Promise<MemoryIndexStatus>
  build(request: MemoryIndexBuild): Promise<MemoryIndexStatus>
}
export type MemorySearchRemotePort = { [K in keyof MemorySearchPort]: (...args: Parameters<MemorySearchPort[K]>) => Promise<unknown> }
export function parseMemoryIndexRequest(method: keyof MemorySearchPort, value: unknown): MemoryIndexScope | MemoryIndexBuild {
  referenceObject(value); referenceExact(value, ['namespaceId', ...(method === 'build' ? ['rebuild'] : [])], method === 'status' ? ['topicId'] : []); referenceString(value.namespaceId, 3000)
  if (method === 'status' && value.topicId !== undefined) referenceString(value.topicId)
  if (method === 'build' && typeof value.rebuild !== 'boolean') throw new TypeError('Invalid index rebuild option')
  return structuredClone(value) as unknown as MemoryIndexScope | MemoryIndexBuild
}
export function parseMemoryIndexStatus(value: unknown): MemoryIndexStatus {
  referenceObject(value); referenceExact(value, ['enabled', 'building', 'total', 'indexed', 'unsupported', 'unsegmented', 'unavailable', 'unavailableRecords'], ['reason'])
  if (typeof value.enabled !== 'boolean' || typeof value.building !== 'boolean') throw new TypeError('Invalid index state')
  for (const key of ['total', 'indexed', 'unsupported', 'unsegmented', 'unavailable', 'unavailableRecords']) referenceInteger(value[key])
  if ((value.indexed as number) > (value.total as number)) throw new TypeError('Invalid index coverage')
  if (value.reason !== undefined) referenceString(value.reason, 500)
  return structuredClone(value) as unknown as MemoryIndexStatus
}
export const MEMORY_SEARCH_REMOTE = { package: 'dsh-translation-plugin', descriptors: (['status', 'build'] as const).map(method => ({
  id: `dsh-translation-plugin#translationMemorySearch/${method}`, service: 'translationMemorySearch', namespace: 'translationMemorySearch', method, invocation: { kind: 'direct' as const },
  parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#index-${method}`, create: () => ({ parse: (value: unknown) => parseMemoryIndexRequest(method, value) }) } }],
  result: { mode: 'strict' as const, typeSymbol: 'dsh-translation-plugin#index-status', create: () => ({ parse: parseMemoryIndexStatus }) },
})) }
