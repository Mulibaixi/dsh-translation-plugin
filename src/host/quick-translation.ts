import type { DomainResult, FinalizePlan, RuntimeSession, RuntimeSnapshot, RuntimeTopic } from '../shared/domain-contracts.js'
import { QUICK_TRANSLATION_REMOTE, parseQuickRequest, type QuickTranslationBinding, type QuickTranslationCapability, type QuickTranslationJob, type QuickTranslationOpen, type QuickTranslationQuery, type QuickTranslationSubmit } from '../shared/quick-translation.js'
import { DshTextExecutionAdapter, type DshExecutionContext, type LlmModuleLoader } from './dsh-text-adapter.js'
import { TextTranslationRuntime } from './text-runtime.js'

export interface QuickHostContext extends DshExecutionContext {
  provide(key: string, service: unknown): unknown
  readonly typert?: { register(contribution: unknown): unknown }
  readonly typertGateway?: unknown
  readonly invocation?: { readonly peer: { readonly id: string } }
  readonly root?: { readonly reflect: { readonly props: Record<string, unknown> }; accessor(name: string, descriptor: { get(): undefined }): unknown }
  effect?(callback: () => (() => void), label?: string): unknown
  inject?(names: string[], callback: (ctx: QuickHostContext) => unknown): unknown
}

interface ContextRecord {
  readonly binding: QuickTranslationBinding
  readonly owner: string
  readonly topic: RuntimeTopic
  session: RuntimeSession
  readonly jobs: Map<string, JobRecord>
  active: string | undefined
}
interface JobRecord {
  readonly query: QuickTranslationQuery
  draftVersion: number
  signature: string | undefined
  readonly internalId: string
  readonly controller: AbortController
  accepted: boolean
  preparation: 'preparing' | 'dispatched' | 'failed' | 'cancelled'
  error: QuickTranslationJob['error']
}

function ok<T>(value: T): DomainResult<T> { return { ok: true, value: structuredClone(value) } }
function bad<T>(code: 'invalid_input' | 'not_found' | 'identity_mismatch' | 'idempotency_conflict' | 'execution_unavailable' | 'busy' | 'internal_error', message: string): DomainResult<T> { return { ok: false, error: { code, message } } }
function unwrap<T>(result: DomainResult<T>): T {
  if (!result.ok) throw Object.assign(new Error(result.error.message), { domain: result.error })
  return result.value
}
function signature(request: QuickTranslationSubmit): string {
  return JSON.stringify([request.sessionKey, request.operationId, request.draftVersion, request.sourceText, request.targetLanguage, request.instruction,
    request.model.providerId, request.model.modelId, request.model.configVersion, request.model.reasoningEffort ?? null])
}

/** Operator-scoped, capability-addressed Remote service. No default Agent or writer is used. */
export class QuickTranslationService {
  readonly typertRemote: { readonly service: QuickTranslationService; readonly serviceKey: 'translationQuick'; readonly namespace: 'translationQuick' }
  readonly adapter: DshTextExecutionAdapter
  readonly runtime: TextTranslationRuntime
  private readonly contexts = new Map<string, ContextRecord>()
  private readonly localContexts = new Map<string, string>()
  private disposed = false
  constructor(readonly ctx: QuickHostContext, loadModule?: LlmModuleLoader) {
    // Cordis' documented shared tracker makes this.ctx follow the Gateway invocation Context.
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationQuick', property: 'ctx' } })
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'translationQuick', namespace: 'translationQuick' })
    this.adapter = new DshTextExecutionAdapter(ctx, loadModule)
    this.runtime = new TextTranslationRuntime(this.adapter)
  }

  private owner(): string | undefined {
    // Gateway obtains this admitted operator identity from the transport, never from request JSON.
    const id = this.ctx.invocation?.peer.id
    return typeof id === 'string' && id.length > 0 ? id : undefined
  }
  private context(sessionKey: string): ContextRecord | undefined {
    const value = this.contexts.get(sessionKey)
    return value && value.owner === this.owner() ? value : undefined
  }
  async capabilities(): Promise<DomainResult<QuickTranslationCapability>> {
    const gateway = this.ctx.get ? this.ctx.get('typertGateway') : this.ctx.typertGateway
    const ready = !this.disposed && !!gateway && await this.adapter.ready()
    return ok({ ready, storage: 'runtime_only', mode: 'quick', ...(ready ? {} : { reason: '当前宿主未提供可用的快译运行服务。' }) })
  }
  async open(input: QuickTranslationOpen): Promise<DomainResult<QuickTranslationBinding>> {
    let request: QuickTranslationOpen
    try { request = parseQuickRequest('open', input) as QuickTranslationOpen } catch { return bad('invalid_input', '快译会话参数无效。') }
    const owner = this.owner()
    if (!owner || this.disposed) return bad('identity_mismatch', '快译需要已授权的宿主连接。')
    const local = JSON.stringify([owner, request.localSessionId, request.maxSourceCodePoints])
    const previous = this.localContexts.get(local)
    if (previous) return ok(this.contexts.get(previous)!.binding)
    if (this.contexts.size >= 256) return bad('busy', '运行期快译会话已达到上限，请重新加载插件后继续。')
    const topic = unwrap(this.runtime.createTopic({ operation_id: `open-topic:${crypto.randomUUID()}`, name: 'Quick translation' }))
    const session = unwrap(this.runtime.createSession({ operation_id: `open-session:${crypto.randomUUID()}`, topic_id: topic.topic_id,
      expected_topic_version: topic.topic_version, mode: 'quick', max_source_code_points: request.maxSourceCodePoints }))
    const binding = { sessionKey: `quick:${crypto.randomUUID()}`, ...request }
    this.contexts.set(binding.sessionKey, { binding, owner, topic, session, jobs: new Map(), active: undefined })
    this.localContexts.set(local, binding.sessionKey)
    return ok(binding)
  }

  async submit(input: QuickTranslationSubmit): Promise<DomainResult<QuickTranslationJob>> {
    let request: QuickTranslationSubmit
    try { request = parseQuickRequest('submit', input) as QuickTranslationSubmit } catch { return bad('invalid_input', '快译请求参数无效。') }
    const context = this.context(request.sessionKey)
    if (!context || this.disposed) return bad('not_found', '快译运行期会话已失效，请重新打开会话。')
    const prior = context.jobs.get(request.operationId)
    if (prior) {
      if (prior.signature !== undefined && prior.signature !== signature(request)) return bad('idempotency_conflict', '同一请求编号不能提交不同原文或设置。')
      if (prior.signature === undefined) {
        // A cancellation can arrive before its submit carrier. Bind the first late request without dispatching it.
        prior.signature = signature(request)
        prior.draftVersion = request.draftVersion
      }
      return ok(this.view(context, prior))
    }
    this.refreshActive(context)
    if (context.active) return bad('busy', '当前快译尚未结算，请等待完成或取消确认。')
    if (Array.from(request.sourceText).length > context.binding.maxSourceCodePoints) return bad('invalid_input', '原文超过当前会话的单次上限。')
    if (context.jobs.size >= 500) return bad('busy', '运行期请求已达到上限，请重新加载插件后继续。')
    const job: JobRecord = {
      query: { sessionKey: request.sessionKey, operationId: request.operationId }, draftVersion: request.draftVersion,
      signature: signature(request), internalId: `quick-operation:${crypto.randomUUID()}`, controller: new AbortController(),
      accepted: false, preparation: 'preparing', error: undefined,
    }
    context.jobs.set(request.operationId, job)
    context.active = request.operationId
    // Claim the operation before any async preparation so duplicate calls cannot send twice.
    try {
      await this.adapter.prepareOperation(job.internalId, request.model, job.controller.signal)
      if (job.controller.signal.aborted || this.disposed) { job.preparation = 'cancelled'; return ok(this.view(context, job)) }
      const before = unwrap(this.runtime.getSnapshot({ translation_session_id: context.session.translation_session_id }))
      const material = unwrap(this.runtime.receive({
        operation_id: job.internalId, topic_id: context.topic.topic_id, translation_session_id: context.session.translation_session_id,
        trigger: 'quick_send', expected_session_version: before.session.session_version, draft_version: request.draftVersion,
        source_text: request.sourceText, instruction: request.instruction, target_language: request.targetLanguage,
        task_type: 'translation', model: request.model, max_attempts: 1,
      }))
      const accepted = unwrap(this.runtime.accept({ operation_id: job.internalId, expected_operation_version: material.operation_version,
        expected_session_version: before.session.session_version, ...this.advance(before) }))
      job.accepted = true
      context.session = { ...before.session, session_version: accepted.session_version }
      const prepared = unwrap(this.runtime.prepare({ operation_id: job.internalId, expected_operation_version: accepted.operation_version }))
      unwrap(this.runtime.dispatch({ operation_id: job.internalId, attempt_request_id: `quick-dispatch:${crypto.randomUUID()}`,
        expected_preparation_version: prepared.preparation_version, reason: 'initial' }))
      job.preparation = 'dispatched'
    } catch {
      job.preparation = job.controller.signal.aborted || this.disposed ? 'cancelled' : 'failed'
      if (job.preparation === 'failed') job.error = this.adapter.diagnostic(job.internalId) ?? { code: 'EXECUTION_FAILED', message: '快译准备失败，请检查模型配置后重试。', stage: 'prepare' }
      this.adapter.discard(job.internalId)
    } finally {
      this.refreshActive(context)
    }
    return ok(this.view(context, job))
  }

  private advance(snapshot: RuntimeSnapshot): { advance?: FinalizePlan } {
    const previous = snapshot.units.at(-1)
    if (!previous) return {}
    const latest = snapshot.revisions.filter(revision => revision.unit_id === previous.unit_id).at(-1)
    const basis = { unit_id: previous.unit_id, unit_version: previous.unit_version, source_version: previous.source_version,
      instruction_version: previous.instruction_version, final_pointer_version: previous.final_pointer_version }
    if (previous.final_pointer?.selection === 'user_fixed') return { advance: { ...basis, action: 'keep_final', revision_id: previous.final_pointer.revision_id } }
    if (latest?.completeness === 'complete' && latest.checks_passed && !latest.late) return { advance: { ...basis, action: 'automatic', revision_id: latest.revision_id } }
    return { advance: { ...basis, action: 'keep_unfinished' } }
  }

  async status(input: QuickTranslationQuery): Promise<DomainResult<QuickTranslationJob>> {
    let request: QuickTranslationQuery
    try { request = parseQuickRequest('status', input) as QuickTranslationQuery } catch { return bad('invalid_input', '快译查询参数无效。') }
    const context = this.context(request.sessionKey)
    const job = context?.jobs.get(request.operationId)
    if (!context || !job) return bad('not_found', '未找到该运行期请求；请保留原文，勿自动重新发送。')
    this.refreshActive(context)
    return ok(this.view(context, job))
  }
  async cancel(input: QuickTranslationQuery): Promise<DomainResult<QuickTranslationJob>> {
    let request: QuickTranslationQuery
    try { request = parseQuickRequest('cancel', input) as QuickTranslationQuery } catch { return bad('invalid_input', '快译取消参数无效。') }
    const context = this.context(request.sessionKey)
    if (!context) return bad('not_found', '快译运行期会话已失效。')
    let job = context.jobs.get(request.operationId)
    if (!job) {
      if (context.jobs.size >= 500) return bad('busy', '运行期请求已达到上限。')
      // Keep the cancellation tombstone even if the submit carrier arrives later.
      job = { query: request, draftVersion: 0, signature: undefined, internalId: `quick-cancel:${crypto.randomUUID()}`,
        controller: new AbortController(), accepted: false, preparation: 'cancelled', error: undefined }
      context.jobs.set(request.operationId, job)
    }
    job.controller.abort()
    if (job.preparation === 'dispatched') {
      const operation = this.runtime.inspect({ operation_id: job.internalId })
      const attemptId = operation.ok ? operation.value.attempt_ids.at(-1) : undefined
      if (attemptId) this.runtime.cancel({ attempt_id: attemptId })
    } else if (job.preparation === 'preparing') job.preparation = 'cancelled'
    this.refreshActive(context)
    return ok(this.view(context, job))
  }

  private view(context: ContextRecord, job: JobRecord): QuickTranslationJob {
    const base = { ...job.query, draftVersion: job.draftVersion, accepted: job.accepted, text: '' }
    if (job.preparation !== 'dispatched') return { ...base, status: job.preparation === 'preparing' ? 'running' : job.preparation, ...(job.error ? { error: job.error } : {}) }
    const snapshot = this.runtime.getSnapshot({ translation_session_id: context.session.translation_session_id })
    if (!snapshot.ok) return { ...base, status: 'unknown', error: { code: 'STATE_UNAVAILABLE', message: '请求状态暂时无法确认，请勿自动重新发送。', stage: 'observe' } }
    const attempt = snapshot.value.attempts.filter(value => value.operation_id === job.internalId).at(-1)
    if (!attempt) return { ...base, status: 'unknown' }
    const revision = snapshot.value.revisions.find(value => value.revision_id === attempt.revision_id)
    const content = revision ? this.runtime.readContent({ topic_id: context.topic.topic_id, content_ref: revision.content_ref }) : undefined
    const state = attempt.status === 'queued' ? 'running' : attempt.status === 'interrupted' ? 'unknown' : attempt.status
    const diagnostic = this.adapter.diagnostic(job.internalId)
    return { ...base, status: state, text: content?.ok ? content.value : '',
      ...(['failed', 'unknown'].includes(state) ? { error: diagnostic ?? { code: state === 'unknown' ? 'OUTCOME_UNKNOWN' : 'INCOMPLETE_RESULT',
        message: state === 'unknown' ? '请求尚未确认结算，请勿自动重新发送。' : '译文未完整完成，请检查模型设置。', stage: attempt.failure_stage ?? 'stream' } } : {}) }
  }
  private refreshActive(context: ContextRecord): void {
    if (!context.active) return
    const job = context.jobs.get(context.active)
    if (!job || !['running', 'unknown'].includes(this.view(context, job).status)) context.active = undefined
  }
  dispose(): void {
    this.disposed = true
    for (const context of this.contexts.values()) for (const job of context.jobs.values()) {
      job.controller.abort(); this.adapter.discard(job.internalId)
      if (job.preparation === 'dispatched') {
        const operation = this.runtime.inspect({ operation_id: job.internalId })
        if (operation.ok) for (const attemptId of operation.value.attempt_ids) this.runtime.cancel({ attempt_id: attemptId })
      }
    }
  }
}

export function installQuickTranslation(ctx: QuickHostContext, loadModule?: LlmModuleLoader): QuickTranslationService | undefined {
  if (!ctx.root || !ctx.effect) return undefined
  // This is the same invocation accessor admitted by bindTypertRemote in the native protocol.
  if (!Object.hasOwn(ctx.root.reflect.props, 'invocation')) ctx.root.accessor('invocation', { get: () => undefined })
  const service = new QuickTranslationService(ctx, loadModule)
  ctx.provide('translationQuick', service)
  const register = (typeCtx: QuickHostContext): void => {
    const registry = typeCtx.get ? typeCtx.get('typert') as QuickHostContext['typert'] : typeCtx.typert
    registry?.register({ package: QUICK_TRANSLATION_REMOTE.package, face: 'host', schemas: [],
      invocations: QUICK_TRANSLATION_REMOTE.descriptors, model: { package: QUICK_TRANSLATION_REMOTE.package, face: 'host', classes: [], events: [], objects: [] } })
  }
  if (ctx.inject) ctx.inject(['typert'], register)
  else register(ctx)
  ctx.effect(() => () => service.dispose(), 'translationQuick runtime lifetime')
  return service
}
