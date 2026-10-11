import {
  emptyTopicTerms, decodeTopicTermSnapshot, decodeTopicTermUserInput, putTopicTerm, putUserTopicTerm, adoptTopicTerm, disableTopicTerm, reconcileTopicTerms, queryTopicTerms, resolveTermEvidence,
  type TopicTermSnapshot, type TopicTermPut, type TopicTermUserInput, type TopicTermUserPut, type TermMutationResult, type TermEvidenceFact, type TopicTermQuery, type TermEvidenceRef,
} from '../memory/topic-terms.js'
import { SessionStore, type LocalStoragePort, type StructureLockPort, type HistoryVersion, type HistoryStatus } from './session-store.js'
import { SETTINGS_KEY, LEGACY_SETTINGS_KEY, parseSettings } from './sessions.js'
import { TOPIC_LOCK_NAME } from './topics.js'
import { isTextUnit } from './translation-history.js'
import { isDocumentEvidenceUnloaded } from './document-evidence.js'

export const TOPIC_TERMS_PREFIX = 'dsh-translation-plugin:topic-terms:v1:'
export function topicTermsKey(topicId: string): string { return `${TOPIC_TERMS_PREFIX}${encodeURIComponent(topicId)}` }
export interface TopicTermVersion {
  readonly ownerId: string
  readonly topicId: string
  readonly stored: string | null
  readonly current: string
}
export type TopicTermCommand = { readonly kind: 'put'; readonly input: TopicTermPut }
  | { readonly kind: 'user_put'; readonly input: TopicTermUserPut }
  | { readonly kind: 'adopt' | 'disable'; readonly id: string; readonly expectedEntryVersion: number }
interface Seat { snapshot: TopicTermSnapshot; stored: string | null; dirty: boolean; status: HistoryStatus }
function browserStorage(): LocalStoragePort | undefined { try { return typeof window === 'undefined' ? undefined : window.localStorage } catch { return undefined } }
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

  constructor(private readonly sessions: SessionStore, private readonly storage: LocalStoragePort | undefined = browserStorage(),
    listen?: (onChange: (key: string | null) => void) => () => void, private readonly locks: StructureLockPort | undefined = browserLocks()) {
    this.enabled = sessions.getSettings().rememberHistory
    this.load()
    this.stopSession = sessions.subscribe(() => this.sessionChanged())
    if (listen) this.stopStorage = listen(key => this.externalChange(key))
    else if (typeof window !== 'undefined' && storage) {
      const onChange = (event: StorageEvent): void => { if (event.storageArea === storage) this.externalChange(event.key) }
      window.addEventListener('storage', onChange); this.stopStorage = () => window.removeEventListener('storage', onChange)
    }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  getNotice(): string | undefined { return this.notice }
  getStatus(ownerId: string, topicId: string): HistoryStatus { return this.seat(ownerId, topicId).status }
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
          if (this.sessions.getTopics().some(topic => topic.id === snapshot.topicId) && !this.sessions.getTopics(snapshot.ownerId).some(topic => topic.id === snapshot.topicId)) throw new Error('topic owner mismatch')
          const current = this.reconcile(snapshot)
          this.seats.set(snapshot.topicId, { snapshot: current, stored: raw, dirty: current !== snapshot, status: current === snapshot ? 'saved' : 'memory' })
        } catch { this.notice = '部分主题术语无法读取，原副本已保留。' }
      }
    } catch { this.notice = '主题术语读取失败，原副本已保留。' }
  }
  private seat(ownerId: string, topicId: string): Seat {
    const existing = this.seats.get(topicId)
    if (existing) {
      if (existing.snapshot.ownerId !== ownerId) throw new Error('Topic term owner mismatch')
      return existing
    }
    const seat: Seat = { snapshot: emptyTopicTerms(ownerId, topicId, now()), stored: null, dirty: false, status: 'memory' }
    this.seats.set(topicId, seat); return seat
  }
  getSnapshot(ownerId: string, topicId: string): TopicTermSnapshot { return this.seat(ownerId, topicId).snapshot }
  readEvidenceAvailability(ownerId: string, topicId: string, ref: TermEvidenceRef): 'ready' | 'unloaded' | 'unavailable' {
    if (isDocumentEvidenceUnloaded(this.sessions, { ownerId, topicId }, ref)) return 'unloaded'
    return resolveTermEvidence({ ownerId, topicId }, ref, (sessionId, unitId) => this.readEvidence(sessionId, unitId)) !== undefined ? 'ready' : 'unavailable'
  }
  private reconcile(snapshot: TopicTermSnapshot): TopicTermSnapshot {
    return reconcileTopicTerms(snapshot, (sessionId, unitId) => this.readEvidence(sessionId, unitId), now(),
      ref => isDocumentEvidenceUnloaded(this.sessions, snapshot, ref))
  }
  readEvidence(sessionId: string, unitId: string): TermEvidenceFact | undefined {
    const session = this.sessions.getSession(sessionId), history = this.sessions.getTranslationHistory(sessionId)
    if (!session || !history || this.sessions.isSessionDeleted(sessionId) || this.sessions.getStatus(sessionId) === 'conflict') return undefined
    const unit = history.units.find(unit => unit.id === unitId)
    if (!unit || !isTextUnit(unit)) return undefined
    const revision = unit.final && unit.revisions.find(revision => revision.id === unit.final?.revisionId)
    const event = [...history.events].reverse().find(event => event.type === 'final.selected' && event.unitId === unit.id)
    return { ownerId: session.ownerId, topicId: session.topicId, sourceVersion: unit.sourceVersion, source: unit.source,
      final: revision && event?.revisionId === revision.id ? { revisionId: revision.id, selectionEventId: event.id, sourceVersion: revision.sourceVersion, text: revision.text } : null }
  }
  query(ownerId: string, topicId: string, query: Omit<TopicTermQuery, 'ownerId' | 'topicId'>): TopicTermSnapshot {
    const snapshot = this.getSnapshot(ownerId, topicId)
    return { ...snapshot, entries: this.getStatus(ownerId, topicId) === 'conflict' ? [] :
      queryTopicTerms(snapshot, { ...query, ownerId, topicId }, (sessionId, unitId) => this.readEvidence(sessionId, unitId)) }
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
    } catch { seat.status = 'error'; this.notice = '主题术语保存失败，当前修改仍保留在本次运行。'; return false }
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
    const seat = this.seat(ownerId, topicId), failure: TermMutationResult = { status: 'invalid', snapshot: seat.snapshot, entry: null }
    return this.locked(failure, () => {
      if (!this.sessions.getTopics(ownerId).some(topic => topic.id === topicId) || !this.currentRaw(seat) || seat.snapshot.version !== expectedVersion) {
        this.emit(); return { status: 'stale', snapshot: seat.snapshot, entry: null }
      }
      const result = command.kind === 'put' ? putTopicTerm(seat.snapshot, command.input, (sessionId, unitId) => this.readEvidence(sessionId, unitId), now()) :
        command.kind === 'user_put' ? putUserTopicTerm(seat.snapshot, command.input, { eventId: `term-user-save:${Date.now()}:${Math.random()}`, at: now() }) :
        command.kind === 'adopt' ? adoptTopicTerm(seat.snapshot, command.id, command.expectedEntryVersion, { eventId: `term-adoption:${Date.now()}:${Math.random()}`, at: now() }) :
          disableTopicTerm(seat.snapshot, command.id, command.expectedEntryVersion, now())
      if (result.snapshot !== seat.snapshot) { seat.snapshot = result.snapshot; seat.dirty = true; seat.status = 'memory'; this.notice = undefined; this.persistLocked(seat); this.emit() }
      return result
    })
  }
  async saveUserTerm(ownerId: string, topicId: string, expectedVersion: number, input: TopicTermUserInput): Promise<TermMutationResult> {
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
      return { ...scope, stored: seat.stored, current: JSON.stringify(seat.snapshot) }
    })
  }
  captureForSessions(ids: readonly string[]): readonly TopicTermVersion[] {
    return this.captureVersions(ids.flatMap(id => { const session = this.sessions.getSession(id); return session ? [{ ownerId: session.ownerId, topicId: session.topicId }] : [] }))
  }
  private matches(version: TopicTermVersion): boolean {
    const seat = this.seat(version.ownerId, version.topicId)
    return seat.status !== 'conflict' && seat.stored === version.stored && JSON.stringify(seat.snapshot) === version.current &&
      (this.storage?.getItem(topicTermsKey(version.topicId)) ?? null) === version.stored
  }
  private removeTopics(versions: readonly TopicTermVersion[]): boolean {
    const removed: string[] = [], failed: string[] = []
    for (const version of versions) {
      const seat = this.seat(version.ownerId, version.topicId)
      try {
        this.storage?.removeItem(topicTermsKey(version.topicId))
        seat.snapshot = { ...emptyTopicTerms(version.ownerId, version.topicId, now()), version: seat.snapshot.version + 1, activeVersion: seat.snapshot.activeVersion + (seat.snapshot.entries.some(entry => entry.status === 'active') ? 1 : 0) }
        seat.stored = null; seat.dirty = false; seat.status = 'memory'; removed.push(version.topicId)
      } catch { failed.push(version.topicId) }
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
          else { this.storage.removeItem(topicTermsKey(topicId)); seat.stored = null }
        }
        seat.snapshot = remove(seat.snapshot); seat.dirty = seat.stored === null ? seat.snapshot.entries.length > 0 : JSON.stringify(seat.snapshot) !== seat.stored; seat.status = seat.dirty ? 'memory' : 'saved'
        this.notice = undefined; this.emit(); return true
      } catch { this.notice = '术语删除失败，当前条目与剩余范围保留。'; this.emit(); return false }
    })
  }
}
