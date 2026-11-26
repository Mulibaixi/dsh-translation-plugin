import { BATCH_OPERATION_PREFIX, batchOperationId, parseBatchRequest, parseProcessingBatch, unfinishedBatch, unfinishedBatchItem, type BatchItem, type BatchRevision, type BatchRequest, type BatchView, type ProcessingBatch } from '../shared/batch-processing.js'
import type { HistoryScope } from '../shared/history-bundle.js'
import { INSTALL_BUSY_MESSAGE } from '../shared/plugin-update.js'
import { imageInputKey, type ImageUnitTarget } from '../shared/image-translation.js'
import { isImageUnit } from '../memory/translation-history.js'
import type { HistoryService } from './history.js'
import type { LocalDataService } from './local-data.js'
import type { NormalTranslationService } from './normal-translation.js'
import { sourceSha256 } from './source-storage.js'
import type { MainAgent, TopicHostContext, TopicToolsService } from './topic-tools.js'
import type { TranslationMaterialsService } from './translation-materials.js'
import type { TranslationSourcesService } from './translation-sources.js'
import { installingTranslationUpdate } from './plugin-update-gate.js'

interface BatchStorage {
  read(key: string): Promise<ProcessingBatch[]>
  write(key: string, batches: readonly ProcessingBatch[]): Promise<void>
  remove(key: string): Promise<void>
}

import { batchNotice, batchTurns, isRuntimeContext, noticeScope, untaggedBatchResults } from './batch-notices.js'

const FINISHING_BATCH = '已终止，当前调用收尾中。'
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
  readonly batchId: string
  lastRejected?: boolean
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
  private readonly admittedSteps = new WeakMap<MainAgent, { turn: number; messages: readonly { source: unknown }[] }>()
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
    return this.serial(key, () => this.handle(request, peer))
  }

  private serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.requests.get(key) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(task)
    this.requests.set(key, next)
    void next.finally(() => { if (this.requests.get(key) === next) this.requests.delete(key) }).catch(() => {})
    return next
  }

  private async handle(request: BatchRequest, peer: string): Promise<BatchView> {
    this.authorize(request, peer)
    const key = scopeKey(request), records = await this.load(key)
    this.authorize(request, peer)
    const running = this.runs.get(key)
    const unfinished = request.batchId ? [] : records.filter(unfinishedBatch).reverse()
    let found = request.batchId ? records.find(batch => batch.id === request.batchId)
      : records.find(batch => batch.id === running?.batchId)
        ?? unfinished.find(batch => batch.mainSessionId === request.mainSessionId) ?? unfinished[0]
    if (found && !found.terminated && !running && found.mainSessionId === request.mainSessionId &&
      (request.kind === 'read' || request.kind === 'continue' || request.kind === 'retry' || request.kind === 'skip')) {
      const recovered = await this.reconcileFailed(request, peer, key, records, found)
      if (recovered !== found && (request.kind === 'retry' || request.kind === 'skip')) return this.view(key, records, recovered)
      found = recovered
    }
    if (request.kind === 'read') {
      const batch = found?.terminated ? await this.reconcileTerminated(request, peer, key, records, found) : found
      return this.view(key, records, batch)
    }
    if (!this.topics.ownsConnection(request.mainSessionId, peer)) throw new Error('请等待当前主会话连接就绪。')
    if (request.kind === 'terminate') {
      if (!found || found.mainSessionId !== request.mainSessionId) throw new Error('请在发起批次的主会话中终止。')
      if (!unfinishedBatch(found)) return this.view(key, records, found)
      const history = await this.history.batchHistory(request, peer)
      const { reviewPending: _review, ...prior } = found
      const terminal = { ...prior, terminated: true as const }
      await this.save(key, records, terminal, history.saved !== null)
      if (running?.batchId === found.id) running.controller.abort()
      this.notices.delete(key)
      const notice = await this.withdrawNotices(request, terminal)
      if (notice) this.notices.set(key, notice)
      return this.view(key, records, terminal)
    }
    if (found?.terminated && request.kind !== 'start') return this.view(key, records, found)
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
    if (installingTranslationUpdate(this.ctx)) throw new Error(INSTALL_BUSY_MESSAGE)
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
      batch = { id: request.batchId, mainSessionId: request.mainSessionId, action: request.action, requirements: request.requirements, items, reviewPending: true }
      await this.save(key, records, batch, durable)
    }
    if (!batch || batch.mainSessionId !== request.mainSessionId) throw new Error('请在发起批次的主会话中继续。')
    const index = batch.items.findIndex(unfinishedBatchItem), item = batch.items[index]
    if (!item && (!batch.reviewPending || request.kind !== 'continue')) return this.view(key, records, batch)
    const upgradeReview = item !== undefined && !batch.reviewPending
    if (upgradeReview) batch = { ...batch, reviewPending: true }
    if (request.kind === 'retry' || request.kind === 'skip') {
      if (!item || item.state !== 'failed' && !(request.kind === 'skip' && item.state === 'pending')) throw new Error('请先确认当前操作结果。')
      if (item.operationId) this.operations.delete(item.operationId)
      batch = this.replace(batch, index, { unitId: item.unitId, name: item.name, state: request.kind === 'skip' ? 'skipped' : 'pending' })
    }
    if (upgradeReview || request.kind === 'retry' || request.kind === 'skip') await this.save(key, records, batch, durable)
    if (installingTranslationUpdate(this.ctx)) throw new Error(INSTALL_BUSY_MESSAGE)
    this.startRun(request, peer, key, records, batch, durable)
    return this.view(key, records, batch)
  }

  private async reconcileFailed(scope: HistoryScope, peer: string, key: string, records: ProcessingBatch[], batch: ProcessingBatch): Promise<ProcessingBatch> {
    const index = batch.items.findIndex(unfinishedBatchItem), item = batch.items[index]
    if (item?.state !== 'failed' || !item.operationId || !this.liveAgent(batch.mainSessionId)) return batch
    try {
      const history = await this.history.batchHistory(scope, peer)
      const result = await this.observe(scope, peer, batch, item, history.saved !== null)
      if (result.state !== 'completed') return batch
      const updated = this.replace(batch, index, result)
      await this.save(key, records, updated, history.saved !== null)
      return updated
    } catch { return batch }
  }

  private async reconcileTerminated(scope: HistoryScope, peer: string, key: string, records: ProcessingBatch[], batch: ProcessingBatch): Promise<ProcessingBatch> {
    if (this.notices.get(key) === FINISHING_BATCH && this.currentTurn(this.liveAgent(batch.mainSessionId)) === undefined) this.notices.delete(key)
    if (!batch.items.some(item => unfinishedBatchItem(item) && item.operationId)) return batch
    try {
      const history = await this.history.batchHistory(scope, peer)
      const bundle = history.saved ?? history.current
      let changed = false
      const items = batch.items.map(item => {
        if (!unfinishedBatchItem(item) || !item.operationId) return item
        const unit = bundle.history.units.find(candidate => candidate.id === item.unitId)
        if (!unit || !isImageUnit(unit) || unit.deletion) return item
        const result = [...unit.revisions].reverse().find(revision => revision.status === 'completed' && revision.batchRevision?.dispatchId === item.operationId)
        if (!result) return item
        changed = true
        const { message: _old, ...rest } = item
        return { ...rest, state: 'completed' as const, revisionId: result.id }
      })
      if (!changed) return batch
      const updated = { ...batch, items }
      await this.save(key, records, updated, history.saved !== null)
      return updated
    } catch { return batch }
  }

  recordNoticeStep(agent: MainAgent, messages: readonly { source: unknown }[]): void {
    const turn = this.currentTurn(agent)
    if (turn !== undefined) this.admittedSteps.set(agent, { turn, messages })
  }

  private view(key: string, records: ProcessingBatch[], batch?: ProcessingBatch): BatchView {
    const message = this.notices.get(key)
    const run = this.runs.get(key)
    const running = !!batch && !batch.terminated && run?.batchId === batch.id
    return {
      batches: records.filter(unfinishedBatch).reverse().map(value => ({
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

  private saveProgress(key: string, records: ProcessingBatch[], batch: ProcessingBatch, durable: boolean, run: Run): Promise<boolean> {
    return this.serial(key, async () => {
      const latest = records.find(entry => entry.id === batch.id)
      if (run.controller.signal.aborted || latest?.terminated) return false
      await this.save(key, records, batch, durable)
      return true
    })
  }

  private liveAgent(mainSessionId: string): MainAgent | undefined {
    return (this.ctx.get?.('agents') as { get(id: string): MainAgent | undefined } | undefined)?.get(mainSessionId)
  }

  async admitNotice(source: NonNullable<ReturnType<typeof batchNotice>>): Promise<boolean> {
    const key = scopeKey(noticeScope(source))
    if (this.retired.has(key) || this.disposed) return false
    const batch = (await this.load(key)).find(entry => entry.id === source.batchId && entry.mainSessionId === source.mainSessionId)
    if (!batch || batch.terminated) return false
    if (!source.unitId) return batch.reviewPending === true && source.operationId === batch.id
    const item = batch.items.find(unfinishedBatchItem)
    if (item?.state !== 'processing' || item.unitId !== source.unitId || item.operationId !== source.operationId) return false
    this.operations.set(source.operationId, { key, namespaceId: source.namespaceId, batchId: source.batchId, target: {
      kind: 'image_unit', mainSessionId: source.mainSessionId, translationSessionId: source.translationSessionId, unitId: source.unitId,
    } })
    return true
  }

  dispatchFor(target: ImageUnitTarget, agent: MainAgent): Pick<BatchRevision, 'turn' | 'dispatchId'> | undefined {
    const turn = batchTurns(agent).at(-1)
    if (!turn || turn.end) return undefined
    const userMessages = turn.messages.filter(message => !isRuntimeContext(message))
    if (userMessages.length !== 1) return undefined
    const source = batchNotice(userMessages[0]!.source, agent.id), operation = source && this.operations.get(source.operationId)
    if (!source || !operation || operation.namespaceId !== this.topics.namespaceForAgent(agent.id) ||
      operation.target.mainSessionId !== target.mainSessionId || operation.target.translationSessionId !== target.translationSessionId ||
      operation.target.unitId !== target.unitId) return undefined
    return { dispatchId: source.operationId, turn: turn.turn }
  }

  noteTranslationOutcome(dispatchId: string, rejected: boolean): void {
    const operation = this.operations.get(dispatchId)
    if (operation) operation.lastRejected = rejected
  }

  currentTurn(agent: MainAgent | undefined): number | undefined {
    const turn = batchTurns(agent).at(-1)
    return turn && !turn.end ? turn.turn : undefined
  }

  private async withdrawNotices(scope: HistoryScope, batch: ProcessingBatch): Promise<string | undefined> {
    const agent = this.liveAgent(batch.mainSessionId)
    if (!agent) return undefined
    const belongs = (message: { source: unknown }): boolean => {
      const source = batchNotice(message.source, agent.id)
      return !!source && source.batchId === batch.id && scopeKey(noticeScope(source)) === scopeKey(scope)
    }
    for (const message of [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])]) {
      if (belongs(message)) agent.inbox?.remove?.(message.id)
    }
    const turn = batchTurns(agent).at(-1)
    if (!turn || turn.end) return undefined
    const step = this.admittedSteps.get(agent)
    if (!turn.messages.some(belongs) && !(step?.turn === turn.turn && step.messages.some(belongs))) return undefined
    const unrelatedClaimed = step?.turn === turn.turn && step.messages.some(message =>
      !belongs(message) && !isRuntimeContext(message))
    if (agent.cancel && !unrelatedClaimed && turn.messages.every(message => belongs(message) || isRuntimeContext(message)) &&
      !agent.inbox?.nextStep.some(message => !belongs(message) && !isRuntimeContext(message))) {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      if (agent.inbox?.nextTurn.length) {
        const materials = this.ctx.get?.('translationMaterials') as TranslationMaterialsService | undefined
        try {
          if (materials) await materials.wakeBatchQueue(agent)
        } catch { return '已终止，其他请求仍在主会话队列。' }
      }
      return undefined
    }
    return FINISHING_BATCH
  }

  private startRun(scope: BatchRequest, peer: string, key: string, records: ProcessingBatch[], batch: ProcessingBatch, durable: boolean): void {
    const run: Run = { batchId: batch.id, paused: false, controller: new AbortController() }
    this.notices.delete(key)
    this.runs.set(key, run)
    void this.advance(scope, peer, key, records, batch, durable, run)
      .catch(error => { if (!run.controller.signal.aborted && !this.disposed && !this.retired.has(key)) this.notices.set(key, errorText(error)) })
      .finally(() => {
        if (this.runs.get(key) === run) this.runs.delete(key)
        if (run.controller.signal.aborted) for (const [id, operation] of this.operations) {
          if (operation.key === key && operation.batchId === run.batchId) this.operations.delete(id)
        }
      })
  }

  private async advance(scope: BatchRequest, peer: string, key: string, records: ProcessingBatch[], batch: ProcessingBatch, durable: boolean, run: Run): Promise<void> {
    const signal = run.controller.signal
    while (!run.paused && !signal.aborted) {
      const index = batch.items.findIndex(unfinishedBatchItem), item = batch.items[index]
      if (item?.state === 'failed' || (!item && !batch.reviewPending)) return
      this.authorize(scope, peer)
      const history = await this.history.batchHistory(scope, peer)
      if (run.paused || signal.aborted) return
      if (history.current.session.mode !== 'normal' || history.current.session.archivedAt !== null) throw new Error('请恢复普通翻译会话后继续。')
      if (!item) {
        const units = new Map(history.current.history.units.map(unit => [unit.id, unit]))
        const pages = batch.items.map((entry, position) => ({ entry, position: position + 1, unit: units.get(entry.unitId) }))
        const targets = pages.flatMap(({ entry, position, unit }) =>
          entry.state === 'completed' && entry.revisionId && unit && isImageUnit(unit) && !unit.deletion
            ? [{ unitId: unit.id, unitNumber: unit.order, position }] : [])
        if (targets.length) {
          const materials = this.ctx.get?.('translationMaterials') as TranslationMaterialsService
          const reviewed = await materials.runBatchReview({ scope, batchId: batch.id, mainSessionId: batch.mainSessionId,
            translationSessionId: scope.sessionId, requirements: batch.requirements, targets,
            skipped: pages.filter(({ entry }) => entry.state === 'skipped').map(({ position }) => position),
            empty: pages.filter(({ entry }) => entry.state === 'completed' && !entry.revisionId).map(({ position }) => position) }, peer, signal, () => !run.paused)
          if (!reviewed || signal.aborted) return
        }
        const { reviewPending: _pending, ...completed } = batch
        await this.saveProgress(key, records, completed, durable, run)
        return
      }
      let settled: BatchItem
      const unit = history.current.history.units.find(candidate => candidate.id === item.unitId)
      if (!unit || !isImageUnit(unit) || unit.deletion || !unit.original) {
        settled = { ...item, state: 'failed', message: '图片单元已删除或不可用。' }
      } else if (item.operationId) {
        settled = await this.observe(scope, peer, batch, item, durable)
      } else {
        const operationId = BATCH_OPERATION_PREFIX + crypto.randomUUID()
        const processing: BatchItem = { ...item, state: 'processing', operationId }
        const target: ImageUnitTarget = { kind: 'image_unit', mainSessionId: batch.mainSessionId, translationSessionId: scope.sessionId, unitId: unit.id }
        batch = this.replace(batch, index, processing)
        if (!await this.saveProgress(key, records, batch, durable, run)) return
        if (run.paused) {
          await this.saveProgress(key, records, this.replace(batch, index, item), durable, run)
          return
        }
        this.operations.set(operationId, { key, namespaceId: scope.namespaceId, target, batchId: batch.id })
        let confirmedEmpty = false
        try {
          const sources = this.ctx.get?.('translationSources') as TranslationSourcesService
          const materials = this.ctx.get?.('translationMaterials') as TranslationMaterialsService
          const original = async (sha256: string) => {
            if (sha256 !== unit.original!.sha256) throw new Error('图片单元的原图身份已变化。')
            return sources.readManagedImage(scope, unit.original!, peer)
          }
          confirmedEmpty = await materials.runBatchImage({ scope, batchId: batch.id, target, operationId, original, name: item.name, requirements: batch.requirements,
            position: index + 1, total: batch.items.length }, peer, signal) === 'empty'
        } catch (error) {
          if (signal.aborted) return
          this.notices.set(key, errorText(error))
        }
        if (signal.aborted) return
        settled = await this.observe(scope, peer, batch, processing, durable, true, confirmedEmpty)
      }
      batch = this.replace(batch, index, settled)
      if (!await this.saveProgress(key, records, batch, durable, run)) return
      if (settled.state !== 'processing' && settled.operationId) this.operations.delete(settled.operationId)
      if (settled.state !== 'completed') return
    }
  }

  private async observe(scope: HistoryScope, peer: string, batch: ProcessingBatch, item: BatchItem, durable: boolean, turnEnded = false, confirmedEmpty = false): Promise<BatchItem> {
    const operationId = item.operationId!
    const history = await this.history.batchHistory(scope, peer)
    const currentUnit = history.current.history.units.find(candidate => candidate.id === item.unitId)
    const current = currentUnit && isImageUnit(currentUnit) && !currentUnit.deletion ? currentUnit : undefined
    const digest = current ? await sourceSha256(new TextEncoder().encode(imageInputKey(current))) : undefined
    const agent = this.liveAgent(batch.mainSessionId), turns = batchTurns(agent)
    const isDispatchNotice = (message: { source: unknown }): boolean => {
      const source = batchNotice(message.source, batch.mainSessionId)
      return !!source && source.operationId === operationId && source.batchId === batch.id && source.unitId === item.unitId &&
        scopeKey(noticeScope(source)) === scopeKey(scope)
    }
    const dispatchTurn = turns.find(turn => turn.messages.some(isDispatchNotice))
    const dispatchNotice = dispatchTurn?.messages.find(isDispatchNotice)
    const recovered = agent && dispatchTurn && dispatchNotice && current?.revisions.some(revision => revision.status === 'completed' && !revision.batchRevision)
      ? untaggedBatchResults(agent, dispatchTurn, dispatchNotice,
        { kind: 'image_unit', mainSessionId: batch.mainSessionId, translationSessionId: scope.sessionId, unitId: item.unitId }, current)
      : undefined
    const saved = durable ? history.saved : history.current
    const savedUnit = saved?.history.units.find(unit => unit.id === item.unitId)
    if (current?.recognition?.status === 'empty' && current.recognition.requirements === batch.requirements &&
      savedUnit && isImageUnit(savedUnit) && savedUnit.recognition?.status === 'empty' && savedUnit.recognition.requirements === batch.requirements) {
      return { ...item, state: 'completed', message: '无待译文字' }
    }
    if (confirmedEmpty || current?.recognition?.status === 'empty' && current.recognition.requirements === batch.requirements) {
      return { ...item, state: 'processing', message: '无待译文字，正在等待会话保存。' }
    }
    const found = (bundle: typeof history.current | null) => {
      const unit = bundle?.history.units.find(candidate => candidate.id === item.unitId)
      return unit && isImageUnit(unit) && !unit.deletion ? unit.revisions.filter(revision => revision.batchRevision
        ? revision.batchRevision.dispatchId === operationId
        : (recovered?.(revision) || batchOperationId(revision.operationId, revision.callRecord?.context?.contextSupplement) === operationId)) : []
    }
    const revisions = found(saved), recorded = found(history.current)
    const eligible = (revision: (typeof recorded)[number]) => revision.batchRevision
      ? revision.batchRevision.inputDigest === digest : recovered?.(revision) || !dispatchTurn && !recorded.some(value => value.batchRevision)
    const result = [...revisions].reverse().find(revision => revision.status === 'completed' && eligible(revision))
    const last = recorded.at(-1)
    const resultTurn = last?.batchRevision?.turn ?? result?.batchRevision?.turn ?? dispatchTurn?.turn
    const conclusion = resultTurn === undefined ? undefined : turns.find(turn => turn.turn === resultTurn)?.end
    const status = await this.normal.batchDirectStatus(batch.mainSessionId, operationId, current)
    if (status === 'needs_context') return { ...item, state: 'processing', message: '主会话正在等待补充。补充后可继续批次。' }
    if (conclusion && conclusion !== 'completed') {
      return { ...item, state: 'failed', ...(result ? { revisionId: result.id } : {}), message: '本项回合已中断，可查看已保存译文，或重试、跳过。' }
    }
    const latestSuccess = [...recorded].reverse().find(revision => revision.status === 'completed' && eligible(revision))
    if (durable && latestSuccess && latestSuccess.id !== result?.id) return { ...item, state: 'processing', message: '译文已记录，正在等待会话保存。' }
    if (status === 'running' || status === 'unknown') return { ...item, state: 'processing', message: '尚未确认本项结果，请检查单元后继续。' }
    if (result && (conclusion === 'completed' || !result.batchRevision && !dispatchTurn && status !== 'source_changed')) {
      const { message: _waiting, ...settled } = item
      const polishingFailed = last && last.id !== result.id && last.status !== 'completed' || status === 'failed' || status === 'cancelled' || this.operations.get(operationId)?.lastRejected
      return { ...settled, state: 'completed', revisionId: result.id, ...(polishingFailed ? { message: '后续润色未完成，已保留最近成功的译文。' } : {}) }
    }
    if (result && (result.batchRevision || status !== 'source_changed') || dispatchTurn && !conclusion) {
      return { ...item, state: 'processing', message: '尚未确认本项结果，请检查单元后继续。' }
    }
    if (conclusion === 'completed' || turnEnded || status === 'source_changed' || last) {
      const { revisionId: _old, ...failed } = item
      return { ...failed, state: 'failed', message: this.notices.get(scopeKey(scope)) ??
        (last && !eligible(last) ? '图片输入已更新，当前内容尚无已保存的译文。' : '本项未取得可用结果，可重试或跳过。') }
    }
    return { ...item, state: 'processing', message: '尚未确认本项结果，请检查主会话。' }
  }

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
