import type { NormalTranslationQuery } from './normal-translation.js'
export interface TranslationLogRead extends NormalTranslationQuery { readonly callId: string; readonly start: number }
export interface TranslationLogPage { readonly text: string; readonly next: number | null; readonly total: number }
export function parseTranslationLogRead(raw: unknown): TranslationLogRead {
  const value = raw as TranslationLogRead
  if (!value || Object.keys(value).length !== 6 || !['mainSessionId', 'translationSessionId', 'operationId', 'callId'].every(key => typeof value[key as keyof TranslationLogRead] === 'string' && String(value[key as keyof TranslationLogRead]).length > 0 && String(value[key as keyof TranslationLogRead]).length <= 3000) || !Number.isSafeInteger(value.start) || value.start < 0 || !Number.isSafeInteger(value.afterSequence) || value.afterSequence < 0) throw new TypeError('Invalid translation log cursor')
  return { ...value }
}
export function parseTranslationLogResult(raw: unknown): { readonly ok: true; readonly value: TranslationLogPage } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  const value = raw as any
  if (!value || typeof value.ok !== 'boolean') throw new TypeError('Invalid translation log reply')
  if (!value.ok) { if (!value.error || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') throw new TypeError('Invalid translation log failure'); return value }
  const page = value.value
  if (!page || typeof page.text !== 'string' || page.text.length > 4000 || !Number.isSafeInteger(page.total) || page.total < 0 || page.next !== null && (!Number.isSafeInteger(page.next) || page.next < 0 || page.next > page.total)) throw new TypeError('Invalid translation log page')
  return value
}
export const TRANSLATION_LOG_REMOTE = { package: 'dsh-translation-plugin', descriptors: [{
  id: 'dsh-translation-plugin#translationNormal/readLog', service: 'translationNormal', namespace: 'translationNormal', method: 'readLog', invocation: { kind: 'direct' as const },
  parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: { mode: 'strict' as const, typeSymbol: 'dsh-translation-plugin#translationLog/read', create: () => ({ parse: parseTranslationLogRead }) } }],
  result: { mode: 'strict' as const, typeSymbol: 'dsh-translation-plugin#translationLog/result', create: () => ({ parse: parseTranslationLogResult }) },
}] }
