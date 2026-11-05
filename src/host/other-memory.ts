import { OTHER_MEMORY_RESPONSE_BYTES, parseOtherMemoryEntry, parseOtherMemoryRequest, parseOtherMemoryScope,
  type OtherMemoryEntry, type OtherMemoryList, type OtherMemoryPage, type OtherMemoryPutSetting, type OtherMemoryReference,
  type OtherMemoryRemotePort, type OtherMemoryRemove, type OtherMemoryScope, type OtherMemorySetting } from '../shared/other-memory.js'
import { referenceBytes, referenceString } from '../shared/reference-memory.js'
import type { SourceIdentity } from '../shared/translation-sources.js'
import { parseReferenceSegmentation } from '../shared/reference-segmentation.js'
import { remapReferenceSegmentation, type ReferenceFilePlan } from './reference-segmentation-reuse.js'
import { loadMemoryDatabase, type MemoryDatabase } from './memory-database.js'
import type { LocalDataService } from './local-data.js'
import type { TopicHostContext, TopicToolsService } from './topic-tools.js'

export interface OtherMemoryReferenceFilesHooks {
  persistSource(entry: OtherMemoryReference): Promise<void>
  readSource(source: SourceIdentity): Promise<string>
  release(entry: OtherMemoryReference): void
}
interface Guard { readonly scope: OtherMemoryScope; readonly peerId: string; readonly generation: number; readonly epoch: number }
function failure(code: string, message: string): Error { return Object.assign(new Error(message), { code }) }
function scopeKey(scope: OtherMemoryScope): string { return JSON.stringify([scope.namespaceId, scope.topicId]) }
function applicable(entry: OtherMemoryEntry, scope: OtherMemoryScope): boolean { return entry.namespaceId === scope.namespaceId && (entry.topicId === null || entry.topicId === scope.topicId) }

/** Host authority for new other_memory assets; Client caches never become a fallback store. */
export class OtherMemoryService implements OtherMemoryRemotePort {
  readonly typertRemote: { readonly service: OtherMemoryService; readonly serviceKey: 'translationOtherMemory'; readonly namespace: 'translationOtherMemory' } = { service: this, serviceKey: 'translationOtherMemory', namespace: 'translationOtherMemory' }
  private readonly epochs = new Map<string, number>()
  private readonly retired = new Set<string>()
  private db: MemoryDatabase | undefined
  private opening: Promise<MemoryDatabase | undefined> | undefined
  private hooks: OtherMemoryReferenceFilesHooks | undefined
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false
  private generation = 0
  private pending = 0
  constructor(private readonly ctx: TopicHostContext, private readonly loadDatabase: (create: boolean) => Promise<MemoryDatabase | undefined> = create => loadMemoryDatabase(ctx, create)) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationOtherMemory', property: 'ctx' } })
  }
  setReferenceFilesHooks(hooks: OtherMemoryReferenceFilesHooks): void { this.hooks = hooks }
  /** Shared connection owner; callers coordinate writes with LocalData's writer. */
  databaseForArchives(create = false): Promise<MemoryDatabase | undefined> { return this.database(create) }
  hasActiveJobs(): boolean { return this.pending > 0 }
  private get topics(): TopicToolsService | undefined { return this.ctx.get?.('translationTopics') as TopicToolsService | undefined }
  private authorize(scope: OtherMemoryScope, peerId: string | undefined): Guard {
    parseOtherMemoryScope(scope)
    if (this.disposed || !peerId || !this.topics?.ownsLibrary(scope.namespaceId, peerId)) throw failure('scope_mismatch', '其他记忆操作不属于此资料库连接，或该连接已关闭。')
    return { scope, peerId, generation: this.generation, epoch: this.epochs.get(scopeKey(scope)) ?? 0 }
  }
  private check(guard: Guard): void {
    if (this.disposed || guard.generation !== this.generation || guard.epoch !== (this.epochs.get(scopeKey(guard.scope)) ?? 0)) throw failure('other_memory_stale', '其他记忆范围已经清理，迟到操作已停止。')
    if (!this.topics?.ownsLibrary(guard.scope.namespaceId, guard.peerId)) throw failure('scope_mismatch', '资料库连接已变化，请重新打开其他记忆。')
    this.checkScope(guard.scope)
  }
  private checkScope(scope: OtherMemoryScope): void {
    if (this.disposed || scope.topicId !== null && (this.retired.has(scopeKey(scope)) || this.db?.retired(scope.namespaceId, scope.topicId)))
      throw failure('other_memory_retired', '此主题已删除，其他记忆不可重新写入或读取。')
  }
  private async database(create = false): Promise<MemoryDatabase | undefined> {
    if (this.disposed) throw failure('other_memory_closed', '其他记忆存储已关闭。')
    if (this.db) return this.db
    if (this.opening) { await this.opening; if (this.db || !create) return this.db }
    const opening = this.loadDatabase(create).then(db => {
      if (this.disposed) { db?.close(); throw failure('other_memory_closed', '其他记忆存储已关闭。') }
      this.db = db; return db
    })
    this.opening = opening
    try { return await opening } finally { if (this.opening === opening) this.opening = undefined }
  }
  private entries(namespaceId: string): readonly OtherMemoryEntry[] {
    const entries = new Map((this.db?.all(namespaceId) ?? []).map(entry => [entry.id, entry]))
    return [...entries.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  }
  private current(id: string, namespaceId: string): OtherMemoryEntry | undefined {
    const entry = this.db?.entry(id)
    return entry?.namespaceId === namespaceId ? entry : undefined
  }
  private writer<T>(action: () => Promise<T>): Promise<T> {
    return ((this.ctx.get?.('translationLocalData') as LocalDataService | undefined)?.storageWriter() ?? (async <R>(run: () => Promise<R>): Promise<R> => run()))(action).then(value => {
      (this.ctx.get?.('translationMemorySearch') as { contentChanged(): void } | undefined)?.contentChanged(); return value
    })
  }
  async retrievalReferences(namespaceId: string, peerId: string): Promise<readonly OtherMemoryReference[]> {
    const guard = this.authorize({ namespaceId, topicId: null }, peerId)
    await this.tail; await this.database(); this.check(guard)
    return structuredClone(this.entries(namespaceId).filter((entry): entry is OtherMemoryReference => entry.kind === 'reference' && entry.category === 'full_text' && !this.retired.has(scopeKey(entry)) && !this.db?.retired(namespaceId, entry.topicId)))
  }
  private serial<T>(guard: Guard, action: () => Promise<T>): Promise<T> {
    this.pending++
    const result = this.tail.then(() => { this.check(guard); return action() })
    this.tail = result.catch(() => {})
    return result.finally(() => { this.pending-- })
  }
  async list(raw: OtherMemoryList): Promise<OtherMemoryPage> {
    return this.listForPeer(raw, this.ctx.invocation?.peer.id)
  }
  /** Model-facing settings reads omit reference registrations before pagination. */
  async listSettings(raw: OtherMemoryList, peerId: string): Promise<OtherMemoryPage> { return this.listForPeer(raw, peerId, true) }
  private async listForPeer(raw: OtherMemoryList, peerId: string | undefined, settingsOnly = false): Promise<OtherMemoryPage> {
    const request = parseOtherMemoryRequest('list', raw) as OtherMemoryList, guard = this.authorize(request, peerId)
    await this.tail; await this.database(); this.check(guard)
    const candidates = this.entries(request.namespaceId).filter(entry => applicable(entry, request) && (!settingsOnly || entry.kind === 'setting') && (request.after === undefined || entry.id > request.after))
    const entries: OtherMemoryEntry[] = []
    let next: string | null = null
    for (const entry of candidates) {
      const page = { entries: [...entries, entry], next: entry.id }
      if (referenceBytes({ ok: true, value: page }) > OTHER_MEMORY_RESPONSE_BYTES) {
        if (!entries.length) throw failure('other_memory_page_limit', '其他记忆单条完整编码超过读取预算，请检查保存的正文。')
        next = entries.at(-1)!.id; break
      }
      entries.push(entry)
    }
    return structuredClone({ entries, next })
  }
  putSetting(raw: OtherMemoryPutSetting): Promise<OtherMemorySetting> {
    return this.putSettingForPeer(raw, this.ctx.invocation?.peer.id)
  }
  putSettingForAgent(raw: OtherMemoryPutSetting, peerId: string): Promise<OtherMemorySetting> { return this.putSettingForPeer(raw, peerId) }
  private putSettingForPeer(raw: OtherMemoryPutSetting, peerId: string | undefined): Promise<OtherMemorySetting> {
    const request = parseOtherMemoryRequest('putSetting', raw) as OtherMemoryPutSetting, guard = this.authorize(request, peerId)
    return this.serial(guard, () => this.writer(async () => {
      const db = await this.database(true); this.check(guard)
      const old = request.id === null ? undefined : this.current(request.id, request.namespaceId)
      if (request.id !== null && (!old || old.kind !== 'setting' || old.version !== request.expectedVersion)) throw failure('other_memory_stale', '此设定已变化或已删除，请重新读取后重试。')
      const entry = parseOtherMemoryEntry({ id: old?.id ?? `memory-${crypto.randomUUID()}`, namespaceId: request.namespaceId, topicId: request.topicId,
        version: (old?.version ?? 0) + 1, kind: 'setting', title: request.title, body: request.body, enabled: request.enabled,
        persistence: 'saved' }) as OtherMemorySetting
      db!.save(entry)
      return structuredClone(entry)
    }))
  }
  /** Only the file service can supply an actual Host-verified immutable original. */
  putReference(request: { readonly namespaceId: string; readonly topicId: string; readonly category: 'full_text' | 'reference'; readonly source: SourceIdentity }, peerId: string): Promise<OtherMemoryReference> {
    referenceString(request.topicId, 3000)
    if (request.category !== 'full_text') throw new TypeError('其他参考资料已关闭，仅支持原文／双语对照文件。')
    const guard = this.authorize(request, peerId)
    return this.serial(guard, async () => {
      await this.database(); this.check(guard)
      if (!this.hooks) throw failure('other_memory_original_unavailable', '参考原件保存服务尚未就绪。')
      const sameName = this.entries(request.namespaceId).filter((entry): entry is OtherMemoryReference => entry.kind === 'reference' && entry.category === 'full_text' && entry.source.name === request.source.name)
      const local = sameName.filter(entry => entry.topicId === request.topicId)
      if (local.length > 1) throw failure('reference_filename_conflict', '当前主题存在多份同名参考文件，请保留要沿用的一份后重试；未重新分段。')
      const old = local[0]
      let baseline = this.db?.referencePlan(request.namespaceId, request.source.name)
      if (!baseline) {
        const candidates = (old?.segmentation ? [old] : sameName.filter(entry => entry.segmentation !== undefined))
        for (const candidate of candidates) {
          const value: ReferenceFilePlan = { source: candidate.source, segmentation: candidate.segmentation! }
          if (!baseline) { baseline = value; continue }
          const first = await this.hooks.readSource(baseline.source), other = await this.hooks.readSource(value.source)
          this.check(guard)
          if (first !== other || JSON.stringify(baseline.segmentation.ends) !== JSON.stringify(value.segmentation.ends))
            throw failure('reference_filename_conflict', '同名历史参考文件存在不同分段，请先在要沿用的原主题更新该文件以确定基准；未重新分段。')
        }
      }
      let segmentation: OtherMemoryReference['segmentation']
      if (baseline) {
        const before = await this.hooks.readSource(baseline.source), after = await this.hooks.readSource(request.source)
        this.check(guard)
        const mapped = remapReferenceSegmentation(before, after, baseline.segmentation)
        segmentation = { version: old?.segmentation && JSON.stringify(old.segmentation.ends) === JSON.stringify(mapped.ends)
          ? old.segmentation.version : (old?.segmentation?.version ?? 0) + 1, ends: mapped.ends }
      }
      const entry = parseOtherMemoryEntry({ id: old?.id ?? `memory-${crypto.randomUUID()}`, namespaceId: request.namespaceId, topicId: request.topicId,
        version: (old?.version ?? 0) + 1, kind: 'reference', category: request.category, source: request.source, persistence: 'saved',
        ...(segmentation ? { segmentation } : {}) }) as OtherMemoryReference
      await this.hooks.persistSource(entry); this.check(guard)
      return this.writer(async () => {
        const db = await this.database(true); this.check(guard)
        db!.transaction(() => {
          db!.save(entry)
          if (entry.segmentation) db!.referencePlanSave(entry.namespaceId, { source: entry.source, segmentation: entry.segmentation })
          if (old) db!.indexRemoveSource(entry.namespaceId, entry.topicId, `reference:${entry.id}`)
        })
        if (old) this.hooks!.release(old)
        return structuredClone(entry)
      })
    })
  }
  async getReference(request: { readonly namespaceId: string; readonly topicId: string; readonly id: string; readonly version: number }, peerId: string): Promise<OtherMemoryReference | undefined> {
    const guard = this.authorize(request, peerId)
    await this.tail; await this.database(); this.check(guard)
    const entry = this.current(request.id, request.namespaceId)
    return entry?.kind === 'reference' && entry.topicId === request.topicId && entry.version === request.version ? structuredClone(entry) : undefined
  }
  async putReferenceSegmentation(request: { readonly namespaceId: string; readonly topicId: string; readonly id: string; readonly version: number; readonly expectedPlanVersion: number; readonly ends: readonly number[]; readonly mode: 'append' | 'replace' }, peerId: string, validate: () => void): Promise<OtherMemoryReference> {
    const guard = this.authorize(request, peerId)
    return this.serial(guard, async () => {
      await this.database(); this.check(guard); validate()
      const old = this.current(request.id, request.namespaceId)
      if (old?.kind !== 'reference' || old.category !== 'full_text' || old.topicId !== request.topicId || old.version !== request.version || (old.segmentation?.version ?? 0) !== request.expectedPlanVersion)
        throw failure('other_memory_stale', '文件或分段方案已变化，请读取最新状态后继续。')
      const ends = request.mode === 'append' ? [...old.segmentation?.ends ?? [], ...request.ends] : [...request.ends]
      const segmentation = parseReferenceSegmentation({ version: request.expectedPlanVersion + 1, ends }, old.source.totalCodePoints)
      const entry = parseOtherMemoryEntry({ ...old, segmentation, persistence: 'saved' }) as OtherMemoryReference
      return this.writer(async () => {
        const db = await this.database(true); this.check(guard); validate()
        db!.transaction(() => {
          db!.save(entry)
          // A late task on another topic's older snapshot must not roll back the latest filename baseline.
          const baseline = db!.referencePlan(entry.namespaceId, entry.source.name)
          if (!baseline || baseline.source.sourceId === entry.source.sourceId) db!.referencePlanSave(entry.namespaceId, { source: entry.source, segmentation })
        })
        ;(this.ctx.get?.('translationMemorySearch') as { contentChanged(): void } | undefined)?.contentChanged()
        return structuredClone(entry)
      })
    })
  }
  /** Host-only read for the already authorized topic; settings and other topics never enter file retrieval. */
  async referencesForTopic(request: { readonly namespaceId: string; readonly topicId: string }, peerId: string): Promise<readonly OtherMemoryReference[]> {
    referenceString(request.topicId, 3000)
    const guard = this.authorize(request, peerId)
    await this.tail; await this.database(); this.check(guard)
    return structuredClone(this.entries(request.namespaceId).filter((entry): entry is OtherMemoryReference => entry.kind === 'reference' && entry.category === 'full_text' && entry.topicId === request.topicId))
  }
  /** Synchronous final check of already loaded metadata after an awaited original read. */
  referenceIsCurrent(scope: { readonly namespaceId: string; readonly topicId: string }, selection: { readonly id: string; readonly version: number; readonly sha256: string }): boolean {
    try {
      this.checkScope(scope)
      const entry = this.current(selection.id, scope.namespaceId)
      return entry?.kind === 'reference' && entry.category === 'full_text' && entry.topicId === scope.topicId && entry.version === selection.version && entry.source.sha256 === selection.sha256
    } catch { return false }
  }
  removeEntry(raw: OtherMemoryRemove): Promise<{ readonly removed: true }> {
    return this.removeForPeer(raw, this.ctx.invocation?.peer.id)
  }
  private retainReferencePlan(db: MemoryDatabase, entry: OtherMemoryEntry): void {
    if (entry.kind !== 'reference' || !entry.segmentation || db.referencePlan(entry.namespaceId, entry.source.name)) return
    const candidates = this.entries(entry.namespaceId).filter(item => item.kind === 'reference' && item.source.name === entry.source.name && item.segmentation !== undefined)
    if (candidates.length === 1) db.referencePlanSave(entry.namespaceId, { source: entry.source, segmentation: entry.segmentation })
  }
  removeSettingForAgent(raw: OtherMemoryRemove, peerId: string): Promise<{ readonly removed: true }> { return this.removeForPeer(raw, peerId, true) }
  private removeForPeer(raw: OtherMemoryRemove, peerId: string | undefined, settingsOnly = false): Promise<{ readonly removed: true }> {
    const request = parseOtherMemoryRequest('removeEntry', raw) as OtherMemoryRemove, guard = this.authorize(request, peerId)
    return this.serial(guard, () => this.writer(async () => {
      const db = await this.database(); this.check(guard)
      const entry = this.current(request.id, request.namespaceId)
      if (!entry || entry.topicId !== request.topicId || entry.version !== request.expectedVersion || settingsOnly && entry.kind !== 'setting') throw failure('other_memory_stale', '此条目已变化、已删除或不是指定范围的设定，请重新读取后重试。')
      db?.transaction(() => { this.retainReferencePlan(db, entry); db.remove(entry.id); if (entry.kind === 'reference') db.indexRemoveSource(entry.namespaceId, entry.topicId, `reference:${entry.id}`) })
      if (entry.kind === 'reference') this.hooks?.release(entry)
      return { removed: true as const }
    }))
  }
  private removeTopic(namespaceId: string, topicId: string): void {
    const durable = this.db?.all(namespaceId).filter(entry => entry.topicId === topicId) ?? []
    this.db?.transaction(() => {
      for (const entry of durable) this.retainReferencePlan(this.db!, entry)
      for (const entry of durable) this.db!.remove(entry.id)
      for (const entry of durable) if (entry.kind === 'reference') this.db!.indexRemoveSource(namespaceId, topicId, `reference:${entry.id}`)
    })
    for (const entry of durable) if (entry.kind === 'reference') this.hooks?.release(entry)
  }
  clearTopic(raw: { readonly namespaceId: string; readonly topicId: string }): Promise<{ readonly cleared: true }> {
    const request = parseOtherMemoryRequest('clearTopic', raw) as typeof raw, guard = this.authorize(request, this.ctx.invocation?.peer.id)
    return this.serial(guard, () => this.writer(async () => {
      await this.database(); this.check(guard)
      if ((this.ctx.get?.('translationOtherMemoryFiles') as { hasActiveJobs?(): boolean } | undefined)?.hasActiveJobs?.()) throw failure('other_memory_busy', '仍有参考原件导入或读取操作，请完成后重试清空。')
      this.removeTopic(request.namespaceId, request.topicId)
      this.epochs.set(scopeKey(request), guard.epoch + 1)
      return { cleared: true as const }
    }))
  }
  async effectiveSettings(namespaceId: string, topicId: string): Promise<readonly OtherMemorySetting[]> {
    const scope = parseOtherMemoryScope({ namespaceId, topicId })
    await this.tail; await this.database(); this.checkScope(scope)
    return structuredClone(this.entries(namespaceId).filter((entry): entry is OtherMemorySetting => applicable(entry, scope) && entry.kind === 'setting' && entry.enabled))
  }
  /** Called inside LocalData's writer, so neither the service queue nor that writer is re-entered. */
  async retireTopicLocked(namespaceId: string, topicId: string): Promise<void> {
    const scope = parseOtherMemoryScope({ namespaceId, topicId }); referenceString(topicId, 3000)
    const key = scopeKey(scope); this.epochs.set(key, (this.epochs.get(key) ?? 0) + 1); this.retired.add(key)
    const db = await this.database(true)
    const durable = db!.all(namespaceId).filter(entry => entry.topicId === topicId)
    db!.transaction(() => {
      for (const entry of durable) this.retainReferencePlan(db!, entry)
      for (const entry of durable) db!.remove(entry.id)
      db!.retire(namespaceId, topicId)
    })
    for (const entry of durable) if (entry.kind === 'reference') this.hooks?.release(entry)
  }
  /** Topic deletion releases its registrations; filename baselines retain their own originals. */
  async topicSourcesLocked(namespaceId: string, topicId: string): Promise<readonly SourceIdentity[]> {
    await this.database()
    return [...(this.db?.all(namespaceId) ?? [])].filter((entry): entry is OtherMemoryReference => entry.namespaceId === namespaceId && entry.topicId === topicId && entry.kind === 'reference').map(entry => entry.source)
  }
  async heldSourceDigests(): Promise<ReadonlySet<string>> {
    await this.database()
    return new Set([...this.db?.referencePlanSources() ?? [], ...(this.db?.all() ?? []).filter((entry): entry is OtherMemoryReference => entry.kind === 'reference').map(entry => entry.source)].map(source => source.sha256))
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.generation++
    await this.tail
    try { await this.opening } catch { /* A stopped opening has already closed its connection. */ }
    this.db?.close(); this.db = undefined
  }
}
