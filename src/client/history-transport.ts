import { readLegacySessionSnapshot, parseHistoryBundle, encodeHistoryBundle, persistableHistoryBundle, historyUnsettled, type HistoryBundle, type HistoryScope } from '../shared/history-bundle.js'
import { historyKey } from '../shared/sessions.js'
import { diffHistoryBundle } from '../shared/history-patch.js'
import { fileJobsSessionPrefix, parseFileJobRecord } from '../shared/file-job-record.js'
import { parseFileIntakeRecord } from '../shared/file-intake-record.js'
import { parsePreparationRecord } from '../shared/preparation-record.js'
import { HISTORY_TRANSFER_POINTS, HISTORY_BUNDLE_BYTES, parseHistoryResult, type HistoryRemoteClientPort, type HistoryRemotePort, type HistoryStatus, type HistoryMutation, type CurrentHistoryRead, type HistoryCurrentPage, type HistoryList, type HistoryListing } from '../shared/history-remote.js'

export interface HistoryLegacyStorage { readonly length: number; key(index: number): string | null; getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export interface LegacyHistoryCopy { readonly key: string; readonly value: string }
export interface LegacyHistoryCapture { readonly saved: HistoryBundle | null; readonly copies: readonly LegacyHistoryCopy[] }
function decodeLegacy<T>(read: () => T, kind: string): T { try { return read() } catch { throw new Error(`此会话的旧${kind}格式无效，原副本保留。`) } }
/** Only this session's known records are captured. Corrupt unrelated preparations remain untouched. */
export function captureLegacyHistory(storage: HistoryLegacyStorage, scope: HistoryScope): LegacyHistoryCapture {
  const raw = storage.getItem(historyKey(scope.sessionId)), head = raw === null ? undefined : readLegacySessionSnapshot(raw)
  if (raw !== null && !head) throw new Error('此会话的旧历史无法完整读取，原副本保留。')
  if (!head) {
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index); if (!key) continue
      if (key.startsWith(fileJobsSessionPrefix(scope.sessionId)) || key.startsWith(`dsh-translation-plugin:file-intake:v1:${encodeURIComponent(scope.sessionId)}:`)) throw new Error('旧会话正文缺失但从属文件记录仍在，暂不迁移。')
      if (key.startsWith('dsh-translation-plugin:preparation:v1:')) {
        let belongs = false
        try { const raw = storage.getItem(key); belongs = raw !== null && parsePreparationRecord(raw).versions[0]!.scope.translationSessionId === scope.sessionId } catch { /* Unrelated unreadable audits stay available for manual cleanup. */ }
        if (belongs) throw new Error('旧会话正文缺失但从属准备记录仍在，暂不迁移。')
      }
    }
    return { saved: null, copies: [] }
  }
  if (head.session.id !== scope.sessionId || head.session.topicId !== scope.topicId) throw new Error('旧会话的主题身份尚未完成整理，暂不迁移。')
  const copies: LegacyHistoryCopy[] = [{ key: historyKey(scope.sessionId), value: raw! }], fileJobs: HistoryBundle['fileJobs'][number][] = [], intakes: HistoryBundle['intakes'][number][] = [], preparations: HistoryBundle['preparations'][number][] = []
  const prepIds = new Set(head.translationHistory.units.flatMap(unit => 'kind' in unit && unit.kind === 'document' ? unit.preparations.map(ref => ref.id) : []))
  const keys: string[] = []; for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key) keys.push(key) }
  for (const key of keys) {
    const value = storage.getItem(key); if (value === null) continue
    if (key.startsWith(fileJobsSessionPrefix(scope.sessionId))) {
      const record = decodeLegacy(() => parseFileJobRecord(value), '文件正文')
      if (record.summary.translationSessionId !== scope.sessionId || record.summary.topicId !== scope.topicId || key !== `${fileJobsSessionPrefix(scope.sessionId)}${encodeURIComponent(record.summary.jobId)}`) throw new Error('文件正文身份不一致，暂不迁移。')
      fileJobs.push(record); copies.push({ key, value })
    } else if (key.startsWith(`dsh-translation-plugin:file-intake:v1:${encodeURIComponent(scope.sessionId)}:`)) {
      const record = decodeLegacy(() => parseFileIntakeRecord(JSON.parse(value)), '文件受理记录'); if (record.scope.translationSessionId !== scope.sessionId || record.scope.topicId !== scope.topicId || key !== `dsh-translation-plugin:file-intake:v1:${encodeURIComponent(scope.sessionId)}:${encodeURIComponent(record.materialId)}`) throw new Error('文件受理记录身份不一致，暂不迁移。')
      intakes.push(record); copies.push({ key, value })
    } else if (key.startsWith('dsh-translation-plugin:preparation:v1:')) {
      let record
      try { record = parsePreparationRecord(value) } catch {
        if ([...prepIds].some(id => key.endsWith(`:${encodeURIComponent(id)}`))) throw new Error('此会话引用的准备正文无法读取，暂不迁移。')
        continue
      }
      if (record.versions[0]!.scope.translationSessionId === scope.sessionId) { preparations.push(record); copies.push({ key, value }) }
    }
  }
  return { saved: parseHistoryBundle({ schemaVersion: 1, session: head.session, history: head.translationHistory, fileJobs, intakes, preparations }, scope, 'saved'), copies }
}
function unwrap<K extends keyof HistoryRemotePort>(method: K, raw: unknown): Awaited<ReturnType<HistoryRemotePort[K]>> {
  const result = raw as { ok?: boolean; value?: unknown; error?: { message?: string } }
  if (result?.ok !== true) throw new Error(result?.error?.message ?? '宿主会话历史通道尚未就绪。')
  return parseHistoryResult(method, result.value)
}
export interface HistoryTransferReceipt { readonly state: HistoryStatus; readonly current: HistoryBundle | null; readonly saved: HistoryBundle | null; readonly cleanupPending: boolean; readonly resourceCleanup?: import('../shared/history-cleanup.js').HistoryCleanupResult }
const cleanupKey = (scope: HistoryScope): string => `dsh-translation-plugin:history-cleanup:v1:${encodeURIComponent(scope.namespaceId)}:${encodeURIComponent(scope.sessionId)}`
const digest = async (value: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
/** The application binds this transport only after all dependent stores can switch together. */
export class HistorySessionTransport {
  private disposed = false
  private epoch = 0
  private tail: Promise<unknown> = Promise.resolve()
  private readonly active = new Set<{ readonly remote: HistoryRemoteClientPort; readonly scope: HistoryScope; readonly transferId: string }>()
  constructor(private readonly remote: () => Promise<HistoryRemoteClientPort | undefined>, private readonly withLock: <T>(action: () => Promise<T>) => Promise<T>, private readonly legacy?: HistoryLegacyStorage) {}
  private check(epoch: number): void { if (this.disposed || this.epoch !== epoch) throw new Error('会话历史迁移连接已关闭，迟到写入已停止。') }
  private serial<T>(run: (epoch: number) => Promise<T>): Promise<T> {
    const epoch = this.epoch, next = this.tail.then(() => { this.check(epoch); return run(epoch) }); this.tail = next.catch(() => {}); return next.then(value => { this.check(epoch); return value })
  }
  private async port(epoch: number): Promise<HistoryRemoteClientPort> { const remote = await this.remote(); this.check(epoch); if (!remote) throw new Error('宿主会话历史通道尚未就绪。'); return remote }
  private async read(remote: HistoryRemoteClientPort, scope: HistoryScope, state: HistoryStatus, layer: 'current' | 'saved', epoch: number): Promise<HistoryBundle | null> {
    if (state.retired || !state.switched || layer === 'saved' && !state.hasSaved) return null
    let text = '', offset = 0, bytes = 0
    while (true) {
      this.check(epoch)
      const page = unwrap('read', await remote.read({ ...scope, token: state.token!, layer, offset })); this.check(epoch)
      bytes += new TextEncoder().encode(page.text).length; if (bytes > HISTORY_BUNDLE_BYTES) throw new Error('宿主历史回读超过 32 MiB，未切换客户端。')
      text += page.text
      if (page.next === null) break
      const next = offset + Array.from(page.text).length
      if (page.next !== next || next <= offset) throw new Error('宿主历史分页不连续，未切换客户端。')
      offset = next
    }
    try { return parseHistoryBundle(JSON.parse(text), scope, layer) } catch { throw new Error('宿主会话正文格式或从属关系无法核验，请重新读取宿主；不得恢复旧端。') }
  }
  private async receipt(remote: HistoryRemoteClientPort, scope: HistoryScope, state: HistoryStatus, epoch: number): Promise<HistoryTransferReceipt> {
    const current = await this.read(remote, scope, state, 'current', epoch)
    return { state, current, saved: state.persistence === 'saved' ? current : await this.read(remote, scope, state, 'saved', epoch), cleanupPending: false }
  }
  load(scope: HistoryScope): Promise<HistoryTransferReceipt> {
    return this.serial(async epoch => { const remote = await this.port(epoch), state = unwrap('status', await remote.status(scope)); this.check(epoch); return this.receipt(remote, scope, state, epoch) })
  }
  list(request: HistoryList): Promise<HistoryListing> { return this.serial(async epoch => { const remote = await this.port(epoch), result = unwrap('list', await remote.list(request)); this.check(epoch); return result }) }
  private async send(remote: HistoryRemoteClientPort, scope: HistoryScope, current: HistoryBundle, saved: HistoryBundle | null, expectedToken: string | null, rememberHistory: boolean, isCurrent: () => boolean, epoch: number, create = false, before?: HistoryTransferReceipt): Promise<HistoryTransferReceipt> {
    const currentText = encodeHistoryBundle(current), savedText = saved === null ? null : encodeHistoryBundle(saved)
    const upload = before?.current ? JSON.stringify(diffHistoryBundle(before.current, current)) : currentText
    for (const text of [currentText, savedText]) if (text !== null && new TextEncoder().encode(text).length > HISTORY_BUNDLE_BYTES) throw new Error('完整会话批次超过 32 MiB，旧副本保留。')
    this.check(epoch)
    const opened = unwrap('begin', await remote.begin({ ...scope, purpose: before?.current ? 'patch' : create ? 'create' : expectedToken === null ? 'migrate' : 'replace', expectedToken, currentPoints: Array.from(upload).length, savedPoints: savedText === null ? null : Array.from(savedText).length, rememberHistory }))
    const active = { remote, scope, transferId: opened.transferId }; this.active.add(active)
    try {
      this.check(epoch)
      for (const [layer, text] of [['current', upload], ['saved', savedText]] as const) if (text !== null) {
        const points = Array.from(text)
        for (let offset = 0; offset < points.length; offset += HISTORY_TRANSFER_POINTS) {
          this.check(epoch); if (!isCurrent()) throw new Error('会话在迁移期间已变化，暂存未提交。')
          const part = points.slice(offset, offset + HISTORY_TRANSFER_POINTS).join(''), result = unwrap('part', await remote.part({ ...scope, transferId: opened.transferId, layer, offset, text: part })); this.check(epoch)
          if (result.next !== offset + Array.from(part).length) throw new Error('历史上传回执不连续，暂存未提交。')
        }
      }
      if (!isCurrent()) throw new Error('会话在提交前已变化，旧副本保留。')
      this.check(epoch)
      let state: HistoryStatus, acknowledged = true
      try { state = unwrap('commit', await remote.commit({ ...scope, transferId: opened.transferId })) }
      catch (error) {
        acknowledged = false
        this.check(epoch); state = unwrap('status', await remote.status(scope))
        if (!state.switched || state.retired || expectedToken !== null && state.token === expectedToken) throw error
      }
      this.check(epoch)
      if (acknowledged && before) {
        const confirmed = parseHistoryBundle(JSON.parse(currentText), scope, rememberHistory ? 'saved' : 'current')
        return { state, current: confirmed, saved: rememberHistory ? confirmed : before.saved, cleanupPending: false }
      }
      const receipt = await this.receipt(remote, scope, state, epoch)
      if (!receipt.current || encodeHistoryBundle(receipt.current) !== currentText || !create && expectedToken === null && (receipt.saved === null ? null : encodeHistoryBundle(receipt.saved)) !== savedText || (create || expectedToken !== null) && rememberHistory && (!receipt.saved || encodeHistoryBundle(receipt.saved) !== currentText))
        throw new Error('宿主已接管此会话，但完整正文回读核对未完成；不得恢复旧端，请重新读取宿主状态。')
      return receipt
    } finally { this.active.delete(active); try { await remote.cancel({ ...scope, transferId: opened.transferId }) } catch { /* The Host also releases staging on library disconnect. */ } }
  }
  migrate(scope: HistoryScope, current: () => HistoryBundle): Promise<HistoryTransferReceipt> {
    return this.serial(epoch => this.withLock(async () => {
      const remote = await this.port(epoch), state = unwrap('status', await remote.status(scope)); this.check(epoch)
      if (state.switched) {
        const loaded = await this.receipt(remote, scope, state, epoch)
        let cleanupPending = false
        if (this.legacy) {
          try {
            if (this.legacy.getItem(cleanupKey(scope)) !== null) cleanupPending = !await this.cleanup(scope, undefined, epoch)
            else { const capture = captureLegacyHistory(this.legacy, scope); if (capture.saved && loaded.saved && encodeHistoryBundle(capture.saved) === encodeHistoryBundle(loaded.saved)) cleanupPending = !await this.cleanup(scope, capture.copies, epoch); else cleanupPending = capture.copies.length > 0 }
          } catch { cleanupPending = true }
        }
        return { ...loaded, cleanupPending }
      }
      const captured = this.legacy ? captureLegacyHistory(this.legacy, scope) : { saved: null, copies: [] }, candidate = parseHistoryBundle(current(), scope)
      if (candidate.session.legacyKey && this.legacy?.getItem(candidate.session.legacyKey) != null) throw new Error('此会话仍关联旧版草稿，需先完成旧格式整理后再迁移；原副本保留。')
      if (historyUnsettled(candidate) || captured.saved && historyUnsettled(captured.saved)) throw new Error('会话仍有未结算任务，暂不迁移。')
      const encoded = encodeHistoryBundle(candidate), unchanged = (): boolean => {
        if (this.disposed || this.epoch !== epoch || encodeHistoryBundle(parseHistoryBundle(current(), scope)) !== encoded) return false
        return captured.copies.every(copy => this.legacy?.getItem(copy.key) === copy.value)
      }
      const receipt = await this.send(remote, scope, candidate, captured.saved, null, false, unchanged, epoch)
      this.check(epoch)
      let cleanupPending: boolean
      try { cleanupPending = !await this.cleanup(scope, captured.copies, epoch) } catch { cleanupPending = true }
      return { ...receipt, cleanupPending }
    }))
  }
  private async cleanup(scope: HistoryScope, copies: readonly LegacyHistoryCopy[] | undefined, epoch: number): Promise<boolean> {
    if (!this.legacy) return true
    const marker = cleanupKey(scope)
    let encoded = this.legacy.getItem(marker)
    if (encoded === null) {
      if (!copies?.length) return true
      const records = await Promise.all(copies.map(async copy => ({ key: copy.key, sha256: await digest(copy.value) })))
      this.check(epoch); encoded = JSON.stringify({ schemaVersion: 1, ...scope, records })
      try { this.legacy.setItem(marker, encoded) } catch { /* A thrown metadata write may still have completed. */ }
      if (this.legacy.getItem(marker) !== encoded) return false
    }
    const record = JSON.parse(encoded) as { schemaVersion: number; namespaceId: string; topicId: string; sessionId: string; records: { key: string; sha256: string }[] }
    if (record.schemaVersion !== 1 || record.namespaceId !== scope.namespaceId || record.topicId !== scope.topicId || record.sessionId !== scope.sessionId || !Array.isArray(record.records) || record.records.some(copy => typeof copy.key !== 'string' || !/^[a-f0-9]{64}$/u.test(copy.sha256))) return false
    let complete = true
    for (const copy of record.records) {
      this.check(epoch)
      try {
        const allowed = copy.key === historyKey(scope.sessionId) || copy.key.startsWith(fileJobsSessionPrefix(scope.sessionId)) || copy.key.startsWith(`dsh-translation-plugin:file-intake:v1:${encodeURIComponent(scope.sessionId)}:`) || copy.key.startsWith('dsh-translation-plugin:preparation:v1:')
        if (!allowed) { complete = false; continue }
        const raw = this.legacy.getItem(copy.key); if (raw === null) continue
        if (await digest(raw) !== copy.sha256) { complete = false; continue }
        this.check(epoch)
        if (this.legacy.getItem(copy.key) !== raw) { complete = false; continue }
        this.legacy.removeItem(copy.key); if (this.legacy.getItem(copy.key) !== null) complete = false
      }
      catch { complete = false }
    }
    if (complete && this.legacy.getItem(marker) === encoded) { this.legacy.removeItem(marker); if (this.legacy.getItem(marker) !== null) complete = false }
    return complete
  }
  replace(scope: HistoryScope, state: HistoryStatus, current: () => HistoryBundle, rememberHistory: boolean, before?: HistoryTransferReceipt): Promise<HistoryTransferReceipt> {
    return this.serial(async epoch => {
      if (!state.token || state.retired) throw new Error('此会话尚未由宿主接管或已退役。')
      const remote = await this.port(epoch), snapshot = parseHistoryBundle(current(), scope), encoded = encodeHistoryBundle(snapshot)
      return this.send(remote, scope, rememberHistory ? persistableHistoryBundle(snapshot) : snapshot, null, state.token, rememberHistory, () => encodeHistoryBundle(parseHistoryBundle(current(), scope)) === encoded, epoch, false, before)
    })
  }
  create(scope: HistoryScope, current: () => HistoryBundle, rememberHistory: boolean): Promise<HistoryTransferReceipt> {
    return this.serial(async epoch => {
      const remote = await this.port(epoch), snapshot = parseHistoryBundle(current(), scope), encoded = encodeHistoryBundle(snapshot)
      return this.send(remote, scope, rememberHistory ? persistableHistoryBundle(snapshot) : snapshot, null, null, rememberHistory, () => encodeHistoryBundle(parseHistoryBundle(current(), scope)) === encoded, epoch, true)
    })
  }
  mutate(request: HistoryMutation): Promise<Awaited<ReturnType<HistoryRemotePort['mutate']>>> { return this.serial(async epoch => { const remote = await this.port(epoch), result = unwrap('mutate', await remote.mutate(request)); this.check(epoch); return result }) }
  retire(request: import('../shared/history-remote.js').HistoryRetire): Promise<Awaited<ReturnType<HistoryRemotePort['retire']>>> { return this.serial(async epoch => { const remote = await this.port(epoch), result = unwrap('retire', await remote.retire(request)); this.check(epoch); return result }) }
  async readCurrent(request: CurrentHistoryRead, signal: AbortSignal): Promise<HistoryCurrentPage> { const epoch = this.epoch, remote = await this.port(epoch); signal.throwIfAborted(); const result = unwrap('readCurrent', await remote.readCurrent(request, signal)); this.check(epoch); signal.throwIfAborted(); return result }
  async searchCurrent(request: import('../shared/history-remote.js').HistoryTextSearch, signal: AbortSignal): Promise<import('../shared/history-remote.js').HistoryTextMatches> { const epoch = this.epoch, remote = await this.port(epoch); signal.throwIfAborted(); const result = unwrap('searchCurrent', await remote.searchCurrent(request, signal)); this.check(epoch); signal.throwIfAborted(); return result }
  dispose(): void { this.disposed = true; this.epoch++; for (const active of this.active) void active.remote.cancel({ ...active.scope, transferId: active.transferId }).catch(() => {}) }
}
