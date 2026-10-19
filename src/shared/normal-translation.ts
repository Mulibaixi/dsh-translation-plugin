import { parseReferenceContextRef, type ReferenceContextRef } from './reference-memory.js'
import { parseTranslationMaterialEnvelope, type TranslationMaterialEnvelope } from './translation-material.js'
import { isNormalTranslationPromptVersion, parseTranslationCallMetadata, type TranslationCallMetadata } from './translation-call.js'

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
export type NormalTranslationTarget = NormalTranslationMaterialTarget | NormalTranslationUnitTarget
export interface NormalTranslationSourceCorrection {
  readonly target: NormalTranslationUnitTarget
  readonly operationId: string
  readonly sourceText: string
  readonly reason: string
}
/** `uiLocale` is the submitting Client's interface locale; the Host uses it only for the notice's reply-language line. */
export interface NormalTranslationUnitRequest { readonly target: NormalTranslationUnitTarget; readonly operationId: string; readonly uiLocale?: string }
export interface NormalTranslationUnitReceipt extends NormalTranslationUnitRequest { readonly status: 'submitted' }
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
  readonly organizedRequirements: string
  readonly termReferences: readonly NormalTranslationTermReference[]
  readonly referenceContextRef?: ReferenceContextRef
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
export function parseNormalTranslationTarget(value: unknown): NormalTranslationTarget {
  object(value)
  if (value.kind === 'material') {
    exact(value, ['kind', 'mainSessionId', 'requestId', 'materialId', 'sourceVersion']); text(value.requestId); text(value.materialId)
  } else if (value.kind === 'unit') {
    exact(value, ['kind', 'mainSessionId', 'translationSessionId', 'unitId', 'sourceVersion']); text(value.translationSessionId); text(value.unitId)
  } else throw new TypeError('Unsupported normal translation target')
  text(value.mainSessionId); version(value.sourceVersion)
  return structuredClone(value) as unknown as NormalTranslationTarget
}
export function parseNormalTranslationSourceCorrection(value: unknown): NormalTranslationSourceCorrection {
  object(value); exact(value, ['target', 'operationId', 'sourceText', 'reason'])
  const target = parseNormalTranslationTarget(value.target)
  if (target.kind !== 'unit') throw new TypeError('Source correction requires a unit')
  text(value.operationId); text(value.sourceText, 200000); text(value.reason, 1000, true)
  return { target, operationId: value.operationId, sourceText: value.sourceText, reason: value.reason }
}
export function parseNormalTranslationUnitRequest(value: unknown): NormalTranslationUnitRequest {
  object(value); exact(value, ['target', 'operationId', ...(Object.hasOwn(value, 'uiLocale') ? ['uiLocale'] : [])]); text(value.operationId)
  if (value.uiLocale !== undefined) text(value.uiLocale, 64)
  const target = parseNormalTranslationTarget(value.target)
  if (target.kind !== 'unit') throw new TypeError('Retranslation requires a unit')
  return { target, operationId: value.operationId, ...(value.uiLocale === undefined ? {} : { uiLocale: value.uiLocale }) }
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
export function parseNormalTranslationExecute(value: unknown): NormalTranslationExecute {
  object(value); exact(value, ['target', 'operationId', 'organizedRequirements', 'termReferences', ...(Object.hasOwn(value,'referenceContextRef') ? ['referenceContextRef'] : [])])
  const target = parseNormalTranslationTarget(value.target)
  text(value.operationId); text(value.organizedRequirements, 4000, true); references(value.termReferences)
  return { target, operationId: value.operationId, organizedRequirements: value.organizedRequirements, termReferences: structuredClone(value.termReferences), ...(value.referenceContextRef === undefined ? {} : {referenceContextRef: parseReferenceContextRef(value.referenceContextRef)}) }
}
export function parseNormalTranslationAcceptance(value: unknown): NormalTranslationAcceptance {
  object(value); exact(value, ['envelope', 'operationId', 'organizedRequirements', 'termReferences', ...(Object.hasOwn(value,'referenceContextRef') ? ['referenceContextRef'] : [])])
  const envelope = parseTranslationMaterialEnvelope(value.envelope)
  if (envelope.kind !== 'material') throw new TypeError('Normal translation requires material')
  text(value.operationId); text(value.organizedRequirements, 4000, true); references(value.termReferences)
  return { envelope, operationId: value.operationId, organizedRequirements: value.organizedRequirements, termReferences: structuredClone(value.termReferences), ...(value.referenceContextRef === undefined ? {} : {referenceContextRef: parseReferenceContextRef(value.referenceContextRef)}) }
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
    return { ok: true, value: { ...parseNormalTranslationUnitRequest({ target: value.value.target, operationId: value.value.operationId }), status: 'submitted' } }
  }
  if (method !== 'capabilities') return { ok: true, value: parseNormalTranslationJob(value.value) }
  object(value.value)
  const capability = value.value
  if (Object.keys(capability).some(field => !['ready', 'reason', 'storage', 'mode'].includes(field)) || typeof capability.ready !== 'boolean' || capability.storage !== 'runtime_only' || capability.mode !== 'normal') throw new TypeError('Invalid normal translation capability')
  if (capability.reason !== undefined) text(capability.reason, 1000)
  return structuredClone(value)
}
const packageName = 'dsh-translation-plugin'
export const NORMAL_TRANSLATION_REMOTE = { package: packageName, descriptors: (['capabilities', 'status', 'cancel', 'requestUnit'] as const).map(method => ({
  id: `${packageName}#translationNormal/${method}`, service: 'translationNormal', namespace: 'translationNormal', method,
  invocation: { kind: 'direct' as const }, parameters: method === 'capabilities' ? [] : [{ name: 'request', wire: 'request', source: 'json' as const,
    codec: { mode: 'strict' as const, typeSymbol: `${packageName}#normal/${method}Request`, create: () => ({ parse: (value: unknown) => method === 'requestUnit' ? parseNormalTranslationUnitRequest(value) : parseNormalTranslationQuery(value) }) } }],
  result: { mode: 'strict' as const, typeSymbol: `${packageName}#normal/${method}Result`, create: () => ({ parse: (value: unknown) => parseResult(method, value) }) },
})) }
