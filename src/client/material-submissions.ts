import { parseTranslationMaterialEnvelope, type TranslationMaterialEnvelope, type TranslationMaterialScope } from '../shared/translation-material.js'
import { parseTranslationMaterialResult, type TranslationMaterialsPort, type TranslationMaterialCapability, type TranslationMaterialReceipt, type TranslationMaterialQuery, type TranslationMaterialResult } from '../shared/translation-material-remote.js'
import { MAX_TOPIC_BRIDGE_REPLY_BYTES } from '../shared/topic-bridge.js'
import type { SessionStore } from './session-store.js'
import type { LocalSession } from './sessions.js'
import type { TopicBridgeClient } from './topic-bridge.js'

/** Projection of the proposed public Composer contract; absent on official DSH rc.2. */
export interface MaterialSubmissionGesture {
  readonly sessionId: string
  readonly requestId: string
  readonly mode: 'queue' | 'steer'
  readonly timestamp: number
  readonly source?: 'click' | 'enter'
  readonly draftRev: number
}
export type MaterialSubmissionOutcome = 'accepted' | 'failed' | 'handled' | 'cancelled' | 'unknown'
export interface MaterialSubmissionContribution {
  freeze(gesture: MaterialSubmissionGesture): { prepare(signal: AbortSignal): Promise<void>; finish(outcome: MaterialSubmissionOutcome): void } | undefined
}
export interface MaterialSubmissionRegistry { register(owner: unknown, contribution: MaterialSubmissionContribution): () => void }
export type TranslationMaterialsRemotePort = { [K in keyof TranslationMaterialsPort]: (...args: Parameters<TranslationMaterialsPort[K]>) => Promise<unknown> }
type Remote = TranslationMaterialsRemotePort | (() => Promise<TranslationMaterialsRemotePort | undefined>) | undefined
interface Options {
  readonly store: SessionStore
  readonly topics: Pick<TopicBridgeClient, 'getStatus' | 'retain' | 'subscribe'>
  readonly remote: Remote
  readonly registry?: MaterialSubmissionRegistry | undefined
  readonly owner: unknown
}
interface Submission {
  readonly envelope: TranslationMaterialEnvelope
  readonly sessionId: string | undefined
  readonly direct: boolean
  stage: 'frozen' | 'preparing' | 'prepared' | 'submitted' | 'attached' | 'unknown' | 'released' | 'failed'
  reason: string | undefined
  finished: boolean
  started: boolean
  settling: boolean
  consumed?: boolean
  preparation?: Promise<void>
}
export interface MaterialSubmissionStatus {
  readonly busy: boolean
  readonly blocked: string | undefined
  readonly message: string | undefined
  readonly unknown: boolean
}
const SEAM_MISSING = '普通模式暂不可用：当前 DSH 缺少同步发送材料接口。'
const FILE_BLOCKED = '文件材料尚未接入。请移除待译文件，或在主输入区选择“本次不附带”。'
const BYTE_BLOCKED = `材料超过传输上限（${MAX_TOPIC_BRIDGE_REPLY_BYTES} 字节）。请缩短待译稿；内容未截断。`
function id(): string { return crypto.randomUUID() }
function scope(envelope: TranslationMaterialEnvelope): TranslationMaterialScope {
  const { ownerId, mainSessionId, requestId, operationId } = envelope
  return { ownerId, mainSessionId, requestId, operationId }
}
function sameScope(a: TranslationMaterialScope, b: TranslationMaterialScope): boolean {
  return a.ownerId === b.ownerId && a.mainSessionId === b.mainSessionId && a.requestId === b.requestId && a.operationId === b.operationId
}
function signature(session: LocalSession): string {
  return JSON.stringify([session.input, session.targetLanguage, session.instruction, session.model, session.maxInputChars])
}
function detail(error: unknown): string { return error instanceof Error ? error.message : '材料提交未完成，草稿保留。' }

/** One root lifetime owns capture, bridge retention and immutable submission receipts. */
export class MaterialSubmissionsClient {
  private readonly submissions = new Map<string, Submission>()
  private readonly versions = new Map<string, { signature: string; version: number }>()
  private readonly files = new Set<string>()
  private readonly omitted = new Map<string, { revision: number; selected: boolean }>()
  private readonly retained = new Map<string, () => void>()
  private readonly listeners = new Set<() => void>()
  private readonly stopStore: () => void
  private readonly stopTopics: () => void
  private readonly unregister: (() => void) | undefined
  private capability: TranslationMaterialCapability | undefined
  private serviceReason: string | undefined
  private loading: Promise<void> | undefined
  private generation = 0
  private disposed = false
  constructor(private readonly options: Options) {
    this.stopStore = options.store.subscribe(() => { this.reconcile(); this.emit() })
    this.stopTopics = options.topics.subscribe(() => this.emit())
    this.unregister = options.registry?.register(options.owner, { freeze: gesture => this.freeze(gesture) })
    this.reconcile()
    void this.load()
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  private draftVersion(session: LocalSession): number {
    const current = signature(session), old = this.versions.get(session.id)
    if (old?.signature === current) return old.version
    const version = (old?.version ?? 0) + 1
    this.versions.set(session.id, { signature: current, version })
    return version
  }
  private live(session: LocalSession): boolean {
    return session.archivedAt === null && !this.options.store.isSessionDeleted(session.id) &&
      this.options.store.getTopics(session.ownerId).some(topic => topic.id === session.topicId)
  }
  private reconcile(): void {
    if (this.disposed) return
    const needed = new Set<string>()
    for (const owner of this.options.store.getOwnerIds()) for (const session of this.options.store.getAvailableSessions(owner)) {
      this.draftVersion(session)
      if (session.mode === 'normal' && this.live(session) && (session.input.trim() || this.files.has(session.id))) needed.add(owner)
    }
    for (const sessionId of this.files) if (!this.options.store.getSession(sessionId)) this.files.delete(sessionId)
    for (const item of this.submissions.values()) if (item.settling || ['frozen', 'preparing', 'prepared', 'unknown'].includes(item.stage) ||
      (!item.consumed && item.envelope.kind === 'material' && ['submitted', 'attached'].includes(item.stage))) needed.add(item.envelope.ownerId)
    for (const owner of needed) if (!this.retained.has(owner)) this.retained.set(owner, this.options.topics.retain(owner))
    for (const [owner, release] of this.retained) if (!needed.has(owner)) { this.retained.delete(owner); release() }
  }
  setFileSelected(sessionId: string, selected: boolean): void {
    if (selected) this.files.add(sessionId); else this.files.delete(sessionId)
    this.reconcile(); this.emit()
  }
  setOmit(ownerId: string, omitted: boolean): void {
    this.omitted.set(ownerId, { revision: (this.omitted.get(ownerId)?.revision ?? 0) + 1, selected: omitted })
    this.emit()
  }
  getAttachment(ownerId: string): { readonly label: string; readonly omitted: boolean; readonly available: boolean } | undefined {
    const session = this.options.store.getActiveSession(ownerId)
    if (!session || session.mode !== 'normal' || !this.live(session) || (!session.input.trim() && !this.files.has(session.id))) return undefined
    return { label: this.unregister ? `附带待译稿：${session.remark || session.name}` : SEAM_MISSING,
      omitted: this.omitted.get(ownerId)?.selected ?? false, available: !!this.unregister }
  }
  private async port(): Promise<TranslationMaterialsRemotePort> {
    const remote = typeof this.options.remote === 'function' ? await this.options.remote() : this.options.remote
    if (!remote) throw new Error('材料提交服务尚未就绪。')
    return remote
  }
  private async call<T>(method: keyof TranslationMaterialsPort, request?: TranslationMaterialEnvelope | TranslationMaterialScope | Parameters<TranslationMaterialsPort['finish']>[0]): Promise<T> {
    const port = await this.port()
    const response = await (method === 'capabilities' ? port.capabilities() : (port[method] as (request: unknown) => Promise<unknown>).call(port, request))
    if (!response || typeof response !== 'object' || (response as { ok?: unknown }).ok !== true) throw new Error('未取得材料服务传输回执；提交结果尚不确定。')
    const result = parseTranslationMaterialResult(method, (response as { value?: unknown }).value) as TranslationMaterialResult<T>
    if (!result.ok) throw new MaterialRejected(result.error.message, result.error.code)
    return result.value
  }
  load(): Promise<void> {
    if (this.loading) return this.loading
    const generation = this.generation
    this.loading = this.call<TranslationMaterialCapability>('capabilities').then(value => {
      if (!this.disposed && generation === this.generation) { this.capability = value; this.serviceReason = value.reason }
    }).catch(error => { if (!this.disposed && generation === this.generation) { this.capability = undefined; this.serviceReason = detail(error) } })
      .finally(() => { if (generation === this.generation) { this.loading = undefined; this.emit() } })
    return this.loading
  }
  private inputReason(session: LocalSession): string | undefined {
    if (!this.live(session)) return '会话已归档、删除或主题不可用，草稿保留。'
    if (this.files.has(session.id)) return FILE_BLOCKED
    if (!session.input.trim()) return '请输入待译材料。'
    if (Array.from(session.input).length > session.maxInputChars) return `已超过单次上限 ${session.maxInputChars} 个字符；内容保持完整。`
    return undefined
  }
  private readiness(ownerId: string): string | undefined {
    if (!this.unregister) return SEAM_MISSING
    if (!this.capability?.ready || !this.capability.directSubmit) return this.serviceReason ?? '正在检查材料提交服务…'
    const topic = this.options.topics.getStatus(ownerId)
    if (!topic.ready) return topic.reason ?? '正在连接此主会话的材料通道…'
    return undefined
  }
  private envelope(session: LocalSession | undefined, ownerId: string, requestId: string, kind: 'material' | 'none' | 'omit', preview = false): TranslationMaterialEnvelope {
    const identity = (): string => preview ? '00000000-0000-0000-0000-000000000000' : id()
    const base = { ownerId, mainSessionId: ownerId, requestId, operationId: identity() }
    const value = parseTranslationMaterialEnvelope(kind === 'material' && session ? { ...base, kind, material: {
      materialId: identity(), sourceVersion: 1, topicId: session.topicId, translationSessionId: session.id,
      draftVersion: this.draftVersion(session), sourceText: session.input, targetLanguage: session.targetLanguage,
      instruction: session.instruction, model: session.model, maxInputChars: session.maxInputChars,
    } } : { ...base, kind })
    // Shared bounded bridge margin leaves room for Gateway's RPC wrapper (256 KiB uplink).
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_TOPIC_BRIDGE_REPLY_BYTES) throw new Error(BYTE_BLOCKED)
    return value
  }
  getStatus(sessionId: string): MaterialSubmissionStatus {
    const session = this.options.store.getSession(sessionId)
    const latest = [...this.submissions.values()].filter(item => item.sessionId === sessionId).at(-1)
    const busy = !!latest && ['frozen', 'preparing', 'prepared'].includes(latest.stage)
    const unknown = latest?.stage === 'unknown'
    let blocked = session ? this.readiness(session.ownerId) ?? this.inputReason(session) : '翻译会话不存在。'
    if (!blocked && session) { try { this.envelope(session, session.ownerId, '00000000-0000-0000-0000-000000000000', 'material', true) } catch (error) { blocked = detail(error) } }
    if (busy) blocked = '正在提交材料…'
    if (unknown) blocked = '提交结果尚不确定，请先检查提交状态。'
    let message = latest?.reason
    if (latest?.consumed) message = '翻译业务已受理；原提交材料已记录。'
    else if (latest?.envelope.kind === 'material' && ['submitted', 'attached'].includes(latest.stage)) {
      const sent = latest.envelope.material.draftVersion, current = session ? this.draftVersion(session) : sent
      message = current === sent ? `已向主会话提交草稿版本 ${sent}；待译草稿保留。`
        : `已提交的是草稿版本 ${sent}；当前草稿为版本 ${current}。`
    }
    return { busy, blocked, message, unknown }
  }
  private record(envelope: TranslationMaterialEnvelope, sessionId: string | undefined, direct: boolean): Submission {
    const item: Submission = { envelope, sessionId, direct, stage: 'frozen', reason: undefined, started: false, finished: false, settling: false }
    this.submissions.set(JSON.stringify([envelope.ownerId, envelope.requestId]), item); this.reconcile(); this.emit()
    return item
  }
  private checkReceipt(item: Submission, receipt: TranslationMaterialReceipt): void {
    if (!sameScope(item.envelope, receipt) || item.envelope.kind !== receipt.kind) throw new Error('材料服务回执身份不匹配；提交结果尚不确定。')
    item.stage = receipt.stage
  }
  /** The bridge may only admit the exact browser snapshot that was prepared for this main submission. */
  resolveSubmittedMaterial(envelope: TranslationMaterialEnvelope & { readonly kind: 'material' }): TranslationMaterialEnvelope & { readonly kind: 'material' } | undefined {
    const item = this.submissions.get(JSON.stringify([envelope.ownerId, envelope.requestId]))
    if (this.disposed || !item || item.envelope.kind !== 'material' ||
      !['prepared', 'submitted', 'attached', 'unknown'].includes(item.stage) ||
      JSON.stringify(item.envelope) !== JSON.stringify(parseTranslationMaterialEnvelope(envelope))) return undefined
    return structuredClone(item.envelope)
  }
  /** Business acceptance consumes only the unchanged submitted draft, including its edit history. */
  consumeSubmittedMaterial(envelope: TranslationMaterialEnvelope & { readonly kind: 'material' }): void {
    const item = this.submissions.get(JSON.stringify([envelope.ownerId, envelope.requestId]))
    if (!item || !this.resolveSubmittedMaterial(envelope) || item.consumed) return
    item.consumed = true
    const session = this.options.store.getSession(envelope.material.translationSessionId)
    if (session && session.ownerId === envelope.ownerId && session.topicId === envelope.material.topicId &&
      this.draftVersion(session) === envelope.material.draftVersion && signature(session) === signature({ ...session,
        input: envelope.material.sourceText, targetLanguage: envelope.material.targetLanguage, instruction: envelope.material.instruction,
        model: envelope.material.model, maxInputChars: envelope.material.maxInputChars })) this.options.store.updateSession(session.id, { input: '' })
    this.reconcile(); this.emit()
  }
  private freeze(gesture: MaterialSubmissionGesture): ReturnType<MaterialSubmissionContribution['freeze']> {
    if (this.disposed || !this.retained.has(gesture.sessionId)) return undefined
    const old = this.submissions.get(JSON.stringify([gesture.sessionId, gesture.requestId]))
    const session = this.options.store.getActiveSession(gesture.sessionId)
    const omitState = this.omitted.get(gesture.sessionId), omit = omitState?.selected ? omitState.revision : undefined
    let item: Submission | undefined = old, failure: string | undefined
    if (!item) {
      try {
        const kind = omit ? 'omit' : session?.mode === 'normal' && session.input.trim() ? 'material' : 'none'
        if (kind !== 'omit' && session?.mode === 'normal' && this.files.has(session.id)) throw new Error(FILE_BLOCKED)
        if (kind === 'material' && session) { const reason = this.inputReason(session); if (reason) throw new Error(reason) }
        item = this.record(this.envelope(session, gesture.sessionId, gesture.requestId, kind), session?.id, false)
        if (omit) this.omitted.set(gesture.sessionId, { revision: omit, selected: false })
      } catch (error) { failure = detail(error) }
    }
    const frozen = item
    return {
      prepare: async signal => {
        if (failure) throw new Error(failure)
        if (!frozen || signal.aborted || this.disposed) throw new Error('材料提交已取消。')
        if (frozen.preparation) return frozen.preparation
        const reason = this.readiness(gesture.sessionId)
        if (reason) throw new Error(reason)
        frozen.started = true; frozen.stage = 'preparing'; this.emit()
        frozen.preparation = (async () => {
          try {
            const receipt = await this.call<TranslationMaterialReceipt>('prepare', frozen.envelope)
            if (!sameScope(frozen.envelope, receipt) || frozen.envelope.kind !== receipt.kind || receipt.stage !== 'prepared') throw new Error('材料准备回执身份或阶段无效。')
            if (signal.aborted || frozen.finished || this.disposed) throw new Error('材料准备已取消。')
            this.checkReceipt(frozen, receipt)
          } catch (error) { frozen.reason = detail(error); throw error }
          finally { this.emit() }
        })()
        return frozen.preparation
      },
      finish: outcome => {
        if (!frozen || frozen.finished) return
        frozen.finished = true
        if (omit && outcome !== 'accepted' && this.omitted.get(gesture.sessionId)?.revision === omit) this.omitted.set(gesture.sessionId, { revision: omit, selected: true })
        const result = outcome === 'accepted' ? 'submitted' : outcome === 'handled' || outcome === 'cancelled' ? 'no_prompt' : outcome
        if (!frozen.started) { frozen.stage = result === 'unknown' ? 'unknown' : 'released'; this.reconcile(); this.emit(); return }
        frozen.stage = result === 'submitted' ? 'submitted' : result === 'unknown' ? 'unknown' : 'released'
        frozen.settling = true
        // A disposal can finish while prepare is in flight. Cleanup must follow its ACK.
        void Promise.resolve(frozen.preparation).catch(() => {}).then(() => this.call<TranslationMaterialReceipt>('finish', { ...scope(frozen.envelope), outcome: result })).then(receipt => this.checkReceipt(frozen, receipt))
          .catch(error => {
            // A typed missing record after a confirmed no-prompt outcome is released.
            frozen.stage = error instanceof MaterialRejected && error.code === 'not_found' && (result === 'no_prompt' || result === 'failed') ? 'released' : 'unknown'
            frozen.reason ??= detail(error)
          }).finally(() => { frozen.settling = false; this.reconcile(); this.emit() })
        this.reconcile(); this.emit()
      },
    }
  }
  async send(sessionId: string): Promise<void> {
    const status = this.getStatus(sessionId), session = this.options.store.getSession(sessionId)
    if (this.disposed || !session || session.mode !== 'normal' || status.blocked) return
    const item = this.record(this.envelope(session, session.ownerId, id(), 'material'), sessionId, true)
    item.started = true; item.stage = 'preparing'; this.emit()
    try { this.checkReceipt(item, await this.call<TranslationMaterialReceipt>('submit', item.envelope)) }
    catch (error) { item.stage = error instanceof MaterialRejected ? 'failed' : 'unknown'; item.reason = detail(error) }
    finally { item.finished = true; this.reconcile(); this.emit() }
  }
  async query(sessionId: string): Promise<void> {
    const item = [...this.submissions.values()].filter(value => value.sessionId === sessionId && value.stage === 'unknown').at(-1)
    if (!item || this.disposed) return
    try {
      const result = await this.call<TranslationMaterialQuery | null>('query', scope(item.envelope))
      if (result && result.receipt.stage === 'prepared') item.reason = '材料已准备，主会话接收状态仍未确认。'
      else if (result) { this.checkReceipt(item, result.receipt); item.reason = undefined }
      else item.reason = '服务中尚无此提交记录；不能据此确认主会话未收到材料。'
    } catch (error) { item.reason = detail(error) }
    this.reconcile(); this.emit()
  }
  reset(): void {
    this.generation++; this.loading = undefined; this.capability = undefined
    for (const item of this.submissions.values()) if (['preparing', 'prepared', 'submitted'].includes(item.stage)) { item.stage = 'unknown'; item.reason = '连接已重置，请检查原提交状态。' }
    this.reconcile(); this.emit(); void this.load()
  }
  dispose(): void {
    if (this.disposed) return
    this.unregister?.(); this.stopStore(); this.stopTopics()
    this.disposed = true; this.generation++
    for (const release of this.retained.values()) release()
    this.retained.clear(); this.listeners.clear(); this.files.clear(); this.omitted.clear(); this.submissions.clear(); this.versions.clear()
  }
}
class MaterialRejected extends Error { constructor(message: string, readonly code: string) { super(message) } }
