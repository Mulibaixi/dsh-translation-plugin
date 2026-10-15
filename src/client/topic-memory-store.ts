import { browserPluginStorage, isPluginStorageEvent } from './storage-fence.js'
import type { ReferenceEvidencePort } from '../shared/reference-memory.js'
import {
  emptyTopicTerms, decodeTopicTermSnapshot, decodeTopicTermPut, decodeTopicTermUserInput, putTopicTerm, putUserTopicTerm, adoptTopicTerm, disableTopicTerm, reconcileTopicTerms, queryTopicTerms, resolveTermEvidence, topicTermContentsConflict,
  type TopicTermSnapshot, type TopicTermPut, type TopicTermUserInput, type TopicTermUserPut, type TermMutationResult, type TermEvidenceFact, type TopicTermQuery, type TermEvidenceRef,
} from '../memory/topic-terms.js'
import { SessionStore, type LocalStoragePort, type StructureLockPort, type HistoryVersion, type HistoryStatus } from './session-store.js'
import { SETTINGS_KEY, LEGACY_SETTINGS_KEY, parseSettings } from './sessions.js'
import { TOPIC_LOCK_NAME } from './topics.js'
import { currentFinalRevision, isTextUnit } from './translation-history.js'
import { cachedTopicEvidence, isTopicEvidenceUnloaded, prepareTopicEvidence } from './topic-evidence.js'
import { TranslationSourceReader, type TranslationEvidenceReader } from './source-reader.js'
import type { EvidenceReadResult } from '../shared/translation-evidence.js'
import { storageSaveFailureMessage } from './storage-errors.js'

export const TOPIC_TERMS_PREFIX = 'dsh-translation-plugin:topic-terms:v1:'
export function topicTermsKey(topicId: string): string { return `${TOPIC_TERMS_PREFIX}${encodeURIComponent(topicId)}` }
export interface TopicTermVersion {
  readonly ownerId: string
  readonly topicId: string
  readonly stored: string | null
  readonly current: string
}
export interface TopicTermClearVersion extends TopicTermVersion {
  readonly storageAvailable: boolean
  readonly version: number
  readonly currentCount: number
  readonly storedCount: number
}
export type TopicTermCommand = { readonly kind: 'put'; readonly input: TopicTermPut }
  | { readonly kind: 'user_put'; readonly input: TopicTermUserPut }
  | { readonly kind: 'adopt' | 'disable'; readonly id: string; readonly expectedEntryVersion: number }
interface Seat { snapshot: TopicTermSnapshot; stored: string | null; dirty: boolean; status: HistoryStatus }
const browserStorage = browserPluginStorage
function browserLocks(): StructureLockPort | undefined {
  if (typeof navigator === 'undefined' || !navigator.locks) return undefined
  return { request: async <T>(name: string, action: () => T | Promise<T>): Promise<T> => await navigator.locks.request(name, async () => await action()) }
}
const now = (): string => new Date().toISOString()

/** One browser terminology snapshot per stable topic; SessionStore remains the source/final authority. */
export class TopicMemoryStore {
  private readonly seats = new Map<string, Seat>()
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Map<string, Promise<boolean>>()
  private readonly stopSession: () => void
  private readonly stopStorage: (() => void) | undefined
  private enabled: boolean
  private notice: string | undefined
  private disposed = false
  private referenceEvidence: ReferenceEvidencePort | undefined
  setReferenceEvidence(port: ReferenceEvidencePort): void { this.referenceEvidence = port }
  private evidenceReader: TranslationEvidenceReader | undefined

  constructor(private readonly sessions: SessionStore, private readonly storage: LocalStoragePort | undefined = browserStorage(),
    listen?: (onChange: (key: string | null) => void) => () => void, private readonly locks: StructureLockPort | undefined = browserLocks()) {
    this.enabled = sessions.getSettings().rememberHistory
    this.load()
    this.stopSession = sessions.subscribe(() => this.sessionChanged())
    if (listen) this.stopStorage = listen(key => this.externalChange(key))
    else if (typeof window !== 'undefined' && storage) {
      const onChange = (event: StorageEvent): void => { if (isPluginStorageEvent(event, storage)) this.externalChange(event.key) }
      window.addEventListener('storage', onChange); this.stopStorage = () => window.removeEventListener('storage', onChange)
    }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  getNotice(): string | undefined { return this.notice }
  getStatus(ownerId: string, topicId: string): HistoryStatus { return this.seat(ownerId, topicId).status }
  setEvidenceReader(reader: TranslationEvidenceReader | undefined): void { this.evidenceReader = reader }
  dispose(): void { this.disposed = true; this.stopSession(); this.stopStorage?.(); this.listeners.clear(); this.seats.clear() }

  private load(): void {
    if (!this.storage) return
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i)
        if (!key?.startsWith(TOPIC_TERMS_PREFIX)) continue
        try {
          const raw = this.storage.getItem(key), snapshot = raw === null ? undefined : decodeTopicTermSnapshot(JSON.parse(raw))
          if (!snapshot || topicTermsKey(snapshot.topicId) !== key) throw new Error('invalid snapshot')
          if (this.sessions.getTopicAssetOwner(snapshot.topicId) !== undefined && this.sessions.getTopicAssetOwner(snapshot.topicId) !== snapshot.ownerId) throw new Error('topic owner mismatch')
          const current = this.reconcile(snapshot)
          this.seats.set(snapshot.topicId, { snapshot: current, stored: raw, dirty: current !== snapshot, status: current === snapshot ? 'saved' : 'memory' })
        } catch { this.notice = '部分主题术语无法读取，原副本已保留。' }
      }
    } catch { this.notice = '主题术语读取失败，原副本已保留。' }
  }
  private seat(ownerId: string, topicId: string): Seat {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const existing = this.seats.get(topicId)
    if (existing) {
      if (existing.snapshot.ownerId !== ownerId) throw new Error('Topic term owner mismatch')
      return existing
    }
    const seat: Seat = { snapshot: emptyTopicTerms(ownerId, topicId, now()), stored: null, dirty: false, status: 'memory' }
    this.seats.set(topicId, seat); return seat
  }
  getSnapshot(ownerId: string, topicId: string): TopicTermSnapshot { return this.seat(ownerId, topicId).snapshot }
  /** Preparation freezes only the current authoritative topic version under the shared lock. */
  isSnapshotCurrent(snapshot: TopicTermSnapshot): boolean {
    const seat = this.seats.get(snapshot.topicId)
    return !this.disposed && !!seat && seat.status !== 'conflict' && seat.snapshot.ownerId === snapshot.ownerId &&
      JSON.stringify(seat.snapshot) === JSON.stringify(snapshot) && this.currentRaw(seat) &&
      this.sessions.getTopics(snapshot.ownerId).some(topic => topic.id === snapshot.topicId)
  }
  readEvidenceAvailability(ownerId: string, topicId: string, ref: TermEvidenceRef): 'ready' | 'unloaded' | 'unavailable' {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    if (isTopicEvidenceUnloaded(this.sessions, { ownerId, topicId }, ref)) return 'unloaded'
    return resolveTermEvidence({ ownerId, topicId }, ref, (sessionId, unitId) => this.readEvidence(sessionId, unitId)) !== undefined ? 'ready' : 'unavailable'
  }
  private reconcile(snapshot: TopicTermSnapshot): TopicTermSnapshot {
    return reconcileTopicTerms(snapshot, (sessionId, unitId) => this.readEvidence(sessionId, unitId), now(),
      ref => isTopicEvidenceUnloaded(this.sessions, snapshot, ref))
  }
  /** Explicit UI range reads use the same identity and bounds as mutation evidence. */
  async readEvidenceAsync(ownerId: string, topicId: string, ref: TermEvidenceRef): Promise<EvidenceReadResult> {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const reader = this.evidenceReader ?? new TranslationSourceReader({ sessions: this.sessions })
    const captured = reader.capture(ownerId, topicId, structuredClone(ref))
    if ('status' in captured) return captured
    try { return await reader.read(captured) }
    catch { return { status: 'unloaded', request: captured, reason: 'transport_unavailable' } }
  }
  readReferenceAsync(ownerId:string,topicId:string,ref:import('../shared/reference-memory.js').ReferenceEvidenceRef){return this.referenceEvidence?.view?.({ownerId,topicId},ref) ?? Promise.resolve(undefined)}
  readEvidence(sessionId: string, unitId: string): TermEvidenceFact | undefined {
    const session = this.sessions.getSession(sessionId), history = this.sessions.getTranslationHistory(sessionId)
    if (!session || !history || this.sessions.isSessionDeleted(sessionId) || this.sessions.getStatus(sessionId) === 'conflict') return undefined
    const unit = history.units.find(unit => unit.id === unitId)
    if (!unit || !isTextUnit(unit)) return undefined
    const revision = currentFinalRevision(unit)
    const event = [...history.events].reverse().find(event => event.type === 'final.selected' && event.unitId === unit.id)
    return { ownerId: session.ownerId, topicId: session.topicId, sourceVersion: unit.sourceVersion, source: unit.source,
      final: revision && event?.revisionId === revision.id ? { revisionId: revision.id, selectionEventId: event.id, sourceVersion: revision.sourceVersion, text: revision.text } : null }
  }
  query(ownerId: string, topicId: string, query: Omit<TopicTermQuery, 'ownerId' | 'topicId'>): TopicTermSnapshot {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const snapshot = this.getSnapshot(ownerId, topicId)
    return { ...snapshot, entries: this.getStatus(ownerId, topicId) === 'conflict' ? [] :
      queryTopicTerms(snapshot, { ...query, ownerId, topicId }, cachedTopicEvidence((sessionId, unitId) => this.readEvidence(sessionId, unitId), this.referenceEvidence)) }
  }
  async queryAsync(ownerId: string, topicId: string, query: Omit<TopicTermQuery, 'ownerId' | 'topicId'>): Promise<TopicTermSnapshot> {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const fixed = structuredClone(query), seat = this.seat(ownerId, topicId), snapshot = seat.snapshot, reader = this.evidenceReader
    if (fixed.mode !== 'normal' || seat.status === 'conflict') return { ...snapshot, entries: [] }
    const entries = snapshot.entries.filter(entry => entry.status === 'active' && entry.origin !== 'user_explicit' &&
      entry.sourceLanguage === fixed.sourceLanguage && entry.targetLanguage === fixed.targetLanguage &&
      [...entry.sourceForms, ...entry.aliases].some(form => fixed.forms.includes(form)))
    const prepared = await prepareTopicEvidence(this.sessions, snapshot, entries.flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis')),
      (sessionId, unitId) => this.readEvidence(sessionId, unitId), reader, this.referenceEvidence)
    if (this.disposed || reader !== this.evidenceReader || !prepared.isCurrent() || seat.snapshot !== snapshot || this.getStatus(ownerId, topicId) === 'conflict' || !this.currentRaw(seat) ||
      !this.sessions.getTopics(ownerId).some(topic => topic.id === topicId)) return { ...seat.snapshot, entries: [] }
    return { ...snapshot, entries: queryTopicTerms(snapshot, { ...fixed, ownerId, topicId }, prepared.resolver) }
  }
  async reconcileAsync(ownerId: string, topicId: string): Promise<TopicTermSnapshot> {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const seat = this.seat(ownerId, topicId), snapshot = seat.snapshot, reader = this.evidenceReader
    const prepared = await prepareTopicEvidence(this.sessions, snapshot, snapshot.entries.filter(entry =>
      entry.origin !== 'user_explicit' && entry.status !== 'disabled' && entry.status !== 'review_required').flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis')),
      (sessionId, unitId) => this.readEvidence(sessionId, unitId), reader, this.referenceEvidence)
    return this.locked(seat.snapshot, () => {
      if (reader !== this.evidenceReader || seat.snapshot !== snapshot || !prepared.isCurrent() || !this.currentRaw(seat) ||
        !this.sessions.getTopics(ownerId).some(topic => topic.id === topicId)) return seat.snapshot
      const next = reconcileTopicTerms(snapshot, prepared.resolver, now(), prepared.isUnloaded)
      if (next !== snapshot) { seat.snapshot = next; seat.dirty = true; seat.status = 'memory'; this.persistLocked(seat); this.emit() }
      return seat.snapshot
    })
  }
  private savingEnabled(): boolean {
    if (!this.storage) return false
    try {
      const settings = parseSettings(this.storage.getItem(SETTINGS_KEY), this.storage.getItem(LEGACY_SETTINGS_KEY))
      if (!settings) throw new Error('invalid settings')
      return settings.rememberHistory
    } catch { this.notice = '历史保存设置无法读取，主题术语仅保留在本次运行。'; return false }
  }
  private currentRaw(seat: Seat): boolean {
    if ((this.storage?.getItem(topicTermsKey(seat.snapshot.topicId)) ?? null) === seat.stored) return true
    seat.status = 'conflict'; this.notice = '主题术语已在其他窗口变化或删除，当前内容保留，请读取最新副本后重试。'; return false
  }
  private persistLocked(seat: Seat): boolean {
    if (!seat.dirty || !this.savingEnabled()) return true
    if (!this.storage || !this.locks) { seat.status = 'error'; this.notice = '主题术语保存需要本地存储和 Web Locks，当前内容仍保留。'; return false }
    try {
      if (!this.currentRaw(seat)) return false
      const raw = JSON.stringify(seat.snapshot)
      this.storage.setItem(topicTermsKey(seat.snapshot.topicId), raw)
      seat.stored = raw; seat.dirty = false; seat.status = 'saved'; return true
    } catch (error) { seat.status = 'error'; this.notice = storageSaveFailureMessage(error, '主题术语', '主题术语保存失败，当前修改仍保留在本次运行。'); return false }
  }
  private queuePersist(seat: Seat): void {
    const id = seat.snapshot.topicId
    if (this.pending.has(id) || !this.locks || !this.storage || !seat.dirty) return
    let wrote = false
    const promise = this.locks.request(TOPIC_LOCK_NAME, () => {
      if (this.disposed) return false
      const needed = seat.dirty, result = this.persistLocked(seat)
      wrote = needed && result && !seat.dirty
      return result
    }).catch(() => {
      seat.status = 'error'; this.notice = '主题术语保存失败，当前修改仍保留。'; return false
    }).finally(() => {
      if (this.pending.get(id) !== promise) return
      this.pending.delete(id); this.emit()
      if (wrote && !this.disposed && seat.dirty && seat.status === 'memory' && this.enabled) this.queuePersist(seat)
    })
    this.pending.set(id, promise)
  }
  private sessionChanged(): void {
    if (this.disposed) return
    const enabled = this.sessions.getSettings().rememberHistory, justEnabled = enabled && !this.enabled
    this.enabled = enabled
    let changed = false
    for (const seat of this.seats.values()) {
      const next = this.reconcile(seat.snapshot)
      const invalidated = next !== seat.snapshot
      if (invalidated) { seat.snapshot = next; seat.dirty = true; if (seat.status !== 'conflict') seat.status = 'memory'; changed = true }
      if (enabled && (justEnabled || invalidated) && seat.dirty && seat.status !== 'conflict') this.queuePersist(seat)
    }
    if (changed || justEnabled) this.emit()
  }
  private async locked<T>(failure: T, action: () => T): Promise<T> {
    if (this.disposed) return failure
    if (!this.storage || !this.locks) return action()
    try { return await this.locks.request(TOPIC_LOCK_NAME, () => this.disposed ? failure : action()) }
    catch { this.notice = '主题术语操作失败，当前内容仍保留。'; this.emit(); return failure }
  }
  async apply(ownerId: string, topicId: string, expectedVersion: number, command: TopicTermCommand): Promise<TermMutationResult> {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const seat = this.seat(ownerId, topicId), failure: TermMutationResult = { status: 'invalid', snapshot: seat.snapshot, entry: null }
    const fixed: TopicTermCommand = structuredClone(command), reader = this.evidenceReader
    if (fixed.kind === 'put' && !decodeTopicTermPut(fixed.input)) return failure
    if (seat.snapshot.version !== expectedVersion) return { status: 'stale', snapshot: seat.snapshot, entry: null }
    const refs = fixed.kind === 'put' ? [...fixed.input.evidence, ...seat.snapshot.entries.filter(entry =>
      fixed.input.status === 'active' && entry.id !== fixed.input.id && entry.status === 'active' && entry.origin !== 'user_explicit' &&
      topicTermContentsConflict(entry, fixed.input)).flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis'))] : []
    const prepared = await prepareTopicEvidence(this.sessions, seat.snapshot, refs, (sessionId, unitId) => this.readEvidence(sessionId, unitId), reader, this.referenceEvidence)
    return this.locked(failure, () => {
      if (reader !== this.evidenceReader || !prepared.isCurrent() || !this.sessions.getTopics(ownerId).some(topic => topic.id === topicId) || !this.currentRaw(seat) || seat.snapshot.version !== expectedVersion) {
        this.emit(); return { status: 'stale', snapshot: seat.snapshot, entry: null }
      }
      const result = fixed.kind === 'put' ? putTopicTerm(seat.snapshot, fixed.input, prepared.resolver, now()) :
        fixed.kind === 'user_put' ? putUserTopicTerm(seat.snapshot, fixed.input, { eventId: `term-user-save:${Date.now()}:${Math.random()}`, at: now() }) :
        fixed.kind === 'adopt' ? adoptTopicTerm(seat.snapshot, fixed.id, fixed.expectedEntryVersion, { eventId: `term-adoption:${Date.now()}:${Math.random()}`, at: now() }) :
          disableTopicTerm(seat.snapshot, fixed.id, fixed.expectedEntryVersion, now())
      if (result.snapshot !== seat.snapshot) { seat.snapshot = result.snapshot; seat.dirty = true; seat.status = 'memory'; this.notice = undefined; this.persistLocked(seat); this.emit() }
      return result
    })
  }
  async saveUserTerm(ownerId: string, topicId: string, expectedVersion: number, input: TopicTermUserInput): Promise<TermMutationResult> {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const parsed = decodeTopicTermUserInput(input), snapshot = this.getSnapshot(ownerId, topicId)
    if (!parsed) return { status: 'invalid', snapshot, entry: null }
    let id = parsed.id
    if (id === null) {
      do {
        id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? `term:${crypto.randomUUID()}` : `term:${Date.now()}:${Math.random()}`
      } while (snapshot.entries.some(entry => entry.id === id))
    }
    return this.apply(ownerId, topicId, expectedVersion, { kind: 'user_put', input: { ...parsed, id } })
  }
  reload(ownerId: string, topicId: string): boolean {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const seat = this.seat(ownerId, topicId)
    try {
      const raw = this.storage?.getItem(topicTermsKey(topicId)) ?? null
      const parsed = raw === null ? emptyTopicTerms(ownerId, topicId, now()) : decodeTopicTermSnapshot(JSON.parse(raw))
      if (!parsed || parsed.ownerId !== ownerId || parsed.topicId !== topicId) throw new Error('invalid topic terms')
      seat.snapshot = this.reconcile(parsed)
      seat.stored = raw; seat.dirty = parsed !== seat.snapshot; seat.status = seat.dirty ? 'memory' : 'saved'; this.notice = undefined; this.emit(); return true
    } catch { seat.status = 'conflict'; this.notice = '最新主题术语无法读取，当前内容保留。'; this.emit(); return false }
  }
  private externalChange(key: string | null): void {
    if (this.disposed || (key !== null && !key.startsWith(TOPIC_TERMS_PREFIX))) return
    for (const seat of this.seats.values()) {
      if (key !== null && key !== topicTermsKey(seat.snapshot.topicId)) continue
      try {
        const raw = this.storage?.getItem(topicTermsKey(seat.snapshot.topicId)) ?? null
        if (raw === seat.stored) continue
        if (!seat.dirty) this.reload(seat.snapshot.ownerId, seat.snapshot.topicId)
        else { seat.status = 'conflict'; this.notice = '主题术语已在其他窗口变化，当前修改保留，未覆盖另一窗口。' }
      } catch { seat.status = 'error'; this.notice = '主题术语读取失败，当前内容保留。' }
    }
    this.emit()
  }
  captureVersions(scopes: readonly { readonly ownerId: string; readonly topicId: string }[]): readonly TopicTermVersion[] {
    return [...new Map(scopes.map(scope => [scope.topicId, scope])).values()].map(scope => {
      const seat = this.seat(scope.ownerId, scope.topicId)
      return { ownerId: seat.snapshot.ownerId, topicId: scope.topicId, stored: seat.stored, current: JSON.stringify(seat.snapshot) }
    })
  }
  captureForSessions(ids: readonly string[]): readonly TopicTermVersion[] {
    return this.captureVersions(ids.flatMap(id => { const session = this.sessions.getSession(id); return session ? [{ ownerId: session.ownerId, topicId: session.topicId }] : [] }))
  }
  captureClearVersion(ownerId: string, topicId: string): TopicTermClearVersion {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const seat = this.seat(ownerId, topicId), saved = seat.stored === null ? null : decodeTopicTermSnapshot(JSON.parse(seat.stored))
    const version = { ownerId, topicId, stored: seat.stored, current: JSON.stringify(seat.snapshot), version: seat.snapshot.version, storageAvailable: !!this.storage,
      currentCount: seat.snapshot.entries.length, storedCount: saved?.entries.length ?? 0 }
    if (!this.isClearVersionCurrent(version)) throw new Error('Topic terms have changed; reload before clearing')
    return version
  }
  isClearVersionCurrent(version: TopicTermVersion): boolean {
    try { return !this.disposed && this.sessions.getTopics(version.ownerId).some(topic => topic.id === version.topicId) && this.matches(version) }
    catch { return false }
  }
  /** The clearing coordinator takes this existing topic lock once for both asset stores. */
  async withTopicLock<T>(action: () => T): Promise<T> {
    if (this.disposed || this.storage && !this.locks) throw new Error('Topic storage lock is unavailable')
    return this.storage && this.locks ? this.locks.request(TOPIC_LOCK_NAME, () => {
      if (this.disposed) throw new Error('Topic memory store is disposed')
      return action()
    }) : action()
  }
  /** Caller holds TOPIC_LOCK_NAME. Explicit clearing persists a content-free version barrier even with history off. */
  clearLocked(version: TopicTermVersion): boolean {
    if (!this.isClearVersionCurrent(version)) return false
    const seat = this.seat(version.ownerId, version.topicId)
    try {
      if (this.storage && !this.locks) throw new Error('storage lock unavailable')
      const saved = seat.stored === null ? null : decodeTopicTermSnapshot(JSON.parse(seat.stored))
      const snapshot: TopicTermSnapshot = { ...emptyTopicTerms(version.ownerId, version.topicId, now()),
        version: Math.max(seat.snapshot.version, saved?.version ?? 0) + 1,
        activeVersion: Math.max(seat.snapshot.activeVersion, saved?.activeVersion ?? 0) +
          (seat.snapshot.entries.some(entry => entry.status === 'active') || saved?.entries.some(entry => entry.status === 'active') ? 1 : 0) }
      const raw = JSON.stringify(snapshot)
      this.storage?.setItem(topicTermsKey(version.topicId), raw)
      seat.snapshot = snapshot; seat.stored = this.storage ? raw : null; seat.dirty = false; seat.status = this.storage ? 'saved' : 'memory'
      this.notice = undefined; this.emit(); return true
    } catch { this.notice = '主题术语清空失败，该范围的当前与已保存内容保留。'; this.emit(); return false }
  }
  private matches(version: TopicTermVersion): boolean {
    const seat = this.seat(version.ownerId, version.topicId)
    return seat.status !== 'conflict' && seat.stored === version.stored && JSON.stringify(seat.snapshot) === version.current &&
      (this.storage?.getItem(topicTermsKey(version.topicId)) ?? null) === version.stored
  }
  private removeTopics(versions: readonly TopicTermVersion[]): boolean {
    const removed: string[] = [], failed: string[] = []
    for (const version of versions) {
      if (this.clearLocked(version)) removed.push(version.topicId)
      else failed.push(version.topicId)
    }
    this.notice = failed.length ? `主题术语清理未完成：已删除 ${removed.length} 个主题，未删除 ${failed.length} 个主题（${failed.join('、')}）。` : undefined
    this.emit(); return failed.length === 0
  }
  async deleteHistoryAsync(ids: readonly string[], unreadable: readonly { readonly key: string; readonly raw: string }[], expectedHistory: readonly HistoryVersion[], termVersions: readonly TopicTermVersion[] = []): Promise<boolean> {
    if (!termVersions.length) return this.sessions.deleteHistoryAsync(ids, false, unreadable, expectedHistory)
    // The UI freezes one scope per selected topic. Never let this helper remove unrelated assets.
    const scopes = this.captureForSessions(ids)
    if (termVersions.some(version => !scopes.some(scope => scope.ownerId === version.ownerId && scope.topicId === version.topicId))) return false
    return this.sessions.deleteHistoryAsync(ids, false, unreadable, expectedHistory, {
      requiresStorage: termVersions.some(version => version.stored !== null),
      preflight: () => termVersions.every(version => this.matches(version)),
      afterHistoryDeleted: () => this.removeTopics(termVersions),
    })
  }
  async deleteEntryAsync(ownerId: string, topicId: string, id: string, expectedVersion: number, expectedEntryVersion: number): Promise<boolean> {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    return this.locked(false, () => {
      const seat = this.seat(ownerId, topicId), entry = seat.snapshot.entries.find(entry => entry.id === id)
      if (seat.snapshot.version !== expectedVersion || entry?.version !== expectedEntryVersion || !this.currentRaw(seat)) return false
      const remove = (snapshot: TopicTermSnapshot): TopicTermSnapshot => ({ ...snapshot, entries: snapshot.entries.filter(entry => entry.id !== id), version: snapshot.version + 1,
        activeVersion: snapshot.activeVersion + (snapshot.entries.some(entry => entry.id === id && entry.status === 'active') ? 1 : 0), updatedAt: now() })
      try {
        // Explicit deletion changes only the saved item; other history-off edits remain temporary.
        if (seat.stored !== null) {
          if (!this.storage || !this.locks) throw new Error('storage lock unavailable')
          const saved = decodeTopicTermSnapshot(JSON.parse(seat.stored))!
          const next = saved.entries.some(entry => entry.id === id) ? remove(saved) : saved
          if (next.entries.length) { const raw = JSON.stringify(next); this.storage.setItem(topicTermsKey(topicId), raw); seat.stored = raw }
          else {
            const barrier = { ...next, version: Math.max(next.version, seat.snapshot.version + 1),
              activeVersion: Math.max(next.activeVersion, seat.snapshot.activeVersion + (entry.status === 'active' ? 1 : 0)) }
            const raw = JSON.stringify(barrier); this.storage.setItem(topicTermsKey(topicId), raw); seat.stored = raw
          }
        }
        seat.snapshot = remove(seat.snapshot); seat.dirty = seat.stored === null ? seat.snapshot.entries.length > 0 : JSON.stringify(seat.snapshot) !== seat.stored; seat.status = seat.dirty ? 'memory' : 'saved'
        this.notice = undefined; this.emit(); return true
      } catch { this.notice = '术语删除失败，当前条目与剩余范围保留。'; this.emit(); return false }
    })
  }
}
