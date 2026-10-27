import { EMBEDDING_TEST_TEXT, parseEmbeddingConfig, parseEmbeddingRequest, type EmbeddingConfig, type EmbeddingStatus, type EmbeddingSave,
  type EmbeddingMutation, type EmbeddingRevision, type EmbeddingTest, type EmbeddingTestResult } from '../shared/embedding.js'
import type { TopicHostContext } from './topic-tools.js'
import { diagnosticSpan } from './diagnostics.js'

export const EMBEDDING_CREDENTIAL_KEY = 'dsh-translation-plugin/embedding'
interface ApiRecord { readonly kind: 'api-key'; readonly key?: string; readonly env?: Readonly<Record<string, string>> }
interface Credentials {
  readRecord(key: unknown): Promise<unknown>
  describeRecord(key: unknown): Promise<{ readonly configured: boolean; readonly writable: boolean }>
  modifyRecord(key: unknown, mutate: (current: unknown) => Promise<ApiRecord | undefined>): Promise<unknown>
  deleteRecord(key: unknown): Promise<void>
}
interface Settings extends EmbeddingConfig { readonly revision: string; readonly apiKey?: string }
const fields = { endpoint: 'DSH_EMBEDDING_ENDPOINT', model: 'DSH_EMBEDDING_MODEL', revision: 'DSH_EMBEDDING_REVISION' } as const
class EmbeddingFailure extends Error { constructor(readonly code: string, message: string) { super(message) } }
function failure(code: string, message: string): Error { return new EmbeddingFailure(code, message) }
function decode(raw: unknown): Settings | undefined {
  if (raw === undefined) return undefined
  const value = raw as ApiRecord
  try {
    const revision = value.env?.[fields.revision]
    if (value.kind !== 'api-key' || !value.env || typeof revision !== 'string' || !revision.length ||
      value.key !== undefined && (typeof value.key !== 'string' || !value.key.length || /[\r\n]/u.test(value.key))) throw new Error('Invalid credential record')
    const config = parseEmbeddingConfig({ endpoint: value.env[fields.endpoint], model: value.env[fields.model] })
    return { ...config, revision, ...(value.key === undefined ? {} : { apiKey: value.key }) }
  } catch { throw failure('embedding_config_invalid', '宿主保存的嵌入配置不可读，请清除后重新填写；原记录已保留。') }
}
function encoded(value: Settings): ApiRecord {
  return { kind: 'api-key', ...(value.apiKey === undefined ? {} : { key: value.apiKey }), env: {
    [fields.endpoint]: value.endpoint, [fields.model]: value.model, [fields.revision]: value.revision,
  } }
}
function safe(value: Settings | undefined, writable: boolean): EmbeddingStatus {
  return { endpoint: value?.endpoint ?? '', model: value?.model ?? '', revision: value?.revision ?? null, hasKey: value?.apiKey !== undefined, available: true, writable }
}
/** One plugin-owned credential record atomically holds the service environment and optional bearer key. */
export class EmbeddingService {
  readonly typertRemote: { readonly service: EmbeddingService; readonly serviceKey: 'translationEmbedding'; readonly namespace: 'translationEmbedding' } = { service: this, serviceKey: 'translationEmbedding', namespace: 'translationEmbedding' }
  private disposed = false
  private generation = 0
  private pending = 0
  private tail: Promise<unknown> = Promise.resolve()
  private readonly requests = new Set<AbortController>()
  constructor(private readonly ctx: TopicHostContext, private readonly options: { readonly fetch?: typeof fetch; readonly timeoutMs?: number } = {}) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationEmbedding', property: 'ctx' } })
  }
  private check(peer: string | undefined, generation: number): void {
    if (!peer || this.disposed || generation !== this.generation) throw failure('embedding_closed', '嵌入设置连接已关闭，请重新打开设置。')
  }
  private async credentials(): Promise<{ provider: Credentials; key: unknown }> {
    const provider = this.ctx.get?.('credentials') as Credentials | undefined
    const loader = this.ctx.get?.('loader') as { internal?: { import(name: string, anchor: string, options: object): Promise<unknown> } } | undefined
    if (!provider?.readRecord || !provider.modifyRecord || !provider.describeRecord || !provider.deleteRecord || !loader?.internal || !this.ctx.baseUrl)
      throw failure('embedding_credentials_unavailable', '宿主凭据服务尚未就绪，暂时不能使用嵌入配置。')
    const seam = await loader.internal.import('@deepseek-ai/dsh-credentials', this.ctx.baseUrl, {}) as { credentialKey(scope: string, id: string): unknown }
    return { provider, key: seam.credentialKey('dsh-translation-plugin', 'embedding') }
  }
  private async storage<T>(run: () => Promise<T>): Promise<T> {
    try { return await run() }
    catch (error) { if (error instanceof EmbeddingFailure) throw error; throw failure('embedding_storage', '宿主嵌入配置或凭据操作未确认完成，请读取最新配置，检查凭据服务后重试。') }
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    this.pending++
    const result = this.tail.catch(() => {}).then(run)
    this.tail = result.catch(() => {})
    return result.finally(() => { this.pending-- })
  }
  async configuration(): Promise<(EmbeddingConfig & { readonly revision: string }) | undefined> {
    if (this.disposed) throw failure('embedding_closed', '嵌入服务已关闭。')
    await this.tail
    const { provider, key } = await this.credentials(), value = decode(await this.storage(() => provider.readRecord(key)))
    return value ? { endpoint: value.endpoint, model: value.model, revision: value.revision } : undefined
  }
  private changed(): void { (this.ctx.get?.('translationMemorySearch') as { embeddingChanged(): void } | undefined)?.embeddingChanged() }
  async status(raw: Record<string, never>): Promise<EmbeddingStatus> {
    parseEmbeddingRequest('status', raw)
    const peer = this.ctx.invocation?.peer.id, generation = this.generation; this.check(peer, generation)
    try {
      await this.tail
      const { provider, key } = await this.credentials(), info = await this.storage(() => provider.describeRecord(key))
      let config: Settings | undefined
      try { config = decode(await this.storage(() => provider.readRecord(key))) }
      catch (error) {
        if (!(error instanceof EmbeddingFailure) || error.code !== 'embedding_config_invalid') throw error
        this.check(peer, generation)
        return { ...safe(undefined, info.writable), available: false, reason: error.message }
      }
      this.check(peer, generation); return safe(config, info.writable)
    } catch (error) {
      this.check(peer, generation)
      if ((error as { code?: string }).code !== 'embedding_credentials_unavailable') throw error
      return { endpoint: '', model: '', revision: null, hasKey: false, available: false, writable: false, reason: (error as Error).message }
    }
  }
  save(raw: EmbeddingSave): Promise<EmbeddingMutation> {
    const request = parseEmbeddingRequest('save', raw) as EmbeddingSave, config = parseEmbeddingConfig(request)
    const peer = this.ctx.invocation?.peer.id, generation = this.generation; this.check(peer, generation)
    return this.serial(async () => {
      this.check(peer, generation)
      const { provider, key } = await this.credentials()
      let stale = false
      const updated = decode(await this.storage(() => provider.modifyRecord(key, async current => {
        this.check(peer, generation)
        const old = decode(current)
        if ((old?.revision ?? null) !== request.expectedRevision) { stale = true; return undefined }
        const apiKey = request.apiKey ?? (old && new URL(old.endpoint).origin === new URL(config.endpoint).origin ? old.apiKey : undefined)
        return encoded({ ...config, revision: crypto.randomUUID(), ...(apiKey === undefined ? {} : { apiKey }) })
      })))
      this.check(peer, generation)
      if (!stale) { for (const controller of this.requests) controller.abort(); this.changed() }
      return { status: stale ? 'stale' : 'saved', settings: safe(updated, (await this.storage(() => provider.describeRecord(key))).writable) }
    })
  }
  clear(raw: EmbeddingRevision): Promise<EmbeddingMutation> {
    const request = parseEmbeddingRequest('clear', raw) as EmbeddingRevision
    const peer = this.ctx.invocation?.peer.id, generation = this.generation; this.check(peer, generation)
    return this.serial(async () => {
      const { provider, key } = await this.credentials()
      let current: Settings | undefined
      try { current = decode(await this.storage(() => provider.readRecord(key))) }
      catch (error) { if (!(error instanceof EmbeddingFailure) || error.code !== 'embedding_config_invalid' || request.expectedRevision !== null) throw error }
      this.check(peer, generation)
      if ((current?.revision ?? null) !== request.expectedRevision) return { status: 'stale', settings: safe(current, (await this.storage(() => provider.describeRecord(key))).writable) }
      await this.storage(() => provider.deleteRecord(key)); this.check(peer, generation)
      for (const controller of this.requests) controller.abort()
      this.changed()
      return { status: 'cleared', settings: safe(undefined, true) }
    })
  }
  /** Internal Host API for the next index batch. Vectors and credential values never cross the settings RPC. */
  async embed(texts: readonly string[], signal: AbortSignal, revision?: string): Promise<{ readonly revision: string; readonly vectors: readonly (readonly number[])[] }> {
    if (!texts.length || texts.length > 32 || texts.some(text => typeof text !== 'string' || !text.trim() || Array.from(text).length > 8000) || new TextEncoder().encode(JSON.stringify(texts)).length > 512 * 1024)
      throw failure('embedding_input_limit', '嵌入输入须为 1～32 段非空文本，每段最多 8000 码点；模型自身 token 上限仍适用。')
    if (this.disposed) throw failure('embedding_closed', '嵌入服务已关闭。')
    const generation = this.generation
    await this.tail
    const { provider, key } = await this.credentials(), config = decode(await this.storage(() => provider.readRecord(key)))
    if (!config || revision !== undefined && config.revision !== revision) throw failure('embedding_stale', '嵌入配置未保存或已变化，请重新测试。')
    const controller = new AbortController(), abort = (): void => controller.abort()
    signal.throwIfAborted(); signal.addEventListener('abort', abort, { once: true }); this.requests.add(controller)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; abort() }, this.options.timeoutMs ?? 30000)
    const report = diagnosticSpan(this.ctx, 'embedding.request', { segments: texts.length, inputCodePoints: texts.reduce((sum, text) => sum + Array.from(text).length, 0) })
    let httpStatus: number | undefined
    try {
      if (this.disposed || generation !== this.generation) throw failure('embedding_closed', '嵌入服务已关闭。')
      const response = await (this.options.fetch ?? fetch)(config.endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(config.apiKey === undefined ? {} : { Authorization: `Bearer ${config.apiKey}` }) },
        body: JSON.stringify({ model: config.model, input: texts, encoding_format: 'float' }) })
      httpStatus = response.status
      if (!response.ok) { await response.body?.cancel(); throw failure('embedding_http', `嵌入 API 返回 HTTP ${response.status}；请检查地址、模型和密钥。`) }
      const reader = response.body?.getReader(); if (!reader) throw failure('embedding_response', '嵌入 API 没有返回 JSON 正文。')
      const chunks: Uint8Array[] = []; let bytes = 0
      while (true) {
        const item = await reader.read(); if (item.done) break
        bytes += item.value.byteLength
        if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw failure('embedding_response', '嵌入响应超过 8 MiB 读取上限。') }
        chunks.push(item.value)
      }
      const body = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
      let data: unknown
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) } catch { throw failure('embedding_response', '嵌入 API 未返回有效的 UTF-8 JSON。') }
      const rows = (data as { data?: unknown } | null)?.data
      if (!Array.isArray(rows) || rows.length !== texts.length) throw failure('embedding_response', '嵌入响应条数与输入不一致。')
      const vectors: number[][] = new Array(texts.length); let dimensions: number | undefined
      for (const row of rows) {
        if (!row || !Number.isInteger(row.index) || row.index < 0 || row.index >= texts.length || vectors[row.index] || !Array.isArray(row.embedding) || !row.embedding.length || row.embedding.length > 65536 || row.embedding.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value)) || dimensions !== undefined && row.embedding.length !== dimensions)
          throw failure('embedding_response', '嵌入响应的索引、维度或浮点向量无效。')
        dimensions = row.embedding.length; vectors[row.index] = row.embedding
      }
      const current = decode(await this.storage(() => provider.readRecord(key)))
      if (controller.signal.aborted || this.disposed || generation !== this.generation || current?.revision !== config.revision) throw failure('embedding_stale', '嵌入配置或调用状态已变化，旧响应已丢弃。')
      report('completed', { httpStatus, dimensions })
      return { revision: config.revision, vectors }
    } catch (error) {
      report(timedOut ? 'failed' : controller.signal.aborted ? 'cancelled' : 'failed', { httpStatus, timedOut, callerCancelled: signal.aborted }, error)
      if (error instanceof EmbeddingFailure) throw error
      throw failure('embedding_request', controller.signal.aborted ? '嵌入请求已取消、超时或配置已变化。' : '嵌入请求未完成，请检查服务地址及网络。')
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); this.requests.delete(controller) }
  }
  async testConnection(raw: EmbeddingTest, signal: AbortSignal): Promise<EmbeddingTestResult> {
    const request = parseEmbeddingRequest('testConnection', raw) as EmbeddingTest
    const peer = this.ctx.invocation?.peer.id, generation = this.generation; this.check(peer, generation)
    const started = Date.now(), result = await this.embed([EMBEDDING_TEST_TEXT], signal, request.revision)
    this.check(peer, generation)
    return { revision: result.revision, dimensions: result.vectors[0]!.length, elapsedMs: Math.max(0, Date.now() - started) }
  }
  hasActiveJobs(): boolean { return this.pending > 0 || this.requests.size > 0 }
  async clearManagedData(): Promise<void> {
    const { provider, key } = await this.credentials()
    await this.storage(() => provider.deleteRecord(key))
  }
  async dispose(): Promise<void> { this.disposed = true; this.generation++; for (const request of this.requests) request.abort(); await this.tail }
}
