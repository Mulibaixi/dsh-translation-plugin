import { browserPluginStorage } from './storage-fence.js'
import type { TopicSessionStart } from '../shared/topic-bridge.js'
import { parseReferenceIndex, referenceBytes, type ReferenceFacts, type ReferenceIndex,
  type ReferenceScope } from '../shared/reference-memory.js'
import type { LocalStoragePort, SessionStore } from './session-store.js'

export const REFERENCE_INDEX_PREFIX = 'dsh-translation-plugin:references:v1:'
const NAMESPACE_KEY = `${REFERENCE_INDEX_PREFIX}namespace`
type Remote = { clearRemote(request: ReferenceScope): Promise<unknown> }
const browserStorage = browserPluginStorage
function indexKey(ownerId: string, topicId: string): string { return `${REFERENCE_INDEX_PREFIX}${encodeURIComponent(ownerId)}:${encodeURIComponent(topicId)}` }
function readIndex(text: string): ReferenceIndex {
  const { documents: _discarded, ...index } = JSON.parse(text)
  return parseReferenceIndex(index)
}
export class ReferenceStore {
  private readonly indices = new Map<string, ReferenceIndex>()
  private readonly listeners = new Set<() => void>()
  private readonly namespaceId: string
  private notice: string | undefined
  private disposed = false
  private readonly dirty = new Set<string>()
  private readonly bindings = new Map<string, {readonly signature:string;readonly topicId:string|null}>()
  constructor(private readonly sessions: SessionStore, private readonly remote: () => Promise<Remote | undefined>, private readonly storage = browserStorage(),
    private readonly options: {readonly withOwner?: <T>(ownerId:string,action:()=>Promise<T>)=>Promise<T>} = {}) {
    this.namespaceId = sessions.getNamespaceId()
    if (storage) for (let at = 0; at < storage.length; at++) {
      const key = storage.key(at)
      if (!key?.startsWith(REFERENCE_INDEX_PREFIX) || key === NAMESPACE_KEY) continue
      try { const index = readIndex(storage.getItem(key)!); if (index.scope.namespaceId !== this.namespaceId || key !== indexKey(index.scope.ownerId, index.scope.topicId)) throw new Error('reference scope mismatch'); this.indices.set(key, index) }
      catch { this.notice = '部分参考资料索引不可读，原副本已保留。' }
    }
  }
  getAssetNamespaceId(): string { return this.namespaceId }
  async bind(ownerId: string, operationId: string, start: TopicSessionStart): Promise<ReferenceFacts> {
    const bindingKey = 'dsh-translation-plugin:reference-binding:v1:' + JSON.stringify([this.namespaceId, ownerId, operationId])
    const run = async (): Promise<ReferenceFacts> => {
      const signature = JSON.stringify(start), stored = this.storage?.getItem(bindingKey)
      const previous = this.bindings.get(bindingKey) ?? (stored ? JSON.parse(stored) as {signature:string;topicId:string|null} : undefined)
      if (previous) {
        if (previous.signature !== signature) throw Object.assign(new Error('归属操作已绑定其他目标。'), {code: 'idempotency_conflict'})
        if (!previous.topicId) throw Object.assign(new Error('归属创建结果未知，请查询会话列表，不会自动重新创建。'), {code: 'outcome_unknown'})
        return this.facts(ownerId, previous.topicId)
      }
      let topicId: string
      if (start.kind === 'existing_topic') topicId = start.topicId
      else if (start.kind === 'parent_session') {
        const session = this.sessions.getAvailableSessions(ownerId).find(session => session.id === start.translationSessionId)
        if (!session || this.sessions.isSessionDeleted(session.id)) throw new Error('指定翻译会话不可用。')
        topicId = session.topicId
      } else {
        this.bindings.set(bindingKey, {signature, topicId:null})
        this.storage?.setItem(bindingKey, JSON.stringify({signature, topicId: null}))
        const created = await this.sessions.createManagedSessionAsync(ownerId, start, 'normal')
        if (!created.ok) throw Object.assign(new Error(created.message), {code: created.code})
        topicId = created.sessions[0]!.topicId
      }
      const facts = this.facts(ownerId, topicId)
      this.bindings.set(bindingKey, {signature, topicId})
      this.storage?.setItem(bindingKey, JSON.stringify({signature, topicId})); return facts
    }
    return typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(bindingKey, run) : run()
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { for (const listener of this.listeners) listener() }
  /** Topic deletion removes the empty index/barrier as well; the topic tombstone remains the authority. */
  discardTopic(ownerId: string, topicId: string): boolean {
    ownerId = this.sessions.getTopicStorageScope(topicId) ?? ownerId
    const key = indexKey(ownerId, topicId)
    try { this.storage?.removeItem(key); this.indices.delete(key); this.emit(); return true }
    catch { this.notice = '参考资料索引未能随主题删除清理，请检查本地存储。'; this.emit(); return false }
  }
  getNotice(): string | undefined { return this.notice }
  facts(ownerId: string, topicId: string): ReferenceFacts {
    ownerId = this.sessions.getTopicStorageScope(topicId) ?? ownerId
    if (this.disposed) throw Object.assign(new Error('参考资料窗口已关闭，请重新启用插件。'), {code:'reference_unavailable'})
    const topic = this.sessions.getTopics(ownerId).find(topic => topic.id === topicId)
    if (!topic) throw Object.assign(new Error('主题不存在或已经删除。'), { code: 'scope_mismatch' })
    const key = indexKey(ownerId, topicId)
    let index = this.indices.get(key)
    try {
      const saved=this.storage?.getItem(key), incoming=saved?readIndex(saved):undefined
      if (incoming && (incoming.scope.namespaceId!==this.namespaceId || incoming.scope.ownerId!==ownerId || incoming.scope.topicId!==topicId)) throw new Error('reference scope mismatch')
      if(incoming && (!index || incoming.scope.generation>index.scope.generation || !this.dirty.has(key)&&incoming.version>index.version)){index=incoming;this.indices.set(key,index)}
    }catch{throw Object.assign(new Error('参考索引的最新副本无法读取，不能覆盖。'),{code:'reference_conflict'})}
    if (!index) { index = { schemaVersion: 1, scope: { namespaceId: this.namespaceId, ownerId, topicId, generation: 0 }, version: 0 }; this.indices.set(key, index) }
    return { index: structuredClone(index), topicName: topic.name }
  }
  sync(ownerId: string, raw: ReferenceIndex, expectedVersion: number): ReferenceFacts {
    const index = parseReferenceIndex(raw), before = this.facts(ownerId, index.scope.topicId)
    if (JSON.stringify(before.index.scope) !== JSON.stringify(index.scope) || before.index.version !== expectedVersion && JSON.stringify(before.index) !== JSON.stringify(index) || index.version < before.index.version) throw Object.assign(new Error('参考索引已变化，请查询原操作。'), { code: 'stale_reference' })
    const key = indexKey(before.index.scope.ownerId, index.scope.topicId)
    if (referenceBytes(index) > 196608) throw Object.assign(new Error('参考资料索引超出预算。'), { code: 'reference_index_limit' })
    this.indices.set(key, index); this.dirty.add(key)
    try { if (!this.storage) throw new Error('storage unavailable'); this.storage.setItem(key, JSON.stringify(index)); this.dirty.delete(key) }
    catch { this.notice = '参考资料当前未保存，运行期内容和旧保存副本保留。'; this.emit(); throw Object.assign(new Error(this.notice), { code: 'save_failed' }) }
    this.notice = undefined; this.emit(); return this.facts(ownerId, index.scope.topicId)
  }
  async clearTopic(ownerId: string, topicId: string): Promise<boolean> {
    ownerId = this.sessions.getTopicStorageScope(topicId) ?? ownerId
    const before = this.facts(ownerId, topicId), remote = await this.remote()
    if (!remote) return false
    const result = await remote.clearRemote(before.index.scope) as { ok?: boolean; value?: { cleared?: boolean } }
    if (result.ok !== true || result.value?.cleared !== true) return false
    const next: ReferenceIndex = { schemaVersion: 1, scope: { ...before.index.scope, generation: before.index.scope.generation + 1 }, version: 0 }
    const key = indexKey(ownerId, topicId)
    try { if (!this.storage) throw new Error('storage unavailable'); this.storage.setItem(key, JSON.stringify(next)); this.indices.set(key, next); this.emit(); return true }
    catch { this.notice = '参考正文已清理，浏览器索引清理尚未确认。'; this.emit(); return false }
  }
  dispose(): void { this.disposed = true; this.indices.clear(); this.bindings.clear(); this.listeners.clear() }
}
