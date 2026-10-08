import { parseTranslationMaterialEnvelope, type TranslationMaterialEnvelope } from './translation-material.js'

/** A main Agent refers to delivered material; it never supplies a replacement body. */
export interface NormalTranslationTarget {
  readonly kind: 'material'
  readonly mainSessionId: string
  readonly requestId: string
  readonly materialId: string
  readonly sourceVersion: number
}
export interface NormalTranslationTermReference { readonly id: string; readonly entryVersion: number }
export interface NormalTranslationExecute {
  readonly target: NormalTranslationTarget
  /** Independent of the submission id and of each eventual model call id. */
  readonly operationId: string
  readonly organizedRequirements: string
  readonly termReferences: readonly NormalTranslationTermReference[]
}
export interface NormalTranslationAcceptance {
  readonly envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }>
  readonly operationId: string
  readonly organizedRequirements: string
  readonly termReferences: readonly NormalTranslationTermReference[]
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
  object(value); exact(value, ['kind', 'mainSessionId', 'requestId', 'materialId', 'sourceVersion'])
  if (value.kind !== 'material') throw new TypeError('Unsupported normal translation target')
  text(value.mainSessionId); text(value.requestId); text(value.materialId); version(value.sourceVersion)
  return structuredClone(value) as unknown as NormalTranslationTarget
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
  object(value); exact(value, ['target', 'operationId', 'organizedRequirements', 'termReferences'])
  const target = parseNormalTranslationTarget(value.target)
  text(value.operationId); text(value.organizedRequirements, 4000, true); references(value.termReferences)
  return { target, operationId: value.operationId, organizedRequirements: value.organizedRequirements, termReferences: structuredClone(value.termReferences) }
}
export function parseNormalTranslationAcceptance(value: unknown): NormalTranslationAcceptance {
  object(value); exact(value, ['envelope', 'operationId', 'organizedRequirements', 'termReferences'])
  const envelope = parseTranslationMaterialEnvelope(value.envelope)
  if (envelope.kind !== 'material') throw new TypeError('Normal translation requires material')
  text(value.operationId); text(value.organizedRequirements, 4000, true); references(value.termReferences)
  return { envelope, operationId: value.operationId, organizedRequirements: value.organizedRequirements, termReferences: structuredClone(value.termReferences) }
}
export function parseNormalTranslationOperation(value: unknown): NormalTranslationOperation {
  object(value); exact(value, ['operationId', 'mainSessionId', 'topicId', 'translationSessionId', 'materialId', 'unitId', 'sourceVersion', 'draftVersion', 'status', 'persistence'])
  for (const field of ['operationId', 'mainSessionId', 'topicId', 'translationSessionId', 'materialId', 'unitId']) text(value[field])
  version(value.sourceVersion); version(value.draftVersion)
  if (!['accepted', 'running', 'completed', 'failed', 'cancelled', 'unknown'].includes(value.status as string) || !['saved', 'runtime_only'].includes(value.persistence as string)) throw new TypeError('Invalid normal translation operation state')
  return structuredClone(value) as unknown as NormalTranslationOperation
}
