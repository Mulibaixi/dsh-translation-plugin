import { parseObjectAssetVersion, type ObjectAssetVersion } from './object-assets.js'

export interface RecordObjectTarget {
  readonly ownerId: string; readonly topicId: string; readonly sessionId: string; readonly unitId: string
  readonly side: 'source' | 'revision'; readonly revisionId: string | null
}
export interface RecordObjectReferenceInput extends RecordObjectTarget {
  /** Insertion point in the sole authoritative body, measured in Unicode code points. */
  readonly offset: number
  readonly asset: ObjectAssetVersion
  /** Reliable source supplied explicitly by the user; never inferred from the record body. */
  readonly formulaSource?: string
}
export interface RecordObjectReference extends RecordObjectReferenceInput {
  readonly refId: string
  /** Stable within this unit and kind. The same object keeps its number on either side. */
  readonly objectOrdinal: number
  readonly createdAt: string
}
export interface RecordObjectSnapshot {
  readonly schemaVersion: 1; readonly ownerId: string; readonly topicId: string; readonly sessionId: string
  readonly version: number; readonly updatedAt: string
  /** Append order is the permanent first-binding order; references and positions are immutable. */
  readonly references: readonly RecordObjectReference[]
}
export interface RecordObjectMutationResult {
  readonly status: 'updated' | 'unchanged' | 'stale' | 'invalid' | 'save_failed'
  readonly snapshot: RecordObjectSnapshot; readonly reference: RecordObjectReference | null
}
type Data = Record<string, unknown>
const targetKeys = ['ownerId', 'topicId', 'sessionId', 'unitId', 'side', 'revisionId'] as const
function record(value: unknown): value is Data { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function exact(value: Data, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function referenceFields(value: Data, required: readonly string[]): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || key === 'formulaSource')
}
function identity(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && Array.from(value).length <= 2048 }
function integer(value: unknown, minimum = 0): value is number { return Number.isSafeInteger(value) && (value as number) >= minimum }
function time(value: unknown): value is string { return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) }
function target(value: Data): boolean {
  return targetKeys.slice(0, 4).every(key => identity(value[key])) &&
    (value.side === 'source' ? value.revisionId === null : value.side === 'revision' && identity(value.revisionId))
}
function copyAsset(asset: ObjectAssetVersion): ObjectAssetVersion {
  return { objectId: asset.objectId, assetId: asset.assetId, version: asset.version, kind: asset.kind, name: asset.name, bytes: asset.bytes }
}
function decodeInput(value: Data): RecordObjectReferenceInput | undefined {
  if (!target(value) || !integer(value.offset)) return undefined
  try {
    const asset = parseObjectAssetVersion(value.asset)
    if (Object.hasOwn(value, 'formulaSource') && (asset.kind !== 'formula' || typeof value.formulaSource !== 'string' || !value.formulaSource.trim() || Array.from(value.formulaSource).length > 200000)) return undefined
    return { ownerId: value.ownerId as string, topicId: value.topicId as string, sessionId: value.sessionId as string, unitId: value.unitId as string,
      side: value.side as RecordObjectTarget['side'], revisionId: value.revisionId as string | null, offset: value.offset, asset,
      ...(typeof value.formulaSource === 'string' ? { formulaSource: value.formulaSource } : {}) }
  } catch { return undefined }
}
/** Parses external metadata only; neither text nor native attachment handles are part of this schema. */
export function decodeRecordObjectReferenceInput(value: unknown): RecordObjectReferenceInput | undefined {
  return record(value) && referenceFields(value, [...targetKeys, 'offset', 'asset']) ? decodeInput(value) : undefined
}
export function decodeRecordObjectSnapshot(value: unknown): RecordObjectSnapshot | undefined {
  if (!record(value) || !exact(value, ['schemaVersion', 'ownerId', 'topicId', 'sessionId', 'version', 'updatedAt', 'references']) || value.schemaVersion !== 1 ||
    !identity(value.ownerId) || !identity(value.topicId) || !identity(value.sessionId) || !integer(value.version) || !time(value.updatedAt) || !Array.isArray(value.references)) return undefined
  const references: RecordObjectReference[] = [], refIds = new Set<string>(), placements = new Set<string>()
  const objects = new Map<string, { kind: string; ordinal: number }>(), ordinals = new Map<string, string>(), assets = new Map<string, string>(), kinds = new Map<string, string>()
  for (const raw of value.references) {
    if (!record(raw) || !referenceFields(raw, [...targetKeys, 'offset', 'asset', 'refId', 'objectOrdinal', 'createdAt']) ||
      !identity(raw.refId) || refIds.has(raw.refId) || !integer(raw.objectOrdinal, 1) || !time(raw.createdAt)) return undefined
    const input = decodeInput(raw)
    if (!input || input.ownerId !== value.ownerId || input.topicId !== value.topicId || input.sessionId !== value.sessionId) return undefined
    const objectKey = JSON.stringify([input.unitId, input.asset.objectId]), ordinalKey = JSON.stringify([input.unitId, input.asset.kind, raw.objectOrdinal])
    const placement = JSON.stringify([input.unitId, input.side, input.revisionId, input.offset, input.asset.objectId]), asset = JSON.stringify(input.asset)
    const old = objects.get(objectKey)
    if (placements.has(placement) || (old && (old.kind !== input.asset.kind || old.ordinal !== raw.objectOrdinal)) ||
      (ordinals.has(ordinalKey) && ordinals.get(ordinalKey) !== input.asset.objectId) ||
      (assets.has(input.asset.assetId) && assets.get(input.asset.assetId) !== asset) ||
      (kinds.has(input.asset.objectId) && kinds.get(input.asset.objectId) !== input.asset.kind)) return undefined
    refIds.add(raw.refId); placements.add(placement); objects.set(objectKey, { kind: input.asset.kind, ordinal: raw.objectOrdinal })
    ordinals.set(ordinalKey, input.asset.objectId); assets.set(input.asset.assetId, asset); kinds.set(input.asset.objectId, input.asset.kind)
    references.push({ ...input, refId: raw.refId, objectOrdinal: raw.objectOrdinal, createdAt: raw.createdAt })
  }
  return { schemaVersion: 1, ownerId: value.ownerId, topicId: value.topicId, sessionId: value.sessionId, version: value.version, updatedAt: value.updatedAt, references }
}
export function emptyRecordObjects(ownerId: string, topicId: string, sessionId: string, at: string): RecordObjectSnapshot {
  if (![ownerId, topicId, sessionId].every(identity) || !time(at)) throw new Error('Invalid record object scope or time')
  return { schemaVersion: 1, ownerId, topicId, sessionId, version: 0, updatedAt: at, references: [] }
}
export function recordObjectTargetMatches(reference: RecordObjectTarget, scope: RecordObjectTarget): boolean {
  return reference.topicId === scope.topicId && reference.sessionId === scope.sessionId && reference.unitId === scope.unitId &&
    reference.side === scope.side && reference.revisionId === scope.revisionId
}
/** Caller has checked the authoritative body and offset under its storage lock. */
export function appendRecordObjectReference(snapshot: RecordObjectSnapshot, input: RecordObjectReferenceInput, action: { readonly refId: string; readonly at: string }): RecordObjectMutationResult {
  const invalid = (): RecordObjectMutationResult => ({ status: 'invalid', snapshot, reference: null })
  if (input.ownerId !== snapshot.ownerId || input.topicId !== snapshot.topicId || input.sessionId !== snapshot.sessionId ||
    !identity(action.refId) || !time(action.at) || !integer(input.offset) || snapshot.references.some(ref => ref.refId === action.refId)) return invalid()
  const samePlace = snapshot.references.find(ref => recordObjectTargetMatches(ref, input) && ref.offset === input.offset && ref.asset.objectId === input.asset.objectId)
  if (samePlace) return JSON.stringify(samePlace.asset) === JSON.stringify(input.asset) && samePlace.formulaSource === input.formulaSource ? { status: 'unchanged', snapshot, reference: samePlace } : invalid()
  if (snapshot.references.some(ref => (ref.asset.objectId === input.asset.objectId && ref.asset.kind !== input.asset.kind) ||
    (ref.asset.assetId === input.asset.assetId && JSON.stringify(ref.asset) !== JSON.stringify(input.asset)))) return invalid()
  const old = snapshot.references.find(ref => ref.unitId === input.unitId && ref.asset.objectId === input.asset.objectId)
  const ordinal = old?.objectOrdinal ?? Math.max(0, ...snapshot.references.filter(ref => ref.unitId === input.unitId && ref.asset.kind === input.asset.kind).map(ref => ref.objectOrdinal)) + 1
  const reference: RecordObjectReference = { ...input, asset: copyAsset(input.asset), refId: action.refId, objectOrdinal: ordinal, createdAt: action.at }
  return { status: 'updated', snapshot: { ...snapshot, version: snapshot.version + 1, updatedAt: action.at, references: [...snapshot.references, reference] }, reference }
}
