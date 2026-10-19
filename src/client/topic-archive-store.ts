import { browserPluginStorage, isPluginStorageEvent } from './storage-fence.js'
import type { ReferenceEvidencePort } from '../shared/reference-memory.js'
import {
  emptyTopicArchive, decodeTopicArchiveSnapshot, decodeTopicArchivePut, decodeTopicArchiveUserInput, putTopicArchive, putUserTopicArchive, adoptTopicArchive, acceptTopicArchiveProposal,
  disableTopicArchive, deleteTopicArchiveEntry, reconcileTopicArchive, queryTopicArchive, referencedEntityIds,
  type TopicArchiveSnapshot, type TopicArchivePut, type TopicArchiveUserInput, type TopicArchiveUserPut, type ArchiveMutationResult, type TopicArchiveQuery,
} from '../memory/topic-archive.js'
import type { TermEvidenceResolver, FileProposalAcceptance } from '../memory/topic-terms.js'
import { SessionStore, type LocalStoragePort, type StructureLockPort, type HistoryStatus } from './session-store.js'
import { SETTINGS_KEY, LEGACY_SETTINGS_KEY, parseSettings } from './sessions.js'
import { TOPIC_LOCK_NAME } from './topics.js'
import { cachedTopicEvidence, isTopicEvidenceUnloaded, prepareTopicEvidence } from './topic-evidence.js'
import type { TranslationEvidenceReader } from './source-reader.js'
import { storageSaveFailureMessage } from './storage-errors.js'

export const TOPIC_ARCHIVE_PREFIX = 'dsh-translation-plugin:topic-archive:v1:'
export function topicArchiveKey(topicId: string): string { return `${TOPIC_ARCHIVE_PREFIX}${encodeURIComponent(topicId)}` }
export interface TopicArchiveVersion {
  readonly storageAvailable: boolean
  readonly ownerId: string
  readonly topicId: string
  readonly stored: string | null
  readonly current: string
  readonly version: number
  readonly currentCount: number
  readonly storedCount: number
}
export type TopicArchiveCommand = { readonly kind: 'put'; readonly input: TopicArchivePut }
  | { readonly kind: 'accept_file_proposal'; readonly input: TopicArchivePut; readonly acceptance: FileProposalAcceptance }
  | { readonly kind: 'revise_file_proposal'; readonly input: TopicArchivePut; readonly acceptance: FileProposalAcceptance }
  | { readonly kind: 'user_put'; readonly input: TopicArchiveUserPut }
  | { readonly kind: 'adopt' | 'disable'; readonly id: string; readonly expectedEntryVersion: number }
interface Seat { snapshot: TopicArchiveSnapshot; stored: string | null; dirty: boolean; status: HistoryStatus }
const browserStorage = browserPluginStorage
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
  private referenceEvidence: ReferenceEvidencePort | undefined
  setReferenceEvidence(port: ReferenceEvidencePort): void { this.referenceEvidence = port }
  private evidenceReader: TranslationEvidenceReader | undefined

  constructor(private readonly sessions: SessionStore, private readonly resolver: TermEvidenceResolver, private readonly storage: LocalStoragePort | undefined = browserStorage(),
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
        if (!key?.startsWith(TOPIC_ARCHIVE_PREFIX)) continue
        try {
          const raw = this.storage.getItem(key), snapshot = raw === null ? undefined : decodeTopicArchiveSnapshot(JSON.parse(raw))
          if (!snapshot || topicArchiveKey(snapshot.topicId) !== key) throw new Error('invalid snapshot')
          if (this.sessions.getTopicAssetOwner(snapshot.topicId) !== undefined && this.sessions.getTopicAssetOwner(snapshot.topicId) !== snapshot.ownerId) throw new Error('topic owner mismatch')
          const current = this.reconcile(snapshot)
          this.seats.set(snapshot.topicId, { snapshot: current, stored: raw, dirty: current !== snapshot, status: current === snapshot ? 'saved' : 'memory' })
        } catch { this.notice = '部分主题档案无法读取，原副本已保留。' }
      }
    } catch { this.notice = '主题档案读取失败，原副本已保留。' }
  }
  private seat(ownerId: string, topicId: string): Seat {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const known = this.sessions.getTopics().some(topic => topic.id === topicId)
    const existing = this.seats.get(topicId)
    if (existing) {
      if (existing.snapshot.ownerId !== ownerId) throw new Error('Topic archive owner mismatch')
      return existing
    }
    if (!known) throw new Error('Unknown topic archive scope')
    const seat: Seat = { snapshot: emptyTopicArchive(ownerId, topicId, now()), stored: null, dirty: false, status: 'memory' }
    this.seats.set(topicId, seat); return seat
  }
  getSnapshot(ownerId: string, topicId: string): TopicArchiveSnapshot { return this.seat(ownerId, topicId).snapshot }
  private reconcile(snapshot: TopicArchiveSnapshot): TopicArchiveSnapshot {
    return reconcileTopicArchive(snapshot, this.resolver, now(), ref => isTopicEvidenceUnloaded(this.sessions, snapshot, ref))
  }
  query(ownerId: string, topicId: string, query: Omit<TopicArchiveQuery, 'ownerId' | 'topicId'>): TopicArchiveSnapshot {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const seat = this.seat(ownerId, topicId)
    return { ...seat.snapshot, entries: seat.status === 'conflict' ? [] : queryTopicArchive(seat.snapshot, { ...query, ownerId, topicId }, cachedTopicEvidence(this.resolver, this.referenceEvidence)) }
  }
  async queryAsync(ownerId: string, topicId: string, query: Omit<TopicArchiveQuery, 'ownerId' | 'topicId'>): Promise<TopicArchiveSnapshot> {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const fixed = structuredClone(query), seat = this.seat(ownerId, topicId), snapshot = seat.snapshot, reader = this.evidenceReader
    if (fixed.mode !== 'normal' || seat.status === 'conflict') return { ...snapshot, entries: [] }
    const candidates = snapshot.entries.filter(entry => {
      if (entry.status !== 'active' || !fixed.kinds.includes(entry.kind)) return false
      const labels = entry.kind === 'entity' ? [entry.name, ...entry.aliases] : entry.kind === 'fact' ? [entry.title] : [entry.relation]
      for (const id of referencedEntityIds(entry)) {
        const entity = snapshot.entries.find(item => item.id === id)
        if (entity?.kind === 'entity') labels.push(entity.name, ...entity.aliases)
      }
      return labels.some(label => fixed.forms.includes(label))
    })
    const dependencyIds = new Set(candidates.flatMap(referencedEntityIds))
    const needed = [...candidates, ...snapshot.entries.filter(entry => dependencyIds.has(entry.id))]
    const prepared = await prepareTopicEvidence(this.sessions, snapshot, needed.filter(entry => entry.origin !== 'user_explicit').flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis')), this.resolver, reader, this.referenceEvidence)
    if (this.disposed || reader !== this.evidenceReader || !prepared.isCurrent() || seat.snapshot !== snapshot || this.getStatus(ownerId, topicId) === 'conflict' || !this.currentRaw(seat) ||
      !this.sessions.getTopics(ownerId).some(topic => topic.id === topicId)) return { ...seat.snapshot, entries: [] }
    return { ...snapshot, entries: queryTopicArchive(snapshot, { ...fixed, ownerId, topicId }, prepared.resolver) }
  }
  async reconcileAsync(ownerId: string, topicId: string): Promise<TopicArchiveSnapshot> {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const seat = this.seat(ownerId, topicId), snapshot = seat.snapshot, reader = this.evidenceReader
    const prepared = await prepareTopicEvidence(this.sessions, snapshot, snapshot.entries.filter(entry => entry.origin !== 'user_explicit' &&
      entry.status !== 'disabled' && entry.status !== 'review_required').flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis')), this.resolver, reader, this.referenceEvidence)
    return this.locked(seat.snapshot, () => {
      if (reader !== this.evidenceReader || seat.snapshot !== snapshot || !prepared.isCurrent() || !this.currentRaw(seat) ||
        !this.sessions.getTopics(ownerId).some(topic => topic.id === topicId)) return seat.snapshot
      const next = reconcileTopicArchive(snapshot, prepared.resolver, now(), prepared.isUnloaded)
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
    } catch (error) { seat.status = 'error'; this.notice = storageSaveFailureMessage(error, '主题档案', '主题档案保存失败，当前修改仍保留在本次运行。'); return false }
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
      const next = this.reconcile(seat.snapshot), invalidated = next !== seat.snapshot
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
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const seat = this.seat(ownerId, topicId), failure: ArchiveMutationResult = { status: 'invalid', snapshot: seat.snapshot, entry: null }
    const fixed: TopicArchiveCommand = structuredClone(command), reader = this.evidenceReader
    const fileProposal = fixed.kind === 'accept_file_proposal' || fixed.kind === 'revise_file_proposal'
    if ((fixed.kind === 'put' || fileProposal) && !decodeTopicArchivePut(fixed.input)) return failure
    if (seat.snapshot.version !== expectedVersion) return { status: 'stale', snapshot: seat.snapshot, entry: null }
    const content = fixed.kind === 'put' || fileProposal || fixed.kind === 'user_put' ? fixed.input : seat.snapshot.entries.find(entry => entry.id === fixed.id)
    const dependencyIds = new Set(content ? referencedEntityIds(content) : [])
    const refs = fixed.kind === 'disable' ? [] : [...(fixed.kind === 'put' || fileProposal ? fixed.input.evidence : []),
      ...seat.snapshot.entries.filter(entry => dependencyIds.has(entry.id) && entry.origin !== 'user_explicit').flatMap(entry => entry.evidence.filter(ref => ref.role === 'basis'))]
    const prepared = await prepareTopicEvidence(this.sessions, seat.snapshot, refs, this.resolver, reader, this.referenceEvidence)
    return this.locked(failure, () => {
      if (reader !== this.evidenceReader || !prepared.isCurrent() || !this.sessions.getTopics(ownerId).some(topic => topic.id === topicId) ||
        !this.currentRaw(seat) || seat.snapshot.version !== expectedVersion) { this.emit(); return { status: 'stale', snapshot: seat.snapshot, entry: null } }
      const result = fixed.kind === 'put' ? putTopicArchive(seat.snapshot, fixed.input, prepared.resolver, now()) :
        fileProposal ? acceptTopicArchiveProposal(seat.snapshot, fixed.input, prepared.resolver, fixed.acceptance, fixed.kind === 'revise_file_proposal') :
        fixed.kind === 'user_put' ? putUserTopicArchive(seat.snapshot, fixed.input, prepared.resolver, { eventId: eventId('archive-user-save'), at: now() }) :
          fixed.kind === 'adopt' ? adoptTopicArchive(seat.snapshot, fixed.id, fixed.expectedEntryVersion, prepared.resolver, { eventId: eventId('archive-adoption'), at: now() }) :
            disableTopicArchive(seat.snapshot, fixed.id, fixed.expectedEntryVersion, now())
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
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const parsed = decodeTopicArchiveUserInput(input), snapshot = this.getSnapshot(ownerId, topicId)
    if (!parsed) return { status: 'invalid', snapshot, entry: null }
    let id = parsed.id
    if (id === null) { do { id = eventId('archive') } while (snapshot.entries.some(entry => entry.id === id)) }
    return this.apply(ownerId, topicId, expectedVersion, { kind: 'user_put', input: { ...parsed, id } })
  }
  reload(ownerId: string, topicId: string): boolean {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const seat = this.seat(ownerId, topicId)
    try {
      const raw = this.storage?.getItem(topicArchiveKey(topicId)) ?? null, parsed = raw === null ? emptyTopicArchive(ownerId, topicId, now()) : decodeTopicArchiveSnapshot(JSON.parse(raw))
      if (!parsed || parsed.ownerId !== ownerId || parsed.topicId !== topicId) throw new Error('invalid topic archive')
      seat.snapshot = this.reconcile(parsed); seat.stored = raw; seat.dirty = parsed !== seat.snapshot
      seat.status = seat.dirty ? 'memory' : raw === null ? 'memory' : 'saved'; this.notice = undefined
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
  captureClearVersion(ownerId: string, topicId: string): TopicArchiveVersion {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
    const seat = this.seat(ownerId, topicId), saved = seat.stored === null ? null : decodeTopicArchiveSnapshot(JSON.parse(seat.stored))
    const version = { ownerId, topicId, stored: seat.stored, current: JSON.stringify(seat.snapshot), version: seat.snapshot.version, storageAvailable: !!this.storage,
      currentCount: seat.snapshot.entries.length, storedCount: saved?.entries.length ?? 0 }
    if (!this.isClearVersionCurrent(version)) throw new Error('Topic archive has changed; reload before clearing')
    return version
  }
  isClearVersionCurrent(version: TopicArchiveVersion): boolean {
    try {
      const seat = this.seat(version.ownerId, version.topicId)
      return !this.disposed && this.sessions.getTopics(version.ownerId).some(topic => topic.id === version.topicId) &&
        seat.status !== 'conflict' && seat.stored === version.stored && JSON.stringify(seat.snapshot) === version.current &&
        (this.storage?.getItem(topicArchiveKey(version.topicId)) ?? null) === version.stored
    } catch { return false }
  }
  /** Caller holds TOPIC_LOCK_NAME; no nested lock and no rememberHistory gate for an explicit clear. */
  clearLocked(version: TopicArchiveVersion): boolean {
    if (!this.isClearVersionCurrent(version)) return false
    const seat = this.seat(version.ownerId, version.topicId)
    try {
      if (this.storage && !this.locks) throw new Error('storage lock unavailable')
      const saved = seat.stored === null ? null : decodeTopicArchiveSnapshot(JSON.parse(seat.stored))
      const snapshot: TopicArchiveSnapshot = { ...emptyTopicArchive(version.ownerId, version.topicId, now()),
        version: Math.max(seat.snapshot.version, saved?.version ?? 0) + 1,
        activeVersion: Math.max(seat.snapshot.activeVersion, saved?.activeVersion ?? 0) +
          (seat.snapshot.entries.some(entry => entry.status === 'active') || saved?.entries.some(entry => entry.status === 'active') ? 1 : 0) }
      const raw = JSON.stringify(snapshot)
      this.storage?.setItem(topicArchiveKey(version.topicId), raw)
      seat.snapshot = snapshot; seat.stored = this.storage ? raw : null; seat.dirty = false; seat.status = this.storage ? 'saved' : 'memory'
      this.notice = undefined; this.emit(); return true
    } catch { this.notice = '主题结构化档案清空失败，该范围的当前与已保存内容保留。'; this.emit(); return false }
  }
  async deleteEntryAsync(ownerId: string, topicId: string, id: string, expectedVersion: number, expectedEntryVersion: number): Promise<boolean> {
    ownerId = this.sessions.getTopicAssetOwner(topicId) ?? ownerId
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
          else {
            const barrier = { ...next, version: Math.max(next.version, seat.snapshot.version + 1),
              activeVersion: Math.max(next.activeVersion, seat.snapshot.activeVersion + (entry.status === 'active' ? 1 : 0)) }
            const raw = JSON.stringify(barrier); this.storage.setItem(topicArchiveKey(topicId), raw); seat.stored = raw
          }
        }
        seat.snapshot = deleteTopicArchiveEntry(seat.snapshot, id, expectedEntryVersion, at).snapshot
        seat.dirty = seat.stored === null ? seat.snapshot.entries.length > 0 : JSON.stringify(seat.snapshot) !== seat.stored; seat.status = seat.dirty ? 'memory' : 'saved'
        this.notice = undefined; this.emit(); return true
      } catch { this.notice = '档案删除失败，当前条目与剩余范围保留。'; this.emit(); return false }
    })
  }
}
