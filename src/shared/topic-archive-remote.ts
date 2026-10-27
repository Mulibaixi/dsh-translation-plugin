import { decodeTopicArchivePut, decodeTopicArchiveUserInput, type TopicArchiveSnapshot, type TopicArchivePut, type TopicArchiveUserPut, type ArchiveMutationResult } from '../memory/topic-archive.js'
import { termEvidenceKey, type TermEvidenceRef, type FileProposalAcceptance } from '../memory/topic-terms.js'
import { referenceBytes, referenceExact, referenceInteger, referenceObject, referenceString } from './reference-memory.js'

export const ARCHIVE_TRANSFER_POINTS = 4000
export const ARCHIVE_TRANSFER_BYTES = 196608
export interface ArchiveRemoteScope { readonly namespaceId: string; readonly ownerId: string; readonly topicId: string }
export type ArchiveHead = Omit<TopicArchiveSnapshot, 'entries'> & { readonly count: number }
export interface ArchiveStorageStatus { readonly switched: boolean; readonly token: string | null; readonly current: ArchiveHead | null; readonly saved: ArchiveHead | null; readonly persistence: 'saved' | 'runtime_only'; readonly retired?: true }
export type ArchiveCommand = { readonly kind: 'put'; readonly input: TopicArchivePut }
  | { readonly kind: 'accept_file_proposal' | 'revise_file_proposal'; readonly input: TopicArchivePut; readonly acceptance: FileProposalAcceptance }
  | { readonly kind: 'user_put'; readonly input: TopicArchiveUserPut }
  | { readonly kind: 'adopt' | 'disable' | 'delete'; readonly id: string; readonly expectedEntryVersion: number }
  | { readonly kind: 'clear' | 'reconcile' }
export interface ArchiveEvidenceState { readonly ref: TermEvidenceRef; readonly status: 'ready' | 'unloaded' | 'missing' }
export interface ArchiveReadRequest extends ArchiveRemoteScope { readonly token: string; readonly layer: 'current' | 'saved'; readonly offset: number }
export interface ArchiveReadPage { readonly text: string; readonly nextOffset: number | null }
export interface ArchiveMutationRequest extends ArchiveRemoteScope { readonly token: string; readonly rememberHistory: boolean; readonly command: ArchiveCommand; readonly evidence: readonly ArchiveEvidenceState[] }
export interface ArchiveMutationReceipt { readonly status: ArchiveMutationResult['status']; readonly token: string; readonly entryId: string | null }
export interface ArchiveMigrateBegin extends ArchiveRemoteScope { readonly currentPoints: number; readonly storedPoints: number | null }
export interface ArchiveMigrateCommit extends ArchiveRemoteScope { readonly transferId: string }
export interface ArchiveMigratePart extends ArchiveMigrateCommit { readonly layer: 'current' | 'saved'; readonly offset: number; readonly text: string }
export interface ArchiveRemotePort {
  status(request: ArchiveRemoteScope): Promise<ArchiveStorageStatus>
  read(request: ArchiveReadRequest): Promise<ArchiveReadPage>
  migrateBegin(request: ArchiveMigrateBegin): Promise<{ readonly transferId: string }>
  migratePart(request: ArchiveMigratePart): Promise<{ readonly nextOffset: number }>
  migrateCommit(request: ArchiveMigrateCommit): Promise<ArchiveStorageStatus>
  migrateCancel(request: ArchiveMigrateCommit): Promise<{ readonly cancelled: true }>
  mutate(request: ArchiveMutationRequest): Promise<ArchiveMutationReceipt>
  persist(request: ArchiveRemoteScope & { readonly token: string }): Promise<ArchiveStorageStatus>
  persistNamespace(request: { readonly namespaceId: string }): Promise<{ readonly persisted: true }>
}
export function parseArchiveScope(value: unknown): ArchiveRemoteScope {
  referenceObject(value); referenceString(value.namespaceId); referenceString(value.ownerId); referenceString(value.topicId)
  return { namespaceId: value.namespaceId, ownerId: value.ownerId, topicId: value.topicId }
}
export function parseArchiveCommand(value: unknown): ArchiveCommand {
  referenceObject(value)
  if (value.kind === 'put' || value.kind === 'accept_file_proposal' || value.kind === 'revise_file_proposal') {
    referenceExact(value, ['kind', 'input'], value.kind === 'put' ? [] : ['acceptance'])
    if (!decodeTopicArchivePut(value.input)) throw new TypeError('Invalid archive input')
    if (value.kind !== 'put') {
      referenceObject(value.acceptance); referenceExact(value.acceptance, ['eventId', 'at', 'batchId', 'candidateId', 'edited'])
      for (const field of ['eventId', 'at', 'batchId', 'candidateId']) referenceString(value.acceptance[field])
      if (typeof value.acceptance.edited !== 'boolean' || !Number.isFinite(Date.parse(value.acceptance.at as string))) throw new TypeError('Invalid archive acceptance')
    }
  } else if (value.kind === 'user_put') { referenceExact(value, ['kind', 'input']); referenceObject(value.input); if (!decodeTopicArchiveUserInput(value.input) || value.input.id === null) throw new TypeError('Invalid user archive input') }
  else if (value.kind === 'adopt' || value.kind === 'disable' || value.kind === 'delete') { referenceExact(value, ['kind', 'id', 'expectedEntryVersion']); referenceString(value.id); referenceInteger(value.expectedEntryVersion, 1) }
  else if (value.kind === 'clear' || value.kind === 'reconcile') referenceExact(value, ['kind'])
  else throw new TypeError('Invalid archive command')
  return structuredClone(value) as unknown as ArchiveCommand
}
type Method = keyof ArchiveRemotePort
export function parseArchiveRemoteRequest(method: Method, value: unknown): unknown {
  referenceObject(value)
  if (method === 'persistNamespace') { referenceExact(value, ['namespaceId']); referenceString(value.namespaceId); return structuredClone(value) }
  parseArchiveScope(value)
  const scope = ['namespaceId', 'ownerId', 'topicId']
  if (method === 'status') referenceExact(value, scope)
  else if (method === 'read') { referenceExact(value, [...scope, 'token', 'layer', 'offset']); referenceString(value.token); referenceInteger(value.offset); if (value.layer !== 'current' && value.layer !== 'saved') throw new TypeError('Invalid archive layer') }
  else if (method === 'persist') { referenceExact(value, [...scope, 'token']); referenceString(value.token) }
  else if (method === 'migrateBegin') { referenceExact(value, [...scope, 'currentPoints', 'storedPoints']); referenceInteger(value.currentPoints, 1); if (value.storedPoints !== null) referenceInteger(value.storedPoints, 1) }
  else if (method.startsWith('migrate')) {
    referenceExact(value, [...scope, 'transferId', ...(method === 'migratePart' ? ['layer', 'offset', 'text'] : [])]); referenceString(value.transferId)
    if (method === 'migratePart') { referenceInteger(value.offset); referenceString(value.text, ARCHIVE_TRANSFER_POINTS, true); if (!value.text.length || value.layer !== 'current' && value.layer !== 'saved') throw new TypeError('Invalid archive layer') }
  } else {
    referenceExact(value, [...scope, 'token', 'rememberHistory', 'command', 'evidence']); referenceString(value.token); parseArchiveCommand(value.command)
    if (typeof value.rememberHistory !== 'boolean' || !Array.isArray(value.evidence)) throw new TypeError('Invalid archive mutation')
    const keys = new Set<string>()
    for (const item of value.evidence) {
      referenceObject(item); referenceExact(item, ['ref', 'status'])
      // The domain decoder is the existing evidence boundary, including legacy source refs.
      if (!decodeTopicArchivePut({ kind: 'fact', id: 'validation', expectedEntryVersion: null, title: 'validation', body: 'validation', entityIds: [], evidence: [item.ref], origin: 'inferred', status: 'proposal' })) throw new TypeError('Invalid archive evidence')
      const key = termEvidenceKey(parseArchiveScope(value), item.ref as TermEvidenceRef)
      if (keys.has(key) || !['ready', 'unloaded', 'missing'].includes(String(item.status))) throw new TypeError('Invalid archive evidence state')
      keys.add(key)
    }
  }
  if (referenceBytes({ request: value }) > ARCHIVE_TRANSFER_BYTES) throw new RangeError('档案请求超过完整传输预算，未截断。')
  return structuredClone(value)
}
function head(value: unknown): void {
  if (value === null) return
  referenceObject(value); referenceExact(value, ['schemaVersion', 'ownerId', 'topicId', 'version', 'activeVersion', 'updatedAt', 'count'])
  referenceString(value.ownerId); referenceString(value.topicId); referenceInteger(value.version); referenceInteger(value.activeVersion); referenceInteger(value.count)
  if (![1, 2, 3].includes(Number(value.schemaVersion)) || Number(value.activeVersion) > Number(value.version) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) throw new TypeError('Invalid archive head')
}
export function parseArchiveStorageStatus(value: unknown): ArchiveStorageStatus {
  referenceObject(value); referenceExact(value, ['switched', 'token', 'current', 'saved', 'persistence'], ['retired']); head(value.current); head(value.saved)
  if (value.retired !== undefined && value.retired !== true) throw new TypeError('Invalid archive retirement')
  if (typeof value.switched !== 'boolean' || !['saved', 'runtime_only'].includes(String(value.persistence))) throw new TypeError('Invalid archive status')
  if (value.token !== null) referenceString(value.token)
  if (value.switched ? value.token === null || value.current === null : value.token !== null || value.current !== null || value.saved !== null) throw new TypeError('Invalid archive authority')
  return structuredClone(value) as unknown as ArchiveStorageStatus
}
export function parseArchiveRemoteResult(method: Method, value: unknown): unknown {
  if (method === 'status' || method === 'persist' || method === 'migrateCommit') return parseArchiveStorageStatus(value)
  referenceObject(value)
  if (method === 'read') { referenceExact(value, ['text', 'nextOffset']); referenceString(value.text, ARCHIVE_TRANSFER_POINTS, true); if (!value.text.length) throw new TypeError('Empty archive page'); if (value.nextOffset !== null) referenceInteger(value.nextOffset, 1) }
  else if (method === 'migrateBegin') { referenceExact(value, ['transferId']); referenceString(value.transferId) }
  else if (method === 'migratePart') { referenceExact(value, ['nextOffset']); referenceInteger(value.nextOffset, 1) }
  else if (method === 'migrateCancel') { referenceExact(value, ['cancelled']); if (value.cancelled !== true) throw new TypeError('Invalid archive cancellation') }
  else if (method === 'persistNamespace') { referenceExact(value, ['persisted']); if (value.persisted !== true) throw new TypeError('Invalid archive persistence') }
  else { referenceExact(value, ['status', 'token', 'entryId']); referenceString(value.token); if (value.entryId !== null) referenceString(value.entryId); if (!['updated', 'unchanged', 'stale', 'invalid', 'requires_user_action', 'save_failed'].includes(String(value.status))) throw new TypeError('Invalid archive receipt') }
  if (referenceBytes({ ok: true, value }) > ARCHIVE_TRANSFER_BYTES) throw new RangeError('档案回包超过完整传输预算。')
  return structuredClone(value)
}
const methods: readonly Method[] = ['status', 'read', 'migrateBegin', 'migratePart', 'migrateCommit', 'migrateCancel', 'mutate', 'persist', 'persistNamespace']
export const TOPIC_ARCHIVE_REMOTE = { package: 'dsh-translation-plugin', descriptors: methods.map(method => ({
  id: `dsh-translation-plugin#translationArchive/${method}`, service: 'translationArchive', namespace: 'translationArchive', method, invocation: { kind: 'direct' as const },
  parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#archive-${method}-request`, create: () => ({ parse: (value: unknown) => parseArchiveRemoteRequest(method, value) }) } }],
  result: { mode: 'strict' as const, typeSymbol: `dsh-translation-plugin#archive-${method}-result`, create: () => ({ parse: (value: unknown) => parseArchiveRemoteResult(method, value) }) },
})) }
