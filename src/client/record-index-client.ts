import { parseRecordIndexState, type RecordIndexTarget, type RecordIndexState, type RecordIndexRequest, type RecordIndexRemotePort } from '../shared/record-index.js'

export interface RecordIndexClientState { readonly status?: RecordIndexState; readonly busy: boolean; readonly error?: string }
const keyOf = (target: RecordIndexTarget): string => JSON.stringify([target.namespaceId, target.topicId, target.sessionId, target.unitId, target.sourceVersion])
const working = (state?: RecordIndexState): boolean => !!state && ['submitted', 'segmenting', 'embedding'].includes(state.phase)

/** Both file views retain one state per exact original; polling stops when its last visible view leaves. */
export class RecordIndexClient {
  private readonly listeners = new Set<() => void>()
  private readonly states = new Map<string, RecordIndexClientState>()
  private readonly retained = new Map<string, { readonly target: RecordIndexTarget; count: number }>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private epoch = 0
  private disposed = false
  constructor(private readonly remote: () => Promise<RecordIndexRemotePort | undefined>) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getState(target: RecordIndexTarget): RecordIndexClientState { return this.states.get(keyOf(target)) ?? { busy: false } }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  retain(target: RecordIndexTarget): () => void {
    if (this.disposed) return () => {}
    const key = keyOf(target), current = this.retained.get(key)
    if (current) current.count++
    else { this.retained.set(key, { target: { ...target }, count: 1 }); void this.refresh(target) }
    this.schedule()
    return () => {
      const entry = this.retained.get(key)
      if (entry && --entry.count === 0) this.retained.delete(key)
      if (!this.retained.size) { clearTimeout(this.timer); this.timer = undefined }
    }
  }
  private schedule(): void {
    if (this.disposed || this.timer !== undefined || !this.retained.size) return
    const delay = [...this.retained.keys()].some(key => working(this.states.get(key)?.status)) ? 1000 : 5000
    this.timer = setTimeout(() => {
      this.timer = undefined
      void Promise.all([...this.retained.values()].map(entry => this.refresh(entry.target))).finally(() => this.schedule())
    }, delay)
  }
  private async run(target: RecordIndexTarget, request?: RecordIndexRequest): Promise<void> {
    const key = keyOf(target), previous = this.getState(target)
    if (this.disposed || previous.busy || request && working(previous.status)) return
    const epoch = this.epoch
    this.states.set(key, { ...(previous.status ? { status: previous.status } : {}), busy: true }); this.emit()
    try {
      const remote = await this.remote()
      if (this.disposed || this.epoch !== epoch) return
      if (!remote) throw new Error('原文索引服务尚未就绪，请重试。')
      const reply = (request ? await remote.request(request) : await remote.status(target)) as unknown as { readonly ok?: boolean; readonly value?: unknown; readonly error?: { readonly message?: string } }
      if (this.disposed || this.epoch !== epoch) return
      if (!reply.ok) throw new Error(reply.error?.message ?? '原文索引操作未完成，请重试。')
      this.states.set(key, { status: parseRecordIndexState(reply.value), busy: false })
    } catch (error) {
      if (!this.disposed && this.epoch === epoch) this.states.set(key, { ...previous, busy: false, error: error instanceof Error ? error.message : '原文索引操作未完成，请重试。' })
    }
    if (!this.disposed && this.epoch === epoch) { this.emit(); this.schedule() }
  }
  refresh(target: RecordIndexTarget): Promise<void> { return this.run(target) }
  request(target: RecordIndexTarget, mainSessionId: string, action: RecordIndexRequest['action'] = 'start'): Promise<void> {
    return this.run(target, { ...target, mainSessionId, action })
  }
  reset(): void { this.epoch++; this.states.clear(); this.emit(); for (const { target } of this.retained.values()) void this.refresh(target) }
  dispose(): void { this.disposed = true; this.epoch++; clearTimeout(this.timer); this.timer = undefined; this.retained.clear(); this.states.clear(); this.listeners.clear() }
}
