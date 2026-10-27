import { historyTargetMatches } from './history-resources.js'
import type { HistoryScope } from '../shared/history-bundle.js'
import { parseTranslationBatchCorrection, parseDocumentCorrectionReceipt, type TranslationBatchCorrection, type DocumentCorrectionReceipt } from '../shared/document-correction.js'
import { parseDocumentUnitCapture, parseDocumentCorrectionQuery, type DocumentUnitCapture } from '../shared/document-unit-capture.js'
import type { NormalTranslationUnitTarget } from '../shared/normal-translation.js'
import type { VersionReference, DocumentSourceVersion } from '../shared/translation-batch.js'
import { toSourceIdentity, type TranslationSourceAsset } from '../shared/translation-sources.js'
import { MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, type TranslationSourceRange } from '../shared/translation-source-read.js'
import type { AnalysisResult } from '../shared/translation-preparation.js'
import { applyDocumentSourcePatches } from '../memory/document-correction.js'
import type { TopicHostContext, TopicToolsService, ToolExecution } from './topic-tools.js'
import type { TranslationSourcesService } from './translation-sources.js'
import type { DocumentExecutionService } from './document-execution-service.js'

function failure(code: string, message: string, stage = 'correct_document_source'): AnalysisResult<never> { return { ok: false, error: { code, message, stage } } }
function rejected(code: string, message: string, stage: string): Error { return Object.assign(new Error(message), { code, stage }) }
export interface CapturedDocumentSource { readonly capture: DocumentUnitCapture; readonly readSource: (range: TranslationSourceRange) => Promise<string>; readonly text: string }
/** Reads and corrects the immutable source; the sole Client bridge owns the version CAS. */
export class DocumentCorrectionService {
  private readonly operations = new Map<string, { signature: string; settled: boolean; result: Promise<AnalysisResult<DocumentCorrectionReceipt>> }>()
  constructor(readonly ctx: TopicHostContext) {}
  private get topics(): TopicToolsService { return this.ctx.get?.('translationTopics') as TopicToolsService }
  private get sources(): TranslationSourcesService { return this.ctx.get?.('translationSources') as TranslationSourcesService }
  async captureUnit(target: NormalTranslationUnitTarget, preparationRef: VersionReference | undefined, exec: ToolExecution,
    options: { readonly requireReady?: boolean; readonly revisionIds?: readonly string[]; readonly metadataOnly?: boolean } = {}): Promise<AnalysisResult<CapturedDocumentSource>> {
    if (!this.topics?.ownsAgent(target.mainSessionId, exec.agent) || (this.topics.protocolFor(target.mainSessionId) ?? 0) < 2) return failure('scope_mismatch', '文档读取需要实际主 Agent 和唯一 v2 或更新主题桥。', 'capture_document')
    try {
      const { metadataOnly, ...captureOptions } = options
      const reply = await this.topics.requestOwned(target.mainSessionId, { kind: 'document_capture', request: { target, ...(preparationRef ? { preparationRef } : {}), ...captureOptions } }, exec)
      if (reply.kind !== 'document_captured') return failure('invalid_reply', 'Client 未返回准确文档事实。', 'capture_document')
      const capture = parseDocumentUnitCapture(reply.capture), source = capture.source
      if (capture.unitId !== target.unitId || capture.scope.translationSessionId !== target.translationSessionId || capture.scope.mainSessionId !== target.mainSessionId || source.version !== target.sourceVersion) return failure('invalid_reply', '文档捕获的身份或原稿版本不一致。', 'capture_document')
      const peerId = this.topics.ownerPeer(target.mainSessionId, exec.agent!)
      if (!peerId) return failure('scope_mismatch', '文档原稿所属连接已失效。', 'read_document_source')
      let asset: TranslationSourceAsset | undefined
      if (source.body.kind === 'asset') {
        asset = { ...source.body.reference, persistence: 'runtime_only' }
        if (!this.sources.validateReference(capture.scope, asset, peerId).ok) {
          if (!capture.sourceRestore) return failure('source_reference_unconfirmed', '原稿没有准确的运行期资产或已确认保存引用。', 'read_document_source')
          const restored = await this.sources.restoreForAgent(capture.sourceRestore, peerId, exec.agent!)
          if (!restored.ok) return restored
          asset = restored.value.source
        }
      }
      const readSource = async (range: TranslationSourceRange): Promise<string> => {
        exec.signal.throwIfAborted()
        if (!this.topics.ownsAgent(target.mainSessionId, exec.agent)) throw rejected('scope_mismatch', '文档原稿授权已失效。', 'read_document_source')
        if (source.body.kind === 'inline') return Array.from(source.body.text).slice(range.start, range.end).join('')
        const parts: string[] = []
        for (let start = range.start; start < range.end; start += MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) {
          const read = this.sources.readForAgent(capture.scope, asset!, { start, end: Math.min(range.end, start + MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) }, peerId, exec.agent!)
          if (!read.ok) throw rejected(read.error.code, read.error.message, read.error.stage)
          parts.push(read.value.text)
        }
        return parts.join('')
      }
      const total = source.body.kind === 'inline' ? Array.from(source.body.text).length : source.body.reference.totalCodePoints, text = metadataOnly ? '' : await readSource({ start: 0, end: total })
      return { ok: true, value: { capture, readSource, text } }
    } catch (error) { const known = error as { code?: string; message?: string; stage?: string }; return failure(known.code ?? 'capture_failed', known.message ?? '文档捕获未确认。', known.stage ?? 'capture_document') }
  }
  correct(args: unknown, exec: ToolExecution): Promise<AnalysisResult<DocumentCorrectionReceipt>> {
    let request: TranslationBatchCorrection
    try { request = parseTranslationBatchCorrection(args) } catch { return Promise.resolve(failure('invalid_input', '文档纠错参数无效。')) }
    const key = JSON.stringify([request.scope.mainSessionId, request.operationId]), signature = JSON.stringify(request), old = this.operations.get(key)
    if (old) return old.signature === signature ? old.result : Promise.resolve(failure('idempotency_conflict', '同一纠错标识已绑定另一版本或补丁。'))
    const entry = { signature, settled: false, result: undefined as unknown as Promise<AnalysisResult<DocumentCorrectionReceipt>> }
    entry.result = this.correctOnce(request, exec).finally(() => { entry.settled = true }); this.operations.set(key, entry); return entry.result
  }
  historyUnitBusy(scope: HistoryScope, unitId: string): boolean { return [...this.operations.values()].some(entry => { const request = JSON.parse(entry.signature); return !entry.settled && historyTargetMatches(scope, unitId, { ...request.scope, unitId: request.unitId }) }) }
  forgetHistoryUnit(scope: HistoryScope, unitId: string, sourceVersion?: number): void { for (const [id, entry] of this.operations) { const request = JSON.parse(entry.signature); if (historyTargetMatches(scope, unitId, { ...request.scope, unitId: request.unitId, sourceVersion: request.expectedSourceVersion }, sourceVersion)) this.operations.delete(id) } }
  async status(args: unknown, exec: ToolExecution): Promise<AnalysisResult<DocumentCorrectionReceipt | null>> {
    try {
      const request = parseDocumentCorrectionQuery(args)
      if (!this.topics.ownsAgent(request.scope.mainSessionId, exec.agent)) return failure('scope_mismatch', '纠错查询不属于实际主 Agent。')
      const reply = await this.topics.requestOwned(request.scope.mainSessionId, { kind: 'document_correct_observe', request }, exec)
      if (reply.kind !== 'document_correct_observed') return failure('invalid_reply', '纠错查询回执类型不一致。')
      if (reply.receipt) (this.ctx.get?.('translationBatch') as DocumentExecutionService).supersedeSource(request.scope, request.unitId, reply.receipt.sourceVersion - 1)
      return { ok: true, value: reply.receipt }
    } catch (error) { const known = error as { code?: string; message?: string }; return failure(known.code ?? 'query_failed', known.message ?? '纠错查询未确认。') }
  }
  private async correctOnce(request: TranslationBatchCorrection, exec: ToolExecution): Promise<AnalysisResult<DocumentCorrectionReceipt>> {
    const target: NormalTranslationUnitTarget = { kind: 'unit', mainSessionId: request.scope.mainSessionId, translationSessionId: request.scope.translationSessionId, unitId: request.unitId, sourceVersion: request.expectedSourceVersion }
    let found = await this.captureUnit(target, undefined, exec, { metadataOnly: true })
    if (!found.ok) return found
    if (JSON.stringify(found.value.capture.scope) !== JSON.stringify(request.scope)) return failure('scope_mismatch', '纠错不属于此精确文档范围。')
    if (found.value.capture.currentSourceVersion !== request.expectedSourceVersion) return failure('stale_source_version', '当前原稿版本已变化，请先读取新版本。')
    if (found.value.capture.hasSourceObjects) return failure('object_source_unsupported', '此原稿含对象位置关联，不能自动猜测纠错映射。')
    const batch = this.ctx.get?.('translationBatch') as DocumentExecutionService
    for (const task of found.value.capture.tasks.filter(task => task.sourceVersion === request.expectedSourceVersion)) {
      if (task.status === 'unknown' || task.unsettled && task.status !== 'running') return failure('prior_call_unconfirmed', '旧源调用状态未知；只能查询，未生成新原稿。')
      if (task.status === 'running') {
        const paused = await batch.pause({ scope: request.scope, taskId: task.taskId, expectedTaskVersion: task.taskVersion, operationId: `${request.operationId}:pause:${task.taskId}` }, exec)
        if (!paused.ok) return paused
      }
    }
    found = await this.captureUnit(target, undefined, exec)
    if (!found.ok) return found
    if (found.value.capture.tasks.some(task => task.sourceVersion === request.expectedSourceVersion && (task.unsettled || ['running', 'unknown'].includes(task.status)))) return failure('prior_call_unconfirmed', '旧源调用尚未确认结算，未生成新原稿。')
    try {
      const patched = await applyDocumentSourcePatches(found.value.text, request.patches), peerId = this.topics.ownerPeer(request.scope.mainSessionId, exec.agent!)
      if (!peerId) return failure('scope_mismatch', '纠错时原稿连接已失效。')
      const createdAt = new Date().toISOString(), created = await this.sources.createCorrectedForAgent(request.scope, patched.text,
        found.value.capture.source.body.kind === 'asset' ? found.value.capture.source.body.reference.name : 'document-source.txt', peerId, exec.agent!)
      if (!created.ok) return created
      const source: DocumentSourceVersion = { version: request.expectedSourceVersion + 1, body: { kind: 'asset', reference: toSourceIdentity(created.value) }, createdAt, operationId: request.operationId }
      const reply = await this.topics.requestOwned(request.scope.mainSessionId, { kind: 'document_correct', request: { scope: request.scope, unitId: request.unitId, expectedSourceVersion: request.expectedSourceVersion, source,
        fact: { operationId: request.operationId, fromSourceVersion: request.expectedSourceVersion, toSourceVersion: source.version, oldLength: Array.from(found.value.text).length, newLength: Array.from(patched.text).length, mappings: patched.mappings, createdAt } } }, exec)
      if (reply.kind !== 'document_corrected') return failure('invalid_reply', '纠错写回回执未知；请查询原纠错操作，未派发模型。')
      const receipt = parseDocumentCorrectionReceipt(reply.receipt)
      if (receipt.unitId !== request.unitId || receipt.operationId !== request.operationId || receipt.sourceVersion !== source.version || JSON.stringify(receipt.scope) !== JSON.stringify(request.scope)) return failure('invalid_reply', '纠错回执身份不一致；请查询原操作。')
      batch.supersedeSource(request.scope, request.unitId, request.expectedSourceVersion)
      return { ok: true, value: receipt }
    } catch (error) { const known = error as { code?: string; message?: string; stage?: string }; return failure(known.code ?? 'correction_failed', known.message ?? '文档纠错未确认，未开始新版本调用。', known.stage ?? 'correct_document_source') }
  }
}
export function installDocumentCorrection(ctx: TopicHostContext): DocumentCorrectionService { const service = new DocumentCorrectionService(ctx); ctx.provide('translationCorrection', service); return service }
