import { browserPluginStorage, isPluginStorageEvent } from './storage-fence.js'
import {
  appendRecordObjectReference, decodeRecordObjectReferenceInput, decodeRecordObjectSnapshot, emptyRecordObjects, recordObjectTargetMatches,
  type RecordObjectMutationResult, type RecordObjectReference, type RecordObjectReferenceInput, type RecordObjectSnapshot, type RecordObjectTarget,
} from '../shared/record-objects.js'
import { SessionStore, type HistoryStatus, type LocalStoragePort, type StructureLockPort } from './session-store.js'
import { SETTINGS_KEY, LEGACY_SETTINGS_KEY, parseSettings } from './sessions.js'
import { TOPIC_LOCK_NAME } from './topics.js'
import { canEditTextRevision, isTextUnit } from './translation-history.js'

export const RECORD_OBJECTS_PREFIX = 'dsh-translation-plugin:record-objects:v1:'
export function recordObjectsKey(sessionId: string): string { return `${RECORD_OBJECTS_PREFIX}${encodeURIComponent(sessionId)}` }
export type RecordObjectAvailability = 'available' | 'record_unavailable' | 'position_unavailable' | 'storage_conflict'
interface Seat { snapshot: RecordObjectSnapshot; stored: string | null; dirty: boolean; status: HistoryStatus }
const now = (): string => new Date().toISOString()
function refId(): string { return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? `record-object-ref:${crypto.randomUUID()}` : `record-object-ref:${Date.now()}:${Math.random()}` }
const browserStorage = browserPluginStorage
function browserLocks(): StructureLockPort | undefined {
  if (typeof navigator === 'undefined' || !navigator.locks) return undefined
  return { request: async <T>(name: string, action: () => T | Promise<T>): Promise<T> => await navigator.locks.request(name, async () => await action()) }
}

/** Position metadata is independent of text history and Host assets. Saving the two is not one transaction. */
export class RecordObjectStore {
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
    this.stopSession = sessions.subscribe(() => {
      const enabled = sessions.getSettings().rememberHistory, justEnabled = enabled && !this.enabled
      this.enabled = enabled
      if (justEnabled) for (const seat of this.seats.values()) if (seat.dirty && seat.status !== 'conflict') this.queuePersist(seat)
      // Deletion or revision changes only availability; never retarget or rewrite an old reference.
      this.emit()
    })
    if (listen) this.stopStorage = listen(key => this.externalChange(key))
    else if (typeof window !== 'undefined' && storage) {
      const onChange = (event: StorageEvent): void => { if (isPluginStorageEvent(event, storage)) this.externalChange(event.key) }
      window.addEventListener('storage', onChange); this.stopStorage = () => window.removeEventListener('storage', onChange)
    }
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener() }
  getNotice(): string | undefined { return this.notice }
  getStatus(ownerId: string, topicId: string, sessionId: string): HistoryStatus { return this.seat(ownerId, topicId, sessionId).status }
  dispose(): void { this.disposed = true; this.stopSession(); this.stopStorage?.(); this.listeners.clear(); this.seats.clear() }
  private load(): void {
    if (!this.storage) return
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i)
        if (!key?.startsWith(RECORD_OBJECTS_PREFIX)) continue
        try {
          const raw = this.storage.getItem(key), snapshot = raw === null ? undefined : decodeRecordObjectSnapshot(JSON.parse(raw))
          if (!snapshot || key !== recordObjectsKey(snapshot.sessionId)) throw new Error('invalid object references')
          const session = this.sessions.getSession(snapshot.sessionId)
          if (session && (session.ownerId !== snapshot.ownerId || session.topicId !== snapshot.topicId)) throw new Error('record object scope mismatch')
          this.seats.set(snapshot.sessionId, { snapshot, stored: raw, dirty: false, status: 'saved' })
        } catch { this.notice = '部分记录对象引用无法读取，原副本已保留。' }
      }
    } catch { this.notice = '记录对象引用读取失败，原副本已保留。' }
  }
  private seat(ownerId: string, topicId: string, sessionId: string): Seat {
    const session = this.sessions.getSession(sessionId)
    if (session && (session.ownerId !== ownerId || session.topicId !== topicId)) throw new Error('Record object scope mismatch')
    const existing = this.seats.get(sessionId)
    if (existing) {
      if (existing.snapshot.ownerId !== ownerId || existing.snapshot.topicId !== topicId) throw new Error('Record object scope mismatch')
      return existing
    }
    if (!session || this.sessions.isSessionDeleted(sessionId)) throw new Error('Unknown record object scope')
    const seat: Seat = { snapshot: emptyRecordObjects(ownerId, topicId, sessionId, now()), stored: null, dirty: false, status: 'memory' }
    this.seats.set(sessionId, seat); return seat
  }
  getSnapshot(ownerId: string, topicId: string, sessionId: string): RecordObjectSnapshot { return this.seat(ownerId, topicId, sessionId).snapshot }
  getReferences(scope: RecordObjectTarget): readonly RecordObjectReference[] {
    const seat = this.seat(scope.ownerId, scope.topicId, scope.sessionId)
    return seat.snapshot.references.filter(ref => recordObjectTargetMatches(ref, scope))
  }
  /** A source object does not block a plain target revision; no metadata moves to a new manual revision. */
  hasRevisionObjects(ownerId: string, topicId: string, sessionId: string, unitId: string, revisionId: string): boolean {
    const scope: RecordObjectTarget = { ownerId, topicId, sessionId, unitId, side: 'revision', revisionId }
    return this.seat(ownerId, topicId, sessionId).snapshot.references.some(ref => recordObjectTargetMatches(ref, scope))
  }
  /** Synchronous saved/runtime check, also used inside the shared structure lock before deletion. */
  revisionDeletionBlockedReason(scope: RecordObjectTarget): string | undefined {
    try {
      const seat = this.seat(scope.ownerId, scope.topicId, scope.sessionId)
      if (seat.status === 'conflict') return '对象引用存在存储冲突，请读取最新副本后再删除。'
      const raw = this.storage?.getItem(recordObjectsKey(scope.sessionId)) ?? null
      const saved = raw === null ? undefined : decodeRecordObjectSnapshot(JSON.parse(raw))
      if (raw !== null && (!saved || saved.ownerId !== scope.ownerId || saved.topicId !== scope.topicId || saved.sessionId !== scope.sessionId)) return '已保存对象引用无法核对，不能删除此版本。'
      if ([...seat.snapshot.references, ...(saved?.references ?? [])].some(ref => recordObjectTargetMatches(ref, scope))) return '此版本仍有对象位置引用，不能删除。'
    } catch { return '对象引用无法核对，不能删除此版本。' }
    return undefined
  }
  private body(scope: RecordObjectTarget, requireEnded = false): string | undefined {
    const session = this.sessions.getSession(scope.sessionId)
    if (!session || session.ownerId !== scope.ownerId || session.topicId !== scope.topicId || this.sessions.isSessionDeleted(session.id) || this.sessions.getStatus(session.id) === 'conflict') return undefined
    const unit = this.sessions.getTranslationHistory(session.id)?.units.find(unit => unit.id === scope.unitId)
    if (!unit || !isTextUnit(unit) || unit.deletion) return undefined
    if (scope.side === 'source') return scope.revisionId === null ? unit.source : undefined
    const revision = scope.revisionId === null ? undefined : unit.revisions.find(revision => revision.id === scope.revisionId)
    return revision && revision.status !== 'deleted' && (!requireEnded || canEditTextRevision(revision)) ? revision.text : undefined
  }
  getAvailability(reference: RecordObjectReference): RecordObjectAvailability {
    let status: string | undefined
    try { status = this.seat(reference.ownerId, reference.topicId, reference.sessionId).status } catch { status = undefined }
    if (status === undefined) return 'record_unavailable'
    if (status === 'conflict') return 'storage_conflict'
    const body = this.body(reference)
    return body === undefined ? 'record_unavailable' : reference.offset > Array.from(body).length ? 'position_unavailable' : 'available'
  }
  private savingEnabled(): boolean {
    if (!this.storage) return false
    try {
      const settings = parseSettings(this.storage.getItem(SETTINGS_KEY), this.storage.getItem(LEGACY_SETTINGS_KEY))
      if (!settings) throw new Error('invalid settings')
      return settings.rememberHistory
    } catch { this.notice = '历史保存设置无法读取，对象引用仅保留在本次运行。'; return false }
  }
  private currentRaw(seat: Seat): boolean {
    if ((this.storage?.getItem(recordObjectsKey(seat.snapshot.sessionId)) ?? null) === seat.stored) return true
    seat.status = 'conflict'; this.notice = '记录对象引用已在其他窗口变化，当前内容保留，请读取最新副本后重试。'; return false
  }
  private persistLocked(seat: Seat): boolean {
    if (!seat.dirty) return true
    if (!this.savingEnabled()) { seat.status = 'memory'; return true }
    if (!this.storage || !this.locks) { seat.status = 'error'; this.notice = '对象引用保存需要本地存储和 Web Locks，当前内容仍保留。'; return false }
    try {
      if (!this.currentRaw(seat)) return false
      const raw = JSON.stringify(seat.snapshot)
      this.storage.setItem(recordObjectsKey(seat.snapshot.sessionId), raw)
      seat.stored = raw; seat.dirty = false; seat.status = 'saved'; return true
    } catch { seat.status = 'error'; this.notice = '对象资源可能已登记，但记录引用未保存；当前引用仍保留在本次运行，可重试保存。'; return false }
  }
  private queuePersist(seat: Seat): void {
    const id = seat.snapshot.sessionId
    if (this.pending.has(id) || !this.storage || !this.locks || !seat.dirty) return
    const pending = this.locks.request(TOPIC_LOCK_NAME, () => this.disposed ? false : this.persistLocked(seat)).catch(() => {
      seat.status = 'error'; this.notice = '对象引用保存未完成，当前引用仍保留。'; return false
    }).finally(() => { if (this.pending.get(id) === pending) { this.pending.delete(id); this.emit() } })
    this.pending.set(id, pending)
  }
  async addReference(input: RecordObjectReferenceInput, expectedVersion: number): Promise<RecordObjectMutationResult> {
    const parsed = decodeRecordObjectReferenceInput(input), seat = this.seat(input.ownerId, input.topicId, input.sessionId)
    const invalid = (): RecordObjectMutationResult => ({ status: 'invalid', snapshot: seat.snapshot, reference: null })
    if (!parsed || this.disposed) return invalid()
    const action = (): RecordObjectMutationResult => {
      if (!this.currentRaw(seat) || expectedVersion !== seat.snapshot.version) { this.emit(); return { status: 'stale', snapshot: seat.snapshot, reference: null } }
      if (this.sessions.getSession(parsed.sessionId)?.archivedAt !== null) return invalid()
      const body = this.body(parsed, true)
      if (body === undefined || parsed.offset > Array.from(body).length) return invalid()
      for (const other of this.seats.values()) for (const ref of other.snapshot.references) {
        if ((ref.ownerId === parsed.ownerId && ref.topicId === parsed.topicId && ref.asset.objectId === parsed.asset.objectId && ref.asset.kind !== parsed.asset.kind) ||
          (ref.asset.assetId === parsed.asset.assetId && (ref.ownerId !== parsed.ownerId || ref.topicId !== parsed.topicId || JSON.stringify(ref.asset) !== JSON.stringify(parsed.asset)))) return invalid()
      }
      const result = appendRecordObjectReference(seat.snapshot, parsed, { refId: refId(), at: now() })
      if (result.snapshot !== seat.snapshot) { seat.snapshot = result.snapshot; seat.dirty = true; seat.status = 'memory' }
      if ((result.status === 'updated' || result.status === 'unchanged') && seat.dirty) {
        this.notice = undefined; const saved = this.persistLocked(seat); this.emit()
        if (!saved) return { ...result, status: 'save_failed' }
      }
      return result
    }
    try { return this.storage && this.locks ? await this.locks.request(TOPIC_LOCK_NAME, () => this.disposed ? invalid() : action()) : action() }
    catch { seat.status = 'error'; this.notice = '记录对象引用操作未完成，当前内容保留。'; this.emit(); return invalid() }
  }
  reload(ownerId: string, topicId: string, sessionId: string): boolean {
    const seat = this.seat(ownerId, topicId, sessionId)
    try {
      const raw = this.storage?.getItem(recordObjectsKey(sessionId)) ?? null, parsed = raw === null ? emptyRecordObjects(ownerId, topicId, sessionId, now()) : decodeRecordObjectSnapshot(JSON.parse(raw))
      if (!parsed || parsed.ownerId !== ownerId || parsed.topicId !== topicId || parsed.sessionId !== sessionId) throw new Error('invalid record object snapshot')
      seat.snapshot = parsed; seat.stored = raw; seat.dirty = false; seat.status = raw === null ? 'memory' : 'saved'; this.notice = undefined; this.emit(); return true
    } catch { seat.status = 'conflict'; this.notice = '最新记录对象引用无法读取，当前内容保留。'; this.emit(); return false }
  }
  private externalChange(key: string | null): void {
    if (this.disposed || (key !== null && !key.startsWith(RECORD_OBJECTS_PREFIX))) return
    for (const seat of this.seats.values()) {
      if (key !== null && key !== recordObjectsKey(seat.snapshot.sessionId)) continue
      try {
        if ((this.storage?.getItem(recordObjectsKey(seat.snapshot.sessionId)) ?? null) === seat.stored) continue
        if (!seat.dirty) this.reload(seat.snapshot.ownerId, seat.snapshot.topicId, seat.snapshot.sessionId)
        else { seat.status = 'conflict'; this.notice = '其他窗口已修改对象引用，当前临时修改保留，未覆盖另一窗口。' }
      } catch { seat.status = 'error'; this.notice = '对象引用读取失败，当前内容保留。' }
    }
    this.emit()
  }
}
