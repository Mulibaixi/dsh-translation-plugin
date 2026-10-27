import { parseOtherMemoryPage, parseOtherMemoryEntry, type OtherMemoryEntry, type OtherMemorySetting, type OtherMemoryReference, type OtherMemoryRemotePort as OtherMemoryPort } from '../shared/other-memory.js'
import { parseOtherMemoryFilesResult, type OtherMemoryFilesCapability, type OtherMemoryFilesRemotePort } from '../shared/other-memory-files.js'
import type { NativeFileUploadPort } from './object-assets-client.js'
import type { SessionStore } from './session-store.js'

export type { OtherMemoryFilesRemotePort } from '../shared/other-memory-files.js'
export type OtherMemoryRemotePort = { [K in keyof OtherMemoryPort]: (...args: Parameters<OtherMemoryPort[K]>) => Promise<unknown> }
export interface OtherMemoryStatus { readonly loading: boolean; readonly ready: boolean; readonly error?: string }
export interface OtherMemorySettingInput {
  readonly id: string | null; readonly expectedVersion: number | null; readonly topicId: string | null
  readonly title: string; readonly body: string; readonly enabled: boolean
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
/** The gateway envelope is separate from the file service's domain result. */
function unwrap<T>(reply: unknown): T {
  if (!record(reply) || reply.ok !== true) throw new Error(record(reply) && record(reply.error) && typeof reply.error.message === 'string' ? reply.error.message : '未取得其他记忆服务回执，请重试。')
  return reply.value as T
}
function fileValue<T>(method: 'capabilities' | 'importReceipt' | 'open' | 'requestSegmentation', reply: unknown): T { return unwrap<T>(parseOtherMemoryFilesResult(method, unwrap(reply))) }

/** Host owns the bodies; this client only retains lists requested by mounted asset views. */
export class OtherMemoryClient {
  private readonly cache = new Map<string | null, readonly OtherMemoryEntry[]>()
  private readonly states = new Map<string | null, OtherMemoryStatus>()
  private readonly revisions = new Map<string | null, number>()
  private readonly retained = new Map<string, number>()
  private saveError: string | undefined
  private readonly listeners = new Set<() => void>()
  private readonly operations = new Map<AbortController, string>()
  private epoch = 0
  private disposed = false
  private readonly stopSession: () => void
  constructor(private readonly sessions: SessionStore, private readonly remote: () => Promise<OtherMemoryRemotePort | undefined>,
    private readonly options: { readonly uploads?: NativeFileUploadPort; readonly filesRemote?: () => Promise<OtherMemoryFilesRemotePort | undefined> } = {}) {
    let remember = sessions.getSettings().rememberHistory
    this.stopSession = sessions.subscribe(() => {
      for (const topicId of this.cache.keys()) if (topicId !== null && !this.available(topicId)) this.discard(topicId)
      for (const [operation, topicId] of this.operations) if (!this.available(topicId)) operation.abort()
      const next = sessions.getSettings().rememberHistory
      if (next && !remember) void this.persistPending()
      remember = next
    })
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  private available(topicId: string | null): boolean {
    return !this.disposed && (topicId === null || !this.sessions.isTopicDeleted(topicId) && !this.sessions.isTopicDeleting(topicId) && this.sessions.getTopics().some(topic => topic.id === topicId))
  }
  private check(topicId: string | null): void { if (!this.available(topicId)) throw new Error('主题不存在、正在删除或已关闭。') }
  private discard(topicId: string | null): void {
    this.revisions.set(topicId, (this.revisions.get(topicId) ?? 0) + 1)
    this.cache.delete(topicId); this.states.delete(topicId)
  }
  retain(topicId: string): () => void {
    if (!this.available(topicId)) return () => {}
    this.retained.set(topicId, (this.retained.get(topicId) ?? 0) + 1)
    if (!this.states.has(topicId)) void this.refresh(topicId)
    let released = false
    return () => {
      if (released) return; released = true
      const count = (this.retained.get(topicId) ?? 1) - 1
      if (count > 0) this.retained.set(topicId, count)
      else { this.retained.delete(topicId); this.discard(topicId) }
    }
  }
  entries(topicId: string): readonly OtherMemoryEntry[] { return this.available(topicId) ? structuredClone(this.cache.get(topicId) ?? []) : [] }
  getStatus(topicId: string): OtherMemoryStatus { const status = this.states.get(topicId) ?? { loading: false, ready: false }; return this.saveError && !status.error ? { ...status, error: this.saveError } : status }
  async refresh(topicId: string | null): Promise<void> {
    if (!this.available(topicId)) return
    const epoch = this.epoch, revision = (this.revisions.get(topicId) ?? 0) + 1
    this.revisions.set(topicId, revision)
    const current = (): boolean => this.epoch === epoch && this.revisions.get(topicId) === revision && this.available(topicId)
    this.states.set(topicId, { loading: true, ready: this.cache.has(topicId) }); this.emit()
    try {
      const remote = await this.remote()
      if (!current()) return
      if (!remote) throw new Error('其他记忆服务未就绪，请重试。')
      const entries: OtherMemoryEntry[] = []
      let after: string | undefined
      do {
        const page = parseOtherMemoryPage(unwrap(await remote.list({ namespaceId: this.sessions.getNamespaceId(), topicId, ...(after ? { after } : {}) })))
        if (!current()) return
        if (page.entries.some(entry => entry.namespaceId !== this.sessions.getNamespaceId() || entry.topicId !== null && entry.topicId !== topicId || entries.some(previous => previous.id === entry.id))) throw new Error('其他记忆回执的范围或分页不匹配。')
        entries.push(...page.entries)
        if (page.next !== null && (page.next === after || !page.entries.length)) throw new Error('其他记忆分页未向后推进。')
        after = page.next ?? undefined
      } while (after !== undefined)
      if (!current()) return
      this.cache.set(topicId, structuredClone(entries)); this.states.set(topicId, { loading: false, ready: true })
    } catch (error) { if (current()) this.states.set(topicId, { loading: false, ready: this.cache.has(topicId), error: (error as Error).message }) }
    finally { if (current()) this.emit() }
  }
  private begin(topicId: string | null): { readonly current: () => boolean } {
    this.check(topicId)
    // A list started before an edit must never overwrite its result.
    for (const [key, status] of this.states) { this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1); this.states.set(key, { ...status, loading: false }) }
    const epoch = this.epoch
    return { current: () => this.epoch === epoch && this.available(topicId) }
  }
  private replace(entry: OtherMemoryEntry | undefined, removedId?: string): void {
    for (const key of this.states.keys()) this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
    for (const [topicId, entries] of this.cache) {
      const next = entries.filter(value => value.id !== (entry?.id ?? removedId))
      if (entry && (entry.topicId === null || entry.topicId === topicId)) next.push(structuredClone(entry))
      this.cache.set(topicId, next); this.states.set(topicId, { loading: false, ready: true })
    }
    this.emit()
  }
  async putSetting(input: OtherMemorySettingInput): Promise<OtherMemorySetting> {
    const operation = this.begin(input.topicId), remote = await this.remote()
    if (!operation.current()) throw new Error('其他记忆连接已变化，请重试。')
    if (!remote) throw new Error('其他记忆服务未就绪，请重试。')
    const entry = parseOtherMemoryEntry(unwrap(await remote.putSetting({ ...input, namespaceId: this.sessions.getNamespaceId(), rememberHistory: this.sessions.getSettings().rememberHistory })))
    if (entry.kind !== 'setting' || entry.namespaceId !== this.sessions.getNamespaceId() || entry.topicId !== input.topicId) throw new Error('设定保存回执不匹配。')
    if (!operation.current()) throw new Error('其他记忆连接已变化，请刷新核对保存结果。')
    this.replace(entry); return entry
  }
  async remove(entry: OtherMemoryEntry): Promise<void> {
    const operation = this.begin(entry.topicId), remote = await this.remote()
    if (!operation.current()) throw new Error('其他记忆连接已变化，请重试。')
    if (!remote) throw new Error('其他记忆服务未就绪，请重试。')
    const result = unwrap<{ readonly removed: true }>(await remote.removeEntry({ namespaceId: this.sessions.getNamespaceId(), topicId: entry.topicId, id: entry.id, expectedVersion: entry.version }))
    if (!operation.current()) throw new Error('其他记忆连接已变化，请刷新核对删除结果。')
    if (result.removed !== true) throw new Error('删除尚未确认，请刷新核对。')
    this.replace(undefined, entry.id)
  }
  async clearTopic(topicId: string): Promise<void> {
    const operation = this.begin(topicId), remote = await this.remote()
    if (!operation.current()) throw new Error('其他记忆连接已变化，请重试。')
    if (!remote) throw new Error('其他记忆服务未就绪，请重试。')
    const result = unwrap<{ readonly cleared: true }>(await remote.clearTopic({ namespaceId: this.sessions.getNamespaceId(), topicId }))
    if (!operation.current()) throw new Error('其他记忆连接已变化，请刷新核对清空结果。')
    if (result.cleared !== true) throw new Error('清空尚未确认，请刷新核对。')
    this.cache.set(topicId, (this.cache.get(topicId) ?? []).filter(entry => entry.topicId === null))
    this.revisions.set(topicId, (this.revisions.get(topicId) ?? 0) + 1)
    this.states.set(topicId, { loading: false, ready: true }); this.emit()
  }
  private async persistPending(): Promise<void> {
    const epoch = this.epoch
    try {
      const remote = await this.remote()
      if (this.epoch !== epoch || this.disposed || !this.sessions.getSettings().rememberHistory) return
      if (!remote) throw new Error('其他记忆服务未就绪，请重试。')
      const result = unwrap<{ readonly persisted: true }>(await remote.persistNamespace({ namespaceId: this.sessions.getNamespaceId() }))
      if (result.persisted !== true) throw new Error('持久保存尚未确认。')
      if (this.epoch !== epoch || this.disposed) return
      this.saveError = undefined
      for (const topicId of this.retained.keys()) await this.refresh(topicId)
    } catch (error) { if (this.epoch === epoch && !this.disposed) { this.saveError = `其他记忆尚未保存：${(error as Error).message}`; this.emit() } }
  }
  canUpload(mainSessionId?: string): boolean { return !!mainSessionId && !!this.options.uploads && !!this.options.filesRemote && !this.disposed }
  async importFile(topicId: string, mainSessionId: string, file: File): Promise<void> {
    const operation = this.begin(topicId)
    if (!this.canUpload(mainSessionId)) throw new Error('请先选择可接收文件的主会话。')
    const controller = new AbortController(); this.operations.set(controller, topicId)
    try {
      const remote = await this.options.filesRemote!()
      if (!operation.current() || controller.signal.aborted) throw new Error('文件登记已取消。')
      if (!remote) throw new Error('参考文件服务未就绪，请重试。')
      const capability = fileValue<OtherMemoryFilesCapability>('capabilities', await remote.capabilities())
      if (!capability.ready) throw new Error(capability.reason ?? '参考文件服务暂不可用。')
      if (!operation.current() || controller.signal.aborted) throw new Error('文件登记已取消。')
      if (file.size > capability.maxBytes) throw new Error(`文件超过当前支持的 ${Math.floor(capability.maxBytes / 1024 / 1024)} MiB 上限。`)
      const receipt = unwrap<{ readonly receiptId: string }>(await this.options.uploads!.upload(mainSessionId, file, file.name, controller.signal, () => {}))
      if (!receipt || typeof receipt.receiptId !== 'string' || !receipt.receiptId) throw new Error('文件上传未取得回执，请重试。')
      if (!operation.current() || controller.signal.aborted) throw new Error('文件登记已取消。')
      const result = fileValue<OtherMemoryReference>('importReceipt', await remote.importReceipt({ namespaceId: this.sessions.getNamespaceId(), topicId, mainSessionId, category: 'full_text', receiptId: receipt.receiptId, rememberHistory: this.sessions.getSettings().rememberHistory }, controller.signal))
      if (result.namespaceId !== this.sessions.getNamespaceId() || result.topicId !== topicId) throw new Error('文件登记回执的主题不匹配。')
      if (!operation.current()) throw new Error('主题或连接已变化，请刷新核对文件登记结果。')
      this.replace(result)
    } finally { this.operations.delete(controller) }
  }
  async open(entry: OtherMemoryReference): Promise<void> {
    this.check(entry.topicId)
    const epoch = this.epoch, controller = new AbortController(); this.operations.set(controller, entry.topicId)
    try {
      const remote = await this.options.filesRemote?.()
      if (this.epoch !== epoch || !this.available(entry.topicId)) throw new Error('主题或连接已变化。')
      if (!remote) throw new Error('参考文件服务未就绪，请重试。')
      fileValue('open', await remote.open({ namespaceId: this.sessions.getNamespaceId(), topicId: entry.topicId, id: entry.id, version: entry.version }, controller.signal))
    } finally { this.operations.delete(controller) }
  }
  async requestSegmentation(entry: OtherMemoryReference, mainSessionId: string): Promise<void> {
    this.check(entry.topicId)
    const controller = new AbortController(); this.operations.set(controller, entry.topicId)
    try {
      const remote = await this.options.filesRemote?.()
      if (!remote) throw new Error('参考文件服务尚未就绪。')
      fileValue('requestSegmentation', await remote.requestSegmentation({ namespaceId: this.sessions.getNamespaceId(), topicId: entry.topicId, id: entry.id, version: entry.version, mainSessionId }, controller.signal))
    } finally { this.operations.delete(controller) }
  }
  reset(): void {
    this.epoch++; for (const operation of this.operations.keys()) operation.abort()
    this.operations.clear(); this.cache.clear(); this.states.clear(); this.revisions.clear(); this.emit()
    if (!this.disposed) for (const topicId of this.retained.keys()) void this.refresh(topicId)
  }
  dispose(): void { this.disposed = true; this.reset(); this.stopSession(); this.retained.clear(); this.listeners.clear() }
}
