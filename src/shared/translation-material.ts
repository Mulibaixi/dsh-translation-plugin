/** Frozen plugin material for one main-session submission, independent of its transport. */
export interface TranslationMaterialScope {
  readonly ownerId: string
  readonly mainSessionId: string
  readonly requestId: string
  readonly operationId: string
}

/** The selected route is optional while the main model discusses the material. */
export interface TranslationMaterialRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface TranslationMaterialUnitReference {
  readonly unitId: string
  readonly sourceVersion: number
}

/** A reference only. Applying a source correction requires a separate business operation. */
export interface TranslationMaterialRevisionReference {
  readonly materialId: string
  readonly sourceVersion: number
  readonly operationId: string
}

export interface TranslationMaterialSnapshot {
  readonly materialId: string
  /** Submitted source version; never inferred from the editable draft's version. */
  readonly sourceVersion: number
  readonly topicId: string
  readonly translationSessionId: string
  readonly draftVersion: number
  readonly sourceText: string
  readonly targetLanguage: string
  readonly instruction: string
  readonly model: TranslationMaterialRoute | null
  readonly maxInputChars: number
  readonly unitReference?: TranslationMaterialUnitReference
  readonly revises?: TranslationMaterialRevisionReference
}

/** No record arriving yet is distinct from both explicit no-material outcomes. */
export type TranslationMaterialDecision =
  | { readonly kind: 'material'; readonly material: TranslationMaterialSnapshot }
  | { readonly kind: 'none' }
  | { readonly kind: 'omit' }

export type TranslationMaterialEnvelope = TranslationMaterialScope & TranslationMaterialDecision

type Data = Record<string, unknown>
function object(value: unknown): asserts value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected translation material object')
}
function fields(value: Data, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError('Unexpected translation material fields')
  }
}
function text(value: unknown, maximum: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim())) throw new TypeError('Invalid translation material text')
  let count = 0
  for (const _ of value) if (++count > maximum) throw new TypeError('Translation material text exceeds limit')
}
function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new TypeError('Invalid translation material version or limit')
}

/** Validate and copy at the plugin bridge boundary; never accepts main chat content or files. */
export function parseTranslationMaterialEnvelope(value: unknown): TranslationMaterialEnvelope {
  object(value)
  const scopeFields = ['ownerId', 'mainSessionId', 'requestId', 'operationId', 'kind']
  if (value.kind === 'material') fields(value, [...scopeFields, 'material'])
  else if (value.kind === 'none' || value.kind === 'omit') fields(value, scopeFields)
  else throw new TypeError('Invalid translation material decision')
  text(value.ownerId, 1000); text(value.mainSessionId, 1000); text(value.requestId, 2048); text(value.operationId, 2048)
  if (value.ownerId !== value.mainSessionId) throw new TypeError('Translation material requires its own main Session')
  const scope: TranslationMaterialScope = { ownerId: value.ownerId, mainSessionId: value.mainSessionId, requestId: value.requestId, operationId: value.operationId }
  if (value.kind === 'none' || value.kind === 'omit') return { ...scope, kind: value.kind }

  const material = value.material
  object(material)
  fields(material, ['materialId', 'sourceVersion', 'topicId', 'translationSessionId', 'draftVersion', 'sourceText', 'targetLanguage', 'instruction', 'model', 'maxInputChars'], ['unitReference', 'revises'])
  text(material.materialId, 2048); text(material.topicId, 3000); text(material.translationSessionId, 2048)
  integer(material.sourceVersion); integer(material.draftVersion); integer(material.maxInputChars, 1, 200000)
  text(material.sourceText, material.maxInputChars); text(material.targetLanguage, 80); text(material.instruction, 4000, true)
  let model: TranslationMaterialRoute | null = null
  if (material.model !== null) {
    object(material.model); fields(material.model, ['provider', 'model'], ['reasoningEffort'])
    text(material.model.provider, 300); text(material.model.model, 300)
    if (material.model.reasoningEffort !== undefined) text(material.model.reasoningEffort, 200)
    model = { provider: material.model.provider, model: material.model.model,
      ...(material.model.reasoningEffort === undefined ? {} : { reasoningEffort: material.model.reasoningEffort }) }
  }
  let unitReference: TranslationMaterialUnitReference | undefined
  if (material.unitReference !== undefined) {
    object(material.unitReference); fields(material.unitReference, ['unitId', 'sourceVersion'])
    text(material.unitReference.unitId, 2048); integer(material.unitReference.sourceVersion)
    unitReference = { unitId: material.unitReference.unitId, sourceVersion: material.unitReference.sourceVersion }
  }
  let revises: TranslationMaterialRevisionReference | undefined
  if (material.revises !== undefined) {
    object(material.revises); fields(material.revises, ['materialId', 'sourceVersion', 'operationId'])
    text(material.revises.materialId, 2048); integer(material.revises.sourceVersion); text(material.revises.operationId, 2048)
    if (material.revises.materialId !== material.materialId || material.revises.sourceVersion !== material.sourceVersion - 1 || material.revises.operationId === scope.operationId) {
      throw new TypeError('Invalid translation material source revision relationship')
    }
    revises = { materialId: material.revises.materialId, sourceVersion: material.revises.sourceVersion, operationId: material.revises.operationId }
  }
  return { ...scope, kind: 'material', material: { materialId: material.materialId, sourceVersion: material.sourceVersion,
    topicId: material.topicId, translationSessionId: material.translationSessionId, draftVersion: material.draftVersion,
    sourceText: material.sourceText, targetLanguage: material.targetLanguage, instruction: material.instruction, model, maxInputChars: material.maxInputChars,
    ...(unitReference === undefined ? {} : { unitReference }), ...(revises === undefined ? {} : { revises }) } }
}
