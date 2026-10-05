import { parseQuickResult, type QuickTranslationPort, type QuickTranslationJob } from '../shared/quick-translation.js'
import { catalogAllowsRoute, type ModelCatalog } from './models.js'
import type { SessionStore } from './session-store.js'
import type { LocalSession, ModelRoute } from './sessions.js'

export type QuickStatus = 'submitting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export interface QuickRecord {
  readonly id: string
  readonly localSessionId: string
  readonly source: string
  readonly targetLanguage: string
  readonly instruction: string
  readonly model: ModelRoute
  readonly draftVersion: number
  status: QuickStatus
  text: string
  message: string | undefined
  accepted: boolean
}
interface Pending {
  readonly record: QuickRecord
  readonly draftStamp: number
  sessionKey: string | undefined
  consumedStamp: number | undefined
  stopped: boolean
  suspended: boolean
  dispatched: boolean
  cancelRequested: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}
interface Binding { readonly ownerId: string; readonly topicId: string; readonly max: number; readonly sessionKey: string }
const active = (status: QuickStatus): boolean => status === 'submitting' || status === 'running'
function validJob(value: unknown): value is QuickTranslationJob {
  try { parseQuickResult('status', { ok: true, value }); return true } catch { return false }
}
const rejectedBeforeExecution = new Set(['invalid_input', 'busy', 'not_found', 'identity_mismatch', 'execution_unavailable'])

/** Browser business state. The transport only addresses the plugin's Host service. */
export class QuickTranslationClient {
  private readonly records = new Map<string, QuickRecord[]>()
  private readonly pending = new Map<string, Pending>()
  private readonly bindings = new Map<string, Binding>()
  private readonly drafts = new Map<string, { signature: string; stamp: number }>()
  private readonly listeners = new Set<() => void>()
  private readonly stopStore: () => void
  private readiness: 'idle' | 'loading' | 'ready' | 'unavailable' = 'idle'
  private reason = '快译服务尚未就绪。'
  private generation = 0
  private sequence = 0
  private disposed = false
  private loading: Promise<void> | undefined
  constructor(private readonly port: QuickTranslationPort | undefined, private readonly store: SessionStore, private readonly models: ModelCatalog,
    private readonly options: { readonly pollMs?: number; readonly requestTimeoutMs?: number; readonly makeId?: () => string } = {}) {
    this.stopStore = store.subscribe(() => this.reconcile())
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  private draftStamp(session: LocalSession): number {
    const signature = JSON.stringify([session.ownerId, session.topicId, session.mode, session.input, session.targetLanguage,
      session.instruction, session.model?.provider ?? null, session.model?.model ?? null, session.model?.reasoningEffort ?? null, session.maxInputChars])
    const prior = this.drafts.get(session.id)
    if (prior?.signature === signature) return prior.stamp
    const next = { signature, stamp: (prior?.stamp ?? 0) + 1 }
    this.drafts.set(session.id, next); return next.stamp
  }
  getRecords(id: string): readonly QuickRecord[] { return this.records.get(id) ?? [] }
  getReadiness(): { readonly status: 'idle' | 'loading' | 'ready' | 'unavailable'; readonly reason: string } { return { status: this.readiness, reason: this.reason } }
  isBusy(id: string): boolean { return this.getRecords(id).some(record => active(record.status) || record.status === 'unknown') }
  blockedReason(session: LocalSession): string | undefined {
    if (session.mode !== 'quick') return '普通模式需主模型协作，尚未接入。'
    if (this.isBusy(session.id)) return '当前会话仍有未结束或结果未知的翻译，请先查询或取消。'
    if (this.readiness !== 'ready') return this.reason
    if (!session.input.trim()) return '请输入待翻译内容。'
    if (Array.from(session.input).length > session.maxInputChars) return `原文超过单次上限 ${session.maxInputChars} 个字符。`
    if (!session.targetLanguage.trim()) return '请设置目标语言。'
    if (!catalogAllowsRoute(this.models.getSnapshot(), session.model)) return '请选择当前目录中的模型与可用推理等级。'
    return undefined
  }
  load(): Promise<void> {
    if (this.disposed || this.readiness === 'ready') return Promise.resolve()
    if (this.loading) return this.loading
    const generation = this.generation
    if (!this.port) { this.readiness = 'unavailable'; this.reason = '快译服务未就绪，请重新检查。'; this.emit(); return Promise.resolve() }
    this.readiness = 'loading'; this.reason = '正在检查快译能力…'; this.emit()
    this.loading = this.request(Promise.resolve().then(() => this.port!.capabilities())).then(result => {
      if (this.disposed || generation !== this.generation) return
      this.readiness = result.ok && result.value?.ready === true && result.value.mode === 'quick' && result.value.storage === 'runtime_only' ? 'ready' : 'unavailable'
      this.reason = result.ok ? (typeof result.value?.reason === 'string' ? result.value.reason : '快译暂不可用。') : result.error.message
      this.emit()
    }).catch(() => {
      if (this.disposed || generation !== this.generation) return
      this.readiness = 'unavailable'; this.reason = '无法连接快译服务，请重试检查。'; this.emit()
    }).finally(() => { if (generation === this.generation) this.loading = undefined })
    return this.loading
  }
  private request<T>(promise: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('request timeout')), this.options.requestTimeoutMs ?? 30000)
      promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
    })
  }
  private reconcile(): void {
    for (const [id, list] of this.records) {
      const session = this.store.getSession(id)
      if (session) this.draftStamp(session)
      if (!session) {
        for (const record of list) this.stop(record.id, false)
        this.records.delete(id); this.bindings.delete(id); this.drafts.delete(id); this.emit()
      } else if (session.archivedAt !== null) {
        for (const record of list) if (active(record.status) || record.status === 'unknown') this.stop(record.id, true)
      }
    }
  }
  async send(id: string): Promise<void> {
    const draft = this.store.getSession(id)
    if (!draft || this.disposed || !this.port || this.blockedReason(draft) || !draft.model) return
    const choice = this.models.getSnapshot().groups.find(group => group.id === draft.model?.provider)?.models.find(model => model.id === draft.model?.model)
    const effort = draft.model.reasoningEffort ?? choice?.reasoning?.defaultEffort
    const model = { ...draft.model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
    const operationId = this.options.makeId?.() ?? `quick:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${++this.sequence}:${Math.random().toString(36).slice(2)}`}`
    const record: QuickRecord = { id: operationId, localSessionId: id, source: draft.input, targetLanguage: draft.targetLanguage, instruction: draft.instruction, model,
      draftVersion: ++this.sequence, status: 'submitting', text: '', message: undefined, accepted: false }
    const pending: Pending = { record, draftStamp: this.draftStamp(draft), sessionKey: undefined, consumedStamp: undefined, stopped: false, suspended: false, dispatched: false, cancelRequested: false, timer: undefined }
    this.records.set(id, [...this.getRecords(id), record]); this.pending.set(operationId, pending); this.emit()
    try {
      let binding = this.bindings.get(id)
      if (!binding || binding.ownerId !== draft.ownerId || binding.topicId !== draft.topicId || binding.max !== draft.maxInputChars) {
        const opened = await this.request(this.port.open({ localSessionId: id, maxSourceCodePoints: draft.maxInputChars }))
        if (!opened.ok) { this.fail(pending, opened.error.message); return }
        if (typeof opened.value?.sessionKey !== 'string' || !opened.value.sessionKey || opened.value.localSessionId !== id || opened.value.maxSourceCodePoints !== draft.maxInputChars) { this.fail(pending, '快译会话身份无效。'); return }
        binding = { ownerId: draft.ownerId, topicId: draft.topicId, max: draft.maxInputChars, sessionKey: opened.value.sessionKey }
        if (!this.store.getSession(id) || pending.stopped || pending.suspended) return
        this.bindings.set(id, binding)
      }
      pending.sessionKey = binding.sessionKey
      if (pending.stopped || pending.suspended) return
      pending.dispatched = true
      const submitted = await this.request(this.port.submit({ sessionKey: binding.sessionKey, operationId, draftVersion: record.draftVersion,
        sourceText: record.source, targetLanguage: record.targetLanguage, instruction: record.instruction,
        model: { providerId: model.provider, modelId: model.model, configVersion: 0, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
      }))
      if (pending.stopped || pending.suspended) return
      if (!submitted.ok) { this.fail(pending, submitted.error.message, rejectedBeforeExecution.has(submitted.error.code) ? 'failed' : 'unknown'); return }
      this.receive(pending, submitted.value)
    } catch { if (!pending.stopped && !pending.suspended) this.fail(pending, pending.dispatched ? '连接中断或回执超时，执行结果未知；未自动重发。' : '无法建立快译会话；原文仍保留。', pending.dispatched ? 'unknown' : 'failed') }
  }
  private receive(pending: Pending, job: QuickTranslationJob): void {
    const record = pending.record
    if (this.disposed || pending.stopped || pending.suspended || !this.store.getSession(record.localSessionId)) return
    if (!validJob(job)) { this.fail(pending, '快译回执格式无效，执行结果未知。', 'unknown'); return }
    const cancelledBeforeSubmit = pending.cancelRequested && job.draftVersion === 0 && job.status === 'cancelled' && job.accepted === false && job.text === ''
    if (job.operationId !== record.id || job.sessionKey !== pending.sessionKey || (job.draftVersion !== record.draftVersion && !cancelledBeforeSubmit)) {
      this.fail(pending, '快译回执身份不匹配，结果未采用。', 'unknown'); return
    }
    if (job.accepted && !record.accepted) {
      record.accepted = true
      // Track semantic draft edits, including edit→undo, independently of store object rebuilding.
      const current = this.store.getSession(record.localSessionId)
      if (!pending.cancelRequested && current && this.draftStamp(current) === pending.draftStamp && this.store.updateSession(record.localSessionId, { input: '' })) {
        const consumed = this.store.getSession(record.localSessionId)
        if (consumed) pending.consumedStamp = this.draftStamp(consumed)
      }
    }
    record.status = job.status; record.text = job.text; record.message = job.error?.message ?? (job.status === 'unknown' ? '执行结果未知，请查询本轮结果；未自动重发。' : undefined)
    if (active(record.status)) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.timer = setTimeout(() => { pending.timer = undefined; void this.poll(pending) }, this.options.pollMs ?? 300)
    } else {
      if (pending.timer) { clearTimeout(pending.timer); pending.timer = undefined }
      if (record.status !== 'completed') this.restore(pending)
      if (record.status !== 'unknown') { pending.stopped = true; this.pending.delete(record.id) }
    }
    this.emit()
  }
  private async poll(pending: Pending): Promise<void> {
    if (!this.port || !pending.sessionKey || pending.stopped || pending.suspended || this.disposed) return
    try {
      const response = await this.request(this.port.status({ sessionKey: pending.sessionKey, operationId: pending.record.id }))
      if (pending.stopped) return
      if (!response.ok) this.fail(pending, response.error.message, 'unknown')
      else this.receive(pending, response.value)
    } catch { if (!pending.stopped) this.fail(pending, '快译状态查询失败，执行结果未知；未自动重发。', 'unknown') }
  }
  private restore(pending: Pending): void {
    const current = this.store.getSession(pending.record.localSessionId)
    if (pending.consumedStamp !== undefined && current && this.draftStamp(current) === pending.consumedStamp) {
      if (this.store.updateSession(current.id, { input: pending.record.source })) pending.consumedStamp = undefined
    }
  }
  restoreSource(record: QuickRecord): void {
    const session = this.store.getSession(record.localSessionId)
    if (session && !session.input) this.store.updateSession(session.id, { input: record.source })
  }
  private fail(pending: Pending, message: string, status: QuickStatus = 'failed'): void {
    if (pending.stopped || this.disposed) return
    pending.record.status = status; pending.record.message = message
    if (pending.timer) clearTimeout(pending.timer)
    this.restore(pending)
    if (status !== 'unknown') { pending.stopped = true; this.pending.delete(pending.record.id) }
    this.emit()
  }
  query(record: QuickRecord): void {
    const pending = this.pending.get(record.id)
    if (pending && pending.record === record && record.status === 'unknown') { pending.suspended = false; void this.poll(pending) }
  }
  cancel(id: string): void { const record = this.getRecords(id).find(record => active(record.status) || record.status === 'unknown'); if (record) this.stop(record.id, true) }
  private cancelRemote(pending: Pending): void {
    if (!this.port || !pending.sessionKey) return
    void this.request(Promise.resolve().then(() => this.port!.cancel({ sessionKey: pending.sessionKey!, operationId: pending.record.id }))).then(response => {
      if (pending.stopped || this.disposed) return
      if (response.ok && validJob(response.value) && response.value.sessionKey === pending.sessionKey && response.value.operationId === pending.record.id &&
        (response.value.draftVersion === pending.record.draftVersion || (response.value.draftVersion === 0 && response.value.status === 'cancelled' && !response.value.accepted && response.value.text === ''))) {
        const job = response.value
        if (job.status !== 'unknown' && job.status !== 'running') {
          pending.suspended = false
          this.receive(pending, job)
          return
        }
      }
      pending.record.message = '已请求取消；Host 停止尚未确认，请查询本轮结果。'; this.emit()
    }).catch(() => { if (!pending.stopped && !this.disposed) { pending.record.message = '已请求取消；连接中断，Host 停止尚未确认。'; this.emit() } })
  }
  private stop(operationId: string, restore: boolean): void {
    const pending = this.pending.get(operationId)
    if (!pending || pending.stopped || (restore && pending.cancelRequested)) return
    if (pending.timer) clearTimeout(pending.timer)
    pending.suspended = true
    pending.cancelRequested = true
    pending.record.status = pending.dispatched ? 'unknown' : 'cancelled'; pending.record.message = pending.dispatched ? '正在请求取消，等待 Host 确认…' : '已取消。'
    if (restore) this.restore(pending)
    this.cancelRemote(pending)
    if (!restore || !pending.dispatched) { pending.stopped = true; this.pending.delete(operationId) }
    this.emit()
  }
  reset(): void {
    this.generation++; this.loading = undefined; this.readiness = 'idle'; this.reason = '连接已重置，请重新检查快译能力。'
    for (const pending of [...this.pending.values()]) {
      if (pending.timer) clearTimeout(pending.timer)
      this.fail(pending, pending.dispatched ? '连接已重置，执行结果未知；未自动重发。' : '连接已重置，未提交翻译。', pending.dispatched ? 'unknown' : 'failed'); pending.suspended = true
    }
    this.emit()
  }
  dispose(): void {
    for (const pending of [...this.pending.values()]) this.stop(pending.record.id, false)
    this.disposed = true; this.generation++; this.stopStore(); this.listeners.clear(); this.records.clear(); this.bindings.clear(); this.drafts.clear()
  }
}
