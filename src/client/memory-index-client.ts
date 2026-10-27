import { parseMemoryIndexStatus, type MemoryIndexStatus, type MemorySearchRemotePort } from '../shared/memory-search.js'
export class MemoryIndexClient {
  private readonly listeners = new Set<() => void>()
  private epoch = 0
  private disposed = false
  private state: { readonly status?: MemoryIndexStatus; readonly busy: boolean; readonly error?: string } = { busy: false }
  constructor(private readonly namespaceId: () => string, private readonly remote: () => Promise<MemorySearchRemotePort | undefined>) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getState() { return this.state }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  private async run(rebuild?: boolean): Promise<void> {
    if (this.disposed || this.state.busy) return
    const epoch = ++this.epoch; this.state = { ...this.state, busy: true }; this.emit()
    try {
      const remote = await this.remote(); if (this.disposed || epoch !== this.epoch) return
      if (!remote) throw new Error('记忆索引服务尚未就绪，请重试。')
      const reply = (rebuild === undefined ? await remote.status({ namespaceId: this.namespaceId() }) : await remote.build({ namespaceId: this.namespaceId(), rebuild })) as { ok?: boolean; value?: unknown; error?: { message?: string } }
      if (this.disposed || epoch !== this.epoch) return
      if (!reply.ok) throw new Error(reply.error?.message ?? '索引操作未完成，请重试。')
      this.state = { status: parseMemoryIndexStatus(reply.value), busy: false }
    } catch (error) { if (!this.disposed && epoch === this.epoch) this.state = { ...this.state, busy: false, error: (error as Error).message } }
    if (!this.disposed && epoch === this.epoch) this.emit()
  }
  refresh(): Promise<void> { return this.run() }
  build(rebuild = false): Promise<void> { return this.run(rebuild) }
  reset(): void { this.epoch++; this.state = { busy: false }; this.emit() }
  dispose(): void { this.disposed = true; this.reset(); this.listeners.clear() }
}
