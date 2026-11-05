import { referenceSegmentationComplete } from '../shared/reference-segmentation.js'
import { DIRECT_REVIEW_NEXT_STEP, DIRECT_REVISION_GUIDANCE, TRANSLATION_SELF_REVIEW } from '../shared/translation-review.js'
import { diagnosticSpan } from './diagnostics.js'
import type { OtherMemoryService } from './other-memory.js'
import type { MainAgent, TopicHostContext, TopicToolsService } from './topic-tools.js'
import type { HistoryService } from './history.js'
import type { HistoryBundle } from '../shared/history-bundle.js'
import { parseHistoryTextRead, type HistoryTextRead } from '../shared/history-text.js'
import { isTextUnit } from '../memory/translation-history.js'

type Data = Record<string, unknown>
interface ToolMessage extends Data {
  readonly role: 'tool'
  readonly toolCallId: string
  readonly isError: boolean
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}
interface HistoryEvent { readonly seq: number; readonly type: string; readonly data: Data }
interface NativeSession {
  readonly surface: { readonly nodes: readonly number[] }
  snapshotEvents(): readonly HistoryEvent[]
  deriveEventMessage(event: HistoryEvent): ToolMessage | null
  append(type: string, data: unknown, options?: unknown): unknown
}
interface PreStepContext {
  on?(name: 'agent/pre-step', listener: (event: { readonly agent: MainAgent; readonly turn: number; readonly step: number; readonly signal: AbortSignal },
    next: () => Promise<unknown>) => Promise<unknown>): () => void
}
function object(value: unknown): Data | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Data : undefined }
function json(text: unknown): Data | undefined { try { return typeof text === 'string' ? object(JSON.parse(text)) : undefined } catch { return undefined } }
function content(message: ToolMessage): string | undefined {
  return message.content.every(block => block.type === 'text' && typeof block.text === 'string') ? message.content.map(block => block.text).join('\n') : undefined
}
type SavedSnapshot = NonNullable<Awaited<ReturnType<HistoryService['compactionSnapshot']>>>
function recordedText(bundle: HistoryBundle, request: HistoryTextRead, operationId: unknown): { readonly source: string; readonly text: string } | undefined {
  const unit = bundle.history.units.find(unit => unit.id === request.unitId)
  if (!unit || !isTextUnit(unit) || unit.deletion) return undefined
  const source = unit.sourceVersions.find(source => source.version === request.sourceVersion)
  const revision = unit.revisions.find(revision => revision.id === request.revisionId)
  return source && revision?.status === 'completed' && !revision.deletion && revision.sourceVersion === request.sourceVersion && revision.operationId === operationId
    ? { source: source.text, text: revision.text } : undefined
}
function bodyMatches(value: Data, text: string): boolean {
  const points = Array.from(text)
  return value.totalCodePoints === points.length && (typeof value.text === 'string' ? value.text === text
    : typeof value.textPreview === 'string' && !!value.textPreview && value.textPreview === points.slice(0, Array.from(value.textPreview).length).join(''))
}

/** Native, logged surface replacement: original events remain intact and replay needs no plugin interpreter. */
export async function compactTranslationHistory(ctx: TopicHostContext, topics: TopicToolsService, agent: MainAgent, turn: number, signal: AbortSignal) {
  const stats = { results: 0, charactersBefore: 0, charactersAfter: 0 }
  const peer = topics.ownerPeer(agent.id, agent), namespaceId = topics.namespaceForAgent(agent.id)
  const session = agent.session as unknown as NativeSession
  const meter = ctx.get?.('tokenMeter') as { estimateMessage(message: unknown): number } | undefined
  // Older hosts without the native replacement/metering capability keep their existing history.
  if (!peer || !namespaceId || !meter?.estimateMessage || !session.surface || !session.snapshotEvents || !session.deriveEventMessage || !session.append) return stats
  const current = (): boolean => !signal.aborted && topics.ownerPeer(agent.id, agent) === peer && topics.namespaceForAgent(agent.id) === namespaceId
  const events = session.snapshotEvents(), calls = new Map<string, HistoryEvent>(), originals = new Map<string, ToolMessage>(), ended = new Set<number>()
  for (const event of events) {
    if (event.type === 'turn/end' && typeof event.data.turn === 'number' && event.data.turn < turn && object(event.data.reason)?.kind === 'completed') ended.add(event.data.turn)
    if (event.type === 'tool/call' && typeof event.data.callId === 'string') calls.set(event.data.callId, event)
    if (event.type === 'tool/result') {
      const message = event.data.message as ToolMessage | undefined
      if (message?.role === 'tool' && !originals.has(message.toolCallId)) originals.set(message.toolCallId, message)
    }
  }
  const memory = ctx.get?.('translationOtherMemory') as OtherMemoryService | undefined
  const plans = new Map<string, Promise<number | undefined>>()
  const replacements: { event: HistoryEvent; message: ToolMessage; text: string; previous: string; readable?: () => boolean; sessionId?: string; topicId?: string }[] = []
  const nodes = new Set(session.surface.nodes)
  const history = ctx.get?.('translationHistory') as HistoryService | undefined
  const snapshots = new Map<string, Promise<SavedSnapshot | undefined>>()
  const openedSessions = async (): Promise<Map<string, string>> => {
    const value = await topics.requestOwned(agent.id, { kind: 'list_sessions' }, { agent, callId: 'history-compaction', signal })
    if (value.kind !== 'sessions') throw new Error('历史收缩未取得已打开会话。')
    return new Map(value.sessions.map(item => [item.id, item.topicId]))
  }
  let opened: Promise<Map<string, string>> | undefined, latestTranslationTurn = -1
  for (const event of events) if (event.type === 'tool/result' && ended.has(event.data.turn as number)) {
    const message = event.data.message as ToolMessage | undefined
    if (!message || message.isError || calls.get(message.toolCallId)?.data.name !== 'translation_translate') continue
    const value = json(content(message))
    if (value?.status === 'completed' && value.recorded === true) latestTranslationTurn = Math.max(latestTranslationTurn, event.data.turn as number)
  }
  // A continuing learning task still needs one complete guide, even when its tools stay loaded.
  let latestLearningCallId: string | undefined
  for (const [id, call] of calls) {
    const result = originals.get(id)
    if (call.data.name === 'translation_load_tools' && result && !result.isError && typeof json(content(result))?.memoryGuide === 'string') latestLearningCallId = id
  }
  for (const event of events) {
    if (event.type !== 'tool/result' || !nodes.has(event.seq) || !ended.has(event.data.turn as number)) continue
    const message = session.deriveEventMessage(event)
    if (!message || message.role !== 'tool' || message.isError) continue
    const previous = content(message), original = originals.get(message.toolCallId)
    const call = calls.get(message.toolCallId), args = json(call?.data.arguments)
    if (previous === undefined || !original || original.isError || !call || !args) continue
    const value = json(content(original)), snapshot = object(value?.snapshot)
    let summary: Data | undefined
    let readable: (() => boolean) | undefined, bodyScope: { sessionId: string; topicId: string } | undefined
    if (call.data.name === 'translation_load_tools' && value) {
      const loadedGroups = Array.isArray(value.loadedGroups) ? value.loadedGroups
        : Array.isArray(value.groups) ? value.groups.flatMap(group => { const item = object(group); return item?.active === true && typeof item.name === 'string' ? [item.name] : [] }) : undefined
      summary = { kind: 'tool_loading_history',
        ...(Array.isArray(args.groups) ? { requestedGroups: args.groups } : {}),
        ...(loadedGroups ? { loadedGroups } : {}),
        ...(value.selectionAfterTurn === undefined ? {} : { selectionAfterTurn: value.selectionAfterTurn }),
        ...(message.toolCallId === latestLearningCallId ? { memoryGuide: value.memoryGuide } : {}),
        note: 'Historical loading receipt. Current schemas determine availability; load only missing tools.' }
    } else if (call.data.name === 'translation_translate' && value?.status === 'completed' && value.recorded === true) {
      const visible = json(previous)
      // Keep the visible body unless an exact saved version can replace it with a shorter reference.
      if (typeof visible?.nextStep === 'string') {
        const nextStep = visible.nextStep.replace(TRANSLATION_SELF_REVIEW + ' ' + DIRECT_REVISION_GUIDANCE, DIRECT_REVIEW_NEXT_STEP)
        if (nextStep !== visible.nextStep) summary = { ...visible, nextStep }
      }
      if (visible && visible.kind !== 'translation_result_history' && event.data.turn !== latestTranslationTurn && history?.compactionSnapshot &&
        visible.mainSessionId === agent.id && typeof visible.topicId === 'string' && (typeof visible.text === 'string' || typeof visible.textPreview === 'string')) {
        let request: HistoryTextRead | undefined
        try { request = parseHistoryTextRead({ translationSessionId: visible.translationSessionId, unitId: visible.unitId, sourceVersion: visible.sourceVersion,
          side: 'translation', revisionId: visible.revisionId, start: 0 }) } catch { /* Unknown historical result shapes retain their visible body. */ }
        if (request) {
          const { text: _text, textPreview: _preview, resultRef: _runtimeRef, truncated: _truncated, ...facts } = summary ?? visible
          const candidate = { ...facts, kind: 'translation_result_history', read: { tool: 'translation_read_history', arguments: request },
            note: 'Historical recorded result, not the current final or a new task. Read this exact version when needed; discover the current unit before editing.' }
          // Short translations do not pay for extra Client/storage checks just to grow their receipt.
          if (JSON.stringify(candidate).length < JSON.stringify(summary ?? visible).length) {
            const allowed = await (opened ??= openedSessions())
            if (!current()) return stats
            const sessionId = request.translationSessionId, topicId = visible.topicId
            if (allowed.get(sessionId) === topicId) {
              let snapshot = snapshots.get(sessionId)
              if (!snapshot) { snapshot = history.compactionSnapshot({ namespaceId, topicId, sessionId }, peer); snapshots.set(sessionId, snapshot) }
              const saved = await snapshot
              if (!current()) return stats
              if (saved?.isCurrent()) {
                const result = recordedText(saved.saved, request, visible.operationId), live = recordedText(saved.current, request, visible.operationId)
                if (result && live?.text === result.text && live.source === result.source && bodyMatches(visible, result.text)) {
                  summary = candidate; readable = saved.isCurrent; bodyScope = { sessionId, topicId }
                }
              }
            }
          }
        }
      }
    } else if ((call.data.name === 'translation_upsert_term' && value?.kind === 'terms' || call.data.name === 'translation_upsert_archive' && value?.kind === 'archive')
      && snapshot && typeof snapshot.topicId === 'string' && Number.isSafeInteger(snapshot.version) && Array.isArray(snapshot.entries)) {
      summary = { kind: call.data.name === 'translation_upsert_term' ? 'terms_history' : 'archive_history', topicId: snapshot.topicId,
        version: snapshot.version, entryCount: snapshot.entries.length,
        read: { tool: call.data.name === 'translation_upsert_term' ? 'translation_list_terms' : 'translation_list_topic_archive', topicId: snapshot.topicId },
        note: 'Historical successful write snapshot. Read current entries and versions before editing.' }
    } else if (call.data.name === 'translation_reference_segmentation_read' && value && memory && typeof args.topicId === 'string'
      && typeof args.id === 'string' && Number.isSafeInteger(args.version)) {
      const file = object(value.file)
      if (!file || file.id !== args.id || file.version !== args.version || !Array.isArray(value.rows)) continue
      const request = { namespaceId, topicId: args.topicId, id: args.id, version: args.version as number }, key = JSON.stringify(request)
      let plan = plans.get(key)
      if (!plan) {
        plan = memory.getReference(request, peer).then(entry => entry && referenceSegmentationComplete(entry) ? entry.segmentation!.version : undefined)
        plans.set(key, plan)
      }
      const planVersion = await plan
      if (!current()) return stats
      if (planVersion === undefined) continue
      summary = { kind: 'completed_reference_page', file: { id: args.id, version: args.version }, savedPlanVersion: planVersion,
        read: { tool: 'translation_reference_segmentation_read', topicId: args.topicId, id: args.id, version: args.version,
          ...(typeof args.after === 'string' ? { after: args.after } : {}) },
        note: 'The full reference has a saved complete segmentation plan. Read this exact original page again only when needed.' }
    }
    if (!summary) continue
    const text = JSON.stringify(summary)
    if (text.length < previous.length) replacements.push({ event, message, text, previous, ...(readable ? { readable, ...bodyScope } : {}) })
  }
  if (!replacements.length || !current()) return stats
  const stillOpened = replacements.some(item => item.readable) ? await openedSessions() : undefined
  if (!current()) return stats
  const report = diagnosticSpan(ctx, 'model.history.compact')
  try {
    const active = new Set(session.surface.nodes)
    for (const { event, message, text, previous, readable, sessionId, topicId } of replacements) {
      if (!active.has(event.seq)) continue
      if (readable && (!readable() || stillOpened?.get(sessionId!) !== topicId)) continue
      const shadowedTokenCount = meter.estimateMessage(message)
      if (!Number.isFinite(shadowedTokenCount) || shadowedTokenCount < 0) throw new Error('上下文替换缺少有效的宿主 token 估算。')
      session.append('compaction/prune', { shadowedRange: { start: event.seq, end: event.seq }, shadowedSeqs: [event.seq], shadowedTokenCount })
      session.append('tool/result', { ...event.data, message: { ...message, content: [{ type: 'text', text }] } },
        { surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq }, sourceEventSeqs: [event.seq] })
      stats.results++; stats.charactersBefore += Array.from(previous).length; stats.charactersAfter += Array.from(text).length
    }
    report('completed', stats)
    return stats
  } catch (error) { report('failed', stats, error); throw error }
}

export function registerTranslationHistoryCompaction(ctx: TopicHostContext, topics: TopicToolsService): (() => void) | undefined {
  return (ctx as unknown as PreStepContext).on?.('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    if (step === 1) {
      try { await compactTranslationHistory(ctx, topics, agent, turn, signal) }
      catch (error) { diagnosticSpan(ctx, 'model.history.compact')('failed', {}, error) }
    }
    return next()
  })
}
