import { parseNormalTranslationTarget, type NormalTranslationUnitTarget } from './normal-translation.js'
import { parseTranslationSourceScope, type TranslationSourceScope } from './translation-sources.js'
import { parseDocumentSourceVersion, parseDocumentChunkPlan, parseDocumentCallRecord, parseDocumentExecutionBaseline,
  type DocumentSourceVersion, type DocumentChunkPlan, type DocumentPreparationReference, type ChunkRevision,
  type DocumentExecutionBaseline, type DocumentTaskStatus, type VersionReference } from './translation-batch.js'
import { parsePreparationSnapshot, type PreparationSnapshot } from './translation-preparation.js'
import { parseTranslationSourceStorageRequest, type TranslationSourceStoredRead } from './translation-source-storage.js'
import { parseDocumentCorrectionFact, type DocumentCorrectionFact } from './document-correction.js'

export interface DocumentUnitCaptureRequest {
  readonly target: NormalTranslationUnitTarget
  readonly preparationRef?: VersionReference
  readonly revisionIds?: readonly string[]
  readonly requireReady?: boolean
}
export interface DocumentCorrectionQuery { readonly scope: TranslationSourceScope; readonly unitId: string; readonly operationId: string }
export function parseDocumentCorrectionQuery(value: unknown): DocumentCorrectionQuery {
  exact(value, ['scope', 'unitId', 'operationId']); identity(value.unitId); identity(value.operationId)
  return { scope: parseTranslationSourceScope(value.scope), unitId: value.unitId, operationId: value.operationId }
}
export interface DocumentUnitCapture {
  readonly scope: TranslationSourceScope
  readonly unitId: string
  readonly currentSourceVersion: number
  readonly source: DocumentSourceVersion
  readonly preparation: PreparationSnapshot | null
  readonly preparations: readonly DocumentPreparationReference[]
  readonly plans: readonly DocumentChunkPlan[]
  readonly chunks: readonly (Omit<ChunkRevision, 'content'> & { readonly completeResult: boolean; readonly outputBytes: number | null })[]
  readonly tasks: readonly { readonly taskId: string; readonly sourceVersion: number; readonly status: DocumentTaskStatus;
    readonly taskVersion: number; readonly taskSequence: number; readonly unsettled: boolean; readonly baseline: Omit<DocumentExecutionBaseline, 'contextBindings'> | null }[]
  readonly corrections: readonly DocumentCorrectionFact[]
  readonly sourceRestore?: TranslationSourceStoredRead
  readonly hasSourceObjects: boolean
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('Unexpected document capture fields')
}
function identity(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new TypeError('Invalid document capture identity') }
function integer(value: unknown, minimum = 1): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError('Invalid document capture number') }
function ref(value: unknown): VersionReference { exact(value, ['id', 'version']); identity(value.id); integer(value.version); return { id: value.id, version: value.version } }
export function parseDocumentUnitCaptureRequest(value: unknown): DocumentUnitCaptureRequest {
  exact(value, ['target'], ['preparationRef', 'revisionIds', 'requireReady'])
  const target = parseNormalTranslationTarget(value.target)
  if (target.kind !== 'unit') throw new TypeError('Document capture needs a unit target')
  if (value.revisionIds !== undefined && (!Array.isArray(value.revisionIds) || value.revisionIds.length > 50)) throw new TypeError('Too many document capture revisions')
  value.revisionIds?.forEach(identity)
  if (value.requireReady !== undefined && typeof value.requireReady !== 'boolean') throw new TypeError('Invalid document capture gate')
  return { target, ...(value.preparationRef === undefined ? {} : { preparationRef: ref(value.preparationRef) }),
    ...(value.revisionIds === undefined ? {} : { revisionIds: value.revisionIds as string[] }), ...(value.requireReady === undefined ? {} : { requireReady: value.requireReady }) }
}
export function parseDocumentUnitCapture(value: unknown): DocumentUnitCapture {
  exact(value, ['scope', 'unitId', 'currentSourceVersion', 'source', 'preparation', 'preparations', 'plans', 'chunks', 'tasks', 'corrections', 'hasSourceObjects'], ['sourceRestore'])
  identity(value.unitId); integer(value.currentSourceVersion)
  const scope = parseTranslationSourceScope(value.scope), source = parseDocumentSourceVersion(value.source), preparation = value.preparation === null ? null : parsePreparationSnapshot(value.preparation)
  for (const key of ['preparations', 'plans', 'chunks', 'tasks', 'corrections']) if (!Array.isArray(value[key])) throw new TypeError('Invalid document capture list')
  if (typeof value.hasSourceObjects !== 'boolean') throw new TypeError('Invalid document object association')
  const preparations = (value.preparations as unknown[]).map(raw => { exact(raw, ['id', 'version', 'sourceVersion']); integer(raw.sourceVersion); return { ...ref({ id: raw.id, version: raw.version }), sourceVersion: raw.sourceVersion } })
  const plans = (value.plans as DocumentChunkPlan[]).map(plan => parseDocumentChunkPlan(plan, plan.items.at(-1)?.outputRange.end ?? 0))
  const chunks = (value.chunks as Record<string, unknown>[]).map(chunk => {
    exact(chunk, ['id', 'taskId', 'childOperationId', 'attemptId', 'callId', 'sourceVersion', 'chunkId', 'planRef', 'preparationRef', 'kind', 'status', 'callRecord', 'createdAt', 'updatedAt', 'completeResult', 'outputBytes'])
    for (const key of ['id', 'taskId', 'childOperationId', 'chunkId', 'createdAt', 'updatedAt']) identity(chunk[key]); integer(chunk.sourceVersion)
    if (typeof chunk.completeResult !== 'boolean') throw new TypeError('Invalid captured completeness')
    if (chunk.outputBytes !== null) integer(chunk.outputBytes, 0)
    return { ...chunk, planRef: ref(chunk.planRef), preparationRef: ref(chunk.preparationRef), callRecord: chunk.callRecord === null ? null : parseDocumentCallRecord(chunk.callRecord, Number.MAX_SAFE_INTEGER) } as unknown as DocumentUnitCapture['chunks'][number]
  })
  const tasks = (value.tasks as Record<string, unknown>[]).map(task => {
    exact(task, ['taskId', 'sourceVersion', 'status', 'taskVersion', 'taskSequence', 'unsettled', 'baseline']); identity(task.taskId); integer(task.sourceVersion); integer(task.taskVersion); integer(task.taskSequence, 0)
    if (typeof task.unsettled !== 'boolean') throw new TypeError('Invalid captured dispatch phase')
    const complete = task.baseline === null ? null : parseDocumentExecutionBaseline({ ...(task.baseline as object), contextBindings: [] })
    const baseline = complete && { hostGeneration: complete.hostGeneration, route: complete.route, capacity: complete.capacity, analysisActualCalls: complete.analysisActualCalls, maxInputChars: complete.maxInputChars }
    return { ...task, baseline } as unknown as DocumentUnitCapture['tasks'][number]
  })
  return { scope, unitId: value.unitId, currentSourceVersion: value.currentSourceVersion, source, preparation, preparations, plans, chunks, tasks,
    corrections: (value.corrections as unknown[]).map(parseDocumentCorrectionFact), hasSourceObjects: value.hasSourceObjects,
    ...(value.sourceRestore === undefined ? {} : { sourceRestore: parseTranslationSourceStorageRequest('restore', value.sourceRestore) as TranslationSourceStoredRead }) }
}
