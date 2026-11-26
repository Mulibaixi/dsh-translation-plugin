import { parseDirectTranslationTarget, type DirectUnitTarget } from './normal-translation.js'
import { HISTORY_TEXT_PAGE_POINTS } from './history-text.js'

import { parseImageSpeakers, type ImageSpeaker } from './image-translation.js'

export interface UnitDirectoryRequest { readonly translationSessionId?: string; readonly offset?: number; readonly limit?: number }
export interface UnitReadRequest {
  readonly translationSessionId?: string
  readonly unitNumbers: readonly number[]
  readonly side?: 'source' | 'translation'
  readonly revisionNumber?: number
  readonly sourceVersion?: number
  readonly start?: number
  readonly format?: 'lines'
  readonly startLine?: number
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
export interface UnitTextContent {
  readonly speakers?: readonly ImageSpeaker[]
  readonly unclearTranscription?: string
  readonly unit: NumberedUnit
  readonly side: 'source' | 'translation'
  readonly revisionNumber: number | null
  readonly revisionId?: string
  readonly text: string | null
  readonly totalCodePoints: number
  readonly start: number
  readonly nextStart: number | null
  readonly message?: string
}
export interface UnitLineContent {
  readonly unit: NumberedUnit
  readonly side: 'translation'
  readonly revisionNumber: number
  readonly revisionId: string
  readonly lines: readonly { readonly line: number; readonly text: string }[]
  readonly nextLine: number | null
}
export type UnitContent = UnitTextContent | UnitLineContent
export interface UnitDirectory { readonly translationSessionId: string; readonly items: readonly NumberedUnit[]; readonly nextOffset: number | null }
function object(value: unknown): asserts value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid unit request') }
function fields(value: Record<string, unknown>, allowed: readonly string[]): void { if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('Unexpected unit field') }
function integer(value: unknown, min: number): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < min) throw new TypeError('Invalid unit number or offset') }
export function parseUnitRequest(value: unknown, read: false): UnitDirectoryRequest
export function parseUnitRequest(value: unknown, read: true): UnitReadRequest
export function parseUnitRequest(value: unknown, read: boolean): UnitDirectoryRequest | UnitReadRequest {
  object(value)
  fields(value, read ? ['translationSessionId', 'unitNumbers', 'side', 'revisionNumber', 'sourceVersion', 'start', 'format', 'startLine'] : ['translationSessionId', 'offset', 'limit'])
  if (value.translationSessionId !== undefined && (typeof value.translationSessionId !== 'string' || !value.translationSessionId.trim())) throw new TypeError('Invalid translation Session')
  if (read) {
    if (!Array.isArray(value.unitNumbers) || !value.unitNumbers.length || value.unitNumbers.length > 8) throw new TypeError('Read 1–8 unit numbers per call')
    value.unitNumbers.forEach(n => integer(n, 1))
    if (value.side !== undefined && !['source', 'translation'].includes(value.side as string)) throw new TypeError('Invalid unit side')
    if (value.revisionNumber !== undefined) { integer(value.revisionNumber, 1); if (value.side === 'source') throw new TypeError('revisionNumber selects a translation revision') }
    if (value.start !== undefined) integer(value.start, 0)
    if (value.sourceVersion !== undefined) integer(value.sourceVersion, 1)
    if (value.format !== undefined && value.format !== 'lines') throw new TypeError('Invalid unit read format')
    if (value.format === 'lines' && (value.unitNumbers.length !== 1 || value.side === 'source' || value.start !== undefined)) {
      throw new TypeError('Line view requires one translation unit and uses startLine instead of start')
    }
    if (value.startLine !== undefined) {
      if (value.format !== 'lines') throw new TypeError('startLine requires the line view')
      integer(value.startLine, 1)
    }
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
  object(value)
  const unit = parseNumberedUnit(value.unit)
  if (Object.hasOwn(value, 'lines')) {
    fields(value, ['unit', 'side', 'revisionNumber', 'revisionId', 'lines', 'nextLine'])
    integer(value.revisionNumber, 1)
    if (unit.kind !== 'text' || value.side !== 'translation' || !unit.versions.includes(value.revisionNumber) ||
      typeof value.revisionId !== 'string' || !value.revisionId.trim() || Array.from(value.revisionId).length > 2048 ||
      !Array.isArray(value.lines) || !value.lines.length || value.lines.length > HISTORY_TEXT_PAGE_POINTS) throw new TypeError('Invalid translation lines page')
    let previous: number | undefined
    let points = 0
    const lines = value.lines.map(item => {
      object(item); fields(item, ['line', 'text']); integer(item.line, 1)
      if (typeof item.text !== 'string' || /[\r\n]/.test(item.text) || previous !== undefined && item.line !== previous + 1) {
        throw new TypeError('Invalid numbered translation line')
      }
      points += Array.from(item.text).length + (previous === undefined ? 0 : 1)
      previous = item.line
      return { line: item.line, text: item.text }
    })
    if (points > HISTORY_TEXT_PAGE_POINTS || value.nextLine !== null && value.nextLine !== lines.at(-1)!.line + 1) throw new TypeError('Invalid translation lines page bounds')
    return { unit, side: 'translation', revisionNumber: value.revisionNumber, revisionId: value.revisionId, lines, nextLine: value.nextLine as number | null }
  }
  fields(value, ['unit', 'side', 'revisionNumber', 'revisionId', 'text', 'totalCodePoints', 'start', 'nextStart', 'message', 'speakers', 'unclearTranscription'])
  if (!['source', 'translation'].includes(value.side as string) || value.text !== null && typeof value.text !== 'string' || value.message !== undefined && typeof value.message !== 'string') throw new TypeError('Invalid unit content')
  integer(value.totalCodePoints, 0); integer(value.start, 0)
  if (value.revisionNumber !== null) integer(value.revisionNumber, 1)
  if (value.revisionId !== undefined && (typeof value.revisionId !== 'string' || !value.revisionId.trim() || Array.from(value.revisionId).length > 2048 ||
    value.side !== 'translation' || value.text === null || value.revisionNumber === null || !unit.versions.includes(value.revisionNumber))) throw new TypeError('Invalid unit content revision')
  if (value.nextStart !== null) integer(value.nextStart, 0)
  if (typeof value.text === 'string' && (Array.from(value.text).length > HISTORY_TEXT_PAGE_POINTS || value.start + Array.from(value.text).length > value.totalCodePoints || value.nextStart !== (value.start + Array.from(value.text).length < value.totalCodePoints ? value.start + Array.from(value.text).length : null))) throw new TypeError('Invalid unit content page')
  if ((value.speakers !== undefined || value.unclearTranscription !== undefined) && (unit.kind !== 'image' || value.side !== 'source')) throw new TypeError('Image annotations require a source page')
  if (value.unclearTranscription !== undefined && (typeof value.unclearTranscription !== 'string' || value.unclearTranscription.length > 900)) throw new TypeError('Invalid image transcription note')
  return { ...structuredClone(value), unit, ...(value.speakers === undefined ? {} : { speakers: parseImageSpeakers(value.speakers) }) } as unknown as UnitTextContent
}
