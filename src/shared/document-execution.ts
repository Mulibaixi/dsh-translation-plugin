import { parseNormalTranslationTarget, parseNormalTranslationUnitRequest, type NormalTranslationTarget, type NormalTranslationUnitTarget } from './normal-translation.js'
import { parseTranslationMaterialEnvelope, type TranslationMaterialEnvelope } from './translation-material.js'
import { parseTranslationSourceScope, type TranslationSourceScope } from './translation-sources.js'
import { sourceCodePointLength } from './translation-source-read.js'
import { parseDocumentChunkPlan, parseDocumentCallContextReference, parseDocumentCallRecord, sameVersionReference,
  parseDocumentExecutionBaseline, parseDocumentExecutionFacts, parseDocumentSourceVersion, documentSourceLength, parseDocumentSupplementFact,
  type DocumentChunkPlan, type DocumentCallContextReference, type DocumentCallRecord, type DocumentTaskStatus,
  type VersionReference, type DocumentExecutionBaseline, type DocumentExecutionFacts, type DocumentSourceVersion, type ChunkRevision, type DocumentSupplementFact } from './translation-batch.js'
import { parsePreparationSnapshot, type PreparationSnapshot } from './translation-preparation.js'
import { parseTranslationSourceStorageRequest, type TranslationSourceStoredRead } from './translation-source-storage.js'
import { parseDocumentReuseRequests, parseDocumentReuseApproval, type DocumentReuseRequest, type DocumentReuseApproval } from './document-correction.js'

export const MAX_DOCUMENT_OUTPUT_BYTES = 16 * 1024 * 1024
export const MAX_DOCUMENT_EXECUTION_PACKET_BYTES = 196608
/** This acknowledges only delivery of an explicit intent to the main Agent, never a translation task. */
export interface DocumentUnitSubmitReceipt {
  readonly accepted: true
  readonly operationId: string
  readonly target: NormalTranslationUnitTarget
}
export interface TranslationBatchExecute {
  readonly target: NormalTranslationTarget
  readonly operationId: string
  readonly planRef: VersionReference
  readonly preparationRef: VersionReference
  readonly reuseApprovals?: readonly DocumentReuseRequest[]
}
export interface DocumentUnitAcceptRequest {
  readonly target: Extract<NormalTranslationTarget, { kind: 'unit' }>
  readonly operationId: string
  readonly taskId: string
  readonly plan: DocumentChunkPlan
  readonly preparationRef: VersionReference
  readonly createdAt: string
  readonly executionBaseline: DocumentExecutionBaseline
  readonly reuseApprovals: readonly DocumentReuseApproval[]
  readonly reusedOutputBytes: number
}
export interface TranslationBatchStatus {
  readonly scope: TranslationSourceScope
  readonly taskId: string
  readonly afterTaskSequence?: number
  readonly limit?: number
}
export interface DocumentTaskScope {
  readonly scope: TranslationSourceScope
  readonly taskId: string
  readonly unitId: string
}
export interface DocumentAcceptRequest {
  readonly envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }>
  readonly operationId: string
  readonly taskId: string
  readonly unitId: string
  readonly plan: DocumentChunkPlan
  readonly preparationRef: VersionReference
  readonly contextBindings: readonly { readonly chunkId: string; readonly contextRef: DocumentCallContextReference }[]
  readonly createdAt: string
  readonly executionBaseline?: DocumentExecutionBaseline
}
export interface DocumentTaskReceipt extends DocumentTaskScope {
  readonly operationId: string
  readonly sourceVersion: number
  readonly planRef: VersionReference
  readonly preparationRef: VersionReference
  readonly taskSequence: number
  readonly status: DocumentTaskStatus
  readonly storage: 'saved' | 'runtime_only'
  readonly storageError: string | null
  readonly restartExecutable: boolean
  readonly taskVersion?: number
  readonly hostGeneration?: string | null
}
export interface DocumentBlockRegistration extends DocumentTaskScope {
  readonly chunkId: string
  readonly childOperationId: string
  readonly attemptId: string | null
  readonly callId: string | null
  readonly revisionId: string
  readonly createdAt: string
  readonly planRef?: VersionReference
  readonly preparationRef?: VersionReference
  readonly contextRef?: DocumentCallContextReference
  readonly outputRange?: import('./translation-source-read.js').TranslationSourceRange
}
export interface DocumentBlockReceipt extends DocumentTaskScope {
  readonly childOperationId: string
  readonly revisionId: string
  readonly callId: string | null
  readonly attemptId: string | null
  readonly sequence: number
  readonly registered: true
}
interface DocumentEventIdentity extends DocumentTaskScope {
  readonly taskSequence: number
  readonly childOperationId: string
  readonly sequence: number
  readonly revisionId: string
  readonly at: string
}
export type DocumentTaskEvent = DocumentEventIdentity & (
  | { readonly kind: 'dispatch_intent' }
  | { readonly kind: 'dispatched'; readonly callRecord: DocumentCallRecord }
  | { readonly kind: 'delta'; readonly delta: string }
  | { readonly kind: 'settled'; readonly status: 'completed' | 'failed' | 'cancelled' | 'unknown';
    readonly usage: DocumentCallRecord['usage'] }
  | { readonly kind: 'copy'; readonly sha256: string })
export interface DocumentTaskFinish extends DocumentTaskScope {
  readonly taskSequence: number
  readonly status: 'completed' | 'failed' | 'cancelled' | 'unknown'
  readonly manifestId: string
  readonly at: string
}
/** Host-to-Client cleanup after the Host has received a terminal finish receipt. */
export interface DocumentTaskRelease extends DocumentTaskScope {
  readonly taskSequence: number
}
export interface TranslationBatchControl {
  readonly scope: TranslationSourceScope
  readonly taskId: string
  readonly operationId: string
  readonly expectedTaskVersion: number
}
export interface TranslationBatchUpdate extends TranslationBatchControl {
  readonly planRef: VersionReference
  readonly preparationRef: VersionReference
  readonly route?: DocumentExecutionBaseline['route']
}
export interface DocumentTaskControl extends DocumentTaskScope {
  readonly operationId: string
  readonly expectedTaskVersion: number
  readonly hostGeneration: string
  readonly taskSequence: number
  readonly status: DocumentTaskStatus
  readonly kind: 'pause' | 'cancel' | 'resume' | 'update'
  readonly at: string
  readonly plan?: DocumentChunkPlan
  readonly preparationRef?: VersionReference
  readonly executionBaseline?: DocumentExecutionBaseline
  readonly reviewIssues?: DocumentExecutionFacts['reviewIssues']
  readonly supplement?: DocumentSupplementFact
}
export interface DocumentRestoreRequest { readonly scope: TranslationSourceScope; readonly taskId: string; readonly unitId?: string; readonly hostGeneration: string }
export interface DocumentRestoreCapture {
  readonly reuseApprovals?: readonly DocumentReuseApproval[]
  readonly receipt: DocumentTaskReceipt
  readonly source: DocumentSourceVersion
  readonly plan: DocumentChunkPlan
  readonly preparation: PreparationSnapshot
  readonly executionFacts: DocumentExecutionFacts
  readonly chunks: readonly Pick<ChunkRevision, 'id' | 'chunkId' | 'status' | 'callId' | 'attemptId' | 'childOperationId' | 'planRef' | 'preparationRef' | 'sourceVersion'>[]
  readonly sourceRestore?: TranslationSourceStoredRead
}
export interface DocumentBatchStatusView {
  readonly scope: TranslationSourceScope
  readonly taskId: string
  readonly unitId: string
  readonly operationId: string
  readonly sourceVersion: number
  readonly planRef: VersionReference
  readonly preparationRef: VersionReference
  readonly status: DocumentTaskStatus
  readonly receipt: DocumentTaskReceipt | null
  readonly taskSequence: number
  readonly taskVersion: number
  readonly hostGeneration: string
  readonly pauseRequested: boolean
  readonly cancelRequested: boolean
  readonly completedChunks: number
  readonly chunkCount: number
  readonly actualCalls: number
  readonly outputBytes: number
  readonly maximumCalls: 512
  readonly maximumOutputBytes: number
  readonly error: { readonly code: string; readonly message: string; readonly stage: string } | null
  readonly events: readonly { readonly taskSequence: number; readonly kind: string; readonly chunkId: string | null; readonly childOperationId: string | null; readonly sequence: number | null; readonly at: string }[]
  readonly afterTaskSequence: number
  readonly nextCursor: number | null
  readonly restartExecutable: boolean
  readonly automaticSupplementCalls: number
  readonly reviewIssues: DocumentExecutionFacts['reviewIssues']
  readonly review: 'pending' | 'review_required' | 'passed' | 'failed'
  readonly finalEligible: boolean
  readonly phaseNotification: 'unavailable' | 'available' | 'not_enqueued' | 'enqueued' | 'claimed' | 'discarded'
}

type Data = Record<string, unknown>
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Data {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('Unexpected document execution fields')
}
function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new TypeError('Invalid document execution number')
}
function text(value: unknown, maximum = 2048, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || sourceCodePointLength(value) > maximum || /[\uD800-\uDFFF]/u.test(value)) throw new TypeError('Invalid document execution text')
}
function time(value: unknown): asserts value is string { text(value, 40); if (!Number.isFinite(Date.parse(value))) throw new TypeError('Invalid document execution time') }
function reference(value: unknown): VersionReference {
  exact(value, ['id', 'version']); text(value.id); integer(value.version); return { id: value.id, version: value.version }
}
function packet(value: unknown): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_DOCUMENT_EXECUTION_PACKET_BYTES) throw new TypeError('Document execution packet exceeds transport budget')
}
function nullableIdentity(value: unknown): asserts value is string | null { if (value !== null) text(value) }
export function parseTranslationBatchExecute(value: unknown): TranslationBatchExecute {
  packet(value); exact(value, ['target', 'operationId', 'planRef', 'preparationRef'], ['reuseApprovals']); text(value.operationId)
  return { target: parseNormalTranslationTarget(value.target), operationId: value.operationId,
    planRef: reference(value.planRef), preparationRef: reference(value.preparationRef), ...(value.reuseApprovals === undefined ? {} : { reuseApprovals: parseDocumentReuseRequests(value.reuseApprovals) }) }
}
export function parseDocumentUnitAcceptRequest(value: unknown): DocumentUnitAcceptRequest {
  packet(value); exact(value, ['target', 'operationId', 'taskId', 'plan', 'preparationRef', 'createdAt', 'executionBaseline', 'reuseApprovals', 'reusedOutputBytes'])
  const target = parseNormalTranslationTarget(value.target)
  if (target.kind !== 'unit') throw new TypeError('Unit admission requires an exact unit target')
  text(value.operationId); text(value.taskId); time(value.createdAt)
  const raw = value.plan as DocumentChunkPlan, plan = parseDocumentChunkPlan(raw, raw.items.at(-1)?.outputRange.end ?? 0), preparationRef = reference(value.preparationRef), executionBaseline = parseDocumentExecutionBaseline(value.executionBaseline)
  if (plan.sourceVersion !== target.sourceVersion || !sameVersionReference(plan.preparationRef, preparationRef) || executionBaseline.contextBindings.length !== plan.items.length || executionBaseline.contextBindings.some((binding, index) => binding.chunkId !== plan.items[index]!.chunkId || !sameVersionReference(binding.contextRef.preparationRef, preparationRef))) throw new TypeError('Unit admission dependencies changed')
  if (!Array.isArray(value.reuseApprovals) || value.reuseApprovals.length > 256) throw new TypeError('Invalid unit reuse approvals')
  integer(value.reusedOutputBytes, 0, MAX_DOCUMENT_OUTPUT_BYTES)
  return { target, operationId: value.operationId, taskId: value.taskId, plan, preparationRef, createdAt: value.createdAt, executionBaseline,
    reuseApprovals: value.reuseApprovals.map(parseDocumentReuseApproval), reusedOutputBytes: value.reusedOutputBytes }
}
export function parseTranslationBatchStatus(value: unknown): TranslationBatchStatus {
  packet(value); exact(value, ['scope', 'taskId'], ['afterTaskSequence', 'limit']); text(value.taskId)
  if (value.afterTaskSequence !== undefined) integer(value.afterTaskSequence, 0)
  if (value.limit !== undefined) integer(value.limit, 1, 50)
  return { scope: parseTranslationSourceScope(value.scope), taskId: value.taskId,
    ...(value.afterTaskSequence === undefined ? {} : { afterTaskSequence: value.afterTaskSequence }),
    ...(value.limit === undefined ? {} : { limit: value.limit }) }
}
export function parseDocumentTaskScope(value: unknown): DocumentTaskScope {
  packet(value); exact(value, ['scope', 'taskId', 'unitId']); text(value.taskId); text(value.unitId)
  return { scope: parseTranslationSourceScope(value.scope), taskId: value.taskId, unitId: value.unitId }
}
function scopeOf(value: Data): DocumentTaskScope { return parseDocumentTaskScope({ scope: value.scope, taskId: value.taskId, unitId: value.unitId }) }
export function parseDocumentAcceptRequest(value: unknown): DocumentAcceptRequest {
  packet(value); exact(value, ['envelope', 'operationId', 'taskId', 'unitId', 'plan', 'preparationRef', 'contextBindings', 'createdAt'], ['executionBaseline'])
  text(value.operationId); text(value.taskId); text(value.unitId); time(value.createdAt)
  const envelope = parseTranslationMaterialEnvelope(value.envelope)
  if (envelope.kind !== 'material' || envelope.material.unitReference || envelope.material.revises || envelope.material.sourceVersion !== 1) throw new TypeError('Document admission requires fixed first material')
  const total = envelope.material.sourceRef?.totalCodePoints ?? sourceCodePointLength(envelope.material.sourceText!)
  const plan = parseDocumentChunkPlan(value.plan, total), preparationRef = reference(value.preparationRef)
  if (plan.sourceVersion !== envelope.material.sourceVersion || !sameVersionReference(plan.preparationRef, preparationRef)) throw new TypeError('Document preparation or plan binding changed')
  if (!Array.isArray(value.contextBindings) || value.contextBindings.length !== plan.items.length) throw new TypeError('Document contexts must bind each planned block')
  const contextBindings = value.contextBindings.map((raw, index) => {
    exact(raw, ['chunkId', 'contextRef']); text(raw.chunkId)
    const contextRef = parseDocumentCallContextReference(raw.contextRef, total)
    if (raw.chunkId !== plan.items[index]!.chunkId || !sameVersionReference(contextRef.preparationRef, preparationRef)) throw new TypeError('Document context plan changed')
    return { chunkId: raw.chunkId, contextRef }
  })
  return { envelope, operationId: value.operationId, taskId: value.taskId, unitId: value.unitId, plan, preparationRef, contextBindings, createdAt: value.createdAt,
    ...(value.executionBaseline === undefined ? {} : { executionBaseline: parseDocumentExecutionBaseline(value.executionBaseline) }) }
}
export function parseDocumentBlockRegistration(value: unknown): DocumentBlockRegistration {
  packet(value); exact(value, ['scope', 'taskId', 'unitId', 'chunkId', 'childOperationId', 'attemptId', 'callId', 'revisionId', 'createdAt'], ['planRef', 'preparationRef', 'contextRef', 'outputRange'])
  for (const key of ['chunkId', 'childOperationId', 'revisionId']) text(value[key])
  nullableIdentity(value.attemptId); nullableIdentity(value.callId); time(value.createdAt)
  if ((value.attemptId === null) !== (value.callId === null)) throw new TypeError('Document call registration identities disagree')
  return { ...scopeOf(value), chunkId: value.chunkId as string, childOperationId: value.childOperationId as string,
    attemptId: value.attemptId, callId: value.callId, revisionId: value.revisionId as string, createdAt: value.createdAt,
    ...(value.planRef === undefined ? {} : { planRef: reference(value.planRef) }), ...(value.preparationRef === undefined ? {} : { preparationRef: reference(value.preparationRef) }),
    ...(value.contextRef === undefined ? {} : { contextRef: parseDocumentCallContextReference(value.contextRef, Number.MAX_SAFE_INTEGER) }),
    ...(value.outputRange === undefined ? {} : { outputRange: parseRange(value.outputRange) }) }
}
export function parseDocumentTaskEvent(value: unknown): DocumentTaskEvent {
  packet(value); exact(value, ['scope', 'taskId', 'unitId', 'taskSequence', 'childOperationId', 'sequence', 'revisionId', 'at', 'kind'], ['callRecord', 'delta', 'status', 'usage', 'sha256'])
  integer(value.taskSequence); integer(value.sequence); text(value.childOperationId); text(value.revisionId); time(value.at)
  const identity: DocumentEventIdentity = { ...scopeOf(value), taskSequence: value.taskSequence, childOperationId: value.childOperationId,
    sequence: value.sequence, revisionId: value.revisionId, at: value.at }
  const base = ['scope', 'taskId', 'unitId', 'taskSequence', 'childOperationId', 'sequence', 'revisionId', 'at', 'kind']
  if (value.kind === 'dispatch_intent') { exact(value, base); return { ...identity, kind: 'dispatch_intent' } }
  if (value.kind === 'dispatched') {
    exact(value, [...base, 'callRecord']); return { ...identity, kind: 'dispatched', callRecord: parseDocumentCallRecord(value.callRecord, Number.MAX_SAFE_INTEGER) }
  }
  if (value.kind === 'delta') { exact(value, [...base, 'delta']); text(value.delta, 100000, true); return { ...identity, kind: 'delta', delta: value.delta } }
  if (value.kind === 'copy') {
    exact(value, [...base, 'sha256']); if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(value.sha256)) throw new TypeError('Invalid document copy hash')
    return { ...identity, kind: 'copy', sha256: value.sha256 }
  }
  if (value.kind !== 'settled') throw new TypeError('Invalid document event kind')
  exact(value, [...base, 'status', 'usage']); terminal(value.status); exact(value.usage, ['inputTokens', 'outputTokens'])
  for (const count of [value.usage.inputTokens, value.usage.outputTokens]) if (count !== null) integer(count, 0)
  return { ...identity, kind: 'settled', status: value.status,
    usage: { inputTokens: value.usage.inputTokens as number | null, outputTokens: value.usage.outputTokens as number | null } }
}
function terminal(value: unknown): asserts value is DocumentTaskFinish['status'] {
  if (!['completed', 'failed', 'cancelled', 'unknown'].includes(value as string)) throw new TypeError('Invalid document terminal status')
}
export function parseDocumentTaskFinish(value: unknown): DocumentTaskFinish {
  packet(value); exact(value, ['scope', 'taskId', 'unitId', 'taskSequence', 'status', 'manifestId', 'at'])
  integer(value.taskSequence); terminal(value.status); text(value.manifestId); time(value.at)
  return { ...scopeOf(value), taskSequence: value.taskSequence, status: value.status, manifestId: value.manifestId, at: value.at }
}
export function parseDocumentTaskRelease(value: unknown): DocumentTaskRelease {
  packet(value); exact(value, ['scope', 'taskId', 'unitId', 'taskSequence']); integer(value.taskSequence)
  return { ...scopeOf(value), taskSequence: value.taskSequence }
}
export function parseDocumentTaskReceipt(value: unknown): DocumentTaskReceipt {
  packet(value); exact(value, ['scope', 'taskId', 'unitId', 'operationId', 'sourceVersion', 'planRef', 'preparationRef', 'taskSequence', 'status', 'storage', 'storageError', 'restartExecutable'], ['taskVersion', 'hostGeneration'])
  text(value.operationId); integer(value.sourceVersion); integer(value.taskSequence, 0)
  if (!['running', 'paused', 'waiting_context', 'waiting_user', 'completed', 'failed', 'cancelled', 'unknown', 'interrupted'].includes(value.status as string) || !['saved', 'runtime_only'].includes(value.storage as string) || typeof value.restartExecutable !== 'boolean') throw new TypeError('Invalid document receipt status')
  if (value.taskVersion !== undefined) integer(value.taskVersion)
  if (value.hostGeneration !== undefined && value.hostGeneration !== null) text(value.hostGeneration)
  if (value.storageError !== null) text(value.storageError, 1000)
  return { ...scopeOf(value), operationId: value.operationId, sourceVersion: value.sourceVersion, planRef: reference(value.planRef), preparationRef: reference(value.preparationRef),
    taskSequence: value.taskSequence, status: value.status as DocumentTaskStatus, storage: value.storage as DocumentTaskReceipt['storage'], storageError: value.storageError as string | null, restartExecutable: value.restartExecutable,
    ...(value.taskVersion === undefined ? {} : { taskVersion: value.taskVersion }), ...(value.hostGeneration === undefined ? {} : { hostGeneration: value.hostGeneration as string | null }) }
}
function parseRange(value: unknown): import('./translation-source-read.js').TranslationSourceRange {
  exact(value, ['start', 'end']); integer(value.start, 0); integer(value.end, value.start + 1); return { start: value.start, end: value.end }
}
export function parseTranslationBatchControl(value: unknown): TranslationBatchControl {
  packet(value); exact(value, ['scope', 'taskId', 'operationId', 'expectedTaskVersion']); text(value.taskId); text(value.operationId); integer(value.expectedTaskVersion)
  return { scope: parseTranslationSourceScope(value.scope), taskId: value.taskId, operationId: value.operationId, expectedTaskVersion: value.expectedTaskVersion }
}
export function parseTranslationBatchUpdate(value: unknown): TranslationBatchUpdate {
  packet(value); exact(value, ['scope', 'taskId', 'operationId', 'expectedTaskVersion', 'planRef', 'preparationRef'], ['route'])
  const { planRef, preparationRef, route, ...control } = value
  return { ...parseTranslationBatchControl(control), planRef: reference(planRef), preparationRef: reference(preparationRef),
    ...(route === undefined ? {} : { route: parseDocumentExecutionBaseline({ hostGeneration: 'route', route, capacity: { contextWindow: null, maxOutputTokens: null, countKind: 'estimated' }, analysisActualCalls: 0, maxInputChars: 1, contextBindings: [] }).route }) }
}
export function parseDocumentTaskControl(value: unknown): DocumentTaskControl {
  packet(value); exact(value, ['scope', 'taskId', 'unitId', 'operationId', 'expectedTaskVersion', 'hostGeneration', 'taskSequence', 'status', 'kind', 'at'], ['plan', 'preparationRef', 'executionBaseline', 'reviewIssues', 'supplement'])
  text(value.operationId); text(value.hostGeneration); integer(value.expectedTaskVersion); integer(value.taskSequence); time(value.at)
  if (!['pause', 'cancel', 'resume', 'update'].includes(value.kind as string) || !['running', 'paused', 'waiting_context', 'waiting_user', 'cancelled', 'failed', 'unknown', 'interrupted'].includes(value.status as string)) throw new TypeError('Invalid document control')
  const baseline = value.executionBaseline === undefined ? undefined : parseDocumentExecutionBaseline(value.executionBaseline)
  let reviewIssues: DocumentExecutionFacts['reviewIssues'] | undefined
  if (value.reviewIssues !== undefined) {
    if (!Array.isArray(value.reviewIssues) || value.reviewIssues.length > 256) throw new TypeError('Invalid document dependency issues')
    reviewIssues = value.reviewIssues.map(raw => { exact(raw, ['code', 'range', 'message']); text(raw.code, 128); text(raw.message); return { code: raw.code, range: parseRange(raw.range), message: raw.message } })
  }
  return { ...scopeOf(value), operationId: value.operationId, expectedTaskVersion: value.expectedTaskVersion, hostGeneration: value.hostGeneration, taskSequence: value.taskSequence,
    status: value.status as DocumentTaskStatus, kind: value.kind as DocumentTaskControl['kind'], at: value.at,
    ...(value.plan === undefined ? {} : { plan: parseDocumentChunkPlan(value.plan, planLength(value.plan)) }),
    ...(value.preparationRef === undefined ? {} : { preparationRef: reference(value.preparationRef) }), ...(baseline === undefined ? {} : { executionBaseline: baseline }), ...(reviewIssues === undefined ? {} : { reviewIssues }),
    ...(value.supplement === undefined ? {} : { supplement: parseDocumentSupplementFact(value.supplement) }) }
}
function planLength(value: unknown): number {
  if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items) || !value.items.length) throw new TypeError('Invalid document plan')
  return parseRange(value.items.at(-1)?.outputRange).end
}
export function parseDocumentRestoreRequest(value: unknown): DocumentRestoreRequest {
  packet(value); exact(value, ['scope', 'taskId', 'hostGeneration'], ['unitId']); text(value.hostGeneration); text(value.taskId)
  if (value.unitId !== undefined) text(value.unitId)
  return { scope: parseTranslationSourceScope(value.scope), taskId: value.taskId, hostGeneration: value.hostGeneration, ...(value.unitId === undefined ? {} : { unitId: value.unitId }) }
}
export function parseDocumentRestoreCapture(value: unknown): DocumentRestoreCapture {
  packet(value); exact(value, ['receipt', 'source', 'plan', 'preparation', 'executionFacts', 'chunks'], ['sourceRestore', 'reuseApprovals'])
  const receipt = parseDocumentTaskReceipt(value.receipt), source = parseDocumentSourceVersion(value.source), plan = parseDocumentChunkPlan(value.plan, documentSourceLength(source)), preparation = parsePreparationSnapshot(value.preparation), executionFacts = parseDocumentExecutionFacts(value.executionFacts)
  if (!Array.isArray(value.chunks) || value.chunks.length > 512) throw new TypeError('Invalid restored chunk metadata')
  const chunks = value.chunks.map(raw => {
    exact(raw, ['id', 'chunkId', 'status', 'callId', 'attemptId', 'childOperationId', 'planRef', 'preparationRef', 'sourceVersion'])
    for (const key of ['id', 'chunkId', 'childOperationId']) text(raw[key]); nullableIdentity(raw.callId); nullableIdentity(raw.attemptId); integer(raw.sourceVersion)
    if (!['running', 'paused', 'waiting_context', 'waiting_user', 'completed', 'failed', 'cancelled', 'unknown', 'interrupted'].includes(raw.status as string)) throw new TypeError('Invalid restored chunk status')
    return { ...raw, planRef: reference(raw.planRef), preparationRef: reference(raw.preparationRef) } as unknown as DocumentRestoreCapture['chunks'][number]
  })
  if (receipt.sourceVersion !== source.version || plan.sourceVersion !== source.version || !sameVersionReference(plan, receipt.planRef) || !sameVersionReference(preparation, receipt.preparationRef) || !sameVersionReference(plan.preparationRef, preparation)) throw new TypeError('Restored task references changed')
  if (value.reuseApprovals !== undefined && (!Array.isArray(value.reuseApprovals) || value.reuseApprovals.length > 256)) throw new TypeError('Invalid restored reuse approvals')
  return { receipt, source, plan, preparation, executionFacts, chunks,
    ...(value.reuseApprovals === undefined ? {} : { reuseApprovals: (value.reuseApprovals as unknown[]).map(parseDocumentReuseApproval) }),
    ...(value.sourceRestore === undefined ? {} : { sourceRestore: parseTranslationSourceStorageRequest('restore', value.sourceRestore) as TranslationSourceStoredRead }) }
}
export function parseDocumentBatchStatusView(value: unknown): DocumentBatchStatusView {
  packet(value); exact(value, ['scope', 'taskId', 'unitId', 'operationId', 'sourceVersion', 'planRef', 'preparationRef', 'status', 'receipt', 'taskSequence', 'taskVersion', 'hostGeneration', 'pauseRequested', 'cancelRequested', 'completedChunks', 'chunkCount', 'actualCalls', 'outputBytes', 'maximumCalls', 'maximumOutputBytes', 'error', 'events', 'afterTaskSequence', 'nextCursor', 'restartExecutable', 'automaticSupplementCalls', 'reviewIssues', 'review', 'finalEligible', 'phaseNotification'])
  const scope = parseTranslationSourceScope(value.scope)
  for (const key of ['taskId', 'unitId', 'operationId', 'hostGeneration']) text(value[key])
  for (const key of ['sourceVersion', 'taskVersion']) integer(value[key])
  for (const key of ['taskSequence', 'completedChunks', 'chunkCount', 'actualCalls', 'outputBytes', 'afterTaskSequence']) integer(value[key], 0)
  for (const key of ['pauseRequested', 'cancelRequested', 'restartExecutable']) if (typeof value[key] !== 'boolean') throw new TypeError('Invalid document status flag')
  if (value.nextCursor !== null) integer(value.nextCursor, 0)
  integer(value.automaticSupplementCalls, 0, 3)
  if (value.maximumCalls !== 512 || value.maximumOutputBytes !== MAX_DOCUMENT_OUTPUT_BYTES || typeof value.finalEligible !== 'boolean' || !['pending', 'review_required', 'passed', 'failed'].includes(value.review as string) || !['unavailable', 'available', 'not_enqueued', 'enqueued', 'claimed', 'discarded'].includes(value.phaseNotification as string) || !['running', 'paused', 'waiting_context', 'waiting_user', 'completed', 'failed', 'cancelled', 'unknown', 'interrupted'].includes(value.status as string)) throw new TypeError('Invalid document status facts')
  if (value.error !== null) { exact(value.error, ['code', 'message', 'stage']); text(value.error.code, 128); text(value.error.message, 2048); text(value.error.stage, 128) }
  if (!Array.isArray(value.events) || value.events.length > 50 || !Array.isArray(value.reviewIssues) || value.reviewIssues.length > 256) throw new TypeError('Invalid document status page')
  value.events.forEach(raw => { exact(raw, ['taskSequence', 'kind', 'chunkId', 'childOperationId', 'sequence', 'at']); integer(raw.taskSequence); text(raw.kind, 128); nullableIdentity(raw.chunkId); nullableIdentity(raw.childOperationId); if (raw.sequence !== null) integer(raw.sequence, 0); time(raw.at) })
  value.reviewIssues.forEach(raw => { exact(raw, ['code', 'range', 'message']); text(raw.code, 128); text(raw.message); parseRange(raw.range) })
  const result = { ...value, scope, planRef: reference(value.planRef), preparationRef: reference(value.preparationRef), receipt: value.receipt === null ? null : parseDocumentTaskReceipt(value.receipt) } as unknown as DocumentBatchStatusView
  if (new TextEncoder().encode(JSON.stringify({ ok: true, value: result })).byteLength > 32768) throw new TypeError('Document status exceeds page budget')
  return structuredClone(result)
}
function parseDocumentRemoteResult(method: string, value: unknown): import('./translation-preparation.js').AnalysisResult<DocumentTaskReceipt | DocumentBatchStatusView> {
  exact(value, ['ok'], ['value', 'error'])
  if (value.ok === true) { exact(value, ['ok', 'value']); return { ok: true, value: method === 'status' ? parseDocumentBatchStatusView(value.value) : parseDocumentTaskReceipt(value.value) } }
  if (value.ok !== false) throw new TypeError('Invalid document Remote result')
  exact(value, ['ok', 'error']); exact(value.error, ['code', 'message', 'stage']); text(value.error.code, 128); text(value.error.message, 2048); text(value.error.stage, 128)
  return { ok: false, error: { code: value.error.code, message: value.error.message, stage: value.error.stage } }
}
function parseDocumentUnitIntentResult(value: unknown, nullable: boolean): import('./translation-preparation.js').AnalysisResult<DocumentUnitSubmitReceipt | null> {
  exact(value, ['ok'], ['value', 'error'])
  if (value.ok === true) {
    exact(value, ['ok', 'value'])
    if (nullable && value.value === null) return { ok: true, value: null }
    exact(value.value, ['accepted', 'operationId', 'target'])
    if (value.value.accepted !== true) throw new TypeError('Invalid document intent receipt')
    const request = parseNormalTranslationUnitRequest({ operationId: value.value.operationId, target: value.value.target })
    return { ok: true, value: { accepted: true, operationId: request.operationId, target: request.target } }
  }
  if (value.ok !== false) throw new TypeError('Invalid document intent result')
  exact(value, ['ok', 'error']); exact(value.error, ['code', 'message', 'stage']); text(value.error.code, 128); text(value.error.message, 2048); text(value.error.stage, 128)
  return { ok: false, error: { code: value.error.code, message: value.error.message, stage: value.error.stage } }
}
export function parseDocumentUnitSubmitResult(value: unknown): import('./translation-preparation.js').AnalysisResult<DocumentUnitSubmitReceipt> {
  return parseDocumentUnitIntentResult(value, false) as import('./translation-preparation.js').AnalysisResult<DocumentUnitSubmitReceipt>
}
/** Null is an unknown intent acknowledgement, including an unavailable runtime record after Host restart. */
export function parseDocumentUnitQueryResult(value: unknown): import('./translation-preparation.js').AnalysisResult<DocumentUnitSubmitReceipt | null> {
  return parseDocumentUnitIntentResult(value, true)
}
const executionPackage = 'dsh-translation-plugin'
export const DOCUMENT_EXECUTION_REMOTE = { package: executionPackage, descriptors: [...(['status', 'pause', 'cancel', 'resume', 'update'] as const).map(method => ({
  id: `${executionPackage}#translationBatch/${method}`, service: 'translationBatch', namespace: 'translationBatch', method,
  invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const,
    codec: { mode: 'strict' as const, typeSymbol: `${executionPackage}#batch/${method}Request`, create: () => ({ parse: (value: unknown) => method === 'status' ? parseTranslationBatchStatus(value) : method === 'update' ? parseTranslationBatchUpdate(value) : parseTranslationBatchControl(value) }) } }],
  result: { mode: 'strict' as const, typeSymbol: `${executionPackage}#batch/${method}Result`, create: () => ({ parse: (value: unknown) => parseDocumentRemoteResult(method, value) }) },
})), ...(['submitUnit', 'queryUnit'] as const).map(method => ({
  id: `${executionPackage}#translationBatch/${method}`, service: 'translationBatch', namespace: 'translationBatch', method,
  invocation: { kind: 'direct' as const }, parameters: [{ name: 'request', wire: 'request', source: 'json' as const,
    codec: { mode: 'strict' as const, typeSymbol: `${executionPackage}#batch/${method}Request`, create: () => ({ parse: parseNormalTranslationUnitRequest }) } }],
  ...(method === 'submitUnit' ? { cancellation: { parameter: 'signal' } } : {}),
  result: { mode: 'strict' as const, typeSymbol: `${executionPackage}#batch/${method}Result`, create: () => ({ parse: method === 'submitUnit' ? parseDocumentUnitSubmitResult : parseDocumentUnitQueryResult }) },
}))] }
export function parseDocumentBlockReceipt(value: unknown): DocumentBlockReceipt {
  packet(value); exact(value, ['scope', 'taskId', 'unitId', 'childOperationId', 'revisionId', 'callId', 'attemptId', 'sequence', 'registered'])
  text(value.childOperationId); text(value.revisionId); nullableIdentity(value.callId); nullableIdentity(value.attemptId); integer(value.sequence, 0)
  if (value.registered !== true || (value.callId === null) !== (value.attemptId === null)) throw new TypeError('Invalid document registration acknowledgment')
  return { ...scopeOf(value), childOperationId: value.childOperationId, revisionId: value.revisionId, callId: value.callId,
    attemptId: value.attemptId, sequence: value.sequence, registered: true }
}
