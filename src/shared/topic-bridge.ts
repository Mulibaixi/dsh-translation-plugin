import { decodeTopicTermPut, decodeTopicTermSnapshot, type TopicTermPut, type TopicTermSnapshot } from '../memory/topic-terms.js'

/** Below the installed Gateway's default 256 KiB uplink inbox. Replies are never silently truncated. */
export const MAX_TOPIC_BRIDGE_REPLY_BYTES = 196_608
export interface TopicBridgeOpen { readonly ownerId: string; readonly mainSessionId: string }
export interface TopicBridgeCapability { readonly ready: boolean; readonly reason?: string }
export type TopicPersistence = 'saved' | 'runtime_only'
export interface TopicSummary {
  readonly id: string
  readonly name: string
  readonly nextSequence: number
  readonly sessionIds: readonly string[]
}
export interface TopicSessionSummary {
  readonly id: string
  readonly topicId: string
  readonly name: string
  readonly mode: 'quick' | 'normal'
  readonly publishedUnitIds: readonly string[]
  readonly topicName: string
  readonly sequence: number
  readonly remark: string
  readonly archived: boolean
}
export type TopicSessionStart =
  | { readonly kind: 'new_topic' }
  | { readonly kind: 'parent_session'; readonly translationSessionId: string }
  | { readonly kind: 'existing_topic'; readonly topicId: string }
export interface TopicUnitFact {
  readonly id: string
  readonly order: number
  readonly source: string
  readonly targetLanguage: string
  readonly instruction: string
  readonly revisions: readonly {
    readonly id: string; readonly order: number; readonly kind: 'machine' | 'manual'
    readonly status: 'submitting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'interrupted'
    readonly text: string; readonly baseRevisionId: string | null
  }[]
  readonly final: { readonly revisionId: string; readonly selection: 'automatic' | 'user_fixed'; readonly selectionEventId: string } | null
}
export type TopicBridgeCommand =
  | { readonly kind: 'list_sessions' }
  | { readonly kind: 'list_topics' }
  | { readonly kind: 'list_topic_terms'; readonly topicId: string }
  | { readonly kind: 'create_session'; readonly start: TopicSessionStart; readonly reason: string }
  | { readonly kind: 'rename_topic'; readonly topicId: string; readonly expectedName: string; readonly name: string }
  | { readonly kind: 'set_session_remark'; readonly translationSessionId: string; readonly expectedRemark: string; readonly remark: string }
  | { readonly kind: 'archive_session'; readonly translationSessionId: string; readonly expectedArchived: boolean; readonly archived: boolean }
  | { readonly kind: 'read_unit'; readonly translationSessionId: string; readonly unitId: string }
  | { readonly kind: 'list_terms'; readonly translationSessionId: string }
  | { readonly kind: 'query_terms'; readonly translationSessionId: string; readonly sourceLanguage: string | null; readonly targetLanguage: string; readonly forms: readonly string[] }
  | { readonly kind: 'upsert_term'; readonly translationSessionId: string; readonly expectedVersion: number; readonly entry: TopicTermPut }
export type TopicBridgeValue =
  | { readonly kind: 'sessions'; readonly sessions: readonly TopicSessionSummary[]; readonly persistence?: TopicPersistence }
  | { readonly kind: 'topics'; readonly topics: readonly TopicSummary[] }
  | { readonly kind: 'session_created'; readonly session: TopicSessionSummary; readonly reason: string; readonly persistence: TopicPersistence }
  | { readonly kind: 'unit'; readonly unit: TopicUnitFact }
  | { readonly kind: 'terms' | 'terms_query'; readonly snapshot: TopicTermSnapshot }
export interface TopicBridgeRequest {
  readonly kind: 'request'
  readonly requestId: string
  readonly mainSessionId: string
  readonly callId: string
  readonly command: TopicBridgeCommand
}
export type TopicBridgeDown = ({ readonly kind: 'ready' } & TopicBridgeOpen) | TopicBridgeRequest
export type TopicBridgeReply = { readonly requestId: string } & (
  | { readonly ok: true; readonly value: TopicBridgeValue }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } })

type Data = Record<string, unknown>
function object(value: unknown): asserts value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected topic bridge object')
}
function exact(value: Data, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError('Unexpected topic bridge fields')
}
function text(value: unknown, limit = 2048, empty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw new TypeError('Invalid topic bridge text')
}
function content(value: unknown, limit: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || [...value].length > limit || (!empty && !value.trim())) throw new TypeError('Invalid topic bridge content')
}
function boolean(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') throw new TypeError('Invalid topic bridge flag')
}
function persistence(value: unknown): asserts value is TopicPersistence {
  if (value !== 'saved' && value !== 'runtime_only') throw new TypeError('Invalid topic persistence receipt')
}
function integer(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError('Invalid topic bridge version')
}
function strings(value: unknown, maximum = 2048, count = 1000): asserts value is string[] {
  if (!Array.isArray(value) || value.length > count) throw new TypeError('Invalid topic bridge list')
  value.forEach(item => text(item, maximum))
}
export function parseTopicBridgeOpen(value: unknown): TopicBridgeOpen {
  object(value); exact(value, ['ownerId', 'mainSessionId']); text(value.ownerId); text(value.mainSessionId)
  if (value.ownerId !== value.mainSessionId) throw new TypeError('Topic bridge requires its own main Session')
  return { ownerId: value.ownerId, mainSessionId: value.mainSessionId }
}
export function parseTopicBridgeCommand(value: unknown): TopicBridgeCommand {
  object(value)
  switch (value.kind) {
      case 'list_sessions': case 'list_topics': exact(value, ['kind']); break
      case 'list_topic_terms': exact(value, ['kind', 'topicId']); text(value.topicId); break
      case 'create_session': {
        exact(value, ['kind', 'start', 'reason']); content(value.reason, 1000); object(value.start)
        switch (value.start.kind) {
          case 'new_topic': exact(value.start, ['kind']); break
          case 'parent_session': exact(value.start, ['kind', 'translationSessionId']); text(value.start.translationSessionId); break
          case 'existing_topic': exact(value.start, ['kind', 'topicId']); text(value.start.topicId); break
          default: throw new TypeError('Invalid translation Session start')
        }
        break
      }
      case 'rename_topic':
        exact(value, ['kind', 'topicId', 'expectedName', 'name']); text(value.topicId); content(value.expectedName, 120); content(value.name, 120); break
      case 'set_session_remark':
        exact(value, ['kind', 'translationSessionId', 'expectedRemark', 'remark']); text(value.translationSessionId); content(value.expectedRemark, 1000, true); content(value.remark, 1000, true); break
      case 'archive_session':
        exact(value, ['kind', 'translationSessionId', 'expectedArchived', 'archived']); text(value.translationSessionId); boolean(value.expectedArchived); boolean(value.archived); break
      case 'read_unit': exact(value, ['kind', 'translationSessionId', 'unitId']); text(value.unitId); break
      case 'list_terms': exact(value, ['kind', 'translationSessionId']); break
      case 'query_terms':
        exact(value, ['kind', 'translationSessionId', 'sourceLanguage', 'targetLanguage', 'forms'])
        if (value.sourceLanguage !== null) text(value.sourceLanguage, 80)
        text(value.targetLanguage, 80); strings(value.forms, 500, 100); break
      case 'upsert_term': {
        exact(value, ['kind', 'translationSessionId', 'expectedVersion', 'entry']); integer(value.expectedVersion)
        text(value.translationSessionId)
        const entry = decodeTopicTermPut(value.entry)
        if (!entry) throw new TypeError('Invalid model term proposal')
        return { kind: 'upsert_term', translationSessionId: value.translationSessionId, expectedVersion: value.expectedVersion, entry }
      }
      default: throw new TypeError('Unknown topic bridge command')
  }
  if (['read_unit', 'list_terms', 'query_terms'].includes(value.kind as string)) text(value.translationSessionId)
  return structuredClone(value) as unknown as TopicBridgeCommand
}
export function parseTopicBridgeDown(value: unknown): TopicBridgeDown {
  object(value)
  if (value.kind === 'ready') {
    exact(value, ['kind', 'ownerId', 'mainSessionId'])
    return { kind: 'ready', ...parseTopicBridgeOpen({ ownerId: value.ownerId, mainSessionId: value.mainSessionId }) }
  }
  exact(value, ['kind', 'requestId', 'mainSessionId', 'callId', 'command'])
  if (value.kind !== 'request') throw new TypeError('Invalid topic bridge frame')
  text(value.requestId); text(value.mainSessionId); text(value.callId)
  return { kind: 'request', requestId: value.requestId, mainSessionId: value.mainSessionId, callId: value.callId, command: parseTopicBridgeCommand(value.command) }
}
function parseUnit(value: unknown): TopicUnitFact {
  object(value); exact(value, ['id', 'order', 'source', 'targetLanguage', 'instruction', 'revisions', 'final'])
  text(value.id); integer(value.order, 1); text(value.source, 2_000_000); text(value.targetLanguage, 200); text(value.instruction, 20_000, true)
  if (!Array.isArray(value.revisions)) throw new TypeError('Invalid topic unit versions')
  for (const revision of value.revisions) {
    object(revision); exact(revision, ['id', 'order', 'kind', 'status', 'text', 'baseRevisionId'])
    text(revision.id); integer(revision.order, 1); text(revision.text, 2_000_000, true)
    if (revision.baseRevisionId !== null) text(revision.baseRevisionId)
    if (!['machine', 'manual'].includes(revision.kind as string) || !['submitting', 'running', 'completed', 'failed', 'cancelled', 'unknown', 'interrupted'].includes(revision.status as string)) throw new TypeError('Invalid topic unit state')
  }
  if (value.final !== null) {
    object(value.final); exact(value.final, ['revisionId', 'selection', 'selectionEventId']); text(value.final.revisionId); text(value.final.selectionEventId)
    if (!['automatic', 'user_fixed'].includes(value.final.selection as string) || !value.revisions.some(revision => revision.id === (value.final as Data).revisionId)) throw new TypeError('Invalid topic unit final')
  }
  return structuredClone(value) as unknown as TopicUnitFact
}
function sessionSummary(value: unknown): void {
  object(value); exact(value, ['id', 'topicId', 'name', 'mode', 'publishedUnitIds', 'topicName', 'sequence', 'remark', 'archived'])
  text(value.id); text(value.topicId); content(value.name, 200); content(value.topicName, 120); integer(value.sequence); content(value.remark, 1000, true); boolean(value.archived)
  if (value.mode !== 'quick' && value.mode !== 'normal') throw new TypeError('Invalid translation Session mode')
  strings(value.publishedUnitIds)
}
function parseValue(value: unknown): TopicBridgeValue {
  object(value)
  switch (value.kind) {
    case 'sessions':
      exact(value, value.persistence === undefined ? ['kind', 'sessions'] : ['kind', 'sessions', 'persistence'])
      if (value.persistence !== undefined) persistence(value.persistence)
      if (!Array.isArray(value.sessions) || value.sessions.length > 1000) throw new TypeError('Invalid topic session list')
      value.sessions.forEach(sessionSummary)
      break
    case 'topics':
      exact(value, ['kind', 'topics'])
      if (!Array.isArray(value.topics) || value.topics.length > 1000) throw new TypeError('Invalid topic metadata list')
      for (const topic of value.topics) {
        object(topic); exact(topic, ['id', 'name', 'nextSequence', 'sessionIds'])
        text(topic.id); content(topic.name, 120); integer(topic.nextSequence); strings(topic.sessionIds)
      }
      break
    case 'session_created':
      exact(value, ['kind', 'session', 'reason', 'persistence']); sessionSummary(value.session); content(value.reason, 1000); persistence(value.persistence)
      break
    case 'unit': exact(value, ['kind', 'unit']); return { kind: 'unit', unit: parseUnit(value.unit) }
    case 'terms': case 'terms_query': {
      exact(value, ['kind', 'snapshot'])
      const snapshot = decodeTopicTermSnapshot(value.snapshot)
      if (!snapshot || (value.kind === 'terms_query' && snapshot.entries.some(entry => entry.status !== 'active'))) throw new TypeError('Invalid topic terms reply')
      return { kind: value.kind, snapshot }
    }
    default: throw new TypeError('Unknown topic bridge reply')
  }
  return structuredClone(value) as unknown as TopicBridgeValue
}
/** Untrusted uplink parsing happens once at the Gateway boundary. */
export function parseTopicBridgeReply(value: unknown): TopicBridgeReply {
  object(value); text(value.requestId)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_TOPIC_BRIDGE_REPLY_BYTES) throw new TypeError('Topic reply exceeds Gateway budget')
  if (value.ok === true) {
    exact(value, ['requestId', 'ok', 'value'])
    return { requestId: value.requestId, ok: true, value: parseValue(value.value) }
  }
  if (value.ok !== false) throw new TypeError('Invalid topic bridge receipt')
  exact(value, ['requestId', 'ok', 'error']); object(value.error); exact(value.error, ['code', 'message']); text(value.error.code, 80); text(value.error.message, 1000)
  return { requestId: value.requestId, ok: false, error: { code: value.error.code, message: value.error.message } }
}
export function parseTopicBridgeCapability(value: unknown): TopicBridgeCapability {
  object(value)
  if (typeof value.ready !== 'boolean' || Object.keys(value).some(key => !['ready', 'reason'].includes(key))) throw new TypeError('Invalid topic bridge readiness')
  if (value.reason !== undefined) text(value.reason, 1000)
  return structuredClone(value) as unknown as TopicBridgeCapability
}
const packageName = 'dsh-translation-plugin'
const codec = (name: string, parse: (value: unknown) => unknown) => ({ mode: 'strict' as const, typeSymbol: `${packageName}#topicBridge/${name}`, create: () => ({ parse }) })
/** Public InvocationDescriptor fields from the installed Gateway's stream/uplink contract. */
export const TOPIC_BRIDGE_REMOTE = { package: packageName, descriptors: [
  { id: `${packageName}#translationTopics/capabilities`, service: 'translationTopics', namespace: 'translationTopics', method: 'capabilities',
    invocation: { kind: 'direct' as const }, parameters: [], result: codec('capability', parseTopicBridgeCapability) },
  { id: `${packageName}#translationTopics/connect`, service: 'translationTopics', namespace: 'translationTopics', method: 'connect', mode: 'stream' as const,
    invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: codec('open', parseTopicBridgeOpen) }],
    cancellation: { parameter: 'signal' }, result: codec('down', parseTopicBridgeDown), uplink: { codec: codec('reply', parseTopicBridgeReply) } },
] }
