import { parseFileHistoryRequest, parseFileHistoryValue, type FileHistoryRequest, type FileHistoryValue, type FileHistoryUnit } from '../shared/file-history.js'
import type { NormalTranslationUnitTarget } from '../shared/normal-translation.js'
import type { FileJobRestart } from '../shared/file-jobs.js'
import type { FileJobSummary } from '../shared/file-jobs.js'
import type { FileJobTextVersion } from './file-jobs-store.js'
import type { SessionStore } from './session-store.js'
import type { FileJobsClient } from './file-jobs-client.js'
import type { MaterialSubmissionsClient } from './material-submissions.js'
import { currentDocumentFinalRevision, isDocumentUnit } from './translation-history.js'
import type { TranslationDocumentReader } from './source-reader.js'
import { readDocumentText, projectDocument } from './document-export.js'

function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code }) }
/** Browser history is authoritative after Host reload; no runtime task or material is fabricated. */
export class FileHistoryClient {
  constructor(private readonly sessions: SessionStore, private readonly jobs: FileJobsClient, private readonly materials: MaterialSubmissionsClient,
    private readonly namespaceId: () => string, private readonly uiLocale: () => string | undefined, private readonly reader: TranslationDocumentReader) {}
  unit(target: NormalTranslationUnitTarget): FileHistoryUnit {
    const session = this.sessions.getSession(target.translationSessionId)
    if (!session || session.ownerId !== target.mainSessionId && !this.sessions.isSessionOpen(target.mainSessionId, session.id) || session.mode !== 'normal' || this.sessions.isSessionDeleted(session.id) || this.sessions.getStatus(session.id) === 'conflict') fail('scope_mismatch', '文件历史不属于此主会话或已变化。')
    const blocked = this.materials.fileAccessBlockedReason?.(session.id, target.unitId)
    if (blocked) fail('unit_removed_or_conflicted', blocked)
    const record = this.jobs.forUnit(session.id, target.unitId)
    if (record) {
      const summary = record.summary
      if (this.jobs.isUnitRemoved(session.id, target.unitId) || summary.sourceVersion !== target.sourceVersion) fail('stale_source_version', '文件已移除或原稿版本已变化。')
      return { target, jobId: summary.jobId, name: summary.sourceRef?.name ?? '原稿.txt', sourceTotalCodePoints: summary.sourceTotalCodePoints,
        targetLanguage: summary.targetLanguage, instruction: summary.instruction, organizedRequirements: summary.organizedRequirements ?? null,
        createdAt: summary.createdAt, updatedAt: summary.updatedAt, phase: summary.phase, unsettled: !['completed', 'failed', 'cancelled'].includes(summary.phase),
        summaryVersion: summary.version, resultVersion: summary.result?.version ?? null, resultRevisionId: null }
    }
    const unit = this.sessions.getTranslationHistory(session.id)?.units.find(unit => unit.id === target.unitId)
    if (!unit || !isDocumentUnit(unit) || unit.deletion || unit.sourceVersion !== target.sourceVersion) fail('stale_source_version', '此准确文档单元不存在、已删除或源版本已变化。')
    const source = unit.sourceVersions.find(source => source.version === target.sourceVersion)!, task = unit.tasks.at(-1)
    const unsettled = unit.tasks.some(task => ['running', 'unknown', 'paused', 'waiting_context', 'waiting_user'].includes(task.status) || task.executionFacts?.blocks.some(block => block.phase !== 'settled'))
    return { target, jobId: null, name: source.body.kind === 'asset' ? source.body.reference.name : `文件 ${unit.order}`,
      sourceTotalCodePoints: source.body.kind === 'asset' ? source.body.reference.totalCodePoints : Array.from(source.body.text).length,
      targetLanguage: unit.targetLanguage, instruction: unit.instruction, organizedRequirements: null, createdAt: unit.createdAt,
      updatedAt: task?.createdAt ?? unit.createdAt, phase: task?.status ?? 'failed', unsettled, summaryVersion: null, resultVersion: null,
      resultRevisionId: currentDocumentFinalRevision(unit)?.id ?? null }
  }
  async handle(ownerId: string, raw: FileHistoryRequest): Promise<FileHistoryValue> {
    const request = parseFileHistoryRequest(raw)
    let value: FileHistoryValue
    if (request.action === 'list') {
      if (request.request.ownerId !== ownerId) fail('scope_mismatch', '文件列表所属主会话不符。')
      const items: FileHistoryUnit[] = []
      for (const session of this.sessions.getAvailableSessions(ownerId)) {
        if (session.ownerId !== ownerId && !this.sessions.isSessionOpen(ownerId, session.id) || session.mode !== 'normal' || request.request.translationSessionId && session.id !== request.request.translationSessionId) continue
        const targets = new Map<string, number>()
        for (const unit of this.sessions.getTranslationHistory(session.id)?.units ?? []) if (isDocumentUnit(unit) && !unit.deletion) targets.set(unit.id, unit.sourceVersion)
        for (const record of this.jobs.units(session.id)) targets.set(record.summary.unitId, record.summary.sourceVersion)
        for (const [unitId, sourceVersion] of targets) {
          if (this.jobs.isUnitRemoved(session.id, unitId)) continue
          items.push(this.unit({ kind: 'unit', mainSessionId: ownerId, translationSessionId: session.id, unitId, sourceVersion }))
        }
      }
      items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.target.unitId.localeCompare(b.target.unitId))
      const offset = request.request.offset ?? 0, page: FileHistoryUnit[] = []
      for (const item of items.slice(offset, offset + Math.min(20, request.request.limit ?? 20))) {
        if (new TextEncoder().encode(JSON.stringify({ action: 'list', items: [...page, item], nextOffset: items.length })).byteLength > 30000) break
        page.push(item)
      }
      if (!page.length && offset < items.length) fail('page_too_large', '单个文件元数据超过回复预算，未截断。')
      value = { action: 'list', items: page, nextOffset: offset + page.length < items.length ? offset + page.length : null }
    } else if (request.action === 'read' || request.action === 'revise') {
      if (request.request.ownerId !== ownerId) fail('scope_mismatch', '文件记录所属主会话不符。')
      const record = this.jobs.get(request.request.jobId)
      if (!record) fail('not_found', '此任务尚无已保存文件记录。')
      const current = this.unit({ kind: 'unit', mainSessionId: ownerId, translationSessionId: record.summary.translationSessionId, unitId: record.summary.unitId, sourceVersion: record.summary.sourceVersion })
      if (request.action === 'revise' && (current.jobId !== request.request.jobId || current.unsettled)) fail('stale_job', '此单元已有较新的任务，请读取最新任务后修订。')
      const scope = { ownerId, mainSessionId: ownerId, ...(record.summary.ownerId !== ownerId ? { historyOwnerId: record.summary.ownerId } : {}) }
      if (request.action === 'read') {
        const page = this.jobs.readSaved({ ...request.request, ownerId: record.summary.ownerId })
        value = { action: 'read', page: { ...page, summary: { ...page.summary, ...scope } } }
      } else value = { action: 'revise', summary: { ...await this.jobs.reviseSaved({ ...request.request, ownerId: record.summary.ownerId }, ownerId), ...scope } }
    } else {
      if (request.target.mainSessionId !== ownerId) fail('scope_mismatch', '文件单元所属主会话不符。')
      const unit = this.unit(request.target)
      if (request.action === 'unit') value = { action: 'unit', unit }
      else if (request.action === 'source') {
        if (request.range.end > unit.sourceTotalCodePoints) fail('invalid_range', '范围超出准确原稿。')
        let text: string
        if (unit.jobId) text = this.jobs.readSaved({ ownerId: this.jobs.get(unit.jobId)!.summary.ownerId, jobId: unit.jobId, section: 'source', range: request.range }).text!
        else {
          const session = this.sessions.getSession(request.target.translationSessionId)!
          const handle = this.reader.captureDocument({ ownerId, topicId: session.topicId, sessionId: session.id, unitId: request.target.unitId, sourceVersion: request.target.sourceVersion, manifestRevisionId: null })
          if ('status' in handle) fail(handle.status, '此准确原稿暂不可读取。')
          const page = await readDocumentText(range => handle.readSource(range), request.range)
          if (!('text' in page) || handle.check()) fail('source_unavailable', '此准确原稿读取或完整性检查未完成。')
          text = page.text
        }
        this.unit(request.target)
        value = { action: 'source', target: request.target, range: request.range, totalCodePoints: unit.sourceTotalCodePoints, text }
      }
      else {
        const existing = this.jobs.all().find(record => record.summary.ownerId === ownerId && record.summary.operationId === request.operationId)?.summary
        if (existing) {
          if (existing.unitId !== request.target.unitId || existing.translationSessionId !== request.target.translationSessionId || existing.sourceVersion !== request.target.sourceVersion || request.organizedRequirements.trim() && existing.organizedRequirements !== request.organizedRequirements) fail('idempotency_conflict', '原重译操作已被记录，不能更换目标或要求。')
          value = { action: 'restart', existing }
        } else {
          if (unit.unsettled || this.sessions.hasDocumentLease(request.target.translationSessionId)) fail('prior_call_unconfirmed', '此会话有未结算或未知任务，未重新派发。')
          const session = this.sessions.getSession(request.target.translationSessionId)!
          if (session.archivedAt !== null || !session.model) fail('configuration_required', '请恢复会话并选择本次翻译模型。')
          const restart = unit.jobId ? await this.jobs.prepareRestart(unit.jobId, request.operationId, request.organizedRequirements, ownerId)
            : await this.legacyRestart(unit, request.operationId, request.organizedRequirements)
          // Check scope again after all storage awaits; never return a source for a replaced unit.
          this.unit(request.target)
          value = { action: 'restart', restart }
        }
      }
    }
    return parseFileHistoryValue(value)
  }
  private async legacyRestart(facts: FileHistoryUnit, operationId: string, organizedRequirements: string): Promise<FileJobRestart> {
    const { target } = facts, session = this.sessions.getSession(target.translationSessionId)!
    if (session.archivedAt !== null || !session.model) fail('configuration_required', '请恢复会话并选择本次翻译模型。')
    const unit = this.sessions.getTranslationHistory(session.id)!.units.find(unit => unit.id === target.unitId)!
    if (!isDocumentUnit(unit)) fail('scope_mismatch', '此单元不是文档。')
    const source = unit.sourceVersions.find(source => source.version === target.sourceVersion)!
    const stored = source.body.kind === 'asset' ? await this.sessions.readStoredSourceRequest({ sessionId: session.id, unitId: unit.id, sourceVersion: source.version }) : null
    const commit = source.historyCommit, librarySource = stored && commit ? { stored, namespaceId: this.namespaceId(), prepareToken: commit.reference.prepareToken } : undefined
    const current = librarySource ? { ...stored!.source, persistence: 'runtime_only' as const } : (await this.materials.resolveFileSource(session.id, unit.id))?.sourceRef
    if (!current) fail('source_reference_unconfirmed', '此准确原稿没有可恢复的保存证明或运行期来源，请重新选择原文件。')
    const sources: FileJobTextVersion[] = [], results: FileJobTextVersion[] = []
    for (const version of unit.sourceVersions) {
      const handle = this.reader.captureDocument({ ownerId: target.mainSessionId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, sourceVersion: version.version, manifestRevisionId: null })
      if ('status' in handle) fail('source_unavailable', '旧原稿版本未完整读取，未启动重译。')
      const text = await readDocumentText(range => handle.readSource(range), { start: 0, end: handle.totalSourceCodePoints })
      if (!('text' in text) || handle.check()) fail('source_unavailable', '旧原稿版本未完整读取，未启动重译。')
      sources.push({ version: version.version, text: text.text, createdAt: version.createdAt })
    }
    for (const [index, revision] of unit.revisions.entries()) {
      if (!revision.eligibility.complete) continue
      const handle = this.reader.captureDocument({ ownerId: target.mainSessionId, topicId: session.topicId, sessionId: session.id, unitId: unit.id, sourceVersion: revision.sourceVersion, manifestRevisionId: revision.id })
      if ('status' in handle) fail('result_unavailable', '旧译文版本暂不可读取，未启动重译。')
      const projection = await projectDocument(handle, false, 'candidate')
      if (!projection.complete || projection.text === null) fail('result_incomplete', '旧译文版本未完整读取，未启动重译。')
      results.push({ version: index + 1, text: projection.text, createdAt: revision.createdAt, legacyRevisionId: revision.id, semanticStatus: revision.review.status === 'passed' ? 'passed' : 'pending' })
    }
    // Recheck the exact immutable history before making the file view own these copied versions.
    const latest = this.sessions.getTranslationHistory(session.id)?.units.find(candidate => candidate.id === unit.id)
    if (JSON.stringify(latest) !== JSON.stringify(unit)) fail('stale_version', '复制旧版本期间文档已变化，未启动重译。')
    const selected = results.find(result => result.legacyRevisionId === facts.resultRevisionId), last = results.at(-1), timestamp = new Date().toISOString()
    const summary: FileJobSummary = { ownerId: target.mainSessionId, mainSessionId: target.mainSessionId, topicId: session.topicId, translationSessionId: session.id,
      jobId: `saved-document:${unit.id}`, unitId: unit.id, materialId: unit.id.replace(/^unit:/u, ''), sourceVersion: unit.sourceVersion, sourceRef: current,
      sourceTotalCodePoints: facts.sourceTotalCodePoints, targetLanguage: unit.targetLanguage, instruction: unit.instruction, model: null, historyOrigin: 'legacy_document',
      operationId: `preserve-document:${unit.id}`, requestId: `saved-document:${unit.id}`, createdAt: unit.createdAt, updatedAt: timestamp, version: 1,
      phase: last ? 'completed' : 'failed', progress: { completed: 0, total: 0 }, baselineVersion: null,
      result: last ? { version: last.version, totalCodePoints: Array.from(last.text).length, semanticStatus: last.semanticStatus! } : null,
      proposalBatch: null, review: { version: 0, status: selected ? 'passed' : 'not_ready', reviewedBy: null, decidedAt: null }, notification: 'not_needed', error: null }
    await this.jobs.preserveDocument({ schemaVersion: 1, summary, sources, results, proposals: [], proposalVersion: null, workers: [], cards: [],
      final: selected ? { version: selected.version, selection: unit.final?.selection ?? 'automatic', selectedAt: timestamp } : null })
    const locale = this.uiLocale()?.trim().slice(0, 64)
    return { operationId, organizedRequirements, previousResultVersion: Math.max(0, ...results.map(result => result.version)), ...(librarySource ? { librarySource } : {}), envelope: {
      ownerId: target.mainSessionId, mainSessionId: target.mainSessionId, requestId: `file-restart:${operationId}`, operationId,
      ...(locale ? { uiLocale: locale } : {}), kind: 'material', material: { materialId: unit.id.replace(/^unit:/u, ''), sourceVersion: target.sourceVersion,
        topicId: session.topicId, translationSessionId: session.id, draftVersion: 1, targetLanguage: unit.targetLanguage, instruction: unit.instruction,
        model: session.model, maxInputChars: session.maxInputChars, sourceRef: current } } }
  }
}
