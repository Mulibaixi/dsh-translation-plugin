import { parseTranslationSourceScope, type TranslationSourceScope } from './translation-sources.js'
import { MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS, type TranslationSourceRange } from './translation-source-read.js'
import { parseDocumentReviewTarget, type DocumentReviewTarget } from './document-review.js'
import type { VersionReference } from './translation-batch.js'

export const MAX_DOCUMENT_REVIEW_PAGE_BYTES = 32768
export interface DocumentReviewPageRequest {
  readonly scope: TranslationSourceScope; readonly unitId: string; readonly sourceVersion: number
  readonly manifestRevisionId?: string; readonly section?: 'summary' | 'entries' | 'preparation' | 'issues'
  readonly cursor?: number; readonly limit?: number
}
export interface DocumentReviewSummary {
  readonly taskId: string; readonly taskVersion: number; readonly taskSequence: number; readonly operationId: string
  readonly planRef: VersionReference; readonly preparationRef: VersionReference
  readonly totalSourceCodePoints: number; readonly entryCount: number; readonly currentSourceVersion: number
  readonly mechanicalStatus: 'pending' | 'passed' | 'failed'; readonly semanticStatus: 'pending' | 'passed' | 'review_required'
  readonly beginAuditId: string | null; readonly finalEligible: boolean; readonly finalRevisionId: string | null
}
export interface DocumentReviewPage {
  readonly target: DocumentReviewTarget; readonly reviewVersion: number; readonly section: NonNullable<DocumentReviewPageRequest['section']>
  readonly summary: DocumentReviewSummary; readonly items: readonly unknown[]; readonly nextCursor: number | null
}
export interface DocumentReviewRead {
  readonly target: DocumentReviewTarget; readonly side: 'source' | 'chunk'; readonly revisionId?: string; readonly range: TranslationSourceRange
}
export interface DocumentReviewTextPage extends DocumentReviewRead { readonly text: string; readonly totalCodePoints: number }
/** Task terms are read from the exact preparation of one document source version; apply is explicit. */
export interface DocumentTaskTermsRequest {
  readonly scope: TranslationSourceScope; readonly unitId: string; readonly sourceVersion: number
  readonly preparationRef?: VersionReference; readonly apply: boolean
}
export interface DocumentTaskTermEntry {
  readonly sourceForms: readonly string[]; readonly preferred: string; readonly sense: string
  readonly userFixed: boolean; readonly rangeCount: number
}
export interface DocumentTaskTermsReply {
  readonly terms: readonly DocumentTaskTermEntry[]; readonly added: number; readonly skipped: number; readonly message: string
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('Invalid document review bridge fields')
}
function id(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new TypeError('Invalid document review bridge identity') }
function number(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new TypeError('Invalid document review bridge number') }
export function documentReviewBytes(value: unknown): number { return new TextEncoder().encode(JSON.stringify(value)).byteLength }
export function parseDocumentReviewPageRequest(value: unknown): DocumentReviewPageRequest {
  exact(value, ['scope', 'unitId', 'sourceVersion'], ['manifestRevisionId', 'section', 'cursor', 'limit'])
  id(value.unitId); number(value.sourceVersion, 1)
  if (value.manifestRevisionId !== undefined) id(value.manifestRevisionId)
  if (value.section !== undefined && !['summary', 'entries', 'preparation', 'issues'].includes(String(value.section))) throw new TypeError('Invalid document review section')
  if (value.cursor !== undefined) number(value.cursor)
  if (value.limit !== undefined) number(value.limit, 1, 50)
  return { ...value, scope: parseTranslationSourceScope(value.scope) } as unknown as DocumentReviewPageRequest
}
export function parseDocumentReviewPage(value: unknown): DocumentReviewPage {
  exact(value, ['target', 'reviewVersion', 'section', 'summary', 'items', 'nextCursor'])
  const target = parseDocumentReviewTarget(value.target)
  number(value.reviewVersion)
  if (!['summary', 'entries', 'preparation', 'issues'].includes(String(value.section)) || !Array.isArray(value.items) || value.items.length > 50) throw new TypeError('Invalid document review metadata page')
  if (value.nextCursor !== null) number(value.nextCursor)
  exact(value.summary, ['taskId', 'taskVersion', 'taskSequence', 'operationId', 'planRef', 'preparationRef', 'totalSourceCodePoints', 'entryCount', 'currentSourceVersion', 'mechanicalStatus', 'semanticStatus', 'beginAuditId', 'finalEligible', 'finalRevisionId'])
  for (const key of ['taskId', 'operationId']) id(value.summary[key])
  for (const key of ['taskVersion', 'currentSourceVersion']) number(value.summary[key], 1)
  for (const key of ['taskSequence', 'totalSourceCodePoints', 'entryCount']) number(value.summary[key])
  for (const key of ['planRef', 'preparationRef']) { exact(value.summary[key], ['id', 'version']); id(value.summary[key].id); number(value.summary[key].version, 1) }
  for (const key of ['beginAuditId', 'finalRevisionId']) if (value.summary[key] !== null) id(value.summary[key])
  if (!['pending', 'passed', 'failed'].includes(String(value.summary.mechanicalStatus)) || !['pending', 'passed', 'review_required'].includes(String(value.summary.semanticStatus)) || typeof value.summary.finalEligible !== 'boolean') throw new TypeError('Invalid document review summary')
  const parsed = { ...value, target } as unknown as DocumentReviewPage
  if (documentReviewBytes({ ok: true, value: parsed }) > MAX_DOCUMENT_REVIEW_PAGE_BYTES) throw new TypeError('Document review page too large')
  return structuredClone(parsed)
}
export function parseDocumentTaskTermsRequest(value: unknown): DocumentTaskTermsRequest {
  exact(value, ['scope', 'unitId', 'sourceVersion', 'apply'], ['preparationRef'])
  id(value.unitId); number(value.sourceVersion, 1)
  if (typeof value.apply !== 'boolean') throw new TypeError('Invalid document task terms apply flag')
  let preparationRef: VersionReference | undefined
  if (value.preparationRef !== undefined) {
    exact(value.preparationRef, ['id', 'version']); id(value.preparationRef.id); number(value.preparationRef.version, 1)
    preparationRef = { id: value.preparationRef.id, version: value.preparationRef.version }
  }
  return { scope: parseTranslationSourceScope(value.scope), unitId: value.unitId, sourceVersion: value.sourceVersion,
    apply: value.apply, ...(preparationRef === undefined ? {} : { preparationRef }) }
}
export function parseDocumentTaskTermsReply(value: unknown): DocumentTaskTermsReply {
  exact(value, ['terms', 'added', 'skipped', 'message'])
  if (!Array.isArray(value.terms) || value.terms.length > 200) throw new TypeError('Invalid document task terms list')
  const terms = value.terms.map(raw => {
    exact(raw, ['sourceForms', 'preferred', 'sense', 'userFixed', 'rangeCount'])
    if (!Array.isArray(raw.sourceForms) || !raw.sourceForms.length || raw.sourceForms.length > 20) throw new TypeError('Invalid document task term forms')
    for (const form of raw.sourceForms) id(form)
    id(raw.preferred)
    if (typeof raw.sense !== 'string' || typeof raw.userFixed !== 'boolean') throw new TypeError('Invalid document task term entry')
    number(raw.rangeCount)
    return { sourceForms: raw.sourceForms.map(form => form as string), preferred: raw.preferred as string, sense: raw.sense,
      userFixed: raw.userFixed, rangeCount: raw.rangeCount }
  })
  number(value.added); number(value.skipped)
  if (typeof value.message !== 'string' || Array.from(value.message).length > 2000) throw new TypeError('Invalid document task terms message')
  const reply = { terms, added: value.added as number, skipped: value.skipped as number, message: value.message }
  if (documentReviewBytes({ ok: true, value: reply }) > MAX_DOCUMENT_REVIEW_PAGE_BYTES) throw new TypeError('Document task terms reply too large')
  return reply
}
export function parseDocumentReviewRead(value: unknown): DocumentReviewRead {
  exact(value, ['target', 'side', 'range'], ['revisionId'])
  const target = parseDocumentReviewTarget(value.target)
  if (!['source', 'chunk'].includes(String(value.side))) throw new TypeError('Invalid review text side')
  if (value.side === 'chunk') id(value.revisionId)
  else if (value.revisionId !== undefined) throw new TypeError('Source page does not identify a chunk')
  exact(value.range, ['start', 'end']); number(value.range.start); number(value.range.end, Number(value.range.start) + 1)
  if (Number(value.range.end) - Number(value.range.start) > MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS) throw new TypeError('Review text page exceeds range limit')
  return { ...value, target } as unknown as DocumentReviewRead
}
export function parseDocumentReviewTextPage(value: unknown): DocumentReviewTextPage {
  exact(value, ['target', 'side', 'range', 'text', 'totalCodePoints'], ['revisionId'])
  const { text, totalCodePoints, ...raw } = value, request = parseDocumentReviewRead(raw)
  number(totalCodePoints)
  if (typeof text !== 'string' || Array.from(text).length !== request.range.end - request.range.start || totalCodePoints < request.range.end || documentReviewBytes({ ok: true, value }) > MAX_DOCUMENT_REVIEW_PAGE_BYTES) throw new TypeError('Invalid bounded review text page')
  return { ...request, text, totalCodePoints }
}

const reviewPackage = 'dsh-translation-plugin'
export const DOCUMENT_REVIEW_REMOTE = { package: reviewPackage, descriptors: [{ id: `${reviewPackage}#translationReview/notify`, service: 'translationReview', namespace: 'translationReview', method: 'notify', invocation: { kind: 'direct' as const },
  parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: `${reviewPackage}#review/notifyRequest`, create: () => ({ parse: (value: unknown) => {
    exact(value, ['target']); return { target: parseDocumentReviewTarget(value.target) }
  } }) } }], result: { mode: 'strict' as const, typeSymbol: `${reviewPackage}#review/notifyResult`, create: () => ({ parse: (value: unknown) => {
    exact(value, ['ok'], ['value', 'error'])
    if (value.ok === true) { exact(value, ['ok', 'value']); exact(value.value, ['state']); if (!['unavailable', 'available', 'not_enqueued', 'enqueued', 'claimed', 'discarded'].includes(String(value.value.state))) throw new TypeError('Invalid review notification state'); return { ok: true, value: { state: value.value.state as string } } }
    if (value.ok !== false) throw new TypeError('Invalid review notification result')
    exact(value, ['ok', 'error']); exact(value.error, ['code', 'message', 'stage']); for (const key of ['code', 'message', 'stage']) id(value.error[key])
    return { ok: false, error: { code: value.error.code as string, message: value.error.message as string, stage: value.error.stage as string } }
  } }) } }] }
