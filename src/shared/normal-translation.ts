import { TRANSLATION_LOG_REMOTE } from './translation-log.js'
import { parseOriginalFilePath } from './translation-sources.js'
import { parseReferenceContextRef, type ReferenceContextRef } from './reference-memory.js'
import { parseTranslationMaterialEnvelope, type TranslationMaterialEnvelope } from './translation-material.js'
import { isNormalTranslationPromptVersion, parseTranslationCallMetadata, type NormalTranslationTerm, type TranslationCallMetadata } from './translation-call.js'
import { parseDirectContextResponse, parseDirectContextSupplement, type DirectContextResponse, type DirectContextSupplement } from './direct-context.js'
import { IMAGE_BACKGROUND_LIMIT, type ImageUnitTarget, type ImageUnitUpdate } from './image-translation.js'
import type { ExactTextEdit } from './text-edits.js'
/** A main Agent refers to delivered material; it never supplies a replacement body. */
export interface NormalTranslationMaterialTarget {
  readonly kind: 'material'
  readonly mainSessionId: string
  readonly requestId: string
  readonly materialId: string
  readonly sourceVersion: number
}
export interface NormalTranslationUnitTarget {
  readonly kind: 'unit'
  readonly mainSessionId: string
  readonly translationSessionId: string
  readonly unitId: string
  readonly sourceVersion: number
}
export type DirectUnitTarget = NormalTranslationUnitTarget | ImageUnitTarget
export type NormalTranslationTarget = NormalTranslationMaterialTarget | NormalTranslationUnitTarget
export type DirectTranslationTarget = NormalTranslationTarget | ImageUnitTarget
export interface NormalTranslationSourceCorrection {
  readonly target: NormalTranslationUnitTarget
  readonly operationId: string
  readonly sourceText: string
  readonly reason: string
}
/** `uiLocale` is the submitting Client's interface locale; the Host uses it only for the notice's reply-language line. */
export interface NormalTranslationUnitRequest { readonly target: NormalTranslationUnitTarget; readonly operationId: string; readonly uiLocale?: string; readonly fileName?: string }
export interface DirectUnitRequest extends Omit<NormalTranslationUnitRequest, 'target'> { readonly target: DirectUnitTarget }
export interface NormalTranslationUnitReceipt extends DirectUnitRequest { readonly status: 'submitted' }
export interface NormalTranslationCorrectionReceipt {
  readonly operationId: string
  readonly mainSessionId: string
  readonly translationSessionId: string
  readonly unitId: string
  readonly previousSourceVersion: number
  readonly sourceVersion: number
  readonly persistence: 'saved' | 'runtime_only'
}
export interface NormalTranslationTermReference { readonly id: string; readonly entryVersion: number }
/** A short handle returned by a term query; only the direct path resolves it, and never beyond the issuing main Session. */
export interface DirectTermHandleReference { readonly termRef: string }
export type DirectTermReference = NormalTranslationTermReference | DirectTermHandleReference
/** Parsed direct request: term references may still be handles until the Host resolves them. */
export interface RawDirectTranslationRequest extends Omit<DirectTranslationRequest, 'termReferences'> {
  readonly termReferences: readonly DirectTermReference[]
}
export interface NormalTranslationExecute {
  readonly target: NormalTranslationTarget
  /** Independent of the submission id and of each eventual model call id. */
  readonly operationId: string
  readonly organizedRequirements: string
  readonly termReferences: readonly NormalTranslationTermReference[]
  readonly referenceContextRef?: ReferenceContextRef
}
export interface NormalTranslationAcceptance {
  readonly envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }>
  readonly operationId: string
  readonly targetLanguage?: string
  readonly organizedRequirements: string
  readonly termReferences: readonly NormalTranslationTermReference[]
  readonly referenceContextRef?: ReferenceContextRef
  readonly range?: DirectTranslationRange
  readonly body?: boolean
  readonly contextSupplement?: DirectContextSupplement
}
export interface DirectTranslationDraftTerm {
  readonly sourceForms: readonly string[]
  readonly preferred: string
  readonly forbidden: readonly string[]
  readonly sense: string
}
/** Draft candidates share the worker payload shape but never carry user authority. */
export function draftTranslationTerms(draft: readonly DirectTranslationDraftTerm[] | undefined): readonly NormalTranslationTerm[] {
  return (draft ?? []).map((term, index) => ({ id: `draft:${index + 1}`, entryVersion: 1, sourceForms: [...term.sourceForms], aliases: [],
    sense: term.sense, preferred: term.preferred, forbidden: [...term.forbidden], userFixed: false, priority: 0 }))
}
/**
 * One direct short-text call: the translation model runs once and the main model must review the
 * returned body. Requirements, the model's own notes and auxiliary context stay distinct.
 * `range` asks the Host to read that exact frozen source interval of a text file; `body` supplies
 * a main-model-organized body for a non-text original (for example extracted PDF or image text).
 */
export interface DirectTranslationRequest {
  readonly target: DirectTranslationTarget
  readonly operationId: string
  readonly targetLanguage?: string
  /** Verbatim user requirements for this task; never a model paraphrase. */
  readonly userRequirements: string
  /** The main model's own organization for this call only. */
  readonly organizedNotes: string
  /** Background that helps understanding and must not be translated; never empty when present. */
  readonly auxiliaryContext: string
  readonly termReferences: readonly NormalTranslationTermReference[]
  readonly referenceContextRef?: ReferenceContextRef
  readonly range?: DirectTranslationRange
  readonly body?: string
  /** Main-model integrated candidates for this call; authority 0, never formal memory. */
  readonly draftTerms?: readonly DirectTranslationDraftTerm[]
  readonly contextResponse?: DirectContextResponse
}
export interface DirectTranslationRange { readonly start: number; readonly end: number }

export const MAX_DIRECT_RESULT_EDITS = 100
export interface DirectResultPatch {
  readonly target: NormalTranslationUnitTarget
  readonly baseRevisionId: string
  readonly operationId: string
  readonly edits: readonly ExactTextEdit[]
}
export interface DirectResultPatchReceipt {
  readonly target: NormalTranslationUnitTarget
  readonly baseRevisionId: string
  readonly operationId: string
  readonly revisionId: string
  readonly revisionNumber: number
  readonly editCount: number
}
/** The Client writes the admitted unit and its completed body in one transaction. */
export interface DirectTranslationCommit {
  readonly envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }>
  readonly operationId: string
  readonly targetLanguage?: string
  readonly userRequirements: string
  readonly organizedNotes: string
  readonly auxiliaryContext: string
  readonly termReferences: readonly NormalTranslationTermReference[]
  readonly revisionId: string
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly text: string
  readonly message: string
  readonly callRecord: TranslationCallMetadata
  readonly referenceContextRef?: ReferenceContextRef
  /** The exact source body this call translated when the material has no inline short text. */
  readonly sourceText?: string
  readonly range?: DirectTranslationRange
  /** The body was extracted and organized by the main model, not read from the frozen original. */
  readonly body?: boolean
  readonly draftTerms?: readonly DirectTranslationDraftTerm[]
  readonly contextSupplement?: DirectContextSupplement
}
export interface DirectTranslationReceipt {
  readonly operationId: string
  readonly mainSessionId: string
  readonly translationSessionId: string
  readonly topicId: string
  readonly unitId: string
  readonly revisionId: string
  readonly targetLanguage?: string
  readonly sourceVersion?: number | undefined
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly textCodePoints: number
  readonly persistence: 'saved' | 'runtime_only'
}
export interface NormalTranslationResultRead {
  readonly operationId: string
  readonly range: { readonly start: number; readonly end: number }
}
export interface NormalTranslationOperation {
  readonly operationId: string
  readonly mainSessionId: string
  readonly topicId: string
  readonly translationSessionId: string
  readonly materialId: string
  readonly unitId: string
  readonly sourceVersion: number
  readonly draftVersion: number
  readonly status: 'accepted' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  readonly persistence: 'saved' | 'runtime_only'
}
export interface NormalTranslationQuery {
  readonly mainSessionId: string
  readonly translationSessionId: string
  readonly operationId: string
  readonly afterSequence: number
}
export interface NormalTranslationError { readonly code: string; readonly message: string; readonly stage: string }
export interface NormalTranslationUpdate {
  readonly mainSessionId: string
  readonly translationSessionId: string
  readonly unitId: string
  readonly operationId: string
  readonly sourceVersion: number
  readonly callId: string | null
  readonly sequence: number
  readonly status: Exclude<NormalTranslationOperation['status'], 'accepted'>
  readonly textDelta: string
  readonly metadata: TranslationCallMetadata | null
  readonly error: NormalTranslationError | null
}
export interface NormalTranslationJob {
  readonly operation: NormalTranslationOperation | null
  readonly callId: string | null
  readonly status: 'preparing' | NormalTranslationOperation['status']
  readonly updates: readonly NormalTranslationUpdate[]
  readonly lastSequence: number
  readonly more: boolean
  readonly error: NormalTranslationError | null
}
export interface NormalTranslationCapability { readonly ready: boolean; readonly reason?: string; readonly storage: 'runtime_only'; readonly mode: 'normal' }
export type NormalTranslationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: NormalTranslationError }

type Data = Record<string, unknown>
function object(value: unknown): asserts value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected normal translation object')
}
function exact(value: Data, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) throw new TypeError('Unexpected normal translation fields')
}
function text(value: unknown, maximum = 2048, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || Array.from(value).length > maximum) throw new TypeError('Invalid normal translation text')
}
function version(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError('Invalid normal translation version')
}
export function parseDirectTranslationTarget(value: unknown): DirectTranslationTarget {
  object(value)
  if (value.kind === 'material') {
    exact(value, ['kind', 'mainSessionId', 'requestId', 'materialId', 'sourceVersion']); text(value.requestId); text(value.materialId)
  } else if (value.kind === 'unit' || value.kind === 'image_unit') {
    exact(value, ['kind', 'mainSessionId', 'translationSessionId', 'unitId', ...(value.kind === 'unit' ? ['sourceVersion'] : [])]); text(value.translationSessionId); text(value.unitId)
  } else throw new TypeError('Unsupported normal translation target')
  text(value.mainSessionId); if (value.kind !== 'image_unit') version(value.sourceVersion)
  return structuredClone(value) as unknown as DirectTranslationTarget
}
export function parseNormalTranslationTarget(value: unknown): NormalTranslationTarget {
  const target = parseDirectTranslationTarget(value)
  if (target.kind === 'image_unit') throw new TypeError('Use direct translation for an image unit')
  return target
}
export function parseImageUnitUpdate(value: unknown): ImageUnitUpdate {
  object(value)
  exact(value, ['target', 'operationId', ...['sourceText', 'backgroundDescription'].filter(field => Object.hasOwn(value, field))])
  const target = parseDirectTranslationTarget(value.target)
  if (target.kind !== 'image_unit' || value.sourceText === undefined && value.backgroundDescription === undefined) throw new TypeError('An image unit update needs text or background')
  text(value.operationId)
  if (value.sourceText !== undefined) text(value.sourceText, 200000, true)
  if (value.backgroundDescription !== undefined) text(value.backgroundDescription, IMAGE_BACKGROUND_LIMIT, true)
  return { target, operationId: value.operationId, ...(value.sourceText === undefined ? {} : { sourceText: value.sourceText }),
    ...(value.backgroundDescription === undefined ? {} : { backgroundDescription: value.backgroundDescription }) }
}
export function parseNormalTranslationSourceCorrection(value: unknown): NormalTranslationSourceCorrection {
  object(value); exact(value, ['target', 'operationId', 'sourceText', 'reason'])
  const target = parseNormalTranslationTarget(value.target)
  if (target.kind !== 'unit') throw new TypeError('Source correction requires a unit')
  text(value.operationId); text(value.sourceText, 200000); text(value.reason, 1000, true)
  return { target, operationId: value.operationId, sourceText: value.sourceText, reason: value.reason }
}
export function parseDirectResultPatch(value: unknown): DirectResultPatch {
  object(value); exact(value, ['target', 'baseRevisionId', 'operationId', 'edits'])
  const target = parseDirectTranslationTarget(value.target)
  if (target.kind !== 'unit') throw new TypeError('Result patch requires a versioned text unit')
  text(value.baseRevisionId); text(value.operationId)
  if (!Array.isArray(value.edits) || !value.edits.length || value.edits.length > MAX_DIRECT_RESULT_EDITS) {
    throw new TypeError(`edits must contain 1 to ${MAX_DIRECT_RESULT_EDITS} exact replacements`)
  }
  const edits = value.edits.map(edit => {
    object(edit); exact(edit, ['from', 'to'])
    text(edit.from, 2_000_000, true); text(edit.to, 2_000_000, true)
    if (!edit.from.length || edit.from === edit.to) throw new TypeError('Each edit must change a nonempty from fragment')
    return { from: edit.from, to: edit.to }
  })
  return { target, baseRevisionId: value.baseRevisionId, operationId: value.operationId, edits }
}
export function parseDirectResultPatchReceipt(value: unknown): DirectResultPatchReceipt {
  object(value); exact(value, ['target', 'baseRevisionId', 'operationId', 'revisionId', 'revisionNumber', 'editCount'])
  const target = parseDirectTranslationTarget(value.target)
  if (target.kind !== 'unit') throw new TypeError('Result patch receipt requires a versioned text unit')
  text(value.baseRevisionId); text(value.operationId); text(value.revisionId)
  version(value.revisionNumber); version(value.editCount)
  if (value.editCount > MAX_DIRECT_RESULT_EDITS) throw new TypeError('Invalid result patch edit count')
  return { target, baseRevisionId: value.baseRevisionId, operationId: value.operationId, revisionId: value.revisionId,
    revisionNumber: value.revisionNumber, editCount: value.editCount }
}
export function parseDirectUnitRequest(value: unknown): DirectUnitRequest {
  object(value); exact(value, ['target', 'operationId', ...(Object.hasOwn(value, 'uiLocale') ? ['uiLocale'] : []), ...(Object.hasOwn(value, 'fileName') ? ['fileName'] : [])]); text(value.operationId)
  if (value.uiLocale !== undefined) text(value.uiLocale, 64)
  if (value.fileName !== undefined) text(value.fileName, 512)
  const target = parseDirectTranslationTarget(value.target)
  if (target.kind === 'material') throw new TypeError('Retranslation requires a unit')
  return { target, operationId: value.operationId, ...(value.uiLocale === undefined ? {} : { uiLocale: value.uiLocale }), ...(value.fileName === undefined ? {} : { fileName: value.fileName }) }
}
export function parseNormalTranslationUnitRequest(value: unknown): NormalTranslationUnitRequest {
  const request = parseDirectUnitRequest(value)
  if (request.target.kind !== 'unit') throw new TypeError('This request requires a versioned unit')
  return { ...request, target: request.target }
}
export function parseNormalTranslationCorrectionReceipt(value: unknown): NormalTranslationCorrectionReceipt {
  object(value); exact(value, ['operationId', 'mainSessionId', 'translationSessionId', 'unitId', 'previousSourceVersion', 'sourceVersion', 'persistence'])
  for (const field of ['operationId', 'mainSessionId', 'translationSessionId', 'unitId']) text(value[field])
  version(value.previousSourceVersion); version(value.sourceVersion)
  if (value.sourceVersion !== (value.previousSourceVersion as number) + 1 || !['saved', 'runtime_only'].includes(value.persistence as string)) throw new TypeError('Invalid source correction receipt')
  return structuredClone(value) as unknown as NormalTranslationCorrectionReceipt
}
function references(value: unknown): asserts value is readonly NormalTranslationTermReference[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError('Invalid normal translation term references')
  const ids = new Set<string>()
  for (const ref of value) {
    object(ref); exact(ref, ['id', 'entryVersion']); text(ref.id); version(ref.entryVersion)
    if (ids.has(ref.id)) throw new TypeError('Duplicate normal translation term reference')
    ids.add(ref.id)
  }
}
/** The direct path also accepts a query-issued handle; ids stay unique once the Host resolves handles. */
function directReferences(value: unknown): asserts value is readonly DirectTermReference[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError('Invalid normal translation term references')
  const keys = new Set<string>()
  for (const ref of value) {
    object(ref)
    if (Object.hasOwn(ref, 'termRef')) {
      exact(ref, ['termRef']); text(ref.termRef)
      if (keys.has(`term:${ref.termRef}`)) throw new TypeError('Duplicate normal translation term reference')
      keys.add(`term:${ref.termRef}`)
      continue
    }
    exact(ref, ['id', 'entryVersion']); text(ref.id); version(ref.entryVersion)
    if (keys.has(`id:${ref.id}`)) throw new TypeError('Duplicate normal translation term reference')
    keys.add(`id:${ref.id}`)
  }
}
export function parseNormalTranslationExecute(value: unknown): NormalTranslationExecute {
  object(value); exact(value, ['target', 'operationId', 'organizedRequirements', 'termReferences', ...(Object.hasOwn(value,'referenceContextRef') ? ['referenceContextRef'] : [])])
  const target = parseNormalTranslationTarget(value.target)
  text(value.operationId); text(value.organizedRequirements, 4000, true); references(value.termReferences)
  return { target, operationId: value.operationId, organizedRequirements: value.organizedRequirements, termReferences: structuredClone(value.termReferences), ...(value.referenceContextRef === undefined ? {} : {referenceContextRef: parseReferenceContextRef(value.referenceContextRef)}) }
}
function parseDraftTerms(value: unknown): readonly DirectTranslationDraftTerm[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 50) throw new TypeError('Invalid draft terminology')
  return value.map((term): DirectTranslationDraftTerm => {
    object(term)
    const optional = ['forbidden', 'sense'].filter(field => Object.hasOwn(term, field))
    exact(term, ['sourceForms', 'preferred', ...optional])
    if (!Array.isArray(term.sourceForms) || term.sourceForms.length === 0 || term.sourceForms.length > 5) throw new TypeError('Invalid draft terminology source forms')
    const sourceForms = term.sourceForms.map(form => { text(form, 200); return form as string })
    text(term.preferred, 200)
    const forbidden = term.forbidden ?? []
    if (!Array.isArray(forbidden) || forbidden.length > 10) throw new TypeError('Invalid draft terminology forbidden forms')
    forbidden.forEach(form => text(form, 200))
    const sense = term.sense ?? ''
    text(sense, 1000, true)
    return { sourceForms, preferred: term.preferred, forbidden: forbidden as string[], sense: sense as string }
  })
}
export const DIRECT_REQUIREMENTS_CODE_POINTS = 4000
export const DIRECT_AUXILIARY_CONTEXT_CODE_POINTS = 8000

function directInputText(field: string, value: unknown, limit: number): asserts value is string {
  if (typeof value !== 'string' || Array.from(value).length > limit) {
    throw new TypeError(`${field} must be a string of at most ${limit} Unicode code points`)
  }
}

export function parseDirectTargetLanguage(value: unknown): string {
  text(value, 80)
  return value.trim()
}

export function parseDirectTranslationRequest(value: unknown): RawDirectTranslationRequest {
  object(value)
  // Omitted optional inputs mean "none"; a model never has to serialize an empty string or array.
  const optional = ['targetLanguage', 'organizedNotes', 'auxiliaryContext', 'userRequirements', 'termReferences', 'range', 'body', 'draftTerms', 'contextResponse'].filter(field => Object.hasOwn(value, field))
  exact(value, ['target', 'operationId', ...optional,
    ...(Object.hasOwn(value, 'referenceContextRef') ? ['referenceContextRef'] : [])])
  const target = parseDirectTranslationTarget(value.target)
  text(value.operationId)
  const organizedNotes = value.organizedNotes ?? '', auxiliaryContext = value.auxiliaryContext ?? ''
  const userRequirements = value.userRequirements ?? '', termReferences = value.termReferences ?? []
  directInputText('userRequirements', userRequirements, DIRECT_REQUIREMENTS_CODE_POINTS)
  directInputText('organizedNotes', organizedNotes, DIRECT_REQUIREMENTS_CODE_POINTS)
  directInputText('auxiliaryContext', auxiliaryContext, DIRECT_AUXILIARY_CONTEXT_CODE_POINTS)
  directReferences(termReferences)
  const range = value.range === undefined ? undefined : parseDirectRange(value.range)
  if (value.body !== undefined) text(value.body, 2_000_000)
  const draftTerms = parseDraftTerms(value.draftTerms)
  const contextResponse = value.contextResponse === undefined ? undefined : parseDirectContextResponse(value.contextResponse)
  if (contextResponse?.operationId === value.operationId) throw new TypeError('A context response requires a new operation id')
  if (range && value.body !== undefined) throw new TypeError('A direct call takes either a frozen range or an organized body, not both')
  if (target.kind !== 'material' && (range || value.body !== undefined)) throw new TypeError('Unit calls have no range or replacement body')
  return { target, operationId: value.operationId, userRequirements, organizedNotes, auxiliaryContext,
    ...(value.targetLanguage === undefined ? {} : { targetLanguage: parseDirectTargetLanguage(value.targetLanguage) }),
    termReferences: structuredClone(termReferences), ...(range ? { range } : {}), ...(value.body === undefined ? {} : { body: value.body as string }),
    ...(draftTerms === undefined ? {} : { draftTerms }),
    ...(contextResponse === undefined ? {} : { contextResponse }),
    ...(value.referenceContextRef === undefined ? {} : { referenceContextRef: parseReferenceContextRef(value.referenceContextRef) }) }
}
function parseDirectRange(value: unknown): DirectTranslationRange {
  object(value); exact(value, ['start', 'end'])
  const { start, end } = value
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number) || (end as number) - (start as number) > 2_000_000) {
    throw new TypeError('A source range must be a nonempty Unicode code point interval [start, end)')
  }
  return { start: start as number, end: end as number }
}
export function parseDirectTranslationCommit(value: unknown): DirectTranslationCommit {
  object(value)
  const optional = ['targetLanguage', 'organizedNotes', 'auxiliaryContext', 'range', 'sourceText', 'body', 'draftTerms', 'contextSupplement'].filter(field => Object.hasOwn(value, field))
  exact(value, ['envelope', 'operationId', 'userRequirements', 'termReferences', 'revisionId', 'status', 'text', 'message', 'callRecord', ...optional,
    ...(Object.hasOwn(value, 'referenceContextRef') ? ['referenceContextRef'] : [])])
  const envelope = parseTranslationMaterialEnvelope(value.envelope)
  if (envelope.kind !== 'material') throw new TypeError('Direct translation requires material')
  text(value.operationId); text(value.revisionId); text(value.message, 1000, true)
  directInputText('userRequirements', value.userRequirements, DIRECT_REQUIREMENTS_CODE_POINTS)
  references(value.termReferences)
  if (!['completed', 'failed', 'cancelled'].includes(value.status as string)) throw new TypeError('Invalid direct translation status')
  text(value.text, 2_000_000, true)
  if (value.status === 'completed' && !(value.text as string).trim()) throw new TypeError('Completed translation requires a body')
  const organizedNotes = value.organizedNotes ?? '', auxiliaryContext = value.auxiliaryContext ?? ''
  directInputText('organizedNotes', organizedNotes, DIRECT_REQUIREMENTS_CODE_POINTS)
  directInputText('auxiliaryContext', auxiliaryContext, DIRECT_AUXILIARY_CONTEXT_CODE_POINTS)
  const range = value.range === undefined ? undefined : parseDirectRange(value.range)
  const body = value.body === true
  if (value.body !== undefined && typeof value.body !== 'boolean') throw new TypeError('Invalid organized body flag')
  const draftTerms = parseDraftTerms(value.draftTerms)
  if (body && range) throw new TypeError('An organized body has no frozen source range')
  if (range) {
    const total = envelope.material.sourceRef?.totalCodePoints
    if (!total || range.end > total) throw new TypeError('A source range must stay inside the frozen original')
  }
  if (value.sourceText !== undefined) {
    text(value.sourceText, 2_000_000)
    if (range && Array.from(value.sourceText as string).length !== range.end - range.start) throw new TypeError('Source batch length does not match its range')
  }
  // A file material has no inline text: the Client can only admit the unit when it receives the exact body.
  if (envelope.material.sourceText === undefined && value.sourceText === undefined) throw new TypeError('File results require the exact source body')
  if (envelope.material.sourceText === undefined && !range && !body) throw new TypeError('File results require a source range or an organized body flag')
  return { envelope, operationId: value.operationId, userRequirements: value.userRequirements, organizedNotes, auxiliaryContext,
    ...(value.targetLanguage === undefined ? {} : { targetLanguage: parseDirectTargetLanguage(value.targetLanguage) }),
    termReferences: structuredClone(value.termReferences), revisionId: value.revisionId,
    status: value.status as DirectTranslationCommit['status'], text: value.text, message: value.message,
    callRecord: parseTranslationCallMetadata(value.callRecord), ...(range ? { range } : {}), ...(body ? { body: true } : {}),
    ...(value.contextSupplement === undefined ? {} : { contextSupplement: parseDirectContextSupplement(value.contextSupplement,
      Array.from(value.sourceText as string ?? envelope.material.sourceText ?? '').length) }),
    ...(draftTerms === undefined ? {} : { draftTerms }),
    ...(value.sourceText === undefined ? {} : { sourceText: value.sourceText as string }),
    ...(value.referenceContextRef === undefined ? {} : { referenceContextRef: parseReferenceContextRef(value.referenceContextRef) }) }
}
export function parseDirectTranslationReceipt(value: unknown): DirectTranslationReceipt {
  object(value)
  exact(value, ['operationId', 'mainSessionId', 'translationSessionId', 'topicId', 'unitId', 'revisionId', ...['sourceVersion', 'targetLanguage'].filter(field => Object.hasOwn(value, field)), 'status', 'textCodePoints', 'persistence'])
  if (value.targetLanguage !== undefined) parseDirectTargetLanguage(value.targetLanguage)
  for (const field of ['operationId', 'mainSessionId', 'translationSessionId', 'topicId', 'unitId', 'revisionId']) text(value[field])
  if (Object.hasOwn(value, 'sourceVersion')) version(value.sourceVersion)
  if (!Number.isSafeInteger(value.textCodePoints) || (value.textCodePoints as number) < 0) throw new TypeError('Invalid direct translation length')
  if (!['completed', 'failed', 'cancelled'].includes(value.status as string) || !['saved', 'runtime_only'].includes(value.persistence as string)) throw new TypeError('Invalid direct translation receipt')
  return structuredClone(value) as unknown as DirectTranslationReceipt
}
/** Exact current result of one material: one full unit, or contiguous range segments in source order. */
export interface NormalTranslationExportSegment {
  readonly unitId: string
  readonly range: DirectTranslationRange | null
  readonly revisionId: string
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly text: string
}
export interface NormalTranslationExport {
  readonly mainSessionId: string
  readonly translationSessionId: string
  readonly topicId: string
  readonly materialId: string | null
  readonly sourceVersion?: number
  readonly totalCodePoints: number
  readonly complete: boolean
  readonly segments: readonly NormalTranslationExportSegment[]
  readonly missing: readonly DirectTranslationRange[]
  readonly overlapping: readonly DirectTranslationRange[]
  readonly originalFilePath?: string
}
export function parseDirectTranslationExport(value: unknown): NormalTranslationExport {
  object(value)
  exact(value, ['mainSessionId', 'translationSessionId', 'topicId', 'materialId', ...(Object.hasOwn(value, 'sourceVersion') ? ['sourceVersion'] : []), 'totalCodePoints', 'complete', 'segments', 'missing', 'overlapping', ...(Object.hasOwn(value, 'originalFilePath') ? ['originalFilePath'] : [])])
  const mainSessionId = value.mainSessionId, translationSessionId = value.translationSessionId
  const topicId = value.topicId, materialId = value.materialId, sourceVersion = value.sourceVersion
  const totalCodePoints = value.totalCodePoints, complete = value.complete
  text(mainSessionId); text(translationSessionId); text(topicId)
  if (materialId !== null) text(materialId)
  if (Object.hasOwn(value, 'sourceVersion')) version(sourceVersion)
  if (!Number.isSafeInteger(totalCodePoints) || (totalCodePoints as number) < 0) throw new TypeError('Invalid export length')
  if (typeof complete !== 'boolean') throw new TypeError('Invalid export completeness')
  if (!Array.isArray(value.segments) || value.segments.length > 200 || !Array.isArray(value.missing) || value.missing.length > 200 || !Array.isArray(value.overlapping) || value.overlapping.length > 200) throw new TypeError('Invalid export segments')
  const segments = value.segments.map((segment): NormalTranslationExportSegment => {
    object(segment); exact(segment, ['unitId', 'range', 'revisionId', 'status', 'text'])
    text(segment.unitId); text(segment.revisionId); text(segment.text, 2_000_000, true)
    if (!['completed', 'failed', 'cancelled'].includes(segment.status as string)) throw new TypeError('Invalid export revision status')
    return { unitId: segment.unitId, range: segment.range === null ? null : parseDirectRange(segment.range), revisionId: segment.revisionId,
      status: segment.status as NormalTranslationExportSegment['status'], text: segment.text }
  })
  return { mainSessionId, translationSessionId, topicId, materialId, ...(sourceVersion === undefined ? {} : { sourceVersion: sourceVersion as number }),
    totalCodePoints: totalCodePoints as number, complete, segments, missing: value.missing.map(range => parseDirectRange(range)),
    overlapping: value.overlapping.map(range => parseDirectRange(range)),
    ...(value.originalFilePath === undefined ? {} : { originalFilePath: parseOriginalFilePath(value.originalFilePath) }) }
}
export function parseNormalTranslationResultRead(value: unknown): NormalTranslationResultRead {
  object(value); exact(value, ['operationId', 'range']); text(value.operationId)
  object(value.range); exact(value.range, ['start', 'end'])
  const { start, end } = value.range
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number)) {
    throw Object.assign(new TypeError('Result range must be a nonempty Unicode code point interval [start, end).'), { code: 'invalid_range' })
  }
  return { operationId: value.operationId, range: { start: start as number, end: end as number } }
}
export function parseNormalTranslationAcceptance(value: unknown): NormalTranslationAcceptance {
  object(value); exact(value, ['envelope', 'operationId', 'organizedRequirements', 'termReferences', ...['targetLanguage', 'referenceContextRef', 'range', 'body', 'contextSupplement'].filter(field => Object.hasOwn(value, field))])
  const envelope = parseTranslationMaterialEnvelope(value.envelope)
  if (envelope.kind !== 'material') throw new TypeError('Normal translation requires material')
  text(value.operationId); text(value.organizedRequirements, 4000, true); references(value.termReferences)
  const range = value.range === undefined ? undefined : parseDirectRange(value.range)
  if (value.body !== undefined && typeof value.body !== 'boolean' || range && value.body) throw new TypeError('Invalid direct preparation source')
  if ((range || value.body) && !envelope.material.sourceRef) throw new TypeError('Direct preparation range or body requires a file')
  if (range && range.end > envelope.material.sourceRef!.totalCodePoints) throw new TypeError('Direct preparation range exceeds the frozen file')
  return { envelope, operationId: value.operationId, organizedRequirements: value.organizedRequirements, termReferences: structuredClone(value.termReferences),
    ...(value.targetLanguage === undefined ? {} : { targetLanguage: parseDirectTargetLanguage(value.targetLanguage) }),
    ...(range ? { range } : {}), ...(value.body === undefined ? {} : { body: value.body }),
    ...(value.contextSupplement === undefined ? {} : { contextSupplement: parseDirectContextSupplement(value.contextSupplement) }),
    ...(value.referenceContextRef === undefined ? {} : {referenceContextRef: parseReferenceContextRef(value.referenceContextRef)}) }
}
export function parseNormalTranslationOperation(value: unknown): NormalTranslationOperation {
  object(value); exact(value, ['operationId', 'mainSessionId', 'topicId', 'translationSessionId', 'materialId', 'unitId', 'sourceVersion', 'draftVersion', 'status', 'persistence'])
  for (const field of ['operationId', 'mainSessionId', 'topicId', 'translationSessionId', 'materialId', 'unitId']) text(value[field])
  version(value.sourceVersion); version(value.draftVersion)
  if (!['accepted', 'running', 'completed', 'failed', 'cancelled', 'unknown'].includes(value.status as string) || !['saved', 'runtime_only'].includes(value.persistence as string)) throw new TypeError('Invalid normal translation operation state')
  return structuredClone(value) as unknown as NormalTranslationOperation
}
export function parseNormalTranslationQuery(value: unknown): NormalTranslationQuery {
  object(value); exact(value, ['mainSessionId', 'translationSessionId', 'operationId', 'afterSequence'])
  text(value.mainSessionId); text(value.translationSessionId); text(value.operationId)
  if (!Number.isSafeInteger(value.afterSequence) || (value.afterSequence as number) < 0) throw new TypeError('Invalid normal translation cursor')
  return structuredClone(value) as unknown as NormalTranslationQuery
}
function parseError(value: unknown): NormalTranslationError {
  object(value); exact(value, ['code', 'message', 'stage']); text(value.code, 80); text(value.message, 1000); text(value.stage, 80)
  return structuredClone(value) as unknown as NormalTranslationError
}
export function parseNormalTranslationUpdate(value: unknown): NormalTranslationUpdate {
  object(value); exact(value, ['mainSessionId', 'translationSessionId', 'unitId', 'operationId', 'sourceVersion', 'callId', 'sequence', 'status', 'textDelta', 'metadata', 'error'])
  for (const field of ['mainSessionId', 'translationSessionId', 'unitId', 'operationId']) text(value[field])
  if (value.callId !== null) text(value.callId)
  version(value.sourceVersion); version(value.sequence); text(value.textDelta, 8192, true)
  if (!['running', 'completed', 'failed', 'cancelled', 'unknown'].includes(value.status as string)) throw new TypeError('Invalid normal translation update state')
  const metadata = value.metadata === null ? null : parseTranslationCallMetadata(value.metadata)
  if (value.callId === null && (value.status === 'running' || value.status === 'completed' || value.textDelta !== '' || metadata !== null)) throw new TypeError('Unstarted operation cannot contain a model revision')
  if (metadata && !isNormalTranslationPromptVersion(metadata.promptVersion)) throw new TypeError('Normal translation requires its own prompt')
  const error = value.error === null ? null : parseError(value.error)
  return { ...structuredClone(value), metadata, error } as unknown as NormalTranslationUpdate
}
export function parseNormalTranslationJob(value: unknown): NormalTranslationJob {
  object(value); exact(value, ['operation', 'callId', 'status', 'updates', 'lastSequence', 'more', 'error'])
  const operation = value.operation === null ? null : parseNormalTranslationOperation(value.operation)
  if (value.callId !== null) text(value.callId)
  if (!['preparing', 'accepted', 'running', 'completed', 'failed', 'cancelled', 'unknown'].includes(value.status as string) || !Array.isArray(value.updates) || typeof value.more !== 'boolean' || !Number.isSafeInteger(value.lastSequence) || (value.lastSequence as number) < 0) throw new TypeError('Invalid normal translation job')
  const updates = value.updates.map(parseNormalTranslationUpdate)
  if (updates.some((update, index) => !operation || update.operationId !== operation.operationId || update.mainSessionId !== operation.mainSessionId ||
    update.translationSessionId !== operation.translationSessionId || update.unitId !== operation.unitId || update.sourceVersion !== operation.sourceVersion ||
    (update.callId !== null && update.callId !== value.callId) || update.sequence > (value.lastSequence as number) || (index > 0 && update.sequence !== updates[index - 1]!.sequence + 1))) throw new TypeError('Invalid normal translation job events')
  return { operation, callId: value.callId as string | null, status: value.status as NormalTranslationJob['status'], updates,
    lastSequence: value.lastSequence as number, more: value.more, error: value.error === null ? null : parseError(value.error) }
}
function parseResult(method: 'capabilities' | 'status' | 'cancel' | 'requestUnit', value: unknown): unknown {
  object(value)
  if (value.ok === false) { exact(value, ['ok', 'error']); return { ok: false, error: parseError(value.error) } }
  if (value.ok !== true) throw new TypeError('Invalid normal translation result')
  exact(value, ['ok', 'value'])
  if (method === 'requestUnit') {
    object(value.value); exact(value.value, ['target', 'operationId', 'status'])
    if (value.value.status !== 'submitted') throw new TypeError('Invalid unit submission state')
    return { ok: true, value: { ...parseDirectUnitRequest({ target: value.value.target, operationId: value.value.operationId }), status: 'submitted' } }
  }
  if (method !== 'capabilities') return { ok: true, value: parseNormalTranslationJob(value.value) }
  object(value.value)
  const capability = value.value
  if (Object.keys(capability).some(field => !['ready', 'reason', 'storage', 'mode'].includes(field)) || typeof capability.ready !== 'boolean' || capability.storage !== 'runtime_only' || capability.mode !== 'normal') throw new TypeError('Invalid normal translation capability')
  if (capability.reason !== undefined) text(capability.reason, 1000)
  return structuredClone(value)
}
const packageName = 'dsh-translation-plugin'
export const NORMAL_TRANSLATION_REMOTE = { package: packageName, descriptors: [...(['capabilities', 'status', 'cancel', 'requestUnit'] as const).map(method => ({
  id: `${packageName}#translationNormal/${method}`, service: 'translationNormal', namespace: 'translationNormal', method,
  invocation: { kind: 'direct' as const }, parameters: method === 'capabilities' ? [] : [{ name: 'request', wire: 'request', source: 'json' as const,
    codec: { mode: 'strict' as const, typeSymbol: `${packageName}#normal/${method}Request`, create: () => ({ parse: (value: unknown) => method === 'requestUnit' ? parseDirectUnitRequest(value) : parseNormalTranslationQuery(value) }) } }],
  result: { mode: 'strict' as const, typeSymbol: `${packageName}#normal/${method}Result`, create: () => ({ parse: (value: unknown) => parseResult(method, value) }) },
})), ...TRANSLATION_LOG_REMOTE.descriptors] }
