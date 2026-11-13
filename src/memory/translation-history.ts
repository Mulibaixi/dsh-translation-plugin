import { decodeRoute, type ModelRoute } from '../shared/sessions.js'
import { isNormalExchangePromptVersion, parseTranslationCallMetadata, parseTranslationCallFacts, translationCallFacts, type TranslationCallMetadata, type TranslationCallFacts } from '../shared/translation-call.js'
import type { TranslationMaterialEnvelope } from '../shared/translation-material.js'
import { parseRequestContextInput, type RequestContextInput } from '../shared/request-context.js'
import type { NormalTranslationResolution } from '../shared/normal-translation-v2.js'
import { advanceDocumentFinal, createDocumentUnit, currentDocumentFinal, parseDocumentUnit, reduceDocumentUnit,
  restoreDocumentUnit, type DocumentMutation, type NewDocumentUnit } from '../memory/document-task.js'
import type { DocumentRevision, DocumentUnit, DocumentTaskStatus } from '../shared/translation-batch.js'
import { parseSourceIdentity, toSourceIdentity, type SourceIdentity } from '../shared/translation-sources.js'
import { IMAGE_BACKGROUND_LIMIT, imageFileFormat } from '../shared/image-translation.js'
export type { DocumentRevision, DocumentSourceVersion, DocumentSourceHistoryCommit, DocumentUnit } from '../shared/translation-batch.js'
export type { DocumentMutation, NewDocumentUnit } from '../memory/document-task.js'

export type TextRevisionStatus = 'submitting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'interrupted' | 'context_requested' | 'deleted'
export interface TextRevisionDeletion {
  readonly eventId: string
  readonly at: string
  readonly originalStatus: 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'context_requested'
  readonly callFacts: TranslationCallFacts | null
}
export interface TextUnitDeletion {
  readonly eventId: string
  readonly at: string
}
export interface TextRevision {
  readonly id: string
  readonly operationId: string
  readonly order: number
  readonly kind: 'machine' | 'manual' | 'review_edit'
  readonly model: ModelRoute | null
  readonly draftVersion: number | null
  readonly sourceVersion?: number | undefined
  readonly baseRevisionId: string | null
  readonly callRecord: TranslationCallMetadata | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly accepted: boolean
  readonly status: TextRevisionStatus
  readonly text: string
  readonly message: string | null
  readonly deletion: TextRevisionDeletion | null
}
export interface FinalPointer {
  readonly revisionId: string
  readonly selection: 'automatic' | 'user_fixed'
  readonly selectedAt: string
}
export interface TextUnit {
  readonly kind?: 'image' | 'text'
  readonly id: string
  readonly order: number
  /** Current source text. Editable text units keep only one entry in sourceVersions. */
  readonly source: string
  readonly targetLanguage: string
  readonly instruction: string
  readonly sourceVersion?: number | undefined
  readonly sourceVersions: readonly TextSourceVersion[]
  readonly material: TextMaterialIdentity | null
  readonly createdAt: string
  readonly revisions: readonly TextRevision[]
  readonly final: FinalPointer | null
  /** Immutable user deletion; the unit keeps its identity, number and event trail. */
  readonly deletion: TextUnitDeletion | null
}
export interface ImageUnit extends TextUnit {
  readonly kind: 'image'
  readonly original: SourceIdentity | null
  readonly backgroundDescription: string
  readonly sourceVersion?: undefined
}
export function isImageUnit(unit: TranslationUnit): unit is ImageUnit { return 'kind' in unit && unit.kind === 'image' }
export function isEditableTextUnit(unit: TranslationUnit): unit is TextUnit & { readonly kind: 'text'; readonly sourceVersion: number } { return 'kind' in unit && unit.kind === 'text' }
export interface TextSourceVersion {
  readonly version: number
  readonly text: string
  readonly createdAt: string
  readonly operationId: string | null
}
/** Numbered identity only; source, results and real execution facts remain in FileJobsStore. */
export interface FileJobUnit {
  readonly kind: 'file_job'
  readonly id: string
  readonly order: number
  readonly createdAt: string
  readonly sourceVersion: number
  readonly deletion: { readonly eventId: string; readonly at: string; readonly calls?: number; readonly inputTokens?: number | null; readonly outputTokens?: number | null } | null
}
export type TranslationUnit = TextUnit | DocumentUnit | FileJobUnit
export function isFileJobUnit(unit: TranslationUnit): unit is FileJobUnit { return 'kind' in unit && unit.kind === 'file_job' }
export function hasUnitBody(unit: TranslationUnit): unit is TextUnit | DocumentUnit { return !isFileJobUnit(unit) }
export function isDocumentUnit(unit: TranslationUnit): unit is DocumentUnit { return 'kind' in unit && unit.kind === 'document' }
export function isTextUnit(unit: TranslationUnit): unit is TextUnit { return !('kind' in unit) || isEditableTextUnit(unit) || isImageUnit(unit) }
export function isDeletedTextUnit(unit: TranslationUnit): boolean { return isTextUnit(unit) && unit.deletion !== null }
export function isDeletedDocumentUnit(unit: TranslationUnit): boolean { return isDocumentUnit(unit) && unit.deletion !== undefined }
export function isDeletedUnit(unit: TranslationUnit): boolean { return isDocumentUnit(unit) ? unit.deletion !== undefined : unit.deletion !== null }
export interface TextMaterialIdentity {
  readonly materialId: string
  readonly mainSessionId: string
  readonly requestId: string
  readonly draftVersion: number
  readonly model: ModelRoute | null
  readonly maxInputChars: number
}
export interface TranslationEvent {
  readonly mainSessionId?: string
  readonly id: string
  readonly order: number
  readonly type: 'operation.submitted' | 'operation.accepted' | 'operation.retranslation_accepted' | 'operation.updated' | 'operation.call_event' | 'final.selected' | 'operation.restored' | 'revision.manual_saved' | 'revision.review_saved' | 'revision.deleted' | 'file_result.deleted' | 'manifest.deleted' | 'chunks.deleted' | 'source.deleted' | 'unit.deleted' | 'document.deleted' | 'source.corrected' | 'exchange.needs_context' | 'exchange.resolution_registered' | 'exchange.resume_registered' | 'exchange.control' | 'exchange.call_started' | 'exchange.resolved' | 'exchange.invalidated' | 'document.admitted' | 'document.updated' | 'document.restored'
  readonly at: string
  readonly unitId: string | null
  readonly revisionId: string | null
  readonly operationId: string | null
  readonly status: TextRevisionStatus | DocumentTaskStatus | null
  readonly reason: 'advance' | 'user_selection' | 'restored' | 'export' | 'user_deletion' | null
  /** Last ordinary stream receipt applied to this history; absent on quick and legacy facts. */
  readonly normalSequence?: number
  readonly sourceVersion?: number | undefined
  readonly sourceReason?: string
  readonly resultVersion?: number
  readonly chunkRevisionIds?: readonly string[]
  readonly exchangeId?: string
  readonly resolutionId?: string | null
  readonly callId?: string
  readonly contextVersion?: number
  readonly normalV2Sequence?: number
}
export type TranslationExchangeResolution = NormalTranslationResolution
export interface TranslationResumeIntent {
  readonly resolutionId: string
  readonly candidateCallId: string
  readonly contextVersion: number
  readonly status: 'registered' | 'started' | 'unknown'
}
export interface TranslationExchangeRecord {
  readonly mainSessionId: string
  readonly topicId: string
  readonly translationSessionId: string
  readonly unitId: string
  readonly sourceVersion: number
  readonly operationId: string
  readonly callId: string
  readonly contextVersion: number
  readonly exchangeId: string
  readonly version: number
  readonly status: 'open' | 'waiting_user' | 'resuming' | 'resolved' | 'cancelled' | 'unknown'
  readonly questions: RequestContextInput
  readonly resolutions: readonly TranslationExchangeResolution[]
  readonly resumeIntent: TranslationResumeIntent | null
}
/** One browser snapshot; events and final pointers reference the sole revision body. */
export interface TranslationHistory {
  readonly schemaVersion: 11 | 12 | typeof TRANSLATION_HISTORY_SCHEMA_VERSION
  readonly units: readonly TranslationUnit[]
  readonly events: readonly TranslationEvent[]
  readonly exchanges: readonly TranslationExchangeRecord[]
}
export type NewTextUnit = Pick<TextUnit, 'id' | 'source' | 'targetLanguage' | 'instruction' | 'createdAt'>
export type NewTextRevision = Omit<TextRevision, 'order' | 'kind' | 'baseRevisionId' | 'callRecord' | 'sourceVersion' | 'deletion'> & Partial<Pick<TextRevision, 'kind' | 'baseRevisionId' | 'callRecord' | 'sourceVersion'>>
export type TextRevisionPatch = Partial<Pick<TextRevision, 'status' | 'text' | 'message' | 'updatedAt' | 'callRecord'>>

export const TRANSLATION_HISTORY_SCHEMA_VERSION = 13
export function emptyTranslationHistory(): TranslationHistory { return { schemaVersion: 11, units: [], events: [], exchanges: [] } }

type Data = Record<string, unknown>
const statuses: readonly TextRevisionStatus[] = ['submitting', 'running', 'completed', 'failed', 'cancelled', 'unknown', 'interrupted', 'context_requested', 'deleted']
function record(value: unknown): value is Data { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function exact(value: Data, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function text(value: unknown, max: number, required = false): value is string {
  if (typeof value !== 'string' || (required && !value.trim())) return false
  let size = 0
  for (const _ of value) if (++size > max) return false
  return true
}
function identity(value: unknown): value is string { return text(value, 2048, true) }
function time(value: unknown): value is string { return text(value, 40, true) && Number.isFinite(Date.parse(value)) }
function order(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 1 }
function status(value: unknown): value is TextRevisionStatus { return typeof value === 'string' && statuses.includes(value as TextRevisionStatus) }
function eligible(revision: TextRevision): boolean { return revision.accepted && revision.status === 'completed' && !!revision.text.trim() }
export function revisionMatchesCurrentSource(unit: TextUnit, revision: TextRevision): boolean {
  return isEditableTextUnit(unit) || revision.sourceVersion === unit.sourceVersion
}
export function currentFinalRevision(unit: TranslationUnit): TextRevision | undefined {
  if (!isTextUnit(unit) || unit.deletion) return undefined
  if (unit.final?.selection === 'automatic') {
    const latest = [...unit.revisions].reverse().find(revision => revisionMatchesCurrentSource(unit, revision))
    if (!latest || !eligible(latest)) return undefined
  }
  return unit.revisions.find(revision => revision.id === unit.final?.revisionId && revisionMatchesCurrentSource(unit, revision) && eligible(revision))
}
/** The revision a result entry resolves to: the effective final when there is one, otherwise the latest complete revision of the current source version. A failed, running or deleted latest attempt resolves to nothing rather than to an older success. */
export function currentResultRevision(unit: TranslationUnit): TextRevision | undefined {
  if (isDeletedTextUnit(unit)) return undefined
  const final = currentFinalRevision(unit)
  if (final || !isTextUnit(unit)) return final
  const latest = [...unit.revisions].reverse().find(revision => revisionMatchesCurrentSource(unit, revision))
  return latest && eligible(latest) ? latest : undefined
}
export function currentDocumentFinalRevision(unit: TranslationUnit): DocumentRevision | undefined {
  return isDocumentUnit(unit) && !unit.deletion ? currentDocumentFinal(unit) : undefined
}
/** The current task may have no manifest; an earlier task is still only a historical candidate. */
export function currentDocumentCandidateRevision(unit: TranslationUnit): DocumentRevision | undefined {
  if (!isDocumentUnit(unit) || unit.deletion) return undefined
  const task = [...unit.tasks].reverse().find(task => task.sourceVersion === unit.sourceVersion)
  return [...unit.revisions].reverse().find(revision => !revision.deletion && revision.sourceVersion === unit.sourceVersion && revision.taskId === task?.taskId)
}
export function canEditTextRevision(revision: TextRevision): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted', 'context_requested'].includes(revision.status) && !!revision.text.trim()
}

function decodeRevision(value: unknown, schemaVersion = 3, parseCall = true, independentSource = false): TextRevision | undefined {
  const fields = ['id', 'operationId', 'order', 'model', 'draftVersion', 'createdAt', 'updatedAt', 'accepted', 'status', 'text', 'message']
  if (!record(value) || !exact(value, schemaVersion === 1 ? fields : [...fields, 'kind', 'baseRevisionId', 'callRecord', ...(schemaVersion >= 3 && !independentSource ? ['sourceVersion'] : []), ...(schemaVersion >= 8 ? ['deletion'] : [])]) ||
    !identity(value.id) || !identity(value.operationId) || !order(value.order) || !time(value.createdAt) || !time(value.updatedAt) ||
    typeof value.accepted !== 'boolean' || !status(value.status) || !text(value.text, 2_000_000) || !(value.message === null || text(value.message, 1000))) return undefined
  const kind = schemaVersion === 1 ? 'machine' : value.kind
  const baseRevisionId = schemaVersion === 1 ? null : value.baseRevisionId
  let callRecord = schemaVersion === 1 ? null : value.callRecord
  const sourceVersion = schemaVersion >= 3 ? value.sourceVersion : 1
  let deletion: TextRevisionDeletion | null = null
  if (value.status === 'deleted') {
    const removed = value.deletion
    const originalStatuses = schemaVersion >= 10 ? ['completed', 'failed', 'cancelled', 'interrupted', 'context_requested'] : ['completed', 'failed', 'cancelled']
    if (schemaVersion < 8 || !record(removed) || !exact(removed, ['eventId', 'at', 'originalStatus', 'callFacts']) ||
      !identity(removed.eventId) || !time(removed.at) || !originalStatuses.includes(removed.originalStatus as string) ||
      value.text !== '' || value.message !== null || callRecord !== null) return undefined
    let callFacts: TranslationCallFacts | null = null
    try { if (removed.callFacts !== null) callFacts = parseTranslationCallFacts(removed.callFacts) } catch { return undefined }
    deletion = { eventId: removed.eventId, at: removed.at, originalStatus: removed.originalStatus as TextRevisionDeletion['originalStatus'], callFacts }
  } else if (schemaVersion >= 8 && value.deletion !== null) return undefined
  if (!independentSource && !order(sourceVersion)) return undefined
  if (kind !== 'machine' && kind !== 'manual' && !(schemaVersion >= 13 && kind === 'review_edit')) return undefined
  const model = decodeRoute(value.model)
  if (kind === 'machine' ? (!model || !order(value.draftVersion) || baseRevisionId !== null) :
    (model !== null || value.draftVersion !== null || !identity(baseRevisionId) || callRecord !== null || (deletion?.originalStatus ?? value.status) !== 'completed' || !value.accepted || deletion?.callFacts != null)) return undefined
  if (deletion?.originalStatus === 'completed' && !value.accepted) return undefined
  if ((value.status === 'completed' && (!value.accepted || !value.text.trim())) || (!value.accepted && value.text !== '')) return undefined
  if (parseCall && callRecord !== null) {
    try { callRecord = parseTranslationCallMetadata(callRecord) } catch { return undefined }
  }
  return { ...value, kind, model, baseRevisionId, callRecord, ...(independentSource ? {} : { sourceVersion }), deletion } as unknown as TextRevision
}

function decodeMaterial(value: unknown): TextMaterialIdentity | null | undefined {
  if (value === null) return null
  if (!record(value) || !exact(value, ['materialId', 'mainSessionId', 'requestId', 'draftVersion', 'model', 'maxInputChars']) ||
    !identity(value.materialId) || !identity(value.mainSessionId) || !identity(value.requestId) || !order(value.draftVersion) ||
    !order(value.maxInputChars) || value.maxInputChars > 200000) return undefined
  const model = decodeRoute(value.model)
  return model === undefined ? undefined : { ...value, model } as unknown as TextMaterialIdentity
}

function decodeExchangeResolution(value: unknown): TranslationExchangeResolution | undefined {
  if (!record(value)) return undefined
  if (value.kind === 'answer') {
    if (!exact(value, ['resolutionId', 'observedVersion', 'kind', 'answerText', 'organizedRequirements', 'references']) || !identity(value.resolutionId) || !order(value.observedVersion) ||
      !text(value.answerText, 32768) || !text(value.organizedRequirements, 32768) || (!value.answerText.trim() && !value.organizedRequirements.trim()) ||
      new TextEncoder().encode(value.answerText + value.organizedRequirements).byteLength > 32768 || !Array.isArray(value.references) || value.references.length > 32) return undefined
    const ids = new Set<string>(), references: { id: string; version: number }[] = []
    for (const raw of value.references) {
      if (!record(raw) || !exact(raw, ['id', 'version']) || !identity(raw.id) || !order(raw.version) || ids.has(raw.id)) return undefined
      ids.add(raw.id); references.push({ id: raw.id, version: raw.version as number })
    }
    return { resolutionId: value.resolutionId, observedVersion: value.observedVersion as number, kind: 'answer', answerText: value.answerText,
      organizedRequirements: value.organizedRequirements, references }
  }
  if ((value.kind !== 'defer' && value.kind !== 'abort') || !exact(value, ['resolutionId', 'observedVersion', 'kind', 'reason']) ||
    !identity(value.resolutionId) || !order(value.observedVersion) || !text(value.reason, 4096) || new TextEncoder().encode(value.reason).byteLength > 4096) return undefined
  return { resolutionId: value.resolutionId, observedVersion: value.observedVersion as number, kind: value.kind, reason: value.reason }
}

function decodeExchange(value: unknown, units: readonly TranslationUnit[]): TranslationExchangeRecord | undefined {
  if (!record(value) || !exact(value, ['mainSessionId', 'topicId', 'translationSessionId', 'unitId', 'sourceVersion', 'operationId', 'callId', 'contextVersion', 'exchangeId', 'version', 'status', 'questions', 'resolutions', 'resumeIntent']) ||
    !identity(value.mainSessionId) || !identity(value.topicId) || !identity(value.translationSessionId) || !identity(value.unitId) || !order(value.sourceVersion) ||
    !identity(value.operationId) || !identity(value.callId) || !order(value.contextVersion) || !identity(value.exchangeId) || !order(value.version) ||
    !['open', 'waiting_user', 'resuming', 'resolved', 'cancelled', 'unknown'].includes(value.status as string) || !Array.isArray(value.resolutions) || value.resolutions.length > 20) return undefined
  const unit = units.filter(isTextUnit).find(item => item.id === value.unitId), source = unit?.sourceVersions.find(item => item.version === value.sourceVersion)
  const revision = unit?.revisions.find(item => item.id === value.callId)
  const priorEditableSource = !!unit && isEditableTextUnit(unit) && (value.sourceVersion as number) < unit.sourceVersion && ['resolved', 'cancelled'].includes(value.status as string)
  if (!unit || (!source && !priorEditableSource) || !revision || revision.operationId !== value.operationId || (!isEditableTextUnit(unit) && revision.sourceVersion !== value.sourceVersion) ||
    !isNormalExchangePromptVersion((revision.callRecord ?? revision.deletion?.callFacts)?.promptVersion)) return undefined
  let questions: RequestContextInput
  // A deleted unit keeps its settled exchanges as audit while clearing the source body.
  try { questions = parseRequestContextInput(value.questions, unit.deletion || !source ? Number.MAX_SAFE_INTEGER : Array.from(source.text).length) } catch { return undefined }
  const resolutions = value.resolutions.map(decodeExchangeResolution)
  if (resolutions.some(item => !item) || new Set(resolutions.map(item => item!.resolutionId)).size !== resolutions.length ||
    resolutions.some((item, index) => resolutions.slice(0, index).some(previous => previous!.observedVersion === item!.observedVersion))) return undefined
  let resumeIntent: TranslationResumeIntent | null = null
  if (value.resumeIntent !== null) {
    const intent = value.resumeIntent, resolutionId = record(intent) ? intent.resolutionId : undefined
    if (!record(intent) || !exact(intent, ['resolutionId', 'candidateCallId', 'contextVersion', 'status']) || !identity(resolutionId) || !identity(intent.candidateCallId) ||
      !order(intent.contextVersion) || intent.contextVersion !== (value.contextVersion as number) + 1 || !['registered', 'started', 'unknown'].includes(intent.status as string) ||
      !resolutions.some(item => item?.resolutionId === resolutionId && item.kind === 'answer')) return undefined
    if (intent.status === 'started' && !unit.revisions.some(item => item.id === intent.candidateCallId && item.operationId === value.operationId && (isEditableTextUnit(unit) || item.sourceVersion === value.sourceVersion))) return undefined
    resumeIntent = { resolutionId, candidateCallId: intent.candidateCallId, contextVersion: intent.contextVersion as number, status: intent.status as TranslationResumeIntent['status'] }
  }
  return { mainSessionId: value.mainSessionId, topicId: value.topicId, translationSessionId: value.translationSessionId, unitId: value.unitId,
    sourceVersion: value.sourceVersion as number, operationId: value.operationId, callId: value.callId, contextVersion: value.contextVersion as number,
    exchangeId: value.exchangeId, version: value.version as number, status: value.status as TranslationExchangeRecord['status'], questions,
    resolutions: resolutions as TranslationExchangeResolution[], resumeIntent }
}

/** Validation does not turn live requests into restored requests. Unknown fields are rejected. */
export function decodeTranslationHistory(value: unknown): TranslationHistory | undefined {
  if (!record(value) || !exact(value, (value.schemaVersion as number) >= 6 ? ['schemaVersion', 'units', 'events', 'exchanges'] : ['schemaVersion', 'units', 'events']) || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].includes(value.schemaVersion as number) || !Array.isArray(value.units) || !Array.isArray(value.events) ||
    ((value.schemaVersion as number) >= 6 && !Array.isArray(value.exchanges))) return undefined
  const units: TranslationUnit[] = [], revisionIds = new Set<string>(), callIds = new Set<string>(), operationUnits = new Map<string, string>(), unitIds = new Set<string>()
  for (const item of value.units) {
    if (record(item) && item.kind === 'file_job') {
      if ((value.schemaVersion as number) < 11 || !exact(item, ['kind', 'id', 'order', 'createdAt', 'sourceVersion', 'deletion']) || !identity(item.id) || unitIds.has(item.id) || item.order !== units.length + 1 || !time(item.createdAt) || !order(item.sourceVersion) || item.deletion !== null && (!record(item.deletion) || !exact(item.deletion, item.deletion.calls === undefined ? ['eventId', 'at'] : ['eventId', 'at', 'calls', 'inputTokens', 'outputTokens']) || !identity(item.deletion.eventId) || !time(item.deletion.at) || item.deletion.calls !== undefined && (!Number.isSafeInteger(item.deletion.calls) || (item.deletion.calls as number) < 0 || [item.deletion.inputTokens, item.deletion.outputTokens].some(value => value !== null && (!Number.isSafeInteger(value) || (value as number) < 0))))) return undefined
      unitIds.add(item.id); units.push(structuredClone(item) as unknown as FileJobUnit); continue
    }
    if (record(item) && item.kind === 'document') {
      if ((value.schemaVersion as number) < 7) return undefined
      let unit: DocumentUnit
      try { unit = parseDocumentUnit(item) } catch { return undefined }
      if (unitIds.has(unit.id) || unit.order !== units.length + 1) return undefined
      for (const revision of [...unit.chunkRevisions, ...unit.revisions]) {
        if (revisionIds.has(revision.id)) return undefined
        revisionIds.add(revision.id)
      }
      for (const chunk of unit.chunkRevisions.filter(chunk => chunk.callId !== null)) {
        if (callIds.has(chunk.callId!)) return undefined
        callIds.add(chunk.callId!)
      }
      for (const operationId of documentOperationIds(unit)) {
        if (operationUnits.has(operationId) && operationUnits.get(operationId) !== unit.id) return undefined
        operationUnits.set(operationId, unit.id)
      }
      unitIds.add(unit.id); units.push(unit); continue
    }
    const schemaVersion = value.schemaVersion as number
    const image = record(item) && item.kind === 'image'
    const editable = record(item) && item.kind === 'text'
    if (editable && schemaVersion < 12) return undefined
    const sourceFields = image ? ['kind', 'original', 'backgroundDescription', 'material', ...(Object.hasOwn(item, 'sourceVersions') ? ['sourceVersions'] : [])]
      : schemaVersion >= 3 ? ['sourceVersion', 'sourceVersions', 'material', ...(editable ? ['kind'] : [])] : []
    if (!record(item) || !exact(item, ['id', 'order', ...((image || schemaVersion < 3 || Object.hasOwn(item, 'source')) ? ['source'] : []), 'targetLanguage', 'instruction', 'createdAt', 'revisions', 'final', ...sourceFields, ...(schemaVersion >= 10 ? ['deletion'] : [])]) ||
      !identity(item.id) || unitIds.has(item.id) || item.order !== units.length + 1 || (schemaVersion < 3 && !text(item.source, 200000, true)) || !text(item.targetLanguage, 80, true) ||
      !text(item.instruction, 4000) || !time(item.createdAt) || !Array.isArray(item.revisions)) return undefined
    let deletion: TextUnitDeletion | null = null
    if (schemaVersion >= 10 && item.deletion !== null) {
      const removed = item.deletion
      if (!record(removed) || !exact(removed, ['eventId', 'at']) || !identity(removed.eventId) || !time(removed.at)) return undefined
      deletion = { eventId: removed.eventId, at: removed.at }
    }
    const material = schemaVersion >= 3 ? decodeMaterial(item.material) : null
    const sourceVersion = image ? undefined : schemaVersion >= 3 ? item.sourceVersion : 1
    const sourceVersions: TextSourceVersion[] = []
    let original: SourceIdentity | null = null
    if (material === undefined || !image && (!order(sourceVersion) || (!item.revisions.length && material === null && !deletion))) return undefined
    if (image) {
      if (schemaVersion < 12 || !text(item.source, 200000) || !text(item.backgroundDescription, IMAGE_BACKGROUND_LIMIT) ||
        Object.hasOwn(item, 'sourceVersions') && (!Array.isArray(item.sourceVersions) || item.sourceVersions.length !== 0)) return undefined
      if (deletion) {
        if (item.original !== null || item.source !== '' || item.backgroundDescription !== '') return undefined
      } else {
        try { original = parseSourceIdentity(item.original) } catch { return undefined }
        if (!imageFileFormat(original.name) || original.encoding !== 'binary') return undefined
      }
    } else if (schemaVersion >= 3) {
      if (!Array.isArray(item.sourceVersions) || !item.sourceVersions.length || editable && item.sourceVersions.length !== 1) return undefined
      for (const raw of item.sourceVersions) {
        if (!record(raw) || !exact(raw, ['version', 'text', 'createdAt', 'operationId']) || raw.version !== (editable ? sourceVersion : sourceVersions.length + 1) ||
          !text(raw.text, 200000, !deletion) || !time(raw.createdAt) || !(raw.operationId === null || identity(raw.operationId))) return undefined
        sourceVersions.push({ ...raw } as unknown as TextSourceVersion)
      }
      if ((!editable && sourceVersion !== sourceVersions.length) || (Object.hasOwn(item, 'source') && item.source !== sourceVersions.at(-1)!.text)) return undefined
    } else sourceVersions.push({ version: 1, text: item.source as string, createdAt: item.createdAt, operationId: null })
    const revisions: TextRevision[] = []
    for (const raw of item.revisions) {
      const revision = decodeRevision(raw, schemaVersion, true, image || editable)
      if (!revision || revision.order !== revisions.length + 1 || revisionIds.has(revision.id) ||
        (operationUnits.has(revision.operationId) && (schemaVersion < 4 || operationUnits.get(revision.operationId) !== item.id))) return undefined
      if (revision.kind === 'machine' && callIds.has(revision.id)) return undefined
      if (revision.kind === 'machine') callIds.add(revision.id)
      if (!image && !editable && !sourceVersions.some(source => source.version === revision.sourceVersion)) return undefined
      if (revision.kind === 'manual' && !revisions.some(base => base.id === revision.baseRevisionId && base.sourceVersion === revision.sourceVersion &&
        (canEditTextRevision(base) || deletion !== null && base.status === 'deleted'))) return undefined
      if (revision.kind === 'review_edit' && (image || !revisions.some(base => base.id === revision.baseRevisionId &&
        base.sourceVersion === revision.sourceVersion && (eligible(base) || deletion !== null && base.deletion?.originalStatus === 'completed')))) return undefined
      revisions.push(revision); revisionIds.add(revision.id); operationUnits.set(revision.operationId, item.id)
    }
    // A deleted unit keeps its number and audit identities; every version must be a content-free tombstone.
    if (deletion && (item.final !== null || revisions.some(revision => revision.status !== 'deleted'))) return undefined
    // Units are admitted material; unaccepted new drafts remain in the transient execution layer.
    if (revisions.length && !revisions[0]!.accepted) return undefined
    let final: FinalPointer | null = null
    if (item.final !== null) {
      const pointer = item.final
      if (!record(pointer) || !exact(pointer, ['revisionId', 'selection', 'selectedAt']) || !identity(pointer.revisionId) ||
        !['automatic', 'user_fixed'].includes(pointer.selection as string) || !time(pointer.selectedAt) ||
        !revisions.some(revision => revision.id === pointer.revisionId && eligible(revision))) return undefined
      final = { revisionId: pointer.revisionId, selection: pointer.selection as FinalPointer['selection'], selectedAt: pointer.selectedAt }
    }
    unitIds.add(item.id)
    const common = { id: item.id, order: item.order as number, targetLanguage: item.targetLanguage, instruction: item.instruction,
      sourceVersions, material, createdAt: item.createdAt, revisions, final, deletion }
    if (image) {
      const unit: ImageUnit = { ...common, kind: 'image', original, source: item.source as string, backgroundDescription: item.backgroundDescription as string }
      units.push(unit)
    } else {
      const version = sourceVersion as number
      units.push({ ...common, ...(editable ? { kind: 'text' as const } : {}), sourceVersion: version, source: sourceVersions.at(-1)!.text })
    }
  }
  const events: TranslationEvent[] = [], eventIds = new Set<string>()
  for (const item of value.events) {
    const eventUnit = record(item) && units.find(unit => unit.id === item.unitId)
    const deletedDocument = !!eventUnit && isDocumentUnit(eventUnit) && !!eventUnit.deletion
    if (!record(item) || !exact(item, ['id', 'order', 'type', 'at', ...(Object.hasOwn(item, 'mainSessionId') ? ['mainSessionId'] : []), 'unitId', 'revisionId', 'operationId', 'status', 'reason', ...((value.schemaVersion as number) >= 4 && Object.hasOwn(item, 'normalSequence') ? ['normalSequence'] : []),
      ...((value.schemaVersion as number) >= 5 ? ['sourceVersion', 'sourceReason'].filter(field => Object.hasOwn(item, field)) : []),
      ...((value.schemaVersion as number) >= 6 ? ['exchangeId', 'resolutionId', 'callId', 'contextVersion', 'normalV2Sequence'].filter(field => Object.hasOwn(item, field)) : []),
      ...((value.schemaVersion as number) >= 11 ? ['resultVersion', 'chunkRevisionIds'].filter(field => Object.hasOwn(item, field)) : [])]) ||
      (Object.hasOwn(item, 'resultVersion') && (item.type !== 'file_result.deleted' || !order(item.resultVersion))) ||
      (Object.hasOwn(item, 'chunkRevisionIds') && (item.type !== 'chunks.deleted' || !Array.isArray(item.chunkRevisionIds) || !item.chunkRevisionIds.length || item.chunkRevisionIds.some(id => !identity(id)) || new Set(item.chunkRevisionIds).size !== item.chunkRevisionIds.length)) ||
      (Object.hasOwn(item, 'mainSessionId') && !identity(item.mainSessionId)) ||
      (Object.hasOwn(item, 'normalSequence') && (!order(item.normalSequence) || item.type !== 'operation.updated' || !identity(item.operationId))) ||
      (Object.hasOwn(item, 'normalV2Sequence') && (!order(item.normalV2Sequence) || !['operation.call_event', 'exchange.needs_context', 'exchange.resolution_registered', 'exchange.resume_registered', 'exchange.control', 'exchange.call_started', 'exchange.resolved', 'exchange.invalidated'].includes(item.type as string) || !identity(item.operationId) || !identity(item.callId) || !order(item.contextVersion))) ||
      (Object.hasOwn(item, 'sourceVersion') && (!order(item.sourceVersion) || !deletedDocument && !(item.type === 'source.deleted' && eventUnit && isFileJobUnit(eventUnit)) &&
        !(eventUnit && isEditableTextUnit(eventUnit) ? (item.sourceVersion as number) <= eventUnit.sourceVersion : eventUnit && hasUnitBody(eventUnit) && eventUnit.sourceVersions.some(source => source.version === item.sourceVersion)))) ||
      (Object.hasOwn(item, 'sourceReason') && (item.type !== 'source.corrected' || !text(item.sourceReason, 1000))) ||
      (item.type === 'source.corrected' && (!order(item.sourceVersion) || item.revisionId !== null || !identity(item.operationId) || !text(item.sourceReason, 1000))) || !identity(item.id) || eventIds.has(item.id) ||
      item.order !== events.length + 1 || !['operation.submitted', 'operation.accepted', 'operation.retranslation_accepted', 'operation.updated', 'operation.call_event', 'final.selected', 'operation.restored', 'revision.manual_saved', 'source.corrected', 'exchange.needs_context', 'exchange.resolution_registered', 'exchange.resume_registered', 'exchange.control', 'exchange.call_started', 'exchange.resolved', 'exchange.invalidated', ...((value.schemaVersion as number) >= 7 ? ['document.admitted', 'document.updated', 'document.restored'] : []), ...((value.schemaVersion as number) >= 8 ? ['revision.deleted'] : []), ...((value.schemaVersion as number) >= 10 ? ['unit.deleted', 'document.deleted'] : []), ...((value.schemaVersion as number) >= 11 ? ['file_result.deleted', 'manifest.deleted', 'chunks.deleted', 'source.deleted'] : []), ...((value.schemaVersion as number) >= 13 ? ['revision.review_saved'] : [])].includes(item.type as string) || !time(item.at) ||
      !(item.unitId === null || (identity(item.unitId) && unitIds.has(item.unitId))) || !(item.revisionId === null || (identity(item.revisionId) && (revisionIds.has(item.revisionId) || deletedDocument))) ||
      !(item.operationId === null || identity(item.operationId)) || !(item.status === null || status(item.status) || String(item.type).startsWith('document.') && ['paused', 'waiting_context', 'waiting_user'].includes(item.status as string)) || !(item.reason === null || ['advance', 'user_selection', 'restored', 'export', ...((value.schemaVersion as number) >= 8 ? ['user_deletion'] : [])].includes(item.reason as string)) ||
      (item.status === 'deleted' || item.reason === 'user_deletion') && !['revision.deleted', 'unit.deleted', 'document.deleted', 'file_result.deleted', 'manifest.deleted', 'chunks.deleted', 'source.deleted'].includes(item.type as string)) return undefined
    if (item.type === 'revision.review_saved' && (!identity(item.revisionId) || item.reason !== null)) return undefined
    if (item.type === 'chunks.deleted' && (!eventUnit || !isDocumentUnit(eventUnit) || !Array.isArray(item.chunkRevisionIds) || item.revisionId !== null || item.operationId !== null || item.status !== 'deleted' || item.reason !== 'user_deletion' || !deletedDocument && item.chunkRevisionIds.some(id => !eventUnit.chunkRevisions.some(chunk => chunk.id === id && chunk.deletion?.eventId === item.id && chunk.deletion?.at === item.at)))) return undefined
    if (item.type === 'manifest.deleted' && (!eventUnit || !isDocumentUnit(eventUnit) || !identity(item.revisionId) || item.operationId !== null || item.status !== 'deleted' || item.reason !== 'user_deletion' || !deletedDocument && !eventUnit.revisions.some(revision => revision.id === item.revisionId && revision.deletion?.eventId === item.id && revision.deletion?.at === item.at))) return undefined
    if (item.type === 'file_result.deleted' && (!units.some(unit => isFileJobUnit(unit) && unit.id === item.unitId) || !order(item.resultVersion) || item.revisionId !== null || item.operationId !== null || item.status !== 'deleted' || item.reason !== 'user_deletion')) return undefined
    if (item.type === 'source.deleted' && (!eventUnit || !(isDocumentUnit(eventUnit) || isFileJobUnit(eventUnit)) || !order(item.sourceVersion) || item.revisionId !== null || item.operationId !== null || item.status !== 'deleted' || item.reason !== 'user_deletion' || isDocumentUnit(eventUnit) && !deletedDocument && !eventUnit.sourceVersions.some(source => source.version === item.sourceVersion && source.deletion?.eventId === item.id && source.deletion?.at === item.at))) return undefined
    const exchangeEvent = String(item.type).startsWith('exchange.')
    if (item.type === 'document.deleted') {
      const unit = units.find(unit => unit.id === item.unitId)
      if (!unit || !isDocumentUnit(unit) || !unit.deletion || item.revisionId !== null || item.operationId !== null || item.status !== 'deleted' ||
        item.reason !== 'user_deletion' || item.id !== unit.deletion.eventId || item.at !== unit.deletion.at) return undefined
    } else if (String(item.type).startsWith('document.') && !deletedDocument) {
      const unit = units.find(unit => unit.id === item.unitId)
      if (!unit || !isDocumentUnit(unit) || item.status !== null || !order(item.sourceVersion) ||
        (item.operationId !== null && !documentOperationIds(unit).includes(item.operationId as string)) ||
        (item.type === 'document.restored' ? item.operationId !== null || item.revisionId !== null || item.reason !== 'restored' : item.reason !== null) ||
        (item.type === 'document.admitted' && (item.revisionId !== null || !unit.tasks.some(task => task.operationId === item.operationId && task.sourceVersion === item.sourceVersion)))) return undefined
    }
    if (exchangeEvent ? ((value.schemaVersion as number) < 6 || !identity(item.exchangeId) || !identity(item.callId) || !order(item.contextVersion) ||
      !(item.resolutionId === null || identity(item.resolutionId)) || !identity(item.operationId) || !identity(item.unitId)) :
      ['exchangeId', 'resolutionId'].some(field => Object.hasOwn(item, field)) || (item.type !== 'operation.call_event' && ['callId', 'contextVersion'].some(field => Object.hasOwn(item, field)))) return undefined
    if (item.revisionId !== null && !deletedDocument && item.type !== 'manifest.deleted') {
      const unit = units.filter(hasUnitBody).find(unit => unit.id === item.unitId), revision = unit?.revisions.find(revision => revision.id === item.revisionId)
      if (!revision || !unit || item.operationId !== revisionOperationId(unit, revision) || (!isEditableTextUnit(unit) && item.sourceVersion !== undefined && item.sourceVersion !== revision.sourceVersion)) return undefined
      if (isTextUnit(unit)) {
        const textRevision = revision as TextRevision, originalStatus = textRevision.deletion?.originalStatus ?? textRevision.status
        if ((item.status === 'completed' || item.type === 'final.selected' || item.type === 'revision.manual_saved') && originalStatus !== 'completed') return undefined
        if (item.type === 'revision.review_saved' && (textRevision.kind !== 'review_edit' || item.status !== 'completed')) return undefined
        if (item.type === 'revision.deleted' && (textRevision.status !== 'deleted' || item.id !== textRevision.deletion?.eventId || item.at !== textRevision.deletion.at ||
          item.status !== 'deleted' || item.reason !== 'user_deletion' || !isEditableTextUnit(unit) && item.sourceVersion !== textRevision.sourceVersion)) return undefined
      } else if (item.type === 'revision.deleted' || item.type === 'revision.review_saved') return undefined
    } else if (item.type === 'revision.deleted') return undefined
    if (item.type === 'unit.deleted') {
      const unit = units.find(unit => unit.id === item.unitId)
      if (!unit || isDocumentUnit(unit) || !unit.deletion || item.revisionId !== null || item.operationId !== null ||
        item.status !== 'deleted' || item.reason !== 'user_deletion' || item.id !== unit.deletion.eventId || item.at !== unit.deletion.at) return undefined
    }
    if (typeof item.operationId === 'string' && typeof item.unitId === 'string') {
      if (operationUnits.has(item.operationId) && operationUnits.get(item.operationId) !== item.unitId) return undefined
      operationUnits.set(item.operationId, item.unitId)
    }
    events.push({ ...item } as unknown as TranslationEvent); eventIds.add(item.id)
  }
  const exchanges = (value.schemaVersion as number) >= 6 ? (value.exchanges as unknown[]).map(item => decodeExchange(item, units)) : []
  if (exchanges.some(item => !item) || new Set(exchanges.map(item => item!.exchangeId)).size !== exchanges.length ||
    new Set(exchanges.map(item => JSON.stringify([item!.operationId, item!.callId]))).size !== exchanges.length) return undefined
  for (const event of events.filter(event => event.type.startsWith('exchange.'))) {
    const exchange = exchanges.find(item => item!.exchangeId === event.exchangeId)
    const linkedCall = exchange && units.filter(isTextUnit).find(unit => unit.id === exchange.unitId)?.revisions.find(revision => revision.id === event.callId)
    const registeredCandidate = event.type === 'exchange.resume_registered' && exchange?.resumeIntent?.candidateCallId === event.callId
    if (!exchange || exchange.operationId !== event.operationId || exchange.unitId !== event.unitId || (!linkedCall && !registeredCandidate) || (linkedCall && linkedCall.operationId !== exchange.operationId) ||
      (!['exchange.call_started', 'exchange.resume_registered'].includes(event.type) && (exchange.callId !== event.callId || exchange.contextVersion !== event.contextVersion)) ||
      (['exchange.call_started', 'exchange.resume_registered'].includes(event.type) && event.contextVersion !== exchange.contextVersion + 1) ||
      (event.resolutionId !== null && !exchange.resolutions.some(resolution => resolution.resolutionId === event.resolutionId))) return undefined
  }
  for (const unit of units.filter(isTextUnit)) for (const revision of unit.revisions) if (revision.deletion &&
    events.filter(event => event.type === 'revision.deleted' && event.revisionId === revision.id && event.id === revision.deletion!.eventId).length !== 1) return undefined
  for (const unit of units.filter(isTextUnit)) {
    const deletion = unit.deletion
    if (deletion && events.filter(event => event.type === 'unit.deleted' && event.unitId === unit.id && event.id === deletion.eventId).length !== 1) return undefined
  }
  for (const unit of units.filter(isFileJobUnit)) if (unit.deletion?.calls !== undefined && events.filter(event => event.type === 'unit.deleted' && event.unitId === unit.id && event.id === unit.deletion!.eventId).length !== 1) return undefined
  for (const unit of units.filter(isDocumentUnit)) {
    const deletion = unit.deletion
    if (deletion && events.filter(event => event.type === 'document.deleted' && event.unitId === unit.id && event.id === deletion.eventId).length !== 1) return undefined
  }
  return { schemaVersion: value.schemaVersion === 13 ? 13 : value.schemaVersion === 12 ? 12 : 11, units, events, exchanges: exchanges as TranslationExchangeRecord[] }
}

/** Version records own source bodies; storage and full-record exports omit the compatibility projection. */
export function persistedTranslationHistory(history: TranslationHistory): unknown {
  return { ...history, units: history.units.map(unit => {
    if (isImageUnit(unit)) {
      const { sourceVersions: _sources, ...stored } = unit
      return stored
    }
    if (!isTextUnit(unit)) return unit
    const { source: _source, ...stored } = unit
    return stored
  }) }
}

export function appendTranslationEvent(history: TranslationHistory, event: Omit<TranslationEvent, 'order'>): TranslationHistory {
  if (event.sourceVersion === undefined && Object.hasOwn(event, 'sourceVersion')) {
    const { sourceVersion: _version, ...unversioned } = event
    event = unversioned
  }
  if (history.events.some(old => old.id === event.id)) throw new Error('Duplicate translation event')
  return { ...history, events: [...history.events, { ...event, order: history.events.length + 1 }] }
}
function appendExchangeEvent(history: TranslationHistory, exchange: TranslationExchangeRecord, type: Extract<TranslationEvent['type'], `exchange.${string}`>, at: string,
  callId = exchange.callId, contextVersion = exchange.contextVersion, resolutionId: string | null = exchange.resolutions.at(-1)?.resolutionId ?? null): TranslationHistory {
  return appendTranslationEvent(history, { id: `text-event:${history.events.length + 1}`, type, at, unitId: exchange.unitId, revisionId: null,
    operationId: exchange.operationId, status: type === 'exchange.needs_context' ? 'context_requested' : null, reason: null, sourceVersion: exchange.sourceVersion,
    exchangeId: exchange.exchangeId, resolutionId, callId, contextVersion })
}

export function registerTranslationExchange(history: TranslationHistory, input: TranslationExchangeRecord, at: string, normalV2Sequence?: number): TranslationHistory {
  if (!time(at) || input.version !== 1 || input.status !== 'open' || input.resolutions.length || input.resumeIntent !== null) throw new Error('Invalid initial translation exchange')
  const exchange = decodeExchange(input, history.units)
  if (!exchange) throw new Error('Translation exchange scope or source range is invalid')
  const previous = history.exchanges.find(item => item.exchangeId === exchange.exchangeId || (item.operationId === exchange.operationId && item.callId === exchange.callId))
  if (previous) {
    if (JSON.stringify(previous) === JSON.stringify(exchange)) return history
    throw new Error('Translation exchange identity already has different content')
  }
  const next = { ...history, exchanges: [...history.exchanges, exchange] }
  const result = appendExchangeEvent(next, exchange, 'exchange.needs_context', at, exchange.callId, exchange.contextVersion, null)
  return normalV2Sequence === undefined ? result : { ...result, events: result.events.map((event, index) => index === result.events.length - 1 ? { ...event, normalV2Sequence } : event) }
}

export function registerTranslationResolution(history: TranslationHistory, exchangeId: string, input: TranslationExchangeResolution, at: string): TranslationHistory {
  const exchange = history.exchanges.find(item => item.exchangeId === exchangeId), resolution = decodeExchangeResolution(input)
  if (!exchange || !resolution || !time(at)) throw new Error('Translation exchange unavailable')
  const previous = exchange.resolutions.find(item => item.resolutionId === resolution.resolutionId)
  if (previous) {
    if (JSON.stringify(previous) === JSON.stringify(resolution)) return history
    throw new Error('Resolution identity already has different content')
  }
  if (resolution.observedVersion !== exchange.version || !['open', 'waiting_user'].includes(exchange.status)) throw new Error('Translation exchange version changed')
  const status = resolution.kind === 'answer' ? 'resuming' : resolution.kind === 'defer' ? 'waiting_user' : 'cancelled'
  const updated: TranslationExchangeRecord = { ...exchange, version: exchange.version + 1, status, resolutions: [...exchange.resolutions, resolution], resumeIntent: null }
  const next = { ...history, exchanges: history.exchanges.map(item => item.exchangeId === exchangeId ? updated : item) }
  return appendExchangeEvent(next, updated, 'exchange.resolution_registered', at, updated.callId, updated.contextVersion, resolution.resolutionId)
}

export function registerTranslationResume(history: TranslationHistory, exchangeId: string, resolutionId: string, candidateCallId: string, contextVersion: number, at: string, normalV2Sequence?: number): TranslationHistory {
  const exchange = history.exchanges.find(item => item.exchangeId === exchangeId), resolution = exchange?.resolutions.find(item => item.resolutionId === resolutionId)
  if (!exchange || !resolution || resolution.kind !== 'answer' || exchange.status !== 'resuming' || !identity(candidateCallId) || !time(at) || contextVersion !== exchange.contextVersion + 1) throw new Error('Resume intent is not prepared')
  const intent = { resolutionId, candidateCallId, contextVersion, status: 'registered' as const }
  if (exchange.resumeIntent) {
    if (JSON.stringify(exchange.resumeIntent) === JSON.stringify(intent)) return history
    throw new Error('A different resume is already registered')
  }
  const updated = { ...exchange, version: exchange.version + 1, resumeIntent: intent }
  const next = { ...history, exchanges: history.exchanges.map(item => item.exchangeId === exchangeId ? updated : item) }
  const result = appendExchangeEvent(next, updated, 'exchange.resume_registered', at, candidateCallId, contextVersion, resolutionId)
  return normalV2Sequence === undefined ? result : { ...result, events: result.events.map((event, index) => index === result.events.length - 1 ? { ...event, normalV2Sequence } : event) }
}

export function recordTranslationExchangeStatus(history: TranslationHistory, exchangeId: string, status: Extract<TranslationExchangeRecord['status'], 'open' | 'waiting_user' | 'resuming' | 'cancelled' | 'unknown'>,
  at: string, normalV2Sequence?: number): TranslationHistory {
  const exchange = history.exchanges.find(item => item.exchangeId === exchangeId)
  if (!exchange || !time(at)) throw new Error('Translation exchange unavailable')
  const updated = { ...exchange, status }
  const result = appendExchangeEvent({ ...history, exchanges: history.exchanges.map(item => item.exchangeId === exchangeId ? updated : item) }, updated, 'exchange.control', at)
  return normalV2Sequence === undefined ? result : { ...result, events: result.events.map((event, index) => index === result.events.length - 1 ? { ...event, normalV2Sequence } : event) }
}

export function bindTranslationExchangeId(history: TranslationHistory, pendingId: string, exchangeId: string): TranslationHistory {
  if (!identity(exchangeId)) throw new Error('Invalid exchange identity')
  const exchange = history.exchanges.find(item => item.exchangeId === pendingId)
  if (!exchange) {
    if (history.exchanges.some(item => item.exchangeId === exchangeId)) return history
    throw new Error('Pending exchange unavailable')
  }
  if (!pendingId.startsWith('pending:') || history.exchanges.some(item => item.exchangeId === exchangeId)) throw new Error('Exchange identity cannot be rebound')
  return { ...history, exchanges: history.exchanges.map(item => item.exchangeId === pendingId ? { ...item, exchangeId } : item),
    events: history.events.map(event => event.exchangeId === pendingId ? { ...event, exchangeId } : event) }
}

export function recordTranslationResumeStarted(history: TranslationHistory, exchangeId: string, callId: string, contextVersion: number, at: string): TranslationHistory {
  const exchange = history.exchanges.find(item => item.exchangeId === exchangeId), unit = exchange && history.units.filter(isTextUnit).find(item => item.id === exchange.unitId)
  const revision = unit?.revisions.find(item => item.id === callId), resolution = exchange?.resolutions.at(-1)
  if (!exchange || !unit || !revision || !resolution || resolution.kind !== 'answer' || exchange.status !== 'resuming' || !time(at) ||
    contextVersion !== exchange.contextVersion + 1 || revision.operationId !== exchange.operationId || revision.sourceVersion !== exchange.sourceVersion ||
    exchange.resumeIntent?.candidateCallId !== callId || exchange.resumeIntent.resolutionId !== resolution.resolutionId || exchange.resumeIntent.contextVersion !== contextVersion ||
    revision.callRecord?.exchangeContext?.contextVersion !== contextVersion || !revision.callRecord.exchangeContext.resolutionRefs.some(ref => ref.resolutionId === resolution.resolutionId)) throw new Error('Resume call is not registered for this exchange')
  const updated = { ...exchange, version: exchange.version + 1, resumeIntent: { ...exchange.resumeIntent, status: 'started' as const } }
  const next = { ...history, exchanges: history.exchanges.map(item => item.exchangeId === exchangeId ? updated : item) }
  return appendExchangeEvent(next, updated, 'exchange.call_started', at, callId, contextVersion, resolution.resolutionId)
}

export function finishTranslationExchange(history: TranslationHistory, exchangeId: string, result: 'resolved' | 'cancelled' | 'unknown', at: string): TranslationHistory {
  const exchange = history.exchanges.find(item => item.exchangeId === exchangeId)
  if (!exchange || !time(at)) throw new Error('Translation exchange unavailable')
  if (exchange.status === result) return history
  const updated: TranslationExchangeRecord = { ...exchange, version: exchange.version + 1, status: result }
  const next = { ...history, exchanges: history.exchanges.map(item => item.exchangeId === exchangeId ? updated : item) }
  return appendExchangeEvent(next, updated, 'exchange.resolved', at, updated.callId, updated.contextVersion)
}

function event(history: TranslationHistory, unit: TextUnit, revision: TextRevision, type: TranslationEvent['type'], at: string, reason: TranslationEvent['reason'] = null): TranslationHistory {
  return appendTranslationEvent(history, { id: `text-event:${history.events.length + 1}`, type, at, unitId: unit.id, revisionId: revision.id, operationId: revision.operationId, status: revision.status, reason })
}
function findUnit(history: TranslationHistory, unitId: string): TextUnit {
  const unit = history.units.find(unit => unit.id === unitId)
  if (!unit || !isTextUnit(unit)) throw new Error('Text translation unit unavailable')
  return unit
}
function replaceUnit(history: TranslationHistory, unit: TranslationUnit): TranslationHistory { return { ...history, units: history.units.map(old => old.id === unit.id ? unit : old) } }

export function textRevisionDeletionBlockedReason(history: TranslationHistory, unitId: string, revisionId: string): string | undefined {
  const unit = history.units.find(item => item.id === unitId)
  if (!unit || !isTextUnit(unit)) return '此操作仅支持短文本旧版本。'
  const revision = unit.revisions.find(item => item.id === revisionId)
  if (!revision) return '此版本已不可用。'
  if (revision.status === 'deleted') return '此版本已删除。'
  if (!['completed', 'failed', 'cancelled'].includes(revision.status)) return '此版本尚未确认结束，不能删除。'
  if (unit.revisions.at(-1)?.id === revisionId) return '最新版本不能删除。'
  if (unit.final?.revisionId === revisionId) return '当前最终指针仍指向此版本，请先选择其他最终版本。'
  if (unit.revisions.some(item => item.baseRevisionId === revisionId)) return '此版本仍被后续修订引用，不能删除。'
  return undefined
}

/** Remove content without rewriting prior events, identities, order or actual invocation facts. */
export function deleteTextRevision(history: TranslationHistory, unitId: string, revisionId: string, input: { readonly eventId: string; readonly at: string }): TranslationHistory {
  const blocked = textRevisionDeletionBlockedReason(history, unitId, revisionId)
  if (blocked || !identity(input.eventId) || !time(input.at)) throw new Error(blocked ?? 'Invalid revision deletion')
  const unit = findUnit(history, unitId), old = unit.revisions.find(item => item.id === revisionId)!
  const revision: TextRevision = { ...old, status: 'deleted', text: '', message: null, callRecord: null,
    deletion: { eventId: input.eventId, at: input.at, originalStatus: old.status as TextRevisionDeletion['originalStatus'],
      callFacts: old.callRecord === null ? null : translationCallFacts(old.callRecord) } }
  const next = appendTranslationEvent(replaceUnit(history, { ...unit, revisions: unit.revisions.map(item => item.id === revisionId ? revision : item) }), {
    id: input.eventId, type: 'revision.deleted', at: input.at, unitId, revisionId, operationId: revision.operationId,
    status: 'deleted', reason: 'user_deletion', sourceVersion: revision.sourceVersion })
  if (!decodeTranslationHistory(persistedTranslationHistory(next))) throw new Error('Invalid deleted revision facts')
  return next
}

/** A unit is deletable only after all translation and help work has settled. */
export function textUnitDeletionBlockedReason(history: TranslationHistory, unitId: string): string | undefined {
  const unit = history.units.find(item => item.id === unitId)
  if (!unit || !isTextUnit(unit)) return '此操作仅支持短文本单元。'
  if (unit.deletion) return '此单元已删除。'
  if (unit.revisions.some(revision => ['submitting', 'running', 'unknown'].includes(revision.status))) return '该单元仍有未结束的翻译，请先结束或查询。'
  if (history.exchanges.some(item => item.unitId === unitId && ['open', 'waiting_user', 'resuming', 'unknown'].includes(item.status))) return '该单元仍有未结算的求助，请先处理。'
  return undefined
}

/** Tombstone a whole unit: clear bodies, keep its number, events and actual call facts. */
export function deleteTextUnit(history: TranslationHistory, unitId: string, input: { readonly eventId: string; readonly at: string }): TranslationHistory {
  const blocked = textUnitDeletionBlockedReason(history, unitId)
  if (blocked || !identity(input.eventId) || !time(input.at)) throw new Error(blocked ?? 'Invalid unit deletion')
  if (history.events.some(item => item.id === input.eventId)) throw new Error('Duplicate unit deletion event')
  const unit = findUnit(history, unitId)
  let next = history
  const revisions = unit.revisions.map(revision => {
    if (revision.status === 'deleted') return revision
    const revisionEventId = `${input.eventId}:r${revision.order}`
    if (next.events.some(item => item.id === revisionEventId)) throw new Error('Duplicate revision deletion event')
    next = appendTranslationEvent(next, { id: revisionEventId, type: 'revision.deleted', at: input.at, unitId, revisionId: revision.id,
      operationId: revision.operationId, status: 'deleted', reason: 'user_deletion', sourceVersion: revision.sourceVersion })
    return { ...revision, status: 'deleted', text: '', message: null, callRecord: null,
      deletion: { eventId: revisionEventId, at: input.at, originalStatus: revision.status as TextRevisionDeletion['originalStatus'],
        callFacts: revision.callRecord === null ? null : translationCallFacts(revision.callRecord) } } satisfies TextRevision
  })
  const deleted: TextUnit = { ...unit, source: '', instruction: '', sourceVersions: unit.sourceVersions.map(source => ({ ...source, text: '' })),
    ...(isImageUnit(unit) ? { original: null, backgroundDescription: '' } : {}),
    revisions, final: null, deletion: { eventId: input.eventId, at: input.at } }
  next = replaceUnit(next, deleted)
  next = appendTranslationEvent(next, { id: input.eventId, type: 'unit.deleted', at: input.at, unitId, revisionId: null,
    operationId: null, status: 'deleted', reason: 'user_deletion', sourceVersion: unit.sourceVersion })
  if (!decodeTranslationHistory(persistedTranslationHistory(next))) throw new Error('Invalid deleted unit facts')
  return next
}

/** Frozen exports may not deliver content from before a confirmed revision or unit deletion. */
export function revisionDeletionChanged(before: TranslationHistory, current: TranslationHistory | undefined): boolean {
  const deletionTypes = ['revision.deleted', 'unit.deleted', 'document.deleted', 'file_result.deleted', 'manifest.deleted', 'chunks.deleted', 'source.deleted']
  const known = new Set(before.events.filter(item => deletionTypes.includes(item.type)).map(item => item.id))
  return !current || current.events.some(item => deletionTypes.includes(item.type) && !known.has(item.id))
}

const terminalDocumentStatuses: readonly DocumentTaskStatus[] = ['completed', 'failed', 'cancelled', 'interrupted']
export function documentUnitDeletionBlockedReason(history: TranslationHistory, unitId: string): string | undefined {
  const unit = history.units.find(item => item.id === unitId)
  if (!unit || !isDocumentUnit(unit)) return '此操作仅支持整篇文档单元。'
  if (unit.deletion) return '此单元已删除。'
  if (unit.tasks.some(task => !terminalDocumentStatuses.includes(task.status))) return '整篇任务尚未结束，请先结束或查询。'
  if (unit.chunkRevisions.some(chunk => ['running', 'unknown'].includes(chunk.status))) return '仍有未结算的翻译块，请先结束或查询。'
  return undefined
}

/** Whole-document tombstone: content arrays are cleared; call counts and token usage remain as facts. */
export function deleteDocumentUnit(history: TranslationHistory, unitId: string, input: { readonly eventId: string; readonly at: string }): TranslationHistory {
  const blocked = documentUnitDeletionBlockedReason(history, unitId)
  if (blocked || !identity(input.eventId) || !time(input.at)) throw new Error(blocked ?? 'Invalid document unit deletion')
  if (history.events.some(item => item.id === input.eventId)) throw new Error('Duplicate document deletion event')
  const unit = history.units.find(item => item.id === unitId)
  if (!unit || !isDocumentUnit(unit)) throw new Error('Document translation unit unavailable')
  let calls = 0, inputTokens = 0, outputTokens = 0, hasInput = false, hasOutput = false
  for (const chunk of unit.chunkRevisions) {
    if (!chunk.callRecord) continue
    calls++
    if (chunk.callRecord.usage.inputTokens !== null) { inputTokens += chunk.callRecord.usage.inputTokens; hasInput = true }
    if (chunk.callRecord.usage.outputTokens !== null) { outputTokens += chunk.callRecord.usage.outputTokens; hasOutput = true }
  }
  calls = Math.max(calls, unit.tasks.reduce((sum, task) => sum + (task.executionFacts?.actualCalls ?? 0), 0))
  const deleted: DocumentUnit = { kind: 'document', id: unit.id, order: unit.order, targetLanguage: unit.targetLanguage, instruction: '',
    sourceVersion: 1, sourceVersions: [], createdAt: unit.createdAt, preparations: [], plans: [], tasks: [], chunkRevisions: [], revisions: [], final: null,
    deletion: { eventId: input.eventId, at: input.at, calls, inputTokens: hasInput ? inputTokens : null, outputTokens: hasOutput ? outputTokens : null } }
  const next = appendTranslationEvent(replaceUnit(history, deleted), { id: input.eventId, type: 'document.deleted', at: input.at, unitId,
    revisionId: null, operationId: null, status: 'deleted', reason: 'user_deletion' })
  if (!decodeTranslationHistory(persistedTranslationHistory(next))) throw new Error('Invalid deleted document unit facts')
  return next
}

export function unitDeletionBlockedReason(history: TranslationHistory, unitId: string): string | undefined {
  const unit = history.units.find(item => item.id === unitId)
  if (unit && isFileJobUnit(unit)) return unit.deletion ? '此单元已删除。' : undefined
  return unit && isDocumentUnit(unit) ? documentUnitDeletionBlockedReason(history, unitId) : textUnitDeletionBlockedReason(history, unitId)
}
export function deleteUnit(history: TranslationHistory, unitId: string, input: { readonly eventId: string; readonly at: string; readonly callFacts?: { readonly calls: number; readonly inputTokens: number | null; readonly outputTokens: number | null } }): TranslationHistory {
  const unit = history.units.find(item => item.id === unitId)
  if (unit && isFileJobUnit(unit)) {
    if (unit.deletion || !identity(input.eventId) || !time(input.at) || history.events.some(event => event.id === input.eventId)) throw new Error('文件单元不可删除。')
    const deleted = { ...unit, deletion: { eventId: input.eventId, at: input.at, ...(input.callFacts ?? { calls: 0, inputTokens: null, outputTokens: null }) } }
    return appendTranslationEvent(replaceUnit(history, deleted), { id: input.eventId, type: 'unit.deleted', at: input.at, unitId, revisionId: null, operationId: null, status: 'deleted', reason: 'user_deletion' })
  }
  return unit && isDocumentUnit(unit) ? deleteDocumentUnit(history, unitId, input) : deleteTextUnit(history, unitId, input)
}
function newRevision(history: TranslationHistory, data: NewTextRevision, revisionOrder: number, unitId: string): TextRevision {
  const independentSource = history.units.some(unit => unit.id === unitId && (isImageUnit(unit) || isEditableTextUnit(unit)))
  const { sourceVersion = 1, ...fields } = data
  const revision = decodeRevision({ kind: 'machine', baseRevisionId: null, callRecord: null, deletion: null, ...fields,
    ...(independentSource ? {} : { sourceVersion }), order: revisionOrder }, history.schemaVersion, false, independentSource)
  if (!revision || history.units.some(unit => isTextUnit(unit) ? unit.revisions.some(old => old.id === revision.id || (unit.id !== unitId && old.operationId === revision.operationId)) :
    isDocumentUnit(unit) && ([...unit.chunkRevisions, ...unit.revisions].some(old => old.id === revision.id) || documentOperationIds(unit).includes(revision.operationId))) ||
    history.events.some(event => event.operationId === revision.operationId && event.unitId !== unitId)) throw new Error('Invalid or duplicate translation revision')
  return revision
}

/** Latest attempt means admission order, including a later failed or unaccepted revision. */
function advanceFinal(history: TranslationHistory, unit: TextUnit, at: string, reason: 'advance' | 'export' | 'restored' = 'advance'): TranslationHistory {
  if (unit.final?.selection === 'user_fixed' && currentFinalRevision(unit)) return history
  const latest = [...unit.revisions].reverse().find(revision => revisionMatchesCurrentSource(unit, revision))
  if (!latest || !eligible(latest) || unit.final?.revisionId === latest.id) return history
  const updated: TextUnit = { ...unit, final: { revisionId: latest.id, selection: 'automatic', selectedAt: at } }
  return event(replaceUnit(history, updated), updated, latest, 'final.selected', at, reason)
}
/** A settled automatic final follows the unit's newest complete revision; a user-fixed choice is never replaced automatically. */
function advanceSettledAutomaticFinal(history: TranslationHistory, unitId: string, revisionId: string, at: string): TranslationHistory {
  const unit = findUnit(history, unitId)
  if (unit.final?.selection !== 'automatic') return history
  const latest = [...unit.revisions].reverse().find(revision => revisionMatchesCurrentSource(unit, revision))
  return latest?.id === revisionId ? advanceFinal(history, unit, at) : history
}
function advanceUnitFinal(history: TranslationHistory, unit: TranslationUnit, at: string, reason: 'advance' | 'export' = 'advance'): TranslationHistory {
  if (isTextUnit(unit)) return advanceFinal(history, unit, at, reason)
  if (!isDocumentUnit(unit)) return history
  const updated = advanceDocumentFinal(unit, at)
  if (updated === unit) return history
  const revision = updated.revisions.find(item => item.id === updated.final!.revisionId)!
  return documentEvent(replaceUnit(history, updated), updated, 'final.selected', at, revision.id, revisionOperationId(updated, revision), reason)
}

/** Explicit export closes only the last unit; earlier missing finals remain visible. */
export function finalizeLastUnit(history: TranslationHistory, at: string): TranslationHistory {
  if (!time(at)) throw new Error('Invalid final selection time')
  const unit = history.units.at(-1)
  return unit ? advanceUnitFinal(history, unit, at, 'export') : history
}

/** A complete direct result advances its own automatic final without a separate file export. */
export function finalizeCompletedUnit(history: TranslationHistory, unitId: string, at: string, reason: 'advance' | 'export' = 'advance'): TranslationHistory {
  if (!time(at)) throw new Error('Invalid final selection time')
  const unit = history.units.find(unit => unit.id === unitId)
  return unit ? advanceUnitFinal(history, unit, at, reason) : history
}
export function finalizeExportedUnit(history: TranslationHistory, unitId: string, at: string): TranslationHistory { return finalizeCompletedUnit(history, unitId, at, 'export') }

/** Editing appends a complete revision and advances an existing automatic final; user-fixed choices remain explicit. */
export function appendManualRevision(history: TranslationHistory, unitId: string, data: { readonly id: string; readonly baseRevisionId: string; readonly text: string; readonly at: string }): TranslationHistory {
  const unit = findUnit(history, unitId), base = unit.revisions.find(revision => revision.id === data.baseRevisionId)
  if (unit.deletion || !base || !canEditTextRevision(base) || !text(data.text, 2_000_000, true) || !time(data.at)) throw new Error('Manual revision requires nonempty ended source and body')
  return appendEditedRevision(history, unit, base, { ...data, kind: 'manual', operationId: `manual:${data.id}` })
}

export function appendReviewRevision(history: TranslationHistory, unitId: string, data: {
  readonly id: string; readonly operationId: string; readonly baseRevisionId: string; readonly sourceVersion: number; readonly text: string; readonly at: string
}): TranslationHistory {
  const unit = findUnit(history, unitId), base = unit.revisions.at(-1)
  if (unit.deletion || isImageUnit(unit) || unit.sourceVersion !== data.sourceVersion || !base || base.id !== data.baseRevisionId ||
    !revisionMatchesCurrentSource(unit, base) || !eligible(base) || data.text === base.text || history.events.some(event => event.operationId === data.operationId)) {
    throw new Error('Review revision requires the current completed text revision and a new operation')
  }
  return appendEditedRevision({ ...history, schemaVersion: 13 }, unit, base, { ...data, kind: 'review_edit' })
}

function appendEditedRevision(history: TranslationHistory, unit: TextUnit, base: TextRevision, data: {
  readonly id: string; readonly operationId: string; readonly kind: 'manual' | 'review_edit'; readonly text: string; readonly at: string
}): TranslationHistory {
  const revision = newRevision(history, { id: data.id, operationId: data.operationId, kind: data.kind, model: null, draftVersion: null,
    baseRevisionId: base.id, callRecord: null, sourceVersion: base.sourceVersion, createdAt: data.at, updatedAt: data.at, accepted: true, status: 'completed', text: data.text, message: null }, unit.revisions.length + 1, unit.id)
  const updated: TextUnit = { ...unit, revisions: [...unit.revisions, revision] }
  const next = event(replaceUnit(history, updated), updated, revision, data.kind === 'review_edit' ? 'revision.review_saved' : 'revision.manual_saved', data.at)
  return data.kind === 'review_edit' ? finalizeCompletedUnit(next, unit.id, data.at) : advanceSettledAutomaticFinal(next, unit.id, revision.id, data.at)
}

/** Append an admitted new unit and finalize its predecessor in the same conversion. */
export function appendTextUnit(history: TranslationHistory, data: NewTextUnit, revision: NewTextRevision): TranslationHistory {
  if (!revision.accepted || revision.kind !== undefined && revision.kind !== 'machine' || !identity(data.id) || !text(data.source, 200000, true) || !text(data.targetLanguage, 80, true) || !text(data.instruction, 4000) || !time(data.createdAt) ||
    history.units.some(unit => unit.id === data.id)) throw new Error('New text unit requires unique admitted material')
  const unit: TextUnit = { ...data, sourceVersion: 1, sourceVersions: [{ version: 1, text: data.source, createdAt: data.createdAt, operationId: null }], material: null,
    order: history.units.length + 1, revisions: [newRevision(history, revision, 1, data.id)], final: null, deletion: null }
  let next = history.units.length ? advanceUnitFinal(history, history.units.at(-1)!, revision.updatedAt) : history
  next = { ...next, units: [...next.units, unit] }
  return event(next, unit, unit.revisions[0]!, 'operation.accepted', revision.updatedAt)
}

/** Business admission is a material fact; an actual model invocation is appended separately. */
export function appendAdmittedTextUnit(history: TranslationHistory, envelope: TranslationMaterialEnvelope & { readonly kind: 'material' }, operationId: string, at: string, editable = false): TranslationHistory {
  const snapshot = envelope.material, unitId = `unit:${snapshot.materialId}`
  if (snapshot.sourceText === undefined) throw Object.assign(new Error('Asset material requires batch admission'), { code: 'requires_batch' })
  if (!identity(operationId) || !time(at) || snapshot.sourceVersion !== 1 || history.units.some(unit => unit.id === unitId) || history.events.some(event => event.operationId === operationId)) throw new Error('Invalid or duplicate admitted material')
  const unit: TextUnit = { ...(editable ? { kind: 'text' as const } : {}), id: unitId, order: history.units.length + 1, source: snapshot.sourceText, targetLanguage: snapshot.targetLanguage,
    instruction: snapshot.instruction, sourceVersion: snapshot.sourceVersion,
    sourceVersions: [{ version: snapshot.sourceVersion, text: snapshot.sourceText, createdAt: at, operationId: envelope.operationId }],
    material: { materialId: snapshot.materialId, mainSessionId: envelope.mainSessionId, requestId: envelope.requestId, draftVersion: snapshot.draftVersion,
      model: snapshot.model, maxInputChars: snapshot.maxInputChars }, createdAt: at, revisions: [], final: null, deletion: null }
  const previous = history.units.at(-1)
  const next = previous ? advanceUnitFinal(history, previous, at) : history
  return appendTranslationEvent({ ...next, schemaVersion: editable && next.schemaVersion === 11 ? 12 : next.schemaVersion, units: [...next.units, unit] }, { id: `text-event:${next.events.length + 1}`,
    type: 'operation.accepted', mainSessionId: envelope.mainSessionId, at, unitId, revisionId: null, operationId, status: 'submitting', reason: null, sourceVersion: snapshot.sourceVersion })
}

export function appendImageUnit(history: TranslationHistory, envelope: Extract<TranslationMaterialEnvelope, { kind: 'material' }>, at: string): TranslationHistory {
  const material = envelope.material, original = material.sourceRef, id = `unit:${material.materialId}`
  if (!original || original.encoding !== 'binary' || !imageFileFormat(original.name)) throw new Error('Invalid image original')
  const existing = history.units.find(unit => unit.id === id)
  if (existing) {
    if (!isImageUnit(existing) || existing.original?.sha256 !== original.sha256 || existing.deletion) throw new Error('Image unit identity already used')
    return history
  }
  const unit: ImageUnit = {
    kind: 'image', id, order: history.units.length + 1, original: toSourceIdentity(original),
    source: '', sourceVersions: [], backgroundDescription: '', targetLanguage: material.targetLanguage,
    instruction: material.instruction, createdAt: at, revisions: [], final: null, deletion: null,
    material: { materialId: material.materialId, mainSessionId: envelope.mainSessionId, requestId: envelope.requestId,
      draftVersion: material.draftVersion, model: material.model, maxInputChars: material.maxInputChars },
  }
  const previous = history.units.at(-1), next = previous ? advanceUnitFinal(history, previous, at) : history
  return { ...next, schemaVersion: next.schemaVersion === 11 ? 12 : next.schemaVersion, units: [...next.units, unit] }
}

export function updateImageUnit(history: TranslationHistory, unitId: string, changes: { readonly sourceText?: string; readonly backgroundDescription?: string }): TranslationHistory {
  const unit = findUnit(history, unitId)
  if (!isImageUnit(unit) || unit.deletion) throw new Error('Image unit unavailable')
  const updated: ImageUnit = { ...unit, source: changes.sourceText ?? unit.source, backgroundDescription: changes.backgroundDescription ?? unit.backgroundDescription }
  return replaceUnit(history, updated)
}

/** Admit one file segment (or one organized file body) as its own text unit. */
export function appendAdmittedFileUnit(history: TranslationHistory, envelope: TranslationMaterialEnvelope & { readonly kind: 'material' },
  unitId: string, sourceText: string, operationId: string, at: string): TranslationHistory {
  const snapshot = envelope.material, suffix = unitId.slice(`unit:${snapshot.materialId}`.length)
  if (snapshot.sourceRef === undefined || snapshot.sourceVersion !== 1) throw new Error('File admission requires a frozen original')
  const body = suffix === ':body', segment = /^:\d+-\d+$/u.test(suffix)
  if (suffix !== '' && !segment && !body) throw new Error('Invalid file segment suffix')
  const length = Array.from(sourceText).length
  if (segment) {
    const parsed = suffix.slice(1).split('-').map(Number), start = parsed[0]!, end = parsed[1]!
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start || end > snapshot.sourceRef.totalCodePoints || length !== end - start) {
      throw new Error('File segment length does not match its frozen range')
    }
  } else if (body ? length === 0 : length !== snapshot.sourceRef.totalCodePoints) throw new Error('File body length does not match the frozen original')
  if (!identity(operationId) || !time(at) || !text(sourceText, 2_000_000) || history.units.some(unit => unit.id === unitId) ||
    history.events.some(event => event.operationId === operationId)) throw new Error('Invalid or duplicate admitted file material')
  const unit: TextUnit = { kind: 'text', id: unitId, order: history.units.length + 1, source: sourceText, targetLanguage: snapshot.targetLanguage,
    instruction: snapshot.instruction, sourceVersion: snapshot.sourceVersion,
    sourceVersions: [{ version: snapshot.sourceVersion, text: sourceText, createdAt: at, operationId: envelope.operationId }],
    material: { materialId: snapshot.materialId, mainSessionId: envelope.mainSessionId, requestId: envelope.requestId, draftVersion: snapshot.draftVersion,
      model: snapshot.model, maxInputChars: snapshot.maxInputChars }, createdAt: at, revisions: [], final: null, deletion: null }
  const previous = history.units.at(-1)
  const next = previous ? advanceUnitFinal(history, previous, at) : history
  return appendTranslationEvent({ ...next, schemaVersion: next.schemaVersion === 11 ? 12 : next.schemaVersion, units: [...next.units, unit] }, { id: `text-event:${next.events.length + 1}`,
    type: 'operation.accepted', mainSessionId: envelope.mainSessionId, at, unitId, revisionId: null, operationId, status: 'submitting', reason: null, sourceVersion: snapshot.sourceVersion })
}
/** Replace the unit's source while preserving its revision IDs and final selection. */
export function appendSourceCorrection(history: TranslationHistory, unitId: string, data: { readonly operationId: string; readonly expectedVersion: number; readonly text: string; readonly reason: string; readonly at: string }): TranslationHistory {
  const unit = findUnit(history, unitId)
  if (isImageUnit(unit)) throw new Error('Use the image unit text update')
  if (unit.deletion) throw new Error('Deleted translation units cannot be corrected')
  if (unit.sourceVersion !== data.expectedVersion || !identity(data.operationId) || !text(data.text, 200000, true) || data.text === unit.source ||
    !text(data.reason, 1000) || !time(data.at) || history.events.some(event => event.operationId === data.operationId)) throw new Error('Invalid or stale source correction')
  const sourceVersion = data.expectedVersion + 1
  const updated: TextUnit = { ...unit, kind: 'text', source: data.text, sourceVersion,
    sourceVersions: [{ version: sourceVersion, text: data.text, createdAt: data.at, operationId: data.operationId }],
    revisions: unit.revisions.map(({ sourceVersion: _previousVersion, ...revision }) => revision) }
  let next = appendTranslationEvent(replaceUnit({ ...history, schemaVersion: history.schemaVersion === 11 ? 12 : history.schemaVersion }, updated), { id: `text-event:${history.events.length + 1}`, type: 'source.corrected', at: data.at,
    unitId, revisionId: null, operationId: data.operationId, status: null, reason: null, sourceVersion, sourceReason: data.reason })
  for (const exchange of history.exchanges.filter(item => item.unitId === unitId && item.sourceVersion === data.expectedVersion && ['open', 'waiting_user', 'resuming', 'unknown'].includes(item.status))) {
    const cancelled = { ...exchange, version: exchange.version + 1, status: 'cancelled' as const }
    next = { ...next, exchanges: next.exchanges.map(item => item.exchangeId === exchange.exchangeId ? cancelled : item) }
    next = appendExchangeEvent(next, cancelled, 'exchange.invalidated', data.at, cancelled.callId, cancelled.contextVersion, null)
  }
  return next
}

export function acceptUnitRetranslation(history: TranslationHistory, unitId: string, operationId: string, sourceVersion: number | undefined, at: string, mainSessionId?: string): TranslationHistory {
  const unit = findUnit(history, unitId)
  if (unit.deletion) throw new Error('Deleted translation units cannot be retranslated')
  if (!identity(operationId) || !time(at) || unit.sourceVersion !== sourceVersion || history.events.some(event => event.operationId === operationId)) throw new Error('Invalid or duplicate unit operation')
  return appendTranslationEvent(history, { id: `text-event:${history.events.length + 1}`, type: 'operation.retranslation_accepted', ...(mainSessionId ? { mainSessionId } : {}), at,
    unitId, revisionId: null, operationId, status: 'submitting', reason: null, sourceVersion })
}

export function appendTextRevision(history: TranslationHistory, unitId: string, revision: NewTextRevision): TranslationHistory {
  if (revision.kind !== undefined && revision.kind !== 'machine') throw new Error('Use local revision saving for edits')
  const unit = findUnit(history, unitId)
  if (unit.deletion) throw new Error('Deleted translation units cannot receive revisions')
  const added = newRevision(history, { sourceVersion: unit.sourceVersion, ...revision }, unit.revisions.length + 1, unit.id)
  if (!revisionMatchesCurrentSource(unit, added) && !unit.sourceVersions.some(source => source.version === added.sourceVersion)) throw new Error('Translation source version unavailable')
  const updated: TextUnit = { ...unit, revisions: [...unit.revisions, added] }
  const next = event(replaceUnit(history, updated), updated, added, revision.accepted ? 'operation.accepted' : 'operation.submitted', revision.createdAt)
  return advanceSettledAutomaticFinal(next, unitId, added.id, revision.updatedAt)
}

/** Acceptance of a retry stays in its existing unit and never advances another unit. */
export function acceptTextRevision(history: TranslationHistory, unitId: string, revisionId: string, at: string): TranslationHistory {
  const unit = findUnit(history, unitId), old = unit.revisions.find(revision => revision.id === revisionId)
  if (!old) throw new Error('Translation revision unavailable')
  if (old.status === 'deleted') throw new Error('Deleted translation revisions cannot be restored')
  if (old.accepted) return history
  if (!time(at)) throw new Error('Invalid acceptance time')
  const revision: TextRevision = { ...old, accepted: true, updatedAt: at }
  const updated: TextUnit = { ...unit, revisions: unit.revisions.map(old => old.id === revisionId ? revision : old) }
  return event(replaceUnit(history, updated), updated, revision, 'operation.accepted', at)
}

export function updateTextRevision(history: TranslationHistory, unitId: string, revisionId: string, patch: TextRevisionPatch): TranslationHistory {
  const unit = findUnit(history, unitId), old = unit.revisions.find(revision => revision.id === revisionId)
  if (unit.deletion) throw new Error('Deleted translation units cannot be updated')
  if (!old) throw new Error('Translation revision unavailable')
  if (old.status === 'deleted') throw new Error('Deleted translation revisions cannot be restored')
  const revision = decodeRevision({ ...old, ...patch }, history.schemaVersion, false, isImageUnit(unit) || isEditableTextUnit(unit))
  if (!revision) throw new Error('Invalid translation revision')
  if (old.status === revision.status && old.text === revision.text && old.message === revision.message && JSON.stringify(old.callRecord) === JSON.stringify(revision.callRecord)) return history
  // A completed body is a version: another translation belongs in a new revision.
  if (old.status === 'completed' && (old.status !== revision.status || old.text !== revision.text || old.message !== revision.message)) throw new Error('Completed translation revisions are immutable')
  const updated: TextUnit = { ...unit, revisions: unit.revisions.map(old => old.id === revisionId ? revision : old) }
  const next = event(replaceUnit(history, updated), updated, revision, 'operation.updated', revision.updatedAt)
  // A completed retranslation is the unit's newest version: an automatic final follows it without waiting for the next unit.
  return advanceSettledAutomaticFinal(next, unitId, revisionId, revision.updatedAt)
}

export function selectFinalRevision(history: TranslationHistory, unitId: string, revisionId: string, at: string): TranslationHistory {
  const unit = findUnit(history, unitId), revision = unit.revisions.find(revision => revision.id === revisionId)
  if (unit.deletion || !revision || !revisionMatchesCurrentSource(unit, revision) || !eligible(revision) || !time(at)) throw new Error('Only complete eligible translations can be final')
  if (unit.final?.revisionId === revisionId && unit.final.selection === 'user_fixed') return history
  const updated: TextUnit = { ...unit, final: { revisionId, selection: 'user_fixed', selectedAt: at } }
  return event(replaceUnit(history, updated), updated, revision, 'final.selected', at, 'user_selection')
}

/** Restore facts without reconstructing an executable Host capability or replaying requests. */
export function restoreTranslationHistory(history: TranslationHistory, at = new Date().toISOString()): TranslationHistory {
  if (!time(at)) throw new TypeError('Invalid history restoration time')
  let next = history
  for (const admitted of history.events.filter(event => ['operation.accepted', 'operation.retranslation_accepted'].includes(event.type) && event.revisionId === null && event.operationId !== null)) {
    if (!history.units.some(unit => unit.id === admitted.unitId && isTextUnit(unit))) continue
    const unit = findUnit(history, admitted.unitId!)
    if (unit.revisions.some(revision => revision.operationId === admitted.operationId)) continue
    const last = [...history.events].reverse().find(event => event.operationId === admitted.operationId)
    if (!last || !['submitting', 'running', 'unknown'].includes(last.status ?? '')) continue
    next = appendTranslationEvent(next, { id: `text-event:${next.events.length + 1}`, type: 'operation.restored', at,
      unitId: unit.id, revisionId: null, operationId: admitted.operationId, status: 'interrupted', reason: 'restored', sourceVersion: admitted.sourceVersion })
  }
  for (const unit of history.units) {
    if (isFileJobUnit(unit)) continue
    if (isDocumentUnit(unit)) {
      if (unit.deletion) continue
      const restored = restoreDocumentUnit(unit)
      if (restored !== unit) next = documentEvent(replaceUnit(next, restored), restored, 'document.restored', at, null, null, 'restored')
      continue
    }
    for (const revision of unit.revisions) {
    if (!['submitting', 'running', 'unknown'].includes(revision.status)) continue
    const updated: TextRevision = { ...revision, status: 'interrupted', message: revision.status === 'unknown'
      ? '重启前执行结果未知，请核对；未自动重发。' : '上次运行已中断，未自动重发。' }
    const current = findUnit(next, unit.id)
    const restored: TextUnit = { ...current, revisions: current.revisions.map(old => old.id === revision.id ? updated : old) }
    next = event(replaceUnit(next, restored), restored, updated, 'operation.restored', at, 'restored')
    }
    const current = findUnit(next, unit.id)
    if (current.final?.selection === 'automatic') next = advanceFinal(next, current, at, 'restored')
  }
  return next
}

function documentOperationIds(unit: DocumentUnit): readonly string[] {
  return [...unit.tasks.map(task => task.operationId), ...unit.plans.map(plan => plan.operationId),
    ...unit.tasks.flatMap(task => task.executionFacts?.controls.map(control => control.operationId) ?? []),
    ...unit.sourceVersions.flatMap(source => source.operationId === null ? [] : [source.operationId]), ...unit.chunkRevisions.map(chunk => chunk.childOperationId),
    ...(unit.reviewAudits?.map(audit => audit.operationId) ?? [])]
}
function revisionOperationId(unit: TranslationUnit, revision: TextRevision | DocumentRevision): string | undefined {
  if ('operationId' in revision) return revision.operationId
  if (!isDocumentUnit(unit)) return undefined
  if (revision.reviewAuditId) return unit.reviewAudits?.find(audit => audit.id === revision.reviewAuditId)?.operationId
  const manual = revision.parentRevisionId ? revision.entries.map(entry => unit.chunkRevisions.find(chunk => chunk.id === entry.revisionId))
    .find(chunk => chunk && chunk.manualBase?.manifestRevisionId === revision.parentRevisionId && chunk.createdAt === revision.createdAt) : undefined
  return manual?.childOperationId ?? unit.tasks.find(task => task.taskId === revision.taskId)?.operationId
}
function documentEvent(history: TranslationHistory, unit: DocumentUnit, type: TranslationEvent['type'], at: string,
  revisionId: string | null = null, operationId: string | null | undefined = null, reason: TranslationEvent['reason'] = null, sourceVersion = unit.sourceVersion): TranslationHistory {
  return appendTranslationEvent(history, { id: `text-event:${history.events.length + 1}`, type, at, unitId: unit.id, revisionId,
    operationId: operationId ?? null, status: null, reason, sourceVersion })
}
/** Explicit admitted-document domain entry; ordinary material execution still rejects assets. */
export function appendDocumentUnit(history: TranslationHistory, data: NewDocumentUnit): TranslationHistory {
  const old = history.units.find(unit => unit.id === data.id)
  const unit = createDocumentUnit(data, old?.order ?? history.units.length + 1)
  if (old) {
    if (isDocumentUnit(old)) {
      const { historyCommit: _commit, ...source } = old.sourceVersions[0]!
      const { historyCommit: _inputCommit, ...inputSource } = unit.sourceVersions[0]!
      const oldTask = old.tasks.find(task => task.taskId === data.task.taskId)
      if (old.targetLanguage === unit.targetLanguage && old.instruction === unit.instruction && old.createdAt === unit.createdAt &&
        JSON.stringify(source) === JSON.stringify(inputSource) && old.preparations.some(item => JSON.stringify(item) === JSON.stringify(data.preparation)) &&
        old.plans.some(item => JSON.stringify(item) === JSON.stringify(data.plan)) && oldTask &&
        JSON.stringify({ ...oldTask, status: 'running' }) === JSON.stringify(data.task)) return history
    }
    throw new TypeError('Document unit already has different facts')
  }
  const previous = history.units.at(-1), advanced = previous ? advanceUnitFinal(history, previous, data.createdAt) : history
  const next = documentEvent({ ...advanced, units: [...advanced.units, unit] }, unit, 'document.admitted', data.createdAt, null, data.task.operationId)
  if (!decodeTranslationHistory(persistedTranslationHistory(next))) throw new TypeError('Document identities collide with existing history')
  return next
}
export function applyDocumentMutation(history: TranslationHistory, unitId: string, mutation: DocumentMutation, at: string): TranslationHistory {
  if (!time(at)) throw new TypeError('Invalid document event time')
  const unit = history.units.find(item => item.id === unitId)
  if (!unit || !isDocumentUnit(unit)) throw new TypeError('Document unit unavailable')
  const updated = reduceDocumentUnit(unit, mutation)
  if (updated === unit) return history
  const revision = mutation.kind === 'manifest' ? updated.revisions.find(item => item.id === mutation.revision.id)
    : mutation.kind === 'final' ? updated.revisions.find(item => item.id === mutation.revisionId)
    : mutation.kind === 'manual' ? updated.revisions.find(item => item.id === mutation.edit.manifestId)
    : mutation.kind === 'review' ? updated.revisions.find(item => item.id === mutation.audit.reviewedRevisionId) : undefined
  const operationId = revision ? revisionOperationId(updated, revision) : mutation.kind === 'task' ? mutation.task.operationId
    : mutation.kind === 'task_update' || mutation.kind === 'task_facts' ? updated.tasks.find(item => item.taskId === mutation.taskId)?.operationId
    : mutation.kind === 'source' ? mutation.source.operationId : mutation.kind === 'plan' ? mutation.plan.operationId
    : mutation.kind === 'chunk' ? mutation.revision.childOperationId : mutation.kind === 'chunk_update' ? updated.chunkRevisions.find(item => item.id === mutation.revisionId)?.childOperationId
    : mutation.kind === 'review' ? mutation.audit.operationId : null
  const sourceVersion = revision?.sourceVersion ?? (mutation.kind === 'chunk' ? mutation.revision.sourceVersion
    : mutation.kind === 'chunk_update' ? updated.chunkRevisions.find(item => item.id === mutation.revisionId)!.sourceVersion
    : mutation.kind === 'task' ? mutation.task.sourceVersion : mutation.kind === 'task_update' || mutation.kind === 'task_facts' ? updated.tasks.find(item => item.taskId === mutation.taskId)!.sourceVersion
    : mutation.kind === 'plan' ? mutation.plan.sourceVersion : mutation.kind === 'preparation' ? mutation.preparation.sourceVersion : updated.sourceVersion)
  const next = documentEvent(replaceUnit(history, updated), updated, mutation.kind === 'final' ? 'final.selected' : 'document.updated', at,
    revision?.id ?? null, operationId, mutation.kind === 'final' ? 'user_selection' : null, sourceVersion)
  if (!decodeTranslationHistory(persistedTranslationHistory(next))) throw new TypeError('Document mutation conflicts with saved history')
  return next
}
