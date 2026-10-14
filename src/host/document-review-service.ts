import { parseDocumentReviewBeginRequest, parseDocumentReviewSubmitRequest, parseDocumentReviewQueryRequest, parseDocumentReviewTarget, parseDocumentManualRevisionRequest,
  type DocumentReviewTarget, type DocumentReviewReceipt } from '../shared/document-review.js'
import { parseDocumentReviewPageRequest, parseDocumentReviewRead, type DocumentReviewPage } from '../shared/document-review-bridge.js'
import type { AnalysisResult } from '../shared/translation-preparation.js'
import type { TranslationSourceScope } from '../shared/translation-sources.js'
import type { TopicHostContext, TopicToolsService, ToolExecution } from './topic-tools.js'
import type { DocumentExecutionService } from './document-execution-service.js'

function failure(code: string, message: string): AnalysisResult<never> { return { ok: false, error: { code, message, stage: 'review_document' } } }
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
export class DocumentReviewService {
  readonly typertRemote: { readonly service: DocumentReviewService; readonly serviceKey: 'translationReview'; readonly namespace: 'translationReview' }
  private readonly begun = new Map<string, { readonly target: DocumentReviewTarget; readonly auditId: string; readonly agent: ToolExecution['agent'] }>()
  constructor(readonly ctx: TopicHostContext) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationReview', property: 'ctx' } })
    this.typertRemote = Object.freeze({ service: this, serviceKey: 'translationReview', namespace: 'translationReview' })
  }
  private get topics(): TopicToolsService { return this.ctx.get?.('translationTopics') as TopicToolsService }
  private get batch(): DocumentExecutionService { return this.ctx.get?.('translationBatch') as DocumentExecutionService }
  private execution(scope: TranslationSourceScope, exec?: ToolExecution): ToolExecution | null {
    if (exec) return this.topics.ownsAgent(scope.mainSessionId, exec.agent) ? exec : null
    const peerId = this.ctx.invocation?.peer.id
    if (!peerId || !this.topics.ownsConnection(scope.mainSessionId, peerId)) return null
    const agent = this.topics.ownerAgent(scope.mainSessionId, peerId)
    return agent && this.topics.ownsAgent(scope.mainSessionId, agent) ? { agent, callId: `document-review:${crypto.randomUUID()}`, signal: new AbortController().signal } : null
  }
  async page(args: unknown, exec: ToolExecution): Promise<AnalysisResult<DocumentReviewPage>> {
    try {
      const request = parseDocumentReviewPageRequest(args)
      if (!this.execution(request.scope, exec)) return failure('scope_mismatch', '复核读取不属于实际主 Agent。')
      const reply = await this.topics.requestOwned(request.scope.mainSessionId, { kind: 'document_review_page', request }, exec)
      if (reply.kind !== 'document_review_page') return failure('invalid_reply', '未收到准确候选复核页。')
      if (!same(reply.page.target.scope, request.scope) || reply.page.target.unitId !== request.unitId || reply.page.target.sourceVersion !== request.sourceVersion || request.manifestRevisionId && reply.page.target.manifestRevisionId !== request.manifestRevisionId) return failure('invalid_reply', '候选复核页身份不一致。')
      if (reply.page.summary.beginAuditId) this.begun.set(reply.page.summary.beginAuditId, { target: reply.page.target, auditId: reply.page.summary.beginAuditId, agent: exec.agent })
      return { ok: true, value: reply.page }
    } catch (error) { const known = error as { code?: string; message?: string }; return failure(known.code ?? 'review_read_failed', known.message ?? '复核页读取失败。') }
  }
  async read(args: unknown, exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    try {
      const request = parseDocumentReviewRead(args)
      if (!this.execution(request.target.scope, exec)) return failure('scope_mismatch', '复核正文读取不属于实际主 Agent。')
      const reply = await this.topics.requestOwned(request.target.scope.mainSessionId, { kind: 'document_review_read', request }, exec)
      if (reply.kind !== 'document_review_text' || !same(reply.page.target, request.target) || reply.page.side !== request.side || reply.page.revisionId !== request.revisionId || !same(reply.page.range, request.range)) return failure('invalid_reply', '复核正文页身份不一致。')
      return { ok: true, value: reply.page }
    } catch (error) { const known = error as { code?: string; message?: string }; return failure(known.code ?? 'review_read_failed', known.message ?? '准确复核正文页读取失败。') }
  }
  async begin(args: unknown, exec: ToolExecution): Promise<AnalysisResult<DocumentReviewReceipt>> {
    try {
      const request = parseDocumentReviewBeginRequest(args)
      if (!this.execution(request.target.scope, exec)) return failure('scope_mismatch', '复核不属于实际主 Agent。')
      const reply = await this.topics.requestOwned(request.target.scope.mainSessionId, { kind: 'document_review_begin', request }, exec)
      if (reply.kind !== 'document_review_receipt' || !same(reply.receipt.target, request.target) || reply.receipt.operationId !== request.operationId || !reply.receipt.audit) return failure('invalid_reply', '机械复核回执未知；请查询原操作。')
      this.begun.set(reply.receipt.audit.id, { target: request.target, auditId: reply.receipt.audit.id, agent: exec.agent })
      return { ok: true, value: reply.receipt }
    } catch (error) { const known = error as { code?: string; message?: string }; return failure(known.code ?? 'review_write_failed', known.message ?? '机械复核未确认；请查询原操作，不能重派。') }
  }
  async submit(args: unknown, exec: ToolExecution): Promise<AnalysisResult<DocumentReviewReceipt>> {
    try {
      const request = parseDocumentReviewSubmitRequest(args)
      if (!this.execution(request.target.scope, exec)) return failure('scope_mismatch', '语义复核提交不属于实际主 Agent。')
      const begun = this.begun.get(request.beginAuditId)
      if (!begun || begun.agent !== exec.agent || !same(begun.target, request.target)) return failure('mechanical_review_required', '先读取并确认此精确候选的实际机械检查。')
      const reply = await this.topics.requestOwned(request.target.scope.mainSessionId, { kind: 'document_review_submit', request }, exec)
      if (reply.kind !== 'document_review_receipt' || !same(reply.receipt.target, request.target) || reply.receipt.operationId !== request.operationId) return failure('invalid_reply', '语义复核写回未知；请查询原操作。')
      return { ok: true, value: reply.receipt }
    } catch (error) { const known = error as { code?: string; message?: string }; return failure(known.code ?? 'review_write_failed', known.message ?? '语义复核未确认；请查询原操作，不能重派。') }
  }
  async observe(args: unknown, exec: ToolExecution): Promise<AnalysisResult<DocumentReviewReceipt | null>> {
    try {
      const request = parseDocumentReviewQueryRequest(args)
      if (!this.execution(request.target.scope, exec)) return failure('scope_mismatch', '原复核查询不属于实际主 Agent。')
      const reply = await this.topics.requestOwned(request.target.scope.mainSessionId, { kind: 'document_review_observe', request }, exec)
      if (reply.kind !== 'document_review_observed') return failure('invalid_reply', '原复核操作查询回执无效。')
      if (reply.receipt?.audit?.semanticStatus === 'pending') this.begun.set(reply.receipt.audit.id, { target: request.target, auditId: reply.receipt.audit.id, agent: exec.agent })
      return { ok: true, value: reply.receipt }
    } catch (error) { const known = error as { code?: string; message?: string }; return failure(known.code ?? 'review_query_failed', known.message ?? '原复核操作查询失败。') }
  }
  async completed(scope: TranslationSourceScope, unitId: string, sourceVersion: number, exec: ToolExecution): Promise<string> {
    const page = await this.page({ scope, unitId, sourceVersion }, exec)
    if (!page.ok) return 'unavailable'
    if (!page.value.summary.beginAuditId) {
      const result = await this.begin({ target: page.value.target, operationId: `document-mechanical:${page.value.target.manifestRevisionId}`, expectedReviewVersion: page.value.reviewVersion }, exec)
      if (!result.ok) return 'unavailable'
    }
    return this.batch.notifyReviewCandidate(page.value.target, exec)
  }
  async notificationCurrent(target: DocumentReviewTarget, expectedReviewVersion: number, exec: ToolExecution): Promise<boolean> {
    const page = await this.page({ scope: target.scope, unitId: target.unitId, sourceVersion: target.sourceVersion }, exec)
    return page.ok && same(page.value.target, target) && page.value.reviewVersion === expectedReviewVersion && page.value.summary.semanticStatus === 'pending'
  }
  async notify(args: unknown): Promise<AnalysisResult<{ readonly state: string }>> {
    try {
      if (!args || typeof args !== 'object' || Object.keys(args).length !== 1 || !('target' in args)) return failure('invalid_input', '新候选通知参数无效。')
      const target = parseDocumentReviewTarget(args.target), exec = this.execution(target.scope)
      if (!exec) return failure('scope_mismatch', '候选通知不属于当前负责人连接。')
      const page = await this.page({ scope: target.scope, unitId: target.unitId, sourceVersion: target.sourceVersion, manifestRevisionId: target.manifestRevisionId }, exec)
      if (!page.ok) return page
      if (!page.value.summary.beginAuditId) {
        const checked = await this.begin({ target, operationId: `document-mechanical:${target.manifestRevisionId}`, expectedReviewVersion: page.value.reviewVersion }, exec)
        if (!checked.ok) return checked
      }
      const state = await this.batch.notifyReviewCandidate(target, exec)
      if (['enqueued', 'claimed'].includes(state)) await exec.agent?.whenIdle?.()
      return { ok: true, value: { state } }
    } catch (error) { const known = error as { code?: string; message?: string }; return failure(known.code ?? 'notification_failed', known.message ?? '新候选通知未确认。') }
  }
  async revise(args: unknown, exec: ToolExecution): Promise<AnalysisResult<DocumentReviewReceipt>> {
    try {
      const request = parseDocumentManualRevisionRequest(args)
      if (!this.execution(request.target.scope, exec)) return failure('scope_mismatch', '局部审阅修订不属于实际主 Agent。')
      const reply = await this.topics.requestOwned(request.target.scope.mainSessionId, { kind: 'document_review_manual', request }, exec)
      if (reply.kind !== 'document_review_receipt' || !same(reply.receipt.target, request.target) || reply.receipt.operationId !== request.operationId) return failure('invalid_reply', '局部修订写回未知；请查询原操作。')
      const target = { ...request.target, manifestRevisionId: reply.receipt.manifestRevisionId }
      await this.completed(target.scope, target.unitId, target.sourceVersion, exec)
      return { ok: true, value: reply.receipt }
    } catch (error) { const known = error as { code?: string; message?: string }; return failure(known.code ?? 'revision_failed', known.message ?? '局部修订未确认。') }
  }
}
export function installDocumentReview(ctx: TopicHostContext): DocumentReviewService { const service = new DocumentReviewService(ctx); ctx.provide('translationReview', service); return service }
