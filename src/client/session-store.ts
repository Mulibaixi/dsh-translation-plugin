import {
  DEFAULT_SESSION_SETTINGS, HISTORY_PREFIX, LEGACY_DRAFT_PREFIX, LEGACY_SETTINGS_KEY, SETTINGS_KEY,
  decodeSession, historyKey, legacySession, newSession, parseSettings, sessionName, validateSessionSettings,
  type LocalSession, type ModelRoute, type SessionSettings,
} from './sessions.js'
import { SESSION_MODEL_PREFIX, OWNER_MODEL_PREFIX, sessionModelKey, ownerModelKey, encodeModelPreference, decodeModelPreference } from './model-preferences.js'
import { SESSION_ORDER_PREFIX, sessionOrderKey, encodeSessionOrder, decodeSessionOrder, reconcileSessionOrder, moveSessionOrder } from './session-order.js'
import { decodeTranslationHistory, emptyTranslationHistory, isDocumentUnit, persistedTranslationHistory, restoreTranslationHistory, type TranslationHistory } from './translation-history.js'
import { parseTranslationSourceReference, parseTranslationSourceStorageRequest, type TranslationSourceQueryReference, type TranslationSourceStoredRead } from '../shared/translation-source-storage.js'
import type { TranslationSourceScope } from '../shared/translation-sources.js'
import type { TranslationSourceHistoryCallbacks, TranslationSourceHistoryCommit } from './source-storage-client.js'
import {
  DELETED_SESSION_PREFIX, TOPIC_IDENTITY_PREFIX, TOPIC_NAME_PREFIX, TOPIC_LOCK_NAME,
  decodeDeletion, decodeTopicIdentity, decodeTopicName, deletedSessionKey, topicIdentityKey, topicNameKey,
  type TopicIdentity,
} from './topics.js'
import type { TopicPersistence, TopicSessionStart } from '../shared/topic-bridge.js'
import { PREPARATION_STORAGE_PREFIX, type PreparationStoreOptions } from './preparation-store.js'
export interface LocalStoragePort {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

type Disposer = () => void
export type HistoryStatus = 'memory' | 'saved' | 'conflict' | 'error'
interface Seat { session: LocalSession; savedSession: LocalSession | undefined; translationHistory: TranslationHistory; savedTranslationHistory: TranslationHistory; stored: string | null; legacyRaw: string | null; status: HistoryStatus }
interface TopicSeat { identity: TopicIdentity; name: string; persistedName: string | undefined; stored: string | null; durable: boolean; nameDirty: boolean }
interface Workspace { active: string | undefined }
export interface HistoryVersion { readonly id: string; readonly stored: string | null; readonly legacyRaw: string | null; readonly current: string }
export interface SourceHistoryTarget { readonly sessionId: string; readonly unitId: string; readonly sourceVersion: number }
export interface StructureLockPort { request<T>(name: string, action: () => T | Promise<T>): Promise<T> }
export type SessionManagementResult =
  | { readonly ok: true; readonly sessions: readonly LocalSession[]; readonly persistence: TopicPersistence }
  | { readonly ok: false; readonly code: string; readonly message: string }
/** One optional topic-term deletion, checked inside the existing history lock. */
export interface HistoryDeleteCompanion {
  readonly requiresStorage: boolean
  preflight(): boolean
  afterHistoryDeleted(): boolean
}

function browserLocks(): StructureLockPort | undefined {
  if (typeof navigator === 'undefined' || !navigator.locks) return undefined
  return { request: async <T>(name: string, action: () => T | Promise<T>): Promise<T> => await navigator.locks.request(name, async () => await action()) }
}

interface SessionSnapshot { readonly session: LocalSession; readonly translationHistory: TranslationHistory }
function readSnapshot(raw: string): SessionSnapshot | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null
    if (!value || ![2, 3, 4, 5, 6, 7, 8, 9, 10].includes(value.schemaVersion as number) || typeof value.token !== 'string') return undefined
    const hasTranslations = [4, 5, 6, 7, 8, 9, 10].includes(value.schemaVersion as number)
    const fields = hasTranslations ? ['schemaVersion', 'token', 'session', 'translationHistory'] : ['schemaVersion', 'token', 'session']
    if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) return undefined
    if (hasTranslations && (value.translationHistory as { schemaVersion?: unknown } | null)?.schemaVersion !== (value.schemaVersion as number) - 3) return undefined
    const session = decodeSession(value.session)
    const translationHistory = hasTranslations ? decodeTranslationHistory(value.translationHistory) : emptyTranslationHistory()
    return session && translationHistory ? { session, translationHistory } : undefined
  } catch { return undefined }
}
function readHistory(raw: string): LocalSession | undefined { return readSnapshot(raw)?.session }
function currentVersion(seat: Seat): string { return JSON.stringify({ session: seat.session, translationHistory: seat.translationHistory }) }

export class SessionStore {
  private settings: SessionSettings = DEFAULT_SESSION_SETTINGS
  private readonly seats = new Map<string, Seat>()
  private readonly topics = new Map<string, TopicSeat>()
  private readonly migrationSources = new Map<string, LocalSession>()
  private readonly deleted = new Set<string>()
  private readonly corruptTopics = new Set<string>()
  private readonly pendingSaves = new Map<string, Promise<boolean>>()
  private readonly dirtySaves = new Set<string>()
  private readonly lastModels = new Map<string, ModelRoute | null>()
  private readonly sessionOrders = new Map<string, readonly string[]>()
  private readonly workspaces = new Map<string, Workspace>()
  private readonly listeners = new Set<Disposer>()
  private notice: string | undefined
  private readonly stop: Disposer | undefined
  private disposed = false

  constructor(private readonly storage?: LocalStoragePort, listen?: (onChange: (key: string | null) => void) => Disposer, private readonly locks: StructureLockPort | undefined = browserLocks()) {
    this.readSettings(); this.loadHistory()
    this.stop = listen?.(key => this.externalChange(key))
  }

  getSettings(): SessionSettings { return this.settings }
  getNotice(): string | undefined { return this.notice }
  getSession(id: string): LocalSession | undefined { return this.seats.get(id)?.session }
  isSessionDeleted(id: string): boolean { return this.isDeleted(id) }
  getTranslationHistory(id: string): TranslationHistory | undefined { return this.seats.get(id)?.translationHistory }
  /** Separate preparation audit storage shares history settings and the existing structure lock. */
  createPreparationStoreOptions(): PreparationStoreOptions {
    const validKey = (key: string): void => { if (!key.startsWith(PREPARATION_STORAGE_PREFIX)) throw new Error('Preparation storage key is outside its namespace') }
    return {
      ...(this.storage && this.locks ? { storage: {
        keys: () => {
          const keys: string[] = []
          for (let index = 0; index < this.storage!.length; index++) { const key = this.storage!.key(index); if (key?.startsWith(PREPARATION_STORAGE_PREFIX)) keys.push(key) }
          return keys
        },
        getItem: (key: string) => { validKey(key); return this.storage!.getItem(key) },
        setItem: (key: string, value: string) => { validKey(key); this.storage!.setItem(key, value) },
      } } : {}),
      withLock: async <T>(action: () => T | Promise<T>): Promise<T> => this.storage && this.locks
        ? this.locks.request(TOPIC_LOCK_NAME, async () => { if (this.disposed) throw new Error('Session store is disposed'); return await action() })
        : await action(),
      isEnabled: () => !this.disposed && this.readSettings() && this.settings.rememberHistory,
      isScopeCurrent: scope => {
        const session = this.getSession(scope.translationSessionId)
        return !this.disposed && !!session && !this.isSessionDeleted(session.id) && scope.ownerId === scope.mainSessionId &&
          session.ownerId === scope.ownerId && session.topicId === scope.topicId && this.getTopics(scope.ownerId).some(topic => topic.id === scope.topicId)
      },
    }
  }
  /** Bind storage acknowledgments to an existing document source; this never admits a task. */
  createSourceHistoryCallbacks(target: SourceHistoryTarget): TranslationSourceHistoryCallbacks {
    const fixed = { ...target }, session = this.getSession(fixed.sessionId)
    if (!session || !Number.isSafeInteger(fixed.sourceVersion) || fixed.sourceVersion < 1) throw new Error('Document source history target is unavailable')
    const scope: TranslationSourceScope = { ownerId: session.ownerId, mainSessionId: session.ownerId, topicId: session.topicId, translationSessionId: session.id }
    this.sourceHistoryVersion(fixed, scope)
    return {
      isHistoryEnabled: () => !this.disposed && this.readSettings() && this.settings.rememberHistory,
      persistPreparedReference: async (value, confirmOperationId) => {
        const reference = parseTranslationSourceReference(value)
        if (reference.state !== 'prepared') throw new Error('History requires a prepared source reference')
        parseTranslationSourceStorageRequest('confirmReference', { scope: reference.scope, referenceKey: reference.referenceKey,
          prepareToken: reference.prepareToken, historyToken: 'validation', operationId: confirmOperationId })
        const result = await this.withStructureLock<TranslationSourceHistoryCommit | undefined>(undefined, () => {
          if (this.disposed || !this.storage || !this.readSettings() || !this.settings.rememberHistory) return undefined
          const source = this.sourceHistoryVersion(fixed, scope)
          if (JSON.stringify(reference.scope) !== JSON.stringify(scope) || JSON.stringify(reference.source) !== JSON.stringify(source.body.reference)) throw new Error('Prepared reference does not match the document source')
          const query = { scope, referenceKey: reference.referenceKey }, retained = this.readSourceHistoryCommit(fixed, scope, query)
          if (retained) {
            if (JSON.stringify(retained.reference) !== JSON.stringify(reference) || retained.confirmOperationId !== confirmOperationId) throw new Error('Document source commit already has different credentials')
            return retained
          }
          const seat = this.seats.get(fixed.sessionId)!, topic = this.topics.get(scope.topicId)
          if (!topic) throw new Error('Document source topic is unavailable')
          for (const unit of seat.translationHistory.units) if (isDocumentUnit(unit)) for (const version of unit.sourceVersions) {
            if (version.historyCommit?.reference.referenceKey === reference.referenceKey && (unit.id !== fixed.unitId || version.version !== fixed.sourceVersion)) throw new Error('Source reference key already belongs to another document source')
          }
          const commit: TranslationSourceHistoryCommit = source.historyCommit ?? { reference,
            historyToken: `source-history:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`, confirmOperationId }
          if (JSON.stringify(commit.reference) !== JSON.stringify(reference) || commit.confirmOperationId !== confirmOperationId) throw new Error('Document source commit already has different credentials')
          const history = decodeTranslationHistory({ ...seat.translationHistory, units: seat.translationHistory.units.map(unit =>
            unit.id === fixed.unitId && isDocumentUnit(unit) ? { ...unit, sourceVersions: unit.sourceVersions.map(version =>
              version.version === fixed.sourceVersion ? { ...version, historyCommit: commit } : version) } : unit) })
          if (!history) throw new Error('Invalid document source history commit')
          seat.translationHistory = history; seat.session = { ...seat.session, updatedAt: new Date().toISOString() }
          if (seat.status !== 'conflict') seat.status = 'memory'
          this.writeIdentity(topic); this.writeTopicName(topic); this.adoptTopic(seat)
          if (!this.persistLocked(fixed.sessionId)) return undefined
          const saved = this.readSourceHistoryCommit(fixed, scope, query)
          if (!saved || saved.historyToken !== commit.historyToken || saved.confirmOperationId !== commit.confirmOperationId ||
            JSON.stringify(saved.reference) !== JSON.stringify(commit.reference)) throw new Error('Document source commit read-back failed')
          this.notice = undefined; this.emit(); return saved
        })
        if (!result) { this.emit(); throw new Error('Document source history was not saved') }
        return result
      },
      readPersistedReference: async request => this.readSourceHistoryCommit(fixed, scope, request),
    }
  }
  /** Verified persisted credentials for an explicit restore/open request; no automatic restoration. */
  async readStoredSourceRequest(target: SourceHistoryTarget): Promise<TranslationSourceStoredRead | null> {
    const session = this.getSession(target.sessionId)
    if (!session) return null
    const scope: TranslationSourceScope = { ownerId: session.ownerId, mainSessionId: session.ownerId, topicId: session.topicId, translationSessionId: session.id }
    const source = this.sourceHistoryVersion(target, scope), key = source.historyCommit?.reference.referenceKey
    if (!key) return null
    const commit = this.readSourceHistoryCommit(target, scope, { scope, referenceKey: key })
    return commit ? { scope: commit.reference.scope, referenceKey: commit.reference.referenceKey, source: commit.reference.source, historyToken: commit.historyToken } : null
  }
  private sourceHistoryVersion(target: SourceHistoryTarget, scope: TranslationSourceScope) {
    const seat = this.seats.get(target.sessionId), session = seat?.session, unit = seat?.translationHistory.units.find(unit => unit.id === target.unitId)
    if (this.disposed || !session || this.isDeleted(session.id) || session.ownerId !== scope.ownerId || scope.mainSessionId !== session.ownerId ||
      session.topicId !== scope.topicId || session.id !== scope.translationSessionId || !unit || !isDocumentUnit(unit)) throw new Error('Document source history scope is unavailable')
    const source = unit.sourceVersions.find(version => version.version === target.sourceVersion)
    if (!source || source.body.kind !== 'asset') throw new Error('Document asset source version is unavailable')
    return { ...source, body: source.body }
  }
  private readSourceHistoryCommit(target: SourceHistoryTarget, scope: TranslationSourceScope, value: TranslationSourceQueryReference): TranslationSourceHistoryCommit | null {
    const query = parseTranslationSourceStorageRequest('queryReference', value) as TranslationSourceQueryReference
    if (JSON.stringify(query.scope) !== JSON.stringify(scope)) throw new Error('Document source query is outside the bound scope')
    const current = this.sourceHistoryVersion(target, scope)
    if (!this.storage) throw new Error('History storage is unavailable')
    const raw = this.storage.getItem(historyKey(target.sessionId))
    if (raw === null) return null
    const snapshot = readSnapshot(raw), session = snapshot?.session, unit = snapshot?.translationHistory.units.find(unit => unit.id === target.unitId)
    if (!session || session.id !== target.sessionId || session.ownerId !== scope.ownerId || session.topicId !== scope.topicId ||
      !this.matchesHistoryIdentity(session, this.seats.get(target.sessionId)!.session)) throw new Error('Persisted document source scope is unavailable')
    if (!unit) return null
    if (!isDocumentUnit(unit)) throw new Error('Persisted source target is not a document')
    const source = unit.sourceVersions.find(version => version.version === target.sourceVersion)
    if (!source) return null
    if (source.body.kind !== 'asset' || JSON.stringify(source.body.reference) !== JSON.stringify(current.body.reference)) throw new Error('Persisted document source version does not match')
    const commit = source.historyCommit
    if (!commit) return null
    if (JSON.stringify(commit.reference.scope) !== JSON.stringify(scope) || commit.reference.referenceKey !== query.referenceKey) throw new Error('Persisted document source credentials do not match')
    return structuredClone(commit)
  }
  getStatus(id: string): HistoryStatus { return this.seats.get(id)?.status ?? 'memory' }
  getStructureCapability(): 'web-locks' | 'runtime-only' { return this.storage && this.locks ? 'web-locks' : 'runtime-only' }
  getTopics(ownerId?: string): readonly { readonly id: string; readonly name: string; readonly nextSequence: number }[] {
    return [...this.topics.values()].filter(topic => ownerId === undefined || topic.identity.ownerId === ownerId)
      .map(topic => ({ id: topic.identity.id, name: topic.name, nextSequence: topic.identity.nextSequence }))
  }
  subscribe(listener: Disposer): Disposer { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { if (!this.disposed) for (const fn of this.listeners) fn() }
  dispose(): void { this.disposed = true; this.stop?.(); this.listeners.clear(); this.workspaces.clear(); this.seats.clear(); this.topics.clear(); this.migrationSources.clear(); this.lastModels.clear(); this.sessionOrders.clear() }

  private readModelPreference(key: string): ModelRoute | null | undefined {
    try {
      const raw = this.storage?.getItem(key)
      if (raw === undefined || raw === null) return undefined
      const model = decodeModelPreference(raw)
      if (model === undefined) throw new Error('invalid model preference')
      return model
    } catch { this.notice = '模型偏好读取失败，当前模型选择仍保留。'; return undefined }
  }

  private restoreModel(session: LocalSession): LocalSession {
    const model = this.readModelPreference(sessionModelKey(session.id))
    return model === undefined ? session : { ...session, model }
  }

  private rememberModel(seat: Seat): void {
    const { ownerId, id, model } = seat.session
    this.lastModels.set(ownerId, model)
    try {
      if (!this.storage) throw new Error('storage unavailable')
      const raw = encodeModelPreference(model)
      // Temporary session IDs cannot be restored; retain only their owner's next-session preference.
      if ((seat.stored !== null || seat.legacyRaw !== null) && !this.isDeleted(id)) this.storage.setItem(sessionModelKey(id), raw)
      this.storage.setItem(ownerModelKey(ownerId), raw)
    } catch { this.notice = '模型与推理等级偏好未完整保存，当前选择仍保留在本次运行中。' }
  }

  private readSettings(): boolean {
    try {
      const settings = parseSettings(this.storage?.getItem(SETTINGS_KEY) ?? null, this.storage?.getItem(LEGACY_SETTINGS_KEY) ?? null)
      if (!settings) throw new Error('invalid settings')
      this.settings = settings
      return true
    } catch { this.notice = '本地设置读取失败，当前设置仍保留。'; return false }
  }

  patchSettings(patch: Partial<Omit<SessionSettings, 'schemaVersion'>>, restore = false): boolean {
    if (this.locks) {
      this.notice = '设置保存需与会话写入协调，请使用异步设置操作。'; this.emit(); return false
    }
    return this.patchSettingsLocked(patch, restore)
  }

  async patchSettingsAsync(patch: Partial<Omit<SessionSettings, 'schemaVersion'>>, restore = false): Promise<boolean> {
    const edits = { ...patch }
    if (!this.locks) return this.patchSettingsLocked(edits, restore)
    return this.withStructureLock(false, () => this.patchSettingsLocked(edits, restore))
  }

  private patchSettingsLocked(patch: Partial<Omit<SessionSettings, 'schemaVersion'>>, restore = false): boolean {
    if (!this.readSettings() && !restore) { this.emit(); return false }
    const next = { ...(restore ? DEFAULT_SESSION_SETTINGS : this.settings), ...patch, schemaVersion: 2 as const }
    const errors = validateSessionSettings(next)
    if (errors.length) { this.notice = errors.join(' '); this.emit(); return false }
    if (!this.storage) { this.notice = '本地存储不可用，设置尚未保存。'; this.emit(); return false }
    if (!this.locks && !this.settings.rememberHistory && next.rememberHistory) {
      this.notice = '当前环境无法协调历史保存，暂不能开启；现有内容仍保留在当前窗口。'; this.emit(); return false
    }
    try {
      const wasEnabled = this.settings.rememberHistory
      this.storage.setItem(SETTINGS_KEY, JSON.stringify(next))
      this.settings = next; this.notice = undefined
      if (!wasEnabled && next.rememberHistory) this.queueHistorySaves()
      this.emit(); return true
    } catch { this.notice = '设置保存失败，编辑值仍保留，请检查本地存储后重试修改。'; this.emit(); return false }
  }

  private queueHistorySaves(): void {
    for (const [id, seat] of this.seats) {
      const topic = this.topics.get(seat.session.topicId)
      if (seat.status !== 'saved' || !topic?.stored || topic.nameDirty || JSON.stringify(seat.translationHistory) !== JSON.stringify(seat.savedTranslationHistory)) this.persist(id)
    }
  }

  private loadHistory(): void {
    if (!this.storage) return
    try {
      const keys: string[] = []
      for (let i = 0; i < this.storage.length; i++) { const key = this.storage.key(i); if (key) keys.push(key) }
      this.loadTopics(keys)
      for (const key of keys.filter(key => key.startsWith(HISTORY_PREFIX))) {
        const raw = this.storage.getItem(key)
        const snapshot = raw === null ? undefined : readSnapshot(raw), session = snapshot?.session
        if (!session || historyKey(session.id) !== key) { this.notice = '部分会话历史无法读取，原存储副本已保留。'; continue }
        if (this.isDeleted(session.id)) continue
        const old = this.seats.get(session.id)
        if (!old) {
          this.seats.set(session.id, { session: this.restoreModel(session), savedSession: session, translationHistory: restoreTranslationHistory(snapshot!.translationHistory), savedTranslationHistory: snapshot!.translationHistory, stored: raw, legacyRaw: session.legacyKey ? this.storage.getItem(session.legacyKey) : null, status: 'saved' })
          if (session.sequenceNamespaceId.startsWith('legacy-pending:')) this.migrationSources.set(session.id, session)
        }
      }
      for (const key of keys.filter(key => key.startsWith(LEGACY_DRAFT_PREFIX))) {
        const raw = this.storage.getItem(key)
        const session = raw === null ? undefined : legacySession(key, raw)
        if (session && !this.isDeleted(session.id) && !this.seats.has(session.id)) {
          this.seats.set(session.id, { session: this.restoreModel(session), savedSession: session, translationHistory: emptyTranslationHistory(), savedTranslationHistory: emptyTranslationHistory(), stored: null, legacyRaw: raw, status: 'saved' })
          this.migrationSources.set(session.id, session)
        }
        else if (!session) this.notice = '部分旧版草稿无法读取，原存储副本已保留。'
      }
      this.migrateTopics()
      for (const seat of this.seats.values()) this.adoptTopic(seat)
    } catch { this.notice = '会话历史读取失败，当前窗口仍可编辑。' }
  }

  private isDeleted(id: string): boolean {
    if (this.deleted.has(id)) return true
    const raw = this.storage?.getItem(deletedSessionKey(id))
    if (raw === undefined || raw === null) return false
    // 无法解码的删除屏障也保守阻止恢复；绝不把它当成不存在。
    if (!decodeDeletion(raw, id)) this.notice = '部分删除屏障无法读取，相关旧副本未恢复。'
    this.deleted.add(id); return true
  }

  private loadTopics(keys: readonly string[]): void {
    for (const key of keys.filter(key => key.startsWith(TOPIC_IDENTITY_PREFIX))) {
      const raw = this.storage?.getItem(key)
      if (raw === undefined || raw === null) continue
      const identity = decodeTopicIdentity(raw)
      if (!identity || topicIdentityKey(identity.id) !== key) {
        this.corruptTopics.add(key); this.notice = '部分主题编号记录无法读取，相关持久主题暂停新建会话。'; continue
      }
      const old = this.topics.get(identity.id)
      if (old && (old.identity.ownerId !== identity.ownerId || old.identity.sequenceNamespaceId !== identity.sequenceNamespaceId)) {
        this.corruptTopics.add(key); this.notice = '主题身份存在冲突，当前内容保留。'; continue
      }
      const nameRaw = this.storage?.getItem(topicNameKey(identity.id))
      const nameRecord = nameRaw ? decodeTopicName(nameRaw, identity) : undefined
      if (nameRaw && !nameRecord) { this.corruptTopics.add(key); this.notice = '主题名称记录无法读取，当前内容保留。' }
      if (old?.nameDirty && nameRecord && old.persistedName !== undefined && old.persistedName !== nameRecord.name) {
        this.notice = '主题已在其他窗口重命名，当前窗口名称仍保留；保存前请核对。'
      }
      this.topics.set(identity.id, {
        identity, stored: raw, durable: true, persistedName: old?.nameDirty ? old.persistedName : nameRecord?.name ?? old?.persistedName,
        name: old?.nameDirty ? old.name : nameRecord?.name ?? old?.name ?? '', nameDirty: old?.nameDirty ?? false,
      })
    }
  }

  private migrateTopics(): void {
    const assigned = new Map<string, { topic: TopicSeat; sequence: number }>()
    for (const topic of this.topics.values()) {
      if (!topic.name) {
        const candidates = [...topic.identity.allocations].sort((a, b) => a.sequence - b.sequence)
        const rootId = topic.identity.sequenceNamespaceId.startsWith('migration:') ? topic.identity.sequenceNamespaceId.slice('migration:'.length) : undefined
        const root = rootId ? this.migrationSources.get(rootId) : undefined
        const saved = candidates.map(entry => this.seats.get(entry.sessionId)?.savedSession).find((session): session is LocalSession => !!session)
        topic.name = root?.legacyName ?? root?.name ?? saved?.topicName ?? '新翻译会话'
        topic.persistedName ??= root?.legacyName ?? root?.name ?? saved?.topicName
      }
      for (const allocation of topic.identity.allocations) {
        const previous = assigned.get(allocation.sessionId)
        if (previous && previous.topic.identity.id !== topic.identity.id) {
          this.corruptTopics.add(topicIdentityKey(topic.identity.id)); this.corruptTopics.add(topicIdentityKey(previous.topic.identity.id))
        } else assigned.set(allocation.sessionId, { topic, sequence: allocation.sequence })
      }
    }
    const groups = new Map<string, LocalSession[]>()
    for (const source of this.migrationSources.values()) {
      if (!this.seats.has(source.id)) continue
      const known = assigned.get(source.id)
      if (known && known.topic.identity.ownerId === source.ownerId) {
        this.applyMigration(source.id, known.topic, known.sequence); continue
      }
      let root = source
      const path = new Set([source.id])
      while (root.parentId) {
        const parent = this.migrationSources.get(root.parentId)
        if (!parent || !this.seats.has(parent.id) || parent.ownerId !== source.ownerId) break
        if (path.has(parent.id)) { root = source; break }
        path.add(parent.id); root = parent
      }
      const id = `topic:migration:${root.id}`
      const group = groups.get(id) ?? []; group.push(source); groups.set(id, group)
    }
    for (const [id, sources] of groups) {
      sources.sort((a, b) => (a.id === id.slice('topic:migration:'.length) ? -1 : b.id === id.slice('topic:migration:'.length) ? 1 : a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)))
      const root = sources[0]!
      let topic = this.topics.get(id)
      if (!topic) {
        topic = {
          identity: { schemaVersion: 1, id, ownerId: root.ownerId, sequenceNamespaceId: `migration:${root.id}`, nextSequence: 0, version: 0, allocations: [] },
          name: root.legacyName ?? root.name, persistedName: root.legacyName ?? root.name, stored: null, durable: true, nameDirty: false,
        }
        this.topics.set(id, topic)
      }
      const allocations = [...topic.identity.allocations]
      let nextSequence = topic.identity.nextSequence
      for (const source of sources) {
        let allocation = allocations.find(entry => entry.sessionId === source.id)
        if (!allocation) {
          if (!Number.isSafeInteger(nextSequence + 1)) { this.corruptTopics.add(topicIdentityKey(id)); this.notice = '主题编号已达到安全上限，相关会话无法继续发号。'; continue }
          allocation = { sessionId: source.id, sequence: nextSequence++ }; allocations.push(allocation)
        }
        this.applyMigration(source.id, topic, allocation.sequence)
      }
      // 旧计数只用于保守抬高新空间；不解析名称，也不声称恢复已丢失的删除历史。
      nextSequence = sources.reduce((highest, source) => Math.max(highest, source.childSequence < Number.MAX_SAFE_INTEGER ? source.childSequence + 1 : Number.MAX_SAFE_INTEGER), nextSequence)
      topic.identity = { ...topic.identity, allocations, nextSequence }
    }
  }

  private applyMigration(id: string, topic: TopicSeat, sequence: number): void {
    const seat = this.seats.get(id)
    if (!seat) return
    const apply = (session: LocalSession): LocalSession => ({
      ...session, topicId: topic.identity.id, sequenceNamespaceId: topic.identity.sequenceNamespaceId, topicName: topic.name,
      sequence, name: sessionName(topic.name, sequence),
    })
    seat.session = apply(seat.session)
    if (seat.savedSession) {
      const savedName = topic.persistedName ?? topic.name
      seat.savedSession = { ...apply(seat.savedSession), topicName: savedName, name: sessionName(savedName, sequence) }
    }
  }

  private adoptTopic(seat: Seat): void {
    const session = seat.session
    let topic = this.topics.get(session.topicId)
    if (!topic) {
      topic = {
        identity: { schemaVersion: 1, id: session.topicId, ownerId: session.ownerId, sequenceNamespaceId: session.sequenceNamespaceId, nextSequence: session.sequence + 1, version: 0, allocations: [{ sessionId: session.id, sequence: session.sequence }] },
        name: session.topicName, persistedName: seat.savedSession?.topicName, stored: null, durable: !!seat.savedSession, nameDirty: false,
      }
      this.topics.set(session.topicId, topic)
    }
    if (topic.identity.ownerId !== session.ownerId || topic.identity.sequenceNamespaceId !== session.sequenceNamespaceId) {
      this.corruptTopics.add(topicIdentityKey(session.topicId)); seat.status = 'conflict'; return
    }
    const allocation = topic.identity.allocations.find(entry => entry.sessionId === session.id)
    if (!allocation || allocation.sequence !== session.sequence) {
      // 已持久的身份记录具有唯一权威；缺失或重复号不能从正文猜测补回。
      if (topic.stored !== null) { seat.status = 'conflict'; this.notice = '会话编号与主题身份记录不一致，当前内容保留。'; return }
      if (!allocation) {
        if (!Number.isSafeInteger(session.sequence + 1) || topic.identity.allocations.some(entry => entry.sequence === session.sequence)) {
          this.corruptTopics.add(topicIdentityKey(session.topicId)); seat.status = 'conflict'; this.notice = '主题编号存在冲突或已达到上限，当前内容保留。'; return
        }
        topic.identity = { ...topic.identity, nextSequence: Math.max(topic.identity.nextSequence, session.sequence + 1), allocations: [...topic.identity.allocations, { sessionId: session.id, sequence: session.sequence }] }
      }
    }
    seat.session = { ...session, topicName: topic.name, name: sessionName(topic.name, session.sequence) }
    if (seat.savedSession && topic.persistedName) seat.savedSession = { ...seat.savedSession, topicName: topic.persistedName, name: sessionName(topic.persistedName, seat.savedSession.sequence) }
  }

  getHistory(ownerId?: string): readonly LocalSession[] {
    return [...this.seats.values()].flatMap(seat => seat.savedSession && (ownerId === undefined || seat.savedSession.ownerId === ownerId) ? [seat.savedSession] : [])
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  getOwnerIds(): readonly string[] { return [...new Set([...this.seats.values()].map(seat => seat.session.ownerId))] }
  getAvailableSessions(ownerId: string): readonly LocalSession[] {
    return [...this.seats.values()].map(seat => seat.session).filter(session => session.ownerId === ownerId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  private readSessionOrder(ownerId: string): readonly string[] {
    const cached = this.sessionOrders.get(ownerId)
    if (cached) return cached
    let ids: readonly string[] = []
    try {
      const raw = this.storage?.getItem(sessionOrderKey(ownerId))
      if (raw !== undefined && raw !== null) {
        const decoded = decodeSessionOrder(raw)
        if (!decoded) throw new Error('invalid session order')
        ids = decoded
      }
    } catch { this.notice = '会话排序偏好读取失败，当前会话仍可使用。' }
    this.sessionOrders.set(ownerId, ids); return ids
  }
  /** Presentation only: fixed topic sequences and export order keep their own authority. */
  getDisplaySessions(ownerId: string): readonly LocalSession[] {
    const sessions = this.getAvailableSessions(ownerId), byId = new Map(sessions.map(session => [session.id, session]))
    return reconcileSessionOrder(this.readSessionOrder(ownerId), sessions.map(session => session.id)).map(id => byId.get(id)!)
  }
  private saveSessionOrder(ownerId: string, ids: readonly string[]): boolean {
    this.sessionOrders.set(ownerId, ids)
    try {
      if (!this.storage) throw new Error('storage unavailable')
      this.storage.setItem(sessionOrderKey(ownerId), encodeSessionOrder(ids)); return true
    } catch { this.notice = '会话排序未保存，当前顺序仍保留在本次运行中。'; return false }
  }
  moveSessionInDisplay(ownerId: string, id: string, targetId: string, after = false): boolean {
    const session = this.getSession(id), target = this.getSession(targetId)
    if (!session || !target || session.ownerId !== ownerId || target.ownerId !== ownerId ||
      (session.archivedAt === null) !== (target.archivedAt === null)) return false
    const ids = this.getDisplaySessions(ownerId).map(session => session.id), next = moveSessionOrder(ids, id, targetId, after)
    if (ids.every((value, index) => value === next[index])) return true
    this.notice = undefined
    const saved = this.saveSessionOrder(ownerId, next)
    this.emit(); return saved
  }
  getActiveSessions(ownerId: string): readonly LocalSession[] { return this.getAvailableSessions(ownerId).filter(session => session.archivedAt === null) }
  getArchivedSessions(ownerId: string): readonly LocalSession[] { return this.getAvailableSessions(ownerId).filter(session => session.archivedAt !== null) }
  getActiveSession(ownerId: string): LocalSession | undefined { const id = this.workspaces.get(ownerId)?.active; return id ? this.getSession(id) : undefined }
  private reconcileWorkspace(ownerId: string): void {
    const workspace = this.workspaces.get(ownerId)
    if (!workspace || (workspace.active && this.getSession(workspace.active)?.archivedAt === null)) return
    workspace.active = this.getActiveSessions(ownerId).at(-1)?.id
  }
  ensureWorkspace(ownerId: string): void {
    if (!ownerId.trim() || this.workspaces.has(ownerId)) return
    this.workspaces.set(ownerId, { active: undefined })
    const recent = this.getHistory(ownerId).find(session => session.archivedAt === null)
    if (recent) this.openSession(ownerId, recent.id)
    else if (!this.getAvailableSessions(ownerId).length) this.createSession(ownerId)
  }
  createSession(ownerId: string, parentId?: string, activate = true): LocalSession | undefined {
    if (!ownerId.trim()) return undefined
    this.readSettings()
    this.loadHistory()
    const parent = parentId ? this.getSession(parentId) : undefined
    if (parentId && (!parent || parent.ownerId !== ownerId)) { this.notice = '当前会话无法作为新会话的起点。'; this.emit(); return undefined }
    const topic = parent ? this.topics.get(parent.topicId) : undefined
    if (topic?.durable || (parent && this.settings.rememberHistory)) {
      this.notice = '持久主题的新编号需要异步主题锁，请使用新建子会话操作。'; this.emit(); return undefined
    }
    const session = this.addSession(ownerId, parent, topic, undefined, activate)
    if (this.settings.rememberHistory) this.persist(session.id)
    this.emit(); return session
  }

  private freshId(): string {
    let id: string
    do {
      id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? `tr-${crypto.randomUUID()}` : `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
    } while (this.seats.has(id) || this.isDeleted(id) || [...this.topics.values()].some(topic => topic.identity.allocations.some(entry => entry.sessionId === id)))
    return id
  }

  private addSession(ownerId: string, parent?: LocalSession, topic?: TopicSeat, reserved?: { readonly id: string; readonly sequence: number }, activate = true): LocalSession {
    const id = reserved?.id ?? this.freshId()
    const sequence = reserved?.sequence ?? topic?.identity.nextSequence ?? 0
    if (!Number.isSafeInteger(sequence + 1)) throw new Error('sequence exhausted')
    const settings = parent ? { ...this.settings, defaultMode: parent.mode, targetLanguage: parent.targetLanguage, defaultInstruction: parent.instruction, maxInputChars: parent.maxInputChars } : this.settings
    const initial = newSession(settings, ownerId, id, topic?.name ?? '新翻译会话', parent?.id ?? null, topic?.identity.id, topic?.identity.sequenceNamespaceId, sequence)
    const model = parent ? parent.model : this.lastModels.has(ownerId) ? this.lastModels.get(ownerId)! : this.readModelPreference(ownerModelKey(ownerId)) ?? null
    const session = { ...initial, model: model ? { ...model } : null }
    if (topic && !reserved) topic.identity = { ...topic.identity, nextSequence: sequence + 1, allocations: [...topic.identity.allocations, { sessionId: id, sequence }] }
    this.seats.set(id, { session, savedSession: undefined, translationHistory: emptyTranslationHistory(), savedTranslationHistory: emptyTranslationHistory(), stored: null, legacyRaw: null, status: 'memory' })
    this.adoptTopic(this.seats.get(id)!)
    if (activate) this.openSession(ownerId, id)
    return session
  }

  private async withStructureLock<T>(failure: T, action: () => T | Promise<T>): Promise<T> {
    if (!this.storage || !this.locks) {
      this.notice = '当前环境缺少 Web Locks 或本地存储。持久主题的新建、重命名与迁移保存已暂停；当前输入仍保留。'; this.emit(); return failure
    }
    try { return await this.locks.request(TOPIC_LOCK_NAME, () => this.disposed ? failure : action()) }
    catch { this.notice = '主题编号或名称保存失败，当前输入仍保留；请检查本地存储后重试。'; this.emit(); return failure }
  }

  /** 有历史保存或既有持久身份时，先可靠发号；正文保存失败可留下空号。 */
  async createSessionAsync(ownerId: string, parentId?: string, activate = true): Promise<LocalSession | undefined> {
    if (!ownerId.trim()) return undefined
    if (!this.readSettings()) { this.emit(); return undefined }
    this.loadHistory()
    const parent = parentId ? this.getSession(parentId) : undefined
    if (parentId && (!parent || parent.ownerId !== ownerId)) { this.notice = '当前会话无法作为新会话的起点。'; this.emit(); return undefined }
    if (!this.settings.rememberHistory && (!parent || !this.topics.get(parent.topicId)?.durable)) return this.createSession(ownerId, parentId, activate)
    return this.withStructureLock(undefined, () => this.createSessionLocked(ownerId, parentId, undefined, activate))
  }

  private createSessionLocked(ownerId: string, parentId?: string, topicId?: string, activate = true): LocalSession | undefined {
    if (!this.readSettings()) return undefined
    this.loadHistory()
    const currentParent = parentId ? this.getSession(parentId) : topicId ? this.getAvailableSessions(ownerId).find(session => session.topicId === topicId && !this.isDeleted(session.id)) : undefined
    if (parentId && (!currentParent || currentParent.ownerId !== ownerId || this.isDeleted(parentId))) {
      this.notice = '原会话已变化或删除，新建未执行。'; this.emit(); return undefined
    }
    let topic = topicId ? this.topics.get(topicId) : currentParent ? this.topics.get(currentParent.topicId) : undefined
    if (topicId && (!topic || topic.identity.ownerId !== ownerId)) return undefined
    const id = this.freshId()
    if (!topic) {
      topic = {
        identity: { schemaVersion: 1, id: `topic:${id}`, ownerId, sequenceNamespaceId: `sequence:${id}`, nextSequence: 0, version: 0, allocations: [] },
        name: '新翻译会话', persistedName: undefined, stored: null, durable: false, nameDirty: false,
      }
      this.topics.set(topic.identity.id, topic)
    }
    if (!this.settings.rememberHistory && !topic.durable) {
      const session = this.addSession(ownerId, currentParent, topic, { id, sequence: topic.identity.nextSequence }, activate)
      this.notice = undefined; this.emit(); return session
    }
    if (!this.storage || !this.locks) {
      this.notice = '当前环境无法协调持久主题编号，新建未执行。'; this.emit(); return undefined
    }
    this.writeIdentity(topic)
    const sequence = topic.identity.nextSequence
    if (!Number.isSafeInteger(sequence + 1)) throw new Error('sequence exhausted')
    this.writeIdentity(topic, { sessionId: id, sequence })
    if (this.settings.rememberHistory) this.writeTopicName(topic)
    const session = this.addSession(ownerId, currentParent, topic, { id, sequence }, activate)
    this.notice = undefined
    if (this.settings.rememberHistory) this.persistLocked(id)
    this.emit(); return session
  }

  async createSessionForTopicAsync(ownerId: string, topicId: string, activate = true): Promise<LocalSession | undefined> {
    this.loadHistory()
    const topic = this.topics.get(topicId)
    if (!topic || topic.identity.ownerId !== ownerId) return undefined
    const parent = this.getAvailableSessions(ownerId).find(session => session.topicId === topicId)
    if (parent) return this.createSessionAsync(ownerId, parent.id, activate)
    if (!this.readSettings()) return undefined
    if (!topic.durable && !this.settings.rememberHistory) return this.createSessionLocked(ownerId, undefined, topicId, activate)
    return this.withStructureLock(undefined, () => this.createSessionLocked(ownerId, undefined, topicId, activate))
  }
  openSession(ownerId: string, id: string): void {
    const session = this.getSession(id)
    if (!session || session.ownerId !== ownerId || session.archivedAt !== null) return
    let workspace = this.workspaces.get(ownerId)
    if (!workspace) { workspace = { active: undefined }; this.workspaces.set(ownerId, workspace) }
    workspace.active = id; this.emit()
  }
  archiveSession(ownerId: string, id: string, archived = true, activate = true): boolean {
    const seat = this.seats.get(id)
    if (!seat || seat.session.ownerId !== ownerId) return false
    const time = new Date().toISOString()
    seat.session = { ...seat.session, archivedAt: archived ? time : null, updatedAt: time }
    if (seat.status !== 'conflict') seat.status = 'memory'
    this.notice = undefined
    if (this.settings.rememberHistory) this.persist(id)
    this.reconcileWorkspace(ownerId)
    if (!archived && activate) this.openSession(ownerId, id)
    this.emit(); return true
  }

  private managementFailure(code: string, message: string): SessionManagementResult {
    this.notice = message; this.emit(); return { ok: false, code, message }
  }

  /** Expected metadata and the actual retention setting are checked under the existing topic lock. */
  private async manageSessions(action: () => SessionManagementResult): Promise<SessionManagementResult> {
    const run = (): SessionManagementResult => {
      if (this.disposed) return this.managementFailure('operation_failed', '会话管理已关闭，未执行修改。')
      if (!this.readSettings()) return this.managementFailure('storage_error', '设置无法读取，未执行修改。')
      this.loadHistory()
      return action()
    }
    try {
      return this.storage && this.locks ? await this.locks.request(TOPIC_LOCK_NAME, run) : run()
    } catch {
      return this.managementFailure('storage_error', '会话操作或保存未完成，内存可能已变化，请查询当前记录；未自动重试。')
    }
  }

  private managedSessionCurrent(seat: Seat): boolean {
    if (seat.status === 'conflict' || (this.storage && (this.storage.getItem(historyKey(seat.session.id)) !== seat.stored ||
      (seat.session.legacyKey && this.storage.getItem(seat.session.legacyKey) !== seat.legacyRaw)))) {
      seat.status = 'conflict'; return false
    }
    return true
  }

  private finishManagedSession(seat: Seat): SessionManagementResult {
    if (this.settings.rememberHistory) {
      try {
        const topic = this.topics.get(seat.session.topicId)!
        this.writeIdentity(topic); this.writeTopicName(topic); this.adoptTopic(seat)
        if (seat.status !== 'saved' && !this.persistLocked(seat.session.id)) {
          return this.managementFailure(seat.status === 'conflict' ? 'conflict' : 'storage_error', '会话修改未保存，内存可能已变化，请查询当前记录。')
        }
      } catch {
        seat.status = 'error'
        return this.managementFailure('storage_error', '会话修改未保存，内存可能已变化，请查询当前记录。')
      }
    }
    this.notice = undefined; this.emit()
    return { ok: true, sessions: [seat.session], persistence: this.settings.rememberHistory ? 'saved' : 'runtime_only' }
  }

  async createManagedSessionAsync(ownerId: string, start: TopicSessionStart): Promise<SessionManagementResult> {
    return this.manageSessions(() => {
      if (!ownerId.trim()) return this.managementFailure('out_of_scope', '主会话身份无效。')
      const parentId = start.kind === 'parent_session' ? start.translationSessionId : undefined
      const topicId = start.kind === 'existing_topic' ? start.topicId : undefined
      const parent = parentId ? this.seats.get(parentId) : undefined
      if (parentId && (!parent || parent.session.ownerId !== ownerId || this.isDeleted(parentId))) return this.managementFailure('out_of_scope', '起点会话不属于当前主会话或已删除。')
      if (parent && !this.managedSessionCurrent(parent)) return this.managementFailure('conflict', '起点会话在其他窗口变化，请先核对当前记录。')
      if (topicId && this.topics.get(topicId)?.identity.ownerId !== ownerId) return this.managementFailure('out_of_scope', '主题不属于当前主会话或不存在。')
      const session = this.createSessionLocked(ownerId, parentId, topicId, false)
      if (!session) return this.managementFailure('operation_failed', this.notice ?? '新会话未创建，请核对当前记录。')
      const seat = this.seats.get(session.id)!
      if (this.settings.rememberHistory && seat.status !== 'saved') return this.managementFailure('storage_error', '新会话未保存，内存可能已创建，请查询当前会话列表；未自动重试。')
      return { ok: true, sessions: [seat.session], persistence: this.settings.rememberHistory ? 'saved' : 'runtime_only' }
    })
  }

  async renameTopicAsync(ownerId: string, topicId: string, expectedName: string, name: string): Promise<SessionManagementResult> {
    return this.manageSessions(() => {
      const topic = this.topics.get(topicId)
      if (!topic || topic.identity.ownerId !== ownerId) return this.managementFailure('out_of_scope', '主题不属于当前主会话或不存在。')
      if (!this.validTopicName(name)) return this.managementFailure('invalid_input', this.notice!)
      const raw = this.storage?.getItem(topicNameKey(topicId)) ?? null
      const saved = raw === null ? undefined : decodeTopicName(raw, topic.identity)
      if (topic.name !== expectedName || (raw !== null && (!saved || (topic.persistedName !== undefined && saved.name !== topic.persistedName)))) {
        return this.managementFailure('conflict', '主题名称已变化，未采用陈旧修改，请查询当前名称。')
      }
      if (this.settings.rememberHistory) {
        if (!this.storage || !this.locks) return this.managementFailure('storage_error', '当前环境无法协调名称保存，未执行修改。')
        this.writeIdentity(topic)
        if (saved?.name !== name.trim()) {
          const version = (saved?.version ?? 0) + 1
          if (!Number.isSafeInteger(version)) throw new Error('version exhausted')
          this.storage.setItem(topicNameKey(topicId), JSON.stringify({ schemaVersion: 1, topicId, sequenceNamespaceId: topic.identity.sequenceNamespaceId, name: name.trim(), version }))
        }
        if (topic.name !== name.trim() || topic.nameDirty) this.projectName(topic, name.trim(), true)
        else topic.persistedName = name.trim()
      } else if (topic.name !== name.trim()) this.projectName(topic, name.trim(), false)
      this.notice = undefined; this.emit()
      return { ok: true, sessions: this.getAvailableSessions(ownerId).filter(session => session.topicId === topicId && !this.isDeleted(session.id)), persistence: this.settings.rememberHistory ? 'saved' : 'runtime_only' }
    })
  }

  async setSessionRemarkAsync(ownerId: string, id: string, expectedRemark: string, remark: string): Promise<SessionManagementResult> {
    return this.manageSessions(() => {
      const seat = this.seats.get(id)
      if (!seat || seat.session.ownerId !== ownerId || this.isDeleted(id)) return this.managementFailure('out_of_scope', '翻译会话不属于当前主会话或已删除。')
      if (!this.managedSessionCurrent(seat) || seat.session.remark !== expectedRemark) return this.managementFailure('conflict', '会话备注已变化，未采用陈旧修改，请查询当前记录。')
      if (Array.from(remark).length > 1000) return this.managementFailure('invalid_input', '备注最多 1000 个字符。')
      if (this.settings.rememberHistory && (!this.storage || !this.locks)) return this.managementFailure('storage_error', '当前环境无法协调会话保存，未执行修改。')
      if (seat.session.remark !== remark) {
        seat.session = { ...seat.session, remark, updatedAt: new Date().toISOString() }; seat.status = 'memory'
      }
      return this.finishManagedSession(seat)
    })
  }

  async setSessionArchivedAsync(ownerId: string, id: string, expectedArchived: boolean, archived: boolean): Promise<SessionManagementResult> {
    return this.manageSessions(() => {
      const seat = this.seats.get(id)
      if (!seat || seat.session.ownerId !== ownerId || this.isDeleted(id)) return this.managementFailure('out_of_scope', '翻译会话不属于当前主会话或已删除。')
      if (!this.managedSessionCurrent(seat) || (seat.session.archivedAt !== null) !== expectedArchived) return this.managementFailure('conflict', '会话归档状态已变化，未采用陈旧修改，请查询当前记录。')
      if (this.settings.rememberHistory && (!this.storage || !this.locks)) return this.managementFailure('storage_error', '当前环境无法协调会话保存，未执行修改。')
      if (expectedArchived !== archived) {
        const time = new Date().toISOString()
        seat.session = { ...seat.session, archivedAt: archived ? time : null, updatedAt: time }; seat.status = 'memory'
        this.reconcileWorkspace(ownerId)
      }
      return this.finishManagedSession(seat)
    })
  }
  updateSession(id: string, patch: Partial<Pick<LocalSession, 'mode' | 'targetLanguage' | 'input' | 'instruction' | 'model' | 'maxInputChars' | 'remark'>>): boolean {
    const seat = this.seats.get(id)
    if (!seat) return false
    if (seat.session.mode === 'normal' && patch.mode === 'quick') {
      this.notice = '普通会话不能降为快译。需要快译时请新建主题。'; this.emit(); return false
    }
    const next = decodeSession({ ...seat.session, ...patch, updatedAt: new Date().toISOString() })
    if (!next) { this.notice = '输入无效或过长，之前的会话内容仍保留。'; this.emit(); return false }
    seat.session = next
    if (seat.status !== 'conflict') seat.status = 'memory'
    this.notice = undefined
    if (Object.hasOwn(patch, 'model')) this.rememberModel(seat)
    if (this.settings.rememberHistory) this.persist(id)
    this.emit(); return true
  }
  /** The conversion runs against current memory; persistence shares the existing session lock and conflict checks. */
  updateTranslationHistory(id: string, update: (history: TranslationHistory) => TranslationHistory): boolean {
    const seat = this.seats.get(id)
    if (!seat || this.disposed) return false
    try {
      if (this.isDeleted(id)) { this.notice = '会话已删除，迟到的翻译记录未采用。'; this.emit(); return false }
      const next = decodeTranslationHistory(update(structuredClone(seat.translationHistory)))
      if (!next) throw new Error('invalid translation history')
      if (JSON.stringify(next) === JSON.stringify(seat.translationHistory)) return true
      seat.translationHistory = next
      seat.session = { ...seat.session, updatedAt: new Date().toISOString() }
      if (seat.status !== 'conflict') seat.status = 'memory'
      this.notice = undefined
      if (this.settings.rememberHistory) this.persist(id)
      this.emit(); return true
    } catch { this.notice = '翻译记录更新失败，之前的材料与版本仍保留。'; this.emit(); return false }
  }
  renameSession(id: string, name: string): boolean {
    const seat = this.seats.get(id)
    if (!seat) return false
    if (!this.readSettings()) { this.emit(); return false }
    if (this.settings.rememberHistory) { this.notice = '已开启历史保存，请使用异步主题重命名操作。'; this.emit(); return false }
    const topic = this.topics.get(seat.session.topicId)
    if (!topic || !this.validTopicName(name)) return false
    this.projectName(topic, name.trim(), false)
    this.notice = undefined
    this.emit(); return true
  }

  private validTopicName(name: string): boolean {
    if (!name.trim() || Array.from(name.trim()).length > 120) { this.notice = '主题名称不能为空，且最多 120 个字符。'; this.emit(); return false }
    return true
  }

  private projectName(topic: TopicSeat, name: string, saved: boolean): void {
    topic.name = name; topic.nameDirty = !saved
    if (saved) topic.persistedName = name
    const time = new Date().toISOString()
    for (const seat of this.seats.values()) if (seat.session.topicId === topic.identity.id) {
      seat.session = { ...seat.session, topicName: name, name: sessionName(name, seat.session.sequence), updatedAt: time }
      if (saved && seat.savedSession) seat.savedSession = { ...seat.savedSession, topicName: name, name: sessionName(name, seat.savedSession.sequence) }
      else if (seat.status !== 'conflict') seat.status = 'memory'
    }
  }

  async renameSessionAsync(id: string, name: string): Promise<boolean> {
    if (!this.validTopicName(name) || !this.readSettings()) return false
    if (!this.settings.rememberHistory) return this.renameSession(id, name)
    const seat = this.seats.get(id), topic = seat && this.topics.get(seat.session.topicId)
    if (!seat || !topic) return false
    let expectedName: string | null
    try { expectedName = this.storage?.getItem(topicNameKey(topic.identity.id)) ?? null }
    catch { this.notice = '主题名称读取失败，当前名称保留。'; this.emit(); return false }
    const expectedRecord = expectedName === null ? undefined : decodeTopicName(expectedName, topic.identity)
    if (expectedName !== null && (!expectedRecord || (topic.persistedName !== undefined && expectedRecord.name !== topic.persistedName))) {
      this.notice = '主题已在其他窗口重命名，请核对最新名称后重试。'; this.emit(); return false
    }
    return this.withStructureLock(false, () => {
      if (!this.readSettings()) return false
      if (!this.settings.rememberHistory) return this.renameSession(id, name)
      if (this.isDeleted(id) || this.storage?.getItem(topicNameKey(topic.identity.id)) !== expectedName) {
        this.notice = '会话或主题名称已在其他窗口变化，请核对后重试。'; this.emit(); return false
      }
      this.writeIdentity(topic)
      const version = (expectedRecord?.version ?? 0) + 1
      if (!Number.isSafeInteger(version)) throw new Error('version exhausted')
      const nameRecord = { schemaVersion: 1, topicId: topic.identity.id, sequenceNamespaceId: topic.identity.sequenceNamespaceId, name: name.trim(), version }
      this.storage!.setItem(topicNameKey(topic.identity.id), JSON.stringify(nameRecord))
      this.projectName(topic, name.trim(), true)
      this.notice = undefined; this.emit(); return true
    })
  }

  private writeIdentity(topic: TopicSeat, allocation?: { readonly sessionId: string; readonly sequence: number }): void {
    if (!this.storage || this.corruptTopics.has(topicIdentityKey(topic.identity.id))) throw new Error('topic unavailable')
    const key = topicIdentityKey(topic.identity.id), raw = this.storage.getItem(key)
    const latest = raw === null ? undefined : decodeTopicIdentity(raw)
    if ((raw !== null && !latest) || (raw === null && topic.stored !== null) ||
      (latest && (latest.ownerId !== topic.identity.ownerId || latest.sequenceNamespaceId !== topic.identity.sequenceNamespaceId))) throw new Error('topic conflict')
    const allocations = [...(latest?.allocations ?? [])]
    for (const item of [...topic.identity.allocations, ...(allocation ? [allocation] : [])]) {
      const known = allocations.find(entry => entry.sessionId === item.sessionId)
      if (known && known.sequence !== item.sequence) throw new Error('allocation conflict')
      if (!known) {
        if (allocations.some(entry => entry.sequence === item.sequence)) throw new Error('sequence conflict')
        allocations.push(item)
      }
    }
    const nextSequence = allocations.reduce((highest, entry) => Math.max(highest, entry.sequence + 1), Math.max(latest?.nextSequence ?? 0, topic.identity.nextSequence))
    if (!Number.isSafeInteger(nextSequence)) throw new Error('sequence exhausted')
    const changed = !latest || latest.nextSequence !== nextSequence || latest.allocations.length !== allocations.length
    const identity: TopicIdentity = { ...topic.identity, nextSequence, allocations, version: changed ? (latest?.version ?? 0) + 1 : latest.version }
    if (!Number.isSafeInteger(identity.version)) throw new Error('version exhausted')
    const serialized = changed ? JSON.stringify(identity) : raw!
    if (changed) this.storage.setItem(key, serialized)
    topic.identity = identity; topic.stored = serialized; topic.durable = true
  }

  private writeTopicName(topic: TopicSeat): void {
    if (!this.storage || !this.readSettings() || !this.settings.rememberHistory) return
    const key = topicNameKey(topic.identity.id), raw = this.storage.getItem(key)
    const old = raw === null ? undefined : decodeTopicName(raw, topic.identity)
    if (raw !== null && !old) throw new Error('topic name unavailable')
    if (old && !topic.nameDirty) { topic.name = old.name; topic.persistedName = old.name; return }
    if (old && topic.persistedName !== undefined && old.name !== topic.persistedName) throw new Error('topic name conflict')
    const version = (old?.version ?? 0) + 1
    if (!Number.isSafeInteger(version)) throw new Error('version exhausted')
    this.storage.setItem(key, JSON.stringify({ schemaVersion: 1, topicId: topic.identity.id, sequenceNamespaceId: topic.identity.sequenceNamespaceId, name: topic.name, version }))
    this.projectName(topic, topic.name, true)
  }

  private persist(id: string, overwrite = false): boolean {
    void this.saveSessionAsync(id, overwrite)
    return false
  }

  private saveSessionAsync(id: string, overwrite = false): Promise<boolean> {
    const pending = this.pendingSaves.get(id)
    if (pending && !overwrite) { this.dirtySaves.add(id); return pending }
    const seat = this.seats.get(id)
    if (!seat) return Promise.resolve(false)
    const promise = this.withStructureLock(false, () => {
      if (!this.readSettings() || !this.settings.rememberHistory) return false
      const current = this.seats.get(id), topic = current && this.topics.get(current.session.topicId)
      if (!current || !topic || this.isDeleted(id)) {
        if (current) current.status = 'conflict'
        this.notice = '会话已删除或主题身份不可用，当前输入保留。'; this.emit(); return false
      }
      try {
        this.writeIdentity(topic)
        this.writeTopicName(topic)
        this.adoptTopic(current)
        const result = this.persistLocked(id, overwrite)
        this.emit(); return result
      } catch {
        current.status = 'error'; this.notice = '主题或会话历史保存失败，当前输入仍保留。'; this.emit(); return false
      }
    }).then(result => {
      if (!result && !this.locks && this.seats.get(id)?.status !== 'conflict') { seat.status = 'error'; this.emit() }
      return result
    }).finally(() => {
      if (this.pendingSaves.get(id) !== promise) return
      this.pendingSaves.delete(id)
      // A mutation can arrive after the lock wrote its snapshot but before this promise settles.
      // Schedule that new dirty state once; failed/conflicting writes await explicit user action.
      if (this.dirtySaves.delete(id) && !this.disposed && this.settings.rememberHistory && this.seats.get(id)?.status === 'memory') this.persist(id)
    })
    this.pendingSaves.set(id, promise)
    return promise
  }

  private persistLocked(id: string, overwrite = false): boolean {
    const seat = this.seats.get(id)
    if (!seat || !this.storage) { this.notice = '会话历史保存不可用，内容仍保留在当前窗口。'; return false }
    try {
      if (!this.readSettings()) throw new Error('invalid settings')
      if (!this.settings.rememberHistory) return false
      if (this.isDeleted(id)) { seat.status = 'conflict'; this.notice = '会话已在其他窗口删除，当前输入保留，不能覆盖恢复已删除身份。'; return false }
      const raw = this.storage.getItem(historyKey(id))
      if (!overwrite && (raw !== seat.stored || seat.status === 'conflict')) {
        seat.status = 'conflict'; this.notice = '会话历史已在其他窗口修改或删除，当前输入保留。请选择读取本地副本或明确覆盖。'; return false
      }
      const hasTranslations = seat.translationHistory.units.length > 0 || seat.translationHistory.events.length > 0
      const serialized = JSON.stringify({ schemaVersion: hasTranslations ? 10 : 3, token: `${Date.now()}-${Math.random()}`, session: seat.session,
        ...(hasTranslations ? { translationHistory: persistedTranslationHistory(seat.translationHistory) } : {}) })
      this.storage.setItem(historyKey(id), serialized)
      if (this.storage.getItem(historyKey(id)) !== serialized) throw new Error('history read-back failed')
      seat.stored = serialized; seat.savedSession = seat.session; seat.savedTranslationHistory = seat.translationHistory; seat.status = 'saved'
      return true
    } catch { seat.status = 'error'; this.notice = '会话历史保存失败，当前输入仍保留在窗口内存中。'; return false }
  }
  overwriteSession(id: string): boolean { this.notice = '覆盖保存需要等待主题锁，请使用异步覆盖操作。'; this.emit(); return false }
  async overwriteSessionAsync(id: string): Promise<boolean> { this.notice = undefined; return this.saveSessionAsync(id, true) }
  private matchesHistoryIdentity(session: LocalSession, previous: LocalSession): boolean {
    // 旧副本在读完父边后再迁移；新格式必须符合已发放的主题身份。
    if (session.sequenceNamespaceId.startsWith('legacy-pending:')) return true
    if (session.topicId !== previous.topicId || session.sequenceNamespaceId !== previous.sequenceNamespaceId || session.sequence !== previous.sequence) return false
    const key = topicIdentityKey(session.topicId)
    if (this.corruptTopics.has(key)) return false
    const topic = this.topics.get(session.topicId)
    const raw = this.storage?.getItem(key) ?? null
    if (raw === null && topic?.stored !== null) return false
    const identity = raw === null ? topic?.identity : decodeTopicIdentity(raw)
    return !!identity && identity.id === session.topicId && identity.ownerId === session.ownerId &&
      identity.sequenceNamespaceId === session.sequenceNamespaceId &&
      identity.allocations.some(allocation => allocation.sessionId === session.id && allocation.sequence === session.sequence)
  }
  reloadSession(id: string): boolean {
    const seat = this.seats.get(id)
    if (!seat || !this.storage) return false
    try {
      const raw = this.storage.getItem(historyKey(id))
      const snapshot = raw === null ? undefined : readSnapshot(raw), session = snapshot?.session
      if (!session || session.id !== id || session.ownerId !== seat.session.ownerId || this.isDeleted(id) || !this.matchesHistoryIdentity(session, seat.session)) throw new Error('invalid history')
      this.notice = undefined
      seat.session = this.restoreModel(session); seat.savedSession = session; seat.translationHistory = restoreTranslationHistory(snapshot!.translationHistory)
      seat.savedTranslationHistory = snapshot!.translationHistory; seat.stored = raw; seat.status = 'saved'
      const topic = this.topics.get(session.topicId)
      if (topic) { topic.nameDirty = false; topic.name = topic.persistedName ?? session.topicName }
      if (session.sequenceNamespaceId.startsWith('legacy-pending:')) this.migrationSources.set(id, session)
      else this.migrationSources.delete(id)
      this.loadHistory(); this.adoptTopic(seat)
      this.reconcileWorkspace(session.ownerId); this.emit(); return true
    } catch { this.notice = '本地副本不存在或无法读取，当前输入保持不变。'; this.emit(); return false }
  }

  getUnreadableHistory(): readonly { readonly key: string; readonly raw: string }[] {
    const result: { key: string; raw: string }[] = []
    if (!this.storage) return result
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i)
        if (!key || !(key.startsWith(HISTORY_PREFIX) || key.startsWith(LEGACY_DRAFT_PREFIX))) continue
        const raw = this.storage.getItem(key)
        if (raw === null) continue
        const session = key.startsWith(HISTORY_PREFIX) ? readHistory(raw) : legacySession(key, raw)
        if (!session || this.isDeleted(session.id) || (key.startsWith(HISTORY_PREFIX) && historyKey(session.id) !== key)) result.push({ key, raw })
      }
    } catch { this.notice = '部分历史存储无法检查，清理范围可能不完整。' }
    return result
  }

  captureHistoryVersions(ids: readonly string[]): readonly HistoryVersion[] {
    return ids.flatMap(id => { const seat = this.seats.get(id); return seat ? [{ id, stored: seat.stored, legacyRaw: seat.legacyRaw, current: currentVersion(seat) }] : [] })
  }

  async deleteHistoryAsync(ids: readonly string[], deleteMemory = false, unreadable: readonly { readonly key: string; readonly raw: string }[] = [], expected?: readonly HistoryVersion[], companion?: HistoryDeleteCompanion): Promise<boolean> {
    if (deleteMemory) return this.deleteHistory(ids, true, unreadable, expected)
    const frozen = expected ?? this.captureHistoryVersions(ids)
    const requiresStorage = !!companion?.requiresStorage || unreadable.length > 0 || ids.some(id => {
      const seat = this.seats.get(id)
      return seat && (seat.stored !== null || seat.legacyRaw !== null || this.topics.get(seat.session.topicId)?.durable)
    })
    if (!requiresStorage) return this.deleteHistoryLocked(ids, false, unreadable, frozen, companion)
    return this.withStructureLock(false, () => {
      // 只保存身份与既有发号记录，不把关闭保存期间的新名称/正文写入磁盘。
      for (const id of ids) {
        const seat = this.seats.get(id), topic = seat && this.topics.get(seat.session.topicId)
        if (topic?.durable) this.writeIdentity(topic)
      }
      return this.deleteHistoryLocked(ids, false, unreadable, frozen, companion)
    })
  }

  deleteHistory(ids: readonly string[], deleteMemory = false, unreadable: readonly { readonly key: string; readonly raw: string }[] = [], expected?: readonly HistoryVersion[]): boolean {
    if (!deleteMemory && (unreadable.length || ids.some(id => {
      const seat = this.seats.get(id)
      return seat && (seat.stored !== null || seat.legacyRaw !== null || this.topics.get(seat.session.topicId)?.durable)
    }))) {
      this.notice = '已保存历史的删除需要等待主题锁，请使用异步删除操作。'; this.emit(); return false
    }
    return this.deleteHistoryLocked(ids, deleteMemory, unreadable, expected)
  }

  private deleteHistoryLocked(ids: readonly string[], deleteMemory: boolean, unreadable: readonly { readonly key: string; readonly raw: string }[], expected?: readonly HistoryVersion[], companion?: HistoryDeleteCompanion): boolean {
    if (deleteMemory) { this.notice = '关联记忆档案尚未接入，此操作未执行。'; this.emit(); return false }
    let removedSessions = 0, removedUnreadable = 0, currentRemoval = '删除前检查', orderSaved = true
    try {
      const seats = [...new Set(ids)].map(id => this.seats.get(id)).filter((seat): seat is Seat => !!seat)
      if (!this.storage && (unreadable.length || seats.some(seat => seat.stored !== null || seat.legacyRaw !== null))) {
        this.notice = '本地存储不可用，已保存历史未删除。'; this.emit(); return false
      }
      for (const item of unreadable) {
        if (!(item.key.startsWith(HISTORY_PREFIX) || item.key.startsWith(LEGACY_DRAFT_PREFIX)) || this.storage?.getItem(item.key) !== item.raw) {
          this.notice = '清理范围或历史副本已变化，请重新选择后确认。'; this.emit(); return false
        }
      }
      // 删除前检查已保存版本，避免清理另一个窗口刚刚更新的会话。
      for (const seat of seats) {
        const topic = this.topics.get(seat.session.topicId)
        if (topic?.durable && !topic.stored) {
          this.notice = '删除前需要可靠保存主题编号，请使用异步删除操作。'; this.emit(); return false
        }
        const version = expected ? expected.find(item => item.id === seat.session.id) : seat
        if (!version || (expected && currentVersion(seat) !== expected.find(item => item.id === seat.session.id)?.current) ||
          (this.storage?.getItem(historyKey(seat.session.id)) ?? null) !== version.stored ||
          (seat.session.legacyKey && (this.storage?.getItem(seat.session.legacyKey) ?? null) !== version.legacyRaw)) {
          this.notice = '待删除会话或历史已变化，请核对最新内容后重新确认。'; this.emit(); return false
        }
      }
      if (companion && !companion.preflight()) {
        this.notice = '待删除主题术语已变化或无法读取，会话及术语均未删除。'; this.emit(); return false
      }
      for (const item of unreadable) {
        currentRemoval = `无法读取的历史副本 ${removedUnreadable + 1}`
        const legacyKey = item.key.startsWith(LEGACY_DRAFT_PREFIX) ? item.key : null
        let id: string | undefined
        try { id = legacyKey ? `legacy:${legacyKey}` : decodeURIComponent(item.key.slice(HISTORY_PREFIX.length)) } catch { /* 无可解码 ID 时仅删除确认过的原键。 */ }
        if (id?.trim()) {
          this.storage!.setItem(deletedSessionKey(id), JSON.stringify({ schemaVersion: 1, sessionId: id, legacyKey }))
          this.deleted.add(id)
          this.storage!.removeItem(sessionModelKey(id))
        }
        this.storage?.removeItem(item.key)
        removedUnreadable++
      }
      for (const seat of seats) {
        currentRemoval = `会话「${seat.session.name}」`
        if (seat.stored !== null || seat.legacyRaw !== null || this.topics.get(seat.session.topicId)?.durable) {
          this.storage!.setItem(deletedSessionKey(seat.session.id), JSON.stringify({ schemaVersion: 1, sessionId: seat.session.id, legacyKey: seat.session.legacyKey }))
          this.deleted.add(seat.session.id); seat.status = 'conflict'; seat.savedSession = undefined
        }
        this.storage?.removeItem(historyKey(seat.session.id))
        seat.stored = null
        if (seat.session.legacyKey) { this.storage?.removeItem(seat.session.legacyKey); seat.legacyRaw = null }
        this.storage?.removeItem(sessionModelKey(seat.session.id))
        this.seats.delete(seat.session.id)
        this.migrationSources.delete(seat.session.id)
        const order = this.readSessionOrder(seat.session.ownerId)
        if (order.includes(seat.session.id)) orderSaved = this.saveSessionOrder(seat.session.ownerId, order.filter(id => id !== seat.session.id)) && orderSaved
        this.reconcileWorkspace(seat.session.ownerId)
        removedSessions++
      }
      if (companion && !companion.afterHistoryDeleted()) {
        this.notice = '所选会话已删除，但主题术语未全部清理。请核对术语存储提示与剩余范围。'; this.emit(); return false
      }
      this.notice = orderSaved ? undefined : '会话已删除，但排序偏好清理未保存；当前列表已移除该会话。'; this.emit(); return true
    } catch { this.notice = `历史清理未完全完成：已移除 ${removedSessions} 条会话和 ${removedUnreadable} 份无法读取的副本；${currentRemoval}未完成。请核对剩余范围后重新确认。`; this.emit(); return false }
  }

  private externalChange(key: string | null): void {
    if (key === null) this.sessionOrders.clear()
    else if (key.startsWith(SESSION_ORDER_PREFIX)) {
      for (const ownerId of this.sessionOrders.keys()) if (key === sessionOrderKey(ownerId)) this.sessionOrders.delete(ownerId)
    }
    if (key === null || key.startsWith(OWNER_MODEL_PREFIX)) this.lastModels.clear()
    if (key === null || key.startsWith(SESSION_MODEL_PREFIX)) {
      for (const seat of this.seats.values()) {
        if (key !== null && key !== sessionModelKey(seat.session.id)) continue
        seat.session = this.restoreModel(seat.session)
      }
    }
    if (key === null || key === SETTINGS_KEY || key === LEGACY_SETTINGS_KEY) {
      const wasEnabled = this.settings.rememberHistory
      if (this.readSettings() && !wasEnabled && this.settings.rememberHistory) this.queueHistorySaves()
    }
    if (key === null || key?.startsWith(HISTORY_PREFIX) || key?.startsWith(LEGACY_DRAFT_PREFIX) ||
      key?.startsWith(TOPIC_IDENTITY_PREFIX) || key?.startsWith(TOPIC_NAME_PREFIX) || key?.startsWith(DELETED_SESSION_PREFIX)) {
      for (const seat of this.seats.values()) {
        if (key !== null && key !== historyKey(seat.session.id) && key !== seat.session.legacyKey && key !== deletedSessionKey(seat.session.id)) continue
        try {
          if (this.isDeleted(seat.session.id)) {
            seat.savedSession = undefined; seat.status = 'conflict'; this.notice = '会话已在其他窗口删除，当前草稿仅保留在本窗口，不能覆盖恢复。'; continue
          }
          const raw = this.storage?.getItem(historyKey(seat.session.id)) ?? null
          const legacyRaw = seat.session.legacyKey ? this.storage?.getItem(seat.session.legacyKey) ?? null : null
          if (legacyRaw !== seat.legacyRaw && raw === seat.stored) {
            if (legacyRaw === null && raw === null) seat.savedSession = undefined
            seat.status = 'conflict'; this.notice = '旧版草稿在其他窗口变化，当前输入保留。'; continue
          }
          if (raw !== seat.stored) {
            const snapshot = raw === null ? undefined : readSnapshot(raw), latest = snapshot?.session
            if (seat.status === 'saved' && latest && latest.id === seat.session.id && latest.ownerId === seat.session.ownerId && this.matchesHistoryIdentity(latest, seat.session)) {
              seat.session = this.restoreModel(latest); seat.savedSession = latest
              // A storage notification is live synchronization, not a restart: keep remote running facts intact.
              seat.translationHistory = snapshot!.translationHistory; seat.savedTranslationHistory = snapshot!.translationHistory; seat.stored = raw
              if (latest.sequenceNamespaceId.startsWith('legacy-pending:')) this.migrationSources.set(latest.id, latest)
              else this.migrationSources.delete(latest.id)
            } else {
              if (raw === null) seat.savedSession = undefined
              seat.status = 'conflict'
              this.notice = '会话历史在其他窗口变化，当前窗口内容保留。'
            }
          }
        } catch { seat.status = 'error'; this.notice = '本地历史读取失败，当前输入仍保留。' }
      }
      this.loadHistory()
      for (const ownerId of this.workspaces.keys()) this.reconcileWorkspace(ownerId)
    }
    this.emit()
  }
}

export function createSessionStore(): SessionStore {
  let storage: LocalStoragePort | undefined
  try { storage = window.localStorage } catch { /* 存储被禁用时保留内存编辑。 */ }
  return new SessionStore(storage, onChange => {
    const listener = (event: StorageEvent): void => { if (event.storageArea === storage) onChange(event.key) }
    window.addEventListener('storage', listener)
    return () => window.removeEventListener('storage', listener)
  })
}
