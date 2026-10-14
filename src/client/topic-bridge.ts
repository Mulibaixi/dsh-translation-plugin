import {
  MAX_TOPIC_BRIDGE_REPLY_BYTES, parseTopicBridgeCapability, parseTopicBridgeV2Capability, parseTopicBridgeDown, parseTopicBridgeReply,
  type TopicBridgeOpen, type TopicBridgeReply, type TopicBridgeRequest, type TopicBridgeValue, type TopicUnitFact, type TopicSessionSummary,
} from '../shared/topic-bridge.js'
import type { TopicTermSnapshot, TopicTermPut, TermMutationResult, TermEvidenceRef, TopicTermQuery } from '../memory/topic-terms.js'
import type { TopicArchiveSnapshot, TopicArchivePut, ArchiveMutationResult, TopicArchiveQuery } from '../memory/topic-archive.js'
import type { SessionStore } from './session-store.js'
import type { LocalSession } from './sessions.js'
import type { NormalTranslationAcceptance, NormalTranslationUpdate } from '../shared/normal-translation.js'
import type { NormalTranslationUnitRequest, NormalTranslationSourceCorrection } from '../shared/normal-translation.js'
import type { NormalTranslationResolution, NormalTranslationV2Event } from '../shared/normal-translation-v2.js'
import { currentFinalRevision, currentDocumentFinalRevision, isTextUnit, isDocumentUnit, applyDocumentMutation } from './translation-history.js'
import type { NormalTranslationReply } from './normal-translation.js'
import type { PreparationStore } from './preparation-store.js'
import type { TranslationMaterialEnvelope } from '../shared/translation-material.js'
import { MAX_ANALYSIS_PAGE_BYTES, type PreparationReceipt, type PreparationPage } from '../shared/translation-preparation.js'
import type { NormalTranslationMaterialTarget } from '../shared/normal-translation.js'
import type { DocumentTasksClient } from './document-tasks.js'

export interface TopicBridgeRemotePort {
  capabilities(): Promise<unknown>
  capabilitiesV2?(): Promise<unknown>
  connectV2?: TopicBridgeRemotePort['connect']
  connect(request: TopicBridgeOpen, signal?: AbortSignal): AsyncIterable<unknown> & {
    send(item: TopicBridgeReply): void
    dispose(): void | Promise<void>
  }
}
export interface TopicBridgeTermsPort {
  getSnapshot(ownerId: string, topicId: string): TopicTermSnapshot
  reconcileAsync?(ownerId: string, topicId: string): Promise<TopicTermSnapshot>
  query(ownerId: string, topicId: string, query: Omit<TopicTermQuery, 'ownerId' | 'topicId'>): TopicTermSnapshot
  queryAsync?(ownerId: string, topicId: string, query: Omit<TopicTermQuery, 'ownerId' | 'topicId'>): Promise<TopicTermSnapshot>
  apply(ownerId: string, topicId: string, expectedVersion: number, command: { readonly kind: 'put'; readonly input: TopicTermPut }): Promise<TermMutationResult>
}
export interface TopicBridgeArchivePort {
  getSnapshot(ownerId: string, topicId: string): TopicArchiveSnapshot
  reconcileAsync?(ownerId: string, topicId: string): Promise<TopicArchiveSnapshot>
  query(ownerId: string, topicId: string, query: Omit<TopicArchiveQuery, 'ownerId' | 'topicId'>): TopicArchiveSnapshot
  queryAsync?(ownerId: string, topicId: string, query: Omit<TopicArchiveQuery, 'ownerId' | 'topicId'>): Promise<TopicArchiveSnapshot>
  apply(ownerId: string, topicId: string, expectedVersion: number, command: { readonly kind: 'put'; readonly input: TopicArchivePut }): Promise<ArchiveMutationResult>
}
type Handle = ReturnType<TopicBridgeRemotePort['connect']>
interface NormalPort {
  prepare(ownerId: string, request: NormalTranslationAcceptance): NormalTranslationReply
  accept(ownerId: string, request: NormalTranslationAcceptance): NormalTranslationReply
  update(ownerId: string, request: NormalTranslationUpdate): NormalTranslationReply
  updateV2(ownerId: string, request: { readonly mainSessionId: string; readonly translationSessionId: string; readonly unitId: string; readonly operationId: string; readonly sourceVersion: number; readonly event: NormalTranslationV2Event }): NormalTranslationReply
  resolveExchange(ownerId: string, request: { readonly translationSessionId: string; readonly exchangeId: string; readonly resolution: NormalTranslationResolution }): NormalTranslationReply
  observe(ownerId: string, request: { readonly translationSessionId: string; readonly operationId: string }): NormalTranslationReply
  resolve(ownerId: string, request: NormalTranslationUnitRequest): NormalTranslationReply
  correctSource(ownerId: string, request: NormalTranslationSourceCorrection): NormalTranslationReply
}
interface Connection {
  refs: number
  generation: number
  controller: AbortController
  handle: Handle | undefined
  ready: boolean
  reason: string | undefined
  requests: Set<string>
}
interface Publication { readonly sessionId: string; readonly topicId: string; readonly fact: TopicUnitFact; readonly automatic: boolean }
function error(requestId: string, code: string, message: string): TopicBridgeReply { return { requestId, ok: false, error: { code, message } } }

/** Browser facts remain authoritative for material, history and terminology. */
export class TopicBridgeClient {
  private readonly connections = new Map<string, Connection>()
  private readonly publications = new Map<string, Publication>()
  private readonly documentPublications = new Map<string, { readonly sessionId: string; readonly topicId: string; readonly unitId: string; readonly sourceVersion: number }>()
  private readonly listeners = new Set<() => void>()
  private readonly stopStore: () => void
  private disposed = false
  private normal: NormalPort | undefined
  private preparation: PreparationStore | undefined
  private documents: DocumentTasksClient | undefined
  private resolvePreparationMaterial: ((envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }>) => Extract<TranslationMaterialEnvelope, { kind: 'material' }> | undefined) | undefined
  private resolvePreparationTarget: ((target: NormalTranslationMaterialTarget) => Extract<TranslationMaterialEnvelope, { kind: 'material' }> | undefined) | undefined
  constructor(private readonly remote: TopicBridgeRemotePort | (() => Promise<TopicBridgeRemotePort | undefined>) | undefined,
    private readonly sessions: SessionStore, private readonly terms: TopicBridgeTermsPort, private readonly archive: TopicBridgeArchivePort) {
    this.stopStore = sessions.subscribe(() => this.reconcile())
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  setNormalTranslation(port: NormalPort): void { this.normal = port }
  setDocumentTasks(port: DocumentTasksClient): void { this.documents = port }
  setPreparation(port: PreparationStore, resolveMaterial: NonNullable<TopicBridgeClient['resolvePreparationMaterial']>, resolveTarget?: TopicBridgeClient['resolvePreparationTarget']): void {
    this.preparation = port; this.resolvePreparationMaterial = resolveMaterial; this.resolvePreparationTarget = resolveTarget
  }
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
      let protocol: 1 | 2 = 1
      if (remote.capabilitiesV2 && remote.connectV2) {
        try {
          const response = await remote.capabilitiesV2() as { readonly ok?: boolean; readonly value?: unknown }
          if (response?.ok === true && parseTopicBridgeV2Capability(response.value).ready) protocol = 2
        } catch { /* Older Host: keep the single v1 connection and text-only execution. */ }
      }
      if (!current()) return
      const handle = protocol === 2 ? remote.connectV2!({ ownerId, mainSessionId: ownerId }, connection.controller.signal)
        : remote.connect({ ownerId, mainSessionId: ownerId }, connection.controller.signal)
      connection.handle = handle
      let opened = false
      for await (const raw of handle) {
        if (!current()) return
        const frame = parseTopicBridgeDown(raw, protocol)
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
        if (protocol === 1 && reply.ok && reply.value.kind === 'unit') {
          reply = { ...reply, value: { ...reply.value, unit: { ...reply.value.unit, revisions: reply.value.unit.revisions.map(revision =>
            revision.status === 'context_requested' ? { ...revision, status: 'failed' as const } : revision) } } }
        }
        handle.send(parseTopicBridgeReply(reply, protocol))
      }
      if (current()) throw new Error('主题管理连接已结束。')
    } catch (failure) {
      if (current()) {
        const code = failure && typeof failure === 'object' && 'code' in failure ? failure.code : undefined
        connection.ready = false
        connection.reason = code === 'connection_occupied' ? '此主会话已由另一窗口连接；请在该窗口继续，或关闭该窗口后重试。' : '主题管理桥暂不可用；本地术语仍可查看。'
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
    const documented = this.documentPublications.get(this.key(ownerId, ref.sessionId, ref.unitId))
    if (documented && documented.topicId === topicId) {
      const session = this.sessions.getSession(ref.sessionId), history = this.sessions.getTranslationHistory(ref.sessionId), unit = history?.units.find(unit => unit.id === ref.unitId)
      if (!session || session.ownerId !== ownerId || session.topicId !== topicId || !unit || !isDocumentUnit(unit) || unit.sourceVersion !== documented.sourceVersion || this.sessions.isSessionDeleted(session.id)) return false
      if (ref.kind === 'source') {
        const source = unit.sourceVersions.find(source => source.version === unit.sourceVersion)!, total = source.body.kind === 'asset' ? source.body.reference.totalCodePoints : Array.from(source.body.text).length
        return (ref.sourceVersion ?? 1) === unit.sourceVersion && (ref.range === null || Number.isSafeInteger(ref.range.start) && Number.isSafeInteger(ref.range.end) && ref.range.start >= 0 && ref.range.end > ref.range.start && ref.range.end <= total)
      }
      const final = currentDocumentFinalRevision(unit), selection = [...(history?.events ?? [])].reverse().find(event => event.type === 'final.selected' && event.unitId === unit.id)
      return final?.id === ref.revisionId && selection?.id === ref.selectionEventId && selection.revisionId === final.id
    }
    const publication = this.publications.get(this.key(ownerId, ref.sessionId, ref.unitId))
    if (!publication || publication.topicId !== topicId) return false
    return ref.kind === 'source' ? publication.fact.sourceVersion === (ref.sourceVersion ?? 1) : (publication.fact.final?.revisionId === ref.revisionId && publication.fact.final.selectionEventId === ref.selectionEventId)
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
    if (command.kind === 'document_correct_observe') {
      const result = await this.documents?.observeCorrection(ownerId, command.request)
      if (result?.ok && result.value) this.publishDocumentUnit(ownerId, result.value.scope.translationSessionId, result.value.unitId, result.value.sourceVersion)
      return result ? result.ok ? success({ kind: 'document_correct_observed', receipt: result.value }) : error(request.requestId, result.error.code, result.error.message) : error(request.requestId, 'unavailable', '纠错查询服务尚未就绪。')
    }
    if (command.kind === 'document_capture' || command.kind === 'document_correct' || command.kind === 'document_accept_unit') {
      if (!this.documents) return error(request.requestId, 'execution_unavailable', '文档范围服务尚未就绪。')
      if (command.kind === 'document_accept_unit') {
        const result = await this.documents.acceptUnit(ownerId, command.request)
        if (result.ok) this.publishDocumentUnit(ownerId, result.value.scope.translationSessionId, result.value.unitId, result.value.sourceVersion)
        return result.ok ? success({ kind: 'document_accepted', receipt: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      if (command.kind === 'document_capture') {
        const result = await this.documents.captureDocument(ownerId, command.request)
        if (result.ok && result.value.tasks.some(task => task.baseline)) this.publishDocumentUnit(ownerId, result.value.scope.translationSessionId, result.value.unitId, result.value.source.version)
        return result.ok ? success({ kind: 'document_captured', capture: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      const result = await this.documents.correctSource(ownerId, command.request)
      if (result.ok) {
        this.publishDocumentUnit(ownerId, result.value.scope.translationSessionId, result.value.unitId, result.value.sourceVersion)
        await this.terms.reconcileAsync?.(ownerId, command.request.scope.topicId)
        await this.archive.reconcileAsync?.(ownerId, command.request.scope.topicId)
      }
      return result.ok ? success({ kind: 'document_corrected', receipt: result.value }) : error(request.requestId, result.error.code, result.error.message)
    }
    if (command.kind === 'document_accept' || command.kind === 'document_register' || command.kind === 'document_event' || command.kind === 'document_finish' || command.kind === 'document_release' || command.kind === 'document_observe' || command.kind === 'document_control' || command.kind === 'document_restore') {
      if (!this.documents) return error(request.requestId, 'execution_unavailable', '整篇执行登记尚未就绪。')
      if (command.kind === 'document_accept') {
        const result = await this.documents.accept(ownerId, command.request)
        if (result.ok) this.publishDocumentUnit(ownerId, result.value.scope.translationSessionId, result.value.unitId, result.value.sourceVersion)
        return result.ok ? success({ kind: 'document_accepted', receipt: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      if (command.kind === 'document_register') {
        const result = this.documents.register(ownerId, command.request)
        return result.ok ? success({ kind: 'document_registered', registration: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      if (command.kind === 'document_observe') {
        const result = this.documents.observe(ownerId, command.request)
        return result.ok ? success({ kind: 'document_observed', receipt: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      if (command.kind === 'document_restore') {
        const result = await this.documents.restore(ownerId, command.request)
        if (result.ok) this.publishDocumentUnit(ownerId, result.value.receipt.scope.translationSessionId, result.value.receipt.unitId, result.value.receipt.sourceVersion)
        return result.ok ? success({ kind: 'document_restored', capture: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      if (command.kind === 'document_control') {
        const result = await this.documents.control(ownerId, command.request)
        if (result.ok && command.request.kind === 'resume') this.publishDocumentUnit(ownerId, result.value.scope.translationSessionId, result.value.unitId, result.value.sourceVersion)
        return result.ok ? success({ kind: 'document_updated', receipt: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      if (command.kind === 'document_release') {
        const result = this.documents.releaseAcknowledgedFinish(ownerId, command.request)
        return result.ok ? success({ kind: 'document_updated', receipt: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      const result = command.kind === 'document_event' ? await this.documents.event(ownerId, command.event) : await this.documents.finish(ownerId, command.request)
      return result.ok ? success({ kind: 'document_updated', receipt: result.value }) : error(request.requestId, result.error.code, result.error.message)
    }
    if (command.kind === 'preparation_review_correction') {
      const target = command.request.target, session = this.sessions.getSession(target.translationSessionId), unit = this.sessions.getTranslationHistory(target.translationSessionId)?.units.find(unit => unit.id === target.unitId)
      if (!this.preparation || target.mainSessionId !== ownerId || !session || session.ownerId !== ownerId || !unit || !isDocumentUnit(unit) || unit.sourceVersion !== target.sourceVersion || this.sessions.isSessionDeleted(session.id)) return error(request.requestId, 'source_mismatch', '纠错准备不属于当前原稿。')
      const source = unit.sourceVersions.find(source => source.version === target.sourceVersion)!, facts = command.facts
      if (facts.unitId !== unit.id || facts.sourceVersion !== source.version || facts.scope.topicId !== session.topicId || facts.scope.translationSessionId !== session.id || facts.scope.ownerId !== ownerId || facts.scope.mainSessionId !== ownerId || source.operationId !== facts.correctionOperationId || source.body.kind === 'asset' && (source.body.reference.sha256 !== facts.sourceSha256 || source.body.reference.totalCodePoints !== facts.totalCodePoints) || !unit.corrections?.some(fact => fact.operationId === facts.correctionOperationId && fact.toSourceVersion === source.version) || !unit.preparations.some(preparation => preparation.id === command.request.preparationId && preparation.version === command.request.expectedVersion)) return error(request.requestId, 'source_mismatch', '纠错准备事实或旧准备引用不一致。')
      const topicTerms = await (this.terms.reconcileAsync?.(ownerId, session.topicId) ?? this.terms.getSnapshot(ownerId, session.topicId))
      const result = await this.preparation.reviewCorrection(command.request, { ...facts, topicTerms })
      if (!result.ok) return error(request.requestId, result.error.code, result.error.message)
      if (!this.sessions.updateTranslationHistory(session.id, history => applyDocumentMutation(history, unit.id, { kind: 'preparation', preparation: { id: result.value.preparationId, version: result.value.version, sourceVersion: source.version } }, result.value.updatedAt))) return error(request.requestId, 'history_update_failed', '新复核准备引用未登记到准确文档。')
      if (this.sessions.getSettings().rememberHistory) await this.sessions.saveTranslationHistoryAsync(session.id)
      return success({ kind: 'preparation_receipt', receipt: result.value })
    }
    if (command.kind === 'preparation_capture') {
      if (!this.preparation || command.request.target.mainSessionId !== ownerId) return error(request.requestId, 'scope_mismatch', '规划准备不属于当前主会话或通道尚未就绪。')
      if (command.request.target.kind === 'unit') {
        const target = command.request.target, session = this.sessions.getSession(target.translationSessionId), unit = this.sessions.getTranslationHistory(target.translationSessionId)?.units.find(unit => unit.id === target.unitId)
        if (!session || session.ownerId !== ownerId || !unit || !isDocumentUnit(unit) || unit.sourceVersion !== target.sourceVersion || this.sessions.isSessionDeleted(session.id)) return error(request.requestId, 'source_mismatch', '规划准备不属于当前文档原稿。')
        const source = unit.sourceVersions.find(source => source.version === target.sourceVersion)!
        const hash = source.body.kind === 'asset' ? source.body.reference.sha256 : [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source.body.text).buffer))].map(byte => byte.toString(16).padStart(2, '0')).join('')
        const topicTerms = await (this.terms.reconcileAsync?.(ownerId, session.topicId) ?? this.terms.getSnapshot(ownerId, session.topicId))
        if (topicTerms.version !== command.topicTermsVersion) return error(request.requestId, 'stale_terms', '原稿核对后用户固定规则已变化。')
        const result = await this.preparation.captureUnit(command.request, hash, topicTerms, command.relevantFixedIds, snapshot => new TextEncoder().encode(JSON.stringify(success({ kind: 'preparation_captured', snapshot }))).byteLength)
        return result.ok ? success({ kind: 'preparation_captured', snapshot: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      const envelope = this.resolvePreparationTarget?.(command.request.target), session = envelope && this.sessions.getSession(envelope.material.translationSessionId)
      if (!envelope || envelope.ownerId !== ownerId || envelope.mainSessionId !== ownerId || !session || session.ownerId !== ownerId ||
        session.topicId !== envelope.material.topicId || this.sessions.isSessionDeleted(session.id) || session.mode !== 'normal') return error(request.requestId, 'material_mismatch', '规划要求的材料不是当前主会话确切交付的固定材料。')
      const topicTerms = await (this.terms.reconcileAsync?.(ownerId, session.topicId) ?? this.terms.getSnapshot(ownerId, session.topicId))
      if (topicTerms.version !== command.topicTermsVersion) return error(request.requestId, 'stale_terms', '固定条目在原稿核对后已变化，请重新取得规划准备。')
      const result = await this.preparation.capture(command.request, { envelope, topicTerms }, command.relevantFixedIds, snapshot => new TextEncoder().encode(JSON.stringify(success({ kind: 'preparation_captured', snapshot }))).byteLength)
      return result.ok ? success({ kind: 'preparation_captured', snapshot: result.value }) : error(request.requestId, result.error.code, result.error.message)
    }
    if (command.kind === 'preparation_prepare' || command.kind === 'preparation_set' || command.kind === 'preparation_status' || command.kind === 'preparation_read') {
      if (!this.preparation || command.request.target.mainSessionId !== ownerId) return error(request.requestId, 'scope_mismatch', '准备记录不属于当前主会话或通道尚未就绪。')
      const measure = (page: PreparationPage) => new TextEncoder().encode(JSON.stringify(success({ kind: 'preparation_page', page }))).byteLength
      let result
      if (command.kind === 'preparation_prepare' || command.kind === 'preparation_set') {
        const envelope = this.resolvePreparationMaterial?.(command.envelope), session = envelope && this.sessions.getSession(envelope.material.translationSessionId)
        if (!envelope || envelope.ownerId !== ownerId || envelope.mainSessionId !== ownerId || !session || session.ownerId !== ownerId ||
          session.topicId !== envelope.material.topicId || this.sessions.isSessionDeleted(session.id) || session.mode !== 'normal') return error(request.requestId, 'material_mismatch', '准备要求的材料不是当前主会话确切交付的固定材料。')
        const topicTerms = await (this.terms.reconcileAsync?.(ownerId, session.topicId) ?? this.terms.getSnapshot(ownerId, session.topicId))
        result = command.kind === 'preparation_prepare' ? await this.preparation.prepare(command.request, { envelope, analysis: command.analysis, topicTerms }, measure)
          : await this.preparation.set(command.request, { envelope, topicTerms }, measure)
      } else if (command.kind === 'preparation_status') result = this.preparation.status(command.request, command.request.target.kind === 'material' ? this.resolvePreparationTarget?.(command.request.target) : undefined)
      else result = this.preparation.read(command.request, measure)
      if (!result.ok) return error(request.requestId, result.error.code, result.error.message)
      const value: TopicBridgeValue = command.kind === 'preparation_read' ? { kind: 'preparation_page', page: result.value as PreparationPage }
        : { kind: 'preparation_receipt', receipt: result.value as PreparationReceipt }
      if (new TextEncoder().encode(JSON.stringify(success(value))).byteLength > MAX_ANALYSIS_PAGE_BYTES) return error(request.requestId, 'reply_too_large', '完整准备回执超过 32768 字节，未截断字段。')
      return success(value)
    }
    if (command.kind === 'normal_resolve' || command.kind === 'normal_correct_source') {
      const target = command.target, publication = this.publications.get(this.key(ownerId, target.translationSessionId, target.unitId))
      if (target.mainSessionId !== ownerId || !publication) return error(request.requestId, 'reference_not_published', '此单元尚未明确提供给当前主模型。')
      const { kind, ...payload } = command
      const result = kind === 'normal_resolve' ? this.normal?.resolve(ownerId, payload as NormalTranslationUnitRequest) : this.normal?.correctSource(ownerId, payload as NormalTranslationSourceCorrection)
      if (result?.ok && result.value.kind === 'normal_source_corrected') this.publishAdmittedUnit(ownerId, target.translationSessionId, target.unitId, publication.automatic)
      return result ? { requestId: request.requestId, ...result } : error(request.requestId, 'execution_unavailable', '普通单元处理通道尚未就绪。')
    }
    if (command.kind === 'normal_observe') {
      const result = this.normal?.observe(ownerId, command)
      return result ? { requestId: request.requestId, ...result } : error(request.requestId, 'execution_unavailable', '普通翻译业务通道尚未就绪。')
    }
    if (command.kind === 'normal_accept' || command.kind === 'normal_prepare' || command.kind === 'normal_update') {
      const { kind, ...payload } = command
      if (kind !== 'normal_update' && 'envelope' in payload && payload.envelope.material.unitReference && !this.isPublished(ownerId, payload.envelope.material.translationSessionId, payload.envelope.material.unitReference.unitId)) return error(request.requestId, 'reference_not_published', '此单元参考已撤回。')
      const result = kind === 'normal_update' ? this.normal?.update(ownerId, payload as NormalTranslationUpdate)
        : kind === 'normal_prepare' ? this.normal?.prepare(ownerId, payload as NormalTranslationAcceptance)
        : this.normal?.accept(ownerId, payload as NormalTranslationAcceptance)
      if (result?.ok && result.value.kind === 'normal_operation') this.publishAdmittedUnit(ownerId, result.value.operation.translationSessionId, result.value.operation.unitId)
      return result ? { requestId: request.requestId, ...result } : error(request.requestId, 'execution_unavailable', '普通翻译业务通道尚未就绪。')
    }
    if (command.kind === 'normal_v2_update') {
      if (command.mainSessionId !== ownerId || !this.isPublished(ownerId, command.translationSessionId, command.unitId)) return error(request.requestId, 'reference_not_published', '普通翻译单元未由当前主会话明确提供。')
      const { kind: _kind, ...payload } = command
      const result = this.normal?.updateV2(ownerId, payload)
      return result ? { requestId: request.requestId, ...result } : error(request.requestId, 'execution_unavailable', '普通翻译 v2 通道尚未就绪。')
    }
    if (command.kind === 'normal_exchange_resolve') {
      const result = this.normal?.resolveExchange(ownerId, command)
      return result ? { requestId: request.requestId, ...result } : error(request.requestId, 'execution_unavailable', '普通翻译 exchange 通道尚未就绪。')
    }
    if (command.kind === 'list_sessions') return success({ kind: 'sessions', sessions: this.sessions.getAvailableSessions(ownerId).filter(session => !this.sessions.isSessionDeleted(session.id)).map(session => this.sessionSummary(session)) })
    if (command.kind === 'list_topics') return success({ kind: 'topics', topics: this.sessions.getTopics(ownerId).map(topic => ({ ...topic,
      sessionIds: this.sessions.getAvailableSessions(ownerId).filter(session => session.topicId === topic.id && !this.sessions.isSessionDeleted(session.id)).map(session => session.id) })) })
    if (command.kind === 'list_topic_terms') {
      if (!this.sessions.getTopics(ownerId).some(topic => topic.id === command.topicId)) return error(request.requestId, 'out_of_scope', '主题不属于当前主会话或不存在。')
      return success({ kind: 'terms', snapshot: await (this.terms.reconcileAsync?.(ownerId, command.topicId) ?? this.terms.getSnapshot(ownerId, command.topicId)) })
    }
    if (command.kind === 'list_topic_archive' || command.kind === 'upsert_archive') {
      if (!this.sessions.getTopics(ownerId).some(topic => topic.id === command.topicId)) return error(request.requestId, 'out_of_scope', '主题不属于当前主会话或不存在。')
      if (command.kind === 'list_topic_archive') return success({ kind: 'archive', snapshot: await (this.archive.reconcileAsync?.(ownerId, command.topicId) ?? this.archive.getSnapshot(ownerId, command.topicId)) })
      if (!command.entry.evidence.every(ref => this.publishedEvidence(ownerId, command.topicId, ref))) return error(request.requestId, 'reference_not_published', '档案依据不在用户明确提供的历史范围中。')
      const result = await this.archive.apply(ownerId, command.topicId, command.expectedVersion, { kind: 'put', input: command.entry })
      if (result.status === 'save_failed') return error(request.requestId, result.status, '当前档案内容可能已更新但未保存，请先查询当前版本后明确重试。')
      if (result.status !== 'updated' && result.status !== 'unchanged') return error(request.requestId, result.status, '档案提交未完成，请核对当前版本及依据。')
      return success({ kind: 'archive', snapshot: result.snapshot })
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
      case 'list_terms': return success({ kind: 'terms', snapshot: await (this.terms.reconcileAsync?.(ownerId, session.topicId) ?? this.terms.getSnapshot(ownerId, session.topicId)) })
      case 'query_terms': {
        const query = { mode: session.mode, sourceLanguage: command.sourceLanguage, targetLanguage: command.targetLanguage, forms: command.forms }
        const snapshot = await (this.terms.queryAsync?.(ownerId, session.topicId, query) ?? this.terms.query(ownerId, session.topicId, query))
        return success({ kind: 'terms_query', snapshot })
      }
      case 'query_archive': {
        const query = { mode: session.mode, kinds: command.kinds, forms: command.forms }
        const snapshot = await (this.archive.queryAsync?.(ownerId, session.topicId, query) ?? this.archive.query(ownerId, session.topicId, query))
        return success({ kind: 'archive_query', snapshot })
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
    const unit = history?.units.find(unit => unit.id === unitId)
    if (!unit || !isTextUnit(unit)) return false
    const latest = unit.revisions.at(-1)
    if (this.disposed || !session || session.ownerId !== ownerId || this.sessions.isSessionDeleted(session.id) || session.mode !== 'normal' || !unit || !latest || !['completed', 'failed', 'cancelled', 'interrupted', 'context_requested'].includes(latest.status)) return false
    const event = [...history!.events].reverse().find(event => event.type === 'final.selected' && event.unitId === unitId)
    const final = currentFinalRevision(unit)
    const fact: TopicUnitFact = { id: unit.id, order: unit.order, source: unit.source, sourceVersion: unit.sourceVersion, targetLanguage: unit.targetLanguage, instruction: unit.instruction,
      revisions: unit.revisions.map(({ id, order, kind, status, text, baseRevisionId, sourceVersion }) => ({ id, order, kind, status, text, baseRevisionId, sourceVersion })),
      final: final && unit.final && event?.revisionId === final.id ? { revisionId: final.id, selection: unit.final.selection, selectionEventId: event.id } : null }
    // Include the largest allowed correlation ID so every future request fits without truncation.
    const reply: TopicBridgeReply = { requestId: 'x'.repeat(2048), ok: true, value: { kind: 'unit', unit: fact } }
    if (new TextEncoder().encode(JSON.stringify(reply)).byteLength > MAX_TOPIC_BRIDGE_REPLY_BYTES) return false
    this.publications.set(this.key(ownerId, sessionId, unitId), { sessionId, topicId: session.topicId, fact: structuredClone(fact), automatic: false })
    this.emit(); return true
  }
  private publishAdmittedUnit(ownerId: string, sessionId: string, unitId: string, automatic = true): void {
    const session = this.sessions.getSession(sessionId), history = this.sessions.getTranslationHistory(sessionId)
    const unit = history?.units.find(unit => unit.id === unitId)
    if (!session || session.ownerId !== ownerId || !unit || !isTextUnit(unit)) return
    const event = [...history!.events].reverse().find(event => event.type === 'final.selected' && event.unitId === unitId)
    const final = currentFinalRevision(unit)
    const fact: TopicUnitFact = { id: unit.id, order: unit.order, source: unit.source, sourceVersion: unit.sourceVersion, targetLanguage: unit.targetLanguage, instruction: unit.instruction,
      revisions: unit.revisions.map(({ id, order, kind, status, text, baseRevisionId, sourceVersion }) => ({ id, order, kind, status, text, baseRevisionId, sourceVersion })),
      final: final && unit.final && event?.revisionId === final.id ? { revisionId: final.id, selection: unit.final.selection, selectionEventId: event.id } : null }
    this.publications.set(this.key(ownerId, sessionId, unitId), { sessionId, topicId: session.topicId, fact, automatic })
    this.emit()
  }
  private publishDocumentUnit(ownerId: string, sessionId: string, unitId: string, sourceVersion: number): void {
    const session = this.sessions.getSession(sessionId), unit = this.sessions.getTranslationHistory(sessionId)?.units.find(unit => unit.id === unitId)
    if (!session || session.ownerId !== ownerId || this.sessions.isSessionDeleted(sessionId) || !unit || !isDocumentUnit(unit) || unit.sourceVersion !== sourceVersion) return
    this.documentPublications.set(this.key(ownerId, sessionId, unitId), { sessionId, topicId: session.topicId, unitId, sourceVersion })
  }
  isPublished(ownerId: string, sessionId: string, unitId: string): boolean { const key = this.key(ownerId, sessionId, unitId); return this.publications.has(key) || this.documentPublications.has(key) }
  revokeUnit(ownerId: string, sessionId: string, unitId: string): void { const key = this.key(ownerId, sessionId, unitId); this.publications.delete(key); this.documentPublications.delete(key); this.emit() }
  private reconcile(): void {
    let changed = false
    for (const [key, publication] of this.documentPublications) {
      const session = this.sessions.getSession(publication.sessionId), unit = this.sessions.getTranslationHistory(publication.sessionId)?.units.find(unit => unit.id === publication.unitId)
      if (!session || this.sessions.isSessionDeleted(session.id) || session.topicId !== publication.topicId || !unit || !isDocumentUnit(unit)) this.documentPublications.delete(key)
    }
    for (const [key, publication] of this.publications) {
      const session = this.sessions.getSession(publication.sessionId)
      if (!session || this.sessions.isSessionDeleted(publication.sessionId) || session.topicId !== publication.topicId || !this.sessions.getTranslationHistory(publication.sessionId)?.units.some(unit => unit.id === publication.fact.id)) {
        this.publications.delete(key); changed = true
      } else if (publication.automatic) this.publishAdmittedUnit(session.ownerId, session.id, publication.fact.id)
    }
    if (changed) this.emit()
  }
  async reset(onlyOwnerId?: string): Promise<void> {
    for (const [ownerId, connection] of this.connections) {
      if (onlyOwnerId !== undefined && ownerId !== onlyOwnerId) continue
      connection.generation++; connection.controller.abort(); await this.closeHandle(connection.handle)
      if (this.disposed || this.connections.get(ownerId) !== connection) continue
      connection.controller = new AbortController(); connection.handle = undefined; connection.ready = false; connection.reason = undefined; connection.requests.clear()
      void this.open(ownerId, connection)
    }
    this.emit()
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true; this.stopStore(); this.publications.clear(); this.documentPublications.clear(); this.listeners.clear()
    const closing = [...this.connections.values()].map(async connection => {
      connection.generation++; connection.controller.abort(); await this.closeHandle(connection.handle)
    })
    this.connections.clear(); await Promise.all(closing)
  }
}
