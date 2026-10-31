import { isFileJobUnit } from './translation-history.js'
import { ReferenceStore } from './reference-store.js'
import {
  MAX_TOPIC_BRIDGE_REPLY_BYTES, parseLibraryConnection, parseTopicBridgeCapability, parseTopicBridgeV2Capability, parseTopicBridgeDown, parseTopicBridgeReply,
  type TopicBridgeOpen, type TopicBridgeReply, type TopicBridgeRequest, type TopicBridgeValue, type TopicUnitFact, type TopicSessionSummary,
} from '../shared/topic-bridge.js'
import type { TopicTermSnapshot, TopicTermPut, TermMutationResult, TermEvidenceRef, TopicTermQuery, TopicTerm } from '../memory/topic-terms.js'
import { referencedEntityIds, type TopicArchiveSnapshot, type TopicArchivePut, type ArchiveMutationResult, type TopicArchiveQuery, type TopicArchiveEntry } from '../memory/topic-archive.js'
import { assetPriority } from '../memory/asset-priority.js'
import type { SessionStore } from './session-store.js'
import type { LocalSession } from './sessions.js'
import type { NormalTranslationAcceptance, NormalTranslationUpdate, DirectTranslationCommit, NormalTranslationTarget } from '../shared/normal-translation.js'
import type { NormalTranslationUnitRequest, NormalTranslationSourceCorrection } from '../shared/normal-translation.js'
import type { NormalTranslationResolution, NormalTranslationV2Event } from '../shared/normal-translation-v2.js'
import { currentFinalRevision, currentDocumentFinalRevision, isTextUnit, isDocumentUnit, applyDocumentMutation, type TranslationHistory, type TextUnit } from './translation-history.js'
import type { NormalTranslationReply } from './normal-translation.js'
import type { PreparationStore } from './preparation-store.js'
import type { TranslationMaterialEnvelope } from '../shared/translation-material.js'
import { MAX_ANALYSIS_PAGE_BYTES, type PreparationReceipt, type PreparationPage } from '../shared/translation-preparation.js'
import type { NormalTranslationMaterialTarget } from '../shared/normal-translation.js'
import type { FileHistoryClient } from './file-history.js'
import type { DocumentTasksClient } from './document-tasks.js'
import type { DocumentReviewClient } from './document-review-client.js'
import { planDocumentTermSedimentation } from './document-term-sedimentation.js'
import { NumberedUnits } from './numbered-units.js'

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export interface TopicBridgeRemotePort {
  connectLibrary?(identity: { readonly namespaceId: string }, signal?: AbortSignal): AsyncIterable<unknown> & { dispose(): void | Promise<void> }
  capabilities(): Promise<unknown>
  capabilitiesV2?(): Promise<unknown>
  capabilitiesV3?(): Promise<unknown>
  capabilitiesV4?(): Promise<unknown>
  connectV4?: TopicBridgeRemotePort['connect']
  connectV3?: TopicBridgeRemotePort['connect']
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
  ensureLoaded(ownerId: string, topicId: string): Promise<TopicArchiveSnapshot>
  reconcileAsync?(ownerId: string, topicId: string): Promise<TopicArchiveSnapshot>
  query(ownerId: string, topicId: string, query: Omit<TopicArchiveQuery, 'ownerId' | 'topicId'>): TopicArchiveSnapshot
  queryAsync?(ownerId: string, topicId: string, query: Omit<TopicArchiveQuery, 'ownerId' | 'topicId'>): Promise<TopicArchiveSnapshot>
  apply(ownerId: string, topicId: string, expectedVersion: number, command: { readonly kind: 'put'; readonly input: TopicArchivePut }): Promise<ArchiveMutationResult>
}
/** Read-only view of the terms a document task actually adopted; it never exposes source bodies. */
export interface DocumentTaskTermSummary {
  readonly sourceForms: readonly string[]
  readonly preferred: string
  readonly sense: string
  readonly userFixed: boolean
  readonly rangeCount: number
}
export interface DocumentTaskTermsView {
  readonly status: 'ready' | 'unavailable'
  readonly terms: readonly DocumentTaskTermSummary[]
  readonly message?: string | undefined
}
export interface DocumentTermSedimentResult {
  readonly status: 'completed' | 'unavailable' | 'failed'
  readonly added: number
  readonly skipped: number
  readonly message: string
}
type Handle = ReturnType<TopicBridgeRemotePort['connect']>
interface NormalPort {
  recoverInterrupted(sessionId: string, ownerId?: string): Promise<void>
  prepare(ownerId: string, request: NormalTranslationAcceptance): NormalTranslationReply
  accept(ownerId: string, request: NormalTranslationAcceptance): NormalTranslationReply
  commitResult(ownerId: string, request: DirectTranslationCommit): NormalTranslationReply
  exportResult(ownerId: string, request: { readonly target: NormalTranslationTarget; readonly totalCodePoints?: number }): NormalTranslationReply
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
function error(requestId: string, code: string, message: string): TopicBridgeReply { return { requestId, ok: false, error: { code, message } } }
function writeEntry(entry: TopicTerm | TopicArchiveEntry) {
  return { id: entry.id, version: entry.version, status: entry.status, origin: entry.origin, priority: assetPriority(entry) }
}

/** Browser facts remain authoritative for material, history and terminology. */
export class TopicBridgeClient {
  private readonly numbered: NumberedUnits
  private libraryController: AbortController | undefined
  private libraryHandle: (AsyncIterable<unknown> & { dispose(): void | Promise<void> }) | undefined
  private libraryReady = false
  private libraryReason: string | undefined
  getLibraryStatus(): { readonly ready: boolean; readonly reason: string | undefined } { return { ready: this.libraryReady, reason: this.libraryReason } }
  async connectLibrary(): Promise<void> {
    this.libraryController?.abort(); await this.closeHandle(this.libraryHandle)
    const controller = new AbortController(); this.libraryController = controller; this.libraryReady = false
    try {
      const remote = typeof this.remote === 'function' ? await this.remote() : this.remote
      if (controller.signal.aborted || this.disposed) return
      if (!remote?.connectLibrary) throw new Error('宿主不支持独立资料库连接，请加载匹配版本。')
      const namespaceId = this.sessions.getNamespaceId(), handle = remote.connectLibrary({ namespaceId }, controller.signal)
      this.libraryHandle = handle
      for await (const raw of handle) {
        if (controller.signal.aborted || this.disposed) return
        const reply = parseLibraryConnection(raw)
        if (reply.namespaceId !== namespaceId) throw new Error('资料库连接身份不一致。')
        this.libraryReady = true; this.libraryReason = undefined; this.emit()
      }
    } catch (error) { if (!controller.signal.aborted) this.libraryReason = error instanceof Error ? error.message : '资料库连接中断。' }
    finally { if (this.libraryController === controller) { this.libraryReady = false; this.emit() } }
  }
  private references: ReferenceStore | undefined
  setReferences(references: ReferenceStore): void { this.references = references }
  private readonly connections = new Map<string, Connection>()
  private readonly listeners = new Set<() => void>()
  private readonly stopStore: () => void
  private disposed = false
  private normal: NormalPort | undefined
  private preparation: PreparationStore | undefined
  private documents: DocumentTasksClient | undefined
  private files: FileHistoryClient | undefined
  setFileHistory(files: FileHistoryClient): void { this.files = files }
  private documentReviews: DocumentReviewClient | undefined
  private resolvePreparationMaterial: ((envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }>) => Extract<TranslationMaterialEnvelope, { kind: 'material' }> | undefined) | undefined
  private resolvePreparationTarget: ((target: NormalTranslationMaterialTarget) => Extract<TranslationMaterialEnvelope, { kind: 'material' }> | undefined) | undefined
  constructor(private readonly remote: TopicBridgeRemotePort | (() => Promise<TopicBridgeRemotePort | undefined>) | undefined,
    private readonly sessions: SessionStore, private readonly terms: TopicBridgeTermsPort, private readonly archive: TopicBridgeArchivePort) {
    this.numbered = new NumberedUnits(sessions, () => this.files)
    this.stopStore = sessions.subscribe(() => this.emit())
    void this.connectLibrary()
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  /** Active term count for the material notice; undefined means the local term store is unavailable. */
  termCount(ownerId: string, topicId: string): number | undefined {
    try { return this.terms.getSnapshot(ownerId, topicId).entries.filter(entry => entry.status === 'active').length } catch { return undefined }
  }
  setNormalTranslation(port: NormalPort): void { this.normal = port }
  setDocumentTasks(port: DocumentTasksClient): void { this.documents = port }
  setDocumentReviews(port: DocumentReviewClient): void { this.documentReviews = port }
  setPreparation(port: PreparationStore, resolveMaterial: NonNullable<TopicBridgeClient['resolvePreparationMaterial']>, resolveTarget?: TopicBridgeClient['resolvePreparationTarget']): void {
    this.preparation = port; this.resolvePreparationMaterial = resolveMaterial; this.resolvePreparationTarget = resolveTarget
  }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  /** Reuse a live local-library connection for asset persistence, including assets created by an old Session. */
  getLibraryOwner(): string | undefined {
    return [...this.connections].find(([, connection]) => connection.ready && !connection.controller.signal.aborted)?.[0]
      ?? [...this.connections].find(([, connection]) => !connection.controller.signal.aborted)?.[0]
  }
  getStatus(ownerId: string): { readonly ready: boolean; readonly reason: string | undefined } {
    if (!this.sessions.isHistoryReady()) return { ready: false, reason: this.sessions.getNotice() ?? '正在读取宿主会话历史，请稍候。' }
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
      if (!remote.capabilitiesV4 || !remote.connectV4) throw new Error('内容协议不匹配，请同时加载支持资料库解耦的 Host 与 Client。')
      const responseV4 = await remote.capabilitiesV4() as { ok?: boolean; value?: { ready?: boolean; contentProtocol?: number; reason?: string } }
      if (responseV4.ok !== true || !responseV4.value?.ready || responseV4.value.contentProtocol !== 3) throw new Error(responseV4.value?.reason ?? '内容协议不匹配。')
      if (!this.libraryReady) await new Promise<void>((resolve, reject) => {
        let stop: () => void = () => {}
        const timer = setTimeout(() => { stop(); reject(new Error(this.libraryReason ?? '资料库连接尚未就绪。')) }, 15000)
        const check = (): void => { if (this.libraryReady) { clearTimeout(timer); stop(); resolve() } else if (!current()) { clearTimeout(timer); stop(); reject(new Error('原执行连接已关闭。')) } }
        stop = this.subscribe(check); check()
      })
      if (!current()) return
      const protocol = 4
      const handle = remote.connectV4({ mainSessionId: ownerId, namespaceId: this.sessions.getNamespaceId() }, connection.controller.signal)
      connection.handle = handle
      let opened = false
      for await (const raw of handle) {
        if (!current()) return
        const frame = parseTopicBridgeDown(raw, protocol)
        if (frame.kind === 'ready') {
          if (opened || frame.namespaceId !== this.sessions.getNamespaceId() || frame.mainSessionId !== ownerId) throw new Error('主题管理连接归属无效。')
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
  private async closeHandle(handle: { dispose(): void | Promise<void> } | undefined): Promise<void> {
    try { await handle?.dispose() }
    catch { console.error('[dsh-translation-plugin] Topic bridge stream cleanup failed.') }
  }
  private accessibleEvidence(ownerId: string, topicId: string, ref: TermEvidenceRef): boolean {
    const session = this.sessions.getSession(ref.sessionId), history = this.sessions.getTranslationHistory(ref.sessionId)
    const unit = history?.units.find(unit => unit.id === ref.unitId)
    if (!session || session.topicId !== topicId || !unit || !this.sessions.canAccessUnit(ownerId, session.id, unit.id)) return false
    if (isFileJobUnit(unit)) return this.files?.hasEvidence(ownerId, topicId, ref) ?? false
    if (ref.kind === 'source') {
      const source = unit.sourceVersions.find(source => source.version === unit.sourceVersion)!
      const total = isTextUnit(unit) ? Array.from(unit.source).length : 'body' in source ? (source.body.kind === 'inline' ? Array.from(source.body.text).length : source.body.reference.totalCodePoints) : 0
      return (ref.sourceVersion ?? 1) === unit.sourceVersion && (ref.range === null || ref.range.start >= 0 && ref.range.end > ref.range.start && ref.range.end <= total)
    }
    const final = isTextUnit(unit) ? currentFinalRevision(unit) : currentDocumentFinalRevision(unit)
    const selection = [...(history?.events ?? [])].reverse().find(event => event.type === 'final.selected' && event.unitId === unit.id)
    return final?.id === ref.revisionId && selection?.id === ref.selectionEventId && selection.revisionId === final.id
  }
  private sessionSummary(session: LocalSession, ownerId: string): TopicSessionSummary {
    return { id: session.id, topicId: session.topicId, name: session.name, mode: session.mode,
      topicName: session.topicName, sequence: session.sequence, remark: session.remark, archived: session.archivedAt !== null,
      active: this.sessions.getActiveSession(ownerId)?.id === session.id }
  }
  private async dispatch(ownerId: string, request: TopicBridgeRequest): Promise<TopicBridgeReply> {
    if (!this.sessions.isHistoryReady()) return error(request.requestId, 'operation_failed', this.sessions.getNotice() ?? '正在读取宿主会话历史，请稍候。')
    const command = request.command
    const success = (value: TopicBridgeValue): TopicBridgeReply => ({ requestId: request.requestId, ok: true, value })
    if (command.kind === 'list_units' || command.kind === 'read_units') {
      const { kind, ...payload } = command
      try { return kind === 'list_units' ? success({ kind: 'unit_directory', directory: this.numbered.list(ownerId, payload) }) : success({ kind: 'unit_contents', contents: await this.numbered.read(ownerId, payload) }) }
      catch (cause) { return error(request.requestId, String((cause as { code?: string }).code ?? 'unit_read_failed'), (cause as Error).message) }
    }
    if (command.kind === 'file_history') {
      if (!this.files) return error(request.requestId, 'file_history_unavailable', '历史文件服务尚未就绪。')
      try { return success({ kind: 'file_history', value: await this.files.handle(ownerId, command.request) }) }
      catch (cause) { return error(request.requestId, String((cause as { code?: string }).code ?? 'file_history_failed'), (cause as Error).message) }
    }
    if (command.kind === 'document_review_page' || command.kind === 'document_review_read' || command.kind === 'document_review_begin' || command.kind === 'document_review_submit' || command.kind === 'document_review_observe' || command.kind === 'document_review_manual') {
      if (!this.documentReviews) return error(request.requestId, 'review_unavailable', '整篇复核服务尚未就绪。')
      if (command.kind === 'document_review_page') {
        const result = await this.documentReviews.page(ownerId, command.request)
        return result.ok ? success({ kind: 'document_review_page', page: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      if (command.kind === 'document_review_read') {
        const result = await this.documentReviews.read(ownerId, command.request)
        return result.ok ? success({ kind: 'document_review_text', page: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      if (command.kind === 'document_review_observe') {
        const result = await this.documentReviews.observe(ownerId, command.request)
        return result.ok ? success({ kind: 'document_review_observed', receipt: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      if (command.kind === 'document_review_manual') {
        const result = await this.documentReviews.manual(command.request, false)
        return result.ok ? success({ kind: 'document_review_receipt', receipt: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      const result = command.kind === 'document_review_begin' ? await this.documentReviews.begin(ownerId, command.request) : await this.documentReviews.submit(ownerId, command.request)
      return result.ok ? success({ kind: 'document_review_receipt', receipt: result.value }) : error(request.requestId, result.error.code, result.error.message)
    }
    if (command.kind === 'document_task_terms') {
      const termsRequest = command.request, session = this.sessions.getSession(termsRequest.scope.translationSessionId)
      if (termsRequest.scope.ownerId !== ownerId || termsRequest.scope.mainSessionId !== ownerId || !session || !this.sessions.isSessionOpen(ownerId, session.id) ||
        session.topicId !== termsRequest.scope.topicId || this.sessions.isSessionDeleted(session.id)) return error(request.requestId, 'scope_mismatch', '任务术语不属于当前主会话。')
      const unit = this.sessions.getTranslationHistory(session.id)?.units.find(item => item.id === termsRequest.unitId)
      if (!unit || !isDocumentUnit(unit) || unit.sourceVersion !== termsRequest.sourceVersion) return error(request.requestId, 'source_mismatch', '任务术语不属于当前文档原稿版本。')
      const view = await this.documentTaskTerms(ownerId, session.id, unit.id, termsRequest.preparationRef)
      if (view.status !== 'ready') return success({ kind: 'document_task_terms', terms: [], added: 0, skipped: 0, message: view.message ?? '尚无匹配的任务准备记录。' })
      let added = 0, skipped = 0, message = view.terms.length ? `本任务采用 ${view.terms.length} 条术语。` : '本任务没有采用的术语。'
      if (termsRequest.apply) {
        const result = await this.sedimentDocumentTaskTerms(ownerId, session.id, unit.id, termsRequest.preparationRef)
        added = result.added; skipped = result.skipped; message = result.message
      }
      return success({ kind: 'document_task_terms', terms: view.terms, added, skipped, message })
    }
    if (command.kind === 'document_correct_observe') {
      const result = await this.documents?.observeCorrection(ownerId, command.request)
      return result ? result.ok ? success({ kind: 'document_correct_observed', receipt: result.value }) : error(request.requestId, result.error.code, result.error.message) : error(request.requestId, 'unavailable', '纠错查询服务尚未就绪。')
    }
    if (command.kind === 'document_capture' || command.kind === 'document_correct' || command.kind === 'document_accept_unit') {
      if (!this.documents) return error(request.requestId, 'execution_unavailable', '文档范围服务尚未就绪。')
      if (command.kind === 'document_accept_unit') {
        const result = await this.documents.acceptUnit(ownerId, command.request)
        return result.ok ? success({ kind: 'document_accepted', receipt: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      if (command.kind === 'document_capture') {
        const result = await this.documents.captureDocument(ownerId, command.request)
        return result.ok ? success({ kind: 'document_captured', capture: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      const result = await this.documents.correctSource(ownerId, command.request)
      if (result.ok) {
        await this.terms.reconcileAsync?.(ownerId, command.request.scope.topicId)
        await this.archive.reconcileAsync?.(ownerId, command.request.scope.topicId)
      }
      return result.ok ? success({ kind: 'document_corrected', receipt: result.value }) : error(request.requestId, result.error.code, result.error.message)
    }
    if (command.kind === 'document_accept' || command.kind === 'document_register' || command.kind === 'document_event' || command.kind === 'document_finish' || command.kind === 'document_release' || command.kind === 'document_observe' || command.kind === 'document_control' || command.kind === 'document_restore') {
      if (!this.documents) return error(request.requestId, 'execution_unavailable', '整篇执行登记尚未就绪。')
      if (command.kind === 'document_accept') {
        const result = await this.documents.accept(ownerId, command.request)
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
        return result.ok ? success({ kind: 'document_restored', capture: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      if (command.kind === 'document_control') {
        const result = await this.documents.control(ownerId, command.request)
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
      if (!this.preparation || target.mainSessionId !== ownerId || !session || !unit || !isDocumentUnit(unit) || unit.sourceVersion !== target.sourceVersion || this.sessions.isSessionDeleted(session.id)) return error(request.requestId, 'source_mismatch', '纠错准备不属于当前原稿。')
      const source = unit.sourceVersions.find(source => source.version === target.sourceVersion)!, facts = command.facts
      if (facts.unitId !== unit.id || facts.sourceVersion !== source.version || facts.scope.topicId !== session.topicId || facts.scope.translationSessionId !== session.id || facts.scope.ownerId !== ownerId || facts.scope.mainSessionId !== ownerId || source.operationId !== facts.correctionOperationId || source.body.kind === 'asset' && (source.body.reference.sha256 !== facts.sourceSha256 || source.body.reference.totalCodePoints !== facts.totalCodePoints) || !unit.corrections?.some(fact => fact.operationId === facts.correctionOperationId && fact.toSourceVersion === source.version) || !unit.preparations.some(preparation => preparation.id === command.request.preparationId && preparation.version === command.request.expectedVersion)) return error(request.requestId, 'source_mismatch', '纠错准备事实或旧准备引用不一致。')
      const topicTerms = await (this.terms.reconcileAsync?.(ownerId, session.topicId) ?? this.terms.getSnapshot(ownerId, session.topicId))
      const result = await this.preparation.reviewCorrection(command.request, { ...facts, topicTerms })
      if (!result.ok) return error(request.requestId, result.error.code, result.error.message)
      if (!this.sessions.updateTranslationHistory(session.id, history => applyDocumentMutation(history, unit.id, { kind: 'preparation', preparation: { id: result.value.preparationId, version: result.value.version, sourceVersion: source.version } }, result.value.updatedAt))) return error(request.requestId, 'history_update_failed', '新复核准备引用未登记到准确文档。')
      await this.sessions.saveTranslationHistoryAsync(session.id)
      return success({ kind: 'preparation_receipt', receipt: result.value })
    }
    if (command.kind === 'preparation_capture') {
      if (!this.preparation || command.request.target.mainSessionId !== ownerId) return error(request.requestId, 'scope_mismatch', '规划准备不属于当前主会话或通道尚未就绪。')
      if (command.request.target.kind === 'unit') {
        const target = command.request.target, session = this.sessions.getSession(target.translationSessionId), unit = this.sessions.getTranslationHistory(target.translationSessionId)?.units.find(unit => unit.id === target.unitId)
        if (!session || !unit || !isDocumentUnit(unit) || unit.sourceVersion !== target.sourceVersion || this.sessions.isSessionDeleted(session.id)) return error(request.requestId, 'source_mismatch', '规划准备不属于当前文档原稿。')
        const source = unit.sourceVersions.find(source => source.version === target.sourceVersion)!
        const hash = source.body.kind === 'asset' ? source.body.reference.sha256 : [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source.body.text).buffer))].map(byte => byte.toString(16).padStart(2, '0')).join('')
        const topicTerms = await (this.terms.reconcileAsync?.(ownerId, session.topicId) ?? this.terms.getSnapshot(ownerId, session.topicId))
        if (topicTerms.version !== command.topicTermsVersion) return error(request.requestId, 'stale_terms', '原稿核对后用户固定规则已变化。')
        const result = await this.preparation.captureUnit(command.request, hash, topicTerms, command.relevantFixedIds, snapshot => new TextEncoder().encode(JSON.stringify(success({ kind: 'preparation_captured', snapshot }))).byteLength)
        return result.ok ? success({ kind: 'preparation_captured', snapshot: result.value }) : error(request.requestId, result.error.code, result.error.message)
      }
      const envelope = this.resolvePreparationTarget?.(command.request.target), session = envelope && this.sessions.getSession(envelope.material.translationSessionId)
      if (!envelope || envelope.mainSessionId !== ownerId || !session || !this.sessions.isSessionOpen(ownerId, session.id) ||
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
        if (!envelope || envelope.mainSessionId !== ownerId || !session || !this.sessions.isSessionOpen(ownerId, session.id) ||
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
      const target = command.target
      if (target.mainSessionId !== ownerId || !this.sessions.canAccessUnit(ownerId, target.translationSessionId, target.unitId)) return error(request.requestId, 'out_of_scope', '请先在当前主会话打开此翻译会话，并核对单元是否存在。')
      const { kind, ...payload } = command
      const result = kind === 'normal_resolve' ? this.normal?.resolve(ownerId, payload as NormalTranslationUnitRequest) : this.normal?.correctSource(ownerId, payload as NormalTranslationSourceCorrection)
      return result ? { requestId: request.requestId, ...result } : error(request.requestId, 'execution_unavailable', '普通单元处理通道尚未就绪。')
    }
    if (command.kind === 'normal_export') {
      const result = this.normal?.exportResult(ownerId, { target: command.target,
        ...(command.totalCodePoints === undefined ? {} : { totalCodePoints: command.totalCodePoints }) })
      return result ? { requestId: request.requestId, ...result } : error(request.requestId, 'execution_unavailable', '普通翻译业务通道尚未就绪。')
    }
    if (command.kind === 'normal_observe') {
      const result = this.normal?.observe(ownerId, command)
      return result ? { requestId: request.requestId, ...result } : error(request.requestId, 'execution_unavailable', '普通翻译业务通道尚未就绪。')
    }
    if (command.kind === 'normal_commit') {
      const { kind: _kind, ...payload } = command, envelope = payload.envelope
      if (envelope.mainSessionId !== ownerId) return error(request.requestId, 'out_of_scope', '译文结果不属于当前主会话。')
      await this.terms.reconcileAsync?.(ownerId, envelope.material.topicId)
      const result = this.normal?.commitResult(ownerId, payload as DirectTranslationCommit)
      return result ? { requestId: request.requestId, ...result } : error(request.requestId, 'execution_unavailable', '普通翻译业务通道尚未就绪。')
    }
    if (command.kind === 'normal_accept' || command.kind === 'normal_prepare' || command.kind === 'normal_update') {
      const { kind, ...payload } = command
      if (kind !== 'normal_update' && 'envelope' in payload && payload.envelope.mainSessionId === ownerId) {
        await this.normal?.recoverInterrupted(payload.envelope.material.translationSessionId, ownerId)
      }
      if (kind !== 'normal_update' && 'envelope' in payload) await this.terms.reconcileAsync?.(ownerId, payload.envelope.material.topicId)
      const result = kind === 'normal_update' ? this.normal?.update(ownerId, payload as NormalTranslationUpdate)
        : kind === 'normal_prepare' ? this.normal?.prepare(ownerId, payload as NormalTranslationAcceptance)
        : this.normal?.accept(ownerId, payload as NormalTranslationAcceptance)
      return result ? { requestId: request.requestId, ...result } : error(request.requestId, 'execution_unavailable', '普通翻译业务通道尚未就绪。')
    }
    if (command.kind === 'normal_v2_update') {
      if (command.mainSessionId !== ownerId) return error(request.requestId, 'scope_mismatch', '普通翻译更新的执行主会话不符。')
      const { kind: _kind, ...payload } = command
      const result = this.normal?.updateV2(ownerId, payload)
      return result ? { requestId: request.requestId, ...result } : error(request.requestId, 'execution_unavailable', '普通翻译 v2 通道尚未就绪。')
    }
    if (command.kind === 'normal_exchange_resolve') {
      const session = this.sessions.getSession(command.translationSessionId)
      if (session && command.resolution.kind === 'answer') await this.terms.reconcileAsync?.(ownerId, session.topicId)
      const result = this.normal?.resolveExchange(ownerId, command)
      return result ? { requestId: request.requestId, ...result } : error(request.requestId, 'execution_unavailable', '普通翻译 exchange 通道尚未就绪。')
    }
    if (command.kind === 'reference_assets') {
      if (!this.sessions.getTopics(ownerId).some(topic => topic.id === command.topicId)) return error(request.requestId,'scope_mismatch','参考资产不属于当前主题。')
      const archive = await (this.archive.reconcileAsync?.(ownerId, command.topicId) ?? this.archive.getSnapshot(ownerId, command.topicId))
      const assets = await Promise.all(command.selections.map(async selection => {
        const entry = archive.entries.find(entry => entry.id === selection.id && entry.version === selection.version && entry.kind === selection.kind && entry.status === 'active')
        if (!entry) throw Object.assign(new Error('所选背景资产已变化或未生效。'),{code:'stale_reference_asset'})
        const label = entry.kind === 'entity' ? entry.name : entry.kind === 'fact' ? entry.title : entry.relation
        const effective = await this.archive.queryAsync?.(ownerId, command.topicId, {mode:'normal',kinds:[entry.kind],forms:[label]})
        if (!effective?.entries.some(candidate => candidate.id === entry.id && candidate.version === entry.version)) throw Object.assign(new Error('所选背景资产的依据尚不可用。'), {code:'stale_reference_asset'})
        const {id:_id, version:_version, createdAt:_created, updatedAt:_updated, confirmation:_confirmation, evidence:_evidence, status:_status, origin, ...content} = entry
        return {...selection, content: JSON.stringify({origin,...content})}
      }))
      return success({kind:'reference_assets',assets})
    }
    if (command.kind === 'reference_bind' || command.kind === 'reference_scope' || command.kind === 'reference_sync') {
      if (!this.references) return error(request.requestId, 'reference_unavailable', '参考资料服务尚未就绪。')
      try {
        const facts = command.kind === 'reference_bind' ? await this.references.bind(ownerId, command.operationId, command.start)
          : command.kind === 'reference_scope' ? this.references.facts(ownerId, command.topicId)
          : this.references.sync(ownerId, command.index, command.expectedVersion)
        return success({ kind: 'reference_facts', facts })
      } catch (cause) { return error(request.requestId, String((cause as {code?: string}).code ?? 'reference_unavailable'), (cause as Error).message) }
    }
    if (command.kind === 'direct_proposals') {
      if (!this.files || command.request.target.mainSessionId !== ownerId) return error(request.requestId, 'scope_mismatch', '资产提案不属于当前主会话。')
      try { return success({ kind: 'direct_proposals', receipt: await this.files.submitProposals(ownerId, command.request) }) }
      catch (cause) { return error(request.requestId, String((cause as { code?: string }).code ?? 'proposal_failed'), (cause as Error).message) }
    }
    if (command.kind === 'settings_scope') {
      if (command.topicId !== null && !this.sessions.getTopics(ownerId).some(topic => topic.id === command.topicId))
        return error(request.requestId, 'out_of_scope', '主题不存在或已删除。')
      return success({ kind: 'settings_scope', scope: { namespaceId: this.sessions.getNamespaceId(), topicId: command.topicId } })
    }
    if (command.kind === 'list_sessions') return success({ kind: 'sessions',
      sessions: this.sessions.getDisplaySessions(ownerId)
        .filter(session => !this.sessions.isSessionDeleted(session.id)).map(session => this.sessionSummary(session, ownerId)) })
    if (command.kind === 'list_topics') return success({ kind: 'topics', topics: this.sessions.getTopics(ownerId).map(topic => ({ ...topic,
      sessionIds: this.sessions.getAvailableSessions(ownerId).filter(session => session.topicId === topic.id && !this.sessions.isSessionDeleted(session.id)).map(session => session.id) })) })
    if (command.kind === 'list_topic_terms') {
      if (!this.sessions.getTopics(ownerId).some(topic => topic.id === command.topicId)) return error(request.requestId, 'out_of_scope', '主题不存在或已删除。')
      return success({ kind: 'terms', snapshot: await (this.terms.reconcileAsync?.(ownerId, command.topicId) ?? this.terms.getSnapshot(ownerId, command.topicId)) })
    }
    if (command.kind === 'list_topic_archive' || command.kind === 'upsert_archive') {
      if (!this.sessions.getTopics(ownerId).some(topic => topic.id === command.topicId)) return error(request.requestId, 'out_of_scope', '主题不存在或已删除。')
      if (command.kind === 'list_topic_archive') return success({ kind: 'archive', snapshot: await (this.archive.reconcileAsync?.(ownerId, command.topicId) ?? this.archive.getSnapshot(ownerId, command.topicId)) })
      if (!command.entry.evidence.every(ref => this.accessibleEvidence(ownerId, command.topicId, ref))) return error(request.requestId, 'reference_not_published', '档案依据不在用户明确提供的历史范围中。')
      const before = await this.archive.ensureLoaded(ownerId, command.topicId)
      const result = await this.archive.apply(ownerId, command.topicId, command.expectedVersion, { kind: 'put', input: command.entry })
      if (result.status === 'save_failed') return error(request.requestId, result.status, '当前档案内容可能已更新但未保存，请先查询当前版本后明确重试。')
      if (result.status !== 'updated' && result.status !== 'unchanged') return error(request.requestId, result.status, '档案提交未完成，请核对当前版本及依据。')
      if (!result.entry) return error(request.requestId, 'invalid_reply', '档案写入缺少准确条目回执，请查询当前记录。')
      const entry = result.entry, previous = new Map(before.entries.map(item => [item.id, item]))
      const affected = result.status === 'updated' && entry.kind === 'entity' ? result.snapshot.entries
        .filter(item => item.id !== entry.id && item.status === 'review_required' && referencedEntityIds(item).includes(entry.id)
          && previous.get(item.id)?.status !== 'review_required' && previous.get(item.id)?.version !== item.version)
        .map(item => ({ id: item.id, version: item.version, status: 'review_required' as const })) : []
      return success({ kind: 'archive_write', status: result.status, topicId: result.snapshot.topicId, version: result.snapshot.version,
        entry: { ...writeEntry(entry), kind: entry.kind }, ...(affected.length ? { affected } : {}) })
    }
    if (command.kind === 'create_session') {
      const result = await this.sessions.createManagedSessionAsync(ownerId, command.start)
      return result.ok ? success({ kind: 'session_created', session: this.sessionSummary(result.sessions[0]!, ownerId), reason: command.reason, persistence: result.persistence })
        : error(request.requestId, result.code, result.message)
    }
    if (command.kind === 'rename_topic') {
      const result = await this.sessions.renameTopicAsync(ownerId, command.topicId, command.expectedName, command.name)
      return result.ok ? success({ kind: 'sessions', sessions: result.sessions.map(session => this.sessionSummary(session, ownerId)), persistence: result.persistence })
        : error(request.requestId, result.code, result.message)
    }
    const session = this.sessions.getSession(command.translationSessionId)
    const opened = !!session && this.sessions.isSessionOpen(ownerId, session.id)
    if (!session || !opened || this.sessions.isSessionDeleted(session.id)) return error(request.requestId, 'out_of_scope', '翻译会话不属于当前主会话或已删除。')
    switch (command.kind) {
      case 'set_session_remark': {
        const result = await this.sessions.setSessionRemarkAsync(ownerId, session.id, command.expectedRemark, command.remark)
        return result.ok ? success({ kind: 'sessions', sessions: result.sessions.map(session => this.sessionSummary(session, ownerId)), persistence: result.persistence })
          : error(request.requestId, result.code, result.message)
      }
      case 'archive_session': {
        const result = await this.sessions.setSessionArchivedAsync(ownerId, session.id, command.expectedArchived, command.archived)
        return result.ok ? success({ kind: 'sessions', sessions: result.sessions.map(session => this.sessionSummary(session, ownerId)), persistence: result.persistence })
          : error(request.requestId, result.code, result.message)
      }
      case 'read_unit': {
        const unit = this.sessions.getTranslationHistory(session.id)?.units.find(unit => unit.id === command.unitId)
        if (!unit || !this.sessions.canAccessUnit(ownerId, session.id, unit.id)) return error(request.requestId, 'not_found', '此单元不存在、已删除或当前记录有冲突。')
        if (!isTextUnit(unit)) return this.files ? success({ kind: 'file_unit', unit: this.files.unit({ kind: 'unit', mainSessionId: ownerId, translationSessionId: session.id, unitId: unit.id, sourceVersion: unit.sourceVersion }) }) : error(request.requestId, 'unavailable', '文件历史服务尚未就绪。')
        return success({ kind: 'unit', unit: this.unitFact(this.sessions.getTranslationHistory(session.id)!, unit) })
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
        if (!command.entry.evidence.every(ref => this.accessibleEvidence(ownerId, session.topicId, ref))) return error(request.requestId, 'reference_not_published', '术语依据不在用户明确提供的历史范围中。')
        const result = await this.terms.apply(ownerId, session.topicId, command.expectedVersion, { kind: 'put', input: command.entry })
        if (result.status === 'save_failed') return error(request.requestId, result.status, '当前术语内容可能已更新但未保存，请先查询当前版本后明确重试。')
        if (result.status !== 'updated' && result.status !== 'unchanged') return error(request.requestId, result.status, '术语提交未完成，请核对当前版本及依据。')
        if (!result.entry) return error(request.requestId, 'invalid_reply', '术语写入缺少准确条目回执，请查询当前记录。')
        return success({ kind: 'term_write', status: result.status, topicId: result.snapshot.topicId, version: result.snapshot.version,
          entry: { ...writeEntry(result.entry), sourceLanguage: result.entry.sourceLanguage, targetLanguage: result.entry.targetLanguage } })
      }
    }
  }
  /** Build the current authoritative text unit only when a caller requests its body. */
  private unitFact(history: TranslationHistory, unit: TextUnit): TopicUnitFact {
    const event = [...history.events].reverse().find(event => event.type === 'final.selected' && event.unitId === unit.id)
    const final = currentFinalRevision(unit)
    return { id: unit.id, order: unit.order, source: unit.source, sourceVersion: unit.sourceVersion, targetLanguage: unit.targetLanguage, instruction: unit.instruction,
      revisions: unit.revisions.flatMap(revision => revision.status === 'deleted' ? [] : [{ id: revision.id, order: revision.order, kind: revision.kind, status: revision.status, text: revision.text, baseRevisionId: revision.baseRevisionId, sourceVersion: revision.sourceVersion }]),
      final: final && unit.final && event?.revisionId === final.id ? { revisionId: final.id, selection: unit.final.selection, selectionEventId: event.id } : null }
  }
  /** Read the exact preparation version this result belongs to; an older source version is never substituted. */
  private async documentTaskPreparation(ownerId: string, sessionId: string, unitId: string, reference?: { readonly id: string; readonly version: number }) {
    const session = this.sessions.getSession(sessionId), unit = this.sessions.getTranslationHistory(sessionId)?.units.find(unit => unit.id === unitId)
    if (this.disposed || !session || !unit || !isDocumentUnit(unit) || session.mode !== 'normal' ||
      this.sessions.isSessionDeleted(sessionId) || this.sessions.getStatus(sessionId) === 'conflict' || !this.preparation) return undefined
    const ref = reference ? unit.preparations.find(item => item.id === reference.id && item.version === reference.version) : unit.preparations.at(-1)
    if (!ref || ref.sourceVersion !== unit.sourceVersion) return undefined
    const source = unit.sourceVersions.find(item => item.version === ref.sourceVersion)
    if (!source) return undefined
    const hash = source.body.kind === 'asset' ? source.body.reference.sha256 : await sha256Hex(source.body.text)
    const prepared = this.preparation.documentUnitPreparation({ ownerId, mainSessionId: ownerId, topicId: session.topicId, translationSessionId: sessionId }, ref, hash)
    return prepared.ok ? { session, unit, ref, snapshot: prepared.value } : undefined
  }
  /** Task terms stay read-only here; sedimentation is a separate explicit user action. */
  async documentTaskTerms(ownerId: string, sessionId: string, unitId: string, reference?: { readonly id: string; readonly version: number }): Promise<DocumentTaskTermsView> {
    try {
      const facts = await this.documentTaskPreparation(ownerId, sessionId, unitId, reference)
      if (!facts) return { status: 'unavailable', terms: [], message: '尚无与当前原稿版本匹配的任务准备记录。' }
      return { status: 'ready', terms: facts.snapshot.terms.map(term => ({ sourceForms: [...term.sourceForms], preferred: term.preferred,
        sense: term.sense, userFixed: term.userFixed, rangeCount: term.ranges.length })) }
    } catch { return { status: 'unavailable', terms: [], message: '任务术语读取失败，可重试。' } }
  }
  /** Write adopted task terms into the topic as pending proposals; nothing is activated or overwritten. */
  async sedimentDocumentTaskTerms(ownerId: string, sessionId: string, unitId: string, reference?: { readonly id: string; readonly version: number }): Promise<DocumentTermSedimentResult> {
    try {
      const facts = await this.documentTaskPreparation(ownerId, sessionId, unitId, reference)
      if (!facts) return { status: 'unavailable', added: 0, skipped: 0, message: '尚无与当前原稿版本匹配的任务准备记录，暂不能沉淀。' }
      let snapshot = await (this.terms.reconcileAsync?.(ownerId, facts.session.topicId) ?? this.terms.getSnapshot(ownerId, facts.session.topicId))
      const plan = planDocumentTermSedimentation({ terms: facts.snapshot.terms, existing: snapshot.entries, sessionId, unitId, sourceVersion: facts.ref.sourceVersion })
      if (!plan.entries.length) return { status: 'completed', added: 0, skipped: plan.skipped,
        message: plan.skipped ? `已有 ${plan.skipped} 条相同术语，无需重复沉淀。` : '本任务没有可沉淀的采用术语。' }
      let added = 0, skipped = plan.skipped
      for (const entry of plan.entries) {
        let result = await this.terms.apply(ownerId, facts.session.topicId, snapshot.version, { kind: 'put', input: entry })
        // One refresh on a concurrent topic edit; the entry identity is new, so retrying cannot duplicate content.
        if (result.status === 'stale') result = await this.terms.apply(ownerId, facts.session.topicId, result.snapshot.version, { kind: 'put', input: entry })
        snapshot = result.snapshot
        if (result.status === 'updated') added++
        else skipped++
      }
      return { status: 'completed', added, skipped,
        message: added ? `已写入 ${added} 条待确认术语，可在记忆资产中采用。` : '未能写入新的术语，请核对主题记忆状态。' }
    } catch { return { status: 'failed', added: 0, skipped: 0, message: '沉淀未完成，请稍后重试。' } }
  }
  async reset(onlyOwnerId?: string): Promise<void> {
    if (onlyOwnerId === undefined) void this.connectLibrary()
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
    this.libraryController?.abort(); void this.closeHandle(this.libraryHandle); this.disposed = true; this.stopStore(); this.listeners.clear()
    const closing = [...this.connections.values()].map(async connection => {
      connection.generation++; connection.controller.abort(); await this.closeHandle(connection.handle)
    })
    this.connections.clear(); await Promise.all(closing)
  }
}
