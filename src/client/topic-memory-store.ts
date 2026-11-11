import { browserPluginStorage, isPluginStorageEvent } from './storage-fence.js'
import { emptyTopicTerms, decodeTopicTermSnapshot, decodeTopicTermPut, decodeTopicTermUserInput, queryTopicTerms, topicTermContentsConflict, alignTopicTermLanguages,
  type TopicTermSnapshot, type TopicTermPut, type TopicTermUserInput, type TopicTermUserPut, type TermMutationResult, type TopicTermQuery } from '../memory/topic-terms.js'
import { resolveTermEvidence, termEvidenceKey, type TermEvidenceRef, type TermEvidenceResolver, type TermEvidenceFact, type FileProposalAcceptance } from '../memory/topic-terms.js'
import { parseTermStorageStatus, type TermRemoteScope, type TermStorageStatus, type TermCommand, type TermEvidenceState, type TermMutationReceipt } from '../shared/topic-terms-remote.js'
import type { SessionStore, LocalStoragePort, StructureLockPort, HistoryStatus, HistoryVersion } from './session-store.js'
import { diagnosticSpan } from '../shared/diagnostics.js'
import { captureTopicEvidenceCurrent, isTopicEvidenceUnloaded, prepareTopicEvidence } from './topic-evidence.js'
import { TranslationSourceReader, type TranslationEvidenceReader } from './source-reader.js'
import type { EvidenceReadResult } from '../shared/translation-evidence.js'
import { currentFinalRevision, isTextUnit } from './translation-history.js'
import { newTermId } from '../shared/term-id.js'
import { termReply, termScopeMatches, readTermSnapshot, transferTermMigration, type TopicTermsRemotePort } from './topic-terms-transport.js'
import { TOPIC_LOCK_NAME } from './topics.js'

export type { TopicTermsRemotePort } from './topic-terms-transport.js'
export const TOPIC_TERMS_PREFIX = 'dsh-translation-plugin:topic-terms:v1:'
export function topicTermsKey(topicId: string): string { return `${TOPIC_TERMS_PREFIX}${encodeURIComponent(topicId)}` }
export interface TopicTermVersion { readonly ownerId: string; readonly topicId: string; readonly token: string }
export interface TopicTermClearVersion extends TopicTermVersion {
  readonly storageAvailable: boolean
  readonly version: number; readonly currentCount: number; readonly storedCount: number
}
export type TopicTermCommand = { readonly kind: 'put'; readonly input: TopicTermPut }
  | { readonly kind: 'delete'; readonly id: string; readonly expectedEntryVersion: number }
  | { readonly kind: 'accept_file_proposal' | 'revise_file_proposal'; readonly input: TopicTermPut; readonly acceptance: FileProposalAcceptance }
  | { readonly kind: 'user_put'; readonly input: TopicTermUserPut }
  | { readonly kind: 'adopt' | 'disable'; readonly id: string; readonly expectedEntryVersion: number }
export interface TopicTermReadState { readonly status: 'idle' | 'loading' | 'ready' | 'error'; readonly snapshot?: TopicTermSnapshot; readonly error?: string; readonly retired?: true }
interface Seat {
  readonly scope: TermRemoteScope; revision: number; state: TopicTermReadState; snapshot?: TopicTermSnapshot
  storage?: TermStorageStatus; loading?: Promise<TopicTermSnapshot>; refs: number; reconcileQueued: boolean
  tail?: Promise<unknown>
  saveFailed?: true
  legacyCleanupPending?: true
}
const now = (): string => new Date().toISOString()
function browserLocks(): StructureLockPort | undefined {
  if (typeof navigator === 'undefined' || !navigator.locks) return undefined
  return { request: async <T>(name: string, action: () => T | Promise<T>): Promise<T> => await navigator.locks.request(name, async () => await action()) }
}

/** Host owns every migrated topic term. Browser storage is read once only as a migration source. */
export class TopicMemoryStore {
  private readonly seats = new Map<string, Seat>()
  private readonly listeners = new Set<() => void>()
  private readonly stopSession: () => void
  private readonly stopStorage: (() => void) | undefined
  private disposed = false
  private epoch = 0
  private notice: string | undefined
  private evidenceReader: TranslationEvidenceReader | undefined
  private readonly pausedReconciliation = new Set<string>()
  private readonly resolver: TermEvidenceResolver = (sessionId, unitId) => this.readEvidence(sessionId, unitId)
  constructor(private readonly sessions: SessionStore, private readonly storage: LocalStoragePort | undefined = browserPluginStorage(),
    listen?: (onChange: (key: string | null) => void) => () => void, private readonly locks: StructureLockPort | undefined = browserLocks(), private supplementaryEvidence?: TermEvidenceResolver,
    private readonly options: { readonly remote?: () => Promise<TopicTermsRemotePort | undefined> } = {}) {
    this.stopSession = sessions.subscribe(() => this.sessionChanged())
    const change = (key: string | null): void => { if (key === null || key.startsWith(TOPIC_TERMS_PREFIX)) this.emit() }
    if (listen) this.stopStorage = listen(change)
    else if (typeof window !== 'undefined' && storage) {
      const changed = (event: StorageEvent): void => { if (isPluginStorageEvent(event, storage)) change(event.key) }
      window.addEventListener('storage', changed); this.stopStorage = () => window.removeEventListener('storage', changed)
    }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  getNotice(): string | undefined { return this.notice }
  setEvidenceReader(reader: TranslationEvidenceReader | undefined): void { this.evidenceReader = reader }
  setSupplementaryEvidenceResolver(resolver: TermEvidenceResolver): void { this.supplementaryEvidence = resolver }
  isSnapshotCurrent(snapshot: TopicTermSnapshot): boolean {
    const seat = this.seats.get(snapshot.topicId)
    return this.available(snapshot.topicId) && seat?.state.status === 'ready' && !seat.storage?.retired &&
      seat.snapshot?.ownerId === snapshot.ownerId && JSON.stringify(seat.snapshot) === JSON.stringify(snapshot)
  }
  async isSnapshotCurrentAsync(snapshot: TopicTermSnapshot): Promise<boolean> {
    if (!this.isSnapshotCurrent(snapshot)) return false
    const seat = this.seats.get(snapshot.topicId)!, token = seat.storage?.token, epoch = this.epoch
    try {
      const remote = await this.remote(), status = parseTermStorageStatus(termReply(await remote.status(seat.scope)))
      const current = this.epoch === epoch && status.token === token && !status.retired && this.isSnapshotCurrent(snapshot)
      if (!current && this.epoch === epoch && this.available(snapshot.topicId) && seat.storage?.token === token) {
        seat.revision++; seat.state = { status: 'error', ...(seat.snapshot ? { snapshot: seat.snapshot } : {}), error: '主题术语已变化，请读取最新内容。' }; this.emit()
      }
      return current
    } catch { return false }
  }
  readEvidenceAvailability(ownerId: string, topicId: string, ref: TermEvidenceRef): 'ready' | 'unloaded' | 'unavailable' {
    ownerId = this.sessions.getTopicStorageScope(topicId) ?? ownerId
    if (isTopicEvidenceUnloaded(this.sessions, { ownerId, topicId }, ref)) return 'unloaded'
    return resolveTermEvidence({ ownerId, topicId }, ref, (sessionId, unitId) => this.readEvidence(sessionId, unitId)) !== undefined ? 'ready' : 'unavailable'
  }
  /** Explicit UI range reads use the same identity and bounds as mutation evidence. */
  async readEvidenceAsync(ownerId: string, topicId: string, ref: TermEvidenceRef): Promise<EvidenceReadResult> {
    ownerId = this.sessions.getTopicStorageScope(topicId) ?? ownerId
    const reader = this.evidenceReader ?? new TranslationSourceReader({ sessions: this.sessions })
    const captured = reader.capture(ownerId, topicId, structuredClone(ref))
    if ('status' in captured) return captured
    try { return await reader.read(captured) }
    catch { return { status: 'unloaded', request: captured, reason: 'transport_unavailable' } }
  }
  readEvidence(sessionId: string, unitId: string): TermEvidenceFact | undefined {
    const supplementary = this.supplementaryEvidence?.(sessionId, unitId)
    if (supplementary) return supplementary
    const session = this.sessions.getSession(sessionId), history = this.sessions.getTranslationHistory(sessionId)
    if (!session || !history || this.sessions.isSessionDeleted(sessionId) || this.sessions.getStatus(sessionId) === 'conflict') return undefined
    const unit = history.units.find(unit => unit.id === unitId)
    if (!unit || !isTextUnit(unit) || unit.deletion) return undefined
    const revision = currentFinalRevision(unit)
    const event = [...history.events].reverse().find(event => event.type === 'final.selected' && event.unitId === unit.id)
    return { ownerId: this.sessions.getTopicStorageScope(session.topicId)!, topicId: session.topicId, sourceVersion: unit.sourceVersion, source: unit.source,
      final: revision && event?.revisionId === revision.id ? { revisionId: revision.id, selectionEventId: event.id, sourceVersion: unit.sourceVersion, text: revision.text } : null }
  }
  private available(topicId: string): boolean { return !this.disposed && !this.sessions.isTopicDeleted(topicId) && this.sessions.getTopics().some(topic => topic.id === topicId) }
  private seat(ownerId: string, topicId: string): Seat {
    if (!this.available(topicId)) throw new Error('主题不存在、已删除或术语服务已关闭。')
    ownerId = this.sessions.getTopicStorageScope(topicId) ?? ownerId
    let seat = this.seats.get(topicId)
    if (!seat) { seat = { scope: { namespaceId: this.sessions.getNamespaceId(), ownerId, topicId }, revision: 0, state: { status: 'idle' }, refs: 0, reconcileQueued: false }; this.seats.set(topicId, seat) }
    if (seat.scope.ownerId !== ownerId) throw new Error('主题术语作用域不匹配。')
    return seat
  }
  getReadState(ownerId: string, topicId: string): TopicTermReadState {
    try { return this.seat(ownerId, topicId).state } catch (error) { return { status: 'error', error: (error as Error).message } }
  }
  getStatus(ownerId: string, topicId: string): HistoryStatus {
    const seat = this.seat(ownerId, topicId)
    return seat.state.status !== 'ready' || seat.saveFailed ? 'error' : seat.storage?.persistence === 'saved' ? 'saved' : 'memory'
  }
  getSnapshot(ownerId: string, topicId: string): TopicTermSnapshot {
    const seat = this.seat(ownerId, topicId)
    if (seat.state.status !== 'ready' || !seat.snapshot) throw new Error(seat.state.error ?? '主题术语尚未读取，请等待加载完成。')
    return seat.snapshot
  }
  retain(ownerId: string, topicId: string): () => void {
    const seat = this.seat(ownerId, topicId); seat.refs++
    void this.ensureLoaded(ownerId, topicId).catch(() => {})
    let released = false
    return () => { if (released) return; released = true; seat.refs--; if (seat.refs === 0) { seat.revision++; delete seat.snapshot; delete seat.loading; seat.state = { status: 'idle' } } }
  }
  async ensureLoaded(ownerId: string, topicId: string): Promise<TopicTermSnapshot> {
    const seat = this.seat(ownerId, topicId)
    if (seat.state.status === 'ready' && seat.snapshot) return seat.snapshot
    return seat.loading ?? this.refresh(ownerId, topicId)
  }
  private async remote(): Promise<TopicTermsRemotePort> {
    const remote = await this.options.remote?.()
    if (!remote || this.disposed) throw new Error('主题术语服务尚未就绪，请检查资料库连接后重试。')
    return remote
  }
  private cleanupLegacy(topicId: string, raw: string | null): boolean {
    if (raw === null || !this.storage) return true
    try {
      if (this.storage.getItem(topicTermsKey(topicId)) !== raw) throw new Error('legacy changed')
      this.storage.removeItem(topicTermsKey(topicId)); return true
    } catch { this.notice = '主题术语已迁移至新存储，旧浏览器副本暂未清理；刷新可重试，不会回退旧副本。'; return false }
  }
  private retryLegacyCleanup(seat: Seat): boolean {
    let cleaned = false
    try { cleaned = this.cleanupLegacy(seat.scope.topicId, this.storage?.getItem(topicTermsKey(seat.scope.topicId)) ?? null) }
    catch { this.notice = '主题术语已迁移至新存储，旧浏览器副本暂未清理；可刷新重试。' }
    if (cleaned) {
      const wasPending = seat.legacyCleanupPending
      delete seat.legacyCleanupPending
      if (wasPending && this.notice?.includes('旧浏览器副本') && ![...this.seats.values()].some(value => value.legacyCleanupPending)) this.notice = undefined
    }
    else seat.legacyCleanupPending = true
    return cleaned
  }
  private async migrateLegacy(remote: TopicTermsRemotePort, seat: Seat, current: () => boolean): Promise<TermStorageStatus> {
    const migrate = async (): Promise<TermStorageStatus> => {
      if (!current()) throw new Error('主题术语迁移已经失效。')
      const before = parseTermStorageStatus(termReply(await remote.status(seat.scope)))
      if (before.switched) return before
      if (this.sessions.isTopicDeleting(seat.scope.topicId)) throw new Error('主题正在删除，不能初始化或迁移术语。')
      const raw = this.storage?.getItem(topicTermsKey(seat.scope.topicId)) ?? null
      let saved: TopicTermSnapshot | null | undefined = null
      try { saved = raw === null ? null : decodeTopicTermSnapshot(JSON.parse(raw)) } catch { throw new Error('旧版主题术语无法读取，原副本已保留，尚未迁移。') }
      if (raw !== null && (!saved || !termScopeMatches(saved, seat.scope))) throw new Error('旧版主题术语无法读取，原副本已保留，尚未迁移。')
      const snapshot = saved ?? emptyTopicTerms(seat.scope.ownerId, seat.scope.topicId, now())
      const committed = await transferTermMigration(remote, seat.scope, snapshot, saved ?? null, current)
      const checked = parseTermStorageStatus(termReply(await remote.status(seat.scope)))
      if (!checked.switched || checked.token !== committed.token) throw new Error('主题术语迁移结果已变化，请重新读取核对。')
      const confirmed = await readTermSnapshot(remote, seat.scope, checked, 'current', current)
      const confirmedSaved = await readTermSnapshot(remote, seat.scope, checked, 'saved', current)
      if (JSON.stringify(confirmed) !== JSON.stringify(snapshot) || JSON.stringify(confirmedSaved) !== JSON.stringify(saved ?? null)) throw new Error('主题术语迁移读回不一致，旧副本已保留。')
      if (!current()) throw new Error('主题术语迁移已经失效。')
      if (!this.cleanupLegacy(seat.scope.topicId, raw)) seat.legacyCleanupPending = true
      return checked
    }
    if (this.locks) return this.locks.request(TOPIC_LOCK_NAME, migrate)
    if (this.storage?.getItem(topicTermsKey(seat.scope.topicId)) != null) throw new Error('旧版术语迁移需要主题存储锁，原副本已保留。')
    return migrate()
  }
  async refresh(ownerId: string, topicId: string): Promise<TopicTermSnapshot> {
    const seat = this.seat(ownerId, topicId), revision = ++seat.revision, epoch = this.epoch
    const current = (): boolean => this.epoch === epoch && seat.revision === revision && this.available(topicId)
    seat.state = { status: 'loading', ...(seat.snapshot ? { snapshot: seat.snapshot } : {}) }; this.emit()
    const load = (async (): Promise<TopicTermSnapshot> => {
      try {
        const remote = await this.remote()
        if (!current()) throw new Error('主题术语读取已经失效。')
        let status = parseTermStorageStatus(termReply(await remote.status(seat.scope)))
        if (!current()) throw new Error('主题术语读取已经失效。')
        if (status.retired) {
          const head = status.current!
          const snapshot: TopicTermSnapshot = { schemaVersion: head.schemaVersion, ownerId: head.ownerId, topicId: head.topicId, version: head.version, activeVersion: head.activeVersion, updatedAt: head.updatedAt, entries: [] }
          if (!termScopeMatches(snapshot, seat.scope) || head.count !== 0) throw new Error('退役术语范围不匹配。')
          seat.snapshot = snapshot; seat.storage = status; seat.state = { status: 'ready', snapshot, retired: true }
          this.retryLegacyCleanup(seat); this.emit(); return snapshot
        }
        if (!status.switched) {
          status = await this.migrateLegacy(remote, seat, current)
        }
        let snapshot = await readTermSnapshot(remote, seat.scope, status, 'current', current)
        if (!current()) throw new Error('主题术语读取已经失效。')
        if (!snapshot || !status.token) throw new Error('主题术语读取未完成，不能将其视为空术语。')
        if (!this.sessions.isTopicDeleting(topicId)) {
          // Reading old evidence may invalidate the runtime projection, never its saved historical copy.
          const refs = [...new Map(this.commandRefs(snapshot, { kind: 'reconcile' }).map(ref => [termEvidenceKey(snapshot!, ref), ref])).values()]
          const resolver = this.resolver, evidenceCurrent = captureTopicEvidenceCurrent(this.sessions, snapshot, refs, resolver)
          const evidence: TermEvidenceState[] = refs.map(ref => ({ ref, status: resolveTermEvidence(snapshot!, ref, resolver) !== undefined ? 'ready' : isTopicEvidenceUnloaded(this.sessions, snapshot!, ref) ? 'unloaded' : 'missing' }))
          const receipt = termReply<TermMutationReceipt>(await remote.mutate({ ...seat.scope, token: status.token, command: { kind: 'reconcile' }, evidence }))
          if (!current() || !evidenceCurrent()) throw new Error('术语依据在读取期间变化，请重新读取。')
          if (receipt.token !== status.token) {
            status = parseTermStorageStatus(termReply(await remote.status(seat.scope)))
            if (receipt.token !== status.token) throw new Error('术语在读取期间变化，请重新读取。')
            snapshot = await readTermSnapshot(remote, seat.scope, status, 'current', current)
            if (!snapshot) throw new Error('术语复核结果尚未读取。')
          }
        }
        if (!current()) throw new Error('主题术语读取已经失效。')
        seat.snapshot = snapshot; seat.storage = status; seat.state = { status: 'ready', snapshot }
        this.retryLegacyCleanup(seat)
        this.emit(); return snapshot
      } catch (error) {
        if (current()) { seat.state = { status: 'error', ...(seat.snapshot ? { snapshot: seat.snapshot } : {}), error: (error as Error).message }; this.emit() }
        throw error
      } finally { if (current()) delete seat.loading }
    })()
    seat.loading = load
    return load
  }
  reloadAsync(ownerId: string, topicId: string): Promise<TopicTermSnapshot> { return this.refresh(ownerId, topicId) }
  async reload(ownerId: string, topicId: string): Promise<boolean> { try { await this.refresh(ownerId, topicId); return true } catch { return false } }
  query(ownerId: string, topicId: string, query: Omit<TopicTermQuery, 'ownerId' | 'topicId'>): TopicTermSnapshot {
    const snapshot = this.getSnapshot(ownerId, topicId)
    return { ...snapshot, entries: queryTopicTerms(snapshot, { ...query, ownerId: snapshot.ownerId, topicId }, this.resolver) }
  }
  queryAsync(ownerId: string, topicId: string, query: Omit<TopicTermQuery, 'ownerId' | 'topicId'>): Promise<TopicTermSnapshot> { return this.enqueue(ownerId, topicId, async () => { await this.waitForRead(ownerId, topicId); return this.queryCurrent(ownerId, topicId, query) }) }
  private async queryCurrent(ownerId: string, topicId: string, query: Omit<TopicTermQuery, 'ownerId' | 'topicId'>): Promise<TopicTermSnapshot> {
    const snapshot = await this.refresh(ownerId, topicId), reader = this.evidenceReader
    const seat = this.seat(ownerId, topicId), token = seat.storage?.token, epoch = this.epoch
    const fixed = structuredClone(query)
    if (fixed.mode !== 'normal') return { ...snapshot, entries: [] }
    const prepared = await prepareTopicEvidence(this.sessions, snapshot, snapshot.entries.filter(entry => entry.origin !== 'user_explicit').flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis')), this.resolver, reader)
    if (this.disposed || reader !== this.evidenceReader || !prepared.isCurrent() || this.getSnapshot(ownerId, topicId) !== snapshot) throw new Error('术语或证据已经变化，请重新查询。')
    const remote = await this.remote(), latest = parseTermStorageStatus(termReply(await remote.status(seat.scope)))
    if (this.epoch !== epoch || latest.token !== token || !prepared.isCurrent() || reader !== this.evidenceReader || this.getSnapshot(ownerId, topicId) !== snapshot) {
      if (this.epoch === epoch && this.available(topicId)) { seat.revision++; delete seat.snapshot; seat.state = { status: 'error', error: '主题术语在查询期间变化，请重新读取。' }; this.emit() }
      throw new Error('主题术语在查询期间变化，请重新查询。')
    }
    return { ...snapshot, entries: queryTopicTerms(snapshot, { ...fixed, ownerId: snapshot.ownerId, topicId }, prepared.resolver) }
  }
  private commandRefs(snapshot: TopicTermSnapshot, command: TermCommand): readonly TermEvidenceRef[] {
    if (command.kind === 'clear' || command.kind === 'delete' || command.kind === 'disable') return []
    if (command.kind === 'reconcile') return snapshot.entries.filter(entry => entry.origin !== 'user_explicit' && entry.status !== 'disabled' && entry.status !== 'review_required').flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis'))
    const content = 'input' in command ? command.input : 'id' in command ? snapshot.entries.find(entry => entry.id === command.id) : undefined
    const own = content && 'evidence' in content ? content.evidence.filter(ref => ref.role === 'basis') : []
    const aligned = command.kind === 'put' ? { ...command.input, ...alignTopicTermLanguages(snapshot, command.input) } : command.kind === 'accept_file_proposal' || command.kind === 'revise_file_proposal' ? command.input : undefined
    const conflicts = command.kind === 'put' || command.kind === 'accept_file_proposal' || command.kind === 'revise_file_proposal'
      ? snapshot.entries.filter(entry => entry.id !== command.input.id && entry.status === 'active' && entry.origin !== 'user_explicit' &&
        (command.kind !== 'put' || command.input.status === 'active') && topicTermContentsConflict(entry, aligned!))
      : []
    return [...own, ...conflicts.flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis'))]
  }

  private enqueue<T>(ownerId: string, topicId: string, action: () => Promise<T>): Promise<T> {
    const seat = this.seat(ownerId, topicId), epoch = this.epoch
    const result = (seat.tail ?? Promise.resolve()).catch(() => {}).then(() => { if (this.epoch !== epoch || !this.available(topicId)) throw new Error('主题术语连接或范围已经变化。'); return action() })
    seat.tail = result.then(() => {}, () => {})
    return result
  }
  private async waitForRead(ownerId: string, topicId: string): Promise<void> { try { await this.seat(ownerId, topicId).loading } catch { /* The serialized caller will retry the Host read. */ } }
  private mutate(ownerId: string, topicId: string, command: TermCommand, expectedVersion?: number, expectedToken?: string): Promise<TermMutationResult> {
    return this.enqueue(ownerId, topicId, () => this.executeMutation(ownerId, topicId, command, expectedVersion, expectedToken))
  }
  private async executeMutation(ownerId: string, topicId: string, command: TermCommand, expectedVersion?: number, expectedToken?: string): Promise<TermMutationResult> {
    const snapshot = await this.ensureLoaded(ownerId, topicId), seat = this.seat(ownerId, topicId), storage = seat.storage!, epoch = this.epoch, revision = seat.revision
    const failure = (status: TermMutationResult['status']): TermMutationResult => ({ status, snapshot: seat.snapshot ?? snapshot, entry: null })
    if (command.kind !== 'clear' && (storage.retired || this.sessions.isTopicDeleting(topicId))) throw new Error('主题已删除或正在删除，术语不能编辑。')
    if (expectedToken !== undefined && storage.token !== expectedToken) return failure('stale')
    if (expectedVersion !== undefined && snapshot.version !== expectedVersion) return failure('stale')
    const fixed = structuredClone(command), reader = this.evidenceReader
    const refs = [...new Map(this.commandRefs(snapshot, fixed).map(ref => [termEvidenceKey(snapshot, ref), ref])).values()]
    const prepared = await prepareTopicEvidence(this.sessions, snapshot, refs, this.resolver, reader)
    const evidence: TermEvidenceState[] = refs.map(ref => ({ ref, status: resolveTermEvidence(snapshot, ref, prepared.resolver) !== undefined ? 'ready' : prepared.isUnloaded(ref) ? 'unloaded' : 'missing' }))
    if (this.epoch !== epoch || !this.available(topicId) || reader !== this.evidenceReader || !prepared.isCurrent() || seat.snapshot !== snapshot || !storage.token) return failure('stale')
    const remote = await this.remote()
    if (this.epoch !== epoch || !this.available(topicId) || !prepared.isCurrent() || seat.snapshot !== snapshot) return failure('stale')
    if (fixed.kind !== 'clear' && this.sessions.isTopicDeleting(topicId)) return failure('stale')
    let result: TermMutationReceipt
    try { result = termReply<TermMutationReceipt>(await remote.mutate({ ...seat.scope, token: storage.token, command: fixed, evidence })) }
    catch (error) {
      // Gateway may normalize a service error code. Confirm an actual version change instead of parsing its message.
      if (this.epoch === epoch && this.available(topicId)) {
        try { await this.refresh(ownerId, topicId); if (seat.storage?.token !== storage.token) return failure('stale') } catch { /* Preserve the original failure when no current version can be confirmed. */ }
      }
      throw error
    }
    if (this.epoch !== epoch || !this.available(topicId)) throw new Error('主题术语操作范围已关闭。')
    if (seat.revision !== revision || seat.snapshot !== snapshot) return failure('stale')
    if (reader !== this.evidenceReader || !prepared.isCurrent()) {
      // The source can change while Host applies the command. Do not publish that late active set.
      seat.revision++; delete seat.snapshot; delete seat.loading
      seat.state = { status: 'error', error: '术语依据在提交期间变化，请读取最新术语后核对。' }; this.emit()
      try {
        const latestReader = this.evidenceReader
        const nextRefs = [...new Map([...this.commandRefs(snapshot, { kind: 'reconcile' }), ...refs].map(ref => [termEvidenceKey(snapshot, ref), ref])).values()]
        const verified = await prepareTopicEvidence(this.sessions, snapshot, nextRefs, this.resolver, latestReader)
        if (this.epoch !== epoch || !this.available(topicId) || !verified.isCurrent()) return failure('stale')
        const states: TermEvidenceState[] = nextRefs.map(ref => ({ ref, status: resolveTermEvidence(snapshot, ref, verified.resolver) !== undefined ? 'ready' : verified.isUnloaded(ref) ? 'unloaded' : 'missing' }))
        termReply(await remote.mutate({ ...seat.scope, token: result.token, command: { kind: 'reconcile' }, evidence: states }))
        if (latestReader === this.evidenceReader && verified.isCurrent() && this.epoch === epoch && this.available(topicId)) await this.refresh(ownerId, topicId)
      } catch { /* A stale response remains unavailable until a confirmed read succeeds. */ }
      return failure('stale')
    }
    const latest = await this.refresh(ownerId, topicId)
    if (seat.storage?.token !== result.token) return failure('stale')
    if (result.status === 'save_failed') { seat.saveFailed = true; this.notice = '主题术语修改已保留在本次运行，但尚未保存；可重试保存。'; this.emit() }
    else if (fixed.kind !== 'reconcile') { delete seat.saveFailed; if (!seat.legacyCleanupPending) this.notice = undefined; this.emit() }
    return { status: result.status, snapshot: latest, entry: result.entryId ? latest.entries.find(entry => entry.id === result.entryId) ?? null : null }
  }
  async apply(ownerId: string, topicId: string, expectedVersion: number, command: TopicTermCommand): Promise<TermMutationResult> {
    const snapshot = await this.ensureLoaded(ownerId, topicId)
    if ((command.kind === 'put' || command.kind === 'accept_file_proposal' || command.kind === 'revise_file_proposal') && !decodeTopicTermPut(command.input)) return { status: 'invalid', snapshot, entry: null }
    return this.mutate(ownerId, topicId, command, expectedVersion)
  }
  async saveUserTerm(ownerId: string, topicId: string, expectedVersion: number, input: TopicTermUserInput): Promise<TermMutationResult> {
    const snapshot = await this.ensureLoaded(ownerId, topicId), parsed = decodeTopicTermUserInput(input)
    if (!parsed) return { status: 'invalid', snapshot, entry: null }
    let id = parsed.id
    if (id === null) { do { id = newTermId() } while (snapshot.entries.some(entry => entry.id === id)) }
    return this.apply(ownerId, topicId, expectedVersion, { kind: 'user_put', input: { ...parsed, id } })
  }
  reconcileAsync(ownerId: string, topicId: string): Promise<TopicTermSnapshot> { return this.enqueue(ownerId, topicId, async () => { await this.waitForRead(ownerId, topicId); await this.refresh(ownerId, topicId); return (await this.executeMutation(ownerId, topicId, { kind: 'reconcile' })).snapshot }) }
  captureClearVersion(ownerId: string, topicId: string): TopicTermClearVersion {
    const seat = this.seat(ownerId, topicId), snapshot = this.getSnapshot(ownerId, topicId), status = seat.storage!
    if (!status.token) throw new Error('术语清空范围尚未读取。')
    return { ownerId: snapshot.ownerId, topicId, token: status.token, version: snapshot.version, storageAvailable: true, currentCount: snapshot.entries.length, storedCount: status.saved?.count ?? 0 }
  }
  captureClearVersionAsync(ownerId: string, topicId: string): Promise<TopicTermClearVersion> { return this.enqueue(ownerId, topicId, async () => { await this.waitForRead(ownerId, topicId); await this.refresh(ownerId, topicId); return this.captureClearVersion(ownerId, topicId) }) }
  isClearVersionCurrent(version: TopicTermVersion): boolean {
    try { const seat = this.seat(version.ownerId, version.topicId); return seat.state.status === 'ready' && seat.storage?.token === version.token } catch { return false }
  }
  async isClearVersionCurrentAsync(version: TopicTermVersion): Promise<boolean> {
    if (!this.isClearVersionCurrent(version)) return false
    const seat = this.seat(version.ownerId, version.topicId), epoch = this.epoch
    try {
      const remote = await this.remote(), status = parseTermStorageStatus(termReply(await remote.status(seat.scope)))
      return this.epoch === epoch && status.token === version.token && this.isClearVersionCurrent(version)
    } catch { return false }
  }
  async clearCaptured(version: TopicTermClearVersion): Promise<boolean> {
    if (!this.isClearVersionCurrent(version)) return false
    try {
      const result = await this.mutate(version.ownerId, version.topicId, { kind: 'clear' }, version.version, version.token)
      if (result.status !== 'updated' && result.status !== 'unchanged') return false
      if (!this.retryLegacyCleanup(this.seat(version.ownerId, version.topicId))) { this.notice = '新存储中的术语已清空，但旧浏览器副本未能删除；主题删除尚未完成，请重试清理。'; this.emit(); return false }
      this.notice = undefined; this.emit(); return true
    }
    catch (error) { this.notice = `主题术语清空未完成：${(error as Error).message}`; this.emit(); return false }
  }
  async clearLocked(version: TopicTermClearVersion): Promise<boolean> { return this.clearCaptured(version) }
  async deleteEntryAsync(ownerId: string, topicId: string, id: string, expectedVersion: number, expectedEntryVersion: number): Promise<boolean> {
    const result = await this.mutate(ownerId, topicId, { kind: 'delete', id, expectedEntryVersion }, expectedVersion)
    if ((result.status === 'updated' || result.status === 'unchanged') && this.seat(ownerId, topicId).legacyCleanupPending) { this.notice = '条目已从新存储删除，但旧浏览器副本尚未清理；刷新可重试清理。'; this.emit() }
    return result.status === 'updated' || result.status === 'unchanged'
  }
  captureVersions(scopes: readonly { readonly ownerId: string; readonly topicId: string }[]): readonly TopicTermVersion[] {
    return [...new Map(scopes.map(scope => [scope.topicId, scope])).values()].map(scope => this.captureClearVersion(scope.ownerId, scope.topicId))
  }
  async captureVersionsAsync(scopes: readonly { readonly ownerId: string; readonly topicId: string }[]): Promise<readonly TopicTermVersion[]> {
    return Promise.all([...new Map(scopes.map(scope => [scope.topicId, scope])).values()].map(scope => this.captureClearVersionAsync(scope.ownerId, scope.topicId)))
  }
  captureForSessions(ids: readonly string[]): readonly TopicTermVersion[] { return this.captureVersions(this.sessionScopes(ids)) }
  captureForSessionsAsync(ids: readonly string[]): Promise<readonly TopicTermVersion[]> { return this.captureVersionsAsync(this.sessionScopes(ids)) }
  private sessionScopes(ids: readonly string[]): readonly { readonly ownerId: string; readonly topicId: string }[] {
    return ids.flatMap(id => { const session = this.sessions.getSession(id); return session ? [{ ownerId: this.sessions.getTopicStorageScope(session.topicId)!, topicId: session.topicId }] : [] })
  }
  /** Only legacy migration/cleanup still needs the browser topic lock. */
  async withTopicLock<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('主题术语服务已关闭。')
    return this.locks ? this.locks.request(TOPIC_LOCK_NAME, action) : action()
  }
  async deleteHistoryAsync(ids: readonly string[], unreadable: readonly { readonly key: string; readonly raw: string }[], expectedHistory: readonly HistoryVersion[], termVersions: readonly TopicTermVersion[] = []): Promise<boolean> {
    if (!termVersions.length) return this.sessions.deleteHistoryAsync(ids, false, unreadable, expectedHistory)
    const scopes = this.sessionScopes(ids), captured: TopicTermClearVersion[] = []
    if (termVersions.some(version => !scopes.some(scope => scope.ownerId === version.ownerId && scope.topicId === version.topicId))) return false
    try {
      for (const version of termVersions) {
        const current = await this.captureClearVersionAsync(version.ownerId, version.topicId)
        if (current.token !== version.token) { this.notice = '待删除主题术语已变化，会话及术语均未删除；请重新核对删除范围。'; this.emit(); return false }
        captured.push(current)
      }
    } catch (error) { this.notice = `主题术语读取未完成，会话及术语均未删除：${(error as Error).message}`; this.emit(); return false }
    for (const version of captured) this.pausedReconciliation.add(version.topicId)
    try {
      const deleted = await this.sessions.deleteHistoryAsync(ids, false, unreadable, expectedHistory, {
        requiresStorage: false, preflight: () => captured.every(version => this.isClearVersionCurrent(version)), afterHistoryDeleted: () => true,
      })
      if (!deleted) return false
      let removed = 0
      for (const version of captured) { if (await this.clearCaptured(version)) removed++ }
      if (removed !== captured.length) { this.notice = `所选会话已删除，但主题术语未全部清理：已清理 ${removed} 个主题，未完成 ${captured.length - removed} 个主题。`; this.emit(); return false }
      return true
    } finally { for (const version of captured) this.pausedReconciliation.delete(version.topicId) }
  }
  private sessionChanged(): void {
    if (this.disposed) return
    for (const [topicId, seat] of this.seats) {
      if (!this.available(topicId)) { seat.revision++; this.seats.delete(topicId); continue }
      if (seat.state.status !== 'ready' || seat.reconcileQueued || this.pausedReconciliation.has(topicId) || this.sessions.isTopicDeleting(topicId)) continue
      seat.reconcileQueued = true
      const baseline = seat.snapshot!
      queueMicrotask(() => {
        if (!this.available(topicId) || this.seats.get(topicId) !== seat || this.pausedReconciliation.has(topicId) || this.sessions.isTopicDeleting(topicId)) { seat.reconcileQueued = false; return }
        void Promise.resolve().then(() => this.reconcileAsync(seat.scope.ownerId, topicId)).then(snapshot => {
          if (snapshot.version !== baseline.version) return this.persistReconciled(seat, snapshot)
        }).catch(error => { if (!this.disposed) { diagnosticSpan({}, 'terms.reconcile', {}, topicId)('failed', {}, error); this.notice = `主题术语依据检查未完成：${(error as Error).message}`; this.emit() } }).finally(() => { seat.reconcileQueued = false })
      })
    }
    this.emit()
  }
  private persistReconciled(seat: Seat, snapshot: TopicTermSnapshot): Promise<void> {
    return this.enqueue(seat.scope.ownerId, seat.scope.topicId, async () => {
      if (seat.snapshot !== snapshot || this.sessions.isTopicDeleting(seat.scope.topicId) || !seat.storage?.token) return
      const remote = await this.remote(), token = seat.storage.token
      if (seat.snapshot !== snapshot || this.sessions.isTopicDeleting(seat.scope.topicId)) return
      termReply(await remote.persist({ ...seat.scope, token }))
      await this.refresh(seat.scope.ownerId, seat.scope.topicId)
    })
  }
  reset(): void { this.epoch++; for (const seat of this.seats.values()) { seat.revision++; delete seat.snapshot; delete seat.loading; seat.state = { status: 'idle' }; if (seat.refs > 0) void this.ensureLoaded(seat.scope.ownerId, seat.scope.topicId).catch(() => {}) }; this.emit() }
  dispose(): void { this.disposed = true; this.epoch++; this.stopSession(); this.stopStorage?.(); this.seats.clear(); this.listeners.clear() }
}
