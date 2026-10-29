import { parseMemoryIndexStatus, type MemoryIndexStatus, type MemorySearchRemotePort } from '../shared/memory-search.js'
interface IndexState { readonly status?: MemoryIndexStatus; readonly busy: boolean; readonly error?: string }
export class MemoryIndexClient {
  private readonly listeners = new Set<() => void>()
  private epoch = 0
  private disposed = false
  private readonly states = new Map<string | undefined, IndexState>()
  constructor(private readonly namespaceId: () => string, private readonly remote: () => Promise<MemorySearchRemotePort | undefined>) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getState(topicId?: string): IndexState { return this.states.get(topicId) ?? { busy: false } }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  private async run(rebuild?: boolean, topicId?: string): Promise<void> {
    const state = this.getState(topicId)
    if (this.disposed || state.busy) return
    const epoch = this.epoch; this.states.set(topicId, { ...state, busy: true }); this.emit()
    try {
      const remote = await this.remote(); if (this.disposed || epoch !== this.epoch) return
      if (!remote) throw new Error('记忆索引服务尚未就绪，请重试。')
      const scope = { namespaceId: this.namespaceId(), ...(topicId === undefined ? {} : { topicId }) }
      let reply = (rebuild === undefined ? await remote.status(scope) : await remote.build({ namespaceId: scope.namespaceId, rebuild })) as { ok?: boolean; value?: unknown; error?: { message?: string } }
      if (rebuild !== undefined && topicId !== undefined && reply.ok) {
        if (this.disposed || epoch !== this.epoch) return
        reply = await remote.status(scope) as typeof reply
      }
      if (this.disposed || epoch !== this.epoch) return
      if (!reply.ok) throw new Error(reply.error?.message ?? '索引操作未完成，请重试。')
      this.states.set(topicId, { status: parseMemoryIndexStatus(reply.value), busy: false })
    } catch (error) { if (!this.disposed && epoch === this.epoch) this.states.set(topicId, { ...state, busy: false, error: (error as Error).message }) }
    if (!this.disposed && epoch === this.epoch) this.emit()
  }
  refresh(topicId?: string): Promise<void> { return this.run(undefined, topicId) }
  build(rebuild = false, topicId?: string): Promise<void> { return this.run(rebuild, topicId) }
  reset(): void { this.epoch++; this.states.clear(); this.emit() }
  dispose(): void { this.disposed = true; this.reset(); this.listeners.clear() }
}
