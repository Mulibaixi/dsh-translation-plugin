import { parseDocumentReviewBeginRequest, parseDocumentReviewSubmitRequest, parseDocumentReviewQueryRequest, parseDocumentManualRevisionRequest, parseDocumentFinalRequest, applyDocumentEdits,
  type DocumentReviewTarget, type DocumentReviewBeginRequest, type DocumentReviewSubmitRequest, type DocumentReviewQueryRequest, type DocumentManualRevisionRequest, type DocumentFinalRequest, type DocumentReviewReceipt } from '../shared/document-review.js'
import { parseDocumentReviewPageRequest, parseDocumentReviewRead, parseDocumentReviewPage, parseDocumentReviewTextPage, documentReviewBytes, MAX_DOCUMENT_REVIEW_PAGE_BYTES,
  type DocumentReviewPageRequest, type DocumentReviewPage, type DocumentReviewRead, type DocumentReviewTextPage } from '../shared/document-review-bridge.js'
import { documentSourceLength, sameVersionReference, type DocumentUnit, type DocumentRevision } from '../shared/translation-batch.js'
import { MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, sourceCodePointLength } from '../shared/translation-source-read.js'
import type { AnalysisResult, PreparationSnapshot } from '../shared/translation-preparation.js'
import { documentReviewVersion, documentManifestFinalEligibility, verifyDocumentMechanicalReview } from '../memory/document-review.js'
import { currentDocumentFinal } from '../memory/document-task.js'
import { applyDocumentMutation, isDocumentUnit } from './translation-history.js'
import type { SessionStore } from './session-store.js'
import type { PreparationStore } from './preparation-store.js'
import type { TranslationDocumentReader, DocumentReadHandle } from './source-reader.js'

export interface DocumentReviewRemotePort { notify(request: { readonly target: DocumentReviewTarget }): Promise<unknown> }
export interface DocumentReviewClientOptions { readonly remote?: DocumentReviewRemotePort | (() => Promise<DocumentReviewRemotePort | undefined>) | undefined; readonly isSessionBusy?: (sessionId: string) => boolean }
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
const good = <T>(value: T): AnalysisResult<T> => ({ ok: true, value })
function bad(code: string, message: string): AnalysisResult<never> { return { ok: false, error: { code, message, stage: 'review_document' } } }
function error(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
async function sha256(text: string): Promise<string> { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), value => value.toString(16).padStart(2, '0')).join('') }

/** Reviews read real bounded source pages and atomically append immutable history facts. */
export class DocumentReviewClient {
  private disposed = false
  private readonly listeners = new Set<() => void>()
  private readonly operations = new Map<string, { signature: string; result: Promise<AnalysisResult<DocumentReviewReceipt>> }>()
  private readonly notices = new Map<string, Promise<void>>()
  constructor(private readonly store: SessionStore, private readonly preparations: PreparationStore, private readonly reader: TranslationDocumentReader,
    private readonly retain: (ownerId: string) => () => void, private readonly options: DocumentReviewClientOptions = {}) {}
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  private locate(ownerId: string, target: DocumentReviewTarget): { unit: DocumentUnit; manifest: DocumentRevision; handle: DocumentReadHandle } {
    const scope = target.scope, session = this.store.getSession(scope.translationSessionId), unit = this.store.getTranslationHistory(scope.translationSessionId)?.units.find(unit => unit.id === target.unitId)
    if (this.disposed || ownerId !== scope.ownerId || ownerId !== scope.mainSessionId || !session || session.ownerId !== ownerId || session.topicId !== scope.topicId || session.mode !== 'normal' || this.store.isSessionDeleted(session.id) || !unit || !isDocumentUnit(unit)) throw error('scope_mismatch', '复核不属于此准确文档范围。')
    if (this.store.getStatus(session.id) === 'conflict') throw error('history_conflict', '历史副本已变化，请先处理冲突。')
    if (unit.sourceVersion !== target.sourceVersion) throw error('stale_source_version', '复核原稿已被新版本取代。')
    const manifest = unit.revisions.find(revision => revision.id === target.manifestRevisionId)
    if (!manifest || manifest.sourceVersion !== target.sourceVersion) throw error('manifest_missing', '此精确整篇候选不存在。')
    const handle = this.reader.captureDocument({ ownerId, topicId: scope.topicId, sessionId: session.id, unitId: unit.id, sourceVersion: target.sourceVersion, manifestRevisionId: manifest.id })
    if ('status' in handle) throw error(handle.status, `候选读取不可用：${handle.reason}`)
    return { unit, manifest, handle }
  }
  private async preparation(target: DocumentReviewTarget, unit: DocumentUnit, manifest: DocumentRevision): Promise<PreparationSnapshot> {
    const reference = unit.preparations.find(item => sameVersionReference(item, manifest.preparationRef)), source = reference && unit.sourceVersions.find(source => source.version === reference.sourceVersion)
    if (!source) throw error('preparation_missing', '此候选的准确准备引用不存在。')
    const hash = source.body.kind === 'asset' ? source.body.reference.sha256 : await sha256(source.body.text)
    const result = this.preparations.documentUnitPreparation(target.scope, manifest.preparationRef, hash)
    if (!result.ok) throw error(result.error.code, result.error.message)
    return result.value
  }
  private async sourceText(handle: DocumentReadHandle): Promise<string> {
    const parts: string[] = []
    for (let start = 0; start < handle.totalSourceCodePoints; start += MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) {
      const page = await handle.readSource({ start, end: Math.min(handle.totalSourceCodePoints, start + MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) })
      if (page.status !== 'ready') throw error(page.status, `原稿读取不可用：${page.reason}`)
      parts.push(page.text)
    }
    const changed = handle.check(); if (changed) throw error(changed.status, changed.reason)
    return parts.join('')
  }
  private assertStopped(unit: DocumentUnit): void {
    if (unit.tasks.some(task => task.sourceVersion === unit.sourceVersion && (['running', 'unknown', 'waiting_context', 'waiting_user'].includes(task.status) || task.executionFacts?.blocks.some(block => block.phase !== 'settled')))) throw error('prior_call_unconfirmed', '当前文档仍有运行中或未确认调用；只能查询原事实。')
  }
  private receipt(target: DocumentReviewTarget, operationId: string, manifestRevisionId = target.manifestRevisionId): DocumentReviewReceipt {
    const { unit } = this.locate(target.scope.ownerId, target), audit = [...(unit.reviewAudits ?? [])].reverse().find(item => item.operationId === operationId) ?? null
    const candidate = unit.revisions.find(item => item.id === manifestRevisionId)!
    return { target, operationId, reviewVersion: documentReviewVersion(unit), audit: audit ? { id: audit.id, reviewId: audit.reviewId, version: audit.version, mechanicalStatus: audit.mechanical.status, semanticStatus: audit.semantic.status } : null,
      manifestRevisionId, status: candidate.review.status === 'passed' ? 'passed' : candidate.review.status === 'failed' ? 'review_required' : 'pending',
      finalEligible: documentManifestFinalEligibility(unit, manifestRevisionId).eligible, storage: this.store.getSettings().rememberHistory && this.store.getStatus(target.scope.translationSessionId) === 'saved' ? 'saved' : 'runtime_only',
      storageError: this.store.getSettings().rememberHistory && this.store.getStatus(target.scope.translationSessionId) === 'saved' ? null : '当前复核事实仅在运行期或保存尚未确认。' }
  }
  async page(ownerId: string, raw: DocumentReviewPageRequest): Promise<AnalysisResult<DocumentReviewPage>> {
    try {
      const request = parseDocumentReviewPageRequest(raw), unit = this.store.getTranslationHistory(request.scope.translationSessionId)?.units.find(unit => unit.id === request.unitId)
      if (!unit || !isDocumentUnit(unit)) throw error('document_missing', '准确文档不存在。')
      const selected = request.manifestRevisionId ? unit.revisions.find(item => item.id === request.manifestRevisionId) : [...unit.revisions].reverse().find(item => item.sourceVersion === request.sourceVersion)
      if (!selected) throw error('manifest_missing', '当前源没有整篇候选。')
      const target = { scope: request.scope, unitId: request.unitId, sourceVersion: request.sourceVersion, manifestRevisionId: selected.id }, located = this.locate(ownerId, target)
      const { manifest, handle } = located, preparation = await this.preparation(target, unit, manifest), task = unit.tasks.find(task => task.taskId === manifest.taskId)
      if (!task) throw error('task_missing', '整篇候选的真实任务不存在。')
      const audits = (unit.reviewAudits ?? []).filter(item => item.manifestRevisionId === manifest.id || item.reviewedRevisionId === manifest.id), audit = audits.at(-1), section = request.section ?? 'summary'
      const records: readonly unknown[] = section === 'entries' ? handle.blocks.map(block => ({ chunkId: block.chunkId, revisionId: block.revisionId, outputRange: block.outputRange, mode: block.mode,
        status: block.revision?.status ?? 'missing', sourceVersion: block.revision?.sourceVersion ?? null, totalCodePoints: block.revision ? block.revision.content.kind === 'text' ? sourceCodePointLength(block.revision.content.text) : block.revision.content.range.end - block.revision.content.range.start : 0,
        preparationRef: block.revision?.preparationRef ?? null, actualContextRef: (() => {
          let revision = block.revision; const seen = new Set<string>()
          while (revision?.manualBase && !seen.has(revision.id)) { seen.add(revision.id); revision = unit.chunkRevisions.find(item => item.id === revision!.manualBase!.revisionId) ?? null }
          return revision?.callRecord?.contextRef ?? null
        })(), reuseRef: block.reuseRef ?? null,
        reuseApproval: block.reuseRef?.approvalId ? unit.reuseApprovals?.find(approval => approval.id === block.reuseRef?.approvalId) ?? null : null }))
        : section === 'issues' ? [...(audit?.mechanical.issues ?? []), ...(audit?.mechanical.suspicions ?? []), ...manifest.review.issues]
        : section === 'preparation' ? [{ kind: 'requirements', targetLanguage: preparation.targetLanguage, userRequirements: preparation.userRequirements, organizedRequirements: preparation.organizedRequirements },
          ...preparation.terms.map(value => ({ kind: 'term', value })), ...preparation.conflicts.map(value => ({ kind: 'conflict', value })), ...preparation.referenceRefs.map(value => ({ kind: 'reference', value })), ...preparation.backgroundRanges.map(value => ({ kind: 'background', value }))] : []
      const summary: DocumentReviewPage['summary'] = { taskId: task.taskId, taskVersion: task.executionFacts?.taskVersion ?? 1, taskSequence: task.executionFacts?.taskSequence ?? 0, operationId: task.operationId,
        planRef: manifest.planRef, preparationRef: manifest.preparationRef, totalSourceCodePoints: documentSourceLength(handle.source), entryCount: manifest.entries.length, currentSourceVersion: unit.sourceVersion,
        mechanicalStatus: audit?.mechanical.status ?? 'pending', semanticStatus: audit?.semantic.status ?? 'pending', beginAuditId: [...audits].reverse().find(item => item.semantic.status === 'pending')?.id ?? null,
        finalEligible: documentManifestFinalEligibility(unit, manifest.id).eligible, finalRevisionId: currentDocumentFinal(unit)?.id ?? null }
      const cursor = request.cursor ?? 0, items: unknown[] = [], page = (): DocumentReviewPage => ({ target, reviewVersion: documentReviewVersion(unit), section, summary, items, nextCursor: cursor + items.length < records.length ? cursor + items.length : null })
      if (cursor > records.length) throw error('invalid_cursor', '复核读取位置超过完整记录。')
      for (const record of records.slice(cursor, cursor + (request.limit ?? 25))) { items.push(record); if (documentReviewBytes({ ok: true, value: page() }) > MAX_DOCUMENT_REVIEW_PAGE_BYTES) { items.pop(); break } }
      if (records.length > cursor && !items.length) throw error('reply_too_large', '复核元数据单项超过分页上限。')
      const changed = handle.check(); if (changed) throw error(changed.status, changed.reason)
      return good(parseDocumentReviewPage(page()))
    } catch (failure) { const known = failure as { code?: string; message?: string }; return bad(known.code ?? 'review_read_failed', known.message ?? '复核读取未完成。') }
  }
  async read(ownerId: string, raw: DocumentReviewRead): Promise<AnalysisResult<DocumentReviewTextPage>> {
    try {
      const request = parseDocumentReviewRead(raw), { handle } = this.locate(ownerId, request.target)
      const result = request.side === 'source' ? await handle.readSource(request.range) : await handle.readChunk(request.revisionId!, request.range)
      if (result.status !== 'ready') return bad(result.status, result.reason)
      return good(parseDocumentReviewTextPage({ ...request, text: result.text, totalCodePoints: result.totalCodePoints }))
    } catch (failure) { const known = failure as { code?: string; message?: string }; return bad(known.code ?? 'review_read_failed', known.message ?? '准确复核页读取失败。') }
  }
  async observe(ownerId: string, raw: DocumentReviewQueryRequest): Promise<AnalysisResult<DocumentReviewReceipt | null>> {
    try { const request = parseDocumentReviewQueryRequest(raw), { unit } = this.locate(ownerId, request.target)
      const audit = request.operationId ? (unit.reviewAudits ?? []).find(item => item.operationId === request.operationId) : null
      const manual = request.operationId ? unit.chunkRevisions.find(item => item.childOperationId === request.operationId && item.manualBase?.manifestRevisionId === request.target.manifestRevisionId) : null
      const edited = manual && unit.revisions.find(item => item.parentRevisionId === request.target.manifestRevisionId && item.entries.some(entry => entry.revisionId === manual.id))
      if (request.operationId && !audit && !edited && unit.final?.selectionEventId !== request.operationId) return good(null)
      if (audit && audit.manifestRevisionId !== request.target.manifestRevisionId) return bad('scope_mismatch', '原操作属于另一个明确候选。')
      return good(this.receipt(request.target, request.operationId ?? 'document-review-query', audit?.reviewedRevisionId ?? edited?.id ?? request.target.manifestRevisionId))
    } catch (failure) { const known = failure as { code?: string; message?: string }; return bad(known.code ?? 'review_query_failed', known.message ?? '原复核操作查询失败。') }
  }
  private operation(ownerId: string, kind: 'begin' | 'submit' | 'manual' | 'final', request: DocumentReviewBeginRequest, execute: () => Promise<AnalysisResult<DocumentReviewReceipt>>): Promise<AnalysisResult<DocumentReviewReceipt>> {
    const key = JSON.stringify([ownerId, request.operationId]), signature = JSON.stringify([kind, request]), previous = this.operations.get(key)
    if (previous) return previous.signature === signature ? previous.result : Promise.resolve(bad('idempotency_conflict', '同一操作标识已经绑定另一复核意图。'))
    const result = execute(); this.operations.set(key, { signature, result }); return result
  }
  private async locked(ownerId: string, request: DocumentReviewBeginRequest, action: (unit: DocumentUnit, manifest: DocumentRevision, handle: DocumentReadHandle) => Promise<string>, requireLatest = true): Promise<AnalysisResult<DocumentReviewReceipt>> {
    const release = this.store.claimDocumentLease(request.target.scope.translationSessionId, `document-review:${request.operationId}`)
    if (!release) return bad('busy', '此翻译会话正在处理另一操作。')
    try {
      const { unit, manifest, handle } = this.locate(ownerId, request.target); this.assertStopped(unit)
      if (this.options.isSessionBusy?.(request.target.scope.translationSessionId)) throw error('busy', '此会话有另一翻译正在执行。')
      if (documentReviewVersion(unit) !== request.expectedReviewVersion) throw error('stale_review_version', '复核版本已变化，请读取当前候选再提交。')
      if (requireLatest && [...unit.revisions].reverse().find(item => item.sourceVersion === unit.sourceVersion)?.id !== manifest.id) throw error('stale_candidate', '已有更新的整篇候选，请复核当前候选。')
      const revisionId = await action(unit, manifest, handle)
      if (this.store.getSettings().rememberHistory) await this.store.saveTranslationHistoryAsync(request.target.scope.translationSessionId)
      this.emit(); return good(this.receipt(request.target, request.operationId, revisionId))
    } catch (failure) { const known = failure as { code?: string; message?: string }; return bad(known.code ?? 'review_write_failed', known.message ?? '复核写入未完成；请查询原操作。') }
    finally { release() }
  }
  begin(ownerId: string, raw: DocumentReviewBeginRequest): Promise<AnalysisResult<DocumentReviewReceipt>> {
    let request: DocumentReviewBeginRequest; try { request = parseDocumentReviewBeginRequest(raw) } catch { return Promise.resolve(bad('invalid_input', '机械复核参数无效。')) }
    return this.operation(ownerId, 'begin', request, () => this.locked(ownerId, request, async (unit, manifest, handle) => {
      const preparation = await this.preparation(request.target, unit, manifest), sourceText = await this.sourceText(handle)
      await this.verifyCopyPages(handle)
      const mechanical = await verifyDocumentMechanicalReview({ unit, manifestRevisionId: manifest.id, sourceText, preparation })
      const changed = handle.check(); if (changed) throw error(changed.status, changed.reason)
      const now = new Date().toISOString()
      const audit = { id: `document-review-audit:${crypto.randomUUID()}`, reviewId: `document-review:${crypto.randomUUID()}`, operationId: request.operationId, version: request.expectedReviewVersion + 1,
        parentAuditId: null, manifestRevisionId: manifest.id, reviewedRevisionId: null, sourceVersion: manifest.sourceVersion, planRef: manifest.planRef, preparationRef: manifest.preparationRef, checkedAt: now, mechanical,
        semantic: { status: 'pending' as const, reviewedEntries: [], preparationRef: null, resolvedIssues: [], issues: [], summary: '' } }
      if (!this.store.updateTranslationHistory(request.target.scope.translationSessionId, history => applyDocumentMutation(history, unit.id, { kind: 'review', expectedReviewVersion: request.expectedReviewVersion, audit }, now))) throw error('history_update_failed', '机械复核事实 CAS 未完成。')
      return manifest.id
    }))
  }
  submit(ownerId: string, raw: DocumentReviewSubmitRequest): Promise<AnalysisResult<DocumentReviewReceipt>> {
    let request: DocumentReviewSubmitRequest; try { request = parseDocumentReviewSubmitRequest(raw) } catch { return Promise.resolve(bad('invalid_input', '语义复核参数无效。')) }
    return this.operation(ownerId, 'submit', request, () => this.locked(ownerId, request, async (unit, manifest, handle) => {
      const begin = (unit.reviewAudits ?? []).find(item => item.id === request.beginAuditId)
      if (!begin || begin.manifestRevisionId !== manifest.id || begin.semantic.status !== 'pending') throw error('begin_missing', '语义复核没有绑定此候选的实际机械检查。')
      const sourceText = await this.sourceText(handle), preparation = await this.preparation(request.target, unit, manifest)
      await this.verifyCopyPages(handle)
      const mechanical = await verifyDocumentMechanicalReview({ unit, manifestRevisionId: manifest.id, sourceText, preparation })
      if (!same(mechanical, begin.mechanical)) throw error('mechanical_changed', '机械复核证据已变化，请核当前候选。')
      const now = new Date().toISOString(), reviewedRevisionId = `document-reviewed:${crypto.randomUUID()}`
      const audit = { ...begin, id: `document-review-audit:${crypto.randomUUID()}`, operationId: request.operationId, version: request.expectedReviewVersion + 1, parentAuditId: begin.id, reviewedRevisionId, checkedAt: now, semantic: request.semantic }
      if (!this.store.updateTranslationHistory(request.target.scope.translationSessionId, history => applyDocumentMutation(history, unit.id, { kind: 'review', expectedReviewVersion: request.expectedReviewVersion, audit }, now))) throw error('history_update_failed', '语义复核与新候选 CAS 未完成。')
      return reviewedRevisionId
    }))
  }
  manual(raw: DocumentManualRevisionRequest, notify = true): Promise<AnalysisResult<DocumentReviewReceipt>> {
    let request: DocumentManualRevisionRequest; try { request = parseDocumentManualRevisionRequest(raw) } catch { return Promise.resolve(bad('invalid_input', '人工块修订参数无效。')) }
    return this.operation(request.target.scope.ownerId, 'manual', request, async () => {
      const result = await this.locked(request.target.scope.ownerId, request, async (unit, _manifest, handle) => {
        const sourceText = await this.sourceText(handle), now = new Date().toISOString(), body = request.text ?? this.editedText(request, handle), changed = handle.check(); if (changed) throw error(changed.status, changed.reason)
        const revisionId = `document-manual:${crypto.randomUUID()}`, manifestRevisionId = `document-manifest:${crypto.randomUUID()}`
        if (!this.store.updateTranslationHistory(request.target.scope.translationSessionId, history => applyDocumentMutation(history, unit.id, { kind: 'manual', edit: { manifestRevisionId: request.target.manifestRevisionId,
          expectedReviewVersion: request.expectedReviewVersion, chunkId: request.chunkId, baseRevisionId: request.baseRevisionId, revisionId, manifestId: manifestRevisionId, operationId: request.operationId, text: body, at: now, sourceText } }, now))) throw error('history_update_failed', '人工块修订 CAS 未完成。')
        return manifestRevisionId
      })
      if (result.ok && notify) void this.notify({ ...request.target, manifestRevisionId: result.value.manifestRevisionId })
      return result
    })
  }
  /** Precise edits resolve against the immutable base chunk text, never against earlier replacements. */
  private editedText(request: DocumentManualRevisionRequest, handle: DocumentReadHandle): string {
    const block = handle.blocks.find(item => item.revisionId === request.baseRevisionId), content = block?.revision?.content
    if (!content || content.kind !== 'text') throw error('edit_base_unavailable', '精确修改需要当前候选中的真实文本块基准。')
    const applied = applyDocumentEdits(content.text, request.edits ?? [])
    if (!applied.ok) throw error(applied.code, applied.message)
    if (applied.text === content.text) throw error('edit_no_change', '精确修改没有改变正文；请核对 oldText 与 newText。')
    return applied.text
  }
  selectFinal(raw: DocumentFinalRequest): Promise<AnalysisResult<DocumentReviewReceipt>> {
    let request: DocumentFinalRequest; try { request = parseDocumentFinalRequest(raw) } catch { return Promise.resolve(bad('invalid_input', '最终版本参数无效。')) }
    return this.operation(request.target.scope.ownerId, 'final', request, () => this.locked(request.target.scope.ownerId, request, async (unit, manifest, handle) => {
      const sourceText = await this.sourceText(handle), preparation = await this.preparation(request.target, unit, manifest), mechanical = await verifyDocumentMechanicalReview({ unit, manifestRevisionId: manifest.id, sourceText, preparation })
      await this.verifyCopyPages(handle)
      if (mechanical.status !== 'passed' || !documentManifestFinalEligibility(unit, manifest.id).eligible) throw error('final_ineligible', '此候选尚未通过完整机械及主模型复核。')
      const now = new Date().toISOString()
      if (!this.store.updateTranslationHistory(request.target.scope.translationSessionId, history => applyDocumentMutation(history, unit.id, { kind: 'final', revisionId: manifest.id, at: now,
        operationId: request.operationId, expectedSourceVersion: request.target.sourceVersion, expectedReviewVersion: request.expectedReviewVersion }, now))) throw error('history_update_failed', '最终版本 CAS 未完成。')
      return manifest.id
    }, false))
  }
  private notify(target: DocumentReviewTarget): Promise<void> {
    const key = JSON.stringify(target), old = this.notices.get(key); if (old) return old
    const release = this.retain(target.scope.ownerId), run = (async () => { try { const remote = typeof this.options.remote === 'function' ? await this.options.remote() : this.options.remote; await remote?.notify({ target }) } catch { /* The pending candidate stays visible; no false review or final is recorded. */ } finally { release(); this.emit() } })()
    this.notices.set(key, run); return run
  }
  private async verifyCopyPages(handle: DocumentReadHandle): Promise<void> {
    for (const block of handle.blocks) {
      if (!block.revision || block.revision.content.kind !== 'source_copy') continue
      const length = block.revision.content.range.end - block.revision.content.range.start
      for (let start = 0; start < length; start += MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) {
        const page = await handle.readChunk(block.revision.id, { start, end: Math.min(length, start + MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) })
        if (page.status !== 'ready') throw error(page.status, `实际复制块读取或校验失败：${page.reason}`)
      }
    }
  }
  dispose(): void { this.disposed = true; this.listeners.clear(); this.operations.clear() }
}
