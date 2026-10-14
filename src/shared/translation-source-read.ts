import { parseNormalTranslationTarget, type NormalTranslationTarget } from './normal-translation.js'

export const MAX_TRANSLATION_SOURCE_PAGE_CODE_POINTS = 4000
export const MAX_TRANSLATION_SOURCE_PAGE_BYTES = 32768
export const INLINE_TRANSLATION_SOURCE_CODE_POINTS = 8000

export interface TranslationSourceRange { readonly start: number; readonly end: number }
export interface TranslationSourceRead { readonly target: NormalTranslationTarget; readonly range: TranslationSourceRange }
export interface TranslationSourcePage extends TranslationSourceRead { readonly totalCodePoints: number; readonly text: string }

function exact(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) {
    throw new TypeError('Unexpected source read fields')
  }
}
export function parseTranslationSourceRead(value: unknown): TranslationSourceRead {
  exact(value, ['target', 'range'])
  const target = parseNormalTranslationTarget(value.target)
  exact(value.range, ['start', 'end'])
  const { start, end } = value.range
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number)) {
    throw Object.assign(new TypeError('Source range must be a nonempty Unicode code point interval [start, end).'), { code: 'invalid_range' })
  }
  return { target, range: { start: start as number, end: end as number } }
}
export function sourceCodePointLength(text: string): number {
  let length = 0
  for (const _ of text) length++
  return length
}
