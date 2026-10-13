import { parseNormalTranslationTarget, type NormalTranslationTarget } from './normal-translation.js'
import { parseTranslationMaterialEnvelope, type TranslationMaterialEnvelope } from './translation-material.js'
import { parseTranslationSourceScope, type TranslationSourceScope } from './translation-sources.js'
import { sourceCodePointLength } from './translation-source-read.js'
import { parseDocumentChunkPlan, parseDocumentCallContextReference, parseDocumentCallRecord, sameVersionReference,
  type DocumentChunkPlan, type DocumentCallContextReference, type DocumentCallRecord, type DocumentTaskStatus,
  type VersionReference } from './translation-batch.js'

export const MAX_DOCUMENT_OUTPUT_BYTES = 16 * 1024 * 1024
export const MAX_DOCUMENT_EXECUTION_PACKET_BYTES = 196608
export interface TranslationBatchExecute {
  readonly target: NormalTranslationTarget
  readonly operationId: string
  readonly planRef: VersionReference
  readonly preparationRef: VersionReference
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
  readonly restartExecutable: false
}
export interface DocumentBlockRegistration extends DocumentTaskScope {
  readonly chunkId: string
  readonly childOperationId: string
  readonly attemptId: string | null
  readonly callId: string | null
  readonly revisionId: string
  readonly createdAt: string
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
  packet(value); exact(value, ['target', 'operationId', 'planRef', 'preparationRef']); text(value.operationId)
  return { target: parseNormalTranslationTarget(value.target), operationId: value.operationId,
    planRef: reference(value.planRef), preparationRef: reference(value.preparationRef) }
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
  packet(value); exact(value, ['envelope', 'operationId', 'taskId', 'unitId', 'plan', 'preparationRef', 'contextBindings', 'createdAt'])
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
  return { envelope, operationId: value.operationId, taskId: value.taskId, unitId: value.unitId, plan, preparationRef, contextBindings, createdAt: value.createdAt }
}
export function parseDocumentBlockRegistration(value: unknown): DocumentBlockRegistration {
  packet(value); exact(value, ['scope', 'taskId', 'unitId', 'chunkId', 'childOperationId', 'attemptId', 'callId', 'revisionId', 'createdAt'])
  for (const key of ['chunkId', 'childOperationId', 'revisionId']) text(value[key])
  nullableIdentity(value.attemptId); nullableIdentity(value.callId); time(value.createdAt)
  if ((value.attemptId === null) !== (value.callId === null)) throw new TypeError('Document call registration identities disagree')
  return { ...scopeOf(value), chunkId: value.chunkId as string, childOperationId: value.childOperationId as string,
    attemptId: value.attemptId, callId: value.callId, revisionId: value.revisionId as string, createdAt: value.createdAt }
}
export function parseDocumentTaskEvent(value: unknown): DocumentTaskEvent {
  packet(value); exact(value, ['scope', 'taskId', 'unitId', 'taskSequence', 'childOperationId', 'sequence', 'revisionId', 'at', 'kind'], ['callRecord', 'delta', 'status', 'usage', 'sha256'])
  integer(value.taskSequence); integer(value.sequence); text(value.childOperationId); text(value.revisionId); time(value.at)
  const identity: DocumentEventIdentity = { ...scopeOf(value), taskSequence: value.taskSequence, childOperationId: value.childOperationId,
    sequence: value.sequence, revisionId: value.revisionId, at: value.at }
  const base = ['scope', 'taskId', 'unitId', 'taskSequence', 'childOperationId', 'sequence', 'revisionId', 'at', 'kind']
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
  packet(value); exact(value, ['scope', 'taskId', 'unitId', 'operationId', 'sourceVersion', 'planRef', 'preparationRef', 'taskSequence', 'status', 'storage', 'storageError', 'restartExecutable'])
  text(value.operationId); integer(value.sourceVersion); integer(value.taskSequence, 0)
  if (!['running', 'completed', 'failed', 'cancelled', 'unknown', 'interrupted'].includes(value.status as string) || !['saved', 'runtime_only'].includes(value.storage as string) || value.restartExecutable !== false) throw new TypeError('Invalid document receipt status')
  if (value.storageError !== null) text(value.storageError, 1000)
  return { ...scopeOf(value), operationId: value.operationId, sourceVersion: value.sourceVersion, planRef: reference(value.planRef), preparationRef: reference(value.preparationRef),
    taskSequence: value.taskSequence, status: value.status as DocumentTaskStatus, storage: value.storage as DocumentTaskReceipt['storage'], storageError: value.storageError as string | null, restartExecutable: false }
}
export function parseDocumentBlockReceipt(value: unknown): DocumentBlockReceipt {
  packet(value); exact(value, ['scope', 'taskId', 'unitId', 'childOperationId', 'revisionId', 'callId', 'attemptId', 'sequence', 'registered'])
  text(value.childOperationId); text(value.revisionId); nullableIdentity(value.callId); nullableIdentity(value.attemptId); integer(value.sequence, 0)
  if (value.registered !== true || (value.callId === null) !== (value.attemptId === null)) throw new TypeError('Invalid document registration acknowledgment')
  return { ...scopeOf(value), childOperationId: value.childOperationId, revisionId: value.revisionId, callId: value.callId,
    attemptId: value.attemptId, sequence: value.sequence, registered: true }
}
