import { parseRecordIndexTarget, parseRecordIndexPlan, RECORD_INDEX_GUIDANCE, type RecordIndexTarget, type RecordIndexRequest, type RecordIndexPlan, type RecordIndexState, type RecordIndexMark } from '../shared/record-index.js'
import type { HistoryScope } from '../shared/history-bundle.js'
import { referenceBytes, referenceExact, referenceInteger, referenceObject, referenceString } from '../shared/reference-memory.js'
import type { OtherMemoryService } from './other-memory.js'
import type { HistoryService } from './history.js'
import type { LocalDataService } from './local-data.js'
import type { MainAgent, TopicHostContext, TopicToolsService, ToolExecution } from './topic-tools.js'
import type { MemorySearchService } from './memory-search.js'
import type { EmbeddingService } from './embedding.js'
import type { TranslationSourcesService } from './translation-sources.js'
import { currentHistoryPair, historyFileName, historyIndexSourceIds } from './history-retrieval.js'
import { referenceAnchors, referenceAnchorPage, referenceBoundaryEnds } from './reference-segments.js'
import { markdownIndexProjection } from './markdown-index.js'
import { sourceSha256 } from './source-storage.js'
import { hostLlmLoader } from './dsh-text-adapter.js'
import { diagnosticSpan } from './diagnostics.js'
import { translationTaskBoundary } from '../shared/translation-task.js'

type IndexAgent = MainAgent & { readonly status: 'idle' | 'running'; followup(message: unknown): void }
interface Original { readonly text: string; readonly hash: string; readonly name: string; readonly isCurrent: () => boolean }
interface Task { readonly target: RecordIndexTarget; readonly agent?: IndexAgent; readonly controller: AbortController; phase: RecordIndexState['phase']; message?: string; job?: Promise<void> }
const key = (target: RecordIndexTarget): string => JSON.stringify([target.namespaceId, target.topicId, target.sessionId, target.unitId, target.sourceVersion])
const complete = (plan: RecordIndexPlan, text: string): boolean => plan.marks.at(-1)?.end === Array.from(text).length
const blank = (): RecordIndexState => ({ phase: 'unselected', segments: 0, indexed: 0, total: 0 })
function failure(message: string): Error { return Object.assign(new Error(message), { code: 'record_index_failed' }) }

/** Explicit file opt-in, model-authored marks, and source-only derived indexing. */
export class RecordIndexService {
  readonly typertRemote: { readonly service: RecordIndexService; readonly serviceKey: 'translationRecordIndex'; readonly namespace: 'translationRecordIndex' } = { service: this, serviceKey: 'translationRecordIndex', namespace: 'translationRecordIndex' }
  private readonly tasks = new Map<string, Task>()
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false
  private readonly stopStatus: (() => void) | undefined
  constructor(private readonly ctx: TopicHostContext, private readonly memory: OtherMemoryService, private readonly history: HistoryService,
    private readonly options: { readonly loadMessages?: () => Promise<{ createUserMessage(input: unknown): unknown }> } = {}) {
    Object.defineProperty(this, Symbol.for('cordis.tracker'), { value: { associate: 'translationRecordIndex', property: 'ctx' } })
    this.stopStatus = ctx.on?.('agent/status', ({ agent }) => {
      if ((agent as IndexAgent).status !== 'idle') return
      for (const task of this.tasks.values()) if (task.agent === agent && ['submitted', 'segmenting'].includes(task.phase)) task.phase = 'partial'
    })
  }
  private get topics(): TopicToolsService { const value = this.ctx.get?.('translationTopics') as TopicToolsService | undefined; if (!value) throw failure('主题服务尚未就绪。'); return value }
  private get search(): MemorySearchService { const value = this.ctx.get?.('translationMemorySearch') as MemorySearchService | undefined; if (!value) throw failure('语义索引服务尚未就绪。'); return value }
  private check(scope: HistoryScope, peer: string): void {
    if (this.disposed || !this.topics.ownsLibrary(scope.namespaceId, peer)) throw failure('文件索引连接已关闭或不属于此资料库。')
  }
  private peer(target: RecordIndexTarget): string {
    const peer = this.ctx.invocation?.peer.id; if (!peer) throw failure('文件索引缺少宿主连接。')
    this.check(target, peer); return peer
  }
  private async writer<T>(action: () => Promise<T>): Promise<T> {
    return ((this.ctx.get?.('translationLocalData') as LocalDataService | undefined)?.storageWriter() ?? (async <R>(run: () => Promise<R>): Promise<R> => run()))(action)
  }
  private async original(target: RecordIndexTarget, peer: string, signal: AbortSignal): Promise<Original> {
    this.check(target, peer); signal.throwIfAborted()
    const snapshot = await this.history.recordSnapshot(target, peer), unit = snapshot.bundle.history.units.find(item => item.id === target.unitId)
    if (!unit || unit.deletion || unit.sourceVersion !== target.sourceVersion) throw failure('当前原文版本已变化或文件单元已删除。')
    const name = historyFileName(snapshot.bundle, target.unitId)
    if (!name || !/\.(?:txt|md)$/iu.test(name)) throw failure('仅支持 TXT、Markdown 文件原文嵌入。')
    const pair = await currentHistoryPair(snapshot.bundle, target, snapshot.token, target.unitId, peer, this.ctx.get?.('translationSources') as TranslationSourcesService | undefined, signal)
    if (!pair?.source || !snapshot.isCurrent()) throw failure('当前文件原稿或有效最终译文不可准确读取，请刷新记录后重试。')
    const hash = await sourceSha256(new TextEncoder().encode(pair.source)); this.check(target, peer); signal.throwIfAborted()
    return { text: pair.source, hash, name, isCurrent: snapshot.isCurrent }
  }
  private async plan(target: RecordIndexTarget, peer: string): Promise<RecordIndexPlan | undefined> {
    this.check(target, peer)
    const db = await this.memory.databaseForArchives(); this.check(target, peer)
    if (db?.retired(target.namespaceId, target.topicId)) return undefined
    const plan = db?.recordIndexGet(target.namespaceId, target.sessionId, target.unitId)
    return plan?.sourceVersion === target.sourceVersion ? plan : undefined
  }
  async selected(scope: HistoryScope, unitId: string, sourceVersion: number, peer: string): Promise<boolean> {
    return !!await this.plan({ ...scope, unitId, sourceVersion }, peer)
  }
  async segments(scope: HistoryScope, unitId: string, sourceVersion: number, sourceText: string, peer: string, signal: AbortSignal): Promise<{ readonly selected: boolean; readonly complete: boolean; readonly parts: readonly { start: number; end: number; text: string }[] }> {
    const target = { ...scope, unitId, sourceVersion }, plan = await this.plan(target, peer)
    if (!plan) return { selected: false, complete: false, parts: [] }
    signal.throwIfAborted()
    if (plan.sourceHash !== await sourceSha256(new TextEncoder().encode(sourceText))) return { selected: false, complete: false, parts: [] }
    if (!complete(plan, sourceText)) return { selected: true, complete: false, parts: [] }
    const snapshot = await this.history.recordSnapshot(scope, peer), markdown = /\.md$/iu.test(historyFileName(snapshot.bundle, unitId) ?? '')
    const points = Array.from(sourceText), parts: { start: number; end: number; text: string }[] = []; let start = 0
    for (const mark of plan.marks) {
      if (mark.end > points.length) throw failure('分段范围超出当前原文，请重新分段。')
      if (mark.kind === 'content') {
        const text = markdown ? markdownIndexProjection(sourceText, { start, end: mark.end }) : points.slice(start, mark.end).join('').replace(/^\uFEFF/u, '')
        if (text.trim()) parts.push({ start, end: mark.end, text })
      }
      start = mark.end
    }
    this.check(target, peer); signal.throwIfAborted()
    return { selected: true, complete: true, parts }
  }
  private async save(target: RecordIndexTarget, original: Original, plan: RecordIndexPlan, expectedVersion: number, peer: string, clearVectors = false, task?: Task): Promise<void> {
    const db = await this.memory.databaseForArchives(true); this.check(target, peer)
    await this.writer(async () => {
      this.check(target, peer)
      if (task && (this.tasks.get(key(target)) !== task || task.controller.signal.aborted)) throw failure('原文嵌入任务已移除或替换，旧标记不再保存。')
      if (!original.isCurrent() || db!.retired(target.namespaceId, target.topicId)) throw failure('原文或所属记录在保存分段前已变化，请重新读取。')
      const old = db!.recordIndexGet(target.namespaceId, target.sessionId, target.unitId)
      if ((old?.version ?? 0) !== expectedVersion) throw failure('分段计划已变化，请先读取当前进度。')
      db!.transaction(() => {
        db!.recordIndexSave(target.namespaceId, target.topicId, target.sessionId, target.unitId, plan)
        if (clearVectors) for (const id of historyIndexSourceIds(target.sessionId, target.unitId)) db!.indexRemoveSource(target.namespaceId, target.topicId, id)
      })
    })
    if (clearVectors) this.search.invalidateRecord(target, target.unitId)
  }
  async status(raw: RecordIndexTarget): Promise<RecordIndexState> {
    const target = parseRecordIndexTarget(raw) as RecordIndexTarget
    return this.state(target, this.peer(target))
  }
  private async state(target: RecordIndexTarget, peer: string): Promise<RecordIndexState> {
    const plan = await this.plan(target, peer)
    if (!plan) return blank()
    const original = await this.original(target, peer, new AbortController().signal)
    if (plan.sourceHash !== original.hash) return { ...blank(), message: '原文已变化，请重新嵌入。' }
    const parts = await this.segments(target, target.unitId, target.sourceVersion, original.text, peer, new AbortController().signal)
    const task = this.tasks.get(key(target)), segments = plan.marks.filter(mark => mark.kind === 'content').length
    if (!parts.complete) {
      if (task && ['submitted', 'segmenting'].includes(task.phase) && task.agent?.status === 'idle') task.phase = 'partial'
      return { phase: task?.phase ?? 'partial', segments, indexed: 0, total: 0, ...(task?.message ? { message: task.message } : {}) }
    }
    if (!parts.parts.length) return { phase: 'empty', segments, indexed: 0, total: 0 }
    const coverage = await this.search.recordCoverage(target, target.unitId, peer, new AbortController().signal)
    const phase = task?.phase === 'embedding' ? 'embedding' : coverage.indexed === coverage.total && coverage.total > 0 ? 'indexed' : 'failed'
    return { phase, segments: parts.parts.length, ...coverage, ...(task?.message ? { message: task.message } : {}) }
  }
  async request(raw: RecordIndexRequest): Promise<RecordIndexState> {
    const request = parseRecordIndexTarget(raw, true) as RecordIndexRequest, peer = this.peer(request)
    const next = this.tail.then(() => this.admit(request, peer)); this.tail = next.catch(() => {})
    return next
  }
  private async admit(request: RecordIndexRequest, peer: string): Promise<RecordIndexState> {
    const { mainSessionId, action, ...target } = request
    this.check(target, peer)
    if (!this.topics.ownsConnection(mainSessionId, peer) || this.topics.namespaceForAgent(mainSessionId) !== target.namespaceId) throw failure('文件分段不属于当前主会话连接。')
    if (action === 'remove') {
      const snapshot = await this.history.recordSnapshot(target, peer), unit = snapshot.bundle.history.units.find(unit => unit.id === target.unitId)
      if (!unit || unit.deletion || unit.sourceVersion !== target.sourceVersion) throw failure('原文版本已变化，旧操作不能移除新版本索引。')
      this.tasks.get(key(target))?.controller.abort(); this.tasks.delete(key(target))
      const db = await this.memory.databaseForArchives()
      await this.writer(async () => {
        this.check(target, peer)
        if (!snapshot.isCurrent()) throw failure('记录在移出索引前已变化，请刷新后重试。')
        db?.transaction(() => { db.recordIndexRemove(target.namespaceId, target.topicId, target.sessionId, target.unitId); for (const id of historyIndexSourceIds(target.sessionId, target.unitId)) db.indexRemoveSource(target.namespaceId, target.topicId, id) })
      })
      this.search.invalidateRecord(target, target.unitId); return blank()
    }
    const running = this.tasks.get(key(target))
    if (running && (running.phase === 'embedding' || ['submitted', 'segmenting'].includes(running.phase) && running.agent?.status === 'running')) return this.state(target, peer)
    const controller = new AbortController(), original = await this.original(target, peer, controller.signal)
    const config = await (this.ctx.get?.('translationEmbedding') as EmbeddingService | undefined)?.configuration()
    if (!config) throw failure('请先保存嵌入 API 配置。')
    let plan = await this.plan(target, peer)
    if (plan?.sourceHash !== original.hash) plan = undefined
    if (plan && complete(plan, original.text) && action !== 'resegment') {
      this.queueEmbedding(target, peer, controller); return this.state(target, peer)
    }
    const live = (this.ctx.get?.('agents') as { get(id: string): IndexAgent | undefined } | undefined)?.get(mainSessionId)
    const agent = live ?? await this.resolve(mainSessionId)
    this.check(target, peer)
    if (!agent || agent.status !== 'idle') throw failure('主模型正在处理其他任务或尚未就绪，请空闲后重试。')
    await this.authorizeAgent(target, agent, peer, controller.signal)
    const helpers = await (this.options.loadMessages ?? hostLlmLoader(this.ctx))()
    if (!plan || action === 'resegment') {
      const db = await this.memory.databaseForArchives(), previous = db?.recordIndexGet(target.namespaceId, target.sessionId, target.unitId)
      plan = { sourceVersion: target.sourceVersion, sourceHash: original.hash, version: (previous?.version ?? 0) + 1, marks: [] }
      await this.save(target, original, plan, previous?.version ?? 0, peer, true)
    }
    this.check(target, peer)
    if (agent.status !== 'idle' || !original.isCurrent()) throw failure('主模型或原文状态已变化，请刷新后重试。')
    const task: Task = { target, agent, controller, phase: 'submitted' }; this.tasks.set(key(target), task)
    this.topics.activateRecordSegmentation(agent)
    try {
      const taskTarget = { topicId: target.topicId, translationSessionId: target.sessionId, unitId: target.unitId, sourceVersion: target.sourceVersion, name: original.name }
      agent.followup(helpers.createUserMessage({ source: { kind: 'translation-record-segmentation', form: 'notice', summary: '原文语义分段', plugin: 'dsh-translation-plugin' },
        content: [{ type: 'text', text: [translationTaskBoundary(agent, 'segment_source', taskTarget), RECORD_INDEX_GUIDANCE, JSON.stringify(taskTarget)].join('\n') }] }))
    } catch (error) { task.phase = 'failed'; task.message = '分段任务未能进入主会话，请重试。'; throw error }
    return { phase: 'submitted', segments: plan.marks.filter(mark => mark.kind === 'content').length, indexed: 0, total: 0 }
  }
  private async resolve(id: string): Promise<IndexAgent | undefined> {
    const controller = this.ctx.get?.('sessionController') as { resolveAgent(id: string): Promise<{ agent: IndexAgent } | { error: unknown }> } | undefined
    if (!controller) return undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const found = await Promise.race([controller.resolveAgent(id), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 10000) })])
      return found && 'agent' in found ? found.agent : undefined
    } finally { clearTimeout(timer) }
  }
  private async authorizeAgent(target: RecordIndexTarget, agent: MainAgent, peer: string, signal: AbortSignal): Promise<void> {
    this.check(target, peer)
    if (!this.topics.ownsAgent(agent.id, agent) || this.topics.ownerPeer(agent.id, agent) !== peer || this.topics.namespaceForAgent(agent.id) !== target.namespaceId) throw failure('分段工具不属于当前主会话。')
    const reply = await this.topics.requestOwned(agent.id, { kind: 'list_sessions' }, { agent, signal, callId: 'record-index-scope' })
    if (reply.kind !== 'sessions' || !reply.sessions.some(session => session.id === target.sessionId && session.topicId === target.topicId && !session.archived)) throw failure('请先在当前主会话打开此文件所属的翻译会话。')
  }
  private queueEmbedding(target: RecordIndexTarget, peer: string, controller: AbortController): void {
    const previous = this.tasks.get(key(target)); previous?.controller.abort()
    const task: Task = { target, ...(previous?.agent ? { agent: previous.agent } : {}), controller, phase: 'embedding' }; this.tasks.set(key(target), task)
    const report = diagnosticSpan(this.ctx, 'memory.record-index', { action: 'embed' }, target.unitId)
    task.job = Promise.resolve().then(async () => {
      await this.search.buildRecord(target, target.unitId, peer, controller.signal)
      if (this.tasks.get(key(target)) === task && !controller.signal.aborted) task.phase = 'indexed'
      report('completed')
    }).catch(error => {
      if (this.tasks.get(key(target)) === task) { task.phase = 'failed'; task.message = (error as Error).message.slice(0, 500) }
      report(controller.signal.aborted ? 'cancelled' : 'failed', {}, error)
    })
  }
  private async toolTarget(raw: Record<string, unknown>, exec: ToolExecution): Promise<{ target: RecordIndexTarget; peer: string; original: Original; plan: RecordIndexPlan; task: Task }> {
    const agent = exec.agent
    if (!agent) throw failure('分段缺少主模型身份。')
    const target: RecordIndexTarget = { namespaceId: this.topics.namespaceForAgent(agent.id) ?? '', topicId: raw.topicId as string, sessionId: raw.translationSessionId as string, unitId: raw.unitId as string, sourceVersion: raw.sourceVersion as number }
    const peer = this.topics.ownerPeer(agent.id, agent)
    if (!peer) throw failure('分段主会话已断开。')
    await this.authorizeAgent(target, agent, peer, exec.signal)
    const task = this.tasks.get(key(target))
    if (!task || task.agent !== agent || task.controller.signal.aborted) throw failure('请先由用户在该文件行发起或继续原文嵌入。')
    const original = await this.original(target, peer, exec.signal), plan = await this.plan(target, peer)
    if (!plan || plan.sourceHash !== original.hash) throw failure('原文或嵌入选择已变化，请重新发起。')
    return { target, peer, original, plan, task }
  }
  async read(raw: Record<string, unknown>, exec: ToolExecution): Promise<unknown> {
    const { target, original, plan, task } = await this.toolTarget(raw, exec)
    if (['submitted', 'partial'].includes(task.phase)) task.phase = 'segmenting'
    const page = referenceAnchorPage(original.text, undefined, raw.after as string | undefined) as { rows: readonly { anchor: string; text: string }[]; next: string | null; contextBefore: string }
    const anchors = referenceAnchors(original.text), marks = new Map(plan.marks.map(mark => [mark.end, mark.kind]))
    return { file: { ...target, name: original.name, totalCodePoints: Array.from(original.text).length }, planVersion: plan.version,
      coveredThrough: anchors.find(anchor => anchor.end === plan.marks.at(-1)?.end)?.id ?? null, complete: complete(plan, original.text), indexing: task.phase,
      contextBefore: page.contextBefore, rows: page.rows.map(row => ({ ...row, marked: marks.get(anchors.find(anchor => anchor.id === row.anchor)!.end) ?? null })), next: page.next }
  }
  async mark(raw: Record<string, unknown>, exec: ToolExecution): Promise<unknown> {
    const { target, peer, original, plan, task } = await this.toolTarget(raw, exec)
    if (!['submitted', 'segmenting', 'partial'].includes(task.phase)) throw failure('此分段计划已完成，请读取当前进度；重新分段须由文件入口发起。')
    referenceInteger(raw.expectedPlanVersion, 1)
    if (raw.expectedPlanVersion !== plan.version || !['append', 'replace'].includes(String(raw.mode)) || !Array.isArray(raw.marks) || !raw.marks.length || raw.marks.length > 512) throw failure('分段版本已变化或标记无效，请先读取当前进度。')
    for (const mark of raw.marks) { referenceObject(mark); referenceExact(mark, ['endAnchor', 'kind']); referenceString(mark.endAnchor, 64); if (!['content', 'exclude'].includes(String(mark.kind))) throw failure('分段类别须为 content 或 exclude。') }
    const additions = raw.marks as { endAnchor: string; kind: RecordIndexMark['kind'] }[], ends = referenceBoundaryEnds(original.text, additions.map(mark => mark.endAnchor))
    const next = parseRecordIndexPlan({ ...plan, version: plan.version + 1, marks: [...(raw.mode === 'append' ? plan.marks : []), ...additions.map((mark, i) => ({ end: ends[i], kind: mark.kind }))] })
    let start = 0; const points = Array.from(original.text)
    for (const mark of next.marks) { if (mark.end > points.length || mark.kind === 'content' && !points.slice(start, mark.end).join('').trim()) throw failure('正文分段为空或超出原文，请重新标记。'); start = mark.end }
    await this.save(target, original, next, plan.version, peer, raw.mode === 'replace', task)
    task.phase = 'segmenting'
    if (complete(next, original.text)) this.queueEmbedding(target, peer, new AbortController())
    return { planVersion: next.version, complete: complete(next, original.text), coveredThrough: additions.at(-1)!.endAnchor, segments: next.marks.filter(mark => mark.kind === 'content').length,
      indexing: complete(next, original.text) ? 'queued' : 'waiting_for_complete' }
  }
  hasActiveJobs(): boolean { return [...this.tasks.values()].some(task => task.phase === 'embedding' || ['submitted', 'segmenting'].includes(task.phase) && task.agent?.status === 'running') }
  async dispose(): Promise<void> { this.disposed = true; this.stopStatus?.(); for (const task of this.tasks.values()) task.controller.abort(); await Promise.allSettled([...this.tasks.values()].flatMap(task => task.job ? [task.job] : [])); this.tasks.clear() }
}

export function registerRecordSegmentationTools(service: RecordIndexService, define: (options: Record<string, unknown>) => unknown, register: (definition: unknown) => () => void): readonly (() => void)[] {
  const text = { type: 'string', required: true }, target = { topicId: text, translationSessionId: text, unitId: text, sourceVersion: { type: 'integer', required: true } }
  return (['read', 'mark'] as const).map(action => register(define({ name: action === 'read' ? 'translation_record_segmentation_read' : 'translation_record_segment',
    description: (action === 'read' ? 'Read one exact user-selected recorded source file page and existing marks. No translation or embedding call. ' : 'Save content/exclude boundary marks for that source. Only complete coverage queues embedding of this ONE original. ') + RECORD_INDEX_GUIDANCE,
    parameters: action === 'read' ? { ...target, after: { type: 'string' } } : { ...target, expectedPlanVersion: { type: 'integer', required: true }, mode: { type: 'string', enum: ['append', 'replace'], required: true },
      marks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { endAnchor: text, kind: { type: 'string', enum: ['content', 'exclude'], required: true } } } } },
    output: { schema: { type: 'json' }, render: (_args: unknown, result: unknown) => [{ type: 'text', text: JSON.stringify(result) }] },
    execute: async (raw: unknown, exec: ToolExecution) => {
      referenceObject(raw); referenceExact(raw, ['topicId', 'translationSessionId', 'unitId', 'sourceVersion', ...(action === 'mark' ? ['expectedPlanVersion', 'mode', 'marks'] : [])], action === 'read' ? ['after'] : [])
      for (const name of ['topicId', 'translationSessionId', 'unitId']) referenceString(raw[name], 3000)
      referenceInteger(raw.sourceVersion, 1); if (raw.after !== undefined) referenceString(raw.after, 64)
      const result = await service[action](raw, exec)
      if (referenceBytes(result) > 32768) throw failure('分段回包超出读取预算，请缩小范围。')
      return result
    },
  })))
}
