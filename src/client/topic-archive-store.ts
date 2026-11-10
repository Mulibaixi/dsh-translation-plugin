import { browserPluginStorage, isPluginStorageEvent } from './storage-fence.js'
import { emptyTopicArchive, decodeTopicArchiveSnapshot, decodeTopicArchivePut, decodeTopicArchiveUserInput, queryTopicArchive, referencedEntityIds,
  type TopicArchiveSnapshot, type TopicArchivePut, type TopicArchiveUserInput, type TopicArchiveUserPut, type ArchiveMutationResult, type TopicArchiveQuery } from '../memory/topic-archive.js'
import { resolveTermEvidence, termEvidenceKey, type TermEvidenceRef, type TermEvidenceResolver, type FileProposalAcceptance } from '../memory/topic-terms.js'
import { parseArchiveStorageStatus, type ArchiveRemoteScope, type ArchiveStorageStatus, type ArchiveCommand, type ArchiveEvidenceState, type ArchiveMutationReceipt } from '../shared/topic-archive-remote.js'
import type { SessionStore, LocalStoragePort, StructureLockPort, HistoryStatus } from './session-store.js'
import { captureTopicEvidenceCurrent, isTopicEvidenceUnloaded, prepareTopicEvidence } from './topic-evidence.js'
import type { TranslationEvidenceReader } from './source-reader.js'
import { archiveReply, archiveScopeMatches, readArchiveSnapshot, transferArchiveMigration, type TopicArchiveRemotePort } from './topic-archive-transport.js'
import { TOPIC_LOCK_NAME } from './topics.js'

export type { TopicArchiveRemotePort } from './topic-archive-transport.js'
export const TOPIC_ARCHIVE_PREFIX = 'dsh-translation-plugin:topic-archive:v1:'
export function topicArchiveKey(topicId: string): string { return `${TOPIC_ARCHIVE_PREFIX}${encodeURIComponent(topicId)}` }
export interface TopicArchiveVersion {
  readonly storageAvailable: boolean; readonly ownerId: string; readonly topicId: string; readonly token: string
  readonly version: number; readonly currentCount: number; readonly storedCount: number
}
export type TopicArchiveCommand = { readonly kind: 'put'; readonly input: TopicArchivePut }
  | { readonly kind: 'delete'; readonly id: string; readonly expectedEntryVersion: number }
  | { readonly kind: 'accept_file_proposal' | 'revise_file_proposal'; readonly input: TopicArchivePut; readonly acceptance: FileProposalAcceptance }
  | { readonly kind: 'user_put'; readonly input: TopicArchiveUserPut }
  | { readonly kind: 'adopt' | 'disable'; readonly id: string; readonly expectedEntryVersion: number }
export interface TopicArchiveReadState { readonly status: 'idle' | 'loading' | 'ready' | 'error'; readonly snapshot?: TopicArchiveSnapshot; readonly error?: string; readonly retired?: true }
interface Seat {
  readonly scope: ArchiveRemoteScope; revision: number; state: TopicArchiveReadState; snapshot?: TopicArchiveSnapshot
  storage?: ArchiveStorageStatus; loading?: Promise<TopicArchiveSnapshot>; refs: number; reconcileQueued: boolean
  tail?: Promise<unknown>
  saveFailed?: true
  legacyCleanupPending?: true
}
const now = (): string => new Date().toISOString()
const eventId = (): string => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? `archive:${crypto.randomUUID()}` : `archive:${Date.now()}:${Math.random()}`
function browserLocks(): StructureLockPort | undefined {
  if (typeof navigator === 'undefined' || !navigator.locks) return undefined
  return { request: async <T>(name: string, action: () => T | Promise<T>): Promise<T> => await navigator.locks.request(name, async () => await action()) }
}

/** Host owns every migrated archive. Browser storage is read once only as a migration source. */
export class TopicArchiveStore {
  private readonly seats = new Map<string, Seat>()
  private readonly listeners = new Set<() => void>()
  private readonly stopSession: () => void
  private readonly stopStorage: (() => void) | undefined
  private disposed = false
  private epoch = 0
  private notice: string | undefined
  private evidenceReader: TranslationEvidenceReader | undefined
  constructor(private readonly sessions: SessionStore, private readonly resolver: TermEvidenceResolver, private readonly storage: LocalStoragePort | undefined = browserPluginStorage(),
    listen?: (onChange: (key: string | null) => void) => () => void, private readonly locks: StructureLockPort | undefined = browserLocks(),
    private readonly options: { readonly remote?: () => Promise<TopicArchiveRemotePort | undefined> } = {}) {
    this.stopSession = sessions.subscribe(() => this.sessionChanged())
    const change = (key: string | null): void => { if (key === null || key.startsWith(TOPIC_ARCHIVE_PREFIX)) this.emit() }
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
  private available(topicId: string): boolean { return !this.disposed && !this.sessions.isTopicDeleted(topicId) && this.sessions.getTopics().some(topic => topic.id === topicId) }
  private seat(ownerId: string, topicId: string): Seat {
    if (!this.available(topicId)) throw new Error('主题不存在、已删除或档案服务已关闭。')
    ownerId = this.sessions.getTopicStorageScope(topicId) ?? ownerId
    let seat = this.seats.get(topicId)
    if (!seat) { seat = { scope: { namespaceId: this.sessions.getNamespaceId(), ownerId, topicId }, revision: 0, state: { status: 'idle' }, refs: 0, reconcileQueued: false }; this.seats.set(topicId, seat) }
    if (seat.scope.ownerId !== ownerId) throw new Error('主题档案作用域不匹配。')
    return seat
  }
  getReadState(ownerId: string, topicId: string): TopicArchiveReadState {
    try { return this.seat(ownerId, topicId).state } catch (error) { return { status: 'error', error: (error as Error).message } }
  }
  getStatus(ownerId: string, topicId: string): HistoryStatus {
    const seat = this.seat(ownerId, topicId)
    return seat.state.status !== 'ready' || seat.saveFailed ? 'error' : seat.storage?.persistence === 'saved' ? 'saved' : 'memory'
  }
  getSnapshot(ownerId: string, topicId: string): TopicArchiveSnapshot {
    const seat = this.seat(ownerId, topicId)
    if (seat.state.status !== 'ready' || !seat.snapshot) throw new Error(seat.state.error ?? '主题档案尚未读取，请等待加载完成。')
    return seat.snapshot
  }
  retain(ownerId: string, topicId: string): () => void {
    const seat = this.seat(ownerId, topicId); seat.refs++
    void this.ensureLoaded(ownerId, topicId).catch(() => {})
    let released = false
    return () => { if (released) return; released = true; seat.refs--; if (seat.refs === 0) { seat.revision++; delete seat.snapshot; delete seat.loading; seat.state = { status: 'idle' } } }
  }
  async ensureLoaded(ownerId: string, topicId: string): Promise<TopicArchiveSnapshot> {
    const seat = this.seat(ownerId, topicId)
    if (seat.state.status === 'ready' && seat.snapshot) return seat.snapshot
    return seat.loading ?? this.refresh(ownerId, topicId)
  }
  private async remote(): Promise<TopicArchiveRemotePort> {
    const remote = await this.options.remote?.()
    if (!remote || this.disposed) throw new Error('主题档案服务尚未就绪，请检查资料库连接后重试。')
    return remote
  }
  private cleanupLegacy(topicId: string, raw: string | null): boolean {
    if (raw === null || !this.storage) return true
    try {
      if (this.storage.getItem(topicArchiveKey(topicId)) !== raw) throw new Error('legacy changed')
      this.storage.removeItem(topicArchiveKey(topicId)); return true
    } catch { this.notice = '主题档案已迁移至新存储，旧浏览器副本暂未清理；刷新可重试，不会回退旧副本。'; return false }
  }
  private retryLegacyCleanup(seat: Seat): boolean {
    let cleaned = false
    try { cleaned = this.cleanupLegacy(seat.scope.topicId, this.storage?.getItem(topicArchiveKey(seat.scope.topicId)) ?? null) }
    catch { this.notice = '主题档案已迁移至新存储，旧浏览器副本暂未清理；可刷新重试。' }
    if (cleaned) {
      const wasPending = seat.legacyCleanupPending
      delete seat.legacyCleanupPending
      if (wasPending && this.notice?.includes('旧浏览器副本') && ![...this.seats.values()].some(value => value.legacyCleanupPending)) this.notice = undefined
    }
    else seat.legacyCleanupPending = true
    return cleaned
  }
  private async migrateLegacy(remote: TopicArchiveRemotePort, seat: Seat, current: () => boolean): Promise<ArchiveStorageStatus> {
    const migrate = async (): Promise<ArchiveStorageStatus> => {
      if (!current()) throw new Error('主题档案迁移已经失效。')
      const before = parseArchiveStorageStatus(archiveReply(await remote.status(seat.scope)))
      if (before.switched) return before
      if (this.sessions.isTopicDeleting(seat.scope.topicId)) throw new Error('主题正在删除，不能初始化或迁移档案。')
      const raw = this.storage?.getItem(topicArchiveKey(seat.scope.topicId)) ?? null
      let saved: TopicArchiveSnapshot | null | undefined = null
      try { saved = raw === null ? null : decodeTopicArchiveSnapshot(JSON.parse(raw)) } catch { throw new Error('旧版主题档案无法读取，原副本已保留，尚未迁移。') }
      if (raw !== null && (!saved || !archiveScopeMatches(saved, seat.scope))) throw new Error('旧版主题档案无法读取，原副本已保留，尚未迁移。')
      const snapshot = saved ?? emptyTopicArchive(seat.scope.ownerId, seat.scope.topicId, now())
      const committed = await transferArchiveMigration(remote, seat.scope, snapshot, saved ?? null, current)
      const checked = parseArchiveStorageStatus(archiveReply(await remote.status(seat.scope)))
      if (!checked.switched || checked.token !== committed.token) throw new Error('主题档案迁移结果已变化，请重新读取核对。')
      const confirmed = await readArchiveSnapshot(remote, seat.scope, checked, 'current', current)
      const confirmedSaved = await readArchiveSnapshot(remote, seat.scope, checked, 'saved', current)
      if (JSON.stringify(confirmed) !== JSON.stringify(snapshot) || JSON.stringify(confirmedSaved) !== JSON.stringify(saved ?? null)) throw new Error('主题档案迁移读回不一致，旧副本已保留。')
      if (!current()) throw new Error('主题档案迁移已经失效。')
      if (!this.cleanupLegacy(seat.scope.topicId, raw)) seat.legacyCleanupPending = true
      return checked
    }
    if (this.locks) return this.locks.request(TOPIC_LOCK_NAME, migrate)
    if (this.storage?.getItem(topicArchiveKey(seat.scope.topicId)) != null) throw new Error('旧版档案迁移需要主题存储锁，原副本已保留。')
    return migrate()
  }
  async refresh(ownerId: string, topicId: string): Promise<TopicArchiveSnapshot> {
    const seat = this.seat(ownerId, topicId), revision = ++seat.revision, epoch = this.epoch
    const current = (): boolean => this.epoch === epoch && seat.revision === revision && this.available(topicId)
    seat.state = { status: 'loading', ...(seat.snapshot ? { snapshot: seat.snapshot } : {}) }; this.emit()
    const load = (async (): Promise<TopicArchiveSnapshot> => {
      try {
        const remote = await this.remote()
        if (!current()) throw new Error('主题档案读取已经失效。')
        let status = parseArchiveStorageStatus(archiveReply(await remote.status(seat.scope)))
        if (!current()) throw new Error('主题档案读取已经失效。')
        if (status.retired) {
          const head = status.current!
          const snapshot: TopicArchiveSnapshot = { schemaVersion: head.schemaVersion, ownerId: head.ownerId, topicId: head.topicId, version: head.version, activeVersion: head.activeVersion, updatedAt: head.updatedAt, entries: [] }
          if (!archiveScopeMatches(snapshot, seat.scope) || head.count !== 0) throw new Error('退役档案范围不匹配。')
          seat.snapshot = snapshot; seat.storage = status; seat.state = { status: 'ready', snapshot, retired: true }
          this.retryLegacyCleanup(seat); this.emit(); return snapshot
        }
        if (!status.switched) {
          status = await this.migrateLegacy(remote, seat, current)
        }
        let snapshot = await readArchiveSnapshot(remote, seat.scope, status, 'current', current)
        if (!current()) throw new Error('主题档案读取已经失效。')
        if (!snapshot || !status.token) throw new Error('主题档案读取未完成，不能将其视为空档案。')
        if (!this.sessions.isTopicDeleting(topicId)) {
          // Reading old evidence may invalidate the runtime projection, never its saved historical copy.
          const refs = [...new Map(this.commandRefs(snapshot, { kind: 'reconcile' }).map(ref => [termEvidenceKey(snapshot!, ref), ref])).values()]
          const resolver = this.resolver, evidenceCurrent = captureTopicEvidenceCurrent(this.sessions, snapshot, refs, resolver)
          const evidence: ArchiveEvidenceState[] = refs.map(ref => ({ ref, status: resolveTermEvidence(snapshot!, ref, resolver) !== undefined ? 'ready' : isTopicEvidenceUnloaded(this.sessions, snapshot!, ref) ? 'unloaded' : 'missing' }))
          const receipt = archiveReply<ArchiveMutationReceipt>(await remote.mutate({ ...seat.scope, token: status.token, command: { kind: 'reconcile' }, evidence }))
          if (!current() || !evidenceCurrent()) throw new Error('档案依据在读取期间变化，请重新读取。')
          if (receipt.token !== status.token) {
            status = parseArchiveStorageStatus(archiveReply(await remote.status(seat.scope)))
            if (receipt.token !== status.token) throw new Error('档案在读取期间变化，请重新读取。')
            snapshot = await readArchiveSnapshot(remote, seat.scope, status, 'current', current)
            if (!snapshot) throw new Error('档案复核结果尚未读取。')
          }
        }
        if (!current()) throw new Error('主题档案读取已经失效。')
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
  reloadAsync(ownerId: string, topicId: string): Promise<TopicArchiveSnapshot> { return this.refresh(ownerId, topicId) }
  async reload(ownerId: string, topicId: string): Promise<boolean> { try { await this.refresh(ownerId, topicId); return true } catch { return false } }
  query(ownerId: string, topicId: string, query: Omit<TopicArchiveQuery, 'ownerId' | 'topicId'>): TopicArchiveSnapshot {
    const snapshot = this.getSnapshot(ownerId, topicId)
    return { ...snapshot, entries: queryTopicArchive(snapshot, { ...query, ownerId: snapshot.ownerId, topicId }, this.resolver) }
  }
  queryAsync(ownerId: string, topicId: string, query: Omit<TopicArchiveQuery, 'ownerId' | 'topicId'>): Promise<TopicArchiveSnapshot> { return this.enqueue(ownerId, topicId, async () => { await this.waitForRead(ownerId, topicId); return this.queryCurrent(ownerId, topicId, query) }) }
  private async queryCurrent(ownerId: string, topicId: string, query: Omit<TopicArchiveQuery, 'ownerId' | 'topicId'>): Promise<TopicArchiveSnapshot> {
    const snapshot = await this.refresh(ownerId, topicId), reader = this.evidenceReader
    const seat = this.seat(ownerId, topicId), token = seat.storage?.token, epoch = this.epoch
    const fixed = structuredClone(query)
    if (fixed.mode !== 'normal') return { ...snapshot, entries: [] }
    const prepared = await prepareTopicEvidence(this.sessions, snapshot, snapshot.entries.filter(entry => entry.origin !== 'user_explicit').flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis')), this.resolver, reader)
    if (this.disposed || reader !== this.evidenceReader || !prepared.isCurrent() || this.getSnapshot(ownerId, topicId) !== snapshot) throw new Error('档案或证据已经变化，请重新查询。')
    const remote = await this.remote(), latest = parseArchiveStorageStatus(archiveReply(await remote.status(seat.scope)))
    if (this.epoch !== epoch || latest.token !== token || !prepared.isCurrent() || reader !== this.evidenceReader || this.getSnapshot(ownerId, topicId) !== snapshot) {
      if (this.epoch === epoch && this.available(topicId)) { seat.revision++; delete seat.snapshot; seat.state = { status: 'error', error: '主题档案在查询期间变化，请重新读取。' }; this.emit() }
      throw new Error('主题档案在查询期间变化，请重新查询。')
    }
    return { ...snapshot, entries: queryTopicArchive(snapshot, { ...fixed, ownerId: snapshot.ownerId, topicId }, prepared.resolver) }
  }
  private commandRefs(snapshot: TopicArchiveSnapshot, command: ArchiveCommand): readonly TermEvidenceRef[] {
    if (command.kind === 'clear' || command.kind === 'delete' || command.kind === 'disable') return []
    if (command.kind === 'reconcile') return snapshot.entries.filter(entry => entry.origin !== 'user_explicit' && entry.status !== 'disabled' && entry.status !== 'review_required').flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis'))
    const content = 'input' in command ? command.input : 'id' in command ? snapshot.entries.find(entry => entry.id === command.id) : undefined
    const ids = new Set(content ? referencedEntityIds(content) : [])
    const own = content && 'evidence' in content ? content.evidence.filter(ref => ref.role === 'basis') : []
    return [...own, ...snapshot.entries.filter(entry => ids.has(entry.id) && entry.origin !== 'user_explicit').flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis'))]
  }
  private enqueue<T>(ownerId: string, topicId: string, action: () => Promise<T>): Promise<T> {
    const seat = this.seat(ownerId, topicId), epoch = this.epoch
    const result = (seat.tail ?? Promise.resolve()).catch(() => {}).then(() => { if (this.epoch !== epoch || !this.available(topicId)) throw new Error('主题档案连接或范围已经变化。'); return action() })
    seat.tail = result.then(() => {}, () => {})
    return result
  }
  private async waitForRead(ownerId: string, topicId: string): Promise<void> { try { await this.seat(ownerId, topicId).loading } catch { /* The serialized caller will retry the Host read. */ } }
  private mutate(ownerId: string, topicId: string, command: ArchiveCommand, expectedVersion?: number, expectedToken?: string): Promise<ArchiveMutationResult> {
    return this.enqueue(ownerId, topicId, () => this.executeMutation(ownerId, topicId, command, expectedVersion, expectedToken))
  }
  private async executeMutation(ownerId: string, topicId: string, command: ArchiveCommand, expectedVersion?: number, expectedToken?: string): Promise<ArchiveMutationResult> {
    const snapshot = await this.ensureLoaded(ownerId, topicId), seat = this.seat(ownerId, topicId), storage = seat.storage!, epoch = this.epoch, revision = seat.revision
    const failure = (status: ArchiveMutationResult['status']): ArchiveMutationResult => ({ status, snapshot: seat.snapshot ?? snapshot, entry: null })
    if (command.kind !== 'clear' && (storage.retired || this.sessions.isTopicDeleting(topicId))) throw new Error('主题已删除或正在删除，档案不能编辑。')
    if (expectedToken !== undefined && storage.token !== expectedToken) return failure('stale')
    if (expectedVersion !== undefined && snapshot.version !== expectedVersion) return failure('stale')
    const fixed = structuredClone(command), reader = this.evidenceReader
    const refs = [...new Map(this.commandRefs(snapshot, fixed).map(ref => [termEvidenceKey(snapshot, ref), ref])).values()]
    const prepared = await prepareTopicEvidence(this.sessions, snapshot, refs, this.resolver, reader)
    const evidence: ArchiveEvidenceState[] = refs.map(ref => ({ ref, status: resolveTermEvidence(snapshot, ref, prepared.resolver) !== undefined ? 'ready' : prepared.isUnloaded(ref) ? 'unloaded' : 'missing' }))
    if (this.epoch !== epoch || !this.available(topicId) || reader !== this.evidenceReader || !prepared.isCurrent() || seat.snapshot !== snapshot || !storage.token) return failure('stale')
    const remote = await this.remote()
    if (this.epoch !== epoch || !this.available(topicId) || !prepared.isCurrent() || seat.snapshot !== snapshot) return failure('stale')
    if (fixed.kind !== 'clear' && this.sessions.isTopicDeleting(topicId)) return failure('stale')
    let result: ArchiveMutationReceipt
    try { result = archiveReply<ArchiveMutationReceipt>(await remote.mutate({ ...seat.scope, token: storage.token, command: fixed, evidence })) }
    catch (error) {
      // Gateway may normalize a service error code. Confirm an actual version change instead of parsing its message.
      if (this.epoch === epoch && this.available(topicId)) {
        try { await this.refresh(ownerId, topicId); if (seat.storage?.token !== storage.token) return failure('stale') } catch { /* Preserve the original failure when no current version can be confirmed. */ }
      }
      throw error
    }
    if (this.epoch !== epoch || !this.available(topicId)) throw new Error('主题档案操作范围已关闭。')
    if (seat.revision !== revision || seat.snapshot !== snapshot) return failure('stale')
    if (reader !== this.evidenceReader || !prepared.isCurrent()) {
      // The source can change while Host applies the command. Do not publish that late active set.
      seat.revision++; delete seat.snapshot; delete seat.loading
      seat.state = { status: 'error', error: '档案依据在提交期间变化，请读取最新档案后核对。' }; this.emit()
      try {
        const latestReader = this.evidenceReader
        const nextRefs = [...new Map([...this.commandRefs(snapshot, { kind: 'reconcile' }), ...refs].map(ref => [termEvidenceKey(snapshot, ref), ref])).values()]
        const verified = await prepareTopicEvidence(this.sessions, snapshot, nextRefs, this.resolver, latestReader)
        if (this.epoch !== epoch || !this.available(topicId) || !verified.isCurrent()) return failure('stale')
        const states: ArchiveEvidenceState[] = nextRefs.map(ref => ({ ref, status: resolveTermEvidence(snapshot, ref, verified.resolver) !== undefined ? 'ready' : verified.isUnloaded(ref) ? 'unloaded' : 'missing' }))
        archiveReply(await remote.mutate({ ...seat.scope, token: result.token, command: { kind: 'reconcile' }, evidence: states }))
        if (latestReader === this.evidenceReader && verified.isCurrent() && this.epoch === epoch && this.available(topicId)) await this.refresh(ownerId, topicId)
      } catch { /* A stale response remains unavailable until a confirmed read succeeds. */ }
      return failure('stale')
    }
    const latest = await this.refresh(ownerId, topicId)
    if (seat.storage?.token !== result.token) return failure('stale')
    if (result.status === 'save_failed') { seat.saveFailed = true; this.notice = '主题档案修改已保留在本次运行，但尚未保存；可重试保存。'; this.emit() }
    else if (fixed.kind !== 'reconcile') { delete seat.saveFailed; if (!seat.legacyCleanupPending) this.notice = undefined; this.emit() }
    return { status: result.status, snapshot: latest, entry: result.entryId ? latest.entries.find(entry => entry.id === result.entryId) ?? null : null }
  }
  async apply(ownerId: string, topicId: string, expectedVersion: number, command: TopicArchiveCommand): Promise<ArchiveMutationResult> {
    const snapshot = await this.ensureLoaded(ownerId, topicId)
    if ((command.kind === 'put' || command.kind === 'accept_file_proposal' || command.kind === 'revise_file_proposal') && !decodeTopicArchivePut(command.input)) return { status: 'invalid', snapshot, entry: null }
    return this.mutate(ownerId, topicId, command, expectedVersion)
  }
  async saveUserEntry(ownerId: string, topicId: string, expectedVersion: number, input: TopicArchiveUserInput): Promise<ArchiveMutationResult> {
    const snapshot = await this.ensureLoaded(ownerId, topicId), parsed = decodeTopicArchiveUserInput(input)
    if (!parsed) return { status: 'invalid', snapshot, entry: null }
    let id = parsed.id
    if (id === null) { do { id = eventId() } while (snapshot.entries.some(entry => entry.id === id)) }
    return this.apply(ownerId, topicId, expectedVersion, { kind: 'user_put', input: { ...parsed, id } })
  }
  reconcileAsync(ownerId: string, topicId: string): Promise<TopicArchiveSnapshot> { return this.enqueue(ownerId, topicId, async () => { await this.waitForRead(ownerId, topicId); await this.refresh(ownerId, topicId); return (await this.executeMutation(ownerId, topicId, { kind: 'reconcile' })).snapshot }) }
  captureClearVersion(ownerId: string, topicId: string): TopicArchiveVersion {
    const seat = this.seat(ownerId, topicId), snapshot = this.getSnapshot(ownerId, topicId), status = seat.storage!
    if (!status.token) throw new Error('档案清空范围尚未读取。')
    return { ownerId: snapshot.ownerId, topicId, token: status.token, version: snapshot.version, storageAvailable: true, currentCount: snapshot.entries.length, storedCount: status.saved?.count ?? 0 }
  }
  captureClearVersionAsync(ownerId: string, topicId: string): Promise<TopicArchiveVersion> { return this.enqueue(ownerId, topicId, async () => { await this.waitForRead(ownerId, topicId); await this.refresh(ownerId, topicId); return this.captureClearVersion(ownerId, topicId) }) }
  isClearVersionCurrent(version: TopicArchiveVersion): boolean {
    try { const seat = this.seat(version.ownerId, version.topicId); return seat.state.status === 'ready' && seat.storage?.token === version.token } catch { return false }
  }
  async isClearVersionCurrentAsync(version: TopicArchiveVersion): Promise<boolean> {
    if (!this.isClearVersionCurrent(version)) return false
    const seat = this.seat(version.ownerId, version.topicId), epoch = this.epoch
    try {
      const remote = await this.remote(), status = parseArchiveStorageStatus(archiveReply(await remote.status(seat.scope)))
      return this.epoch === epoch && status.token === version.token && this.isClearVersionCurrent(version)
    } catch { return false }
  }
  async clearCaptured(version: TopicArchiveVersion): Promise<boolean> {
    if (!this.isClearVersionCurrent(version)) return false
    try {
      const result = await this.mutate(version.ownerId, version.topicId, { kind: 'clear' }, version.version, version.token)
      if (result.status !== 'updated' && result.status !== 'unchanged') return false
      if (!this.retryLegacyCleanup(this.seat(version.ownerId, version.topicId))) { this.notice = '新存储中的档案已清空，但旧浏览器副本未能删除；主题删除尚未完成，请重试清理。'; this.emit(); return false }
      this.notice = undefined; this.emit(); return true
    }
    catch (error) { this.notice = `主题档案清空未完成：${(error as Error).message}`; this.emit(); return false }
  }
  async clearLocked(version: TopicArchiveVersion): Promise<boolean> { return this.clearCaptured(version) }
  async deleteEntryAsync(ownerId: string, topicId: string, id: string, expectedVersion: number, expectedEntryVersion: number): Promise<boolean> {
    const result = await this.mutate(ownerId, topicId, { kind: 'delete', id, expectedEntryVersion }, expectedVersion)
    if ((result.status === 'updated' || result.status === 'unchanged') && this.seat(ownerId, topicId).legacyCleanupPending) { this.notice = '条目已从新存储删除，但旧浏览器副本尚未清理；刷新可重试清理。'; this.emit() }
    return result.status === 'updated' || result.status === 'unchanged'
  }
  private sessionChanged(): void {
    if (this.disposed) return
    for (const [topicId, seat] of this.seats) {
      if (!this.available(topicId)) { seat.revision++; this.seats.delete(topicId); continue }
      if (seat.state.status !== 'ready' || seat.reconcileQueued || this.sessions.isTopicDeleting(topicId)) continue
      seat.reconcileQueued = true
      const baseline = seat.snapshot!
      queueMicrotask(() => {
        if (!this.available(topicId) || this.seats.get(topicId) !== seat || this.sessions.isTopicDeleting(topicId)) { seat.reconcileQueued = false; return }
        void Promise.resolve().then(() => this.reconcileAsync(seat.scope.ownerId, topicId)).then(snapshot => {
          if (snapshot.version !== baseline.version) return this.persistReconciled(seat, snapshot)
        }).catch(error => { if (!this.disposed) { this.notice = `主题档案依据检查未完成：${(error as Error).message}`; this.emit() } }).finally(() => { seat.reconcileQueued = false })
      })
    }
    this.emit()
  }
  private persistReconciled(seat: Seat, snapshot: TopicArchiveSnapshot): Promise<void> {
    return this.enqueue(seat.scope.ownerId, seat.scope.topicId, async () => {
      if (seat.snapshot !== snapshot || this.sessions.isTopicDeleting(seat.scope.topicId) || !seat.storage?.token) return
      const remote = await this.remote(), token = seat.storage.token
      if (seat.snapshot !== snapshot || this.sessions.isTopicDeleting(seat.scope.topicId)) return
      archiveReply(await remote.persist({ ...seat.scope, token }))
      await this.refresh(seat.scope.ownerId, seat.scope.topicId)
    })
  }
  reset(): void { this.epoch++; for (const seat of this.seats.values()) { seat.revision++; delete seat.snapshot; delete seat.loading; seat.state = { status: 'idle' }; if (seat.refs > 0) void this.ensureLoaded(seat.scope.ownerId, seat.scope.topicId).catch(() => {}) }; this.emit() }
  dispose(): void { this.disposed = true; this.epoch++; this.stopSession(); this.stopStorage?.(); this.seats.clear(); this.listeners.clear() }
}
