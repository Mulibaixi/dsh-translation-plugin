import type { ImageUnit, TextRevision } from '../memory/translation-history.js'
import type { ImageUnitTarget } from '../shared/image-translation.js'
import type { HistoryScope } from '../shared/history-bundle.js'
import type { MainAgent } from './topic-tools.js'

interface BatchNotice {
  readonly kind: 'translation-unit'
  readonly plugin: 'dsh-translation-plugin'
  readonly mainSessionId: string
  readonly translationSessionId: string
  readonly namespaceId: string
  readonly topicId: string
  readonly batchId: string
  readonly operationId: string
  readonly unitId?: string
}

export function batchNoticeSource(scope: HistoryScope, mainSessionId: string, batchId: string, operationId: string, unitId?: string): BatchNotice {
  return { kind: 'translation-unit', plugin: 'dsh-translation-plugin', mainSessionId, translationSessionId: scope.sessionId,
    namespaceId: scope.namespaceId, topicId: scope.topicId, batchId, operationId, ...(unitId === undefined ? {} : { unitId }) }
}

export function batchNotice(source: unknown, mainSessionId: string): BatchNotice | undefined {
  const input = source as Partial<BatchNotice> | undefined
  if (input?.kind !== 'translation-unit' || input.plugin !== 'dsh-translation-plugin' || input.mainSessionId !== mainSessionId ||
    !input.namespaceId || !input.topicId || !input.translationSessionId || !input.batchId || !input.operationId) return undefined
  return input as BatchNotice
}

export function noticeScope(source: BatchNotice): HistoryScope {
  return { namespaceId: source.namespaceId, topicId: source.topicId, sessionId: source.translationSessionId }
}

interface JournalMessage {
  readonly id: string
  readonly content: readonly unknown[]
  readonly source: { readonly kind: string }
}
interface JournalTurn {
  readonly turn: number
  readonly messages: JournalMessage[]
  end?: string
}

/** Admission is proved by native user/message events in the actual turn. */
export function batchTurns(agent: MainAgent | undefined): readonly JournalTurn[] {
  const events = agent?.session.snapshotEvents?.() as readonly { type: string; data?: unknown }[] | undefined
  const turns: JournalTurn[] = []
  let current: JournalTurn | undefined
  for (const event of events ?? []) {
    const data = event.data as { turn?: number; reason?: { kind?: string }; message?: JournalMessage } | undefined
    if (event.type === 'turn/start' && typeof data?.turn === 'number') {
      current = { turn: data.turn, messages: [] }
      turns.push(current)
    } else if (current && event.type === 'user/message') {
      const message = data?.message ?? (data as unknown as JournalMessage | undefined)
      if (message?.source && message.id) current.messages.push(message)
    } else if (current && event.type === 'turn/end' && data?.turn === current.turn) {
      current.end = data?.reason?.kind ?? 'unknown'
      current = undefined
    }
  }
  return turns
}

export function isRuntimeContext(message: { readonly source: unknown }): boolean {
  const kind = (message.source as { kind?: string } | undefined)?.kind
  return kind === 'runtime-context' || kind === 'time-context'
}

function json(value: unknown): Record<string, unknown> | undefined {
  try {
    const result: unknown = typeof value === 'string' ? JSON.parse(value) : undefined
    if (result && typeof result === 'object' && !Array.isArray(result)) return result as Record<string, unknown>
  } catch { /* Keep incomplete journal evidence out of recovery. */ }
}

function messageText(message: JournalMessage): string {
  return message.content.flatMap(value => {
    const block = value as { type?: string; text?: string }
    return block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  }).join('\n')
}

/** Recover untagged results only when the exact batch turn and current image input can be verified. */
export function untaggedBatchResults(agent: MainAgent, turn: JournalTurn, notice: JournalMessage,
  target: ImageUnitTarget, unit: ImageUnit): (revision: TextRevision) => boolean {
  const messages = turn.messages.filter(message => !isRuntimeContext(message))
  const input = json(messageText(notice).split('\n').find(line => line.startsWith('{"target":')))
  if (turn.end !== 'completed' || messages.length !== 1 || messages[0]?.id !== notice.id ||
    !input || input.sourcePreview !== unit.source || JSON.stringify(input.speakers ?? []) !== JSON.stringify(unit.speakers ?? [])) return () => false
  type Call = { operationId: string; auxiliaryContext: string; startedAt: number }
  const calls = new Map<string, Call>(), results = new Map<string, Call>()
  for (const event of (agent.session.snapshotEvents?.() ?? []) as readonly { type: string; time?: number; data?: Record<string, unknown> }[]) {
    const data = event.data
    if (data?.turn !== turn.turn) continue
    if (event.type === 'tool/call' && data.name === 'translation_translate' && typeof data.callId === 'string' && typeof event.time === 'number') {
      const args = json(data.arguments), requested = args?.target as Partial<ImageUnitTarget> | undefined
      if (typeof args?.operationId !== 'string' || requested?.kind !== target.kind || requested.mainSessionId !== target.mainSessionId ||
        requested.translationSessionId !== target.translationSessionId || requested.unitId !== target.unitId) continue
      calls.set(data.callId, { operationId: args.operationId, startedAt: event.time, auxiliaryContext: [unit.backgroundDescription, args.auxiliaryContext].filter(Boolean).join('\n\n') })
    } else if (event.type === 'tool/result') {
      const message = data.message as (JournalMessage & { toolCallId?: string; isError?: boolean }) | undefined
      const call = message?.toolCallId ? calls.get(message.toolCallId) : undefined
      if (!message || message.isError || !call) continue
      const result = json(messageText(message))
      if (result?.status === 'completed' && result.recorded === true && result.operationId === call.operationId &&
        result.unitId === target.unitId && typeof result.revisionId === 'string') results.set(result.revisionId, call)
    }
  }
  return revision => {
    const call = results.get(revision.id)
    return !!call && revision.kind === 'machine' && revision.status === 'completed' && revision.operationId === call.operationId &&
      Date.parse(revision.createdAt) >= call.startedAt &&
      !!revision.callRecord?.context && (revision.callRecord.context.auxiliaryContext ?? '') === call.auxiliaryContext
  }
}
