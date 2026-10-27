import { diagnosticSpan } from './diagnostics.js'
import { parseHistoryBundle, encodeHistoryBundle, persistableHistoryBundle, historyUnsettled, type HistoryBundle, type HistoryScope } from '../shared/history-bundle.js'
import { parseHistoryRequest, HISTORY_BUNDLE_BYTES, type HistoryBegin, type HistoryRead, type HistoryPartUpload, type HistoryTransfer, type HistoryMutation, type HistoryStatus, type CurrentHistoryRead, type HistoryCurrentPage } from '../shared/history-remote.js'
import { deleteTextRevision, deleteUnit, isTextUnit, isDocumentUnit, isFileJobUnit, isDeletedUnit, appendTranslationEvent, type TranslationHistory } from '../memory/translation-history.js'
import { fileResultDeletionBlockedReason, deleteFileResult, fileSourceDeletionBlockedReason, deleteFileSource } from '../memory/file-job-deletion.js'
import { fileResultSourceVersion } from '../memory/file-job-current.js'
import { documentRevisionDeletionBlockedReason, deleteDocumentRevision, documentSourceDeletionBlockedReason, deleteDocumentSource, documentOrphanChunks, documentChunkCleanupBlockedReason, deleteDocumentChunks } from '../memory/document-deletion.js'
import type { OtherMemoryService } from './other-memory.js'
import type { LocalDataService } from './local-data.js'
import type { TopicHostContext, TopicToolsService } from './topic-tools.js'
import type { TranslationSourcesService } from './translation-sources.js'
import { historyResources, historyTargetMatches } from './history-resources.js'
import { mergeHistoryCleanup, sourceReferenceKey, type HistoryCleanup, type HistoryCleanupResult } from '../shared/history-cleanup.js'
import { readCurrentHistory } from './history-current.js'
import { currentHistoryPair, currentHistoryStamp, historyRecordExcerpt, historyIndexSourceIds } from './history-retrieval.js'
import { parseTranslationRecordSelection, type TranslationRecordSelection, type TranslationRecordExcerpt } from '../shared/reference-memory.js'
import { referenceBytes } from '../shared/reference-memory.js'
import type { HistoryList, HistoryListing } from '../shared/history-remote.js'
import type { HistoryTextSearch, HistoryTextMatches } from '../shared/history-remote.js'
import { applyHistoryPatch, historySessionMetadata } from '../shared/history-patch.js'

interface Seat { readonly scope: HistoryScope; current: HistoryBundle | null; saved: HistoryBundle | null; token: string }
interface Guard { readonly scope: HistoryScope; readonly peer: string; readonly generation: number }
interface Transfer { readonly guard: Guard; readonly request: HistoryBegin; readonly layers: { current: string[]; saved: string[] }; readonly points: { current: number; saved: number }; readonly bytes: { current: number; saved: number }; committed?: HistoryStatus }
const key = (scope: Pick<HistoryScope, 'namespaceId' | 'sessionId'>): string => JSON.stringify([scope.namespaceId, scope.sessionId])
const token = (): string => `history:${crypto.randomUUID()}`
function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
function fileCallFacts(bundle: HistoryBundle, unitId: string): { calls: number; inputTokens: number | null; outputTokens: number | null } {
  const workers = new Map(bundle.fileJobs.filter(record => record.summary.unitId === unitId).flatMap(record => record.workers.map(worker => [worker.callId ?? worker.id, worker] as const)))
  let calls = 0, inputTokens: number | null = null, outputTokens: number | null = null
  for (const worker of workers.values()) {
    calls += worker.native?.observedAttempts ?? (worker.callId ? 1 : 0)
    if (worker.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + worker.inputTokens
    if (worker.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + worker.outputTokens
  }
  return { calls, inputTokens, outputTokens }
}
/** Complete session migration and Host authority. Existing Client stores opt in only as one bundle. */
export class HistoryService {
  readonly typertRemote: { readonly service: HistoryService; readonly serviceKey: 'translationHistory'; readonly namespace: 'translationHistory' } = { service: this, serviceKey: 'translationHistory', namespace: 'translationHistory' }
  private readonly seats = new Map<string, Seat>()
  private readonly encoded = new WeakMap<HistoryBundle, { readonly text: string; point: number; offset: number }>()
  private readonly transfers = new Map<string, Transfer>()
  private readonly deletingUnits = new Map<string, { scope: HistoryScope; unitId: string }>()
  private tail: Promise<unknown> = Promise.resolve()
  private pending = 0
  private disposed = false
  private generation = 0
  constructor(private readonly ctx: TopicHostContext, private readonly memory: OtherMemoryService) { Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationHistory', property: 'ctx' } }) }
  private get topics(): TopicToolsService | undefined { return this.ctx.get?.('translationTopics') as TopicToolsService | undefined }
  private authorize(scope: HistoryScope): Guard {
    const peer = this.ctx.invocation?.peer.id
    if (!peer) throw failure('history_scope', '会话历史缺少宿主连接。')
    const guard = { scope: { namespaceId: scope.namespaceId, topicId: scope.topicId, sessionId: scope.sessionId }, peer, generation: this.generation }; this.check(guard); return guard
  }
  private check(guard: Guard): void {
    if (this.disposed || guard.generation !== this.generation || !this.topics?.ownsLibrary(guard.scope.namespaceId, guard.peer)) throw failure('history_scope', '会话历史连接已关闭或不属于此资料库。')
  }
  private serial<T>(guard: Guard, run: () => Promise<T>): Promise<T> {
    this.pending++; const next = this.tail.then(() => { this.check(guard); return run() }); this.tail = next.catch(() => {})
    return next.finally(() => { this.pending-- })
  }
  private async writer<T>(run: () => Promise<T>): Promise<T> {
    const report = diagnosticSpan(this.ctx, 'history.write')
    try {
      const value = await ((this.ctx.get?.('translationLocalData') as LocalDataService | undefined)?.storageWriter() ?? (async <R>(fn: () => Promise<R>): Promise<R> => fn()))(run)
      ;(this.ctx.get?.('translationMemorySearch') as { contentChanged(): void } | undefined)?.contentChanged()
      const result = value as { status?: string; state?: { persistence?: string; retired?: boolean } } | undefined
      report(result?.status === 'blocked' || result?.status === 'stale' ? 'degraded' : 'completed', { outcome: result?.status, persistence: result?.state?.persistence, retired: result?.state?.retired })
      return value
    } catch (error) { report('failed', {}, error); throw error }
  }
  private describe(seat: Seat | undefined): HistoryStatus {
    return seat ? { switched: true, token: seat.token, retired: seat.current === null, hasSaved: seat.saved !== null, persistence: same(seat.current, seat.saved) ? 'saved' : 'runtime_only' }
      : { switched: false, token: null, retired: false, hasSaved: false, persistence: 'runtime_only' }
  }
  private async seat(guard: Guard): Promise<Seat | undefined> {
    const db = await this.memory.databaseForArchives(); this.check(guard)
    if (db?.retired(guard.scope.namespaceId, guard.scope.topicId)) {
      const retired: Seat = { scope: guard.scope, current: null, saved: null, token: this.seats.get(key(guard.scope))?.token ?? token() }; this.seats.set(key(guard.scope), retired); return retired
    }
    const cached = this.seats.get(key(guard.scope))
    if (cached) { if (cached.scope.topicId !== guard.scope.topicId) throw failure('history_scope', '会话历史所属主题不一致。'); return cached }
    const stored = db?.historyState(guard.scope.namespaceId, guard.scope.sessionId)
    if (!stored) return undefined
    if (stored.topicId !== guard.scope.topicId) throw failure('history_scope', '已保存会话属于其他主题。')
    const seat: Seat = { scope: guard.scope, current: stored.bundle, saved: stored.bundle, token: stored.token }; this.seats.set(key(guard.scope), seat); return seat
  }
  private async current(guard: Guard, expected: string): Promise<Seat> {
    const seat = await this.seat(guard); this.check(guard)
    if (!seat || seat.current === null) throw failure('history_unavailable', '此会话尚未迁移或已退役。')
    if (seat.token !== expected) throw failure('history_stale', '会话历史已变化，请读取最新状态。')
    return seat
  }
  async list(raw: HistoryList): Promise<HistoryListing> {
    const request = parseHistoryRequest('list', raw) as HistoryList, guard = this.authorize({ namespaceId: request.namespaceId, topicId: request.topicId ?? '*', sessionId: '*' })
    await this.tail; const db = await this.memory.databaseForArchives(); this.check(guard)
    const known = new Map<string, HistoryListing['sessions'][number]>((db?.historyScopes(request.namespaceId) ?? []).map(row => {
      const retired = row.retired || !!db?.retired(request.namespaceId, row.topicId)
      return [row.sessionId, { sessionId: row.sessionId, topicId: row.topicId, state: { switched: true, token: row.token, retired, persistence: 'saved' as const, hasSaved: !retired }, ...(!retired && row.session ? { session: row.session } : {}) }]
    }))
    for (const seat of this.seats.values()) if (seat.scope.namespaceId === request.namespaceId) {
      const retired = !!db?.retired(request.namespaceId, seat.scope.topicId)
      known.set(seat.scope.sessionId, { sessionId: seat.scope.sessionId, topicId: seat.scope.topicId, state: retired ? { ...this.describe(seat), retired: true, hasSaved: false } : this.describe(seat), ...(!retired && seat.current ? { session: historySessionMetadata(seat.current.session) } : {}) })
    }
    const candidates = [...known.values()].filter(row => (request.topicId === undefined || row.topicId === request.topicId) && (request.after === undefined || row.sessionId > request.after)).sort((a, b) => a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
    const sessions: HistoryListing['sessions'][number][] = []
    for (const row of candidates.slice(0, 20)) { if (referenceBytes({ sessions: [...sessions, row], next: row.sessionId }) > 32768) break; sessions.push(row) }
    if (candidates.length && !sessions.length) throw failure('history_page', '单条历史元数据超过读取预算。')
    return { sessions, next: sessions.length < candidates.length ? sessions.at(-1)!.sessionId : null }
  }
  /** Filter scope and opened-session ids before loading any history body. Index builds omit the id filter. */
  async retrievalSnapshots(namespaceId: string, peer: string, topicId?: string, sessionIds?: readonly string[]): Promise<readonly { readonly scope: HistoryScope; readonly token: string; readonly current: HistoryBundle; readonly saved: HistoryBundle | null }[]> {
    const guard: Guard = { scope: { namespaceId, topicId: topicId ?? '*', sessionId: '*' }, peer, generation: this.generation }
    this.check(guard); await this.tail
    const db = await this.memory.databaseForArchives(), scopes = new Map((db?.historyScopes(namespaceId) ?? []).map(row => [row.sessionId, { namespaceId, topicId: row.topicId, sessionId: row.sessionId }]))
    for (const seat of this.seats.values()) if (seat.scope.namespaceId === namespaceId) scopes.set(seat.scope.sessionId, seat.scope)
    const allowed = sessionIds && new Set(sessionIds), result = []
    for (const scope of scopes.values()) if ((topicId === undefined || scope.topicId === topicId) && (!allowed || allowed.has(scope.sessionId))) {
      const seat = await this.seat({ ...guard, scope }); if (seat?.current) result.push({ scope, token: seat.token, current: seat.current, saved: seat.saved })
    }
    this.check(guard); return result
  }
  async recordExcerpt(scope: HistoryScope, raw: TranslationRecordSelection, peer: string, signal: AbortSignal, page?: { readonly side: 'source' | 'translation'; readonly start: number }): Promise<{ readonly excerpt: TranslationRecordExcerpt; readonly next: number | null; readonly isCurrent: () => boolean }> {
    const selection = parseTranslationRecordSelection(raw), guard: Guard = { scope, peer, generation: this.generation }
    if (selection.sessionId !== scope.sessionId) throw failure('history_scope', '译例不属于所选会话。')
    this.check(guard); await this.tail
    const seat = await this.seat(guard)
    if (!seat?.current) throw failure('history_unavailable', '译例已删除或不可用。')
    const pair = await currentHistoryPair(seat.current, scope, seat.token, selection.unitId, peer, this.ctx.get?.('translationSources') as TranslationSourcesService | undefined, signal)
    if (!pair || pair.sourceVersion !== selection.sourceVersion || pair.finalId !== selection.finalId) throw failure('history_stale', '译例的当前原稿或最终选择已变化，请重新检索。')
    const exact = await historyRecordExcerpt(pair, selection.sourceRange, selection.translationRange)
    if (exact.selection.sha256 !== selection.sha256) throw failure('history_stale', '译例片段正文已变化，请重新检索。')
    let excerpt = exact, next: number | null = null
    if (page) {
      const length = Array.from(pair[page.side]).length
      if (page.start >= length) throw failure('history_range', '译例读取位置已超出正文。')
      const end = Math.min(length, page.start + 4000), range = { start: page.start, end }
      excerpt = await historyRecordExcerpt(pair, page.side === 'source' ? range : null, page.side === 'translation' ? range : null); next = end < length ? end : null
    }
    this.check(guard); signal.throwIfAborted()
    if (this.seats.get(key(scope)) !== seat) throw failure('history_stale', '译例在读取期间变化，请重新检索。')
    const captured = currentHistoryStamp(seat.current, selection.unitId)
    return { excerpt, next, isCurrent: () => { try { this.check(guard); const current = currentHistoryStamp(this.seats.get(key(scope))?.current ?? null, selection.unitId); return !!captured && !!current && current.length === captured.length && current.every((value, i) => value === captured[i]) } catch { return false } } }
  }
  async status(raw: HistoryScope): Promise<HistoryStatus> {
    const request = parseHistoryRequest('status', raw) as HistoryScope, guard = this.authorize(request)
    await this.tail; return this.describe(await this.seat(guard))
  }
  async read(raw: HistoryRead): Promise<{ readonly text: string; readonly next: number | null }> {
    const request = parseHistoryRequest('read', raw) as HistoryRead, guard = this.authorize(request)
    await this.tail; const seat = await this.current(guard, request.token), bundle = request.layer === 'current' ? seat.current : seat.saved
    if (!bundle) throw failure('history_unavailable', '此会话没有已保存的历史层。')
    let cursor = this.encoded.get(bundle)
    if (!cursor) { cursor = { text: encodeHistoryBundle(bundle), point: 0, offset: 0 }; this.encoded.set(bundle, cursor) }
    if (request.offset < cursor.point) { cursor.point = 0; cursor.offset = 0 }
    const advance = (): void => { cursor!.offset += cursor!.text.codePointAt(cursor!.offset)! > 0xffff ? 2 : 1; cursor!.point++ }
    while (cursor.point < request.offset && cursor.offset < cursor.text.length) advance()
    if (cursor.point !== request.offset || cursor.offset >= cursor.text.length) throw failure('history_range', '历史读取范围已变化。')
    const from = cursor.offset, end = request.offset + 4000
    while (cursor.point < end && cursor.offset < cursor.text.length) advance()
    return { text: cursor.text.slice(from, cursor.offset), next: cursor.offset < cursor.text.length ? cursor.point : null }
  }
  begin(raw: HistoryBegin): Promise<{ readonly transferId: string }> {
    const request = parseHistoryRequest('begin', raw) as HistoryBegin, guard = this.authorize(request)
    return this.serial(guard, async () => {
      const seat = await this.seat(guard)
      if (seat?.current === null) throw failure('history_retired', '此会话已退役，不能重新导入。')
      if (!['replace', 'patch'].includes(request.purpose) ? !!seat || request.expectedToken !== null : !seat || seat.token !== request.expectedToken) throw failure('history_stale', '会话已切换或版本已变化，不能覆盖。')
      // One bounded staging batch per peer. The Client serializes session transfers.
      for (const [id, transfer] of this.transfers) if (transfer.guard.peer === guard.peer) this.transfers.delete(id)
      const transferId = token(); this.transfers.set(transferId, { guard, request, layers: { current: [], saved: [] }, points: { current: 0, saved: 0 }, bytes: { current: 0, saved: 0 } }); return { transferId }
    })
  }
  private transfer(guard: Guard, request: HistoryTransfer): Transfer {
    const transfer = this.transfers.get(request.transferId)
    if (!transfer || transfer.guard.peer !== guard.peer || !same(transfer.guard.scope, guard.scope)) throw failure('history_transfer', '会话迁移暂存不可用，请查询宿主状态。')
    this.check(transfer.guard); return transfer
  }
  part(raw: HistoryPartUpload): Promise<{ readonly next: number }> {
    const request = parseHistoryRequest('part', raw) as HistoryPartUpload, guard = this.authorize(request)
    return this.serial(guard, async () => {
      const transfer = this.transfer(guard, request), limit = request.layer === 'current' ? transfer.request.currentPoints : transfer.request.savedPoints
      if (transfer.committed || limit === null) throw failure('history_transfer', '此迁移层不可再写入。')
      const size = Array.from(request.text).length, before = transfer.points[request.layer]
      if (request.offset + size > limit) throw failure('history_transfer', '历史分片超过声明范围。')
      if (request.offset < before) {
        if (Array.from(transfer.layers[request.layer].join('')).slice(request.offset, request.offset + size).join('') !== request.text) throw failure('history_transfer', '重试分片与已暂存正文不一致。')
      } else {
        const bytes = new TextEncoder().encode(request.text).length
        if (request.offset !== before || transfer.bytes[request.layer] + bytes > HISTORY_BUNDLE_BYTES) throw failure('history_transfer', '历史分片不连续或超过 32 MiB 限制。')
        transfer.layers[request.layer].push(request.text); transfer.points[request.layer] += size; transfer.bytes[request.layer] += bytes
      }
      return { next: request.offset + size }
    })
  }
  private preserve(before: HistoryBundle, next: HistoryBundle): void {
    const immutable = (bundle: HistoryBundle) => [bundle.session.id, bundle.session.topicId, bundle.session.sequenceNamespaceId, bundle.session.sequence, bundle.session.createdAt]
    if (!same(immutable(before), immutable(next))) throw failure('history_identity', '历史更新不能更改已发放的会话身份。')
    for (const unit of before.history.units) {
      const candidate = next.history.units.find(item => item.id === unit.id)
      if (!candidate || candidate.order !== unit.order || isTextUnit(candidate) !== isTextUnit(unit) || isDeletedUnit(unit) && (!isDeletedUnit(candidate) || !same(unit.deletion, candidate.deletion))) throw failure('history_deleted', '历史更新不能丢失编号或恢复已删除单元。')
      if (!isDeletedUnit(unit) && isDeletedUnit(candidate)) throw failure('history_deleted', '单元删除须使用宿主删除命令，未接受快照覆盖。')
      const arrays = ['sourceVersions', 'revisions', 'preparations', 'plans', 'tasks', 'chunkRevisions', 'corrections', 'reuseApprovals', 'reviewAudits']
      const identity = (value: any): string => JSON.stringify([value.id ?? value.taskId ?? value.version, value.version ?? null])
      for (const field of arrays) {
        const old = (unit as unknown as Record<string, unknown>)[field], current = (candidate as unknown as Record<string, unknown>)[field]
        if (Array.isArray(old) && (!Array.isArray(current) || old.some(value => !current.some(item => identity(item) === identity(value))))) throw failure('history_versions', '历史更新不能丢弃已保留的原稿、修订、准备或调用版本。')
      }
      if (isTextUnit(unit) && isTextUnit(candidate)) for (const revision of unit.revisions) if (revision.status === 'deleted' && !candidate.revisions.some(item => item.id === revision.id && item.status === 'deleted' && same(item.deletion, revision.deletion))) throw failure('history_deleted', '历史更新不能恢复已删除版本。')
      if (isTextUnit(unit) && isTextUnit(candidate) && candidate.revisions.some(revision => revision.status === 'deleted' && unit.revisions.find(item => item.id === revision.id)?.status !== 'deleted')) throw failure('history_deleted', '版本删除须使用宿主删除命令，未接受快照覆盖。')
      if (isDocumentUnit(unit) && isDocumentUnit(candidate)) for (const field of ['sourceVersions', 'revisions', 'chunkRevisions', 'reviewAudits'] as const) {
        for (const item of candidate[field] ?? []) {
          const id = (value: any): unknown => value.id ?? value.version
          const old = (unit[field] ?? []).find(value => id(value) === id(item))
          if (old?.deletion ? !same(old, item) : item.deletion) throw failure('history_deleted', '文档版本删除须使用宿主命令，已删正文不能恢复。')
        }
      }
    }
    if (before.history.events.some(event => !next.history.events.some(item => item.id === event.id && same(item, event)))) throw failure('history_versions', '历史更新不能改写或丢弃已有事件。')
    for (const record of before.fileJobs) {
      const current = next.fileJobs.find(item => item.summary.jobId === record.summary.jobId)
      if (!current || [...record.sources, ...record.results].some(version => !(record.sources.includes(version) ? current.sources : current.results).some(item => item.version === version.version))) throw failure('history_versions', '历史更新不能丢弃文件正文版本。')
      for (const result of record.results) {
        const candidate = current.results.find(item => item.version === result.version)!
        if (result.baseVersion !== undefined && result.baseVersion !== candidate.baseVersion || result.sourceVersion !== undefined && result.sourceVersion !== candidate.sourceVersion) throw failure('history_versions', '历史更新不能更改文件译文的原稿或修订基础。')
      }
      for (const result of record.results) if (result.deletion && next.fileJobs.some(item => item.summary.unitId === record.summary.unitId && item.results.some(candidate => candidate.version === result.version && (!same(candidate.deletion, result.deletion) || candidate.text !== '')))) throw failure('history_deleted', '历史更新不能恢复已删除文件译文。')
      for (const source of record.sources) if (source.deletion && next.fileJobs.some(item => item.summary.unitId === record.summary.unitId && item.sources.some(candidate => candidate.version === source.version && !same(source, candidate)))) throw failure('history_deleted', '历史更新不能恢复已删除文件原稿。')
      if (record.results.length && record.results.every(result => result.deletion) && current.results.some(result => !result.deletion)) throw failure('history_deleted', '已删除全部结果的旧任务不能追加正文，请明确重译。')
    }
    if (next.fileJobs.some(record => record.results.some(result => result.deletion && !before.fileJobs.some(old => old.summary.unitId === record.summary.unitId && old.results.some(value => value.version === result.version && same(value.deletion, result.deletion)))))) throw failure('history_deleted', '文件版本删除须使用宿主删除命令。')
    if (next.fileJobs.some(record => record.sources.some(source => source.deletion && !before.fileJobs.some(old => old.summary.unitId === record.summary.unitId && old.sources.some(value => value.version === source.version && same(value.deletion, source.deletion)))))) throw failure('history_deleted', '原稿删除须使用宿主删除命令。')
    if (before.preparations.some(record => !next.preparations.some(item => item.versions[0]!.id === record.versions[0]!.id && record.versions.every(version => item.versions.some(candidate => candidate.version === version.version))))) throw failure('history_versions', '历史更新不能丢弃从属准备版本。')
    if (before.preparations.some(record => record.prepareSignature === '' && next.preparations.some(item => item.versions[0]!.id === record.versions[0]!.id && item.prepareSignature !== ''))) throw failure('history_deleted', '历史更新不能恢复已清除的准备请求。')
    if (before.intakes.some(record => !next.intakes.some(item => item.materialId === record.materialId))) throw failure('history_versions', '历史更新不能丢弃从属受理记录。')
  }
  commit(raw: HistoryTransfer): Promise<HistoryStatus> {
    const request = parseHistoryRequest('commit', raw) as HistoryTransfer, guard = this.authorize(request)
    return this.serial(guard, () => this.writer(async () => {
      const transfer = this.transfer(guard, request); if (transfer.committed) return transfer.committed
      const before = await this.seat(guard), input = transfer.request
      this.transfer(guard, request)
      if (!['replace', 'patch'].includes(input.purpose) ? !!before : !before || before.token !== input.expectedToken || !before.current) throw failure('history_stale', '会话历史已变化，本次暂存未提交。')
      if (transfer.points.current !== input.currentPoints || input.savedPoints !== null && transfer.points.saved !== input.savedPoints) throw failure('history_transfer', '完整历史及从属记录尚未取得。')
      let current: HistoryBundle, importedSaved: HistoryBundle | null
      try { const value = JSON.parse(transfer.layers.current.join('')); current = input.purpose === 'patch' ? applyHistoryPatch(before!.current!, value, guard.scope) : parseHistoryBundle(value, guard.scope); importedSaved = input.savedPoints === null ? null : parseHistoryBundle(JSON.parse(transfer.layers.saved.join('')), guard.scope, 'saved') }
      catch { throw failure('history_payload', '完整会话历史或从属记录格式无效，暂存未提交，旧副本保留。') }
      if (input.purpose === 'migrate' && (historyUnsettled(current) || importedSaved && historyUnsettled(importedSaved))) throw failure('history_busy', '此会话仍有运行中、等待处理或结果未知的任务，暂不迁移。')
      if (importedSaved) this.preserve(importedSaved, current)
      if (before?.current) this.preserve(before.current, current); if (before?.saved) this.preserve(before.saved, current)
      const saved = input.purpose === 'migrate' ? importedSaved : input.rememberHistory ? parseHistoryBundle(persistableHistoryBundle(current), guard.scope, 'saved') : before?.saved ?? null
      if (input.purpose !== 'migrate' && input.rememberHistory) current = saved!
      const next: Seat = { scope: guard.scope, current, saved, token: token() }
      if (saved !== null) {
        const db = await this.memory.databaseForArchives(true); this.check(guard); this.transfer(guard, request)
        if (db!.retired(guard.scope.namespaceId, guard.scope.topicId)) throw failure('history_retired', '主题已删除，历史不可恢复。')
        db!.transaction(() => {
          db!.historySave(guard.scope.namespaceId, guard.scope.topicId, guard.scope.sessionId, next.token, saved)
          if (encodeHistoryBundle(db!.historyState(guard.scope.namespaceId, guard.scope.sessionId)!.bundle!) !== encodeHistoryBundle(saved)) throw failure('history_verify', '宿主历史持久重读不一致，旧副本保留。')
        })
      }
      this.check(guard); this.seats.set(key(guard.scope), next)
      transfer.layers.current.length = 0; transfer.layers.saved.length = 0; transfer.committed = this.describe(next)
      return transfer.committed
    }))
  }
  cancel(raw: HistoryTransfer): Promise<{ readonly cancelled: true }> {
    const request = parseHistoryRequest('cancel', raw) as HistoryTransfer, guard = this.authorize(request)
    return this.serial(guard, async () => { if (this.transfers.has(request.transferId)) { this.transfer(guard, request); this.transfers.delete(request.transferId) }; return { cancelled: true } })
  }
  unitBlocked(sessionId: string, unitId: string, namespaceId?: string): boolean {
    const matches = (scope: HistoryScope): boolean => scope.sessionId === sessionId && (namespaceId === undefined || scope.namespaceId === namespaceId)
    return [...this.deletingUnits.values()].some(value => matches(value.scope) && (value.unitId === '*' || value.unitId === unitId)) || [...this.seats.values()].some(seat => matches(seat.scope) && (seat.current === null || seat.current.history.units.some(unit => unit.id === unitId && isDeletedUnit(unit))))
  }
  async isUnitDeleted(namespaceId: string, sessionId: string, unitId: string): Promise<boolean> {
    await this.tail
    const db = await this.memory.databaseForArchives(), seat = this.seats.get(key({ namespaceId, sessionId })), stored = seat ? undefined : db?.historyState(namespaceId, sessionId)
    const current = seat ? seat.current : stored?.bundle
    return current === null || !!current?.history.units.some(unit => unit.id === unitId && isDeletedUnit(unit))
  }
  async isFileResultDeleted(namespaceId: string, sessionId: string, unitId: string, version: number): Promise<boolean> {
    await this.tail
    const db = await this.memory.databaseForArchives(), seat = this.seats.get(key({ namespaceId, sessionId })), stored = seat ? undefined : db?.historyState(namespaceId, sessionId)
    return [seat?.current, seat?.saved, stored?.bundle].some(bundle => bundle?.fileJobs.some(record => record.summary.unitId === unitId && record.results.some(result => result.version === version && result.deletion))) || !!db?.historyCleanups().some(task => task.scope.namespaceId === namespaceId && task.scope.sessionId === sessionId && task.unitId === unitId && task.resultVersions?.includes(version))
  }
  fileSourceBlocked(sessionId: string, unitId: string, version: number, namespaceId?: string): boolean {
    return this.unitBlocked(sessionId, unitId, namespaceId) || [...this.seats.values()].some(seat => seat.scope.sessionId === sessionId && (namespaceId === undefined || seat.scope.namespaceId === namespaceId) && [seat.current, seat.saved].some(bundle => bundle?.fileJobs.some(record => record.summary.unitId === unitId && record.sources.some(source => source.version === version && source.deletion))))
  }
  async isFileSourceDeleted(namespaceId: string, sessionId: string, unitId: string, version: number): Promise<boolean> {
    await this.tail
    const db = await this.memory.databaseForArchives(), seat = this.seats.get(key({ namespaceId, sessionId })), stored = seat ? undefined : db?.historyState(namespaceId, sessionId)
    return [seat?.current, seat?.saved, stored?.bundle].some(bundle => bundle?.fileJobs.some(record => record.summary.unitId === unitId && record.sources.some(source => source.version === version && source.deletion)))
  }
  async isDocumentViewDeleted(namespaceId: string, sessionId: string, unitId: string, revisionId: string): Promise<boolean> {
    await this.tail
    const db = await this.memory.databaseForArchives(), seat = this.seats.get(key({ namespaceId, sessionId })), stored = seat ? undefined : db?.historyState(namespaceId, sessionId)
    return [seat?.current, seat?.saved, stored?.bundle].some(bundle => bundle?.history.units.some(unit => unit.id === unitId && isDocumentUnit(unit) && (unit.revisions.some(revision => revision.deletion && `source:${revision.sourceVersion}:manifest:${revision.id}` === revisionId) || unit.sourceVersions.some(source => source.deletion && `source:${source.version}` === revisionId)))) || !!db?.historyCleanups().some(task => task.scope.namespaceId === namespaceId && task.scope.sessionId === sessionId && task.unitId === unitId && task.revisionIds?.includes(revisionId))
  }
  async sourceReferenceAvailable(reference: HistoryCleanup['references'][number] & { readonly namespaceId?: string }): Promise<boolean> {
    await this.tail
    const scope = reference.scope, namespaceId = scope.namespaceId ?? reference.namespaceId
    if (!namespaceId) return true
    const db = await this.memory.databaseForArchives(), seat = this.seats.get(key({ namespaceId, sessionId: scope.translationSessionId })), stored = seat ? undefined : db?.historyState(namespaceId, scope.translationSessionId)
    const referenceKey = sourceReferenceKey(reference)
    if (!seat && !stored && !db?.historyCleanups().some(task => task.references.some(value => sourceReferenceKey(value) === referenceKey))) return true
    const bundles = seat ? [seat.current, seat.saved] : [stored?.bundle]
    if (historyResources(bundles.filter((bundle): bundle is HistoryBundle => !!bundle), { namespaceId, topicId: scope.topicId, sessionId: scope.translationSessionId }).references.some(value => sourceReferenceKey(value) === referenceKey)) return true
    return (await this.resourceHoldersLocked()).references.some(value => sourceReferenceKey(value) === referenceKey)
  }
  /** Writer callers already serialize changes; read callers await tail first. Never wait on tail here. */
  async resourceHoldersLocked(): Promise<HistoryCleanup> {
    const db = await this.memory.databaseForArchives(), bundles: HistoryBundle[] = [], known = new Set<string>()
    for (const seat of this.seats.values()) {
      known.add(key(seat.scope))
      if (!db?.retired(seat.scope.namespaceId, seat.scope.topicId)) for (const bundle of [seat.current, seat.saved]) if (bundle) bundles.push(bundle)
    }
    for (const scope of db?.historyAllScopes() ?? []) if (!known.has(key(scope)) && !db!.retired(scope.namespaceId, scope.topicId)) {
      const bundle = db!.historyState(scope.namespaceId, scope.sessionId)?.bundle; if (bundle) bundles.push(bundle)
    }
    return historyResources(bundles, { namespaceId: '*', topicId: '*', sessionId: '*' })
  }
  async cleanupResourcesLocked(scope?: HistoryScope, unitId?: string, topic = false): Promise<HistoryCleanupResult> {
    const report = diagnosticSpan(this.ctx, 'history.cleanup', { topic, unit: unitId !== undefined }, scope?.sessionId)
    const total = { complete: true, removed: 0, retained: 0 }
    const tally = { removed: new Set<string>(), retained: new Set<string>() }
    try {
      const db = await this.memory.databaseForArchives(), data = this.ctx.get?.('translationLocalData') as LocalDataService | undefined
      for (const task of db?.historyCleanups() ?? []) if (!scope || (topic ? task.scope.namespaceId === scope.namespaceId && task.scope.topicId === scope.topicId : key(task.scope) === key(scope)) && (unitId === undefined || task.unitId === unitId)) {
        const result = data ? await data.cleanupHistoryUnitLocked(task, await this.resourceHoldersLocked(), tally) : { complete: !task.resultVersions && !task.revisionIds && !task.sourceVersions && !task.sources.length && !task.references.length, removed: 0, retained: 0 }
        total.complete &&= result.complete; total.removed += result.removed; total.retained += result.retained
        if (result.complete) db!.historyCleanupRemove(task.scope.namespaceId, task.scope.sessionId, task.unitId)
      }
      if (data) { total.removed = tally.removed.size; total.retained = tally.retained.size }
    } catch (error) { total.complete = false; report('failed', { removed: total.removed, retained: total.retained }, error); return total }
    report(total.complete ? 'completed' : 'degraded', total)
    return total
  }
  cleanupTopicResourcesLocked(namespaceId: string, topicId: string): Promise<HistoryCleanupResult> { return this.cleanupResourcesLocked({ namespaceId, topicId, sessionId: '*' }, undefined, true) }
  private async sessionCleanupLocked(scope: HistoryScope, bundles: readonly HistoryBundle[]): Promise<HistoryCleanup> {
    const data = this.ctx.get?.('translationLocalData') as LocalDataService | undefined, db = await this.memory.databaseForArchives()
    let task = historyResources(bundles, scope)
    if (data) task = await data.scopeResourcesLocked(task)
    for (const previous of db?.historyCleanups() ?? []) if (key(previous.scope) === key(scope)) task = mergeHistoryCleanup(previous, task)
    return { ...task, unitId: '*' }
  }
  mutate(raw: HistoryMutation): ReturnType<import('../shared/history-remote.js').HistoryRemotePort['mutate']> {
    const request = parseHistoryRequest('mutate', raw) as HistoryMutation, guard = this.authorize(request)
    return this.serial(guard, () => this.writer(async () => {
      const seat = await this.seat(guard)
      if (!seat?.current) throw failure('history_unavailable', '历史尚未迁入宿主或已删除。')
      const repeated = seat.current.history.events.find(event => event.id === request.operationId)
      if (repeated) {
        const types = request.command.kind === 'delete_unit' ? ['unit.deleted', 'document.deleted'] : request.command.kind === 'delete_document_chunks' ? ['chunks.deleted'] : request.command.kind === 'delete_file_result' ? ['file_result.deleted'] : request.command.kind === 'delete_document_source' || request.command.kind === 'delete_file_source' ? ['source.deleted'] : request.command.kind === 'delete_document_revision' ? ['manifest.deleted'] : ['revision.deleted']
        if (repeated.unitId !== request.command.unitId || !types.includes(repeated.type) || (request.command.kind === 'delete_text_revision' || request.command.kind === 'delete_document_revision') && repeated.revisionId !== request.command.revisionId || request.command.kind === 'delete_file_result' && repeated.resultVersion !== request.command.version || (request.command.kind === 'delete_document_source' || request.command.kind === 'delete_file_source') && repeated.sourceVersion !== request.command.version) throw failure('history_operation', '操作编号已用于其他历史变更。')
        return { status: 'updated', state: this.describe(seat), ...(!['delete_text_revision', 'delete_document_chunks'].includes(request.command.kind) ? { resourceCleanup: await this.cleanupResourcesLocked(guard.scope, request.command.unitId) } : {}) }
      }
      if (seat.token !== request.token) return { status: 'stale', state: this.describe(seat) }
      if (seat.current.session.archivedAt !== null || historyUnsettled(seat.current) || seat.saved && historyUnsettled(seat.saved)) return { status: 'blocked', state: this.describe(seat), reason: '会话已归档或仍有未结算任务，当前未删除。' }
      const command = request.command, unit = seat.current.history.units.find(unit => unit.id === command.unitId)
      if (!unit) return { status: 'blocked', state: this.describe(seat), reason: '目标单元不存在，当前未删除。' }
      if (isDeletedUnit(unit)) return { status: 'updated', state: this.describe(seat), ...(command.kind === 'delete_unit' ? { resourceCleanup: await this.cleanupResourcesLocked(guard.scope, command.unitId) } : {}) }
      let orphanIds: readonly string[] = []
      if (command.kind === 'delete_document_chunks') {
        if (!isDocumentUnit(unit)) return { status: 'blocked', state: this.describe(seat), reason: '此操作仅支持文档翻译块。' }
        const blocked = documentChunkCleanupBlockedReason(unit)
        if (blocked) return { status: 'blocked', state: this.describe(seat), reason: blocked }
        const layers = [seat.current, seat.saved].flatMap(bundle => bundle?.history.units.filter(isDocumentUnit).filter(target => target.id === command.unitId) ?? [])
        const held = new Set(layers.flatMap(target => { const orphans = new Set(documentOrphanChunks(target)); return target.chunkRevisions.filter(chunk => !chunk.deletion && !orphans.has(chunk.id)).map(chunk => chunk.id) }))
        orphanIds = documentOrphanChunks(unit).filter(id => !held.has(id))
        if (!orphanIds.length) return { status: 'blocked', state: this.describe(seat), reason: '翻译块仍被已保存版本使用，当前没有可清理正文。' }
      }
      if (command.kind === 'delete_text_revision') {
        if (!isTextUnit(unit) || !unit.revisions.some(revision => revision.id === command.revisionId)) return { status: 'blocked', state: this.describe(seat), reason: '目标短文版本不存在，当前未删除。' }
        if (unit.revisions.find(revision => revision.id === command.revisionId)!.status === 'deleted') return { status: 'updated', state: this.describe(seat) }
      }
      if (command.kind === 'delete_document_revision') {
        if (!isDocumentUnit(unit)) return { status: 'blocked', state: this.describe(seat), reason: '此操作仅支持文档旧译文。' }
        for (const bundle of [seat.current, seat.saved]) if (bundle) {
          const target = bundle.history.units.find(item => item.id === command.unitId)
          if (target && isDocumentUnit(target) && target.revisions.some(revision => revision.id === command.revisionId && !revision.deletion)) {
            const blocked = documentRevisionDeletionBlockedReason(target, command.revisionId)
            if (blocked) return { status: 'blocked', state: this.describe(seat), reason: blocked }
          } else if (bundle === seat.current && !unit.revisions.some(revision => revision.id === command.revisionId)) return { status: 'blocked', state: this.describe(seat), reason: '文档版本不存在。' }
        }
      }
      if (command.kind === 'delete_document_source') {
        if (!isDocumentUnit(unit)) return { status: 'blocked', state: this.describe(seat), reason: '此操作仅支持文档旧原稿。' }
        for (const bundle of [seat.current, seat.saved]) if (bundle) {
          const target = bundle.history.units.find(item => item.id === command.unitId)
          if (!target || !isDocumentUnit(target)) continue
          const source = target.sourceVersions.find(source => source.version === command.version)
          if (!source || source.deletion) continue
          const blocked = documentSourceDeletionBlockedReason(target, command.version)
          if (blocked) return { status: 'blocked', state: this.describe(seat), reason: blocked }
          const refs = target.preparations.filter(ref => ref.sourceVersion === command.version)
          if (bundle.history.units.some(other => other.id !== target.id && isDocumentUnit(other) && other.preparations.some(ref => ref.sourceVersion === command.version && refs.some(old => ref.id === old.id)))) return { status: 'blocked', state: this.describe(seat), reason: '其他文档仍在使用此原稿的准备记录。' }
        }
        if (!unit.sourceVersions.some(source => source.version === command.version)) return { status: 'blocked', state: this.describe(seat), reason: '原稿版本不存在。' }
      }
      if (command.kind === 'delete_file_source') {
        if (!isFileJobUnit(unit)) return { status: 'blocked', state: this.describe(seat), reason: '此操作仅支持文件旧原稿。' }
        for (const bundle of [seat.current, seat.saved]) if (bundle) {
          const target = bundle.history.units.find(item => item.id === command.unitId), records = bundle.fileJobs.filter(record => record.summary.unitId === command.unitId)
          if (!target || !records.some(record => record.sources.some(source => source.version === command.version && !source.deletion))) continue
          const blocked = fileSourceDeletionBlockedReason(records, target.sourceVersion, command.version)
          if (blocked) return { status: 'blocked', state: this.describe(seat), reason: blocked }
          const versions = bundle.preparations.flatMap(record => record.versions.filter(version => historyTargetMatches(guard.scope, target.id, { ...version.scope, ...version.target }, command.version)))
          if (bundle.history.units.some(other => other.id !== target.id && isDocumentUnit(other) && other.preparations.some(ref => versions.some(version => version.id === ref.id && version.version === ref.version)))) return { status: 'blocked', state: this.describe(seat), reason: '其他文档仍在使用此原稿的准备记录。' }
        }
        if (!seat.current.fileJobs.some(record => record.summary.unitId === unit.id && record.sources.some(source => source.version === command.version))) return { status: 'blocked', state: this.describe(seat), reason: '原稿版本不存在。' }
      }
      if (command.kind === 'delete_file_result') {
        if (!isFileJobUnit(unit)) return { status: 'blocked', state: this.describe(seat), reason: '此操作仅支持文件译文版本。' }
        for (const bundle of [seat.current, seat.saved]) if (bundle) {
          const records = bundle.fileJobs.filter(record => record.summary.unitId === command.unitId), target = records.flatMap(record => record.results).find(result => result.version === command.version)
          if (target?.deletion) continue
          if (target) { const version = bundle.history.units.find(unit => unit.id === command.unitId)!.sourceVersion, blocked = fileResultDeletionBlockedReason(records, version, command.version); if (blocked) return { status: 'blocked', state: this.describe(seat), reason: blocked } }
          else if (bundle === seat.current) return { status: 'blocked', state: this.describe(seat), reason: '此文件译文版本不存在。' }
        }
      }
      if (['translationFileJobs', 'translationNormal', 'translationBatch', 'translationAnalysis', 'translationCorrection', 'translationPlanning'].some(name => (this.ctx.get?.(name) as { historyUnitBusy?(scope: HistoryScope, unitId: string): boolean } | undefined)?.historyUnitBusy?.(guard.scope, command.unitId))) return { status: 'blocked', state: this.describe(seat), reason: '此单元仍有宿主任务未结算，请先结束或查询。' }
      const cleanup: HistoryCleanup | undefined = command.kind === 'delete_unit' ? historyResources([seat.current, ...seat.saved ? [seat.saved] : []], guard.scope, command.unitId)
        : command.kind === 'delete_file_source' ? (() => {
          const bundles = [seat.current, ...seat.saved ? [seat.saved] : []], records = bundles.flatMap(bundle => bundle.fileJobs.filter(record => record.summary.unitId === command.unitId))
          const owned = bundles.map(bundle => ({ ...bundle, history: { ...bundle.history, units: [] }, fileJobs: bundle.fileJobs.filter(record => record.summary.unitId === command.unitId && record.summary.sourceVersion === command.version), intakes: command.version === 1 ? bundle.intakes.filter(intake => intake.unitId === command.unitId) : [] }))
          return { ...historyResources(owned, guard.scope, command.unitId), sourceVersions: [command.version], resultVersions: [...new Set(records.flatMap(record => record.results.filter(result => fileResultSourceVersion(record, result) === command.version).map(result => result.version)))], revisionIds: [`source:${command.unitId}:${command.version}`] }
        })()
        : command.kind === 'delete_file_result' ? { scope: guard.scope, unitId: command.unitId, sources: [], references: [], resultVersions: [command.version] }
        : command.kind === 'delete_document_revision' && isDocumentUnit(unit) ? { scope: guard.scope, unitId: command.unitId, sources: [], references: [], revisionIds: [`source:${unit.revisions.find(revision => revision.id === command.revisionId)!.sourceVersion}:manifest:${command.revisionId}`] }
        : command.kind === 'delete_document_source' ? (() => {
          const bodies = [seat.current, ...seat.saved ? [seat.saved] : []].flatMap(bundle => bundle.history.units.filter(isDocumentUnit).filter(unit => unit.id === command.unitId))
          const sources = bodies.flatMap(unit => unit.sourceVersions.filter(source => source.version === command.version))
          return { scope: guard.scope, unitId: command.unitId, sourceVersions: [command.version], sources: sources.flatMap(source => source.body.kind === 'asset' ? [{ sourceId: source.body.reference.sourceId, sha256: source.body.reference.sha256 }] : []), references: sources.flatMap(source => source.historyCommit ? [{ scope: source.historyCommit.reference.scope, referenceKey: source.historyCommit.reference.referenceKey }] : []), revisionIds: [`source:${command.version}`, ...new Set(bodies.flatMap(unit => unit.revisions.filter(revision => revision.sourceVersion === command.version).map(revision => `source:${command.version}:manifest:${revision.id}`)))] }
        })() : undefined
      const at = new Date().toISOString(), operation = { eventId: request.operationId, at }
      const convert = (bundle: HistoryBundle): HistoryBundle => {
        const target = bundle.history.units.find(unit => unit.id === command.unitId)
        if (!target || isDeletedUnit(target)) return bundle
        if (command.kind === 'delete_document_chunks') {
          if (!isDocumentUnit(target)) return bundle
          const ids = orphanIds.filter(id => target.chunkRevisions.some(chunk => chunk.id === id && !chunk.deletion))
          if (!ids.length) return bundle
          const updated = deleteDocumentChunks(target, ids, operation)
          const history = appendTranslationEvent({ ...bundle.history, units: bundle.history.units.map(unit => unit.id === target.id ? updated : unit) }, { id: request.operationId, at, type: 'chunks.deleted', unitId: target.id, chunkRevisionIds: ids, revisionId: null, operationId: null, status: 'deleted', reason: 'user_deletion' })
          return { ...bundle, session: { ...bundle.session, updatedAt: at }, history }
        }
        if (command.kind === 'delete_file_source') {
          const records = bundle.fileJobs.filter(record => record.summary.unitId === target.id)
          if (!records.some(record => record.sources.some(source => source.version === command.version && !source.deletion))) return bundle
          const updated = deleteFileSource(records, target.sourceVersion, command.version, operation)
          const preparations = bundle.preparations.flatMap(record => {
            const versions = record.versions.filter(version => !historyTargetMatches(guard.scope, target.id, { ...version.scope, ...version.target }, command.version))
            return versions.length === record.versions.length ? [record] : versions.length ? [{ ...record, schemaVersion: 3 as const, versions, prepareSignature: '', operations: Object.fromEntries(Object.entries(record.operations).filter(([, entry]) => versions.some(version => version.version === entry.version))) }] : []
          })
          const history = appendTranslationEvent(bundle.history, { id: request.operationId, at, type: 'source.deleted', unitId: target.id, sourceVersion: command.version, revisionId: null, operationId: null, status: 'deleted', reason: 'user_deletion' })
          return { ...bundle, session: { ...bundle.session, updatedAt: at }, history, fileJobs: bundle.fileJobs.map(record => updated.find(item => item.summary.jobId === record.summary.jobId) ?? record), preparations, intakes: command.version === 1 ? bundle.intakes.filter(intake => intake.unitId !== target.id) : bundle.intakes }
        }
        if (command.kind === 'delete_document_source') {
          if (!isDocumentUnit(target) || !target.sourceVersions.some(source => source.version === command.version && !source.deletion)) return bundle
          const updated = deleteDocumentSource(target, command.version, operation), refs = target.preparations.filter(ref => ref.sourceVersion === command.version)
          const preparations = bundle.preparations.flatMap(record => {
            const versions = record.versions.filter(version => !(version.sourceVersion === command.version && (refs.some(ref => ref.id === version.id) || historyTargetMatches(guard.scope, target.id, { ...version.scope, ...version.target }))))
            if (versions.length === record.versions.length) return [record]
            return versions.length ? [{ ...record, schemaVersion: 3 as const, versions, prepareSignature: '', operations: Object.fromEntries(Object.entries(record.operations).filter(([, entry]) => versions.some(version => version.version === entry.version))) }] : []
          })
          const history = appendTranslationEvent({ ...bundle.history, units: bundle.history.units.map(unit => unit.id === target.id ? updated : unit) }, { id: request.operationId, at, type: 'source.deleted', unitId: target.id, revisionId: null, operationId: null, sourceVersion: command.version, status: 'deleted', reason: 'user_deletion' })
          return { ...bundle, session: { ...bundle.session, updatedAt: at }, history, preparations, intakes: command.version === 1 ? bundle.intakes.filter(intake => intake.unitId !== target.id) : bundle.intakes }
        }
        if (command.kind === 'delete_document_revision') {
          if (!isDocumentUnit(target) || !target.revisions.some(revision => revision.id === command.revisionId && !revision.deletion)) return bundle
          const updated = deleteDocumentRevision(target, command.revisionId, operation)
          const history = appendTranslationEvent({ ...bundle.history, units: bundle.history.units.map(unit => unit.id === target.id ? updated : unit) }, { id: request.operationId, at, type: 'manifest.deleted', unitId: target.id, revisionId: command.revisionId, operationId: null, status: 'deleted', reason: 'user_deletion' })
          return { ...bundle, session: { ...bundle.session, updatedAt: at }, history }
        }
        if (command.kind === 'delete_file_result') {
          const records = bundle.fileJobs.filter(record => record.summary.unitId === command.unitId)
          if (!records.some(record => record.results.some(result => result.version === command.version && !result.deletion))) return bundle
          const updated = deleteFileResult(records, target.sourceVersion, command.version, operation)
          const history = appendTranslationEvent(bundle.history, { id: request.operationId, at, type: 'file_result.deleted', unitId: command.unitId, resultVersion: command.version, revisionId: null, operationId: null, status: 'deleted', reason: 'user_deletion' })
          return { ...bundle, session: { ...bundle.session, updatedAt: at }, history, fileJobs: bundle.fileJobs.map(record => updated.find(item => item.summary.jobId === record.summary.jobId) ?? record) }
        }
        const history = command.kind === 'delete_text_revision'
          ? !isTextUnit(target) || !target.revisions.some(revision => revision.id === command.revisionId && revision.status !== 'deleted') ? bundle.history : deleteTextRevision(bundle.history, command.unitId, command.revisionId, operation)
          : deleteUnit(bundle.history, command.unitId, { ...operation, callFacts: fileCallFacts(bundle, command.unitId) })
        if (history === bundle.history) return bundle
        const session = { ...bundle.session, updatedAt: at }
        if (command.kind !== 'delete_unit') return { ...bundle, session, history }
        const references = new Set(history.units.filter(isDocumentUnit).filter(unit => !isDeletedUnit(unit)).flatMap(unit => unit.preparations.map(ref => ref.id)))
        const owned = new Set([...(isDocumentUnit(target) ? target.preparations.map(ref => ref.id) : []), ...bundle.preparations.filter(item => item.versions.some(version => historyTargetMatches(guard.scope, command.unitId, { ...version.scope, ...version.target }))).map(item => item.versions[0]!.id)])
        return { ...bundle, session, history, intakes: bundle.intakes.filter(item => item.unitId !== request.command.unitId), fileJobs: bundle.fileJobs.filter(item => item.summary.unitId !== request.command.unitId), preparations: bundle.preparations.filter(item => !owned.has(item.versions[0]!.id) || references.has(item.versions[0]!.id)) }
      }
      const fenceKey = JSON.stringify([guard.scope.namespaceId, guard.scope.sessionId, command.unitId])
      if (cleanup) this.deletingUnits.set(fenceKey, { scope: guard.scope, unitId: command.unitId })
      try {
        const current = parseHistoryBundle(convert(seat.current), guard.scope), saved = seat.saved ? parseHistoryBundle(convert(seat.saved), guard.scope, 'saved') : null
        const next = { ...seat, current, saved, token: token() }
        if (saved || cleanup) { const db = await this.memory.databaseForArchives(true); this.check(guard); db!.transaction(() => {
          if (saved) db!.historySave(guard.scope.namespaceId, guard.scope.topicId, guard.scope.sessionId, next.token, saved)
          if (cleanup) {
            const previous = db!.historyCleanups().find(task => key(task.scope) === key(cleanup.scope) && task.unitId === cleanup.unitId)
            db!.historyCleanupSave(mergeHistoryCleanup(previous, cleanup))
            if (command.kind === 'delete_unit') historyIndexSourceIds(guard.scope.sessionId, request.command.unitId).forEach(id => db!.indexRemoveSource(guard.scope.namespaceId, guard.scope.topicId, id))
          }
        }) }
        this.seats.set(key(guard.scope), next)
        return { status: 'updated', state: this.describe(next), ...(cleanup ? { resourceCleanup: await this.cleanupResourcesLocked(guard.scope, command.unitId) } : {}) }
      } catch (error) {
        if ((error as { code?: string }).code) throw error
        return { status: 'blocked', state: this.describe(seat), reason: '目标版本仍受保护或删除尚未完成，请核对最新／最终选择与存储状态。' }
      } finally { this.deletingUnits.delete(fenceKey) }
    }))
  }
  /** Literal body matches only; the overlap also covers matches crossing stored/read pages. */
  async searchCurrent(raw: HistoryTextSearch, signal: AbortSignal): Promise<HistoryTextMatches> {
    const request = parseHistoryRequest('searchCurrent', raw) as HistoryTextSearch
    const { query: _query, ...read } = request
    const fold = (text: string): string => text.replace(/[A-Z]/g, letter => letter.toLowerCase())
    const needle = fold(request.query), length = Array.from(needle).length, matches: { start: number; end: number }[] = []
    const first = await this.readCurrent(read, signal)
    if (first.text === null) throw failure('history_unavailable', first.reason ?? '当前正文不可读取。')
    const boundary = Math.min(first.totalCodePoints, request.start + 1000), wanted = Math.min(first.totalCodePoints, boundary + length - 1)
    let text = first.text, end = request.start + Array.from(text).length
    while (end < wanted) { const page = await this.readCurrent({ ...read, start: end }, signal); if (page.text === null) throw failure('history_unavailable', page.reason ?? '当前正文不可读取。'); text += page.text; end += Array.from(page.text).length }
    text = Array.from(text).slice(0, wanted - request.start).join('')
    const folded = fold(text)
    let offset = 0, next = boundary
    while (matches.length < 250) {
      const found = folded.indexOf(needle, offset); if (found < 0) break
      const start = request.start + Array.from(text.slice(0, found)).length
      if (start >= boundary) break
      matches.push({ start, end: start + length }); offset = found + needle.length; next = Math.max(boundary, start + length)
    }
    if (matches.length === 250) next = matches.at(-1)!.end
    signal.throwIfAborted()
    // A second page/read checks the same token, including deletion during the scan.
    const guard = this.authorize(request); await this.tail; await this.current(guard, request.token)
    return { matches, next: next < first.totalCodePoints ? next : null }
  }
  async readCurrent(raw: CurrentHistoryRead, signal: AbortSignal): Promise<HistoryCurrentPage> {
    const request = parseHistoryRequest('readCurrent', raw) as CurrentHistoryRead, guard = this.authorize(request); this.pending++
    try {
      await this.tail; const seat = await this.current(guard, request.token)
      const result = await readCurrentHistory(seat.current!, request, guard.peer, this.ctx.get?.('translationSources') as TranslationSourcesService | undefined, signal)
      signal.throwIfAborted(); this.check(guard)
      if (this.seats.get(key(guard.scope)) !== seat) throw failure('history_stale', '历史在读取期间变化，迟到正文未返回。')
      return result
    } finally { this.pending-- }
  }
  releaseLibrary(namespaceId: string, peer: string): void { for (const [id, transfer] of this.transfers) if (transfer.guard.scope.namespaceId === namespaceId && transfer.guard.peer === peer) this.transfers.delete(id) }
  retire(raw: import('../shared/history-remote.js').HistoryRetire): ReturnType<import('../shared/history-remote.js').HistoryRemotePort['retire']> {
    const request = parseHistoryRequest('retire', raw), guard = this.authorize(request)
    return this.serial(guard, () => this.writer(async () => {
      const seat = await this.seat(guard)
      if (!seat) throw failure('history_unavailable', '会话尚未存入宿主。')
      if (seat.current === null) return { status: 'updated', state: this.describe(seat), resourceCleanup: await this.cleanupResourcesLocked(guard.scope) }
      if (seat.token !== request.token) return { status: 'stale', state: this.describe(seat) }
      if (historyUnsettled(seat.current) || seat.saved && historyUnsettled(seat.saved)) return { status: 'blocked', state: this.describe(seat), reason: '此会话仍有未结算任务，请先结束或查询。' }
      if (['translationFileJobs', 'translationNormal', 'translationBatch', 'translationAnalysis', 'translationCorrection', 'translationPlanning', 'translationReview'].some(name => (this.ctx.get?.(name) as { historyUnitBusy?(scope: HistoryScope, unitId: string): boolean } | undefined)?.historyUnitBusy?.(guard.scope, '*'))) return { status: 'blocked', state: this.describe(seat), reason: '此会话仍有宿主任务未结算，请先结束或查询。' }
      const fence = JSON.stringify([guard.scope.namespaceId, guard.scope.sessionId, '*']); this.deletingUnits.set(fence, { scope: guard.scope, unitId: '*' })
      try {
        const task = await this.sessionCleanupLocked(guard.scope, [seat.current, ...seat.saved ? [seat.saved] : []])
        this.check(guard)
        const next: Seat = { ...seat, current: null, saved: null, token: token() }, db = await this.memory.databaseForArchives(true)
        db!.transaction(() => {
          db!.historySave(guard.scope.namespaceId, guard.scope.topicId, guard.scope.sessionId, next.token, null)
          for (const previous of db!.historyCleanups()) if (key(previous.scope) === key(guard.scope)) db!.historyCleanupRemove(previous.scope.namespaceId, previous.scope.sessionId, previous.unitId)
          db!.historyCleanupSave(task)
          for (const unit of seat.current!.history.units) historyIndexSourceIds(guard.scope.sessionId, unit.id).forEach(id => db!.indexRemoveSource(guard.scope.namespaceId, guard.scope.topicId, id))
        })
        this.seats.set(key(guard.scope), next)
        return { status: 'updated', state: this.describe(next), resourceCleanup: await this.cleanupResourcesLocked(guard.scope) }
      } finally { this.deletingUnits.delete(fence) }
    }))
  }
  async retireTopicLocked(namespaceId: string, topicId: string): Promise<void> {
    const db = await this.memory.databaseForArchives(true)
    const ids = new Set([...db!.historySessions(namespaceId, topicId), ...[...this.seats.values()].filter(seat => seat.scope.namespaceId === namespaceId && seat.scope.topicId === topicId).map(seat => seat.scope.sessionId)])
    const tasks: HistoryCleanup[] = []
    for (const sessionId of ids) {
      const scope = { namespaceId, topicId, sessionId }, seat = this.seats.get(key(scope)), saved = seat ? seat.saved : db!.historyState(namespaceId, sessionId)?.bundle
      tasks.push(await this.sessionCleanupLocked(scope, [seat?.current, saved].filter((bundle): bundle is HistoryBundle => !!bundle)))
    }
    db!.transaction(() => { for (const task of tasks) {
      db!.historySave(namespaceId, topicId, task.scope.sessionId, token(), null)
      for (const previous of db!.historyCleanups()) if (key(previous.scope) === key(task.scope)) db!.historyCleanupRemove(previous.scope.namespaceId, previous.scope.sessionId, previous.unitId)
      db!.historyCleanupSave(task)
    } })
    for (const sessionId of ids) this.seats.set(key({ namespaceId, sessionId }), { scope: { namespaceId, topicId, sessionId }, current: null, saved: null, token: token() })
    for (const [id, transfer] of this.transfers) if (transfer.guard.scope.namespaceId === namespaceId && transfer.guard.scope.topicId === topicId) this.transfers.delete(id)
  }
  hasActiveJobs(): boolean { return this.pending > 0 || [...this.transfers.values()].some(transfer => !transfer.committed) || [...this.seats.values()].some(seat => seat.current && historyUnsettled(seat.current)) }
  async dispose(): Promise<void> { this.disposed = true; this.generation++; await this.tail; this.transfers.clear(); this.seats.clear() }
}
