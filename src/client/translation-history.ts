import { decodeRoute, type ModelRoute } from './sessions.js'
import { parseTranslationCallMetadata, type TranslationCallMetadata } from '../shared/translation-call.js'
import type { TranslationMaterialEnvelope } from '../shared/translation-material.js'

export type TextRevisionStatus = 'submitting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'interrupted'
export interface TextRevision {
  readonly id: string
  readonly operationId: string
  readonly order: number
  readonly kind: 'machine' | 'manual'
  readonly model: ModelRoute | null
  readonly draftVersion: number | null
  readonly sourceVersion: number
  readonly baseRevisionId: string | null
  readonly callRecord: TranslationCallMetadata | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly accepted: boolean
  readonly status: TextRevisionStatus
  readonly text: string
  readonly message: string | null
}
export interface FinalPointer {
  readonly revisionId: string
  readonly selection: 'automatic' | 'user_fixed'
  readonly selectedAt: string
}
export interface TextUnit {
  readonly id: string
  readonly order: number
  /** Compatibility projection of sourceVersions[sourceVersion - 1].text; never persisted twice. */
  readonly source: string
  readonly targetLanguage: string
  readonly instruction: string
  readonly sourceVersion: number
  readonly sourceVersions: readonly TextSourceVersion[]
  readonly material: TextMaterialIdentity | null
  readonly createdAt: string
  readonly revisions: readonly TextRevision[]
  readonly final: FinalPointer | null
}
export interface TextSourceVersion {
  readonly version: number
  readonly text: string
  readonly createdAt: string
  readonly operationId: string | null
}
export interface TextMaterialIdentity {
  readonly materialId: string
  readonly mainSessionId: string
  readonly requestId: string
  readonly draftVersion: number
  readonly model: ModelRoute | null
  readonly maxInputChars: number
}
export interface TranslationEvent {
  readonly id: string
  readonly order: number
  readonly type: 'operation.submitted' | 'operation.accepted' | 'operation.retranslation_accepted' | 'operation.updated' | 'final.selected' | 'operation.restored' | 'revision.manual_saved' | 'source.corrected'
  readonly at: string
  readonly unitId: string | null
  readonly revisionId: string | null
  readonly operationId: string | null
  readonly status: TextRevisionStatus | null
  readonly reason: 'advance' | 'user_selection' | 'restored' | 'export' | null
  /** Last ordinary stream receipt applied to this history; absent on quick and legacy facts. */
  readonly normalSequence?: number
  readonly sourceVersion?: number
  readonly sourceReason?: string
}
/** One browser snapshot; events and final pointers reference the sole revision body. */
export interface TranslationHistory {
  readonly schemaVersion: 5
  readonly units: readonly TextUnit[]
  readonly events: readonly TranslationEvent[]
}
export type NewTextUnit = Pick<TextUnit, 'id' | 'source' | 'targetLanguage' | 'instruction' | 'createdAt'>
export type NewTextRevision = Omit<TextRevision, 'order' | 'kind' | 'baseRevisionId' | 'callRecord' | 'sourceVersion'> & Partial<Pick<TextRevision, 'kind' | 'baseRevisionId' | 'callRecord' | 'sourceVersion'>>
export type TextRevisionPatch = Partial<Pick<TextRevision, 'status' | 'text' | 'message' | 'updatedAt' | 'callRecord'>>

export function emptyTranslationHistory(): TranslationHistory { return { schemaVersion: 5, units: [], events: [] } }

type Data = Record<string, unknown>
const statuses: readonly TextRevisionStatus[] = ['submitting', 'running', 'completed', 'failed', 'cancelled', 'unknown', 'interrupted']
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
export function currentFinalRevision(unit: TextUnit): TextRevision | undefined {
  return unit.revisions.find(revision => revision.id === unit.final?.revisionId && revision.sourceVersion === unit.sourceVersion && eligible(revision))
}
export function canEditTextRevision(revision: TextRevision): boolean {
  return ['completed', 'failed', 'cancelled', 'interrupted'].includes(revision.status) && !!revision.text.trim()
}

function decodeRevision(value: unknown, schemaVersion = 3, parseCall = true): TextRevision | undefined {
  const fields = ['id', 'operationId', 'order', 'model', 'draftVersion', 'createdAt', 'updatedAt', 'accepted', 'status', 'text', 'message']
  if (!record(value) || !exact(value, schemaVersion === 1 ? fields : [...fields, 'kind', 'baseRevisionId', 'callRecord', ...(schemaVersion >= 3 ? ['sourceVersion'] : [])]) ||
    !identity(value.id) || !identity(value.operationId) || !order(value.order) || !time(value.createdAt) || !time(value.updatedAt) ||
    typeof value.accepted !== 'boolean' || !status(value.status) || !text(value.text, 2_000_000) || !(value.message === null || text(value.message, 1000))) return undefined
  const kind = schemaVersion === 1 ? 'machine' : value.kind
  const baseRevisionId = schemaVersion === 1 ? null : value.baseRevisionId
  let callRecord = schemaVersion === 1 ? null : value.callRecord
  const sourceVersion = schemaVersion >= 3 ? value.sourceVersion : 1
  if (!order(sourceVersion)) return undefined
  if (kind !== 'machine' && kind !== 'manual') return undefined
  const model = decodeRoute(value.model)
  if (kind === 'machine' ? (!model || !order(value.draftVersion) || baseRevisionId !== null) :
    (model !== null || value.draftVersion !== null || !identity(baseRevisionId) || callRecord !== null || value.status !== 'completed' || !value.accepted)) return undefined
  if ((value.status === 'completed' && (!value.accepted || !value.text.trim())) || (!value.accepted && value.text !== '')) return undefined
  if (parseCall && callRecord !== null) {
    try { callRecord = parseTranslationCallMetadata(callRecord) } catch { return undefined }
  }
  return { ...value, kind, model, baseRevisionId, callRecord, sourceVersion } as unknown as TextRevision
}

function decodeMaterial(value: unknown): TextMaterialIdentity | null | undefined {
  if (value === null) return null
  if (!record(value) || !exact(value, ['materialId', 'mainSessionId', 'requestId', 'draftVersion', 'model', 'maxInputChars']) ||
    !identity(value.materialId) || !identity(value.mainSessionId) || !identity(value.requestId) || !order(value.draftVersion) ||
    !order(value.maxInputChars) || value.maxInputChars > 200000) return undefined
  const model = decodeRoute(value.model)
  return model === undefined ? undefined : { ...value, model } as unknown as TextMaterialIdentity
}

/** Validation does not turn live requests into restored requests. Unknown fields are rejected. */
export function decodeTranslationHistory(value: unknown): TranslationHistory | undefined {
  if (!record(value) || !exact(value, ['schemaVersion', 'units', 'events']) || ![1, 2, 3, 4, 5].includes(value.schemaVersion as number) || !Array.isArray(value.units) || !Array.isArray(value.events)) return undefined
  const units: TextUnit[] = [], revisionIds = new Set<string>(), operationUnits = new Map<string, string>(), unitIds = new Set<string>()
  for (const item of value.units) {
    if (!record(item) || !exact(item, ['id', 'order', ...(((value.schemaVersion as number) < 3 || Object.hasOwn(item, 'source')) ? ['source'] : []), 'targetLanguage', 'instruction', 'createdAt', 'revisions', 'final', ...((value.schemaVersion as number) >= 3 ? ['sourceVersion', 'sourceVersions', 'material'] : [])]) ||
      !identity(item.id) || unitIds.has(item.id) || item.order !== units.length + 1 || ((value.schemaVersion as number) < 3 && !text(item.source, 200000, true)) || !text(item.targetLanguage, 80, true) ||
      !text(item.instruction, 4000) || !time(item.createdAt) || !Array.isArray(item.revisions)) return undefined
    const material = (value.schemaVersion as number) >= 3 ? decodeMaterial(item.material) : null
    const sourceVersion = (value.schemaVersion as number) >= 3 ? item.sourceVersion : 1
    const sourceVersions: TextSourceVersion[] = []
    if (material === undefined || !order(sourceVersion) || (!item.revisions.length && material === null)) return undefined
    if ((value.schemaVersion as number) >= 3) {
      if (!Array.isArray(item.sourceVersions) || !item.sourceVersions.length) return undefined
      for (const raw of item.sourceVersions) {
        if (!record(raw) || !exact(raw, ['version', 'text', 'createdAt', 'operationId']) || raw.version !== sourceVersions.length + 1 ||
          !text(raw.text, 200000, true) || !time(raw.createdAt) || !(raw.operationId === null || identity(raw.operationId))) return undefined
        sourceVersions.push({ ...raw } as unknown as TextSourceVersion)
      }
      if (sourceVersion !== sourceVersions.length || (Object.hasOwn(item, 'source') && item.source !== sourceVersions.at(-1)!.text)) return undefined
    } else sourceVersions.push({ version: 1, text: item.source as string, createdAt: item.createdAt, operationId: null })
    const revisions: TextRevision[] = []
    for (const raw of item.revisions) {
      const revision = decodeRevision(raw, value.schemaVersion as number)
      if (!revision || revision.order !== revisions.length + 1 || revisionIds.has(revision.id) ||
        (operationUnits.has(revision.operationId) && ((value.schemaVersion as number) < 4 || operationUnits.get(revision.operationId) !== item.id))) return undefined
      if (!sourceVersions.some(source => source.version === revision.sourceVersion)) return undefined
      if (revision.kind === 'manual' && !revisions.some(base => base.id === revision.baseRevisionId && base.sourceVersion === revision.sourceVersion && canEditTextRevision(base))) return undefined
      revisions.push(revision); revisionIds.add(revision.id); operationUnits.set(revision.operationId, item.id)
    }
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
    units.push({ id: item.id, order: item.order as number, source: sourceVersions[sourceVersion - 1]!.text, targetLanguage: item.targetLanguage, instruction: item.instruction,
      sourceVersion, sourceVersions, material, createdAt: item.createdAt, revisions, final })
  }
  const events: TranslationEvent[] = [], eventIds = new Set<string>()
  for (const item of value.events) {
    if (!record(item) || !exact(item, ['id', 'order', 'type', 'at', 'unitId', 'revisionId', 'operationId', 'status', 'reason', ...((value.schemaVersion as number) >= 4 && Object.hasOwn(item, 'normalSequence') ? ['normalSequence'] : []),
      ...((value.schemaVersion as number) >= 5 ? ['sourceVersion', 'sourceReason'].filter(field => Object.hasOwn(item, field)) : [])]) ||
      (Object.hasOwn(item, 'normalSequence') && (!order(item.normalSequence) || item.type !== 'operation.updated' || !identity(item.operationId))) ||
      (Object.hasOwn(item, 'sourceVersion') && (!order(item.sourceVersion) || !units.find(unit => unit.id === item.unitId)?.sourceVersions.some(source => source.version === item.sourceVersion))) ||
      (Object.hasOwn(item, 'sourceReason') && (item.type !== 'source.corrected' || !text(item.sourceReason, 1000))) ||
      (item.type === 'source.corrected' && (!order(item.sourceVersion) || item.revisionId !== null || !identity(item.operationId) || !text(item.sourceReason, 1000))) || !identity(item.id) || eventIds.has(item.id) ||
      item.order !== events.length + 1 || !['operation.submitted', 'operation.accepted', 'operation.retranslation_accepted', 'operation.updated', 'final.selected', 'operation.restored', 'revision.manual_saved', 'source.corrected'].includes(item.type as string) || !time(item.at) ||
      !(item.unitId === null || (identity(item.unitId) && unitIds.has(item.unitId))) || !(item.revisionId === null || (identity(item.revisionId) && revisionIds.has(item.revisionId))) ||
      !(item.operationId === null || identity(item.operationId)) || !(item.status === null || status(item.status)) || !(item.reason === null || ['advance', 'user_selection', 'restored', 'export'].includes(item.reason as string))) return undefined
    if (item.revisionId !== null) {
      const unit = units.find(unit => unit.id === item.unitId), revision = unit?.revisions.find(revision => revision.id === item.revisionId)
      if (!revision || item.operationId !== revision.operationId || (item.sourceVersion !== undefined && item.sourceVersion !== revision.sourceVersion)) return undefined
    }
    if (typeof item.operationId === 'string' && typeof item.unitId === 'string') {
      if (operationUnits.has(item.operationId) && operationUnits.get(item.operationId) !== item.unitId) return undefined
      operationUnits.set(item.operationId, item.unitId)
    }
    events.push({ ...item } as unknown as TranslationEvent); eventIds.add(item.id)
  }
  return { schemaVersion: 5, units, events }
}

/** Version records own source bodies; storage and full-record exports omit the compatibility projection. */
export function persistedTranslationHistory(history: TranslationHistory): unknown {
  return { ...history, units: history.units.map(({ source: _source, ...unit }) => unit) }
}

export function appendTranslationEvent(history: TranslationHistory, event: Omit<TranslationEvent, 'order'>): TranslationHistory {
  if (history.events.some(old => old.id === event.id)) throw new Error('Duplicate translation event')
  return { ...history, events: [...history.events, { ...event, order: history.events.length + 1 }] }
}
function event(history: TranslationHistory, unit: TextUnit, revision: TextRevision, type: TranslationEvent['type'], at: string, reason: TranslationEvent['reason'] = null): TranslationHistory {
  return appendTranslationEvent(history, { id: `text-event:${history.events.length + 1}`, type, at, unitId: unit.id, revisionId: revision.id, operationId: revision.operationId, status: revision.status, reason })
}
function findUnit(history: TranslationHistory, unitId: string): TextUnit {
  const unit = history.units.find(unit => unit.id === unitId)
  if (!unit) throw new Error('Translation unit unavailable')
  return unit
}
function replaceUnit(history: TranslationHistory, unit: TextUnit): TranslationHistory { return { ...history, units: history.units.map(old => old.id === unit.id ? unit : old) } }
function newRevision(history: TranslationHistory, data: NewTextRevision, revisionOrder: number, unitId: string): TextRevision {
  const revision = decodeRevision({ kind: 'machine', baseRevisionId: null, callRecord: null, sourceVersion: 1, ...data, order: revisionOrder }, 3, false)
  if (!revision || history.units.some(unit => unit.revisions.some(old => old.id === revision.id || (unit.id !== unitId && old.operationId === revision.operationId))) ||
    history.events.some(event => event.operationId === revision.operationId && event.unitId !== unitId)) throw new Error('Invalid or duplicate translation revision')
  return revision
}

/** Latest attempt means admission order, including a later failed or unaccepted revision. */
function advanceFinal(history: TranslationHistory, unit: TextUnit, at: string, reason: 'advance' | 'export' = 'advance'): TranslationHistory {
  if (unit.final?.selection === 'user_fixed' && currentFinalRevision(unit)) return history
  const latest = [...unit.revisions].reverse().find(revision => revision.sourceVersion === unit.sourceVersion)
  if (!latest || !eligible(latest) || unit.final?.revisionId === latest.id) return history
  const updated: TextUnit = { ...unit, final: { revisionId: latest.id, selection: 'automatic', selectedAt: at } }
  return event(replaceUnit(history, updated), updated, latest, 'final.selected', at, reason)
}

/** Explicit export closes only the last unit; earlier missing finals remain visible. */
export function finalizeLastUnit(history: TranslationHistory, at: string): TranslationHistory {
  if (!time(at)) throw new Error('Invalid final selection time')
  const unit = history.units.at(-1)
  return unit ? advanceFinal(history, unit, at, 'export') : history
}

/** Editing saves a new complete local fact and leaves the existing final pointer alone. */
export function appendManualRevision(history: TranslationHistory, unitId: string, data: { readonly id: string; readonly baseRevisionId: string; readonly text: string; readonly at: string }): TranslationHistory {
  const unit = findUnit(history, unitId), base = unit.revisions.find(revision => revision.id === data.baseRevisionId)
  if (!base || !canEditTextRevision(base) || !text(data.text, 2_000_000, true) || !time(data.at)) throw new Error('Manual revision requires nonempty ended source and body')
  const revision = newRevision(history, { id: data.id, operationId: `manual:${data.id}`, kind: 'manual', model: null, draftVersion: null,
    baseRevisionId: base.id, callRecord: null, sourceVersion: base.sourceVersion, createdAt: data.at, updatedAt: data.at, accepted: true, status: 'completed', text: data.text, message: null }, unit.revisions.length + 1, unit.id)
  const updated: TextUnit = { ...unit, revisions: [...unit.revisions, revision] }
  return event(replaceUnit(history, updated), updated, revision, 'revision.manual_saved', data.at)
}

/** Append an admitted new unit and finalize its predecessor in the same conversion. */
export function appendTextUnit(history: TranslationHistory, data: NewTextUnit, revision: NewTextRevision): TranslationHistory {
  if (!revision.accepted || revision.kind === 'manual' || !identity(data.id) || !text(data.source, 200000, true) || !text(data.targetLanguage, 80, true) || !text(data.instruction, 4000) || !time(data.createdAt) ||
    history.units.some(unit => unit.id === data.id)) throw new Error('New text unit requires unique admitted material')
  const unit: TextUnit = { ...data, sourceVersion: 1, sourceVersions: [{ version: 1, text: data.source, createdAt: data.createdAt, operationId: null }], material: null,
    order: history.units.length + 1, revisions: [newRevision(history, revision, 1, data.id)], final: null }
  let next = history.units.length ? advanceFinal(history, history.units.at(-1)!, revision.updatedAt) : history
  next = { ...next, units: [...next.units, unit] }
  return event(next, unit, unit.revisions[0]!, 'operation.accepted', revision.updatedAt)
}

/** Business admission is a material fact; an actual model invocation is appended separately. */
export function appendAdmittedTextUnit(history: TranslationHistory, envelope: TranslationMaterialEnvelope & { readonly kind: 'material' }, operationId: string, at: string): TranslationHistory {
  const snapshot = envelope.material, unitId = `unit:${snapshot.materialId}`
  if (snapshot.sourceText === undefined) throw Object.assign(new Error('Asset material requires batch admission'), { code: 'requires_batch' })
  if (!identity(operationId) || !time(at) || snapshot.sourceVersion !== 1 || history.units.some(unit => unit.id === unitId) || history.events.some(event => event.operationId === operationId)) throw new Error('Invalid or duplicate admitted material')
  const unit: TextUnit = { id: unitId, order: history.units.length + 1, source: snapshot.sourceText, targetLanguage: snapshot.targetLanguage,
    instruction: snapshot.instruction, sourceVersion: snapshot.sourceVersion,
    sourceVersions: [{ version: snapshot.sourceVersion, text: snapshot.sourceText, createdAt: at, operationId: envelope.operationId }],
    material: { materialId: snapshot.materialId, mainSessionId: envelope.mainSessionId, requestId: envelope.requestId, draftVersion: snapshot.draftVersion,
      model: snapshot.model, maxInputChars: snapshot.maxInputChars }, createdAt: at, revisions: [], final: null }
  const previous = history.units.at(-1)
  const next = previous ? advanceFinal(history, previous, at) : history
  return appendTranslationEvent({ ...next, units: [...next.units, unit] }, { id: `text-event:${next.events.length + 1}`,
    type: 'operation.accepted', at, unitId, revisionId: null, operationId, status: 'submitting', reason: null, sourceVersion: snapshot.sourceVersion })
}

/** Correct one admitted source without overwriting earlier bodies or the old final pointer. */
export function appendSourceCorrection(history: TranslationHistory, unitId: string, data: { readonly operationId: string; readonly expectedVersion: number; readonly text: string; readonly reason: string; readonly at: string }): TranslationHistory {
  const unit = findUnit(history, unitId)
  if (unit.sourceVersion !== data.expectedVersion || !identity(data.operationId) || !text(data.text, 200000, true) || data.text === unit.source ||
    !text(data.reason, 1000) || !time(data.at) || history.events.some(event => event.operationId === data.operationId)) throw new Error('Invalid or stale source correction')
  const sourceVersion = unit.sourceVersion + 1, updated: TextUnit = { ...unit, source: data.text, sourceVersion,
    sourceVersions: [...unit.sourceVersions, { version: sourceVersion, text: data.text, createdAt: data.at, operationId: data.operationId }] }
  return appendTranslationEvent(replaceUnit(history, updated), { id: `text-event:${history.events.length + 1}`, type: 'source.corrected', at: data.at,
    unitId, revisionId: null, operationId: data.operationId, status: null, reason: null, sourceVersion, sourceReason: data.reason })
}

export function acceptUnitRetranslation(history: TranslationHistory, unitId: string, operationId: string, sourceVersion: number, at: string): TranslationHistory {
  const unit = findUnit(history, unitId)
  if (!identity(operationId) || !time(at) || unit.sourceVersion !== sourceVersion || history.events.some(event => event.operationId === operationId)) throw new Error('Invalid or duplicate unit operation')
  return appendTranslationEvent(history, { id: `text-event:${history.events.length + 1}`, type: 'operation.retranslation_accepted', at,
    unitId, revisionId: null, operationId, status: 'submitting', reason: null, sourceVersion })
}

export function appendTextRevision(history: TranslationHistory, unitId: string, revision: NewTextRevision): TranslationHistory {
  if (revision.kind === 'manual') throw new Error('Use manual revision saving for local edits')
  const unit = findUnit(history, unitId), added = newRevision(history, { sourceVersion: unit.sourceVersion, ...revision }, unit.revisions.length + 1, unit.id)
  if (!unit.sourceVersions.some(source => source.version === added.sourceVersion)) throw new Error('Translation source version unavailable')
  const updated: TextUnit = { ...unit, revisions: [...unit.revisions, added] }
  return event(replaceUnit(history, updated), updated, added, revision.accepted ? 'operation.accepted' : 'operation.submitted', revision.createdAt)
}

/** Acceptance of a retry stays in its existing unit and never advances another unit. */
export function acceptTextRevision(history: TranslationHistory, unitId: string, revisionId: string, at: string): TranslationHistory {
  const unit = findUnit(history, unitId), old = unit.revisions.find(revision => revision.id === revisionId)
  if (!old) throw new Error('Translation revision unavailable')
  if (old.accepted) return history
  if (!time(at)) throw new Error('Invalid acceptance time')
  const revision: TextRevision = { ...old, accepted: true, updatedAt: at }
  const updated: TextUnit = { ...unit, revisions: unit.revisions.map(old => old.id === revisionId ? revision : old) }
  return event(replaceUnit(history, updated), updated, revision, 'operation.accepted', at)
}

export function updateTextRevision(history: TranslationHistory, unitId: string, revisionId: string, patch: TextRevisionPatch): TranslationHistory {
  const unit = findUnit(history, unitId), old = unit.revisions.find(revision => revision.id === revisionId)
  if (!old) throw new Error('Translation revision unavailable')
  const revision = decodeRevision({ ...old, ...patch }, 3, false)
  if (!revision) throw new Error('Invalid translation revision')
  if (old.status === revision.status && old.text === revision.text && old.message === revision.message && JSON.stringify(old.callRecord) === JSON.stringify(revision.callRecord)) return history
  // A completed body is a version: another translation belongs in a new revision.
  if (old.status === 'completed' && (old.status !== revision.status || old.text !== revision.text || old.message !== revision.message)) throw new Error('Completed translation revisions are immutable')
  const updated: TextUnit = { ...unit, revisions: unit.revisions.map(old => old.id === revisionId ? revision : old) }
  return event(replaceUnit(history, updated), updated, revision, 'operation.updated', revision.updatedAt)
}

export function selectFinalRevision(history: TranslationHistory, unitId: string, revisionId: string, at: string): TranslationHistory {
  const unit = findUnit(history, unitId), revision = unit.revisions.find(revision => revision.id === revisionId)
  if (!revision || revision.sourceVersion !== unit.sourceVersion || !eligible(revision) || !time(at)) throw new Error('Only complete current-source translations can be final')
  if (unit.final?.revisionId === revisionId && unit.final.selection === 'user_fixed') return history
  const updated: TextUnit = { ...unit, final: { revisionId, selection: 'user_fixed', selectedAt: at } }
  return event(replaceUnit(history, updated), updated, revision, 'final.selected', at, 'user_selection')
}

/** Restore facts without reconstructing an executable Host capability or replaying requests. */
export function restoreTranslationHistory(history: TranslationHistory, at = new Date().toISOString()): TranslationHistory {
  let next = history
  for (const admitted of history.events.filter(event => ['operation.accepted', 'operation.retranslation_accepted'].includes(event.type) && event.revisionId === null && event.operationId !== null)) {
    const unit = findUnit(history, admitted.unitId!)
    if (unit.revisions.some(revision => revision.operationId === admitted.operationId)) continue
    const last = [...history.events].reverse().find(event => event.operationId === admitted.operationId)
    if (!last || !['submitting', 'running', 'unknown'].includes(last.status ?? '')) continue
    next = appendTranslationEvent(next, { id: `text-event:${next.events.length + 1}`, type: 'operation.restored', at,
      unitId: unit.id, revisionId: null, operationId: admitted.operationId, status: 'interrupted', reason: 'restored', sourceVersion: admitted.sourceVersion ?? 1 })
  }
  for (const unit of history.units) for (const revision of unit.revisions) {
    if (!['submitting', 'running', 'unknown'].includes(revision.status)) continue
    const updated: TextRevision = { ...revision, status: 'interrupted', message: revision.status === 'unknown'
      ? '重启前执行结果未知，请核对；未自动重发。' : '上次运行已中断，未自动重发。' }
    const current = findUnit(next, unit.id)
    const restored: TextUnit = { ...current, revisions: current.revisions.map(old => old.id === revision.id ? updated : old) }
    next = event(replaceUnit(next, restored), restored, updated, 'operation.restored', at, 'restored')
  }
  return next
}
