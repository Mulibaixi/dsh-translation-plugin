import { diagnosticSpan } from './diagnostics.js'
import { referenceBytes, type ReferenceFileSelection } from '../shared/reference-memory.js'
import { parseMemoryIndexRequest, type MemoryIndexBuild, type MemoryIndexScope, type MemoryIndexStatus } from '../shared/memory-search.js'
import type { TopicArchiveEntry, TopicArchiveSnapshot } from '../memory/topic-archive.js'
import type { OtherMemoryService } from './other-memory.js'
import type { OtherMemoryFilesService } from './other-memory-files.js'
import type { TopicArchiveService } from './topic-archive.js'
import type { EmbeddingService } from './embedding.js'
import type { LocalDataService } from './local-data.js'
import type { MemoryVectorRow } from './memory-database.js'
import type { TopicHostContext, TopicToolsService } from './topic-tools.js'
import type { HistoryService } from './history.js'
import type { HistoryScope } from '../shared/history-bundle.js'
import { currentFinalRevision, isDeletedUnit, isDocumentUnit, isFileJobUnit, isTextUnit } from '../memory/translation-history.js'
import { currentDocumentFinal } from '../memory/document-task.js'
import { currentHistoryPair, historyFileName, isFileHistoryUnit, historyIndexSourceId, historyIndexSourceIds, historyRecordExcerpt, historyRecordText, type CurrentHistoryPair } from './history-retrieval.js'
import type { TranslationSourcesService } from './translation-sources.js'
import type { TranslationRecordSelection } from '../shared/reference-memory.js'
import { languageMatches } from '../shared/language-tag.js'
import { REFERENCE_SEGMENTATION_VERSION, segmentReferenceText } from './reference-segments.js'

interface Chunk extends Omit<MemoryVectorRow, 'vector'> {
  readonly text: string; readonly saved: boolean
  readonly embeddingText?: string
  readonly keywordText?: string
  readonly ref: { readonly kind: 'entity' | 'fact' | 'relation'; readonly id: string; readonly version: number; readonly purpose: 'background' }
    | { readonly kind: 'reference_file'; readonly selection: ReferenceFileSelection }
    | { readonly kind: 'translation_record'; readonly selection: TranslationRecordSelection; readonly targetLanguage: string }
  readonly origin: string
}
interface Collection { readonly chunks: readonly Chunk[]; readonly saved: readonly Omit<MemoryVectorRow, 'vector'>[]; readonly unsupported: number; readonly unsegmented: number; readonly unavailable: number; readonly unavailableRecords: number }
interface IndexSeat {
  readonly namespaceId: string; peer: string; enabled: boolean; dirty: boolean; epoch: number
  config: string; vectors: Map<string, readonly number[]>; status: MemoryIndexStatus
  job?: Promise<void> | undefined; controller?: AbortController | undefined
}
interface RecordSegments {
  selected(scope: HistoryScope, unitId: string, sourceVersion: number, peer: string): Promise<boolean>
  segments(scope: HistoryScope, unitId: string, sourceVersion: number, source: string, peer: string, signal: AbortSignal): Promise<{ readonly selected: boolean; readonly complete: boolean; readonly parts: readonly { readonly start: number; readonly end: number; readonly text: string }[] }>
}
const empty = (): MemoryIndexStatus => ({ enabled: false, building: false, total: 0, indexed: 0, unsupported: 0, unsegmented: 0, unavailable: 0, unavailableRecords: 0 })
const identity = (row: Omit<MemoryVectorRow, 'vector'>): string => JSON.stringify([row.topicId, row.sourceId, row.hash, row.start, row.end])
const hash = async (text: string): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(n => n.toString(16).padStart(2, '0')).join('')
const configKey = (config: { readonly endpoint: string; readonly model: string }): string => JSON.stringify([REFERENCE_SEGMENTATION_VERSION, config.endpoint, config.model])
class MemoryIndexFailure extends Error {}
function failure(message: string): Error { return new MemoryIndexFailure(message) }
function projection(entry: TopicArchiveEntry, snapshot: TopicArchiveSnapshot): string {
  const entity = (id: string): string => { const item = snapshot.entries.find(item => item.id === id); return item?.kind === 'entity' ? item.name : id }
  return entry.kind === 'entity' ? [entry.name, ...entry.aliases, entry.description].join('\n') : entry.kind === 'fact' ? [entry.title, entry.body].join('\n')
    : [entity(entry.sourceEntityId), entry.relation, entity(entry.targetEntityId), entry.description].join('\n')
}
async function segments(text: string): Promise<readonly { readonly text: string; readonly hash: string; readonly start: number; readonly end: number }[]> {
  const points = Array.from(text), result = []
  for (let start = 0; start < points.length;) {
    let end = Math.min(start + 1000, points.length)
    if (end < points.length) for (let p = end - 1; p >= start + 500; p--) if (points[p] === '\n') { end = p + 1; break }
    const content = points.slice(start, end).join('')
    if (content.trim()) result.push({ text: content, hash: await hash(content), start, end })
    start = end
  }
  return result
}
function normalized(vector: readonly number[]): readonly number[] | undefined {
  if (!Array.isArray(vector) || !vector.length || vector.length > 65536 || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) return undefined
  let max = 0; for (const value of vector) max = Math.max(max, Math.abs(value))
  if (!max) return undefined
  const scaled = vector.map(value => value / max), length = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0))
  return scaled.map(value => value / length)
}

/** Derived vectors contain no editable body. Every query starts from current scoped Host content. */
export class MemorySearchService {
  readonly typertRemote: { readonly service: MemorySearchService; readonly serviceKey: 'translationMemorySearch'; readonly namespace: 'translationMemorySearch' } = { service: this, serviceKey: 'translationMemorySearch', namespace: 'translationMemorySearch' }
  private readonly seats = new Map<string, IndexSeat>()
  private tail: Promise<void> = Promise.resolve()
  private disposed = false
  private searches = 0
  private contentEpoch = 0
  private readonly recordJobs = new Map<string, { readonly controller: AbortController; readonly promise: Promise<void> }>()
  constructor(private readonly ctx: TopicHostContext, private readonly memory: OtherMemoryService, private readonly archive: TopicArchiveService,
    private readonly files: OtherMemoryFilesService, private readonly embedding: EmbeddingService) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationMemorySearch', property: 'ctx' } })
  }
  private check(namespaceId: string, peer: string): void {
    if (this.disposed || !(this.ctx.get?.('translationTopics') as TopicToolsService | undefined)?.ownsLibrary(namespaceId, peer)) throw failure('记忆检索连接已关闭或不属于此资料库。')
  }
  private writer<T>(action: () => Promise<T>): Promise<T> { return ((this.ctx.get?.('translationLocalData') as LocalDataService | undefined)?.storageWriter() ?? (async <R>(run: () => Promise<R>): Promise<R> => run()))(action) }
  private async seat(namespaceId: string, peer: string, resume = true): Promise<IndexSeat> {
    this.check(namespaceId, peer)
    let seat = this.seats.get(namespaceId)
    if (!seat) {
      const enabled = (await this.memory.databaseForArchives())?.indexNamespaces().includes(namespaceId) ?? false
      this.check(namespaceId, peer)
      seat = this.seats.get(namespaceId)
      if (!seat) { seat = { namespaceId, peer, enabled, dirty: enabled, epoch: 0, config: '', vectors: new Map(), status: { ...empty(), enabled } }; this.seats.set(namespaceId, seat) }
    }
    seat.peer = peer; if (resume && seat.dirty) this.kick(seat)
    return seat
  }
  async status(raw: MemoryIndexScope): Promise<MemoryIndexStatus> {
    const request = parseMemoryIndexRequest('status', raw) as MemoryIndexScope, peer = this.ctx.invocation?.peer.id
    if (!peer) throw failure('索引状态缺少宿主连接。')
    const seat = await this.seat(request.namespaceId, peer, false)
    this.searches++
    try {
      const collection = await this.collect(request.namespaceId, peer, new AbortController().signal, request.topicId)
      const config = await this.embedding.configuration(); this.check(request.namespaceId, peer)
      const status = { ...seat.status, total: collection.chunks.length,
        indexed: config && seat.config === configKey(config) ? collection.chunks.filter(row => seat.vectors.has(identity(row))).length : 0,
        unsupported: collection.unsupported, unsegmented: collection.unsegmented, unavailable: collection.unavailable, unavailableRecords: collection.unavailableRecords }
      if (request.topicId === undefined) seat.status = status
      return status
    } finally { this.searches-- }
  }
  /** Resume an already-enabled index on library connection, before any search/settings visit. */
  resumeLibrary(namespaceId: string, peer: string): void {
    void this.seat(namespaceId, peer).catch(error => diagnosticSpan(this.ctx, 'memory.index.resume', {}, namespaceId)('failed', {}, error))
  }
  async build(raw: MemoryIndexBuild): Promise<MemoryIndexStatus> {
    return this.buildForPeer(raw, this.ctx.invocation?.peer.id)
  }
  async buildForPeer(raw: MemoryIndexBuild, peer: string | undefined): Promise<MemoryIndexStatus> {
    const request = parseMemoryIndexRequest('build', raw) as MemoryIndexBuild
    if (!peer) throw failure('索引构建缺少宿主连接。')
    const config = await this.embedding.configuration(); if (!config) throw failure('请先保存嵌入 API 配置。')
    const seat = await this.seat(request.namespaceId, peer)
    await this.writer(async () => {
      this.check(request.namespaceId, peer)
      const db = await this.memory.databaseForArchives(true); this.check(request.namespaceId, peer)
      db!.transaction(() => { db!.indexEnable(request.namespaceId); if (request.rebuild) db!.indexClear(request.namespaceId) })
      seat.enabled = true; seat.epoch++; seat.controller?.abort(); seat.dirty = true
      if (request.rebuild) { seat.config = ''; seat.vectors.clear() }
    })
    this.kick(seat); return { ...seat.status, enabled: true, building: true }
  }
  contentChanged(): void {
    this.contentEpoch++
    for (const seat of this.seats.values()) if (seat.enabled) { seat.epoch++; seat.dirty = true; seat.controller?.abort(); this.kick(seat) }
  }
  embeddingChanged(): void { this.contentChanged() }
  private kick(seat: IndexSeat): void {
    if (this.disposed || !seat.enabled || !seat.dirty || seat.job) return
    seat.dirty = false; seat.status = { ...seat.status, enabled: true, building: true }
    const epoch = seat.epoch, controller = new AbortController(); seat.controller = controller
    const report = diagnosticSpan(this.ctx, 'memory.index', {}, seat.namespaceId)
    const job = this.tail.catch(() => {}).then(() => this.run(seat, epoch, controller.signal)).then(() => {
      report('completed', { indexed: seat.status.indexed, total: seat.status.total, unsupported: seat.status.unsupported, unsegmented: seat.status.unsegmented, unavailable: seat.status.unavailable, unavailableRecords: seat.status.unavailableRecords })
    }).catch(error => {
      report(controller.signal.aborted ? 'cancelled' : 'failed', { indexed: seat.status.indexed, total: seat.status.total }, error)
      if (!this.disposed && epoch === seat.epoch) seat.status = { ...seat.status, reason: error instanceof MemoryIndexFailure || (error as { code?: string }).code?.startsWith('embedding_') ? (error as Error).message : '记忆索引未完成；可读取原内容，检查服务后补齐或重建。' }
    }).finally(() => {
      if (seat.job === job) { seat.job = undefined; seat.controller = undefined; seat.status = { ...seat.status, building: false }; if (seat.dirty) this.kick(seat) }
    })
    seat.job = job; this.tail = job
  }
  private async collect(namespaceId: string, peer: string, signal: AbortSignal, topicId?: string, sessionIds?: readonly string[], unitId?: string): Promise<Collection> {
    const epoch = this.contentEpoch
    this.check(namespaceId, peer); signal.throwIfAborted()
    const snapshots = unitId === undefined ? await this.archive.retrievalSnapshots(namespaceId, peer, topicId) : [], chunks: Chunk[] = [], saved: Omit<MemoryVectorRow, 'vector'>[] = []
    for (const pair of snapshots) {
      const savedKeys = new Set<string>()
      for (const entry of pair.saved?.entries ?? []) if (entry.status === 'active') for (const part of await segments(projection(entry, pair.saved!))) {
        const row = { topicId: pair.saved!.topicId, sourceId: `archive:${entry.id}`, hash: part.hash, start: part.start, end: part.end }; saved.push(row); savedKeys.add(identity(row))
      }
      for (const entry of pair.current.entries) if (entry.status === 'active') for (const part of await segments(projection(entry, pair.current))) {
        const row = { ...part, topicId: pair.current.topicId, sourceId: `archive:${entry.id}` }
        chunks.push({ ...row, saved: savedKeys.has(identity(row)), ref: { kind: entry.kind, id: entry.id, version: entry.version, purpose: 'background' }, origin: entry.origin })
      }
    }
    let unsupported = 0, unsegmented = 0, unavailable = 0, unavailableRecords = 0
    for (const ref of unitId === undefined ? await this.memory.retrievalReferences(namespaceId, peer) : []) {
      if (topicId !== undefined && ref.topicId !== topicId) continue
      signal.throwIfAborted()
      try {
        const { text } = await this.files.readText({ namespaceId, topicId: ref.topicId, id: ref.id, version: ref.version }, peer, signal)
        const segments = segmentReferenceText(text, ref.segmentation)
        if (!segments.length) { unsegmented++; continue }
        for (const segment of segments) {
          const part = { ...segment, hash: await hash(segment.text) }
          const row = { ...part, topicId: ref.topicId, sourceId: `reference:${ref.id}`, saved: ref.persistence === 'saved', origin: ref.category,
            ref: { kind: 'reference_file' as const, selection: { id: ref.id, version: ref.version, sha256: ref.source.sha256, range: { start: part.start, end: part.end } } } }
          chunks.push(row); if (row.saved) saved.push(row)
        }
      } catch (error) { signal.throwIfAborted(); if ((error as { code?: string }).code === 'reference_format_unsupported') unsupported++; else unavailable++ }
    }
    const history = this.ctx.get?.('translationHistory') as HistoryService | undefined
    const recordSegments = this.ctx.get?.('translationRecordIndex') as RecordSegments | undefined
    const historyRows = async (pair: CurrentHistoryPair, parts?: readonly { readonly start: number; readonly end: number; readonly text: string }[]): Promise<Chunk[]> => {
      const points = { source: Array.from(pair.source), translation: Array.from(pair.translation) }, result: Chunk[] = []
      const add = async (side: 'source' | 'translation' | 'bilingual', sourceRange: TranslationRecordSelection['sourceRange'], translationRange: TranslationRecordSelection['translationRange'], embeddingText?: string): Promise<void> => {
        const excerpt = await historyRecordExcerpt(pair, sourceRange, translationRange, points), range = sourceRange ?? translationRange!
        result.push({ topicId: topicId ?? '', sourceId: historyIndexSourceId(pair.sessionId, pair.unitId, side), hash: embeddingText === undefined ? excerpt.selection.sha256 : await hash(JSON.stringify(['file-source-v1', pair.sourceVersion, excerpt.source, embeddingText])), start: range.start, end: range.end,
          text: historyRecordText(excerpt), ...(embeddingText === undefined ? {} : { embeddingText }), keywordText: embeddingText ?? [excerpt.source, excerpt.translation].filter(text => text !== null).join('\n'), saved: false, origin: embeddingText === undefined ? 'current_final' : 'current_file_source', ref: { kind: 'translation_record', selection: excerpt.selection, targetLanguage: pair.targetLanguage } })
      }
      if (parts !== undefined) {
        for (const part of parts) if (part.text.trim()) await add('source', { start: part.start, end: part.end }, null, part.text)
      } else if (points.source.length + points.translation.length <= 1000) {
        if (points.source.length + points.translation.length) await add('bilingual', points.source.length ? { start: 0, end: points.source.length } : null, points.translation.length ? { start: 0, end: points.translation.length } : null)
      } else for (const side of ['source', 'translation'] as const) for (const segment of await segments(pair[side])) {
        const range = { start: segment.start, end: segment.end }; await add(side, side === 'source' ? range : null, side === 'translation' ? range : null)
      }
      return result
    }
    for (const snapshot of await history?.retrievalSnapshots(namespaceId, peer, topicId, sessionIds) ?? []) {
      const savedRows: Chunk[] = []
      const load = async (bundle: typeof snapshot.current, countUnavailable: boolean): Promise<Chunk[]> => {
        const result: Chunk[] = []
        for (const unit of bundle.history.units) if (!isDeletedUnit(unit) && (unitId === undefined || unit.id === unitId)) {
          signal.throwIfAborted()
          if (isTextUnit(unit) && !currentFinalRevision(unit) || isDocumentUnit(unit) && !currentDocumentFinal(unit)) continue
          if (isFileJobUnit(unit) && !bundle.fileJobs.some(record => record.summary.unitId === unit.id && record.summary.sourceVersion === unit.sourceVersion && record.final)) continue
          try {
            const file = isFileHistoryUnit(bundle, unit.id)
            if (unitId !== undefined && !file) continue
            if (file && (!recordSegments || !/\.(?:txt|md)$/iu.test(historyFileName(bundle, unit.id) ?? '') || !await recordSegments.selected(snapshot.scope, unit.id, unit.sourceVersion!, peer))) continue
            const pair = await currentHistoryPair(bundle, snapshot.scope, snapshot.token, unit.id, peer, this.ctx.get?.('translationSources') as TranslationSourcesService | undefined, signal)
            if (!pair) { if (countUnavailable) unavailableRecords++; continue }
            let parts: readonly { readonly start: number; readonly end: number; readonly text: string }[] | undefined
            if (file) {
              const plan = await recordSegments!.segments(snapshot.scope, unit.id, unit.sourceVersion!, pair.source, peer, signal)
              if (!plan.selected) continue
              if (!plan.complete) { if (countUnavailable) unsegmented++; continue }
              parts = plan.parts
            }
            for (const row of await historyRows(pair, parts)) result.push({ ...row, topicId: snapshot.scope.topicId })
          } catch { signal.throwIfAborted(); if (countUnavailable) unavailableRecords++ }
        }
        return result
      }
      const currentRows = await load(snapshot.current, true)
      if (snapshot.saved) savedRows.push(...snapshot.saved === snapshot.current ? currentRows : await load(snapshot.saved, false))
      saved.push(...savedRows)
      const savedKeys = new Set(savedRows.map(identity))
      for (const row of currentRows) chunks.push({ ...row, saved: savedKeys.has(identity(row)) })
    }
    this.check(namespaceId, peer); signal.throwIfAborted()
    if (epoch !== this.contentEpoch) throw failure('记忆内容在读取期间变化，请重试检索。')
    return { chunks, saved, unsupported, unsegmented, unavailable, unavailableRecords }
  }
  private async cache(seat: IndexSeat, config: string): Promise<void> {
    if (seat.config === config) return
    const rows = (await this.memory.databaseForArchives())?.indexRows(seat.namespaceId, config) ?? []
    this.check(seat.namespaceId, seat.peer)
    seat.vectors = new Map(rows.flatMap(row => { const vector = normalized(row.vector); return vector ? [[identity(row), vector] as const] : [] })); seat.config = config
  }
  private coverage(seat: IndexSeat, collection: Collection): void {
    seat.status = { enabled: seat.enabled, building: !!seat.job, total: collection.chunks.length, indexed: collection.chunks.filter(row => seat.vectors.has(identity(row))).length,
      unsupported: collection.unsupported, unsegmented: collection.unsegmented, unavailable: collection.unavailable, unavailableRecords: collection.unavailableRecords }
  }
  private async run(seat: IndexSeat, epoch: number, signal: AbortSignal): Promise<void> {
    const check = (): void => { this.check(seat.namespaceId, seat.peer); signal.throwIfAborted(); if (seat.epoch !== epoch) throw failure('索引内容已变化。') }
    check()
    const config = await this.embedding.configuration(); if (!config) throw failure('尚未配置嵌入 API。')
    const space = configKey(config); await this.cache(seat, space)
    const collection = await this.collect(seat.namespaceId, seat.peer, signal); check(); this.coverage(seat, collection)
    const currentKeys = new Set([...collection.chunks, ...collection.saved].map(identity))
    for (const id of seat.vectors.keys()) if (!currentKeys.has(id)) seat.vectors.delete(id)
    await this.writer(async () => { check(); const db = await this.memory.databaseForArchives(); check(); db?.transaction(() => db.indexPrune(seat.namespaceId, space, collection.saved)) })
    const missing = collection.chunks.filter(row => !seat.vectors.has(identity(row)))
    for (let start = 0; start < missing.length; start += 32) {
      check(); const batch = missing.slice(start, start + 32), result = await this.embedding.embed(batch.map(row => row.embeddingText ?? row.text), signal, config.revision); check()
      const vectors = result.vectors.map(normalized)
      const dimensions = seat.vectors.values().next().value?.length
      if (vectors.some(vector => !vector || dimensions !== undefined && vector.length !== dimensions)) throw failure('嵌入维度已变化或返回零向量，请重建记忆索引。')
      const latest = await this.collect(seat.namespaceId, seat.peer, signal); check()
      const live = new Set(latest.chunks.map(identity)), durable = new Set(latest.saved.map(identity))
      const freshConfig = await this.embedding.configuration(); check(); if (!freshConfig || configKey(freshConfig) !== space || freshConfig.revision !== config.revision) throw failure('嵌入配置已变化。')
      await this.writer(async () => {
        check(); const persistent = batch.flatMap((row, i) => live.has(identity(row)) && durable.has(identity(row)) ? [{ ...row, vector: vectors[i]! }] : [])
        const db = await this.memory.databaseForArchives(); check()
        db?.transaction(() => { for (const row of persistent) db.indexPut(seat.namespaceId, space, row) })
        batch.forEach((row, i) => { if (live.has(identity(row))) seat.vectors.set(identity(row), vectors[i]!) })
      })
      this.coverage(seat, latest)
    }
  }
  /** File actions never wake the namespace-wide build or embed another object's content. */
  async buildRecord(scope: HistoryScope, unitId: string, peer: string, signal: AbortSignal): Promise<void> {
    const key = JSON.stringify([scope.namespaceId, scope.topicId, scope.sessionId, unitId])
    const existing = this.recordJobs.get(key)
    if (existing) return existing.promise
    signal.throwIfAborted()
    const controller = new AbortController(), abort = (): void => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const job = this.tail.catch(() => {}).then(() => this.runRecord(scope, unitId, peer, controller.signal)).finally(() => {
      signal.removeEventListener('abort', abort)
      if (this.recordJobs.get(key)?.promise === job) this.recordJobs.delete(key)
    })
    this.recordJobs.set(key, { controller, promise: job }); this.tail = job.catch(() => {})
    return job
  }
  private async runRecord(scope: HistoryScope, unitId: string, peer: string, signal: AbortSignal): Promise<void> {
    const check = (): void => { this.check(scope.namespaceId, peer); signal.throwIfAborted() }
    check()
    const seat = await this.seat(scope.namespaceId, peer, false), config = await this.embedding.configuration()
    check(); if (!config) throw failure('尚未配置嵌入 API。')
    const space = configKey(config); await this.cache(seat, space)
    const read = () => this.collect(scope.namespaceId, peer, signal, scope.topicId, [scope.sessionId], unitId)
    let collection = await read(); check()
    const wanted = new Set(collection.chunks.map(identity)), sourceIds = new Set(historyIndexSourceIds(scope.sessionId, unitId))
    for (const id of seat.vectors.keys()) {
      const [topicId, sourceId] = JSON.parse(id) as string[]
      if (topicId === scope.topicId && sourceIds.has(sourceId!) && !wanted.has(id)) seat.vectors.delete(id)
    }
    await this.writer(async () => {
      check(); const db = await this.memory.databaseForArchives(true); check()
      db!.transaction(() => {
        db!.indexEnable(scope.namespaceId)
        for (const sourceId of sourceIds) db!.indexRemoveSource(scope.namespaceId, scope.topicId, sourceId)
        const durable = new Set(collection.saved.map(identity))
        for (const row of collection.chunks) {
          const vector = seat.vectors.get(identity(row))
          if (vector && durable.has(identity(row))) db!.indexPut(scope.namespaceId, space, { ...row, vector })
        }
      })
      seat.enabled = true; seat.status = { ...seat.status, enabled: true }
    })
    const missing = collection.chunks.filter(row => !seat.vectors.has(identity(row)))
    for (let start = 0; start < missing.length; start += 32) {
      check()
      const batch = missing.slice(start, start + 32), result = await this.embedding.embed(batch.map(row => row.embeddingText ?? row.text), signal, config.revision)
      check()
      const vectors = result.vectors.map(normalized), dimensions = seat.vectors.values().next().value?.length
      if (vectors.some(vector => !vector || dimensions !== undefined && vector.length !== dimensions)) throw failure('嵌入维度已变化或返回零向量，请重建记忆索引。')
      collection = await read(); check()
      const live = new Set(collection.chunks.map(identity)), durable = new Set(collection.saved.map(identity)), latestConfig = await this.embedding.configuration()
      check(); if (!latestConfig || latestConfig.revision !== config.revision || configKey(latestConfig) !== space) throw failure('嵌入配置已变化。')
      await this.writer(async () => {
        check(); const db = await this.memory.databaseForArchives(true); check()
        db!.transaction(() => batch.forEach((row, i) => {
          if (live.has(identity(row)) && durable.has(identity(row))) db!.indexPut(scope.namespaceId, space, { ...row, vector: vectors[i]! })
        }))
        batch.forEach((row, i) => { if (live.has(identity(row))) seat.vectors.set(identity(row), vectors[i]!) })
      })
    }
  }
  async recordCoverage(scope: HistoryScope, unitId: string, peer: string, signal: AbortSignal): Promise<{ readonly indexed: number; readonly total: number }> {
    const seat = await this.seat(scope.namespaceId, peer, false), config = await this.embedding.configuration()
    if (config) await this.cache(seat, configKey(config))
    const collection = await this.collect(scope.namespaceId, peer, signal, scope.topicId, [scope.sessionId], unitId)
    return { indexed: config && seat.config === configKey(config) ? collection.chunks.filter(row => seat.vectors.has(identity(row))).length : 0, total: collection.chunks.length }
  }
  invalidateRecord(scope: HistoryScope, unitId: string): void {
    const key = JSON.stringify([scope.namespaceId, scope.topicId, scope.sessionId, unitId])
    this.recordJobs.get(key)?.controller.abort()
    const seat = this.seats.get(scope.namespaceId), sourceIds = new Set(historyIndexSourceIds(scope.sessionId, unitId))
    if (seat) for (const id of seat.vectors.keys()) {
      const [topicId, sourceId] = JSON.parse(id) as string[]
      if (topicId === scope.topicId && sourceIds.has(sourceId!)) seat.vectors.delete(id)
    }
  }
  async search(namespaceId: string, topicId: string, query: string, peer: string, signal: AbortSignal, sessionIds: readonly string[] = [], targetLanguage?: string) {
    const report = diagnosticSpan(this.ctx, 'memory.search', { queryCodePoints: Array.from(query).length, openedSessions: sessionIds.length }, topicId)
    this.searches++
    try {
      const seat = await this.seat(namespaceId, peer)
      let collection = await this.collect(namespaceId, peer, signal, topicId, sessionIds), queryVector: readonly number[] | undefined, reason: string | undefined, space = ''
      try {
        const config = await this.embedding.configuration()
        if (config && seat.enabled) {
          space = configKey(config); await this.cache(seat, space)
          this.check(namespaceId, peer); signal.throwIfAborted()
          if (collection.chunks.some(row => seat.vectors.has(identity(row)))) {
            queryVector = normalized((await this.embedding.embed([query], signal, config.revision)).vectors[0]!)
            if (!queryVector) throw failure('查询未取得有效向量。')
          }
          const current = await this.embedding.configuration()
          if (!current || current.revision !== config.revision) { queryVector = undefined; reason = '嵌入配置已变化，本次仅使用词面匹配。' }
        } else reason = '尚未建立记忆索引，本次仅使用词面匹配。'
      } catch (error) { report('degraded', { fallback: 'keyword' }, error); signal.throwIfAborted(); queryVector = undefined; reason = '语义服务暂不可用，本次仅使用词面匹配；仍可按引用读取。' }
      collection = await this.collect(namespaceId, peer, signal, topicId, sessionIds); this.check(namespaceId, peer)
      const words = [...new Set(query.toLowerCase().trim().split(/\s+/u))]
      const keyword = collection.chunks.map(row => ({ row, score: words.reduce((sum, word) => sum + ((row.keywordText ?? row.text).toLowerCase().includes(word) ? 1 : 0), 0) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score)
      let dimensionsChanged = false
      const semantic = queryVector && seat.config === space ? collection.chunks.flatMap(row => {
        const vector = seat.vectors.get(identity(row)); if (!vector) return []
        if (vector.length !== queryVector!.length) { dimensionsChanged = true; return [] }
        return [{ row, score: vector.reduce((sum, value, i) => sum + value * queryVector![i]!, 0) }]
      }).sort((a, b) => b.score - a.score) : []
      if (dimensionsChanged) { semantic.length = 0; reason = '嵌入维度与现有索引不同，请重建；本次仅使用词面匹配。' }
      const ranked: Chunk[] = [], seen = new Set<string>()
      for (let i = 0; i < Math.max(keyword.length, semantic.length); i++) for (const item of [keyword[i], semantic[i]]) if (item && !seen.has(identity(item.row))) { seen.add(identity(item.row)); ranked.push(item.row) }
      if (targetLanguage) {
        const records = ranked.filter(row => row.ref.kind === 'translation_record').sort((a, b) => Number(b.ref.kind === 'translation_record' && languageMatches(b.ref.targetLanguage, targetLanguage)) - Number(a.ref.kind === 'translation_record' && languageMatches(a.ref.targetLanguage, targetLanguage)))
        let offset = 0; ranked.forEach((row, i) => { if (row.ref.kind === 'translation_record') ranked[i] = records[offset++]! })
      }
      const counts = new Map<string, number>(), matches: { readonly ref: Chunk['ref']; readonly excerpt: string; readonly origin: string }[] = []
      for (const row of ranked) {
        const object = row.ref.kind === 'translation_record' ? JSON.stringify([row.ref.selection.sessionId, row.ref.selection.unitId]) : row.sourceId
        if ((counts.get(object) ?? 0) >= 2) continue
        if (matches.length >= 8) break
        const item = { ref: row.ref, excerpt: row.text, origin: row.origin }
        if (referenceBytes({ matches: [...matches, item] }) > 24000) break
        matches.push(item); counts.set(object, (counts.get(object) ?? 0) + 1)
      }
      const indexed = seat.config === space ? collection.chunks.filter(row => seat.vectors.has(identity(row))).length : 0
      report(reason ? 'degraded' : 'completed', { matches: matches.length, keywordMatches: keyword.length, vectorMatches: semantic.length, indexed, total: collection.chunks.length, unavailableFiles: collection.unavailable, unsegmentedFiles: collection.unsegmented, unsupportedFiles: collection.unsupported, unavailableRecords: collection.unavailableRecords, dimensionsChanged, fallback: !!reason })
      return { matches, method: semantic.length ? 'keyword+vector' : 'keyword', ...(reason === undefined ? {} : { reason }), resultsLimited: ranked.length > matches.length,
        coverage: { categories: ['entity', 'fact', 'relation', 'reference_file', 'translation_record'], excluded: ['old_translation_revisions', 'unadopted_candidates', 'legacy_reference_segments', 'terms', 'settings'], totalSegments: collection.chunks.length, vectorSegments: indexed,
          unsupportedFiles: collection.unsupported, unsegmentedFiles: collection.unsegmented, unavailableFiles: collection.unavailable, unavailableRecords: collection.unavailableRecords, complete: indexed === collection.chunks.length && collection.unsupported === 0 && collection.unsegmented === 0 && collection.unavailable === 0 && collection.unavailableRecords === 0 && !reason } }
    } catch (error) { report(signal.aborted ? 'cancelled' : 'failed', {}, error); throw error }
    finally { this.searches-- }
  }
  forgetTopic(namespaceId: string, topicId: string): void {
    const seat = this.seats.get(namespaceId)
    if (seat) for (const id of seat.vectors.keys()) if ((JSON.parse(id) as string[])[0] === topicId) seat.vectors.delete(id)
    this.contentChanged()
  }
  async verify(namespaceId: string, topicId: string, peer: string, matches: readonly { readonly ref: Chunk['ref']; readonly excerpt: string }[], signal: AbortSignal, sessionIds: readonly string[] = []): Promise<boolean> {
    const current = await this.collect(namespaceId, peer, signal, topicId, sessionIds)
    return matches.every(match => current.chunks.some(row => JSON.stringify(row.ref) === JSON.stringify(match.ref) && row.text === match.excerpt))
  }
  hasActiveJobs(): boolean { return this.searches > 0 || this.recordJobs.size > 0 || [...this.seats.values()].some(seat => !!seat.job) }
  async dispose(): Promise<void> { this.disposed = true; for (const seat of this.seats.values()) seat.controller?.abort(); for (const job of this.recordJobs.values()) job.controller.abort(); await this.tail; this.seats.clear() }
}
