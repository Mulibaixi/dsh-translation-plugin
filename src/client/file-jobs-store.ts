import type { FileIntakeStoreOptions } from './file-intake-store.js'
import { FILE_JOBS_STORAGE_PREFIX, fileJobsSessionPrefix, parseFileJobRecord as parse, type FileJobRecord } from '../shared/file-job-record.js'
export * from '../shared/file-job-record.js'
interface Seat { record: FileJobRecord; stored: string | null; error?: string; conflict?: boolean }
const key = (record: FileJobRecord): string => `${fileJobsSessionPrefix(record.summary.translationSessionId)}${encodeURIComponent(record.summary.jobId)}`

/** Fixed source/results and browser decisions share the history switch and structure lock. */
export class FileJobsStore {
  private readonly seats = new Map<string, Seat>()
  private readonly writes = new Map<string, Promise<boolean>>()
  private disposed = false
  constructor(private readonly options: FileIntakeStoreOptions, private readonly changed: () => void) {
    for (const storageKey of options.storage?.keys() ?? []) {
      if (!storageKey.startsWith(FILE_JOBS_STORAGE_PREFIX)) continue
      try {
        const raw = options.storage!.getItem(storageKey)
        if (!raw) continue
        const record = parse(raw)
        if (key(record) !== storageKey || !options.isScopeCurrent(record.summary)) continue
        this.seats.set(record.summary.jobId, { record, stored: raw })
      } catch { /* Preserve unreadable storage for explicit local-data cleanup. */ }
    }
    options.registerHistory?.(() => [...this.seats.values()].map(seat => JSON.stringify(seat.record)), records => {
      this.seats.clear()
      for (const raw of records) { const record = parse(raw); this.seats.set(record.summary.jobId, { record, stored: options.storage?.getItem(key(record)) ?? null }) }
      this.changed()
    })
  }
  get(jobId: string): FileJobRecord | undefined { return this.seats.get(jobId)?.record }
  all(): readonly FileJobRecord[] { return [...this.seats.values()].map(value => value.record).filter(value => this.options.isScopeCurrent(value.summary)) }
  status(jobId: string): { readonly saved: boolean; readonly error?: string } {
    const seat = this.seats.get(jobId)
    return { saved: !seat?.error && !!seat?.stored && seat.stored === JSON.stringify(seat.record), ...(seat?.error ? { error: seat.error } : {}) }
  }
  put(record: FileJobRecord): void {
    if (this.disposed || !this.options.isScopeCurrent(record.summary)) return
    const seat = this.seats.get(record.summary.jobId)
    if (seat?.conflict) return
    if (seat) seat.record = record
    else this.seats.set(record.summary.jobId, { record, stored: null })
    this.changed(); void this.persist(record.summary.jobId)
  }
  async persist(jobId: string): Promise<boolean> {
    if (this.writes.has(jobId)) { await this.writes.get(jobId); return this.persist(jobId) }
    const seat = this.seats.get(jobId)
    if (this.disposed || !seat || seat.conflict) return false
    if (!this.options.isEnabled()) return true
    if (this.options.storage?.getItem(key(seat.record)) === JSON.stringify(seat.record)) { seat.stored = JSON.stringify(seat.record); delete seat.error; return true }
    if (seat.stored === JSON.stringify(seat.record)) return true
    const write = (async (): Promise<boolean> => {
      try {
        if (!await this.options.saveSession(seat.record.summary.translationSessionId)) throw new Error('所属会话尚未保存。')
        return await this.options.withLock(async () => {
          if (this.disposed || !this.options.isEnabled() || !this.options.isScopeCurrent(seat.record.summary)) return false
          const storage = this.options.storage
          if (!storage) throw new Error('文件任务存储不可用；内容仍保留在本次运行。')
          if (storage.getItem(key(seat.record)) !== seat.stored) { seat.conflict = true; throw new Error('文件任务历史已在其他窗口修改或清理，当前副本未覆盖。') }
          const serialized = JSON.stringify(seat.record)
          await storage.setItem(key(seat.record), serialized)
          seat.stored = serialized; delete seat.error
          return true
        })
      } catch (cause) { seat.error = cause instanceof Error ? cause.message : '文件任务保存失败；内容仍保留。'; return false }
    })().finally(() => { this.writes.delete(jobId); this.changed() })
    this.writes.set(jobId, write)
    return write
  }
  reconcile(): void {
    for (const [jobId, seat] of this.seats) {
      if (!this.options.isScopeCurrent(seat.record.summary)) { this.seats.delete(jobId); continue }
      try {
        if (this.options.storage?.getItem(key(seat.record)) === JSON.stringify(seat.record)) seat.stored = JSON.stringify(seat.record)
        if (seat.stored !== null && this.options.storage?.getItem(key(seat.record)) !== seat.stored) {
          seat.conflict = true; seat.error = '文件任务历史已在其他窗口修改或清理，请重新打开读取最新记录。'
        }
      } catch { seat.error = '文件任务历史暂时无法读取。' }
      if (!seat.conflict && !seat.error && this.options.isEnabled() && seat.stored !== JSON.stringify(seat.record)) void this.persist(jobId)
    }
  }
  blocked(jobId: string): string | undefined { const seat = this.seats.get(jobId); return seat?.conflict ? seat.error : undefined }
  /** A saved-result edit commits under the shared structure lock; failed writes never claim success. */
  async mutate(jobId: string, update: (record: FileJobRecord) => FileJobRecord): Promise<FileJobRecord> {
    await this.writes.get(jobId)
    return this.options.withLock(async () => {
      const seat = this.seats.get(jobId)
      if (this.disposed || !seat || seat.conflict || !this.options.isScopeCurrent(seat.record.summary)) throw new Error('文件历史范围已变化，未修改译文。')
      const storage = this.options.storage, enabled = this.options.isEnabled()
      if (enabled && (!storage || storage.getItem(key(seat.record)) !== seat.stored)) throw new Error('文件历史已在其他窗口变化，未覆盖。')
      const record = update(structuredClone(seat.record)), serialized = JSON.stringify(record)
      if (enabled && serialized !== seat.stored) {
        try { await storage!.setItem(key(record), serialized) } catch (cause) { if (storage!.getItem(key(record)) !== serialized) throw cause }
        if (storage!.getItem(key(record)) !== serialized) throw new Error('文件修订保存尚未确认，未报告成功。')
      }
      seat.record = record; if (enabled) seat.stored = serialized
      delete seat.error; this.changed(); return record
    })
  }
  dispose(): void { this.disposed = true; this.seats.clear() }
}
