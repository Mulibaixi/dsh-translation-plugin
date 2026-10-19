import { parseDocumentAcceptRequest, parseDocumentBlockRegistration, parseDocumentTaskEvent, parseDocumentTaskFinish, parseDocumentTaskScope,
  MAX_DOCUMENT_OUTPUT_BYTES, type DocumentAcceptRequest, type DocumentBlockRegistration, type DocumentBlockReceipt,
  parseDocumentTaskRelease, type DocumentTaskEvent, type DocumentTaskFinish, type DocumentTaskReceipt, type DocumentTaskRelease, type DocumentTaskScope } from '../shared/document-execution.js'
import { parseDocumentTaskControl, parseDocumentRestoreRequest, parseDocumentRestoreCapture, parseTranslationBatchControl, parseDocumentTaskReceipt, parseDocumentBatchStatusView, parseDocumentUnitSubmitResult, parseDocumentUnitQueryResult,
  type DocumentTaskControl, type DocumentRestoreRequest, type DocumentRestoreCapture, type TranslationBatchControl } from '../shared/document-execution.js'
import { documentSourceLength, parseDocumentChunkPlan, parseDocumentCallRecord, sameVersionReference, type ChunkRevision, type DocumentUnit, type DocumentExecutionFacts } from '../shared/translation-batch.js'
import { toSourceIdentity } from '../shared/translation-sources.js'
import { MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, sourceCodePointLength, type TranslationSourceRange } from '../shared/translation-source-read.js'
import type { AnalysisResult, PreparationSnapshot } from '../shared/translation-preparation.js'
import { parseDocumentUnitCaptureRequest, parseDocumentUnitCapture, parseDocumentCorrectionQuery, type DocumentCorrectionQuery, type DocumentUnitCaptureRequest, type DocumentUnitCapture } from '../shared/document-unit-capture.js'
import { parseDocumentCorrectionCommit, type DocumentCorrectionCommit, type DocumentCorrectionReceipt } from '../shared/document-correction.js'
import { parseDocumentUnitAcceptRequest, type DocumentUnitAcceptRequest } from '../shared/document-execution.js'
import { appendDocumentUnit, applyDocumentMutation, isDocumentUnit } from './translation-history.js'
import type { SessionStore } from './session-store.js'
import type { MaterialSubmissionsClient } from './material-submissions.js'
import type { PreparationStore } from './preparation-store.js'
import type { TranslationSourceReader } from './source-reader.js'
import type { TranslationSourceStorageClient } from './source-storage-client.js'
import type { NormalTranslationUnitRequest } from '../shared/normal-translation.js'

type Block = { readonly request: DocumentBlockRegistration; sequence: number; phase: 'registered' | 'claimed' | 'dispatched' | 'settled' }
type TaskRequest = Pick<DocumentAcceptRequest, 'operationId' | 'plan' | 'preparationRef' | 'contextBindings' | 'createdAt' | 'executionBaseline'> & { readonly envelope?: DocumentAcceptRequest['envelope']; readonly reuseApprovals?: DocumentUnitAcceptRequest['reuseApprovals'] }
interface Task {
  readonly signature: string
  request: TaskRequest
  readonly scope: DocumentTaskScope
  releaseLease: () => void
  releaseBridge: () => void
  release: () => void
  readonly blocks: Map<string, Block>
  readonly events: Map<number, string>
  sequence: number
  finishSequence: number | null
  outputBytes: number
  historySaved: boolean
  sourceSaved: boolean
  preparationSaved: boolean
  preparationStorageError: string | null
  storageError: string | null
  storage: 'saved' | 'runtime_only'
}
export interface TranslationBatchRemotePort {
  status(request: import('../shared/document-execution.js').TranslationBatchStatus): Promise<unknown>
  pause(request: TranslationBatchControl): Promise<unknown>
  cancel(request: TranslationBatchControl): Promise<unknown>
  resume(request: TranslationBatchControl): Promise<unknown>
  submitUnit?(request: NormalTranslationUnitRequest): Promise<unknown>
  queryUnit?(request: NormalTranslationUnitRequest): Promise<unknown>
}
export interface DocumentTasksOptions {
  readonly canCorrectSource?: (ownerId: string, topicId: string, sessionId: string, unitId: string) => boolean
  readonly isSessionBusy?: (sessionId: string) => boolean
  readonly reader?: TranslationSourceReader
  readonly sourceStorage?: TranslationSourceStorageClient
  readonly subscribeBridge?: (listener: () => void) => () => void
  readonly bridgeReady?: (ownerId: string) => boolean
  readonly remote?: TranslationBatchRemotePort | (() => Promise<TranslationBatchRemotePort | undefined>) | undefined
  readonly publishUnit?: (ownerId: string, sessionId: string, unitId: string, sourceVersion: number) => boolean
  readonly uiLocale?: () => string | undefined
}
function bad(code: string, message: string, stage = 'document_writeback'): AnalysisResult<never> { return { ok: false, error: { code, message, stage } } }
const ok = <T>(value: T): AnalysisResult<T> => ({ ok: true, value })
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
const bytes = (text: string): number => new TextEncoder().encode(text).byteLength
function hex(value: ArrayBuffer): string { return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('') }
async function digest(value: Uint8Array<ArrayBuffer>): Promise<string> { return hex(await crypto.subtle.digest('SHA-256', value.buffer)) }
async function eventSignature(event: DocumentTaskEvent): Promise<{ readonly signature: string; readonly deltaBytes: number }> {
  if (event.kind === 'delta') {
    const encoded = new TextEncoder().encode(event.delta), deltaDigest = await digest(encoded)
    const { delta: _delta, ...metadata } = event
    return { signature: await digest(new TextEncoder().encode(JSON.stringify({ ...metadata, deltaDigest }))), deltaBytes: encoded.byteLength }
  }
  return { signature: await digest(new TextEncoder().encode(JSON.stringify(event))), deltaBytes: 0 }
}
function contexts(snapshot: PreparationSnapshot, output: TranslationSourceRange, declared: readonly TranslationSourceRange[]): readonly TranslationSourceRange[] {
  const merged: TranslationSourceRange[] = []
  for (const range of [...snapshot.backgroundRanges, ...declared].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = merged.at(-1)
    if (last && range.start <= last.end) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, range.end) }
    else merged.push({ ...range })
  }
  return merged.flatMap(range => range.start >= output.end || range.end <= output.start ? [range]
    : [{ start: range.start, end: Math.min(range.end, output.start) }, { start: Math.max(range.start, output.end), end: range.end }].filter(range => range.start < range.end))
}

/** One browser admission owns one document unit. Child registrations never dispatch a model. */
export class DocumentTasksClient {
  private readonly tasks = new Map<string, Task>()
  private readonly admissions = new Map<string, { readonly signature: string; readonly promise: Promise<AnalysisResult<DocumentTaskReceipt>> }>()
  private readonly stopBridge: (() => void) | undefined
  private disposed = false
  private readonly controlsPending = new Map<string, Set<'pause' | 'cancel' | 'resume' | 'status'>>()
  private readonly noticeOwners = new Map<string, string>()
  private readonly notices = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private readonly correctedRetains = new Map<string, () => void>()
  private readonly unitRequests = new Map<string, { readonly request: NormalTranslationUnitRequest; readonly previousTasks: readonly string[];
    pending: boolean; unknown: boolean; outcome: 'pending' | 'submitted' | 'accepted' | 'failed' | 'unknown'; message: string; release?: (() => void) | undefined }>()
  private readonly stopStore: () => void
  constructor(private readonly store: SessionStore, private readonly materials: MaterialSubmissionsClient, private readonly preparations: PreparationStore,
    private readonly retain: (ownerId: string) => () => void, private readonly options: DocumentTasksOptions = {}) {
    this.stopBridge = options.subscribeBridge?.(() => {
      for (const task of this.tasks.values()) if (this.options.bridgeReady?.(task.scope.scope.ownerId) === false) {
        const unit = this.unit(task), state = unit?.tasks.find(item => item.taskId === task.scope.taskId)
        if (state && ['running', 'unknown'].includes(state.status)) this.store.updateTranslationHistory(task.scope.scope.translationSessionId,
          history => applyDocumentMutation(history, task.scope.unitId, { kind: 'task_update', taskId: task.scope.taskId, status: 'unknown' }, new Date().toISOString()))
      }
    })
    this.stopStore = store.subscribe(() => {
      let changed = false
      for (const item of this.unitRequests.values()) {
        const target = item.request.target, unit = this.store.getTranslationHistory(target.translationSessionId)?.units.find(unit => unit.id === target.unitId)
        if (unit && isDocumentUnit(unit) && unit.tasks.some(task => !item.previousTasks.includes(task.taskId)) && item.outcome !== 'accepted') {
          item.pending = false; item.unknown = false; item.outcome = 'accepted'; item.message = '文档重译已受理。'; item.release?.(); delete item.release; changed = true
        }
      }
      if (changed) this.emit()
    })
    materials.setDocumentRemovalGuard((sessionId, unitId) => {
      const intent = this.unitRequests.get(JSON.stringify([sessionId, unitId]))
      if (intent && (intent.pending || intent.unknown || intent.outcome === 'submitted')) return '此文档还有待确认的重译意图，请先查询或等待业务受理。'
      const session = this.store.getSession(sessionId), unit = this.store.getTranslationHistory(sessionId)?.units.find(unit => unit.id === unitId)
      if (session && unit && isDocumentUnit(unit) && unit.tasks.some(task => this.controlsPending.get(this.key(session.ownerId, task.taskId))?.size)) return '任务控制尚在处理中，请等待确切回执。'
      return undefined
    })
  }
  private key(ownerId: string, taskId: string): string { return JSON.stringify([ownerId, taskId]) }
  private unit(task: Task): DocumentUnit | undefined {
    const unit = this.store.getTranslationHistory(task.scope.scope.translationSessionId)?.units.find(unit => unit.id === task.scope.unitId)
    return unit && isDocumentUnit(unit) ? unit : undefined
  }
  private locate(ownerId: string, scope: DocumentTaskScope): Task | undefined {
    const task = this.tasks.get(this.key(ownerId, scope.taskId)), session = this.store.getSession(scope.scope.translationSessionId)
    return !this.disposed && task && same(task.scope, scope) && scope.scope.ownerId === ownerId && scope.scope.mainSessionId === ownerId && session &&
      session.ownerId === ownerId && session.topicId === scope.scope.topicId && !this.store.isSessionDeleted(session.id) && !this.materials.fileAccessBlockedReason(session.id, scope.unitId) ? task : undefined
  }
  private receipt(task: Task): DocumentTaskReceipt {
    const request = task.request, record = this.unit(task)!.tasks.find(item => item.taskId === task.scope.taskId)!, status = record.status, facts = record.executionFacts
    return { ...task.scope, operationId: request.operationId, sourceVersion: record.sourceVersion,
      planRef: { id: request.plan.id, version: request.plan.version }, preparationRef: request.preparationRef,
      taskSequence: task.sequence, status, storage: task.storage === 'saved' && this.store.getSettings().rememberHistory && this.store.getStatus(task.scope.scope.translationSessionId) === 'saved' ? 'saved' : 'runtime_only',
      storageError: task.storage === 'saved' && !this.store.getSettings().rememberHistory ? '历史保存已关闭；后续事实仅保留在当前运行期。' : task.storageError,
      restartExecutable: Boolean(facts && task.storage === 'saved'), ...(facts ? { taskVersion: facts.taskVersion, hostGeneration: [...facts.controls].reverse().find(control => control.baseline)?.baseline?.hostGeneration ?? facts.baseline.hostGeneration } : {}) }
  }
  private facts(task: Task): DocumentExecutionFacts | undefined { return this.unit(task)?.tasks.find(item => item.taskId === task.scope.taskId)?.executionFacts }
  private progressedFacts(task: Task, sequence: number, outputBytes = task.outputBytes, actualCall = false): DocumentExecutionFacts | undefined {
    const facts = this.facts(task)
    return facts && { ...facts, taskSequence: sequence, outputBytes, actualCalls: facts.actualCalls + Number(actualCall), blocks: [...task.blocks.values()].map(block => ({ request: block.request, sequence: block.sequence, phase: block.phase })) }
  }
  async captureDocument(ownerId: string, raw: DocumentUnitCaptureRequest): Promise<AnalysisResult<DocumentUnitCapture>> {
    let request: DocumentUnitCaptureRequest
    try { request = parseDocumentUnitCaptureRequest(raw) } catch { return bad('invalid_input', '文档捕获参数无效。', 'capture_document') }
    const blocked = this.materials.fileAccessBlockedReason(request.target.translationSessionId, request.target.unitId)
    if (blocked) return bad('unit_removed_or_conflicted', blocked, 'capture_document')
    const target = request.target, session = this.store.getSession(target.translationSessionId), unit = this.store.getTranslationHistory(target.translationSessionId)?.units.find(unit => unit.id === target.unitId)
    if (this.disposed || target.mainSessionId !== ownerId || !session || session.ownerId !== ownerId || !unit || !isDocumentUnit(unit) || session.mode !== 'normal' || this.store.isSessionDeleted(session.id)) return bad('scope_mismatch', '文档捕获不属于此实际主会话。', 'capture_document')
    if (this.store.getStatus(session.id) === 'conflict') return bad('history_conflict', '当前历史副本已变化。', 'capture_document')
    const source = unit.sourceVersions.find(source => source.version === target.sourceVersion)
    if (!source) return bad('source_version_missing', '准确原稿版本不存在。', 'capture_document')
    const scope = { ownerId, mainSessionId: ownerId, topicId: session.topicId, translationSessionId: session.id }
    const reference = request.preparationRef ?? [...unit.preparations].reverse().find(preparation => preparation.sourceVersion === target.sourceVersion) ?? unit.preparations.at(-1)
    let preparation: PreparationSnapshot | null = null
    if (reference) {
      const actual = unit.preparations.find(item => sameVersionReference(item, reference)), preparedSource = actual && unit.sourceVersions.find(source => source.version === actual.sourceVersion)
      if (!actual || !preparedSource) return bad('preparation_not_found', '此准备引用不属于该文档。', 'capture_document')
      const hash = preparedSource.body.kind === 'asset' ? preparedSource.body.reference.sha256 : await digest(new TextEncoder().encode(preparedSource.body.text))
      const prepared = this.preparations.documentUnitPreparation(scope, reference, hash, request.requireReady ?? false)
      if (!prepared.ok) return prepared
      preparation = prepared.value
      if (request.requireReady && preparation.sourceVersion !== target.sourceVersion) return bad('preparation_not_ready', '新原稿的准备尚待明确复核。', 'capture_document')
    }
    const selected = request.revisionIds ?? [], chunks = unit.chunkRevisions.filter(chunk => selected.includes(chunk.id)).map(({ content, ...chunk }) => ({ ...chunk,
      completeResult: chunk.status === 'completed' && (content.kind === 'source_copy' || Boolean(content.text)), outputBytes: content.kind === 'text' ? new TextEncoder().encode(content.text).byteLength : null }))
    if (selected.some(id => !chunks.some(chunk => chunk.id === id))) return bad('chunk_not_found', '请求的准确旧块不存在。', 'capture_document')
    const sourceRestore = source.body.kind === 'asset' ? await this.store.readStoredSourceRequest({ sessionId: session.id, unitId: unit.id, sourceVersion: source.version }) : null
    const latestTask = unit.tasks.at(-1), latestPlan = [...unit.plans].reverse().find(plan => plan.sourceVersion === target.sourceVersion)
    const capture: DocumentUnitCapture = { scope, unitId: unit.id, currentSourceVersion: unit.sourceVersion, source, preparation, preparations: unit.preparations.filter(item => reference && sameVersionReference(item, reference)),
      plans: unit.plans.filter(plan => plan === latestPlan || chunks.some(chunk => sameVersionReference(plan, chunk.planRef))), chunks,
      tasks: unit.tasks.filter(task => task.sourceVersion === target.sourceVersion || task === latestTask).map(task => ({ taskId: task.taskId, sourceVersion: task.sourceVersion, status: task.status, taskVersion: task.executionFacts?.taskVersion ?? 1,
        taskSequence: task.executionFacts?.taskSequence ?? 0, unsettled: Boolean(task.executionFacts?.blocks.some(block => block.phase !== 'settled')),
        baseline: (() => { const baseline = [...(task.executionFacts?.controls ?? [])].reverse().find(control => control.baseline)?.baseline ?? task.executionFacts?.baseline
          return baseline ? { hostGeneration: baseline.hostGeneration, route: baseline.route, capacity: baseline.capacity, analysisActualCalls: baseline.analysisActualCalls, maxInputChars: baseline.maxInputChars } : null })() })),
      corrections: unit.corrections ?? [], hasSourceObjects: this.options.canCorrectSource?.(ownerId, session.topicId, session.id, unit.id) === false,
      ...(sourceRestore ? { sourceRestore } : {}) }
    try { return ok(parseDocumentUnitCapture(capture)) } catch { return bad('capture_too_large', '文档捕获身份、引用或完整传输包无效。', 'capture_document') }
  }
  async observeCorrection(ownerId: string, raw: DocumentCorrectionQuery): Promise<AnalysisResult<DocumentCorrectionReceipt | null>> {
    let request: DocumentCorrectionQuery
    try { request = parseDocumentCorrectionQuery(raw) } catch { return bad('invalid_input', '纠错查询参数无效。') }
    const blocked = this.materials.fileAccessBlockedReason(request.scope.translationSessionId, request.unitId)
    if (blocked) return bad('unit_removed_or_conflicted', blocked)
    const scope = request.scope, session = this.store.getSession(scope.translationSessionId), unit = this.store.getTranslationHistory(scope.translationSessionId)?.units.find(unit => unit.id === request.unitId)
    if (this.disposed || scope.ownerId !== ownerId || scope.mainSessionId !== ownerId || !session || session.ownerId !== ownerId || session.topicId !== scope.topicId || !unit || !isDocumentUnit(unit) || this.store.isSessionDeleted(session.id)) return bad('scope_mismatch', '纠错查询不属于当前授权范围。')
    const fact = unit.corrections?.find(fact => fact.operationId === request.operationId)
    if (!fact) return ok(null)
    const source = unit.sourceVersions.find(source => source.version === fact.toSourceVersion)!, saved = this.store.getSettings().rememberHistory && this.store.getStatus(session.id) === 'saved' && await this.sourceConfirmed(session.id, unit.id, source)
    return ok({ scope, unitId: unit.id, operationId: request.operationId, sourceVersion: source.version, storage: saved ? 'saved' : 'runtime_only', storageError: saved ? null : '纠错已记录，保存状态未确认。' })
  }
  private async sourceConfirmed(sessionId: string, unitId: string, source: DocumentUnit['sourceVersions'][number]): Promise<boolean> {
    if (source.body.kind === 'inline') return true
    if (!source.historyCommit || !this.options.sourceStorage || !await this.store.readStoredSourceRequest({ sessionId, unitId, sourceVersion: source.version })) return false
    try { return (await this.options.sourceStorage.queryPersistedReference(source.historyCommit)).state === 'confirmed' } catch { return false }
  }
  async correctSource(ownerId: string, raw: DocumentCorrectionCommit): Promise<AnalysisResult<DocumentCorrectionReceipt>> {
    let request: DocumentCorrectionCommit
    try { request = parseDocumentCorrectionCommit(raw) } catch { return bad('invalid_input', '文档纠错写回参数无效。', 'correct_document_source') }
    const blocked = this.materials.fileAccessBlockedReason(request.scope.translationSessionId, request.unitId)
    if (blocked) return bad('unit_removed_or_conflicted', blocked, 'correct_document_source')
    const scope = request.scope, session = this.store.getSession(scope.translationSessionId), unit = this.store.getTranslationHistory(scope.translationSessionId)?.units.find(unit => unit.id === request.unitId)
    if (this.disposed || scope.ownerId !== ownerId || scope.mainSessionId !== ownerId || !session || session.ownerId !== ownerId || session.topicId !== scope.topicId || !unit || !isDocumentUnit(unit) || this.store.isSessionDeleted(session.id)) return bad('scope_mismatch', '文档纠错不属于当前授权范围。', 'correct_document_source')
    if (this.store.getStatus(session.id) === 'conflict') return bad('history_conflict', '历史副本已变化，未修改原稿。', 'correct_document_source')
    if (this.options.canCorrectSource?.(ownerId, scope.topicId, session.id, unit.id) === false) return bad('object_source_unsupported', '此原稿含对象位置关联，不能自动纠错。', 'correct_document_source')
    const previous = unit.corrections?.find(fact => fact.operationId === request.fact.operationId)
    if (previous && (!same(previous, request.fact) || !same(unit.sourceVersions.find(source => source.version === previous.toSourceVersion)?.body, request.source.body))) return bad('idempotency_conflict', '纠错操作已绑定其他事实。')
    if (!previous && (unit.sourceVersion !== request.expectedSourceVersion || unit.tasks.some(task => task.sourceVersion === unit.sourceVersion && (['running', 'unknown'].includes(task.status) || task.executionFacts?.blocks.some(block => block.phase !== 'settled'))))) return bad('prior_call_unconfirmed', '原稿版本已变化或旧调用未结算，未追加原稿。', 'correct_document_source')
    if (!previous && !this.store.updateTranslationHistory(session.id, history => applyDocumentMutation(history, unit.id, { kind: 'correction', expectedVersion: request.expectedSourceVersion, source: request.source, fact: request.fact }, request.fact.createdAt))) return bad('history_update_failed', '新原稿 CAS 未完成。', 'correct_document_source')
    const retainKey = JSON.stringify([ownerId, session.id, unit.id])
    if (!this.correctedRetains.has(retainKey)) this.correctedRetains.set(retainKey, this.retain(ownerId))
    for (const task of this.tasks.values()) if (task.scope.unitId === unit.id && task.scope.scope.translationSessionId === session.id && task.request.plan.sourceVersion === request.expectedSourceVersion) task.release()
    let saved = false, storageError: string | null = '历史保存已关闭，新原稿仅保留在当前运行期。'
    if (this.store.getSettings().rememberHistory) {
      saved = await this.store.saveTranslationHistoryAsync(session.id)
      if (saved && request.source.body.kind === 'asset' && this.options.sourceStorage) {
        const result = await this.options.sourceStorage.save({ prepare: { scope, sourceRef: { ...request.source.body.reference, persistence: 'runtime_only' }, referenceKey: `document-source:${unit.id}:${request.source.version}`, operationId: `document-source-prepare:${request.fact.operationId}` },
          confirmOperationId: `document-source-confirm:${request.fact.operationId}` }, this.store.createSourceHistoryCallbacks({ sessionId: session.id, unitId: unit.id, sourceVersion: request.source.version }))
        saved = result.state === 'confirmed'
      }
      storageError = saved ? null : '新原稿或历史保存未确认；当前运行期仍可读取。'
    }
    return ok({ scope, unitId: unit.id, operationId: request.fact.operationId, sourceVersion: request.source.version, storage: saved ? 'saved' : 'runtime_only', storageError })
  }
  async acceptUnit(ownerId: string, raw: DocumentUnitAcceptRequest): Promise<AnalysisResult<DocumentTaskReceipt>> {
    let request: DocumentUnitAcceptRequest
    try { request = parseDocumentUnitAcceptRequest(raw) } catch { return bad('invalid_input', '文档新版本受理参数无效。', 'accept_document') }
    const blocked = this.materials.fileAccessBlockedReason(request.target.translationSessionId, request.target.unitId)
    if (blocked) return bad('unit_removed_or_conflicted', blocked, 'accept_document')
    const target = request.target, session = this.store.getSession(target.translationSessionId), history = this.store.getTranslationHistory(target.translationSessionId), unit = history?.units.find(unit => unit.id === target.unitId), key = this.key(ownerId, request.taskId), signature = JSON.stringify(request)
    const existing = this.tasks.get(key)
    if (existing) return existing.signature === signature ? ok(this.receipt(existing)) : bad('idempotency_conflict', '新版本任务已绑定其他准备或计划。')
    if (this.disposed || target.mainSessionId !== ownerId || !session || session.ownerId !== ownerId || session.mode !== 'normal' || !unit || !isDocumentUnit(unit) || unit.sourceVersion !== target.sourceVersion || this.store.isSessionDeleted(session.id)) return bad('stale_source_version', '文档新版本不属于当前准确原稿。', 'accept_document')
    if (this.store.getStatus(session.id) === 'conflict' || this.options.isSessionBusy?.(session.id) || this.store.hasDocumentLease(session.id) || unit.tasks.some(task => task.sourceVersion === unit.sourceVersion && ['running', 'unknown'].includes(task.status))) return bad('busy', '当前会话已有运行中或未知任务。', 'accept_document')
    const source = unit.sourceVersions.find(source => source.version === target.sourceVersion)!, hash = source.body.kind === 'asset' ? source.body.reference.sha256 : await digest(new TextEncoder().encode(source.body.text))
    const prepared = this.preparations.documentUnitPreparation({ ownerId, mainSessionId: ownerId, topicId: session.topicId, translationSessionId: session.id }, request.preparationRef, hash, true)
    if (!prepared.ok) return prepared
    const preparation = prepared.value
    if (preparation.sourceVersion !== unit.sourceVersion || request.plan.items.at(-1)?.outputRange.end !== documentSourceLength(source)) return bad('source_mismatch', '新计划、准备与准确原稿覆盖不一致。')
    for (const [index, binding] of request.executionBaseline.contextBindings.entries()) {
      const item = request.plan.items[index]!, expected = item.mode === 'copy' ? [] : contexts(preparation, item.outputRange, item.contextRanges)
      if (!same(expected, binding.contextRef.contextRanges) || binding.contextRef.supplementRefs.length || binding.contextRef.referenceRefs.length || binding.contextRef.termRefs.some(ref => !preparation.terms.some(term => same(term.ref, ref)))) return bad('context_mismatch', '新版本实际上下文没有绑定复核准备。')
    }
    const sourceSaved = await this.sourceConfirmed(session.id, unit.id, source)
    const currentUnit = this.store.getTranslationHistory(session.id)?.units.find(current => current.id === unit.id)
    if (!currentUnit || !isDocumentUnit(currentUnit) || currentUnit.sourceVersion !== target.sourceVersion || this.store.isSessionDeleted(session.id) || this.store.getStatus(session.id) === 'conflict') return bad('stale_source_version', '原稿或历史在新任务准确受理前已变化。', 'accept_document')
    const releaseLease = this.store.claimDocumentLease(session.id, request.taskId)
    if (!releaseLease) return bad('busy', '当前会话已被另一文档占用。')
    const scope: DocumentTaskScope = { scope: { ownerId, mainSessionId: ownerId, topicId: session.topicId, translationSessionId: session.id }, taskId: request.taskId, unitId: unit.id }
    const task: Task = { signature, request: { operationId: request.operationId, plan: request.plan, preparationRef: request.preparationRef, contextBindings: request.executionBaseline.contextBindings,
      createdAt: request.createdAt, executionBaseline: request.executionBaseline, reuseApprovals: request.reuseApprovals }, scope, releaseLease, releaseBridge: this.retain(ownerId), release: () => {}, blocks: new Map(), events: new Map(), sequence: 0, finishSequence: null,
      outputBytes: request.reusedOutputBytes, historySaved: false, sourceSaved, preparationSaved: preparation.storage === 'saved', preparationStorageError: preparation.storageError, storageError: null, storage: 'runtime_only' }
    task.release = () => { task.releaseLease(); task.releaseBridge() }
    if (!this.store.updateTranslationHistory(session.id, current => {
      let next = applyDocumentMutation(current, unit.id, { kind: 'preparation', preparation: { ...request.preparationRef, sourceVersion: unit.sourceVersion } }, request.createdAt)
      next = applyDocumentMutation(next, unit.id, { kind: 'plan', plan: request.plan }, request.createdAt)
      next = applyDocumentMutation(next, unit.id, { kind: 'task', task: { taskId: request.taskId, operationId: request.operationId, sourceVersion: unit.sourceVersion,
        planRef: { id: request.plan.id, version: request.plan.version }, preparationRef: request.preparationRef, createdAt: request.createdAt, status: 'running', executionFacts: {
          baseline: request.executionBaseline, taskVersion: 1, taskSequence: 0, actualCalls: request.executionBaseline.analysisActualCalls, outputBytes: request.reusedOutputBytes, automaticSupplementCalls: 0, blocks: [], controls: [], reviewIssues: [] } } }, request.createdAt)
      for (const approval of request.reuseApprovals) next = applyDocumentMutation(next, unit.id, { kind: 'reuse', approval }, request.createdAt)
      return next
    })) { task.release(); return bad('history_update_failed', '新版本任务或复用事实未完成准确受理。') }
    this.tasks.set(key, task)
    const retainKey = JSON.stringify([ownerId, session.id, unit.id]); this.correctedRetains.get(retainKey)?.(); this.correctedRetains.delete(retainKey)
    task.historySaved = this.store.getSettings().rememberHistory && await this.store.saveTranslationHistoryAsync(session.id); this.refreshStorage(task)
    return ok(this.receipt(task))
  }
  accept(ownerId: string, raw: DocumentAcceptRequest): Promise<AnalysisResult<DocumentTaskReceipt>> {
    let request: DocumentAcceptRequest
    try { request = parseDocumentAcceptRequest(raw) } catch { return Promise.resolve(bad('invalid_input', '文档受理参数无效。', 'accept_document')) }
    const blocked = this.materials.fileAccessBlockedReason(request.envelope.material.translationSessionId, request.unitId)
    if (blocked) return Promise.resolve(bad('unit_removed_or_conflicted', blocked, 'accept_document'))
    const key = this.key(ownerId, request.taskId), signature = JSON.stringify(request), previous = this.admissions.get(key)
    if (previous) return previous.signature === signature ? previous.promise.then(result => result.ok && this.tasks.has(key) ? ok(this.receipt(this.tasks.get(key)!)) : result)
      : Promise.resolve(bad('idempotency_conflict', '同一整篇任务已经绑定其他材料或计划。', 'accept_document'))
    const promise = this.acceptOnce(ownerId, request, signature)
    this.admissions.set(key, { signature, promise })
    return promise
  }
  private async acceptOnce(ownerId: string, request: DocumentAcceptRequest, signature: string): Promise<AnalysisResult<DocumentTaskReceipt>> {
    const blocked = this.materials.fileAccessBlockedReason(request.envelope.material.translationSessionId, request.unitId)
    if (blocked) return bad('unit_removed_or_conflicted', blocked, 'accept_document')
    const envelope = this.materials.resolveSubmittedMaterial(request.envelope), material = envelope?.material, session = material && this.store.getSession(material.translationSessionId)
    if (this.disposed || !envelope || envelope.ownerId !== ownerId || envelope.mainSessionId !== ownerId || !session || session.ownerId !== ownerId || session.topicId !== material!.topicId ||
      session.mode !== 'normal' || session.archivedAt !== null || this.store.isSessionDeleted(session.id) || request.unitId !== `unit:${material!.materialId}` || !material!.model) return bad('material_mismatch', '文档需要确切已交付的普通模式材料。', 'accept_document')
    if (this.store.getStatus(session.id) === 'conflict') return bad('history_conflict', '当前历史副本已变化，未消费材料。', 'accept_document')
    const history = this.store.getTranslationHistory(session.id)!
    if (this.options.isSessionBusy?.(session.id) || this.store.hasDocumentLease(session.id) || history.units.some(unit => isDocumentUnit(unit)
      ? unit.tasks.some(task => ['running', 'unknown'].includes(task.status)) : unit.revisions.some(revision => ['submitting', 'running', 'unknown', 'context_requested'].includes(revision.status)))) return bad('busy', '此会话已有执行中或未知操作。', 'accept_document')
    if (history.units.some(unit => unit.id === request.unitId) || this.store.getAvailableSessions(ownerId).some(candidate => this.store.getTranslationHistory(candidate.id)?.events.some(event => event.operationId === request.operationId))) return bad('already_admitted', '此材料或操作已有历史事实，请查询原任务。', 'accept_document')
    const releaseLease = this.store.claimDocumentLease(session.id, request.taskId)
    if (!releaseLease) return bad('busy', '此会话已被另一翻译占用。', 'accept_document')
    const retainedBridge = this.retain(ownerId)
    let leaseHeld = true, bridgeHeld = true
    const releaseTaskLease = () => { if (leaseHeld) { leaseHeld = false; releaseLease() } }
    const releaseTaskBridge = () => { if (bridgeHeld) { bridgeHeld = false; retainedBridge() } }
    const release = () => { releaseTaskLease(); releaseTaskBridge() }
    const target = { kind: 'material' as const, mainSessionId: ownerId, requestId: envelope.requestId, materialId: material!.materialId, sourceVersion: material!.sourceVersion }
    const prepared = await this.preparations.documentPreparation({ target, preparationId: request.preparationRef.id, version: request.preparationRef.version }, envelope)
    if (!prepared.ok) { release(); return prepared }
    const snapshot = prepared.value
    if (request.executionBaseline && (!same(request.executionBaseline.contextBindings, request.contextBindings) || request.executionBaseline.maxInputChars !== material!.maxInputChars ||
      request.executionBaseline.analysisActualCalls !== this.preparations.documentAnalysisActualCalls(snapshot.scope, request.preparationRef) ||
      request.executionBaseline.route.provider !== material!.model.provider || request.executionBaseline.route.model !== material!.model.model || material!.model.reasoningEffort !== undefined && request.executionBaseline.route.reasoningEffort !== material!.model.reasoningEffort)) {
      release(); return bad('execution_baseline_mismatch', '执行基线未绑定此固定材料和真实分析调用事实。', 'accept_document')
    }
    if (this.disposed || !this.materials.resolveSubmittedMaterial(envelope) || this.store.isSessionDeleted(session.id)) { release(); return bad('scope_mismatch', '文档受理时固定材料已不可用。', 'accept_document') }
    for (const [index, binding] of request.contextBindings.entries()) {
      const item = request.plan.items[index]!, expected = item.mode === 'copy' ? [] : contexts(snapshot, item.outputRange, item.contextRanges)
      if (!same(expected, binding.contextRef.contextRanges) || binding.contextRef.supplementRefs.length || binding.contextRef.referenceRefs.length ||
        binding.contextRef.termRefs.some(ref => !snapshot.terms.some(term => same(term.ref, ref))) || item.mode === 'copy' && binding.contextRef.termRefs.length) {
        release(); return bad('context_mismatch', '块实际上下文与固定准备或计划不一致。', 'accept_document')
      }
    }
    const fileCreatedAt = this.materials.getFileCreatedAt(session.id, request.unitId) ?? request.createdAt
    const fileCommit = this.materials.getFileHistoryCommit(session.id, request.unitId)
    const source = { version: 1, body: material!.sourceRef ? { kind: 'asset' as const, reference: toSourceIdentity(material!.sourceRef) }
      : { kind: 'inline' as const, text: material!.sourceText! }, createdAt: fileCreatedAt, operationId: null,
      ...(fileCommit && material!.sourceRef && same(fileCommit.reference.source, toSourceIdentity(material!.sourceRef)) ? { historyCommit: fileCommit } : {}) }
    if (!this.store.updateTranslationHistory(session.id, current => appendDocumentUnit(current, { id: request.unitId, targetLanguage: material!.targetLanguage,
      instruction: material!.instruction, createdAt: fileCreatedAt, source, preparation: { ...request.preparationRef, sourceVersion: 1 }, plan: request.plan,
      task: { taskId: request.taskId, operationId: request.operationId, sourceVersion: 1, planRef: { id: request.plan.id, version: request.plan.version },
        preparationRef: request.preparationRef, createdAt: request.createdAt, status: 'running', ...(request.executionBaseline ? { executionFacts: {
          baseline: request.executionBaseline, taskVersion: 1, taskSequence: 0, actualCalls: request.executionBaseline.analysisActualCalls, outputBytes: 0, automaticSupplementCalls: 0, blocks: [], controls: [], reviewIssues: [] } } : {}) } }))) { release(); return bad('history_update_failed', '文档单元记录未完成，材料保留。', 'accept_document') }
    const scope: DocumentTaskScope = { scope: { ownerId, mainSessionId: ownerId, topicId: session.topicId, translationSessionId: session.id }, taskId: request.taskId, unitId: request.unitId }
    const task: Task = { signature, request: structuredClone(request), scope, releaseLease: releaseTaskLease, releaseBridge: releaseTaskBridge, release,
      blocks: new Map(), events: new Map(), sequence: 0, finishSequence: null, outputBytes: 0, historySaved: false, sourceSaved: !material!.sourceRef,
      preparationSaved: snapshot.storage === 'saved', preparationStorageError: snapshot.storageError, storage: 'runtime_only', storageError: null }
    task.release = () => { task.releaseLease(); task.releaseBridge() }
    this.tasks.set(this.key(ownerId, request.taskId), task)
    if (this.store.getSettings().rememberHistory) {
      const historySaved = await this.store.saveTranslationHistoryAsync(session.id)
      let sourceSaved = !material!.sourceRef
      if (material!.sourceRef && this.options.sourceStorage) {
        try {
          const saved = source.historyCommit ? await this.options.sourceStorage.confirmPersistedReference(source.historyCommit,
            this.store.createSourceHistoryCallbacks({ sessionId: session.id, unitId: request.unitId, sourceVersion: 1 })) : await this.options.sourceStorage.save({ prepare: { scope: scope.scope, sourceRef: material!.sourceRef,
          referenceKey: `document-source:${request.unitId}:1`, operationId: `document-source-prepare:${request.taskId}` }, confirmOperationId: `document-source-confirm:${request.taskId}` },
        this.store.createSourceHistoryCallbacks({ sessionId: session.id, unitId: request.unitId, sourceVersion: 1 }))
          sourceSaved = saved.state === 'confirmed'
        } catch { sourceSaved = false }
      }
      task.historySaved = historySaved
      task.sourceSaved = sourceSaved
      task.preparationSaved = snapshot.storage === 'saved'
      this.refreshStorage(task)
    }
    this.materials.consumeSubmittedMaterial(envelope)
    if (this.store.getSettings().rememberHistory) {
      task.historySaved = await this.store.saveTranslationHistoryAsync(session.id)
    } else task.historySaved = false
    this.refreshStorage(task)
    return ok(this.receipt(task))
  }
  private refreshStorage(task: Task): void {
    task.storage = task.historySaved && task.sourceSaved && task.preparationSaved ? 'saved' : 'runtime_only'
    task.storageError = task.storage === 'saved' ? null : !task.historySaved ? '整篇历史未确认保存；事实保留在当前运行期。'
      : !task.sourceSaved ? '原稿保存引用尚未确认；当前运行期可读取。'
        : task.preparationStorageError ?? '准备正文尚未保存；本任务仅在运行期可执行。'
  }
  register(ownerId: string, raw: DocumentBlockRegistration): AnalysisResult<DocumentBlockReceipt> {
    let request: DocumentBlockRegistration
    try { request = parseDocumentBlockRegistration(raw) } catch { return bad('invalid_input', '块登记参数无效。') }
    const task = this.locate(ownerId, { scope: request.scope, taskId: request.taskId, unitId: request.unitId })
    if (!task) return bad('task_not_found', '准确受理的整篇任务不存在。')
    const old = task.blocks.get(request.revisionId)
    const receipt = (block: Block): DocumentBlockReceipt => ({ ...task.scope, childOperationId: block.request.childOperationId, revisionId: block.request.revisionId,
      callId: block.request.callId, attemptId: block.request.attemptId, sequence: block.sequence, registered: true })
    if (old) return same(old.request, request) ? ok(receipt(old)) : bad('idempotency_conflict', '块操作已绑定其他调用或版本。')
    const unit = this.unit(task)!, item = task.request.plan.items.find(item => item.chunkId === request.chunkId)
    const completed = (chunkId: string) => Boolean(task.request.reuseApprovals?.some(approval => approval.chunkId === chunkId)) || unit.chunkRevisions.some(chunk => chunk.taskId === request.taskId && chunk.chunkId === chunkId && chunk.status === 'completed')
    if (!item || (item.mode === 'copy') !== (request.callId === null) || unit.tasks.find(item => item.taskId === request.taskId)?.status !== 'running' || completed(request.chunkId) ||
      request.planRef && !sameVersionReference(request.planRef, task.request.plan) || request.preparationRef && !sameVersionReference(request.preparationRef, task.request.preparationRef) ||
      request.contextRef && !same({ ...request.contextRef, supplementRefs: [] }, task.request.contextBindings.find(binding => binding.chunkId === request.chunkId)?.contextRef) || request.outputRange && !same(request.outputRange, item.outputRange) ||
      [...task.blocks.values()].some(block => block.phase !== 'settled' || block.request.revisionId === request.revisionId ||
        request.callId !== null && block.request.callId === request.callId || request.attemptId !== null && block.request.attemptId === request.attemptId)) return bad('invalid_state', '块未属于固定串行计划或前一块尚未结算。')
    const nextItem = task.request.plan.items.find(item => !completed(item.chunkId))
    if (nextItem?.chunkId !== request.chunkId) return bad('invalid_state', '块登记必须沿固定源顺序。')
    const block: Block = { request, sequence: 0, phase: 'registered' }
    task.blocks.set(request.revisionId, block)
    const facts = this.progressedFacts(task, task.sequence)
    if (facts && !this.store.updateTranslationHistory(task.scope.scope.translationSessionId, history => applyDocumentMutation(history, task.scope.unitId,
      { kind: 'task_facts', taskId: task.scope.taskId, facts }, request.createdAt))) { task.blocks.delete(request.revisionId); return bad('history_update_failed', '块登记事实未保存。') }
    return ok(receipt(block))
  }
  async event(ownerId: string, raw: DocumentTaskEvent): Promise<AnalysisResult<DocumentTaskReceipt>> {
    let event: DocumentTaskEvent
    try { event = parseDocumentTaskEvent(raw) } catch { return bad('invalid_input', '文档实际事件参数无效。') }
    const task = this.locate(ownerId, { scope: event.scope, taskId: event.taskId, unitId: event.unitId })
    if (!task) return bad('task_not_found', '文档任务不存在或所属范围不一致。')
    const digestResult = await eventSignature(event), signature = digestResult.signature, old = task.events.get(event.taskSequence)
    if (old) return old === signature ? ok(this.receipt(task)) : bad('idempotency_conflict', '父事件序号已有不同事实。')
    const block = task.blocks.get(event.revisionId), unit = this.unit(task)!
    if (!block || block.request.childOperationId !== event.childOperationId || event.taskSequence !== task.sequence + 1 || event.sequence !== block.sequence + 1) return bad('sequence_gap', '父或子事件有缺口；请查询原事件，未重发调用。')
    const item = task.request.plan.items.find(item => item.chunkId === block.request.chunkId)!, context = block.request.contextRef ?? task.request.contextBindings.find(binding => binding.chunkId === item.chunkId)!.contextRef
    const sourceLength = documentSourceLength(unit.sourceVersions.find(source => source.version === task.request.plan.sourceVersion)!)
    const previous = unit.chunkRevisions.find(chunk => chunk.id === event.revisionId)
    let newBytes = 0, next: ChunkRevision | undefined
    if (event.kind === 'dispatch_intent') {
      if (block.phase !== 'registered' || !block.request.callId || item.mode !== 'translate') return bad('invalid_state', '派发槽认领没有准确块登记。')
    } else if (event.kind === 'dispatched') {
      if (!(block.phase === 'claimed' || !this.facts(task) && block.phase === 'registered') || !block.request.callId || !block.request.attemptId || item.mode !== 'translate') return bad('invalid_state', '实际派发事件没有准确块登记和派发认领。')
      let call
      try { call = parseDocumentCallRecord(event.callRecord, sourceLength) } catch { return bad('invalid_call', '实际模型调用记录无效。') }
      const facts = this.facts(task), baseline = [...(facts?.controls ?? [])].reverse().find(control => control.baseline)?.baseline ?? facts?.baseline
      const route = baseline?.route ?? task.request.envelope!.material.model!
      if (call.callId !== block.request.callId || call.attemptId !== block.request.attemptId || !same(call.contextRef, context) ||
        call.model.provider !== route.provider || call.model.model !== route.model || route.reasoningEffort !== undefined && call.model.reasoningEffort !== route.reasoningEffort) return bad('call_mismatch', '实际调用身份、模型或上下文未使用受理时固定版本。')
      next = { id: event.revisionId, taskId: event.taskId, childOperationId: event.childOperationId, attemptId: call.attemptId, callId: call.callId,
        sourceVersion: task.request.plan.sourceVersion, chunkId: item.chunkId, planRef: { id: task.request.plan.id, version: task.request.plan.version },
        preparationRef: task.request.preparationRef, kind: 'machine', status: 'running', content: { kind: 'text', text: '' }, callRecord: call, createdAt: event.at, updatedAt: event.at }
    } else if (event.kind === 'copy') {
      if (block.phase !== 'registered' || item.mode !== 'copy') return bad('invalid_state', 'copy 事件没有准确本地块登记。')
      const source = unit.sourceVersions.find(source => source.version === unit.sourceVersion)!
      let text: string
      if (source.body.kind === 'inline') text = Array.from(source.body.text).slice(item.outputRange.start, item.outputRange.end).join('')
      else {
        const read = this.options.reader?.captureDocument({ ownerId, topicId: event.scope.topicId, sessionId: event.scope.translationSessionId, unitId: event.unitId, sourceVersion: unit.sourceVersion, manifestRevisionId: null })
        if (!read || 'status' in read) return bad('source_unavailable', 'copy 原稿尚不可读取，未伪记成功。')
        const parts: string[] = []
        for (let start = item.outputRange.start; start < item.outputRange.end; start += MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) {
          const page = await read.readSource({ start, end: Math.min(item.outputRange.end, start + MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) })
          if (page.status !== 'ready') return bad('source_unavailable', 'copy 精确原稿范围未读取成功。')
          parts.push(page.text)
        }
        text = parts.join('')
      }
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), value => value.toString(16).padStart(2, '0')).join('')
      if (digest !== event.sha256) return bad('copy_mismatch', 'copy 结果未引用准确原稿内容。')
      newBytes = bytes(text)
      next = { id: event.revisionId, taskId: event.taskId, childOperationId: event.childOperationId, attemptId: null, callId: null,
        sourceVersion: task.request.plan.sourceVersion, chunkId: item.chunkId, planRef: { id: task.request.plan.id, version: task.request.plan.version }, preparationRef: task.request.preparationRef,
        kind: 'copy', status: 'completed', content: { kind: 'source_copy', sourceVersion: unit.sourceVersion, range: item.outputRange, sha256: digest }, callRecord: null, createdAt: event.at, updatedAt: event.at }
    } else if (event.kind === 'settled' && !previous && ['registered', 'claimed'].includes(block.phase)) {
      if (event.status === 'completed' || event.usage.inputTokens !== null || event.usage.outputTokens !== null) return bad('invalid_state', '尚未派发的块不能伪造成功或模型用量。')
    } else {
      if (block.phase !== 'dispatched' || !previous || previous.content.kind !== 'text' || !previous.callRecord) return bad('invalid_state', '实际输出没有派发调用事实，或此块已结算。')
      if (event.kind === 'delta') {
        newBytes = digestResult.deltaBytes
        next = { ...previous, content: { kind: 'text', text: previous.content.text + event.delta }, updatedAt: event.at }
      } else {
        if (event.status === 'completed' && !previous.content.text.trim()) return bad('incomplete_result', '空输出不能记为完整翻译。')
        next = { ...previous, status: event.status, callRecord: { ...previous.callRecord, usage: event.usage }, updatedAt: event.at }
      }
    }
    if (task.outputBytes + newBytes > MAX_DOCUMENT_OUTPUT_BYTES) return bad('output_budget_exceeded', '整篇累计结果超过 16 MiB；已有残稿保留，未截断为成功。')
    const current = this.locate(ownerId, task.scope)
    if (!current || task.sequence + 1 !== event.taskSequence || block.sequence + 1 !== event.sequence) return bad('sequence_changed', '读取期间实际事件已有变化，请查询当前父子序号。')
    const nextPhase = event.kind === 'dispatch_intent' ? 'claimed' : event.kind === 'copy' || event.kind === 'settled' ? 'settled' : 'dispatched'
    const facts = this.progressedFacts(task, event.taskSequence, task.outputBytes + newBytes, event.kind === 'dispatched')
    if (event.kind === 'dispatched' && event.callRecord.contextRef.supplementRefs.some(ref => !facts?.supplements?.some(supplement => supplement.chunkId === item.chunkId && sameVersionReference(ref, supplement)))) return bad('supplement_unavailable', '实际调用所用补充正文没有确切登记。')
    const nextFacts = facts && { ...facts, blocks: facts.blocks.map(item => item.request.revisionId === event.revisionId ? { ...item, sequence: event.sequence, phase: nextPhase as Block['phase'] } : item) }
    if (!this.store.updateTranslationHistory(event.scope.translationSessionId, history => applyDocumentMutation(history, event.unitId,
      next ? previous ? { kind: 'chunk_update', revisionId: previous.id, patch: { status: next.status, content: next.content, callRecord: next.callRecord, updatedAt: next.updatedAt }, ...(nextFacts ? { executionFacts: nextFacts } : {}) }
        : { kind: 'chunk', revision: next, ...(nextFacts ? { executionFacts: nextFacts } : {}) }
        : { kind: 'task_facts', taskId: event.taskId, facts: nextFacts! }, event.at))) return bad('history_update_failed', '块实际事实写入失败，未重复调用。')
    task.sequence = event.taskSequence; block.sequence = event.sequence; task.events.set(event.taskSequence, signature); task.outputBytes += newBytes
    block.phase = nextPhase
    if (event.kind === 'dispatch_intent' || event.kind === 'dispatched' || event.kind === 'settled' || event.kind === 'copy') {
      task.historySaved = this.store.getSettings().rememberHistory && await this.store.saveTranslationHistoryAsync(event.scope.translationSessionId)
      this.refreshStorage(task)
      if (event.kind === 'dispatch_intent' && task.sourceSaved && task.preparationSaved && this.store.getSettings().rememberHistory && !task.historySaved) return bad('history_save_failed', '派发认领未确认保存，未授权此块模型派发。')
    }
    return ok(this.receipt(task))
  }
  async finish(ownerId: string, raw: DocumentTaskFinish): Promise<AnalysisResult<DocumentTaskReceipt>> {
    let request: DocumentTaskFinish
    try { request = parseDocumentTaskFinish(raw) } catch { return bad('invalid_input', '整篇结算参数无效。') }
    const task = this.locate(ownerId, { scope: request.scope, taskId: request.taskId, unitId: request.unitId })
    if (!task) return bad('task_not_found', '准确受理的整篇任务不存在。')
    const signature = JSON.stringify(request), prior = task.events.get(request.taskSequence)
    if (prior) return prior === signature ? ok(this.receipt(task)) : bad('idempotency_conflict', '整体结算序号已有其他事实。')
    if (request.taskSequence !== task.sequence + 1 || [...task.blocks.values()].some(block => block.phase === 'dispatched' || block.phase === 'claimed')) return bad('sequence_gap', '整篇结算须等待准确块结算及父事件序号。')
    const unit = this.unit(task)!, plan = task.request.plan
    const chunks = plan.items.map(item => {
      const approval = task.request.reuseApprovals?.find(approval => approval.chunkId === item.chunkId)
      return approval ? unit.chunkRevisions.find(chunk => chunk.id === approval.reuseRef.revisionId) : [...unit.chunkRevisions].reverse().find(chunk => chunk.taskId === request.taskId && chunk.chunkId === item.chunkId)
    })
    const complete = chunks.every(chunk => chunk?.status === 'completed')
    if (request.status === 'completed' && !complete) return bad('incomplete_result', '范围缺失、截断或未知块不能记为整篇完成。')
    if (!this.store.updateTranslationHistory(request.scope.translationSessionId, history => {
      const manifest = chunks.every(Boolean) ? applyDocumentMutation(history, request.unitId, { kind: 'manifest', revision: {
        id: request.manifestId, taskId: request.taskId, sourceVersion: plan.sourceVersion, planRef: { id: plan.id, version: plan.version }, preparationRef: task.request.preparationRef, createdAt: request.at,
        entries: plan.items.map((item, index) => { const approval = task.request.reuseApprovals?.find(approval => approval.chunkId === item.chunkId)
          return { chunkId: item.chunkId, outputRange: item.outputRange, revisionId: chunks[index]!.id, ...(approval ? { reuseRef: { ...approval.reuseRef, approvalId: approval.id } } : {}) } }),
        review: { status: 'pending', checkedAt: null, issues: this.facts(task)?.reviewIssues ?? [] } } }, request.at) : history
      const facts = this.progressedFacts(task, request.taskSequence)
      return applyDocumentMutation(manifest, request.unitId, facts ? { kind: 'task_facts', taskId: request.taskId, facts, status: request.status }
        : { kind: 'task_update', taskId: request.taskId, status: request.status }, request.at)
    })) return bad('history_update_failed', '整篇清单与状态未完成写回。')
    task.sequence = request.taskSequence; task.events.set(request.taskSequence, signature)
    if (request.status !== 'unknown') task.finishSequence = request.taskSequence
    if (this.store.getSettings().rememberHistory) {
      task.historySaved = await this.store.saveTranslationHistoryAsync(request.scope.translationSessionId)
    } else {
      task.historySaved = false
    }
    this.refreshStorage(task)
    if (request.status !== 'unknown') task.releaseLease()
    return ok(this.receipt(task))
  }
  releaseAcknowledgedFinish(ownerId: string, raw: DocumentTaskRelease): AnalysisResult<DocumentTaskReceipt> {
    let request: DocumentTaskRelease
    try { request = parseDocumentTaskRelease(raw) } catch { return bad('invalid_input', '整篇清理确认参数无效。') }
    const task = this.locate(ownerId, { scope: request.scope, taskId: request.taskId, unitId: request.unitId })
    if (!task || task.finishSequence !== request.taskSequence || request.taskSequence !== task.sequence) return bad('finish_not_acknowledged', '没有匹配的已确认整篇终态。')
    const status = this.unit(task)?.tasks.find(item => item.taskId === task.scope.taskId)?.status
    if (!status || !['completed', 'failed', 'cancelled'].includes(status)) return bad('finish_not_acknowledged', '整篇任务尚未到达可清理的已确认终态。')
    task.releaseBridge()
    return ok(this.receipt(task))
  }
  async restore(ownerId: string, raw: DocumentRestoreRequest): Promise<AnalysisResult<DocumentRestoreCapture>> {
    let request: DocumentRestoreRequest
    try { request = parseDocumentRestoreRequest(raw) } catch { return bad('invalid_input', '文档恢复查询参数无效。', 'restore_document') }
    const scope = request.scope, session = this.store.getSession(scope.translationSessionId)
    if (this.disposed || !session || scope.ownerId !== ownerId || scope.mainSessionId !== ownerId || session.ownerId !== ownerId || session.topicId !== scope.topicId || session.mode !== 'normal' || this.store.isSessionDeleted(session.id)) return bad('scope_mismatch', '文档恢复不属于此主会话。', 'restore_document')
    const current = this.store.getTranslationHistory(session.id)?.units.find(unit => isDocumentUnit(unit) && unit.tasks.some(task => task.taskId === request.taskId))
    if (!current || !isDocumentUnit(current) || request.unitId !== undefined && request.unitId !== current.id) return bad('task_not_found', '此范围内没有确切任务。', 'restore_document')
    const blocked = this.materials.fileAccessBlockedReason(session.id, current.id)
    if (blocked) return bad('unit_removed_or_conflicted', blocked, 'restore_document')
    const record = current.tasks.find(task => task.taskId === request.taskId)!
    if (!record.executionFacts) return bad('execution_baseline_missing', '此旧任务未保存真实分析调用数、模型容量和执行序号，无法恢复；已有结果仍可查阅。', 'restore_document')
    const saved = this.store.readStoredDocumentTask(session.id, current.id, record.taskId)
    if (!saved) return bad('history_not_saved', '当前任务执行事实没有准确的已保存副本。', 'restore_document')
    const savedRecord = saved.tasks.find(task => task.taskId === record.taskId)!, facts = savedRecord.executionFacts!, source = saved.sourceVersions.find(source => source.version === record.sourceVersion)!, plan = saved.plans.find(plan => sameVersionReference(plan, record.planRef))!
    if (['waiting_context', 'waiting_user'].includes(savedRecord.status)) return bad('context_restore_unavailable', '旧任务的动态求助问题未保存，无法恢复此等待；已有结果仍可查阅。', 'restore_document')
    if (saved.chunkRevisions.filter(chunk => chunk.taskId === record.taskId).some(chunk => chunk.callRecord?.contextRef.supplementRefs.some(ref => !facts.supplements?.some(supplement => supplement.chunkId === chunk.chunkId && sameVersionReference(ref, supplement))))) return bad('context_restore_unavailable', '实际调用的补充正文缺失，无法重建该调用准备。', 'restore_document')
    const sourceSha256 = source.body.kind === 'asset' ? source.body.reference.sha256 : await digest(new TextEncoder().encode(source.body.text))
    const prepared = this.preparations.savedDocumentPreparation(scope, record.preparationRef, sourceSha256)
    if (!prepared.ok) return prepared
    const sourceRestore = source.body.kind === 'asset' ? await this.store.readStoredSourceRequest({ sessionId: session.id, unitId: current.id, sourceVersion: source.version }) : null
    if (source.body.kind === 'asset' && !sourceRestore) return bad('source_reference_unconfirmed', '原稿身份或准确历史保存引用未确认。', 'restore_document')
    const baseline = [...facts.controls].reverse().find(control => control.baseline)?.baseline ?? facts.baseline
    const capture: DocumentRestoreCapture = { receipt: { scope, taskId: record.taskId, unitId: current.id, operationId: record.operationId, sourceVersion: record.sourceVersion,
      planRef: record.planRef, preparationRef: record.preparationRef, taskSequence: facts.taskSequence, taskVersion: facts.taskVersion,
      hostGeneration: baseline.hostGeneration, status: record.status, storage: 'saved', storageError: null, restartExecutable: true }, source, plan,
      preparation: prepared.value, executionFacts: facts, chunks: saved.chunkRevisions.filter(chunk => chunk.taskId === record.taskId).map(({ id, chunkId, status, callId, attemptId, childOperationId, planRef, preparationRef, sourceVersion }) => ({ id, chunkId, status, callId, attemptId, childOperationId, planRef, preparationRef, sourceVersion })),
      ...(saved.reuseApprovals?.some(approval => approval.operationId === record.operationId) ? { reuseApprovals: saved.reuseApprovals.filter(approval => approval.operationId === record.operationId) } : {}),
      ...(sourceRestore ? { sourceRestore } : {}) }
    try { return ok(parseDocumentRestoreCapture(capture)) } catch { return bad('restore_packet_too_large', '完整恢复事实超过主题桥预算或引用无效，未截字段或开始调用。', 'restore_document') }
  }
  async control(ownerId: string, raw: DocumentTaskControl): Promise<AnalysisResult<DocumentTaskReceipt>> {
    let request: DocumentTaskControl
    try { request = parseDocumentTaskControl(raw) } catch { return bad('invalid_input', '文档控制写回参数无效。') }
    const blocked = this.materials.fileAccessBlockedReason(request.scope.translationSessionId, request.unitId)
    if (blocked) return bad('unit_removed_or_conflicted', blocked)
    const before = this.store.getTranslationHistory(request.scope.translationSessionId)?.units.find(unit => unit.id === request.unitId)
    if (request.kind === 'resume' && before && isDocumentUnit(before) && before.tasks.find(task => task.taskId === request.taskId)?.sourceVersion !== before.sourceVersion) return bad('stale_source_version', '旧任务原稿已被纠错版本取代，不能继续旧源派发。')
    let task = this.locate(ownerId, { scope: request.scope, taskId: request.taskId, unitId: request.unitId })
    if (!task) {
      if (request.kind !== 'resume') return bad('task_not_found', '当前运行期没有此文档任务。')
      const captured = await this.restore(ownerId, { scope: request.scope, taskId: request.taskId, unitId: request.unitId, hostGeneration: request.hostGeneration })
      if (!captured.ok) return captured
      const value = captured.value, facts = value.executionFacts
      if (request.expectedTaskVersion !== facts.taskVersion || request.taskSequence !== facts.taskSequence + 1) return bad('stale_task_version', '已保存任务版本或父序号已变化。', 'restore_document')
      if (facts.blocks.some(block => block.phase !== 'settled') || value.chunks.some(chunk => ['running', 'unknown', 'interrupted'].includes(chunk.status))) return bad('prior_call_unconfirmed', '旧块调用未确认结束；只能查询，不能新身份重发。', 'restore_document')
      const releaseLease = this.store.claimDocumentLease(request.scope.translationSessionId, request.taskId)
      if (!releaseLease) return bad('busy', '此翻译会话已由另一操作占用。')
      const baseline = [...facts.controls].reverse().find(control => control.baseline)?.baseline ?? facts.baseline
      const recovered: Task = { signature: `restored:${request.taskId}`, request: { operationId: value.receipt.operationId, plan: value.plan, preparationRef: value.receipt.preparationRef,
        contextBindings: baseline.contextBindings, createdAt: value.source.createdAt, executionBaseline: baseline, ...(value.reuseApprovals ? { reuseApprovals: value.reuseApprovals } : {}) }, scope: { scope: request.scope, taskId: request.taskId, unitId: request.unitId },
        releaseLease, releaseBridge: this.retain(ownerId), release: () => { recovered.releaseLease(); recovered.releaseBridge() },
        blocks: new Map(facts.blocks.map(block => [block.request.revisionId, { ...block }])), events: new Map(), sequence: facts.taskSequence,
        finishSequence: null, outputBytes: facts.outputBytes, historySaved: true, sourceSaved: true, preparationSaved: true, preparationStorageError: null, storageError: null, storage: 'saved' }
      this.tasks.set(this.key(ownerId, request.taskId), recovered); task = recovered
    }
    const unit = this.unit(task)!, record = unit.tasks.find(item => item.taskId === request.taskId)!, facts = record.executionFacts
    if (request.kind === 'resume' && record.sourceVersion !== unit.sourceVersion) return bad('stale_source_version', '旧任务原稿已被纠错版本取代，不能继续旧源派发。')
    if (!facts) return bad('execution_baseline_missing', '旧任务缺少可恢复的真实执行基线。')
    const prior = facts.controls.find(control => control.operationId === request.operationId)
    if (prior) {
      return prior.expectedTaskVersion === request.expectedTaskVersion && prior.kind === request.kind && prior.hostGeneration === request.hostGeneration && prior.status === request.status &&
        same(prior.planRef, request.plan ? { id: request.plan.id, version: request.plan.version } : undefined) && same(prior.preparationRef, request.preparationRef) && same(prior.baseline, request.executionBaseline)
        && same(prior.supplementRef, request.supplement ? { id: request.supplement.id, version: request.supplement.version } : undefined)
        && (!request.supplement || facts.supplements?.some(supplement => same(supplement, request.supplement)))
        ? ok(this.receipt(task)) : bad('idempotency_conflict', '同一控制标识已有不同意图或版本。')
    }
    if (facts.taskVersion !== request.expectedTaskVersion || request.taskSequence !== task.sequence + 1) return bad('stale_task_version', '任务控制版本或父序号已变化，请查询当前任务。')
    if (request.kind === 'resume' && (!['paused', 'waiting_user', 'waiting_context', 'failed', 'cancelled', 'interrupted'].includes(record.status) || [...task.blocks.values()].some(block => block.phase !== 'settled'))) return bad('prior_call_unconfirmed', '此任务仍有未确认调用，不能继续。')
    if (request.kind === 'resume' && this.options.isSessionBusy?.(request.scope.translationSessionId)) return bad('busy', '此翻译会话已有另一执行操作。')
    if (['pause', 'update', 'cancel'].includes(request.kind) && request.status !== 'unknown' && [...task.blocks.values()].some(block => block.phase !== 'settled')) return bad('prior_call_unconfirmed', '在途块尚未结算，任务控制不能伪造停止事实。')
    if (request.plan) {
      try { parseDocumentChunkPlan(request.plan, documentSourceLength(unit.sourceVersions.find(source => source.version === record.sourceVersion)!)) }
      catch { return bad('plan_mismatch', '新计划没有完整覆盖准确原稿。') }
      if (request.plan.sourceVersion !== record.sourceVersion || !request.preparationRef || !sameVersionReference(request.plan.preparationRef, request.preparationRef) || !request.executionBaseline) return bad('plan_mismatch', '新计划必须绑定准确原稿、准备和执行基线。')
    }
    const activePlan = request.plan ?? task.request.plan, activePreparation = request.preparationRef ?? task.request.preparationRef
    if (request.executionBaseline && (request.executionBaseline.contextBindings.length !== activePlan.items.length || request.executionBaseline.contextBindings.some((binding, index) =>
      binding.chunkId !== activePlan.items[index]!.chunkId || !sameVersionReference(binding.contextRef.preparationRef, activePreparation)))) return bad('context_mismatch', '新执行基线没有逐块绑定准确准备。')
    const supplements = facts.supplements ?? [], supplement = request.supplement
    if (supplement && (request.kind !== 'resume' || !activePlan.items.some(item => item.chunkId === supplement.chunkId && item.mode === 'translate') || supplements.length >= 3 ||
      supplements.some(old => old.chunkId === supplement.chunkId || sameVersionReference(old, supplement)))) return bad('supplement_budget_exceeded', '本块已登记补充或整篇三次补充预算已用尽。')
    for (const chunk of unit.chunkRevisions.filter(chunk => chunk.taskId === request.taskId && chunk.status === 'completed')) if (request.plan) {
      const oldPlan = unit.plans.find(plan => sameVersionReference(plan, chunk.planRef))!, old = oldPlan.items.find(item => item.chunkId === chunk.chunkId)!, next = request.plan.items.find(item => item.chunkId === chunk.chunkId)
      if (!next || !same(old.outputRange, next.outputRange) || old.mode !== next.mode) return bad('completed_range_changed', '新计划不能改变已完成块范围或模式。')
    }
    for (const approval of task.request.reuseApprovals ?? []) if (request.plan) {
      const old = task.request.plan.items.find(item => item.chunkId === approval.chunkId), next = request.plan.items.find(item => item.chunkId === approval.chunkId)
      if (!old || !next || !same(old.outputRange, next.outputRange) || old.mode !== next.mode) return bad('completed_range_changed', '新计划不能改变已批准复用块的范围或模式。')
    }
    const nextFacts: DocumentExecutionFacts = { ...facts, taskVersion: facts.taskVersion + 1, taskSequence: request.taskSequence,
      controls: [...facts.controls, { operationId: request.operationId, expectedTaskVersion: request.expectedTaskVersion, taskVersion: facts.taskVersion + 1,
        hostGeneration: request.hostGeneration, taskSequence: request.taskSequence, status: request.status, kind: request.kind, at: request.at,
        ...(request.plan ? { planRef: { id: request.plan.id, version: request.plan.version } } : {}), ...(request.preparationRef ? { preparationRef: request.preparationRef } : {}), ...(request.executionBaseline ? { baseline: request.executionBaseline } : {}),
        ...(supplement ? { supplementRef: { id: supplement.id, version: supplement.version } } : {}) }],
      reviewIssues: [...facts.reviewIssues, ...(request.reviewIssues ?? [])].filter((issue, index, items) => items.findIndex(other => same(issue, other)) === index) }
    const resolvedFacts: DocumentExecutionFacts = supplement ? { ...nextFacts, supplements: [...supplements, supplement], automaticSupplementCalls: facts.automaticSupplementCalls + 1 } : nextFacts
    if (!this.store.updateTranslationHistory(request.scope.translationSessionId, history => {
      let next = history
      if (request.preparationRef) next = applyDocumentMutation(next, request.unitId, { kind: 'preparation', preparation: { ...request.preparationRef, sourceVersion: record.sourceVersion } }, request.at)
      if (request.plan) next = applyDocumentMutation(next, request.unitId, { kind: 'plan', plan: request.plan }, request.at)
      return applyDocumentMutation(next, request.unitId, { kind: 'task_facts', taskId: request.taskId, facts: resolvedFacts, status: request.status,
        ...(request.plan ? { planRef: { id: request.plan.id, version: request.plan.version } } : {}), ...(request.preparationRef ? { preparationRef: request.preparationRef } : {}) }, request.at)
    })) return bad('history_update_failed', '任务控制事实未完成写回。')
    task.sequence = request.taskSequence
    if (request.plan || request.preparationRef || request.executionBaseline) task.request = { ...task.request, plan: request.plan ?? task.request.plan,
      preparationRef: request.preparationRef ?? task.request.preparationRef, contextBindings: request.executionBaseline?.contextBindings ?? task.request.contextBindings,
      ...(request.executionBaseline ? { executionBaseline: request.executionBaseline } : {}) }
    if (request.kind === 'resume') {
      task.finishSequence = null
      // Completed/failed tasks have relinquished their old retains; every explicit resume owns fresh retains.
      task.releaseLease()
      task.releaseLease = this.store.claimDocumentLease(request.scope.translationSessionId, request.taskId) ?? (() => {})
      const retainNext = this.retain(ownerId); task.releaseBridge(); task.releaseBridge = retainNext
    }
    task.historySaved = this.store.getSettings().rememberHistory && await this.store.saveTranslationHistoryAsync(request.scope.translationSessionId)
    this.refreshStorage(task)
    if (request.kind === 'cancel') { task.finishSequence = request.taskSequence; task.releaseLease() }
    return ok(this.receipt(task))
  }
  observe(ownerId: string, raw: DocumentTaskScope): AnalysisResult<DocumentTaskReceipt | null> {
    let scope: DocumentTaskScope
    try { scope = parseDocumentTaskScope(raw) } catch { return bad('invalid_input', '文档查询范围无效。') }
    const task = this.locate(ownerId, scope)
    return scope.scope.ownerId !== ownerId || scope.scope.mainSessionId !== ownerId ? bad('scope_mismatch', '文档查询不属于当前主会话。') : ok(task ? this.receipt(task) : null)
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { for (const listener of this.listeners) listener() }
  uiState(sessionId: string, taskId: string): { readonly pending: boolean; readonly pausing: boolean; readonly cancelling: boolean; readonly message: string | null; readonly canResume: boolean; readonly recoverability: string | null } {
    const session = this.store.getSession(sessionId), unit = this.store.getTranslationHistory(sessionId)?.units.find(unit => isDocumentUnit(unit) && unit.tasks.some(task => task.taskId === taskId))
    const task = unit && isDocumentUnit(unit) ? unit.tasks.find(task => task.taskId === taskId) : undefined, key = session ? this.key(session.ownerId, taskId) : ''
    const uncertain = task?.executionFacts?.blocks.some(block => block.phase !== 'settled') || unit && isDocumentUnit(unit) && unit.chunkRevisions.some(chunk => chunk.taskId === taskId && ['running', 'unknown', 'interrupted'].includes(chunk.status))
    const recoverability = !task?.executionFacts ? '此旧任务缺少执行恢复事实；已有原稿与结果可查阅。' : uncertain && ['interrupted', 'unknown'].includes(task.status) ? '旧调用未确认结束，请查询任务状态。' : null
    return { pending: Boolean(this.controlsPending.get(key)?.size), pausing: this.controlsPending.get(key)?.has('pause') ?? false,
      cancelling: this.controlsPending.get(key)?.has('cancel') ?? false, message: this.notices.get(key) ?? null,
      canResume: Boolean(task?.executionFacts && !uncertain && unit && !this.materials.fileAccessBlockedReason(sessionId, unit.id) && ['paused', 'failed', 'cancelled', 'interrupted'].includes(task.status)), recoverability }
  }
  async requestControl(sessionId: string, taskId: string, kind: 'pause' | 'cancel' | 'resume' | 'status'): Promise<void> {
    const session = this.store.getSession(sessionId), history = this.store.getTranslationHistory(sessionId), unit = history?.units.find(unit => isDocumentUnit(unit) && unit.tasks.some(task => task.taskId === taskId))
    if (this.disposed || !session || !unit || !isDocumentUnit(unit) || this.materials.fileAccessBlockedReason(sessionId, unit.id)) return
    const record = unit.tasks.find(task => task.taskId === taskId)!, facts = record.executionFacts, key = this.key(session.ownerId, taskId)
    const pending = this.controlsPending.get(key) ?? new Set<'pause' | 'cancel' | 'resume' | 'status'>()
    if (pending.has(kind) || pending.size && !(kind === 'cancel' && pending.has('pause') && !pending.has('cancel'))) return
    if (kind !== 'status' && (!facts || kind === 'resume' && !this.uiState(sessionId, taskId).canResume)) { this.notices.set(key, '此任务目前只能查询执行状态。'); this.emit(); return }
    const scope = { ownerId: session.ownerId, mainSessionId: session.ownerId, topicId: session.topicId, translationSessionId: sessionId }, release = this.retain(session.ownerId)
    const noticeOwner = crypto.randomUUID(); this.noticeOwners.set(key, noticeOwner)
    pending.add(kind); this.controlsPending.set(key, pending); this.notices.delete(key); this.emit()
    try {
      const port = typeof this.options.remote === 'function' ? await this.options.remote() : this.options.remote
      if (!port) throw new Error('整篇控制服务尚未就绪。')
      const request = kind === 'status' ? { scope, taskId, afterTaskSequence: 0, limit: 50 } : parseTranslationBatchControl({ scope, taskId, operationId: `document-${kind}:${crypto.randomUUID()}`, expectedTaskVersion: facts!.taskVersion })
      let timeout: ReturnType<typeof setTimeout> | undefined
      const raw = await Promise.race([kind === 'status' ? port.status(request as import('../shared/document-execution.js').TranslationBatchStatus) : port[kind](request as TranslationBatchControl),
        new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('控制回执未知，请查询此任务；未自动重发。')), 15000) })]).finally(() => clearTimeout(timeout)) as { ok?: boolean; value?: { ok?: boolean; value?: unknown; error?: { message?: string } } }
      if (raw?.ok !== true || raw.value?.ok !== true) throw new Error(raw?.value?.error?.message ?? '任务控制结果未知，请查询原任务。')
      const result = kind === 'status' ? parseDocumentBatchStatusView(raw.value.value) : parseDocumentTaskReceipt(raw.value.value)
      if (result.taskId !== taskId || result.unitId !== unit.id || !same(result.scope, scope)) throw new Error('任务控制回执所属范围不符。')
      if (this.noticeOwners.get(key) === noticeOwner) this.notices.set(key, kind === 'status' ? result.status === 'unknown' ? '执行结果仍未知；保留已有块和残稿。' : '已查询此任务状态。' : kind === 'pause' ? '已暂停；在途块已结算，后续块未派发。' : kind === 'cancel' ? '已取消；完成块和残稿已保留。' : '已继续此任务。')
    } catch (error) { if (this.noticeOwners.get(key) === noticeOwner) this.notices.set(key, error instanceof Error ? error.message : '任务控制未完成，请查询原任务。') }
    finally { pending.delete(kind); if (!pending.size) this.controlsPending.delete(key); release(); this.emit() }
  }
  getRetranslationStatus(sessionId: string, unitId: string): { readonly pending: boolean; readonly message: string; readonly unknown: boolean } | undefined {
    const item = this.unitRequests.get(JSON.stringify([sessionId, unitId]))
    return item ? { pending: item.pending, message: item.message, unknown: item.unknown } : undefined
  }
  observeFileTask(summary: import('../shared/file-jobs.js').FileJobSummary): void {
    const item = this.unitRequests.get(JSON.stringify([summary.translationSessionId, summary.unitId]))
    if (!item || item.request.operationId !== summary.operationId || item.request.target.mainSessionId !== summary.ownerId || item.outcome === 'accepted') return
    item.pending = false; item.unknown = false; item.outcome = 'accepted'; item.message = '文件重译已受理。'
    item.release?.(); delete item.release; this.emit()
  }
  retranslationBlockedReason(sessionId: string, unitId: string): string | undefined {
    const session = this.store.getSession(sessionId), unit = this.store.getTranslationHistory(sessionId)?.units.find(unit => unit.id === unitId)
    if (this.disposed || !session || !unit || !isDocumentUnit(unit) || session.mode !== 'normal' || this.store.isSessionDeleted(sessionId)) return '此文档单元已不可用。'
    const blocked = this.materials.fileAccessBlockedReason(sessionId, unitId)
    if (blocked) return blocked
    if (session.archivedAt !== null) return '请先恢复归档会话。'
    if (!session.model) return '请先选择本次翻译模型。'
    if (this.store.getStatus(sessionId) === 'conflict') return '本地历史副本已变化，请核对最新记录。'
    if (this.options.bridgeReady?.(session.ownerId) === false) return '正在连接此主会话。'
    const intent = this.unitRequests.get(JSON.stringify([sessionId, unitId]))
    if (intent?.pending) return '正在发送或查询此文档的重译意图。'
    if (intent?.unknown) return '重译意图发送状态未知，请先检查状态。'
    if (intent?.outcome === 'submitted') return '重译意图已发送，正在等待主模型受理。'
    if (this.options.isSessionBusy?.(sessionId) || this.store.hasDocumentLease(sessionId) ||
      this.store.getTranslationHistory(sessionId)?.units.some(item => isDocumentUnit(item) && item.tasks.some(task =>
        ['running', 'unknown', 'paused', 'waiting_user', 'waiting_context'].includes(task.status) || task.executionFacts?.blocks.some(block => block.phase !== 'settled')))) return '当前会话仍有未结束或未知任务，请先查询或取消。'
    return undefined
  }
  async requestRetranslation(sessionId: string, unitId: string): Promise<void> {
    if (this.retranslationBlockedReason(sessionId, unitId)) return
    const session = this.store.getSession(sessionId)!, unit = this.store.getTranslationHistory(sessionId)!.units.find(unit => unit.id === unitId)!
    if (!isDocumentUnit(unit)) return
    const locale = this.options.uiLocale?.()?.trim(), request: NormalTranslationUnitRequest = {
      target: { kind: 'unit', mainSessionId: session.ownerId, translationSessionId: sessionId, unitId, sourceVersion: unit.sourceVersion },
      operationId: `document-unit-intent:${crypto.randomUUID()}`, ...(locale ? { uiLocale: locale.slice(0, 64) } : {}) }
    const key = JSON.stringify([sessionId, unitId]), item = { request, previousTasks: unit.tasks.map(task => task.taskId), pending: true, unknown: false,
      outcome: 'pending' as 'pending' | 'submitted' | 'accepted' | 'failed' | 'unknown', message: '正在发送文档重译意图…', release: this.retain(session.ownerId) as (() => void) | undefined }
    this.unitRequests.get(key)?.release?.(); this.unitRequests.set(key, item); this.emit()
    let dispatched = false
    try {
      if (!this.options.publishUnit?.(session.ownerId, sessionId, unitId, unit.sourceVersion)) throw new Error('此文档未能供主模型读取。')
      const port = typeof this.options.remote === 'function' ? await this.options.remote() : this.options.remote
      if (!port?.submitUnit) throw new Error('宿主尚未提供文档重译入口。')
      if (this.materials.fileAccessBlockedReason(sessionId, unitId)) throw new Error('此文件单元已移除或历史副本已变化。')
      dispatched = true
      const result = await this.intentReply(port.submitUnit(request))
      if (!result.ok) { dispatched = result.error.code === 'main_admission_unknown'; throw new Error(result.error.message) }
      if (!result.value || !same(result.value.target, request.target) || result.value.operationId !== request.operationId || result.value.accepted !== true) throw new Error('文档重译回执身份不一致。')
      if (item.outcome !== 'accepted') { item.outcome = 'submitted'; item.message = '已向主模型发送此文档的重译意图，等待业务受理。' }
    } catch (error) {
      if (item.outcome !== 'accepted') { item.unknown = dispatched; item.outcome = dispatched ? 'unknown' : 'failed'; item.message = `${dispatched ? '发送状态未知' : '发送失败'}：${error instanceof Error ? error.message : '请核对主会话。'} 未自动重发。` }
    } finally {
      item.pending = false
      if (!dispatched) { item.release?.(); item.release = undefined }
      this.emit()
    }
  }
  async queryRetranslation(sessionId: string, unitId: string): Promise<void> {
    const item = this.unitRequests.get(JSON.stringify([sessionId, unitId]))
    if (this.disposed || !item?.unknown || item.pending || this.materials.fileAccessBlockedReason(sessionId, unitId)) return
    item.pending = true; this.emit()
    try {
      const port = typeof this.options.remote === 'function' ? await this.options.remote() : this.options.remote
      if (!port?.queryUnit) throw new Error('宿主尚未提供文档重译意图查询。')
      const result = await this.intentReply(port.queryUnit(item.request), true)
      if (item.outcome === 'accepted') return
      // A read-side rejection (including lost authorization) does not settle the original send.
      if (!result.ok) throw new Error(result.error.message)
      else if (result.value === null) item.message = '服务尚无此意图的确切回执；发送状态仍未知，未重新发送。'
      else if (!same(result.value.target, item.request.target) || result.value.operationId !== item.request.operationId || result.value.accepted !== true) throw new Error('文档意图查询回执身份不一致。')
      else { item.unknown = false; item.outcome = 'submitted'; item.message = '已确认重译意图发送，等待主模型受理。' }
    } catch (error) { item.message = `重译意图仍待确认：${error instanceof Error ? error.message : '查询未完成。'} 未重新发送。` }
    finally { item.pending = false; this.emit() }
  }
  private async intentReply(promise: Promise<unknown>, query = false): Promise<AnalysisResult<{ readonly accepted: true; readonly operationId: string; readonly target: NormalTranslationUnitRequest['target'] } | null>> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const raw = await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('未取得文档意图回执，请检查状态。')), 15000) })]).finally(() => clearTimeout(timer)) as {
      ok?: boolean; value?: AnalysisResult<{ readonly accepted: true; readonly operationId: string; readonly target: NormalTranslationUnitRequest['target'] } | null>
    }
    if (raw?.ok !== true || !raw.value || typeof raw.value.ok !== 'boolean') throw new Error('未取得文档意图传输回执。')
    return query ? parseDocumentUnitQueryResult(raw.value) : parseDocumentUnitSubmitResult(raw.value)
  }
  dispose(): void { this.disposed = true; this.stopBridge?.(); this.stopStore(); for (const item of this.unitRequests.values()) item.release?.(); this.unitRequests.clear(); for (const task of this.tasks.values()) task.release(); this.tasks.clear(); for (const release of this.correctedRetains.values()) release(); this.correctedRetains.clear(); this.admissions.clear(); this.listeners.clear(); this.controlsPending.clear(); this.notices.clear(); this.noticeOwners.clear() }
}
