import { decodeTopicArchiveSnapshot, emptyTopicArchive, putTopicArchive, putUserTopicArchive, adoptTopicArchive, acceptTopicArchiveProposal, disableTopicArchive,
  deleteTopicArchiveEntry, reconcileTopicArchive, referencedEntityIds, type TopicArchiveSnapshot, type ArchiveMutationResult } from '../memory/topic-archive.js'
import { termEvidenceKey, type TermEvidenceRef, type TermEvidenceResolver } from '../memory/topic-terms.js'
import { ARCHIVE_TRANSFER_POINTS, parseArchiveRemoteRequest, type ArchiveRemoteScope, type ArchiveStorageStatus, type ArchiveHead, type ArchiveReadRequest,
  type ArchiveReadPage, type ArchiveMigrateBegin, type ArchiveMigratePart, type ArchiveMigrateCommit, type ArchiveMutationRequest, type ArchiveMutationReceipt,
  type ArchiveRemotePort, type ArchiveEvidenceState, type ArchiveCommand } from '../shared/topic-archive-remote.js'
import type { OtherMemoryService } from './other-memory.js'
import type { LocalDataService } from './local-data.js'
import type { TopicHostContext, TopicToolsService } from './topic-tools.js'

interface Seat { readonly scope: ArchiveRemoteScope; current: TopicArchiveSnapshot; saved: TopicArchiveSnapshot | null; token: string }
interface Guard { readonly scope: ArchiveRemoteScope; readonly peer: string; readonly generation: number }
interface Transfer { readonly guard: Guard; readonly id: string; readonly totals: { current: number; saved: number | null }; readonly parts: { current: string[]; saved: string[] }; readonly lengths: { current: number; saved: number } }
function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
const key = (scope: Pick<ArchiveRemoteScope, 'namespaceId' | 'topicId'>): string => JSON.stringify([scope.namespaceId, scope.topicId])
const stamp = (): string => new Date().toISOString()
const token = (): string => `archive:${crypto.randomUUID()}`
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
function head(snapshot: TopicArchiveSnapshot | null): ArchiveHead | null { if (!snapshot) return null; const { entries, ...metadata } = snapshot; return { ...metadata, count: entries.length } }

/** Commands are executed here; Client transports legacy input once and thereafter caches reads only. */
export class TopicArchiveService implements ArchiveRemotePort {
  readonly typertRemote: { readonly service: TopicArchiveService; readonly serviceKey: 'translationArchive'; readonly namespace: 'translationArchive' } = { service: this, serviceKey: 'translationArchive', namespace: 'translationArchive' }
  private readonly seats = new Map<string, Seat>()
  private readonly transfers = new Map<string, Transfer>()
  private readonly retired = new Map<string, string>()
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false
  private generation = 0
  private pending = 0
  constructor(private readonly ctx: TopicHostContext, private readonly memory: OtherMemoryService) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationArchive', property: 'ctx' } })
  }
  private authorize(scope: ArchiveRemoteScope): Guard {
    const peer = this.ctx.invocation?.peer.id
    if (!peer || this.disposed || !(this.ctx.get?.('translationTopics') as TopicToolsService | undefined)?.ownsLibrary(scope.namespaceId, peer)) throw failure('scope_mismatch', '主题档案操作不属于此资料库连接。')
    return { scope, peer, generation: this.generation }
  }
  private check(guard: Guard): void {
    if (this.disposed || guard.generation !== this.generation) throw failure('archive_closed', '主题档案存储已关闭，迟到操作已停止。')
    if (!(this.ctx.get?.('translationTopics') as TopicToolsService | undefined)?.ownsLibrary(guard.scope.namespaceId, guard.peer)) throw failure('scope_mismatch', '资料库连接已变化。')
  }
  private async isRetired(scope: ArchiveRemoteScope): Promise<boolean> { return this.retired.has(key(scope)) || (await this.memory.databaseForArchives())?.retired(scope.namespaceId, scope.topicId) === true }
  private async requireOpen(guard: Guard): Promise<void> { this.check(guard); if (await this.isRetired(guard.scope)) throw failure('archive_retired', '此主题已删除，档案不可读取或恢复。'); this.check(guard) }
  private retiredStatus(scope: ArchiveRemoteScope): ArchiveStorageStatus {
    let value = this.retired.get(key(scope)); if (!value) { value = token(); this.retired.set(key(scope), value) }
    return { switched: true, token: value, current: head(emptyTopicArchive(scope.ownerId, scope.topicId, '1970-01-01T00:00:00.000Z')), saved: null, persistence: 'saved', retired: true }
  }
  private async seat(scope: ArchiveRemoteScope): Promise<Seat | undefined> {
    const known = this.seats.get(key(scope))
    if (known) { if (known.scope.ownerId !== scope.ownerId) throw failure('scope_mismatch', '主题档案所属身份不一致。'); return known }
    const stored = (await this.memory.databaseForArchives())?.archiveState(scope.namespaceId, scope.topicId)
    if (!stored) return undefined
    if (stored.ownerId !== scope.ownerId) throw failure('scope_mismatch', '已保存主题档案所属身份不一致。')
    const seat: Seat = { scope, current: stored.snapshot ?? emptyTopicArchive(scope.ownerId, scope.topicId, stamp()), saved: stored.snapshot, token: token() }
    this.seats.set(key(scope), seat); return seat
  }
  private describe(seat: Seat | undefined): ArchiveStorageStatus {
    return seat ? { switched: true, token: seat.token, current: head(seat.current), saved: head(seat.saved), persistence: same(seat.current, seat.saved) ? 'saved' : 'runtime_only' }
      : { switched: false, token: null, current: null, saved: null, persistence: 'runtime_only' }
  }
  private async current(guard: Guard, expected: string): Promise<Seat> {
    await this.requireOpen(guard)
    const seat = await this.seat(guard.scope); this.check(guard)
    if (this.retired.has(key(guard.scope))) throw failure('archive_retired', '此主题已删除，档案不可读取或恢复。')
    if (!seat || seat.token !== expected) throw failure('archive_stale', '主题档案已变化，请读取最新副本后重试。')
    return seat
  }
  private serial<T>(guard: Guard, run: () => Promise<T>): Promise<T> {
    this.pending++
    const result = this.tail.then(() => { this.check(guard); return run() }); this.tail = result.catch(() => {})
    return result.finally(() => { this.pending-- })
  }
  private writer<T>(run: () => Promise<T>): Promise<T> { return ((this.ctx.get?.('translationLocalData') as LocalDataService | undefined)?.storageWriter() ?? (async <R>(f: () => Promise<R>): Promise<R> => f()))(run).then(value => {
    (this.ctx.get?.('translationMemorySearch') as { contentChanged(): void } | undefined)?.contentChanged(); return value
  }) }
  /** Current Host overlays and saved projections; never imports a Client body for indexing. */
  async retrievalSnapshots(namespaceId: string, peer: string, topicId?: string): Promise<readonly { readonly current: TopicArchiveSnapshot; readonly saved: TopicArchiveSnapshot | null }[]> {
    const guard: Guard = { scope: { namespaceId, ownerId: namespaceId, topicId: '*' }, peer, generation: this.generation }; this.check(guard)
    await this.tail; this.check(guard)
    const db = await this.memory.databaseForArchives(), scopes = new Map((db?.archiveScopes(namespaceId) ?? []).map(scope => [scope.topicId, { ...scope, namespaceId }]))
    for (const seat of this.seats.values()) if (seat.scope.namespaceId === namespaceId) scopes.set(seat.scope.topicId, seat.scope)
    const result: { current: TopicArchiveSnapshot; saved: TopicArchiveSnapshot | null }[] = []
    for (const scope of scopes.values()) if ((topicId === undefined || scope.topicId === topicId) && !await this.isRetired(scope)) { const seat = await this.seat(scope); if (seat) result.push({ current: seat.current, saved: seat.saved }) }
    this.check(guard); return structuredClone(result)
  }
  async status(raw: ArchiveRemoteScope): Promise<ArchiveStorageStatus> {
    const scope = parseArchiveRemoteRequest('status', raw) as ArchiveRemoteScope, guard = this.authorize(scope)
    await this.tail; this.check(guard)
    if (await this.isRetired(scope)) { this.check(guard); return this.retiredStatus(scope) }
    const seat = await this.seat(scope); this.check(guard)
    return this.retired.has(key(scope)) ? this.retiredStatus(scope) : this.describe(seat)
  }
  async read(raw: ArchiveReadRequest): Promise<ArchiveReadPage> {
    const request = parseArchiveRemoteRequest('read', raw) as ArchiveReadRequest, guard = this.authorize(request)
    await this.tail
    const seat = await this.current(guard, request.token); this.check(guard)
    if (this.retired.has(key(request))) throw failure('archive_retired', '此主题已删除，档案不可读取或恢复。')
    const text = JSON.stringify(request.layer === 'current' ? seat.current : seat.saved), points = Array.from(text)
    if (request.offset >= points.length) throw failure('archive_range', '档案读取位置已超出当前完整内容。')
    const end = Math.min(points.length, request.offset + ARCHIVE_TRANSFER_POINTS)
    return { text: points.slice(request.offset, end).join(''), nextOffset: end < points.length ? end : null }
  }
  migrateBegin(raw: ArchiveMigrateBegin): Promise<{ readonly transferId: string }> {
    const request = parseArchiveRemoteRequest('migrateBegin', raw) as ArchiveMigrateBegin, guard = this.authorize(request)
    return this.serial(guard, async () => {
      await this.requireOpen(guard)
      if (await this.seat(request)) throw failure('archive_already_switched', '此主题档案已迁入宿主，不接受旧快照覆盖。')
      const id = token()
      for (const [oldId, transfer] of this.transfers) if (key(transfer.guard.scope) === key(request) && transfer.guard.peer === guard.peer) this.transfers.delete(oldId)
      this.transfers.set(id, { id, guard, totals: { current: request.currentPoints, saved: request.storedPoints }, parts: { current: [], saved: [] }, lengths: { current: 0, saved: 0 } })
      return { transferId: id }
    })
  }
  private transfer(request: ArchiveMigrateCommit, guard: Guard): Transfer {
    const transfer = this.transfers.get(request.transferId)
    if (!transfer || transfer.guard.peer !== guard.peer || !same(transfer.guard.scope.namespaceId, guard.scope.namespaceId) || key(transfer.guard.scope) !== key(guard.scope) || transfer.guard.scope.ownerId !== guard.scope.ownerId) throw failure('archive_transfer_missing', '档案迁移暂存已失效，请查询当前宿主状态。')
    this.check(transfer.guard); return transfer
  }
  migratePart(raw: ArchiveMigratePart): Promise<{ readonly nextOffset: number }> {
    const request = parseArchiveRemoteRequest('migratePart', raw) as ArchiveMigratePart, guard = this.authorize(request)
    return this.serial(guard, async () => {
      await this.requireOpen(guard)
      const transfer = this.transfer(request, guard), limit = transfer.totals[request.layer], size = Array.from(request.text).length
      if (limit === null || request.offset + size > limit) throw failure('archive_transfer_range', '档案迁移分片超出声明范围。')
      if (request.offset < transfer.lengths[request.layer]) {
        if (Array.from(transfer.parts[request.layer].join('')).slice(request.offset, request.offset + size).join('') !== request.text) throw failure('archive_transfer_changed', '重试分片与原内容不一致。')
      } else {
        if (request.offset !== transfer.lengths[request.layer]) throw failure('archive_transfer_range', '档案迁移分片不连续。')
        transfer.parts[request.layer].push(request.text); transfer.lengths[request.layer] += size
      }
      return { nextOffset: request.offset + size }
    })
  }
  migrateCommit(raw: ArchiveMigrateCommit): Promise<ArchiveStorageStatus> {
    const request = parseArchiveRemoteRequest('migrateCommit', raw) as ArchiveMigrateCommit, guard = this.authorize(request)
    return this.serial(guard, () => this.writer(async () => {
      await this.requireOpen(guard)
      if (await this.seat(request)) throw failure('archive_already_switched', '宿主已有权威档案，不接受再次导入。')
      const transfer = this.transfer(request, guard)
      if (transfer.lengths.current !== transfer.totals.current || transfer.totals.saved !== null && transfer.lengths.saved !== transfer.totals.saved) throw failure('archive_transfer_incomplete', '档案分片尚未完整取得，旧副本保留。')
      const parse = (layer: 'current' | 'saved'): TopicArchiveSnapshot => {
        const snapshot = decodeTopicArchiveSnapshot(JSON.parse(transfer.parts[layer].join('')))
        if (!snapshot || snapshot.ownerId !== request.ownerId || snapshot.topicId !== request.topicId) throw failure('archive_import_invalid', '旧档案完整内容或所属范围无效，未切换存储。')
        return snapshot
      }
      const current = parse('current'), saved = transfer.totals.saved === null ? null : parse('saved')
      if (saved) {
        const db = await this.memory.databaseForArchives(true); await this.requireOpen(guard)
        db!.transaction(() => {
          db!.archiveSave(request.namespaceId, request.ownerId, request.topicId, saved)
          if (!same(db!.archiveState(request.namespaceId, request.topicId)?.snapshot, saved)) throw failure('archive_import_failed', '宿主档案重读核对未完成，旧副本暂留。')
        })
      }
      const seat: Seat = { scope: guard.scope, current, saved, token: token() }
      this.seats.set(key(request), seat); this.transfers.delete(request.transferId); return this.describe(seat)
    }))
  }
  migrateCancel(raw: ArchiveMigrateCommit): Promise<{ readonly cancelled: true }> {
    const request = parseArchiveRemoteRequest('migrateCancel', raw) as ArchiveMigrateCommit, guard = this.authorize(request)
    return this.serial(guard, async () => { const existing = this.transfers.get(request.transferId); if (existing) { this.transfer(request, guard); this.transfers.delete(request.transferId) }; return { cancelled: true } })
  }
  private evidence(snapshot: TopicArchiveSnapshot, command: ArchiveCommand, values: readonly ArchiveEvidenceState[]): TermEvidenceResolver {
    const target = 'input' in command ? command.input : 'id' in command ? snapshot.entries.find(entry => entry.id === command.id) : undefined
    const dependencies = new Set(target ? referencedEntityIds(target) : [])
    const refs: TermEvidenceRef[] = command.kind === 'reconcile' ? snapshot.entries.filter(entry => entry.origin !== 'user_explicit' && !['disabled', 'review_required'].includes(entry.status)).flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis'))
      : command.kind === 'clear' || command.kind === 'delete' || command.kind === 'disable' ? []
      : [...('input' in command && 'evidence' in command.input ? command.input.evidence.filter(ref => ref.role === 'basis') : []), ...snapshot.entries.filter(entry => dependencies.has(entry.id) && entry.origin !== 'user_explicit').flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis'))]
    const facts = new Map(values.map(value => [termEvidenceKey(snapshot, value.ref), value.status]))
    if (refs.some(ref => !facts.has(termEvidenceKey(snapshot, ref)))) throw failure('archive_evidence_incomplete', '档案依据状态尚未完整取得，请重新读取实际依据。')
    // Archive domain code consumes availability only, never these references' source text.
    return Object.assign(() => undefined, { resolveRef: (scope: { ownerId: string; topicId: string }, ref: TermEvidenceRef) => facts.get(termEvidenceKey(scope, ref)) === 'ready' ? 'available' : undefined,
      isUnloaded: (scope: { ownerId: string; topicId: string }, ref: TermEvidenceRef) => facts.get(termEvidenceKey(scope, ref)) === 'unloaded' })
  }
  mutate(raw: ArchiveMutationRequest): Promise<ArchiveMutationReceipt> {
    const request = parseArchiveRemoteRequest('mutate', raw) as ArchiveMutationRequest, guard = this.authorize(request)
    return this.serial(guard, () => this.writer(async () => {
      if (await this.isRetired(request)) {
        this.check(guard); const status = this.retiredStatus(request)
        if (request.command.kind === 'clear' && request.token === status.token) return { status: 'unchanged', token: status.token!, entryId: null }
        throw failure('archive_retired', '此主题已删除，档案不可恢复。')
      }
      await this.requireOpen(guard)
      const seat = await this.seat(request); this.check(guard)
      if (this.retired.has(key(request))) throw failure('archive_retired', '此主题已删除，档案不可恢复。')
      if (!seat) throw failure('archive_not_initialized', '主题档案尚未完成存储切换。')
      // Gateway intentionally hides exception codes; a CAS conflict is a typed business result.
      if (seat.token !== request.token) return { status: 'stale', token: seat.token, entryId: null }
      const command = request.command, at = stamp(), resolver = this.evidence(seat.current, command, request.evidence)
      const action = { eventId: `archive-user:${crypto.randomUUID()}`, at }
      let result: ArchiveMutationResult
      if (command.kind === 'put') result = putTopicArchive(seat.current, command.input, resolver, at)
      else if (command.kind === 'user_put') result = putUserTopicArchive(seat.current, command.input, resolver, action)
      else if (command.kind === 'accept_file_proposal' || command.kind === 'revise_file_proposal') result = acceptTopicArchiveProposal(seat.current, command.input, resolver, command.acceptance, command.kind === 'revise_file_proposal')
      else if (command.kind === 'adopt') result = adoptTopicArchive(seat.current, command.id, command.expectedEntryVersion, resolver, action)
      else if (command.kind === 'disable') result = disableTopicArchive(seat.current, command.id, command.expectedEntryVersion, at)
      else if (command.kind === 'delete') result = deleteTopicArchiveEntry(seat.current, command.id, command.expectedEntryVersion, at)
      else if (command.kind === 'reconcile') { const next = reconcileTopicArchive(seat.current, resolver, at, ref => resolver.isUnloaded?.(seat.current, ref) === true); result = { status: next === seat.current ? 'unchanged' : 'updated', snapshot: next, entry: null } }
      else {
        const snapshot = { ...emptyTopicArchive(request.ownerId, request.topicId, at), version: Math.max(seat.current.version, seat.saved?.version ?? 0) + 1,
          activeVersion: Math.max(seat.current.activeVersion, seat.saved?.activeVersion ?? 0) + ([...seat.current.entries, ...(seat.saved?.entries ?? [])].some(entry => entry.status === 'active') ? 1 : 0) }
        result = { status: 'updated', snapshot, entry: null }
      }
      if (!['updated', 'unchanged'].includes(result.status)) return { status: result.status, token: seat.token, entryId: result.entry?.id ?? null }
      let saved = seat.saved
      if (command.kind === 'clear') saved = result.snapshot
      else if (command.kind === 'delete') { const old = saved?.entries.find(entry => entry.id === command.id); if (saved && old) saved = deleteTopicArchiveEntry(saved, command.id, old.version, at).snapshot }
      else if (command.kind !== 'reconcile') saved = result.snapshot
      if (!same(saved, seat.saved) || command.kind === 'clear' || command.kind === 'delete') {
        try {
          const db = await this.memory.databaseForArchives(true); await this.requireOpen(guard)
          db!.transaction(() => {
            db!.archiveSave(request.namespaceId, request.ownerId, request.topicId, saved)
            if (command.kind === 'delete') db!.indexRemoveSource(request.namespaceId, request.topicId, `archive:${command.id}`)
            if (command.kind === 'clear') for (const entry of [...seat.current.entries, ...(seat.saved?.entries ?? [])]) db!.indexRemoveSource(request.namespaceId, request.topicId, `archive:${entry.id}`)
          })
        } catch (error) {
          this.check(guard)
          if (this.retired.has(key(request))) throw error
          if (command.kind === 'clear' || command.kind === 'delete') throw error
          // A failed save keeps the accepted edit in the Host runtime overlay, never a Client fallback.
          if (seat.current !== result.snapshot) { seat.current = result.snapshot; seat.token = token() }
          return { status: 'save_failed', token: seat.token, entryId: result.entry?.id ?? null }
        }
      }
      if (result.snapshot !== seat.current || !same(saved, seat.saved)) { seat.current = result.snapshot; seat.saved = saved; seat.token = token() }
      return { status: result.status, token: seat.token, entryId: result.entry?.id ?? null }
    }))
  }
  persist(raw: ArchiveRemoteScope & { readonly token: string }): Promise<ArchiveStorageStatus> {
    const request = parseArchiveRemoteRequest('persist', raw) as typeof raw, guard = this.authorize(request)
    return this.serial(guard, () => this.writer(async () => {
      const seat = await this.current(guard, request.token), db = await this.memory.databaseForArchives(true); await this.requireOpen(guard)
      db!.transaction(() => db!.archiveSave(request.namespaceId, request.ownerId, request.topicId, seat.current))
      if (!same(seat.saved, seat.current)) { seat.saved = seat.current; seat.token = token() }; return this.describe(seat)
    }))
  }
  /** LocalData already owns the storage writer. Permanent no-body identity permits deletion retries. */
  async retireTopicLocked(namespaceId: string, topicId: string): Promise<void> {
    this.retired.set(key({ namespaceId, topicId }), token()); this.seats.delete(key({ namespaceId, topicId }))
    for (const [id, transfer] of this.transfers) if (key(transfer.guard.scope) === key({ namespaceId, topicId })) this.transfers.delete(id)
    const db = await this.memory.databaseForArchives(true)
    db!.transaction(() => { db!.archiveRemove(namespaceId, topicId); db!.indexClear(namespaceId, topicId); db!.retire(namespaceId, topicId) })
  }
  hasActiveJobs(): boolean { return this.pending > 0 }
  async dispose(): Promise<void> { this.disposed = true; this.generation++; await this.tail; this.seats.clear(); this.transfers.clear() }
}
