import {
  emptyTopicArchive, decodeTopicArchiveSnapshot, decodeTopicArchiveUserInput, putTopicArchive, putUserTopicArchive, adoptTopicArchive,
  disableTopicArchive, deleteTopicArchiveEntry, reconcileTopicArchive, queryTopicArchive,
  type TopicArchiveSnapshot, type TopicArchivePut, type TopicArchiveUserInput, type TopicArchiveUserPut, type ArchiveMutationResult, type TopicArchiveQuery,
} from '../memory/topic-archive.js'
import type { TermEvidenceResolver } from '../memory/topic-terms.js'
import { SessionStore, type LocalStoragePort, type StructureLockPort, type HistoryStatus } from './session-store.js'
import { SETTINGS_KEY, LEGACY_SETTINGS_KEY, parseSettings } from './sessions.js'
import { TOPIC_LOCK_NAME } from './topics.js'

export const TOPIC_ARCHIVE_PREFIX = 'dsh-translation-plugin:topic-archive:v1:'
export function topicArchiveKey(topicId: string): string { return `${TOPIC_ARCHIVE_PREFIX}${encodeURIComponent(topicId)}` }
export type TopicArchiveCommand = { readonly kind: 'put'; readonly input: TopicArchivePut }
  | { readonly kind: 'user_put'; readonly input: TopicArchiveUserPut }
  | { readonly kind: 'adopt' | 'disable'; readonly id: string; readonly expectedEntryVersion: number }
interface Seat { snapshot: TopicArchiveSnapshot; stored: string | null; dirty: boolean; status: HistoryStatus }
function browserStorage(): LocalStoragePort | undefined { try { return typeof window === 'undefined' ? undefined : window.localStorage } catch { return undefined } }
function browserLocks(): StructureLockPort | undefined {
  if (typeof navigator === 'undefined' || !navigator.locks) return undefined
  return { request: async <T>(name: string, action: () => T | Promise<T>): Promise<T> => await navigator.locks.request(name, async () => await action()) }
}
const now = (): string => new Date().toISOString()
const eventId = (kind: string): string => typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? `${kind}:${crypto.randomUUID()}` : `${kind}:${Date.now()}:${Math.random()}`

/** Independent structured snapshots share SessionStore scope, history policy and the terminology lock. */
export class TopicArchiveStore {
  private readonly seats = new Map<string, Seat>()
  private readonly listeners = new Set<() => void>()
  private readonly pending = new Map<string, Promise<boolean>>()
  private readonly stopSession: () => void
  private readonly stopStorage: (() => void) | undefined
  private enabled: boolean
  private notice: string | undefined
  private disposed = false

  constructor(private readonly sessions: SessionStore, private readonly resolver: TermEvidenceResolver, private readonly storage: LocalStoragePort | undefined = browserStorage(),
    listen?: (onChange: (key: string | null) => void) => () => void, private readonly locks: StructureLockPort | undefined = browserLocks()) {
    this.enabled = sessions.getSettings().rememberHistory
    this.load()
    this.stopSession = sessions.subscribe(() => this.sessionChanged())
    if (listen) this.stopStorage = listen(key => this.externalChange(key))
    else if (typeof window !== 'undefined' && storage) {
      const onChange = (event: StorageEvent): void => { if (event.storageArea === storage) this.externalChange(event.key) }
      window.addEventListener('storage', onChange); this.stopStorage = () => window.removeEventListener('storage', onChange)
    }
    if (this.enabled) for (const seat of this.seats.values()) if (seat.dirty) this.queuePersist(seat)
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
        if (!key?.startsWith(TOPIC_ARCHIVE_PREFIX)) continue
        try {
          const raw = this.storage.getItem(key), snapshot = raw === null ? undefined : decodeTopicArchiveSnapshot(JSON.parse(raw))
          if (!snapshot || topicArchiveKey(snapshot.topicId) !== key) throw new Error('invalid snapshot')
          if (this.sessions.getTopics().some(topic => topic.id === snapshot.topicId) && !this.sessions.getTopics(snapshot.ownerId).some(topic => topic.id === snapshot.topicId)) throw new Error('topic owner mismatch')
          const current = reconcileTopicArchive(snapshot, this.resolver, now())
          this.seats.set(snapshot.topicId, { snapshot: current, stored: raw, dirty: current !== snapshot, status: current === snapshot ? 'saved' : 'memory' })
        } catch { this.notice = '部分主题档案无法读取，原副本已保留。' }
      }
    } catch { this.notice = '主题档案读取失败，原副本已保留。' }
  }
  private seat(ownerId: string, topicId: string): Seat {
    const known = this.sessions.getTopics().some(topic => topic.id === topicId), owned = this.sessions.getTopics(ownerId).some(topic => topic.id === topicId)
    if (known && !owned) throw new Error('Topic archive owner mismatch')
    const existing = this.seats.get(topicId)
    if (existing) {
      if (existing.snapshot.ownerId !== ownerId) throw new Error('Topic archive owner mismatch')
      return existing
    }
    if (!owned) throw new Error('Unknown topic archive scope')
    const seat: Seat = { snapshot: emptyTopicArchive(ownerId, topicId, now()), stored: null, dirty: false, status: 'memory' }
    this.seats.set(topicId, seat); return seat
  }
  getSnapshot(ownerId: string, topicId: string): TopicArchiveSnapshot { return this.seat(ownerId, topicId).snapshot }
  query(ownerId: string, topicId: string, query: Omit<TopicArchiveQuery, 'ownerId' | 'topicId'>): TopicArchiveSnapshot {
    const seat = this.seat(ownerId, topicId)
    return { ...seat.snapshot, entries: seat.status === 'conflict' ? [] : queryTopicArchive(seat.snapshot, { ...query, ownerId, topicId }, this.resolver) }
  }
  private savingEnabled(): boolean {
    if (!this.storage) return false
    try {
      const settings = parseSettings(this.storage.getItem(SETTINGS_KEY), this.storage.getItem(LEGACY_SETTINGS_KEY))
      if (!settings) throw new Error('invalid settings')
      return settings.rememberHistory
    } catch { this.notice = '历史保存设置无法读取，主题档案仅保留在本次运行。'; return false }
  }
  private currentRaw(seat: Seat): boolean {
    if ((this.storage?.getItem(topicArchiveKey(seat.snapshot.topicId)) ?? null) === seat.stored) return true
    seat.status = 'conflict'; this.notice = '主题档案已在其他窗口变化或删除，当前内容保留，请读取最新副本后重试。'; return false
  }
  private persistLocked(seat: Seat): boolean {
    if (!seat.dirty) return true
    if (!this.savingEnabled()) { seat.status = 'memory'; return true }
    if (!this.storage || !this.locks) { seat.status = 'error'; this.notice = '主题档案保存需要本地存储和 Web Locks，当前内容仍保留。'; return false }
    try {
      if (!this.currentRaw(seat)) return false
      const raw = JSON.stringify(seat.snapshot)
      this.storage.setItem(topicArchiveKey(seat.snapshot.topicId), raw)
      seat.stored = raw; seat.dirty = false; seat.status = 'saved'; return true
    } catch { seat.status = 'error'; this.notice = '主题档案保存失败，当前修改仍保留在本次运行。'; return false }
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
    }).catch(() => { seat.status = 'error'; this.notice = '主题档案保存失败，当前修改仍保留。'; return false }).finally(() => {
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
      const next = reconcileTopicArchive(seat.snapshot, this.resolver, now()), invalidated = next !== seat.snapshot
      if (invalidated) { seat.snapshot = next; seat.dirty = true; if (seat.status !== 'conflict') seat.status = 'memory'; changed = true }
      if (enabled && (justEnabled || invalidated) && seat.dirty && seat.status !== 'conflict') this.queuePersist(seat)
    }
    if (changed || justEnabled) this.emit()
  }
  private async locked<T>(failure: T, action: () => T): Promise<T> {
    if (this.disposed) return failure
    if (!this.storage || !this.locks) return action()
    try { return await this.locks.request(TOPIC_LOCK_NAME, () => this.disposed ? failure : action()) }
    catch { this.notice = '主题档案操作失败，当前内容仍保留。'; this.emit(); return failure }
  }
  async apply(ownerId: string, topicId: string, expectedVersion: number, command: TopicArchiveCommand): Promise<ArchiveMutationResult> {
    const seat = this.seat(ownerId, topicId), failure: ArchiveMutationResult = { status: 'invalid', snapshot: seat.snapshot, entry: null }
    return this.locked(failure, () => {
      if (!this.currentRaw(seat) || seat.snapshot.version !== expectedVersion) { this.emit(); return { status: 'stale', snapshot: seat.snapshot, entry: null } }
      const result = command.kind === 'put' ? putTopicArchive(seat.snapshot, command.input, this.resolver, now()) :
        command.kind === 'user_put' ? putUserTopicArchive(seat.snapshot, command.input, this.resolver, { eventId: eventId('archive-user-save'), at: now() }) :
          command.kind === 'adopt' ? adoptTopicArchive(seat.snapshot, command.id, command.expectedEntryVersion, this.resolver, { eventId: eventId('archive-adoption'), at: now() }) :
            disableTopicArchive(seat.snapshot, command.id, command.expectedEntryVersion, now())
      const changed = result.snapshot !== seat.snapshot
      if (changed) { seat.snapshot = result.snapshot; seat.dirty = true; seat.status = 'memory'; this.notice = undefined }
      // A repeated explicit save retries a dirty snapshot without manufacturing a new semantic version.
      if ((result.status === 'updated' || result.status === 'unchanged') && seat.dirty) {
        this.notice = undefined
        const saved = this.persistLocked(seat)
        if (saved && seat.status === 'saved') this.notice = undefined
        this.emit()
        if (!saved) return { ...result, status: 'save_failed' }
      } else if (changed) this.emit()
      return result
    })
  }
  async saveUserEntry(ownerId: string, topicId: string, expectedVersion: number, input: TopicArchiveUserInput): Promise<ArchiveMutationResult> {
    const parsed = decodeTopicArchiveUserInput(input), snapshot = this.getSnapshot(ownerId, topicId)
    if (!parsed) return { status: 'invalid', snapshot, entry: null }
    let id = parsed.id
    if (id === null) { do { id = eventId('archive') } while (snapshot.entries.some(entry => entry.id === id)) }
    return this.apply(ownerId, topicId, expectedVersion, { kind: 'user_put', input: { ...parsed, id } })
  }
  reload(ownerId: string, topicId: string): boolean {
    const seat = this.seat(ownerId, topicId)
    try {
      const raw = this.storage?.getItem(topicArchiveKey(topicId)) ?? null, parsed = raw === null ? emptyTopicArchive(ownerId, topicId, now()) : decodeTopicArchiveSnapshot(JSON.parse(raw))
      if (!parsed || parsed.ownerId !== ownerId || parsed.topicId !== topicId) throw new Error('invalid topic archive')
      seat.snapshot = reconcileTopicArchive(parsed, this.resolver, now()); seat.stored = raw; seat.dirty = parsed !== seat.snapshot
      seat.status = seat.dirty ? 'memory' : raw === null ? 'memory' : 'saved'; this.notice = undefined
      if (this.enabled && seat.dirty) this.queuePersist(seat)
      this.emit(); return true
    } catch { seat.status = 'conflict'; this.notice = '最新主题档案无法读取，当前内容保留。'; this.emit(); return false }
  }
  private externalChange(key: string | null): void {
    if (this.disposed || (key !== null && !key.startsWith(TOPIC_ARCHIVE_PREFIX))) return
    for (const seat of this.seats.values()) {
      if (key !== null && key !== topicArchiveKey(seat.snapshot.topicId)) continue
      try {
        const raw = this.storage?.getItem(topicArchiveKey(seat.snapshot.topicId)) ?? null
        if (raw === seat.stored) continue
        if (!seat.dirty) this.reload(seat.snapshot.ownerId, seat.snapshot.topicId)
        else { seat.status = 'conflict'; this.notice = '主题档案已在其他窗口变化，当前修改保留，未覆盖另一窗口。' }
      } catch { seat.status = 'error'; this.notice = '主题档案读取失败，当前内容保留。' }
    }
    this.emit()
  }
  async deleteEntryAsync(ownerId: string, topicId: string, id: string, expectedVersion: number, expectedEntryVersion: number): Promise<boolean> {
    return this.locked(false, () => {
      const seat = this.seat(ownerId, topicId), entry = seat.snapshot.entries.find(entry => entry.id === id)
      if (seat.snapshot.version !== expectedVersion || entry?.version !== expectedEntryVersion || !this.currentRaw(seat)) return false
      const at = now()
      try {
        // Explicit deletion removes its saved item and marks saved dependents for review; temporary edits stay temporary.
        if (seat.stored !== null) {
          if (!this.storage || !this.locks) throw new Error('storage lock unavailable')
          const saved = decodeTopicArchiveSnapshot(JSON.parse(seat.stored))!, savedEntry = saved.entries.find(item => item.id === id)
          const next = savedEntry ? deleteTopicArchiveEntry(saved, id, savedEntry.version, at).snapshot : saved
          if (next.entries.length) { const raw = JSON.stringify(next); this.storage.setItem(topicArchiveKey(topicId), raw); seat.stored = raw }
          else { this.storage.removeItem(topicArchiveKey(topicId)); seat.stored = null }
        }
        seat.snapshot = deleteTopicArchiveEntry(seat.snapshot, id, expectedEntryVersion, at).snapshot
        seat.dirty = seat.stored === null ? seat.snapshot.entries.length > 0 : JSON.stringify(seat.snapshot) !== seat.stored; seat.status = seat.dirty ? 'memory' : 'saved'
        this.notice = undefined; this.emit(); return true
      } catch { this.notice = '档案删除失败，当前条目与剩余范围保留。'; this.emit(); return false }
    })
  }
}
