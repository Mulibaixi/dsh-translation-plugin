import { parseTranslationBatchExecute, parseTranslationBatchStatus, type TranslationBatchExecute,
  type TranslationBatchStatus, type DocumentTaskReceipt, type DocumentTaskEvent, type DocumentBlockRegistration,
  type DocumentTaskScope } from '../shared/document-execution.js'
import type { AnalysisResult } from '../shared/translation-preparation.js'
import type { DocumentTaskStatus } from '../shared/translation-batch.js'
import { documentPlanningBytes, MAX_DOCUMENT_PLAN_CALLS, MAX_DOCUMENT_PLAN_PAGE_BYTES } from '../shared/document-planning.js'
import { DshTextExecutionAdapter, type DocumentExecutionPacket } from './dsh-text-adapter.js'
import type { DocumentExecutionFreeze, DocumentPlanningInput } from './document-planner.js'
import type { DocumentPlanningService } from './document-planning-service.js'
import type { NormalTranslationService } from './normal-translation.js'
import type { TopicHostContext, TopicToolsService, ToolExecution, MainAgent } from './topic-tools.js'
import { MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, sourceCodePointLength } from '../shared/translation-source-read.js'

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
interface ProgressFact { readonly taskSequence: number; readonly kind: string; readonly chunkId: string | null; readonly childOperationId: string | null; readonly sequence: number | null; readonly at: string }
interface Job extends DocumentTaskScope {
  readonly request: TranslationBatchExecute
  readonly agent: MainAgent
  readonly controller: AbortController
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
}
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
  readonly adapter: DshTextExecutionAdapter
  private readonly jobs = new Map<string, Job>()
  private readonly operations = new Map<string, Job>()
  private disposed = false
  constructor(readonly ctx: TopicHostContext) { this.adapter = new DshTextExecutionAdapter(ctx) }
  private get topics(): TopicToolsService { return this.ctx.get?.('translationTopics') as TopicToolsService }
  private get planning(): DocumentPlanningService { return this.ctx.get?.('translationPlanning') as DocumentPlanningService }
  private get normal(): NormalTranslationService { return this.ctx.get?.('translationNormal') as NormalTranslationService }
  private execution(job: Job): ToolExecution { return { agent: job.agent, callId: job.request.operationId, signal: job.delivery.signal } }
  private release(job: Job): void { this.normal?.releaseDocumentSession(job.scope.ownerId, job.scope.translationSessionId, job.taskId) }
  private assertReceipt(job: Job, receipt: DocumentTaskReceipt, sequence: number): void {
    if (!same(receipt.scope, job.scope) || receipt.taskId !== job.taskId || receipt.unitId !== job.unitId ||
      receipt.operationId !== job.request.operationId || receipt.sourceVersion !== job.request.target.sourceVersion ||
      !same(receipt.planRef, job.request.planRef) || !same(receipt.preparationRef, job.request.preparationRef) || receipt.taskSequence !== sequence) {
      throw rejected('invalid_reply', '整篇登记回执的身份、版本或序号不一致。', 'document_writeback')
    }
  }
  async execute(args: unknown, exec: ToolExecution): Promise<AnalysisResult<DocumentTaskReceipt>> {
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
    const job: Job = { request, scope, taskId, unitId: `unit:${envelope.material.materialId}`, agent: exec.agent!,
      controller: new AbortController(), delivery: new AbortController(), facts: [], createdAt: new Date().toISOString(),
      acceptance: undefined!, input: null, snapshot: null, receipt: null, status: 'running', taskSequence: 0,
      actualCalls: 0, outputBytes: 0, completedChunks: 0, writing: Promise.resolve(), error: null, uncertain: false, acceptRequested: false, finishing: false, cleanupRequested: false }
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
      const admission = { envelope: job.input.envelope, operationId: request.operationId, taskId: job.taskId, unitId: job.unitId,
        plan: job.snapshot.plan, preparationRef: request.preparationRef,
        contextBindings: job.snapshot.budgets.map(item => ({ chunkId: item.chunkId, contextRef: item.contextRef })), createdAt: job.createdAt }
      job.acceptRequested = true
      const value = await this.topics.requestOwned(job.scope.mainSessionId, { kind: 'document_accept', request: admission }, this.execution(job))
      if (value.kind !== 'document_accepted') throw rejected('invalid_reply', 'Client 未准确确认整篇受理。', 'accept_document')
      this.assertReceipt(job, value.receipt, 0); job.receipt = value.receipt
      if (value.receipt.status !== 'running') throw rejected('invalid_reply', '整篇受理未建立运行中的真实单元。', 'accept_document')
      // The worker has its own lifetime after admission; completing the tool call does not cancel it.
      queueMicrotask(() => { void this.run(job) })
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
    payload: Omit<Extract<DocumentTaskEvent, { kind: 'dispatched' }>, keyof DocumentTaskScope | 'taskSequence' | 'childOperationId' | 'sequence' | 'revisionId' | 'at'> |
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
    if (status !== 'unknown') { this.release(job); this.cleanup(job) }
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
  private async run(job: Job): Promise<void> {
    const snapshot = job.snapshot!, input = job.input!
    // Freeze the route/preparation, while checking the original Agent/bridge/source at each read.
    const target = job.request.target
    if (target.kind !== 'material') return
    const materials = this.ctx.get?.('translationMaterials') as import('./translation-materials.js').TranslationMaterialsService
    const isCurrent = () => !this.disposed && !job.controller.signal.aborted && this.topics.ownsAgent(job.scope.mainSessionId, job.agent) && materials.deliveredForAgent(target, job.agent).ok
    const workerInput: DocumentPlanningInput = { ...input, isCurrent, readSource: range => {
      job.controller.signal.throwIfAborted()
      if (!isCurrent()) throw rejected('scope_mismatch', '整篇原稿授权已失效。', 'read_document_source')
      const pieces: string[] = []
      for (let start = range.start; start < range.end; start += MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) {
        const requested = { start, end: Math.min(range.end, start + MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) }, page = materials.readSource({ target, range: requested }, job.agent)
        if (!page.ok) throw rejected(page.error.code, page.error.message, page.error.stage)
        if (!same(page.value.range, requested) || page.value.totalCodePoints !== snapshot.preparation.totalCodePoints || sourceCodePointLength(page.value.text) !== requested.end - requested.start) throw rejected('source_mismatch', '整篇读取返回的固定源范围不一致。', 'read_document_source')
        pieces.push(page.value.text)
      }
      return pieces.join('')
    } }
    try {
      const points = await this.planning.planner.readExecutionSource(workerInput, snapshot, job.controller.signal)
      for (const item of snapshot.plan.items) {
        job.controller.signal.throwIfAborted()
        const internalId = `document-worker:${crypto.randomUUID()}`, registration: DocumentBlockRegistration = {
          scope: job.scope, taskId: job.taskId, unitId: job.unitId, chunkId: item.chunkId,
          childOperationId: `document-child:${crypto.randomUUID()}`, revisionId: `document-chunk:${crypto.randomUUID()}`,
          attemptId: item.mode === 'translate' ? `document-attempt:${crypto.randomUUID()}` : null,
          callId: item.mode === 'translate' ? `document-call:${crypto.randomUUID()}` : null, createdAt: new Date().toISOString() }
        let sequence = 0, dispatched = false, registered = false, terminal = false
        let usage: { inputTokens: number | null; outputTokens: number | null } = { inputTokens: null, outputTokens: null }
        try {
          if (item.mode === 'copy') {
            const text = points.slice(item.outputRange.start, item.outputRange.end).join(''), bytes = new TextEncoder().encode(text)
            if (job.outputBytes + bytes.byteLength > MAX_OUTPUT_BYTES) throw rejected('output_budget_exceeded', '整篇实际正文超过 16 MiB，停止后续块。', 'copy_document')
            const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer))].map(value => value.toString(16).padStart(2, '0')).join('')
            await this.register(job, registration); registered = true
            await this.event(job, registration, ++sequence, { kind: 'copy', sha256: hash }); job.outputBytes += bytes.byteLength
            job.completedChunks++; continue
          }
          if (job.actualCalls >= MAX_DOCUMENT_PLAN_CALLS) throw rejected('call_budget_exceeded', '已达到 512 次实际模型调用预算，停止后续块。', 'dispatch_document')
          const model = actualModel(snapshot), capacity = await this.adapter.prepareDocumentCapacity(internalId, model, job.controller.signal)
          const prompt = await this.planning.planner.reconstructExecution(workerInput, snapshot, item.chunkId, capacity, job.controller.signal, points)
          if (!prompt.ok) throw rejected(prompt.error.code, prompt.error.message, prompt.error.stage)
          const packet: DocumentExecutionPacket = { operationId: internalId, callId: registration.callId!, attemptId: registration.attemptId!, model,
            systemPrompt: prompt.value.systemPrompt, userMessage: prompt.value.userMessage, prompt: prompt.value }
          const record = this.adapter.preflightDocument(packet)
          await this.register(job, registration); registered = true
          for await (const event of this.adapter.executeDocument(packet, job.controller.signal, () => {
            dispatched = true; job.actualCalls++
            void this.event(job, registration, ++sequence, { kind: 'dispatched', callRecord: record }).catch(() => {})
          })) {
            await job.writing
            if (event.type === 'text') sequence = await this.append(job, registration, sequence, event.text)
            else if (event.type === 'usage') usage = { inputTokens: event.input_tokens ?? null, outputTokens: event.output_tokens ?? null }
            else if (event.type === 'terminal') {
              const completed = event.reason === 'stop' && event.completeness === 'complete' && event.checks_passed && event.provider_state === 'finished'
              const diagnostic = this.adapter.diagnostic(internalId)
              const providerUnknown = event.reason === 'error' && ['TIMEOUT', 'TRANSPORT', 'EXECUTION_FAILED'].includes(diagnostic?.code ?? '')
              job.uncertain ||= providerUnknown
              await this.event(job, registration, ++sequence, { kind: 'settled', status: completed ? 'completed' : providerUnknown ? 'unknown' : event.reason === 'aborted' ? 'cancelled' : 'failed', usage })
              terminal = true
              if (!completed) throw diagnostic ? rejected(diagnostic.code, diagnostic.message, diagnostic.stage) : rejected('incomplete_output', '模型输出未完整结束，保留残稿并停止后续块。', 'stream_document')
            }
          }
          if (!terminal) throw rejected('incomplete_output', '模型流缺少完整结算，停止后续块。', 'stream_document')
          job.completedChunks++
        } catch (error) {
          const known = error as { code?: string; sequence?: number }
          sequence = known.sequence ?? sequence
          try { await job.writing } catch { job.uncertain = true }
          job.uncertain ||= ['outcome_unknown', 'invalid_reply'].includes(known.code ?? '')
          const diagnostic = this.adapter.diagnostic(internalId)
          // A transport failure after dispatch does not prove that the provider stopped.
          const providerUnknown = dispatched && !terminal && diagnostic?.stage === 'stream'
          if (providerUnknown) job.uncertain = true
          if (registered && dispatched && !terminal && (providerUnknown || !job.uncertain)) {
            try { await this.event(job, registration, ++sequence, { kind: 'settled', status: providerUnknown ? 'unknown' : 'failed', usage }) }
            catch { job.uncertain = true }
          }
          if (diagnostic) throw rejected(diagnostic.code, diagnostic.message, diagnostic.stage)
          throw error
        } finally { this.adapter.discard(internalId) }
      }
      await this.finish(job, 'completed')
    } catch (error) {
      const known = error as { code?: string; message?: string; stage?: string }
      job.uncertain ||= ['outcome_unknown', 'invalid_reply', 'scope_mismatch'].includes(known.code ?? '')
      job.status = this.disposed ? 'interrupted' : job.uncertain ? 'unknown' : 'failed'
      job.error = { code: known.code ?? 'document_execution_failed', message: known.message ?? '整篇执行已停止，已完成块及残稿保留。', stage: known.stage ?? 'execute_document' }
      if (!this.disposed && !job.finishing) {
        try { await job.writing; await this.finish(job, job.uncertain ? 'unknown' : 'failed') } catch { job.uncertain = true; job.status = 'unknown' }
      }
    } finally {
      if (!job.uncertain) this.release(job)
      // No resume or automatic retry is introduced in this stage.
      job.input = null
    }
  }
  async status(args: unknown, exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    let request: TranslationBatchStatus
    try { request = parseTranslationBatchStatus(args) } catch { return failure('invalid_input', '整篇状态参数无效。', 'status_document') }
    if (this.disposed || !this.topics.ownsAgent(request.scope.mainSessionId, exec.agent)) return failure('scope_mismatch', '整篇查询不属于实际主 Agent。', 'authorize_document')
    const job = this.jobs.get(request.taskId)
    if (!job || !same(job.scope, request.scope)) return failure('not_found', '未找到此确切范围的运行期整篇任务。', 'status_document')
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
      status: job.status, receipt: job.receipt, taskSequence: job.taskSequence, completedChunks: job.completedChunks,
      chunkCount: job.snapshot?.plan.items.length ?? 0, actualCalls: job.actualCalls, outputBytes: job.outputBytes,
      maximumCalls: MAX_DOCUMENT_PLAN_CALLS, maximumOutputBytes: MAX_OUTPUT_BYTES, error: job.error, events,
      afterTaskSequence: after, nextCursor: events.length < available.length ? events.at(-1)?.taskSequence ?? after : null,
      restartExecutable: false, review: 'pending', finalEligible: false, phaseNotification: 'unavailable' })
    for (const fact of available.slice(0, request.limit ?? 50)) {
      events.push(fact)
      if (documentPlanningBytes({ ok: true, value: view() }) > MAX_DOCUMENT_PLAN_PAGE_BYTES) { events.pop(); break }
    }
    if (available.length && !events.length || documentPlanningBytes({ ok: true, value: view() }) > MAX_DOCUMENT_PLAN_PAGE_BYTES) return failure('reply_too_large', '完整整篇状态单项超过 32768 字节。', 'status_document')
    return { ok: true, value: structuredClone(view()) }
  }
  dispose(): void {
    this.disposed = true
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
