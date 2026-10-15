import type { ReferenceFilesService } from './reference-files.js'
import {
  parseTranslationPlanSuggest, parseTranslationPlanSet, parseTranslationPlanQuery, parseTranslationPlanRead,
  documentPlanningBytes, MAX_DOCUMENT_PLAN_PAGE_BYTES, type TranslationPlanSuggest, type TranslationPlanSet,
  type TranslationPlanQuery, type TranslationPlanRead,
} from '../shared/document-planning.js'
import type { NormalTranslationMaterialTarget, NormalTranslationTarget } from '../shared/normal-translation.js'
import type { DocumentCorrectionService } from './document-correction-service.js'
import type { TranslationMaterialEnvelope } from '../shared/translation-material.js'
import type { AnalysisResult } from '../shared/translation-preparation.js'
import { MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, sourceCodePointLength } from '../shared/translation-source-read.js'
import { DocumentPlanner, type DocumentPlanningInput, type DocumentExecutionFreeze } from './document-planner.js'
import type { VersionReference } from '../shared/translation-batch.js'
import { DshTextExecutionAdapter } from './dsh-text-adapter.js'
import type { TopicHostContext, TopicToolsService, ToolExecution } from './topic-tools.js'
import type { TranslationMaterialsService } from './translation-materials.js'
import type { TerminologyAnalysisService } from './terminology-analysis.js'

type Envelope = Extract<TranslationMaterialEnvelope, { kind: 'material' }>
function failure(code: string, message: string, stage: string): AnalysisResult<never> { return { ok: false, error: { code, message, stage } } }
function rejection(code: string, message: string, stage: string): Error { return Object.assign(new Error(message), { code, stage }) }

/** Actual Agent/material authorization surrounds the pure, runtime-only planner. */
export class DocumentPlanningService {
  readonly planner: DocumentPlanner
  private disposed = false
  constructor(readonly ctx: TopicHostContext) { this.planner = new DocumentPlanner(new DshTextExecutionAdapter(ctx)) }
  private get topics(): TopicToolsService | undefined { return this.ctx.get?.('translationTopics') as TopicToolsService | undefined }
  private get materials(): TranslationMaterialsService | undefined { return this.ctx.get?.('translationMaterials') as TranslationMaterialsService | undefined }
  private material(target: NormalTranslationMaterialTarget, exec: ToolExecution): AnalysisResult<Envelope> {
    if (this.disposed || !this.topics?.ownsAgent(target.mainSessionId, exec.agent)) return failure('scope_mismatch', '规划不属于已连接的实际主 Agent。', 'authorize_plan')
    if ((this.topics.protocolFor(target.mainSessionId) ?? 0) < 2) return failure('planning_unavailable', '规划需要当前唯一主题桥的 v2 连接。', 'authorize_plan')
    exec.signal.throwIfAborted()
    return this.materials?.deliveredForAgent(target, exec.agent!) ?? failure('unavailable', '固定材料服务尚未就绪。', 'authorize_plan')
  }
  private async baseInput(request: Pick<TranslationPlanSuggest, 'target' | 'preparationRef'>, exec: ToolExecution): Promise<AnalysisResult<DocumentPlanningInput>> {
    if (request.target.kind === 'unit') {
      const correction = this.ctx.get?.('translationCorrection') as DocumentCorrectionService
      const captured = await correction.captureUnit(request.target, request.preparationRef, exec, { requireReady: true })
      if (!captured.ok) return captured
      const { capture, readSource, text } = captured.value
      let preparation = capture.preparation!
      const baseline = [...capture.tasks].reverse().find(task => task.baseline)?.baseline
      if (capture.currentSourceVersion !== request.target.sourceVersion || !preparation || !baseline) return failure('preparation_not_ready', '当前原稿的准备复核或真实执行基线缺失。', 'capture_preparation')
      const terms = await this.topics!.requestOwned(request.target.mainSessionId, { kind: 'list_terms', translationSessionId: request.target.translationSessionId }, exec)
      if (terms.kind !== 'terms' || terms.snapshot.topicId !== capture.scope.topicId) return failure('invalid_reply', '文档固定条目查询范围不一致。', 'capture_preparation')
      const excluded = preparation.correctionReview?.excludedRanges ?? [], relevantFixedIds = terms.snapshot.entries.filter(entry => entry.status === 'active' && entry.targetLanguage === preparation.targetLanguage && entry.origin === 'user_explicit' && entry.confirmation !== null && [...entry.sourceForms, ...entry.aliases].some(form => {
        let offset = text.indexOf(form)
        while (offset >= 0) { const start = Array.from(text.slice(0, offset)).length, end = start + Array.from(form).length
          if (!excluded.some(range => start >= range.start && end <= range.end)) return true
          offset = text.indexOf(form, offset + 1)
        }
        return false
      })).map(entry => entry.id)
      const checked = await this.topics!.requestOwned(request.target.mainSessionId, { kind: 'preparation_capture', request: { target: request.target, preparationId: request.preparationRef.id, version: request.preparationRef.version }, relevantFixedIds, topicTermsVersion: terms.snapshot.version }, exec)
      if (checked.kind !== 'preparation_captured') return failure('invalid_reply', '新版本固定准备捕获未确认。', 'capture_preparation')
      preparation = checked.snapshot
      return { ok: true, value: { restoredSource: capture.source, maxInputChars: baseline.maxInputChars, preparation,
        analysis: { analysisId: preparation.mechanicalCoverage.analysisId, version: preparation.mechanicalCoverage.analysisVersion, actualCalls: baseline.analysisActualCalls },
        isCurrent: () => !this.disposed && !exec.signal.aborted && Boolean(this.topics?.ownsAgent(request.target.mainSessionId, exec.agent)), readSource } }
    }
    const material = this.material(request.target, exec)
    if (!material.ok) return material
    let captured
    let fixedSource: readonly string[] | undefined
    try {
      const terms = await this.topics!.requestOwned(request.target.mainSessionId, { kind: 'list_terms', translationSessionId: material.value.material.translationSessionId }, exec)
      if (terms.kind !== 'terms' || terms.snapshot.topicId !== material.value.material.topicId) return failure('invalid_reply', '规划固定条目查询不属于实际材料主题。', 'capture_preparation')
      const fixed = terms.snapshot.entries.filter(entry => entry.status === 'active' && entry.targetLanguage === material.value.material.targetLanguage && entry.origin === 'user_explicit' && entry.confirmation !== null && entry.confirmation.adoptedEntryVersion < entry.version)
      const relevantFixedIds: string[] = []
      if (fixed.length) {
        const total = material.value.material.sourceRef?.totalCodePoints ?? sourceCodePointLength(material.value.material.sourceText!), pieces: string[] = []
        for (let start = 0; start < total; start += MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) {
          const range = { start, end: Math.min(total, start + MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) }, page = this.materials!.readSource({ target: request.target, range }, exec.agent!)
          if (!page.ok) return page
          if (page.value.totalCodePoints !== total || page.value.range.start !== range.start || page.value.range.end !== range.end || sourceCodePointLength(page.value.text) !== range.end - range.start) return failure('invalid_reply', '规划固定词核对取得的源范围不一致。', 'read_plan_source')
          pieces.push(page.value.text)
        }
        const source = pieces.join('')
        relevantFixedIds.push(...fixed.filter(entry => [...entry.sourceForms, ...entry.aliases].some(form => source.includes(form))).map(entry => entry.id))
        fixedSource = Array.from(source)
      }
      captured = await this.topics!.requestOwned(request.target.mainSessionId, { kind: 'preparation_capture', request: { target: request.target, preparationId: request.preparationRef.id, version: request.preparationRef.version }, relevantFixedIds, topicTermsVersion: terms.snapshot.version }, exec)
    }
    catch (error) { const known = error as { code?: string; message?: string }; return failure(known.code ?? 'bridge_failed', known.message ?? '规划准备捕获未确认。', 'capture_preparation') }
    if (captured.kind !== 'preparation_captured') return failure('invalid_reply', '规划准备捕获回执类型不一致。', 'capture_preparation')
    const snapshot = captured.snapshot
    if (snapshot.id !== request.preparationRef.id || snapshot.version !== request.preparationRef.version || JSON.stringify(snapshot.target) !== JSON.stringify(request.target) ||
      snapshot.scope.ownerId !== material.value.ownerId || snapshot.scope.mainSessionId !== material.value.mainSessionId || snapshot.scope.topicId !== material.value.material.topicId ||
      snapshot.scope.translationSessionId !== material.value.material.translationSessionId || snapshot.sourceVersion !== request.target.sourceVersion ||
      JSON.stringify(snapshot.route) !== JSON.stringify(material.value.material.model)) return failure('invalid_reply', '规划准备与固定材料身份、版本或实际模型路由不一致。', 'capture_preparation')
    const analysis = this.ctx.get?.('translationAnalysis') as TerminologyAnalysisService | undefined
    const facts = analysis?.preparationFacts({ target: request.target, analysisId: snapshot.mechanicalCoverage.analysisId, version: snapshot.mechanicalCoverage.analysisVersion }, exec)
    if (!facts) return failure('unavailable', '真实术语分析服务尚未就绪。', 'authorize_plan')
    if (!facts.ok) return facts
    if (facts.value.run.totalCodePoints !== snapshot.totalCodePoints || facts.value.run.sourceVersion !== snapshot.sourceVersion) return failure('source_mismatch', '规划准备与真实分析的固定原稿不一致。', 'authorize_plan')
    const materialTarget = request.target
    const isCurrent = (): boolean => !exec.signal.aborted && this.material(materialTarget, exec).ok
    return { ok: true, value: {
      envelope: material.value, preparation: snapshot,
      analysis: { analysisId: facts.value.run.analysisId, version: facts.value.run.version, actualCalls: facts.value.run.actualCalls }, isCurrent,
      readSource: range => {
        if (!isCurrent()) throw rejection('scope_mismatch', '规划读取时材料授权已失效。', 'read_plan_source')
        if (fixedSource) return fixedSource.slice(range.start, range.end).join('')
        const pieces: string[] = []
        for (let start = range.start; start < range.end; start += MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) {
          const pageRange = { start, end: Math.min(range.end, start + MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) }, page = this.materials!.readSource({ target: request.target, range: pageRange }, exec.agent!)
          if (!page.ok) throw rejection(page.error.code, page.error.message, page.error.stage)
          if (page.value.totalCodePoints !== snapshot.totalCodePoints || page.value.range.start !== pageRange.start || page.value.range.end !== pageRange.end || sourceCodePointLength(page.value.text) !== pageRange.end - pageRange.start) throw rejection('invalid_reply', '规划原稿分页与固定源范围不一致。', 'read_plan_source')
          pieces.push(page.value.text)
        }
        return pieces.join('')
      },
    } }
  }
  async attachReferences(input: DocumentPlanningInput, exec: ToolExecution): Promise<DocumentPlanningInput> {
    const ref=input.preparation.referenceContextRef
    if(!ref)return input
    const service=this.ctx.get?.('translationReferences') as ReferenceFilesService | undefined
    if(!service)throw rejection('reference_unavailable','参考资料服务不可用，不能省略参考继续执行。','prepare_reference')
    const context=await service.resolveContext(input.preparation.scope.ownerId,input.preparation.scope.topicId,ref,exec)
    return {...input,referenceContext:context,isCurrent:()=>input.isCurrent()&&service.contextCurrent(context)}
  }
  private async input(request: Pick<TranslationPlanSuggest,'target'|'preparationRef'>, exec: ToolExecution): Promise<AnalysisResult<DocumentPlanningInput>> {
    const input=await this.baseInput(request,exec)
    if(!input.ok)return input
    try{return {ok:true,value:await this.attachReferences(input.value,exec)}}
    catch(error){return failure(String((error as {code?:string}).code??'reference_unavailable'),(error as Error).message,'prepare_reference')}
  }
  private bounded<T>(result: AnalysisResult<T>): AnalysisResult<T> {
    return documentPlanningBytes(result) > MAX_DOCUMENT_PLAN_PAGE_BYTES ? failure('reply_too_large', '完整规划回执超过 32768 字节；未截字段。', 'plan_budget') : result
  }
  async suggest(args: unknown, exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    let request: TranslationPlanSuggest
    try { request = parseTranslationPlanSuggest(args) } catch { return failure('invalid_input', '分块建议参数无效。', 'suggest_plan') }
    const input = await this.input(request, exec)
    return input.ok ? this.bounded(await this.planner.suggest(input.value, request, exec.signal)) : input
  }
  async set(args: unknown, exec: ToolExecution): Promise<AnalysisResult<unknown>> {
    let request: TranslationPlanSet
    try { request = parseTranslationPlanSet(args) } catch { return failure('invalid_input', '分块计划参数无效。', 'set_plan') }
    const input = await this.input(request, exec)
    return input.ok ? this.bounded(await this.planner.set(input.value, request, exec.signal)) : input
  }
  status(args: unknown, exec: ToolExecution): AnalysisResult<unknown> {
    let request: TranslationPlanQuery
    try { request = parseTranslationPlanQuery(args) } catch { return failure('invalid_input', '分块计划查询参数无效。', 'status_plan') }
    const authorized = request.target.kind === 'material' ? this.material(request.target, exec) : this.unitAuthorized(request.target, exec)
    return authorized.ok ? this.bounded(this.planner.status(request)) : authorized
  }
  read(args: unknown, exec: ToolExecution): AnalysisResult<unknown> {
    let request: TranslationPlanRead
    try { request = parseTranslationPlanRead(args) } catch { return failure('invalid_input', '分块计划分页参数无效。', 'read_plan') }
    const authorized = request.target.kind === 'material' ? this.material(request.target, exec) : this.unitAuthorized(request.target, exec)
    return authorized.ok ? this.bounded(this.planner.read(request)) : authorized
  }
  /** Private authorized capture; never registered as a model tool or Remote method. */
  private unitAuthorized(target: NormalTranslationTarget, exec: ToolExecution): AnalysisResult<true> {
    return !this.disposed && this.topics?.ownsAgent(target.mainSessionId, exec.agent) && (this.topics.protocolFor(target.mainSessionId) ?? 0) >= 2
      ? { ok: true, value: true } : failure('scope_mismatch', '规划不属于当前实际主 Agent。', 'authorize_plan')
  }
  async captureExecution(target: NormalTranslationTarget, planRef: VersionReference, preparationRef: VersionReference,
    exec: ToolExecution): Promise<AnalysisResult<{ readonly input: DocumentPlanningInput; readonly snapshot: DocumentExecutionFreeze }>> {
    const input = await this.input({ target, preparationRef }, exec)
    if (!input.ok) return input
    const snapshot = await this.planner.freezeExecution(input.value, { target, planId: planRef.id, version: planRef.version }, preparationRef, exec.signal)
    return snapshot.ok ? { ok: true, value: { input: input.value, snapshot: snapshot.value } } : snapshot
  }
  dispose(): void { this.disposed = true; this.planner.dispose() }
}

export function installDocumentPlanning(ctx: TopicHostContext): DocumentPlanningService {
  const service = new DocumentPlanningService(ctx)
  ctx.provide('translationPlanning', service)
  ctx.effect?.(() => () => service.dispose(), 'document planning lifetime')
  return service
}
