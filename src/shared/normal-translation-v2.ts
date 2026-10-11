import { parseTranslationCallMetadata, type TranslationCallMetadata } from './translation-call.js'
import { parseRequestContextInput, type RequestContextInput } from './request-context.js'
import { parseNormalTranslationOperation, type NormalTranslationError, type NormalTranslationOperation } from './normal-translation.js'

export type NormalTranslationV2Status = 'accepted' | 'running' | 'waiting_context' | 'waiting_user' | 'resuming' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export type NormalTranslationEventKind = 'call-started' | 'partial' | 'needs-context' | 'control' | 'resume-registered' | 'call-ended'
export type NormalTranslationResolution =
  | { readonly resolutionId: string; readonly observedVersion: number; readonly kind: 'answer'; readonly answerText: string; readonly organizedRequirements: string; readonly references: readonly { readonly id: string; readonly version: number }[] }
  | { readonly resolutionId: string; readonly observedVersion: number; readonly kind: 'defer' | 'abort'; readonly reason: string }

export interface NormalTranslationV2Event {
  readonly sequence: number
  readonly kind: NormalTranslationEventKind
  readonly callId: string | null
  readonly resolutionId: string | null
  readonly exchangeId: string | null
  readonly contextVersion: number
  readonly textDelta: string
  readonly metadata: TranslationCallMetadata | null
  readonly requestContext: RequestContextInput | null
  readonly status: NormalTranslationV2Status | null
  readonly error: NormalTranslationError | null
}

export interface NormalTranslationCallAttempt {
  readonly callId: string
  readonly contextVersion: number
  readonly metadata: TranslationCallMetadata
  readonly status: Exclude<NormalTranslationV2Status, 'accepted' | 'waiting_context' | 'waiting_user' | 'resuming'>
  readonly startSequence: number
  readonly endSequence: number | null
}

export interface NormalTranslationV2Job {
  readonly operation: Omit<NormalTranslationOperation, 'status'> & { readonly status: NormalTranslationV2Status }
  readonly status: NormalTranslationV2Status
  readonly attempts: readonly NormalTranslationCallAttempt[]
  readonly events: readonly NormalTranslationV2Event[]
  readonly lastSequence: number
  readonly more: boolean
  readonly error: NormalTranslationError | null
}

type Data = Record<string, unknown>
function object(value: unknown): asserts value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected normal translation v2 object')
}
function exact(value: Data, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError('Unexpected normal translation v2 fields')
}
function text(value: unknown, limit = 2048, empty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw new TypeError('Invalid normal translation v2 text')
}
function integer(value: unknown, minimum = 1): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError('Invalid normal translation v2 sequence')
}
const statuses: readonly NormalTranslationV2Status[] = ['accepted', 'running', 'waiting_context', 'waiting_user', 'resuming', 'completed', 'failed', 'cancelled', 'unknown']

export function parseNormalTranslationV2Event(value: unknown): NormalTranslationV2Event {
  object(value); exact(value, ['sequence', 'kind', 'callId', 'resolutionId', 'exchangeId', 'contextVersion', 'textDelta', 'metadata', 'requestContext', 'status', 'error'])
  integer(value.sequence); integer(value.contextVersion)
  if (!['call-started', 'partial', 'needs-context', 'control', 'resume-registered', 'call-ended'].includes(value.kind as string)) throw new TypeError('Invalid normal translation v2 event')
  if (value.callId !== null) text(value.callId)
  if (value.resolutionId !== null) text(value.resolutionId)
  if (value.exchangeId !== null) text(value.exchangeId)
  text(value.textDelta, 8192, true)
  const metadata = value.metadata === null ? null : parseTranslationCallMetadata(value.metadata)
  const requestContext = value.requestContext === null ? null : parseRequestContextInput(value.requestContext, Number.MAX_SAFE_INTEGER)
  if (value.status !== null && !statuses.includes(value.status as NormalTranslationV2Status)) throw new TypeError('Invalid normal translation v2 state')
  if (value.error !== null) {
    object(value.error); exact(value.error, ['code', 'message', 'stage'])
    text(value.error.code, 80); text(value.error.message, 1000); text(value.error.stage, 80)
  }
  if ((value.kind === 'call-started' ? metadata === null : value.kind !== 'call-ended' && metadata !== null) || (value.kind === 'needs-context') !== (requestContext !== null) ||
    (value.kind === 'partial') !== (value.textDelta !== '') || (value.kind === 'call-ended' ? value.status === null :
      !['needs-context', 'control', 'resume-registered'].includes(value.kind as string) && value.status !== null) ||
    (value.kind === 'needs-context' && value.resolutionId !== null) || (value.kind === 'resume-registered' && value.resolutionId === null)) throw new TypeError('Invalid normal translation v2 event payload')
  return { ...structuredClone(value), metadata, requestContext } as unknown as NormalTranslationV2Event
}

/** Host-side facts for one operation. The event sequence never resets between calls. */
export class NormalTranslationAttemptJournal {
  private readonly eventList: NormalTranslationV2Event[] = []
  private readonly attemptList: NormalTranslationCallAttempt[] = []

  start(callId: string, contextVersion: number, metadata: TranslationCallMetadata, exchangeId: string | null = null): void {
    if (this.attemptList.some(attempt => attempt.callId === callId) || contextVersion !== this.attemptList.length + 1) throw new Error('Invalid normal translation call attempt')
    const event = this.append({ kind: 'call-started', callId, resolutionId: metadata.exchangeContext?.resolutionRefs[0]?.resolutionId ?? null, exchangeId,
      contextVersion, textDelta: '', metadata, requestContext: null, status: null, error: null })
    this.attemptList.push({ callId, contextVersion, metadata: structuredClone(metadata), status: 'running', startSequence: event.sequence, endSequence: null })
  }

  partial(callId: string, textDelta: string): void {
    this.active(callId)
    this.append({ kind: 'partial', callId, resolutionId: null, exchangeId: null, contextVersion: this.active(callId).contextVersion, textDelta, metadata: null, requestContext: null, status: null, error: null })
  }

  needsContext(callId: string, requestContext: RequestContextInput, exchangeId: string | null = null, status: 'waiting_context' | 'waiting_user' = 'waiting_context'): void {
    const attempt = this.active(callId)
    this.append({ kind: 'needs-context', callId, resolutionId: null, exchangeId, contextVersion: attempt.contextVersion, textDelta: '', metadata: null,
      requestContext: structuredClone(requestContext), status, error: null })
  }

  control(callId: string, status: Extract<NormalTranslationV2Status, 'waiting_context' | 'waiting_user' | 'resuming' | 'cancelled' | 'unknown'>, resolutionId: string | null = null, exchangeId: string | null = null): void {
    const attempt = this.attemptList.find(item => item.callId === callId)
    if (!attempt) throw new Error('No normal translation call attempt')
    this.append({ kind: 'control', callId, resolutionId, exchangeId, contextVersion: attempt.contextVersion, textDelta: '', metadata: null, requestContext: null, status, error: null })
  }

  resumeRegistered(callId: string, contextVersion: number, resolutionId: string, exchangeId: string | null = null): void {
    this.append({ kind: 'resume-registered', callId, resolutionId, exchangeId, contextVersion, textDelta: '', metadata: null, requestContext: null, status: 'resuming', error: null })
  }

  end(callId: string, status: NormalTranslationCallAttempt['status'], error: NormalTranslationError | null = null, metadata?: TranslationCallMetadata, exchangeId: string | null = null): void {
    const attempt = this.active(callId), event = this.append({ kind: 'call-ended', callId, resolutionId: metadata?.exchangeContext?.resolutionRefs[0]?.resolutionId ?? null, exchangeId, contextVersion: attempt.contextVersion,
      textDelta: '', metadata: metadata ?? null, requestContext: null, status, error })
    this.attemptList[this.attemptList.length - 1] = { ...attempt, metadata: metadata ? structuredClone(metadata) : attempt.metadata, status, endSequence: event.sequence }
  }

  snapshot(): { readonly attempts: readonly NormalTranslationCallAttempt[]; readonly events: readonly NormalTranslationV2Event[] } {
    return structuredClone({ attempts: this.attemptList, events: this.eventList })
  }

  private active(callId: string): NormalTranslationCallAttempt {
    const attempt = this.attemptList.at(-1)
    if (!attempt || attempt.callId !== callId || attempt.endSequence !== null) throw new Error('No active normal translation call attempt')
    return attempt
  }

  private append(value: Omit<NormalTranslationV2Event, 'sequence'>): NormalTranslationV2Event {
    const event = parseNormalTranslationV2Event({ ...value, sequence: this.eventList.length + 1 })
    this.eventList.push(event)
    return event
  }
}

export function parseNormalTranslationV2Job(value: unknown): NormalTranslationV2Job {
  object(value); exact(value, ['operation', 'status', 'attempts', 'events', 'lastSequence', 'more', 'error'])
  object(value.operation)
  exact(value.operation, ['operationId', 'mainSessionId', 'topicId', 'translationSessionId', 'materialId', 'unitId', 'sourceVersion', 'draftVersion', 'status', 'persistence'])
  if (!statuses.includes(value.operation.status as NormalTranslationV2Status)) throw new TypeError('Invalid normal translation v2 operation state')
  const operationStatus = value.operation.status as NormalTranslationV2Status
  const operationBase = parseNormalTranslationOperation({ ...value.operation, status: ['accepted', 'running', 'completed', 'failed', 'cancelled', 'unknown'].includes(operationStatus) ? operationStatus : 'unknown' })
  const operation = { ...operationBase, status: operationStatus } as NormalTranslationV2Job['operation']
  if (!statuses.includes(value.status as NormalTranslationV2Status) || !Array.isArray(value.attempts) || !Array.isArray(value.events) ||
    !Number.isSafeInteger(value.lastSequence) || (value.lastSequence as number) < 0 || typeof value.more !== 'boolean') throw new TypeError('Invalid normal translation v2 job')
  const attempts = value.attempts.map((raw: unknown, index: number) => {
    object(raw); exact(raw, ['callId', 'contextVersion', 'metadata', 'status', 'startSequence', 'endSequence'])
    text(raw.callId); integer(raw.contextVersion); integer(raw.startSequence)
    if (raw.contextVersion !== index + 1 || !['running', 'completed', 'failed', 'cancelled', 'unknown'].includes(raw.status as string) ||
      !(raw.endSequence === null || (Number.isSafeInteger(raw.endSequence) && (raw.endSequence as number) >= (raw.startSequence as number)))) throw new TypeError('Invalid normal translation call attempt')
    return { ...structuredClone(raw), metadata: parseTranslationCallMetadata(raw.metadata) } as NormalTranslationCallAttempt
  })
  const events = value.events.map(parseNormalTranslationV2Event)
  if (events.some((event: NormalTranslationV2Event, index: number) => event.sequence > (value.lastSequence as number) ||
    (index > 0 && event.sequence !== events[index - 1]!.sequence + 1))) throw new TypeError('Invalid normal translation v2 event sequence')
  return { operation, status: value.status as NormalTranslationV2Status, attempts, events, lastSequence: value.lastSequence as number, more: value.more,
    error: value.error === null ? null : parseError(value.error) }
}

function parseError(value: unknown): NormalTranslationError {
  object(value); exact(value, ['code', 'message', 'stage'])
  text(value.code, 80); text(value.message, 1000); text(value.stage, 80)
  return structuredClone(value) as unknown as NormalTranslationError
}

export const NORMAL_TRANSLATION_V2_REMOTE = {
  package: 'dsh-translation-plugin',
  descriptors: (['status', 'cancel'] as const).map(method => ({
    id: `dsh-translation-plugin#translationNormalV2/${method}`, service: 'translationNormalV2', namespace: 'translationNormalV2', method,
    invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const,
      codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#normalV2/${method}Request`, create: () => ({
        parse: (value: unknown) => {
          object(value); exact(value, ['mainSessionId', 'translationSessionId', 'operationId', 'afterSequence'])
          for (const key of ['mainSessionId', 'translationSessionId', 'operationId']) text(value[key])
          if (!Number.isSafeInteger(value.afterSequence) || (value.afterSequence as number) < 0) throw new TypeError('Invalid normal translation v2 cursor')
          return structuredClone(value)
        },
      }) } }],
    result: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#normalV2/${method}Result`, create: () => ({
      parse: (value: unknown) => {
        object(value)
        if (value.ok === false) { exact(value, ['ok', 'error']); return { ok: false, error: parseError(value.error) } }
        if (value.ok !== true) throw new TypeError('Invalid normal translation v2 receipt')
        exact(value, ['ok', 'value'])
        return { ok: true, value: parseNormalTranslationV2Job(value.value) }
      },
    }) },
  })),
}
