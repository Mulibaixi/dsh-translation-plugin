import { parseSourceIdentity, type SourceIdentity } from './translation-sources.js'
import { parseTranslationSourceReference, parseTranslationSourceStorageRequest,
  type TranslationSourceReference } from './translation-source-storage.js'
import { sourceCodePointLength, type TranslationSourceRange } from './translation-source-read.js'

export interface VersionReference { readonly id: string; readonly version: number }
export type SourceBody = { readonly kind: 'inline'; readonly text: string }
  | { readonly kind: 'asset'; readonly reference: SourceIdentity }
/** Exact prepared transaction retained by the authoritative history writer. */
export interface DocumentSourceHistoryCommit {
  readonly reference: TranslationSourceReference
  readonly historyToken: string
  readonly confirmOperationId: string
}
export interface DocumentSourceVersion {
  readonly version: number
  readonly body: SourceBody
  readonly createdAt: string
  readonly operationId: string | null
  readonly historyCommit?: DocumentSourceHistoryCommit
}
/** The preparation body is owned by the later preparation service, not copied into history. */
export interface DocumentPreparationReference extends VersionReference { readonly sourceVersion: number }
export interface ChunkPlanItem {
  readonly chunkId: string
  readonly outputRange: TranslationSourceRange
  readonly mode: 'translate' | 'copy'
  readonly contextRanges: readonly TranslationSourceRange[]
}
export interface DocumentChunkPlan extends VersionReference {
  readonly sourceVersion: number
  readonly preparationRef: VersionReference
  readonly items: readonly ChunkPlanItem[]
  readonly protectedRanges?: readonly TranslationSourceRange[]
  readonly createdAt: string
  readonly operationId: string
}
export type DocumentTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'interrupted'
export interface DocumentTaskRecord {
  readonly taskId: string
  readonly operationId: string
  readonly sourceVersion: number
  readonly planRef: VersionReference
  readonly preparationRef: VersionReference
  readonly createdAt: string
  readonly status: DocumentTaskStatus
}
export type DocumentTermReference = { readonly kind: 'topic_term'; readonly id: string; readonly entryVersion: number }
  | { readonly kind: 'candidate'; readonly id: string; readonly version: number }
export interface DocumentReferenceSelection extends VersionReference { readonly range: TranslationSourceRange }
export interface DocumentCallContextReference {
  readonly preparationRef: VersionReference
  readonly termRefs: readonly DocumentTermReference[]
  readonly referenceRefs: readonly DocumentReferenceSelection[]
  readonly contextRanges: readonly TranslationSourceRange[]
  readonly supplementRefs: readonly VersionReference[]
}
/** One actual call, with selected context references; no source or preparation body. */
export interface DocumentCallRecord {
  readonly callId: string
  readonly attemptId: string
  readonly promptVersion: string
  readonly model: { readonly provider: string; readonly model: string; readonly reasoningEffort: string | null }
  readonly configVersion: null
  readonly maxOutputTokens: number | null
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null }
  readonly contextRef: DocumentCallContextReference
}
export type ChunkContent = { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'source_copy'; readonly sourceVersion: number; readonly range: TranslationSourceRange; readonly sha256: string }
export interface ChunkRevision {
  readonly id: string
  readonly taskId: string
  readonly childOperationId: string
  readonly attemptId: string | null
  readonly callId: string | null
  readonly sourceVersion: number
  readonly chunkId: string
  readonly planRef: VersionReference
  readonly preparationRef: VersionReference
  readonly kind: 'machine' | 'manual' | 'copy'
  readonly status: DocumentTaskStatus
  readonly content: ChunkContent
  readonly callRecord: DocumentCallRecord | null
  readonly createdAt: string
  readonly updatedAt: string
}
export interface ManifestEntry {
  readonly chunkId: string
  readonly outputRange: TranslationSourceRange
  readonly revisionId: string
  readonly reuseRef?: { readonly sourceVersion: number; readonly planVersion: number; readonly revisionId: string }
}
export interface DocumentReview {
  readonly status: 'pending' | 'passed' | 'failed'
  readonly checkedAt: string | null
  readonly issues: readonly { readonly code: string; readonly range: TranslationSourceRange; readonly message: string }[]
}
export interface DocumentEligibility { readonly complete: boolean; readonly finalEligible: boolean }
export interface DocumentRevision {
  readonly id: string
  readonly taskId: string
  readonly sourceVersion: number
  readonly planRef: VersionReference
  readonly preparationRef: VersionReference
  readonly createdAt: string
  readonly entries: readonly ManifestEntry[]
  readonly review: DocumentReview
  readonly eligibility: DocumentEligibility
}
export interface DocumentFinalPointer {
  readonly revisionId: string
  readonly selection: 'automatic' | 'user_fixed'
  readonly selectedAt: string
}
export interface DocumentUnit {
  readonly kind: 'document'
  readonly id: string
  readonly order: number
  readonly targetLanguage: string
  readonly instruction: string
  readonly sourceVersion: number
  readonly sourceVersions: readonly DocumentSourceVersion[]
  readonly createdAt: string
  readonly preparations: readonly DocumentPreparationReference[]
  readonly plans: readonly DocumentChunkPlan[]
  readonly tasks: readonly DocumentTaskRecord[]
  readonly chunkRevisions: readonly ChunkRevision[]
  readonly revisions: readonly DocumentRevision[]
  readonly final: DocumentFinalPointer | null
}

type Data = Record<string, unknown>
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('Unexpected document fields')
}
function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new TypeError('Invalid document number')
}
function string(value: unknown, maximum = 2048, required = true): asserts value is string {
  if (typeof value !== 'string' || (required && !value.trim()) || sourceCodePointLength(value) > maximum) throw new TypeError('Invalid document text')
}
function time(value: unknown): asserts value is string { string(value, 40); if (!Number.isFinite(Date.parse(value))) throw new TypeError('Invalid document time') }
function array(value: unknown, maximum = Number.MAX_SAFE_INTEGER): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError('Invalid document list')
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
export function sameVersionReference(left: VersionReference, right: VersionReference): boolean { return left.id === right.id && left.version === right.version }
export function documentSourceLength(source: DocumentSourceVersion): number {
  return source.body.kind === 'inline' ? sourceCodePointLength(source.body.text) : source.body.reference.totalCodePoints
}
function range(value: unknown, maximum = Number.MAX_SAFE_INTEGER): TranslationSourceRange {
  exact(value, ['start', 'end']); integer(value.start, 0, maximum); integer(value.end, value.start + 1, maximum)
  return { start: value.start, end: value.end }
}
function ref(value: unknown): VersionReference {
  exact(value, ['id', 'version']); string(value.id); integer(value.version)
  return { id: value.id, version: value.version }
}
function taskStatus(value: unknown): asserts value is DocumentTaskStatus {
  if (!['running', 'completed', 'failed', 'cancelled', 'unknown', 'interrupted'].includes(value as string)) throw new TypeError('Invalid document status')
}
export function parseDocumentSourceVersion(value: unknown): DocumentSourceVersion {
  exact(value, ['version', 'body', 'createdAt', 'operationId'], ['historyCommit']); integer(value.version); time(value.createdAt)
  if (value.operationId !== null) string(value.operationId)
  exact(value.body, ['kind'], ['text', 'reference'])
  let body: SourceBody
  if (value.body.kind === 'inline') {
    exact(value.body, ['kind', 'text']); string(value.body.text, 2_000_000)
    if (new TextEncoder().encode(value.body.text).byteLength > 2 * 1024 * 1024 || /[\uD800-\uDFFF]/u.test(value.body.text)) throw new TypeError('Invalid document source encoding')
    body = { kind: 'inline', text: value.body.text }
  } else {
    if (value.body.kind !== 'asset') throw new TypeError('Invalid document source body')
    exact(value.body, ['kind', 'reference']); body = { kind: 'asset', reference: parseSourceIdentity(value.body.reference) }
  }
  const result: DocumentSourceVersion = { version: value.version, body, createdAt: value.createdAt, operationId: value.operationId as string | null }
  if (Object.hasOwn(value, 'historyCommit')) {
    if (body.kind !== 'asset') throw new TypeError('Inline sources have no storage transaction')
    exact(value.historyCommit, ['reference', 'historyToken', 'confirmOperationId'])
    const reference = parseTranslationSourceReference(value.historyCommit.reference)
    if (reference.state !== 'prepared' || !same(reference.source, body.reference)) throw new TypeError('Source history transaction identity changed')
    const confirmation = parseTranslationSourceStorageRequest('confirmReference', { scope: reference.scope, referenceKey: reference.referenceKey,
      prepareToken: reference.prepareToken, historyToken: value.historyCommit.historyToken, operationId: value.historyCommit.confirmOperationId })
    if (!('historyToken' in confirmation) || !('operationId' in confirmation)) throw new TypeError('Invalid source history transaction')
    return { ...result, historyCommit: { reference, historyToken: confirmation.historyToken, confirmOperationId: confirmation.operationId } }
  }
  return result
}
export function parseDocumentPreparationReference(value: unknown): DocumentPreparationReference {
  exact(value, ['id', 'version', 'sourceVersion']); string(value.id); integer(value.version); integer(value.sourceVersion)
  return { id: value.id, version: value.version, sourceVersion: value.sourceVersion }
}
export function parseDocumentChunkPlan(value: unknown, sourceLength: number): DocumentChunkPlan {
  exact(value, ['id', 'version', 'sourceVersion', 'preparationRef', 'items', 'createdAt', 'operationId'], ['protectedRanges'])
  string(value.id); integer(value.version); integer(value.sourceVersion); time(value.createdAt); string(value.operationId); array(value.items, 256)
  const preparationRef = ref(value.preparationRef), items: ChunkPlanItem[] = [], ids = new Set<string>()
  let end = 0
  for (const raw of value.items) {
    exact(raw, ['chunkId', 'outputRange', 'mode', 'contextRanges']); string(raw.chunkId); array(raw.contextRanges, 8)
    const outputRange = range(raw.outputRange, sourceLength)
    if (ids.has(raw.chunkId) || outputRange.start !== end || !['translate', 'copy'].includes(raw.mode as string)) throw new TypeError('Document plan must cover the source once in order')
    const contextRanges = raw.contextRanges.map(item => range(item, sourceLength))
    ids.add(raw.chunkId); end = outputRange.end
    items.push({ chunkId: raw.chunkId, outputRange, mode: raw.mode as ChunkPlanItem['mode'], contextRanges })
  }
  if (!items.length || end !== sourceLength) throw new TypeError('Document plan does not cover the entire source')
  let protectedRanges: TranslationSourceRange[] | undefined
  if (Object.hasOwn(value, 'protectedRanges')) {
    array(value.protectedRanges, 256)
    protectedRanges = []
    let protectedEnd = 0
    for (const raw of value.protectedRanges) {
      const protectedRange = range(raw, sourceLength)
      if (protectedRange.start < protectedEnd) throw new TypeError('Document protected ranges must be ordered and disjoint')
      protectedRanges.push(protectedRange); protectedEnd = protectedRange.end
    }
  }
  const result: DocumentChunkPlan = { id: value.id, version: value.version, sourceVersion: value.sourceVersion, preparationRef,
    items, ...(protectedRanges ? { protectedRanges } : {}), createdAt: value.createdAt, operationId: value.operationId }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 32768) throw new TypeError('Document plan exceeds metadata budget')
  return result
}
export function parseDocumentTaskRecord(value: unknown): DocumentTaskRecord {
  exact(value, ['taskId', 'operationId', 'sourceVersion', 'planRef', 'preparationRef', 'createdAt', 'status'])
  string(value.taskId); string(value.operationId); integer(value.sourceVersion); time(value.createdAt); taskStatus(value.status)
  return { taskId: value.taskId, operationId: value.operationId, sourceVersion: value.sourceVersion,
    planRef: ref(value.planRef), preparationRef: ref(value.preparationRef), createdAt: value.createdAt, status: value.status }
}
export function parseDocumentCallRecord(value: unknown, sourceLength: number): DocumentCallRecord {
  exact(value, ['callId', 'attemptId', 'promptVersion', 'model', 'configVersion', 'maxOutputTokens', 'usage', 'contextRef'])
  string(value.callId); string(value.attemptId); string(value.promptVersion, 128)
  exact(value.model, ['provider', 'model', 'reasoningEffort']); string(value.model.provider, 512); string(value.model.model, 512)
  if (value.model.reasoningEffort !== null) string(value.model.reasoningEffort, 64)
  if (value.configVersion !== null) throw new TypeError('Unsupported document call configuration')
  if (value.maxOutputTokens !== null) integer(value.maxOutputTokens, 0)
  exact(value.usage, ['inputTokens', 'outputTokens'])
  for (const count of [value.usage.inputTokens, value.usage.outputTokens]) if (count !== null) integer(count, 0)
  return { callId: value.callId, attemptId: value.attemptId, promptVersion: value.promptVersion,
    model: { provider: value.model.provider, model: value.model.model, reasoningEffort: value.model.reasoningEffort as string | null }, configVersion: null,
    maxOutputTokens: value.maxOutputTokens as number | null, usage: { inputTokens: value.usage.inputTokens as number | null, outputTokens: value.usage.outputTokens as number | null },
    contextRef: parseDocumentCallContextReference(value.contextRef, sourceLength) }
}
export function parseDocumentCallContextReference(value: unknown, sourceLength: number): DocumentCallContextReference {
  exact(value, ['preparationRef', 'termRefs', 'referenceRefs', 'contextRanges', 'supplementRefs'])
  const contextRef = value
  array(contextRef.termRefs, 100); array(contextRef.referenceRefs, 32); array(contextRef.contextRanges, 8); array(contextRef.supplementRefs, 4)
  const termRefs: DocumentTermReference[] = contextRef.termRefs.map(raw => {
    exact(raw, ['kind', 'id'], ['entryVersion', 'version']); string(raw.id)
    if (raw.kind === 'topic_term') { exact(raw, ['kind', 'id', 'entryVersion']); integer(raw.entryVersion); return { kind: 'topic_term', id: raw.id, entryVersion: raw.entryVersion } }
    if (raw.kind !== 'candidate') throw new TypeError('Invalid document term reference')
    exact(raw, ['kind', 'id', 'version']); integer(raw.version); return { kind: 'candidate', id: raw.id, version: raw.version }
  })
  const referenceRefs = contextRef.referenceRefs.map(raw => {
    exact(raw, ['id', 'version', 'range']); string(raw.id); integer(raw.version)
    return { id: raw.id, version: raw.version, range: range(raw.range) }
  })
  const supplementRefs = contextRef.supplementRefs.map(ref)
  for (const refs of [termRefs, referenceRefs, supplementRefs]) if (new Set(refs.map(item => JSON.stringify(item))).size !== refs.length) throw new TypeError('Duplicate document context reference')
  return { preparationRef: ref(contextRef.preparationRef), termRefs, referenceRefs,
    contextRanges: contextRef.contextRanges.map(item => range(item, sourceLength)), supplementRefs }
}
export function parseChunkRevision(value: unknown, sourceLength: number): ChunkRevision {
  exact(value, ['id', 'taskId', 'childOperationId', 'attemptId', 'callId', 'sourceVersion', 'chunkId', 'planRef', 'preparationRef', 'kind', 'status', 'content', 'callRecord', 'createdAt', 'updatedAt'])
  string(value.id); string(value.taskId); string(value.childOperationId); integer(value.sourceVersion); string(value.chunkId); time(value.createdAt); time(value.updatedAt); taskStatus(value.status)
  if (!['machine', 'manual', 'copy'].includes(value.kind as string)) throw new TypeError('Invalid document revision kind')
  const planRef = ref(value.planRef), preparationRef = ref(value.preparationRef)
  exact(value.content, ['kind'], ['text', 'sourceVersion', 'range', 'sha256'])
  let content: ChunkContent
  if (value.content.kind === 'text') {
    exact(value.content, ['kind', 'text']); string(value.content.text, 16 * 1024 * 1024, value.status === 'completed')
    if (new TextEncoder().encode(value.content.text).byteLength > 16 * 1024 * 1024 || /[\uD800-\uDFFF]/u.test(value.content.text)) throw new TypeError('Document chunk exceeds text encoding or byte budget')
    content = { kind: 'text', text: value.content.text }
  } else {
    if (value.content.kind !== 'source_copy') throw new TypeError('Invalid document chunk content')
    exact(value.content, ['kind', 'sourceVersion', 'range', 'sha256']); integer(value.content.sourceVersion)
    if (typeof value.content.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.content.sha256)) throw new TypeError('Invalid source copy checksum')
    content = { kind: 'source_copy', sourceVersion: value.content.sourceVersion, range: range(value.content.range, sourceLength), sha256: value.content.sha256 }
  }
  let callRecord: DocumentCallRecord | null = null
  if (value.kind === 'machine') {
    string(value.callId); string(value.attemptId)
    if (content.kind !== 'text') throw new TypeError('Machine chunks must own their translated text')
    if (value.callRecord !== null) {
      callRecord = parseDocumentCallRecord(value.callRecord, sourceLength)
      if (callRecord.callId !== value.callId || callRecord.attemptId !== value.attemptId || !sameVersionReference(callRecord.contextRef.preparationRef, preparationRef)) throw new TypeError('Document call identity changed')
    }
    if (value.status === 'completed' && callRecord === null) throw new TypeError('Completed machine chunks require the actual call record')
  } else if (value.callId !== null || value.attemptId !== null || value.callRecord !== null || value.status !== 'completed' ||
    (value.kind === 'copy' ? content.kind !== 'source_copy' : content.kind !== 'text')) throw new TypeError('Local chunks cannot pretend to be model calls')
  return { id: value.id, taskId: value.taskId, childOperationId: value.childOperationId, attemptId: value.attemptId as string | null,
    callId: value.callId as string | null, sourceVersion: value.sourceVersion, chunkId: value.chunkId, planRef, preparationRef,
    kind: value.kind as ChunkRevision['kind'], status: value.status, content, callRecord, createdAt: value.createdAt, updatedAt: value.updatedAt }
}
export function parseDocumentRevision(value: unknown, sourceLength: number): DocumentRevision {
  exact(value, ['id', 'taskId', 'sourceVersion', 'planRef', 'preparationRef', 'createdAt', 'entries', 'review', 'eligibility'])
  string(value.id); string(value.taskId); integer(value.sourceVersion); time(value.createdAt); array(value.entries, 256)
  const entries: ManifestEntry[] = value.entries.map(raw => {
    exact(raw, ['chunkId', 'outputRange', 'revisionId'], ['reuseRef']); string(raw.chunkId); string(raw.revisionId)
    const entry: ManifestEntry = { chunkId: raw.chunkId, outputRange: range(raw.outputRange, sourceLength), revisionId: raw.revisionId }
    if (!Object.hasOwn(raw, 'reuseRef')) return entry
    exact(raw.reuseRef, ['sourceVersion', 'planVersion', 'revisionId']); integer(raw.reuseRef.sourceVersion); integer(raw.reuseRef.planVersion); string(raw.reuseRef.revisionId)
    return { ...entry, reuseRef: { sourceVersion: raw.reuseRef.sourceVersion, planVersion: raw.reuseRef.planVersion, revisionId: raw.reuseRef.revisionId } }
  })
  exact(value.review, ['status', 'checkedAt', 'issues']); array(value.review.issues, 50)
  if (!['pending', 'passed', 'failed'].includes(value.review.status as string)) throw new TypeError('Invalid document review')
  if (value.review.status === 'pending' ? value.review.checkedAt !== null : value.review.checkedAt === null) throw new TypeError('Document review lacks its actual check time')
  if (value.review.checkedAt !== null) time(value.review.checkedAt)
  const issues = value.review.issues.map(raw => {
    exact(raw, ['code', 'range', 'message']); string(raw.code, 80); string(raw.message, 1000)
    return { code: raw.code, range: range(raw.range, sourceLength), message: raw.message }
  })
  if (value.review.status === 'passed' && issues.length) throw new TypeError('Passed document review has unresolved issues')
  exact(value.eligibility, ['complete', 'finalEligible'])
  if (typeof value.eligibility.complete !== 'boolean' || typeof value.eligibility.finalEligible !== 'boolean') throw new TypeError('Invalid document eligibility')
  return { id: value.id, taskId: value.taskId, sourceVersion: value.sourceVersion, planRef: ref(value.planRef), preparationRef: ref(value.preparationRef),
    createdAt: value.createdAt, entries, review: { status: value.review.status as DocumentReview['status'], checkedAt: value.review.checkedAt as string | null, issues },
    eligibility: { complete: value.eligibility.complete, finalEligible: value.eligibility.finalEligible } }
}

/** Validates structural facts only; document-task validates their cross references and eligibility. */
export function parseDocumentUnitShape(value: unknown): DocumentUnit {
  exact(value, ['kind', 'id', 'order', 'targetLanguage', 'instruction', 'sourceVersion', 'sourceVersions', 'createdAt', 'preparations', 'plans', 'tasks', 'chunkRevisions', 'revisions', 'final'])
  if (value.kind !== 'document') throw new TypeError('Invalid document unit kind')
  string(value.id); integer(value.order); string(value.targetLanguage, 80); string(value.instruction, 4000, false); integer(value.sourceVersion); time(value.createdAt)
  array(value.sourceVersions); array(value.preparations); array(value.plans); array(value.tasks); array(value.chunkRevisions); array(value.revisions)
  const sourceVersions = value.sourceVersions.map(parseDocumentSourceVersion)
  if (!sourceVersions.length || sourceVersions.some((source, index) => source.version !== index + 1) || value.sourceVersion !== sourceVersions.length) throw new TypeError('Invalid document source versions')
  const sourceLength = (version: unknown): number => {
    integer(version); const source = sourceVersions[version - 1]
    if (!source) throw new TypeError('Document source version unavailable')
    return documentSourceLength(source)
  }
  let final: DocumentFinalPointer | null = null
  if (value.final !== null) {
    exact(value.final, ['revisionId', 'selection', 'selectedAt']); string(value.final.revisionId); time(value.final.selectedAt)
    if (!['automatic', 'user_fixed'].includes(value.final.selection as string)) throw new TypeError('Invalid document final selection')
    final = { revisionId: value.final.revisionId, selection: value.final.selection as DocumentFinalPointer['selection'], selectedAt: value.final.selectedAt }
  }
  const plans = value.plans.map(raw => { exact(raw, ['id', 'version', 'sourceVersion', 'preparationRef', 'items', 'createdAt', 'operationId'], ['protectedRanges']); return parseDocumentChunkPlan(raw, sourceLength(raw.sourceVersion)) })
  const chunkRevisions = value.chunkRevisions.map(raw => { exact(raw, ['id', 'taskId', 'childOperationId', 'attemptId', 'callId', 'sourceVersion', 'chunkId', 'planRef', 'preparationRef', 'kind', 'status', 'content', 'callRecord', 'createdAt', 'updatedAt']); return parseChunkRevision(raw, sourceLength(raw.sourceVersion)) })
  const revisions = value.revisions.map(raw => { exact(raw, ['id', 'taskId', 'sourceVersion', 'planRef', 'preparationRef', 'createdAt', 'entries', 'review', 'eligibility']); return parseDocumentRevision(raw, sourceLength(raw.sourceVersion)) })
  return { kind: 'document', id: value.id, order: value.order, targetLanguage: value.targetLanguage, instruction: value.instruction, sourceVersion: value.sourceVersion,
    sourceVersions, createdAt: value.createdAt, preparations: value.preparations.map(parseDocumentPreparationReference), plans,
    tasks: value.tasks.map(parseDocumentTaskRecord), chunkRevisions, revisions, final }
}
