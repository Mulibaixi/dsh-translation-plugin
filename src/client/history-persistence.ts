import { HistorySessionTransport, type HistoryTransferReceipt } from './history-transport.js'
import { encodeHistoryBundle, parseHistoryBundle, type HistoryBundle, type HistoryScope } from '../shared/history-bundle.js'
import type { HistoryRemoteClientPort, HistoryMutation } from '../shared/history-remote.js'
import type { LocalSession } from './sessions.js'
import type { TranslationHistory } from './translation-history.js'
import { fileJobsSessionPrefix } from '../shared/file-job-record.js'

export type HistoryRecordKind = 'fileJobs' | 'intakes' | 'preparations'
export interface HistoryRecordRegistration {
  current(): readonly string[]
  restore(records: readonly string[]): void
}
export interface SessionHistoryBackend {
  snapshot(id: string): string | null
  save(session: LocalSession, history: TranslationHistory): Promise<HistoryTransferReceipt>
  mutate(session: LocalSession, history: TranslationHistory, command: HistoryMutation['command'], operationId: string): Promise<HistoryTransferReceipt>
  retire(session: LocalSession, history: TranslationHistory, operationId: string): Promise<import('../shared/history-cleanup.js').HistoryCleanupResult | undefined>
  reload(session: LocalSession): Promise<HistoryTransferReceipt>
  search(session: LocalSession, unitId: string, side: 'source' | 'translation', query: string, start: number, signal: AbortSignal): Promise<import('../shared/history-remote.js').HistoryTextMatches>
  register(kind: HistoryRecordKind, port: HistoryRecordRegistration): void
  recordStorage(kind: HistoryRecordKind): { keys(): readonly string[]; getItem(key: string): string | null; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> }
}
export interface HistoryClientSessions {
  getNamespaceId(): string
  getSession(id: string): LocalSession | undefined
  getTranslationHistory(id: string): TranslationHistory | undefined
  restoreHostHistory(receipts: readonly HistoryTransferReceipt[]): void
  restoreHostDirectory(entries: import('../shared/history-remote.js').HistoryListing['sessions']): void
  confirmHostHistory(receipt: HistoryTransferReceipt): void
  setHistoryReady(ready: boolean, error?: string): void
}
const recordKey = (kind: HistoryRecordKind, record: any): string => kind === 'fileJobs'
  ? `${fileJobsSessionPrefix(record.summary.translationSessionId)}${encodeURIComponent(record.summary.jobId)}`
  : kind === 'intakes' ? `dsh-translation-plugin:file-intake:v1:${encodeURIComponent(record.scope.translationSessionId)}:${encodeURIComponent(record.materialId)}`
  : `dsh-translation-plugin:preparation:v1:${encodeURIComponent(record.versions[0].scope.ownerId)}:${encodeURIComponent(record.versions[0].id)}`
const recordSession = (kind: HistoryRecordKind, record: any): string => kind === 'fileJobs' ? record.summary.translationSessionId : kind === 'intakes' ? record.scope.translationSessionId : record.versions[0].scope.translationSessionId

/** Browser stores retain metadata only. Confirmed bodies and versions live in the Host. */
export class HistoryPersistenceClient implements SessionHistoryBackend {
  private readonly transport: HistorySessionTransport
  private readonly seats = new Map<string, HistoryTransferReceipt>()
  private readonly records = new Map<HistoryRecordKind, HistoryRecordRegistration>()
  private disposed = false
  private loading: Promise<void> | undefined
  constructor(private readonly sessions: HistoryClientSessions, remote: () => Promise<HistoryRemoteClientPort | undefined>) {
    // The SessionStore already owns the shared write lock; the transport does not reacquire it.
    this.transport = new HistorySessionTransport(remote, action => action())
  }
  register(kind: HistoryRecordKind, port: HistoryRecordRegistration): void { this.records.set(kind, port) }
  start(): Promise<void> {
    if (this.loading) return this.loading
    this.sessions.setHistoryReady(false)
    const work = (async () => {
      const entries: import('../shared/history-remote.js').HistoryListing['sessions'][number][] = []
      let after: string | undefined
      do {
        const page = await this.transport.list({ namespaceId: this.sessions.getNamespaceId(), ...(after ? { after } : {}) })
        entries.push(...page.sessions)
        after = page.next ?? undefined
      } while (after)
      this.check()
      this.sessions.restoreHostDirectory(entries)
      this.sessions.setHistoryReady(true)
    })().catch(error => {
      if (!this.disposed) this.sessions.setHistoryReady(false, error instanceof Error ? error.message : '会话历史读取失败，请重试。')
    }).finally(() => { if (this.loading === work) this.loading = undefined })
    this.loading = work; return work
  }
  private check(): void { if (this.disposed) throw new Error('会话历史连接已关闭。') }
  snapshot(id: string): string | null {
    const saved = this.seats.get(id)?.saved
    return saved ? JSON.stringify({ schemaVersion: 14, token: 'host-saved', session: saved.session, translationHistory: saved.history }) : null
  }
  private scope(session: LocalSession): HistoryScope { return { namespaceId: this.sessions.getNamespaceId(), topicId: session.topicId, sessionId: session.id } }
  private bundle(session: LocalSession, history: TranslationHistory, override?: { kind: HistoryRecordKind; key: string; value: string }): HistoryBundle {
    const records = (kind: HistoryRecordKind): unknown[] => {
      const values = (this.records.get(kind)?.current() ?? []).map(raw => JSON.parse(raw)).filter(record => recordSession(kind, record) === session.id)
      if (override?.kind === kind) { const index = values.findIndex(record => recordKey(kind, record) === override.key); const value = JSON.parse(override.value); if (index < 0) values.push(value); else values[index] = value }
      return values
    }
    return parseHistoryBundle({ schemaVersion: 1, session, history, fileJobs: records('fileJobs'), intakes: records('intakes'), preparations: records('preparations') }, this.scope(session))
  }
  private async commit(session: LocalSession, history: TranslationHistory, override?: { kind: HistoryRecordKind; key: string; value: string }): Promise<HistoryTransferReceipt> {
    this.check()
    const scope = this.scope(session), before = this.seats.get(session.id), snapshot = structuredClone(this.bundle(session, history, override))
    const current = (): HistoryBundle => {
      this.check()
      const liveSession = this.sessions.getSession(session.id), liveHistory = this.sessions.getTranslationHistory(session.id)
      if (!liveSession || !liveHistory) throw new Error('会话已关闭或删除，未保存迟到正文。')
      // Upload one admitted snapshot. Later stream events stay in SessionStore and
      // its existing dirty-save queue follows this receipt with the newer state.
      // Removal still invalidates the transfer; Host tokens fence other writers.
      return snapshot
    }
    const encoded = encodeHistoryBundle(snapshot)
    if (encodeHistoryBundle(current()) !== encoded) throw new Error('会话在保存前变化，请重试保存。')
    if (before?.current && encodeHistoryBundle(before.current) === encoded && before.state.persistence === 'saved') return before
    const receipt = before?.state.switched
      ? await this.transport.replace(scope, before.state, current, before)
      : await this.transport.create(scope, current)
    this.check(); this.seats.set(session.id, receipt); this.sessions.confirmHostHistory(receipt); return receipt
  }
  save(session: LocalSession, history: TranslationHistory): Promise<HistoryTransferReceipt> { return this.commit(session, history) }
  async mutate(session: LocalSession, history: TranslationHistory, command: HistoryMutation['command'], operationId: string): Promise<HistoryTransferReceipt> {
    await this.commit(session, history)
    const state = this.seats.get(session.id)!.state
    const result = await this.transport.mutate({ ...this.scope(session), token: state.token!, command, operationId })
    if (result.status !== 'updated') throw new Error(result.reason ?? '会话已变化，请重新读取后删除。')
    const receipt = { ...await this.transport.load(this.scope(session)), ...(result.resourceCleanup ? { resourceCleanup: result.resourceCleanup } : {}) }; this.check(); this.seats.set(session.id, receipt)
    this.restoreRecords(session.id)
    return receipt
  }
  async reload(session: LocalSession): Promise<HistoryTransferReceipt> {
    const receipt = await this.transport.load(this.scope(session)); this.check(); this.seats.set(session.id, receipt)
    this.restoreRecords(session.id); return receipt
  }
  async search(session: LocalSession, unitId: string, side: 'source' | 'translation', query: string, start: number, signal: AbortSignal): Promise<import('../shared/history-remote.js').HistoryTextMatches> {
    const seat = this.seats.get(session.id), token = seat?.state.token, history = this.sessions.getTranslationHistory(session.id)
    if (!token || !seat.current || !history) throw new Error('请先读取此会话。')
    const local = this.bundle(session, history)
    if (encodeHistoryBundle({ ...seat.current, history: local.history, fileJobs: local.fileJobs }) !== encodeHistoryBundle(seat.current)) throw new Error('当前正文尚未同步到宿主，请重试保存后查找。')
    return this.transport.searchCurrent({ ...this.scope(session), token, unitId, side, query, start }, signal)
  }
  private restoreRecords(sessionId: string): void {
    for (const [kind, port] of this.records) port.restore([
      ...port.current().filter(raw => recordSession(kind, JSON.parse(raw)) !== sessionId),
      ...(this.seats.get(sessionId)?.current?.[kind].map(record => JSON.stringify(record)) ?? []),
    ])
  }
  async retire(session: LocalSession, history: TranslationHistory, operationId: string): Promise<import('../shared/history-cleanup.js').HistoryCleanupResult | undefined> {
    let cleanup: import('../shared/history-cleanup.js').HistoryCleanupResult | undefined
    try {
      await this.commit(session, history)
      const result = await this.transport.retire({ ...this.scope(session), token: this.seats.get(session.id)!.state.token!, operationId })
      if (result.status !== 'updated') throw new Error(result.reason ?? '会话已变化，未删除。')
      cleanup = result.resourceCleanup
    } catch (error) {
      const receipt = await this.transport.load(this.scope(session))
      if (!receipt.state.retired) throw error
      try { cleanup = (await this.transport.retire({ ...this.scope(session), token: receipt.state.token!, operationId })).resourceCleanup }
      catch { cleanup = { complete: false, removed: 0, retained: 0 } }
    }
    this.check(); this.seats.delete(session.id); this.restoreRecords(session.id)
    return cleanup
  }
  recordStorage(kind: HistoryRecordKind): ReturnType<SessionHistoryBackend['recordStorage']> {
    const saved = (): Map<string, string> => new Map([...this.seats.values()].flatMap(seat => seat.saved ? seat.saved[kind].map(record => [recordKey(kind, record), JSON.stringify(record)] as const) : []))
    return {
      keys: () => [...saved().keys()], getItem: key => saved().get(key) ?? null,
      setItem: async (key, value) => {
        const record = JSON.parse(value), id = recordSession(kind, record), session = this.sessions.getSession(id), history = this.sessions.getTranslationHistory(id)
        if (!session || !history || recordKey(kind, record) !== key) throw new Error('从属记录缺少准确的所属会话。')
        await this.commit(session, history, { kind, key, value })
      },
      removeItem: async () => { throw new Error('请通过宿主单元或会话删除入口释放从属记录。') },
    }
  }
  dispose(): void { this.disposed = true; this.transport.dispose(); this.seats.clear(); this.records.clear() }
}
