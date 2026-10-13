import { decodeTopicTermPut, decodeTopicTermSnapshot, type TopicTermPut, type TopicTermSnapshot } from '../memory/topic-terms.js'
import { decodeTopicArchivePut, decodeTopicArchiveSnapshot, decodeTopicArchiveQuerySnapshot, type TopicArchivePut, type TopicArchiveSnapshot, type TopicArchiveKind } from '../memory/topic-archive.js'
import { parseNormalTranslationAcceptance, parseNormalTranslationOperation, parseNormalTranslationUpdate, parseNormalTranslationTarget, parseNormalTranslationSourceCorrection, parseNormalTranslationCorrectionReceipt, type NormalTranslationAcceptance, type NormalTranslationOperation, type NormalTranslationUpdate, type NormalTranslationUnitTarget, type NormalTranslationSourceCorrection, type NormalTranslationCorrectionReceipt } from './normal-translation.js'
import { parseTranslationMaterialEnvelope, type TranslationMaterialEnvelope } from './translation-material.js'
import { parseNormalTranslationV2Event, type NormalTranslationResolution, type NormalTranslationV2Event } from './normal-translation-v2.js'
import {
  parseTranslationPreparationPrepare, parseTranslationPreparationSet, parseTranslationPreparationQuery, parseTranslationPreparationRead,
  parsePreparationAnalysisFacts, parsePreparationReceipt, parsePreparationPage,
  type TranslationPreparationPrepare, type TranslationPreparationSet, type TranslationPreparationQuery, type TranslationPreparationRead,
  type PreparationAnalysisFacts, type PreparationReceipt, type PreparationPage,
} from './translation-preparation.js'

/** Below the installed Gateway's default 256 KiB uplink inbox. Replies are never silently truncated. */
export const MAX_TOPIC_BRIDGE_REPLY_BYTES = 196_608
export interface TopicBridgeOpen { readonly ownerId: string; readonly mainSessionId: string }
export interface TopicBridgeCapability { readonly ready: boolean; readonly reason?: string }
export interface TopicBridgeV2Capability extends TopicBridgeCapability { readonly normalProtocol: 2 }
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
  readonly sourceVersion: number
  readonly targetLanguage: string
  readonly instruction: string
  readonly revisions: readonly {
    readonly id: string; readonly order: number; readonly kind: 'machine' | 'manual'
    readonly status: 'submitting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'interrupted' | 'context_requested'
    readonly text: string; readonly baseRevisionId: string | null; readonly sourceVersion: number
  }[]
  readonly final: { readonly revisionId: string; readonly selection: 'automatic' | 'user_fixed'; readonly selectionEventId: string } | null
}
export type TopicBridgeCommand =
  | { readonly kind: 'preparation_prepare'; readonly request: TranslationPreparationPrepare; readonly envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }>; readonly analysis: PreparationAnalysisFacts }
  | { readonly kind: 'preparation_set'; readonly request: TranslationPreparationSet; readonly envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }> }
  | { readonly kind: 'preparation_status'; readonly request: TranslationPreparationQuery }
  | { readonly kind: 'preparation_read'; readonly request: TranslationPreparationRead }
  | { readonly kind: 'normal_resolve'; readonly target: NormalTranslationUnitTarget; readonly operationId: string }
  | ({ readonly kind: 'normal_correct_source' } & NormalTranslationSourceCorrection)
  | ({ readonly kind: 'normal_accept' } & NormalTranslationAcceptance)
  | ({ readonly kind: 'normal_prepare' } & NormalTranslationAcceptance)
  | ({ readonly kind: 'normal_update' } & NormalTranslationUpdate)
  | { readonly kind: 'normal_v2_update'; readonly mainSessionId: string; readonly translationSessionId: string; readonly unitId: string; readonly operationId: string; readonly sourceVersion: number; readonly event: NormalTranslationV2Event }
  | { readonly kind: 'normal_exchange_resolve'; readonly translationSessionId: string; readonly exchangeId: string; readonly resolution: NormalTranslationResolution }
  | { readonly kind: 'normal_observe'; readonly translationSessionId: string; readonly operationId: string }
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
  | { readonly kind: 'list_topic_archive'; readonly topicId: string }
  | { readonly kind: 'query_archive'; readonly translationSessionId: string; readonly kinds: readonly TopicArchiveKind[]; readonly forms: readonly string[] }
  | { readonly kind: 'upsert_archive'; readonly topicId: string; readonly expectedVersion: number; readonly entry: TopicArchivePut }
export type TopicBridgeValue =
  | { readonly kind: 'preparation_receipt'; readonly receipt: PreparationReceipt }
  | { readonly kind: 'preparation_page'; readonly page: PreparationPage }
  | { readonly kind: 'normal_resolved'; readonly envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }> }
  | { readonly kind: 'normal_source_corrected'; readonly correction: NormalTranslationCorrectionReceipt }
  | { readonly kind: 'normal_operation'; readonly operation: NormalTranslationOperation; readonly termSnapshot: TopicTermSnapshot }
  | { readonly kind: 'normal_prepared'; readonly termSnapshot: TopicTermSnapshot }
  | { readonly kind: 'normal_updated'; readonly operation: NormalTranslationOperation; readonly callId: string | null; readonly sequence: number }
  | { readonly kind: 'normal_v2_updated'; readonly operation: NormalTranslationOperation; readonly callId: string | null; readonly sequence: number }
  | { readonly kind: 'normal_exchange_resolved'; readonly exchangeId: string; readonly version: number; readonly status: 'waiting_user' | 'resuming' | 'cancelled' }
  | { readonly kind: 'normal_observed'; readonly operation: NormalTranslationOperation | null }
  | { readonly kind: 'sessions'; readonly sessions: readonly TopicSessionSummary[]; readonly persistence?: TopicPersistence }
  | { readonly kind: 'topics'; readonly topics: readonly TopicSummary[] }
  | { readonly kind: 'session_created'; readonly session: TopicSessionSummary; readonly reason: string; readonly persistence: TopicPersistence }
  | { readonly kind: 'unit'; readonly unit: TopicUnitFact }
  | { readonly kind: 'terms' | 'terms_query'; readonly snapshot: TopicTermSnapshot }
  | { readonly kind: 'archive' | 'archive_query'; readonly snapshot: TopicArchiveSnapshot }
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
export function parseTopicBridgeCommand(value: unknown, protocol: 1 | 2 = 1): TopicBridgeCommand {
  object(value)
  if (protocol === 1 && ['normal_v2_update', 'normal_exchange_resolve', 'preparation_prepare', 'preparation_set', 'preparation_status', 'preparation_read'].includes(value.kind as string)) throw new TypeError('Command requires topic bridge v2')
  switch (value.kind) {
      case 'preparation_prepare': {
        exact(value, ['kind', 'request', 'envelope', 'analysis'])
        const envelope = parseTranslationMaterialEnvelope(value.envelope)
        if (envelope.kind !== 'material') throw new TypeError('Preparation requires a material envelope')
        return { kind: 'preparation_prepare', request: parseTranslationPreparationPrepare(value.request), envelope, analysis: parsePreparationAnalysisFacts(value.analysis) }
      }
      case 'preparation_set': {
        exact(value, ['kind', 'request', 'envelope'])
        const envelope = parseTranslationMaterialEnvelope(value.envelope)
        if (envelope.kind !== 'material') throw new TypeError('Preparation requires a material envelope')
        return { kind: 'preparation_set', request: parseTranslationPreparationSet(value.request), envelope }
      }
      case 'preparation_status': exact(value, ['kind', 'request']); return { kind: 'preparation_status', request: parseTranslationPreparationQuery(value.request) }
      case 'preparation_read': exact(value, ['kind', 'request']); return { kind: 'preparation_read', request: parseTranslationPreparationRead(value.request) }
      case 'normal_resolve': {
        exact(value, ['kind', 'target', 'operationId']); text(value.operationId)
        const target = parseNormalTranslationTarget(value.target)
        if (target.kind !== 'unit') throw new TypeError('Normal resolve requires a unit')
        return { kind: 'normal_resolve', target, operationId: value.operationId }
      }
      case 'normal_correct_source': {
        const { kind, ...correction } = value
        return { kind: 'normal_correct_source', ...parseNormalTranslationSourceCorrection(correction) }
      }
      case 'normal_accept': case 'normal_prepare': {
        exact(value, ['kind', 'envelope', 'operationId', 'organizedRequirements', 'termReferences'])
        return { kind: value.kind, ...parseNormalTranslationAcceptance({ envelope: value.envelope, operationId: value.operationId,
          organizedRequirements: value.organizedRequirements, termReferences: value.termReferences }) }
      }
      case 'normal_update': {
        const { kind, ...update } = value
        return { kind: 'normal_update', ...parseNormalTranslationUpdate(update) }
      }
      case 'normal_v2_update': {
        exact(value, ['kind', 'mainSessionId', 'translationSessionId', 'unitId', 'operationId', 'sourceVersion', 'event'])
        for (const field of ['mainSessionId', 'translationSessionId', 'unitId', 'operationId']) text(value[field])
        integer(value.sourceVersion, 1)
        return { kind: 'normal_v2_update', mainSessionId: value.mainSessionId as string, translationSessionId: value.translationSessionId as string, unitId: value.unitId as string,
          operationId: value.operationId as string, sourceVersion: value.sourceVersion as number, event: parseNormalTranslationV2Event(value.event) }
      }
      case 'normal_exchange_resolve': {
        exact(value, ['kind', 'translationSessionId', 'exchangeId', 'resolution']); text(value.translationSessionId); text(value.exchangeId); object(value.resolution)
        if (value.resolution.kind === 'answer') {
          exact(value.resolution, ['resolutionId', 'observedVersion', 'kind', 'answerText', 'organizedRequirements', 'references'])
          text(value.resolution.resolutionId); integer(value.resolution.observedVersion, 1); content(value.resolution.answerText, 32768, true); content(value.resolution.organizedRequirements, 32768, true)
          if (new TextEncoder().encode(value.resolution.answerText + value.resolution.organizedRequirements).byteLength > 32768 ||
            !value.resolution.answerText.trim() && !value.resolution.organizedRequirements.trim()) throw new TypeError('Invalid exchange answer budget')
          if (!Array.isArray(value.resolution.references) || value.resolution.references.length > 32) throw new TypeError('Invalid exchange references')
          for (const reference of value.resolution.references) { object(reference); exact(reference, ['id', 'version']); text(reference.id); integer(reference.version, 1) }
        } else if (value.resolution.kind === 'defer' || value.resolution.kind === 'abort') {
          exact(value.resolution, ['resolutionId', 'observedVersion', 'kind', 'reason']); text(value.resolution.resolutionId); integer(value.resolution.observedVersion, 1); content(value.resolution.reason, 4096, true)
          if (new TextEncoder().encode(value.resolution.reason).byteLength > 4096) throw new TypeError('Invalid exchange reason budget')
        } else throw new TypeError('Invalid exchange resolution')
        return { kind: 'normal_exchange_resolve', translationSessionId: value.translationSessionId, exchangeId: value.exchangeId,
          resolution: structuredClone(value.resolution) as unknown as NormalTranslationResolution }
      }
      case 'normal_observe': exact(value, ['kind', 'translationSessionId', 'operationId']); text(value.translationSessionId); text(value.operationId); break
      case 'list_sessions': case 'list_topics': exact(value, ['kind']); break
      case 'list_topic_terms': case 'list_topic_archive': exact(value, ['kind', 'topicId']); text(value.topicId); break
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
      case 'query_archive':
        exact(value, ['kind', 'translationSessionId', 'kinds', 'forms']); text(value.translationSessionId)
        strings(value.kinds, 20, 3); strings(value.forms, 500, 100)
        if (value.kinds.some(kind => !['entity', 'fact', 'relation'].includes(kind))) throw new TypeError('Invalid topic archive kinds')
        break
      case 'upsert_archive': {
        exact(value, ['kind', 'topicId', 'expectedVersion', 'entry']); text(value.topicId); integer(value.expectedVersion)
        const entry = decodeTopicArchivePut(value.entry)
        if (!entry) throw new TypeError('Invalid model archive proposal')
        return { kind: 'upsert_archive', topicId: value.topicId, expectedVersion: value.expectedVersion, entry }
      }
      default: throw new TypeError('Unknown topic bridge command')
  }
  if (['read_unit', 'list_terms', 'query_terms'].includes(value.kind as string)) text(value.translationSessionId)
  return structuredClone(value) as unknown as TopicBridgeCommand
}
export function parseTopicBridgeDown(value: unknown, protocol: 1 | 2 = 1): TopicBridgeDown {
  object(value)
  if (value.kind === 'ready') {
    exact(value, ['kind', 'ownerId', 'mainSessionId'])
    return { kind: 'ready', ...parseTopicBridgeOpen({ ownerId: value.ownerId, mainSessionId: value.mainSessionId }) }
  }
  exact(value, ['kind', 'requestId', 'mainSessionId', 'callId', 'command'])
  if (value.kind !== 'request') throw new TypeError('Invalid topic bridge frame')
  text(value.requestId); text(value.mainSessionId); text(value.callId)
  return { kind: 'request', requestId: value.requestId, mainSessionId: value.mainSessionId, callId: value.callId, command: parseTopicBridgeCommand(value.command, protocol) }
}
function parseUnit(value: unknown, protocol: 1 | 2): TopicUnitFact {
  object(value); exact(value, ['id', 'order', 'source', 'targetLanguage', 'instruction', 'revisions', 'final', ...(value.sourceVersion === undefined ? [] : ['sourceVersion'])])
  const sourceVersion = value.sourceVersion ?? 1; integer(sourceVersion, 1)
  text(value.id); integer(value.order, 1); text(value.source, 2_000_000); text(value.targetLanguage, 200); text(value.instruction, 20_000, true)
  if (!Array.isArray(value.revisions)) throw new TypeError('Invalid topic unit versions')
  for (const revision of value.revisions) {
    object(revision); exact(revision, ['id', 'order', 'kind', 'status', 'text', 'baseRevisionId', ...(revision.sourceVersion === undefined ? [] : ['sourceVersion'])])
    integer(revision.sourceVersion ?? 1, 1)
    text(revision.id); integer(revision.order, 1); text(revision.text, 2_000_000, true)
    if (revision.baseRevisionId !== null) text(revision.baseRevisionId)
    if (!['machine', 'manual'].includes(revision.kind as string) || !['submitting', 'running', 'completed', 'failed', 'cancelled', 'unknown', 'interrupted', ...(protocol === 2 ? ['context_requested'] : [])].includes(revision.status as string)) throw new TypeError('Invalid topic unit state')
  }
  if (value.final !== null) {
    object(value.final); exact(value.final, ['revisionId', 'selection', 'selectionEventId']); text(value.final.revisionId); text(value.final.selectionEventId)
    if (!['automatic', 'user_fixed'].includes(value.final.selection as string) || !value.revisions.some(revision => revision.id === (value.final as Data).revisionId)) throw new TypeError('Invalid topic unit final')
  }
  return { ...structuredClone(value), sourceVersion, revisions: value.revisions.map(revision => ({ ...structuredClone(revision), sourceVersion: revision.sourceVersion ?? 1 })) } as unknown as TopicUnitFact
}
function sessionSummary(value: unknown): void {
  object(value); exact(value, ['id', 'topicId', 'name', 'mode', 'publishedUnitIds', 'topicName', 'sequence', 'remark', 'archived'])
  text(value.id); text(value.topicId); content(value.name, 200); content(value.topicName, 120); integer(value.sequence); content(value.remark, 1000, true); boolean(value.archived)
  if (value.mode !== 'quick' && value.mode !== 'normal') throw new TypeError('Invalid translation Session mode')
  strings(value.publishedUnitIds)
}
function parseValue(value: unknown, protocol: 1 | 2): TopicBridgeValue {
  object(value)
  if (protocol === 1 && ['normal_v2_updated', 'normal_exchange_resolved', 'preparation_receipt', 'preparation_page'].includes(value.kind as string)) throw new TypeError('Reply requires topic bridge v2')
  switch (value.kind) {
    case 'preparation_receipt': exact(value, ['kind', 'receipt']); return { kind: 'preparation_receipt', receipt: parsePreparationReceipt(value.receipt) }
    case 'preparation_page': exact(value, ['kind', 'page']); return { kind: 'preparation_page', page: parsePreparationPage(value.page) }
    case 'normal_resolved': {
      exact(value, ['kind', 'envelope']); const envelope = parseTranslationMaterialEnvelope(value.envelope)
      if (envelope.kind !== 'material' || !envelope.material.unitReference) throw new TypeError('Invalid unit resolution')
      return { kind: 'normal_resolved', envelope }
    }
    case 'normal_source_corrected': exact(value, ['kind', 'correction']); return { kind: 'normal_source_corrected', correction: parseNormalTranslationCorrectionReceipt(value.correction) }
    case 'normal_observed': exact(value, ['kind', 'operation']); return { kind: 'normal_observed', operation: value.operation === null ? null : parseNormalTranslationOperation(value.operation) }
    case 'normal_prepared': {
      exact(value, ['kind', 'termSnapshot'])
      const termSnapshot = decodeTopicTermSnapshot(value.termSnapshot)
      if (!termSnapshot || termSnapshot.entries.some(entry => entry.status !== 'active')) throw new TypeError('Invalid normal translation preparation')
      return { kind: 'normal_prepared', termSnapshot }
    }
    case 'normal_updated': {
      exact(value, ['kind', 'operation', 'callId', 'sequence']); if (value.callId !== null) text(value.callId); integer(value.sequence, 1)
      return { kind: 'normal_updated', operation: parseNormalTranslationOperation(value.operation), callId: value.callId, sequence: value.sequence }
    }
    case 'normal_v2_updated': {
      exact(value, ['kind', 'operation', 'callId', 'sequence']); if (value.callId !== null) text(value.callId); integer(value.sequence, 1)
      return { kind: 'normal_v2_updated', operation: parseNormalTranslationOperation(value.operation), callId: value.callId, sequence: value.sequence }
    }
    case 'normal_exchange_resolved': {
      exact(value, ['kind', 'exchangeId', 'version', 'status']); text(value.exchangeId); integer(value.version, 1)
      if (!['waiting_user', 'resuming', 'cancelled'].includes(value.status as string)) throw new TypeError('Invalid exchange resolution state')
      return structuredClone(value) as unknown as TopicBridgeValue
    }
    case 'normal_operation': {
      exact(value, ['kind', 'operation', 'termSnapshot'])
      const operation = parseNormalTranslationOperation(value.operation), termSnapshot = decodeTopicTermSnapshot(value.termSnapshot)
      if (!termSnapshot || termSnapshot.ownerId !== operation.mainSessionId || termSnapshot.topicId !== operation.topicId || termSnapshot.entries.some(entry => entry.status !== 'active')) throw new TypeError('Invalid normal translation term package')
      return { kind: 'normal_operation', operation, termSnapshot }
    }
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
    case 'unit': exact(value, ['kind', 'unit']); return { kind: 'unit', unit: parseUnit(value.unit, protocol) }
    case 'terms': case 'terms_query': {
      exact(value, ['kind', 'snapshot'])
      const snapshot = decodeTopicTermSnapshot(value.snapshot)
      if (!snapshot || (value.kind === 'terms_query' && snapshot.entries.some(entry => entry.status !== 'active'))) throw new TypeError('Invalid topic terms reply')
      return { kind: value.kind, snapshot }
    }
    case 'archive': case 'archive_query': {
      exact(value, ['kind', 'snapshot'])
      const snapshot = (value.kind === 'archive_query' ? decodeTopicArchiveQuerySnapshot : decodeTopicArchiveSnapshot)(value.snapshot)
      if (!snapshot) throw new TypeError('Invalid topic archive reply')
      return { kind: value.kind, snapshot }
    }
    default: throw new TypeError('Unknown topic bridge reply')
  }
  return structuredClone(value) as unknown as TopicBridgeValue
}
/** Untrusted uplink parsing happens once at the Gateway boundary. */
export function parseTopicBridgeReply(value: unknown, protocol: 1 | 2 = 1): TopicBridgeReply {
  object(value); text(value.requestId)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_TOPIC_BRIDGE_REPLY_BYTES) throw new TypeError('Topic reply exceeds Gateway budget')
  if (value.ok === true) {
    exact(value, ['requestId', 'ok', 'value'])
    return { requestId: value.requestId, ok: true, value: parseValue(value.value, protocol) }
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
export function parseTopicBridgeV2Capability(value: unknown): TopicBridgeV2Capability {
  object(value)
  if (value.normalProtocol !== 2) throw new TypeError('Topic bridge v2 version mismatch')
  const { normalProtocol: _protocol, ...capability } = value
  return { ...parseTopicBridgeCapability(capability), normalProtocol: 2 }
}
/** Public InvocationDescriptor fields from the installed Gateway's stream/uplink contract. */
export const TOPIC_BRIDGE_REMOTE = { package: packageName, descriptors: [
  { id: `${packageName}#translationTopics/capabilities`, service: 'translationTopics', namespace: 'translationTopics', method: 'capabilities',
    invocation: { kind: 'direct' as const }, parameters: [], result: codec('capability', parseTopicBridgeCapability) },
  { id: `${packageName}#translationTopics/connect`, service: 'translationTopics', namespace: 'translationTopics', method: 'connect', mode: 'stream' as const,
    invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: codec('open', parseTopicBridgeOpen) }],
    cancellation: { parameter: 'signal' }, result: codec('down', parseTopicBridgeDown), uplink: { codec: codec('reply', parseTopicBridgeReply) } },
  { id: `${packageName}#translationTopics/capabilitiesV2`, service: 'translationTopics', namespace: 'translationTopics', method: 'capabilitiesV2',
    invocation: { kind: 'direct' as const }, parameters: [], result: codec('capabilityV2', parseTopicBridgeV2Capability) },
  { id: `${packageName}#translationTopics/connectV2`, service: 'translationTopics', namespace: 'translationTopics', method: 'connectV2', mode: 'stream' as const,
    invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: codec('openV2', parseTopicBridgeOpen) }],
    cancellation: { parameter: 'signal' }, result: codec('downV2', value => parseTopicBridgeDown(value, 2)), uplink: { codec: codec('replyV2', value => parseTopicBridgeReply(value, 2)) } },
] }
