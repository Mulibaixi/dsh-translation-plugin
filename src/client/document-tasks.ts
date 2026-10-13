import { parseDocumentAcceptRequest, parseDocumentBlockRegistration, parseDocumentTaskEvent, parseDocumentTaskFinish, parseDocumentTaskScope,
  MAX_DOCUMENT_OUTPUT_BYTES, type DocumentAcceptRequest, type DocumentBlockRegistration, type DocumentBlockReceipt,
  parseDocumentTaskRelease, type DocumentTaskEvent, type DocumentTaskFinish, type DocumentTaskReceipt, type DocumentTaskRelease, type DocumentTaskScope } from '../shared/document-execution.js'
import { documentSourceLength, parseDocumentCallRecord, sameVersionReference, type ChunkRevision, type DocumentUnit } from '../shared/translation-batch.js'
import { toSourceIdentity } from '../shared/translation-sources.js'
import { MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, sourceCodePointLength, type TranslationSourceRange } from '../shared/translation-source-read.js'
import type { AnalysisResult, PreparationSnapshot } from '../shared/translation-preparation.js'
import { appendDocumentUnit, applyDocumentMutation, isDocumentUnit } from './translation-history.js'
import type { SessionStore } from './session-store.js'
import type { MaterialSubmissionsClient } from './material-submissions.js'
import type { PreparationStore } from './preparation-store.js'
import type { TranslationSourceReader } from './source-reader.js'
import type { TranslationSourceStorageClient } from './source-storage-client.js'

type Block = { readonly request: DocumentBlockRegistration; sequence: number; phase: 'registered' | 'dispatched' | 'settled' }
interface Task {
  readonly signature: string
  readonly request: DocumentAcceptRequest
  readonly scope: DocumentTaskScope
  readonly releaseLease: () => void
  readonly releaseBridge: () => void
  readonly release: () => void
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
export interface DocumentTasksOptions {
  readonly isSessionBusy?: (sessionId: string) => boolean
  readonly reader?: TranslationSourceReader
  readonly sourceStorage?: TranslationSourceStorageClient
  readonly subscribeBridge?: (listener: () => void) => () => void
  readonly bridgeReady?: (ownerId: string) => boolean
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
  constructor(private readonly store: SessionStore, private readonly materials: MaterialSubmissionsClient, private readonly preparations: PreparationStore,
    private readonly retain: (ownerId: string) => () => void, private readonly options: DocumentTasksOptions = {}) {
    this.stopBridge = options.subscribeBridge?.(() => {
      for (const task of this.tasks.values()) if (this.options.bridgeReady?.(task.scope.scope.ownerId) === false) {
        const unit = this.unit(task), state = unit?.tasks.find(item => item.taskId === task.scope.taskId)
        if (state && ['running', 'unknown'].includes(state.status)) this.store.updateTranslationHistory(task.scope.scope.translationSessionId,
          history => applyDocumentMutation(history, task.scope.unitId, { kind: 'task_update', taskId: task.scope.taskId, status: 'unknown' }, new Date().toISOString()))
      }
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
      session.ownerId === ownerId && session.topicId === scope.scope.topicId && !this.store.isSessionDeleted(session.id) ? task : undefined
  }
  private receipt(task: Task): DocumentTaskReceipt {
    const request = task.request, status = this.unit(task)!.tasks.find(item => item.taskId === task.scope.taskId)!.status
    return { ...task.scope, operationId: request.operationId, sourceVersion: request.envelope.material.sourceVersion,
      planRef: { id: request.plan.id, version: request.plan.version }, preparationRef: request.preparationRef,
      taskSequence: task.sequence, status, storage: task.storage === 'saved' && this.store.getSettings().rememberHistory && this.store.getStatus(task.scope.scope.translationSessionId) === 'saved' ? 'saved' : 'runtime_only',
      storageError: task.storage === 'saved' && !this.store.getSettings().rememberHistory ? '历史保存已关闭；后续事实仅保留在当前运行期。' : task.storageError, restartExecutable: false }
  }
  accept(ownerId: string, raw: DocumentAcceptRequest): Promise<AnalysisResult<DocumentTaskReceipt>> {
    let request: DocumentAcceptRequest
    try { request = parseDocumentAcceptRequest(raw) } catch { return Promise.resolve(bad('invalid_input', '文档受理参数无效。', 'accept_document')) }
    const key = this.key(ownerId, request.taskId), signature = JSON.stringify(request), previous = this.admissions.get(key)
    if (previous) return previous.signature === signature ? previous.promise.then(result => result.ok && this.tasks.has(key) ? ok(this.receipt(this.tasks.get(key)!)) : result)
      : Promise.resolve(bad('idempotency_conflict', '同一整篇任务已经绑定其他材料或计划。', 'accept_document'))
    const promise = this.acceptOnce(ownerId, request, signature)
    this.admissions.set(key, { signature, promise })
    return promise
  }
  private async acceptOnce(ownerId: string, request: DocumentAcceptRequest, signature: string): Promise<AnalysisResult<DocumentTaskReceipt>> {
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
    if (this.disposed || !this.materials.resolveSubmittedMaterial(envelope) || this.store.isSessionDeleted(session.id)) { release(); return bad('scope_mismatch', '文档受理时固定材料已不可用。', 'accept_document') }
    for (const [index, binding] of request.contextBindings.entries()) {
      const item = request.plan.items[index]!, expected = item.mode === 'copy' ? [] : contexts(snapshot, item.outputRange, item.contextRanges)
      if (!same(expected, binding.contextRef.contextRanges) || binding.contextRef.supplementRefs.length || binding.contextRef.referenceRefs.length ||
        binding.contextRef.termRefs.some(ref => !snapshot.terms.some(term => same(term.ref, ref))) || item.mode === 'copy' && binding.contextRef.termRefs.length) {
        release(); return bad('context_mismatch', '块实际上下文与固定准备或计划不一致。', 'accept_document')
      }
    }
    const source = { version: 1, body: material!.sourceRef ? { kind: 'asset' as const, reference: toSourceIdentity(material!.sourceRef) }
      : { kind: 'inline' as const, text: material!.sourceText! }, createdAt: request.createdAt, operationId: null }
    if (!this.store.updateTranslationHistory(session.id, current => appendDocumentUnit(current, { id: request.unitId, targetLanguage: material!.targetLanguage,
      instruction: material!.instruction, createdAt: request.createdAt, source, preparation: { ...request.preparationRef, sourceVersion: 1 }, plan: request.plan,
      task: { taskId: request.taskId, operationId: request.operationId, sourceVersion: 1, planRef: { id: request.plan.id, version: request.plan.version },
        preparationRef: request.preparationRef, createdAt: request.createdAt, status: 'running' } }))) { release(); return bad('history_update_failed', '文档单元记录未完成，材料保留。', 'accept_document') }
    const scope: DocumentTaskScope = { scope: { ownerId, mainSessionId: ownerId, topicId: session.topicId, translationSessionId: session.id }, taskId: request.taskId, unitId: request.unitId }
    const task: Task = { signature, request: structuredClone(request), scope, releaseLease: releaseTaskLease, releaseBridge: releaseTaskBridge, release,
      blocks: new Map(), events: new Map(), sequence: 0, finishSequence: null, outputBytes: 0, historySaved: false, sourceSaved: !material!.sourceRef,
      preparationSaved: snapshot.storage === 'saved', preparationStorageError: snapshot.storageError, storage: 'runtime_only', storageError: null }
    this.tasks.set(this.key(ownerId, request.taskId), task)
    if (this.store.getSettings().rememberHistory) {
      const historySaved = await this.store.saveTranslationHistoryAsync(session.id)
      let sourceSaved = !material!.sourceRef
      if (material!.sourceRef && this.options.sourceStorage) {
        try {
          const saved = await this.options.sourceStorage.save({ prepare: { scope: scope.scope, sourceRef: material!.sourceRef,
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
    const old = task.blocks.get(request.childOperationId)
    const receipt = (block: Block): DocumentBlockReceipt => ({ ...task.scope, childOperationId: block.request.childOperationId, revisionId: block.request.revisionId,
      callId: block.request.callId, attemptId: block.request.attemptId, sequence: block.sequence, registered: true })
    if (old) return same(old.request, request) ? ok(receipt(old)) : bad('idempotency_conflict', '块操作已绑定其他调用或版本。')
    const unit = this.unit(task)!, item = task.request.plan.items.find(item => item.chunkId === request.chunkId)
    if (!item || (item.mode === 'copy') !== (request.callId === null) || unit.tasks.find(item => item.taskId === request.taskId)?.status !== 'running' ||
      [...task.blocks.values()].some(block => block.phase !== 'settled' || block.request.chunkId === request.chunkId || block.request.revisionId === request.revisionId ||
        request.callId !== null && block.request.callId === request.callId || request.attemptId !== null && block.request.attemptId === request.attemptId)) return bad('invalid_state', '块未属于固定串行计划或前一块尚未结算。')
    const nextItem = task.request.plan.items[task.blocks.size]
    if (nextItem?.chunkId !== request.chunkId) return bad('invalid_state', '块登记必须沿固定源顺序。')
    const block: Block = { request, sequence: 0, phase: 'registered' }
    task.blocks.set(request.childOperationId, block)
    return ok(receipt(block))
  }
  async event(ownerId: string, raw: DocumentTaskEvent): Promise<AnalysisResult<DocumentTaskReceipt>> {
    let event: DocumentTaskEvent
    try { event = parseDocumentTaskEvent(raw) } catch { return bad('invalid_input', '文档实际事件参数无效。') }
    const task = this.locate(ownerId, { scope: event.scope, taskId: event.taskId, unitId: event.unitId })
    if (!task) return bad('task_not_found', '文档任务不存在或所属范围不一致。')
    const digestResult = await eventSignature(event), signature = digestResult.signature, old = task.events.get(event.taskSequence)
    if (old) return old === signature ? ok(this.receipt(task)) : bad('idempotency_conflict', '父事件序号已有不同事实。')
    const block = task.blocks.get(event.childOperationId), unit = this.unit(task)!
    if (!block || block.request.revisionId !== event.revisionId || event.taskSequence !== task.sequence + 1 || event.sequence !== block.sequence + 1) return bad('sequence_gap', '父或子事件有缺口；请查询原事件，未重发调用。')
    const item = task.request.plan.items.find(item => item.chunkId === block.request.chunkId)!, context = task.request.contextBindings.find(binding => binding.chunkId === item.chunkId)!.contextRef
    const sourceLength = documentSourceLength(unit.sourceVersions.find(source => source.version === task.request.plan.sourceVersion)!)
    const previous = unit.chunkRevisions.find(chunk => chunk.id === event.revisionId)
    let newBytes = 0, next: ChunkRevision | undefined
    if (event.kind === 'dispatched') {
      if (block.phase !== 'registered' || !block.request.callId || !block.request.attemptId || item.mode !== 'translate') return bad('invalid_state', '实际派发事件没有准确块登记。')
      let call
      try { call = parseDocumentCallRecord(event.callRecord, sourceLength) } catch { return bad('invalid_call', '实际模型调用记录无效。') }
      const route = task.request.envelope.material.model!
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
    if (!this.store.updateTranslationHistory(event.scope.translationSessionId, history => applyDocumentMutation(history, event.unitId,
      previous ? { kind: 'chunk_update', revisionId: previous.id, patch: { status: next.status, content: next.content, callRecord: next.callRecord, updatedAt: next.updatedAt } }
        : { kind: 'chunk', revision: next }, event.at))) return bad('history_update_failed', '块实际事实写入失败，未重复调用。')
    task.sequence = event.taskSequence; block.sequence = event.sequence; task.events.set(event.taskSequence, signature); task.outputBytes += newBytes
    block.phase = event.kind === 'copy' || event.kind === 'settled' ? 'settled' : 'dispatched'
    return ok(this.receipt(task))
  }
  async finish(ownerId: string, raw: DocumentTaskFinish): Promise<AnalysisResult<DocumentTaskReceipt>> {
    let request: DocumentTaskFinish
    try { request = parseDocumentTaskFinish(raw) } catch { return bad('invalid_input', '整篇结算参数无效。') }
    const task = this.locate(ownerId, { scope: request.scope, taskId: request.taskId, unitId: request.unitId })
    if (!task) return bad('task_not_found', '准确受理的整篇任务不存在。')
    const signature = JSON.stringify(request), prior = task.events.get(request.taskSequence)
    if (prior) return prior === signature ? ok(this.receipt(task)) : bad('idempotency_conflict', '整体结算序号已有其他事实。')
    if (request.taskSequence !== task.sequence + 1 || [...task.blocks.values()].some(block => block.phase === 'dispatched')) return bad('sequence_gap', '整篇结算须等待准确块结算及父事件序号。')
    const unit = this.unit(task)!, plan = task.request.plan
    const chunks = plan.items.map(item => unit.chunkRevisions.find(chunk => chunk.taskId === request.taskId && chunk.chunkId === item.chunkId))
    const complete = chunks.every(chunk => chunk?.status === 'completed')
    if (request.status === 'completed' && !complete) return bad('incomplete_result', '范围缺失、截断或未知块不能记为整篇完成。')
    if (!this.store.updateTranslationHistory(request.scope.translationSessionId, history => {
      const manifest = chunks.every(Boolean) ? applyDocumentMutation(history, request.unitId, { kind: 'manifest', revision: {
        id: request.manifestId, taskId: request.taskId, sourceVersion: unit.sourceVersion, planRef: { id: plan.id, version: plan.version }, preparationRef: task.request.preparationRef, createdAt: request.at,
        entries: plan.items.map((item, index) => ({ chunkId: item.chunkId, outputRange: item.outputRange, revisionId: chunks[index]!.id })),
        review: { status: 'pending', checkedAt: null, issues: [] } } }, request.at) : history
      return applyDocumentMutation(manifest, request.unitId, { kind: 'task_update', taskId: request.taskId, status: request.status }, request.at)
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
  observe(ownerId: string, raw: DocumentTaskScope): AnalysisResult<DocumentTaskReceipt | null> {
    let scope: DocumentTaskScope
    try { scope = parseDocumentTaskScope(raw) } catch { return bad('invalid_input', '文档查询范围无效。') }
    const task = this.locate(ownerId, scope)
    return scope.scope.ownerId !== ownerId || scope.scope.mainSessionId !== ownerId ? bad('scope_mismatch', '文档查询不属于当前主会话。') : ok(task ? this.receipt(task) : null)
  }
  dispose(): void { this.disposed = true; this.stopBridge?.(); for (const task of this.tasks.values()) task.release(); this.tasks.clear(); this.admissions.clear() }
}
