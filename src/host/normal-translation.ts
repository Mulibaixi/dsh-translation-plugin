import { NORMAL_TRANSLATION_REMOTE, parseNormalTranslationExecute, parseNormalTranslationQuery, type NormalTranslationExecute,
  type NormalTranslationOperation, type NormalTranslationQuery, type NormalTranslationJob, type NormalTranslationResult,
  type NormalTranslationUpdate, type NormalTranslationError, type NormalTranslationCapability,
  parseNormalTranslationSourceCorrection, type NormalTranslationCorrectionReceipt,
  parseNormalTranslationUnitRequest, type NormalTranslationUnitRequest, type NormalTranslationUnitReceipt } from '../shared/normal-translation.js'
import { MAX_TOPIC_BRIDGE_REPLY_BYTES, type TopicBridgeValue } from '../shared/topic-bridge.js'
import type { TranslationMaterialEnvelope, TranslationMaterialSnapshot } from '../shared/translation-material.js'
import type { NormalTranslationContext, TranslationCallMetadata } from '../shared/translation-call.js'
import type { TopicTermSnapshot } from '../memory/topic-terms.js'
import { DshTextExecutionAdapter, hostLlmLoader, type LlmModuleLoader, type NormalExecutionPacket } from './dsh-text-adapter.js'
import type { TopicHostContext, TopicToolsService, ToolExecution, MainAgent } from './topic-tools.js'
import type { TranslationMaterialsService } from './translation-materials.js'

type Accepted = Extract<TopicBridgeValue, { kind: 'normal_operation' }>
type Envelope = Extract<TranslationMaterialEnvelope, { kind: 'material' }>
type InlineEnvelope = Envelope & { readonly material: Extract<TranslationMaterialSnapshot, { readonly sourceText: string }> }
interface Admission { readonly signature: string; readonly sessionId: string; readonly result: Promise<Accepted> }
interface Job {
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
  deliveryFailed: boolean
  acceptRequested: boolean
  writing: Promise<void>
}
function rejected(code: string, message: string, stage: string): Error { return Object.assign(new Error(message), { code, stage }) }
function ok<T>(value: T): NormalTranslationResult<T> { return { ok: true, value: structuredClone(value) } }
function bad<T>(code: string, message: string, stage: string): NormalTranslationResult<T> { return { ok: false, error: { code, message, stage } } }
function identity(ownerId: string, operationId: string): string { return JSON.stringify([ownerId, operationId]) }
function requireInline(envelope: Envelope): asserts envelope is InlineEnvelope {
  if (envelope.material.sourceRef !== undefined) throw rejected('requires_batch', '文件原稿已固定，可供准备和讨论；完整文件翻译需要后续分批执行支持，材料保留。', 'prepare')
}

/** Transient calls and short receipts only. The Client owns all source and revision history. */
export class NormalTranslationService {
  readonly typertRemote: { readonly service: NormalTranslationService; readonly serviceKey: 'translationNormal'; readonly namespace: 'translationNormal' }
  readonly adapter: DshTextExecutionAdapter
  private readonly admissions = new Map<string, Admission>()
  private readonly jobs = new Map<string, Job>()
  private readonly resolved = new Map<string, { readonly signature: string; readonly result: Promise<Envelope> }>()
  private readonly corrections = new Map<string, { readonly signature: string; readonly result: Promise<NormalTranslationCorrectionReceipt> }>()
  private readonly unitRequests = new Map<string, { readonly signature: string; readonly result: Promise<NormalTranslationResult<NormalTranslationUnitReceipt>> }>()
  private readonly activeSessions = new Set<string>()
  private disposed = false
  constructor(readonly ctx: TopicHostContext, loadModule?: LlmModuleLoader) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationNormal', property: 'ctx' } })
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'translationNormal', namespace: 'translationNormal' })
    this.adapter = new DshTextExecutionAdapter(ctx, loadModule)
  }
  private get topics(): TopicToolsService { return this.ctx.get?.('translationTopics') as TopicToolsService }
  private get materials(): TranslationMaterialsService { return this.ctx.get?.('translationMaterials') as TranslationMaterialsService }
  private owned(request: NormalTranslationExecute, exec: ToolExecution): void {
    if (this.disposed || !this.topics?.ownsAgent(request.target.mainSessionId, exec.agent)) throw rejected('scope_mismatch', '普通翻译操作不属于已连接的主 Agent。', 'authorize')
    exec.signal.throwIfAborted()
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
    this.owned(request, exec)
    const key = identity(request.target.mainSessionId, request.operationId), previous = this.jobs.get(key)
    if (this.corrections.has(key)) throw rejected('idempotency_conflict', '原文纠错与翻译须使用独立的操作 ID。', 'prepare')
    if (previous) {
      if (JSON.stringify(previous.request) !== JSON.stringify(request)) throw rejected('idempotency_conflict', '同一业务操作 ID 不能更换材料、版本或要求。', 'prepare')
      return previous.acceptance.then(() => structuredClone(previous.operation!))
    }
    if (request.target.kind === 'unit') {
      const signature = JSON.stringify(request), previous = this.resolved.get(key)
      if (previous && previous.signature !== signature) throw rejected('idempotency_conflict', '同一业务操作 ID 不能更换单元、版本或要求。', 'resolve_unit')
      if (!previous) {
        const target = request.target
        const result = this.topics.requestOwned(target.mainSessionId, { kind: 'normal_resolve', target, operationId: request.operationId }, exec).then(value => {
          if (value.kind !== 'normal_resolved' || value.envelope.mainSessionId !== target.mainSessionId ||
            value.envelope.material.translationSessionId !== target.translationSessionId || value.envelope.material.sourceVersion !== target.sourceVersion ||
            value.envelope.material.unitReference?.unitId !== target.unitId || value.envelope.material.unitReference.sourceVersion !== target.sourceVersion) throw rejected('invalid_reply', '历史单元的权威源快照身份不符。', 'resolve_unit')
          return value.envelope
        })
        this.resolved.set(key, { signature, result })
      }
      return this.resolved.get(key)!.result.then(envelope => this.executeEnvelope(request, exec, envelope))
    }
    return this.executeEnvelope(request, exec, this.source(request, exec))
  }
  private executeEnvelope(request: NormalTranslationExecute, exec: ToolExecution, envelope: Envelope): Promise<NormalTranslationOperation> {
    this.owned(request, exec)
    requireInline(envelope)
    const key = identity(request.target.mainSessionId, request.operationId), previous = this.jobs.get(key)
    if (previous) return previous.acceptance.then(() => structuredClone(previous.operation!))
    const sessionId = identity(request.target.mainSessionId, envelope.material.translationSessionId)
    if (!envelope.material.model) throw rejected('model_required', '此提交材料未选择翻译模型，请选择后重新提交；草稿保留。', 'prepare')
    if (this.activeSessions.has(sessionId)) throw rejected('busy', '此普通翻译会话仍有未结算操作。', 'prepare')
    this.activeSessions.add(sessionId)
    const job: Job = { request, envelope, agent: exec.agent!, sessionId, controller: new AbortController(), delivery: new AbortController(),
      internalId: `normal-operation:${crypto.randomUUID()}`, updates: [], acceptance: undefined!, operation: null, packet: undefined,
      callId: null, metadata: null, status: 'preparing', error: null, deliveryFailed: false, acceptRequested: false, writing: Promise.resolve() }
    const abort = () => job.controller.abort()
    exec.signal.addEventListener('abort', abort, { once: true })
    this.jobs.set(key, job)
    job.acceptance = Promise.resolve().then(() => this.prepare(job, exec.callId)).finally(() => exec.signal.removeEventListener('abort', abort))
    return job.acceptance.then(() => structuredClone(job.operation!))
  }
  private validateTerms(request: NormalTranslationExecute, envelope: Envelope, snapshot: TopicTermSnapshot): void {
    if (snapshot.ownerId !== request.target.mainSessionId || snapshot.topicId !== envelope.material.topicId ||
      snapshot.entries.length !== request.termReferences.length || request.termReferences.some(ref => !snapshot.entries.some(entry =>
        entry.id === ref.id && entry.version === ref.entryVersion && entry.status === 'active' && entry.targetLanguage === envelope.material.targetLanguage))) throw rejected('invalid_reply', '普通翻译术语回执与指定范围或版本不一致。', 'prepare')
  }
  private async prepare(job: Job, mainCallId: string): Promise<NormalTranslationOperation> {
    const { request, envelope } = job, exec: ToolExecution = { agent: job.agent, callId: mainCallId, signal: job.controller.signal }
    try {
      if (!await this.adapter.ready()) throw rejected('execution_unavailable', '普通翻译模型运行服务尚未就绪；材料保留。', 'prepare')
      const terms = await this.topics.requestOwned(request.target.mainSessionId, { kind: 'normal_prepare', envelope,
        operationId: request.operationId, organizedRequirements: request.organizedRequirements, termReferences: request.termReferences }, exec)
      if (terms.kind !== 'normal_prepared') throw rejected('invalid_reply', '未取得普通翻译准备回执。', 'prepare')
      this.validateTerms(request, envelope, terms.termSnapshot)
      const route = envelope.material.model!, model = { providerId: route.provider, modelId: route.model, configVersion: 0,
        ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) }
      await this.adapter.prepareOperation(job.internalId, model, job.controller.signal)
      const context: NormalTranslationContext = { organizedRequirements: request.organizedRequirements, terms: terms.termSnapshot.entries.map(entry => ({
        id: entry.id, entryVersion: entry.version, sourceForms: entry.sourceForms, aliases: entry.aliases, sense: entry.sense,
        preferred: entry.preferred, forbidden: entry.forbidden, userFixed: entry.origin === 'user_explicit',
      })) }
      job.packet = { operationId: job.internalId, callId: `normal-call:${crypto.randomUUID()}`, model, sourceText: envelope.material.sourceText,
        targetLanguage: envelope.material.targetLanguage, instruction: envelope.material.instruction, context }
      job.metadata = this.adapter.preflightNormal(job.packet)
      job.controller.signal.throwIfAborted()
      job.acceptRequested = true
      const accepted = await this.admit(request, exec, true, envelope)
      job.operation = accepted.operation; job.status = accepted.operation.status
      if (JSON.stringify(accepted.termSnapshot.entries) !== JSON.stringify(terms.termSnapshot.entries)) throw rejected('invalid_reply', '业务受理时术语包与已准备版本不一致。', 'accept')
      queueMicrotask(() => { void this.run(job) })
      return structuredClone(job.operation)
    } catch (error) {
      const unknown = job.acceptRequested && ['outcome_unknown', 'invalid_reply'].includes((error as { code?: string }).code ?? '')
      job.status = unknown ? 'unknown' : job.controller.signal.aborted ? 'cancelled' : 'failed'
      job.error = this.adapter.diagnostic(job.internalId) ?? { code: unknown ? 'OUTCOME_UNKNOWN' : (error as { code?: string }).code ?? 'PREPARE_FAILED',
        message: unknown ? '业务受理回执尚未确认；保留此操作并查询，未派发翻译模型。' : job.status === 'cancelled' ? '普通翻译已在模型调用前取消。' : request.target.kind === 'unit' ? '重译准备未完成，原文及已完成的纠错保留。' : '普通翻译准备未完成，材料保留。', stage: (error as { stage?: string }).stage ?? 'prepare' }
      this.adapter.discard(job.internalId)
      if (job.operation && unknown) this.emit(job, 'unknown', '', null, job.error)
      if (!unknown) this.activeSessions.delete(job.sessionId)
      throw rejected(job.error.code, job.error.message, job.error.stage)
    }
  }
  /** Host foundation used only after the executor has prepared the full call. */
  acceptPrepared(input: NormalTranslationExecute, exec: ToolExecution): Promise<Accepted> { return this.admit(input, exec, false) }
  private admit(input: NormalTranslationExecute, exec: ToolExecution, reserved: boolean, resolved?: Envelope): Promise<Accepted> {
    const request = parseNormalTranslationExecute(input)
    this.owned(request, exec)
    const key = identity(request.target.mainSessionId, request.operationId), signature = JSON.stringify(request), previous = this.admissions.get(key)
    if (previous) {
      if (previous.signature !== signature) throw rejected('idempotency_conflict', '同一业务操作 ID 不能更换材料、版本或要求。', 'accept')
      return previous.result.then(result => structuredClone(result))
    }
    const envelope = resolved ?? this.source(request, exec)
    requireInline(envelope)
    const sessionId = identity(request.target.mainSessionId, envelope.material.translationSessionId)
    if (!reserved && this.activeSessions.has(sessionId)) throw rejected('busy', '此普通翻译会话仍有未结算操作。', 'accept')
    this.activeSessions.add(sessionId)
    const result = Promise.resolve().then(async (): Promise<Accepted> => {
      const value = await this.topics.requestOwned(request.target.mainSessionId, { kind: 'normal_accept', envelope,
        operationId: request.operationId, organizedRequirements: request.organizedRequirements, termReferences: request.termReferences }, exec)
      if (value.kind !== 'normal_operation' || value.operation.operationId !== request.operationId || value.operation.mainSessionId !== request.target.mainSessionId ||
        value.operation.materialId !== envelope.material.materialId || value.operation.sourceVersion !== request.target.sourceVersion ||
        (request.target.kind === 'unit' && value.operation.unitId !== request.target.unitId) ||
        value.operation.translationSessionId !== envelope.material.translationSessionId || value.operation.topicId !== envelope.material.topicId ||
        value.operation.draftVersion !== envelope.material.draftVersion) throw rejected('invalid_reply', '普通翻译业务回执身份不一致。', 'accept')
      this.validateTerms(request, envelope, value.termSnapshot)
      return structuredClone(value)
    }).catch(error => {
      if (!['outcome_unknown', 'invalid_reply'].includes((error as { code?: string }).code ?? '')) this.activeSessions.delete(sessionId)
      throw error
    })
    this.admissions.set(key, { signature, sessionId, result })
    return result.then(value => structuredClone(value))
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
    const key = identity(request.target.mainSessionId, request.operationId), signature = JSON.stringify(request), previous = this.unitRequests.get(key)
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
      agent.followup(helpers.createUserMessage({ content: [{ type: 'text', text: [
        'The user requests retranslation of this explicitly provided translation unit. Call translation_execute with this exact target and operationId; organize relevant requirements/term references first if needed. The program reads authoritative source, original target language and requirements, and the translation session current model. Do not translate in main chat or copy the translation back. No extra confirmation or user action is needed. The editable draft is unrelated and remains unchanged.',
        JSON.stringify(request),
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
  private async run(job: Job): Promise<void> {
    if (!job.operation || !job.packet) return
    let terminal = false, bodyLength = 0
    try {
      if (job.controller.signal.aborted || this.disposed) { this.emit(job, 'cancelled', '', null, { code: 'CANCELLED_BEFORE_DISPATCH', message: '已在模型调用前取消。', stage: 'cancel' }); return }
      for await (const event of this.adapter.executeNormal(job.packet, job.controller.signal, () => {
        job.callId = job.packet!.callId
        this.emit(job, 'running', '', job.metadata)
      })) {
        if (event.type === 'text') {
          bodyLength += event.text.length
          const points = Array.from(event.text)
          for (let offset = 0; offset < points.length; offset += 8192) this.emit(job, 'running', points.slice(offset, offset + 8192).join(''))
        } else if (event.type === 'usage') {
          job.metadata = { ...job.metadata!, usage: { inputTokens: event.input_tokens ?? job.metadata!.usage.inputTokens,
            outputTokens: event.output_tokens ?? job.metadata!.usage.outputTokens } }
        } else {
          terminal = true
          const complete = event.reason === 'stop' && event.provider_state === 'finished' && event.completeness === 'complete' && event.checks_passed && bodyLength > 0
          const status = event.provider_state === 'unknown' ? 'unknown' : event.reason === 'aborted' ? 'cancelled' : complete ? 'completed' : 'failed'
          const error = status === 'completed' ? null : this.adapter.diagnostic(job.internalId) ?? { code: status === 'cancelled' ? 'CANCELLED' : 'INCOMPLETE_RESULT',
            message: status === 'cancelled' ? '普通翻译已取消，已有输出保留。' : '普通译文未完整完成，已有输出保留。', stage: status === 'cancelled' ? 'cancel' : 'stream' }
          job.error = error; this.emit(job, status, '', job.metadata, error)
        }
      }
      if (!terminal) throw rejected('INVALID_STREAM', '模型未提供结束状态。', 'protocol')
    } catch {
      const error = this.adapter.diagnostic(job.internalId) ?? { code: 'OUTCOME_UNKNOWN', message: '模型调用结束状态尚未确认，请查询原操作。', stage: 'stream' }
      job.error = error; this.emit(job, 'unknown', '', job.callId ? job.metadata : null, error)
    } finally {
      this.adapter.discard(job.internalId)
      if (job.status !== 'unknown') this.activeSessions.delete(job.sessionId)
    }
  }
  private scoped(input: NormalTranslationQuery): NormalTranslationResult<Job> {
    const peerId = this.ctx.invocation?.peer.id
    if (!peerId || this.disposed || !this.topics.ownsConnection(input.mainSessionId, peerId)) return bad('scope_mismatch', '普通翻译查询或取消不属于此主会话连接。', 'authorize')
    const job = this.jobs.get(identity(input.mainSessionId, input.operationId))
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
  cancel(input: NormalTranslationQuery): NormalTranslationResult<NormalTranslationJob> {
    const request = parseNormalTranslationQuery(input), found = this.scoped(request)
    if (!found.ok) return found
    const job = found.value
    if (['preparing', 'accepted', 'running', 'unknown'].includes(job.status)) job.controller.abort()
    return this.view(job, request.afterSequence)
  }
  dispose(): void {
    this.disposed = true
    for (const job of this.jobs.values()) { job.controller.abort(); job.delivery.abort(); this.adapter.discard(job.internalId) }
    this.admissions.clear(); this.resolved.clear(); this.corrections.clear(); this.unitRequests.clear(); this.activeSessions.clear()
  }
}
export function installNormalTranslation(ctx: TopicHostContext, loadModule?: LlmModuleLoader, registerRemote = true): NormalTranslationService {
  if (ctx.root && !Object.hasOwn(ctx.root.reflect.props, 'invocation')) ctx.root.accessor('invocation', { get: () => undefined })
  const service = new NormalTranslationService(ctx, loadModule)
  ctx.provide('translationNormal', service)
  if (registerRemote) {
    const register = (scope: TopicHostContext): void => {
      const registry = (scope.get?.('typert') ?? scope.typert) as TopicHostContext['typert']
      registry?.register({ package: NORMAL_TRANSLATION_REMOTE.package, face: 'host', schemas: [], invocations: NORMAL_TRANSLATION_REMOTE.descriptors,
        model: { package: NORMAL_TRANSLATION_REMOTE.package, face: 'host', classes: [], events: [], objects: [] } })
    }
    if (ctx.inject) ctx.inject(['typert'], register)
    else register(ctx)
  }
  ctx.effect?.(() => () => service.dispose(), 'normal translation lifetime')
  return service
}
