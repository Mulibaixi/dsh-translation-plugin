import { decodeTopicTermSnapshot, emptyTopicTerms, putTopicTerm, putUserTopicTerm, adoptTopicTerm, acceptTopicTermProposal, disableTopicTerm,
  reconcileTopicTerms, topicTermContentsConflict, alignTopicTermLanguages, type TopicTermSnapshot, type TermMutationResult } from '../memory/topic-terms.js'
import { termEvidenceKey, type TermEvidenceRef, type TermEvidenceResolver } from '../memory/topic-terms.js'
import { TERM_TRANSFER_POINTS, parseTermRemoteRequest, type TermRemoteScope, type TermStorageStatus, type TermHead, type TermReadRequest,
  type TermReadPage, type TermMigrateBegin, type TermMigratePart, type TermMigrateCommit, type TermMutationRequest, type TermMutationReceipt,
  type TermsRemotePort, type TermEvidenceState, type TermCommand } from '../shared/topic-terms-remote.js'
import { newTermId } from '../shared/term-id.js'
import type { OtherMemoryService } from './other-memory.js'
import type { LocalDataService } from './local-data.js'
import type { TopicHostContext, TopicToolsService } from './topic-tools.js'

interface Seat { readonly scope: TermRemoteScope; current: TopicTermSnapshot; saved: TopicTermSnapshot | null; token: string }
interface Guard { readonly scope: TermRemoteScope; readonly peer: string; readonly generation: number }
interface Transfer { readonly guard: Guard; readonly id: string; readonly totals: { current: number; saved: number | null }; readonly parts: { current: string[]; saved: string[] }; readonly lengths: { current: number; saved: number } }
function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
const key = (scope: Pick<TermRemoteScope, 'namespaceId' | 'topicId'>): string => JSON.stringify([scope.namespaceId, scope.topicId])
const stamp = (): string => new Date().toISOString()
const token = (): string => `terms:${crypto.randomUUID()}`
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
function head(snapshot: TopicTermSnapshot | null): TermHead | null { if (!snapshot) return null; const { entries, ...metadata } = snapshot; return { ...metadata, count: entries.length } }

function deleteTopicTermEntry(snapshot: TopicTermSnapshot, id: string, expectedEntryVersion: number, at: string): TermMutationResult {
  const entry = snapshot.entries.find(item => item.id === id) ?? null
  if (!entry || entry.version !== expectedEntryVersion) return { status: 'stale', snapshot, entry }
  return { status: 'updated', snapshot: { ...snapshot, entries: snapshot.entries.filter(item => item.id !== id), version: snapshot.version + 1,
    activeVersion: snapshot.activeVersion + (entry.status === 'active' ? 1 : 0), updatedAt: at }, entry: null }
}

/** Commands are executed here; Client transports legacy input once and thereafter caches reads only. */
export class TopicTermsService implements TermsRemotePort {
  readonly typertRemote: { readonly service: TopicTermsService; readonly serviceKey: 'translationTerms'; readonly namespace: 'translationTerms' } = { service: this, serviceKey: 'translationTerms', namespace: 'translationTerms' }
  private readonly seats = new Map<string, Seat>()
  private readonly transfers = new Map<string, Transfer>()
  private readonly retired = new Map<string, string>()
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false
  private generation = 0
  private pending = 0
  constructor(private readonly ctx: TopicHostContext, private readonly memory: OtherMemoryService) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationTerms', property: 'ctx' } })
  }
  private authorize(scope: TermRemoteScope): Guard {
    const peer = this.ctx.invocation?.peer.id
    if (!peer || this.disposed || !(this.ctx.get?.('translationTopics') as TopicToolsService | undefined)?.ownsLibrary(scope.namespaceId, peer)) throw failure('scope_mismatch', '主题术语操作不属于此资料库连接。')
    return { scope, peer, generation: this.generation }
  }
  private check(guard: Guard): void {
    if (this.disposed || guard.generation !== this.generation) throw failure('terms_closed', '主题术语存储已关闭，迟到操作已停止。')
    if (!(this.ctx.get?.('translationTopics') as TopicToolsService | undefined)?.ownsLibrary(guard.scope.namespaceId, guard.peer)) throw failure('scope_mismatch', '资料库连接已变化。')
  }
  private async isRetired(scope: TermRemoteScope): Promise<boolean> { return this.retired.has(key(scope)) || (await this.memory.databaseForArchives())?.retired(scope.namespaceId, scope.topicId) === true }
  private async requireOpen(guard: Guard): Promise<void> { this.check(guard); if (await this.isRetired(guard.scope)) throw failure('terms_retired', '此主题已删除，术语不可读取或恢复。'); this.check(guard) }
  private retiredStatus(scope: TermRemoteScope): TermStorageStatus {
    let value = this.retired.get(key(scope)); if (!value) { value = token(); this.retired.set(key(scope), value) }
    return { switched: true, token: value, current: head(emptyTopicTerms(scope.ownerId, scope.topicId, '1970-01-01T00:00:00.000Z')), saved: null, persistence: 'saved', retired: true }
  }
  private async seat(scope: TermRemoteScope): Promise<Seat | undefined> {
    const known = this.seats.get(key(scope))
    if (known) { if (known.scope.ownerId !== scope.ownerId) throw failure('scope_mismatch', '主题术语所属身份不一致。'); return known }
    const stored = (await this.memory.databaseForArchives())?.termsState(scope.namespaceId, scope.topicId)
    if (!stored) return undefined
    if (stored.ownerId !== scope.ownerId) throw failure('scope_mismatch', '已保存主题术语所属身份不一致。')
    const seat: Seat = { scope, current: stored.snapshot ?? emptyTopicTerms(scope.ownerId, scope.topicId, stamp()), saved: stored.snapshot, token: token() }
    this.seats.set(key(scope), seat); return seat
  }
  private describe(seat: Seat | undefined): TermStorageStatus {
    return seat ? { switched: true, token: seat.token, current: head(seat.current), saved: head(seat.saved), persistence: same(seat.current, seat.saved) ? 'saved' : 'runtime_only' }
      : { switched: false, token: null, current: null, saved: null, persistence: 'runtime_only' }
  }
  private async current(guard: Guard, expected: string): Promise<Seat> {
    await this.requireOpen(guard)
    const seat = await this.seat(guard.scope); this.check(guard)
    if (this.retired.has(key(guard.scope))) throw failure('terms_retired', '此主题已删除，术语不可读取或恢复。')
    if (!seat || seat.token !== expected) throw failure('terms_stale', '主题术语已变化，请读取最新副本后重试。')
    return seat
  }
  private serial<T>(guard: Guard, run: () => Promise<T>): Promise<T> {
    this.pending++
    const result = this.tail.then(() => { this.check(guard); return run() }); this.tail = result.catch(() => {})
    return result.finally(() => { this.pending-- })
  }
  private writer<T>(run: () => Promise<T>): Promise<T> { return ((this.ctx.get?.('translationLocalData') as LocalDataService | undefined)?.storageWriter() ?? (async <R>(f: () => Promise<R>): Promise<R> => f()))(run) }
  async status(raw: TermRemoteScope): Promise<TermStorageStatus> {
    const scope = parseTermRemoteRequest('status', raw) as TermRemoteScope, guard = this.authorize(scope)
    await this.tail; this.check(guard)
    if (await this.isRetired(scope)) { this.check(guard); return this.retiredStatus(scope) }
    const seat = await this.seat(scope); this.check(guard)
    return this.retired.has(key(scope)) ? this.retiredStatus(scope) : this.describe(seat)
  }
  async read(raw: TermReadRequest): Promise<TermReadPage> {
    const request = parseTermRemoteRequest('read', raw) as TermReadRequest, guard = this.authorize(request)
    await this.tail
    const seat = await this.current(guard, request.token); this.check(guard)
    if (this.retired.has(key(request))) throw failure('terms_retired', '此主题已删除，术语不可读取或恢复。')
    const text = JSON.stringify(request.layer === 'current' ? seat.current : seat.saved), points = Array.from(text)
    if (request.offset >= points.length) throw failure('terms_range', '术语读取位置已超出当前完整内容。')
    const end = Math.min(points.length, request.offset + TERM_TRANSFER_POINTS)
    return { text: points.slice(request.offset, end).join(''), nextOffset: end < points.length ? end : null }
  }
  migrateBegin(raw: TermMigrateBegin): Promise<{ readonly transferId: string }> {
    const request = parseTermRemoteRequest('migrateBegin', raw) as TermMigrateBegin, guard = this.authorize(request)
    return this.serial(guard, async () => {
      await this.requireOpen(guard)
      if (await this.seat(request)) throw failure('terms_already_switched', '此主题术语已迁入宿主，不接受旧快照覆盖。')
      const id = token()
      for (const [oldId, transfer] of this.transfers) if (key(transfer.guard.scope) === key(request) && transfer.guard.peer === guard.peer) this.transfers.delete(oldId)
      this.transfers.set(id, { id, guard, totals: { current: request.currentPoints, saved: request.storedPoints }, parts: { current: [], saved: [] }, lengths: { current: 0, saved: 0 } })
      return { transferId: id }
    })
  }
  private transfer(request: TermMigrateCommit, guard: Guard): Transfer {
    const transfer = this.transfers.get(request.transferId)
    if (!transfer || transfer.guard.peer !== guard.peer || !same(transfer.guard.scope.namespaceId, guard.scope.namespaceId) || key(transfer.guard.scope) !== key(guard.scope) || transfer.guard.scope.ownerId !== guard.scope.ownerId) throw failure('terms_transfer_missing', '术语迁移暂存已失效，请查询当前宿主状态。')
    this.check(transfer.guard); return transfer
  }
  migratePart(raw: TermMigratePart): Promise<{ readonly nextOffset: number }> {
    const request = parseTermRemoteRequest('migratePart', raw) as TermMigratePart, guard = this.authorize(request)
    return this.serial(guard, async () => {
      await this.requireOpen(guard)
      const transfer = this.transfer(request, guard), limit = transfer.totals[request.layer], size = Array.from(request.text).length
      if (limit === null || request.offset + size > limit) throw failure('terms_transfer_range', '术语迁移分片超出声明范围。')
      if (request.offset < transfer.lengths[request.layer]) {
        if (Array.from(transfer.parts[request.layer].join('')).slice(request.offset, request.offset + size).join('') !== request.text) throw failure('terms_transfer_changed', '重试分片与原内容不一致。')
      } else {
        if (request.offset !== transfer.lengths[request.layer]) throw failure('terms_transfer_range', '术语迁移分片不连续。')
        transfer.parts[request.layer].push(request.text); transfer.lengths[request.layer] += size
      }
      return { nextOffset: request.offset + size }
    })
  }
  migrateCommit(raw: TermMigrateCommit): Promise<TermStorageStatus> {
    const request = parseTermRemoteRequest('migrateCommit', raw) as TermMigrateCommit, guard = this.authorize(request)
    return this.serial(guard, () => this.writer(async () => {
      await this.requireOpen(guard)
      if (await this.seat(request)) throw failure('terms_already_switched', '宿主已有权威术语，不接受再次导入。')
      const transfer = this.transfer(request, guard)
      if (transfer.lengths.current !== transfer.totals.current || transfer.totals.saved !== null && transfer.lengths.saved !== transfer.totals.saved) throw failure('terms_transfer_incomplete', '术语分片尚未完整取得，旧副本保留。')
      const parse = (layer: 'current' | 'saved'): TopicTermSnapshot => {
        const snapshot = decodeTopicTermSnapshot(JSON.parse(transfer.parts[layer].join('')))
        if (!snapshot || snapshot.ownerId !== request.ownerId || snapshot.topicId !== request.topicId) throw failure('terms_import_invalid', '旧术语完整内容或所属范围无效，未切换存储。')
        return snapshot
      }
      const current = parse('current'), saved = transfer.totals.saved === null ? null : parse('saved')
      if (saved) {
        const db = await this.memory.databaseForArchives(true); await this.requireOpen(guard)
        db!.transaction(() => {
          db!.termsSave(request.namespaceId, request.ownerId, request.topicId, saved)
          if (!same(db!.termsState(request.namespaceId, request.topicId)?.snapshot, saved)) throw failure('terms_import_failed', '宿主术语重读核对未完成，旧副本暂留。')
        })
      }
      const seat: Seat = { scope: guard.scope, current, saved, token: token() }
      this.seats.set(key(request), seat); this.transfers.delete(request.transferId); return this.describe(seat)
    }))
  }
  migrateCancel(raw: TermMigrateCommit): Promise<{ readonly cancelled: true }> {
    const request = parseTermRemoteRequest('migrateCancel', raw) as TermMigrateCommit, guard = this.authorize(request)
    return this.serial(guard, async () => { const existing = this.transfers.get(request.transferId); if (existing) { this.transfer(request, guard); this.transfers.delete(request.transferId) }; return { cancelled: true } })
  }
  private evidence(snapshot: TopicTermSnapshot, command: TermCommand, values: readonly TermEvidenceState[]): TermEvidenceResolver {
    const fileProposal = command.kind === 'accept_file_proposal' || command.kind === 'revise_file_proposal'
    const input = command.kind === 'put' ? { ...command.input, ...alignTopicTermLanguages(snapshot, command.input) } : fileProposal ? command.input : undefined
    const refs: TermEvidenceRef[] = command.kind === 'reconcile' ? snapshot.entries.filter(entry => entry.origin !== 'user_explicit' && !['disabled', 'review_required'].includes(entry.status)).flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis'))
      : input ? [...input.evidence.filter(ref => ref.role === 'basis'), ...snapshot.entries.filter(entry =>
        (fileProposal || input.status === 'active') && entry.id !== input.id && entry.status === 'active' && entry.origin !== 'user_explicit' &&
        topicTermContentsConflict(entry, input)).flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis'))] : []
    const facts = new Map(values.map(value => [termEvidenceKey(snapshot, value.ref), value.status]))
    if (refs.some(ref => !facts.has(termEvidenceKey(snapshot, ref)))) throw failure('terms_evidence_incomplete', '术语依据状态尚未完整取得，请重新读取实际依据。')
    // Term domain code consumes availability only, never these references' source text.
    return Object.assign(() => undefined, { resolveRef: (scope: { ownerId: string; topicId: string }, ref: TermEvidenceRef) => facts.get(termEvidenceKey(scope, ref)) === 'ready' ? 'available' : undefined,
      isUnloaded: (scope: { ownerId: string; topicId: string }, ref: TermEvidenceRef) => facts.get(termEvidenceKey(scope, ref)) === 'unloaded' })
  }
  mutate(raw: TermMutationRequest): Promise<TermMutationReceipt> {
    const request = parseTermRemoteRequest('mutate', raw) as TermMutationRequest, guard = this.authorize(request)
    return this.serial(guard, () => this.writer(async () => {
      if (await this.isRetired(request)) {
        this.check(guard); const status = this.retiredStatus(request)
        if (request.command.kind === 'clear' && request.token === status.token) return { status: 'unchanged', token: status.token!, entryId: null }
        throw failure('terms_retired', '此主题已删除，术语不可恢复。')
      }
      await this.requireOpen(guard)
      const seat = await this.seat(request); this.check(guard)
      if (this.retired.has(key(request))) throw failure('terms_retired', '此主题已删除，术语不可恢复。')
      if (!seat) throw failure('terms_not_initialized', '主题术语尚未完成存储切换。')
      // Gateway intentionally hides exception codes; a CAS conflict is a typed business result.
      if (seat.token !== request.token) return { status: 'stale', token: seat.token, entryId: null }
      const command = request.command, at = stamp(), resolver = this.evidence(seat.current, command, request.evidence)
      const action = { eventId: `terms-user:${crypto.randomUUID()}`, at }
      let result: TermMutationResult
      if (command.kind === 'put') result = putTopicTerm(seat.current, command.input, resolver, at, newTermId)
      else if (command.kind === 'user_put') result = putUserTopicTerm(seat.current, command.input, action)
      else if (command.kind === 'accept_file_proposal' || command.kind === 'revise_file_proposal') result = acceptTopicTermProposal(seat.current, command.input, resolver, command.acceptance, command.kind === 'revise_file_proposal')
      else if (command.kind === 'adopt') result = adoptTopicTerm(seat.current, command.id, command.expectedEntryVersion, action)
      else if (command.kind === 'disable') result = disableTopicTerm(seat.current, command.id, command.expectedEntryVersion, at)
      else if (command.kind === 'delete') result = deleteTopicTermEntry(seat.current, command.id, command.expectedEntryVersion, at)
      else if (command.kind === 'reconcile') { const next = reconcileTopicTerms(seat.current, resolver, at, ref => resolver.isUnloaded?.(seat.current, ref) === true); result = { status: next === seat.current ? 'unchanged' : 'updated', snapshot: next, entry: null } }
      else {
        const snapshot = { ...emptyTopicTerms(request.ownerId, request.topicId, at), version: Math.max(seat.current.version, seat.saved?.version ?? 0) + 1,
          activeVersion: Math.max(seat.current.activeVersion, seat.saved?.activeVersion ?? 0) + ([...seat.current.entries, ...(seat.saved?.entries ?? [])].some(entry => entry.status === 'active') ? 1 : 0) }
        result = { status: 'updated', snapshot, entry: null }
      }
      if (!['updated', 'unchanged'].includes(result.status)) return { status: result.status, token: seat.token, entryId: result.entry?.id ?? null }
      let saved = seat.saved
      if (command.kind === 'clear') saved = result.snapshot
      else if (command.kind === 'delete') { const old = saved?.entries.find(entry => entry.id === command.id); if (saved && old) saved = deleteTopicTermEntry(saved, command.id, old.version, at).snapshot }
      else if (request.rememberHistory) saved = result.snapshot
      if (!same(saved, seat.saved) || command.kind === 'clear' || command.kind === 'delete') {
        try {
          const db = await this.memory.databaseForArchives(true); await this.requireOpen(guard)
          db!.transaction(() => db!.termsSave(request.namespaceId, request.ownerId, request.topicId, saved))
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
  persist(raw: TermRemoteScope & { readonly token: string }): Promise<TermStorageStatus> {
    const request = parseTermRemoteRequest('persist', raw) as typeof raw, guard = this.authorize(request)
    return this.serial(guard, () => this.writer(async () => {
      const seat = await this.current(guard, request.token), db = await this.memory.databaseForArchives(true); await this.requireOpen(guard)
      db!.transaction(() => db!.termsSave(request.namespaceId, request.ownerId, request.topicId, seat.current))
      if (!same(seat.saved, seat.current)) { seat.saved = seat.current; seat.token = token() }; return this.describe(seat)
    }))
  }
  persistNamespace(raw: { readonly namespaceId: string }): Promise<{ readonly persisted: true }> {
    const request = parseTermRemoteRequest('persistNamespace', raw) as typeof raw
    // Namespace-wide policy changes have no topic routing or Client body payload.
    const guard = this.authorize({ namespaceId: request.namespaceId, ownerId: request.namespaceId, topicId: '*' })
    return this.serial(guard, () => this.writer(async () => {
      this.check(guard)
      const candidates: Seat[] = []
      for (const seat of this.seats.values()) if (seat.scope.namespaceId === request.namespaceId && !same(seat.current, seat.saved) &&
        !(seat.saved === null && seat.current.version === 0 && seat.current.entries.length === 0) && !await this.isRetired(seat.scope)) candidates.push(seat)
      this.check(guard)
      if (!candidates.length) return { persisted: true as const }
      const db = await this.memory.databaseForArchives(true); this.check(guard)
      const live = candidates.filter(seat => this.seats.get(key(seat.scope)) === seat && !this.retired.has(key(seat.scope)) && !db!.retired(seat.scope.namespaceId, seat.scope.topicId))
      db!.transaction(() => { for (const seat of live) db!.termsSave(seat.scope.namespaceId, seat.scope.ownerId, seat.scope.topicId, seat.current) })
      for (const seat of live) { seat.saved = seat.current; seat.token = token() }
      return { persisted: true as const }
    }))
  }
  /** LocalData already owns the storage writer. Permanent no-body identity permits deletion retries. */
  async retireTopicLocked(namespaceId: string, topicId: string): Promise<void> {
    this.retired.set(key({ namespaceId, topicId }), token()); this.seats.delete(key({ namespaceId, topicId }))
    for (const [id, transfer] of this.transfers) if (key(transfer.guard.scope) === key({ namespaceId, topicId })) this.transfers.delete(id)
    const db = await this.memory.databaseForArchives(true)
    db!.transaction(() => { db!.termsRemove(namespaceId, topicId); db!.retire(namespaceId, topicId) })
  }
  hasActiveJobs(): boolean { return this.pending > 0 }
  async dispose(): Promise<void> { this.disposed = true; this.generation++; await this.tail; this.seats.clear(); this.transfers.clear() }
}
