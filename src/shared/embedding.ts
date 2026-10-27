import { referenceExact, referenceInteger, referenceObject, referenceString } from './reference-memory.js'

export const EMBEDDING_TEST_TEXT = 'Translation memory connection test.'
export interface EmbeddingConfig { readonly endpoint: string; readonly model: string }
export interface EmbeddingStatus extends EmbeddingConfig {
  readonly revision: string | null; readonly available: boolean; readonly hasKey: boolean; readonly writable: boolean; readonly reason?: string
}
export interface EmbeddingSave extends EmbeddingConfig { readonly expectedRevision: string | null; readonly apiKey?: string }
export interface EmbeddingRevision { readonly expectedRevision: string | null }
export interface EmbeddingTest { readonly revision: string }
export interface EmbeddingTestResult { readonly revision: string; readonly dimensions: number; readonly elapsedMs: number }
export interface EmbeddingMutation { readonly status: 'saved' | 'cleared' | 'stale'; readonly settings: EmbeddingStatus }
export interface EmbeddingPort {
  status(request: Record<string, never>): Promise<EmbeddingStatus>
  save(request: EmbeddingSave): Promise<EmbeddingMutation>
  clear(request: EmbeddingRevision): Promise<EmbeddingMutation>
  testConnection(request: EmbeddingTest, signal: AbortSignal): Promise<EmbeddingTestResult>
}
export type EmbeddingRemotePort = { [K in keyof EmbeddingPort]: (...args: Parameters<EmbeddingPort[K]>) => Promise<unknown> }
export function parseEmbeddingConfig(value: unknown): EmbeddingConfig {
  referenceObject(value); referenceString(value.endpoint, 2000); referenceString(value.model, 200)
  const url = new URL(value.endpoint)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search || !url.pathname.endsWith('/embeddings'))
    throw new TypeError('请填写以 /embeddings 结尾的完整 HTTP(S) API 地址，不包含查询参数或登录信息。')
  if (value.endpoint !== value.endpoint.trim() || value.model !== value.model.trim()) throw new TypeError('API 地址和模型名称首尾不能有空格。')
  return { endpoint: url.href, model: value.model }
}
export function parseEmbeddingStatus(value: unknown): EmbeddingStatus {
  referenceObject(value); referenceExact(value, ['endpoint', 'model', 'revision', 'available', 'hasKey', 'writable'], ['reason'])
  if (typeof value.available !== 'boolean' || typeof value.hasKey !== 'boolean' || typeof value.writable !== 'boolean') throw new TypeError('Invalid embedding capability')
  if (value.revision !== null) { referenceString(value.revision); parseEmbeddingConfig(value) }
  else if (value.endpoint !== '' || value.model !== '' || value.hasKey !== false) throw new TypeError('Invalid empty embedding configuration')
  if (value.reason !== undefined) referenceString(value.reason, 500)
  return structuredClone(value) as unknown as EmbeddingStatus
}
type Method = keyof EmbeddingPort
export function parseEmbeddingRequest(method: Method, value: unknown): unknown {
  referenceObject(value)
  if (method === 'status') referenceExact(value, [])
  else if (method === 'save') {
    referenceExact(value, ['endpoint', 'model', 'expectedRevision'], ['apiKey']); parseEmbeddingConfig(value)
    if (value.expectedRevision !== null) referenceString(value.expectedRevision)
    if (value.apiKey !== undefined) { referenceString(value.apiKey, 8192); if (/[\r\n]/u.test(value.apiKey)) throw new TypeError('Invalid API key') }
  } else if (method === 'clear') { referenceExact(value, ['expectedRevision']); if (value.expectedRevision !== null) referenceString(value.expectedRevision) }
  else { referenceExact(value, ['revision']); referenceString(value.revision) }
  return structuredClone(value)
}
export function parseEmbeddingResult(method: Method, value: unknown): unknown {
  if (method === 'status') return parseEmbeddingStatus(value)
  referenceObject(value)
  if (method === 'testConnection') {
    referenceExact(value, ['revision', 'dimensions', 'elapsedMs']); referenceString(value.revision); referenceInteger(value.dimensions, 1); referenceInteger(value.elapsedMs)
  } else {
    referenceExact(value, ['status', 'settings'])
    if (!['saved', 'cleared', 'stale'].includes(String(value.status))) throw new TypeError('Invalid embedding update')
    parseEmbeddingStatus(value.settings)
  }
  return structuredClone(value)
}
export const EMBEDDING_REMOTE = { package: 'dsh-translation-plugin', descriptors: (['status', 'save', 'clear', 'testConnection'] as const).map(method => ({
  id: `dsh-translation-plugin#translationEmbedding/${method}`, service: 'translationEmbedding', namespace: 'translationEmbedding', method, invocation: { kind: 'direct' as const },
  parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#embedding-${method}-request`, create: () => ({ parse: (value: unknown) => parseEmbeddingRequest(method, value) }) } }],
  ...(method === 'testConnection' ? { cancellation: { parameter: 'signal' } } : {}),
  result: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#embedding-${method}-result`, create: () => ({ parse: (value: unknown) => parseEmbeddingResult(method, value) }) },
})) }
