import { parseTranslationBatchExecute, parseTranslationBatchStatus, parseTranslationBatchControl, parseTranslationBatchUpdate, parseDocumentRestoreCapture,
  type TranslationBatchControl, type TranslationBatchUpdate, type DocumentTaskControl, type TranslationBatchExecute,
  type TranslationBatchStatus, type DocumentTaskReceipt, type DocumentTaskEvent, type DocumentBlockRegistration,
  type DocumentTaskScope } from '../shared/document-execution.js'
import type { AnalysisResult } from '../shared/translation-preparation.js'
import type { DocumentTaskStatus, DocumentExecutionBaseline, DocumentSourceVersion, DocumentSupplementFact } from '../shared/translation-batch.js'
import { documentPlanningBytes, MAX_DOCUMENT_PLAN_CALLS, MAX_DOCUMENT_PLAN_PAGE_BYTES } from '../shared/document-planning.js'
import { DshTextExecutionAdapter, type DocumentExecutionPacket } from './dsh-text-adapter.js'
import type { DocumentExecutionFreeze, DocumentPlanningInput } from './document-planner.js'
import type { DocumentPlanningService } from './document-planning-service.js'
import type { NormalTranslationService } from './normal-translation.js'
import type { TopicHostContext, TopicToolsService, ToolExecution, MainAgent } from './topic-tools.js'
import { MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, sourceCodePointLength } from '../shared/translation-source-read.js'
import type { RequestContextInput } from '../shared/request-context.js'
import type { TranslationExchangeService, ExecutorOperationRef, NeedsContextReference, ExchangeResolution, PreparedExecutorResume,
  ExecutorResumeRegistration, BatchTaskPhaseEvent } from 'dsh-composer-extension/contracts'

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
interface ProgressFact { readonly taskSequence: number; readonly kind: string; readonly chunkId: string | null; readonly childOperationId: string | null; readonly sequence: number | null; readonly at: string }
interface Job extends DocumentTaskScope {
  /** The Cordis invocation context that authorized the job and owns its E exchange registration. */
  readonly exchangeOwner: TopicHostContext
  request: TranslationBatchExecute
  readonly agent: MainAgent
  controller: AbortController
  readonly delivery: AbortController
  readonly facts: ProgressFact[]
  readonly createdAt: string
  acceptance: Promise<AnalysisResult<DocumentTaskReceipt>>
  input: DocumentPlanningInput | null
  snapshot: DocumentExecutionFreeze | null
  receipt: DocumentTaskReceipt | null
  status: DocumentTaskStatus
  taskSequence: number
  actualCalls: number
  outputBytes: number
  completedChunks: number
  writing: Promise<void>
  error: { code: string; message: string; stage: string } | null
  uncertain: boolean
  acceptRequested: boolean
  finishing: boolean
  cleanupRequested: boolean
  taskVersion: number
  pauseRequested: boolean
  cancelRequested: boolean
  running: Promise<void> | null
  readonly completed: Set<string>
  source: DocumentSourceVersion | null
  automaticSupplementCalls: number
  readonly supplemented: Set<string>
  readonly supplements: Map<string, DocumentSupplementFact>
  reviewIssues: { code: string; range: { start: number; end: number }; message: string }[]
  help: Help | null
  resumeEntry: ResumeEntry | null
  phaseNotification: string
  controlling: boolean
  controlOwner: object | null
  controllingKind: DocumentTaskControl['kind'] | 'exchange' | null
}
interface Help { registration: DocumentBlockRegistration; sequence: number; contextVersion: number; questions: RequestContextInput; exchange: TranslationExchangeService; exchangeId: string | null }
interface ExchangeRegistration { readonly exchange: TranslationExchangeService; readonly unregister: () => void; readonly unregisterPhase: () => void }
interface ResumeEntry { readonly token: PreparedExecutorResume; readonly job: Job; readonly resolutionId: string; readonly observedVersion: number;
  readonly resolution: ExchangeResolution; readonly registration: DocumentBlockRegistration | null; readonly packet: DocumentExecutionPacket | null;
  readonly preparedTaskVersion: number; readonly planRef: TranslationBatchExecute['planRef']; readonly preparationRef: TranslationBatchExecute['preparationRef']; readonly route: DocumentExecutionBaseline['route'];
  registeredTaskVersion: number | null; registered: boolean; dispatched: boolean }
const generations = new Map<string, DocumentExecutionService>()
function failure(code: string, message: string, stage: string): AnalysisResult<never> { return { ok: false, error: { code, message, stage } } }
function rejected(code: string, message: string, stage: string): Error { return Object.assign(new Error(message), { code, stage }) }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function key(owner: string, operation: string): string { return JSON.stringify([owner, operation]) }
function actualModel(snapshot: DocumentExecutionFreeze) {
  const route = snapshot.capacity.route
  return { providerId: route.provider, modelId: route.model, configVersion: 0,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) }
}

/** One accepted document, one serial worker. The Client remains the authoritative history owner. */
export class DocumentExecutionService {
  readonly hostGeneration = `translation-batch:${crypto.randomUUID()}`
  readonly typertRemote: { readonly service: DocumentExecutionService; readonly serviceKey: 'translationBatch'; readonly namespace: 'translationBatch' }
  readonly adapter: DshTextExecutionAdapter
  private readonly jobs = new Map<string, Job>()
  private readonly operations = new Map<string, Job>()
  private readonly controls = new Map<string, { signature: string; result: Promise<AnalysisResult<DocumentTaskReceipt>> }>()
  private readonly resumeTokens = new Map<unknown, ResumeEntry>()
  private readonly children = new Map<string, Job>()
  private readonly exchangeRegistrations = new Map<TopicHostContext, ExchangeRegistration>()
  private readonly phaseFacts = new Map<string, BatchTaskPhaseEvent>()
  private disposed = false
  constructor(readonly ctx: TopicHostContext) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationBatch', property: 'ctx' } })
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'translationBatch', namespace: 'translationBatch' })
    this.adapter = new DshTextExecutionAdapter(ctx); generations.set(this.hostGeneration, this)
    this.attachExchange(ctx)
  }
  private attachExchange(owner: TopicHostContext = this.ctx): TranslationExchangeService | undefined {
    const exchange = owner.get?.('translationExchange') as TranslationExchangeService | undefined
    const current = this.exchangeRegistrations.get(owner)
    if (exchange && current?.exchange.hostGeneration === exchange.hostGeneration) return current.exchange
    current?.unregister(); current?.unregisterPhase(); this.exchangeRegistrations.delete(owner)
    if (!exchange || typeof exchange.registerBatch !== 'function' || typeof exchange.registerBatchTaskPhaseInspector !== 'function' ||
      typeof exchange.batchCapabilities !== 'function' || exchange.batchCapabilities().batchProtocol !== 1) return undefined
    const unregister = exchange.registerBatch(owner as unknown as Parameters<TranslationExchangeService['registerBatch']>[0], this)
    const unregisterPhase = exchange.registerBatchTaskPhaseInspector(owner as unknown as Parameters<TranslationExchangeService['registerBatchTaskPhaseInspector']>[0], {
      inspectBatchTaskPhase: event => {
        const fixed = this.phaseFacts.get(event.eventId), job = this.jobs.get(event.result.taskId)
        return !this.disposed && this.exchangeRegistrations.get(owner)?.exchange.hostGeneration === exchange.hostGeneration && job?.exchangeOwner === owner &&
          fixed && same(fixed, event) && job.taskVersion === event.result.version && job.taskSequence === event.result.taskSequence ? fixed : null
      },
    })
    this.exchangeRegistrations.set(owner, { exchange, unregister, unregisterPhase })
    return exchange
  }
  private async notifyPhase(job: Job, phase: BatchTaskPhaseEvent['phase']): Promise<void> {
    const exchange = this.attachExchange(job.exchangeOwner)
    if (!exchange || exchange.batchCapabilities().taskPhase.state !== 'available') { job.phaseNotification = 'unavailable'; return }
    const event: BatchTaskPhaseEvent = { eventId: JSON.stringify([job.taskId, job.taskVersion, job.taskSequence, phase]), hostGeneration: exchange.hostGeneration,
      scope: job.scope, operationId: job.request.operationId, phase, result: { kind: 'task', taskId: job.taskId, unitId: job.unitId,
        sourceVersion: job.request.target.sourceVersion, version: job.taskVersion, taskSequence: job.taskSequence } }
    this.phaseFacts.set(event.eventId, event)
    try { const result = await exchange.notifyBatchTaskPhase(job.exchangeOwner as unknown as Parameters<TranslationExchangeService['notifyBatchTaskPhase']>[0], event); job.phaseNotification = result.ok ? result.value.state : 'unavailable' }
    catch { job.phaseNotification = 'unavailable' }
  }
  private get topics(): TopicToolsService { return this.ctx.get?.('translationTopics') as TopicToolsService }
  private get planning(): DocumentPlanningService { return this.ctx.get?.('translationPlanning') as DocumentPlanningService }
  private get normal(): NormalTranslationService { return this.ctx.get?.('translationNormal') as NormalTranslationService }
  private execution(job: Job): ToolExecution { return { agent: job.agent, callId: job.request.operationId, signal: job.delivery.signal } }
  private release(job: Job): void { this.normal?.releaseDocumentSession(job.scope.ownerId, job.scope.translationSessionId, job.taskId) }
  private baseline(job: Job, snapshot = job.snapshot!, input = job.input!): DocumentExecutionBaseline {
    return { hostGeneration: this.hostGeneration, route: snapshot.capacity.route,
      capacity: { contextWindow: snapshot.capacity.contextWindow, maxOutputTokens: snapshot.capacity.maxOutputTokens, countKind: snapshot.capacity.countKind },
      analysisActualCalls: snapshot.callBudget.analysisActualCalls, maxInputChars: input.envelope?.material.maxInputChars ?? input.maxInputChars!,
      contextBindings: snapshot.budgets.map(item => ({ chunkId: item.chunkId, contextRef: item.contextRef })) }
  }
  private start(job: Job): void {
    if (job.running) return
    job.running = this.run(job).finally(() => { job.running = null })
  }
  private assertReceipt(job: Job, receipt: DocumentTaskReceipt, sequence: number, planRef = job.request.planRef, preparationRef = job.request.preparationRef): void {
    if (!same(receipt.scope, job.scope) || receipt.taskId !== job.taskId || receipt.unitId !== job.unitId ||
      receipt.operationId !== job.request.operationId || receipt.sourceVersion !== job.request.target.sourceVersion ||
      !same(receipt.planRef, planRef) || !same(receipt.preparationRef, preparationRef) || receipt.taskSequence !== sequence) {
      throw rejected('invalid_reply', '整篇登记回执的身份、版本或序号不一致。', 'document_writeback')
    }
  }
  async execute(args: unknown, exec: ToolExecution): Promise<AnalysisResult<DocumentTaskReceipt>> {
    const exchangeOwner = this.ctx
    let request: TranslationBatchExecute
    try { request = parseTranslationBatchExecute(args) } catch { return failure('invalid_input', '整篇执行参数无效。', 'execute_document') }
    if (this.disposed || !this.topics?.ownsAgent(request.target.mainSessionId, exec.agent)) return failure('scope_mismatch', '整篇执行不属于已连接的实际主 Agent。', 'authorize_document')
    if (this.topics.protocolFor(request.target.mainSessionId) !== 2) return failure('execution_unavailable', '整篇执行需要唯一主题桥的 v2 连接。', 'authorize_document')
    if (request.target.kind !== 'material') return failure('unit_preparation_unavailable', '已保存单元尚无已授权的整篇准备与规划读取路径；请使用本次已交付材料。', 'authorize_document')
    const operationKey = key(request.target.mainSessionId, request.operationId), old = this.operations.get(operationKey)
    if (old) return same(old.request, request) ? old.acceptance : failure('idempotency_conflict', '同一整篇操作标识不能更换材料、计划或准备版本。', 'execute_document')
    exec.signal.throwIfAborted()
    // Source authorization gives the original translation Session, independent from current UI selection.
    const material = (this.ctx.get?.('translationMaterials') as import('./translation-materials.js').TranslationMaterialsService)?.deliveredForAgent(request.target, exec.agent!)
    if (!material?.ok) return material ?? failure('unavailable', '固定材料服务尚未就绪。', 'authorize_document')
    if (material.value.material.sourceVersion !== 1) return failure('source_version_unavailable', '本阶段只受理新材料的首个原稿版本；源纠错与范围复用尚未接入。', 'authorize_document')
    const envelope = material.value, scope = { ownerId: envelope.ownerId, mainSessionId: envelope.mainSessionId,
      topicId: envelope.material.topicId, translationSessionId: envelope.material.translationSessionId }, taskId = `document-task:${crypto.randomUUID()}`
    if (!this.normal?.claimDocumentSession(scope.ownerId, scope.translationSessionId, taskId)) return failure('busy', '此翻译会话仍有未结算的短文或整篇任务。', 'accept_document')
    const job: Job = { request, scope, taskId, unitId: `unit:${envelope.material.materialId}`, agent: exec.agent!, exchangeOwner,
      controller: new AbortController(), delivery: new AbortController(), facts: [], createdAt: new Date().toISOString(),
      acceptance: undefined!, input: null, snapshot: null, receipt: null, status: 'running', taskSequence: 0,
      actualCalls: 0, outputBytes: 0, completedChunks: 0, writing: Promise.resolve(), error: null, uncertain: false, acceptRequested: false, finishing: false, cleanupRequested: false,
      taskVersion: 1, pauseRequested: false, cancelRequested: false, running: null, completed: new Set(), source: null, automaticSupplementCalls: 0, supplemented: new Set(), supplements: new Map(), reviewIssues: [], help: null, resumeEntry: null, phaseNotification: 'unavailable', controlling: false, controlOwner: null, controllingKind: null }
    this.jobs.set(taskId, job); this.operations.set(operationKey, job)
    job.acceptance = this.accept(job, exec)
    return job.acceptance
  }
  private async accept(job: Job, exec: ToolExecution): Promise<AnalysisResult<DocumentTaskReceipt>> {
    try {
      const request = job.request
      if (request.target.kind !== 'material') throw rejected('unit_preparation_unavailable', '整篇准备尚不支持历史单元目标。', 'accept_document')
      const captured = await this.planning.captureExecution(request.target, request.planRef, request.preparationRef, exec)
      if (!captured.ok) throw rejected(captured.error.code, captured.error.message, captured.error.stage)
      job.input = captured.value.input; job.snapshot = captured.value.snapshot; job.actualCalls = captured.value.snapshot.callBudget.analysisActualCalls
      if (!await this.adapter.ready()) throw rejected('execution_unavailable', '整篇模型运行服务尚未就绪，材料保留。', 'prepare_document')
      exec.signal.throwIfAborted()
      const admission = { envelope: job.input.envelope!, operationId: request.operationId, taskId: job.taskId, unitId: job.unitId,
        plan: job.snapshot.plan, preparationRef: request.preparationRef,
        contextBindings: job.snapshot.budgets.map(item => ({ chunkId: item.chunkId, contextRef: item.contextRef })), createdAt: job.createdAt, executionBaseline: this.baseline(job) }
      job.acceptRequested = true
      const value = await this.topics.requestOwned(job.scope.mainSessionId, { kind: 'document_accept', request: admission }, this.execution(job))
      if (value.kind !== 'document_accepted') throw rejected('invalid_reply', 'Client 未准确确认整篇受理。', 'accept_document')
      this.assertReceipt(job, value.receipt, 0); job.receipt = value.receipt
      if (value.receipt.status !== 'running') throw rejected('invalid_reply', '整篇受理未建立运行中的真实单元。', 'accept_document')
      // The worker has its own lifetime after admission; completing the tool call does not cancel it.
      queueMicrotask(() => this.start(job))
      return { ok: true, value: structuredClone(value.receipt) }
    } catch (error) {
      const known = error as { code?: string; message?: string; stage?: string }
      job.uncertain = job.acceptRequested && ['outcome_unknown', 'invalid_reply'].includes(known.code ?? '')
      job.status = job.uncertain ? 'unknown' : 'failed'
      job.error = { code: known.code ?? 'prepare_failed', message: job.uncertain ? '整篇受理回执未知；未调用译模型，请查询此 taskId。' : known.message ?? '整篇受理失败，材料保留。', stage: known.stage ?? 'accept_document' }
      if (!job.uncertain) this.release(job)
      return failure(job.error.code, `${job.error.message}${job.uncertain ? ` taskId=${job.taskId}` : ''}`, job.error.stage)
    }
  }
  private async register(job: Job, request: DocumentBlockRegistration): Promise<void> {
    const value = await this.topics.requestOwned(job.scope.mainSessionId, { kind: 'document_register', request }, this.execution(job))
    if (value.kind !== 'document_registered' || !same(value.registration.scope, job.scope) || value.registration.taskId !== job.taskId ||
      value.registration.unitId !== job.unitId || value.registration.childOperationId !== request.childOperationId ||
      value.registration.revisionId !== request.revisionId || value.registration.callId !== request.callId ||
      value.registration.attemptId !== request.attemptId || value.registration.sequence !== 0 || !value.registration.registered) {
      throw rejected('invalid_reply', 'Client 未准确确认块登记；未派发该块模型。', 'register_document_block')
    }
  }
  private event(job: Job, registration: DocumentBlockRegistration, sequence: number,
    payload: Omit<Extract<DocumentTaskEvent, { kind: 'dispatch_intent' }>, keyof DocumentTaskScope | 'taskSequence' | 'childOperationId' | 'sequence' | 'revisionId' | 'at'> |
      Omit<Extract<DocumentTaskEvent, { kind: 'dispatched' }>, keyof DocumentTaskScope | 'taskSequence' | 'childOperationId' | 'sequence' | 'revisionId' | 'at'> |
      Omit<Extract<DocumentTaskEvent, { kind: 'delta' }>, keyof DocumentTaskScope | 'taskSequence' | 'childOperationId' | 'sequence' | 'revisionId' | 'at'> |
      Omit<Extract<DocumentTaskEvent, { kind: 'settled' }>, keyof DocumentTaskScope | 'taskSequence' | 'childOperationId' | 'sequence' | 'revisionId' | 'at'> |
      Omit<Extract<DocumentTaskEvent, { kind: 'copy' }>, keyof DocumentTaskScope | 'taskSequence' | 'childOperationId' | 'sequence' | 'revisionId' | 'at'>): Promise<void> {
    const taskSequence = ++job.taskSequence, at = new Date().toISOString()
    const event = { scope: job.scope, taskId: job.taskId, unitId: job.unitId, taskSequence,
      childOperationId: registration.childOperationId, sequence, revisionId: registration.revisionId, at, ...payload } as DocumentTaskEvent
    job.facts.push({ taskSequence, kind: payload.kind, chunkId: registration.chunkId, childOperationId: registration.childOperationId, sequence, at })
    job.writing = job.writing.then(async () => {
      const value = await this.topics.requestOwned(job.scope.mainSessionId, { kind: 'document_event', event }, this.execution(job))
      if (value.kind !== 'document_updated') throw rejected('invalid_reply', 'Client 未准确确认块写回。', 'document_writeback')
      this.assertReceipt(job, value.receipt, taskSequence); job.receipt = value.receipt
    })
    return job.writing
  }
  private async finish(job: Job, status: 'completed' | 'failed' | 'cancelled' | 'unknown'): Promise<void> {
    job.finishing = true
    const taskSequence = ++job.taskSequence, at = new Date().toISOString()
    job.facts.push({ taskSequence, kind: status, chunkId: null, childOperationId: null, sequence: null, at })
    const value = await this.topics.requestOwned(job.scope.mainSessionId, { kind: 'document_finish', request: {
      scope: job.scope, taskId: job.taskId, unitId: job.unitId, taskSequence, status, manifestId: `document-manifest:${crypto.randomUUID()}`, at } }, this.execution(job))
    if (value.kind !== 'document_updated') throw rejected('invalid_reply', 'Client 未准确确认整篇结算。', 'document_writeback')
    this.assertReceipt(job, value.receipt, taskSequence); job.receipt = value.receipt; job.status = status
    if (status === 'completed') await this.notifyPhase(job, 'document_review_required')
    if (status !== 'unknown') {
      this.release(job)
      if (!job.cancelRequested) {
        // A queued or claimed review notice is the handoff to the main Agent. Keep the Client
        // lease/bridge alive until its current turn and any queued follow-up have actually drained.
        if (status === 'completed' && ['enqueued', 'claimed'].includes(job.phaseNotification) && typeof job.agent.whenIdle === 'function') {
          try { await job.agent.whenIdle() } catch { /* The completed fact is authoritative; cleanup still follows. */ }
        }
        this.cleanup(job)
      }
    }
  }
  /** Cleanup acknowledges the already received finish fact; its own ACK is not a business fact. */
  private cleanup(job: Job): void {
    if (job.cleanupRequested) return
    job.cleanupRequested = true
    try {
      void this.topics.requestOwned(job.scope.mainSessionId, { kind: 'document_release', request: {
        scope: job.scope, taskId: job.taskId, unitId: job.unitId, taskSequence: job.taskSequence } }, this.execution(job)).catch(() => {})
    } catch { /* The authoritative finish ACK has already been received. */ }
  }
  /** Slice provider deltas by Unicode code points and complete JSON bytes; preserve the bounded partial on overflow. */
  private async append(job: Job, registration: DocumentBlockRegistration, sequence: number, delta: string): Promise<number> {
    let piece = '', overflow = false
    for (const point of delta) {
      if (/[\uD800-\uDFFF]/u.test(point)) throw rejected('invalid_stream', '模型输出含无效 Unicode 字符，保留此前残稿。', 'stream_document')
      const bytes = new TextEncoder().encode(point).byteLength
      if (job.outputBytes + bytes > MAX_OUTPUT_BYTES) { overflow = true; break }
      if (piece.length >= 28000) { await this.event(job, registration, ++sequence, { kind: 'delta', delta: piece }); piece = '' }
      piece += point; job.outputBytes += bytes
    }
    if (piece) await this.event(job, registration, ++sequence, { kind: 'delta', delta: piece })
    if (overflow) throw Object.assign(rejected('output_budget_exceeded', '实际累计正文超过 16 MiB；已保留受限残稿并停止后续块。', 'stream_document'), { sequence })
    return sequence
  }
  private workerInput(job: Job): DocumentPlanningInput {
    const snapshot = job.snapshot!, input = job.input!
    // Freeze the route/preparation, while checking the original Agent/bridge/source at each read.
    const target = job.request.target
    if (target.kind !== 'material') throw rejected('source_mismatch', '文档缺少固定源目标。', 'read_document_source')
    const materials = this.ctx.get?.('translationMaterials') as import('./translation-materials.js').TranslationMaterialsService
    const isCurrent = () => !this.disposed && !job.controller.signal.aborted && this.topics.ownsAgent(job.scope.mainSessionId, job.agent) && (job.source !== null || materials.deliveredForAgent(target, job.agent).ok)
    return { ...input, isCurrent, readSource: range => {
      job.controller.signal.throwIfAborted()
      if (!isCurrent()) throw rejected('scope_mismatch', '整篇原稿授权已失效。', 'read_document_source')
      if (job.source) return input.readSource(range)
      const pieces: string[] = []
      for (let start = range.start; start < range.end; start += MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) {
        const requested = { start, end: Math.min(range.end, start + MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) }, page = materials.readSource({ target, range: requested }, job.agent)
        if (!page.ok) throw rejected(page.error.code, page.error.message, page.error.stage)
        if (!same(page.value.range, requested) || page.value.totalCodePoints !== snapshot.preparation.totalCodePoints || sourceCodePointLength(page.value.text) !== requested.end - requested.start) throw rejected('source_mismatch', '整篇读取返回的固定源范围不一致。', 'read_document_source')
        pieces.push(page.value.text)
      }
      return pieces.join('')
    } }
  }
  private async run(job: Job): Promise<void> {
    const snapshot = job.snapshot!, input = job.input!
    const workerInput = this.workerInput(job)
    try {
      const points = await this.planning.planner.readExecutionSource(workerInput, snapshot, job.controller.signal)
      for (const item of snapshot.plan.items) {
        if (job.completed.has(item.chunkId)) continue
        if (job.pauseRequested) { job.status = 'paused'; return }
        job.controller.signal.throwIfAborted()
        const resume = job.resumeEntry?.registration?.chunkId === item.chunkId ? job.resumeEntry : null
        let internalId = resume?.packet?.operationId ?? `document-worker:${crypto.randomUUID()}`, registration: DocumentBlockRegistration = resume?.registration ?? {
          scope: job.scope, taskId: job.taskId, unitId: job.unitId, chunkId: item.chunkId,
          childOperationId: `document-child:${crypto.randomUUID()}`, revisionId: `document-chunk:${crypto.randomUUID()}`,
          attemptId: item.mode === 'translate' ? `document-attempt:${crypto.randomUUID()}` : null,
          callId: item.mode === 'translate' ? `document-call:${crypto.randomUUID()}` : null, createdAt: new Date().toISOString(),
          planRef: { id: snapshot.plan.id, version: snapshot.plan.version }, preparationRef: job.request.preparationRef,
          contextRef: snapshot.budgets.find(budget => budget.chunkId === item.chunkId)!.contextRef, outputRange: item.outputRange }
        let sequence = 0, dispatched = false, registered = false, terminal = false, needsContext: RequestContextInput | undefined
        let usage: { inputTokens: number | null; outputTokens: number | null } = { inputTokens: null, outputTokens: null }
        try {
          if (item.mode === 'copy') {
            const text = points.slice(item.outputRange.start, item.outputRange.end).join(''), bytes = new TextEncoder().encode(text)
            if (job.outputBytes + bytes.byteLength > MAX_OUTPUT_BYTES) throw rejected('output_budget_exceeded', '整篇实际正文超过 16 MiB，停止后续块。', 'copy_document')
            const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer))].map(value => value.toString(16).padStart(2, '0')).join('')
            await this.register(job, registration); registered = true
            await this.event(job, registration, ++sequence, { kind: 'copy', sha256: hash }); job.outputBytes += bytes.byteLength
            job.completed.add(item.chunkId); job.completedChunks = job.completed.size; continue
          }
          if (job.actualCalls >= MAX_DOCUMENT_PLAN_CALLS) throw rejected('call_budget_exceeded', '已达到 512 次实际模型调用预算，停止后续块。', 'dispatch_document')
          const model = actualModel(snapshot), capacity = await this.adapter.prepareDocumentCapacity(internalId, model, job.controller.signal)
          const prompt = await this.planning.planner.reconstructExecution(workerInput, snapshot, item.chunkId, capacity, job.controller.signal, points)
          if (!prompt.ok) throw rejected(prompt.error.code, prompt.error.message, prompt.error.stage)
          const exchange = this.attachExchange(job.exchangeOwner), contextAvailable = !!exchange && exchange.batchCapabilities().exchange.state === 'available' && this.adapter.documentRequestContextAvailable(internalId)
          const savedSupplement = job.supplements.get(item.chunkId)
          const callPrompt = savedSupplement ? { ...prompt.value, contextRef: { ...prompt.value.contextRef, supplementRefs: [{ id: savedSupplement.id, version: savedSupplement.version }] } } : prompt.value
          if (savedSupplement && !resume) registration = { ...registration, contextRef: callPrompt.contextRef }
          const packet: DocumentExecutionPacket = resume?.packet ?? { operationId: internalId, callId: registration.callId!, attemptId: registration.attemptId!, model,
            systemPrompt: callPrompt.systemPrompt, userMessage: callPrompt.userMessage, prompt: callPrompt, requestContextAvailable: contextAvailable,
            ...(savedSupplement ? { supplement: { resolutionId: savedSupplement.id, observedVersion: savedSupplement.version, answerText: savedSupplement.answerText, organizedRequirements: savedSupplement.organizedRequirements } } : {}) }
          const record = this.adapter.preflightDocument(packet)
          await this.register(job, registration); registered = true
          // A durable dispatch claim precedes the actual stream. It never increments actual call usage.
          await this.event(job, registration, ++sequence, { kind: 'dispatch_intent' })
          job.controller.signal.throwIfAborted()
          for await (const event of this.adapter.executeDocument(packet, job.controller.signal, () => {
            dispatched = true; job.actualCalls++
            void this.event(job, registration, ++sequence, { kind: 'dispatched', callRecord: record }).catch(() => {})
            if (resume && job.help) {
              job.help.registration = registration; job.help.contextVersion = resume.token.contextVersion
              job.help.exchange.batchResumeStarted(job.exchangeOwner as unknown as Parameters<TranslationExchangeService['batchResumeStarted']>[0], { ...this.helpReference(job).scope,
                callId: registration.callId!, contextVersion: resume.token.contextVersion, hostGeneration: job.help.exchange.hostGeneration,
                lastSequence: job.taskSequence, exchangeId: job.help.exchangeId! }, resume.resolutionId)
            }
          })) {
            await job.writing
            if (event.type === 'text') sequence = await this.append(job, registration, sequence, event.text)
            else if (event.type === 'usage') usage = { inputTokens: event.input_tokens ?? null, outputTokens: event.output_tokens ?? null }
            else if (event.type === 'needs_context') {
              needsContext = { questions: event.input.questions.map(question => ({ ...question, range: question.range === null ? null : {
                start: item.outputRange.start + question.range.start, end: item.outputRange.start + question.range.end } })) }
            }
            else if (event.type === 'terminal') {
              const completed = event.reason === 'stop' && event.completeness === 'complete' && event.checks_passed && event.provider_state === 'finished'
              const diagnostic = this.adapter.diagnostic(internalId)
              const providerUnknown = event.reason === 'error' && ['TIMEOUT', 'TRANSPORT', 'EXECUTION_FAILED'].includes(diagnostic?.code ?? '')
              job.uncertain ||= providerUnknown
              await this.event(job, registration, ++sequence, { kind: 'settled', status: completed ? 'completed' : providerUnknown ? 'unknown' : event.reason === 'aborted' ? 'cancelled' : 'failed', usage })
              terminal = true
              if (needsContext && exchange && !job.cancelRequested) {
                if (job.supplemented.has(item.chunkId) || job.automaticSupplementCalls >= 3 || job.actualCalls >= MAX_DOCUMENT_PLAN_CALLS) throw rejected('supplement_budget_exceeded', '本块或整任务的自动补充预算已用尽；已保留原尝试。', 'request_document_context')
                job.help = { registration, sequence, contextVersion: resume?.token.contextVersion ?? 1, questions: needsContext, exchange, exchangeId: null }
                this.children.set(registration.childOperationId, job); job.pauseRequested = true
                await this.writeControl(job, { scope: job.scope, taskId: job.taskId, expectedTaskVersion: job.taskVersion,
                  operationId: `document-context:${registration.callId}` }, 'pause', 'waiting_context')
                const ref = this.helpReference(job)
                const accepted = await exchange.acceptBatchNeedsContext(job.exchangeOwner as unknown as Parameters<TranslationExchangeService['acceptBatchNeedsContext']>[0], ref, needsContext)
                if (!accepted.ok) throw rejected(accepted.error.code, accepted.error.message, accepted.error.stage)
                job.help.exchangeId = accepted.value.exchangeId
                job.phaseNotification = await exchange.notifyBatchMainAgent(job.exchangeOwner as unknown as Parameters<TranslationExchangeService['notifyBatchMainAgent']>[0], ref) ? 'enqueued' : 'unavailable'
                return
              }
              if (!completed) throw diagnostic ? rejected(diagnostic.code, diagnostic.message, diagnostic.stage) : rejected('incomplete_output', '模型输出未完整结束，保留残稿并停止后续块。', 'stream_document')
            }
          }
          if (!terminal) throw rejected('incomplete_output', '模型流缺少完整结算，停止后续块。', 'stream_document')
          job.completed.add(item.chunkId); job.completedChunks = job.completed.size
          if (resume && job.help) {
            const help = job.help, ref = this.helpReference(job)
            await help.exchange.finishBatchOperation(job.exchangeOwner as unknown as Parameters<TranslationExchangeService['finishBatchOperation']>[0], {
              ...ref.scope, callId: ref.callId, contextVersion: ref.contextVersion, hostGeneration: ref.hostGeneration, lastSequence: ref.lastSequence, exchangeId: help.exchangeId! }, 'completed')
            job.help = null
          }
        } catch (error) {
          const known = error as { code?: string; sequence?: number }
          sequence = known.sequence ?? sequence
          try { await job.writing } catch { job.uncertain = true }
          job.uncertain ||= ['outcome_unknown', 'invalid_reply'].includes(known.code ?? '')
          const diagnostic = this.adapter.diagnostic(internalId)
          // A transport failure after dispatch does not prove that the provider stopped.
          const stoppedByAbort = job.cancelRequested && job.controller.signal.aborted && error instanceof Error && error.name === 'AbortError'
          const providerUnknown = dispatched && !terminal && diagnostic?.stage === 'stream' && !stoppedByAbort
          if (providerUnknown) job.uncertain = true
          if (registered && dispatched && !terminal && (providerUnknown || !job.uncertain)) {
            try { await this.event(job, registration, ++sequence, { kind: 'settled', status: providerUnknown ? 'unknown' : stoppedByAbort ? 'cancelled' : 'failed', usage }) }
            catch { job.uncertain = true }
          }
          if (resume && job.help) {
            const help = job.help, ref = this.helpReference(job)
            try { await help.exchange.finishBatchOperation(job.exchangeOwner as unknown as Parameters<TranslationExchangeService['finishBatchOperation']>[0], {
              ...ref.scope, callId: ref.callId, contextVersion: ref.contextVersion, hostGeneration: ref.hostGeneration, lastSequence: ref.lastSequence,
              exchangeId: help.exchangeId! }, job.uncertain ? 'unknown' : 'cancelled') } catch { job.phaseNotification = 'unavailable' }
            if (!job.uncertain) job.help = null
          }
          if (diagnostic) throw rejected(diagnostic.code, diagnostic.message, diagnostic.stage)
          throw error
        } finally { this.adapter.discard(internalId); if (resume) job.resumeEntry = null }
      }
      if (job.pauseRequested) { job.status = 'paused'; return }
      await this.finish(job, 'completed')
    } catch (error) {
      const known = error as { code?: string; message?: string; stage?: string }
      job.uncertain ||= ['outcome_unknown', 'invalid_reply', 'scope_mismatch'].includes(known.code ?? '')
      job.status = this.disposed ? 'interrupted' : job.uncertain ? 'unknown' : job.cancelRequested ? 'cancelled' : 'failed'
      job.error = { code: known.code ?? 'document_execution_failed', message: known.message ?? '整篇执行已停止，已完成块及残稿保留。', stage: known.stage ?? 'execute_document' }
      if (!this.disposed && !job.finishing) {
        try { await job.writing; await this.finish(job, job.uncertain ? 'unknown' : job.cancelRequested ? 'cancelled' : 'failed') } catch { job.uncertain = true; job.status = 'unknown' }
      }
    } finally {
      if (!job.uncertain && !['paused', 'waiting_context', 'waiting_user'].includes(job.status)) this.release(job)
    }
  }
  private helpReference(job: Job): NeedsContextReference {
    const help = job.help!, registration = help.registration
    return { scope: { mainSessionId: job.scope.mainSessionId, topicId: job.scope.topicId, translationSessionId: job.scope.translationSessionId,
      unitId: job.unitId, sourceVersion: job.request.target.sourceVersion, operationId: registration.childOperationId }, callId: registration.callId!,
      contextVersion: help.contextVersion, hostGeneration: help.exchange.hostGeneration, lastSequence: job.taskSequence }
  }
  authorizePeer(mainSessionId: string, peerId: string): boolean { return this.topics.ownsConnection(mainSessionId, peerId) }
  private child(ref: ExecutorOperationRef): Job | undefined {
    const job = this.children.get(ref.operationId), help = job?.help
    if (!job || !help || this.disposed || !this.topics.ownsAgent(ref.mainSessionId, job.agent) || this.attachExchange(job.exchangeOwner)?.hostGeneration !== help.exchange.hostGeneration ||
      ref.hostGeneration !== help.exchange.hostGeneration || !same({ mainSessionId: ref.mainSessionId, topicId: ref.topicId, translationSessionId: ref.translationSessionId,
        unitId: ref.unitId, sourceVersion: ref.sourceVersion, operationId: ref.operationId }, this.helpReference(job).scope) ||
      ref.callId !== help.registration.callId || ref.contextVersion !== help.contextVersion || ref.exchangeId !== undefined && ref.exchangeId !== help.exchangeId) return undefined
    return job
  }
  async inspectOperation(ref: ExecutorOperationRef): Promise<unknown> {
    const job = this.child(ref)
    if (!job || job.status !== 'waiting_context' || ref.lastSequence !== job.taskSequence || job.controller.signal.aborted) return null
    const current = this.helpReference(job)
    return { scope: current.scope, callId: current.callId, contextVersion: current.contextVersion, hostGeneration: current.hostGeneration,
      lastSequence: current.lastSequence, status: 'waiting_context', sourceCodePointLength: job.snapshot!.preparation.totalCodePoints, requestContext: job.help!.questions }
  }
  async prepareResume(ref: ExecutorOperationRef, resolutionId: string, observedVersion: number, resolution: ExchangeResolution): Promise<PreparedExecutorResume> {
    const job = this.child(ref)
    if (!job || !['waiting_context', 'waiting_user'].includes(job.status) || ref.lastSequence !== job.taskSequence || job.controller.signal.aborted || !job.help?.exchangeId) throw rejected('resume_scope_mismatch', '补充目标不是当前等待的真实文档块。', 'authorize')
    const old = [...this.resumeTokens.values()].find(entry => entry.job === job && entry.resolutionId === resolutionId)
    if (old) { if (!same(old.resolution, resolution) || old.observedVersion !== observedVersion) throw rejected('idempotency_conflict', '同一答复标识不能更换补充内容。', 'prepare'); return old.token }
    const preparedTaskVersion = job.taskVersion, planRef = structuredClone(job.request.planRef), preparationRef = structuredClone(job.request.preparationRef), route = job.snapshot!.capacity.route
    let registration: DocumentBlockRegistration | null = null, packet: DocumentExecutionPacket | null = null
    if (resolution.kind === 'answer') {
      if (job.supplemented.has(job.help.registration.chunkId) || job.automaticSupplementCalls >= 3 || job.actualCalls >= MAX_DOCUMENT_PLAN_CALLS) throw rejected('supplement_budget_exceeded', '本块一次或整任务三次自动补充预算已用尽。', 'prepare')
      const context = job.help.registration.contextRef!, available = [...context.termRefs.map(ref => ({ id: ref.id, version: ref.kind === 'topic_term' ? ref.entryVersion : ref.version })), ...context.referenceRefs]
      if (resolution.references.some(reference => !available.some(item => item.id === reference.id && item.version === reference.version))) throw rejected('stale_reference', '补充引用不属于本块确切冻结的术语或依据版本。', 'prepare')
      const internalId = `document-supplement:${crypto.randomUUID()}`, snapshot = job.snapshot!, model = actualModel(snapshot)
      const capacity = await this.adapter.prepareDocumentCapacity(internalId, model, job.controller.signal)
      if (!this.adapter.documentRequestContextAvailable(internalId)) { this.adapter.discard(internalId); throw rejected('resume_capability_lost', '实际模型已失去求助工具能力。', 'prepare') }
      const input = this.workerInput(job), prompt = await this.planning.planner.reconstructExecution(input, snapshot, job.help.registration.chunkId, capacity, job.controller.signal)
      if (!prompt.ok) { this.adapter.discard(internalId); throw rejected(prompt.error.code, prompt.error.message, 'prepare') }
      registration = { ...job.help.registration, attemptId: `document-attempt:${crypto.randomUUID()}`, callId: `document-call:${crypto.randomUUID()}`,
        revisionId: `document-chunk:${crypto.randomUUID()}`, createdAt: new Date().toISOString(), contextRef: { ...prompt.value.contextRef, supplementRefs: [{ id: resolutionId, version: observedVersion }] } }
      packet = { operationId: internalId, callId: registration.callId!, attemptId: registration.attemptId!, model, systemPrompt: prompt.value.systemPrompt,
        userMessage: prompt.value.userMessage, prompt: { ...prompt.value, contextRef: registration.contextRef! }, requestContextAvailable: true,
        supplement: { resolutionId, observedVersion, answerText: resolution.answerText, organizedRequirements: resolution.organizedRequirements } }
      this.adapter.preflightDocument(packet)
    }
    if (job.taskVersion !== preparedTaskVersion || !same(job.request.planRef, planRef) || !same(job.request.preparationRef, preparationRef) || !same(job.snapshot!.capacity.route, route)) {
      if (packet) this.adapter.discard(packet.operationId)
      throw rejected('resume_dependency_changed', '补充准备期间任务控制版本或冻结依赖已变化。', 'prepare')
    }
    const token: PreparedExecutorResume = Object.freeze({ candidateCallId: registration?.callId ?? null, contextVersion: job.help.contextVersion + (registration ? 1 : 0), token: crypto.randomUUID() })
    this.resumeTokens.set(token.token, { token, job, resolutionId, observedVersion, resolution: structuredClone(resolution), registration, packet,
      preparedTaskVersion, planRef, preparationRef, route,
      registeredTaskVersion: null, registered: false, dispatched: false })
    return token
  }
  async registerResume(prepared: PreparedExecutorResume): Promise<ExecutorResumeRegistration> {
    const entry = this.resumeTokens.get(prepared.token)
    if (!entry || entry.token !== prepared || !entry.job.help || entry.job.uncertain || entry.job.controller.signal.aborted || this.attachExchange(entry.job.exchangeOwner)?.hostGeneration !== entry.job.help.exchange.hostGeneration ||
      entry.job.controlling || !entry.registered && entry.job.taskVersion !== entry.preparedTaskVersion || !same(entry.planRef, entry.job.request.planRef) || !same(entry.preparationRef, entry.job.request.preparationRef) || !same(entry.route, entry.job.snapshot!.capacity.route)) throw rejected('resume_token_invalid', '补充续作令牌、控制版本或实际协调代际已失效。', 'register_resume')
    if (!entry.registered) {
      const job = entry.job, status = entry.resolution.kind === 'answer' ? 'running' : entry.resolution.kind === 'defer' ? 'waiting_user' : 'cancelled'
      job.controlling = true
      try {
        const supplement: DocumentSupplementFact | undefined = entry.resolution.kind === 'answer' ? { id: entry.resolutionId, version: entry.observedVersion,
          chunkId: entry.registration!.chunkId, answerText: entry.resolution.answerText, organizedRequirements: entry.resolution.organizedRequirements,
          references: entry.resolution.references, createdAt: new Date().toISOString() } : undefined
        await this.writeControl(job, { scope: job.scope, taskId: job.taskId, operationId: `document-resolution:${entry.resolutionId}`, expectedTaskVersion: job.taskVersion },
          entry.resolution.kind === 'answer' ? 'resume' : entry.resolution.kind === 'defer' ? 'pause' : 'cancel', status, supplement ? { supplement } : {})
        if (supplement) { job.supplements.set(supplement.chunkId, supplement); job.supplemented.add(supplement.chunkId); job.automaticSupplementCalls++ }
        entry.registered = true; entry.registeredTaskVersion = job.taskVersion
        if (entry.resolution.kind === 'abort') { job.cancelRequested = true; job.controller.abort(); await this.finish(job, 'cancelled'); this.cleanup(job) }
      } finally { job.controlling = false }
    }
    return { candidateCallId: prepared.candidateCallId, contextVersion: prepared.contextVersion, lastSequence: entry.job.taskSequence }
  }
  async dispatchResume(prepared: PreparedExecutorResume): Promise<{ readonly status: 'resuming' }> {
    const entry = this.resumeTokens.get(prepared.token)
    if (!entry || entry.token !== prepared || !entry.registered || !entry.packet || !entry.registration || entry.job.uncertain || entry.job.controller.signal.aborted || !entry.job.help || this.attachExchange(entry.job.exchangeOwner)?.hostGeneration !== entry.job.help.exchange.hostGeneration ||
      entry.job.controlling || entry.job.taskVersion !== entry.registeredTaskVersion || !same(entry.planRef, entry.job.request.planRef) || !same(entry.preparationRef, entry.job.request.preparationRef) || !same(entry.route, entry.job.snapshot!.capacity.route)) throw rejected('resume_dispatch_unavailable', '补充尚未准确登记、依赖已改变或当前协调代际已失效。', 'dispatch')
    if (!entry.dispatched) {
      entry.dispatched = true; entry.job.resumeEntry = entry; entry.job.pauseRequested = false; entry.job.finishing = false; entry.job.status = 'running'; entry.job.error = null
      queueMicrotask(() => { const running = entry.job.running; if (running) void running.then(() => this.start(entry.job)); else this.start(entry.job) })
    }
    return { status: 'resuming' }
  }
  async queryOperation(ref: ExecutorOperationRef): Promise<unknown> { const job = this.child(ref); return job ? { status: job.status, lastSequence: job.taskSequence } : null }
  async cancelOperation(ref: ExecutorOperationRef): Promise<unknown> {
    const job = this.child(ref)
    if (!job) return false
    const result = await this.cancel({ scope: job.scope, taskId: job.taskId, operationId: `document-child-cancel:${ref.operationId}:${job.taskVersion}`, expectedTaskVersion: job.taskVersion }, this.execution(job))
    return result.ok
  }
  private async toolExecution(scope: DocumentTaskScope['scope'], exec?: ToolExecution): Promise<ToolExecution | null> {
    if (exec) return this.topics.ownsAgent(scope.mainSessionId, exec.agent) ? exec : null
    const peerId = this.ctx.invocation?.peer.id
    if (!peerId || !this.topics.ownsConnection(scope.mainSessionId, peerId)) return null
    const agent = this.topics.ownerAgent(scope.mainSessionId, peerId)
    return agent && this.topics.ownsAgent(scope.mainSessionId, agent) ? { agent, callId: `document-control:${crypto.randomUUID()}`, signal: new AbortController().signal } : null
  }
  private async writeControl(job: Job, request: TranslationBatchControl, kind: DocumentTaskControl['kind'], status: DocumentTaskStatus,
    changes: Pick<DocumentTaskControl, 'plan' | 'preparationRef' | 'executionBaseline' | 'reviewIssues' | 'supplement'> = {}): Promise<DocumentTaskReceipt> {
    await job.writing
    const taskSequence = ++job.taskSequence, at = new Date().toISOString()
    const value = await this.topics.requestOwned(job.scope.mainSessionId, { kind: 'document_control', request: {
      scope: job.scope, taskId: job.taskId, unitId: job.unitId, operationId: request.operationId, expectedTaskVersion: request.expectedTaskVersion,
      hostGeneration: this.hostGeneration, taskSequence, status, kind, at, ...changes } }, this.execution(job))
    if (value.kind !== 'document_updated') throw rejected('invalid_reply', 'Client 未准确确认整篇控制操作。', 'control_document')
    this.assertReceipt(job, value.receipt, taskSequence, changes.plan ? { id: changes.plan.id, version: changes.plan.version } : job.request.planRef, changes.preparationRef ?? job.request.preparationRef)
    if (value.receipt.taskVersion !== request.expectedTaskVersion + 1 || value.receipt.hostGeneration !== this.hostGeneration) throw rejected('invalid_reply', '整篇控制版本或 Host 代际未准确确认。', 'control_document')
    job.receipt = value.receipt; job.taskVersion = value.receipt.taskVersion; job.status = status
    job.facts.push({ taskSequence, kind, chunkId: null, childOperationId: null, sequence: null, at })
    return structuredClone(value.receipt)
  }
  private async restore(request: TranslationBatchControl, exec: ToolExecution): Promise<AnalysisResult<Job>> {
    const exchangeOwner = this.ctx
    try {
      const value = await this.topics.requestOwned(request.scope.mainSessionId, { kind: 'document_restore', request: {
        scope: request.scope, taskId: request.taskId, hostGeneration: this.hostGeneration } }, exec)
      if (value.kind !== 'document_restored') return failure('invalid_reply', 'Client 未返回准确的已保存任务。', 'restore_document')
      const capture = parseDocumentRestoreCapture(value.capture), receipt = capture.receipt, facts = capture.executionFacts
      if (!same(receipt.scope, request.scope) || receipt.taskId !== request.taskId || receipt.storage !== 'saved') return failure('history_unavailable', '此确切任务、原稿和准备尚未完整保存。', 'restore_document')
      if (receipt.taskVersion !== request.expectedTaskVersion) return failure('stale_version', '任务控制版本已变化，请先查询。', 'restore_document')
      if (['waiting_context', 'waiting_user'].includes(receipt.status)) return failure('context_restore_unavailable', '旧任务仍等待真实补充，原 Composer 交换与问题答复尚未保存；不能把它当普通失败续作。', 'restore_document')
      const previous = generations.get(receipt.hostGeneration ?? facts.baseline.hostGeneration)
      if (previous && previous !== this && !previous.disposed) return failure('prior_host_active', '旧 Host 代际仍有效，请向原任务查询或控制。', 'restore_document')
      if (previous?.jobs.get(request.taskId)?.running || facts.blocks.some(block => block.phase !== 'settled') || capture.chunks.some(chunk => ['running', 'unknown', 'interrupted'].includes(chunk.status)) || receipt.status === 'unknown') return failure('prior_call_unconfirmed', '旧任务存在未确认停止的登记或实际调用；只可查询，不能派发新尝试。', 'restore_document')
      const baseline = [...facts.controls].reverse().find(control => control.baseline)?.baseline ?? facts.baseline
      const source = capture.source, sources = this.ctx.get?.('translationSources') as import('./translation-sources.js').TranslationSourcesService
      const peerId = this.topics.ownerPeer(request.scope.mainSessionId, exec.agent!)
      if (!peerId) return failure('scope_mismatch', '恢复时原负责人连接已失效。', 'restore_document')
      let restoredAsset: import('../shared/translation-sources.js').TranslationSourceAsset | undefined
      if (source.body.kind === 'asset') {
        if (!capture.sourceRestore) return failure('source_reference_missing', '缺少原稿的准确已保存引用和历史确认 token。', 'restore_document')
        const restored = await sources.restoreForAgent(capture.sourceRestore, peerId, exec.agent!)
        if (!restored.ok) return restored
        restoredAsset = restored.value.source
      }
      const input: DocumentPlanningInput = { preparation: capture.preparation, restoredSource: source, maxInputChars: baseline.maxInputChars,
        analysis: { analysisId: capture.preparation.mechanicalCoverage.analysisId, version: capture.preparation.mechanicalCoverage.analysisVersion, actualCalls: baseline.analysisActualCalls },
        isCurrent: () => !this.disposed && this.topics.ownsAgent(request.scope.mainSessionId, exec.agent), readSource: range => {
          if (source.body.kind === 'inline') return Array.from(source.body.text).slice(range.start, range.end).join('')
          const read = sources.readForAgent(request.scope, restoredAsset!, range, peerId, exec.agent!)
          if (!read.ok) throw rejected(read.error.code, read.error.message, read.error.stage)
          return read.value.text
        } }
      const restored = await this.planning.planner.restoreExecution(input, capture.plan, baseline, exec.signal)
      if (!restored.ok) return restored
      const completed = new Set(capture.chunks.filter(chunk => chunk.status === 'completed').map(chunk => chunk.chunkId))
      const job: Job = { scope: request.scope, taskId: request.taskId, unitId: receipt.unitId, request: { target: capture.preparation.target,
        operationId: receipt.operationId, planRef: receipt.planRef, preparationRef: receipt.preparationRef }, agent: exec.agent!, exchangeOwner, controller: new AbortController(), delivery: new AbortController(),
        facts: [], createdAt: capture.source.createdAt, acceptance: Promise.resolve({ ok: true, value: receipt }), input, snapshot: restored.value, receipt,
        status: receipt.status, taskSequence: facts.taskSequence, actualCalls: facts.actualCalls, outputBytes: facts.outputBytes, completedChunks: completed.size, writing: Promise.resolve(),
        error: null, uncertain: false, acceptRequested: true, finishing: false, cleanupRequested: false, taskVersion: facts.taskVersion,
        pauseRequested: true, cancelRequested: false, running: null, completed, source, automaticSupplementCalls: facts.automaticSupplementCalls,
        supplemented: new Set((facts.supplements ?? []).map(item => item.chunkId)), supplements: new Map((facts.supplements ?? []).map(item => [item.chunkId, item])), reviewIssues: [...structuredClone(facts.reviewIssues)], help: null, resumeEntry: null, phaseNotification: 'unavailable', controlling: false, controlOwner: null, controllingKind: null }
      this.jobs.set(job.taskId, job); this.operations.set(key(job.scope.mainSessionId, job.request.operationId), job)
      return { ok: true, value: job }
    } catch (error) {
      const known = error as { code?: string; message?: string; stage?: string }
      return failure(known.code ?? 'restore_failed', known.message ?? '已保存任务恢复失败，未调用模型。', known.stage ?? 'restore_document')
    }
  }
  private async control(kind: DocumentTaskControl['kind'], args: unknown, exec?: ToolExecution): Promise<AnalysisResult<DocumentTaskReceipt>> {
    let request: TranslationBatchControl | TranslationBatchUpdate
    try { request = kind === 'update' ? parseTranslationBatchUpdate(args) : parseTranslationBatchControl(args) } catch { return Promise.resolve(failure('invalid_input', '整篇控制参数无效。', 'control_document')) }
    exec = await this.toolExecution(request.scope, exec) ?? undefined
    if (this.disposed || !exec) return failure('scope_mismatch', '整篇控制不属于当前实际主 Agent 或负责人 Peer。', 'authorize_document')
    const controlKey = key(request.scope.mainSessionId, request.operationId), signature = JSON.stringify([kind, request]), old = this.controls.get(controlKey)
    if (old) return old.signature === signature ? old.result : Promise.resolve(failure('idempotency_conflict', '同一控制操作标识不能更换目标或意图。', 'control_document'))
    const result = this.controlOnce(kind, request, exec)
    this.controls.set(controlKey, { signature, result }); return result
  }
  private async controlOnce(kind: DocumentTaskControl['kind'], request: TranslationBatchControl | TranslationBatchUpdate, exec?: ToolExecution): Promise<AnalysisResult<DocumentTaskReceipt>> {
    const authorized = await this.toolExecution(request.scope, exec)
    if (this.disposed || !authorized) return failure('scope_mismatch', '整篇控制不属于当前实际主 Agent 或负责人 Peer。', 'authorize_document')
    let job = this.jobs.get(request.taskId)
    if (!job && kind === 'resume') { const restored = await this.restore(request, authorized); if (!restored.ok) return restored; job = restored.value }
    if (!job || !same(job.scope, request.scope)) return failure('not_found', '未找到此确切范围的整篇任务。', 'control_document')
    if (job.taskVersion !== request.expectedTaskVersion) return failure('stale_version', '任务控制版本已变化，请查询后提交新的明确意图。', 'control_document')
    if (job.uncertain || job.status === 'unknown') return failure('outcome_unknown', '原任务结果未知；请查询原事实，不能派发新尝试。', 'control_document')
    if (job.controlling && !(kind === 'cancel' && job.controllingKind === 'pause')) return failure('busy', '此任务正在结算另一明确控制操作，请查询当前版本。', 'control_document')
    const controlOwner = {}
    job.controlling = true; job.controlOwner = controlOwner; job.controllingKind = kind
    try {
      if (kind === 'pause') {
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return failure('invalid_state', '此任务已停止，请按真实状态明确继续。', 'control_document')
        job.pauseRequested = true
        await job.running
        if (job.controlOwner !== controlOwner) return failure('pause_superseded', '暂停请求已由明确取消取代，请查询取消结果。', 'control_document')
        if (job.uncertain) throw rejected('outcome_unknown', '在途块结算未知，暂停只能查询。', 'control_document')
        if (['failed', 'cancelled'].includes(job.status)) return { ok: true, value: structuredClone(job.receipt!) }
        job.controllingKind = 'exchange'
        return { ok: true, value: await this.writeControl(job, request, kind, 'paused') }
      }
      if (kind === 'cancel') {
        if (job.status === 'completed') return failure('invalid_state', '此任务已经完成。', 'control_document')
        job.cancelRequested = true; job.pauseRequested = false; job.controller.abort()
        await job.running
        if (job.uncertain) throw rejected('outcome_unknown', '实际调用取消未确认；请查询原任务。', 'control_document')
        const receipt = await this.writeControl(job, request, kind, 'cancelled'); this.release(job); this.cleanup(job); return { ok: true, value: receipt }
      }
      if (kind === 'update') {
        if (job.status === 'completed') return failure('invalid_state', '已完成任务的依赖复核属于后续整篇检查阶段。', 'control_document')
        job.pauseRequested = true; await job.running
        if (job.uncertain) throw rejected('outcome_unknown', '在途块结果未知，不能更新依赖。', 'control_document')
        const update = request as TranslationBatchUpdate
        if (job.request.target.kind !== 'material') throw rejected('preparation_unavailable', '此任务缺少准确材料准备目标。', 'update_document')
        const captured = await this.planning.captureExecution(job.request.target, update.planRef, update.preparationRef, authorized)
        if (!captured.ok) throw rejected(captured.error.code, captured.error.message, captured.error.stage)
        let next = captured.value.snapshot
        const previous = job.snapshot!
        if (update.route) {
          const routed = await this.planning.planner.rerouteExecution(captured.value.input, next, update.route, authorized.signal)
          if (!routed.ok) throw rejected(routed.error.code, routed.error.message, routed.error.stage)
          next = routed.value
        }
        for (const id of job.completed) {
          const old = previous.plan.items.find(item => item.chunkId === id), replacement = next.plan.items.find(item => item.chunkId === id)
          if (!old || !replacement || !same(old.outputRange, replacement.outputRange) || old.mode !== replacement.mode) throw rejected('completed_range_changed', '新计划不能改写已完成块的范围或模式；源纠错另行处理。', 'update_document')
        }
        const changedIssues = [...job.completed].flatMap(chunkId => {
          const item = previous.plan.items.find(item => item.chunkId === chunkId)!, before = previous.budgets.find(item => item.chunkId === chunkId)!, after = next.budgets.find(item => item.chunkId === chunkId)!
          const termsBefore = previous.preparation.terms.filter(term => before.contextRef.termRefs.some(ref => same(ref, term.ref)))
          const termsAfter = next.preparation.terms.filter(term => after.contextRef.termRefs.some(ref => same(ref, term.ref)))
          const intersects = (range: { start: number; end: number }) => range.start < item.outputRange.end && item.outputRange.start < range.end
          return item.mode === 'translate' && (!same(termsBefore, termsAfter) || !same(previous.preparation.organizedRequirements, next.preparation.organizedRequirements) || !same(before.contextRef.contextRanges, after.contextRef.contextRanges) || !same(before.contextRef.referenceRefs, after.contextRef.referenceRefs) || !same(previous.protectedRanges.filter(intersects), next.protectedRanges.filter(intersects)))
            ? [{ code: 'dependency_changed', range: item.outputRange, message: '已完成块采用的用词、要求或上下文依赖已变化；需明确复核或后续重译。' }] : []
        })
        const issues = [...job.reviewIssues, ...changedIssues].filter((issue, index, all) => all.findIndex(other => same(other, issue)) === index)
        const receipt = await this.writeControl(job, request, kind, 'paused', { plan: next.plan, preparationRef: update.preparationRef, executionBaseline: this.baseline(job, next, captured.value.input), reviewIssues: issues })
        job.input = captured.value.input; job.snapshot = next; job.request = { ...job.request, planRef: update.planRef, preparationRef: update.preparationRef }
        job.reviewIssues = issues
        if (issues.length) await this.notifyPhase(job, 'document_dependencies_changed')
        return { ok: true, value: receipt }
      }
      if (!['paused', 'failed', 'cancelled', 'interrupted', 'waiting_user'].includes(job.status) || job.running) return failure('invalid_state', '只有已停止且结果已确认的任务可明确继续。', 'resume_document')
      if (job.help) return failure('context_resolution_required', '本块仍有实际求助问题，请通过当前 Composer 交换明确答复。', 'resume_document')
      if (!job.input || !job.snapshot) return failure('execution_baseline_missing', '原稿、准备或计划事实缺失，不能恢复。', 'resume_document')
      if (!this.normal.claimDocumentSession(job.scope.ownerId, job.scope.translationSessionId, job.taskId)) return failure('busy', '此翻译会话已被另一操作占用。', 'resume_document')
      job.controller = new AbortController(); job.pauseRequested = false; job.cancelRequested = false; job.finishing = false; job.cleanupRequested = false; job.error = null
      const receipt = await this.writeControl(job, request, kind, 'running', { executionBaseline: this.baseline(job) })
      queueMicrotask(() => this.start(job)); return { ok: true, value: receipt }
    } catch (error) {
      const known = error as { code?: string; message?: string; stage?: string }
      if (['outcome_unknown', 'invalid_reply'].includes(known.code ?? '')) { job.uncertain = true; job.status = 'unknown' }
      return failure(known.code ?? 'control_failed', known.message ?? '整篇控制未完成。', known.stage ?? 'control_document')
    } finally { if (job.controlOwner === controlOwner) { job.controlling = false; job.controlOwner = null; job.controllingKind = null } }
  }
  pause(args: unknown, exec?: ToolExecution): Promise<AnalysisResult<DocumentTaskReceipt>> { return this.control('pause', args, exec) }
  cancel(args: unknown, exec?: ToolExecution): Promise<AnalysisResult<DocumentTaskReceipt>> { return this.control('cancel', args, exec) }
  resume(args: unknown, exec?: ToolExecution): Promise<AnalysisResult<DocumentTaskReceipt>> { return this.control('resume', args, exec) }
  update(args: unknown, exec?: ToolExecution): Promise<AnalysisResult<DocumentTaskReceipt>> { return this.control('update', args, exec) }
  async status(args: unknown, exec?: ToolExecution): Promise<AnalysisResult<unknown>> {
    let request: TranslationBatchStatus
    try { request = parseTranslationBatchStatus(args) } catch { return failure('invalid_input', '整篇状态参数无效。', 'status_document') }
    exec = await this.toolExecution(request.scope, exec) ?? undefined
    if (this.disposed || !exec) return failure('scope_mismatch', '整篇查询不属于实际主 Agent 或负责人 Peer。', 'authorize_document')
    const job = this.jobs.get(request.taskId)
    if (!job) {
      try {
        const value = await this.topics.requestOwned(request.scope.mainSessionId, { kind: 'document_restore', request: { scope: request.scope, taskId: request.taskId, hostGeneration: this.hostGeneration } }, exec)
        if (value.kind !== 'document_restored') return failure('invalid_reply', 'Client 未返回确切保存事实。', 'status_document')
        const capture = parseDocumentRestoreCapture(value.capture), receipt = capture.receipt, facts = capture.executionFacts, after = request.afterTaskSequence ?? 0
        if (!same(receipt.scope, request.scope) || receipt.taskId !== request.taskId) return failure('scope_mismatch', '保存事实的任务范围不一致。', 'status_document')
        if (after > facts.taskSequence) return failure('invalid_cursor', '查询位置超过已保存实际序号。', 'status_document')
        const events = facts.controls.filter(control => control.taskSequence > after).slice(0, request.limit ?? 50).map(control => ({ taskSequence: control.taskSequence, kind: control.kind, chunkId: null, childOperationId: null, sequence: null, at: control.at }))
        const available = facts.controls.filter(control => control.taskSequence > after)
        const view = { scope: receipt.scope, taskId: receipt.taskId, unitId: receipt.unitId, operationId: receipt.operationId, sourceVersion: receipt.sourceVersion,
          planRef: receipt.planRef, preparationRef: receipt.preparationRef, status: receipt.status, receipt, taskSequence: facts.taskSequence, taskVersion: facts.taskVersion,
          hostGeneration: receipt.hostGeneration!, pauseRequested: receipt.status === 'paused', cancelRequested: receipt.status === 'cancelled',
          completedChunks: new Set(capture.chunks.filter(chunk => chunk.status === 'completed').map(chunk => chunk.chunkId)).size, chunkCount: capture.plan.items.length,
          actualCalls: facts.actualCalls, outputBytes: facts.outputBytes, maximumCalls: MAX_DOCUMENT_PLAN_CALLS, maximumOutputBytes: MAX_OUTPUT_BYTES,
          error: null, events, afterTaskSequence: after, nextCursor: events.length < available.length ? events.at(-1)?.taskSequence ?? after : null,
          restartExecutable: receipt.restartExecutable, automaticSupplementCalls: facts.automaticSupplementCalls, reviewIssues: facts.reviewIssues,
          review: facts.reviewIssues.length ? 'review_required' : 'pending', finalEligible: false, phaseNotification: 'unavailable' }
        return documentPlanningBytes({ ok: true, value: view }) > MAX_DOCUMENT_PLAN_PAGE_BYTES ? failure('reply_too_large', '保存状态完整回包超过 32768 字节。', 'status_document') : { ok: true, value: view }
      } catch (error) { const known = error as { code?: string; message?: string }; return failure(known.code ?? 'not_found', known.message ?? '未找到准确保存的任务事实。', 'status_document') }
    }
    if (!same(job.scope, request.scope)) return failure('scope_mismatch', '任务不属于此确切范围。', 'status_document')
    if (job.uncertain) {
      try {
        const value = await this.topics.requestOwned(job.scope.mainSessionId, { kind: 'document_observe', request: { scope: job.scope, taskId: job.taskId, unitId: job.unitId } }, exec)
        if (value.kind === 'document_observed' && value.receipt) {
          this.assertReceipt(job, value.receipt, value.receipt.taskSequence)
          if (value.receipt.taskSequence <= job.taskSequence) {
            job.receipt = value.receipt
            if (value.receipt.taskSequence === job.taskSequence && ['completed', 'failed', 'cancelled'].includes(value.receipt.status)) {
              job.status = value.receipt.status; job.uncertain = false
              if (job.status === 'completed') job.error = null
              this.release(job); this.cleanup(job)
            }
          }
        }
      } catch { /* Observation never dispatches or releases an uncertain parent lease. */ }
    }
    const after = request.afterTaskSequence ?? 0
    if (after > job.taskSequence) return failure('invalid_cursor', '状态位置超过此任务实际序号。', 'status_document')
    const available = job.facts.filter(item => item.taskSequence > after), events: ProgressFact[] = []
    const view = () => ({ scope: job.scope, taskId: job.taskId, unitId: job.unitId, operationId: job.request.operationId,
      sourceVersion: job.request.target.sourceVersion, planRef: job.request.planRef, preparationRef: job.request.preparationRef,
      status: job.status, receipt: job.receipt, taskSequence: job.taskSequence, taskVersion: job.taskVersion, hostGeneration: this.hostGeneration,
      pauseRequested: job.pauseRequested, cancelRequested: job.cancelRequested, completedChunks: job.completedChunks,
      chunkCount: job.snapshot?.plan.items.length ?? 0, actualCalls: job.actualCalls, outputBytes: job.outputBytes,
      maximumCalls: MAX_DOCUMENT_PLAN_CALLS, maximumOutputBytes: MAX_OUTPUT_BYTES, error: job.error, events,
      afterTaskSequence: after, nextCursor: events.length < available.length ? events.at(-1)?.taskSequence ?? after : null,
      restartExecutable: job.receipt?.restartExecutable ?? false, automaticSupplementCalls: job.automaticSupplementCalls, reviewIssues: job.reviewIssues,
      review: job.reviewIssues.length ? 'review_required' : 'pending', finalEligible: false, phaseNotification: job.phaseNotification })
    for (const fact of available.slice(0, request.limit ?? 50)) {
      events.push(fact)
      if (documentPlanningBytes({ ok: true, value: view() }) > MAX_DOCUMENT_PLAN_PAGE_BYTES) { events.pop(); break }
    }
    if (available.length && !events.length || documentPlanningBytes({ ok: true, value: view() }) > MAX_DOCUMENT_PLAN_PAGE_BYTES) return failure('reply_too_large', '完整整篇状态单项超过 32768 字节。', 'status_document')
    return { ok: true, value: structuredClone(view()) }
  }
  dispose(): void {
    this.disposed = true
    for (const registration of this.exchangeRegistrations.values()) { registration.unregister(); registration.unregisterPhase() }
    this.exchangeRegistrations.clear()
    for (const job of this.jobs.values()) {
      if (job.status === 'running') job.status = 'interrupted'
      job.controller.abort(); job.delivery.abort()
    }
  }
}

export function installDocumentExecution(ctx: TopicHostContext): DocumentExecutionService {
  const service = new DocumentExecutionService(ctx)
  ctx.provide('translationBatch', service)
  ctx.effect?.(() => () => service.dispose(), 'document execution lifetime')
  return service
}
