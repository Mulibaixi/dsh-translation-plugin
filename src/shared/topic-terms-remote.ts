import { decodeTopicTermPut, decodeTopicTermUserInput, type TopicTermSnapshot, type TopicTermPut, type TopicTermUserPut, type TermMutationResult } from '../memory/topic-terms.js'
import { termEvidenceKey, type TermEvidenceRef, type FileProposalAcceptance } from '../memory/topic-terms.js'
import { referenceBytes, referenceExact, referenceInteger, referenceObject, referenceString } from './reference-memory.js'

export const TERM_TRANSFER_POINTS = 4000
export const TERM_TRANSFER_BYTES = 196608
export interface TermRemoteScope { readonly namespaceId: string; readonly ownerId: string; readonly topicId: string }
export type TermHead = Omit<TopicTermSnapshot, 'entries'> & { readonly count: number }
export interface TermStorageStatus { readonly switched: boolean; readonly token: string | null; readonly current: TermHead | null; readonly saved: TermHead | null; readonly persistence: 'saved' | 'runtime_only'; readonly retired?: true }
export type TermCommand = { readonly kind: 'put'; readonly input: TopicTermPut }
  | { readonly kind: 'accept_file_proposal' | 'revise_file_proposal'; readonly input: TopicTermPut; readonly acceptance: FileProposalAcceptance }
  | { readonly kind: 'user_put'; readonly input: TopicTermUserPut }
  | { readonly kind: 'adopt' | 'disable' | 'delete'; readonly id: string; readonly expectedEntryVersion: number }
  | { readonly kind: 'clear' | 'reconcile' }
export interface TermEvidenceState { readonly ref: TermEvidenceRef; readonly status: 'ready' | 'unloaded' | 'missing' }
export interface TermReadRequest extends TermRemoteScope { readonly token: string; readonly layer: 'current' | 'saved'; readonly offset: number }
export interface TermReadPage { readonly text: string; readonly nextOffset: number | null }
export interface TermMutationRequest extends TermRemoteScope { readonly token: string; readonly rememberHistory: boolean; readonly command: TermCommand; readonly evidence: readonly TermEvidenceState[] }
export interface TermMutationReceipt { readonly status: TermMutationResult['status']; readonly token: string; readonly entryId: string | null }
export interface TermMigrateBegin extends TermRemoteScope { readonly currentPoints: number; readonly storedPoints: number | null }
export interface TermMigrateCommit extends TermRemoteScope { readonly transferId: string }
export interface TermMigratePart extends TermMigrateCommit { readonly layer: 'current' | 'saved'; readonly offset: number; readonly text: string }
export interface TermsRemotePort {
  status(request: TermRemoteScope): Promise<TermStorageStatus>
  read(request: TermReadRequest): Promise<TermReadPage>
  migrateBegin(request: TermMigrateBegin): Promise<{ readonly transferId: string }>
  migratePart(request: TermMigratePart): Promise<{ readonly nextOffset: number }>
  migrateCommit(request: TermMigrateCommit): Promise<TermStorageStatus>
  migrateCancel(request: TermMigrateCommit): Promise<{ readonly cancelled: true }>
  mutate(request: TermMutationRequest): Promise<TermMutationReceipt>
  persist(request: TermRemoteScope & { readonly token: string }): Promise<TermStorageStatus>
  persistNamespace(request: { readonly namespaceId: string }): Promise<{ readonly persisted: true }>
}
export function parseTermScope(value: unknown): TermRemoteScope {
  referenceObject(value); referenceString(value.namespaceId); referenceString(value.ownerId); referenceString(value.topicId)
  return { namespaceId: value.namespaceId, ownerId: value.ownerId, topicId: value.topicId }
}
export function parseTermCommand(value: unknown): TermCommand {
  referenceObject(value)
  if (value.kind === 'put' || value.kind === 'accept_file_proposal' || value.kind === 'revise_file_proposal') {
    referenceExact(value, ['kind', 'input'], value.kind === 'put' ? [] : ['acceptance'])
    if (!decodeTopicTermPut(value.input)) throw new TypeError('Invalid term input')
    if (value.kind !== 'put') {
      referenceObject(value.acceptance); referenceExact(value.acceptance, ['eventId', 'at', 'batchId', 'candidateId', 'edited'])
      for (const field of ['eventId', 'at', 'batchId', 'candidateId']) referenceString(value.acceptance[field])
      if (typeof value.acceptance.edited !== 'boolean' || !Number.isFinite(Date.parse(value.acceptance.at as string))) throw new TypeError('Invalid term acceptance')
    }
  } else if (value.kind === 'user_put') { referenceExact(value, ['kind', 'input']); referenceObject(value.input); if (!decodeTopicTermUserInput(value.input) || value.input.id === null) throw new TypeError('Invalid user term input') }
  else if (value.kind === 'adopt' || value.kind === 'disable' || value.kind === 'delete') { referenceExact(value, ['kind', 'id', 'expectedEntryVersion']); referenceString(value.id); referenceInteger(value.expectedEntryVersion, 1) }
  else if (value.kind === 'clear' || value.kind === 'reconcile') referenceExact(value, ['kind'])
  else throw new TypeError('Invalid term command')
  return structuredClone(value) as unknown as TermCommand
}
type Method = keyof TermsRemotePort
export function parseTermRemoteRequest(method: Method, value: unknown): unknown {
  referenceObject(value)
  if (method === 'persistNamespace') { referenceExact(value, ['namespaceId']); referenceString(value.namespaceId); return structuredClone(value) }
  parseTermScope(value)
  const scope = ['namespaceId', 'ownerId', 'topicId']
  if (method === 'status') referenceExact(value, scope)
  else if (method === 'read') { referenceExact(value, [...scope, 'token', 'layer', 'offset']); referenceString(value.token); referenceInteger(value.offset); if (value.layer !== 'current' && value.layer !== 'saved') throw new TypeError('Invalid term layer') }
  else if (method === 'persist') { referenceExact(value, [...scope, 'token']); referenceString(value.token) }
  else if (method === 'migrateBegin') { referenceExact(value, [...scope, 'currentPoints', 'storedPoints']); referenceInteger(value.currentPoints, 1); if (value.storedPoints !== null) referenceInteger(value.storedPoints, 1) }
  else if (method.startsWith('migrate')) {
    referenceExact(value, [...scope, 'transferId', ...(method === 'migratePart' ? ['layer', 'offset', 'text'] : [])]); referenceString(value.transferId)
    if (method === 'migratePart') { referenceInteger(value.offset); referenceString(value.text, TERM_TRANSFER_POINTS, true); if (!value.text.length || value.layer !== 'current' && value.layer !== 'saved') throw new TypeError('Invalid term layer') }
  } else {
    referenceExact(value, [...scope, 'token', 'rememberHistory', 'command', 'evidence']); referenceString(value.token); parseTermCommand(value.command)
    if (typeof value.rememberHistory !== 'boolean' || !Array.isArray(value.evidence)) throw new TypeError('Invalid term mutation')
    const keys = new Set<string>()
    for (const item of value.evidence) {
      referenceObject(item); referenceExact(item, ['ref', 'status'])
      // The domain decoder is the existing evidence boundary, including legacy source refs.
      if (!decodeTopicTermPut({ id: 'validation', expectedEntryVersion: null, sourceLanguage: null, targetLanguage: 'validation', sourceForms: ['validation'], aliases: [], sense: '', preferred: 'validation', forbidden: [], evidence: [item.ref], origin: 'inferred', status: 'proposal' })) throw new TypeError('Invalid term evidence')
      const key = termEvidenceKey(parseTermScope(value), item.ref as TermEvidenceRef)
      if (keys.has(key) || !['ready', 'unloaded', 'missing'].includes(String(item.status))) throw new TypeError('Invalid term evidence state')
      keys.add(key)
    }
  }
  if (referenceBytes({ request: value }) > TERM_TRANSFER_BYTES) throw new RangeError('术语请求超过完整传输预算，未截断。')
  return structuredClone(value)
}
function head(value: unknown): void {
  if (value === null) return
  referenceObject(value); referenceExact(value, ['schemaVersion', 'ownerId', 'topicId', 'version', 'activeVersion', 'updatedAt', 'count'])
  referenceString(value.ownerId); referenceString(value.topicId); referenceInteger(value.version); referenceInteger(value.activeVersion); referenceInteger(value.count)
  if (![1, 2, 3].includes(Number(value.schemaVersion)) || Number(value.activeVersion) > Number(value.version) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new TypeError('Invalid term head')
}
export function parseTermStorageStatus(value: unknown): TermStorageStatus {
  referenceObject(value); referenceExact(value, ['switched', 'token', 'current', 'saved', 'persistence'], ['retired']); head(value.current); head(value.saved)
  if (value.retired !== undefined && value.retired !== true) throw new TypeError('Invalid term retirement')
  if (typeof value.switched !== 'boolean' || !['saved', 'runtime_only'].includes(String(value.persistence))) throw new TypeError('Invalid term status')
  if (value.token !== null) referenceString(value.token)
  if (value.switched ? value.token === null || value.current === null : value.token !== null || value.current !== null || value.saved !== null) throw new TypeError('Invalid term authority')
  return structuredClone(value) as unknown as TermStorageStatus
}
export function parseTermRemoteResult(method: Method, value: unknown): unknown {
  if (method === 'status' || method === 'persist' || method === 'migrateCommit') return parseTermStorageStatus(value)
  referenceObject(value)
  if (method === 'read') { referenceExact(value, ['text', 'nextOffset']); referenceString(value.text, TERM_TRANSFER_POINTS, true); if (!value.text.length) throw new TypeError('Empty term page'); if (value.nextOffset !== null) referenceInteger(value.nextOffset, 1) }
  else if (method === 'migrateBegin') { referenceExact(value, ['transferId']); referenceString(value.transferId) }
  else if (method === 'migratePart') { referenceExact(value, ['nextOffset']); referenceInteger(value.nextOffset, 1) }
  else if (method === 'migrateCancel') { referenceExact(value, ['cancelled']); if (value.cancelled !== true) throw new TypeError('Invalid term cancellation') }
  else if (method === 'persistNamespace') { referenceExact(value, ['persisted']); if (value.persisted !== true) throw new TypeError('Invalid term persistence') }
  else { referenceExact(value, ['status', 'token', 'entryId']); referenceString(value.token); if (value.entryId !== null) referenceString(value.entryId); if (!['updated', 'unchanged', 'stale', 'invalid', 'requires_user_action', 'conflict', 'save_failed'].includes(String(value.status))) throw new TypeError('Invalid term receipt') }
  if (referenceBytes({ ok: true, value }) > TERM_TRANSFER_BYTES) throw new RangeError('术语回包超过完整传输预算。')
  return structuredClone(value)
}
const methods: readonly Method[] = ['status', 'read', 'migrateBegin', 'migratePart', 'migrateCommit', 'migrateCancel', 'mutate', 'persist', 'persistNamespace']
export const TOPIC_TERMS_REMOTE = { package: 'dsh-translation-plugin', descriptors: methods.map(method => ({
  id: `dsh-translation-plugin#translationTerms/${method}`, service: 'translationTerms', namespace: 'translationTerms', method, invocation: { kind: 'direct' as const },
  parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#term-${method}-request`, create: () => ({ parse: (value: unknown) => parseTermRemoteRequest(method, value) }) } }],
  result: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#term-${method}-result`, create: () => ({ parse: (value: unknown) => parseTermRemoteResult(method, value) }) },
})) }
