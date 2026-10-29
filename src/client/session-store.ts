import { readLegacySessionSnapshot } from '../shared/history-bundle.js'
import { diagnosticSpan } from '../shared/diagnostics.js'
import type { SessionHistoryBackend } from './history-persistence.js'
import type { HistoryTransferReceipt } from './history-transport.js'
import { isFileJobUnit, hasUnitBody } from './translation-history.js'
import { libraryNamespace } from './library-identity.js'
import { browserPluginStorage, isPluginStorageEvent } from './storage-fence.js'
import {
  DEFAULT_SESSION_SETTINGS, HISTORY_PREFIX, LEGACY_DRAFT_PREFIX, LEGACY_SETTINGS_KEY, SETTINGS_KEY,
  decodeSession, historyKey, legacySession, newSession, parseSettings, sessionName, validateSessionSettings,
  type LocalSession, type ModelRoute, type SessionSettings,
} from './sessions.js'
import { SESSION_MODEL_PREFIX, OWNER_MODEL_PREFIX, sessionModelKey, ownerModelKey, encodeModelPreference, decodeModelPreference } from './model-preferences.js'
import { SESSION_ORDER_PREFIX, sessionOrderKey, encodeSessionOrder, decodeSessionOrder, moveSessionOrder } from './session-order.js'
import { decodeTranslationHistory, emptyTranslationHistory, isDocumentUnit, isTextUnit, deleteTextRevision, textRevisionDeletionBlockedReason,
  deleteUnit, unitDeletionBlockedReason, isDeletedUnit,
  persistedTranslationHistory, restoreTranslationHistory, type TranslationHistory } from './translation-history.js'
import { parseTranslationSourceReference, parseTranslationSourceStorageRequest, type TranslationSourceQueryReference, type TranslationSourceStoredRead } from '../shared/translation-source-storage.js'
import { parseTranslationSourceScope, type TranslationSourceScope } from '../shared/translation-sources.js'
import type { TranslationSourceHistoryCallbacks, TranslationSourceHistoryCommit } from './source-storage-client.js'
import {
  DELETED_SESSION_PREFIX, TOPIC_IDENTITY_PREFIX, TOPIC_NAME_PREFIX, TOPIC_LOCK_NAME, DELETED_TOPIC_PREFIX, TOPIC_DELETION_INTENT_PREFIX,
  decodeDeletion, decodeTopicIdentity, decodeTopicName, decodeTopicDeletion, decodeTopicDeletionIntent,
  deletedSessionKey, deletedTopicKey, topicDeletionIntentKey, topicIdentityKey, topicNameKey,
  type TopicIdentity, type TopicDeletionIntent,
} from './topics.js'
import type { TopicPersistence, TopicSessionStart } from '../shared/topic-bridge.js'
import { PREPARATION_STORAGE_PREFIX, type PreparationStoreOptions } from './preparation-store.js'
import { FILE_INTAKE_STORAGE_PREFIX, fileIntakeSessionPrefix, type FileIntakeStoreOptions } from './file-intake-store.js'
import { FILE_JOBS_STORAGE_PREFIX, fileJobsSessionPrefix } from './file-jobs-store.js'
import { recordObjectsKey } from './record-object-store.js'
import { storageSaveFailureMessage } from './storage-errors.js'
import { deletionOperationId, type DeletionStatus } from './deletion.js'
import { readPluginStorageUsage, type PluginStorageUsage } from './storage-usage.js'
const LEGACY_TOPIC_STORAGE_PREFIX = 'dsh-translation-plugin:legacy-topic-storage:v1:'
/** Every translation Session a stored preparation audit still points at, newest format first. */
function preparationSessions(raw: string): readonly string[] {
  try {
    const value = JSON.parse(raw) as { versions?: readonly { scope?: { translationSessionId?: unknown } }[]; scope?: { translationSessionId?: unknown } }
    const ids = new Set<string>()
    for (const version of value.versions ?? []) {
      const id = version?.scope?.translationSessionId
      if (typeof id === 'string' && id.trim()) ids.add(id)
    }
    const direct = value.scope?.translationSessionId
    if (typeof direct === 'string' && direct.trim()) ids.add(direct)
    return [...ids]
  } catch { return [] }
}
export interface LocalStoragePort {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

type Disposer = () => void
export type HistoryStatus = 'memory' | 'saved' | 'conflict' | 'error'
interface Seat { session: LocalSession; savedSession: LocalSession | undefined; translationHistory: TranslationHistory; savedTranslationHistory: TranslationHistory; stored: string | null; legacyRaw: string | null; status: HistoryStatus; storageError?: string }
interface TopicSeat { identity: TopicIdentity; name: string; persistedName: string | undefined; stored: string | null; durable: boolean; nameDirty: boolean }
interface Workspace { active: string | undefined; open: readonly string[] }
export interface HistoryVersion { readonly id: string; readonly stored: string | null; readonly legacyRaw: string | null; readonly current: string }
export interface TextRevisionDeletionPlan {
  readonly sessionId: string; readonly unitId: string; readonly revisionId: string; readonly eventId: string; readonly version: HistoryVersion
}
export interface TextRevisionDeletionResult {
  readonly status: DeletionStatus; readonly operationId: string; readonly message: string
}
interface PendingRevisionDeletion {
  readonly plan: TextRevisionDeletionPlan; readonly at: string; readonly serialized: string
  readonly saved: SessionSnapshot; readonly release: () => void
}
export interface TextUnitDeletionPlan {
  readonly sessionId: string; readonly unitId: string; readonly eventId: string; readonly version: HistoryVersion
}
export type TextUnitDeletionResult = TextRevisionDeletionResult
interface PendingUnitDeletion {
  readonly plan: TextUnitDeletionPlan; readonly at: string; readonly serialized: string
  readonly saved: SessionSnapshot; readonly release: () => void
}
export interface TopicDeletionPlan {
  readonly callerOwnerId: string
  /** Asset storage anchor; cross-main-session deletion is allowed only when every session belongs to the caller. */
  readonly ownerId: string
  readonly topicId: string
  readonly topicName: string
  readonly operationId: string
  readonly identityStored: string | null
  readonly nameStored: string | null
  readonly versions: readonly HistoryVersion[]
  readonly sessionIds: readonly string[]
  readonly sessionCount: number
  readonly archivedCount: number
  readonly otherOwnerCount: number
}
export interface TopicDeletionResult {
  readonly status: 'deleted' | 'partial' | 'blocked' | 'stale' | 'failed'
  readonly operationId: string
  readonly message: string
  readonly remaining?: readonly string[]
  readonly resourceCleanup?: import('../shared/history-cleanup.js').HistoryCleanupResult
}
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
const readSnapshot = readLegacySessionSnapshot
function readHistory(raw: string): LocalSession | undefined { return readSnapshot(raw)?.session }
function currentVersion(seat: Seat): string { return JSON.stringify({ session: seat.session, translationHistory: seat.translationHistory }) }

export class SessionStore {
  private readonly namespaceId: string
  private readonly legacyStorageOwners = new Map<string, string>()
  private readonly legacyCreators = new Map<string, string>()
  private settings: SessionSettings = DEFAULT_SESSION_SETTINGS
  private readonly seats = new Map<string, Seat>()
  private readonly topics = new Map<string, TopicSeat>()
  private readonly migrationSources = new Map<string, LocalSession>()
  private readonly deleted = new Set<string>()
  private readonly deletedTopics = new Set<string>()
  private readonly topicIntents = new Map<string, TopicDeletionIntent>()
  private readonly corruptTopics = new Set<string>()
  private readonly pendingSaves = new Map<string, Promise<boolean>>()
  private readonly dirtySaves = new Set<string>()
  private readonly lastModels = new Map<string, ModelRoute | null>()
  private readonly sessionOrders = new Map<string, readonly string[]>()
  private readonly workspaces = new Map<string, Workspace>()
  private readonly listeners = new Set<Disposer>()
  private readonly executionLeases = new Map<string, string>()
  private readonly revisionDeletions = new Map<string, PendingRevisionDeletion>()
  private readonly unitDeletions = new Map<string, PendingUnitDeletion>()
  private notice: string | undefined
  private readonly stop: Disposer | undefined
  private disposed = false
  private historyBackend: SessionHistoryBackend | undefined
  private historyReady: boolean
  private historyError: string | undefined
  private readonly unloadedHistory = new Map<string, LocalSession>()
  private readonly loadingHistory = new Map<string, Promise<boolean>>()

  constructor(private readonly storage?: LocalStoragePort, listen?: (onChange: (key: string | null) => void) => Disposer, private readonly locks: StructureLockPort | undefined = browserLocks(), private readonly hostHistory = false) {
    this.historyReady = !hostHistory
    this.namespaceId = libraryNamespace(storage)
    this.readSettings(); this.loadHistory()
    this.stop = listen?.(key => this.externalChange(key))
  }

  getNamespaceId(): string { return this.namespaceId }
  setHistoryBackend(backend: SessionHistoryBackend): void { this.historyBackend = backend }
  isHistoryReady(): boolean { return this.historyReady }
  setHistoryReady(ready: boolean, error?: string): void { this.historyReady = ready; this.historyError = error; this.emit() }
  restoreHostDirectory(entries: import('../shared/history-remote.js').HistoryListing['sessions']): void {
    for (const entry of entries) if (entry.session && !entry.state.retired && !this.seats.has(entry.sessionId)) {
      const session = entry.session
      this.seats.set(session.id, { session, savedSession: entry.state.hasSaved ? session : undefined, translationHistory: emptyTranslationHistory(), savedTranslationHistory: emptyTranslationHistory(), stored: null, legacyRaw: null, status: entry.state.persistence === 'saved' ? 'saved' : 'memory' })
      this.unloadedHistory.set(session.id, session)
      this.adoptTopic(this.seats.get(session.id)!)
    }
  }
  isSessionHistoryLoaded(id: string): boolean { return this.seats.has(id) && !this.unloadedHistory.has(id) }
  ensureSessionHistory(id: string): Promise<boolean> {
    if (!this.unloadedHistory.has(id)) return Promise.resolve(this.seats.has(id))
    const pending = this.loadingHistory.get(id); if (pending) return pending
    const seat = this.seats.get(id), original = this.unloadedHistory.get(id)!
    if (!seat || !this.historyBackend) return Promise.resolve(false)
    const work = this.historyBackend.reload(seat.session).then(receipt => {
      if (this.disposed || this.isDeleted(id) || this.seats.get(id) !== seat || !receipt.current) return false
      // Directory actions (rename/archive/remark) may run while its body is loading.
      const patch = Object.fromEntries(Object.keys(original).filter(field => JSON.stringify((seat.session as any)[field]) !== JSON.stringify((original as any)[field])).map(field => [field, (seat.session as any)[field]]))
      this.restoreHostHistory([receipt]); const loaded = this.seats.get(id)!; loaded.session = { ...loaded.session, ...patch }
      this.emit(); return true
    }).catch(error => { if (!this.disposed) { this.notice = error instanceof Error ? error.message : '会话正文读取失败，请重试打开。'; this.emit() }; return false })
      .finally(() => { this.loadingHistory.delete(id); this.emit() })
    this.loadingHistory.set(id, work); return work
  }
  async searchHistoryCurrent(id: string, unitId: string, side: 'source' | 'translation', query: string, start: number, signal: AbortSignal): Promise<import('../shared/history-remote.js').HistoryTextMatches> {
    while (this.pendingSaves.has(id)) { await this.pendingSaves.get(id); signal.throwIfAborted() }
    const session = this.getSession(id); if (!session || !this.historyBackend) throw new Error('宿主查找尚未就绪。')
    return this.historyBackend.search(session, unitId, side, query, start, signal)
  }
  usesHostHistory(): boolean { return !!this.historyBackend }
  restoreHostHistory(receipts: readonly HistoryTransferReceipt[]): void {
    const correctedFinals: string[] = []
    for (const receipt of receipts) {
      const current = receipt.current
      if (!current) continue
      const saved = receipt.saved
      const restored = restoreTranslationHistory(current.history)
      const corrected = restored.units.some(unit => {
        const previous = current.history.units.find(previous => previous.id === unit.id)
        return isTextUnit(unit) && unit.final?.selection === 'automatic' && previous && isTextUnit(previous) && unit.final.revisionId !== previous.final?.revisionId
      })
      if (corrected) correctedFinals.push(current.session.id)
      this.unloadedHistory.delete(current.session.id)
      this.seats.set(current.session.id, { session: this.restoreModel(current.session), savedSession: saved?.session,
        translationHistory: restored, savedTranslationHistory: saved?.history ?? emptyTranslationHistory(),
        stored: this.historyBackend?.snapshot(current.session.id) ?? null, legacyRaw: null, status: !corrected && receipt.state.persistence === 'saved' ? 'saved' : 'memory' })
    }
    for (const seat of this.seats.values()) this.adoptTopic(seat)
    for (const owner of this.workspaces.keys()) this.reconcileWorkspace(owner)
    if (this.historyBackend) for (const id of correctedFinals) this.persist(id)
  }
  private historyRaw(id: string): string | null { return this.hostHistory ? this.historyBackend?.snapshot(id) ?? null : this.storage?.getItem(historyKey(id)) ?? null }
  confirmHostHistory(receipt: HistoryTransferReceipt): void {
    const seat = receipt.current && this.seats.get(receipt.current.session.id)
    if (!seat || this.disposed) return
    seat.savedSession = receipt.saved?.session; seat.savedTranslationHistory = receipt.saved?.history ?? emptyTranslationHistory()
    seat.stored = this.historyBackend?.snapshot(seat.session.id) ?? null
    if (seat.status !== 'conflict') seat.status = receipt.saved && JSON.stringify(receipt.saved.session) === JSON.stringify(seat.session) && JSON.stringify(receipt.saved.history) === JSON.stringify(seat.translationHistory) ? 'saved' : 'memory'
  }
  /** Compatibility locator for old stored assets, never an execution identity. */
  getTopicStorageScope(topicId: string): string | undefined {
    if (this.deletedTopics.has(topicId) || !this.topics.has(topicId)) return undefined
    return this.legacyStorageOwners.get(topicId) ?? this.namespaceId
  }
  private rememberLegacyStorage(topicId: string, owner: unknown): void {
    if (typeof owner !== 'string' || !owner.trim() || this.legacyStorageOwners.has(topicId)) return
    const key = 'dsh-translation-plugin:legacy-topic-storage:v1:' + encodeURIComponent(topicId)
    this.legacyStorageOwners.set(topicId, owner)
    try { this.storage?.setItem(key, owner) } catch { this.notice = '旧资产定位信息未保存；相关内容保留，迁移写入暂停。' }
  }
  getOperationMainSessionId(sessionId: string, operationId: string): string | undefined {
    const history = this.getTranslationHistory(sessionId)
    const event = history?.events.find(event => event.operationId === operationId && event.mainSessionId)
    if (event?.mainSessionId) return event.mainSessionId
    const exchange = history?.exchanges.find(exchange => exchange.operationId === operationId)
    if (exchange) return exchange.mainSessionId
    for (const unit of history?.units ?? []) {
      if (isTextUnit(unit) && unit.material && history?.events.find(event => event.unitId === unit.id && event.type === 'operation.accepted')?.operationId === operationId) return unit.material.mainSessionId
      if (isDocumentUnit(unit)) { const task = unit.tasks.find(task => task.taskId === operationId || task.operationId === operationId); if (task) return task.mainSessionId ?? task.executionFacts?.blocks[0]?.request.scope.mainSessionId }
    }
    return undefined
  }
  getAllSessions(): readonly LocalSession[] { return [...this.seats.values()].map(seat => seat.session) }
  hasUnsettledWork(): boolean {
    return this.executionLeases.size > 0 || [...this.seats.values()].some(seat => seat.translationHistory.exchanges.some(exchange => ['open','waiting_user','resuming','unknown'].includes(exchange.status)) || seat.translationHistory.units.some(unit => isDocumentUnit(unit)
      ? unit.tasks.some(task => ['running','unknown','waiting_context','waiting_user'].includes(task.status))
      : isTextUnit(unit) && unit.revisions.some(revision => ['submitting','running','unknown','context_requested'].includes(revision.status))))
  }
  getSettings(): SessionSettings { return this.settings }
  getStorageUsage(): PluginStorageUsage { return readPluginStorageUsage(this.storage) }
  getNotice(): string | undefined {
    const errors = [...this.seats.values()].flatMap(seat => seat.storageError ? [seat.storageError] : [])
    return [...new Set([...(this.historyError ? [this.historyError] : []), ...(this.notice ? [this.notice] : []), ...errors])].join(' ') || undefined
  }
  getSession(id: string): LocalSession | undefined { return this.seats.get(id)?.session }
  hasPersistedSession(id: string): boolean { return this.seats.get(id)?.stored != null || this.unloadedHistory.has(id) && this.seats.get(id)?.status === 'saved' }
  isSessionDeleted(id: string): boolean { return this.isDeleted(id) }
  getTranslationHistory(id: string): TranslationHistory | undefined { return this.unloadedHistory.has(id) ? undefined : this.seats.get(id)?.translationHistory }
  /** A document parent owns this session; its children use the same lease. */
  claimDocumentLease(sessionId: string, taskId: string): (() => void) | undefined {
    if (this.disposed || !this.seats.has(sessionId) || this.executionLeases.has(sessionId)) return undefined
    this.executionLeases.set(sessionId, taskId)
    let released = false
    return () => { if (!released && this.executionLeases.get(sessionId) === taskId) { released = true; this.executionLeases.delete(sessionId); this.emit() } }
  }
  hasDocumentLease(sessionId: string): boolean { return this.executionLeases.has(sessionId) }
  /** Await the current history write without treating queued work as saved. */
  async saveTranslationHistoryAsync(sessionId: string): Promise<boolean> {
    if (!this.readSettings()) return false
    await this.pendingSaves.get(sessionId)
    const queued = this.pendingSaves.get(sessionId)
    if (queued) await queued
    if (this.seats.get(sessionId)?.status === 'saved') return true
    return this.saveSessionAsync(sessionId)
  }
  /** Separate preparation audit storage shares history persistence and the existing structure lock. */
  createPreparationStoreOptions(): PreparationStoreOptions {
    const validKey = (key: string): void => { if (!key.startsWith(PREPARATION_STORAGE_PREFIX)) throw new Error('Preparation storage key is outside its namespace') }
    return {
      ...(this.historyBackend ? { storage: this.historyBackend.recordStorage('preparations'), registerHistory: (current: () => readonly string[], restore: (records: readonly string[]) => void) => this.historyBackend!.register('preparations', { current, restore }) } :
      (this.storage && this.locks ? { storage: {
        keys: () => {
          const keys: string[] = []
          for (let index = 0; index < this.storage!.length; index++) { const key = this.storage!.key(index); if (key?.startsWith(PREPARATION_STORAGE_PREFIX)) keys.push(key) }
          return keys
        },
        getItem: (key: string) => { validKey(key); return this.storage!.getItem(key) },
        setItem: (key: string, value: string) => { validKey(key); this.storage!.setItem(key, value) },
      } } : {})),
      withLock: async <T>(action: () => T | Promise<T>): Promise<T> => this.storage && this.locks
        ? this.locks.request(TOPIC_LOCK_NAME, async () => { if (this.disposed) throw new Error('Session store is disposed'); return await action() })
        : await action(),
      isEnabled: () => !this.disposed && this.readSettings(),
      isScopeCurrent: scope => {
        const session = this.getSession(scope.translationSessionId)
        return !this.disposed && !!session && !this.isSessionDeleted(session.id) && session.topicId === scope.topicId && this.getTopics(scope.ownerId).some(topic => topic.id === scope.topicId)
      },
    }
  }
  /** File rows share history persistence, identity checks and structure lock, without storing a File body. */
  createFileIntakeStoreOptions(): FileIntakeStoreOptions {
    return this.createFileRecordStoreOptions(FILE_INTAKE_STORAGE_PREFIX)
  }
  createFileJobsStoreOptions(): FileIntakeStoreOptions { return this.createFileRecordStoreOptions(FILE_JOBS_STORAGE_PREFIX, true) }
  private createFileRecordStoreOptions(prefix: string, retainConsumerHistory = false): FileIntakeStoreOptions {
    const validKey = (key: string): void => { if (!key.startsWith(prefix)) throw new Error('File record storage key is outside its namespace') }
    return {
      ...(this.historyBackend ? { storage: this.historyBackend.recordStorage(retainConsumerHistory ? 'fileJobs' : 'intakes'),
        registerHistory: (current: () => readonly string[], restore: (records: readonly string[]) => void) => this.historyBackend!.register(retainConsumerHistory ? 'fileJobs' : 'intakes', { current, restore }) } : (this.storage && this.locks ? { storage: {
        keys: () => {
          const keys: string[] = []
          for (let index = 0; index < this.storage!.length; index++) { const key = this.storage!.key(index); if (key?.startsWith(prefix)) keys.push(key) }
          return keys
        },
        getItem: (key: string) => { validKey(key); return this.storage!.getItem(key) },
        setItem: (key: string, value: string) => { validKey(key); this.storage!.setItem(key, value) },
        removeItem: (key: string) => { validKey(key); this.storage!.removeItem(key) },
      } } : {})),
      withLock: async <T>(action: () => T | Promise<T>): Promise<T> => this.storage && this.locks
        ? this.locks.request(TOPIC_LOCK_NAME, async () => { if (this.disposed) throw new Error('Session store is disposed'); return await action() }) : await action(),
      isEnabled: () => !this.disposed && this.readSettings(),
      isScopeCurrent: scope => {
        const session = this.getSession(scope.translationSessionId)
        return !this.disposed && !!session && !this.isSessionDeleted(session.id) &&
          session.topicId === scope.topicId && this.getTopics().some(topic => topic.id === scope.topicId)
      },
      saveSession: sessionId => this.saveTranslationHistoryAsync(sessionId),
    }
  }
  /** Bind storage acknowledgments to an existing document source; this never admits a task. */
  createSourceHistoryCallbacks(target: SourceHistoryTarget, preparedScope?: TranslationSourceScope): TranslationSourceHistoryCallbacks {
    const fixed = { ...target }, session = this.getSession(fixed.sessionId)
    if (!session || !Number.isSafeInteger(fixed.sourceVersion) || fixed.sourceVersion < 1) throw new Error('Document source history target is unavailable')
    const storedScope = this.getTranslationHistory(session.id)?.units.find(unit => unit.id === target.unitId)
    const retainedScope = storedScope && isDocumentUnit(storedScope) ? storedScope.sourceVersions.find(source => source.version === target.sourceVersion)?.historyCommit?.reference.scope : undefined
    const scope = parseTranslationSourceScope(retainedScope ?? preparedScope ?? { namespaceId: this.namespaceId, ownerId: this.getTopicStorageScope(session.topicId)!, mainSessionId: this.getTopicStorageScope(session.topicId)!, topicId: session.topicId, translationSessionId: session.id })
    this.sourceHistoryVersion(fixed, scope)
    return {
      isHistoryEnabled: () => !this.disposed && this.readSettings(),
      persistPreparedReference: async (value, confirmOperationId) => {
        const reference = parseTranslationSourceReference(value)
        if (reference.state !== 'prepared') throw new Error('History requires a prepared source reference')
        parseTranslationSourceStorageRequest('confirmReference', { scope: reference.scope, referenceKey: reference.referenceKey,
          prepareToken: reference.prepareToken, historyToken: 'validation', operationId: confirmOperationId })
        const result = await this.withStructureLock<TranslationSourceHistoryCommit | undefined>(undefined, async () => {
          if (this.disposed || !this.storage || !this.readSettings()) return undefined
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
          if (!await this.persistLocked(fixed.sessionId)) return undefined
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
  readStoredDocumentTask(sessionId: string, unitId: string, taskId: string): import('../shared/translation-batch.js').DocumentUnit | null {
    const seat = this.seats.get(sessionId), raw = this.historyRaw(sessionId), snapshot = raw ? readSnapshot(raw) : undefined
    if (!seat || !snapshot || this.disposed || this.isDeleted(sessionId) || !this.matchesHistoryIdentity(seat.session, snapshot.session)) return null
    const stored = snapshot.translationHistory.units.find(unit => unit.id === unitId), current = seat.translationHistory.units.find(unit => unit.id === unitId)
    if (!stored || !current || !isDocumentUnit(stored) || !isDocumentUnit(current)) return null
    const savedTask = stored.tasks.find(task => task.taskId === taskId), task = current.tasks.find(task => task.taskId === taskId)
    if (!savedTask || !task || JSON.stringify(savedTask.executionFacts) !== JSON.stringify(task.executionFacts)) return null
    return structuredClone(stored)
  }
  async readStoredSourceRequest(target: SourceHistoryTarget): Promise<TranslationSourceStoredRead | null> {
    const session = this.getSession(target.sessionId)
    if (!session) return null
    const storedScope = this.getTranslationHistory(session.id)?.units.find(unit => unit.id === target.unitId)
    const retainedScope = storedScope && isDocumentUnit(storedScope) ? storedScope.sourceVersions.find(source => source.version === target.sourceVersion)?.historyCommit?.reference.scope : undefined
    const scope: TranslationSourceScope = retainedScope ?? { namespaceId: this.namespaceId, ownerId: this.getTopicStorageScope(session.topicId)!, mainSessionId: this.getTopicStorageScope(session.topicId)!, topicId: session.topicId, translationSessionId: session.id }
    const source = this.sourceHistoryVersion(target, scope), key = source.historyCommit?.reference.referenceKey
    if (!key) return null
    const commit = this.readSourceHistoryCommit(target, scope, { scope, referenceKey: key })
    return commit ? { scope: commit.reference.scope, referenceKey: commit.reference.referenceKey, source: commit.reference.source, historyToken: commit.historyToken } : null
  }
  private sourceHistoryVersion(target: SourceHistoryTarget, scope: TranslationSourceScope) {
    const seat = this.seats.get(target.sessionId), session = seat?.session, unit = seat?.translationHistory.units.find(unit => unit.id === target.unitId)
    if (this.disposed || !session || this.isDeleted(session.id) || scope.ownerId !== scope.mainSessionId ||
      session.topicId !== scope.topicId || session.id !== scope.translationSessionId || !unit || !isDocumentUnit(unit)) throw new Error('Document source history scope is unavailable')
    const source = unit.sourceVersions.find(version => version.version === target.sourceVersion)
    if (!source || source.deletion || source.body.kind !== 'asset') throw new Error('Document asset source version is unavailable')
    return { ...source, body: source.body }
  }
  private readSourceHistoryCommit(target: SourceHistoryTarget, scope: TranslationSourceScope, value: TranslationSourceQueryReference): TranslationSourceHistoryCommit | null {
    const query = parseTranslationSourceStorageRequest('queryReference', value) as TranslationSourceQueryReference
    if (JSON.stringify(query.scope) !== JSON.stringify(scope)) throw new Error('Document source query is outside the bound scope')
    const current = this.sourceHistoryVersion(target, scope)
    if (!this.storage) throw new Error('History storage is unavailable')
    const raw = this.historyRaw(target.sessionId)
    if (raw === null) return null
    const snapshot = readSnapshot(raw), session = snapshot?.session, unit = snapshot?.translationHistory.units.find(unit => unit.id === target.unitId)
    if (!session || session.id !== target.sessionId || session.topicId !== scope.topicId ||
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
  /** Topics belong to this local asset library; ownerId remains a legacy caller argument. */
  getTopics(_ownerId?: string): readonly { readonly id: string; readonly name: string; readonly nextSequence: number }[] {
    return [...this.topics.values()]
      .filter(topic => !this.deletedTopics.has(topic.identity.id))
      .map(topic => ({ id: topic.identity.id, name: topic.name, nextSequence: topic.identity.nextSequence }))
  }
  /** Stable storage anchor retained for existing topic assets; never an execution owner. */
  isTopicDeleted(topicId: string): boolean { return this.deletedTopics.has(topicId) }
  isTopicDeleting(topicId: string): boolean { return this.topicIntents.has(topicId) }
  getTopicDeletionIntent(topicId: string): TopicDeletionIntent | undefined { return this.topicIntents.get(topicId) }
  getTopicSessions(topicId: string): readonly LocalSession[] {
    return this.getAllSessions().filter(session => session.topicId === topicId && !this.isSessionDeleted(session.id))
      .sort((a, b) => a.sequence - b.sequence)
  }
  subscribe(listener: Disposer): Disposer { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { if (!this.disposed) for (const fn of this.listeners) fn() }
  dispose(): void { this.disposed = true; this.stop?.(); this.listeners.clear(); for (const item of this.revisionDeletions.values()) item.release(); this.revisionDeletions.clear(); for (const item of this.unitDeletions.values()) item.release(); this.unitDeletions.clear(); this.workspaces.clear(); this.seats.clear(); this.topics.clear(); this.deletedTopics.clear(); this.topicIntents.clear(); this.migrationSources.clear(); this.lastModels.clear(); this.sessionOrders.clear() }

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
    const { id, model } = seat.session
    const ownerId = this.namespaceId
    this.lastModels.set(ownerId, model)
    try {
      if (!this.storage) throw new Error('storage unavailable')
      const raw = encodeModelPreference(model)
      // Temporary session IDs cannot be restored; retain only their owner's next-session preference.
      if ((seat.stored !== null || seat.legacyRaw !== null) && !this.isDeleted(id)) this.storage.setItem(sessionModelKey(id), raw)
      this.storage.setItem(ownerModelKey(ownerId), raw)
    } catch (error) { this.notice = storageSaveFailureMessage(error, '模型与推理等级偏好', '模型与推理等级偏好未完整保存，当前选择仍保留在本次运行中。') }
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
    try {
      this.storage.setItem(SETTINGS_KEY, JSON.stringify(next))
      this.settings = next; this.notice = undefined
      this.emit(); return true
    } catch (error) { this.notice = storageSaveFailureMessage(error, '设置', '设置保存失败，编辑值仍保留，请检查本地存储后重试修改。'); this.emit(); return false }
  }

  private loadHistory(): void {
    if (!this.storage) return
    try {
      const keys: string[] = []
      for (let i = 0; i < this.storage.length; i++) { const key = this.storage.key(i); if (key) keys.push(key) }
      this.loadTopicDeletions(keys)
      this.loadTopics(keys)
      if (this.hostHistory) return
      for (const key of keys.filter(key => key.startsWith(HISTORY_PREFIX))) {
        const raw = this.storage.getItem(key)
        const snapshot = raw === null ? undefined : readSnapshot(raw), session = snapshot?.session
        if (raw && session) {
          const legacy = JSON.parse(raw).session?.ownerId
          if (typeof legacy === 'string') { this.legacyCreators.set(session.id, legacy); this.rememberLegacyStorage(session.topicId, legacy) }
        }
        if (!session || historyKey(session.id) !== key) { this.notice = '部分会话历史无法读取，原存储副本已保留。'; continue }
        if (this.isDeleted(session.id)) continue
        if (this.deletedTopics.has(session.topicId)) { this.notice = '已删除主题的遗留会话未恢复，原存储副本已保留。'; continue }
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
          if (this.deletedTopics.has(session.topicId)) { this.notice = '已删除主题的遗留草稿未恢复，原存储副本已保留。'; continue }
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
      if (identity) {
        const locator = this.storage?.getItem('dsh-translation-plugin:legacy-topic-storage:v1:' + encodeURIComponent(identity.id))
        const legacy = JSON.parse(raw).ownerId
        if (locator) this.legacyStorageOwners.set(identity.id, locator)
        else if (typeof legacy === 'string') this.rememberLegacyStorage(identity.id, legacy)
      }
      if (!identity || topicIdentityKey(identity.id) !== key) {
        this.corruptTopics.add(key); this.notice = '部分主题编号记录无法读取，相关持久主题暂停新建会话。'; continue
      }
      if (this.deletedTopics.has(identity.id)) continue
      const old = this.topics.get(identity.id)
      if (old && (old.identity.sequenceNamespaceId !== identity.sequenceNamespaceId)) {
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

  /** Deletion barriers load before identities so a deleted topic never re-enters listings. */
  private loadTopicDeletions(keys: readonly string[]): void {
    for (const key of keys.filter(key => key.startsWith(DELETED_TOPIC_PREFIX))) {
      const raw = this.storage?.getItem(key)
      if (raw === undefined || raw === null) continue
      let id: string
      try { id = decodeURIComponent(key.slice(DELETED_TOPIC_PREFIX.length)) } catch { this.notice = '部分主题删除状态未确认，请核对主题列表。'; continue }
      if (!decodeTopicDeletion(raw, id)) { this.notice = '部分主题删除状态未确认，请核对主题列表。'; continue }
      this.deletedTopics.add(id)
    }
    for (const key of keys.filter(key => key.startsWith(TOPIC_DELETION_INTENT_PREFIX))) {
      const raw = this.storage?.getItem(key)
      if (raw === undefined || raw === null) continue
      let id: string
      try { id = decodeURIComponent(key.slice(TOPIC_DELETION_INTENT_PREFIX.length)) } catch { continue }
      const intent = decodeTopicDeletionIntent(raw, id)
      if (!intent) { this.notice = '部分主题删除进度无法读取，请重新打开确认后重试。'; continue }
      this.topicIntents.set(id, intent)
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
      if (known) {
        this.applyMigration(source.id, known.topic, known.sequence); continue
      }
      let root = source
      const path = new Set([source.id])
      while (root.parentId) {
        const parent = this.migrationSources.get(root.parentId)
        if (!parent || !this.seats.has(parent.id) || this.legacyCreators.get(parent.id) !== this.legacyCreators.get(source.id)) break
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
          identity: { schemaVersion: 2, id, sequenceNamespaceId: `migration:${root.id}`, nextSequence: 0, version: 0, allocations: [] },
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
    if (this.deletedTopics.has(session.topicId)) { seat.status = 'conflict'; this.notice = '主题已删除，遗留会话未恢复。'; return }
    let topic = this.topics.get(session.topicId)
    if (!topic) {
      topic = {
        identity: { schemaVersion: 2, id: session.topicId, sequenceNamespaceId: session.sequenceNamespaceId, nextSequence: session.sequence + 1, version: 0, allocations: [{ sessionId: session.id, sequence: session.sequence }] },
        name: session.topicName, persistedName: seat.savedSession?.topicName, stored: null, durable: !!seat.savedSession, nameDirty: false,
      }
      this.topics.set(session.topicId, topic)
    }
    if (topic.identity.sequenceNamespaceId !== session.sequenceNamespaceId) {
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
    return [...this.seats.values()].flatMap(seat => seat.savedSession && (ownerId === undefined || this.isSessionOpen(ownerId, seat.savedSession.id)) ? [seat.savedSession] : [])
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  getOwnerIds(): readonly string[] { return [...new Set([...this.workspaces.keys(), ...this.sessionOrders.keys()])] }
  getOpenOwnerIds(): readonly string[] { return [...new Set([...this.workspaces.keys(), ...this.sessionOrders.keys()])].filter(ownerId => ownerId !== this.namespaceId && this.openSet(ownerId).length > 0) }
  getAvailableSessions(_entryId?: string): readonly LocalSession[] {
    return [...this.seats.values()].map(seat => seat.session)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  /** 打开集合与显示顺序共用同一份持久记录：ids 即本主会话当前打开（且可排序）的会话。 */
  private openSet(ownerId: string): readonly string[] {
    const cached = this.sessionOrders.get(ownerId)
    if (cached) return cached
    const raw = this.storage?.getItem(sessionOrderKey(ownerId)) ?? null
    if (raw === null) return this.seedOpenSet(ownerId)
    try {
      const decoded = decodeSessionOrder(raw)
      if (decoded) { this.sessionOrders.set(ownerId, decoded); return decoded }
      throw new Error('invalid session order')
    } catch {
      // 偏好不可读时降级为「名下未归档会话全部可见」，不清空列表也不覆盖原记录。
      this.notice = '会话排序偏好读取失败，当前会话仍可使用。'
      const fallback = this.getAvailableSessions(ownerId).filter(session => session.archivedAt === null).map(session => session.id)
      this.sessionOrders.set(ownerId, fallback); return fallback
    }
  }
  private writeOpenSet(ownerId: string, ids: readonly string[]): boolean { return this.saveSessionOrder(ownerId, ids) }
  /** 迁移：从未记录打开集合的既有主会话，把其名下未归档会话视为已打开。 */
  private seedOpenSet(ownerId: string): readonly string[] {
    const seeded = this.getAllSessions().filter(session => this.legacyCreators.get(session.id) === ownerId && session.archivedAt === null).map(session => session.id)
    if (seeded.length) this.saveSessionOrder(ownerId, seeded)
    else this.sessionOrders.set(ownerId, seeded)
    return seeded
  }
  /** Presentation only: the open set is authoritative; topic sequences and export order keep their own authority. */
  getDisplaySessions(ownerId: string): readonly LocalSession[] {
    const open = this.openSet(ownerId), byId = new Map([...this.seats.values()].map(seat => [seat.session.id, seat.session]))
    return open.flatMap(id => { const session = byId.get(id); return session && !this.isSessionDeleted(id) && session.archivedAt === null ? [session] : [] })
  }
  private saveSessionOrder(ownerId: string, ids: readonly string[]): boolean {
    this.sessionOrders.set(ownerId, ids)
    try {
      if (!this.storage) throw new Error('storage unavailable')
      this.storage.setItem(sessionOrderKey(ownerId), encodeSessionOrder(ids)); return true
    } catch (error) { this.notice = storageSaveFailureMessage(error, '会话排序', '会话排序未保存，当前顺序仍保留在本次运行中。'); return false }
  }
  moveSessionInDisplay(ownerId: string, id: string, targetId: string, after = false): boolean {
    const ids = this.getDisplaySessions(ownerId).map(session => session.id)
    if (!ids.includes(id) || !ids.includes(targetId)) return false
    const next = moveSessionOrder(ids, id, targetId, after)
    if (ids.every((value, index) => value === next[index])) return true
    this.notice = undefined
    const saved = this.writeOpenSet(ownerId, next)
    const workspace = this.workspaces.get(ownerId); if (workspace) workspace.open = next
    this.emit(); return saved
  }
  getActiveSessions(ownerId: string): readonly LocalSession[] { return this.getDisplaySessions(ownerId) }
  getArchivedSessions(ownerId: string): readonly LocalSession[] {
    return [...this.seats.values()].map(seat => seat.session)
      .filter(session => session.archivedAt !== null && !this.isSessionDeleted(session.id))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  getActiveSession(ownerId: string): LocalSession | undefined { const id = this.workspaces.get(ownerId)?.active; return id && this.isSessionHistoryLoaded(id) ? this.getSession(id) : undefined }
  getUnloadedActiveSession(ownerId: string): string | undefined { const id = this.workspaces.get(ownerId)?.active; return id && this.unloadedHistory.has(id) ? id : undefined }
  /** 执行归属：会话已加入该主会话的打开集合即可在该主会话下执行，归属 ownerId 不变。 */
  isSessionOpen(ownerId: string, id: string): boolean { return this.openSet(ownerId).includes(id) }
  canAccessUnit(mainSessionId: string, sessionId: string, unitId: string): boolean {
    const unit = this.getTranslationHistory(sessionId)?.units.find(unit => unit.id === unitId)
    return this.isSessionOpen(mainSessionId, sessionId) && !this.isSessionDeleted(sessionId) && this.getStatus(sessionId) !== 'conflict' && !!unit && !unit.deletion
  }
  private reconcileWorkspace(ownerId: string): void {
    const workspace = this.workspaces.get(ownerId)
    if (!workspace) return
    const open = this.openSet(ownerId)
    if (workspace.active && open.includes(workspace.active) && this.getSession(workspace.active)?.archivedAt === null) return
    workspace.active = this.getDisplaySessions(ownerId).at(-1)?.id
  }
  ensureWorkspace(ownerId: string): void {
    if (!this.historyReady) return
    if (!ownerId.trim() || this.workspaces.has(ownerId)) return
    const open = this.openSet(ownerId)
    this.workspaces.set(ownerId, { active: undefined, open })
    // 首次进入保持「未选择会话」空态；有历史时恢复最近一个仍处于打开集合内的会话。
    const recent = this.getHistory(ownerId).find(session => session.archivedAt === null && open.includes(session.id))
    if (recent) this.openSession(ownerId, recent.id)
  }
  createSession(ownerId: string, parentId?: string, activate = true): LocalSession | undefined {
    if (!this.historyReady) return undefined
    if (!ownerId.trim()) return undefined
    this.readSettings()
    this.loadHistory()
    const parent = parentId ? this.getSession(parentId) : undefined
    if (parentId && (!parent)) { this.notice = '当前会话无法作为新会话的起点。'; this.emit(); return undefined }
    const topic = parent ? this.topics.get(parent.topicId) : undefined
    if (topic?.durable || parent) {
      this.notice = '持久主题的新编号需要异步主题锁，请使用新建子会话操作。'; this.emit(); return undefined
    }
    const session = this.addSession(ownerId, parent, topic, undefined, activate)
    this.persist(session.id)
    this.emit(); return session
  }

  private freshId(): string {
    let id: string
    do {
      id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? `tr-${crypto.randomUUID()}` : `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
    } while (this.seats.has(id) || this.isDeleted(id) || [...this.topics.values()].some(topic => topic.identity.allocations.some(entry => entry.sessionId === id)))
    return id
  }

  private addSession(ownerId: string, parent?: LocalSession, topic?: TopicSeat, reserved?: { readonly id: string; readonly sequence: number }, activate = true, initialMode?: LocalSession['mode']): LocalSession {
    const id = reserved?.id ?? this.freshId()
    const sequence = reserved?.sequence ?? topic?.identity.nextSequence ?? 0
    if (!Number.isSafeInteger(sequence + 1)) throw new Error('sequence exhausted')
    const settings = parent ? { ...this.settings, defaultMode: parent.mode, targetLanguage: parent.targetLanguage, defaultInstruction: parent.instruction, maxInputChars: parent.maxInputChars } : this.settings
    const initial = newSession(initialMode ? { ...settings, defaultMode: initialMode } : settings, ownerId, id, topic?.name ?? '新翻译会话', parent?.id ?? null, topic?.identity.id, topic?.identity.sequenceNamespaceId, sequence)
    const model = parent ? parent.model : this.lastModels.has(this.namespaceId) ? this.lastModels.get(this.namespaceId)! : this.readModelPreference(ownerModelKey(this.namespaceId)) ?? null
    const session = { ...initial, model: model ? { ...model } : null }
    if (topic && !reserved) topic.identity = { ...topic.identity, nextSequence: sequence + 1, allocations: [...topic.identity.allocations, { sessionId: id, sequence }] }
    this.seats.set(id, { session, savedSession: undefined, translationHistory: emptyTranslationHistory(), savedTranslationHistory: emptyTranslationHistory(), stored: null, legacyRaw: null, status: 'memory' })
    this.adoptTopic(this.seats.get(id)!)
    this.attachToWorkspace(ownerId, id)
    if (activate) this.openSession(ownerId, id)
    return session
  }

  /** 新建的会话进入本主会话的打开集合（即使后台创建不激活，也显示在列表里）。 */
  private attachToWorkspace(ownerId: string, id: string): void {
    const workspace = this.workspaces.get(ownerId)
    const open = workspace?.open ?? this.openSet(ownerId)
    if (open.includes(id)) return
    const next = [...open, id]
    if (workspace) workspace.open = next; else this.workspaces.set(ownerId, { active: undefined, open: next })
    this.writeOpenSet(ownerId, next)
  }

  private lockTimeoutMs = 15_000
  private async withStructureLock<T>(failure: T, action: () => T | Promise<T>): Promise<T> {
    if (!this.storage || !this.locks) {
      this.notice = '当前环境缺少 Web Locks 或本地存储。持久主题的新建、重命名与迁移保存已暂停；当前输入仍保留。'; this.emit(); return failure
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // Two panels (for example one main Session and an opened cross-owner Session) share one
      // origin-wide topic lock. A stuck holder must not block this panel forever.
      return await Promise.race([
        this.locks.request(TOPIC_LOCK_NAME, () => this.disposed ? failure : action()),
        new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('主题写入等待超时')), this.lockTimeoutMs) }),
      ])
    }
    catch (error) { this.notice = storageSaveFailureMessage(error, '主题编号或名称', '主题编号或名称保存失败，当前输入仍保留；请检查本地存储后重试。'); this.emit(); return failure }
    finally { if (timer) clearTimeout(timer) }
  }

  /** 先可靠发号；正文保存失败可留下空号。 */
  async createSessionAsync(ownerId: string, parentId?: string, activate = true, initialMode?: LocalSession['mode']): Promise<LocalSession | undefined> {
    if (!this.historyReady) return undefined
    if (!ownerId.trim()) return undefined
    if (!this.readSettings()) { this.emit(); return undefined }
    this.loadHistory()
    if (parentId && !await this.ensureSessionHistory(parentId)) return undefined
    const parent = parentId ? this.getSession(parentId) : undefined
    if (parentId && (!parent)) { this.notice = '当前会话无法作为新会话的起点。'; this.emit(); return undefined }
    return this.withStructureLock(undefined, () => this.createSessionLocked(ownerId, parentId, undefined, activate, initialMode))
  }

  private async createSessionLocked(ownerId: string, parentId?: string, topicId?: string, activate = true, initialMode?: LocalSession['mode']): Promise<LocalSession | undefined> {
    if (!this.historyReady) return undefined
    if (!this.readSettings()) return undefined
    this.loadHistory()
    const parentKey = parentId ?? (topicId ? this.getAvailableSessions(ownerId).find(session => session.topicId === topicId && !this.isDeleted(session.id))?.id : undefined)
    if (parentKey && !await this.ensureSessionHistory(parentKey)) return undefined
    const currentParent = parentKey ? this.getSession(parentKey) : undefined
    if (parentId && (!currentParent || this.isDeleted(parentId))) {
      this.notice = '原会话已变化或删除，新建未执行。'; this.emit(); return undefined
    }
    let topic = topicId ? this.topics.get(topicId) : currentParent ? this.topics.get(currentParent.topicId) : undefined
    if (topicId && !topic) return undefined
    const id = this.freshId()
    if (!topic) {
      topic = {
        identity: { schemaVersion: 2, id: `topic:${id}`, sequenceNamespaceId: `sequence:${id}`, nextSequence: 0, version: 0, allocations: [] },
        name: '新翻译会话', persistedName: undefined, stored: null, durable: false, nameDirty: false,
      }
      this.topics.set(topic.identity.id, topic)
    }
    if (!this.storage || !this.locks) {
      this.notice = '当前环境无法协调持久主题编号，新建未执行。'; this.emit(); return undefined
    }
    this.writeIdentity(topic)
    const sequence = topic.identity.nextSequence
    if (!Number.isSafeInteger(sequence + 1)) throw new Error('sequence exhausted')
    this.writeIdentity(topic, { sessionId: id, sequence })
    this.writeTopicName(topic)
    const session = this.addSession(ownerId, currentParent, topic, { id, sequence }, activate, initialMode)
    this.notice = undefined
    await this.persistLocked(id)
    this.emit(); return session
  }

  async createSessionForTopicAsync(ownerId: string, topicId: string, activate = true, initialMode?: LocalSession['mode']): Promise<LocalSession | undefined> {
    this.loadHistory()
    const topic = this.topics.get(topicId)
    if (!ownerId.trim() || !topic) return undefined
    const parent = this.getAvailableSessions(ownerId).find(session => session.topicId === topicId)
    if (parent) return this.createSessionAsync(ownerId, parent.id, activate, initialMode)
    if (!this.readSettings()) return undefined
    return this.withStructureLock(undefined, () => this.createSessionLocked(ownerId, undefined, topicId, activate, initialMode))
  }
  openSession(ownerId: string, id: string): void {
    const session = this.getSession(id)
    if (!session || session.archivedAt !== null || this.isSessionDeleted(id)) return
    const workspace = this.workspaces.get(ownerId)
    const open = workspace?.open ?? this.openSet(ownerId)
    const next = open.includes(id) ? open : [...open, id]
    if (workspace) workspace.open = next; else this.workspaces.set(ownerId, { active: id, open: next })
    if (next !== open) this.writeOpenSet(ownerId, next)
    this.workspaces.get(ownerId)!.active = id
    if (this.unloadedHistory.has(id)) void this.ensureSessionHistory(id)
    this.emit()
  }
  /** 关闭 = 仅从本主会话的打开集合移除，不改归属与归档状态；可经主题 [打开] 再次打开。 */
  closeSession(ownerId: string, id: string): boolean {
    const workspace = this.workspaces.get(ownerId)
    const open = workspace?.open ?? this.openSet(ownerId)
    if (!open.includes(id)) return false
    const next = open.filter(value => value !== id)
    if (workspace) workspace.open = next
    else this.workspaces.set(ownerId, { active: undefined, open: next })
    this.writeOpenSet(ownerId, next)
    this.reconcileWorkspace(ownerId)
    this.notice = undefined
    this.emit(); return true
  }
  archiveSession(ownerId: string, id: string, archived = true, activate = true): boolean {
    const seat = this.seats.get(id)
    if (!seat) return false
    const time = new Date().toISOString()
    seat.session = { ...seat.session, archivedAt: archived ? time : null, updatedAt: time }
    if (seat.status !== 'conflict') seat.status = 'memory'
    this.notice = undefined
    this.persist(id)
    for (const entry of this.workspaces.keys()) this.reconcileWorkspace(entry)
    if (!archived && activate) this.openSession(ownerId, id)
    this.emit(); return true
  }

  private managementFailure(code: string, message: string): SessionManagementResult {
    this.notice = message; this.emit(); return { ok: false, code, message }
  }

  /** Expected metadata and settings are checked under the existing topic lock. */
  private async manageSessions(action: () => SessionManagementResult | Promise<SessionManagementResult>): Promise<SessionManagementResult> {
    const run = async (): Promise<SessionManagementResult> => {
      if (!this.historyReady) return this.managementFailure('history_loading', this.notice ?? '正在读取宿主会话历史，请稍候。')
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
    if (seat.status === 'conflict' || (this.storage && (this.historyRaw(seat.session.id) !== seat.stored ||
      (seat.session.legacyKey && this.storage.getItem(seat.session.legacyKey) !== seat.legacyRaw)))) {
      seat.status = 'conflict'; return false
    }
    return true
  }

  private async finishManagedSession(seat: Seat): Promise<SessionManagementResult> {
    try {
      const topic = this.topics.get(seat.session.topicId)!
      this.writeIdentity(topic); this.writeTopicName(topic); this.adoptTopic(seat)
      if (seat.status !== 'saved' && !await this.persistLocked(seat.session.id)) {
        return this.managementFailure(seat.status === 'conflict' ? 'conflict' : 'storage_error', '会话修改未保存，内存可能已变化，请查询当前记录。')
      }
    } catch {
      seat.status = 'error'
      return this.managementFailure('storage_error', '会话修改未保存，内存可能已变化，请查询当前记录。')
    }
    this.notice = undefined; this.emit()
    return { ok: true, sessions: [seat.session], persistence: 'saved' }
  }

  async createManagedSessionAsync(ownerId: string, start: TopicSessionStart, initialMode?: 'normal'): Promise<SessionManagementResult> {
    return this.manageSessions(async () => {
      if (!ownerId.trim()) return this.managementFailure('out_of_scope', '主会话身份无效。')
      const parentId = start.kind === 'parent_session' ? start.translationSessionId : undefined
      const topicId = start.kind === 'existing_topic' ? start.topicId : undefined
      const parent = parentId ? this.seats.get(parentId) : undefined
      if (parentId && (!parent || this.isDeleted(parentId))) return this.managementFailure('out_of_scope', '起点会话不属于当前主会话或已删除。')
      if (parent && !this.managedSessionCurrent(parent)) return this.managementFailure('conflict', '起点会话在其他窗口变化，请先核对当前记录。')
      if (topicId && (!this.topics.has(topicId) || this.deletedTopics.has(topicId) || this.topicIntents.has(topicId))) return this.managementFailure('out_of_scope', '主题不存在或已删除。')
      const session = await this.createSessionLocked(ownerId, parentId, topicId, false, initialMode)
      if (!session) return this.managementFailure('operation_failed', this.notice ?? '新会话未创建，请核对当前记录。')
      const seat = this.seats.get(session.id)!
      if (seat.status !== 'saved') return this.managementFailure('storage_error', '新会话未保存，内存可能已创建，请查询当前会话列表；未自动重试。')
      return { ok: true, sessions: [seat.session], persistence: 'saved' }
    })
  }

  /** Topic deletion is a client-orchestrated cascade; the store owns the identity, barriers and session removal. */
  captureTopicDeletion(callerOwnerId: string, topicId: string): TopicDeletionPlan | undefined {
    const topic = this.topics.get(topicId)
    if (!topic || this.deletedTopics.has(topicId)) return undefined
    const sessions = this.getTopicSessions(topicId), intent = this.topicIntents.get(topicId)
    return { callerOwnerId, ownerId: this.getTopicStorageScope(topicId)!, topicId, topicName: topic.name,
      operationId: intent?.operationId ?? deletionOperationId('topic'), identityStored: topic.stored,
      nameStored: this.storage?.getItem(topicNameKey(topicId)) ?? null,
      versions: this.captureHistoryVersions(sessions.map(session => session.id)), sessionIds: sessions.map(session => session.id),
      sessionCount: sessions.length, archivedCount: sessions.filter(session => session.archivedAt !== null).length,
      otherOwnerCount: 0 }
  }
  getTopicDeletionBlockedReason(plan: TopicDeletionPlan): string | undefined {
    const topic = this.topics.get(plan.topicId)
    if (!topic || this.deletedTopics.has(plan.topicId)) return '此主题已删除。'
    if (!this.storage || !this.locks) return '当前环境缺少本地存储或 Web Locks，无法写入删除屏障。'
    for (const sessionId of plan.sessionIds) {
      const seat = this.seats.get(sessionId)
      if (!seat) return '会话已变化，请重新打开删除确认。'
      if (seat.status === 'conflict') return '存在会话副本冲突，请先读取最新副本。'
      if (this.executionLeases.has(sessionId) || [...this.revisionDeletions.values(), ...this.unitDeletions.values()].some(item => item.plan.sessionId === sessionId)) return '主题内仍有未结算操作或删除回执，请先结束或查询。'
      const active = (history: TranslationHistory): boolean => history.units.some(unit => isDocumentUnit(unit)
        ? unit.tasks.some(task => ['running', 'unknown'].includes(task.status))
        : isTextUnit(unit) && unit.revisions.some(revision => ['submitting', 'running', 'unknown'].includes(revision.status))) ||
        history.exchanges.some(exchange => ['open', 'waiting_user', 'resuming', 'unknown'].includes(exchange.status))
      if (active(seat.translationHistory) || seat.stored !== null && active(seat.savedTranslationHistory)) return '主题内仍有运行中、等待处理或结果未知的翻译，请先结束或查询。'
    }
    return undefined
  }
  /** Phase A: freeze versions and write the cross-window deletion intent. */
  async beginTopicDeletionAsync(plan: TopicDeletionPlan): Promise<boolean> {
    const fixed = structuredClone(plan)
    return this.withStructureLock(false, () => {
      const topic = this.topics.get(fixed.topicId)
      if (!topic || this.deletedTopics.has(fixed.topicId)) return false
      const blocked = this.getTopicDeletionBlockedReason(fixed)
      if (blocked) { this.notice = blocked; this.emit(); return false }
      if (topic.stored !== fixed.identityStored || (this.storage?.getItem(topicNameKey(fixed.topicId)) ?? null) !== fixed.nameStored) {
        this.notice = '主题身份或名称已变化，请重新打开删除确认。'; this.emit(); return false
      }
      const intent = this.topicIntents.get(fixed.topicId)
      if (intent && intent.operationId !== fixed.operationId) { this.notice = '主题删除尚未完成，请继续原删除操作。'; this.emit(); return false }
      if (this.getTopicSessions(fixed.topicId).length !== fixed.sessionCount) { this.notice = '主题会话已变化，请重新打开删除确认。'; this.emit(); return false }
      for (const version of fixed.versions) {
        const seat = this.seats.get(version.id)
        if (!seat || currentVersion(seat) !== version.current || seat.stored !== version.stored || seat.legacyRaw !== version.legacyRaw) {
          this.notice = '主题会话或历史已变化，请重新打开删除确认。'; this.emit(); return false
        }
      }
      const next: TopicDeletionIntent = { schemaVersion: 1, topicId: fixed.topicId, operationId: fixed.operationId, at: new Date().toISOString(),
        sessionIds: [...fixed.sessionIds], identityStored: fixed.identityStored, nameStored: fixed.nameStored }
      const serialized = JSON.stringify(next)
      try {
        this.storage!.setItem(topicDeletionIntentKey(fixed.topicId), serialized)
        if (this.storage!.getItem(topicDeletionIntentKey(fixed.topicId)) !== serialized) throw new Error('intent read-back failed')
      } catch { this.notice = '主题删除进度写入失败，本次未删除任何内容。'; this.emit(); return false }
      this.topicIntents.set(fixed.topicId, next); this.notice = undefined; this.emit(); return true
    })
  }
  /** Phase B: remove all topic sessions and their per-session records; the topic identity stays until commit. */
  async deleteTopicSessionsAsync(plan: TopicDeletionPlan): Promise<boolean> {
    if (!this.topicIntents.has(plan.topicId)) return false
    return this.deleteHistoryAsync([...plan.sessionIds], false, [], plan.versions)
  }
  /** Phase C: write the tombstone, then remove the identity/name and the intent. */
  async commitTopicDeletionAsync(plan: TopicDeletionPlan): Promise<boolean> {
    const fixed = structuredClone(plan)
    return this.withStructureLock(false, () => {
      const intent = this.topicIntents.get(fixed.topicId), topic = this.topics.get(fixed.topicId)
      if (!intent || intent.operationId !== fixed.operationId || !topic || this.deletedTopics.has(fixed.topicId)) return false
      if (topic.stored !== fixed.identityStored || (this.storage?.getItem(topicNameKey(fixed.topicId)) ?? null) !== fixed.nameStored ||
        this.getTopicSessions(fixed.topicId).length) { this.notice = '主题或会话已变化，删除未提交；请重新核对。'; this.emit(); return false }
      const tombstone = { schemaVersion: 1 as const, topicId: fixed.topicId, sequenceNamespaceId: topic.identity.sequenceNamespaceId,
        nextSequence: topic.identity.nextSequence, sessionCount: fixed.sessionCount, at: new Date().toISOString(), operationId: fixed.operationId }
      const serialized = JSON.stringify(tombstone)
      try {
        this.storage!.setItem(deletedTopicKey(fixed.topicId), serialized)
        if (this.storage!.getItem(deletedTopicKey(fixed.topicId)) !== serialized) throw new Error('tombstone read-back failed')
      } catch { this.notice = '主题删除屏障写入失败，主题尚未删除。'; this.emit(); return false }
      this.deletedTopics.add(fixed.topicId)
      let cleanupNotice: string | undefined
      try {
        this.storage!.removeItem(topicIdentityKey(fixed.topicId))
        this.storage!.removeItem(topicNameKey(fixed.topicId))
        this.storage!.removeItem(topicDeletionIntentKey(fixed.topicId))
      } catch { cleanupNotice = '主题已删除，但部分身份记录未清理；主题不会重新出现在列表中。' }
      this.topics.delete(fixed.topicId); this.corruptTopics.delete(topicIdentityKey(fixed.topicId))
      this.topicIntents.delete(fixed.topicId)
      this.notice = cleanupNotice
      this.emit(); return true
    })
  }
  /** Keep the topic usable when a pre-commit phase fails; the intent must never outlive an abandoned attempt. */
  async abortTopicDeletionAsync(plan: TopicDeletionPlan, message: string): Promise<boolean> {
    return this.withStructureLock(false, () => {
      const intent = this.topicIntents.get(plan.topicId)
      if (!intent || intent.operationId !== plan.operationId) return false
      this.storage?.removeItem(topicDeletionIntentKey(plan.topicId)); this.topicIntents.delete(plan.topicId)
      this.notice = message; this.emit(); return true
    })
  }

  async renameTopicAsync(ownerId: string, topicId: string, expectedName: string, name: string): Promise<SessionManagementResult> {
    return this.manageSessions(async () => {
      const topic = this.topics.get(topicId)
      if (!ownerId.trim() || !topic || this.deletedTopics.has(topicId) || this.topicIntents.has(topicId)) return this.managementFailure('out_of_scope', '主题不存在或已删除。')
      if (!this.validTopicName(name)) return this.managementFailure('invalid_input', this.notice!)
      const raw = this.storage?.getItem(topicNameKey(topicId)) ?? null
      const saved = raw === null ? undefined : decodeTopicName(raw, topic.identity)
      if (topic.name !== expectedName || (raw !== null && (!saved || (topic.persistedName !== undefined && saved.name !== topic.persistedName)))) {
        return this.managementFailure('conflict', '主题名称已变化，未采用陈旧修改，请查询当前名称。')
      }
      if (!this.storage || !this.locks) return this.managementFailure('storage_error', '当前环境无法协调名称保存，未执行修改。')
      this.writeIdentity(topic)
      if (saved?.name !== name.trim()) {
        const version = (saved?.version ?? 0) + 1
        if (!Number.isSafeInteger(version)) throw new Error('version exhausted')
        this.storage.setItem(topicNameKey(topicId), JSON.stringify({ schemaVersion: 1, topicId, sequenceNamespaceId: topic.identity.sequenceNamespaceId, name: name.trim(), version }))
      }
      if (topic.name !== name.trim() || topic.nameDirty) this.projectName(topic, name.trim(), true)
      else topic.persistedName = name.trim()
      if (this.historyBackend) for (const seat of this.seats.values()) if (seat.session.topicId === topicId) {
        const saved = await this.persistLocked(seat.session.id)
        if (!saved) return this.managementFailure('storage_error', '主题名称尚未全部保存到宿主，请重试。')
      }
      this.notice = undefined; this.emit()
      return { ok: true, sessions: this.getAvailableSessions(ownerId).filter(session => session.topicId === topicId && !this.isDeleted(session.id)), persistence: 'saved' }
    })
  }

  async setSessionRemarkAsync(ownerId: string, id: string, expectedRemark: string, remark: string): Promise<SessionManagementResult> {
    return this.manageSessions(async () => {
      const seat = this.seats.get(id)
      if (!seat || this.isDeleted(id)) return this.managementFailure('out_of_scope', '翻译会话不属于当前主会话或已删除。')
      if (!this.managedSessionCurrent(seat) || seat.session.remark !== expectedRemark) return this.managementFailure('conflict', '会话备注已变化，未采用陈旧修改，请查询当前记录。')
      if (Array.from(remark).length > 1000) return this.managementFailure('invalid_input', '备注最多 1000 个字符。')
      if (!this.storage || !this.locks) return this.managementFailure('storage_error', '当前环境无法协调会话保存，未执行修改。')
      if (seat.session.remark !== remark) {
        seat.session = { ...seat.session, remark, updatedAt: new Date().toISOString() }; seat.status = 'memory'
      }
      return this.finishManagedSession(seat)
    })
  }

  async setSessionArchivedAsync(ownerId: string, id: string, expectedArchived: boolean, archived: boolean): Promise<SessionManagementResult> {
    return this.manageSessions(async () => {
      const seat = this.seats.get(id)
      if (!seat || this.isDeleted(id)) return this.managementFailure('out_of_scope', '翻译会话不属于当前主会话或已删除。')
      if (!this.managedSessionCurrent(seat) || (seat.session.archivedAt !== null) !== expectedArchived) return this.managementFailure('conflict', '会话归档状态已变化，未采用陈旧修改，请查询当前记录。')
      if (!this.storage || !this.locks) return this.managementFailure('storage_error', '当前环境无法协调会话保存，未执行修改。')
      if (expectedArchived !== archived) {
        const time = new Date().toISOString()
        seat.session = { ...seat.session, archivedAt: archived ? time : null, updatedAt: time }; seat.status = 'memory'
        for (const entry of this.workspaces.keys()) this.reconcileWorkspace(entry)
      }
      return this.finishManagedSession(seat)
    })
  }
  updateSession(id: string, patch: Partial<Pick<LocalSession, 'mode' | 'targetLanguage' | 'input' | 'instruction' | 'model' | 'maxInputChars' | 'remark'>>): boolean {
    const seat = this.seats.get(id)
    if (!seat) return false
    if (this.unloadedHistory.has(id) && Object.keys(patch).some(field => field !== 'remark')) { void this.ensureSessionHistory(id); return false }
    if (seat.session.mode === 'normal' && patch.mode === 'quick') {
      this.notice = '普通会话不能降为快译。需要快译时请新建主题。'; this.emit(); return false
    }
    const next = decodeSession({ ...seat.session, ...patch, updatedAt: new Date().toISOString() })
    if (!next) { this.notice = '输入无效或过长，之前的会话内容仍保留。'; this.emit(); return false }
    seat.session = next
    if (seat.status !== 'conflict') seat.status = 'memory'
    this.notice = undefined
    if (Object.hasOwn(patch, 'model')) this.rememberModel(seat)
    this.persist(id)
    this.emit(); return true
  }
  /** The conversion runs against current memory; persistence shares the existing session lock and conflict checks. */
  updateTranslationHistory(id: string, update: (history: TranslationHistory) => TranslationHistory): boolean {
    if (this.unloadedHistory.has(id)) { void this.ensureSessionHistory(id); return false }
    const seat = this.seats.get(id)
    if (!seat || this.disposed) return false
    if ([...this.revisionDeletions.values(), ...this.unitDeletions.values()].some(item => item.plan.sessionId === id)) {
      this.notice = '此会话的删除回执尚未确认，请先查询本次删除结果。'; this.emit(); return false
    }
    try {
      if (this.isDeleted(id)) { this.notice = '会话已删除，迟到的翻译记录未采用。'; this.emit(); return false }
      if (this.deletedTopics.has(seat.session.topicId) || this.topicIntents.has(seat.session.topicId)) {
        this.notice = '主题正在删除或已删除，迟到的翻译记录未采用。'; this.emit(); return false
      }
      const next = decodeTranslationHistory(update(structuredClone(seat.translationHistory)))
      if (!next) throw new Error('invalid translation history')
      if (JSON.stringify(next) === JSON.stringify(seat.translationHistory)) return true
      seat.translationHistory = next
      seat.session = { ...seat.session, updatedAt: new Date().toISOString() }
      if (seat.status !== 'conflict') seat.status = 'memory'
      this.notice = undefined
      this.persist(id)
      this.emit(); return true
    } catch { this.notice = '翻译记录更新失败，之前的材料与版本仍保留。'; this.emit(); return false }
  }
  captureTextRevisionDeletion(sessionId: string, unitId: string, revisionId: string): TextRevisionDeletionPlan | undefined {
    const version = this.captureHistoryVersions([sessionId])[0]
    return version ? { sessionId, unitId, revisionId, version, eventId: deletionOperationId('revision') } : undefined
  }
  getPendingTextRevisionDeletion(sessionId: string, unitId: string, revisionId: string): string | undefined {
    return [...this.revisionDeletions.values()].find(item => item.plan.sessionId === sessionId && item.plan.unitId === unitId && item.plan.revisionId === revisionId)?.plan.eventId
  }
  getTextRevisionDeletionBlockedReason(sessionId: string, unitId: string, revisionId: string): string | undefined {
    return this.revisionDeletionBlockedReason(sessionId, unitId, revisionId)
  }
  private revisionDeletionBlockedReason(sessionId: string, unitId: string, revisionId: string, leaseId?: string): string | undefined {
    const seat = this.seats.get(sessionId)
    if (!seat || this.disposed || this.isDeleted(sessionId)) return '此会话已不可用。'
    if (seat.session.archivedAt !== null) return '归档会话不能删除版本，请先恢复会话。'
    if (seat.status === 'conflict') return '会话副本存在冲突，请先读取最新副本。'
    if (this.executionLeases.has(sessionId) && this.executionLeases.get(sessionId) !== leaseId) return '此会话仍有未结算操作，请先结束或查询。'
    const active = (history: TranslationHistory): boolean => history.units.some(unit => isDocumentUnit(unit)
      ? unit.tasks.some(task => ['running', 'unknown'].includes(task.status))
      : isTextUnit(unit) && unit.revisions.some(revision => ['submitting', 'running', 'unknown'].includes(revision.status))) ||
      history.exchanges.some(exchange => ['open', 'waiting_user', 'resuming', 'unknown'].includes(exchange.status)) ||
      history.events.some(event => event.revisionId === null && ['operation.accepted', 'operation.retranslation_accepted'].includes(event.type) &&
        !history.units.filter(isTextUnit).some(unit => unit.revisions.some(revision => revision.operationId === event.operationId)) &&
        ['submitting', 'running', 'unknown'].includes([...history.events].reverse().find(item => item.operationId === event.operationId)?.status ?? ''))
    if (active(seat.translationHistory) || seat.stored !== null && active(seat.savedTranslationHistory)) return '此会话仍有运行中、等待处理或结果未知的翻译，请先结束或查询。'
    const runtime = textRevisionDeletionBlockedReason(seat.translationHistory, unitId, revisionId)
    if (runtime) return runtime
    const savedUnit = seat.savedTranslationHistory.units.find(unit => unit.id === unitId)
    if (seat.stored !== null && (savedUnit && !isFileJobUnit(savedUnit) ? savedUnit.revisions : []).some(revision => revision.id === revisionId)) {
      const saved = textRevisionDeletionBlockedReason(seat.savedTranslationHistory, unitId, revisionId)
      if (saved) return `已保存副本：${saved} 请先保存当前状态或调整最终选择。`
    }
    return undefined
  }
  /** Explicit deletion writes only the saved target conversion, regardless of automatic history saving. */
  async deleteTextRevisionAsync(plan: TextRevisionDeletionPlan | undefined, guards: { readonly blockedReason?: () => string | undefined } = {}): Promise<TextRevisionDeletionResult> {
    const stopped = (status: TextRevisionDeletionResult['status'], message: string): TextRevisionDeletionResult => ({ status, operationId: plan?.eventId ?? '', message })
    if (!plan) return stopped('stale', '删除目标已不可用，请重新打开确认。')
    const fixed = structuredClone(plan), blocked = this.revisionDeletionBlockedReason(fixed.sessionId, fixed.unitId, fixed.revisionId) ?? guards.blockedReason?.()
    if (blocked) return stopped('blocked', blocked)
    if (this.historyBackend) return this.deleteHostUnitPart(fixed, { kind: 'delete_text_revision', unitId: fixed.unitId, revisionId: fixed.revisionId }, guards.blockedReason)
    const release = this.claimDocumentLease(fixed.sessionId, fixed.eventId)
    if (!release) return stopped('blocked', '此会话仍有未结算操作，请先结束或查询。')
    const run = (): TextRevisionDeletionResult => {
      const seat = this.seats.get(fixed.sessionId)
      if (!seat || currentVersion(seat) !== fixed.version.current || seat.stored !== fixed.version.stored || seat.legacyRaw !== fixed.version.legacyRaw ||
        (this.historyRaw(fixed.sessionId) ?? null) !== fixed.version.stored) return stopped('stale', '会话或版本已变化，请重新打开删除确认。')
      const reason = this.revisionDeletionBlockedReason(fixed.sessionId, fixed.unitId, fixed.revisionId, fixed.eventId) ?? guards.blockedReason?.()
      if (reason) return stopped('blocked', reason)
      const at = new Date().toISOString(), input = { eventId: fixed.eventId, at }
      const runtime = deleteTextRevision(seat.translationHistory, fixed.unitId, fixed.revisionId, input)
      const savedHasTarget = seat.stored !== null && seat.savedTranslationHistory.units.filter(hasUnitBody).find(unit => unit.id === fixed.unitId)?.revisions.some(revision => revision.id === fixed.revisionId)
      if (!savedHasTarget) {
        seat.translationHistory = runtime; seat.session = { ...seat.session, updatedAt: at }; seat.status = 'memory'; this.emit()
        return stopped('deleted', '已删除此旧版本的正文；未保存内容仍只保留在本次运行。')
      }
      if (!this.storage || !seat.savedSession) return stopped('failed', '保存副本不可用，本次未删除正文。')
      const saved: SessionSnapshot = { session: { ...seat.savedSession, updatedAt: at },
        translationHistory: deleteTextRevision(seat.savedTranslationHistory, fixed.unitId, fixed.revisionId, input) }
      const serialized = JSON.stringify({ schemaVersion: 14, token: fixed.eventId, session: saved.session, translationHistory: persistedTranslationHistory(saved.translationHistory) })
      const pending: PendingRevisionDeletion = { plan: fixed, at, saved, serialized, release }
      this.revisionDeletions.set(fixed.eventId, pending)
      try { this.storage.setItem(historyKey(fixed.sessionId), serialized) } catch { /* Read the original operation below; a thrown write is not proof of failure. */ }
      return this.observeRevisionDeletionLocked(pending)
    }
    try {
      const seat = this.seats.get(fixed.sessionId)
      return seat?.stored !== null ? await this.withStructureLock(stopped('failed', '无法取得存储锁，本次未删除正文。'), run) : run()
    } catch { return stopped('failed', '无法读取删除目标，正文仍保留；请核对当前副本。') }
    finally { if (!this.revisionDeletions.has(fixed.eventId)) release() }
  }
  /** Query the original write only; never repeat an uncertain deletion write. */
  async observeTextRevisionDeletionAsync(operationId: string): Promise<TextRevisionDeletionResult> {
    const pending = this.revisionDeletions.get(operationId)
    if (!pending) return { status: 'stale', operationId, message: '未找到待确认的删除操作，请核对当前记录。' }
    return this.withStructureLock({ status: 'unknown', operationId, message: '删除回执仍未确认，请再次查询原操作。' } as TextRevisionDeletionResult,
      () => this.observeRevisionDeletionLocked(pending))
  }
  private observeRevisionDeletionLocked(pending: PendingRevisionDeletion): TextRevisionDeletionResult {
    const { plan } = pending, seat = this.seats.get(plan.sessionId)
    const result = (status: TextRevisionDeletionResult['status'], message: string): TextRevisionDeletionResult => ({ status, operationId: plan.eventId, message })
    let raw: string | null
    try { raw = this.historyRaw(plan.sessionId) } catch { return result('unknown', '删除回执尚未确认，请查询本次删除结果；未重复写入。') }
    const snapshot = raw === pending.serialized ? pending.saved : raw === null ? undefined : readSnapshot(raw)
    const removed = snapshot?.translationHistory.units.filter(isTextUnit).find(unit => unit.id === plan.unitId)?.revisions.find(revision => revision.id === plan.revisionId)
    if (seat && removed?.deletion?.eventId === plan.eventId && removed.deletion.at === pending.at) {
      seat.translationHistory = deleteTextRevision(seat.translationHistory, plan.unitId, plan.revisionId, { eventId: plan.eventId, at: pending.at })
      seat.session = { ...seat.session, updatedAt: pending.at }; seat.savedSession = snapshot!.session
      seat.savedTranslationHistory = snapshot!.translationHistory; seat.stored = raw
      const laterChange = raw !== pending.serialized
      seat.status = laterChange ? 'conflict' : currentVersion(seat) === JSON.stringify(snapshot) ? 'saved' : 'memory'
      delete seat.storageError; this.revisionDeletions.delete(plan.eventId); pending.release(); this.emit()
      return result('deleted', laterChange ? '版本正文已删除；保存副本随后变化，请读取最新副本，当前临时修改仍保留。' : '已删除此旧版本的正文。')
    }
    if (raw === plan.version.stored || raw !== pending.serialized) {
      this.revisionDeletions.delete(plan.eventId); pending.release()
      if (seat && raw !== plan.version.stored) seat.status = 'conflict'
      this.emit(); return result(raw === plan.version.stored ? 'failed' : 'stale', raw === plan.version.stored
        ? '删除未写入，正文和旧保存副本仍保留，请重新确认后重试。' : '保存副本已变化，未重复写入删除，请读取最新副本。')
    }
    return result('unknown', '删除回执尚未确认，请查询本次删除结果；未重复写入。')
  }
  captureTextUnitDeletion(sessionId: string, unitId: string): TextUnitDeletionPlan | undefined {
    const version = this.captureHistoryVersions([sessionId])[0]
    return version ? { sessionId, unitId, eventId: deletionOperationId('unit'), version } : undefined
  }
  getPendingTextUnitDeletion(sessionId: string, unitId: string): string | undefined {
    return [...this.unitDeletions.values()].find(item => item.plan.sessionId === sessionId && item.plan.unitId === unitId)?.plan.eventId
  }
  getTextUnitDeletionBlockedReason(sessionId: string, unitId: string): string | undefined {
    return this.unitDeletionBlockedReason(sessionId, unitId)
  }
  private unitDeletionBlockedReason(sessionId: string, unitId: string, leaseId?: string): string | undefined {
    const seat = this.seats.get(sessionId)
    if (!seat || this.disposed || this.isDeleted(sessionId)) return '此会话已不可用。'
    if (seat.session.archivedAt !== null) return '归档会话不能删除单元，请先恢复会话。'
    if (seat.status === 'conflict') return '会话副本存在冲突，请先读取最新副本。'
    if (this.executionLeases.has(sessionId) && this.executionLeases.get(sessionId) !== leaseId) return '此会话仍有未结算操作，请先结束或查询。'
    if ([...this.revisionDeletions.values(), ...this.unitDeletions.values()].some(item => item.plan.sessionId === sessionId)) return '此会话的删除回执尚未确认，请先查询本次删除结果。'
    const active = (history: TranslationHistory): boolean => history.units.some(unit => isDocumentUnit(unit)
      ? unit.tasks.some(task => ['running', 'unknown'].includes(task.status))
      : isTextUnit(unit) && unit.revisions.some(revision => ['submitting', 'running', 'unknown'].includes(revision.status))) ||
      history.exchanges.some(exchange => ['open', 'waiting_user', 'resuming', 'unknown'].includes(exchange.status))
    if (active(seat.translationHistory) || seat.stored !== null && active(seat.savedTranslationHistory)) return '此会话仍有运行中、等待处理或结果未知的翻译，请先结束或查询。'
    const runtime = unitDeletionBlockedReason(seat.translationHistory, unitId)
    if (runtime) return runtime
    const savedUnit = seat.stored !== null ? seat.savedTranslationHistory.units.find(unit => unit.id === unitId) : undefined
    if (savedUnit && !isDeletedUnit(savedUnit)) {
      const saved = unitDeletionBlockedReason(seat.savedTranslationHistory, unitId)
      if (saved) return `已保存副本：${saved}`
    }
    return undefined
  }
  /** Explicit deletion writes the saved target conversion even when automatic history saving is off. */
  async deleteTextUnitAsync(plan: TextUnitDeletionPlan | undefined, guards: { readonly blockedReason?: () => string | undefined } = {}): Promise<TextUnitDeletionResult> {
    const stopped = (status: TextUnitDeletionResult['status'], message: string): TextUnitDeletionResult => ({ status, operationId: plan?.eventId ?? '', message })
    if (!plan) return stopped('stale', '删除目标已不可用，请重新打开确认。')
    const fixed = structuredClone(plan), blocked = this.unitDeletionBlockedReason(fixed.sessionId, fixed.unitId) ?? guards.blockedReason?.()
    if (blocked) return stopped('blocked', blocked)
    if (this.historyBackend) return this.deleteHostUnitPart(fixed, { kind: 'delete_unit', unitId: fixed.unitId }, guards.blockedReason)
    const release = this.claimDocumentLease(fixed.sessionId, fixed.eventId)
    if (!release) return stopped('blocked', '此会话仍有未结算操作，请先结束或查询。')
    const run = (): TextUnitDeletionResult => {
      const seat = this.seats.get(fixed.sessionId)
      if (!seat || currentVersion(seat) !== fixed.version.current || seat.stored !== fixed.version.stored || seat.legacyRaw !== fixed.version.legacyRaw ||
        (this.historyRaw(fixed.sessionId) ?? null) !== fixed.version.stored) return stopped('stale', '会话或版本已变化，请重新打开删除确认。')
      const reason = this.unitDeletionBlockedReason(fixed.sessionId, fixed.unitId, fixed.eventId) ?? guards.blockedReason?.()
      if (reason) return stopped('blocked', reason)
      const at = new Date().toISOString(), input = { eventId: fixed.eventId, at }
      const runtime = deleteUnit(seat.translationHistory, fixed.unitId, input)
      const savedUnit = seat.stored !== null ? seat.savedTranslationHistory.units.find(unit => unit.id === fixed.unitId) : undefined
      if (!savedUnit || isDeletedUnit(savedUnit)) {
        seat.translationHistory = runtime; seat.session = { ...seat.session, updatedAt: at }
        if (seat.status !== 'conflict') seat.status = 'memory'
        this.emit()
        return stopped('deleted', '已删除此单元的正文；未保存内容仍只保留在本次运行。')
      }
      if (!this.storage || !seat.savedSession) return stopped('failed', '保存副本不可用，本次未删除正文。')
      const saved: SessionSnapshot = { session: { ...seat.savedSession, updatedAt: at },
        translationHistory: deleteUnit(seat.savedTranslationHistory, fixed.unitId, input) }
      const serialized = JSON.stringify({ schemaVersion: 14, token: fixed.eventId, session: saved.session, translationHistory: persistedTranslationHistory(saved.translationHistory) })
      const pending: PendingUnitDeletion = { plan: fixed, at, saved, serialized, release }
      this.unitDeletions.set(fixed.eventId, pending)
      try { this.storage.setItem(historyKey(fixed.sessionId), serialized) } catch { /* Read the original operation below; a thrown write is not proof of failure. */ }
      return this.observeUnitDeletionLocked(pending)
    }
    try {
      const seat = this.seats.get(fixed.sessionId)
      return seat?.stored !== null ? await this.withStructureLock(stopped('failed', '无法取得存储锁，本次未删除正文。'), run) : run()
    } catch { return stopped('failed', '无法读取删除目标，正文仍保留；请核对当前副本。') }
    finally { if (!this.unitDeletions.has(fixed.eventId)) release() }
  }
  /** Query the original write only; never repeat an uncertain deletion write. */
  async observeTextUnitDeletionAsync(operationId: string): Promise<TextUnitDeletionResult> {
    const pending = this.unitDeletions.get(operationId)
    if (!pending) return { status: 'stale', operationId, message: '未找到待确认的删除操作，请核对当前记录。' }
    return this.withStructureLock({ status: 'unknown', operationId, message: '删除回执仍未确认，请再次查询原操作。' } as TextUnitDeletionResult,
      () => this.observeUnitDeletionLocked(pending))
  }
  private observeUnitDeletionLocked(pending: PendingUnitDeletion): TextUnitDeletionResult {
    const { plan } = pending, seat = this.seats.get(plan.sessionId)
    const result = (status: TextUnitDeletionResult['status'], message: string): TextUnitDeletionResult => ({ status, operationId: plan.eventId, message })
    let raw: string | null
    try { raw = this.historyRaw(plan.sessionId) } catch { return result('unknown', '删除回执尚未确认，请查询本次删除结果；未重复写入。') }
    const snapshot = raw === pending.serialized ? pending.saved : raw === null ? undefined : readSnapshot(raw)
    const removed = snapshot?.translationHistory.units.find(unit => unit.id === plan.unitId)
    if (seat && removed?.deletion?.eventId === plan.eventId && removed.deletion.at === pending.at) {
      const current = seat.translationHistory.units.find(unit => unit.id === plan.unitId)
      if (current && !isDeletedUnit(current)) seat.translationHistory = deleteUnit(seat.translationHistory, plan.unitId, { eventId: plan.eventId, at: pending.at })
      seat.session = { ...seat.session, updatedAt: pending.at }; seat.savedSession = snapshot!.session
      seat.savedTranslationHistory = snapshot!.translationHistory; seat.stored = raw
      const laterChange = raw !== pending.serialized
      seat.status = laterChange ? 'conflict' : currentVersion(seat) === JSON.stringify(snapshot) ? 'saved' : 'memory'
      delete seat.storageError; this.unitDeletions.delete(plan.eventId); pending.release(); this.emit()
      return result('deleted', laterChange ? '单元正文已删除；保存副本随后变化，请读取最新副本，当前临时修改仍保留。' : '已删除此单元的正文。')
    }
    if (raw === plan.version.stored || raw !== pending.serialized) {
      this.unitDeletions.delete(plan.eventId); pending.release()
      if (seat && raw !== plan.version.stored) seat.status = 'conflict'
      this.emit(); return result(raw === plan.version.stored ? 'failed' : 'stale', raw === plan.version.stored
        ? '删除未写入，正文和旧保存副本仍保留，请重新确认后重试。' : '保存副本已变化，未重复写入删除，请读取最新副本。')
    }
    return result('unknown', '删除回执尚未确认，请查询本次删除结果；未重复写入。')
  }
  private async deleteHostUnitPart(plan: TextUnitDeletionPlan, command: import('../shared/history-remote.js').HistoryMutation['command'], blocked?: () => string | undefined): Promise<TextUnitDeletionResult> {
    const result = (status: TextUnitDeletionResult['status'], message: string): TextUnitDeletionResult => ({ status, operationId: plan.eventId, message })
    return this.withStructureLock(result('failed', '宿主删除未完成，请重试。'), async () => {
      const seat = this.seats.get(plan.sessionId)
      if (!seat || currentVersion(seat) !== plan.version.current || blocked?.()) return result('stale', '会话或删除条件已变化，请重新确认。')
      const release = this.claimDocumentLease(plan.sessionId, plan.eventId)
      if (!release) return result('blocked', '此会话仍有未结算操作。')
      try {
        const receipt = await this.historyBackend!.mutate(seat.session, seat.translationHistory, command, plan.eventId)
        this.restoreHostHistory([receipt])
        const cleanup = receipt.resourceCleanup
        const message = !cleanup ? '已删除所选正文，保留编号和实际调用记录。' : !cleanup.complete
          ? '正文已删除；部分文件清理未完成，请在存储管理中重试文件回收。编号和调用统计保留。'
          : `正文已删除，清理 ${cleanup.removed} 个文件${cleanup.retained ? `，${cleanup.retained} 个共享文件因其他对象持有而保留` : ''}。编号和调用统计保留。`
        this.notice = message; this.emit(); return result('deleted', message)
      } catch (error) { return result('blocked', error instanceof Error ? error.message : '宿主删除未完成。') }
      finally { release() }
    })
  }
  async deleteFileResultAsync(plan: TextUnitDeletionPlan & { readonly resultVersion: number }, blocked?: () => string | undefined): Promise<TextUnitDeletionResult> {
    const reason = this.unitDeletionBlockedReason(plan.sessionId, plan.unitId) ?? blocked?.()
    if (!this.historyBackend || reason) return { status: 'blocked', operationId: plan.eventId, message: reason ?? '请连接宿主历史后再删除文件译文版本。' }
    return this.deleteHostUnitPart(plan, { kind: 'delete_file_result', unitId: plan.unitId, version: plan.resultVersion }, blocked)
  }
  async deleteFileSourceAsync(plan: TextUnitDeletionPlan & { readonly sourceVersion: number }, blocked?: () => string | undefined): Promise<TextUnitDeletionResult> {
    const reason = this.unitDeletionBlockedReason(plan.sessionId, plan.unitId) ?? blocked?.()
    if (!this.historyBackend || reason) return { status: 'blocked', operationId: plan.eventId, message: reason ?? '文件旧原稿删除需要宿主历史服务。' }
    return this.deleteHostUnitPart(plan, { kind: 'delete_file_source', unitId: plan.unitId, version: plan.sourceVersion }, blocked)
  }
  async deleteDocumentRevisionAsync(plan: TextUnitDeletionPlan & { readonly revisionId: string }, blocked?: () => string | undefined): Promise<TextUnitDeletionResult> {
    const reason = this.unitDeletionBlockedReason(plan.sessionId, plan.unitId) ?? blocked?.()
    if (!this.historyBackend || reason) return { status: 'blocked', operationId: plan.eventId, message: reason ?? '请连接宿主历史后再删除文档版本。' }
    return this.deleteHostUnitPart(plan, { kind: 'delete_document_revision', unitId: plan.unitId, revisionId: plan.revisionId }, blocked)
  }
  async deleteDocumentSourceAsync(plan: TextUnitDeletionPlan & { readonly sourceVersion: number }, blocked?: () => string | undefined): Promise<TextUnitDeletionResult> {
    const reason = this.unitDeletionBlockedReason(plan.sessionId, plan.unitId) ?? blocked?.()
    if (!this.historyBackend || reason) return { status: 'blocked', operationId: plan.eventId, message: reason ?? '请连接宿主历史后再删除旧原稿。' }
    return this.deleteHostUnitPart(plan, { kind: 'delete_document_source', unitId: plan.unitId, version: plan.sourceVersion }, blocked)
  }
  async deleteDocumentChunksAsync(plan: TextUnitDeletionPlan, blocked?: () => string | undefined): Promise<TextUnitDeletionResult> {
    const reason = this.unitDeletionBlockedReason(plan.sessionId, plan.unitId) ?? blocked?.()
    if (!this.historyBackend || reason) return { status: 'blocked', operationId: plan.eventId, message: reason ?? '翻译块清理需要宿主历史服务。' }
    return this.deleteHostUnitPart(plan, { kind: 'delete_document_chunks', unitId: plan.unitId }, blocked)
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
      if (saved && seat.savedSession && !this.historyBackend) seat.savedSession = { ...seat.savedSession, topicName: name, name: sessionName(name, seat.savedSession.sequence) }
      else if (seat.status !== 'conflict') seat.status = 'memory'
    }
  }

  async renameSessionAsync(id: string, name: string): Promise<boolean> {
    if (!this.validTopicName(name) || !this.readSettings()) return false

    const seat = this.seats.get(id), topic = seat && this.topics.get(seat.session.topicId)
    if (!seat || !topic) return false
    let expectedName: string | null
    try { expectedName = this.storage?.getItem(topicNameKey(topic.identity.id)) ?? null }
    catch { this.notice = '主题名称读取失败，当前名称保留。'; this.emit(); return false }
    const expectedRecord = expectedName === null ? undefined : decodeTopicName(expectedName, topic.identity)
    if (expectedName !== null && (!expectedRecord || (topic.persistedName !== undefined && expectedRecord.name !== topic.persistedName))) {
      this.notice = '主题已在其他窗口重命名，请核对最新名称后重试。'; this.emit(); return false
    }
    return this.withStructureLock(false, async () => {
      if (!this.readSettings()) return false

      if (this.isDeleted(id) || this.storage?.getItem(topicNameKey(topic.identity.id)) !== expectedName) {
        this.notice = '会话或主题名称已在其他窗口变化，请核对后重试。'; this.emit(); return false
      }
      this.writeIdentity(topic)
      const version = (expectedRecord?.version ?? 0) + 1
      if (!Number.isSafeInteger(version)) throw new Error('version exhausted')
      const nameRecord = { schemaVersion: 1, topicId: topic.identity.id, sequenceNamespaceId: topic.identity.sequenceNamespaceId, name: name.trim(), version }
      this.storage!.setItem(topicNameKey(topic.identity.id), JSON.stringify(nameRecord))
      this.projectName(topic, name.trim(), true)
      if (this.historyBackend) for (const item of this.seats.values()) if (item.session.topicId === topic.identity.id && !await this.persistLocked(item.session.id)) { this.emit(); return false }
      this.notice = undefined; this.emit(); return true
    })
  }

  private writeIdentity(topic: TopicSeat, allocation?: { readonly sessionId: string; readonly sequence: number }): void {
    if (!this.storage || this.corruptTopics.has(topicIdentityKey(topic.identity.id))) throw new Error('topic unavailable')
    const legacyOwner = this.legacyStorageOwners.get(topic.identity.id)
    if (legacyOwner && this.storage.getItem('dsh-translation-plugin:legacy-topic-storage:v1:' + encodeURIComponent(topic.identity.id)) !== legacyOwner) throw new Error('legacy asset locator was not saved')
    const key = topicIdentityKey(topic.identity.id), raw = this.storage.getItem(key)
    const latest = raw === null ? undefined : decodeTopicIdentity(raw)
    if ((raw !== null && !latest) || (raw === null && topic.stored !== null) ||
      (latest && (latest.sequenceNamespaceId !== topic.identity.sequenceNamespaceId))) throw new Error('topic conflict')
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
    if (!this.storage || !this.readSettings()) return
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
    const promise = this.withStructureLock(false, async () => {
      if (!this.readSettings()) return false
      const current = this.seats.get(id), topic = current && this.topics.get(current.session.topicId)
      if (!current || !topic || this.isDeleted(id)) {
        if (current) current.status = 'conflict'
        this.notice = '会话已删除或主题身份不可用，当前输入保留。'; this.emit(); return false
      }
      try {
        this.writeIdentity(topic); this.writeTopicName(topic)
        this.adoptTopic(current)
        const result = await this.persistLocked(id, overwrite)
        this.emit(); return result
      } catch (error) {
        current.status = 'error'; current.storageError = this.notice = storageSaveFailureMessage(error, '主题或会话历史', '主题或会话历史保存失败，当前输入仍保留。'); this.emit(); return false
      }
    }).then(result => {
      if (!result && !this.locks && this.seats.get(id)?.status !== 'conflict') { seat.status = 'error'; this.emit() }
      return result
    }).finally(() => {
      if (this.pendingSaves.get(id) !== promise) return
      this.pendingSaves.delete(id)
      // A mutation can arrive after the lock wrote its snapshot but before this promise settles.
      // Schedule that new dirty state once; failed/conflicting writes await explicit user action.
      if (this.dirtySaves.delete(id) && !this.disposed && this.seats.get(id)?.status === 'memory') this.persist(id)
    })
    this.pendingSaves.set(id, promise)
    return promise
  }

  private async persistLocked(id: string, overwrite = false): Promise<boolean> {
    if (!await this.ensureSessionHistory(id)) return false
    const seat = this.seats.get(id)
    if (!seat || !this.storage) { this.notice = '会话历史保存不可用，内容仍保留在当前窗口。'; return false }
    try {
      if (!this.historyReady) throw new Error('宿主会话历史尚未读取完成。')
      if (!this.readSettings()) throw new Error('invalid settings')
      if (this.historyBackend) {
        const captured = currentVersion(seat), receipt = await this.historyBackend.save(seat.session, seat.translationHistory)
        if (this.disposed || this.isDeleted(id)) return false
        seat.savedSession = receipt.saved?.session; seat.savedTranslationHistory = receipt.saved?.history ?? emptyTranslationHistory()
        seat.stored = this.historyBackend.snapshot(id)
        seat.status = currentVersion(seat) === captured && receipt.state.persistence === 'saved' ? 'saved' : 'memory'
        delete seat.storageError
        return receipt.state.persistence === 'saved'
      }

      if (this.isDeleted(id)) { seat.status = 'conflict'; this.notice = '会话已在其他窗口删除，当前输入保留，不能覆盖恢复已删除身份。'; return false }
      if (this.deletedTopics.has(seat.session.topicId) || this.topicIntents.has(seat.session.topicId)) {
        seat.status = 'conflict'; this.notice = '主题正在删除或已删除，当前输入保留，不能写入已关闭的主题。'; return false
      }
      const raw = this.historyRaw(id)
      if (!overwrite && (raw !== seat.stored || seat.status === 'conflict')) {
        seat.status = 'conflict'; this.notice = '会话历史已在其他窗口修改或删除，当前输入保留。请选择读取本地副本或明确覆盖。'; return false
      }
      if (raw !== null) {
        const saved = readSnapshot(raw)
        // A saved tombstone may never be overwritten by a copy that no longer carries the same deletion facts.
        const resurrectsDeletion = !!saved && saved.translationHistory.units.filter(isTextUnit).some(unit => {
          const current = seat.translationHistory.units.filter(isTextUnit).find(item => item.id === unit.id)
          if (unit.deletion) return current?.deletion?.eventId !== unit.deletion.eventId
          return unit.revisions.some(revision => revision.status === 'deleted' &&
            current?.revisions.find(item => item.id === revision.id)?.deletion?.eventId !== revision.deletion?.eventId)
        })
        if (!saved || resurrectsDeletion) {
          seat.status = 'conflict'; this.notice = '保存副本含已删除内容或无法读取的格式，不能覆盖恢复旧正文。请读取最新副本。'; return false
        }
      }
      const hasTranslations = seat.translationHistory.units.length > 0 || seat.translationHistory.events.length > 0
      const serialized = JSON.stringify({ schemaVersion: hasTranslations ? 14 : 3, token: `${Date.now()}-${Math.random()}`, session: seat.session,
        ...(hasTranslations ? { translationHistory: persistedTranslationHistory(seat.translationHistory) } : {}) })
      this.storage.setItem(historyKey(id), serialized)
      if (this.historyRaw(id) !== serialized) throw new Error('history read-back failed')
      seat.stored = serialized; seat.savedSession = seat.session; seat.savedTranslationHistory = seat.translationHistory; seat.status = 'saved'
      if (this.notice === seat.storageError) this.notice = undefined
      delete seat.storageError
      return true
    } catch (error) { diagnosticSpan({}, 'history.save', {}, id)('failed', {}, error); seat.status = 'error'; seat.storageError = this.notice = storageSaveFailureMessage(error, '会话历史', '会话历史保存失败，当前输入仍保留在窗口内存中。'); return false }
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
    return !!identity && identity.id === session.topicId &&
      identity.sequenceNamespaceId === session.sequenceNamespaceId &&
      identity.allocations.some(allocation => allocation.sessionId === session.id && allocation.sequence === session.sequence)
  }
  async reloadSessionAsync(id: string): Promise<boolean> {
    if (!this.historyBackend) return this.reloadSession(id)
    return this.withStructureLock(false, async () => {
      const seat = this.seats.get(id)
      if (!seat || this.executionLeases.has(id)) return false
      try {
        const receipt = await this.historyBackend!.reload(seat.session)
        if (!receipt.current) { this.notice = '此会话已在宿主删除。'; this.emit(); return false }
        this.restoreHostHistory([receipt]); this.notice = undefined; this.emit(); return true
      } catch (error) { this.notice = error instanceof Error ? error.message : '宿主历史读取失败，当前编辑保留。'; this.emit(); return false }
    })
  }
  reloadSession(id: string): boolean {
    if (this.historyBackend) { void this.reloadSessionAsync(id); return false }
    const seat = this.seats.get(id)
    if (!seat || !this.storage) return false
    if ([...this.revisionDeletions.values(), ...this.unitDeletions.values()].some(item => item.plan.sessionId === id)) {
      this.notice = '删除回执尚未确认，请先查询本次删除结果，再读取其他副本。'; this.emit(); return false
    }
    try {
      const raw = this.historyRaw(id)
      const snapshot = raw === null ? undefined : readSnapshot(raw), session = snapshot?.session
      if (!session || session.id !== id || this.isDeleted(id) || !this.matchesHistoryIdentity(session, seat.session)) throw new Error('invalid history')
      this.notice = undefined
      seat.session = this.restoreModel(session); seat.savedSession = session; seat.translationHistory = restoreTranslationHistory(snapshot!.translationHistory)
      seat.savedTranslationHistory = snapshot!.translationHistory; seat.stored = raw; seat.status = 'saved'
      delete seat.storageError
      const topic = this.topics.get(session.topicId)
      if (topic) { topic.nameDirty = false; topic.name = topic.persistedName ?? session.topicName }
      if (session.sequenceNamespaceId.startsWith('legacy-pending:')) this.migrationSources.set(id, session)
      else this.migrationSources.delete(id)
      this.loadHistory(); this.adoptTopic(seat)
      for (const entry of this.workspaces.keys()) this.reconcileWorkspace(entry); this.emit(); return true
    } catch { this.notice = '本地副本不存在或无法读取，当前输入保持不变。'; this.emit(); return false }
  }

  getUnreadableHistory(): readonly { readonly key: string; readonly raw: string }[] {
    if (this.hostHistory) return []
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

  /** Preparation audits whose every recorded version points at a translation Session that no longer exists. */
  getOrphanPreparations(): readonly { readonly key: string; readonly raw: string }[] {
    const result: { key: string; raw: string }[] = []
    if (!this.storage) return result
    try {
      for (let index = 0; index < this.storage.length; index++) {
        const key = this.storage.key(index)
        if (!key?.startsWith(PREPARATION_STORAGE_PREFIX)) continue
        const raw = this.storage.getItem(key)
        if (raw === null) continue
        const sessions = preparationSessions(raw)
        // 无归属（旧格式）或仍有存活会话时一律保留，只清理所有版本都指向已消失会话的记录。
        if (!sessions.length || sessions.some(id => !!this.getSession(id) && !this.isDeleted(id))) continue
        result.push({ key, raw })
      }
    } catch { this.notice = '部分准备审计无法检查，清理范围可能不完整。' }
    return result
  }

  /** Migration locators that point at a topic already blocked by a deletion tombstone. */
  getOrphanLegacyLocators(): readonly { readonly key: string; readonly raw: string }[] {
    const result: { key: string; raw: string }[] = []
    if (!this.storage) return result
    try {
      for (let index = 0; index < this.storage.length; index++) {
        const key = this.storage.key(index)
        if (!key?.startsWith(LEGACY_TOPIC_STORAGE_PREFIX)) continue
        let topicId: string
        try { topicId = decodeURIComponent(key.slice(LEGACY_TOPIC_STORAGE_PREFIX.length)) } catch { continue }
        if (!this.deletedTopics.has(topicId)) continue
        const raw = this.storage.getItem(key)
        if (raw !== null) result.push({ key, raw })
      }
    } catch { this.notice = '部分迁移定位无法检查，清理范围可能不完整。' }
    return result
  }

  /** Verifies each copy is unchanged, then drops these explicit orphan records. Tombstones and open sets stay untouched. */
  deleteOrphanRecords(records: readonly { readonly key: string; readonly raw: string }[]): boolean {
    if (!records.length) return true
    if (!this.storage) { this.notice = '本地存储不可用，孤立记录未清理。'; this.emit(); return false }
    try {
      for (const item of records) if (!(item.key.startsWith(PREPARATION_STORAGE_PREFIX) || item.key.startsWith(LEGACY_TOPIC_STORAGE_PREFIX)) ||
        this.storage.getItem(item.key) !== item.raw) { this.notice = '清理范围已变化，请刷新统计后重试。'; this.emit(); return false }
      for (const item of records) this.storage.removeItem(item.key)
    } catch { this.notice = '孤立记录未全部清理，请刷新统计后重试。'; this.emit(); return false }
    this.notice = undefined; this.emit(); return true
  }

  captureHistoryVersions(ids: readonly string[]): readonly HistoryVersion[] {
    return ids.flatMap(id => { const seat = this.seats.get(id); return seat ? [{ id, stored: seat.stored, legacyRaw: seat.legacyRaw, current: currentVersion(seat) }] : [] })
  }

  async deleteHistoryAsync(ids: readonly string[], deleteMemory = false, unreadable: readonly { readonly key: string; readonly raw: string }[] = [], expected?: readonly HistoryVersion[], companion?: HistoryDeleteCompanion): Promise<boolean> {
    if (this.historyBackend && !deleteMemory) return this.withStructureLock(false, async () => {
      const versions = expected ?? this.captureHistoryVersions(ids)
      for (const version of versions) { const seat = this.seats.get(version.id); if (!seat || currentVersion(seat) !== version.current || seat.stored !== version.stored || this.executionLeases.has(version.id)) { this.notice = '待删除会话已变化或仍在运行，请重新确认。'; this.emit(); return false } }
      if (companion && !companion.preflight()) return false
      try {
        for (const id of ids) if (!await this.ensureSessionHistory(id)) throw new Error('会话正文尚未读取，未删除。')
        for (const id of ids) { const seat = this.seats.get(id), topic = seat && this.topics.get(seat.session.topicId); if (topic?.durable) this.writeIdentity(topic) }
        const cleanup = { complete: true, removed: 0, retained: 0 }
        for (const id of ids) { const seat = this.seats.get(id); if (seat) {
          const result = await this.historyBackend!.retire(seat.session, seat.translationHistory, deletionOperationId('session'))
          if (result) { cleanup.complete &&= result.complete; cleanup.removed += result.removed; cleanup.retained += result.retained }
          seat.stored = null; seat.savedSession = undefined; seat.savedTranslationHistory = emptyTranslationHistory()
          if (!this.deleteHistoryLocked([id], false, [], undefined)) throw new Error('会话正文已删除，本地列表清理未完成，请重试。')
        } }
        const done = this.deleteHistoryLocked([], false, [], undefined, companion)
        if (done) { this.notice = `会话已删除；本次清理 ${cleanup.removed} 个文件${cleanup.retained ? ids.length === 1 ? `，共享保留 ${cleanup.retained} 个文件` : '，仍被使用的共享文件保留' : ''}。${cleanup.complete ? '' : '文件清理尚未全部确认，请在存储与空间重试回收；正文不会恢复。'}`; this.emit() }
        return done
      } catch (error) { this.notice = error instanceof Error ? error.message : '宿主会话删除未完成，请重试。'; this.emit(); return false }
    })
    if (deleteMemory) return this.deleteHistory(ids, true, unreadable, expected)
    const frozen = expected ?? this.captureHistoryVersions(ids)
    const requiresStorage = !!companion?.requiresStorage || unreadable.length > 0 || ids.some(id => {
      const seat = this.seats.get(id)
      return seat && (seat.stored !== null || seat.legacyRaw !== null || this.topics.get(seat.session.topicId)?.durable)
    })
    if (!requiresStorage) return this.deleteHistoryLocked(ids, false, unreadable, frozen, companion)
    return this.withStructureLock(false, () => {
      // 清理前保留身份与既有发号记录，避免编号重用。
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

  /** A session id still owns file jobs, intake records, object links and audits even when its history copy never decoded. */
  private removeSessionArtifacts(id: string): void {
    if (!this.storage) return
    const keys: string[] = []
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index)
      if (!key) continue
      if (key.startsWith(fileIntakeSessionPrefix(id)) || key.startsWith(fileJobsSessionPrefix(id)) || key === recordObjectsKey(id)) {
        keys.push(key); continue
      }
      if (!key.startsWith(PREPARATION_STORAGE_PREFIX)) continue
      try {
        const preparation = JSON.parse(this.storage.getItem(key) ?? 'null') as { scope?: { translationSessionId?: unknown } } | null
        if (preparation?.scope?.translationSessionId === id) keys.push(key)
      } catch { /* Keep unattributable audits; they cannot be matched safely. */ }
    }
    for (const key of keys) this.storage.removeItem(key)
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
          (this.historyRaw(seat.session.id) ?? null) !== version.stored ||
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
          if (!legacyKey) this.removeSessionArtifacts(id)
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
        const fileKeys: string[] = [], preparationKeys: string[] = []
        for (let index = 0; index < (this.storage?.length ?? 0); index++) {
          const fileKey = this.storage?.key(index)
          if (fileKey?.startsWith(fileIntakeSessionPrefix(seat.session.id)) || fileKey?.startsWith(fileJobsSessionPrefix(seat.session.id))) fileKeys.push(fileKey)
          if (fileKey?.startsWith(PREPARATION_STORAGE_PREFIX)) {
            try {
              const preparation = JSON.parse(this.storage!.getItem(fileKey) ?? 'null') as { scope?: { translationSessionId?: unknown } } | null
              if (preparation?.scope?.translationSessionId === seat.session.id) preparationKeys.push(fileKey)
            } catch { /* Keep unreadable preparation records; they cannot be attributed safely. */ }
          }
        }
        for (const fileKey of [...fileKeys, ...preparationKeys]) this.storage!.removeItem(fileKey)
        this.storage?.removeItem(recordObjectsKey(seat.session.id))
        seat.stored = null
        if (seat.session.legacyKey) { this.storage?.removeItem(seat.session.legacyKey); seat.legacyRaw = null }
        this.storage?.removeItem(sessionModelKey(seat.session.id))
        this.seats.delete(seat.session.id)
        this.migrationSources.delete(seat.session.id)
        // 打开集合可能被尚未在本实例渲染的主会话持有，按工作区、缓存与已存记录三处汇总归属。
        const openOwners = new Set<string>([...this.workspaces.keys(), ...this.sessionOrders.keys()])
        for (let index = 0; index < (this.storage?.length ?? 0); index++) {
          const key = this.storage!.key(index)
          if (key?.startsWith(SESSION_ORDER_PREFIX)) openOwners.add(key.slice(SESSION_ORDER_PREFIX.length))
        }
        for (const ownerId of openOwners) {
          const open = this.openSet(ownerId)
          if (!open.includes(seat.session.id)) continue
          const next = open.filter(id => id !== seat.session.id)
          orderSaved = this.writeOpenSet(ownerId, next) && orderSaved
          const workspace = this.workspaces.get(ownerId)
          if (workspace) { workspace.open = next; this.reconcileWorkspace(ownerId) }
        }
        removedSessions++
      }
      if (companion && !companion.afterHistoryDeleted()) {
        this.notice = '所选会话已删除，但主题术语未全部清理。请核对术语存储提示与剩余范围。'; this.emit(); return false
      }
      this.notice = orderSaved ? undefined : '会话已删除，但排序偏好清理未保存；当前列表已移除该会话。'; this.emit(); return true
    } catch { this.notice = `历史清理未完全完成：已移除 ${removedSessions} 条会话和 ${removedUnreadable} 份无法读取的副本；${currentRemoval}未完成。请核对剩余范围后重新确认。`; this.emit(); return false }
  }

  private externalChange(key: string | null): void {
    if (this.hostHistory && key && (key.startsWith(HISTORY_PREFIX) || key.startsWith(LEGACY_DRAFT_PREFIX))) return
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
      this.readSettings()
    }
    if (key === null || key?.startsWith(HISTORY_PREFIX) || key?.startsWith(LEGACY_DRAFT_PREFIX) ||
      key?.startsWith(TOPIC_IDENTITY_PREFIX) || key?.startsWith(TOPIC_NAME_PREFIX) || key?.startsWith(DELETED_SESSION_PREFIX)) {
      for (const seat of this.seats.values()) {
        if (key !== null && key !== historyKey(seat.session.id) && key !== seat.session.legacyKey && key !== deletedSessionKey(seat.session.id)) continue
        try {
          if (this.isDeleted(seat.session.id)) {
            seat.savedSession = undefined; seat.status = 'conflict'; this.notice = '会话已在其他窗口删除，当前草稿仅保留在本窗口，不能覆盖恢复。'; continue
          }
          const raw = this.historyRaw(seat.session.id) ?? null
          const legacyRaw = seat.session.legacyKey ? this.storage?.getItem(seat.session.legacyKey) ?? null : null
          if (legacyRaw !== seat.legacyRaw && raw === seat.stored) {
            if (legacyRaw === null && raw === null) seat.savedSession = undefined
            seat.status = 'conflict'; this.notice = '旧版草稿在其他窗口变化，当前输入保留。'; continue
          }
          if (raw !== seat.stored) {
            const snapshot = raw === null ? undefined : readSnapshot(raw), latest = snapshot?.session
            if (seat.status === 'saved' && latest && latest.id === seat.session.id && this.matchesHistoryIdentity(latest, seat.session)) {
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

export function createSessionStore(hostHistory = false): SessionStore {
  const storage = browserPluginStorage()
  return new SessionStore(storage, onChange => {
    const listener = (event: StorageEvent): void => { if (isPluginStorageEvent(event, storage)) onChange(event.key) }
    window.addEventListener('storage', listener)
    return () => window.removeEventListener('storage', listener)
  }, browserLocks(), hostHistory)
}
