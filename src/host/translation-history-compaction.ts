import { referenceSegmentationComplete } from '../shared/reference-segmentation.js'
import { DIRECT_REVIEW_NEXT_STEP, DIRECT_REVISION_GUIDANCE, TRANSLATION_SELF_REVIEW } from '../shared/translation-review.js'
import { diagnosticSpan } from './diagnostics.js'
import type { OtherMemoryService } from './other-memory.js'
import type { MainAgent, TopicHostContext, TopicToolsService } from './topic-tools.js'

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
  const replacements: { event: HistoryEvent; message: ToolMessage; text: string; previous: string }[] = []
  const nodes = new Set(session.surface.nodes)
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
      // Replace only the known static block; keep the current body, refs, usage and any task-specific suffix.
      if (typeof visible?.nextStep === 'string') {
        const nextStep = visible.nextStep.replace(TRANSLATION_SELF_REVIEW + ' ' + DIRECT_REVISION_GUIDANCE, DIRECT_REVIEW_NEXT_STEP)
        if (nextStep !== visible.nextStep) summary = { ...visible, nextStep }
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
    if (text.length < previous.length) replacements.push({ event, message, text, previous })
  }
  if (!replacements.length || !current()) return stats
  const report = diagnosticSpan(ctx, 'model.history.compact')
  try {
    const active = new Set(session.surface.nodes)
    for (const { event, message, text, previous } of replacements) {
      if (!active.has(event.seq)) continue
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
