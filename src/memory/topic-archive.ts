import { resolveTermEvidence, fileProposalAcceptance, type FileProposalAcceptance, type TermEvidenceRef, type TermEvidenceResolver, type TermUserAdoption } from './topic-terms.js'

export type TopicArchiveKind = 'entity' | 'fact' | 'relation'
export type TopicArchiveStatus = 'proposal' | 'active' | 'review_required' | 'disabled'
export type TopicArchiveOrigin = 'inferred' | 'source_checked' | 'user_explicit'
export interface TopicEntityContent { readonly kind: 'entity'; readonly name: string; readonly aliases: readonly string[]; readonly description: string }
export interface TopicFactContent { readonly kind: 'fact'; readonly title: string; readonly body: string; readonly entityIds: readonly string[] }
export interface TopicRelationContent { readonly kind: 'relation'; readonly sourceEntityId: string; readonly relation: string; readonly targetEntityId: string; readonly description: string }
export type TopicArchiveSemantic = TopicEntityContent | TopicFactContent | TopicRelationContent
export type TopicArchiveContent = TopicArchiveSemantic & { readonly evidence: readonly TermEvidenceRef[] }
export type TopicArchiveEntry = TopicArchiveContent & {
  readonly id: string; readonly version: number; readonly status: TopicArchiveStatus; readonly origin: TopicArchiveOrigin
  readonly confirmation: TermUserAdoption | null; readonly createdAt: string; readonly updatedAt: string
  readonly acceptance?: FileProposalAcceptance
}
export interface TopicArchiveSnapshot {
  readonly schemaVersion: 1 | 2 | 3; readonly ownerId: string; readonly topicId: string; readonly version: number
  readonly activeVersion: number; readonly updatedAt: string; readonly entries: readonly TopicArchiveEntry[]
}
export type TopicArchivePut = TopicArchiveContent & {
  readonly id: string; readonly expectedEntryVersion: number | null; readonly origin: 'inferred' | 'source_checked'; readonly status: 'proposal' | 'active'
}
export type TopicArchiveUserInput = TopicArchiveSemantic & { readonly id: string | null; readonly expectedEntryVersion: number | null }
export type TopicArchiveUserPut = TopicArchiveSemantic & { readonly id: string; readonly expectedEntryVersion: number | null }
export interface ArchiveMutationResult {
  readonly status: 'updated' | 'unchanged' | 'stale' | 'invalid' | 'requires_user_action' | 'save_failed'
  readonly snapshot: TopicArchiveSnapshot; readonly entry: TopicArchiveEntry | null
}
export interface TopicArchiveQuery {
  readonly ownerId: string; readonly topicId: string; readonly mode: 'quick' | 'normal'
  readonly kinds: readonly TopicArchiveKind[]; readonly forms: readonly string[]
}

type Data = Record<string, unknown>
const statuses: readonly TopicArchiveStatus[] = ['proposal', 'active', 'review_required', 'disabled']
function record(value: unknown): value is Data { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function exact(value: Data, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function text(value: unknown, maximum: number, required = true): value is string { return typeof value === 'string' && (!required || !!value.trim()) && Array.from(value).length <= maximum }
function integer(value: unknown, minimum = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum }
function time(value: unknown): value is string { return text(value, 40) && Number.isFinite(Date.parse(value)) }
function strings(value: unknown, maximum: number): value is readonly string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(item => text(item, maximum)) && new Set(value).size === value.length
}
function evidence(value: unknown): value is TermEvidenceRef {
  if (!record(value) || !(exact(value, ['kind', 'sessionId', 'unitId', 'revisionId', 'selectionEventId', 'range', 'role']) ||
      (value.kind === 'source' && exact(value, ['kind', 'sessionId', 'unitId', 'sourceVersion', 'revisionId', 'selectionEventId', 'range', 'role']))) ||
    !text(value.sessionId, 2048) || !text(value.unitId, 2048) || !['basis', 'example'].includes(value.role as string)) return false
  if (value.kind === 'source' ? value.revisionId !== null || value.selectionEventId !== null ||
      (Object.hasOwn(value, 'sourceVersion') && !integer(value.sourceVersion, 1)) :
    value.kind !== 'final' || !text(value.revisionId, 2048) || !text(value.selectionEventId, 2048)) return false
  return value.range === null || (record(value.range) && exact(value.range, ['start', 'end']) && integer(value.range.start) && integer(value.range.end, 1) && value.range.end > value.range.start)
}
function semantic(value: unknown): value is TopicArchiveSemantic {
  if (!record(value)) return false
  return value.kind === 'entity' ? text(value.name, 500) && strings(value.aliases, 500) && text(value.description, 8000, false) :
    value.kind === 'fact' ? text(value.title, 500) && text(value.body, 16000) && strings(value.entityIds, 2048) :
    value.kind === 'relation' && text(value.sourceEntityId, 2048) && text(value.relation, 500) && text(value.targetEntityId, 2048) && text(value.description, 8000, false)
}
function semanticKeys(kind: unknown): readonly string[] {
  return kind === 'entity' ? ['kind', 'name', 'aliases', 'description'] : kind === 'fact' ? ['kind', 'title', 'body', 'entityIds'] : ['kind', 'sourceEntityId', 'relation', 'targetEntityId', 'description']
}
function content(value: unknown): value is TopicArchiveContent {
  return semantic(value) && record(value) && Array.isArray(value.evidence) && value.evidence.length <= 100 && value.evidence.every(evidence)
}
function copySemantic(value: TopicArchiveSemantic): TopicArchiveSemantic {
  return value.kind === 'entity' ? { kind: value.kind, name: value.name, aliases: [...value.aliases], description: value.description } :
    value.kind === 'fact' ? { kind: value.kind, title: value.title, body: value.body, entityIds: [...value.entityIds] } :
      { kind: value.kind, sourceEntityId: value.sourceEntityId, relation: value.relation, targetEntityId: value.targetEntityId, description: value.description }
}
function copyContent(value: TopicArchiveContent): TopicArchiveContent { return { ...copySemantic(value), evidence: value.evidence.map(ref => ({ ...ref, range: ref.range ? { ...ref.range } : null })) } }
function sourceBasis(value: TopicArchiveContent): boolean { return value.evidence.some(ref => ref.kind === 'source' && ref.role === 'basis') }
function adoption(value: unknown): value is TermUserAdoption {
  return record(value) && exact(value, ['eventId', 'at', 'adoptedEntryVersion', ...(Object.hasOwn(value, 'edited') ? ['edited'] : [])]) &&
    (value.edited === undefined || typeof value.edited === 'boolean') && text(value.eventId, 2048) && time(value.at) && integer(value.adoptedEntryVersion, 1)
}

/** Storage/RPC parsing is kept at the boundary; internal mutations use trusted domain values. */
export function decodeTopicArchivePut(value: unknown): TopicArchivePut | undefined {
  if (!record(value) || !exact(value, [...semanticKeys(value.kind), 'evidence', 'id', 'expectedEntryVersion', 'origin', 'status']) || !content(value) ||
    !text(value.id, 2048) || !(value.expectedEntryVersion === null || integer(value.expectedEntryVersion, 1)) ||
    !['inferred', 'source_checked'].includes(value.origin as string) || !['proposal', 'active'].includes(value.status as string) ||
    (value.status === 'active' && (!['source_checked'].includes(String(value.origin)) || !sourceBasis(value)))) return undefined
  return { ...copyContent(value), id: value.id, expectedEntryVersion: value.expectedEntryVersion, origin: value.origin as TopicArchivePut['origin'], status: value.status as TopicArchivePut['status'] }
}
export function decodeTopicArchiveUserInput(value: unknown): TopicArchiveUserInput | undefined {
  if (!record(value) || !exact(value, [...semanticKeys(value.kind), 'id', 'expectedEntryVersion']) || !semantic(value) ||
    !(value.id === null || text(value.id, 2048)) || !(value.expectedEntryVersion === null || integer(value.expectedEntryVersion, 1)) ||
    (value.id === null && value.expectedEntryVersion !== null)) return undefined
  return { ...copySemantic(value), id: value.id, expectedEntryVersion: value.expectedEntryVersion }
}
function decodeSnapshot(value: unknown, projection: boolean): TopicArchiveSnapshot | undefined {
  if (!record(value) || !exact(value, ['schemaVersion', 'ownerId', 'topicId', 'version', 'activeVersion', 'updatedAt', 'entries']) || ![1, 2, 3].includes(value.schemaVersion as number) ||
    !text(value.ownerId, 2048) || !text(value.topicId, 2048) || !integer(value.version) || !integer(value.activeVersion) || value.activeVersion > value.version || !time(value.updatedAt) || !Array.isArray(value.entries)) return undefined
  const entries: TopicArchiveEntry[] = [], ids = new Set<string>()
  for (const raw of value.entries) {
    if (!record(raw) || !exact(raw, [...semanticKeys(raw.kind), 'evidence', 'id', 'version', 'status', 'origin', 'confirmation', 'createdAt', 'updatedAt', ...(Object.hasOwn(raw, 'acceptance') ? ['acceptance'] : [])]) ||
      !content(raw) || !text(raw.id, 2048) || ids.has(raw.id) || !integer(raw.version, 1) || raw.version > value.version || !time(raw.createdAt) || !time(raw.updatedAt) ||
      !statuses.includes(raw.status as TopicArchiveStatus) || !['inferred', 'source_checked', 'user_explicit'].includes(raw.origin as string)) return undefined
    if (raw.origin === 'user_explicit' ? (!adoption(raw.confirmation) || raw.confirmation.adoptedEntryVersion >= raw.version || raw.evidence.some(ref => ref.role === 'basis')) : raw.confirmation !== null) return undefined
    if (raw.acceptance !== undefined && (value.schemaVersion !== 3 || raw.origin === 'user_explicit' || !fileProposalAcceptance(raw.acceptance))) return undefined
    if (raw.status === 'active' && ((raw.origin === 'inferred' && !raw.acceptance) || (raw.origin !== 'user_explicit' && !sourceBasis(raw)))) return undefined
    ids.add(raw.id); entries.push(structuredClone(raw) as unknown as TopicArchiveEntry)
  }
  // Deleted references remain visible only as explicitly unavailable review/disabled entries.
  if (projection ? entries.some(entry => entry.status !== 'active') : entries.some(entry => entry.status !== 'review_required' && entry.status !== 'disabled' && referencedEntityIds(entry).some(id => !entries.some(candidate => candidate.id === id && candidate.kind === 'entity')))) return undefined
  return { schemaVersion: value.schemaVersion as 1 | 2 | 3, ownerId: value.ownerId, topicId: value.topicId, version: value.version, activeVersion: value.activeVersion, updatedAt: value.updatedAt, entries }
}
export function decodeTopicArchiveSnapshot(value: unknown): TopicArchiveSnapshot | undefined { return decodeSnapshot(value, false) }
/** Query entries are active projections; entity IDs may refer to omitted matching context. */
export function decodeTopicArchiveQuerySnapshot(value: unknown): TopicArchiveSnapshot | undefined { return decodeSnapshot(value, true) }
export function emptyTopicArchive(ownerId: string, topicId: string, at: string): TopicArchiveSnapshot {
  if (!text(ownerId, 2048) || !text(topicId, 2048) || !time(at)) throw new Error('Invalid topic archive identity or time')
  return { schemaVersion: 1, ownerId, topicId, version: 0, activeVersion: 0, updatedAt: at, entries: [] }
}
export function referencedEntityIds(value: TopicArchiveSemantic): readonly string[] {
  return value.kind === 'entity' ? [] : value.kind === 'fact' ? value.entityIds : [...new Set([value.sourceEntityId, value.targetEntityId])]
}
function validBasis(snapshot: TopicArchiveSnapshot, entry: TopicArchiveContent, resolver: TermEvidenceResolver, isUnloaded: (ref: TermEvidenceRef) => boolean = () => false): boolean {
  return sourceBasis(entry) && entry.evidence.filter(ref => ref.role === 'basis').every(ref => resolveTermEvidence(snapshot, ref, resolver) !== undefined || isUnloaded(ref))
}
function effectiveOwn(snapshot: TopicArchiveSnapshot, entry: TopicArchiveEntry, resolver: TermEvidenceResolver, isUnloaded: (ref: TermEvidenceRef) => boolean = () => false): boolean {
  return entry.status === 'active' && (entry.origin === 'user_explicit' || ((!!entry.acceptance || ['source_checked'].includes(entry.origin)) && validBasis(snapshot, entry, resolver, isUnloaded)))
}
function validReferences(snapshot: TopicArchiveSnapshot, value: TopicArchiveSemantic, resolver: TermEvidenceResolver, active: boolean, isUnloaded: (ref: TermEvidenceRef) => boolean = () => false): boolean {
  return referencedEntityIds(value).every(id => {
    const entity = snapshot.entries.find(entry => entry.id === id)
    return entity?.kind === 'entity' && (!active || effectiveOwn(snapshot, entity, resolver, isUnloaded))
  })
}
function effective(snapshot: TopicArchiveSnapshot, entry: TopicArchiveEntry, resolver: TermEvidenceResolver): boolean { return effectiveOwn(snapshot, entry, resolver) && validReferences(snapshot, entry, resolver, true) }
function activeProjection(entry: TopicArchiveEntry | undefined): unknown {
  return entry?.status === 'active' ? { id: entry.id, ...copySemantic(entry), origin: entry.origin, basis: entry.evidence.filter(ref => ref.role === 'basis') } : null
}
function replace(snapshot: TopicArchiveSnapshot, entry: TopicArchiveEntry, at: string): TopicArchiveSnapshot {
  const old = snapshot.entries.find(item => item.id === entry.id), activeChanged = JSON.stringify(activeProjection(old)) !== JSON.stringify(activeProjection(entry))
  return { ...snapshot, schemaVersion: entry.acceptance || snapshot.schemaVersion === 3 ? 3 as const : 2 as const, version: snapshot.version + 1, activeVersion: snapshot.activeVersion + (activeChanged ? 1 : 0), updatedAt: at,
    entries: old ? snapshot.entries.map(item => item.id === entry.id ? entry : item) : [...snapshot.entries, entry] }
}
function reviewDependents(snapshot: TopicArchiveSnapshot, entityId: string, at: string): TopicArchiveSnapshot {
  let next = snapshot
  for (const entry of snapshot.entries) if (entry.status !== 'disabled' && entry.status !== 'review_required' && referencedEntityIds(entry).includes(entityId)) {
    next = replace(next, { ...entry, status: 'review_required', version: entry.version + 1, updatedAt: at }, at)
  }
  return next
}
function replaceAndReview(snapshot: TopicArchiveSnapshot, entry: TopicArchiveEntry, at: string): TopicArchiveSnapshot {
  const old = snapshot.entries.find(item => item.id === entry.id), next = replace(snapshot, entry, at)
  return old?.kind === 'entity' && (JSON.stringify(copySemantic(old)) !== JSON.stringify(copySemantic(entry)) || (old.status === 'active' && entry.status !== 'active')) ? reviewDependents(next, entry.id, at) : next
}
function result(snapshot: TopicArchiveSnapshot, status: ArchiveMutationResult['status'], entry: TopicArchiveEntry | null): ArchiveMutationResult { return { status, snapshot, entry } }

/** Model edits are allowed; changed content must be reviewed again without inherited adoption. */
export function putTopicArchive(snapshot: TopicArchiveSnapshot, input: TopicArchivePut, resolver: TermEvidenceResolver, at: string): ArchiveMutationResult {
  const old = snapshot.entries.find(entry => entry.id === input.id) ?? null
  if ((old?.version ?? null) !== input.expectedEntryVersion) return result(snapshot, 'stale', old)
  if (old && time(at) && content(input) && JSON.stringify(copyContent(old)) === JSON.stringify(copyContent(input))) return result(snapshot, 'unchanged', old)
  if (old) input = { ...input, status: 'proposal' }
  if (!text(input.id, 2048) || !time(at) || !content(input) || (old && old.kind !== input.kind) || !['inferred', 'source_checked'].includes(input.origin) ||
    !['proposal', 'active'].includes(input.status) || (input.status === 'active' && (input.origin !== 'source_checked' || !validBasis(snapshot, input, resolver))) ||
    !validReferences(snapshot, input, resolver, input.status === 'active')) return result(snapshot, 'invalid', old)
  const entry: TopicArchiveEntry = { ...copyContent(input), id: input.id, version: (old?.version ?? 0) + 1, status: input.status, origin: input.origin,
    confirmation: null, createdAt: old?.createdAt ?? at, updatedAt: at }
  if (old && old.origin === entry.origin && old.status === entry.status && JSON.stringify(copyContent(old)) === JSON.stringify(copyContent(entry))) return result(snapshot, 'unchanged', old)
  return result(replaceAndReview(snapshot, entry, at), 'updated', entry)
}
export function putUserTopicArchive(snapshot: TopicArchiveSnapshot, input: TopicArchiveUserPut, resolver: TermEvidenceResolver, action: { readonly eventId: string; readonly at: string }): ArchiveMutationResult {
  const old = snapshot.entries.find(entry => entry.id === input.id) ?? null
  if ((old?.version ?? null) !== input.expectedEntryVersion) return result(snapshot, 'stale', old)
  if (!text(input.id, 2048) || !semantic(input) || (old && old.kind !== input.kind) || !text(action.eventId, 2048) || !time(action.at) || !validReferences(snapshot, input, resolver, true)) return result(snapshot, 'invalid', old)
  const fields: TopicArchiveContent = { ...copySemantic(input), evidence: old?.evidence.map(ref => ({ ...ref, range: ref.range ? { ...ref.range } : null, role: 'example' as const })) ?? [] }
  if (old?.origin === 'user_explicit' && old.status === 'active' && JSON.stringify(copyContent(old)) === JSON.stringify(fields)) return result(snapshot, 'unchanged', old)
  if (!old) {
    const candidate = putTopicArchive(snapshot, { ...fields, id: input.id, expectedEntryVersion: null, origin: 'inferred', status: 'proposal' }, resolver, action.at)
    return candidate.entry ? adoptTopicArchive(candidate.snapshot, input.id, candidate.entry.version, resolver, { ...action, edited: true }) : candidate
  }
  const entry: TopicArchiveEntry = { ...fields, id: old.id, createdAt: old.createdAt, updatedAt: action.at, version: old.version + 1,
    origin: 'user_explicit', status: 'active', confirmation: { ...action, adoptedEntryVersion: old.version, edited: true } }
  return result(replaceAndReview(snapshot, entry, action.at), 'updated', entry)
}
export function adoptTopicArchive(snapshot: TopicArchiveSnapshot, id: string, expectedEntryVersion: number, resolver: TermEvidenceResolver, action: { readonly eventId: string; readonly at: string; readonly edited?: boolean }): ArchiveMutationResult {
  const old = snapshot.entries.find(entry => entry.id === id) ?? null
  if (!old || old.version !== expectedEntryVersion) return result(snapshot, 'stale', old)
  if (!text(action.eventId, 2048) || !time(action.at) || !validReferences(snapshot, old, resolver, true)) return result(snapshot, 'invalid', old)
  if (old.origin === 'user_explicit' && old.status === 'active') return result(snapshot, 'unchanged', old)
  const { acceptance: _acceptance, ...previous } = old
  const entry: TopicArchiveEntry = { ...previous, origin: 'user_explicit', status: 'active', version: old.version + 1, updatedAt: action.at,
    evidence: old.evidence.map(ref => ({ ...ref, role: 'example' })), confirmation: { ...action, adoptedEntryVersion: old.version, edited: action.edited ?? old.acceptance?.edited ?? false } }
  return result(replace(snapshot, entry, action.at), 'updated', entry)
}
/** User confirmation preserves model attribution and source basis, including inferred statements. */
export function acceptTopicArchiveProposal(snapshot: TopicArchiveSnapshot, input: TopicArchivePut, resolver: TermEvidenceResolver, action: FileProposalAcceptance, revision = false): ArchiveMutationResult {
  const old = snapshot.entries.find(entry => entry.id === input.id) ?? null
  if (old?.acceptance?.candidateId === action.candidateId && old.acceptance.batchId === action.batchId && old.status === 'active' &&
    old.origin === input.origin && JSON.stringify(copyContent(old)) === JSON.stringify(copyContent(input))) return result(snapshot, 'unchanged', old)
  if ((old?.version ?? null) !== input.expectedEntryVersion) return result(snapshot, 'stale', old)
  if (revision ? !old : old?.origin === 'user_explicit' || old?.acceptance) return result(snapshot, 'requires_user_action', old)
  if ((old && old.kind !== input.kind) || !decodeTopicArchivePut({ ...input, status: 'proposal' }) || !fileProposalAcceptance(action) || !validBasis(snapshot, input, resolver) ||
    !validReferences(snapshot, input, resolver, true)) return result(snapshot, 'invalid', old)
  if (old?.origin === 'user_explicit') {
    const entry: TopicArchiveEntry = { ...copyContent(input), evidence: input.evidence.map(ref => ({ ...ref, role: 'example' })), id: old.id,
      origin: 'user_explicit', status: 'active', confirmation: { eventId: action.eventId, at: action.at, adoptedEntryVersion: old.version, edited: old.confirmation?.edited !== false || action.edited },
      version: old.version + 1, createdAt: old.createdAt, updatedAt: action.at }
    return result(replaceAndReview(snapshot, entry, action.at), 'updated', entry)
  }
  const entry: TopicArchiveEntry = { ...copyContent(input), id: input.id, origin: input.origin, status: 'active', confirmation: null,
    acceptance: { ...action, edited: action.edited || !!old?.acceptance?.edited }, version: (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? action.at, updatedAt: action.at }
  return result(replaceAndReview(snapshot, entry, action.at), 'updated', entry)
}
export function disableTopicArchive(snapshot: TopicArchiveSnapshot, id: string, expectedEntryVersion: number, at: string): ArchiveMutationResult {
  const old = snapshot.entries.find(entry => entry.id === id) ?? null
  if (!old || old.version !== expectedEntryVersion) return result(snapshot, 'stale', old)
  if (!time(at)) return result(snapshot, 'invalid', old)
  if (old.status === 'disabled') return result(snapshot, 'unchanged', old)
  const entry: TopicArchiveEntry = { ...old, status: 'disabled', version: old.version + 1, updatedAt: at }
  return result(replaceAndReview(snapshot, entry, at), 'updated', entry)
}
export function deleteTopicArchiveEntry(snapshot: TopicArchiveSnapshot, id: string, expectedEntryVersion: number, at: string): ArchiveMutationResult {
  const old = snapshot.entries.find(entry => entry.id === id) ?? null
  if (!old || old.version !== expectedEntryVersion) return result(snapshot, 'stale', old)
  if (!time(at)) return result(snapshot, 'invalid', old)
  const next: TopicArchiveSnapshot = { ...snapshot, version: snapshot.version + 1, activeVersion: snapshot.activeVersion + (old.status === 'active' ? 1 : 0), updatedAt: at, entries: snapshot.entries.filter(entry => entry.id !== id) }
  return result(old.kind === 'entity' ? reviewDependents(next, id, at) : next, 'updated', null)
}
/** A changed final basis never silently revives. User examples do not govern independent adoption. */
export function reconcileTopicArchive(snapshot: TopicArchiveSnapshot, resolver: TermEvidenceResolver, at: string,
  isUnloaded: (ref: TermEvidenceRef) => boolean = () => false): TopicArchiveSnapshot {
  if (!time(at)) throw new Error('Invalid topic archive reconciliation time')
  let next = snapshot
  for (const original of snapshot.entries) {
    const entry = next.entries.find(entry => entry.id === original.id)!
    if (entry.status === 'disabled' || entry.status === 'review_required' || entry.origin === 'user_explicit') continue
    if (entry.evidence.some(ref => ref.role === 'basis' && resolveTermEvidence(snapshot, ref, resolver) === undefined && !isUnloaded(ref)) || (entry.status === 'active' && !sourceBasis(entry))) {
      next = replaceAndReview(next, { ...entry, status: 'review_required', version: entry.version + 1, updatedAt: at }, at)
    }
  }
  for (const entry of next.entries) if (entry.status !== 'disabled' && entry.status !== 'review_required' &&
    !validReferences(next, entry, resolver, entry.status === 'active', isUnloaded)) next = replace(next, { ...entry, status: 'review_required', version: entry.version + 1, updatedAt: at }, at)
  return next
}
/** Normal retrieval matches caller-supplied exact labels; Quick never reads archives. */
export function queryTopicArchive(snapshot: TopicArchiveSnapshot, query: TopicArchiveQuery, resolver: TermEvidenceResolver): readonly TopicArchiveEntry[] {
  if (query.mode !== 'normal' || query.ownerId !== snapshot.ownerId || query.topicId !== snapshot.topicId) return []
  return snapshot.entries.filter(entry => {
    if (!query.kinds.includes(entry.kind) || !effective(snapshot, entry, resolver)) return false
    const labels = entry.kind === 'entity' ? [entry.name, ...entry.aliases] : entry.kind === 'fact' ? [entry.title] : [entry.relation]
    for (const id of referencedEntityIds(entry)) {
      const entity = snapshot.entries.find(item => item.id === id)
      if (entity?.kind === 'entity') labels.push(entity.name, ...entity.aliases)
    }
    return labels.some(label => query.forms.includes(label))
  })
}
