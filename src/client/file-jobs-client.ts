import { currentFileJob } from '../memory/file-job-current.js'
import { fileResultDeletionBlockedReason, eraseFileResult, fileSourceDeletionBlockedReason, eraseFileSource } from '../memory/file-job-deletion.js'
import { MAX_FILE_JOB_TEXT_POINTS, parseFileJobResult, type FileJobsPort, type FileJobRestart, type FileJobReadReview, type FileJobSummary, type FileJobReviewPage, type FileJobProposal, type FileJobWorker, type FileJobResult } from '../shared/file-jobs.js'
import type { EvidenceReadRequest, EvidenceReadResult, EvidenceUnavailableResult } from '../shared/translation-evidence.js'
import type { FileProposalAcceptance, TermEvidenceFact, TermEvidenceRef, TopicTermPut } from '../memory/topic-terms.js'
import type { TopicArchivePut } from '../memory/topic-archive.js'
import type { SessionStore } from './session-store.js'
import type { TranslationEvidenceReader } from './source-reader.js'
import type { TopicMemoryStore } from './topic-memory-store.js'
import type { TopicArchiveStore } from './topic-archive-store.js'
import type { ViewFilesClient } from './view-files-client.js'
import type { MaterialSubmissionsClient } from './material-submissions.js'
import { FileJobsStore, type FileJobCardState, type FileJobRecord, type FileJobTextVersion } from './file-jobs-store.js'
import type { FileJobExportUnit } from './translation-export.js'
import { reviewFileProposals, fileRevisionEvidence, type FileProposalReviews } from './file-proposal-revisions.js'
import { applyFileJobEdits } from '../shared/file-job-edits.js'
import type { FileJobRevision } from '../shared/file-jobs.js'
import { isDocumentUnit, isFileJobUnit, isTextUnit, revisionMatchesCurrentSource, type FileJobUnit } from './translation-history.js'
import { parseDirectProposalSubmission, type DirectProposalSubmission, type DirectProposalReceipt } from '../shared/direct-proposals.js'
import { putAssetProposals } from './topic-asset-actions.js'
export type { FileJobRecord, FileJobCardState } from './file-jobs-store.js'

export type FileJobsRemotePort = { [K in keyof FileJobsPort]: (request: Parameters<FileJobsPort[K]>[0]) => Promise<unknown> }
type Remote = FileJobsRemotePort | (() => Promise<FileJobsRemotePort | undefined>) | undefined
const running = (job: FileJobSummary): boolean => !['completed', 'failed', 'cancelled'].includes(job.phase)
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
const unavailable = (request: EvidenceReadRequest | null, reason: string): EvidenceUnavailableResult => ({ status: 'missing', request, reason })
function rememberText(values: readonly FileJobTextVersion[], version: number, text: string, createdAt: string): readonly FileJobTextVersion[] {
  const old = values.find(value => value.version === version)
  if (old && old.text !== text) throw new Error('固定文件版本内容已变化；原副本仍保留。')
  return old ? values : [...values, { version, text, createdAt }]
}
export function proposalDependencies(proposal: FileJobProposal): readonly string[] {
  return proposal.kind === 'fact' ? proposal.entityCandidateIds : proposal.kind === 'relation' ? [...new Set([proposal.sourceEntityCandidateId, proposal.targetEntityCandidateId])] : []
}
export function proposalTitle(proposal: FileJobProposal): string {
  return proposal.kind === 'term' ? proposal.sourceForms.join('、') : proposal.kind === 'entity' ? proposal.name : proposal.kind === 'fact' ? proposal.title : proposal.relation
}
async function assetIdentity(jobId: string, candidateId: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([jobId, candidateId])))
  return `file-asset:${Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('')}`
}

/** Root-owned polling copies exact Host facts and stays alive while individual views are closed. */
export class FileJobsClient implements TranslationEvidenceReader {
  private readonly records: FileJobsStore
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Set<string>()
  private readonly leases = new Map<string, () => void>()
  private readonly retentions = new Map<string, () => void>()
  private readonly stopStore: () => void
  private readonly timer: ReturnType<typeof setInterval>
  private retainOwner: ((ownerId: string) => () => void) | undefined
  private assets: { terms: TopicMemoryStore; archive: TopicArchiveStore } | undefined
  private stopAssets: (() => void)[] = []
  private materials: MaterialSubmissionsClient | undefined
  private assetNamespaceId: (() => string) | undefined
  private syncing = false
  private disposed = false
  private notice: string | undefined
  canExecute(ownerId?: string): boolean { return Boolean(ownerId && ownerId !== this.sessions.getNamespaceId()) }
  getNamespaceId(): string { return this.sessions.getNamespaceId() }
  private readonly missingHosts = new Set<string>()
  private readonly projectedVersions = new Map<string, number>()
  private readonly boundOwners = new Map<string, number>()
  private readonly retranslationIntents = new Map<string, { request: import('../shared/normal-translation.js').NormalTranslationUnitRequest; status: 'pending' | 'submitted' | 'unknown' | 'failed'; message: string }>()
  getRetranslationStatus(jobId: string) { return this.retranslationIntents.get(jobId) }
  constructor(private readonly sessions: SessionStore, private readonly fallback: TranslationEvidenceReader, private readonly remote: Remote,
    private readonly uiLocale?: () => string | undefined) {
    this.records = new FileJobsStore(sessions.createFileJobsStoreOptions(), () => { this.units(undefined, true); this.emit() })
    this.units(undefined, true)
    this.stopStore = sessions.subscribe(() => {
      this.records.reconcile(); this.reconcileLeases()
      for (const [id, intent] of this.retranslationIntents) if (this.sourceDeleted(intent.request.target.translationSessionId, intent.request.target.unitId, intent.request.target.sourceVersion)) this.retranslationIntents.delete(id)
    })
    this.timer = setInterval(() => { void this.refresh() }, 1800)
    queueMicrotask(() => { void this.refresh() })
  }
  setAssets(terms: TopicMemoryStore, archive: TopicArchiveStore, retain: (ownerId: string) => () => void): void {
    for (const stop of this.stopAssets) stop()
    this.stopAssets = [terms.subscribe(() => this.emit()), archive.subscribe(() => this.emit())]
    this.assets = { terms, archive }; this.retainOwner = retain; this.reconcileLeases()
  }
  proposalReviews(record: FileJobRecord): FileProposalReviews {
    if (this.assets) {
      for (const store of [this.assets.terms, this.assets.archive]) {
        const state = store.getReadState(record.summary.mainSessionId, record.summary.topicId)
        if (state.status !== 'ready' || state.retired) {
          if (state.status === 'idle') void store.ensureLoaded(record.summary.mainSessionId, record.summary.topicId).catch(() => {})
          return Object.fromEntries(record.proposals.map(proposal => [proposal.candidateId,
            { kind: 'blocked' as const, message: state.retired ? '此主题记忆已删除，不能采纳提案。' : state.error ?? '正在读取主题记忆，请完成后再审阅提案。' }]))
        }
      }
    }
    return reviewFileProposals(record, this.assets?.terms.getSnapshot(record.summary.mainSessionId, record.summary.topicId).entries ?? [],
      this.assets?.archive.getSnapshot(record.summary.mainSessionId, record.summary.topicId).entries ?? [])
  }
  setMaterials(materials: MaterialSubmissionsClient, assetNamespaceId?: () => string): void { this.materials = materials; this.assetNamespaceId = assetNamespaceId }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  bindOwner(ownerId: string): () => void {
    this.boundOwners.set(ownerId, (this.boundOwners.get(ownerId) ?? 0) + 1); void this.refresh()
    return () => { const count = this.boundOwners.get(ownerId) ?? 0; if (count <= 1) this.boundOwners.delete(ownerId); else this.boundOwners.set(ownerId, count - 1) }
  }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  getNotice(): string | undefined { return this.notice }
  get(jobId: string): FileJobRecord | undefined { return this.records.all().find(record => record.summary.jobId === jobId) }
  all(sessionId?: string, topicId?: string): readonly FileJobRecord[] {
    return this.records.all().filter(record => (!sessionId || record.summary.translationSessionId === sessionId) && (!topicId || record.summary.topicId === topicId) && !this.unitDeleted(record.summary.translationSessionId, record.summary.unitId))
      .sort((left, right) => Date.parse(left.summary.createdAt) - Date.parse(right.summary.createdAt))
  }
  /** Candidates go directly to the four ordinary archives, without a separate review batch. */
  async submitDirectProposals(ownerId: string, raw: DirectProposalSubmission): Promise<DirectProposalReceipt> {
    const request = parseDirectProposalSubmission(raw), target = request.target
    const session = this.sessions.getSession(target.translationSessionId)
    const unit = this.sessions.getTranslationHistory(target.translationSessionId)?.units.find(unit => unit.id === target.unitId)
    const revision = unit && isTextUnit(unit) ? unit.revisions.at(-1) : undefined
    if (ownerId !== target.mainSessionId || !session || !this.sessions.isSessionOpen(ownerId, session.id) || !unit || !isTextUnit(unit) || unit.deletion ||
      unit.sourceVersion !== target.sourceVersion || !revision || revision.id !== request.revisionId || revision.status !== 'completed' || !revisionMatchesCurrentSource(unit, revision))
      throw Object.assign(new Error('原文或译文版本已变化，或不属于已打开会话，请重新读取后总结提案。'), { code: 'stale_proposals' })
    const proposals: FileJobProposal[] = request.proposals.map(({ quotes, ...proposal }) => ({ ...proposal, origin: 'inferred', disposition: 'pending', evidence: quotes.map((quote, index) => {
      const offset = unit.source.indexOf(quote)
      if (offset < 0) throw new Error(`候选 ${proposal.candidateId} 的 quotes[${index}] 未出现在此单元原文中，请复制准确原文。`)
      if (unit.source.indexOf(quote, offset + 1) >= 0) throw new Error(`候选 ${proposal.candidateId} 的 quotes[${index}] 在原文出现多次，请扩大为包含上下文的唯一片段；同一原文可以支持多个不同候选。`)
      const start = Array.from(unit.source.slice(0, offset)).length
      return { range: { start, end: start + Array.from(quote).length } }
    }) }))
    if (!this.assets) throw new Error('主题记忆尚未就绪，请重新打开记忆资产。')
    const check = (): void => {
      const current = this.sessions.getTranslationHistory(session.id)?.units.find(item => item.id === unit.id)
      if (!current || !isTextUnit(current) || current.deletion || current.sourceVersion !== unit.sourceVersion || current.source !== unit.source || current.revisions.at(-1)?.id !== revision.id || !this.sessions.isSessionOpen(ownerId, session.id))
        throw Object.assign(new Error('原文或译文已变化，请重新总结。'), { code: 'stale_proposals' })
    }
    const result = await putAssetProposals(this.assets.terms, this.assets.archive, { ownerId, topicId: session.topicId, sessionId: session.id,
      unitId: unit.id, sourceVersion: unit.sourceVersion, targetLanguage: unit.targetLanguage }, proposals, check)
    return { ...result, persistence: 'saved' }
  }
  units(sessionId?: string, includeRemoved = false): readonly FileJobRecord[] {
    const groups = new Map<string, FileJobRecord[]>()
    for (const record of this.all(sessionId)) {
      const key = JSON.stringify([record.summary.translationSessionId, record.summary.unitId])
      groups.set(key, [...groups.get(key) ?? [], record])
    }
    return [...groups.values()].filter(records => includeRemoved || !records.some(record => record.summary.removedAt)).map(records => {
      const unit = this.sessions.getTranslationHistory(records[0]!.summary.translationSessionId)?.units.find(unit => unit.id === records[0]!.summary.unitId)
      const merged = currentFileJob(records, unit?.sourceVersion)!.record
      this.registerUnit(merged)
      return merged
    })
  }
  private registerUnit(record: FileJobRecord): void {
    const job = record.summary, history = this.sessions.getTranslationHistory(job.translationSessionId)
    if (!history || this.sessions.isSessionDeleted(job.translationSessionId)) return
    const old = history.units.find(unit => unit.id === job.unitId)
    if (old && !isFileJobUnit(old)) return
    if (old && old.sourceVersion > job.sourceVersion) return
    const removedAt = this.isUnitRemoved(job.translationSessionId, job.unitId) ? job.removedAt ?? this.all(job.translationSessionId).find(value => value.summary.unitId === job.unitId && value.summary.removedAt)!.summary.removedAt! : undefined
    if (old && old.sourceVersion === job.sourceVersion && (!!old.deletion || !removedAt)) return
    const identity: FileJobUnit = { kind: 'file_job', id: job.unitId, order: old?.order ?? history.units.length + 1,
      createdAt: old?.createdAt ?? job.createdAt, sourceVersion: job.sourceVersion,
      deletion: old?.deletion ?? (removedAt ? { eventId: `file-removed:${job.unitId}`, at: removedAt } : null) }
    this.sessions.updateTranslationHistory(job.translationSessionId, current => ({ ...current,
      units: old ? current.units.map(unit => unit.id === old.id ? identity : unit) : [...current.units, { ...identity, order: current.units.length + 1 }] }))
  }
  unitRecord(jobId: string): FileJobRecord | undefined { const record = this.get(jobId); return record && this.forUnit(record.summary.translationSessionId, record.summary.unitId) }
  forUnit(sessionId: string, unitId: string): FileJobRecord | undefined { return this.units(sessionId, true).find(record => record.summary.unitId === unitId) }
  isUnitRemoved(sessionId: string, unitId: string): boolean { return this.all(sessionId).some(record => record.summary.unitId === unitId && !!record.summary.removedAt) }
  private unitDeleted(sessionId: string, unitId: string): boolean {
    const unit = this.sessions.getTranslationHistory(sessionId)?.units.find(unit => unit.id === unitId)
    return !!unit?.deletion && (!isFileJobUnit(unit) || unit.deletion.calls !== undefined)
  }
  private sourceDeleted(sessionId: string, unitId: string, version: number): boolean {
    return this.sessions.getTranslationHistory(sessionId)?.events.some(event => event.type === 'source.deleted' && event.unitId === unitId && event.sourceVersion === version) ?? false
  }
  unitDeletionBlockedReason(jobId: string): string | undefined {
    const record = this.get(jobId)
    if (!record) return '文件单元已不可用。'
    if (this.all(record.summary.translationSessionId).some(item => item.summary.unitId === record.summary.unitId && (running(item.summary) || this.pending.has(item.summary.jobId)))) return '此文件仍有未结算操作，请先结束或查询。'
    return this.sessions.getTextUnitDeletionBlockedReason(record.summary.translationSessionId, record.summary.unitId)
  }
  captureUnitDeletion(jobId: string): import('./session-store.js').TextUnitDeletionPlan | undefined {
    const record = this.get(jobId)
    return record && !this.unitDeletionBlockedReason(jobId) ? this.sessions.captureTextUnitDeletion(record.summary.translationSessionId, record.summary.unitId) : undefined
  }
  async deleteUnit(plan: import('./session-store.js').TextUnitDeletionPlan): Promise<void> {
    const result = await this.sessions.deleteTextUnitAsync(plan, { blockedReason: () => {
      const record = this.all(plan.sessionId).find(record => record.summary.unitId === plan.unitId)
      return record && this.unitDeletionBlockedReason(record.summary.jobId)
    } })
    this.notice = result.message; this.emit()
  }
  resultDeletionBlockedReason(jobId: string, version: number): string | undefined {
    const record = this.unitRecord(jobId)
    return !record ? '文件单元已不可用。' : this.unitDeletionBlockedReason(jobId) ?? fileResultDeletionBlockedReason(this.all(record.summary.translationSessionId).filter(item => item.summary.unitId === record.summary.unitId), record.summary.sourceVersion, version)
  }
  captureResultDeletion(jobId: string, version: number): (import('./session-store.js').TextUnitDeletionPlan & { readonly resultVersion: number }) | undefined {
    const record = this.unitRecord(jobId)
    if (!record || this.resultDeletionBlockedReason(jobId, version)) return undefined
    const plan = this.sessions.captureTextUnitDeletion(record.summary.translationSessionId, record.summary.unitId)
    return plan && { ...plan, resultVersion: version }
  }
  async deleteResult(plan: import('./session-store.js').TextUnitDeletionPlan & { readonly resultVersion: number }): Promise<void> {
    const result = await this.sessions.deleteFileResultAsync(plan, () => {
      const record = this.forUnit(plan.sessionId, plan.unitId)
      return record ? this.resultDeletionBlockedReason(record.summary.jobId, plan.resultVersion) : '文件单元已变化。'
    })
    this.notice = result.message; this.emit()
  }
  sourceDeletionBlockedReason(jobId: string, version: number): string | undefined {
    const record = this.unitRecord(jobId)
    return !record ? '文件单元已不可用。' : this.unitDeletionBlockedReason(jobId) ?? fileSourceDeletionBlockedReason(this.all(record.summary.translationSessionId).filter(item => item.summary.unitId === record.summary.unitId), record.summary.sourceVersion, version)
  }
  captureSourceDeletion(jobId: string, version: number): (import('./session-store.js').TextUnitDeletionPlan & { readonly sourceVersion: number }) | undefined {
    const record = this.unitRecord(jobId)
    if (!record || this.sourceDeletionBlockedReason(jobId, version)) return undefined
    const plan = this.sessions.captureTextUnitDeletion(record.summary.translationSessionId, record.summary.unitId)
    return plan && { ...plan, sourceVersion: version }
  }
  async deleteSource(plan: import('./session-store.js').TextUnitDeletionPlan & { readonly sourceVersion: number }): Promise<void> {
    const result = await this.sessions.deleteFileSourceAsync(plan, () => {
      const record = this.forUnit(plan.sessionId, plan.unitId)
      return record ? this.sourceDeletionBlockedReason(record.summary.jobId, plan.sourceVersion) : '文件单元已变化。'
    })
    this.notice = result.message; this.emit()
  }
  exportUnits(sessionIds: readonly string[]): readonly FileJobExportUnit[] {
    return this.units().filter(record => sessionIds.includes(record.summary.translationSessionId)).map(record => {
      const selected = currentFileJob(this.all(record.summary.translationSessionId).filter(value => value.summary.unitId === record.summary.unitId), record.summary.sourceVersion)!
      return { sessionId: record.summary.translationSessionId, topicId: record.summary.topicId, unitId: record.summary.unitId,
        createdAt: record.summary.createdAt, sourceVersion: record.summary.sourceVersion, targetLanguage: selected.targetLanguage,
        source: selected.source?.text ?? null, translation: selected.final?.text ?? null, resultVersion: selected.final?.version ?? null, selection: selected.record.final?.selection ?? null }
    })
  }
  status(jobId: string) { return this.records.status(jobId) }
  async preserveDocument(record: FileJobRecord): Promise<void> {
    if (this.forUnit(record.summary.translationSessionId, record.summary.unitId)) return
    this.records.put(record)
    if (!await this.records.persist(record.summary.jobId)) throw new Error('旧文档版本保存未完成，尚未启动重译。')
  }
  isBusy(jobId: string): boolean { return this.pending.has(jobId) }
  hostUnavailable(jobId: string): boolean { return this.missingHosts.has(jobId) }
  pendingCount(record: FileJobRecord): number {
    return record.summary.proposalBatch?.status === 'reviewed' ? record.proposals.filter(proposal => proposal.disposition !== 'rejected' &&
      !record.cards.some(card => card.candidateId === proposal.candidateId && card.status !== 'pending')).length : 0
  }
  private async call<K extends keyof FileJobsPort>(method: K, request: Parameters<FileJobsPort[K]>[0]): Promise<Awaited<ReturnType<FileJobsPort[K]>> extends FileJobResult<infer T> ? T : never> {
    const remote = typeof this.remote === 'function' ? await this.remote() : this.remote
    if (!remote || this.disposed) throw new Error('文件任务服务暂不可用；已保存版本仍可查阅。')
    const raw = await (remote[method] as (request: unknown) => Promise<unknown>)(request)
    const transport = raw as { readonly ok?: boolean; readonly value?: { readonly ok?: boolean } }
    const result = parseFileJobResult(transport?.ok === true && typeof transport.value?.ok === 'boolean' ? transport.value : raw) as FileJobResult<unknown>
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, stage: result.error.stage })
    return result.value as Awaited<ReturnType<FileJobsPort[K]>> extends FileJobResult<infer T> ? T : never
  }
  private reconcileLeases(): void {
    const live = this.records.all().filter(record => running(record.summary) && !this.missingHosts.has(record.summary.jobId))
    const ids = new Set(live.map(record => record.summary.jobId))
    for (const [id, release] of this.leases) if (!ids.has(id)) { this.leases.delete(id); release() }
    for (const [id, release] of this.retentions) if (!ids.has(id)) { this.retentions.delete(id); release() }
    for (const record of live) {
      const job = record.summary
      if (!this.leases.has(job.jobId)) { const release = this.sessions.claimDocumentLease(job.translationSessionId, job.jobId); if (release) this.leases.set(job.jobId, release) }
      if (!this.retentions.has(job.jobId) && this.retainOwner) this.retentions.set(job.jobId, this.retainOwner(job.mainSessionId))
    }
  }
  async refresh(): Promise<void> {
    if (this.disposed || this.syncing) return
    this.syncing = true
    try {
      const owners = [...new Set([...this.boundOwners.keys(), ...this.sessions.getOpenOwnerIds(), ...this.records.all().map(record => record.summary.mainSessionId)])].filter(ownerId => this.canExecute(ownerId))
      const errors: string[] = []
      for (const ownerId of owners) {
        try {
        let offset: number | null = 0
        const found = new Set<string>()
        do {
          const page: { readonly items: readonly FileJobSummary[]; readonly nextOffset: number | null } = await this.call('list', { ownerId, offset, limit: 20 })
          for (const summary of page.items) { found.add(summary.jobId); await this.project(summary) }
          offset = page.nextOffset
        } while (offset !== null && !this.disposed)
        for (const record of this.records.all()) if (record.summary.mainSessionId === ownerId && !found.has(record.summary.jobId)) this.missingHosts.add(record.summary.jobId)
        } catch (cause) { errors.push(cause instanceof Error ? cause.message : '文件任务状态暂未取得。') }
      }
      this.notice = [...new Set(errors)].join(' ') || undefined
      for (const [jobId, intent] of this.retranslationIntents) if (this.records.all().some(record => record.summary.operationId === intent.request.operationId && record.summary.mainSessionId === intent.request.target.mainSessionId && record.summary.unitId === intent.request.target.unitId)) this.retranslationIntents.delete(jobId)
    } catch (cause) { this.notice = cause instanceof Error ? cause.message : '文件任务状态暂未取得。' }
    finally { this.syncing = false; this.reconcileLeases(); this.emit() }
  }
  private async text(summary: FileJobSummary, section: 'source' | 'result', length: number, resultVersion?: number): Promise<string> {
    const pieces: string[] = []
    for (let start = 0; start < length; start += MAX_FILE_JOB_TEXT_POINTS) {
      const range = { start, end: Math.min(length, start + MAX_FILE_JOB_TEXT_POINTS) }
      const page = await this.call('readReview', { ownerId: summary.mainSessionId, jobId: summary.jobId, section, range, ...(resultVersion === undefined ? {} : { resultVersion }) })
      if (page.summary.version !== summary.version || !same(page.range, range) || typeof page.text !== 'string' || Array.from(page.text).length !== range.end - range.start) throw new Error('文件任务在读取期间有更新，将读取新的完整版本。')
      pieces.push(page.text)
    }
    return pieces.join('')
  }
  private async items(summary: FileJobSummary, section: FileJobReadReview['section']): Promise<NonNullable<FileJobReviewPage['items']>> {
    const items: NonNullable<FileJobReviewPage['items']>[number][] = []
    let offset: number | null = 0
    do {
      const page: FileJobReviewPage = await this.call('readReview', { ownerId: summary.mainSessionId, jobId: summary.jobId, section, offset, limit: 40 })
      if (page.summary.version !== summary.version) throw new Error('文件任务在读取期间有更新，将读取新的完整批次。')
      items.push(...page.items ?? []); offset = page.nextOffset
    } while (offset !== null)
    return items
  }
  private async project(summary: FileJobSummary): Promise<void> {
    const session = this.sessions.getSession(summary.translationSessionId)
    if (!session || session.topicId !== summary.topicId || this.sessions.isSessionDeleted(session.id) || this.unitDeleted(session.id, summary.unitId) || this.sourceDeleted(session.id, summary.unitId, summary.sourceVersion)) return
    this.missingHosts.delete(summary.jobId)
    const previous = this.records.get(summary.jobId)
    if (previous?.summary.removedAt && !summary.removedAt) return
    if (previous && this.projectedVersions.get(summary.jobId) === summary.version) return
    let record: FileJobRecord = previous ?? { schemaVersion: 1, summary, sources: [], results: [], proposals: [], proposalVersion: null, cards: [], workers: [], final: null }
    // Publish running progress immediately; terminal results commit after complete paging.
    if (running(summary)) { this.records.put({ ...record, summary }); this.registerUnit({ ...record, summary }) }
    const source = record.sources.find(value => value.version === summary.sourceVersion)
    if (!source) {
      const text = await this.text(summary, 'source', summary.sourceTotalCodePoints)
      if (summary.sourceRef) {
        const bytes = new TextEncoder().encode(text), hash = await crypto.subtle.digest('SHA-256', bytes)
        if (bytes.byteLength !== summary.sourceRef.bytes || Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') !== summary.sourceRef.sha256) throw new Error('原稿内容与固定来源校验不一致。')
      }
      record = { ...record, sources: rememberText(record.sources, summary.sourceVersion, text, summary.createdAt) }
    }
    const versions = await this.items(summary, 'results') as readonly { readonly version: number; readonly totalCodePoints: number; readonly semanticStatus?: 'pending' | 'passed' | 'changes_requested'; readonly baseVersion?: number }[]
    for (const version of versions) {
      if (!record.results.some(value => value.version === version.version)) record = { ...record,
        results: rememberText(record.results, version.version, await this.text(summary, 'result', version.totalCodePoints, version.version), summary.updatedAt) }
      record = { ...record, results: record.results.map(value => value.version === version.version ? { ...value, sourceVersion: summary.sourceVersion, ...(version.baseVersion === undefined ? {} : { baseVersion: version.baseVersion }),
        semanticStatus: version.semanticStatus ?? (summary.result?.version === value.version ? summary.result.semanticStatus : value.semanticStatus ?? 'pending') } : value) }
    }
    if (summary.proposalBatch?.status === 'reviewed' && record.proposalVersion !== summary.proposalBatch.version) record = { ...record,
      proposals: await this.items(summary, 'proposals') as readonly FileJobProposal[], proposalVersion: summary.proposalBatch.version }
    const workers = await this.items(summary, 'workers') as readonly FileJobWorker[]
    const constraints = await this.items(summary, 'constraints'), plan = await this.items(summary, 'plan'), checks = await this.items(summary, 'checks')
    const contexts = await this.items(summary, 'contexts'), reviews = await this.items(summary, 'reviews')
    if (summary.baselineVersion !== null && record.preparation?.version !== summary.baselineVersion) {
      const page = await this.call('readReview', { ownerId: summary.mainSessionId, jobId: summary.jobId, section: 'baseline', offset: 0, limit: 40 })
      record = { ...record, preparation: { version: summary.baselineVersion, context: page.context ?? '', items: await this.items(summary, 'baseline') } }
    }
    const current = this.records.get(summary.jobId)
    const final = current?.final ?? record.final
    record = { ...record, summary, workers, constraints, plan, checks, contexts, reviews, cards: (current?.cards ?? record.cards).map(card => card.draft && card.draftBatchVersion !== undefined && card.draftBatchVersion !== summary.proposalBatch?.version
      ? { ...card, message: '主模型已更新提案；当前编辑草稿基于旧批次，请核对新内容后再采纳。' } : card),
      final: final?.selection === 'user_fixed' ? final : summary.result?.semanticStatus === 'passed' ? { version: summary.result.version, selection: 'automatic', selectedAt: summary.review.decidedAt ?? summary.updatedAt } : final }
    for (const value of this.records.get(summary.jobId)?.results ?? []) if (value.deletion) record = eraseFileResult(record, value.version, value.deletion)
    for (const stored of this.all(session.id).filter(item => item.summary.unitId === summary.unitId)) for (const source of stored.sources) if (source.deletion) record = eraseFileSource(record, source.version, source.deletion)
    if (!this.unitDeleted(session.id, summary.unitId) && !this.sourceDeleted(session.id, summary.unitId, summary.sourceVersion)) { this.records.put(record); this.registerUnit(record); this.projectedVersions.set(summary.jobId, summary.version) }
  }
  async cancel(jobId: string): Promise<void> {
    await this.action(jobId, async record => { await this.project(await this.call('control', { ownerId: record.summary.mainSessionId, jobId, action: 'cancel' })) })
  }
  async retranslate(jobId: string, executionOwnerId?: string): Promise<void> {
    this.notice = '旧文件任务仅供读取与清理；需要重译时，请重新发送原稿，使用当前翻译流程。'
    this.emit()
  }
  async queryRetranslation(jobId: string): Promise<void> {
    const intent = this.retranslationIntents.get(jobId)
    if (!intent || this.pending.has(jobId)) return
    this.pending.add(jobId); this.emit()
    try {
      const receipt = await this.call('queryUnit', intent.request)
      if (!receipt) { intent.status = 'unknown'; intent.message = '原重译意图暂无确切回执，未重新发送。' }
      else if (receipt.accepted !== true || receipt.operationId !== intent.request.operationId || !same(receipt.target, intent.request.target)) throw new Error('重译意图查询回执身份不一致。')
      else { intent.status = 'submitted'; intent.message = '已确认重译意图发送，仍在等待主模型受理。' }
      await this.refresh()
    } catch { intent.status = 'unknown'; intent.message = '原重译意图仍待确认，未重新发送。' }
    finally { this.pending.delete(jobId); this.emit() }
  }
  async prepareRestart(jobId: string, operationId: string, organizedRequirements: string, executionOwnerId?: string): Promise<FileJobRestart> {
      if (!this.canExecute(executionOwnerId)) throw new Error('请选择本次任务使用的主会话。')
      const record = this.get(jobId)
      if (!record || this.records.blocked(jobId) || this.isUnitRemoved(record.summary.translationSessionId, record.summary.unitId)) throw new Error('文件历史已移除或变化。')
      if (running(record.summary)) throw new Error('此文件仍有未结算或结果未知的任务，不能重新派发。')
      if (this.sourceDeleted(record.summary.translationSessionId, record.summary.unitId, record.summary.sourceVersion)) throw new Error('此原稿版本已删除，不能重新派发。')
      const config = record.summary, session = this.sessions.getSession(config.translationSessionId)!, ownerId = executionOwnerId!
      if (!this.sessions.isSessionOpen(ownerId, session.id)) throw new Error('请先在当前主会话打开此翻译会话。')
      const commit = this.materials?.getFileHistoryCommit(session.id, config.unitId), namespaceId = this.assetNamespaceId?.()
      let librarySource: FileJobRestart['librarySource'] = config.sourceOrigin ? await this.materials?.readFileSourceOrigin(config.sourceOrigin) : undefined
      if (!librarySource && commit && namespaceId && (!config.sourceRef || commit.reference.source.sha256 === config.sourceRef.sha256)) librarySource = {
        stored: { scope: commit.reference.scope, referenceKey: commit.reference.referenceKey, source: commit.reference.source, historyToken: commit.historyToken },
        namespaceId, prepareToken: commit.reference.prepareToken,
      }
      if (!librarySource && namespaceId) {
        const document = this.sessions.getTranslationHistory(session.id)?.units.find(unit => unit.id === config.unitId)
        const source = document && isDocumentUnit(document) ? document.sourceVersions.find(source => source.version === config.sourceVersion) : undefined
        const stored = source?.body.kind === 'asset' && source.historyCommit ? await this.sessions.readStoredSourceRequest({ sessionId: session.id, unitId: config.unitId, sourceVersion: config.sourceVersion }) : null
        if (stored && source?.historyCommit) librarySource = { stored, namespaceId, prepareToken: source.historyCommit.reference.prepareToken }
      }
      // Saved proof reads through the local library; it never tries to restore into an old owner's live scope first.
      const sourceRef = librarySource ? { ...librarySource.stored.source, persistence: 'runtime_only' as const }
        : (!this.missingHosts.has(jobId) && ownerId === config.mainSessionId ? config.sourceRef : undefined)
          ?? (await this.materials?.resolveFileSource(session.id, config.unitId))?.sourceRef
      if (!sourceRef) throw new Error('已保存原稿未能恢复，且运行期引用不可用；请打开原稿后重新选择文件。')
      if (this.disposed || this.sessions.isSessionDeleted(session.id) || this.unitDeleted(session.id, config.unitId) || this.sourceDeleted(session.id, config.unitId, config.sourceVersion)) throw new Error('此文件或原稿已删除，未恢复旧稿任务。')
      const locale = this.uiLocale?.()?.trim().slice(0, 64)
      return { operationId, previousResultVersion: this.unitRecord(jobId)?.results.at(-1)?.version ?? 0,
        organizedRequirements: organizedRequirements.trim() ? organizedRequirements : config.organizedRequirements ?? '',
        envelope: {  mainSessionId: ownerId, requestId: `file-restart:${operationId}`, operationId,
          ...(locale ? { uiLocale: locale } : {}),
          kind: 'material', material: { materialId: config.materialId, sourceVersion: config.sourceVersion, topicId: config.topicId, translationSessionId: config.translationSessionId,
            draftVersion: 1, targetLanguage: config.targetLanguage, instruction: config.instruction, model: session.model, maxInputChars: session.maxInputChars, sourceRef } },
        ...(librarySource ? { librarySource } : {}) }
  }
  async reviseSaved(request: FileJobRevision, actingOwner = request.ownerId): Promise<FileJobSummary> {
    const signature = JSON.stringify({ ...request, actingOwner })
    const updated = await this.records.mutate(request.jobId, record => {
      if (record.summary.mainSessionId !== request.ownerId) throw new Error('文件修订不属于当前主会话。')
      const old = record.revisionOperations?.find(item => item.operationId === request.operationId)
      if (old) { if (old.signature === '') throw new Error('此操作的译文版本已删除，不能重放原修订。'); if (old.signature !== signature) throw new Error('同一修订操作不能更换内容。'); return record }
      if (record.summary.phase !== 'completed' || !record.summary.result || record.summary.removedAt) throw new Error('仅可修订已完成且未移除的文件。')
      if (record.summary.version !== request.expectedVersion) throw new Error('文件版本已变化，请重新读取当前译文。')
      const source = record.results.find(result => result.version === record.summary.result!.version)
      if (!source || source.deletion) throw new Error('此准确结果尚未完整保存或已删除，未修改译文。')
      const text = applyFileJobEdits(source.text, request.edits), at = new Date().toISOString(), version = text === source.text ? source.version
        : 1 + Math.max(0, ...this.all(record.summary.translationSessionId).filter(item => item.summary.unitId === record.summary.unitId).flatMap(item => item.results.map(result => result.version)))
      const summary: FileJobSummary = text === source.text ? record.summary : { ...record.summary, version: record.summary.version + 1, updatedAt: at,
        result: { version, totalCodePoints: Array.from(text).length, semanticStatus: 'passed' },
        review: { version: record.summary.review.version + 1, status: 'passed', reviewedBy: actingOwner, decidedAt: at } }
      return { ...record, summary, results: text === source.text ? record.results : [...record.results, { version, sourceVersion: record.summary.sourceVersion, baseVersion: source.version, text, createdAt: at, semanticStatus: 'passed' }],
        final: record.final?.selection === 'user_fixed' ? record.final : { version, selection: 'automatic', selectedAt: at },
        revisionOperations: [...record.revisionOperations ?? [], { operationId: request.operationId, signature, summary }] }
    })
    return updated.revisionOperations!.find(item => item.operationId === request.operationId)!.summary
  }
  readSaved(request: FileJobReadReview): FileJobReviewPage {
    const record = this.get(request.jobId)
    if (!record || record.summary.mainSessionId !== request.ownerId || this.records.blocked(request.jobId) || this.isUnitRemoved(record.summary.translationSessionId, record.summary.unitId)) throw new Error('已保存文件不存在、已移除或不属于当前主会话。')
    const { summary } = record
    if (request.section === 'source' || request.section === 'result') {
      const value = request.section === 'source' ? record.sources.find(item => item.version === summary.sourceVersion) : record.results.find(item => item.version === (request.resultVersion ?? summary.result?.version))
      if (!value || value.deletion) throw new Error('准确正文版本尚未完整保存或已删除。')
      const text = Array.from(value.text), range = request.range ?? { start: 0, end: Math.min(4000, text.length) }
      if (range.start < 0 || range.end > text.length || range.end <= range.start || range.end - range.start > 4000) throw new Error('正文范围必须为准确版本内的最多4000码点。')
      return { summary, section: request.section, text: text.slice(range.start, range.end).join(''), range, nextOffset: range.end < text.length ? range.end : null }
    }
    const values: Record<string, readonly unknown[]> = { results: record.results.filter(result => !result.deletion).map(result => ({ version: result.version, totalCodePoints: Array.from(result.text).length, semanticStatus: result.semanticStatus ?? 'pending', ...(result.baseVersion === undefined ? {} : { baseVersion: result.baseVersion }) })),
      proposals: record.proposals, baseline: record.preparation?.items ?? [], conflicts: [], workers: record.workers, constraints: record.constraints ?? [], plan: record.plan ?? [], checks: record.checks ?? [], contexts: record.contexts ?? [], reviews: record.reviews ?? [] }
    const all = values[request.section] ?? [], offset = request.offset ?? 0, items = all.slice(offset, offset + Math.min(200, request.limit ?? 40)) as NonNullable<FileJobReviewPage['items']>
    return { summary, section: request.section, items, total: all.length, ...(request.section === 'baseline' ? { context: record.preparation?.context ?? '' } : {}), nextOffset: offset + items.length < all.length ? offset + items.length : null }
  }
  async remove(jobId: string): Promise<void> {
    await this.action(jobId, async record => {
      const related = this.all(record.summary.translationSessionId).filter(value => value.summary.unitId === record.summary.unitId)
      if (related.some(value => running(value.summary) || value.results.length || value.summary.result)) throw new Error('请先确认文件任务已结束；已有译文结果的单元不能移除。')
      const summary = await this.call('control', { ownerId: record.summary.mainSessionId, jobId, action: 'remove' })
      if (!summary.removedAt) throw new Error('文件移除尚未确认，记录仍保留。')
      await this.project(summary)
      for (const value of related) {
        const current = this.records.get(value.summary.jobId)
        if (current && current.summary.jobId !== summary.jobId) this.records.put({ ...current, summary: { ...current.summary, removedAt: summary.removedAt } })
      }
      await this.records.persist(summary.jobId)
    })
  }
  private async action(jobId: string, action: (record: FileJobRecord) => Promise<void>): Promise<void> {
    const record = this.get(jobId)
    if (!record || this.pending.has(jobId) || this.records.blocked(jobId)) return
    this.pending.add(jobId); this.notice = undefined; this.emit()
    try { await action(record) } catch (cause) { this.notice = cause instanceof Error ? cause.message : '操作未完成，已有内容保留。' }
    finally { this.pending.delete(jobId); this.reconcileLeases(); this.emit() }
  }
  edit(jobId: string, proposal: FileJobProposal): void {
    const record = this.get(jobId), old = record?.cards.find(card => card.candidateId === proposal.candidateId)
    if (!record || old?.status === 'adopted' || !record.proposals.some(value => value.candidateId === proposal.candidateId && value.kind === proposal.kind)) return
    this.card(record, { candidateId: proposal.candidateId, status: 'pending', draft: structuredClone(proposal), draftBatchVersion: record.proposalVersion ?? undefined })
  }
  discardDraft(jobId: string, candidateId: string): void {
    const record = this.get(jobId), state = record?.cards.find(card => card.candidateId === candidateId)
    if (!record || state?.status === 'adopted') return
    this.card(record, { candidateId, status: state?.status ?? 'pending' })
  }
  private card(record: FileJobRecord, state: FileJobCardState): void {
    const current = this.get(record.summary.jobId)
    if (!current) return
    this.records.put({ ...current, cards: [...current.cards.filter(card => card.candidateId !== state.candidateId), state] })
  }
  reject(jobId: string, candidateIds: readonly string[]): void {
    const record = this.get(jobId)
    if (!record || this.pending.has(jobId)) return
    for (const candidateId of candidateIds) {
      const old = record.cards.find(card => card.candidateId === candidateId)
      if (old?.status !== 'adopted') this.card(record, { ...old, candidateId, status: 'rejected' })
    }
  }
  async adopt(jobId: string, candidateIds: readonly string[], reviewed?: FileProposalReviews): Promise<void> {
    await this.action(jobId, async initial => {
      if (!this.assets || initial.summary.proposalBatch?.status !== 'reviewed') throw new Error('资产尚未完成集中验收。')
      await this.assets.terms.refresh(initial.summary.mainSessionId, initial.summary.topicId)
      await this.assets.archive.refresh(initial.summary.mainSessionId, initial.summary.topicId)
      const selected = new Set(candidateIds), ordered: FileJobProposal[] = [], visiting = new Set<string>(), visited = new Set<string>()
      const visit = (id: string): void => {
        if (visited.has(id)) return
        if (visiting.has(id)) throw new Error('资产实体依赖存在循环，请提交意见。')
        const source = initial.proposals.find(value => value.candidateId === id), state = initial.cards.find(value => value.candidateId === id)
        if (!source || source.disposition === 'rejected' || state?.status === 'rejected' && !selected.has(id)) throw new Error('依赖实体未采用，请先检查所选卡片。')
        if (state?.draft && state.draftBatchVersion !== initial.proposalVersion) throw new Error('编辑草稿基于旧提案批次，请核对主模型的新内容后再编辑或采纳。')
        const proposal = state?.draft ?? source
        visiting.add(id)
        for (const dependency of proposalDependencies(proposal)) {
          const entity = initial.proposals.find(value => value.candidateId === dependency)
          if (entity?.kind !== 'entity') throw new Error('关系或事实缺少对应实体，尚未写入。')
          visit(dependency)
        }
        visiting.delete(id); visited.add(id); ordered.push(proposal)
      }
      for (const id of selected) visit(id)
      const approvals = { ...(reviewed ?? this.proposalReviews(initial)) }
      let adopted = 0, failed = 0
      for (const proposal of ordered) {
        await this.assets.terms.refresh(initial.summary.mainSessionId, initial.summary.topicId)
        await this.assets.archive.refresh(initial.summary.mainSessionId, initial.summary.topicId)
        const record = this.get(jobId)!, previous = record.cards.find(card => card.candidateId === proposal.candidateId)
        if (previous?.status === 'adopted') continue
        const review = approvals[proposal.candidateId], currentReview = this.proposalReviews(record)[proposal.candidateId]
        if (!review || review.kind === 'blocked' || !currentReview || currentReview.kind === 'blocked' || review.kind !== currentReview.kind ||
          review.kind === 'update' && (currentReview.kind !== 'update' || review.entry.id !== currentReview.entry.id || review.entry.version !== currentReview.entry.version)) {
          this.card(record, { ...previous, candidateId: proposal.candidateId, status: 'pending', message: review?.kind === 'blocked' ? review.message
            : currentReview?.kind === 'blocked' ? currentReview.message : '既有资产已变化，请核对当前条目和版本后再采纳。' }); failed++; continue
        }
        const assetId = review.kind === 'update' ? review.entry.id : await assetIdentity(`${record.summary.translationSessionId}:${record.summary.unitId}:${jobId}:${record.summary.proposalBatch!.id}`, proposal.candidateId)
        const sourceEvidence: readonly TermEvidenceRef[] = proposal.evidence.map(item => ({ kind: 'source', sessionId: record.summary.translationSessionId,
          unitId: record.summary.unitId, sourceVersion: record.summary.sourceVersion, revisionId: null, selectionEventId: null, role: 'basis', range: { ...item.range } }))
        const evidence = fileRevisionEvidence(sourceEvidence, review.kind === 'update' ? review.entry.evidence : [], proposal.origin)
        const acceptance: FileProposalAcceptance = { eventId: previous?.eventId ?? `file-card:${crypto.randomUUID()}`, at: new Date().toISOString(),
          batchId: record.summary.proposalBatch!.id, candidateId: proposal.candidateId, edited: !!previous?.draft }
        let status: string, active = false
        if (proposal.kind === 'term') {
          const snapshot = this.assets.terms.getSnapshot(record.summary.mainSessionId, record.summary.topicId)
          const existing = snapshot.entries.find(entry => entry.id === assetId)
          const input: TopicTermPut = { id: assetId, expectedEntryVersion: review.kind === 'update' ? review.entry.version : null, sourceLanguage: existing?.sourceLanguage ?? null,
            targetLanguage: record.summary.targetLanguage, sourceForms: [...new Set([...(existing?.sourceForms ?? []), ...proposal.sourceForms])], aliases: existing?.aliases ?? [], sense: proposal.description, preferred: proposal.preferred,
            forbidden: existing?.forbidden ?? [], evidence, origin: proposal.origin, status: 'proposal' }
          const result = await this.assets.terms.apply(record.summary.mainSessionId, record.summary.topicId, snapshot.version, { kind: review.kind === 'update' ? 'revise_file_proposal' : 'accept_file_proposal', input, acceptance })
          status = result.status; active = result.entry?.status === 'active' && !['error', 'conflict'].includes(this.assets.terms.getStatus(record.summary.mainSessionId, record.summary.topicId))
        } else {
          const snapshot = this.assets.archive.getSnapshot(record.summary.mainSessionId, record.summary.topicId)
          const resolve = (id: string): string => {
            const state = this.get(jobId)!.cards.find(card => card.candidateId === id)
            if (state?.status !== 'adopted' || !state.assetId || !snapshot.entries.some(entry => entry.id === state.assetId && entry.kind === 'entity' && entry.status === 'active')) throw new Error('依赖实体未能生效，相关卡片仍待审。')
            return state.assetId
          }
          try {
            const semantic = proposal.kind === 'entity' ? { kind: 'entity' as const, name: proposal.name, aliases: proposal.aliases, description: proposal.description }
              : proposal.kind === 'fact' ? { kind: 'fact' as const, title: proposal.title, body: proposal.body, entityIds: proposal.entityCandidateIds.map(resolve) }
                : { kind: 'relation' as const, sourceEntityId: resolve(proposal.sourceEntityCandidateId), relation: proposal.relation, targetEntityId: resolve(proposal.targetEntityCandidateId), description: proposal.description }
            const existing = snapshot.entries.find(entry => entry.id === assetId)
            if (semantic.kind === 'entity' && existing?.kind === 'entity') semantic.aliases = [...new Set([...existing.aliases, ...(existing.name === semantic.name ? [] : [existing.name]), ...semantic.aliases])].filter(name => name !== semantic.name)
            const input: TopicArchivePut = { ...semantic, id: assetId, expectedEntryVersion: review.kind === 'update' ? review.entry.version : null, evidence, origin: proposal.origin, status: 'proposal' }
            const result = await this.assets.archive.apply(record.summary.mainSessionId, record.summary.topicId, snapshot.version, { kind: review.kind === 'update' ? 'revise_file_proposal' : 'accept_file_proposal', input, acceptance })
            // Updating an entity may mark dependent entries for review. Keep this action's
            // approvals only for that status-only cascade, never for concurrent content edits.
            if (result.status === 'updated') for (const [id, approval] of Object.entries(approvals)) if (approval.kind === 'update') {
              const before = snapshot.entries.find(entry => entry.id === approval.entry.id), after = result.snapshot.entries.find(entry => entry.id === approval.entry.id)
              if (before && after && before.id !== assetId && before.version === approval.entry.version && after.version === before.version + 1 && after.status === 'review_required' &&
                same({ ...before, status: null, version: null, updatedAt: null }, { ...after, status: null, version: null, updatedAt: null })) approvals[id] = { kind: 'update', entry: after }
            }
            status = result.status; active = result.entry?.status === 'active' && !['error', 'conflict'].includes(this.assets.archive.getStatus(record.summary.mainSessionId, record.summary.topicId))
          } catch (cause) { status = cause instanceof Error ? cause.message : '依赖实体不可用' }
        }
        if ((status === 'updated' || status === 'unchanged') && active) {
          this.card(record, { ...previous, candidateId: proposal.candidateId, status: 'adopted', assetId, adoptedAt: acceptance.at, eventId: acceptance.eventId, adoptedProposal: proposal,
            message: review.kind === 'update' ? `已更新原条目（版本 ${review.entry.version} → ${review.entry.version + 1}）。` : '已新增条目。' }); adopted++
        } else {
          this.card(record, { ...previous, candidateId: proposal.candidateId, status: 'pending', eventId: acceptance.eventId,
            message: status === 'conflict' || status === 'requires_user_action' ? '与已生效或已采纳资产冲突，请编辑或提出意见。' : `采纳未完成（${status}），卡片仍保留。` }); failed++
        }
      }
      await this.records.persist(jobId)
      this.notice = `已采纳 ${adopted} 条${failed ? `，${failed} 条仍待处理` : ''}。`
    })
  }
  async feedback(jobId: string, candidateIds: readonly string[], comment: string): Promise<void> {
    await this.action(jobId, async record => {
      if (!candidateIds.length || !comment.trim() || !record.summary.proposalBatch) throw new Error('请选择卡片并填写意见。')
      const summary = await this.call('feedback', { ownerId: record.summary.mainSessionId, jobId, candidateIds: [...candidateIds], comment: comment.trim(),
        expectedBatchVersion: record.summary.proposalBatch.version, operationId: `file-feedback:${crypto.randomUUID()}`,
        proposalEdits: record.cards.filter(card => candidateIds.includes(card.candidateId) && card.draft).map(card => card.draft!) })
      await this.project(summary); this.notice = '意见已合并提交，将只复核所选资产及依赖。'
    })
  }
  selectFinal(jobId: string, version: number): void {
    const record = this.unitRecord(jobId)
    const result = record?.results.find(result => result.version === version && !result.deletion && result.semanticStatus === 'passed' && result.sourceVersion === record.summary.sourceVersion)
    if (!record || !result) return
    const origin = this.all(record.summary.translationSessionId).find(item => item.summary.unitId === record.summary.unitId && item.summary.sourceVersion === result.sourceVersion && item.results.some(value => value.version === version && value.text === result.text))
    if (origin) this.records.put({ ...origin, final: { version, selection: 'user_fixed', selectedAt: new Date().toISOString() } })
  }
  async open(jobId: string, side: 'source' | 'result', version: number, views: ViewFilesClient): Promise<void> {
    await this.action(jobId, async raw => {
      const record = this.unitRecord(raw.summary.jobId) ?? raw
      const value = (side === 'source' ? record.sources : record.results).find(value => value.version === version)
      if (!value || value.deletion) throw new Error('所选固定版本尚未取得或已删除。')
      const outcome = await views.open({ namespaceId: this.sessions.getNamespaceId(), sessionId: record.summary.translationSessionId, unitId: record.summary.unitId,
        kind: side, title: `${side === 'source' ? '原稿' : '译文'} · 版本 ${version}`, revisionId: `${side}:${record.summary.unitId}:${version}`, fileName: `${side === 'source' ? '原稿' : '译文'}-v${version}.txt`, format: 'txt', text: value.text })
      if (!outcome.ok) throw new Error(outcome.message)
    })
  }
  readEvidence(sessionId: string, unitId: string): TermEvidenceFact | undefined {
    const record = this.forUnit(sessionId, unitId), session = this.sessions.getSession(sessionId)
    if (!record || !session || this.records.blocked(record.summary.jobId) || this.sessions.getStatus(sessionId) === 'conflict') return undefined
    const source = record.sources.find(value => value.version === record.summary.sourceVersion)
    return source ? { ownerId: this.sessions.getTopicStorageScope(session.topicId)!, topicId: session.topicId, sourceVersion: source.version, source: source.text, final: null } : undefined
  }
  capture(ownerId: string, topicId: string, ref: TermEvidenceRef): EvidenceReadRequest | EvidenceUnavailableResult {
    const record = this.forUnit(ref.sessionId, ref.unitId)
    if (!record) return this.fallback.capture(ownerId, topicId, ref)
    const request: EvidenceReadRequest = { ownerId: record.summary.mainSessionId, topicId, sessionId: ref.sessionId, unitId: ref.unitId,
      sourceVersion: ref.kind === 'source' ? ref.sourceVersion ?? 1 : record.summary.sourceVersion, side: ref.kind,
      range: ref.range, revisionId: ref.revisionId, selectionEventId: ref.selectionEventId }
    if (record.summary.topicId !== topicId || ref.kind !== 'source' || !this.isCurrent(request)) return unavailable(request, 'file_job_source_unavailable')
    return request
  }
  isCurrent(request: EvidenceReadRequest): boolean {
    const record = this.forUnit(request.sessionId, request.unitId)
    if (!record) return this.fallback.isCurrent(request)
    return !this.disposed && request.side === 'source' && record.summary.mainSessionId === request.ownerId && record.summary.topicId === request.topicId &&
      !this.records.blocked(record.summary.jobId) && this.sessions.getStatus(request.sessionId) !== 'conflict' && record.sources.some(source => source.version === request.sourceVersion && !source.deletion)
  }
  async read(request: EvidenceReadRequest): Promise<EvidenceReadResult> {
    const record = this.forUnit(request.sessionId, request.unitId)
    if (!record) return this.fallback.read(request)
    if (!this.isCurrent(request)) return unavailable(request, 'file_job_source_unavailable')
    const source = record.sources.find(source => source.version === request.sourceVersion)!, points = Array.from(source.text)
    const range = request.range ?? { start: 0, end: points.length }
    if (range.start < 0 || range.end > points.length || range.end <= range.start) return unavailable(request, 'range_out_of_bounds')
    if (range.end - range.start > MAX_FILE_JOB_TEXT_POINTS) return { status: 'unloaded', request, reason: 'range_required', totalCodePoints: points.length }
    return { status: 'ready', request, range, totalCodePoints: points.length, sourceVersion: source.version, manifestRevisionId: null, text: points.slice(range.start, range.end).join('') }
  }
  dispose(): void {
    this.disposed = true; clearInterval(this.timer); this.stopStore()
    for (const stop of this.stopAssets) stop()
    for (const release of this.leases.values()) release()
    for (const release of this.retentions.values()) release()
    this.leases.clear(); this.retentions.clear(); this.listeners.clear(); this.records.dispose()
    this.retranslationIntents.clear()
  }
}
