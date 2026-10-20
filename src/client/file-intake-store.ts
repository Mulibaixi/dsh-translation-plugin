import { parseTranslationSourceScope, parseSourceIdentity, type SourceIdentity, type TranslationSourceAsset, type TranslationSourceScope } from '../shared/translation-sources.js'
import { parseTranslationSourceReference, type TranslationSourceStoragePort, type TranslationSourceStoredRead } from '../shared/translation-source-storage.js'
import type { TranslationMaterialScope } from '../shared/translation-material.js'
import { decodeRoute, type ModelRoute } from './sessions.js'
import type { TranslationSourceHistoryCallbacks, TranslationSourceHistoryCommit, TranslationSourceStorageClient } from './source-storage-client.js'
import { storageSaveFailureMessage } from './storage-errors.js'

export const FILE_INTAKE_STORAGE_PREFIX = 'dsh-translation-plugin:file-intake:v1:'
export const fileIntakeSessionPrefix = (sessionId: string): string => `${FILE_INTAKE_STORAGE_PREFIX}${encodeURIComponent(sessionId)}:`
const key = (item: Pick<FileIntakeRecord, 'scope' | 'materialId'>): string => `${fileIntakeSessionPrefix(item.scope.translationSessionId)}${encodeURIComponent(item.materialId)}`
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
export interface FileIntakeConfig {
  readonly targetLanguage: string
  readonly instruction: string
  readonly model: ModelRoute | null
  readonly maxInputChars: number
  readonly draftVersion: number
}
export type FileIntakeStage = 'freezing' | 'frozen' | 'failed' | 'unknown' | 'accepted' | 'removed'
/** No File, original body, or subsequent composer draft is serialized here. */
export interface FileIntakeRecord {
  readonly schemaVersion: 1
  readonly scope: TranslationSourceScope
  readonly unitId: string
  readonly materialId: string
  readonly name: string
  readonly createdAt: string
  readonly config: FileIntakeConfig
  /** The main Session that actually submits this file. It differs from `scope` when the Session was opened from another main Session. */
  readonly submission: TranslationMaterialScope
  readonly stage: FileIntakeStage
  readonly hostStarted: boolean
  readonly message?: string
  readonly source?: SourceIdentity
  readonly historyCommit?: TranslationSourceHistoryCommit
  readonly documentUnitId?: string
}
export interface FileIntakeStoragePort {
  keys(): readonly string[]
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}
export interface FileIntakeStoreOptions {
  readonly storage?: FileIntakeStoragePort
  readonly withLock: <T>(action: () => T | Promise<T>) => Promise<T>
  readonly isEnabled: () => boolean
  readonly isScopeCurrent: (scope: Pick<TranslationSourceScope, 'topicId' | 'translationSessionId'>) => boolean
  readonly saveSession: (sessionId: string) => Promise<boolean>
}
interface Seat {
  record: FileIntakeRecord
  stored: string | null
  runtimeSource?: TranslationSourceAsset
  sourceConfirmed?: boolean
  /** Exact bytes are in the managed cache, independent of optional chat history. */
  sourceCached?: boolean
  storageError?: string
  conflict?: boolean
  pending?: Promise<void>
  dirty?: boolean
}
function parse(value: unknown): FileIntakeRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文件记录格式无法读取。')
  const item = value as FileIntakeRecord, scope = parseTranslationSourceScope(item.scope), config = item.config
  if (item.schemaVersion !== 1 || typeof item.materialId !== 'string' || !item.materialId.trim() || item.unitId !== `unit:${item.materialId}` ||
    typeof item.name !== 'string' || !item.name.trim() || item.name.length > 255 || !Number.isFinite(Date.parse(item.createdAt)) ||
    !['freezing', 'frozen', 'failed', 'unknown', 'accepted', 'removed'].includes(item.stage) || typeof item.hostStarted !== 'boolean' ||
    !config || typeof config.targetLanguage !== 'string' || typeof config.instruction !== 'string' || decodeRoute(config.model) === undefined ||
    !Number.isSafeInteger(config.maxInputChars) || config.maxInputChars < 1 || !Number.isSafeInteger(config.draftVersion) || config.draftVersion < 1 ||
    !item.submission || typeof item.submission.mainSessionId !== 'string' || !item.submission.mainSessionId.trim() ||
    typeof item.submission.requestId !== 'string' || !item.submission.requestId.trim() || typeof item.submission.operationId !== 'string' || !item.submission.operationId.trim() ||
    item.message !== undefined && typeof item.message !== 'string' || item.documentUnitId !== undefined && item.documentUnitId !== item.unitId) throw new Error('文件记录身份或配置无效。')
  const source = item.source ? parseSourceIdentity(item.source) : undefined
  let historyCommit: TranslationSourceHistoryCommit | undefined
  if (item.historyCommit) {
    const reference = parseTranslationSourceReference(item.historyCommit.reference)
    if (!source || !same(reference.scope, scope) || !same(reference.source, source) || reference.state !== 'prepared' ||
      typeof item.historyCommit.historyToken !== 'string' || !item.historyCommit.historyToken.trim() ||
      typeof item.historyCommit.confirmOperationId !== 'string' || !item.historyCommit.confirmOperationId.trim()) throw new Error('文件原稿保存引用无效。')
    historyCommit = { reference, historyToken: item.historyCommit.historyToken, confirmOperationId: item.historyCommit.confirmOperationId }
  }
  return { schemaVersion: 1, scope, unitId: item.unitId, materialId: item.materialId, name: item.name, createdAt: item.createdAt,
    config: { targetLanguage: config.targetLanguage, instruction: config.instruction, model: config.model, maxInputChars: config.maxInputChars, draftVersion: config.draftVersion },
    submission: {  mainSessionId: item.submission.mainSessionId, requestId: item.submission.requestId, operationId: item.submission.operationId },
    stage: item.stage, hostStarted: item.hostStarted, ...(item.message ? { message: item.message } : {}), ...(source ? { source } : {}),
    ...(historyCommit ? { historyCommit } : {}), ...(item.documentUnitId ? { documentUnitId: item.documentUnitId } : {}) }
}

/** A small, independently versioned history row exists before any document plan exists. */
export class FileIntakeStore {
  private readonly seats = new Map<string, Seat>()
  private readonly sourceJobs = new Map<string, Promise<void>>()
  private disposed = false
  constructor(private readonly options: FileIntakeStoreOptions, private readonly onChange: () => void) { this.load() }
  private load(): void {
    try {
      for (const storageKey of this.options.storage?.keys() ?? []) {
        const raw = this.options.storage!.getItem(storageKey)
        if (!raw) continue
        try {
          const saved = parse(JSON.parse(raw))
          if (storageKey !== key(saved) || !this.options.isScopeCurrent(saved.scope)) continue
          // A restart is not a negative receipt from the previous authority.
          const record: FileIntakeRecord = ['freezing', 'frozen'].includes(saved.stage)
            ? { ...saved, stage: saved.hostStarted ? 'unknown' : 'failed', message: saved.hostStarted
              ? '上次文件提交需先查询状态；原稿记录已保留。' : '上次原稿冻结未完成，请重试或重新选择文件。' } : saved
          this.seats.set(record.unitId, { record, stored: raw })
        } catch { /* Keep unreadable bytes intact; never infer an empty file from them. */ }
      }
    } catch { /* The caller still owns captured runtime files. A write reports the storage error. */ }
  }
  get(unitId: string): FileIntakeRecord | undefined { return this.seats.get(unitId)?.record }
  accessBlockedReason(unitId: string): string | undefined {
    const seat = this.seats.get(unitId)
    if (!seat) return undefined
    if (seat.record.stage === 'removed') return '此文件单元已移除；已有调用记录和主题记忆保留。'
    if (seat.conflict) return seat.storageError ?? '此文件历史副本已变化，请重新打开插件读取最新记录。'
    return undefined
  }
  hasPersisted(unitId: string): boolean { return this.seats.get(unitId)?.stored !== null && this.seats.has(unitId) }
  all(sessionId?: string): readonly FileIntakeRecord[] {
    return [...this.seats.values()].map(seat => seat.record).filter(item => item.stage !== 'removed' &&
      (sessionId === undefined || item.scope.translationSessionId === sessionId) && this.options.isScopeCurrent(item.scope))
  }
  storageState(unitId: string): { readonly storage: 'saved' | 'runtime_only'; readonly storagePending: boolean; readonly storageError?: string } {
    const seat = this.seats.get(unitId)
    let hasCommit = false
    try { hasCommit = !!seat?.record.historyCommit && !!this.readCommit(unitId) } catch { /* Unreadable storage cannot establish a durable original. */ }
    return { storage: seat && hasCommit && seat.sourceConfirmed && !seat.conflict ? 'saved' : 'runtime_only',
      storagePending: hasCommit && !seat?.sourceConfirmed,
      ...(seat?.storageError ? { storageError: seat.storageError } : {}) }
  }
  put(record: FileIntakeRecord): void {
    const fixed = parse(record), old = this.seats.get(fixed.unitId)
    if (old && same(old.record, fixed)) return
    if (old) old.record = fixed
    else this.seats.set(fixed.unitId, { record: fixed, stored: null })
    void this.persist(fixed.unitId); this.onChange()
  }
  setSource(unitId: string, source: TranslationSourceAsset): void {
    const seat = this.seats.get(unitId)
    if (!seat) return
    seat.runtimeSource = structuredClone(source)
    seat.sourceCached = false
    const { persistence: _persistence, ...identity } = source
    this.put({ ...seat.record, source: identity })
  }
  runtimeSource(unitId: string): TranslationSourceAsset | undefined { return this.seats.get(unitId)?.runtimeSource }
  /** Called on settings and external-storage notifications; CAS prevents resurrecting cleared rows. */
  reconcile(): void {
    for (const [unitId, seat] of this.seats) {
      if (!this.options.isScopeCurrent(seat.record.scope)) { this.seats.delete(unitId); continue }
      if (seat.stored !== null && this.options.storage) {
        try {
          const current = this.options.storage.getItem(key(seat.record))
          if (current !== seat.stored) {
            seat.conflict = true
            if (current) {
              try {
                const authoritative = parse(JSON.parse(current))
                if (authoritative.unitId === unitId && same(authoritative.scope, seat.record.scope) && authoritative.stage === 'removed') seat.record = authoritative
              } catch { /* An unreadable external change blocks access instead of restoring old authority. */ }
            }
            seat.storageError = current === null ? '此文件历史已在其他窗口清除；当前原稿仅保留在运行期。' : '文件历史已在其他窗口修改；当前副本未覆盖。'
          }
        } catch { seat.storageError = '文件历史读取失败；当前原稿仍保留在运行期。' }
      }
      if (this.options.isEnabled() && !seat.conflict && seat.stored !== JSON.stringify(seat.record)) void this.persist(unitId)
    }
  }
  async persist(unitId: string): Promise<void> {
    const seat = this.seats.get(unitId)
    if (!seat || this.disposed || !this.options.isEnabled() || seat.conflict) return
    if (seat.pending) { seat.dirty = true; return seat.pending }
    const work = (async (): Promise<void> => {
      try {
        if (!await this.options.saveSession(seat.record.scope.translationSessionId)) throw new Error('所属会话历史尚未可靠保存。')
        await this.options.withLock(() => this.write(seat))
      } catch (error) { seat.storageError = storageSaveFailureMessage(error, '文件记录', '文件记录未保存，原稿仍保留在当前运行期。') }
    })().finally(() => {
      delete seat.pending
      if (seat.dirty) { delete seat.dirty; if (!seat.storageError) void this.persist(unitId) }
      this.onChange()
    })
    seat.pending = work; return work
  }
  private write(seat: Seat, explicitRemoval = false): void {
    const storage = this.options.storage
    if (this.disposed || !explicitRemoval && !this.options.isEnabled() || !this.options.isScopeCurrent(seat.record.scope)) return
    if (!storage) throw new Error('本地文件历史存储不可用。')
    if (seat.conflict || storage.getItem(key(seat.record)) !== seat.stored) { seat.conflict = true; throw new Error('文件历史副本已修改或清除，未覆盖。') }
    const serialized = JSON.stringify(seat.record)
    storage.setItem(key(seat.record), serialized)
    if (storage.getItem(key(seat.record)) !== serialized) throw new Error('文件历史保存后读取不一致。')
    seat.stored = serialized; delete seat.storageError
  }
  callbacks(unitId: string): TranslationSourceHistoryCallbacks {
    const initial = this.seats.get(unitId)
    if (!initial) throw new Error('文件记录不存在。')
    return {
      isHistoryEnabled: () => !this.disposed && this.options.isEnabled() && this.options.isScopeCurrent(initial.record.scope),
      persistPreparedReference: async (reference, confirmOperationId) => {
        await this.persist(unitId)
        return this.options.withLock(() => {
          const seat = this.seats.get(unitId)
          if (!seat || !this.options.isEnabled() || !same(reference.scope, seat.record.scope) || !same(reference.source, seat.record.source)) throw new Error('原稿引用与文件记录不匹配。')
          const commit = seat.record.historyCommit ?? { reference, historyToken: `file-history:${crypto.randomUUID()}`, confirmOperationId }
          if (!same(commit.reference, reference) || commit.confirmOperationId !== confirmOperationId) throw new Error('原稿引用已有其他保存凭据。')
          seat.record = parse({ ...seat.record, historyCommit: commit }); this.write(seat)
          const saved = this.readCommit(unitId)
          if (!saved || !same(saved, commit)) throw new Error('文件原稿凭据未准确保存。')
          this.onChange(); return saved
        })
      },
      readPersistedReference: async request => {
        const seat = this.seats.get(unitId)
        if (!seat || !same(request.scope, seat.record.scope)) return null
        const commit = this.readCommit(unitId)
        return commit?.reference.referenceKey === request.referenceKey ? commit : null
      },
    }
  }
  private readCommit(unitId: string): TranslationSourceHistoryCommit | null {
    const seat = this.seats.get(unitId)
    if (!seat || !this.options.isScopeCurrent(seat.record.scope) || !this.options.storage || seat.conflict) return null
    const raw = this.options.storage.getItem(key(seat.record)), saved = raw ? parse(JSON.parse(raw)) : undefined
    if (!saved || !same(saved.scope, seat.record.scope) || !same(saved.source, seat.record.source) || !same(saved.historyCommit, seat.record.historyCommit)) return null
    return saved.historyCommit ? structuredClone(saved.historyCommit) : null
  }
  historyCommit(unitId: string): TranslationSourceHistoryCommit | undefined {
    try { return this.readCommit(unitId) ?? undefined }
    catch { return undefined } // Unreadable history cannot lend credentials to a new document admission.
  }
  async saveSource(unitId: string, client?: TranslationSourceStorageClient): Promise<void> {
    const seat = this.seats.get(unitId)
    if (!seat || !client || !seat.runtimeSource || seat.record.stage === 'removed' || seat.sourceConfirmed || seat.sourceCached) return
    const pending = this.sourceJobs.get(unitId)
    if (pending) return pending
    const work = (async (): Promise<void> => {
      const record = seat.record, prepare = { scope: record.scope, sourceRef: seat.runtimeSource!, referenceKey: `file-source:${record.materialId}:1`,
        operationId: `file-source-prepare:${record.materialId}` }
      // The exact original is cached even when optional chat history is off; only the history
      // confirmation depends on that setting.
      const outcome = record.historyCommit
        ? await client.confirmPersistedReference(record.historyCommit, this.callbacks(unitId))
        : this.options.isEnabled()
          ? await client.save({ prepare, confirmOperationId: `file-source-confirm:${record.materialId}` }, this.callbacks(unitId))
          : await client.cache({ prepare })
      seat.sourceCached = outcome.state === 'prepared' || outcome.state === 'confirmed'
      seat.sourceConfirmed = outcome.state === 'confirmed'
      if (!seat.sourceCached) seat.storageError = '原稿缓存尚未确认；当前运行期仍可读取。'
      else if (seat.stored === JSON.stringify(seat.record)) delete seat.storageError
    })().catch(error => { seat.storageError = storageSaveFailureMessage(error, '原稿缓存', '原稿缓存尚未确认；当前原稿保留。') })
      .finally(() => { this.sourceJobs.delete(unitId); this.onChange() })
    this.sourceJobs.set(unitId, work); return work
  }
  async resolveSource(unitId: string, storage?: TranslationSourceStoragePort): Promise<{ readonly scope: TranslationSourceScope; readonly sourceRef?: TranslationSourceAsset; readonly savedSource?: TranslationSourceStoredRead } | undefined> {
    const seat = this.seats.get(unitId)
    if (!seat || !this.options.isScopeCurrent(seat.record.scope)) return undefined
    const blocked = this.accessBlockedReason(unitId)
    if (blocked) throw new Error(blocked)
    const commit = this.readCommit(unitId)
    const savedSource = commit ? { scope: commit.reference.scope, referenceKey: commit.reference.referenceKey, source: commit.reference.source, historyToken: commit.historyToken } : undefined
    if (commit && storage && !seat.sourceConfirmed) {
      const result = await storage.queryReference({ scope: commit.reference.scope, referenceKey: commit.reference.referenceKey })
      if (!result.ok) throw new Error(result.error.message)
      const reference = result.value
      if (reference.state !== 'confirmed' || reference.historyToken !== commit.historyToken || reference.prepareToken !== commit.reference.prepareToken ||
        !same(reference.scope, commit.reference.scope) || !same(reference.source, commit.reference.source)) throw new Error('已保存原稿与历史凭据不一致。')
      if (this.seats.get(unitId) !== seat || !this.options.isScopeCurrent(seat.record.scope) || !same(this.readCommit(unitId), commit)) throw new Error('文件历史在查询期间已变化。')
      seat.sourceConfirmed = true; this.onChange()
    }
    return { scope: seat.record.scope, ...(seat.runtimeSource ? { sourceRef: seat.runtimeSource } : {}), ...(savedSource ? { savedSource } : {}) }
  }
  async remove(unitId: string): Promise<void> {
    const seat = this.seats.get(unitId)
    if (!seat) return
    await seat.pending
    await this.sourceJobs.get(unitId)
    await this.options.withLock(() => {
      const storage = this.options.storage
      if (seat.stored !== null) {
        if (!storage || storage.getItem(key(seat.record)) !== seat.stored) throw new Error('文件历史副本已变化，未移除。')
        storage.removeItem(key(seat.record))
        if (storage.getItem(key(seat.record)) !== null) throw new Error('文件记录删除尚未确认。')
      }
      this.seats.delete(unitId)
    })
    this.onChange()
  }
  /** An explicit removal updates only this old row even while new-history saving is off. */
  async markRemoved(record: FileIntakeRecord): Promise<void> {
    const old = this.seats.get(record.unitId)
    await old?.pending
    await this.sourceJobs.get(record.unitId)
    const seat = old ?? { record, stored: null }
    const removed = parse({ ...record, stage: 'removed', documentUnitId: record.unitId })
    await this.options.withLock(() => {
      const previous = seat.record
      // A persisted document needs its removal barrier even if this row did not exist yet.
      // The caller passes only the selected unit's fixed facts, never an editable session draft.
      try {
        seat.record = removed
        this.write(seat, true)
        this.seats.set(record.unitId, seat)
      } catch (error) { seat.record = previous; throw error }
    })
    this.onChange()
  }
  dispose(): void { this.disposed = true; this.seats.clear(); this.sourceJobs.clear() }
}
