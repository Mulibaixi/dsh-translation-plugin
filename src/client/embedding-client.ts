import { parseEmbeddingRequest, parseEmbeddingResult, type EmbeddingRemotePort, type EmbeddingStatus, type EmbeddingSave, type EmbeddingMutation, type EmbeddingTestResult } from '../shared/embedding.js'

export interface EmbeddingClientState {
  readonly loading: boolean; readonly busy: boolean; readonly settings?: EmbeddingStatus; readonly result?: EmbeddingTestResult | undefined; readonly error?: string | undefined
}
function unwrap<T>(method: 'status' | 'save' | 'clear' | 'testConnection', raw: unknown): T {
  const reply = raw as { ok?: boolean; value?: unknown; error?: { message?: string } }
  if (reply?.ok !== true) throw new Error(reply?.error?.message ?? '嵌入设置服务尚未就绪，请重试。')
  return parseEmbeddingResult(method, reply.value) as T
}
export class EmbeddingClient {
  private state: EmbeddingClientState = { loading: false, busy: false }
  private readonly listeners = new Set<() => void>()
  private epoch = 0
  private disposed = false
  private test: AbortController | undefined
  constructor(private readonly remote: () => Promise<EmbeddingRemotePort | undefined>) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getState(): EmbeddingClientState { return this.state }
  private set(state: EmbeddingClientState): void { this.state = state; if (!this.disposed) for (const listener of this.listeners) listener() }
  async refresh(): Promise<void> {
    if (this.disposed || this.state.busy) return
    const epoch = ++this.epoch
    this.set({ ...this.state, loading: true, result: undefined })
    try {
      const remote = await this.remote(); if (!remote) throw new Error('嵌入设置服务尚未就绪，请重试。')
      if (this.disposed || epoch !== this.epoch) return
      const settings = unwrap<EmbeddingStatus>('status', await remote.status({}))
      if (!this.disposed && epoch === this.epoch) this.set({ settings, loading: false, busy: false })
    } catch (error) { if (!this.disposed && epoch === this.epoch) this.set({ ...this.state, loading: false, error: (error as Error).message }) }
  }
  async save(input: EmbeddingSave): Promise<boolean> {
    if (this.disposed || this.state.busy) return false
    const epoch = ++this.epoch; this.set({ ...this.state, busy: true, error: undefined, result: undefined })
    try {
      parseEmbeddingRequest('save', input)
      const remote = await this.remote(); if (!remote) throw new Error('嵌入设置服务尚未就绪。')
      if (this.disposed || epoch !== this.epoch) return false
      const mutation = unwrap<EmbeddingMutation>('save', await remote.save(input))
      if (this.disposed || epoch !== this.epoch) return false
      this.set({ settings: mutation.settings, loading: false, busy: false, ...(mutation.status === 'stale' ? { error: '配置已在其他窗口变化，编辑值保留；请核对当前配置后重试。' } : {}) })
      return mutation.status === 'saved'
    } catch (error) { if (!this.disposed && epoch === this.epoch) this.set({ ...this.state, busy: false, error: (error as Error).message }); return false }
  }
  async clear(expectedRevision: string | null): Promise<boolean> {
    if (this.disposed || this.state.busy) return false
    const epoch = ++this.epoch; this.set({ ...this.state, busy: true, error: undefined, result: undefined })
    try {
      const remote = await this.remote(); if (!remote) throw new Error('嵌入设置服务尚未就绪。')
      if (this.disposed || epoch !== this.epoch) return false
      const mutation = unwrap<EmbeddingMutation>('clear', await remote.clear({ expectedRevision }))
      if (this.disposed || epoch !== this.epoch) return false
      this.set({ settings: mutation.settings, loading: false, busy: false, ...(mutation.status === 'stale' ? { error: '配置已变化，请核对最新内容后再清除。' } : {}) })
      return mutation.status === 'cleared'
    } catch (error) { if (!this.disposed && epoch === this.epoch) this.set({ ...this.state, busy: false, error: (error as Error).message }); return false }
  }
  async testConnection(): Promise<void> {
    const settings = this.state.settings
    if (this.disposed || this.state.busy || !settings?.revision) return
    const epoch = ++this.epoch, controller = new AbortController(); this.test = controller
    this.set({ ...this.state, busy: true, error: undefined, result: undefined })
    try {
      const remote = await this.remote(); if (!remote) throw new Error('嵌入设置服务尚未就绪。')
      if (this.disposed || epoch !== this.epoch) return
      const result = unwrap<EmbeddingTestResult>('testConnection', await remote.testConnection({ revision: settings.revision }, controller.signal))
      if (result.revision !== settings.revision) throw new Error('测试回执属于已变化的配置，未作为当前结果。')
      if (!this.disposed && epoch === this.epoch && result.revision === settings.revision) this.set({ settings, result, loading: false, busy: false })
    } catch (error) { if (!this.disposed && epoch === this.epoch) this.set({ ...this.state, busy: false, error: (error as Error).message }) }
    finally { if (this.test === controller) this.test = undefined }
  }
  reset(): void { this.epoch++; this.test?.abort(); this.test = undefined; this.set({ loading: false, busy: false }) }
  dispose(): void { this.disposed = true; this.reset(); this.listeners.clear() }
}
