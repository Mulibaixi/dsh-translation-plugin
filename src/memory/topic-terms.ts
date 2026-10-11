/** Topic terminology contains references, never a second copy of source/final bodies. */
export type TopicTermStatus = 'proposal' | 'active' | 'conflict' | 'review_required' | 'disabled'
export type TopicTermOrigin = 'inferred' | 'source_checked' | 'user_explicit'
export interface TermEvidenceRef {
  readonly kind: 'source' | 'final'
  readonly sessionId: string
  readonly unitId: string
  /** Source refs only. Missing legacy values identify source version 1. */
  readonly sourceVersion?: number
  readonly revisionId: string | null
  readonly selectionEventId: string | null
  /** Half-open Unicode code point offsets; null selects the whole body. */
  readonly range: { readonly start: number; readonly end: number } | null
  readonly role: 'basis' | 'example'
}
export interface TermUserAdoption {
  readonly eventId: string
  readonly at: string
  readonly adoptedEntryVersion: number
}
export interface TopicTermContent {
  readonly sourceLanguage: string | null
  readonly targetLanguage: string
  readonly sourceForms: readonly string[]
  readonly aliases: readonly string[]
  readonly sense: string
  readonly preferred: string
  readonly forbidden: readonly string[]
  readonly evidence: readonly TermEvidenceRef[]
}
export interface TopicTerm extends TopicTermContent {
  readonly id: string
  readonly version: number
  readonly status: TopicTermStatus
  readonly origin: TopicTermOrigin
  readonly confirmation: TermUserAdoption | null
  readonly createdAt: string
  readonly updatedAt: string
}
export interface TopicTermSnapshot {
  readonly schemaVersion: 1
  readonly ownerId: string
  readonly topicId: string
  readonly version: number
  readonly activeVersion: number
  readonly updatedAt: string
  readonly entries: readonly TopicTerm[]
}
/** Caller resolves the authoritative browser unit, including its latest final.selected event. */
export interface TermEvidenceFact {
  readonly ownerId: string
  readonly topicId: string
  /** Version of the current source body returned by the authoritative unit. */
  readonly sourceVersion: number
  readonly source: string
  readonly final: { readonly revisionId: string; readonly selectionEventId: string; readonly sourceVersion: number; readonly text: string } | null
}
/** Pure access to previously resolved facts. resolveRef returns exactly the requested range, never a partial whole body. */
export type TermEvidenceResolver = ((sessionId: string, unitId: string) => TermEvidenceFact | undefined) & {
  readonly resolveRef?: (scope: Pick<TopicTermSnapshot, 'ownerId' | 'topicId'>, ref: TermEvidenceRef) => string | undefined
  /** Deferred facts may preserve a potential conflict; they never make a query or new basis ready. */
  readonly isUnloaded?: (scope: Pick<TopicTermSnapshot, 'ownerId' | 'topicId'>, ref: TermEvidenceRef) => boolean
}
/** Includes scope and every evidence identity field; legacy source refs explicitly identify version 1. */
export function termEvidenceKey(scope: Pick<TopicTermSnapshot, 'ownerId' | 'topicId'>, ref: TermEvidenceRef): string {
  return JSON.stringify([scope.ownerId, scope.topicId, ref.sessionId, ref.unitId, ref.kind,
    ref.kind === 'source' ? ref.sourceVersion ?? 1 : null, ref.revisionId, ref.selectionEventId,
    ref.range?.start ?? null, ref.range?.end ?? null])
}
export interface TopicTermPut extends TopicTermContent {
  readonly id: string
  readonly expectedEntryVersion: number | null
  readonly origin: 'inferred' | 'source_checked'
  readonly status: 'proposal' | 'active'
}
/** An explicit Client form edits semantic fields; existing evidence is retained as examples. */
export interface TopicTermUserInput extends Omit<TopicTermContent, 'evidence'> {
  readonly id: string | null
  readonly expectedEntryVersion: number | null
}
export interface TopicTermUserPut extends TopicTermUserInput { readonly id: string }
export interface TermMutationResult {
  readonly status: 'updated' | 'unchanged' | 'stale' | 'invalid' | 'requires_user_action' | 'conflict'
  readonly snapshot: TopicTermSnapshot
  readonly entry: TopicTerm | null
}
export interface TopicTermQuery {
  readonly mode: 'quick' | 'normal'
  readonly ownerId: string
  readonly topicId: string
  readonly sourceLanguage: string | null
  readonly targetLanguage: string
  /** Explicit terms extracted by the caller, not arbitrary substrings of a full source. */
  readonly forms: readonly string[]
}

type Data = Record<string, unknown>
const statuses: readonly TopicTermStatus[] = ['proposal', 'active', 'conflict', 'review_required', 'disabled']
function record(value: unknown): value is Data { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function exact(value: Data, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function text(value: unknown, maximum: number, required = true): value is string { return typeof value === 'string' && (!required || !!value.trim()) && Array.from(value).length <= maximum }
function integer(value: unknown, minimum = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum }
function time(value: unknown): value is string { return text(value, 40) && Number.isFinite(Date.parse(value)) }
function strings(value: unknown, maximum: number, required = false): value is readonly string[] {
  return Array.isArray(value) && value.length <= 100 && (!required || value.length > 0) && value.every(item => text(item, maximum)) && new Set(value).size === value.length
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
function content(value: TopicTermContent): boolean {
  return (value.sourceLanguage === null || text(value.sourceLanguage, 80)) && text(value.targetLanguage, 80) &&
    strings(value.sourceForms, 500, true) && strings(value.aliases, 500) && text(value.sense, 4000, false) && text(value.preferred, 4000) &&
    strings(value.forbidden, 4000) && !value.forbidden.includes(value.preferred) && Array.isArray(value.evidence) && value.evidence.length <= 100 && value.evidence.every(evidence)
}
function hasSourceBasis(entry: TopicTermContent): boolean { return entry.evidence.some(ref => ref.kind === 'source' && ref.role === 'basis') }
function adoption(value: unknown): value is TermUserAdoption {
  return record(value) && exact(value, ['eventId', 'at', 'adoptedEntryVersion']) && text(value.eventId, 2048) && time(value.at) && integer(value.adoptedEntryVersion, 1)
}

export function decodeTopicTermPut(value: unknown): TopicTermPut | undefined {
  if (!record(value) || !exact(value, ['id', 'expectedEntryVersion', 'sourceLanguage', 'targetLanguage', 'sourceForms', 'aliases', 'sense', 'preferred', 'forbidden', 'evidence', 'origin', 'status']) ||
    !text(value.id, 2048) || !(value.expectedEntryVersion === null || integer(value.expectedEntryVersion, 1)) || !content(value as unknown as TopicTermContent) ||
    !['inferred', 'source_checked'].includes(value.origin as string) || !['proposal', 'active'].includes(value.status as string) ||
    (value.status === 'active' && (value.origin !== 'source_checked' || !hasSourceBasis(value as unknown as TopicTermContent)))) return undefined
  return { ...copyContent(value as unknown as TopicTermContent), id: value.id, expectedEntryVersion: value.expectedEntryVersion,
    origin: value.origin as TopicTermPut['origin'], status: value.status as TopicTermPut['status'] }
}

/** Local form boundary. The model RPC continues to accept only TopicTermPut. */
export function decodeTopicTermUserInput(value: unknown): TopicTermUserInput | undefined {
  if (!record(value) || !exact(value, ['id', 'expectedEntryVersion', 'sourceLanguage', 'targetLanguage', 'sourceForms', 'aliases', 'sense', 'preferred', 'forbidden']) ||
    !(value.id === null || text(value.id, 2048)) || !(value.expectedEntryVersion === null || integer(value.expectedEntryVersion, 1)) ||
    (value.id === null && value.expectedEntryVersion !== null) || !content({ ...value, evidence: [] } as unknown as TopicTermContent)) return undefined
  return structuredClone(value) as unknown as TopicTermUserInput
}

/** Parse only at storage/RPC boundaries. Parsing does not resolve or restore source facts. */
export function decodeTopicTermSnapshot(value: unknown): TopicTermSnapshot | undefined {
  if (!record(value) || !exact(value, ['schemaVersion', 'ownerId', 'topicId', 'version', 'activeVersion', 'updatedAt', 'entries']) || value.schemaVersion !== 1 ||
    !text(value.ownerId, 2048) || !text(value.topicId, 2048) || !integer(value.version) || !integer(value.activeVersion) || value.activeVersion > value.version || !time(value.updatedAt) || !Array.isArray(value.entries)) return undefined
  const entries: TopicTerm[] = [], ids = new Set<string>()
  for (const raw of value.entries) {
    if (!record(raw) || !exact(raw, ['id', 'version', 'sourceLanguage', 'targetLanguage', 'sourceForms', 'aliases', 'sense', 'preferred', 'forbidden', 'evidence', 'status', 'origin', 'confirmation', 'createdAt', 'updatedAt']) ||
      !text(raw.id, 2048) || ids.has(raw.id) || !integer(raw.version, 1) || raw.version > value.version || !time(raw.createdAt) || !time(raw.updatedAt) ||
      !statuses.includes(raw.status as TopicTermStatus) || !['inferred', 'source_checked', 'user_explicit'].includes(raw.origin as string) || !content(raw as unknown as TopicTermContent)) return undefined
    if (raw.origin === 'user_explicit' ? (!adoption(raw.confirmation) || raw.confirmation.adoptedEntryVersion >= raw.version || (raw.evidence as TermEvidenceRef[]).some(ref => ref.role === 'basis')) : raw.confirmation !== null) return undefined
    if (raw.status === 'active' && (raw.origin === 'inferred' || (raw.origin === 'source_checked' && !hasSourceBasis(raw as unknown as TopicTermContent)))) return undefined
    ids.add(raw.id); entries.push(structuredClone(raw) as unknown as TopicTerm)
  }
  return { schemaVersion: 1, ownerId: value.ownerId, topicId: value.topicId, version: value.version, activeVersion: value.activeVersion, updatedAt: value.updatedAt, entries }
}

export function emptyTopicTerms(ownerId: string, topicId: string, at: string): TopicTermSnapshot {
  if (!text(ownerId, 2048) || !text(topicId, 2048) || !time(at)) throw new Error('Invalid topic term identity or time')
  return { schemaVersion: 1, ownerId, topicId, version: 0, activeVersion: 0, updatedAt: at, entries: [] }
}

export function resolveTermEvidence(snapshot: Pick<TopicTermSnapshot, 'ownerId' | 'topicId'>, ref: TermEvidenceRef, resolver: TermEvidenceResolver): string | undefined {
  if (resolver.resolveRef) {
    const body = resolver.resolveRef(snapshot, ref)
    return typeof body === 'string' && body.trim() ? body : undefined
  }
  const fact = resolver(ref.sessionId, ref.unitId)
  if (!fact || fact.ownerId !== snapshot.ownerId || fact.topicId !== snapshot.topicId || !integer(fact.sourceVersion, 1)) return undefined
  let body: string
  if (ref.kind === 'source') {
    if ((ref.sourceVersion ?? 1) !== fact.sourceVersion) return undefined
    body = fact.source
  }
  else {
    if (!fact.final || !integer(fact.final.sourceVersion, 1) || fact.final.sourceVersion !== fact.sourceVersion ||
      fact.final.revisionId !== ref.revisionId || fact.final.selectionEventId !== ref.selectionEventId) return undefined
    body = fact.final.text
  }
  if (ref.range !== null) {
    const points = Array.from(body)
    if (ref.range.end > points.length) return undefined
    body = points.slice(ref.range.start, ref.range.end).join('')
  }
  return body.trim() ? body : undefined
}
function validBasis(snapshot: TopicTermSnapshot, entry: TopicTermContent, resolver: TermEvidenceResolver): boolean {
  return hasSourceBasis(entry) && entry.evidence.filter(ref => ref.role === 'basis').every(ref => resolveTermEvidence(snapshot, ref, resolver) !== undefined)
}
function effective(snapshot: TopicTermSnapshot, entry: TopicTerm, resolver: TermEvidenceResolver): boolean {
  return entry.status === 'active' && (entry.origin === 'user_explicit' || (entry.origin === 'source_checked' && validBasis(snapshot, entry, resolver)))
}
/** Shared candidate selection for bounded evidence preparation and the pure conflict check. */
export function topicTermContentsConflict(left: TopicTermContent, right: TopicTermContent): boolean {
  return left.sourceLanguage === right.sourceLanguage && left.targetLanguage === right.targetLanguage && left.sense === right.sense &&
    [...left.sourceForms, ...left.aliases].some(form => [...right.sourceForms, ...right.aliases].includes(form)) &&
    (left.preferred !== right.preferred || left.forbidden.includes(right.preferred) || right.forbidden.includes(left.preferred))
}
function hasConflict(snapshot: TopicTermSnapshot, entry: TopicTermContent & { readonly id: string }, resolver?: TermEvidenceResolver): boolean {
  return snapshot.entries.some(old => old.id !== entry.id && old.status === 'active' && topicTermContentsConflict(old, entry) &&
    (!resolver || effective(snapshot, old, resolver) || (old.origin === 'source_checked' && hasSourceBasis(old) &&
      old.evidence.filter(ref => ref.role === 'basis').every(ref => resolveTermEvidence(snapshot, ref, resolver) !== undefined || resolver.isUnloaded?.(snapshot, ref)))))
}
function activeProjection(entry: TopicTerm): unknown {
  if (entry.status !== 'active') return null
  return { id: entry.id, sourceLanguage: entry.sourceLanguage, targetLanguage: entry.targetLanguage, sourceForms: entry.sourceForms, aliases: entry.aliases,
    sense: entry.sense, preferred: entry.preferred, forbidden: entry.forbidden, origin: entry.origin, basis: entry.evidence.filter(ref => ref.role === 'basis') }
}
function copyContent(entry: TopicTermContent): TopicTermContent {
  return { sourceLanguage: entry.sourceLanguage, targetLanguage: entry.targetLanguage, sourceForms: [...entry.sourceForms], aliases: [...entry.aliases],
    sense: entry.sense, preferred: entry.preferred, forbidden: [...entry.forbidden], evidence: entry.evidence.map(ref => ({ kind: ref.kind, sessionId: ref.sessionId, unitId: ref.unitId,
      ...(ref.kind === 'source' && ref.sourceVersion !== undefined ? { sourceVersion: ref.sourceVersion } : {}),
      revisionId: ref.revisionId, selectionEventId: ref.selectionEventId, range: ref.range ? { ...ref.range } : null, role: ref.role })) }
}
function replace(snapshot: TopicTermSnapshot, entry: TopicTerm, at: string): TopicTermSnapshot {
  const old = snapshot.entries.find(item => item.id === entry.id)
  const activeChanged = JSON.stringify(old ? activeProjection(old) : null) !== JSON.stringify(activeProjection(entry))
  return { ...snapshot, version: snapshot.version + 1, activeVersion: snapshot.activeVersion + (activeChanged ? 1 : 0), updatedAt: at,
    entries: old ? snapshot.entries.map(item => item.id === entry.id ? entry : item) : [...snapshot.entries, entry] }
}
function result(snapshot: TopicTermSnapshot, status: TermMutationResult['status'], entry: TopicTerm | null): TermMutationResult { return { status, snapshot, entry } }

/** Main-model proposals/source checks cannot rewrite a user-adopted rule. */
export function putTopicTerm(snapshot: TopicTermSnapshot, input: TopicTermPut, resolver: TermEvidenceResolver, at: string): TermMutationResult {
  const old = snapshot.entries.find(entry => entry.id === input.id) ?? null
  if ((old?.version ?? null) !== input.expectedEntryVersion) return result(snapshot, 'stale', old)
  if (old?.origin === 'user_explicit') return result(snapshot, 'requires_user_action', old)
  if (!text(input.id, 2048) || !time(at) || !content(input) || !['inferred', 'source_checked'].includes(input.origin) ||
    !['proposal', 'active'].includes(input.status) || (input.origin === 'inferred' && input.status === 'active')) return result(snapshot, 'invalid', old)
  let status: TopicTermStatus = input.status
  if (status === 'active' && !validBasis(snapshot, input, resolver)) return result(snapshot, 'invalid', old)
  if (status === 'active' && hasConflict(snapshot, input, resolver)) status = 'conflict'
  const entry: TopicTerm = { ...copyContent(input), id: input.id, origin: input.origin, status, confirmation: null, version: (old?.version ?? 0) + 1, createdAt: old?.createdAt ?? at, updatedAt: at }
  if (old && old.origin === entry.origin && old.status === entry.status && JSON.stringify(copyContent(old)) === JSON.stringify(copyContent(entry))) return result(snapshot, 'unchanged', old)
  return result(replace(snapshot, entry, at), 'updated', entry)
}

/** One explicit user save, with no intermediate persisted proposal or second adoption action. */
export function putUserTopicTerm(snapshot: TopicTermSnapshot, input: TopicTermUserPut, action: { readonly eventId: string; readonly at: string }): TermMutationResult {
  const old = snapshot.entries.find(entry => entry.id === input.id) ?? null
  if ((old?.version ?? null) !== input.expectedEntryVersion) return result(snapshot, 'stale', old)
  const submitted = { ...input, evidence: old?.evidence ?? [] }
  if (!text(input.id, 2048) || !text(action.eventId, 2048) || !time(action.at) || !content(submitted)) return result(snapshot, 'invalid', old)
  const fields = copyContent(submitted)
  if (hasConflict(snapshot, { ...fields, id: input.id })) return result(snapshot, 'conflict', old)
  const examples = fields.evidence.map(ref => ({ ...ref, role: 'example' as const }))
  if (old?.origin === 'user_explicit' && old.status === 'active' && JSON.stringify(copyContent(old)) === JSON.stringify({ ...fields, evidence: examples })) return result(snapshot, 'unchanged', old)
  if (!old) {
    // Existing schema1 confirmation references a real candidate version >= 1.
    // Build both facts in memory; the caller writes only the final adopted snapshot.
    const candidate = putTopicTerm(snapshot, { ...fields, id: input.id, expectedEntryVersion: null, origin: 'inferred', status: 'proposal' }, () => undefined, action.at)
    return adoptTopicTerm(candidate.snapshot, input.id, candidate.entry!.version, action)
  }
  const entry: TopicTerm = { ...fields, evidence: examples, id: old.id, createdAt: old.createdAt, updatedAt: action.at,
    version: old.version + 1, origin: 'user_explicit', status: 'active', confirmation: { ...action, adoptedEntryVersion: old.version } }
  return result(replace(snapshot, entry, action.at), 'updated', entry)
}

/** Only an explicit UI adoption supplies this event; model put has no confirmation field. */
export function adoptTopicTerm(snapshot: TopicTermSnapshot, id: string, expectedEntryVersion: number, action: { readonly eventId: string; readonly at: string }): TermMutationResult {
  const old = snapshot.entries.find(entry => entry.id === id) ?? null
  if (!old || old.version !== expectedEntryVersion) return result(snapshot, 'stale', old)
  if (!text(action.eventId, 2048) || !time(action.at)) return result(snapshot, 'invalid', old)
  if (hasConflict(snapshot, old)) return result(snapshot, 'conflict', old)
  if (old.origin === 'user_explicit' && old.status === 'active') return result(snapshot, 'unchanged', old)
  const entry: TopicTerm = { ...old, origin: 'user_explicit', status: 'active', version: old.version + 1, updatedAt: action.at,
    evidence: old.evidence.map(ref => ({ ...ref, role: 'example' })), confirmation: { ...action, adoptedEntryVersion: old.version } }
  return result(replace(snapshot, entry, action.at), 'updated', entry)
}

export function disableTopicTerm(snapshot: TopicTermSnapshot, id: string, expectedEntryVersion: number, at: string): TermMutationResult {
  const old = snapshot.entries.find(entry => entry.id === id) ?? null
  if (!old || old.version !== expectedEntryVersion) return result(snapshot, 'stale', old)
  if (!time(at)) return result(snapshot, 'invalid', old)
  if (old.status === 'disabled') return result(snapshot, 'unchanged', old)
  const entry: TopicTerm = { ...old, status: 'disabled', version: old.version + 1, updatedAt: at }
  return result(replace(snapshot, entry, at), 'updated', entry)
}

/** Invalidated basis cannot silently revive, even if an old final revision is selected again. */
export function reconcileTopicTerms(snapshot: TopicTermSnapshot, resolver: TermEvidenceResolver, at: string,
  isUnloaded: (ref: TermEvidenceRef) => boolean = () => false): TopicTermSnapshot {
  if (!time(at)) throw new Error('Invalid topic term reconciliation time')
  let next = snapshot
  for (const entry of snapshot.entries) {
    if (entry.origin === 'user_explicit' || entry.status === 'disabled' || entry.status === 'review_required') continue
    const basis = entry.evidence.filter(ref => ref.role === 'basis')
    if (basis.some(ref => resolveTermEvidence(snapshot, ref, resolver) === undefined && !isUnloaded(ref)) || (entry.status === 'active' && !hasSourceBasis(entry))) {
      next = replace(next, { ...entry, status: 'review_required', version: entry.version + 1, updatedAt: at }, at)
    }
  }
  return next
}

/** Quick never reads terms. Normal lookup is scoped and matches explicit forms exactly. */
export function queryTopicTerms(snapshot: TopicTermSnapshot, query: TopicTermQuery, resolver: TermEvidenceResolver): readonly TopicTerm[] {
  if (query.mode !== 'normal' || query.ownerId !== snapshot.ownerId || query.topicId !== snapshot.topicId) return []
  return snapshot.entries.filter(entry => entry.sourceLanguage === query.sourceLanguage && entry.targetLanguage === query.targetLanguage &&
    effective(snapshot, entry, resolver) && [...entry.sourceForms, ...entry.aliases].some(form => query.forms.includes(form)))
}
