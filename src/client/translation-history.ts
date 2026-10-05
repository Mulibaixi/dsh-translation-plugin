import { decodeRoute, type ModelRoute } from './sessions.js'

export type TextRevisionStatus = 'submitting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'interrupted'
export interface TextRevision {
  readonly id: string
  readonly operationId: string
  readonly order: number
  readonly model: ModelRoute
  readonly draftVersion: number
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
  readonly source: string
  readonly targetLanguage: string
  readonly instruction: string
  readonly createdAt: string
  readonly revisions: readonly TextRevision[]
  readonly final: FinalPointer | null
}
export interface TranslationEvent {
  readonly id: string
  readonly order: number
  readonly type: 'operation.submitted' | 'operation.accepted' | 'operation.updated' | 'final.selected' | 'operation.restored'
  readonly at: string
  readonly unitId: string | null
  readonly revisionId: string | null
  readonly operationId: string | null
  readonly status: TextRevisionStatus | null
  readonly reason: 'advance' | 'user_selection' | 'restored' | null
}
/** One browser snapshot; events and final pointers reference the sole revision body. */
export interface TranslationHistory {
  readonly schemaVersion: 1
  readonly units: readonly TextUnit[]
  readonly events: readonly TranslationEvent[]
}
export type NewTextUnit = Pick<TextUnit, 'id' | 'source' | 'targetLanguage' | 'instruction' | 'createdAt'>
export type NewTextRevision = Omit<TextRevision, 'order'>
export type TextRevisionPatch = Partial<Pick<TextRevision, 'status' | 'text' | 'message' | 'updatedAt'>>

export function emptyTranslationHistory(): TranslationHistory { return { schemaVersion: 1, units: [], events: [] } }

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

function decodeRevision(value: unknown): TextRevision | undefined {
  if (!record(value) || !exact(value, ['id', 'operationId', 'order', 'model', 'draftVersion', 'createdAt', 'updatedAt', 'accepted', 'status', 'text', 'message']) ||
    !identity(value.id) || !identity(value.operationId) || !order(value.order) || !order(value.draftVersion) || !time(value.createdAt) || !time(value.updatedAt) ||
    typeof value.accepted !== 'boolean' || !status(value.status) || !text(value.text, 2_000_000) || !(value.message === null || text(value.message, 1000))) return undefined
  const model = decodeRoute(value.model)
  if (!model || (value.status === 'completed' && (!value.accepted || !value.text.trim())) || (!value.accepted && value.text !== '')) return undefined
  return { ...value, model } as unknown as TextRevision
}

/** Validation does not turn live requests into restored requests. Unknown fields are rejected. */
export function decodeTranslationHistory(value: unknown): TranslationHistory | undefined {
  if (!record(value) || !exact(value, ['schemaVersion', 'units', 'events']) || value.schemaVersion !== 1 || !Array.isArray(value.units) || !Array.isArray(value.events)) return undefined
  const units: TextUnit[] = [], revisionIds = new Set<string>(), operationIds = new Set<string>(), unitIds = new Set<string>()
  for (const item of value.units) {
    if (!record(item) || !exact(item, ['id', 'order', 'source', 'targetLanguage', 'instruction', 'createdAt', 'revisions', 'final']) ||
      !identity(item.id) || unitIds.has(item.id) || item.order !== units.length + 1 || !text(item.source, 200000, true) || !text(item.targetLanguage, 80, true) ||
      !text(item.instruction, 4000) || !time(item.createdAt) || !Array.isArray(item.revisions) || !item.revisions.length) return undefined
    const revisions: TextRevision[] = []
    for (const raw of item.revisions) {
      const revision = decodeRevision(raw)
      if (!revision || revision.order !== revisions.length + 1 || revisionIds.has(revision.id) || operationIds.has(revision.operationId)) return undefined
      revisions.push(revision); revisionIds.add(revision.id); operationIds.add(revision.operationId)
    }
    // Units are admitted material; unaccepted new drafts remain in the transient execution layer.
    if (!revisions[0]!.accepted) return undefined
    let final: FinalPointer | null = null
    if (item.final !== null) {
      const pointer = item.final
      if (!record(pointer) || !exact(pointer, ['revisionId', 'selection', 'selectedAt']) || !identity(pointer.revisionId) ||
        !['automatic', 'user_fixed'].includes(pointer.selection as string) || !time(pointer.selectedAt) ||
        !revisions.some(revision => revision.id === pointer.revisionId && eligible(revision))) return undefined
      final = { revisionId: pointer.revisionId, selection: pointer.selection as FinalPointer['selection'], selectedAt: pointer.selectedAt }
    }
    unitIds.add(item.id)
    units.push({ id: item.id, order: item.order as number, source: item.source, targetLanguage: item.targetLanguage, instruction: item.instruction, createdAt: item.createdAt, revisions, final })
  }
  const events: TranslationEvent[] = [], eventIds = new Set<string>()
  for (const item of value.events) {
    if (!record(item) || !exact(item, ['id', 'order', 'type', 'at', 'unitId', 'revisionId', 'operationId', 'status', 'reason']) || !identity(item.id) || eventIds.has(item.id) ||
      item.order !== events.length + 1 || !['operation.submitted', 'operation.accepted', 'operation.updated', 'final.selected', 'operation.restored'].includes(item.type as string) || !time(item.at) ||
      !(item.unitId === null || (identity(item.unitId) && unitIds.has(item.unitId))) || !(item.revisionId === null || (identity(item.revisionId) && revisionIds.has(item.revisionId))) ||
      !(item.operationId === null || identity(item.operationId)) || !(item.status === null || status(item.status)) || !(item.reason === null || ['advance', 'user_selection', 'restored'].includes(item.reason as string))) return undefined
    if (item.revisionId !== null) {
      const unit = units.find(unit => unit.id === item.unitId), revision = unit?.revisions.find(revision => revision.id === item.revisionId)
      if (!revision || item.operationId !== revision.operationId) return undefined
    }
    events.push({ ...item } as unknown as TranslationEvent); eventIds.add(item.id)
  }
  return { schemaVersion: 1, units, events }
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
function newRevision(history: TranslationHistory, data: NewTextRevision, revisionOrder: number): TextRevision {
  const revision = decodeRevision({ ...data, order: revisionOrder })
  if (!revision || history.units.some(unit => unit.revisions.some(old => old.id === revision.id || old.operationId === revision.operationId))) throw new Error('Invalid or duplicate translation revision')
  return revision
}

/** Latest attempt means admission order, including a later failed or unaccepted revision. */
function advanceFinal(history: TranslationHistory, unit: TextUnit, at: string): TranslationHistory {
  if (unit.final?.selection === 'user_fixed') return history
  const latest = unit.revisions.at(-1)
  if (!latest || !eligible(latest) || unit.final?.revisionId === latest.id) return history
  const updated: TextUnit = { ...unit, final: { revisionId: latest.id, selection: 'automatic', selectedAt: at } }
  return event(replaceUnit(history, updated), updated, latest, 'final.selected', at, 'advance')
}

/** Append an admitted new unit and finalize its predecessor in the same conversion. */
export function appendTextUnit(history: TranslationHistory, data: NewTextUnit, revision: NewTextRevision): TranslationHistory {
  if (!revision.accepted || !identity(data.id) || !text(data.source, 200000, true) || !text(data.targetLanguage, 80, true) || !text(data.instruction, 4000) || !time(data.createdAt) ||
    history.units.some(unit => unit.id === data.id)) throw new Error('New text unit requires unique admitted material')
  const unit: TextUnit = { ...data, order: history.units.length + 1, revisions: [newRevision(history, revision, 1)], final: null }
  let next = history.units.length ? advanceFinal(history, history.units.at(-1)!, revision.updatedAt) : history
  next = { ...next, units: [...next.units, unit] }
  return event(next, unit, unit.revisions[0]!, 'operation.accepted', revision.updatedAt)
}

export function appendTextRevision(history: TranslationHistory, unitId: string, revision: NewTextRevision): TranslationHistory {
  const unit = findUnit(history, unitId), added = newRevision(history, revision, unit.revisions.length + 1)
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
  const revision = decodeRevision({ ...old, ...patch })
  if (!revision) throw new Error('Invalid translation revision')
  if (old.status === revision.status && old.text === revision.text && old.message === revision.message) return history
  // A completed body is a version: another translation belongs in a new revision.
  if (old.status === 'completed') throw new Error('Completed translation revisions are immutable')
  const updated: TextUnit = { ...unit, revisions: unit.revisions.map(old => old.id === revisionId ? revision : old) }
  return event(replaceUnit(history, updated), updated, revision, 'operation.updated', revision.updatedAt)
}

export function selectFinalRevision(history: TranslationHistory, unitId: string, revisionId: string, at: string): TranslationHistory {
  const unit = findUnit(history, unitId), revision = unit.revisions.find(revision => revision.id === revisionId)
  if (!revision || !eligible(revision) || !time(at)) throw new Error('Only complete admitted translations can be final')
  if (unit.final?.revisionId === revisionId && unit.final.selection === 'user_fixed') return history
  const updated: TextUnit = { ...unit, final: { revisionId, selection: 'user_fixed', selectedAt: at } }
  return event(replaceUnit(history, updated), updated, revision, 'final.selected', at, 'user_selection')
}

/** Restore facts without reconstructing an executable Host capability or replaying requests. */
export function restoreTranslationHistory(history: TranslationHistory, at = new Date().toISOString()): TranslationHistory {
  let next = history
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
