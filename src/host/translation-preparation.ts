import {
  parseTranslationPreparationPrepare, parseTranslationPreparationSet, parseTranslationPreparationQuery, parseTranslationPreparationRead,
  parseTranslationPreparationCorrectionReview,
  type AnalysisResult, type TranslationPreparationPrepare, type TranslationPreparationSet,
  type PreparationCorrectionReviewFacts,
} from '../shared/translation-preparation.js'
import type { TranslationMaterialEnvelope } from '../shared/translation-material.js'
import { MAX_TOPIC_BRIDGE_REPLY_BYTES, type TopicBridgeCommand, type TopicBridgeValue } from '../shared/topic-bridge.js'
import type { TopicHostContext, TopicToolsService, ToolExecution } from './topic-tools.js'
import type { TranslationMaterialsService } from './translation-materials.js'
import type { TerminologyAnalysisService } from './terminology-analysis.js'
import type { DocumentCorrectionService } from './document-correction-service.js'
import type { ReferenceFilesService } from './reference-files.js'

type Envelope = Extract<TranslationMaterialEnvelope, { kind: 'material' }>
function failure(code: string, message: string, stage: string): AnalysisResult<never> { return { ok: false, error: { code, message, stage } } }

/** Host proves delivered material and analysis; the sole Client bridge commits preparations. */
export class TranslationPreparationService {
  private disposed = false
  constructor(readonly ctx: TopicHostContext) {}
  private get topics(): TopicToolsService | undefined { return this.ctx.get?.('translationTopics') as TopicToolsService | undefined }
  private authorized(ownerId: string, exec: ToolExecution): AnalysisResult<true> {
    if (this.disposed || !this.topics?.ownsAgent(ownerId, exec.agent)) return failure('scope_mismatch', '准备操作不属于已连接的实际主 Agent。', 'authorize_preparation')
    if ((this.topics.protocolFor(ownerId) ?? 0) < 2) return failure('preparation_unavailable', '准备记录需要当前唯一主题桥的 v2 或更新连接。', 'authorize_preparation')
    exec.signal.throwIfAborted()
    return { ok: true, value: true }
  }
  private material(request: TranslationPreparationPrepare | TranslationPreparationSet, exec: ToolExecution): AnalysisResult<Envelope> {
    const authorization = this.authorized(request.target.mainSessionId, exec)
    if (!authorization.ok) return authorization
    const materials = this.ctx.get?.('translationMaterials') as TranslationMaterialsService | undefined
    return materials?.deliveredForAgent(request.target, exec.agent!) ?? failure('unavailable', '固定材料服务尚未就绪。', 'authorize_preparation')
  }
  private async request(ownerId: string, command: TopicBridgeCommand, expected: TopicBridgeValue['kind'], exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    try {
      if (new TextEncoder().encode(JSON.stringify({ kind: 'request', requestId: 'x'.repeat(36), mainSessionId: ownerId, callId: exec.callId, command })).byteLength > MAX_TOPIC_BRIDGE_REPLY_BYTES) return failure('request_too_large', '完整准备传输包超过 196608 字节，请调整分析或任务范围；候选未截断、准备未登记。', 'preparation_budget')
      const value = await this.topics!.requestOwned(ownerId, command, exec)
      if (value.kind !== expected) return failure('invalid_reply', '准备记录回执类型不一致。', 'preparation_bridge')
      if (command.kind === 'preparation_prepare' || command.kind === 'preparation_set' || command.kind === 'preparation_review_correction' || command.kind === 'preparation_status' || command.kind === 'preparation_read') {
        const response = value.kind === 'preparation_receipt' ? value.receipt : value.kind === 'preparation_page' ? value.page : undefined
        if (!response || response.preparationId !== command.request.preparationId || JSON.stringify(response.target) !== JSON.stringify(command.request.target)) return failure('invalid_reply', '准备回执与请求的固定材料或标识不一致。', 'preparation_bridge')
        const version = command.kind === 'preparation_prepare' ? 1 : command.kind === 'preparation_set' || command.kind === 'preparation_review_correction' ? command.request.expectedVersion + 1 : command.request.version
        if (response.version !== version) return failure('invalid_reply', '准备回执版本与明确操作不一致。', 'preparation_bridge')
        if ('scope' in response && (response.scope.ownerId !== ownerId || response.scope.mainSessionId !== ownerId || response.sourceVersion !== command.request.target.sourceVersion)) return failure('invalid_reply', '准备回执所属会话或源版本不一致。', 'preparation_bridge')
        if (command.kind === 'preparation_read' && 'section' in response && response.section !== command.request.section) return failure('invalid_reply', '准备分页区段与请求不一致。', 'preparation_bridge')
      }
      return { ok: true, value: 'receipt' in value ? value.receipt : 'page' in value ? value.page : value }
    } catch (error) {
      const known = error as { readonly code?: string; readonly message?: string }
      return failure(known.code ?? 'bridge_failed', known.message ?? '准备记录操作未确认，请查询原准备版本。', 'preparation_bridge')
    }
  }
  async prepare(args: unknown, exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    let request: TranslationPreparationPrepare
    try { request = parseTranslationPreparationPrepare(args) } catch { return failure('invalid_input', '准备创建参数无效。', 'prepare_preparation') }
    const material = this.material(request, exec)
    if (!material.ok) return material
    const analysis = this.ctx.get?.('translationAnalysis') as TerminologyAnalysisService | undefined
    const facts = analysis?.preparationFacts({ target: request.target, analysisId: request.analysisId, version: request.analysisVersion }, exec)
    if (!facts) return failure('unavailable', '真实术语分析服务尚未就绪。', 'prepare_preparation')
    if (!facts.ok) return facts
    return this.request(request.target.mainSessionId, { kind: 'preparation_prepare', request, envelope: material.value, analysis: facts.value }, 'preparation_receipt', exec)
  }
  async set(args: unknown, exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    let request: TranslationPreparationSet
    try { request = parseTranslationPreparationSet(args) } catch { return failure('invalid_input', '准备采用参数无效。', 'set_preparation') }
    const material = this.material(request, exec)
    if (!material.ok) return material
    if (request.referenceContextRef) {
      try {
        const references = this.ctx.get?.('translationReferences') as ReferenceFilesService | undefined
        if (!references) return failure('reference_unavailable', '参考资料服务尚未就绪。', 'set_preparation')
        await references.resolveContext(material.value.ownerId, material.value.material.topicId, request.referenceContextRef, exec)
      } catch(error) { return failure((error as {code?:string}).code ?? 'reference_unavailable', (error as Error).message, 'set_preparation') }
    }
    return this.request(request.target.mainSessionId, { kind: 'preparation_set', request, envelope: material.value }, 'preparation_receipt', exec)
  }
  async status(args: unknown, exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    let request: ReturnType<typeof parseTranslationPreparationQuery>
    try { request = parseTranslationPreparationQuery(args) } catch { return failure('invalid_input', '准备状态查询参数无效。', 'status_preparation') }
    const authorized = this.authorized(request.target.mainSessionId, exec)
    if (!authorized.ok) return authorized
    return this.request(request.target.mainSessionId, { kind: 'preparation_status', request }, 'preparation_receipt', exec)
  }
  async reviewCorrection(args: unknown, exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    let request: ReturnType<typeof parseTranslationPreparationCorrectionReview>
    try { request = parseTranslationPreparationCorrectionReview(args) } catch { return failure('invalid_input', '纠错准备复核参数无效。', 'review_correction_preparation') }
    const authorization = this.authorized(request.target.mainSessionId, exec)
    if (!authorization.ok) return authorization
    const correction = this.ctx.get?.('translationCorrection') as DocumentCorrectionService | undefined
    if (!correction) return failure('unavailable', '准确单元原稿服务尚未就绪。', 'review_correction_preparation')
    const captured = await correction.captureUnit(request.target, { id: request.preparationId, version: request.expectedVersion }, exec)
    if (!captured.ok) return captured
    const { capture, text: sourceText } = captured.value, previous = capture.preparation
    if (capture.currentSourceVersion !== request.target.sourceVersion || !previous || capture.source.operationId === null || !capture.corrections.some(fact => fact.operationId === capture.source.operationId && fact.toSourceVersion === capture.source.version)) return failure('source_mismatch', '复核需要当前纠错源及其真实准备和纠错事实。', 'review_correction_preparation')
    try {
      const reference = request.referenceContextRef ?? previous.referenceContextRef
      if (reference) {
        const references = this.ctx.get?.('translationReferences') as ReferenceFilesService | undefined
        if (!references) return failure('reference_unavailable', '参考资料服务尚未就绪。', 'review_correction_preparation')
        await references.resolveContext(capture.scope.ownerId, capture.scope.topicId, reference, exec)
      }
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceText).buffer)), hash = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('')
      const total = Array.from(sourceText).length
      if (capture.source.body.kind === 'asset' && (capture.source.body.reference.sha256 !== hash || capture.source.body.reference.totalCodePoints !== total)) return failure('source_mismatch', '实际读到的纠错原稿与固定身份不一致。', 'review_correction_preparation')
      const reply = await this.topics!.requestOwned(request.target.mainSessionId, { kind: 'list_terms', translationSessionId: request.target.translationSessionId }, exec)
      if (reply.kind !== 'terms' || reply.snapshot.ownerId !== capture.scope.ownerId || reply.snapshot.topicId !== capture.scope.topicId) return failure('invalid_reply', '当前主题词不属于此单元。', 'review_correction_preparation')
      const points = Array.from(sourceText), termMatches = request.termSelections.map(selected => {
        const selectedRef = selected.ref
        const forms = selectedRef.kind === 'candidate'
          ? previous.terms.find(term => term.ref.kind === 'candidate' && (term.ref.id === selectedRef.id || term.candidateRefs.some(ref => ref.id === selectedRef.id)))?.sourceForms
          : reply.snapshot.entries.find(entry => entry.id === selectedRef.id && entry.version === selectedRef.entryVersion)?.sourceForms
        const aliases = selectedRef.kind === 'topic_term' ? reply.snapshot.entries.find(entry => entry.id === selectedRef.id && entry.version === selectedRef.entryVersion)?.aliases ?? [] : []
        return { ref: selectedRef, matched: !!forms?.length && selected.ranges.every(range => range.end <= total && [...forms, ...aliases].some(form => points.slice(range.start, range.end).join('').includes(form))) }
      })
      const required = (start: number, end: number): boolean => !(request.excludedRanges ?? []).some(range => range.start <= start && range.end >= end)
      const relevantFixedIds = reply.snapshot.entries.filter(entry => entry.status === 'active' && entry.targetLanguage === previous.targetLanguage && entry.origin === 'user_explicit' && entry.confirmation !== null && entry.confirmation.adoptedEntryVersion < entry.version && [...entry.sourceForms, ...entry.aliases].some(form => {
        let offset = sourceText.indexOf(form)
        while (offset >= 0) { const start = Array.from(sourceText.slice(0, offset)).length; if (required(start, start + Array.from(form).length)) return true; offset = sourceText.indexOf(form, offset + 1) }
        return false
      })).map(entry => entry.id)
      const facts: PreparationCorrectionReviewFacts = { scope: capture.scope, unitId: capture.unitId, sourceVersion: capture.source.version, sourceSha256: hash, totalCodePoints: total,
        correctionOperationId: capture.source.operationId, analysisActualCalls: previous.correctionReview?.analysisBasis.actualCalls ?? [...capture.tasks].reverse().find(task => task.baseline)?.baseline?.analysisActualCalls ?? null,
        topicTerms: reply.snapshot, termMatches, relevantFixedIds }
      return this.request(request.target.mainSessionId, { kind: 'preparation_review_correction', request, facts }, 'preparation_receipt', exec)
    } catch (error) { const known = error as { code?: string; message?: string }; return failure(known.code ?? 'review_failed', known.message ?? '纠错准备复核未确认。', 'review_correction_preparation') }
  }
  async read(args: unknown, exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    let request: ReturnType<typeof parseTranslationPreparationRead>
    try { request = parseTranslationPreparationRead(args) } catch { return failure('invalid_input', '准备分页查询参数无效。', 'read_preparation') }
    const authorized = this.authorized(request.target.mainSessionId, exec)
    if (!authorized.ok) return authorized
    return this.request(request.target.mainSessionId, { kind: 'preparation_read', request }, 'preparation_page', exec)
  }
  dispose(): void { this.disposed = true }
}

export function installTranslationPreparation(ctx: TopicHostContext): TranslationPreparationService {
  const service = new TranslationPreparationService(ctx)
  ctx.provide('translationPreparation', service)
  ctx.effect?.(() => () => service.dispose(), 'translation preparation lifetime')
  return service
}
