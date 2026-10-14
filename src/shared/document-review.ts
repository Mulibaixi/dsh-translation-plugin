import { parseTranslationSourceScope, type TranslationSourceScope } from './translation-sources.js'
import { sourceCodePointLength, type TranslationSourceRange } from './translation-source-read.js'
import type { VersionReference } from './translation-batch.js'

export interface DocumentReviewIssue { readonly code: string; readonly range: TranslationSourceRange; readonly message: string }
export interface DocumentReviewEntryReference { readonly chunkId: string; readonly revisionId: string }
export interface DocumentMechanicalReview {
  readonly status: 'passed' | 'failed'
  readonly sourceSha256: string
  readonly entries: readonly (DocumentReviewEntryReference & { readonly outputRange: TranslationSourceRange; readonly contentSha256: string })[]
  readonly issues: readonly DocumentReviewIssue[]
  /** Frozen actual dependency issues; later task facts do not rewrite this check. */
  readonly criticalIssues: readonly DocumentReviewIssue[]
  /** Text matching provides questions for the reviewer, never proof of mistranslation. */
  readonly suspicions: readonly DocumentReviewIssue[]
}
export interface DocumentSemanticReview {
  readonly status: 'pending' | 'passed' | 'review_required'
  readonly reviewedEntries: readonly DocumentReviewEntryReference[]
  readonly preparationRef: VersionReference | null
  readonly resolvedIssues: readonly DocumentReviewIssue[]
  readonly issues: readonly DocumentReviewIssue[]
  readonly summary: string
}
/** One immutable check of one fixed manifest; semantic completion appends another audit. */
export interface DocumentReviewAudit {
  readonly id: string
  readonly reviewId: string
  readonly operationId: string
  readonly version: number
  readonly parentAuditId: string | null
  readonly manifestRevisionId: string
  readonly reviewedRevisionId: string | null
  readonly sourceVersion: number
  readonly planRef: VersionReference
  readonly preparationRef: VersionReference
  readonly checkedAt: string
  readonly mechanical: DocumentMechanicalReview
  readonly semantic: DocumentSemanticReview
}
export interface DocumentManualRevisionBase extends DocumentReviewEntryReference { readonly manifestRevisionId: string }
export interface DocumentReviewTarget {
  readonly scope: TranslationSourceScope
  readonly unitId: string
  readonly sourceVersion: number
  readonly manifestRevisionId: string
}
export interface DocumentReviewBeginRequest { readonly target: DocumentReviewTarget; readonly operationId: string; readonly expectedReviewVersion: number }
export interface DocumentReviewSubmitRequest extends DocumentReviewBeginRequest {
  readonly beginAuditId: string
  readonly semantic: DocumentSemanticReview & { readonly status: 'passed' | 'review_required'; readonly preparationRef: VersionReference }
}
export interface DocumentReviewQueryRequest { readonly target: DocumentReviewTarget; readonly operationId?: string }
export interface DocumentReviewReadRequest {
  readonly target: DocumentReviewTarget
  readonly kind: 'source' | 'chunk'
  readonly revisionId?: string
  readonly range: TranslationSourceRange
}
export interface DocumentManualRevisionRequest extends DocumentReviewBeginRequest { readonly chunkId: string; readonly baseRevisionId: string; readonly text: string }
export interface DocumentFinalRequest extends DocumentReviewBeginRequest {}
export interface DocumentReviewReceipt {
  readonly target: DocumentReviewTarget
  readonly operationId: string
  readonly reviewVersion: number
  readonly audit: { readonly id: string; readonly reviewId: string; readonly version: number; readonly mechanicalStatus: DocumentMechanicalReview['status']; readonly semanticStatus: DocumentSemanticReview['status'] } | null
  readonly manifestRevisionId: string
  readonly status: 'pending' | 'passed' | 'review_required'
  readonly finalEligible: boolean
  readonly storage: 'saved' | 'runtime_only'
  readonly storageError: string | null
}

type Data = Record<string, unknown>
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('Unexpected document review fields')
}
function text(value: unknown, max = 2048, empty = false): asserts value is string {
  if (typeof value !== 'string' || !empty && !value.trim() || sourceCodePointLength(value) > max || /[\uD800-\uDFFF]/u.test(value)) throw new TypeError('Invalid document review text')
}
function integer(value: unknown, min = 1): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < min) throw new TypeError('Invalid document review version') }
function ref(value: unknown): VersionReference { exact(value, ['id', 'version']); text(value.id); integer(value.version); return { id: value.id, version: value.version } }
function range(value: unknown, maximum = Number.MAX_SAFE_INTEGER): TranslationSourceRange {
  exact(value, ['start', 'end']); integer(value.start, 0); integer(value.end)
  if (value.end <= value.start || value.end > maximum) throw new TypeError('Invalid document review range')
  return { start: value.start, end: value.end }
}
function list(value: unknown, max = 256): asserts value is unknown[] { if (!Array.isArray(value) || value.length > max) throw new TypeError('Invalid document review list') }
function packet(value: unknown): void { if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 196608) throw new TypeError('Document review transaction exceeds transport budget') }
function hash(value: unknown): asserts value is string { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new TypeError('Invalid document review checksum') }
function entry(value: unknown): DocumentReviewEntryReference { exact(value, ['chunkId', 'revisionId']); text(value.chunkId); text(value.revisionId); return { chunkId: value.chunkId, revisionId: value.revisionId } }
export function parseDocumentReviewIssues(value: unknown, maximum = Number.MAX_SAFE_INTEGER): readonly DocumentReviewIssue[] {
  list(value, 1024); return value.map(raw => { exact(raw, ['code', 'range', 'message']); text(raw.code, 128); text(raw.message, 2048); return { code: raw.code, range: range(raw.range, maximum), message: raw.message } })
}
export function parseDocumentMechanicalReview(value: unknown): DocumentMechanicalReview {
  exact(value, ['status', 'sourceSha256', 'entries', 'issues', 'criticalIssues', 'suspicions']); hash(value.sourceSha256); list(value.entries)
  if (!['passed', 'failed'].includes(String(value.status))) throw new TypeError('Invalid mechanical review status')
  const entries = value.entries.map(raw => { exact(raw, ['chunkId', 'revisionId', 'outputRange', 'contentSha256']); hash(raw.contentSha256); return { ...entry({ chunkId: raw.chunkId, revisionId: raw.revisionId }), outputRange: range(raw.outputRange), contentSha256: raw.contentSha256 } })
  const issues = parseDocumentReviewIssues(value.issues), criticalIssues = parseDocumentReviewIssues(value.criticalIssues), suspicions = parseDocumentReviewIssues(value.suspicions)
  if (value.status === 'passed' && issues.length || value.status === 'failed' && !issues.length) throw new TypeError('Mechanical status disagrees with findings')
  return { status: value.status as DocumentMechanicalReview['status'], sourceSha256: value.sourceSha256, entries, issues, criticalIssues, suspicions }
}
export function parseDocumentSemanticReview(value: unknown): DocumentSemanticReview {
  exact(value, ['status', 'reviewedEntries', 'preparationRef', 'resolvedIssues', 'issues', 'summary']); list(value.reviewedEntries); text(value.summary, 4000, true)
  if (!['pending', 'passed', 'review_required'].includes(String(value.status))) throw new TypeError('Invalid semantic review status')
  const reviewedEntries = value.reviewedEntries.map(entry), preparationRef = value.preparationRef === null ? null : ref(value.preparationRef)
  const issues = parseDocumentReviewIssues(value.issues), resolvedIssues = parseDocumentReviewIssues(value.resolvedIssues)
  if (value.status === 'pending' ? reviewedEntries.length || preparationRef !== null || resolvedIssues.length || issues.length || value.summary : preparationRef === null || !value.summary.trim()) throw new TypeError('Semantic review lacks its actual declaration')
  if (value.status === 'passed' && issues.length) throw new TypeError('Passed semantic review has unresolved issues')
  return { status: value.status as DocumentSemanticReview['status'], reviewedEntries, preparationRef, resolvedIssues, issues, summary: value.summary }
}
export function parseDocumentReviewAudit(value: unknown): DocumentReviewAudit {
  exact(value, ['id', 'reviewId', 'operationId', 'version', 'parentAuditId', 'manifestRevisionId', 'reviewedRevisionId', 'sourceVersion', 'planRef', 'preparationRef', 'checkedAt', 'mechanical', 'semantic'])
  for (const name of ['id', 'reviewId', 'operationId', 'manifestRevisionId'] as const) text(value[name])
  for (const name of ['parentAuditId', 'reviewedRevisionId'] as const) if (value[name] !== null) text(value[name])
  integer(value.version); integer(value.sourceVersion); text(value.checkedAt, 40)
  if (!Number.isFinite(Date.parse(value.checkedAt))) throw new TypeError('Invalid document review time')
  const semantic = parseDocumentSemanticReview(value.semantic)
  if (semantic.status === 'pending' ? value.parentAuditId !== null || value.reviewedRevisionId !== null : value.parentAuditId === null || value.reviewedRevisionId === null) throw new TypeError('Document audit stage changed')
  return { id: value.id as string, reviewId: value.reviewId as string, operationId: value.operationId as string, version: value.version, parentAuditId: value.parentAuditId as string | null,
    manifestRevisionId: value.manifestRevisionId as string, reviewedRevisionId: value.reviewedRevisionId as string | null, sourceVersion: value.sourceVersion, planRef: ref(value.planRef), preparationRef: ref(value.preparationRef),
    checkedAt: value.checkedAt, mechanical: parseDocumentMechanicalReview(value.mechanical), semantic }
}
export function parseDocumentManualRevisionBase(value: unknown): DocumentManualRevisionBase {
  exact(value, ['manifestRevisionId', 'chunkId', 'revisionId']); text(value.manifestRevisionId)
  return { manifestRevisionId: value.manifestRevisionId, ...entry({ chunkId: value.chunkId, revisionId: value.revisionId }) }
}
export function parseDocumentReviewTarget(value: unknown): DocumentReviewTarget {
  exact(value, ['scope', 'unitId', 'sourceVersion', 'manifestRevisionId']); text(value.unitId); text(value.manifestRevisionId); integer(value.sourceVersion)
  return { scope: parseTranslationSourceScope(value.scope), unitId: value.unitId, sourceVersion: value.sourceVersion, manifestRevisionId: value.manifestRevisionId }
}
function begin(value: Data): DocumentReviewBeginRequest { text(value.operationId); integer(value.expectedReviewVersion, 0); return { target: parseDocumentReviewTarget(value.target), operationId: value.operationId, expectedReviewVersion: value.expectedReviewVersion } }
export function parseDocumentReviewBeginRequest(value: unknown): DocumentReviewBeginRequest { packet(value); exact(value, ['target', 'operationId', 'expectedReviewVersion']); return begin(value) }
export function parseDocumentReviewSubmitRequest(value: unknown): DocumentReviewSubmitRequest {
  packet(value); exact(value, ['target', 'operationId', 'expectedReviewVersion', 'beginAuditId', 'semantic']); text(value.beginAuditId)
  const semantic = parseDocumentSemanticReview(value.semantic)
  if (semantic.status === 'pending' || !semantic.preparationRef) throw new TypeError('Submit requires an actual semantic decision')
  return { ...begin(value), beginAuditId: value.beginAuditId, semantic: { ...semantic, status: semantic.status, preparationRef: semantic.preparationRef } }
}
export function parseDocumentReviewQueryRequest(value: unknown): DocumentReviewQueryRequest {
  exact(value, ['target'], ['operationId']); if (value.operationId !== undefined) text(value.operationId)
  return { target: parseDocumentReviewTarget(value.target), ...(value.operationId === undefined ? {} : { operationId: value.operationId }) }
}
export function parseDocumentReviewReadRequest(value: unknown): DocumentReviewReadRequest {
  exact(value, ['target', 'kind', 'range'], ['revisionId'])
  if (value.kind !== 'source' && value.kind !== 'chunk' || value.kind === 'source' && value.revisionId !== undefined) throw new TypeError('Invalid review evidence kind')
  if (value.kind === 'chunk') text(value.revisionId)
  const part = range(value.range); if (part.end - part.start > 4000) throw new TypeError('Review evidence requires a bounded page')
  return { target: parseDocumentReviewTarget(value.target), kind: value.kind, range: part, ...(value.revisionId === undefined ? {} : { revisionId: value.revisionId as string }) }
}
export function parseDocumentManualRevisionRequest(value: unknown): DocumentManualRevisionRequest {
  exact(value, ['target', 'operationId', 'expectedReviewVersion', 'chunkId', 'baseRevisionId', 'text']); text(value.chunkId); text(value.baseRevisionId); text(value.text, 16 * 1024 * 1024)
  if (new TextEncoder().encode(value.text).byteLength > 16 * 1024 * 1024) throw new TypeError('Manual revision exceeds text budget')
  return { ...begin(value), chunkId: value.chunkId, baseRevisionId: value.baseRevisionId, text: value.text }
}
export const parseDocumentFinalRequest = parseDocumentReviewBeginRequest
export function parseDocumentReviewReceipt(value: unknown): DocumentReviewReceipt {
  exact(value, ['target', 'operationId', 'reviewVersion', 'audit', 'manifestRevisionId', 'status', 'finalEligible', 'storage', 'storageError'])
  text(value.operationId); text(value.manifestRevisionId); integer(value.reviewVersion, 0)
  if (!['pending', 'passed', 'review_required'].includes(String(value.status)) || typeof value.finalEligible !== 'boolean' ||
    !['saved', 'runtime_only'].includes(String(value.storage))) throw new TypeError('Invalid document review receipt')
  if (value.storageError !== null) text(value.storageError, 2048)
  let audit: DocumentReviewReceipt['audit'] = null
  if (value.audit !== null) {
    exact(value.audit, ['id', 'reviewId', 'version', 'mechanicalStatus', 'semanticStatus']); text(value.audit.id); text(value.audit.reviewId); integer(value.audit.version)
    if (!['passed', 'failed'].includes(String(value.audit.mechanicalStatus)) || !['pending', 'passed', 'review_required'].includes(String(value.audit.semanticStatus)) || value.audit.version > value.reviewVersion) throw new TypeError('Invalid document review audit receipt')
    audit = { id: value.audit.id, reviewId: value.audit.reviewId, version: value.audit.version, mechanicalStatus: value.audit.mechanicalStatus as 'passed' | 'failed', semanticStatus: value.audit.semanticStatus as DocumentSemanticReview['status'] }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 32768) throw new TypeError('Document review receipt exceeds page budget')
  return { target: parseDocumentReviewTarget(value.target), operationId: value.operationId, reviewVersion: value.reviewVersion, audit,
    manifestRevisionId: value.manifestRevisionId, status: value.status as DocumentReviewReceipt['status'], finalEligible: value.finalEligible,
    storage: value.storage as DocumentReviewReceipt['storage'], storageError: value.storageError as string | null }
}
