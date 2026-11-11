import { parseDirectTranslationTarget, type DirectUnitTarget } from './normal-translation.js'

export interface UnitDirectoryRequest { readonly translationSessionId?: string; readonly offset?: number; readonly limit?: number }
export interface UnitReadRequest {
  readonly translationSessionId?: string
  readonly unitNumbers: readonly number[]
  readonly side?: 'source' | 'translation'
  readonly revisionNumber?: number
  readonly sourceVersion?: number
  readonly start?: number
}
export interface NumberedUnit {
  readonly target: DirectUnitTarget
  readonly number: number
  readonly kind: 'text' | 'file' | 'image'
  readonly status: string
  readonly versions: readonly number[]
  readonly finalVersion: number | null
  readonly finalSelection?: 'automatic' | 'user_fixed'
}
export interface UnitContent {
  readonly unit: NumberedUnit
  readonly side: 'source' | 'translation'
  readonly revisionNumber: number | null
  readonly text: string | null
  readonly totalCodePoints: number
  readonly start: number
  readonly nextStart: number | null
  readonly message?: string
}
export interface UnitDirectory { readonly translationSessionId: string; readonly items: readonly NumberedUnit[]; readonly nextOffset: number | null }
function object(value: unknown): asserts value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid unit request') }
function fields(value: Record<string, unknown>, allowed: readonly string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('Unexpected unit field') }
function integer(value: unknown, min: number): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < min) throw new TypeError('Invalid unit number or offset') }
export function parseUnitRequest(value: unknown, read: false): UnitDirectoryRequest
export function parseUnitRequest(value: unknown, read: true): UnitReadRequest
export function parseUnitRequest(value: unknown, read: boolean): UnitDirectoryRequest | UnitReadRequest {
  object(value)
  fields(value, read ? ['translationSessionId', 'unitNumbers', 'side', 'revisionNumber', 'sourceVersion', 'start'] : ['translationSessionId', 'offset', 'limit'])
  if (value.translationSessionId !== undefined && (typeof value.translationSessionId !== 'string' || !value.translationSessionId.trim())) throw new TypeError('Invalid translation Session')
  if (read) {
    if (!Array.isArray(value.unitNumbers) || !value.unitNumbers.length || value.unitNumbers.length > 8) throw new TypeError('Read 1–8 unit numbers per call')
    value.unitNumbers.forEach(n => integer(n, 1))
    if (value.side !== undefined && !['source', 'translation'].includes(value.side as string)) throw new TypeError('Invalid unit side')
    if (value.revisionNumber !== undefined) { integer(value.revisionNumber, 1); if (value.side === 'source') throw new TypeError('revisionNumber selects a translation revision') }
    if (value.start !== undefined) integer(value.start, 0)
    if (value.sourceVersion !== undefined) integer(value.sourceVersion, 1)
  } else {
    if (value.offset !== undefined) integer(value.offset, 0)
    if (value.limit !== undefined) { integer(value.limit, 1); if (value.limit > 50) throw new TypeError('Unit directory limit exceeds 50') }
  }
  return structuredClone(value) as unknown as UnitDirectoryRequest | UnitReadRequest
}
export function parseNumberedUnit(value: unknown): NumberedUnit {
  object(value); fields(value, ['target', 'number', 'kind', 'status', 'versions', 'finalVersion', 'finalSelection'])
  if (value.finalSelection !== undefined && !['automatic', 'user_fixed'].includes(value.finalSelection as string)) throw new TypeError('Invalid final selection')
  const target = parseDirectTranslationTarget(value.target)
  if (target.kind === 'material' || !['text', 'file', 'image'].includes(value.kind as string) || (target.kind === 'image_unit') !== (value.kind === 'image') || typeof value.status !== 'string' || !Array.isArray(value.versions)) throw new TypeError('Invalid unit directory item')
  integer(value.number, 1); value.versions.forEach(n => integer(n, 1))
  if (value.finalVersion !== null) { integer(value.finalVersion, 1); if (!value.versions.includes(value.finalVersion)) throw new TypeError('Invalid final version') }
  return { ...structuredClone(value), target } as unknown as NumberedUnit
}
export function parseUnitDirectory(value: unknown): UnitDirectory {
  object(value); fields(value, ['translationSessionId', 'items', 'nextOffset'])
  if (typeof value.translationSessionId !== 'string' || !Array.isArray(value.items) || value.items.length > 50) throw new TypeError('Invalid unit directory')
  if (value.nextOffset !== null) integer(value.nextOffset, 0)
  return { translationSessionId: value.translationSessionId, items: value.items.map(parseNumberedUnit), nextOffset: value.nextOffset as number | null }
}
export function parseUnitContent(value: unknown): UnitContent {
  object(value); fields(value, ['unit', 'side', 'revisionNumber', 'text', 'totalCodePoints', 'start', 'nextStart', 'message'])
  const unit = parseNumberedUnit(value.unit)
  if (!['source', 'translation'].includes(value.side as string) || value.text !== null && typeof value.text !== 'string' || value.message !== undefined && typeof value.message !== 'string') throw new TypeError('Invalid unit content')
  integer(value.totalCodePoints, 0); integer(value.start, 0)
  if (value.revisionNumber !== null) integer(value.revisionNumber, 1)
  if (value.nextStart !== null) integer(value.nextStart, 0)
  if (typeof value.text === 'string' && (Array.from(value.text).length > 4000 || value.start + Array.from(value.text).length > value.totalCodePoints || value.nextStart !== (value.start + Array.from(value.text).length < value.totalCodePoints ? value.start + Array.from(value.text).length : null))) throw new TypeError('Invalid unit content page')
  return { ...structuredClone(value), unit } as unknown as UnitContent
}
