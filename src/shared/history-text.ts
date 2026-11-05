/** Exact recorded text versions, independent of the unit's current source or final selection. */
export interface HistoryTextRead {
  readonly translationSessionId: string
  readonly unitId: string
  readonly sourceVersion: number
  readonly side: 'source' | 'translation'
  readonly revisionId?: string
  readonly start?: number
}
export interface HistoryTextPage extends Omit<HistoryTextRead, 'start'> {
  readonly start: number
  readonly text: string
  readonly totalCodePoints: number
  readonly nextStart: number | null
}
export const HISTORY_TEXT_PAGE_POINTS = 4000
export const HISTORY_TEXT_REPLY_BYTES = 32768

function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid history text request')
}
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('Unexpected history text fields')
}
function identity(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new TypeError('Invalid history text identity')
}
function integer(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new TypeError('Invalid history text position or version')
}
const identityFields = ['translationSessionId', 'unitId', 'sourceVersion', 'side'] as const
function version(value: Record<string, unknown>): void {
  identity(value.translationSessionId); identity(value.unitId); integer(value.sourceVersion, 1)
  if (value.side !== 'source' && value.side !== 'translation') throw new TypeError('Invalid history text side')
  if (value.side === 'source') {
    if (Object.hasOwn(value, 'revisionId')) throw new TypeError('A source page cannot select a translation revision')
  } else identity(value.revisionId)
}
export function parseHistoryTextRead(value: unknown): HistoryTextRead {
  object(value); fields(value, identityFields, ['revisionId', 'start']); version(value)
  if (value.start !== undefined) integer(value.start)
  return structuredClone(value) as unknown as HistoryTextRead
}
export function parseHistoryTextPage(value: unknown): HistoryTextPage {
  object(value); fields(value, [...identityFields, 'start', 'text', 'totalCodePoints', 'nextStart'], ['revisionId']); version(value)
  integer(value.start); integer(value.totalCodePoints)
  if (typeof value.text !== 'string') throw new TypeError('Invalid history text body')
  const length = Array.from(value.text).length, end = value.start + length
  if (length > HISTORY_TEXT_PAGE_POINTS || value.start > value.totalCodePoints || end > value.totalCodePoints ||
    value.nextStart !== (end < value.totalCodePoints ? end : null) || end < value.totalCodePoints && !length) throw new TypeError('Invalid history text page')
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > HISTORY_TEXT_REPLY_BYTES) throw new TypeError('History text page exceeds reply budget')
  return structuredClone(value) as unknown as HistoryTextPage
}
