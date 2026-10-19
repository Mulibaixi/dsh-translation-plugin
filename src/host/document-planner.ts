import type { FrozenReferenceContext } from '../shared/reference-memory.js'
import type { ModelSelection } from '../shared/contracts.js'
import { parseDocumentChunkPlan, type ChunkPlanItem, type DocumentChunkPlan, type VersionReference, type DocumentSourceVersion, type DocumentExecutionBaseline } from '../shared/translation-batch.js'
import {
  documentPlanningBytes, reconstructDocumentTranslationPrompt, MAX_DOCUMENT_PLAN_CHUNKS, MAX_DOCUMENT_PLAN_CALLS,
  MAX_DOCUMENT_PLAN_PAGE_BYTES, MAX_DOCUMENT_PLAN_PAGE_ITEMS, MAX_DOCUMENT_PLAN_PACKET_BYTES,
  type DocumentPreparedCapacity, type DocumentChunkBudget, type DocumentPlanCallBudget, type DocumentPlanReceipt,
  type DocumentPlanSuggestion, type DocumentPlanSuggestionPage, type DocumentPlanPage, type DocumentTranslationPrompt,
  type TranslationPlanSuggest, type TranslationPlanSet, type TranslationPlanQuery, type TranslationPlanRead,
} from '../shared/document-planning.js'
import { parsePreparationSnapshot, type AnalysisResult, type PreparationSnapshot } from '../shared/translation-preparation.js'
import { sourceCodePointLength, type TranslationSourceRange } from '../shared/translation-source-read.js'
import type { TranslationMaterialEnvelope, TranslationMaterialRoute } from '../shared/translation-material.js'
import type { DshTextExecutionAdapter } from './dsh-text-adapter.js'

/** Supplied only by the authorized Host service, never by a model or RPC caller. */
export interface DocumentPlanningInput {
  readonly envelope?: Extract<TranslationMaterialEnvelope, { kind: 'material' }>
  readonly restoredSource?: DocumentSourceVersion
  readonly maxInputChars?: number
  readonly preparation: PreparationSnapshot
  readonly referenceContext?: FrozenReferenceContext
  readonly analysis: { readonly analysisId: string; readonly version: number; readonly actualCalls: number }
  readonly readSource: (range: TranslationSourceRange) => string | Promise<string>
  readonly isCurrent: () => boolean
}
/** Private Host execution capture. Immutable references and capacity facts, without source or prompt bodies. */
export interface DocumentExecutionFreeze {
  readonly target: TranslationPlanQuery['target']
  readonly sourceSha256: string
  readonly plan: DocumentChunkPlan
  readonly preparation: PreparationSnapshot
  readonly protectedRanges: readonly TranslationSourceRange[]
  readonly budgets: readonly DocumentChunkBudget[]
  readonly capacity: DocumentPreparedCapacity
  readonly callBudget: DocumentPlanCallBudget
}
interface PlanningRecord {
  readonly target: TranslationPlanQuery['target']
  readonly sourceSha256: string
  readonly plan: DocumentChunkPlan
  readonly protectedRanges: readonly TranslationSourceRange[]
  readonly budgets: readonly DocumentChunkBudget[]
  readonly receipt: DocumentPlanReceipt
  readonly cursorToken: string
}
interface SuggestionRecord {
  readonly id: string
  readonly signature: string
  readonly cursorToken: string
  readonly items: readonly DocumentPlanSuggestion[]
  readonly summary: Omit<DocumentPlanSuggestionPage, 'items' | 'nextCursor' | 'cursor' | 'limit'>
}
function ok<T>(value: T): AnalysisResult<T> { return { ok: true, value } }
function bad(code: string, message: string, stage = 'plan_document'): AnalysisResult<never> { return { ok: false, error: { code, message, stage } } }
function reject(code: string, message: string, stage = 'plan_document'): Error { return Object.assign(new Error(message), { code, stage }) }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function frozen<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value) } return value }
function key(target: TranslationPlanQuery['target'], id: string): string { return JSON.stringify([target.mainSessionId, id]) }
function inputLimit(input: DocumentPlanningInput): number {
  const maximum = input.envelope?.material.maxInputChars ?? input.maxInputChars
  if (!Number.isSafeInteger(maximum) || maximum! < 1) throw reject('execution_baseline_missing', '缺少实际受理时的单次正文上限，无法恢复执行。', 'restore_document')
  return maximum!
}
function overlap(left: TranslationSourceRange, right: TranslationSourceRange): boolean { return left.start < right.end && right.start < left.end }
function covers(actual: readonly TranslationSourceRange[], required: TranslationSourceRange): boolean {
  let end = required.start
  for (const part of [...actual].sort((a, b) => a.start - b.start)) {
    if (part.end <= end) continue
    if (part.start > end) break
    end = part.end
    if (end >= required.end) return true
  }
  return false
}
function model(route: TranslationMaterialRoute): ModelSelection {
  return { providerId: route.provider, modelId: route.model, configVersion: 0,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }) }
}
function callBudget(analysisActualCalls: number, items: readonly ChunkPlanItem[]): DocumentPlanCallBudget {
  const plannedTranslationCalls = items.filter(item => item.mode === 'translate').length
  const automaticSupplementCalls = Math.min(3, plannedTranslationCalls)
  const totalReservedCalls = analysisActualCalls + plannedTranslationCalls + automaticSupplementCalls
  if (totalReservedCalls > MAX_DOCUMENT_PLAN_CALLS) throw reject('call_budget_exceeded',
    `实际分析 ${analysisActualCalls} 次、预计翻译 ${plannedTranslationCalls} 次及自动补充 ${automaticSupplementCalls} 次合计 ${totalReservedCalls} 次，超过 512 次任务预算。`)
  return { analysisActualCalls, plannedTranslationCalls, automaticSupplementCalls, totalReservedCalls, maximumCalls: 512 }
}
function errorResult(error: unknown): AnalysisResult<never> {
  const value = error as { readonly code?: string; readonly stage?: string; readonly message?: string }
  if (value.stage && value.code && value.message) return bad(value.code, value.message, value.stage)
  const code = value.code === 'CONTEXT_WINDOW_EXCEEDED' ? value.code : value.code === 'INVALID_PREPARED_CALL' ? value.code : 'model_prepare_failed'
  return bad(code, code === 'CONTEXT_WINDOW_EXCEEDED' ? '所选模型的实际输出预留已用尽上下文容量。' : '无法准备固定翻译模型的实际容量，请检查原模型配置。', 'prepare_document_capacity')
}
function mergeRanges(parts: readonly TranslationSourceRange[]): readonly TranslationSourceRange[] {
  const result: TranslationSourceRange[] = []
  for (const part of [...parts].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = result[result.length - 1]
    if (last && part.start <= last.end) result[result.length - 1] = { start: last.start, end: Math.max(last.end, part.end) }
    else result.push({ ...part })
  }
  return result
}
/** Context is a source reference, never a second output. Already translated output positions are omitted from context. */
function contextRanges(preparation: PreparationSnapshot, item: ChunkPlanItem): readonly TranslationSourceRange[] {
  const parts = mergeRanges([...item.contextRanges, ...preparation.backgroundRanges]).flatMap(part => {
    if (!overlap(part, item.outputRange)) return [part]
    return [{ start: part.start, end: Math.min(part.end, item.outputRange.start) },
      { start: Math.max(part.start, item.outputRange.end), end: part.end }].filter(part => part.start < part.end)
  })
  if (parts.length > 8) throw reject('context_range_budget', `块 ${item.chunkId} 的前后文与背景共有 ${parts.length} 个实际范围，超过 8 个；请调整明确背景或上下文。`)
  return parts
}

/** Runtime planning facts only. No business acceptance, translation unit, draft consumption, or model stream. */
export class DocumentPlanner {
  private readonly plans = new Map<string, readonly PlanningRecord[]>()
  private readonly operations = new Map<string, { readonly signature: string; readonly record: PlanningRecord }>()
  private readonly suggestions = new Map<string, SuggestionRecord>()
  private readonly locks = new Set<string>()
  constructor(readonly adapter: DshTextExecutionAdapter) {}

  private check(input: DocumentPlanningInput, target: TranslationPlanQuery['target'], preparationRef: VersionReference): PreparationSnapshot {
    if (!input.isCurrent()) throw reject('scope_mismatch', '规划所属实际主 Agent 或固定材料已失效。', 'authorize_plan')
    const preparation = parsePreparationSnapshot(input.preparation), envelope = input.envelope
    if (target.kind === 'unit') {
      if (!input.restoredSource || input.restoredSource.version !== target.sourceVersion || !same(preparation.target, target) ||
        preparation.id !== preparationRef.id || preparation.version !== preparationRef.version || !preparation.preparationReady ||
        preparation.scope.translationSessionId !== target.translationSessionId || preparation.scope.mainSessionId !== target.mainSessionId ||
        !Number.isSafeInteger(input.analysis.actualCalls) || input.analysis.actualCalls < preparation.mechanicalCoverage.coverage.length || input.analysis.actualCalls > 512) throw reject('source_mismatch', '纠错原稿、复核准备和实际分析基线不一致。')
      return preparation
    }
    if (!envelope) throw reject('material_missing', '新规划需要确切已交付材料。')
    const material = envelope.material
    if (!same(preparation.target, target) || envelope.ownerId !== target.mainSessionId || envelope.mainSessionId !== target.mainSessionId ||
      envelope.requestId !== target.requestId || material.materialId !== target.materialId || material.sourceVersion !== target.sourceVersion ||
      preparation.id !== preparationRef.id || preparation.version !== preparationRef.version ||
      preparation.scope.ownerId !== envelope.ownerId || preparation.scope.mainSessionId !== envelope.mainSessionId ||
      preparation.scope.topicId !== material.topicId || preparation.scope.translationSessionId !== material.translationSessionId ||
      preparation.sourceVersion !== material.sourceVersion || preparation.userRequirements !== material.instruction ||
      preparation.targetLanguage !== material.targetLanguage || !same(preparation.route, material.model)) {
      throw reject('source_mismatch', '计划、准备包与当前已交付原稿或固定模型不一致。')
    }
    if (!preparation.preparationReady) throw reject('preparation_not_ready', '需译范围的机械扫描、主模型审阅或关键问题尚未完成。')
    if (input.analysis.analysisId !== preparation.mechanicalCoverage.analysisId || input.analysis.version !== preparation.mechanicalCoverage.analysisVersion ||
      !Number.isSafeInteger(input.analysis.actualCalls) || input.analysis.actualCalls < preparation.mechanicalCoverage.coverage.length || input.analysis.actualCalls > 512) {
      throw reject('analysis_mismatch', '缺少与此准备包相符的真实分析调用次数，不能用候选或覆盖项计数替代。')
    }
    return preparation
  }
  private async source(input: DocumentPlanningInput, preparation: PreparationSnapshot, signal: AbortSignal): Promise<{ readonly points: readonly string[]; readonly bytes: number }> {
    const asset = input.envelope?.material.sourceRef ?? (input.restoredSource?.body.kind === 'asset' ? input.restoredSource.body.reference : undefined)
    if (asset && (asset.bytes > 2 * 1024 * 1024 || asset.totalCodePoints !== preparation.totalCodePoints || asset.sha256 !== preparation.sourceSha256)) throw reject('source_limit', '原稿身份不一致或超过 2 MiB 整体上限。')
    const inline = input.envelope?.material.sourceText ?? (input.restoredSource?.body.kind === 'inline' ? input.restoredSource.body.text : undefined)
    if (inline !== undefined && (new TextEncoder().encode(inline).byteLength > 2 * 1024 * 1024 || sourceCodePointLength(inline) !== preparation.totalCodePoints)) throw reject('source_limit', '内联原稿超过 2 MiB 或固定码点长度不一致。')
    const pieces: string[] = []
    for (let start = 0; start < preparation.totalCodePoints; start += 4000) {
      signal.throwIfAborted()
      if (!input.isCurrent()) throw reject('scope_mismatch', '规划读取时固定材料或实际主 Agent 已失效。', 'read_plan_source')
      const range = { start, end: Math.min(preparation.totalCodePoints, start + 4000) }, text = await input.readSource(range)
      if (sourceCodePointLength(text) !== range.end - range.start || /[\uD800-\uDFFF]/u.test(text)) throw reject('source_mismatch', '实际原稿读取与固定 Unicode 码点范围不一致。', 'read_plan_source')
      pieces.push(text)
    }
    // Sources uses ignoreBOM:true: the original U+FEFF is already part of text and its code point ranges.
    const text = pieces.join(''), bytes = new TextEncoder().encode(text)
    if (bytes.byteLength > 2 * 1024 * 1024 || (asset && bytes.byteLength !== asset.bytes)) throw reject('source_limit', '实际原稿超过 2 MiB 或原件字节身份不一致。')
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer))
    if ([...digest].map(byte => byte.toString(16).padStart(2, '0')).join('') !== preparation.sourceSha256) throw reject('source_mismatch', '实际原稿校验与准备包固定源不一致。', 'read_plan_source')
    if (!input.isCurrent()) throw reject('scope_mismatch', '规划源校验完成前实际主 Agent 或材料已失效。', 'read_plan_source')
    return { points: Array.from(text), bytes: bytes.byteLength }
  }
  private budget(preparation: PreparationSnapshot, item: ChunkPlanItem, points: readonly string[], capacity: DocumentPreparedCapacity,
    maximum: number, protectedRanges: readonly TranslationSourceRange[] = [], references?: FrozenReferenceContext): { readonly budget: DocumentChunkBudget; readonly prompt: DocumentTranslationPrompt | null } {
    if(preparation.referenceContextRef && (!references || !same(references.manifestRef,preparation.referenceContextRef) || references.scope.topicId!==preparation.scope.topicId))throw reject('reference_context_unavailable','准确的参考上下文不可用，不能省略后执行。')
    const contextRef = { preparationRef: { id: preparation.id, version: preparation.version }, termRefs: [], referenceRefs: [], contextRanges: [], supplementRefs: [] }
    if (item.mode === 'copy') return { budget: { chunkId: item.chunkId, mode: 'copy', outputCodePoints: item.outputRange.end - item.outputRange.start,
      inputTokens: 0, countKind: 'estimated', outputReservationTokens: 0, contextWindow: capacity.contextWindow, maxOutputTokens: capacity.maxOutputTokens, contextRef }, prompt: null }
    const outputCodePoints = item.outputRange.end - item.outputRange.start
    if (outputCodePoints > maximum) throw reject('single_input_limit', `块 ${item.chunkId} 的待译正文 ${outputCodePoints} 码点超过会话单次上限 ${maximum}；上下文不计入正文上限。`)
    const contexts = contextRanges(preparation, item), relevance = [item.outputRange, ...contexts]
    const termRefs = preparation.terms.filter(term => term.ranges.some(range => relevance.some(part => overlap(range, part)))).map(term => term.ref)
    if (termRefs.length > 100) throw reject('term_range_budget', `块 ${item.chunkId} 的实际相关术语超过 100 项，请细分需译范围或调整准备适用范围。`)
    const actualRef = { ...contextRef, termRefs, contextRanges: contexts, referenceRefs: preparation.referenceRefs }
    const outputText = points.slice(item.outputRange.start, item.outputRange.end).join('')
    const prompt = reconstructDocumentTranslationPrompt(preparation, item, outputText,
      contexts.map(range => ({ range, text: points.slice(range.start, range.end).join('') })), actualRef, protectedRanges, references)
    const bytes = new TextEncoder().encode(prompt.systemPrompt + prompt.userMessage).byteLength
    if (bytes > MAX_DOCUMENT_PLAN_PACKET_BYTES) throw reject('input_package_limit', `块 ${item.chunkId} 的完整提示、用词与背景超过 196608 字节；请细分或调整背景。`)
    const inputTokens = bytes + 16, outputEstimate = Math.max(1, new TextEncoder().encode(outputText).byteLength)
    const outputReservationTokens = capacity.maxOutputTokens ?? Math.max(128, outputEstimate * 2)
    if (capacity.maxOutputTokens !== null && outputEstimate > capacity.maxOutputTokens) throw reject('output_capacity',
      `块 ${item.chunkId} 的保守输出估算 ${outputEstimate} tokens 超过实际最大输出 ${capacity.maxOutputTokens}，请细分该块。`)
    if (capacity.contextWindow !== null && inputTokens + outputReservationTokens > capacity.contextWindow) throw reject('context_capacity',
      `块 ${item.chunkId} 的完整输入估算 ${inputTokens} 与输出预留 ${outputReservationTokens} 合计超过实际上下文 ${capacity.contextWindow}，请细分或调整明确背景。`)
    return { budget: { chunkId: item.chunkId, mode: 'translate', outputCodePoints, inputTokens, countKind: 'estimated', outputReservationTokens,
      contextWindow: capacity.contextWindow, maxOutputTokens: capacity.maxOutputTokens, contextRef: actualRef }, prompt }
  }
  private validatePlan(preparation: PreparationSnapshot, plan: DocumentChunkPlan, protectedRanges: readonly TranslationSourceRange[]): void {
    const required = preparation.correctionReview?.requiredRanges ?? preparation.mechanicalCoverage.requiredRanges,
      coverage = preparation.correctionReview ? preparation.correctionReview.complete ? required : [] : preparation.mechanicalCoverage.coverage.map(item => item.range)
    for (const item of plan.items) {
      if (item.mode !== 'translate') continue
      if (!covers(required, item.outputRange) || !covers(coverage, item.outputRange) || !covers(preparation.modelReview.reviewedRanges, item.outputRange)) {
        throw reject('unprepared_translate_range', `块 ${item.chunkId} 的 translate 范围 [${item.outputRange.start},${item.outputRange.end}) 包含明确免分析或未扫描、未审阅的原稿，必须 copy 或重新准备。`)
      }
      for (const range of protectedRanges) if (overlap(item.outputRange, range) &&
        (range.start < item.outputRange.start || range.end > item.outputRange.end)) throw reject('protected_range_conflict',
        `保护范围 [${range.start},${range.end}) 被块 ${item.chunkId} 的边界拆开；请将整个保护区置于单块 translate，超容量时整区 copy。`)
    }
  }
  private async capacity(input: DocumentPlanningInput, preparation: PreparationSnapshot, operationId: string, signal: AbortSignal): Promise<DocumentPreparedCapacity> {
    const capacity = await this.adapter.prepareDocumentCapacity(operationId, model(preparation.route), signal)
    if (!input.isCurrent()) throw reject('scope_mismatch', '实际模型准备完成前固定材料或主 Agent 已失效。', 'prepare_document_capacity')
    if (capacity.route.provider !== preparation.route.provider || capacity.route.model !== preparation.route.model ||
      (preparation.route.reasoningEffort !== undefined && capacity.route.reasoningEffort !== preparation.route.reasoningEffort)) {
      throw reject('model_mismatch', '实际准备模型与固定准备包所选模型或指定推理等级不一致。', 'prepare_document_capacity')
    }
    return capacity
  }
  private page<T>(list: readonly T[], token: string, section: string, cursor: string | undefined, limit: number | undefined,
    make: (items: readonly T[], nextCursor: string | null) => unknown): AnalysisResult<unknown> {
    let index = 0
    if (cursor !== undefined) {
      const prefix = `${token}:${section}:`, suffix = cursor.slice(prefix.length)
      if (!cursor.startsWith(prefix) || !/^(0|[1-9][0-9]*)$/u.test(suffix) || !Number.isSafeInteger(Number(suffix)) || Number(suffix) > list.length) return bad('invalid_cursor', '规划游标不属于此固定源、准备版本、计划版本或区段。', 'read_plan')
      index = Number(suffix)
    }
    let end = Math.min(list.length, index + (limit ?? MAX_DOCUMENT_PLAN_PAGE_ITEMS))
    const result = (): unknown => make(list.slice(index, end), end < list.length ? `${token}:${section}:${end}` : null)
    while (end > index && documentPlanningBytes(ok(result())) > MAX_DOCUMENT_PLAN_PAGE_BYTES) end--
    if ((end === index && index < list.length) || documentPlanningBytes(ok(result())) > MAX_DOCUMENT_PLAN_PAGE_BYTES) return bad('page_too_large', '单项完整规划结果超过 32768 字节，未截断字段。', 'read_plan')
    return ok(frozen(result()))
  }
  private suggestionKey(request: TranslationPlanSuggest): string { return JSON.stringify([request.target, request.preparationRef]) }
  /** One identity binds the exact source hash, preparation version, route, analysis facts and input limit. */
  private suggestionSignature(preparation: PreparationSnapshot, input: DocumentPlanningInput): string {
    return JSON.stringify([preparation.sourceSha256, preparation.route, preparation.version, input.analysis.actualCalls, inputLimit(input)])
  }

  async suggest(input: DocumentPlanningInput, request: TranslationPlanSuggest, signal = new AbortController().signal): Promise<AnalysisResult<DocumentPlanSuggestionPage>> {
    const preparedId = `document-suggestion:${crypto.randomUUID()}`
    try {
      const preparation = this.check(input, request.target, request.preparationRef)
      const suggestionKey = this.suggestionKey(request), signature = this.suggestionSignature(preparation, input)
      let record = this.suggestions.get(suggestionKey)
      if (request.cursor !== undefined) {
        if (!record || record.signature !== signature) return bad('invalid_cursor', '建议游标的固定材料或分析事实已失效。', 'read_plan_suggestion')
      } else {
        const source = await this.source(input, preparation, signal), capacity = await this.capacity(input, preparation, preparedId, signal)
        const excluded = preparation.correctionReview?.excludedRanges ?? preparation.mechanicalCoverage.excludedRanges
        const partitions = [...(preparation.correctionReview?.requiredRanges ?? preparation.mechanicalCoverage.requiredRanges).map(range => ({ range, mode: 'translate' as const })),
          ...excluded.map(range => ({ range, mode: 'copy' as const }))].sort((a, b) => a.range.start - b.range.start)
        const items: DocumentPlanSuggestion[] = []
        for (const part of partitions) {
          if (part.mode === 'copy') {
            const item: ChunkPlanItem = { chunkId: `suggested-${items.length + 1}`, outputRange: part.range, mode: 'copy', contextRanges: [] }
            items.push({ item, boundary: 'excluded_copy', budget: this.budget(preparation, item, source.points, capacity, inputLimit(input), [], input.referenceContext).budget })
            continue
          }
          let start = part.range.start
          while (start < part.range.end) {
            let end = Math.min(part.range.end, start + Math.min(4000, inputLimit(input)))
            let boundary: DocumentPlanSuggestion['boundary'] = end === part.range.end ? 'end' : 'capacity'
            const selected = this.boundary(source.points, start, end, part.range.end)
            end = selected.end; boundary = selected.boundary
            let item: ChunkPlanItem, budget: DocumentChunkBudget
            for (;;) {
              item = { chunkId: `suggested-${items.length + 1}`, outputRange: { start, end }, mode: 'translate', contextRanges: [] }
              try { budget = this.budget(preparation, item, source.points, capacity, inputLimit(input), [], input.referenceContext).budget; break }
              catch (error) {
                if (end - start <= 1 || !['context_capacity', 'output_capacity', 'input_package_limit', 'term_range_budget'].includes((error as { code?: string }).code ?? '')) throw error
                const reduced = start + Math.max(1, Math.floor((end - start) * 0.75))
                const smaller = this.boundary(source.points, start, reduced, part.range.end)
                end = smaller.end; boundary = smaller.boundary
              }
            }
            items.push({ item, boundary, budget }); start = end
            if (items.length > MAX_DOCUMENT_PLAN_CHUNKS) throw reject('chunk_budget_exceeded', '实际容量需要超过 256 个计划块，请调整固定模型、范围或背景；没有截断原稿。')
          }
          if (items.length > MAX_DOCUMENT_PLAN_CHUNKS) throw reject('chunk_budget_exceeded', '建议包含超过 256 个计划块。')
        }
        if (items.length > MAX_DOCUMENT_PLAN_CHUNKS) throw reject('chunk_budget_exceeded', '建议包含超过 256 个计划块。')
        const budget = callBudget(input.analysis.actualCalls, items.map(item => item.item))
        record = frozen({ id: preparedId, signature, cursorToken: crypto.randomUUID(), items,
          summary: { target: request.target, preparationRef: request.preparationRef, suggestionRef: { id: preparedId, version: 1 }, capacity, callBudget: budget,
            totalCodePoints: preparation.totalCodePoints, sourceBytes: source.bytes, suggestionOnly: true, executionStarted: false, executionAvailable: false } })
        this.suggestions.set(suggestionKey, record)
      }
      return this.page(record!.items, record!.cursorToken, 'suggestions', request.cursor, request.limit,
        (items, nextCursor) => ({ ...record!.summary, items, nextCursor })) as AnalysisResult<DocumentPlanSuggestionPage>
    } catch (error) { return errorResult(error) }
    finally { this.adapter.discard(preparedId) }
  }
  /** Bounded search within one proposed block, retaining paragraphs and punctuation with their source positions. */
  private boundary(points: readonly string[], start: number, maximumEnd: number, partitionEnd: number): { readonly end: number; readonly boundary: DocumentPlanSuggestion['boundary'] } {
    if (maximumEnd >= partitionEnd) return { end: partitionEnd, boundary: 'end' }
    const minimum = start + Math.max(1, Math.floor((maximumEnd - start) / 2))
    let paragraph = 0, sentence = 0
    for (let at = maximumEnd - 1; at >= minimum; at--) {
      const char = points[at]!
      if (char === '\n') {
        const next = points.slice(at + 1, Math.min(at + 81, points.length)).join('')
        if (/^(?:\s*第[^\n]{1,32}[章节卷部]|\s*#{1,6}\s|\s*(?:chapter|part)\s+\S)/iu.test(next)) return { end: at + 1, boundary: 'chapter' }
        if (!paragraph && (points[at - 1] === '\n' || points[at - 1] === '\r' && points[at - 2] === '\n')) paragraph = at + 1
      }
      if (!sentence && /^[。！？.!?]$/u.test(char) && (at + 1 >= points.length || /^[\s”’"')）\]]$/u.test(points[at + 1]!))) sentence = at + 1
    }
    return paragraph ? { end: paragraph, boundary: 'paragraph' } : sentence ? { end: sentence, boundary: 'sentence' } : { end: maximumEnd, boundary: 'capacity' }
  }

  async set(input: DocumentPlanningInput, request: TranslationPlanSet, signal = new AbortController().signal): Promise<AnalysisResult<DocumentPlanReceipt>> {
    const preparedId = `document-plan:${crypto.randomUUID()}`, planKey = key(request.target, request.planId), operationKey = key(request.target, request.operationId)
    const signature = JSON.stringify(request)
    if (this.locks.has(planKey) || this.locks.has(operationKey)) return bad('busy', '此计划或操作正在核验，请查询原操作。')
    this.locks.add(planKey); this.locks.add(operationKey)
    try {
      const preparation = this.check(input, request.target, request.preparationRef), repeated = this.operations.get(operationKey)
      if (repeated) return repeated.signature === signature ? ok(repeated.record.receipt) : bad('idempotency_conflict', '此操作标识已绑定另一计划内容。')
      const existing = this.plans.get(planKey) ?? [], previous = existing[existing.length - 1]
      if ((previous?.plan.version ?? 0) !== request.expectedVersion) return bad('stale_version', '计划已变化，请读取当前版本后重新提交明确的新计划。')
      if (previous && !same(previous.target, request.target)) return bad('source_mismatch', '计划标识已绑定另一固定材料。')
      const protectedRanges = request.protectedRanges ?? previous?.protectedRanges ?? []
      let items: readonly ChunkPlanItem[], adopted: SuggestionRecord | undefined
      if (request.suggestionRef) {
        adopted = [...this.suggestions.values()].find(record => record.id === request.suggestionRef!.id)
        if (!adopted || request.suggestionRef.version !== 1) return bad('suggestion_not_found', '程序分块建议不存在或版本无效；请重新建议。')
        if (!same(adopted.summary.target, request.target) || !same(adopted.summary.preparationRef, request.preparationRef)) return bad('suggestion_mismatch', '建议不属于此固定材料或准备版本。')
        if (adopted.signature !== this.suggestionSignature(preparation, input)) return bad('suggestion_stale', '建议对应的原稿、准备、分析事实或单次上限已变化；请重新建议。')
        if (adopted.summary.totalCodePoints !== preparation.totalCodePoints) return bad('suggestion_stale', '建议的固定源规模与当前准备不一致；请重新建议。')
        items = adopted.items.map(item => item.item)
      } else items = request.items
      const plan = parseDocumentChunkPlan({ id: request.planId, version: request.expectedVersion + 1, sourceVersion: request.target.sourceVersion,
        preparationRef: request.preparationRef, items, protectedRanges,
        createdAt: new Date().toISOString(), operationId: request.operationId }, preparation.totalCodePoints)
      this.validatePlan(preparation, plan, protectedRanges)
      const source = await this.source(input, preparation, signal), capacity = await this.capacity(input, preparation, preparedId, signal)
      if (adopted && (!same(capacity, adopted.summary.capacity) || source.bytes !== adopted.summary.sourceBytes)) return bad('suggestion_stale', '实际模型容量或固定源字节已变化；请重新建议后再采用。')
      const budgets = plan.items.map(item => {
        try { return this.budget(preparation, item, source.points, capacity, inputLimit(input), protectedRanges, input.referenceContext).budget }
        catch (error) {
          const protection = item.mode === 'translate' ? protectedRanges.find(range => overlap(range, item.outputRange)) : undefined
          if (protection && ['single_input_limit', 'context_capacity', 'output_capacity', 'input_package_limit'].includes((error as { code?: string }).code ?? '')) {
            throw reject('protected_capacity_conflict', `保护范围 [${protection.start},${protection.end}) 的不可拆分 translate 块 ${item.chunkId} 容量不足：${(error as Error).message} 请将整保护区 copy 或调整模型/背景。`)
          }
          throw error
        }
      })
      const calls = callBudget(input.analysis.actualCalls, plan.items)
      const receipt: DocumentPlanReceipt = { target: request.target, planId: plan.id, version: plan.version, preparationRef: plan.preparationRef,
        sourceVersion: plan.sourceVersion, route: capacity.route, capacity, totalCodePoints: preparation.totalCodePoints, sourceBytes: source.bytes,
        chunkCount: plan.items.length, translateChunkCount: calls.plannedTranslationCalls, copyChunkCount: plan.items.length - calls.plannedTranslationCalls,
        callBudget: calls, budgetReady: true, executionStarted: false, executionAvailable: false, storage: 'runtime_only', restartExecutable: false, createdAt: plan.createdAt }
      if (documentPlanningBytes(ok(receipt)) > MAX_DOCUMENT_PLAN_PAGE_BYTES) throw reject('reply_too_large', '完整计划状态超过 32768 字节，未创建计划。')
      const record = frozen({ target: request.target, sourceSha256: preparation.sourceSha256, plan, protectedRanges: structuredClone(protectedRanges),
        budgets, receipt, cursorToken: crypto.randomUUID() })
      for (const [section, items] of [['items', plan.items], ['budgets', budgets], ['protected', protectedRanges]] as const) {
        for (const item of items) if (documentPlanningBytes(ok({ target: request.target, planId: plan.id, version: plan.version, section, items: [item], nextCursor: `${record.cursorToken}:${section}:256` })) > MAX_DOCUMENT_PLAN_PAGE_BYTES) throw reject('page_too_large', '单项完整计划范围或预算超过 32768 字节，未创建计划。')
      }
      signal.throwIfAborted()
      if (!input.isCurrent()) throw reject('scope_mismatch', '固定材料或主 Agent 在计划核验完成前已失效。', 'authorize_plan')
      this.plans.set(planKey, [...existing, record]); this.operations.set(operationKey, { signature, record })
      return ok(record.receipt)
    } catch (error) {
      if (error instanceof TypeError) return bad('invalid_plan', '计划必须按固定原稿顺序完整覆盖；块、上下文、保护区或元数据超过限额。')
      return errorResult(error)
    } finally { this.adapter.discard(preparedId); this.locks.delete(planKey); this.locks.delete(operationKey) }
  }
  private lookup(query: TranslationPlanQuery): AnalysisResult<PlanningRecord> {
    const record = this.plans.get(key(query.target, query.planId))?.find(item => item.plan.version === query.version)
    return record && same(record.target, query.target) ? ok(record) : bad('not_found', '未找到此已授权固定材料的运行期计划版本。', 'query_plan')
  }
  /** Recheck the actual prepared route and all complete prompts before business admission. */
  async freezeExecution(input: DocumentPlanningInput, query: TranslationPlanQuery, preparationRef: VersionReference,
    signal = new AbortController().signal): Promise<AnalysisResult<DocumentExecutionFreeze>> {
    const preparedId = `document-admission:${crypto.randomUUID()}`
    try {
      const found = this.lookup(query)
      if (!found.ok) return found
      const record = found.value, preparation = this.check(input, query.target, preparationRef)
      if (!same(preparationRef, record.plan.preparationRef) || record.sourceSha256 !== preparation.sourceSha256) throw reject('source_mismatch', '执行引用不属于此固定计划与准备版本。', 'freeze_document')
      this.validatePlan(preparation, record.plan, record.protectedRanges)
      const source = await this.source(input, preparation, signal), capacity = await this.capacity(input, preparation, preparedId, signal)
      if (!same(capacity.route, record.receipt.capacity.route)) throw reject('model_mismatch', '实际默认推理等级或路由已变化，请重新准备并规划。', 'freeze_document')
      const budgets = record.plan.items.map(item => this.budget(preparation, item, source.points, capacity,
        inputLimit(input), record.protectedRanges, input.referenceContext).budget)
      return ok(frozen({ target: record.target, sourceSha256: record.sourceSha256,
        plan: { ...record.plan, protectedRanges: record.protectedRanges },
        preparation: frozen(structuredClone(preparation)), protectedRanges: record.protectedRanges, budgets, capacity,
        callBudget: callBudget(input.analysis.actualCalls, record.plan.items) }))
    } catch (error) { return errorResult(error) }
    finally { this.adapter.discard(preparedId) }
  }
  /** The serial worker uses the exact same prompt and capacity helper as planning. */
  async readExecutionSource(input: DocumentPlanningInput, snapshot: DocumentExecutionFreeze, signal: AbortSignal): Promise<readonly string[]> {
    return (await this.source(input, snapshot.preparation, signal)).points
  }
  /** Reconstruct a saved task from persisted actual facts. No runtime plan Map or inferred analysis counts. */
  async restoreExecution(input: DocumentPlanningInput, rawPlan: DocumentChunkPlan, baseline: DocumentExecutionBaseline,
    signal: AbortSignal): Promise<AnalysisResult<DocumentExecutionFreeze>> {
    const preparedId = `document-restore:${crypto.randomUUID()}`
    try {
      const preparation = parsePreparationSnapshot(input.preparation)
      if (!input.isCurrent() || !preparation.preparationReady || !(preparation.correctionReview?.complete ?? preparation.mechanicalCoverage.complete) || !preparation.modelReview.complete ||
        preparation.conflicts.length || preparation.questions.some(question => question.decision === null)) throw reject('preparation_not_ready', '已保存准备缺少完整扫描、审阅或关键问题决策。', 'restore_document')
      if (input.restoredSource?.version !== preparation.sourceVersion || input.analysis.actualCalls !== baseline.analysisActualCalls ||
        !Number.isSafeInteger(baseline.analysisActualCalls)) throw reject('execution_baseline_missing', '已保存原稿、准备与实际分析事实不一致。', 'restore_document')
      const plan = parseDocumentChunkPlan(rawPlan, preparation.totalCodePoints), protectedRanges = plan.protectedRanges ?? []
      if (plan.sourceVersion !== preparation.sourceVersion || !same(plan.preparationRef, { id: preparation.id, version: preparation.version })) throw reject('source_mismatch', '已保存计划未引用确切原稿和准备版本。', 'restore_document')
      this.validatePlan(preparation, plan, protectedRanges)
      const source = await this.source(input, preparation, signal)
      const capacity = await this.adapter.prepareDocumentCapacity(preparedId, model(baseline.route), signal)
      if (!same(capacity.route, baseline.route)) throw reject('model_mismatch', '实际模型路由与已保存默认推理等级不一致，请明确更新准备与规划。', 'restore_document')
      const budgets = plan.items.map(item => this.budget(preparation, item, source.points, capacity, inputLimit(input), protectedRanges, input.referenceContext).budget)
      if (!same(budgets.map(item => ({ chunkId: item.chunkId, contextRef: item.contextRef })), baseline.contextBindings)) throw reject('context_mismatch', '已保存调用上下文无法按确切准备和计划重建。', 'restore_document')
      return ok(frozen({ target: preparation.target, sourceSha256: preparation.sourceSha256, plan, preparation, protectedRanges, budgets, capacity,
        callBudget: callBudget(baseline.analysisActualCalls, plan.items) }))
    } catch (error) { return errorResult(error) }
    finally { this.adapter.discard(preparedId) }
  }
  /** An explicit task route change freezes a new actual capacity, while old analysis/call facts stay immutable. */
  async rerouteExecution(input: DocumentPlanningInput, snapshot: DocumentExecutionFreeze, route: TranslationMaterialRoute,
    signal: AbortSignal): Promise<AnalysisResult<DocumentExecutionFreeze>> {
    const preparedId = `document-route:${crypto.randomUUID()}`
    try {
      const source = await this.source(input, snapshot.preparation, signal)
      const capacity = await this.adapter.prepareDocumentCapacity(preparedId, model(route), signal)
      if (capacity.route.provider !== route.provider || capacity.route.model !== route.model || route.reasoningEffort !== undefined && route.reasoningEffort !== capacity.route.reasoningEffort) throw reject('model_mismatch', '明确新模型与实际准备路由不一致。', 'update_document')
      const budgets = snapshot.plan.items.map(item => this.budget(snapshot.preparation, item, source.points, capacity, inputLimit(input), snapshot.protectedRanges, input.referenceContext).budget)
      return ok(frozen({ ...snapshot, capacity, budgets }))
    } catch (error) { return errorResult(error) }
    finally { this.adapter.discard(preparedId) }
  }
  async reconstructExecution(input: DocumentPlanningInput, snapshot: DocumentExecutionFreeze, chunkId: string,
    capacity: DocumentPreparedCapacity, signal: AbortSignal, frozenSource?: readonly string[]): Promise<AnalysisResult<DocumentTranslationPrompt>> {
    try {
      if (!same(capacity.route, snapshot.capacity.route)) throw reject('model_mismatch', '执行时实际模型路由或默认推理等级已变化。', 'prepare_document')
      const item = snapshot.plan.items.find(item => item.chunkId === chunkId)
      if (!item || item.mode === 'copy') return bad('copy_has_no_call', 'copy 块不装配模型提示。', 'prepare_document')
      signal.throwIfAborted()
      if (!input.isCurrent()) throw reject('scope_mismatch', '整篇原会话或源授权已失效。', 'prepare_document')
      const points = frozenSource ?? (await this.source(input, snapshot.preparation, signal)).points
      const assembled = this.budget(snapshot.preparation, item, points, capacity, inputLimit(input), snapshot.protectedRanges, input.referenceContext)
      const expected = snapshot.budgets.find(item => item.chunkId === chunkId)
      if (!expected || !same(assembled.budget.contextRef, expected.contextRef)) throw reject('context_mismatch', '实际上下文引用与受理时冻结集合不一致。', 'prepare_document')
      return ok(assembled.prompt!)
    } catch (error) { return errorResult(error) }
  }
  status(query: TranslationPlanQuery): AnalysisResult<DocumentPlanReceipt> { const found = this.lookup(query); return found.ok ? ok(found.value.receipt) : found }
  read(request: TranslationPlanRead): AnalysisResult<DocumentPlanPage> {
    const found = this.lookup(request)
    if (!found.ok) return found
    const record = found.value, items = request.section === 'items' ? record.plan.items : request.section === 'budgets' ? record.budgets : record.protectedRanges
    return this.page<ChunkPlanItem | DocumentChunkBudget | TranslationSourceRange>(items, record.cursorToken, request.section, request.cursor, request.limit,
      (items, nextCursor) => ({ target: request.target, planId: request.planId, version: request.version, section: request.section, items, nextCursor })) as AnalysisResult<DocumentPlanPage>
  }
  /** Audit reconstruction from exact preparation/source refs. This does not prepare or execute another call. */
  async reconstruct(input: DocumentPlanningInput, query: TranslationPlanQuery, chunkId: string, signal = new AbortController().signal): Promise<AnalysisResult<DocumentTranslationPrompt>> {
    try {
      const found = this.lookup(query)
      if (!found.ok) return found
      const record = found.value, preparation = this.check(input, query.target, record.plan.preparationRef)
      if (record.sourceSha256 !== preparation.sourceSha256) throw reject('source_mismatch', '计划的源校验已变化。')
      const item = record.plan.items.find(item => item.chunkId === chunkId)
      if (!item) return bad('not_found', '未找到计划块。')
      if (item.mode === 'copy') return bad('copy_has_no_call', 'copy 块只引用原稿范围，不存在模型提示或调用记录。')
      const source = await this.source(input, preparation, signal)
      const assembled = this.budget(preparation, item, source.points, record.receipt.capacity, inputLimit(input), record.protectedRanges, input.referenceContext)
      return ok(assembled.prompt!)
    } catch (error) { return errorResult(error) }
  }
  dispose(): void { this.plans.clear(); this.operations.clear(); this.suggestions.clear(); this.locks.clear() }
}
