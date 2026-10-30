import { parseTranslationLogRead, type TranslationLogRead, type TranslationLogPage } from '../shared/translation-log.js'
import { SOURCE_LAYOUT_GUIDANCE } from '../shared/translation-call.js'
import { translationTaskBoundary } from '../shared/translation-task.js'
import { STYLE_SETTINGS_GUIDANCE } from '../shared/style-settings.js'
import { historyContextRefs, type DirectHistoryRefs } from '../shared/direct-history-context.js'
import { diagnosticSpan } from '../shared/diagnostics.js'
import { historyTargetMatches } from './history-resources.js'
import type { HistoryScope } from '../shared/history-bundle.js'
import { languageMatches } from '../shared/language-tag.js'
import type { ReferenceFilesService } from './reference-files.js'
import type { OtherMemoryService } from './other-memory.js'
import { NORMAL_TRANSLATION_REMOTE, parseNormalTranslationExecute, parseNormalTranslationQuery, type NormalTranslationExecute,
  type NormalTranslationOperation, type NormalTranslationQuery, type NormalTranslationJob, type NormalTranslationResult,
  type NormalTranslationUpdate, type NormalTranslationError, type NormalTranslationCapability,
  parseNormalTranslationSourceCorrection, type NormalTranslationCorrectionReceipt,
  parseNormalTranslationUnitRequest, type NormalTranslationUnitRequest, type NormalTranslationUnitReceipt,
  parseDirectTranslationRequest, type DirectTranslationRequest, type DirectTranslationCommit, type DirectTranslationReceipt, type RawDirectTranslationRequest,
  parseNormalTranslationResultRead, type NormalTranslationTermReference, type DirectTranslationRange, draftTranslationTerms,
  type NormalTranslationExport, type NormalTranslationMaterialTarget, type NormalTranslationUnitTarget, type NormalTranslationTarget } from '../shared/normal-translation.js'
import type { TermHandleRegistry } from './term-handles.js'
import { NORMAL_TRANSLATION_V2_REMOTE, NormalTranslationAttemptJournal, type NormalTranslationV2Job, type NormalTranslationV2Status } from '../shared/normal-translation-v2.js'
import { MAX_TOPIC_BRIDGE_REPLY_BYTES, type TopicBridgeValue } from '../shared/topic-bridge.js'
import { sourceAnnotationChecks, type TranslationCheck } from '../shared/translation-quality.js'
import { MAX_TRANSLATION_SOURCE_PAGE_BYTES, MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, sourceCodePointLength } from '../shared/translation-source-read.js'
import type { TranslationMaterialEnvelope, TranslationMaterialSnapshot } from '../shared/translation-material.js'
import { isNormalExchangePromptVersion, translationCallFacts, type NormalTranslationContext, type TranslationCallMetadata } from '../shared/translation-call.js'
import type { RequestContextInput } from '../shared/request-context.js'
import type { TopicTermSnapshot } from '../memory/topic-terms.js'
import { DshTextExecutionAdapter, hostLlmLoader, type LlmModuleLoader, type NormalExecutionPacket } from './dsh-text-adapter.js'
import { uiLanguageDirective } from './ui-language.js'
import type { TopicHostContext, TopicToolsService, ToolExecution, MainAgent } from './topic-tools.js'
import type { TranslationMaterialsService } from './translation-materials.js'
import type { TranslationExchangeService, ExecutorOperationRef, NeedsContextReference, ExchangeScope, ExchangeResolution,
  PreparedExecutorResume, ExecutorResumeRegistration } from 'dsh-composer-extension/contracts'
import type { NormalTranslationResolution } from '../shared/normal-translation-v2.js'
import type { FileJobConflict, FileJobMechanicalIssue, FileJobProposal, FileJobTerm, FileJobWorker } from '../shared/file-jobs.js'
import { FileWorkerRuntime } from './file-worker-runtime.js'
import { artifactExtension, parseArtifactOpen, parseArtifactSave, type TranslationArtifactCheck, type TranslationArtifactSaved } from '../shared/translation-artifact.js'
import { TRANSLATION_SELF_REVIEW, DIRECT_REVISION_GUIDANCE, FILE_MEMORY_REVIEW_GUIDANCE, MARKDOWN_REVIEW_GUIDANCE } from '../shared/translation-review.js'
import { resolveMarkdownImages } from './markdown-files.js'
import { loadArtifactStorage, type ArtifactStorage } from './translation-delivery.js'
import { assetPriority } from '../memory/asset-priority.js'
import type { ModelSelection } from '../shared/contracts.js'

type Accepted = Extract<TopicBridgeValue, { kind: 'normal_operation' }>
type Envelope = Extract<TranslationMaterialEnvelope, { kind: 'material' }>
type InlineEnvelope = Envelope & { readonly material: Extract<TranslationMaterialSnapshot, { readonly sourceText: string }> }
interface Admission { readonly signature: string; readonly sessionId: string; readonly result: Promise<Accepted> }
interface Job {
  readonly namespaceId: string | undefined
  readonly request: NormalTranslationExecute
  readonly envelope: InlineEnvelope
  readonly agent: MainAgent
  readonly sessionId: string
  readonly controller: AbortController
  readonly delivery: AbortController
  readonly internalId: string
  readonly updates: NormalTranslationUpdate[]
  acceptance: Promise<NormalTranslationOperation>
  operation: NormalTranslationOperation | null
  packet: NormalExecutionPacket | undefined
  callId: string | null
  metadata: TranslationCallMetadata | null
  status: NormalTranslationJob['status']
  error: NormalTranslationError | null
  requestContext?: RequestContextInput
  readonly attempts: NormalTranslationAttemptJournal
  v2Status: NormalTranslationV2Status
  exchangeId: string | null
  deliveryFailed: boolean
  deliveredSequence: number
  acceptRequested: boolean
  writing: Promise<void>
  exchange?: TranslationExchangeService
  exchangeOwner?: TopicHostContext
}
interface ResumeToken {
  readonly token: PreparedExecutorResume
  readonly job: Job
  readonly exchangeId: string
  readonly resolutionId: string
  readonly resolution: ExchangeResolution
  readonly clientResolution: NormalTranslationResolution
  readonly packet: NormalExecutionPacket | null
  readonly metadata: TranslationCallMetadata | null
  registered: boolean
  dispatched: boolean
}
function rejected(code: string, message: string, stage: string): Error { return Object.assign(new Error(message), { code, stage }) }
/** Per-attempt facts used to decide whether a failed direct call may release its operationId placeholder. */
interface DispatchAttempt { dispatched: boolean; resolved: boolean }
/** What one direct call returns to the main model: the body, the real terminal facts and the recorded revision. */
export interface DirectTranslationView {
  readonly target?: NormalTranslationUnitTarget
  readonly nextStep?: string
  readonly assetReview?: { readonly tool: 'translation_submit_proposals'; readonly target: import('../shared/normal-translation.js').NormalTranslationUnitTarget; readonly revisionId: string; readonly nextStep: string }
  readonly operationId: string
  readonly mainSessionId: string
  readonly translationSessionId: string
  readonly topicId: string
  readonly unitId: string
  readonly revisionId: string
  readonly sourceVersion: number
  readonly status: 'completed' | 'failed' | 'cancelled' | 'unknown'
  /** Whether the Client confirmed the revision write. A model body alone is not a saved result. */
  readonly recorded: boolean
  readonly text?: string
  readonly textPreview?: string
  readonly totalCodePoints: number
  readonly truncated: boolean
  /** Actual route and usage facts; the per-call context is not echoed back into the main chat. */
  readonly metadata: Omit<TranslationCallMetadata, 'context'>
  /** Local stage durations for latency diagnosis; no user text is included. */
  readonly timing: { readonly prepareMs: number; readonly firstTextMs: number | null; readonly streamMs: number; readonly recordMs: number; readonly totalMs: number }
  readonly message?: string
  readonly resultRef?: { readonly operationId: string; readonly totalCodePoints: number; readonly tool: 'translation_read_result' }
  readonly persistence: 'saved' | 'runtime_only' | 'unconfirmed'
  readonly contextUsage?: { readonly terms: number; readonly nearbyUnits: number; readonly revisionBaseId: string | null; readonly referenceStatus: string; readonly referenceFiles: number }
}
function ok<T>(value: T): NormalTranslationResult<T> { return { ok: true, value: structuredClone(value) } }
function bad<T>(code: string, message: string, stage: string): NormalTranslationResult<T> { return { ok: false, error: { code, message, stage } } }
function identity(ownerId: string, operationId: string): string { return JSON.stringify([ownerId, operationId]) }
function requireInline(envelope: Envelope): asserts envelope is InlineEnvelope {
  if (envelope.material.sourceRef !== undefined) throw rejected('requires_batch', '文件原稿已固定；请用 translation_translate 直接翻译整篇、指定范围或整理正文，不要再启动旧文件任务。', 'prepare')
}

/** Transient calls and short receipts only. The Client owns all source and revision history. */
export interface TranslationExtractionView {
  readonly operationId: string
  readonly materialId: string
  readonly sourceVersion: number
  readonly range: DirectTranslationRange
  readonly totalCodePoints: number
  readonly terms: readonly FileJobTerm[]
  readonly proposals: readonly FileJobProposal[]
  readonly conflicts: readonly FileJobConflict[]
  readonly warnings: readonly FileJobMechanicalIssue[]
  readonly worker: FileJobWorker
  readonly truncated: boolean
}
export class NormalTranslationService {
  readonly typertRemote: { readonly service: NormalTranslationService; readonly serviceKey: 'translationNormal'; readonly namespace: 'translationNormal' }
  readonly typertRemoteV2: { readonly service: { status: NormalTranslationService['statusV2']; cancel: NormalTranslationService['cancelV2'] }; readonly serviceKey: 'translationNormalV2'; readonly namespace: 'translationNormalV2' }
  readonly v2Remote: { status: NormalTranslationService['statusV2']; cancel: NormalTranslationService['cancelV2'] }
  readonly adapter: DshTextExecutionAdapter
  private readonly admissions = new Map<string, Admission>()
  private readonly jobs = new Map<string, Job>()
  private readonly resolved = new Map<string, { readonly signature: string; readonly result: Promise<Envelope> }>()
  private readonly corrections = new Map<string, { readonly signature: string; readonly result: Promise<NormalTranslationCorrectionReceipt> }>()
  private readonly unitRequests = new Map<string, { readonly signature: string; readonly result: Promise<NormalTranslationResult<NormalTranslationUnitReceipt>> }>()
  private readonly activeSessions = new Set<string>()
  private readonly documentSessions = new Map<string, string>()
  private readonly resumeTokens = new Map<string, ResumeToken>()
  private readonly resumesByResolution = new Map<string, ResumeToken>()
  private readonly direct = new Map<string, { readonly signature: string; readonly promise: Promise<DirectTranslationView>; settled: boolean;
    callId?: string; historyContext?: { readonly translationSessionId: string; readonly topicId: string; readonly refs: DirectHistoryRefs } }>()
  private readonly directResults = new Map<string, { readonly ownerId: string; readonly text: string; readonly status: string }>()
  private readonly extractions = new Map<string, { readonly signature: string; readonly promise: Promise<TranslationExtractionView>; settled: boolean }>()
  private readonly savedArtifacts = new Map<string, string>()
  private readonly workers: FileWorkerRuntime
  private artifacts: Promise<ArtifactStorage> | undefined
  private exchange: TranslationExchangeService | undefined
  private unregisterExchange: (() => void) | undefined
  private disposed = false
  constructor(readonly ctx: TopicHostContext, loadModule?: LlmModuleLoader) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationNormal', property: 'ctx' } })
    this.workers = new FileWorkerRuntime(ctx)
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'translationNormal', namespace: 'translationNormal' })
    // Gateway must bind the v2 service and its invocation-scoped Context, just like v1.
    const v2Remote = {
      ctx,
      status(this: { ctx: TopicHostContext }, request: NormalTranslationQuery) {
        return (this.ctx.get?.('translationNormal') as NormalTranslationService).statusV2(request)
      },
      cancel(this: { ctx: TopicHostContext }, request: NormalTranslationQuery) {
        return (this.ctx.get?.('translationNormal') as NormalTranslationService).cancelV2(request)
      },
    }
    Object.defineProperty(v2Remote, Symbol.for('cordis.tracker'), { value: { associate: 'translationNormalV2', property: 'ctx' } })
    this.v2Remote = v2Remote
    this.typertRemoteV2 = Object.freeze({ service: v2Remote, serviceKey: 'translationNormalV2', namespace: 'translationNormalV2' })
    Object.defineProperty(v2Remote, 'typertRemote', { value: this.typertRemoteV2, configurable: true, writable: true })
    this.adapter = new DshTextExecutionAdapter(ctx, loadModule)
    this.attachExchange(ctx)
  }
  private attachExchange(scope: TopicHostContext): TranslationExchangeService | undefined {
    const exchange = scope.get?.('translationExchange') as TranslationExchangeService | undefined
    if (!exchange || this.exchange === exchange) return exchange
    this.unregisterExchange?.()
    this.exchange = exchange
    this.unregisterExchange = exchange.register(scope as unknown as Parameters<TranslationExchangeService['register']>[0], this)
    return exchange
  }
  private get topics(): TopicToolsService { return this.ctx.get?.('translationTopics') as TopicToolsService }
  private get materials(): TranslationMaterialsService { return this.ctx.get?.('translationMaterials') as TranslationMaterialsService }
  private async savedRequirements(mainSessionId: string, topicId: string): Promise<Pick<NormalTranslationContext, 'memoryRequirements'>> {
    const memory = this.ctx.get?.('translationOtherMemory') as OtherMemoryService | undefined
    if (!memory) return {}
    const namespaceId = this.topics.namespaceForAgent(mainSessionId)
    if (!namespaceId) throw rejected('memory_scope_unavailable', '尚未确认当前资料库，无法读取已保存的翻译设定。', 'prepare')
    const entries = await memory.effectiveSettings(namespaceId, topicId)
    const memoryRequirements = entries.map(({ id, version, topicId, title, body }) => ({ id, version, topicId, title, body }))
    if (new TextEncoder().encode(JSON.stringify(memoryRequirements)).byteLength > 32768) {
      throw rejected('memory_requirements_limit', `适用翻译设定超过本次调用 32768 字节预算，请精简或停用后重试：${entries.map(entry => entry.title).join('、')}`, 'prepare')
    }
    return memoryRequirements.length ? { memoryRequirements } : {}
  }
  /** One parent reservation shares the short-text occupancy rule; its children do not reacquire it. */
  claimDocumentSession(ownerId: string, translationSessionId: string, taskId: string): boolean {
    const sessionId = translationSessionId, current = this.documentSessions.get(sessionId)
    if (current === taskId) return true
    if (this.disposed || this.activeSessions.has(sessionId)) return false
    this.activeSessions.add(sessionId); this.documentSessions.set(sessionId, taskId)
    return true
  }
  releaseDocumentSession(ownerId: string, translationSessionId: string, taskId: string): void {
    const sessionId = identity(ownerId, translationSessionId)
    if (this.documentSessions.get(sessionId) !== taskId) return
    this.documentSessions.delete(sessionId); this.activeSessions.delete(sessionId)
  }
  async inspectOperation(ref: ExecutorOperationRef): Promise<unknown> {
    const job = this.jobs.get(identity(ref.mainSessionId, ref.operationId)), operation = job?.operation
    const latest = job?.attempts.snapshot().attempts.at(-1)
    if (!job || !operation || !job.requestContext || !['running', 'waiting_context'].includes(job.v2Status) || job.controller.signal.aborted || !latest ||
      job.callId !== ref.callId || ref.hostGeneration !== job.exchange?.hostGeneration || ref.contextVersion !== latest.contextVersion ||
      ref.lastSequence !== job.attempts.snapshot().events.length || (latest.endSequence !== null && latest.status !== 'failed')) return null
    const scope: ExchangeScope = { mainSessionId: operation.mainSessionId, topicId: operation.topicId, translationSessionId: operation.translationSessionId,
      unitId: operation.unitId, sourceVersion: operation.sourceVersion, operationId: operation.operationId }
    if (JSON.stringify(scope) !== JSON.stringify({ mainSessionId: ref.mainSessionId, topicId: ref.topicId, translationSessionId: ref.translationSessionId,
      unitId: ref.unitId, sourceVersion: ref.sourceVersion, operationId: ref.operationId })) return null
    return { scope, callId: job.callId, contextVersion: ref.contextVersion, hostGeneration: ref.hostGeneration, status: 'waiting_context',
      lastSequence: job.attempts.snapshot().events.length, sourceCodePointLength: Array.from(job.envelope.material.sourceText).length, requestContext: job.requestContext }
  }
  async prepareResume(ref: ExecutorOperationRef, resolutionId: string, observedVersion: number, resolution: ExchangeResolution): Promise<PreparedExecutorResume> {
    const job = this.jobs.get(identity(ref.mainSessionId, ref.operationId)), latest = job?.attempts.snapshot().attempts.at(-1)
    if (!job || !job.operation || !job.packet || !job.requestContext || !['waiting_context', 'waiting_user'].includes(job.v2Status) ||
      job.controller.signal.aborted || !latest || latest.endSequence === null || latest.status !== 'failed' || job.callId !== ref.callId ||
      ref.hostGeneration !== job.exchange?.hostGeneration || ref.contextVersion !== latest.contextVersion ||
      ref.lastSequence !== job.attempts.snapshot().events.length || job.exchangeId !== ref.exchangeId) throw rejected('resume_scope_mismatch', '续作目标不是当前仍等待补充的翻译操作。', 'authorize')
    const tokenKey = JSON.stringify([job.internalId, resolutionId]), previous = this.resumesByResolution.get(tokenKey)
    if (previous) {
      if (JSON.stringify(previous.resolution) !== JSON.stringify(resolution) || previous.token.contextVersion !== ref.contextVersion + 1) throw rejected('resume_idempotency_conflict', '同一 resolutionId 不能更换答复或续作上下文。', 'protocol')
      return previous.token
    }
    let clientResolution: NormalTranslationResolution
    if (resolution.kind === 'answer') {
      if (job.packet.referenceContext) await (this.ctx.get?.('translationReferences') as ReferenceFilesService).validateContext(job.packet.referenceContext, {agent:job.agent,callId:job.request.operationId,signal:job.controller.signal})
      const termIds = new Set(job.packet.context.terms.map(term => JSON.stringify([term.id, term.entryVersion])))
      if (resolution.references.some(reference => !termIds.has(JSON.stringify([reference.id, reference.version])))) throw rejected('stale_reference', '答复引用不属于该翻译操作冻结的术语或依据版本。', 'resolve')
      clientResolution = { ...resolution, resolutionId, observedVersion }
      const candidateCallId = `normal-call:${crypto.randomUUID()}`
      const packet: NormalExecutionPacket = { ...job.packet, operationId: `${job.internalId}:resume:${candidateCallId}`, callId: candidateCallId, exchangeResume: clientResolution,
        exchangeContextVersion: ref.contextVersion + 1 }
      const metadata = await this.adapter.prepareNormalResume(packet, job.controller.signal)
      const token: PreparedExecutorResume = Object.freeze({ candidateCallId, contextVersion: ref.contextVersion + 1, token: crypto.randomUUID() })
      const entry: ResumeToken = { token, job, exchangeId: job.exchangeId!, resolutionId, resolution, clientResolution, packet, metadata, registered: false, dispatched: false }
      this.resumeTokens.set(token.token as string, entry); this.resumesByResolution.set(tokenKey, entry)
      return token
    }
    clientResolution = { ...resolution, resolutionId, observedVersion }
    const token: PreparedExecutorResume = Object.freeze({ candidateCallId: null, contextVersion: ref.contextVersion, token: crypto.randomUUID() })
    const entry: ResumeToken = { token, job, exchangeId: job.exchangeId!, resolutionId, resolution, clientResolution, packet: null, metadata: null, registered: false, dispatched: false }
    this.resumeTokens.set(token.token as string, entry); this.resumesByResolution.set(tokenKey, entry)
    return token
  }
  async registerResume(prepared: PreparedExecutorResume): Promise<ExecutorResumeRegistration> {
    const entry = this.resumeTokens.get(prepared.token as string)
    if (!entry || entry.token !== prepared || entry.token.candidateCallId !== prepared.candidateCallId || entry.token.contextVersion !== prepared.contextVersion) throw rejected('resume_token_invalid', '续作准备令牌无效。', 'authorize')
    if (entry.registered) return { candidateCallId: prepared.candidateCallId, contextVersion: prepared.contextVersion, lastSequence: entry.job.attempts.snapshot().events.length }
    const { job, clientResolution, exchangeId } = entry, operation = job.operation!
    const value = await this.topics.requestOwned(operation.mainSessionId, { kind: 'normal_exchange_resolve', translationSessionId: operation.translationSessionId,
      exchangeId, resolution: clientResolution }, { agent: job.agent, callId: operation.operationId, signal: job.delivery.signal })
    if (value.kind !== 'normal_exchange_resolved' || value.exchangeId !== exchangeId || value.status !== (clientResolution.kind === 'answer' ? 'resuming' : clientResolution.kind === 'defer' ? 'waiting_user' : 'cancelled')) throw rejected('resume_resolution_unconfirmed', 'Client 未确认求助答复登记。', 'register_resume')
    if (clientResolution.kind === 'answer') {
      job.attempts.resumeRegistered(prepared.candidateCallId!, prepared.contextVersion, entry.resolutionId, exchangeId)
      this.deliverV2(job)
      await job.writing
      if (job.deliveryFailed || job.deliveredSequence < job.attempts.snapshot().events.length) {
        job.v2Status = 'unknown'; job.status = 'unknown'; job.operation = { ...operation, status: 'unknown' }
        throw rejected('resume_intent_unconfirmed', 'Client 未确认续作意图登记。', 'register_resume')
      }
      job.v2Status = 'resuming'
    } else if (clientResolution.kind === 'defer') {
      job.attempts.control(job.callId!, 'waiting_user', entry.resolutionId, exchangeId)
      this.deliverV2(job)
      await job.writing
      if (job.deliveryFailed) throw rejected('defer_unconfirmed', 'Client 未确认等待用户状态。', 'register_resume')
      job.v2Status = 'waiting_user'
    }
    entry.registered = true
    return { candidateCallId: prepared.candidateCallId, contextVersion: prepared.contextVersion, lastSequence: job.attempts.snapshot().events.length }
  }
  async dispatchResume(prepared: PreparedExecutorResume): Promise<{ readonly status: 'resuming' }> {
    const entry = this.resumeTokens.get(prepared.token as string)
    if (!entry || entry.token !== prepared || !entry.registered || !entry.packet || !entry.metadata || entry.job.controller.signal.aborted) throw rejected('resume_dispatch_unavailable', '续作尚未确认登记或操作已取消。', 'dispatch')
    if (entry.dispatched) return { status: 'resuming' }
    const { job } = entry
    if (job.v2Status !== 'resuming' || !this.activeSessions.has(job.sessionId)) throw rejected('resume_operation_changed', '翻译会话不再处于该续作状态。', 'dispatch')
    entry.dispatched = true
    job.packet = entry.packet; job.metadata = entry.metadata; job.exchangeId = entry.exchangeId; delete job.requestContext
    job.v2Status = 'resuming'; job.status = 'running'; job.error = null
    queueMicrotask(() => { void this.run(job) })
    return { status: 'resuming' }
  }
  async queryOperation(ref: ExecutorOperationRef): Promise<unknown> {
    const job = this.jobs.get(identity(ref.mainSessionId, ref.operationId)), operation = job?.operation
    if (!job || !operation || ref.hostGeneration !== job.exchange?.hostGeneration || job.callId !== ref.callId ||
      ref.contextVersion !== job.attempts.snapshot().attempts.at(-1)?.contextVersion || operation.topicId !== ref.topicId ||
      operation.translationSessionId !== ref.translationSessionId || operation.unitId !== ref.unitId || operation.sourceVersion !== ref.sourceVersion) return null
    return this.viewV2(job, 0)
  }
  async cancelOperation(ref: ExecutorOperationRef): Promise<unknown> {
    const job = this.jobs.get(identity(ref.mainSessionId, ref.operationId)), operation = job?.operation
    const attempt = job?.attempts.snapshot().attempts.at(-1)
    const preparedResume = job && [...this.resumesByResolution.values()].some(entry => entry.job === job && entry.registered &&
      entry.token.candidateCallId === ref.callId && entry.token.contextVersion === ref.contextVersion && entry.exchangeId === ref.exchangeId)
    if (!job || !operation || ref.hostGeneration !== job.exchange?.hostGeneration || (job.callId !== ref.callId && !preparedResume) ||
      (job.callId === ref.callId && ref.contextVersion !== attempt?.contextVersion) || operation.topicId !== ref.topicId ||
      operation.translationSessionId !== ref.translationSessionId || operation.unitId !== ref.unitId || operation.sourceVersion !== ref.sourceVersion ||
      !['preparing', 'accepted', 'running', 'waiting_context', 'waiting_user', 'resuming', 'unknown'].includes(job.v2Status)) return false
    job.controller.abort()
    if (job.exchange && job.exchangeId && attempt && attempt.endSequence !== null && ['waiting_context', 'waiting_user', 'resuming', 'unknown'].includes(job.v2Status)) {
      job.attempts.control(attempt.callId, 'cancelled', null, job.exchangeId)
      job.v2Status = 'cancelled'; job.status = 'cancelled'; job.operation = { ...operation, status: 'cancelled' }
      job.error = { code: 'CANCELLED', message: '等待补充的普通翻译已取消。', stage: 'cancel' }
      this.deliverV2(job); await job.writing
      const current = { mainSessionId: operation.mainSessionId, topicId: operation.topicId, translationSessionId: operation.translationSessionId,
        unitId: operation.unitId, sourceVersion: operation.sourceVersion, operationId: operation.operationId, callId: attempt.callId,
        contextVersion: attempt.contextVersion, hostGeneration: job.exchange.hostGeneration,
        lastSequence: job.attempts.snapshot().events.length, exchangeId: job.exchangeId }
      if (job.deliveryFailed || job.deliveredSequence < job.attempts.snapshot().events.length) {
        job.v2Status = 'unknown'; job.status = 'unknown'; job.operation = { ...operation, status: 'unknown' }
        await job.exchange.finishOperation(job.exchangeOwner as unknown as Parameters<TranslationExchangeService['finishOperation']>[0], current, 'unknown')
        return false
      }
      const finished = await job.exchange.finishOperation(job.exchangeOwner as unknown as Parameters<TranslationExchangeService['finishOperation']>[0], current, 'cancelled')
      if (!finished.ok) { job.v2Status = 'unknown'; job.status = 'unknown'; job.operation = { ...operation, status: 'unknown' }; return false }
      this.activeSessions.delete(job.sessionId)
    }
    return true
  }
  authorizePeer(mainSessionId: string, peerId: string): boolean { return this.topics.ownsConnection(mainSessionId, peerId) }
  private owned(target: { readonly mainSessionId: string }, exec: ToolExecution): void {
    if (this.disposed || !this.topics?.ownsAgent(target.mainSessionId, exec.agent)) throw rejected('scope_mismatch', '普通翻译操作不属于已连接的主 Agent。', 'authorize')
    const unit = target as NormalTranslationTarget
    if (unit.kind === 'unit' && (this.ctx.get?.('translationHistory') as { unitBlocked(sessionId: string, unitId: string): boolean } | undefined)?.unitBlocked(unit.translationSessionId, unit.unitId)) throw rejected('unit_deleted', '此单元已删除或正在删除。', 'authorize')
    exec.signal.throwIfAborted()
  }
  /** Resolve one historical unit's authoritative snapshot through the Client exactly once per operation. */
  private unitEnvelope(target: NormalTranslationExecute['target'], operationId: string, signature: string, exec: ToolExecution): Promise<Envelope> {
    if (target.kind !== 'unit') throw rejected('unsupported_target', '历史单元须先读取权威快照。', 'resolve_unit')
    const key = identity(target.mainSessionId, operationId), previous = this.resolved.get(key)
    if (previous && previous.signature !== signature) throw rejected('idempotency_conflict', '同一业务操作 ID 不能更换单元、版本或要求。', 'resolve_unit')
    if (!previous) {
      const result = this.topics.requestOwned(target.mainSessionId, { kind: 'normal_resolve', target, operationId }, exec).then(value => {
        if (value.kind !== 'normal_resolved' || value.envelope.mainSessionId !== target.mainSessionId ||
          value.envelope.material.translationSessionId !== target.translationSessionId || value.envelope.material.sourceVersion !== target.sourceVersion ||
          value.envelope.material.unitReference?.unitId !== target.unitId || value.envelope.material.unitReference.sourceVersion !== target.sourceVersion) throw rejected('invalid_reply', '历史单元的权威源快照身份不符。', 'resolve_unit')
        return value.envelope
      })
      this.resolved.set(key, { signature, result })
    }
    return this.resolved.get(key)!.result
  }
  private source(request: NormalTranslationExecute, exec: ToolExecution): Envelope {
    if (request.target.kind !== 'material') throw rejected('unsupported_target', '历史单元须先读取权威快照。', 'resolve_unit')
    const result = this.materials?.deliveredForAgent(request.target, exec.agent!)
    if (!result) throw rejected('execution_unavailable', '材料服务尚未就绪。', 'resolve_material')
    if (!result.ok) throw rejected(result.error.code, result.error.message, result.error.stage)
    requireInline(result.value)
    if (result.value.material.unitReference || result.value.material.revises) throw rejected('unsupported_target', '已有单元的重译和原文修改尚未接入。', 'resolve_material')
    return result.value
  }
  async capabilities(): Promise<NormalTranslationResult<NormalTranslationCapability>> {
    const ready = !this.disposed && !!this.topics && !!this.materials && await this.adapter.ready()
    return ok({ ready, storage: 'runtime_only', mode: 'normal', ...(ready ? {} : { reason: '普通翻译模型运行服务尚未就绪。' }) })
  }
  execute(input: unknown, exec: ToolExecution): Promise<NormalTranslationOperation> {
    const request = parseNormalTranslationExecute(input)
    this.owned(request.target, exec)
    const key = identity(request.target.mainSessionId, request.operationId), previous = this.jobs.get(key)
    if (this.corrections.has(key)) throw rejected('idempotency_conflict', '原文纠错与翻译须使用独立的操作 ID。', 'prepare')
    if (previous) {
      if (JSON.stringify(previous.request) !== JSON.stringify(request)) throw rejected('idempotency_conflict', '同一业务操作 ID 不能更换材料、版本或要求。', 'prepare')
      return previous.acceptance.then(() => structuredClone(previous.operation!))
    }
    if (request.target.kind === 'unit') {
      return this.unitEnvelope(request.target, request.operationId, JSON.stringify(request), exec).then(envelope => this.executeEnvelope(request, exec, envelope))
    }
    return this.executeEnvelope(request, exec, this.source(request, exec))
  }
  private executeEnvelope(request: NormalTranslationExecute, exec: ToolExecution, envelope: Envelope): Promise<NormalTranslationOperation> {
    this.owned(request.target, exec)
    requireInline(envelope)
    const key = identity(request.target.mainSessionId, request.operationId), previous = this.jobs.get(key)
    if (previous) return previous.acceptance.then(() => structuredClone(previous.operation!))
    const sessionId = envelope.material.translationSessionId
    if (!envelope.material.model) throw rejected('model_required', '此提交材料未选择翻译模型，请选择后重新提交；草稿保留。', 'prepare')
    if (this.activeSessions.has(sessionId)) throw rejected('busy', '此普通翻译会话仍有未结算操作。', 'prepare')
    this.activeSessions.add(sessionId)
    const job: Job = { namespaceId: this.topics.namespaceForAgent(request.target.mainSessionId), request, envelope, agent: exec.agent!, sessionId, controller: new AbortController(), delivery: new AbortController(),
      internalId: `normal-operation:${crypto.randomUUID()}`, updates: [], acceptance: undefined!, operation: null, packet: undefined,
      callId: null, metadata: null, status: 'preparing', error: null, deliveryFailed: false, acceptRequested: false, writing: Promise.resolve(),
      deliveredSequence: 0, attempts: new NormalTranslationAttemptJournal(), v2Status: 'accepted', exchangeId: null }
    const abort = () => job.controller.abort()
    exec.signal.addEventListener('abort', abort, { once: true })
    this.jobs.set(key, job)
    job.acceptance = Promise.resolve().then(() => this.prepare(job, exec.callId)).finally(() => exec.signal.removeEventListener('abort', abort))
    return job.acceptance.then(() => structuredClone(job.operation!))
  }
  private validateTerms(termReferences: readonly NormalTranslationTermReference[], envelope: Envelope, snapshot: TopicTermSnapshot): void {
    if (snapshot.topicId !== envelope.material.topicId ||
      snapshot.entries.length !== termReferences.length || termReferences.some(ref => !snapshot.entries.some(entry =>
        entry.id === ref.id && entry.version === ref.entryVersion && entry.status === 'active' && languageMatches(entry.targetLanguage, envelope.material.targetLanguage)))) throw rejected('invalid_reply', '普通翻译术语回执与指定范围或版本不一致。', 'prepare')
  }
  private async prepare(job: Job, mainCallId: string): Promise<NormalTranslationOperation> {
    const { request, envelope } = job, exec: ToolExecution = { agent: job.agent, callId: mainCallId, signal: job.controller.signal }
    try {
      if (!await this.adapter.ready()) throw rejected('execution_unavailable', '普通翻译模型运行服务尚未就绪；材料保留。', 'prepare')
      const terms = await this.topics.requestOwned(request.target.mainSessionId, { kind: 'normal_prepare', envelope,
        operationId: request.operationId, organizedRequirements: request.organizedRequirements, termReferences: request.termReferences, ...(request.referenceContextRef ? {referenceContextRef: request.referenceContextRef} : {}) }, exec)
      if (terms.kind !== 'normal_prepared') throw rejected('invalid_reply', '未取得普通翻译准备回执。', 'prepare')
      this.validateTerms(request.termReferences, envelope, terms.termSnapshot)
      const savedRequirements = await this.savedRequirements(envelope.mainSessionId, envelope.material.topicId)
      const route = envelope.material.model!, model = { providerId: route.provider, modelId: route.model, configVersion: 0,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) }
      await this.adapter.prepareOperation(job.internalId, model, job.controller.signal)
      const referenceContext = request.referenceContextRef ? await (this.ctx.get?.('translationReferences') as ReferenceFilesService).resolveContext(envelope.mainSessionId, envelope.material.topicId, request.referenceContextRef, exec) : undefined
      const context: NormalTranslationContext = { ...savedRequirements, organizedRequirements: request.organizedRequirements, ...(request.referenceContextRef ? {referenceContextRef: request.referenceContextRef} : {}), terms: terms.termSnapshot.entries.map(entry => ({
        id: entry.id, entryVersion: entry.version, sourceForms: entry.sourceForms, aliases: entry.aliases, sense: entry.sense,
        preferred: entry.preferred, forbidden: entry.forbidden, userFixed: entry.origin === 'user_explicit',
      })) }
      job.packet = { operationId: job.internalId, callId: `normal-call:${crypto.randomUUID()}`, model, sourceText: envelope.material.sourceText,
        targetLanguage: envelope.material.targetLanguage, instruction: envelope.material.instruction, context, ...(referenceContext ? {referenceContext,referenceContextCurrent:()=> (this.ctx.get?.('translationReferences') as ReferenceFilesService).contextCurrent(referenceContext)} : {}) }
      const exchangeOwner = this.ctx
      const exchange = this.attachExchange(exchangeOwner)
      if (exchange) { job.exchange = exchange; job.exchangeOwner = exchangeOwner }
      else { delete job.exchange; delete job.exchangeOwner }
      const exchangeCapabilities = await exchange?.capabilities()
      const requestContextAvailable = (this.topics.protocolFor(request.target.mainSessionId) ?? 0) >= 2 && exchangeCapabilities?.ok === true &&
        exchangeCapabilities.value.capabilities.exchange.state === 'available' && exchangeCapabilities.value.capabilities.modelControl.state === 'available'
      job.metadata = this.adapter.preflightNormal(job.packet, requestContextAvailable)
      job.controller.signal.throwIfAborted()
      job.acceptRequested = true
      const accepted = await this.admit(request, exec, true, envelope)
      job.operation = accepted.operation; job.status = accepted.operation.status
      if (JSON.stringify(accepted.termSnapshot.entries) !== JSON.stringify(terms.termSnapshot.entries)) throw rejected('invalid_reply', '业务受理时术语包与已准备版本不一致。', 'accept')
      queueMicrotask(() => { void this.run(job) })
      return structuredClone(job.operation)
    } catch (error) {
      const unknown = job.acceptRequested && ['outcome_unknown', 'invalid_reply'].includes((error as { code?: string }).code ?? '')
      const memoryError = (error as { code?: string }).code?.startsWith('memory_') ? (error as Error).message : undefined
      job.status = unknown ? 'unknown' : job.controller.signal.aborted ? 'cancelled' : 'failed'
      job.error = this.adapter.diagnostic(job.internalId) ?? { code: unknown ? 'OUTCOME_UNKNOWN' : (error as { code?: string }).code ?? 'PREPARE_FAILED',
        message: unknown ? '业务受理回执尚未确认；保留此操作并查询，未派发翻译模型。' : memoryError ?? (job.status === 'cancelled' ? '普通翻译已在模型调用前取消。' : request.target.kind === 'unit' ? '重译准备未完成，原文及已完成的纠错保留。' : '普通翻译准备未完成，材料保留。'), stage: (error as { stage?: string }).stage ?? 'prepare' }
      this.adapter.discard(job.packet?.operationId ?? job.internalId)
      if (job.operation && unknown) this.emit(job, 'unknown', '', null, job.error)
      if (!unknown) this.activeSessions.delete(job.sessionId)
      throw rejected(job.error.code, job.error.message, job.error.stage)
    }
  }
  /** Host foundation used only after the executor has prepared the full call. */
  acceptPrepared(input: NormalTranslationExecute, exec: ToolExecution): Promise<Accepted> { return this.admit(input, exec, false) }
  private admit(input: NormalTranslationExecute, exec: ToolExecution, reserved: boolean, resolved?: Envelope): Promise<Accepted> {
    const request = parseNormalTranslationExecute(input)
    this.owned(request.target, exec)
    const key = identity(request.target.mainSessionId, request.operationId), signature = JSON.stringify(request), previous = this.admissions.get(key)
    if (previous) {
      if (previous.signature !== signature) throw rejected('idempotency_conflict', '同一业务操作 ID 不能更换材料、版本或要求。', 'accept')
      return previous.result.then(result => structuredClone(result))
    }
    const envelope = resolved ?? this.source(request, exec)
    if ((this.ctx.get?.('translationHistory') as { unitBlocked(sessionId: string, unitId: string): boolean } | undefined)?.unitBlocked(envelope.material.translationSessionId, envelope.material.unitReference?.unitId ?? `unit:${envelope.material.materialId}`)) throw rejected('unit_deleted', '此单元已删除或正在删除。', 'accept')
    requireInline(envelope)
    const sessionId = envelope.material.translationSessionId
    if (!reserved && this.activeSessions.has(sessionId)) throw rejected('busy', '此普通翻译会话仍有未结算操作。', 'accept')
    this.activeSessions.add(sessionId)
    const result = Promise.resolve().then(async (): Promise<Accepted> => {
      const value = await this.topics.requestOwned(request.target.mainSessionId, { kind: 'normal_accept', envelope,
        operationId: request.operationId, organizedRequirements: request.organizedRequirements, termReferences: request.termReferences, ...(request.referenceContextRef ? {referenceContextRef: request.referenceContextRef} : {}) }, exec)
      if (value.kind !== 'normal_operation' || value.operation.operationId !== request.operationId || value.operation.mainSessionId !== request.target.mainSessionId ||
        value.operation.materialId !== envelope.material.materialId || value.operation.sourceVersion !== request.target.sourceVersion ||
        (request.target.kind === 'unit' && value.operation.unitId !== request.target.unitId) ||
        value.operation.translationSessionId !== envelope.material.translationSessionId || value.operation.topicId !== envelope.material.topicId ||
        value.operation.draftVersion !== envelope.material.draftVersion) throw rejected('invalid_reply', '普通翻译业务回执身份不一致。', 'accept')
      this.validateTerms(request.termReferences, envelope, value.termSnapshot)
      return structuredClone(value)
    }).catch(error => {
      if (!['outcome_unknown', 'invalid_reply'].includes((error as { code?: string }).code ?? '')) this.activeSessions.delete(sessionId)
      throw error
    })
    this.admissions.set(key, { signature, sessionId, result })
    return result.then(value => structuredClone(value))
  }
  /** Query-issued handles are short model-facing references; resolve them to an exact id/version before any business request. */
  private resolveTermHandles(request: RawDirectTranslationRequest): DirectTranslationRequest {
    if (request.termReferences.every(ref => !('termRef' in ref))) return request as DirectTranslationRequest
    const handles = this.ctx.get?.('translationTermHandles') as TermHandleRegistry | undefined
    const resolved = request.termReferences.map(ref => {
      if (!('termRef' in ref)) return ref
      const target = handles?.resolve(request.target.mainSessionId, ref.termRef)
      if (!target) throw rejected('term_ref_invalid', '术语引用句柄无效或已过期，请重新查询术语并使用返回的 ref 或 termRef。', 'resolve_terms')
      return { id: target.id, entryVersion: target.entryVersion }
    })
    const ids = new Set<string>()
    for (const ref of resolved) {
      if (ids.has(ref.id)) throw rejected('invalid_input', '术语引用重复，请只保留一条。', 'resolve_terms')
      ids.add(ref.id)
    }
    return { ...request, termReferences: resolved }
  }
  /**
   * One real translation call whose result is awaited. The main model receives the body (or a
   * readable reference) and records it in one Client transaction; no exchange, request_context or
   * asynchronous acceptance handoff is involved.
   */
  translate(input: unknown, exec: ToolExecution): Promise<DirectTranslationView> {
    const request = this.resolveTermHandles(parseDirectTranslationRequest(input))
    this.owned(request.target, exec)
    // A correction usually arrives as a later user turn with no notice; keep the direct toolset for that turn.
    if (exec.agent) this.topics.retainToolsForNextTurn(exec.agent, ['direct'])
    const key = identity(request.target.mainSessionId, request.operationId), signature = JSON.stringify(request)
    const previous = this.direct.get(key)
    if (previous) {
      if (previous.signature !== signature) throw rejected('idempotency_conflict', '同一业务操作 ID 不能更换材料、要求或术语；该 ID 已用于另一次请求，请修正参数后改用新的 operationId 重试。', 'prepare')
      return previous.promise.then(view => structuredClone(view))
    }
    if (this.corrections.has(key)) throw rejected('idempotency_conflict', '原文纠错与翻译须使用独立的操作 ID。', 'prepare')
    const attempt: DispatchAttempt = { dispatched: false, resolved: false }
    const promise = this.runDirect(request, exec, attempt)
    const entry = { signature, promise, settled: false }; this.direct.set(key, entry)
    void promise.then(() => { entry.settled = true }, () => { entry.settled = true })
    return promise.then(view => structuredClone(view), error => {
      // Nothing was dispatched and no business fact exists, so the placeholder only blocks the corrected retry.
      // A dispatched, unknown or recorded attempt keeps its reservation so the same ID replays its real outcome.
      if (!attempt.dispatched && this.direct.get(key)?.promise === promise) {
        this.direct.delete(key)
        if (attempt.resolved) this.resolved.delete(key)
      }
      throw error
    })
  }
  private async runDirect(request: DirectTranslationRequest, exec: ToolExecution, attempt: DispatchAttempt): Promise<DirectTranslationView> {
    const startedAt = Date.now()
    let prepareDone = startedAt, firstTextAt = 0
    let envelope: Envelope, sourceText: string, range: DirectTranslationRange | undefined, bodyMode = false
    if (request.target.kind === 'unit') {
      attempt.resolved = true
      envelope = await this.unitEnvelope(request.target, request.operationId, JSON.stringify(request), exec)
      requireInline(envelope)
      if (request.range || request.body !== undefined) throw rejected('unsupported_input', '历史单元重译不接受范围或替换正文。', 'prepare')
      sourceText = envelope.material.sourceText!
    } else {
      const delivered = this.materials?.deliveredForAgent(request.target, exec.agent!, { historical: true })
      if (!delivered) throw rejected('execution_unavailable', '材料服务尚未就绪。', 'resolve_material')
      if (!delivered.ok) throw rejected(delivered.error.code, delivered.error.message, delivered.error.stage)
      if (delivered.value.material.unitReference || delivered.value.material.revises) throw rejected('unsupported_target', '已有单元的重译和原文修改尚未接入。', 'resolve_material')
      envelope = delivered.value
      if (envelope.material.sourceText !== undefined) {
        if (request.range || request.body !== undefined) throw rejected('unsupported_input', '内联短文不接受原文范围或替换正文。', 'prepare')
        sourceText = envelope.material.sourceText
      } else if (request.body !== undefined) {
        // A non-text original: the main model supplies the body it actually extracted and organized.
        sourceText = request.body; bodyMode = true
      } else {
        const read = this.materials!.materialText(request.target, request.range, exec.agent!)
        if (!read.ok) throw rejected(read.error.code, read.error.message, read.error.stage)
        envelope = read.value.envelope
        sourceText = read.value.text
        // A file result always records its exact source interval, including a whole-file call.
        range = read.value.range
      }
    }
    const material = envelope.material, route = material.model
    if (!route) throw rejected('model_required', '此提交材料未选择翻译模型，请选择后重新提交；草稿保留。', 'prepare')
    const length = sourceCodePointLength(sourceText), limit = material.maxInputChars
    if (length > limit) throw rejected('source_too_large', `本次正文 ${length} 码点，超过此会话单次上限 ${limit}；请用范围分段翻译或缩小正文。`, 'prepare')
    const sessionId = material.translationSessionId
    if (this.activeSessions.has(sessionId)) throw rejected('busy', '此普通翻译会话仍有未结算操作。', 'prepare')
    if (!await this.adapter.ready()) throw rejected('execution_unavailable', '普通翻译模型运行服务尚未就绪；材料保留。', 'prepare')
    exec.signal.throwIfAborted()
    const terms = await this.topics.requestOwned(request.target.mainSessionId, { kind: 'normal_prepare', envelope,
      operationId: request.operationId, organizedRequirements: request.organizedNotes, termReferences: request.termReferences,
      ...(request.referenceContextRef ? { referenceContextRef: request.referenceContextRef } : {}) }, exec)
    if (terms.kind !== 'normal_prepared') throw rejected('invalid_reply', '未取得普通翻译准备回执。', 'prepare')
    this.validateTerms(request.termReferences, envelope, terms.termSnapshot)
    const savedRequirements = await this.savedRequirements(envelope.mainSessionId, material.topicId)
    const model: ModelSelection = { providerId: route.provider, modelId: route.model, configVersion: 0,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) }
    const internalId = `normal-direct:${crypto.randomUUID()}`, callId = `normal-direct-call:${crypto.randomUUID()}`
    this.activeSessions.add(sessionId)
    try {
      // Crossing this line may start real provider work; failures after it keep the operation reservation.
      attempt.dispatched = true
      await this.adapter.prepareOperation(internalId, model, exec.signal)
      prepareDone = Date.now()
      const referenceService = this.ctx.get?.('translationReferences') as ReferenceFilesService | undefined
      let contextRef = request.referenceContextRef, referenceStatus = contextRef ? 'explicit' : 'no_match'
      const contextLog = diagnosticSpan(this.ctx, 'translation.context', {}, request.operationId)
      if (!contextRef && referenceService?.prepareExactExample) {
        try {
          const prepared = await referenceService.prepareExactExample(material.topicId, sourceText, request.operationId, exec)
          contextRef = prepared.ref; referenceStatus = prepared.status === 'skipped' && length > 300 ? 'long_source_needs_selection' : prepared.status
        } catch (error) {
          exec.signal.throwIfAborted(); referenceStatus = 'unavailable'
          contextLog('degraded', { referenceStatus }, error)
        }
      }
      const referenceContext = contextRef ? await referenceService!.resolveContext(envelope.mainSessionId, material.topicId, contextRef, exec) : undefined
      const context: NormalTranslationContext = { ...savedRequirements, organizedRequirements: request.organizedNotes,
        ...(terms.historyContext ? { historyContext: historyContextRefs(terms.historyContext) } : {}),
        ...(request.userRequirements ? { userRequirements: request.userRequirements } : {}),
        ...(request.auxiliaryContext ? { auxiliaryContext: request.auxiliaryContext } : {}),
        terms: [...terms.termSnapshot.entries.map(entry => {
          const priority = assetPriority(entry)
          return { id: entry.id, entryVersion: entry.version, sourceForms: entry.sourceForms, aliases: entry.aliases, sense: entry.sense,
            preferred: entry.preferred, forbidden: entry.forbidden, userFixed: priority === 2, priority }
        }), ...draftTranslationTerms(request.draftTerms)],
        ...(contextRef ? { referenceContextRef: contextRef } : {}) }
      const packet: NormalExecutionPacket = { operationId: internalId, callId, model, sourceText,
        targetLanguage: material.targetLanguage, instruction: material.instruction, context, mode: 'direct',
        ...(terms.historyContext ? { historyContext: terms.historyContext } : {}),
        ...(referenceContext ? { referenceContext, referenceContextCurrent: () => (this.ctx.get?.('translationReferences') as ReferenceFilesService).contextCurrent(referenceContext) } : {}) }
      const entry = this.direct.get(identity(request.target.mainSessionId, request.operationId))
      if (entry) {
        entry.callId = callId
        if (context.historyContext) entry.historyContext = { translationSessionId: sessionId, topicId: material.topicId, refs: context.historyContext }
      }
      const contextUsage = { terms: context.terms.length, nearbyUnits: terms.historyContext?.nearby.length ?? 0,
        revisionBaseId: terms.historyContext?.base?.revisionId ?? null, referenceStatus, referenceFiles: referenceContext?.files?.length ?? 0 }
      contextLog('completed', contextUsage)
      let metadata = this.adapter.preflightNormal(packet, false), text = '', points = 0
      let terminal: { readonly reason: string; readonly completeness: string; readonly checks_passed: boolean; readonly provider_state: string } | undefined
      for await (const event of this.adapter.executeNormal(packet, exec.signal)) {
        if (event.type === 'text') {
          if (!firstTextAt) firstTextAt = Date.now()
          text += event.text; points += sourceCodePointLength(event.text)
          if (points > 2_000_000) throw rejected('output_limit', '译文超过单次记录上限，未截断。', 'stream')
        } else if (event.type === 'usage') {
          metadata = { ...metadata, usage: { inputTokens: event.input_tokens ?? null, outputTokens: event.output_tokens ?? null } }
        } else if (event.type === 'needs_context') {
          throw rejected('unexpected_context_request', '直接翻译不接受补充问题；请把必要语境作为辅助上下文重试。', 'stream')
        } else terminal = event
      }
      if (!terminal) throw rejected('INVALID_STREAM', '模型未提供结束状态。', 'protocol')
      const streamDone = Date.now()
      const complete = terminal.reason === 'stop' && terminal.provider_state === 'finished' && terminal.completeness === 'complete' &&
        terminal.checks_passed && text.trim().length > 0
      const status: DirectTranslationView['status'] = terminal.provider_state === 'unknown' ? 'unknown' : terminal.reason === 'aborted' ? 'cancelled'
        : complete ? 'completed' : 'failed'
      // Keep source file transport formatting in the recorded result, not just in an exported copy.
      if (status === 'completed') {
        if (sourceText.startsWith('\uFEFF') && !text.startsWith('\uFEFF')) text = '\uFEFF' + text
        if (sourceText.includes('\r\n') && !/(?<!\r)\n/u.test(sourceText)) text = text.replace(/\r?\n/gu, '\r\n')
        points = sourceCodePointLength(text)
      }
      const reason = status === 'completed' ? undefined : status === 'cancelled' ? '翻译已取消，已生成的部分保留。'
        : status === 'unknown' ? '模型调用结束状态尚未确认，结果尚未记录。' : this.adapter.diagnostic(internalId)?.message ?? '译文未完整完成，已生成的部分保留。'
      this.directResults.set(identity(request.target.mainSessionId, request.operationId), { ownerId: request.target.mainSessionId, text, status })
      let receipt: DirectTranslationReceipt | undefined, recordError: string | undefined
      if (status !== 'unknown') {
        try { receipt = await this.commitDirect(request, envelope, callId, status, text, reason ?? '', metadata, exec, sourceText, range, bodyMode) }
        catch (error) { recordError = `译文已生成，但结果记录未确认：${error instanceof Error ? error.message : '请重新读取当前单元。'}` }
      }
      const recordDone = Date.now()
      return { ...this.directView(request, envelope, callId, status, text, points, metadata, receipt,
        [reason, recordError].filter(item => item !== undefined).join(' ') || undefined,
        { prepareMs: prepareDone - startedAt, firstTextMs: firstTextAt ? firstTextAt - startedAt : null,
          streamMs: streamDone - prepareDone, recordMs: recordDone - streamDone, totalMs: recordDone - startedAt },
        envelope.material.sourceText === undefined
          ? bodyMode ? `unit:${material.materialId}:body`
            : range!.start === 0 && range!.end === material.sourceRef?.totalCodePoints ? `unit:${material.materialId}`
            : `unit:${material.materialId}:${range!.start}-${range!.end}`
          : `unit:${material.materialId}`,
        status === 'completed' ? sourceAnnotationChecks(text, context.terms, sourceText) : []), contextUsage }
    } catch (error) {
      const code = (error as { code?: unknown }).code
      if (typeof code === 'string' && code !== 'ABORT_ERR') throw error
      const failure = this.adapter.diagnostic(internalId)
      if (failure) throw rejected(failure.code, failure.message, failure.stage)
      throw rejected(exec.signal.aborted ? 'CANCELLED' : 'EXECUTION_FAILED',
        exec.signal.aborted ? '翻译已取消，未记录不完整结果。' : '翻译调用未完成，请检查模型配置后重试。', exec.signal.aborted ? 'cancel' : 'stream')
    } finally { this.adapter.discard(internalId); this.activeSessions.delete(sessionId) }
  }
  private directView(request: DirectTranslationRequest, envelope: Envelope, callId: string, status: DirectTranslationView['status'],
    text: string, totalCodePoints: number, metadata: TranslationCallMetadata, receipt: DirectTranslationReceipt | undefined, message: string | undefined,
    timing: DirectTranslationView['timing'], fallbackUnitId: string, checks: readonly TranslationCheck[] = []): DirectTranslationView {
    const material = envelope.material
    const base = { operationId: request.operationId, mainSessionId: request.target.mainSessionId, translationSessionId: material.translationSessionId,
      topicId: material.topicId, unitId: receipt?.unitId ?? material.unitReference?.unitId ?? fallbackUnitId,
      revisionId: receipt?.revisionId ?? callId, sourceVersion: material.sourceVersion, status, recorded: receipt !== undefined,
      totalCodePoints, metadata: translationCallFacts(metadata), timing, ...(checks.length ? { checks } : {}),
      ...(message ? { message } : {}), persistence: receipt?.persistence ?? 'unconfirmed' as const }
    const assetReview = material.sourceText === undefined && status === 'completed' && receipt ? { assetReview: {
      tool: 'translation_submit_proposals' as const, target: { kind: 'unit' as const, mainSessionId: request.target.mainSessionId,
        translationSessionId: material.translationSessionId, unitId: receipt.unitId, sourceVersion: receipt.sourceVersion }, revisionId: receipt.revisionId,
      nextStep: 'Review this result, then submit reusable entity/term/fact/relation proposals consistent with it using exact unique source quotes. draftTerms were only translation input, not saved proposals. Submit [] if no new assets. The translation Session already owns this recorded file result; point the user to its file entry. Do not create a separate delivery copy unless the user explicitly asks for an export.' } } : {}
    const handoff = receipt ? { target: { kind: 'unit' as const, mainSessionId: request.target.mainSessionId,
      translationSessionId: receipt.translationSessionId, unitId: receipt.unitId, sourceVersion: receipt.sourceVersion },
      nextStep: TRANSLATION_SELF_REVIEW + ' ' + DIRECT_REVISION_GUIDANCE } : {}
    const withText = { ...base, ...assetReview, ...handoff, text, truncated: false }
    if (new TextEncoder().encode(JSON.stringify(withText)).byteLength <= 60_000) return withText
    return { ...base, ...assetReview, ...handoff, textPreview: Array.from(text).slice(0, 4000).join(''), truncated: true,
      resultRef: { operationId: request.operationId, totalCodePoints, tool: 'translation_read_result' as const } }
  }
  private async commitDirect(request: DirectTranslationRequest, envelope: Envelope, callId: string, status: DirectTranslationCommit['status'],
    text: string, message: string, metadata: TranslationCallMetadata, exec: ToolExecution, sourceText: string,
    range: DirectTranslationRange | undefined, bodyMode: boolean): Promise<DirectTranslationReceipt> {
    const commit: DirectTranslationCommit = { envelope, operationId: request.operationId, userRequirements: request.userRequirements,
      organizedNotes: request.organizedNotes, auxiliaryContext: request.auxiliaryContext, termReferences: request.termReferences,
      revisionId: callId, status, text, message, callRecord: metadata,
      ...(envelope.material.sourceText === undefined ? { sourceText } : {}), ...(range ? { range } : {}), ...(bodyMode ? { body: true } : {}),
      ...(request.draftTerms?.length ? { draftTerms: request.draftTerms } : {}),
      ...(metadata.context?.referenceContextRef ? { referenceContextRef: metadata.context.referenceContextRef } : {}) }
    const value = await this.topics.requestOwned(request.target.mainSessionId, { kind: 'normal_commit', ...commit }, exec)
    if (value.kind !== 'normal_committed') throw rejected('invalid_reply', '译文提交回执类型不一致。', 'record_result')
    const receipt = value.receipt
    if (receipt.operationId !== request.operationId || receipt.mainSessionId !== request.target.mainSessionId ||
      receipt.translationSessionId !== envelope.material.translationSessionId || receipt.revisionId !== callId ||
      receipt.sourceVersion !== envelope.material.sourceVersion) throw rejected('invalid_reply', '译文提交回执身份不一致。', 'record_result')
    return receipt
  }
  /** Read a bounded page of one direct result; only exact runtime results and the actual main Agent. */
  readResult(input: unknown, exec: ToolExecution): { readonly operationId: string; readonly range: { readonly start: number; readonly end: number }; readonly totalCodePoints: number; readonly text: string } {
    const request = parseNormalTranslationResultRead(input), agent = exec.agent
    if (this.disposed || !agent || !this.topics?.ownsAgent(agent.id, agent)) throw rejected('scope_mismatch', '译文读取工具不属于已连接的主 Agent。', 'authorize')
    exec.signal.throwIfAborted()
    const entry = this.directResults.get(identity(agent.id, request.operationId))
    if (!entry) throw rejected('not_found', '本次运行期没有该译文结果；请重新翻译或读取当前单元。', 'read_result')
    const totalCodePoints = sourceCodePointLength(entry.text)
    if (request.range.end > totalCodePoints) throw rejected('range_out_of_bounds', '译文范围超出实际结果长度，未截断。', 'read_result')
    if (request.range.end - request.range.start > MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) throw rejected('page_too_large', '译文分页每次最多读取 4000 个 Unicode 码点，未截断。', 'read_result')
    const text = Array.from(entry.text).slice(request.range.start, request.range.end).join('')
    if (new TextEncoder().encode(JSON.stringify({ operationId: request.operationId, range: request.range, totalCodePoints, text })).byteLength > MAX_TRANSLATION_SOURCE_PAGE_BYTES) {
      throw rejected('page_too_large', '译文分页完整回复超过 32768 UTF-8 字节，未截断。', 'read_result')
    }
    return { operationId: request.operationId, range: request.range, totalCodePoints, text }
  }
  /**
   * One native subagent extraction over an exact file interval. It returns candidates only and
   * never writes formal memory; the main model integrates them and passes draft terms to a call.
   */
  extractAssets(input: unknown, exec: ToolExecution): Promise<TranslationExtractionView> {
    const request = this.resolveTermHandles(parseDirectTranslationRequest(input))
    if (request.target.kind !== 'material') throw rejected('unsupported_target', '资产提取只接受已交付文件材料。', 'extract_assets')
    const target = request.target
    if (this.disposed || !this.topics?.ownsAgent(target.mainSessionId, exec.agent)) throw rejected('scope_mismatch', '资产提取工具不属于此实际主 Agent。', 'authorize')
    exec.signal.throwIfAborted()
    if (exec.agent) this.topics.retainToolsForNextTurn(exec.agent, ['direct'])
    const key = identity(target.mainSessionId, request.operationId), signature = JSON.stringify(request), previous = this.extractions.get(key)
    if (previous && previous.signature !== signature) throw rejected('idempotency_conflict', '同一提取操作 ID 不能更换材料、范围或要求；该 ID 已用于另一次请求，请修正参数后改用新的 operationId 重试。', 'extract_assets')
    if (!previous) {
      const attempt: DispatchAttempt = { dispatched: false, resolved: false }
      const promise = this.runExtraction(request, target, exec, attempt)
      const entry = { signature, promise, settled: false }; this.extractions.set(key, entry)
      void promise.then(() => { entry.settled = true }, () => { entry.settled = true })
      // Same rule as the direct call: a rejection before the extraction worker starts leaves nothing to replay.
      void promise.catch(() => { if (!attempt.dispatched && this.extractions.get(key)?.promise === promise) this.extractions.delete(key) })
    }
    return this.extractions.get(key)!.promise
  }
  private async runExtraction(request: DirectTranslationRequest, target: NormalTranslationMaterialTarget,
    exec: ToolExecution, attempt: DispatchAttempt): Promise<TranslationExtractionView> {
    const delivered = this.materials?.deliveredForAgent(target, exec.agent!, { historical: true })
    if (!delivered) throw rejected('execution_unavailable', '材料服务尚未就绪。', 'resolve_material')
    if (!delivered.ok) throw rejected(delivered.error.code, delivered.error.message, delivered.error.stage)
    const material = delivered.value.material
    let text: string, totalCodePoints: number, base = 0
    if (request.body !== undefined) {
      // A binary original has no readable text; the main model's organized body is the material.
      text = request.body; totalCodePoints = material.sourceRef?.totalCodePoints ?? 0
    } else {
      const read = this.materials!.materialText(target, request.range, exec.agent!)
      if (!read.ok) throw rejected(read.error.code, read.error.message, read.error.stage)
      text = read.value.text; totalCodePoints = read.value.totalCodePoints; base = read.value.range.start
    }
    const length = sourceCodePointLength(text)
    if (length > material.maxInputChars) throw rejected('source_too_large', `本次提取正文 ${length} 码点，超过此会话单次上限 ${material.maxInputChars}；请按范围分段提取。`, 'prepare')
    const snapshot = await this.topics.requestOwned(target.mainSessionId, { kind: 'list_terms', translationSessionId: material.translationSessionId }, exec)
    if (snapshot.kind !== 'terms') throw rejected('invalid_reply', '未取得提取所需的术语快照。', 'prepare')
    const existingAssets = snapshot.snapshot.entries.filter(entry => entry.status === 'active' && languageMatches(entry.targetLanguage, material.targetLanguage))
      .map(entry => ({ sourceForms: entry.sourceForms, aliases: entry.aliases, preferred: entry.preferred, forbidden: entry.forbidden,
        sense: entry.sense, authority: assetPriority(entry) }))
    attempt.dispatched = true
    const output = await this.workers.prepare({ ownerId: target.mainSessionId, jobId: `extraction:${request.operationId}`,
      mainSessionId: target.mainSessionId, topicId: material.topicId, translationSessionId: material.translationSessionId,
      source: { materialId: material.materialId, version: material.sourceVersion, text },
      targetLanguage: material.targetLanguage, instruction: material.instruction, existingAssets }, exec.signal)
    const shift = (range: DirectTranslationRange): DirectTranslationRange => ({ start: range.start + base, end: range.end + base })
    const terms = output.terms.slice(0, 100), proposals = output.proposals.slice(0, 100), conflicts = output.conflicts.slice(0, 50)
    return { operationId: request.operationId, materialId: material.materialId, sourceVersion: material.sourceVersion,
      range: { start: base, end: base + length }, totalCodePoints,
      terms: terms.map(term => ({ ...term, ranges: term.ranges.map(shift) })),
      proposals: proposals.map(proposal => ({ ...proposal, evidence: proposal.evidence.map(item => ({ range: shift(item.range) })) })),
      conflicts: conflicts.map(conflict => ({ ...conflict, ranges: conflict.ranges.map(shift) })),
      warnings: output.warnings ?? [], worker: output.worker,
      truncated: terms.length < output.terms.length || proposals.length < output.proposals.length || conflicts.length < output.conflicts.length }
  }
  private artifactStorage(): Promise<ArtifactStorage> {
    if (!this.artifacts) this.artifacts = loadArtifactStorage(this.ctx).catch(error => { this.artifacts = undefined; throw error })
    return this.artifacts
  }
  private async exportResult(target: NormalTranslationMaterialTarget | NormalTranslationUnitTarget, exec: ToolExecution): Promise<NormalTranslationExport> {
    const value = await this.topics.requestOwned(target.mainSessionId, { kind: 'normal_export', target }, exec)
    if (value.kind !== 'normal_exported') throw rejected('invalid_reply', '译文导出回执类型不一致。', 'export_result')
    const exported = value.export
    if (exported.mainSessionId !== target.mainSessionId || exported.sourceVersion !== target.sourceVersion ||
      (target.kind === 'material' ? exported.materialId !== target.materialId : exported.segments.some(segment => segment.unitId !== target.unitId))) {
      throw rejected('invalid_reply', '译文导出回执身份不一致。', 'export_result')
    }
    return exported
  }
  private artifactChecks(format: TranslationArtifactSaved['format'], body: string): TranslationArtifactCheck[] {
    const checks: TranslationArtifactCheck[] = []
    if (format === 'json') {
      try { JSON.parse(body) } catch (error) { checks.push({ code: 'json_invalid', message: `保存的正文不是有效 JSON：${error instanceof Error ? error.message : '解析失败'}` }) }
    }
    if (format === 'md') {
      const fences = body.split('\n').filter(line => /^\s*```/u.test(line)).length
      if (fences % 2 !== 0) checks.push({ code: 'markdown_fence_unbalanced', message: 'Markdown 代码围栏数量为奇数，可能缺少结束围栏。' })
    }
    return checks
  }
  private artifactName(request: { readonly fileName?: string; readonly format: TranslationArtifactSaved['format'] },
    target: NormalTranslationMaterialTarget | NormalTranslationUnitTarget): string {
    const stem = request.fileName ?? (target.kind === 'material' ? target.materialId : target.unitId)
    const base = stem.replace(/\.[A-Za-z0-9]{1,8}$/u, '').replace(/[\\/<>:"|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '_').replace(/^[. ]+|[. ]+$/gu, '')
    return `${Array.from(base).slice(0, 80).join('') || 'translation'}${artifactExtension(request.format)}`
  }
  /** Write the current result, resolving Markdown images only in the exported copy; report success per save. */
  async saveArtifact(input: unknown, exec: ToolExecution): Promise<TranslationArtifactSaved> {
    const request = parseArtifactSave(input), target = request.target
    if (this.disposed || !this.topics?.ownsAgent(target.mainSessionId, exec.agent)) throw rejected('scope_mismatch', '产物保存工具不属于此实际主 Agent。', 'authorize')
    exec.signal.throwIfAborted()
    const exported = await this.exportResult(target, exec)
    if (!exported.complete) {
      const missing = exported.missing.map(range => `[${range.start},${range.end})`).join('、') || '未知范围'
      const overlapping = exported.overlapping.map(range => `[${range.start},${range.end})`).join('、')
      throw rejected('incomplete_result', `译文尚未覆盖完整原文，未保存产物。缺少：${missing}${overlapping ? `；重叠：${overlapping}` : ''}。`, 'export_result')
    }
    const recorded = exported.segments.map(segment => segment.text).join('')
    if (!recorded.trim()) throw rejected('empty_result', '当前译文为空，未保存产物。', 'export_result')
    const fileName = this.artifactName(request, target)
    let path: string, body: string
    try {
      const storage = await this.artifactStorage()
      body = request.format === 'md' ? await resolveMarkdownImages(recorded, exported.originalFilePath, async (name, bytes) => {
        const image = await storage.write(name, bytes)
        return `./${encodeURIComponent(image.slice(Math.max(image.lastIndexOf('/'), image.lastIndexOf('\\')) + 1))}`
      }) : recorded
      path = await storage.write(fileName, body)
    }
    catch { exec.signal.throwIfAborted(); throw rejected('storage_failed', '译件写入失败，未报告保存完成。', 'save_artifact') }
    const checks = this.artifactChecks(request.format, body)
    if (exec.agent) this.savedArtifacts.set(`${exec.agent.id}\u0000${path}`, path)
    return { path, fileName, format: request.format, bytes: new TextEncoder().encode(body).byteLength,
      codePoints: Array.from(body).length, revisionIds: exported.segments.map(segment => segment.revisionId),
      segments: exported.segments.length, checks }
  }
  /** Open one artifact saved in this runtime; an arbitrary path is never accepted. */
  async openArtifact(input: unknown, exec: ToolExecution): Promise<{ readonly opened: true; readonly path: string }> {
    const request = parseArtifactOpen(input), agent = exec.agent
    if (this.disposed || !agent || !this.topics?.ownsAgent(agent.id, agent)) throw rejected('scope_mismatch', '打开产物工具不属于此实际主 Agent。', 'authorize')
    const path = this.savedArtifacts.get(`${agent.id}\u0000${request.path}`)
    if (!path) throw rejected('not_found', '此路径不是本次运行保存的译件；请先保存再打开。', 'open_artifact')
    const controller = this.ctx.get?.('sessionController') as { canOpenWorkspacePath?(): boolean; openWorkspacePath(request: { path: string }, signal: AbortSignal): Promise<unknown> } | undefined
    if (typeof controller?.canOpenWorkspacePath !== 'function' || !controller.canOpenWorkspacePath() || typeof controller.openWorkspacePath !== 'function') {
      throw rejected('unavailable', '当前宿主不支持打开本地文件。', 'open_artifact')
    }
    exec.signal.throwIfAborted()
    try { await controller.openWorkspacePath({ path }, exec.signal) }
    catch { exec.signal.throwIfAborted(); throw rejected('open_failed', '译件已保存，但未能在系统默认应用中打开。', 'open_artifact') }
    return { opened: true, path }
  }
  correctSource(input: unknown, exec: ToolExecution): Promise<NormalTranslationCorrectionReceipt> {
    const request = parseNormalTranslationSourceCorrection(input)
    if (this.disposed || !this.topics.ownsAgent(request.target.mainSessionId, exec.agent)) throw rejected('scope_mismatch', '纠错工具不属于此主 Agent。', 'authorize')
    exec.signal.throwIfAborted()
    const key = identity(request.target.mainSessionId, request.operationId), signature = JSON.stringify(request), previous = this.corrections.get(key)
    if (this.jobs.has(key) || this.resolved.has(key) || this.admissions.has(key)) throw rejected('idempotency_conflict', '原文纠错与翻译须使用独立的操作 ID。', 'correct_source')
    if (previous && previous.signature !== signature) throw rejected('idempotency_conflict', '同一纠错操作 ID 不能更换原文或范围。', 'correct_source')
    if (!previous) {
      const result = this.topics.requestOwned(request.target.mainSessionId, { kind: 'normal_correct_source', ...request }, exec).then(value => {
        if (value.kind !== 'normal_source_corrected' || value.correction.operationId !== request.operationId || value.correction.mainSessionId !== request.target.mainSessionId ||
          value.correction.translationSessionId !== request.target.translationSessionId || value.correction.unitId !== request.target.unitId ||
          value.correction.previousSourceVersion !== request.target.sourceVersion) throw rejected('invalid_reply', '原文纠错回执身份不符。', 'correct_source')
        return value.correction
      })
      this.corrections.set(key, { signature, result })
    }
    return this.corrections.get(key)!.result.then(receipt => structuredClone(receipt))
  }
  requestUnit(input: NormalTranslationUnitRequest, signal = new AbortController().signal): Promise<NormalTranslationResult<NormalTranslationUnitReceipt>> {
    const request = parseNormalTranslationUnitRequest(input), peerId = this.ctx.invocation?.peer.id
    if (!peerId || this.disposed || !this.topics.ownsConnection(request.target.mainSessionId, peerId)) return Promise.resolve(bad('scope_mismatch', '重译请求不属于此主会话连接。', 'authorize'))
    // The reply-language line is notice metadata: the identity of a retranslation request is its target and operation.
    const key = identity(request.target.mainSessionId, request.operationId), signature = JSON.stringify({ target: request.target, operationId: request.operationId }), previous = this.unitRequests.get(key)
    if (previous && previous.signature !== signature) return Promise.resolve(bad('idempotency_conflict', '同一重译请求不能更换单元或版本。', 'main_admission'))
    if (!previous) this.unitRequests.set(key, { signature, result: this.submitUnitIntent(request, peerId, signal) })
    return this.unitRequests.get(key)!.result
  }
  private async submitUnitIntent(request: NormalTranslationUnitRequest, peerId: string, signal: AbortSignal): Promise<NormalTranslationResult<NormalTranslationUnitReceipt>> {
    try {
      const controller = this.ctx.get?.('sessionController') as { resolveAgent(id: string): Promise<{ agent: MainAgent & { followup(message: unknown): void } } | { error: unknown }> }
      const [found, helpers] = await Promise.all([controller.resolveAgent(request.target.mainSessionId), hostLlmLoader(this.ctx)()])
      signal.throwIfAborted()
      if ('error' in found) return bad('unavailable', '无法准备所属主会话。', 'resolve_main_agent')
      const agent = found.agent
      if (this.disposed || !this.topics.ownsConnection(request.target.mainSessionId, peerId) || !this.topics.ownsAgent(request.target.mainSessionId, agent)) return bad('scope_mismatch', '所属主会话连接已变化。', 'main_admission')
      const value = await this.topics.requestOwned(request.target.mainSessionId, { kind: 'read_unit', translationSessionId: request.target.translationSessionId,
        unitId: request.target.unitId }, { agent, callId: request.operationId, signal })
      if (value.kind !== 'unit' || value.unit.id !== request.target.unitId || value.unit.sourceVersion !== request.target.sourceVersion) return bad('stale_version', '原文版本已变化，请读取当前单元再重译。', 'resolve_unit')
      if (!this.topics.ownsConnection(request.target.mainSessionId, peerId)) return bad('scope_mismatch', '所属主会话连接已变化。', 'main_admission')
      const directive = uiLanguageDirective(request.uiLocale)
      this.topics.activateForMaterial(agent, request.fileName ? 'file' : 'short')
      agent.followup(helpers.createUserMessage({ content: [{ type: 'text', text: [
        translationTaskBoundary(agent, 'retranslate', { ...request.target, operationId: request.operationId, ...(request.fileName ? { fileName: request.fileName } : {}) }),
        'The user explicitly requests a new translation of this exact unit. Call translation_translate with the target and operationId below, wait for its actual complete result, review it and deliver it in this turn. This is not an asynchronous acceptance/handoff. Do not call retired execution or file-job tools. The program reads the authoritative source and current Session model; do not change the editable draft.',
        'This is a full user-requested retranslation, not an automatic retry or a request to preserve every old wording. The previous translation is reference data. Read current applicable settings and query the relevant active terms, including disputed expressions. Do not copy earlier model-authored notes or obsolete interpretations as current user requirements. Use organizedNotes for your organization; userRequirements contains only actual current user wording, empty when none.',
        SOURCE_LAYOUT_GUIDANCE,
        request.fileName ? `Original file: ${request.fileName}. After review, submit reusable candidates with translation_submit_proposals using the returned target/revisionId (or [] if none). Keep delivery in this file unit and its version entry; briefly report completion in the main chat. Do not call translation_save_result, open a standalone copy or rewrite the same translation into another file unless the user explicitly requests a separate export.` : 'Deliver the reviewed translation. Save a file only when the user explicitly requests a separate export.',
        STYLE_SETTINGS_GUIDANCE,
        ...(request.fileName ? [FILE_MEMORY_REVIEW_GUIDANCE] : []),
        TRANSLATION_SELF_REVIEW,
        ...(request.fileName && /\.md$/iu.test(request.fileName) ? [MARKDOWN_REVIEW_GUIDANCE] : []),
        DIRECT_REVISION_GUIDANCE,
        JSON.stringify({ target: request.target, operationId: request.operationId, userRequirements: '', organizedNotes: '', termReferences: [] }),
        ...(directive ? [directive] : []),
      ].join('\n') }], source: { kind: 'translation-unit', form: 'notice', summary: '重译单元', plugin: 'dsh-translation-plugin', mainSessionId: request.target.mainSessionId,
        translationSessionId: request.target.translationSessionId, unitId: request.target.unitId, sourceVersion: request.target.sourceVersion, operationId: request.operationId } }))
      return ok({ ...request, status: 'submitted' })
    } catch (error) { return bad((error as { code?: string }).code ?? 'main_admission_failed', '重译意图未能进入主会话；单元与草稿保留。', 'main_admission') }
  }
  private emit(job: Job, status: NormalTranslationUpdate['status'], textDelta = '', metadata: TranslationCallMetadata | null = null, error: NormalTranslationError | null = null): void {
    const operation = job.operation!
    const update: NormalTranslationUpdate = { mainSessionId: operation.mainSessionId, translationSessionId: operation.translationSessionId,
      unitId: operation.unitId, operationId: operation.operationId, sourceVersion: operation.sourceVersion, callId: job.callId,
      sequence: job.updates.length + 1, status, textDelta, metadata, error }
    job.updates.push(structuredClone(update)); job.status = status; job.operation = { ...operation, status }
    const v2Attempt = job.attempts.snapshot().attempts.length > 0 && isNormalExchangePromptVersion(job.metadata?.promptVersion)
    if (v2Attempt) return
    job.writing = job.writing.then(async () => {
      if (job.deliveryFailed || this.disposed) return
      try {
        const value = await this.topics.requestOwned(operation.mainSessionId, { kind: 'normal_update', ...update },
          { agent: job.agent, callId: job.callId ?? operation.operationId, signal: job.delivery.signal })
        if (value.kind !== 'normal_updated' || value.callId !== update.callId || value.sequence !== update.sequence || value.operation.operationId !== operation.operationId ||
          value.operation.mainSessionId !== operation.mainSessionId || value.operation.unitId !== operation.unitId || value.operation.sourceVersion !== operation.sourceVersion) throw rejected('invalid_reply', '译文回写回执身份不一致。', 'writeback')
      } catch {
        job.deliveryFailed = true
        job.error = { code: 'WRITEBACK_UNCONFIRMED', message: '译文回写尚未确认，请查询原操作；模型不会重新调用。', stage: 'writeback' }
        job.controller.abort()
      }
    })
  }
  private deliverV2(job: Job): void {
    const event = job.attempts.snapshot().events.at(-1)!, operation = job.operation!
    job.writing = job.writing.then(async () => {
      if (job.deliveryFailed || this.disposed) return
      try {
        const value = await this.topics.requestOwned(operation.mainSessionId, { kind: 'normal_v2_update', mainSessionId: operation.mainSessionId,
          translationSessionId: operation.translationSessionId, unitId: operation.unitId, operationId: operation.operationId, sourceVersion: operation.sourceVersion, event },
          { agent: job.agent, callId: event.callId ?? operation.operationId, signal: job.delivery.signal })
        if (value.kind !== 'normal_v2_updated' || value.callId !== event.callId || value.sequence !== event.sequence || value.operation.operationId !== operation.operationId ||
          value.operation.mainSessionId !== operation.mainSessionId || value.operation.unitId !== operation.unitId || value.operation.sourceVersion !== operation.sourceVersion) throw rejected('invalid_reply', '普通翻译 v2 回写回执身份不一致。', 'writeback')
        job.deliveredSequence = event.sequence
      } catch {
        job.deliveryFailed = true
        job.error = { code: 'WRITEBACK_UNCONFIRMED', message: 'v2 译文回写尚未确认，请查询原操作；模型不会重新调用。', stage: 'writeback' }
        job.controller.abort()
      }
    })
  }
  private async run(job: Job): Promise<void> {
    if (!job.operation || !job.packet) return
    let terminal = false, bodyLength = 0
    try {
      if (job.error?.code === 'HOST_GENERATION_LOST') return
      if (job.controller.signal.aborted || this.disposed) { this.emit(job, 'cancelled', '', null, { code: 'CANCELLED_BEFORE_DISPATCH', message: '已在模型调用前取消。', stage: 'cancel' }); return }
      if (job.packet.referenceContext) await (this.ctx.get?.('translationReferences') as ReferenceFilesService).validateContext(job.packet.referenceContext, {agent:job.agent,callId:job.request.operationId,signal:job.controller.signal})
      for await (const event of this.adapter.executeNormal(job.packet, job.controller.signal, () => {
        if (job.error?.code === 'HOST_GENERATION_LOST') throw job.error
        job.callId = job.packet!.callId
        const contextVersion = job.metadata!.exchangeContext?.contextVersion ?? 1
        job.attempts.start(job.callId, contextVersion, job.metadata!, job.exchangeId)
        job.v2Status = 'running'
        if (isNormalExchangePromptVersion(job.metadata!.promptVersion)) {
          const resolutionId = job.metadata!.exchangeContext?.resolutionRefs[0]?.resolutionId
          this.deliverV2(job)
          if (resolutionId && job.exchange) {
            job.writing = job.writing.then(() => {
              const operation = job.operation!, latest = job.attempts.snapshot().attempts.at(-1)!
              job.exchange!.resumeStarted(job.exchangeOwner as unknown as Parameters<TranslationExchangeService['resumeStarted']>[0], {
                mainSessionId: operation.mainSessionId, topicId: operation.topicId, translationSessionId: operation.translationSessionId,
                unitId: operation.unitId, sourceVersion: operation.sourceVersion, operationId: operation.operationId, callId: job.callId!,
                contextVersion: latest.contextVersion, hostGeneration: job.exchange!.hostGeneration, lastSequence: job.attempts.snapshot().events.length,
                ...(job.exchangeId ? { exchangeId: job.exchangeId } : {}),
              }, resolutionId)
            })
          }
        }
        this.emit(job, 'running', '', job.metadata)
      })) {
        if (job.error?.code === 'HOST_GENERATION_LOST') throw job.error
        if (event.type === 'text') {
          bodyLength += event.text.length
          const points = Array.from(event.text)
          for (let offset = 0; offset < points.length; offset += 8192) {
            const delta = points.slice(offset, offset + 8192).join('')
            if (delta) {
              job.attempts.partial(job.callId!, delta)
              if (isNormalExchangePromptVersion(job.metadata?.promptVersion)) this.deliverV2(job)
            }
            this.emit(job, 'running', delta)
          }
        } else if (event.type === 'usage') {
          job.metadata = { ...job.metadata!, usage: { inputTokens: event.input_tokens ?? job.metadata!.usage.inputTokens,
            outputTokens: event.output_tokens ?? job.metadata!.usage.outputTokens } }
        } else if (event.type === 'needs_context') {
          job.requestContext = event.input
          const operation = job.operation!
          const scope: ExchangeScope = { mainSessionId: operation.mainSessionId, topicId: operation.topicId,
            translationSessionId: operation.translationSessionId, unitId: operation.unitId, sourceVersion: operation.sourceVersion, operationId: operation.operationId }
          job.exchangeId = null
          job.v2Status = 'waiting_context'
          job.attempts.needsContext(job.callId!, event.input, null, 'waiting_context')
          this.deliverV2(job)
          await job.writing
          if (job.deliveryFailed) {
            job.v2Status = 'unknown'
            job.error = { code: 'QUESTION_WRITEBACK_UNKNOWN', message: '补充问题未获 Client 确认；未通知主模型，也不会自动续作。', stage: 'writeback' }
            continue
          }
          let controlStatus: 'waiting_context' | 'waiting_user' = 'waiting_context'
          let registered = false
          let ref: NeedsContextReference | undefined
          if (job.exchange && job.operation && isNormalExchangePromptVersion(job.metadata?.promptVersion)) {
            ref = { scope, callId: job.callId!, contextVersion: job.attempts.snapshot().attempts.at(-1)!.contextVersion,
              hostGeneration: job.exchange.hostGeneration, lastSequence: job.attempts.snapshot().events.length }
            const accepted = await job.exchange.acceptNeedsContext(job.exchangeOwner as unknown as Parameters<TranslationExchangeService['acceptNeedsContext']>[0], ref, event.input)
            if (accepted.ok) {
              job.exchangeId = accepted.value.exchangeId
              controlStatus = accepted.value.status === 'waiting_user' ? 'waiting_user' : 'waiting_context'
              registered = true
            }
          }
          job.v2Status = controlStatus
          if (isNormalExchangePromptVersion(job.metadata?.promptVersion) && !registered) {
            job.attempts.control(job.callId!, 'unknown', null, null)
            job.v2Status = 'unknown'
            job.error = { code: 'EXCHANGE_UNAVAILABLE', message: '求助控制事实未能登记，操作状态未知；不会自动续作。', stage: 'register_resume' }
          } else if (registered) {
            job.attempts.control(job.callId!, controlStatus, null, job.exchangeId)
          }
          if (isNormalExchangePromptVersion(job.metadata?.promptVersion)) {
            this.deliverV2(job)
            await job.writing
            if (job.deliveryFailed) {
              job.v2Status = 'unknown'
              job.error = { code: 'EXCHANGE_BIND_UNKNOWN', message: '求助编号未获 Client 确认；不会通知主模型或自动续作。', stage: 'writeback' }
              if (ref && job.exchangeId) await job.exchange?.finishOperation(job.exchangeOwner as unknown as Parameters<TranslationExchangeService['finishOperation']>[0], {
                ...scope, callId: job.callId!, contextVersion: ref.contextVersion, hostGeneration: ref.hostGeneration,
                lastSequence: job.attempts.snapshot().events.length, exchangeId: job.exchangeId,
              }, 'unknown')
            }
          }
        } else {
          terminal = true
          const complete = event.reason === 'stop' && event.provider_state === 'finished' && event.completeness === 'complete' && event.checks_passed && bodyLength > 0
          const status = event.provider_state === 'unknown' ? 'unknown' : event.reason === 'aborted' ? 'cancelled' : complete && !job.requestContext ? 'completed' : 'failed'
          if (job.callId) job.attempts.end(job.callId, status, status === 'completed' ? null : {
            code: status === 'cancelled' ? 'CANCELLED' : job.requestContext ? 'EXCHANGE_UNAVAILABLE' : 'INCOMPLETE_RESULT',
            message: status === 'cancelled' ? '普通翻译已取消，已有输出保留。' : job.requestContext ? '当前执行尚未连接补充协调器，部分译文已保留。' : '普通译文未完整完成，已有输出保留。',
            stage: status === 'cancelled' ? 'cancel' : job.requestContext ? 'resolve' : 'stream',
          }, job.metadata ?? undefined, job.exchangeId)
          if (isNormalExchangePromptVersion(job.metadata?.promptVersion)) this.deliverV2(job)
          if (!job.requestContext) job.v2Status = status
          const error = status === 'completed' ? null : status === 'cancelled'
            ? { code: 'CANCELLED', message: '普通翻译已取消，已有输出保留。', stage: 'cancel' }
            : job.requestContext ? { code: 'EXCHANGE_UNAVAILABLE', message: '当前执行尚未连接补充协调器，部分译文已保留。', stage: 'resolve' }
            : this.adapter.diagnostic(job.packet.operationId) ?? { code: 'INCOMPLETE_RESULT', message: '普通译文未完整完成，已有输出保留。', stage: 'stream' }
          job.error = error; this.emit(job, status, '', job.metadata, error)
        }
      }
      if (!terminal) throw rejected('INVALID_STREAM', '模型未提供结束状态。', 'protocol')
    } catch {
      const error = job.error?.code === 'HOST_GENERATION_LOST' ? job.error : this.adapter.diagnostic(job.packet.operationId) ?? { code: 'OUTCOME_UNKNOWN', message: '模型调用结束状态尚未确认，请查询原操作。', stage: 'stream' }
      job.error = error
      const status = error.stage === 'protocol' ? 'failed' : 'unknown'
      if (job.callId && job.attempts.snapshot().attempts.at(-1)?.endSequence === null) {
        job.attempts.end(job.callId, status, error, job.metadata ?? undefined, job.exchangeId)
        if (isNormalExchangePromptVersion(job.metadata?.promptVersion)) this.deliverV2(job)
      }
      if (job.v2Status !== 'waiting_context') job.v2Status = status
      this.emit(job, status, '', job.callId ? job.metadata : null, error)
    } finally {
      this.adapter.discard(job.packet.operationId)
      await job.writing
      if (job.deliveryFailed) {
        job.v2Status = 'unknown'; job.status = 'unknown'
        if (job.operation) job.operation = { ...job.operation, status: 'unknown' }
      }
      const attempt = job.attempts.snapshot().attempts.at(-1)
      if (job.exchange && job.operation && job.exchangeId && job.callId && isNormalExchangePromptVersion(job.metadata?.promptVersion) && attempt) {
        const result = job.v2Status === 'waiting_context' || job.v2Status === 'waiting_user' ? 'needs_context'
          : job.v2Status === 'completed' ? 'completed' : job.v2Status === 'cancelled' ? 'cancelled' : 'unknown'
        await job.exchange.finishOperation(job.exchangeOwner as unknown as Parameters<TranslationExchangeService['finishOperation']>[0], {
          mainSessionId: job.operation.mainSessionId, topicId: job.operation.topicId, translationSessionId: job.operation.translationSessionId,
          unitId: job.operation.unitId, sourceVersion: job.operation.sourceVersion, operationId: job.operation.operationId,
          callId: attempt.callId, contextVersion: attempt.contextVersion, hostGeneration: job.exchange.hostGeneration,
          lastSequence: job.attempts.snapshot().events.length, exchangeId: job.exchangeId,
        }, result)
        // The translator attempt must be durably ended before the main Agent can resolve it.
        if (result === 'needs_context' && job.v2Status === 'waiting_context' && !job.deliveryFailed) {
          await job.exchange.notifyMainAgent(job.exchangeOwner as unknown as Parameters<TranslationExchangeService['notifyMainAgent']>[0], {
            scope: { mainSessionId: job.operation.mainSessionId, topicId: job.operation.topicId, translationSessionId: job.operation.translationSessionId,
              unitId: job.operation.unitId, sourceVersion: job.operation.sourceVersion, operationId: job.operation.operationId },
            callId: attempt.callId, contextVersion: attempt.contextVersion, hostGeneration: job.exchange.hostGeneration,
            lastSequence: job.attempts.snapshot().events.length,
          })
        }
      }
      if (!['unknown', 'waiting_context', 'waiting_user', 'resuming'].includes(job.v2Status)) this.activeSessions.delete(job.sessionId)
    }
  }
  private scoped(input: NormalTranslationQuery): NormalTranslationResult<Job> {
    const peerId = this.ctx.invocation?.peer.id
    const job = this.jobs.get(identity(input.mainSessionId, input.operationId))
    if (!peerId || this.disposed || !(this.topics.ownsConnection(input.mainSessionId, peerId) || job?.namespaceId && this.topics.ownsLibrary(job.namespaceId, peerId))) return bad('scope_mismatch', '普通翻译查询或取消不属于此资料库。', 'authorize')
    if (!job || job.envelope.material.translationSessionId !== input.translationSessionId) return bad('not_found', '未找到该运行期操作；不能据此重新派发。', 'observe')
    return { ok: true, value: job }
  }
  private view(job: Job, after: number): NormalTranslationResult<NormalTranslationJob> {
    if (after > job.updates.length) return bad('stale_cursor', '查询位置超过原操作的实际记录。', 'observe')
    const updates: NormalTranslationUpdate[] = []
    const view = (): NormalTranslationJob => ({ operation: job.operation, callId: job.callId, status: job.status, updates,
      lastSequence: job.updates.length, more: after + updates.length < job.updates.length, error: job.error })
    for (const update of job.updates.slice(after)) {
      updates.push(update)
      if (new TextEncoder().encode(JSON.stringify(view())).byteLength > MAX_TOPIC_BRIDGE_REPLY_BYTES) { updates.pop(); break }
    }
    return ok(view())
  }
  async status(input: NormalTranslationQuery): Promise<NormalTranslationResult<NormalTranslationJob>> {
    const request = parseNormalTranslationQuery(input), found = this.scoped(request), peerId = this.ctx.invocation?.peer.id
    if (!found.ok) return found
    const job = found.value
    // A lost Client acknowledgement is not an unknown provider outcome. Return its recorded
    // terminal events for replay and release execution occupancy; never dispatch another call here.
    await job.writing
    const settled = job.attempts.snapshot().attempts.at(-1)
    if (job.deliveryFailed && settled?.endSequence != null && ['completed', 'failed', 'cancelled'].includes(settled.status)) {
      job.status = settled.status as 'completed' | 'failed' | 'cancelled'
      job.v2Status = job.status
      if (job.operation) job.operation = { ...job.operation, status: job.status }
      this.activeSessions.delete(job.sessionId)
    }

    if (job.acceptRequested && job.operation === null && job.status === 'unknown' && peerId) {
      try {
        const value = await this.topics.observeOperation(request.mainSessionId, peerId, { kind: 'normal_observe',
          translationSessionId: request.translationSessionId, operationId: request.operationId }, new AbortController().signal)
        if (job.operation === null && value.kind === 'normal_observed' && value.operation && value.operation.operationId === request.operationId &&
          value.operation.mainSessionId === request.mainSessionId && value.operation.translationSessionId === request.translationSessionId &&
          value.operation.materialId === job.envelope.material.materialId && value.operation.sourceVersion === job.envelope.material.sourceVersion) {
          job.operation = value.operation
          job.error = { code: 'EXECUTION_NOT_STARTED', message: '材料已受理，但翻译模型未调用；此次操作已结算，原文记录保留。', stage: 'dispatch' }
          this.emit(job, 'failed', '', null, job.error)
          this.activeSessions.delete(job.sessionId)
        }
      } catch { /* No additional evidence: retain the original unknown operation without dispatch. */ }
    }
    return this.view(job, request.afterSequence)
  }
  async readLog(raw: TranslationLogRead): Promise<NormalTranslationResult<TranslationLogPage>> {
    const input = parseTranslationLogRead(raw), peer = this.ctx.invocation?.peer.id
    const found = this.scoped(input)
    let ownsCall = found.ok && (found.value.callId === input.callId || found.value.attempts.snapshot().attempts.some(attempt => attempt.callId === input.callId))
    if (!ownsCall) {
      const direct = this.direct.get(identity(input.mainSessionId, input.operationId))
      if (!peer || !this.topics.ownsConnection(input.mainSessionId, peer) || !direct?.settled) return bad('not_found', '该调用日志当前不可读取，请在原宿主运行期间导出。', 'observe')
      const receipt = await direct.promise
      ownsCall = this.direct.get(identity(input.mainSessionId, input.operationId)) === direct && receipt.translationSessionId === input.translationSessionId && receipt.revisionId === input.callId
    }
    if (!ownsCall) return bad('scope_mismatch', '调用日志与所选版本不匹配。', 'authorize')
    const events = this.adapter.inspectCallLog(input.callId)
    if (!events) return bad('not_found', '该调用没有可导出的执行日志；可能尚未派发或宿主已重启。', 'observe')
    // Export only the public route in request headers, never adapter defaults or credentials.
    const text = JSON.stringify({ schemaVersion: 1, callId: input.callId, events }, (key, value) => {
      if (key === 'adapterDefaults' || /^(?:apiKey|api_key|authorization|password|secret|access_token|refresh_token|headers)$/iu.test(key)) return undefined
      if (key === 'config' && value && typeof value === 'object') return { provider: value.provider, model: value.model, reasoningEffort: value.reasoningEffort, maxTokens: value.maxTokens }
      return value
    }, 2)
    if (input.start > text.length) return bad('stale_cursor', '日志读取位置无效。', 'observe')
    const end = Math.min(text.length, input.start + 4000)
    return ok({ text: text.slice(input.start, end), next: end < text.length ? end : null, total: text.length })
  }
  private viewV2(job: Job, after: number): NormalTranslationResult<NormalTranslationV2Job> {
    const { attempts, events } = job.attempts.snapshot()
    const page: typeof events[number][] = []
    const operation = job.operation && { ...job.operation, status: job.v2Status }
    const view = (): NormalTranslationV2Job => ({ operation: operation!, status: job.v2Status, attempts, events: page,
      lastSequence: events.length, more: after + page.length < events.length, error: job.error })
    if (!operation) return bad('not_found', '普通翻译尚未取得受理回执。', 'observe')
    if (after > events.length) return bad('stale_cursor', '查询位置超过原操作的实际记录。', 'observe')
    for (const event of events.slice(after)) {
      page.push(event)
      if (new TextEncoder().encode(JSON.stringify(view())).byteLength > MAX_TOPIC_BRIDGE_REPLY_BYTES) { page.pop(); break }
    }
    return ok(view())
  }
  async statusV2(input: NormalTranslationQuery): Promise<NormalTranslationResult<NormalTranslationV2Job>> {
    const request = parseNormalTranslationQuery(input), found = this.scoped(request)
    if (!found.ok) return found
    const job = found.value
    const live = this.ctx.get?.('translationExchange') as TranslationExchangeService | undefined
    if (job.exchange && job.exchange.hostGeneration !== live?.hostGeneration && ['accepted', 'running', 'waiting_context', 'waiting_user', 'resuming'].includes(job.v2Status)) {
      job.controller.abort()
      job.v2Status = 'unknown'; job.status = 'unknown'
      job.operation = job.operation && { ...job.operation, status: 'unknown' }
      job.error = { code: 'HOST_GENERATION_LOST', message: '补充协调宿主已重新加载，原操作状态未知；不会自动重新调用模型。', stage: 'observe' }
      const attempt = job.attempts.snapshot().attempts.at(-1)
      if (attempt?.endSequence !== null && attempt && job.exchangeId) {
        job.attempts.control(attempt.callId, 'unknown', null, job.exchangeId)
        this.deliverV2(job); await job.writing
      }
    }
    return this.viewV2(job, request.afterSequence)
  }
  async cancelV2(input: NormalTranslationQuery): Promise<NormalTranslationResult<NormalTranslationV2Job>> {
    const request = parseNormalTranslationQuery(input), found = this.scoped(request)
    if (!found.ok) return found
    const job = found.value
    if (['preparing', 'accepted', 'running', 'unknown', 'waiting_context', 'waiting_user', 'resuming'].includes(job.v2Status)) {
      const attempt = job.attempts.snapshot().attempts.at(-1)
      if (job.exchange && job.exchangeId && attempt) {
        const operation = job.operation!
        const prepared = [...this.resumesByResolution.values()].find(entry => entry.job === job && entry.registered &&
          entry.token.candidateCallId === job.packet?.callId && entry.exchangeId === job.exchangeId)
        const cancelled = await this.cancelOperation({ mainSessionId: operation.mainSessionId, topicId: operation.topicId,
          translationSessionId: operation.translationSessionId, unitId: operation.unitId, sourceVersion: operation.sourceVersion,
          operationId: operation.operationId, callId: prepared?.token.candidateCallId ?? job.callId ?? attempt.callId,
          contextVersion: prepared?.token.contextVersion ?? attempt.contextVersion,
          hostGeneration: job.exchange.hostGeneration, lastSequence: job.attempts.snapshot().events.length, exchangeId: job.exchangeId })
        if (cancelled === false) return bad('cancel_unconfirmed', '普通翻译取消未获执行端确认；请查询原操作。', 'writeback')
      } else job.controller.abort()
    }
    return this.viewV2(job, request.afterSequence)
  }
  cancel(input: NormalTranslationQuery): NormalTranslationResult<NormalTranslationJob> {
    const request = parseNormalTranslationQuery(input), found = this.scoped(request)
    if (!found.ok) return found
    const job = found.value
    if (['preparing', 'accepted', 'running', 'unknown'].includes(job.status)) job.controller.abort()
    return this.view(job, request.afterSequence)
  }
  hasActiveJobs(ownerId?: string): boolean {
    if (ownerId === undefined) return this.activeSessions.size > 0 || this.documentSessions.size > 0 || [...this.jobs.values()].some(job => ['accepted', 'running', 'unknown'].includes(job.status) || ['waiting_context', 'waiting_user'].includes(job.v2Status))
    return [...this.jobs.values()].some(job => job.envelope.mainSessionId === ownerId && (['preparing', 'accepted', 'running', 'unknown'].includes(job.status) || ['waiting_context', 'waiting_user'].includes(job.v2Status)))
  }
  historyUnitBusy(scope: HistoryScope, unitId: string): boolean {
    return [...this.jobs.values()].some(job => historyTargetMatches(scope, unitId, job.operation ?? job.envelope.material) && (['preparing', 'accepted', 'running', 'unknown'].includes(job.status) || ['waiting_context', 'waiting_user', 'resuming'].includes(job.v2Status))) ||
      [...this.direct.values(), ...this.extractions.values()].some(entry => { const target = JSON.parse(entry.signature).target; return !entry.settled && (historyTargetMatches(scope, unitId, target) || target.kind === 'material' && `unit:${target.materialId}` === unitId) }) ||
      [...this.direct.values()].some(entry => !entry.settled && entry.historyContext && [entry.historyContext.refs.base, ...entry.historyContext.refs.nearby].some(ref => ref && historyTargetMatches(scope, unitId, { ...entry.historyContext, ...ref })))
  }
  forgetHistoryUnit(scope: HistoryScope, unitId: string, sourceVersion?: number): void {
    const owned = new Set([...this.jobs.values()].filter(job => historyTargetMatches(scope, unitId, job.operation ?? job.envelope.material, sourceVersion)))
    for (const [id, job] of this.jobs) if (owned.has(job)) {
      job.controller.abort(); job.delivery.abort(); this.adapter.discard(job.packet?.operationId ?? job.internalId)
      for (const attempt of job.attempts.snapshot().attempts) this.adapter.forgetCallLog(attempt.callId)
      this.jobs.delete(id)
    }
    for (const [id, entry] of this.resumeTokens) if (owned.has(entry.job)) this.resumeTokens.delete(id)
    for (const [id, entry] of this.resumesByResolution) if (owned.has(entry.job)) this.resumesByResolution.delete(id)
    const matches = (target: NormalTranslationTarget): boolean => historyTargetMatches(scope, unitId, target, sourceVersion) || target?.kind === 'material' && `unit:${target.materialId}` === unitId && (sourceVersion === undefined || target.sourceVersion === sourceVersion)
    for (const [id, entry] of this.direct) if (matches(JSON.parse(entry.signature).target) || entry.historyContext &&
      [entry.historyContext.refs.base, ...entry.historyContext.refs.nearby].some(ref => ref && historyTargetMatches(scope, unitId, { ...entry.historyContext, ...ref }, sourceVersion))) {
      if (entry.callId) this.adapter.forgetCallLog(entry.callId)
      this.direct.delete(id); this.directResults.delete(id); this.savedArtifacts.delete(id)
    }
    for (const [id, entry] of this.admissions) if (matches(JSON.parse(entry.signature).target)) this.admissions.delete(id)
    for (const map of [this.resolved, this.corrections, this.unitRequests, this.direct, this.extractions]) for (const [id, entry] of map) {
      const request = JSON.parse(entry.signature)
      if (matches(request.target)) { map.delete(id); this.directResults.delete(id); this.savedArtifacts.delete(id) }
    }
  }
  dispose(): void {
    this.disposed = true
    this.unregisterExchange?.(); this.unregisterExchange = undefined; this.exchange = undefined
    for (const job of this.jobs.values()) { job.controller.abort(); job.delivery.abort(); this.adapter.discard(job.packet?.operationId ?? job.internalId) }
    for (const entry of this.resumeTokens.values()) if (entry.packet) this.adapter.discard(entry.packet.operationId)
    this.resumeTokens.clear(); this.resumesByResolution.clear()
    this.admissions.clear(); this.resolved.clear(); this.corrections.clear(); this.unitRequests.clear(); this.activeSessions.clear(); this.documentSessions.clear()
    this.direct.clear(); this.directResults.clear()
    this.extractions.clear(); this.savedArtifacts.clear(); this.artifacts = undefined
    void this.workers.dispose()
  }
}
export function installNormalTranslation(ctx: TopicHostContext, loadModule?: LlmModuleLoader, registerRemote = true): NormalTranslationService {
  if (ctx.root && !Object.hasOwn(ctx.root.reflect.props, 'invocation')) ctx.root.accessor('invocation', { get: () => undefined })
  const service = new NormalTranslationService(ctx, loadModule)
  ctx.provide('translationNormal', service)
  ctx.provide('translationNormalV2', service.v2Remote)
  if (registerRemote) {
    const register = (scope: TopicHostContext): void => {
      const registry = (scope.get?.('typert') ?? scope.typert) as TopicHostContext['typert']
      registry?.register({ package: NORMAL_TRANSLATION_REMOTE.package, face: 'host', schemas: [], invocations: [...NORMAL_TRANSLATION_REMOTE.descriptors, ...NORMAL_TRANSLATION_V2_REMOTE.descriptors],
        model: { package: NORMAL_TRANSLATION_REMOTE.package, face: 'host', classes: [], events: [], objects: [] } })
    }
    if (ctx.inject) ctx.inject(['typert'], register)
    else register(ctx)
  }
  ctx.effect?.(() => () => service.dispose(), 'normal translation lifetime')
  return service
}
