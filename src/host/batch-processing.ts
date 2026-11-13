import { BATCH_OPERATION_PREFIX, batchOperationId, parseBatchRequest, parseProcessingBatch, unfinishedBatchItem, type BatchItem, type BatchRequest, type BatchView, type ProcessingBatch } from '../shared/batch-processing.js'
import type { HistoryScope } from '../shared/history-bundle.js'
import type { ImageUnitTarget } from '../shared/image-translation.js'
import { isImageUnit } from '../memory/translation-history.js'
import type { HistoryService } from './history.js'
import type { LocalDataService } from './local-data.js'
import type { NormalTranslationService } from './normal-translation.js'
import { sourceSha256 } from './source-storage.js'
import type { TopicHostContext, TopicToolsService } from './topic-tools.js'
import type { TranslationMaterialsService } from './translation-materials.js'
import type { TranslationSourcesService } from './translation-sources.js'

interface BatchStorage {
  read(key: string): Promise<ProcessingBatch[]>
  write(key: string, batches: readonly ProcessingBatch[]): Promise<void>
  remove(key: string): Promise<void>
}

const scopeKey = (scope: HistoryScope): string => JSON.stringify([scope.namespaceId, scope.topicId, scope.sessionId])
const errorText = (error: unknown): string => (error instanceof Error && error.message ? error.message : '批量处理未完成。').slice(0, 900)

async function batchStorage(ctx: TopicHostContext): Promise<BatchStorage> {
  const loader = ctx.get?.('loader') as TopicHostContext['loader']
  if (!ctx.baseUrl || !loader?.internal) throw new Error('批次存储尚未就绪。')
  const [home, atomic] = await Promise.all([
    loader.internal.import('@deepseek-ai/dsh-home-paths', ctx.baseUrl, {}) as Promise<{ dshHomePath(...parts: string[]): string }>,
    loader.internal.import('@deepseek-ai/dsh-atomic-write', ctx.baseUrl, {}) as Promise<{ writeFileAtomic(path: string, data: string, options: object): Promise<void> }>,
  ])
  const fsName = 'node:fs/promises'
  const fs = await import(fsName) as { readFile(path: string, encoding: 'utf8'): Promise<string>; unlink(path: string): Promise<void> }
  const locate = async (key: string) => home.dshHomePath('translation-plugin', 'batches', 'v1', (await sourceSha256(new TextEncoder().encode(key))) + '.json')
  const missing = (error: unknown): boolean => (error as { code?: string } | null)?.code === 'ENOENT'
  return {
    async read(key) {
      try {
        const value: unknown = JSON.parse(await fs.readFile(await locate(key), 'utf8'))
        if (!Array.isArray(value)) throw new TypeError('批次记录无法读取。')
        return value.map(parseProcessingBatch)
      } catch (error) { if (missing(error)) return []; throw error }
    },
    async write(key, batches) { await atomic.writeFileAtomic(await locate(key), JSON.stringify(batches), { mode: 0o600, dirMode: 0o700 }) },
    async remove(key) { try { await fs.unlink(await locate(key)) } catch (error) { if (!missing(error)) throw error } },
  }
}

interface Run {
  readonly batchId: string
  readonly controller: AbortController
  paused: boolean
}
interface Operation {
  readonly key: string
  readonly namespaceId: string
  readonly target: ImageUnitTarget
  noText: boolean
}

/** Batch progress owns references. Image text and result revisions stay in the ordinary history. */
export class BatchProcessingService {
  readonly typertRemote: { readonly service: BatchProcessingService; readonly serviceKey: 'translationBatchProcessing'; readonly namespace: 'translationBatchProcessing' } =
    { service: this, serviceKey: 'translationBatchProcessing', namespace: 'translationBatchProcessing' }
  private storage: Promise<BatchStorage> | undefined
  private readonly records = new Map<string, Promise<ProcessingBatch[]>>()
  private readonly requests = new Map<string, Promise<unknown>>()
  private readonly runs = new Map<string, Run>()
  private readonly operations = new Map<string, Operation>()
  private readonly notices = new Map<string, string>()
  private readonly retired = new Set<string>()
  private disposed = false

  constructor(private readonly ctx: TopicHostContext, private readonly loadStorage = () => batchStorage(ctx)) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationBatchProcessing', property: 'ctx' } })
  }
  private get topics() { return this.ctx.get?.('translationTopics') as TopicToolsService }
  private get history() { return this.ctx.get?.('translationHistory') as HistoryService }
  private get normal() { return this.ctx.get?.('translationNormal') as NormalTranslationService }
  private get localData() { return this.ctx.get?.('translationLocalData') as LocalDataService | undefined }

  private store(): Promise<BatchStorage> {
    if (!this.storage) {
      const loading = this.loadStorage()
      this.storage = loading
      void loading.catch(() => { if (this.storage === loading) this.storage = undefined })
    }
    return this.storage
  }

  private load(key: string): Promise<ProcessingBatch[]> {
    let pending = this.records.get(key)
    if (!pending) {
      pending = this.store().then(storage => storage.read(key))
      this.records.set(key, pending)
      void pending.catch(() => { if (this.records.get(key) === pending) this.records.delete(key) })
    }
    return pending
  }

  private async save(key: string, records: ProcessingBatch[], value: ProcessingBatch, durable: boolean): Promise<void> {
    const next = records.some(batch => batch.id === value.id)
      ? records.map(batch => batch.id === value.id ? value : batch) : [...records, value]
    const write = async () => {
      if (this.disposed || this.retired.has(key)) throw new Error('批次所属会话已关闭。')
      if (durable) await (await this.store()).write(key, next)
      records.splice(0, records.length, ...next)
    }
    await (this.localData?.storageWriter() ?? (fn => fn()))(write)
  }

  private authorize(scope: BatchRequest, peer: string | undefined): asserts peer is string {
    if (this.disposed || this.retired.has(scopeKey(scope)) || !peer || !this.topics?.ownsLibrary(scope.namespaceId, peer)) throw new Error('批次不属于当前资料库连接。')
  }

  batch(input: unknown): Promise<BatchView> {
    const request = parseBatchRequest(input), peer = this.ctx.invocation?.peer.id, key = scopeKey(request)
    this.authorize(request, peer)
    const previous = this.requests.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(() => this.handle(request, peer))
    this.requests.set(key, next)
    void next.finally(() => { if (this.requests.get(key) === next) this.requests.delete(key) }).catch(() => {})
    return next
  }

  private async handle(request: BatchRequest, peer: string): Promise<BatchView> {
    this.authorize(request, peer)
    const key = scopeKey(request), records = await this.load(key)
    this.authorize(request, peer)
    const running = this.runs.get(key)
    const unfinished = request.batchId ? [] : records.filter(batch => batch.items.some(unfinishedBatchItem)).reverse()
    const found = request.batchId ? records.find(batch => batch.id === request.batchId)
      : records.find(batch => batch.id === running?.batchId)
        ?? unfinished.find(batch => batch.mainSessionId === request.mainSessionId) ?? unfinished[0]
    if (request.kind === 'read') return this.view(key, records, found)
    if (!this.topics.ownsConnection(request.mainSessionId, peer)) throw new Error('请等待当前主会话连接就绪。')
    if (request.kind === 'pause') {
      if (found?.mainSessionId !== request.mainSessionId) throw new Error('请在发起批次的主会话中暂停。')
      if (found?.id === running?.batchId && running) running.paused = true
      return this.view(key, records, found)
    }
    if (request.kind === 'start' && found) {
      if (found.mainSessionId !== request.mainSessionId || found.requirements !== request.requirements ||
        found.items.length !== request.unitIds.length || found.items.some((item, index) => item.unitId !== request.unitIds[index])) throw new Error('批次 ID 已用于另一份清单。')
      return this.view(key, records, found)
    }
    if (running) throw new Error('此会话已有一个批次在处理当前项。')
    const history = await this.history.batchHistory(request, peer)
    if (history.current.session.mode !== 'normal' || history.current.session.archivedAt !== null) throw new Error('请先打开普通翻译会话。')
    const durable = history.saved !== null
    let batch = found
    if (request.kind === 'start') {
      const items = request.unitIds.map(unitId => {
        const unit = history.current.history.units.find(unit => unit.id === unitId)
        if (!unit || !isImageUnit(unit) || !unit.original || unit.deletion) throw new Error('清单中的图片单元不可用。')
        if (durable && !history.saved?.history.units.some(saved => saved.id === unitId && !saved.deletion)) throw new Error('清单中有图片尚未保存，请重试。')
        return { unitId, name: unit.original.name, state: 'pending' as const }
      })
      batch = { id: request.batchId, mainSessionId: request.mainSessionId, action: request.action, requirements: request.requirements, items }
      await this.save(key, records, batch, durable)
    }
    if (!batch || batch.mainSessionId !== request.mainSessionId) throw new Error('请在发起批次的主会话中继续。')
    const index = batch.items.findIndex(unfinishedBatchItem), item = batch.items[index]
    if (!item) return this.view(key, records, batch)
    if (request.kind === 'retry' || request.kind === 'skip') {
      if (item.state !== 'failed' && !(request.kind === 'skip' && item.state === 'pending')) throw new Error('请先确认当前操作结果。')
      if (item.operationId) this.operations.delete(item.operationId)
      batch = this.replace(batch, index, { unitId: item.unitId, name: item.name, state: request.kind === 'skip' ? 'skipped' : 'pending' })
      await this.save(key, records, batch, durable)
    }
    this.startRun(request, peer, key, records, batch, durable)
    return this.view(key, records, batch)
  }

  private view(key: string, records: ProcessingBatch[], batch?: ProcessingBatch): BatchView {
    const message = this.notices.get(key)
    const run = this.runs.get(key)
    const running = !!batch && run?.batchId === batch.id
    return {
      batches: records.filter(value => value.items.some(unfinishedBatchItem)).reverse().map(value => ({
        id: value.id, name: value.items[0]!.name, completed: value.items.filter(item => item.state === 'completed').length, total: value.items.length,
      })),
      batch: batch ?? null, running, ...(running && run.paused ? { pausing: true } : {}),
      ...(message ? { message } : {}),
    }
  }

  private replace(batch: ProcessingBatch, index: number, item: BatchItem): ProcessingBatch {
    const items = [...batch.items]; items[index] = item
    return { ...batch, items }
  }

  private startRun(scope: BatchRequest, peer: string, key: string, records: ProcessingBatch[], batch: ProcessingBatch, durable: boolean): void {
    const run: Run = { batchId: batch.id, paused: false, controller: new AbortController() }
    this.notices.delete(key)
    this.runs.set(key, run)
    void this.advance(scope, peer, key, records, batch, durable, run)
      .catch(error => { if (!this.disposed && !this.retired.has(key)) this.notices.set(key, errorText(error)) })
      .finally(() => { if (this.runs.get(key) === run) this.runs.delete(key) })
  }

  private async advance(scope: BatchRequest, peer: string, key: string, records: ProcessingBatch[], batch: ProcessingBatch, durable: boolean, run: Run): Promise<void> {
    const signal = run.controller.signal
    while (!run.paused && !signal.aborted) {
      const index = batch.items.findIndex(unfinishedBatchItem), item = batch.items[index]
      if (!item || item.state === 'failed') return
      this.authorize(scope, peer)
      const history = await this.history.batchHistory(scope, peer)
      if (run.paused || signal.aborted) return
      if (history.current.session.mode !== 'normal' || history.current.session.archivedAt !== null) throw new Error('请恢复普通翻译会话后继续。')
      let settled: BatchItem
      const unit = history.current.history.units.find(candidate => candidate.id === item.unitId)
      if (!unit || !isImageUnit(unit) || unit.deletion || !unit.original) {
        settled = { ...item, state: 'failed', message: '图片单元已删除或不可用。' }
      } else if (item.operationId) {
        settled = await this.observe(scope, peer, batch, item, durable)
      } else {
        if (this.normal.isSessionExecuting(scope.sessionId)) throw new Error('会话还有翻译在执行，结束后可继续批次。')
        const operationId = BATCH_OPERATION_PREFIX + crypto.randomUUID()
        const processing: BatchItem = { ...item, state: 'processing', operationId }
        const target: ImageUnitTarget = { kind: 'image_unit', mainSessionId: batch.mainSessionId, translationSessionId: scope.sessionId, unitId: unit.id }
        batch = this.replace(batch, index, processing)
        await this.save(key, records, batch, durable)
        if (signal.aborted) return
        if (run.paused) {
          await this.save(key, records, this.replace(batch, index, item), durable)
          return
        }
        this.operations.set(operationId, { key, namespaceId: scope.namespaceId, target, noText: false })
        try {
          const sources = this.ctx.get?.('translationSources') as TranslationSourcesService
          const materials = this.ctx.get?.('translationMaterials') as TranslationMaterialsService
          const path = unit.source.trim() ? undefined : await sources.batchImagePath(scope, unit.original, peer)
          await materials.runBatchImage({ target, operationId, path, name: item.name, requirements: batch.requirements,
            position: index + 1, total: batch.items.length }, peer, signal)
        } catch (error) {
          if (signal.aborted) return
          this.notices.set(key, errorText(error))
        }
        if (signal.aborted) return
        settled = await this.observe(scope, peer, batch, processing, durable, true)
      }
      batch = this.replace(batch, index, settled)
      await this.save(key, records, batch, durable)
      if (settled.state !== 'processing' && settled.operationId) this.operations.delete(settled.operationId)
      if (settled.state !== 'completed') return
    }
  }

  private async observe(scope: HistoryScope, peer: string, batch: ProcessingBatch, item: BatchItem, durable: boolean, turnEnded = false): Promise<BatchItem> {
    const operationId = item.operationId!
    const history = await this.history.batchHistory(scope, peer)
    const find = (bundle: typeof history.current | null) => {
      const unit = bundle?.history.units.find(candidate => candidate.id === item.unitId)
      if (!unit || !isImageUnit(unit) || unit.deletion) return undefined
      return [...unit.revisions].reverse().find(revision => batchOperationId(revision.operationId, revision.callRecord?.context?.contextSupplement) === operationId)
    }
    const result = find(durable ? history.saved : history.current)
    if (result?.status === 'completed') {
      const { message: _waiting, ...settled } = item
      return { ...settled, state: 'completed', revisionId: result.id }
    }
    if (result && ['failed', 'cancelled', 'interrupted', 'deleted'].includes(result.status)) return { ...item, state: 'failed', message: result.message?.slice(0, 900) || '本项翻译未完成。' }
    if (durable && find(history.current)?.status === 'completed') return { ...item, state: 'processing', message: '译文已记录，正在等待会话保存。' }
    const operation = this.operations.get(operationId)
    if (operation?.noText) return { ...item, state: 'completed', message: '无待译文字' }
    const status = await this.normal.batchDirectStatus(batch.mainSessionId, operationId)
    if (status === 'needs_context') return { ...item, state: 'processing', message: '主会话正在等待补充。补充后可继续批次。' }
    if (status === 'running' || status === 'unknown' || status === 'completed') return { ...item, state: 'processing', message: '尚未确认本项结果，请检查单元后继续。' }
    if (!operation || turnEnded || status === 'failed' || status === 'cancelled') {
      return { ...item, state: 'failed', message: this.notices.get(scopeKey(scope)) ?? '本项已停止，尚未取得结果。可重试或跳过。' }
    }
    return { ...item, state: 'processing', message: '尚未确认本项结果，请检查主会话。' }
  }

  allows(operationId: string, target: ImageUnitTarget): boolean {
    const operation = this.operations.get(operationId)
    return !this.disposed && !!operation && !this.retired.has(operation.key) &&
      this.topics.namespaceForAgent(target.mainSessionId) === operation.namespaceId &&
      operation.target.mainSessionId === target.mainSessionId && operation.target.translationSessionId === target.translationSessionId && operation.target.unitId === target.unitId
  }

  ownsActiveTarget(target: ImageUnitTarget): boolean {
    return [...this.operations].some(([operationId, operation]) => this.runs.has(operation.key) && this.allows(operationId, target))
  }

  markNoText(operationId: string): void { const item = this.operations.get(operationId); if (item) item.noText = true }
  hasActiveJobs(): boolean { return this.runs.size > 0 }
  historyUnitBusy(scope: HistoryScope, unitId: string): boolean {
    const key = scopeKey(scope)
    return this.runs.has(key) && (unitId === '*' || [...this.operations.values()].some(operation => operation.key === key && operation.target.unitId === unitId))
  }

  /** The history writer already owns the local-data write gate. */
  async retireLocked(scope: HistoryScope): Promise<void> {
    const key = scopeKey(scope)
    this.retired.add(key)
    this.runs.get(key)?.controller.abort()
    this.runs.delete(key); this.records.delete(key); this.notices.delete(key)
    for (const [id, operation] of this.operations) if (operation.key === key) this.operations.delete(id)
    await (await this.store()).remove(key)
  }

  dispose(): void {
    this.disposed = true
    for (const run of this.runs.values()) run.controller.abort()
    this.runs.clear(); this.operations.clear(); this.records.clear(); this.requests.clear(); this.notices.clear()
  }
}
