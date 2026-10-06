import {
  MAX_TOPIC_BRIDGE_REPLY_BYTES, parseTopicBridgeCapability, parseTopicBridgeDown, parseTopicBridgeReply,
  type TopicBridgeOpen, type TopicBridgeReply, type TopicBridgeRequest, type TopicBridgeValue, type TopicUnitFact, type TopicSessionSummary,
} from '../shared/topic-bridge.js'
import type { TopicTermSnapshot, TopicTermPut, TermMutationResult, TermEvidenceRef, TopicTermQuery } from '../memory/topic-terms.js'
import type { SessionStore } from './session-store.js'
import type { LocalSession } from './sessions.js'

export interface TopicBridgeRemotePort {
  capabilities(): Promise<unknown>
  connect(request: TopicBridgeOpen, signal?: AbortSignal): AsyncIterable<unknown> & {
    send(item: TopicBridgeReply): void
    dispose(): void | Promise<void>
  }
}
export interface TopicBridgeTermsPort {
  getSnapshot(ownerId: string, topicId: string): TopicTermSnapshot
  query(ownerId: string, topicId: string, query: Omit<TopicTermQuery, 'ownerId' | 'topicId'>): TopicTermSnapshot
  apply(ownerId: string, topicId: string, expectedVersion: number, command: { readonly kind: 'put'; readonly input: TopicTermPut }): Promise<TermMutationResult>
}
type Handle = ReturnType<TopicBridgeRemotePort['connect']>
interface Connection {
  refs: number
  generation: number
  controller: AbortController
  handle: Handle | undefined
  ready: boolean
  reason: string | undefined
  requests: Set<string>
}
interface Publication { readonly sessionId: string; readonly topicId: string; readonly fact: TopicUnitFact }
function error(requestId: string, code: string, message: string): TopicBridgeReply { return { requestId, ok: false, error: { code, message } } }

/** Browser facts remain authoritative. This bridge does not admit ordinary translation. */
export class TopicBridgeClient {
  private readonly connections = new Map<string, Connection>()
  private readonly publications = new Map<string, Publication>()
  private readonly listeners = new Set<() => void>()
  private readonly stopStore: () => void
  private disposed = false
  constructor(private readonly remote: TopicBridgeRemotePort | (() => Promise<TopicBridgeRemotePort | undefined>) | undefined,
    private readonly sessions: SessionStore, private readonly terms: TopicBridgeTermsPort) {
    this.stopStore = sessions.subscribe(() => this.reconcile())
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  private key(ownerId: string, sessionId: string, unitId: string): string { return JSON.stringify([ownerId, sessionId, unitId]) }
  getStatus(ownerId: string): { readonly ready: boolean; readonly reason: string | undefined } {
    const connection = this.connections.get(ownerId)
    return { ready: connection?.ready ?? false, reason: connection?.reason }
  }
  retain(ownerId: string): () => void {
    if (this.disposed || !ownerId.trim()) return () => {}
    let connection = this.connections.get(ownerId)
    if (!connection) {
      connection = { refs: 0, generation: 0, controller: new AbortController(), handle: undefined, ready: false, reason: undefined, requests: new Set() }
      this.connections.set(ownerId, connection)
      void this.open(ownerId, connection)
    }
    connection.refs++
    const retained = connection
    let released = false
    return () => {
      if (released) return
      released = true
      if (--retained.refs === 0 && this.connections.get(ownerId) === retained) {
        this.connections.delete(ownerId)
        retained.generation++; retained.controller.abort(); void this.closeHandle(retained.handle)
        this.emit()
      }
    }
  }
  private async open(ownerId: string, connection: Connection): Promise<void> {
    const generation = connection.generation
    const current = (): boolean => !this.disposed && this.connections.get(ownerId) === connection && connection.generation === generation
    try {
      const remote = typeof this.remote === 'function' ? await this.remote() : this.remote
      if (!current()) return
      if (!remote) throw new Error('主题管理服务尚未就绪。')
      const response = await remote.capabilities() as { readonly ok?: boolean; readonly value?: unknown }
      if (!current()) return
      if (response?.ok !== true) throw new Error('无法取得主题管理服务回执。')
      const capability = parseTopicBridgeCapability(response.value)
      if (!capability.ready) throw new Error(capability.reason ?? '主题管理服务尚未就绪。')
      const handle = remote.connect({ ownerId, mainSessionId: ownerId }, connection.controller.signal)
      connection.handle = handle
      let opened = false
      for await (const raw of handle) {
        if (!current()) return
        const frame = parseTopicBridgeDown(raw)
        if (frame.kind === 'ready') {
          if (opened || frame.ownerId !== ownerId || frame.mainSessionId !== ownerId) throw new Error('主题管理连接归属无效。')
          opened = true; connection.ready = true; connection.reason = undefined; this.emit()
          continue
        }
        if (!opened || frame.mainSessionId !== ownerId) throw new Error('主题管理请求归属无效。')
        let reply: TopicBridgeReply
        if (connection.requests.has(frame.requestId)) reply = error(frame.requestId, 'duplicate_request', '此请求已经处理，未重复修改会话或术语。')
        else {
          connection.requests.add(frame.requestId)
          try { reply = await this.dispatch(ownerId, frame) }
          catch { reply = error(frame.requestId, 'operation_failed', '资料或术语操作未完成，请查询当前记录后重试。') }
        }
        if (!current()) return
        if (new TextEncoder().encode(JSON.stringify(reply)).byteLength > MAX_TOPIC_BRIDGE_REPLY_BYTES) reply = error(frame.requestId, 'reply_too_large', '此资料超过桥接读取上限，未截断或发送。')
        handle.send(parseTopicBridgeReply(reply))
      }
      if (current()) throw new Error('主题管理连接已结束。')
    } catch (failure) {
      if (current()) {
        const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : undefined
        connection.ready = false
        connection.reason = code === 'connection_occupied' ? '此主会话的主题管理已由另一窗口连接；请关闭另一窗口的翻译面板后重试。' : '主题管理桥暂不可用；本地术语仍可查看。'
        this.emit()
      }
    } finally {
      if (current()) { const handle = connection.handle; connection.handle = undefined; await this.closeHandle(handle) }
    }
  }
  private async closeHandle(handle: Handle | undefined): Promise<void> {
    try { await handle?.dispose() }
    catch { console.error('[dsh-translation-plugin] Topic bridge stream cleanup failed.') }
  }
  private publishedEvidence(ownerId: string, topicId: string, ref: TermEvidenceRef): boolean {
    const publication = this.publications.get(this.key(ownerId, ref.sessionId, ref.unitId))
    if (!publication || publication.topicId !== topicId) return false
    return ref.kind === 'source' || (publication.fact.final?.revisionId === ref.revisionId && publication.fact.final.selectionEventId === ref.selectionEventId)
  }
  private sessionSummary(session: LocalSession): TopicSessionSummary {
    return { id: session.id, topicId: session.topicId, name: session.name, mode: session.mode,
      topicName: session.topicName, sequence: session.sequence, remark: session.remark, archived: session.archivedAt !== null,
      publishedUnitIds: [...this.publications.values()].filter(item => item.sessionId === session.id).map(item => item.fact.id) }
  }
  private async dispatch(ownerId: string, request: TopicBridgeRequest): Promise<TopicBridgeReply> {
    this.reconcile()
    const command = request.command
    const success = (value: TopicBridgeValue): TopicBridgeReply => ({ requestId: request.requestId, ok: true, value })
    if (command.kind === 'list_sessions') return success({ kind: 'sessions', sessions: this.sessions.getAvailableSessions(ownerId).filter(session => !this.sessions.isSessionDeleted(session.id)).map(session => this.sessionSummary(session)) })
    if (command.kind === 'list_topics') return success({ kind: 'topics', topics: this.sessions.getTopics(ownerId).map(topic => ({ ...topic,
      sessionIds: this.sessions.getAvailableSessions(ownerId).filter(session => session.topicId === topic.id && !this.sessions.isSessionDeleted(session.id)).map(session => session.id) })) })
    if (command.kind === 'list_topic_terms') {
      if (!this.sessions.getTopics(ownerId).some(topic => topic.id === command.topicId)) return error(request.requestId, 'out_of_scope', '主题不属于当前主会话或不存在。')
      return success({ kind: 'terms', snapshot: this.terms.getSnapshot(ownerId, command.topicId) })
    }
    if (command.kind === 'create_session') {
      const result = await this.sessions.createManagedSessionAsync(ownerId, command.start)
      return result.ok ? success({ kind: 'session_created', session: this.sessionSummary(result.sessions[0]!), reason: command.reason, persistence: result.persistence })
        : error(request.requestId, result.code, result.message)
    }
    if (command.kind === 'rename_topic') {
      const result = await this.sessions.renameTopicAsync(ownerId, command.topicId, command.expectedName, command.name)
      return result.ok ? success({ kind: 'sessions', sessions: result.sessions.map(session => this.sessionSummary(session)), persistence: result.persistence })
        : error(request.requestId, result.code, result.message)
    }
    const session = this.sessions.getSession(command.translationSessionId)
    if (!session || session.ownerId !== ownerId || this.sessions.isSessionDeleted(session.id)) return error(request.requestId, 'out_of_scope', '翻译会话不属于当前主会话或已删除。')
    switch (command.kind) {
      case 'set_session_remark': {
        const result = await this.sessions.setSessionRemarkAsync(ownerId, session.id, command.expectedRemark, command.remark)
        return result.ok ? success({ kind: 'sessions', sessions: result.sessions.map(session => this.sessionSummary(session)), persistence: result.persistence })
          : error(request.requestId, result.code, result.message)
      }
      case 'archive_session': {
        const result = await this.sessions.setSessionArchivedAsync(ownerId, session.id, command.expectedArchived, command.archived)
        return result.ok ? success({ kind: 'sessions', sessions: result.sessions.map(session => this.sessionSummary(session)), persistence: result.persistence })
          : error(request.requestId, result.code, result.message)
      }
      case 'read_unit': {
        if (session.mode !== 'normal') return error(request.requestId, 'normal_required', '历史原文参考只在明确升级为普通后提供。')
        const publication = this.publications.get(this.key(ownerId, session.id, command.unitId))
        return publication && publication.topicId === session.topicId ? success({ kind: 'unit', unit: structuredClone(publication.fact) })
          : error(request.requestId, 'reference_not_published', '用户尚未选择此单元供主模型参考。')
      }
      case 'list_terms': return success({ kind: 'terms', snapshot: this.terms.getSnapshot(ownerId, session.topicId) })
      case 'query_terms': {
        const snapshot = this.terms.query(ownerId, session.topicId, { mode: session.mode, sourceLanguage: command.sourceLanguage,
          targetLanguage: command.targetLanguage, forms: command.forms })
        return success({ kind: 'terms_query', snapshot })
      }
      case 'upsert_term': {
        if (!command.entry.evidence.every(ref => this.publishedEvidence(ownerId, session.topicId, ref))) return error(request.requestId, 'reference_not_published', '术语依据不在用户明确提供的历史范围中。')
        const result = await this.terms.apply(ownerId, session.topicId, command.expectedVersion, { kind: 'put', input: command.entry })
        if (result.status !== 'updated' && result.status !== 'unchanged') return error(request.requestId, result.status, '术语提交未完成，请核对当前版本及依据。')
        return success({ kind: 'terms', snapshot: result.snapshot })
      }
    }
  }
  publishUnit(ownerId: string, sessionId: string, unitId: string): boolean {
    const session = this.sessions.getSession(sessionId), history = this.sessions.getTranslationHistory(sessionId)
    const unit = history?.units.find(unit => unit.id === unitId), latest = unit?.revisions.at(-1)
    if (this.disposed || !session || session.ownerId !== ownerId || this.sessions.isSessionDeleted(session.id) || session.mode !== 'normal' || !unit || !latest || !['completed', 'failed', 'cancelled', 'interrupted'].includes(latest.status)) return false
    const event = [...history!.events].reverse().find(event => event.type === 'final.selected' && event.unitId === unitId)
    const fact: TopicUnitFact = { id: unit.id, order: unit.order, source: unit.source, targetLanguage: unit.targetLanguage, instruction: unit.instruction,
      revisions: unit.revisions.map(({ id, order, kind, status, text, baseRevisionId }) => ({ id, order, kind, status, text, baseRevisionId })),
      final: unit.final && event?.revisionId === unit.final.revisionId ? { revisionId: unit.final.revisionId, selection: unit.final.selection, selectionEventId: event.id } : null }
    // Include the largest allowed correlation ID so every future request fits without truncation.
    const reply: TopicBridgeReply = { requestId: 'x'.repeat(2048), ok: true, value: { kind: 'unit', unit: fact } }
    if (new TextEncoder().encode(JSON.stringify(reply)).byteLength > MAX_TOPIC_BRIDGE_REPLY_BYTES) return false
    this.publications.set(this.key(ownerId, sessionId, unitId), { sessionId, topicId: session.topicId, fact: structuredClone(fact) })
    this.emit(); return true
  }
  isPublished(ownerId: string, sessionId: string, unitId: string): boolean { return this.publications.has(this.key(ownerId, sessionId, unitId)) }
  revokeUnit(ownerId: string, sessionId: string, unitId: string): void { this.publications.delete(this.key(ownerId, sessionId, unitId)); this.emit() }
  private reconcile(): void {
    let changed = false
    for (const [key, publication] of this.publications) {
      const session = this.sessions.getSession(publication.sessionId)
      if (!session || this.sessions.isSessionDeleted(publication.sessionId) || session.topicId !== publication.topicId || !this.sessions.getTranslationHistory(publication.sessionId)?.units.some(unit => unit.id === publication.fact.id)) {
        this.publications.delete(key); changed = true
      }
    }
    if (changed) this.emit()
  }
  async reset(onlyOwnerId?: string): Promise<void> {
    for (const [ownerId, connection] of this.connections) {
      if (onlyOwnerId !== undefined && ownerId !== onlyOwnerId) continue
      connection.generation++; connection.controller.abort(); await this.closeHandle(connection.handle)
      if (this.disposed || this.connections.get(ownerId) !== connection) continue
      connection.controller = new AbortController(); connection.handle = undefined; connection.ready = false; connection.requests.clear()
      void this.open(ownerId, connection)
    }
    this.emit()
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.stopStore(); this.publications.clear(); this.listeners.clear()
    const closing = [...this.connections.values()].map(async connection => {
      connection.generation++; connection.controller.abort(); await this.closeHandle(connection.handle)
    })
    this.connections.clear(); await Promise.all(closing)
  }
}
