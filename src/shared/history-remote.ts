import { referenceExact, referenceInteger, referenceObject, referenceString, referenceBytes } from './reference-memory.js'
import type { HistoryScope } from './history-bundle.js'
import type { HistoryCleanupResult } from './history-cleanup.js'
import { decodeSession, type LocalSession } from './sessions.js'
export const HISTORY_TRANSFER_POINTS = 16000
export const HISTORY_BUNDLE_BYTES = 32 * 1024 * 1024
export interface HistoryStatus { readonly switched: boolean; readonly token: string | null; readonly retired: boolean; readonly persistence: 'saved' | 'runtime_only'; readonly hasSaved: boolean }
export interface HistoryList { readonly namespaceId: string; readonly topicId?: string; readonly after?: string }
export interface HistoryListing { readonly sessions: readonly { readonly sessionId: string; readonly topicId: string; readonly state: HistoryStatus; readonly session?: LocalSession }[]; readonly next: string | null }
export interface HistoryBegin extends HistoryScope { readonly purpose: 'create' | 'migrate' | 'replace' | 'patch'; readonly expectedToken: string | null; readonly currentPoints: number; readonly savedPoints: number | null }
export interface HistoryTransfer extends HistoryScope { readonly transferId: string }
export interface HistoryPartUpload extends HistoryTransfer { readonly layer: 'current' | 'saved'; readonly offset: number; readonly text: string }
export interface HistoryRead extends HistoryScope { readonly token: string; readonly layer: 'current' | 'saved'; readonly offset: number }
export interface HistoryMutation extends HistoryScope { readonly token: string; readonly operationId: string; readonly command: { readonly kind: 'delete_text_revision' | 'delete_document_revision'; readonly unitId: string; readonly revisionId: string } | { readonly kind: 'delete_file_result' | 'delete_document_source' | 'delete_file_source'; readonly unitId: string; readonly version: number } | { readonly kind: 'delete_unit' | 'delete_document_chunks'; readonly unitId: string } }
export interface HistoryRetire extends HistoryScope { readonly token: string; readonly operationId: string }
export interface CurrentHistoryRead extends HistoryScope { readonly token: string; readonly unitId: string; readonly side: 'source' | 'translation'; readonly start: number }
export interface HistoryTextSearch extends CurrentHistoryRead { readonly query: string }
export interface HistoryTextMatches { readonly matches: readonly { readonly start: number; readonly end: number }[]; readonly next: number | null }
export interface HistoryCurrentPage {
  readonly token: string; readonly unitId: string; readonly kind: 'text' | 'document' | 'file_job' | 'image'; readonly sourceVersion?: number
  readonly finalId: string | null; readonly targetLanguage: string; readonly text: string | null; readonly totalCodePoints: number; readonly next: number | null; readonly reason?: string
}
export interface HistoryRemotePort {
  list(request: HistoryList): Promise<HistoryListing>
  status(request: HistoryScope): Promise<HistoryStatus>
  read(request: HistoryRead): Promise<{ readonly text: string; readonly next: number | null }>
  begin(request: HistoryBegin): Promise<{ readonly transferId: string }>
  part(request: HistoryPartUpload): Promise<{ readonly next: number }>
  commit(request: HistoryTransfer): Promise<HistoryStatus>
  cancel(request: HistoryTransfer): Promise<{ readonly cancelled: true }>
  mutate(request: HistoryMutation): Promise<{ readonly status: 'updated' | 'stale' | 'blocked'; readonly state: HistoryStatus; readonly reason?: string; readonly resourceCleanup?: HistoryCleanupResult }>
  retire(request: HistoryRetire): ReturnType<HistoryRemotePort['mutate']>
  readCurrent(request: CurrentHistoryRead, signal: AbortSignal): Promise<HistoryCurrentPage>
  searchCurrent(request: HistoryTextSearch, signal: AbortSignal): Promise<HistoryTextMatches>
}
export type HistoryRemoteClientPort = { [K in keyof HistoryRemotePort]: (...args: Parameters<HistoryRemotePort[K]>) => Promise<unknown> }
export function parseHistoryScope(value: unknown): asserts value is HistoryScope & Record<string, unknown> {
  referenceObject(value); for (const field of ['namespaceId', 'topicId', 'sessionId']) referenceString(value[field], 3000)
}
export function parseHistoryRequest(method: keyof HistoryRemotePort, value: unknown): any {
  if (method === 'list') {
    referenceObject(value); referenceExact(value, ['namespaceId'], ['topicId', 'after']); referenceString(value.namespaceId, 3000)
    if (value.topicId !== undefined) referenceString(value.topicId, 3000); if (value.after !== undefined) referenceString(value.after, 3000)
    return structuredClone(value)
  }
  parseHistoryScope(value)
  const base = ['namespaceId', 'topicId', 'sessionId']
  if (method === 'status') referenceExact(value, base)
  else if (method === 'begin') {
    referenceExact(value, [...base, 'purpose', 'expectedToken', 'currentPoints', 'savedPoints'])
    if (!['create', 'migrate', 'replace', 'patch'].includes(String(value.purpose))) throw new TypeError('Invalid history transfer purpose')
    if (value.expectedToken !== null) referenceString(value.expectedToken)
    referenceInteger(value.currentPoints, 1); if ((value.currentPoints as number) > HISTORY_BUNDLE_BYTES) throw new TypeError('History batch is too large')
    if (value.savedPoints !== null) { referenceInteger(value.savedPoints, 1); if ((value.savedPoints as number) > HISTORY_BUNDLE_BYTES) throw new TypeError('History batch is too large') }
    if (['replace', 'patch'].includes(String(value.purpose)) && (value.savedPoints !== null || value.expectedToken === null)) throw new TypeError('Replacement preserves the Host saved layer unless explicitly persisted')
    if (value.purpose === 'create' && (value.savedPoints !== null || value.expectedToken !== null)) throw new TypeError('New sessions do not import a legacy saved layer')
  } else if (method === 'read') {
    referenceExact(value, [...base, 'token', 'layer', 'offset']); referenceString(value.token); referenceInteger(value.offset)
    if (!['current', 'saved'].includes(String(value.layer))) throw new TypeError('Invalid history layer')
  } else if (method === 'readCurrent' || method === 'searchCurrent') {
    referenceExact(value, [...base, 'token', 'unitId', 'side', 'start', ...(method === 'searchCurrent' ? ['query'] : [])]); referenceString(value.token); referenceString(value.unitId); referenceInteger(value.start)
    if (!['source', 'translation'].includes(String(value.side))) throw new TypeError('Invalid history side')
    if (method === 'searchCurrent') { referenceString(value.query, 4000, true); if (!value.query.length) throw new TypeError('Empty history query') }
  } else if (method === 'retire') {
    referenceExact(value, [...base, 'token', 'operationId']); referenceString(value.token); referenceString(value.operationId)
  } else if (method === 'mutate') {
    referenceExact(value, [...base, 'token', 'operationId', 'command']); referenceString(value.token); referenceString(value.operationId); referenceObject(value.command)
    referenceExact(value.command, ['kind', 'unitId', ...(['delete_text_revision', 'delete_document_revision'].includes(String(value.command.kind)) ? ['revisionId'] : ['delete_file_result', 'delete_document_source', 'delete_file_source'].includes(String(value.command.kind)) ? ['version'] : [])]); referenceString(value.command.unitId)
    if (value.command.kind === 'delete_text_revision' || value.command.kind === 'delete_document_revision') referenceString(value.command.revisionId)
    else if (value.command.kind === 'delete_file_result' || value.command.kind === 'delete_document_source' || value.command.kind === 'delete_file_source') referenceInteger(value.command.version, 1)
    else if (!['delete_unit', 'delete_document_chunks'].includes(String(value.command.kind))) throw new TypeError('Unsupported history mutation')
  } else {
    referenceExact(value, [...base, 'transferId', ...(method === 'part' ? ['layer', 'offset', 'text'] : [])]); referenceString(value.transferId)
    if (method === 'part') {
      if (!['current', 'saved'].includes(String(value.layer))) throw new TypeError('Invalid history transfer layer')
      referenceInteger(value.offset)
      if (typeof value.text !== 'string' || !value.text.length || Array.from(value.text).length > HISTORY_TRANSFER_POINTS) throw new TypeError('Invalid history transfer text')
    }
  }
  return structuredClone(value)
}
export function parseHistoryResult(method: keyof HistoryRemotePort, value: unknown): any {
  referenceObject(value)
  if (method === 'list') {
    referenceExact(value, ['sessions', 'next']); if (!Array.isArray(value.sessions) || value.sessions.length > 20) throw new TypeError('Invalid history list')
    for (const entry of value.sessions) {
      referenceObject(entry); referenceExact(entry, ['sessionId', 'topicId', 'state'], ['session']); referenceString(entry.sessionId, 3000); referenceString(entry.topicId, 3000); parseHistoryResult('status', entry.state)
      if (entry.session !== undefined && (!decodeSession(entry.session) || (entry.session as LocalSession).id !== entry.sessionId || (entry.session as LocalSession).topicId !== entry.topicId || ['input', 'instruction', 'legacyManualText'].some(field => (entry.session as any)[field] !== ''))) throw new TypeError('Invalid history directory metadata')
      if (!(entry.state as HistoryStatus).retired && !entry.session) throw new TypeError('Missing history directory metadata')
    }
    if (value.next !== null) referenceString(value.next, 3000)
  } else if (method === 'status' || method === 'commit') {
    referenceExact(value, ['switched', 'token', 'retired', 'persistence', 'hasSaved'])
    if (typeof value.switched !== 'boolean' || typeof value.retired !== 'boolean' || typeof value.hasSaved !== 'boolean' || !['saved', 'runtime_only'].includes(String(value.persistence))) throw new TypeError('Invalid history status')
    if (value.token !== null) referenceString(value.token)
    if (value.switched !== (value.token !== null)) throw new TypeError('Invalid history authority token')
  } else if (method === 'begin') { referenceExact(value, ['transferId']); referenceString(value.transferId) }
  else if (method === 'part') { referenceExact(value, ['next']); referenceInteger(value.next) }
  else if (method === 'cancel') { referenceExact(value, ['cancelled']); if (value.cancelled !== true) throw new TypeError('Invalid history cancellation') }
  else if (method === 'read') { referenceExact(value, ['text', 'next']); if (typeof value.text !== 'string' || !value.text.length || Array.from(value.text).length > 4000) throw new TypeError('Invalid history page'); if (value.next !== null) referenceInteger(value.next, 1) }
  else if (method === 'mutate' || method === 'retire') {
    referenceExact(value, ['status', 'state'], ['reason', 'resourceCleanup']); if (!['updated', 'stale', 'blocked'].includes(String(value.status))) throw new TypeError('Invalid history mutation'); parseHistoryResult('status', value.state); if (value.reason !== undefined) referenceString(value.reason, 500)
    if (value.resourceCleanup !== undefined) { referenceObject(value.resourceCleanup); referenceExact(value.resourceCleanup, ['complete', 'removed', 'retained']); if (typeof value.resourceCleanup.complete !== 'boolean') throw new TypeError('Invalid cleanup result'); referenceInteger(value.resourceCleanup.removed); referenceInteger(value.resourceCleanup.retained) }
  }
  else if (method === 'searchCurrent') {
    referenceExact(value, ['matches', 'next']); if (!Array.isArray(value.matches) || value.matches.length > 250) throw new TypeError('Invalid history search matches')
    let end = 0
    for (const match of value.matches) { referenceObject(match); referenceExact(match, ['start', 'end']); referenceInteger(match.start); referenceInteger(match.end, (match.start as number) + 1); if ((match.start as number) < end) throw new TypeError('Unordered history matches'); end = match.end as number }
    if (value.next !== null) referenceInteger(value.next, Math.max(1, end))
  } else {
    referenceExact(value, ['token', 'unitId', 'kind', 'finalId', 'targetLanguage', 'text', 'totalCodePoints', 'next'], ['reason', 'sourceVersion'])
    referenceString(value.token); referenceString(value.unitId); referenceString(value.targetLanguage, 80)
    if (!['text', 'document', 'file_job', 'image'].includes(String(value.kind))) throw new TypeError('Invalid history unit kind')
    if (value.kind !== 'image') referenceInteger(value.sourceVersion, 1)
    else if (Object.hasOwn(value, 'sourceVersion')) throw new TypeError('Image source is unversioned')
    referenceInteger(value.totalCodePoints)
    if (value.finalId !== null) referenceString(value.finalId)
    if (value.text !== null) { if (typeof value.text !== 'string' || Array.from(value.text).length > 4000) throw new TypeError('Invalid current text') }
    if (value.next !== null) referenceInteger(value.next, 1)
    if (value.reason !== undefined) referenceString(value.reason, 500)
  }
  if (referenceBytes(value) > 32768) throw new TypeError('History reply exceeds 32768 bytes')
  return structuredClone(value)
}
export const HISTORY_REMOTE = { package: 'dsh-translation-plugin', descriptors: (['list', 'status', 'read', 'begin', 'part', 'commit', 'cancel', 'mutate', 'retire', 'readCurrent', 'searchCurrent'] as const).map(method => ({
  id: `dsh-translation-plugin#translationHistory/${method}`, service: 'translationHistory', namespace: 'translationHistory', method, invocation: { kind: 'direct' as const },
  parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#history-${method}`, create: () => ({ parse: (value: unknown) => parseHistoryRequest(method, value) }) } }],
  ...(['readCurrent', 'searchCurrent'].includes(method) ? { cancellation: { parameter: 'signal' } } : {}),
  result: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#history-${method}-result`, create: () => ({ parse: (value: unknown) => parseHistoryResult(method, value) }) },
})) }
